"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")
const vm = require("vm")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const source = fs.readFileSync(path.join(ROOT, "content_scheduling.js"), "utf8")
const prefix = source.split(";(function aesRouteAssistantMain")[0]

function loadHarness(url, selectorIata) {
    const parsed = new URL(url)
    const fakeSelect = {
        selectedIndex: 0,
        options: [{textContent: "Selected airport (" + selectorIata + ")", value: selectorIata}]
    }
    const ctx = {
        window: {location: {href: parsed.href, pathname: parsed.pathname}},
        document: {
            querySelector(sel) {
                return sel.indexOf("select") === 0 ? fakeSelect : null
            },
            querySelectorAll() {
                return []
            }
        }
    }
    vm.runInNewContext(prefix + "\nglobalThis.__AES_FF_SCHED = AES_FF_SCHED;", ctx)
    return ctx
}

function resolve(ctx) {
    for (const fn of ctx.__AES_FF_SCHED.ORIGIN_IATA_LOOKUPS) {
        const out = fn()
        if (out) return out.toUpperCase()
    }
    return null
}

console.log("=== Route Assistant scheduling origin detection ===")

{
    const ctx = loadHarness("https://free1.airlinesim.aero/app/com/scheduling/ICNNRT?6", "JFK")
    assert.strictEqual(ctx.readIataFromUrl(), "ICN")
    assert.strictEqual(resolve(ctx), "ICN", "specific route URL beats stale selected airport")
}

{
    const ctx = loadHarness("https://free1.airlinesim.aero/app/com/scheduling?origin=lax", "JFK")
    assert.strictEqual(ctx.readIataFromUrl(), "LAX")
    assert.strictEqual(resolve(ctx), "LAX", "origin query beats stale selected airport")
}

{
    const ctx = loadHarness("https://free1.airlinesim.aero/app/com/scheduling", "JFK")
    assert.strictEqual(ctx.readIataFromUrl(), null)
    assert.strictEqual(resolve(ctx), "JFK", "generic scheduling page still falls back to selected airport")
}

console.log("  ok  URL route pair wins before Wicket selector fallback")
console.log("\nRoute Assistant scheduling origin detection: 3 passed, 0 failed")
