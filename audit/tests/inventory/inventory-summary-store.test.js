"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..", "..", "..")

global.window = global
global.chrome = {
    storage: {
        local: {
            async get() {
                return {
                    "routeAssistant:inventory:JFK-LHR": {
                        hub: "JFK",
                        dest: "LHR",
                        scrapedAt: 1000,
                        classes: {
                            Y: {totalSeats: 100, soldSeats: 90},
                            C: {totalSeats: 20, soldSeats: 10},
                            F: {totalSeats: 10, soldSeats: 3},
                            Cargo: {totalSeats: 5000, soldSeats: 4200}
                        },
                        departures: [
                            {flight: "AES1", flightNumberId: 1, totalSeats: 130, sold: 103}
                        ]
                    }
                }
            }
        }
    }
}

const src = fs.readFileSync(path.join(ROOT, "modules/inventory/inventory-summary-store.js"), "utf8")
eval(src)

;(async function () {
    const {rows, totals} = await global.CentralInventorySummaryStore.loadAll({})
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].loads.Y, 0.9)
    assert.strictEqual(rows[0].loads.Cargo, 0.84)
    assert.strictEqual(rows[0].loads.cargo, 0.84)
    assert.strictEqual(rows[0].flightNumberCount, 1)
    assert.strictEqual(totals.flightNumberCount, 1)
    console.log("inventory summary store tests passed")
})().catch(err => {
    console.error(err && err.stack || err)
    process.exit(1)
})
