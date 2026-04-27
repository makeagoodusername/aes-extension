"use strict"

/**
 * Joins the per-airline aircraftFleet[] (written by content_fleetManagement.js)
 * with per-aircraft state from other AES modules. The result feeds the inline
 * table augmentation + the summary strip on the AS fleet management page.
 *
 * Reads:
 *   - aircraftFlightPlan:state:<server>:<aircraftId>  (location, drafted plan)
 *   - <server><airlineCode>scheduleManagement:index   (live schedules per hub)
 *
 * Returns one RowRecord per aircraft:
 *   {aircraftId, registration, equipment, typeId, hub,
 *    locIata, locAirportId, locName, lastSeenAt,
 *    hasDraftedPlan, scheduleStatus: "live"|null}
 *
 * scheduleStatus is hub-scoped, NOT per-tail — ScheduleStore tracks flights
 * by aircraftType, not aircraftId, so the best signal we can give per row is
 * "does the airline have a saved schedule whose hub equals this aircraft's
 * current location?" If you later add per-tail bindings to the schedule
 * builder, switch this to a flights[].aircraftId match.
 */
class FleetHubAircraftAggregator {

    /**
     * @param {object} args - {server, airlineCode, fleet: Array}
     * @returns {Promise<Array>} RowRecord[]
     */
    static async enrich(args) {
        const server = String(args.server || "")
        const airlineCode = String(args.airlineCode || "")
        const fleet = Array.isArray(args.fleet) ? args.fleet : []
        if (!fleet.length) return []

        // One storage round-trip for the whole fleet — chrome.storage.local.get
        // returns undefined for missing keys, so unknown aircraftIds are free.
        const stateKeys = fleet.map(a => "aircraftFlightPlan:state:" + server + ":" + a.aircraftId)
        const indexKey = server + airlineCode + "scheduleManagement:index"
        const blob = await chrome.storage.local.get(stateKeys.concat([indexKey]))

        const liveHubs = new Set()
        const idx = blob[indexKey]
        if (Array.isArray(idx)) {
            for (const e of idx) {
                if (e && e.hub) liveHubs.add(String(e.hub).toUpperCase())
            }
        }

        return fleet.map(a => {
            const stateKey = "aircraftFlightPlan:state:" + server + ":" + a.aircraftId
            const state = blob[stateKey]

            const locIata = state && typeof state.currentLocationIata === "string"
                ? state.currentLocationIata.toUpperCase()
                : null
            const locAirportId = state && typeof state.currentLocationAirportId === "number" && isFinite(state.currentLocationAirportId)
                ? state.currentLocationAirportId
                : null
            const locName = state && typeof state.currentLocationName === "string" ? state.currentLocationName : null
            const lastSeenAt = state && typeof state.lastSeenAt === "number" && isFinite(state.lastSeenAt)
                ? state.lastSeenAt
                : null
            const hasDraftedPlan = !!(state && Array.isArray(state.draftedPlan) && state.draftedPlan.length > 0)

            const scheduleStatus = locIata && liveHubs.has(locIata) ? "live" : null

            return {
                aircraftId:     a.aircraftId,
                registration:   a.registration || "",
                equipment:      a.equipment    || "",
                typeId:         a.typeId       || null,
                hub:            locIata        || null,
                locIata,
                locAirportId,
                locName,
                lastSeenAt,
                hasDraftedPlan,
                scheduleStatus
            }
        })
    }

    /**
     * Returns the most-frequent hub IATA across the row set, used as a
     * fallback for the R-button when an aircraft's own location is unknown.
     * Falls back to null when no aircraft has a known hub yet.
     */
    static fallbackHub(rows) {
        const counts = new Map()
        for (const r of rows) {
            if (!r.hub) continue
            counts.set(r.hub, (counts.get(r.hub) || 0) + 1)
        }
        let best = null
        let bestCount = 0
        for (const [hub, n] of counts) {
            if (n > bestCount) { best = hub; bestCount = n }
        }
        return best
    }
}

if (typeof window !== "undefined") {
    window.FleetHubAircraftAggregator = FleetHubAircraftAggregator
}
