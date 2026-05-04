"use strict"

const {loadModule, assert} = require("./_helpers")

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
        if (e && e.stack) {
            console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
        }
    }
}

function loadSettings() {
    delete global.chrome
    const win = loadModule("modules/central-hub/settings-store.js")
    return win.CentralHubSettings
}

;(async function main() {
    await it("loads defaults without chrome.storage.local", async () => {
        const Settings = loadSettings()
        const loaded = await Settings.load()
        assert.strictEqual(loaded.activeSection, "fleet")
        assert.deepStrictEqual(loaded.expandedTiles, [])

        await Settings.patch({activeSection: "routes", expandedTiles: ["route-management"]})
        const saved = await Settings.load()
        assert.strictEqual(saved.activeSection, "routes")
        assert.deepStrictEqual(saved.expandedTiles, ["route-management"])
    })

    await it("falls back when chrome.storage.local throws during launch", async () => {
        const Settings = loadSettings()
        const warnings = []
        const originalWarn = console.warn
        console.warn = function () {
            warnings.push(Array.from(arguments).join(" "))
        }
        global.chrome = {
            storage: {
                local: {
                    get: async () => { throw new Error("storage unavailable") },
                    set: async () => { throw new Error("write unavailable") }
                }
            }
        }

        try {
            const loaded = await Settings.load()
            assert.strictEqual(loaded.activeSection, "fleet")

            await Settings.patch({activeSection: "operations"})
            const saved = await Settings.load()
            assert.strictEqual(saved.activeSection, "operations")
        } finally {
            console.warn = originalWarn
        }

        assert.ok(warnings.some(line => /settings storage read failed/.test(line)))
        assert.ok(warnings.some(line => /settings storage write failed/.test(line)))
    })

    console.log("\ncentral-hub-settings: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
})()
