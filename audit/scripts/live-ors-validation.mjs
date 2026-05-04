import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import path from "node:path"

const require = createRequire("/tmp/aes-pw/package.json")
const { chromium } = require("@playwright/test")

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const profileDir = process.env.AES_ORS_PROFILE || "/tmp/aes-ors-playwright"
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = creds.server || "free1.airlinesim.aero"
const enterpriseId = process.env.AES_TEST_ENTERPRISE_ID || "775"
const hub = (process.env.AES_ORS_HUB || "LHR").toUpperCase()
const dest = (process.env.AES_ORS_DEST || "CDG").toUpperCase()

const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1440, height: 1000 },
    args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check",
    ],
})

const consoleEvents = []
const pageErrors = []

try {
    const page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(60000)
    page.on("console", msg => {
        const text = msg.text()
        consoleEvents.push({type: msg.type(), text})
    })
    page.on("pageerror", err => {
        pageErrors.push((err && err.message) || String(err))
    })

    await loginIfNeeded(page)
    await page.goto(`https://${serverHost}/app/enterprise/dashboard?select=${encodeURIComponent(enterpriseId)}`, {
        waitUntil: "domcontentloaded",
    })
    await page.waitForLoadState("networkidle").catch(() => {})

    await page.goto(`https://${serverHost}/app/com/scheduling/${hub}${dest}`, {
        waitUntil: "domcontentloaded",
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector("#aes-route-assistant", {timeout: 45000})

    const client = await context.newCDPSession(page)
    const ctxId = await findAesIsolatedContext(client)
    if (!ctxId) throw new Error("Could not find AES isolated execution context")

    const beforeDom = await page.evaluate(() => {
        const root = document.querySelector("#aes-route-assistant")
        const panel = window.RouteAssistantPanel && window.RouteAssistantPanel._currentInstance
        return {
            url: location.href,
            panelHub: panel && panel.hubIata || null,
            panelRows: panel && panel.rows ? panel.rows.length : null,
            rootText: root ? root.innerText.slice(0, 2000) : "",
            buttons: Array.from(document.querySelectorAll("#aes-route-assistant button"))
                .map(b => ({text: (b.innerText || b.textContent || "").trim(), disabled: b.disabled}))
                .filter(b => /ORS|Sync|route|rank|repair|market|demand/i.test(b.text))
        }
    })

    const validation = await evalInContext(client, ctxId, liveValidationExpression({hub, dest}))

    const settingsDom = await page.evaluate(async () => {
        const btns = Array.from(document.querySelectorAll("#aes-route-assistant button"))
        const gear = btns.find(b => ((b.innerText || b.textContent || "").trim() === "⚙"))
            || btns.find(b => /Score weights|filters|settings/i.test(b.title || ""))
        if (gear) {
            gear.click()
            await new Promise(resolve => setTimeout(resolve, 300))
        }
        const root = document.querySelector("#aes-route-assistant")
        const text = root ? root.innerText : ""
        const labels = Array.from(document.querySelectorAll("#aes-route-assistant label"))
            .map(el => (el.innerText || el.textContent || "").trim())
            .filter(Boolean)
        const buttons = Array.from(document.querySelectorAll("#aes-route-assistant button"))
            .map(b => ({
                text: (b.innerText || b.textContent || "").trim(),
                title: b.title || "",
                disabled: b.disabled
            }))
        const orsButtons = buttons.filter(b => /ORS|rank|route data|repair/i.test(b.text + " " + b.title))
        const hasPlaystyleSelect = Array.from(document.querySelectorAll("#aes-route-assistant select option"))
            .some(o => o.value === "adaptive" || o.value === "competitive" || o.value === "premium")
        return {
            ok: /ORS Rank/.test(text),
            usedGearButton: !!gear,
            rootHasLhr: /\bHub\s+LHR\b/.test(text),
            hasCargoClassToggle: labels.some(l => /\bCargo\b/.test(l)),
            hasPlaystyleControl: /\bPlaystyle\b/i.test(text) || hasPlaystyleSelect,
            hasRouteSyncButton: orsButtons.some(b =>
                /Sync route data \+ ORS rank|Sync route pipeline/i.test(b.text)
            ),
            hasRepairButton: orsButtons.some(b => /repair ORS only/i.test(b.text)),
            orsButtons
        }
    })

    await page.evaluate(async () => {
        const panel = window.RouteAssistantPanel && window.RouteAssistantPanel._currentInstance
        if (panel && typeof panel.refresh === "function") {
            await panel.refresh()
        }
    }).catch(() => {})

    const afterDom = await page.evaluate((targetDest) => {
        const root = document.querySelector("#aes-route-assistant")
        const panel = window.RouteAssistantPanel && window.RouteAssistantPanel._currentInstance
        const headers = Array.from(document.querySelectorAll("#aes-route-assistant th"))
            .map(th => (th.innerText || th.textContent || "").trim())
            .filter(Boolean)
        const routeRow = panel && panel.rows
            ? panel.rows.find(r => String(r.destIata || r.dest || "").toUpperCase() === String(targetDest || "").toUpperCase())
            : null
        return {
            rootText: root ? root.innerText.slice(0, 2000) : "",
            panelHub: panel && panel.hubIata || null,
            panelRows: panel && panel.rows ? panel.rows.length : null,
            hasCargoOrsColumn: headers.includes("Cg"),
            orsHeaders: headers.filter(h => ["ORS", "RkNS", "Gap", "OrsC#", "Y", "C", "F", "Cg"].includes(h)),
            routeRow: routeRow ? {
                dest: routeRow.destIata || routeRow.dest,
                hasByClassCargo: !!(routeRow.orsByClass && routeRow.orsByClass.CARGO),
                orsClassCargo: routeRow.orsClassCargo == null ? null : routeRow.orsClassCargo,
                orsWarnings: routeRow.orsWarnings || []
            } : null
        }
    }, dest)

    const errors = consoleEvents.filter(e =>
        e.type === "error"
        || /\b(error|exception|failed)\b/i.test(e.text) && /\[AES|RouteAssistant|ORS|ors/i.test(e.text)
    )
    const report = {
        route: `${hub}-${dest}`,
        beforeDom,
        validation,
        settingsDom,
        afterDom,
        console: {
            errors,
            aesOrs: consoleEvents
                .filter(e => /\[AES ors|routeSync|ORS/i.test(e.text))
                .slice(-50)
        },
        pageErrors
    }
    console.log(JSON.stringify(report, null, 2))
    if (errors.length || pageErrors.length) {
        throw new Error("Chrome validation captured errors")
    }
    if (!validation || validation.ok !== true) {
        throw new Error("Live ORS validation failed")
    }
    if (!settingsDom || settingsDom.ok !== true
            || settingsDom.hasCargoClassToggle !== true
            || settingsDom.hasPlaystyleControl !== true
            || settingsDom.hasRouteSyncButton !== true) {
        throw new Error("Live ORS settings UI validation failed")
    }
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}

async function loginIfNeeded(page) {
    await page.goto(`https://${serverHost}/app/enterprise/dashboard`, { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle").catch(() => {})
    if (!/\/auth\/login/.test(page.url()) && !/airlinesim\.aero\/auth\/login/.test(page.url())) {
        return
    }
    await page.goto("https://www.airlinesim.aero/auth/login", { waitUntil: "domcontentloaded" })
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']",
    ].join(", ")).first()
    await loginInput.fill(creds.email)
    await page.locator("input[type='password']").first().fill(creds.password)
    await Promise.all([
        page.waitForURL((url) => !/\/auth\/login/.test(url.pathname), { timeout: 60000 }),
        page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click(),
    ])
}

async function findAesIsolatedContext(client) {
    const contexts = []
    client.on("Runtime.executionContextCreated", ev => contexts.push(ev.context))
    await client.send("Runtime.enable")
    await new Promise(resolve => setTimeout(resolve, 1000))
    const isolated = contexts.filter(c => c && c.auxData && c.auxData.type === "isolated")
    for (const c of isolated) {
        const probe = await evalInContext(client, c.id,
            "!!(window.RouteAssistantOrsScraper && window.RouteAssistantRouteSync && window.RouteAssistantOrsIntelligence)")
            .catch(() => false)
        if (probe === true) return c.id
    }
    return null
}

async function evalInContext(client, contextId, expression) {
    const res = await client.send("Runtime.evaluate", {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
        timeout: 180000,
    })
    if (res.exceptionDetails) {
        const ex = res.exceptionDetails.exception || {}
        throw new Error(ex.description || res.exceptionDetails.text || "Runtime.evaluate failed")
    }
    return res.result && Object.prototype.hasOwnProperty.call(res.result, "value")
        ? res.result.value
        : null
}

function liveValidationExpression({hub, dest}) {
    return `(${async function liveValidate(input) {
        const hub = input.hub
        const dest = input.dest
        const classes = ["ECONOMY", "BUSINESS", "FIRST", "CARGO"]
        const required = [
            "RouteAssistantSettings",
            "RouteAssistantTypeSpecsStore",
            "RouteAssistantSchedulePageScraper",
            "RouteAssistantOrsScraper",
            "RouteAssistantRouteSync",
            "RouteAssistantOrsIntelligence",
            "RouteAssistantOrsModel",
            "RouteAssistantOrsCompetitionAdjuster",
            "RouteAssistantSilentAutoProposers",
            "RouteAssistantPerClassProposer",
            "RouteAssistantPricingApplier"
        ]
        const modules = {}
        for (const name of required) modules[name] = typeof window[name]
        modules.AESAircraftTypeSpecs = typeof AESAircraftTypeSpecs
        const missing = required.filter(name => modules[name] === "undefined")
        if (modules.AESAircraftTypeSpecs === "undefined") missing.push("AESAircraftTypeSpecs")
        if (missing.length) return {ok: false, stage: "modules", modules, missing}

        const settings = await RouteAssistantSettings.load()
        const server = AES.getServerName()
        const progress = []
        const sync = new RouteAssistantRouteSync(server, {})
        const result = await sync.syncRoute(hub, dest, {
            orsParams: {
                classesToScrape: classes,
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
                    primaryAircraftType: scheduleRec.primaryAircraftType || null
                } : null
            }),
            onStage: p => progress.push({
                stage: p.stage,
                route: p.route && (p.route.hub + "-" + p.route.dest),
                at: Date.now()
            })
        })

        const rec = await RouteAssistantOrsScraper.loadRecord(hub, dest)
        const schedule = await RouteAssistantSchedulePageScraper.loadRecord(hub, dest).catch(() => null)
        let typeSpec = null
        if (schedule && schedule.primaryAircraftTypeId) {
            const fetched = await AESAircraftTypeSpecs.fetchById(schedule.primaryAircraftTypeId)
            if (fetched) {
                const typeRecord = Object.assign({
                    typeId: schedule.primaryAircraftTypeId,
                    typeName: schedule.primaryAircraftType || ""
                }, fetched)
                await RouteAssistantTypeSpecsStore.save(typeRecord)
                const cached = await RouteAssistantTypeSpecsStore.get(schedule.primaryAircraftTypeId)
                if (cached) {
                    typeSpec = {
                        typeId: cached.typeId,
                        typeName: cached.typeName,
                        seats: cached.seats,
                        cargoCapacity: cached.cargoCapacity,
                        speed: cached.speed,
                        range: cached.range,
                        paxSatisfaction: cached.paxSatisfaction,
                        orsAttraction: cached.orsAttraction,
                        customerAttraction: cached.customerAttraction,
                        fetchedAt: cached.fetchedAt
                    }
                }
            }
        }
        const svc = new RouteAssistantOrsIntelligence(server, {settings: settings})
        const coverage = await svc.getCoverage([{hub, dest, weeklyFlights: schedule && schedule.weeklyFlights || 0}], {
            settings,
            classesToScrape: classes,
            staleMs: 24 * 60 * 60 * 1000,
            writeHealth: true
        })

        const byClass = rec && rec.byClass || {}
        const classSummary = {}
        for (const cls of classes) {
            const cr = byClass[cls]
            classSummary[cls] = cr ? {
                totalConnections: cr.totalConnections,
                rankAny: cr.rankAny,
                rankNonstop: cr.rankNonstop,
                rankBookable: cr.rankBookable,
                ourTopRating: cr.ourTopRating,
                topCompetitorRating: cr.topCompetitorRating,
                ratingGapToTop: cr.ratingGapToTop,
                matchedOwnLegs: cr.oursDetection && cr.oursDetection.matchedOwnLegs || 0
            } : null
        }

        const pricingProbe = {warm: null, verify: null, error: null}
        try {
            const applier = new RouteAssistantPricingApplier(server, {
                dryRunOnly: true,
                applyEnabled: false
            })
            pricingProbe.warm = await applier.warmCache(hub, dest)
            pricingProbe.verify = await applier._verify(hub, dest)
        } catch (e) {
            pricingProbe.error = e && e.message || String(e)
        }
        const livePrices = Object.assign({},
            pricingProbe.warm && pricingProbe.warm.prices || {},
            pricingProbe.verify || {})
        function firstFinite() {
            for (let i = 0; i < arguments.length; i++) {
                const n = Number(arguments[i])
                if (isFinite(n) && n > 0) return n
            }
            return null
        }
        const prices = {
            Y: firstFinite(livePrices.Y, schedule && schedule.ourPrice, 100),
            C: firstFinite(livePrices.C, schedule && schedule.ourPriceC, 250),
            F: firstFinite(livePrices.F, schedule && schedule.ourPriceF, 600),
            Cargo: firstFinite(livePrices.Cargo, schedule && schedule.ourCargoPrice, 0.8)
        }
        const model = RouteAssistantOrsModel.project({
            route: {
                hub,
                dest,
                currentFrequency: Number(schedule && schedule.weeklyFlights) || 1,
                ownPricing: {prices},
                orsByClass: byClass,
                spec: typeSpec,
                paxDemandPool: 1000,
                cargoDemandPool: 10000,
                paxElasticity: -1.2,
                cargoElasticity: -0.8
            },
            scenario: {
                priceMultipliers: {Y: 1, C: 1, F: 1},
                cargoMultiplier: 1
            },
            modelParams: Object.assign({}, settings.orsSandbox && settings.orsSandbox.modelParams || {}, {
                aircraftAttractionNeutral: settings.ors && settings.ors.aircraftAttractionNeutral,
                aircraftAttractionScale: settings.ors && settings.ors.aircraftAttractionScale,
                aircraftAttractionMaxBonus: settings.ors && settings.ors.aircraftAttractionMaxBonus
            }),
            economics: {}
        })

        const dryProposal = RouteAssistantSilentAutoProposers.dispatch(
            "per-class-elasticity",
            {
                hub,
                destIata: dest,
                paxDemandPool: 1000,
                cargoDemandPool: 10000,
                paxElasticity: -1.2,
                cargoElasticity: -0.8,
                rmTightnessByClass: {Y: 0.82, C: 0.70, F: 0.55, Cargo: 0.78},
                competitorCountsByClass: {Y: 0, C: 2, F: 4, Cargo: 5},
                competitorPricesByClass: {
                    Y: prices.Y * 1.08,
                    C: prices.C * 0.94,
                    F: prices.F * 1.05,
                    Cargo: prices.Cargo * 1.10
                }
            },
            prices,
            {
                silentAutoMinDeltaPct: 1,
                silentAutoMaxStepPct: 10,
                silentAutoPerClassEnabled: {Y: true, C: true, F: true, Cargo: true},
                silentAutoPerClassMinDemandPool: {Y: 1, C: 1, F: 1, Cargo: 1},
                orsCompetition: {
                    playstyle: "adaptive",
                    monopolyOrsMultiplier: 0.25,
                    competitiveOrsMultiplier: 1.5
                }
            },
            {hub}
        )

        const capturedClasses = classes.filter(cls => !!byClass[cls])
        const ok = !!(result && !result.halted && rec && capturedClasses.length === classes.length
            && (!schedule || !schedule.primaryAircraftTypeId || !!typeSpec)
            && coverage && coverage.coveredRoutes === 1
            && model && model.perClass && Object.prototype.hasOwnProperty.call(model.perClass, "CARGO")
            && dryProposal && dryProposal.ok === true)
        return {
            ok,
            modules,
            progress,
            sync: {
                halted: !!(result && result.halted),
                reason: result && result.reason || null,
                hasSchedule: !!(result && result.schedule),
                hasOrs: !!(result && result.ors)
            },
            schedule: schedule ? {
                weeklyFlights: schedule.weeklyFlights,
                flights: Array.isArray(schedule.flights) ? schedule.flights.length : null,
                primaryAircraftType: schedule.primaryAircraftType,
                primaryAircraftTypeId: schedule.primaryAircraftTypeId,
                scrapedAt: schedule.scrapedAt
            } : null,
            typeSpec,
            record: rec ? {
                hub: rec.hub,
                dest: rec.dest,
                server: rec.server || null,
                scrapedAt: rec.scrapedAt,
                classesScraped: rec.classesScraped,
                oursDetection: rec.oursDetection || null
            } : null,
            classSummary,
            coverage: coverage ? {
                totalRoutes: coverage.totalRoutes,
                coveredRoutes: coverage.coveredRoutes,
                usableRoutes: coverage.usableRoutes,
                missingClasses: coverage.missingClasses,
                warningRoutes: coverage.warningRoutes,
                nextAction: coverage.nextAction
            } : null,
            pricingProbe: {
                warm: pricingProbe.warm ? {
                    ok: pricingProbe.warm.ok,
                    source: pricingProbe.warm.source || null,
                    prices: pricingProbe.warm.prices || null,
                    error: pricingProbe.warm.error || null
                } : null,
                verify: pricingProbe.verify,
                error: pricingProbe.error
            },
            model: {
                notes: model && model.notes || [],
                hasCargoClass: !!(model && model.perClass && Object.prototype.hasOwnProperty.call(model.perClass, "CARGO")),
                cargoShare: model && model.perClass && model.perClass.CARGO ? model.perClass.CARGO.baselineShare : null,
                scaledCargo: model && model.scaledPrices ? model.scaledPrices.Cargo : null
            },
            dryProposal: dryProposal ? {
                ok: dryProposal.ok,
                prices: dryProposal.prices || null,
                reason: dryProposal.reason || dryProposal.skipReason || null,
                rationale: dryProposal.rationale || null
            } : null
        }
    }})(` + JSON.stringify({hub, dest}) + `)`
}
