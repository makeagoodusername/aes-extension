"use strict"

const path = require("path")
const assert = require("assert")
const api = require(path.resolve(__dirname, "..",
    "modules/route-assistant/competitor-flight-details.js"))

let pass = 0, fail = 0
function it(name, fn) {
    try {
        fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== competitor-flight-details ===")

const typeSpecs = new Map([
    [10, {typeId: 10, typeName: "Boeing 737-700", seats: 149, cargoCapacity: 12000}],
    [20, {typeId: 20, typeName: "Airbus A321", seats: 206, cargoCapacity: 18000}]
])

const flights = [
    {
        flightCode: "BGW 100",
        flightId: 100,
        typeCode: "737-700",
        typeId: 10,
        depDateLocal: "2026-05-05",
        depTimeLocal: "06:00",
        serviceClass: "Y",
        availability: 14,
        price: 313
    },
    {
        flightCode: "BGW 100",
        flightId: 100,
        typeCode: "737-700",
        typeId: 10,
        depDateLocal: "2026-05-05",
        depTimeLocal: "06:00",
        serviceClass: "C",
        availability: 3,
        price: 820
    },
    {
        flightCode: "BGW101",
        flightId: 101,
        typeCode: "737-700",
        typeId: 10,
        depDateLocal: "2026-05-05",
        depTimeLocal: "12:00",
        serviceClass: "Y",
        availability: 9,
        price: 326
    },
    {
        flightCode: "MIA 200",
        flightId: 200,
        typeCode: "A321",
        typeId: 20,
        depDateLocal: "2026-05-05",
        depTimeLocal: "18:00",
        serviceClass: "Y",
        availability: 20,
        price: 180
    },
    {
        flightCode: "OWN 1",
        flightId: 1,
        typeId: 10,
        serviceClass: "Y",
        price: 1,
        isOurs: true
    }
]

it("extracts spaced and compact airline prefixes", () => {
    assert.strictEqual(api.flightPrefix("BGW 100"), "BGW")
    assert.strictEqual(api.flightPrefix("BGW101"), "BGW")
})

it("summarises unique flight instances, prices, times, aircraft and capacity", () => {
    const detail = api.summariseFlights(flights.filter(f => /^BGW/.test(f.flightCode)), {typeSpecs})
    assert.strictEqual(detail.flightCount, 2)
    assert.strictEqual(detail.rowCount, 3)
    assert.strictEqual(detail.pricesByClass.Y.median, 319.5)
    assert.strictEqual(detail.pricesByClass.C.median, 820)
    assert.deepStrictEqual(detail.departures, ["06:00", "12:00"])
    assert.strictEqual(detail.totalSeatCapacity, 298)
    assert.strictEqual(detail.totalCargoCapacity, 24000)
    assert.strictEqual(detail.aircraft[0].typeCode, "737-700")
    assert.strictEqual(detail.aircraft[0].flights, 2)
    assert.ok(api.formatSummary(detail).includes("2 flt"))
    assert.ok(api.formatTooltip(detail).includes("BGW 100"))
    const instances = api.buildFlightInstances(flights.filter(f => /^BGW/.test(f.flightCode)), {typeSpecs})
    assert.strictEqual(instances.length, 2)
    assert.ok(api.formatFlightLine(instances[0]).includes("Y 313 AS$"))
    assert.ok(api.formatFlightLine(instances[0]).includes("149 seats"))
})

it("attaches flight details to enterprise entries by IATA prefix", () => {
    const entries = [
        {enterpriseId: 775, name: "Breeze Global Wings", iata: "BGW"},
        {enterpriseId: 776, name: "Miami Air", iata: "MIA"}
    ]
    api.attachFlightDetails(entries, flights, {typeSpecs})
    assert.strictEqual(entries[0].routeFlightDetail.flightCount, 2)
    assert.strictEqual(entries[0].routeFlightDetail.totalSeatCapacity, 298)
    assert.strictEqual(entries[1].routeFlightDetail.flightCount, 1)
    assert.strictEqual(entries[1].routeFlightDetail.totalSeatCapacity, 206)
})

it("supports from-flight-list backfill entries and routeFlightPrefix", () => {
    const entries = [
        {name: "QA  ·  1 flight", fromFlightList: true},
        {name: "Manual", routeFlightPrefix: "BGW"}
    ]
    api.attachFlightDetails(entries, [
        {flightCode: "QA100", flightId: 300, typeId: 10, serviceClass: "Y", price: 100},
        flights[0]
    ], {typeSpecs})
    assert.strictEqual(entries[0].routeFlightDetail.prefixes[0], "QA")
    assert.strictEqual(entries[1].routeFlightDetail.prefixes[0], "BGW")
})

it("decorates route rows and collects competitor aircraft type ids", () => {
    const row = {
        competitorFlights: flights,
        competitorEntries: [{name: "Breeze Global Wings", iata: "BGW"}],
        marketSharePax: [{name: "Miami Air", iata: "MIA"}]
    }
    api.decorateRow(row, {typeSpecs})
    assert.strictEqual(row.competitorEntries[0].routeFlightDetail.flightCount, 2)
    assert.strictEqual(row.marketSharePax[0].routeFlightDetail.flightCount, 1)
    assert.deepStrictEqual(api.collectTypeIdsFromRows([row]).sort((a, b) => a - b), [10, 20])
})

console.log("\n" + pass + " passed, " + fail + " failed")
process.exit(fail ? 1 : 0)
