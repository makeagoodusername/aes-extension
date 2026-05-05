"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

let pass = 0
let fail = 0

async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
    }
}

function reset(storage) {
    global.window = global
    global.console = console
    delete global.AesWaveAutomationContext
    delete global.AesWaveRegistry
    global.CentralHubBus = {emit() {}}
    global.chrome = {
        storage: {
            local: {
                async get(keys) {
                    const out = {}
                    const list = Array.isArray(keys) ? keys : Object.keys(keys || {})
                    for (const k of list) if (Object.prototype.hasOwnProperty.call(storage, k)) out[k] = storage[k]
                    return out
                }
            }
        }
    }
}

function load() {
    const src = fs.readFileSync(path.join(ROOT, "modules/route-assistant/wave-automation-context.js"), "utf8")
    eval(src)
    return global.AesWaveAutomationContext
}

function preset(extra) {
    return Object.assign({
        id: "p-jfk",
        name: "JFK bank",
        hub: "JFK",
        waves: [{
            id: "w1",
            label: "AM",
            arrivalWindow: {start: "08:00", end: "09:00"},
            departureWindow: {start: "10:00", end: "11:00"},
            composition: {shortHaul: 2, mediumHaul: 0, longHaul: 0}
        }]
    }, extra || {})
}

function installWaveStubs() {
    global.RouteAssistantWaveOverlay = {
        buildSchedule(p, rows) {
            return {
                preset: p,
                validation: [],
                flights: rows.slice(0, 1).map((r, i) => ({seq: i + 1, waveId: "w1", destination: r.destIata})),
                placements: rows.slice(0, 1).map(r => ({waveId: "w1", route: {destination: r.destIata}})),
                warnings: [],
                unplaced: rows.slice(1).map(r => ({destination: r.destIata})),
                connections: []
            }
        }
    }
    global.RouteAssistantWavePlanDiagnostics = {
        scorePlan(build) {
            return {
                planScore: 78,
                planGrade: "B",
                perWave: [{waveId: "w1", slotsUsed: 1, slotsTotal: 2, fitQuality: "ok"}],
                unplaceable: {count: build.unplaced.length},
                warnings: []
            }
        }
    }
}

console.log("=== wave automation context ===")

;(async () => {
    await it("reports a missing preset as a create-starter action", async () => {
        reset({})
        global.SchedulePresets = {async load() { return {presets: []} }}
        const Ctx = load()
        const ctx = await Ctx.buildForHub({hub: "JFK", rows: [{aircraftId: 1, hub: "JFK"}]})
        assert.strictEqual(ctx.readiness.status, "blocked")
        assert.ok(ctx.readiness.blockers.some(b => b.code === "noPreset"))
        assert.strictEqual(ctx.actions.createStarter.enabled, true)
    })

    await it("blocks presets with no active capacity", async () => {
        reset({
            "routeAssistant:topRoutes:JFK": {
                hub: "JFK",
                scrapedAt: Date.now(),
                rows: [{destIata: "BOS", distanceKm: 300, paxScore: 9}]
            }
        })
        const p = preset({waves: [Object.assign({}, preset().waves[0], {
            composition: {shortHaul: 0, mediumHaul: 0, longHaul: 0}
        })]})
        global.SchedulePresets = {async load() { return {presets: [p]} }}
        const Ctx = load()
        const ctx = await Ctx.buildForHub({hub: "JFK", rows: [{aircraftId: 1, hub: "JFK"}]})
        assert.ok(ctx.readiness.blockers.some(b => b.code === "noCapacity"))
        assert.strictEqual(ctx.actions.buildPreview.enabled, false)
    })

    await it("returns score, readiness, and fleet actions for a usable hub plan", async () => {
        reset({
            "routeAssistant:topRoutes:JFK": {
                hub: "JFK",
                scrapedAt: Date.now(),
                rows: [
                    {destIata: "BOS", distanceKm: 300, paxScore: 9, profitPerWeek: 1200},
                    {destIata: "LAX", distanceKm: 4000, paxScore: 8, profitPerWeek: 900}
                ]
            }
        })
        installWaveStubs()
        global.SchedulePresets = {async load() { return {presets: [preset()]} }}
        const Ctx = load()
        const ctx = await Ctx.buildForHub({
            hub: "JFK",
            rows: [{aircraftId: 1, hub: "JFK"}],
            existingStations: ["BOS"]
        })
        assert.strictEqual(ctx.readiness.status, "attention")
        assert.strictEqual(ctx.readiness.score, 78)
        assert.strictEqual(ctx.stationSummary.open, 1)
        assert.strictEqual(ctx.stationSummary.missing, 1)
        assert.strictEqual(ctx.actions.buildPreview.enabled, true)
        assert.strictEqual(ctx.actions.applyToFleet.enabled, true)
    })

    console.log("\nwave automation context: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
