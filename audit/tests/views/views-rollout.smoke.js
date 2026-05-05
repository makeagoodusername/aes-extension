"use strict"

/**
 * Smoke test for the 5 reserved views shipped in the Layer 2 rollout.
 *
 * Strategy: stub `window`, `chrome.storage.local`, `AesView.declare`, and the
 * domain-store classes; eval each view file; capture the compute function;
 * exercise it against fixture storage; assert the output shape.
 *
 * Run: `node audit/tests/views/views-rollout.smoke.js`
 */
const fs = require("fs")
const path = require("path")
const vm = require("vm")

let pass = 0, fail = 0
function ok(label, cond, detail) {
    if (cond) { pass++; console.log("PASS", label) }
    else      { fail++; console.error("FAIL", label, detail || "") }
}

function buildSandbox(extras) {
    const declared = {}
    const ctx = {
        console, setTimeout, clearTimeout, Promise,
        Date, Math, Number, JSON, Array, Object, String, RegExp,
        chrome: extras.chrome || {},
        AES:    extras.AES    || {},
        AesView: {
            declare: (opts) => { declared[opts.name] = opts },
            get:     (n) => extras.viewValues && extras.viewValues[n],
            subscribe: () => () => {},
            invalidate: () => {},
            list:    () => []
        },
        AesDataBus: {
            last:    (t) => extras.busLast && extras.busLast[t],
            peek:    () => undefined,
            publish: () => {}, emit: () => {}, on: () => () => {}
        }
    }
    Object.assign(ctx, extras.globals || {})
    ctx.window = ctx
    return {ctx, declared}
}

function loadView(rel, sandbox) {
    const file = path.join(__dirname, "..", "..", "..", rel)
    const src  = fs.readFileSync(file, "utf8")
    vm.createContext(sandbox.ctx)
    vm.runInContext(src, sandbox.ctx, {filename: rel})
}

// ─── fleet:wear-rollup ──────────────────────────────────────────────────────
{
    const fixtureRoster = {aircraft: [
        {aircraftId: 1, age: 5},
        {aircraftId: 2, age: 12},
        {aircraftId: 3, age: 7}
    ]}
    const fixtureMaint = {
        1: {ratio: 50, condition: 90, ratioStatus: "ok",   conditionStatus: "ok",   scrapedAt: 1000},
        2: {ratio: 85, condition: 60, ratioStatus: "warn", conditionStatus: "warn", scrapedAt: 2000},
        3: {ratio: null, condition: null, ratioStatus: null, conditionStatus: null, scrapedAt: 1500}
    }
    const sb = buildSandbox({
        AES: {getServer: () => "FREE1", getAirlineIdentity: () => "SkyAir"},
        globals: {
            AesFleetRoster: {load: async () => fixtureRoster},
            AesAfpMaintenanceStore: {load: async (s, id) => fixtureMaint[id]}
        }
    })
    loadView("modules/_shared/views/fleet-wear-rollup.js", sb)
    const v = sb.declared["fleet:wear-rollup"]
    ok("wear-rollup declared",        !!v, v)
    ok("wear-rollup deps include maintenance",
        v && v.deps.includes("data:afp:maintenance:updated"))
    v.compute().then((val) => {
        ok("wear-rollup totalTails=3",     val.totalTails === 3, val)
        ok("wear-rollup wearStressCount=1", val.wearStressCount === 1)
        ok("wear-rollup oldestAgeYears=12", val.oldestAgeYears === 12)
        ok("wear-rollup fleetWearAvg=67.5", Math.abs(val.fleetWearAvg - 67.5) < 0.01)
        ok("wear-rollup byTail size=3",    Object.keys(val.byTail).length === 3)
        ok("wear-rollup scrapedAt=2000",   val.scrapedAt === 2000)
    })
}

// ─── strategy:current-decision ──────────────────────────────────────────────
{
    const storage = {
        "aesStrategy:dispatchPending": {decisionId: "d1", domain: "price", payload: {hub: "JFK"}, requestedAt: 5000, source: "panel"},
        "aesStrategy:plan:applied":    {planId: "p1", ts: 3000, server: "FREE1", airlineCode: "SK", tier: "suggest", totalOk: 2, totalFailed: 0}
    }
    const sb = buildSandbox({
        chrome: {storage: {local: {get: async (keys) => {
            const out = {}
            for (const k of keys) if (k in storage) out[k] = storage[k]
            return out
        }}}}
    })
    loadView("modules/_shared/views/strategy-current-decision.js", sb)
    const v = sb.declared["strategy:current-decision"]
    ok("current-decision declared", !!v)
    v.compute().then((val) => {
        ok("current-decision pending newer→inFlight",        val.inFlight === true, val)
        ok("current-decision pending decisionId=d1",         val.pending && val.pending.decisionId === "d1")
        ok("current-decision applied tier=suggest",          val.applied && val.applied.tier === "suggest")
        ok("current-decision nextAction=awaiting-user-apply", val.nextAction === "awaiting-user-apply")
        // Reverse: pending older than applied → not inFlight (mutate AFTER first
        // compute resolves so the async read sees the original snapshot).
        storage["aesStrategy:dispatchPending"].requestedAt = 1000
        v.compute().then((val2) => {
            ok("current-decision pending older→not inFlight", val2.inFlight === false)
            ok("current-decision nextAction=already-applied", val2.nextAction === "already-applied")
        })
    })
}

// ─── enterprise:financial-rollup (computeRunway / burnTrend behaviors) ─────
{
    const idx = []
    for (let i = 0; i < 6; i++) idx.push({weekId: "W" + (10 - i), weekClosesAt: 1000 + i})
    const storage = {"FREE1Skyaccounting:index": idx}
    // Worsening burn: avg recent (-2000, -3000, -4000) vs prior (-500, -800, -1000)
    // Recent avg = -3000, prior avg = -766.67 → worsening
    // Cash 60000 / burn 3000 = 20 weeks
    storage["FREE1Skyaccounting:bank:W10"]   = {payload: {cashBalance: 60000}, scrapedAt: 9000}
    storage["FREE1Skyaccounting:income:W10"] = {payload: {totals: {ebt: {current: -2000}}}}
    storage["FREE1Skyaccounting:income:W9"]  = {payload: {totals: {ebt: {current: -3000}}}}
    storage["FREE1Skyaccounting:income:W8"]  = {payload: {totals: {ebt: {current: -4000}}}}
    storage["FREE1Skyaccounting:income:W7"]  = {payload: {totals: {ebt: {current:  -500}}}}
    storage["FREE1Skyaccounting:income:W6"]  = {payload: {totals: {ebt: {current:  -800}}}}
    storage["FREE1Skyaccounting:income:W5"]  = {payload: {totals: {ebt: {current: -1000}}}}
    const sb = buildSandbox({
        AES: {getServer: () => "FREE1", getAirlineIdentity: () => "Sky"},
        chrome: {storage: {local: {get: async (keys) => {
            const out = {}
            const arr = Array.isArray(keys) ? keys : Object.keys(keys || {})
            for (const k of arr) if (k in storage) out[k] = storage[k]
            return out
        }}}}
    })
    loadView("modules/_shared/views/enterprise-financial-rollup.js", sb)
    const v = sb.declared["enterprise:financial-rollup"]
    ok("financial-rollup declared", !!v)
    v.compute().then((val) => {
        ok("financial-rollup netCash=60000",  val.netCash === 60000, val)
        ok("financial-rollup runwayWeeks=20", val.runwayWeeks === 20, "got " + val.runwayWeeks)
        ok("financial-rollup burnTrend=worsening", val.burnTrend === "worsening", "got " + val.burnTrend)
        ok("financial-rollup trend length=6",  val.trend.length === 6)
    })
}

// ─── enterprise:freshness (TTL classification) ─────────────────────────────
{
    const sb = buildSandbox({
        AES: {getServer: () => "", getAirlineIdentity: () => ""},
        chrome: {storage: {local: {get: async () => ({})}}}
    })
    loadView("modules/_shared/views/enterprise-freshness.js", sb)
    const v = sb.declared["enterprise:freshness"]
    ok("freshness declared", !!v)
    v.compute().then((val) => {
        ok("freshness fuel.isStale (no scrape)",      val.fuel && val.fuel.isStale === true)
        ok("freshness scanner.isStale (no scan)",     val.scanner && val.scanner.isStale === true)
        ok("freshness has scrapedAt",                  Number.isFinite(val.scrapedAt))
        ok("freshness TTL exposed on globals",         sb.ctx.AES_FRESHNESS_TTL_MS && sb.ctx.AES_FRESHNESS_TTL_MS.fuel === 4 * 60 * 60 * 1000)
    })
}

// ─── scanner:current-deals (best-deal selection) ───────────────────────────
{
    const session = {scanId: "s1", server: "FREE1", presetName: "wide-body", status: "done", startedAt: 1000, finishedAt: 5000}
    const results = {
        "Airbus A320": {type: "Airbus A320", scrapedAt: 4000, rows: [
            {type: "Airbus A320", family: "A320", acquisitionPrice: 30000000, breakEvenDays: 800, seatKmYearCost: 0.05}
        ]},
        "Boeing 737":  {type: "Boeing 737", scrapedAt: 4500, rows: [
            {type: "Boeing 737", family: "737", acquisitionPrice: 28000000, breakEvenDays: 700, seatKmYearCost: 0.04},
            {type: "Boeing 737", family: "737", acquisitionPrice: 26000000, breakEvenDays: 750, seatKmYearCost: 0.06}
        ]}
    }
    const allStorage = {"FREE1marketScan:s1": session}
    const sb = buildSandbox({
        AES: {getServer: () => "FREE1"},
        chrome: {storage: {local: {get: async (keys) => {
            if (keys === null) return allStorage
            const out = {}
            const arr = Array.isArray(keys) ? keys : [keys]
            for (const k of arr) if (k in allStorage) out[k] = allStorage[k]
            return out
        }}}},
        globals: {MarketScanSession: {loadResults: async () => results}}
    })
    loadView("modules/_shared/views/scanner-current-deals.js", sb)
    const v = sb.declared["scanner:current-deals"]
    ok("current-deals declared", !!v)
    v.compute().then((val) => {
        ok("current-deals scanId=s1",          val.scanId === "s1", val)
        ok("current-deals dealsCount=3",       val.dealsCount === 3)
        ok("current-deals best is 737 0.04",   val.bestDeal && val.bestDeal.type === "Boeing 737" && val.bestDeal.seatKmYearCost === 0.04)
        ok("current-deals scrapedAt=5000",     val.scrapedAt === 5000)
    })
}

// flush microtasks then summarise
setTimeout(() => {
    console.log("\n" + pass + " pass, " + fail + " fail")
    process.exit(fail ? 1 : 0)
}, 100)
