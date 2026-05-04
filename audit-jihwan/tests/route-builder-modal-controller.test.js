"use strict"

/**
 * Route Builder MODAL — controller-logic smoke.
 *
 * Loads the new modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js
 * in a Node sandbox (no DOM) and exercises the pure helpers it exposes via
 * `window.AesAfpRouteBuilderModal._internal`:
 *
 *   parseIataList(text)            — IATA tokeniser
 *   materialiseLegs(build, draft)  — overlays draft.perLegEdits onto planner flights
 *   buildApplyPayload(state)       — final {ctx, legs, source} sent to AesAfpAutoApplyBatch.start
 *   defaultConfig(overrides)       — planner config baseline
 *   singleDayMask(idx)             — 7-element 0/1 array
 *
 * The modal's render path needs a DOM (document.createElement) and is exercised
 * separately via the existing audit/tests/afp/route-builder-planner.test.js +
 * audit-jihwan/tests/route-builder-workbench-e2e.test.js suite. This test
 * proves that the modal-level pipeline (planner ➜ draft overlay ➜ apply
 * payload) produces the right `{ctx, legs}` payload for AesAfpAutoApplyBatch.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

function makeChromeStub() {
    const store = new Map()
    return {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) {
                        const out = {}; for (const [k, v] of store) out[k] = v; return out
                    }
                    if (typeof keys === "string") {
                        const out = {}; if (store.has(keys)) out[keys] = store.get(keys); return out
                    }
                    if (Array.isArray(keys)) {
                        const out = {}; for (const k of keys) if (store.has(k)) out[k] = store.get(k); return out
                    }
                    return {}
                },
                async set(items) { for (const k in items) store.set(k, items[k]) },
                async remove(keys) {
                    if (Array.isArray(keys)) for (const k of keys) store.delete(k)
                    else store.delete(keys)
                }
            },
            onChanged: {addListener() {}, removeListener() {}}
        },
        runtime: {id: "test"}
    }
}

function reset() {
    for (const n of [
        "AesAfpRouteBuilderModal", "AesAfpRouteBuilderPlanner",
        "AesAfpActiveDraftStore", "ScheduleFactors"
    ]) {
        try { delete global[n] } catch (_) {}
    }
    global.window = global
    global.chrome = makeChromeStub()
    // Stub document so the modal IIFE doesn't crash on initial load. The
    // pure helpers we test never touch document.
    global.document = {
        createElement: () => ({style: {cssText: ""}, appendChild() {}, addEventListener() {}}),
        body: {appendChild() {}, removeChild() {}}
    }
}

function load(rel, exposeNames) {
    let src = fs.readFileSync(path.join(ROOT, rel), "utf8")
    if (Array.isArray(exposeNames) && exposeNames.length) {
        src += "\n;(function(){\n"
        for (const n of exposeNames) {
            src += `try { if (typeof ${n} !== "undefined") window.${n} = ${n}; } catch(_) {}\n`
        }
        src += "})();\n"
    }
    eval(src)
}

function loadStack() {
    load("modules/schedule-management/range-buckets.js", ["ScheduleFactors"])
    load("modules/aircraft-flight-plan/auto-scheduler/route-builder-planner.js")
    load("modules/aircraft-flight-plan/active-draft-store.js", ["AesAfpActiveDraftStore"])
    load("modules/aircraft-flight-plan/auto-scheduler/route-builder-modal.js")
}

function candidates() {
    return [
        {destIata: "CDG", distanceKm: 344,  paxScore: 7,  cargoScore: 3, weeklyFlights: 90, scoreBlend: 700},
        {destIata: "DUB", distanceKm: 449,  paxScore: 8,  cargoScore: 2, weeklyFlights: 80, scoreBlend: 500},
        {destIata: "JFK", distanceKm: 5540, paxScore: 10, cargoScore: 8, weeklyFlights: 48, scoreBlend: 900},
        {destIata: "HND", distanceKm: 9600, paxScore: 10, cargoScore: 9, weeklyFlights: 20, scoreBlend: 850}
    ]
}
const SPEC = {typeName: "Boeing 777-300ER", cruiseSpeedKmh: 905, range: 14000}

let pass = 0, fail = 0
async function it(name, fn) {
    try { await fn(); pass++; console.log("  ok  " + name) }
    catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)) }
}

;(async () => {

console.log("=== route-builder-modal-controller ===")

// ── 1) Module loads and exposes _internal helpers ─────────────────────
await it("modal loads and exposes _internal helpers", async () => {
    reset(); loadStack()
    assert.ok(window.AesAfpRouteBuilderModal, "AesAfpRouteBuilderModal not exposed")
    const I = window.AesAfpRouteBuilderModal._internal
    assert.ok(I, "_internal not exposed")
    for (const fn of ["parseIataList", "materialiseLegs", "buildApplyPayload",
                       "defaultConfig", "singleDayMask", "dayFromMask"]) {
        assert.strictEqual(typeof I[fn], "function", "_internal." + fn + " not a function")
    }
})

// ── 2) parseIataList — comma + space + semicolon separators ──────────
await it("parseIataList handles comma/space/semicolon separators", async () => {
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    assert.deepStrictEqual(I.parseIataList("JFK, LHR  CDG;DUB"), ["JFK", "LHR", "CDG", "DUB"])
    assert.deepStrictEqual(I.parseIataList(""), [])
    assert.deepStrictEqual(I.parseIataList("jfk,LHR,not-iata,CDG"), ["JFK", "LHR", "CDG"])
    // Dupes collapse, order preserved.
    assert.deepStrictEqual(I.parseIataList("JFK,JFK,LHR,JFK"), ["JFK", "LHR"])
})

// ── 3) defaultConfig + singleDayMask sanity ──────────────────────────
await it("defaultConfig defaults are sane; singleDayMask is 7-element 0/1", async () => {
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    const cfg = I.defaultConfig()
    assert.strictEqual(cfg.targetFlights, 4)
    assert.strictEqual(cfg.sequentialLongHaul, true)
    assert.strictEqual(cfg.baseDeparture, "06:00")
    assert.deepStrictEqual(I.singleDayMask(0), [1, 0, 0, 0, 0, 0, 0])
    assert.deepStrictEqual(I.singleDayMask(3), [0, 0, 0, 1, 0, 0, 0])
    assert.deepStrictEqual(I.singleDayMask(7), [1, 0, 0, 0, 0, 0, 0])  // wraps
})

// ── 4) materialiseLegs overlays per-leg edits onto planner flights ───
await it("materialiseLegs overlays user-edited HH:MM + dayMask onto planner flights", async () => {
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    const result = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR", candidates: candidates(), spec: SPEC,
        config: {includedIatas: ["DUB", "JFK"], targetFlights: 4}
    })
    const build = result.build
    assert.strictEqual(build.flights.length, 4)
    const outDub = build.flights.find(f => f.destination === "DUB" && f.direction === "outbound")
    const inJfk = build.flights.find(f => f.origin === "JFK" && f.direction === "inbound")
    assert.ok(outDub && inJfk, "expected DUB out + JFK in flights")

    const draft = {perLegEdits: {}}
    draft.perLegEdits[outDub.seq] = {depTimeLocal: "13:45"}
    draft.perLegEdits[inJfk.seq]  = {depTimeLocal: "21:00", dayMask: I.singleDayMask(3)}

    const legs = I.materialiseLegs(build, draft, null)
    const outE = legs.find(l => l.seq === outDub.seq)
    const inE  = legs.find(l => l.seq === inJfk.seq)
    assert.strictEqual(outE.depTime, "13:45", "out edit not overlayed: " + outE.depTime)
    assert.strictEqual(inE.depTime,  "21:00", "in edit not overlayed: " + inE.depTime)
    assert.deepStrictEqual(inE.dayMask, [0, 0, 0, 1, 0, 0, 0], "in dayMask not overlayed")
})

// ── 5) buildApplyPayload — full pipe (planner ➜ overlay ➜ payload) ───
await it("buildApplyPayload produces the correct {ctx, legs, source} for AesAfpAutoApplyBatch.start", async () => {
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    const plannerResult = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR", candidates: candidates(), spec: SPEC,
        config: {includedIatas: ["JFK", "HND"], targetFlights: 4}
    })
    const draft = await window.AesAfpActiveDraftStore.load("free1", "22092")
    // No edits — the payload should reflect the planner's recommendation 1:1.
    const payload = I.buildApplyPayload({
        server: "free1", aircraftId: "22092", hub: "LHR",
        plannerResult, draft, settings: null
    })

    assert.deepStrictEqual(payload.ctx, {
        server: "free1", aircraftId: "22092", currentLocationIata: "LHR"
    })
    assert.strictEqual(payload.source, "route-builder-modal")
    assert.strictEqual(payload.legs.length, 4, "expected 4 legs for 2 round-trips")
    // Every leg has the fields apply-batch + form-driver need:
    for (const leg of payload.legs) {
        assert.ok(leg.origin,      "leg missing origin")
        assert.ok(leg.destination, "leg missing destination")
        assert.ok(leg.depTime,     "leg missing depTime")
        assert.ok(Array.isArray(leg.dayMask) && leg.dayMask.length === 7,
            "leg dayMask shape wrong")
        assert.ok(leg.dayMask.some(Boolean),
            "leg dayMask has no day set")
    }
})

// ── 6) End-to-end: edit ➜ payload reflects edit ──────────────────────
await it("end-to-end: planner recommend → setEdit → buildApplyPayload sees the edit", async () => {
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    const plannerResult = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR", candidates: candidates(), spec: SPEC,
        config: {includedIatas: ["CDG"], targetFlights: 2}
    })
    // Persist build into the draft store (matches what _runPlanner does)
    await window.AesAfpActiveDraftStore.setFlights("free1", "22092", {
        hub: "LHR",
        flights: plannerResult.build.flights,
        metadata: plannerResult.build.metadata
    })
    // User edits the outbound to depart at 19:30 instead.
    const outSeq = plannerResult.build.flights[0].seq
    await window.AesAfpActiveDraftStore.setEdit("free1", "22092", outSeq, {depTimeLocal: "19:30"})
    const draft = await window.AesAfpActiveDraftStore.load("free1", "22092")

    const payload = I.buildApplyPayload({
        server: "free1", aircraftId: "22092", hub: "LHR",
        plannerResult, draft, settings: null
    })
    const editedLeg = payload.legs.find(l => l.seq === outSeq)
    assert.ok(editedLeg, "edited leg missing from payload")
    assert.strictEqual(editedLeg.depTime, "19:30",
        "edit should land in apply payload, got " + editedLeg.depTime)
})

// ── 7) Empty/blank build → empty legs (won't bother the apply pipeline) ─
await it("empty plannerResult → empty legs (apply path is no-op)", async () => {
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    const payload = I.buildApplyPayload({
        server: "free1", aircraftId: "22092", hub: "LHR",
        plannerResult: null, draft: null
    })
    assert.deepStrictEqual(payload.legs, [])
    assert.strictEqual(payload.ctx.server, "free1")
})

// ── 8) Drop legs missing origin/dest/depTime so apply doesn't crash ──
await it("buildApplyPayload filters legs missing origin/destination/depTime", async () => {
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    // Synthetic build with one valid leg + one missing depTime + one missing dest.
    const build = {flights: [
        {seq: 1, origin: "LHR", destination: "JFK", depTimeLocal: "06:00", dayMask: [1,0,0,0,0,0,0]},
        {seq: 2, origin: "LHR", destination: "JFK", depTimeLocal: "",       dayMask: [1,0,0,0,0,0,0]},
        {seq: 3, origin: "LHR", destination: "",    depTimeLocal: "10:00",  dayMask: [1,0,0,0,0,0,0]}
    ]}
    const payload = I.buildApplyPayload({
        server: "free1", aircraftId: "22092", hub: "LHR",
        plannerResult: {build}, draft: null
    })
    assert.strictEqual(payload.legs.length, 1, "expected 1 valid leg, got " + payload.legs.length)
    assert.strictEqual(payload.legs[0].seq, 1)
})

// ── 9) Tile module loads cleanly ─────────────────────────────────────
await it("route-builder-tile.js loads without throwing", async () => {
    reset(); loadStack()
    // Fake CentralHubTile base + registry so the tile registers its factory.
    global.window.CentralHubTile = class { mount() {} }
    global.window.CentralHubTileRegistry = {
        _registered: [],
        register(spec) { this._registered.push(spec) }
    }
    load("modules/central-hub/tiles/route-builder-tile.js")
    const reg = global.window.CentralHubTileRegistry._registered
    const ours = reg.find(r => r.id === "route-builder")
    assert.ok(ours, "route-builder tile not registered: " + JSON.stringify(reg.map(r => r.id)))
    assert.strictEqual(ours.section, "fleet")
    assert.strictEqual(typeof ours.factory, "function")
})

// ── 10) Headline summary ─────────────────────────────────────────────
console.log("\n  example apply payload from a fresh planner run:")
{
    reset(); loadStack()
    const I = window.AesAfpRouteBuilderModal._internal
    const plannerResult = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR", candidates: candidates(), spec: SPEC,
        config: {includedIatas: ["DUB", "JFK", "HND"], targetFlights: 6,
                 baseDeparture: "06:00", sequentialLongHaul: true}
    })
    const payload = I.buildApplyPayload({
        server: "free1", aircraftId: "22092", hub: "LHR",
        plannerResult, draft: null
    })
    console.log("    ctx:    ", JSON.stringify(payload.ctx))
    console.log("    source: ", payload.source)
    console.log("    legs:   ", payload.legs.length, "(every one has origin+dest+depTime+dayMask)")
    for (const leg of payload.legs) {
        const dayIdx = leg.dayMask.findIndex(Boolean)
        console.log("            seq=" + leg.seq + " " + (leg.direction || "?").padEnd(8)
            + " " + leg.origin + " -> " + leg.destination
            + " day=" + dayIdx + " dep=" + leg.depTime)
    }
}

console.log("\nroute-builder-modal-controller: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)

})()
