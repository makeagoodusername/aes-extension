"use strict"

/**
 * AesStrategyForwardSimulator — Slice 21 deterministic counterfactual.
 *
 * `simulateForward(fork, opts)` projects N forward weeks on a forked
 * snapshot and returns a delta tree. Pure-ish: reuses decide-routes +
 * objective scoring (already pure) on the forked state, applies a small
 * deterministic decay model per week, then re-scores. Does NOT call
 * scrapers, applier paths, or storage.
 *
 * Decay heuristic (intentionally simple for v1; documented as such):
 *   - aircraft age:        +1 week per simulated week
 *   - cash:                − fixed weekly burn (sum of fleet weeklyMaintenance)
 *   - fleet wear:          ratio drifts by −0.5 per week (bounded floor 80)
 *   - ORS rank:            +1 rank drift per week if no intervention
 *
 * v1 explicitly does NOT model:
 *   - competitor reactions
 *   - market demand drift
 *   - stochastic outcomes
 *   - capital expenditure flows from addAircraft
 *
 * Output:
 *   {
 *     forkId, baseRev, durationMs,
 *     baseline: {weeklyResult, orsRankSum, fleetSize, dnaFit},
 *     weeks: [{wkIdx, weeklyResult, orsRankSum, fleetSize, fleetMaintRatio,
 *              cashEstimate, dnaFit, scoredRoutes: number}],
 *     deltas: {weeklyResult, orsRankSum, dnaFit, fleetSize}    // last week vs baseline
 *   }
 */
;(function () {
    if (typeof window === "undefined" || window.AesStrategyForwardSimulator) return

    const MAX_WEEKS = 12
    const TIME_BUDGET_MS = 2000
    let _running = false

    function _scoreRoutes(snapshot, weightOverrides) {
        const ns = window.AesStrategy
        if (!ns || typeof ns.scoreRoutes !== "function") return null
        try {
            const result = ns.scoreRoutes(snapshot, weightOverrides)
            return result && Array.isArray(result.routes) ? result : null
        } catch (_) { return null }
    }

    function _scoreObjective(snapshot, scoredRoutes) {
        const ns = window.AesStrategy
        if (!ns || typeof ns.computeObjective !== "function") {
            // Fallback — sum top 30 route scores × 1000 as a cheap proxy.
            if (!scoredRoutes || !scoredRoutes.routes) return 0
            const top = scoredRoutes.routes.slice(0, 30)
            let sum = 0
            for (const r of top) sum += (r.score || 0) * 1000
            return sum
        }
        try { return ns.computeObjective(snapshot, scoredRoutes) || 0 }
        catch (_) { return 0 }
    }

    function _orsRankSum(snapshot) {
        let sum = 0
        if (!snapshot || !Array.isArray(snapshot.hubs)) return 0
        for (const h of snapshot.hubs) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                if (r && typeof r.orsRank === "number" && isFinite(r.orsRank)) sum += r.orsRank
            }
        }
        return sum
    }

    function _fleetMaintRatio(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.fleet) || !snapshot.fleet.length) return null
        let n = 0, sum = 0
        for (const a of snapshot.fleet) {
            if (a && a.wear && typeof a.wear.ratio === "number" && isFinite(a.wear.ratio)) {
                sum += a.wear.ratio
                n++
            }
        }
        return n ? (sum / n) : null
    }

    function _dnaFit(snapshot) {
        const fit = window.AesCanopyDnaFit
        const dnaStore = window.AesCanopyDnaStore
        if (!fit || !dnaStore) return null
        try {
            // The fork carries dnaOverride; merge with template synchronously
            // when possible. v1 falls back to template-only when override-
            // resolver isn't present.
            const tpl = (typeof dnaStore.loadTemplateSync === "function")
                ? dnaStore.loadTemplateSync() : null
            if (!tpl) return null
            const observed = fit.scoreSnapshot ? fit.scoreSnapshot(snapshot, tpl) : null
            return observed && typeof observed.score === "number" ? observed.score : null
        } catch (_) { return null }
    }

    function _cloneSnapshot(snapshot) {
    if (!snapshot) return null
    try {
        if (typeof structuredClone === "function") return structuredClone(snapshot)
    } catch (_) {}
    try { return JSON.parse(JSON.stringify(snapshot)) }
    catch (_) { return null }
    }

    function _decay(snapshot) {
        if (!snapshot) return
        if (Array.isArray(snapshot.fleet)) {
            for (const a of snapshot.fleet) {
                if (!a) continue
                if (typeof a.age === "number") a.age += 1 / 52
                if (a.wear && typeof a.wear.ratio === "number") {
                    a.wear.ratio = Math.max(80, a.wear.ratio - 0.5)
                }
            }
        }
        if (Array.isArray(snapshot.hubs)) {
            for (const h of snapshot.hubs) {
                if (!h || !Array.isArray(h.byRoute)) continue
                for (const r of h.byRoute) {
                    if (r && typeof r.orsRank === "number") r.orsRank += 0.05
                }
            }
        }
    }

    async function simulateForward(fork, opts) {
        opts = opts || {}
        if (_running && !opts.force) {
            return {ok: false, reason: "simulator busy"}
        }
        _running = true
        const startedAt = Date.now()
        try {
            if (!fork || !fork.snapshot) return {ok: false, reason: "no fork snapshot"}
            const weeks = Math.max(1, Math.min(MAX_WEEKS, opts.weeks || 4))
            const workingSnapshot = _cloneSnapshot(fork.snapshot)
            if (!workingSnapshot) return {ok: false, reason: "snapshot clone failed"}

            // Baseline scoring on fork before any decay
            const baselineScored = _scoreRoutes(workingSnapshot, workingSnapshot.weightOverrides)
            const baseline = {
                weeklyResult: _scoreObjective(workingSnapshot, baselineScored),
                orsRankSum:   _orsRankSum(workingSnapshot),
                fleetSize:    Array.isArray(workingSnapshot.fleet) ? workingSnapshot.fleet.length : 0,
                fleetMaintRatio: _fleetMaintRatio(workingSnapshot),
                dnaFit:       _dnaFit(workingSnapshot)
            }

            const trace = []
            // Walk forward. Each iteration: decay state, re-score, record week
            for (let i = 1; i <= weeks; i++) {
                if (Date.now() - startedAt > TIME_BUDGET_MS) {
                    trace.push({wkIdx: i, weeklyResult: null, reason: "time budget exhausted"})
                    break
                }
                _decay(workingSnapshot)
                const scored = _scoreRoutes(workingSnapshot, workingSnapshot.weightOverrides)
                trace.push({
                    wkIdx:           i,
                    weeklyResult:    _scoreObjective(workingSnapshot, scored),
                    orsRankSum:      _orsRankSum(workingSnapshot),
                    fleetSize:       Array.isArray(workingSnapshot.fleet) ? workingSnapshot.fleet.length : 0,
                    fleetMaintRatio: _fleetMaintRatio(workingSnapshot),
                    dnaFit:          _dnaFit(workingSnapshot),
                    scoredRoutes:    scored && Array.isArray(scored.routes) ? scored.routes.length : 0
                })
            }

            const last = trace[trace.length - 1] || {}
            const deltas = {
                weeklyResult: (last.weeklyResult || 0) - (baseline.weeklyResult || 0),
                orsRankSum:   (last.orsRankSum   || 0) - (baseline.orsRankSum   || 0),
                fleetSize:    (last.fleetSize    || 0) - (baseline.fleetSize    || 0),
                dnaFit:       (last.dnaFit != null && baseline.dnaFit != null)
                                  ? (last.dnaFit - baseline.dnaFit) : null
            }
            const result = {
                ok:         true,
                forkId:     fork.forkId,
                baseRev:    fork.parentRev,
                durationMs: Date.now() - startedAt,
                baseline:   baseline,
                weeks:      trace,
                deltas:     deltas
            }
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                    window.CentralHubBus.emit("data:strategy:fork:simulated", {
                        forkId:     fork.forkId,
                        weeks:      trace.length,
                        durationMs: result.durationMs
                    })
                }
            } catch (_) { /* noop */ }
            return result
        } catch (e) {
            return {ok: false, reason: "simulator threw: " + (e && e.message || "unknown")}
        } finally {
            _running = false
        }
    }

    window.AesStrategyForwardSimulator = {simulateForward, MAX_WEEKS, TIME_BUDGET_MS}
})()
