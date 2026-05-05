"use strict"

/**
 * Smoke for the new explore-map overlays (slices 6/7/8) + the slice-5
 * iata-backfill store. Targets the pure helpers; render is DOM-bound and
 * remains covered by live verification.
 *
 * Lives at audit/ root rather than audit/tests/competitor-intel/ because
 * audit/tests/ is root-owned in this checkout (see audit/critical-outcomes-matrix.md).
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

const ROOT = path.resolve(__dirname, "..")

function load(filename, sandbox) {
    const src = fs.readFileSync(path.resolve(ROOT, filename), "utf8")
    if (!sandbox._ctx) {
        vm.createContext(sandbox)
        sandbox._ctx = true
    }
    vm.runInContext(src, sandbox, {filename})
}

function makeSandbox() {
    const window = {}
    return {
        window,
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
const view = sb.window.AesCompetitorIntelExploreMapView
assert(view, "explore-map-view module loaded")
assert(typeof view._buildAllianceAirportIndex === "function", "alliance helper exported")
assert(typeof view._buildOurNetworkAirportIndex === "function", "our-network helper exported")
assert(typeof view._buildDemandAirportIndex === "function", "demand helper exported")
assert(typeof view._allianceColor === "function", "allianceColor helper exported")

const tests = []
function t(name, fn) { tests.push({name, fn}) }

function makeAirportIndexWith(carrierIds) {
    const out = new Map()
    for (const iata in carrierIds) {
        const carriers = new Map()
        for (const id of carrierIds[iata]) {
            carriers.set(String(id), {enterpriseId: String(id)})
        }
        out.set(iata, {iata, carriers})
    }
    return out
}

// ---- Slice 6 — alliance overlay -----------------------------------------

t("alliance: empty when no enterprises carry alliance", () => {
    const data = {enterprises: new Map([
        ["1", {enterpriseId: "1", alliance: null}],
        ["2", {enterpriseId: "2"}]
    ])}
    const airIdx = makeAirportIndexWith({JFK: ["1", "2"]})
    const slot = view._buildAllianceAirportIndex(data, airIdx).get("JFK")
    assert.strictEqual(slot.distinctCount, 0)
    assert.strictEqual(slot.totalAffiliated, 0)
    assert.strictEqual(slot.dominantId, null)
})

t("alliance: dominant alliance picks the most members at the airport", () => {
    const data = {enterprises: new Map([
        ["1", {enterpriseId: "1", alliance: {id: "A", name: "Star"}}],
        ["2", {enterpriseId: "2", alliance: {id: "A", name: "Star"}}],
        ["3", {enterpriseId: "3", alliance: {id: "B", name: "OneWorld"}}]
    ])}
    const airIdx = makeAirportIndexWith({JFK: ["1", "2", "3"]})
    const slot = view._buildAllianceAirportIndex(data, airIdx).get("JFK")
    assert.strictEqual(slot.distinctCount, 2)
    assert.strictEqual(slot.dominantId, "A")
    assert.strictEqual(slot.dominantName, "Star")
    assert.strictEqual(slot.dominantCount, 2)
    assert.strictEqual(slot.totalAffiliated, 3)
})

t("alliance: airports without overlapping enterprises don't claim alliances", () => {
    const data = {enterprises: new Map([
        ["1", {enterpriseId: "1", alliance: {id: "A", name: "Star"}}]
    ])}
    const airIdx = makeAirportIndexWith({JFK: ["1"], LAX: ["2"]})
    const out = view._buildAllianceAirportIndex(data, airIdx)
    const lax = out.get("LAX")
    assert.strictEqual(lax.distinctCount, 0, "LAX has no allied carrier in cache")
    assert.strictEqual(lax.dominantId, null)
})

t("alliance: rejects malformed envelopes", () => {
    assert.strictEqual(view._buildAllianceAirportIndex({}, makeAirportIndexWith({})).size, 0)
    assert.strictEqual(view._buildAllianceAirportIndex({enterprises: null}, null).size, 0)
})

t("allianceColor: stable id → stable colour, distinct ids → distinct colours", () => {
    const a = view._allianceColor("alliance-A")
    const a2 = view._allianceColor("alliance-A")
    const b = view._allianceColor("alliance-B")
    assert.strictEqual(a.fill, a2.fill, "stable mapping")
    assert.notStrictEqual(a.fill, "#475569", "non-null id is not the slate fallback")
    assert.notStrictEqual(a.fill, b.fill, "different ids → different palette slots")
    assert.strictEqual(view._allianceColor(null).fill, "#475569", "null id → slate")
})

// ---- Slice 7 — our network overlay (pass-through) -----------------------

t("ourNetwork: returns empty when ourSchedule absent or invalid", () => {
    assert.strictEqual(view._buildOurNetworkAirportIndex({}).size, 0)
    assert.strictEqual(view._buildOurNetworkAirportIndex({ourSchedule: "garbage"}).size, 0)
    assert.strictEqual(view._buildOurNetworkAirportIndex({ourSchedule: null}).size, 0)
})

t("ourNetwork: passes through caller-supplied Map by reference", () => {
    const m = new Map([["JFK", {totalLegs: 14, departures: 7, arrivals: 7, aircraftIds: new Set(["a"])}]])
    const out = view._buildOurNetworkAirportIndex({ourSchedule: m})
    assert.strictEqual(out, m, "no copy — reference passes through")
    assert.strictEqual(out.get("JFK").totalLegs, 14)
})

// ---- Slice 8 — demand overlay (pass-through) ----------------------------

t("demand: returns empty when demand absent", () => {
    assert.strictEqual(view._buildDemandAirportIndex({}).size, 0)
})

t("demand: passes through caller-supplied Map", () => {
    const m = new Map([["LHR", {paxScore: 10, sizeScore: 9, cargoScore: 5, scrapedAt: 1}]])
    const out = view._buildDemandAirportIndex({demand: m})
    assert.strictEqual(out, m)
    assert.strictEqual(out.get("LHR").paxScore, 10)
})

// ---- Slice 5 — iata-backfill projection ---------------------------------

const sb2 = makeSandbox()
load("modules/competitor-intel/iata-backfill-store.js", sb2)
const back = sb2.window.AesCompetitorIataBackfill
assert(back, "iata-backfill module loaded")

t("iata-backfill: norm + reject", () => {
    assert.strictEqual(back._normIata("ba"), "BA")
    assert.strictEqual(back._normIata("WWW"), "WWW")
    assert.strictEqual(back._normIata("toolong"), null)
    assert.strictEqual(back._normIata(""), null)
    assert.strictEqual(back._normEnterpriseId("12345"), "12345")
    assert.strictEqual(back._normEnterpriseId("iata:WW"), null)
    assert.strictEqual(back._normEnterpriseId(null), null)
})

t("iata-backfill: projectFromEnterprises emits one triple per real (iata,id) pair", () => {
    const ents = new Map([
        ["77", {enterpriseId: "77", iata: "BA", name: "British Airways"}],
        ["88", {enterpriseId: "88", iata: "lh", name: "Lufthansa"}],
        ["iata:XX", {enterpriseId: "iata:XX", iata: "XX"}],         // synthetic — skip
        ["99", {enterpriseId: "99", name: "no-iata"}]               // missing iata — skip
    ])
    const out = back.projectFromEnterprises(ents)
    assert.strictEqual(out.length, 2)
    out.sort((a, b) => a.iata.localeCompare(b.iata))
    assert.strictEqual(out[0].iata, "BA")
    assert.strictEqual(out[0].enterpriseId, "77")
    assert.strictEqual(out[1].iata, "LH")
    assert.strictEqual(out[1].enterpriseId, "88")
})

// ---- host.js — _buildOurScheduleIndex + _buildDemandIndex --------------

const sbHost = {
    window: {AesCompetitorStore: {}, AesCompetitorIataBackfill: null},
    chrome: {storage: {local: {get: () => Promise.resolve({})}}},
    console
}
load("modules/competitor-intel/host.js", sbHost)
const host = sbHost.window.AesCompetitorIntelHost
assert(host, "host module loaded")
assert(typeof host._buildOurScheduleIndex === "function", "_buildOurScheduleIndex exported")
assert(typeof host._buildDemandIndex === "function", "_buildDemandIndex exported")

t("host._buildOurScheduleIndex: counts each leg at origin + destination", () => {
    const all = {
        "aircraftFlightPlan:schedule:free1:1": {aircraftId: "1", legs: [
            {origin: "LHR", destination: "CDG"},
            {origin: "CDG", destination: "LHR"},
            {origin: "LHR", destination: "JFK"}
        ]},
        "aircraftFlightPlan:schedule:free1:2": {aircraftId: "2", legs: [
            {origin: "LHR", destination: "FRA"}
        ]},
        "aircraftFlightPlan:schedule:other-server:9": {aircraftId: "9", legs: [
            {origin: "LHR", destination: "JFK"}
        ]},
        "irrelevant": {legs: []}
    }
    const out = host._buildOurScheduleIndex("free1", all)
    assert.strictEqual(out.get("LHR").totalLegs, 4)
    assert.strictEqual(out.get("LHR").departures, 3)
    assert.strictEqual(out.get("LHR").arrivals, 1)
    assert.strictEqual(out.get("LHR").aircraftIds.size, 2)
    assert.strictEqual(out.get("CDG").totalLegs, 2)
    assert.strictEqual(out.get("JFK").totalLegs, 1)
    assert.strictEqual(out.get("FRA").totalLegs, 1)
    assert(!out.has("other-iata"))
})

t("host._buildOurScheduleIndex: empty when wrong server / missing legs", () => {
    assert.strictEqual(host._buildOurScheduleIndex(null, {}).size, 0)
    assert.strictEqual(host._buildOurScheduleIndex("free1", null).size, 0)
    const all = {"aircraftFlightPlan:schedule:free1:1": {aircraftId: "1", legs: null}}
    assert.strictEqual(host._buildOurScheduleIndex("free1", all).size, 0)
})

t("host._buildOurScheduleIndex: rejects malformed iata in legs", () => {
    const all = {"aircraftFlightPlan:schedule:free1:1": {aircraftId: "1", legs: [
        {origin: "lhr", destination: "JFK"},        // lower-case → upper-cased → kept
        {origin: "TOO_LONG", destination: "FRA"}    // bad → only FRA counted
    ]}}
    const out = host._buildOurScheduleIndex("free1", all)
    assert.strictEqual(out.get("LHR").totalLegs, 1)
    assert.strictEqual(out.get("JFK").totalLegs, 1)
    assert.strictEqual(out.get("FRA").totalLegs, 1)
})

t("host._buildDemandIndex: pulls pax/size/cargo + skips empties", () => {
    const all = {
        "routeAssistant:demand:LHR": {iata: "LHR", paxScore: 10, sizeScore: 9, cargoScore: 5, scrapedAt: 100},
        "routeAssistant:demand:JFK": {iata: "JFK", paxScore: 8, sizeScore: 10, cargoScore: 7, scrapedAt: 110},
        "routeAssistant:demand:XXX": {iata: "XXX"},                  // all scoring fields missing → skip
        "unrelated":                {paxScore: 5, sizeScore: 5}      // wrong prefix → skip
    }
    const out = host._buildDemandIndex(all)
    assert.strictEqual(out.size, 2)
    assert.strictEqual(out.get("LHR").paxScore, 10)
    assert.strictEqual(out.get("JFK").sizeScore, 10)
    assert(!out.has("XXX"))
})

t("host._buildDemandIndex: handles missing iata via key suffix", () => {
    const all = {"routeAssistant:demand:CDG": {paxScore: 6, sizeScore: 7}}
    const out = host._buildDemandIndex(all)
    assert.strictEqual(out.size, 1)
    assert.strictEqual(out.get("CDG").paxScore, 6)
})

let pass = 0, fail = 0
console.log("=== explore-map overlays + iata-backfill ===")
for (const test of tests) {
    try { test.fn(); console.log("  ok  " + test.name); pass++ }
    catch (e) { console.log("  FAIL " + test.name + ": " + (e && e.message || e)); fail++ }
}
console.log("pass=" + pass + " fail=" + fail)
process.exit(fail ? 1 : 0)
