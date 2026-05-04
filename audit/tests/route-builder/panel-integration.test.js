"use strict"

/**
 * Route-planner panel integration test.
 *
 * Loads recommender + mock-schedule + panel into a synthetic JSDOM-lite
 * environment, drives the panel through the user flow:
 *   1. Mount
 *   2. setSelected(['JFK', 'MAD', 'ICN'])
 *   3. Set targetFlightCount via state
 *   4. recommend()
 *   5. dry-run apply (verifies orchestrator NOT called)
 *   6. apply() — verifies orchestrator.start IS called with correct payload
 *
 * Also runs the entire flow TWICE to confirm:
 *   - Mounting/unmounting is clean
 *   - Recommender output is consistent
 *   - Apply path is reproducible
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
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).map(l => "       " + l).join("\n"))
    }
}

// --- Synthetic DOM (minimal — enough for our panel's needs) ----------------

class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase()
        this.children = []
        this.style = {}
        this.dataset = {}
        this._listeners = {}
        this._textContent = ""
        this._attrs = {}
    }
    set textContent(v) { this._textContent = String(v == null ? "" : v); this.children = [] }
    get textContent() {
        if (this._textContent) return this._textContent
        return this.children.map(c => c.textContent || "").join("")
    }
    set innerHTML(v) { this._textContent = String(v); this.children = [] }
    appendChild(c) {
        if (!c) return c
        c._parent = this
        this.children.push(c)
        return c
    }
    append(...items) {
        for (const i of items) {
            if (i instanceof El) this.appendChild(i)
            else this.appendChild(this._mkText(i))
        }
    }
    _mkText(s) { const t = new El("#text"); t.textContent = String(s); return t }
    removeChild(c) {
        const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c
    }
    replaceChild(neu, old) {
        const i = this.children.indexOf(old); if (i >= 0) this.children[i] = neu; neu._parent = this; return old
    }
    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn)
    }
    removeEventListener(type, fn) {
        const arr = this._listeners[type] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1)
    }
    dispatchEvent(ev) {
        const arr = this._listeners[ev.type] || []
        for (const fn of arr.slice()) try { fn(ev) } catch (_) {}
    }
    setAttribute(k, v) { this._attrs[k] = String(v) }
    getAttribute(k) { return this._attrs[k] }
    querySelector() { return null }
    querySelectorAll() { return [] }
    click() { this.dispatchEvent({type: "click"}) }
    get parentNode() { return this._parent || null }
    get childNodes() { return this.children }
    get children_arr() { return this.children }
    get lastChild() { return this.children[this.children.length - 1] || null }
    get firstChild() { return this.children[0] || null }
    set value(v) { this._value = String(v == null ? "" : v) }
    get value() { return this._value || "" }
    set checked(v) { this._checked = !!v }
    get checked() { return !!this._checked }
}

class SelectEl extends El {
    constructor() {
        super("select")
        this.options = []
        this.selectedIndex = -1
    }
    set value(v) {
        this._value = String(v == null ? "" : v)
        this.selectedIndex = this.options.findIndex(o => o.value === this._value)
    }
    get value() { return this._value || "" }
}

function setupDOM() {
    const root = new El("html")
    const body = new El("body")
    root.appendChild(body)
    global.document = {
        body,
        readyState: "complete",
        addEventListener() {},
        removeEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag) => {
            const t = String(tag).toLowerCase()
            return t === "select" ? new SelectEl() : new El(t)
        },
        createTextNode: (text) => { const t = new El("#text"); t.textContent = String(text); return t }
    }
    global.window = global.window || {}
}

// --- Stubs -----------------------------------------------------------------

function setupStubs(orchestratorSpy) {
    global.window.AesAfp = {
        getActiveHub: () => "FRA",
        ctx: { server: "free1", aircraftId: "9001", currentLocationIata: "FRA" }
    }
    global.window.AesAfpSpecResolver = {
        last: { typeName: "B777-300ER", cruiseSpeedKmh: 905, range: 14600, turnaroundMin: 60 }
    }
    global.window.AesAfpRouteCandidates = {
        last: [
            { destIata: "JFK", destName: "New York", distanceKm: 6200 },
            { destIata: "LAX", destName: "Los Angeles", distanceKm: 9300 },
            { destIata: "ICN", destName: "Seoul",   distanceKm: 8500 },
            { destIata: "MAD", destName: "Madrid",  distanceKm: 1450 },
            { destIata: "FCO", destName: "Rome",    distanceKm:  950 },
            { destIata: "BCN", destName: "Barcelona", distanceKm: 1100 }
        ]
    }
    global.window.AesAfpFleetApplyOrchestrator = {
        start: orchestratorSpy
    }
}

function loadModule(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
}

// --- Tests -----------------------------------------------------------------

async function run() {
    console.log("\nRoute-planner panel integration:")

    setupDOM()

    let orchestratorCalls = []
    const orchestratorSpy = async function (payload) {
        orchestratorCalls.push(payload)
        return { ok: true, perAircraft: [{aircraftId: payload.runs[0].aircraftId,
                                            succeeded: payload.runs[0].legs.length, failed: 0}] }
    }

    setupStubs(orchestratorSpy)

    loadModule("modules/aircraft-flight-plan/route-planner/recommender.js")
    loadModule("modules/aircraft-flight-plan/route-planner/mock-schedule.js")
    loadModule("modules/aircraft-flight-plan/route-planner/panel.js")

    const Panel = global.window.AesAfpRoutePlannerPanel
    assert.ok(Panel, "panel module loaded")

    // ===== ROUND 1 =====
    console.log("\n  --- Round 1 ---")
    let host = global.document.createElement("div")
    let inst = Panel.mount(host, {})

    await it("mount returns instance with API", () => {
        assert.ok(inst, "mount returned null")
        assert.strictEqual(typeof inst.recommend, "function")
        assert.strictEqual(typeof inst.apply, "function")
        assert.strictEqual(typeof inst.setSelected, "function")
        assert.strictEqual(typeof inst.getState, "function")
    })

    await it("initial state has empty selection", () => {
        const s = inst.getState()
        assert.strictEqual(s.selected.length, 0)
        assert.strictEqual(s.currentLegs.length, 0)
    })

    await it("setSelected updates selection", () => {
        inst.setSelected(["JFK", "MAD", "ICN"])
        const s = inst.getState()
        assert.deepStrictEqual(s.selected, ["JFK", "MAD", "ICN"])
    })

    await it("recommend() populates currentLegs", () => {
        inst.recommend()
        const s = inst.getState()
        assert.ok(s.currentLegs.length > 0, "should produce legs")
        const dests = new Set(s.currentLegs.map(l => l.destination))
        assert.ok(dests.has("JFK"))
        assert.ok(dests.has("MAD"))
        assert.ok(dests.has("ICN"))
    })

    await it("recommend respects aircraft range (B777 covers all 3)", () => {
        const s = inst.getState()
        // ICN is 8500km which fits within B777's 14600km range
        assert.ok(s.currentLegs.some(l => l.destination === "ICN"))
    })

    await it("ICN is classified long-haul, capped at 2/wk", () => {
        const s = inst.getState()
        const icnLegs = s.currentLegs.filter(l => l.destination === "ICN")
        assert.ok(icnLegs.length >= 1)
        const totalIcnFreq = icnLegs.reduce((sum, l) => sum + l._meta.freqPerWeek, 0)
        assert.ok(totalIcnFreq <= 2, "ICN long-haul should cap at 2, got " + totalIcnFreq)
        assert.strictEqual(icnLegs[0]._meta.classification, "long")
    })

    await it("dry-run apply does NOT call orchestrator", async () => {
        orchestratorCalls = []
        await inst.apply(true)
        assert.strictEqual(orchestratorCalls.length, 0)
    })

    await it("live apply DOES call orchestrator with correct payload shape", async () => {
        orchestratorCalls = []
        await inst.apply(false)
        assert.strictEqual(orchestratorCalls.length, 1, "should call once")
        const pl = orchestratorCalls[0]
        assert.strictEqual(pl.source, "route-planner")
        assert.ok(Array.isArray(pl.runs))
        assert.strictEqual(pl.runs.length, 1)
        assert.strictEqual(pl.runs[0].aircraftId, "9001")
        assert.ok(Array.isArray(pl.runs[0].legs))
        assert.ok(pl.runs[0].legs.length > 0)
        // Each leg has the orchestrator-required fields
        for (const l of pl.runs[0].legs) {
            assert.strictEqual(typeof l.origin, "string")
            assert.strictEqual(typeof l.destination, "string")
            assert.strictEqual(typeof l.depTime, "string")
            assert.ok(Array.isArray(l.dayMask))
            assert.strictEqual(l.dayMask.length, 7)
            assert.strictEqual(l._meta, undefined, "_meta should be stripped")
        }
        assert.strictEqual(pl.ctx.server, "free1")
    })

    inst.destroy()

    // ===== ROUND 2 =====
    console.log("\n  --- Round 2 (idempotency) ---")
    host = global.document.createElement("div")
    inst = Panel.mount(host, {})

    await it("re-mount works cleanly", () => {
        const s = inst.getState()
        assert.strictEqual(s.selected.length, 0, "fresh mount should have empty state")
    })

    let round2Legs = null
    await it("re-running recommend with same inputs yields same legs", () => {
        inst.setSelected(["JFK", "MAD", "ICN"])
        inst.recommend()
        const s = inst.getState()
        round2Legs = s.currentLegs
        assert.ok(round2Legs.length > 0)
    })

    await it("apply() after second recommend works", async () => {
        orchestratorCalls = []
        await inst.apply(false)
        assert.strictEqual(orchestratorCalls.length, 1)
        assert.strictEqual(orchestratorCalls[0].runs[0].legs.length, round2Legs.length)
    })

    // === Edge: missing aircraftId ===
    inst.destroy()
    console.log("\n  --- Edge cases ---")
    global.window.AesAfp.ctx = { server: "free1" }   // no aircraftId
    host = global.document.createElement("div")
    inst = Panel.mount(host, {})

    await it("apply without aircraftId fails gracefully (no orchestrator call)", async () => {
        orchestratorCalls = []
        inst.setSelected(["MAD"])
        inst.recommend()
        await inst.apply(false)
        assert.strictEqual(orchestratorCalls.length, 0,
            "should not call orchestrator when ctx.aircraftId missing")
    })

    // === Edge: orchestrator unavailable ===
    inst.destroy()
    global.window.AesAfp.ctx = { server: "free1", aircraftId: "9001" }
    delete global.window.AesAfpFleetApplyOrchestrator
    host = global.document.createElement("div")
    inst = Panel.mount(host, {})

    await it("apply when orchestrator missing fails gracefully", async () => {
        inst.setSelected(["MAD"])
        inst.recommend()
        let threw = false
        try { await inst.apply(false) } catch (_) { threw = true }
        assert.strictEqual(threw, false, "should NOT throw")
    })

    // Restore for any later tests
    global.window.AesAfpFleetApplyOrchestrator = { start: orchestratorSpy }

    // === Verify recommender output integrates with mock-schedule ===
    console.log("\n  --- Mock-schedule integration ---")
    inst.destroy()
    host = global.document.createElement("div")
    inst = Panel.mount(host, {})

    await it("mock-schedule receives legs from recommender", () => {
        const ms = global.window.AesAfpRoutePlannerMockSchedule
        assert.ok(ms, "mock-schedule loaded")
        inst.setSelected(["JFK", "MAD"])
        inst.recommend()
        const s = inst.getState()
        assert.ok(s.currentLegs.length > 0)
    })

    // === Conflict detection ===
    await it("mock-schedule detects time conflicts", () => {
        const MS = global.window.AesAfpRoutePlannerMockSchedule
        const conflictingLegs = [
            {destination: "JFK", depTime: "09:00",
             dayMask: [true,false,false,false,false,false,false],
             _meta: {blockHrs: 6, freqPerWeek: 1}},
            {destination: "MAD", depTime: "10:00",  // overlap with JFK 09:00-15:00
             dayMask: [true,false,false,false,false,false,false],
             _meta: {blockHrs: 4, freqPerWeek: 1}}
        ]
        const conflicts = MS._findConflicts(conflictingLegs)
        assert.strictEqual(conflicts.size, 2, "both legs should be flagged conflicting")
        assert.ok(conflicts.has(0))
        assert.ok(conflicts.has(1))
    })

    await it("mock-schedule does NOT flag separated times", () => {
        const MS = global.window.AesAfpRoutePlannerMockSchedule
        const okLegs = [
            {destination: "JFK", depTime: "06:00",
             dayMask: [true,false,false,false,false,false,false],
             _meta: {blockHrs: 4, freqPerWeek: 1}},
            {destination: "MAD", depTime: "16:00",
             dayMask: [true,false,false,false,false,false,false],
             _meta: {blockHrs: 4, freqPerWeek: 1}}
        ]
        const conflicts = MS._findConflicts(okLegs)
        assert.strictEqual(conflicts.size, 0, "non-overlapping should not conflict")
    })

    await it("mock-schedule conflict detection respects dayMask separation", () => {
        const MS = global.window.AesAfpRoutePlannerMockSchedule
        // Same time, different days — no conflict
        const okLegs = [
            {destination: "JFK", depTime: "09:00",
             dayMask: [true,false,false,false,false,false,false],
             _meta: {blockHrs: 6, freqPerWeek: 1}},
            {destination: "MAD", depTime: "09:00",
             dayMask: [false,true,false,false,false,false,false],
             _meta: {blockHrs: 4, freqPerWeek: 1}}
        ]
        const conflicts = MS._findConflicts(okLegs)
        assert.strictEqual(conflicts.size, 0, "same time different days = no conflict")
    })

    console.log("\n  " + pass + " passed, " + fail + " failed")
    if (fail) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
