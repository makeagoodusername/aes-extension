"use strict"

/**
 * Yield-history store for the Route Assistant.
 *
 * Persists per-route snapshots of attributed actual yield, taken from the
 * `<server>aircraftFlights<aircraftId>` records that `content_aircraftFlights.js`
 * writes when the user visits an aircraft's flight-history page. Snapshots are
 * stored at:
 *
 *   routeAssistant:yieldHistory:<HUB>-<DEST>
 *     → {hub, dest, snapshots: [...], lastSnapshotAt}
 *
 * Pair key is **directional** (matches RouteAssistantSchedulePageScraper).
 * Profit + frequency differ by direction, so HUB→DEST and DEST→HUB get
 * independent history.
 *
 * Snapshot shape:
 *   {
 *     timestamp,                  // unix-ms when the snapshot ran
 *     profitPerFlight,            // attributed AS$/flt for this route
 *     profitPerWeek,              // = profitPerFlight × frequency
 *     frequency,                  // weekly flights summed across contributing tails
 *     aircraftTypeNames,          // unique type names contributing
 *     aircraftRegistrations,      // unique tails contributing
 *     contributingTails,          // count of tails that fed into this snapshot
 *     totalKnownTails,            // tails we *know* fly the route (from ticket-price cache)
 *     attributionMode             // "frequency" | "distance" | "equal"
 *   }
 *
 * Snapshots are stored newest-last; `_prune` keeps the most-recent N (12 by
 * default) so storage doesn't grow unboundedly.
 */
class RouteAssistantYieldHistoryStore {
    static CACHE_PREFIX = "routeAssistant:yieldHistory:"
    static DEFAULT_HISTORY_LIMIT = 12

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
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
        const key = RouteAssistantYieldHistoryStore.CACHE_PREFIX
            + RouteAssistantYieldHistoryStore._pairKey(hub, dest)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
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
        const keys = pairs.map(p => {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            return RouteAssistantYieldHistoryStore.CACHE_PREFIX
                + RouteAssistantYieldHistoryStore._pairKey(a, b)
        })
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        const now = Date.now()
        for (const k in out) {
            const rec = out[k]
            if (!rec || !Array.isArray(rec.snapshots) || !rec.snapshots.length) continue
            if (maxAgeDays) {
                const last = rec.lastSnapshotAt || rec.snapshots[rec.snapshots.length - 1].timestamp
                if (typeof last === "number" && (now - last) > maxAgeDays * 86400000) continue
            }
            const pair = k.substring(RouteAssistantYieldHistoryStore.CACHE_PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Append snapshots to multiple route records in a single storage write.
     *
     * @param {Array<{hub, dest, snapshot}>} entries
     * @param {object} [opts]
     * @param {number} [opts.historyLimit] keep the most-recent N snapshots per route
     * @returns {Promise<Map<pairKey, record>>}
     */
    static async appendSnapshots(entries, opts) {
        if (!entries || !entries.length) return new Map()
        const limit = RouteAssistantYieldHistoryStore._normaliseLimit(opts && opts.historyLimit)
        const keys = entries.map(e => RouteAssistantYieldHistoryStore.CACHE_PREFIX
            + RouteAssistantYieldHistoryStore._pairKey(e.hub, e.dest))
        const existing = await chrome.storage.local.get(keys)
        const writes = {}
        const updated = new Map()

        for (const e of entries) {
            const pair = RouteAssistantYieldHistoryStore._pairKey(e.hub, e.dest)
            const key  = RouteAssistantYieldHistoryStore.CACHE_PREFIX + pair
            const prev = existing[key] || null
            const snapshots = prev && Array.isArray(prev.snapshots) ? prev.snapshots.slice() : []
            if (e.snapshot) snapshots.push(e.snapshot)
            const pruned = RouteAssistantYieldHistoryStore._prune(snapshots, limit)
            const rec = {
                hub:            String(e.hub || "").toUpperCase(),
                dest:           String(e.dest || "").toUpperCase(),
                snapshots:      pruned,
                lastSnapshotAt: pruned.length ? pruned[pruned.length - 1].timestamp : null
            }
            writes[key] = rec
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
     */
    static async deleteRoute(hub, dest) {
        const key = RouteAssistantYieldHistoryStore.CACHE_PREFIX
            + RouteAssistantYieldHistoryStore._pairKey(hub, dest)
        await chrome.storage.local.remove([key])
    }
}
