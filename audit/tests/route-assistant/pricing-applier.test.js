"use strict"

/**
 * Regression smoke for modules/route-assistant/pricing-applier.js.
 *
 * Locks down the pure Wicket-form surfaces that make pricing automation safe:
 * per-form observed field names, body construction, cooldown preflight, and
 * endpoint-aware apply fingerprints.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

class FakeElement {
    constructor(kind, attrs, children, text) {
        this.kind = kind
        this.attrs = attrs || {}
        this.children = children || []
        this.textContent = text || ""
        this.selectedIndex = 0
        this.options = []
    }

    getAttribute(name) {
        return this.attrs[name] == null ? null : this.attrs[name]
    }

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

class FakeDocument {
    constructor(spec) {
        this.spec = spec
        this.body = new FakeElement("body")
        this.form = makeForm(spec)
    }

    getElementById(id) {
        if (id !== "wicket-ajax-base-url") return null
        return new FakeElement("script", {}, [], "Wicket.Ajax.baseUrl = \"app/com/markets/ICNNRT?" + this.spec.session + "\";")
    }

    querySelectorAll(selector) {
        if (selector === "form[method='post']") return [this.form]
        if (selector === "script") {
            return [new FakeElement("script", {}, [], this.spec.sliderScript || "")]
        }
        return []
    }
}

function makeForm(spec) {
    const children = [
        new FakeElement("submit"),
        new FakeElement("hidden", {name: "csrf", value: spec.hidden || "tok"}),
        makePricingFieldset(spec),
        makeGeneralFieldset(spec)
    ]
    return new FakeElement("form", {
        method: "post",
        id: spec.formId || "form-pricing",
        action: "https://free1.airlinesim.aero/app/com/markets/ICNNRT?" + spec.action
    }, children)
}

function makePricingFieldset(spec) {
    const rows = (spec.rows || []).map(row => {
        return new FakeElement("row", {}, [
            new FakeElement("td", {}, [], row.cls),
            new FakeElement("td", {}, [], String(row.current)),
            new FakeElement("td", {}, [
                new FakeElement("priceInput", {name: row.name, value: String(row.value)})
            ]),
            new FakeElement("td", {}, [], ""),
            new FakeElement("td", {}, [
                new FakeElement("span", {}, [], String(row.defaultValue))
            ], String(row.defaultValue))
        ])
    })
    return new FakeElement("fieldset", {}, [
        new FakeElement("legend", {}, [], "Pricing"),
        ...rows
    ])
}

function makeGeneralFieldset(spec) {
    const selected = new FakeElement("option", {value: spec.serviceProfile || "42"})
    const select = new FakeElement("select", {name: "serviceProfile-group:serviceProfile-group_body:serviceProfile"})
    select.options = [selected]
    return new FakeElement("fieldset", {}, [
        new FakeElement("legend", {}, [], "General Settings"),
        select
    ])
}

const FORMS = {
    A: {
        session: "123",
        action: "123-1.-pair-pair~panel-settings-settings~form",
        sliderScript: "slider({value: 100, min: 10, max: 300});slider({value: 50, min: 5, max: 200});",
        rows: [
            {cls: "Y", current: 100, value: 100, defaultValue: 120, name: "classes:prices:0:newPrice"},
            {cls: "C", current: 50, value: 50, defaultValue: 60, name: "classes:prices:1:newPrice"}
        ]
    },
    B: {
        session: "456",
        action: "456-2.-pair-pair~panel-settings-settings~form",
        serviceProfile: "99",
        sliderScript: "slider({value: 210, min: 20, max: 500});",
        rows: [
            {cls: "Y", current: 210, value: 210, defaultValue: 230, name: "wicket:custom:y"}
        ]
    },
    C: {
        session: "789",
        action: "789-3.-pair-pair~panel-settings-settings~form",
        serviceProfile: "77",
        sliderScript: [
            "slider({value: 100, min: 1, max: 200});",
            "slider({value: 250, min: 1, max: 500});",
            "slider({value: 400, min: 1, max: 800});",
            "slider({value: 0.85, min: 0.01, max: 1.80});"
        ].join(""),
        rows: [
            {cls: "Economy", current: 100, value: 100, defaultValue: 110, name: "classes:prices:0:newPrice"},
            {cls: "Business", current: 250, value: 250, defaultValue: 275, name: "classes:prices:1:newPrice"},
            {cls: "First", current: 400, value: 400, defaultValue: 440, name: "classes:prices:2:newPrice"},
            {cls: "Cargo", current: "0.85", value: "0.85", defaultValue: "1.10", name: "classes:prices:3:newPrice"}
        ]
    }
}

global.window = global
global.DOMParser = class {
    parseFromString(html) {
        const text = String(html)
        const spec = text.indexOf("FORM_C") >= 0 ? FORMS.C
            : text.indexOf("FORM_B") >= 0 ? FORMS.B : FORMS.A
        return new FakeDocument(spec)
    }
}

const src = fs.readFileSync(path.join(ROOT, "modules/route-assistant/pricing-applier.js"), "utf8")
eval(src)

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
    }
}

console.log("=== pricing-applier ===")

it("normalises route pair variants before building market URLs", () => {
    const Applier = global.RouteAssistantPricingApplier
    const url = "https://free1.airlinesim.aero/app/com/markets/JFKLHR"

    assert.strictEqual(Applier._markUrl("free1", "JFK", "LHR"), url)
    assert.strictEqual(Applier._markUrl("free1", "JFK-LHR", ""), url)
    assert.strictEqual(Applier._markUrl("free1", "JFK", "-LHR"), url)
    assert.strictEqual(Applier._endpointUrl("free1", {hub: "JFK-LHR"}), url)
})

it("keeps observed Wicket field names scoped to the parsed form", () => {
    const Applier = global.RouteAssistantPricingApplier
    const first = Applier.parseFormContext("FORM_A")
    const second = Applier.parseFormContext("FORM_B")

    assert.deepStrictEqual(first.observedFieldNames, {
        Y: "classes:prices:0:newPrice",
        C: "classes:prices:1:newPrice"
    })
    assert.deepStrictEqual(second.observedFieldNames, {Y: "wicket:custom:y"})
    assert.strictEqual(second.observedFieldNames.C, undefined)
})

it("buildBody uses this form's field names and preserves settings/scope", () => {
    const Applier = global.RouteAssistantPricingApplier
    const ctx = Applier.parseFormContext("FORM_B")
    const body = Applier.buildBody({
        formContext: ctx,
        prices: {Y: 220},
        scope: {airportPair: true, flightNumbers: false},
        submitButton: "submit-prices"
    })

    assert.strictEqual(body.get("wicket:custom:y"), "220")
    assert.strictEqual(body.get("classes:prices:0:newPrice"), null)
    assert.strictEqual(body.get("classes:prices:1:newPrice"), null)
    assert.strictEqual(body.get("csrf"), "tok")
    assert.strictEqual(body.get("settings:airportPair"), "on")
    assert.strictEqual(body.get("settings:flightNumbers"), null)
    assert.strictEqual(body.get("submit-prices"), "")
    assert.strictEqual(body.get("serviceProfile-group:serviceProfile-group_body:serviceProfile"), "99")
})

it("normalises long AS class labels to Y/C/F/Cargo keys", () => {
    const Applier = global.RouteAssistantPricingApplier
    const ctx = Applier.parseFormContext("FORM_C")
    assert.deepStrictEqual(ctx.classOrder, ["Y", "C", "F", "Cargo"])
    assert.deepStrictEqual(ctx.classLabels, {
        Y: "Economy",
        C: "Business",
        F: "First"
    })
    assert.deepStrictEqual(ctx.currentPrices, {Y: 100, C: 250, F: 400, Cargo: 0.85})
    assert.deepStrictEqual(ctx.defaults, {Y: 110, C: 275, F: 440, Cargo: 1.1})
    assert.deepStrictEqual(ctx.sliderRanges, {Y: [1, 200], C: [1, 500], F: [1, 800], Cargo: [0.01, 1.8]})

    const body = Applier.buildBody({
        formContext: ctx,
        prices: {Y: 105, C: 260, F: 420, Cargo: 0.925},
        scope: {airportPair: true, flightNumbers: true},
        submitButton: "submit-prices"
    })
    assert.strictEqual(body.get("classes:prices:0:newPrice"), "105")
    assert.strictEqual(body.get("classes:prices:1:newPrice"), "260")
    assert.strictEqual(body.get("classes:prices:2:newPrice"), "420")
    assert.strictEqual(body.get("classes:prices:3:newPrice"), "0.93")
    assert.deepStrictEqual(Applier._extractPricesFromBody(body, ctx), {Y: 105, C: 260, F: 420, Cargo: 0.93})

    const preflight = Applier.preflight({formContext: ctx, prices: {Cargo: 0.91}, warnAboveDeltaPct: 5})
    assert.strictEqual(preflight.blockers.length, 0)
    assert.ok(Math.abs(preflight.deltas.Cargo - 0.06) < 1e-9)

    const fpA = Applier.fingerprint("icn", "nrt", {Cargo: 0.85}, {}, {endpoint: "markets"})
    const fpB = Applier.fingerprint("icn", "nrt", {Cargo: 0.91}, {}, {endpoint: "markets"})
    assert.notStrictEqual(fpA, fpB)
})

it("preflight cooldowns are deterministic with injected now", () => {
    const Applier = global.RouteAssistantPricingApplier
    const ctx = Applier.parseFormContext("FORM_A")
    const now = 1_000_000
    const preflight = Applier.preflight({
        formContext: ctx,
        prices: {Y: 130},
        warnAboveDeltaPct: 5,
        cooldownMinPerRoute: 10,
        lastApplyAt: now - 3 * 60000,
        cooldownMinGlobal: 5,
        lastApplyAtGlobal: now - 2 * 60000,
        now
    })

    assert.ok(preflight.warnings.some(w => w.code === "largeDelta" && w.cls === "Y"))
    assert.ok(preflight.blockers.some(b => b.code === "cooldownActive" && b.remainingMin === 7))
    assert.ok(preflight.blockers.some(b => b.code === "cooldownActiveGlobal" && b.remainingMin === 3))
})

it("preflight blocks non-numeric requested prices before a body can emit NaN", () => {
    const Applier = global.RouteAssistantPricingApplier
    const ctx = Applier.parseFormContext("FORM_A")
    const preflight = Applier.preflight({
        formContext: ctx,
        prices: {Y: "not-a-number"},
        warnAboveDeltaPct: 5
    })
    const body = Applier.buildBody({
        formContext: ctx,
        prices: {Y: "not-a-number"},
        scope: {airportPair: true}
    })

    assert.ok(preflight.blockers.some(b => b.code === "invalidPrice" && b.cls === "Y"))
    assert.strictEqual(body.get("classes:prices:0:newPrice"), null)
    assert.ok(body.toString().indexOf("NaN") < 0)
})

it("keeps sub-AS$ cargo decimals through body extraction, verify, and fingerprint", () => {
    const Applier = global.RouteAssistantPricingApplier
    const ctx = Applier.parseFormContext("FORM_C")
    const body = Applier.buildBody({
        formContext: ctx,
        prices: {Cargo: 0.925},
        scope: {airportPair: true}
    })
    const extracted = Applier._extractPricesFromBody(body, ctx)
    assert.strictEqual(body.get("classes:prices:3:newPrice"), "0.93")
    assert.strictEqual(extracted.Cargo, 0.93)
    assert.strictEqual(Applier._verifyMatches({Cargo: 0.93}, {Cargo: 0.93}), true)
    assert.strictEqual(Applier._verifyMatches({Cargo: 0.93}, {Cargo: 1}), false)
    assert.notStrictEqual(
        Applier.fingerprint("icn", "nrt", {Cargo: 0.85}, {}, {}),
        Applier.fingerprint("icn", "nrt", {Cargo: 0.95}, {}, {})
    )
})

it("fingerprint separates route-level and per-flight-number targets", () => {
    const Applier = global.RouteAssistantPricingApplier
    const scope = {airportPair: true, flightNumbers: true}
    const market = Applier.fingerprint("icn", "nrt", {Y: 120}, scope, {endpoint: "markets"})
    const flight = Applier.fingerprint("icn", "nrt", {Y: 120}, scope, {
        endpoint: "flightNumbers",
        flightNumberId: 1234,
        legIndex: 0
    })

    assert.notStrictEqual(market, flight)
    assert.ok(flight.indexOf("ep=fn") >= 0)
    assert.ok(flight.indexOf("fnId=1234") >= 0)
})

it("resolves active-write gates centrally before POST", () => {
    const Applier = global.RouteAssistantPricingApplier
    assert.strictEqual(Applier.resolveApplyGate(
        {enabled: true, dryRunOnly: false, liveScopes: {manual: true}},
        "manual"
    ).dryRun, false)
    assert.strictEqual(Applier.resolveApplyGate(
        {enabled: true, dryRunOnly: true, liveScopes: {manual: true}},
        "manual"
    ).reason, "dry-run-only")
    assert.strictEqual(Applier.resolveApplyGate(
        {enabled: false, dryRunOnly: false, liveScopes: {manual: true}},
        "manual"
    ).reason, "apply-disabled")
    assert.strictEqual(Applier.resolveApplyGate(
        {enabled: true, dryRunOnly: false, liveScopes: {manual: false}},
        "manual"
    ).reason, "scope-disabled:manual")
    assert.strictEqual(Applier.resolveApplyGate(
        {enabled: true, dryRunOnly: false, liveScopes: {manual: true}},
        "manual",
        {forceDryRun: true}
    ).reason, "forced-dry-run")
})

it("threads live scope permissions through applier instances", () => {
    const Applier = global.RouteAssistantPricingApplier
    const applier = new Applier("TEST", {
        dryRunOnly: false,
        applyEnabled: true,
        liveScopes: {manual: true, silentAuto: true}
    })
    const gate = Applier.resolveApplyGate({
        enabled: applier.applyEnabled,
        dryRunOnly: applier.dryRunOnly,
        liveScopes: applier.liveScopes
    }, Applier._scopeNameForSource("silent-auto"))

    assert.strictEqual(applier.dryRunOnly, false)
    assert.strictEqual(applier.liveScopes.silentAuto, true)
    assert.strictEqual(gate.dryRun, false)
    assert.strictEqual(gate.reason, "live")
})

console.log("pass=" + pass + " fail=" + fail)
if (fail) process.exit(1)
