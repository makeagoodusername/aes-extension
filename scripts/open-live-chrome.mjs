#!/usr/bin/env node

import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const ROOT = path.resolve(new URL("..", import.meta.url).pathname)
const EXTENSION_PATH = process.env.AES_EXTENSION_PATH || ROOT
const START_PORT = Number(process.env.AES_REMOTE_DEBUGGING_PORT || 9222)
const PORT = await findAvailableDebugPort(START_PORT)
const PROFILE_DIR = process.env.AES_LIVE_PROFILE
    || path.join(os.tmpdir(), `aes-live-open-${PORT}`)
const SERVER_HOST = normalizeServerHost(process.env.AES_REAL_SERVER || "free1.airlinesim.aero")
const DASHBOARD_URL = process.env.AES_TEST_DASHBOARD_URL
    || `https://${SERVER_HOST}/app/enterprise/dashboard?qa-live-open=1`

const LOGIN_EMAIL = process.env.AES_LOGIN_EMAIL || ""
const LOGIN_PASSWORD = process.env.AES_LOGIN_PASSWORD || ""

fs.mkdirSync(PROFILE_DIR, { recursive: true })

const chromeProcess = spawn(findChrome(), [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    DASHBOARD_URL
], {
    detached: true,
    stdio: "ignore"
})
chromeProcess.unref()

let browser = null
try {
    await waitForCdp(PORT, 30000)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    const context = browser.contexts()[0]
    if (!context) throw new Error(`No browser context on port ${PORT}`)
    const page = context.pages().find(p => /airlinesim\.aero/.test(p.url()))
        || context.pages()[0]
        || await context.newPage()

    page.setDefaultTimeout(60000)
    const loggedIn = await loginIfNeeded(page)
    await gotoDomContentLoaded(page, DASHBOARD_URL)
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
    await page.waitForSelector(".aes-menu__trigger, #aes-central-hub", { timeout: 45000 })

    console.log(JSON.stringify({
        ok: true,
        loggedIn,
        remoteDebuggingPort: PORT,
        profileDir: PROFILE_DIR,
        url: page.url(),
        title: await page.title().catch(() => "")
    }, null, 2))
    process.exit(0)
} catch (err) {
    console.error(JSON.stringify({
        ok: false,
        remoteDebuggingPort: PORT,
        profileDir: PROFILE_DIR,
        error: err && err.stack ? err.stack : String(err)
    }, null, 2))
    process.exit(1)
}

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : `${raw}.airlinesim.aero`
}

function findChrome() {
    const candidates = [
        process.env.CHROME_BIN,
        "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        chromium.executablePath()
    ].filter(Boolean)
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate
    }
    throw new Error("No Chrome executable found")
}

async function loginIfNeeded(page) {
    await gotoDomContentLoaded(page, DASHBOARD_URL)
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
    const needsLogin = /\/auth\/login|\/app\/login/i.test(page.url())
        || await page.locator("input[type='password']").count().catch(() => 0) > 0
    if (!needsLogin) return false
    if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
        throw new Error("Live login requires AES_LOGIN_EMAIL and AES_LOGIN_PASSWORD")
    }

    await gotoDomContentLoaded(page, "https://www.airlinesim.aero/auth/login")
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first()
    await loginInput.fill(LOGIN_EMAIL)
    await page.locator("input[type='password']").first().fill(LOGIN_PASSWORD)

    const submit = page.locator(
        "button[type='submit'], input[type='submit'], button:has-text(\"Log in\")"
    ).first()
    await Promise.all([
        page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), { timeout: 60000 }).catch(() => null),
        submit.click()
    ])
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {})
    if (/\/auth\/login|\/app\/login/i.test(page.url())) {
        const details = await page.locator(".form-error, .alert, .error, [class*='error']")
            .allTextContents({ timeout: 2000 })
            .catch(() => [])
        throw new Error("Login did not leave the AirlineSim auth page"
            + (details.length ? `: ${details.join(" | ").slice(0, 500)}` : ""))
    }
    return true
}

async function gotoDomContentLoaded(page, url) {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(err => {
        if (!/ERR_ABORTED/.test(String(err))) throw err
    })
}

async function waitForCdp(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`)
            if (res.ok) return
        } catch (_) {
            // keep polling
        }
        await sleep(250)
    }
    throw new Error(`Chrome did not open CDP on port ${port}`)
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function findAvailableDebugPort(start, attempts = 100) {
    const first = Number.isFinite(start) && start > 0 ? Math.floor(start) : 9222
    for (let port = first; port < first + attempts; port += 1) {
        if (await isPortAvailable(port)) return port
    }
    throw new Error(`No available remote debugging port in ${first}-${first + attempts - 1}`)
}

function isPortAvailable(port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once("error", () => resolve(false))
        server.once("listening", () => server.close(() => resolve(true)))
        server.listen(port, "127.0.0.1")
    })
}
