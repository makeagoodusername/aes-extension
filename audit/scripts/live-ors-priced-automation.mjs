import { chromium } from "playwright"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const profileDir = process.env.AES_ORS_PRICING_PROFILE
    || process.env.AES_REAL_PRICING_PROFILE
    || path.join(os.tmpdir(), "aes-chrome-pricing-real")
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normalizeServerHost(process.env.AES_REAL_SERVER || creds.server || "free1.airlinesim.aero")
const serverSlug = serverHost.replace(/\.airlinesim\.aero$/i, "")
const enterpriseId = process.env.AES_REAL_ENTERPRISE_ID || process.env.AES_TEST_ENTERPRISE_ID || "775"
const hub = (process.env.AES_ORS_HUB || process.env.AES_REAL_PRICE_HUB || "LHR").toUpperCase()
const dest = (process.env.AES_ORS_DEST || process.env.AES_REAL_PRICE_DEST || "CDG").toUpperCase()
const maxStepPct = numberEnv("AES_PRICE_MAX_STEP_PCT", 2)
const maxAllowedDeltaPct = numberEnv("AES_PRICE_MAX_ALLOWED_DELTA_PCT", maxStepPct + 0.5)

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function numberEnv(name, fallback) {
    const n = Number(process.env[name])
    return Number.isFinite(n) ? n : fallback
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
                    "RouteAssistantRouteSync",
                    "RouteAssistantOrsScraper",
                    "RouteAssistantOrsPriceIndex",
                    "RouteAssistantPricingApplier",
                    "RouteAssistantSettings",
                    "RouteAssistantSilentAutoProposers"
                ]
                return names.filter(name => !!window[name]).length
            })()`).catch(() => 0)
            if (score >= 6) return {client, contextId: ctx.id}
        }
        await sleep(500)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated pricing/ORS context not found")
}

async function evalInContext(client, contextId, expression) {
    const res = await client.send("Runtime.evaluate", {
        contextId,
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 300000
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

function liveAutomationExpression(input) {
    return `(${async function run(input) {
        const hub = input.hub
        const dest = input.dest
        const pair = hub + "-" + dest
        const server = input.serverSlug
        const maxStepPct = input.maxStepPct
        const maxAllowedDeltaPct = input.maxAllowedDeltaPct
        const required = [
            "AesRoutePriceAutomator",
            "RouteAssistantRouteSync",
            "RouteAssistantOrsScraper",
            "RouteAssistantOrsPriceIndex",
            "RouteAssistantPricingApplier",
            "RouteAssistantPricingApplyLog",
            "RouteAssistantSettings",
            "RouteAssistantSilentAutoProposers"
        ]
        const missing = required.filter(name => typeof window[name] === "undefined")
        if (missing.length) return {ok: false, stage: "modules", missing}

        const original = await RouteAssistantSettings.load()
        const progress = []
        const startedAt = Date.now()

        function pctDelta(prev, next) {
            const p = Number(prev)
            const n = Number(next)
            if (!isFinite(p) || !isFinite(n) || p <= 0) return null
            return ((n - p) / p) * 100
        }
        function priceObjectHasOnlySafeMoves(prev, next) {
            const deltas = {}
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                if (next[cls] == null) continue
                const d = pctDelta(prev && prev[cls], next[cls])
                deltas[cls] = d
                if (d == null || Math.abs(d) > maxAllowedDeltaPct + 1e-9) {
                    return {ok: false, reason: cls + " delta " + (d == null ? "null" : d.toFixed(2) + "%"), deltas}
                }
                if (Number(next[cls]) <= 0) {
                    return {ok: false, reason: cls + " proposed non-positive", deltas}
                }
            }
            return {ok: true, deltas}
        }
        function classSummaries(index) {
            const out = {}
            const classes = index && (index.classes || index.byClass) || {}
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const c = classes[cls] || null
                out[cls] = c ? {
                    competitorCount: c.competitorCount,
                    competitorMedian: c.competitorMedian || c.competitorMedianPrice || null,
                    rankAny: c.rankAny,
                    rankNonstop: c.rankNonstop,
                    rankBookable: c.rankBookable,
                    pressurePct: c.pressurePct || c.orsPressurePct || null
                } : null
            }
            return out
        }

        try {
            const sync = new RouteAssistantRouteSync(server, {})
            const syncResult = await sync.syncRoute(hub, dest, {
                orsParams: {
                    classesToScrape: ["ECONOMY", "BUSINESS", "FIRST", "CARGO"],
                    departureH: 0,
                    arrivalH: 24,
                    useGround: false,
                    pageStaggerMs: 1500,
                    pageRateLimitRetryMs: 10000
                },
                contextBuilder: async ({scheduleRec}) => ({
                    capturedAt: Date.now(),
                    aircraft: scheduleRec ? {
                        weeklyFlights: scheduleRec.weeklyFlights || null,
                        primaryAircraftType: scheduleRec.primaryAircraftType || null,
                        primaryAircraftTypeId: scheduleRec.primaryAircraftTypeId || null
                    } : null
                }),
                onStage: p => progress.push({
                    stage: p.stage,
                    route: p.route && (p.route.hub + "-" + p.route.dest),
                    at: Date.now()
                })
            })

            const applier = new RouteAssistantPricingApplier(server, {
                dryRunOnly: false,
                applyEnabled: true,
                liveScopes: {manual: true, bulk: true, silentAuto: true},
                cooldownMinPerRoute: 0,
                cooldownMinGlobal: 0,
                warnAboveDeltaPct: 1000,
                applyLog: new RouteAssistantPricingApplyLog({limit: 200, perRouteLimit: 20, dedupWindowMin: 0})
            })
            const warm = await applier.warmCache(hub, dest)
            const verifyBefore = await applier._verify(hub, dest)
            const currentPrices = Object.assign({}, verifyBefore || warm.prices || {})
            if (!Object.keys(currentPrices).length) {
                return {ok: false, stage: "warm-pricing", progress, syncResult, warm, verifyBefore}
            }

            const orsRecord = await RouteAssistantOrsScraper.loadRecord(hub, dest)
            const orsIndex = RouteAssistantOrsPriceIndex.indexRecord(orsRecord, {
                currentPrices,
                rankTarget: original && original.ors && original.ors.targetRank || 3
            }) || (orsRecord && orsRecord.pricingIndex) || null
            const classes = orsRecord && orsRecord.byClass || {}
            const classesScraped = Object.keys(classes)
            if (!orsRecord || classesScraped.length < 4 || !orsIndex) {
                return {
                    ok: false,
                    stage: "ors-index",
                    progress,
                    syncResult,
                    warm,
                    verifyBefore,
                    classesScraped,
                    hasOrsRecord: !!orsRecord,
                    hasOrsIndex: !!orsIndex
                }
            }

            const now = Date.now()
            const schedule = syncResult && syncResult.schedule || {}
            const weeklyFlights = Number(schedule.weeklyFlights) || 1
            const topRecord = {
                server,
                hub,
                scrapedAt: now,
                source: "codex-live-ors-priced-automation",
                rows: [{
                    hub,
                    destIata: dest,
                    destName: schedule.destName || schedule.destinationName || dest,
                    weeklyFlights,
                    flights: Array.isArray(schedule.flights) ? schedule.flights.length : weeklyFlights,
                    status: "live-ors-pricing",
                    paxScore: 990,
                    cargoScore: 990,
                    paxDemandPool: 1000,
                    cargoDemandPool: 10000,
                    demandPoolByClass: {Y: 1000, C: 300, F: 80, Cargo: 10000},
                    rmTightnessByClass: {Y: 0.82, C: 0.72, F: 0.68, Cargo: 0.78},
                    priceElasticityByClass: {Y: -1.2, C: -1.1, F: -1.0, Cargo: -0.8}
                }]
            }
            const writes = {}
            writes["routeAssistant:topRoutes:" + hub] = topRecord
            if (window.AesAccountKey && typeof window.AesAccountKey.acctKey === "function") {
                writes[window.AesAccountKey.acctKey("routeAssistant:topRoutes", hub)] = topRecord
            }
            await chrome.storage.local.set(writes)

            await AesRoutePriceAutomator.configureAutomaticLiveMode({
                followMode: "all",
                strategy: "per-class-elasticity",
                minDeltaPct: 1,
                maxStepPct,
                maxPerDay: 1,
                maxPerHour: 1,
                cooldowns: false
            })
            const configured = await RouteAssistantSettings.load()
            configured.pricing = configured.pricing || {}
            configured.pricing.silentAutoPerClassEnabled = {Y: true, C: true, F: true, Cargo: true}
            configured.pricing.silentAutoPerClassMinDemandPool = {Y: 1, C: 1, F: 1, Cargo: 1}
            configured.pricing.silentAutoPerClassMaxStepPct = {
                Y: maxStepPct,
                C: maxStepPct,
                F: maxStepPct,
                Cargo: maxStepPct
            }
            configured.pricing.apply = configured.pricing.apply || {}
            configured.pricing.apply.classes = {
                Y: {enabled: true, maxMove: maxStepPct},
                C: {enabled: true, maxMove: maxStepPct},
                F: {enabled: true, maxMove: maxStepPct},
                Cargo: {enabled: true, maxMove: maxStepPct}
            }
            configured.ors = Object.assign({}, configured.ors || {}, {
                playstyle: "adaptive",
                monopolyOrsMultiplier: 0.25,
                competitiveOrsMultiplier: 1.5
            })
            await RouteAssistantSettings.save({
                pricing: configured.pricing,
                ors: configured.ors
            })

            const preview = await AesRoutePriceAutomator.preview({server, airline: null}, {
                followMode: "all",
                limit: 1
            })
            const row = preview.rows.find(r => r.pair === pair) || preview.rows[0] || null
            const proposal = preview.proposals.find(p => p.pair === pair) || preview.proposals[0] || null
            if (!proposal) {
                return {
                    ok: false,
                    stage: "preview",
                    reason: "no proposal",
                    progress,
                    syncResult,
                    warm,
                    verifyBefore,
                    ors: {
                        classesScraped,
                        classSummaries: classSummaries(orsIndex)
                    },
                    preview: {
                        state: preview.state,
                        counts: preview.counts,
                        rows: preview.rows.slice(0, 5).map(r => ({
                            pair: r.pair,
                            stage: r.stage,
                            reason: r.reason,
                            prices: r.prices,
                            withOrs: !!r.orsPricingIndex,
                            competitorSourceByClass: r.competitorSourceByClass
                        }))
                    }
                }
            }
            if (proposal.pair !== pair) {
                return {ok: false, stage: "guard", reason: "proposal route mismatch " + proposal.pair, progress}
            }
            if (preview.state && preview.state.dryRun) {
                return {ok: false, stage: "guard", reason: "preview still dry-run", progress, state: preview.state}
            }
            if (!row || !row.orsPricingIndex) {
                return {ok: false, stage: "guard", reason: "proposal has no ORS pricing index", progress, row}
            }
            const guard = priceObjectHasOnlySafeMoves(proposal.prevPrices, proposal.prices)
            if (!guard.ok) {
                return {
                    ok: false,
                    stage: "guard",
                    reason: guard.reason,
                    progress,
                    currentPrices,
                    proposal: {
                        pair: proposal.pair,
                        prevPrices: proposal.prevPrices,
                        prices: proposal.prices,
                        reason: proposal.reason,
                        rationale: proposal.rationale
                    },
                    deltas: guard.deltas
                }
            }

            const tick = await AesRoutePriceAutomator.runTick({server, airline: null}, {
                source: "codex-live-ors-priced-automation",
                force: true,
                followMode: "all",
                maxRoutes: 1,
                limit: 1
            })
            const verifyAfter = await applier._verify(hub, dest)
            const appliedTrace = (tick.perRoute || []).find(r => r.pair === pair) || null
            const verifyMatches = RouteAssistantPricingApplier._verifyMatches(proposal.prices, verifyAfter)
            return {
                ok: !!(tick && tick.dryRun === false && tick.applied === 1 && verifyMatches),
                stage: "done",
                progress,
                sync: {
                    halted: !!(syncResult && syncResult.halted),
                    hasSchedule: !!(syncResult && syncResult.schedule),
                    hasOrs: !!(syncResult && syncResult.ors),
                    reason: syncResult && syncResult.reason || null
                },
                warm,
                currentPrices,
                ors: {
                    classesScraped,
                    classSummaries: classSummaries(orsIndex)
                },
                preview: {
                    state: preview.state,
                    counts: preview.counts,
                    proposal: {
                        pair: proposal.pair,
                        prevPrices: proposal.prevPrices,
                        prices: proposal.prices,
                        reason: proposal.reason,
                        rationale: proposal.rationale,
                        deltas: guard.deltas
                    },
                    row: row ? {
                        pair: row.pair,
                        stage: row.stage,
                        reason: row.reason,
                        competitorSourceByClass: row.competitorSourceByClass,
                        orsCompetitorCountsByClass: row.orsCompetitorCountsByClass,
                        orsCompetitorPricesByClass: row.orsCompetitorPricesByClass
                    } : null
                },
                tick,
                appliedTrace,
                verifyAfter,
                verifyMatches,
                durationMs: Date.now() - startedAt
            }
        } finally {
            await RouteAssistantSettings.save({
                pricing: original.pricing,
                ors: original.ors
            }).catch(() => {})
        }
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
    await page.goto(`https://${serverHost}/app/enterprise/dashboard?select=${encodeURIComponent(enterpriseId)}`, {
        waitUntil: "domcontentloaded"
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 45000})

    await page.goto(`https://${serverHost}/app/com/scheduling/${hub}${dest}`, {
        waitUntil: "domcontentloaded"
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector("#aes-route-assistant, .aes-menu__trigger", {timeout: 45000})

    const result = await evalInFreshAesContext(page, liveAutomationExpression({
        hub,
        dest,
        serverSlug,
        maxStepPct,
        maxAllowedDeltaPct
    }))

    const output = {
        server: serverHost,
        route: `${hub}-${dest}`,
        loggedIn,
        profileDir,
        result,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    console.log(JSON.stringify(output, null, 2))
    process.exitCode = result && result.ok === true && pageErrors.length === 0 ? 0 : 1
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}
