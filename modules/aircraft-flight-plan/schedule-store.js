"use strict"

;(function () {
    const root = (typeof window !== "undefined")
        ? window
        : ((typeof globalThis !== "undefined") ? globalThis : null)
    if (typeof window !== "undefined") {
        if (window.AesAfpScheduleStore) return
    } else if (root && root.AesAfpScheduleStore) {
        return
    }

/**
 * Track 7 slice 7c — Persistent per-aircraft Schedule store.
 *
 *   aircraftFlightPlan:schedule:<server>:<aircraftId> →
 *     Schedule  (see schedule-model.js for the value-object schema)
 *
 * The AFP page is the only writer (via `schedule-broadcaster.js`); every
 * other surface (Fleet Hub overlay, Route Assistant panel, Schedule
 * Management panel, aircraft-flights `/1` page) reads via
 * `chrome.storage.onChanged`. The same convention `active-draft-store.js`
 * has used since slice F (HANDOVER §2.2 — "the other side edits via
 * chrome.storage.onChanged").
 *
 * Single-writer read-modify-write — same atomicity convention as
 * `state-store.js:120` / `maintenance-store.js:80`. Every save() reads
 * the existing record, compares serialised content, and short-circuits
 * to a no-op when nothing changed (the Wicket-storm hash-gate trick from
 * `maintenance-store.js:102-108`). This keeps Wicket re-renders that
 * re-fire `ctx:ready` from spamming `chrome.storage.onChanged`.
 *
 * Serialisation: the in-memory Schedule carries `raw:` HTMLElement
 * back-refs on every block and leg (vfp-reader keeps them so live UI
 * actions can attach handlers later). Those references can't be
 * JSON-serialised, and they're meaningless to a consumer reading the
 * stored value from another tab. `_serializeForStorage(schedule)`
 * strips them before save; the loaded record has `raw: null` everywhere.
 *
 * Versioning: Schedule.schemaVersion = 1. Future schema changes bump
 * this; `load()` returns `null` for any record whose schemaVersion
 * doesn't match (the consumer falls back to the live DOM scrape).
 */
class AesAfpScheduleStore {
    static PREFIX        = "aircraftFlightPlan:schedule:"
    static SCHEMA_VERSION = 1
    static DEFAULT_FRESH_MS = 5 * 60 * 1000   // 5 minutes
    static STALE_BACKDATE_MS = 60 * 60 * 1000 // 1 hour — markStale() shifts scrapedAt this far back

    static _key(server, aircraftId) {
        return AesAfpScheduleStore.PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    /** Recursively strip `raw:` element refs so the schedule is JSON-safe. */
    static _serializeForStorage(schedule) {
        if (!schedule) return null
        const out = JSON.parse(JSON.stringify(schedule, (key, value) => {
            if (key === "raw") return null
            return value
        }))
        return out
    }

    /**
     * Returns the stored Schedule for one aircraft, or `null` if nothing
     * is persisted yet (or the persisted record's schemaVersion is too
     * old). Consumers should treat `null` as "fall back to a live scrape".
     */
    static async load(server, aircraftId) {
        if (!server || !aircraftId) return null
        const key = AesAfpScheduleStore._key(server, aircraftId)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") return null
        if (rec.schemaVersion !== AesAfpScheduleStore.SCHEMA_VERSION) return null
        return rec
    }

    /**
     * Persist a Schedule. Returns the stored record, or `null` when the
     * write was a no-op (the previous serialised payload was byte-equal
     * to the new one — see hash-gate in `maintenance-store.js:102-108`).
     *
     * Caller is responsible for setting `scrapedAt`; the broadcaster does
     * this at scrape time. We don't stamp it inside save() because that
     * would defeat the no-op detection (every save would change scrapedAt
     * even when content is identical).
     */
    static async save(server, aircraftId, schedule) {
        if (!server || !aircraftId)            return null
        if (!schedule || typeof schedule !== "object") return null

        const next = AesAfpScheduleStore._serializeForStorage({
            ...schedule,
            schemaVersion: AesAfpScheduleStore.SCHEMA_VERSION,
            server:        String(server),
            aircraftId:    String(aircraftId)
        })

        const key = AesAfpScheduleStore._key(server, aircraftId)
        const existing = (await chrome.storage.local.get([key]))[key] || null

        if (existing && AesAfpScheduleStore._isContentEqual(existing, next)) {
            return null
        }

        await chrome.storage.local.set({[key]: next})
        return next
    }

    /**
     * Detect content-level equality, ignoring `scrapedAt`. Two scrapes
     * 30s apart that produce identical schedules should NOT trigger a
     * storage write — that's how Wicket-storm hash-gating prevents
     * cross-tab consumers from getting hammered.
     */
    static _isContentEqual(a, b) {
        if (a === b) return true
        if (!a || !b) return false
        // Compare a fingerprint that omits scrapedAt.
        const fp = obj => JSON.stringify(obj, (k, v) => {
            if (k === "scrapedAt") return 0
            return v
        })
        return fp(a) === fp(b)
    }

    /**
     * Mark a stored schedule as stale by setting its `scrapedAt` 1 hour
     * into the past — every consumer's `isFresh()` check now returns
     * false until the AFP page re-scrapes. Cheaper than wiping the key
     * (which would force consumers into their empty fallback for a few
     * seconds during page reload). Used by apply-batch on `auto-apply:done`.
     *
     * Idempotent — a stale record stays stale.
     */
    static async markStale(server, aircraftId) {
        if (!server || !aircraftId) return
        const key = AesAfpScheduleStore._key(server, aircraftId)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") return
        const oldScrapedAt = (typeof rec.scrapedAt === "number") ? rec.scrapedAt : Date.now()
        const newScrapedAt = oldScrapedAt - AesAfpScheduleStore.STALE_BACKDATE_MS
        if (newScrapedAt === rec.scrapedAt) return
        rec.scrapedAt = newScrapedAt
        await chrome.storage.local.set({[key]: rec})
    }

    /**
     * Synchronously check whether a loaded Schedule is fresh enough for
     * a given consumer's tolerance. Returns false on null / missing /
     * malformed scrapedAt.
     */
    static isFresh(schedule, maxAgeMs) {
        if (!schedule || typeof schedule !== "object") return false
        const ts = (typeof schedule.scrapedAt === "number") ? schedule.scrapedAt : 0
        if (!ts) return false
        const ms = (typeof maxAgeMs === "number" && maxAgeMs > 0)
            ? maxAgeMs : AesAfpScheduleStore.DEFAULT_FRESH_MS
        return (Date.now() - ts) <= ms
    }

    /** ms since the schedule was scraped, or `Infinity` when scrapedAt is
     *  missing. Useful for "scrapedAt N min ago" badges. */
    static getStaleness(schedule) {
        if (!schedule || typeof schedule.scrapedAt !== "number" || !schedule.scrapedAt) return Infinity
        return Math.max(0, Date.now() - schedule.scrapedAt)
    }

    /**
     * Subscribe to schedule-store updates across tabs. The callback fires
     * every time `chrome.storage.local` reports a change to a key under
     * this store's PREFIX, with `{server, aircraftId, schedule, oldSchedule}`.
     * Returns an unwatch function.
     *
     * `schedule` is the new value (or null when the key was deleted);
     * `oldSchedule` is the previous value (or null on first write).
     */
    static watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                if (key.indexOf(AesAfpScheduleStore.PREFIX) !== 0) continue
                const tail = key.slice(AesAfpScheduleStore.PREFIX.length)
                const sep = tail.indexOf(":")
                if (sep < 0) continue
                const server     = tail.slice(0, sep)
                const aircraftId = tail.slice(sep + 1)
                try {
                    cb({
                        server,
                        aircraftId,
                        schedule:    changes[key].newValue || null,
                        oldSchedule: changes[key].oldValue || null
                    })
                } catch (e) { console.warn("[AES AFP] schedule-store watch handler threw", e) }
            }
        }
        try { chrome.storage.onChanged.addListener(handler) }
        catch (_) { /* test env without chrome.storage */ return () => {} }
        return () => {
            try { chrome.storage.onChanged.removeListener(handler) }
            catch (_) { /* noop */ }
        }
    }

    /** Wipe one aircraft's persisted schedule. Not surfaced in the UI;
     *  useful for tests + future "Reset this aircraft" CTA. */
    static async remove(server, aircraftId) {
        if (!server || !aircraftId) return
        const key = AesAfpScheduleStore._key(server, aircraftId)
        await chrome.storage.local.remove([key])
    }
}

if (root) {
    root.AesAfpScheduleStore = AesAfpScheduleStore
}
})()
