"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys]
            const out = {}
            for (const k of list) if (store.has(k)) out[k] = store.get(k)
            return out
        },
        async set(items) {
            for (const k in items) store.set(k, items[k])
        },
        _store: store
    }
}

global.window = global
global.chrome = {
    storage: {
        local: makeChromeStore({
            settings: {
                routeAssistant: {
                    ors: {classesToScrape: ["ECONOMY"], concurrency: 2, staggerMs: 1500}
                }
            }
        })
    }
}

let syncCall = null
global.RouteAssistantRouteSync = function () {}
global.RouteAssistantOrsScraper = function () {
    this.bulkScrape = () => { throw new Error("bulkScrape should not be used by Phase 4 postRun") }
}
global.RouteAssistantOrsIntelligence = function (server, opts) {
    this.server = server
    this.opts = opts
    this.sync = async (routes, policy) => {
        syncCall = {server, routes, policy}
        return {ok: true, results: routes.map(r => ({schedule: {}, ors: {hub: r.hub, dest: r.dest}}))}
    }
}

const src = fs.readFileSync(path.join(ROOT, "modules/scrape-orchestrator/phases.js"), "utf8")
eval(src)

let pass = 0
let fail = 0
async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
    }
}

console.log("=== scrape-orchestrator ORS postRun ===")

;(async function () {
    await it("per-route postRun uses ORS intelligence route-sync path", async () => {
        const phase = global.ScrapeOrchestratorPhases._perRoute()
        syncCall = null
        const out = await phase.postRun({
            server: "free1",
            enumerators: {
                async enumerateAllRoutes() {
                    return [{hub: "ICN", dest: "NRT"}, {hub: "ICN", dest: "HND"}]
                }
            }
        })
        assert.strictEqual(out.ok, true)
        assert.ok(syncCall, "facade sync was called")
        assert.strictEqual(syncCall.server, "free1")
        assert.strictEqual(syncCall.policy.includeFresh, true)
        assert.strictEqual(syncCall.policy.source, "scrape-orchestrator")
        assert.deepStrictEqual(syncCall.routes.map(r => r.hub + "-" + r.dest), ["ICN-NRT", "ICN-HND"])
    })

    await it("ors-rank phase exposes empty buildJobs + a postRun that calls intel.sync", async () => {
        const phase = global.ScrapeOrchestratorPhases._orsRank()
        assert.strictEqual(phase.id, "ors-rank")
        assert.strictEqual(phase.optional, false, "ors-rank is mandatory")
        assert.strictEqual(typeof phase.buildJobs, "function")
        assert.strictEqual(typeof phase.postRun,   "function")
        const jobs = await phase.buildJobs({server: "free1"})
        assert.deepStrictEqual(jobs, [], "ors-rank has no tab-fan-out jobs")

        syncCall = null
        const out = await phase.postRun({
            server: "free1",
            enumerators: {
                async enumerateAllRoutes() {
                    return [{hub: "LHR", dest: "MAD"}, {hub: "LHR", dest: "CDG"}]
                }
            }
        })
        assert.strictEqual(out.ok, true)
        assert.ok(syncCall, "ors-rank postRun called intel.sync")
        assert.strictEqual(syncCall.policy.source, "ors-rank-phase")
        assert.strictEqual(syncCall.policy.includeFresh, false,
            "ors-rank refreshes only stale slice — does NOT redo every route")
        assert.deepStrictEqual(syncCall.routes.map(r => r.hub + "-" + r.dest), ["LHR-MAD", "LHR-CDG"])
    })

    await it("ors-rank phase is in ScrapeOrchestratorPhases.all() list (mandatory)", async () => {
        const ids = global.ScrapeOrchestratorPhases.all().map(p => p.id)
        assert.ok(ids.indexOf("ors-rank") >= 0, "ors-rank is registered in all()")
        assert.ok(ids.indexOf("per-route") < ids.indexOf("ors-rank"),
            "ors-rank runs after per-route in the default order")
    })

    await it("ors-rank postRun no-ops cleanly when intel module is absent", async () => {
        const phase = global.ScrapeOrchestratorPhases._orsRank()
        const savedIntel = global.RouteAssistantOrsIntelligence
        global.RouteAssistantOrsIntelligence = undefined
        try {
            const out = await phase.postRun({
                server: "free1",
                enumerators: {async enumerateAllRoutes() { return [{hub: "X", dest: "Y"}] }}
            })
            assert.strictEqual(out.skipped, true)
            assert.ok(/ORS intelligence not loaded/.test(out.reason))
        } finally {
            global.RouteAssistantOrsIntelligence = savedIntel
        }
    })

    await it("ors-rank postRun returns reason when no routes are known", async () => {
        const phase = global.ScrapeOrchestratorPhases._orsRank()
        const out = await phase.postRun({
            server: "free1",
            enumerators: {async enumerateAllRoutes() { return [] }}
        })
        assert.strictEqual(out.skipped, true)
        assert.strictEqual(out.reason, "no routes")
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})().catch(e => {
    console.error(e)
    process.exit(1)
})
