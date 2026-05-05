"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

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

function loadSettingsStore() {
    global.window = global
    delete global.RouteAssistantSettings
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/settings-store.js"), "utf8"))
    return global.RouteAssistantSettings
}

function loadBackgroundAlarmHelpers() {
    global.chrome = {
        runtime: {
            lastError: null,
            onInstalled: {addListener() {}},
            onStartup: {addListener() {}}
        },
        storage: {
            local: {async get() { return {settings: {}} }},
            onChanged: {addListener() {}}
        },
        alarms: {
            onAlarm: {addListener() {}},
            async get() { return null },
            async clear() { return true },
            create() {}
        },
        tabs: {query() {}}
    }
    const src = fs.readFileSync(path.join(ROOT, "modules/_background/silent-auto-alarm.js"), "utf8")
        + "\nglobal.__aesSilentAutoConfigFromSettings = _aesSilentAutoConfigFromSettings;"
        + "\nglobal.__aesSilentAutoTickMin = _aesSilentAutoTickMin;"
    eval(src)
    return {
        configFromSettings: global.__aesSilentAutoConfigFromSettings,
        tickMin: global.__aesSilentAutoTickMin
    }
}

function loadCentralAutomator() {
    global.window = global
    global.__aesAccountId = "acct-1"
    global.location = {pathname: "/app/enterprise/dashboard"}
    const storage = {}
    global.chrome = {
        storage: {local: {
            async get(keys) {
                if (keys == null) return JSON.parse(JSON.stringify(storage))
                const out = {}
                const arr = Array.isArray(keys) ? keys : [keys]
                for (const k of arr) {
                    if (Object.prototype.hasOwnProperty.call(storage, k)) out[k] = storage[k]
                }
                return JSON.parse(JSON.stringify(out))
            },
            async set(items) { Object.assign(storage, JSON.parse(JSON.stringify(items || {}))) }
        }},
        runtime: {onMessage: {addListener() {}}}
    }
    global.AES = {
        getServerName() { return "free1" },
        getAirlineCode() { return {code: "CFA"} }
    }
    const state = {
        pricing: {
            silentAutoEnabled: false,
            silentAutoTickMin: 30,
            silentAutoFollowMode: "watchlist",
            apply: {enabled: false, dryRunOnly: true, liveScopes: {}}
        }
    }
    global.RouteAssistantSettings = {
        async load() {
            return JSON.parse(JSON.stringify(state))
        },
        async save(partial) {
            if (partial && partial.pricing) state.pricing = JSON.parse(JSON.stringify(partial.pricing))
            return JSON.parse(JSON.stringify(state))
        }
    }
    delete global.AesRoutePriceAutomator
    eval(fs.readFileSync(path.join(ROOT, "modules/route-assistant/central-price-automator.js"), "utf8"))
    return {automator: global.AesRoutePriceAutomator, state, storage}
}

(async () => {
    console.log("=== silent-auto cadence ===")

    const Settings = loadSettingsStore()
    await it("new defaults use a 5-second foreground cadence", () => {
        const defaults = Settings._defaults()
        const merged = Settings._mergePricing(defaults.pricing, {})
        assert.strictEqual(merged.silentAutoTickSec, 5)
        assert.strictEqual(merged.silentAutoTickMin, 5 / 60)
    })

    await it("legacy minute saves preserve their existing cadence", () => {
        const defaults = Settings._defaults()
        const merged = Settings._mergePricing(defaults.pricing, {silentAutoTickMin: 30})
        assert.strictEqual(merged.silentAutoTickSec, 1800)
        assert.strictEqual(merged.silentAutoTickMin, 30)
    })

    await it("seconds setting wins over legacy minute mirror", () => {
        const defaults = Settings._defaults()
        const merged = Settings._mergePricing(defaults.pricing, {
            silentAutoTickMin: 30,
            silentAutoTickSec: 5
        })
        assert.strictEqual(merged.silentAutoTickSec, 5)
        assert.strictEqual(merged.silentAutoTickMin, 5 / 60)
    })

    const bg = loadBackgroundAlarmHelpers()
    await it("background config accepts 5-second cadence as a sub-minute value", () => {
        const cfg = bg.configFromSettings({
            routeAssistant: {pricing: {silentAutoEnabled: true, silentAutoTickSec: 5}}
        })
        assert.strictEqual(cfg.enabled, true)
        assert.strictEqual(cfg.tickMin, 1 / 12)
        assert.strictEqual(bg.tickMin({silentAutoTickSec: 5}), 1 / 12)
    })

    const {automator, state, storage} = loadCentralAutomator()
    await it("dashboard helper writes both seconds and legacy minute mirror", async () => {
        await automator.configureAutomaticLiveMode({tickSec: 5, followMode: "all"})
        assert.strictEqual(state.pricing.silentAutoTickSec, 5)
        assert.strictEqual(state.pricing.silentAutoTickMin, 5 / 60)
        const desc = automator.describeSettings({pricing: state.pricing})
        assert.strictEqual(desc.tickMs, 5000)
        assert.strictEqual(desc.tickLabel, "5 sec")
    })

    await it("dashboard due gate skips automatic ticks inside the 5-second window", async () => {
        state.pricing.silentAutoEnabled = true
        state.pricing.silentAutoTickSec = 5
        state.pricing.silentAutoTickMin = 5 / 60
        state.pricing.silentAutoLastTickAt = Date.now() - 2000
        const tick = await automator.runTickIfDue({server: "free1"}, {source: "test"})
        assert.strictEqual(tick.skipped, "recent")
        assert.ok(tick.nextDueAt > Date.now())
    })

    await it("dashboard preview discovers routes from live scheduling cache", async () => {
        storage["routeAssistant:ticketPrice:acct:acct-1:JFK-ATL"] = {
            hub: "JFK",
            dest: "ATL",
            scrapedAt: Date.now(),
            weeklyFlights: 7,
            source: "live"
        }
        const preview = await automator.preview({server: "free1"}, {followMode: "all", forceDryRun: true})
        assert.strictEqual(preview.counts.routes, 1)
        assert.strictEqual(preview.rows[0].pair, "JFK-ATL")
        assert.strictEqual(preview.rows[0].source, "schedule-cache")
        assert.strictEqual(preview.rows[0].reason, "no own pricing cached")
        assert.ok(preview.notices.some(n => n.code === "no-own-pricing-cache"))
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})()
