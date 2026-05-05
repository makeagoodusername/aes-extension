import { chromium } from "playwright"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const extensionPath = repoRoot
const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = String(process.env.AES_REAL_ENTERPRISE_ID || "775")
const port = String(process.env.AES_LIVE_CHROME_PORT || "10070")
const profileDir = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), "aes-permanent-live-smoke-" + port)
const reportPath = process.env.AES_LIVE_SMOKE_REPORT
    || path.join(repoRoot, "audit", "live-permanent-mode-smoke-" + port + "-20260505.json")
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const loginEmail = process.env.AES_LOGIN_EMAIL || ""
const loginPassword = process.env.AES_LOGIN_PASSWORD || ""
delete process.env.AES_LOGIN_PASSWORD

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

async function evalAes(page, predicate, expression, timeoutMs = 90000) {
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

function pricingSmokeExpression(input) {
    return `(${async function run(input) {
        const out = {
            routeAssistantSettings: false,
            automator: false,
            strategySettings: false,
            configured: null,
            preview: null,
            tick: null
        }
        if (typeof RouteAssistantSettings !== "undefined") out.routeAssistantSettings = true
        if (typeof AesRoutePriceAutomator !== "undefined") out.automator = true
        if (typeof AesStrategySettings !== "undefined") out.strategySettings = true
        if (!out.routeAssistantSettings || !out.automator) return out

        await AesRoutePriceAutomator.configureAutomaticLiveMode({
            followMode: "all",
            cooldowns: false,
            maxPerDay: 0,
            maxPerHour: 0,
            tickSec: 5,
            minDeltaPct: 0
        })
        const settings = await RouteAssistantSettings.load()
        const desc = AesRoutePriceAutomator.describeSettings(settings)
        const apply = settings.pricing && settings.pricing.apply || {}
        out.configured = {
            permanentLiveMode: apply.permanentLiveMode !== false,
            applyEnabled: apply.enabled !== false,
            dryRunOnly: apply.dryRunOnly === true,
            liveScopes: Object.assign({}, apply.liveScopes || {}),
            silentAutoEnabled: !!settings.pricing.silentAutoEnabled,
            followMode: settings.pricing.silentAutoFollowMode || null,
            tickSec: settings.pricing.silentAutoTickSec || null,
            caps: {
                day: settings.pricing.silentAutoMaxPerDay || 0,
                hour: settings.pricing.silentAutoMaxPerHour || 0
            },
            desc: {
                dryRun: desc.dryRun,
                liveWrites: desc.liveWrites,
                tickSec: desc.tickSec,
                followMode: desc.followMode
            }
        }
        out.preview = await AesRoutePriceAutomator.preview(
            {server: input.serverSlug, airline: null},
            {followMode: "all", limit: 75}
        ).then(p => ({
            counts: p.counts || null,
            proposals: (p.proposals || []).slice(0, 5).map(x => ({
                pair: x.pair,
                prices: x.prices || null,
                reason: x.reason || null
            }))
        })).catch(e => ({error: String(e && e.message || e)}))
        out.tick = await AesRoutePriceAutomator.runTick(
            {server: input.serverSlug, airline: null},
            {force: true, source: "codex-permanent-live-smoke", maxRoutes: 3}
        ).then(t => ({
            dryRun: t.dryRun,
            eligible: t.eligible,
            proposed: t.proposed,
            applied: t.applied,
            simulated: t.simulated,
            blocked: t.blocked,
            skipped: t.skipped,
            error: t.error || null,
            perRoute: (t.perRoute || []).slice(0, 5).map(r => ({
                pair: r.pair,
                status: r.status,
                dryRun: r.dryRun,
                error: r.error || null
            }))
        })).catch(e => ({error: String(e && e.message || e)}))
        if (out.strategySettings) {
            const s = await AesStrategySettings.load()
            out.strategy = {
                tier: s.tier,
                schedule: AesStrategySettings.canApply(s, "schedule"),
                price: AesStrategySettings.canApply(s, "price"),
                service: AesStrategySettings.canApply(s, "service"),
                crew: AesStrategySettings.canApply(s, "crew"),
                alliance: AesStrategySettings.canApply(s, "alliance")
            }
        }
        return out
    }})(${JSON.stringify(input)})`
}

function afpSmokeExpression() {
    return `(${async function run() {
        const out = {
            afpSettings: typeof AesAfpSettings !== "undefined",
            dashboardSettings: typeof AesAfpDashboardSettings !== "undefined",
            fleetBulkApply: typeof AesFleetCommandBulkApply !== "undefined",
            dndDropPopover: typeof FleetScheduleGridDropPopover !== "undefined"
        }
        if (out.afpSettings) {
            const s = await AesAfpSettings.load()
            out.afp = {
                autoSchedulerEnabled: !!(s.autoScheduler && s.autoScheduler.enabled),
                tier: s.autoScheduler && s.autoScheduler.tier,
                dragSubmitDryRunOnly: !!(s.dragSubmit && s.dragSubmit.dryRunOnly),
                applyDryRunOnly: !!(s.apply && s.apply.dryRunOnly)
            }
        }
        if (out.dashboardSettings) {
            const d = await AesAfpDashboardSettings.load()
            out.dashboard = {
                applyEnabled: d.applyEnabled !== false,
                dryRunOnly: d.dryRunOnly === true,
                permanentLiveMode: d.permanentLiveMode !== false
            }
        }
        return out
    }})()`
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
            consoleRows.push({type: msg.type(), text: msg.text(), url: page.url()})
        }
    })
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    const loggedIn = await loginIfNeeded(page)
    await gotoDom(page, "https://" + serverHost + "/app/enterprise/dashboard?select=" + encodeURIComponent(enterpriseId))
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 45000})
    const pricing = await evalAes(page,
        "window.RouteAssistantSettings && window.AesRoutePriceAutomator",
        pricingSmokeExpression({serverSlug}))

    await gotoDom(page, "https://" + serverHost + "/app/fleets")
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, table, body", {timeout: 45000})
    const afp = await evalAes(page,
        "window.AesAfpSettings || window.AesAfpDashboardSettings || window.AesFleetCommandBulkApply",
        afpSmokeExpression())

    const output = {
        ok: !!(pricing && pricing.configured && pricing.configured.desc
            && pricing.configured.desc.liveWrites === true
            && pricing.configured.desc.dryRun === false
            && pricing.tick && pricing.tick.dryRun === false
            && afp && (!afp.dashboard || afp.dashboard.dryRunOnly === false)
            && pageErrors.length === 0),
        server: serverHost,
        enterpriseId,
        loggedIn,
        finalUrl: page.url(),
        title: await page.title().catch(() => ""),
        profileDir,
        remoteDebuggingPort: port,
        pricing,
        afp,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2))
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = output.ok ? 0 : 1
    if (process.env.AES_KEEP_BROWSER === "1") {
        console.log(JSON.stringify({
            keepAlive: true,
            remoteDebuggingPort: port,
            profileDir,
            url: page.url()
        }, null, 2))
        await new Promise(() => {})
    }
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") await context.close()
}
