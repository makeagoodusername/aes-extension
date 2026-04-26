/**
 * Shared utilities for the schedule-management module.
 *
 * This module is intentionally pure / framework-free — every function is a
 * static method that takes its inputs explicitly. The presets-store, builder,
 * and panel all import from here so we have one source of truth for range
 * categorisation, distance math, and HH:MM time arithmetic.
 *
 * Distance unit throughout: nautical miles (nm). AirlineSim's route distances
 * are reported in km in the UI but most aircraft range specs are in nm —
 * convert at the boundary, not here.
 */
class ScheduleFactors {
    /**
     * Default range buckets in nautical miles. The boundaries roughly match
     * AS's own short/medium/long-haul buckets; users can override per preset.
     */
    static defaultRangeBuckets() {
        return {
            shortHaul:  {label: "Short haul",  min: 0,    max: 1500},
            mediumHaul: {label: "Medium haul", min: 1500, max: 3500},
            longHaul:   {label: "Long haul",   min: 3500, max: 99999}
        }
    }

    /**
     * Default factor block applied to a fresh preset. These are the knobs the
     * builder consults when it places flights and emits warnings.
     */
    static defaultFactors() {
        return {
            minTransferMinutes: 45,
            maxTransferMinutes: 240,
            turnaroundBuffer: 10,
            rangeBuckets: ScheduleFactors.defaultRangeBuckets(),
            slotWindow: {start: "06:00", end: "23:00"},
            dayPattern: "daily",
            dayMask: [1, 1, 1, 1, 1, 1, 1],
            nightArrivalsAllowed: false,
            timezoneAware: true
        }
    }

    /**
     * Returns the bucket key for a given distance, or null if no bucket
     * accepts it.
     * @param {number} distanceNm
     * @param {object} buckets - {key: {min, max}, …} (defaults if omitted)
     */
    static bucketize(distanceNm, buckets) {
        const b = buckets || ScheduleFactors.defaultRangeBuckets()
        for (const key in b) {
            const range = b[key]
            if (distanceNm >= range.min && distanceNm < range.max) return key
        }
        return null
    }

    /**
     * True if an aircraft with the given range can fly the route distance
     * with a small safety margin (5%). The margin matches AS's own routing
     * checker which refuses routes near the spec limit.
     */
    static aircraftCanFly(aircraftRangeNm, distanceNm) {
        if (!aircraftRangeNm || !distanceNm) return false
        return aircraftRangeNm * 0.95 >= distanceNm
    }

    /**
     * Great-circle distance in nautical miles between two lat/lon pairs
     * (decimal degrees). Used when the panel needs to compute a route
     * distance from raw coordinates rather than fetching it from AS.
     */
    static haversineNm(latA, lonA, latB, lonB) {
        const R_NM = 3440.065
        const toRad = d => d * Math.PI / 180
        const dLat = toRad(latB - latA)
        const dLon = toRad(lonB - lonA)
        const a = Math.sin(dLat/2)**2
            + Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon/2)**2
        return Math.round(2 * R_NM * Math.asin(Math.sqrt(a)))
    }

    /** km → nm */
    static kmToNm(km) { return Math.round(km * 0.539957) }

    /** nm → km */
    static nmToKm(nm) { return Math.round(nm * 1.852) }

    /**
     * "HH:MM" → minutes since midnight. Returns NaN on bad input so callers
     * can detect parse failures without try/catch.
     */
    static parseHHMM(str) {
        if (typeof str !== "string") return NaN
        const m = str.match(/^([0-2]?\d):([0-5]\d)$/)
        if (!m) return NaN
        const h = parseInt(m[1], 10)
        const mm = parseInt(m[2], 10)
        if (h > 23) return NaN
        return h * 60 + mm
    }

    /** minutes since midnight → "HH:MM" (always zero-padded, wraps at 24h) */
    static formatHHMM(minutes) {
        const m = ((Math.round(minutes) % 1440) + 1440) % 1440
        const h = Math.floor(m / 60)
        const mm = m % 60
        return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0")
    }

    /**
     * Signed difference in minutes from `from` to `to`, both "HH:MM".
     * Positive = `to` is later in the day. Caller decides how to handle
     * day wrap-arounds (we deliberately don't guess).
     */
    static minutesBetween(fromHHMM, toHHMM) {
        return ScheduleFactors.parseHHMM(toHHMM) - ScheduleFactors.parseHHMM(fromHHMM)
    }

    /**
     * Resolves a dayPattern + optional custom mask into a length-7 array
     * (Mon..Sun). Used by the builder to expand a wave into per-day flights.
     */
    static resolveDayMask(pattern, customMask) {
        switch (pattern) {
            case "daily":     return [1, 1, 1, 1, 1, 1, 1]
            case "weekdays":  return [1, 1, 1, 1, 1, 0, 0]
            case "weekends":  return [0, 0, 0, 0, 0, 1, 1]
            case "custom":    return Array.isArray(customMask) && customMask.length === 7
                ? customMask.map(v => v ? 1 : 0)
                : [1, 1, 1, 1, 1, 1, 1]
            default:          return [1, 1, 1, 1, 1, 1, 1]
        }
    }

    /**
     * True if a time falls inside [start, end] (inclusive). Both args are
     * "HH:MM"; an inverted window (e.g. 22:00–05:00) is treated as wrapping
     * past midnight, which is what hub night-curfew checks usually want.
     */
    static withinWindow(timeHHMM, startHHMM, endHHMM) {
        const t = ScheduleFactors.parseHHMM(timeHHMM)
        const s = ScheduleFactors.parseHHMM(startHHMM)
        const e = ScheduleFactors.parseHHMM(endHHMM)
        if (isNaN(t) || isNaN(s) || isNaN(e)) return false
        if (s <= e) return t >= s && t <= e
        return t >= s || t <= e
    }
}
