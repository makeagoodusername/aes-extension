"use strict"

/**
 * AesConductorLockStore — K4 reservation locks.
 *
 * A storage-backed lock table keyed per-(server, airline) by
 * "<resourceType>:<resourceId>". A lock is held by `owner` (a routine def
 * id today; a scenario id later when K17 conflict resolution lands) and
 * expires after `ttlMs` (default 600 000 ms = 10 min) so a worker reboot
 * doesn't strand resources.
 *
 * Storage:
 *   aesConductor:locks:<server>:<airline>
 *     → { "<resType>:<resId>": {owner, acquiredAt, ttlMs, reason} }
 *
 * Bus topics (registered in modules/_shared/data-bus-topics.js):
 *   data:conductor:lock:acquired   {resourceType, resourceId, owner, ttlMs}
 *   data:conductor:lock:released   {resourceType, resourceId, owner, reason}
 *
 * Pruning is lazy — every `peek` and `acquire` call sweeps expired entries
 * before reading. No background sweeper; if no one ever calls again, the
 * dead entries cost <1 KB per host per the storage envelope.
 *
 * Concurrency: the same tail-Promise queue pattern as scenario-store keeps
 * concurrent acquire/release calls deterministic within a page context.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorLockStore) return

    const PREFIX        = "aesConductor:locks:"
    const DEFAULT_TTL   = 10 * 60 * 1000

    let _writeChain = Promise.resolve()
    function _enqueue(fn) {
        const next = _writeChain.then(fn).catch(e => {
            try { console.error("[lock-store] write failed", e) } catch (_) {}
        })
        _writeChain = next
        return next
    }

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    function _composite(resType, resId) {
        return String(resType || "") + ":" + String(resId == null ? "" : resId)
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

    function _isExpired(entry, now) {
        if (!entry || typeof entry !== "object") return true
        const acq = (typeof entry.acquiredAt === "number") ? entry.acquiredAt : 0
        const ttl = (typeof entry.ttlMs === "number" && entry.ttlMs > 0) ? entry.ttlMs : DEFAULT_TTL
        return (now - acq) > ttl
    }

    /** Sweep + return a clean blob; emits release events for expired entries. */
    function _pruneInPlace(blob, host, now) {
        const expired = []
        for (const k of Object.keys(blob)) {
            if (_isExpired(blob[k], now)) {
                expired.push({key: k, entry: blob[k]})
                delete blob[k]
            }
        }
        if (expired.length && window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
            for (const e of expired) {
                try {
                    const colon = e.key.indexOf(":")
                    const resType = colon > 0 ? e.key.slice(0, colon) : ""
                    const resId   = colon > 0 ? e.key.slice(colon + 1) : ""
                    window.CentralHubBus.emit("data:conductor:lock:released", {
                        resourceType: resType,
                        resourceId:   resId,
                        owner:        (e.entry && e.entry.owner) || null,
                        reason:       "ttl",
                        server:       host && host.server,
                        airline:      (host && host.airline) || ""
                    })
                } catch (_) { /* noop */ }
            }
        }
        return blob
    }

    let _cache = null
    let _cacheKey = null

    /** Read-only snapshot for renderers (sync after first await). Prunes
     *  expired entries before returning so consumers see truth. */
    async function loadCached(host) {
        const k = _key(host)
        if (!k) return {}
        const blob = await _read(k)
        const pruned = _pruneInPlace(blob, host, Date.now())
        if (Object.keys(pruned).length !== Object.keys(blob).length) {
            await _write(k, pruned)
        }
        _cache = pruned
        _cacheKey = k
        return pruned
    }

    /** Returns the live entry (or null) for a resource. Does not write. */
    async function peek(host, resType, resId) {
        const k = _key(host)
        if (!k) return null
        const blob = await _read(k)
        const composite = _composite(resType, resId)
        const e = blob[composite]
        if (!e) return null
        if (_isExpired(e, Date.now())) {
            // Lazy prune one entry on read to avoid a second roundtrip.
            return _enqueue(async () => {
                const fresh = await _read(k)
                if (fresh[composite] && _isExpired(fresh[composite], Date.now())) {
                    delete fresh[composite]
                    await _write(k, fresh)
                    try {
                        if (window.CentralHubBus) {
                            window.CentralHubBus.emit("data:conductor:lock:released", {
                                resourceType: resType, resourceId: resId,
                                owner: e.owner || null, reason: "ttl",
                                server: host.server, airline: host.airline || ""
                            })
                        }
                    } catch (_) { /* noop */ }
                }
                return null
            })
        }
        return e
    }

    /** Try to acquire the lock. Returns true on success, false when held by
     *  someone else. Reacquiring as the same owner refreshes acquiredAt. */
    async function acquire(host, resType, resId, owner, opts) {
        const k = _key(host)
        if (!k || !owner) return false
        const ttlMs = (opts && typeof opts.ttlMs === "number" && opts.ttlMs > 0) ? opts.ttlMs : DEFAULT_TTL
        const reason = (opts && typeof opts.reason === "string") ? opts.reason : ""
        return _enqueue(async () => {
            const blob = await _read(k)
            const now = Date.now()
            _pruneInPlace(blob, host, now)
            const composite = _composite(resType, resId)
            const e = blob[composite]
            if (e && e.owner !== owner) return false
            const next = {
                owner:      String(owner),
                acquiredAt: now,
                ttlMs:      ttlMs,
                reason:     reason
            }
            blob[composite] = next
            await _write(k, blob)
            _cache = blob
            _cacheKey = k
            try {
                if (window.CentralHubBus) {
                    window.CentralHubBus.emit("data:conductor:lock:acquired", {
                        resourceType: resType, resourceId: resId,
                        owner: next.owner, ttlMs: ttlMs,
                        server: host.server, airline: host.airline || ""
                    })
                }
            } catch (_) { /* noop */ }
            return true
        })
    }

    /** Release iff currently held by `owner`. Idempotent; emits the
     *  release event with `reason: "owner"` (or the caller's override). */
    async function release(host, resType, resId, owner, opts) {
        const k = _key(host)
        if (!k) return false
        const reason = (opts && typeof opts.reason === "string") ? opts.reason : "owner"
        return _enqueue(async () => {
            const blob = await _read(k)
            const composite = _composite(resType, resId)
            const e = blob[composite]
            if (!e) return false
            if (owner && e.owner !== owner) return false
            delete blob[composite]
            await _write(k, blob)
            _cache = blob
            _cacheKey = k
            try {
                if (window.CentralHubBus) {
                    window.CentralHubBus.emit("data:conductor:lock:released", {
                        resourceType: resType, resourceId: resId,
                        owner: e.owner || null, reason: reason,
                        server: host.server, airline: host.airline || ""
                    })
                }
            } catch (_) { /* noop */ }
            return true
        })
    }

    /** Force-prune. Useful as a manual reset from DevTools. */
    async function prune(host) {
        const k = _key(host)
        if (!k) return 0
        return _enqueue(async () => {
            const blob = await _read(k)
            const before = Object.keys(blob).length
            _pruneInPlace(blob, host, Date.now())
            await _write(k, blob)
            _cache = blob
            _cacheKey = k
            return before - Object.keys(blob).length
        })
    }

    async function clear(host) {
        const k = _key(host)
        if (!k) return
        return _enqueue(async () => {
            try { await chrome.storage.local.remove([k]) } catch (_) { /* noop */ }
            _cache = null
            _cacheKey = null
        })
    }

    window.AesConductorLockStore = {
        loadCached, peek, acquire, release, prune, clear,
        PREFIX, DEFAULT_TTL
    }
})()
