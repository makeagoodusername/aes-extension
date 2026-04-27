"use strict"

/**
 * Service-profile apply-log store.
 *
 * Single FIFO ring under `routeAssistant:serviceProfileApplyLog`, capacity
 * 50 (newest first; oldest popped off the tail). Mirrors
 * pricing-apply-log.js but drops the per-route partition because service
 * profiles are keyed by id, not hub-dest pair.
 *
 *   {entries: [<entry>...], updatedAt}
 *
 * `add()` performs slim duplication-guard: if the most-recent entry has
 * the same fingerprint AND status AND the new ts is within
 * `dedupWindowMs` (default 5 min), the existing entry's `count` is bumped
 * and its ts is refreshed instead of inserting a new row.
 */
class RouteAssistantServiceProfileApplyLog {
    static GLOBAL_KEY    = "routeAssistant:serviceProfileApplyLog"
    static DEFAULT_LIMIT = 50

    /**
     * @param {object} [opts]
     * @param {number} [opts.limit=50]
     */
    constructor(opts) {
        opts = opts || {}
        this.limit = isFinite(opts.limit)
            ? Math.max(10, opts.limit)
            : RouteAssistantServiceProfileApplyLog.DEFAULT_LIMIT
    }

    static _newId(ts) {
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    /**
     * Persist one apply record. Returns the saved record (with assigned id).
     */
    async add(record, opts) {
        opts = opts || {}
        const dedupWindowMs = isFinite(opts.dedupWindowMs)
            ? opts.dedupWindowMs
            : 5 * 60 * 1000
        const ts = record && record.ts ? record.ts : Date.now()
        const fingerprint = (record && record.fingerprint) || null

        const cleaned = RouteAssistantServiceProfileApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || RouteAssistantServiceProfileApplyLog._newId(ts)

        const got = await chrome.storage.local.get([
            RouteAssistantServiceProfileApplyLog.GLOBAL_KEY
        ])
        const rec = got[RouteAssistantServiceProfileApplyLog.GLOBAL_KEY]
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
            [RouteAssistantServiceProfileApplyLog.GLOBAL_KEY]: {entries, updatedAt: ts}
        })
        return cleaned
    }

    /**
     * Patch an existing entry by id (e.g., upgrade a `posted` to a later
     * verified flag). No-op if id not found.
     */
    async update(id, patch) {
        if (!id || !patch) return null
        const got = await chrome.storage.local.get([
            RouteAssistantServiceProfileApplyLog.GLOBAL_KEY
        ])
        const rec = got[RouteAssistantServiceProfileApplyLog.GLOBAL_KEY]
        if (!rec || !Array.isArray(rec.entries)) return null
        const idx = rec.entries.findIndex(e => e && e.id === id)
        if (idx < 0) return null
        const merged = Object.assign({}, rec.entries[idx], patch)
        const newEntries = rec.entries.slice()
        newEntries[idx] = merged
        const ts = Date.now()
        await chrome.storage.local.set({
            [RouteAssistantServiceProfileApplyLog.GLOBAL_KEY]: {entries: newEntries, updatedAt: ts}
        })
        return merged
    }

    async getRecent(n) {
        const got = await chrome.storage.local.get([
            RouteAssistantServiceProfileApplyLog.GLOBAL_KEY
        ])
        const rec = got[RouteAssistantServiceProfileApplyLog.GLOBAL_KEY]
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
            RouteAssistantServiceProfileApplyLog.GLOBAL_KEY
        ])
    }

    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:               r.id || null,
            ts:               r.ts || Date.now(),
            profileId:        isFinite(r.profileId) ? Number(r.profileId) : null,
            status:           r.status || "unknown",
            source:           r.source || "tile",
            fingerprint:      r.fingerprint || null,
            requestedChanges: r.requestedChanges
                ? RouteAssistantServiceProfileApplyLog._cloneChanges(r.requestedChanges)
                : null,
            prevValues:       r.prevValues
                ? RouteAssistantServiceProfileApplyLog._cloneChanges(r.prevValues)
                : null,
            newValues:        r.newValues
                ? RouteAssistantServiceProfileApplyLog._cloneChanges(r.newValues)
                : null,
            verifiedValues:   r.verifiedValues
                ? RouteAssistantServiceProfileApplyLog._cloneChanges(r.verifiedValues)
                : null,
            verified:         !!r.verified,
            httpStatus:       r.httpStatus || null,
            error:            r.error ? Object.assign({}, r.error) : null,
            warning:          r.warning ? String(r.warning).slice(0, 240) : null,
            bodyPreview:      r.bodyPreview ? String(r.bodyPreview).slice(0, 1500) : null,
            count:            isFinite(r.count) ? r.count : 1
        }
        for (const k in out) {
            if (out[k] == null) delete out[k]
        }
        return out
    }

    static _cloneChanges(src) {
        const out = {}
        if (!src) return out
        for (const cat in src) {
            const cls = src[cat] || {}
            const slot = {}
            for (const k in cls) {
                if (cls[k] == null) continue
                slot[k] = cls[k]
            }
            if (Object.keys(slot).length) out[cat] = slot
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantServiceProfileApplyLog = RouteAssistantServiceProfileApplyLog
}
