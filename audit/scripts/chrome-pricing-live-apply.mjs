import { chromium } from "playwright"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname)
const EXT_PATH = ROOT
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "aes-chrome-pricing-live-"))
const CHROME = process.env.CHROME_EXECUTABLE || process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const routeState = {
    ICNNRT: {hub: "ICN", dest: "NRT", prices: {Y: 250, C: 600, F: 1100, Cargo: 0.85}},
    ICNHND: {hub: "ICN", dest: "HND", prices: {Y: 210, C: 540, F: 980, Cargo: 0.72}}
}
const posted = []

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function formPage(pair) {
    const rec = routeState[pair] || routeState.ICNNRT
    const p = rec.prices
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${pair} Pricing | AirlineSim</title>
</head>
<body>
  <div class="as-navbar-main"><a class="name" href="#"><span>Casper Flight Logistics</span></a></div>
  <script id="wicket-ajax-base-url">Wicket.Ajax.baseUrl="com/markets/${pair}?399";</script>
  <form id="pricing-form" method="post" action="/app/com/markets/${pair}?399-1.-pair-pair~panel-settings-settings~form">
    <fieldset>
      <legend>Pricing</legend>
      <table>
        <tbody>
          <tr><td>Y</td><td>${p.Y} AS$</td><td><input type="text" name="classes:prices:0:newPrice" value="${p.Y}"></td><td></td><td><span>${p.Y}</span></td></tr>
          <tr><td>C</td><td>${p.C} AS$</td><td><input type="text" name="classes:prices:1:newPrice" value="${p.C}"></td><td></td><td><span>${p.C}</span></td></tr>
          <tr><td>F</td><td>${p.F} AS$</td><td><input type="text" name="classes:prices:2:newPrice" value="${p.F}"></td><td></td><td><span>${p.F}</span></td></tr>
          <tr><td>Cargo</td><td>${p.Cargo} AS$</td><td><input type="text" name="classes:prices:3:newPrice" value="${p.Cargo}"></td><td></td><td><span>${p.Cargo}</span></td></tr>
        </tbody>
      </table>
    </fieldset>
    <fieldset>
      <legend>General Settings</legend>
      <select name="serviceProfile-group:serviceProfile-group_body:serviceProfile"><option value="svc-1" selected>Balanced</option></select>
    </fieldset>
    <label><input type="checkbox" name="settings:airportPair" checked> Airport pair</label>
    <label><input type="checkbox" name="settings:flightNumbers" checked> Flight numbers</label>
    <button name="submit-prices">Apply</button>
  </form>
</body>
</html>`
}

function dashboardPage() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AES Live Pricing Fixture</title>
</head>
<body>
  <nav id="as-navbar-main-collapse">
    <ul class="navbar-nav">
      <li><a href="/app/enterprise/dashboard">Dashboard</a></li>
      <li><a href="/app/com/scheduling/ICN">Scheduling</a></li>
      <li><a href="/app/com/markets/ICNNRT">Markets</a></li>
    </ul>
  </nav>
  <main>
    <h1>Casper Flight Logistics Dashboard</h1>
    <a href="/app/info/airports/ICN">Seoul Incheon (ICN)</a>
    <a href="/app/info/airports/NRT">Tokyo Narita (NRT)</a>
    <a href="/app/info/airports/HND">Tokyo Haneda (HND)</a>
  </main>
</body>
</html>`
}

function pairFromUrl(url) {
    const m = /\/app\/com\/markets\/([A-Z0-9]{6,8})/i.exec(url)
    return m ? m[1].toUpperCase() : null
}

function applyPost(pair, body) {
    const params = new URLSearchParams(body || "")
    const rec = routeState[pair]
    if (!rec) return
    const next = Object.assign({}, rec.prices)
    const mapping = {
        Y: "classes:prices:0:newPrice",
        C: "classes:prices:1:newPrice",
        F: "classes:prices:2:newPrice",
        Cargo: "classes:prices:3:newPrice"
    }
    for (const cls of Object.keys(mapping)) {
        if (!params.has(mapping[cls])) continue
        const n = Number(params.get(mapping[cls]))
        if (isFinite(n)) next[cls] = cls === "Cargo" ? Math.round(n * 100) / 100 : Math.round(n)
    }
    rec.prices = next
    posted.push({
        pair,
        body: body || "",
        prices: Object.assign({}, next),
        scope: {
            airportPair: params.has("settings:airportPair"),
            flightNumbers: params.has("settings:flightNumbers"),
            returnAirportPair: params.has("settings:returnAirportPair"),
            returnFlightNumbers: params.has("settings:returnFlightNumbers")
        },
        submit: params.has("submit-prices")
    })
}

async function evalInAesWorld(page, expression) {
    const deadline = Date.now() + 15000
    let lastError = null
    while (Date.now() < deadline) {
        const cdp = await page.context().newCDPSession(page)
        const contexts = new Map()
        cdp.on("Runtime.executionContextCreated", evt => {
            if (evt && evt.context) contexts.set(evt.context.id, evt.context)
        })
        try {
            await cdp.send("Runtime.enable")
            await sleep(350)
            let best = null
            for (const ctx of contexts.values()) {
                let probe
                try {
                    probe = await cdp.send("Runtime.evaluate", {
                        contextId: ctx.id,
                        returnByValue: true,
                        expression: `(() => {
                            const keys = [
                                "AesRoutePriceAutomator",
                                "RouteAssistantPricingApplier",
                                "RouteAssistantSettings",
                                "RouteAssistantSilentAutoProposers",
                                "RouteAssistantPricingApplyLog"
                            ]
                            return keys.filter(k => !!window[k]).length
                        })()`
                    })
                } catch (_) {
                    continue
                }
                const score = probe && probe.result && probe.result.value || 0
                if (!best || score > best.score) best = {ctx, score}
            }
            if (best && best.score > 0) {
                const result = await cdp.send("Runtime.evaluate", {
                    contextId: best.ctx.id,
                    expression,
                    awaitPromise: true,
                    returnByValue: true,
                    timeout: 20000
                })
                if (result.exceptionDetails) {
                    throw new Error(result.exceptionDetails.text
                        || (result.exceptionDetails.exception && result.exceptionDetails.exception.description)
                        || "Runtime.evaluate failed")
                }
                return result.result.value
            }
            lastError = new Error("No AES isolated world found")
        } catch (e) {
            lastError = e
        } finally {
            await cdp.detach().catch(() => {})
        }
        await sleep(250)
    }
    throw lastError || new Error("No AES isolated world found")
}

async function main() {
    const cdpPort = process.env.AES_CDP_PORT || ""
    const connected = !!cdpPort
    const browser = connected
        ? await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort)
        : null
    const context = connected
        ? browser.contexts()[0]
        : await chromium.launchPersistentContext(PROFILE, {
            executablePath: fs.existsSync(CHROME) ? CHROME : chromium.executablePath(),
            headless: false,
            ignoreDefaultArgs: ["--disable-extensions"],
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
    if (!context) throw new Error("No browser context available")

    const consoleRows = []
    const pageErrors = []
    context.on("page", page => {
        page.on("console", msg => {
            if (msg.type() === "error" || msg.type() === "warning") {
                consoleRows.push({url: page.url(), type: msg.type(), text: msg.text()})
            }
        })
        page.on("pageerror", err => pageErrors.push({url: page.url(), message: String(err && err.message || err)}))
    })

    await context.route("https://*.airlinesim.aero/**", async route => {
        const req = route.request()
        const url = req.url()
        const pair = pairFromUrl(url)
        if (pair && req.method() === "POST") {
            applyPost(pair, req.postData() || "")
            await route.fulfill({status: 200, contentType: "text/html; charset=utf-8", body: formPage(pair)})
            return
        }
        if (pair) {
            await route.fulfill({status: 200, contentType: "text/html; charset=utf-8", body: formPage(pair)})
            return
        }
        await route.fulfill({status: 200, contentType: "text/html; charset=utf-8", body: dashboardPage()})
    })

    const page = await context.newPage()
    await page.goto("https://free1.airlinesim.aero/app/enterprise/dashboard", {waitUntil: "domcontentloaded"})
    await page.waitForSelector(".aes-menu__trigger", {timeout: 12000})

    const result = await evalInAesWorld(page, `(async () => {
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
                    silentAutoPerClassEnabled: {Y: true, C: true, F: true, Cargo: true},
                    silentAutoPerClassMinDemandPool: {Y: 1, C: 1, F: 1, Cargo: 1},
                    apply: {
                        enabled: true,
                        dryRunOnly: false,
                        liveScopes: {manual: true, bulk: true, silentAuto: true},
                        cooldownMinPerRoute: 0,
                        cooldownMinGlobal: 0,
                        warnAboveDeltaPct: 100,
                        defaultScope: {
                            airportPair: true,
                            flightNumbers: true,
                            returnAirportPair: false,
                            returnFlightNumbers: false
                        },
                        classes: {
                            Y: {enabled: true}, C: {enabled: true}, F: {enabled: true}, Cargo: {enabled: true}
                        }
                    }
                },
                ors: {playstyle: "adaptive", monopolyOrsMultiplier: 0.25, competitiveOrsMultiplier: 1.5},
                demandDepth: {historicWindowPeriods: 4}
            }},
            "routeAssistant:topRoutes:ICN": {
                server: "free1",
                hub: "ICN",
                scrapedAt: now,
                rows: [{
                    destIata: "HND",
                    paxScore: 9,
                    cargoScore: 9,
                    priceElasticityByClass: {Y: -1.5, C: -1.1, F: -1.7, Cargo: -0.8},
                    rmTightnessByClass: {Y: 0.95, C: 0.80, F: 0.65, Cargo: 0.96},
                    demandPoolByClass: {Y: 700, C: 90, F: 25, Cargo: 7000}
                }]
            },
            "routeAssistant:markets:ownPricing:ICN-HND": {
                server: "free1",
                hub: "ICN",
                dest: "HND",
                scrapedAt: now,
                prices: {Y: 210, C: 540, F: 980, Cargo: 0.72}
            },
            "routeAssistant:markets:competitors:ICN-HND": {
                server: "free1",
                hub: "ICN",
                dest: "HND",
                scrapedAt: now,
                competitors: [
                    {classKey: "Y", price: 250},
                    {classKey: "Y", price: 265},
                    {classKey: "C", price: 610},
                    {classKey: "F", price: 1120},
                    {isCargo: true, price: 0.86},
                    {isCargo: true, price: 0.91}
                ]
            }
        })

        const directLog = new RouteAssistantPricingApplyLog({limit: 50, perRouteLimit: 10, dedupWindowMin: 0})
        const directApplier = new RouteAssistantPricingApplier("free1", {
            dryRunOnly: false,
            applyEnabled: true,
            liveScopes: {silentAuto: true},
            cooldownMinPerRoute: 0,
            cooldownMinGlobal: 0,
            warnAboveDeltaPct: 100,
            applyLog: directLog
        })
        const direct = await directApplier.apply("ICN", "NRT", {
            Y: 275,
            C: 660,
            F: 1180,
            Cargo: 0.96
        }, {
            source: "silent-auto",
            dryRun: false,
            scope: {airportPair: true, flightNumbers: true, returnAirportPair: false, returnFlightNumbers: false},
            reason: "chrome live apply probe"
        })

        const preview = await AesRoutePriceAutomator.preview({server: "free1", airline: "CFA"}, {
            followMode: "all",
            limit: 10
        })
        const tick = await AesRoutePriceAutomator.runTick({server: "free1", airline: "CFA"}, {
            force: true,
            followMode: "all",
            maxRoutes: 1
        })
        const storage = await chrome.storage.local.get([
            "routeAssistant:markets:ownPricing:ICN-NRT",
            "routeAssistant:markets:ownPricing:ICN-HND",
            "routeAssistant:pricingApplyLog"
        ])
        return {
            runtimeId: chrome.runtime.id,
            gates: {
                directDryRun: direct.dryRun,
                directReason: direct.applyGate && direct.applyGate.reason,
                previewDryRun: preview.state && preview.state.dryRun,
                previewReason: preview.state && preview.state.applyGate && preview.state.applyGate.reason,
                tickDryRun: tick.dryRun
            },
            direct: {
                status: direct.status,
                newPrices: direct.newPrices,
                verifiedPrices: direct.verifiedPrices,
                logId: direct.logId,
                error: direct.error || null
            },
            preview: {
                counts: preview.counts,
                proposals: preview.proposals.map(p => ({pair: p.pair, prices: p.prices, reason: p.reason})).slice(0, 3)
            },
            tick,
            cache: {
                nrt: storage["routeAssistant:markets:ownPricing:ICN-NRT"],
                hnd: storage["routeAssistant:markets:ownPricing:ICN-HND"],
                logCount: storage["routeAssistant:pricingApplyLog"] && storage["routeAssistant:pricingApplyLog"].length
            }
        }
    })()`)

    const output = {result, posted, consoleRows, pageErrors}
    console.log(JSON.stringify(output, null, 2))

    const ok = result
        && result.gates
        && result.gates.directDryRun === false
        && result.gates.previewDryRun === false
        && result.gates.tickDryRun === false
        && result.direct
        && result.direct.status === "verified"
        && result.tick
        && result.tick.applied >= 1
        && posted.length >= 2
        && pageErrors.length === 0
    await context.unroute("https://*.airlinesim.aero/**").catch(() => {})
    if (connected) {
        await page.close().catch(() => {})
    } else {
        await context.close()
        fs.rmSync(PROFILE, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    }
    process.exit(ok ? 0 : 1)
}

main().catch(err => {
    console.error(err && err.stack || err)
    process.exit(1)
})
