"use strict"

/**
 * ScrapeOrchestratorEnumerators — pure functions that read
 * chrome.storage.local and return target lists for each fan-out
 * phase. Returning `[]` is the cold-start signal — the corresponding
 * phase produces no jobs.
 */

class ScrapeOrchestratorEnumerators {
    /**
     * Hubs the airline operates at. Sources, in order:
     *   1. Distinct `aircraftFleet.fleet[].location` values (canonical).
     *   2. Distinct `aircraftFlights[].originIata/destinationIata` values.
     *   3. RA settings `recentHubs` if no fleet/flight records yet.
     */
    static async enumerateHubs(server, airline) {
        const hubs = new Set()

        const all = await chrome.storage.local.get(null)
        const fleetSuffix = "aircraftFleet"
        const fleetCandidates = []
        for (const k in all) {
            if (k.indexOf(server) !== 0) continue
            if (k.lastIndexOf(fleetSuffix) !== k.length - fleetSuffix.length) continue
            const rec = all[k]
            if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) continue
            fleetCandidates.push(rec)
            if (!airline || ScrapeOrchestratorEnumerators._sameAirline(rec.airline, airline)) {
                ScrapeOrchestratorEnumerators._collectHubsFromFleet(rec.fleet, hubs)
            }
        }

        if (!hubs.size && fleetCandidates.length) {
            const chosen = fleetCandidates.slice().sort((a, b) => b.fleet.length - a.fleet.length)[0]
            ScrapeOrchestratorEnumerators._collectHubsFromFleet(chosen.fleet, hubs)
        }

        if (!hubs.size) {
            const flightCandidates = []
            for (const k in all) {
                if (server && k.indexOf(server) !== 0) continue
                if (k.indexOf("aircraftFlights") < 0) continue
                const rec = all[k]
                if (!rec || rec.type !== "aircraftFlights" || !Array.isArray(rec.flights)) continue
                if (server && rec.server && String(rec.server) !== String(server)) continue
                flightCandidates.push(rec)
                if (!airline || ScrapeOrchestratorEnumerators._sameAirline(rec.airline, airline)) {
                    ScrapeOrchestratorEnumerators._collectHubsFromFlights(rec.flights, hubs)
                }
            }
            if (!hubs.size) {
                for (const rec of flightCandidates) {
                    ScrapeOrchestratorEnumerators._collectHubsFromFlights(rec.flights, hubs)
                }
            }
        }

        if (!hubs.size) {
            // RA stores recentHubs under settings.routeAssistant.recentHubs.
            const recent = (all.settings && all.settings.routeAssistant && all.settings.routeAssistant.recentHubs) || []
            for (const h of recent) if (h) hubs.add(String(h).toUpperCase())
        }

        return Array.from(hubs).sort()
    }

    static _collectHubsFromFleet(fleet, set) {
        for (const a of fleet) {
            if (!a) continue
            const loc = a.location || a.hub || a.station
            if (loc) set.add(String(loc).toUpperCase())
        }
    }

    static _collectHubsFromFlights(flights, set) {
        for (const f of (flights || [])) {
            if (!f) continue
            const origin = f.originIata || f.origin || f.from
            const dest = f.destinationIata || f.destIata || f.destination || f.to
            if (origin) set.add(String(origin).toUpperCase())
            if (dest) set.add(String(dest).toUpperCase())
        }
    }

    static _sameAirline(a, b) {
        const aa = ScrapeOrchestratorEnumerators._normaliseAirlineKey(a)
        const bb = ScrapeOrchestratorEnumerators._normaliseAirlineKey(b)
        return !!aa && aa === bb
    }

    static _normaliseAirlineKey(value) {
        return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    }

    /**
     * Aircraft roster — array of `{aircraftId, registration, equipment}`.
     */
    static async enumerateAircraft(server, airline) {
        const all = await chrome.storage.local.get(null)
        const fleetSuffix = "aircraftFleet"
        let chosen = null
        let bestSize = 0
        for (const k in all) {
            if (k.indexOf(server) !== 0) continue
            if (k.lastIndexOf(fleetSuffix) !== k.length - fleetSuffix.length) continue
            const rec = all[k]
            if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) continue
            if (airline && rec.airline && String(rec.airline) === String(airline)) {
                chosen = rec; break
            }
            if (rec.fleet.length > bestSize) { chosen = rec; bestSize = rec.fleet.length }
        }
        if (!chosen) return []
        const out = []
        for (const a of chosen.fleet) {
            if (a && a.aircraftId) {
                out.push({
                    aircraftId:   String(a.aircraftId),
                    registration: a.registration || "",
                    equipment:    a.equipment || ""
                })
            }
        }
        return out
    }

    /**
     * Returns every cached (hub, dest) pair across every per-hub
     * topRoutes record. Used as the universe for Phase 4 fan-out.
     */
    static async enumerateAllRoutes(server) {
        const all = await chrome.storage.local.get(null)
        const prefix = "routeAssistant:topRoutes:"
        const seen = new Set()
        const out = []
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const hubPart = k.substring(prefix.length)
            if (!hubPart || hubPart.indexOf(":") >= 0) continue
            const blob = all[k]
            if (!blob || !Array.isArray(blob.rows)) continue
            // Tolerant server filter: skip blobs from another server, but
            // accept legacy blobs that pre-date the `server` field.
            if (server && blob.server && String(blob.server) !== String(server)) continue
            const hub = String(blob.hub || hubPart).toUpperCase()
            for (const r of blob.rows) {
                const dest = r && (r.destIata || r.dest)
                if (!dest) continue
                const D = String(dest).toUpperCase()
                const pair = hub + "-" + D
                if (seen.has(pair)) continue
                seen.add(pair)
                out.push({hub: hub, dest: D})
            }
        }
        return out
    }

    /**
     * Unique competitor enterprise IDs harvested from the markets-page
     * competitor records. Each markets record carries a list of
     * `competitors[].enterpriseId` (or similar — see HANDOVER §4 for
     * the exact field name; we tolerate variations).
     */
    static async enumerateCompetitorIds(server) {
        const all = await chrome.storage.local.get(null)
        const prefix = "routeAssistant:markets:competitors:"
        const seen = new Set()
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (!rec) continue
            if (server && rec.server && String(rec.server) !== String(server)) continue
            const list = rec.competitors || rec.rows || rec.airlines || []
            if (!Array.isArray(list)) continue
            for (const c of list) {
                const id = c && (c.enterpriseId || c.id || c.airlineId)
                if (id != null) seen.add(String(id))
            }
        }
        return Array.from(seen).sort()
    }

    /**
     * IATAs to scrape via flightsfrom.com. Default = hubs ∪ destinations
     * the user already has cached, which keeps Phase 6 from blowing up
     * to thousands of airports.
     */
    static async enumerateAirportsForFlightsFrom(hubs, routes) {
        const seen = new Set()
        for (const h of (hubs || [])) seen.add(String(h).toUpperCase())
        for (const r of (routes || [])) {
            if (r.hub) seen.add(String(r.hub).toUpperCase())
            if (r.dest) seen.add(String(r.dest).toUpperCase())
        }
        return Array.from(seen).sort()
    }
}

if (typeof window !== "undefined") {
    window.ScrapeOrchestratorEnumerators = ScrapeOrchestratorEnumerators
}
