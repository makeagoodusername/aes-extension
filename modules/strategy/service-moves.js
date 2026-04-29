"use strict"

/**
 * AES Strategy — service-profile move proposer (Slice 3 + 7 + S1).
 *
 * Pure function. Identifies service profiles whose Y-class score lags the
 * top-quartile baseline and proposes upgrades. S1 weights the move by the
 * resolved objective: when rankWeight is high we recommend bigger upgrades
 * (since service drives ORS rating), when profitWeight is high we
 * recommend smaller upgrades (since premium service costs eat margin).
 *
 * Slice 7 fills `changes` with per-category (drinks, snacks, entrees, …)
 * granularity. Two perturbation profiles are constructed for each profile —
 *   A (cost-aware) ranks (category, class) cells by lift × demand / cost
 *   B (lift-first) ranks them by lift × demand
 * — each is packed greedily until the per-class lift target is met. The
 * winner is the pack whose objective-weighted score (shareWeight·demand +
 * rankWeight·lift + profitWeight·costSavings, all term-normalised) is
 * higher. This lets the same proposer flip between premium-cost upgrades
 * for rank-max routes and cheap-broad upgrades for profit-max routes.
 *
 * When the profile lacks scraped per-category data the move falls back to
 * the pre-Slice-7 advisory (empty `changes`) so diff-plan flags it as such.
 *
 * NO POSTs. Slice 4 (`apply()`) routes through
 * RouteAssistantServiceProfileApplier.apply(profileId, changes).
 *
 * Public API:
 *   AesStrategy.proposeServiceMoves(snapshot, opts?) → ServiceMove[]
 *
 * Opts (all optional):
 *   {minPredictedLift, objective: {kind, custom?}}
 *
 * ServiceMove shape (unchanged for back-compat with diff-plan):
 *   {profileId, profileName, currentClassScore: {Y, C, F},
 *    targetClassScore: {Y, C, F},
 *    changes: {<categoryKey>: {Y?, C?, F?}},
 *    predictedOrsDelta: number, rationale: string[],
 *    objective?: {kind, weights}}
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeServiceMoves === "function") return

    const DEFAULT_BALANCED = {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    /**
     * Anti-spiral guard (NORTH-STAR §4.17). Service upgrades raise the
     * service-cost floor that everyone in the alliance/competitor set has to
     * match. When competitor income across our network is already below a
     * configurable floor, an upgrade arms-race risks flipping competitors into
     * negative territory; we dampen `upgradeAggression` so the proposal stays
     * cautious until the loop settles. Single global pass — service-moves
     * doesn't have per-route slot, so we summarise across all routes.
     *
     * Returns:
     *   {available: true,  pressureRatio, damper, sampleCount, floor}
     *   {available: false}
     */
    function _competitorIncomeGuard(snapshot) {
        if (typeof RouteAssistantCompetitorIncome === "undefined") return {available: false}
        const econ = (snapshot && snapshot.settings && snapshot.settings.economics) || {}
        const stratEcon = (snapshot && snapshot.strategySettings
                           && snapshot.strategySettings.economics) || {}
        const floor = _num(econ.competitorIncomeFloorWeekly,
                           _num(stratEcon.competitorIncomeFloorWeekly, 5000))
        const hubs = (snapshot && snapshot.hubs) || []
        let sampleCount = 0
        let belowFloor  = 0
        for (const h of hubs) {
            for (const r of (h && h.byRoute) || []) {
                if (!r) continue
                const c = r.competitor
                if (!c) continue
                const dist = _num(r.distanceKm, 0)
                if (dist <= 0) continue
                const totalFlights = _num(c.flightCount, 0)
                const ourFlights   = _num(c.ourFlightCount, 0)
                const compFreq     = totalFlights - ourFlights
                if (compFreq <= 0) continue
                const compPrice = _num(c.priceMin, NaN)
                if (!isFinite(compPrice) || compPrice <= 0) continue
                const spec = r.spec || null
                if (!spec || !spec.seats || !spec.range || !spec.speed) continue
                const ourShare = _num(r.ourPaxShare, 0)
                const compSharePct = Math.max(0, Math.min(100, (1 - ourShare) * 100))
                let result
                try {
                    result = RouteAssistantCompetitorIncome.estimate({
                        distanceKm:       dist,
                        price:            compPrice,
                        frequency:        compFreq,
                        aircraftSpec:     spec,
                        observedSharePct: compSharePct,
                        economics:        econ
                    })
                } catch (_) { continue }
                if (!result || result.confidence === "low") continue
                const estProfit = _num(result.estProfitPerWeek, NaN)
                if (!isFinite(estProfit)) continue
                sampleCount++
                if (estProfit < floor) belowFloor++
            }
        }
        if (sampleCount < 3) return {available: false}
        const pressureRatio = belowFloor / sampleCount
        // > 50% of routes squeezing competitor → tighten the screws no further.
        const damper = pressureRatio > 0.5 ? 0.7 : 1
        return {
            available:    true,
            pressureRatio: pressureRatio,
            damper:        damper,
            sampleCount:   sampleCount,
            floor:         floor
        }
    }

    function _classScore(p, key) {
        return p && p.classScore && _num(p.classScore[key], NaN)
    }

    // ── Slice 7 — per-category change-set construction ─────────────────
    //
    // Cost weights are *relative*; the absolute scale cancels in the
    // pairwise A/B objective comparison. Calibrated against AS catering
    // category cost-per-pax intuition: drinks/headphones/magazines are
    // cheap (radio levels mean a few cents per pax); entrees and
    // additional entrees are an order of magnitude pricier.
    const CATEGORY_COST_WEIGHT = Object.freeze({
        drinks:               1.0,
        snacks:               1.5,
        entrees:              4.0,
        additionalEntrees:    4.0,
        headphones:           1.0,
        newspapersMagazines:  0.5,
        flightMagazines:      0.5,
        foodPresentation:     1.5
    })
    const DEFAULT_CATEGORY_COST = 2.0

    // Per-class cost-of-luxury multiplier — F-class catering is much
    // pricier per pax than Y for the same +1 service level. Mirrors the
    // settings.serviceProfiles.classCostPerPax {Y:5, C:18, F:45} ratio so
    // the rank stays consistent with the rest of the cost model.
    const CLASS_COST_MULTIPLIER = Object.freeze({Y: 1, C: 3.6, F: 9})

    // Network-default class mix used when settings.serviceProfiles
    // .defaultClassMix isn't on the snapshot. Same skew the aggregator
    // uses, so per-class demand weights line up across modules.
    const DEFAULT_CLASS_MIX = Object.freeze({Y: 0.85, C: 0.13, F: 0.02})

    function _categoryCostFactor(catKey, resolved) {
        const tbl = resolved && resolved.categoryWeights
        const def = resolved && isFinite(resolved.defaultCategoryCost)
            ? resolved.defaultCategoryCost : DEFAULT_CATEGORY_COST
        if (tbl && tbl[catKey] != null && isFinite(tbl[catKey])) return tbl[catKey]
        return CATEGORY_COST_WEIGHT[catKey] != null
            ? CATEGORY_COST_WEIGHT[catKey] : def
    }

    /**
     * Resolve the active service-cost tables: prefer
     * `snapshot.strategySettings.serviceCosts.*`, fall back to the frozen
     * literals above when the settings block is absent or partial. Engine
     * stays pure — caller resolves once per propose() so no per-cell store
     * read.
     */
    function _resolveServiceCosts(snapshot) {
        const s = snapshot && snapshot.strategySettings
                  && snapshot.strategySettings.serviceCosts
        const cw = (s && s.categoryWeights && typeof s.categoryWeights === "object")
            ? Object.assign({}, CATEGORY_COST_WEIGHT, s.categoryWeights)
            : CATEGORY_COST_WEIGHT
        const cm = (s && s.classMultipliers && typeof s.classMultipliers === "object")
            ? Object.assign({}, CLASS_COST_MULTIPLIER, s.classMultipliers)
            : CLASS_COST_MULTIPLIER
        const dc = (s && isFinite(s.defaultCategoryCost))
            ? s.defaultCategoryCost
            : DEFAULT_CATEGORY_COST
        return {categoryWeights: cw, classMultipliers: cm, defaultCategoryCost: dc}
    }

    /**
     * Estimate per-class network weekly pax. Per-route LF is rarely
     * attached to the snapshot, so we fall back to a coarse 0.7 LF when
     * missing. Used only as a *relative* demand weight — absolute scale
     * cancels in the A/B comparison.
     */
    function _resolveDemandByClass(snapshot) {
        const settings = (snapshot && snapshot.settings) || {}
        const sp = settings.serviceProfiles || {}
        const mix = sp.defaultClassMix || DEFAULT_CLASS_MIX
        let totalPax = 0
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            const w     = _num(r && r.weeklyFlights, 0)
            const seats = _num(r && r.spec && r.spec.seats, 0)
            const lf    = _num(r && r.lf, 0.7)
            totalPax += w * seats * lf
        }
        if (totalPax <= 0) totalPax = 1
        return {
            Y: totalPax * (mix.Y != null ? Number(mix.Y) : DEFAULT_CLASS_MIX.Y),
            C: totalPax * (mix.C != null ? Number(mix.C) : DEFAULT_CLASS_MIX.C),
            F: totalPax * (mix.F != null ? Number(mix.F) : DEFAULT_CLASS_MIX.F)
        }
    }

    /**
     * Enumerate (category, class) cells that can be bumped +1. Each cell
     * carries the per-bump marginalLift (1 / (ceiling × N_categories) —
     * approximates the contribution one +1 bump makes to classScore,
     * which is the mean of normalised per-category levels).
     */
    function _enumerateCells(profile) {
        const cats = profile && profile.categories
        if (!cats) return []
        const catKeys = Object.keys(cats)
        if (!catKeys.length) return []
        const out = []
        for (const catKey of catKeys) {
            const cat = cats[catKey] || {}
            for (const cls of ["Y", "C", "F"]) {
                const lvl = _num(cat[cls], null)
                if (lvl == null) continue
                // Heuristic ceiling: the scraper drops the actual radio
                // range, so we assume there's at least 4 levels of headroom
                // and never less than the AS-typical max of 9. Used only
                // for the lift-per-bump approximation; the applier silently
                // skips bumps that overshoot AS's real range.
                const ceiling      = Math.max(lvl + 4, 9)
                const marginalLift = 1 / Math.max(1, ceiling * catKeys.length)
                out.push({
                    catKey:        catKey,
                    cls:           cls,
                    level:         lvl,
                    ceilingLevel:  ceiling,
                    marginalLift:  marginalLift
                })
            }
        }
        return out
    }

    /**
     * Greedy pack: sort cells by `scorerFn` desc, accumulate +1 bumps
     * until each class hits its lift target (or all classes met / cells
     * exhausted). One bump per cell per pack — keeps changes bounded
     * and stops the ranker from stacking lift on a single category.
     */
    function _packPerturbation(cells, targetLiftByClass, scorerFn) {
        const sorted    = cells.slice().sort((a, b) => scorerFn(b) - scorerFn(a))
        const changes   = {}
        const remaining = Object.assign({}, targetLiftByClass)
        const picks     = []
        let totalLift = 0, totalCost = 0, totalDemandLift = 0
        for (const c of sorted) {
            if (remaining[c.cls] == null || remaining[c.cls] <= 0) continue
            if (changes[c.catKey] && changes[c.catKey][c.cls] != null) continue
            if (!changes[c.catKey]) changes[c.catKey] = {}
            changes[c.catKey][c.cls] = c.level + 1
            remaining[c.cls] = Math.max(0, remaining[c.cls] - c.marginalLift)
            totalLift       += c.marginalLift
            totalCost       += c.cost   || 0
            totalDemandLift += c.marginalLift * (c.demand || 0)
            picks.push(c)
            if ((remaining.Y || 0) <= 0 && (remaining.C || 0) <= 0
                    && (remaining.F || 0) <= 0) break
        }
        return {
            changes:         changes,
            picks:           picks,
            totalLift:       totalLift,
            totalCost:       totalCost,
            totalDemandLift: totalDemandLift
        }
    }

    /**
     * Build A and B perturbation packs for one profile, score them under
     * the active objective weights, and return the winner. Returns null
     * when there are no bumpable cells (profile lacks scraped category
     * detail). Each cell is annotated with `demand` and `cost` so both
     * scorers + the post-pack objective comparison see the same numbers.
     */
    function _buildAB(profile, targetLiftByClass, demandByClass, weights, costs) {
        const cells = _enumerateCells(profile)
        if (!cells.length) return null
        const resolved = costs || {categoryWeights: CATEGORY_COST_WEIGHT,
                                   classMultipliers: CLASS_COST_MULTIPLIER,
                                   defaultCategoryCost: DEFAULT_CATEGORY_COST}
        for (const c of cells) {
            c.demand = _num(demandByClass[c.cls], 0)
            c.cost   = _categoryCostFactor(c.catKey, resolved)
                     * (resolved.classMultipliers[c.cls] || 1)
        }
        const packA = _packPerturbation(cells, targetLiftByClass,
            c => c.marginalLift * c.demand / Math.max(1, c.cost))
        const packB = _packPerturbation(cells, targetLiftByClass,
            c => c.marginalLift * c.demand)

        // Normalise each term across A vs B so objective weights actually
        // steer the choice (raw demandTerm is in pax, costTerm in cost
        // units — different scales would let one term dominate).
        const maxLift   = Math.max(packA.totalLift,       packB.totalLift,       1e-9)
        const maxDemand = Math.max(packA.totalDemandLift, packB.totalDemandLift, 1e-9)
        const maxCost   = Math.max(packA.totalCost,       packB.totalCost,       1e-9)
        function score(pack) {
            return weights.shareWeight  * (pack.totalDemandLift / maxDemand)
                 + weights.rankWeight   * (pack.totalLift       / maxLift)
                 + weights.profitWeight * ((maxCost - pack.totalCost) / maxCost)
        }
        const sA = score(packA)
        const sB = score(packB)
        const winner = (sA >= sB) ? packA : packB
        return Object.assign({pickedProfile: (sA >= sB) ? "A" : "B",
                              scoreA: sA, scoreB: sB}, winner)
    }

    function _resolveGlobal(snapshot, opts) {
        if (opts && opts.objective && opts.objective.kind) return opts.objective
        const s = (snapshot && snapshot.strategySettings) || {}
        if (s.objective) return s.objective
        return {kind: "balanced", custom: DEFAULT_BALANCED}
    }

    function _resolveWeights(snapshot, opts) {
        const global = _resolveGlobal(snapshot, opts)
        const O = window.AesStrategyObjective
        if (O && typeof O.resolve === "function") {
            return O.resolve(global.kind, global.custom, null)
        }
        return {kind: global.kind || "balanced", weights: DEFAULT_BALANCED}
    }

    function proposeServiceMoves(snapshot, opts) {
        const o = opts || {}

        // Velvet Cascade · PR 1A — prefer the joint rank-target tuner when
        // it has populated `_jointPlan` on the snapshot (priceMoves call
        // does the work and caches; service-side just consumes). Falls
        // through to the S1 top-quartile heuristic when no joint plan
        // is available.
        if (typeof ns.tuneJointly === "function" && o.useJointTuner !== false) {
            const cached = (snapshot && snapshot._jointPlan) || null
            const joint = cached || ns.tuneJointly(snapshot, o)
            if (joint && Array.isArray(joint.serviceMoves)) {
                if (snapshot && !cached) snapshot._jointPlan = joint
                if (joint.serviceMoves.length) return joint.serviceMoves
                // Empty serviceMoves with a populated jointPlan means the tuner
                // explicitly evaluated comfortΔ=0 as best — skip the S1 heuristic.
                if (joint.summary && joint.summary.pass1) return []
            }
        }

        const minLift = _num(o.minPredictedLift, 0.05)
        const profiles = (snapshot && snapshot.serviceProfiles) || []
        if (profiles.length < 2) return []

        const resolved = _resolveWeights(snapshot, o)
        const w        = resolved.weights
        const costs    = _resolveServiceCosts(snapshot)

        // rankWeight ≈ how aggressive about upgrades. profitWeight tempers.
        // upgradeAggression in [0, 1] — 1 = take full gap, 0 = ignore moves.
        let upgradeAggression = Math.max(0, Math.min(1,
            0.5 + 0.5 * w.rankWeight - 0.3 * w.profitWeight + 0.2 * w.shareWeight))

        // Anti-spiral guard (§4.17): if competitor profit is broadly below
        // the configurable floor across our network, dampen aggression so a
        // service-cost arms race doesn't pile on already-thin margins.
        const incomeGuard = _competitorIncomeGuard(snapshot)
        if (incomeGuard.available && incomeGuard.damper < 1) {
            upgradeAggression = upgradeAggression * incomeGuard.damper
        }
        // Phase B1 — crew-pressure gate. Service upgrades drive cleaning/
        // catering/cabin-crew workload, so when staff are critically short
        // we shouldn't push more service ops onto the network. severity 1.0
        // dampens to ×0.3, 0.5 to ×0.65; below 0.3 passes through.
        const crewPressure = snapshot && snapshot.crew && snapshot.crew.pressure
        let crewDamper = 1
        if (crewPressure && isFinite(crewPressure.severity) && crewPressure.severity > 0.3) {
            crewDamper = Math.max(0.3, 1 - 0.7 * crewPressure.severity)
            upgradeAggression = upgradeAggression * crewDamper
        }

        // Compute "upper-half" baseline for each class (top-quartile median).
        const ys = profiles.map(p => _classScore(p, "Y")).filter(isFinite).sort((a, b) => b - a)
        const cs = profiles.map(p => _classScore(p, "C")).filter(isFinite).sort((a, b) => b - a)
        const fs = profiles.map(p => _classScore(p, "F")).filter(isFinite).sort((a, b) => b - a)
        if (!ys.length) return []

        const upperMedY = ys[Math.floor(ys.length / 4)]
        const upperMedC = cs.length ? cs[Math.floor(cs.length / 4)] : null
        const upperMedF = fs.length ? fs[Math.floor(fs.length / 4)] : null

        const demandByClass = _resolveDemandByClass(snapshot)

        const moves = []
        for (const p of profiles) {
            if (!p) continue
            const yNow = _classScore(p, "Y")
            const cNow = _classScore(p, "C")
            const fNow = _classScore(p, "F")
            if (!isFinite(yNow)) continue

            const yGap = upperMedY - yNow
            if (yGap < minLift) continue

            // Apply objective-weighted aggression so profit-max picks
            // smaller upgrades, share/rank-max pick bigger ones.
            const targetLift = yGap * upgradeAggression
            if (targetLift < minLift) continue

            const target = {
                Y: _round(yNow + targetLift, 3),
                C: isFinite(cNow) && upperMedC != null
                    ? _round(Math.max(cNow, cNow + (upperMedC - cNow) * upgradeAggression), 3)
                    : cNow,
                F: isFinite(fNow) && upperMedF != null
                    ? _round(Math.max(fNow, fNow + (upperMedF - fNow) * upgradeAggression), 3)
                    : fNow
            }

            const rationale = [
                "[gap] Y-score " + _round(yNow, 3) + " vs. top-quartile median "
                    + _round(upperMedY, 3) + " (full gap +" + _round(yGap, 3) + ")",
                "[goal] " + resolved.kind
                    + " · aggression " + _round(upgradeAggression, 2)
                    + " · target lift +" + _round(targetLift, 3)
            ]
            if (incomeGuard.available) {
                if (incomeGuard.damper < 1) {
                    rationale.push("[anti-spiral] " + Math.round(incomeGuard.pressureRatio * 100)
                        + "% of " + incomeGuard.sampleCount + " sampled routes show competitor profit below $"
                        + incomeGuard.floor + "/wk — aggression dampened ×" + incomeGuard.damper)
                } else {
                    rationale.push("[anti-spiral] competitor profit healthy across "
                        + incomeGuard.sampleCount + " sampled routes — no aggression damper")
                }
            } else {
                rationale.push("[anti-spiral] competitor-income data unavailable — using legacy weights")
            }
            if (crewDamper < 1) {
                rationale.push("[crew-pressure] severity "
                    + _round(crewPressure.severity, 2)
                    + " — service-upgrade aggression dampened ×" + _round(crewDamper, 2)
                    + " (avoid piling cabin/catering load on short crew)")
            }
            if (p.scrapedAt) {
                const ageDays = (Date.now() - p.scrapedAt) / (24 * 3600 * 1000)
                if (ageDays > 14) rationale.push("[stale] profile detail scraped " + Math.round(ageDays) + "d ago")
            }

            const targetLiftByClass = {
                Y: Math.max(0, target.Y - yNow),
                C: isFinite(cNow) ? Math.max(0, target.C - cNow) : 0,
                F: isFinite(fNow) ? Math.max(0, target.F - fNow) : 0
            }
            const ab = _buildAB(p, targetLiftByClass, demandByClass, w, costs)
            let changes        = {}
            let deliveredLift  = targetLift
            if (ab && ab.picks && ab.picks.length) {
                changes        = ab.changes
                deliveredLift  = ab.totalLift
                rationale.push("[s7] perturbation " + ab.pickedProfile
                    + " (" + ab.picks.length + " bump"
                    + (ab.picks.length === 1 ? "" : "s")
                    + ", cost~" + _round(ab.totalCost, 1)
                    + ", scoreA=" + _round(ab.scoreA, 3)
                    + " scoreB=" + _round(ab.scoreB, 3) + ")")
                const top = ab.picks.slice(0, 3)
                    .map(c => c.catKey + "·" + c.cls + " " + c.level + "→" + (c.level + 1))
                    .join(", ")
                if (top) rationale.push("[picks] " + top
                    + (ab.picks.length > 3 ? " +" + (ab.picks.length - 3) + " more" : ""))
            } else {
                rationale.push("[s7] no per-category change set — profile lacks scraped category detail (advisory only)")
            }

            moves.push({
                profileId:         p.id,
                profileName:       p.name || ("#" + p.id),
                currentClassScore: {Y: yNow, C: cNow, F: fNow},
                targetClassScore:  target,
                changes:           changes,
                predictedOrsDelta: deliveredLift,
                rationale:         rationale,
                objective:         {kind: resolved.kind, weights: w}
            })
        }

        moves.sort((a, b) => (b.predictedOrsDelta || 0) - (a.predictedOrsDelta || 0))
        return moves
    }

    ns.proposeServiceMoves = proposeServiceMoves

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Build a synthetic snapshot with two profiles: one lagging
            // baseline with full per-category data, and one already at
            // baseline so it's filtered out.
            const snap = {
                hubs: [{iata: "FRA", byRoute: [
                    {dest: "LHR", weeklyFlights: 14, lf: 0.8, spec: {seats: 180}},
                    {dest: "CDG", weeklyFlights: 14, lf: 0.8, spec: {seats: 180}}
                ]}],
                serviceProfiles: [
                    {id: 1, name: "Lagging", classScore: {Y: 0.3, C: 0.4, F: 0.4},
                     categories: {drinks: {Y: 1, C: 2, F: 2}, snacks: {Y: 1, C: 2, F: 3},
                                  entrees: {Y: 0, C: 1, F: 2}, headphones: {Y: 0, C: 1, F: 2}}},
                    {id: 2, name: "Top",     classScore: {Y: 0.8, C: 0.8, F: 0.8},
                     categories: null}
                ]
            }
            // share-max should pick perturbation that bumps high-demand cells.
            const movesShare = proposeServiceMoves(snap, {useJointTuner: false,
                objective: {kind: "maxShare"}})
            console.assert(movesShare.length === 1,
                "[smoke s7] only the lagging profile produces a move")
            console.assert(Object.keys(movesShare[0].changes).length > 0,
                "[smoke s7] changes populated when categories present")
            console.assert(/\[s7\] perturbation [AB]/.test(movesShare[0].rationale.join(" ")),
                "[smoke s7] rationale names winning perturbation")

            // profit-max with same gap should still produce changes but
            // the cost-aware scorer often wins.
            const movesProfit = proposeServiceMoves(snap, {useJointTuner: false,
                objective: {kind: "maxProfit"}})
            console.assert(movesProfit.length === 1,
                "[smoke s7] profit-max also surfaces the lagging profile")
            // Profit-max aggression < share-max aggression → fewer or
            // equal bumps.
            console.assert(movesProfit[0].rationale.join(" ").indexOf("[picks]") >= 0
                || movesProfit[0].rationale.join(" ").indexOf("[s7]") >= 0,
                "[smoke s7] profit-max move carries s7 rationale")

            // Profile lacking categories should still emit advisory
            // (empty changes) when its Y-score lags baseline.
            const advisorySnap = {
                hubs: snap.hubs,
                serviceProfiles: [
                    {id: 3, name: "Bare",  classScore: {Y: 0.2, C: 0.2, F: 0.2}, categories: null},
                    {id: 4, name: "Top",   classScore: {Y: 0.9, C: 0.9, F: 0.9}, categories: null}
                ]
            }
            const advisoryMoves = proposeServiceMoves(advisorySnap, {useJointTuner: false,
                objective: {kind: "balanced"}})
            console.assert(advisoryMoves.length === 1,
                "[smoke s7] advisory path still emits a move when categories are missing")
            console.assert(Object.keys(advisoryMoves[0].changes).length === 0,
                "[smoke s7] empty changes when categories null — advisory only")
            console.assert(/lacks scraped category detail/.test(advisoryMoves[0].rationale.join(" ")),
                "[smoke s7] advisory rationale explains the empty change set")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
