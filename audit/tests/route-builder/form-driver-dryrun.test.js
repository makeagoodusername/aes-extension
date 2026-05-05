"use strict"

/**
 * Route-builder pipeline smoke test — dry-run twice end-to-end.
 *
 * Builds a synthetic AS New-Flight form (selects + checkboxes + hidden
 * inputs), stubs window.AesAfp + window.AesAfpSettings, loads form-driver.js
 * isolated-world style, then calls `dryRun(leg)` against a realistic leg
 * payload. Verifies the body the form would POST is correct, complete, and
 * idempotent across two consecutive runs.
 *
 * NEVER POSTs — dryRun() is a pure read of the DOM.
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
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
    }
}

// --- Synthetic DOM ---------------------------------------------------------

function mkOption(value, text) {
    return {
        value: String(value),
        textContent: String(text || ""),
        innerText: String(text || ""),
        text: String(text || "")
    }
}

function mkSelect(name, opts) {
    return {
        name, value: "", selectedIndex: 0,
        options: opts.map(o => typeof o === "string" ? mkOption(o, o) : mkOption(o.value, o.text)),
        add(opt) { this.options.push(opt) },
        dispatchEvent() { return true }
    }
}

function setSelectOptions(sel, opts, selectedIndex) {
    sel.options = opts.map(o => typeof o === "string" ? mkOption(o, o) : mkOption(o.value, o.text))
    sel.selectedIndex = Number.isFinite(selectedIndex) ? selectedIndex : 0
    const opt = sel.options[sel.selectedIndex]
    sel.value = opt ? opt.value : ""
}

function mkCheckbox(name, value) {
    return {
        type: "checkbox", name, value: value || "on", checked: false,
        dispatchEvent() { return true }
    }
}

function mkHidden(name, value) {
    return { type: "hidden", name, value: String(value || "") }
}

function mkInput(name, value) {
    return {
        name, value: value || "", type: "text",
        dispatchEvent() { return true }
    }
}

function buildForm() {
    const originSelect = mkSelect("origin", [
        { value: "1001", text: "Frankfurt, Germany (FRA)" },
        { value: "1002", text: "London, UK (LHR)" }
    ])
    const destSelect = mkSelect("destination", [
        { value: "2001", text: "New York, USA (JFK)" },
        { value: "2002", text: "Los Angeles, USA (LAX)" },
        { value: "2003", text: "Tokyo, Japan (NRT)" }
    ])
    const hoursSelect = mkSelect("departure:hours", Array.from({length: 24}, (_, i) => String(i)))
    const minsSelect  = mkSelect("departure:minutes", Array.from({length: 12}, (_, i) => String(i * 5)))
    const priceSelect = mkSelect("price", [
        {value: "", text: "default"},
        {value: "80", text: "80%"},
        {value: "90", text: "90%"},
        {value: "100", text: "100%"},
        {value: "110", text: "110%"},
        {value: "120", text: "120%"}
    ])
    const serviceSelect = mkSelect("service", [
        {value: "", text: "default"},
        {value: "PAX", text: "Passenger"},
        {value: "CARGO", text: "Cargo"},
        {value: "MAIL", text: "Mail"}
    ])
    const flightNumberInput = mkInput("number:number_body:input", "")
    const dayCheckboxes = Array.from({length: 7}, (_, i) =>
        mkCheckbox(`form:daySelection:${i}:ticked`, "true"))
    const hiddenFields = [
        mkHidden("wicket:interface", "?-3"),
        mkHidden("formSignature", "abc123")
    ]

    const submitBtn = { name: "submit", clicked: 0, click() { this.clicked++ } }

    // querySelectorAll for day checkboxes + hidden inputs
    const allElements = [...dayCheckboxes, ...hiddenFields]
    const form = {
        action: "https://free1.airlinesim.aero/app/fleets/aircraft/9001/0?wicket:interface=:foo",
        querySelectorAll(selector) {
            if (selector.includes("daySelection")) return dayCheckboxes
            if (selector.includes("hidden")) return hiddenFields
            return []
        },
        querySelector() { return null }
    }

    return {
        form, originSelect, destSelect, hoursSelect, minsSelect,
        priceSelect, serviceSelect, flightNumberInput, submitBtn,
        reverseBtn: null
    }
}

// --- Globals stub ----------------------------------------------------------

function setupGlobals(formCtx) {
    const handlers = new Map()
    const bus = {
        on(name, h) {
            if (!handlers.has(name)) handlers.set(name, [])
            handlers.get(name).push(h)
        },
        emit(name, payload) {
            for (const h of handlers.get(name) || []) h(payload)
        }
    }
    formCtx._bus = bus
    global.window = global.window || {}
    global.window.AesAfp = {
        getNewFlightForm: () => formCtx,
        getFormTabs: () => null,
        getActiveHub: () => "FRA",
        ctx: { server: "free1", aircraftId: "9001", currentLocationIata: "FRA" },
        bus,
        slot: () => null
    }
    global.window.AesAfpSettings = {
        load: async () => ({
            defaultPricePct: 100,
            defaultService: "",
            defaultDepartureTime: "09:00"
        })
    }
    global.document = global.document || {
        readyState: "complete",
        addEventListener() {}, removeEventListener() {},
        querySelectorAll(selector) {
            if (selector.includes("daySelection")) return formCtx.querySelectorAll
                ? formCtx.form.querySelectorAll(selector)
                : []
            return []
        },
        querySelector: () => null
    }
    global.location = global.location || { search: "" }
    global.chrome = global.chrome || { runtime: { onMessage: { addListener() {} } } }
    global.Event = class { constructor(type) { this.type = type } }
}

function loadFormDriver() {
    const src = fs.readFileSync(path.join(ROOT, "modules/aircraft-flight-plan/form-driver.js"), "utf8")
    eval(src)
    return global.window.AesAfpFormDriver
}

// --- Tests -----------------------------------------------------------------

async function run() {
    console.log("\nRoute-builder dry-run smoke (form-driver):")

    const formCtx = buildForm()
    setupGlobals(formCtx)
    const driver = loadFormDriver()

    if (!driver) {
        console.log("  FAIL form-driver did not register on window")
        process.exit(1)
    }

    await it("driver exposes dryRun()", () => {
        assert.strictEqual(typeof driver.dryRun, "function")
    })

    await it("driver exposes fillAndSubmit()", () => {
        assert.strictEqual(typeof driver.fillAndSubmit, "function")
    })

    // --- Run 1 --------------------------------------------------------------
    const leg = {
        origin: "FRA",
        destination: "JFK",
        depTime: "14:30",
        dayMask: [true, false, true, false, true, false, true],  // Mon/Wed/Fri/Sun
        pricePct: 110,
        service: "PAX",
        flightNumberText: "1234"
    }

    let r1
    await it("dryRun #1 returns body + url for valid leg", () => {
        r1 = driver.dryRun(leg)
        assert.ok(r1, "dryRun returned undefined")
        assert.strictEqual(typeof r1.body, "object", "body absent")
        assert.ok(r1.url && r1.url.length, "url absent")
        assert.strictEqual(r1.missed.length, 0, "missed: " + JSON.stringify(r1.missed))
    })

    await it("dryRun #1 body has origin = FRA option value", () => {
        assert.strictEqual(r1.body.origin, "1001")
    })

    await it("dryRun #1 body has destination = JFK option value", () => {
        assert.strictEqual(r1.body.destination, "2001")
    })

    await it("dryRun #1 body has departure 14:30", () => {
        assert.strictEqual(r1.body["departure:hours"], "14")
        assert.strictEqual(r1.body["departure:minutes"], "30")
    })

    await it("dryRun #1 body has price = 110", () => {
        assert.strictEqual(r1.body.price, "110")
    })

    await it("dryRun #1 body has service = PAX", () => {
        assert.strictEqual(r1.body.service, "PAX")
    })

    await it("dryRun #1 body has flight-number suffix 1234", () => {
        assert.strictEqual(r1.body["number:number_body:input"], "1234")
    })

    await it("dryRun #1 body has Mon/Wed/Fri/Sun day checkboxes set", () => {
        assert.strictEqual(r1.body["form:daySelection:0:ticked"], "true", "Mon should be on")
        assert.strictEqual(r1.body["form:daySelection:2:ticked"], "true", "Wed should be on")
        assert.strictEqual(r1.body["form:daySelection:4:ticked"], "true", "Fri should be on")
        assert.strictEqual(r1.body["form:daySelection:6:ticked"], "true", "Sun should be on")
        assert.strictEqual(r1.body["form:daySelection:1:ticked"], undefined, "Tue should be off")
        assert.strictEqual(r1.body["form:daySelection:3:ticked"], undefined, "Thu should be off")
        assert.strictEqual(r1.body["form:daySelection:5:ticked"], undefined, "Sat should be off")
    })

    await it("dryRun #1 body has hidden Wicket fields", () => {
        assert.strictEqual(r1.body["wicket:interface"], "?-3")
        assert.strictEqual(r1.body["formSignature"], "abc123")
    })

    // --- Run 2 (idempotency) -----------------------------------------------
    let r2
    await it("dryRun #2 returns identical body shape", () => {
        r2 = driver.dryRun(leg)
        assert.deepStrictEqual(r2.body, r1.body)
        assert.strictEqual(r2.missed.length, 0)
        assert.strictEqual(r2.url, r1.url)
    })

    // --- Verify dryRun was actually pure (no submit) -----------------------
    await it("dryRun did not click the submit button (zero clicks)", () => {
        assert.strictEqual(formCtx.submitBtn.clicked, 0,
            "submit button was clicked " + formCtx.submitBtn.clicked + " times")
    })

    // --- Edge: leg without optional fields ---------------------------------
    let r3
    await it("dryRun with minimal leg (destination only) defaults correctly", () => {
        r3 = driver.dryRun({ destination: "LAX" })
        assert.strictEqual(r3.body.origin, "1001", "origin defaults to active hub FRA via _activeHubIata")
        assert.strictEqual(r3.body.destination, "2002", "destination LAX")
        assert.strictEqual(r3.body["departure:hours"], "9", "default 09:00")
        assert.strictEqual(r3.body["departure:minutes"], "0")
        assert.strictEqual(r3.body.price, "100", "default 100%")
        assert.strictEqual(r3.body.service, "", "default empty service")
        assert.strictEqual(r3.body["form:daySelection:0:ticked"], "true", "all days default on (Mon)")
        assert.strictEqual(r3.body["form:daySelection:6:ticked"], "true", "all days default on (Sun)")
    })

    // --- Edge: leg missing destination → missed flag -----------------------
    let r4
    await it("dryRun without destination flags missed[]", () => {
        r4 = driver.dryRun({ origin: "FRA" })
        assert.ok(r4.missed.includes("destination"), "should flag destination as missed")
    })

    // --- Edge: cargo service -----------------------------------------------
    let r5
    await it("dryRun with service=CARGO routes through correctly", () => {
        r5 = driver.dryRun({ destination: "NRT", service: "CARGO" })
        assert.strictEqual(r5.body.service, "CARGO")
        assert.strictEqual(r5.body.destination, "2003")
    })

    await it("dryRun borrows endpoint values across O/D selects for inbound wave legs", () => {
        const r = driver.dryRun({ origin: "NRT", destination: "FRA", depTime: "08:05" })
        assert.strictEqual(r.body.origin, "2003", "origin NRT should borrow destination option value")
        assert.strictEqual(r.body.destination, "1001", "destination FRA should borrow origin option value")
        assert.strictEqual(r.body["departure:hours"], "8")
        assert.strictEqual(r.body["departure:minutes"], "5")
        assert.strictEqual(r.missed.length, 0, "missed: " + JSON.stringify(r.missed))
    })

    await it("fill sets exact inbound wave O/D and time when endpoints start in opposite selects", async () => {
        const r = await driver.fill({ origin: "NRT", destination: "FRA", depTime: "08:05" })
        assert.strictEqual(r.ok, true, "fill missed: " + JSON.stringify(r.missed))
        assert.strictEqual(formCtx.originSelect.value, "2003")
        assert.strictEqual(formCtx.destSelect.value, "1001")
        assert.strictEqual(formCtx.hoursSelect.value, "8")
        assert.strictEqual(formCtx.minsSelect.value, "5")
        assert.strictEqual(formCtx.submitBtn.clicked, 0, "fill must not submit")
    })

    await it("fill does not reverse a blank AS form before setting outbound O/D", async () => {
        let reversed = 0
        setSelectOptions(formCtx.originSelect, [
            {value: "", text: "Choose One"},
            {value: "1001", text: "Frankfurt, Germany (FRA)"},
            {value: "2003", text: "Tokyo, Japan (NRT)"}
        ], 0)
        setSelectOptions(formCtx.destSelect, [
            {value: "", text: "Choose One"},
            {value: "1001", text: "Frankfurt, Germany (FRA)"},
            {value: "2003", text: "Tokyo, Japan (NRT)"}
        ], 0)
        formCtx.reverseBtn = { click() { reversed++ } }
        const r = await driver.fill({ origin: "FRA", destination: "NRT", depTime: "08:05" })
        assert.strictEqual(r.ok, true, "fill missed: " + JSON.stringify(r.missed))
        assert.strictEqual(reversed, 0, "blank form should not click reverse")
        assert.strictEqual(formCtx.originSelect.value, "1001")
        assert.strictEqual(formCtx.destSelect.value, "2003")
        assert.strictEqual(formCtx.hoursSelect.value, "8")
        assert.strictEqual(formCtx.minsSelect.value, "5")
        formCtx.reverseBtn = null
    })

    await it("candidate:selected wave-leg payload fills origin, destination, and departure", async () => {
        setSelectOptions(formCtx.originSelect, [
            { value: "1001", text: "Frankfurt, Germany (FRA)" },
            { value: "1002", text: "London, UK (LHR)" },
            { value: "2002", text: "Los Angeles, USA (LAX)" }
        ], 0)
        setSelectOptions(formCtx.destSelect, [
            { value: "2001", text: "New York, USA (JFK)" },
            { value: "2002", text: "Los Angeles, USA (LAX)" },
            { value: "1002", text: "London, UK (LHR)" }
        ], 0)
        formCtx._bus.emit("candidate:selected", {
            source: "wave-leg",
            candidate: {
                destIata: "LAX",
                __wave: {
                    origin: "LAX",
                    destination: "LHR",
                    depTime: "06:15",
                    direction: "inbound"
                }
            }
        })
        await new Promise(r => setTimeout(r, 0))
        assert.strictEqual(formCtx.originSelect.value, "2002")
        assert.strictEqual(formCtx.destSelect.value, "1002")
        assert.strictEqual(formCtx.hoursSelect.value, "6")
        assert.strictEqual(formCtx.minsSelect.value, "15")
        assert.strictEqual(formCtx.submitBtn.clicked, 0, "bus fill must not submit")
    })

    await it("fill reverses AS orientation before applying an outbound wave leg", async () => {
        let reversed = 0
        setSelectOptions(formCtx.originSelect, [
            {value: "", text: "Choose One"},
            {value: "2003", text: "Tokyo, Japan (NRT)"},
            {value: "2002", text: "Los Angeles, USA (LAX)"}
        ], 0)
        setSelectOptions(formCtx.destSelect, [
            {value: "1001", text: "Frankfurt, Germany (FRA)"}
        ], 0)
        formCtx.reverseBtn = {
            click() {
                reversed++
                setSelectOptions(formCtx.originSelect, [
                    {value: "1001", text: "Frankfurt, Germany (FRA)"}
                ], 0)
                setSelectOptions(formCtx.destSelect, [
                    {value: "", text: "Choose One"},
                    {value: "2003", text: "Tokyo, Japan (NRT)"},
                    {value: "2002", text: "Los Angeles, USA (LAX)"}
                ], 0)
            }
        }
        const r = await driver.fill({ origin: "FRA", destination: "NRT", depTime: "08:05" })
        assert.strictEqual(r.ok, true, "fill missed: " + JSON.stringify(r.missed))
        assert.strictEqual(reversed, 1, "reverse control should be clicked once")
        assert.strictEqual(formCtx.originSelect.value, "1001")
        assert.strictEqual(formCtx.destSelect.value, "2003")
        assert.strictEqual(formCtx.hoursSelect.value, "8")
        assert.strictEqual(formCtx.minsSelect.value, "5")
        assert.strictEqual(formCtx.submitBtn.clicked, 0, "orientation fill must not submit")
        formCtx.reverseBtn = null
    })

    // --- Idempotency across mixed-leg sequence -----------------------------
    await it("running 5 different legs in sequence preserves form state", () => {
        setSelectOptions(formCtx.originSelect, [
            { value: "1001", text: "Frankfurt, Germany (FRA)" },
            { value: "1002", text: "London, UK (LHR)" }
        ], 0)
        setSelectOptions(formCtx.destSelect, [
            { value: "2001", text: "New York, USA (JFK)" },
            { value: "2002", text: "Los Angeles, USA (LAX)" },
            { value: "2003", text: "Tokyo, Japan (NRT)" }
        ], 0)
        const legs = [
            { destination: "JFK", service: "PAX" },
            { destination: "LAX", service: "CARGO", pricePct: 90 },
            { destination: "NRT", service: "MAIL", depTime: "06:15" },
            { destination: "JFK", flightNumberText: "9999" },
            { destination: "LAX", dayMask: [true,false,false,false,false,false,false] }
        ]
        for (let i = 0; i < legs.length; i++) {
            const r = driver.dryRun(legs[i])
            assert.strictEqual(r.missed.length, 0, "leg " + i + " missed: " + JSON.stringify(r.missed))
            assert.ok(r.body.destination, "leg " + i + " destination missing")
        }
        // Submit still never clicked
        assert.strictEqual(formCtx.submitBtn.clicked, 0, "no POST should have happened")
    })

    console.log("\n  " + pass + " passed, " + fail + " failed")
    if (fail) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
