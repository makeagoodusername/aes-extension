"use strict"

/**
 * Smoke for modules/route-assistant/flights-prices-bridge.js applySelected().
 * Locks down:
 *   - selected rows grouped per (hub, dest); one applier.apply() call per pair
 *   - per-class prices passed through, minPrices threaded into the call
 *   - source string is "bulkRecommended" (the new scope)
 *   - reason is clamped to 240 chars and defaulted
 *   - summary aggregates verified / dry-run / failed counts
 *   - clamped flag on result envelope is counted in summary.clamped
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

function makeMockApplier(stubs) {
    const calls = []
    return {
        calls,
        async apply(hub, dest, prices, opts) {
            const stub = stubs && stubs[hub + "-" + dest]
            calls.push({ hub, dest, prices: Object.assign({}, prices), opts: Object.assign({}, opts) })
            return Object.assign(
                { status: "dry-run", hub, dest, requestedPrices: prices },
                stub || {}
            )
        }
    }
}

function makeBridge() {
    return new bridgeApi.RouteAssistantFlightsPricesBridge("free1", "FGM", {
        routeAssistant: {
            pricing: {
                apply: { minPriceFloor: { enabled: true, safetyMarginPct: 5 } }
            }
        }
    })
}

async function run() {
    console.log("=== flights-prices-bridge.applySelected ===")

    await it("groups rows per (hub,dest) into single apply() call", async () => {
        const applier = makeMockApplier()
        const bridge = makeBridge()
        const rows = [
            { hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250, minPrice: 59 },
            { hub: "JFK", dest: "LAX", classKey: "C", toPrice: 600, minPrice: 97 },
            { hub: "JFK", dest: "MIA", classKey: "Y", toPrice: 220, minPrice: 55 }
        ]
        const out = await bridge.applySelected(rows, { applier })
        assert.strictEqual(applier.calls.length, 2, "expected 2 apply() calls (2 routes)")
        const jfkLax = applier.calls.find(c => c.dest === "LAX")
        assert.deepStrictEqual(jfkLax.prices, { Y: 250, C: 600 })
        assert.deepStrictEqual(jfkLax.opts.minPrices, { Y: 59, C: 97 })
        const jfkMia = applier.calls.find(c => c.dest === "MIA")
        assert.deepStrictEqual(jfkMia.prices, { Y: 220 })
        assert.deepStrictEqual(jfkMia.opts.minPrices, { Y: 55 })
        assert.strictEqual(out.summary.total, 2)
        assert.strictEqual(out.summary.dryRun, 2)
    })

    await it("source = 'bulkRecommended' on every apply() call", async () => {
        const applier = makeMockApplier()
        const bridge = makeBridge()
        await bridge.applySelected(
            [{ hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250 }],
            { applier }
        )
        assert.strictEqual(applier.calls[0].opts.source, "bulkRecommended")
    })

    await it("reason is defaulted and threaded into call", async () => {
        const applier = makeMockApplier()
        const bridge = makeBridge()
        await bridge.applySelected(
            [{ hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250 }],
            { applier }
        )
        assert.ok(/flightsPrices/.test(applier.calls[0].opts.reason || ""))
    })

    await it("minPriceFloor settings struct is forwarded to applier", async () => {
        const applier = makeMockApplier()
        const bridge = makeBridge()
        await bridge.applySelected(
            [{ hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250, minPrice: 59 }],
            { applier }
        )
        assert.deepStrictEqual(applier.calls[0].opts.minPriceFloor,
            { enabled: true, safetyMarginPct: 5 })
    })

    await it("summary aggregates statuses across pairs", async () => {
        const applier = makeMockApplier({
            "JFK-LAX": { status: "verified" },
            "JFK-MIA": { status: "failed", error: { code: "noFormContext" } },
            "JFK-PUJ": { status: "dry-run", clamped: true }
        })
        const bridge = makeBridge()
        const rows = [
            { hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250 },
            { hub: "JFK", dest: "MIA", classKey: "Y", toPrice: 220 },
            { hub: "JFK", dest: "PUJ", classKey: "Y", toPrice: 180 }
        ]
        const out = await bridge.applySelected(rows, { applier })
        assert.strictEqual(out.summary.total,    3)
        assert.strictEqual(out.summary.verified, 1)
        assert.strictEqual(out.summary.failed,   1)
        assert.strictEqual(out.summary.dryRun,   1)
        assert.strictEqual(out.summary.clamped,  1, "clamped flag picked up from result envelope")
    })

    await it("onRow callback fires per pair", async () => {
        const applier = makeMockApplier()
        const bridge = makeBridge()
        const seen = []
        await bridge.applySelected(
            [
                { hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250 },
                { hub: "JFK", dest: "MIA", classKey: "Y", toPrice: 220 }
            ],
            { applier, onRow: (r) => seen.push(r.pair) }
        )
        assert.deepStrictEqual(seen.sort(), ["JFK-LAX", "JFK-MIA"])
    })

    await it("applier exception is caught into a synthetic failure result", async () => {
        const applier = {
            async apply() { throw new Error("simulated breaker trip") }
        }
        const bridge = makeBridge()
        const out = await bridge.applySelected(
            [{ hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250 }],
            { applier }
        )
        assert.strictEqual(out.summary.failed, 1)
        assert.strictEqual(out.results[0].result.status, "failed")
        assert.strictEqual(out.results[0].result.error.code, "applierThrew")
    })

    await it("missing applier throws with a clear message", async () => {
        const bridge = makeBridge()
        let err = null
        try {
            await bridge.applySelected([{ hub: "JFK", dest: "LAX", classKey: "Y", toPrice: 250 }], {})
        } catch (e) { err = e }
        assert.ok(err && /applier required/.test(err.message))
    })

    console.log("\n" + pass + " passed, " + fail + " failed")
    process.exit(fail ? 1 : 0)
}

run()
