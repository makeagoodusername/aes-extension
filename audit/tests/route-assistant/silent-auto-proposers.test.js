"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function loadModule() {
    global.window = global
    global.Date.now = Date.now
    delete global.RouteAssistantSilentAutoProposers
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposers.js"), "utf8"))
    return global.RouteAssistantSilentAutoProposers
}

function loadPerClassModule() {
    global.window = global
    global.Date.now = Date.now
    delete global.RouteAssistantPerClassProposer
    delete global.RouteAssistantSilentAutoProposers
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposer-per-class.js"), "utf8"))
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposers.js"), "utf8"))
    return global.RouteAssistantSilentAutoProposers
}

function loadPerClassModuleWithCompetition() {
    global.window = global
    global.Date.now = Date.now
    delete global.RouteAssistantPerClassProposer
    delete global.RouteAssistantSilentAutoProposers
    delete global.RouteAssistantOrsCompetitionAdjuster
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-competition-adjuster.js"), "utf8"))
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposer-per-class.js"), "utf8"))
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposers.js"), "utf8"))
    return global.RouteAssistantSilentAutoProposers
}

let pass = 0
let fail = 0
function it(name, fn) {
    try {
        fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== silent-auto proposers ===")

it("ors-elasticity emits capped Y C F and Cargo prices from the ORS move", () => {
    const proposers = loadModule()
    global.RouteAssistantOrsModel = {
        scanPriceCurve() {
            return {
                points: [],
                baselineProfit: 10000,
                optimal: {
                    multiplier: 1.30,
                    profitPerWeek: 12000,
                    deltaProfit: 2000
                }
            }
        }
    }

    const now = Date.now()
    const route = {
        hub: "ICN",
        destIata: "NRT",
        ownPricing: {prices: {Y: 100, C: 200, F: 300, Cargo: 0.85}},
        orsByClass: {
            ECONOMY: {scrapedAt: now},
            BUSINESS: {scrapedAt: now},
            FIRST: {scrapedAt: now},
            CARGO: {scrapedAt: now}
        }
    }
    const prop = proposers.dispatch("ors-elasticity", route, route.ownPricing.prices, {
        silentAutoMinDeltaPct: 1,
        silentAutoMaxStepPct: 10,
        silentAutoOrsMaxAgeMin: 60
    }, {
        modelParams: {},
        economics: {},
        useRealDemandForLF: false
    })

    assert.strictEqual(prop.ok, true)
    assert.deepStrictEqual(prop.prices, {Y: 110, C: 220, F: 330, Cargo: 0.93})
    assert.strictEqual(prop.newY, 110)
    assert.match(prop.reason, /applied mult 1\.10/)
    assert.match(prop.rationale.join(" "), /Y\/C\/F\/Cargo/)
})

it("strategy-objective emits cargo-only moves without requiring a Y move", () => {
    const proposers = loadModule()
    const bucket = {Y: null, C: null, F: null, Cargo: {
        classKey: "Cargo",
        fromPct: 100,
        toPct: 92,
        objective: {kind: "balanced"},
        rationale: ["cargo lane discount"]
    }}
    const ctx = {hub: "ICN", strategyMovesByPair: new Map([["ICN-NRT", bucket]])}
    const prop = proposers.dispatch("strategy-objective",
        {hub: "ICN", destIata: "NRT"},
        {Y: 100, Cargo: 80},
        {silentAutoMinDeltaPct: 1, silentAutoMaxStepPct: 10},
        ctx)

    assert.strictEqual(prop.ok, true, prop.skipReason)
    assert.deepStrictEqual(prop.prices, {Cargo: 74})
    assert.strictEqual(prop.prevY, 100)
    assert.strictEqual(prop.newY, 100)
    assert.match(prop.reason, /Cargo/)
    assert.match(prop.rationale.join(" "), /\[Cargo\]/)
})

it("ors-elasticity falls back to its multiplier for Cargo when per-class cargo signal is absent", () => {
    const proposers = loadPerClassModule()
    global.RouteAssistantOrsModel = {
        scanPriceCurve() {
            return {points: [1, 2], optimal: {multiplier: 1.30, deltaProfit: 2000}}
        }
    }

    const now = Date.now()
    const route = {
        hub: "ICN",
        destIata: "NRT",
        ownPricing: {prices: {Y: 100, C: 200, F: 300, Cargo: 0.85}},
        orsByClass: {
            ECONOMY: {scrapedAt: now},
            CARGO: {scrapedAt: now}
        }
    }
    const prop = proposers.dispatch("ors-elasticity", route, route.ownPricing.prices, {
        silentAutoMinDeltaPct: 1,
        silentAutoMaxStepPct: 10,
        silentAutoOrsMaxAgeMin: 60
    }, {})

    assert.strictEqual(prop.ok, true, prop.skipReason)
    assert.strictEqual(prop.prices.Cargo, 0.93)
    assert.strictEqual(prop.perClassDeltas.Cargo, 10)
})

it("competitor-median respects the Y apply gate before proposing", () => {
    const proposers = loadModule()
    const prop = proposers.dispatch("competitor-median",
        {hub: "ICN", destIata: "NRT", competitorMedianPriceY: 130, competitorYsCount: 3},
        {Y: 100},
        {
            silentAutoMinDeltaPct: 1,
            silentAutoMaxStepPct: 10,
            applyClassGates: {Y: {enabled: false}}
        },
        {})

    assert.strictEqual(prop.ok, false)
    assert.match(prop.skipReason, /Y disabled/)
})

it("per-class-elasticity distinguishes Y C F and Cargo with class-specific demand", () => {
    const proposers = loadPerClassModule()
    const route = {
        hub: "ICN",
        destIata: "NRT",
        demandPoolByClass: {Y: 180, C: 28, F: 12, Cargo: 2500},
        priceElasticityByClass: {Y: -0.8, C: -2.4, F: -1.1, Cargo: -0.6},
        rmTightnessByClass: {Y: 0.92, C: 0.34, F: 0.70, Cargo: 0.88},
        competitorPricesByClass: {Y: 130, C: 170, F: 640, Cargo: 92}
    }
    const prop = proposers.dispatch("per-class-elasticity", route,
        {Y: 100, C: 210, F: 520, Cargo: 75},
        {
            silentAutoMinDeltaPct: 1,
            silentAutoMaxStepPct: 10,
            silentAutoPerClassMaxStepPct: {Y: null, C: null, F: null, Cargo: null}
        },
        {})

    assert.strictEqual(prop.ok, true)
    assert.ok(prop.prices.Y > 100, prop.rationale && prop.rationale.join(" | "))
    assert.ok(prop.prices.C < 210, prop.rationale && prop.rationale.join(" | "))
    assert.ok(prop.prices.F > 520, prop.rationale && prop.rationale.join(" | "))
    assert.ok(prop.prices.Cargo > 75, prop.rationale && prop.rationale.join(" | "))
    assert.match(prop.rationale.join(" "), /\[Cargo\]/)
})

it("per-class-elasticity applies competition tier per cabin instead of economy-only", () => {
    const proposers = loadPerClassModuleWithCompetition()
    const route = {
        hub: "ICN",
        destIata: "NRT",
        competitorYsCount: 0,
        competitorCountsByClass: {Y: 0, C: 2, F: 4, Cargo: 5},
        demandPoolByClass: {Y: 180, C: 28, F: 12, Cargo: 2500},
        priceElasticityByClass: {Y: -0.8, C: -0.8, F: -0.8, Cargo: -0.8},
        rmTightnessByClass: {Y: 0.92, C: 0.92, F: 0.92, Cargo: 0.92},
        competitorPricesByClass: {Y: 130, C: 260, F: 650, Cargo: 92}
    }
    const prop = proposers.dispatch("per-class-elasticity", route,
        {Y: 100, C: 210, F: 520, Cargo: 75},
        {
            silentAutoMinDeltaPct: 1,
            silentAutoMaxStepPct: 10,
            silentAutoPerClassMaxStepPct: {Y: null, C: null, F: null, Cargo: null},
            orsCompetition: {playstyle: "adaptive", monopolyOrsMultiplier: 0.25, competitiveOrsMultiplier: 1.5}
        },
        {})

    assert.strictEqual(prop.ok, true, prop.skipReason)
    const text = prop.rationale.join(" ")
    assert.match(text, /\[Y\].*monopoly/)
    assert.match(text, /\[C\].*competitive/)
    assert.match(text, /\[Cargo\].*saturated/)
})

it("surface advisor message lists all moved classes instead of only Y", () => {
    const proposers = loadPerClassModule()
    const emitted = []
    global.AesCanvasEvents = {ADVISOR_SUGGESTION: "advisor:suggestion", EDIT_STAGED: "edit:staged"}
    global.CentralHubBus = {
        emit(type, payload) { emitted.push({type, payload}) }
    }
    const route = {
        hub: "ICN",
        destIata: "NRT",
        demandPoolByClass: {Y: 180, C: 28, F: 12, Cargo: 2500},
        priceElasticityByClass: {Y: -0.8, C: -2.4, F: -1.1, Cargo: -0.6},
        rmTightnessByClass: {Y: 0.92, C: 0.34, F: 0.70, Cargo: 0.88},
        competitorPricesByClass: {Y: 130, C: 170, F: 640, Cargo: 92}
    }
    const result = proposers.surface("per-class-elasticity", route,
        {Y: 100, C: 210, F: 520, Cargo: 75},
        {
            silentAutoMinDeltaPct: 1,
            silentAutoMaxStepPct: 10,
            silentAutoPerClassMaxStepPct: {Y: null, C: null, F: null, Cargo: null}
        },
        {})

    assert.strictEqual(result.ok, true)
    const evt = emitted.find(e => e.type === "advisor:suggestion")
    assert.ok(evt, "advisor event emitted")
    assert.match(evt.payload.message, /Y 100 →/)
    assert.match(evt.payload.message, /C 210 →/)
    assert.match(evt.payload.message, /Cargo 75 →/)
    assert.strictEqual(evt.payload.action.label, "Apply price changes")
})

console.log("pass=" + pass + " fail=" + fail)
if (fail) process.exit(1)
