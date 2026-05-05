#!/usr/bin/env node

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const EXTENSION_PATH = ROOT
const START_PORT = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const DASHBOARD_URL = process.env.AES_TEST_DASHBOARD_URL
    || "https://free1.airlinesim.aero/app/enterprise/dashboard?qa-fixture=1"
const PROFILE_DIR = process.env.AES_TEST_PROFILE
    || fs.mkdtempSync(path.join(os.tmpdir(), "aes-qa-e2e-"))
const LIVE = process.env.AES_TEST_LIVE === "1"
const LOGIN_EMAIL = process.env.AES_LOGIN_EMAIL || ""
const LOGIN_PASSWORD = process.env.AES_LOGIN_PASSWORD || ""

const result = {
    ok: false,
    remoteDebuggingPort: null,
    dashboardUrl: DASHBOARD_URL,
    live: LIVE,
    checks: [],
    consoleErrors: [],
    pageErrors: [],
}

let context = null
let ownsProfile = !process.env.AES_TEST_PROFILE

try {
    const port = await findAvailableDebugPort(START_PORT)
    result.remoteDebuggingPort = port

    context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        ignoreHTTPSErrors: true,
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            `--remote-debugging-port=${port}`,
        ],
    })

    if (!LIVE) await installAirlineSimFixtures(context)

    const page = await context.newPage()
    wireDiagnostics(page, result)

    if (LIVE) await loginIfNeeded(page)

    await page.goto(DASHBOARD_URL, {waitUntil: "domcontentloaded"})
    await visible(page, ".aes-menu__trigger", "AES menu trigger")
    pass("AES menu injected on dashboard")
    await visible(page, "#aes-central-hub", "central hub")
    pass("Central Hub injected on dashboard")
    await visible(page, "#aes-bridge-nav-link", "Bridge navbar link")
    pass("Bridge navbar link injected")

    await openPalette(page)
    await page.locator("#aes-command-palette-input").fill("go to accounting")
    await visible(page, '#aes-command-palette-list .row[data-cmd-id="nav.accounting"]', "Accounting command row")
    pass("Cmd-K opens palette and finds Accounting command")
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/app\/finance\/accounting(?:[?#].*)?$/, {timeout: 10000})
    pass("Palette command navigated to Accounting")

    await openPalette(page)
    await visible(page, "#aes-command-palette.open", "Accounting page command palette")
    pass("Cmd-K still opens on Accounting page")
    await page.keyboard.press("Escape")
    await closeBlockingOverlays(page)
    const bridgeSafe = await page.locator("#aes-bridge-nav-link[data-aes-bridge-safe='1']").count()
    assert(bridgeSafe === 1, "Bridge safe click repair did not attach")
    pass("Bridge navbar click repair attached")

    const bridgePage = await clickBridgeAndFindTab(context, page)
    assert(bridgePage && /chrome-extension:\/\/[^/]+\/bridge\.html/.test(bridgePage.url()),
        "Bridge tab did not open through runtime fallback")
    pass("Bridge navbar opened extension Bridge tab")

    await page.bringToFront()
    await page.click("#aes-bridge-nav-link")
    await page.waitForTimeout(750)
    const bridgeTabs = context.pages()
        .filter(p => /chrome-extension:\/\/[^/]+\/bridge\.html/.test(p.url()))
    assert(bridgeTabs.length === 1, `Bridge dedupe expected 1 tab, saw ${bridgeTabs.length}`)
    pass("Bridge background pipeline dedupes repeated clicks")

    result.ok = true
} catch (err) {
    result.error = err && err.stack ? err.stack : String(err)
    process.exitCode = 1
} finally {
    if (context) await context.close().catch(() => {})
    if (ownsProfile) fs.rmSync(PROFILE_DIR, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    console.log(JSON.stringify(result, null, 2))
}

function pass(name) {
    result.checks.push({name, ok: true})
}

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function visible(page, selector, name) {
    await page.waitForSelector(selector, {state: "visible", timeout: 15000})
    return name
}

async function openPalette(page) {
    const mod = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(`${mod}+K`)
    await visible(page, "#aes-command-palette.open", "command palette")
    await visible(page, "#aes-command-palette-input", "command palette input")
}

async function clickBridgeAndFindTab(context, page) {
    await closeBlockingOverlays(page)
    const newPage = context.waitForEvent("page", {timeout: 5000}).catch(() => null)
    await page.click("#aes-bridge-nav-link")
    const opened = await newPage
    if (opened) {
        await opened.waitForLoadState("domcontentloaded").catch(() => {})
        return opened
    }
    await page.waitForTimeout(750)
    return context.pages().find(p => /chrome-extension:\/\/[^/]+\/bridge\.html/.test(p.url())) || null
}

async function closeBlockingOverlays(page) {
    await page.keyboard.press("Escape").catch(() => {})
    await page.evaluate(() => {
        const palette = document.getElementById("aes-command-palette")
        const paletteBackdrop = document.getElementById("aes-command-palette-backdrop")
        if (palette) palette.classList.remove("open")
        if (paletteBackdrop) paletteBackdrop.classList.remove("open")

        const releaseNotes = document.getElementById("aes-release-notes-dialog")
        if (releaseNotes) {
            releaseNotes.classList.remove("in", "show")
            releaseNotes.style.display = "none"
            releaseNotes.setAttribute("aria-hidden", "true")
        }
        document.querySelectorAll(".modal-backdrop").forEach(el => el.remove())
        document.body && document.body.classList.remove("modal-open")
    }).catch(() => {})
}

async function loginIfNeeded(page) {
    await page.goto(DASHBOARD_URL, {waitUntil: "domcontentloaded"})
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login|\/app\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) {
        result.login = {needed: false, url: redactUrl(page.url())}
        return
    }

    if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
        throw new Error("Live login requires AES_LOGIN_EMAIL and AES_LOGIN_PASSWORD")
    }

    await page.goto("https://www.airlinesim.aero/auth/login", {waitUntil: "domcontentloaded"})
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']",
    ].join(", ")).first()
    const passwordInput = page.locator("input[type='password']").first()
    await loginInput.fill(LOGIN_EMAIL)
    await passwordInput.fill(LOGIN_PASSWORD)
    const submit = page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first()
    if (await submit.count()) {
        await Promise.all([
            page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000}).catch(() => null),
            submit.click(),
        ])
    } else {
        await Promise.all([
            page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000}).catch(() => null),
            passwordInput.press("Enter"),
        ])
    }
    await page.waitForLoadState("networkidle").catch(() => {})
    if (/\/auth\/login|\/app\/login/i.test(page.url())) {
        throw new Error("Live login did not leave the login page")
    }
    result.login = {needed: true, url: redactUrl(page.url())}
}

function redactUrl(url) {
    try {
        const u = new URL(url)
        u.search = u.search ? "?..." : ""
        return u.toString()
    } catch (_) {
        return String(url || "")
    }
}

function wireDiagnostics(page, target) {
    page.on("console", msg => {
        if (msg.type() === "error") target.consoleErrors.push(msg.text())
    })
    page.on("pageerror", err => {
        target.pageErrors.push(err && err.stack ? err.stack : String(err))
    })
}

async function findAvailableDebugPort(start, attempts = 50) {
    for (let port = start; port < start + attempts; port += 1) {
        if (await isPortAvailable(port)) return port
    }
    throw new Error(`No available remote debugging port in ${start}-${start + attempts - 1}`)
}

function isPortAvailable(port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => server.close(() => resolve(true)))
        server.listen(port, "127.0.0.1")
    })
}

async function installAirlineSimFixtures(ctx) {
    await ctx.route("https://free1.airlinesim.aero/app/enterprise/dashboard**", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: pageShell(`
              <main id="main-content">
                <section class="facts">
                  <table>
                    <tr><td>Airline</td><td>Casper Flight Logistics</td></tr>
                    <tr><td>Code</td><td>CFL</td></tr>
                    <tr><td>Company reputation</td><td>92</td></tr>
                  </table>
                </section>
                <section id="enterprise-dashboard" class="as-page-dashboard">
                  <h1>Enterprise Dashboard</h1>
                </section>
              </main>`)
        })
    })
    await ctx.route("https://free1.airlinesim.aero/app/finance/accounting**", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: pageShell(`
              <main id="main-content">
                <section class="as-panel">
                  <h1>Accounting</h1>
                  <table><tbody><tr><td>Cash</td><td>1234567</td></tr></tbody></table>
                </section>
              </main>`)
        })
    })
}

function pageShell(body) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AirlineSim QA Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    .as-navbar-main { background: #233044; color: #fff; padding: 8px 12px; }
    .as-navbar-main a { color: inherit; text-decoration: none; }
    #as-navbar-main-collapse .navbar-nav { display: flex; gap: 12px; list-style: none; margin: 0; padding: 8px 12px; background: #f5f5f5; }
    #as-navbar-main-collapse a { color: #1b2733; text-decoration: none; }
    .as-navbar-bottom { padding: 6px 12px; border-bottom: 1px solid #ddd; }
    main { padding: 16px; }
    .facts table { border-collapse: collapse; }
    .facts td { border: 1px solid #ddd; padding: 4px 8px; }
  </style>
</head>
<body>
  <div class="as-navbar-main">
    <a class="name" href="/app/enterprise/dashboard"><span>Casper Flight Logistics</span><span class="caret"></span></a>
  </div>
  <nav id="as-navbar-main-collapse">
    <ul class="navbar-nav">
      <li><a href="/app/enterprise/dashboard">Dashboard</a></li>
      <li><a href="/app/fleets">Fleets</a></li>
      <li><a href="/app/com/scheduling/ICN">Scheduling</a></li>
      <li><a href="/app/com/numbers">Flight numbers</a></li>
      <li><a href="/app/enterprise/settings">Settings</a></li>
    </ul>
  </nav>
  <div class="as-navbar-bottom"><span><i class="fa fa-clock-o"></i> 2026-05-05 12:34 UTC</span></div>
  ${body}
</body>
</html>`
}
