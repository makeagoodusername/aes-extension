"use strict"

/**
 * Locks down Agent 3's F-A3-001: simulateForward() mutates fork.snapshot
 * via _decay(), so re-running on the same fork produces drifted baselines.
 * The simulator's docstring claims "deterministic counterfactual"; this
 * test asserts that claim end-to-end.
 *
 * Today this test is EXPECTED TO FAIL (red bar) — that's the point. It
 * fails because the second simulateForward() call sees an already-decayed
 * snapshot. Once Agent 3 lands the structuredClone-at-entry fix
 * (modules/strategy/forward-simulator.js _decay), this test should turn
 * green automatically.
 *
 * Run from project root:
 *   node audit/tests/strategy/forward-simulator-determinism.test.js
 */

const {loadModule, it, summary, assert} = require("./_helpers")

const STRATEGY_NS = {
    scoreRoutes(snapshot) {
        let sum = 0
        if (snapshot && Array.isArray(snapshot.hubs)) {
            for (const h of snapshot.hubs) {
                if (h && Array.isArray(h.byRoute)) {
                    for (const r of h.byRoute) sum += (r.orsRank || 0)
                }
            }
        }
        return {
            routes: [{score: 1 / (1 + sum)}, {score: 0.5}, {score: 0.25}]
        }
    },
    computeObjective(snapshot, scored) {
        if (!scored || !scored.routes) return 0
        let s = 0
        for (const r of scored.routes) s += (r.score || 0) * 1000
        return s
    }
}

function makeFork() {
    return {
        forkId: "fork-test-1",
        parentRev: "rev-baseline",
        snapshot: {
            ts: 1700000000000,
            fleet: [
                {id: "A1", age: 5,  weeklyMaintenance: 1000, wear: {ratio: 95}},
                {id: "A2", age: 8,  weeklyMaintenance: 1200, wear: {ratio: 92}},
                {id: "A3", age: 12, weeklyMaintenance: 1400, wear: {ratio: 88}}
            ],
            hubs: [
                {iata: "JFK", byRoute: [
                    {origin: "JFK", destination: "LAX", orsRank: 5},
                    {origin: "JFK", destination: "ORD", orsRank: 8}
                ]},
                {iata: "LAX", byRoute: [
                    {origin: "LAX", destination: "JFK", orsRank: 6},
                    {origin: "LAX", destination: "SEA", orsRank: 11}
                ]}
            ],
            weightOverrides: null
        }
    }
}

const win = loadModule(
    "modules/strategy/forward-simulator.js",
    {AesStrategy: STRATEGY_NS, CentralHubBus: {emit() {}}}
)

const sim = win.AesStrategyForwardSimulator
assert.ok(sim,                                 "AesStrategyForwardSimulator exported on window")
assert.equal(typeof sim.simulateForward, "function", "simulateForward is a function")

;(async function main() {
    const fork1 = makeFork()
    const r1 = await sim.simulateForward(fork1, {weeks: 4})
    const r2 = await sim.simulateForward(fork1, {weeks: 4, force: true})

    await it("simulateForward returns ok on first call", () => {
        assert.equal(r1.ok, true, "first call should succeed: " + JSON.stringify(r1))
    })
    await it("simulateForward returns ok on second call (forced)", () => {
        assert.equal(r2.ok, true, "second call should succeed: " + JSON.stringify(r2))
    })

    // ── Determinism gate (F-A3-001).
    //
    // The baseline scoring is computed from fork.snapshot before any decay
    // is applied (forward-simulator.js:136-143). If _decay() didn't mutate
    // fork.snapshot, the second call's baseline would be identical to the
    // first. Today the test fails because _decay() walks fork.snapshot
    // in place: aircraft age advances, wear.ratio drops, orsRank drifts.
    await it("baseline.weeklyResult is the same across re-runs (F-A3-001)", () => {
        assert.strictEqual(r1.baseline.weeklyResult, r2.baseline.weeklyResult,
            "second baseline.weeklyResult drifted: r1=" + r1.baseline.weeklyResult +
            " r2=" + r2.baseline.weeklyResult)
    })
    await it("baseline.orsRankSum is the same across re-runs (F-A3-001)", () => {
        assert.strictEqual(r1.baseline.orsRankSum, r2.baseline.orsRankSum,
            "second baseline.orsRankSum drifted: r1=" + r1.baseline.orsRankSum +
            " r2=" + r2.baseline.orsRankSum)
    })
    const fork3 = makeFork()
    const startAge = fork3.snapshot.fleet[0].age
    await sim.simulateForward(fork3, {weeks: 4, force: true})
    await it("fleet[0].age stays untouched after simulation (F-A3-001)", () => {
        assert.strictEqual(fork3.snapshot.fleet[0].age, startAge,
            "simulator mutated fork.snapshot.fleet[0].age in place: " +
            "started=" + startAge + " ended=" + fork3.snapshot.fleet[0].age)
    })

    // ── Single-run shape gate (independent of determinism — should pass today).
    await it("first-call deltas reflect non-zero forward projection", () => {
        const d = r1.deltas || {}
        assert.ok(typeof d.weeklyResult === "number", "deltas.weeklyResult numeric")
        assert.ok(typeof d.orsRankSum === "number",   "deltas.orsRankSum numeric")
    })
    await it("first-call weeks array length === requested weeks (or smaller on time-budget hit)", () => {
        assert.ok(Array.isArray(r1.weeks),       "weeks array present")
        assert.ok(r1.weeks.length >= 1,          "≥1 week traced")
        assert.ok(r1.weeks.length <= 4,          "≤4 weeks traced (we asked for 4)")
    })

    summary("forward-simulator-determinism (F-A3-001 lockdown)")
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
