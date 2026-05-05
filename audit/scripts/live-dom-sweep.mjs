import { chromium } from "playwright"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname)
const credentialsPath = path.join(repoRoot, "audit", "credentials.json")
const outPath = process.env.AES_LIVE_SWEEP_OUT
    || path.join(repoRoot, "audit", "live-dom-sweep-report.json")
const port = process.env.AES_LIVE_CHROME_PORT || "9315"
const creds = JSON.parse(await readFile(credentialsPath, "utf8"))
const serverHost = normalizeServerHost(process.env.AES_LIVE_SERVER || creds.server || "free1.airlinesim.aero")
const modKey = process.platform === "darwin" ? "Meta" : "Control"

function normalizeServerHost(value) {
    const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
    if (!raw) return "free1.airlinesim.aero"
    return /\.airlinesim\.aero$/i.test(raw) ? raw : raw + ".airlinesim.aero"
}

function pageUrl(pagePath) {
    return `https://${serverHost}${pagePath}`
}

function summarizeEvents(events) {
    return events.filter(evt => evt.level === "error" || evt.kind === "pageerror")
}

async function snapshot(page, name) {
    return page.evaluate((pageName) => {
        const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || ""
        return {
            name: pageName,
            url: location.href,
            title: document.title,
            h1: txt("h1"),
            aesMenu: !!document.querySelector(".aes-menu__trigger"),
            aesNodes: document.querySelectorAll("[class*=aes-], [id*=aes-], [data-tile-id]").length,
            hub: !!document.querySelector("#aes-central-hub"),
            tiles: document.querySelectorAll(".aes-central-hub-tile[data-tile-id]").length,
            settingsShell: !!document.querySelector("#aes-unified-settings, .aes-unified-settings"),
            commandPalette: !!document.querySelector("#aes-command-palette"),
            tableRows: document.querySelectorAll("table tr").length,
            visibleText: document.body?.innerText?.slice(0, 600) || ""
        }
    }, name)
}

async function gotoAndSnapshot(page, name, pagePath, events) {
    const before = events.length
    await page.goto(pageUrl(pagePath), { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForTimeout(1000)
    const snap = await snapshot(page, name)
    snap.consoleErrors = summarizeEvents(events.slice(before))
    return snap
}

async function testDashboardInteractions(page, events) {
    const result = { name: "dashboard-interactions" }
    const before = events.length
    await page.goto(pageUrl("/app/enterprise/dashboard"), { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector(".aes-menu__trigger", { timeout: 15000 })

    await page.keyboard.press(`${modKey}+K`)
    await page.waitForSelector("#aes-command-palette.open", { timeout: 10000 })
    result.paletteOpenedByKeyboard = true
    result.defaultRows = await page.locator("#aes-command-palette-list .row").count()
    await page.locator("#aes-command-palette-input").fill("strategy fork")
    result.strategyForkRows = await page.locator("#aes-command-palette-list .row", { hasText: "Create Strategy Fork" }).count()
    await page.locator("#aes-command-palette-input").fill("go to accounting")
    result.accountingRows = await page.locator("#aes-command-palette-list .row", { hasText: "Go to Accounting" }).count()
    await page.keyboard.press("Escape")

    await page.locator(".aes-menu__trigger").first().click()
    await page.waitForTimeout(300)
    result.menuItems = await page.locator(".aes-menu__panel li").count()
    result.menuOpen = await page.locator(".aes-menu__panel").evaluate(el => getComputedStyle(el).display !== "none").catch(() => false)
    result.consoleErrors = summarizeEvents(events.slice(before))
    return result
}

async function testSettingsInteractions(page, events) {
    const result = { name: "settings-interactions" }
    const before = events.length
    await page.goto(pageUrl("/app/enterprise/settings"), { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle").catch(() => {})
    await page.waitForSelector("h1", { timeout: 15000 })
    result.h1 = await page.locator("h1").first().innerText().catch(() => "")
    const tabButtons = page.locator("button, [role='tab']")
    result.buttons = await tabButtons.count()
    const modulesButton = tabButtons.filter({ hasText: /Modules/i }).first()
    if (await modulesButton.count()) {
        await modulesButton.click()
        await page.waitForTimeout(300)
        result.clickedModules = true
    } else {
        result.clickedModules = false
    }
    result.checkboxes = await page.locator("input[type='checkbox']").count()
    result.consoleErrors = summarizeEvents(events.slice(before))
    return result
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const context = browser.contexts()[0]
if (!context) throw new Error(`No browser context on CDP port ${port}`)
const page = context.pages().find(p => !p.url().startsWith("devtools://")) || await context.newPage()
page.setDefaultTimeout(30000)

const events = []
page.on("console", msg => {
    events.push({ kind: "console", level: msg.type(), text: msg.text(), url: page.url() })
})
page.on("pageerror", err => {
    events.push({ kind: "pageerror", level: "error", text: err.message, url: page.url() })
})

const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    serverHost,
    port,
    pages: [],
    interactions: []
}

report.interactions.push(await testDashboardInteractions(page, events))
report.pages.push(await gotoAndSnapshot(page, "dashboard", "/app/enterprise/dashboard", events))
report.pages.push(await gotoAndSnapshot(page, "scheduling", "/app/com/scheduling", events))
report.pages.push(await gotoAndSnapshot(page, "flight-numbers", "/app/com/numbers", events))
report.pages.push(await gotoAndSnapshot(page, "markets", "/app/com/markets/JFKJFK", events))
report.pages.push(await gotoAndSnapshot(page, "ors", "/app/info/ors", events))
report.pages.push(await gotoAndSnapshot(page, "fleet-management", "/app/fleets", events))
report.pages.push(await gotoAndSnapshot(page, "inventory", "/app/com/inventory/JFKJFK", events))
report.pages.push(await gotoAndSnapshot(page, "accounting", "/app/finance/accounting", events))
report.pages.push(await gotoAndSnapshot(page, "cashflow", "/action/enterprise/schedule", events))
report.interactions.push(await testSettingsInteractions(page, events))
report.pages.push(await gotoAndSnapshot(page, "settings", "/app/enterprise/settings", events))

report.errorCount = report.pages.reduce((sum, p) => sum + p.consoleErrors.length, 0)
    + report.interactions.reduce((sum, p) => sum + p.consoleErrors.length, 0)
report.ok = report.errorCount === 0

await mkdir(path.dirname(outPath), { recursive: true })
await writeFile(outPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(0)
