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
 *
 * Override hook: `assign()` accepts an optional `overrides` blob (the
 * shape returned by `AesScheduleColorOverrides.load()`). When present,
 * `colorOf(routeKey)` consults `overrides.byRoute` first and falls back
 * to the deterministic palette. Aircraft- and day-keyed palettes are
 * exposed as static helpers for the alternate color modes the renderer
 * supports — they share the same golden-ratio HSL machinery so the
 * visual rhythm stays consistent across modes.
 */
class FleetScheduleGridColoring {
    static SAT = 62
    static LIGHT = 70

    /**
     * @param {Map<aircraftId, Schedule>} schedules
     * @param {object} opts - {symmetric?: bool, overrides?: object}
     *   - symmetric: if true, JFK→LHR and LHR→JFK share one color.
     *   - overrides: AesScheduleColorOverrides state — read-only here;
     *     resolvers consult `byRoute` so user picks beat the palette.
     */
    static assign(schedules, opts) {
        const o = opts || {}
        const symmetric = !!o.symmetric
        const overrides = o.overrides || null
        const overrideRoutes = (overrides && overrides.byRoute) || {}

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
            overrides,
            colorOf(routeKey) {
                if (overrideRoutes && overrideRoutes[routeKey]) return overrideRoutes[routeKey]
                return colorMap.get(routeKey) || "#ddd"
            },
            edgeOf(routeKey) {
                if (overrideRoutes && overrideRoutes[routeKey]) {
                    return FleetScheduleGridColoring._darken(overrideRoutes[routeKey])
                }
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

    /**
     * Aircraft palette — deterministic HSL per aircraftId, with override
     * lookup against `overrides.byAircraft`. Returns {fill, edge}. The
     * renderer calls this in `colorMode === "aircraft"`.
     */
    static colorOfAircraft(aircraftId, overrides) {
        const id = String(aircraftId == null ? "" : aircraftId)
        const ov = overrides && overrides.byAircraft && overrides.byAircraft[id]
        if (ov) return {fill: ov, edge: FleetScheduleGridColoring._darken(ov)}
        const hue = FleetScheduleGridColoring._hashHue(id)
        return {
            fill: `hsl(${hue},${FleetScheduleGridColoring.SAT}%,${FleetScheduleGridColoring.LIGHT}%)`,
            edge: `hsl(${hue},${Math.min(80, FleetScheduleGridColoring.SAT + 10)}%,40%)`
        }
    }

    /**
     * Day palette — seven distinct hues (Mon..Sun) spread evenly around
     * the wheel so adjacent days are visually distinct. Override lookup
     * against `overrides.byDay` keyed by "0".."6".
     */
    static colorOfDay(dayIdx, overrides) {
        const d = (Number.isInteger(dayIdx) && dayIdx >= 0 && dayIdx < 7) ? dayIdx : 0
        const ov = overrides && overrides.byDay && overrides.byDay[String(d)]
        if (ov) return {fill: ov, edge: FleetScheduleGridColoring._darken(ov)}
        // Anchored at 18° (warm Monday) and stepping ~51° per day so the
        // week traces a full hue rotation without two adjacent days landing
        // on near-identical pastels.
        const hue = (18 + d * 51) % 360
        return {
            fill: `hsl(${hue},${FleetScheduleGridColoring.SAT}%,${FleetScheduleGridColoring.LIGHT}%)`,
            edge: `hsl(${hue},${Math.min(80, FleetScheduleGridColoring.SAT + 10)}%,40%)`
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
        return FleetScheduleGridColoring._hashHue(routeKey)
    }

    static _hashHue(s) {
        let h = 0
        const str = String(s)
        for (let i = 0; i < str.length; i++) {
            h = (h * 31 + str.charCodeAt(i)) >>> 0
        }
        return h % 360
    }

    /**
     * Edge color for a user-picked override (hex or any CSS color). We
     * can't easily darken arbitrary CSS, so just stamp a black-ish
     * outline that contrasts with light fills and stays visible against
     * dark fills too.
     */
    static _darken(_color) {
        return "#1A1612"
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridColoring = FleetScheduleGridColoring
}
