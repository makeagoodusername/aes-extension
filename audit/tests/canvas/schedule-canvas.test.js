"use strict"

const {loadAfpModule, resetGlobals, it, summary, assert} = require("../afp/_helpers")

console.log("=== schedule canvas ===")

resetGlobals()
loadAfpModule("modules/canvas/wave-spine-renderer.js", ["CanvasWaveSpineRenderer"])

const Renderer = window.CanvasWaveSpineRenderer

function wave() {
    return {
        id: "w1",
        label: "Wave 1",
        arrivalWindow:   {start: "08:05", end: "08:35"},
        departureWindow: {start: "09:55", end: "10:25"}
    }
}

it("wave rows include cached schedules that touch the active hub", () => {
    const renderer = new Renderer({
        activeHub: "JFK",
        fleet: [
            {aircraftId: "1", registration: "N001", hub: null},
            {aircraftId: "2", registration: "N002", hub: "LAX"}
        ],
        schedules: new Map([
            ["1", {hubIata: "JFK", legs: [{origin: "JFK", destination: "SEA", depTimeLocal: "10:10"}]}],
            ["2", {hubIata: "LAX", legs: [{origin: "LAX", destination: "SFO", depTimeLocal: "10:10"}]}]
        ])
    })
    assert.deepStrictEqual(renderer._fleetForActiveHub().map(r => r.aircraftId), ["1"])
})

it("wave cells summarize inbound arrivals and outbound departures", () => {
    const renderer = new Renderer({
        activeHub: "JFK",
        fleet: [{aircraftId: "1", registration: "N001", hub: "JFK"}],
        schedules: new Map([["1", {
            hubIata: "JFK",
            legs: [
                {seq: 1, dayIdx: 0, origin: "SEA", destination: "JFK", depTimeLocal: "02:10", arrTimeLocal: "08:10", durationMin: 360},
                {seq: 2, dayIdx: 0, origin: "JFK", destination: "SEA", depTimeLocal: "10:10", arrTimeLocal: "16:05", durationMin: 355},
                {seq: 3, dayIdx: 0, origin: "JFK", destination: "BOS", depTimeLocal: "12:00", arrTimeLocal: "13:10", durationMin: 70}
            ]
        }]])
    })
    const summary = renderer._summariseWaveCell({aircraftId: "1", hub: "JFK"}, wave())
    assert.strictEqual(summary.flightCount, 2)
    assert.strictEqual(summary.topDest, "SEA")
    assert.strictEqual(summary.dayMask[0], true)
    assert.deepStrictEqual(summary.legs.map(l => l.waveDirection), ["inbound", "outbound"])
})

resetGlobals()
loadAfpModule("modules/fleet-schedule-grid/dnd-source-panel.js", ["FleetScheduleGridDndSourcePanel"])

const SourcePanel = window.FleetScheduleGridDndSourcePanel

async function main() {
    await it("route source panel loads top routes, FlightsFrom routes, and watchlist", async () => {
        await chrome.storage.local.set({
            "routeAssistant:topRoutes:JFK": {
                hub: "JFK",
                rows: [
                    {destIata: "SEA", score: 80},
                    {destIata: "BOS", score: 90}
                ]
            }
        })
        global.FlightsFromStore = {
            loadAirport: async () => ({routes: [
                {destIata: "ATL", weeklyFlights: 14},
                {destIata: "SEA", weeklyFlights: 7}
            ]})
        }
        global.RouteAssistantWatchlistStore = {
            loadAll: async () => new Map([
                ["JFK-MIA", {name: "Miami"}],
                ["LAX-SFO", {name: "San Francisco"}]
            ])
        }
        global.RouteAssistantDemandStore = {
            getMany: async () => new Map([
                ["BOS", {name: "Boston", paxScore: 8}]
            ])
        }

        const panel = new SourcePanel({
            activeHub: "JFK",
            schedules: new Map([["1", {legs: [{origin: "JFK", destination: "SEA"}]}]])
        })
        const cards = await panel._loadRouteCards()
        const byDest = new Map(cards.map(c => [c.destIata, c]))

        assert.ok(byDest.has("BOS"))
        assert.ok(byDest.has("ATL"))
        assert.ok(byDest.has("MIA"))
        assert.ok(byDest.has("SEA"))
        assert.strictEqual(byDest.has("SFO"), false)
        assert.strictEqual(byDest.get("BOS").destName, "Boston")
        assert.strictEqual(byDest.get("SEA").alreadyScheduled, true)
        assert.deepStrictEqual(Array.from(byDest.get("SEA").sources).sort(), ["ff", "top"])
    })

    summary("schedule canvas")
}

main().catch(err => {
    console.error(err && err.stack || err)
    process.exitCode = 1
})
