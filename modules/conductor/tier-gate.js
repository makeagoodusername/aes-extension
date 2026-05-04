"use strict"

/**
 * AesConductorTierGate — pure tier resolution for K11.
 *
 * Maps a (scenario, fire, trustEntry, settings) tuple onto a tier string +
 * one-line reason. Called by scenario-engine after every fire is appended,
 * and by tile/UI surfaces that need to render the same decision.
 *
 * Order of clamps (most-restrictive wins):
 *   1. globalMax (user-set ceiling across all scenarios; default "apply-confirm")
 *   2. scenarioCeilings[scenarioId] (per-scenario user override; §4.15)
 *   3. scenario.defaultTierCap (per-scenario shipped default)
 *   4. trustEntry.ceiling (K14 drift demotion)
 *   5. trustEntry.tier (LCB-derived candidate, with hysteresis already applied)
 *
 * Tier semantics:
 *   alert         — informational; no apply path
 *   suggest       — UI affordances appear (Open/Apply buttons) but every action is gated
 *   apply-confirm — Apply button opens the dispatch with confirm-required
 *   apply-auto    — dispatch can fire without confirm (still passes through apply-pipeline two-gate)
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorTierGate) return

    const TIER_ORDER = ["alert", "suggest", "apply-confirm", "apply-auto"]
    const DEFAULT_GLOBAL_MAX = "apply-confirm"

    function _idx(tier) { return TIER_ORDER.indexOf(tier) }

    function _minTier(...tiers) {
        let lo = TIER_ORDER.length - 1
        const found = []
        for (const t of tiers) {
            if (!t) continue
            const i = _idx(t)
            if (i < 0) continue
            found.push(t)
            if (i < lo) lo = i
        }
        if (!found.length) return "alert"
        return TIER_ORDER[lo]
    }

    /** Pure. Returns {tier, reason, candidate, clamps:[]} so the tile and
     *  rationale string can show every stop along the way. */
    function gate(scenario, trustEntry, settings) {
        const sc = scenario || {}
        const te = trustEntry || {tier: "alert", lcb: 0, tq: 0.5, n: 0, ceiling: null}
        const cfg = settings || {}
        const candidate = te.tier || "alert"

        const scenarioCeilings = (cfg.scenarioCeilings && typeof cfg.scenarioCeilings === "object")
            ? cfg.scenarioCeilings : {}
        const userOverride = scenarioCeilings[sc.id] || null
        const shippedCap   = sc.defaultTierCap || null
        const driftCeiling = te.ceiling || null
        const globalMax    = cfg.globalMax || DEFAULT_GLOBAL_MAX

        const clamps = []
        if (userOverride)  clamps.push("user:" + userOverride)
        if (shippedCap)    clamps.push("default:" + shippedCap)
        if (driftCeiling)  clamps.push("drift:" + driftCeiling)
        if (globalMax)     clamps.push("global:" + globalMax)

        const final = _minTier(candidate, userOverride, shippedCap, driftCeiling, globalMax)

        let reason
        if (final === candidate && !clamps.length) {
            reason = "TQ=" + te.tq.toFixed(2) + " LCB=" + te.lcb.toFixed(2) + " n=" + te.n + " → " + final
        } else if (final === candidate) {
            reason = "TQ=" + te.tq.toFixed(2) + " LCB=" + te.lcb.toFixed(2) + " → " + final
                + " (no clamp tighter than candidate)"
        } else {
            const tighteners = []
            if (userOverride && _idx(userOverride) === _idx(final))  tighteners.push("user")
            if (shippedCap   && _idx(shippedCap)   === _idx(final))  tighteners.push("default")
            if (driftCeiling && _idx(driftCeiling) === _idx(final))  tighteners.push("drift")
            if (globalMax    && _idx(globalMax)    === _idx(final))  tighteners.push("global")
            reason = "TQ=" + te.tq.toFixed(2) + " LCB=" + te.lcb.toFixed(2)
                + " → candidate " + candidate + ", clamped to " + final
                + (tighteners.length ? " by " + tighteners.join("+") : "")
        }
        return {tier: final, reason: reason, candidate: candidate, clamps: clamps}
    }

    /** Convenience — true if `tier` permits the given action. The action
     *  hierarchy is the same as the tier hierarchy. */
    function permits(tier, action) {
        const ti = _idx(tier)
        const ai = _idx(action)
        if (ti < 0 || ai < 0) return false
        return ti >= ai
    }

    window.AesConductorTierGate = {gate, permits, TIER_ORDER, DEFAULT_GLOBAL_MAX}
})()
