import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const extensionPath = repoRoot
const profileDir = process.env.AES_CHROME_ORS_PROFILE || "/tmp/aes-cft-ors-flow"
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const chromeAppName = process.env.AES_CHROME_APP_NAME || "Google Chrome for Testing"

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function extensionInfo(page) {
    await page.goto("chrome://extensions/", {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
    await page.waitForTimeout(1000)
    return await page.evaluate(() => new Promise(resolve => {
        chrome.developerPrivate.getExtensionsInfo(
            {includeDisabled: true, includeTerminated: true},
            infos => resolve((infos || []).find(e => e.name === "AirlineSim Enhancement Suite") || null)
        )
    }))
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
    ], {encoding: "utf8", timeout: 5000})
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
    ].join("\n")], {encoding: "utf8", timeout: 15000})
}

async function ensureLoadedFromExtensionsTab(context) {
    const page = context.pages()[0] || await context.newPage()
    let info = await extensionInfo(page)
    if (!info) {
        await page.waitForTimeout(3000)
        info = await extensionInfo(page)
    }
    if (info && info.location === "UNPACKED" && info.path === extensionPath) {
        if (info.state !== "ENABLED") info = await enableExtension(page, info.id)
        if (!info || info.state !== "ENABLED") {
            throw new Error("AES unpacked extension exists but could not be enabled")
        }
        if (process.env.AES_RELOAD_EXTENSION === "1") {
            await page.evaluate(id => new Promise(resolve => {
                chrome.developerPrivate.reload(id, resolve)
            }), info.id).catch(() => {})
            await page.waitForTimeout(1500)
            info = await extensionInfo(page)
            if (info && info.state !== "ENABLED") info = await enableExtension(page, info.id)
            if (!info || info.state !== "ENABLED") {
                throw new Error("AES unpacked extension disabled after reload")
            }
        }
        return info
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
        chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, resolve)
    }))
    const loadPromise = page.evaluate(() => new Promise(resolve => {
        chrome.developerPrivate.loadUnpacked(info => resolve({
            info,
            lastError: chrome.runtime.lastError && chrome.runtime.lastError.message
        }))
    })).catch(err => ({evalError: String(err)}))

    await page.waitForTimeout(1200)
    chooseFolderWithAppleScript(extensionPath)
    const loadResult = await Promise.race([
        loadPromise,
        new Promise(resolve => setTimeout(() => resolve({timeout: true}), 15000))
    ])
    if (loadResult && (loadResult.timeout || loadResult.lastError || loadResult.evalError)) {
        throw new Error("Load unpacked failed: " + JSON.stringify(loadResult))
    }

    info = await extensionInfo(page)
    if (!info || info.state !== "ENABLED" || info.location !== "UNPACKED") {
        throw new Error("AES did not appear as an enabled unpacked extension")
    }
    return info
}

async function seedStorage(context, extId) {
    let worker = context.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${extId}/`))
    if (!worker) {
        worker = await context.waitForEvent("serviceworker", {
            predicate: w => w.url().startsWith(`chrome-extension://${extId}/`),
            timeout: 10000
        }).catch(() => null)
    }
    let extensionPage = null
    const target = worker || await (async () => {
        extensionPage = await context.newPage()
        await extensionPage.goto(`chrome-extension://${extId}/options.html`, {waitUntil: "domcontentloaded"})
            .catch(async () => {
                await extensionPage.goto(`chrome-extension://${extId}/popup.html`, {waitUntil: "domcontentloaded"})
            })
        return extensionPage
    })()
    const ts = Date.now()
    await target.evaluate(async items => {
        await chrome.storage.local.set(items)
    }, {
        settings: {
            routeAssistant: {
                ors: {
                    playstyle: "adaptive",
                    monopolyOrsMultiplier: 0.25,
                    competitiveOrsMultiplier: 1.5,
                    competitiveRivalFlights: 6,
                    classesToScrape: ["ECONOMY", "BUSINESS", "FIRST", "CARGO"],
                    showPerClassColumns: true,
                    aircraftAttractionNeutral: 50,
                    aircraftAttractionScale: 0.1,
                    aircraftAttractionMaxBonus: 2
                },
                pricing: {
                    silentAutoStrategy: "per-class-elasticity",
                    silentAutoMinDeltaPct: 1,
                    silentAutoMaxStepPct: 10,
                    silentAutoPerClassEnabled: {Y: true, C: true, F: true, Cargo: true},
                    silentAutoPerClassMinDemandPool: {Y: 1, C: 1, F: 1, Cargo: 1},
                    apply: {
                        enabled: true,
                        dryRunOnly: true,
                        classes: {
                            Y: {enabled: true},
                            C: {enabled: true},
                            F: {enabled: true},
                            Cargo: {enabled: true}
                        }
                    }
                },
                demandDepth: {useRealDemandForLF: true}
            }
        },
        "routeAssistant:markets:ownPricing:ICN-NRT": {
            hub: "ICN",
            dest: "NRT",
            scrapedAt: ts,
            prices: {Y: 100, C: 240, F: 620, Cargo: 0.85}
        }
    })
    if (extensionPage) await extensionPage.close()
}

function schedulingPage() {
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ICN-NRT Scheduling | AirlineSim</title></head>
<body>
  <div class="as-navbar-main"><a class="name" href="#"><span>Casper Flight Logistics</span><span class="caret"></span></a></div>
  <form class="scheduling"><select name="origin"><option selected>Seoul Incheon (ICN)</option></select></form>
  <div class="as-fieldset">
    <div class="legend">Flight Numbers</div>
    <table>
      <tbody>
        <tr>
          <td>CFL 101</td><td>08:00 HT</td><td>1234567</td>
          <td><a href="/app/fleets/aircraft/9001">HL-CFL</a> <a href="/action/enterprise/aircraftsType?id=320">Airbus A320-200</a></td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>`
}

function orsForm() {
    return `<!doctype html>
<html><body>
  <script id="wicket-ajax-base-url">Wicket.Ajax.baseUrl="info/ors?399";</script>
  <form id="id-ors" method="post" action="./ors?399-2.-form">
    <input type="hidden" name="csrf" value="mock-token">
  </form>
</body></html>`
}

function serviceLetter(payload) {
    if (payload === "BUSINESS") return "C"
    if (payload === "FIRST") return "F"
    if (payload === "CARGO") return "cargo"
    return "Y"
}

function classFromPost(postData) {
    const params = new URLSearchParams(postData || "")
    const payload = params.get("payload")
    if (payload === "radio1") return "BUSINESS"
    if (payload === "radio2") return "FIRST"
    if (payload === "radio3") return "CARGO"
    return "ECONOMY"
}

function connectionTbody({clsName, code, flightId, typeId, typeName, rating, price, service, bookable = true}) {
    return `<tbody class="${bookable ? "bookable" : "unbookable"}">
      <tr><th>Date</th><th>From</th><th>To</th><th>Flight</th><th>Aircraft</th><th>Price</th></tr>
      <tr>
        <td title="2026-05-03 08:00">Mon</td><td>ICN</td><td>NRT</td>
        <td><a href="/app/com/flight?id=${flightId}">${code}</a></td>
        <td><img title="rating ${rating}"> <a href="/action/enterprise/aircraftsType?id=${typeId}">${typeName}</a></td>
        <td><span>${price}</span><span>${service}</span><div class="good">available</div></td>
      </tr>
      <tr class="totals"><td colspan="3"></td><td class="duration">2:20</td><td class="rating"><img title="rating ${rating}"></td><td class="price">${price}</td></tr>
    </tbody>`
}

function orsResult(payload) {
    const service = serviceLetter(payload)
    const ownPrice = payload === "CARGO" ? 1 : payload === "FIRST" ? 620 : payload === "BUSINESS" ? 240 : 100
    const rivalPrice = payload === "CARGO" ? 1 : payload === "FIRST" ? 650 : payload === "BUSINESS" ? 260 : 130
    const ownRating = payload === "FIRST" ? 92 : payload === "BUSINESS" ? 84 : payload === "CARGO" ? 76 : 88
    const rivalRating = payload === "FIRST" ? 89 : payload === "BUSINESS" ? 86 : payload === "CARGO" ? 80 : 82
    return `<!doctype html>
<html><body>
  <div class="ors-result">
    <p>Found a total of 2 connections, displaying 2 at 30 per page.</p>
    <table>
      ${connectionTbody({clsName: "own", code: "CFL 101", flightId: 101, typeId: 320, typeName: "Airbus A320-200", rating: ownRating, price: ownPrice, service})}
      ${connectionTbody({clsName: "rival", code: "ANA 901", flightId: 901, typeId: 321, typeName: "Airbus A321neo", rating: rivalRating, price: rivalPrice, service})}
    </table>
    <div class="navigation"><a disabled="disabled">1</a></div>
  </div>
</body></html>`
}

function typeSpecPage() {
    return `<!doctype html>
<html><body>
  <table>
    <tr><th>Seats</th><td>180</td></tr>
    <tr><th>Cargo capacity</th><td>2,800 kg</td></tr>
    <tr><th>Cruise speed</th><td>840 km/h</td></tr>
    <tr><th>Range</th><td>6,100 km</td></tr>
    <tr><th>Customer ORS attraction</th><td>87</td></tr>
  </table>
</body></html>`
}

async function installMockAirlineSim(context) {
    await context.route("https://free1.airlinesim.aero/**", async route => {
        const req = route.request()
        const url = new URL(req.url())
        if (url.pathname === "/app/com/scheduling/ICNNRT") {
            await route.fulfill({status: 200, contentType: "text/html", body: schedulingPage()})
            return
        }
        if (url.pathname === "/app/info/ors" && req.method() === "GET") {
            await route.fulfill({status: 200, contentType: "text/html", body: orsForm()})
            return
        }
        if (url.pathname === "/app/info/ors" && req.method() === "POST") {
            await route.fulfill({status: 200, contentType: "text/html", body: orsResult(classFromPost(req.postData()))})
            return
        }
        if (url.pathname === "/action/enterprise/aircraftsType") {
            await route.fulfill({status: 200, contentType: "text/html", body: typeSpecPage()})
            return
        }
        await route.fulfill({status: 200, contentType: "text/html", body: "<!doctype html><body></body>"})
    })
}

async function findAesContext(client, contexts, timeoutMs = 30000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        for (const ctx of contexts.values()) {
            try {
                const result = await client.send("Runtime.evaluate", {
                    contextId: ctx.id,
                    expression: `(() => {
                        try {
                            return !!(window.RouteAssistantOrsScraper
                                && window.RouteAssistantRouteSync
                                && window.RouteAssistantOrsIntelligence
                                && window.RouteAssistantOrsCompetitionAdjuster
                                && window.RouteAssistantPerClassProposer
                                && typeof AESAircraftTypeSpecs !== "undefined")
                        } catch (_) { return false }
                    })()`,
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
        awaitPromise: true,
        timeout: 120000
    })
    if (result.exceptionDetails) {
        const ex = result.exceptionDetails.exception
        throw new Error((ex && (ex.description || ex.value)) || result.exceptionDetails.text || "CDP evaluation failed")
    }
    return result.result.value
}

function validationExpression() {
    return `(${async function validate() {
        const settings = await RouteAssistantSettings.load()
        settings.ors.playstyle = "adaptive"
        settings.ors.monopolyOrsMultiplier = 0.25
        settings.ors.competitiveOrsMultiplier = 1.5
        await RouteAssistantSettings.save({ors: settings.ors})

        const sync = new RouteAssistantRouteSync("free1", {})
        const stages = []
        const result = await sync.syncRoute("ICN", "NRT", {
            orsParams: {
                classesToScrape: ["ECONOMY", "BUSINESS", "FIRST", "CARGO"],
                departureH: 0,
                arrivalH: 24,
                useGround: false,
                carrierOverride: "CFL",
                pageStaggerMs: 0
            },
            contextBuilder: async ({scheduleRec}) => ({
                capturedAt: Date.now(),
                aircraft: {
                    typeId: scheduleRec && scheduleRec.primaryAircraftTypeId,
                    typeName: scheduleRec && scheduleRec.primaryAircraftType,
                    weeklyFlights: scheduleRec && scheduleRec.weeklyFlights
                }
            }),
            onStage: p => stages.push(p.stage)
        })

        const rec = await RouteAssistantOrsScraper.loadRecord("ICN", "NRT")
        const pricingIndex = rec && (rec.pricingIndex || RouteAssistantOrsScraper.buildPricingIndex(rec))
        const fetchedSpec = await AESAircraftTypeSpecs.fetchById(320)
        await RouteAssistantTypeSpecsStore.save(Object.assign({
            typeId: 320,
            typeName: "Airbus A320-200"
        }, fetchedSpec || {}))
        const cachedSpec = await RouteAssistantTypeSpecsStore.get(320)

        const byClass = rec && rec.byClass || {}
        const classes = ["ECONOMY", "BUSINESS", "FIRST", "CARGO"]
        const captured = classes.filter(cls => byClass[cls] && Array.isArray(byClass[cls].connections))
        const matched = classes.reduce((sum, cls) => {
            const det = byClass[cls] && byClass[cls].oursDetection
            return sum + (det && det.matchedOwnLegs || 0)
        }, 0)

        const svc = new RouteAssistantOrsIntelligence("free1", {settings})
        const composite = svc.getComposite({orsByClass: byClass}, settings)
        const model = RouteAssistantOrsModel.project({
            route: {
                hub: "ICN",
                dest: "NRT",
                currentFrequency: 7,
                ownPricing: {prices: {Y: 100, C: 240, F: 620, Cargo: 0.85}},
                orsByClass: byClass,
                spec: cachedSpec,
                distanceKm: 1200,
                paxDemandPool: 1200,
                cargoDemandPool: 9000,
                paxElasticity: -1.1,
                cargoElasticity: -0.7
            },
            scenario: {
                priceMultipliers: {Y: 1, C: 1, F: 1},
                cargoMultiplier: 1.1,
                comfortDelta: 1
            },
            modelParams: {
                aircraftAttractionNeutral: settings.ors.aircraftAttractionNeutral,
                aircraftAttractionScale: settings.ors.aircraftAttractionScale,
                aircraftAttractionMaxBonus: settings.ors.aircraftAttractionMaxBonus
            },
            economics: {}
        })

        const proposal = RouteAssistantSilentAutoProposers.dispatch(
            "per-class-elasticity",
            {
                hub: "ICN",
                destIata: "NRT",
                competitorYsCount: 0,
                competitorCountsByClass: {Y: 0, C: 2, F: 4, Cargo: 5},
                demandPoolByClass: {Y: 200, C: 30, F: 12, Cargo: 3000},
                priceElasticityByClass: {Y: -0.8, C: -0.8, F: -0.8, Cargo: -0.8},
                rmTightnessByClass: {Y: 0.92, C: 0.92, F: 0.92, Cargo: 0.92},
                competitorPricesByClass: {Y: 130, C: 260, F: 650, Cargo: 0.95}
            },
            {Y: 100, C: 240, F: 620, Cargo: 0.85},
            {
                silentAutoMinDeltaPct: 1,
                silentAutoMaxStepPct: 10,
                silentAutoPerClassEnabled: {Y: true, C: true, F: true, Cargo: true},
                silentAutoPerClassMinDemandPool: {Y: 1, C: 1, F: 1, Cargo: 1},
                orsCompetition: settings.ors
            },
            {hub: "ICN"}
        )

        const rationale = proposal && Array.isArray(proposal.rationale)
            ? proposal.rationale.join(" ")
            : ""
        return {
            ok: !!(result && !result.halted
                && rec && captured.length === 4
                && pricingIndex && pricingIndex.competitorPricesByClass
                && pricingIndex.competitorPricesByClass.Y === 130
                && pricingIndex.competitorCountsByClass.C === 1
                && matched >= 4
                && cachedSpec && cachedSpec.customerAttraction === 87
                && model && model.notes && model.notes.some(n => /aircraft ORS attraction/i.test(n))
                && model.scaledPrices && Math.abs(model.scaledPrices.Cargo - 0.935) < 1e-9
                && proposal && proposal.ok === true
                && /\[Y\].*monopoly/.test(rationale)
                && /\[C\].*competitive/.test(rationale)
                && /\[Cargo\].*saturated/.test(rationale)),
            stages,
            sync: {
                hasSchedule: !!(result && result.schedule),
                hasOrs: !!(result && result.ors),
                halted: !!(result && result.halted)
            },
            record: rec ? {
                classesScraped: rec.classesScraped,
                matchedOwnLegs: matched,
                contextAircraft: rec.context && rec.context.aircraft || null
            } : null,
            composite: composite ? {
                rankAny: composite.rankAny,
                ratingGapToTop: composite.ratingGapToTop,
                primaryValue: composite.primaryValue
            } : null,
            pricingIndex: pricingIndex ? {
                prices: pricingIndex.competitorPricesByClass,
                counts: pricingIndex.competitorCountsByClass
            } : null,
            typeSpec: cachedSpec ? {
                seats: cachedSpec.seats,
                cargoCapacity: cachedSpec.cargoCapacity,
                customerAttraction: cachedSpec.customerAttraction
            } : null,
            model: model ? {
                scaledCargo: model.scaledPrices && model.scaledPrices.Cargo,
                notes: model.notes
            } : null,
            proposal: proposal ? {
                ok: proposal.ok,
                prices: proposal.prices,
                rationale: proposal.rationale
            } : null
        }
    }})()`
}

const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromePath,
    viewport: {width: 1440, height: 1000},
    args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check"
    ]
})

const consoleEvents = []
const pageErrors = []

try {
    const info = await ensureLoadedFromExtensionsTab(context)
    await seedStorage(context, info.id)
    await installMockAirlineSim(context)

    const page = await context.newPage()
    page.setDefaultTimeout(45000)
    page.on("console", msg => consoleEvents.push({type: msg.type(), text: msg.text()}))
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    const client = await context.newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => {
        if (ev && ev.context) contexts.set(ev.context.id, ev.context)
    })
    client.on("Runtime.executionContextDestroyed", ev => contexts.delete(ev.executionContextId))
    await client.send("Runtime.enable")

    await page.goto("https://free1.airlinesim.aero/app/com/scheduling/ICNNRT", {waitUntil: "domcontentloaded"})
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector("#aes-route-assistant", {timeout: 30000}).catch(() => {})

    const ctxId = await findAesContext(client, contexts)
    const validation = await evalInContext(client, ctxId, validationExpression())
    const dom = await page.evaluate(() => {
        const root = document.querySelector("#aes-route-assistant")
        return {
            hasPanel: !!root,
            text: root ? root.innerText.slice(0, 800) : "",
            buttons: Array.from(document.querySelectorAll("#aes-route-assistant button"))
                .map(b => ((b.innerText || b.textContent || "").trim() || b.title || "").slice(0, 80))
                .filter(Boolean)
                .slice(0, 40)
        }
    })

    const errors = consoleEvents.filter(e =>
        e.type === "error"
        || (/\b(error|exception|failed)\b/i.test(e.text) && /\b(AES|ORS|RouteAssistant|ors)\b/i.test(e.text))
    )
    const report = {
        extension: {id: info.id, path: info.path, state: info.state, location: info.location},
        dom,
        validation,
        console: {
            errors,
            ors: consoleEvents.filter(e => /\b(AES ors|ORS|RouteAssistant)\b/i.test(e.text)).slice(-50)
        },
        pageErrors
    }
    console.log(JSON.stringify(report, null, 2))
    if (!validation || validation.ok !== true) throw new Error("Chrome ORS validation failed")
    if (errors.length || pageErrors.length) throw new Error("Chrome ORS flow captured errors")
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") await context.close()
}
