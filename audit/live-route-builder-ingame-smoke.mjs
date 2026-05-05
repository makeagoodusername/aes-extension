import {chromium} from "playwright"
import fs from "node:fs"
import {readFile} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const port = process.env.AES_LIVE_CHROME_PORT || "10033"
const profileDir = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), `aes-route-builder-ingame-${port}`)
const serverHost = "free1.airlinesim.aero"
const enterpriseId = process.env.AES_REAL_ENTERPRISE_ID || "775"
let aircraftId = process.env.AES_AIRCRAFT_ID || "22092"
const reportPath = process.env.AES_ROUTE_BUILDER_INGAME_REPORT
    || path.join(repoRoot, "audit", `live-route-builder-ingame-${port}-20260505.json`)
const screenshotPath = process.env.AES_ROUTE_BUILDER_INGAME_SHOT
    || path.join(repoRoot, "audit", `live-route-builder-ingame-${port}-20260505.png`)

const fileCreds = JSON.parse(await readFile(credentialsPath, "utf8"))
const loginEmail = process.env.AES_LOGIN_EMAIL || fileCreds.email
const loginPassword = process.env.AES_LOGIN_PASSWORD || fileCreds.password
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function gotoDom(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function loginIfNeeded(page) {
    await gotoDom(page, `https://${serverHost}/app/enterprise/dashboard`)
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false

    await gotoDom(page, "https://www.airlinesim.aero/auth/login")
    await page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first().fill(loginEmail)
    await page.locator("input[type='password']").first().fill(loginPassword)
    await page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')")
        .first().click()
    try {
        await page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000})
    } catch (_) {
        const details = await page.locator(".form-error, .alert, .error, [class*='error']")
            .allTextContents({timeout: 2000})
            .catch(() => [])
        throw new Error("Login did not leave AirlineSim auth page"
            + (details.length ? ": " + details.join(" | ").slice(0, 500) : ""))
    }
    return true
}

async function findAesContext(page, predicate, timeoutMs = 60000) {
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
                    expression: "(() => { try { return !!(" + predicate + ") } catch (_) { return false } })()",
                    returnByValue: true,
                    timeout: 2000
                })
                if (res && res.result && res.result.value === true) return {client, contextId: ctx.id}
            } catch (_) {}
        }
        await sleep(300)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated context not found")
}

async function evalAes(page, expression, timeoutMs = 90000) {
    const found = await findAesContext(page,
        "window.AesAfp || window.AesDataBus || window.CentralHubBus || window.RouteAssistantSettings",
        timeoutMs)
    try {
        const res = await found.client.send("Runtime.evaluate", {
            contextId: found.contextId,
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: timeoutMs
        })
        if (res.exceptionDetails) {
            const ex = res.exceptionDetails.exception || {}
            throw new Error(ex.description || ex.value || res.exceptionDetails.text || "Runtime.evaluate failed")
        }
        return res.result && Object.prototype.hasOwnProperty.call(res.result, "value")
            ? res.result.value
            : null
    } finally {
        await found.client.detach().catch(() => {})
    }
}

async function discoverAircraftId(page) {
    const candidates = []
    for (const url of [
        `https://${serverHost}/app/fleets`,
        `https://${serverHost}/app/fleets/aircraft`
    ]) {
        await gotoDom(page, url)
        await page.waitForLoadState("networkidle").catch(() => {})
        const ids = await page.evaluate(() => {
            const out = []
            for (const a of document.querySelectorAll("a[href*='/app/fleets/aircraft/']")) {
                const href = String(a.href || a.getAttribute("href") || "")
                const m = /\/app\/fleets\/aircraft\/(\d+)/.exec(href)
                if (m && out.indexOf(m[1]) < 0) out.push(m[1])
            }
            return out
        }).catch(() => [])
        for (const id of ids) if (candidates.indexOf(id) < 0) candidates.push(id)
        if (candidates.length) return candidates[0]
    }
    throw new Error("No accessible aircraft found on the current enterprise fleet pages")
}

fs.mkdirSync(profileDir, {recursive: true})
const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: fs.existsSync(chromePath) ? chromePath : chromium.executablePath(),
    headless: false,
    viewport: {width: 1440, height: 1000},
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--remote-debugging-port=${port}`,
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
    page.setDefaultTimeout(60000)
    page.on("console", msg => {
        if (msg.type() === "error" || msg.type() === "warning") {
            consoleRows.push({type: msg.type(), text: msg.text().slice(0, 500)})
        }
    })
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    const loggedIn = await loginIfNeeded(page)
    await gotoDom(page, `https://${serverHost}/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseId)}`)
    await page.waitForLoadState("networkidle").catch(() => {})
    await gotoDom(page, `https://${serverHost}/app/fleets/aircraft/${encodeURIComponent(aircraftId)}/0?aes-rb-ingame=${Date.now()}`)
    await page.waitForLoadState("networkidle").catch(() => {})
    if (/\/action\/user\/invalidParameter/i.test(page.url())) {
        aircraftId = await discoverAircraftId(page)
        await gotoDom(page, `https://${serverHost}/app/fleets/aircraft/${encodeURIComponent(aircraftId)}/0?aes-rb-ingame=${Date.now()}`)
        await page.waitForLoadState("networkidle").catch(() => {})
    }
    await sleep(2500)
    await page.locator("button:has-text('GOT IT'), button:has-text('Got it')")
        .first().click({timeout: 2500}).catch(() => {})

    const result = await evalAes(page, `(${async function () {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
        const missing = ["AesAfp", "AesAfpRouteCandidates", "RouteAssistantSchedulePageScraper"]
            .filter(name => typeof window[name] === "undefined")
        if (missing.length) {
            return {
                ok: false,
                stage: "missing-modules",
                missing,
                url: location.href,
                title: document.title,
                bodyText: (document.body && document.body.innerText || "").slice(0, 1000)
            }
        }
        const iata = value => {
            const s = String(value || "").trim().toUpperCase()
            return /^[A-Z]{3}$/.test(s) ? s : null
        }
        await sleep(1200)
        const ctx = window.AesAfp && AesAfp.ctx || {}
        const server = ctx.server || "free1"
        const legs = (window.AesAfp && typeof AesAfp.getCurrentSchedule === "function")
            ? (AesAfp.getCurrentSchedule() || []) : []
        const pairs = []
        const seen = new Set()
        for (const leg of legs) {
            const origin = iata(leg && leg.origin)
            const dest = iata(leg && leg.destination)
            if (!origin || !dest || origin === dest) continue
            const key = origin + "-" + dest
            if (seen.has(key)) continue
            seen.add(key)
            pairs.push({origin, dest})
        }
        const scraper = new RouteAssistantSchedulePageScraper(server)
        const scraped = []
        for (const pair of pairs.slice(0, 6)) {
            const rec = await scraper.scrape(pair.origin, pair.dest)
            scraped.push({
                pair: pair.origin + "-" + pair.dest,
                weeklyFlights: rec && rec.weeklyFlights,
                departureTime: rec && rec.departureTime,
                aircraftType: rec && rec.primaryAircraftType,
                flights: rec && rec.flights && rec.flights.length
            })
        }
        const hub = (scraped.find(r => r && r.weeklyFlights != null) || pairs[0] || {}).pair
            ? String((scraped.find(r => r && r.weeklyFlights != null) || {pair: pairs[0].origin + "-" + pairs[0].dest}).pair).split("-")[0]
            : (typeof AesAfp.getActiveHub === "function" ? AesAfp.getActiveHub() : ctx.currentLocationIata)
        if (hub && ctx.currentLocationIata && hub !== ctx.currentLocationIata) {
            const key = "aircraftFlightPlan:planHub:" + server + ":" + ctx.aircraftId
            await chrome.storage.local.set({[key]: {iata: hub, server, aircraftId: ctx.aircraftId, ts: Date.now()}})
            if (AesAfp.bus) AesAfp.bus.emit("hub:changed", {hub})
        }
        const settings = typeof AesAfpSettings !== "undefined" ? await AesAfpSettings.load() : {}
        const spec = window.AesAfpSpecResolver && AesAfpSpecResolver.last || null
        const scheduledDestSet = new Set(legs.map(l => iata(l && l.destination)).filter(Boolean))
        const scheduledFlightIds = new Set(legs.map(l => l && l.flightId != null ? String(l.flightId) : null).filter(Boolean))
        const candidates = await AesAfpRouteCandidates.compute({
            originIata: hub,
            spec,
            settings,
            scheduledDestSet,
            scheduledFlightIds,
            scheduleLegs: legs
        })
        AesAfpRouteCandidates._chipState = Object.assign(
            AesAfpRouteCandidates._chipState || {},
            {rangeFitOnly: false, hideAlreadyScheduled: false, topN: "all"}
        )
        const host = window.AesAfp && AesAfp.slot && AesAfp.slot("candidates")
        if (host) AesAfpRouteCandidates.render(host, candidates, {
            originIata: hub, spec, settings, scheduledDestSet, scheduledFlightIds, scheduleLegs: legs
        })
        if (window.AesAfpAutoSchedulerPreview && AesAfpAutoSchedulerPreview.render) {
            AesAfpAutoSchedulerPreview.render()
        }
        const liveCandidates = candidates
            .filter(c => c && (c.liveWeeklyFlights != null || c.liveDeparture || c.liveAircraftType))
            .map(c => ({
                destIata: c.destIata,
                distanceKm: c.distanceKm,
                distanceNm: c.distanceNm,
                weeklyFlights: c.weeklyFlights,
                liveWeeklyFlights: c.liveWeeklyFlights,
                liveDeparture: c.liveDeparture,
                liveAircraftType: c.liveAircraftType,
                scoreBlend: c.scoreBlend
            }))
        let plannerCandidates = candidates
        if (liveCandidates.length && typeof RouteAssistantDistanceResolver !== "undefined") {
            plannerCandidates = candidates.map(c => Object.assign({}, c))
            const distanceResolver = new RouteAssistantDistanceResolver(server)
            for (const c of plannerCandidates) {
                if (!c || !(c.liveWeeklyFlights != null || c.liveDeparture || c.liveAircraftType)) continue
                if (Number(c.distanceKm) > 0 || Number(c.distanceNm) > 0) continue
                try {
                    const rec = await distanceResolver.resolve(hub, c.destIata)
                    if (rec && Number(rec.distanceKm) > 0) c.distanceKm = Number(rec.distanceKm)
                } catch (_) {}
            }
        }
        const plannerPick = plannerCandidates.find(c => c
            && (c.liveWeeklyFlights != null || c.liveDeparture || c.liveAircraftType)
            && (Number(c.distanceKm) > 0 || Number(c.distanceNm) > 0))
        const plannerProbe = plannerPick && window.AesAfpRouteBuilderPlanner
            ? AesAfpRouteBuilderPlanner.recommend({
                hubIata: hub,
                candidates: plannerCandidates,
                spec,
                config: {
                    includedIatas: [plannerPick.destIata],
                    targetFlights: 2,
                    airportCount: 1,
                    scheduleType: "hubShuttle",
                    baseDeparture: plannerPick.liveDeparture || "09:00",
                    startDayIdx: 0,
                    turnaroundMin: 60
                }
            }) : null
        const headers = Array.from(document.querySelectorAll("th"))
            .map(th => (th.textContent || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
        const rowText = Array.from(document.querySelectorAll("[data-aes-afp-cand-iata]"))
            .slice(0, 4)
            .map(row => (row.textContent || "").replace(/\s+/g, " ").trim())
        return {
            ok: liveCandidates.length > 0 && headers.some(h => /AS\/w/.test(h)) && headers.some(h => /AS dep/.test(h)),
            ctx: {
                server,
                aircraftId: ctx.aircraftId,
                currentLocationIata: ctx.currentLocationIata,
                activeHub: hub
            },
            scheduleLegCount: legs.length,
            scraped,
            liveCandidates,
            headers,
            rowText,
            plannerProbe: plannerProbe ? {
                validation: plannerProbe.build && plannerProbe.build.validation || [],
                generatedFlights: plannerProbe.build && plannerProbe.build.flights && plannerProbe.build.flights.length,
                selectedCandidates: (plannerProbe.selectedCandidates || []).map(c => ({
                    destIata: c.destIata,
                    liveWeeklyFlights: c.liveWeeklyFlights,
                    liveDeparture: c.liveDeparture,
                    liveAircraftType: c.liveAircraftType
                }))
            } : null
        }
    }})()`)

    await page.evaluate(() => {
        const row = document.querySelector("[data-aes-afp-cand-iata]")
        if (row) row.scrollIntoView({block: "center", inline: "nearest"})
    }).catch(() => {})
    await page.screenshot({path: screenshotPath, fullPage: true}).catch(() => {})

    const report = {
        server: serverHost,
        enterpriseId,
        aircraftId,
        port,
        loggedIn,
        profileDir,
        result,
        screenshotPath,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = result && result.ok && pageErrors.length === 0 ? 0 : 1
} finally {
    await context.close().catch(() => {})
}
