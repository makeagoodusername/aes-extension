"use strict"

/**
 * ORS competition-weight smoke. Locks the curve + composite scaling so
 * downstream consumers (central-price-automator, service-profile-applier)
 * can rely on a stable mapping.
 */
const assert = require("assert")
const path = require("path")

const M = require(path.resolve(__dirname, "..", "..", "..",
    "modules/route-assistant/ors-competition-weight.js"))

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " — " + (e && e.message))
    }
}

console.log("=== ors-competition-weight ===")

it("true monopoly (0 competitors) returns suppressed ORS weight", () => {
    assert.strictEqual(M.weightFromCompetitorCount(0), 0.20)
})

it("duopoly (1 competitor) returns high ORS weight", () => {
    assert.strictEqual(M.weightFromCompetitorCount(1), 0.85)
})

it("triopoly/crowded routes ramp toward saturated ORS weight", () => {
    assert.strictEqual(M.weightFromCompetitorCount(2), 0.90)
    assert.strictEqual(M.weightFromCompetitorCount(3), 0.95)
})

it("crowded (4) and saturated (5+) return full ORS weight", () => {
    assert.strictEqual(M.weightFromCompetitorCount(4), 1.00)
    assert.strictEqual(M.weightFromCompetitorCount(5), 1.00)
    assert.strictEqual(M.weightFromCompetitorCount(8), 1.00)
    assert.strictEqual(M.weightFromCompetitorCount(50), 1.00)
})

it("non-finite or negative inputs default to 0 competitors (monopoly weight)", () => {
    assert.strictEqual(M.weightFromCompetitorCount(null), 0.20)
    assert.strictEqual(M.weightFromCompetitorCount(undefined), 0.20)
    assert.strictEqual(M.weightFromCompetitorCount("nope"), 0.20)
    assert.strictEqual(M.weightFromCompetitorCount(-3), 0.20)
})

it("custom curve overrides default anchors", () => {
    const w = M.weightFromCompetitorCount(2, {curve: {2: 0.30}})
    assert.strictEqual(w, 0.30)
})

it("cap option lifts saturation ceiling above 1.0", () => {
    const w = M.weightFromCompetitorCount(10, {cap: 1.5})
    assert.strictEqual(w, 1.5)
})

it("serviceProfileEmphasis matches weightFromCompetitorCount by default", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 7]) {
        assert.strictEqual(M.serviceProfileEmphasis(n), M.weightFromCompetitorCount(n))
    }
})

it("applyToComposite adds competitionWeight + effectiveRatingGapToTop", () => {
    const composite = {ratingGapToTop: 25, rankAny: 18, ourTopRating: 45}
    const out = M.applyToComposite(composite, 1)
    assert.strictEqual(out.competitionWeight, 0.85)
    assert.strictEqual(out.effectiveRatingGapToTop, 25 * 0.85)
    assert.strictEqual(out.ratingGapToTop, 25, "raw gap untouched")
})

it("applyToComposite handles null gap gracefully", () => {
    const out = M.applyToComposite({ratingGapToTop: null}, 5)
    assert.strictEqual(out.competitionWeight, 1.0)
    assert.strictEqual(out.effectiveRatingGapToTop, null)
})

it("monopoly route effective gap is much smaller than saturated", () => {
    const c = {ratingGapToTop: 30}
    const monopoly = M.applyToComposite(c, 0)
    const saturated = M.applyToComposite(c, 6)
    assert.ok(monopoly.effectiveRatingGapToTop < saturated.effectiveRatingGapToTop * 0.3,
        "monopoly effective gap should be <30% of saturated")
})

console.log("\nors-competition-weight: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)
