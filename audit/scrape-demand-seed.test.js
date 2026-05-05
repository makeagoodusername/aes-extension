"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

global.window = global
global.chrome = {
    storage: {
        local: {
            async get() { return {} },
            async set() {}
        }
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
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"))
    }
}

console.log("=== scrape demand-seed phase ===")

;(async function () {
    await it("registers demand-seed as opt-in phase before route fan-out", async () => {
        const phases = global.ScrapeOrchestratorPhases.all()
        const ids = phases.map(p => p.id)
        const phase = phases.find(p => p.id === "demand-seed")
        assert.ok(phase, "demand-seed phase exists")
        assert.strictEqual(phase.optional, true)
        assert.strictEqual(phase.defaultEnabled, false)
        assert.ok(ids.indexOf("foundation") < ids.indexOf("demand-seed"))
        assert.ok(ids.indexOf("demand-seed") < ids.indexOf("per-aircraft"))
        assert.ok(ids.indexOf("per-aircraft") < ids.indexOf("per-hub"))
        assert.ok(ids.indexOf("per-hub") < ids.indexOf("per-route"))
    })

    await it("dashboard bundle loads parallel-scanner before scrape orchestrator host", async () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))
        const dashboard = manifest.content_scripts.find(cs =>
            (cs.matches || []).some(m => m.includes("/app/enterprise/dashboard"))
        )
        assert.ok(dashboard, "dashboard content-script block exists")
        const js = dashboard.js || []
        const scanner = js.indexOf("modules/route-assistant/parallel-scanner.js")
        const phases = js.indexOf("modules/scrape-orchestrator/phases.js")
        const host = js.indexOf("modules/scrape-orchestrator/host.js")
        assert.ok(scanner >= 0, "parallel-scanner is loaded on dashboard")
        assert.ok(phases >= 0, "scrape phases are loaded on dashboard")
        assert.ok(host >= 0, "scrape host is loaded on dashboard")
        assert.ok(scanner < phases, "scanner loads before demand-seed phase")
        assert.ok(scanner < host, "scanner loads before scrape host")
    })

    await it("estimate accounts for one opt-in demand-seed postRun unit", async () => {
        const out = await global.ScrapeOrchestratorPhases.estimate({
            server: "free1",
            airline: "ZZ",
            enumerators: {
                async enumerateHubs() { return ["ICN", "NRT"] },
                async enumerateAircraft() { return [{aircraftId: "1"}] },
                async enumerateAllRoutes() { return [{hub: "ICN", dest: "NRT"}] },
                async enumerateCompetitorIds() { return ["42"] },
                async enumerateAirportsForFlightsFrom() { return ["ICN", "NRT"] }
            }
        })
        assert.strictEqual(out.demandSeed, 1)
    })

    await it("postRun calls RouteAssistantParallelScanner when present", async () => {
        const phase = global.ScrapeOrchestratorPhases._demandSeed()
        assert.deepStrictEqual(await phase.buildJobs({server: "free1"}), [])
        let call = null
        global.RouteAssistantParallelScanner = function (server, opts) {
            call = {server, opts}
            this.seedAllCountries = async () => ({
                phase: "done",
                total: 4,
                fetched: 3,
                airportsSeeded: 125,
                failedCountries: ["99"]
            })
        }

        const out = await phase.postRun({server: "free1"})

        assert.strictEqual(call.server, "free1")
        assert.strictEqual(call.opts.concurrency, 3)
        assert.strictEqual(call.opts.staggerMs, 1500)
        assert.strictEqual(out.ok, true)
        assert.strictEqual(out.countries, 4)
        assert.strictEqual(out.fetched, 3)
        assert.strictEqual(out.airportsSeeded, 125)
        assert.strictEqual(out.failedCountries, 1)
    })

    await it("postRun no-ops cleanly when scanner is absent", async () => {
        const phase = global.ScrapeOrchestratorPhases._demandSeed()
        delete global.RouteAssistantParallelScanner
        const out = await phase.postRun({server: "free1"})
        assert.strictEqual(out.skipped, true)
        assert.ok(/parallel-scanner not loaded/.test(out.reason))
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})().catch(e => {
    console.error(e)
    process.exit(1)
})
