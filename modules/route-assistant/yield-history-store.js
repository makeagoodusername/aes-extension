"use strict"

/**
 * Yield-history store for the Route Assistant.
 *
 * Persists per-route snapshots of attributed actual yield, taken from the
 * `<server>aircraftFlights<aircraftId>` records that `content_aircraftFlights.js`
 * writes when the user visits an aircraft's flight-history page. Snapshots are
 * stored at:
 *
 *   routeAssistant:yieldHistory:<HUB>-<DEST>                  (legacy)
 *   routeAssistant:yieldHistory:acct:<id>:<HUB>-<DEST>        (L3+)
 *     → {hub, dest, snapshots: [...], lastSnapshotAt}
 *
 * Pair key is **directional** (matches RouteAssistantSchedulePageScraper).
 * Profit + frequency differ by direction, so HUB→DEST and DEST→HUB get
 * independent history.
 *
 * L3 — Class B refactor: namespaced via `acctKey()`, reads fall back to
 * legacy. Yield-history is a scraper output (depends on which airline is
 * "ours"), so per-account scoping prevents one account's recorded yields
 * from leaking into another account's profit estimates.
 */
class RouteAssistantYieldHistoryStore {
    static LEGACY_PREFIX = "routeAssistant:yieldHistory:"
    static SCOPE_PREFIX  = "routeAssistant:yieldHistory"
    static DEFAULT_HISTORY_LIMIT = 12

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantYieldHistoryStore.SCOPE_PREFIX,
            RouteAssistantYieldHistoryStore._pairKey(hub, dest))
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantYieldHistoryStore.LEGACY_PREFIX
            + RouteAssistantYieldHistoryStore._pairKey(hub, dest)
    }

    static _normaliseLimit(v) {
        const n = Number(v)
        return isFinite(n) && n > 0 ? Math.floor(n) : RouteAssistantYieldHistoryStore.DEFAULT_HISTORY_LIMIT
    }

    static _prune(snapshots, limit) {
        if (!Array.isArray(snapshots) || !snapshots.length) return []
        const sorted = snapshots.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        const lim = RouteAssistantYieldHistoryStore._normaliseLimit(limit)
        return sorted.length > lim ? sorted.slice(sorted.length - lim) : sorted
    }

    static async loadRecord(hub, dest) {
        const ns = RouteAssistantYieldHistoryStore._key(hub, dest)
        const lg = RouteAssistantYieldHistoryStore._legacyKey(hub, dest)
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            return out[ns] || null
        }
        const out = await chrome.storage.local.get([ns, lg])
        if (out[ns] !== undefined) return out[ns]
        return out[lg] || null
    }

    /**
     * Bulk-load history records for a list of {hub, dest} pairs (or
     * [hub, dest] tuples). Returns Map<pairKey, record>. Optional `maxAgeDays`
     * drops records whose latest snapshot is older than the threshold so the
     * panel can avoid surfacing very stale numbers without a snapshot.
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const maxAgeDays = (opts && Number(opts.maxAgeDays) > 0) ? Number(opts.maxAgeDays) : null
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantYieldHistoryStore._pairKey(a, b))
            nsKeys.push(RouteAssistantYieldHistoryStore._key(a, b))
            lgKeys.push(RouteAssistantYieldHistoryStore._legacyKey(a, b))
        }
        const all = []
        for (const k of nsKeys) all.push(k)
        for (const k of lgKeys) if (all.indexOf(k) < 0) all.push(k)
        const out = await chrome.storage.local.get(all)
        const map = new Map()
        const now = Date.now()
        for (let i = 0; i < pairs.length; i++) {
            const ns = nsKeys[i]
            const lg = lgKeys[i]
            const rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
            if (!rec || !Array.isArray(rec.snapshots) || !rec.snapshots.length) continue
            if (maxAgeDays) {
                const last = rec.lastSnapshotAt || rec.snapshots[rec.snapshots.length - 1].timestamp
                if (typeof last === "number" && (now - last) > maxAgeDays * 86400000) continue
            }
            map.set(pairKeys[i], rec)
        }
        return map
    }

    /**
     * Append snapshots to multiple route records in a single storage write.
     * Reads via legacy fallback so a pre-L3 history seeds the namespaced
     * record on the next snapshot append.
     *
     * @param {Array<{hub, dest, snapshot}>} entries
     * @param {object} [opts]
     * @param {number} [opts.historyLimit] keep the most-recent N snapshots per route
     * @returns {Promise<Map<pairKey, record>>}
     */
    static async appendSnapshots(entries, opts) {
        if (!entries || !entries.length) return new Map()
        const limit = RouteAssistantYieldHistoryStore._normaliseLimit(opts && opts.historyLimit)
        const nsKeys = []
        const lgKeys = []
        for (const e of entries) {
            nsKeys.push(RouteAssistantYieldHistoryStore._key(e.hub, e.dest))
            lgKeys.push(RouteAssistantYieldHistoryStore._legacyKey(e.hub, e.dest))
        }
        const all = []
        for (const k of nsKeys) all.push(k)
        for (const k of lgKeys) if (all.indexOf(k) < 0) all.push(k)
        const existing = await chrome.storage.local.get(all)
        const writes = {}
        const updated = new Map()

        for (let i = 0; i < entries.length; i++) {
            const e = entries[i]
            const pair = RouteAssistantYieldHistoryStore._pairKey(e.hub, e.dest)
            const ns   = nsKeys[i]
            const lg   = lgKeys[i]
            const prev = existing[ns] !== undefined ? existing[ns] : (existing[lg] || null)
            const snapshots = prev && Array.isArray(prev.snapshots) ? prev.snapshots.slice() : []
            if (e.snapshot) snapshots.push(e.snapshot)
            const pruned = RouteAssistantYieldHistoryStore._prune(snapshots, limit)
            const rec = {
                hub:            String(e.hub || "").toUpperCase(),
                dest:           String(e.dest || "").toUpperCase(),
                snapshots:      pruned,
                lastSnapshotAt: pruned.length ? pruned[pruned.length - 1].timestamp : null
            }
            writes[ns] = rec
            updated.set(pair, rec)
        }
        await chrome.storage.local.set(writes)
        return updated
    }

    /**
     * Convenience accessor — newest snapshot for a record (or null when empty).
     */
    static latestSnapshot(record) {
        if (!record || !Array.isArray(record.snapshots) || !record.snapshots.length) return null
        return record.snapshots[record.snapshots.length - 1]
    }

    /**
     * Drop a single route's history. Used by the override editor's
     * "Reset history" button so a calibration round can start clean.
     * Removes both namespaced AND legacy keys — explicit user intent.
     */
    static async deleteRoute(hub, dest) {
        const ns = RouteAssistantYieldHistoryStore._key(hub, dest)
        const lg = RouteAssistantYieldHistoryStore._legacyKey(hub, dest)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
    }

    /** L3 deprecated — preserve for any reader still doing key arithmetic. */
    static get CACHE_PREFIX() { return RouteAssistantYieldHistoryStore.LEGACY_PREFIX }
}

if (typeof window !== "undefined") {
    window.RouteAssistantYieldHistoryStore = RouteAssistantYieldHistoryStore
}
