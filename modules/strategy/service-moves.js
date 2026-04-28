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
 * v1 stays coarse — `changes` is left empty so the existing applier
 * routes profile-level deltas. Slice 7 fills per-category (drinks,
 * snacks, …) granularity.
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
        const floor = _num(econ.competitorIncomeFloorWeekly, 5000)
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

        // Compute "upper-half" baseline for each class (top-quartile median).
        const ys = profiles.map(p => _classScore(p, "Y")).filter(isFinite).sort((a, b) => b - a)
        const cs = profiles.map(p => _classScore(p, "C")).filter(isFinite).sort((a, b) => b - a)
        const fs = profiles.map(p => _classScore(p, "F")).filter(isFinite).sort((a, b) => b - a)
        if (!ys.length) return []

        const upperMedY = ys[Math.floor(ys.length / 4)]
        const upperMedC = cs.length ? cs[Math.floor(cs.length / 4)] : null
        const upperMedF = fs.length ? fs[Math.floor(fs.length / 4)] : null

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
                    + " · target lift +" + _round(targetLift, 3),
                "[note] v1 emits coarse profile recommendation — Slice 7 produces per-category change set"
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
            if (p.scrapedAt) {
                const ageDays = (Date.now() - p.scrapedAt) / (24 * 3600 * 1000)
                if (ageDays > 14) rationale.push("[stale] profile detail scraped " + Math.round(ageDays) + "d ago")
            }

            moves.push({
                profileId:         p.id,
                profileName:       p.name || ("#" + p.id),
                currentClassScore: {Y: yNow, C: cNow, F: fNow},
                targetClassScore:  target,
                changes:           {},
                predictedOrsDelta: targetLift,
                rationale:         rationale,
                objective:         {kind: resolved.kind, weights: w}
            })
        }

        moves.sort((a, b) => (b.predictedOrsDelta || 0) - (a.predictedOrsDelta || 0))
        return moves
    }

    ns.proposeServiceMoves = proposeServiceMoves
})()
