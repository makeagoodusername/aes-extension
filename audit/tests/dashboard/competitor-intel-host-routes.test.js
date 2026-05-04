"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

console.log("=== competitor-intel-host-routes ===")

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

function summary() {
    console.log("\ncompetitor-intel-host-routes: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
}

function installChromeStorage(seed) {
    const store = Object.assign({}, seed || {})
    global.chrome = {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) return Object.assign({}, store)
                    if (typeof keys === "string") return {[keys]: store[keys]}
                    if (Array.isArray(keys)) {
                        const out = {}
                        for (const k of keys) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]
                        return out
                    }
                    const out = {}
                    for (const k in keys || {}) out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : keys[k]
                    return out
                },
                async set(obj) { Object.assign(store, obj || {}) },
                async remove(keys) {
                    for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
                }
            }
        }
    }
    return store
}

function installHost(seed) {
    installChromeStorage(seed)
    global.window = {}
    global.AES = {getServerName() { return "free1" }}
    const src = fs.readFileSync(path.join(ROOT, "modules/competitor-intel/host.js"), "utf8")
    eval(src)
    assert(window.AesCompetitorIntelHost, "host export installed")
    return window.AesCompetitorIntelHost
}

function enterprise(id, name, iata, footprint) {
    return {
        server: "free1",
        enterpriseId: String(id),
        name,
        iata,
        scrapedAt: 1777600000000 + Number(id),
        routeFootprint: footprint
    }
}

;(async () => {
    await it("derives route rows from native enterprise routeFootprints", async () => {
        const seed = {
            "competitorIntel:enterprise:free1:930": enterprise("930", "Mr White Air", "MRW", [
                {hub: "JFK", dest: "ORD", weeklyFlights: 7},
                {hub: "JFK", dest: "ATL", weeklyFlights: 14}
            ]),
            "competitorIntel:enterprise:free1:931": enterprise("931", "Other Air", "OTH", [
                {origin: "JFK", destination: "ORD", frequency: 3},
                {hub: "JFK", dest: "JFK", weeklyFlights: 99}
            ])
        }
        const Host = installHost(seed)
        const data = await Host.loadServerData("free1")

        assert.strictEqual(data.enterprises.size, 2)
        assert.strictEqual(data.edges.size, 2)

        const ord = data.edges.get("JFK-ORD")
        assert(ord, "JFK-ORD edge exists")
        assert.strictEqual(ord.source, "enterpriseRouteFootprint")
        assert.strictEqual(ord.totals.totalWeeklyFlights, 10)
        assert.deepStrictEqual(ord.competitors.map(c => c.iata).sort(), ["MRW", "OTH"])

        const atl = data.edges.get("JFK-ATL")
        assert(atl, "JFK-ATL edge exists")
        assert.strictEqual(atl.competitors[0].enterpriseId, "930")
        assert.strictEqual(atl.totals.totalWeeklyFlights, 14)
    })

    await it("adds footprint competitors to cached market edges without overwriting market totals", async () => {
        const seed = {
            "competitorIntel:enterprise:free1:930": enterprise("930", "Mr White Air", "MRW", [
                {hub: "JFK", dest: "ORD", weeklyFlights: 7}
            ]),
            "competitorIntel:edge:free1:JFK-ORD": {
                server: "free1",
                hub: "JFK",
                dest: "ORD",
                scrapedAt: 1777600000000,
                source: "routeAssistantMarkets",
                competitors: [{enterpriseId: "999", name: "Market Leader", iata: "MLD", weeklyFlights: 20}],
                totals: {totalWeeklyFlights: 20, totalSeats: 3000}
            }
        }
        const Host = installHost(seed)
        const data = await Host.loadServerData("free1")
        const ord = data.edges.get("JFK-ORD")

        assert(ord, "JFK-ORD edge exists")
        assert.strictEqual(ord.source, "mixed")
        assert.strictEqual(ord.totals.totalWeeklyFlights, 20)
        assert.deepStrictEqual(ord.competitors.map(c => c.iata).sort(), ["MLD", "MRW"])
    })

    summary()
})()
