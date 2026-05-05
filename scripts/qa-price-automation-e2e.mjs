#!/usr/bin/env node

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"

const ROOT = path.resolve(new URL("..", import.meta.url).pathname)
const EXTENSION_PATH = process.env.AES_EXTENSION_PATH || ROOT
const START_PORT = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const CONNECT_PORT = process.env.AES_LIVE_CONNECT_PORT || process.env.AES_CONNECT_PORT || ""
const DEBUG_PORT = CONNECT_PORT ? Number(CONNECT_PORT) : await findAvailableDebugPort(START_PORT)
const PROFILE_DIR = process.env.AES_TEST_PROFILE
    || path.join(os.tmpdir(), `aes-price-automation-${DEBUG_PORT}`)
const SERVER_HOST = normalizeServerHost(process.env.AES_REAL_SERVER || "free1.airlinesim.aero")
const DASHBOARD_URL = process.env.AES_TEST_DASHBOARD_URL
    || `https://${SERVER_HOST}/app/enterprise/dashboard?qa-price-automation=1`
const LOGIN_EMAIL = process.env.AES_LOGIN_EMAIL || ""
const LOGIN_PASSWORD = process.env.AES_LOGIN_PASSWORD || ""
const REPORT_PATH = process.env.AES_PRICE_AUTOMATION_REPORT
    || path.join(ROOT, "audit", `price-automation-e2e-${DEBUG_PORT}.json`)

auditManifest()

let browser = null
let context = null
const pageErrors = []
const consoleRows = []

try {
    if (CONNECT_PORT) {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`)
        context = browser.contexts()[0]
        if (!context) throw new Error(`No browser context on port ${DEBUG_PORT}`)
    } else {
        fs.mkdirSync(PROFILE_DIR, { recursive: true })
        context = await chromium.launchPersistentContext(PROFILE_DIR, {
            headless: false,
            ignoreHTTPSErrors: true,
            viewport: { width: 1440, height: 1000 },
            args: [
                `--remote-debugging-port=${DEBUG_PORT}`,
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                "--disable-features=DisableLoadExtensionCommandLineSwitch",
                "--disable-background-timer-throttling",
                "--no-first-run",
                "--no-default-browser-check"
            ]
        })
    }

    const page = context.pages().find(p => /airlinesim\.aero/.test(p.url()))
        || context.pages()[0]
        || await context.newPage()
    page.setDefaultTimeout(60000)
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))
    page.on("console", msg => {
        if (msg.type() === "error" || msg.type() === "warning") {
            consoleRows.push({ type: msg.type(), text: msg.text(), url: page.url() })
        }
    })

    const loggedIn = CONNECT_PORT ? !/\/auth\/login/i.test(page.url()) : await loginIfNeeded(page)
    await gotoDomContentLoaded(page, DASHBOARD_URL)
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", { timeout: 45000 })

    const result = await evalInFreshAesContext(page, priceAutomationSeededExpression({
        serverSlug: SERVER_HOST.replace(/\.airlinesim\.aero$/i, ""),
        tickSec: 5,
        hub: process.env.AES_QA_PRICE_HUB || "LHR",
        dest: process.env.AES_QA_PRICE_DEST || "CDG"
    }))

    const output = {
        ok: !!(result && result.ok) && pageErrors.length === 0,
        attached: !!CONNECT_PORT,
        remoteDebuggingPort: DEBUG_PORT,
        profileDir: CONNECT_PORT ? null : PROFILE_DIR,
        server: SERVER_HOST,
        dashboardUrl: page.url(),
        title: await page.title().catch(() => ""),
        loggedIn,
        manifest: auditManifest(),
        baseline: result && result.baseline || null,
        seeded: result && result.seeded || null,
        result,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
    fs.writeFileSync(REPORT_PATH, JSON.stringify(output, null, 2))
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = output.ok ? 0 : 1
} catch (err) {
    const output = {
        ok: false,
        attached: !!CONNECT_PORT,
        remoteDebuggingPort: DEBUG_PORT,
        profileDir: CONNECT_PORT ? null : PROFILE_DIR,
        error: err && err.stack ? err.stack : String(err),
        consoleRows,
        pageErrors
    }
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
    fs.writeFileSync(REPORT_PATH, JSON.stringify(output, null, 2))
    console.error(JSON.stringify(output, null, 2))
    process.exitCode = 1
} finally {
    if (!CONNECT_PORT && context && process.env.AES_KEEP_BROWSER !== "1") {
        await context.close().catch(() => {})
    }
}

if (CONNECT_PORT) process.exit(process.exitCode || 0)

function auditManifest() {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))
    if (manifest.manifest_version !== 3) throw new Error("Expected manifest_version 3")
    if (!manifest.background || manifest.background.service_worker !== "background.js") {
        throw new Error("Expected background.js service worker")
    }

    for (const permission of ["storage", "tabs", "alarms"]) {
        if (!(manifest.permissions || []).includes(permission)) {
            throw new Error(`Missing permission: ${permission}`)
        }
    }
    if (!(manifest.host_permissions || []).includes("https://*.airlinesim.aero/*")) {
        throw new Error("Missing AirlineSim host permission")
    }

    const dashboardBlock = (manifest.content_scripts || []).find(block =>
        (block.matches || []).some(pattern => /\/app\/enterprise\/dashboard/.test(pattern))
    )
    if (!dashboardBlock) throw new Error("Dashboard content-script block missing")
    const scripts = dashboardBlock.js || []
    const required = [
        "modules/route-assistant/pricing-plumbing.js",
        "modules/route-assistant/pricing-apply-log.js",
        "modules/route-assistant/markets-page-scraper.js",
        "modules/route-assistant/pricing-applier.js",
        "modules/route-assistant/silent-auto-proposer-per-class.js",
        "modules/route-assistant/silent-auto-proposers.js",
        "modules/route-assistant/central-price-automator.js",
        "modules/route-assistant/dashboard-auto-price-loop.js"
    ]
    for (const file of required) {
        if (!scripts.includes(file)) throw new Error(`Dashboard pricing script missing: ${file}`)
        if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`Manifest file missing on disk: ${file}`)
    }
    assertBefore(scripts, "modules/route-assistant/pricing-plumbing.js", "modules/route-assistant/pricing-applier.js")
    assertBefore(scripts, "modules/route-assistant/pricing-applier.js", "modules/route-assistant/central-price-automator.js")
    assertBefore(scripts, "modules/route-assistant/silent-auto-proposers.js", "modules/route-assistant/central-price-automator.js")
    assertBefore(scripts, "modules/route-assistant/central-price-automator.js", "modules/route-assistant/dashboard-auto-price-loop.js")

    return {
        serviceWorker: manifest.background.service_worker,
        permissions: manifest.permissions,
        hostPermissions: manifest.host_permissions,
        dashboardPricingScripts: required
    }
}

function assertBefore(list, left, right) {
    if (list.indexOf(left) < 0 || list.indexOf(right) < 0 || list.indexOf(left) > list.indexOf(right)) {
        throw new Error(`Manifest order invalid: ${left} must load before ${right}`)
    }
}

async function loginIfNeeded(page) {
    await gotoDomContentLoaded(page, DASHBOARD_URL)
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
    const needsLogin = /\/auth\/login|\/app\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false
    if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
        throw new Error("Live login requires AES_LOGIN_EMAIL and AES_LOGIN_PASSWORD")
    }

    await gotoDomContentLoaded(page, "https://www.airlinesim.aero/auth/login")
    await page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first().fill(LOGIN_EMAIL)
    await page.locator("input[type='password']").first().fill(LOGIN_PASSWORD)
    const submit = page.locator(
        "button[type='submit'], input[type='submit'], button:has-text(\"Log in\")"
    ).first()
    await Promise.all([
        page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), { timeout: 60000 }).catch(() => null),
        submit.click()
    ])
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
    if (/\/auth\/login|\/app\/login/i.test(page.url())) throw new Error("Login did not leave the auth page")
    return true
}

async function gotoDomContentLoaded(page, url) {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function evalInFreshAesContext(page, expression, attempts = 4) {
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        let client = null
        try {
            const found = await findAesContext(page)
            client = found.client
            const value = await evalInContext(client, found.contextId, expression)
            await client.detach().catch(() => {})
            return value
        } catch (err) {
            lastError = err
            if (client) await client.detach().catch(() => {})
            const msg = String((err && err.message) || err)
            if (!/navigated|closed|Cannot find context|Execution context was destroyed|Target closed/i.test(msg)) {
                throw err
            }
            await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {})
            await sleep(750 + attempt * 500)
        }
    }
    throw lastError || new Error("AES context evaluation failed")
}

async function findAesContext(page) {
    const client = await page.context().newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => {
        if (ev && ev.context) contexts.set(ev.context.id, ev.context)
    })
    await client.send("Runtime.enable")
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
        for (const ctx of contexts.values()) {
            const score = await evalInContext(client, ctx.id, `(() => {
                const names = [
                    "AesRoutePriceAutomator",
                    "AesRoutePriceAutomatorDashboardLoop",
                    "RouteAssistantSettings",
                    "RouteAssistantPricingApplier"
                ]
                return names.filter(name => !!window[name]).length
            })()`).catch(() => 0)
            if (score >= 4) return { client, contextId: ctx.id }
        }
        await sleep(500)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated price automation context not found")
}

async function evalInContext(client, contextId, expression) {
    const res = await client.send("Runtime.evaluate", {
        contextId,
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 180000
    })
    if (res.exceptionDetails) {
        const ex = res.exceptionDetails.exception || {}
        throw new Error(ex.description || ex.value || res.exceptionDetails.text || "Runtime.evaluate failed")
    }
    return res.result && Object.prototype.hasOwnProperty.call(res.result, "value")
        ? res.result.value
        : null
}

function priceAutomationExpression(input) {
    return `(${async function run(input) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
        const required = [
            "AesRoutePriceAutomator",
            "AesRoutePriceAutomatorDashboardLoop",
            "RouteAssistantSettings",
            "RouteAssistantPricingApplier"
        ]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return { ok: false, stage: "modules", missing }

        const original = await RouteAssistantSettings.load()
        const startedAt = Date.now()
        const samples = []
        let restoreError = null
        try {
            const prepared = await RouteAssistantSettings.load()
            const pricing = Object.assign({}, prepared.pricing || {})
            const apply = Object.assign({}, pricing.apply || {})
            apply.enabled = true
            apply.permanentLiveMode = false
            apply.dryRunOnly = true
            apply.liveScopes = Object.assign({}, apply.liveScopes || {}, { silentAuto: false })
            apply.cooldownMinPerRoute = 0
            apply.cooldownMinGlobal = 0
            pricing.apply = apply
            pricing.silentAutoEnabled = true
            pricing.silentAutoConfirmedAt = Date.now()
            pricing.silentAutoFollowMode = "all"
            pricing.silentAutoStrategy = "competitor-median"
            pricing.silentAutoTickSec = input.tickSec
            pricing.silentAutoTickMin = input.tickSec / 60
            pricing.silentAutoMaxPerDay = 0
            pricing.silentAutoMaxPerHour = 0
            pricing.silentAutoMutedUntil = null
            pricing.silentAutoLastTickAt = null
            pricing.silentAutoLastTickResult = null
            await RouteAssistantSettings.save({ pricing })

            const desc = AesRoutePriceAutomator.describeSettings(
                await RouteAssistantSettings.load(),
                { forceDryRun: true, followMode: "all" }
            )
            const preview = await AesRoutePriceAutomator.preview(
                { server: input.serverSlug, airline: null },
                { forceDryRun: true, followMode: "all", limit: 25 }
            )
            const forcedTick = await AesRoutePriceAutomator.runTick(
                { server: input.serverSlug, airline: null },
                { force: true, forceDryRun: true, followMode: "all", maxRoutes: 1 }
            )
            const cacheReaderSmoke = await runExactTopRoutesSmoke(input.serverSlug)
            const afterForced = await RouteAssistantSettings.load()
            const resetPricing = Object.assign({}, afterForced.pricing || pricing)
            resetPricing.silentAutoLastTickAt = null
            resetPricing.silentAutoLastTickResult = null
            await RouteAssistantSettings.save({ pricing: resetPricing })

            if (typeof AesRoutePriceAutomatorDashboardLoop.start === "function") {
                AesRoutePriceAutomatorDashboardLoop.start()
            }

            const deadline = Date.now() + input.observeMs
            let lastAt = 0
            while (Date.now() < deadline && samples.length < 2) {
                await sleep(500)
                const fresh = await RouteAssistantSettings.load()
                const p = fresh.pricing || {}
                const at = Number(p.silentAutoLastTickAt)
                if (Number.isFinite(at) && at > 0 && at !== lastAt) {
                    lastAt = at
                    samples.push({
                        at,
                        elapsedMs: at - startedAt,
                        result: p.silentAutoLastTickResult || null
                    })
                }
            }
            const intervals = []
            for (let i = 1; i < samples.length; i += 1) intervals.push(samples[i].at - samples[i - 1].at)

            return {
                ok: desc.dryRun === true
                    && desc.liveWrites === false
                    && forcedTick.dryRun === true
                    && cacheReaderSmoke.ok === true
                    && samples.length >= 2
                    && intervals.every(ms => ms >= 4000 && ms <= 10000),
                stage: "done",
                dryRunOnly: true,
                liveWritesDisabled: true,
                desc: {
                    silentAutoEnabled: desc.silentAutoEnabled,
                    dryRun: desc.dryRun,
                    liveWrites: desc.liveWrites,
                    tickMs: desc.tickMs,
                    tickLabel: desc.tickLabel,
                    followMode: desc.followMode
                },
                preview: {
                    counts: preview.counts || null,
                    notices: preview.notices || [],
                    proposals: (preview.proposals || []).slice(0, 5).map(p => ({
                        pair: p.pair,
                        reason: p.reason || null,
                        prices: p.prices || null
                    }))
                },
                forcedTick: {
                    dryRun: forcedTick.dryRun,
                    eligible: forcedTick.eligible,
                    proposed: forcedTick.proposed,
                    applied: forcedTick.applied,
                    simulated: forcedTick.simulated,
                    error: forcedTick.error || null,
                    perRoute: forcedTick.perRoute || []
                },
                cacheReaderSmoke,
                samples,
                intervals,
                durationMs: Date.now() - startedAt
            }
        } catch (e) {
            return {
                ok: false,
                stage: "exception",
                error: String(e && e.message || e),
                stack: e && e.stack || null
            }
        } finally {
            try {
                await RouteAssistantSettings.save({
                    pricing: original.pricing,
                    ors: original.ors
                })
            } catch (e) {
                restoreError = String(e && e.message || e)
            }
            if (restoreError) console.warn("[AES QA] failed to restore Route Assistant settings", restoreError)
        }

        async function runExactTopRoutesSmoke(serverSlug) {
            const hub = "QAA"
            const dest = "QAB"
            const pair = hub + "-" + dest
            const keys = [
                "routeAssistant:topRoutes",
                "routeAssistant:markets:ownPricing:" + pair,
                "routeAssistant:markets:competitors:" + pair
            ]
            const backup = await chrome.storage.local.get(keys)
            const had = {}
            for (const key of keys) {
                had[key] = Object.prototype.hasOwnProperty.call(backup || {}, key)
            }
            const now = Date.now()
            try {
                await chrome.storage.local.set({
                    "routeAssistant:topRoutes": {
                        server: serverSlug,
                        hub,
                        accountId: window.__aesAccountId || null,
                        scrapedAt: now,
                        snapshotAt: now,
                        rows: [{
                            destIata: dest,
                            destName: "QA price automation probe"
                        }]
                    },
                    ["routeAssistant:markets:ownPricing:" + pair]: {
                        server: serverSlug,
                        hub,
                        dest,
                        prices: {Y: 100},
                        scrapedAt: now
                    },
                    ["routeAssistant:markets:competitors:" + pair]: {
                        server: serverSlug,
                        hub,
                        dest,
                        competitors: [
                            {serviceClass: "Y", price: 120},
                            {serviceClass: "Y", price: 140}
                        ],
                        scrapedAt: now
                    }
                })
                const preview = await AesRoutePriceAutomator.preview(
                    {server: serverSlug, airline: null},
                    {forceDryRun: true, followMode: "all", limit: 10}
                )
                const row = (preview.rows || []).find(r => r.pair === pair) || null
                return {
                    ok: !!(row && row.source === "topRoutes" && row.stage === "proposed"
                        && row.proposal && row.proposal.prices && row.proposal.prices.Y),
                    pair,
                    counts: preview.counts || null,
                    row: row ? {
                        source: row.source,
                        stage: row.stage,
                        reason: row.reason || null,
                        competitorMedianPriceY: row.competitorMedianPriceY,
                        proposedY: row.proposal && row.proposal.prices && row.proposal.prices.Y || null
                    } : null
                }
            } finally {
                const restore = {}
                const remove = []
                for (const key of keys) {
                    if (had[key]) restore[key] = backup[key]
                    else remove.push(key)
                }
                if (remove.length) await chrome.storage.local.remove(remove)
                if (Object.keys(restore).length) await chrome.storage.local.set(restore)
            }
        }
    }})(` + JSON.stringify(input) + `)`
}

function priceAutomationSeededExpression(input) {
    return `(${async function run(input) {
        const required = [
            "AesRoutePriceAutomator",
            "AesRoutePriceAutomatorDashboardLoop",
            "RouteAssistantSettings",
            "RouteAssistantPricingApplier",
            "RouteAssistantMarketsPageScraper"
        ]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return { ok: false, stage: "modules", missing }

        const host = { server: input.serverSlug, airline: null }
        const hub = String(input.hub || "LHR").toUpperCase()
        const dest = String(input.dest || "CDG").toUpperCase()
        const pair = hub + "-" + dest
        const startedAt = Date.now()
        const cachePrefixes = [
            "routeAssistant:topRoutes:",
            "routeAssistant:markets:",
            "routeAssistant:ticketPrice:",
            "routeAssistant:override:"
        ]
        const isPricingKey = key => cachePrefixes.some(prefix => String(key || "").indexOf(prefix) === 0)
        const tickSummary = tick => ({
            dryRun: tick && tick.dryRun,
            eligible: tick && tick.eligible,
            proposed: tick && tick.proposed,
            applied: tick && tick.applied,
            simulated: tick && tick.simulated,
            capped: tick && tick.capped,
            blocked: tick && tick.blocked,
            skipped: tick && tick.skipped,
            error: tick && tick.error || null,
            perRoute: ((tick && tick.perRoute) || []).slice(0, 5).map(r => ({
                pair: r.pair || null,
                dest: r.dest || null,
                stage: r.stage || null,
                applyStatus: r.applyStatus || null,
                reason: r.reason || null,
                priceSummary: r.priceSummary || null,
                prices: r.prices || null,
                errorCode: r.errorCode || null
            }))
        })
        const previewSummary = preview => ({
            counts: preview && preview.counts || null,
            notices: preview && preview.notices || [],
            proposals: ((preview && preview.proposals) || []).slice(0, 5).map(p => ({
                pair: p.pair || null,
                hub: p.hub || null,
                dest: p.dest || null,
                reason: p.reason || null,
                prices: p.prices || null,
                prevPrices: p.prevPrices || null,
                deltaPct: p.deltaPct || null
            })),
            rows: ((preview && preview.rows) || []).slice(0, 5).map(r => ({
                pair: r.pair || null,
                source: r.source || null,
                stage: r.stage || null,
                reason: r.reason || null,
                prices: r.prices || null,
                competitorYsCount: r.competitorYsCount || 0,
                manualPricePin: r.manualPricePin == null ? null : r.manualPricePin
            }))
        })

        async function saveQaPricing() {
            const settings = await RouteAssistantSettings.load()
            const pricing = Object.assign({}, settings.pricing || {})
            const apply = Object.assign({}, pricing.apply || {})
            apply.enabled = true
            apply.permanentLiveMode = false
            apply.dryRunOnly = true
            apply.liveScopes = Object.assign({}, apply.liveScopes || {}, { silentAuto: false })
            apply.cooldownMinPerRoute = 0
            apply.cooldownMinGlobal = 0
            apply.silentAutoCompetitorMinCount = 2
            pricing.apply = apply
            pricing.silentAutoEnabled = true
            pricing.silentAutoConfirmedAt = Date.now()
            pricing.silentAutoFollowMode = "all"
            pricing.silentAutoStrategy = "competitor-median"
            pricing.silentAutoMinDeltaPct = 1
            pricing.silentAutoMaxStepPct = 5
            pricing.silentAutoTickSec = input.tickSec || 5
            pricing.silentAutoTickMin = (input.tickSec || 5) / 60
            pricing.silentAutoMaxPerDay = 0
            pricing.silentAutoMaxPerHour = 0
            pricing.silentAutoMutedUntil = null
            pricing.silentAutoLastTickAt = null
            pricing.silentAutoLastTickResult = null
            await RouteAssistantSettings.save({ pricing })
            return pricing
        }

        async function seedRouteCache() {
            const now = Date.now()
            const accountId = window.__aesAccountId || null
            const topRoutesKey = accountId
                ? "routeAssistant:topRoutes:acct:" + accountId + ":" + hub
                : "routeAssistant:topRoutes:" + hub
            await chrome.storage.local.set({
                [topRoutesKey]: {
                    server: input.serverSlug,
                    accountId: accountId || undefined,
                    hub,
                    scrapedAt: now,
                    rows: [{
                        destIata: dest,
                        destName: "QA seeded destination",
                        weeklyFlights: 14,
                        paxDemandPool: 800,
                        paxElasticity: -1.1,
                        cargoDemandPool: 120,
                        rmTightness: 0.7,
                        status: "qa-seeded"
                    }]
                }
            })
            const savedMarkets = await RouteAssistantMarketsPageScraper.saveAllRecords(
                hub,
                dest,
                {
                    ownPricing: {
                        prices: { Y: 100, C: 210, F: 480, Cargo: 0.8 },
                        defaults: { Y: 100, C: 210, F: 480, Cargo: 0.8 },
                        sliderRanges: { Y: [1, 500], C: [1, 800], F: [1, 1200], Cargo: [0.01, 5] },
                        generalSettings: {
                            originTerminal: null,
                            destinationTerminal: null,
                            serviceProfile: 3,
                            boardingPreference: "standard",
                            cargoPreference: "standard"
                        }
                    },
                    competitors: {
                        competitors: [
                            { flightCode: "QA 120", serviceClass: "Y", capacity: 100, booked: 40, loadPct: 40, availability: 60, price: 120, status: "bookable", isOurs: false },
                            { flightCode: "QA 130", serviceClass: "Y", capacity: 100, booked: 50, loadPct: 50, availability: 50, price: 130, status: "bookable", isOurs: false },
                            { flightCode: "QA 230", serviceClass: "C", capacity: 20, booked: 8, loadPct: 40, availability: 12, price: 230, status: "bookable", isOurs: false }
                        ]
                    }
                },
                "qa-price-automation-e2e",
                input.serverSlug
            )
            const all = await chrome.storage.local.get(null)
            const seededKeys = Object.keys(all).filter(key => key === topRoutesKey || key.endsWith(":" + pair))
            return { topRoutesKey, savedFamilies: Object.keys(savedMarkets || {}), seededKeys }
        }

        const originalSettings = await RouteAssistantSettings.load()
        const originalStorage = await chrome.storage.local.get(null)
        const restoreKeys = Object.keys(originalStorage).filter(isPricingKey)
        const restoreSnapshot = {}
        for (const key of restoreKeys) restoreSnapshot[key] = originalStorage[key]
        let restoreError = null
        let stoppedLoop = false
        try {
            if (window.AesRoutePriceAutomatorDashboardLoop
                    && typeof window.AesRoutePriceAutomatorDashboardLoop.stop === "function") {
                stoppedLoop = !!window.AesRoutePriceAutomatorDashboardLoop.stop()
            }
            if (restoreKeys.length) await chrome.storage.local.remove(restoreKeys)

            await saveQaPricing()
            const desc = AesRoutePriceAutomator.describeSettings(
                await RouteAssistantSettings.load(),
                { forceDryRun: true, followMode: "all" }
            )
            const baselinePreview = await AesRoutePriceAutomator.preview(
                host,
                { forceDryRun: true, followMode: "all", limit: 25 }
            )
            const baselineTick = await AesRoutePriceAutomator.runTick(
                host,
                { force: true, forceDryRun: true, followMode: "all", maxRoutes: 1 }
            )

            await saveQaPricing()
            const seedInfo = await seedRouteCache()
            const seededPreview = await AesRoutePriceAutomator.preview(
                host,
                { forceDryRun: true, followMode: "all", limit: 25 }
            )

            let tickVia = "dashboard-loop"
            let loopTick = await AesRoutePriceAutomatorDashboardLoop.tick()
            if (loopTick && loopTick.skipped) {
                tickVia = "direct-forced-fallback"
                await saveQaPricing()
                loopTick = await AesRoutePriceAutomator.runTick(
                    host,
                    { force: true, forceDryRun: true, followMode: "all", maxRoutes: 1 }
                )
            }

            const baselineNoticeCodes = (baselinePreview.notices || []).map(n => n.code)
            const seededPerRoute = (loopTick.perRoute || [])[0] || {}
            return {
                ok: baselinePreview.counts
                    && baselinePreview.counts.routes === 0
                    && baselineNoticeCodes.indexOf("no-route-data") >= 0
                    && baselineTick.error
                    && baselineTick.error.code === "noCachedRoutes"
                    && desc.dryRun === true
                    && desc.liveWrites === false
                    && seededPreview.counts
                    && seededPreview.counts.routes === 1
                    && seededPreview.counts.proposed === 1
                    && loopTick.dryRun === true
                    && loopTick.applied === 1
                    && loopTick.simulated === 1
                    && seededPerRoute.applyStatus === "dry-run",
                stage: "done",
                host,
                hub,
                dest,
                pair,
                dryRunOnly: true,
                liveWritesDisabled: true,
                tickVia,
                desc: {
                    silentAutoEnabled: desc.silentAutoEnabled,
                    dryRun: desc.dryRun,
                    liveWrites: desc.liveWrites,
                    tickMs: desc.tickMs,
                    tickLabel: desc.tickLabel,
                    followMode: desc.followMode
                },
                baseline: {
                    preview: previewSummary(baselinePreview),
                    tick: tickSummary(baselineTick)
                },
                seeded: {
                    storage: seedInfo,
                    preview: previewSummary(seededPreview),
                    dashboardLoopTick: tickSummary(loopTick)
                },
                durationMs: Date.now() - startedAt
            }
        } catch (e) {
            return {
                ok: false,
                stage: "exception",
                error: String(e && e.message || e),
                stack: e && e.stack || null
            }
        } finally {
            try {
                const after = await chrome.storage.local.get(null)
                const afterKeys = Object.keys(after).filter(isPricingKey)
                if (afterKeys.length) await chrome.storage.local.remove(afterKeys)
                if (restoreKeys.length) await chrome.storage.local.set(restoreSnapshot)
                const restoreSettings = {}
                if (Object.prototype.hasOwnProperty.call(originalSettings, "pricing")) {
                    restoreSettings.pricing = originalSettings.pricing
                }
                if (Object.prototype.hasOwnProperty.call(originalSettings, "ors")) {
                    restoreSettings.ors = originalSettings.ors
                }
                if (Object.keys(restoreSettings).length) await RouteAssistantSettings.save(restoreSettings)
                if (stoppedLoop && window.AesRoutePriceAutomatorDashboardLoop
                        && typeof window.AesRoutePriceAutomatorDashboardLoop.start === "function") {
                    window.AesRoutePriceAutomatorDashboardLoop.start()
                }
            } catch (e) {
                restoreError = String(e && e.message || e)
            }
            if (restoreError) console.warn("[AES QA] failed to restore price automation state", restoreError)
        }
    }})(` + JSON.stringify(input) + `)`
}

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : `${raw}.airlinesim.aero`
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function findAvailableDebugPort(start, attempts = 100) {
    const first = Number.isFinite(start) && start > 0 ? Math.floor(start) : 9222
    for (let port = first; port < first + attempts; port += 1) {
        if (await isPortAvailable(port)) return port
    }
    throw new Error(`No available remote debugging port in ${first}-${first + attempts - 1}`)
}

function isPortAvailable(port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => server.close(() => resolve(true)))
        server.listen(port, "127.0.0.1")
    })
}
