"use strict"

/**
 * Smoke for modules/competitor-intel/views/airline-detail-view.js — pure
 * helpers: buildModel, _buildFleetModel, _buildGrowthModel, _realWaveByHub.
 * Render functions are DOM-bound; covered by live verification.
 *
 * Lives under audit-jihwan/tests/ because audit/tests/competitor-intel/ is
 * root-owned in this checkout. Same shape and runner as the existing
 * audit/tests/competitor-intel/explore-map-view.test.js.
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

function load(filename, sandbox) {
    const src = fs.readFileSync(path.resolve(__dirname, "../..", filename), "utf8")
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

const sb = makeSandbox()
load("modules/competitor-intel/views/airline-detail-view.js", sb)
const mod = sb.window.AesCompetitorIntelAirlineDetailView
assert(mod && typeof mod.buildModel === "function", "module loaded with buildModel")
assert(typeof mod._buildFleetModel === "function", "_buildFleetModel exposed")
assert(typeof mod._buildGrowthModel === "function", "_buildGrowthModel exposed")
assert(typeof mod._realWaveByHub === "function", "_realWaveByHub exposed")

const tests = []
function t(name, fn) { tests.push({name, fn}) }

// ---- buildModel -----------------------------------------------------------

t("buildModel returns falsy record when airlineId not in cache", () => {
    const model = mod.buildModel({enterprises: new Map(), snapshots: new Map(), orsRoutes: new Map()}, "999")
    assert(!model.record, "record is falsy when airlineId missing")
    // Cross-realm Array — duck-type via length, not deepStrictEqual.
    assert.strictEqual(model.hubs.length, 0)
    assert.strictEqual(model.routes.length, 0)
    assert.strictEqual(model.ors.length, 0)
})

t("buildModel projects hubs+routes from enterprise record", () => {
    const data = {
        enterprises: new Map([["77", {
            enterpriseId: "77", name: "Test Air", iata: "TA",
            hubs: [{iata: "LHR", weeklyDepartures: 168}, {iata: "JFK", weeklyDepartures: 84}],
            routeFootprint: [
                {hub: "LHR", dest: "JFK", weeklyFlights: 14},
                {hub: "LHR", dest: "CDG", weeklyFlights: 28},
                {hub: "JFK", dest: "LAX", weeklyFlights: 7}
            ]
        }]]),
        snapshots: new Map(),
        orsRoutes: new Map()
    }
    const model = mod.buildModel(data, "77")
    assert.strictEqual(model.record.iata, "TA")
    assert.strictEqual(model.hubs.length, 2)
    assert.strictEqual(model.routes.length, 3)
    assert.strictEqual(model.routes[0].weeklyFlights, 14)
    assert(model.fleet, "fleet shape attached")
    assert(model.growth, "growth shape attached")
})

t("buildModel deduplicates routeFootprint by hub-dest pair", () => {
    const data = {
        enterprises: new Map([["1", {
            enterpriseId: "1", name: "Dup", iata: "DD",
            hubs: [], routeFootprint: [
                {hub: "LHR", dest: "JFK", weeklyFlights: 5},
                {hub: "LHR", dest: "JFK", weeklyFlights: 3}
            ]
        }]]),
        snapshots: new Map(),
        orsRoutes: new Map()
    }
    const model = mod.buildModel(data, "1")
    assert.strictEqual(model.routes.length, 1)
    assert.strictEqual(model.routes[0].weeklyFlights, 5)
})

t("buildModel matches ORS overlay only for routes the airline actually flies", () => {
    const data = {
        enterprises: new Map([["1", {
            enterpriseId: "1", name: "Air1", iata: "A1",
            hubs: [{iata: "LHR"}],
            routeFootprint: [
                {hub: "LHR", dest: "JFK", weeklyFlights: 14},
                {hub: "LHR", dest: "CDG", weeklyFlights: 28}
            ]
        }]]),
        snapshots: new Map(),
        orsRoutes: new Map([
            ["LHR-JFK", {hub: "LHR", dest: "JFK", ourRank: 2, scrapedAt: 1}],
            ["LHR-CDG", {hub: "LHR", dest: "CDG", ourRank: 4, scrapedAt: 2}],
            ["LHR-LAX", {hub: "LHR", dest: "LAX", ourRank: 1, scrapedAt: 3}]
        ])
    }
    const model = mod.buildModel(data, "1")
    assert.strictEqual(model.ors.length, 2, "only matches LHR-JFK and LHR-CDG")
    // Cross-realm Array — convert to plain JSON before comparing.
    const keys = JSON.parse(JSON.stringify(model.ors.map(o => o.key))).sort()
    assert.deepStrictEqual(keys, ["LHR-CDG", "LHR-JFK"])
})

// ---- _buildFleetModel -----------------------------------------------------

t("_buildFleetModel returns empty types when fleetByType absent", () => {
    const fm = mod._buildFleetModel({fleet: {aircraftCount: 12}})
    assert.strictEqual(fm.summary.aircraftCount, 12)
    assert.strictEqual(fm.types.length, 0)
    assert.strictEqual(fm.totalTyped, 0)
    assert.strictEqual(fm.weightedAvgAgeYears, null)
})

t("_buildFleetModel sorts types by count desc and computes share", () => {
    const fm = mod._buildFleetModel({
        fleet: {aircraftCount: 50},
        fleetByType: [
            {typeId: "1", typeCode: "A320", count: 10, avgAgeMonths: 60},
            {typeId: "2", typeCode: "B777", count: 30, avgAgeMonths: 84, oldestMonths: 120, newestMonths: 24},
            {typeId: "3", typeCode: "B787", count: 5}
        ]
    })
    assert.strictEqual(fm.totalTyped, 45)
    assert.strictEqual(fm.types[0].typeCode, "B777")
    assert.strictEqual(fm.types[0].count, 30)
    assert.strictEqual(fm.types[0].share, 0.667)
    assert.strictEqual(fm.types[0].avgAgeYears, 7)
    assert.strictEqual(fm.types[0].oldestYears, 10)
    assert.strictEqual(fm.types[0].newestYears, 2)
    assert.strictEqual(fm.types[2].typeCode, "B787")
    assert.strictEqual(fm.types[2].avgAgeYears, null, "no avgAgeMonths → null")
    assert.strictEqual(fm.missingTypeBreakdown, 5, "50 total - 45 typed = 5 untyped")
})

t("_buildFleetModel weightedAvgAgeYears averages by tail count", () => {
    const fm = mod._buildFleetModel({
        fleet: {aircraftCount: 30},
        fleetByType: [
            {typeId: "1", typeCode: "A", count: 10, avgAgeMonths: 6},
            {typeId: "2", typeCode: "B", count: 20, avgAgeMonths: 12}
        ]
    })
    // weighted: (6*10 + 12*20) / 30 = 300/30 = 10 months → 0.83 years (rounded to 0.8)
    assert(Math.abs(fm.weightedAvgAgeYears - 0.8) < 0.05)
})

t("_buildFleetModel skips zero-count types and rejects non-finite ages", () => {
    const fm = mod._buildFleetModel({
        fleet: {},
        fleetByType: [
            {typeId: "1", typeCode: "X", count: 0, avgAgeMonths: 60},
            {typeId: "2", typeCode: "Y", count: 5, avgAgeMonths: "abc"}
        ]
    })
    assert.strictEqual(fm.types.length, 1)
    assert.strictEqual(fm.types[0].typeCode, "Y")
    assert.strictEqual(fm.types[0].avgAgeYears, null)
})

// ---- _buildGrowthModel ----------------------------------------------------

t("_buildGrowthModel returns zeros when fewer than 2 snapshots in window", () => {
    const g = mod._buildGrowthModel([])
    assert.strictEqual(g.deltas.aircraft, 0)
    assert.strictEqual(g.deltas.hubs, 0)
    assert.strictEqual(g.deltas.routes, 0)
    assert.strictEqual(g.deltas.types, 0)
    assert.strictEqual(g.count, 0)
    const g1 = mod._buildGrowthModel([{at: Date.now(), aircraftCount: 10, hubCount: 1, routeCount: 5, fleetTypeCount: 2}])
    assert.strictEqual(g1.deltas.aircraft, 0)
    assert.strictEqual(g1.deltas.hubs, 0)
    assert.strictEqual(g1.deltas.routes, 0)
    assert.strictEqual(g1.deltas.types, 0)
    assert.strictEqual(g1.count, 1)
})

t("_buildGrowthModel computes deltas across the 30d window", () => {
    const now = Date.now()
    const snapshots = [
        {at: now - 60 * 86400000, aircraftCount: 1, hubCount: 1, routeCount: 1, fleetTypeCount: 1},
        {at: now - 25 * 86400000, aircraftCount: 10, hubCount: 2, routeCount: 5, fleetTypeCount: 3},
        {at: now - 5 * 86400000,  aircraftCount: 15, hubCount: 3, routeCount: 12, fleetTypeCount: 4}
    ]
    const g = mod._buildGrowthModel(snapshots)
    assert.strictEqual(g.deltas.aircraft, 5)
    assert.strictEqual(g.deltas.hubs, 1)
    assert.strictEqual(g.deltas.routes, 7)
    assert.strictEqual(g.deltas.types, 1)
    assert.strictEqual(g.count, 3)
})

t("_buildGrowthModel handles snapshots with missing fields safely", () => {
    const now = Date.now()
    const g = mod._buildGrowthModel([
        {at: now - 20 * 86400000, aircraftCount: 5},
        {at: now - 5 * 86400000,  aircraftCount: 7, routeCount: 4}
    ])
    assert.strictEqual(g.deltas.aircraft, 2)
    assert.strictEqual(g.deltas.routes, 0, "missing field on either side → 0")
})

// ---- _realWaveByHub -------------------------------------------------------

t("_realWaveByHub buckets BA flights from LHR by UTC hour", () => {
    const records = [
        {hub: "LHR", dest: "JFK", competitors: [
            {flightCode: "BA 178", depTimeUtc: "06:30", flightId: "1"},
            {flightCode: "BA 178", depTimeUtc: "06:30", flightId: "1"},
            {flightCode: "BA 252", depTimeUtc: "14:15", flightId: "2"},
            {flightCode: "AF 380", depTimeUtc: "09:00", flightId: "3"}
        ]}
    ]
    const wave = mod._realWaveByHub(records, "BA")
    const lhr = wave.get("LHR")
    assert(lhr, "LHR slot present")
    assert.strictEqual(lhr.total, 2, "2 unique BA departures")
    assert.strictEqual(lhr.hours[6], 1, "06:30 → hour bucket 6")
    assert.strictEqual(lhr.hours[14], 1, "14:15 → hour bucket 14")
})

t("_realWaveByHub respects allowed hubs filter", () => {
    const records = [
        {hub: "LHR", dest: "JFK", competitors: [{flightCode: "BA 1", depTimeUtc: "08:00", flightId: "a"}]},
        {hub: "MAN", dest: "JFK", competitors: [{flightCode: "BA 2", depTimeUtc: "09:00", flightId: "b"}]}
    ]
    const wave = mod._realWaveByHub(records, "BA", ["LHR"])
    assert.strictEqual(wave.size, 1)
    assert(wave.has("LHR"))
    assert(!wave.has("MAN"))
})

t("_realWaveByHub skips isOurs entries and bad codes", () => {
    const records = [
        {hub: "LHR", dest: "JFK", competitors: [
            {flightCode: "BA 1", depTimeUtc: "06:00", flightId: "a", isOurs: true},
            {flightCode: "BA1",  depTimeUtc: "07:00", flightId: "b"},
            {flightCode: "garbage", depTimeUtc: "08:00", flightId: "c"}
        ]}
    ]
    const wave = mod._realWaveByHub(records, "BA")
    assert.strictEqual(wave.get("LHR").total, 1, "only the second row counts")
    assert.strictEqual(wave.get("LHR").hours[7], 1)
})

t("_realWaveByHub counts last7d when depDateUtc is recent", () => {
    const now = Date.UTC(2026, 4, 3, 12, 0, 0)
    const todayStr = "2026-05-02"
    const oldStr = "2025-12-01"
    const records = [
        {hub: "LHR", dest: "JFK", competitors: [
            {flightCode: "BA 1", depTimeUtc: "06:00", depDateUtc: todayStr, flightId: "a"},
            {flightCode: "BA 2", depTimeUtc: "07:00", depDateUtc: oldStr,   flightId: "b"}
        ]}
    ]
    const wave = mod._realWaveByHub(records, "BA", null, now)
    assert.strictEqual(wave.get("LHR").total, 2)
    assert.strictEqual(wave.get("LHR").last7d, 1, "only the recent dep counted as last7d")
})

t("_realWaveByHub returns empty Map for invalid IATA", () => {
    const wave = mod._realWaveByHub([], "")
    assert.strictEqual(wave.size, 0)
    const wave2 = mod._realWaveByHub([], "TOOLONG")
    assert.strictEqual(wave2.size, 0)
})

t("_realWaveByHub handles 3-letter carrier prefixes (e.g. WWW)", () => {
    const records = [
        {hub: "LHR", dest: "JFK", competitors: [
            {flightCode: "WWW 1", depTimeUtc: "10:00", flightId: "a"},
            {flightCode: "BA 1",  depTimeUtc: "11:00", flightId: "b"}
        ]}
    ]
    const wave = mod._realWaveByHub(records, "WWW")
    assert.strictEqual(wave.get("LHR").total, 1)
    assert.strictEqual(wave.get("LHR").hours[10], 1)
})

// ---- iata-backfill projectFromEdges --------------------------------------

const sb2 = makeSandbox()
load("modules/competitor-intel/iata-backfill-store.js", sb2)
const ibf = sb2.window.AesCompetitorIataBackfill
assert(ibf && typeof ibf.projectFromEdges === "function", "projectFromEdges exposed")

t("projectFromEdges captures (iata, enterpriseId, name) when both present", () => {
    const edges = new Map([
        ["LHR-JFK", {hub: "LHR", dest: "JFK", competitors: [
            {enterpriseId: "100", iata: "BA", name: "British"},
            {enterpriseId: "iata:WWW", iata: "WWW"}     // synthetic id rejected
        ]}],
        ["JFK-CDG", {hub: "JFK", dest: "CDG", competitors: [
            {iata: "AF"},                               // no id rejected
            {enterpriseId: "200", iata: "BA"}            // dup IATA — first wins
        ]}]
    ])
    const out = ibf.projectFromEdges(edges)
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].iata, "BA")
    assert.strictEqual(out[0].enterpriseId, "100")
    assert.strictEqual(out[0].name, "British")
})

t("projectFromEdges returns empty for unparseable input", () => {
    assert.strictEqual(ibf.projectFromEdges(null).length, 0)
    assert.strictEqual(ibf.projectFromEdges(undefined).length, 0)
    assert.strictEqual(ibf.projectFromEdges({}).length, 0, "non-Map → empty")
})

let pass = 0, fail = 0
console.log("=== airline-detail-view ===")
for (const test of tests) {
    try { test.fn(); console.log("  ok  " + test.name); pass++ }
    catch (e) { console.log("  FAIL " + test.name + ": " + (e && e.message || e)); fail++ }
}
console.log("pass=" + pass + " fail=" + fail)
process.exit(fail ? 1 : 0)
