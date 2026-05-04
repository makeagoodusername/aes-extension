"use strict"

/**
 * Node-runnable smoke for the AFP maintenance budget target horizon.
 *
 * Verifies the scheduler ceiling solves against minMaintenanceRatio after
 * maintenanceWaitDays (default user target: 100% after 3 days), rather than
 * only using the long-run equilibrium point.
 */

const {loadAfpModule, resetGlobals, assert} = require("./_helpers")

async function main() {
    resetGlobals()
    loadAfpModule("modules/aircraft-flight-plan/maintenance-budget.js")

    global.AesAfpSettings = {
        load: async () => ({
            autoScheduler: {
                minMaintenanceRatio: 100,
                maintenanceWaitDays: 3,
                fallbackMaxWeeklyBlockHours: 80,
                fallbackMaxDailyBlockHours: 14
            }
        })
    }
    global.AesAfpMaintenanceStore = {
        load: async () => ({
            ratio: 98,
            condition: 100,
            ratioStatus: "ok",
            conditionStatus: "ok"
        })
    }
    global.AesAfpWearModel = {
        fit: async () => ({
            valid: true,
            slope: -0.1,
            intercept: 10,
            equilibriumWeeklyBlockHours: 100
        }),
        scheduledWeeklyBlockHours: async () => 60
    }

    const budget = await window.AesAfpMaintenanceBudget.compute({
        server: "free1",
        aircraftId: "A1"
    })

    assert.ok(budget, "budget returned")
    assert.strictEqual(budget.source, "regression")
    assert.strictEqual(budget.targetMaintenanceRatio, 100)
    assert.strictEqual(budget.maintenanceWaitDays, 3)
    assert.ok(Math.abs(budget.maxWeeklyBlockHours - 53.3333333333) < 0.01,
        "below-target ratio tightens weekly ceiling to hit 100% after 3 days")
    assert.ok(Math.abs(budget.forecastRatioTargetDays - 100) < 0.01,
        "target-horizon forecast lands on 100%")
    console.log("maintenance-budget-target: passed")
}

main().catch(err => {
    console.error("maintenance-budget-target: FAILED")
    console.error(err && err.stack || err)
    process.exitCode = 1
})
