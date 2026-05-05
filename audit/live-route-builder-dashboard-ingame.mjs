import { chromium } from "playwright"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const port = String(process.env.AES_RB_LIVE_PORT || "10043")
const profileDir = process.env.AES_RB_LIVE_PROFILE
    || path.join(os.tmpdir(), "aes-route-builder-ingame-" + port)
const reportPath = path.resolve(process.env.AES_RB_LIVE_REPORT
    || path.join(repoRoot, "audit", "live-route-builder-dashboard-ingame-" + port + "-20260505.json"))
const shotPath = path.resolve(process.env.AES_RB_LIVE_SHOT
    || path.join(repoRoot, "audit", "live-route-builder-dashboard-ingame-" + port + "-20260505.png"))
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normaliseServerHost(process.env.AES_REAL_SERVER || creds.server || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = String(process.env.AES_REAL_ENTERPRISE_ID || process.env.AES_TEST_ENTERPRISE_ID || "775")
const hub = String(process.env.AES_RB_LIVE_HUB || "JFK").toUpperCase()
const dests = String(process.env.AES_RB_LIVE_DESTS || "LAX,ORD,MCO")
    .split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 8)

function normaliseServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function gotoDomContentLoaded(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function loginIfNeeded(page) {
    await gotoDomContentLoaded(page, "https://" + serverHost + "/app/enterprise/dashboard")
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false

    await gotoDomContentLoaded(page, "https://www.airlinesim.aero/auth/login")
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first()
    await loginInput.fill(creds.email)
    await page.locator("input[type='password']").first().fill(creds.password)
    await Promise.all([
        page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000}),
        page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click()
    ])
    return true
}

async function evalInContext(client, contextId, expression) {
    const res = await client.send("Runtime.evaluate", {
        contextId,
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 900000
    })
    if (res.exceptionDetails) {
        const ex = res.exceptionDetails.exception || {}
        throw new Error(ex.description || ex.value || res.exceptionDetails.text || "Runtime.evaluate failed")
    }
    return res.result && Object.prototype.hasOwnProperty.call(res.result, "value")
        ? res.result.value
        : null
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
                    "AesAfpRouteBuilderModal",
                    "AesAfpRouteBuilderPlanner",
                    "RouteAssistantSchedulePageScraper",
                    "RouteAssistantMarketsPageScraper",
                    "RouteAssistantDistanceResolver"
                ]
                return names.filter(name => !!window[name]).length
            })()`).catch(() => 0)
            if (score >= 5) return {client, contextId: ctx.id}
        }
        await sleep(500)
    }
    await client.detach().catch(() => {})
    throw new Error("AES Route Builder isolated context not found")
}

async function evalInFreshAesContext(page, expression) {
    const found = await findAesContext(page)
    try {
        return await evalInContext(found.client, found.contextId, expression)
    } finally {
        await found.client.detach().catch(() => {})
    }
}

function seedAndOpenExpression(input) {
    return `(${async function run(input) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
        const required = [
            "AesAfpRouteBuilderModal",
            "AesAfpRouteBuilderPlanner",
            "RouteAssistantSchedulePageScraper",
            "RouteAssistantMarketsPageScraper",
            "RouteAssistantDistanceResolver"
        ]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return {ok: false, stage: "modules", missing}

        const hub = input.hub
        const dests = input.dests
        const resolver = new RouteAssistantDistanceResolver(input.serverSlug)
        const schedule = new RouteAssistantSchedulePageScraper(input.serverSlug)
        const markets = new RouteAssistantMarketsPageScraper(input.serverSlug)
        const scrapeResults = []

        for (const dest of dests) {
            const row = {hub, dest}
            try {
                const dist = await resolver.resolve(hub, dest)
                row.distanceKm = dist && dist.distanceKm || null
                row.distanceSource = dist && dist.source || null
            } catch (e) {
                row.distanceError = String(e && e.message || e)
            }
            try {
                const rec = await schedule.scrape(hub, dest)
                row.scheduleWeeklyFlights = rec && rec.weeklyFlights || 0
                row.scheduleDeparture = rec && rec.departureTime || null
                row.scheduleAircraft = rec && rec.primaryAircraftType || null
            } catch (e) {
                row.scheduleError = String(e && e.message || e)
            }
            try {
                const rec = await markets.scrape(hub, dest)
                row.marketFamilies = rec ? Object.keys(rec).sort() : []
                row.marketHasPricing = !!(rec && rec.ownPricing)
                row.marketHasCompetitors = !!(rec && rec.competitors)
                row.marketHasShare = !!(rec && rec.marketShare)
            } catch (e) {
                row.marketError = String(e && e.message || e)
            }
            scrapeResults.push(row)
        }

        window.__aesRouteBuilderLiveOpen = AesAfpRouteBuilderModal.open({
            server: input.serverSlug,
            airline: "",
            hub,
            defaultIatas: dests.slice(0, 3),
            defaultFlights: 4
        }).catch(e => ({error: String(e && e.message || e)}))
        await sleep(5000)

        const modal = document.querySelector("[data-aes-route-builder-modal]")
        const text = modal ? (modal.innerText || modal.textContent || "") : ""
        const rows = Array.from(document.querySelectorAll("[data-aes-rb-candidate-row]")).map(el => ({
            dest: el.getAttribute("data-aes-rb-candidate-row"),
            selected: el.getAttribute("data-aes-rb-selected") === "1",
            text: (el.innerText || el.textContent || "").trim()
        }))
        return {
            ok: !!modal && rows.length > 0,
            stage: "opened",
            url: location.href,
            hub,
            dests,
            scrapeResults,
            modalText: text.slice(0, 5000),
            rows
        }
    }})(` + JSON.stringify(input) + `)`
}

function cadenceExpression(input) {
    return `(${async function run(input) {
        const required = [
            "AesRoutePriceAutomator",
            "AesRoutePriceAutomatorDashboardLoop",
            "RouteAssistantSettings"
        ]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return {ok: false, stage: "modules", missing}

        const original = await RouteAssistantSettings.load()
        const startedAt = Date.now()
        let restoreError = null
        const observed = []
        const seen = new Set()
        try {
            const prepared = await RouteAssistantSettings.load()
            prepared.pricing = prepared.pricing || {}
            const pricing = prepared.pricing
            pricing.apply = Object.assign({}, pricing.apply || {}, {
                enabled: true,
                dryRunOnly: true
            })
            pricing.silentAutoEnabled = true
            pricing.silentAutoConfirmedAt = Date.now()
            pricing.silentAutoFollowMode = "all"
            pricing.silentAutoTickSec = 5
            pricing.silentAutoTickMin = 5 / 60
            pricing.silentAutoMutedUntil = null
            pricing.silentAutoLastTickAt = null
            pricing.silentAutoLastTickResult = null
            await RouteAssistantSettings.save({pricing})

            if (typeof AesRoutePriceAutomatorDashboardLoop.start === "function") {
                AesRoutePriceAutomatorDashboardLoop.start()
            }
            const deadline = Date.now() + input.timeoutMs
            while (Date.now() < deadline && observed.length < input.ticks) {
                const latest = await RouteAssistantSettings.load()
                const p = latest && latest.pricing || {}
                const at = Number(p.silentAutoLastTickAt)
                if (isFinite(at) && at > 0 && !seen.has(at)) {
                    seen.add(at)
                    observed.push({
                        at,
                        iso: new Date(at).toISOString(),
                        result: p.silentAutoLastTickResult || null
                    })
                }
                await new Promise(resolve => setTimeout(resolve, 250))
            }
        } finally {
            try {
                await RouteAssistantSettings.save({pricing: original.pricing, ors: original.ors})
            } catch (e) {
                restoreError = String(e && e.message || e)
            }
        }
        const deltasMs = []
        for (let i = 1; i < observed.length; i++) deltasMs.push(observed[i].at - observed[i - 1].at)
        return {
            ok: observed.length >= input.ticks && deltasMs.every(ms => ms >= 4000 && ms <= 9000) && !restoreError,
            stage: "done",
            startedAt,
            observed,
            deltasMs,
            restoredSettings: !restoreError,
            restoreError
        }
    }})(` + JSON.stringify(input) + `)`
}

fs.mkdirSync(profileDir, {recursive: true})
fs.mkdirSync(path.dirname(reportPath), {recursive: true})
fs.mkdirSync(path.dirname(shotPath), {recursive: true})

const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: fs.existsSync(chromePath) ? chromePath : chromium.executablePath(),
    headless: false,
    viewport: {width: 1440, height: 1000},
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
        "--disable-extensions-except=" + extensionPath,
        "--load-extension=" + extensionPath,
        "--remote-debugging-port=" + port,
        "--remote-allow-origins=*",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check"
    ]
})

const consoleRows = []
const pageErrors = []

try {
    const page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(90000)
    page.on("console", msg => {
        if (msg.type() === "error" || msg.type() === "warning") {
            consoleRows.push({type: msg.type(), text: msg.text(), url: page.url()})
        }
    })
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    const loggedIn = await loginIfNeeded(page)
    const dashboardUrl = "https://" + serverHost + "/app/enterprise/dashboard?3&select=" + encodeURIComponent(enterpriseId)
    await gotoDomContentLoaded(page, dashboardUrl)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 60000})

    const pricingCadence = await evalInFreshAesContext(page, cadenceExpression({
        ticks: 3,
        timeoutMs: 40000
    }))

    const modalBeforePlan = await evalInFreshAesContext(page, seedAndOpenExpression({
        serverSlug,
        hub,
        dests
    }))

    const recommend = page.locator("[data-aes-route-builder-modal] button").filter({hasText: "Recommend schedule"}).first()
    await recommend.click({timeout: 30000})
    await page.locator("[data-aes-route-builder-modal]").filter({hasText: "Mock schedule"}).waitFor({timeout: 30000})
    await page.screenshot({path: shotPath, fullPage: true, timeout: 30000}).catch(() => {})

    const modalAfterPlan = await page.evaluate(() => {
        const modal = document.querySelector("[data-aes-route-builder-modal]")
        const text = modal ? (modal.innerText || modal.textContent || "") : ""
        return {
            text: text.slice(0, 5000),
            mockSchedule: /Mock schedule/i.test(text),
            rows: Array.from(document.querySelectorAll("[data-aes-rb-candidate-row]")).map(el => ({
                dest: el.getAttribute("data-aes-rb-candidate-row"),
                selected: el.getAttribute("data-aes-rb-selected") === "1",
                text: (el.innerText || el.textContent || "").trim()
            }))
        }
    })

    const rowText = modalAfterPlan.rows.map(r => r.text).join("\n")
    const output = {
        ok: !!(pricingCadence && pricingCadence.ok)
            && !!(modalBeforePlan && modalBeforePlan.ok)
            && modalAfterPlan.mockSchedule
            && /Candidate routes - Route Assistant in-game data/i.test(modalAfterPlan.text)
            && (/\/wk/.test(rowText) || /AS schedule/i.test(modalBeforePlan.modalText))
            && (/AS|Y |%/.test(rowText) || /AS pricing|AS competitors|AS market share/i.test(modalBeforePlan.modalText))
            && pageErrors.length === 0,
        server: serverHost,
        enterpriseId,
        loggedIn,
        url: page.url(),
        title: await page.title().catch(() => ""),
        profileDir,
        remoteDebuggingPort: port,
        hub,
        dests,
        pricingCadence,
        modalBeforePlan,
        modalAfterPlan,
        screenshot: shotPath,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2))
    console.log(JSON.stringify({
        ok: output.ok,
        port,
        hub,
        dests,
        pricingDeltasMs: pricingCadence && pricingCadence.deltasMs,
        candidateRows: modalAfterPlan.rows.length,
        mockSchedule: modalAfterPlan.mockSchedule,
        screenshot: shotPath,
        report: reportPath
    }, null, 2))
    process.exitCode = output.ok ? 0 : 1
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}
