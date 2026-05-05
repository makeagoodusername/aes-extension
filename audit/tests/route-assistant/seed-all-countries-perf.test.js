"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function installWindow() {
    global.window = global
    global.console = console
}

function evalFile(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
}

function makeStorage() {
    const store = new Map()
    const calls = []
    return {
        calls,
        async get(keys) {
            if (keys == null) {
                const out = {}
                for (const [k, v] of store) out[k] = v
                return out
            }
            const list = Array.isArray(keys)
                ? keys
                : (typeof keys === "string" ? [keys] : Object.keys(keys || {}))
            const out = {}
            for (const k of list) if (store.has(k)) out[k] = store.get(k)
            return out
        },
        async set(items) {
            calls.push(Object.keys(items))
            for (const k in items) store.set(k, items[k])
        },
        async remove(keys) {
            for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k)
        },
        size() { return store.size },
        getRaw(key) { return store.get(key) }
    }
}

function makeIata(n) {
    const a = Math.floor(n / (26 * 26)) % 26
    const b = Math.floor(n / 26) % 26
    const c = n % 26
    return String.fromCharCode(65 + a, 65 + b, 65 + c)
}

async function testChunkedDemandWrites() {
    installWindow()
    const storage = makeStorage()
    global.chrome = {storage: {local: storage}}
    delete global.RouteAssistantDemandStore
    evalFile("modules/route-assistant/demand-store.js")

    const airports = []
    for (let i = 0; i < 601; i++) {
        airports.push({
            iata: makeIata(i),
            name: "Airport " + i,
            airportId: String(i),
            sizeScore: 5,
            paxScore: 6,
            cargoScore: 7
        })
    }

    await RouteAssistantDemandStore.saveCountryAirports("99", airports, {countryName: "Exampleland"})

    assert.strictEqual(storage.size(), 601)
    assert.strictEqual(storage.calls.length, 3)
    assert.deepStrictEqual(storage.calls.map(c => c.length), [250, 250, 101])
    assert.strictEqual(
        storage.getRaw("routeAssistant:demand:AAA").countryName,
        "Exampleland"
    )
}

async function testSeedAllCountriesParallelism() {
    installWindow()
    global.chrome = {storage: {local: makeStorage()}}
    global.RouteAssistantCountryResolver = class {
        constructor() {}
    }
    const saved = []
    global.RouteAssistantDemandStore = {
        async saveCountryAirports(countryId, airports) {
            saved.push({countryId, count: airports.length})
        }
    }

    let active = 0
    let maxActive = 0
    global.CountryScraper = {
        async loadCountriesList() {
            return [
                {id: "1", name: "One"},
                {id: "2", name: "Two"},
                {id: "3", name: "Three"},
                {id: "4", name: "Four"},
                {id: "5", name: "Five"}
            ]
        },
        async _getAllAirportsForCountry(id) {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise(resolve => setTimeout(resolve, 5))
            active--
            return [{iata: "A" + id, name: "Airport " + id, paxScore: 5, cargoScore: 5}]
        }
    }

    delete global.RouteAssistantParallelScanner
    evalFile("modules/route-assistant/parallel-scanner.js")
    const scanner = new RouteAssistantParallelScanner("free1", {concurrency: 3, staggerMs: 0})
    const result = await scanner.seedAllCountries()

    assert.ok(maxActive > 1, "seedAllCountries should run more than one country fetch at once")
    assert.ok(maxActive <= 3, "seedAllCountries should respect the configured concurrency")
    assert.strictEqual(result.fetched, 5)
    assert.strictEqual(saved.length, 5)
}

;(async function () {
    await testChunkedDemandWrites()
    await testSeedAllCountriesParallelism()
    console.log("seed-all-countries perf tests passed")
})().catch(err => {
    console.error(err)
    process.exit(1)
})
