"use strict"

/**
 * InternalHubTransfer — routine to manage large regional airlines transferring
 * passengers internally between hubs.
 *
 * Target shape: `<HUB1>:<HUB2>`
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesConductorRoutines && window.AesConductorRoutines._defs
        && window.AesConductorRoutines._defs.InternalHubTransfer) return

    const EXPIRE_AFTER_MS = 60 * 24 * 60 * 60 * 1000

    function _hubPairKey(payload) {
        if (!payload) return null
        const hub  = payload.hub  ? String(payload.hub).toUpperCase()  : null
        const dest = payload.dest ? String(payload.dest).toUpperCase() : null
        if (!hub || !dest) return null
        // Sort hubs alphabetically to make the pair symmetric
        const hubs = [hub, dest].sort()
        return hubs[0] + ":" + hubs[1]
    }

    const def = {
        id: "InternalHubTransfer",
        label: "Internal Hub Transfer",
        watchScenarios: ["ProfitDecay", "ProfitRecovery", "CompetitorEntry", "CompetitorExit"],
        watchSignalTypes: ["route.profit.changed"],
        resolveTarget: (event) => {
            const payload = event.payload || event
            return _hubPairKey(payload)
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
                            reason: "2+ hub-to-hub activity events within window — recommend schedule adjustment to balance internal transfer"
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
                    return { state: "completed", reason: "Hub-to-hub activity stabilised (recovery scenario fired)" }
                }
                if (event.type === "route.profit.changed") {
                    const payload = event.payload || {}
                    const to = Number.isFinite(payload.to) ? payload.to : 0
                    if (newPeak > 0 && to >= newPeak * 0.95) {
                        return { state: "completed", reason: "Hub-to-hub activity stabilised (profit ≥ 95% of peak)" }
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
        window.AesConductorRoutines.InternalHubTransfer = def
})()
