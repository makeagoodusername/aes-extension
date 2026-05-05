"use strict"

/**
 * Phase 4 — rebalance apply-log ring.
 *
 * One audit entry per rebalance-applier attempt (dry-run, applied, failed,
 * skipped). Single global timeline only — proposals are hub/preset-scoped,
 * not route-scoped, so the per-route ring used by pricing-apply-log isn't
 * useful here. Cap 100 entries (rebalance applies are rate-limited at
 * `apply.maxAppliesPer24h` and gated by §4.17 anti-spiral).
 *
 * Storage:
 *   global timeline → `routeAssistant:rebalanceApplyLog`
 *                     {entries: [...], updatedAt}
 *   account-scoped via AesAccountKey.acctKey when bootstrapped; legacy
 *   global key still readable for installs that pre-date L1 scoping.
 *
 * Public API:
 *   const log = new AesStrategyRebalanceApplyLog({limit?})
 *   await log.add({proposalId, kind, status, hubIata, ...})
 *   await log.getRecent(n?)            → {entries, updatedAt}
 *   await log.getLastSuccessAt()       → ts | null
 *   await log.countSince(sinceMs)      → integer
 *   await log.clear()
 *
 * Status values shipped by the applier:
 *   "applied"    — live POST/state change verified
 *   "dry-run"    — gates passed but `apply.dryRunOnly === true`
 *   "skipped"    — gate blocked (reason captured)
 *   "failed"     — gates passed, work threw
 *   "advisory"   — kind not yet wireable (e.g. service-profile-promote)
 */
class AesStrategyRebalanceApplyLog {
    static GLOBAL_KEY    = "routeAssistant:rebalanceApplyLog"
    static DEFAULT_LIMIT = 100

    constructor(opts) {
        opts = opts || {}
        this.limit = isFinite(opts.limit) ? Math.max(20, opts.limit) : AesStrategyRebalanceApplyLog.DEFAULT_LIMIT
    }

    static _key() {
        if (typeof window !== "undefined" && window.AesAccountKey
                && typeof window.AesAccountKey.acctKey === "function") {
            return window.AesAccountKey.acctKey(AesStrategyRebalanceApplyLog.GLOBAL_KEY)
        }
        return AesStrategyRebalanceApplyLog.GLOBAL_KEY
    }

    static _newId(ts) {
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    async add(record) {
        const ts = record && record.ts ? record.ts : Date.now()
        const cleaned = AesStrategyRebalanceApplyLog._cleanRecord(record)
        cleaned.ts = ts
        cleaned.id = cleaned.id || AesStrategyRebalanceApplyLog._newId(ts)

        const key = AesStrategyRebalanceApplyLog._key()
        let entries = []
        let updatedAt = 0
        try {
            const got = await chrome.storage.local.get([key])
            const rec = got[key]
            if (rec && Array.isArray(rec.entries)) entries = rec.entries.slice()
            if (rec && isFinite(rec.updatedAt)) updatedAt = rec.updatedAt
        } catch (_) { /* fresh ring */ }

        entries.unshift(cleaned)
        if (entries.length > this.limit) entries = entries.slice(0, this.limit)

        try {
            await chrome.storage.local.set({[key]: {entries, updatedAt: ts}})
        } catch (e) { console.warn("[AES rebalance-apply-log] add failed:", e) }
        return cleaned
    }

    async getRecent(n) {
        const key = AesStrategyRebalanceApplyLog._key()
        try {
            const got = await chrome.storage.local.get([key])
            const rec = got[key] || {entries: [], updatedAt: 0}
            const entries = Array.isArray(rec.entries) ? rec.entries : []
            return {
                entries:   isFinite(n) && n > 0 ? entries.slice(0, n) : entries,
                updatedAt: rec.updatedAt || 0
            }
        } catch (_) { return {entries: [], updatedAt: 0} }
    }

    async getLastSuccessAt() {
        const r = await this.getRecent()
        for (const e of r.entries) {
            if (!e) continue
            if (e.status === "applied") return e.ts || null
        }
        return null
    }

    async countSince(sinceMs) {
        if (!isFinite(sinceMs)) return 0
        const r = await this.getRecent()
        let n = 0
        for (const e of r.entries) {
            if (!e) continue
            if (e.status !== "applied") continue
            if (!isFinite(e.ts)) continue
            if (e.ts >= sinceMs) n++
        }
        return n
    }

    async clear() {
        const key = AesStrategyRebalanceApplyLog._key()
        try { await chrome.storage.local.remove([key]) }
        catch (e) { console.warn("[AES rebalance-apply-log] clear failed:", e) }
    }

    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:           r.id || null,
            ts:           r.ts || Date.now(),
            proposalId:   r.proposalId ? String(r.proposalId).slice(0, 80) : null,
            kind:         r.kind ? String(r.kind).slice(0, 40) : null,
            status:       r.status || "unknown",
            source:       r.source || "manual",
            hubIata:      r.hubIata ? String(r.hubIata).toUpperCase().slice(0, 8) : null,
            presetId:     r.presetId ? String(r.presetId).slice(0, 60) : null,
            waveId:       r.waveId ? String(r.waveId).slice(0, 60) : null,
            aircraftIds:  Array.isArray(r.aircraftIds)
                              ? r.aircraftIds.slice(0, 16).map(String) : null,
            predicted:    (r.predicted && typeof r.predicted === "object")
                              ? Object.assign({}, r.predicted) : null,
            payload:      (r.payload && typeof r.payload === "object")
                              ? JSON.parse(JSON.stringify(r.payload)) : null,
            rationale:    Array.isArray(r.rationale)
                              ? r.rationale.slice(0, 12).map(s => String(s).slice(0, 240)) : null,
            reason:       r.reason ? String(r.reason).slice(0, 240) : null,
            error:        r.error  ? String(r.error).slice(0, 240)  : null,
            dryRun:       !!r.dryRun
        }
        for (const k in out) if (out[k] == null) delete out[k]
        return out
    }
}

if (typeof window !== "undefined") {
    window.AesStrategyRebalanceApplyLog = AesStrategyRebalanceApplyLog
}
