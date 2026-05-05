"use strict"

/**
 * Pure-function ORS-aware pricing simulator (Letter I — slice 1).
 *
 * Reads cached ORS connection lists + markets-page prices + demand-derivator
 * outputs and projects how rank / share / pax-per-week / revenue-per-week /
 * profit-per-week change at a different price, frequency, or comfort level.
 * Reuses RouteAssistantProfitEstimator for the revenue/cost half so the
 * model stays a thin layer on top of existing plumbing.
 *
 * Scope:
 *   - Independent per-class price multipliers {Y, C, F} (slice 2b).
 *   - Frequency lever synthesises additional own-connection rows when
 *     newFreq > currentFreq (slice 2a); below-current freq dilutes LF.
 *   - Cargo branch projects share/yield separately from pax (slice 2d).
 *   - Closed-form rating shift + numeric-stable softmax for share.
 *   - Optional per-route T calibration against marketShare leaderboard.
 *   - Per-route rating-price elasticity NOT yet derived (slice 2c — needs
 *     accumulated demand-derivator data, deferred).
 *
 * Read-only — never writes to AS or chrome.storage.
 *
 * The model is intentionally transparent: every constant is a settings
 * tunable; every fallback / clamp / data-gap surfaces as a `notes[]` entry
 * the panel can render as a caveats footer.
 *
 * Public API:
 *   RouteAssistantOrsModel.project({route, scenario, modelParams, economics, useRealDemandForLF})
 *     → {baseline, projected, delta, perClass, notes, modelParams, …}
 *   RouteAssistantOrsModel.calibrateTemperature({allRatings, ourIndices, observedShare})
 *     → T or null
 *   RouteAssistantOrsModel.findOurInLeaderboard(marketSharePax, ourEnterpriseId)
 *     → leaderboard row or null
 */
class RouteAssistantOrsModel {
    /** Drop connections past this rank from softmax — past #50 contributes
     *  <0.1% share at default T and matches AS's pagination cutoff. */
    static MAX_FOR_SOFTMAX = 50

    /** Default softmax temperature (in rating-points). Lower = sharper share-by-rank. */
    static DEFAULT_T = 25

    /** Projected rating clamp range as fraction of base. */
    static RATING_CLAMP_LOW  = 0.5
    static RATING_CLAMP_HIGH = 1.5

    /** Default rating sensitivities (settings override). */
    static DEFAULT_PRICE_ALPHA   = 8   // points per ±100% price change
    static DEFAULT_COMFORT_ALPHA = 5   // points per service-level step

    /** Fallback baseline rating for routes with zero own connections (synthesised). */
    static NO_OWN_BASELINE_FACTOR = 0.95   // × topCompetitorRating

    /** Maps RA panel cabin-class labels to AS payload keys. */
    static CLASS_PAYLOAD = {Y: "ECONOMY", C: "BUSINESS", F: "FIRST"}

    /** Cargo payload key — handled separately from the pax classes. */
    static CARGO_PAYLOAD = "CARGO"

    /**
     * Main entry. Runs the full projection.
     *
     * @param {object} input
     * @param {object} input.route
     *   {hub, dest, distanceKm, ownPricing, orsByClass, marketSharePax?,
     *    ourEnterpriseId?, ourFlightIds?, ourCarrierPrefixes?,
     *    spec, currentFrequency, paxDemandPool, paxElasticity,
     *    paxScore, cargoScore, aircraftAge, useDistanceFuel?,
     *    fuelPriceASc?, fuelBurnOverrides?, falloffPct?}
     * @param {object} input.scenario
     *   {priceMultipliers:{Y:1, C:1, F:1}, cargoMultiplier:1, frequency:null, comfortDelta:0}
     *   Legacy {priceMultiplier:<num>} accepted and migrated via _normaliseScenario.
     * @param {object} input.modelParams
     *   {ratingPriceElasticity, ratingComfortLift, shareTemperature, perRouteT?}
     * @param {object} input.economics — RouteAssistantSettings.economics
     * @param {boolean} input.useRealDemandForLF
     */
    static project(input) {
        input = input || {}
        const route    = input.route || {}
        const scenario = RouteAssistantOrsModel._normaliseScenario(input.scenario)
        const params   = Object.assign({
            ratingPriceElasticity: RouteAssistantOrsModel.DEFAULT_PRICE_ALPHA,
            ratingComfortLift:     RouteAssistantOrsModel.DEFAULT_COMFORT_ALPHA,
            shareTemperature:      RouteAssistantOrsModel.DEFAULT_T,
            perRouteT:             null
        }, input.modelParams || {})
        const T = (_isPositive(params.perRouteT))
            ? Number(params.perRouteT)
            : (_isPositive(params.shareTemperature) ? Number(params.shareTemperature) : RouteAssistantOrsModel.DEFAULT_T)
        const economics     = input.economics || {}
        const useRealDemand = !!input.useRealDemandForLF
        const notes         = []

        // --- Frequency lever (slice 2a) -------------------------------------
        // Compute frequency synthesis budget BEFORE the per-class loop so each
        // class's _projectClass receives a synthesized connection list when
        // newFreq > currentFreq. Below-current freq keeps the slice 1 LF-only
        // dilution behaviour.
        const baseFreq = _safeNumber(route.currentFrequency) || 0
        const newFreq  = scenario.frequency != null ? Math.max(0, Math.round(scenario.frequency)) : baseFreq
        const requestedExtras = Math.max(0, newFreq - baseFreq)
        if (newFreq < baseFreq) {
            notes.push("frequency below current; LF dilutes only (connection list unchanged)")
        }

        // --- Per-class projection (Y, C, F independently) -------------------
        const perClass = {Y: null, C: null, F: null, CARGO: null}
        const byClass  = route.orsByClass || {}
        const observedPrices = (route.ownPricing && route.ownPricing.prices) || {}
        const observedY = _safeNumber(observedPrices.Y)

        // Aircraft-fit bonus (passenger preference for the right airframe on
        // this route's distance bucket). Caller may pass `route.aircraftBonus`
        // explicitly; otherwise we auto-derive from the strategy heuristic
        // table when it's loaded. Stays 0 when the modifier module isn't on
        // the page (route-assistant runs standalone in some surfaces).
        let aircraftBonus = Number(route.aircraftBonus)
        if (!isFinite(aircraftBonus)) aircraftBonus = 0
        const modifierRoot = (typeof window !== "undefined")
            ? window
            : ((typeof globalThis !== "undefined") ? globalThis : null)
        const aircraftModifier = modifierRoot && modifierRoot.AesStrategyAircraftOrsModifier
        if (!aircraftBonus
            && aircraftModifier
            && typeof aircraftModifier.lookup === "function") {
            try {
                const spec = route.spec || (route.aircraft && route.aircraft.spec)
                const dist = _safeNumber(route.distanceKm)
                const derived = aircraftModifier.lookup(
                    spec, dist,
                    (input.modelParams && input.modelParams.aircraftOrsModifier) || null
                )
                if (Number.isFinite(derived) && derived !== 0) {
                    aircraftBonus = derived
                    notes.push("aircraft-fit bonus " + (derived > 0 ? "+" : "")
                        + derived + " pts ("
                        + (aircraftModifier.categoryFor(spec && spec.seats) || "?")
                        + " on " + (aircraftModifier.distanceBucketFor(dist) || "?")
                        + " route)")
                }
            } catch (_) { /* never let modifier lookup break the projection */ }
        }
        aircraftBonus += RouteAssistantOrsModel._aircraftAttractionBonus(
            route.spec || (route.aircraft && route.aircraft.spec) || route.aircraft,
            params,
            notes
        )

        for (const cls of ["Y", "C", "F"]) {
            const payload  = RouteAssistantOrsModel.CLASS_PAYLOAD[cls]
            const classRec = byClass[payload]
            if (!classRec || !Array.isArray(classRec.connections) || !classRec.connections.length) {
                perClass[cls] = null
                continue
            }
            const observed = _safeNumber(observedPrices[cls])
            // For non-Y classes without a cached fare, skip — don't fabricate.
            if (cls !== "Y" && observed == null) {
                notes.push("class " + cls + ": no cached fare; skipped")
                perClass[cls] = null
                continue
            }
            const classMult = Number(scenario.priceMultipliers && scenario.priceMultipliers[cls])
            const mult      = isFinite(classMult) && classMult > 0 ? classMult : 1
            const newPrice  = observed != null ? observed * mult : null
            // Synthesise additional own-connection rows when requested above current.
            const synthRec = (requestedExtras > 0)
                ? RouteAssistantOrsModel._synthesizeOwnConnections(classRec, baseFreq, requestedExtras, notes, cls)
                : classRec
            perClass[cls] = RouteAssistantOrsModel._projectClass({
                classRec:      synthRec,
                observedPrice: observed,
                newPrice:      newPrice,
                comfortDelta:  Number(scenario.comfortDelta) || 0,
                aircraftBonus: aircraftBonus,
                params:        params,
                T:             T,
                notes:         notes,
                cls:           cls,
                topCompetitorRating: _safeNumber(classRec.topCompetitorRating)
            })
        }

        // --- Cargo branch (slice 2d) ----------------------------------------
        // Cargo is intentionally kept OUT of the Y/C/F primary-class fallback
        // so it doesn't pollute the rating/rank/share aggregates above.
        const cargoRec = byClass[RouteAssistantOrsModel.CARGO_PAYLOAD]
        const cargoMult = Number(scenario.cargoMultiplier) || 1
        if (cargoRec && Array.isArray(cargoRec.connections) && cargoRec.connections.length) {
            perClass.CARGO = RouteAssistantOrsModel._projectCargo({
                classRec:    cargoRec,
                params:      params,
                T:           T,
                notes:       notes,
                topCompetitorRating: _safeNumber(cargoRec.topCompetitorRating)
            })
        } else if (_safeNumber(route.cargoDemandPool) != null) {
            notes.push("no CARGO connection list cached — cargo profit unchanged by share")
        }
        if (cargoMult !== 1) {
            notes.push("cargo multiplier scales yield only — no rating shift modelled")
        }

        // --- Aggregate (primary class — first non-null among Y, C, F) ------
        const primary = perClass.Y || perClass.C || perClass.F
        if (!primary) {
            notes.push("no ORS connection list cached for any class")
        }

        const baseRating = primary ? primary.baselineRating  : null
        const projRating = primary ? primary.projectedRating : null
        const baseShare  = primary ? primary.baselineShare   : null
        const projShare  = primary ? primary.projectedShare  : null

        // --- Demand pool — apply price-side elasticity ONCE.
        // Pool is Y-anchored: demand-derivator's pax series is dominated by ECONOMY
        // (sole source when only one class is captured; capacity-weighted Y-heavy
        // when all three are). So pool elasticity reads the Y multiplier only.
        const yMult    = Number(scenario.priceMultipliers && scenario.priceMultipliers.Y) || 1
        const basePool = _safeNumber(route.paxDemandPool)
        const elast    = _safeNumber(route.paxElasticity)
        let projPool = basePool
        if (basePool != null && observedY != null && yMult !== 1
            && elast != null && elast < 0) {
            projPool = basePool * Math.pow(yMult, elast)
        }

        // --- Pax/week = pool × share. Falls back to share-only when pool is null.
        const baselinePax = (basePool != null && baseShare != null)
            ? Math.round(basePool * baseShare) : null
        const projectedPax = (projPool != null && projShare != null)
            ? Math.round(projPool * projShare) : null

        // --- Cargo/week = cargoPool × cargoShare. Tracked separately from pax
        // so it doesn't pollute the pax aggregates. Revenue/profit numbers
        // come from the estimator below — this is just the volume signal.
        // Cargo pool shifts via cargoElasticity when cargoMultiplier scales
        // yield (yield is effectively the per-kg-km price in AS).
        const cargoPool   = _safeNumber(route.cargoDemandPool)
        const cargoElast  = _safeNumber(route.cargoElasticity)
        let projCargoPool = cargoPool
        if (cargoPool != null && cargoMult !== 1 && cargoElast != null && cargoElast < 0) {
            projCargoPool = cargoPool * Math.pow(cargoMult, cargoElast)
        }
        const cargoBaseShare = perClass.CARGO ? perClass.CARGO.baselineShare  : null
        const cargoProjShare = perClass.CARGO ? perClass.CARGO.projectedShare : null
        const baselineCargoWk = (cargoPool != null && cargoBaseShare != null)
            ? Math.round(cargoPool * cargoBaseShare) : null
        const projectedCargoWk = (projCargoPool != null && cargoProjShare != null)
            ? Math.round(projCargoPool * cargoProjShare) : null

        // --- Revenue/profit projection via the existing estimator ----------
        const baseCargoYield = _safeNumber(economics && economics.cargoYieldPerKgKm)
        const baselineEcon = RouteAssistantOrsModel._estimate({
            route:           route,
            economics:       economics,
            useRealDemand:   useRealDemand,
            paxPerWeekTarget: baselinePax,
            yieldPerKm:      (observedY != null && route.distanceKm > 0)
                ? observedY / route.distanceKm : null,
            paxDemandPool:   basePool,
            frequency:       baseFreq
        })
        const baselineRevenueWk = _revenueWeek(baselineEcon, baseFreq)

        const newPriceY = (observedY != null) ? observedY * yMult : null
        const projectedEcon = RouteAssistantOrsModel._estimate({
            route:           route,
            economics:       economics,
            useRealDemand:   useRealDemand,
            paxPerWeekTarget: projectedPax,
            yieldPerKm:      (newPriceY != null && route.distanceKm > 0)
                ? newPriceY / route.distanceKm : null,
            paxDemandPool:   projPool,
            cargoDemandPool: projCargoPool,
            frequency:       newFreq,
            // Cargo multiplier scales yield only (rating-shift not modelled).
            cargoYieldPerKgKm: (cargoMult !== 1 && baseCargoYield != null && baseCargoYield > 0)
                ? baseCargoYield * cargoMult : null
        })
        const projectedRevenueWk = _revenueWeek(projectedEcon, newFreq)

        // --- Build output --------------------------------------------------
        const baseline = {
            rating:          baseRating,
            rank:            primary ? primary.baselineRanks : null,
            share:           baseShare,
            paxPerWeek:      baselinePax,
            cargoPerWeek:    baselineCargoWk,
            revenuePerWeek:  baselineRevenueWk,
            profitPerWeek:   baselineEcon ? baselineEcon.profitPerWeek : null,
            profitPerFlight: baselineEcon ? baselineEcon.profitPerFlight : null
        }
        const projected = {
            rating:          projRating,
            rank:            primary ? primary.projectedRanks : null,
            share:           projShare,
            paxPerWeek:      projectedPax,
            cargoPerWeek:    projectedCargoWk,
            revenuePerWeek:  projectedRevenueWk,
            profitPerWeek:   projectedEcon ? projectedEcon.profitPerWeek : null,
            profitPerFlight: projectedEcon ? projectedEcon.profitPerFlight : null
        }
        const delta = {
            rating:         _signedDelta(baseline.rating, projected.rating),
            share:          _signedDelta(baseline.share,  projected.share),
            paxPerWeek:     _signedDelta(baseline.paxPerWeek, projected.paxPerWeek),
            cargoPerWeek:   _signedDelta(baseline.cargoPerWeek, projected.cargoPerWeek),
            revenuePerWeek: _signedDelta(baseline.revenuePerWeek, projected.revenuePerWeek),
            profitPerWeek:  _signedDelta(baseline.profitPerWeek,  projected.profitPerWeek)
        }

        // Slice 2c — surface per-class α source labels in the notes
        // footer. The panel's `_recomputeOrsSandbox` cascade resolver
        // populates `alphaSourceByClass` via `modelParams.alphaSourceByClass`;
        // the model just renders the labels into human-readable lines.
        const alphaSrc    = (input.modelParams && input.modelParams.alphaSourceByClass) || {}
        const alphaResMap = (params.ratingPriceElasticityByClass) || {}
        for (const cls of ["Y", "C", "F"]) {
            const pc = perClass[cls]
            if (!pc) continue
            const src = alphaSrc[cls]
            const a   = Number.isFinite(alphaResMap[cls]) ? alphaResMap[cls] : params.ratingPriceElasticity
            if (src === "override") {
                notes.push("class " + cls + ": α=" + a + " (manual override)")
            } else if (src === "derived") {
                notes.push("class " + cls + ": α=" + a + " (derived from observation log)")
            } else if (src === "siblingDerived") {
                notes.push("class " + cls + ": α=" + a + " (borrowed from sibling class on this route)")
            } else if (src === "fleetMedian") {
                notes.push("class " + cls + ": α=" + a + " (fleet median across user's routes)")
            } else if (src === "global") {
                notes.push("class " + cls + ": α=" + a + " (global default — no per-route data yet)")
            }
        }

        return {
            baseline:    baseline,
            projected:   projected,
            delta:       delta,
            perClass:    perClass,
            notes:       notes,
            modelParams: {
                ratingPriceElasticity:        params.ratingPriceElasticity,
                ratingPriceElasticityByClass: alphaResMap,
                alphaSourceByClass:           alphaSrc,
                ratingComfortLift:            params.ratingComfortLift,
                T:                            T,
                source:                       _isPositive(params.perRouteT) ? "perRoute" : "global"
            },
            scenario:      scenario,
            baselineEcon:  baselineEcon,
            projectedEcon: projectedEcon,
            // Surface the per-class scaled prices for the panel preview.
            scaledPrices:  {
                Y: newPriceY,
                C: (_safeNumber(observedPrices.C) != null)
                    ? _safeNumber(observedPrices.C) * (Number(scenario.priceMultipliers.C) || 1) : null,
                F: (_safeNumber(observedPrices.F) != null)
                    ? _safeNumber(observedPrices.F) * (Number(scenario.priceMultipliers.F) || 1) : null,
                Cargo: (_safeNumber(observedPrices.Cargo) != null)
                    ? _safeNumber(observedPrices.Cargo) * cargoMult : null
            },
            elasticity: elast,
            adjustedPool: projPool
        }
    }

    static _aircraftAttractionBonus(spec, params, notes) {
        if (!spec) return 0
        const raw = _safeNumber(
            spec.orsAttraction != null ? spec.orsAttraction
                : (spec.customerAttraction != null ? spec.customerAttraction : spec.paxSatisfaction)
        )
        if (raw == null) return 0
        const neutral = _safeNumber(params && params.aircraftAttractionNeutral)
        const scale = _safeNumber(params && params.aircraftAttractionScale)
        const cap = _safeNumber(params && params.aircraftAttractionMaxBonus)
        const n = neutral != null ? neutral : 50
        const s = scale != null ? scale : 0.04
        const c = cap != null ? Math.max(0, cap) : 3
        if (s <= 0 || c <= 0) return 0
        const bonus = Math.max(-c, Math.min(c, (raw - n) * s))
        if (bonus !== 0) {
            notes && notes.push("aircraft ORS attraction "
                + (bonus > 0 ? "+" : "") + Math.round(bonus * 100) / 100
                + " pts (spec " + raw + ", neutral " + n + ")")
        }
        return bonus
    }

    /**
     * Canonicalise the scenario shape — accepts either the slice 1 shape
     * (single `priceMultiplier` numeric, Y-anchored) or the slice 2 shape
     * (`priceMultipliers: {Y, C, F}` independent). Always returns the
     * slice 2 shape; legacy multiplier maps to all three classes.
     */
    static _normaliseScenario(scenario) {
        const s = scenario || {}
        let pm = s.priceMultipliers
        if (!pm || typeof pm !== "object") {
            const legacy = Number(s.priceMultiplier)
            const v = isFinite(legacy) && legacy > 0 ? legacy : 1
            pm = {Y: v, C: v, F: v}
        } else {
            pm = {
                Y: isFinite(Number(pm.Y)) && Number(pm.Y) > 0 ? Number(pm.Y) : 1,
                C: isFinite(Number(pm.C)) && Number(pm.C) > 0 ? Number(pm.C) : 1,
                F: isFinite(Number(pm.F)) && Number(pm.F) > 0 ? Number(pm.F) : 1
            }
        }
        const cm = Number(s.cargoMultiplier)
        return {
            priceMultipliers: pm,
            cargoMultiplier:  isFinite(cm) && cm > 0 ? cm : 1,
            frequency:        s.frequency != null && isFinite(Number(s.frequency)) ? Number(s.frequency) : null,
            comfortDelta:     isFinite(Number(s.comfortDelta)) ? Number(s.comfortDelta) : 0
        }
    }

    /**
     * Synthesise additional own-connection rows to project a frequency
     * increase. Returns a shallow-cloned `classRec` whose `connections`
     * array has up to `extraFlights` synthetic own rows appended (capped
     * by the saturation guard in `_capSynthesisCount`). Each synthetic
     * row clones a template (preferring own + nonstop, else highest-rated
     * own) with a new flightCode and `isOurs` forced true on every leg.
     *
     * Connection schemas in cache have NO timestamps (verified against
     * ors-scraper); the model's rank/softmax never read timestamps, so
     * the clones don't need synthetic departure times.
     */
    static _synthesizeOwnConnections(classRec, baseFreq, requestedExtras, notes, cls) {
        const conns = (classRec && Array.isArray(classRec.connections)) ? classRec.connections : []
        if (!conns.length) return classRec
        // Pick a template: prefer own + nonstop, then any own, else give up.
        let template = null
        for (const c of conns) {
            const legs = (c.legs || []).filter(l => !l.isGround)
            if (!legs.length) continue
            if (legs.every(l => !!l.isOurs) && legs.length === 1) { template = c; break }
        }
        if (!template) {
            let best = null
            for (const c of conns) {
                const legs = (c.legs || []).filter(l => !l.isGround)
                if (!legs.length) continue
                if (!legs.every(l => !!l.isOurs)) continue
                const r = Number(c.rating) || 0
                if (!best || r > (Number(best.rating) || 0)) best = c
            }
            template = best
        }
        if (!template) {
            notes && notes.push("class " + cls + ": no own connection to clone; frequency synthesis skipped")
            return classRec
        }
        const cap = RouteAssistantOrsModel._capSynthesisCount(baseFreq, requestedExtras, conns.length)
        if (cap <= 0) {
            notes && notes.push("class " + cls + ": frequency synthesis skipped (saturation cap)")
            return classRec
        }
        if (cap < requestedExtras) {
            notes && notes.push("class " + cls + ": frequency synthesis capped at +" + cap
                + " (50% of current); requested +" + requestedExtras)
        }
        const synth = []
        for (let i = 0; i < cap; i++) {
            const cloneLegs = (template.legs || []).map(l => Object.assign({}, l, {
                isOurs:     l.isGround ? !!l.isOurs : true,
                flightCode: l.isGround ? l.flightCode : "synth-" + cls + "-" + (i + 1),
                flightId:   l.isGround ? l.flightId   : null
            }))
            synth.push({
                rating:        Number(template.rating) || 0,
                totalDuration: template.totalDuration,
                totalPrice:    template.totalPrice,
                bookable:      true,
                legs:          cloneLegs,
                _synthetic:    true
            })
        }
        notes && notes.push("class " + cls + ": synthesised " + cap
            + " additional own connection" + (cap === 1 ? "" : "s")
            + " to project +" + cap + "/wk")
        return Object.assign({}, classRec, {connections: conns.concat(synth)})
    }

    /**
     * Cap the synthesised connection count so the softmax doesn't saturate.
     * Limits: (i) the requested extras, (ii) ceil(0.5 × current freq) — adding
     * 30 synthetic rows to a 5-row list pushes our share to ~1.0 in a way
     * the user can't sanity-check, (iii) MAX_FOR_SOFTMAX − existing rows so
     * the projection stays inside the same softmax window the model uses.
     */
    static _capSynthesisCount(baseFreq, requestedExtras, existingTotal) {
        if (!(requestedExtras > 0)) return 0
        const halfFreqCap = Math.max(1, Math.ceil(0.5 * (baseFreq || 0)))
        const headroom    = Math.max(0, RouteAssistantOrsModel.MAX_FOR_SOFTMAX - (existingTotal || 0))
        return Math.max(0, Math.min(requestedExtras, halfFreqCap, headroom))
    }

    /**
     * Per-class projection — handles rating shift, re-rank, and softmax share.
     * Returns the per-class panel of baseline+projected rating/rank/share or
     * null when the class has zero connections.
     */
    static _projectClass(arg) {
        const conns = arg.classRec.connections.slice(0, RouteAssistantOrsModel.MAX_FOR_SOFTMAX)
        const params = arg.params
        const T = arg.T
        const notes = arg.notes
        const cls = arg.cls

        // Tag each connection with isOurs (every-leg-ours vs partial).
        const tagged = conns.map((c, idx) => {
            const flightLegs = (c.legs || []).filter(l => !l.isGround)
            if (!flightLegs.length) return {idx, conn: c, oursAll: false, oursAny: false, isNonstop: false, rating: _safeNumber(c.rating) || 0}
            const oursAll = flightLegs.every(l => !!l.isOurs)
            const oursAny = flightLegs.some(l => !!l.isOurs)
            return {idx, conn: c, oursAll, oursAny, isNonstop: flightLegs.length === 1, rating: _safeNumber(c.rating) || 0}
        })

        const ourIdx = []
        for (let i = 0; i < tagged.length; i++) if (tagged[i].oursAll) ourIdx.push(i)

        const baselineRatings = tagged.map(t => t.rating)
        const baselineRanks   = RouteAssistantOrsModel._reRank(tagged, baselineRatings)
        const baselineShare   = RouteAssistantOrsModel._softmaxShare(baselineRatings, ourIdx, T)
        let baselineRating    = _maxOrNull(ourIdx.map(i => baselineRatings[i]))

        // No own connection in cache — synthesise from top competitor.
        if (baselineRating == null) {
            const topCompet = arg.topCompetitorRating
            if (_isPositive(topCompet)) {
                baselineRating = topCompet * RouteAssistantOrsModel.NO_OWN_BASELINE_FACTOR
                notes && notes.push("class " + cls + ": no own connection in cache; baseline rating estimated as top competitor × " + RouteAssistantOrsModel.NO_OWN_BASELINE_FACTOR)
            }
        }

        // Project rating: linear-in-percent shift, clamped.
        const observed   = arg.observedPrice
        const newPrice   = arg.newPrice
        const priceRatio = (_isPositive(observed) && newPrice != null)
            ? (newPrice - observed) / observed
            : 0
        // Slice 2c — per-route per-class α resolution. Uses
        // `Number.isFinite` (NOT `||`) so a manual override of `0`
        // (route's rating doesn't respond to price) is honored. Panel's
        // `_recomputeOrsSandbox` runs the cascade resolver and passes
        // the resolved per-class map in via `modelParams`.
        const alphaForClass = (params.ratingPriceElasticityByClass
                              && Number.isFinite(params.ratingPriceElasticityByClass[cls]))
            ? params.ratingPriceElasticityByClass[cls]
            : params.ratingPriceElasticity
        let clampedHigh = false, clampedLow = false
        const aircraftBonus = Number(arg.aircraftBonus) || 0
        const projectedRatings = tagged.map(t => {
            if (!t.oursAll) return t.rating  // leave competitors + mixed-ownership rows fixed
            const base = t.rating
            if (!base) return base
            const shifted = base
                - alphaForClass * priceRatio
                + params.ratingComfortLift * (arg.comfortDelta || 0)
                + aircraftBonus
            const lo = base * RouteAssistantOrsModel.RATING_CLAMP_LOW
            const hi = base * RouteAssistantOrsModel.RATING_CLAMP_HIGH
            if (shifted < lo) { clampedLow  = true; return lo }
            if (shifted > hi) { clampedHigh = true; return hi }
            return shifted
        })
        if (aircraftBonus !== 0) {
            notes && notes.push("class " + cls + ": aircraft ORS bonus " + (aircraftBonus > 0 ? "+" : "") + aircraftBonus + " pts")
        }
        if (clampedLow)  notes && notes.push("class " + cls + ": projected rating clamped low")
        if (clampedHigh) notes && notes.push("class " + cls + ": projected rating clamped high")

        const projectedRanks = RouteAssistantOrsModel._reRank(tagged, projectedRatings)
        const projectedShare = RouteAssistantOrsModel._softmaxShare(projectedRatings, ourIdx, T)
        const projectedRating = _maxOrNull(ourIdx.map(i => projectedRatings[i])) || baselineRating

        if (tagged.some(t => t.oursAny && !t.oursAll)) {
            notes && notes.push("class " + cls + ": mixed-ownership multi-leg connection kept fixed rating")
        }

        return {
            baselineRating:   baselineRating,
            projectedRating:  projectedRating,
            baselineShare:    baselineShare,
            projectedShare:   projectedShare,
            baselineRanks:    baselineRanks,
            projectedRanks:   projectedRanks,
            connectionsCount: tagged.length,
            ownConnectionsCount: ourIdx.length,
            priceRatio:       priceRatio,
            // Slice 2c — surface the resolved α actually used for this
            // class so the panel can render it next to the projection.
            alphaUsed:        alphaForClass
        }
    }

    /**
     * Cargo per-class projection. Mirrors `_projectClass` but simpler:
     * no comfort lift (cargo rating in AS doesn't shift with comfort) and
     * no price-driven rating shift (the cargo multiplier scales yield,
     * not rating — see `cargoYieldPerKgKm` override on the projected
     * estimate). The result still surfaces baseline+projected share so
     * the panel can show share-vs-competitors.
     */
    static _projectCargo(arg) {
        const conns = arg.classRec.connections.slice(0, RouteAssistantOrsModel.MAX_FOR_SOFTMAX)
        const T = arg.T
        const tagged = conns.map((c, idx) => {
            const flightLegs = (c.legs || []).filter(l => !l.isGround)
            if (!flightLegs.length) return {idx, conn: c, oursAll: false, oursAny: false, isNonstop: false, rating: _safeNumber(c.rating) || 0}
            const oursAll = flightLegs.every(l => !!l.isOurs)
            const oursAny = flightLegs.some(l => !!l.isOurs)
            return {idx, conn: c, oursAll, oursAny, isNonstop: flightLegs.length === 1, rating: _safeNumber(c.rating) || 0}
        })
        const ourIdx = []
        for (let i = 0; i < tagged.length; i++) if (tagged[i].oursAll) ourIdx.push(i)
        const ratings = tagged.map(t => t.rating)
        const ranks = RouteAssistantOrsModel._reRank(tagged, ratings)
        const share = RouteAssistantOrsModel._softmaxShare(ratings, ourIdx, T)
        const ourRating = _maxOrNull(ourIdx.map(i => ratings[i]))
        return {
            baselineRating:   ourRating,
            projectedRating:  ourRating,
            baselineShare:    share,
            projectedShare:   share,
            baselineRanks:    ranks,
            projectedRanks:   ranks,
            connectionsCount: tagged.length,
            ownConnectionsCount: ourIdx.length,
            priceRatio:       0
        }
    }

    /**
     * Compute rank flavors after sorting connections by `ratingByIndex` desc.
     * Mirrors RouteAssistantOrsScraper.computeRanks (ors-scraper.js:486–528).
     * Returns {any, firstLegOurs, allOurs, nonstop, bookable} — each a 1-based
     * rank position or null when no own connection qualifies.
     */
    static _reRank(tagged, ratingByIndex) {
        const order = tagged.map((t, i) => ({t, r: ratingByIndex[i]}))
            .sort((a, b) => {
                const dr = (b.r || 0) - (a.r || 0)
                return dr !== 0 ? dr : (a.t.idx - b.t.idx)
            })
        const out = {any: null, firstLegOurs: null, allOurs: null, nonstop: null, bookable: null}
        for (let pos = 0; pos < order.length; pos++) {
            const t = order[pos].t
            const c = t.conn
            const flightLegs = (c.legs || []).filter(l => !l.isGround)
            if (!flightLegs.length) continue
            const anyOurs   = flightLegs.some(l => !!l.isOurs)
            const allOurs   = flightLegs.every(l => !!l.isOurs)
            const firstOurs = !!flightLegs[0].isOurs
            const isNonstop = flightLegs.length === 1
            const rankPos = pos + 1
            if (anyOurs   && out.any         == null) out.any         = rankPos
            if (firstOurs && out.firstLegOurs == null) out.firstLegOurs = rankPos
            if (allOurs   && out.allOurs     == null) out.allOurs     = rankPos
            if (allOurs && isNonstop && out.nonstop  == null) out.nonstop  = rankPos
            if (anyOurs && c.bookable && out.bookable == null) out.bookable = rankPos
        }
        return out
    }

    /**
     * Numeric-stable softmax share — sum of exp((r - maxR)/T) over `ourIndices`
     * divided by total. Returns 0..1 or null on degenerate input.
     */
    static _softmaxShare(ratings, ourIndices, T) {
        if (!Array.isArray(ratings) || !ratings.length) return null
        if (!Array.isArray(ourIndices) || !ourIndices.length) return 0
        const t = (_isPositive(T)) ? Number(T) : RouteAssistantOrsModel.DEFAULT_T
        let maxR = -Infinity
        for (const r of ratings) {
            const v = _safeNumber(r) || 0
            if (v > maxR) maxR = v
        }
        if (!isFinite(maxR)) return null
        let total = 0, ours = 0
        const ourSet = new Set(ourIndices)
        for (let i = 0; i < ratings.length; i++) {
            const r = _safeNumber(ratings[i]) || 0
            const w = Math.exp((r - maxR) / t)
            total += w
            if (ourSet.has(i)) ours += w
        }
        if (total <= 0) return null
        return ours / total
    }

    /**
     * Slice 4a — sweet-spot finder. Scan a uniform price multiplier across
     * `[lo, hi]` in `step` increments, calling `project()` for each step
     * and returning the profit-maximising multiplier alongside the full
     * sweep so callers can render a preview / sparkline (slice 5a reuses
     * this for inline charts).
     *
     * Inputs match `project()` exactly; the scan overrides the scenario's
     * `priceMultipliers` to {Y:m, C:m, F:m} for each step but keeps cargo /
     * frequency / comfort fixed at their current values. Y is the only
     * channel that drives the demand-pool elasticity inside `project()`,
     * so a uniform sweep already exercises the dominant lever.
     *
     * Returns null when the baseline projection has no profit signal
     * (typically: no own connection or missing fuel/spec input).
     *
     * @param {object} input — same shape as `project()`
     * @param {object} [input.scan] — {lo, hi, step} (defaults 0.7 / 1.3 / 0.05)
     * @return {object|null} {points, baselineMultiplier, optimal}
     */
    static scanPriceCurve(input) {
        input = input || {}
        const scanCfg = input.scan || {}
        const lo   = isFinite(scanCfg.lo)   && scanCfg.lo   > 0   ? Number(scanCfg.lo)   : 0.7
        const hi   = isFinite(scanCfg.hi)   && scanCfg.hi   > lo  ? Number(scanCfg.hi)   : 1.3
        const step = isFinite(scanCfg.step) && scanCfg.step > 0   ? Number(scanCfg.step) : 0.05
        const baseScenario = RouteAssistantOrsModel._normaliseScenario(input.scenario)
        const baseRes = RouteAssistantOrsModel.project(Object.assign({}, input, {
            scenario: Object.assign({}, baseScenario, {priceMultipliers: {Y: 1, C: 1, F: 1}})
        }))
        const baseProfit = baseRes && baseRes.baseline ? _safeNumber(baseRes.baseline.profitPerWeek) : null
        const points = []
        // Iterate via integer steps to dodge float drift (0.7 + 0.05 × 12 = 1.3).
        const steps = Math.round((hi - lo) / step)
        let optimal = null
        for (let i = 0; i <= steps; i++) {
            const m = Math.round((lo + i * step) * 10000) / 10000
            const scenarioStep = Object.assign({}, baseScenario, {
                priceMultipliers: {Y: m, C: m, F: m}
            })
            const res = RouteAssistantOrsModel.project(Object.assign({}, input, {scenario: scenarioStep}))
            const profit = res && res.projected ? _safeNumber(res.projected.profitPerWeek) : null
            const deltaProfit = (profit != null && baseProfit != null) ? (profit - baseProfit) : null
            const point = {multiplier: m, profitPerWeek: profit, deltaProfit: deltaProfit}
            points.push(point)
            if (profit != null && (optimal == null || profit > optimal.profitPerWeek)) {
                optimal = point
            }
        }
        if (!optimal) return null
        const deltaPct = (baseProfit != null && baseProfit !== 0)
            ? (optimal.profitPerWeek - baseProfit) / Math.abs(baseProfit) : null
        return {
            points:             points,
            baselineMultiplier: 1,
            baselineProfit:     baseProfit,
            optimal: {
                multiplier:     optimal.multiplier,
                profitPerWeek:  optimal.profitPerWeek,
                deltaProfit:    optimal.deltaProfit,
                deltaPct:       deltaPct
            }
        }
    }

    /**
     * Slice 5c — sensitivity sweep heatmap. 2-D scan over a uniform price
     * multiplier (applied to Y/C/F together) crossed with a frequency axis
     * derived from the route's current frequency. Returns one cell per
     * (price, freq) pair with the projected profit/wk and delta vs the
     * (1.0×, current frequency) baseline.
     *
     * Default grid is 5 × 5 — price ±20% in 10% steps, freq ×0.6/0.8/1.0/
     * 1.2/1.4 (rounded, floored to 1). Callers can pass `grid.priceMultipliers`
     * or `grid.freqMultipliers` arrays to override.
     *
     * Pure — same purity contract as `scanPriceCurve`. Returns null on
     * degenerate input (no baseline profit signal).
     *
     * @param {object} input — same shape as `project()`
     * @param {object} [input.grid] — `{priceMultipliers?, freqMultipliers?}`
     * @return {object|null} `{cells, priceMultipliers, frequencies,
     *                         baselineFreq, baselineProfit, optimal}`
     */
    static scanPriceFreqGrid(input) {
        input = input || {}
        const cfg = input.grid || {}
        const baseScenario = RouteAssistantOrsModel._normaliseScenario(input.scenario)
        const baseFreq = (input.route && _safeNumber(input.route.currentFrequency)) || 0
        const priceMults = (Array.isArray(cfg.priceMultipliers) && cfg.priceMultipliers.length)
            ? cfg.priceMultipliers.map(Number).filter(v => isFinite(v) && v > 0)
            : [0.80, 0.90, 1.00, 1.10, 1.20]
        const freqMults = (Array.isArray(cfg.freqMultipliers) && cfg.freqMultipliers.length)
            ? cfg.freqMultipliers.map(Number).filter(v => isFinite(v) && v > 0)
            : [0.60, 0.80, 1.00, 1.20, 1.40]
        // Round to integers; clamp to ≥1 so the synthesiser always has at
        // least one own-connection to work with. Dedup adjacent collisions
        // (a base of 1/wk produces 1/1/1/1/1 across the whole row).
        const frequencies = []
        for (const fm of freqMults) {
            const f = Math.max(1, Math.round(baseFreq * fm) || 1)
            if (frequencies.length === 0 || frequencies[frequencies.length - 1] !== f) frequencies.push(f)
        }
        if (!frequencies.length) frequencies.push(Math.max(1, Math.round(baseFreq) || 1))

        const baseRes = RouteAssistantOrsModel.project(Object.assign({}, input, {
            scenario: Object.assign({}, baseScenario, {priceMultipliers: {Y: 1, C: 1, F: 1}})
        }))
        const baseProfit = baseRes && baseRes.baseline ? _safeNumber(baseRes.baseline.profitPerWeek) : null

        const cells = []
        let optimal = null
        for (const m of priceMults) {
            for (const f of frequencies) {
                const scenarioStep = Object.assign({}, baseScenario, {
                    priceMultipliers: {Y: m, C: m, F: m},
                    frequency:        f
                })
                const res = RouteAssistantOrsModel.project(Object.assign({}, input, {scenario: scenarioStep}))
                const profit = res && res.projected ? _safeNumber(res.projected.profitPerWeek) : null
                const deltaProfit = (profit != null && baseProfit != null) ? (profit - baseProfit) : null
                const cell = {priceMultiplier: m, frequency: f, profitPerWeek: profit, deltaProfit: deltaProfit}
                cells.push(cell)
                if (profit != null && (optimal == null || profit > optimal.profitPerWeek)) optimal = cell
            }
        }
        if (!optimal) return null
        return {
            cells:            cells,
            priceMultipliers: priceMults,
            frequencies:      frequencies,
            baselineFreq:     baseFreq,
            baselineProfit:   baseProfit,
            optimal:          optimal
        }
    }

    /**
     * Solve for T given an observed share and the rating list. Bisection
     * over [1, 200] — share is monotonic in T (higher T = more uniform).
     * Returns T (rounded to 1 decimal) or null on degenerate input.
     */
    static calibrateTemperature(arg) {
        const ratings = arg && arg.allRatings
        const ourIdx  = arg && arg.ourIndices
        const target  = arg && arg.observedShare
        if (!Array.isArray(ratings) || !ratings.length) return null
        if (!Array.isArray(ourIdx) || !ourIdx.length) return null
        if (!isFinite(target) || target <= 0 || target >= 1) return null
        const f = (T) => {
            const s = RouteAssistantOrsModel._softmaxShare(ratings, ourIdx, T)
            return s == null ? null : (s - target)
        }
        let lo = 1, hi = 200
        const fLo = f(lo), fHi = f(hi)
        if (fLo == null || fHi == null) return null
        // Target unbracketed → return the closer endpoint.
        if (fLo * fHi > 0) {
            return Math.abs(fLo) < Math.abs(fHi) ? lo : hi
        }
        for (let i = 0; i < 50; i++) {
            const mid = (lo + hi) / 2
            const fm = f(mid)
            if (fm == null) return null
            if (Math.abs(fm) < 0.001) return Math.round(mid * 10) / 10
            if (fm * fLo < 0) hi = mid
            else              lo = mid
            if (hi - lo < 0.05) break
        }
        return Math.round(((lo + hi) / 2) * 10) / 10
    }

    /**
     * Wrap RouteAssistantProfitEstimator.estimate() with the projection
     * inputs. Returns `{profitPerFlight, profitPerWeek, breakdown}` or null.
     */
    static _estimate(arg) {
        if (typeof RouteAssistantProfitEstimator === "undefined") return null
        const route = arg.route || {}
        const spec  = route.spec
        if (!spec) return null
        const seats = _safeNumber(spec.seats) || 0
        const freq  = _safeNumber(arg.frequency)
        const paxLF = (arg.paxPerWeekTarget != null && seats > 0 && freq != null && freq > 0)
            ? Math.max(0, Math.min(1, arg.paxPerWeekTarget / (seats * freq)))
            : null
        return RouteAssistantProfitEstimator.estimate({
            distanceKm:         route.distanceKm,
            spec:               spec,
            frequency:          freq != null ? freq : (route.currentFrequency || 0),
            paxScore:           route.paxScore,
            cargoScore:         route.cargoScore,
            paxDemandPool:      arg.paxDemandPool,
            cargoDemandPool:    arg.cargoDemandPool != null ? arg.cargoDemandPool : route.cargoDemandPool,
            useRealDemandForLF: !!arg.useRealDemand,
            override:           {
                paxLF:              paxLF,
                yieldPerKm:         arg.yieldPerKm,
                cargoYieldPerKgKm:  arg.cargoYieldPerKgKm
            },
            economics:          arg.economics,
            aircraftAge:        route.aircraftAge,
            useDistanceFuel:    !!route.useDistanceFuel,
            fuelPriceASc:       route.fuelPriceASc,
            fuelBurnOverrides:  route.fuelBurnOverrides,
            falloffPct:         route.falloffPct
        })
    }

    /**
     * Find "our enterprise's row" in the markets-page leaderboard.
     * Returns the row {rank, name, sharePct, change, …} or null.
     */
    static findOurInLeaderboard(marketSharePax, ourEnterpriseId) {
        if (!Array.isArray(marketSharePax) || !marketSharePax.length) return null
        if (ourEnterpriseId == null || ourEnterpriseId === "") return null
        const idStr = String(ourEnterpriseId)
        for (const row of marketSharePax) {
            if (row && row.enterpriseId != null && String(row.enterpriseId) === idStr) return row
        }
        return null
    }

    /**
     * End-to-end T calibration for a route. Resolves the observed share
     * from the leaderboard, picks the primary class with cached connections,
     * builds the ratings + ourIndices vectors, and runs calibrateTemperature.
     *
     * Returns `{ok: true, T, observedShare, ourRow}` on success or
     * `{ok: false, code}` on any precondition miss. Codes are stable —
     * UX layers map them to user copy; the auto-loop ignores all of them.
     *
     * Codes: "no-marketShare" | "no-ourEnterpriseId" | "not-in-leaderboard"
     *      | "no-share" | "no-connections" | "no-own-connections"
     *      | "solver-failed"
     */
    static calibrateRouteT(arg) {
        const orsByClass      = arg && arg.orsByClass
        const marketSharePax  = arg && arg.marketSharePax
        const ourEnterpriseId = arg && arg.ourEnterpriseId

        if (!marketSharePax || !marketSharePax.length) return {ok: false, code: "no-marketShare"}
        if (!ourEnterpriseId)                          return {ok: false, code: "no-ourEnterpriseId"}
        const ourRow = RouteAssistantOrsModel.findOurInLeaderboard(marketSharePax, ourEnterpriseId)
        if (!ourRow) return {ok: false, code: "not-in-leaderboard"}
        const observedShare = (ourRow.sharePct != null) ? Number(ourRow.sharePct) / 100 : null
        if (observedShare == null || !isFinite(observedShare) || observedShare <= 0) {
            return {ok: false, code: "no-share"}
        }

        const byClass = orsByClass || {}
        const primary = byClass.ECONOMY || byClass.BUSINESS || byClass.FIRST
        if (!primary || !Array.isArray(primary.connections) || !primary.connections.length) {
            return {ok: false, code: "no-connections"}
        }
        const conns = primary.connections.slice(0, RouteAssistantOrsModel.MAX_FOR_SOFTMAX)
        const ratings = conns.map(c => Number(c.rating) || 0)
        const ourIndices = []
        for (let i = 0; i < conns.length; i++) {
            const legs = (conns[i].legs || []).filter(l => !l.isGround)
            if (legs.length && legs.every(l => !!l.isOurs)) ourIndices.push(i)
        }
        if (!ourIndices.length) return {ok: false, code: "no-own-connections"}

        const T = RouteAssistantOrsModel.calibrateTemperature({
            allRatings:    ratings,
            ourIndices:    ourIndices,
            observedShare: observedShare
        })
        if (T == null || !isFinite(T) || T <= 0) return {ok: false, code: "solver-failed"}
        return {ok: true, T, observedShare, ourRow}
    }
}

// ---------- Helpers ----------

function _safeNumber(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

function _isPositive(v) {
    const n = _safeNumber(v)
    return n != null && n > 0
}

function _maxOrNull(arr) {
    if (!Array.isArray(arr) || !arr.length) return null
    let m = -Infinity, any = false
    for (const v of arr) {
        if (v == null || !isFinite(v)) continue
        any = true
        if (v > m) m = v
    }
    return any ? m : null
}

function _signedDelta(a, b) {
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) return null
    return b - a
}

function _revenueWeek(econ, freq) {
    if (!econ || !econ.breakdown) return null
    const f = _safeNumber(freq) || 0
    if (f <= 0) return null
    return Math.round((econ.breakdown.revenue || 0) * f)
}

if (typeof window !== "undefined") {
    window.RouteAssistantOrsModel = RouteAssistantOrsModel
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantOrsModel
}
