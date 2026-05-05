"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            if (keys == null) return Object.fromEntries(store)
            const out = {}
            for (const k of Array.isArray(keys) ? keys : [keys]) {
                if (store.has(k)) out[k] = store.get(k)
            }
            return out
        },
        async set(items) {
            for (const k in items) store.set(k, items[k])
        }
    }
}

function loadAutomator() {
    global.window = global
    global.location = {pathname: "/test"}
    global.chrome = {
        storage: {local: makeChromeStore({})},
        runtime: {onMessage: {addListener() {}}}
    }
    global.AES = {
        getServerName() { return "free1" },
        getAirlineCode() { return {code: "CFA"} }
    }
    const settingsState = {
        pricing: {
            silentAutoEnabled: true,
            silentAutoTickMin: 30,
            apply: {dryRunOnly: true}
        }
    }
    global.RouteAssistantSettings = {
        async load() { return JSON.parse(JSON.stringify(settingsState)) },
        async save(partial) {
            if (partial && partial.pricing) settingsState.pricing = partial.pricing
            return JSON.parse(JSON.stringify(settingsState))
        }
    }
    delete global.AesRoutePriceAutomator
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/ors-price-index.js"), "utf8"))
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/central-price-automator.js"), "utf8"))
    return global.AesRoutePriceAutomator
}

(async () => {
    const automator = loadAutomator()
    const configured = await automator.configureAutomaticLiveMode({
        tickSec: 5,
        followMode: "all",
        maxPerDay: 0,
        maxPerHour: 0
    })
    assert.strictEqual(configured.pricing.silentAutoTickSec, 5)
    assert.strictEqual(automator.configFromSettings(configured).silentAutoTickMs, 5000)
    assert.strictEqual(automator.configFromSettings(configured).silentAutoTickLabel, "5 sec")
    assert.strictEqual(automator.describeSettings(configured, {}).tickMs, 5000)
    assert.strictEqual(automator.describeSettings(configured, {}).tickLabel, "5 sec")
    const staleMirror = {
        pricing: {
            silentAutoEnabled: true,
            silentAutoTickSec: 5,
            silentAutoTickMin: 30,
            apply: {dryRunOnly: true}
        }
    }
    assert.strictEqual(automator.configFromSettings(staleMirror).silentAutoTickMin, 5 / 60)
    assert.strictEqual(automator.describeSettings(staleMirror, {}).tickMin, 5 / 60)
    console.log("=== central-price-automator cadence ===")
    console.log("  ok  supports 5-second foreground silent-auto cadence")
})().catch(err => {
    console.error(err)
    process.exit(1)
})
