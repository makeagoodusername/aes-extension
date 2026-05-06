"use strict"

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
        if (selector === "span") return this.children.find(c => c.kind === "span") || null
        if (selector === "div") return this.children.find(c => c.kind === "div") || null
        if (selector === "input[type='text']") return this.children.find(c => c.kind === "priceInput") || null
        if (selector.indexOf("aircraftsType") >= 0) return null
        if (selector.indexOf("flight?id=") >= 0) return null
        return null
    }

    querySelectorAll(selector) {
        if (selector === "tbody tr") return this.children.filter(c => c.kind === "row")
        if (selector === "td") return this.children.filter(c => c.kind === "td")
        if (selector === "fieldset") return this.children.filter(c => c.kind === "fieldset")
        if (selector === "table tbody tr") return this.children.filter(c => c.kind === "row")
        return []
    }

    getElementsByTagName(tag) {
        if (tag === "span") return this.children.filter(c => c.kind === "span")
        if (tag === "a") return this.children.filter(c => c.kind === "a")
        if (tag === "input") return this.children.filter(c => c.kind === "priceInput" || c.kind === "input")
        if (tag === "div") return this.children.filter(c => c.kind === "div")
        if (tag === "table") return this.children.filter(c => c.kind === "table")
        if (tag === "tbody") return this.children.filter(c => c.kind === "tbody")
        return []
    }
}

class FakeDocument {
    constructor() {
        this.inventoryTable = makeCompetitorTable()
        this.pricingFieldset = makePricingFieldset()
    }

    querySelector(selector) {
        if (selector === "#inventory-table") return this.inventoryTable
        return null
    }

    querySelectorAll(selector) {
        if (selector === "fieldset") return [this.pricingFieldset]
        if (selector === "script") {
            return [new FakeElement("script", {}, [], [
                "slider({value: 100, min: 1, max: 200});",
                "slider({value: 250, min: 1, max: 500});",
                "slider({value: 400, min: 1, max: 800});",
                "slider({value: 0.85, min: 0, max: 2});"
            ].join(""))]
        }
        return []
    }

    getElementById(id) {
        if (id === "inventory-table") return this.inventoryTable
        return null
    }

    getElementsByTagName(tag) {
        if (tag === "script") {
            return [new FakeElement("script", {}, [], [
                "slider({value: 100, min: 1, max: 200});",
                "slider({value: 250, min: 1, max: 500});",
                "slider({value: 400, min: 1, max: 800});",
                "slider({value: 0.85, min: 0, max: 2});"
            ].join(""))]
        }
        if (tag === "fieldset") return [this.pricingFieldset]
        return []
    }

    getElementsByClassName(cls) {
        if (cls === "marketShareData") return []
        return []
    }
}

function makeCell(text, children) {
    return new FakeElement("td", {}, children || [], text)
}

function makeCompetitorRow(serviceClass, price) {
    return new FakeElement("row", {}, [
        makeCell("FN 100", [new FakeElement("span", {}, [], "FN 100")]),
        makeCell("2026-05-02", []),
        makeCell("08:00", []),
        makeCell("10:00", []),
        makeCell(serviceClass, []),
        makeCell("100", [new FakeElement("div", {}, [], "100")]),
        makeCell(String(price) + " AS$", []),
        makeCell("bookable", [new FakeElement("span", {}, [], "bookable")]),
        makeCell("", [])
    ])
}

function makeCompetitorTable() {
    const table = new FakeElement("table", {}, [])
    const tbody = new FakeElement("tbody", {}, [
        makeCompetitorRow("Cargo", "0.85"),
        makeCompetitorRow("Freight", "0.95"),
        makeCompetitorRow("Business", "220")
    ])
    tbody.children.forEach(tr => { tr.cells = tr.children })
    tbody.rows = tbody.children
    table.tBodies = [tbody]
    return table
}

function makePricingRow(cls, current, value, defaultValue) {
    return new FakeElement("row", {}, [
        makeCell(cls, []),
        makeCell(String(current), []),
        makeCell("", [new FakeElement("priceInput", {value: String(value)}, [], "")]),
        makeCell("", []),
        makeCell(String(defaultValue), [new FakeElement("span", {}, [], String(defaultValue))])
    ])
}

function makePricingFieldset() {
    const table = new FakeElement("table", {}, [])
    const tbody = new FakeElement("tbody", {}, [
        makePricingRow("Economy", "100", "100", "110"),
        makePricingRow("Business", "250", "250", "275"),
        makePricingRow("First", "400", "400", "440"),
        makePricingRow("Freight", "0.85", "0.85", "0.95")
    ])
    tbody.children.forEach(tr => { tr.cells = tr.children })
    tbody.rows = tbody.children
    table.tBodies = [tbody]

    return new FakeElement("fieldset", {}, [
        new FakeElement("legend", {}, [], "Pricing"),
        table
    ])
}

global.window = global
eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/markets-page-scraper.js"), "utf8"))

const Scraper = global.RouteAssistantMarketsPageScraper
const doc = new FakeDocument()

const competitors = Scraper._parseCompetitors(doc)
assert.strictEqual(competitors[0].serviceClass, "Cargo")
assert.strictEqual(competitors[0].price, 0.85)
assert.strictEqual(competitors[1].serviceClass, "Cargo")
assert.strictEqual(competitors[1].price, 0.95)
assert.strictEqual(competitors[2].serviceClass, "C")
assert.strictEqual(competitors[2].price, 220)

const own = Scraper._parseOwnPricing(doc)
assert.deepStrictEqual(own.prices, {Y: 100, C: 250, F: 400, Cargo: 0.85})
assert.deepStrictEqual(own.defaults, {Y: 110, C: 275, F: 440, Cargo: 0.95})
assert.deepStrictEqual(own.sliderRanges, {Y: [1, 200], C: [1, 500], F: [1, 800], Cargo: [0, 2]})

console.log("markets-page-scraper tests passed")
