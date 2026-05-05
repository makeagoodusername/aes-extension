"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

let pass = 0
let fail = 0

async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
    }
}

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
        "AesAfp", "AesAfpSpecResolver", "CentralHubBus"
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
        ctx: {currentLocationIata: "JFK"},
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
            {destIata: "MCO", destName: "Orlando",     weeklyFlights: 105, distanceKm: 1520, airlines: ["B6", "DL"]},
            {destIata: "ISP", destName: "Islip",       weeklyFlights: 14,  distanceKm: 64,   airlines: ["WN", "F9"]}
        ]
    }
}

const scoring = {
    paxScore:      {enabled: true, weight: 2, direction: "higher"},
    cargoScore:    {enabled: true, weight: 1, direction: "higher"},
    weeklyFlights: {enabled: true, weight: 1, direction: "higher"},
    airlineCount:  {enabled: true, weight: 1, direction: "lower"}
}

console.log("=== FlightsFrom demand fallback ===")

;(async () => {
    await it("publishes FlightsFrom topRoutes fallback for canvas and downstream consumers", async () => {
        reset()
        load("modules/flightsfrom/data-store.js")

        await FlightsFromStore.saveAirport(sampleRecord())
        const out = await chrome.storage.local.get(["routeAssistant:topRoutes:JFK", "routeAssistant:topRoutes"])
        const hubBlob = out["routeAssistant:topRoutes:JFK"]

        assert.ok(hubBlob, "per-hub topRoutes blob written")
        assert.strictEqual(hubBlob.source, "flightsfrom")
        assert.strictEqual(hubBlob.rows[0].destIata, "LAX")
        assert.strictEqual(hubBlob.rows[0].paxScore, 10)
        assert.strictEqual(out["routeAssistant:topRoutes"].hub, "JFK")
    })

    await it("Route Assistant rows use real FlightsFrom frequency when AS demand is missing", async () => {
        reset()
        load("modules/flightsfrom/data-store.js")
        load("modules/route-assistant/aggregator.js", ["RouteAssistantAggregator"])

        const rows = RouteAssistantAggregator.buildRouteRows({
            hubIata: "JFK",
            ffData: sampleRecord(),
            demandMap: new Map()
        })
        const lax = rows.find(r => r.destIata === "LAX")
        const mco = rows.find(r => r.destIata === "MCO")
        const isp = rows.find(r => r.destIata === "ISP")

        assert.strictEqual(lax.paxScore, 10)
        assert.strictEqual(mco.paxScore, 8)
        assert.strictEqual(isp.paxScore, 3)
        assert.strictEqual(lax.demandSource, "flightsfrom")
        assert.match(lax.demandBasis, /231 flights\/wk/)
    })

    await it("AS demand cache still wins over the FlightsFrom fallback", async () => {
        reset()
        load("modules/flightsfrom/data-store.js")
        load("modules/route-assistant/aggregator.js", ["RouteAssistantAggregator"])

        const rows = RouteAssistantAggregator.buildRouteRows({
            hubIata: "JFK",
            ffData: sampleRecord(),
            demandMap: new Map([["LAX", {iata: "LAX", paxScore: 4, cargoScore: 6, airportId: "123"}]])
        })
        const lax = rows.find(r => r.destIata === "LAX")

        assert.strictEqual(lax.paxScore, 4)
        assert.strictEqual(lax.cargoScore, 6)
        assert.strictEqual(lax.demandSource, "route-assistant")
    })

    await it("AFP candidate queue scores and labels routes from FlightsFrom demand", async () => {
        reset()
        loadCore()
        await FlightsFromStore.saveAirport(sampleRecord())

        const rows = await AesAfpRouteCandidates.compute({
            originIata: "JFK",
            spec: {range: 10000, cruiseSpeedKmh: 840},
            settings: {scoring},
            scheduledDestSet: new Set(),
            scheduledFlightIds: new Set(),
            scheduleLegs: []
        })

        const lax = rows.find(r => r.destIata === "LAX")
        const isp = rows.find(r => r.destIata === "ISP")

        assert.ok(rows.length >= 3, "candidates computed")
        assert.strictEqual(lax.paxScore, 10)
        assert.strictEqual(isp.paxScore, 3)
        assert.strictEqual(lax.demandSource, "flightsfrom")
        assert.ok(lax.scoreBlend > isp.scoreBlend, "high-frequency route scores higher")
        assert.ok(lax.notes.some(n => /FlightsFrom frequency/.test(n)), "row explains fallback source")
    })

    await it("AFP candidate queue falls back to cached route intel when FlightsFrom is empty", async () => {
        reset()
        loadCore()

        await chrome.storage.local.set({
            "routeAssistant:ticketPrice:acct:test:JFK-ALM": {
                hub: "JFK",
                dest: "ALM",
                weeklyFlights: 0,
                departureTime: "23:05"
            },
            "routeAssistant:markets:ownPricing:acct:test:JFK-ALM": {
                hub: "JFK",
                dest: "ALM",
                prices: {Y: 253}
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

        const alm = rows.find(r => r.destIata === "ALM")
        assert.ok(alm, "ALM candidate computed from cached route intel")
        assert.strictEqual(alm.originIata, "JFK")
        assert.strictEqual(alm.paxScore, 5)
        assert.strictEqual(alm.demandSource, "pricing cache")
        assert.strictEqual(alm.suggestedDepTime, "23:05")
        assert.ok(alm.notes.some(n => /Cached own-pricing route|Cached ticket-price route|cached route intel/i.test(n)),
            "row explains cached fallback source")
    })

    console.log("\nFlightsFrom demand fallback: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
