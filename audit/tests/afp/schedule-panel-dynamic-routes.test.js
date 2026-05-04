"use strict"

/**
 * Smoke for SchedulePanel's dynamic route selection. Locks down the path
 * that replaced the old `builder.build([])` foundation stub.
 */
const {loadAfpModule, resetGlobals, it, summary, assert} = require("./_helpers")

console.log("=== schedule-panel dynamic routes ===")

resetGlobals()
loadAfpModule("modules/schedule-management/range-buckets.js", ["ScheduleFactors"])
global.ScheduleFactors = window.ScheduleFactors
loadAfpModule("modules/schedule-management/schedule-panel.js", ["SchedulePanel"])

const P = window.SchedulePanel
assert.ok(P, "SchedulePanel not exposed")

function preset() {
    return {
        id: "p1",
        name: "JFK banks",
        hub: "JFK",
        factors: window.ScheduleFactors.defaultFactors(),
        waves: [{
            id: "w1",
            label: "Morning",
            arrivalWindow: {start: "06:00", end: "06:30"},
            departureWindow: {start: "07:15", end: "07:45"},
            composition: {shortHaul: 1, mediumHaul: 1, longHaul: 0}
        }]
    }
}

it("dedupe keeps first source priority but fills missing distance", () => {
    const rows = P._dedupeRouteRows([
        {source: "AFP candidates", row: {destIata: "BOS", score: 90}},
        {source: "Route Assistant top-routes", row: {destIata: "BOS", distanceKm: 300, paxScore: 7}}
    ])
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0]._source, "AFP candidates")
    assert.strictEqual(rows[0].distanceKm, 300)
    assert.strictEqual(rows[0].paxScore, 7)
})

it("rowsToBuildRoutes converts km to nm and skips missing distances", () => {
    const out = P._rowsToBuildRoutes([
        {destIata: "BOS", distanceKm: 300, score: 90},
        {destIata: "ORD", score: 80}
    ])
    assert.strictEqual(out.routes.length, 1)
    assert.strictEqual(out.routes[0].destination, "BOS")
    assert.ok(out.routes[0].distanceNm > 0)
    assert.strictEqual(out.skippedNoDistance, 1)
})

it("capacity selection fills each configured bucket by route rank", () => {
    const rows = P._rowsToBuildRoutes([
        {destIata: "NRT", distanceKm: 10860, score: 100}, // longHaul, no capacity
        {destIata: "BOS", distanceKm: 300,  score: 90},  // shortHaul, selected
        {destIata: "ORD", distanceKm: 1180, score: 80},  // shortHaul, overflow
        {destIata: "LAX", distanceKm: 3974, score: 70}   // mediumHaul, selected
    ]).routes
    const picked = P._selectRoutesForPresetCapacity(rows, preset())
    assert.deepStrictEqual(picked.routes.map(r => r.destination), ["BOS", "LAX"])
    assert.strictEqual(picked.selectedByBucket.shortHaul, 1)
    assert.strictEqual(picked.selectedByBucket.mediumHaul, 1)
    assert.strictEqual(picked.selectedByBucket.longHaul, 0)
    assert.strictEqual(picked.skippedNoCapacity, 2)
    assert.strictEqual(picked.skippedNoBucket, 0)
})

it("zero composition reports no build capacity", () => {
    const p = preset()
    p.waves[0].composition = {shortHaul: 0, mediumHaul: 0, longHaul: 0}
    const capacity = P._capacityByBucket(p)
    assert.strictEqual(capacity.total, 0)
})

it("time validation accepts midnight and rejects invalid values", () => {
    assert.strictEqual(P._isValidHHMM("00:00"), true)
    assert.strictEqual(P._isValidHHMM("23:59"), true)
    assert.strictEqual(P._isValidHHMM("24:00"), false)
    assert.strictEqual(P._isValidHHMM(""), false)
})

summary("schedule-panel dynamic routes")
