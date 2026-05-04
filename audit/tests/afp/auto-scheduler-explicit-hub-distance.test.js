"use strict"

const {loadAfpModule, resetGlobals, assert} = require("./_helpers")

function expose(name) {
    global[name] = window[name]
}

function preset(id, hub) {
    return {
        id,
        name: hub + " explicit hub preset",
        hub,
        factors: Object.assign({}, window.ScheduleFactors.defaultFactors(), {
            slotWindow: {start: "00:00", end: "23:59"},
            dayPattern: "custom",
            dayMask: [1, 0, 0, 0, 0, 0, 0],
            minTransferMinutes: 45
        }),
        waves: [{
            id: "w-" + hub,
            label: "One route",
            arrivalWindow:   {start: "06:00", end: "06:30"},
            departureWindow: {start: "09:00", end: "09:00"},
            composition: {shortHaul: 1, mediumHaul: 0, longHaul: 0}
        }]
    }
}

async function main() {
    resetGlobals()
    loadAfpModule("modules/schedule-management/range-buckets.js", ["ScheduleFactors"])
    expose("ScheduleFactors")
    loadAfpModule("modules/schedule-management/schedule-builder.js", ["ScheduleBuilder"])
    expose("ScheduleBuilder")
    loadAfpModule("modules/aircraft-flight-plan/auto-scheduler/grid-state.js")
    expose("AesAfpAutoSchedulerGrid")
    loadAfpModule("modules/aircraft-flight-plan/auto-scheduler/objective.js")
    expose("AesAfpAutoSchedulerObjective")

    window.AesAfp = {
        ctx: {
            server: "free1",
            airlineCode: "CFA",
            aircraftId: "A1",
            currentLocationIata: "SYD"
        },
        bus: { emit() {} },
        getNewFlightForm() {
            const mkSelect = (iatas) => ({
                options: iatas.map(iata => ({textContent: "Airport (" + iata + ")"}))
            })
            return {
                originSelect: mkSelect(["LHR", "CDG"]),
                destSelect:   mkSelect(["LHR", "CDG"])
            }
        }
    }
    global.AesAfp = window.AesAfp

    const settings = {
        lastSelectedPresetId: "syd-preset",
        activePresetIdByHub: {LHR: "lhr-preset", SYD: "syd-preset"},
        defaultPricePct: 100,
        autoScheduler: {
            fillToBudget: false,
            budgetOverrunPct: 0.5,
            fallbackFuelCostPerKg: 0.4,
            weights: {
                cargoWeight: 0.5,
                grossWeight: 1,
                fuelWeight: 0,
                distanceSaturationNm: 2500,
                distanceFloor: 0.2,
                slackPenaltyPerHour: 0,
                dailyOverrunPenaltyPerHour: 0,
                cycleMinutes: 30,
                slotResolutionMin: 5,
                tightSlotResolutionMin: 1,
                weeklyFlightsDivisor: 4,
                maxPlacementsPerCandidate: 2,
                minPlacementsPerCandidate: 1,
                efficiencyWeight: 0.25,
                gapTargetMinutes: 1,
                gapPenaltyPerMinute: 0
            }
        }
    }
    global.AesAfpSettings = { load: async () => settings }
    global.SchedulePresets = {
        load: async () => ({
            defaultPresetId: "syd-preset",
            presets: [preset("syd-preset", "SYD"), preset("lhr-preset", "LHR")]
        })
    }

    const resolvedPairs = []
    global.RouteAssistantDistanceResolver = class {
        constructor(server) { this.server = server }
        async resolve(hub, dest) {
            resolvedPairs.push([this.server, hub, dest])
            if (hub === "LHR" && dest === "CDG") return {distanceKm: 344, source: "test"}
            if (hub === "LHR" && dest === "AMS") return {distanceKm: 370, source: "test"}
            return null
        }
    }

    loadAfpModule("modules/aircraft-flight-plan/auto-scheduler/allocator.js")

    const build = await window.AesAfpAutoScheduler.run({
        aircraftId: "A1",
        hubIata: "LHR",
        persist: false,
        candidates: [
            {destIata: "AMS", distanceKm: null, distanceNm: null, paxScore: 99, cargoScore: 9, weeklyFlights: 99, profitPerWeek: 9000},
            {destIata: "CDG", distanceKm: null, distanceNm: null, paxScore: 10, cargoScore: 6, weeklyFlights: 56, profitPerWeek: 5000}
        ],
        spec: {typeName: "Test Jet", seats: 120, range: 2500, cruiseSpeedKmh: 800},
        budget: {
            maxWeeklyBlockHours: 6,
            maxDailyBlockHours: 6,
            currentRatio: 100,
            targetMaintenanceRatio: 100
        }
    })

    assert.deepStrictEqual(build.validation, [], "valid build")
    assert.strictEqual(build.preset.id, "lhr-preset",
        "explicit planning hub chooses the matching hub preset")
    assert.strictEqual(build.metadata.scheduleOriginIata, "LHR",
        "metadata records explicit planning hub as origin")
    assert.strictEqual(build.metadata.scheduleOriginSource, "explicit",
        "metadata records explicit hub source")
    assert.strictEqual(build.metadata.candidateDistancesHydrated, 1,
        "missing route distance was hydrated before scheduling")
    assert.strictEqual(build.metadata.candidateFormSelectableFiltered, 1,
        "non-selectable AS form destinations are filtered before scheduling")
    assert.deepStrictEqual(resolvedPairs, [["free1", "LHR", "CDG"]],
        "distance resolver receives the explicit planning hub")
    assert.strictEqual(build.flights.length, 2, "one round-trip was scheduled")
    assert.strictEqual(build.flights[0].origin, "LHR")
    assert.strictEqual(build.flights[0].destination, "CDG")
    assert.strictEqual(build.flights[1].origin, "CDG")
    assert.strictEqual(build.flights[1].destination, "LHR")

    console.log("auto-scheduler-explicit-hub-distance: passed")
}

main().catch(err => {
    console.error("auto-scheduler-explicit-hub-distance: FAILED")
    console.error(err && err.stack || err)
    process.exitCode = 1
})
