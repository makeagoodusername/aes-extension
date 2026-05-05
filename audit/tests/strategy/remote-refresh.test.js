"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

function installGlobals(store) {
    global.location = {
        hostname: "free1.airlinesim.aero",
        protocol: "https:",
        search: ""
    }
    global.chrome = {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) return Object.assign({}, store || {})
                    const out = {}
                    const list = Array.isArray(keys) ? keys : [keys]
                    for (const key of list) out[key] = store[key]
                    return out
                }
            }
        },
        runtime: {
            lastError: null,
            onMessage: {
                addListener() {},
                removeListener() {}
            },
            sendMessage(_message, cb) {
                if (cb) cb({ok: true})
            }
        }
    }
}

function loadRemote(store) {
    installGlobals(store)
    return loadModule("modules/strategy/remote-refresh.js", {})
}

;(async function main() {
    await it("builds per-aircraft plan and flights jobs from cached fleet", async () => {
        const win = loadRemote({
            "free1FGaircraftFleet": {
                type: "aircraftFleet",
                airlineCode: "FG",
                fleet: [
                    {aircraftId: "A1", registration: "N001FGM", location: "JFK"}
                ]
            }
        })
        const ctx = {server: "free1", airline: "FG", origin: "https://free1.airlinesim.aero"}
        const jobs = await win.AesStrategyRemoteRefresh._internals._buildJobs("per-aircraft", ctx, {})

        assert.strictEqual(jobs.length, 2)
        assert.strictEqual(jobs[0].url, "https://free1.airlinesim.aero/app/fleets/aircraft/A1/0")
        assert.strictEqual(jobs[0].expectStorageKeyPrefix, "aircraftFlightPlan:maintenance:free1:A1")
        assert.strictEqual(jobs[1].url, "https://free1.airlinesim.aero/app/fleets/aircraft/A1/1")
        assert.strictEqual(jobs[1].expectStorageKeyPrefix, "aircraftFlightsA1")
        assert.strictEqual(jobs[0].acceptExistingStorage, true)
    })

    await it("builds markets and inventory jobs for route candidates", async () => {
        const win = loadRemote({})
        const ctx = {server: "free1", airline: "FG", origin: "https://free1.airlinesim.aero"}
        const jobs = await win.AesStrategyRemoteRefresh._internals._buildJobs("per-route", ctx, {
            routes: [{hub: "JFK", dest: "BOS"}]
        })

        assert.strictEqual(jobs.length, 2)
        assert.strictEqual(jobs[0].url, "https://free1.airlinesim.aero/app/com/markets/JFKBOS")
        assert.strictEqual(jobs[0].expectStorageKeyPrefix, "markets:competitors:JFK-BOS")
        assert.strictEqual(jobs[1].url, "https://free1.airlinesim.aero/app/com/inventory/JFKBOS")
        assert.strictEqual(jobs[1].expectStorageKeyPrefix, "inventory:JFK-BOS")
    })

    await it("skips remote refresh for placeholder harness servers", async () => {
        const win = loadRemote({})
        const report = await win.AesStrategyRemoteRefresh.run({
            server: "TEST",
            phases: ["foundation"]
        })

        assert.strictEqual(report.ok, true)
        assert.strictEqual(report.skipped, true)
        assert.strictEqual(report.skipReason, "non-live-server")
        assert.strictEqual(report.totalJobs, 0)
    })

    await it("seedMissing consolidates empty stores into one remote refresh", async () => {
        installGlobals({})
        const calls = []
        const progress = []
        const win = loadModule("modules/strategy/store-readiness.js", {
            AesStrategyRemoteRefresh: {
                async run(opts, onProgress) {
                    calls.push(opts)
                    if (onProgress) onProgress({stage: "done", report: {okJobs: 7, totalJobs: 7}})
                    return {ok: true, totalJobs: 7, okJobs: 7, failedJobs: 0}
                }
            }
        })

        const report = await win.AesStrategyStoreReadiness.seedMissing({
            server: "free1",
            airline: "Fly Gemini",
            snapshot: {fleet: {aircraft: []}},
            portfolio: {overlapRoutes: [{hub: "JFK", dest: "BOS"}]}
        }, p => progress.push(p))

        assert.strictEqual(calls.length, 1)
        assert.deepStrictEqual(calls[0].phases, ["foundation", "per-hub", "per-aircraft", "per-route"])
        assert.deepStrictEqual(calls[0].routes, [{hub: "JFK", dest: "BOS"}])
        assert.strictEqual(report.remote, true)
        assert.strictEqual(report.ok, 4)
        assert.ok(progress.some(p => p.stage === "done"))
    })

    await it("seedMissing does not fetch staff pages from local harness TEST scope", async () => {
        installGlobals({})
        global.location = {
            hostname: "127.0.0.1",
            protocol: "http:",
            search: ""
        }
        let scrapeCalls = 0
        class StaffPilotsStub {
            static STORAGE_KEY = "crewMgmt:pilots"
            async scrape() { scrapeCalls++ }
        }
        const win = loadModule("modules/strategy/store-readiness.js", {
            CrewMgmtStaffPilotsScraper: StaffPilotsStub
        })

        const report = await win.AesStrategyStoreReadiness.seedMissing({
            server: "TEST",
            airline: "TestAir",
            snapshot: {fleet: {aircraft: []}},
            portfolio: {overlapRoutes: []}
        })
        const items = await win.AesStrategyStoreReadiness.probe({
            server: "TEST",
            snapshot: {fleet: {aircraft: []}}
        })
        const crew = items.find(it => it && it.key === "crewPilots")

        assert.strictEqual(scrapeCalls, 0)
        assert.strictEqual(report.ran, 0)
        assert.strictEqual(crew.action.kind, "nav")
        assert.strictEqual(crew.action.url, "/action/enterprise/staffPilots")
    })

    summary("remote-refresh")
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
