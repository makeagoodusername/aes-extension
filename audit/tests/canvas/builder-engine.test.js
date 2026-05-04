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

function reset(events) {
    global.window = global
    global.console = console
    delete global.AesWaveAutomationContext
    global.AesCanvasEvents = {
        BUILDER_PROPOSAL: "canvas:builder-proposal",
        BUILDER_DONE: "canvas:builder-done"
    }
    global.CentralHubBus = {
        emit(type, payload) { events.push({type, payload}) }
    }
    global.chrome = {
        storage: {
            local: {
                async get() { return {} }
            }
        }
    }
}

function load() {
    const src = fs.readFileSync(path.join(ROOT, "modules/canvas/rail/builder-engine.js"), "utf8")
    eval(src)
    return global.CanvasBuilderEngine
}

function preset() {
    return {
        id: "p-jfk",
        hub: "JFK",
        waves: [
            {id: "w1", label: "AM", arrivalWindow: {start: "08:00", end: "09:00"}, departureWindow: {start: "10:00", end: "11:00"}},
            {id: "w2", label: "PM", arrivalWindow: {start: "12:00", end: "13:00"}, departureWindow: {start: "14:00", end: "15:00"}}
        ]
    }
}

function proposals(events) {
    return events
        .filter(e => e.type === "canvas:builder-proposal")
        .map(e => e.payload)
}

console.log("=== canvas builder-engine ===")

;(async () => {
    await it("streams station-aware addRoute edits and respects inbound-filled wave cells", async () => {
        const events = []
        reset(events)
        const Engine = load()
        const engine = new Engine()
        await engine.propose({
            hub: "JFK",
            fleet: [
                {aircraftId: 101, hub: "JFK", range: 6000},
                {aircraftId: 102, hub: "JFK", range: 6000}
            ],
            schedules: new Map([
                ["101", {legs: [{origin: "LAX", destination: "JFK", arrTimeLocal: "08:30", depTimeLocal: "03:00"}]}]
            ]),
            preset: preset(),
            existingStations: new Set(["BOS"]),
            demandRows: [
                {dest: "BOS", paxScore: 9, distanceKm: 300, profitPerWeek: 1200},
                {destIata: "LAX", paxScore: 8, distanceKm: 4000, profitPerWeek: 900}
            ]
        })

        const built = proposals(events).filter(p => p.plan && p.plan.edits && p.plan.edits.length)
        assert.ok(built.length >= 1, "expected at least one real proposal")
        const edits = built[0].plan.edits
        assert.ok(edits.every(e => e.kind === "addRoute"), "edits are addRoute")
        assert.ok(edits.every(e => e.hub === "JFK"), "edits carry hub")
        assert.ok(edits.some(e => e.stationStatus === "open"), "open station annotated")
        assert.ok(edits.some(e => e.stationStatus === "missing"), "missing station annotated")
        assert.ok(!edits.some(e => e.aircraftId === "101" && e.waveId === "w1"),
            "inbound arrival in w1 keeps cell non-empty")
        assert.strictEqual(events[events.length - 1].type, "canvas:builder-done")
    })

    await it("emits a visible diagnostic card when no demand cache is available", async () => {
        const events = []
        reset(events)
        const Engine = load()
        await new Engine().propose({
            hub: "JFK",
            fleet: [{aircraftId: 101, hub: "JFK"}],
            schedules: new Map(),
            preset: preset(),
            demandRows: []
        })
        const diag = proposals(events)[0]
        assert.ok(diag.empty, "diagnostic proposal marked empty")
        assert.match(diag.name, /No cached demand/)
        assert.strictEqual(events[events.length - 1].type, "canvas:builder-done")
    })

    await it("emits diagnostics instead of silent done when all cells are already filled", async () => {
        const events = []
        reset(events)
        const Engine = load()
        await new Engine().propose({
            hub: "JFK",
            fleet: [{aircraftId: 101, hub: "JFK"}],
            schedules: new Map([["101", {legs: [
                {origin: "JFK", destination: "BOS", depTimeLocal: "10:30"},
                {origin: "JFK", destination: "LAX", depTimeLocal: "14:30"}
            ]}]]),
            preset: preset(),
            existingStations: ["BOS"],
            demandRows: [{destIata: "BOS", paxScore: 9}]
        })
        const diag = proposals(events)[0]
        assert.ok(diag.empty, "diagnostic proposal emitted")
        assert.match(diag.rationale, /no empty wave cells/i)
    })

    await it("uses wave automation context to prioritise underfilled waves", async () => {
        const events = []
        reset(events)
        global.AesWaveAutomationContext = {
            async buildForHub() {
                return {
                    readiness: {score: 66, blockers: []},
                    capacity: {underfilledWaveIds: ["w2"], unplaced: 0}
                }
            }
        }
        const Engine = load()
        await new Engine().propose({
            hub: "JFK",
            fleet: [{aircraftId: 101, hub: "JFK"}],
            schedules: new Map(),
            preset: preset(),
            demandRows: [{destIata: "BOS", paxScore: 9, distanceKm: 300}]
        })
        const built = proposals(events).find(p => p.plan && p.plan.edits && p.plan.edits.length)
        assert.ok(built, "expected a proposal")
        assert.strictEqual(built.plan.edits[0].waveId, "w2")
        assert.strictEqual(built.diagnostics.waveScore, 66)
    })

    console.log("\ncanvas builder-engine: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
