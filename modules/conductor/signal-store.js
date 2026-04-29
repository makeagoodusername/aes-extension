"use strict"

/**
 * AesConductorSignalStore — storage-backed ring buffer for typed signals
 * derived by the signal layer (Conductor K1).
 *
 * Storage:
 *   aesConductor:signals:<server>:<airline>  → Signal[] (oldest-first, capped 500)
 *
 * Cap chosen so a busy hour (~50 signals from per-aircraft scrapes + tile
 * refreshes) leaves headroom over a typical session. K10 will join outcomes
 * onto fires and may bump the cap; the Conductor namespace is budgeted
 * 1 MB total (CONDUCTOR-ROADMAP §V).
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorSignalStore) return

    const PREFIX = "aesConductor:signals:"
    const CAP    = 500

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    async function _read(key) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return []
        try {
            const blob = await chrome.storage.local.get([key])
            const arr = blob && blob[key]
            return Array.isArray(arr) ? arr : []
        } catch (_) { return [] }
    }

    async function append(host, signal) {
        const key = _key(host)
        if (!key || !signal) return
        const arr = await _read(key)
        arr.push(signal)
        if (arr.length > CAP) arr.splice(0, arr.length - CAP)
        try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
    }

    async function recent(host, n) {
        const arr = await _read(_key(host))
        const cap = isFinite(n) && n > 0 ? Math.min(n, arr.length) : arr.length
        return arr.slice(arr.length - cap).reverse()
    }

    async function byType(host, type, n) {
        const arr = await _read(_key(host))
        const out = []
        for (let i = arr.length - 1; i >= 0 && out.length < (n || 60); i--) {
            if (arr[i] && arr[i].type === type) out.push(arr[i])
        }
        return out
    }

    async function clear(host) {
        const key = _key(host)
        if (!key) return
        try { await chrome.storage.local.set({[key]: []}) } catch (_) { /* noop */ }
    }

    window.AesConductorSignalStore = {append, recent, byType, clear, PREFIX, CAP}
})()
