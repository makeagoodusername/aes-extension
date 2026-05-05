"use strict"

/**
 * AFP Dashboard — flight-number apply log.
 *
 * Mirrors `RouteAssistantPricingApplyLog` (route-assistant/pricing-apply-log.js)
 * but keys per (server, aircraftId) instead of (hub, dest). Dry-run entries in
 * T1 land here; T2 will append `posted` / `verified` / `failed` / `aborted`.
 *
 *   aircraftFlightPlan:fnApplyLog                       — global ring (cap 200)
 *   aircraftFlightPlan:fnApplyLog:<server>:<aircraftId> — per-aircraft ring (cap 20)
 *
 * 5-min dedup on (fingerprint + status) collapses repeat clicks into a single
 * entry with bumped `count`, identical to pricing-apply-log.
 */
class AesAfpFnApplyLog {
    static GLOBAL_KEY       = "aircraftFlightPlan:fnApplyLog"
    static PER_AIRCRAFT_PREFIX = "aircraftFlightPlan:fnApplyLog:"
    static PER_AIRCRAFT_LIMIT  = 20
    static DEFAULT_LIMIT       = 200

    constructor(opts) {
        opts = opts || {}
        this.limit            = isFinite(opts.limit)            ? Math.max(20, opts.limit)            : AesAfpFnApplyLog.DEFAULT_LIMIT
        this.perAircraftLimit = isFinite(opts.perAircraftLimit) ? Math.max(5,  opts.perAircraftLimit) : AesAfpFnApplyLog.PER_AIRCRAFT_LIMIT
    }

    static _aircraftKey(server, aircraftId) {
        return AesAfpFnApplyLog.PER_AIRCRAFT_PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    static _newId(ts) {
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    /**
     * Persist one apply record. Same dedup window (5 min) as
     * pricing-apply-log so a misclick doesn't pollute the timeline. Returns
     * the saved (cleaned) record with its assigned id.
     */
    async add(record, opts) {
        opts = opts || {}
        const dedupWindowMs = isFinite(opts.dedupWindowMs) ? opts.dedupWindowMs : 5 * 60 * 1000
        const ts = (record && record.ts) || Date.now()
        const fingerprint = (record && record.fingerprint) || null

        const cleaned = AesAfpFnApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || AesAfpFnApplyLog._newId(ts)

        const acKey = AesAfpFnApplyLog._aircraftKey(cleaned.server, cleaned.aircraftId)
        const got = await chrome.storage.local.get([AesAfpFnApplyLog.GLOBAL_KEY, acKey])

        const globalRec = got[AesAfpFnApplyLog.GLOBAL_KEY] || {entries: [], updatedAt: 0}
        let entries = Array.isArray(globalRec.entries) ? globalRec.entries.slice() : []

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

        const acRec = got[acKey] || {server: cleaned.server, aircraftId: cleaned.aircraftId, entries: [], updatedAt: 0}
        let acEntries = Array.isArray(acRec.entries) ? acRec.entries.slice() : []
        // Per-aircraft ring does not dedup — every attempt is recorded.
        acEntries.unshift(cleaned)
        if (acEntries.length > this.perAircraftLimit) acEntries = acEntries.slice(0, this.perAircraftLimit)

        const updatedAt = ts
        await chrome.storage.local.set({
            [AesAfpFnApplyLog.GLOBAL_KEY]: {entries, updatedAt},
            [acKey]: {server: cleaned.server, aircraftId: cleaned.aircraftId, entries: acEntries, updatedAt}
        })
        return cleaned
    }

    async getRecent(n) {
        const got = await chrome.storage.local.get([AesAfpFnApplyLog.GLOBAL_KEY])
        const rec = got[AesAfpFnApplyLog.GLOBAL_KEY] || {entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return {
            entries:   isFinite(n) && n > 0 ? entries.slice(0, n) : entries,
            updatedAt: rec.updatedAt || 0
        }
    }

    async getForAircraft(server, aircraftId, n) {
        const acKey = AesAfpFnApplyLog._aircraftKey(server, aircraftId)
        const got = await chrome.storage.local.get([acKey])
        const rec = got[acKey] || {server: String(server || ""), aircraftId: String(aircraftId || ""), entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return Object.assign({}, rec, {
            entries: isFinite(n) && n > 0 ? entries.slice(0, n) : entries
        })
    }

    /**
     * Most recent terminal-success ts on this aircraft (verified/posted).
     * Drives the per-aircraft cooldown check in T2+. Dry-run/failed entries
     * don't count.
     */
    async getLastSuccessAt(server, aircraftId) {
        const r = await this.getForAircraft(server, aircraftId)
        for (const e of r.entries) {
            if (!e) continue
            if (e.status === "verified" || e.status === "posted") return e.ts || null
        }
        return null
    }

    async clear() {
        const all = await chrome.storage.local.get(null)
        const keys = [AesAfpFnApplyLog.GLOBAL_KEY]
        for (const k in all) {
            if (k.indexOf(AesAfpFnApplyLog.PER_AIRCRAFT_PREFIX) === 0) keys.push(k)
        }
        if (keys.length) await chrome.storage.local.remove(keys)
        return keys.length
    }

    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:           r.id || null,
            ts:           r.ts || Date.now(),
            server:       String(r.server || ""),
            aircraftId:   String(r.aircraftId || ""),
            registration: r.registration || null,
            equipment:    r.equipment    || null,
            status:       r.status       || "unknown",
            ok:           r.ok === true,
            source:       r.source       || "manual",
            leg:          r.leg ? Object.assign({}, r.leg) : null,
            postUrl:      r.postUrl      || null,
            submitButton: r.submitButton || null,
            bodyPreview:  r.bodyPreview ? String(r.bodyPreview).slice(0, 1500) : null,
            fingerprint:  r.fingerprint  || null,
            blockers:     Array.isArray(r.blockers) ? r.blockers.slice(0, 10).map(b => Object.assign({}, b)) : null,
            warnings:     Array.isArray(r.warnings) ? r.warnings.slice(0, 10).map(w => Object.assign({}, w)) : null,
            warning:      r.warning ? String(r.warning).slice(0, 240) : null,
            error:        r.error ? Object.assign({}, r.error) : null,
            reason:       r.reason ? String(r.reason).slice(0, 240) : null,
            httpStatus:   r.httpStatus || null,
            verifyAt:     r.verifyAt || null,
            verifiedFlightNumberDests: Array.isArray(r.verifiedFlightNumberDests)
                ? r.verifiedFlightNumberDests.slice(0, 40) : null,
            count:        isFinite(r.count) ? r.count : 1
        }
        for (const k in out) {
            if (out[k] == null) delete out[k]
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.AesAfpFnApplyLog = AesAfpFnApplyLog
}
