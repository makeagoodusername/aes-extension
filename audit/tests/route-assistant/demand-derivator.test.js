"use strict"

const assert = require("assert")
const path = require("path")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const Derivator = require(path.join(ROOT, "modules/route-assistant/demand-derivator.js"))

const historic = {
    scrapedAt: 1,
    byPayload: {
        ECONOMY: {periods: [1, 2, 3, 4], capacities: [100, 110, 120, 130], prices: [90, 100, 110, 120]},
        CARGO:   {periods: [1, 2, 3, 4], capacities: [900, 1000, 1100, 1200], prices: [0.70, 0.72, 0.74, 0.75]}
    }
}

const derived = Derivator.derive(historic, null, null, {window: 4})

assert.strictEqual(derived.paxAvgPrice, 105)
assert.strictEqual(derived.cargoAvgPrice, 0.73)
assert.strictEqual(derived.avgPriceByClass.Y, 105)
assert.strictEqual(derived.avgPriceByClass.Cargo, 0.73)

console.log("demand-derivator tests passed")
