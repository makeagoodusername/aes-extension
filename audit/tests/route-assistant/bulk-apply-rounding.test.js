"use strict"

/**
 * F-LIVE-003 lockdown — bulk-apply price rounding handles cargo correctly.
 *
 * The pre-fix `_computeBulkProposedPrice(current, deltaPct)` integer-rounded
 * the result. Cargo prices in AS are typically sub-$1/kg, so a 5–10% delta
 * (the bulk-modal's typical knob) rounded back to the same integer cent and
 * the bulk apply silently skipped the cargo move. This test reads the
 * function out of panel.js by regex (panel.js is too big to require()) and
 * locks the post-fix behavior:
 *
 *   - Pax (price >= 10): integer rounding (preserves existing behavior).
 *   - Cargo OR price < 10: 2-decimal rounding so $0.85 → $0.89 (5%).
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const panelSrc = fs.readFileSync(path.join(ROOT, "modules/route-assistant/panel.js"), "utf8")

// Extract the method body and rebuild it as a stand-alone function. We
// match `_computeBulkProposedPrice(currentPrice, deltaPct, cls) { … }` —
// the post-fix signature with the `cls` arg.
const match = panelSrc.match(
    /_computeBulkProposedPrice\s*\(\s*currentPrice\s*,\s*deltaPct\s*,\s*cls\s*\)\s*\{([\s\S]*?)\n\s*\}/
)
if (!match) {
    console.error("FAIL — _computeBulkProposedPrice signature did not match (looking for 3-arg post-fix form)")
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const compute = new Function("currentPrice", "deltaPct", "cls", match[1])

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== bulk-apply rounding (F-LIVE-003) ===")

it("pax classes round to integer at +5%", () => {
    assert.strictEqual(compute(250, 5, "Y"), 263, "250 × 1.05 = 262.5 → 263")
    assert.strictEqual(compute(600, 5, "C"), 630, "600 × 1.05 = 630")
    assert.strictEqual(compute(1100, 5, "F"), 1155, "1100 × 1.05 = 1155")
})

it("pax classes round to integer at -5%", () => {
    assert.strictEqual(compute(250, -5, "Y"), 238, "250 × 0.95 = 237.5 → 238")
    assert.strictEqual(compute(1000, -10, "Y"), 900, "1000 × 0.9 = 900")
})

it("cargo @ $0.85 with +5% rounds to 2 decimals (NOT 1)", () => {
    const r = compute(0.85, 5, "Cargo")
    assert.notStrictEqual(r, 1, "pre-fix bug: round(0.85*1.05)=1 wipes the move")
    assert.ok(Math.abs(r - 0.89) < 0.001, "0.85*1.05=0.8925 → 0.89 (got " + r + ")")
})

it("cargo @ $0.85 with -5% rounds down (NOT 1)", () => {
    const r = compute(0.85, -5, "Cargo")
    assert.notStrictEqual(r, 1)
    assert.ok(Math.abs(r - 0.81) < 0.001, "0.85*0.95=0.8075 → 0.81 (got " + r + ")")
})

it("sub-$10 prices use 2-decimal rounding even without explicit Cargo class", () => {
    // current < 10 path — same behavior as Cargo
    const r = compute(2.50, 4, "Y")
    assert.ok(Math.abs(r - 2.6) < 0.001, "2.50*1.04=2.6 (got " + r + ")")
})

it("zero delta returns current unchanged", () => {
    assert.strictEqual(compute(250, 0, "Y"), 250)
    assert.strictEqual(compute(0.85, 0, "Cargo"), 0.85)
})

it("non-finite or non-positive current returns unchanged", () => {
    assert.strictEqual(compute(0, 5, "Y"), 0, "zero passes through")
    assert.strictEqual(compute(-1, 5, "Y"), -1, "negative passes through")
    const nan = compute(NaN, 5, "Y")
    assert.ok(Number.isNaN(nan), "NaN passes through")
})

it("min floor: pax >= $10 keeps $1 floor; sub-$10 + cargo use $0.01 floor", () => {
    // Pax priced at >= 10 uses integer rounding + $1 floor.
    const yBig = compute(10, -99, "Y")
    assert.ok(yBig >= 1, "pax >= 10 keeps $1 integer floor (got " + yBig + ")")
    // Sub-$10 (any class) uses 2-decimal rounding + $0.01 floor.
    // 0.05 × 0.01 = 0.0005 → rounds to 0.00, floored to 0.01.
    const cMin = compute(0.05, -99, "Cargo")
    assert.ok(cMin >= 0.01, "cargo min floor $0.01 (got " + cMin + ")")
})

it("a 10% cargo move on $0.85 gets ALL classes a non-trivial delta (no silent skip)", () => {
    // The smoking-gun integration scenario: bulk modal with state.deltaPct.Cargo = 10%
    // would, pre-fix, produce prop === cur for the cargo cell, hiding the cargo move
    // from the user AND from the apply round-trip.
    const cur = 0.85
    const prop = compute(cur, 10, "Cargo")
    assert.notStrictEqual(prop, cur, "post-fix: cargo move visible (pre-fix round wiped it)")
    assert.ok(prop > cur, "+10% should raise the price")
})

console.log("\nbulk-apply rounding: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)
