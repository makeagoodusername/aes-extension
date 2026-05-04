/**
 * Locks the contract of modules/route-assistant/score.js:
 *   1. computeScores returns rows with score=null when no field is enabled
 *   2. min/max normalisation is per-field across the visible row set
 *   3. "lower = better" direction inverts the normalised value
 *   4. weights affect the relative contribution
 *   5. missing/non-finite values contribute 0 to the numerator but full
 *      weight to the denominator (sparse-data rows score lower than dense
 *      rows even when both have a high observed value)
 *   6. user direction in scoringConfig overrides fieldDef direction
 *   7. hi === lo (single-point or all-equal) yields norm=1 (treated as best)
 *   8. _weight defaults: missing/non-finite/negative → 1, otherwise the number
 *   9. determinism: same input → same output across calls
 */
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const Score = require(path.join(ROOT, "modules/route-assistant/score.js"))

let pass = 0
let fail = 0

function it(name, fn) {
    try {
        fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) {
            console.log(e.stack.split("\n").slice(1, 3).map(l => "       " + l).join("\n"))
        }
    }
}

console.log("=== Route Assistant score ===")

const fieldDefs = [
    {field: "paxScore",      direction: "higher"},
    {field: "cargoScore",    direction: "higher"},
    {field: "weeklyFlights", direction: "higher"},
    {field: "airlineCount",  direction: "lower"}
]

it("returns score=null when no field is enabled", () => {
    const out = Score.computeScores(
        [{paxScore: 9}, {paxScore: 5}],
        {paxScore: {enabled: false, weight: 1}},
        fieldDefs
    )
    assert.strictEqual(out.length, 2)
    assert.strictEqual(out[0].score, null)
    assert.strictEqual(out[1].score, null)
})

it("higher=better normalises 0..1 then scales to 0..100", () => {
    const out = Score.computeScores(
        [{paxScore: 0}, {paxScore: 5}, {paxScore: 10}],
        {paxScore: {enabled: true, weight: 1}},
        fieldDefs
    )
    assert.strictEqual(out[0].score, 0)
    assert.strictEqual(out[1].score, 50)
    assert.strictEqual(out[2].score, 100)
})

it("lower=better inverts the normalised value", () => {
    const out = Score.computeScores(
        [{airlineCount: 1}, {airlineCount: 3}, {airlineCount: 5}],
        {airlineCount: {enabled: true, weight: 1}},
        fieldDefs
    )
    assert.strictEqual(out[0].score, 100)
    assert.strictEqual(out[1].score, 50)
    assert.strictEqual(out[2].score, 0)
})

it("user direction in scoringConfig overrides fieldDef direction", () => {
    // fieldDef says airlineCount is "lower=better"; user flips to "higher".
    const out = Score.computeScores(
        [{airlineCount: 1}, {airlineCount: 5}],
        {airlineCount: {enabled: true, weight: 1, direction: "higher"}},
        fieldDefs
    )
    assert.strictEqual(out[0].score, 0)
    assert.strictEqual(out[1].score, 100)
})

it("weights shift the blend", () => {
    const rows = [
        {paxScore: 10, airlineCount: 5}, // best pax, worst comp
        {paxScore: 0,  airlineCount: 1}  // worst pax, best comp
    ]
    // Equal weight → tie at 50.
    const equal = Score.computeScores(rows, {
        paxScore:     {enabled: true, weight: 1},
        airlineCount: {enabled: true, weight: 1}
    }, fieldDefs)
    assert.strictEqual(equal[0].score, 50)
    assert.strictEqual(equal[1].score, 50)

    // 3:1 toward paxScore → row 0 dominates.
    const tilted = Score.computeScores(rows, {
        paxScore:     {enabled: true, weight: 3},
        airlineCount: {enabled: true, weight: 1}
    }, fieldDefs)
    assert.strictEqual(tilted[0].score, 75)
    assert.strictEqual(tilted[1].score, 25)
})

it("missing values contribute 0 numerator but full weight denominator", () => {
    // Row A scores top on pax, missing cargo.
    // Row B scores top on both.
    // B should outscore A because A's missing-cargo costs it half its weight.
    const out = Score.computeScores(
        [{paxScore: 10, cargoScore: null}, {paxScore: 10, cargoScore: 10}],
        {
            paxScore:   {enabled: true, weight: 1},
            cargoScore: {enabled: true, weight: 1}
        },
        fieldDefs
    )
    // Both rows' paxScore is the same so range is degenerate (norm=1 for both)
    // → row A: weightedSum = 1*1 = 1, fullWeight = 2, score = 50
    // → row B: weightedSum = 1*1 + 1*1 = 2, fullWeight = 2, score = 100
    assert.strictEqual(out[0].score, 50)
    assert.strictEqual(out[1].score, 100)
})

it("non-finite values are treated as missing", () => {
    const out = Score.computeScores(
        [{paxScore: NaN}, {paxScore: 5}, {paxScore: 10}],
        {paxScore: {enabled: true, weight: 1}},
        fieldDefs
    )
    // NaN is the *only* enabled field for row 0 — contributed=0 → score=null.
    // (Distinct from "scored 0" — the function preserves the
    // unmeasurable / measured-as-zero distinction.)
    // 5 (low end of {5, 10}) → 0; 10 (top) → 100.
    assert.strictEqual(out[0].score, null)
    assert.strictEqual(out[1].score, 0)
    assert.strictEqual(out[2].score, 100)
})

it("non-finite on one of N enabled fields contributes 0 numerator + 0 weight", () => {
    // Row A: paxScore=10 (top), cargoScore=NaN (missing)
    // Row B: paxScore=10 (top), cargoScore=10 (top)
    // A's cargo is missing → contributes 0 numerator AND 0 weight to A.
    // A: weightedSum = 1*1 (pax norm=1) = 1, contributed = 1, fullWeight = 2
    //    → (1/2)*100 = 50
    // B: weightedSum = 1*1 + 1*1 = 2, contributed = 2, fullWeight = 2
    //    → (2/2)*100 = 100
    const out = Score.computeScores(
        [
            {paxScore: 10, cargoScore: NaN},
            {paxScore: 10, cargoScore: 10}
        ],
        {
            paxScore:   {enabled: true, weight: 1},
            cargoScore: {enabled: true, weight: 1}
        },
        fieldDefs
    )
    assert.strictEqual(out[0].score, 50)
    assert.strictEqual(out[1].score, 100)
})

it("hi === lo collapses to norm=1 (everyone at top)", () => {
    const out = Score.computeScores(
        [{paxScore: 7}, {paxScore: 7}, {paxScore: 7}],
        {paxScore: {enabled: true, weight: 1}},
        fieldDefs
    )
    out.forEach(r => assert.strictEqual(r.score, 100))
})

it("single-row input scores 100 (degenerate range)", () => {
    const out = Score.computeScores(
        [{paxScore: 3}],
        {paxScore: {enabled: true, weight: 1}},
        fieldDefs
    )
    assert.strictEqual(out[0].score, 100)
})

it("empty rows array returns empty result", () => {
    const out = Score.computeScores([], {paxScore: {enabled: true, weight: 1}}, fieldDefs)
    assert.deepStrictEqual(out, [])
})

it("zero weight on the only enabled field → score=null (no contributor)", () => {
    const out = Score.computeScores(
        [{paxScore: 5}, {paxScore: 10}],
        {paxScore: {enabled: true, weight: 0}},
        fieldDefs
    )
    // weight=0 fails the w>0 gate inside the per-row loop, no contribution
    // → fullWeight=0 → score=null on both
    assert.strictEqual(out[0].score, null)
    assert.strictEqual(out[1].score, null)
})

it("missing weight defaults to 1", () => {
    const a = Score.computeScores(
        [{paxScore: 0}, {paxScore: 10}],
        {paxScore: {enabled: true}},
        fieldDefs
    )
    const b = Score.computeScores(
        [{paxScore: 0}, {paxScore: 10}],
        {paxScore: {enabled: true, weight: 1}},
        fieldDefs
    )
    assert.deepStrictEqual(a.map(r => r.score), b.map(r => r.score))
})

it("negative weight defaults to 1 (no inversion via weight)", () => {
    const out = Score.computeScores(
        [{paxScore: 0}, {paxScore: 10}],
        {paxScore: {enabled: true, weight: -5}},
        fieldDefs
    )
    assert.strictEqual(out[0].score, 0)
    assert.strictEqual(out[1].score, 100)
})

it("determinism: same input → same output across two calls", () => {
    const rows = [
        {paxScore: 9, airlineCount: 2},
        {paxScore: 4, airlineCount: 5},
        {paxScore: 7, airlineCount: 1}
    ]
    const cfg = {
        paxScore:     {enabled: true, weight: 2},
        airlineCount: {enabled: true, weight: 1}
    }
    const a = Score.computeScores(rows, cfg, fieldDefs)
    const b = Score.computeScores(rows, cfg, fieldDefs)
    assert.deepStrictEqual(a.map(r => r.score), b.map(r => r.score))
})

it("does not mutate input rows", () => {
    const r0 = {paxScore: 5}
    const original = JSON.stringify(r0)
    Score.computeScores([r0], {paxScore: {enabled: true, weight: 1}}, fieldDefs)
    assert.strictEqual(JSON.stringify(r0), original)
})

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
