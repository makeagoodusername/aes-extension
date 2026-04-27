"use strict"

/**
 * Per-aircraft historical flight log (Track 2 slice 2b.0).
 *
 * Persists block-time samples for completed flights so the wear-model can
 * compute "weekly block hours actually flown" instead of relying on the
 * forward Visual Flight Plan as a proxy.
 *
 *   aircraftFlightPlan:flightLog:<server>:<aircraftId> →
 *     {server, aircraftId,
 *      flights: [
 *        {flightNumber, depUtc, arrUtc, blockMinutes,
 *         status, originIata, destinationIata}
 *      ],
 *      scrapedAt, createdAt, updatedAt}
 *
 * `flights[]` is newest-first, capped at 200 entries (≈ a week of densely-
 * scheduled flying with margin). Older flights age out.
 *
 * The store dedupes on (flightNumber + depUtc) so re-running the scraper on
 * the same /1 page after pagination has shifted is a no-op for unchanged
 * rows.
 *
 * Public API:
 *   load(server, aircraftId)                        -> Record
 *   save(server, aircraftId, patch)                 -> Record
 *   appendNew(server, aircraftId, flights)          -> Record  (de-dupes)
 *   weeklyBlockHours(server, aircraftId, asOfMs?)   -> number | null
 *     Sum block-minutes of completed flights whose depUtc falls in the
 *     trailing 7 days from `asOf`. Returns null when fewer than 2 distinct
 *     completed flights overlap the window — signals "not enough data" to
 *     callers so they can fall back gracefully.
 */
class AesAfpFlightLogStore {
    static PREFIX = "aircraftFlightPlan:flightLog:"
    static FLIGHTS_CAP = 200
    static COMPLETED_STATUSES = ["finished", "inflight"]
    static SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000
    static MIN_SAMPLES_FOR_WEEK = 2

    static _key(server, aircraftId) {
        return AesAfpFlightLogStore.PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    static _empty(server, aircraftId) {
        return {
            server:     String(server || ""),
            aircraftId: String(aircraftId || ""),
            flights:    [],
            scrapedAt:  null,
            createdAt:  null,
            updatedAt:  null
        }
    }

    static async load(server, aircraftId) {
        if (!server || !aircraftId) return AesAfpFlightLogStore._empty(server, aircraftId)
        const key = AesAfpFlightLogStore._key(server, aircraftId)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") {
            return AesAfpFlightLogStore._empty(server, aircraftId)
        }
        return {
            server:     rec.server || String(server),
            aircraftId: rec.aircraftId || String(aircraftId),
            flights:    Array.isArray(rec.flights) ? rec.flights : [],
            scrapedAt:  isFinite(rec.scrapedAt) ? rec.scrapedAt : null,
            createdAt:  isFinite(rec.createdAt) ? rec.createdAt : null,
            updatedAt:  isFinite(rec.updatedAt) ? rec.updatedAt : null
        }
    }

    static _dedupKey(f) {
        return String(f && f.flightNumber || "") + "|" + String(f && f.depUtc || "")
    }

    /**
     * Append new flights to the existing list, de-duped on (flightNumber +
     * depUtc). New entries take precedence over existing ones with the same
     * key (so a status flip from "inflight" to "finished" gets recorded).
     * The merged list is sorted newest-first by depUtc and capped at
     * FLIGHTS_CAP.
     */
    static async appendNew(server, aircraftId, flights) {
        if (!server || !aircraftId) return null
        if (!Array.isArray(flights) || !flights.length) {
            return AesAfpFlightLogStore.load(server, aircraftId)
        }
        const existing = await AesAfpFlightLogStore.load(server, aircraftId)
        const map = new Map()
        for (const f of existing.flights) map.set(AesAfpFlightLogStore._dedupKey(f), f)
        for (const f of flights) {
            if (!f) continue
            const cleaned = {
                flightNumber:    f.flightNumber || null,
                depUtc:          f.depUtc || null,
                arrUtc:          f.arrUtc || null,
                blockMinutes:    isFinite(f.blockMinutes) ? Number(f.blockMinutes) : null,
                status:          f.status || null,
                originIata:      f.originIata || null,
                destinationIata: f.destinationIata || null
            }
            map.set(AesAfpFlightLogStore._dedupKey(cleaned), cleaned)
        }
        let merged = Array.from(map.values())
        merged.sort((a, b) => String(b.depUtc || "").localeCompare(String(a.depUtc || "")))
        if (merged.length > AesAfpFlightLogStore.FLIGHTS_CAP) {
            merged = merged.slice(0, AesAfpFlightLogStore.FLIGHTS_CAP)
        }

        const now = Date.now()
        const next = {
            server:     String(server),
            aircraftId: String(aircraftId),
            flights:    merged,
            scrapedAt:  now,
            createdAt:  existing.createdAt || now,
            updatedAt:  now
        }
        await chrome.storage.local.set({[AesAfpFlightLogStore._key(server, aircraftId)]: next})
        return next
    }

    static async save(server, aircraftId, patch) {
        if (!server || !aircraftId) return null
        const existing = await AesAfpFlightLogStore.load(server, aircraftId)
        const now = Date.now()
        const next = {
            server:     String(server),
            aircraftId: String(aircraftId),
            flights:    Array.isArray(patch && patch.flights) ? patch.flights : existing.flights,
            scrapedAt:  isFinite(patch && patch.scrapedAt) ? Number(patch.scrapedAt) : existing.scrapedAt,
            createdAt:  existing.createdAt || now,
            updatedAt:  now
        }
        await chrome.storage.local.set({[AesAfpFlightLogStore._key(server, aircraftId)]: next})
        return next
    }

    /**
     * Parse "DD.MM. HH:MM" UTC into ms epoch using the rolling-year
     * heuristic (current UTC year, with a one-year subtract when the
     * computed date is more than 30 days in the future). Returns null on
     * unparseable input.
     */
    static parseDepUtcToMs(depUtc, nowMs) {
        if (!depUtc || typeof depUtc !== "string") return null
        const m = depUtc.match(/^(\d{2})\.(\d{2})\.\s*(\d{2}):(\d{2})$/)
        if (!m) return null
        const day = Number(m[1]), mon = Number(m[2])
        const hh  = Number(m[3]), mm  = Number(m[4])
        const now = isFinite(nowMs) ? Number(nowMs) : Date.now()
        const refDate = new Date(now)
        let year = refDate.getUTCFullYear()
        let candidate = Date.UTC(year, mon - 1, day, hh, mm, 0)
        if (candidate - now > 30 * 24 * 3600 * 1000) {
            year -= 1
            candidate = Date.UTC(year, mon - 1, day, hh, mm, 0)
        }
        return candidate
    }

    /**
     * Sum block-minutes of completed flights whose depUtc falls in the
     * trailing 7 days from `asOfMs` (default = now). Returns hours, or null
     * when fewer than MIN_SAMPLES_FOR_WEEK flights overlap the window — the
     * regression doesn't deserve to be called with effectively-zero
     * historical data.
     */
    static async weeklyBlockHours(server, aircraftId, asOfMs) {
        const rec = await AesAfpFlightLogStore.load(server, aircraftId)
        const asOf = isFinite(asOfMs) ? Number(asOfMs) : Date.now()
        const cutoff = asOf - AesAfpFlightLogStore.SEVEN_DAYS_MS

        let totalMin = 0
        let count = 0
        for (const f of rec.flights) {
            if (!f || !f.status) continue
            if (AesAfpFlightLogStore.COMPLETED_STATUSES.indexOf(f.status) < 0) continue
            const ms = AesAfpFlightLogStore.parseDepUtcToMs(f.depUtc, asOf)
            if (ms == null) continue
            if (ms < cutoff || ms > asOf) continue
            if (!isFinite(f.blockMinutes) || f.blockMinutes <= 0) continue
            totalMin += Number(f.blockMinutes)
            count++
        }
        if (count < AesAfpFlightLogStore.MIN_SAMPLES_FOR_WEEK) return null
        return totalMin / 60
    }

    /**
     * Subscribe to flight-log updates across tabs. Mirrors
     * `AesAfpScheduleStore.watch`. Callback receives
     * `{server, aircraftId, log, oldLog}`; returns an unwatch fn.
     */
    static watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                if (key.indexOf(AesAfpFlightLogStore.PREFIX) !== 0) continue
                const tail = key.slice(AesAfpFlightLogStore.PREFIX.length)
                const sep = tail.indexOf(":")
                if (sep < 0) continue
                const server     = tail.slice(0, sep)
                const aircraftId = tail.slice(sep + 1)
                try {
                    cb({
                        server,
                        aircraftId,
                        log:    changes[key].newValue || null,
                        oldLog: changes[key].oldValue || null
                    })
                } catch (e) { console.warn("[AES AFP] flight-log-store watch handler threw", e) }
            }
        }
        try { chrome.storage.onChanged.addListener(handler) }
        catch (_) { return () => {} }
        return () => {
            try { chrome.storage.onChanged.removeListener(handler) }
            catch (_) { /* noop */ }
        }
    }
}

if (typeof window !== "undefined") {
    window.AesAfpFlightLogStore = AesAfpFlightLogStore
}
