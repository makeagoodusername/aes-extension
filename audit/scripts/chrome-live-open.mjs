import { chromium } from "playwright"
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

const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normalizeServerHost(process.env.AES_LIVE_SERVER || creds.server || "free1.airlinesim.aero")
const startPath = process.env.AES_LIVE_START_PATH || "/app/enterprise/dashboard"
const enterpriseSelect = String(
    process.env.AES_LIVE_ENTERPRISE_ID
    || process.env.AES_LIVE_SELECT_ENTERPRISE
    || creds.enterpriseId
    || ""
).trim()
const expectedAirline = String(
    process.env.AES_LIVE_EXPECT_AIRLINE
    || creds.expectedAirline
    || ""
).trim()

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

async function loginIfNeeded(page) {
    await gotoDomContentLoaded(page, `https://${serverHost}/app/enterprise/dashboard`)
    await page.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false

    await gotoDomContentLoaded(page, "https://www.airlinesim.aero/auth/login")
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

async function gotoDomContentLoaded(page, url) {
    await page.goto(url, {waitUntil: "domcontentloaded"}).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

fs.mkdirSync(profileDir, {recursive: true})

const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: fs.existsSync(chromePath) ? chromePath : chromium.executablePath(),
    headless: false,
    viewport: {width: 1440, height: 1000},
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check"
    ]
})

const page = context.pages()[0] || await context.newPage()
page.setDefaultTimeout(60000)
page.on("pageerror", err => console.error("[pageerror]", (err && err.message) || String(err)))
page.on("console", msg => {
    if (msg.type() === "error") console.error("[console:error]", msg.text())
})

const loggedIn = await loginIfNeeded(page)
if (enterpriseSelect) {
    await gotoDomContentLoaded(page, `https://${serverHost}/app/enterprise/dashboard?select=${encodeURIComponent(enterpriseSelect)}`)
    await page.waitForLoadState("networkidle").catch(() => {})
}
await gotoDomContentLoaded(page, `https://${serverHost}${startPath}`)
await page.waitForLoadState("networkidle").catch(() => {})
const pageTitle = await page.title().catch(() => "")
const pageHasExpectedAirline = expectedAirline
    ? await page.locator("body").evaluate((body, airline) =>
        (body && body.innerText || "").toLowerCase().includes(String(airline).toLowerCase()),
        expectedAirline).catch(() => false)
    : true
if (expectedAirline
    && !pageTitle.toLowerCase().includes(expectedAirline.toLowerCase())
    && !pageHasExpectedAirline) {
    throw new Error(`Expected AirlineSim airline "${expectedAirline}" after login/select, but page title is "${pageTitle}"`)
}
console.log(JSON.stringify({
    ok: true,
    loggedIn,
    url: page.url(),
    title: pageTitle,
    enterpriseSelect: enterpriseSelect || null,
    expectedAirline: expectedAirline || null,
    profileDir,
    remoteDebuggingPort: port
}, null, 2))

process.on("SIGINT", async () => {
    await context.close().catch(() => {})
    process.exit(0)
})
process.on("SIGTERM", async () => {
    await context.close().catch(() => {})
    process.exit(0)
})

setInterval(() => {}, 1 << 30)
