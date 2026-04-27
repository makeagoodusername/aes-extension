"use strict"

/**
 * Track 7 slice 7a — typed factories + back-compat adapter for the AFP
 * page-model layer.
 *
 * The vfp-reader (sibling module) parses the visual-flight-plan Gantt into
 * a rich Schedule with all six block kinds (`flight`, `location`,
 * `maintenance`, `turnaround`, `ready`, `overlap`). This module exposes:
 *
 *   - BLOCK_KINDS                — frozen list of canonical kind strings
 *   - emptySchedule(s, a)        — empty Schedule shell for "no VFP yet"
 *   - legsFromSchedule(schedule) — adapter that produces the LEGACY Leg[]
 *                                  shape (the one host.js:readVisualFlightPlan
 *                                  used to return before 7a) so existing
 *                                  callers don't change.
 *
 * Schema is documented in /Users/jihwan/.claude/plans/reactive-whistling-thompson.md
 * (the Track 7 plan). Single source of truth for the per-aircraft schedule.
 *
 * Storage shape lives in `schedule-store.js` (Slice 7c). The matrix half
 * (`PlanningMatrix`) lands in Slice 7b — until then `Schedule.planningMatrix`
 * is the empty stub returned by `emptyMatrix()`.
 *
 * Defensive: nothing in this module touches the DOM. Pure data factories
 * + an adapter, both safe to call on any page.
 */
;(function () {
    const BLOCK_KINDS = Object.freeze([
        "flight", "location", "maintenance", "turnaround", "ready", "overlap"
    ])

    function emptyMatrix() {
        return {
            isPresent: false,
            segments:  [],
            daysActive: [false, false, false, false, false, false, false]
        }
    }

    function emptySummary() {
        return {
            flightCount:           0,
            weeklyBlockMinutes:    0,
            weeklyMaintenanceMin:  0,
            weeklyTurnaroundMin:   0,
            weeklyReadyMin:        0
        }
    }

    /**
     * Empty Schedule shell. Used by readers that hit a page with no VFP
     * (`.as-panel.visual-flight-plan` absent — e.g. on aircraft with no
     * flights yet) and by consumers that need a defensive null-shape.
     */
    function emptySchedule(server, aircraftId) {
        return {
            schemaVersion:  1,
            server:         String(server     || ""),
            aircraftId:     String(aircraftId || ""),
            scrapedAt:      0,
            hubIata:        null,
            days:           [],
            planningMatrix: emptyMatrix(),
            legs:           [],
            summary:        emptySummary()
        }
    }

    /**
     * Adapter: produce the legacy `Leg[]` shape from a Schedule. Mirrors
     * exactly what host.js:readVisualFlightPlan() returned before Slice 7a
     * so the existing callers (wear-model.js:251, route-candidates.js:570,
     * auto-scheduler/schedule-diff.js:29) see no behaviour change.
     *
     * Field-for-field: {seq, dayIdx, dayName, depTimeLocal, arrTimeLocal,
     * durationMin, origin, destination, flightCode, flightNumber, flightId,
     * flightLink, spansIntoNext, spansFromPrev, raw}.
     *
     * The `flightNumber` alias is preserved because some callers grep for
     * it; consumers that already use `flightCode` see the same value.
     */
    function legsFromSchedule(schedule) {
        if (!schedule || !Array.isArray(schedule.legs)) return []
        return schedule.legs.map(L => ({
            seq:           L.seq,
            dayIdx:        L.dayIdx,
            dayName:       L.dayName,
            depTimeLocal:  L.depTimeLocal,
            arrTimeLocal:  L.arrTimeLocal,
            durationMin:   L.durationMin,
            origin:        L.origin,
            destination:   L.destination,
            flightCode:    L.flightCode,
            flightNumber:  L.flightNumber || L.flightCode,
            flightId:      L.flightId,
            flightLink:    L.flightLink,
            spansIntoNext: !!L.spansIntoNext,
            spansFromPrev: !!L.spansFromPrev,
            raw:           L.raw
        }))
    }

    if (typeof window !== "undefined") {
        window.AesAfpScheduleModel = {
            BLOCK_KINDS,
            emptySchedule,
            emptyMatrix,
            emptySummary,
            legsFromSchedule
        }
    }
})()
