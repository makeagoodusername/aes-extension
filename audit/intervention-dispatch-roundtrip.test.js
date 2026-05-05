"use strict"

/**
 * K11.2 lockdown — fork→dispatch composer round-trip.
 *
 * Stage 2 of the slice/e-integration "next-layer informational
 * organisation" wave. Verifies that:
 *
 *   1. composeFromIntervention validates against intervention-types
 *   2. valid interventions persist to KEY_INTV (sibling slot to KEY)
 *   3. readPendingIntervention round-trips the payload
 *   4. clearPendingIntervention zeroes it
 *   5. invalid interventions return null without writing
 *   6. the price-move slot (KEY) is NOT touched
 *   7. the bus emits TOPIC_INTV with the small-payload contract
 *
 * Lives at audit/ root (sibling to settings-bridge.test.js) because
 * audit/tests/strategy/ is currently root-owned by a parallel agent's
 * process; this test is independent and stand-alone.
 *
 * Run from project root:
 *   node audit/intervention-dispatch-roundtrip.test.js
 */

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

let pass = 0, fail = 0
async function it(name, fn) {
    try { await fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
    }
}
function summary(label) {
    console.log("\n" + label + ": " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
}

function makeFakeStorage() {
    const store = new Map()
    return {
        store: store,
        get(keys) {
            const out = {}
            const arr = Array.isArray(keys) ? keys : [keys]
            for (const k of arr) if (store.has(k)) out[k] = store.get(k)
            return Promise.resolve(out)
        },
        set(obj) {
            for (const k of Object.keys(obj)) store.set(k, obj[k])
            return Promise.resolve()
        },
        remove(keys) {
            const arr = Array.isArray(keys) ? keys : [keys]
            for (const k of arr) store.delete(k)
            return Promise.resolve()
        }
    }
}

function evalInto(window, relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    global.window = window
    eval(src)
}

;(async function main() {
    const storage = makeFakeStorage()
    const busLog = []
    const fakeBus = {emit(topic, hint) { busLog.push({topic, hint}) }}

    global.chrome = {storage: {local: storage}}
    const window = {AesDataBus: fakeBus}

    evalInto(window, "modules/strategy/intervention-types.js")
    evalInto(window, "modules/strategy/decision-dispatch.js")

    const dispatch = window.AesStrategyDecisionDispatch
    assert.ok(dispatch, "AesStrategyDecisionDispatch exposed on window")
    assert.equal(typeof dispatch.composeFromIntervention, "function",
        "composeFromIntervention is a function")
    assert.equal(dispatch.KEY_INTV,   "aesStrategy:interventionPending", "KEY_INTV stable")
    assert.equal(dispatch.TOPIC_INTV, "data:strategy:intervention:pending", "TOPIC_INTV stable")

    await it("valid setWeight intervention persists + emits + returns dispatchId", async () => {
        const id = await dispatch.composeFromIntervention(
            {kind: "setWeight", name: "profitWeight", value: 0.5},
            {originForkId: "fk-test", reason: "smoke"}
        )
        assert.ok(typeof id === "string", "returns string id")
        assert.ok(/^intv:fk-test:\d+$/.test(id), "id matches intv:<fork>:<ts> shape, got " + id)

        const read = await dispatch.readPendingIntervention()
        assert.ok(read, "readPendingIntervention returns payload")
        assert.equal(read.dispatchId, id,                              "round-trips dispatchId")
        assert.equal(read.intervention.kind, "setWeight",              "intervention shape preserved")
        assert.equal(read.intervention.name, "profitWeight",           "intervention.name preserved")
        assert.equal(read.intervention.value, 0.5,                     "intervention.value preserved")
        assert.equal(read.originForkId, "fk-test",                     "originForkId preserved")
        assert.equal(read.reason, "smoke",                             "reason preserved")
        assert.equal(read.source, "counterfactual-lab",                "source defaults to counterfactual-lab")
        assert.equal(read.applied, false,                              "applied: false (two-gate preserved)")
        assert.equal(typeof read.summary, "string",                    "summary populated by types.summarize")

        const last = busLog[busLog.length - 1]
        assert.ok(last,                                                "bus emit fired")
        assert.equal(last.topic, "data:strategy:intervention:pending", "bus topic is TOPIC_INTV")
        assert.equal(last.hint.dispatchId, id,                         "hint carries dispatchId")
        assert.equal(last.hint.kind, "setWeight",                      "hint carries kind")
        assert.equal(last.hint.originForkId, "fk-test",                "hint carries originForkId")
    })

    await it("price-move slot KEY is NOT touched (sibling-slot invariant)", async () => {
        const moveSlot = storage.store.get(dispatch.KEY)
        assert.strictEqual(moveSlot, undefined,
            "price-move pending slot stayed empty; got " + JSON.stringify(moveSlot))
    })

    await it("clearPendingIntervention zeroes the slot", async () => {
        await dispatch.clearPendingIntervention()
        const read = await dispatch.readPendingIntervention()
        assert.strictEqual(read, null, "slot cleared")
    })

    await it("invalid intervention (bad kind) returns null + no write + no emit", async () => {
        const before = busLog.length
        const id = await dispatch.composeFromIntervention(
            {kind: "garbage", name: "x"}, {originForkId: "fk-bad"}
        )
        assert.strictEqual(id, null, "rejected intervention returns null")
        const read = await dispatch.readPendingIntervention()
        assert.strictEqual(read, null, "no intervention payload persisted")
        assert.equal(busLog.length, before, "no bus emit fired for invalid intervention")
    })

    await it("invalid intervention (out-of-range setWeight value) returns null", async () => {
        const id = await dispatch.composeFromIntervention(
            {kind: "setWeight", name: "profitWeight", value: 99},
            {originForkId: "fk-bad"}
        )
        assert.strictEqual(id, null, "out-of-range value rejected")
    })

    await it("missing ctx → defaults originForkId to 'anon'", async () => {
        await dispatch.clearPendingIntervention()
        const id = await dispatch.composeFromIntervention(
            {kind: "dropRoute", hub: "FRA", dest: "JFK"}, undefined
        )
        assert.ok(id, "still composes without ctx")
        assert.ok(/^intv:anon:\d+$/.test(id), "id falls back to intv:anon:<ts>, got " + id)
    })

    summary("intervention-dispatch-roundtrip (K11.2)")
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
