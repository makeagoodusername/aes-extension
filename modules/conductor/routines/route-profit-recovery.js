"use strict"

/**
 * RouteProfitRecovery — bundled routine that turns repeated ProfitDecay
 * fires for the same route into a stateful playbook.
 *
 * State machine:
 *   observing  — first ProfitDecay fire seen for hub:dest
 *   proposing  — 2+ ProfitDecay fires accumulated within 14 days AND
 *                profit hasn't recovered → suggest open RA panel for the
 *                route (no actuator wired in thin K3; surfaces in tile)
 *   completed  — ProfitRecovery scenario fires for the same route OR
 *                signal payload.to ≥ scratch.peakProfit (back to baseline)
 *   expired    — 60 days no qualifying activity
 *
 * Target shape: `<HUB>:<DEST>` (uppercased pair key).
 *
 * Why 14-day proposing window: a single bad week can be noise; two weeks of
 * decay confirms the trend. CONDUCTOR-ROADMAP §IV's ProfitDecay scenario
 * full form uses a 12-week baseline + 3-week EWMA; the routine sits one
 * level above that — N decay scenarios → take action.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesConductorRoutines && window.AesConductorRoutines._defs
        && window.AesConductorRoutines._defs.RouteProfitRecovery) return

    const PROPOSE_AFTER       = 2                         // ProfitDecay fires
    const PROPOSE_WINDOW_MS   = 14 * 24 * 60 * 60 * 1000
    const EXPIRE_AFTER_MS     = 60 * 24 * 60 * 60 * 1000
    const RECOVERY_MARGIN_PCT = 0.95                      // ≥95% of peak counts as recovered

    function _routeKey(payload) {
        if (!payload) return null
        const hub  = payload.hub  ? String(payload.hub).toUpperCase()  : null
        const dest = payload.dest ? String(payload.dest).toUpperCase() : null
        if (!hub || !dest) return null
        return hub + ":" + dest
    }

    const def = {
        id:               "RouteProfitRecovery",
        label:            "Route profit recovery",
        watchScenarios:   ["ProfitDecay", "ProfitRecovery"],
        watchSignalTypes: ["route.profit.changed"],
        spawnFromScenarioFire: true,
        // K4 — reserve the route (hub-dest) while proposing.
        resourceType:     "route",

        resolveTarget: (event) => {
            if (!event) return null
            return _routeKey(event.payload)
        },

        initialState: "observing",
        initialScratch: (event) => {
            const p = (event && event.payload) || {}
            const peak = (typeof p.from === "number" && isFinite(p.from)) ? p.from : null
            return {
                fireCount:    event && event.scenarioId === "ProfitDecay" ? 1 : 0,
                firstFireAt:  Date.now(),
                lastFireAt:   Date.now(),
                peakProfit:   peak,
                latestProfit: typeof p.to === "number" ? p.to : null
            }
        },

        advance: (instance, event, ctx) => {
            const scratch = Object.assign({}, instance.scratch || {})
            const now     = (ctx && ctx.now) || Date.now()
            const p       = (event && event.payload) || {}
            const isScenario = !!event.scenarioId
            const isSignal   = !!event.type && !isScenario

            const incoming = (typeof p.to === "number" && isFinite(p.to)) ? p.to : null
            if (incoming != null) scratch.latestProfit = incoming
            if (typeof p.from === "number" && isFinite(p.from)) {
                if (scratch.peakProfit == null || p.from > scratch.peakProfit) scratch.peakProfit = p.from
            }

            const recoveredViaScenario = (isScenario && event.scenarioId === "ProfitRecovery")
            const recoveredViaThreshold = incoming != null && scratch.peakProfit != null
                && incoming >= scratch.peakProfit * RECOVERY_MARGIN_PCT
                && instance.state !== "observing"
            if ((recoveredViaScenario || recoveredViaThreshold) && instance.state !== "completed") {
                return {
                    state:   "completed",
                    scratch: scratch,
                    reason:  recoveredViaScenario
                        ? "ProfitRecovery scenario fired for " + instance.target
                        : "profit recovered to ~" + Math.round((incoming || 0) / 1000) + "k/wk (≥95% of peak)"
                }
            }

            if (instance.state === "observing") {
                if (isScenario && event.scenarioId === "ProfitDecay") {
                    scratch.fireCount  = (scratch.fireCount || 0) + 1
                    scratch.lastFireAt = now
                    const inWindow = (now - (scratch.firstFireAt || now)) <= PROPOSE_WINDOW_MS
                    if (scratch.fireCount >= PROPOSE_AFTER && inWindow) {
                        return {
                            state:   "proposing",
                            scratch: scratch,
                            reason:  scratch.fireCount + " ProfitDecay fires for "
                                + instance.target + " in 14d — review pricing / service / cmp"
                        }
                    }
                    return {scratch}
                }
                if ((now - (instance.spawnedAt || now)) > EXPIRE_AFTER_MS) {
                    return {state: "expired", scratch, reason: "no qualifying activity for 60 days"}
                }
                return null
            }

            if (instance.state === "proposing") {
                if (isScenario && event.scenarioId === "ProfitDecay") {
                    scratch.fireCount  = (scratch.fireCount || 0) + 1
                    scratch.lastFireAt = now
                    return {scratch}
                }
                if ((now - (instance.lastEventAt || now)) > EXPIRE_AFTER_MS) {
                    return {state: "expired", scratch, reason: "proposal idle 60 days"}
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
    window.AesConductorRoutines.RouteProfitRecovery = def
})()
