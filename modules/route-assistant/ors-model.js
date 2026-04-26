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
 * Slice 1 scope:
 *   - Pax-only. Cargo numbers pass through estimator unchanged.
 *   - Y-anchored multi-class price slider; C/F scale proportionally.
 *   - Frequency dilutes LF only (no synthesised connections).
 *   - Closed-form rating shift + numeric-stable softmax for share.
 *   - Optional per-route T calibration against marketShare leaderboard.
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
     *   {priceMultiplier:1.0, frequency:null, comfortDelta:0}
     * @param {object} input.modelParams
     *   {ratingPriceElasticity, ratingComfortLift, shareTemperature, perRouteT?}
     * @param {object} input.economics — RouteAssistantSettings.economics
     * @param {boolean} input.useRealDemandForLF
     */
    static project(input) {
        input = input || {}
        const route    = input.route || {}
        const scenario = Object.assign({priceMultiplier: 1.0, frequency: null, comfortDelta: 0},
                                       input.scenario || {})
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

        // --- Per-class projection (Y, C, F independently) -------------------
        const perClass = {Y: null, C: null, F: null}
        const byClass  = route.orsByClass || {}
        const observedPrices = (route.ownPricing && route.ownPricing.prices) || {}
        const observedY = _safeNumber(observedPrices.Y)

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
            const newPrice = observed != null
                ? observed * (Number(scenario.priceMultiplier) || 1)
                : null
            perClass[cls] = RouteAssistantOrsModel._projectClass({
                classRec:      classRec,
                observedPrice: observed,
                newPrice:      newPrice,
                comfortDelta:  Number(scenario.comfortDelta) || 0,
                params:        params,
                T:             T,
                notes:         notes,
                cls:           cls,
                topCompetitorRating: _safeNumber(classRec.topCompetitorRating)
            })
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

        // --- Frequency lever — slice 1: dilute LF, don't synthesise connections.
        const baseFreq = _safeNumber(route.currentFrequency) || 0
        const newFreq  = scenario.frequency != null ? Math.max(0, Math.round(scenario.frequency)) : baseFreq
        const freqExceedsCurrent = newFreq > baseFreq
        if (freqExceedsCurrent && newFreq !== baseFreq) {
            notes.push("frequency above current; rank/share unchanged in slice 1 (LF affected only)")
        }

        // --- Demand pool — apply price-side elasticity ONCE.
        const basePool = _safeNumber(route.paxDemandPool)
        const elast    = _safeNumber(route.paxElasticity)
        let projPool = basePool
        if (basePool != null && observedY != null && scenario.priceMultiplier !== 1
            && elast != null && elast < 0) {
            projPool = basePool * Math.pow(scenario.priceMultiplier, elast)
        }

        // --- Pax/week = pool × share. Falls back to share-only when pool is null.
        const baselinePax = (basePool != null && baseShare != null)
            ? Math.round(basePool * baseShare) : null
        const projectedPax = (projPool != null && projShare != null)
            ? Math.round(projPool * projShare) : null

        // --- Revenue/profit projection via the existing estimator ----------
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

        const newPriceY = (observedY != null) ? observedY * (Number(scenario.priceMultiplier) || 1) : null
        const projectedEcon = RouteAssistantOrsModel._estimate({
            route:           route,
            economics:       economics,
            useRealDemand:   useRealDemand,
            paxPerWeekTarget: projectedPax,
            yieldPerKm:      (newPriceY != null && route.distanceKm > 0)
                ? newPriceY / route.distanceKm : null,
            paxDemandPool:   projPool,
            frequency:       newFreq
        })
        const projectedRevenueWk = _revenueWeek(projectedEcon, newFreq)

        // --- Build output --------------------------------------------------
        const baseline = {
            rating:          baseRating,
            rank:            primary ? primary.baselineRanks : null,
            share:           baseShare,
            paxPerWeek:      baselinePax,
            revenuePerWeek:  baselineRevenueWk,
            profitPerWeek:   baselineEcon ? baselineEcon.profitPerWeek : null,
            profitPerFlight: baselineEcon ? baselineEcon.profitPerFlight : null
        }
        const projected = {
            rating:          projRating,
            rank:            primary ? primary.projectedRanks : null,
            share:           projShare,
            paxPerWeek:      projectedPax,
            revenuePerWeek:  projectedRevenueWk,
            profitPerWeek:   projectedEcon ? projectedEcon.profitPerWeek : null,
            profitPerFlight: projectedEcon ? projectedEcon.profitPerFlight : null
        }
        // When freq exceeds current, suppress rank/share/rating projections so
        // the panel can gray those out and only show profit/revenue.
        if (freqExceedsCurrent && newFreq !== baseFreq) {
            projected.rating = baseline.rating
            projected.rank   = baseline.rank
            projected.share  = baseline.share
        }

        const delta = {
            rating:         _signedDelta(baseline.rating, projected.rating),
            share:          _signedDelta(baseline.share,  projected.share),
            paxPerWeek:     _signedDelta(baseline.paxPerWeek, projected.paxPerWeek),
            revenuePerWeek: _signedDelta(baseline.revenuePerWeek, projected.revenuePerWeek),
            profitPerWeek:  _signedDelta(baseline.profitPerWeek,  projected.profitPerWeek)
        }

        return {
            baseline:    baseline,
            projected:   projected,
            delta:       delta,
            perClass:    perClass,
            notes:       notes,
            modelParams: {
                ratingPriceElasticity: params.ratingPriceElasticity,
                ratingComfortLift:     params.ratingComfortLift,
                T:                     T,
                source:                _isPositive(params.perRouteT) ? "perRoute" : "global"
            },
            scenario:      scenario,
            baselineEcon:  baselineEcon,
            projectedEcon: projectedEcon,
            // Surface the proportionally-scaled C/F prices for the panel preview.
            scaledPrices:  {
                Y: newPriceY,
                C: _safeNumber(observedPrices.C) != null ? _safeNumber(observedPrices.C) * (Number(scenario.priceMultiplier) || 1) : null,
                F: _safeNumber(observedPrices.F) != null ? _safeNumber(observedPrices.F) * (Number(scenario.priceMultiplier) || 1) : null
            },
            elasticity: elast,
            adjustedPool: projPool
        }
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
        let clampedHigh = false, clampedLow = false
        const projectedRatings = tagged.map(t => {
            if (!t.oursAll) return t.rating  // leave competitors + mixed-ownership rows fixed
            const base = t.rating
            if (!base) return base
            const shifted = base
                - params.ratingPriceElasticity * priceRatio
                + params.ratingComfortLift * (arg.comfortDelta || 0)
            const lo = base * RouteAssistantOrsModel.RATING_CLAMP_LOW
            const hi = base * RouteAssistantOrsModel.RATING_CLAMP_HIGH
            if (shifted < lo) { clampedLow  = true; return lo }
            if (shifted > hi) { clampedHigh = true; return hi }
            return shifted
        })
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
            priceRatio:       priceRatio
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
            cargoDemandPool:    route.cargoDemandPool,
            useRealDemandForLF: !!arg.useRealDemand,
            override:           {paxLF: paxLF, yieldPerKm: arg.yieldPerKm},
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

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantOrsModel
}
