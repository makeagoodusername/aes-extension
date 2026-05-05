"use strict"

/**
 * Node-runnable smoke for AesAfpActiveDraftStore's read-modify-write helpers.
 *
 * Locks down F-9228-901: concurrent setApplied / setDismissed / setEdit calls
 * must not build stale whole-map patches before entering the per-key queue.
 */

const {loadAfpModule, resetGlobals, it, summary, assert} = require("./_helpers")

resetGlobals()
loadAfpModule("modules/aircraft-flight-plan/active-draft-store.js")

const Store = global.window.AesAfpActiveDraftStore
assert.ok(Store, "AesAfpActiveDraftStore exported on window")

async function main() {
    await it("concurrent setApplied calls preserve every seq", async () => {
        await Promise.all([
            Store.setApplied("free1", "22094", 1, 1001),
            Store.setApplied("free1", "22094", 2, 1002),
            Store.setApplied("free1", "22094", 3, 1003)
        ])
        const rec = await Store.load("free1", "22094")
        assert.deepStrictEqual(rec.appliedLegs, {1: 1001, 2: 1002, 3: 1003})
    })

    await it("concurrent setDismissed calls preserve every seq", async () => {
        await Promise.all([
            Store.setDismissed("free1", "22094", 4, 2004),
            Store.setDismissed("free1", "22094", 5, 2005)
        ])
        const rec = await Store.load("free1", "22094")
        assert.deepStrictEqual(rec.dismissedLegs, {4: 2004, 5: 2005})
    })

    await it("concurrent setEdit calls merge per-leg overlays", async () => {
        await Promise.all([
            Store.setEdit("free1", "22094", 6, {depTimeLocal: "09:00"}),
            Store.setEdit("free1", "22094", 7, {pricePct: 115}),
            Store.setEdit("free1", "22094", 6, {service: "full"})
        ])
        const rec = await Store.load("free1", "22094")
        assert.deepStrictEqual(rec.perLegEdits[6], {depTimeLocal: "09:00", service: "full"})
        assert.deepStrictEqual(rec.perLegEdits[7], {pricePct: 115})
    })

    await it("null updates still clear the targeted seq", async () => {
        await Store.setApplied("free1", "22094", 2, null)
        await Store.setDismissed("free1", "22094", 5, null)
        await Store.setEdit("free1", "22094", 7, null)
        const rec = await Store.load("free1", "22094")
        assert.strictEqual(rec.appliedLegs[2], undefined)
        assert.strictEqual(rec.dismissedLegs[5], undefined)
        assert.strictEqual(rec.perLegEdits[7], undefined)
        assert.strictEqual(rec.appliedLegs[1], 1001)
        assert.strictEqual(rec.dismissedLegs[4], 2004)
    })

    summary("active-draft-store (F-9228-901 lockdown)")
}

main().catch(err => {
    console.error(err && err.stack || err)
    process.exitCode = 1
})
