import { chromium } from "playwright"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const port = process.env.AES_LIVE_CHROME_PORT || "9985"
const connectPort = process.env.AES_LIVE_CONNECT_PORT || ""
const profileDir = process.env.AES_LIVE_5S_PROFILE
    || path.join(os.tmpdir(), `aes-live-5s-${port}`)
const reportPath = process.env.AES_LIVE_5S_REPORT
    || path.join(repoRoot, "audit", `live-5s-autopricing-cadence-${port}.json`)
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const loginEmail = process.env.AES_LOGIN_EMAIL || creds.email
const loginPassword = process.env.AES_LOGIN_PASSWORD || creds.password
const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || creds.server || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = process.env.AES_REAL_ENTERPRISE_ID || process.env.AES_TEST_ENTERPRISE_ID || "775"
const startPath = process.env.AES_LIVE_START_PATH || `/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseId)}`

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
    await page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first().fill(loginEmail)
    await page.locator("input[type='password']").first().fill(loginPassword)
    const submit = page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first()
    await submit.click()
    try {
        await page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000})
    } catch (err) {
        const details = await page.locator(".form-error, .alert, .error, [class*='error']")
            .allTextContents({timeout: 2000})
            .catch(() => [])
        throw new Error("Login did not leave the AirlineSim auth page"
            + (details.length ? ": " + details.join(" | ").slice(0, 500) : ""))
    }
    return true
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
                const names = ["AesRoutePriceAutomator", "RouteAssistantSettings", "RouteAssistantPricingApplier"]
                return names.filter(name => !!window[name]).length
            })()`).catch(() => 0)
            if (score >= 2) return {client, contextId: ctx.id}
        }
        await sleep(500)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated auto-pricing context not found")
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

function cadenceExpression(input) {
    return `(${async function run(input) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
        const required = ["AesRoutePriceAutomator", "RouteAssistantSettings"]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return {ok: false, stage: "modules", missing}

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
            apply.liveScopes = Object.assign({}, apply.liveScopes || {}, {silentAuto: false})
            pricing.apply = apply
            pricing.silentAutoEnabled = true
            pricing.silentAutoConfirmedAt = Date.now()
            pricing.silentAutoTickSec = input.tickSec
            pricing.silentAutoTickMin = input.tickSec / 60
            pricing.silentAutoFollowMode = "all"
            pricing.silentAutoMaxPerDay = 0
            pricing.silentAutoMaxPerHour = 0
            pricing.silentAutoMutedUntil = null
            pricing.silentAutoLastTickAt = null
            pricing.silentAutoLastTickResult = null
            await RouteAssistantSettings.save({pricing})

            const deadline = Date.now() + input.windowMs
            let lastAt = 0
            while (Date.now() < deadline && samples.length < 3) {
                await sleep(500)
                const fresh = await RouteAssistantSettings.load()
                const p = fresh.pricing || {}
                const at = Number(p.silentAutoLastTickAt)
                if (isFinite(at) && at > 0 && at !== lastAt) {
                    lastAt = at
                    samples.push({
                        at,
                        elapsedMs: at - startedAt,
                        result: p.silentAutoLastTickResult || null
                    })
                }
            }
            const intervals = []
            for (let i = 1; i < samples.length; i++) intervals.push(samples[i].at - samples[i - 1].at)
            return {
                ok: samples.length >= 2 && intervals.some(ms => ms >= 4000 && ms <= 8000),
                stage: "done",
                server: input.serverSlug,
                tickSec: input.tickSec,
                samples,
                intervals,
                dryRunOnly: true,
                liveWritesDisabled: true,
                durationMs: Date.now() - startedAt
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
            if (restoreError) {
                samples.push({restoreError})
            }
        }
    }})(` + JSON.stringify(input) + `)`
}

let browser = null
let context = null
if (connectPort) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${connectPort}`)
    context = browser.contexts()[0]
    if (!context) throw new Error(`No browser context on port ${connectPort}`)
} else {
    fs.mkdirSync(profileDir, {recursive: true})
    context = await chromium.launchPersistentContext(profileDir, {
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
}

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

    const loggedIn = connectPort
        ? !/\/auth\/login/i.test(page.url())
        : await loginIfNeeded(page)
    await page.goto(`https://${serverHost}${startPath}`, {
        waitUntil: "domcontentloaded"
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 45000})

    const result = await evalInFreshAesContext(page, cadenceExpression({
        serverSlug,
        tickSec: 5,
        windowMs: 22000
    }))

    const output = {
        server: serverHost,
        enterpriseId,
        port: connectPort || port,
        loggedIn,
        attached: !!connectPort,
        profileDir: connectPort ? null : profileDir,
        result,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2))
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = result && result.ok === true && pageErrors.length === 0 ? 0 : 1
} finally {
    if (!connectPort && context) await context.close().catch(() => {})
}
if (connectPort) process.exit(process.exitCode || 0)
