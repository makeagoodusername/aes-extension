"use strict"

/**
 * Track 8 slice 8d — single read facade for the per-airline aircraft
 * fleet roster.
 *
 * The roster is written by `content_fleetManagement.js` on each visit
 * to /app/fleets, keyed:
 *
 *   chrome.storage.local["<server><airlineCode>aircraftFleet"] = {
 *     server, type:"aircraftFleet", airline,
 *     fleet: [{registration, equipment, typeId, age, maintanance, aircraftId, …}]
 *   }
 *
 * Three readers exist today, all reading that key directly: Fleet Hub
 * overlay, RouteAssistantFleetStore, and AFP's spec-resolver. This
 * facade unifies them. Logic is inlined (not delegated to
 * RouteAssistantFleetStore) so consumers on pages where RA isn't loaded
 * — e.g. /app/fleets/aircraft/<id>/0 — can still read the roster.
 *
 * Usage:
 *   const fleet = await AesFleetRoster.load(server, airlineCode)
 *   const a = AesFleetRoster.findByRegistration(fleet, "G-XYZ1")
 *   const a2 = AesFleetRoster.findByAircraftId(fleet, "12345")
 *   const fleet2 = await AesFleetRoster.loadCurrent()    // server+airline auto-resolved
 *
 * Output shape mirrors `RouteAssistantFleetStore.loadFleet()`:
 *   {aircraft, byType, airline, ambiguous, server}
 *
 * Module-prefix isolation (HANDOVER §10): only reads keys ending in
 * `aircraftFleet`. Doesn't touch `aircraftFlightPlan:*` or
 * `routeAssistant:*` namespaces.
 */
class AesFleetRoster {
    static SUFFIX = "aircraftFleet"

    /**
     * Load the fleet for one (server, airlineCode). Pass `airlineCode = null`
     * to fall back to the largest fleet on that server (with `ambiguous: true`
     * when more than one airline is owned).
     */
    static async load(server, airlineCode) {
        if (!server) return AesFleetRoster._empty(null, false, server)
        const all = await chrome.storage.local.get(null)

        const matching = []
        for (const key in all) {
            if (key.indexOf(server) !== 0) continue
            if (key.lastIndexOf(AesFleetRoster.SUFFIX) !== key.length - AesFleetRoster.SUFFIX.length) continue
            const rec = all[key]
            if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) continue
            matching.push(rec)
        }
        if (!matching.length) return AesFleetRoster._empty(null, false, server)

        let chosen = null
        let ambiguous = false
        if (airlineCode) {
            chosen = matching.find(r =>
                AesFleetRoster._sameAirline(r.airline, airlineCode)) || null
        }
        if (!chosen) {
            chosen = matching.slice().sort((a, b) => b.fleet.length - a.fleet.length)[0]
            ambiguous = matching.length > 1
        }

        return AesFleetRoster._build(chosen, ambiguous, server)
    }

    /**
     * Convenience: resolve `(server, airlineCode)` from the current AS
     * page via `helpers.js`'s `AES.getServer()` / `AES.getAirlineIdentity()`,
     * then load. Returns the empty shape when identity can't be resolved
     * (e.g. on a page that hasn't rendered the navbar yet).
     */
    static async loadCurrent() {
        if (typeof AES === "undefined") return AesFleetRoster._empty(null, false, null)
        let server = null
        let airlineCode = null
        try { server = AES.getServer ? AES.getServer() : null } catch (_) { /* noop */ }
        try { airlineCode = AES.getAirlineIdentity ? AES.getAirlineIdentity() : null } catch (_) { /* noop */ }
        return AesFleetRoster.load(server || "", airlineCode || null)
    }

    static findByRegistration(fleet, registration) {
        if (!fleet || !registration) return null
        return (fleet.aircraft || []).find(a => a && a.registration === registration) || null
    }

    static findByAircraftId(fleet, aircraftId) {
        if (!fleet || aircraftId == null) return null
        const want = String(aircraftId)
        return (fleet.aircraft || []).find(a => a && String(a.aircraftId) === want) || null
    }

    /** typeIds present in the fleet (skips aircraft without a backfilled typeId). */
    static typeIdsIn(fleet) {
        const ids = new Set()
        for (const a of (fleet && fleet.aircraft) || []) {
            if (a && a.typeId) ids.add(a.typeId)
        }
        return Array.from(ids)
    }

    static hasMissingTypeIds(fleet) {
        for (const a of (fleet && fleet.aircraft) || []) {
            if (a && !a.typeId) return true
        }
        return false
    }

    /* ─────── internals ─────── */

    static _empty(airline, ambiguous, server) {
        return {
            aircraft:  [],
            byType:    new Map(),
            airline:   airline,
            ambiguous: ambiguous,
            server:    server || null
        }
    }

    static _sameAirline(a, b) {
        const aa = AesFleetRoster._normaliseAirlineKey(a)
        const bb = AesFleetRoster._normaliseAirlineKey(b)
        return !!aa && aa === bb
    }

    static _normaliseAirlineKey(value) {
        return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    }

    static _build(rec, ambiguous, server) {
        const aircraft = rec.fleet.slice()
        const byType = new Map()
        for (const a of aircraft) {
            if (!a) continue
            const key = a.typeId || ("name:" + (a.equipment || ""))
            const slot = byType.get(key) || {
                typeId:        a.typeId || null,
                typeName:      a.equipment || "(unknown)",
                count:         0,
                registrations: [],
                _ageSum:       0,
                _ageCount:     0
            }
            slot.count++
            if (a.registration) slot.registrations.push(a.registration)
            if (typeof a.age === "number" && isFinite(a.age) && a.age >= 0) {
                slot._ageSum   += a.age
                slot._ageCount += 1
            }
            byType.set(key, slot)
        }
        for (const slot of byType.values()) {
            slot.avgAge = slot._ageCount > 0
                ? Math.round((slot._ageSum / slot._ageCount) * 10) / 10
                : null
            delete slot._ageSum
            delete slot._ageCount
        }
        return {
            aircraft:  aircraft,
            byType:    byType,
            airline:   rec.airline || null,
            ambiguous: ambiguous,
            server:    server
        }
    }
}

if (typeof window !== "undefined") {
    window.AesFleetRoster = AesFleetRoster
}
