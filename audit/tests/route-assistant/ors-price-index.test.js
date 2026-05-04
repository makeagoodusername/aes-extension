"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function loadIndex() {
    global.window = global
    delete global.RouteAssistantOrsPriceIndex
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-price-index.js"), "utf8"))
    return global.RouteAssistantOrsPriceIndex
}

let pass = 0
let fail = 0
function it(name, fn) {
    try {
        fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== ORS price index ===")

it("indexes ORS connection prices by cabin and separates own from competitors", () => {
    const idx = loadIndex()
    const now = Date.now()
    const rec = {
        hub: "ICN",
        dest: "NRT",
        scrapedAt: now,
        byClass: {
            ECONOMY: {
                scrapedAt: now,
                totalConnections: 4,
                rankAny: 2,
                ratingGapToTop: -4,
                connections: [
                    {rating: 100, totalPrice: 100, bookable: true,
                     legs: [{flightCode: "CFA 1", isOurs: true}]},
                    {rating: 98, totalPrice: 140, bookable: true,
                     legs: [{flightCode: "ANA 1", isOurs: false}]},
                    {rating: 95, totalPrice: 160, bookable: true,
                     legs: [{flightCode: "JAL 2", isOurs: false}]},
                    {rating: 80, totalPrice: 180, bookable: true,
                     legs: [{flightCode: "ANA 9", isOurs: false}, {flightCode: "JAL 9", isOurs: false}]}
                ]
            },
            BUSINESS: {
                scrapedAt: now,
                totalConnections: 2,
                rankAny: 1,
                ratingGapToTop: 3,
                connections: [
                    {rating: 99, totalPrice: 240, bookable: true,
                     legs: [{flightCode: "CFA 3", isOurs: true}]},
                    {rating: 91, totalPrice: 300, bookable: true,
                     legs: [{flightCode: "ANA 3", isOurs: false}]}
                ]
            }
        }
    }

    const out = idx.indexRecord(rec, {currentPrices: {Y: 100, C: 250}})
    assert.strictEqual(out.pairKey, "ICN-NRT")
    assert.strictEqual(out.competitorPricesByClass.Y, 160)
    assert.strictEqual(out.competitorCountsByClass.Y, 3)
    assert.strictEqual(out.ownPricesByClass.Y, 100)
    assert.strictEqual(out.classes.Y.nonstopCompetitor.median, 150)
    assert.strictEqual(out.classes.Y.deltaToCurrentPct, 60)
    assert.strictEqual(out.classes.Y.competitorMedianPrice, 160)
    assert.strictEqual(out.classes.Y.competitorCarrierCount, 2)
    assert.strictEqual(out.orsPressureByClass.Y, 1.26)
    assert.strictEqual(out.competitorPricesByClass.C, 300)
    assert.strictEqual(out.classes.C.ratingGapToTop, 3)
    assert.strictEqual(out.orsPressureByClass.C, 3.7)
})

it("falls back to summed leg prices when totalPrice is absent", () => {
    const idx = loadIndex()
    const out = idx.indexRecord({
        hub: "JFK",
        dest: "BOS",
        byClass: {
            ECONOMY: {
                connections: [
                    {rating: 90, legs: [{flightCode: "AA 1", price: 55}, {flightCode: "AA 2", price: 65}]}
                ]
            }
        }
    }, {currentPrices: {Y: 100}})
    assert.strictEqual(out.competitorPricesByClass.Y, 120)
    assert.strictEqual(out.classes.Y.topConnections[0].carrierPrefixes[0], "AA")
})

console.log("\nors-price-index: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)
