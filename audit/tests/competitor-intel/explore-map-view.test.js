"use strict"

/**
 * Smoke for modules/competitor-intel/views/explore-map-view.js — pure
 * helpers (_buildAirportIndex, _carrierSummary, _radius, _project).
 * Render is DOM-bound; covered by live verification.
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

function load(filename, sandbox) {
    const src = fs.readFileSync(path.resolve(__dirname, "../../..", filename), "utf8")
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox, {filename})
}

function makeSandbox() {
    return {
        window: {},
        document: {createElement: () => ({}), createElementNS: () => ({})},
        console
    }
}

function makeCoords() {
    const T = {
        JFK: {lat: 40.6413, lon: -73.7781, name: "New York JFK"},
        LAX: {lat: 33.9416, lon: -118.4085, name: "Los Angeles"},
        LHR: {lat: 51.4700, lon: -0.4543, name: "London Heathrow"},
        CDG: {lat: 49.0097, lon: 2.5479, name: "Paris CDG"}
    }
    return {get: (i) => T[String(i || "").toUpperCase()] || null}
}

const sb = makeSandbox()
sb.window.WorldViewAirportCoords = makeCoords()
load("modules/competitor-intel/views/explore-map-view.js", sb)
const mod = sb.window.AesCompetitorIntelExploreMapView
assert(mod && typeof mod._buildAirportIndex === "function", "module loaded")

const tests = []
function t(name, fn) { tests.push({name, fn}) }

t("buildAirportIndex with no data returns empty Map", () => {
    const idx = mod._buildAirportIndex({}, makeCoords())
    // VM realm has its own Map class — duck-type instead of instanceof
    assert.strictEqual(idx.size, 0)
    assert.strictEqual(typeof idx.has, "function")
    assert.strictEqual(typeof idx.values, "function")
})

t("edges populate both endpoints with shared carriers", () => {
    const data = {
        edges: new Map([
            ["JFK-LAX", {
                hub: "JFK", dest: "LAX",
                competitors: [
                    {enterpriseId: "1", name: "AirOne", iata: "AO", weeklyFlights: 14},
                    {enterpriseId: "2", name: "AirTwo", iata: "AT", weeklyFlights: 7}
                ],
                totals: {totalWeeklyFlights: 21}
            }]
        ]),
        enterprises: new Map(),
        ourHubs: new Set()
    }
    const idx = mod._buildAirportIndex(data, makeCoords())
    assert.strictEqual(idx.size, 2)
    const jfk = idx.get("JFK")
    const lax = idx.get("LAX")
    assert(jfk && lax)
    assert.strictEqual(jfk.carriers.size, 2)
    assert.strictEqual(lax.carriers.size, 2)
    assert.strictEqual(jfk.weeklyFlights, 21)
    assert.strictEqual(lax.weeklyFlights, 21)
    assert.strictEqual(jfk.name, "New York JFK")
    assert.strictEqual(lax.name, "Los Angeles")
})

t("our hubs flagged via ourHubs set", () => {
    const data = {
        edges: new Map([["JFK-LAX", {hub: "JFK", dest: "LAX",
            competitors: [{enterpriseId: "1", name: "AirOne"}]}]]),
        enterprises: new Map(),
        ourHubs: new Set(["JFK"])
    }
    const idx = mod._buildAirportIndex(data, makeCoords())
    assert.strictEqual(idx.get("JFK").isOurs, true)
    assert.strictEqual(idx.get("LAX").isOurs, false)
})

t("enterprise hubs add a hub-based carrier even with no edges", () => {
    const data = {
        edges: new Map(),
        enterprises: new Map([
            ["7", {enterpriseId: "7", name: "AirSeven", iata: "A7",
                hubs: [{iata: "LHR"}, {iata: "CDG"}]}]
        ]),
        ourHubs: new Set()
    }
    const idx = mod._buildAirportIndex(data, makeCoords())
    assert.strictEqual(idx.size, 2)
    const lhr = idx.get("LHR")
    assert(lhr.carriers.has("7"))
    assert.strictEqual(lhr.carriers.get("7").hubBased, true)
})

t("carrier hubBased flag persists when enterprise + edge both reference", () => {
    const data = {
        edges: new Map([["LHR-CDG", {hub: "LHR", dest: "CDG",
            competitors: [{enterpriseId: "7", name: "AirSeven", weeklyFlights: 5}]}]]),
        enterprises: new Map([
            ["7", {enterpriseId: "7", name: "AirSeven", hubs: [{iata: "LHR"}]}]
        ]),
        ourHubs: new Set()
    }
    const idx = mod._buildAirportIndex(data, makeCoords())
    const lhr = idx.get("LHR")
    assert.strictEqual(lhr.carriers.get("7").hubBased, true)
    assert.strictEqual(lhr.carriers.get("7").weeklyFlights, 5)
    assert.strictEqual(idx.get("CDG").carriers.get("7").hubBased, false)
})

t("invalid IATA in edges is silently dropped", () => {
    const data = {
        edges: new Map([["jfk-lax", {hub: "jfk", dest: "X",
            competitors: [{enterpriseId: "1", name: "AirOne"}]}]]),
        enterprises: new Map(),
        ourHubs: new Set()
    }
    const idx = mod._buildAirportIndex(data, makeCoords())
    assert(idx.has("JFK"))
    assert(!idx.has("X"))
})

t("carrierSummary sorts by weeklyFlights desc", () => {
    const carriers = new Map([
        ["1", {enterpriseId: "1", name: "Low", weeklyFlights: 2}],
        ["2", {enterpriseId: "2", name: "High", weeklyFlights: 20}],
        ["3", {enterpriseId: "3", name: "Mid", weeklyFlights: 10}]
    ])
    const sum = mod._carrierSummary(carriers)
    assert.strictEqual(sum.list.length, 3)
    assert.strictEqual(sum.list[0].name, "High")
    assert.strictEqual(sum.list[1].name, "Mid")
    assert.strictEqual(sum.list[2].name, "Low")
    assert.strictEqual(sum.total, 3)
})

t("radius scales by carrier count, sqrt", () => {
    const small = mod._radius(1, 100)
    const large = mod._radius(100, 100)
    assert(small < large)
    assert(small >= 4 && small <= 6, "small ~ near min")
    assert(large >= 19 && large <= 21, "large ~ near max")
})

t("project lat/lon → x/y on equirectangular VW=1000 VH=500", () => {
    const eq = mod._project(0, 0)
    assert.strictEqual(eq.x, 500)
    assert.strictEqual(eq.y, 250)
    const ne = mod._project(90, -180)
    assert.strictEqual(ne.x, 0)
    assert.strictEqual(ne.y, 0)
    const sw = mod._project(-90, 180)
    assert.strictEqual(sw.x, 1000)
    assert.strictEqual(sw.y, 500)
})

t("airports without coords are kept in the index but have null lat/lon", () => {
    // ZZZ is not in test coord table — index entry should still exist
    const data = {
        edges: new Map([["JFK-ZZZ", {hub: "JFK", dest: "ZZZ",
            competitors: [{enterpriseId: "1", name: "AirOne"}]}]]),
        enterprises: new Map(),
        ourHubs: new Set()
    }
    const idx = mod._buildAirportIndex(data, makeCoords())
    assert(idx.has("ZZZ"))
    assert.strictEqual(idx.get("ZZZ").lat, null)
    assert.strictEqual(idx.get("ZZZ").lon, null)
})

// ---------------------------------------------------------------------------
// Schedule projection — _scheduleFromRecords
// ---------------------------------------------------------------------------

function makeRec(hub, dest, flights) {
    return {hub, dest, server: "test", scrapedAt: 0,
        competitors: flights.map(f => Object.assign({isOurs: false, serviceClass: "Y"}, f))}
}

t("scheduleFromRecords: groups outbound + inbound for one carrier at hub", () => {
    const recs = [
        makeRec("LHR", "CDG", [
            {flightId: 1, flightCode: "BA 100", depTimeUtc: "08:00", arrTimeUtc: "09:00", typeCode: "320"},
            {flightId: 2, flightCode: "BA 200", depTimeUtc: "12:00", arrTimeUtc: "13:00", typeCode: "320"}
        ]),
        makeRec("CDG", "LHR", [
            {flightId: 3, flightCode: "BA 101", depTimeUtc: "10:00", arrTimeUtc: "11:00", typeCode: "320"}
        ])
    ]
    const proj = mod._scheduleFromRecords(recs, "BA", "LHR")
    assert.strictEqual(proj.uniqueCount, 3)
    assert.strictEqual(proj.flights.filter(f => f.dir === "out").length, 2, "two outbound from LHR")
    assert.strictEqual(proj.flights.filter(f => f.dir === "in").length, 1, "one inbound to LHR")
})

t("scheduleFromRecords: dedupes service-class triplets via flightId", () => {
    const recs = [makeRec("LHR", "CDG", [
        {flightId: 1, flightCode: "BA 100", depTimeUtc: "08:00", arrTimeUtc: "09:00", serviceClass: "Y"},
        {flightId: 1, flightCode: "BA 100", depTimeUtc: "08:00", arrTimeUtc: "09:00", serviceClass: "C"},
        {flightId: 1, flightCode: "BA 100", depTimeUtc: "08:00", arrTimeUtc: "09:00", serviceClass: "Cargo"}
    ])]
    const proj = mod._scheduleFromRecords(recs, "BA", "LHR")
    assert.strictEqual(proj.uniqueCount, 1, "all three classes collapse to one flight")
})

t("scheduleFromRecords: filters by carrier IATA prefix (case-insensitive)", () => {
    const recs = [makeRec("LHR", "CDG", [
        {flightId: 1, flightCode: "BA 100", depTimeUtc: "08:00"},
        {flightId: 2, flightCode: "AF 100", depTimeUtc: "09:00"},
        {flightId: 3, flightCode: "ba 200", depTimeUtc: "10:00"}
    ])]
    const projBA = mod._scheduleFromRecords(recs, "BA", "LHR")
    assert.strictEqual(projBA.uniqueCount, 2, "BA matches BA + ba")
    const projAF = mod._scheduleFromRecords(recs, "AF", "LHR")
    assert.strictEqual(projAF.uniqueCount, 1)
})

t("scheduleFromRecords: bank detection clusters into 30-min bins", () => {
    // 3 flights at 08:00, 08:15 → same bin (480..510). Two bins ≥2.
    const recs = [makeRec("LHR", "CDG", [
        {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"},
        {flightId: 2, flightCode: "BA 2", depTimeUtc: "08:15"},
        {flightId: 3, flightCode: "BA 3", depTimeUtc: "08:25"},
        {flightId: 4, flightCode: "BA 4", depTimeUtc: "14:00"},
        {flightId: 5, flightCode: "BA 5", depTimeUtc: "14:10"}
    ])]
    const proj = mod._scheduleFromRecords(recs, "BA", "LHR")
    assert.strictEqual(proj.banks.length, 2, "two banks")
    assert.strictEqual(proj.banks[0].count, 3, "bigger bank has 3 flights")
    assert.strictEqual(proj.banks[0].peakMin, 480)
    assert.strictEqual(proj.banks[1].count, 2)
    assert.strictEqual(proj.banks[1].peakMin, 840)
})

t("scheduleFromRecords: ignores other airports in the records", () => {
    const recs = [
        makeRec("FRA", "MUC", [{flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"}]),
        makeRec("LHR", "CDG", [{flightId: 2, flightCode: "BA 2", depTimeUtc: "09:00"}])
    ]
    const proj = mod._scheduleFromRecords(recs, "BA", "LHR")
    assert.strictEqual(proj.uniqueCount, 1)
    assert.strictEqual(proj.flights[0].routePair, "LHR→CDG")
})

t("scheduleFromRecords: skips isOurs flights", () => {
    const recs = [{hub: "LHR", dest: "CDG", competitors: [
        {isOurs: true, flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"},
        {isOurs: false, flightId: 2, flightCode: "BA 2", depTimeUtc: "09:00"}
    ]}]
    const proj = mod._scheduleFromRecords(recs, "BA", "LHR")
    assert.strictEqual(proj.uniqueCount, 1)
})

t("scheduleFromRecords: bad input returns empty projection", () => {
    const proj = mod._scheduleFromRecords([], "BA", "LHR")
    assert.strictEqual(proj.flights.length, 0)
    assert.strictEqual(proj.uniqueCount, 0)
    assert.strictEqual(proj.banks.length, 0)
})

t("scheduleFromRecords: rejects malformed iata", () => {
    const recs = [makeRec("LHR", "CDG", [{flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"}])]
    assert.strictEqual(mod._scheduleFromRecords(recs, "ba1", "LHR").uniqueCount, 0)
    assert.strictEqual(mod._scheduleFromRecords(recs, "BA", "lhr1").uniqueCount, 0)
})

// ---------------------------------------------------------------------------
// Carrier network projector — _carrierNetworkFromRecords (slice 4)
// ---------------------------------------------------------------------------

t("carrierNetworkFromRecords: empty when no records", () => {
    const proj = mod._carrierNetworkFromRecords([], "BA")
    assert.strictEqual(proj.totalRoutes, 0)
    assert.strictEqual(proj.totalWeekly, 0)
})

t("carrierNetworkFromRecords: aggregates per route, sorted desc by weekly", () => {
    const recs = [
        makeRec("LHR", "CDG", [
            {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"},
            {flightId: 2, flightCode: "BA 2", depTimeUtc: "12:00"},
            {flightId: 3, flightCode: "BA 3", depTimeUtc: "16:00"}
        ]),
        makeRec("LHR", "JFK", [
            {flightId: 10, flightCode: "BA 100", depTimeUtc: "10:00"}
        ]),
        makeRec("CDG", "LHR", [
            {flightId: 20, flightCode: "BA 21", depTimeUtc: "09:00"},
            {flightId: 21, flightCode: "BA 22", depTimeUtc: "13:00"}
        ])
    ]
    const proj = mod._carrierNetworkFromRecords(recs, "BA")
    assert.strictEqual(proj.totalRoutes, 3)
    assert.strictEqual(proj.totalWeekly, 6)
    assert.strictEqual(proj.routes[0].pair, "LHR-CDG", "highest-weekly route first")
    assert.strictEqual(proj.routes[0].weeklyFlights, 3)
    assert.strictEqual(proj.routes[1].weeklyFlights, 2, "CDG-LHR has 2")
    assert.strictEqual(proj.routes[2].weeklyFlights, 1, "LHR-JFK has 1")
})

t("carrierNetworkFromRecords: dedupes service-class triplets", () => {
    const recs = [makeRec("LHR", "CDG", [
        {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00", serviceClass: "Y"},
        {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00", serviceClass: "C"},
        {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00", serviceClass: "Cargo"}
    ])]
    const proj = mod._carrierNetworkFromRecords(recs, "BA")
    assert.strictEqual(proj.routes[0].weeklyFlights, 1, "three classes collapse to one")
})

t("carrierNetworkFromRecords: depSpark fills 24-hour buckets", () => {
    const recs = [makeRec("LHR", "CDG", [
        {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"},
        {flightId: 2, flightCode: "BA 2", depTimeUtc: "08:30"},
        {flightId: 3, flightCode: "BA 3", depTimeUtc: "14:15"}
    ])]
    const proj = mod._carrierNetworkFromRecords(recs, "BA")
    const spark = proj.routes[0].depSpark
    assert.strictEqual(spark.length, 24)
    assert.strictEqual(spark[8], 2, "08:00 + 08:30 → hour 8")
    assert.strictEqual(spark[14], 1)
    assert.strictEqual(spark[0], 0)
})

t("carrierNetworkFromRecords: top banks per route", () => {
    const recs = [makeRec("LHR", "CDG", [
        {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"},
        {flightId: 2, flightCode: "BA 2", depTimeUtc: "08:10"},
        {flightId: 3, flightCode: "BA 3", depTimeUtc: "08:20"},
        {flightId: 4, flightCode: "BA 4", depTimeUtc: "14:00"},
        {flightId: 5, flightCode: "BA 5", depTimeUtc: "14:10"}
    ])]
    const proj = mod._carrierNetworkFromRecords(recs, "BA")
    const r = proj.routes[0]
    assert.strictEqual(r.topBanks.length, 2)
    assert.strictEqual(r.topBanks[0].peakMin, 480)
    assert.strictEqual(r.topBanks[0].count, 3)
})

t("carrierNetworkFromRecords: hubsTouched aggregates O&D across network", () => {
    const recs = [
        makeRec("LHR", "CDG", [{flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"}]),
        makeRec("LHR", "JFK", [{flightId: 2, flightCode: "BA 2", depTimeUtc: "10:00"}]),
        makeRec("CDG", "FRA", [{flightId: 3, flightCode: "BA 3", depTimeUtc: "12:00"}])
    ]
    const proj = mod._carrierNetworkFromRecords(recs, "BA")
    const hubs = Array.from(proj.hubsTouched).sort()
    assert.deepStrictEqual(hubs, ["CDG", "FRA", "JFK", "LHR"])
})

t("carrierNetworkFromRecords: rejects malformed iata", () => {
    const recs = [makeRec("LHR", "CDG", [{flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00"}])]
    assert.strictEqual(mod._carrierNetworkFromRecords(recs, "x").totalRoutes, 0)
    assert.strictEqual(mod._carrierNetworkFromRecords(recs, "TOO LONG").totalRoutes, 0)
})

t("carrierNetworkFromRecords: skips isOurs and other carriers", () => {
    const recs = [makeRec("LHR", "CDG", [
        {flightId: 1, flightCode: "BA 1", depTimeUtc: "08:00", isOurs: true},
        {flightId: 2, flightCode: "AF 1", depTimeUtc: "09:00"},
        {flightId: 3, flightCode: "BA 2", depTimeUtc: "10:00"}
    ])]
    const proj = mod._carrierNetworkFromRecords(recs, "BA")
    assert.strictEqual(proj.routes[0].weeklyFlights, 1)
})

t("buildOrsAirportIndex: empty when no ORS routes", () => {
    const idx = mod._buildOrsAirportIndex({})
    assert.strictEqual(idx.size, 0)
    const idx2 = mod._buildOrsAirportIndex({orsRoutes: new Map()})
    assert.strictEqual(idx2.size, 0)
})

t("buildOrsAirportIndex: aggregates ECONOMY connections at hub + dest", () => {
    const ors = new Map([
        ["LHR-CDG", {hub: "LHR", dest: "CDG", byClass: {ECONOMY: {totalConnections: 100}}}],
        ["LHR-JFK", {hub: "LHR", dest: "JFK", byClass: {ECONOMY: {totalConnections: 60}}}]
    ])
    const idx = mod._buildOrsAirportIndex({orsRoutes: ors})
    assert.strictEqual(idx.get("LHR").connections, 160, "LHR sums both routes")
    assert.strictEqual(idx.get("LHR").routeCount, 2)
    assert.strictEqual(idx.get("CDG").connections, 100)
    assert.strictEqual(idx.get("JFK").connections, 60)
})

t("buildOrsAirportIndex: falls back to byClass.Y when ECONOMY missing", () => {
    const ors = new Map([
        ["LHR-CDG", {hub: "LHR", dest: "CDG", byClass: {Y: {totalConnections: 50}}}]
    ])
    const idx = mod._buildOrsAirportIndex({orsRoutes: ors})
    assert.strictEqual(idx.get("LHR").connections, 50)
})

t("buildOrsAirportIndex: ignores routes with zero connections", () => {
    const ors = new Map([
        ["LHR-CDG", {hub: "LHR", dest: "CDG", byClass: {ECONOMY: {totalConnections: 0}}}],
        ["LHR-JFK", {hub: "LHR", dest: "JFK", byClass: {ECONOMY: {totalConnections: 5}}}]
    ])
    const idx = mod._buildOrsAirportIndex({orsRoutes: ors})
    assert(!idx.has("CDG"))
    assert.strictEqual(idx.get("LHR").connections, 5)
    assert.strictEqual(idx.get("LHR").routeCount, 1)
})

t("hhmmToMin / minToHHMM round-trip", () => {
    assert.strictEqual(mod._hhmmToMin("08:30"), 510)
    assert.strictEqual(mod._hhmmToMin("00:00"), 0)
    assert.strictEqual(mod._hhmmToMin("23:59"), 23 * 60 + 59)
    assert.strictEqual(mod._hhmmToMin("garbage"), null)
    assert.strictEqual(mod._minToHHMM(0), "00:00")
    assert.strictEqual(mod._minToHHMM(510), "08:30")
    assert.strictEqual(mod._minToHHMM(1439), "23:59")
})

let pass = 0, fail = 0
console.log("=== explore-map-view ===")
for (const test of tests) {
    try { test.fn(); console.log("  ok  " + test.name); pass++ }
    catch (e) { console.log("  FAIL " + test.name + ": " + (e && e.message || e)); fail++ }
}
console.log("pass=" + pass + " fail=" + fail)
process.exit(fail ? 1 : 0)
