import { chromium } from "playwright"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const extensionPath = repoRoot
const sourcePort = String(process.env.AES_SOURCE_PORT || "9947")
const port = String(process.env.AES_LIVE_CHROME_PORT || "9997")
const serverHost = normalizeServerHost(process.env.AES_LIVE_SERVER || "free1.airlinesim.aero")
const enterpriseId = String(process.env.AES_LIVE_ENTERPRISE_ID || "775")
const startPath = process.env.AES_LIVE_START_PATH
    || `/app/enterprise/dashboard?3&select=${encodeURIComponent(enterpriseId)}`
const expectedAirline = String(process.env.AES_LIVE_EXPECT_AIRLINE || "CFLAIR").trim()
const profileDir = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), `aes-live-cookie-clone-${port}`)
const reportPath = process.env.AES_LIVE_OPEN_REPORT
    || path.join(repoRoot, "audit", `live-open-cookie-clone-${port}-20260504.json`)
const chromePath = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

async function main() {
    const source = await chromium.connectOverCDP(`http://127.0.0.1:${sourcePort}`)
    const sourceContext = source.contexts()[0]
    if (!sourceContext) throw new Error(`No source browser context on port ${sourcePort}`)

    const cookies = await sourceContext.cookies([
        `https://${serverHost}`,
        "https://www.airlinesim.aero"
    ])
    if (!cookies.length) throw new Error(`No cookies found on source port ${sourcePort}`)

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

    await context.addCookies(cookies)
    const page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(60000)
    const consoleRows = []
    const pageErrors = []
    page.on("console", msg => {
        if (msg.type() === "error" || msg.type() === "warning") {
            consoleRows.push({type: msg.type(), text: msg.text(), url: page.url()})
        }
    })
    page.on("pageerror", err => pageErrors.push((err && err.message) || String(err)))

    await page.goto(`https://${serverHost}${startPath}`, {waitUntil: "domcontentloaded"})
        .catch(err => {
            if (!/ERR_ABORTED/.test(String(err))) throw err
        })
    await page.waitForLoadState("networkidle", {timeout: 30000}).catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", {timeout: 45000})

    const title = await page.title().catch(() => "")
    const url = page.url()
    const bodyHasExpectedAirline = expectedAirline
        ? await page.locator("body").evaluate((body, airline) =>
            (body && body.innerText || "").toLowerCase().includes(String(airline).toLowerCase()),
            expectedAirline).catch(() => false)
        : true
    const loggedIn = !/\/auth\/login/i.test(url)
    const ok = loggedIn
        && (!expectedAirline
            || title.toLowerCase().includes(expectedAirline.toLowerCase())
            || bodyHasExpectedAirline)
        && pageErrors.length === 0

    const report = {
        ok,
        sourcePort,
        remoteDebuggingPort: port,
        server: serverHost,
        enterpriseId,
        url,
        title,
        loggedIn,
        expectedAirline: expectedAirline || null,
        bodyHasExpectedAirline,
        profileDir,
        reportPath,
        consoleRows: consoleRows.filter(row => !/ResizeObserver loop/i.test(row.text)),
        pageErrors
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!ok) process.exitCode = 1

    if (process.env.AES_KEEP_BROWSER === "1") {
        process.on("SIGINT", async () => {
            await context.close().catch(() => {})
            process.exit(0)
        })
        process.on("SIGTERM", async () => {
            await context.close().catch(() => {})
            process.exit(0)
        })
        setInterval(() => {}, 1 << 30)
    } else {
        await context.close()
        process.exit(process.exitCode || 0)
    }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
