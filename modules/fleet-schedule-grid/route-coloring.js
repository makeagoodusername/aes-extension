"use strict"

/**
 * Fleet Schedule Grid — route coloring.
 *
 * Pure assigner: given a Map<aircraftId, Schedule>, produce a stable color
 * per (origin → destination) route plus aggregate stats. The colors drive
 * both the per-leg block fill on the grid and the legend entries below.
 *
 * Direction is significant: JFK→LHR and LHR→JFK get adjacent hues (sibling
 * routes) so the eye groups them visually but can still tell them apart.
 *
 * Hue assignment is deterministic from the route key (lex-sorted O+D), so
 * a given route always lands on the same hue regardless of how many other
 * routes are in the fleet — no flicker on re-paint.
 *
 * Saturation/lightness are tuned for the AS panel skin: light enough that
 * a black tail label reads on top, saturated enough that ten routes don't
 * blur into one tan smear.
 */
class FleetScheduleGridColoring {
    static SAT = 62
    static LIGHT = 70

    /**
     * @param {Map<aircraftId, Schedule>} schedules
     * @param {object} opts - {symmetric: bool} — if true, JFK→LHR and
     *   LHR→JFK share the same color (treats route as undirected pair).
     *   Default false.
     */
    static assign(schedules, opts) {
        const o = opts || {}
        const symmetric = !!o.symmetric

        // First pass — count flights and aircraft per route key.
        const stats = new Map() // routeKey -> {origin, dest, count, aircraft:Set}
        if (schedules && typeof schedules.forEach === "function") {
            schedules.forEach((schedule, aircraftId) => {
                const legs = (schedule && Array.isArray(schedule.legs)) ? schedule.legs : []
                for (const leg of legs) {
                    if (!leg.origin || !leg.destination) continue
                    const key = symmetric
                        ? FleetScheduleGridColoring._symKey(leg.origin, leg.destination)
                        : leg.origin + "→" + leg.destination
                    let s = stats.get(key)
                    if (!s) {
                        s = {key, origin: leg.origin, dest: leg.destination, count: 0, aircraft: new Set()}
                        stats.set(key, s)
                    }
                    s.count++
                    s.aircraft.add(String(aircraftId))
                }
            })
        }

        // Second pass — build the color table. Sort by count desc so the
        // highest-volume routes get the easiest-to-distinguish hues at the
        // start of the spectrum (the eye discriminates better in mid-range).
        const sorted = Array.from(stats.values()).sort((a, b) => b.count - a.count)
        const colorMap = new Map()
        const routes = []

        for (let i = 0; i < sorted.length; i++) {
            const s = sorted[i]
            const hue = FleetScheduleGridColoring._hueFor(s.key, i, sorted.length)
            const color     = `hsl(${hue},${FleetScheduleGridColoring.SAT}%,${FleetScheduleGridColoring.LIGHT}%)`
            const colorEdge = `hsl(${hue},${Math.min(80, FleetScheduleGridColoring.SAT + 10)}%,40%)`
            const colorSoft = `hsla(${hue},${FleetScheduleGridColoring.SAT}%,${FleetScheduleGridColoring.LIGHT}%,0.30)`
            colorMap.set(s.key, color)
            routes.push({
                key:           s.key,
                origin:        s.origin,
                destination:   s.dest,
                count:         s.count,
                aircraftCount: s.aircraft.size,
                color, colorEdge, colorSoft, hue
            })
        }

        return {
            routes,
            symmetric,
            colorOf(routeKey) { return colorMap.get(routeKey) || "#ddd" },
            edgeOf(routeKey) {
                const r = routes.find(rr => rr.key === routeKey)
                return r ? r.colorEdge : "#888"
            },
            keyOf(leg) {
                if (!leg || !leg.origin || !leg.destination) return null
                return symmetric
                    ? FleetScheduleGridColoring._symKey(leg.origin, leg.destination)
                    : leg.origin + "→" + leg.destination
            }
        }
    }

    /** Symmetric pair key — alphabetically ordered so A↔B === B↔A. */
    static _symKey(a, b) {
        return a <= b ? (a + "↔" + b) : (b + "↔" + a)
    }

    /**
     * Deterministic hue (0..360) for a route key. Spread by golden-ratio
     * rotation so adjacent indices land on visually distinct hues, but a
     * given key always returns the same hue regardless of fleet size.
     *
     * Falls back to a hash-of-key if more than 30 routes — beyond that the
     * spectrum is saturated and you want stability over uniqueness.
     */
    static _hueFor(routeKey, index, total) {
        if (total <= 30) {
            // 137.508 = golden angle; first 30 hues are visually distinct.
            return Math.round((index * 137.508) % 360)
        }
        let h = 0
        for (let i = 0; i < routeKey.length; i++) {
            h = (h * 31 + routeKey.charCodeAt(i)) >>> 0
        }
        return h % 360
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridColoring = FleetScheduleGridColoring
}
