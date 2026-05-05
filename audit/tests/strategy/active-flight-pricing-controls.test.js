"use strict"

/**
 * Strategy autopricer controls:
 *   - context.js attaches currently in-air route state from the existing
 *     aircraftFlights/flightInfo caches.
 *   - price-moves.js consumes that in-air state alongside demand + ORS so
 *     weak live outcomes can block/dampen passenger price hikes without
 *     incorrectly blocking independent cargo moves.
 */

const {loadModule, it, summary, assert} = require("./_helpers")

function installChromeStore(store) {
    global.chrome = {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) return Object.assign({}, store)
                    const list = Array.isArray(keys) ? keys : [keys]
                    const out = {}
                    for (const k of list) out[k] = store[k]
                    return out
                },
                async set(obj) { Object.assign(store, obj || {}) }
            }
        }
    }
}

function loadContextWithStore(store) {
    installChromeStore(store)
    return loadModule("modules/strategy/context.js", {
        AesFleetRoster: {
            async load() {
                return {
                    server: "free1",
                    airline: "CF",
                    aircraft: [{aircraftId: "AC1", registration: "N1", typeId: 1}]
                }
            }
        },
        RouteAssistantTypeSpecsStore: {
            async getMany() { return new Map([[1, {typeId: 1, seats: 180, cargoCapacity: 9000, range: 6000, speed: 840}]]) }
        },
        AesAfpFlightLogStore: {
            async weeklyBlockHours() { return null }
        },
        AccountingAggregator: {
            async loadUnifiedLedger() {
                return {
                    routes: [{
                        hub: "JFK", destIata: "LAX", distanceKm: 3980,
                        paxScore: 2, cargoScore: 8, weeklyFlights: 7,
                        ourPaxShare: 0.2, profitPerWeek: 25000,
                        status: "active", score: 10, snapshotAt: Date.now()
                    }],
                    aircraft: [],
                    periodActuals: {totals: {bankBalance: 1_000_000, netResult: 20_000}}
                }
            }
        }
    })
}

const priceWin = loadModule("modules/strategy/price-moves.js", {
    AesStrategy: {},
    AesStrategyObjective: {
        resolve(kind, custom) {
            return {
                kind: kind || "balanced",
                weights: custom || {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
            }
        }
    },
    AesOrsCompetitionWeight: {
        weightFromCompetitorCount(n) { return n > 0 ? 1 : 0.2 }
    }
})
const proposePriceMoves = priceWin.AesStrategy.proposePriceMoves

;(async function run() {
    await it("context attaches in-air route controls from aircraftFlights + flightInfo caches", async () => {
        const win = loadContextWithStore({
            "free1CFaircraftFlightsAC1": {
                type: "aircraftFlights",
                server: "free1",
                airline: "CF",
                aircraftId: "AC1",
                registration: "N1",
                flights: [
                    {flightId: 101, flightNumber: "CF100", flightNumberId: 9001,
                     status: "inflight", originIata: "JFK", destinationIata: "LAX",
                     depUtc: "03.05. 10:00"},
                    {flightId: 102, flightNumber: "CF101", flightNumberId: 9002,
                     status: "booked", originIata: "JFK", destinationIata: "LAX"}
                ]
            },
            "free1CFflightInfo101": {money: {CM5: {Total: -500}}},
            "free1ZZaircraftFlightsAC2": {
                type: "aircraftFlights",
                server: "free1",
                airline: "ZZ",
                aircraftId: "AC2",
                registration: "Z1",
                flights: [
                    {flightId: 201, flightNumber: "ZZ200", status: "inflight",
                     originIata: "JFK", destinationIata: "LAX"}
                ]
            },
            "free1ZZflightInfo201": {money: {CM5: {Total: 9999}}}
        })
        const snap = await win.AesStrategy.snapshot({server: "free1", airlineCode: "CF"})
        const route = snap.hubs[0].byRoute[0]
        assert.ok(route.activeFlightControls, "activeFlightControls attached")
        assert.strictEqual(route.activeFlightControls.inflight, 1)
        assert.strictEqual(route.activeFlightControls.avgCm5, -500)
        assert.deepStrictEqual(route.activeFlightControls.flightNumbers, ["CF100"])
        assert.deepStrictEqual(route.activeFlightControls.tailRegs, ["N1"])
    })

    await it("context attaches in-air return legs to the priced route", async () => {
        const win = loadContextWithStore({
            "free1CFaircraftFlightsAC1": {
                type: "aircraftFlights",
                server: "free1",
                airline: "CF",
                aircraftId: "AC1",
                registration: "N1",
                flights: [{
                    flightId: 103,
                    flightNumber: "CF102",
                    flightNumberId: 9003,
                    status: "inflight",
                    originIata: "LAX",
                    destinationIata: "JFK",
                    depUtc: "03.05. 14:00"
                }]
            },
            "free1CFflightInfo103": {money: {CM5: {Total: -750}}}
        })
        const snap = await win.AesStrategy.snapshot({server: "free1", airlineCode: "CF"})
        const route = snap.hubs[0].byRoute[0]
        assert.ok(route.activeFlightControls, "return leg controls attached")
        assert.strictEqual(route.activeFlightControls.inflight, 1)
        assert.strictEqual(route.activeFlightControls.avgCm5, -750)
        assert.deepStrictEqual(route.activeFlightControls.flightNumbers, ["CF102"])
        assert.deepStrictEqual(route.activeFlightControls.sourcePairs, ["LAX-JFK"])
    })

    await it("passenger hike is blocked when in-air route has weak demand and poor ORS", () => {
        const snap = {
            hubs: [{iata: "JFK", byRoute: [{
                dest: "LAX",
                profitPerWeek: 50000,
                paxScore: 2,
                cargoScore: 0,
                rmTightness: 0.42,
                competitor: {
                    priceMin: 130, priceMax: 140,
                    byClass: {Y: {priceMin: 130, priceMax: 140, samples: 12}},
                    flightCount: 12,
                    ourFlightCount: 0
                },
                ownPricing: {prices: {Y: 100}},
                orsByClass: {ECONOMY: {rankAny: 18, ratingGapToTop: -14}},
                activeFlightControls: {inflight: 1, avgCm5: -300}
            }]}]
        }
        const moves = proposePriceMoves(snap, {useJointTuner: false, deadband: 2})
        assert.ok(!moves.some(m => m.classKey === "Y"),
            "Y move should be blocked by in-air weak-demand/poor-ORS controls")
    })

    await it("cargo can still move independently when passenger ORS is poor", () => {
        const snap = {
            hubs: [{iata: "JFK", byRoute: [{
                dest: "LAX",
                profitPerWeek: 50000,
                paxScore: 2,
                cargoScore: 9,
                competitor: {
                    priceMin: 105, priceMax: 155,
                    byClass: {
                        Y:     {priceMin: 150, priceMax: 155, samples: 12},
                        Cargo: {priceMin: 106, priceMax: 110, samples: 8}
                    },
                    flightCount: 20,
                    ourFlightCount: 0
                },
                ownPricing: {prices: {Cargo: 100}},
                orsByClass: {ECONOMY: {rankAny: 18, ratingGapToTop: -14}},
                activeFlightControls: {inflight: 1, avgCm5: -300}
            }]}]
        }
        const moves = proposePriceMoves(snap, {useJointTuner: false, deadband: 2})
        const cargo = moves.find(m => m.classKey === "Cargo")
        assert.ok(cargo, "Cargo move should survive passenger ORS weakness")
        assert.ok(!/control:ORS/.test(cargo.rationale.join(" ")),
            "Cargo rationale must not cite passenger ORS controls")
    })

    await it("positive ORS rating gap does not dampen strategy passenger hikes", () => {
        const snap = {
            hubs: [{iata: "JFK", byRoute: [{
                dest: "LAX",
                profitPerWeek: 50000,
                paxScore: 9,
                cargoScore: 0,
                competitor: {
                    priceMin: 130, priceMax: 140,
                    byClass: {Y: {priceMin: 130, priceMax: 140, samples: 12}},
                    flightCount: 12,
                    ourFlightCount: 0
                },
                ownPricing: {prices: {Y: 100}},
                orsByClass: {ECONOMY: {ratingGapToTop: 20}}
            }]}]
        }
        const moves = proposePriceMoves(snap, {useJointTuner: false, deadband: 2})
        const y = moves.find(m => m.classKey === "Y")
        assert.ok(y, "Y move should survive positive ORS gap")
        assert.ok(!/control:ORS/.test(y.rationale.join(" ")),
            "Positive rating gap means strong ORS, not weak ORS")
    })

    summary("active-flight-pricing-controls")
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
