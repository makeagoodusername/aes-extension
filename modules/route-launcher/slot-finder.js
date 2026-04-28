"use strict"

/**
 * Route Launcher — slot finder.
 *
 * Returns the next plausible departure HH:MM for a given aircraft based
 * on the configured slot strategy. AS's "New Flight Number" form takes
 * a single time of day; week-day placement is implicit in the resulting
 * schedule grid.
 *
 * Strategies (defaults from AesRouteLauncherDefaults):
 *   - "earliest-gap"        scan active draft, return last-arrival + turnaround,
 *                           wrapped into the operating window 06:00–22:00
 *   - "fixed-time"          always return defaultDepartureTime
 *   - "daily-round-robin"   defaultDepartureTime + (legCount * 4h) mod 24
 *
 * Reads the active draft (`aircraftFlightPlan:draft:<server>:<aircraftId>`)
 * via AesAfpActiveDraftStore — already loaded on the dashboard.
 */
class AesRouteLauncherSlotFinder {
    static MIN_HOUR = 6
    static MAX_HOUR = 22
    static FALLBACK = "09:00"

    static async findSlot(server, aircraftId, opts) {
        const o = opts || {}
        const strategy = o.strategy || "earliest-gap"
        const dflt = o.defaultDepartureTime || AesRouteLauncherSlotFinder.FALLBACK
        const turn = Number.isFinite(o.turnaroundMin) ? o.turnaroundMin : 30
        const flightMin = Number.isFinite(o.flightMin) ? o.flightMin : 60

        if (strategy === "fixed-time") return dflt

        const legs = await AesRouteLauncherSlotFinder._legsOf(server, aircraftId)
        if (strategy === "daily-round-robin") {
            const offset = (legs.length * 4) % 24
            const base = AesRouteLauncherSlotFinder._parse(dflt) || {h: 9, m: 0}
            return AesRouteLauncherSlotFinder._fmt((base.h + offset) % 24, base.m)
        }

        if (!legs.length) return dflt
        const lastArrivalMin = AesRouteLauncherSlotFinder._lastArrivalMin(legs, flightMin)
        if (lastArrivalMin == null) return dflt
        const proposedMin = (lastArrivalMin + turn) % (24 * 60)
        return AesRouteLauncherSlotFinder._clampToWindow(proposedMin, dflt)
    }

    static async _legsOf(server, aircraftId) {
        if (typeof window === "undefined" || !window.AesAfpActiveDraftStore) return []
        try {
            const draft = await window.AesAfpActiveDraftStore.load(server, aircraftId)
            return Array.isArray(draft.flights) ? draft.flights : []
        } catch (_) { return [] }
    }

    static _lastArrivalMin(legs, fallbackFlightMin) {
        let latest = null
        for (const f of legs) {
            const dep = AesRouteLauncherSlotFinder._parse(f.depTimeLocal || f.depTime)
            if (!dep) continue
            const dur = Number.isFinite(f.flightMin) ? f.flightMin
                      : Number.isFinite(f.blockMin)  ? f.blockMin
                      : fallbackFlightMin
            const arrMin = (dep.h * 60 + dep.m + dur) % (24 * 60)
            if (latest == null || arrMin > latest) latest = arrMin
        }
        return latest
    }

    static _clampToWindow(min, fallback) {
        const h = Math.floor(min / 60)
        const m = min % 60
        if (h < AesRouteLauncherSlotFinder.MIN_HOUR || h >= AesRouteLauncherSlotFinder.MAX_HOUR) {
            return fallback
        }
        return AesRouteLauncherSlotFinder._fmt(h, m)
    }

    static _parse(hhmm) {
        if (typeof hhmm !== "string") return null
        const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
        if (!m) return null
        const h = Number(m[1])
        const mm = Number(m[2])
        if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
        if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
        return {h, m: mm}
    }

    static _fmt(h, m) {
        return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0")
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherSlotFinder = AesRouteLauncherSlotFinder
}
