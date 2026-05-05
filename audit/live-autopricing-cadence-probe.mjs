import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const port = process.env.AES_LIVE_CHROME_PORT || "9937"
const serverHost = normalizeServerHost(process.env.AES_LIVE_SERVER || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = process.env.AES_REAL_ENTERPRISE_ID || process.env.AES_TEST_ENTERPRISE_ID || "775"
const intervalMs = numberEnv("AES_CADENCE_INTERVAL_MS", 5000)
const cycles = numberEnv("AES_CADENCE_CYCLES", 3)
const routeLimit = numberEnv("AES_CADENCE_ROUTE_LIMIT", 75)
const minDeltaPct = optionalNumberEnv("AES_CADENCE_MIN_DELTA_PCT")
const maxStepPct = optionalNumberEnv("AES_CADENCE_MAX_STEP_PCT")
const outPath = path.resolve(process.env.AES_CADENCE_REPORT
    || path.join(repoRoot, "audit", `live-autopricing-cadence-${port}-20260504.json`))

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function numberEnv(name, fallback) {
    const n = Number(process.env[name])
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function optionalNumberEnv(name) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) return null
    const n = Number(process.env[name])
    return Number.isFinite(n) ? n : null
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function goto(page, url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
}

async function findAesContext(page) {
    const client = await page.context().newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => {
        if (ev && ev.context && ev.context.id) contexts.set(ev.context.id, ev.context)
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
            if (score >= 5) return { client, contextId: ctx.id }
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

async function evalAes(page, expression) {
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
            "RouteAssistantPricingApplier",
            "RouteAssistantPricingApplyLog",
            "RouteAssistantSettings",
            "RouteAssistantSilentAutoProposers"
        ]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return { ok: false, stage: "modules", missing }

        const startedAt = Date.now()
        const original = await RouteAssistantSettings.load()
        const report = {
            ok: false,
            stage: "running",
            startedAt,
            intervalMs: input.intervalMs,
            cycles: input.cycles,
            routeLimit: input.routeLimit,
            configured: null,
            previewBefore: null,
            ticks: [],
            applyLog: null,
            restoredSettings: false
        }

        function clone(obj) {
            return obj && typeof obj === "object" ? JSON.parse(JSON.stringify(obj)) : obj
        }

        function summariseTick(tick, tickStartedAt, prevStartedAt) {
            return {
                tickStartedAt,
                tickCompletedAt: Date.now(),
                sincePrevStartMs: prevStartedAt ? tickStartedAt - prevStartedAt : null,
                dryRun: !!(tick && tick.dryRun),
                proposed: Number(tick && tick.proposed) || 0,
                applied: Number(tick && tick.applied) || 0,
                simulated: Number(tick && tick.simulated) || 0,
                blocked: Number(tick && tick.blocked) || 0,
                skipped: Number(tick && tick.skipped) || 0,
                error: tick && tick.error || null,
                perRoute: ((tick && tick.perRoute) || []).slice(0, 10).map(r => ({
                    pair: r.pair || null,
                    dest: r.dest || null,
                    stage: r.stage || null,
                    applyStatus: r.applyStatus || null,
                    reason: r.reason || null,
                    priceSummary: r.priceSummary || null,
                    prices: clone(r.prices || null),
                    errorCode: r.errorCode || null
                }))
            }
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
                bulk: apply.liveScopes && apply.liveScopes.bulk === true,
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
            pricing.apply = apply
            pricing.silentAutoEnabled = true
            pricing.silentAutoConfirmedAt = Date.now()
            pricing.silentAutoFollowMode = "all"
            pricing.silentAutoMutedUntil = null
            if (input.minDeltaPct != null) pricing.silentAutoMinDeltaPct = Math.max(0, Number(input.minDeltaPct))
            if (input.maxStepPct != null) pricing.silentAutoMaxStepPct = Math.max(0, Number(input.maxStepPct))
            await RouteAssistantSettings.save({ pricing })

            const configured = await RouteAssistantSettings.load()
            const previewBefore = await AesRoutePriceAutomator.preview({ server: input.serverSlug, airline: null }, {
                followMode: "all",
                limit: input.routeLimit
            })
            report.configured = {
                dryRun: previewBefore.state && previewBefore.state.dryRun,
                liveWrites: previewBefore.state && previewBefore.state.liveWrites,
                followMode: previewBefore.state && previewBefore.state.followMode,
                minDeltaPct: configured.pricing && configured.pricing.silentAutoMinDeltaPct,
                maxStepPct: configured.pricing && configured.pricing.silentAutoMaxStepPct
            }
            report.previewBefore = {
                counts: previewBefore.counts,
                proposals: (previewBefore.proposals || []).slice(0, 10).map(p => ({
                    pair: p.pair,
                    prices: clone(p.prices || null),
                    reason: p.reason || null
                }))
            }

            let prevStartedAt = null
            for (let i = 0; i < input.cycles; i++) {
                if (i > 0) await new Promise(resolve => setTimeout(resolve, input.intervalMs))
                const tickStartedAt = Date.now()
                const tick = await AesRoutePriceAutomator.runTick({ server: input.serverSlug, airline: null }, {
                    source: "codex-live-cadence-probe",
                    force: true,
                    followMode: "all",
                    limit: input.routeLimit,
                    maxRoutes: 1
                })
                report.ticks.push(summariseTick(tick, tickStartedAt, prevStartedAt))
                prevStartedAt = tickStartedAt
            }

            const log = new RouteAssistantPricingApplyLog({
                limit: 1000,
                perRouteLimit: 50,
                dedupWindowMin: 0
            })
            const recent = await log.getRecent(1000)
            const entries = ((recent && recent.entries) || []).filter(e =>
                e && e.ts >= startedAt - 1000 && e.source === "silent-auto"
            )
            report.applyLog = {
                entriesInRun: entries.length,
                successes: entries.filter(e => !e.dryRun && (e.status === "verified" || e.status === "posted")).length,
                failures: entries.filter(e => e.status !== "verified" && e.status !== "posted").length,
                entries: entries.map(e => ({
                    route: (e.hub || "") + "-" + (e.dest || ""),
                    status: e.status,
                    dryRun: !!e.dryRun,
                    prevPrices: clone(e.prevPrices || null),
                    newPrices: clone(e.newPrices || null),
                    verifiedPrices: clone(e.verifiedPrices || null),
                    reason: e.reason || null,
                    error: e.error || null
                }))
            }

            const intervals = report.ticks.slice(1).map(t => t.sincePrevStartMs)
            const cadenceOk = intervals.every(ms => ms >= input.intervalMs - 500 && ms <= input.intervalMs + 3000)
            report.ok = report.configured && report.configured.liveWrites === true
                && report.ticks.length === input.cycles
                && report.ticks.every(t => t.dryRun === false)
                && cadenceOk
                && (!report.applyLog || report.applyLog.failures === 0)
            report.stage = "done"
            report.cadenceOk = cadenceOk
            report.intervalsMs = intervals
        } catch (e) {
            report.stage = "exception"
            report.error = String(e && e.message || e)
            report.stack = e && e.stack || null
        } finally {
            try {
                await RouteAssistantSettings.save({
                    pricing: original.pricing,
                    ors: original.ors
                })
                report.restoredSettings = true
            } catch (e) {
                report.restoreError = String(e && e.message || e)
            }
        }
        report.durationMs = Date.now() - startedAt
        return report
    }})(` + JSON.stringify(input) + `)`
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const context = browser.contexts()[0]
if (!context) throw new Error(`No browser context on port ${port}`)
const page = context.pages()[0] || await context.newPage()
page.setDefaultTimeout(60000)

const consoleRows = []
const pageErrors = []
page.on("console", msg => {
    if (msg.type() === "error" || msg.type() === "warning") {
        consoleRows.push({ type: msg.type(), text: msg.text(), url: page.url() })
    }
})
page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

const dashboardUrl = enterpriseId
    ? `https://${serverHost}/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseId)}`
    : `https://${serverHost}/app/enterprise/dashboard`
await goto(page, dashboardUrl)
await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", { timeout: 45000 })

const result = await evalAes(page, cadenceExpression({
    serverSlug,
    intervalMs,
    cycles,
    routeLimit,
    minDeltaPct,
    maxStepPct
}))

const output = {
    server: serverHost,
    enterpriseId,
    port,
    dashboardUrl,
    result,
    consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
    pageErrors
}
fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
console.log(JSON.stringify({
    ok: result && result.ok,
    stage: result && result.stage,
    intervalsMs: result && result.intervalsMs,
    liveWrites: result && result.configured && result.configured.liveWrites,
    dryRunTicks: result && result.ticks && result.ticks.map(t => t.dryRun),
    applied: result && result.ticks && result.ticks.reduce((sum, t) => sum + (t.applied || 0), 0),
    failures: result && result.applyLog && result.applyLog.failures,
    report: outPath
}, null, 2))
// Do not close the browser here: this script attaches to an already-open
// live Chrome instance whose lifetime is owned by chrome-live-open.mjs.
process.exit(result && result.ok && !pageErrors.length ? 0 : 1)
