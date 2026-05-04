"use strict"

/**
 * AesConductorTrustStore — K11 Trust Quotient.
 *
 * Maintains a per-(account, scenarioId) Beta-Bayesian success posterior
 * driven by the K10 verdict stream. Computes the Trust Quotient
 * `TQ ∈ [0,1]` (posterior mean) plus a 5%-percentile lower-confidence
 * bound (LCB) used by the tier-gate to promote/demote scenarios.
 *
 * Storage:
 *   aesConductor:trust:<server>:<airline>  → {<scenarioId>: TrustEntry}
 *
 * TrustEntry:
 *   {
 *     alpha:   number,         // Beta α (2 + favourable count)
 *     beta:    number,         // Beta β (2 + unfavourable count)
 *     n:       number,         // alpha + beta - 4 (observed count)
 *     tq:      number,         // alpha / (alpha + beta)
 *     lcb:     number,         // 5%-percentile lower bound
 *     tier:    string,         // last derived tier (cached for hysteresis)
 *     ceiling: string|null,    // K14 drift clamp; null = no clamp
 *     lastAt:  number          // ms timestamp of last update
 *   }
 *
 * Pure prior is Beta(2, 2) — peaked at 0.5, lightly informative. Observing
 * one favourable promotes mean to 0.6; observing one unfavourable demotes
 * to 0.4. Twenty observations of one polarity move LCB through the alert
 * → suggest → apply-confirm gates if all signs agree.
 *
 * Idempotency: the trust-driver dedups fireIds via a separate ring
 * (`aesConductor:trustSeen`). This store assumes every record() call is a
 * fresh observation.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorTrustStore) return

    const PREFIX        = "aesConductor:trust:"
    const PRIOR_ALPHA   = 2
    const PRIOR_BETA    = 2
    const Z_5PCT        = 1.6449                  // one-sided 95%
    const TIER_ORDER    = ["alert", "suggest", "apply-confirm", "apply-auto"]
    const LCB_THRESHOLDS = {
        suggest:        0.40,
        "apply-confirm": 0.60,
        "apply-auto":    0.80
    }
    const HYSTERESIS    = 0.05                    // demote only once LCB drops below threshold − 0.05

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    async function _read(key) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return {}
        try {
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return (v && typeof v === "object") ? v : {}
        } catch (_) { return {} }
    }

    async function _write(key, obj) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return
        try { await chrome.storage.local.set({[key]: obj}) } catch (_) { /* noop */ }
    }

    /** Normal-approximation 5% LCB on Beta(α, β). For small (α+β) this is a
     *  conservative under-estimate, which keeps tier promotion safe. */
    function _lcb(alpha, beta) {
        const n = alpha + beta
        const mean = alpha / n
        const variance = (alpha * beta) / (n * n * (n + 1))
        const stderr = Math.sqrt(variance)
        const v = mean - Z_5PCT * stderr
        if (v < 0) return 0
        if (v > 1) return 1
        return v
    }

    function _tierFromLcb(lcb, prevTier) {
        let tier = "alert"
        if (lcb >= LCB_THRESHOLDS.suggest)         tier = "suggest"
        if (lcb >= LCB_THRESHOLDS["apply-confirm"]) tier = "apply-confirm"
        if (lcb >= LCB_THRESHOLDS["apply-auto"])    tier = "apply-auto"
        if (!prevTier || prevTier === tier) return tier
        const prevIdx = TIER_ORDER.indexOf(prevTier)
        const nextIdx = TIER_ORDER.indexOf(tier)
        if (prevIdx < 0 || nextIdx < 0) return tier
        if (nextIdx > prevIdx) return tier                       // promotions are eager
        const upperFloor = LCB_THRESHOLDS[prevTier] - HYSTERESIS
        if (upperFloor != null && lcb >= upperFloor) return prevTier
        return tier
    }

    function _empty() {
        return {
            alpha:   PRIOR_ALPHA,
            beta:    PRIOR_BETA,
            n:       0,
            tq:      0.5,
            lcb:     _lcb(PRIOR_ALPHA, PRIOR_BETA),
            tier:    "alert",
            ceiling: null,
            lastAt:  0
        }
    }

    function _normalize(raw) {
        const e = _empty()
        if (!raw || typeof raw !== "object") return e
        if (typeof raw.alpha === "number" && raw.alpha >= 1)   e.alpha = raw.alpha
        if (typeof raw.beta  === "number" && raw.beta  >= 1)   e.beta  = raw.beta
        e.n = Math.max(0, (e.alpha - PRIOR_ALPHA) + (e.beta - PRIOR_BETA))
        e.tq = e.alpha / (e.alpha + e.beta)
        e.lcb = _lcb(e.alpha, e.beta)
        if (typeof raw.tier === "string" && TIER_ORDER.indexOf(raw.tier) >= 0) e.tier = raw.tier
        if (typeof raw.ceiling === "string" && TIER_ORDER.indexOf(raw.ceiling) >= 0) e.ceiling = raw.ceiling
        if (typeof raw.lastAt === "number") e.lastAt = raw.lastAt
        return e
    }

    async function load(host) {
        const blob = await _read(_key(host))
        const out = {}
        for (const k of Object.keys(blob)) out[k] = _normalize(blob[k])
        return out
    }

    async function get(host, scenarioId) {
        if (!scenarioId) return _empty()
        const blob = await _read(_key(host))
        return _normalize(blob[scenarioId])
    }

    /** Update posterior with one observation. `favourable === null` is a
     *  no-op (the verdict isn't terminal yet). */
    async function record(host, scenarioId, favourable) {
        if (!scenarioId || favourable == null) return null
        const key = _key(host)
        if (!key) return null
        const blob = await _read(key)
        const cur = _normalize(blob[scenarioId])
        if (favourable) cur.alpha += 1
        else            cur.beta  += 1
        cur.n      = (cur.alpha - PRIOR_ALPHA) + (cur.beta - PRIOR_BETA)
        cur.tq     = cur.alpha / (cur.alpha + cur.beta)
        cur.lcb    = _lcb(cur.alpha, cur.beta)
        cur.tier   = _tierFromLcb(cur.lcb, cur.tier)
        cur.lastAt = Date.now()
        blob[scenarioId] = cur
        await _write(key, blob)
        return cur
    }

    /** K14 drift hook — clamp the maximum tier this scenario can be promoted
     *  to. `null` clears the clamp. Idempotent. */
    async function setCeiling(host, scenarioId, ceilingTier) {
        if (!scenarioId) return null
        const key = _key(host)
        if (!key) return null
        const blob = await _read(key)
        const cur = _normalize(blob[scenarioId])
        const next = (ceilingTier && TIER_ORDER.indexOf(ceilingTier) >= 0) ? ceilingTier : null
        if (cur.ceiling === next) return cur                     // no-op
        cur.ceiling = next
        cur.lastAt = Date.now()
        blob[scenarioId] = cur
        await _write(key, blob)
        return cur
    }

    async function reset(host, scenarioId) {
        const key = _key(host)
        if (!key) return
        const blob = await _read(key)
        if (scenarioId) {
            delete blob[scenarioId]
        } else {
            for (const k of Object.keys(blob)) delete blob[k]
        }
        await _write(key, blob)
    }

    /** Pure helper exported for the tier-gate. Resolves a TrustEntry +
     *  scenario.defaultTierCap + global ceiling into a single tier string.
     *  Hysteresis already lives in the cached entry.tier; this only enforces
     *  the user/drift ceilings on top. */
    function clampTier(entry, scenarioCap, globalCap) {
        const candidate = (entry && entry.tier) || "alert"
        const order = TIER_ORDER
        const cands = [candidate, entry && entry.ceiling, scenarioCap, globalCap]
            .filter(t => t && order.indexOf(t) >= 0)
        let idx = order.length - 1
        for (const t of cands) idx = Math.min(idx, order.indexOf(t))
        if (idx < 0) idx = 0
        return order[idx]
    }

    window.AesConductorTrustStore = {
        load, get, record, setCeiling, reset, clampTier,
        TIER_ORDER, LCB_THRESHOLDS, PRIOR_ALPHA, PRIOR_BETA, PREFIX
    }
})()
