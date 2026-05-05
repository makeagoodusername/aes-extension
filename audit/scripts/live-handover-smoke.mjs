import { chromium } from "playwright"

const port = process.env.AES_LIVE_CHROME_PORT || "9347"
const server = process.env.AES_LIVE_SERVER || "free1.airlinesim.aero"
const modKey = process.platform === "darwin" ? "Meta" : "Control"
const repeat = /^(1|true|yes|forever)$/i.test(process.env.AES_LIVE_REPEAT || "")
const repeatCount = Number(process.env.AES_LIVE_REPEAT_COUNT || (repeat ? 0 : 1))
const repeatIntervalMs = Number(process.env.AES_LIVE_REPEAT_INTERVAL_MS || 60000)
const stopOnFail = /^(1|true|yes)$/i.test(process.env.AES_LIVE_STOP_ON_FAIL || "")
const compact = /^(1|true|yes)$/i.test(process.env.AES_LIVE_COMPACT || "")
const keepChromeOpen = /^(1|true|yes)$/i.test(process.env.AES_LIVE_KEEP_CHROME || "")
const enterpriseSelect = process.env.AES_LIVE_ENTERPRISE_SELECT || ""
const defaultDashboardTarget = enterpriseSelect
    ? `/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseSelect)}`
    : "/app/enterprise/dashboard"
const startTarget = process.env.AES_LIVE_START_URL
    || process.env.AES_LIVE_START_PATH
    || defaultDashboardTarget
const dashboardTarget = process.env.AES_LIVE_DASHBOARD_URL
    || process.env.AES_LIVE_DASHBOARD_PATH
    || (/\/app\/enterprise\/dashboard/i.test(startTarget) ? startTarget : defaultDashboardTarget)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const requiredDashboardTiles = [
    "conductor",
    "conductor-trust",
    "conductor-drift",
    "counterfactual-lab",
    "fleet-command",
    "fleet-optimizer",
    "data-flow-inspector"
]

const requiredDashboardGlobals = [
    "AesDataBus",
    "AesRelay",
    "AesCleanup",
    "CentralHubBus",
    "CentralHubTileRegistry",
    "AESCommandRegistry",
    "AESCommandPalette",
    "AesConductorTrustStore",
    "AesConductorDriftDriver",
    "AesStrategyForkStore",
    "AesStrategyForwardSimulator"
]

const routeChecks = [
    {
        label: "dashboard",
        path: dashboardTarget,
        selectors: [".aes-menu__trigger", "#aes-central-hub"],
        globals: requiredDashboardGlobals
    },
    {
        label: "accounting",
        path: "/app/finance/accounting",
        selectors: [".aes-menu__trigger"],
        globals: ["AccountingSnapshotStore", "AesDataBus"]
    },
    {
        label: "enterprise settings",
        path: "/app/enterprise/settings",
        selectors: [".aes-menu__trigger"],
        globals: ["AesUnifiedSettings", "AesSettings", "AesDataBus"]
    },
    {
        label: "fleets",
        path: "/app/fleets",
        selectors: [".aes-menu__trigger"],
        globals: ["AesFleetRoster", "AesFleetCommand", "AesStrategyPortfolio"]
    },
    {
        label: "scheduling",
        path: "/app/com/scheduling",
        selectors: [".aes-menu__trigger"],
        globals: [
            "RouteAssistantPanel",
            "RouteAssistantWavePalette",
            "RouteAssistantWaveFavoritesStore",
            "RouteAssistantWaveKeybindsStore",
            "AesDragArbiter"
        ]
    },
    {
        label: "flight numbers",
        path: "/app/com/numbers",
        selectors: [".aes-menu__trigger"],
        globals: ["AesPerLegAutopricer", "AesRelay"]
    },
    {
        label: "inventory sample",
        path: "/app/com/inventory/LHRJFK",
        selectors: [".aes-menu__trigger"],
        globals: ["CentralInventoryQuickPriceApplier"]
    }
]

async function runOnce(iteration, browser) {
    const startedAt = new Date().toISOString()
    const context = browser.contexts()[0]
    if (!context) throw new Error("No Chrome context found on port " + port)

    const errors = []
    context.on("page", attachPageListeners(errors))
    for (const page of context.pages()) attachPageListeners(errors)(page)

    const page = context.pages().find(p => /airlinesim\.aero/.test(p.url())) || await context.newPage()
    page.setDefaultTimeout(30000)

    const results = []
    for (const check of routeChecks) {
        results.push(await runRouteCheck(page, check))
    }

    const dashboard = await gotoLive(page, dashboardTarget)
    await waitForSelectors(dashboard, [".aes-menu__trigger", "#aes-central-hub"], "dashboard-final")
    results.push(await checkDashboardTilesAndCommands(dashboard))
    results.push(await checkDashboardTileBodies(dashboard))
    results.push(await checkUnifiedSettingsModal(dashboard))
    results.push(await checkCmdKAccounting(dashboard))
    await gotoLive(page, dashboardTarget)
    await waitForSelectors(page, [".aes-menu__trigger", "#aes-central-hub"], "dashboard-flows")
    results.push(await checkConductorAndForkFlows(page))

    const airportPath = await firstAirportPath(page).catch(() => null)
    if (airportPath) {
        results.push(await runRouteCheck(page, {
            label: "airport info",
            path: airportPath,
            selectors: [".aes-menu__trigger"],
            globals: ["AesCompetitorAirportHost", "AesCompetitorStore"]
        }))
    } else {
        results.push({label: "airport info", ok: true, warning: "No live airport info link found to sample"})
    }

    const aircraftPath = await firstAircraftPath(page).catch(() => null)
        || (process.env.AES_LIVE_AIRCRAFT_ID
            ? "/app/fleets/aircraft/" + encodeURIComponent(process.env.AES_LIVE_AIRCRAFT_ID) + "/0"
            : null)
    if (aircraftPath) {
        results.push(await runRouteCheck(page, {
            label: "aircraft flight plan",
            path: aircraftPath.replace(/\/1(?:[?#].*)?$/, "/0"),
            selectors: [".aes-menu__trigger"],
            globals: [
                "AesAfp",
                "AesAfpScheduleStore",
                "AesAfpFormDriver",
                "AesAfpScheduleApplyOrchestrator",
                "AesAfpMockScheduleBuilder"
            ]
        }))
        results.push(await runRouteCheck(page, {
            label: "aircraft flights",
            path: aircraftPath.replace(/\/0(?:[?#].*)?$/, "/1"),
            selectors: [".aes-menu__trigger"],
            globals: ["AesAfpMaintenanceStore", "AesAfpFlightLogStore", "AesAircraftFlightsScheduledDecorator"]
        }))
    } else {
        results.push({label: "aircraft pages", ok: false, warning: "No aircraft link discovered on live /app/fleets"})
    }

    const summary = {
        ok: results.every(r => r.ok || r.warning),
        iteration,
        startedAt,
        finishedAt: new Date().toISOString(),
        port,
        server,
        startTarget,
        dashboardTarget,
        url: page.url(),
        results,
        pageErrors: errors.filter(e => !isIgnorableError(e)).slice(0, 40)
    }
    summary.ok = summary.ok && summary.pageErrors.length === 0
    return summary
}

async function main() {
    let failures = 0
    let iteration = 0
    const forever = repeat && (!Number.isFinite(repeatCount) || repeatCount <= 0)
    const limit = repeat ? repeatCount : 1
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 60000})
    try {
        while (forever || iteration < limit) {
            iteration += 1
            let summary
            try {
                summary = await runOnce(iteration, browser)
            } catch (err) {
                summary = {
                    ok: false,
                    iteration,
                    startedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    port,
                    server,
                    error: err && (err.stack || err.message) || String(err)
                }
            }
            if (!summary.ok) failures += 1
            printSummary(summary)
            if (!repeat || (stopOnFail && !summary.ok)) break
            if (!forever && iteration >= limit) break
            await sleep(Math.max(1000, repeatIntervalMs))
        }
    } finally {
        if (!keepChromeOpen) await browser.close().catch(() => {})
    }
    process.exit(failures ? 1 : 0)
}

function printSummary(summary) {
    if (!compact) {
        console.log(JSON.stringify(summary, null, 2))
        return
    }
    const results = Array.isArray(summary.results) ? summary.results : []
    console.log(JSON.stringify({
        ok: summary.ok,
        iteration: summary.iteration,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        passed: results.filter(r => r.ok).length,
        warnings: results.filter(r => r.warning).length,
        failed: results.filter(r => !r.ok && !r.warning).map(r => r.label),
        pageErrors: Array.isArray(summary.pageErrors) ? summary.pageErrors.length : 0,
        error: summary.error || null
    }))
}

function attachPageListeners(errors) {
    return page => {
        if (page.__aesLiveSmokeListeners) return
        page.__aesLiveSmokeListeners = true
        page.on("pageerror", err => errors.push({url: page.url(), type: "pageerror", text: err && err.message || String(err)}))
        page.on("console", msg => {
            if (msg.type() === "error") errors.push({url: page.url(), type: "console.error", text: msg.text()})
        })
        page.on("requestfailed", req => {
            const failure = req.failure()
            const url = req.url()
            if (/airlinesim\.aero/.test(url)) {
                errors.push({url: page.url(), type: "requestfailed", text: req.method() + " " + url + " :: " + (failure && failure.errorText || "unknown")})
            }
        })
    }
}

function isIgnorableError(row) {
    const text = String(row && row.text || "")
    return /favicon|ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|net::ERR_FAILED.*sockjs/i.test(text)
        || /Failed to load resource: the server responded with a status of 404/i.test(text)
        || /Refused to execute script .*jquery\.checkboxes\.js.*MIME type/i.test(text)
}

async function gotoLive(page, path) {
    const url = /^https?:\/\//i.test(path) ? path : `https://${server}${path}`
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 45000})
    await page.waitForLoadState("networkidle", {timeout: 15000}).catch(() => {})
    return page
}

async function runRouteCheck(page, check) {
    await gotoLive(page, check.path)
    const selectorResult = await waitForSelectors(page, check.selectors || [], check.label)
    const boot = await evalInAesWorld(page, `(() => {
        const status = window.AesBoot && window.AesBoot.status ? window.AesBoot.status() : null
        return status ? {
            failed: (status.failed || []).map(r => ({id: r.id, reason: r.reason || r.error || ""})),
            skippedAnchors: status.skippedAnchors || []
        } : null
    })()`).catch(err => ({error: String(err && err.message || err)}))
    const globals = await globalsPresent(page, check.globals || [])
    return {
        label: check.label,
        ok: selectorResult.ok && globals.missing.length === 0 && !(boot && boot.failed && boot.failed.length),
        url: page.url(),
        selectors: selectorResult,
        globals,
        boot
    }
}

async function waitForSelectors(page, selectors, label) {
    const out = []
    for (const selector of selectors) {
        const hit = await page.locator(selector).first().waitFor({state: "visible", timeout: 12000})
            .then(() => true)
            .catch(() => false)
        out.push({selector, visible: hit})
    }
    return {label, ok: out.every(r => r.visible), rows: out}
}

async function globalsPresent(page, names) {
    if (!names.length) return {present: [], missing: []}
    const state = await evalInAesWorld(page, `(names => {
        const present = []
        const missing = []
        for (const name of names) {
            let exists = false
            try { exists = Function("return typeof " + name + " !== 'undefined'")() } catch (_) {}
            if (exists) present.push(name)
            else missing.push(name)
        }
        return {present, missing}
    })(${JSON.stringify(names)})`)
    return state
}

async function checkDashboardTilesAndCommands(page) {
    const result = await evalInAesWorld(page, `(requiredTiles => {
        const tileIds = window.CentralHubTileRegistry
            ? window.CentralHubTileRegistry.all().map(t => t.id).sort()
            : []
        const commandIds = window.AESCommandRegistry
            ? window.AESCommandRegistry.list({scope: "dashboard"}).map(c => c.id || c.title || c.label).sort()
            : []
        return {
            tileCount: tileIds.length,
            missingTiles: requiredTiles.filter(id => !tileIds.includes(id)),
            hasAccountingCommand: commandIds.some(id => /accounting/i.test(String(id))),
            hasForkCommand: commandIds.some(id => /fork/i.test(String(id))),
            commandCount: commandIds.length
        }
    })(${JSON.stringify(requiredDashboardTiles)})`)
    return {
        label: "dashboard tiles + command registry",
        ok: result.missingTiles.length === 0 && result.hasAccountingCommand && result.hasForkCommand,
        result
    }
}

async function checkDashboardTileBodies(page) {
    const result = await evalInAesWorld(page, `(async requiredTiles => {
        const shell = window.__aesCentralHub
        const rows = []
        if (!shell || !shell.tilesById) return {ok: false, reason: "hub shell missing", rows}
        for (const id of requiredTiles) {
            const tile = shell.tilesById.get(id)
            if (!tile) {
                rows.push({id, ok: false, reason: "tile object missing"})
                continue
            }
            const wasExpanded = !!tile.expanded
            try {
                tile.expanded = true
                if (tile.bodyEl) tile.bodyEl.style.display = "block"
                if (typeof tile._renderBodySafe === "function") await tile._renderBodySafe()
                const text = (tile.bodyEl && (tile.bodyEl.innerText || tile.bodyEl.textContent) || "")
                    .replace(/\\s+/g, " ").trim()
                const broken = /failed to load|\\[object Object\\]|\\bNaN\\b/i.test(text)
                rows.push({id, ok: !!tile.bodyEl && !broken, bodyChars: text.length, excerpt: text.slice(0, 180)})
            } finally {
                tile.expanded = wasExpanded
                if (tile.bodyEl) tile.bodyEl.style.display = wasExpanded ? "block" : "none"
            }
        }
        return {ok: rows.every(r => r.ok), rows}
    })(${JSON.stringify(requiredDashboardTiles)})`, 30000)
    return {
        label: "dashboard tile bodies render",
        ok: !!(result && result.ok),
        result
    }
}

async function checkUnifiedSettingsModal(page) {
    const result = await evalInAesWorld(page, `(async () => {
        const api = window.AesUnifiedSettings
        if (!api || typeof api.open !== "function") return {ok: false, reason: "AesUnifiedSettings.open missing"}
        api.open({moduleId: "strategy"})
        await new Promise(r => setTimeout(r, 250))
        const host = document.getElementById("aes-unified-settings")
        const visible = !!(host && host.getClientRects && host.getClientRects().length)
        if (api.close) api.close()
        return {ok: visible, modalPresent: !!host}
    })()`)
    return {
        label: "unified settings modal",
        ok: !!(result && result.ok),
        result
    }
}

async function checkCmdKAccounting(page) {
    await page.keyboard.press(`${modKey}+K`)
    const palette = page.locator("#aes-command-palette")
    const input = page.locator("#aes-command-palette-input")
    const opened = await palette.waitFor({state: "visible", timeout: 8000}).then(() => true).catch(() => false)
    if (!opened) return {label: "Cmd-K accounting dispatch", ok: false, reason: "palette did not open"}
    await input.fill("go to accounting")
    await page.keyboard.press("Enter")
    await page.waitForURL(url => /\/app\/finance\/accounting/.test(url.pathname), {timeout: 15000}).catch(() => {})
    const ok = /\/app\/finance\/accounting/.test(new URL(page.url()).pathname)
    return {label: "Cmd-K accounting dispatch", ok, url: page.url()}
}

async function checkConductorAndForkFlows(page) {
    const result = await evalInAesWorld(page, `(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms))
        const code = (AES.getAirlineCode && AES.getAirlineCode()) || {}
        const host = {server: AES.getServerName(), airline: code.code || ""}
        const scenarioId = "MaintenanceWatch"
        const smokePrefix = "codex-live-smoke-" + Date.now() + "-"
        const forkKey = window.AesAccountKey && window.AesAccountKey.acctKey
            ? window.AesAccountKey.acctKey("aesStrategy:forks")
            : "aesStrategy:forks"
        const trustKey = "aesConductor:trust:" + host.server + ":" + host.airline
        const seenKey = "aesConductor:trustSeen:" + host.server + ":" + host.airline
        const driftKey = "aesConductor:drift:" + host.server + ":" + host.airline
        const proposalKey = "aesConductor:driftProposals:" + host.server + ":" + host.airline
        const thresholdKey = "aesConductor:thresholds:" + host.server + ":" + host.airline
        const keys = [trustKey, seenKey, driftKey, proposalKey, thresholdKey, forkKey]
        const saved = await chrome.storage.local.get(keys)
        async function restore() {
            const present = {}
            const missing = []
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(saved, key)) present[key] = saved[key]
                else missing.push(key)
            }
            if (missing.length) await chrome.storage.local.remove(missing)
            if (Object.keys(present).length) await chrome.storage.local.set(present)
        }
        try {
            const trust = window.AesConductorTrustStore
            const drift = window.AesConductorDriftDriver
            const threshold = window.AesConductorThresholdStore
            const forkStore = window.AesStrategyForkStore
            const snapshotFork = window.AesStrategySnapshotFork
            const simulator = window.AesStrategyForwardSimulator
            const interventions = window.AesStrategyInterventionTypes
            if (!trust || !drift || !threshold || !forkStore || !snapshotFork || !simulator || !interventions) {
                return {ok: false, reason: "missing conductor/fork globals"}
            }
            if (!window.CentralHubBus) return {ok: false, reason: "CentralHubBus missing"}

            const events = {
                trustUpdated: 0,
                tierPromoted: 0,
                driftSignal: 0,
                proposalCreated: 0,
                thresholdApplied: 0,
                forkCreated: 0,
                forkSimulated: 0,
                forkPromoted: 0
            }
            const off = [
                CentralHubBus.on("data:conductor:trust:updated", () => events.trustUpdated++),
                CentralHubBus.on("signal:conductor:tier:promoted", () => events.tierPromoted++),
                CentralHubBus.on("signal:conductor:drift", () => events.driftSignal++),
                CentralHubBus.on("data:conductor:drift:proposal:created", () => events.proposalCreated++),
                CentralHubBus.on("data:conductor:threshold:applied", () => events.thresholdApplied++),
                CentralHubBus.on("data:strategy:fork:created", () => events.forkCreated++),
                CentralHubBus.on("data:strategy:fork:simulated", () => events.forkSimulated++),
                CentralHubBus.on("data:strategy:fork:promoted", () => events.forkPromoted++)
            ]

            const seedTrust = Object.assign({}, saved[trustKey] || {})
            delete seedTrust[scenarioId]
            const seedDrift = Object.assign({}, saved[driftKey] || {})
            delete seedDrift[scenarioId]
            const seedProposals = Array.isArray(saved[proposalKey])
                ? saved[proposalKey].filter(p => !p || p.scenarioId !== scenarioId)
                : []
            const seedThresholds = Object.assign({}, saved[thresholdKey] || {})
            for (const key of Object.keys(seedThresholds)) {
                if (key.indexOf(scenarioId + ".") === 0) delete seedThresholds[key]
            }
            await chrome.storage.local.set({
                [trustKey]: seedTrust,
                [driftKey]: seedDrift,
                [proposalKey]: seedProposals,
                [thresholdKey]: seedThresholds
            })

            for (let i = 0; i < 10; i++) {
                CentralHubBus.emit("conductor:outcome:applied", {
                    fireId: smokePrefix + "trust-" + i,
                    scenarioId,
                    outcome: {terminal: true, favourable: true}
                })
            }
            let trustEntry = null
            const trustDeadline = Date.now() + 8000
            while (Date.now() < trustDeadline) {
                trustEntry = await trust.get(host, scenarioId)
                if (trustEntry && trustEntry.n >= 10) break
                await sleep(250)
            }

            const beforeThresholds = await threshold.load(host)
            const dryRun = await threshold.apply(host, scenarioId, "RATIO_FLOOR", 99, {
                enabled: false,
                dryRun: true,
                source: "live-smoke"
            })
            const afterThresholds = await threshold.load(host)

            for (let i = 0; i < 35; i++) {
                await drift._onOutcomeApplied({
                    fireId: smokePrefix + "drift-" + i,
                    scenarioId,
                    outcome: {terminal: true, expectedDelta: 5, observedDelta: -2}
                })
            }
            const proposalBlob = await chrome.storage.local.get([proposalKey])
            const proposals = Array.isArray(proposalBlob[proposalKey]) ? proposalBlob[proposalKey] : []
            const driftProposal = proposals.find(p => p && p.scenarioId === scenarioId)
            const driftBlob = await chrome.storage.local.get([driftKey])
            const driftState = driftBlob[driftKey] && driftBlob[driftKey][scenarioId]

            const base = {
                ts: Date.now(),
                hubs: [{
                    iata: "JFK",
                    byRoute: [{
                        dest: "ORD",
                        destName: "Chicago O'Hare",
                        distanceKm: 1188,
                        paxScore: 8,
                        cargoScore: 6,
                        profitPerWeek: 420000,
                        weeklyFlights: 14,
                        competitor: {flightCount: 8, ourFlightCount: 2},
                        orsRank: 2
                    }, {
                        dest: "ALM",
                        destName: "Alamogordo",
                        distanceKm: 2900,
                        paxScore: 4,
                        cargoScore: 3,
                        profitPerWeek: 90000,
                        weeklyFlights: 4,
                        competitor: {flightCount: 1, ourFlightCount: 0},
                        orsRank: 6
                    }]
                }],
                fleet: [{
                    aircraftId: "SMOKE-1",
                    age: 1,
                    seats: 180,
                    wear: {ratio: 112, maxWeeklyBlockHours: 80, weeklyHoursLast7d: 42}
                }],
                serviceProfiles: [{classScore: {Y: 0.86, C: 0.73}}],
                cash: {weeklyResult: 250000, runwayWeeks: Infinity},
                settings: {strategy: {objective: {kind: "balanced"}}}
            }
            const fork = await forkStore.create(base, {namedAs: "live-smoke-fork"})
            const validation = interventions.validate({kind: "setWeight", name: "profitWeight", value: 0.5})
            const applied = snapshotFork.applyIntervention(fork, {kind: "setWeight", name: "profitWeight", value: 0.5})
            if (applied && applied.ok) await forkStore.update(applied.fork)
            const sim = await simulator.simulateForward(applied.fork || fork, {weeks: 4, force: true})
            const promotion = await forkStore.promote(fork.forkId, {promotionEnabled: false})
            for (const stop of off) {
                try { stop() } catch (_) {}
            }

            return {
                ok: trustEntry && trustEntry.n >= 10
                    && trustEntry.tq > 0.5
                    && dryRun.applied === false
                    && JSON.stringify(beforeThresholds) === JSON.stringify(afterThresholds)
                    && !!driftProposal
                    && driftState && driftState.drifted === true
                    && validation.ok === true
                    && applied.ok === true
                    && sim.ok === true
                    && sim.weeks && sim.weeks.length === 4
                    && promotion.ok === false,
                trust: {n: trustEntry.n, tq: trustEntry.tq, tier: trustEntry.tier, ceiling: trustEntry.ceiling},
                dryRun,
                drift: driftState && {drifted: driftState.drifted, polarity: driftState.polarity, window: driftState.window && driftState.window.length},
                driftProposal: driftProposal && {scenarioId: driftProposal.scenarioId, key: driftProposal.key, polarity: driftProposal.polarity},
                fork: {
                    created: !!fork,
                    validation,
                    applied: applied.ok,
                    simulated: sim.ok,
                    weeks: sim.weeks && sim.weeks.length,
                    scoredRoutes: sim.weeks && sim.weeks[0] && sim.weeks[0].scoredRoutes,
                    promoteReason: promotion.reason
                },
                events
            }
        } finally {
            await restore()
        }
    })()`, 45000)
    return {label: "Conductor trust/drift + counterfactual fork dry-run flows", ok: !!(result && result.ok), result}
}

async function firstAircraftPath(page) {
    await gotoLive(page, "/app/fleets")
    await page.waitForSelector("a[href*='/app/fleets/aircraft/']", {timeout: 15000})
    const href = await page.locator("a[href*='/app/fleets/aircraft/']").first().getAttribute("href")
    if (!href) return null
    return new URL(href, `https://${server}`).pathname
}

async function firstAirportPath(page) {
    for (const path of ["/app/com/scheduling", "/app/fleets"]) {
        await gotoLive(page, path)
        const href = await page.locator("a[href*='/app/info/airports/']").first()
            .getAttribute("href", {timeout: 5000})
            .catch(() => null)
        if (href) return new URL(href, `https://${server}`).pathname
    }
    const aircraftPath = await firstAircraftPath(page).catch(() => null)
    if (aircraftPath) {
        for (const tail of ["/0", "/1"]) {
            await gotoLive(page, aircraftPath.replace(/\/[01](?:[?#].*)?$/, tail))
            const href = await page.locator("a[href*='/app/info/airports/']").first()
                .getAttribute("href", {timeout: 5000})
                .catch(() => null)
            if (href) return new URL(href, `https://${server}`).pathname
        }
    }
    return null
}

async function evalInAesWorld(page, expression, timeoutMs = 20000) {
    const cdp = await page.context().newCDPSession(page)
    const contexts = []
    cdp.on("Runtime.executionContextCreated", evt => {
        if (evt && evt.context) contexts.push(evt.context)
    })
    try {
        await cdp.send("Runtime.enable")
        await sleep(450)
        const deadline = Date.now() + timeoutMs
        let lastError = null
        while (Date.now() < deadline) {
            const candidates = contexts.slice()
            let best = null
            for (const ctx of candidates) {
                const score = await cdp.send("Runtime.evaluate", {
                    contextId: ctx.id,
                    returnByValue: true,
                    expression: `(() => {
                        try {
                            const keys = ["AesBoot", "AesDataBus", "CentralHubBus", "AESCommandRegistry", "AesRelay", "AesAfp", "RouteAssistantPanel"]
                            return keys.filter(k => !!window[k]).length
                        } catch (_) { return 0 }
                    })()`
                }).then(r => r.result && r.result.value || 0).catch(err => {
                    lastError = err
                    return 0
                })
                if (!best || score > best.score) best = {ctx, score}
            }
            if (best && best.score > 0) {
                const result = await cdp.send("Runtime.evaluate", {
                    contextId: best.ctx.id,
                    expression,
                    awaitPromise: true,
                    returnByValue: true,
                    timeout: timeoutMs
                })
                if (result.exceptionDetails) {
                    throw new Error(result.exceptionDetails.text
                        || (result.exceptionDetails.exception && result.exceptionDetails.exception.description)
                        || "Runtime.evaluate failed")
                }
                return result.result.value
            }
            await sleep(250)
        }
        throw lastError || new Error("AES isolated world not found on " + page.url())
    } finally {
        await cdp.detach().catch(() => {})
    }
}

main().catch(err => {
    console.error(err && err.stack || err)
    process.exit(1)
})
