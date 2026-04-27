"use strict"

/**
 * Inventory quick-price apply-log store.
 *
 * Single FIFO ring under `routeAssistant:inventoryQuickPriceApplyLog`,
 * capacity 50 (newest first; oldest popped off the tail). Mirrors
 * service-profile-apply-log.js — one global ring rather than per-route
 * partitioning because the applier is one-class-at-a-time and rapid
 * repeated applies on the same route+class are exactly what dedup is
 * for.
 *
 *   {entries: [<entry>...], updatedAt}
 *
 * `add()` performs slim duplication-guard: if the most-recent entry
 * has the same fingerprint AND status AND the new ts is within
 * `dedupWindowMs` (default 5 min), the existing entry's `count` is
 * bumped and its ts refreshed instead of inserting a new row.
 */
class CentralInventoryQuickPriceApplyLog {
    static GLOBAL_KEY    = "routeAssistant:inventoryQuickPriceApplyLog"
    static DEFAULT_LIMIT = 50

    constructor(opts) {
        opts = opts || {}
        this.limit = isFinite(opts.limit)
            ? Math.max(10, opts.limit)
            : CentralInventoryQuickPriceApplyLog.DEFAULT_LIMIT
    }

    /**
     * Deterministic key for (hub, dest, classKey, newPrice). Drives dedup.
     */
    static fingerprint({hub, dest, classKey, newPrice}) {
        const h = String(hub || "").toUpperCase()
        const d = String(dest || "").toUpperCase()
        const c = String(classKey || "")
        const p = isFinite(newPrice) ? Math.round(Number(newPrice)) : ""
        return h + "-" + d + "|" + c + "=" + p
    }

    static _newId(ts) {
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    /**
     * Persist one apply record. Returns the saved record (with id).
     */
    async add(record, opts) {
        opts = opts || {}
        const dedupWindowMs = isFinite(opts.dedupWindowMs)
            ? opts.dedupWindowMs
            : 5 * 60 * 1000
        const ts = record && record.ts ? record.ts : Date.now()
        const fingerprint = (record && record.fingerprint) || null

        const cleaned = CentralInventoryQuickPriceApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || CentralInventoryQuickPriceApplyLog._newId(ts)

        const got = await chrome.storage.local.get([
            CentralInventoryQuickPriceApplyLog.GLOBAL_KEY
        ])
        const rec = got[CentralInventoryQuickPriceApplyLog.GLOBAL_KEY]
            || {entries: [], updatedAt: 0}
        let entries = Array.isArray(rec.entries) ? rec.entries.slice() : []

        let merged = false
        if (fingerprint && entries.length) {
            const head = entries[0]
            if (head
                && head.fingerprint === fingerprint
                && head.status === cleaned.status
                && (ts - head.ts) < dedupWindowMs) {
                head.ts = ts
                head.count = (head.count || 1) + 1
                cleaned.id = head.id
                merged = true
            }
        }
        if (!merged) entries.unshift(cleaned)
        if (entries.length > this.limit) entries = entries.slice(0, this.limit)

        await chrome.storage.local.set({
            [CentralInventoryQuickPriceApplyLog.GLOBAL_KEY]: {entries, updatedAt: ts}
        })
        return cleaned
    }

    async update(id, patch) {
        if (!id || !patch) return null
        const got = await chrome.storage.local.get([
            CentralInventoryQuickPriceApplyLog.GLOBAL_KEY
        ])
        const rec = got[CentralInventoryQuickPriceApplyLog.GLOBAL_KEY]
        if (!rec || !Array.isArray(rec.entries)) return null
        const idx = rec.entries.findIndex(e => e && e.id === id)
        if (idx < 0) return null
        const merged = Object.assign({}, rec.entries[idx], patch)
        const newEntries = rec.entries.slice()
        newEntries[idx] = merged
        const ts = Date.now()
        await chrome.storage.local.set({
            [CentralInventoryQuickPriceApplyLog.GLOBAL_KEY]: {entries: newEntries, updatedAt: ts}
        })
        return merged
    }

    async getRecent(n) {
        const got = await chrome.storage.local.get([
            CentralInventoryQuickPriceApplyLog.GLOBAL_KEY
        ])
        const rec = got[CentralInventoryQuickPriceApplyLog.GLOBAL_KEY]
            || {entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return {
            entries:   isFinite(n) && n > 0 ? entries.slice(0, n) : entries,
            updatedAt: rec.updatedAt || 0
        }
    }

    async getById(id) {
        if (!id) return null
        const r = await this.getRecent()
        return r.entries.find(e => e && e.id === id) || null
    }

    async clear() {
        await chrome.storage.local.remove([
            CentralInventoryQuickPriceApplyLog.GLOBAL_KEY
        ])
    }

    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:          r.id || null,
            ts:          r.ts || Date.now(),
            server:      r.server ? String(r.server) : null,
            hub:         r.hub  ? String(r.hub).toUpperCase()  : null,
            dest:        r.dest ? String(r.dest).toUpperCase() : null,
            classKey:    r.classKey || null,
            prev:        isFinite(r.prev) ? Number(r.prev) : null,
            new:         isFinite(r.new)  ? Number(r.new)  : null,
            verified:    isFinite(r.verified) ? Number(r.verified) : null,
            status:      r.status || "unknown",
            source:      r.source || "tile",
            fingerprint: r.fingerprint || null,
            httpStatus:  r.httpStatus || null,
            error:       r.error ? Object.assign({}, r.error) : null,
            count:       isFinite(r.count) ? r.count : 1
        }
        for (const k in out) {
            if (out[k] == null) delete out[k]
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.CentralInventoryQuickPriceApplyLog = CentralInventoryQuickPriceApplyLog
}
