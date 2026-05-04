"use strict"

/**
 * Regression smoke for modules/inventory/quick-price-applier.js.
 *
 * A verified dashboard Inventory quick-price write must update the shared
 * routeAssistant:markets:ownPricing cache so Route Assistant, dashboard
 * silent-auto, and market/inventory surfaces agree on the current fare.
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
        if (selector === "button[name='submit-prices']"
                || selector === "button[name='submit-prices'], input[name='submit-prices']") {
            return this.children.find(c => c.kind === "submit") || null
        }
        if (selector === "input[name='submit-prices']") return null
        if (selector === "input[type='text']" || selector === "input") {
            return this.children.find(c => c.kind === "priceInput") || null
        }
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
    constructor() {
        this.body = new FakeElement("body")
        this.form = makeInventoryForm()
    }

    getElementById(id) {
        if (id !== "wicket-ajax-base-url") return null
        return new FakeElement("script", {}, [], "Wicket.Ajax.baseUrl = \"app/com/inventory/ICNNRT?123\";")
    }

    querySelectorAll(selector) {
        if (selector === "form[method='post']") return [this.form]
        return []
    }
}

function makeInventoryForm() {
    const children = [
        new FakeElement("submit"),
        new FakeElement("hidden", {name: "csrf", value: "tok"}),
        makePricingFieldset(),
        makeGeneralFieldset()
    ]
    return new FakeElement("form", {
        method: "post",
        action: "https://free1.airlinesim.aero/app/com/inventory/ICNNRT?123-1.-pair-pair~panel-settings-settings~form"
    }, children)
}

function makePricingFieldset() {
    const rows = [
        {cls: "Cargo", current: "0.70",  value: "0.70",  name: "wicket:cargo"},
        {cls: "Economy", current: "100", value: "100", name: "wicket:economy"},
        {cls: "First", current: "500", value: "500", name: "wicket:first"},
        {cls: "Business", current: "220", value: "220", name: "wicket:business"}
    ].map(row => new FakeElement("row", {}, [
        new FakeElement("td", {}, [], row.cls),
        new FakeElement("td", {}, [], row.current),
        new FakeElement("td", {}, [
            new FakeElement("priceInput", {name: row.name, value: row.value})
        ])
    ]))
    return new FakeElement("fieldset", {}, [
        new FakeElement("legend", {}, [], "Pricing"),
        ...rows
    ])
}

function makeGeneralFieldset() {
    const selected = new FakeElement("option", {value: "svc-42"})
    const select = new FakeElement("select", {name: "serviceProfile-group:serviceProfile-group_body:serviceProfile"})
    select.options = [selected]
    return new FakeElement("fieldset", {}, [
        new FakeElement("legend", {}, [], "General Settings"),
        select
    ])
}

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys]
            const out = {}
            for (const k of list) if (store.has(k)) out[k] = store.get(k)
            return out
        },
        async set(items) {
            for (const k in items) store.set(k, items[k])
        },
        _store: store
    }
}

global.window = global
const events = []
global.AesAccountKey = {
    acctKey(prefix, pair) { return prefix + ":acct:acct-test:" + pair }
}
global.AesDataBus = {
    emit(topic, payload) { events.push({topic, payload}) }
}
global.chrome = {
    storage: {
        local: makeChromeStore({
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                server: "free1",
                scrapedAt: 1,
                source: "seed",
                prices: {Y: 100, C: 200}
            }
        })
    }
}
global.DOMParser = class {
    parseFromString() {
        return new FakeDocument()
    }
}

const src = fs.readFileSync(path.join(ROOT, "modules/inventory/quick-price-applier.js"), "utf8")
eval(src)

let pass = 0
let fail = 0
async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
    }
}

console.log("=== quick-price-applier ===")

;(async function () {
    await it("parses inventory prices by class label when Wicket fields are reordered/custom", async () => {
        const Applier = global.CentralInventoryQuickPriceApplier
        const ctx = Applier.parseFormContext("FORM")

        assert.deepStrictEqual(ctx.classOrder, ["Cargo", "Y", "F", "C"])
        assert.deepStrictEqual(ctx.currentPrices, {Cargo: 0.7, Y: 100, F: 500, C: 220})
        assert.deepStrictEqual(ctx.observedFieldNames, {
            Cargo: "wicket:cargo",
            Y: "wicket:economy",
            F: "wicket:first",
            C: "wicket:business"
        })

        const body = Applier.buildBody({
            formContext: ctx,
            classKey: "Cargo",
            newPrice: 0.84,
            scope: {airportPair: true, flightNumbers: false}
        })
        assert.strictEqual(body.get("wicket:cargo"), "0.84")
        assert.strictEqual(body.get("wicket:economy"), "100")
        assert.strictEqual(body.get("wicket:first"), "500")
        assert.strictEqual(body.get("wicket:business"), "220")
        assert.strictEqual(body.get("classes:prices:3:newPrice"), null)
        assert.strictEqual(body.get("settings:airportPair"), "on")
        assert.strictEqual(body.get("settings:flightNumbers"), null)
        assert.strictEqual(body.get("serviceProfile-group:serviceProfile-group_body:serviceProfile"), "svc-42")
    })

    await it("normalizes business C separately from Cargo", async () => {
        const Applier = global.CentralInventoryQuickPriceApplier
        assert.strictEqual(Applier.normalizeClassKey("C"), "C")
        assert.strictEqual(Applier.normalizeClassKey("Business"), "C")
        assert.strictEqual(Applier.normalizeClassKey("Cargo"), "Cargo")
        assert.strictEqual(Applier.normalizeClassKey("Freight"), "Cargo")
    })

    await it("syncs verified quick-price writes into legacy and account-scoped ownPricing caches", async () => {
        const applier = new global.CentralInventoryQuickPriceApplier({applyEnabled: true})
        await applier._syncVerifiedOwnPricingCache({
            server: "free1",
            hub: "ICN",
            dest: "NRT",
            classKey: "Y",
            verified: 123,
            formContext: {
                currentPrices: {Y: 100, C: 200, F: 300, Cargo: 0.72},
                generalSettings: {"serviceProfile": "42"}
            }
        })

        const legacyKey = "routeAssistant:markets:ownPricing:ICN-NRT"
        const scopedKey = "routeAssistant:markets:ownPricing:acct:acct-test:ICN-NRT"
        const legacy = global.chrome.storage.local._store.get(legacyKey)
        const scoped = global.chrome.storage.local._store.get(scopedKey)

        assert.ok(legacy, "legacy cache written")
        assert.ok(scoped, "account-scoped cache written")
        assert.deepStrictEqual(legacy.prices, {Y: 123, C: 200, F: 300, Cargo: 0.72})
        assert.deepStrictEqual(scoped.prices, {Y: 123, C: 200, F: 300, Cargo: 0.72})
        assert.strictEqual(scoped.source, "inventoryQuickPrice:verified")
        assert.strictEqual(scoped.server, "free1")
        assert.strictEqual(scoped.generalSettings.serviceProfile, "42")
        assert.ok(events.some(e => e.topic === "data:route-assistant:markets:updated"
            && e.payload.hub === "ICN"
            && e.payload.dest === "NRT"))
    })

    await it("builds a Cargo quick-price body while preserving Y/C/F prices", async () => {
        const body = global.CentralInventoryQuickPriceApplier.buildBody({
            formContext: {
                hiddenFields: {"hidden-token": "abc"},
                observedFieldNames: {
                    Y: "classes:prices:0:newPrice",
                    C: "classes:prices:1:newPrice",
                    F: "classes:prices:2:newPrice",
                    Cargo: "classes:prices:3:newPrice"
                },
                classOrder: ["Y", "C", "F", "Cargo"],
                currentPrices: {Y: 100, C: 200, F: 300, Cargo: 0.7},
                generalSettings: {"serviceProfile": "42"}
            },
            classKey: "Cargo",
            newPrice: 0.875,
            scope: {airportPair: true, flightNumbers: true}
        })

        assert.strictEqual(body.get("classes:prices:0:newPrice"), "100")
        assert.strictEqual(body.get("classes:prices:1:newPrice"), "200")
        assert.strictEqual(body.get("classes:prices:2:newPrice"), "300")
        assert.strictEqual(body.get("classes:prices:3:newPrice"), "0.88")
        assert.strictEqual(body.get("hidden-token"), "abc")
        assert.strictEqual(body.get("serviceProfile"), "42")
        assert.strictEqual(body.get("settings:airportPair"), "on")
        assert.strictEqual(body.get("settings:flightNumbers"), "on")
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})()
