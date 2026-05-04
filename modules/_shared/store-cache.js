"use strict"

/**
 * AesStoreCache — L0 in-memory cache for chrome.storage.local reads.
 *
 * Sits below the domain stores (prefix-store, ttl-cache, settings-bridge,
 * etc.) and short-circuits chrome.storage.local.get when the value was
 * read or written recently. Cross-tab safety comes from one global
 * chrome.storage.onChanged listener that updates L0 on remote writes.
 *
 * Storage shape unchanged — this is purely a memory layer.
 *
 * Public API:
 *   AesStoreCache.getMem(fullKey) → {value, at, source} | undefined
 *   AesStoreCache.setMem(fullKey, value, source: "read"|"write"|"echo") → void
 *   AesStoreCache.invalidate(fullKey) → void
 *   AesStoreCache.invalidatePrefix(prefix) → number  // count cleared
 *   AesStoreCache.size() → number
 *   AesStoreCache.stats() → {hits, misses, ratio, entries}
 *   AesStoreCache.recordHit() / recordMiss()        // for cached-store factory
 *   AesStoreCache.flush() → void                    // dev/test only
 *
 * Memory caps:
 *   MAX_ENTRIES (10000) — LRU eviction when exceeded.
 *
 * Echo source: chrome.storage.onChanged fires on the writer tab AND on
 * peer tabs. Peer tabs see source="echo"; the writer tab already has
 * source="write" set by setMem before chrome.storage commits.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStoreCache) return

    const MAX_ENTRIES = 10000

    // Map<fullKey, {value, at, source}>; insertion order = LRU
    const _cache = new Map()
    let _hits = 0
    let _misses = 0

    function getMem(fullKey) {
        if (typeof fullKey !== "string") return undefined
        const rec = _cache.get(fullKey)
        if (!rec) return undefined
        // refresh LRU position
        _cache.delete(fullKey)
        _cache.set(fullKey, rec)
        return rec
    }

    function setMem(fullKey, value, source) {
        if (typeof fullKey !== "string") return
        if (_cache.has(fullKey)) _cache.delete(fullKey)
        _cache.set(fullKey, {value, at: Date.now(), source: source || "write"})
        if (_cache.size > MAX_ENTRIES) {
            // evict oldest (first inserted)
            const oldestKey = _cache.keys().next().value
            if (oldestKey !== undefined) _cache.delete(oldestKey)
        }
    }

    function invalidate(fullKey) {
        if (typeof fullKey !== "string") return
        _cache.delete(fullKey)
    }

    function invalidatePrefix(prefix) {
        if (typeof prefix !== "string" || !prefix) return 0
        let n = 0
        for (const k of _cache.keys()) {
            if (k.indexOf(prefix) === 0) {
                _cache.delete(k)
                n++
            }
        }
        return n
    }

    function size() { return _cache.size }

    function recordHit() { _hits++ }
    function recordMiss() { _misses++ }

    function stats() {
        const total = _hits + _misses
        return {
            hits:    _hits,
            misses:  _misses,
            ratio:   total > 0 ? _hits / total : 0,
            entries: _cache.size
        }
    }

    function flush() {
        _cache.clear()
        _hits = 0
        _misses = 0
    }

    // Echo of the writer's own commit carries the same newValue as the write
    // it just posted; a peer write that races inside the 50ms commit window
    // carries a different newValue and must NOT be suppressed (the previous
    // time-only guard dropped peer writes silently — F-9223-003).
    function _echoEqualsWrite(a, b) {
        if (a === b) return true
        if (a === null || b === null) return false
        if (typeof a !== "object" || typeof b !== "object") return false
        try { return JSON.stringify(a) === JSON.stringify(b) }
        catch (_) { return false }
    }

    // Cross-tab + same-tab onChanged listener — keeps L0 fresh on remote writes.
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
        try {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local" || !changes) return
                for (const k in changes) {
                    const c = changes[k]
                    if (c && "newValue" in c && c.newValue !== undefined) {
                        // Echo from another tab OR our own commit echoing back.
                        // Suppress only the writer's OWN echo: a "write" record
                        // <50ms old whose value matches the newValue. Anything
                        // else (peer write, divergent value) updates L0.
                        const existing = _cache.get(k)
                        if (existing && existing.source === "write"
                                && Date.now() - existing.at < 50
                                && _echoEqualsWrite(existing.value, c.newValue)) {
                            continue
                        }
                        if (_cache.has(k)) _cache.delete(k)
                        _cache.set(k, {value: c.newValue, at: Date.now(), source: "echo"})
                        if (_cache.size > MAX_ENTRIES) {
                            const oldestKey = _cache.keys().next().value
                            if (oldestKey !== undefined) _cache.delete(oldestKey)
                        }
                    } else if (c && c.newValue === undefined) {
                        // Key removed elsewhere — drop L0 entry.
                        _cache.delete(k)
                    }
                }
            })
        } catch (_) { /* noop in non-extension contexts */ }
    }

    // Account-bootstrap purge — pre-bootstrap cache entries used legacy keys;
    // post-bootstrap reads use scoped keys. Clear unscoped routeAssistant /
    // strategy / aircraftFlightPlan / etc. entries on first bootstrap event.
    if (typeof window.AesDataBus !== "undefined" && typeof window.AesDataBus.on === "function") {
        try {
            window.AesDataBus.on("data:account:bootstrapped", function () {
                invalidatePrefix("aesStrategy:")
                invalidatePrefix("routeAssistant:")
                invalidatePrefix("aircraftFleet")
            })
        } catch (_) { /* noop */ }
    }

    window.AesStoreCache = {
        getMem,
        setMem,
        invalidate,
        invalidatePrefix,
        size,
        recordHit,
        recordMiss,
        stats,
        flush,
        MAX_ENTRIES
    }
})()
