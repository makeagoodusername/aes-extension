import { chromium } from "playwright"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(new URL("..", import.meta.url).pathname)
const LIVE = process.env.AES_TEST_LIVE === "1"
const TEMP_PROFILE = LIVE ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "aes-bridge-menu-smoke-"))
const PROFILE = process.env.AES_TEST_PROFILE || TEMP_PROFILE || path.resolve(os.tmpdir(), "aes-bridge-menu-live-profile")
const START_PORT = Number(process.env.AES_REMOTE_DEBUG_PORT || 9222)
const DASHBOARD_URL = process.env.AES_TEST_DASHBOARD_URL
    || "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-bridge-smoke=1"
const CHROME = process.env.CHROME_EXECUTABLE || process.env.CHROME_BIN
const CREDENTIALS_PATH = path.join(ROOT, "audit", "credentials.json")

function pageFixture() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AES Bridge Smoke</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    #as-navbar-main-collapse .navbar-nav {
      display: flex;
      gap: 12px;
      list-style: none;
      margin: 0;
      padding: 8px 12px;
      background: #f5f5f5;
    }
    #as-navbar-main-collapse a { color: #1b2733; text-decoration: none; }
    .as-navbar-bottom { padding: 6px 12px; border-bottom: 1px solid #ddd; }
    main { padding: 16px; }
  </style>
</head>
<body>
  <nav id="as-navbar-main-collapse">
    <ul class="navbar-nav">
      <li><a href="/app/enterprise/dashboard">Dashboard</a></li>
      <li><a href="/app/fleets">Fleets</a></li>
      <li><a href="/app/com/scheduling/ICN">Scheduling</a></li>
      <li><a href="/app/finance/accounting">Accounting</a></li>
      <li><a href="/app/enterprise/settings">Settings</a></li>
    </ul>
  </nav>
  <div class="as-navbar-bottom"><span><i class="fa fa-clock-o"></i> 2026-05-03 12:34 UTC</span></div>
  <main>
    <h1>Enterprise Dashboard</h1>
    <section class="facts">
      <table>
        <tbody>
          <tr><td>Airline</td><td>Casper Flight Logistics</td></tr>
          <tr><td>Code</td><td>CFL</td></tr>
          <tr><td>Company reputation</td><td>92</td></tr>
        </tbody>
      </table>
    </section>
    <section id="enterprise-dashboard"></section>
  </main>
</body>
</html>`
}

function isPortAvailable(port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => {
            server.close(() => resolve(true))
        })
        server.listen(port, "127.0.0.1")
    })
}

async function findAvailableDebugPort(start) {
    for (let port = start; port < start + 100; port++) {
        if (await isPortAvailable(port)) return port
    }
    throw new Error(`No available remote debugging port found from ${start} to ${start + 99}`)
}

async function firstBridgePage(context) {
    const existing = context.pages().find(page => /chrome-extension:\/\/[^/]+\/bridge\.html/.test(page.url()))
    if (existing) return existing
    return context.waitForEvent("page", {
        predicate: page => /chrome-extension:\/\/[^/]+\/bridge\.html/.test(page.url()),
        timeout: 10000,
    })
}

async function readStdinCredentials() {
    const lines = []
    for await (const chunk of process.stdin) {
        lines.push(String(chunk))
        const joined = lines.join("")
        if (joined.split(/\r?\n/).filter(Boolean).length >= 2) break
    }
    const values = lines.join("").split(/\r?\n/).filter(Boolean)
    return {
        email: values[0] || "",
        password: values[1] || "",
    }
}

async function readCredentials() {
    if (process.env.AES_CREDENTIALS_STDIN === "1") return readStdinCredentials()
    const fromEnv = {
        email: process.env.AES_LOGIN_EMAIL || "",
        password: process.env.AES_LOGIN_PASSWORD || "",
    }
    if (fromEnv.email && fromEnv.password) return fromEnv
    try {
        const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"))
        return {
            email: parsed.email || "",
            password: parsed.password || "",
        }
    } catch (_) {
        return fromEnv
    }
}

async function loginIfNeeded(page) {
    if (!LIVE) return
    if (!/\/auth\/login/.test(page.url())
            && await page.locator("input[type='password']").count().catch(() => 0) === 0) {
        return
    }

    const credentials = await readCredentials()
    if (!credentials.email || !credentials.password) {
        throw new Error("Live mode needs AES_LOGIN_EMAIL/AES_LOGIN_PASSWORD or ignored audit/credentials.json")
    }

    if (!/\/auth\/login/.test(page.url())) {
        await page.goto("https://www.airlinesim.aero/auth/login", {waitUntil: "domcontentloaded"})
    }
    await page.locator("input[name='login'], input[type='email']").first().waitFor({state: "visible", timeout: 30000})
    await page.locator("input[name='login'], input[type='email']").first().fill(credentials.email)
    await page.locator("input[type='password'], input[name='password']").first().fill(credentials.password)
    const form = page.locator("form").filter({has: page.locator("input[type='password']")}).first()
    const submit = form.locator("button[type='submit'], input[type='submit']").first()
    if (await submit.count()) await submit.click()
    else await page.locator("input[type='password'], input[name='password']").first().press("Enter")
    await page.waitForLoadState("domcontentloaded", {timeout: 30000}).catch(() => {})
    if (/\/auth\/login/.test(page.url())
            || await page.locator("input[type='password']").count().catch(() => 0) > 0) {
        throw new Error("AirlineSim login did not complete")
    }
}

async function main() {
    const remoteDebuggingPort = await findAvailableDebugPort(START_PORT)
    const errors = []

    const context = await chromium.launchPersistentContext(PROFILE, {
        executablePath: CHROME && fs.existsSync(CHROME) ? CHROME : undefined,
        headless: false,
        ignoreDefaultArgs: ["--disable-extensions"],
        viewport: {width: 1280, height: 900},
        args: [
            `--disable-extensions-except=${ROOT}`,
            `--load-extension=${ROOT}`,
            `--remote-debugging-port=${remoteDebuggingPort}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    })

    try {
        context.on("page", page => {
            page.on("pageerror", err => errors.push(`pageerror ${page.url()}: ${err.message}`))
            page.on("console", msg => {
                if (msg.type() === "error") errors.push(`console ${page.url()}: ${msg.text()}`)
            })
        })

        if (!LIVE) {
            await context.route("https://*.airlinesim.aero/**", route => route.fulfill({
                status: 200,
                contentType: "text/html; charset=utf-8",
                body: pageFixture(),
            }))
        }

        const page = await context.newPage()
        await page.goto(DASHBOARD_URL, {waitUntil: "domcontentloaded"})
        await loginIfNeeded(page)
        if (LIVE && !/airlinesim\.aero\/app\//.test(page.url())) {
            await page.goto(DASHBOARD_URL, {waitUntil: "domcontentloaded"})
        }
        await page.waitForSelector(".aes-menu__trigger", {timeout: 10000})
        await page.waitForSelector("#aes-bridge-nav-link[data-aes-bridge-safe='1']", {timeout: 10000})

        await page.locator("#aes-bridge-nav-link").click()
        const bridge = await firstBridgePage(context)
        await bridge.waitForLoadState("domcontentloaded")
        await bridge.waitForSelector(".aes-bridge__h1", {timeout: 10000})
        const bridgeUrl = bridge.url()

        await page.bringToFront()
        await page.locator("#aes-bridge-nav-link").click()
        await page.waitForTimeout(800)
        const bridgeTabs = context.pages().filter(p => /chrome-extension:\/\/[^/]+\/bridge\.html/.test(p.url()))

        const result = {
            ok: bridgeTabs.length === 1 && errors.length === 0,
            remoteDebuggingPort,
            dashboardUrl: page.url(),
            bridgeUrl,
            bridgeTabCount: bridgeTabs.length,
            errors,
        }

        console.log(JSON.stringify(result, null, 2))
        if (!result.ok) process.exitCode = 1
    } finally {
        await context.close().catch(() => {})
        if (TEMP_PROFILE) fs.rmSync(TEMP_PROFILE, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    }
}

main().catch(err => {
    console.error(err && err.stack || err)
    try {
        if (TEMP_PROFILE) fs.rmSync(TEMP_PROFILE, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    } catch (_) {}
    process.exit(1)
})
