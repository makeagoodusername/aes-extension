"use strict"

/**
 * Price-automation diagnostics — per-route record of the most recent
 * skip / proposal / apply event so the user can see *why* a route
 * isn't moving without trawling 50-entry trace caps.
 *
 * Single chrome.storage.local key: `aesPrice:diagnostics`.
 *   { "HUB-DEST": { lastSkipReason, lastSkipAt,
 *                   lastProposedReason, lastProposedAt,
 *                   lastAppliedAt, lastAppliedOk, lastLogId },
 *     ... }
 *
 * Capped at MAX_ROUTES entries; oldest-skip evicted on overflow.
 *
 * Writes are best-effort: every public method swallows errors and
 * returns silently. Callers must NEVER await these from a hot path —
 * fire-and-forget keeps the apply / proposer loops insulated from
 * storage hiccups.
 *
 * Public API (window.AesPriceDiagnostics):
 *   recordSkip({hub, dest, reason})        → Promise<void>
 *   recordProposal({hub, dest, reason?})   → Promise<void>
 *   recordApply({hub, dest, ok, logId?})   → Promise<void>
 *   getAll()                                → Promise<{[pair]: rec}>
 *   getRoute(hub, dest)                     → Promise<rec | null>
 *   clear()                                 → Promise<void>
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesPriceDiagnostics) return

    const KEY        = "aesPrice:diagnostics"
    const MAX_ROUTES = 500

    function _pair(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    async function _load() {
        try {
            const out = await chrome.storage.local.get([KEY])
            const m = out[KEY]
            return (m && typeof m === "object") ? m : {}
        } catch (_) { return {} }
    }

    async function _save(map) {
        try { await chrome.storage.local.set({[KEY]: map}) }
        catch (_) { /* best-effort */ }
    }

    function _evict(map) {
        const keys = Object.keys(map)
        if (keys.length <= MAX_ROUTES) return map
        // Oldest-touched route wins eviction. lastTouchedAt = max of any timestamp.
        const ts = (k) => {
            const r = map[k] || {}
            return Math.max(
                Number(r.lastSkipAt)     || 0,
                Number(r.lastProposedAt) || 0,
                Number(r.lastAppliedAt)  || 0
            )
        }
        keys.sort((a, b) => ts(a) - ts(b))
        for (const k of keys.slice(0, keys.length - MAX_ROUTES)) delete map[k]
        return map
    }

    async function recordSkip(info) {
        if (!info || !info.hub || !info.dest) return
        const k = _pair(info.hub, info.dest)
        const map = await _load()
        const prev = map[k] || {}
        map[k] = Object.assign({}, prev, {
            lastSkipReason: String(info.reason || "unknown").slice(0, 240),
            lastSkipAt:     Date.now()
        })
        await _save(_evict(map))
    }

    async function recordProposal(info) {
        if (!info || !info.hub || !info.dest) return
        const k = _pair(info.hub, info.dest)
        const map = await _load()
        const prev = map[k] || {}
        map[k] = Object.assign({}, prev, {
            lastProposedReason: info.reason ? String(info.reason).slice(0, 240) : null,
            lastProposedAt:     Date.now()
        })
        await _save(_evict(map))
    }

    async function recordApply(info) {
        if (!info || !info.hub || !info.dest) return
        const k = _pair(info.hub, info.dest)
        const map = await _load()
        const prev = map[k] || {}
        const patch = {
            lastAppliedAt: Date.now(),
            lastAppliedOk: !!info.ok
        }
        if (info.logId) patch.lastLogId = String(info.logId).slice(0, 64)
        // A successful apply implicitly resolves the prior skip — clear it
        // so the activity feed stops reporting an outdated reason.
        if (info.ok) {
            patch.lastSkipReason = null
            patch.lastSkipAt     = null
        }
        map[k] = Object.assign({}, prev, patch)
        await _save(_evict(map))
    }

    async function getAll() { return await _load() }

    async function getRoute(hub, dest) {
        const map = await _load()
        return map[_pair(hub, dest)] || null
    }

    async function clear() {
        try { await chrome.storage.local.remove([KEY]) }
        catch (_) { /* best-effort */ }
    }

    window.AesPriceDiagnostics = {
        recordSkip, recordProposal, recordApply,
        getAll, getRoute, clear,
        KEY: KEY,
        MAX_ROUTES: MAX_ROUTES
    }
})()
