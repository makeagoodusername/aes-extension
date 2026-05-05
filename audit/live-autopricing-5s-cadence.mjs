import { chromium } from "playwright"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const reportPath = process.env.AES_5S_REPORT
    || path.join(repoRoot, "audit", `live-autopricing-5s-cadence-${Date.now()}.json`)
const profileDir = process.env.AES_5S_PROFILE
    || path.join(os.tmpdir(), "aes-chrome-autopricing-5s")
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const requestedPort = Number(process.env.AES_5S_PORT || process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const port = String(await findAvailableDebugPort(requestedPort))

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
if (process.env.AES_LOGIN_EMAIL) creds.email = process.env.AES_LOGIN_EMAIL
if (process.env.AES_LOGIN_PASSWORD) creds.password = process.env.AES_LOGIN_PASSWORD
delete process.env.AES_LOGIN_EMAIL
delete process.env.AES_LOGIN_PASSWORD
const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || creds.server || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = String(process.env.AES_REAL_ENTERPRISE_ID || process.env.AES_TEST_ENTERPRISE_ID || "775")
const observeTicks = Math.max(2, Math.min(5, Number(process.env.AES_5S_OBSERVED_TICKS) || 3))
const observeTimeoutMs = Math.max(15000, Math.min(90000, Number(process.env.AES_5S_TIMEOUT_MS) || 35000))

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function isPortAvailable(port) {
    return await new Promise(resolve => {
        const server = net.createServer()
        server.unref()
        server.on("error", () => resolve(false))
        server.listen({host: "127.0.0.1", port}, () => {
            server.close(() => resolve(true))
        })
    })
}

async function findAvailableDebugPort(startPort) {
    const start = Number.isFinite(startPort) && startPort > 0 ? Math.floor(startPort) : 9222
    for (let port = start; port < start + 100; port++) {
        if (await isPortAvailable(port)) return port
    }
    throw new Error(`No available remote debugging port found from ${start} to ${start + 99}`)
}

async function gotoDomContentLoaded(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function loginIfNeeded(page) {
    await gotoDomContentLoaded(page, `https://${serverHost}/app/enterprise/dashboard`)
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
                    "AesRoutePriceAutomator",
                    "AesRoutePriceAutomatorDashboardLoop",
                    "RouteAssistantPricingApplier",
                    "RouteAssistantSettings"
                ]
                return names.filter(name => !!window[name]).length
            })()`).catch(() => 0)
            if (score >= 4) return {client, contextId: ctx.id}
        }
        await sleep(500)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated dashboard auto-pricing context not found")
}

async function evalInFreshAesContext(page, expression) {
    const found = await findAesContext(page)
    try {
        return await evalInContext(found.client, found.contextId, expression)
    } finally {
        await found.client.detach().catch(() => {})
    }
}

function cadenceExpression(input) {
    return `(${async function run(input) {
        const required = [
            "AesRoutePriceAutomator",
            "AesRoutePriceAutomatorDashboardLoop",
            "RouteAssistantSettings",
            "RouteAssistantPricingApplier"
        ]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return {ok: false, stage: "modules", missing}

        const startedAt = Date.now()
        const original = await RouteAssistantSettings.load()
        let outcome = null
        let restoreError = null

        function clone(obj) {
            return obj && typeof obj === "object" ? JSON.parse(JSON.stringify(obj)) : obj
        }

        try {
            const prepared = await RouteAssistantSettings.load()
            prepared.pricing = prepared.pricing || {}
            const pricing = prepared.pricing
            const apply = Object.assign({}, pricing.apply || {})
            apply.enabled = true
            apply.dryRunOnly = false
            apply.liveScopes = Object.assign({}, apply.liveScopes || {}, {silentAuto: true})
            apply.defaultScope = Object.assign(
                {},
                (RouteAssistantPricingApplier && RouteAssistantPricingApplier.DEFAULT_SCOPE) || {},
                apply.defaultScope || {},
                {
                    airportPair: true,
                    flightNumbers: true,
                    returnAirportPair: false,
                    returnFlightNumbers: false
                }
            )
            pricing.apply = apply
            pricing.silentAutoEnabled = true
            pricing.silentAutoConfirmedAt = Date.now()
            pricing.silentAutoFollowMode = "all"
            pricing.silentAutoTickSec = 5
            pricing.silentAutoTickMin = 5 / 60
            pricing.silentAutoMaxPerDay = 1
            pricing.silentAutoMaxPerHour = 1
            pricing.silentAutoMutedUntil = null
            pricing.silentAutoLastTickAt = null
            pricing.silentAutoLastTickResult = null
            await RouteAssistantSettings.save({pricing})

            const configured = await RouteAssistantSettings.load()
            const desc = AesRoutePriceAutomator.describeSettings(configured)
            const previewBefore = await AesRoutePriceAutomator.preview(
                {server: input.serverSlug, airline: null},
                {followMode: "all", limit: 75}
            ).catch(e => ({error: String(e && e.message || e)}))

            if (typeof AesRoutePriceAutomatorDashboardLoop.start === "function") {
                AesRoutePriceAutomatorDashboardLoop.start()
            }

            const observed = []
            const seen = new Set()
            const deadline = Date.now() + input.observeTimeoutMs
            while (Date.now() < deadline && observed.length < input.observeTicks) {
                const latest = await RouteAssistantSettings.load()
                const p = latest && latest.pricing || {}
                const at = Number(p.silentAutoLastTickAt)
                if (isFinite(at) && at > 0 && !seen.has(at)) {
                    seen.add(at)
                    observed.push({
                        at,
                        iso: new Date(at).toISOString(),
                        result: clone(p.silentAutoLastTickResult || null)
                    })
                }
                await new Promise(resolve => setTimeout(resolve, 250))
            }

            const deltasMs = []
            for (let i = 1; i < observed.length; i++) deltasMs.push(observed[i].at - observed[i - 1].at)
            const cadenceOk = deltasMs.every(ms => ms >= 4000 && ms <= 9000)

            outcome = {
                ok: observed.length >= input.observeTicks && cadenceOk,
                stage: "done",
                startedAt,
                tickLabel: desc.tickLabel,
                tickMs: desc.tickMs,
                liveWrites: desc.liveWrites,
                dryRun: desc.dryRun,
                previewBefore: {
                    counts: previewBefore.counts || null,
                    proposals: (previewBefore.proposals || []).slice(0, 10).map(p => ({
                        pair: p.pair,
                        prices: clone(p.prices),
                        reason: p.reason || null
                    })),
                    error: previewBefore.error || null
                },
                observed,
                deltasMs,
                restoredSettings: false
            }
        } catch (e) {
            outcome = {
                ok: false,
                stage: "exception",
                error: String(e && e.message || e),
                stack: e && e.stack || null,
                restoredSettings: false
            }
        } finally {
            try {
                await RouteAssistantSettings.save({pricing: original.pricing, ors: original.ors})
            } catch (e) {
                restoreError = String(e && e.message || e)
            }
        }
        if (outcome) outcome.restoredSettings = !restoreError
        if (outcome && restoreError) outcome.restoreError = restoreError
        return outcome || {ok: false, stage: "unknown", restoredSettings: !restoreError}
    }})(` + JSON.stringify(input) + `)`
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
            consoleRows.push({type: msg.type(), text: msg.text(), url: page.url()})
        }
    })
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    const loggedIn = await loginIfNeeded(page)
    const dashboardUrl = `https://${serverHost}/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseId)}`
    await gotoDomContentLoaded(page, dashboardUrl)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 45000})

    const result = await evalInFreshAesContext(page, cadenceExpression({
        serverSlug,
        observeTicks,
        observeTimeoutMs
    }))

    const output = {
        ok: !!(result && result.ok) && result.restoredSettings === true && pageErrors.length === 0,
        server: serverHost,
        enterpriseId,
        loggedIn,
        url: page.url(),
        title: await page.title().catch(() => ""),
        profileDir,
        remoteDebuggingPort: port,
        result,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2))
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = output.ok ? 0 : 1
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}
