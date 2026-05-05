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
 *
 * Concurrency (H-004): chrome.storage.local read-modify-write is racy when
 * two appends fire in the same tick (signal-layer can emit several signals
 * back-to-back from one onChanged delivery). All mutations funnel through
 * a per-key tail-Promise queue so each read-modify-write completes before
 * the next one starts. Pure reads (recent, byType) bypass the queue.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorSignalStore) return

    const PREFIX = "aesConductor:signals:"
    const CAP    = 500

    /** key → Promise tail. Each enqueue chains onto the previous tail so
     *  read-modify-writes for the same key serialize. Cross-key writes still
     *  parallelise. */
    const _queues = new Map()

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    /** Serialize `task` against any in-flight mutation for `key`. Returns the
     *  task's resolved value. The queue self-prunes when the tail settles
     *  with no further enqueues, so idle keys don't leak Promises. */
    function _enqueue(key, task) {
        const prev = _queues.get(key) || Promise.resolve()
        const next = prev.then(task, task)
        _queues.set(key, next)
        // Prune when this tail is the current one and has settled.
        next.catch(() => {}).then(() => {
            if (_queues.get(key) === next) _queues.delete(key)
        })
        return next
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
        return _enqueue(key, async () => {
            const arr = await _read(key)
            arr.push(signal)
            if (arr.length > CAP) arr.splice(0, arr.length - CAP)
            try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
        })
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
        return _enqueue(key, async () => {
            try { await chrome.storage.local.set({[key]: []}) } catch (_) { /* noop */ }
        })
    }

    window.AesConductorSignalStore = {append, recent, byType, clear, PREFIX, CAP}
})()
