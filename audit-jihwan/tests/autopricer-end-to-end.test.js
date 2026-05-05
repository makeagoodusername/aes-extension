"use strict"

/**
 * Autopricer end-to-end smoke — proposer ➜ applier body.
 *
 * Exercises the full per-class autopricer pipeline using only pure-function
 * surfaces (no Chrome, no fetch, no Wicket session). Goal: prove that when
 * the proposer says "raise Y/C/F/Cargo", the body the applier would POST
 * actually carries the bumped per-class price for every cabin — including
 * Cargo's sub-AS$ decimal — and that disabling a single cabin via
 * per-class apply gates suppresses just that cabin without dropping the rest.
 *
 * Pipeline under test:
 *   demand-derivator    →  per-class signals (paxElasticity / cargo*, pools, RM tightness)
 *   per-class proposer  →  prices map        (Y / C / F / Cargo)
 *   pricing-applier     →  POST body         (Wicket field names + values)
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

// -- Tiny DOM stub borrowed from pricing-applier.test.js, expanded so the
//    same parser handles a synthetic full Y/C/F/Cargo route form.
class FakeElement {
    constructor(kind, attrs, children, text) {
        this.kind = kind
        this.attrs = attrs || {}
        this.children = children || []
        this.textContent = text || ""
        this.selectedIndex = 0
        this.options = []
    }
    getAttribute(name) { return this.attrs[name] == null ? null : this.attrs[name] }
    querySelector(selector) {
        if (selector === "legend") return this.children.find(c => c.kind === "legend") || null
        if (selector === "button[name='submit-prices']") return this.children.find(c => c.kind === "submit") || null
        if (selector === "input[name='submit-prices']") return null
        if (selector === "input[type='text']") return this.children.find(c => c.kind === "priceInput") || null
        if (selector === "span") return this.children.find(c => c.kind === "span") || null
        return null
    }
    querySelectorAll(selector) {
        if (selector === "input[type='hidden']") return this.children.filter(c => c.kind === "hidden")
        if (selector === "fieldset") return this.children.filter(c => c.kind === "fieldset")
        if (selector === "table tbody tr") return this.children.filter(c => c.kind === "row")
        if (selector === "td") return this.children.filter(c => c.kind === "td")
        if (selector === "select") return this.children.filter(c => c.kind === "select")
        return []
    }
}

function makeRoute(rows) {
    const tdRows = rows.map(r => new FakeElement("row", {}, [
        new FakeElement("td", {}, [], r.cls),
        new FakeElement("td", {}, [], String(r.current)),
        new FakeElement("td", {}, [
            new FakeElement("priceInput", {name: r.name, value: String(r.current)})
        ]),
        new FakeElement("td", {}, [], ""),
        new FakeElement("td", {}, [new FakeElement("span", {}, [], String(r.def))], String(r.def))
    ]))
    const pricingFs = new FakeElement("fieldset", {}, [
        new FakeElement("legend", {}, [], "Pricing"),
        ...tdRows
    ])
    const opt = new FakeElement("option", {value: "42"})
    const sel = new FakeElement("select", {name: "serviceProfile-group:serviceProfile-group_body:serviceProfile"})
    sel.options = [opt]
    const generalFs = new FakeElement("fieldset", {}, [
        new FakeElement("legend", {}, [], "General Settings"),
        sel
    ])
    return new FakeElement("form", {
        method: "post",
        id: "form-pricing",
        action: "https://free1.airlinesim.aero/app/com/markets/JFKLAX?123-1.-pair-pair~panel-settings-settings~form"
    }, [
        new FakeElement("submit"),
        new FakeElement("hidden", {name: "csrf", value: "tok"}),
        pricingFs,
        generalFs
    ])
}

class FakeDocument {
    constructor() {
        this.form = makeRoute([
            {cls: "Y",     current: 100,  def: 100,  name: "classes:prices:0:newPrice"},
            {cls: "C",     current: 280,  def: 280,  name: "classes:prices:1:newPrice"},
            {cls: "F",     current: 520,  def: 520,  name: "classes:prices:2:newPrice"},
            {cls: "Cargo", current: 0.85, def: 0.85, name: "classes:prices:3:newPrice"}
        ])
    }
    getElementById(id) {
        if (id !== "wicket-ajax-base-url") return null
        return new FakeElement("script", {}, [], 'Wicket.Ajax.baseUrl = "app/com/markets/JFKLAX?123";')
    }
    querySelectorAll(selector) {
        if (selector === "form[method='post']") return [this.form]
        if (selector === "script") {
            const txt = "slider({value: 100, min: 50, max: 200});"
                      + "slider({value: 280, min: 100, max: 600});"
                      + "slider({value: 520, min: 200, max: 1200});"
                      + "slider({value: 0.85, min: 0.10, max: 2.50});"
            return [new FakeElement("script", {}, [], txt)]
        }
        return []
    }
}

global.window = global
global.DOMParser = class { parseFromString() { return new FakeDocument() } }

// Production modules under test
delete global.RouteAssistantDemandDerivator
delete global.RouteAssistantPerClassProposer
delete global.RouteAssistantSilentAutoProposers
delete global.RouteAssistantPricingApplier

eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/demand-derivator.js"), "utf8"))
eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposer-per-class.js"), "utf8"))
eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposers.js"), "utf8"))
eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/pricing-applier.js"), "utf8"))

const Derivator = global.RouteAssistantDemandDerivator
const Registry  = global.RouteAssistantSilentAutoProposers
const Applier   = global.RouteAssistantPricingApplier

// Synthetic historic record: each class has 12 weeks of (capacity, price)
// that drift inversely so the regression yields a non-degenerate elasticity.
function buildHistoric() {
    const periods = Array.from({length: 12}, (_, i) => "wk-" + (i + 1))
    function series(baseCap, basePrice, capJitter, priceJitter) {
        const capacities = []
        const prices = []
        for (let i = 0; i < 12; i++) {
            // Mild negative correlation: higher price → lower booked capacity.
            const p = basePrice + (i - 6) * priceJitter
            const c = baseCap   - (i - 6) * capJitter
            prices.push(p)
            capacities.push(c)
        }
        return {periods, capacities, prices}
    }
    return {
        scrapedAt: Date.now(),
        byPayload: {
            ECONOMY:  series(1200, 100, 4,  1),
            BUSINESS: series(120,  300, 1,  3),
            FIRST:    series(40,   600, 0.5, 6),
            CARGO:    series(8000, 0.85, 80, 0.005)
        }
    }
}

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)) }
}

console.log("=== autopricer-end-to-end ===")

// 1) Demand derivator should produce per-class signals for every cabin.
const derived = Derivator.derive(buildHistoric(), null, null, null, {window: 12})

it("derivator emits demand pool, avg price, and elasticity for each class", () => {
    for (const cls of ["Y", "C", "F", "Cargo"]) {
        assert.ok(derived.demandPoolByClass[cls] != null,  cls + " demandPool missing")
        assert.ok(derived.avgPriceByClass[cls] != null,    cls + " avgPrice missing")
        assert.ok(derived.priceElasticityByClass[cls] != null, cls + " elasticity missing")
        assert.ok(derived.priceElasticityByClass[cls] <= 0,    cls + " elasticity not negative")
    }
    assert.ok(derived.cargoDemandPool > 0, "cargo aggregate demand pool not derived")
})

// 2) Build a route record the proposer accepts: full per-class signals,
//    high RM tightness so load-pressure pushes prices up, no competitor
//    median (so the formulas use elasticity x load-signal alone).
const route = {
    hub:     "JFK",
    destIata:"LAX",
    paxScore: 8,
    cargoScore: 7,
    paxDemandPool:   derived.paxDemandPool,
    cargoDemandPool: derived.cargoDemandPool,
    paxElasticity:   derived.paxElasticity,
    cargoElasticity: derived.cargoElasticity,
    rmTightness:     0.92,
    demandPoolByClass:    derived.demandPoolByClass,
    priceElasticityByClass: derived.priceElasticityByClass,
    rmTightnessByClass:   {Y: 0.94, C: 0.88, F: 0.80, Cargo: 0.86}
}
const prices = {Y: 100, C: 280, F: 520, Cargo: 0.85}

const cfg = {
    silentAutoMinDeltaPct: 1,
    silentAutoMaxStepPct:  10,
    silentAutoPerClassEnabled:    {Y: true, C: true, F: true, Cargo: true},
    silentAutoPerClassMinDemandPool: {Y: 0, C: 0, F: 0, Cargo: 0}
}

const proposed = Registry.dispatch("per-class-elasticity", route, prices, cfg, {})

it("per-class proposer raises every cabin when LF + demand both lean up", () => {
    assert.ok(proposed.ok,                "proposer should succeed: " + (proposed.skipReason || ""))
    for (const cls of ["Y", "C", "F", "Cargo"]) {
        assert.ok(proposed.prices[cls] != null, cls + " missing from proposal")
        assert.ok(proposed.prices[cls] > prices[cls],
            cls + " did not increase: " + prices[cls] + " -> " + proposed.prices[cls])
    }
})

// 3) Independent class moves: at least one of C/F/Cargo deltas should NOT
//    match Y's delta (different elasticity per class via the regression).
it("each class moves on its own elasticity — not all bound to Y's delta", () => {
    function pct(cls) { return (proposed.prices[cls] - prices[cls]) / prices[cls] * 100 }
    const yDelta = pct("Y")
    let distinct = 0
    for (const cls of ["C", "F", "Cargo"]) {
        if (Math.abs(pct(cls) - yDelta) > 0.01) distinct++
    }
    assert.ok(distinct >= 1, "expected at least one of C/F/Cargo to differ from Y, all matched")
})

// 4) Disable one cabin via apply-class gates — proposer must drop just it.
const cfgGated = Object.assign({}, cfg, {
    applyClassGates: {C: {enabled: false}}
})
const gatedProp = Registry.dispatch("per-class-elasticity", route, prices, cfgGated, {})

it("applyClassGates.<cls>.enabled=false suppresses only that cabin", () => {
    assert.ok(gatedProp.ok, "gated proposal should still succeed for the other 3")
    assert.strictEqual(gatedProp.prices.C, undefined, "C should be dropped")
    assert.ok(gatedProp.prices.Y != null,     "Y should remain")
    assert.ok(gatedProp.prices.F != null,     "F should remain")
    assert.ok(gatedProp.prices.Cargo != null, "Cargo should remain")
})

// 5) Wire proposer output into the applier's pure body builder.
//    parseFormContext reads the synthetic form (4 cabins, Cargo decimal).
const ctx = Applier.parseFormContext("any html — DOMParser stub returns the synthetic form")

it("form context exposes all four cabins with the right field names", () => {
    assert.deepStrictEqual(ctx.classOrder, ["Y", "C", "F", "Cargo"])
    assert.strictEqual(ctx.observedFieldNames.Cargo, "classes:prices:3:newPrice")
    assert.deepStrictEqual(ctx.currentPrices, {Y: 100, C: 280, F: 520, Cargo: 0.85})
})

const preflight = Applier.preflight({
    formContext: ctx,
    prices: proposed.prices,
    warnAboveDeltaPct: 5
})

it("preflight finds no blockers for an in-band per-class raise", () => {
    assert.deepStrictEqual(preflight.blockers, [],
        "blockers: " + JSON.stringify(preflight.blockers))
    assert.ok(preflight.deltas.Y > 0, "preflight should report a positive Y delta")
})

const body = Applier.buildBody({
    formContext: ctx,
    prices: proposed.prices,
    scope: {airportPair: true, flightNumbers: true},
    submitButton: "submit-prices"
})

it("POST body carries the proposer's per-class prices, Cargo decimal-formatted", () => {
    const extracted = Applier._extractPricesFromBody(body, ctx)
    assert.strictEqual(extracted.Y, Math.round(proposed.prices.Y))
    assert.strictEqual(extracted.C, Math.round(proposed.prices.C))
    assert.strictEqual(extracted.F, Math.round(proposed.prices.F))
    const expectCargo = Math.round(proposed.prices.Cargo * 100) / 100
    assert.ok(Math.abs(extracted.Cargo - expectCargo) < 0.005,
        "Cargo body roundtrip lost precision: " + extracted.Cargo + " vs " + expectCargo)

    assert.strictEqual(body.get("classes:prices:0:newPrice"), String(Math.round(proposed.prices.Y)))
    assert.strictEqual(body.get("classes:prices:1:newPrice"), String(Math.round(proposed.prices.C)))
    assert.strictEqual(body.get("classes:prices:2:newPrice"), String(Math.round(proposed.prices.F)))
    assert.match(body.get("classes:prices:3:newPrice"), /^0\.\d+$/, "Cargo body should be sub-AS$ decimal")

    assert.strictEqual(body.get("settings:airportPair"),   "on")
    assert.strictEqual(body.get("settings:flightNumbers"), "on")
    assert.strictEqual(body.get("submit-prices"),          "")
})

// 6) When the gated proposer drops C, the applier body should leave C at the
//    cached current price (Wicket round-trip), not a NaN or empty.
const gatedBody = Applier.buildBody({
    formContext: ctx,
    prices: gatedProp.prices,
    scope: {airportPair: true, flightNumbers: true},
    submitButton: "submit-prices"
})

it("gated cabin round-trips its current price untouched in the body", () => {
    assert.strictEqual(gatedBody.get("classes:prices:1:newPrice"), "280",
        "C should round-trip current 280, got " + gatedBody.get("classes:prices:1:newPrice"))
    assert.notStrictEqual(gatedBody.get("classes:prices:0:newPrice"), "100",
        "Y should still be raised even when C is gated")
})

// 7) Headline numbers — show what the proposer actually decided so the
//    smoke output is human-readable, not just pass/fail.
console.log("\n  proposed prices (live values from a run):")
for (const cls of ["Y", "C", "F", "Cargo"]) {
    const cur = prices[cls]
    const next = proposed.prices[cls]
    if (next == null) {
        console.log("    " + cls.padEnd(5) + " " + String(cur).padStart(6) + "   skipped")
        continue
    }
    const dPct = ((next - cur) / cur * 100).toFixed(2)
    const e = derived.priceElasticityByClass[cls]
    const sign = (next - cur) > 0 ? "+" : ""
    console.log("    " + cls.padEnd(5) + " " + String(cur).padStart(6) + " -> " + String(next).padStart(6)
        + "   (" + sign + dPct + "%, elast " + (e == null ? "?" : e.toFixed(2)) + ")")
}

console.log(
    "\nautopricer-end-to-end: " + pass + " passed, " + fail + " failed\n"
)
process.exit(fail === 0 ? 0 : 1)
