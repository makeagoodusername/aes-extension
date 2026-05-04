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
        id: "jfk-preset",
        name: "JFK preset selected while aircraft is in FCO",
        hub: "JFK",
        factors: Object.assign({}, window.ScheduleFactors.defaultFactors(), {
            slotWindow: {start: "00:00", end: "23:59"},
            dayPattern: "daily",
            minTransferMinutes: 45
        }),
        waves: [{
            id: "w1",
            label: "Morning",
            arrivalWindow:   {start: "00:00", end: "04:00"},
            departureWindow: {start: "05:00", end: "05:00"},
            composition: {shortHaul: 1, mediumHaul: 0, longHaul: 0}
        }]
    }

    const settings = {
        defaultPricePct: 100,
        autoScheduler: {
            fillToBudget: false,
            budgetOverrunPct: 0.5,
            fallbackFuelCostPerKg: 0.4,
            weights: {
                cargoWeight: 0.5,
                grossWeight: 1,
                fuelWeight: 0,
                distanceSaturationNm: 5000,
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
        load: async () => ({defaultPresetId: "jfk-preset", presets: [preset]})
    }

    loadAfpModule("modules/aircraft-flight-plan/auto-scheduler/allocator.js")

    const build = await window.AesAfpAutoScheduler.run({
        aircraftId: "A1",
        persist: false,
        candidates: [
            {destIata: "FCO", distanceKm: 100, distanceNm: 54, paxScore: 99, cargoScore: 99, weeklyFlights: 100, profitPerWeek: 9000},
            {destIata: "JFK", distanceKm: 6861, distanceNm: 3705, paxScore: 10, cargoScore: 3, weeklyFlights: 56, profitPerWeek: 5000}
        ],
        spec: {typeName: "Test Longhaul", seats: 220, range: 9000, cruiseSpeedKmh: 850},
        budget: {
            maxWeeklyBlockHours: 24,
            maxDailyBlockHours: 24,
            currentRatio: 100,
            targetMaintenanceRatio: 100
        }
    })

    assert.deepStrictEqual(build.validation, [], "valid build")
    assert.ok(build.flights.length >= 2, "valid route was scheduled")
    assert.ok(build.flights.every(f => f.origin !== f.destination),
        "auto-scheduler never emits origin-equals-destination flights")
    assert.strictEqual(build.flights[0].origin, "FCO",
        "outbound origin follows aircraft location, not mismatched preset hub")
    assert.strictEqual(build.flights[0].destination, "JFK",
        "outbound destination keeps the scored route")
    assert.strictEqual(build.flights[1].origin, "JFK",
        "inbound origin reverses the scored route")
    assert.strictEqual(build.flights[1].destination, "FCO",
        "inbound destination returns to aircraft location")
    assert.strictEqual(build.metadata.scheduleOriginIata, "FCO",
        "metadata records the chosen schedule origin")
    assert.strictEqual(build.metadata.scheduleOriginSource, "aircraft-location",
        "metadata records why the aircraft location was used")
    assert.ok(build.warnings.some(w => w && w.type === "ferryPreset"),
        "mismatched preset hub remains visible as a warning")

    console.log("auto-scheduler-hub-origin: passed")
}

main().catch(err => {
    console.error("auto-scheduler-hub-origin: FAILED")
    console.error(err && err.stack || err)
    process.exitCode = 1
})
