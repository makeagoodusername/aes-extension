"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

const root = path.resolve(__dirname, "../../..")
const code = fs.readFileSync(path.join(root, "content_inventory.js"), "utf8")

function loadInventoryContext() {
    const ctx = {
        console,
        window: {
            addEventListener() {}
        },
        chrome: {
            storage: {
                local: {
                    get() {},
                    set() {}
                }
            }
        },
        AES: {
            cleanInteger(value) {
                const n = parseInt(String(value || "").replace(/[^\d-]/g, ""), 10)
                return Number.isFinite(n) ? n : 0
            }
        }
    }
    vm.createContext(ctx)
    vm.runInContext(code, ctx)
    ctx.settings = {
        invPricing: {
            recommendation: {}
        }
    }
    return ctx
}

function price(current, defaultPrice) {
    return {
        currentPrice: current,
        defaultPrice,
        currentPricePoint: Math.round((current / defaultPrice) * 100)
    }
}

function flight(cmp, cap, bkd, fare, status) {
    return {
        cmp,
        cap,
        bkd,
        price: fare,
        status: status || "booked"
    }
}

function prices() {
    return {
        Y: price(100, 100),
        C: price(220, 220),
        F: price(500, 500),
        Cargo: price(70, 70)
    }
}

function summarize(analysis) {
    const out = {}
    for (const key of ["Y", "C", "F", "Cargo"]) {
        out[key] = {
            load: Math.round(analysis.getLoad(key) * 100),
            step: analysis.data[key].newPriceChange || 0,
            recommendation: analysis.data[key].recommendation,
            source: analysis.data[key].breakdown && analysis.data[key].breakdown.source
        }
    }
    return out
}

{
    const ctx = loadInventoryContext()
    const analysis = ctx.getAnalysis([
        flight("Y", 100, 84, 100),
        flight("C", 50, 38, 220),
        flight("F", 10, 7, 500),
        flight("Cargo", 100, 80, 70)
    ], prices(), {})
    const result = summarize(analysis)
    assert.strictEqual(result.Y.step, 0)
    assert.strictEqual(result.C.step, 0)
    assert.strictEqual(result.F.step, 0)
    assert.strictEqual(result.Cargo.step, 0)
}

{
    const ctx = loadInventoryContext()
    const analysis = ctx.getAnalysis([
        flight("Y", 120, 120, 100),
        flight("C", 40, 12, 220),
        flight("F", 12, 1, 500),
        flight("Cargo", 100, 80, 70)
    ], prices(), {})
    const result = summarize(analysis)
    assert.ok(result.Y.step > 0, result.Y.recommendation)
    assert.ok(result.C.step < 0, result.C.recommendation)
    assert.ok(result.F.step < 0, result.F.recommendation)
    assert.strictEqual(result.Cargo.step, 0)
}

{
    const ctx = loadInventoryContext()
    const analysis = ctx.getAnalysis([
        flight("Y", 120, 55, 100),
        flight("C", 40, 20, 220),
        flight("F", 12, 4, 500),
        flight("Cargo", 200, 190, 70)
    ], prices(), {})
    const result = summarize(analysis)
    assert.ok(result.Cargo.step > 0, result.Cargo.recommendation)
    assert.ok(result.Y.step < 0, result.Y.recommendation)
}

{
    const ctx = loadInventoryContext()
    const current = prices()
    current.Cargo = price(0.85, 0.85)
    const analysis = ctx.getAnalysis([
        flight("Cargo", 2000, 1980, 0.85),
        flight("Cargo", 2000, 1980, 0.85)
    ], current, {})
    const result = summarize(analysis)
    assert.ok(result.Cargo.step > 0, result.Cargo.recommendation)
    assert.ok(analysis.data.Cargo.newPrice > 0.85, "cargo should rise from 0.85")
    assert.ok(analysis.data.Cargo.newPrice < 1, "cargo should preserve decimal cents, got " + analysis.data.Cargo.newPrice)
    assert.strictEqual(typeof analysis.data.Cargo.breakdown.routeIndex, "number")
    assert.ok(analysis.data.Cargo.breakdown.routeStep > 0, "cargo route pressure should contribute to high-load demand")
}

{
    const ctx = loadInventoryContext()
    const current = prices()
    current.Y = price(110, 100)
    const analysis = ctx.getAnalysis([
        flight("Y", 100, 100, 100, "finished")
    ], current, {})
    const result = summarize(analysis)
    assert.strictEqual(analysis.data.Y.demandFallback, 1)
    assert.strictEqual(result.Y.source, "observed rows")
    assert.ok(result.Y.step > 0, result.Y.recommendation)
}

{
    const ctx = loadInventoryContext()
    assert.doesNotThrow(() => {
        const analysis = ctx.getAnalysis([
            flight("Y", 100, 80, 100)
        ], {
            Y: price(100, 100),
            Cargo: price(70, 70)
        }, {})
        assert.strictEqual(analysis.data.F.valid, 0)
        assert.strictEqual(analysis.data.F.recommendation, 0)
    })
}

{
    const ctx = loadInventoryContext()
    assert.doesNotThrow(() => {
        const diff = ctx.displayDifference(undefined, undefined)
        assert.strictEqual(diff.load, "-")
        assert.strictEqual(diff.price, "-")
        assert.strictEqual(ctx.displayHistoryLoad(undefined), "-")
        assert.strictEqual(ctx.displayHistoryPrice(undefined), "-")
        assert.strictEqual(ctx.historyDisplayTotal({}, "all"), "-")
    })
}

{
    const ctx = loadInventoryContext()
    assert.strictEqual(ctx.parseInventoryPrice("0.85 AS$", "Cargo"), 0.85)
    assert.strictEqual(ctx.parseInventoryPrice("1,234 AS$", "Y"), 1234)

    const current = prices()
    current.Cargo = price(0.85, 1.00)
    const analysis = ctx.getAnalysis([
        flight("Cargo", 2000, 1900, 0.85)
    ], current, {})
    assert.ok(analysis.data.Cargo.newPrice > 0.85, analysis.data.Cargo.recommendation)
    assert.ok(analysis.data.Cargo.newPrice < 10, "cargo new price stays fractional")
}

{
    const ctx = loadInventoryContext()
    const cells = [
        {innerText: ""},
        {innerText: "", querySelector(selector) {
            assert.strictEqual(selector, "a[href*='numbers']")
            return {innerText: "AS123"}
        }},
        {innerText: "2026-05-03"},
        {innerText: ""},
        {innerText: ""},
        {innerText: "Cargo"},
        {innerText: "2,000"},
        {innerText: "1,850"},
        {innerText: ""},
        {innerText: "0.85 AS$"},
        {innerText: "Booked"}
    ]
    const row = {
        querySelectorAll(selector) {
            assert.strictEqual(selector, "td")
            return cells
        }
    }
    const parsed = JSON.parse(JSON.stringify(ctx.getFlight(row)))
    assert.deepStrictEqual(parsed, {
        fltNr: "AS123",
        date: "2026-05-03",
        cmp: "Cargo",
        cap: 2000,
        bkd: 1850,
        price: 0.85,
        status: "Booked"
    })
}

console.log("inventory autopricer tests passed")
