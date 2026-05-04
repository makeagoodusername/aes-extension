"use strict"

/**
 * Node-runnable smoke for AesAfpScheduleDiff. Mirrors the in-page asserts
 * that fire on `?aes-debug` (schedule-diff.js:241) so CI / pre-commit can
 * regression-check the matcher without spinning up Chrome.
 *
 * Also asserts F4-003 status: today the public API is `compare(cur, pro)`
 * (no opts) — Agent 4 flagged this as a brief↔code mismatch. The
 * "tolerance is configurable via opts.toleranceMin" part of the contract
 * is NOT shipped. The opts-aware test is marked as expected-fail until
 * Agent 4 lands the extension.
 *
 * Run from project root:
 *   node audit/tests/afp/schedule-diff.test.js
 */

const path = require("path")
const fs = require("fs")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

const src = fs.readFileSync(
    path.join(ROOT, "modules/aircraft-flight-plan/auto-scheduler/schedule-diff.js"),
    "utf8"
)
global.window = {location: {search: ""}}
eval(src)

const D = global.window.AesAfpScheduleDiff
assert.ok(D, "AesAfpScheduleDiff exported on window")

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)) }
}

it("timeDeltaMin: same time → 0",            () => assert.strictEqual(D.timeDeltaMin("09:00", "09:00"), 0))
it("timeDeltaMin: +10 min",                  () => assert.strictEqual(D.timeDeltaMin("09:00", "09:10"), 10))
it("timeDeltaMin: midnight wrap → 20",       () => assert.strictEqual(D.timeDeltaMin("23:50", "00:10"), 20))
it("timeDeltaMin: 12h apart → 720",          () => assert.strictEqual(D.timeDeltaMin("06:00", "18:00"), 720))
it("timeDeltaMin: bad input → null",         () => assert.strictEqual(D.timeDeltaMin("bad",   "09:00"), null))

it("isMatchable: full leg matchable",        () => assert.strictEqual(D.isMatchable({origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}), true))
it("isMatchable: lowercase IATA rejected",   () => assert.strictEqual(D.isMatchable({origin:"jfk", destination:"LAX", depTimeLocal:"06:00"}), false))
it("isMatchable: null leg rejected",         () => assert.strictEqual(D.isMatchable(null), false))

it("compare: identical lists → keep",       () => {
    const same = D.compare(
        [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"},
         {seq:2, origin:"LAX", destination:"JFK", depTimeLocal:"14:00"}],
        [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"},
         {seq:12, origin:"LAX", destination:"JFK", depTimeLocal:"14:00"}])
    assert.strictEqual(same.keep.length,   2)
    assert.strictEqual(same.delete.length, 0)
    assert.strictEqual(same.add.length,    0)
})

it("compare: ±15 min tolerance → keep",     () => {
    const within = D.compare(
        [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
        [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:14"}])
    assert.strictEqual(within.keep.length,        1)
    assert.strictEqual(within.keep[0].deltaMin,   14)
    assert.strictEqual(within.keep[0].matchedBy, "time")
})

it("compare: outside ±15 → delete + add",   () => {
    const beyond = D.compare(
        [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
        [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:30"}])
    assert.strictEqual(beyond.keep.length,    0)
    assert.strictEqual(beyond.delete.length,  1)
    assert.strictEqual(beyond.add.length,     1)
    assert.strictEqual(beyond.moveTime.length, 0, "Phase-1: moveTime always []")
})

it("compare: flightId-exact beats time delta (7e)", () => {
    const fidMatch = D.compare(
        [{seq:1, flightId:"f-42", origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
        [{seq:11, flightId:"f-42", origin:"JFK", destination:"LAX", depTimeLocal:"08:00"}])
    assert.strictEqual(fidMatch.keep.length,        1)
    assert.strictEqual(fidMatch.keep[0].matchedBy, "flightId")
})

it("compare: locked unmatched → locked bucket", () => {
    const locked = D.compare(
        [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00", modifiers:{locked:true}}],
        [{seq:11, origin:"JFK", destination:"BOS", depTimeLocal:"06:00"}])
    assert.strictEqual(locked.locked.length, 1)
    assert.strictEqual(locked.delete.length, 0)
})

it("compare: closest-time wins among ambiguous candidates", () => {
    const a = D.compare(
        [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
        [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:14"},
         {seq:12, origin:"JFK", destination:"LAX", depTimeLocal:"06:05"},
         {seq:13, origin:"JFK", destination:"LAX", depTimeLocal:"06:13"}])
    assert.strictEqual(a.keep.length,            1)
    assert.strictEqual(a.keep[0].proposedSeq,    12)
    assert.strictEqual(a.add.length,             2)
})

// ── F4-003 lockdown — opts.toleranceMin per Agent 4's brief↔code mismatch.
//
// Today this test FAILS (expected) — compare() takes only 2 args. Once
// Agent 4 lands the (cur, pro, opts) extension with default 15, the
// 30-min keep should pass.
it("compare: opts.toleranceMin=45 lets 30-min delta keep (F4-003)", () => {
    const a = D.compare(
        [{seq:1, origin:"JFK", destination:"LAX", depTimeLocal:"06:00"}],
        [{seq:11, origin:"JFK", destination:"LAX", depTimeLocal:"06:30"}],
        {toleranceMin: 45})
    assert.strictEqual(a.keep.length, 1, "expected the relaxed tolerance to keep the leg")
})

console.log("\nschedule-diff (F4-003 lockdown): " + pass + " passed, " + fail + " failed")
if (fail > 0) process.exitCode = 1
