import { chromium } from "playwright"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname)
const EXT_PATH = ROOT
const PROFILE = path.join(os.tmpdir(), "aes-chrome-pricing-ors-smoke")

const AS_FIXTURE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AES Chrome Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    #as-navbar-main-collapse ul { display: flex; gap: 12px; list-style: none; padding: 8px 12px; margin: 0; background: #f5f5f5; }
    main { padding: 16px; }
    fieldset { margin: 12px 0; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #ddd; padding: 4px 8px; }
  </style>
</head>
<body>
  <nav id="as-navbar-main-collapse">
    <ul class="navbar-nav">
      <li><a href="/app/enterprise/dashboard">Dashboard</a></li>
      <li><a href="/app/fleets">Fleets</a></li>
      <li><a href="/app/com/scheduling/ICN">Scheduling</a></li>
      <li><a href="/app/finance/accounting">Accounting</a></li>
      <li><a href="/app/enterprise/settings">Settings</a></li>
    </ul>
  </nav>
  <main>
    <h1>Dashboard: Chrome Fixture</h1>
    <a href="/app/info/airports/ICN">Seoul Incheon (ICN)</a>
    <a href="/app/info/airports/NRT">Tokyo Narita (NRT)</a>
    <fieldset>
      <legend>Pricing</legend>
      <form method="post" action="/app/com/markets/ICNNRT?1-1.-pair-pair~panel-settings-settings~form">
        <table><tbody>
          <tr><td>Y</td><td>250 AS$</td><td><input type="text" name="classes:prices:0:newPrice" value="250"></td><td></td><td><span>250</span></td></tr>
          <tr><td>C</td><td>600 AS$</td><td><input type="text" name="classes:prices:1:newPrice" value="600"></td><td></td><td><span>600</span></td></tr>
          <tr><td>F</td><td>1100 AS$</td><td><input type="text" name="classes:prices:2:newPrice" value="1100"></td><td></td><td><span>1100</span></td></tr>
          <tr><td>Cargo</td><td>0.85 AS$</td><td><input type="text" name="classes:prices:3:newPrice" value="0.85"></td><td></td><td><span>0.85</span></td></tr>
        </tbody></table>
        <button name="submit-prices">Apply</button>
      </form>
    </fieldset>
  </main>
</body>
</html>`

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function evalInAesWorld(page, expression) {
    const cdp = await page.context().newCDPSession(page)
    const contexts = []
    cdp.on("Runtime.executionContextCreated", evt => contexts.push(evt.context))
    await cdp.send("Runtime.enable")
    await sleep(350)
    const isolated = contexts.filter(ctx => {
        const aux = ctx.auxData || {}
        return aux.type === "isolated" && String(ctx.origin || "").startsWith("chrome-extension://")
    })
    let best = null
    for (const ctx of isolated) {
        const probe = await cdp.send("Runtime.evaluate", {
            contextId: ctx.id,
            returnByValue: true,
            expression: `(() => {
                const keys = [
                    "AesRoutePriceAutomator",
                    "RouteAssistantSilentAutoProposers",
                    "RouteAssistantPerClassProposer",
                    "AesRouteAssistantOrsPlaystyleContext",
                    "ScheduleBuilder",
                    "ScheduleFactors",
                    "SchedulePresets",
                    "AesPricingCompass",
                    "AesSettings"
                ]
                return keys.filter(k => !!window[k]).length
            })()`
        })
        const score = probe.result && probe.result.value || 0
        if (!best || score > best.score) best = {ctx, score}
    }
    if (!best || best.score === 0) {
        throw new Error("No AES isolated world found on " + page.url())
    }
    const result = await cdp.send("Runtime.evaluate", {
        contextId: best.ctx.id,
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 12000
    })
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text
            || (result.exceptionDetails.exception && result.exceptionDetails.exception.description)
            || "Runtime.evaluate failed")
    }
    return result.result.value
}

async function main() {
    fs.rmSync(PROFILE, {recursive: true, force: true})
    const context = await chromium.launchPersistentContext(PROFILE, {
        executablePath: process.env.CHROME_EXECUTABLE || chromium.executablePath(),
        headless: false,
        viewport: {width: 1440, height: 1000},
        args: [
            `--disable-extensions-except=${EXT_PATH}`,
            `--load-extension=${EXT_PATH}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check"
        ]
    })

    const consoleRows = []
    const pageErrors = []
    context.on("page", page => {
        page.on("console", msg => {
            const type = msg.type()
            if (type === "error" || type === "warning") {
                consoleRows.push({url: page.url(), type, text: msg.text()})
            }
        })
        page.on("pageerror", err => pageErrors.push({url: page.url(), message: String(err && err.message || err)}))
    })

    await context.route("https://*.airlinesim.aero/**", async route => {
        await route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: AS_FIXTURE
        })
    })

    const page = await context.newPage()
    await page.goto("https://free1.airlinesim.aero/app/enterprise/dashboard", {waitUntil: "domcontentloaded"})
    await page.waitForSelector(".aes-menu__trigger", {timeout: 12000})
    const dashboard = await evalInAesWorld(page, `(() => ({
        runtimeId: chrome.runtime.id,
        hasMenu: !!document.querySelector(".aes-menu__trigger"),
        hasAutomator: !!window.AesRoutePriceAutomator,
        hasPerClass: !!window.RouteAssistantPerClassProposer,
        hasPlaystyle: !!window.AesRouteAssistantOrsPlaystyleContext
    }))()`)

    await page.goto("https://free1.airlinesim.aero/app/com/scheduling/ICN", {waitUntil: "domcontentloaded"})
    await page.waitForSelector(".aes-menu__trigger", {timeout: 12000})
    const pricing = await evalInAesWorld(page, `(async () => {
        const now = Date.now()
        await chrome.storage.local.clear()
        await chrome.storage.local.set({
            settings: {routeAssistant: {
                pricing: {
                    silentAutoEnabled: true,
                    silentAutoFollowMode: "all",
                    silentAutoStrategy: "per-class-elasticity",
                    silentAutoMinDeltaPct: 1,
                    silentAutoMaxStepPct: 10,
                    silentAutoMaxPerDay: 20,
                    silentAutoMaxPerHour: 5,
                    apply: {enabled: true, dryRunOnly: true, liveScopes: {silentAuto: true}, cooldownMinPerRoute: 0, cooldownMinGlobal: 0}
                },
                ors: {playstyle: "adaptive", monopolyOrsMultiplier: 0.25, competitiveOrsMultiplier: 1.5},
                demandDepth: {historicWindowPeriods: 4}
            }},
            "routeAssistant:topRoutes:ICN": {
                server: "free1",
                hub: "ICN",
                scrapedAt: now,
                rows: [{
                    destIata: "NRT",
                    paxScore: 8,
                    cargoScore: 9,
                    priceElasticityByClass: {Y: -1.5, C: -1.0, F: -2.0, Cargo: -0.8},
                    rmTightnessByClass: {Y: 0.90, C: 0.75, F: 0.50, Cargo: 0.95},
                    demandPoolByClass: {Y: 500, C: 80, F: 20, Cargo: 5000}
                }]
            },
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                server: "free1",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: now,
                prices: {Y: 250, C: 600, F: 1100, Cargo: 0.85}
            },
            "routeAssistant:markets:competitors:ICN-NRT": {
                server: "free1",
                hub: "ICN",
                dest: "NRT",
                scrapedAt: now,
                competitors: [
                    {classKey: "Y", price: 280},
                    {classKey: "Y", price: 300},
                    {classKey: "C", price: 700},
                    {classKey: "F", price: 1200},
                    {isCargo: true, price: 0.95},
                    {isCargo: true, price: 1.05}
                ]
            }
        })
        const direct = window.RouteAssistantPerClassProposer.propose({
            hub: "ICN",
            destIata: "NRT",
            priceElasticityByClass: {Y: -1.5, C: -1.0, F: -2.0, Cargo: -0.8},
            rmTightnessByClass: {Y: 0.90, C: 0.75, F: 0.50, Cargo: 0.95},
            demandPoolByClass: {Y: 500, C: 80, F: 20, Cargo: 5000},
            competitorPricesByClass: {Y: 290, C: 700, F: 1200, Cargo: 1.00},
            competitorCountsByClass: {Y: 2, C: 1, F: 1, Cargo: 2}
        }, {Y: 250, C: 600, F: 1100, Cargo: 0.85}, {
            silentAutoMinDeltaPct: 1,
            silentAutoMaxStepPct: 10,
            silentAutoPerClassEnabled: {Y: true, C: true, F: true, Cargo: true},
            silentAutoPerClassMinDemandPool: {Y: 50, C: 10, F: 5, Cargo: 1000},
            orsCompetition: {playstyle: "adaptive", monopolyOrsMultiplier: 0.25, competitiveOrsMultiplier: 1.5}
        }, {})
        const preview = await window.AesRoutePriceAutomator.preview({server: "free1", airline: "CFA"}, {limit: 10, followMode: "all"})
        const row = preview.rows.find(r => r.pair === "ICN-NRT")
        const playstyle = window.AesRouteAssistantOrsPlaystyleContext.classify({
            competitorCount: 5,
            ourPaxShare: 0.05,
            settings: {playstyle: "adaptive", monopolyOrsMultiplier: 0.25, competitiveOrsMultiplier: 1.5}
        })
        return {
            registry: window.RouteAssistantSilentAutoProposers.list().map(x => x.key),
            direct,
            preview: {
                counts: preview.counts,
                rowStage: row && row.stage,
                reason: row && row.reason,
                prices: row && row.proposal && row.proposal.prices,
                signals: row && row.pricingSignals && row.pricingSignals.labels,
                competitorPricesByClass: row && row.competitorPricesByClass
            },
            playstyle
        }
    })()`)

    await page.goto("https://free1.airlinesim.aero/app/fleets/aircraft/22094/0", {waitUntil: "domcontentloaded"})
    await page.waitForSelector(".aes-menu__trigger", {timeout: 12000})
    const fleets = await evalInAesWorld(page, `(() => ({
        hasScheduleFactors: !!window.ScheduleFactors,
        hasSchedulePresets: !!window.SchedulePresets,
        hasScheduleBuilder: !!window.ScheduleBuilder,
        hasAfpHost: !!window.AesAfp,
        builderSmoke: window.ScheduleBuilder
            ? new window.ScheduleBuilder({
                hub: "ICN",
                factors: window.ScheduleFactors.defaultFactors(),
                waves: [{id: "w1", arrivalWindow: {start: "06:00", end: "06:30"}, departureWindow: {start: "07:15", end: "07:45"}, composition: {shortHaul: 1}}]
              }, {}).validatePreset()
            : ["missing"]
    }))()`)

    const extensionId = dashboard.runtimeId
    const bridge = await context.newPage()
    await bridge.goto(`chrome-extension://${extensionId}/bridge.html`, {waitUntil: "domcontentloaded"})
    const bridgeInfo = await bridge.evaluate(() => ({
        title: document.title,
        h1: document.querySelector("h1") && document.querySelector("h1").textContent,
        sections: document.querySelectorAll("section, [data-bridge-section], .aes-bridge-section").length,
        bodyLen: document.body ? document.body.innerText.length : 0
    }))

    const result = {
        dashboard,
        pricing,
        fleets,
        bridge: bridgeInfo,
        consoleRows: consoleRows.filter(r => !/favicon|DevTools/.test(r.text)).slice(0, 20),
        pageErrors
    }

    console.log(JSON.stringify(result, null, 2))

    const proposed = pricing.preview && pricing.preview.prices || {}
    const ok = dashboard.hasAutomator
        && dashboard.hasPerClass
        && dashboard.hasPlaystyle
        && pricing.registry.includes("per-class-elasticity")
        && pricing.direct && pricing.direct.ok
        && proposed.Y != null
        && proposed.Cargo != null
        && fleets.hasScheduleBuilder
        && pageErrors.length === 0
    await context.close()
    process.exit(ok ? 0 : 1)
}

main().catch(async err => {
    console.error(err && err.stack || err)
    process.exit(1)
})
