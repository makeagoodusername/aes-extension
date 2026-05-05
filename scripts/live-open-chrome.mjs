#!/usr/bin/env node

import { chromium } from "playwright"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const START_PORT = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const SERVER_HOST = normalizeServer(process.env.AES_LIVE_SERVER || "free1.airlinesim.aero")
const START_PATH = process.env.AES_LIVE_START_PATH || "/app/enterprise/dashboard?3&select=775"
const LOGIN_EMAIL = process.env.AES_LOGIN_EMAIL || ""
const LOGIN_PASSWORD = process.env.AES_LOGIN_PASSWORD || ""
delete process.env.AES_LOGIN_PASSWORD

const chromeForTesting = "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const CHROME_PATH = process.env.CHROME_BIN
    || (fs.existsSync(chromeForTesting) ? chromeForTesting : chromium.executablePath())

const port = await findAvailableDebugPort(Number.isFinite(START_PORT) ? START_PORT : 9222)
const profileDir = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), `aes-live-open-${port}`)

fs.mkdirSync(profileDir, { recursive: true })

const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME_PATH,
    headless: false,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--disable-background-timer-throttling",
        "--no-first-run",
        "--no-default-browser-check",
    ],
})

const page = context.pages()[0] || await context.newPage()
page.setDefaultTimeout(60000)
page.on("pageerror", err => console.error("[pageerror]", (err && err.message) || String(err)))
page.on("console", msg => {
    if (msg.type() === "error") console.error("[console:error]", msg.text())
})

let loggedIn = false
try {
    loggedIn = await loginIfNeeded(page)
    await gotoDom(page, `https://${SERVER_HOST}${START_PATH}`)
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", { timeout: 60000 }).catch(() => {})
    console.log(JSON.stringify({
        ok: true,
        remoteDebuggingPort: port,
        profileDir,
        url: page.url(),
        title: await page.title().catch(() => ""),
        loggedIn,
    }, null, 2))
} catch (err) {
    console.error(JSON.stringify({
        ok: false,
        remoteDebuggingPort: port,
        profileDir,
        url: page.url(),
        error: err && err.stack ? err.stack : String(err),
    }, null, 2))
    process.exitCode = 1
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
setInterval(() => {}, 1 << 30)

async function shutdown() {
    await context.close().catch(() => {})
    process.exit(0)
}

async function loginIfNeeded(targetPage) {
    await gotoDom(targetPage, `https://${SERVER_HOST}/app/enterprise/dashboard`)
    await targetPage.waitForLoadState("networkidle").catch(() => {})
    const needsLogin = /\/auth\/login/i.test(targetPage.url())
        || await targetPage.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false
    if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
        throw new Error("Live login requires AES_LOGIN_EMAIL and AES_LOGIN_PASSWORD")
    }

    await gotoDom(targetPage, "https://www.airlinesim.aero/auth/login")
    const loginInput = targetPage.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']",
    ].join(", ")).first()
    const passwordInput = targetPage.locator("input[type='password']").first()
    await loginInput.fill(LOGIN_EMAIL)
    await passwordInput.fill(LOGIN_PASSWORD)
    const submit = targetPage.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first()
    await Promise.all([
        targetPage.waitForURL(url => !/\/auth\/login/i.test(url.pathname), { timeout: 60000 }).catch(() => null),
        submit.click(),
    ])
    await targetPage.waitForLoadState("networkidle").catch(() => {})
    if (/\/auth\/login/i.test(targetPage.url())) {
        throw new Error("Login did not leave AirlineSim auth page")
    }
    return true
}

async function gotoDom(targetPage, url) {
    await targetPage.goto(url, { waitUntil: "domcontentloaded" }).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

function normalizeServer(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : `${raw}.airlinesim.aero`
}

async function findAvailableDebugPort(start, attempts = 100) {
    for (let candidate = start; candidate < start + attempts; candidate += 1) {
        if (await canListen(candidate)) return candidate
    }
    throw new Error(`No available remote debugging port in ${start}-${start + attempts - 1}`)
}

function canListen(candidate) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => server.close(() => resolve(true)))
        server.listen(candidate, "127.0.0.1")
    })
}
