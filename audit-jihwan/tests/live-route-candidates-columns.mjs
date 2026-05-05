import {chromium} from "playwright"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname)
const CHROME = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const PROFILE = process.env.AES_ROUTE_COLUMNS_PROFILE
    || path.join(os.tmpdir(), "aes-chrome-routebuilder-10038")
const PORT = String(process.env.AES_ROUTE_COLUMNS_PORT || "10039")
const HOST = process.env.AES_ROUTE_COLUMNS_HOST || "https://free1.airlinesim.aero"
const ENTERPRISE_ID = process.env.AES_ROUTE_COLUMNS_ENTERPRISE_ID || "775"
const AIRCRAFT_ID = process.env.AES_ROUTE_COLUMNS_AIRCRAFT_ID || "22092"
const REPORT = path.resolve(process.env.AES_ROUTE_COLUMNS_REPORT
    || "audit-jihwan/pw-results/live-route-candidates-columns-20260505.json")
const SHOT = path.resolve(process.env.AES_ROUTE_COLUMNS_SHOT
    || "audit-jihwan/pw-results/live-route-candidates-columns-20260505.png")

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function gotoDom(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function loginIfNeeded(page) {
    await gotoDom(page, HOST + "/app/enterprise/dashboard")
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false

    const email = process.env.AES_LOGIN_EMAIL || ""
    const password = process.env.AES_LOGIN_PASSWORD || ""
    if (!email || !password) throw new Error("login required but AES_LOGIN_EMAIL/PASSWORD are not set")

    await gotoDom(page, "https://www.airlinesim.aero/auth/login")
    await page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first().fill(email)
    await page.locator("input[type='password']").first().fill(password)
    await Promise.all([
        page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000}),
        page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click()
    ])
    return true
}

async function resolveAircraftId(page) {
    if (AIRCRAFT_ID && AIRCRAFT_ID !== "auto") {
        await gotoDom(page, HOST + "/app/fleets/aircraft/" + encodeURIComponent(AIRCRAFT_ID) + "/0?aes-debug")
        await page.waitForLoadState("networkidle").catch(() => {})
        if (!/\/action\/user\/invalidParameter/i.test(page.url())) return AIRCRAFT_ID
    }

    await gotoDom(page, HOST + "/app/fleets")
    await page.waitForLoadState("networkidle").catch(() => {})
    const found = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a[href*='/app/fleets/aircraft/']"))
        for (const a of links) {
            const href = a.getAttribute("href") || ""
            const m = /\/app\/fleets\/aircraft\/(\d+)/.exec(href)
            if (m) return m[1]
        }
        return null
    })
    if (!found) throw new Error("no aircraft link found on fleet page")
    await gotoDom(page, HOST + "/app/fleets/aircraft/" + encodeURIComponent(found) + "/0?aes-debug")
    await page.waitForLoadState("networkidle").catch(() => {})
    if (/\/action\/user\/invalidParameter/i.test(page.url())) {
        throw new Error("discovered aircraft id also redirected to invalidParameter: " + found)
    }
    return found
}

async function getAesContext(page) {
    const session = await page.context().newCDPSession(page)
    const contexts = []
    session.on("Runtime.executionContextCreated", ev => {
        if (ev && ev.context) contexts.push(ev.context)
    })
    await session.send("Runtime.enable")
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
        for (const ctx of contexts) {
            try {
                const probe = await session.send("Runtime.evaluate", {
                    contextId: ctx.id,
                    expression: "!!(window.AesAfpRouteCandidates || window.AesAfp || window.AES || window.RouteAssistantSchedulePageScraper)",
                    returnByValue: true
                })
                if (probe.result && probe.result.value) return {session, contextId: ctx.id}
            } catch (_) {}
        }
        await sleep(250)
    }
    await session.detach().catch(() => {})
    throw new Error("AES AFP route-candidate context not found")
}

async function evalAes(page, expression) {
    const {session, contextId} = await getAesContext(page)
    try {
        const res = await session.send("Runtime.evaluate", {
            contextId,
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: 120000
        })
        if (res.exceptionDetails) {
            const ex = res.exceptionDetails.exception || {}
            throw new Error(ex.description || ex.value || res.exceptionDetails.text || "Runtime.evaluate failed")
        }
        return res.result ? res.result.value : null
    } finally {
        await session.detach().catch(() => {})
    }
}

fs.mkdirSync(path.dirname(REPORT), {recursive: true})
fs.mkdirSync(path.dirname(SHOT), {recursive: true})
fs.mkdirSync(PROFILE, {recursive: true})

const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: fs.existsSync(CHROME) ? CHROME : chromium.executablePath(),
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

const page = context.pages()[0] || await context.newPage()
const consoleRows = []
const pageErrors = []
page.on("console", msg => {
    if (["error", "warning"].includes(msg.type())) consoleRows.push({type: msg.type(), text: msg.text()})
})
page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

try {
    const loggedIn = await loginIfNeeded(page)
    await gotoDom(page, HOST + "/app/enterprise/dashboard?select=" + encodeURIComponent(ENTERPRISE_ID))
    await page.waitForLoadState("networkidle").catch(() => {})
    const aircraftId = await resolveAircraftId(page)
    await page.waitForSelector(".as-page-aircraft, body", {timeout: 45000})
    await sleep(2500)

    const snapshot = await evalAes(page, `(
        async () => {
            const required = [
                "AesAfpRouteCandidates",
                "RouteAssistantSchedulePageScraper",
                "RouteAssistantSettings"
            ]
            const missing = required.filter(name => typeof window[name] === "undefined")
            if (missing.length) {
                return {
                    missing,
                    href: location.href,
                    title: document.title,
                    hasAes: typeof window.AES !== "undefined",
                    hasAfp: typeof window.AesAfp !== "undefined",
                    globals: Object.keys(window).filter(k => /^Aes|^RouteAssistant/.test(k)).sort().slice(0, 80)
                }
            }
            const hub = String(
                (window.AesAfp && typeof AesAfp.getActiveHub === "function" && AesAfp.getActiveHub())
                || (window.AesAfp && AesAfp.ctx && AesAfp.ctx.currentLocationIata)
                || "JFK"
            ).toUpperCase()
            const dest = hub === "JFK" ? "LAX" : "JFK"
            const server = (window.AesAfp && AesAfp.ctx && AesAfp.ctx.server) || "free1"
            const now = Date.now()

            const scheduleRecord = await RouteAssistantSchedulePageScraper.saveRecord(hub, dest, {
                weeklyFlights: 14,
                dailyFlights: [2, 2, 2, 2, 2, 2, 2],
                daysPerWeek: 7,
                departureTime: "06:00",
                primaryAircraftType: "Boeing 737-700",
                primaryAircraftTypeId: 123,
                primaryAircraftReg: "BGW",
                cruiseSpeedKmh: 820,
                flights: [{flightNumber: "AES1", departureTime: "06:00", frequencyDays: "1234567"}]
            }, "live-browser-check")

            const topBlob = {
                server,
                hub,
                scrapedAt: now,
                snapshotAt: now,
                rows: [{
                    hub,
                    destIata: dest,
                    destName: dest,
                    distanceKm: hub === "JFK" && dest === "LAX" ? 3971 : 5535,
                    paxScore: 10,
                    cargoScore: 8,
                    weeklyFlights: 259,
                    airlineCount: 6,
                    score: 92,
                    scoreBlend: 92,
                    demandSource: "route-assistant",
                    demandBasis: "live browser route-builder check"
                }]
            }
            await chrome.storage.local.set({["routeAssistant:topRoutes:" + hub]: topBlob})

            const settings = typeof RouteAssistantSettings !== "undefined"
                ? await RouteAssistantSettings.load()
                : {aircraftFlightPlan: {candidateChips: {rangeFitOnly: false, hideAlreadyScheduled: false}}}
            settings.aircraftFlightPlan = settings.aircraftFlightPlan || {}
            settings.aircraftFlightPlan.candidateChips = Object.assign(
                {rangeFitOnly: false, hideAlreadyScheduled: false},
                settings.aircraftFlightPlan.candidateChips || {}
            )

            const spec = (window.AesAfpSpecResolver && AesAfpSpecResolver.last)
                || {typeName: "Browser Test", range: 12000, cruiseSpeedKmh: 850}
            const rows = await AesAfpRouteCandidates.compute({
                originIata: hub,
                spec,
                settings,
                scheduledDestSet: new Set(),
                scheduledFlightIds: new Set(),
                scheduleLegs: []
            })
            const host = document.createElement("div")
            host.id = "aes-live-route-candidate-check"
            host.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:999999;"
                + "max-height:420px;overflow:auto;background:#0f1623;border:2px solid #60a5fa;padding:10px;"
            document.body.appendChild(host)
            AesAfpRouteCandidates._chipState = {
                rangeFitOnly: false,
                hideAlreadyScheduled: false,
                watchlistOnly: false,
                showWaves: false,
                topN: 10
            }
            AesAfpRouteCandidates.render(host, rows, {originIata: hub, settings, spec})

            const headers = Array.from(host.querySelectorAll("th")).map(th => th.textContent.trim())
            const firstCells = Array.from(host.querySelectorAll("tbody tr:first-child td")).map(td => td.textContent.trim())
            const first = rows.find(r => r.destIata === dest) || rows[0] || null
            return {
                hub,
                dest,
                scheduleRecord: {
                    weeklyFlights: scheduleRecord.weeklyFlights,
                    departureTime: scheduleRecord.departureTime,
                    primaryAircraftType: scheduleRecord.primaryAircraftType
                },
                candidate: first && {
                    destIata: first.destIata,
                    weeklyFlights: first.weeklyFlights,
                    liveWeeklyFlights: first.liveWeeklyFlights,
                    liveDeparture: first.liveDeparture,
                    liveAircraftType: first.liveAircraftType,
                    paxScore: first.paxScore
                },
                headers,
                firstCells,
                hostText: host.innerText.slice(0, 1000),
                headerCount: headers.length,
                cellCount: firstCells.length,
                hasAsWeekly: headers.includes("AS/w"),
                hasAsDeparture: headers.includes("AS dep"),
                columnsAligned: headers.length === firstCells.length
            }
        }
    )()`)

    await page.screenshot({path: SHOT, fullPage: false}).catch(() => {})
    const output = {
        ok: !!snapshot && snapshot.hasAsWeekly && snapshot.hasAsDeparture
            && snapshot.columnsAligned
            && snapshot.candidate && snapshot.candidate.liveWeeklyFlights === 14
            && pageErrors.length === 0,
        url: page.url(),
        title: await page.title().catch(() => ""),
        loggedIn,
        aircraftId,
        remoteDebuggingPort: PORT,
        profile: PROFILE,
        screenshot: SHOT,
        snapshot,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(REPORT, JSON.stringify(output, null, 2))
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = output.ok ? 0 : 1
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") await context.close()
}
