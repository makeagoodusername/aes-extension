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
        if (e && e.stack) {
            console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
        }
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
        "FlightsFromStore",
        "AesRouteLauncherRanker",
        "RouteAssistantDemandStore"
    ]) {
        try { delete global[name] } catch (_) {}
    }
    global.window = global
    global.chrome = makeChromeStub()
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

function loadRanker() {
    load("modules/flightsfrom/data-store.js", ["FlightsFromStore"])
    load("modules/route-launcher/destination-ranker.js", ["AesRouteLauncherRanker"])
}

function sampleRecord() {
    return {
        iata: "JFK",
        airportName: "New York John F. Kennedy",
        scrapedAt: Date.UTC(2026, 3, 30),
        routes: [
            {
                destIata: "ORD",
                destName: "Chicago O'Hare",
                weeklyFlights: 380,
                seatsPerWeek: 61000,
                distanceKm: 1188,
                airlineCount: 9
            },
            {
                destIata: "LAX",
                destName: "Los Angeles",
                weeklyFlights: 231,
                seatsPerWeek: 44000,
                distanceKm: 3983,
                airlineCount: 7
            },
            {
                destIata: "SFO",
                destName: "San Francisco",
                weeklyFlights: 126,
                seatsPerWeek: 26000,
                distanceKm: 4160,
                airlineCount: 5
            }
        ]
    }
}

console.log("=== Route Launcher destination ranker ===")

;(async () => {
    await it("uses FlightsFrom demand when Route Assistant demand is missing", async () => {
        reset()
        loadRanker()
        global.RouteAssistantDemandStore = { getMany: async () => new Map() }

        await FlightsFromStore.saveAirport(sampleRecord())
        const ranked = await AesRouteLauncherRanker.rank("free1", "JFK", {skipCache: true})
        const ord = ranked.entries.find(r => r.destIata === "ORD")
        const lax = ranked.entries.find(r => r.destIata === "LAX")
        const sfo = ranked.entries.find(r => r.destIata === "SFO")

        assert.strictEqual(ranked.source, "computed")
        assert.strictEqual(ranked.entries.length, 3)
        assert.strictEqual(ord.hasDemandData, true)
        assert.strictEqual(ord.paxScore, 10)
        assert.strictEqual(ord.demandSource, "flightsfrom")
        assert.match(ord.demandBasis, /380 flights\/wk/)
        assert.strictEqual(lax.paxScore, 10)
        assert.strictEqual(sfo.paxScore, 7)
        assert.ok(ord.score > sfo.score, "busiest FlightsFrom route ranks higher")
    })

    await it("keeps Route Assistant demand authoritative over FlightsFrom fallback", async () => {
        reset()
        loadRanker()
        global.RouteAssistantDemandStore = {
            getMany: async () => new Map([
                ["LAX", {
                    iata: "LAX",
                    paxScore: 4,
                    cargoScore: 6,
                    demandSource: "route-assistant",
                    demandBasis: "AS demand bars"
                }]
            ])
        }

        await FlightsFromStore.saveAirport(sampleRecord())
        const ranked = await AesRouteLauncherRanker.rank("free1", "JFK", {skipCache: true})
        const lax = ranked.entries.find(r => r.destIata === "LAX")
        const ord = ranked.entries.find(r => r.destIata === "ORD")

        assert.strictEqual(lax.hasDemandData, true)
        assert.strictEqual(lax.paxScore, 4)
        assert.strictEqual(lax.cargoScore, 6)
        assert.strictEqual(lax.demandSource, "route-assistant")
        assert.strictEqual(lax.demandBasis, "AS demand bars")
        assert.strictEqual(ord.demandSource, "flightsfrom")
        assert.ok(ord.score > lax.score, "FlightsFrom fallback still scores other destinations")
    })

    await it("recomputes old cache entries that predate FlightsFrom demand fallback", async () => {
        reset()
        loadRanker()
        global.RouteAssistantDemandStore = { getMany: async () => new Map() }

        await FlightsFromStore.saveAirport(sampleRecord())
        await chrome.storage.local.set({
            "routeLauncher:rankCache:free1:JFK": {
                entries: [{
                    destIata: "LAX",
                    hasDemandData: false,
                    paxScore: null,
                    cargoScore: null,
                    score: 12,
                    weeklyFlights: 231
                }],
                source: "computed",
                hub: "JFK",
                computedAt: Date.now()
            }
        })

        const ranked = await AesRouteLauncherRanker.rank("free1", "JFK")
        const lax = ranked.entries.find(r => r.destIata === "LAX")

        assert.strictEqual(ranked.schemaVersion, AesRouteLauncherRanker.CACHE_SCHEMA_VERSION)
        assert.strictEqual(lax.hasDemandData, true)
        assert.strictEqual(lax.demandSource, "flightsfrom")
        assert.strictEqual(lax.paxScore, 10)
    })

    console.log("\nRoute Launcher destination ranker: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
