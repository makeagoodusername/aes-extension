import { chromium } from "playwright"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const profileDir = process.env.AES_REAL_PRICING_PROFILE
    || path.join(os.tmpdir(), "aes-chrome-pricing-real")
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || creds.server || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = process.env.AES_REAL_ENTERPRISE_ID || ""
const explicitHub = (process.env.AES_REAL_PRICE_HUB || "").toUpperCase()
const explicitDest = (process.env.AES_REAL_PRICE_DEST || "").toUpperCase()
const priceClass = process.env.AES_REAL_PRICE_CLASS || ""
const priceDelta = Number(process.env.AES_REAL_PRICE_DELTA || "0")

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function loginIfNeeded(page) {
    await page.goto(`https://${serverHost}/app/enterprise/dashboard`, {waitUntil: "domcontentloaded"})
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false

    await page.goto("https://www.airlinesim.aero/auth/login", {waitUntil: "domcontentloaded"})
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

async function findAesContext(page) {
    const client = await page.context().newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => {
        if (ev && ev.context) contexts.set(ev.context.id, ev.context)
    })
    await client.send("Runtime.enable")
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
        for (const ctx of contexts.values()) {
            const ok = await evalInContext(client, ctx.id, `(() => {
                return !!(window.RouteAssistantPricingApplier
                    && window.RouteAssistantPricingApplyLog
                    && window.RouteAssistantPricingApplier.parseFormContext)
            })()`).catch(() => false)
            if (ok) return {client, contextId: ctx.id}
        }
        await sleep(500)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated pricing context not found")
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

async function evalInFreshAesContext(page, expression, attempts = 4) {
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt++) {
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
            await page.waitForLoadState("domcontentloaded", {timeout: 10000}).catch(() => {})
            await sleep(1000 + attempt * 500)
        }
    }
    throw lastError || new Error("AES context evaluation failed")
}

function realApplyExpression() {
    return `(${async function runLiveApply(input) {
        const server = input.serverSlug
        const explicitHub = input.explicitHub
        const explicitDest = input.explicitDest
        const priceClass = input.priceClass
        const priceDelta = input.priceDelta
        const candidates = []
        const seen = new Set()
        const addCandidate = (hub, dest, source) => {
            hub = String(hub || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
            dest = String(dest || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
            if (!hub || !dest) return
            const key = hub + "-" + dest
            if (seen.has(key)) return
            seen.add(key)
            candidates.push({hub, dest, source})
        }

        if (explicitHub && explicitDest) addCandidate(explicitHub, explicitDest, "env")

        try {
            const all = await chrome.storage.local.get(null)
            for (const key of Object.keys(all || {})) {
                let m = /routeAssistant:markets:ownPricing:([A-Z0-9]{3,4})-([A-Z0-9]{3,4})$/i.exec(key)
                if (m) addCandidate(m[1], m[2], "ownPricing")
                m = /routeAssistant:topRoutes:([A-Z0-9]{3,4})$/i.exec(key)
                if (m && all[key] && Array.isArray(all[key].rows)) {
                    for (const row of all[key].rows.slice(0, 12)) {
                        addCandidate(m[1], row.destIata || row.dest || row.iata, "topRoutes")
                    }
                }
            }
        } catch (_) {}

        for (const a of Array.from(document.querySelectorAll("a[href*='/app/com/markets/']"))) {
            const href = a.getAttribute("href") || ""
            const m = /\/app\/com\/markets\/([A-Z0-9]{6,8})/i.exec(href)
            if (!m) continue
            const token = m[1].toUpperCase()
            if (token.length === 6) addCandidate(token.slice(0, 3), token.slice(3), "dom")
        }

        addCandidate("LHR", "CDG", "default")
        addCandidate("ICN", "NRT", "default")
        addCandidate("ICN", "HND", "default")
        addCandidate("JFK", "ATL", "default")

        const probeFailures = []
        async function probe(candidate) {
            const url = window.RouteAssistantPricingApplier._markUrl(server, candidate.hub, candidate.dest)
            const resp = await fetch(url, {credentials: "include"})
            const html = await resp.text().catch(() => "")
            if (!resp.ok) return {ok: false, reason: "HTTP " + resp.status, url}
            if (window.RouteAssistantPricingApplier.AUTHENTICATION_RE.test(html)) {
                return {ok: false, reason: "notLoggedIn", url}
            }
            const formContext = window.RouteAssistantPricingApplier.parseFormContext(html)
            if (!formContext || !formContext.currentPrices || !Object.keys(formContext.currentPrices).length) {
                return {ok: false, reason: "noFormContext", url}
            }
            return {ok: true, url, formContext}
        }

        let selected = null
        for (const candidate of candidates) {
            try {
                const p = await probe(candidate)
                if (p.ok) {
                    selected = {candidate, probe: p}
                    break
                }
                probeFailures.push({candidate, reason: p.reason})
            } catch (e) {
                probeFailures.push({candidate, reason: e && e.message || String(e)})
            }
        }
        if (!selected) return {ok: false, stage: "probe", candidates, probeFailures}

        const currentPrices = selected.probe.formContext.currentPrices || {}
        const requestedPrices = Object.assign({}, currentPrices)
        if (priceClass && isFinite(priceDelta) && priceDelta !== 0 && requestedPrices[priceClass] != null) {
            requestedPrices[priceClass] = Number(requestedPrices[priceClass]) + priceDelta
        }

        const applyLog = new window.RouteAssistantPricingApplyLog({
            limit: 100,
            perRouteLimit: 20,
            dedupWindowMin: 0
        })
        const applier = new window.RouteAssistantPricingApplier(server, {
            dryRunOnly: false,
            applyEnabled: true,
            liveScopes: {manual: true, bulk: true, silentAuto: true},
            cooldownMinPerRoute: 0,
            cooldownMinGlobal: 0,
            warnAboveDeltaPct: 1000,
            applyLog
        })
        const result = await applier.apply(selected.candidate.hub, selected.candidate.dest, requestedPrices, {
            source: "manual",
            dryRun: false,
            scope: {
                airportPair: true,
                flightNumbers: true,
                returnAirportPair: false,
                returnFlightNumbers: false
            },
            reason: priceDelta
                ? "Codex Chrome real pricing apply"
                : "Codex Chrome real pricing apply, same-value POST",
            onPreflight: () => true
        })
        const verify = await applier._verify(selected.candidate.hub, selected.candidate.dest)
        return {
            ok: !!(result && result.dryRun === false && (result.status === "verified" || result.status === "posted")),
            route: selected.candidate,
            url: selected.probe.url,
            currentPrices,
            requestedPrices,
            result: result ? {
                status: result.status,
                dryRun: result.dryRun,
                applyGate: result.applyGate,
                prevPrices: result.prevPrices,
                newPrices: result.newPrices,
                verifiedPrices: result.verifiedPrices,
                httpStatus: result.httpStatus,
                logId: result.logId || null,
                error: result.error || null,
                warning: result.warning || null
            } : null,
            verify,
            candidatesTried: probeFailures.length + 1,
            probeFailures
        }
    }})(${JSON.stringify({
        serverSlug,
        explicitHub,
        explicitDest,
        priceClass,
        priceDelta: isFinite(priceDelta) ? priceDelta : 0
    })})`
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
            consoleRows.push({type: msg.type(), text: msg.text(), url: page.url()})
        }
    })
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    const loggedIn = await loginIfNeeded(page)
    const dashboardUrl = enterpriseId
        ? `https://${serverHost}/app/enterprise/dashboard?select=${encodeURIComponent(enterpriseId)}`
        : `https://${serverHost}/app/enterprise/dashboard`
    await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"})
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 45000})

    const apply = await evalInFreshAesContext(page, realApplyExpression())

    const output = {
        server: serverHost,
        loggedIn,
        apply,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    console.log(JSON.stringify(output, null, 2))
    const ok = apply && apply.ok === true
        && apply.result
        && apply.result.dryRun === false
        && pageErrors.length === 0
    process.exitCode = ok ? 0 : 1
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}
