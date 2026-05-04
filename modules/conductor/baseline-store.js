"use strict"

/**
 * AesConductorBaselineStore — K13 per-metric per-scope EWMA baseline + variance.
 *
 * Storage:
 *   aesConductor:baselines:<server>:<airline>
 *     → { "<metric>:<scope>:<scopeId>": {n, mean, var, lastAt} }
 *
 * Pure-function EWMA primitives; reads/writes scoped by host like every other
 * conductor store (HANDOVER §10 — storage key prefix is contract).
 *
 * Update rule (Welford-flavoured EWMA with shrinkage prior):
 *   alpha = 2 / (N + 1), default N = 20
 *   prior n0 = 4 (effective sample weight before any real samples)
 *   On first sample:  mean = value, var = 0, n = 1
 *   On subsequent:    delta = value - mean
 *                     mean += alpha * delta
 *                     var  = (1 - alpha) * (var + alpha * delta * delta)
 *                     n   += 1
 *
 * The `n0` prior keeps zScore() conservative until we've seen ≥4 samples.
 * Scenarios consume baselines via `ctx.baselines` injected by scenario-engine;
 * fall back to shipped DEFAULT_* constants when a baseline is absent.
 *
 * Bus topics (registered via Agent-6 bus-topic-requests):
 *   data:conductor:baseline:updated   — debounced 5s after writes
 *   signal:conductor:baseline:tick    — 24h chrome.alarms roll-up
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorBaselineStore) return

    const PREFIX     = "aesConductor:baselines:"
    const DEFAULT_N  = 20
    const PRIOR_N0   = 4
    const ALPHA      = 2 / (DEFAULT_N + 1)
    const KEY_CAP    = 800                // hard cap to prevent runaway growth

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    function _composite(metric, scope, scopeId) {
        return String(metric) + ":" + String(scope || "global") + ":" + String(scopeId || "")
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
        try { await chrome.storage.local.set({[key]: obj}) } catch (_) { /* noop */ }
    }

    /** Pure update — returns next entry. Exported for tests + drivers. */
    function step(prev, value) {
        if (typeof value !== "number" || !isFinite(value)) return prev || null
        if (!prev || typeof prev.n !== "number" || prev.n < 1) {
            return {n: 1, mean: value, var: 0, lastAt: Date.now()}
        }
        const delta = value - prev.mean
        const mean  = prev.mean + ALPHA * delta
        const v     = (1 - ALPHA) * ((prev.var || 0) + ALPHA * delta * delta)
        return {n: prev.n + 1, mean, var: v, lastAt: Date.now()}
    }

    /** Pure z-score — returns null when entry unset or too few samples. */
    function zOf(entry, value) {
        if (!entry || typeof value !== "number" || !isFinite(value)) return null
        if (entry.n < PRIOR_N0) return null
        const sd = Math.sqrt(Math.max(entry.var || 0, 1e-9))
        if (sd === 0) return null
        return (value - entry.mean) / sd
    }

    let _cache = null
    let _cacheKey = null

    async function loadCached(host) {
        const k = _key(host)
        if (!k) return {}
        if (_cacheKey === k && _cache) return _cache
        const blob = await _read(k)
        _cache = blob
        _cacheKey = k
        return blob
    }

    function get(blob, metric, scope, scopeId) {
        if (!blob) return null
        return blob[_composite(metric, scope, scopeId)] || null
    }

    let _writeTimer = null
    function _scheduleEmit(envelope) {
        if (_writeTimer) clearTimeout(_writeTimer)
        _writeTimer = setTimeout(() => {
            _writeTimer = null
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                    window.CentralHubBus.emit("data:conductor:baseline:updated", envelope)
                }
            } catch (_) { /* noop */ }
        }, 5000)
    }

    async function update(host, metric, scope, scopeId, value) {
        if (typeof value !== "number" || !isFinite(value)) return null
        const k = _key(host)
        if (!k) return null
        const blob = await _read(k)
        const composite = _composite(metric, scope, scopeId)
        const next = step(blob[composite], value)
        if (!next) return null
        blob[composite] = next
        const keys = Object.keys(blob)
        if (keys.length > KEY_CAP) {
            keys.sort((a, b) => (blob[a].lastAt || 0) - (blob[b].lastAt || 0))
            const drop = keys.length - KEY_CAP
            for (let i = 0; i < drop; i++) delete blob[keys[i]]
        }
        await _write(k, blob)
        _cache = blob
        _cacheKey = k
        _scheduleEmit({metric, scope, scopeId, n: next.n, mean: next.mean})
        return next
    }

    async function summary(host) {
        const blob = await _read(_key(host))
        const out = {count: 0, byMetric: {}}
        for (const k of Object.keys(blob)) {
            out.count += 1
            const colon = k.indexOf(":")
            const m = colon > 0 ? k.slice(0, colon) : k
            out.byMetric[m] = (out.byMetric[m] || 0) + 1
        }
        return out
    }

    async function clear(host) {
        const k = _key(host)
        if (!k) return
        try { await chrome.storage.local.remove([k]) } catch (_) { /* noop */ }
        _cache = null
        _cacheKey = null
    }

    window.AesConductorBaselineStore = {
        loadCached, update, get, summary, clear,
        step, zOf,
        PREFIX, ALPHA, PRIOR_N0
    }
})()
