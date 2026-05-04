import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const extensionPath = repoRoot
const profileDir = process.env.AES_CHROME_STRATEGY_PROFILE || "/tmp/aes-cft-strategy-panel"
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const chromeAppName = process.env.AES_CHROME_APP_NAME || "Google Chrome for Testing"
const port = process.env.AES_CHROME_STRATEGY_PORT || "9291"

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function dashboardPage() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Mock Dashboard | Free1 | AirlineSim</title>
  <style>
    body { margin:0; font-family: Arial, sans-serif; background:#f3efe5; color:#222; }
    .as-navbar-main { height:36px; background:#233044; color:white; display:flex; align-items:center; padding:0 16px; }
    .as-navbar-main a.name { color:white; text-decoration:none; }
    .as-navbar-bottom { height:28px; background:#e9e2d3; display:flex; align-items:center; padding:0 16px; }
    #main-content { padding:18px; }
    #enterprise-dashboard { border:1px solid #c8bda7; background:white; padding:14px; }
    .facts table { border-collapse:collapse; }
    .facts td { padding:2px 8px; border-bottom:1px solid #ddd; }
  </style>
</head>
<body>
  <div class="as-navbar-main"><a class="name" href="#"><span>Casper Flight Logistics</span><span class="caret"></span></a></div>
  <div class="as-navbar-bottom"><span><i class="fa fa-clock-o"></i> 2026-05-02 19:00 HT</span></div>
  <div id="main-content">
    <div id="enterprise-dashboard" class="as-page-dashboard">
      <h1>Casper Flight Logistics Dashboard</h1>
      <div class="facts"><table><tbody>
        <tr><td>Name</td><td>Casper Flight Logistics</td></tr>
        <tr><td>Code</td><td>Casper Flight Logistics</td></tr>
      </tbody></table></div>
    </div>
  </div>
</body>
</html>`
}

async function extensionInfo(page) {
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded" })
        .catch(err => {
            if (!/ERR_ABORTED/.test(String(err))) throw err
        })
    await page.waitForTimeout(1000)
    let lastErr = null
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            return await page.evaluate(() => new Promise(resolve => {
                chrome.developerPrivate.getExtensionsInfo(
                    { includeDisabled: true, includeTerminated: true },
                    infos => resolve((infos || []).find(e => e.name === "AirlineSim Enhancement Suite") || null)
                )
            }))
        } catch (err) {
            lastErr = err
            if (!/Execution context was destroyed|Cannot find context|navigation/i.test(String(err))) throw err
            await page.waitForTimeout(500)
        }
    }
    throw lastErr
}

async function enableExtension(page, id) {
    if (!id) return null
    await page.evaluate(extensionId => new Promise(resolve => {
        chrome.developerPrivate.updateExtensionConfiguration({extensionId, enabled: true}, resolve)
    }), id).catch(() => {})
    await page.waitForTimeout(1000)
    return await extensionInfo(page)
}

function chooseFolderWithAppleScript(folder) {
    const escaped = folder.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
    execFileSync("osascript", [
        "-e", `tell application "${chromeAppName}" to activate`,
        "-e", "delay 0.5"
    ], { encoding: "utf8", timeout: 5000 })
    execFileSync("osascript", ["-e", [
        "tell application \"System Events\"",
        "  keystroke \"g\" using {command down, shift down}",
        "  delay 0.7",
        `  keystroke "${escaped}"`,
        "  delay 0.2",
        "  keystroke return",
        "  delay 1",
        "  keystroke return",
        "  delay 0.7",
        "  keystroke return",
        "end tell"
    ].join("\n")], { encoding: "utf8", timeout: 15000 })
}

async function ensureLoadedFromExtensionsTab(context) {
    const page = context.pages()[0] || await context.newPage()
    let info = await extensionInfo(page)
    if (info && info.location === "UNPACKED" && info.path === extensionPath) {
        if (info.state !== "ENABLED") info = await enableExtension(page, info.id)
        if (info && info.state === "ENABLED") {
            await page.evaluate(id => new Promise(resolve => {
                chrome.developerPrivate.reload(id, resolve)
            }), info.id).catch(() => {})
            await page.waitForTimeout(1500)
            info = await extensionInfo(page)
            if (info && info.state !== "ENABLED") info = await enableExtension(page, info.id)
        }
        if (info && info.state === "ENABLED") {
            return info
        }
    }

    let worker = context.serviceWorkers().find(w => /^chrome-extension:\/\/[^/]+\//.test(w.url()))
    if (!worker) {
        worker = await context.waitForEvent("serviceworker", {
            predicate: w => /^chrome-extension:\/\/[^/]+\//.test(w.url()),
            timeout: 5000
        }).catch(() => null)
    }
    if (worker) {
        const id = new URL(worker.url()).hostname
        return {id, path: extensionPath, state: "ENABLED", location: "UNPACKED", source: "serviceworker"}
    }

    if (process.env.AES_ALLOW_APPLESCRIPT_LOAD !== "1") {
        throw new Error("AES was not visible on chrome://extensions after --load-extension")
    }

    await page.evaluate(() => new Promise(resolve => {
        chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve)
    }))
    const loadPromise = page.evaluate(() => new Promise(resolve => {
        chrome.developerPrivate.loadUnpacked(info => resolve({
            info,
            lastError: chrome.runtime.lastError && chrome.runtime.lastError.message
        }))
    })).catch(err => ({ evalError: String(err) }))

    await page.waitForTimeout(1200)
    chooseFolderWithAppleScript(extensionPath)
    const loadResult = await Promise.race([
        loadPromise,
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 15000))
    ])
    if (loadResult && (loadResult.timeout || loadResult.lastError || loadResult.evalError)) {
        throw new Error("Load unpacked failed: " + JSON.stringify(loadResult))
    }

    info = await extensionInfo(page)
    if (info && info.state !== "ENABLED") info = await enableExtension(page, info.id)
    if (!info || info.state !== "ENABLED" || info.location !== "UNPACKED") {
        throw new Error("AES did not appear as an enabled unpacked extension")
    }
    return info
}

async function seedStorage(context, extId) {
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "domcontentloaded" })
        .catch(async () => {
            await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" })
        })
    const ts = Date.now()
    await page.evaluate(async items => chrome.storage.local.set(items), {
        "centralHub:settings": {
            activeSection: "tools",
            expandedTiles: ["strategy"],
            pinnedTiles: [],
            recentTiles: [],
            layoutMode: "classic",
            cascadePromptDismissed: true
        },
        settings: {
            strategy: {
                tier: "preview-only",
                objective: {kind: "balanced", custom: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}},
                priceMovesEnabled: false,
                routeCreationEnabled: false,
                allianceMovesEnabled: false,
                slotBidApplyEnabled: true,
                serviceMovesEnabled: false,
                crewMovesEnabled: false,
                scheduleApplyEnabled: false,
                autoSeedDisabled: true,
                learningEnabled: false,
                alliance: {apply: {enabled: true, dryRunOnly: true}}
            },
            routeAssistant: {
                pricing: {
                    apply: {
                        enabled: true,
                        dryRunOnly: true,
                        cooldownMinPerRoute: 0,
                        cooldownMinGlobal: 0
                    }
                }
            }
        },
        "free1CFLaircraftFleet": {
            server: "free1",
            type: "aircraftFleet",
            airline: "Casper Flight Logistics",
            scrapedAt: ts,
            fleet: [
                {aircraftId: "999001", registration: "D-CFLA", equipment: "Airbus A320-200", typeId: 320, location: "ICN", hub: "ICN"},
                {aircraftId: "999002", registration: "D-CFLB", equipment: "Airbus A321neo", typeId: 321, location: "ICN", hub: "ICN"}
            ]
        },
        "routeAssistant:markets:ownPricing:ICN-NRT": {
            server: "free1",
            hub: "ICN",
            dest: "NRT",
            scrapedAt: ts,
            prices: {Y: 100, C: 220, F: 500, Cargo: 0.85}
        },
        "aesStrategy:slots:available:free1": [{
                server: "free1",
                iata: "NRT",
                slotId: "NRT-AM-01",
                runwayClass: "A",
                weeklyOps: 14,
                minBid: 85000,
                currentBid: 0,
                observedAt: ts,
                source: "chrome-strategy-flow"
        }]
    })
    await page.close()
}

async function findAesContext(client, contexts, predicate, timeoutMs = 30000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        for (const ctx of contexts.values()) {
            try {
                const result = await client.send("Runtime.evaluate", {
                    contextId: ctx.id,
                    expression: `(() => { try { return !!(${predicate}) } catch (_) { return false } })()`,
                    returnByValue: true
                })
                if (result.result && result.result.value === true) return ctx.id
            } catch (_) {
                // context may have navigated
            }
        }
        await sleep(250)
    }
    throw new Error("AES isolated context not found")
}

async function evalInContext(client, contextId, expression) {
    const result = await client.send("Runtime.evaluate", {
        contextId,
        expression,
        returnByValue: true,
        awaitPromise: true
    })
    if (result.exceptionDetails) {
        const ex = result.exceptionDetails.exception
        throw new Error((ex && (ex.description || ex.value)) || result.exceptionDetails.text || "CDP evaluation failed")
    }
    return result.result.value
}

function installFakeStrategyExpression() {
    return `(() => {
        const ns = window.AesStrategy || (window.AesStrategy = {})
        const now = Date.now()
        const fakeSnapshot = {
            server: "free1",
            airlineCode: "Casper Flight Logistics",
            accountId: null,
            ts: now,
            strategySettings: {alliance: {proposers: {}}},
            settings: {strategy: {}},
            fleet: [
                {aircraftId: "999001", registration: "D-CFLA", equipment: "A320", typeId: 320, currentLocationIata: "ICN", hub: "ICN", cruiseSpeedKmh: 820, rangeKm: 6100, wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 12, ratio: 98}},
                {aircraftId: "999002", registration: "D-CFLB", equipment: "A321neo", typeId: 321, currentLocationIata: "ICN", hub: "ICN", cruiseSpeedKmh: 840, rangeKm: 7400, wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 0, ratio: 99}}
            ],
            hubs: [{
                iata: "ICN",
                byRoute: [{
                    dest: "NRT",
                    distanceKm: 1250,
                    weeklyFlights: 14,
                    orsRank: 4.2,
                    paxScore: 8,
                    profitPerWeek: 120000,
                    ownPricing: {prices: {Y: 100, C: 220, F: 500, Cargo: 0.85}},
                    competitor: {priceMin: 95, priceMax: 140, byClass: {Y: {priceMin: 95, priceMax: 110}, Cargo: {priceMin: 0.82, priceMax: 0.95}}},
                    cacheAge: {maxMs: 1000}
                }]
            }]
        }
        const fakePlan = {
            planId: "chrome-strategy-flow",
            server: "free1",
            airlineCode: "Casper Flight Logistics",
            summary: {predictedWeeklyProfit: 184000, predictedOrsAvg: 0.82},
            perAircraft: [{
                aircraftId: "999001",
                registration: "D-CFLA",
                equipment: "A320",
                typeId: 320,
                hub: "ICN",
                plannedProfit: 74000,
                utilization: {weeklyHours: 31.5, capWeeklyHours: 80},
                rationale: ["NRT cargo pressure and passenger demand are both positive"],
                legs: [
                    {seq: 1, origin: "ICN", destination: "NRT", depTime: "08:00", depTimeLocal: "08:00", service: "svc-42", pricePct: 112},
                    {seq: 2, origin: "NRT", destination: "ICN", depTime: "12:00", depTimeLocal: "12:00", service: "svc-42", pricePct: 112}
                ]
            }],
            priceMoves: [
                {hub: "ICN", dest: "NRT", classKey: "Y", fromPct: 100, toPct: 112, deltaPct: 12, impactWeekly: 5100, rationale: ["Y demand supports a fare lift"]},
                {hub: "ICN", dest: "NRT", classKey: "Cargo", fromPct: 100, toPct: 105, deltaPct: 5, impactWeekly: 1900, rationale: ["Cargo load factor is tight and competitor cargo band is higher"]}
            ],
            serviceMoves: [{
                profileId: "svc-42",
                profileName: "Balanced Asia",
                changes: {drinks: 2},
                predictedOrsDelta: 0.04,
                rationale: ["Route ORS below target"]
            }],
            crewMoves: [],
            routeCreations: [{
                hub: "ICN",
                dest: "SIN",
                distanceKm: 4620,
                proposedTypeIds: [321],
                proposedFrequency: 3,
                proposedPricePct: 108,
                impactWeekly: 22000,
                rationale: ["High unserved demand and idle A321 capacity"]
            }]
        }
        const allianceMoves = [
            {kind: "il-request", partnerEnterpriseId: "12345", partnerName: "Mock Partner", requestType: "INTERLINING", score: 0.82, rationale: ["Adds Japan feed"]},
            {kind: "alliance-join", allianceId: "all-9", allianceName: "Mock Alliance", score: 0.67, rationale: ["Manual alliance join candidate"]}
        ]
        const originalDiff = typeof ns.diffPlan === "function" ? ns.diffPlan.bind(ns) : null
        const originalCollectAdvisory = typeof ns.collectAdvisoryDecisions === "function"
            ? ns.collectAdvisoryDecisions.bind(ns) : null
        const fakeDiff = originalDiff ? originalDiff(fakePlan, fakeSnapshot, {allianceMoves}) : {
            summary: {byKind: {}, applicableTotal: 0, advisoryTotal: 0},
            decisions: []
        }
        window.__aesStrategyPanelFlow = {
            seedCalls: 0,
            snapshotCalls: [],
            pricing: [],
            routeCreation: [],
            alliance: [],
            slotBids: [],
            applyDecision: [],
            openedUrls: [],
            decisions: fakeDiff.decisions.map(d => ({id: d.id, domain: d.domain, title: d.title, applicable: d.applicable}))
        }
        window.open = function(url) {
            window.__aesStrategyPanelFlow.openedUrls.push(String(url || ""))
            return {closed: false, focus: function() {}}
        }
        if (window.AesAccountRegistry) {
            window.AesAccountRegistry.list = async () => [
                {id: "free1:CFL", server: "free1", airlineIdentity: "Casper Flight Logistics", displayName: "Casper Flight Logistics", lastSeenAt: now},
                {id: "free2:WTA", server: "free2", airlineIdentity: "World Two Air", displayName: "World Two Air", lastSeenAt: now - 1000}
            ]
        }
        ns.snapshot = async (opts) => {
            const o = opts || {}
            window.__aesStrategyPanelFlow.snapshotCalls.push({
                server: o.server || null,
                airlineCode: o.airlineCode || null,
                accountId: o.accountId || null
            })
            const server = o.server || fakeSnapshot.server
            const airlineCode = o.airlineCode || fakeSnapshot.airlineCode
            const cash = server === "free2"
                ? {weeklyResult: 74000, bankBalance: 1800000, runwayWeeks: 16}
                : {weeklyResult: 120000, bankBalance: 2500000, runwayWeeks: 20}
            return Object.assign({}, fakeSnapshot, {server, airlineCode, cash})
        }
        ns.scoreRoutes = () => ({routes: [{hub: "ICN", dest: "NRT", score: 91}]})
        ns.computeObjective = (snapshot, scored) => {
            const routes = scored && scored.routes || []
            return routes.reduce((sum, r) => sum + ((r && Number(r.score)) || 0) * 1000, 0)
        }
        ns.allocateFleet = () => fakePlan
        ns.diffPlan = (plan, snapshot, opts) => originalDiff
            ? originalDiff(fakePlan, fakeSnapshot, Object.assign({}, opts || {}, {allianceMoves}))
            : fakeDiff
        ns.collectAdvisoryDecisions = async (snapshot, ctx) => originalCollectAdvisory
            ? originalCollectAdvisory(fakeSnapshot, ctx || {})
            : []
        ns.proposeAllianceMoves = async () => allianceMoves
        ns.applyDecision = async (decision, opts) => {
            window.__aesStrategyPanelFlow.applyDecision.push({decisionId: decision && decision.id, opts})
            return {
                applied: [{decisionId: decision && decision.id, result: {status: "dry-run", formAvailable: true, bodyPreview: "requestType=INTERLINING"}}],
                skipped: [],
                aborted: false
            }
        }
        if (window.AesStrategyStoreReadiness) {
            window.AesStrategyStoreReadiness.seedMissing = async (ctx, progress) => {
                window.__aesStrategyPanelFlow.seedCalls += 1
                if (typeof progress === "function") progress({stage: "done"})
                return {ok: true, seeded: []}
            }
        }
        if (window.AesStrategyPortfolio) {
            window.AesStrategyPortfolio.scanServer = async () => ({
                server: "free1",
                airlines: [{airline: "Casper Flight Logistics", displayName: "Casper Flight Logistics", fleetCount: 2, lastScrape: now}],
                overlapHubs: [],
                overlapRoutes: []
            })
        }
        if (window.RouteAssistantPricingApplier && window.RouteAssistantPricingApplier.prototype) {
            window.RouteAssistantPricingApplier.prototype.warmCache = async () => ({ok: true})
            window.RouteAssistantPricingApplier.prototype.apply = async function(hub, dest, prices, opts) {
                window.__aesStrategyPanelFlow.pricing.push({server: this.server, hub, dest, prices, opts})
                return {ok: true, status: "dry-run", dryRun: true, logId: "pricing-log-1", prices}
            }
        }
        if (window.AesStrategyRouteCreationApplier) {
            window.AesStrategyRouteCreationApplier.apply = async (creation, snapshot, opts) => {
                window.__aesStrategyPanelFlow.routeCreation.push({creation, snapshotServer: snapshot && snapshot.server, opts})
                return {ok: true, status: "dry-run", aircraft: {aircraftId: "999002"}, legs: [{origin: creation.hub, destination: creation.dest}]}
            }
        }
        window.AllianceIlRequestApplier = class FakeAllianceIlRequestApplier {
            constructor(server, opts) {
                this.server = server
                this.opts = opts || {}
            }
            async apply(partnerEnterpriseId, opts) {
                window.__aesStrategyPanelFlow.alliance.push({server: this.server, partnerEnterpriseId, opts, ctorOpts: this.opts})
                return {status: "dry-run", formAvailable: true, bodyPreview: "partner=" + partnerEnterpriseId, logId: "alliance-log-1"}
            }
        }
        if (window.AesSlotBidder) {
            window.AesSlotBidder.apply = async (req) => {
                window.__aesStrategyPanelFlow.slotBids.push(req)
                return {ok: true, dryRun: true, reason: "dry-run-stub"}
            }
        }
        return window.__aesStrategyPanelFlow.decisions
    })()`
}

async function runFlow(context, ext) {
    await seedStorage(context, ext.id)

    const page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(60000)
    const errors = []
    page.on("pageerror", err => errors.push("pageerror: " + err.message))
    page.on("console", msg => {
        if (msg.type() === "error") errors.push("console error: " + msg.text())
    })

    await page.route("https://free1.airlinesim.aero/app/enterprise/dashboard**", route => {
        route.fulfill({ status: 200, contentType: "text/html", body: dashboardPage() })
    })
    await page.route("https://free1.airlinesim.aero/app/alliance**", route => {
        route.fulfill({ status: 200, contentType: "text/html", body: "<html><body><h1>Mock Alliance Page</h1></body></html>" })
    })
    await page.route("https://free1.airlinesim.aero/app/info/enterprises/**", route => {
        route.fulfill({ status: 200, contentType: "text/html", body: "<html><body><h1>Mock Partner Page</h1></body></html>" })
    })

    const client = await context.newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => contexts.set(ev.context.id, ev.context))
    client.on("Runtime.executionContextDestroyed", ev => contexts.delete(ev.executionContextId))
    await client.send("Runtime.enable")

    await page.goto("https://free1.airlinesim.aero/app/enterprise/dashboard?mock-strategy=1", {
        waitUntil: "domcontentloaded"
    })
    await page.waitForSelector("#aes-central-hub")

    const aesCtx = await findAesContext(client, contexts,
        "window.AesStrategyPanel && window.AesStrategy && window.CentralHubTileRegistry")
    const fakeDecisions = await evalInContext(client, aesCtx, installFakeStrategyExpression())

    const tile = page.locator("#aes-central-hub-tile-strategy")
    await tile.scrollIntoViewIfNeeded()
    await expectCount(tile, "strategy tile")
    await tile.locator("[data-aes-strategy-menu-target]").first().waitFor({timeout: 10000})
    const failures = []

    const menuTargets = await tile.locator("[data-aes-strategy-menu-target]").evaluateAll(buttons =>
        buttons.map(b => b.dataset.aesStrategyMenuTarget).filter(Boolean)
    )
    for (const target of ["preview", "briefing", "hub-designer", "portfolio", "slot-trading", "backtest", "layered", "weekly-review", "diagnostics"]) {
        if (!menuTargets.includes(target)) failures.push("strategy menu missing target: " + target)
    }

    async function clickStrategyMenu(target) {
        await tile.scrollIntoViewIfNeeded()
        await tile.locator("[data-aes-strategy-menu-target='" + target + "']").click()
        await page.waitForTimeout(250)
    }

    async function assertTileExpanded(tileId, label, requiredText) {
        const targetTile = page.locator("#aes-central-hub-tile-" + tileId)
        await targetTile.waitFor({timeout: 10000})
        const state = await targetTile.evaluate((el, text) => {
            const body = el.querySelector(".aes-central-hub-tile__body")
            const visible = !!body && window.getComputedStyle(body).display !== "none"
            return {
                visible,
                text: body ? (body.innerText || body.textContent || "") : "",
                hasText: !text || (body && (body.innerText || body.textContent || "").toLowerCase().includes(String(text).toLowerCase()))
            }
        }, requiredText || "")
        if (!state.visible) failures.push(label + " strategy menu did not expand tile")
        if (!state.hasText) failures.push(label + " strategy menu expanded wrong tile/body: " + state.text.slice(0, 120))
    }

    async function dispatchCommand(id) {
        const result = await evalInContext(client, aesCtx,
            "window.AESCommandRegistry && window.AESCommandRegistry.dispatch(" + JSON.stringify(id) + ")")
        if (!result || !result.ok) failures.push("command palette dispatch failed for " + id + ": " + JSON.stringify(result))
        await page.waitForTimeout(250)
    }

    async function assertStrategyPanelFocus(section, label) {
        await page.waitForSelector("[data-aes-strategy-panel='1']", {timeout: 10000})
        const focused = await page.locator("[data-aes-strategy-panel='1'] [data-aes-strategy-menu='" + section + "'][data-active='1']").count()
        if (!focused) failures.push(label + " did not focus Strategy panel section " + section)
    }

    async function closeStrategyPanel() {
        await evalInContext(client, aesCtx, "window.AesStrategyPanel && window.AesStrategyPanel.close(); true")
        await page.waitForSelector("[data-aes-strategy-panel='1']", {state: "detached", timeout: 5000}).catch(() => {})
    }

    async function assertRejectedStrategyOpenHandled(label, clickAction) {
        await closeStrategyPanel()
        const rejectionProbeStart = errors.length
        await evalInContext(client, aesCtx, `(() => {
            window.__aesOriginalStrategyPanelOpen = window.AesStrategyPanel && window.AesStrategyPanel.open
            if (window.AesStrategyPanel) {
                window.AesStrategyPanel.open = () => Promise.reject(new Error("strategy-open-rejection-probe"))
            }
            return true
        })()`)
        try {
            await clickAction()
            await page.waitForTimeout(500)
        } catch (err) {
            failures.push(label + " click failed during rejection probe: " + err.message)
        } finally {
            await evalInContext(client, aesCtx, `(() => {
                if (window.AesStrategyPanel && window.__aesOriginalStrategyPanelOpen) {
                    window.AesStrategyPanel.open = window.__aesOriginalStrategyPanelOpen
                }
                delete window.__aesOriginalStrategyPanelOpen
                return true
            })()`)
        }
        const rejectionProbeErrors = errors.slice(rejectionProbeStart)
            .filter(e => /strategy-open-rejection-probe/.test(e))
        if (rejectionProbeErrors.length) {
            failures.push(label + " leaked rejected AesStrategyPanel.open promise")
        }
        await closeStrategyPanel()
    }

    async function waitForContextValue(expression, predicate, label, timeoutMs = 10000) {
        const started = Date.now()
        let last = null
        while (Date.now() - started < timeoutMs) {
            last = await evalInContext(client, aesCtx, expression).catch(err => ({error: err.message}))
            if (predicate(last)) return last
            await page.waitForTimeout(250)
        }
        failures.push(label + " timed out; last=" + JSON.stringify(last))
        return last
    }

    await tile.locator("[data-aes-strategy-open-modal='1']").waitFor({timeout: 10000})
    await assertRejectedStrategyOpenHandled("Strategy tile header Open", async () => {
        await tile.locator(".aes-central-hub-tile__open").click()
    })
    await assertRejectedStrategyOpenHandled("Strategy tile body Open modal CTA", async () => {
        await tile.locator("[data-aes-strategy-open-modal='1']").click()
    })
    await assertRejectedStrategyOpenHandled("Strategy menu preview", async () => {
        await clickStrategyMenu("preview")
    })

    await tile.locator(".aes-central-hub-tile__open").click()
    await assertStrategyPanelFocus("overview", "Strategy tile header Open")
    await closeStrategyPanel()

    await tile.locator("[data-aes-strategy-open-modal='1']").click()
    await assertStrategyPanelFocus("overview", "Strategy tile body Open modal CTA")
    await closeStrategyPanel()

    await clickStrategyMenu("preview")
    await page.waitForSelector("[data-aes-strategy-panel='1']", {timeout: 10000})
    const previewFocused = await page.locator("[data-aes-strategy-panel='1'] [data-aes-strategy-menu='decisions'][data-active='1']").count()
    if (!previewFocused) failures.push("Preview/apply menu did not focus Strategy panel decisions section")
    await evalInContext(client, aesCtx, "window.AesStrategyPanel && window.AesStrategyPanel.close(); true")
    await page.waitForSelector("[data-aes-strategy-panel='1']", {state: "detached", timeout: 5000}).catch(() => {})

    await clickStrategyMenu("layered")
    await page.waitForSelector("text=Layered strategy overrides", {timeout: 10000})
    await evalInContext(client, aesCtx, "window.AesStrategyLayeredPanel.close(); true")
    await page.waitForSelector("[data-aes-layered-panel='1']", {state: "detached", timeout: 5000}).catch(() => {})

    await clickStrategyMenu("briefing")
    await page.waitForSelector("[data-aes-strategy-surface='briefing']", {timeout: 10000})
        .catch(err => failures.push("Executive briefing menu did not open briefing modal: " + err.message))
    await page.keyboard.press("Escape").catch(err =>
        failures.push("Executive briefing Escape close failed to send: " + err.message))
    await page.waitForSelector("[data-aes-strategy-surface='briefing']", {state: "detached", timeout: 5000})
        .catch(err => failures.push("Executive briefing Escape did not dismiss modal: " + err.message))

    await clickStrategyMenu("hub-designer")
    await page.waitForSelector("[data-aes-strategy-surface='hub-designer']", {timeout: 10000})
        .catch(err => failures.push("Hub designer menu did not open designer modal: " + err.message))
    await evalInContext(client, aesCtx, "window.AesStrategyHubDesignerModal && window.AesStrategyHubDesignerModal.close(); true")
    await page.waitForSelector("[data-aes-strategy-surface='hub-designer']", {state: "detached", timeout: 5000}).catch(() => {})

    await clickStrategyMenu("portfolio")
    await assertTileExpanded("strategy-portfolio", "Portfolio", "world")
    const portfolioTile = page.locator("#aes-central-hub-tile-strategy-portfolio")
    await portfolioTile.locator("[data-aes-strategy-portfolio-world='free2']").click()
    await assertStrategyPanelFocus("overview", "Portfolio world row")
    await waitForContextValue(
        "window.__aesStrategyPanelFlow && window.__aesStrategyPanelFlow.snapshotCalls && window.__aesStrategyPanelFlow.snapshotCalls.some(c => c && c.server === 'free2' && c.airlineCode === 'World Two Air')",
        value => value === true,
        "Portfolio world row snapshot scope"
    )
    await closeStrategyPanel()

    await clickStrategyMenu("slot-trading")
    await assertTileExpanded("strategy-slot-trading", "Slot trading", "NRT")
    await assertStrategyPanelFocus("decisions", "Slot trading menu")
    await page.waitForSelector("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']", {timeout: 10000})
    const slotTradingDomain = await page.locator("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']").inputValue()
    if (slotTradingDomain !== "slotBid") failures.push("Slot trading menu did not select slotBid domain: " + slotTradingDomain)
    await closeStrategyPanel()

    const slotTile = page.locator("#aes-central-hub-tile-strategy-slot-trading")
    await slotTile.locator("[data-aes-strategy-slot-open='1']").click()
    await assertStrategyPanelFocus("decisions", "Slot trading tile CTA")
    await page.waitForSelector("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']", {timeout: 10000})
    const slotTileDomain = await page.locator("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']").inputValue()
    if (slotTileDomain !== "slotBid") failures.push("Slot trading tile CTA did not select slotBid domain: " + slotTileDomain)
    await closeStrategyPanel()
    await assertRejectedStrategyOpenHandled("Slot trading tile CTA", async () => {
        await slotTile.locator("[data-aes-strategy-slot-open='1']").click()
    })

    await dispatchCommand("tile.open.strategy-slot-trading")
    await assertTileExpanded("strategy-slot-trading", "Palette tile.open.strategy-slot-trading", "NRT")
    await dispatchCommand("nav.section.operations")
    await waitForContextValue(
        "window.__aesCentralHub && window.__aesCentralHub.settings && window.__aesCentralHub.settings.activeSection",
        value => value === "operations",
        "Command nav.section.operations"
    )

    await clickStrategyMenu("backtest")
    await assertTileExpanded("strategy-backtest", "Backtest", "backtest")
    await clickStrategyMenu("weekly-review")
    await assertTileExpanded("weekly-review", "Weekly review", "weekly")
    await clickStrategyMenu("diagnostics")
    await assertTileExpanded("diagnostics", "Diagnostics", "diagnostic")

    await evalInContext(client, aesCtx, "window.AESCommandPalette && window.AESCommandPalette.open(); true")
    await page.waitForSelector("#aes-command-palette", {timeout: 10000})
    await page.locator("#aes-command-palette-input").fill("strategy pricing")
    await page.waitForTimeout(250)
    const paletteRows = await page.locator("#aes-command-palette-list [role='option']").evaluateAll(rows =>
        rows.map(r => ({id: r.dataset.cmdId, text: (r.innerText || r.textContent || "").trim()}))
    )
    if (!paletteRows.some(r => r.id === "open.strategy.pricing" && /Open Strategy Pricing Decisions/i.test(r.text))) {
        failures.push("command palette did not surface Open Strategy Pricing Decisions")
    }
    await page.locator("#aes-command-palette-list [data-cmd-id='open.strategy.pricing']").click()
    await page.waitForSelector("#aes-command-palette", {state: "detached", timeout: 5000}).catch(() => {})
    await assertStrategyPanelFocus("decisions", "Palette row click open.strategy.pricing")
    await page.waitForSelector("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']", {timeout: 10000})
    const palettePricingDomain = await page.locator("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']").inputValue()
    if (palettePricingDomain !== "price") failures.push("Palette row click open.strategy.pricing did not select price domain: " + palettePricingDomain)
    await closeStrategyPanel()

    await page.keyboard.press("Control+K")
    await page.waitForSelector("#aes-command-palette", {timeout: 10000})
    await page.locator("#aes-command-palette-input").fill("strategy journal")
    await page.waitForTimeout(250)
    const selectedPaletteCommand = await page.locator("#aes-command-palette-list [aria-selected='true']").evaluate(row => ({
        id: row.dataset.cmdId,
        text: (row.innerText || row.textContent || "").trim()
    })).catch(() => null)
    if (!selectedPaletteCommand || selectedPaletteCommand.id !== "open.strategy.journal") {
        failures.push("Keyboard palette search did not select Strategy Journal first: " + JSON.stringify(selectedPaletteCommand))
    }
    await page.keyboard.press("Enter")
    await page.waitForSelector("#aes-command-palette", {state: "detached", timeout: 5000}).catch(() => {})
    await assertStrategyPanelFocus("journal", "Keyboard palette Enter open.strategy.journal")
    await closeStrategyPanel()

    await dispatchCommand("open.strategy.pricing")
    await assertStrategyPanelFocus("decisions", "Command open.strategy.pricing")
    await page.waitForSelector("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']", {timeout: 10000})
    const pricingDomain = await page.locator("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']").inputValue()
    if (pricingDomain !== "price") failures.push("Command open.strategy.pricing did not select price domain: " + pricingDomain)
    await closeStrategyPanel()

    await dispatchCommand("open.strategy.service")
    await assertStrategyPanelFocus("decisions", "Command open.strategy.service")
    await page.waitForSelector("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']", {timeout: 10000})
    const serviceDomain = await page.locator("[data-aes-strategy-panel='1'] [data-aes-strategy-domain-filter='1']").inputValue()
    if (serviceDomain !== "service") failures.push("Command open.strategy.service did not select service domain: " + serviceDomain)
    await closeStrategyPanel()

    await dispatchCommand("open.strategy.settings")
    await assertStrategyPanelFocus("settings", "Command open.strategy.settings")
    await closeStrategyPanel()

    await dispatchCommand("open.strategy.schedules")
    await assertStrategyPanelFocus("aircraft", "Command open.strategy.schedules")
    await closeStrategyPanel()

    await dispatchCommand("open.strategy.learning")
    await assertStrategyPanelFocus("learning", "Command open.strategy.learning")
    await closeStrategyPanel()

    await dispatchCommand("open.strategy.journal")
    await assertStrategyPanelFocus("journal", "Command open.strategy.journal")
    await closeStrategyPanel()

    await dispatchCommand("open.strategy.layered")
    await page.waitForSelector("[data-aes-layered-panel='1']", {timeout: 10000})
        .catch(err => failures.push("Command open.strategy.layered did not open layered panel: " + err.message))
    await evalInContext(client, aesCtx, "window.AesStrategyLayeredPanel && window.AesStrategyLayeredPanel.close(); true")
    await page.waitForSelector("[data-aes-layered-panel='1']", {state: "detached", timeout: 5000}).catch(() => {})

    await dispatchCommand("open.strategy.hubDesigner")
    await page.waitForSelector("[data-aes-strategy-surface='hub-designer']", {timeout: 10000})
        .catch(err => failures.push("Command open.strategy.hubDesigner did not open designer modal: " + err.message))
    await evalInContext(client, aesCtx, "window.AesStrategyHubDesignerModal && window.AesStrategyHubDesignerModal.close(); true")
    await page.waitForSelector("[data-aes-strategy-surface='hub-designer']", {state: "detached", timeout: 5000}).catch(() => {})

    await dispatchCommand("open.settings.strategy")
    await page.waitForSelector("#aes-unified-settings", {timeout: 10000})
    const settingsText = (await page.locator("#aes-unified-settings .us-canvas").innerText()).toLowerCase()
    if (!settingsText.includes("strategy")) failures.push("Command open.settings.strategy opened settings without strategy content")
    await page.getByRole("button", {name: /Open Strategy panel/i}).click()
    await page.waitForSelector("[data-aes-strategy-panel='1']", {timeout: 10000})
    await assertStrategyPanelFocus("settings", "Unified settings Strategy action")
    await closeStrategyPanel()

    await evalInContext(client, aesCtx, "window.AesStrategyForkStore && window.AesStrategyForkStore.clear && window.AesStrategyForkStore.clear(); true")
    await dispatchCommand("strategy.fork.create")
    const forkAfterCreate = await waitForContextValue(
        "window.AesStrategyForkStore.list().then(list => ({count: list.length, first: list[0] && {forkId: list[0].forkId, namedAs: list[0].namedAs, simulated: !!(list[0].lastResult && list[0].lastResult.ok)}}))",
        value => value && value.count === 1,
        "Command strategy.fork.create"
    )
    await assertTileExpanded("counterfactual-lab", "Counterfactual lab create command", "Fork")
    await dispatchCommand("strategy.fork.simulate4")
    const forkAfterSim = await waitForContextValue(
        "window.AesStrategyForkStore.list().then(list => ({count: list.length, first: list[0] && {forkId: list[0].forkId, simulated: !!(list[0].lastResult && list[0].lastResult.ok), weeks: list[0].lastResult && list[0].lastResult.weeks && list[0].lastResult.weeks.length}}))",
        value => value && value.first && value.first.simulated && value.first.weeks === 4,
        "Command strategy.fork.simulate4"
    )
    await assertTileExpanded("counterfactual-lab", "Counterfactual lab simulate command", "baseline")
    if (forkAfterCreate && forkAfterSim && forkAfterCreate.first && forkAfterSim.first
            && forkAfterCreate.first.forkId !== forkAfterSim.first.forkId) {
        failures.push("Fork simulate command updated a different fork")
    }

    await tile.getByRole("button", { name: /^Compose$/i }).click()
    await tile.getByRole("button", { name: /Open full modal/i }).waitFor()
    await tile.getByRole("button", { name: /Open full modal/i }).click()
    await page.waitForSelector("text=Strategy preview")

    const panelOverlay = page.locator("body > div[style*='position: fixed'], body > div[style*='position:fixed']")
        .filter({hasText: "Strategy preview"})
        .last()

    const panelText = (await panelOverlay.innerText()).toLowerCase()
    const requiredPanelText = ["New routes", "Alliance", "Slot bids", "Auto-seed on open", "ICN", "NRT", "SIN"]
    for (const text of requiredPanelText) {
        if (!panelText.includes(text.toLowerCase())) failures.push("panel missing text: " + text)
    }

    await panelOverlay.locator("[data-aes-strategy-menu='journal']").click()
    await page.waitForTimeout(300)
    const journalActive = await panelOverlay.locator("[data-aes-strategy-menu='journal'][data-active='1']").count()
    if (!journalActive) failures.push("Strategy panel section menu did not activate Journal")
    await panelOverlay.locator("[data-aes-strategy-menu='decisions']").click()
    await page.waitForTimeout(300)
    const decisionsActive = await panelOverlay.locator("[data-aes-strategy-menu='decisions'][data-active='1']").count()
    if (!decisionsActive) failures.push("Strategy panel section menu did not return to Decisions")

    await panelOverlay.locator("[data-aes-strategy-filter='price']").click()
    await page.waitForTimeout(300)
    const chipPricingDomain = await panelOverlay.locator("[data-aes-strategy-domain-filter='1']").inputValue()
    if (chipPricingDomain !== "price") failures.push("Pricing summary chip did not select price domain: " + chipPricingDomain)
    const pricingChipActive = await panelOverlay.locator("[data-aes-strategy-filter='price'][data-active='1']").count()
    if (!pricingChipActive) failures.push("Pricing summary chip did not mark active")
    await panelOverlay.locator("[data-aes-strategy-clear-filters='1']").click()
    await page.waitForTimeout(300)
    const chipClearedDomain = await panelOverlay.locator("[data-aes-strategy-domain-filter='1']").inputValue()
    if (chipClearedDomain !== "all") failures.push("Clear filters did not reset pricing domain: " + chipClearedDomain)

    await panelOverlay.locator("[data-aes-strategy-filter='slotBid']").click()
    await page.waitForTimeout(300)
    const chipSlotDomain = await panelOverlay.locator("[data-aes-strategy-domain-filter='1']").inputValue()
    if (chipSlotDomain !== "slotBid") failures.push("Slot-bid summary chip did not select slotBid domain: " + chipSlotDomain)
    const slotChipText = (await panelOverlay.innerText()).toLowerCase()
    if (!slotChipText.includes("nrt · score")) failures.push("Slot-bid summary chip did not show slot decision")
    await panelOverlay.locator("[data-aes-strategy-clear-filters='1']").click()
    await page.waitForTimeout(300)

    await panelOverlay.getByRole("button", { name: /Refresh/i }).click()
    await page.waitForTimeout(800)
    await panelOverlay.locator("select").first().selectOption("apply-on-confirm")
    await page.waitForTimeout(500)

    await panelOverlay.getByRole("checkbox", {name: "Pricing", exact: true}).check()
    await panelOverlay.getByRole("checkbox", {name: "New routes", exact: true}).check()
    await panelOverlay.getByRole("checkbox", {name: "Alliance", exact: true}).check()
    await panelOverlay.getByRole("checkbox", {name: "Slot bids", exact: true}).check()
    await panelOverlay.getByRole("checkbox", {name: "Auto-seed on open", exact: true}).uncheck()
    await page.waitForTimeout(300)
    await panelOverlay.getByRole("checkbox", {name: "Auto-seed on open", exact: true}).check()

    const search = panelOverlay.locator("input[type='search']").first()
    await search.fill("Cargo")
    await page.waitForTimeout(300)
    const cargoFiltered = (await panelOverlay.innerText()).toLowerCase()
    if (!cargoFiltered.includes("cargo")) failures.push("Cargo search did not show cargo decision")
    await search.fill("")
    const slotFilteredBeforeApply = (await panelOverlay.innerText()).toLowerCase()
    if (!slotFilteredBeforeApply.includes("nrt · score")) failures.push("Slot bid decision did not render in Strategy panel")

    await panelOverlay.getByRole("checkbox", {name: "Applicable only", exact: true}).check()
    await panelOverlay.getByRole("checkbox", {name: "Applicable only", exact: true}).uncheck()
    const sortSelect = panelOverlay.locator("label").filter({hasText: "Sort"}).locator("select")
    await sortSelect.selectOption("impact")
    await sortSelect.selectOption("hub")
    await sortSelect.selectOption("order")

    await panelOverlay.getByRole("button", { name: /Select all applicable/i }).click()
    await panelOverlay.getByRole("checkbox", {name: "Selected only", exact: true}).check()
    await panelOverlay.getByRole("checkbox", {name: "Selected only", exact: true}).uncheck()
    await panelOverlay.getByRole("button", { name: /Clear visible/i }).click()

    const cargoRow = panelOverlay.locator("label").filter({hasText: "Cargo 100%"}).first()
    page.once("dialog", dialog => dialog.accept("105"))
    await cargoRow.getByRole("button", { name: /Pin @/i }).click()
    await page.waitForTimeout(800)
    const pin = await evalInContext(client, aesCtx,
        "window.RouteAssistantRouteOverridesStore.get('ICN','NRT').then(r => r && r.pricePin)")
    if (Math.abs(Number(pin) - 105) > 0.001) failures.push("price pin did not persist through Strategy row")

    await panelOverlay.getByRole("button", { name: /Open alliance page/i }).click()
    await page.waitForTimeout(300)

    await panelOverlay.getByRole("button", { name: /Send IL request/i }).click()
    await page.waitForTimeout(800)

    await cargoRow.locator("input[type='checkbox']").check()
    await panelOverlay.locator("label").filter({hasText: "Open new route ICN"}).locator("input[type='checkbox']").check()
    await panelOverlay.locator("label").filter({hasText: "Send IL request"}).locator("input[type='checkbox']").check()
    await panelOverlay.locator("label").filter({hasText: "NRT · score"}).locator("input[type='checkbox']").check()
    await panelOverlay.getByRole("button", { name: /Apply 4 selected/i }).click()
    await page.waitForSelector("text=Confirm apply")
    await page.locator("input[placeholder*='APPLY']").fill("APPLY")
    await page.getByRole("button", { name: /Confirm apply/i }).click()
    await page.waitForTimeout(1500)

    const flow = await evalInContext(client, aesCtx, "(() => window.__aesStrategyPanelFlow)()")
    if (!flow.applyDecision.length) failures.push("Send IL request did not call applyDecision")
    if (!flow.pricing.length) failures.push("bulk apply did not call pricing applier")
    if (flow.pricing[0] && Math.abs(Number(flow.pricing[0].prices.Cargo) - 0.89) > 0.001) {
        failures.push("strategy bulk apply cargo price was " + JSON.stringify(flow.pricing[0].prices))
    }
    if (!flow.routeCreation.length) failures.push("bulk apply did not call route creation applier")
    if (!flow.alliance.length) failures.push("bulk apply did not call alliance applier")
    if (!flow.slotBids.length) failures.push("bulk apply did not call slot bidder")
    if (!flow.openedUrls.some(url => url.includes("/app/alliance"))) {
        failures.push("Open alliance page did not request /app/alliance")
    }
    if (!flow.seedCalls) failures.push("Refresh/open path did not exercise store readiness seed path")

    const buttonTexts = await panelOverlay.locator("button").evaluateAll(buttons =>
        buttons.map(b => (b.innerText || b.textContent || b.title || "").trim()).filter(Boolean)
    ).catch(() => [])

    const realErrors = errors.filter(e =>
        !/ResizeObserver loop/.test(e)
        && !/anchor not found/i.test(e)
    )
    if (realErrors.length) failures.push("page/console errors: " + realErrors.join(" | "))

    return {fakeDecisions, flow, buttonTexts, errors, failures}
}

async function expectCount(locator, label) {
    const count = await locator.count().catch(() => 0)
    if (!count) throw new Error("Missing " + label)
}

const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: false,
    viewport: { width: 1500, height: 1000 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--remote-debugging-port=${port}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch"
    ]
})

try {
    const ext = await ensureLoadedFromExtensionsTab(context)
    const extSummary = {
        id: ext.id,
        state: ext.state,
        location: ext.location,
        path: ext.path,
        manifestErrors: ext.manifestErrors && ext.manifestErrors.length,
        installWarnings: ext.installWarnings && ext.installWarnings.length
    }
    console.log("EXTENSION", JSON.stringify(extSummary, null, 2))
    const flow = await runFlow(context, ext)
    console.log("STRATEGY_FLOW", JSON.stringify(flow, null, 2))
    if (flow.failures.length) {
        throw new Error(flow.failures.join("; "))
    }
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}
