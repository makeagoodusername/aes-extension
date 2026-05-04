"use strict"

/**
 * Route-planner recommender — comprehensive smoke.
 *
 * Tests:
 *  • Empty / invalid inputs are rejected gracefully
 *  • Short-haul mix → daily/multi-daily frequency
 *  • Long-haul mix → 1-2 freq/week, sequential days
 *  • Mixed network (short + medium + long)
 *  • Out-of-range destinations are filtered
 *  • Utilization warning fires near 100%
 *  • dayMask spreads evenly
 *  • Time stagger separates rotations
 *  • Weight bias works
 *  • Pure: no DOM, no chrome — load module twice, output identical
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

function loadRecommender() {
    delete global.window
    global.window = {}
    const src = fs.readFileSync(path.join(ROOT, "modules/aircraft-flight-plan/route-planner/recommender.js"), "utf8")
    eval(src)
    return global.window.AesAfpRoutePlannerRecommender
}

const A330 = { cruiseSpeedKmh: 870, range: 13000, turnaroundMin: 60 }
const B737 = { cruiseSpeedKmh: 830, range: 5500, turnaroundMin: 30 }

async function run() {
    console.log("\nRoute-planner recommender smoke:")

    const R = loadRecommender()

    await it("module exposes recommend()", () => {
        assert.strictEqual(typeof R.recommend, "function")
        assert.strictEqual(typeof R._classify, "function")
        assert.strictEqual(typeof R._spreadDayMask, "function")
    })

    // --- Input validation ---
    await it("empty input → no legs, warning", () => {
        const r = R.recommend({})
        assert.strictEqual(r.legs.length, 0)
        assert.ok(r.warnings.length > 0)
    })

    await it("invalid hub IATA → rejected", () => {
        const r = R.recommend({hub: "FRANKFURT", spec: A330,
            destinations: [{iata: "JFK", distanceKm: 6200}]})
        assert.strictEqual(r.legs.length, 0)
        assert.match(r.warnings[0], /invalid hub/)
    })

    await it("no destinations → no legs", () => {
        const r = R.recommend({hub: "FRA", spec: A330, destinations: []})
        assert.strictEqual(r.legs.length, 0)
    })

    await it("destinations with bad distance filtered", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 7,
            destinations: [
                {iata: "JFK", distanceKm: 6200},
                {iata: "BAD", distanceKm: NaN},
                {iata: "ZZZ", distanceKm: 0}
            ]})
        assert.ok(r.legs.length >= 1, "should still emit legs for valid dest")
        // Only JFK is a destination in the legs
        const dests = new Set(r.legs.map(l => l.destination))
        assert.ok(dests.has("JFK"))
        assert.ok(!dests.has("BAD"))
        assert.ok(!dests.has("ZZZ"))
    })

    // --- Classification ---
    await it("classify short/medium/long correctly", () => {
        // 4h threshold short, 9h threshold long
        assert.strictEqual(R._classify(2, R.DEFAULTS), "short")
        assert.strictEqual(R._classify(4, R.DEFAULTS), "short")
        assert.strictEqual(R._classify(6, R.DEFAULTS), "medium")
        assert.strictEqual(R._classify(9, R.DEFAULTS), "long")
        assert.strictEqual(R._classify(15, R.DEFAULTS), "long")
    })

    // --- DayMask spreading ---
    await it("dayMask spreads frequency evenly", () => {
        const m1 = R._spreadDayMask(1, 0)
        assert.strictEqual(m1.filter(Boolean).length, 1)
        const m2 = R._spreadDayMask(2, 0)
        assert.strictEqual(m2.filter(Boolean).length, 2)
        // For freq=2 evenly spaced: gap should be ~3 days
        const idx2 = m2.map((v, i) => v ? i : -1).filter(i => i >= 0)
        assert.strictEqual(idx2[0], 0)
        assert.ok(idx2[1] >= 3, "2nd day at least 3 apart, got " + idx2[1])
        const m7 = R._spreadDayMask(7, 0)
        assert.strictEqual(m7.filter(Boolean).length, 7, "freq=7 fills all days")
        const m9 = R._spreadDayMask(9, 0)
        assert.strictEqual(m9.filter(Boolean).length, 7, "freq>7 saturates")
    })

    // --- Short-haul rotation ---
    await it("short-haul (1500km) → daily or near-daily", () => {
        const r = R.recommend({hub: "FRA", spec: B737, targetFlightCount: 7,
            destinations: [{iata: "MAD", distanceKm: 1450}]})
        assert.ok(r.legs.length >= 1)
        const totalFreq = r.legs.reduce((s, l) => s + l._meta.freqPerWeek, 0)
        assert.strictEqual(totalFreq, 7, "should hit 7 flights/wk")
        assert.strictEqual(r.legs[0]._meta.classification, "short")
    })

    await it("short-haul with target 14 → 2 rotations of freq=7 each", () => {
        const r = R.recommend({hub: "FRA", spec: B737, targetFlightCount: 14,
            destinations: [{iata: "MAD", distanceKm: 1450}]})
        const totalFreq = r.legs.reduce((s, l) => s + l._meta.freqPerWeek, 0)
        assert.strictEqual(totalFreq, 14)
        // Should be 2 separate legs (separate flight numbers) for the same dest
        const madLegs = r.legs.filter(l => l.destination === "MAD")
        assert.strictEqual(madLegs.length, 2, "should split into 2 FNs")
        // Different depTimes
        assert.notStrictEqual(madLegs[0].depTime, madLegs[1].depTime,
            "rotations should have staggered depTimes")
    })

    // --- Long-haul ---
    await it("long-haul (12000km) → freq capped at 2/week", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 7,
            destinations: [{iata: "ICN", distanceKm: 8500}]})  // ~10h one-way
        assert.ok(r.legs.length === 1, "long-haul = 1 FN")
        const leg = r.legs[0]
        assert.strictEqual(leg._meta.classification, "long")
        assert.ok(leg._meta.freqPerWeek <= 2, "long-haul cap 2/wk, got " + leg._meta.freqPerWeek)
    })

    await it("long-haul dayMask: enabled days spaced by ≥3", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 4,
            destinations: [{iata: "ICN", distanceKm: 8500}]})
        const leg = r.legs[0]
        const days = leg.dayMask.map((v, i) => v ? i : -1).filter(i => i >= 0)
        if (days.length === 2) {
            const gap = days[1] - days[0]
            assert.ok(gap >= 3, "long-haul day gap ≥ 3, got " + gap)
        }
    })

    // --- Mixed network ---
    await it("mixed short+medium+long network", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 14,
            destinations: [
                {iata: "MAD", distanceKm: 1450},   // short
                {iata: "JFK", distanceKm: 6200},   // medium
                {iata: "ICN", distanceKm: 8500}    // long
            ]})
        assert.ok(r.legs.length >= 3, "should emit at least one leg per dest")
        const byDest = {}
        for (const l of r.legs) {
            byDest[l.destination] = (byDest[l.destination] || 0) + l._meta.freqPerWeek
        }
        assert.ok(byDest.MAD > 0, "MAD should have flights")
        assert.ok(byDest.JFK > 0, "JFK should have flights")
        assert.ok(byDest.ICN > 0, "ICN should have flights")
        assert.ok(byDest.ICN <= 2, "ICN long-haul capped at 2")
    })

    // --- Range filter ---
    await it("destination beyond aircraft range filtered with warning", () => {
        const r = R.recommend({hub: "FRA", spec: B737, targetFlightCount: 7,
            destinations: [
                {iata: "MAD", distanceKm: 1450},
                {iata: "ICN", distanceKm: 8500}   // > B737 range 5500
            ]})
        const dests = new Set(r.legs.map(l => l.destination))
        assert.ok(dests.has("MAD"))
        assert.ok(!dests.has("ICN"), "ICN should be filtered (out of range)")
        assert.ok(r.warnings.some(w => /ICN.*out of range/.test(w)))
    })

    // --- Utilization warning ---
    await it("utilization near 100% emits warning", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 100,
            destinations: [
                {iata: "MAD", distanceKm: 1450},
                {iata: "FCO", distanceKm: 950}
            ]})
        assert.ok(r.warnings.some(w => /utilization/.test(w)))
        assert.ok(r.summary.utilizationPct >= 80,
            "utilization should be high, got " + r.summary.utilizationPct)
    })

    // --- Output shape ---
    await it("each leg has all required fields for orchestrator", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 5,
            destinations: [{iata: "MAD", distanceKm: 1450}, {iata: "JFK", distanceKm: 6200}]})
        for (const l of r.legs) {
            assert.strictEqual(typeof l.origin, "string")
            assert.strictEqual(typeof l.destination, "string")
            assert.strictEqual(typeof l.depTime, "string")
            assert.match(l.depTime, /^\d{2}:\d{2}$/)
            assert.ok(Array.isArray(l.dayMask))
            assert.strictEqual(l.dayMask.length, 7)
            assert.strictEqual(typeof l.pricePct, "number")
            assert.strictEqual(typeof l.service, "string")
        }
    })

    // --- Time stagger ---
    await it("multiple destinations get staggered depTimes", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 4,
            destinations: [
                {iata: "MAD", distanceKm: 1450},
                {iata: "FCO", distanceKm: 950},
                {iata: "BCN", distanceKm: 1100},
                {iata: "ATH", distanceKm: 1900}
            ]})
        const times = r.legs.map(l => l.depTime)
        const uniq = new Set(times)
        // Not all the same time
        assert.ok(uniq.size >= 2, "depTimes should be staggered, got " + JSON.stringify(times))
    })

    // --- Weight bias ---
    await it("weight bias allocates more flights to higher-weight dests", () => {
        const r = R.recommend({hub: "FRA", spec: B737, targetFlightCount: 14,
            destinations: [
                {iata: "MAD", distanceKm: 1450, weight: 3},   // 3x weight
                {iata: "FCO", distanceKm: 950,  weight: 1}
            ]})
        const byDest = {}
        for (const l of r.legs) {
            byDest[l.destination] = (byDest[l.destination] || 0) + l._meta.freqPerWeek
        }
        assert.ok(byDest.MAD > byDest.FCO,
            "MAD (weight 3) should get more flights than FCO (weight 1), got "
            + JSON.stringify(byDest))
    })

    // --- Determinism ---
    await it("output is deterministic across calls", () => {
        const inp = {hub: "FRA", spec: A330, targetFlightCount: 10,
            destinations: [
                {iata: "MAD", distanceKm: 1450},
                {iata: "JFK", distanceKm: 6200},
                {iata: "ICN", distanceKm: 8500}
            ]}
        const r1 = R.recommend(inp)
        const r2 = R.recommend(inp)
        assert.deepStrictEqual(r1.legs.map(_strip), r2.legs.map(_strip))
        function _strip(l) {
            return {origin: l.origin, destination: l.destination, depTime: l.depTime,
                    dayMask: l.dayMask, pricePct: l.pricePct, service: l.service,
                    freq: l._meta.freqPerWeek}
        }
    })

    // --- Summary ---
    await it("summary aggregates correctly", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 8,
            destinations: [
                {iata: "MAD", distanceKm: 1450},
                {iata: "FCO", distanceKm: 950}
            ]})
        const sum = r.summary
        assert.ok(sum.totalLegs > 0)
        assert.ok(sum.totalBlockHrs > 0)
        assert.ok(sum.utilizationPct >= 0 && sum.utilizationPct <= 100)
        assert.strictEqual(typeof sum.byDestination, "object")
    })

    // --- Edge: single dest, target=1 ---
    await it("target=1 produces exactly 1 flight", () => {
        const r = R.recommend({hub: "FRA", spec: A330, targetFlightCount: 1,
            destinations: [{iata: "JFK", distanceKm: 6200}]})
        const totalFreq = r.legs.reduce((s, l) => s + l._meta.freqPerWeek, 0)
        assert.strictEqual(totalFreq, 1)
    })

    console.log("\n  " + pass + " passed, " + fail + " failed")
    if (fail) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
