"use strict"

/**
 * MaintenanceRebalance — bundled routine that turns repeated
 * MaintenanceWatch fires for the same tail into a stateful playbook.
 *
 * State machine:
 *   observing  — one fire seen; waiting for follow-ups or recovery
 *   proposing  — 3+ MaintenanceWatch fires accumulated within 14 days
 *                AND ratio still below floor → suggest insertion of an MX
 *                block (no actuator wired in thin K3; surfaces in tile)
 *   completed  — ratio recovered to ≥ floor + 5 (any state can transition)
 *   expired    — no qualifying activity for 30 days (auto-cleanup)
 *
 * Actuator integration is deferred — when the user manually inserts an MX
 * block, the maintenance scraper writes a fresh ratio reading, the engine
 * sees ratio recovery, and the routine completes. K3.1 will wire a real
 * suggest-with-Apply affordance via the AFP form-driver path.
 *
 * The "proposing" state currently surfaces visibly in the Conductor tile
 * with rationale; the user reads it, decides, acts manually. That alone
 * proves the routine architecture end-to-end.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorRoutines) {
        if (window.AesConductorRoutines && window.AesConductorRoutines.MaintenanceRebalance) return
    }

    const RATIO_FLOOR     = 105
    const RATIO_RECOVER   = 110
    const PROPOSE_AFTER   = 3              // fires
    const EXPIRE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

    const def = {
        id:               "MaintenanceRebalance",
        label:            "Maintenance rebalance",
        watchScenarios:   ["MaintenanceWatch"],
        watchSignalTypes: ["maintenance.ratio.changed"],
        spawnFromScenarioFire: true,

        resolveTarget: (event) => {
            if (!event) return null
            if (event.scenarioId) {
                return (event.payload && event.payload.aircraftId) || null
            }
            if (event.type === "maintenance.ratio.changed") {
                return (event.payload && event.payload.aircraftId) || null
            }
            return null
        },

        initialState: "observing",
        initialScratch: (event) => ({
            fireCount:      event && event.scenarioId ? 1 : 0,
            firstFireAt:    Date.now(),
            lastFireAt:     Date.now(),
            lastRatio:      (event && event.payload && (event.payload.ratio != null ? event.payload.ratio : event.payload.to)) || null
        }),

        advance: (instance, event, ctx) => {
            const scratch = Object.assign({}, instance.scratch || {})
            const now     = (ctx && ctx.now) || Date.now()
            const isScenario = !!event.scenarioId
            const isSignal   = !!event.type && !isScenario

            const newRatio = (() => {
                if (!event || !event.payload) return null
                if (typeof event.payload.ratio === "number") return event.payload.ratio
                if (typeof event.payload.to    === "number") return event.payload.to
                return null
            })()
            if (newRatio != null) scratch.lastRatio = newRatio

            if (newRatio != null && newRatio >= RATIO_RECOVER && instance.state !== "completed") {
                return {
                    state:   "completed",
                    scratch: scratch,
                    reason:  "ratio recovered to " + newRatio.toFixed(1) + "% (≥ " + RATIO_RECOVER + "%)"
                }
            }

            if (instance.state === "observing") {
                if (isScenario && event.scenarioId === "MaintenanceWatch") {
                    scratch.fireCount  = (scratch.fireCount || 0) + 1
                    scratch.lastFireAt = now
                    if (scratch.fireCount >= PROPOSE_AFTER) {
                        return {
                            state:   "proposing",
                            scratch: scratch,
                            reason:  scratch.fireCount + " MaintenanceWatch fires for "
                                + instance.target + " — recommending MX block insertion"
                        }
                    }
                    return {scratch}
                }
                if ((now - (instance.spawnedAt || now)) > EXPIRE_AFTER_MS) {
                    return {state: "expired", scratch, reason: "no qualifying activity for 30 days"}
                }
                return null
            }

            if (instance.state === "proposing") {
                if (isScenario && event.scenarioId === "MaintenanceWatch") {
                    scratch.fireCount  = (scratch.fireCount || 0) + 1
                    scratch.lastFireAt = now
                    return {scratch}
                }
                if ((now - (instance.lastEventAt || now)) > EXPIRE_AFTER_MS) {
                    return {state: "expired", scratch, reason: "proposal idle 30 days"}
                }
                return null
            }

            return null
        }
    }

    // Registry shape lives in modules/conductor/routines/_registry.js, which
    // the manifest loads before this file. Defensive fallback in case the
    // load-order assumption is ever broken — keeps this file self-healing.
    if (!window.AesConductorRoutines || typeof window.AesConductorRoutines.register !== "function") {
        window.AesConductorRoutines = {
            _defs: {},
            register(d) { if (d && d.id) this._defs[d.id] = d },
            all() { return Object.values(this._defs) }
        }
    }
    window.AesConductorRoutines.register(def)
    window.AesConductorRoutines.MaintenanceRebalance = def
})()
