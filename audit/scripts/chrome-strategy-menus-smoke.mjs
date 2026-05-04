import { chromium } from "playwright"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname)
const EXT_PATH = ROOT
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "aes-chrome-strategy-menus-smoke-"))
const CHROME = process.env.CHROME_EXECUTABLE || process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const AS_FIXTURE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AES Strategy Menu Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    #as-navbar-main-collapse ul { display: flex; gap: 12px; list-style: none; padding: 8px 12px; margin: 0; background: #f5f5f5; }
    main { padding: 16px; }
    #dashboard-fixture { border: 1px solid #ddd; padding: 12px; min-height: 200px; }
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
    <h1>Dashboard: Strategy Fixture</h1>
    <section id="dashboard-fixture">
      <table>
        <tbody><tr><td>Company reputation</td><td>92</td></tr></tbody>
        <tfoot><tr><td><a href="/app/com/scheduling/ICN">Scheduling</a></td><td><a href="/app/fleets">Fleets</a></td><td><a href="/app/com/scheduling/ICN">Hub schedule</a></td></tr></tfoot>
      </table>
    </section>
  </main>
</body>
</html>`

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function progress(label) {
    console.error("[strategy-smoke] " + label)
}

function cleanupProfile() {
    try {
        fs.rmSync(PROFILE, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    } catch (e) {
        progress("profile cleanup skipped: " + (e && e.message || e))
    }
}

function withTimeout(promise, ms, label) {
    let timer = null
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms)
    })
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

async function evalInAesWorld(page, expression) {
    const deadline = Date.now() + 15000
    let lastError = null
    while (Date.now() < deadline) {
        let cdp = null
        try {
            if (page.isClosed()) throw new Error("page closed before AES isolated world was ready")
            cdp = await withTimeout(page.context().newCDPSession(page), 5000, "new CDP session")
            const contexts = []
            cdp.on("Runtime.executionContextCreated", evt => {
                if (evt && evt.context) contexts.push(evt.context)
            })
            await withTimeout(cdp.send("Runtime.enable"), 5000, "Runtime.enable")
            await sleep(450)
            const candidates = contexts.slice()
            let best = null
            for (const ctx of candidates) {
                let probe = null
                try {
                    probe = await withTimeout(cdp.send("Runtime.evaluate", {
                        contextId: ctx.id,
                        returnByValue: true,
                        timeout: 3000,
                        expression: `(() => {
                            const keys = [
                                "AesStrategyPanel",
                                "AESCommandRegistry",
                                "AESCommandPalette",
                                "CentralHubTileRegistry",
                                "CentralHubBus",
                                "AesStrategyHubDesignerModal",
                                "AesStrategyLayeredPanel",
                                "AesStrategyForkStore"
                            ]
                            return keys.filter(k => !!window[k]).length
                        })()`
                    }), 4000, "Runtime.evaluate probe")
                } catch (e) {
                    lastError = e
                    continue
                }
                const score = probe && probe.result && probe.result.value || 0
                if (!best || score > best.score) best = {ctx, score}
            }
            if (!best || best.score === 0) {
                lastError = new Error("No AES isolated world found on " + page.url())
            } else {
                const result = await withTimeout(cdp.send("Runtime.evaluate", {
                    contextId: best.ctx.id,
                    expression,
                    awaitPromise: true,
                    returnByValue: true,
                    timeout: 15000
                }), 18000, "Runtime.evaluate")
                if (result.exceptionDetails) {
                    throw new Error(result.exceptionDetails.text
                        || (result.exceptionDetails.exception && result.exceptionDetails.exception.description)
                        || "Runtime.evaluate failed")
                }
                return result.result.value
            }
        } catch (e) {
            lastError = e
        } finally {
            if (cdp) {
                try { await withTimeout(cdp.detach(), 1000, "CDP detach") } catch (_) {}
            }
        }
        await sleep(250)
    }
    throw lastError || new Error("No AES isolated world found on " + page.url())
}

async function main() {
    progress("launch")
    const context = await chromium.launchPersistentContext(PROFILE, {
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
    progress("launched")

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
    progress("goto dashboard")
    await page.goto("https://free1.airlinesim.aero/app/enterprise/dashboard", {waitUntil: "domcontentloaded"})
    progress("wait menu")
    await page.waitForSelector(".aes-menu__trigger", {timeout: 12000})

    progress("initial eval")
    const initial = await evalInAesWorld(page, `(() => {
        const commands = window.AESCommandRegistry
            ? window.AESCommandRegistry.list({scope: "dashboard", query: "strategy"}).map(c => c.id)
            : []
        const tiles = window.CentralHubTileRegistry
            ? window.CentralHubTileRegistry.all().filter(t => /strategy/.test(t.id)).map(t => ({id: t.id, section: t.section}))
            : []
        return {
            runtimeId: chrome.runtime.id,
            hasMenu: !!document.querySelector(".aes-menu__trigger"),
            hasPanel: !!(window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function"),
            panelSections: window.AesStrategyPanel && window.AesStrategyPanel.sections || [],
            strategyCommands: commands,
            strategyTiles: tiles,
            aesMenuLabels: Array.from(document.querySelectorAll(".aes-menu__panel a")).map(a => a.textContent.trim()).filter(Boolean)
        }
    })()`)

    progress("patch menu fixture")
    await evalInAesWorld(page, `(() => {
        const realOpen = window.AesStrategyPanel.open
        window.__aesStrategySmokeRealOpen = realOpen
        window.AesStrategyPanel.open = function patchedStrategySmokeOpen(opts) {
            opts = opts || {}
            window.__aesStrategyMenuClickOpts = opts
            const snapshot = {
                accountId: "acct-smoke",
                hubs: [{iata: "ICN", byRoute: [{dest: "NRT", override: {}}]}],
                routeObjectives: {}
            }
            const plan = {
                summary: {predictedWeeklyProfit: 12345, predictedOrsAvg: 4.8},
                perAircraft: [{
                    aircraftId: "A1",
                    registration: "HL001",
                    equipment: "A320",
                    utilization: {weeklyHours: 16.5},
                    plannedProfit: 6200,
                    rationale: ["smoke schedule placement"],
                    legs: [{seq: 1, origin: "ICN", destination: "NRT", depTime: "08:00", service: "C", pricePct: 110, _strategy: {tupleScore: 0.77}}]
                }]
            }
            const diff = {
                summary: {
                    byKind: {schedule: 1, service: 1, price: 1, crew: 0, routeCreation: 0, alliance: 0},
                    applicableTotal: 2,
                    advisoryTotal: 1,
                    dollarImpactWeekly: 5000,
                    scheduleDiffMode: "real",
                    aircraftWithDiff: 1,
                    aircraftMissingDiff: 0,
                    addedLegs: 1,
                    removedLegs: 0,
                    keptLegs: 1
                },
                decisions: [{
                    id: "price-ICN-NRT",
                    domain: "price",
                    kind: "price",
                    title: "ICN-NRT price move",
                    subtitle: "Y 250 -> 275",
                    applicable: true,
                    rationale: ["competitor median and demand support a move"],
                    payload: {hub: "ICN", dest: "NRT", toPct: 110},
                    _impact: {unit: "$/wk", value: 3200, label: "+$3,200/wk", tone: "ok"}
                },{
                    id: "service-ICN-NRT",
                    domain: "service",
                    kind: "service",
                    title: "ICN-NRT service profile",
                    subtitle: "Lift ORS on premium demand",
                    applicable: true,
                    rationale: ["premium demand is deep enough"],
                    payload: {hub: "ICN", dest: "NRT"},
                    _impact: {unit: "ORS", value: 0.4, label: "+0.4 ORS", tone: "ok"}
                },{
                    id: "schedule-HL001",
                    domain: "schedule",
                    kind: "schedule",
                    title: "HL001 schedule advisory",
                    subtitle: "ICN-NRT at 08:00",
                    applicable: false,
                    applicableNote: "advisory only in smoke",
                    rationale: ["schedule actuator not enabled"],
                    payload: {aircraftId: "A1", legs: [{origin: "ICN", dest: "NRT"}]},
                    _diff: {added: 1, removed: 0, kept: 1, locked: 0},
                    _impact: {unit: "$/wk", value: 1800, label: "+$1,800/wk", tone: "ok"}
                }]
            }
            return realOpen(Object.assign({snapshot, plan, diff}, opts))
        }
        return true
    })()`)
    progress("click aes menu")
    await page.locator(".aes-menu__trigger").click()
    progress("click strategy settings")
    await page.locator(".aes-menu__panel a").filter({hasText: "Strategy Settings"}).first().click()
    progress("wait strategy panel")
    await page.waitForSelector(".aes-strategy-panel", {timeout: 8000})
    progress("menu click eval")
    const menuClick = await evalInAesWorld(page, `(() => ({
        overlay: !!document.querySelector(".aes-strategy-panel"),
        opts: window.__aesStrategyMenuClickOpts || null,
        active: document.querySelector("[data-aes-strategy-menu][data-active='1']")
            && document.querySelector("[data-aes-strategy-menu][data-active='1']").dataset.aesStrategyMenu
    }))()`)

    progress("panel eval")
    const panel = await evalInAesWorld(page, `(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
        const active = () => {
            const el = document.querySelector("[data-aes-strategy-menu][data-active='1']")
            return el ? el.dataset.aesStrategyMenu : null
        }
        const domain = () => {
            const el = document.querySelector("[data-aes-strategy-domain-filter]")
            return el ? el.value : null
        }
        const decisionText = () => {
            const el = document.querySelector("[data-aes-strategy-section='decisions']")
            return el ? el.textContent : ""
        }
        const afterOpen = {active: active(), domain: domain(), text: decisionText()}
        const settingsDispatch = await window.AESCommandRegistry.dispatch("open.strategy.settings")
        await wait(180)
        const afterSettings = {active: active()}
        const pricingDispatch = await window.AESCommandRegistry.dispatch("open.strategy.pricing")
        await wait(180)
        const afterPricing = {active: active(), domain: domain(), text: decisionText()}
        const learningDispatch = await window.AESCommandRegistry.dispatch("open.strategy.learning")
        await wait(180)
        const afterLearning = {active: active()}
        return {afterOpen, settingsDispatch, afterSettings, pricingDispatch, afterPricing, learningDispatch, afterLearning}
    })()`)

    progress("hub command eval")
    const hubTile = await evalInAesWorld(page, `(() => {
        if (window.AesStrategyPanel && typeof window.AesStrategyPanel.close === "function") window.AesStrategyPanel.close()
        const ids = window.AESCommandRegistry.list({scope: "dashboard", query: "strategy"}).map(c => c.id)
        return {
            hasTileCommand: ids.indexOf("tile.open.strategy") >= 0,
            strategyTileSpec: window.CentralHubTileRegistry
                ? window.CentralHubTileRegistry.all().find(t => t.id === "strategy") || null
                : null
        }
    })()`)

    progress("goto fleets")
    await page.goto("https://free1.airlinesim.aero/app/fleets/aircraft/22094/0", {waitUntil: "domcontentloaded"})
    progress("wait fleets menu")
    await page.waitForSelector(".aes-menu__trigger", {timeout: 12000})
    progress("fleets eval")
    const fleets = await evalInAesWorld(page, `(() => {
        const scopedCommands = window.AESCommandRegistry
            ? window.AESCommandRegistry.list({scope: "fleets", query: "fork"}).map(c => c.id)
            : []
        const dashboardCommands = window.AESCommandRegistry
            ? window.AESCommandRegistry.list({scope: "dashboard", query: "fork"}).map(c => c.id)
            : []
        return {
            hasPanel: !!(window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function"),
            hasForkStore: !!window.AesStrategyForkStore,
            hasSnapshotFork: !!window.AesStrategySnapshotFork,
            hasForwardSimulator: !!window.AesStrategyForwardSimulator,
            forkRegistryAttached: !!window.__aesForkDeriverRegistry,
            scopedForkCommands: scopedCommands,
            dashboardForkCommands: dashboardCommands
        }
    })()`)

    const badMenuStateLabels = initial.aesMenuLabels.filter(label =>
        /(Planner|Strategy|Decisions|Settings|Designer|Overrides|Journal|Skin|Density)(n\/a|ready|ON|OFF|COMPACT|COMFORT)$/i.test(label))

    const result = {
        initial,
        menuClick,
        panel,
        hubTile,
        fleets,
        badMenuStateLabels,
        consoleRows: consoleRows.filter(r => !/favicon|DevTools|legacy dropdown/.test(r.text)).slice(0, 30),
        pageErrors
    }
    progress("result")
    console.log(JSON.stringify(result, null, 2))

    const pricingText = panel.afterPricing && panel.afterPricing.text || ""
    const ok = initial.hasMenu
        && initial.hasPanel
        && initial.panelSections.includes("decisions")
        && initial.strategyCommands.includes("open.strategy.pricing")
        && initial.strategyCommands.includes("open.strategy.settings")
        && initial.strategyTiles.some(t => t.id === "strategy")
        && initial.aesMenuLabels.some(label => /Pricing Decisions/.test(label))
        && badMenuStateLabels.length === 0
        && menuClick.overlay
        && menuClick.active === "settings"
        && menuClick.opts
        && menuClick.opts.section === "settings"
        && panel.afterOpen.active === "settings"
        && panel.settingsDispatch.ok
        && panel.afterSettings.active === "settings"
        && panel.pricingDispatch.ok
        && panel.afterPricing.active === "decisions"
        && panel.afterPricing.domain === "price"
        && pricingText.indexOf("ICN-NRT price move") >= 0
        && panel.learningDispatch.ok
        && panel.afterLearning.active === "learning"
        && hubTile.hasTileCommand
        && hubTile.strategyTileSpec
        && hubTile.strategyTileSpec.section === "tools"
        && fleets.hasPanel
        && fleets.hasForkStore
        && fleets.hasSnapshotFork
        && fleets.hasForwardSimulator
        && fleets.scopedForkCommands.includes("strategy.fork.create")
        && fleets.dashboardForkCommands.includes("strategy.fork.create")
        && pageErrors.length === 0
    await context.close()
    cleanupProfile()
    process.exit(ok ? 0 : 1)
}

main().catch(async err => {
    console.error(err && err.stack || err)
    cleanupProfile()
    process.exit(1)
})
