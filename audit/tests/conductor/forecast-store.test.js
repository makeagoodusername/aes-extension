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
        async get(keys) { const out = {}; for (const k of keys) out[k] = data[k]; return out },
        async set(obj)  { Object.assign(data, obj) },
        async remove(k) { for (const x of (Array.isArray(k) ? k : [k])) delete data[x] }
    }
}

function fakeBus() {
    const subs = {}
    return {
        on(t, fn) { (subs[t] = subs[t] || []).push(fn) },
        emit(t, p) { for (const fn of (subs[t] || [])) try { fn(p) } catch (_) {} },
        subs
    }
}

function setup() {
    const storage = makeStorage()
    const bus = fakeBus()
    global.window = {CentralHubBus: bus}
    global.chrome = {storage: {local: storage}, alarms: {create() {}, onAlarm: {addListener() {}}}}

    evalModule("modules/conductor/signal-store.js")
    evalModule("modules/conductor/baseline-store.js")
    evalModule("modules/conductor/forecaster.js")

    // Tiny stub of AesConductorScenarios — single scenario declaring a
    // route-scoped wildcard forecast.
    window.AesConductorScenarios = {
        all: () => [{
            id: "ProfitDecay",
            forecast: [{metric: "route.profit", scope: "route", scopeId: "*",
                        horizonDays: 14, model: "linear"}]
        }]
    }
    evalModule("modules/conductor/forecast-store.js")
    return {storage, bus}
}

async function seedSignals(host) {
    const t0 = Date.now() - 30 * 86_400_000
    const ss = window.AesConductorSignalStore
    for (let i = 0; i < 20; i++) {
        await ss.append(host, {
            id: "sig-" + i, type: "route.profit.changed",
            server: host.server, airline: host.airline,
            payload: {hub: "JFK", dest: "LHR", to: 10000 + i * 500, from: 9500 + i * 500},
            firedAt: t0 + i * 86_400_000
        })
    }
}

async function main() {
    await it("refresh expands scopeId:'*' and writes a forecast envelope", async () => {
        const {storage} = setup()
        const host = {server: "free1", airline: "TEST"}
        await seedSignals(host)
        const fs = window.AesConductorForecastStore
        const r = await fs.refresh(host)
        assert.strictEqual(r.count, 1, "one forecast computed")
        const blob = storage.data["aesConductor:forecasts:free1:TEST"]
        assert.ok(blob, "forecast blob written")
        const e = blob["route.profit:route:JFK-LHR"]
        assert.ok(e, "JFK-LHR composite present")
        assert.strictEqual(e.model, "linear")
        assert.ok(typeof e.p50 === "number" && isFinite(e.p50), "p50 numeric")
        assert.ok(e.p10 < e.p50 && e.p50 < e.p90, "monotone CI")
    })

    await it("peek() returns the cached blob after refresh", async () => {
        setup()
        const host = {server: "free1", airline: "TEST"}
        await seedSignals(host)
        const fs = window.AesConductorForecastStore
        await fs.refresh(host)
        const blob = fs.peek()
        assert.ok(blob && blob["route.profit:route:JFK-LHR"], "peek surfaces the envelope")
    })

    await it("getForecast returns null after TTL expiry", async () => {
        setup()
        const host = {server: "free1", airline: "TEST"}
        await seedSignals(host)
        const fs = window.AesConductorForecastStore
        await fs.refresh(host)
        const blob = fs.peek()
        const e = blob["route.profit:route:JFK-LHR"]
        e.computedAt = Date.now() - (fs.TTL_MS + 60_000)
        const got = fs.getForecast(blob, "route.profit", "route", "JFK-LHR")
        assert.strictEqual(got, null, "expired entry returns null")
    })

    summary("forecast-store.test.js")
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
})
