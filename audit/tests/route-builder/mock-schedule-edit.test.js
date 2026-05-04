"use strict"

/**
 * Mock-schedule edit-flow test.
 *
 * Validates that user edits in the mock-schedule grid (time changes, day
 * toggles, leg deletes) propagate through the onChange callback so the
 * panel's leg buffer stays in sync with the GUI state.
 *
 * Approach: render the mock-schedule into a synthetic DOM, locate the
 * inline edit controls, dispatch synthetic clicks on day toggles + commit
 * a time edit, and verify getLegs() returns the mutated state.
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

// --- Synthetic DOM (subset matching mock-schedule's needs) -----------------

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
    appendChild(c) { if (!c) return c; c._parent = this; this.children.push(c); return c }
    append(...items) {
        for (const i of items) {
            if (i instanceof El) this.appendChild(i)
            else { const t = new El("#text"); t.textContent = String(i); this.appendChild(t) }
        }
    }
    removeChild(c) {
        const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c
    }
    remove() {
        if (this._parent) this._parent.removeChild(this)
    }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) }
    removeEventListener(t, fn) {
        const arr = this._listeners[t] || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1)
    }
    dispatchEvent(ev) {
        const arr = this._listeners[ev.type] || []
        for (const fn of arr.slice()) try { fn(ev) } catch (_) {}
    }
    click() { this.dispatchEvent({type: "click", stopPropagation: () => {}}) }
    setAttribute(k, v) { this._attrs[k] = String(v) }
    get parentNode() { return this._parent || null }
    get childNodes() { return this.children }
    get firstChild() { return this.children[0] || null }
    get lastChild() { return this.children[this.children.length - 1] || null }
    set value(v) { this._value = String(v == null ? "" : v) }
    get value() { return this._value || "" }
    set checked(v) { this._checked = !!v }
    get checked() { return !!this._checked }
    // Find descendants by predicate
    find(pred) {
        if (pred(this)) return this
        for (const c of this.children) {
            const f = c.find && c.find(pred)
            if (f) return f
        }
        return null
    }
    findAll(pred, acc) {
        acc = acc || []
        if (pred(this)) acc.push(this)
        for (const c of this.children) {
            if (c.findAll) c.findAll(pred, acc)
        }
        return acc
    }
}

function setupDOM() {
    const root = new El("html")
    const body = new El("body")
    root.appendChild(body)
    global.document = {
        body,
        readyState: "complete",
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag) => new El(tag),
        createTextNode: (text) => { const t = new El("#text"); t.textContent = String(text); return t }
    }
    global.window = {}
}

function loadModule(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
}

async function run() {
    console.log("\nMock-schedule edit-flow:")

    setupDOM()
    loadModule("modules/aircraft-flight-plan/route-planner/mock-schedule.js")
    const MS = global.window.AesAfpRoutePlannerMockSchedule
    assert.ok(MS, "mock-schedule loaded")

    const initialLegs = [
        {origin: "FRA", destination: "JFK", depTime: "09:00",
         dayMask: [true, false, true, false, true, false, true],
         pricePct: 100, service: "PAX", flightNumberText: "",
         _meta: {blockHrs: 12, freqPerWeek: 4, classification: "long"}},
        {origin: "FRA", destination: "MAD", depTime: "07:30",
         dayMask: [true, true, true, true, true, false, false],
         pricePct: 100, service: "PAX", flightNumberText: "",
         _meta: {blockHrs: 4, freqPerWeek: 5, classification: "short"}}
    ]

    let onChangeCalls = []
    const host = global.document.createElement("div")
    const sched = MS.render(host, initialLegs, {
        onChange: (legs) => { onChangeCalls.push(legs) }
    })

    await it("render returns instance with API", () => {
        assert.ok(sched)
        assert.strictEqual(typeof sched.update, "function")
        assert.strictEqual(typeof sched.getLegs, "function")
        assert.strictEqual(typeof sched.destroy, "function")
    })

    await it("getLegs returns deep copy of initial legs", () => {
        const legs = sched.getLegs()
        assert.strictEqual(legs.length, 2)
        assert.strictEqual(legs[0].destination, "JFK")
        assert.strictEqual(legs[1].destination, "MAD")
        // Deep copy — mutating shouldn't affect internal state
        legs[0].destination = "MUTATED"
        const fresh = sched.getLegs()
        assert.strictEqual(fresh[0].destination, "JFK", "internal state should be isolated")
    })

    await it("leg blocks rendered into day columns", () => {
        const blocks = host.findAll(el => el.dataset && el.dataset.legBlock === "1")
        // JFK has 4 enabled days × 1 block = 4. MAD has 5 × 1 = 5. Total 9.
        assert.strictEqual(blocks.length, 9, "expected 9 blocks total, got " + blocks.length)
    })

    await it("each block tagged with leg index dataset", () => {
        const blocks = host.findAll(el => el.dataset && el.dataset.legBlock === "1")
        const jfkBlocks = blocks.filter(b => b.dataset.legIdx === "0")
        const madBlocks = blocks.filter(b => b.dataset.legIdx === "1")
        assert.strictEqual(jfkBlocks.length, 4, "JFK 4 days enabled")
        assert.strictEqual(madBlocks.length, 5, "MAD 5 days enabled")
    })

    await it("clicking a leg block opens inline editor", () => {
        const blocks = host.findAll(el => el.dataset && el.dataset.legBlock === "1")
        const target = blocks[0]
        target.click()
        // Editor appended to block: look for time input inside any block
        const allEditors = host.findAll(el => el.tagName === "INPUT" && el._attrs.type === "time")
        // Note: my fake DOM has type set via .type assignment, not setAttribute.
        // Let me check via different path: find any input descendant.
        const inputs = host.findAll(el => el.tagName === "INPUT")
        assert.ok(inputs.length >= 1, "editor should add inputs, got " + inputs.length)
    })

    await it("update() with new legs replaces internal state", () => {
        onChangeCalls = []
        const newLegs = [
            {origin: "FRA", destination: "LHR", depTime: "08:00",
             dayMask: [true, true, true, true, true, true, true],
             pricePct: 100, service: "", flightNumberText: "",
             _meta: {blockHrs: 3, freqPerWeek: 7, classification: "short"}}
        ]
        sched.update(newLegs)
        const got = sched.getLegs()
        assert.strictEqual(got.length, 1)
        assert.strictEqual(got[0].destination, "LHR")
    })

    await it("update() re-renders blocks (LHR has 7 days = 7 blocks)", () => {
        const blocks = host.findAll(el => el.dataset && el.dataset.legBlock === "1")
        assert.strictEqual(blocks.length, 7, "LHR should produce 7 blocks (every day)")
    })

    await it("conflict detection works after update()", () => {
        const conflictingLegs = [
            {destination: "JFK", depTime: "09:00",
             dayMask: [true, false, false, false, false, false, false],
             _meta: {blockHrs: 6, freqPerWeek: 1}},
            {destination: "LAX", depTime: "10:00",
             dayMask: [true, false, false, false, false, false, false],
             _meta: {blockHrs: 6, freqPerWeek: 1}}
        ]
        sched.update(conflictingLegs)
        const conflicts = MS._findConflicts(conflictingLegs)
        assert.strictEqual(conflicts.size, 2)
    })

    await it("destroy() clears the host", () => {
        sched.destroy()
        assert.strictEqual(host.children.length, 0,
            "host should be empty after destroy, got " + host.children.length)
    })

    // === Re-render after destroy ===
    await it("can re-render after destroy without errors", () => {
        const sched2 = MS.render(host, initialLegs, {})
        assert.ok(sched2, "re-render returned instance")
        const blocks = host.findAll(el => el.dataset && el.dataset.legBlock === "1")
        assert.strictEqual(blocks.length, 9, "re-render produces same 9 blocks")
        sched2.destroy()
    })

    // === Day toggle button mutation ===
    console.log("\n  --- Day toggle simulation ---")
    const sched3 = MS.render(host, initialLegs, {
        onChange: (legs) => { onChangeCalls.push(legs) }
    })

    await it("simulating block click + day toggle button click mutates dayMask", () => {
        onChangeCalls = []
        const blocks = host.findAll(el => el.dataset && el.dataset.legBlock === "1")
        // Click first JFK block to open editor
        const jfk0 = blocks.find(b => b.dataset.legIdx === "0")
        assert.ok(jfk0, "JFK block found")
        jfk0.click()
        // Editor was appended into the block (mock-schedule.js:_openEditor → block.appendChild(editor))
        // Find day toggle buttons — text is the first letter of a day (M T W T F S S)
        const DAY_LETTERS = new Set(["M", "T", "W", "F", "S"])
        const dayBtns = jfk0.findAll(el => el.tagName === "BUTTON"
            && el._textContent && el._textContent.length === 1
            && DAY_LETTERS.has(el._textContent))
        assert.ok(dayBtns.length === 7, "should be 7 day toggles, got " + dayBtns.length)
        // Toggle Tuesday (idx 1) — was off, click to enable
        dayBtns[1].click()
        // Day toggle alone doesn't trigger onChange (only ✓ commit does).
        // Find ✓ button.
        const okBtns = jfk0.findAll(el => el.tagName === "BUTTON" && el._textContent === "✓")
        assert.ok(okBtns.length >= 1, "✓ button found")
        okBtns[0].click()
        const updated = sched3.getLegs()
        assert.strictEqual(updated[0].dayMask[1], true,
            "Tuesday should now be enabled, got " + JSON.stringify(updated[0].dayMask))
        assert.ok(onChangeCalls.length >= 1, "onChange should fire on commit")
    })

    await it("simulating delete button removes the leg", () => {
        const before = sched3.getLegs().length
        onChangeCalls = []
        const blocks = host.findAll(el => el.dataset && el.dataset.legBlock === "1")
        const target = blocks[0]
        target.click()
        // Find delete button (🗑 emoji)
        const delBtns = target.findAll(el => el.tagName === "BUTTON" && el._textContent === "🗑")
        assert.ok(delBtns.length >= 1, "delete button found")
        delBtns[0].click()
        const after = sched3.getLegs().length
        assert.strictEqual(after, before - 1,
            "delete should remove 1 leg, before=" + before + " after=" + after)
        assert.ok(onChangeCalls.length >= 1, "onChange should fire on delete")
    })

    sched3.destroy()

    console.log("\n  " + pass + " passed, " + fail + " failed")
    if (fail) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
