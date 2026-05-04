"use strict"

const {loadAfpModule, resetGlobals, assert} = require("./_helpers")

function expose(name) {
    global[name] = window[name]
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
            currentLocationIata: "FCO"
        },
        bus: { emit() {} }
    }
    global.AesAfp = window.AesAfp

    const preset = {
        id: "profit-guard",
        name: "Profit guard",
        hub: "FCO",
        factors: Object.assign({}, window.ScheduleFactors.defaultFactors(), {
            slotWindow: {start: "00:00", end: "23:59"},
            dayPattern: "daily",
            minTransferMinutes: 45
        }),
        waves: [{
            id: "w1",
            label: "All-day",
            arrivalWindow:   {start: "00:00", end: "05:00"},
            departureWindow: {start: "06:00", end: "23:00"},
            composition: {shortHaul: 2, mediumHaul: 0, longHaul: 0}
        }]
    }
    const settings = {
        defaultPricePct: 100,
        autoScheduler: {
            fillToBudget: true,
            budgetOverrunPct: 0.5,
            fallbackFuelCostPerKg: 0.4,
            weights: {
                cargoWeight: 0.5,
                grossWeight: 1,
                fuelWeight: 0,
                distanceSaturationNm: 2500,
                distanceFloor: 0.2,
                slackPenaltyPerHour: 5000,
                dailyOverrunPenaltyPerHour: 10000,
                cycleMinutes: 30,
                slotResolutionMin: 5,
                tightSlotResolutionMin: 1,
                weeklyFlightsDivisor: 4,
                maxPlacementsPerCandidate: 4,
                minPlacementsPerCandidate: 1,
                efficiencyWeight: 0.25,
                gapTargetMinutes: 1,
                gapPenaltyPerMinute: 25
            }
        }
    }
    global.AesAfpSettings = { load: async () => settings }
    global.SchedulePresets = {
        load: async () => ({defaultPresetId: "profit-guard", presets: [preset]})
    }

    loadAfpModule("modules/aircraft-flight-plan/auto-scheduler/allocator.js")

    const build = await window.AesAfpAutoScheduler.run({
        aircraftId: "A1",
        persist: false,
        candidates: [
            {destIata: "AAA", distanceKm: 200, distanceNm: 108, paxScore: 1, cargoScore: 1, weeklyFlights: 100, profitPerWeek: 1000},
            {destIata: "BBB", distanceKm: 200, distanceNm: 108, paxScore: 10, cargoScore: 10, weeklyFlights: 100, profitPerWeek: -5000}
        ],
        spec: {typeName: "Test Jet", seats: 100, range: 5000, cruiseSpeedKmh: 800},
        budget: {
            maxWeeklyBlockHours: 5,
            maxDailyBlockHours: 10,
            currentRatio: 100,
            targetMaintenanceRatio: 100
        }
    })

    assert.deepStrictEqual(build.validation, [], "valid build")
    assert.ok(build.flights.length > 0, "positive-profit route was scheduled")
    assert.ok(build.flights.every(f => f.origin !== "BBB" && f.destination !== "BBB"),
        "known negative-profit route was not scheduled")
    assert.ok(build.unplaced.some(r => r.destination === "BBB"),
        "known negative-profit route remains visible as unplaced")
    console.log("auto-scheduler-profit-guard: passed")
}

main().catch(err => {
    console.error("auto-scheduler-profit-guard: FAILED")
    console.error(err && err.stack || err)
    process.exitCode = 1
})
