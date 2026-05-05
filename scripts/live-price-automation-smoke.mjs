import { chromium } from "playwright"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const extensionPath = process.env.AES_EXTENSION_PATH || repoRoot
const requestedPort = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const connectPortRaw = process.env.AES_LIVE_CONNECT_PORT || process.env.AES_CONNECT_PORT || ""
const connectPort = connectPortRaw ? Number(connectPortRaw) : null
const pairArg = String(process.env.AES_PRICE_PAIR || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const reportPath = process.env.AES_PRICE_SMOKE_REPORT
    || path.join(repoRoot, "audit", `live-price-automation-smoke-${Date.now()}.json`)

auditManifest()
const launched = await getOrLaunchBrowser()
const context = launched.context
let page = context.pages().find(p => p.url().includes(serverHost)) || context.pages()[0] || await context.newPage()
const report = {
    ok: false,
    port: launched.port,
    launched: launched.launched,
    serverHost,
    pair: null,
    steps: [],
}

try {
    await page.bringToFront()
    await gotoDom(page, `https://${serverHost}/app/enterprise/dashboard?qa-price-automation=1`)
    await page.waitForLoadState("networkidle").catch(() => {})
    if (await isLoginPage(page)) {
        throw new Error("Browser is not logged in. Log in on the opened Chrome profile, then rerun this script.")
    }

    const pair = pairArg || await pickRoutePair(page)
    if (!pair || pair.length < 6) throw new Error("Could not discover a scheduling route pair")
    const hub = pair.slice(0, 3)
    const dest = pair.slice(3)
    report.pair = `${hub}-${dest}`
    report.steps.push({stage: "route-pair", hub, dest})

    await gotoDom(page, `https://${serverHost}/app/com/scheduling/${hub}${dest}?qa-price-schedule=1`)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(2500)
    const schedulePreview = await evalPricingWithDashboardFallback(page, previewExpression(serverSlug, true))
    report.steps.push({stage: "schedule-cache-preview", preview: compactPreview(schedulePreview)})

    await gotoDom(page, `https://${serverHost}/app/com/markets/${hub}${dest}?qa-price-market=1`)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(3000)

    await gotoDom(page, `https://${serverHost}/app/enterprise/dashboard?qa-price-automation-after-market=1`)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(2500)
    const marketPreview = await evalPricingWithDashboardFallback(page, previewExpression(serverSlug, true))
    report.steps.push({stage: "market-cache-preview", preview: compactPreview(marketPreview)})

    const tick = await evalPricingWithDashboardFallback(page, tickExpression(serverSlug))
    report.steps.push({stage: "dry-run-tick", tick})

    report.ok = !!(
        marketPreview
        && marketPreview.counts
        && marketPreview.counts.routes > 0
        && marketPreview.counts.withOwnPricing > 0
        && tick
        && tick.dryRun === true
        && (!tick.error || ["noProposals", "cooldownActive", "capExhausted"].includes(tick.error.code))
    )
    fs.mkdirSync(path.dirname(reportPath), {recursive: true})
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
} finally {
    if (launched.launched) await context.close().catch(() => {})
    else await launched.browser?.close().catch(() => {})
}

async function getOrLaunchBrowser() {
    const start = Number.isFinite(requestedPort) ? requestedPort : 9222
    if (connectPort) {
        if (!(await hasCdp(connectPort))) throw new Error(`No Chrome CDP endpoint is listening on port ${connectPort}`)
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${connectPort}`)
        return {browser, context: browser.contexts()[0], port: connectPort, launched: false}
    }
    if (await hasCdp(start)) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${start}`)
        return {browser, context: browser.contexts()[0], port: start, launched: false}
    }

    const port = await findAvailablePort(start)
    const profileDir = process.env.AES_PRICE_PROFILE
        || path.join(os.tmpdir(), `aes-price-automation-${port}`)
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: {width: 1366, height: 900},
        args: [
            `--remote-debugging-port=${port}`,
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    })
    return {context, port, launched: true}
}

function auditManifest() {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"))
    if (manifest.manifest_version !== 3) throw new Error("Expected manifest_version 3")
    if (!manifest.background || manifest.background.service_worker !== "background.js") {
        throw new Error("Expected background.js service worker")
    }
    for (const permission of ["storage", "tabs", "alarms"]) {
        if (!(manifest.permissions || []).includes(permission)) {
            throw new Error(`Missing permission: ${permission}`)
        }
    }
    if (!(manifest.host_permissions || []).includes("https://*.airlinesim.aero/*")) {
        throw new Error("Missing AirlineSim host permission")
    }
    const marketsBlock = (manifest.content_scripts || []).find(block =>
        (block.matches || []).some(pattern => /\/app\/com\/markets\//.test(pattern))
    )
    if (!marketsBlock) throw new Error("Market Analysis content-script block missing")
    const scripts = marketsBlock.js || []
    const required = [
        "modules/route-assistant/settings-store.js",
        "modules/route-assistant/markets-page-scraper.js",
        "modules/route-assistant/pricing-plumbing.js",
        "modules/route-assistant/pricing-apply-log.js",
        "modules/route-assistant/pricing-applier.js",
        "modules/route-assistant/silent-auto-proposer-per-class.js",
        "modules/route-assistant/silent-auto-proposers.js",
        "modules/route-assistant/central-price-automator.js",
        "content_markets.js"
    ]
    for (const file of required) {
        if (!scripts.includes(file)) throw new Error(`Market pricing script missing: ${file}`)
        if (!fs.existsSync(path.join(repoRoot, file))) throw new Error(`Manifest file missing on disk: ${file}`)
    }
    assertBefore(scripts, "modules/route-assistant/markets-page-scraper.js", "modules/route-assistant/pricing-applier.js")
    assertBefore(scripts, "modules/route-assistant/pricing-applier.js", "modules/route-assistant/central-price-automator.js")
    assertBefore(scripts, "modules/route-assistant/silent-auto-proposers.js", "modules/route-assistant/central-price-automator.js")
    assertBefore(scripts, "modules/route-assistant/central-price-automator.js", "content_markets.js")
}

function assertBefore(list, left, right) {
    if (list.indexOf(left) < 0 || list.indexOf(right) < 0 || list.indexOf(left) > list.indexOf(right)) {
        throw new Error(`Manifest order invalid: ${left} must load before ${right}`)
    }
}

async function pickRoutePair(page) {
    await gotoDom(page, `https://${serverHost}/app/com/scheduling?qa-price-pick=1`)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(1500)
    const pairs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/app/com/scheduling/"]'))
        .map(a => {
            const m = /\/app\/com\/scheduling\/([A-Z0-9]{6,8})(?:[/?#]|$)/i.exec(a.href || "")
            return m ? m[1].toUpperCase() : null
        })
        .filter(Boolean))
    const unique = Array.from(new Set(pairs)).filter(p => /^[A-Z0-9]{6}$/.test(p))
    return unique[0] || "JFKATL"
}

async function evalPricing(page, expression) {
    const found = await findAesContext(page, `!!(window.AesRoutePriceAutomator && window.RouteAssistantSettings && window.RouteAssistantPricingApplier)`)
    try {
        return await evalCtx(found.client, found.contextId, expression)
    } finally {
        await found.client.detach().catch(() => {})
    }
}

async function evalPricingWithDashboardFallback(page, expression) {
    try {
        return await evalPricing(page, expression)
    } catch (e) {
        if (!/AES price automation context not found/.test(String(e && e.message || e))) throw e
        await gotoDom(page, `https://${serverHost}/app/enterprise/dashboard?qa-price-automation-context=1`)
        await page.waitForLoadState("networkidle").catch(() => {})
        await page.waitForTimeout(2500)
        return await evalPricing(page, expression)
    }
}

function previewExpression(server, forceDryRun) {
    return `(${async function run(input) {
        const p = await AesRoutePriceAutomator.preview(
            {server: input.server},
            {followMode: "all", limit: 50, forceDryRun: input.forceDryRun}
        )
        return {
            counts: p.counts,
            notices: p.notices,
            proposals: (p.proposals || []).slice(0, 5).map(x => ({
                pair: x.pair,
                prices: x.prices,
                reason: x.reason || null,
                deltaPct: x.deltaPct || null,
                headlineClass: x.headlineClass || null
            })),
            rows: (p.rows || []).slice(0, 10).map(r => ({
                pair: r.pair,
                source: r.source,
                stage: r.stage,
                reason: r.reason,
                hasOwnPricing: !!(r.prices && Object.keys(r.prices).length),
                competitorYsCount: r.competitorYsCount || 0
            }))
        }
    }})(${JSON.stringify({server, forceDryRun})})`
}

function tickExpression(server) {
    return `(${async function run(input) {
        const settings = await RouteAssistantSettings.load()
        const originalPricing = JSON.parse(JSON.stringify(settings.pricing || {}))
        try {
            settings.pricing = settings.pricing || {}
            settings.pricing.silentAutoEnabled = true
            settings.pricing.silentAutoFollowMode = "all"
            settings.pricing.silentAutoMinDeltaPct = 0
            settings.pricing.silentAutoLastTickAt = null
            settings.pricing.silentAutoLastTickResult = null
            await RouteAssistantSettings.save({pricing: settings.pricing})
            const t = await AesRoutePriceAutomator.runTick(
                {server: input.server},
                {force: true, forceDryRun: true, source: "live-price-automation-smoke", maxRoutes: 1}
            )
            return {
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
                    stage: r.stage,
                    applyStatus: r.applyStatus || null,
                    reason: r.reason || null,
                    priceSummary: r.priceSummary || null,
                    errorCode: r.errorCode || null
                }))
            }
        } finally {
            await RouteAssistantSettings.save({pricing: originalPricing})
        }
    }})(${JSON.stringify({server})})`
}

function compactPreview(preview) {
    if (!preview) return null
    return {
        counts: preview.counts,
        notices: preview.notices,
        proposals: preview.proposals,
        rows: preview.rows,
    }
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
            const ok = await evalCtx(client, ctx.id, `(() => { try { return ${predicate} } catch (_) { return false } })()`, 3000)
                .catch(() => false)
            if (ok) return {client, contextId: ctx.id}
        }
        await new Promise(resolve => setTimeout(resolve, 300))
    }
    await client.detach().catch(() => {})
    throw new Error("AES price automation context not found")
}

async function evalCtx(client, contextId, expression, timeout = 120000) {
    const res = await client.send("Runtime.evaluate", {
        contextId,
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout,
    })
    if (res.exceptionDetails) {
        const ex = res.exceptionDetails.exception || {}
        throw new Error(ex.description || ex.value || res.exceptionDetails.text || "Runtime.evaluate failed")
    }
    return res.result && Object.prototype.hasOwnProperty.call(res.result, "value")
        ? res.result.value
        : null
}

async function gotoDom(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function isLoginPage(page) {
    return /\/auth\/login/i.test(page.url())
}

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

async function hasCdp(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1000)})
        return res.ok
    } catch (_) {
        return false
    }
}

async function findAvailablePort(startPort) {
    for (let port = startPort; port < startPort + 100; port++) {
        if (await canListen(port)) return port
    }
    throw new Error(`No available remote debugging port found from ${startPort} to ${startPort + 99}`)
}

function canListen(port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => server.close(() => resolve(true)))
        server.listen(port, "127.0.0.1")
    })
}
