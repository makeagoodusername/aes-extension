"use strict"

/**
 * AES Slots — available-slot store (Slice 20).
 *
 * TTL-capped ring of slot opportunity records keyed by server. Records
 * are written by the scraper on a successful page parse and read by the
 * tuner / tile / bidder. Stale entries (> 7 days) are evicted on read.
 *
 * Storage keys:
 *   aesStrategy:slots:available:<server>   ← per-server ring (cap 200, 7d TTL)
 *   aesStrategy:slots:bids                 ← bid history (cap 500)
 *
 * Public API (window.AesSlotStore):
 *   loadAvailable(server)            → Promise<SlotRecord[]>
 *   saveAvailable(server, records)   → Promise<SlotRecord[]>
 *   recordBid(bid)                   → Promise<BidRecord>
 *   loadBids({server?, limit?})      → Promise<BidRecord[]>
 *
 * SlotRecord:
 *   {iata, slotId, runwayClass, weeklyOps, expiresAt?, observedAt,
 *    minBid?, currentBid?, source}
 */
;(function () {
    if (window.AesSlotStore) return

    const TTL_MS    = 7 * 24 * 60 * 60 * 1000
    const CAP_AVAIL = 200
    const CAP_BIDS  = 500
    const KEY_BIDS  = "aesStrategy:slots:bids"

    function _availKey(server) { return "aesStrategy:slots:available:" + String(server || "_") }

    async function loadAvailable(server) {
        if (!server) return []
        try {
            const got = await chrome.storage.local.get([_availKey(server)])
            const list = got[_availKey(server)] || []
            const now = Date.now()
            return list.filter(r => r && (now - (r.observedAt || 0)) < TTL_MS)
        } catch (_) { return [] }
    }

    async function saveAvailable(server, records) {
        if (!server) return []
        const arr = Array.isArray(records) ? records.slice(0, CAP_AVAIL) : []
        const now = Date.now()
        for (const r of arr) {
            if (!r) continue
            if (!r.observedAt) r.observedAt = now
            if (!r.source)     r.source     = "scraper"
        }
        try {
            await chrome.storage.local.set({[_availKey(server)]: arr})
            _emit("data:slots:available:updated", {server, count: arr.length})
        } catch (e) { console.warn("[AesSlotStore] saveAvailable failed", e) }
        return arr
    }

    async function recordBid(bid) {
        if (!bid) return null
        const stamped = Object.assign(
            {ts: Date.now(), status: "queued", source: "AesSlotBidder"},
            bid
        )
        try {
            const got = await chrome.storage.local.get([KEY_BIDS])
            const list = got[KEY_BIDS] || []
            list.unshift(stamped)
            const trimmed = list.slice(0, CAP_BIDS)
            await chrome.storage.local.set({[KEY_BIDS]: trimmed})
            _emit("data:slots:bid:queued", {iata: bid.iata, server: bid.server})
        } catch (e) { console.warn("[AesSlotStore] recordBid failed", e) }
        return stamped
    }

    async function loadBids(opts) {
        opts = opts || {}
        try {
            const got = await chrome.storage.local.get([KEY_BIDS])
            let list = got[KEY_BIDS] || []
            if (opts.server) list = list.filter(b => b && b.server === opts.server)
            if (opts.limit)  list = list.slice(0, opts.limit)
            return list
        } catch (_) { return [] }
    }

    function _emit(name, payload) {
        try { if (window.AesDataBus && window.AesDataBus.emit) window.AesDataBus.emit(name, payload || {}) } catch (_) {}
    }

    window.AesSlotStore = {loadAvailable, saveAvailable, recordBid, loadBids, TTL_MS, CAP_AVAIL, CAP_BIDS}
})()
