import { chromium } from "playwright"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const root = path.resolve(new URL("..", import.meta.url).pathname)
const extensionPath = root
const profileDir = process.env.AES_LIVE_PROFILE
    || path.join(os.tmpdir(), "aes-live-login-profile")
const startUrl = process.env.AES_LIVE_START_URL
    || "https://free1.airlinesim.aero/app/enterprise/dashboard"
let email = process.env.AES_E2E_EMAIL || process.env.AES_LOGIN_EMAIL || ""
let password = process.env.AES_E2E_PASSWORD || process.env.AES_LOGIN_PASSWORD || ""
const startPort = Number(process.env.AES_REMOTE_DEBUGGING_PORT || "9222") || 9222
const remoteDebuggingPort = await findAvailablePort(startPort)

if (!email || !password) {
    throw new Error("Set AES_E2E_EMAIL and AES_E2E_PASSWORD for live login")
}
delete process.env.AES_E2E_EMAIL
delete process.env.AES_LOGIN_EMAIL
delete process.env.AES_E2E_PASSWORD
delete process.env.AES_LOGIN_PASSWORD

fs.mkdirSync(profileDir, {recursive: true})

const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: {width: 1440, height: 1000},
    args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--remote-debugging-port=${remoteDebuggingPort}`,
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

await page.goto(startUrl, {waitUntil: "domcontentloaded"}).catch(err => {
    if (!/ERR_ABORTED/.test(String(err))) throw err
})
await page.waitForLoadState("networkidle").catch(() => {})

const needsLogin = /\/auth\/login/i.test(page.url())
    || await page.locator("input[type='password']").count().catch(() => 0) > 0
if (needsLogin) {
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
    password = ""
    const submit = page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in'), button:has-text('Login')").first()
    if (await submit.count().catch(() => 0)) await submit.click()
    else await passwordInput.press("Enter")
    await page.waitForURL(url => !/\/auth\/login/i.test(url.pathname), {timeout: 60000}).catch(() => {})
    await page.waitForLoadState("networkidle").catch(() => {})
}

if (/\/auth\/login/i.test(page.url())) {
    throw new Error("Login did not leave /auth/login")
}

await page.goto(startUrl, {waitUntil: "domcontentloaded"}).catch(err => {
    if (!/ERR_ABORTED/.test(String(err))) throw err
})
await page.waitForLoadState("networkidle").catch(() => {})

console.log(JSON.stringify({
    ok: true,
    url: page.url(),
    title: await page.title().catch(() => ""),
    profileDir,
    remoteDebuggingPort
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
