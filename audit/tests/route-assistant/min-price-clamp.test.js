"use strict"

/**
 * Smoke for RouteAssistantPricingApplier._applyMinPriceFloor.
 * Locks down: clamp fires when price < floor × (1 + safetyMarginPct/100);
 * does nothing when gate disabled or floor missing; mutates input map in
 * place; aggregates a `clamped` flag + per-class `clamps` record.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")
const ROOT = path.resolve(__dirname, "..", "..", "..")

global.window = global
delete global.RouteAssistantPricingApplier
eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/pricing-applier.js"), "utf8"))
const Applier = global.RouteAssistantPricingApplier

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== _applyMinPriceFloor ===")

it("clamps Y price below floor × 1.05 up to ceiling integer", () => {
    const prices = { Y: 50 }
    const out = Applier._applyMinPriceFloor(prices, { Y: 59 }, { enabled: true, safetyMarginPct: 5 })
    // 59 * 1.05 = 61.95, ceil = 62
    assert.strictEqual(prices.Y, 62, "Y should be 62 after clamp")
    assert.strictEqual(out.clamped, true)
    assert.deepStrictEqual(out.clamps.Y, { from: 50, to: 62, floor: 59, marginPct: 5 })
})

it("does NOT clamp Y price above floor × 1.05", () => {
    const prices = { Y: 200 }
    const out = Applier._applyMinPriceFloor(prices, { Y: 59 }, { enabled: true, safetyMarginPct: 5 })
    assert.strictEqual(prices.Y, 200)
    assert.strictEqual(out.clamped, false)
    assert.deepStrictEqual(out.clamps, {})
})

it("safety margin = 0 clamps to exactly the floor", () => {
    const prices = { Y: 30 }
    const out = Applier._applyMinPriceFloor(prices, { Y: 59 }, { enabled: true, safetyMarginPct: 0 })
    assert.strictEqual(prices.Y, 59)
    assert.strictEqual(out.clamped, true)
})

it("disabled gate is a no-op", () => {
    const prices = { Y: 10 }
    const out = Applier._applyMinPriceFloor(prices, { Y: 59 }, { enabled: false, safetyMarginPct: 5 })
    assert.strictEqual(prices.Y, 10)
    assert.strictEqual(out.clamped, false)
})

it("missing floor for a class is skipped without affecting others", () => {
    const prices = { Y: 50, C: 80 }
    const out = Applier._applyMinPriceFloor(prices, { Y: 59 }, { enabled: true, safetyMarginPct: 5 })
    assert.strictEqual(prices.Y, 62, "Y still clamped")
    assert.strictEqual(prices.C, 80, "C untouched (no floor)")
    assert.strictEqual(out.clamped, true)
    assert.ok(!out.clamps.C, "C should not appear in clamps")
})

it("missing inputs (null prices / null minPrices) are no-ops", () => {
    const out1 = Applier._applyMinPriceFloor(null, { Y: 59 }, { enabled: true, safetyMarginPct: 5 })
    assert.strictEqual(out1.clamped, false)
    const prices = { Y: 50 }
    const out2 = Applier._applyMinPriceFloor(prices, null, { enabled: true, safetyMarginPct: 5 })
    assert.strictEqual(prices.Y, 50)
    assert.strictEqual(out2.clamped, false)
})

it("multi-class clamp: Y up, C up, F left alone", () => {
    const prices = { Y: 30, C: 60, F: 1500 }
    const out = Applier._applyMinPriceFloor(prices,
        { Y: 59, C: 97, F: 49 },
        { enabled: true, safetyMarginPct: 5 })
    assert.strictEqual(prices.Y, 62)
    assert.strictEqual(prices.C, 102)  // ceil(97*1.05) = 102
    assert.strictEqual(prices.F, 1500) // already above
    assert.strictEqual(out.clamped, true)
    assert.deepStrictEqual(Object.keys(out.clamps).sort(), ["C", "Y"])
})

console.log("\n" + pass + " passed, " + fail + " failed")
process.exit(fail ? 1 : 0)
