"use strict"

/**
 * ORS competition-aware adjuster smoke.
 *
 * Tests:
 *  • classify() across 0/1/2/3/4/5/10 competitors
 *  • adjust() weights at each tier
 *  • settings overrides take effect
 *  • per-route overrides win over global settings
 *  • route.competitorYsCount preferred when present
 *  • applyToSignal + applyElasticityScale helpers
 *  • Pure: deterministic across calls, no DOM, no chrome
 */

const fs = require("fs")
const path = require("path")
const assert = require("assert")
const ROOT = path.resolve(__dirname, "..", "..", "..")

let pass = 0, fail = 0
async function it(name, fn) {
    try { await fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
    }
}

function load() {
    delete global.window
    global.window = {}
    const src = fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-competition-adjuster.js"), "utf8")
    eval(src)
    return global.window.RouteAssistantOrsCompetitionAdjuster
}

async function run() {
    console.log("\nORS competition adjuster smoke:")

    const A = load()
    assert.ok(A, "module loaded")

    // === classify ===
    await it("classify 0 → monopoly", () => {
        assert.strictEqual(A.classify(0), "monopoly")
    })
    await it("classify 1 → duopoly", () => {
        assert.strictEqual(A.classify(1), "duopoly")
    })
    await it("classify 2 → competitive", () => {
        assert.strictEqual(A.classify(2), "competitive")
    })
    await it("classify 3 → competitive (at threshold)", () => {
        assert.strictEqual(A.classify(3), "competitive")
    })
    await it("classify 5 → saturated (at threshold)", () => {
        assert.strictEqual(A.classify(5), "saturated")
    })
    await it("classify 10 → saturated", () => {
        assert.strictEqual(A.classify(10), "saturated")
    })
    await it("classify negative → monopoly (clamped)", () => {
        assert.strictEqual(A.classify(-3), "monopoly")
    })
    await it("classify NaN/null → monopoly", () => {
        assert.strictEqual(A.classify(NaN), "monopoly")
        assert.strictEqual(A.classify(null), "monopoly")
        assert.strictEqual(A.classify(undefined), "monopoly")
    })

    // === adjust output shape ===
    await it("adjust returns full envelope", () => {
        const r = A.adjust({competitorCount: 1})
        assert.strictEqual(typeof r.competitorCount, "number")
        assert.strictEqual(typeof r.classification, "string")
        assert.strictEqual(typeof r.orsRankWeight, "number")
        assert.strictEqual(typeof r.orsRatingWeight, "number")
        assert.strictEqual(typeof r.serviceProfileWeight, "number")
        assert.strictEqual(typeof r.priceElasticityScale, "number")
        assert.strictEqual(typeof r.rationale, "string")
    })

    // === Monopoly behavior ===
    await it("monopoly: ORS rank weight = 0", () => {
        const r = A.adjust({competitorCount: 0})
        assert.strictEqual(r.classification, "monopoly")
        assert.strictEqual(r.orsRankWeight, 0)
    })
    await it("monopoly: rating weight low (0.10)", () => {
        const r = A.adjust({competitorCount: 0})
        assert.strictEqual(r.orsRatingWeight, 0.10)
    })
    await it("monopoly: elasticity scale < 1 (less price-sensitive)", () => {
        const r = A.adjust({competitorCount: 0})
        assert.ok(r.priceElasticityScale < 1, "got " + r.priceElasticityScale)
        assert.strictEqual(r.priceElasticityScale, 0.5)
    })

    // === Duopoly behavior ===
    await it("duopoly: rank weight high (≥0.8)", () => {
        const r = A.adjust({competitorCount: 1})
        assert.ok(r.orsRankWeight >= 0.8, "got " + r.orsRankWeight)
    })
    await it("duopoly: elasticity scale = 1 (baseline)", () => {
        const r = A.adjust({competitorCount: 1})
        assert.strictEqual(r.priceElasticityScale, 1.0)
    })

    // === Saturated behavior ===
    await it("saturated: service profile weight peaks (0.85)", () => {
        const r = A.adjust({competitorCount: 5})
        assert.strictEqual(r.classification, "saturated")
        assert.strictEqual(r.serviceProfileWeight, 0.85)
    })
    await it("saturated: rating weight peaks (0.90)", () => {
        const r = A.adjust({competitorCount: 8})
        assert.strictEqual(r.orsRatingWeight, 0.90)
    })
    await it("saturated: elasticity scale > 1 (more sensitive)", () => {
        const r = A.adjust({competitorCount: 8})
        assert.strictEqual(r.priceElasticityScale, 1.4)
    })

    // === Weight transitions monotonic across tiers ===
    await it("service weight non-decreasing as competitors go up", () => {
        const ws = [0, 1, 2, 3, 5, 8].map(n => A.adjust({competitorCount: n}).serviceProfileWeight)
        for (let i = 1; i < ws.length; i++) {
            assert.ok(ws[i] >= ws[i-1],
                "service weight should not drop: " + JSON.stringify(ws))
        }
    })
    await it("elasticity scale non-decreasing as competitors go up", () => {
        const es = [0, 1, 2, 3, 5, 8].map(n => A.adjust({competitorCount: n}).priceElasticityScale)
        for (let i = 1; i < es.length; i++) {
            assert.ok(es[i] >= es[i-1],
                "elasticity scale should not drop: " + JSON.stringify(es))
        }
    })

    // === Settings override ===
    await it("settings override changes monopoly rank weight", () => {
        const r = A.adjust({
            competitorCount: 0,
            settings: {monopolyRankWeight: 0.50}
        })
        assert.strictEqual(r.orsRankWeight, 0.50)
    })

    await it("settings override changes saturated threshold", () => {
        // Default sat threshold is 5; with override 3 → 3 competitors = saturated
        const r = A.adjust({
            competitorCount: 3,
            settings: {saturatedCountThreshold: 3}
        })
        assert.strictEqual(r.classification, "saturated")
    })

    // === Per-route override ===
    await it("per-route override wins over global settings", () => {
        const r = A.adjust({
            competitorCount: 1,
            hub: "FRA",
            dest: "JFK",
            settings: {
                duopolyRankWeight: 0.85,
                overrides: {
                    "FRA-JFK": {duopolyRankWeight: 0.20}   // FRA-JFK wants ORS suppressed
                }
            }
        })
        assert.strictEqual(r.orsRankWeight, 0.20, "per-route override should win")
    })

    await it("per-route override only applies to matching route", () => {
        const settings = {
            duopolyRankWeight: 0.85,
            overrides: {"FRA-JFK": {duopolyRankWeight: 0.20}}
        }
        const matched   = A.adjust({competitorCount: 1, hub: "FRA", dest: "JFK", settings})
        const unmatched = A.adjust({competitorCount: 1, hub: "FRA", dest: "LAX", settings})
        assert.strictEqual(matched.orsRankWeight, 0.20)
        assert.strictEqual(unmatched.orsRankWeight, 0.85)
    })

    // === route.competitorYsCount preferred ===
    await it("route.competitorYsCount overrides input.competitorCount", () => {
        const r = A.adjust({
            competitorCount: 0,    // would be monopoly
            route: {competitorYsCount: 4}    // but route says 4 → competitive
        })
        assert.strictEqual(r.classification, "competitive")
        assert.strictEqual(r.competitorCount, 4)
    })

    await it("route without competitorYsCount → falls back to input", () => {
        const r = A.adjust({
            competitorCount: 1,
            route: {someOtherField: 42}    // no competitorYsCount
        })
        assert.strictEqual(r.competitorCount, 1)
    })

    await it("route.competitorCountsByClass wins when classKey is supplied", () => {
        const r = A.adjust({
            competitorCount: 0,
            classKey: "C",
            route: {
                competitorYsCount: 0,
                competitorCountsByClass: {Y: 0, C: 4, F: 2, Cargo: 5}
            }
        })
        assert.strictEqual(r.competitorCount, 4)
        assert.strictEqual(r.classification, "competitive")
    })

    await it("adaptive ORS playstyle suppresses monopoly and maximises saturated service", () => {
        const settings = {
            playstyle: "adaptive",
            monopolyOrsMultiplier: 0.25,
            competitiveOrsMultiplier: 2
        }
        const monopoly = A.adjust({competitorCount: 0, settings})
        const saturated = A.adjust({competitorCount: 5, settings})
        assert.strictEqual(monopoly.playstyle, "adaptive")
        assert.ok(monopoly.serviceProfileWeight < 0.20,
            "monopoly service weight should be damped, got " + monopoly.serviceProfileWeight)
        assert.strictEqual(saturated.serviceProfileWeight, 1)
        assert.strictEqual(saturated.orsRatingWeight, 1)
    })

    // === Helpers ===
    await it("applyToSignal multiplies signal by rank weight by default", () => {
        const w = A.adjust({competitorCount: 1})    // duopoly: rank=0.85
        const s = A.applyToSignal(10, w)
        assert.strictEqual(s, 10 * 0.85)
    })

    await it("applyToSignal kind='rating' uses rating weight", () => {
        const w = A.adjust({competitorCount: 5})    // saturated: rating=0.90
        const s = A.applyToSignal(10, w, "rating")
        assert.strictEqual(s, 10 * 0.90)
    })

    await it("applyToSignal kind='service' uses service weight", () => {
        const w = A.adjust({competitorCount: 5})
        const s = A.applyToSignal(10, w, "service")
        assert.strictEqual(s, 10 * 0.85)
    })

    await it("applyToSignal preserves NaN/Infinity", () => {
        const w = A.adjust({competitorCount: 1})
        assert.ok(Number.isNaN(A.applyToSignal(NaN, w)))
        assert.strictEqual(A.applyToSignal(Infinity, w), Infinity)
    })

    await it("applyElasticityScale scales negative elasticities correctly", () => {
        const monoW = A.adjust({competitorCount: 0})   // scale 0.5
        const satW  = A.adjust({competitorCount: 5})   // scale 1.4
        assert.strictEqual(A.applyElasticityScale(-1.2, monoW), -0.6)
        assert.strictEqual(A.applyElasticityScale(-1.2, satW),  -1.68)
    })

    // === Rationale ===
    await it("rationale is a one-line string with key facts", () => {
        const r = A.adjust({competitorCount: 0})
        assert.match(r.rationale, /monopoly/)
        assert.match(r.rationale, /0 competitors/)
        assert.match(r.rationale, /ORS suppressed/)
        const r2 = A.adjust({competitorCount: 5})
        assert.match(r2.rationale, /saturated/)
        assert.match(r2.rationale, /service profile maximised/)
    })

    // === Determinism ===
    await it("output is deterministic across 5 calls", () => {
        const inp = {competitorCount: 3, hub: "FRA", dest: "MAD"}
        const refs = []
        for (let i = 0; i < 5; i++) refs.push(A.adjust(inp))
        for (let i = 1; i < 5; i++) {
            assert.deepStrictEqual(refs[i], refs[0])
        }
    })

    // === Pure: clamp + safety ===
    await it("invalid settings ignored (NaN, undefined)", () => {
        const r = A.adjust({
            competitorCount: 1,
            settings: {duopolyRankWeight: "not-a-number"}
        })
        assert.strictEqual(r.orsRankWeight, 0.85, "should fall back to default")
    })

    await it("weights clamped to [0..1]", () => {
        const r = A.adjust({
            competitorCount: 1,
            settings: {duopolyRankWeight: 5.0}   // out of range
        })
        assert.ok(r.orsRankWeight <= 1)
        const r2 = A.adjust({
            competitorCount: 1,
            settings: {duopolyRankWeight: -2.0}  // negative
        })
        assert.ok(r2.orsRankWeight >= 0)
    })

    await it("elasticity scale clamped to [0.1..3]", () => {
        const r = A.adjust({
            competitorCount: 1,
            settings: {elasticityScaleDuopoly: 100}
        })
        assert.ok(r.priceElasticityScale <= 3)
        const r2 = A.adjust({
            competitorCount: 1,
            settings: {elasticityScaleDuopoly: -5}
        })
        assert.ok(r2.priceElasticityScale >= 0.1)
    })

    console.log("\n  " + pass + " passed, " + fail + " failed")
    if (fail) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
