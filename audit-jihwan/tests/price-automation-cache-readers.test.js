"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..")

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
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
    }
}

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            if (keys == null) return Object.fromEntries(store)
            const list = Array.isArray(keys) ? keys : [keys]
            const out = {}
            for (const key of list) if (store.has(key)) out[key] = store.get(key)
            return out
        },
        async set(items) {
            for (const key in items) store.set(key, items[key])
        },
        _store: store
    }
}

function loadRouteAssistantTile() {
    global.window = global
    global.__aesAccountId = "acct-live"
    global.CentralHubTile = class {}
    global.CentralHubTileRegistry = {register() {}}
    delete global.CentralHubRouteAssistantTile
    let src = fs.readFileSync(path.join(ROOT, "modules/central-hub/tiles/route-assistant-tile.js"), "utf8")
    src += "\n;window.CentralHubRouteAssistantTile = CentralHubRouteAssistantTile;\n"
    eval(src)
    return new window.CentralHubRouteAssistantTile()
}

function loadAutomator(store) {
    global.window = global
    global.__aesAccountId = "acct-live"
    global.chrome = {
        storage: {local: makeChromeStore(store)},
        runtime: {onMessage: {addListener() {}}}
    }
    global.AES = {
        getServerName() { return "free1" },
        getAirlineCode() { return {code: "AES"} }
    }
    global.RouteAssistantSettings = {
        async load() {
            return {
                pricing: {
                    silentAutoEnabled: true,
                    silentAutoFollowMode: "all",
                    silentAutoStrategy: "competitor-median",
                    silentAutoMinDeltaPct: 1,
                    silentAutoMaxStepPct: 10,
                    silentAutoMaxPerDay: 0,
                    silentAutoMaxPerHour: 0,
                    apply: {dryRunOnly: true}
                }
            }
        },
        async save() {}
    }
    global.RouteAssistantWatchlistStore = {
        async loadKeys() { return new Set() }
    }
    global.RouteAssistantMarketsPageScraper = {
        async bulkLoadCache() { return new Map() }
    }
    global.RouteAssistantSilentAutoProposers = {
        dispatch(strategy, route, prices) {
            assert.strictEqual(strategy, "competitor-median")
            assert.deepStrictEqual(prices, {Y: 100})
            return {
                ok: true,
                dest: route.destIata,
                prices: {Y: 110},
                deltaPct: 10,
                prevY: 100,
                newY: 110,
                reason: "test proposal"
            }
        }
    }
    delete global.RouteAssistantPricingApplier
    delete global.AesRoutePriceAutomator
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/central-price-automator.js"), "utf8"))
    return global.AesRoutePriceAutomator
}

console.log("=== price automation cache readers ===")

;(async () => {
    await it("Central Hub tile reads scoped, legacy, and exact topRoutes snapshots", async () => {
        const now = Date.now()
        const tile = loadRouteAssistantTile()
        tile._loadByPrefix = async () => [
            {
                key: "routeAssistant:topRoutes",
                suffix: "",
                value: {hub: "GMP", snapshotAt: now - 50, rows: [{destIata: "CJU"}]}
            },
            {
                key: "routeAssistant:topRoutes:ICN",
                suffix: "ICN",
                value: {hub: "ICN", snapshotAt: now - 20, rows: [{destIata: "NRT"}]}
            },
            {
                key: "routeAssistant:topRoutes:acct:acct-live:ICN",
                suffix: "acct:acct-live:ICN",
                value: {hub: "ICN", accountId: "acct-live", snapshotAt: now, rows: [{destIata: "HND"}]}
            },
            {
                key: "routeAssistant:topRoutes:acct:other:ICN",
                suffix: "acct:other:ICN",
                value: {hub: "ICN", accountId: "other", snapshotAt: now + 1, rows: [{destIata: "BAD"}]}
            },
            {
                key: "routeAssistant:topRoutes:perClass:ICN",
                suffix: "perClass:ICN",
                value: {hub: "ICN", snapshotAt: now + 2, rows: [{destIata: "BAD"}]}
            }
        ]

        const hubs = await tile._loadHubs()

        assert.strictEqual(hubs.length, 2)
        assert.deepStrictEqual(hubs.map(h => h.hub), ["ICN", "GMP"])
        assert.strictEqual(hubs[0].record.rows[0].destIata, "HND")
        assert.strictEqual(hubs[1].record.rows[0].destIata, "CJU")
    })

    await it("dashboard automator can seed route candidates from the exact global topRoutes key", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            "routeAssistant:topRoutes": {
                server: "free1",
                hub: "ICN",
                scrapedAt: now,
                rows: [{destIata: "NRT", destName: "Tokyo Narita"}]
            },
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                server: "free1",
                hub: "ICN",
                dest: "NRT",
                prices: {Y: 100},
                scrapedAt: now
            },
            "routeAssistant:markets:competitors:ICN-NRT": {
                server: "free1",
                hub: "ICN",
                dest: "NRT",
                competitors: [
                    {serviceClass: "Y", price: 120},
                    {serviceClass: "Y", price: 140}
                ],
                scrapedAt: now
            }
        })

        const preview = await automator.preview({server: "free1"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")

        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.source, "topRoutes")
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.strictEqual(row.competitorMedianPriceY, 130)
        assert.deepStrictEqual(row.proposal.prices, {Y: 110})
        assert.strictEqual(preview.counts.proposed, 1)
    })

    console.log("\nprice automation cache readers: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
