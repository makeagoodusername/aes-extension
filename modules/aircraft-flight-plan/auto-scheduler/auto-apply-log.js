"use strict"

/**
 * Track 5 slice 5e — auto-apply audit log + retry queue.
 *
 * Mirrors the dual-store ring-buffer pattern from
 * `modules/route-assistant/pricing-apply-log.js`:
 *
 *   1. Global timeline   `aircraftFlightPlan:autoApplyLog`
 *      → {entries: [...], updatedAt}
 *      Capped at 200 entries (newest first; oldest pop off the tail).
 *      Single key drives a future "Recent batches" cross-aircraft view.
 *
 *   2. Per-aircraft ring `aircraftFlightPlan:autoApplyLog:<server>:<aircraftId>`
 *      → {server, aircraftId, entries: [...], updatedAt}
 *      Capped at 80 entries per aircraft (≈ 3 batches of 28 legs apiece).
 *      `getForAircraft` + `getRetryQueue` read this exclusively so the
 *      per-aircraft retry CTA stays cheap (no global scan).
 *
 * Entry shape (kept thin — drop nulls in `_cleanRecord`):
 *
 *   {
 *     id, ts, batchId, server, aircraftId, hub,
 *     status: "queued" | "started" | "ok" | "failed"
 *           | "aborted" | "done" | "error" | "queue-dismissed"
 *     // Per-leg entries (status: ok/failed/aborted) carry these:
 *     legIdx, seq, origin, dest, depTime, pricePct, service,
 *     direction, waveLabel, error, source
 *     // Batch lifecycle entries (status: queued/started/done/error):
 *     total, succeeded, failed, elapsedMs
 *   }
 *
 * Singleton exported as `window.AesAfpAutoApplyLog` (mirrors
 * `audit-log.js`'s singleton-instance convention).
 *
 * Tier-gate posture: this store is write-only from `apply-batch.js`
 * which itself only fires when the user has unlocked the
 * `autoScheduler.tier === "apply-on-confirm"` gate. Reads are open —
 * the diagnostics console can dump the log unconditionally.
 */
class AesAfpAutoApplyLogClass {
    static GLOBAL_KEY          = "aircraftFlightPlan:autoApplyLog"
    static PER_AIRCRAFT_PREFIX = "aircraftFlightPlan:autoApplyLog:"
    static GLOBAL_LIMIT        = 200
    static PER_AIRCRAFT_LIMIT  = 80

    static _aircraftKey(server, aircraftId) {
        return AesAfpAutoApplyLogClass.PER_AIRCRAFT_PREFIX
            + String(server || "") + ":" + String(aircraftId || "")
    }

    static _newId(ts) {
        const t = (ts || Date.now()).toString(36)
        const r = Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
        return t + "-" + r
    }

    /**
     * Coerce a raw record into the canonical audit shape and drop nulls
     * to keep storage small.
     */
    static _cleanRecord(record) {
        const r = record || {}
        const out = {
            id:         r.id || null,
            ts:         (typeof r.ts === "number" && isFinite(r.ts)) ? r.ts : Date.now(),
            batchId:    r.batchId    ? String(r.batchId).slice(0, 64) : null,
            server:     r.server     ? String(r.server)               : null,
            aircraftId: r.aircraftId ? String(r.aircraftId)           : null,
            hub:        r.hub        ? String(r.hub).toUpperCase().slice(0, 4) : null,
            status:     r.status     ? String(r.status).slice(0, 32)  : "unknown",
            legIdx:     (typeof r.legIdx === "number" && isFinite(r.legIdx)) ? r.legIdx : null,
            seq:        (r.seq != null) ? r.seq : null,
            origin:     r.origin     ? String(r.origin).toUpperCase().slice(0, 4) : null,
            dest:       r.dest       ? String(r.dest).toUpperCase().slice(0, 4)   : null,
            depTime:    r.depTime    ? String(r.depTime).slice(0, 5)              : null,
            pricePct:   (typeof r.pricePct === "number" && isFinite(r.pricePct))  ? r.pricePct : null,
            service:    r.service    ? String(r.service).slice(0, 64)             : null,
            direction:  r.direction  ? String(r.direction).slice(0, 16)           : null,
            waveLabel:  r.waveLabel  ? String(r.waveLabel).slice(0, 64)           : null,
            error:      r.error      ? String(r.error).slice(0, 240)              : null,
            source:     r.source     ? String(r.source).slice(0, 32)              : null,
            total:      (typeof r.total === "number" && isFinite(r.total))         ? r.total : null,
            succeeded:  (typeof r.succeeded === "number" && isFinite(r.succeeded)) ? r.succeeded : null,
            failed:     (typeof r.failed === "number" && isFinite(r.failed))       ? r.failed : null,
            elapsedMs:  (typeof r.elapsedMs === "number" && isFinite(r.elapsedMs)) ? r.elapsedMs : null
        }
        for (const k in out) if (out[k] == null) delete out[k]
        return out
    }

    /**
     * Persist one entry to BOTH stores in a single chrome.storage.local.set
     * — same single-write invariant as `audit-log.js` (preserves the
     * global vs per-aircraft sync contract).
     */
    async add(record) {
        const cleaned = AesAfpAutoApplyLogClass._cleanRecord(record)
        cleaned.id = cleaned.id || AesAfpAutoApplyLogClass._newId(cleaned.ts)
        // Phase A4 — stamp accountId for future per-account splitting.
        if (cleaned.accountId == null
                && window.AesAccountKey
                && typeof window.AesAccountKey.currentAccountIdSync === "function") {
            const acctId = window.AesAccountKey.currentAccountIdSync()
            if (acctId) cleaned.accountId = acctId
        }

        const globalKey = AesAfpAutoApplyLogClass.GLOBAL_KEY
        const aircraftKey = (cleaned.server && cleaned.aircraftId)
            ? AesAfpAutoApplyLogClass._aircraftKey(cleaned.server, cleaned.aircraftId)
            : null
        const keys = aircraftKey ? [globalKey, aircraftKey] : [globalKey]
        const got = await chrome.storage.local.get(keys)

        const globalRec = (got && got[globalKey]) || {entries: [], updatedAt: 0}
        let entries = Array.isArray(globalRec.entries) ? globalRec.entries.slice() : []
        entries.unshift(cleaned)
        if (entries.length > AesAfpAutoApplyLogClass.GLOBAL_LIMIT) {
            entries = entries.slice(0, AesAfpAutoApplyLogClass.GLOBAL_LIMIT)
        }
        const writes = {[globalKey]: {entries, updatedAt: cleaned.ts}}

        if (aircraftKey) {
            const acRec = (got && got[aircraftKey])
                || {server: cleaned.server, aircraftId: cleaned.aircraftId, entries: [], updatedAt: 0}
            let acEntries = Array.isArray(acRec.entries) ? acRec.entries.slice() : []
            acEntries.unshift(cleaned)
            if (acEntries.length > AesAfpAutoApplyLogClass.PER_AIRCRAFT_LIMIT) {
                acEntries = acEntries.slice(0, AesAfpAutoApplyLogClass.PER_AIRCRAFT_LIMIT)
            }
            writes[aircraftKey] = {
                server:     cleaned.server,
                aircraftId: cleaned.aircraftId,
                entries:    acEntries,
                updatedAt:  cleaned.ts
            }
        }

        // Phase A4 — dual-write to account-scoped keys. Legacy reads stay
        // canonical; the scoped keys give the migration's second slice a
        // clean per-account history.
        if (cleaned.accountId) {
            const scopedGlobal = AesAfpAutoApplyLogClass.GLOBAL_KEY
                + ":acct:" + cleaned.accountId
            writes[scopedGlobal] = {entries, updatedAt: cleaned.ts}
            if (aircraftKey && writes[aircraftKey]) {
                const scopedAircraft = scopedGlobal + ":"
                    + cleaned.server + ":" + cleaned.aircraftId
                writes[scopedAircraft] = writes[aircraftKey]
            }
        }
        await chrome.storage.local.set(writes)
        return cleaned
    }

    /** Read the global timeline. `n` slices the head; omit to get all. */
    async getRecent(n) {
        const got = await chrome.storage.local.get([AesAfpAutoApplyLogClass.GLOBAL_KEY])
        const rec = got[AesAfpAutoApplyLogClass.GLOBAL_KEY] || {entries: [], updatedAt: 0}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return (isFinite(n) && n > 0) ? entries.slice(0, n) : entries
    }

    /** Read one aircraft's per-aircraft ring (newest first). */
    async getForAircraft(server, aircraftId, n) {
        if (!server || !aircraftId) return []
        const key = AesAfpAutoApplyLogClass._aircraftKey(server, aircraftId)
        const got = await chrome.storage.local.get([key])
        const rec = got[key] || {entries: []}
        const entries = Array.isArray(rec.entries) ? rec.entries : []
        return (isFinite(n) && n > 0) ? entries.slice(0, n) : entries
    }

    /**
     * Retry-queue surface — failed entries from the LATEST batch on this
     * aircraft. Excludes:
     *
     * - Failed seqs that have a later "ok" entry anywhere in the ring
     *   (the leg succeeded on a retry batch OR via a manual single-leg
     *   apply elsewhere — either way it shouldn't surface as "still failed").
     * - Anything when the latest batch carries a "queue-dismissed"
     *   marker (user clicked Dismiss; the underlying entries stay in
     *   the ring for audit history but the CTA is fenced off).
     *
     * Returns `{batchId, legs, dismissed?}`.
     */
    async getRetryQueue(server, aircraftId) {
        const all = await this.getForAircraft(server, aircraftId)
        if (!all.length) return {batchId: null, legs: []}

        let latestBatchId = null
        for (const e of all) {
            if (!e || !e.batchId) continue
            if (e.status === "queue-dismissed") continue
            latestBatchId = e.batchId
            break
        }
        if (!latestBatchId) return {batchId: null, legs: []}

        for (const e of all) {
            if (!e) continue
            if (e.status === "queue-dismissed" && e.batchId === latestBatchId) {
                return {batchId: latestBatchId, legs: [], dismissed: true}
            }
        }

        const okSeqs = new Set()
        for (const e of all) {
            if (e && e.status === "ok" && e.seq != null) okSeqs.add(String(e.seq))
        }

        const legs = []
        const seenSeqs = new Set()
        for (const e of all) {
            if (!e || e.batchId !== latestBatchId) continue
            if (e.status !== "failed") continue
            const seqKey = String(e.seq)
            if (seenSeqs.has(seqKey)) continue   // dedup if a leg failed twice in the same batch
            if (okSeqs.has(seqKey))   continue   // later "ok" supersedes
            seenSeqs.add(seqKey)
            legs.push(e)
        }
        return {batchId: latestBatchId, legs}
    }

    /**
     * Wipe the retry queue for one aircraft by stamping a "queue-dismissed"
     * marker for the latest batch. The underlying failed entries remain
     * in the ring for audit history; subsequent `getRetryQueue` calls
     * read the marker as a fence and return an empty list.
     */
    async dismissRetryQueue(server, aircraftId) {
        const queue = await this.getRetryQueue(server, aircraftId)
        if (!queue.batchId || queue.dismissed) return false
        await this.add({
            ts:         Date.now(),
            batchId:    queue.batchId,
            server,
            aircraftId,
            status:     "queue-dismissed",
            source:     "manual"
        })
        return true
    }

    /** Wipe BOTH stores entirely. Returns the count of keys removed. */
    async clear() {
        const all = await chrome.storage.local.get(null)
        const keys = [AesAfpAutoApplyLogClass.GLOBAL_KEY]
        for (const k in all) {
            if (k.startsWith(AesAfpAutoApplyLogClass.PER_AIRCRAFT_PREFIX)) keys.push(k)
        }
        if (keys.length) await chrome.storage.local.remove(keys)
        return keys.length
    }
}

const _aesAfpAutoApplyLog = new AesAfpAutoApplyLogClass()
if (typeof window !== "undefined") {
    window.AesAfpAutoApplyLog = _aesAfpAutoApplyLog
}

// ── ?aes-debug smoke tests (no test runner — project convention) ───────
try {
    if (typeof location !== "undefined"
            && /[?&]aes-debug\b/.test(location.search || "")) {
        console.assert(typeof window.AesAfpAutoApplyLog.add === "function",
            "[AES auto-5e smoke] add() exposed")
        console.assert(typeof window.AesAfpAutoApplyLog.getRetryQueue === "function",
            "[AES auto-5e smoke] getRetryQueue() exposed")
        console.assert(typeof window.AesAfpAutoApplyLog.dismissRetryQueue === "function",
            "[AES auto-5e smoke] dismissRetryQueue() exposed")
        const c = AesAfpAutoApplyLogClass._cleanRecord({
            ts: 100, batchId: "b1", server: "free1", aircraftId: "6968",
            hub: "mco", origin: "mco", dest: "jfk", depTime: "09:00",
            status: "ok", seq: 1, legIdx: 0, error: null, service: ""
        })
        console.assert(c.hub === "MCO" && c.dest === "JFK"
            && !("error" in c) && !("service" in c),
            "[AES auto-5e smoke] _cleanRecord normalises iatas + drops nulls")
    }
} catch (_) { /* never let smoke break the page */ }
