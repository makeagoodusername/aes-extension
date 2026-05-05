import { chromium } from "playwright"
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const extensionPath = repoRoot
const flightDetails = require(path.join(repoRoot, "modules/route-assistant/competitor-flight-details.js"))

const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = String(process.env.AES_REAL_ENTERPRISE_ID || "775")
const hub = String(process.env.AES_RA_LIVE_HUB || "JFK").toUpperCase()
const dest = String(process.env.AES_RA_LIVE_DEST || "LAX").toUpperCase()
const port = String(process.env.AES_LIVE_CHROME_PORT || "10072")
const profileDir = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), "aes-ra-enterprise-flight-drilldown-" + port)
const reportPath = path.resolve(process.env.AES_RA_LIVE_REPORT
    || path.join(repoRoot, "audit", "live-ra-enterprise-flight-drilldown-" + port + "-20260505.json"))
const shotPath = path.resolve(process.env.AES_RA_LIVE_SHOT
    || path.join(repoRoot, "audit", "live-ra-enterprise-flight-drilldown-" + port + "-20260505.png"))
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
let fileCreds = {}
try {
    fileCreds = JSON.parse(fs.readFileSync(credentialsPath, "utf8"))
} catch (_) {
    fileCreds = {}
}
const loginEmail = process.env.AES_LOGIN_EMAIL || fileCreds.email || ""
const loginPassword = process.env.AES_LOGIN_PASSWORD || fileCreds.password || ""

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function gotoDom(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function loginIfNeeded(page) {
    await gotoDom(page, "https://" + serverHost + "/app/enterprise/dashboard")
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false
    if (!loginEmail || !loginPassword) {
        throw new Error("AES_LOGIN_EMAIL and AES_LOGIN_PASSWORD are required for fresh login")
    }

    await gotoDom(page, "https://www.airlinesim.aero/auth/login")
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first()
    await loginInput.fill(loginEmail)
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
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
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
    throw new Error("AES isolated context not found for predicate: " + predicate)
}

async function evalAes(page, predicate, expression, timeoutMs = 180000) {
    const found = await findAesContext(page, predicate, timeoutMs)
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

function liveReadExpression(input) {
    return `(${async function run(input) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

        function parseNumber(text) {
            if (!text) return null
            const stripped = String(text).replace(/[^\d.,\s-]/g, " ").trim()
            if (!stripped) return null
            const m = /(-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)/.exec(stripped)
            if (!m) return null
            const cleaned = m[1].replace(/[\s,](?=\d{3}\b)/g, "").replace(/,/g, ".")
            const n = parseFloat(cleaned)
            return isFinite(n) ? Math.round(n) : null
        }

        function parseTypeSpec(html) {
            if (!html) return null
            const doc = new DOMParser().parseFromString(html, "text/html")
            let seats = null
            let cargoCapacity = null
            let classSeatSum = 0
            let classSeatHits = 0
            let typeName = null
            const h1 = doc.querySelector("h1, h2, h3, .page-header")
            if (h1) typeName = (h1.textContent || "").replace(/\s+/g, " ").trim() || null
            for (const tr of doc.querySelectorAll("table tr")) {
                const cells = tr.querySelectorAll("th, td")
                if (cells.length < 2) continue
                const label = ((cells[0].textContent || "") + "").trim()
                const labelLow = label.toLowerCase()
                const valueText = (cells[cells.length - 1].textContent || "").trim()
                const num = parseNumber(valueText)
                if (num === null) continue
                const isCargoish = /(cargo|payload|freight)/i.test(labelLow)
                const isSpeedish = /\bspeed\b/i.test(labelLow) && !/stall/i.test(labelLow)
                const isRangeish = /\brange\b/i.test(labelLow)
                const isComfortish = /\b(popularity|comfort|satisfaction|rating)\b/i.test(labelLow)
                    && !/(cargo|payload|crew|noise)/i.test(labelLow)
                if (!isCargoish && !isSpeedish && !isRangeish && !isComfortish) {
                    if (/^(?:total\s*)?(?:seats?|capacity|pax|passengers?)\b/i.test(labelLow)
                            || /\bseats?\s*(?:\\(.*\\))?\s*$/i.test(labelLow)) {
                        if (seats === null || num > seats) seats = num
                    } else if (/^(?:y|economy|c|business|f|first)\b/i.test(labelLow)
                            && /seat|class/i.test(labelLow + " " + (cells[1].textContent || ""))) {
                        classSeatSum += num
                        classSeatHits++
                    }
                }
                if (isCargoish && (cargoCapacity === null || num > cargoCapacity)) cargoCapacity = num
            }
            if (seats === null && classSeatHits >= 1) seats = classSeatSum
            return {typeName, seats, cargoCapacity}
        }

        const parsed = RouteAssistantMarketsPageScraper.parseFromDoc(document)
        const competitors = parsed && parsed.competitors && parsed.competitors.competitors || []
        const typeIds = Array.from(new Set(competitors
            .map(f => Number(f && f.typeId))
            .filter(n => isFinite(n) && n > 0)))
        const typeSpecs = {}
        const typeErrors = []
        for (const typeId of typeIds) {
            try {
                const resp = await fetch("/action/enterprise/aircraftsType?id=" + encodeURIComponent(String(typeId)), {
                    credentials: "include"
                })
                if (!resp.ok) {
                    typeErrors.push({typeId, status: resp.status})
                    continue
                }
                const html = await resp.text()
                const spec = parseTypeSpec(html)
                const sample = competitors.find(f => Number(f && f.typeId) === Number(typeId))
                if (spec && ((spec.seats != null && spec.seats > 0)
                        || (spec.cargoCapacity != null && spec.cargoCapacity > 0))) {
                    typeSpecs[typeId] = Object.assign({
                        typeId,
                        typeName: spec.typeName || (sample && sample.typeCode) || null
                    }, spec)
                }
            } catch (error) {
                typeErrors.push({typeId, error: String(error && error.message || error)})
            }
            await sleep(100)
        }

        const allStorage = await new Promise(resolve => {
            try { chrome.storage.local.get(null, data => resolve(data || {})) }
            catch (_) { resolve({}) }
        })
        const iataByEnterpriseId = {}
        const backfillKey = "competitorIntel:iataToEnterpriseId:" + input.serverSlug
        const backfill = allStorage[backfillKey]
        if (backfill && backfill.byIata) {
            for (const iata in backfill.byIata) {
                const rec = backfill.byIata[iata]
                if (rec && rec.enterpriseId != null) iataByEnterpriseId[String(rec.enterpriseId)] = String(iata).toUpperCase()
            }
        }
        const enterprisePrefix = "competitorIntel:enterprise:" + input.serverSlug + ":"
        for (const key in allStorage) {
            if (key.indexOf(enterprisePrefix) !== 0) continue
            const rec = allStorage[key]
            if (!rec || rec.enterpriseId == null || !rec.iata) continue
            iataByEnterpriseId[String(rec.enterpriseId)] = String(rec.iata).toUpperCase()
        }

        return {
            url: location.href,
            title: document.title,
            hub: input.hub,
            dest: input.dest,
            parsedFamilies: Object.keys(parsed || {}).filter(k => !!parsed[k]),
            competitorRows: competitors.length,
            marketSharePaxRows: parsed && parsed.marketShare && parsed.marketShare.pax
                ? parsed.marketShare.pax.length : 0,
            marketShareCargoRows: parsed && parsed.marketShare && parsed.marketShare.cargo
                ? parsed.marketShare.cargo.length : 0,
            parsed,
            typeIds,
            typeSpecs,
            typeErrors,
            iataByEnterpriseId,
            storageIataBackfills: Object.keys(iataByEnterpriseId).length,
            sampleFlights: competitors.slice(0, 8)
        }
    }})(${JSON.stringify(input)})`
}

function mergeCompetitorEntries(parsed, iataByEnterpriseId) {
    const merged = new Map()
    const add = (entry, kind) => {
        if (!entry || String(entry.enterpriseId || "") === enterpriseId) return
        const key = entry.enterpriseId != null
            ? "id:" + entry.enterpriseId
            : "name:" + String(entry.name || "").toLowerCase().trim()
        if (!key || key === "name:") return
        const slot = merged.get(key) || {
            enterpriseId: entry.enterpriseId != null ? entry.enterpriseId : null,
            name: entry.name || null,
            iata: entry.enterpriseId != null ? iataByEnterpriseId[String(entry.enterpriseId)] || null : null,
            paxShare: null,
            cargoShare: null,
            paxRank: null,
            cargoRank: null,
            paxChange: null,
            cargoChange: null
        }
        if (entry.name && !slot.name) slot.name = entry.name
        if (kind === "pax") {
            slot.paxShare = entry.sharePct
            slot.paxRank = entry.rank
            slot.paxChange = entry.change
        } else {
            slot.cargoShare = entry.sharePct
            slot.cargoRank = entry.rank
            slot.cargoChange = entry.change
        }
        merged.set(key, slot)
    }
    const share = parsed && parsed.marketShare || {}
    for (const e of (share.pax || [])) add(e, "pax")
    for (const e of (share.cargo || [])) add(e, "cargo")
    return Array.from(merged.values())
}

function uniqueFlightCount(flights) {
    const seen = new Set()
    for (const f of flights || []) {
        const key = f.flightId != null ? "id:" + f.flightId
            : [f.flightCode || "", f.depDateLocal || "", f.depTimeLocal || "", f.typeId || f.typeCode || ""].join("|")
        seen.add(key)
    }
    return seen.size
}

function buildReport(live, loggedIn, pageErrors, consoleRows) {
    const parsed = live.parsed || {}
    const competitors = parsed.competitors && parsed.competitors.competitors || []
    const competitorFlights = competitors.filter(f => !f || !f.isOurs)
    const typeSpecs = new Map()
    for (const [id, spec] of Object.entries(live.typeSpecs || {})) {
        const n = Number(id)
        const rec = Object.assign({typeId: n}, spec)
        typeSpecs.set(n, rec)
        typeSpecs.set(String(n), rec)
    }

    const row = {
        marketCompetitorFlights: competitorFlights,
        competitorMarketFlights: competitorFlights,
        competitorFlights,
        competitorEntries: mergeCompetitorEntries(parsed, live.iataByEnterpriseId || {}),
        marketSharePax: parsed.marketShare && parsed.marketShare.pax || [],
        marketShareCargo: parsed.marketShare && parsed.marketShare.cargo || []
    }
    flightDetails.decorateRow(row, {typeSpecs})

    const attachedPrefixes = new Set()
    for (const entry of row.competitorEntries || []) {
        const detail = entry.routeFlightDetail
        if (!detail || !detail.prefixes) continue
        for (const prefix of detail.prefixes) attachedPrefixes.add(prefix)
    }
    const byPrefix = new Map()
    for (const flight of competitorFlights) {
        const prefix = flightDetails.flightPrefix(flight && flight.flightCode)
        if (!prefix) continue
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, [])
        byPrefix.get(prefix).push(flight)
    }
    for (const [prefix, flights] of byPrefix) {
        if (attachedPrefixes.has(prefix)) continue
        row.competitorEntries.push({
            enterpriseId: null,
            name: prefix + " - " + uniqueFlightCount(flights) + " flight"
                + (uniqueFlightCount(flights) === 1 ? "" : "s"),
            routeFlightPrefix: prefix,
            fromFlightList: true
        })
    }
    flightDetails.decorateRow(row, {typeSpecs})

    const groups = (row.competitorEntries || [])
        .filter(entry => entry.routeFlightDetail && entry.routeFlightDetail.flightCount)
        .map(entry => {
            const detail = entry.routeFlightDetail
            return {
                enterpriseId: entry.enterpriseId != null ? entry.enterpriseId : null,
                name: entry.name || null,
                iata: entry.iata || entry.routeFlightPrefix || entry.flightPrefix || null,
                fromFlightList: !!entry.fromFlightList,
                flightCount: detail.flightCount,
                rowCount: detail.rowCount,
                totalSeatCapacity: detail.totalSeatCapacity,
                totalCargoCapacity: detail.totalCargoCapacity,
                pricesByClass: detail.pricesByClass,
                departures: detail.departures,
                aircraft: detail.aircraft.slice(0, 5),
                sampleFlights: detail.sampleFlights.slice(0, 4).map(f => ({
                    flightCode: f.flightCode,
                    flightId: f.flightId,
                    depDateLocal: f.depDateLocal,
                    depTimeLocal: f.depTimeLocal,
                    arrTimeLocal: f.arrTimeLocal,
                    typeCode: f.typeCode,
                    typeId: f.typeId,
                    seatCapacity: f.seatCapacity,
                    cargoCapacity: f.cargoCapacity,
                    classes: f.classes,
                    status: f.status
                }))
            }
        })
        .sort((a, b) => b.flightCount - a.flightCount || String(a.iata || "").localeCompare(String(b.iata || "")))

    const rowsWithAnyCapacity = competitorFlights.filter(f => {
        const spec = typeSpecs.get(f && f.typeId) || typeSpecs.get(String(f && f.typeId))
        return !!(spec && (spec.seats != null || spec.cargoCapacity != null))
    }).length

    return {
        ok: loggedIn !== false
            && live.competitorRows > 0
            && groups.length > 0
            && rowsWithAnyCapacity === competitorFlights.length
            && pageErrors.length === 0,
        mode: "read-only-real-airlinesim-market-flight-drilldown",
        noAirlineSimPosts: true,
        startedAt: new Date().toISOString(),
        server: serverHost,
        enterpriseId,
        hub,
        dest,
        loggedIn,
        marketUrl: live.url,
        title: live.title,
        parsedFamilies: live.parsedFamilies,
        competitorRows: live.competitorRows,
        competitorFlightRowsExcludingOwn: competitorFlights.length,
        marketSharePaxRows: live.marketSharePaxRows,
        marketShareCargoRows: live.marketShareCargoRows,
        airlineGroupsWithFlightDetail: groups.length,
        rowsWithAnyCapacity,
        typeIds: live.typeIds,
        typeErrors: live.typeErrors,
        storageIataBackfills: live.storageIataBackfills,
        groups: groups.slice(0, 20),
        sampleFlights: live.sampleFlights,
        consoleRows,
        pageErrors,
        reportPath,
        shotPath,
        profileDir,
        remoteDebuggingPort: port
    }
}

fs.mkdirSync(profileDir, {recursive: true})
fs.mkdirSync(path.dirname(reportPath), {recursive: true})

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
    page.setDefaultTimeout(60000)
    page.on("console", msg => {
        if (msg.type() === "error" || msg.type() === "warning") {
            const text = msg.text()
            if (!/favicon|ResizeObserver loop/i.test(text)) {
                consoleRows.push({type: msg.type(), text, url: page.url()})
            }
        }
    })
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    const loggedIn = await loginIfNeeded(page)
    await gotoDom(page, "https://" + serverHost + "/app/enterprise/dashboard?select=" + encodeURIComponent(enterpriseId))
    await page.waitForLoadState("networkidle").catch(() => {})
    await gotoDom(page, "https://" + serverHost + "/app/com/markets/" + hub + dest)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector("#inventory-table, body", {timeout: 45000})
    await page.screenshot({path: shotPath, fullPage: true, timeout: 15000}).catch(() => {})

    const live = await evalAes(page,
        "typeof RouteAssistantMarketsPageScraper !== 'undefined'",
        liveReadExpression({serverSlug, hub, dest}),
        240000)
    const report = buildReport(live, loggedIn, pageErrors, consoleRows)
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.ok ? 0 : 1
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") await context.close().catch(() => {})
}
