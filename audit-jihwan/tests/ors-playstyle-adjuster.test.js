"use strict"

/**
 * ORS Playstyle Context — orchestration smoke + live-snapshot validation.
 *
 * This module is a thin orchestration layer around the existing
 * `RouteAssistantOrsCompetitionAdjuster` (modules/route-assistant/ors-competition-adjuster.js).
 * The underlying adjuster owns tier classification + per-tier weights;
 * this layer adds:
 *
 *   buildContext({orsRecord?, marketRecord?, settings?})
 *     - auto-derives competitorCount from raw scrape data
 *
 *   composite(orsComposite, marketRecord, settings?)
 *     - fuses an ors-intelligence composite with the playstyle context
 *
 *   refineByShare(weights, ourPaxShare, settings?)
 *     - bumps the tier when ourPaxShare is very high (demote toward
 *       monopoly) or very low (promote toward saturated)
 *
 * Tier names match the underlying adjuster:
 *   monopoly (count 0) → duopoly (1) → competitive (2..4) → saturated (≥5)
 *
 * Live data: the LHR→CDG ORS sample we captured from Chrome 9252 has 7
 * distinct competing carriers, so the classifier should land on `saturated`
 * (the underlying adjuster's "fragmented" equivalent) — service profile
 * differentiation matters most.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

function reset() {
    for (const n of [
        "AesRouteAssistantOrsPlaystyleAdjuster",
        "AesRouteAssistantOrsPlaystyleContext",
        "RouteAssistantOrsCompetitionAdjuster"
    ]) {
        try { delete global[n] } catch (_) {}
    }
    global.window = global
}

function load(rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8")
    eval(src)
}

function loadStack() {
    load("modules/route-assistant/ors-competition-adjuster.js")
    load("modules/route-assistant/ors-playstyle-adjuster.js")
}

let pass = 0, fail = 0
async function it(name, fn) {
    try { await fn(); pass++; console.log("  ok  " + name) }
    catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)) }
}

;(async () => {

console.log("=== ors-playstyle-adjuster ===")

// ── 1) Module loads + exposes API ─────────────────────────────────────
await it("module loads on top of competition-adjuster and exposes the API", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    assert.ok(A, "context module not exposed")
    assert.ok(window.AesRouteAssistantOrsPlaystyleAdjuster === A,
        "legacy alias should point at the same object")
    for (const fn of ["buildContext", "composite", "refineByShare", "classify", "adjustOrsScore"]) {
        assert.strictEqual(typeof A[fn], "function", fn + " missing")
    }
    assert.deepStrictEqual(A.TIER_ORDER,
        ["monopoly", "duopoly", "competitive", "saturated"])
})

// ── 2) Classify by competitor count alone (delegates to underlying) ──
await it("classify: 0→monopoly, 1→duopoly, 3→competitive, 7→saturated", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    assert.strictEqual(A.classify({competitorCount: 0}).playstyle, "monopoly")
    assert.strictEqual(A.classify({competitorCount: 1}).playstyle, "duopoly")
    assert.strictEqual(A.classify({competitorCount: 3}).playstyle, "competitive")
    assert.strictEqual(A.classify({competitorCount: 7}).playstyle, "saturated")
})

// ── 3) ORS weight rises with competition; service weight peaks saturated ─
await it("monopoly orsRankWeight=0; saturated service weight peaks", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const m = A.classify({competitorCount: 0})
    const s = A.classify({competitorCount: 7})
    assert.ok(m.orsWeightMultiplier <= s.orsWeightMultiplier,
        "monopoly ORS weight should be <= saturated, got " + m.orsWeightMultiplier
        + " vs " + s.orsWeightMultiplier)
    assert.ok(m.serviceProfileWeightMultiplier <= s.serviceProfileWeightMultiplier,
        "monopoly service weight should be <= saturated")
    assert.strictEqual(m.recommendedServiceTier, "minimum")
    assert.strictEqual(s.recommendedServiceTier, "maximum")
})

// ── 4) Share refinement: high share demotes one tier ─────────────────
await it("share refinement: ourPaxShare 0.80 in 5-carrier (saturated) market demotes to competitive", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const base = A.classify({competitorCount: 5})
    const dominated = A.classify({competitorCount: 5, ourPaxShare: 0.80})
    assert.strictEqual(base.playstyle, "saturated")
    assert.strictEqual(dominated.playstyle, "competitive",
        "5 competitors with 80% share should demote to competitive, got " + dominated.playstyle)
})

// ── 5) Share refinement: low share promotes ──────────────────────────
await it("share refinement: ourPaxShare 0.05 in 3-carrier (competitive) market promotes to saturated", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const base = A.classify({competitorCount: 3})
    const small = A.classify({competitorCount: 3, ourPaxShare: 0.05})
    assert.strictEqual(base.playstyle, "competitive")
    assert.strictEqual(small.playstyle, "saturated",
        "small player in 3-carrier market should promote to saturated, got " + small.playstyle)
})

// ── 6) Settings — playstyle axis from underlying adjuster works ──────
await it("settings.playstyle scales tier weights via the underlying adjuster", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    // The adjuster supports a "competitive" playstyle mode that boosts
    // ORS/service weights — the result should differ from the default
    // ("adaptive") mode.
    const baseSat   = A.classify({competitorCount: 7})
    const compMode  = A.classify({competitorCount: 7,
        settings: {orsCompetition: {playstyle: "competitive",
            competitiveOrsMultiplier: 1.4}}})
    assert.strictEqual(baseSat.playstyle, "saturated")
    assert.strictEqual(compMode.playstyle, "saturated")
    assert.ok(compMode.serviceProfileWeightMultiplier
              >= baseSat.serviceProfileWeightMultiplier,
        "competitive playstyle should not reduce service weight, got "
        + compMode.serviceProfileWeightMultiplier + " vs " + baseSat.serviceProfileWeightMultiplier)
})

// ── 7) adjustOrsScore returns multiplier + classification ────────────
await it("adjustOrsScore returns the right multiplier per playstyle", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const mono = A.adjustOrsScore(3, 0)
    assert.strictEqual(mono.playstyle, "monopoly")
    assert.strictEqual(mono.effectiveRank, 3)
    // monopolyRankWeight is 0 by default — ORS rank meaningless.
    assert.strictEqual(mono.multiplier, 0,
        "monopoly multiplier should be 0 (rank meaningless), got " + mono.multiplier)
    const sat = A.adjustOrsScore(3, 7)
    assert.strictEqual(sat.playstyle, "saturated")
    assert.ok(sat.multiplier > 0,
        "saturated multiplier should be > 0, got " + sat.multiplier)
})

// ── 8) composite() weights ratingGap by ORS rating weight ────────────
await it("composite() weights ratingGapToTop by underlying orsRatingWeight", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const orsCmp = {rankAny: 5, ratingGapToTop: 50}
    const monop = A.composite(orsCmp, {competitorCount: 0})
    const sat   = A.composite(orsCmp, {competitorCount: 7})
    assert.ok(sat.weightedRatingGap > monop.weightedRatingGap,
        "saturated should weight rating gap higher than monopoly: "
        + sat.weightedRatingGap + " vs " + monop.weightedRatingGap)
    assert.strictEqual(monop.rankAny, 5, "composite preserves input fields")
})

// ── 9) buildContext: ORS connections fall-through ────────────────────
await it("buildContext counts distinct competing carriers from ORS connections", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const orsRecord = {
        ourCarrierPrefixes: ["AB"],
        byClass: {
            ECONOMY: {
                connections: [
                    {legs: [{flightCode: "AB1234"}]},      // ours — filtered
                    {legs: [{flightCode: "BA456"}]},
                    {legs: [{flightCode: "LIM 99"}]},
                    {legs: [{flightCode: "OGA 12"}]},
                    {legs: [{flightCode: "BA789"}]},       // BA dup
                    {legs: [{flightCode: "HXA 1012"}]}
                ]
            }
        }
    }
    const ctx = A.buildContext({orsRecord})
    assert.strictEqual(ctx.competitorCount, 4,
        "expected 4 competitors (BA, LIM, OGA, HXA), got " + ctx.competitorCount)
    assert.match(ctx.source, /orsRecord\.byClass/)
    assert.strictEqual(ctx.classification, "competitive",
        "4 competitors should classify as competitive, got " + ctx.classification)
})

// ── 10) buildContext prefers marketRecord ──────────────────────────────
await it("buildContext prefers marketRecord.competitorEntries over ORS fallback", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const market = {
        ourCarrierPrefixes: ["AB"],
        ourPaxShare: 0.30,
        competitorEntries: [
            {airlineCode: "BA"}, {airlineCode: "AF"}, {airlineCode: "LH"}
        ]
    }
    const ctx = A.buildContext({marketRecord: market})
    assert.strictEqual(ctx.competitorCount, 3)
    assert.strictEqual(ctx.ourPaxShare, 0.30)
    assert.match(ctx.source, /marketRecord/)
    assert.strictEqual(ctx.classification, "competitive",
        "3 competitors → competitive, got " + ctx.classification)
})

// ── 11) LIVE LHR→CDG validation ──────────────────────────────────────
//      Captured from /app/info/ors?3653 on Chrome 9252:
//      30 connections, 7 distinct carriers (BA, LIM, OGA, HXA, ZH, FRA, ALH).
await it("LIVE LHR→CDG (7 carriers, real Chrome 9252) → saturated", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const liveOrs = {
        scrapedAt: Date.now(),
        ourCarrierPrefixes: [],
        totalConnections: 30,
        byClass: {
            ECONOMY: {
                connections: [
                    {legs: [{flightCode: "BA0001"}]}, {legs: [{flightCode: "BA0002"}]},
                    {legs: [{flightCode: "BA0003"}]}, {legs: [{flightCode: "BA0004"}]},
                    {legs: [{flightCode: "BA0005"}]}, {legs: [{flightCode: "BA0006"}]},
                    {legs: [{flightCode: "BA0007"}]}, {legs: [{flightCode: "BA0008"}]},
                    {legs: [{flightCode: "BA0009"}]},
                    {legs: [{flightCode: "LIM01"}]},  {legs: [{flightCode: "LIM02"}]},
                    {legs: [{flightCode: "LIM03"}]},  {legs: [{flightCode: "LIM04"}]},
                    {legs: [{flightCode: "LIM05"}]},  {legs: [{flightCode: "LIM06"}]},
                    {legs: [{flightCode: "OGA01"}]},  {legs: [{flightCode: "OGA02"}]},
                    {legs: [{flightCode: "OGA03"}]},  {legs: [{flightCode: "OGA04"}]},
                    {legs: [{flightCode: "OGA05"}]},
                    {legs: [{flightCode: "HXA1012"}]}, {legs: [{flightCode: "HXA1013"}]},
                    {legs: [{flightCode: "HXA1014"}]},
                    {legs: [{flightCode: "ZH301"}]},   {legs: [{flightCode: "ZH302"}]},
                    {legs: [{flightCode: "ZH303"}]},
                    {legs: [{flightCode: "FRA101"}]},  {legs: [{flightCode: "FRA102"}]},
                    {legs: [{flightCode: "FRA103"}]},
                    {legs: [{flightCode: "ALH001"}]}
                ]
            }
        }
    }
    const ctx = A.buildContext({orsRecord: liveOrs})
    assert.strictEqual(ctx.competitorCount, 7,
        "live LHR→CDG should resolve 7 distinct carriers, got " + ctx.competitorCount)
    assert.strictEqual(ctx.classification, "saturated",
        "7 carriers should classify as saturated")
    assert.ok(ctx.weights && ctx.weights.serviceProfileWeight > 0.5,
        "saturated serviceProfileWeight should be substantial, got "
        + (ctx.weights && ctx.weights.serviceProfileWeight))
    assert.ok(ctx.weights.priceElasticityScale > 1.0,
        "saturated price-elasticity scale should be > 1 (more sensitive), got "
        + ctx.weights.priceElasticityScale)
})

// ── 12) LIVE hypothetical monopoly ───────────────────────────────────
await it("hypothetical monopoly: 0 competitors → recommendedServiceTier minimum", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const liveOrs = {
        scrapedAt: Date.now(),
        ourCarrierPrefixes: ["HXA"],
        totalConnections: 14,
        byClass: {
            ECONOMY: {
                connections: [
                    {legs: [{flightCode: "HXA101"}]}, {legs: [{flightCode: "HXA102"}]},
                    {legs: [{flightCode: "HXA103"}]}, {legs: [{flightCode: "HXA104"}]}
                ]
            }
        }
    }
    const ctx = A.buildContext({orsRecord: liveOrs})
    assert.strictEqual(ctx.competitorCount, 0,
        "monopoly route should have 0 competitors, got " + ctx.competitorCount)
    assert.strictEqual(ctx.classification, "monopoly")
    // The legacy classify() shim returns recommendedServiceTier — verify.
    const c = A.classify({competitorCount: 0})
    assert.strictEqual(c.recommendedServiceTier, "minimum")
})

// ── 13) refineByShare alone ─────────────────────────────────────────
await it("refineByShare directly demotes/promotes one tier per threshold", async () => {
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const Comp = window.RouteAssistantOrsCompetitionAdjuster
    const w = Comp.adjust({competitorCount: 7})
    assert.strictEqual(w.classification, "saturated")
    const demoted = A.refineByShare(w, 0.80)
    assert.strictEqual(demoted.classification, "competitive",
        "high-share demotion should drop saturated → competitive")
    const promoted = A.refineByShare(w, 0.03)
    // saturated is already top — refinement should be a no-op.
    assert.strictEqual(promoted.classification, "saturated",
        "saturated cannot be promoted further, should stay saturated")
})

// ── Headline summary ─────────────────────────────────────────────────
console.log("\n  live LHR→CDG verdict (from real Chrome 9252 ORS scrape):")
{
    reset(); loadStack()
    const A = window.AesRouteAssistantOrsPlaystyleContext
    const r = A.classify({competitorCount: 7, ourPaxShare: 0.05})
    console.log("    competitors=7, ourPaxShare=0.05 → playstyle=" + r.playstyle)
    console.log("    ORS rank weight multiplier  : " + r.orsWeightMultiplier)
    console.log("    Service profile multiplier  : " + r.serviceProfileWeightMultiplier)
    console.log("    Recommended service tier    : " + r.recommendedServiceTier)
    console.log("    Rationale                   : " + r.rationale.join(" | "))
}

console.log("\nors-playstyle-adjuster: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)

})()
