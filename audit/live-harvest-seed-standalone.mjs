import { chromium } from "playwright"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..")
const CREDS_PATH = path.join(ROOT, "audit", "credentials.json")
const EXTENSION_PATH = ROOT
const CHROME = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const PROFILE = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), "chrome-aes-cflair-seed-standalone")
const PORT = process.env.AES_LIVE_CHROME_PORT || "9382"
const SERVER = normalizeServer(process.env.AES_LIVE_SERVER || "free1.airlinesim.aero")
const DASHBOARD_URL = process.env.AES_HARVEST_DASHBOARD_URL
    || `https://${SERVER}/app/enterprise/dashboard?3&select=775`
const OUT = process.env.AES_HARVEST_OUT
    || path.join(ROOT, "audit", `live-harvest-seed-standalone-${PORT}.json`)
const KEEP_OPEN = process.env.AES_KEEP_OPEN === "1"
const POLL_MS = Number(process.env.AES_HARVEST_POLL_MS || 5000)
const CONCURRENCY = Math.max(1, Number(process.env.AES_HARVEST_CONCURRENCY || 3) || 3)
const STAGGER_MS = Math.max(0, Number(process.env.AES_HARVEST_STAGGER_MS || 1500) || 0)
const MAX_RESTARTS = Math.max(0, Number(process.env.AES_HARVEST_MAX_RESTARTS || 3) || 0)
const AES_READY = "window.CountryScraper && window.RouteAssistantDemandStore"

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function normalizeServer(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function shortServer() {
    return SERVER.replace(/\.airlinesim\.aero$/i, "")
}

async function loginIfNeeded(page, creds) {
    await goto(page, `https://${SERVER}/app/enterprise/dashboard`)
    await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    await Promise.race([
        page.waitForURL(url => /\/auth\/login/i.test(url.pathname), {timeout: 10000}).catch(() => null),
        page.locator("input[type='password']").first().waitFor({state: "visible", timeout: 10000}).catch(() => null),
        page.locator("#as-navbar-main-collapse, #aes-central-hub, h1").first().waitFor({state: "visible", timeout: 10000}).catch(() => null)
    ])
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
        || !await page.locator("body").evaluate(body =>
            /dashboard/i.test(document.title || "")
            && /dashboard/i.test(body && body.innerText || "")
            && !/log\s*in|password/i.test(body && body.innerText || "")
        ).catch(() => false)
    if (!needsLogin) return false

    await goto(page, "https://www.airlinesim.aero/auth/login")
    await page.locator("input[type='password']").first().waitFor({state: "visible", timeout: 30000})
    await page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first().fill(creds.email)
    await page.locator("input[type='password']").first().fill(creds.password)
    await Promise.allSettled([
        page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000}),
        page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click()
    ])
    await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    if (/\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0) {
        throw new Error("login failed; still on auth/login")
    }
    return true
}

async function goto(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function findAesContext(page, predicate, timeoutMs = 30000) {
    const client = await page.context().newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => {
        if (ev && ev.context && ev.context.id) contexts.set(ev.context.id, ev.context)
    })
    await client.send("Runtime.enable")
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
        for (const ctx of contexts.values()) {
            try {
                const res = await client.send("Runtime.evaluate", {
                    contextId: ctx.id,
                    expression: `(() => { try { return !!(${predicate}) } catch (_) { return false } })()`,
                    returnByValue: true
                })
                if (res && res.result && res.result.value) return {client, contextId: ctx.id}
            } catch (_) {}
        }
        await sleep(250)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated context not found")
}

async function evalIn(client, contextId, expression) {
    const res = await client.send("Runtime.evaluate", {
        contextId,
        expression,
        returnByValue: true,
        awaitPromise: true
    })
    if (res && res.exceptionDetails) {
        throw new Error(res.exceptionDetails.text
            || (res.exceptionDetails.exception && res.exceptionDetails.exception.description)
            || "Runtime.evaluate exception")
    }
    return res && res.result ? res.result.value : undefined
}

function countSeededExpression() {
    return `new Promise(resolve => {
        chrome.storage.local.get(null, all => {
            const counts = {
                demand: 0,
                topRoutes: 0,
                marketsCompetitors: 0,
                marketsOwnPricing: 0,
                inventory: 0,
                ors: 0,
                aircraftFleet: 0,
                aircraftFlights: 0,
                maintenance: 0,
                sampleDemand: []
            }
            for (const k in all || {}) {
                if (k.indexOf("routeAssistant:demand:") === 0) {
                    counts.demand++
                    if (counts.sampleDemand.length < 5) counts.sampleDemand.push(all[k])
                } else if (k.indexOf("routeAssistant:topRoutes:") === 0) counts.topRoutes++
                else if (k.indexOf("routeAssistant:markets:competitors:") === 0) counts.marketsCompetitors++
                else if (k.indexOf("routeAssistant:markets:ownPricing:") === 0) counts.marketsOwnPricing++
                else if (k.indexOf("routeAssistant:inventory:") === 0) counts.inventory++
                else if (k.indexOf("routeAssistant:ors:") === 0) counts.ors++
                else if (/aircraftFleet$/.test(k)) counts.aircraftFleet++
                else if (k.indexOf("aircraftFlights") === 0) counts.aircraftFlights++
                else if (k.indexOf("aircraftFlightPlan:maintenance:") === 0) counts.maintenance++
            }
            resolve(counts)
        })
    })`
}

async function evalAes(page, expression, timeoutMs = 30000) {
    const {client, contextId} = await findAesContext(page, AES_READY, timeoutMs)
    try {
        return await evalIn(client, contextId, expression)
    } finally {
        await client.detach().catch(() => {})
    }
}

function isContextChurn(error) {
    const text = String(error && error.message || error)
    return /Cannot find context|Execution context was destroyed|Inspected target navigated|Target page.*closed|Target closed|Session closed/i.test(text)
}

async function getLivePage(context, currentPage) {
    if (currentPage && !currentPage.isClosed()) return currentPage
    const found = context.pages().find(p => !p.isClosed() && /airlinesim\.aero/i.test(p.url()))
        || context.pages().find(p => !p.isClosed())
        || await context.newPage()
    found.setDefaultTimeout(60000)
    return found
}

async function prepareDashboard(context, page, creds) {
    page = await getLivePage(context, page)
    if (!/airlinesim\.aero\/app\/enterprise\/dashboard/i.test(page.url())) {
        report.loggedIn = await loginIfNeeded(page, creds)
    }
    await goto(page, DASHBOARD_URL)
    await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    await Promise.race([
        page.waitForURL(url => /\/auth\/login/i.test(url.pathname), {timeout: 10000}).catch(() => null),
        page.locator("input[type='password']").first().waitFor({state: "visible", timeout: 10000}).catch(() => null),
        page.locator("#as-navbar-main-collapse, #aes-central-hub, h1").first().waitFor({state: "visible", timeout: 10000}).catch(() => null)
    ])
    if (/\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0) {
        report.loggedIn = await loginIfNeeded(page, creds)
        await goto(page, DASHBOARD_URL)
        await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    }
    await sleep(2500)
    report.title = await page.title().catch(() => "")
    report.url = page.url()
    if (/\/auth\/login/i.test(page.url())) throw new Error("not logged in")
    return page
}

function seedExpression(server) {
    return `(() => {
        if (window.__AESSeedRun && !window.__AESSeedRun.done) return {started: false, reason: "already-running"}
        const run = {
            done: false,
            startedAt: Date.now(),
            progress: null,
            result: null,
            error: null
        }
        window.__AESSeedRun = run
        const notify = p => { run.progress = Object.assign({at: Date.now()}, p || {}) }
        const directSeed = async () => {
            const countries = await CountryScraper.loadCountriesList(${JSON.stringify(server)})
            const state = {
                phase: "seeding",
                total: countries.length,
                fetched: 0,
                airportsSeeded: 0,
                failedCountries: [],
                currentCountryId: null,
                currentCountryName: null,
                activeCountries: []
            }
            notify(state)
            let next = 0
            const active = new Map()
            const workerCount = Math.max(1, Math.min(${JSON.stringify(CONCURRENCY)}, countries.length))
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
            const seedOne = async c => {
                if (!c) return
                active.set(String(c.id), c.name || String(c.id))
                state.currentCountryId = c.id
                state.currentCountryName = c.name
                state.activeCountries = Array.from(active.values())
                notify(state)
                try {
                    const airports = await CountryScraper._getAllAirportsForCountry(c.id, ${JSON.stringify(server)})
                    if (airports && airports.length) {
                        await RouteAssistantDemandStore.saveCountryAirports(c.id, airports, {countryName: c.name || null})
                        state.fetched++
                        state.airportsSeeded += airports.length
                    } else {
                        state.failedCountries.push({id: c.id, name: c.name})
                    }
                } catch (error) {
                    state.failedCountries.push({id: c.id, name: c.name, error: (error && error.message) || String(error)})
                } finally {
                    active.delete(String(c.id))
                    state.activeCountries = Array.from(active.values())
                    state.currentCountryId = c.id
                    state.currentCountryName = c.name
                    notify(state)
                }
            }
            const workers = []
            for (let i = 0; i < workerCount; i++) {
                workers.push((async () => {
                    while (next < countries.length) {
                        const idx = next++
                        await seedOne(countries[idx])
                        if (idx < countries.length - 1) await wait(${JSON.stringify(STAGGER_MS)})
                    }
                })())
            }
            await Promise.all(workers)
            state.phase = "done"
            state.currentCountryId = null
            state.currentCountryName = null
            state.activeCountries = []
            notify(state)
            return state
        }
        const runSeed = async () => {
            if (typeof RouteAssistantParallelScanner === "function") {
                const scanner = new RouteAssistantParallelScanner(${JSON.stringify(server)}, {
                    concurrency: ${JSON.stringify(CONCURRENCY)},
                    staggerMs: ${JSON.stringify(STAGGER_MS)}
                })
                scanner.onProgress(notify)
                return scanner.seedAllCountries()
            }
            return directSeed()
        }
        runSeed().then(out => {
            run.done = true
            run.completedAt = Date.now()
            run.result = out || null
        }).catch(error => {
            run.done = true
            run.completedAt = Date.now()
            run.error = (error && error.message) || String(error)
        })
        return {started: true, hasParallelScanner: typeof RouteAssistantParallelScanner === "function"}
    })()`
}

const report = {
    ok: false,
    mode: "standalone-demand-seed-first",
    profile: PROFILE,
    port: PORT,
    server: SERVER,
    dashboardUrl: DASHBOARD_URL,
    startedAt: new Date().toISOString(),
    progress: [],
    restarts: [],
    before: null,
    after: null,
    result: null,
    errors: []
}

fs.mkdirSync(PROFILE, {recursive: true})
const creds = JSON.parse(await readFile(CREDS_PATH, "utf8"))
const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: fs.existsSync(CHROME) ? CHROME : chromium.executablePath(),
    headless: false,
    viewport: {width: 1440, height: 1000},
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        `--remote-debugging-port=${PORT}`,
        "--remote-allow-origins=*",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check"
    ]
})

let page = context.pages()[0] || await context.newPage()
page.setDefaultTimeout(60000)

try {
    page = await prepareDashboard(context, page, creds)
    report.before = await evalAes(page, countSeededExpression())
    report.start = await evalAes(page, seedExpression(shortServer()))

    let lastPrint = ""
    let restartCount = 0
    while (true) {
        let state = null
        try {
            state = await evalAes(page, `(() => {
                const run = window.__AESSeedRun || null
                if (!run) return null
                return {
                    done: !!run.done,
                    startedAt: run.startedAt || null,
                    completedAt: run.completedAt || null,
                    progress: run.progress || null,
                    result: run.result || null,
                    error: run.error || null
                }
            })()`, 10000)
            if (!state) throw new Error("seed state disappeared")
        } catch (error) {
            if (!isContextChurn(error) && !/seed state disappeared/i.test(String(error && error.message || error))) {
                throw error
            }
            if (restartCount >= MAX_RESTARTS) throw error
            restartCount++
            const row = {
                at: new Date().toISOString(),
                reason: (error && error.message) || String(error),
                restart: restartCount
            }
            report.restarts.push(row)
            console.log("[seed:restart]", JSON.stringify(row))
            page = await prepareDashboard(context, page, creds)
            report.start = await evalAes(page, seedExpression(shortServer()))
            await sleep(POLL_MS)
            continue
        }

        if (state.progress) {
            const p = state.progress
            const total = p.allCountries != null ? `${p.fetched || 0}/${p.total || 0} todo ${p.skippedCountries || 0} skipped` : `${p.fetched || 0}/${p.total || 0}`
            const line = `${p.phase || "?"} ${total} airports=${p.airportsSeeded || 0} failed=${(p.failedCountries || []).length}`
            if (line !== lastPrint) {
                console.log("[seed]", line)
                lastPrint = line
            }
            report.progress.push({
                at: new Date().toISOString(),
                phase: p.phase || null,
                total: p.total || 0,
                allCountries: p.allCountries || null,
                skippedCountries: p.skippedCountries || 0,
                fetched: p.fetched || 0,
                airportsSeeded: p.airportsSeeded || 0,
                failedCountries: (p.failedCountries || []).length,
                activeCountries: p.activeCountries || [],
                currentCountryId: p.currentCountryId || null,
                currentCountryName: p.currentCountryName || null
            })
        }
        if (state.done) {
            report.result = state.result
            if (state.error) throw new Error(state.error)
            break
        }
        await sleep(POLL_MS)
    }
    report.after = await evalAes(page, countSeededExpression())
    report.ok = !!(report.result && report.result.phase === "done")
} catch (error) {
    report.errors.push((error && error.message) || String(error))
} finally {
    report.completedAt = new Date().toISOString()
    await mkdir(path.dirname(OUT), {recursive: true})
    await writeFile(OUT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({
        ok: report.ok,
        out: OUT,
        url: report.url,
        title: report.title,
        before: report.before,
        after: report.after,
        result: report.result,
        errors: report.errors,
        keepOpen: KEEP_OPEN
    }, null, 2))
}

if (!report.ok) process.exit(1)
if (KEEP_OPEN) await new Promise(() => {})
