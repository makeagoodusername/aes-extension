import { chromium } from "playwright"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(new URL("..", import.meta.url).pathname)
const START_PORT = Number(process.env.AES_REMOTE_DEBUG_PORT || 9222)
const PROFILE = process.env.AES_TEST_PROFILE
    || fs.mkdtempSync(path.join(os.tmpdir(), "aes-live-login-profile-"))
const DASHBOARD_URL = process.env.AES_TEST_DASHBOARD_URL
    || "https://free1.airlinesim.aero/app/enterprise/dashboard"
const CHROME = process.env.CHROME_EXECUTABLE || process.env.CHROME_BIN || chromium.executablePath()

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

async function readStdinCredentials() {
    const chunks = []
    for await (const chunk of process.stdin) {
        chunks.push(String(chunk))
        if (chunks.join("").split(/\r?\n/).filter(Boolean).length >= 2) break
    }
    const values = chunks.join("").split(/\r?\n/).filter(Boolean)
    return {
        email: values[0] || "",
        password: values[1] || "",
    }
}

function cdpJson(port, pathName) {
    return new Promise((resolve, reject) => {
        const req = http.get({
            hostname: "127.0.0.1",
            port,
            path: pathName,
            timeout: 1000,
        }, res => {
            let body = ""
            res.setEncoding("utf8")
            res.on("data", chunk => { body += chunk })
            res.on("end", () => {
                try { resolve(JSON.parse(body)) }
                catch (err) { reject(err) }
            })
        })
        req.on("error", reject)
        req.on("timeout", () => {
            req.destroy(new Error("CDP probe timed out"))
        })
    })
}

async function waitForCdp(port) {
    const deadline = Date.now() + 20000
    let lastError = null
    while (Date.now() < deadline) {
        try {
            return await cdpJson(port, "/json/version")
        } catch (err) {
            lastError = err
            await new Promise(resolve => setTimeout(resolve, 300))
        }
    }
    throw lastError || new Error("CDP did not become ready")
}

function launchChrome(port) {
    const args = [
        `--user-data-dir=${PROFILE}`,
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        `--remote-debugging-port=${port}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check",
        DASHBOARD_URL,
    ]
    const child = spawn(CHROME, args, {
        detached: true,
        stdio: "ignore",
    })
    child.unref()
    return child.pid
}

async function login(page, credentials) {
    await page.goto("https://www.airlinesim.aero/auth/login", {waitUntil: "domcontentloaded", timeout: 60000})
    await page.locator("input[name='login'], input[type='email']").first().waitFor({state: "visible", timeout: 30000})
    await page.locator("input[name='login'], input[type='email']").first().fill(credentials.email)
    await page.locator("input[type='password'], input[name='password']").first().fill(credentials.password)
    const form = page.locator("form").filter({has: page.locator("input[type='password']")}).first()
    const submit = form.locator("button[type='submit'], input[type='submit']").first()
    if (await submit.count()) await submit.click()
    else await page.locator("input[type='password'], input[name='password']").first().press("Enter")
    await page.waitForLoadState("domcontentloaded", {timeout: 30000}).catch(() => {})
    await page.waitForTimeout(2000)
    if (/\/auth\/login/.test(page.url())
            || await page.locator("input[type='password']").count().catch(() => 0) > 0) {
        throw new Error("AirlineSim login did not complete")
    }
}

async function main() {
    const credentials = await readStdinCredentials()
    if (!credentials.email || !credentials.password) {
        throw new Error("Expected email and password on stdin, one per line")
    }
    const port = await findAvailableDebugPort(START_PORT)
    const pid = launchChrome(port)
    await waitForCdp(port)

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0] || await browser.newContext()
    const page = context.pages()[0] || await context.newPage()
    await login(page, credentials)
    await page.goto(DASHBOARD_URL, {waitUntil: "domcontentloaded", timeout: 60000})
    await page.waitForSelector(".aes-menu__trigger", {timeout: 30000})
    await page.bringToFront()
    await browser.close()

    console.log(JSON.stringify({
        ok: true,
        remoteDebuggingPort: port,
        pid,
        profile: PROFILE,
        url: DASHBOARD_URL,
        extensionLoaded: true,
    }, null, 2))
}

main().catch(err => {
    console.error(err && err.stack || err)
    process.exit(1)
})
