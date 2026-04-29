"use strict"

/**
 * Pay-tier apply-log store (Slice 8).
 *
 * Single FIFO ring under `crewMgmt:payTier:applyLog`, capacity 50 (newest
 * first; oldest popped off the tail). Mirrors service-profile-apply-log.js
 * — same dedup-on-fingerprint pattern; only the storage key, the cap, and
 * the audit shape change (positionId + salary deltas instead of profileId
 * + radio-group changes).
 *
 * Shape persisted at the storage key:
 *   {entries: [<entry>...], updatedAt}
 *
 * `add()` performs slim duplication-guard: if the most-recent entry has
 * the same fingerprint AND status AND the new ts is within
 * `dedupWindowMs` (default 60s), the existing entry's `count` is bumped
 * and its ts is refreshed instead of inserting a new row.
 */
class CrewMgmtPayTierApplyLog {
    static GLOBAL_KEY    = "crewMgmt:payTier:applyLog"
    static DEFAULT_LIMIT = 50

    /**
     * @param {object} [opts]
     * @param {number} [opts.limit=50]
     */
    constructor(opts) {
        opts = opts || {}
        this.limit = isFinite(opts.limit)
            ? Math.max(10, opts.limit)
            : CrewMgmtPayTierApplyLog.DEFAULT_LIMIT
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
            : 60 * 1000
        const ts = record && record.ts ? record.ts : Date.now()
        const fingerprint = (record && record.fingerprint) || null

        const cleaned = CrewMgmtPayTierApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || CrewMgmtPayTierApplyLog._newId(ts)

        const got = await chrome.storage.local.get([CrewMgmtPayTierApplyLog.GLOBAL_KEY])
        const rec = got[CrewMgmtPayTierApplyLog.GLOBAL_KEY]
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
            [CrewMgmtPayTierApplyLog.GLOBAL_KEY]: {entries, updatedAt: ts}
        })
        return cleaned
    }

    /** Patch an existing entry by id (e.g., post-write verify upgrade). */
    async update(id, patch) {
        if (!id || !patch) return null
        const got = await chrome.storage.local.get([CrewMgmtPayTierApplyLog.GLOBAL_KEY])
        const rec = got[CrewMgmtPayTierApplyLog.GLOBAL_KEY]
        if (!rec || !Array.isArray(rec.entries)) return null
        const idx = rec.entries.findIndex(e => e && e.id === id)
        if (idx < 0) return null
        const merged = Object.assign({}, rec.entries[idx], patch)
        const newEntries = rec.entries.slice()
        newEntries[idx] = merged
        const ts = Date.now()
        await chrome.storage.local.set({
            [CrewMgmtPayTierApplyLog.GLOBAL_KEY]: {entries: newEntries, updatedAt: ts}
        })
        return merged
    }

    async getRecent(n) {
        const got = await chrome.storage.local.get([CrewMgmtPayTierApplyLog.GLOBAL_KEY])
        const rec = got[CrewMgmtPayTierApplyLog.GLOBAL_KEY]
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
        await chrome.storage.local.remove([CrewMgmtPayTierApplyLog.GLOBAL_KEY])
    }

    /**
     * Cooldown helper for the strategy panel — returns the ts of the most
     * recent terminal-success entry for a given positionId, or null.
     * Mirrors service-profile-apply-log.getLastSuccessAtFor.
     */
    async getLastSuccessAtFor(positionId) {
        if (positionId == null) return null
        const want = String(positionId)
        const r = await this.getRecent()
        for (const e of r.entries) {
            if (!e) continue
            if (String(e.positionId) !== want) continue
            if (e.status === "verified" || e.status === "posted") return e.ts || null
        }
        return null
    }

    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:               r.id || null,
            ts:               r.ts || Date.now(),
            positionId:       r.positionId != null ? String(r.positionId) : null,
            label:            r.label || null,
            status:           r.status || "unknown",
            source:           r.source || "tile",
            fingerprint:      r.fingerprint || null,
            requestedSalary:  isFinite(r.requestedSalary) ? Number(r.requestedSalary) : null,
            payTierPp:        isFinite(r.payTierPp)       ? Number(r.payTierPp)       : null,
            prevValues:       r.prevValues
                ? CrewMgmtPayTierApplyLog._cloneSalaryValues(r.prevValues)
                : null,
            newValues:        r.newValues
                ? CrewMgmtPayTierApplyLog._cloneSalaryValues(r.newValues)
                : null,
            verifiedValues:   r.verifiedValues
                ? CrewMgmtPayTierApplyLog._cloneSalaryValues(r.verifiedValues)
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

    static _cloneSalaryValues(src) {
        const out = {}
        if (!src) return out
        for (const k of ["salaryPerEmployee", "nextWeekSalaryPerEmployee", "countryAverage"]) {
            if (src[k] == null) continue
            const n = Number(src[k])
            if (isFinite(n)) out[k] = n
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.CrewMgmtPayTierApplyLog = CrewMgmtPayTierApplyLog
}
