"use strict"

/**
 * Route-builder pipeline smoke test — fillAndSubmit path.
 *
 * Validates that:
 *  1. fillAndSubmit calls submitBtn.click() exactly once on a valid leg
 *  2. fillAndSubmit returns {ok:false} without clicking when destination missing
 *  3. fillAndSubmit rejects batch[] shape (defensive)
 *  4. Two consecutive fillAndSubmit calls each produce one click (no leak)
 *
 * The submit button is stubbed — no real POST happens. This validates the
 * single-POST-chokepoint invariant (form-driver.js:661 click is the only
 * mutating call) and that the gating logic is reached correctly.
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

function mkOption(value, text) {
    return { value: String(value), textContent: String(text || ""), text: String(text || "") }
}
function mkSelect(name, opts) {
    return {
        name, value: "", selectedIndex: 0,
        options: opts.map(o => typeof o === "string" ? mkOption(o, o) : mkOption(o.value, o.text)),
        dispatchEvent() { return true }
    }
}
function mkInput(name, value) {
    return { name, value: value || "", type: "text", dispatchEvent() { return true } }
}
function mkCheckbox(name) {
    return { type: "checkbox", name, value: "true", checked: false, dispatchEvent() { return true } }
}

function buildForm() {
    const dayCheckboxes = Array.from({length: 7}, (_, i) =>
        mkCheckbox(`form:daySelection:${i}:ticked`))
    const submitBtn = { name: "submit", clicked: 0, click() { this.clicked++ } }
    const form = {
        action: "/app/fleets/aircraft/9001/0?wicket:interface=:foo",
        querySelectorAll: (sel) => sel.includes("daySelection") ? dayCheckboxes : []
    }
    return {
        form,
        originSelect: mkSelect("origin", [{value:"1001",text:"FRA Frankfurt (FRA)"}, {value:"1002",text:"London (LHR)"}]),
        destSelect: mkSelect("destination", [{value:"2001",text:"NYC (JFK)"}, {value:"2002",text:"LA (LAX)"}]),
        hoursSelect: mkSelect("departure:hours", Array.from({length:24}, (_,i) => String(i))),
        minsSelect: mkSelect("departure:minutes", ["0", "30"]),
        priceSelect: mkSelect("price", [{value:"100",text:"100%"}]),
        serviceSelect: mkSelect("service", [{value:"",text:"default"}, {value:"PAX",text:"Pax"}]),
        flightNumberInput: mkInput("number:number_body:input", ""),
        submitBtn,
        reverseBtn: null,
        _dayCheckboxes: dayCheckboxes
    }
}

function setupGlobals(formCtx) {
    global.window = {}
    global.window.AesAfp = {
        getNewFlightForm: () => formCtx,
        getFormTabs: () => null,
        getActiveHub: () => "FRA",
        ctx: { server: "free1", aircraftId: "9001", currentLocationIata: "FRA" },
        bus: { emit() {}, on() {} },
        slot: () => null
    }
    global.window.AesAfpSettings = {
        load: async () => ({ defaultPricePct: 100, defaultService: "", defaultDepartureTime: "09:00" })
    }
    global.document = {
        readyState: "complete",
        addEventListener() {}, removeEventListener() {},
        querySelectorAll: (sel) => sel.includes("daySelection") ? formCtx._dayCheckboxes : [],
        querySelector: () => null
    }
    global.location = { search: "" }
    global.chrome = { runtime: { onMessage: { addListener() {} } } }
    global.Event = class { constructor(t) { this.type = t } }
    global.setTimeout = setTimeout
}

function loadFormDriver() {
    delete global.window.AesAfpFormDriver
    const src = fs.readFileSync(path.join(ROOT, "modules/aircraft-flight-plan/form-driver.js"), "utf8")
    eval(src)
    return global.window.AesAfpFormDriver
}

async function run() {
    console.log("\nRoute-builder fill+submit smoke (form-driver):")

    const formCtx = buildForm()
    setupGlobals(formCtx)
    const driver = loadFormDriver()

    await it("fillAndSubmit on valid leg returns {ok:true, posting:true}", async () => {
        const r = await driver.fillAndSubmit({
            origin: "FRA", destination: "JFK", depTime: "09:30", pricePct: 100, service: "PAX"
        })
        assert.strictEqual(r.ok, true, "ok should be true: " + JSON.stringify(r))
        assert.strictEqual(r.posting, true)
    })

    await it("fillAndSubmit scheduled exactly one submit click (after microtask)", async () => {
        await new Promise(r => setTimeout(r, 10))
        assert.strictEqual(formCtx.submitBtn.clicked, 1,
            "expected 1 click, got " + formCtx.submitBtn.clicked)
    })

    await it("fillAndSubmit on missing destination returns {ok:false} without click", async () => {
        const beforeClicks = formCtx.submitBtn.clicked
        const r = await driver.fillAndSubmit({ origin: "FRA" })
        await new Promise(r => setTimeout(r, 10))
        assert.strictEqual(r.ok, false, "should fail: " + JSON.stringify(r))
        assert.match(r.error || "", /destination/, "error should mention destination")
        assert.strictEqual(formCtx.submitBtn.clicked, beforeClicks,
            "no click should happen on invalid leg")
    })

    await it("fillAndSubmit rejects batch[] shape (invariant)", async () => {
        const beforeClicks = formCtx.submitBtn.clicked
        const r = await driver.fillAndSubmit({ batch: [{destination:"JFK"}, {destination:"LAX"}] })
        await new Promise(r => setTimeout(r, 10))
        assert.strictEqual(r.ok, false)
        assert.match(r.error, /batch/i, "error should reference batch")
        assert.strictEqual(formCtx.submitBtn.clicked, beforeClicks,
            "no click on batch[] rejection")
    })

    await it("two consecutive fillAndSubmit calls each click once (no leak)", async () => {
        const baseline = formCtx.submitBtn.clicked
        await driver.fillAndSubmit({ destination: "JFK" })
        await driver.fillAndSubmit({ destination: "LAX" })
        await new Promise(r => setTimeout(r, 10))
        assert.strictEqual(formCtx.submitBtn.clicked, baseline + 2,
            "expected baseline+2 clicks, got " + (formCtx.submitBtn.clicked - baseline))
    })

    await it("fillAndSubmit with cargo service routes through correctly", async () => {
        const baseline = formCtx.submitBtn.clicked
        // Add CARGO option to the service select for this leg
        formCtx.serviceSelect.options.push({value:"CARGO", text:"Cargo"})
        const r = await driver.fillAndSubmit({ destination: "JFK", service: "CARGO" })
        await new Promise(r => setTimeout(r, 10))
        assert.strictEqual(r.ok, true, "cargo leg should fill ok: " + JSON.stringify(r))
        assert.strictEqual(formCtx.submitBtn.clicked, baseline + 1)
    })

    console.log("\n  " + pass + " passed, " + fail + " failed")
    if (fail) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
