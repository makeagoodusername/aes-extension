import { chromium } from "playwright"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const reportPath = process.env.AES_MASS_PRICE_REPORT
    || path.join(repoRoot, "audit", "live-autopricing-mass-apply-report.json")
const profileDir = process.env.AES_MASS_PRICING_PROFILE
    || process.env.AES_ORS_PRICING_PROFILE
    || process.env.AES_REAL_PRICING_PROFILE
    || path.join(os.tmpdir(), "aes-chrome-pricing-real")
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || creds.server || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = process.env.AES_REAL_ENTERPRISE_ID || process.env.AES_TEST_ENTERPRISE_ID || "775"

const routeLimit = intEnv("AES_MASS_ROUTE_LIMIT", 500)
const maxPerDay = intEnv("AES_MASS_MAX_PER_DAY", 0)
const maxPerHour = intEnv("AES_MASS_MAX_PER_HOUR", 0)
const logLimit = intEnv("AES_MASS_LOG_LIMIT", 1000)
const perRouteLogLimit = intEnv("AES_MASS_PER_ROUTE_LOG_LIMIT", 50)
const minDeltaPct = optionalNumberEnv("AES_MASS_MIN_DELTA_PCT")
const maxStepPct = optionalNumberEnv("AES_MASS_MAX_STEP_PCT")

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function intEnv(name, fallback) {
    const n = Number(process.env[name])
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback
}

function optionalNumberEnv(name) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) return null
    const n = Number(process.env[name])
    return Number.isFinite(n) ? n : null
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
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
        for (const ctx of contexts.values()) {
            const score = await evalInContext(client, ctx.id, `(() => {
                const names = [
                    "AesRoutePriceAutomator",
                    "RouteAssistantPricingApplier",
                    "RouteAssistantPricingApplyLog",
                    "RouteAssistantSettings",
                    "RouteAssistantSilentAutoProposers"
                ]
                return names.filter(name => !!window[name]).length
            })()`).catch(() => 0)
            if (score >= 5) return {client, contextId: ctx.id}
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

function massApplyExpression(input) {
    return `(${async function run(input) {
        const required = [
            "AesRoutePriceAutomator",
            "RouteAssistantPricingApplier",
            "RouteAssistantPricingApplyLog",
            "RouteAssistantSettings",
            "RouteAssistantSilentAutoProposers"
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

        function priceSummary(prev, next) {
            const parts = []
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                if (!next || next[cls] == null) continue
                const before = prev && prev[cls] != null ? Number(prev[cls]) : null
                const after = Number(next[cls])
                if (!isFinite(after)) continue
                if (before == null || !isFinite(before)) {
                    parts.push(cls + " -> " + after)
                    continue
                }
                const same = cls === "Cargo" ? Math.abs(before - after) < 0.005 : Math.round(before) === Math.round(after)
                if (!same) parts.push(cls + " " + before + "->" + after)
            }
            return parts.join(", ") || "no-op"
        }

        try {
            const prepared = await RouteAssistantSettings.load()
            prepared.pricing = prepared.pricing || {}
            const pricing = prepared.pricing
            const apply = Object.assign({}, pricing.apply || {})
            apply.enabled = true
            apply.dryRunOnly = false
            apply.liveScopes = Object.assign({}, apply.liveScopes || {}, {
                manual: true,
                bulk: true,
                silentAuto: true
            })
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
            apply.cooldownMinPerRoute = 0
            apply.cooldownMinGlobal = 0
            apply.pricingApplyLogLimit = Math.max(Number(apply.pricingApplyLogLimit) || 200, input.logLimit)
            apply.perRouteApplyLogLimit = Math.max(Number(apply.perRouteApplyLogLimit) || 20, input.perRouteLogLimit)
            apply.pricingApplyLogDedupWindowMin = 0

            pricing.apply = apply
            pricing.silentAutoEnabled = true
            pricing.silentAutoConfirmedAt = Date.now()
            pricing.silentAutoFollowMode = "all"
            pricing.silentAutoMaxPerDay = input.maxPerDay
            pricing.silentAutoMaxPerHour = input.maxPerHour
            pricing.silentAutoMutedUntil = null
            if (input.minDeltaPct != null) pricing.silentAutoMinDeltaPct = Math.max(0, Number(input.minDeltaPct))
            if (input.maxStepPct != null) {
                pricing.silentAutoMaxStepPct = Math.max(0, Number(input.maxStepPct))
                pricing.silentAutoPerClassMaxStepPct = Object.assign(
                    {},
                    pricing.silentAutoPerClassMaxStepPct || {},
                    {Y: input.maxStepPct, C: input.maxStepPct, F: input.maxStepPct, Cargo: input.maxStepPct}
                )
                apply.classes = Object.assign({}, apply.classes || {}, {
                    Y: Object.assign({}, apply.classes && apply.classes.Y || {}, {enabled: true, maxMove: input.maxStepPct}),
                    C: Object.assign({}, apply.classes && apply.classes.C || {}, {enabled: true, maxMove: input.maxStepPct}),
                    F: Object.assign({}, apply.classes && apply.classes.F || {}, {enabled: true, maxMove: input.maxStepPct}),
                    Cargo: Object.assign({}, apply.classes && apply.classes.Cargo || {}, {enabled: true, maxMove: input.maxStepPct})
                })
            }
            await RouteAssistantSettings.save({pricing})

            const configured = await RouteAssistantSettings.load()
            const previewBefore = await AesRoutePriceAutomator.preview({server: input.serverSlug, airline: null}, {
                followMode: "all",
                limit: input.routeLimit
            })
            if (previewBefore.state && previewBefore.state.dryRun) {
                outcome = {
                    ok: false,
                    stage: "guard",
                    reason: "auto-pricing gate still resolved to dryRun",
                    state: previewBefore.state,
                    counts: previewBefore.counts
                }
                return outcome
            }

            const proposalsBefore = previewBefore.proposals.map(p => ({
                pair: p.pair,
                hub: p.hub,
                dest: p.dest,
                prevPrices: clone(p.prevPrices),
                prices: clone(p.prices),
                reason: p.reason || null,
                summary: priceSummary(p.prevPrices, p.prices)
            }))

            const tick = await AesRoutePriceAutomator.runTick({server: input.serverSlug, airline: null}, {
                source: "codex-live-autopricing-mass-apply",
                force: true,
                followMode: "all",
                limit: input.routeLimit
            })

            const log = new RouteAssistantPricingApplyLog({
                limit: input.logLimit,
                perRouteLimit: input.perRouteLogLimit,
                dedupWindowMin: 0
            })
            const recent = await log.getRecent(input.logLimit)
            const entries = (recent.entries || []).filter(e =>
                e && e.ts >= startedAt - 1000 && e.source === "silent-auto"
            )
            const successes = entries.filter(e =>
                !e.dryRun && (e.status === "verified" || e.status === "posted")
            )
            const failures = entries.filter(e =>
                e.status !== "verified" && e.status !== "posted"
            )
            const applied = successes.map(e => ({
                id: e.id || null,
                ts: e.ts || null,
                route: (e.hub || "") + "-" + (e.dest || ""),
                status: e.status,
                dryRun: !!e.dryRun,
                prevPrices: clone(e.prevPrices),
                newPrices: clone(e.newPrices),
                verifiedPrices: clone(e.verifiedPrices),
                summary: priceSummary(e.prevPrices, e.newPrices),
                reason: e.reason || null
            }))
            const failed = failures.map(e => ({
                id: e.id || null,
                route: (e.hub || "") + "-" + (e.dest || ""),
                status: e.status,
                dryRun: !!e.dryRun,
                error: e.error || null,
                reason: e.reason || null
            }))

            const proposedCount = proposalsBefore.length
            outcome = {
                ok: tick && tick.dryRun === false
                    && tick.simulated === 0
                    && tick.blocked === 0
                    && tick.applied === proposedCount
                    && successes.length === proposedCount,
                stage: "done",
                startedAt,
                server: input.serverSlug,
                routeLimit: input.routeLimit,
                configured: {
                    dryRun: previewBefore.state && previewBefore.state.dryRun,
                    liveWrites: previewBefore.state && previewBefore.state.liveWrites,
                    followMode: previewBefore.state && previewBefore.state.followMode,
                    maxPerDay: configured.pricing && configured.pricing.silentAutoMaxPerDay,
                    maxPerHour: configured.pricing && configured.pricing.silentAutoMaxPerHour,
                    minDeltaPct: configured.pricing && configured.pricing.silentAutoMinDeltaPct,
                    maxStepPct: configured.pricing && configured.pricing.silentAutoMaxStepPct,
                    defaultScope: apply.defaultScope
                },
                previewBefore: {
                    counts: previewBefore.counts,
                    notices: previewBefore.notices || [],
                    proposals: proposalsBefore
                },
                tick,
                applyLog: {
                    entriesInRun: entries.length,
                    successes: successes.length,
                    failures: failures.length,
                    applied,
                    failed
                },
                postRunPreview: await AesRoutePriceAutomator.preview({server: input.serverSlug, airline: null}, {
                    followMode: "all",
                    limit: input.routeLimit
                }).then(p => ({
                    counts: p.counts,
                    notices: p.notices || [],
                    proposals: p.proposals.slice(0, 25).map(x => ({
                        pair: x.pair,
                        prices: clone(x.prices),
                        reason: x.reason || null
                    }))
                })).catch(e => ({error: String(e && e.message || e)}))
            }
        } catch (e) {
            outcome = {
                ok: false,
                stage: "exception",
                error: String(e && e.message || e),
                stack: e && e.stack || null
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
        }

        outcome = outcome || {ok: false, stage: "unknown"}
        outcome.restoredSettings = !restoreError
        if (restoreError) outcome.restoreError = restoreError
        outcome.durationMs = Date.now() - startedAt
        return outcome
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
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--remote-allow-origins=*",
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

    const result = await evalInFreshAesContext(page, massApplyExpression({
        serverSlug,
        routeLimit,
        maxPerDay,
        maxPerHour,
        logLimit,
        perRouteLogLimit,
        minDeltaPct,
        maxStepPct
    }))

    const output = {
        server: serverHost,
        enterpriseId,
        loggedIn,
        profileDir,
        routeLimit,
        result,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2))
    console.log(JSON.stringify(output, null, 2))
    const ok = result && result.ok === true
        && result.restoredSettings === true
        && pageErrors.length === 0
    process.exitCode = ok ? 0 : 1
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}
