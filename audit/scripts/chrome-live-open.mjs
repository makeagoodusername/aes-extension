import { chromium } from "playwright"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const extensionPath = repoRoot
const profileDir = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), "aes-chrome-live-open")
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const port = process.env.AES_LIVE_CHROME_PORT || "9315"
const directLaunch = !/^(0|false|no)$/i.test(process.env.AES_LIVE_DIRECT_LAUNCH || "1")

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normalizeServerHost(process.env.AES_LIVE_SERVER || creds.server || "free1.airlinesim.aero")
const enterpriseSelect = process.env.AES_LIVE_ENTERPRISE_SELECT || ""
const defaultStartPath = enterpriseSelect
    ? `/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseSelect)}`
    : "/app/enterprise/dashboard"
const startTarget = process.env.AES_LIVE_START_URL
    || process.env.AES_LIVE_START_PATH
    || defaultStartPath

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
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

fs.mkdirSync(profileDir, {recursive: true})

let child = null
let browser = null
let context = null
if (directLaunch) {
    const executable = fs.existsSync(chromePath) ? chromePath : chromium.executablePath()
    child = spawn(executable, [
        `--user-data-dir=${profileDir}`,
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check",
        toLiveUrl(startTarget)
    ], {
        detached: false,
        stdio: process.env.AES_LIVE_CHROME_VERBOSE ? "inherit" : "ignore"
    })
    await waitForCdp(port, 45000)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    context = browser.contexts()[0]
    if (!context) throw new Error("No Chrome context found on port " + port)
} else {
    context = await chromium.launchPersistentContext(profileDir, {
        executablePath: fs.existsSync(chromePath) ? chromePath : chromium.executablePath(),
        headless: false,
        viewport: {width: 1440, height: 1000},
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            `--remote-debugging-port=${port}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--disable-background-timer-throttling",
            "--no-first-run",
            "--no-default-browser-check"
        ]
    })
}

const page = context.pages()[0] || await context.newPage()
page.setDefaultTimeout(60000)
page.on("pageerror", err => console.error("[pageerror]", (err && err.message) || String(err)))
page.on("console", msg => {
    if (msg.type() === "error") console.error("[console:error]", msg.text())
})

const loggedIn = await loginIfNeeded(page)
await page.goto(toLiveUrl(startTarget), {waitUntil: "domcontentloaded"})
await page.waitForLoadState("networkidle").catch(() => {})
console.log(JSON.stringify({
    ok: true,
    loggedIn,
    url: page.url(),
    profileDir,
    remoteDebuggingPort: port,
    launchMode: directLaunch ? "direct" : "playwright",
    chromePid: child && child.pid || null
}, null, 2))

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

await new Promise(() => {})

function toLiveUrl(target) {
    return /^https?:\/\//i.test(target) ? target : `https://${serverHost}${target}`
}

async function waitForCdp(targetPort, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let lastError = null
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${targetPort}/json/version`)
            if (response.ok) return
            lastError = new Error("CDP status " + response.status)
        } catch (err) {
            lastError = err
        }
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw lastError || new Error("Timed out waiting for CDP port " + targetPort)
}

async function shutdown() {
    if (browser) await browser.close().catch(() => {})
    else if (context) await context.close().catch(() => {})
    if (child && !child.killed) child.kill("SIGTERM")
    process.exit(0)
}
