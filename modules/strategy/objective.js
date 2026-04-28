"use strict"

/**
 * AES Strategy — objective resolver and scoring (Slice S1).
 *
 * Pure module. Maps a user-selected goal kind onto a weight triple
 * {shareWeight, profitWeight, rankWeight} and exposes a scalar
 * score(projection, opts) function so price/service proposers can pick
 * the best candidate for the active goal.
 *
 * Storage: settings.strategy.objective = {kind, custom: {...}}
 *   - kind ∈ {"maxShare","maxProfit","balanced","custom"}
 *   - custom is consulted only when kind === "custom"; weights are
 *     normalised to sum to 1 (defaulting to balanced if all zeros).
 *
 * Per-route override resolution lives in route-objective-store.js;
 * AesStrategyObjective.resolve() takes the snapshot's per-route map
 * + global settings + (hub, dest) and returns the objective triple
 * the proposer should use for that route.
 *
 * Public API (window.AesStrategyObjective):
 *   resolve(globalKind, customWeights, perRouteRec?)
 *     → {kind, weights: {shareWeight, profitWeight, rankWeight}}
 *   resolveForRoute(snapshot, hub, dest)
 *     → same as above; reads snapshot.routeObjectives + snapshot.settings
 *   score(projection, weights)
 *     → scalar; higher is better. Pure.
 *   KINDS                           → frozen array of valid kinds
 *   PRESET_WEIGHTS[kind]            → frozen weights for non-"custom" kinds
 *
 * `projection` shape (what proposers feed into score()):
 *   {share, profit, rank,
 *    baselineShare?, baselineProfit?, baselineRank?}
 *
 * The score is normalised so a "no change" projection scores 0; positive
 * means the candidate is better than baseline. This keeps deadband checks
 * trivial — `score < epsilon` ⇒ skip.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyObjective) return

    const KINDS = Object.freeze(["maxShare", "maxProfit", "balanced", "custom"])

    const PRESET_WEIGHTS = Object.freeze({
        maxShare:  Object.freeze({shareWeight: 0.7, profitWeight: 0.2, rankWeight: 0.1}),
        maxProfit: Object.freeze({shareWeight: 0.1, profitWeight: 0.8, rankWeight: 0.1}),
        balanced:  Object.freeze({shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2})
    })

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _normalise(weights) {
        const s = Math.max(0, _num(weights && weights.shareWeight,  0))
        const p = Math.max(0, _num(weights && weights.profitWeight, 0))
        const r = Math.max(0, _num(weights && weights.rankWeight,   0))
        const total = s + p + r
        if (total <= 0) return Object.assign({}, PRESET_WEIGHTS.balanced)
        return {shareWeight: s / total, profitWeight: p / total, rankWeight: r / total}
    }

    function resolve(globalKind, customWeights, perRouteRec) {
        if (perRouteRec && perRouteRec.kind) {
            const k = String(perRouteRec.kind)
            if (k === "custom") {
                return {kind: "custom", weights: _normalise(perRouteRec.custom)}
            }
            if (PRESET_WEIGHTS[k]) {
                return {kind: k, weights: Object.assign({}, PRESET_WEIGHTS[k])}
            }
        }
        const k = (globalKind && PRESET_WEIGHTS[globalKind]) ? globalKind
                : (globalKind === "custom" ? "custom" : "balanced")
        if (k === "custom") return {kind: "custom", weights: _normalise(customWeights)}
        return {kind: k, weights: Object.assign({}, PRESET_WEIGHTS[k])}
    }

    function resolveForRoute(snapshot, hub, dest) {
        const settings = snapshot && snapshot.settings || {}
        const strategy = (settings.strategy || (snapshot && snapshot.strategySettings)) || {}
        const obj = strategy.objective || {}
        const globalKind = obj.kind || "balanced"
        const customWeights = obj.custom || null
        const map = snapshot && snapshot.routeObjectives
        let perRoute = null
        if (map && hub && dest) {
            const k = String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
            perRoute = (typeof map.get === "function") ? map.get(k) : map[k]
        }
        return resolve(globalKind, customWeights, perRoute)
    }

    /**
     * Compute the score for a candidate projection. Higher is better.
     *
     * Each component is computed as a delta over baseline so the same
     * scale fits "no change" → 0:
     *   shareTerm  = projection.share - baselineShare    (∈ [-1, 1])
     *   profitTerm = (projection.profit - baselineProfit) / max(|baselineProfit|, 1)
     *                clamped to [-1, 1]
     *   rankTerm   = +1 → rank #1, -1 → rank ≥10, linearly between
     *                with sign indicating improvement (so rising from #5 to #2 is positive)
     *
     * If a baseline is missing the term contributes 0 (no opinion).
     */
    function score(projection, weights) {
        const w = _normalise(weights || PRESET_WEIGHTS.balanced)
        const p = projection || {}

        let shareTerm = 0
        if (isFinite(p.share) && isFinite(p.baselineShare)) {
            shareTerm = Math.max(-1, Math.min(1, _num(p.share, 0) - _num(p.baselineShare, 0)))
        }

        let profitTerm = 0
        if (isFinite(p.profit) && isFinite(p.baselineProfit)) {
            const denom = Math.max(Math.abs(_num(p.baselineProfit, 0)), 1)
            profitTerm = Math.max(-1, Math.min(1, (_num(p.profit, 0) - _num(p.baselineProfit, 0)) / denom))
        }

        let rankTerm = 0
        if (isFinite(p.rank) && p.rank > 0) {
            const bestPossible = (isFinite(p.baselineRank) && p.baselineRank > 0)
                ? Math.min(p.baselineRank, 10) : 10
            const baseScore = (10 - Math.min(bestPossible, 10)) / 9   // 0..1
            const projScore = (10 - Math.min(_num(p.rank, 10), 10)) / 9 // 0..1
            rankTerm = Math.max(-1, Math.min(1, projScore - baseScore))
        }

        return w.shareWeight * shareTerm
             + w.profitWeight * profitTerm
             + w.rankWeight   * rankTerm
    }

    window.AesStrategyObjective = {
        KINDS:           KINDS,
        PRESET_WEIGHTS:  PRESET_WEIGHTS,
        resolve:         resolve,
        resolveForRoute: resolveForRoute,
        score:           score,
        normalise:       _normalise
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const r = resolve("maxProfit", null, null)
            console.assert(r.kind === "maxProfit",                                "[smoke obj] kind preserved")
            console.assert(Math.abs(r.weights.profitWeight - 0.8) < 1e-6,         "[smoke obj] maxProfit profit weight")
            const cust = resolve("custom", {shareWeight: 1, profitWeight: 1, rankWeight: 0}, null)
            console.assert(Math.abs(cust.weights.shareWeight - 0.5) < 1e-6,       "[smoke obj] custom normalised")
            const fall = resolve("custom", {shareWeight: 0, profitWeight: 0, rankWeight: 0}, null)
            console.assert(Math.abs(fall.weights.profitWeight - 0.4) < 1e-6,      "[smoke obj] zero custom → balanced")
            const sNoChange = score({share: 0.3, profit: 100, rank: 3,
                                     baselineShare: 0.3, baselineProfit: 100, baselineRank: 3}, r.weights)
            console.assert(Math.abs(sNoChange) < 1e-9,                            "[smoke obj] no-change → 0")
            const sBetter = score({share: 0.4, profit: 150, rank: 1,
                                   baselineShare: 0.3, baselineProfit: 100, baselineRank: 3},
                                   PRESET_WEIGHTS.balanced)
            console.assert(sBetter > 0,                                            "[smoke obj] strict improvement → positive")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
