"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            if (keys == null) {
                const out = {}
                for (const [k, v] of store) out[k] = v
                return out
            }
            const list = Array.isArray(keys) ? keys : [keys]
            const out = {}
            for (const k of list) if (store.has(k)) out[k] = store.get(k)
            return out
        },
        async set(items) {
            for (const k in items) store.set(k, items[k])
        },
        async remove(keys) {
            for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
        },
        _store: store
    }
}

function loadModules(initialStore) {
    global.window = global
    global.__aesAccountId = "acct-test"
    global.currentAccountIdSync = () => "acct-test"
    global.acctKey = (prefix, suffix) => prefix + ":acct:acct-test" + (suffix ? ":" + suffix : "")
    global.chrome = {
        storage: {local: makeChromeStore(initialStore || {})}
    }
    global.AesDataBus = {emit() {}}
    global.AES = {
        getServerName() { return "free1" },
        getAirlineIdentity() { return "Test Air" }
    }

    delete global.RouteAssistantOrsScraper
    delete global.RouteAssistantOrsPriceIndex
    delete global.RouteAssistantOrsIntelligence

    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-scraper.js"), "utf8"))
    global.RouteAssistantOrsScraper = global.window.RouteAssistantOrsScraper

    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-price-index.js"), "utf8"))
    global.RouteAssistantOrsPriceIndex = global.window.RouteAssistantOrsPriceIndex

    global.RouteAssistantSchedulePageScraper = {
        async bulkLoadCache(routes) {
            const map = new Map()
            for (const r of routes || []) {
                const hub = String(r.hub || r[0]).toUpperCase()
                const dest = String(r.dest || r[1]).toUpperCase()
                const pk = hub + "-" + dest
                const rec = global.chrome.storage.local._store.get("routeAssistant:ticketPrice:acct:acct-test:" + pk)
                    || global.chrome.storage.local._store.get("routeAssistant:ticketPrice:" + pk)
                if (rec) map.set(pk, rec)
            }
            return map
        },
        async loadRecord(hub, dest) {
            const pk = String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
            return global.chrome.storage.local._store.get("routeAssistant:ticketPrice:acct:acct-test:" + pk)
                || global.chrome.storage.local._store.get("routeAssistant:ticketPrice:" + pk)
                || null
        }
    }

    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-intelligence.js"), "utf8"))
    global.RouteAssistantOrsIntelligence = global.window.RouteAssistantOrsIntelligence
    return {
        scraper: global.RouteAssistantOrsScraper,
        intelligence: global.RouteAssistantOrsIntelligence,
        store: global.chrome.storage.local._store
    }
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
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== route-assistant ORS intelligence ===")

;(async function () {
    await it("computeRanks stores audited own-detection confidence", () => {
        const {scraper} = loadModules()
        const conns = [
            {rating: 100, bookable: true, legs: [{flightCode: "AES 10"}]},
            {rating: 90, bookable: true, legs: [{flightCode: "AES 11"}]},
            {rating: 80, bookable: true, legs: [{flightCode: "CMP 1"}]}
        ]
        const out = scraper.computeRanks(conns, new Set(["AES 10"]), ["AES"], {
            flightNumbersSource: "route-sync-schedule-scrape"
        })
        assert.strictEqual(out.rankAny, 1)
        assert.strictEqual(out.oursDetection.flightNumbersSource, "route-sync-schedule-scrape")
        assert.strictEqual(out.oursDetection.matchedOwnLegs, 2)
        assert.strictEqual(out.oursDetection.exactFlightNumberMatches, 1)
        assert.strictEqual(out.oursDetection.prefixMatches, 1)
        assert.strictEqual(out.oursDetection.prefixFallbackOnly, false)

        const fallback = scraper.computeRanks(
            [{rating: 50, bookable: true, legs: [{flightCode: "AES 99"}]}],
            new Set(),
            ["AES"]
        )
        assert.strictEqual(fallback.oursDetection.prefixFallbackOnly, true)
    })

    await it("ORS scraper loadRecord prefers account scoped records and falls back to legacy", async () => {
        const {scraper, intelligence} = loadModules({
            "routeAssistant:ors:ICN-NRT": {
                hub: "ICN", dest: "NRT", scrapedAt: 100,
                params: {payload: "ECONOMY"},
                totalConnections: 1,
                rankAny: 3,
                connections: []
            },
            "routeAssistant:ors:acct:acct-test:ICN-HND": {
                hub: "ICN", dest: "HND", scrapedAt: 200,
                byClass: {ECONOMY: {scrapedAt: 200, totalConnections: 1, rankAny: 1, connections: []}},
                classesScraped: ["ECONOMY"]
            }
        })
        const legacy = await scraper.loadRecord("ICN", "NRT")
        const scoped = await scraper.loadRecord("ICN", "HND")
        assert.ok(legacy.byClass.ECONOMY, "legacy record migrated to byClass")
        assert.strictEqual(legacy.byClass.ECONOMY.rankAny, 3)
        assert.strictEqual(scoped.byClass.ECONOMY.rankAny, 1)
        const listed = await intelligence.listCachedRoutes("free1")
        assert.ok(listed.get("ICN-NRT").byClass.ECONOMY, "facade list migrates legacy records")
    })

    await it("facade coverage reports covered, stale, missing, and flown-null warning routes", async () => {
        const now = Date.now()
        const {intelligence} = loadModules({
            "routeAssistant:ors:acct:acct-test:ICN-NRT": {
                hub: "ICN", dest: "NRT", scrapedAt: now,
                byClass: {ECONOMY: {scrapedAt: now, totalConnections: 2, rankAny: 1, connections: [{legs: []}]}},
                classesScraped: ["ECONOMY"],
                oursDetection: {matchedOwnLegs: 1, carrierPrefixes: ["AES"], flightNumbersSource: "route-sync-schedule-scrape"}
            },
            "routeAssistant:ors:acct:acct-test:ICN-HND": {
                hub: "ICN", dest: "HND", scrapedAt: now - 10 * 86400000,
                byClass: {ECONOMY: {scrapedAt: now - 10 * 86400000, totalConnections: 1, rankAny: 2, connections: [{legs: []}]}},
                classesScraped: ["ECONOMY"]
            },
            "routeAssistant:ticketPrice:acct:acct-test:ICN-GMP": {
                hub: "ICN", dest: "GMP", scrapedAt: now, weeklyFlights: 7, flights: [{flightNumber: "AES 7"}]
            }
        })
        const svc = new intelligence("free1")
        const coverage = await svc.getCoverage([
            {hub: "ICN", dest: "NRT"},
            {hub: "ICN", dest: "HND"},
            {hub: "ICN", dest: "GMP"}
        ], {classesToScrape: ["ECONOMY"], staleMs: 7 * 86400000})

        assert.strictEqual(coverage.totalRoutes, 3)
        assert.strictEqual(coverage.coveredRoutes, 2)
        assert.deepStrictEqual(coverage.staleRoutes, ["ICN-HND"])
        assert.deepStrictEqual(coverage.missingRoutes, ["ICN-GMP"])
        assert.ok(coverage.warningRoutes.some(w => w.route === "ICN-GMP" && w.warning === "schedule-flown-no-ors"))
        assert.strictEqual(coverage.oursDetection.routesWithOwnMatches, 1)
    })

    await it("route snapshot carries an ORS price index from scraped connections", async () => {
        const now = Date.now()
        const {intelligence} = loadModules({
            "routeAssistant:ors:acct:acct-test:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                scrapedAt: now,
                byClass: {ECONOMY: {
                    scrapedAt: now,
                    totalConnections: 3,
                    rankAny: 2,
                    connections: [
                        {totalPrice: 100, legs: [{flightCode: "AES 1", isOurs: true}]},
                        {totalPrice: 130, legs: [{flightCode: "ANA 1", isOurs: false}]},
                        {totalPrice: 150, legs: [{flightCode: "JAL 1", isOurs: false}]}
                    ]
                }}
            }
        })
        const svc = new intelligence("free1")
        const snap = await svc.getRouteSnapshot("ICN", "NRT")
        assert.ok(snap.priceIndex, "priceIndex exists")
        assert.strictEqual(snap.priceIndex.competitorPricesByClass.Y, 140)
        assert.strictEqual(snap.priceIndex.competitorCountsByClass.Y, 2)
    })

    await it("planner prioritises active, watched, high-score, then remaining routes and estimates Wicket requests", async () => {
        const now = Date.now()
        const {intelligence} = loadModules({
            "routeAssistant:ticketPrice:acct:acct-test:ICN-ACT": {hub: "ICN", dest: "ACT", scrapedAt: now, weeklyFlights: 3}
        })
        const svc = new intelligence("free1")
        const plan = await svc.planSync([
            {hub: "ICN", dest: "ZZZ", score: 1},
            {hub: "ICN", dest: "HIG", score: 95},
            {hub: "ICN", dest: "WAT", watched: true},
            {hub: "ICN", dest: "ACT", score: 5}
        ], {classesToScrape: ["ECONOMY", "BUSINESS"], includeFresh: true, concurrency: 2, staggerMs: 1500})

        assert.deepStrictEqual(plan.routes.map(r => r.dest), ["ACT", "WAT", "HIG", "ZZZ"])
        assert.strictEqual(plan.estimatedRequests, 20) // 4 routes × (2 ORS classes × GET/POST + 1 schedule)
        assert.strictEqual(plan.requiredClasses.length, 2)
    })

    await it("default ORS sync classes include Cargo for analyser and autopricer freshness", () => {
        const {intelligence} = loadModules()
        assert.deepStrictEqual(intelligence._classes({}), ["ECONOMY", "BUSINESS", "FIRST", "CARGO"])
    })

    await it("scraper memo key does not let a prior Y-only scrape suppress Cargo repair", async () => {
        const {scraper} = loadModules()
        const s = new scraper("free1")
        const calls = []
        s._scrapeOneClass = async (_hub, _dest, params) => {
            calls.push(params.payload)
            return {
                classRecord: {
                    scrapedAt: Date.now(),
                    totalConnections: params.payload === "CARGO" ? 2 : 1,
                    rankAny: params.payload === "CARGO" ? 4 : 1,
                    connections: []
                },
                ourFlightIds: []
            }
        }
        const one = await s.scrape("ICN", "NRT", {classesToScrape: ["ECONOMY"]})
        const two = await s.scrape("ICN", "NRT", {classesToScrape: ["ECONOMY", "CARGO"]})
        assert.ok(one.byClass.ECONOMY, "first scrape stored economy")
        assert.ok(two.byClass.CARGO, "second scrape must not return stale economy-only memo")
        assert.deepStrictEqual(calls, ["ECONOMY", "ECONOMY", "CARGO"])
    })

    await it("saved ORS records persist a per-class pricing index", async () => {
        const {scraper, store} = loadModules()
        const rec = await scraper.saveRecord("ICN", "NRT", {
            byClass: {ECONOMY: {
                scrapedAt: 123,
                totalConnections: 3,
                rankAny: 1,
                ratingGapToTop: -3,
                connections: [
                    {rating: 96, totalPrice: 100, bookable: true, legs: [{flightCode: "AES 1", isOurs: true}]},
                    {rating: 94, totalPrice: 140, bookable: true, legs: [{flightCode: "ANA 11", isOurs: false}]},
                    {rating: 91, totalPrice: 160, bookable: true, legs: [{flightCode: "JAL 22", isOurs: false}]}
                ]
            }},
            classesScraped: ["ECONOMY"]
        })
        const saved = store.get(scraper._key("ICN", "NRT"))
        assert.ok(rec.pricingIndex, "returned record has pricingIndex")
        assert.ok(saved.pricingIndex, "stored record has pricingIndex")
        assert.strictEqual(saved.pricingIndex.competitorPricesByClass.Y, 150)
        assert.strictEqual(saved.pricingIndex.competitorCountsByClass.Y, 2)
        assert.strictEqual(saved.pricingIndex.byClass.Y.ownConnectionCount, 1)
    })

    await it("fresh route-sync flight numbers seed carrier prefixes before initials fallback", async () => {
        const {scraper} = loadModules()
        const s = new scraper("free1")
        let seenPrefixes = null
        s._scrapeOneClass = async (_hub, _dest, params, fnSet, prefixes) => {
            seenPrefixes = prefixes.slice()
            const connections = [{
                rating: 90,
                bookable: true,
                legs: [{flightCode: "AES 99"}]
            }]
            const summary = scraper.computeRanks(connections, fnSet, prefixes, {
                flightNumbersSource: params.flightNumbersSource
            })
            return {
                classRecord: Object.assign(summary, {connections}),
                ourFlightIds: []
            }
        }
        const rec = await s.scrape("ICN", "NRT", {
            classesToScrape: ["ECONOMY"],
            ourFlightNumbersOverride: new Set(["AES 10"])
        })
        assert.deepStrictEqual(seenPrefixes, ["AES"])
        assert.strictEqual(rec.byClass.ECONOMY.oursDetection.prefixMatches, 1)
        assert.strictEqual(rec.oursDetection.prefixFallbackOnly, true)
    })

    await it("rating observation logger reads account-scoped ownPricing through markets cache loader", async () => {
        const {scraper} = loadModules()
        let captured = null
        global.RouteAssistantRatingObservationStore = {
            async add(hub, dest, obs) { captured = {hub, dest, obs} }
        }
        global.RouteAssistantMarketsPageScraper = {
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {
                    ownPricing: {
                        scrapedAt: 123,
                        prices: {Y: 111, C: 222, F: 333, Cargo: 0.44},
                        generalSettings: {serviceProfile: "7"}
                    }
                }]])
            }
        }
        await scraper._logRatingObservation("free1", "ICN", "NRT", {
            scrapedAt: 456,
            byClass: {
                ECONOMY: {
                    ourTopRating: 88,
                    connections: [{legs: [{isGround: false, isOurs: true}]}]
                }
            }
        })
        assert.ok(captured, "observation should be added")
        assert.strictEqual(captured.obs.prices.Y, 111)
        assert.strictEqual(captured.obs.ratings.Y, 88)
        assert.strictEqual(captured.obs.pricingScrapedAt, 123)
        assert.strictEqual(captured.obs.comfortLevel, 7)
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})().catch(e => {
    console.error(e)
    process.exit(1)
})
