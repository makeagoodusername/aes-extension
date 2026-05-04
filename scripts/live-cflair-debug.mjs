import { chromium } from "playwright"
import fs from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const profileDir = process.env.AES_CFLAIR_PROFILE || path.join(os.tmpdir(), "aes-cflair-live-debug")
const reportPath = process.env.AES_CFLAIR_REPORT || path.join(repoRoot, "audit", "live-cflair-debug-report.json")
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const remotePort = process.env.AES_CFLAIR_PORT || "9327"
const attachPort = process.env.AES_CFLAIR_CDP_PORT || ""
const cookieSourcePort = process.env.AES_CFLAIR_COOKIE_SOURCE_PORT || ""
const sourceEnterpriseId = process.env.AES_CFLAIR_SOURCE_ENTERPRISE_ID || "770"
const targetEnterpriseId = process.env.AES_CFLAIR_ENTERPRISE_ID || "775"
const livePostEnabled = process.env.AES_CFLAIR_LIVE_POST !== "0"

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normalizeServerHost(process.env.AES_CFLAIR_SERVER || creds.server || "free1.airlinesim.aero")
const serverId = serverHost.replace(/\.airlinesim\.aero$/i, "")
const baseUrl = `https://${serverHost}`

const report = {
    startedAt: new Date().toISOString(),
    serverHost,
    profileDir,
    remotePort,
    attachPort: attachPort || null,
    cookieSourcePort: cookieSourcePort || null,
    sourceEnterpriseId,
    targetEnterpriseId,
    livePostEnabled,
    extension: {},
    login: {},
    probes: [],
    interactions: {},
    liveWrite: null,
    consoleEvents: [],
    failures: []
}

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function shortText(value, max = 500) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max)
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`))
        }, ms))
    ])
}

async function gotoSafe(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(1200)
}

async function loginIfNeeded(page) {
    await gotoSafe(page, `${baseUrl}/app/enterprise/dashboard`)
    const beforeUrl = page.url()
    const needsLogin = /\/auth\/login/i.test(beforeUrl)
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    report.login.startUrl = beforeUrl
    report.login.needsLogin = needsLogin
    if (!needsLogin) return

    await gotoSafe(page, "https://www.airlinesim.aero/auth/login")
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first()
    const passwordInput = page.locator("input[type='password']").first()
    await loginInput.fill(creds.email)
    await passwordInput.fill(creds.password)
    const form = page.locator("form").filter({has: page.locator("input[type='password']")}).first()
    const submit = form.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first()
    if (await submit.count().catch(() => 0)) await submit.click()
    else await passwordInput.press("Enter")
    await page.waitForLoadState("domcontentloaded").catch(() => {})
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(5000)
    report.login.afterSubmitUrl = page.url()
    if (/\/auth\/login/i.test(page.url())) {
        report.login.errorText = shortText(await page.locator("body").innerText().catch(() => ""))
        throw new Error("AS login did not leave auth/login; body=" + report.login.errorText)
    }
}

async function inspectLoadedExtension(context) {
    const workers = context.serviceWorkers()
        .filter(w => /^chrome-extension:\/\/[^/]+\/background\.js/i.test(w.url()))
        .map(w => ({url: w.url(), id: new URL(w.url()).hostname, source: "serviceworker"}))
    const out = {workers, extensions: [], activeAes: null}
    const page = await context.newPage().catch(() => null)
    if (!page) return out
    try {
        await page.goto("chrome://extensions/", {waitUntil: "domcontentloaded"}).catch(() => {})
        await page.waitForTimeout(800)
        out.extensions = await page.evaluate(() => new Promise(resolve => {
            if (typeof chrome === "undefined" || !chrome.developerPrivate) {
                resolve([])
                return
            }
            chrome.developerPrivate.getExtensionsInfo(
                {includeDisabled: true, includeTerminated: true},
                infos => resolve((infos || []).map(e => ({
                    id: e.id,
                    name: e.name,
                    state: e.state,
                    location: e.location,
                    path: e.path,
                    manifestErrors: e.manifestErrors && e.manifestErrors.length || 0,
                    installWarnings: e.installWarnings && e.installWarnings.length || 0
                })))
            )
        })).catch(() => [])
        out.activeAes = out.extensions.find(e =>
            e.name === "AirlineSim Enhancement Suite"
            && e.state === "ENABLED"
            && e.location === "UNPACKED"
            && e.path === extensionPath
        ) || null
    } finally {
        await page.close().catch(() => {})
    }
    return out
}

async function readCookiesFromCdpSource(port) {
    const endpoints = [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        `http://[::1]:${port}`
    ]
    let tabs = null
    let lastError = null
    for (const endpoint of endpoints) {
        try {
            tabs = await fetch(`${endpoint}/json/list`).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                return r.json()
            })
            if (Array.isArray(tabs)) break
        } catch (err) {
            lastError = err
            tabs = null
        }
    }
    if (!Array.isArray(tabs)) {
        throw new Error(`CDP list failed on port ${port}: ${lastError && lastError.message || "no endpoint reachable"}`)
    }
    const tab = tabs.find(t => t && t.type === "page" && /airlinesim\.aero/i.test(t.url || ""))
        || tabs.find(t => t && t.type === "page" && !String(t.url || "").startsWith("devtools://"))
    if (!tab || !tab.webSocketDebuggerUrl) {
        throw new Error(`No usable page target on CDP port ${port}`)
    }

    const ws = new WebSocket(tab.webSocketDebuggerUrl)
    let nextId = 0
    const pending = new Map()
    ws.addEventListener("message", evt => {
        let msg = null
        try { msg = JSON.parse(evt.data) } catch (_) {}
        if (!msg || !pending.has(msg.id)) return
        const slot = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) slot.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else slot.resolve(msg.result || {})
    })
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, {once: true})
        ws.addEventListener("error", reject, {once: true})
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, {resolve, reject})
        ws.send(JSON.stringify({id, method, params}))
    })
    try {
        await send("Network.enable").catch(() => {})
        const result = await send("Network.getAllCookies")
        const cookies = Array.isArray(result.cookies) ? result.cookies : []
        return cookies
            .filter(c => c && /airlinesim\.aero$/i.test(String(c.domain || "").replace(/^\./, "")))
            .map(c => {
                const cookie = {
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || "/",
                    httpOnly: !!c.httpOnly,
                    secure: !!c.secure,
                    sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax"
                }
                if (Number.isFinite(c.expires) && c.expires > 0) cookie.expires = c.expires
                return cookie
            })
    } finally {
        ws.close()
    }
}

async function activeAirline(page) {
    return await page.evaluate(() => {
        const candidates = [
            ".as-navbar-main .name",
            "#as-navbar-main-collapse .name",
            ".navbar .name",
            "a.name"
        ]
        const nav = candidates.map(s => document.querySelector(s)).find(Boolean)
        const navText = nav ? nav.textContent : ""
        const title = document.title || ""
        const activeText = (navText || title || "").replace(/\s+/g, " ").trim()
        const body = document.body ? document.body.innerText : ""
        const known = /CFLAIR/i.test(activeText) ? "CFLAIR"
            : /Casper Flight Logistics/i.test(activeText) ? "Casper Flight Logistics"
            : null
        return {
            navText: activeText,
            title,
            known,
            hasCflair: /CFLAIR/i.test(activeText),
            hasCasper: /Casper Flight Logistics/i.test(activeText),
            bodyHasCflair: /CFLAIR/i.test(body),
            bodyHasCasper: /Casper Flight Logistics/i.test(body)
        }
    })
}

async function switchToCflair(page) {
    await gotoSafe(page, `${baseUrl}/app/enterprise/dashboard?select=${encodeURIComponent(sourceEnterpriseId)}`)
    let before = await activeAirline(page)
    if (!before.hasCasper) {
        await page.waitForTimeout(2500)
        before = await activeAirline(page)
    }
    await gotoSafe(page, `${baseUrl}/app/enterprise/dashboard?select=${encodeURIComponent(targetEnterpriseId)}`)
    let after = await activeAirline(page)
    if (!after.hasCflair) {
        await page.waitForTimeout(2500)
        after = await activeAirline(page)
    }
    report.login.activeBeforeSwitch = before
    report.login.activeAfterSwitch = after
    report.login.switchUrl = page.url()
    if (!before.hasCasper) {
        throw new Error(`Casper source selection did not take; active=${JSON.stringify(before)}`)
    }
    if (!after.hasCflair) {
        throw new Error(`CFLAIR switch did not take; active=${JSON.stringify(after)}`)
    }
}

async function isoEval(page, expression) {
    const session = await page.context().newCDPSession(page)
    const contexts = []
    session.on("Runtime.executionContextCreated", evt => {
        if (evt && evt.context) contexts.push(evt.context)
    })
    await withTimeout(session.send("Runtime.enable"), 5000, "Runtime.enable").catch(async err => {
        await session.detach().catch(() => {})
        throw err
    })
    await page.waitForTimeout(600)
    const isolated = contexts.filter(ctx => {
        const aux = ctx.auxData || {}
        const origin = ctx.origin || ""
        const name = ctx.name || ""
        return aux.type === "isolated"
            && (origin.startsWith("chrome-extension://") || /AirlineSim Enhancement Suite/i.test(name))
    })
    let best = null
    let bestScore = -1
    for (const ctx of isolated) {
        const probe = await withTimeout(session.send("Runtime.evaluate", {
            contextId: ctx.id,
            expression: `(() => {
                const names = [
                  "AesSettings","AesDataBus","CentralHubBus","CentralHubTileRegistry",
                  "AESCommandRegistry","AESCommandPalette","AesCompetitorIntelHost",
                  "RouteAssistantPricingApplier","AesPerLegAutopricer","AesAfp",
                  "AesAfpFormDriver","AesAfpSubmitBridge","FleetScheduleGridHost"
                ];
                return names.reduce((n, k) => n + (typeof window[k] !== "undefined" ? 1 : 0), 0);
            })()`,
            returnByValue: true,
            awaitPromise: true
        }), 5000, "isolated context probe").catch(() => null)
        const score = probe && probe.result && probe.result.value
        if (Number(score) > bestScore) {
            bestScore = Number(score)
            best = ctx
        }
    }
    if (!best) {
        await session.detach().catch(() => {})
        return {error: "no isolated extension context", value: null}
    }
    const result = await withTimeout(session.send("Runtime.evaluate", {
        contextId: best.id,
        expression,
        returnByValue: true,
        awaitPromise: true
    }), 45000, "isolated extension evaluation").catch(err => ({exceptionDetails: {text: String(err)}}))
    await session.detach().catch(() => {})
    if (result.exceptionDetails) {
        return {ctx: best.id, score: bestScore, error: result.exceptionDetails.text || "exception", value: null}
    }
    return {ctx: best.id, score: bestScore, value: result.result && result.result.value}
}

async function probePage(page, label, pathName) {
    await gotoSafe(page, `${baseUrl}${pathName}`)
    const dom = await page.evaluate(() => {
        const q = s => document.querySelectorAll(s).length
        const h1 = document.querySelector("h1")
        const body = document.body ? document.body.innerText : ""
        return {
            url: location.href,
            title: document.title,
            h1: h1 ? h1.textContent.trim() : null,
            aesNodes: q("[id^='aes-'], [class*='aes-'], [data-aes], [data-tile-id]"),
            buttons: q("button, .btn, input[type='submit']"),
            forms: q("form"),
            menuTrigger: q(".aes-menu__trigger"),
            centralHub: q("#aes-central-hub"),
            commandPalette: q("#aes-command-palette"),
            routeAssistant: q("#aes-route-assistant"),
            fleetHubCells: q(".aes-fleet-hub-cell"),
            afpHost: q("[data-aes-afp-slot], .aes-afp-studio, .aes-afp-driver"),
            perLegChips: q(".aes-perleg-suggest, .aes-perleg-banner"),
            textHead: body.replace(/\s+/g, " ").trim().slice(0, 650)
        }
    })
    const iso = await isoEval(page, `(() => {
        const names = [
          "AesSettings","AesDataBus","CentralHubBus","CentralHubTileRegistry",
          "AESCommandRegistry","AESCommandPalette","AesCompetitorIntelHost",
          "AesRoutePriceAutomator","RouteAssistantPricingApplier","AesPerLegAutopricer",
          "AesAfp","AesAfpFormDriver","AesAfpSubmitBridge","AesAfpScheduleStore",
          "FleetScheduleGridHost","AesPricingCompass"
        ];
        const present = names.filter(k => typeof window[k] !== "undefined");
        let commandCount = null;
        try { commandCount = window.AESCommandRegistry && window.AESCommandRegistry.list().length; } catch (_) {}
        return {present, commandCount};
    })()`)
    const out = {label, requestedPath: pathName, dom, iso}
    report.probes.push(out)
    return out
}

function recordProbeFailure(probe) {
    if (!probe || !probe.dom) return
    const isoGlobals = probe.iso && probe.iso.value && Array.isArray(probe.iso.value.present)
        ? probe.iso.value.present.length
        : 0
    if (probe.dom.aesNodes <= 0 || isoGlobals <= 0) {
        report.failures.push({
            kind: "aes-not-injected",
            label: probe.label,
            url: probe.dom.url,
            aesNodes: probe.dom.aesNodes,
            isoGlobals,
            isoError: probe.iso && probe.iso.error || null
        })
    }
}

async function exerciseDashboard(page) {
    await gotoSafe(page, `${baseUrl}/app/enterprise/dashboard?select=${encodeURIComponent(targetEnterpriseId)}`)
    const state = {}
    const menuTrigger = page.locator(".aes-menu__trigger").first()
    state.menuTriggerCount = await page.locator(".aes-menu__trigger").count().catch(() => 0)
    if (state.menuTriggerCount) {
        await menuTrigger.click().catch(() => {})
        await page.waitForTimeout(500)
        state.menuItems = await page.locator(".aes-menu__panel button, .aes-menu__panel a, .aes-menu__item").count().catch(() => 0)
        state.menuText = shortText(await page.locator(".aes-menu__panel, .aes-menu").first().innerText().catch(() => ""))
        await page.keyboard.press("Escape").catch(() => {})
    }

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K").catch(() => {})
    await page.waitForTimeout(700)
    state.paletteAfterKeyboard = await page.locator("#aes-command-palette.open").count().catch(() => 0)
    if (!state.paletteAfterKeyboard) {
        state.paletteOpenEval = await isoEval(page, `(() => {
            if (!window.AESCommandPalette || typeof window.AESCommandPalette.open !== "function") return false;
            window.AESCommandPalette.open();
            return true;
        })()`)
        await page.waitForTimeout(700)
    }
    state.paletteOpen = await page.locator("#aes-command-palette.open").count().catch(() => 0)
    state.paletteRows = await page.locator("#aes-command-palette-list .row").count().catch(() => 0)
    state.paletteInputFocused = await page.evaluate(() => document.activeElement && document.activeElement.id === "aes-command-palette-input").catch(() => false)
    await page.keyboard.press("Escape").catch(() => {})

    state.competitorModal = await isoEval(page, `(async () => {
        if (!window.AesCompetitorIntelHost || typeof window.AesCompetitorIntelHost.open !== "function") return {ok:false, reason:"missing"};
        await window.AesCompetitorIntelHost.open({serverId:${JSON.stringify(serverId)}});
        return {
            ok: true,
            shell: !!window.AesCompetitorIntelShell,
            overlay: !!document.querySelector("#aes-competitor-intel-overlay")
        };
    })()`)
    await page.waitForTimeout(1200)
    state.competitorOverlayCount = await page.locator("#aes-competitor-intel-overlay, .aes-competitor-intel, [data-aes-competitor-intel], .aes-ci-shell").count().catch(() => 0)
    state.competitorText = shortText(await page.locator("body").innerText().catch(() => ""), 900)
    await page.keyboard.press("Escape").catch(() => {})

    report.interactions.dashboard = state
    return state
}

async function liveSamePricePost(page) {
    if (!livePostEnabled) {
        return {skipped: true, reason: "AES_CFLAIR_LIVE_POST=0"}
    }
    await gotoSafe(page, `${baseUrl}/app/com/numbers/9381/0`)
    await page.waitForTimeout(1800)
    const result = await isoEval(page, `(async () => {
        const per = window.AesPerLegAutopricer;
        const Ctor = window.RouteAssistantPricingApplier;
        if (!per || !Ctor) return {ok:false, error:"missing autopricer or pricing applier"};
        if (typeof per.run === "function") await per.run();
        const priceCtx = per._readCurrentPrices && per._readCurrentPrices();
        const route = per._routeFromForm && per._routeFromForm();
        const target = per._parseNumbersUrl && per._parseNumbersUrl(location);
        const server = per._serverFromLocation && per._serverFromLocation(location);
        if (!priceCtx || !route || !target || !target.flightNumberId || !server) {
            return {ok:false, error:"missing live context", hasPriceCtx:!!priceCtx, route, target, server};
        }
        const applier = new Ctor(server, {
            dryRunOnly: false,
            applyEnabled: true,
            liveScopes: {manual:true, bulk:true, silentAuto:true, bulkRecommended:true},
            cooldownMinPerRoute: 0,
            cooldownMinGlobal: 0,
            warnAboveDeltaPct: 99
        });
        const res = await applier.apply(route.hub, route.dest, priceCtx.prices, {
            endpoint: "flightNumbers",
            flightNumberId: target.flightNumberId,
            legIndex: target.legIndex || 0,
            source: "manual",
            dryRun: false,
            reason: "Codex live CFLAIR same-price verification",
            lastApplyAt: null,
            lastApplyAtGlobal: null,
            onPreflight: () => true
        });
        return {
            ok: true,
            route,
            target,
            requestedPrices: priceCtx.prices,
            status: res && res.status,
            dryRun: res && res.dryRun,
            applyGate: res && res.applyGate,
            prevPrices: res && res.prevPrices,
            newPrices: res && res.newPrices,
            verifiedPrices: res && res.verifiedPrices,
            error: res && res.error,
            httpStatus: res && res.httpStatus
        };
    })()`)
    return result
}

let browser = null
let context = null
let ownsBrowser = true
if (attachPort) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${attachPort}`, {timeout: 120000})
    context = browser.contexts()[0]
    ownsBrowser = false
    if (!context) throw new Error(`No browser context on CDP port ${attachPort}`)
} else {
    fs.mkdirSync(profileDir, {recursive: true})
    context = await chromium.launchPersistentContext(profileDir, {
        executablePath: fs.existsSync(chromePath) ? chromePath : chromium.executablePath(),
        headless: false,
        viewport: {width: 1440, height: 1000},
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            `--remote-debugging-port=${remotePort}`,
            "--remote-allow-origins=*",
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--disable-background-timer-throttling",
            "--no-first-run",
            "--no-default-browser-check"
        ]
    })
    if (cookieSourcePort) {
        const copiedCookies = await readCookiesFromCdpSource(cookieSourcePort)
        report.login.cookieSourcePort = cookieSourcePort
        report.login.copiedCookieCount = copiedCookies.length
        if (copiedCookies.length) await context.addCookies(copiedCookies)
    }
}

try {
    const page = context.pages().find(p => /free1\.airlinesim\.aero\/app\/enterprise\/dashboard/.test(p.url()))
        || context.pages().find(p => /airlinesim\.aero/.test(p.url()))
        || context.pages()[0]
        || await context.newPage()
    page.setDefaultTimeout(60000)
    page.on("pageerror", err => {
        report.consoleEvents.push({kind: "pageerror", text: (err && err.message) || String(err), url: page.url()})
    })
    page.on("console", msg => {
        if (!["error", "warning"].includes(msg.type())) return
        const text = msg.text()
        if (/Content Security Policy|report-only/i.test(text)) return
        report.consoleEvents.push({kind: "console", level: msg.type(), text, url: page.url()})
    })

    report.extension = await inspectLoadedExtension(context)

    if (attachPort) {
        report.login.attachedToExistingChrome = true
        report.login.startUrl = page.url()
        const needsLogin = /\/auth\/login/i.test(page.url())
            || await page.locator("input[type='password']").count().catch(() => 0) > 0
        report.login.needsLogin = needsLogin
        if (needsLogin) await loginIfNeeded(page)
    } else {
        await loginIfNeeded(page)
    }
    await switchToCflair(page)

    recordProbeFailure(await probePage(page, "dashboard", `/app/enterprise/dashboard?select=${targetEnterpriseId}`))
    await exerciseDashboard(page)
    recordProbeFailure(await probePage(page, "fleets", "/app/fleets"))
    recordProbeFailure(await probePage(page, "afp-aircraft-22094", "/app/fleets/aircraft/22094/0"))
    recordProbeFailure(await probePage(page, "scheduling-jfk-alm", "/app/com/scheduling/JFKALM"))
    recordProbeFailure(await probePage(page, "markets-jfk-lhr", "/app/com/markets/JFKLHR"))
    recordProbeFailure(await probePage(page, "flight-number-9381", "/app/com/numbers/9381/0"))
    recordProbeFailure(await probePage(page, "flight-numbers-index", "/app/com/numbers"))
    recordProbeFailure(await probePage(page, "accounting", "/app/finance/accounting"))
    recordProbeFailure(await probePage(page, "alliance", "/app/alliance"))
    recordProbeFailure(await probePage(page, "bulk-flight-prices", "/action/enterprise/flightsPrices?adjust=true"))

    report.liveWrite = await liveSamePricePost(page)
    if (report.liveWrite && report.liveWrite.error) {
        report.failures.push({kind: "live-write-eval", error: report.liveWrite.error})
    }
    const liveValue = report.liveWrite && report.liveWrite.value
    if (livePostEnabled && liveValue && liveValue.ok !== true) {
        report.failures.push({kind: "live-write-failed", result: liveValue})
    }
    report.finishedAt = new Date().toISOString()
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    const summary = {
        ok: report.failures.length === 0,
        reportPath,
        extension: report.extension,
        activeAfterSwitch: report.login.activeAfterSwitch,
        probes: report.probes.map(p => ({
            label: p.label,
            url: p.dom.url,
            aesNodes: p.dom.aesNodes,
            isoGlobals: p.iso && p.iso.value && p.iso.value.present ? p.iso.value.present.length : 0
        })),
        dashboard: report.interactions.dashboard,
        liveWrite: report.liveWrite && report.liveWrite.value ? report.liveWrite.value : report.liveWrite,
        consoleEvents: report.consoleEvents,
        failures: report.failures
    }
    console.log(JSON.stringify(summary, null, 2))
    if (report.failures.length) {
        throw new Error("Live CFLAIR verification failed: "
            + report.failures.map(f => f.kind + (f.label ? ":" + f.label : "")).join(", "))
    }
} catch (err) {
    report.finishedAt = new Date().toISOString()
    report.error = {
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack).slice(0, 4000) : null
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => {})
    console.error(JSON.stringify({
        ok: false,
        reportPath,
        error: report.error.message,
        login: report.login,
        extension: report.extension,
        failures: report.failures
    }, null, 2))
    process.exitCode = 1
} finally {
    if (ownsBrowser) await context.close().catch(() => {})
}

if (!ownsBrowser) process.exit(0)
