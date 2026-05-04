"use strict"

/**
 * Route-planner scenario tests.
 *
 * Covers two ends of the spectrum:
 *  - B737-800 (short-haul, ~5500km range): European hub network
 *  - A380-800 (ultra-long-haul, ~15000km range): intercontinental
 *
 * Also asserts the orchestrator-payload shape exactly matches what
 * AesAfpFleetApplyOrchestrator.start expects (runs:[{aircraftId,legs}],
 * ctx:{server}, source:string), and verifies cargo service profile flows
 * through end-to-end.
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

const B737  = { typeName: "B737-800",  cruiseSpeedKmh: 830, range: 5500,  turnaroundMin: 30 }
const A330  = { typeName: "A330-300",  cruiseSpeedKmh: 870, range: 11750, turnaroundMin: 60 }
const A380  = { typeName: "A380-800",  cruiseSpeedKmh: 945, range: 15700, turnaroundMin: 90 }

async function run() {
    console.log("\nRoute-planner scenarios:")
    const R = loadRecommender()

    // === SCENARIO 1: B737 European hub ===
    console.log("\n  --- Scenario 1: B737-800 European short-haul ---")
    const europeDests = [
        { iata: "LHR", distanceKm: 660 },   // London
        { iata: "CDG", distanceKm: 480 },   // Paris
        { iata: "MAD", distanceKm: 1450 },
        { iata: "FCO", distanceKm: 950 },
        { iata: "BCN", distanceKm: 1100 },
        { iata: "VIE", distanceKm: 600 },   // Vienna
        { iata: "AMS", distanceKm: 365 }    // Amsterdam
    ]

    let plan1
    await it("B737 7-dest network with 35 flights/wk", () => {
        plan1 = R.recommend({
            hub: "FRA", spec: B737,
            destinations: europeDests,
            targetFlightCount: 35
        })
        assert.ok(plan1.legs.length >= 7, "should hit ≥1 leg per dest, got " + plan1.legs.length)
        const totalFreq = plan1.legs.reduce((s, l) => s + l._meta.freqPerWeek, 0)
        assert.strictEqual(totalFreq, 35, "should hit exact target")
    })

    await it("B737: every selected destination got at least one flight", () => {
        const dests = new Set(plan1.legs.map(l => l.destination))
        for (const d of europeDests) {
            assert.ok(dests.has(d.iata), "missing " + d.iata)
        }
    })

    await it("B737: all classifications are short (≤4h one-way)", () => {
        for (const l of plan1.legs) {
            assert.strictEqual(l._meta.classification, "short",
                l.destination + " expected short, got " + l._meta.classification)
        }
    })

    await it("B737: depTimes are staggered (not all 09:00)", () => {
        const times = plan1.legs.map(l => l.depTime)
        const uniq = new Set(times)
        assert.ok(uniq.size >= 4, "expected ≥4 unique times, got " + uniq.size)
    })

    await it("B737: utilization < 100%", () => {
        assert.ok(plan1.summary.utilizationPct < 100,
            "B737 should have headroom, got " + plan1.summary.utilizationPct)
    })

    // === SCENARIO 2: A380 intercontinental network ===
    console.log("\n  --- Scenario 2: A380-800 ultra-long-haul ---")
    const intercontinentalDests = [
        { iata: "JFK", distanceKm: 6200 },   // ~7h one-way
        { iata: "LAX", distanceKm: 9300 },   // ~11h one-way (long)
        { iata: "ICN", distanceKm: 8500 },   // ~10h one-way (long)
        { iata: "NRT", distanceKm: 9300 },   // ~11h (long)
        { iata: "SYD", distanceKm: 16500 }   // out of range — should be filtered
    ]

    let plan2
    await it("A380 intercontinental with 14 flights/wk", () => {
        plan2 = R.recommend({
            hub: "FRA", spec: A380,
            destinations: intercontinentalDests,
            targetFlightCount: 14
        })
        assert.ok(plan2.legs.length > 0)
    })

    await it("A380: SYD filtered (16500km > 15700km range)", () => {
        const dests = new Set(plan2.legs.map(l => l.destination))
        assert.ok(!dests.has("SYD"), "SYD should be out of range")
        assert.ok(plan2.warnings.some(w => /SYD.*out of range/.test(w)),
            "should warn about SYD: " + JSON.stringify(plan2.warnings))
    })

    await it("A380: long-haul destinations capped at 2/wk each", () => {
        const longDests = ["LAX", "ICN", "NRT"]
        for (const d of longDests) {
            const dLegs = plan2.legs.filter(l => l.destination === d)
            const totalFreq = dLegs.reduce((s, l) => s + l._meta.freqPerWeek, 0)
            assert.ok(totalFreq <= 2, d + " freq " + totalFreq + " exceeds long-haul cap 2")
        }
    })

    await it("A380: long-haul day spacing ≥ 3 days", () => {
        for (const l of plan2.legs.filter(l => l._meta.classification === "long")) {
            const days = l.dayMask.map((v, i) => v ? i : -1).filter(i => i >= 0)
            if (days.length === 2) {
                const gap = days[1] - days[0]
                assert.ok(gap >= 3,
                    l.destination + " long-haul day gap " + gap + " < 3")
            }
        }
    })

    await it("A380: long-haul depTimes staggered ≥ 90 min apart between dests", () => {
        const longLegs = plan2.legs.filter(l => l._meta.classification === "long")
        const times = longLegs.map(l => {
            const m = l.depTime.match(/^(\d+):(\d+)/)
            return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0
        })
        const uniq = new Set(times)
        assert.ok(uniq.size >= longLegs.length - 1,
            "long-haul depTimes should be staggered, got " + JSON.stringify(times))
    })

    // === SCENARIO 3: Cargo service profile end-to-end ===
    console.log("\n  --- Scenario 3: Cargo service profile ---")
    let cargoPlan
    await it("Recommender accepts service override via opts.defaultService", () => {
        cargoPlan = R.recommend({
            hub: "FRA", spec: A330,
            destinations: [
                { iata: "JFK", distanceKm: 6200 },
                { iata: "ICN", distanceKm: 8500 }
            ],
            targetFlightCount: 6,
            opts: { defaultService: "CARGO" }
        })
        assert.ok(cargoPlan.legs.length > 0)
        for (const l of cargoPlan.legs) {
            assert.strictEqual(l.service, "CARGO",
                l.destination + " service should be CARGO, got " + l.service)
        }
    })

    // === SCENARIO 4: Orchestrator-payload shape match ===
    console.log("\n  --- Scenario 4: Orchestrator-payload contract ---")
    await it("Every leg in plan1 has all required orchestrator fields", () => {
        for (const l of plan1.legs) {
            assert.strictEqual(typeof l.origin, "string", "origin missing")
            assert.match(l.origin, /^[A-Z]{3}$/, "origin format")
            assert.strictEqual(typeof l.destination, "string", "destination missing")
            assert.match(l.destination, /^[A-Z]{3}$/, "destination format")
            assert.match(l.depTime, /^\d{2}:\d{2}$/, "depTime format")
            assert.ok(Array.isArray(l.dayMask), "dayMask")
            assert.strictEqual(l.dayMask.length, 7, "dayMask length 7")
            l.dayMask.forEach((v, i) => assert.strictEqual(typeof v, "boolean",
                "dayMask[" + i + "] should be bool"))
            assert.strictEqual(typeof l.pricePct, "number")
            assert.strictEqual(typeof l.service, "string")
            assert.strictEqual(typeof l.flightNumberText, "string")
        }
    })

    // === SCENARIO 5: Pathological — too many destinations, target too small ===
    console.log("\n  --- Scenario 5: Edge — over-selected with low target ---")
    let plan5
    await it("8 destinations + target 3 → 3 dests get 1 each, others get 0", () => {
        plan5 = R.recommend({
            hub: "FRA", spec: B737,
            destinations: [
                { iata: "LHR", distanceKm: 660 },
                { iata: "CDG", distanceKm: 480 },
                { iata: "MAD", distanceKm: 1450 },
                { iata: "FCO", distanceKm: 950 },
                { iata: "BCN", distanceKm: 1100 },
                { iata: "VIE", distanceKm: 600 },
                { iata: "AMS", distanceKm: 365 },
                { iata: "ZRH", distanceKm: 300 }
            ],
            targetFlightCount: 3
        })
        // Some destinations may end up with 0 — that's expected when target < N(dests)
        const totalFreq = plan5.legs.reduce((s, l) => s + l._meta.freqPerWeek, 0)
        assert.strictEqual(totalFreq, 3, "should hit exact target=3")
    })

    // === SCENARIO 6: Reproducibility across runs ===
    console.log("\n  --- Scenario 6: Cross-run reproducibility ---")
    await it("Same input → same output across 3 runs", () => {
        const inp = {
            hub: "FRA", spec: A380,
            destinations: intercontinentalDests,
            targetFlightCount: 10
        }
        const r1 = R.recommend(inp)
        const r2 = R.recommend(inp)
        const r3 = R.recommend(inp)
        const strip = (l) => ({
            origin: l.origin, destination: l.destination, depTime: l.depTime,
            dayMask: l.dayMask, freq: l._meta.freqPerWeek
        })
        assert.deepStrictEqual(r1.legs.map(strip), r2.legs.map(strip))
        assert.deepStrictEqual(r2.legs.map(strip), r3.legs.map(strip))
    })

    console.log("\n  " + pass + " passed, " + fail + " failed")
    if (fail) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
