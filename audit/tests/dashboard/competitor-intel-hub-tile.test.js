"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

console.log("=== competitor-intel-hub-tile ===")

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
    console.log("\ncompetitor-intel-hub-tile: " + pass + " passed, " + fail + " failed")
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
                }
            },
            onChanged: {addListener() {}, removeListener() {}}
        }
    }
}

function installTile(seed) {
    installChromeStorage(seed)
    let registered = null
    global.window = {
        CentralHubTile: class {},
        CentralHubStatusBadges: {KIND: {MUTED: "muted", INFO: "info", DEFAULT: "default"}},
        CentralHubTileRegistry: {
            register(def) { registered = def }
        },
        RouteAssistantOrsIntelligence: {
            async listCachedRoutes() {
                return new Map([["JFK-ORD", {hub: "JFK", dest: "ORD"}]])
            }
        }
    }
    eval(fs.readFileSync(path.join(ROOT, "modules/central-hub/tiles/competitor-intel-hub-tile.js"), "utf8"))
    assert(registered && registered.factory, "tile registered")
    const tile = registered.factory()
    tile.ctx = {server: "free1"}
    return tile
}

;(async () => {
    await it("counts native enterprise routeFootprints as route edges", async () => {
        const tile = installTile({
            "competitorIntel:enterprise:free1:930": {
                server: "free1",
                enterpriseId: "930",
                routeFootprint: [
                    {hub: "JFK", dest: "ORD", weeklyFlights: 7},
                    {origin: "ORD", destination: "JFK", frequency: 7},
                    {hub: "JFK", dest: "ATL", weeklyFlights: 14},
                    {hub: "JFK", dest: "ORD", weeklyFlights: 7}
                ]
            },
            "competitorIntel:enterprise:free1:931": {
                server: "free1",
                enterpriseId: "931",
                routeFootprint: [
                    {from: "BOS", to: "JFK", flightsPerWeek: 3},
                    {hub: "BAD", dest: "BAD", weeklyFlights: 99}
                ]
            }
        })
        const counts = await tile._scanServer()
        assert.strictEqual(counts.enterprises, 2)
        assert.strictEqual(counts.edges, 4)
        assert.strictEqual(counts.orsRoutes, 1)
    })

    await it("status summary uses derived footprint edge count", async () => {
        const tile = installTile({
            "competitorIntel:enterprise:free1:930": {
                server: "free1",
                enterpriseId: "930",
                routeFootprint: [{hub: "JFK", dest: "ORD", weeklyFlights: 7}]
            }
        })
        const status = await tile.loadStatus()
        assert(status.summary.includes("1 enterprises"))
        assert(status.summary.includes("1 edges"))
    })

    summary()
})()
