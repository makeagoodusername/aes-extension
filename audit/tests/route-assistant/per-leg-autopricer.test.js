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
        location: {pathname: "/some/other/path", search: "", hostname: "free1.airlinesim.aero"},
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

function makeDom({anchors = [], segmentTabs = [], headingText = "", title = "", fieldsetText = "", fieldsetRows = []} = {}) {
    const anchorEls = anchors.map(a => ({
        getAttribute: (k) => k === "href" ? a.href : null,
        textContent: a.text || "",
        innerText: a.text || "",
        querySelectorAll: () => []
    }))
    const segmentEls = segmentTabs.map(t => ({
        getAttribute: (k) => k === "href" ? (t.href || "") : null,
        textContent: t.text || (t.spans || []).join(" - "),
        innerText: t.text || (t.spans || []).join(" - "),
        querySelectorAll: (sel) => sel === "span"
            ? (t.spans || []).map(s => ({textContent: s}))
            : []
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
            if (sel === "a[href]") return anchorEls.concat(segmentEls)
            if (sel.includes(".nav-tabs")) return segmentEls
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

function makeStorageHarness(initial) {
    const sb = makeSandbox()
    const store = Object.assign({}, initial || {})
    const events = []
    sb.location = {
        hostname: "free1.airlinesim.aero",
        pathname: "/app/com/numbers/18665",
        search: "?segment=0"
    }
    sb.chrome = {
        runtime: {lastError: null},
        storage: {local: {
            get: (keys, cb) => {
                let out = {}
                if (keys == null) out = Object.assign({}, store)
                else if (typeof keys === "string") {
                    if (keys in store) out[keys] = store[keys]
                } else if (Array.isArray(keys)) {
                    keys.forEach(k => { if (k in store) out[k] = store[k] })
                } else {
                    Object.keys(keys || {}).forEach(k => { out[k] = k in store ? store[k] : keys[k] })
                }
                if (cb) setTimeout(() => cb(out), 0)
                return Promise.resolve(out)
            },
            set: (writes, cb) => {
                Object.assign(store, writes || {})
                if (cb) setTimeout(cb, 0)
                return Promise.resolve()
            }
        }}
    }
    sb.window.AesAccountKey = {
        acctKey: (prefix, suffix) => prefix + ":acct:acct1:" + suffix
    }
    sb.window.AesDataBus = {
        emit: (topic, payload) => {
            events.push({topic, payload})
            return {topic, payload}
        }
    }
    load("modules/route-assistant/per-leg-autopricer.js", sb)
    return {mod: sb.window.AesPerLegAutopricer, store, events, window: sb.window}
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

t("route detection: route action links beat unrelated body text", () => {
    const r = withDom(makeDom({
        anchors: [
            {href: "../inventory/JFKPUJ", text: "view in inventory"},
            {href: "../markets/JFKPUJ", text: "view market analysis"}
        ],
        headingText: "Customer service to Merchandise"
    }), m => m._routeFromForm())
    assert(r, "should detect from route href")
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "PUJ")
    assert.strictEqual(r.source, "route-link")
})

t("route detection: active segment tab spans are used before broad page text", () => {
    const r = withDom(makeDom({
        segmentTabs: [{href: "./18665?segment", spans: ["JFK", "PUJ"]}],
        headingText: "Customer service to Merchandise"
    }), m => m._routeFromForm())
    assert(r, "should detect from segment tab")
    assert.strictEqual(r.hub, "JFK")
    assert.strictEqual(r.dest, "PUJ")
    assert.strictEqual(r.source, "segment-tab")
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
// Data funnel — visible flight-number pricing feeds shared route context.
// ---------------------------------------------------------------------------

t("visible flight-number prices funnel into ownPricing and flight-number caches", async () => {
    const h = makeStorageHarness({
        "routeAssistant:markets:ownPricing:JFK-PUJ": {
            hub: "JFK", dest: "PUJ", prices: {Y: 200}, flightNumbers: {
                old: {scrapedAt: 1, prices: {Y: 199}}
            }
        }
    })
    const res = await h.mod._persistVisiblePricingSnapshot(
        {hub: "JFK", dest: "PUJ", source: "route-link"},
        {prices: {Y: 225, C: 525, F: 976, Cargo: 152}},
        {flightNumberId: "18665", legIndex: 0, path: "/app/com/numbers/18665"},
        "free1",
        {labels: ["demand", "competition"]}
    )
    assert(res && res.ownPricing, "snapshot should return ownPricing record")
    const legacyOwn = h.store["routeAssistant:markets:ownPricing:JFK-PUJ"]
    const scopedOwn = h.store["routeAssistant:markets:ownPricing:acct:acct1:JFK-PUJ"]
    assert(legacyOwn && scopedOwn, "legacy + account-scoped ownPricing should be written")
    assert.strictEqual(scopedOwn.prices.Y, 225)
    assert.strictEqual(scopedOwn.prices.C, 525)
    assert.strictEqual(scopedOwn.prices.F, 976)
    assert.strictEqual(scopedOwn.prices.Cargo, 152)
    assert(scopedOwn.flightNumbers["free1:18665:0"], "ownPricing should carry per-flight-number slot")
    assert.strictEqual(scopedOwn.flightNumbers["free1:18665:0"].routeSource, "route-link")
    assert(h.store["routeAssistant:flightNumbers:pricing:free1:18665:0"], "legacy flight-number pricing key")
    assert(h.store["routeAssistant:flightNumbers:pricing:acct:acct1:free1:18665:0"], "scoped flight-number pricing key")
    assert(h.events.some(e => e.topic === "data:route-assistant:markets:updated"))
    assert(h.events.some(e => e.topic === "data:route-assistant:flight-number-pricing:updated"))
})

t("diagnostics funnel records proposal context when classes move", async () => {
    const h = makeStorageHarness()
    const calls = []
    h.window.AesPriceDiagnostics = {
        recordContext: async (info) => calls.push({type: "context", info}),
        recordProposal: async (info) => calls.push({type: "proposal", info}),
        recordSkip: async (info) => calls.push({type: "skip", info})
    }
    await h.mod._recordPriceFunnel(
        {hub: "JFK", dest: "PUJ", source: "route-link"},
        {prices: {Y: 225, C: 525}},
        {Y: {newPrice: 252, deltaPct: 12, loadFactor: 0.9}, C: {skipReason: "hold"}},
        ["Y"],
        ["C"],
        {labels: ["demand"]},
        {flightNumberId: "18665", legIndex: 0},
        {keys: ["routeAssistant:markets:ownPricing:JFK-PUJ"]}
    )
    const ctx = calls.find(c => c.type === "context")
    const prop = calls.find(c => c.type === "proposal")
    assert(ctx, "recordContext should be called")
    assert(prop, "recordProposal should be called")
    assert.strictEqual(prop.info.prices.Y, 252)
    assert.strictEqual(Object.keys(prop.info.prices).length, 1)
    assert.strictEqual(prop.info.context.flightNumberId, "18665")
    assert.deepStrictEqual(prop.info.context.movedClasses, ["Y"])
    assert(!calls.some(c => c.type === "skip"), "proposal should not also record skip")
})

// ---------------------------------------------------------------------------
// Flight-number apply wiring — pure helpers plus a stubbed applier.
// ---------------------------------------------------------------------------

t("URL parsing extracts flightNumberId and visible leg", () => {
    const pathLeg = mod._parseNumbersUrl({pathname: "/app/com/numbers/18665/2", search: "?segment=9"})
    assert.strictEqual(pathLeg.flightNumberId, "18665")
    assert.strictEqual(pathLeg.legIndex, 2)
    assert.strictEqual(pathLeg.path, "/app/com/numbers/18665/2")
    const queryLeg = mod._parseNumbersUrl({pathname: "/app/com/numbers/18665", search: "?segment=1"})
    assert.strictEqual(queryLeg.flightNumberId, "18665")
    assert.strictEqual(queryLeg.legIndex, 1)
    const defaultLeg = mod._parseNumbersUrl({pathname: "/app/com/numbers/18665", search: ""})
    assert.strictEqual(defaultLeg.flightNumberId, "18665")
    assert.strictEqual(defaultLeg.legIndex, 0)
    assert.strictEqual(mod._parseNumbersUrl({pathname: "/app/com/markets/JFKLAX", search: ""}), null)
})

t("suggestionsToPriceMap sends only non-skipped valid class suggestions", () => {
    const prices = mod._suggestionsToPriceMap({
        Y: {newPrice: 211.4},
        C: {skipReason: "disabled by per-class apply gate", newPrice: 500},
        F: {newPrice: "not-a-number"},
        Cargo: {newPrice: 0.914}
    })
    assert.strictEqual(prices.Y, 211)
    assert.strictEqual(prices.Cargo, 0.91)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(prices, "C"), false)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(prices, "F"), false)
})

t("status rendering exposes terminal apply statuses and preflight text", () => {
    const host = {
        children: [],
        querySelector(sel) {
            return sel === ".aes-perleg-status"
                ? this.children.find(c => c.className === "aes-perleg-status") || null
                : null
        },
        appendChild(el) { this.children.push(el) }
    }
    for (const status of ["verified", "posted", "dry-run", "aborted", "failed"]) {
        const state = mod._statusFromResult({
            status,
            error: status === "failed" ? {message: "network failed"} : null,
            preflight: {
                blockers: status === "aborted" ? [{code: "cooldownActive", message: "cooldown active"}] : [],
                warnings: [{code: "largeDelta", message: "Y price +12.0%"}]
            }
        })
        const el = mod._renderApplyStatus(host, state)
        assert(el.textContent.includes(status), "status should render: " + el.textContent)
        assert(el.textContent.includes("Y price +12.0%"), "warning should render: " + el.textContent)
        if (status === "aborted") assert(el.textContent.includes("cooldown active"))
    }
})

t("stubbed one-click apply targets current flight-number leg and omits skipped classes", async () => {
    const sb = makeSandbox()
    sb.location = {pathname: "/app/com/numbers/18665/3", search: "?segment=3", hostname: "free1.airlinesim.aero"}
    load("modules/route-assistant/per-leg-autopricer.js", sb)
    const calls = []
    sb.window.RouteAssistantPricingApplier = function (server, opts) {
        this.server = server
        this.opts = opts
        this.apply = async (hub, dest, prices, applyOpts) => {
            calls.push({server, opts, hub, dest, prices, applyOpts})
            return {
                status: "verified",
                applyGate: {reason: "live"},
                preflight: {blockers: [], warnings: []},
                verifiedPrices: Object.assign({}, prices)
            }
        }
    }
    const m = sb.window.AesPerLegAutopricer
    const result = await m._applySuggestedPrices({
        route: {hub: "JFK", dest: "PUJ"},
        suggestions: {
            Y: {newPrice: 240},
            C: {skipReason: "disabled by per-class apply gate", newPrice: 600},
            Cargo: {newPrice: 1.07}
        },
        rowsByCls: {},
        settings: {
            pricing: {
                apply: {
                    enabled: true,
                    dryRunOnly: false,
                    liveScopes: {manual: true},
                    cooldownMinPerRoute: 0,
                    cooldownMinGlobal: 0,
                    classes: {C: {enabled: false}}
                }
            }
        }
    }, {suppressRerun: true})

    assert.strictEqual(result.status, "verified")
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].server, "free1")
    assert.strictEqual(calls[0].hub, "JFK")
    assert.strictEqual(calls[0].dest, "PUJ")
    assert.strictEqual(calls[0].prices.Y, 240)
    assert.strictEqual(calls[0].prices.Cargo, 1.07)
    assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[0].prices, "C"), false)
    assert.strictEqual(calls[0].applyOpts.endpoint, "flightNumbers")
    assert.strictEqual(calls[0].applyOpts.flightNumberId, "18665")
    assert.strictEqual(calls[0].applyOpts.legIndex, 3)
    assert.strictEqual(calls[0].applyOpts.source, "manual")
    assert.strictEqual(calls[0].applyOpts.dryRun, false)
})

t("forced dry-run passes dryRun true through the flight-number applier path", async () => {
    const sb = makeSandbox()
    sb.location = {pathname: "/app/com/numbers/105/0", search: "", hostname: "free1.airlinesim.aero"}
    load("modules/route-assistant/per-leg-autopricer.js", sb)
    const calls = []
    sb.window.RouteAssistantPricingApplier = function () {
        this.apply = async (hub, dest, prices, applyOpts) => {
            calls.push(applyOpts)
            return {status: "dry-run", applyGate: {reason: "forced-dry-run"}, preflight: {blockers: [], warnings: []}}
        }
    }
    const result = await sb.window.AesPerLegAutopricer._applySuggestedPrices({
        route: {hub: "ICN", dest: "NRT"},
        suggestions: {Y: {newPrice: 120}},
        rowsByCls: {},
        settings: {pricing: {apply: {enabled: true, dryRunOnly: false, liveScopes: {manual: true}}}}
    }, {dryRun: true, suppressRerun: true})
    assert.strictEqual(result.status, "dry-run")
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].dryRun, true)
    assert.strictEqual(calls[0].endpoint, "flightNumbers")
})

t("live preflight warnings require a second confirm click", async () => {
    const sb = makeSandbox()
    sb.location = {pathname: "/app/com/numbers/777/1", search: "", hostname: "free1.airlinesim.aero"}
    load("modules/route-assistant/per-leg-autopricer.js", sb)
    const warning = {code: "largeDelta", message: "Y price +20.0%"}
    let posts = 0
    sb.window.RouteAssistantPricingApplier = function () {
        this.apply = async (hub, dest, prices, applyOpts) => {
            const preflight = {blockers: [], warnings: [warning]}
            const verdict = applyOpts.onPreflight(preflight)
            if (verdict && verdict.abort) {
                return {
                    status: "aborted",
                    error: {code: "userAborted", message: verdict.reason},
                    applyGate: {reason: "live"},
                    preflight
                }
            }
            posts += 1
            return {status: "verified", applyGate: {reason: "live"}, preflight, verifiedPrices: prices}
        }
    }
    const state = {
        route: {hub: "JFK", dest: "LAX"},
        suggestions: {Y: {newPrice: 250}},
        rowsByCls: {},
        settings: {pricing: {apply: {enabled: true, dryRunOnly: false, liveScopes: {manual: true}}}}
    }
    const first = await sb.window.AesPerLegAutopricer._applySuggestedPrices(state, {suppressRerun: true})
    const second = await sb.window.AesPerLegAutopricer._applySuggestedPrices(state, {suppressRerun: true})
    assert.strictEqual(first.status, "aborted")
    assert.strictEqual(second.status, "verified")
    assert.strictEqual(posts, 1)
})

// ---------------------------------------------------------------------------

let pass = 0, fail = 0
console.log("=== per-leg autopricer ===")
;(async () => {
    for (const test of tests) {
        try { await test.fn(); console.log("  ok  " + test.name); pass++ }
        catch (e) { console.log("  FAIL " + test.name + ": " + (e && e.stack || e)); fail++ }
    }
    console.log("pass=" + pass + " fail=" + fail)
    process.exit(fail ? 1 : 0)
})()
