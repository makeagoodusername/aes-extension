"use strict"

/**
 * Shared pricing plumbing for Route Assistant write paths.
 *
 * This is intentionally small and dependency-free. The pricing UI, dashboard
 * automator, inventory quick-price path, and tests all need the same answer to
 * two questions:
 *   - is this call a dry-run or a live POST?
 *   - how should per-class prices be formatted for logs / summaries?
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.RouteAssistantPricingPlumbing) return

    const CLASS_KEYS = ["Y", "C", "F", "Cargo"]
    const DEFAULT_LIVE_SCOPES = {
        manual: true,
        bulk: true,
        silentAuto: true,
        bulkRecommended: true
    }

    function _num(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    function normaliseApplyBlock(apply) {
        const src = apply && typeof apply === "object" ? apply : {}
        const liveScopes = Object.assign(
            {},
            DEFAULT_LIVE_SCOPES,
            (src.liveScopes && typeof src.liveScopes === "object") ? src.liveScopes : {}
        )
        if (src.permanentLiveMode === true) Object.assign(liveScopes, DEFAULT_LIVE_SCOPES)
        return {
            enabled: src.enabled !== false,
            dryRunOnly: src.permanentLiveMode === true ? false : src.dryRunOnly === true,
            liveScopes
        }
    }

    function resolveApplyGate(apply, scopeName, opts) {
        const a = normaliseApplyBlock(apply)
        const o = opts || {}
        const scope = scopeName || null
        const scopeLiveAllowed = scope ? a.liveScopes[scope] !== false : true
        const forcedDryRun = !!o.forceDryRun
        const dryRun = forcedDryRun || a.dryRunOnly || !a.enabled || !scopeLiveAllowed
        const reason = forcedDryRun ? "forced-dry-run"
            : a.dryRunOnly ? "dry-run-only"
            : !a.enabled ? "apply-disabled"
            : !scopeLiveAllowed ? "scope-disabled:" + scope
            : "live"
        return {
            applyEnabled: a.enabled,
            dryRunOnly: a.dryRunOnly,
            scopeName: scope,
            scopeLiveAllowed,
            forcedDryRun,
            dryRun,
            liveWrites: !dryRun,
            reason
        }
    }

    function classEnabledMap(src) {
        const out = {Y: true, C: true, F: true, Cargo: true}
        if (!src || typeof src !== "object") return out
        for (const cls of CLASS_KEYS) {
            if (typeof src[cls] === "boolean") out[cls] = src[cls]
        }
        return out
    }

    function classNumberMap() {
        const out = {}
        for (let i = 0; i < arguments.length; i++) {
            const src = arguments[i]
            if (!src || typeof src !== "object") continue
            for (const cls of CLASS_KEYS) {
                if (out[cls] != null) continue
                const n = _num(src[cls])
                if (n != null) out[cls] = n
            }
        }
        return out
    }

    function normalisePriceForClass(cls, value) {
        const n = Number(value)
        if (!isFinite(n)) return NaN
        return cls === "Cargo" ? Math.round(n * 100) / 100 : Math.round(n)
    }

    function formatPriceForClass(cls, value) {
        const n = normalisePriceForClass(cls, value)
        if (!isFinite(n)) return ""
        return cls === "Cargo"
            ? n.toFixed(2).replace(/\.?0+$/, "")
            : String(Math.round(n))
    }

    function pricesEqual(cls, a, b) {
        const left = normalisePriceForClass(cls, a)
        const right = normalisePriceForClass(cls, b)
        const tolerance = cls === "Cargo" ? 0.005 : 0.5
        return isFinite(left) && isFinite(right) && Math.abs(left - right) < tolerance
    }

    function summarizePriceMove(prevPrices, nextPrices) {
        const prev = prevPrices || {}
        const next = nextPrices || {}
        const parts = []
        for (const cls of CLASS_KEYS) {
            if (next[cls] == null) continue
            if (prev[cls] == null) {
                parts.push(cls + " -> " + formatPriceForClass(cls, next[cls]))
                continue
            }
            const p = Number(prev[cls])
            const n = Number(next[cls])
            if (pricesEqual(cls, p, n)) continue
            const pct = p > 0 ? ((n - p) / p) * 100 : null
            parts.push(cls + " " + formatPriceForClass(cls, p) + "->" + formatPriceForClass(cls, n)
                + (pct != null ? " (" + (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%)" : ""))
        }
        return parts.length ? parts.join(" · ") : "no-op"
    }

    window.RouteAssistantPricingPlumbing = {
        CLASS_KEYS,
        DEFAULT_LIVE_SCOPES,
        normaliseApplyBlock,
        resolveApplyGate,
        classEnabledMap,
        classNumberMap,
        normalisePriceForClass,
        formatPriceForClass,
        pricesEqual,
        summarizePriceMove
    }
})()
