"use strict"

/**
 * Per-class elasticity proposer — pure-function smoke.
 *
 * Locks down the contract of modules/route-assistant/silent-auto-proposer-per-class.js:
 *   - per-class enable / disable
 *   - cargo handling distinct from passenger classes
 *   - per-class step caps
 *   - min-demand floor
 *   - load-factor signal direction (full → up, empty → down)
 *   - elasticity attenuation
 *   - competitor-pull blending when present
 *   - skips below |Δ%| < silentAutoMinDeltaPct
 *   - dispatch wiring through silent-auto-proposers.js
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function loadProposer() {
    global.window = global
    delete global.RouteAssistantPerClassProposer
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposer-per-class.js"), "utf8"))
    return global.RouteAssistantPerClassProposer
}

function loadDispatcher() {
    global.window = global
    delete global.RouteAssistantPerClassProposer
    delete global.RouteAssistantSilentAutoProposers
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposer-per-class.js"), "utf8"))
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposers.js"), "utf8"))
    return global.RouteAssistantSilentAutoProposers
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

console.log("=== per-class elasticity proposer ===")

const baseRoute = {
    destIata:        "LAX",
    hub:             "JFK",
    paxElasticity:   -1.5,
    cargoElasticity: -1.0,
    paxDemandPool:   600,
    cargoDemandPool: 5000,
    rmTightness:     0.85
}
const basePrices = {Y: 250, C: 600, F: 1100, Cargo: 0.85}
const baseCfg = {silentAutoMinDeltaPct: 3, silentAutoMaxStepPct: 10}

it("emits a price for every enabled class with non-noise delta", () => {
    const m = loadProposer()
    const r = m.propose(baseRoute, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true, "should propose ok")
    // High load factor (0.85) → upward signal in every class
    assert.ok(r.prices.Y > basePrices.Y,   "Y should rise on full load")
    assert.ok(r.prices.C > basePrices.C,   "C should rise on full load")
    assert.ok(r.prices.F > basePrices.F,   "F should rise on full load")
    assert.ok(r.prices.Cargo > basePrices.Cargo, "Cargo should rise on full load")
})

it("low load factor pushes prices down across the board", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {rmTightness: 0.3})
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(r.prices.Y < basePrices.Y, "Y should fall on empty load")
    assert.ok(r.prices.Cargo < basePrices.Cargo, "Cargo should fall on empty load")
})

it("LF anchor (0.65) produces no movement (noise-floor skip)", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {rmTightness: 0.65})
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, false, "no movement at LF anchor")
    assert.ok(/no class produced a move/i.test(r.skipReason || ""))
})

it("disabled class is skipped and its key absent from result", () => {
    const m = loadProposer()
    const cfg = Object.assign({}, baseCfg, {
        silentAutoPerClassEnabled: {Y: true, C: false, F: true, Cargo: true}
    })
    const r = m.propose(baseRoute, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(!("C" in r.prices), "C should not appear when disabled")
    assert.ok("Y" in r.prices,     "Y should still appear")
})

it("Cargo-only price still produces ok=true with cargo headline fallback", () => {
    const m = loadProposer()
    const cfg = Object.assign({}, baseCfg, {
        silentAutoPerClassEnabled: {Y: false, C: false, F: false, Cargo: true}
    })
    const r = m.propose(baseRoute, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    assert.deepStrictEqual(Object.keys(r.prices), ["Cargo"])
    assert.ok(r.prices.Cargo > basePrices.Cargo)
})

it("min-demand floor skips classes strictly below threshold", () => {
    const m = loadProposer()
    // Pool=4 is strictly below all three pax mins (Y=50, C=10, F=5).
    // Cargo unaffected (own cargoDemandPool=5000 > 1000).
    const route = Object.assign({}, baseRoute, {paxDemandPool: 4})
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true, "cargo still moves")
    assert.ok(!("Y" in r.prices), "Y skipped on pool 4 < min 50")
    assert.ok(!("C" in r.prices), "C skipped on pool 4 < min 10")
    assert.ok(!("F" in r.prices), "F skipped on pool 4 < min 5")
    assert.ok("Cargo" in r.prices, "Cargo should still move")
})

it("step cap is enforced per class (within rounding slack)", () => {
    const m = loadProposer()
    const cfg = Object.assign({}, baseCfg, {
        silentAutoMaxStepPct: 5,  // tight cap
        silentAutoMinDeltaPct: 1
    })
    const r = m.propose(baseRoute, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    // Allow up to 1 unit of rounding drift on the cap. For Y at $250, +5%
    // is $262.50 → rounds to $263, which is 5.2% — that's the rounding
    // floor on integer prices. Anything beyond that means the cap leaked.
    for (const cls of ["Y", "C", "F", "Cargo"]) {
        if (r.prices[cls] != null) {
            const pct = ((r.prices[cls] - basePrices[cls]) / basePrices[cls]) * 100
            const slack = 100 / basePrices[cls]   // worst-case 1-unit round
            assert.ok(Math.abs(pct) <= 5 + slack + 1e-6,
                cls + " moved " + pct.toFixed(2) + "% (cap 5%, slack " + slack.toFixed(2) + ")")
        }
    }
})

it("per-class cap overrides global cap (within rounding slack)", () => {
    const m = loadProposer()
    const cfg = Object.assign({}, baseCfg, {
        silentAutoMaxStepPct: 10,
        silentAutoPerClassMaxStepPct: {Y: 1, C: null, F: null, Cargo: null}
    })
    const r = m.propose(baseRoute, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    if (r.prices.Y != null) {
        const pctY = ((r.prices.Y - basePrices.Y) / basePrices.Y) * 100
        const slack = 100 / basePrices.Y
        assert.ok(Math.abs(pctY) <= 1 + slack + 1e-6,
            "Y moved " + pctY.toFixed(2) + "% (cap 1%, slack " + slack.toFixed(2) + ")")
    }
})

it("competitor median pulls a price toward it (50/50 blend)", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        rmTightness: 0.65,                     // zero out load signal
        competitorPricesByClass: {C: 800}      // we're at 600, comp is 800
    })
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true, "should produce a move from competitor pull")
    assert.ok(r.prices.C > basePrices.C, "C should move toward competitor median 800")
})

it("ORS indexed competitor median feeds the same class price calculation", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        rmTightness: 0.65,
        competitorPricesByClass: {},
        competitorCountsByClass: {},
        orsCompetitorPricesByClass: {Y: 320},
        orsCompetitorCountsByClass: {Y: 2}
    })
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true, r.skipReason)
    assert.ok(r.prices.Y > basePrices.Y, "Y should move toward ORS indexed median")
    assert.strictEqual(m._classCompetitorMedian("Y", route), 320)
    assert.strictEqual(m._classCompetitorCount("Y", route), 2)
})

it("missing elasticity falls back to safe default (-1.2) without throwing", () => {
    const m = loadProposer()
    const route = {destIata: "LAX", paxDemandPool: 600, cargoDemandPool: 5000, rmTightness: 0.85}
    // No paxElasticity, no cargoElasticity, no ratingPriceElasticityByClass
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true, "should fall back to default elasticity")
})

it("no current price for a class skips that class", () => {
    const m = loadProposer()
    const prices = {Y: 250, C: null, F: 1100, Cargo: 0.85}
    const r = m.propose(baseRoute, prices, baseCfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(!("C" in r.prices), "C with null current price skipped")
})

it("rationale carries one line per moved class plus skip reasons", () => {
    const m = loadProposer()
    const cfg = Object.assign({}, baseCfg, {
        silentAutoPerClassEnabled: {Y: true, C: true, F: false, Cargo: true}
    })
    const r = m.propose(baseRoute, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(Array.isArray(r.rationale), "rationale should be an array")
    assert.ok(r.rationale.some(s => /^\[Y\]/.test(s)), "Y line present")
    assert.ok(r.rationale.some(s => /^\[F\] disabled/.test(s)), "F disabled line present")
})

it("dispatcher returns ok skip envelope when proposer module missing", () => {
    const dispatch = loadDispatcher().dispatch
    const r = dispatch("per-class-elasticity", baseRoute, basePrices, baseCfg, {})
    // PerClass module IS loaded above, so this should succeed
    assert.strictEqual(r.ok, true, "should dispatch to per-class proposer when registered")
})

it("dispatcher list() includes per-class-elasticity", () => {
    const lst = loadDispatcher().list()
    const found = lst.find(p => p.key === "per-class-elasticity")
    assert.ok(found, "per-class-elasticity should be in list()")
    assert.match(found.label, /per-class/i)
})

it("dispatcher defaults to per-class-elasticity when no strategy is provided", () => {
    const dispatch = loadDispatcher().dispatch
    const r = dispatch(null, baseRoute, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true, r.skipReason)
    assert.ok(r.prices.Y > basePrices.Y, "default dispatch should move Y")
    assert.ok(r.prices.Cargo > basePrices.Cargo, "default dispatch should include Cargo")
})

it("rating-derived per-class elasticity overrides aggregate paxElasticity", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        // Aggregate paxElasticity is mild (-1.0); F is much more elastic (-2.5).
        // The F move should be visibly smaller than Y's at the same LF.
        paxElasticity: -1.0,
        ratingPriceElasticityByClass: {Y: -1.0, C: -1.0, F: -2.5},
        rmTightness: 0.85
    })
    const cfg = Object.assign({}, baseCfg, {silentAutoMinDeltaPct: 0.5})
    const r = m.propose(route, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    if (r.prices.Y != null && r.prices.F != null) {
        const yPct = ((r.prices.Y - basePrices.Y) / basePrices.Y) * 100
        const fPct = ((r.prices.F - basePrices.F) / basePrices.F) * 100
        assert.ok(fPct < yPct,
            "F (more elastic) should move less than Y (Y=" + yPct.toFixed(1)
            + "% F=" + fPct.toFixed(1) + "%)")
    }
})

it("rating-derived positive alpha magnitude is treated as price sensitivity", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        paxElasticity: -1.0,
        ratingPriceElasticityByClass: {Y: 1.0, C: 1.0, F: 2.5},
        rmTightness: 0.85
    })
    const cfg = Object.assign({}, baseCfg, {silentAutoMinDeltaPct: 0.5})
    const r = m.propose(route, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    const yPct = ((r.prices.Y - basePrices.Y) / basePrices.Y) * 100
    const fPct = ((r.prices.F - basePrices.F) / basePrices.F) * 100
    assert.ok(fPct < yPct,
        "positive F alpha should damp F more than Y (Y=" + yPct.toFixed(1)
        + "% F=" + fPct.toFixed(1) + "%)")
})

it("apply-layer gate (cfg.applyClassGates) suppresses a class even when silentAutoPerClassEnabled is true", () => {
    const m = loadProposer()
    // Cargo is enabled in the proposer's local map but disabled at the
    // apply-gate layer — defense-in-depth: either layer can suppress.
    const cfg = Object.assign({}, baseCfg, {
        silentAutoPerClassEnabled: {Y: true, C: true, F: true, Cargo: true},
        applyClassGates:           {Cargo: {enabled: false}}
    })
    const r = m.propose(baseRoute, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(!("Cargo" in r.prices), "Cargo should not move when apply gate disables it")
})

it("rmTightnessByClass overrides aggregate rmTightness", () => {
    const m = loadProposer()
    // Aggregate LF says full (upward signal). F-cabin is empty (downward).
    const route = Object.assign({}, baseRoute, {
        rmTightness: 0.85,
        rmTightnessByClass: {Y: 0.85, C: 0.85, F: 0.30, Cargo: 0.85}
    })
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true)
    if (r.prices.Y != null) assert.ok(r.prices.Y > basePrices.Y, "Y up on full")
    if (r.prices.F != null) assert.ok(r.prices.F < basePrices.F, "F down on empty F-cabin LF")
})

it("missing rmTightness produces no load-factor movement instead of a max discount", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        rmTightness: null,
        rmTightnessByClass: {Y: null, C: null, F: null, Cargo: null},
        competitorPricesByClass: {}
    })
    const r = m.propose(route, basePrices, Object.assign({}, baseCfg, {silentAutoMinDeltaPct: 0.5}), {})
    assert.strictEqual(r.ok, false, "no LF or competitor signal should mean no proposal")
    assert.ok(/no class produced a move/i.test(r.skipReason || ""))
})

it("null per-class demand/LF falls back to aggregate demand/LF", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        paxDemandPool: 600,
        cargoDemandPool: 5000,
        rmTightness: 0.85,
        demandPoolByClass: {Y: 600, C: null, F: null, Cargo: null},
        rmTightnessByClass: {Y: 0.85, C: null, F: null, Cargo: null}
    })
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(r.prices.C > basePrices.C, "C should use aggregate LF/demand when class fields are null")
    assert.ok(r.prices.F > basePrices.F, "F should use aggregate LF/demand when class fields are null")
    assert.ok(r.prices.Cargo > basePrices.Cargo, "Cargo should use cargo pool + aggregate LF when class fields are null")
})

it("demandPoolByClass overrides aggregate paxDemandPool floor", () => {
    const m = loadProposer()
    // Aggregate pool 600 passes floor; F per-class pool 3 does not.
    const route = Object.assign({}, baseRoute, {
        paxDemandPool: 600,
        demandPoolByClass: {Y: 600, C: 600, F: 3, Cargo: 5000}
    })
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(!("F" in r.prices), "F skipped on per-class demand floor")
    assert.ok("Y" in r.prices, "Y still moves")
})

it("priceElasticityByClass beats paxElasticity (less elastic class moves more)", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        paxElasticity: -1.5,
        priceElasticityByClass: {Y: -3.0, C: -1.5, F: -0.5},
        rmTightness: 0.85
    })
    const cfg = Object.assign({}, baseCfg, {silentAutoMinDeltaPct: 0.5})
    const r = m.propose(route, basePrices, cfg, {})
    assert.strictEqual(r.ok, true)
    if (r.prices.Y != null && r.prices.F != null) {
        const yPct = ((r.prices.Y - basePrices.Y) / basePrices.Y) * 100
        const fPct = ((r.prices.F - basePrices.F) / basePrices.F) * 100
        assert.ok(fPct > yPct,
            "F (less elastic) should move more than Y (Y=" + yPct.toFixed(1) + "% F=" + fPct.toFixed(1) + "%)")
    }
})

it("Cargo falls back to cargoElasticity when priceElasticityByClass.Cargo missing", () => {
    const m = loadProposer()
    const route = Object.assign({}, baseRoute, {
        priceElasticityByClass: {Y: -1.5, C: -1.5, F: -1.5},  // no Cargo entry
        cargoElasticity: -0.6
    })
    const r = m.propose(route, basePrices, baseCfg, {})
    assert.strictEqual(r.ok, true)
    assert.ok(r.prices.Cargo != null, "Cargo prices via cargoElasticity fallback")
})

console.log("\nper-class-elasticity: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)
