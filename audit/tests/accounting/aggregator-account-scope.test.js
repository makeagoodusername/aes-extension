"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

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

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            if (keys == null) {
                const out = {}
                for (const [k, v] of store) out[k] = v
                return out
            }
            const list = Array.isArray(keys)
                ? keys
                : (typeof keys === "string" ? [keys] : Object.keys(keys || {}))
            const out = {}
            for (const k of list) if (store.has(k)) out[k] = store.get(k)
            return out
        }
    }
}

function install(storage, accountId) {
    global.window = global
    global.console = console
    global.__aesAccountId = accountId || null
    global.currentAccountIdSync = function () { return global.__aesAccountId || null }
    global.chrome = {storage: {local: storage}}
    global.AccountingSnapshotStore = {
        async loadLatest() { return null },
        async loadAllSisters() { return {leasing: null, capital: null, assets: null, cashflow: null} },
        async loadIndex() { return [] }
    }
}

function loadAggregator() {
    delete global.AccountingAggregator
    const src = fs.readFileSync(path.join(ROOT, "modules/accounting/aggregator.js"), "utf8")
    eval(src)
    assert.ok(global.AccountingAggregator, "AccountingAggregator exported")
    return global.AccountingAggregator
}

function topRoutes(accountId, dest) {
    return {
        hub: "JFK",
        server: "free1",
        accountId: accountId || null,
        scrapedAt: 1000,
        rows: [{destIata: dest, distanceKm: 1000, weeklyFlights: 7, profitPerWeek: 5000}]
    }
}

console.log("=== accounting aggregator account scope ===")

;(async function () {
    await it("prefers the active account's scoped topRoutes over legacy", async () => {
        const storage = makeChromeStore({
            "routeAssistant:topRoutes:JFK": topRoutes(null, "LEG"),
            "routeAssistant:topRoutes:acct:acctA:JFK": topRoutes("acctA", "AAA"),
            "routeAssistant:topRoutes:acct:acctB:JFK": topRoutes("acctB", "BBB")
        })
        install(storage, "acctA")
        const Aggregator = loadAggregator()

        const ledger = await Aggregator.loadUnifiedLedger("free1", "CFA")
        assert.deepStrictEqual(ledger.routes.map(r => r.destIata), ["AAA"])
    })

    await it("falls back to legacy instead of a sister account's scoped topRoutes", async () => {
        const storage = makeChromeStore({
            "routeAssistant:topRoutes:JFK": topRoutes(null, "LEG"),
            "routeAssistant:topRoutes:acct:acctB:JFK": topRoutes("acctB", "BBB")
        })
        install(storage, "acctA")
        const Aggregator = loadAggregator()

        const ledger = await Aggregator.loadUnifiedLedger("free1", "CFA")
        assert.deepStrictEqual(ledger.routes.map(r => r.destIata), ["LEG"])
    })

    await it("uses legacy only when no current account id is available", async () => {
        const storage = makeChromeStore({
            "routeAssistant:topRoutes:JFK": topRoutes("acctB", "LEG"),
            "routeAssistant:topRoutes:acct:acctB:JFK": topRoutes("acctB", "BBB")
        })
        install(storage, null)
        const Aggregator = loadAggregator()

        const ledger = await Aggregator.loadUnifiedLedger("free1", "CFA")
        assert.deepStrictEqual(ledger.routes.map(r => r.destIata), ["LEG"])
    })

    await it("drops legacy fallback when its account metadata belongs to a sister account", async () => {
        const storage = makeChromeStore({
            "routeAssistant:topRoutes:JFK": topRoutes("acctB", "LEG"),
            "routeAssistant:topRoutes:acct:acctB:JFK": topRoutes("acctB", "BBB")
        })
        install(storage, "acctA")
        const Aggregator = loadAggregator()

        const ledger = await Aggregator.loadUnifiedLedger("free1", "CFA")
        assert.deepStrictEqual(ledger.routes.map(r => r.destIata), [])
    })

    console.log("\naccounting aggregator account scope: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
