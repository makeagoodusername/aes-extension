"use strict"

/**
 * Smoke for modules/route-assistant/per-leg-autopricer.js — the inline
 * Y/C/F/Cargo suggester that mounts on /app/com/numbers/*.
 *
 * Verifies (no DOM beyond a hand-rolled jsdom shim where needed):
 *   - per-class math distinguishes Y/C/F/Cargo by elasticity, demand, LF
 *   - Cargo runs on its own elasticity branch (cargoElasticity), not paxElasticity
 *   - per-class apply gate (settings.pricing.apply.classes.<cls>.enabled=false) skips
 *   - competitor median pulls the suggested price toward it (50/50 blend)
 *   - load-factor noise floor: at LF_ANCHOR (0.65) with no other signal, no move
 *   - missing demand falls through to default elasticity, doesn't crash
 *   - Cargo cap from per-class apply gate beats global maxStepPct
 *   - rounding: integers for Y/C/F, decimals for sub-AS$10 cargo
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

function load(filename, sandbox) {
    const src = fs.readFileSync(path.resolve(__dirname, "../../..", filename), "utf8")
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox, {filename})
}

function makeSandbox() {
    return {
        window: {},
        chrome: undefined,
        console,
        document: {
            readyState: "complete",
            addEventListener: () => {},
            getElementById: () => null,
            createElement: () => ({textContent: "", appendChild: () => {}, style: {}}),
            head: {appendChild: () => {}},
            querySelectorAll: () => [],
            querySelector: () => null,
            title: ""
        },
        location: {pathname: "/some/other/path"},
        Event: function () {}
    }
}

const tests = []
function t(name, fn) { tests.push({name, fn}) }

const sandbox = makeSandbox()
load("modules/route-assistant/ors-price-index.js", sandbox)
load("modules/route-assistant/per-leg-autopricer.js", sandbox)
const mod = sandbox.window.AesPerLegAutopricer
assert(mod && typeof mod._computeOne === "function", "module loaded with _computeOne export")

// ---------------------------------------------------------------------------

t("Y class moves up when LF is high and elasticity is mild", () => {
    const r = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.85}, null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 20})
    assert(!r.skipReason, "should not skip: " + (r.skipReason || ""))
    assert(r.deltaPct > 0, "should propose upward move, got " + r.deltaPct)
    assert(r.newPrice > 200, "newPrice should exceed current")
})

t("Y class moves down when LF is low (empty seats)", () => {
    const r = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.40}, null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 20})
    assert(!r.skipReason)
    assert(r.deltaPct < 0)
    assert(r.newPrice < 200)
})

t("LF anchor (0.65) with no competitor produces noise-floor skip", () => {
    const r = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.65}, null,
        {enabled: true}, {minDeltaPct: 3, maxStepPct: 10})
    assert(r.skipReason && /min/.test(r.skipReason),
        "expected min-delta skip, got " + JSON.stringify(r))
})

t("Cargo uses cargoElasticity, NOT paxElasticity", () => {
    // paxElasticity is steeply negative (would attenuate move heavily) but
    // cargoElasticity is mild — proposed Cargo move should clear the floor.
    const r = mod._computeOne("Cargo", 0.45,
        {paxElasticity: -3.0, cargoElasticity: -0.5, rmTightness: 0.85}, null,
        {enabled: true}, {minDeltaPct: 3, maxStepPct: 30})
    assert(!r.skipReason, "Cargo should move on its own ε branch: " + (r.skipReason || ""))
    assert(r.elasticity === -0.5, "elasticity should reflect cargoElasticity, got " + r.elasticity)
    assert(r.newPrice > 0.45, "Cargo newPrice should exceed current at high LF")
})

t("Cargo rounds to 2 decimals when sub-AS$10 (small fares)", () => {
    const r = mod._computeOne("Cargo", 0.50,
        {cargoElasticity: -1, rmTightness: 0.80}, 0.60,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 50})
    assert(!r.skipReason)
    const cents = Math.round(r.newPrice * 100)
    assert(cents === Math.round(r.newPrice * 100), "should be 0.01-grained")
    assert(r.newPrice <= 0.60 && r.newPrice >= 0.50, "newPrice in [0.50, 0.60]")
})

t("Y rounds to integer", () => {
    const r = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.80}, 220,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 20})
    assert(!r.skipReason)
    assert(Number.isInteger(r.newPrice), "Y newPrice should be integer, got " + r.newPrice)
})

t("competitor median pulls move toward it (50/50 blend)", () => {
    const noComp = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.85}, null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    const lowComp = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.85}, 150,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    assert(!noComp.skipReason && !lowComp.skipReason)
    // High LF says "raise", competitor at 150 says "drop". Blend should
    // pull the move toward neutral or slightly negative.
    assert(lowComp.deltaPct < noComp.deltaPct, "competitor at 150 should drag delta below no-comp delta")
})

t("ORS indexed median can supply the competitor signal on the flight-number page", () => {
    const idx = mod._orsPriceIndex({
        hub: "JFK",
        dest: "LAX",
        byClass: {
            ECONOMY: {
                connections: [
                    {totalPrice: 200, legs: [{flightCode: "AES 1", isOurs: true}]},
                    {totalPrice: 260, legs: [{flightCode: "AA 1", isOurs: false}]},
                    {totalPrice: 280, legs: [{flightCode: "UA 1", isOurs: false}]}
                ]
            }
        }
    }, {Y: 200})
    const comp = mod._combinedCompetitorMedian("Y", null, idx)
    assert.strictEqual(comp, 270)
    const r = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.65}, comp,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    assert(!r.skipReason)
    assert(r.newPrice > 200, "ORS median should pull Y upward")
})

t("passenger ORS and weak yield history dampen upward per-leg moves", () => {
    const demand = {paxElasticity: -1, rmTightness: 0.85}
    const base = mod._computeOne("Y", 200, demand, 260,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    const controlled = mod._computeOne("Y", 200, demand, 260,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30}, {
            ors: {weak: true, severe: true, rankAny: 18, ratingGapToTop: 20},
            yieldHistory: {lossMaking: false, deteriorating: true}
        })
    assert(!base.skipReason && !controlled.skipReason)
    assert(controlled.deltaPct < base.deltaPct, "route signals should damp the increase")
    assert(controlled.routeSignalFactor < 1, "route signal factor should be applied")
    assert(controlled.routeSignalNotes.includes("poor ORS"))
    assert(controlled.routeSignalNotes.includes("weak yield history"))
})

t("weak ORS plus negative yield history can block passenger increases", () => {
    const r = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.85}, 260,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30}, {
            ors: {weak: true, rankAny: 10, ratingGapToTop: 8},
            yieldHistory: {lossMaking: true}
        })
    assert(r.skipReason && /blocked/.test(r.skipReason),
        "expected ORS/yield block, got " + JSON.stringify(r))
})

t("Cargo ignores passenger ORS but keeps cargo demand math", () => {
    const demand = {cargoElasticity: -1, rmTightness: 0.95}
    const base = mod._computeOne("Cargo", 0.80, demand, null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    const withPassengerOrs = mod._computeOne("Cargo", 0.80, demand, null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30}, {
            ors: {weak: true, severe: true, rankAny: 20, ratingGapToTop: 30}
        })
    assert(!base.skipReason && !withPassengerOrs.skipReason)
    assert.strictEqual(withPassengerOrs.deltaPct, base.deltaPct)
    assert.strictEqual(withPassengerOrs.routeSignalFactor, 1)
})

t("per-class apply gate disables a class entirely", () => {
    const r = mod._computeOne("Y", 200, {paxElasticity: -1, rmTightness: 0.85}, null,
        {enabled: false}, {minDeltaPct: 1, maxStepPct: 20})
    assert(r.skipReason && /disabled/.test(r.skipReason),
        "expected disabled skip, got " + JSON.stringify(r))
})

t("per-class gate cap overrides global maxStepPct", () => {
    const big = mod._computeOne("Cargo", 1.0,
        {cargoElasticity: -1, rmTightness: 0.95}, 5.0,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 100})
    const capped = mod._computeOne("Cargo", 1.0,
        {cargoElasticity: -1, rmTightness: 0.95}, 5.0,
        {enabled: true, cap: 5}, {minDeltaPct: 1, maxStepPct: 100})
    assert(!big.skipReason && !capped.skipReason)
    assert(big.deltaPct > capped.deltaPct)
    assert(capped.deltaPct <= 5 + 1e-9, "capped delta should not exceed gate cap")
})

t("missing demand falls back to default elasticity, no crash", () => {
    const r = mod._computeOne("Y", 200, null, 240,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    assert(!r.skipReason, "should still suggest a move from competitor signal alone")
    assert(r.elasticity === -1.2, "default elasticity should be -1.2")
})

t("demand pool below minimum skips the class", () => {
    // For C class default min is 10. Pool of 5 should skip.
    const r = mod._computeOne("C", 400,
        {paxElasticity: -1, rmTightness: 0.85, demandPoolByClass: {C: 5}}, null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 20})
    assert(r.skipReason && /demand pool/.test(r.skipReason),
        "expected thin-data skip, got " + JSON.stringify(r))
})

t("normaliseClassKey covers AS variants", () => {
    assert.strictEqual(mod._normaliseClassKey("Economy"), "Y")
    assert.strictEqual(mod._normaliseClassKey("Y"), "Y")
    assert.strictEqual(mod._normaliseClassKey("Business class"), "C")
    assert.strictEqual(mod._normaliseClassKey("First"), "F")
    assert.strictEqual(mod._normaliseClassKey("Cargo"), "Cargo")
    assert.strictEqual(mod._normaliseClassKey("Freight"), "Cargo")
    assert.strictEqual(mod._normaliseClassKey("Mail"), "Cargo")
    assert.strictEqual(mod._normaliseClassKey(""), null)
    assert.strictEqual(mod._normaliseClassKey("foo"), null)
})

t("ORS primary treats positive rating gap as strong and negative as weak", () => {
    const strong = mod._orsPrimary({byClass: {ECONOMY: {ratingGapToTop: 18}}})
    const weak = mod._orsPrimary({byClass: {ECONOMY: {ratingGapToTop: -18}}})
    const fallback = mod._orsPrimary({byClass: {ECONOMY: {ourTopRating: 60, topCompetitorRating: 76}}})

    assert.strictEqual(strong.strong, true)
    assert.strictEqual(strong.weak, false)
    assert.strictEqual(weak.severe, true)
    assert.strictEqual(fallback.ratingGapToTop, -16)
    assert.strictEqual(fallback.severe, true)
})

t("routeSignals backfills shared ORS from class summaries and includes Cargo", () => {
    const signals = mod._routeSignals({
        ors: {
            byClass: {
                BUSINESS: {rankAny: 18, ratingGapToTop: -15},
                CARGO: {rankAny: 4, ratingGapToTop: 3}
            }
        }
    }, null)
    assert.strictEqual(signals.ors.rankAny, 18)
    assert.strictEqual(signals.orsByClass.C.rankAny, 18)
    assert.strictEqual(signals.orsByClass.Cargo.rankAny, 4)
    assert(signals.labels.includes("ORS"))
})

t("routeSignals does not inherit passenger ORS into missing Cargo class", () => {
    const signals = mod._routeSignals({
        ors: {
            byClass: {
                ECONOMY: {rankAny: 1, ratingGapToTop: 4}
            }
        }
    }, null)
    assert.strictEqual(signals.ors.rankAny, 1)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(signals.orsByClass, "Cargo"), false)
})

t("routeSignals reads embedded ORS pricing index when the index module is absent", () => {
    const signals = mod._routeSignals({
        ors: {
            pricingIndex: {
                competitorPricesByClass: {Y: 250},
                competitorCountsByClass: {Y: 2},
                classes: {Y: {competitorMedianPrice: 250, competitorCount: 2}}
            }
        }
    }, null, {Y: 200})
    assert.strictEqual(signals.orsPriceIndex.competitorPricesByClass.Y, 250)
    assert.strictEqual(signals.orsPriceIndex.competitorCountsByClass.Y, 2)
    assert.strictEqual(mod._combinedCompetitorMedian("Y", null, signals.orsPriceIndex), 250)
})

t("priceElasticityByClass overrides aggregate paxElasticity per class", () => {
    const r = mod._computeOne("F", 800,
        {paxElasticity: -3.0, priceElasticityByClass: {F: -0.5}, rmTightness: 0.85},
        null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    assert(!r.skipReason)
    assert(r.elasticity === -0.5, "F should pick its per-class elasticity, got " + r.elasticity)
})

t("loadSignal at LF=0.85 produces +16% raw signal (sanity)", () => {
    // (0.85 - 0.65) * 80 = 16
    assert(Math.abs(mod._loadSignal(0.85) - 16) < 1e-6)
})

t("elasticityScale at -1 returns 0.5 (sanity)", () => {
    assert.strictEqual(mod._elasticityScale(-1), 0.5)
})

t("Cargo demand pool below 1000 default skips", () => {
    const r = mod._computeOne("Cargo", 0.50,
        {cargoElasticity: -1, rmTightness: 0.85, cargoDemandPool: 500}, null,
        {enabled: true}, {minDeltaPct: 1, maxStepPct: 30})
    assert(r.skipReason && /demand pool/.test(r.skipReason))
})

// ---------------------------------------------------------------------------
// Route detection — exercises _routeFromForm with a hand-rolled DOM stub.
// ---------------------------------------------------------------------------

function makeDom({anchors = [], headingText = "", title = "", fieldsetText = "", fieldsetRows = []} = {}) {
    const anchorEls = anchors.map(a => ({
        getAttribute: (k) => k === "href" ? a.href : null,
        textContent: a.text || ""
    }))
    const heading = headingText ? {innerText: headingText, textContent: headingText} : null
    const fs = fieldsetText || fieldsetRows.length ? {
        innerText: fieldsetText,
        textContent: fieldsetText,
        querySelector: (sel) => sel === "legend" ? {textContent: "Pricing"} : null,
        querySelectorAll: (sel) => sel === "table tbody tr" ? fieldsetRows : []
    } : null
    return {
        readyState: "complete",
        addEventListener: () => {},
        getElementById: () => null,
        createElement: () => ({textContent: "", appendChild: () => {}, style: {}}),
        head: {appendChild: () => {}},
        title,
        querySelector: (sel) => {
            if (sel.startsWith("h1, h2, h3")) return heading
            if (sel === "fieldset legend") return null
            return null
        },
        querySelectorAll: (sel) => {
            if (sel.includes('a[href*="/app/info/airports/"]') || sel.includes('a[href*="/info/airports/"]')) return anchorEls
            if (sel === "fieldset") return fs ? [fs] : []
            return []
        }
    }
}

function withDom(dom, fn) {
    const sb = makeSandbox()
    sb.document = dom
    sb.location = {pathname: "/some/other/path"}
    load("modules/route-assistant/per-leg-autopricer.js", sb)
    return fn(sb.window.AesPerLegAutopricer)
}

t("route detection: airport-info anchors win when present", () => {
    const r = withDom(makeDom({
        anchors: [
            {href: "/app/info/airports/123/JFK", text: "John F Kennedy (JFK)"},
            {href: "/app/info/airports/456/LAX", text: "Los Angeles (LAX)"}
        ],
        headingText: "Some unrelated header"
    }), m => m._routeFromForm())
    assert(r, "should detect route")
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "LAX")
    assert.strictEqual(r.source, "anchor")
})

t("route detection: arrow heading 'JFK → LAX'", () => {
    const r = withDom(makeDom({
        anchors: [],
        headingText: "Flight 123: JFK → LAX",
        title: "Flight 123"
    }), m => m._routeFromForm())
    assert(r, "should detect from arrow")
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "LAX")
})

t("route detection: ascii arrow 'JFK -> LAX'", () => {
    const r = withDom(makeDom({headingText: "Route JFK -> LAX"}),
        m => m._routeFromForm())
    assert(r)
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "LAX")
})

t("route detection: 'JFK to LAX' phrasing", () => {
    const r = withDom(makeDom({headingText: "Flight from JFK to LAX"}),
        m => m._routeFromForm())
    assert(r)
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "LAX")
})

t("route detection: parenthesized IATA pairs", () => {
    const r = withDom(makeDom({headingText: "From New York (JFK) to Los Angeles (LAX)"}),
        m => m._routeFromForm())
    assert(r)
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "LAX")
})

t("route detection: returns null when nothing parseable", () => {
    const r = withDom(makeDom({headingText: "No route info here"}),
        m => m._routeFromForm())
    assert.strictEqual(r, null)
})

t("route detection: anchor href fallback when text lacks IATA", () => {
    const r = withDom(makeDom({
        anchors: [
            {href: "/app/info/airports/123/CDG", text: "Charles de Gaulle"},
            {href: "/app/info/airports/456/LHR", text: "Heathrow"}
        ]
    }), m => m._routeFromForm())
    assert(r, "anchor href should provide IATA when text doesn't")
    assert.strictEqual(r.hub, "CDG")
    assert.strictEqual(r.dest, "LHR")
})

t("route detection: dedupes repeated IATA in anchors", () => {
    const r = withDom(makeDom({
        anchors: [
            {href: "/app/info/airports/1/JFK", text: "JFK"},
            {href: "/app/info/airports/1/JFK", text: "JFK"},
            {href: "/app/info/airports/2/LAX", text: "LAX"}
        ]
    }), m => m._routeFromForm())
    assert(r)
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "LAX")
})

t("route detection: lowercase IATA in heading is uppercased", () => {
    const r = withDom(makeDom({headingText: "lhr → cdg evening"}),
        m => m._routeFromForm())
    assert(r)
    assert.strictEqual(r.hub, "LHR")
    assert.strictEqual(r.dest, "CDG")
})

// ---------------------------------------------------------------------------

let pass = 0, fail = 0
console.log("=== per-leg autopricer ===")
for (const test of tests) {
    try { test.fn(); console.log("  ok  " + test.name); pass++ }
    catch (e) { console.log("  FAIL " + test.name + ": " + (e && e.message || e)); fail++ }
}
console.log("pass=" + pass + " fail=" + fail)
process.exit(fail ? 1 : 0)
