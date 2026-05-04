"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

function installLocation() {
    global.location = {search: ""}
}

;(async function main() {
    await it("creates a round-trip flight plan for an idle new aircraft", async () => {
        installLocation()
        const scoringWin = loadModule("modules/strategy/scoring-primitives.js", {})
        const orchestratorCalls = []
        const win = loadModule("modules/strategy/route-creation-applier.js", {
            AesStrategyScoring: scoringWin.AesStrategyScoring,
            AesAfpFleetApplyOrchestrator: {
                async start(payload) {
                    orchestratorCalls.push(payload)
                    return {
                        ok: true,
                        perAircraft: [{aircraftId: "NEW1", ok: true, succeeded: 4, failed: 0}],
                        totalSucceeded: 4,
                        totalFailed: 0
                    }
                }
            }
        })

        const result = await win.AesStrategyRouteCreationApplier.apply({
            hub: "JFK",
            dest: "BOS",
            distanceKm: 300,
            proposedTypeIds: [737],
            proposedFrequency: 2,
            proposedPricePct: 105
        }, {
            server: "free1",
            fleet: [{
                aircraftId: "NEW1",
                typeId: 737,
                currentLocationIata: "JFK",
                cruiseSpeedKmh: 800,
                wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 0}
            }]
        }, {server: "free1"})

        assert.strictEqual(result.ok, true)
        assert.strictEqual(result.aircraft.aircraftId, "NEW1")
        assert.strictEqual(result.legs.length, 4)
        assert.strictEqual(orchestratorCalls.length, 1)
        assert.strictEqual(orchestratorCalls[0].ctx.server, "free1")
        assert.strictEqual(orchestratorCalls[0].source, "aesStrategy-routeCreation")
        assert.strictEqual(orchestratorCalls[0].runs[0].aircraftId, "NEW1")

        const legs = orchestratorCalls[0].runs[0].legs
        assert.strictEqual(legs[0].origin, "JFK")
        assert.strictEqual(legs[0].destination, "BOS")
        assert.strictEqual(legs[1].origin, "BOS")
        assert.strictEqual(legs[1].destination, "JFK")
        assert.strictEqual(legs[0].pricePct, 105)
        assert.strictEqual(legs[0].depTime, legs[0].depTimeLocal)
        assert.match(legs[0].depTime, /^\d{2}:\d{2}$/)
    })

    await it("prefers the right type at the hub before fallback aircraft", async () => {
        installLocation()
        const scoringWin = loadModule("modules/strategy/scoring-primitives.js", {})
        const win = loadModule("modules/strategy/route-creation-applier.js", {
            AesStrategyScoring: scoringWin.AesStrategyScoring
        })
        const pick = win.AesStrategyRouteCreationApplier.pickAircraft({
            hub: "JFK",
            proposedTypeIds: [737]
        }, {
            fleet: [
                {aircraftId: "WRONG-HUB", typeId: 737, currentLocationIata: "ATL", wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 0}},
                {aircraftId: "RIGHT-HUB", typeId: 737, currentLocationIata: "JFK", wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 60}},
                {aircraftId: "WRONG-TYPE", typeId: 320, currentLocationIata: "JFK", wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 0}}
            ]
        })

        assert.strictEqual(pick && pick.aircraftId, "RIGHT-HUB")
    })

    summary("route-creation-applier")
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
