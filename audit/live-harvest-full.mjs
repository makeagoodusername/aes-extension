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
    || path.join(os.tmpdir(), "chrome-aes-cflair-harvest-full")
const PORT = process.env.AES_LIVE_CHROME_PORT || "9382"
const SERVER = normalizeServer(process.env.AES_LIVE_SERVER || "free1.airlinesim.aero")
const DASHBOARD_URL = process.env.AES_HARVEST_DASHBOARD_URL
    || `https://${SERVER}/app/enterprise/dashboard?3&select=775`
const OUT = process.env.AES_HARVEST_OUT
    || path.join(ROOT, "audit", `live-harvest-full-${PORT}.json`)
const PHASES = (process.env.AES_HARVEST_PHASES
    || "foundation,per-hub,per-aircraft,per-route,ors-rank")
    .split(",").map(s => s.trim()).filter(Boolean)
const POLL_MS = Number(process.env.AES_HARVEST_POLL_MS || 5000)
const LAUNCH = process.env.AES_HARVEST_LAUNCH === "1"

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function normalizeServer(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

async function goto(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function loginIfNeeded(page) {
    await goto(page, `https://${SERVER}/app/enterprise/dashboard`)
    await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false

    const creds = JSON.parse(await readFile(CREDS_PATH, "utf8"))
    await goto(page, "https://www.airlinesim.aero/auth/login")
    await page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first().fill(creds.email)
    await page.locator("input[type='password']").first().fill(creds.password)
    await Promise.all([
        page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000}),
        page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click()
    ])
    return true
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

function countExpression() {
    return `new Promise(resolve => {
        chrome.storage.local.get(null, all => {
            const counts = {
                demand: 0,
                topRoutes: 0,
                marketsCompetitors: 0,
                marketsOwnPricing: 0,
                marketsMarketShare: 0,
                marketsHistoric: 0,
                inventory: 0,
                ors: 0,
                aircraftFleet: 0,
                aircraftFlights: 0,
                maintenance: 0,
                accounting: 0,
                crew: 0,
                alliance: 0,
                serviceProfiles: 0,
                scrapeArchives: 0
            }
            for (const k in all || {}) {
                if (k.indexOf("routeAssistant:demand:") === 0) counts.demand++
                else if (k.indexOf("routeAssistant:topRoutes:") === 0) counts.topRoutes++
                else if (k.indexOf("routeAssistant:markets:competitors:") === 0) counts.marketsCompetitors++
                else if (k.indexOf("routeAssistant:markets:ownPricing:") === 0) counts.marketsOwnPricing++
                else if (k.indexOf("routeAssistant:markets:marketShare:") === 0) counts.marketsMarketShare++
                else if (k.indexOf("routeAssistant:markets:historic:") === 0) counts.marketsHistoric++
                else if (k.indexOf("routeAssistant:inventory:") === 0) counts.inventory++
                else if (k.indexOf("routeAssistant:ors:") === 0) counts.ors++
                else if (/aircraftFleet$/.test(k)) counts.aircraftFleet++
                else if (k.indexOf("aircraftFlights") >= 0) counts.aircraftFlights++
                else if (k.indexOf("aircraftFlightPlan:maintenance:") === 0) counts.maintenance++
                else if (k.indexOf("accounting:") >= 0) counts.accounting++
                else if (k.indexOf("crewMgmt:") === 0) counts.crew++
                else if (k.indexOf("alliance:") === 0) counts.alliance++
                else if (k.indexOf("routeAssistant:serviceProfile") === 0) counts.serviceProfiles++
                else if (k.indexOf("scrapeOrchestrator:run:") === 0) counts.scrapeArchives++
            }
            resolve(counts)
        })
    })`
}

function startExpression(phases) {
    return `(() => {
        if (window.__AESFullHarvestRun && !window.__AESFullHarvestRun.done) {
            return {started: false, reason: "already-running"}
        }
        const run = {
            done: false,
            startedAt: Date.now(),
            current: null,
            events: [],
            result: null,
            error: null
        }
        const push = evt => {
            const row = Object.assign({at: Date.now()}, evt || {})
            run.current = row
            run.events.push(row)
            if (run.events.length > 500) run.events.splice(0, run.events.length - 500)
        }
        window.__AESFullHarvestRun = run
        const orchestrator = new ScrapeOrchestrator({
            onPhaseStart: e => push(Object.assign({type: "phase-start"}, e || {})),
            onPhaseDone: e => push(Object.assign({type: "phase-done"}, e || {})),
            onProgress: e => push(e || {}),
            onError: e => push(Object.assign({type: "error"}, e || {})),
            onDone: e => {
                run.done = true
                run.completedAt = Date.now()
                run.result = e || null
                push(Object.assign({type: "done"}, e || {}))
            }
        })
        run.orchestrator = orchestrator
        orchestrator.start({
            source: "codex-harvest",
            phaseFilter: ${JSON.stringify(phases)},
            includePerCompetitor: false,
            includeDemandSeed: false,
            includeFlightsFrom: false
        }).catch(error => {
            run.done = true
            run.completedAt = Date.now()
            run.error = (error && error.message) || String(error)
            push({type: "fatal", message: run.error})
        })
        return {started: true, phases: ${JSON.stringify(phases)}}
    })()`
}

const report = {
    ok: false,
    mode: "full-read-only-harvest",
    port: PORT,
    server: SERVER,
    dashboardUrl: DASHBOARD_URL,
    phases: PHASES,
    launch: LAUNCH,
    profile: LAUNCH ? PROFILE : null,
    startedAt: new Date().toISOString(),
    before: null,
    after: null,
    progress: [],
    result: null,
    errors: []
}

try {
    let context
    if (LAUNCH) {
        fs.mkdirSync(PROFILE, {recursive: true})
        context = await chromium.launchPersistentContext(PROFILE, {
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
    } else {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
        context = browser.contexts()[0]
    }
    if (!context) throw new Error(`No browser context on ${PORT}`)
    const page = LAUNCH
        ? (context.pages()[0] || await context.newPage())
        : (context.pages().find(p => /enterprise\/dashboard/i.test(p.url())) || await context.newPage())
    console.log("[harvest-driver] page", page.url())
    if (LAUNCH) report.loggedIn = await loginIfNeeded(page)
    await goto(page, DASHBOARD_URL)
    if (LAUNCH && /\/auth\/login/i.test(page.url())) {
        report.loggedIn = await loginIfNeeded(page)
        await goto(page, DASHBOARD_URL)
    }
    await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    await page.waitForTimeout(2500)
    console.log("[harvest-driver] dashboard", page.url(), await page.title().catch(() => ""))
    report.url = page.url()
    report.title = await page.title().catch(() => "")
    if (/\/auth\/login/i.test(page.url())) throw new Error("not logged in")

    const {client, contextId} = await findAesContext(
        page,
        "window.ScrapeOrchestrator && window.ScrapeOrchestratorPhases && window.AesScrapeRunArchiveStore"
    )
    try {
        report.before = await evalIn(client, contextId, countExpression())
        report.start = await evalIn(client, contextId, startExpression(PHASES))
        let last = ""
        while (true) {
            const state = await evalIn(client, contextId, `(() => {
                const run = window.__AESFullHarvestRun || null
                if (!run) return null
                return {
                    done: !!run.done,
                    startedAt: run.startedAt || null,
                    completedAt: run.completedAt || null,
                    current: run.current || null,
                    events: (run.events || []).slice(-20),
                    result: run.result || null,
                    error: run.error || null
                }
            })()`)
            if (!state) throw new Error("harvest state disappeared")
            if (state.current) {
                const c = state.current
                const line = [
                    c.type || "event",
                    c.phaseId || c.phase || "",
                    c.jobId || "",
                    c.succeeded != null ? `ok=${c.succeeded}` : "",
                    c.failed != null ? `fail=${c.failed}` : "",
                    c.total != null ? `total=${c.total}` : ""
                ].filter(Boolean).join(" ")
                if (line && line !== last) {
                    console.log("[harvest]", line)
                    last = line
                }
                report.progress.push({
                    at: new Date().toISOString(),
                    current: state.current,
                    recent: state.events
                })
            }
            if (state.done) {
                report.result = state.result
                if (state.error) throw new Error(state.error)
                break
            }
            await sleep(POLL_MS)
        }
        report.after = await evalIn(client, contextId, countExpression())
        report.ok = true
    } finally {
        await client.detach().catch(() => {})
    }
} catch (error) {
    report.errors.push((error && error.message) || String(error))
} finally {
    report.completedAt = new Date().toISOString()
    await mkdir(path.dirname(OUT), {recursive: true})
    await writeFile(OUT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({
        ok: report.ok,
        out: OUT,
        title: report.title,
        before: report.before,
        after: report.after,
        result: report.result,
        errors: report.errors
    }, null, 2))
}

process.exit(report.ok ? 0 : 1)
