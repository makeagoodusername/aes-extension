"use strict"

/**
 * Locks down the bridge's aggregation of per-flight ground-truth into
 * per-route signals. content_flightInfo.js writes flightInfoData JSONs
 * keyed by `<server><airline>flightInfo<flightId>`; the bridge has to:
 *   - pick those keys out of chrome.storage.local via FLIGHT_INFO_KEY_RE
 *   - aggregate across multiple flights per route
 *   - take MAX of minPrice (conservative floor)
 *   - take MEDIAN of currentLoad
 *   - count samples
 *   - fall back gracefully on missing fields
 * Also covers the parsePairFromOwnPricingKey helper (legacy + scoped).
 */
const path = require("path")
const assert = require("assert")
const bridgeApi = require(path.resolve(__dirname, "..", "..", "..",
    "modules/route-assistant/flights-prices-bridge.js"))

let pass = 0, fail = 0
function it(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { pass++; console.log("  ok  " + name) },
        (e) => {
            fail++
            console.log("  FAIL " + name + " - " + (e && e.message))
            if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
        }
    )
}

function mockChromeStorage(items) {
    global.chrome = {
        storage: {
            local: {
                get: (_keys, cb) => { cb(items) }
            }
        }
    }
}

function makeFlightInfo(flightId, hub, dest, loads, prices) {
    return {
        type: "flightInfo",
        flightId,
        server: "free1",
        route: { hub, dest },
        loads:  loads  || {},
        prices: prices || {},
        money:  {}
    }
}

async function run() {
    console.log("=== flights-prices-bridge aggregation ===")

    await it("median + max-floor across three flights on the same route", async () => {
        mockChromeStorage({
            "free1FGMflightInfo101": makeFlightInfo(101, "JFK", "LAX",
                { Y: { capacity: 144, bookings: 130, loadPct: 90 } },
                { Y: { unit: 220, min: 60 } }),
            "free1FGMflightInfo102": makeFlightInfo(102, "JFK", "LAX",
                { Y: { capacity: 144, bookings: 144, loadPct: 100 } },
                { Y: { unit: 230, min: 65 } }),
            "free1FGMflightInfo103": makeFlightInfo(103, "JFK", "LAX",
                { Y: { capacity: 144, bookings: 100, loadPct: 70 } },
                { Y: { unit: 215, min: 58 } })
        })
        const bridge = new bridgeApi.RouteAssistantFlightsPricesBridge("free1", "FGM", {})
        const idx = await bridge.loadFlightInfoIndex()
        const lax = idx.get("JFK-LAX")
        assert.ok(lax, "JFK-LAX should be in the index")
        assert.strictEqual(lax.Y.minPrice, 65, "minPrice should be the MAX (most conservative)")
        assert.strictEqual(lax.Y.currentLoad, 90, "median of [70,90,100] = 90")
        assert.strictEqual(lax.Y.currentPrice, 220, "median of [215,220,230] = 220")
        assert.strictEqual(lax.Y.sampleCount, 3)
    })

    await it("ignores entries with non-flightInfo type or missing route", async () => {
        mockChromeStorage({
            "free1FGMflightInfo200": makeFlightInfo(200, "JFK", "MIA",
                { Y: { loadPct: 80 } },
                { Y: { min: 50 } }),
            "free1FGMflightInfo201": { type: "other", route: { hub: "JFK", dest: "MIA" } },
            "free1FGMflightInfo202": { type: "flightInfo", flightId: 202 } // no route
        })
        const bridge = new bridgeApi.RouteAssistantFlightsPricesBridge("free1", "FGM", {})
        const idx = await bridge.loadFlightInfoIndex()
        const mia = idx.get("JFK-MIA")
        assert.strictEqual(mia.Y.sampleCount, 1, "only the one valid flightInfo counts")
    })

    await it("parsePairFromOwnPricingKey accepts legacy + airline-scoped keys", () => {
        const p1 = bridgeApi.parsePairFromOwnPricingKey("routeAssistant:markets:ownPricing:JFK-LAX")
        assert.deepStrictEqual(p1, { hub: "JFK", dest: "LAX" })
        const p2 = bridgeApi.parsePairFromOwnPricingKey("acct:free1:FGM:routeAssistant:markets:ownPricing:JFK-PUJ")
        assert.deepStrictEqual(p2, { hub: "JFK", dest: "PUJ" })
        const p3 = bridgeApi.parsePairFromOwnPricingKey("not:a:matching:key")
        assert.strictEqual(p3, null)
    })

    await it("loadRouteFixture builds a fixture from ownPricing entries", async () => {
        mockChromeStorage({
            "routeAssistant:markets:ownPricing:JFK-LAX": {
                prices: { Y: 100, C: 250, F: 600 },
                generalSettings: {
                    "serviceProfile-group:serviceProfile-group_body:serviceProfile": "611"
                }
            },
            "routeAssistant:markets:ownPricing:JFK-PUJ": {
                prices: { Y: 100, Cargo: 1.5 },
                generalSettings: {}
            },
            "settings": { dummy: true }   // unrelated key, should be skipped
        })
        const bridge = new bridgeApi.RouteAssistantFlightsPricesBridge("free1", "FGM", {})
        const fixture = await bridge.loadRouteFixture()
        assert.strictEqual(fixture.length, 2)
        const lax = fixture.find(r => r.dest === "LAX")
        assert.deepStrictEqual(lax.classes.sort(), ["C", "F", "Y"])
        assert.strictEqual(lax.serviceProfileId, "611")
        const puj = fixture.find(r => r.dest === "PUJ")
        assert.deepStrictEqual(puj.classes.sort(), ["Cargo", "Y"])
    })

    await it("invalidate() clears caches so the next compute re-loads", async () => {
        mockChromeStorage({})
        const bridge = new bridgeApi.RouteAssistantFlightsPricesBridge("free1", "FGM", {})
        await bridge.loadRouteFixture()
        await bridge.loadFlightInfoIndex()
        bridge.invalidate()
        assert.strictEqual(bridge._loaded.routes, false)
        assert.strictEqual(bridge._loaded.flightInfo, false)
        assert.strictEqual(bridge._snapshotCache.snapshot, null)
    })

    await it("median helper: even-length array averages two middle values", () => {
        assert.strictEqual(bridgeApi.median([1, 2, 3, 4]), 2.5)
        assert.strictEqual(bridgeApi.median([10]), 10)
        assert.strictEqual(bridgeApi.median([]), null)
        assert.strictEqual(bridgeApi.median(null), null)
    })

    await it("maxFinite helper: drops NaN/non-finite, returns null on empty", () => {
        assert.strictEqual(bridgeApi.maxFinite([5, NaN, 12, Infinity, 8]), 12)
        assert.strictEqual(bridgeApi.maxFinite([NaN, NaN]), null)
        assert.strictEqual(bridgeApi.maxFinite([]), null)
    })

    console.log("\n" + pass + " passed, " + fail + " failed")
    process.exit(fail ? 1 : 0)
}

run()
