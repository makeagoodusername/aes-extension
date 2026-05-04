/**
 * Smoke test for modules/route-assistant/ors-model.js — locks the
 * top-level contract that `RouteAssistantOrsModel.project(input)`:
 *   1. is pure: same input → same output across two calls
 *   2. accepts the legacy `{priceMultiplier: <num>}` scenario shape and
 *      migrates it to `{priceMultipliers: {Y, C, F}}` internally
 *   3. survives empty/null inputs without throwing, and reports the
 *      gap in the `notes[]` array
 *   4. returns the documented top-level keys
 *   5. degrades cleanly when RouteAssistantProfitEstimator is not on the
 *      global (revenue/profit aggregates fall back to null but the
 *      rating/share/pax half still computes)
 *
 * Intentionally avoids exercising the deep revenue/cost paths through
 * RouteAssistantProfitEstimator — those are covered separately by
 * profit-estimator-byclass.test.js. This is the no-crash + structural
 * contract the panel relies on every render.
 */
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")
// Don't load profit-estimator — _estimate() early-returns null when
// RouteAssistantProfitEstimator is undefined, which is what we want
// to verify happens cleanly.
const Model = require(path.join(ROOT, "modules/route-assistant/ors-model.js"))

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

console.log("=== Route Assistant ORS model — smoke ===")

// --- Fixtures --------------------------------------------------------------

function fixtureRoute() {
    // Minimal but realistic-shape route: one own connection + two competitors,
    // ECONOMY only. Missing cargo + missing C/F so we hit several
    // "no cached fare; skipped" paths.
    return {
        hub: "JFK", dest: "LAX",
        distanceKm: 3970,
        currentFrequency: 7,
        paxScore: 8, cargoScore: 4,
        paxDemandPool: 12000,
        paxElasticity: -0.6,
        ourEnterpriseId: "ent-1",
        ourFlightIds: new Set(["fn-1"]),
        ownPricing: {prices: {Y: 0.10}},   // AS$/km
        orsByClass: {
            ECONOMY: {
                topCompetitorRating: 110,
                // Real ORS scraper output uses `legs[]` per connection.
                // _projectClass tags `oursAll` from every-leg-isOurs (line 459).
                connections: [
                    {rating: 100, legs: [{isGround: false, isOurs: true}],  flightId: "fn-1"},
                    {rating: 105, legs: [{isGround: false, isOurs: false}], enterpriseId: "ent-2"},
                    {rating: 95,  legs: [{isGround: false, isOurs: false}], enterpriseId: "ent-3"}
                ]
            }
        },
        spec: null   // no spec → _estimate returns null cleanly
    }
}

function fixtureScenario() {
    return {
        priceMultipliers: {Y: 1.1, C: 1, F: 1},
        cargoMultiplier:  1,
        frequency:        null,
        comfortDelta:     0
    }
}

function fixtureModelParams() {
    return {
        ratingPriceElasticity: 8,
        ratingComfortLift:     5,
        shareTemperature:      25,
        perRouteT:             null
    }
}

// --- Tests -----------------------------------------------------------------

it("project is pure: same input → same output across two calls", () => {
    const input = {
        route:        fixtureRoute(),
        scenario:     fixtureScenario(),
        modelParams:  fixtureModelParams(),
        economics:    {yieldPerKm: 0.10},
        useRealDemandForLF: false
    }
    const a = Model.project(input)
    const b = Model.project(input)
    // Notes array order/content is part of the contract; deep-equal everything.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
})

it("returns the documented top-level keys", () => {
    const out = Model.project({
        route:       fixtureRoute(),
        scenario:    fixtureScenario(),
        modelParams: fixtureModelParams(),
        economics:   {}
    })
    // Documented on the project() JSDoc (around line 30):
    //   {baseline, projected, delta, perClass, notes, modelParams, …}
    assert.ok("baseline"    in out, "baseline key present")
    assert.ok("projected"   in out, "projected key present")
    assert.ok("delta"       in out, "delta key present")
    assert.ok("perClass"    in out, "perClass key present")
    assert.ok(Array.isArray(out.notes), "notes is an array")
    assert.ok(out.modelParams && typeof out.modelParams === "object", "modelParams echoed")
})

it("accepts the legacy {priceMultiplier: N} scenario shape", () => {
    // Pre-2b callers passed a single multiplier. Code comments (line 73)
    // say it's accepted and migrated via _normaliseScenario.
    const route   = fixtureRoute()
    const params  = fixtureModelParams()
    const legacy  = {priceMultiplier: 1.1}
    const modern  = {priceMultipliers: {Y: 1.1, C: 1, F: 1}, cargoMultiplier: 1}

    const fromLegacy = Model.project({route, scenario: legacy, modelParams: params, economics: {}})
    const fromModern = Model.project({route, scenario: modern, modelParams: params, economics: {}})

    // Y multiplier is what drives the per-class projection; the two should
    // produce equivalent baseline + projected aggregates on the Y class.
    assert.strictEqual(fromLegacy.perClass.Y && fromLegacy.perClass.Y.projectedRating,
                       fromModern.perClass.Y && fromModern.perClass.Y.projectedRating,
                       "Y projectedRating identical between legacy + modern shapes")
    assert.strictEqual(fromLegacy.perClass.Y && fromLegacy.perClass.Y.projectedShare,
                       fromModern.perClass.Y && fromModern.perClass.Y.projectedShare,
                       "Y projectedShare identical between legacy + modern shapes")
})

it("empty route does not throw", () => {
    let threw = false
    let out
    try {
        out = Model.project({route: {}, scenario: {}, modelParams: {}, economics: {}})
    } catch (e) {
        threw = true
    }
    assert.strictEqual(threw, false, "empty route should not throw")
    assert.ok(out, "returns a result object")
    assert.ok(Array.isArray(out.notes), "notes is an array")
    // Should diagnose the "no ORS connection list cached" gap.
    const gapNote = out.notes.find(n => /no ORS connection list cached/i.test(n))
    assert.ok(gapNote, "notes mentions missing connection list when route is empty")
})

it("null/undefined input does not throw", () => {
    let threw = false
    try { Model.project(null) }      catch (e) { threw = true }
    assert.strictEqual(threw, false, "project(null) should not throw")

    threw = false
    try { Model.project(undefined) } catch (e) { threw = true }
    assert.strictEqual(threw, false, "project(undefined) should not throw")
})

it("missing C / F connections produce class:null without crashing", () => {
    const route = fixtureRoute()
    // ECONOMY-only fixture; C and F intentionally absent from orsByClass.
    const out = Model.project({
        route, scenario: fixtureScenario(),
        modelParams: fixtureModelParams(), economics: {}
    })
    assert.strictEqual(out.perClass.C, null, "C is null when no BUSINESS connections")
    assert.strictEqual(out.perClass.F, null, "F is null when no FIRST connections")
    assert.ok(out.perClass.Y, "Y is populated when ECONOMY connections present")
})

it("estimator unavailable → revenue/profit fall back to null without crashing", () => {
    // No global RouteAssistantProfitEstimator set in this test process.
    assert.strictEqual(typeof global.RouteAssistantProfitEstimator, "undefined",
        "estimator should NOT be on global")
    const out = Model.project({
        route: fixtureRoute(), scenario: fixtureScenario(),
        modelParams: fixtureModelParams(), economics: {yieldPerKm: 0.10}
    })
    // baseline + projected exist, but profitPerWeek is null because _estimate
    // early-returned null at line 814 (`if (typeof RouteAssistantProfitEstimator === "undefined") return null`).
    assert.ok(out.baseline,  "baseline exists")
    assert.ok(out.projected, "projected exists")
    // The exact key depends on _estimate's null shape — at minimum,
    // accessing a profit-related field shouldn't crash.
    const baselineProfit = out.baseline && out.baseline.profitPerWeek
    const projectedProfit = out.projected && out.projected.profitPerWeek
    assert.ok(baselineProfit == null || isFinite(baselineProfit),
        "baseline profitPerWeek is null or a finite number")
    assert.ok(projectedProfit == null || isFinite(projectedProfit),
        "projected profitPerWeek is null or a finite number")
})

it("priceMultiplier=1 yields delta ratings ≈ 0 on Y", () => {
    // No price change AND no comfort change → projected rating ≈ baseline.
    const out = Model.project({
        route:       fixtureRoute(),
        scenario:    {priceMultipliers: {Y: 1, C: 1, F: 1}, cargoMultiplier: 1, comfortDelta: 0},
        modelParams: fixtureModelParams(),
        economics:   {}
    })
    const Y = out.perClass.Y
    assert.ok(Y, "Y class projected")
    const ratingDelta = Y.projectedRating - Y.baselineRating
    assert.ok(Math.abs(ratingDelta) < 1e-6,
        "no price/comfort change → no rating shift (delta = " + ratingDelta + ")")
})

it("Y price up → Y rating down (negative shift)", () => {
    // Raising Y price 20% should lower the projected rating
    // (ratingPriceElasticity = 8 points per ±100% change → -1.6 points here).
    const out = Model.project({
        route:       fixtureRoute(),
        scenario:    {priceMultipliers: {Y: 1.2, C: 1, F: 1}, cargoMultiplier: 1, comfortDelta: 0},
        modelParams: fixtureModelParams(),
        economics:   {}
    })
    const Y = out.perClass.Y
    assert.ok(Y, "Y class projected")
    assert.ok(Y.projectedRating < Y.baselineRating,
        "20% price hike should drop rating (got base=" + Y.baselineRating
        + ", proj=" + Y.projectedRating + ")")
})

it("Y price down → Y rating up (positive shift)", () => {
    const out = Model.project({
        route:       fixtureRoute(),
        scenario:    {priceMultipliers: {Y: 0.8, C: 1, F: 1}, cargoMultiplier: 1, comfortDelta: 0},
        modelParams: fixtureModelParams(),
        economics:   {}
    })
    const Y = out.perClass.Y
    assert.ok(Y, "Y class projected")
    assert.ok(Y.projectedRating > Y.baselineRating,
        "20% price cut should lift rating (got base=" + Y.baselineRating
        + ", proj=" + Y.projectedRating + ")")
})

it("auto-derives aircraft-fit bonus when modifier module is loaded", () => {
    // The model checks `window.AesStrategyAircraftOrsModifier` because in
    // production it runs as a content script. Stand up a window shim here.
    const savedWindow = global.window
    global.window = global.window || global
    const savedModifier = global.window.AesStrategyAircraftOrsModifier
    global.window.AesStrategyAircraftOrsModifier = {
        lookup: (spec, dist) => (spec && spec.seats >= 250 && dist > 4500) ? 3 : 0,
        categoryFor: (s) => s >= 250 ? "wide" : "narrow",
        distanceBucketFor: (d) => d > 4500 ? "long" : "medium"
    }
    try {
        const route = fixtureRoute()
        route.distanceKm = 8000
        route.spec = {seats: 300}
        // Compare to a control without the modifier — the rating bonus should
        // lift the projected rating.
        const withMod = Model.project({
            route, scenario: fixtureScenario(),
            modelParams: fixtureModelParams(), economics: {}
        })
        global.window.AesStrategyAircraftOrsModifier = undefined
        const noMod  = Model.project({
            route, scenario: fixtureScenario(),
            modelParams: fixtureModelParams(), economics: {}
        })
        assert.ok(withMod.perClass.Y, "Y class projected with modifier")
        assert.ok(noMod.perClass.Y,   "Y class projected without modifier")
        assert.ok(withMod.perClass.Y.projectedRating > noMod.perClass.Y.projectedRating,
            "aircraft-fit bonus lifts projected rating " +
            "(with=" + withMod.perClass.Y.projectedRating + ", " +
            "no=" + noMod.perClass.Y.projectedRating + ")")
        const noteHit = withMod.notes.find(n => /aircraft-fit bonus/i.test(n))
        assert.ok(noteHit, "notes mention the aircraft-fit bonus for transparency")
    } finally {
        global.window.AesStrategyAircraftOrsModifier = savedModifier
        if (savedWindow === undefined) delete global.window
        else global.window = savedWindow
    }
})

it("explicit route.aircraftBonus wins over auto-derivation", () => {
    const savedWindow = global.window
    global.window = global.window || global
    const savedModifier = global.window.AesStrategyAircraftOrsModifier
    global.window.AesStrategyAircraftOrsModifier = {
        lookup: () => -10,   // would tank rating if used
        categoryFor: () => "wide",
        distanceBucketFor: () => "long"
    }
    try {
        const route = fixtureRoute()
        route.aircraftBonus = 5     // explicit caller value
        route.spec = {seats: 300}
        route.distanceKm = 8000
        const out = Model.project({
            route, scenario: fixtureScenario(),
            modelParams: fixtureModelParams(), economics: {}
        })
        // No "aircraft-fit bonus" note when the caller supplied the bonus —
        // the auto-derivation branch is only entered when route.aircraftBonus
        // is unset.
        const autoNote = out.notes.find(n => /aircraft-fit bonus/i.test(n))
        assert.strictEqual(autoNote, undefined,
            "explicit route.aircraftBonus suppresses auto-derivation log")
    } finally {
        global.window.AesStrategyAircraftOrsModifier = savedModifier
        if (savedWindow === undefined) delete global.window
        else global.window = savedWindow
    }
})

it("aircraft ORS attraction from type specs shifts projected rating with caps", () => {
    const route = fixtureRoute()
    route.spec = {orsAttraction: 90}
    const out = Model.project({
        route,
        scenario: {priceMultipliers: {Y: 1, C: 1, F: 1}, cargoMultiplier: 1, comfortDelta: 0},
        modelParams: Object.assign({}, fixtureModelParams(), {
            aircraftAttractionNeutral: 50,
            aircraftAttractionScale: 0.1,
            aircraftAttractionMaxBonus: 2
        }),
        economics: {}
    })
    assert.ok(out.perClass.Y, "Y class projected")
    assert.ok(Math.abs((out.perClass.Y.projectedRating - out.perClass.Y.baselineRating) - 2) < 1e-6,
        "attraction bonus is capped at +2 rating points")
    assert.ok(out.notes.some(n => /aircraft ORS attraction/i.test(n)),
        "notes mention the aircraft attraction adjustment")
})

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
