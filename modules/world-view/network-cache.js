"use strict"

/**
 * WorldViewNetworkCache — TTL-bounded cache for the derived per-hub
 * WorldViewNetwork object.
 *
 * Key: worldView:network:<server>:<airline>:<hub>
 * Index: worldView:network:index:<server>:<airline>  (LRU hub list)
 *
 * Cap 10 hubs per (server, airline). On put, evicts the oldest hub key
 * if the cap is exceeded. TTL default 1h; reads with stale entries
 * return null so the caller rebuilds.
 *
 * Stores the derived shape only — NOT raw snapshot — so storage stays
 * bounded (~3 KB/hub × 10 hubs × N servers).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewNetworkCache) return

    const KEY_PREFIX = "worldView:network"
    const INDEX_PREFIX = "worldView:network:index"
    const DEFAULT_TTL_MS = 60 * 60 * 1000      // 1h
    const CAP = 10

    function _key(server, airline, hub) {
        return [KEY_PREFIX, _norm(server), _norm(airline), _norm(hub)].join(":")
    }
    function _indexKey(server, airline) {
        return [INDEX_PREFIX, _norm(server), _norm(airline)].join(":")
    }
    function _norm(s) {
        return (s || "_").toString().trim().toLowerCase()
    }

    async function _readIndex(server, airline) {
        const k = _indexKey(server, airline)
        const out = await chrome.storage.local.get([k])
        const v = out[k]
        return Array.isArray(v) ? v.slice() : []
    }

    async function _writeIndex(server, airline, list) {
        const k = _indexKey(server, airline)
        await chrome.storage.local.set({[k]: list})
    }

    const WorldViewNetworkCache = {
        async get(server, airline, hub, opts) {
            const k = _key(server, airline, hub)
            const out = await chrome.storage.local.get([k])
            const rec = out[k]
            if (!rec || typeof rec !== "object") return null
            const ttl = (opts && Number(opts.ttlMs)) || DEFAULT_TTL_MS
            const expiresAt = Number(rec.expiresAt) || 0
            if (expiresAt && Date.now() > expiresAt) return null
            // Tolerate older shape without expiresAt by checking ts.
            if (!expiresAt) {
                const ts = Number(rec.ts) || 0
                if (Date.now() - ts > ttl) return null
            }
            return rec.network || null
        },

        async put(server, airline, hub, network, opts) {
            const ttl = (opts && Number(opts.ttlMs)) || DEFAULT_TTL_MS
            const k = _key(server, airline, hub)
            const rec = {
                network: network,
                ts: Date.now(),
                expiresAt: Date.now() + ttl
            }
            await chrome.storage.local.set({[k]: rec})

            // LRU index update: move hub to front, evict beyond CAP.
            const norm = _norm(hub)
            let list = await _readIndex(server, airline)
            list = list.filter(h => h !== norm)
            list.unshift(norm)
            const evicted = list.splice(CAP)
            await _writeIndex(server, airline, list)
            for (const h of evicted) {
                try { await chrome.storage.local.remove(_key(server, airline, h)) }
                catch (_) {}
            }
            return network
        },

        async invalidate(server, airline, hub) {
            const k = _key(server, airline, hub)
            try { await chrome.storage.local.remove(k) } catch (_) {}
            const norm = _norm(hub)
            const list = await _readIndex(server, airline)
            const next = list.filter(h => h !== norm)
            if (next.length !== list.length) await _writeIndex(server, airline, next)
        },

        async invalidateAll(server, airline) {
            const list = await _readIndex(server, airline)
            for (const h of list) {
                try { await chrome.storage.local.remove(_key(server, airline, h)) }
                catch (_) {}
            }
            await _writeIndex(server, airline, [])
        },

        keyFor(server, airline, hub) { return _key(server, airline, hub) },
        prefix() { return KEY_PREFIX },
        TTL_MS: DEFAULT_TTL_MS,
        CAP: CAP
    }

    window.WorldViewNetworkCache = WorldViewNetworkCache
})()
