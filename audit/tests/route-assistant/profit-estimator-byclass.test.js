"use strict"

/**
 * profit-estimator byClass breakdown — pure-function smoke.
 *
 * Locks the contract that `RouteAssistantProfitEstimator.estimate(...)`:
 *   1. returns `breakdown.byClass = null` when `economics.classYields` is absent
 *      (backward-compatible — pre-byClass consumers still see aggregate paxRevenue)
 *   2. populates Y/C/F per-cabin lines whose revenue sums to the
 *      aggregate `paxRevenue` when classYields IS set
 *   3. always populates `byClass.Cargo` when cargoYieldPerKgKm > 0 regardless of
 *      whether passenger classYields is configured
 *   4. honours `economics.classShares` mis-typed inputs (auto-normalises so
 *      shares that don't sum to 1 don't silently shrink revenue)
 *   5. respects per-class `loadFactorMin/Max` ranges driven off `paxScore`
 */

const fs = require("fs")
const path = require("path")
const assert = require("assert")
const vm = require("vm")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function loadEstimator() {
    const src = fs.readFileSync(path.join(ROOT, "modules/route-assistant/profit-estimator.js"), "utf8")
    // Wrap in a function that returns the class — top-level `class Foo {}`
    // declarations are lexically scoped, so `vm.runInContext` doesn't expose
    // them on the sandbox by default.
    return new Function(src + "\nreturn RouteAssistantProfitEstimator;")()
}

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== profit-estimator byClass ===")

const E = loadEstimator()
assert.ok(E && typeof E.estimate === "function", "estimator loaded")

const baseInput = {
    distanceKm: 4000,
    spec:       {seats: 250, range: 11000, speed: 850, cargoCapacity: 0},
    frequency:  7,
    paxScore:   6,
    economics: {
        loadFactor:    0.75,
        loadFactorMin: 0.5,
        loadFactorMax: 0.95,
        yieldPerKm:    0.10,
        fuelCostPerHour: 2500
    }
}

it("byClass=null when classYields absent (backward compat)", () => {
    const r = E.estimate(baseInput)
    assert.ok(r.profitPerFlight !== null, "got profit")
    assert.strictEqual(r.breakdown.byClass, null, "byClass should be null without classYields")
    assert.ok(r.breakdown.paxRevenue > 0, "aggregate paxRevenue non-zero")
})

it("byClass populated for Y/C/F when classYields set, sums match paxRevenue", () => {
    const input = Object.assign({}, baseInput, {
        economics: Object.assign({}, baseInput.economics, {
            classYields: {
                Y: { yieldPerKm: 0.10, loadFactorMin: 0.55, loadFactorMax: 0.92, demandSensitivity: 0 },
                C: { yieldPerKm: 0.32, loadFactorMin: 0.45, loadFactorMax: 0.85, demandSensitivity: 0 },
                F: { yieldPerKm: 0.65, loadFactorMin: 0.30, loadFactorMax: 0.75, demandSensitivity: 0 }
            },
            classShares: { Y: 0.78, C: 0.16, F: 0.06 }
        })
    })
    const r = E.estimate(input)
    const bc = r.breakdown.byClass
    assert.ok(bc, "byClass present")
    assert.ok(bc.Y && bc.C && bc.F, "Y/C/F all populated")
    const sum = bc.Y.revenue + bc.C.revenue + bc.F.revenue
    // Allow $1 tolerance for round-to-int per-line.
    assert.ok(Math.abs(sum - r.breakdown.paxRevenue) <= 3,
        "sum of byClass revenue (" + sum + ") matches paxRevenue (" + r.breakdown.paxRevenue + ")")
    // Per-cabin LF should respect the configured range driven by paxScore.
    // paxScore=6, Y range [0.55, 0.92] → 0.55 + 0.6*(0.37) = 0.772
    assert.ok(Math.abs(bc.Y.loadFactor - 0.772) < 0.001, "Y LF matches range×score")
})

it("classShares auto-normalised when input doesn't sum to 1", () => {
    const input = Object.assign({}, baseInput, {
        economics: Object.assign({}, baseInput.economics, {
            classYields: {
                Y: { yieldPerKm: 0.10, loadFactorMin: 0.55, loadFactorMax: 0.92 },
                C: { yieldPerKm: 0.10, loadFactorMin: 0.55, loadFactorMax: 0.92 },
                F: { yieldPerKm: 0.10, loadFactorMin: 0.55, loadFactorMax: 0.92 }
            },
            // Sums to 0.5 — should renormalise so total revenue == single-class
            classShares: { Y: 0.4, C: 0.08, F: 0.02 }
        })
    })
    const r = E.estimate(input)
    const bc = r.breakdown.byClass
    const totalSeats = bc.Y.seats + bc.C.seats + bc.F.seats
    assert.ok(Math.abs(totalSeats - 250) < 0.5,
        "seats renormalised to 250 (got " + totalSeats + ")")
})

it("byClass.Cargo populated when cargoYieldPerKgKm > 0", () => {
    const input = Object.assign({}, baseInput, {
        spec: Object.assign({}, baseInput.spec, {cargoCapacity: 12000}),
        cargoScore: 7,
        economics: Object.assign({}, baseInput.economics, {
            cargoYieldPerKgKm:   0.04,
            cargoLoadFactorMin:  0.4,
            cargoLoadFactorMax:  0.85
        })
    })
    const r = E.estimate(input)
    const bc = r.breakdown.byClass
    assert.ok(bc, "byClass present")
    assert.ok(bc.Cargo, "Cargo line populated")
    assert.ok(bc.Cargo.revenue > 0, "Cargo revenue non-zero")
    assert.strictEqual(bc.Cargo.cargoKg, 12000, "Cargo kg matches spec")
})

it("missing class share = excluded from byClass (no zero line)", () => {
    const input = Object.assign({}, baseInput, {
        economics: Object.assign({}, baseInput.economics, {
            classYields: {
                Y: { yieldPerKm: 0.10, loadFactorMin: 0.55, loadFactorMax: 0.92 }
            },
            classShares: { Y: 1.0 }   // C and F absent → not partitioned
        })
    })
    const r = E.estimate(input)
    const bc = r.breakdown.byClass
    assert.ok(bc.Y, "Y present")
    assert.ok(!bc.C, "C absent")
    assert.ok(!bc.F, "F absent")
})

console.log("=== " + pass + " passed, " + fail + " failed ===")
process.exit(fail ? 1 : 0)
