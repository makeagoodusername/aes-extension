"use strict"

const {loadAfpModule, resetGlobals, assert} = require("./_helpers")

function expose(name) {
    global[name] = window[name]
}

function firstDay(mask) {
    return Array.isArray(mask) ? mask.findIndex(Boolean) : -1
}

function timeToMin(hhmm) {
    const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/)
    assert.ok(m, "valid HH:MM: " + hhmm)
    return Number(m[1]) * 60 + Number(m[2])
}

async function main() {
    resetGlobals()
    loadAfpModule("modules/schedule-management/range-buckets.js", ["ScheduleFactors"])
    expose("ScheduleFactors")
    loadAfpModule("modules/aircraft-flight-plan/auto-scheduler/route-builder-planner.js")

    const candidates = [
        {destIata: "DUB", distanceKm: 449, paxScore: 8, cargoScore: 2, weeklyFlights: 80, scoreBlend: 500},
        {destIata: "JFK", distanceKm: 5540, paxScore: 10, cargoScore: 8, weeklyFlights: 48, scoreBlend: 900},
        {destIata: "CDG", distanceKm: 344, paxScore: 7, cargoScore: 3, weeklyFlights: 90, scoreBlend: 700},
        {destIata: "HND", distanceKm: 9600, paxScore: 10, cargoScore: 9, weeklyFlights: 20, scoreBlend: 850}
    ]

    const result = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates,
        spec: {typeName: "Boeing 767-300ER", cruiseSpeedKmh: 850, range: 12000},
        config: {
            includedIatas: ["JFK", "CDG"],
            targetFlights: 4,
            baseDeparture: "09:00",
            startDayIdx: 0,
            turnaroundMin: 60,
            sequentialLongHaul: true
        }
    })

    assert.deepStrictEqual(result.build.validation, [], "planner build is valid")
    assert.strictEqual(result.rows.length, 2, "four flights creates two round trips")
    assert.strictEqual(result.build.flights.length, 4, "generated four applyable legs")
    assert.deepStrictEqual(result.build.metadata.selectedAirports, ["JFK", "CDG"],
        "manual airport inclusion order is preserved")
    assert.strictEqual(result.build.metadata.requestedFlights, 4)
    assert.strictEqual(result.build.metadata.generatedFlights, 4)

    const [outJfk, inJfk, outCdg, inCdg] = result.build.flights
    assert.strictEqual(outJfk.origin, "LHR")
    assert.strictEqual(outJfk.destination, "JFK")
    assert.strictEqual(inJfk.origin, "JFK")
    assert.strictEqual(inJfk.destination, "LHR")
    assert.strictEqual(outCdg.destination, "CDG")
    assert.strictEqual(inCdg.origin, "CDG")

    assert.strictEqual(firstDay(outJfk.dayMask), 0, "first outbound starts Monday")
    assert.ok(firstDay(inJfk.dayMask) >= 0, "inbound has a concrete departure day")
    assert.ok(timeToMin(inJfk.depTimeLocal) !== timeToMin(outJfk.depTimeLocal),
        "return departure is sequenced after outbound")
    assert.ok(result.rows[1].outDayIdx >= result.rows[0].outDayIdx,
        "second route is sequentially placed after the first route")
    assert.ok(result.rows[0].rangeBucket === "mediumHaul" || result.rows[0].rangeBucket === "longHaul",
        "longer first route is bucketed for irregular planning")

    const odd = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates,
        spec: {cruiseSpeedKmh: 850},
        config: {includedIatas: ["CDG"], targetFlights: 3}
    })
    assert.strictEqual(odd.build.flights.length, 4,
        "odd flight targets round up to whole round trips")
    assert.ok(odd.build.warnings.some(w => w.type === "oddFlightTargetRounded"),
        "odd target warning is surfaced")

    const chain = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates,
        spec: {typeName: "Boeing 767-300ER", cruiseSpeedKmh: 850, range: 12000},
        config: {
            scheduleType: "chainLoop",
            includedIatas: ["JFK", "CDG"],
            targetFlights: 3,
            baseDeparture: "08:00",
            startDayIdx: 0,
            turnaroundMin: 60,
            sequentialLongHaul: true
        }
    })
    assert.deepStrictEqual(chain.build.validation, [], "chain planner build is valid")
    assert.strictEqual(chain.config.scheduleType, "chainLoop")
    assert.strictEqual(chain.rows.length, 3, "chain target creates one editable row per leg")
    assert.strictEqual(chain.build.flights.length, 3, "chain target creates exact flight count")
    assert.deepStrictEqual(chain.build.flights.map(f => f.origin + "-" + f.destination),
        ["LHR-JFK", "JFK-CDG", "CDG-LHR"],
        "chain loop walks through selected airports and returns to hub")
    assert.strictEqual(chain.rows[1].inSeq, null, "chain rows are single-leg rows")
    assert.deepStrictEqual(chain.build.metadata.selectedAirports, ["JFK", "CDG"],
        "chain metadata excludes the hub from selected airports")
    assert.ok(!chain.build.warnings.some(w => w.type === "oddFlightTargetRounded"),
        "odd chain targets do not round to round trips")

    console.log("route-builder-planner: passed")
}

main().catch(err => {
    console.error("route-builder-planner: FAILED")
    console.error(err && err.stack || err)
    process.exitCode = 1
})
