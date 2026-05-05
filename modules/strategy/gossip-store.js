"use strict"

/**
 * AES Strategy — Markets Gossip store (Slice 27).
 *
 * Per-(server, airline) ring buffer of GossipEvent records produced by
 * the detectors. Capped + TTL'd so a noisy week can't blow the strategy
 * storage budget.
 *
 * Storage:
 *   aesStrategy:gossip:<server>:<airline>      — ring (cap 200)
 *   aesStrategy:gossipSeen:<server>:<airline>  — Set of acknowledged eventIds (cap 100 LRU)
 *
 * TTL: events older than 30 days are dropped on next append. The seen
 * set prunes to its newest 100 entries.
 *
 * Public API (window.AesStrategyGossipStore):
 *   .append(host, events)             → Promise<number>      // count written
 *   .loadAll(host)                    → Promise<event[]>     (newest first)
 *   .markSeen(host, eventIds)         → Promise<void>
 *   .loadSeen(host)                   → Promise<Set<string>>
 *   .clear(host)                      → Promise<void>
 *   .RING_KEY / .SEEN_KEY                                    // for storage watchers
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyGossipStore) return

    const RING_PREFIX = "aesStrategy:gossip:"
    const SEEN_PREFIX = "aesStrategy:gossipSeen:"
    const RING_CAP    = 200
    const SEEN_CAP    = 100
    const TTL_MS      = 30 * 24 * 3600 * 1000

    function _hostKey(host, prefix) {
        if (!host || !host.server || !host.airline) return null
        return prefix + host.server + ":" + host.airline
    }

    async function loadAll(host) {
        const key = _hostKey(host, RING_PREFIX)
        if (!key) return []
        try {
            const got = await chrome.storage.local.get([key])
            const ring = Array.isArray(got[key]) ? got[key].slice() : []
            const cutoff = Date.now() - TTL_MS
            return ring.filter(e => e && Number(e.ts) >= cutoff)
        } catch (e) {
            console.warn("[AesStrategyGossipStore] loadAll failed", e)
            return []
        }
    }

    async function append(host, events) {
        if (!Array.isArray(events) || !events.length) return 0
        const key = _hostKey(host, RING_PREFIX)
        if (!key) return 0
        try {
            const got = await chrome.storage.local.get([key])
            const cur = Array.isArray(got[key]) ? got[key] : []
            const cutoff = Date.now() - TTL_MS
            const fresh = events.concat(cur).filter(e => e && Number(e.ts) >= cutoff)
            // Newest first; cap at RING_CAP.
            fresh.sort((a, b) => Number(b.ts) - Number(a.ts))
            const trimmed = fresh.slice(0, RING_CAP)
            await chrome.storage.local.set({[key]: trimmed})
            return events.length
        } catch (e) {
            console.warn("[AesStrategyGossipStore] append failed", e)
            return 0
        }
    }

    async function loadSeen(host) {
        const key = _hostKey(host, SEEN_PREFIX)
        if (!key) return new Set()
        try {
            const got = await chrome.storage.local.get([key])
            const list = Array.isArray(got[key]) ? got[key] : []
            return new Set(list)
        } catch (_) { return new Set() }
    }

    async function markSeen(host, eventIds) {
        if (!Array.isArray(eventIds) || !eventIds.length) return
        const key = _hostKey(host, SEEN_PREFIX)
        if (!key) return
        try {
            const got = await chrome.storage.local.get([key])
            const cur = Array.isArray(got[key]) ? got[key] : []
            // Newest at the end of the list; LRU prune from the front.
            const set = new Set(cur)
            for (const id of eventIds) {
                if (id) set.add(String(id))
            }
            const out = Array.from(set)
            const trimmed = out.length > SEEN_CAP ? out.slice(out.length - SEEN_CAP) : out
            await chrome.storage.local.set({[key]: trimmed})
        } catch (e) {
            console.warn("[AesStrategyGossipStore] markSeen failed", e)
        }
    }

    async function clear(host) {
        const ringKey = _hostKey(host, RING_PREFIX)
        const seenKey = _hostKey(host, SEEN_PREFIX)
        const keys = [ringKey, seenKey].filter(Boolean)
        if (!keys.length) return
        try { await chrome.storage.local.remove(keys) } catch (_) {}
    }

    window.AesStrategyGossipStore = {
        append:   append,
        loadAll:  loadAll,
        loadSeen: loadSeen,
        markSeen: markSeen,
        clear:    clear,
        RING_PREFIX: RING_PREFIX,
        SEEN_PREFIX: SEEN_PREFIX,
        RING_CAP:    RING_CAP,
        TTL_MS:      TTL_MS
    }
})()
