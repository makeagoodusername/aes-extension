"use strict"

/**
 * Joins the per-airline aircraftFleet[] (written by content_fleetManagement.js)
 * with per-aircraft state from other AES modules. The result feeds the inline
 * table augmentation + the summary strip on the AS fleet management page.
 *
 * Reads:
 *   - aircraftFlightPlan:state:<server>:<aircraftId>  (location, drafted plan)
 *   - aircraftFlightPlan:draft:<server>:<aircraftId>  (live wave-built draft — used for hub gravity)
 *   - <server><airlineCode>scheduleManagement:index   (live schedules per hub)
 *
 * Returns one RowRecord per aircraft:
 *   {aircraftId, registration, equipment, typeId, hub, gravityHub, derivedFrom,
 *    locIata, locAirportId, locName, lastSeenAt,
 *    hasDraftedPlan, scheduleStatus: "live"|null}
 *
 * Hub semantics: `hub` is the operational center of gravity — the airport
 * that hosts the most non-dismissed departures across the aircraft's drafted
 * legs. Falls back to `locIata` (current parked location) when no draft
 * exists. This keeps the hub stable across single-rotation moves so cards
 * don't flicker as aircraft fly out and back. Callers that specifically need
 * "where is the aircraft right now" should read `locIata`. `derivedFrom`
 * tells the UI which source produced the hub.
 *
 * scheduleStatus is hub-scoped, NOT per-tail — ScheduleStore tracks flights
 * by aircraftType, not aircraftId, so the best signal we can give per row is
 * "does the airline have a saved schedule whose hub equals this aircraft's
 * resolved hub?"
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
        // Drafts are batched alongside state so hub gravity is computed without
        // a second round-trip.
        const stateKeys = fleet.map(a => "aircraftFlightPlan:state:" + server + ":" + a.aircraftId)
        const draftKeys = fleet.map(a => "aircraftFlightPlan:draft:" + server + ":" + a.aircraftId)
        const indexKey = server + airlineCode + "scheduleManagement:index"
        const blob = await chrome.storage.local.get(stateKeys.concat(draftKeys, [indexKey]))

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
            const draftKey = "aircraftFlightPlan:draft:" + server + ":" + a.aircraftId
            const draft = blob[draftKey]

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

            const gravityHub = FleetHubAircraftAggregator._computeGravityHub(draft, locIata)
            const hub = gravityHub || locIata || null
            const derivedFrom = gravityHub ? "gravity" : (locIata ? "location" : null)

            const scheduleStatus = hub && liveHubs.has(hub) ? "live" : null

            return {
                aircraftId:     a.aircraftId,
                registration:   a.registration || "",
                equipment:      a.equipment    || "",
                typeId:         a.typeId       || null,
                hub,
                gravityHub,
                derivedFrom,
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
     * Modal departure airport across the aircraft's non-dismissed draft legs.
     * Tie-break prefers the supplied `preferIata` (typically the current
     * parked location) so that when two airports tie, the result tracks
     * where the aircraft physically is. Final fallback is alphabetical for
     * determinism. Returns null when there are no draft legs.
     */
    static _computeGravityHub(draft, preferIata) {
        if (!draft || typeof draft !== "object") return null
        const flights = Array.isArray(draft.flights) ? draft.flights : []
        if (!flights.length) return null
        const dismissed = (draft.dismissedLegs && typeof draft.dismissedLegs === "object")
            ? draft.dismissedLegs : {}
        const counts = new Map()
        for (const f of flights) {
            if (!f) continue
            const seq = f.seq != null ? String(f.seq) : null
            if (seq && Object.prototype.hasOwnProperty.call(dismissed, seq)) continue
            const orig = typeof f.origin === "string" ? f.origin.toUpperCase() : null
            if (!orig) continue
            counts.set(orig, (counts.get(orig) || 0) + 1)
        }
        if (!counts.size) return null
        let best = null
        let bestCount = -1
        const prefer = preferIata ? String(preferIata).toUpperCase() : null
        for (const [iata, n] of counts) {
            if (n > bestCount) { best = iata; bestCount = n; continue }
            if (n === bestCount) {
                if (prefer && iata === prefer)        best = iata
                else if (prefer && best === prefer)   { /* keep */ }
                else if (iata < best)                 best = iata
            }
        }
        return best
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
