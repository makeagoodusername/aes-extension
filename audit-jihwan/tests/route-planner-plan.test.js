"use strict"

/**
 * Route Planner plan smoke tests.
 *
 * Loads the production pure planner and exercises the full mock-schedule
 * path: airport parsing, demand-ranked plan generation, editable preview
 * mutations, submit payload building, and sequential bridge application.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

function reset() {
    try { delete global.AesRoutePlanner } catch (_) {}
    global.window = global
}

function loadPlanner() {
    reset()
    const src = fs.readFileSync(path.join(ROOT, "modules/route-planner/planner.js"), "utf8")
    eval(src)
    assert.ok(global.AesRoutePlanner, "AesRoutePlanner did not attach to window")
    return global.AesRoutePlanner
}

function sampleSchedule() {
    return {
        date: {
            "20260401": {
                schedule: [
                    {origin: "JFK", destination: "ATL", od: "JFKATL", flightNumber: {"7": {}, "9": {}}},
                    {origin: "ATL", destination: "JFK", od: "ATLJFK", flightNumber: {}}
                ]
            },
            "20260403": {
                schedule: [
                    {origin: "JFK", destination: "LHR", od: "JFKLHR", flightNumber: {"1": {}, "12": {}}},
                    {origin: "LHR", destination: "JFK", od: "LHRJFK", flightNumber: {}}
                ]
            }
        }
    }
}

function routeMeta() {
    return {
        "JFK-LHR": {distanceKm: 5540, weeklyFlights: 210, score: 500},
        "LHR-JFK": {distanceKm: 5540, weeklyFlights: 210, score: 500},
        "JFK-ATL": {distanceKm: 1220, weeklyFlights: 120, score: 150},
        "ATL-JFK": {distanceKm: 1220, weeklyFlights: 120, score: 150}
    }
}

function baseOptions(overrides) {
    return Object.assign({
        hub:               "JFK",
        airports:          ["JFK", "ATL", "LHR"],
        aircraft:          [{aircraftId: "22092", registration: "N001CFA", hub: "JFK"}],
        flightCount:       4,
        startFlightNumber: 100,
        startTime:         "09:00",
        turnMin:           45,
        routeMeta:         routeMeta(),
        pricePct:          115,
        service:           "STD"
    }, overrides || {})
}

let pass = 0, fail = 0
async function it(name, fn) {
    try { await fn(); pass++; console.log("  ok  " + name) }
    catch (e) { fail++; console.log("  FAIL " + name + " -- " + (e && e.message)) }
}

function selectedSeqs(plan) {
    return (plan.flights || []).filter(f => f && f.selected !== false).map(f => f.seq)
}

console.log("=== route-planner-plan ===")

;(async () => {

await it("parses and deduplicates airport lists from text and schedule", async () => {
    const Planner = loadPlanner()
    assert.deepStrictEqual(Planner.normalizeIataList(" jfk, atl;LHR JFK badcode 12 "), ["JFK", "ATL", "LHR"])
    assert.deepStrictEqual(Planner.airportsFromSchedule(sampleSchedule()), ["JFK", "LHR"])
    assert.strictEqual(Planner.latestScheduleDate(sampleSchedule()), "20260403")
    assert.strictEqual(Planner.suggestNextFlightNumber(sampleSchedule()), 2)
})

await it("generates demand-ranked out-and-back flights with long-leg gaps", async () => {
    const Planner = loadPlanner()
    const plan = Planner.generatePlan(baseOptions())

    assert.ok(plan.ok, "plan should generate: " + (plan.errors || []).join(","))
    assert.strictEqual(plan.flights.length, 4)
    assert.deepStrictEqual(plan.flights.map(f => f.origin + "-" + f.destination), [
        "JFK-LHR",
        "LHR-JFK",
        "JFK-ATL",
        "ATL-JFK"
    ])
    assert.deepStrictEqual(plan.flights.map(f => f.flightNumberText), ["100", "101", "102", "103"])
    assert.ok(plan.flights[0].blockMin >= 300, "JFK-LHR should be treated as long")
    assert.ok(plan.flights[0].nextGapMin > 45, "long leg should receive irregular sequential gap")
    assert.match(plan.flights[0].note, /long leg/)
    assert.strictEqual(plan.summary.longFlights, 2)
})

await it("generates chain plans from each prior destination", async () => {
    const Planner = loadPlanner()
    const plan = Planner.generatePlan(baseOptions({pattern: "chain", flightCount: 3}))

    assert.ok(plan.ok)
    assert.deepStrictEqual(plan.flights.map(f => f.origin + "-" + f.destination), [
        "JFK-ATL",
        "ATL-LHR",
        "LHR-JFK"
    ])
})

await it("applies editable preview fields and rebuilds arrival/day state", async () => {
    const Planner = loadPlanner()
    const plan = Planner.generatePlan(baseOptions({flightCount: 2}))
    const edited = Planner.applyEdits(plan, [{
        seq:              1,
        depTimeLocal:     "22:45",
        dayIdx:           4,
        flightNumberText: "4321",
        aircraftId:       "777",
        selected:         false
    }])
    const f = edited.flights[0]

    assert.strictEqual(f.depTimeLocal, "22:45")
    assert.notStrictEqual(f.arrTimeLocal, plan.flights[0].arrTimeLocal)
    assert.strictEqual(f.dayName, "Fri")
    assert.deepStrictEqual(f.dayMask, [false, false, false, false, true, false, false])
    assert.strictEqual(f.flightNumberText, "4321")
    assert.strictEqual(f.aircraftId, "777")
    assert.strictEqual(f.selected, false)
})

await it("builds the submit payload expected by the AFP bridge", async () => {
    const Planner = loadPlanner()
    const plan = Planner.generatePlan(baseOptions({flightCount: 1}))
    const edited = Planner.applyEdits(plan, [{seq: 1, dayIdx: 3, flightNumberText: "212"}])
    const payload = Planner.buildSubmitPayload(edited.flights[0], {server: "free1"})

    assert.strictEqual(payload.server, "free1")
    assert.strictEqual(payload.aircraftId, "22092")
    assert.strictEqual(payload.hub, "JFK")
    assert.strictEqual(payload.leg.origin, "JFK")
    assert.strictEqual(payload.leg.destination, "LHR")
    assert.strictEqual(payload.leg.depTimeLocal, edited.flights[0].depTimeLocal)
    assert.deepStrictEqual(payload.leg.dayMask, [false, false, false, true, false, false, false])
    assert.strictEqual(payload.leg.pricePct, 115)
    assert.strictEqual(payload.leg.service, "STD")
    assert.strictEqual(payload.leg.flightNumberText, "212")
})

await it("applies selected rows sequentially through a bridge, checked twice", async () => {
    const Planner = loadPlanner()
    const plan = Planner.applyEdits(Planner.generatePlan(baseOptions({flightCount: 3})), [
        {seq: 2, selected: false}
    ])
    assert.deepStrictEqual(selectedSeqs(plan), [1, 3])

    for (let run = 1; run <= 2; run++) {
        const calls = []
        const progress = []
        const result = await Planner.applyPlan(plan, {
            server:       "free1",
            applyDelayMs: 0,
            submitBridge: {
                async submitLegInBackground(args) {
                    calls.push(JSON.parse(JSON.stringify(args)))
                    return {ok: true, flightNumber: args.leg.flightNumberText || "AUTO"}
                }
            },
            onProgress(evt) {
                progress.push({phase: evt.phase, seq: evt.flight && evt.flight.seq})
            }
        })

        assert.ok(result.ok, "run " + run + " apply should succeed")
        assert.strictEqual(calls.length, 2)
        assert.deepStrictEqual(calls.map(c => c.leg.origin + "-" + c.leg.destination), ["JFK-LHR", "JFK-ATL"])
        assert.deepStrictEqual(progress.filter(p => p.phase === "submitting").map(p => p.seq), [1, 3])
        assert.strictEqual(calls[0].server, "free1")
        assert.strictEqual(calls[0].aircraftId, "22092")
        assert.ok(Array.isArray(calls[0].leg.dayMask))
    }
})

await it("accepts midnight as a valid first departure", async () => {
    const Planner = loadPlanner()
    const plan = Planner.generatePlan(baseOptions({startTime: "00:00", flightCount: 1}))
    assert.ok(plan.ok, "midnight plan should generate")
    assert.match(plan.flights[0].depTimeLocal, /^\d{2}:\d{2}$/)
})

console.log("=== route-planner-plan: " + pass + " passed, " + fail + " failed ===")
if (fail) process.exit(1)

})().catch(err => {
    console.error(err)
    process.exit(1)
})
