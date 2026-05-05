import { chromium } from "playwright"
import { mkdir, writeFile } from "node:fs/promises"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..")
const PORT = process.env.AES_LIVE_CHROME_PORT || "9377"
const SERVER = normalizeServer(process.env.AES_LIVE_SERVER || "free1.airlinesim.aero")
const LAUNCH = process.env.AES_LIVE_CHROME_LAUNCH === "1"
const PROFILE_DIR = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), `aes-live-harvest-${PORT}`)
const CHROME_PATH = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const OUT = process.env.AES_HARVEST_OUT
    || path.join(ROOT, "audit", `live-harvest-seed-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
const POLL_MS = Number(process.env.AES_HARVEST_POLL_MS || 5000)
const CONCURRENCY = Number(process.env.AES_HARVEST_CONCURRENCY || 3)
const STAGGER_MS = Number(process.env.AES_HARVEST_STAGGER_MS || 1500)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function normalizeServer(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function baseUrl() {
    return `https://${SERVER}`
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
                if (res && res.result && res.result.value) return { client, contextId: ctx.id }
            } catch (_) {}
        }
        await sleep(250)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated context not found")
}

async function evalAes(page, expression, timeoutMs = 30000) {
    const { client, contextId } = await findAesContext(
        page,
        "(window.CountryScraper || typeof CountryScraper !== \"undefined\") && window.RouteAssistantDemandStore",
        timeoutMs
    )
    try {
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
    } finally {
        await client.detach().catch(() => {})
    }
}

async function countSeeded(page) {
    return await evalAes(page, `new Promise(resolve => {
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
    })`)
}

let browser = null
let context = null
if (LAUNCH) {
    fs.mkdirSync(PROFILE_DIR, {recursive: true})
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath(),
        headless: false,
        viewport: {width: 1440, height: 1000},
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
            `--disable-extensions-except=${ROOT}`,
            `--load-extension=${ROOT}`,
            `--remote-debugging-port=${PORT}`,
            "--remote-allow-origins=*",
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--disable-background-timer-throttling",
            "--no-first-run",
            "--no-default-browser-check"
        ]
    })
    browser = context.browser()
} else {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    context = browser.contexts()[0]
}
if (!context) throw new Error(`No browser context on CDP port ${PORT}`)
const existingDashboard = context.pages()
    .filter(p => !p.isClosed())
    .find(p => /airlinesim\.aero\/app\/enterprise\/dashboard/i.test(p.url()))
const page = existingDashboard || await context.newPage()
page.setDefaultTimeout(60000)

const report = {
    ok: false,
    mode: "demand-seed-first",
    port: PORT,
    server: SERVER,
    startedAt: new Date().toISOString(),
    progress: [],
    before: null,
    after: null,
    result: null,
    errors: []
}

try {
    const dashboardUrl = process.env.AES_HARVEST_DASHBOARD_URL
        || `${baseUrl()}/app/enterprise/dashboard`
    await page.goto(dashboardUrl, {waitUntil: "domcontentloaded", timeout: 60000})
        .catch(err => {
            if (!/ERR_ABORTED/.test(String(err))) throw err
        })
    await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    await page.waitForTimeout(1500)
    if (/\/auth\/login/i.test(page.url())) throw new Error("not logged in")

    report.before = await countSeeded(page)
    const start = await evalAes(page, `(() => {
        if (window.__AESSeedRun && !window.__AESSeedRun.done) return {started: false, reason: "already-running"}
        const run = {
            done: false,
            startedAt: Date.now(),
            progress: null,
            result: null,
            error: null
        }
        window.__AESSeedRun = run
        const server = ${JSON.stringify(SERVER.replace(/\.airlinesim\.aero$/i, ""))}
        const notify = p => {
            run.progress = Object.assign({at: Date.now()}, p || {})
        }
        const directSeed = async () => {
            const countries = await CountryScraper.loadCountriesList(server)
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
            const workerCount = Math.max(1, Math.min(${JSON.stringify(Math.max(1, Math.floor(CONCURRENCY) || 1))}, countries.length))
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
            const seedOne = async c => {
                if (!c) return
                active.set(String(c.id), c.name || String(c.id))
                state.currentCountryId = c.id
                state.currentCountryName = c.name
                state.activeCountries = Array.from(active.values())
                notify(state)
                try {
                    const airports = await CountryScraper._getAllAirportsForCountry(c.id, server)
                    if (airports && airports.length) {
                        await RouteAssistantDemandStore.saveCountryAirports(c.id, airports, {
                            countryName: c.name || null
                        })
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
                        if (idx < countries.length - 1) await wait(${JSON.stringify(Math.max(0, Math.floor(STAGGER_MS) || 0))})
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
                const scanner = new RouteAssistantParallelScanner(server, {
                    concurrency: ${JSON.stringify(Math.max(1, Math.floor(CONCURRENCY) || 1))},
                    staggerMs: ${JSON.stringify(Math.max(0, Math.floor(STAGGER_MS) || 0))}
                })
                scanner.onProgress(notify)
                return scanner.seedAllCountries()
            }
            return directSeed()
        }
        runSeed()
            .then(out => {
                run.done = true
                run.completedAt = Date.now()
                run.result = out || null
            })
            .catch(error => {
                run.done = true
                run.completedAt = Date.now()
                run.error = (error && error.message) || String(error)
            })
        return {started: true}
    })()`)
    report.start = start

    let lastPrint = ""
    while (true) {
        const state = await evalAes(page, `(() => {
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
        })()`)
        if (!state) throw new Error("seed state disappeared")
        if (state.progress) {
            const p = state.progress
            const line = `${p.phase || "?"} ${p.fetched || 0}/${p.total || 0} airports=${p.airportsSeeded || 0} failed=${(p.failedCountries || []).length}`
            if (line !== lastPrint) {
                console.log("[seed]", line)
                lastPrint = line
            }
            report.progress.push({
                at: new Date().toISOString(),
                phase: p.phase || null,
                total: p.total || 0,
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

    report.after = await countSeeded(page)
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
        before: report.before,
        after: report.after,
        result: report.result,
        errors: report.errors
    }, null, 2))
    if (LAUNCH && context) {
        await context.close().catch(() => {})
    }
    // In attach mode, keep the live Chrome open for follow-on debugging through the same CDP port.
}

if (!report.ok) process.exit(1)
