import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const port = process.env.AES_LIVE_CHROME_PORT || "10019"
const serverHost = process.env.AES_LIVE_SERVER || "free1.airlinesim.aero"
const serverSlug = serverHost.replace(/^https?:\/\//i, "").replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = process.env.AES_REAL_ENTERPRISE_ID || process.env.AES_TEST_ENTERPRISE_ID || "775"
const observeTicks = Math.max(2, Math.min(5, Number(process.env.AES_AUTO5_TICKS) || 3))
const timeoutMs = Math.max(20000, Math.min(90000, Number(process.env.AES_AUTO5_TIMEOUT_MS) || 40000))
const outPath = path.resolve(process.env.AES_AUTO5_REPORT
    || `audit/live-dashboard-auto-5s-real-${port}-20260504.json`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
                    "RouteAssistantSettings",
                    "RouteAssistantPricingApplier",
                    "RouteAssistantPricingApplyLog"
                ]
                return names.filter(name => !!window[name]).length
            })()`).catch(() => 0)
            if (score >= 5) return {client, contextId: ctx.id}
        }
        await sleep(500)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated dashboard auto-pricing context not found")
}

function browserExpression(input) {
    return `(${async function run(input) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
        const startedAt = Date.now()
        const original = await RouteAssistantSettings.load()
        const clone = obj => obj && typeof obj === "object"
            ? JSON.parse(JSON.stringify(obj))
            : obj
        const report = {
            ok: false,
            stage: "running",
            startedAt,
            url: location.href,
            title: document.title,
            configured: null,
            previewBefore: null,
            observed: [],
            intervalsMs: [],
            applyLog: null,
            restoredSettings: false
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
            apply.pricingApplyLogDedupWindowMin = 0
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
            const desc = AesRoutePriceAutomator.describeSettings(configured, {followMode: "all"})
            const previewBefore = await AesRoutePriceAutomator.preview(
                {server: input.serverSlug, airline: null},
                {followMode: "all", limit: 100}
            )
            report.configured = desc
            report.previewBefore = {
                counts: previewBefore.counts,
                proposals: (previewBefore.proposals || []).slice(0, 10).map(p => ({
                    pair: p.pair,
                    prevPrices: clone(p.prevPrices),
                    prices: clone(p.prices),
                    reason: p.reason || null
                }))
            }

            if (typeof AesRoutePriceAutomatorDashboardLoop.start === "function") {
                AesRoutePriceAutomatorDashboardLoop.start()
            }

            const seen = new Set()
            const deadline = Date.now() + input.timeoutMs
            while (Date.now() < deadline && report.observed.length < input.observeTicks) {
                const latest = await RouteAssistantSettings.load()
                const p = latest && latest.pricing || {}
                const at = Number(p.silentAutoLastTickAt)
                if (Number.isFinite(at) && at > 0 && !seen.has(at)) {
                    seen.add(at)
                    report.observed.push({
                        at,
                        iso: new Date(at).toISOString(),
                        result: clone(p.silentAutoLastTickResult || null)
                    })
                }
                await sleep(250)
            }
            for (let i = 1; i < report.observed.length; i++) {
                report.intervalsMs.push(report.observed[i].at - report.observed[i - 1].at)
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
                    ts: e.ts,
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

            const cadenceOk = report.intervalsMs.length
                && report.intervalsMs.every(ms => ms >= 4000 && ms <= 9000)
            report.ok = desc.liveWrites === true
                && desc.dryRun === false
                && report.observed.length >= input.observeTicks
                && cadenceOk
                && report.applyLog.successes >= 1
                && report.applyLog.failures === 0
            report.stage = "done"
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
const page = context.pages().find(p => /airlinesim\.aero/.test(p.url())) || context.pages()[0] || await context.newPage()
page.setDefaultTimeout(60000)

const consoleRows = []
const pageErrors = []
page.on("console", msg => {
    if (msg.type() === "error" || msg.type() === "warning") {
        consoleRows.push({type: msg.type(), text: msg.text(), url: page.url()})
    }
})
page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

const dashboardUrl = `https://${serverHost.replace(/^https?:\/\//i, "")}/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseId)}`
await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"}).catch(err => {
    if (!/ERR_ABORTED/.test(String(err))) throw err
})
await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 45000})

const found = await findAesContext(page)
let result
try {
    result = await evalInContext(found.client, found.contextId, browserExpression({
        serverSlug,
        observeTicks,
        timeoutMs
    }))
} finally {
    await found.client.detach().catch(() => {})
}

const output = {
    ok: !!(result && result.ok) && result.restoredSettings === true && pageErrors.length === 0,
    server: serverHost,
    enterpriseId,
    port,
    result,
    consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
    pageErrors
}
fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
console.log(JSON.stringify({
    ok: output.ok,
    port,
    intervalsMs: result && result.intervalsMs,
    liveWrites: result && result.configured && result.configured.liveWrites,
    dryRun: result && result.configured && result.configured.dryRun,
    proposalsBefore: result && result.previewBefore && result.previewBefore.proposals,
    applyLog: result && result.applyLog,
    report: outPath
}, null, 2))
await browser.close().catch(() => {})
process.exit(output.ok ? 0 : 1)
