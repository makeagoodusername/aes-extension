"use strict"

/**
 * Auto-Pricing Tier 3 — flight-number resolver.
 *
 * Picks the representative flight-number id for a (server, hub, dest)
 * route so the pricing applier can target the per-leg form at
 * `/app/com/numbers/<flightNumberId>/<legIndex>` instead of the
 * route-level markets-page form. The user opted into the
 * "single representative flight number per route" mode — lowest
 * `flightNumberId` wins (deterministic, stable across runs).
 *
 * Data source — `<server>aircraftFlights<aircraftId>` records populated
 * by content_aircraftFlights.js. Each `flights[]` envelope already carries
 * `flightNumberId`, `originIata`, `destinationIata` (G-slice 4 wiring;
 * see scheduled-decorator.js header). Walking those records is cheaper
 * than scraping; the typical fleet has dozens of aircraft each with
 * dozens of flights, so the scan stays under a few hundred records.
 *
 * Pure-ish: depends on `chrome.storage.local`. No DOM, no network.
 */
class AesRouteAssistantFlightNumberResolver {
    static AIRCRAFT_FLIGHTS_PREFIX_RE = /^(.+)aircraftFlights\d+$/

    /**
     * @param {string} server  — `free1`, `tristar`, etc. Used to filter
     *   `<server>aircraftFlights<id>` keys to this account's server.
     * @param {string} hub     — origin IATA (3 letters).
     * @param {string} dest    — destination IATA (3 letters).
     * @returns {Promise<{flightNumberId: number, legIndex: number,
     *                    source: string, candidates: number[]} | null>}
     */
    static async resolve(server, hub, dest) {
        if (!server || !hub || !dest) return null
        const HUB  = String(hub).toUpperCase()
        const DEST = String(dest).toUpperCase()
        const all = await chrome.storage.local.get(null)
        const seen = new Set()
        for (const key in all) {
            if (key.indexOf(server + "aircraftFlights") !== 0) continue
            const rec = all[key]
            if (!rec || !Array.isArray(rec.flights)) continue
            for (const env of rec.flights) {
                if (!env) continue
                if (env.originIata !== HUB || env.destinationIata !== DEST) continue
                const fnId = env.flightNumberId
                if (typeof fnId === "number" && isFinite(fnId)) seen.add(fnId)
            }
        }
        if (!seen.size) return null
        const sorted = Array.from(seen).sort((a, b) => a - b)
        return {
            flightNumberId: sorted[0],
            legIndex:       0,
            source:         "aircraftFlights",
            candidates:     sorted
        }
    }
}

if (typeof window !== "undefined") {
    window.AesRouteAssistantFlightNumberResolver = AesRouteAssistantFlightNumberResolver
}
