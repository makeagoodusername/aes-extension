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
 * Pair key is **directional** (matches RouteAssistantTicketPriceScraper).
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

    static _legacyKey(hub, dest) {
        return RouteAssistantYieldHistoryStore.CACHE_PREFIX
            + RouteAssistantYieldHistoryStore._pairKey(hub, dest)
    }

    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantYieldHistoryStore._legacyKey(hub, dest)
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(legacy, accountId)
        }
        return legacy
    }

    static _resolveAccountId(opts) {
        if (opts && typeof opts.accountId === "string" && opts.accountId) return opts.accountId
        if (typeof globalThis !== "undefined"
            && globalThis.AesAccountScopedKey
            && typeof globalThis.AesAccountScopedKey.currentAccountIdSync === "function") {
            return globalThis.AesAccountScopedKey.currentAccountIdSync()
        }
        return null
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

    static async loadRecord(hub, dest, opts) {
        const acctId = RouteAssistantYieldHistoryStore._resolveAccountId(opts)
        const scoped = RouteAssistantYieldHistoryStore._key(hub, dest, acctId)
        const legacy = RouteAssistantYieldHistoryStore._legacyKey(hub, dest)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        return out[scoped] || out[legacy] || null
    }

    /**
     * Bulk-load history records for a list of {hub, dest} pairs (or
     * [hub, dest] tuples). Returns Map<pairKey, record>. Optional `maxAgeDays`
     * drops records whose latest snapshot is older than the threshold.
     * Account-scoped first with a legacy-key fallback.
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId     = RouteAssistantYieldHistoryStore._resolveAccountId(opts)
        const maxAgeDays = (opts && Number(opts.maxAgeDays) > 0) ? Number(opts.maxAgeDays) : null
        const pairList   = []
        const scopedKeys = []
        const legacyKeys = []
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairList.push(RouteAssistantYieldHistoryStore._pairKey(a, b))
            scopedKeys.push(RouteAssistantYieldHistoryStore._key(a, b, acctId))
            legacyKeys.push(RouteAssistantYieldHistoryStore._legacyKey(a, b))
        }
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const out     = await chrome.storage.local.get(reqKeys)
        const map     = new Map()
        const now     = Date.now()
        for (let i = 0; i < pairList.length; i++) {
            const rec = out[scopedKeys[i]] || out[legacyKeys[i]] || null
            if (!rec || !Array.isArray(rec.snapshots) || !rec.snapshots.length) continue
            if (maxAgeDays) {
                const last = rec.lastSnapshotAt || rec.snapshots[rec.snapshots.length - 1].timestamp
                if (typeof last === "number" && (now - last) > maxAgeDays * 86400000) continue
            }
            map.set(pairList[i], rec)
        }
        return map
    }

    /**
     * Append snapshots to multiple route records in a single storage write.
     * Pre-existing record (if any) is read account-scoped first with a
     * legacy-key fallback, so a partially-migrated cache continues
     * accumulating instead of starting blank.
     *
     * @param {Array<{hub, dest, snapshot}>} entries
     * @param {object} [opts]
     * @param {number} [opts.historyLimit] keep the most-recent N snapshots per route
     * @param {string} [opts.accountId]    override resolved accountId
     * @returns {Promise<Map<pairKey, record>>}
     */
    static async appendSnapshots(entries, opts) {
        if (!entries || !entries.length) return new Map()
        const acctId = RouteAssistantYieldHistoryStore._resolveAccountId(opts)
        const limit  = RouteAssistantYieldHistoryStore._normaliseLimit(opts && opts.historyLimit)
        const scopedKeys = entries.map(e => RouteAssistantYieldHistoryStore._key(e.hub, e.dest, acctId))
        const legacyKeys = entries.map(e => RouteAssistantYieldHistoryStore._legacyKey(e.hub, e.dest))
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const existing = await chrome.storage.local.get(reqKeys)
        const writes = {}
        const updated = new Map()

        for (let i = 0; i < entries.length; i++) {
            const e = entries[i]
            const pair = RouteAssistantYieldHistoryStore._pairKey(e.hub, e.dest)
            const scopedKey = scopedKeys[i]
            const prev = existing[scopedKey] || existing[legacyKeys[i]] || null
            const snapshots = prev && Array.isArray(prev.snapshots) ? prev.snapshots.slice() : []
            if (e.snapshot) snapshots.push(e.snapshot)
            const pruned = RouteAssistantYieldHistoryStore._prune(snapshots, limit)
            const rec = {
                hub:            String(e.hub || "").toUpperCase(),
                dest:           String(e.dest || "").toUpperCase(),
                snapshots:      pruned,
                lastSnapshotAt: pruned.length ? pruned[pruned.length - 1].timestamp : null
            }
            writes[scopedKey] = rec
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
     * Removes both the scoped and legacy keys so a stale legacy entry
     * doesn't resurrect on the next read.
     */
    static async deleteRoute(hub, dest, opts) {
        const acctId = RouteAssistantYieldHistoryStore._resolveAccountId(opts)
        const scoped = RouteAssistantYieldHistoryStore._key(hub, dest, acctId)
        const legacy = RouteAssistantYieldHistoryStore._legacyKey(hub, dest)
        const toRemove = scoped === legacy ? [scoped] : [scoped, legacy]
        await chrome.storage.local.remove(toRemove)
    }
}
