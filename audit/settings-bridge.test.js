"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")
const SRC = fs.readFileSync(
    path.join(ROOT, "modules/_shared/settings-bridge.js"),
    "utf8"
)

function clone(value) {
    return JSON.parse(JSON.stringify(value))
}

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
    }
}

function summary() {
    console.log("\nsettings-bridge smoke: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
}

;(async function main() {
    const storage = {
        settings: {
            seed: true,
            general: {defaultDashboard: "general"}
        }
    }

    global.window = {}
    global.chrome = {
        storage: {
            local: {
                async get(keys) {
                    if (Array.isArray(keys) && keys.length === 1 && keys[0] === "settings") {
                        return {settings: clone(storage.settings)}
                    }
                    return {settings: clone(storage.settings)}
                },
                async set(payload) {
                    storage.settings = clone(payload.settings)
                }
            }
        }
    }
    delete globalThis.AesSettings
    delete globalThis.currentAccountIdSync

    eval(SRC)
    const AesSettings = globalThis.AesSettings

    await it("exports AesSettings on first eval", () => {
        assert.ok(AesSettings, "expected globalThis.AesSettings")
        assert.equal(typeof AesSettings.saveArea, "function")
        assert.equal(typeof AesSettings.saveAreaScoped, "function")
    })

    await it("duplicate eval keeps the same export", () => {
        const first = globalThis.AesSettings
        eval(SRC)
        assert.strictEqual(globalThis.AesSettings, first)
    })

    await it("concurrent saveArea/saveAreaScoped preserve sibling branches", async () => {
        await Promise.all([
            AesSettings.saveArea("schedule", {autoExtract: 1}),
            AesSettings.saveArea("stationAutomation", {defaultConcurrency: 6}),
            AesSettings.saveAreaScoped("routeAssistant", {panelMode: "waves"}, "acct-1"),
            AesSettings.saveAreaScoped("strategy", {riskProfile: "low"}, "acct-1")
        ])

        const all = await AesSettings.loadAll()
        assert.deepStrictEqual(all.general, {defaultDashboard: "general"})
        assert.deepStrictEqual(all.schedule, {autoExtract: 1})
        assert.deepStrictEqual(all.stationAutomation, {defaultConcurrency: 6})
        assert.deepStrictEqual(all.acct["acct-1"].routeAssistant, {panelMode: "waves"})
        assert.deepStrictEqual(all.acct["acct-1"].strategy, {riskProfile: "low"})
        assert.strictEqual(all.seed, true)
    })

    await it("getAreaScoped falls back to the legacy top-level area", async () => {
        const block = await AesSettings.getAreaScoped("general", "missing-acct")
        assert.deepStrictEqual(block, {defaultDashboard: "general"})
    })

    await it("saveAreaScoped uses currentAccountIdSync when accountId is omitted", async () => {
        globalThis.currentAccountIdSync = () => "acct-2"
        await AesSettings.saveAreaScoped("aircraftFlightPlan", {
            autoScheduler: {diff: {toleranceMin: 45}}
        })
        const block = await AesSettings.getAreaScoped("aircraftFlightPlan", "acct-2")
        assert.strictEqual(block.autoScheduler.diff.toleranceMin, 45)
    })

    summary()
})().catch((e) => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
