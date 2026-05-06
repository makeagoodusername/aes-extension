"use strict"

/**
 * RegionalFeeder — routine to manage passenger delivery to hub.
 *
 * Target shape: `<HUB>:<DEST>`
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesConductorRoutines && window.AesConductorRoutines._defs
        && window.AesConductorRoutines._defs.RegionalFeeder) return

    const EXPIRE_AFTER_MS = 60 * 24 * 60 * 60 * 1000

    function _routeKey(payload) {
        if (!payload) return null
        const hub  = payload.hub  ? String(payload.hub).toUpperCase()  : null
        const dest = payload.dest ? String(payload.dest).toUpperCase() : null
        if (!hub || !dest) return null
        return hub + ":" + dest
    }

    const def = {
        id: "RegionalFeeder",
        label: "Regional Feeder",
        watchScenarios: ["ProfitDecay", "ProfitRecovery", "CompetitorEntry", "CompetitorExit"], // Observe various route level changes
        watchSignalTypes: ["route.profit.changed"],
        resolveTarget: (event) => {
            const payload = event.payload || event
            return _routeKey(payload)
        },
        initialState: "observing",
        spawnFromScenarioFire: true,

        initialScratch: (event) => {
            const payload = event.payload || event
            const from = Number.isFinite(payload.from) ? payload.from : 0
            return {
                firstFireAt: Date.now(),
                fireCount: 1,
                peakProfit: from
            }
        },

        advance: (instance, event, ctx) => {
            const now = ctx.now
            const s = instance.scratch

            // Update peak profit on any signal
            let newPeak = s.peakProfit || 0
            if (event.type === "route.profit.changed") {
                const payload = event.payload || {}
                const from = Number.isFinite(payload.from) ? payload.from : 0
                const to   = Number.isFinite(payload.to)   ? payload.to   : 0
                if (from > newPeak) newPeak = from
                if (to > newPeak) newPeak = to
            }

            if (instance.state === "observing") {
                if (event.scenarioId && event.scenarioId !== "ProfitRecovery") {
                    const count = (s.fireCount || 0) + 1
                    if (count >= 2) {
                        return {
                            state: "proposing",
                            scratch: { fireCount: count, peakProfit: newPeak },
                            reason: "2+ route activity events within window — recommend schedule adjustment to feed hub"
                        }
                    }
                    return {
                        state: "observing",
                        scratch: { fireCount: count, peakProfit: newPeak }
                    }
                }
            }

            if (instance.state === "proposing") {
                if (event.scenarioId === "ProfitRecovery") {
                    return { state: "completed", reason: "Route activity stabilised (recovery scenario fired)" }
                }
                if (event.type === "route.profit.changed") {
                    const payload = event.payload || {}
                    const to = Number.isFinite(payload.to) ? payload.to : 0
                    if (newPeak > 0 && to >= newPeak * 0.95) {
                        return { state: "completed", reason: "Route activity stabilised (profit ≥ 95% of peak)" }
                    }
                }
            }

            if (now - instance.lastEventAt > EXPIRE_AFTER_MS) {
                return { state: "expired", reason: "60 days without qualifying activity" }
            }

            return { state: instance.state, scratch: { peakProfit: newPeak } }
        }
    }

    if (!window.AesConductorRoutines || typeof window.AesConductorRoutines.register !== "function") {
        window.AesConductorRoutines = { _defs: {}, register(d) { if (d && d.id) this._defs[d.id] = d }, all() { return Object.values(this._defs) } }
    }
        window.AesConductorRoutines.register(def)
        window.AesConductorRoutines.RegionalFeeder = def
})()
