"use strict"

/**
 * Mock-schedule builder smoke. Locks the contract of
 * modules/aircraft-flight-plan/mock-schedule/builder.js so the GUI + apply
 * pipeline can rely on a stable leg shape.
 */
const assert = require("assert")
const path = require("path")

const M = require(path.resolve(__dirname, "..", "..", "..",
    "modules/aircraft-flight-plan/mock-schedule/builder.js"))

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " — " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"))
    }
}

console.log("=== mock-schedule builder ===")

const B767 = {seats: 218, cargoCapacity: 7000, cruiseSpeedKmh: 850, range: 11000}
const B737 = {seats: 160, cargoCapacity: 3000, cruiseSpeedKmh: 800, range: 5500}

it("classifies short / medium / long by round-trip hours", () => {
    const cls = M._internal._classify
    assert.strictEqual(cls(8),  "SHORT")
    assert.strictEqual(cls(12), "SHORT")
    assert.strictEqual(cls(20), "MEDIUM")
    assert.strictEqual(cls(36), "MEDIUM")
    assert.strictEqual(cls(48), "LONG")
})

it("rejects destinations beyond aircraft range", () => {
    const out = M.recommend({
        hub: "LHR", spec: B737, flightsTarget: 4,
        destinations: [
            {iata: "FRA", distanceKm: 650},
            {iata: "JFK", distanceKm: 5500 + 1}  // out of range
        ]
    })
    assert.ok(out.warnings.some(w => /JFK out of range/.test(w)), "warns on out-of-range")
    assert.ok(out.legs.every(l => l.destination !== "JFK"), "no JFK legs emitted")
})

it("emits short-haul legs that share a single multi-day mask + working window", () => {
    const out = M.recommend({
        hub: "LHR", spec: B767, flightsTarget: 7,
        destinations: [{iata: "FRA", distanceKm: 650}]
    })
    assert.ok(out.legs.length >= 1, "at least one leg")
    const fra = out.legs.filter(l => l.destination === "FRA")
    for (const l of fra) {
        assert.strictEqual(l.classification, "SHORT")
        assert.strictEqual(l.origin, "LHR")
        assert.match(l.depTime, /^[0-2]\d:[0-5]\d$/, "HH:MM")
        const h = parseInt(l.depTime.split(":")[0], 10)
        assert.ok(h >= 6 && h < 22, "departure inside working window")
        assert.ok(Array.isArray(l.dayMask) && l.dayMask.length === 7)
    }
    const occurrences = fra.reduce((s, l) => s + (l.weekOccurrences || 1), 0)
    assert.strictEqual(occurrences, 7, "schedule sums to requested flights")
})

it("long-haul produces irregular departures pinned to specific days", () => {
    const out = M.recommend({
        hub: "LHR", spec: B767, flightsTarget: 3,
        destinations: [{iata: "JFK", distanceKm: 5550}]
    })
    const jfk = out.legs.filter(l => l.destination === "JFK")
    assert.ok(jfk.length >= 1, "long-haul emits at least one leg")
    for (const l of jfk) {
        // JFK is 5550km / 850 km/h = ~6.5h one-way → RT ~16h → MEDIUM (not LONG)
        // Use TYO instead for true long-haul check.
        assert.ok(l.classification === "MEDIUM" || l.classification === "LONG")
    }
    // True long-haul: SYD from LHR ~ 17000km
    const syd = M.recommend({
        hub: "LHR", spec: {seats: 250, cruiseSpeedKmh: 880, range: 18000, cargoCapacity: 8000},
        flightsTarget: 2,
        destinations: [{iata: "SYD", distanceKm: 17000}]
    })
    const sydLegs = syd.legs.filter(l => l.destination === "SYD")
    assert.ok(sydLegs.length >= 1, "long-haul SYD emits leg")
    for (const l of sydLegs) {
        assert.strictEqual(l.classification, "LONG")
        assert.strictEqual(l.irregularTime, true, "long-haul flags irregularTime")
        assert.ok(typeof l.pinnedDay === "number", "long-haul pins a day")
        const trueDays = l.dayMask.filter(Boolean).length
        assert.strictEqual(trueDays, 1, "long-haul dayMask is single-day")
    }
})

it("distributes flights across multiple destinations", () => {
    const out = M.recommend({
        hub: "LHR", spec: B767, flightsTarget: 14,
        destinations: [
            {iata: "FRA", distanceKm: 650},
            {iata: "CDG", distanceKm: 350},
            {iata: "AMS", distanceKm: 370}
        ]
    })
    const byDest = out.totals.byDest
    assert.ok(byDest.FRA > 0 && byDest.CDG > 0 && byDest.AMS > 0,
        "every destination gets at least one flight")
    assert.strictEqual(out.totals.scheduledFlights, 14,
        "total scheduled equals target")
})

it("caps flightsTarget at aircraft weekly capacity and warns", () => {
    const out = M.recommend({
        hub: "LHR", spec: {seats: 250, cruiseSpeedKmh: 880, range: 18000, cargoCapacity: 8000},
        flightsTarget: 50,                 // unrealistic for one aircraft on SYD only
        destinations: [{iata: "SYD", distanceKm: 17000}]
    })
    assert.ok(out.warnings.some(w => /exceeds aircraft weekly capacity/.test(w)),
        "warns when target > capacity")
    assert.ok(out.totals.scheduledFlights <= 50, "scheduledFlights respects cap")
    assert.ok(out.totals.scheduledFlights >= 1, "still produces at least one leg")
})

it("returns empty schedule when flightsTarget is 0 or destinations empty", () => {
    const a = M.recommend({hub: "LHR", spec: B767, flightsTarget: 0, destinations: [{iata: "FRA", distanceKm: 650}]})
    assert.strictEqual(a.legs.length, 0)
    const b = M.recommend({hub: "LHR", spec: B767, flightsTarget: 5, destinations: []})
    assert.strictEqual(b.legs.length, 0)
})

it("leg shape matches AesAfpFormDriver.normaliseLeg expectations", () => {
    const out = M.recommend({
        hub: "LHR", spec: B767, flightsTarget: 3,
        destinations: [{iata: "FRA", distanceKm: 650}]
    })
    const l = out.legs[0]
    assert.ok(l, "got at least one leg")
    for (const k of ["origin", "destination", "depTime", "dayMask", "pricePct", "service", "flightNumberText"]) {
        assert.ok(k in l, "leg has " + k)
    }
    assert.strictEqual(l.origin, "LHR")
    assert.strictEqual(l.destination, "FRA")
    assert.strictEqual(typeof l.flightNumberText, "string")
    assert.match(l.depTime, /^\d{2}:\d{2}$/)
    assert.strictEqual(l.dayMask.length, 7)
    assert.ok(l.sequenceGroup && l.sequenceGroup.indexOf("FRA") >= 0,
        "sequenceGroup namespaced by destination")
})

it("HHMM formatter snaps to 5-minute grid + wraps midnight", () => {
    const f = M._internal._formatHHMM
    assert.strictEqual(f(9.0),  "09:00")
    assert.strictEqual(f(9.5),  "09:30")
    assert.strictEqual(f(9.07), "09:05")           // snap up to 5
    assert.strictEqual(f(0),    "00:00")
    assert.strictEqual(f(24),   "00:00")
    assert.strictEqual(f(25.5), "01:30")
})

it("medium-haul alternates outbound days starting at 0/2/4/6", () => {
    // PEK from LHR ~8200km / 850 = 9.6h one-way → RT ~22.5h → MEDIUM
    const out = M.recommend({
        hub: "LHR", spec: B767, flightsTarget: 3,
        destinations: [{iata: "PEK", distanceKm: 8200}]
    })
    const legs = out.legs.filter(l => l.destination === "PEK")
    assert.strictEqual(legs.length, 3)
    for (const l of legs) {
        assert.strictEqual(l.classification, "MEDIUM")
        assert.ok(typeof l.pinnedDay === "number" && l.pinnedDay >= 0 && l.pinnedDay <= 6)
    }
    const days = legs.map(l => l.pinnedDay).sort()
    assert.deepStrictEqual(days, [0, 2, 4], "MEDIUM picks Mon/Wed/Fri first")
})

console.log("\nmock-schedule-builder: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)
