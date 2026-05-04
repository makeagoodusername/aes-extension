"use strict"

/**
 * Regression smoke for modules/route-assistant/central-price-automator.js.
 *
 * The market-cache keys do not include server/world, so the automator must
 * check each cached record's embedded `server` before using it for a topRoute.
 */
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

function loadAutomator(marketBucket, extraStore, settingsOverride) {
    global.window = global
    global.__aesAccountId = "acct-test"
    delete global.RouteAssistantDemandStore
    delete global.RouteAssistantDemandDerivator
    delete global.RouteAssistantInventoryPageScraper
    delete global.RouteAssistantOrsScraper
    delete global.RouteAssistantOrsPriceIndex
    delete global.RouteAssistantYieldHistoryStore
    delete global.RouteAssistantPricingApplyLog
    delete global.RouteAssistantPricingApplier
    const store = Object.assign({
        "routeAssistant:topRoutes:ICN": {
            server: "free1",
            hub: "ICN",
            scrapedAt: Date.now(),
            rows: [{destIata: "NRT", destName: "Tokyo Narita"}]
        }
    }, extraStore || {})
    global.chrome = {
        storage: {local: makeChromeStore(store)},
        runtime: {onMessage: {addListener() {}}}
    }
    global.AES = {
        getServerName() { return "free1" },
        getAirlineCode() { return {code: "CFA"} }
    }
    const defaultSettings = {
        pricing: {
            silentAutoEnabled: false,
            silentAutoFollowMode: "watchlist",
            silentAutoStrategy: "competitor-median",
            silentAutoMinDeltaPct: 3,
            silentAutoMaxStepPct: 10,
            silentAutoMaxPerDay: 20,
            silentAutoMaxPerHour: 5,
            apply: {dryRunOnly: true}
        }
    }
    const settingsState = Object.assign({}, defaultSettings, settingsOverride || {})
    settingsState.pricing = Object.assign(
        {},
        defaultSettings.pricing,
        (settingsOverride && settingsOverride.pricing) || {}
    )
    settingsState.pricing.apply = Object.assign(
        {},
        defaultSettings.pricing.apply,
        (settingsOverride && settingsOverride.pricing && settingsOverride.pricing.apply) || {}
    )
    global.RouteAssistantSettings = {
        async load() {
            return JSON.parse(JSON.stringify(settingsState))
        },
        async save(partial) {
            if (partial && partial.pricing) settingsState.pricing = partial.pricing
            return JSON.parse(JSON.stringify(settingsState))
        }
    }
    global.RouteAssistantWatchlistStore = {
        async loadKeys() { return new Set(["ICN-NRT"]) }
    }
    global.RouteAssistantMarketsPageScraper = {
        async bulkLoadCache() {
            return marketBucket ? new Map([["ICN-NRT", marketBucket]]) : new Map()
        }
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

    delete global.AesRoutePriceAutomator
    delete global.RouteAssistantOrsPriceIndex
    const idxSrc = fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-price-index.js"), "utf8")
    eval(idxSrc)
    const src = fs.readFileSync(path.join(ROOT, "modules/route-assistant/central-price-automator.js"), "utf8")
    eval(src)
    assert.ok(global.AesRoutePriceAutomator, "automator exported")
    return global.AesRoutePriceAutomator
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
    }
}

console.log("=== central-price-automator ===")

;(async function () {
    await it("ignores same-pair market cache records from another server", async () => {
        const automator = loadAutomator({
            ownPricing: {server: "otherworld", prices: {Y: 100}, scrapedAt: Date.now()},
            competitors: {server: "otherworld", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: Date.now()}
        })
        const preview = await automator.preview({server: "free1"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "skipped")
        assert.strictEqual(row.reason, "no own pricing cached")
        assert.strictEqual(row.prices, null)
        assert.strictEqual(row.competitorYsCount, 0)
        assert.strictEqual(preview.counts.proposed, 0)
    })

    await it("uses account-scoped market cache records from the active server", async () => {
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: Date.now()},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: Date.now()}
        })
        const preview = await automator.preview({server: "free1"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.strictEqual(row.competitorMedianPriceY, 130)
        assert.deepStrictEqual(row.proposal.prices, {Y: 110})
        assert.strictEqual(preview.counts.proposed, 1)
    })

    await it("ignores fallback records scoped to another account", async () => {
        const automator = loadAutomator(null, {
            "routeAssistant:markets:ownPricing:acct:other-account:ICN-NRT": {
                server: "free1",
                prices: {Y: 100},
                scrapedAt: Date.now()
            },
            "routeAssistant:markets:competitors:acct:other-account:ICN-NRT": {
                server: "free1",
                competitors: [
                    {serviceClass: "Y", price: 120},
                    {serviceClass: "Y", price: 140}
                ],
                scrapedAt: Date.now()
            }
        })
        const preview = await automator.preview({server: "free1"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "skipped")
        assert.strictEqual(row.reason, "no own pricing cached")
        assert.strictEqual(preview.counts.proposed, 0)
    })

    await it("uses fallback records scoped to the active account", async () => {
        const automator = loadAutomator(null, {
            "routeAssistant:markets:ownPricing:acct:acct-test:ICN-NRT": {
                server: "free1",
                prices: {Y: 100},
                scrapedAt: Date.now()
            },
            "routeAssistant:markets:competitors:acct:acct-test:ICN-NRT": {
                server: "free1",
                competitors: [
                    {serviceClass: "Y", price: 120},
                    {serviceClass: "Y", price: 140}
                ],
                scrapedAt: Date.now()
            }
        })
        const preview = await automator.preview({server: "free1"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.deepStrictEqual(row.proposal.prices, {Y: 110})
        assert.strictEqual(preview.counts.proposed, 1)
    })

    await it("blocks upward auto-pricing when airborne route is weak on demand and ORS", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: now},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: now}
        }, {
            "free1CFAaircraftFlights1": {
                type: "aircraftFlights",
                server: "free1",
                airline: "CFA",
                registration: "HL-101",
                flights: [{
                    flightId: 77,
                    flightNumber: "CFA 77",
                    flightNumberId: 770,
                    status: "inflight",
                    originIata: "ICN",
                    destinationIata: "NRT",
                    depUtc: "2026-05-01 06:00"
                }]
            },
            "free1aircraftFlights1": {
                type: "aircraftFlights",
                server: "free1",
                airline: "CFA",
                registration: "HL-101",
                flights: [{
                    flightId: 77,
                    flightNumber: "CFA 77",
                    flightNumberId: 770,
                    status: "inflight",
                    originIata: "ICN",
                    destinationIata: "NRT",
                    depUtc: "2026-05-01 06:00"
                }]
            },
            "free1CFAflightInfo77": {money: {CM5: {Total: -5000}}}
        }, {
            demandDepth: {inventoryMaxAgeDays: 3, historicWindowPeriods: 12},
            pricing: {
                silentAutoFollowMode: "watchlist",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {dryRunOnly: true}
            }
        })
        global.RouteAssistantDemandStore = {
            async getMany() {
                return new Map([["NRT", {iata: "NRT", paxScore: 2, cargoScore: 3, scrapedAt: now}]])
            }
        }
        global.RouteAssistantOrsScraper = {
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {
                    scrapedAt: now,
                    byClass: {ECONOMY: {
                        rankAny: 18,
                        ourTopRating: 45,
                        topCompetitorRating: 70,
                        ratingGapToTop: -25
                    }}
                }]])
            }
        }
        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "skipped")
        assert.match(row.reason, /blocked upward move/)
        assert.strictEqual(row.activeFlightControls.inflight, 1)
        assert.strictEqual(row.controlVariables.airborne, true)
        assert.strictEqual(row.controlVariables.orsSevere, true)
        assert.strictEqual(preview.counts.proposed, 0)
    })

    await it("loads in-air return legs into dashboard route controls", async () => {
        const now = Date.now()
        const automator = loadAutomator(null, {
            "free1CFAaircraftFlights1": {
                type: "aircraftFlights",
                server: "free1",
                airline: "CFA",
                registration: "HL-101",
                flights: [{
                    flightId: 78,
                    flightNumber: "CFA 78",
                    flightNumberId: 780,
                    status: "inflight",
                    originIata: "NRT",
                    destinationIata: "ICN",
                    depUtc: "2026-05-01 08:00"
                }]
            },
            "free1CFAflightInfo78": {money: {CM5: {Total: -750}}}
        })

        const activeByRoute = await automator._private._loadAirborneByRoute({
            server: "free1",
            airline: "CFA"
        })
        const controls = activeByRoute.get("ICN-NRT")
        assert.ok(controls, "return leg controls exist for priced pair")
        assert.strictEqual(controls.inflight, 1)
        assert.strictEqual(controls.avgCm5, -750)
        assert.deepStrictEqual(controls.flightNumbers, ["CFA 78"])
        assert.deepStrictEqual(controls.sourcePairs, ["NRT-ICN"])

        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT preview row exists")
        assert.strictEqual(preview.counts.withActiveFlights, 1)
        assert.strictEqual(row.activeFlightControls.sourcePairs[0], "NRT-ICN")
    })

    await it("dampens discount proposals when demand is tight and ORS is strong", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: now},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 80},
                {serviceClass: "Y", price: 82}
            ], scrapedAt: now}
        }, null, {
            pricing: {
                silentAutoFollowMode: "watchlist",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {dryRunOnly: true}
            }
        })
        global.RouteAssistantSilentAutoProposers.dispatch = function(strategy, route, prices) {
            assert.strictEqual(strategy, "competitor-median")
            assert.deepStrictEqual(prices, {Y: 100})
            return {
                ok: true,
                dest: route.destIata,
                prices: {Y: 90},
                deltaPct: -10,
                prevY: 100,
                newY: 90,
                reason: "test discount"
            }
        }
        global.RouteAssistantDemandStore = {
            async getMany() {
                return new Map([["NRT", {iata: "NRT", paxScore: 9, cargoScore: 4, scrapedAt: now}]])
            }
        }
        global.RouteAssistantInventoryPageScraper = {
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {scrapedAt: now}]])
            }
        }
        global.RouteAssistantDemandDerivator = {
            derive() {
                return {rmTightness: 0.92, scrapedAt: now}
            }
        }
        global.RouteAssistantOrsScraper = {
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {
                    scrapedAt: now,
                    byClass: {ECONOMY: {
                        rankAny: 2,
                        ourTopRating: 98,
                        topCompetitorRating: 99,
                        ratingGapToTop: 1
                    }}
                }]])
            }
        }
        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.strictEqual(row.proposal.newY, 96)
        assert.ok(row.proposal.deltaPct > -5, "discount was damped below half")
        assert.strictEqual(row.controlVariables.demandStrong, true)
        assert.strictEqual(row.controlVariables.orsStrong, true)
        assert.match(row.reason, /controls/)
    })

    await it("interprets positive ORS rating gap as strong and negative gap as weak", async () => {
        const automator = loadAutomator(null)
        const strong = automator._private._composeControlVariables({
            destIata: "NRT",
            competitorCountsByClass: {Y: 5},
            orsControls: {ratingGapToTop: 20}
        }, "Y")
        const weak = automator._private._composeControlVariables({
            destIata: "NRT",
            competitorCountsByClass: {Y: 5},
            orsControls: {ratingGapToTop: -20}
        }, "Y")
        const fallbackWeak = automator._private._composeControlVariables({
            destIata: "NRT",
            competitorCountsByClass: {Y: 5},
            orsControls: {ourTopRating: 60, topCompetitorRating: 75}
        }, "Y")

        assert.strictEqual(strong.orsStrong, true, "positive gap should be a strong ORS signal")
        assert.strictEqual(strong.orsWeak, false, "positive gap must not be weak")
        assert.strictEqual(weak.orsSevere, true, "large negative gap should be severe")
        assert.strictEqual(fallbackWeak.ratingGapToTop, -15)
        assert.strictEqual(fallbackWeak.orsSevere, true)
    })

    await it("loads realised yield history into dashboard auto-pricing controls", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: now},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: now}
        }, null, {
            pricing: {
                silentAutoFollowMode: "watchlist",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {dryRunOnly: true}
            }
        })
        global.RouteAssistantYieldHistoryStore = {
            async getMany() {
                return new Map([["ICN-NRT", {
                    hub: "ICN",
                    dest: "NRT",
                    lastSnapshotAt: now,
                    snapshots: [
                        {timestamp: now - 86400000, profitPerFlight: 1000, profitPerWeek: 7000, frequency: 7},
                        {timestamp: now, profitPerFlight: -2500, profitPerWeek: -17500, frequency: 7,
                         attributionMode: "per-flight"}
                    ]
                }]])
            }
        }
        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.strictEqual(row.yieldControls.latestProfitPerFlight, -2500)
        assert.strictEqual(row.controlVariables.historyWeak, true)
        assert.strictEqual(row.proposal.newY, 107)
        assert.match(row.reason, /history/)
        assert.ok(row.pricingSignals.labels.includes("history"))
        assert.strictEqual(preview.counts.withYieldHistory, 1)
    })

    await it("feeds per-class competitor medians and demand controls into per-class auto-pricing", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100, C: 210, F: 520, Cargo: 0.75}, scrapedAt: now},
            competitors: {server: "free1", competitors: [
                {classKey: "Y", fare: 125},
                {bookingClass: "Economy", price: 135},
                {cabinClass: "Business", avgPrice: 170},
                {serviceClass: "C", price: 180},
                {payload: "FIRST", price: 620},
                {class: "F", price: 640},
                {isCargo: true, price: 0.90},
                {payloadClass: "CARGO", fare: 0.96}
            ], scrapedAt: now},
            historic: {
                server: "free1",
                scrapedAt: now,
                byPayload: {
                    ECONOMY:  {periods: [1, 2, 3, 4], capacities: [160, 170, 175, 180], prices: [96, 98, 100, 102]},
                    BUSINESS: {periods: [1, 2, 3, 4], capacities: [26, 24, 22, 20], prices: [220, 216, 212, 210]},
                    FIRST:    {periods: [1, 2, 3, 4], capacities: [10, 11, 12, 13], prices: [500, 510, 520, 530]},
                    CARGO:    {periods: [1, 2, 3, 4], capacities: [2000, 2200, 2300, 2400], prices: [0.70, 0.72, 0.74, 0.75]}
                }
            }
        }, null, {
            pricing: {
                silentAutoFollowMode: "watchlist",
                silentAutoStrategy: "per-class-elasticity",
                silentAutoMinDeltaPct: 1,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {dryRunOnly: true}
            },
            demandDepth: {historicWindowPeriods: 4}
        })
        const perClassSrc = fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposer-per-class.js"), "utf8")
        const proposerSrc = fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposers.js"), "utf8")
        delete global.RouteAssistantPerClassProposer
        delete global.RouteAssistantSilentAutoProposers
        delete global.RouteAssistantDemandDerivator
        global.RouteAssistantDemandDerivator = require(path.join(ROOT, "modules/route-assistant/demand-derivator.js"))
        eval(perClassSrc)
        eval(proposerSrc)
        global.RouteAssistantInventoryPageScraper = {
            _pairKey(hub, dest) { return String(hub).toUpperCase() + "-" + String(dest).toUpperCase() },
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {
                    scrapedAt: now,
                    classes: {
                        Y: {totalSeats: 200, soldSeats: 184},
                        C: {totalSeats: 50, soldSeats: 18},
                        F: {totalSeats: 14, soldSeats: 10},
                        Cargo: {totalSeats: 3000, soldSeats: 2700}
                    }
                }]])
            }
        }

        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.deepStrictEqual(row.competitorCountsByClass, {Y: 2, C: 2, F: 2, Cargo: 2})
        assert.strictEqual(row.competitorPricesByClass.Y, 130)
        assert.strictEqual(row.competitorPricesByClass.Cargo, 0.93)
        assert.strictEqual(row.demandControls.demandPoolByClass.Cargo, 2225)
        assert.strictEqual(row.demandControls.rmTightnessByClass.Y, 0.92)
        assert.strictEqual(row.demandControls.rmTightnessByClass.C, 0.36)
        assert.ok(row.proposal.prices.Y > 100, "Y should rise on strong economy demand")
        assert.ok(row.proposal.prices.C < 210, "C should fall on weak business demand/competitor band")
        assert.ok(row.proposal.prices.F > 520, "F should move independently from Y/C")
        assert.ok(row.proposal.prices.Cargo > 0.75, "Cargo should move independently on cargo demand")
        assert.ok(row.proposal.prices.Cargo < 10, "Cargo proposal should stay fractional")
        assert.match(row.proposal.reason, /per-class/)
    })

    await it("indexes ORS search prices into dashboard auto-pricing calculation", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: now},
            competitors: {server: "free1", competitors: [], scrapedAt: now}
        }, {
            "routeAssistant:topRoutes:ICN": {
                server: "free1",
                hub: "ICN",
                scrapedAt: now,
                rows: [{
                    destIata: "NRT",
                    destName: "Tokyo Narita",
                    paxDemandPool: 600,
                    paxElasticity: -1.2,
                    rmTightness: 0.65
                }]
            }
        }, {
            pricing: {
                silentAutoFollowMode: "watchlist",
                silentAutoStrategy: "per-class-elasticity",
                silentAutoMinDeltaPct: 1,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {dryRunOnly: true}
            }
        })
        delete global.RouteAssistantOrsPriceIndex
        eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-price-index.js"), "utf8"))
        eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/silent-auto-proposer-per-class.js"), "utf8"))
        global.RouteAssistantSilentAutoProposers = {
            dispatch(strategy, route, prices, cfg, ctx) {
                assert.strictEqual(strategy, "per-class-elasticity")
                return global.RouteAssistantPerClassProposer.propose(route, prices, cfg, ctx)
            }
        }
        global.RouteAssistantOrsScraper = {
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {
                    hub: "ICN",
                    dest: "NRT",
                    scrapedAt: now,
                    byClass: {ECONOMY: {
                        scrapedAt: now,
                        totalConnections: 3,
                        rankAny: 1,
                        ratingGapToTop: -3,
                        connections: [
                            {rating: 96, totalPrice: 100, bookable: true, legs: [{flightCode: "CFA 1", isOurs: true}]},
                            {rating: 94, totalPrice: 140, bookable: true, legs: [{flightCode: "ANA 11", isOurs: false}]},
                            {rating: 91, totalPrice: 160, bookable: true, legs: [{flightCode: "JAL 22", isOurs: false}]}
                        ]
                    }}
                }]])
            }
        }

        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.strictEqual(row.orsCompetitorPricesByClass.Y, 150)
        assert.strictEqual(row.orsCompetitorCountsByClass.Y, 2)
        assert.strictEqual(row.orsPressureByClass.Y, 2.57)
        assert.ok(row.pricingSignals.labels.includes("ORS-price"))
        assert.ok((row.proposal.rationale || []).some(s => /ORS Δ 2\.6%/.test(s)),
            "proposal rationale should include ORS pressure")
        assert.ok(row.proposal.prices.Y > 100, "Y should move toward ORS competitor median")
        assert.strictEqual(preview.counts.withOrsPriceIndex, 1)
    })

    await it("skips active manual price pins in dashboard auto-pricing", async () => {
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: Date.now()},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: Date.now()}
        }, {
            "routeAssistant:override:acct:acct-test:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                pricePin: 105,
                updatedAt: Date.now()
            }
        })
        const preview = await automator.preview({server: "free1"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "skipped")
        assert.strictEqual(row.reason, "manual price pin 105%")
        assert.strictEqual(row.manualPricePin, 105)
        assert.strictEqual(preview.counts.pinned, 1)
        assert.strictEqual(preview.counts.proposed, 0)
    })

    await it("does not count pinned routes as tick-eligible", async () => {
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: Date.now()},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: Date.now()}
        }, {
            "routeAssistant:override:acct:acct-test:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                pricePin: 105,
                updatedAt: Date.now()
            }
        })
        const result = await automator.runTick({server: "free1"}, {force: true, limit: 10})
        assert.strictEqual(result.eligible, 0)
        assert.strictEqual(result.skipped, 1)
        assert.strictEqual(result.proposed, 0)
        assert.strictEqual(result.error.code, "noProposals")
    })

    await it("configures dashboard auto mode for live all-route writes", async () => {
        const automator = loadAutomator(null)
        const saved = await automator.configureAutomaticLiveMode({
            followMode: "all",
            cooldowns: false,
            maxPerHour: 5
        })
        assert.strictEqual(saved.pricing.silentAutoEnabled, true)
        assert.strictEqual(saved.pricing.silentAutoFollowMode, "all")
        assert.strictEqual(saved.pricing.silentAutoMaxPerHour, 5)
        assert.strictEqual(saved.pricing.apply.enabled, true)
        assert.strictEqual(saved.pricing.apply.dryRunOnly, false)
        assert.strictEqual(saved.pricing.apply.liveScopes.silentAuto, true)
        assert.strictEqual(saved.pricing.apply.cooldownMinPerRoute, 0)
        assert.strictEqual(saved.pricing.apply.cooldownMinGlobal, 0)
    })

    await it("Cargo class control variables ignore passenger ORS rank/rating", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100, Cargo: 0.80}, scrapedAt: now},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: now}
        }, null, {
            pricing: {
                silentAutoFollowMode: "watchlist",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {dryRunOnly: true}
            }
        })
        global.RouteAssistantSilentAutoProposers.dispatch = function(strategy, route, prices) {
            return {
                ok: true,
                dest: route.destIata,
                prices: {Cargo: 0.90},
                deltaPct: 12,
                prevY: 100,
                newY: 100,
                reason: "cargo upward proposal"
            }
        }
        global.RouteAssistantDemandStore = {
            async getMany() {
                return new Map([["NRT", {iata: "NRT", paxScore: 2, cargoScore: 8, scrapedAt: now}]])
            }
        }
        global.RouteAssistantOrsScraper = {
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {
                    scrapedAt: now,
                    byClass: {ECONOMY: {
                        rankAny: 18,
                        ourTopRating: 45,
                        topCompetitorRating: 70,
                        ratingGapToTop: -25
                    }}
                }]])
            }
        }
        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        // Pax ORS is severely weak. Cargo's controls must not see orsSevere/orsWeak,
        // so the upward cargo proposal isn't damped or blocked by passenger ORS.
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.ok(row.proposal.prices.Cargo > 0.80, "cargo upward move survives despite weak pax ORS")
        const cargoControls = row.controlVariables
        // Controls echoed are the headline (Cargo) controls — pax ORS suppressed.
        assert.strictEqual(cargoControls.classKey, "Cargo")
        assert.strictEqual(cargoControls.orsSevere, false, "orsSevere must be false for cargo class")
        assert.strictEqual(cargoControls.orsWeak,   false, "orsWeak must be false for cargo class")
        assert.strictEqual(row.pricingSignals.byClass.Cargo.ors, false,
            "Cargo pricing signal must not inherit passenger ORS")
    })

    await it("Y class block does not kill an independent cargo move", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100, Cargo: 0.80}, scrapedAt: now},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: now}
        }, {
            "free1CFAaircraftFlights1": {
                type: "aircraftFlights",
                server: "free1",
                airline: "CFA",
                registration: "HL-101",
                flights: [{
                    flightId: 77,
                    flightNumber: "CFA 77",
                    flightNumberId: 770,
                    status: "inflight",
                    originIata: "ICN",
                    destinationIata: "NRT",
                    depUtc: "2026-05-01 06:00"
                }]
            },
            "free1aircraftFlights1": {
                type: "aircraftFlights",
                server: "free1",
                airline: "CFA",
                registration: "HL-101",
                flights: [{
                    flightId: 77,
                    flightNumber: "CFA 77",
                    flightNumberId: 770,
                    status: "inflight",
                    originIata: "ICN",
                    destinationIata: "NRT",
                    depUtc: "2026-05-01 06:00"
                }]
            },
            "free1CFAflightInfo77": {money: {CM5: {Total: -5000}}}
        }, {
            demandDepth: {inventoryMaxAgeDays: 3, historicWindowPeriods: 12},
            pricing: {
                silentAutoFollowMode: "watchlist",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {dryRunOnly: true}
            }
        })
        global.RouteAssistantSilentAutoProposers.dispatch = function(strategy, route, prices) {
            return {
                ok: true,
                dest: route.destIata,
                prices: {Y: 110, Cargo: 0.90},
                deltaPct: 10,
                prevY: 100,
                newY: 110,
                reason: "mixed Y+Cargo upward"
            }
        }
        global.RouteAssistantDemandStore = {
            async getMany() {
                return new Map([["NRT", {iata: "NRT", paxScore: 2, cargoScore: 8, scrapedAt: now}]])
            }
        }
        global.RouteAssistantOrsScraper = {
            async bulkLoadCache() {
                return new Map([["ICN-NRT", {
                    scrapedAt: now,
                    byClass: {ECONOMY: {
                        rankAny: 18,
                        ourTopRating: 45,
                        topCompetitorRating: 70,
                        ratingGapToTop: -25
                    }}
                }]])
            }
        }
        const preview = await automator.preview({server: "free1", airline: "CFA"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        // Y is airborne+orsSevere+demandWeak → Y must be dropped. But cargo
        // has its own healthy signal (cargoScore 8) and pax ORS shouldn't apply
        // to it, so cargo survives and becomes the headline.
        assert.strictEqual(row.stage, "proposed", row.reason)
        assert.strictEqual(row.proposal.prices.Y, undefined, "Y is blocked")
        assert.ok(row.proposal.prices.Cargo > 0.80, "cargo independent move survives")
        assert.strictEqual(row.proposal.headlineClass, "Cargo")
    })

    await it("counts posted dashboard tick results as applied", async () => {
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: Date.now()},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: Date.now()}
        }, null, {
            pricing: {
                silentAutoEnabled: true,
                silentAutoFollowMode: "all",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {
                    enabled: true,
                    dryRunOnly: false,
                    liveScopes: {silentAuto: true},
                    cooldownMinPerRoute: 0,
                    cooldownMinGlobal: 0
                }
            }
        })
        global.RouteAssistantPricingApplyLog = class {
            async countSilentAutoIn() { return {daily: 0, hourly: 0} }
        }
        global.RouteAssistantPricingApplier = class {
            static DEFAULT_SCOPE = {
                airportPair: true,
                flightNumbers: true,
                returnAirportPair: false,
                returnFlightNumbers: false
            }
            async apply() { return {status: "posted"} }
        }
        const tick = await automator.runTick({server: "free1"}, {force: true, maxRoutes: 1})
        assert.strictEqual(tick.applied, 1)
        assert.strictEqual(tick.blocked, 0)
        assert.strictEqual(tick.perRoute[0].applyStatus, "posted")
    })

    await it("marks live proposals as cooldown-blocked before posting", async () => {
        const now = Date.now()
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: now},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: now}
        }, null, {
            pricing: {
                silentAutoEnabled: true,
                silentAutoFollowMode: "all",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {
                    enabled: true,
                    dryRunOnly: false,
                    liveScopes: {silentAuto: true},
                    cooldownMinPerRoute: 60,
                    cooldownMinGlobal: 5
                }
            }
        })
        let constructedApplier = false
        global.RouteAssistantPricingApplyLog = class {
            async getLastSuccessGlobal() { return now - 60 * 1000 }
            async getLastSuccessMap() { return new Map([["ICN-NRT", now - 2 * 60 * 1000]]) }
            async countSilentAutoIn() { return {daily: 0, hourly: 0} }
        }
        global.RouteAssistantPricingApplier = class {
            static DEFAULT_SCOPE = {
                airportPair: true,
                flightNumbers: true,
                returnAirportPair: false,
                returnFlightNumbers: false
            }
            constructor() { constructedApplier = true }
            async apply() { throw new Error("should not post while cooldown is visible") }
        }

        const preview = await automator.preview({server: "free1"}, {limit: 10})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        assert.ok(row, "ICN-NRT row exists")
        assert.strictEqual(row.stage, "cooldown")
        assert.ok(/cooldown active/.test(row.reason), row.reason)
        assert.strictEqual(preview.counts.proposed, 0)
        assert.strictEqual(preview.counts.cooldownBlocked, 1)

        const tick = await automator.runTick({server: "free1"}, {force: true, maxRoutes: 1})
        assert.strictEqual(tick.applied, 0)
        assert.strictEqual(tick.blocked, 1)
        assert.strictEqual(tick.error.code, "cooldownActive")
        assert.strictEqual(tick.perRoute[0].stage, "cooldown")
        assert.strictEqual(constructedApplier, false)
    })

    await it("threads dry-run pricing gates into dashboard ticks", async () => {
        const constructed = []
        const applied = []
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: Date.now()},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: Date.now()}
        }, null, {
            pricing: {
                silentAutoEnabled: true,
                silentAutoFollowMode: "all",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {
                    enabled: true,
                    dryRunOnly: true,
                    liveScopes: {silentAuto: true},
                    cooldownMinPerRoute: 0,
                    cooldownMinGlobal: 0
                }
            }
        })
        global.RouteAssistantPricingApplyLog = class {
            async countSilentAutoIn() { return {daily: 0, hourly: 0} }
        }
        global.RouteAssistantPricingApplier = class {
            static DEFAULT_SCOPE = {
                airportPair: true,
                flightNumbers: true,
                returnAirportPair: false,
                returnFlightNumbers: false
            }
            constructor(server, opts) { constructed.push({server, opts}) }
            async apply(hub, dest, prices, opts) {
                applied.push({hub, dest, prices, opts})
                return {status: opts.dryRun ? "dry-run" : "posted"}
            }
        }
        const tick = await automator.runTick({server: "free1"}, {force: true, maxRoutes: 1})
        assert.strictEqual(tick.dryRun, true)
        assert.strictEqual(tick.applied, 1)
        assert.strictEqual(tick.simulated, 1)
        assert.strictEqual(tick.perRoute[0].applyStatus, "dry-run")
        assert.strictEqual(tick.perRoute[0].stage, "simulated")
        assert.strictEqual(constructed[0].opts.dryRunOnly, true)
        assert.strictEqual(constructed[0].opts.applyEnabled, true)
        assert.strictEqual(constructed[0].opts.liveScopes.silentAuto, true)
        assert.strictEqual(applied[0].opts.dryRun, true)
    })

    await it("forceDryRun makes dashboard preview and tick safe even when live gate is enabled", async () => {
        const applied = []
        const automator = loadAutomator({
            ownPricing: {server: "free1", prices: {Y: 100}, scrapedAt: Date.now()},
            competitors: {server: "free1", competitors: [
                {serviceClass: "Y", price: 120},
                {serviceClass: "Y", price: 140}
            ], scrapedAt: Date.now()}
        }, null, {
            pricing: {
                silentAutoEnabled: true,
                silentAutoFollowMode: "all",
                silentAutoStrategy: "competitor-median",
                silentAutoMinDeltaPct: 3,
                silentAutoMaxStepPct: 10,
                silentAutoMaxPerDay: 20,
                silentAutoMaxPerHour: 5,
                apply: {
                    enabled: true,
                    dryRunOnly: false,
                    liveScopes: {silentAuto: true},
                    cooldownMinPerRoute: 0,
                    cooldownMinGlobal: 0
                }
            }
        })
        global.RouteAssistantPricingApplyLog = class {
            async countSilentAutoIn() { return {daily: 0, hourly: 0} }
        }
        global.RouteAssistantPricingApplier = class {
            static DEFAULT_SCOPE = {
                airportPair: true,
                flightNumbers: true,
                returnAirportPair: false,
                returnFlightNumbers: false
            }
            async apply(hub, dest, prices, opts) {
                applied.push({hub, dest, prices, opts})
                return {status: opts.dryRun ? "dry-run" : "posted"}
            }
        }
        const preview = await automator.preview({server: "free1"}, {limit: 10, forceDryRun: true})
        assert.strictEqual(preview.state.dryRun, true)
        assert.strictEqual(preview.state.liveWrites, false)
        assert.strictEqual(preview.state.applyGate.forcedDryRun, true)

        const tick = await automator.runTick({server: "free1"}, {force: true, maxRoutes: 1, forceDryRun: true})
        assert.strictEqual(tick.dryRun, true)
        assert.strictEqual(tick.perRoute[0].applyStatus, "dry-run")
        assert.strictEqual(applied[0].opts.dryRun, true)
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})()
