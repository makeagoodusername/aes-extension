"use strict"

const fs = require("fs")
const path = require("path")
const {it, summary, assert, ROOT} = require("../strategy/_helpers")

function evalModule(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
}

function makeStorage() {
    const data = {}
    return {
        data,
        async get(keys) {
            const out = {}
            for (const k of keys) out[k] = data[k]
            return out
        },
        async set(obj) {
            Object.assign(data, obj)
        },
        async remove(keys) {
            for (const k of keys) delete data[k]
        }
    }
}

function setup() {
    const listeners = {}
    const storage = makeStorage()
    global.window = {
        CentralHubBus: {
            on(topic, fn) { listeners[topic] = fn },
            emit() {}
        }
    }
    global.chrome = {
        storage: {local: storage},
        alarms: {
            create() {},
            onAlarm: {addListener() {}}
        }
    }
    evalModule("modules/conductor/baseline-store.js")
    evalModule("modules/conductor/baseline-driver.js")
    return {listeners, storage}
}

async function main() {
    await it("driver registers on conductor:signal and updates the scoped baseline store", async () => {
        const {listeners, storage} = setup()
        assert.strictEqual(typeof listeners["conductor:signal"], "function")

        listeners["conductor:signal"]({
            type: "cash.balance.changed",
            server: "free1",
            airline: "CFLAIR",
            payload: {to: 543339}
        })

        const key = "aesConductor:baselines:free1:CFLAIR"
        for (let i = 0; i < 10 && !storage.data[key]; i++) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        assert.ok(storage.data[key], "baseline blob written")
        assert.strictEqual(storage.data[key]["cash.balance:global:"].mean, 543339)
    })

    await it("driver maps route and ORS signals to route-scoped composites", async () => {
        setup()
        const d = window.AesConductorBaselineDriver

        assert.deepStrictEqual(d.emitsFor({
            type: "route.profit.changed",
            payload: {hub: "jfk", dest: "lhr", to: 12000}
        }), [["route.profit", "route", "JFK-LHR", 12000]])

        assert.deepStrictEqual(d.emitsFor({
            type: "ors.rank.changed",
            payload: {
                hub: "JFK",
                dest: "CDG",
                classes: [{rankTo: 3}, {rankTo: 5}, {rankTo: null}]
            }
        }), [["ors.rank.avg", "route", "JFK-CDG", 4]])
    })

    await it("baseline z-score remains conservative until the prior has enough samples", async () => {
        setup()
        const s = window.AesConductorBaselineStore
        let entry = null
        entry = s.step(entry, 100)
        entry = s.step(entry, 104)
        entry = s.step(entry, 108)
        assert.strictEqual(s.zOf(entry, 130), null)

        entry = s.step(entry, 112)
        assert.strictEqual(typeof s.zOf(entry, 130), "number")
    })

    summary("baseline-driver.test.js")
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
})
