"use strict"

const {loadAfpModule, resetGlobals, it, summary, assert} = require("./_helpers")

console.log("=== profit scheduling ===")

resetGlobals()
loadAfpModule("modules/schedule-management/range-buckets.js", ["ScheduleFactors"])
global.ScheduleFactors = window.ScheduleFactors
loadAfpModule("modules/route-assistant/wave-slot-scorer.js", ["RouteAssistantWaveSlotScorer"])
global.RouteAssistantWaveSlotScorer = window.RouteAssistantWaveSlotScorer
loadAfpModule("modules/schedule-management/schedule-builder.js", ["ScheduleBuilder"])

function preset() {
    return {
        id: "profit",
        name: "Profit banks",
        hub: "JFK",
        factors: Object.assign({}, window.ScheduleFactors.defaultFactors(), {
            minTransferMinutes: 45
        }),
        waves: [{
            id: "w1",
            label: "Morning",
            arrivalWindow: {start: "06:00", end: "07:00"},
            departureWindow: {start: "08:00", end: "09:00"},
            composition: {shortHaul: 2, mediumHaul: 0, longHaul: 0}
        }]
    }
}

function route(destination, profitPerWeek) {
    return {
        destination,
        distanceNm: 300,
        aircraftType: "Test Jet",
        _scoredRow: {
            destIata: destination,
            profitPerWeek,
            paxScore: 10,
            cargoScore: 8,
            aircraftFit: "optimal"
        }
    }
}

it("profit mode rejects known non-positive margin routes instead of filling capacity", () => {
    const builder = new window.ScheduleBuilder(preset(), {server: "free1", airlineCode: "CFA"})
    const assignment = builder.assignRoutes([
        route("BOS", 50000),
        route("ISP", -12000),
        route("ALB", 0)
    ], {
        mode: "profit",
        selectedSpec: {range: 3000}
    })

    const placedDests = Array.from(new Set(assignment.placements.map(p => p.route.destination)))
    assert.deepStrictEqual(placedDests, ["BOS"])
    assert.strictEqual(assignment.profitPlaced, 1)
    assert.deepStrictEqual(
        assignment.unplaced.map(r => r.destination).sort(),
        ["ALB", "ISP"]
    )
})

summary("profit scheduling")
