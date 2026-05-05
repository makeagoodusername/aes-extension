"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName || "").toUpperCase()
        this.children = []
        this.parentNode = null
        this.dataset = {}
        this.style = {}
        this.attributes = {}
        this.className = ""
        this.value = ""
        this.disabled = false
        this.draggable = false
        this._text = ""
        this._html = ""
    }

    append() {
        for (const child of arguments) this.appendChild(child)
    }

    appendChild(child) {
        if (child == null) return child
        if (typeof child === "string") child = new FakeText(child)
        child.parentNode = this
        this.children.push(child)
        return child
    }

    insertBefore(child, before) {
        if (child == null) return child
        child.parentNode = this
        const idx = this.children.indexOf(before)
        if (idx < 0) this.children.push(child)
        else this.children.splice(idx, 0, child)
        return child
    }

    removeChild(child) {
        const idx = this.children.indexOf(child)
        if (idx >= 0) this.children.splice(idx, 1)
        child.parentNode = null
        return child
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value)
    }

    getAttribute(name) {
        return this.attributes[name] || null
    }

    addEventListener() {}

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null
    }

    querySelectorAll(selector) {
        const out = []
        const wantClass = selector && selector.charAt(0) === "."
        const want = wantClass ? selector.slice(1).toLowerCase() : String(selector || "").toUpperCase()
        const walk = (node) => {
            if (!(node instanceof FakeElement)) return
            if (wantClass) {
                const classes = String(node.className || "").toLowerCase().split(/\s+/)
                if (classes.indexOf(want) >= 0) out.push(node)
            } else if (node.tagName === want) {
                out.push(node)
            }
            for (const child of node.children) walk(child)
        }
        walk(this)
        return out
    }

    set textContent(value) {
        this._text = String(value == null ? "" : value)
        this.children = []
    }

    get textContent() {
        return this._text + this.children.map(child => child.textContent || "").join("")
    }

    set innerHTML(value) {
        this._html = String(value == null ? "" : value)
        this._text = this._html.replace(/<[^>]*>/g, "")
        this.children = []
    }

    get innerHTML() {
        return this._html || this.textContent
    }
}

class FakeText {
    constructor(text) {
        this.textContent = String(text || "")
        this.parentNode = null
    }
}

function makeChromeStub() {
    return {
        storage: {
            local: {async get() { return {} }, async set() {}, async remove() {}},
            onChanged: {addListener() {}, removeListener() {}}
        },
        runtime: {id: "test"}
    }
}

function loadRouteCandidates() {
    global.window = {}
    global.chrome = makeChromeStub()
    global.escapeHtml = (s) => String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
    global.document = {
        readyState: "complete",
        createElement: tag => new FakeElement(tag),
        createTextNode: text => new FakeText(text),
        addEventListener() {},
        querySelector() { return null },
        querySelectorAll() { return [] }
    }
    global.window.document = global.document
    global.window.AesAfp = {
        bus: {on() {}, emit() {}},
        slot() { return null },
        getActiveHub() { return "JFK" },
        ctx: {server: "free1", aircraftId: "22092", currentLocationIata: "JFK"}
    }
    global.AesAfp = global.window.AesAfp
    const src = fs.readFileSync(path.join(ROOT, "modules/aircraft-flight-plan/route-candidates.js"), "utf8")
    eval(src)
    return global.window.AesAfpRouteCandidates
}

function findTag(node, tagName) {
    const want = String(tagName).toUpperCase()
    if (node && node.tagName === want) return node
    for (const child of (node && node.children) || []) {
        const hit = findTag(child, want)
        if (hit) return hit
    }
    return null
}

const candidates = loadRouteCandidates()
const merged = candidates._mergeRouteRows(
    [{destIata: "LAX", weeklyFlights: 259, paxScore: 3, source: "flightsfrom"}],
    [{destIata: "LAX", paxScore: 10, liveWeeklyFlights: 14,
        liveDeparture: "06:00", source: "cached top routes"}]
)
assert.strictEqual(merged.length, 1, "merge keeps one row per destination")
assert.strictEqual(merged[0].weeklyFlights, 259, "real-world weekly frequency is preserved")
assert.strictEqual(merged[0].paxScore, 10, "Route Assistant demand outranks FlightsFrom fallback demand")
assert.strictEqual(merged[0].liveWeeklyFlights, 14, "in-game weekly frequency survives merge")

const host = new FakeElement("div")
candidates.render(host, [{
    originIata: "JFK",
    destIata: "LAX",
    destName: "Los Angeles",
    fits: "fit",
    distanceKm: 3971,
    blockMin: 305,
    paxScore: 10,
    cargoScore: 10,
    weeklyFlights: 259,
    liveWeeklyFlights: 14,
    liveDeparture: "06:00",
    liveDepartureMin: 360,
    liveDailyFlights: [2, 2, 2, 2, 2, 2, 2],
    liveAircraftType: "Boeing 737-700",
    airlineCount: 6,
    scoreBlend: 92,
    notes: []
}], {
    originIata: "JFK",
    settings: {
        aircraftFlightPlan: {
            candidateChips: {rangeFitOnly: false, hideAlreadyScheduled: false},
            defaultTopN: 10
        }
    }
})

const table = findTag(host, "table")
assert.ok(table, "candidate table rendered")
const headerCells = table.querySelectorAll("th")
const bodyCells = table.querySelectorAll("td")
assert.strictEqual(headerCells.length, bodyCells.length,
    "header/body column count should stay aligned")

const labels = headerCells.map(th => th.textContent.trim())
assert.ok(labels.includes("AS/w"), "AS weekly frequency column is visible")
assert.ok(labels.includes("AS dep"), "AS departure column is visible")

const footer = host.children[host.children.length - 1]
assert.ok(/AS live 1/.test(footer.textContent), "footer counts live AS schedule rows")

console.log("route-candidates-live-columns: passed")
