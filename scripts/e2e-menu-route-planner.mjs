import { chromium } from "playwright"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const root = path.resolve(new URL("..", import.meta.url).pathname)
const extensionPath = root
const profileDir = process.env.AES_E2E_PROFILE
    || fs.mkdtempSync(path.join(os.tmpdir(), "aes-e2e-route-planner-"))
const startPort = Number(process.env.AES_REMOTE_DEBUGGING_PORT || "9222") || 9222
const remoteDebuggingPort = await findAvailablePort(startPort)
const liveMode = process.env.AES_E2E_LIVE === "1"
const dashboardUrl = process.env.AES_E2E_DASHBOARD_URL
    || (liveMode
        ? "https://free1.airlinesim.aero/app/enterprise/dashboard"
        : "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=route-planner")
const errors = []
let page = null

const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: {width: 1366, height: 900},
    args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--remote-debugging-port=${remoteDebuggingPort}`,
        "--remote-allow-origins=*",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check"
    ]
})

try {
    if (!liveMode) await installRoutes(context)

    page = await context.newPage()
    page.on("pageerror", err => errors.push((err && err.message) || String(err)))
    page.on("console", msg => {
        if (msg.type() === "error") errors.push(msg.text())
    })

    await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"})
    if (liveMode) await loginIfNeeded(page)
    await page.locator(".aes-menu__trigger", {hasText: "AES"}).first().waitFor({state: "visible", timeout: 15000})
    await page.locator("#aes-central-hub").first().waitFor({state: "visible", timeout: 15000})
    await dismissBlockingModals(page)

    await page.locator(".aes-menu__trigger", {hasText: "AES"}).first().click()
    await page.locator(".aes-menu__panel a", {hasText: "Route Planner"}).first().click()

    await page.waitForURL(/\/app\/fleets\/aircraft\/\d+\/0(?:[?#].*)?$/, {timeout: 20000})
    await page.locator("text=Total flights/wk:").first()
        .waitFor({state: "visible", timeout: 15000})

    const checks = await page.evaluate(() => ({
        finalPath: location.pathname,
        routePlannerVisible: !![...document.querySelectorAll("body *")]
            .find(el => /Total flights\/wk:/.test(el.textContent || "")),
        overlayText: (document.body && document.body.innerText || "")
            .split("\n")
            .filter(line => /Route Planner|Total flights\/wk|Dry-run|Hub:/.test(line))
            .slice(0, 8)
    }))

    console.log(JSON.stringify({
        ok: true,
        mode: liveMode ? "live" : "mock",
        remoteDebuggingPort,
        startUrl: dashboardUrl,
        finalUrl: page.url(),
        checks,
        errors
    }, null, 2))
} catch (err) {
    const diagnostics = page ? await page.evaluate(() => ({
        url: location.href,
        pending: (() => {
            try { return sessionStorage.getItem("aes:menu:pending") } catch (_) { return null }
        })(),
        hasRouteAndOpen: !!window.AesMenuRouteAndOpen,
        hasRoutePlanner: !!window.AesAfpRoutePlannerPanel,
        hasAfp: !!window.AesAfp,
        bodyExcerpt: (document.body && document.body.innerText || "").slice(0, 1200)
    })).catch(e => ({diagnosticsError: (e && e.message) || String(e)})) : null
    console.error(JSON.stringify({
        ok: false,
        mode: liveMode ? "live" : "mock",
        remoteDebuggingPort,
        finalUrl: page ? page.url() : null,
        error: (err && err.message) || String(err),
        diagnostics,
        errors
    }, null, 2))
    throw err
} finally {
    await context.close().catch(() => {})
    if (!process.env.AES_E2E_PROFILE) {
        fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    }
}

async function installRoutes(ctx) {
    await ctx.route("https://free1.airlinesim.aero/app/enterprise/dashboard**", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html",
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

    await ctx.route("https://free1.airlinesim.aero/app/fleets", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: pageShell(`
<main id="main-content">
  <section class="as-page-fleet-management">
    <h1>Fleet Management</h1>
    <div class="row">
      <div class="col-md-9">
        <div class="as-panel">
          <table>
            <tbody>
              <tr>
                <td>Mock A320</td><td>D-CFLA</td><td>Airbus A320-200</td><td>ICN</td>
                <td><a href="/app/fleets/aircraft/999001/0">Flight Plan</a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</main>`)
        })
    })

    await ctx.route("https://free1.airlinesim.aero/app/fleets/aircraft/999001/0**", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: pageShell(`
<main id="main-content">
  <section class="as-page-aircraft">
    <h1><span>D-CFLA</span> <span>Airbus A320-200</span> <span>Mock A320</span></h1>
    <div class="row">
      <div class="col-md-2">
        <div class="as-panel">
          <div class="as-table-well">
            <table><tbody><tr><th>Last airport</th><td><a href="/app/info/airports/1" title="Seoul Incheon">ICN</a></td></tr></tbody></table>
          </div>
        </div>
      </div>
      <div class="col-md-10">
        <div class="as-panel">
          <h2>Visual Flight Plan</h2>
          <form id="new-flight-form"><button type="submit">Submit</button></form>
        </div>
      </div>
    </div>
  </section>
</main>`)
        })
    })
}

async function loginIfNeeded(page) {
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return

    const email = process.env.AES_E2E_EMAIL || process.env.AES_LOGIN_EMAIL || ""
    const password = process.env.AES_E2E_PASSWORD || process.env.AES_LOGIN_PASSWORD || ""
    if (!email || !password) {
        throw new Error("Live mode needs AES_E2E_EMAIL and AES_E2E_PASSWORD environment variables")
    }

    if (!/\/auth\/login/i.test(page.url())) {
        await page.goto("https://www.airlinesim.aero/auth/login", {waitUntil: "domcontentloaded"})
    }

    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first()
    const passwordInput = page.locator("input[type='password']").first()

    await loginInput.fill(email)
    await passwordInput.fill(password)
    const submit = page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in'), button:has-text('Login')").first()
    if (await submit.count().catch(() => 0)) await submit.click()
    else await passwordInput.press("Enter")

    await page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000})
        .catch(() => {})
    await page.waitForLoadState("networkidle").catch(() => {})
    if (/\/auth\/login/i.test(page.url())) {
        throw new Error("Login did not leave /auth/login")
    }
    await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"})
    await page.waitForLoadState("networkidle").catch(() => {})
}

async function dismissBlockingModals(page) {
    await page.keyboard.press("Escape").catch(() => {})
    await page.evaluate(() => {
        const selectors = [
            "#aes-release-notes-dialog",
            ".modal.fade.in",
            ".modal.show"
        ]
        for (const selector of selectors) {
            for (const modal of document.querySelectorAll(selector)) {
                const closer = modal.querySelector("[data-dismiss='modal'], .close, button")
                if (closer) {
                    try { closer.click() } catch (_) {}
                }
                try { modal.classList.remove("in", "show") } catch (_) {}
                try { modal.style.display = "none" } catch (_) {}
                try { modal.setAttribute("aria-hidden", "true") } catch (_) {}
            }
        }
        for (const backdrop of document.querySelectorAll(".modal-backdrop")) {
            try { backdrop.remove() } catch (_) {}
        }
        try { document.body.classList.remove("modal-open") } catch (_) {}
        try { document.body.style.removeProperty("padding-right") } catch (_) {}
    }).catch(() => {})
}

function pageShell(body) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AirlineSim Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    .as-navbar-main { background: #233044; color: #fff; padding: 8px 12px; }
    .as-navbar-main a { color: inherit; text-decoration: none; }
    #as-navbar-main-collapse .navbar-nav { display: flex; gap: 12px; list-style: none; margin: 0; padding: 8px 12px; background: #f5f5f5; }
    #as-navbar-main-collapse a { color: #1b2733; text-decoration: none; }
    .as-navbar-bottom { padding: 6px 12px; border-bottom: 1px solid #ddd; }
    main { padding: 16px; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #ddd; padding: 4px 8px; }
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
  <div class="as-navbar-bottom"><span><i class="fa fa-clock-o"></i> 2026-05-03 12:34 UTC</span></div>
  ${body}
</body>
</html>`
}

function findAvailablePort(start) {
    return new Promise((resolve, reject) => {
        const tryPort = port => {
            if (port >= start + 100) {
                reject(new Error(`No available remote debugging port found from ${start}`))
                return
            }
            const server = net.createServer()
            server.once("error", () => tryPort(port + 1))
            server.once("listening", () => {
                server.close(() => resolve(port))
            })
            server.listen(port, "127.0.0.1")
        }
        tryPort(start)
    })
}
