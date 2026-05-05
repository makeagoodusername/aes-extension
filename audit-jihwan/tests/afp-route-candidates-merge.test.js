"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

function makeChromeStub() {
    const store = new Map()
    return {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) {
                        const out = {}
                        for (const [k, v] of store) out[k] = v
                        return out
                    }
                    if (typeof keys === "string") {
                        const out = {}
                        if (store.has(keys)) out[keys] = store.get(keys)
                        return out
                    }
                    const out = {}
                    for (const k of keys || []) if (store.has(k)) out[k] = store.get(k)
                    return out
                },
                async set(items) {
                    for (const k in items) store.set(k, items[k])
                },
                async remove(keys) {
                    for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
                },
                _store: store
            },
            onChanged: { addListener() {}, removeListener() {} }
        },
        runtime: { id: "test" }
    }
}

function reset() {
    for (const name of [
        "FlightsFromStore", "RouteAssistantScore", "RouteAssistantAggregator",
        "AesAfpRouteCandidates", "RouteAssistantDemandStore", "ScheduleFactors",
        "AesAfp"
    ]) {
        try { delete global[name] } catch (_) {}
    }
    global.window = global
    global.document = {
        readyState: "complete",
        addEventListener() {},
        querySelector() { return null },
        querySelectorAll() { return [] }
    }
    global.chrome = makeChromeStub()
    global.AesAfp = {
        ctx: {server: "free1", airlineCode: "CFA", currentLocationIata: "JFK"},
        getActiveHub() { return "JFK" },
        slot() { return null },
        bus: { on() {}, off() {}, emit() {} }
    }
    global.ScheduleFactors = {
        kmToNm(km) { return km * 0.539957 },
        aircraftCanFly(rangeNm, distanceNm) { return distanceNm <= rangeNm }
    }
}

function load(rel, exposeNames) {
    let src = fs.readFileSync(path.join(ROOT, rel), "utf8")
    if (Array.isArray(exposeNames) && exposeNames.length) {
        src += "\n;(function(){\n"
        for (const name of exposeNames) {
            src += `try { if (typeof ${name} !== "undefined") window.${name} = ${name}; } catch (_) {}\n`
        }
        src += "})();\n"
    }
    eval(src)
}

function loadCore() {
    load("modules/flightsfrom/data-store.js")
    load("modules/route-assistant/score.js", ["RouteAssistantScore"])
    load("modules/route-assistant/aggregator.js", ["RouteAssistantAggregator"])
    global.RouteAssistantDemandStore = { getMany: async () => new Map() }
    load("modules/aircraft-flight-plan/route-candidates.js")
}

function sampleRecord() {
    return {
        iata: "JFK",
        airportName: "All scheduled direct flights from New York (JFK)",
        scrapedAt: Date.UTC(2026, 3, 30),
        routes: [
            {destIata: "LAX", destName: "Los Angeles", weeklyFlights: 231, distanceKm: 3974, airlines: ["AA", "DL"]},
            {destIata: "MCO", destName: "Orlando", weeklyFlights: 105, distanceKm: 1520, airlines: ["B6", "DL"]}
        ]
    }
}

const scoring = {
    paxScore:      {enabled: true, weight: 2, direction: "higher"},
    cargoScore:    {enabled: true, weight: 1, direction: "higher"},
    weeklyFlights: {enabled: true, weight: 1, direction: "higher"},
    airlineCount:  {enabled: true, weight: 1, direction: "lower"},
    liveWeeklyFlights: {enabled: true, weight: 1, direction: "higher"}
}

;(async () => {
    console.log("=== AFP route-candidates source merge ===")
    reset()
    loadCore()
    await FlightsFromStore.saveAirport(sampleRecord())
    await chrome.storage.local.set({
        "routeAssistant:topRoutes:JFK": {
            server: "free1",
            hub: "JFK",
            scrapedAt: Date.UTC(2026, 4, 1),
            rows: [{
                destIata: "SEA",
                destName: "Seattle",
                distanceKm: 3886,
                paxScore: 9,
                cargoScore: 6,
                score: 91,
                weeklyFlights: 12,
                liveWeeklyFlights: 7,
                departureTime: "08:15",
                primaryAircraftType: "Boeing 737-700",
                demandSource: "route-assistant",
                demandBasis: "AS top-routes cache"
            }]
        }
    })

    const rows = await AesAfpRouteCandidates.compute({
        originIata: "JFK",
        spec: {range: 10000, cruiseSpeedKmh: 840},
        settings: {scoring},
        scheduledDestSet: new Set(),
        scheduledFlightIds: new Set(),
        scheduleLegs: []
    })

    const sea = rows.find(r => r.destIata === "SEA")
    const lax = rows.find(r => r.destIata === "LAX")
    assert.ok(sea, "SEA candidate computed from Route Assistant cache")
    assert.ok(lax, "FlightsFrom candidates remain available")
    assert.strictEqual(sea.demandSource, "route-assistant")
    assert.strictEqual(sea.liveWeeklyFlights, 7)
    assert.strictEqual(sea.liveDeparture, "08:15")
    assert.ok(sea.notes.some(n => /In-game schedule: 7\/wk/.test(n)),
        "row explains in-game schedule source")
    console.log("  ok  merges AS in-game cached routes while FlightsFrom exists")
})().catch(err => {
    console.error(err && err.stack || err)
    process.exitCode = 1
})
