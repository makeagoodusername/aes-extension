/**
 * Loads the user's owned fleet from chrome.storage.local for use by the route
 * assistant.
 *
 * `content_fleetManagement.js` writes one record per airline at
 *   chrome.storage.local["<server><airlineCode>aircraftFleet"]
 * shaped:
 *   {server, type:"aircraftFleet", airline, fleet: [{registration, equipment,
 *    typeId, age, maintanance, aircraftId, ...}, ...]}
 *
 * `typeId` is a Phase 2 addition; older records may have it `null`. The panel
 * surfaces a banner asking the user to revisit /app/fleets to backfill, but
 * the rest of the loader still works — typeless aircraft just appear as
 * "(unknown spec)" in the picker.
 *
 * Airline disambiguation: a multi-airline account has multiple
 * <server>*aircraftFleet keys. The caller passes the airline code already
 * resolved by the panel's `_loadOwnSchedule()` (which pinned by hub matches).
 * Without that, we fall back to the first matching key + a flag the panel
 * uses to surface a warning.
 */
class RouteAssistantFleetStore {
    /**
     * @param {string} server
     * @param {string|null} airlineCode preferred airline (from ownSchedule).
     * @returns {Promise<{aircraft, byType, airline, ambiguous, server}>}
     *   aircraft  — flat array of fleet records.
     *   byType    — Map<typeId, {typeId, typeName, count, registrations[]}>
     *   airline   — airline code we settled on, or null.
     *   ambiguous — true when more than one fleet key matched and we picked
     *               one without a schedule hint.
     */
    static async loadFleet(server, airlineCode) {
        if (!server) return RouteAssistantFleetStore._empty(null, false, server)

        if (airlineCode) {
            const directKey = String(server) + String(airlineCode) + "aircraftFleet"
            try {
                const direct = await chrome.storage.local.get([directKey])
                const rec = direct && direct[directKey]
                if (rec && rec.type === "aircraftFleet" && Array.isArray(rec.fleet)) {
                    return RouteAssistantFleetStore._fromRecord(rec, false, server)
                }
            } catch (_) { /* fall back to legacy scan below */ }
        }

        const all = await chrome.storage.local.get(null)

        const matching = []
        const suffix = "aircraftFleet"
        for (const key in all) {
            if (key.indexOf(server) !== 0) continue
            if (key.lastIndexOf(suffix) !== key.length - suffix.length) continue
            const rec = all[key]
            if (!rec || rec.type !== "aircraftFleet" || !Array.isArray(rec.fleet)) continue
            matching.push(rec)
        }
        if (!matching.length) return RouteAssistantFleetStore._empty(null, false, server)

        // Prefer the record whose airline matches the schedule's airline.
        let chosen = null
        let ambiguous = false
        if (airlineCode) {
            chosen = matching.find(r =>
                RouteAssistantFleetStore._sameAirline(r.airline, airlineCode)) || null
        }
        if (!chosen) {
            // Pick the airline with the largest fleet — usually the user's
            // primary. Mark ambiguous so the panel can warn.
            chosen = matching.slice().sort((a, b) => b.fleet.length - a.fleet.length)[0]
            ambiguous = matching.length > 1
        }

        return RouteAssistantFleetStore._fromRecord(chosen, ambiguous, server)
    }

    static _fromRecord(chosen, ambiguous, server) {
        if (!chosen || !Array.isArray(chosen.fleet)) {
            return RouteAssistantFleetStore._empty(null, false, server)
        }
        const aircraft = chosen.fleet.slice()
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
        // Finalise: convert age sums to averages, drop the work fields.
        for (const slot of byType.values()) {
            slot.avgAge = slot._ageCount > 0 ? Math.round((slot._ageSum / slot._ageCount) * 10) / 10 : null
            delete slot._ageSum
            delete slot._ageCount
        }

        return {
            aircraft:  aircraft,
            byType:    byType,
            airline:   chosen.airline || null,
            ambiguous: ambiguous,
            server:    server
        }
    }

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
        const aa = RouteAssistantFleetStore._normaliseAirlineKey(a)
        const bb = RouteAssistantFleetStore._normaliseAirlineKey(b)
        return !!aa && aa === bb
    }

    static _normaliseAirlineKey(value) {
        return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "")
    }

    /**
     * Returns the unique typeIds present in the fleet, skipping aircraft whose
     * typeId hasn't been backfilled yet.
     */
    static typeIdsIn(fleet) {
        const ids = new Set()
        for (const a of (fleet && fleet.aircraft) || []) {
            if (a && a.typeId) ids.add(a.typeId)
        }
        return Array.from(ids)
    }

    /**
     * True if any aircraft in the fleet still lacks a typeId — used to gate
     * the "visit /app/fleets to refresh" banner.
     */
    static hasMissingTypeIds(fleet) {
        for (const a of (fleet && fleet.aircraft) || []) {
            if (a && !a.typeId) return true
        }
        return false
    }

    static findByRegistration(fleet, registration) {
        if (!fleet || !registration) return null
        return (fleet.aircraft || []).find(a => a && a.registration === registration) || null
    }

    static slotForTypeId(fleet, typeId) {
        if (!fleet || !typeId || !fleet.byType) return null
        return fleet.byType.get(typeId) || null
    }

    /**
     * Type slots eligible for spec lookup — i.e. slots whose typeId has been
     * captured. Older fleet records may have aircraft without typeIds; those
     * surface via the migration banner instead of the picker.
     */
    static activeTypeSlots(fleet) {
        if (!fleet || !fleet.byType) return []
        return Array.from(fleet.byType.values()).filter(s => s.typeId)
    }
}
