import { chromium, expect } from "@playwright/test"
import fs from "fs"
import net from "net"
import os from "os"
import path from "path"

const ROOT = path.resolve(new URL("..", import.meta.url).pathname)
const START_PORT = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const LIVE = process.env.AES_TEST_LIVE === "1"
const DASHBOARD_URL = process.env.AES_TEST_DASHBOARD_URL
    || "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=1"
const ACCOUNTING_URL = process.env.AES_TEST_ACCOUNTING_URL
    || "https://free1.airlinesim.aero/app/finance/accounting?aes-fixture=1"
const SCHEDULE_URL = process.env.AES_TEST_SCHEDULE_URL
    || "https://free1.airlinesim.aero/app/info/enterprises/775?tab=3&aes-fixture=1"

async function main() {
    auditManifest()

    const debugPort = await findAvailableDebugPort(START_PORT)
    const profileDir = process.env.AES_TEST_PROFILE
        || fs.mkdtempSync(path.join(os.tmpdir(), "aes-e2e-profile-"))
    const removeProfile = !process.env.AES_TEST_PROFILE

    console.log(`Using --remote-debugging-port=${debugPort}`)

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: [
            `--disable-extensions-except=${ROOT}`,
            `--load-extension=${ROOT}`,
            `--remote-debugging-port=${debugPort}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
        ],
    })

    try {
        if (!LIVE) await installFixtureRoutes(context)

        await verifyCommandPaletteDispatch(context)
        await verifyGlobalMenuChord(context)
        await verifyCrossPageStrategyMenu(context)
        await verifyBridgeMessagePipeline(context)
        await verifyScheduleExtractorTrigger(context)

        console.log("E2E extension pipeline: PASS")
    } finally {
        await context.close().catch(() => {})
        if (removeProfile) {
            fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
        }
    }
}

function auditManifest() {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"))
    const background = manifest.background && manifest.background.service_worker
    const permissions = manifest.permissions || []
    const hostPermissions = manifest.host_permissions || []

    if (manifest.manifest_version !== 3) throw new Error("Expected manifest_version 3")
    if (background !== "background.js") throw new Error(`Unexpected service worker: ${background}`)
    for (const permission of ["storage", "tabs", "alarms"]) {
        if (!permissions.includes(permission)) throw new Error(`Missing permission: ${permission}`)
    }
    if (!hostPermissions.includes("https://*.airlinesim.aero/*")) {
        throw new Error("Missing AirlineSim host permission")
    }

    const missing = []
    const duplicates = []
    for (const [blockIndex, block] of (manifest.content_scripts || []).entries()) {
        const seen = new Set()
        for (const file of [...(block.js || []), ...(block.css || [])]) {
            if (seen.has(file)) duplicates.push({blockIndex, file})
            seen.add(file)
            if (!fs.existsSync(path.join(ROOT, file))) missing.push(file)
        }
    }
    if (missing.length) throw new Error(`Missing manifest files: ${missing.join(", ")}`)
    if (duplicates.length) {
        throw new Error("Duplicate manifest entries: "
            + duplicates.map(d => `block ${d.blockIndex} ${d.file}`).join(", "))
    }

    console.log(JSON.stringify({
        manifest: {
            serviceWorker: background,
            permissions,
            hostPermissions,
            contentScriptBlocks: manifest.content_scripts.length,
        },
    }))
}

async function verifyCommandPaletteDispatch(context) {
    const page = await newObservedPage(context, "cmd-k")
    await page.goto(DASHBOARD_URL, {waitUntil: "domcontentloaded"})

    await expect(page.locator(".aes-menu__trigger", {hasText: "AES"}).first())
        .toBeVisible({timeout: 10000})
    await expect(page.locator("#aes-central-hub").first()).toBeVisible({timeout: 10000})

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K")
    await expect(page.locator("#aes-command-palette")).toBeVisible({timeout: 10000})
    await page.locator("#aes-command-palette-input").fill("go to accounting")
    await expect(page.locator("#aes-command-palette-list .row").filter({hasText: "Go to Accounting"}))
        .toHaveCount(1, {timeout: 10000})
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/app\/finance\/accounting(?:[?#].*)?$/, {timeout: 10000})
    assertNoPageErrors(page)
    await page.close()
}

async function verifyCrossPageStrategyMenu(context) {
    const page = await newObservedPage(context, "strategy-route")
    await page.goto(ACCOUNTING_URL, {waitUntil: "domcontentloaded"})

    await expect(page.locator(".aes-menu__trigger", {hasText: "AES"}).first())
        .toBeVisible({timeout: 10000})
    await page.locator(".aes-menu__trigger").first().click()
    await page.getByText("Open Strategy", {exact: true}).click()

    await expect(page).toHaveURL(/\/app\/enterprise\/dashboard(?:[?#].*)?$/, {timeout: 10000})
    await expect(page.locator(".aes-strategy-modal")).toBeVisible({timeout: 15000})
    assertNoPageErrors(page)
    await page.close()
}

async function verifyGlobalMenuChord(context) {
    const page = await newObservedPage(context, "global-menu-chord")
    await page.goto(ACCOUNTING_URL, {waitUntil: "domcontentloaded"})

    await expect(page.locator(".aes-menu__trigger", {hasText: "AES"}).first())
        .toBeVisible({timeout: 10000})
    await page.keyboard.press("g")
    await page.keyboard.press("g")
    await expect(page.locator(".aes-menu__panel").first()).toBeVisible({timeout: 10000})

    assertNoPageErrors(page)
    await page.close()
}

async function verifyBridgeMessagePipeline(context) {
    const page = await newObservedPage(context, "bridge")
    await page.goto(ACCOUNTING_URL, {waitUntil: "domcontentloaded"})

    await expect(page.locator("#aes-bridge-nav-link").first())
        .toBeVisible({timeout: 10000})
    await page.locator("#aes-bridge-nav-link").first().click()

    const bridgePage = await context.waitForEvent("page", {timeout: 10000})
    await bridgePage.waitForLoadState("domcontentloaded")
    const bridgePages = context.pages().filter(p => p.url().includes("/bridge.html"))
    if (bridgePages.length !== 1) throw new Error(`Expected one Bridge tab, got ${bridgePages.length}`)

    assertNoPageErrors(page)
    await bridgePage.close()
    await page.close()
}

async function verifyScheduleExtractorTrigger(context) {
    const page = await newObservedPage(context, "schedule")
    await page.goto(SCHEDULE_URL, {waitUntil: "domcontentloaded"})

    await expect(page.locator("#aes-extractSchedule-btn")).toBeVisible({timeout: 10000})
    await page.locator("#aes-extractSchedule-btn").click()
    await expect(page.getByText("Schedule extracted!")).toBeVisible({timeout: 10000})

    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", {timeout: 5000})
    const stored = await worker.evaluate(() => new Promise(resolve => {
        chrome.storage.local.get("free1CFLschedule", resolve)
    }))
    if (!stored.free1CFLschedule) throw new Error("Schedule extractor did not write free1CFLschedule")

    assertNoPageErrors(page)
    await page.close()
}

async function newObservedPage(context, label) {
    const page = await context.newPage()
    page.__aesErrors = []
    page.on("pageerror", err => page.__aesErrors.push(`${label} pageerror: ${err.message}`))
    page.on("console", msg => {
        if (msg.type() === "error") page.__aesErrors.push(`${label} console: ${msg.text()}`)
    })
    return page
}

function assertNoPageErrors(page) {
    if (page.__aesErrors && page.__aesErrors.length) {
        throw new Error(page.__aesErrors.join("\n"))
    }
}

async function installFixtureRoutes(context) {
    await context.route("https://free1.airlinesim.aero/app/enterprise/dashboard**", route => {
        route.fulfill({status: 200, contentType: "text/html", body: dashboardFixture()})
    })
    await context.route("https://free1.airlinesim.aero/app/finance/accounting**", route => {
        route.fulfill({status: 200, contentType: "text/html", body: accountingFixture()})
    })
    await context.route("https://free1.airlinesim.aero/app/info/enterprises/**", route => {
        route.fulfill({status: 200, contentType: "text/html", body: scheduleFixture()})
    })
}

function dashboardFixture() {
    return pageShell(`
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
}

function accountingFixture() {
    return pageShell(`
    <main id="main-content">
      <section class="as-panel">
        <h1>Accounting</h1>
        <table><tbody><tr><td>Cash</td><td>1234567</td></tr></tbody></table>
      </section>
    </main>`)
}

function scheduleFixture() {
    return pageShell(`
    <main id="main-content">
      <section class="flight-schedule">
        <table>
          <tbody>
            <tr class="important origin">
              <td><a>ICN</a></td>
              <td class="code">CFL 100</td>
            </tr>
            <tr class="destination"><td><a>NRT</a></td></tr>
            <tr>
              <td class="code">CFL 100</td>
              <td class="days">1234567</td>
              <td class="remarks"></td>
              <td class="valid">2026</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>`)
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
    #as-navbar-main-collapse .navbar-nav {
      display: flex; gap: 12px; list-style: none; margin: 0; padding: 8px 12px; background: #f5f5f5;
    }
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
  <div class="as-navbar-bottom"><span><i class="fa fa-clock-o"></i> 2026-05-03 12:34 UTC</span></div>
  ${body}
</body>
</html>`
}

async function findAvailableDebugPort(startPort) {
    for (let port = startPort; port < startPort + 100; port += 1) {
        if (await canBind(port)) return port
    }
    throw new Error(`No available remote debugging port found from ${startPort}`)
}

function canBind(port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => server.close(() => resolve(true)))
        server.listen(port, "127.0.0.1")
    })
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
})
