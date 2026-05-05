"use strict"

/**
 * Node-runnable smoke for the AFP dense auto-scheduler.
 *
 * Covers the user-requested behavior:
 *   - one-minute slot resolution
 *   - dense fill past a preset's nominal wave composition when budget allows
 *   - no overlap with registered maintenance windows
 *   - packed same-day flight intervals close to the configured 1 minute gap
 */

const {loadAfpModule, resetGlobals, assert} = require("./_helpers")

function expose(name) {
    global[name] = window[name]
}

function minutes(hhmm) {
    return window.ScheduleFactors.parseHHMM(hhmm)
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
            airlineCode: "CFL",
            aircraftId: "A1",
            currentLocationIata: "FCO"
        },
        bus: { emit() {} }
    }
    global.AesAfp = window.AesAfp

    const preset = {
        id: "dense",
        name: "Dense FCO",
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
            composition: {shortHaul: 1, mediumHaul: 0, longHaul: 0}
        }]
    }

    const settings = {
        defaultPricePct: 100,
        autoScheduler: {
            fillToBudget: true,
            budgetOverrunPct: 0.5,
            minMaintenanceRatio: 100,
            maintenanceWaitDays: 3,
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
                maxPlacementsPerCandidate: 14,
                efficiencyWeight: 0.25,
                gapTargetMinutes: 1,
                gapPenaltyPerMinute: 25
            }
        }
    }

    global.AesAfpSettings = { load: async () => settings }
    global.SchedulePresets = {
        load: async () => ({defaultPresetId: "dense", presets: [preset]})
    }

    loadAfpModule("modules/aircraft-flight-plan/auto-scheduler/allocator.js")

    const candidates = [
        {destIata: "AAA", distanceKm: 160, distanceNm: 86, paxScore: 10, cargoScore: 4, weeklyFlights: 100},
        {destIata: "BBB", distanceKm: 220, distanceNm: 119, paxScore: 9,  cargoScore: 5, weeklyFlights: 100}
    ]
    const spec = {
        typeName: "Test Jet",
        seats: 100,
        range: 5000,
        cruiseSpeedKmh: 800
    }
    const budget = {
        maxWeeklyBlockHours: 22,
        maxDailyBlockHours: 10,
        mandatoryGroundHoursPerDay: 4,
        currentRatio: 100,
        targetMaintenanceRatio: 100,
        maintenanceWaitDays: 3,
        source: "test",
        fit: {valid: true, slope: -0.05, intercept: 5}
    }

    const build = await window.AesAfpAutoScheduler.run({
        aircraftId: "A1",
        candidates,
        spec,
        budget,
        persist: false,
        maintenanceWindows: [{dayIdx: 0, startMin: 490, endMin: 540}]
    })

    assert.deepStrictEqual(build.validation, [], "valid build")
    assert.strictEqual(build.metadata.slotResolutionMin, 1, "uses one-minute slots")
    assert.strictEqual(build.metadata.fillToBudget, true, "dense fill is on")
    assert.ok(build.metadata.maintenanceHoursReserved > 0,
        "registered maintenance reserves grid occupancy")
    assert.strictEqual(build.metadata.budgetUsedHours, build.metadata.flightOnlyHoursUsed,
        "budget usage reports flight hours, not maintenance-reserved occupancy")
    assert.ok(build.metadata.occupiedHoursUsed > build.metadata.flightOnlyHoursUsed,
        "occupied hours retain flight + maintenance grid total for diagnostics")
    assert.ok(build.metadata.placedRoundTrips > 7,
        "places beyond one wave-cap round-trip per day when budget allows")
    assert.ok(build.metadata.packing.overflowPlacements > 0,
        "metadata records wave-cap overflow placements")
    assert.ok(build.metadata.packing.tightGapSharePct == null
        || build.metadata.packing.tightGapSharePct >= 50,
        "same-day gaps are usually within target +/-1 minute")

    for (let i = 0; i < build.flights.length; i += 2) {
        const out = build.flights[i]
        const inn = build.flights[i + 1]
        if (!out || !inn || !out.dayMask || !out.dayMask[0]) continue
        const start = minutes(out.depTimeLocal)
        const end = minutes(inn.arrTimeLocal)
        assert.ok(!(start < 540 && end > 490),
            "Monday round-trip does not overlap registered maintenance")
    }

    console.log("auto-scheduler-dense: passed")
}

main().catch(err => {
    console.error("auto-scheduler-dense: FAILED")
    console.error(err && err.stack || err)
    process.exitCode = 1
})
