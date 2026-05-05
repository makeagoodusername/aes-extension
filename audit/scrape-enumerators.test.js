"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

function makeChromeStore(initial) {
    return {
        async get() { return initial || {} }
    }
}

global.window = global

const src = fs.readFileSync(path.join(ROOT, "modules/scrape-orchestrator/enumerators.js"), "utf8")
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

console.log("=== scrape-orchestrator enumerators ===")

;(async function () {
    await it("derives hubs from aircraftFlights when fleet locations are blank", async () => {
        global.chrome = {
            storage: {
                local: makeChromeStore({
                    free1CFLAIRaircraftFleet: {
                        type: "aircraftFleet",
                        airline: "CFLAIR",
                        fleet: [{aircraftId: "1", location: ""}]
                    },
                    free1CFLAIRaircraftFlights1: {
                        type: "aircraftFlights",
                        server: "free1",
                        airline: "CFLAIR",
                        flights: [
                            {originIata: "JFK", destinationIata: "LHR"},
                            {originIata: "JFK", destinationIata: "CDG"},
                            {originIata: "FCO", destinationIata: "JFK"}
                        ]
                    }
                })
            }
        }

        const hubs = await global.ScrapeOrchestratorEnumerators.enumerateHubs("free1", "CFLAIR")

        assert.deepStrictEqual(hubs, ["CDG", "FCO", "JFK", "LHR"])
    })

    await it("prefers nonblank fleet locations over aircraftFlights fallback", async () => {
        global.chrome = {
            storage: {
                local: makeChromeStore({
                    free1CFLAIRaircraftFleet: {
                        type: "aircraftFleet",
                        airline: "CFLAIR",
                        fleet: [{aircraftId: "1", location: "JFK"}]
                    },
                    free1CFLAIRaircraftFlights1: {
                        type: "aircraftFlights",
                        server: "free1",
                        airline: "CFLAIR",
                        flights: [{originIata: "LHR", destinationIata: "CDG"}]
                    }
                })
            }
        }

        const hubs = await global.ScrapeOrchestratorEnumerators.enumerateHubs("free1", "CFLAIR")

        assert.deepStrictEqual(hubs, ["JFK"])
    })

    await it("falls back to flight records when host airline reports a short code", async () => {
        global.chrome = {
            storage: {
                local: makeChromeStore({
                    free1CFLAIRaircraftFleet: {
                        type: "aircraftFleet",
                        airline: "CFLAIR",
                        fleet: [{aircraftId: "1", location: ""}]
                    },
                    free1CFLAIRaircraftFlights1: {
                        type: "aircraftFlights",
                        server: "free1",
                        airline: "CFLAIR",
                        flights: [
                            {originIata: "JFK", destinationIata: "LHR"},
                            {originIata: "LHR", destinationIata: "JFK"}
                        ]
                    }
                })
            }
        }

        const hubs = await global.ScrapeOrchestratorEnumerators.enumerateHubs("free1", "CFA")

        assert.deepStrictEqual(hubs, ["JFK", "LHR"])
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})().catch(e => {
    console.error(e)
    process.exit(1)
})
