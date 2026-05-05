import { chromium } from "playwright"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const extensionPath = process.env.AES_EXTENSION_PATH || repoRoot
const live = process.env.AES_TEST_LIVE === "1"
const startPort = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const remoteDebuggingPort = await findAvailablePort(Number.isFinite(startPort) ? startPort : 9222)
const tmpProfile = live ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "aes-e2e-profile-"))
const profileDir = process.env.AES_TEST_PROFILE || tmpProfile || path.join(os.tmpdir(), "aes-e2e-live-profile")
const dashboardUrl = process.env.AES_TEST_DASHBOARD_URL
    || "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=1"
const accountingUrl = process.env.AES_TEST_ACCOUNTING_URL
    || "https://free1.airlinesim.aero/app/finance/accounting?aes-fixture=1"
const modKey = process.platform === "darwin" ? "Meta" : "Control"

const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: {width: 1366, height: 900},
    args: [
        `--remote-debugging-port=${remoteDebuggingPort}`,
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check",
    ],
})

try {
    console.log(`[e2e] launched Chrome with --remote-debugging-port=${remoteDebuggingPort}`)
    if (!live) installMockAirlineSimRoutes(context)

    const page = context.pages()[0] || await context.newPage()
    const consoleIssues = []
    page.on("console", msg => {
        if (msg.type() === "error" || /\[AES/.test(msg.text())) {
            consoleIssues.push(`${msg.type()}: ${msg.text()}`)
        }
    })
    page.on("pageerror", err => consoleIssues.push(`pageerror: ${err.message}`))

    await page.goto(dashboardUrl, {waitUntil: "domcontentloaded", timeout: 60000})
    await visible(page, ".aes-menu__trigger")
    await visible(page, "#aes-central-hub")
    console.log("[e2e] dashboard content scripts mounted")

    const bridgePromise = context.waitForEvent("page", {
        predicate: p => /^chrome-extension:\/\/[^/]+\/bridge\.html/.test(p.url()),
        timeout: 10000,
    }).catch(() => null)
    await page.locator("#aes-bridge-nav-link").click({timeout: 10000})
    const bridgePage = await bridgePromise
    assert(bridgePage, "Bridge click did not open chrome-extension://*/bridge.html")
    await bridgePage.close().catch(() => {})
    await page.bringToFront()
    console.log("[e2e] content script -> background -> tabs bridge opened")

    await page.goto(accountingUrl, {waitUntil: "domcontentloaded", timeout: 60000})
    await visible(page, ".aes-menu__trigger")
    await page.keyboard.press(`${modKey}+K`)
    await visible(page, "#aes-command-palette")
    await visible(page, "#aes-command-palette-input")
    await page.keyboard.press("Escape")
    console.log("[e2e] Cmd-K opens palette on a generic finance page")

    await page.mouse.click(20, 160)
    await page.keyboard.press("g")
    await page.keyboard.press("g")
    await visible(page, ".aes-menu__panel")
    await page.mouse.click(20, 160)
    await page.waitForFunction(() => {
        const panel = document.querySelector(".aes-menu__panel")
        if (!panel) return true
        return getComputedStyle(panel).display === "none"
    }, null, {timeout: 5000}).catch(() => {})
    console.log("[e2e] g g opens the AES menu")

    await page.locator(".aes-menu__trigger").click()
    await page.locator(".aes-menu__panel a", {hasText: "Open command palette"}).click()
    await visible(page, "#aes-command-palette")
    await page.locator("#aes-command-palette-input").fill("go to dashboard")
    await visible(page, "#aes-command-palette-list .row")
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/app\/enterprise\/dashboard(?:[?#].*)?$/, {timeout: 10000})
    console.log("[e2e] AES menu -> palette -> navigation command dispatched")

    const blockingIssues = consoleIssues.filter(line => !/favicon|ERR_BLOCKED_BY_CLIENT/i.test(line))
    if (blockingIssues.length) {
        console.warn("[e2e] console issues captured:")
        for (const issue of blockingIssues.slice(0, 20)) console.warn(`  ${issue}`)
    }
    console.log("[e2e] PASS")
} finally {
    await context.close().catch(() => {})
    if (tmpProfile) {
        fs.rmSync(tmpProfile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    }
}

function installMockAirlineSimRoutes(ctx) {
    ctx.route("https://free1.airlinesim.aero/app/enterprise/dashboard**", route => {
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
    </main>`),
        })
    })
    ctx.route("https://free1.airlinesim.aero/app/finance/accounting**", route => {
        route.fulfill({
            status: 200,
            contentType: "text/html",
            body: pageShell(`
    <main id="main-content">
      <section class="as-panel">
        <h1>Accounting</h1>
        <table><tbody><tr><td>Cash</td><td>1234567</td></tr></tbody></table>
      </section>
    </main>`),
        })
    })
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

async function visible(page, selector) {
    await page.waitForSelector(selector, {state: "visible", timeout: 15000})
}

function assert(value, message) {
    if (!value) throw new Error(message)
}

async function findAvailablePort(startPort) {
    for (let port = startPort; port < startPort + 80; port++) {
        if (await canListen(port)) return port
    }
    throw new Error(`No available remote debugging port found from ${startPort} to ${startPort + 79}`)
}

function canListen(port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => {
            server.close(() => resolve(true))
        })
        server.listen(port, "127.0.0.1")
    })
}
