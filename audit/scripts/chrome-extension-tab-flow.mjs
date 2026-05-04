import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const extensionPath = repoRoot
const profileDir = process.env.AES_CHROME_TAB_PROFILE || "/tmp/aes-cft-extension-tab-load2"
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const chromeAppName = process.env.AES_CHROME_APP_NAME || "Google Chrome for Testing"
const port = process.env.AES_CHROME_TAB_PORT || "9290"

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function fleetPage() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Mock Fleet | Free1 | AirlineSim</title>
  <style>
    body { font-family: Arial, sans-serif; }
    .as-page-fleet-management { padding: 12px; }
    .as-panel { border: 1px solid #aaa; background: #fff; margin: 12px; padding: 8px; }
  </style>
</head>
<body>
  <div class="as-navbar-bottom"><span><i class="fa fa-clock-o"></i> 2026-05-02 19:00 HT</span></div>
  <div class="as-page-fleet-management">
    <h1>Casper Flight Logistics Fleet Management</h1>
    <div class="as-panel"><div class="as-table-well">Currently 1 aircrafts stored in memory.</div></div>
    <table>
      <tbody>
        <tr>
          <td><a href="/app/fleets/aircraft/999001/0">Mock A320</a></td>
          <td>D-CFLA</td>
          <td>Airbus A320-200</td>
          <td>ICN</td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>`
}

function inventoryForm(values) {
    const row = (label, current, field) =>
        `<tr><td>${label}</td><td>${current}</td><td><input type="text" name="${field}" value="${current}"></td><td></td><td><span>${current}</span></td></tr>`
    return `<!doctype html>
<html><body>
<form method="post" action="https://free1.airlinesim.aero/app/com/inventory/ICNNRT?1~panel-settings-settings~form">
  <input type="hidden" name="csrf" value="tok">
  <button name="submit-prices" type="submit">Apply</button>
  <fieldset><legend>Pricing</legend><table><tbody>
    ${row("Economy", values.Y, "classes:prices:0:newPrice")}
    ${row("Business", values.C, "classes:prices:1:newPrice")}
    ${row("First", values.F, "classes:prices:2:newPrice")}
    ${row("Cargo", values.Cargo, "classes:prices:3:newPrice")}
  </tbody></table></fieldset>
  <fieldset><legend>General Settings</legend>
    <select name="serviceProfile"><option selected value="svc-42">svc-42</option></select>
  </fieldset>
</form>
</body></html>`
}

async function extensionInfo(page) {
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded" })
        .catch(err => {
            if (!/ERR_ABORTED/.test(String(err))) throw err
        })
    await page.waitForTimeout(1000)
    return await page.evaluate(() => new Promise(resolve => {
        chrome.developerPrivate.getExtensionsInfo(
            { includeDisabled: true, includeTerminated: true },
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
    const data = {
        "canvas:state": {
            activeHub: "ICN",
            view: "waves",
            railMode: "advisor",
            railOpen: true,
            focusedAircraftId: "999001",
            focusedWaveId: null,
            advisorPrefs: { firstRunSeen: true, debouncedSuggestions: {} }
        },
        "free1CFLaircraftFleet": {
            server: "free1",
            type: "aircraftFleet",
            airline: "CFL",
            fleet: [{
                aircraftId: "999001",
                registration: "D-CFLA",
                equipment: "Airbus A320-200",
                typeId: "A320",
                location: "ICN",
                hub: "ICN",
                locIata: "ICN",
                age: 1
            }]
        },
        settings: {
            routeAssistant: {
                pricing: {
                    silentAutoEnabled: true,
                    silentAutoFollowMode: "all",
                    silentAutoMinDeltaPct: 1,
                    silentAutoMaxStepPct: 10,
                    silentAutoMaxPerDay: 50,
                    silentAutoMaxPerHour: 50,
                    apply: {
                        enabled: true,
                        dryRunOnly: true,
                        liveScopes: { manual: false, silentAuto: false },
                        cooldownMinPerRoute: 0,
                        cooldownMinGlobal: 0,
                        classes: {
                            Y: { enabled: true, maxMove: 10 },
                            C: { enabled: false, maxMove: 8 },
                            F: { enabled: true, maxMove: 6 },
                            Cargo: { enabled: true, maxMove: 2 }
                        },
                        defaultScope: {
                            airportPair: true,
                            flightNumbers: true,
                            returnAirportPair: false,
                            returnFlightNumbers: false
                        }
                    }
                }
            },
            aircraftFlightPlan: {
                autoScheduler: { enabled: true, tier: "preview-only" },
                dragSubmit: { dryRunOnly: true }
            }
        },
        "routeAssistant:topRoutes:ICN": {
            server: "free1",
            hub: "ICN",
            scrapedAt: ts,
            snapshotAt: ts,
            rows: [{
                hub: "ICN",
                destIata: "NRT",
                destName: "Tokyo Narita",
                score: 91,
                weeklyFlights: 21,
                flights: 21,
                paxDemandPool: 600,
                cargoDemandPool: 4000,
                paxElasticity: -1.4,
                cargoElasticity: -0.9,
                rmTightness: 0.92,
                competitorPricesByClass: { Y: 150, C: 260, F: 650, Cargo: 1.10 },
                demandPoolByClass: { Y: 600, C: 90, F: 30, Cargo: 4000 },
                rmTightnessByClass: { Y: 0.95, C: 0.8, F: 0.85, Cargo: 0.94 }
            }]
        },
        "routeAssistant:markets:ownPricing:ICN-NRT": {
            server: "free1",
            hub: "ICN",
            dest: "NRT",
            scrapedAt: ts,
            prices: { Y: 100, C: 220, F: 500, Cargo: 0.70 }
        }
    }
    await page.evaluate(async items => chrome.storage.local.set(items), data)
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

async function clickScheduleCanvasLauncher(page, errors) {
    const launcher = page.getByText(/Open Schedule Canvas/i)
    try {
        await launcher.click({timeout: 12000})
        return
    } catch (err) {
        const diag = await page.evaluate(() => ({
            url: location.href,
            readyState: document.readyState,
            hasFleetPage: !!document.querySelector(".as-page-fleet-management"),
            hasFleetScheduleGridHost: typeof window.FleetScheduleGridHost !== "undefined",
            hasFleetScheduleGridInstance: !!window.__aesFleetScheduleGridHost,
            hasCanvasModal: typeof window.CanvasModal !== "undefined",
            buttons: Array.from(document.querySelectorAll("button"))
                .map(b => (b.innerText || b.textContent || b.title || "").trim())
                .filter(Boolean)
                .slice(0, 40),
            bodyText: (document.body && (document.body.innerText || document.body.textContent) || "").slice(0, 1200)
        })).catch(evalErr => ({evalError: String(evalErr)}))
        throw new Error("Schedule Canvas launcher missing: " + JSON.stringify({
            diag,
            errors
        }) + "; " + err.message)
    }
}

async function runFlow(context, ext) {
    await seedStorage(context, ext.id)

    const page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(60000)
    const errors = []
    const posted = []
    page.on("pageerror", err => errors.push("pageerror: " + (err.stack || err.message || String(err))))
    page.on("console", msg => {
        if (msg.type() === "error" || msg.type() === "warning") {
            errors.push(msg.type() + ": " + msg.text())
        }
    })

    await page.route("https://free1.airlinesim.aero/app/fleets**", route => {
        route.fulfill({ status: 200, contentType: "text/html", body: fleetPage() })
    })
    await page.route("https://free1.airlinesim.aero/app/com/inventory/ICNNRT**", async route => {
        if (route.request().method() === "POST") posted.push(route.request().postData() || "")
        await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: inventoryForm({ Y: "100", C: "220", F: "500", Cargo: "0.70" })
        })
    })

    const client = await context.newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => contexts.set(ev.context.id, ev.context))
    client.on("Runtime.executionContextDestroyed", ev => contexts.delete(ev.executionContextId))
    await client.send("Runtime.enable")

    await page.goto("https://free1.airlinesim.aero/app/fleets?mock-canvas=1", {
        waitUntil: "domcontentloaded"
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await clickScheduleCanvasLauncher(page, errors)
    await page.waitForSelector(".aes-canvas-modal-overlay")
    await page.waitForTimeout(3000)

    const aesCtx = await findAesContext(client, contexts,
        "typeof window.CanvasRailController === 'function' && window.RouteAssistantSilentAutoProposers && typeof window.RouteAssistantSilentAutoProposers.surface === 'function'")

    await evalInContext(client, aesCtx, `(() => {
        window.__aesChromeFlow = {surface: [], apply: []}
        const sp = window.RouteAssistantSilentAutoProposers
        const origSurface = sp.surface
        sp.surface = function(strategy, route, prices, cfg, ctx) {
            const result = origSurface.apply(this, arguments)
            window.__aesChromeFlow.surface.push({
                strategy,
                routeDest: route && route.destIata,
                prices,
                cfg,
                ctx,
                result
            })
            return result
        }
        const Applier = window.RouteAssistantPricingApplier
        if (Applier && Applier.prototype) {
            Applier.prototype.apply = async function(hub, dest, prices, opts) {
                window.__aesChromeFlow.apply.push({hub, dest, prices, opts})
                return {ok: true, status: "dry-run", dryRun: true, skipped: false, prices, hub, dest}
            }
        }
        return true
    })()`)

    const advisorTab = page.getByRole("button", { name: /Advisor/i }).first()
    if (await advisorTab.count().catch(() => 0)) {
        await advisorTab.click().catch(() => {})
    }
    await page.getByRole("button", { name: /Run proposers now/i }).click()
    await page.waitForTimeout(2500)

    let seen = await evalInContext(client, aesCtx, "(() => window.__aesChromeFlow)()")
    const modalAfterRun = await page.locator(".aes-canvas-modal-overlay").innerText()
    const buttonsAfterRun = await page.locator(".aes-canvas-modal-overlay button")
        .evaluateAll(buttons => buttons.map((b, i) => ({
            i,
            text: (b.innerText || b.textContent || "").trim(),
            disabled: b.disabled,
            title: b.title || ""
        })))

    const action = page.getByRole("button", { name: /Apply price changes/i }).first()
    const hadAdvisorAction = !!(await action.count().catch(() => 0))
    if (hadAdvisorAction) {
        await action.click()
        await page.waitForTimeout(800)
    } else if (seen.surface[0] && seen.surface[0].result && seen.surface[0].result.ok) {
        await evalInContext(client, aesCtx, `(() => {
            window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_STAGED, {
                kind: "applyPricing",
                payload: {
                    hub: "ICN",
                    dest: "NRT",
                    prices: ${JSON.stringify({Y: 110, F: 530, Cargo: 0.71})},
                    source: "chrome-flow-fallback",
                    reason: "manual staged fallback after proposer surface"
                }
            })
            return true
        })()`)
        await page.waitForTimeout(800)
    }
    await page.locator(".aes-canvas-modal-overlay")
        .getByRole("button", { name: /^Apply$/i })
        .last()
        .click()
    await page.waitForTimeout(1200)
    seen = await evalInContext(client, aesCtx, "(() => window.__aesChromeFlow)()")

    const failures = []
    if (!seen.surface.length) failures.push("surface not called")
    if (seen.surface[0] && seen.surface[0].strategy !== "per-class-elasticity") {
        failures.push("strategy was " + seen.surface[0].strategy)
    }
    if (seen.surface[0]
            && !(seen.surface[0].cfg && seen.surface[0].cfg.applyClassGates
                && seen.surface[0].cfg.applyClassGates.C
                && seen.surface[0].cfg.applyClassGates.C.enabled === false)) {
        failures.push("C apply gate not threaded to proposer surface")
    }
    if (seen.surface[0]
            && !(seen.surface[0].cfg && seen.surface[0].cfg.applyClassGates
                && seen.surface[0].cfg.applyClassGates.Cargo
                && seen.surface[0].cfg.applyClassGates.Cargo.maxMove === 2)) {
        failures.push("Cargo maxMove not threaded to proposer surface")
    }
    if (!seen.apply.length) failures.push("pricing apply not called")
    if (seen.apply[0]
            && !(seen.apply[0].opts && seen.apply[0].opts.classGates
                && seen.apply[0].opts.classGates.C
                && seen.apply[0].opts.classGates.C.enabled === false)) {
        failures.push("C class gate not passed to applier")
    }
    if (seen.apply[0]
            && !(seen.apply[0].opts && seen.apply[0].opts.classGates
                && seen.apply[0].opts.classGates.Cargo
                && seen.apply[0].opts.classGates.Cargo.maxMove === 2)) {
        failures.push("Cargo class gate not passed to applier")
    }
    const realErrors = errors.filter(e => !/navbar anchor not found/.test(e))
    if (realErrors.length) failures.push("console/page errors: " + realErrors.join(" | "))

    return {
        seen,
        posted,
        hadAdvisorAction,
        modalAfterRun: modalAfterRun.slice(0, 5000),
        buttonsAfterRun,
        errors,
        failures
    }
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
    console.log("FLOW", JSON.stringify(flow, null, 2))
    if (flow.failures.length) {
        throw new Error(flow.failures.join("; "))
    }
} finally {
    if (process.env.AES_KEEP_BROWSER !== "1") {
        await context.close()
    }
}
