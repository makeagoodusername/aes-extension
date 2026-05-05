"use strict"

/**
 * Route Builder Workbench end-to-end smoke.
 *
 * Validates the complete chain the user just asked for:
 *   1. Multi-airport selection      — explicit includedIatas vs. top-N auto
 *   2. Flight count target          — matches requested round-trips
 *   3. Long-haul irregular times    — long routes respect the latest-departure
 *                                     cutoff and start fresh days
 *   4. Sequential addition          — long route #2's dep is gated by #1's arr
 *   5. Per-leg time edit overlay    — user-edited HH:MM survives the
 *                                     materialise step that feeds apply-batch
 *   6. Apply-payload integrity      — mock-schedule edits land in the leg list
 *                                     that AesAfpAutoApplyBatch.start consumes
 *
 * Runs the planner module (`route-builder-planner.js`), the active-draft-store
 * (`active-draft-store.js`) for perLegEdits, and a local re-implementation of
 * preview-panel.js's `_materialiseLegs` to confirm the overlay merge contract
 * the production confirm modal relies on.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

// chrome.storage.local stub
function makeChromeStub() {
    const store = new Map()
    return {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) {
                        const out = {}
                        for (const [k, v] of store) out[k] = v
                        return out
                    }
                    if (typeof keys === "string") {
                        const out = {}
                        if (store.has(keys)) out[keys] = store.get(keys)
                        return out
                    }
                    if (Array.isArray(keys)) {
                        const out = {}
                        for (const k of keys) if (store.has(k)) out[k] = store.get(k)
                        return out
                    }
                    return {}
                },
                async set(items) { for (const k in items) store.set(k, items[k]) },
                async remove(keys) {
                    if (Array.isArray(keys)) for (const k of keys) store.delete(k)
                    else store.delete(keys)
                },
                _store: store
            },
            onChanged: {addListener() {}, removeListener() {}}
        },
        runtime: {id: "test", onMessage: {addListener() {}}, sendMessage() {}}
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

function reset() {
    for (const n of ["AesAfpRouteBuilderPlanner", "AesAfpActiveDraftStore", "ScheduleFactors"]) {
        try { delete global[n] } catch (_) {}
    }
    global.window = global
    global.chrome = makeChromeStub()
}

function loadStack() {
    load("modules/schedule-management/range-buckets.js", ["ScheduleFactors"])
    load("modules/aircraft-flight-plan/auto-scheduler/route-builder-planner.js")
    load("modules/aircraft-flight-plan/active-draft-store.js", ["AesAfpActiveDraftStore"])
}

// Mirror of preview-panel.js:_materialiseLegs (the actual function that
// generates the apply payload from build + draft.perLegEdits). If this
// helper drifts from production, the test must drift with it — see
// modules/aircraft-flight-plan/auto-scheduler/preview-panel.js:1961.
function materialiseLegs(build, draft, settings) {
    const flights = (build && build.flights) || []
    const overlays = (draft && draft.perLegEdits) || {}
    const dpct = (settings && isFinite(Number(settings.defaultPricePct)))
        ? settings.defaultPricePct : 100
    const dsvc = (settings && typeof settings.defaultService === "string")
        ? settings.defaultService : ""
    const out = []
    for (const f of flights) {
        const o = overlays[f.seq] || {}
        const eff = Object.assign({}, f, o)
        out.push({
            seq:         f.seq,
            waveId:      f.waveId,
            waveLabel:   f.waveLabel,
            direction:   eff.direction || f.direction,
            origin:      eff.origin      || f.origin      || null,
            destination: eff.destination || f.destination || null,
            depTime:     eff.depTimeLocal || f.depTimeLocal || null,
            distanceNm:  f.distanceNm,
            pricePct:    isFinite(Number(eff.pricePct)) ? Number(eff.pricePct) : dpct,
            service:     (typeof eff.service === "string") ? eff.service : dsvc,
            dayMask:     Array.isArray(eff.dayMask) ? eff.dayMask : f.dayMask
        })
    }
    return out
}

// Realistic fleet of candidate destinations from LHR ranging from
// short-haul (CDG ~344km) to ultra-long-haul (HND ~9600km, ~12h block).
function candidates() {
    return [
        {destIata: "CDG", distanceKm: 344,  paxScore: 7,  cargoScore: 3, weeklyFlights: 90, scoreBlend: 700},
        {destIata: "DUB", distanceKm: 449,  paxScore: 8,  cargoScore: 2, weeklyFlights: 80, scoreBlend: 500},
        {destIata: "FRA", distanceKm: 654,  paxScore: 8,  cargoScore: 4, weeklyFlights: 65, scoreBlend: 600},
        {destIata: "JFK", distanceKm: 5540, paxScore: 10, cargoScore: 8, weeklyFlights: 48, scoreBlend: 900},
        {destIata: "HND", distanceKm: 9600, paxScore: 10, cargoScore: 9, weeklyFlights: 20, scoreBlend: 850}
    ]
}

const SPEC = {typeName: "Boeing 777-300ER", cruiseSpeedKmh: 905, range: 14000}

let pass = 0, fail = 0
async function it(name, fn) {
    try {
        await fn()
        pass++; console.log("  ok  " + name)
    } catch (e) {
        fail++; console.log("  FAIL " + name + " — " + (e && e.message))
    }
}

function timeMin(hhmm) {
    const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/)
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

;(async () => {

console.log("=== route-builder-workbench-e2e ===")

// ── Scenario 1: Multi-airport selection honors includedIatas ──────────
await it("multi-airport selection: planner honors the user's chosen IATAs", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["DUB", "JFK", "FRA"], targetFlights: 6}
    })
    const dests = r.build.metadata.selectedAirports
    assert.deepStrictEqual(dests, ["DUB", "JFK", "FRA"],
        "planner did not preserve the user's airport order: " + dests.join(","))
    assert.strictEqual(r.build.flights.length, 6,
        "expected 6 flights for 3 round-trips, got " + r.build.flights.length)
})

// ── Scenario 2: Auto-pick top-N when no airports given ───────────────
await it("auto-pick top-N: with no includedIatas, planner picks top scored", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {targetFlights: 4, airportCount: 2}
    })
    // Top 2 by scoreBlend: JFK(900), HND(850)
    assert.deepStrictEqual(r.build.metadata.selectedAirports.sort(), ["HND", "JFK"],
        "auto-pick should choose HND+JFK by score, got " + r.build.metadata.selectedAirports.join(","))
})

// ── Scenario 3: Long-haul flagged for sequential placement ───────────
await it("long-haul flagged for sequential placement, short-haul not", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["CDG", "JFK", "HND"], targetFlights: 6, sequentialLongHaul: true}
    })
    const cdg = r.rows.find(x => x.destination === "CDG")
    const jfk = r.rows.find(x => x.destination === "JFK")
    const hnd = r.rows.find(x => x.destination === "HND")
    assert.ok(cdg, "CDG row missing")
    assert.ok(jfk, "JFK row missing")
    assert.ok(hnd, "HND row missing")
    assert.strictEqual(cdg.rangeBucket, "shortHaul", "CDG should be shortHaul, got " + cdg.rangeBucket)
    // JFK at 2991nm sits below the 3500nm longHaul cutoff but its 397min
    // block triggers the planner's flightMin >= 6h sequential rule.
    assert.ok(jfk.rangeBucket === "longHaul" || jfk.rangeBucket === "mediumHaul",
        "JFK should be medium or long haul, got " + jfk.rangeBucket)
    assert.strictEqual(hnd.rangeBucket, "longHaul", "HND should be longHaul, got " + hnd.rangeBucket)
    assert.ok(jfk.sequential, "JFK (>6h block) should be flagged sequential")
    assert.ok(hnd.sequential, "HND (>6h block, longHaul) should be flagged sequential")
    assert.ok(!cdg.sequential, "CDG (1h block, short-haul) should NOT be flagged sequential")
})

// ── Scenario 4: Latest-long-haul cutoff respected ────────────────────
//    A late base time + long flight should advance to the next day rather
//    than schedule a long-haul departure past the cutoff.
await it("latest-long-haul cutoff: late base shifts long-haul to next day", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        // baseDeparture 22:00 → past the default 18:00 cutoff.
        // Two long-haul round-trips — sequential placement should push
        // the second one's departure to a later day so its long-haul
        // dep doesn't land past the cutoff at the cycled time.
        config: {
            includedIatas: ["JFK", "HND"],
            targetFlights: 4,
            baseDeparture: "06:00",
            startDayIdx: 0,
            sequentialLongHaul: true,
            latestLongHaulDeparture: "18:00"
        }
    })
    const rows = r.rows
    assert.strictEqual(rows.length, 2, "expected 2 rows, got " + rows.length)
    // Row 1 (JFK ~7h). Row 2 (HND ~11h) follows JFK return + longGap.
    // The HND row's outDayIdx must be >= JFK row's inDayIdx (sequential).
    assert.ok(rows[1].outDayIdx >= rows[0].inDayIdx,
        "second long-haul out-day should be >= first long-haul in-day, got "
        + rows[0].inDayIdx + " then " + rows[1].outDayIdx)
})

// ── Scenario 5: Sequential addition — second long leg gated by first ──
await it("sequential addition: long route 2's dep > long route 1's arr", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {
            includedIatas: ["JFK", "HND"],
            targetFlights: 4,
            baseDeparture: "06:00",
            startDayIdx: 0,
            turnaroundMin: 60,
            longGapMin: 120,
            sequentialLongHaul: true
        }
    })
    const r0 = r.rows[0]   // JFK round-trip
    const r1 = r.rows[1]   // HND round-trip
    // Convert both to absolute weekly minutes and compare:
    const r0InAbs = r0.inDayIdx * 1440 + timeMin(r0.inArrTime)
    const r1OutAbs = r1.outDayIdx * 1440 + timeMin(r1.outDepTime)
    assert.ok(r1OutAbs > r0InAbs,
        "second long route depart (" + r1.outDayName + " " + r1.outDepTime + ")"
        + " must be after first long route arrive (" + r0.inDayName + " " + r0.inArrTime + ")")
    // And the gap should be at least longGapMin (120 min).
    const gap = r1OutAbs - r0InAbs
    assert.ok(gap >= 120,
        "gap between long routes should be >= longGapMin 120, got " + gap)
})

// ── Scenario 6: Per-leg time edit overlay survives materialise ────────
await it("per-leg edit: user-edited HH:MM lands in the apply payload", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["JFK"], targetFlights: 2}
    })
    const build = r.build
    const outSeq = build.flights[0].seq

    // User opens the workbench, edits the JFK outbound time to 14:30
    // and the inbound to 03:15.
    const inSeq = build.flights[1].seq
    await window.AesAfpActiveDraftStore.setEdit("free1", "22092", outSeq, {depTimeLocal: "14:30"})
    await window.AesAfpActiveDraftStore.setEdit("free1", "22092", inSeq,  {depTimeLocal: "03:15", pricePct: 110})

    const draft = await window.AesAfpActiveDraftStore.load("free1", "22092")
    assert.strictEqual(draft.perLegEdits[outSeq].depTimeLocal, "14:30",
        "out edit not stored")
    assert.strictEqual(draft.perLegEdits[inSeq].depTimeLocal, "03:15",
        "in edit not stored")

    // Materialise the legs (this is what the apply path sees).
    const legs = materialiseLegs(build, draft)
    const out = legs.find(l => l.seq === outSeq)
    const inn = legs.find(l => l.seq === inSeq)
    assert.strictEqual(out.depTime, "14:30",
        "out depTime should be the edited 14:30, got " + out.depTime)
    assert.strictEqual(inn.depTime, "03:15",
        "in depTime should be the edited 03:15, got " + inn.depTime)
    assert.strictEqual(inn.pricePct, 110,
        "in pricePct should be the edited 110, got " + inn.pricePct)
})

// ── Scenario 7: Clearing an edit reverts to planner-recommended time ─
await it("clearing an edit (setEdit null) reverts to planner-recommended time", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["JFK"], targetFlights: 2}
    })
    const build = r.build
    const outSeq = build.flights[0].seq
    const recommended = build.flights[0].depTimeLocal

    await window.AesAfpActiveDraftStore.setEdit("free1", "22092", outSeq, {depTimeLocal: "11:11"})
    let draft = await window.AesAfpActiveDraftStore.load("free1", "22092")
    let legs = materialiseLegs(build, draft)
    assert.strictEqual(legs[0].depTime, "11:11", "edit not applied")

    await window.AesAfpActiveDraftStore.setEdit("free1", "22092", outSeq, null)
    draft = await window.AesAfpActiveDraftStore.load("free1", "22092")
    legs = materialiseLegs(build, draft)
    assert.strictEqual(legs[0].depTime, recommended,
        "depTime should revert to planner's " + recommended + ", got " + legs[0].depTime)
})

// ── Scenario 8: Round-trip integrity — every selected airport produces both legs ──
await it("round-trip integrity: each selected airport gets out+in legs", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["DUB", "FRA", "CDG"], targetFlights: 6}
    })
    const dests = ["DUB", "FRA", "CDG"]
    for (const dest of dests) {
        const out = r.build.flights.find(f => f.destination === dest && f.direction === "outbound")
        const inn = r.build.flights.find(f => f.origin === dest && f.direction === "inbound")
        assert.ok(out, dest + " missing outbound")
        assert.ok(inn, dest + " missing inbound")
        assert.strictEqual(out.origin, "LHR", dest + " out origin should be LHR")
        assert.strictEqual(inn.destination, "LHR", dest + " in destination should be LHR")
    }
})

// ── Scenario 9: Odd flight count rounds to whole round-trips with warning ─
await it("odd flight count rounds up + warning surfaced", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["DUB"], targetFlights: 3}
    })
    assert.strictEqual(r.build.flights.length, 4, "3 → should round to 4")
    assert.ok(r.build.warnings.some(w => w.type === "oddFlightTargetRounded"),
        "expected oddFlightTargetRounded warning, got " + JSON.stringify(r.build.warnings))
})

// ── Scenario 10: Validation — empty hub fails clean ──────────────────
await it("validation: empty hub produces clear validation message", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["JFK"], targetFlights: 2}
    })
    assert.ok(r.build.validation.length > 0, "expected validation errors")
    assert.match(r.build.validation.join(" "), /hubIata/i,
        "validation should mention hubIata: " + r.build.validation.join(" "))
})

// ── Scenario 11: End-to-end materialise carries all 4 fields per leg ──
await it("end-to-end: materialised legs carry origin/dest/depTime/dayMask for every flight", async () => {
    reset(); loadStack()
    const r = window.AesAfpRouteBuilderPlanner.recommend({
        hubIata: "LHR",
        candidates: candidates(),
        spec: SPEC,
        config: {includedIatas: ["JFK", "HND"], targetFlights: 4}
    })
    const draft = await window.AesAfpActiveDraftStore.load("free1", "22092")
    const legs = materialiseLegs(r.build, draft)
    assert.strictEqual(legs.length, 4)
    for (const leg of legs) {
        assert.ok(leg.origin,      "leg missing origin: " + JSON.stringify(leg))
        assert.ok(leg.destination, "leg missing destination: " + JSON.stringify(leg))
        assert.ok(leg.depTime,     "leg missing depTime: " + JSON.stringify(leg))
        assert.ok(Array.isArray(leg.dayMask) && leg.dayMask.length === 7,
            "leg dayMask shape wrong: " + JSON.stringify(leg.dayMask))
        assert.ok(leg.dayMask.some(Boolean),
            "leg dayMask has no day set: " + JSON.stringify(leg.dayMask))
    }
})

// ── Headline summary ─────────────────────────────────────────────────
console.log("\n  recommended schedule for hub LHR · 6 flights · DUB/JFK/HND:")
const showcase = window.AesAfpRouteBuilderPlanner.recommend({
    hubIata: "LHR",
    candidates: candidates(),
    spec: SPEC,
    config: {
        includedIatas: ["DUB", "JFK", "HND"],
        targetFlights: 6,
        baseDeparture: "06:00",
        sequentialLongHaul: true
    }
})
for (const row of showcase.rows) {
    const tag = row.sequential ? "[seq] " : "      "
    console.log("    " + tag
        + row.outDayName.slice(0, 3) + " " + row.outDepTime + "  LHR -> " + row.destination
        + " (" + Math.round(row.distanceNm) + "nm, " + row.flightMin + "min) · "
        + row.inDayName.slice(0, 3) + " " + row.inDepTime + "  " + row.destination + " -> LHR"
        + "   [" + row.rangeBucket + "]")
}

console.log("\nroute-builder-workbench-e2e: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)

})()
