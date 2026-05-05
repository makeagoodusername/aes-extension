"use strict"

/**
 * AesConductorThresholdStore — K14 user-overlay for scenario thresholds.
 *
 * Sparse per-(account, scenarioId, key) override map. Read by `scenarios.js`
 * via `resolveThreshold(scenarioId, key, baseDefault)` so the same scenario
 * code path serves both the shipped defaults and any user/drift-applied
 * overlays.
 *
 * Storage:
 *   aesConductor:thresholds:<server>:<airline>
 *     → { "<scenarioId>.<key>": {value: number, source: "user"|"drift", at: number, before: number} }
 *
 * Mirrors the L5 DNA template/override pattern: empty key removes the
 * overlay, never writes a tombstone.
 *
 * Two-gate model (set by drift-driver based on settings):
 *   `apply()` writes the overlay only when `enabled=true`. If `dryRun=true`
 *   the call still emits `data:conductor:threshold:applied` with
 *   `source:"dry-run"` so the user sees the preview but no live behavior
 *   change occurs. §4.18 — defaults at the call-site level make this safe.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorThresholdStore) return

    const PREFIX = "aesConductor:thresholds:"

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    function _composite(scenarioId, key) {
        return String(scenarioId) + "." + String(key)
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

    async function load(host) {
        return await _read(_key(host))
    }

    /** Read a single overlay value, returning the baseDefault if no override
     *  is present. Synchronous-friendly via a cached blob read every call —
     *  scenarios call this from match() / evaluate() which run on hot paths,
     *  but reads from chrome.storage.local are <1ms in practice. For the
     *  tighter inner loop (signal layer) we expose `loadCached(host)` that
     *  scenarios.js can call once per tick and pass into a closure. */
    async function resolve(host, scenarioId, key, baseDefault) {
        if (!scenarioId || !key) return baseDefault
        const blob = await _read(_key(host))
        const e = blob[_composite(scenarioId, key)]
        if (!e || typeof e.value !== "number" || !isFinite(e.value)) return baseDefault
        return e.value
    }

    /** Apply (or dry-run) an overlay. Idempotent on identical {value,source}.
     *  Returns the envelope of what happened so the caller can emit. */
    async function apply(host, scenarioId, key, value, opts) {
        opts = opts || {}
        const enabled = !!opts.enabled
        const dryRun  = !!opts.dryRun
        const source  = opts.source || "user"
        const composite = _composite(scenarioId, key)
        const storeKey = _key(host)
        const blob = await _read(storeKey)
        const before = blob[composite] && typeof blob[composite].value === "number" ? blob[composite].value : null
        const envelope = {
            scenarioId, key, before, after: value,
            source: dryRun ? "dry-run" : source,
            applied: !dryRun && enabled
        }
        if (!enabled || dryRun) {
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                    window.CentralHubBus.emit("data:conductor:threshold:applied", envelope)
                }
            } catch (_) { /* noop */ }
            return envelope
        }
        if (typeof value !== "number" || !isFinite(value)) return envelope
        blob[composite] = {value, source, at: Date.now(), before}
        await _write(storeKey, blob)
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("data:conductor:threshold:applied", envelope)
            }
        } catch (_) { /* noop */ }
        return envelope
    }

    async function clear(host, scenarioId, key) {
        const storeKey = _key(host)
        if (!storeKey) return
        const blob = await _read(storeKey)
        if (scenarioId && key) {
            delete blob[_composite(scenarioId, key)]
        } else if (scenarioId) {
            const prefix = String(scenarioId) + "."
            for (const k of Object.keys(blob)) {
                if (k.indexOf(prefix) === 0) delete blob[k]
            }
        } else {
            for (const k of Object.keys(blob)) delete blob[k]
        }
        await _write(storeKey, blob)
    }

    window.AesConductorThresholdStore = {load, resolve, apply, clear, PREFIX}
})()
