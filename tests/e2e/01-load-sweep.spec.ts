import { chromium, test, expect } from "@playwright/test"
import fs from "fs"
import os from "os"
import path from "path"

const URLS = [
    "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-sweep=1",
    "https://free1.airlinesim.aero/app/enterprise/settings?aes-sweep=1",
    "https://free1.airlinesim.aero/app/finance/accounting?aes-sweep=1",
    "https://free1.airlinesim.aero/app/aircraft/market?aes-sweep=1",
    "https://free1.airlinesim.aero/app/com/scheduling/ICN?aes-sweep=1",
    "https://free1.airlinesim.aero/app/com/inventory/123?aes-sweep=1",
    "https://free1.airlinesim.aero/app/com/markets/ICN?aes-sweep=1",
    "https://free1.airlinesim.aero/app/com/numbers?aes-sweep=1",
    "https://free1.airlinesim.aero/app/info/airports/ICN?aes-sweep=1",
    "https://free1.airlinesim.aero/app/info/enterprises/123?tab=3&aes-sweep=1",
    "https://free1.airlinesim.aero/app/fleets?aes-sweep=1",
    "https://free1.airlinesim.aero/app/fleets/aircraft/123/0?aes-sweep=1",
    "https://free1.airlinesim.aero/app/fleets/aircraft/123/1?aes-sweep=1",
    "https://free1.airlinesim.aero/action/enterprise/staffOverview?aes-sweep=1",
    "https://free1.airlinesim.aero/action/info/flight/123?aes-sweep=1",
]

test("AES content scripts load without page crashes across matched pages", async () => {
    test.setTimeout(90000)

    const extPath = path.resolve(__dirname, "..", "..")
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "aes-load-sweep-"))

    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: [
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
        ],
    })

    try {
        const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", {timeout: 10000})
        await worker.evaluate(async () => {
            await chrome.storage.local.set({
                settings: "corrupt-settings-blob",
                "free1CFLAIRflightInfo12345": null,
                "free1flightInfo12345": "old-corrupt-flight-info",
            })
        })

        await ctx.route("https://free1.airlinesim.aero/**", route => route.fulfill({
            status: 200,
            contentType: "text/html",
            body: fixturePage(),
        }))

        const failures: string[] = []
        for (const url of URLS) {
            const page = await ctx.newPage()
            const errors: string[] = []
            page.on("pageerror", err => errors.push(`pageerror: ${err.message}`))
            page.on("console", msg => {
                if (msg.type() === "error") {
                    errors.push(`console.error: ${msg.text()}`)
                }
            })

            await page.goto(url, {waitUntil: "domcontentloaded"})
            await page.waitForTimeout(1500)

            if (errors.length) {
                failures.push(`${url}\n${errors.map(err => `  ${err}`).join("\n")}`)
            }
            await page.close()
        }

        expect(failures, failures.join("\n\n")).toEqual([])
    } finally {
        await ctx.close().catch(() => {})
        fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
    }
})

function fixturePage() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AES Load Sweep</title>
</head>
<body>
  <div class="as-navbar-main">
    <a class="name" href="/app/enterprise/dashboard"><span>Casper Flight Logistics</span></a>
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
  <div class="as-navbar-bottom"><span>2026-05-03 12:34 UTC</span></div>
  <main id="main-content">
    <section id="enterprise-dashboard" class="as-page-dashboard">
      <h1>Enterprise Dashboard</h1>
      <table>
        <tbody>
          <tr><td>Airline</td><td>Casper Flight Logistics</td></tr>
          <tr><td>Code</td><td>CFL</td></tr>
          <tr><td>Company reputation</td><td>92</td></tr>
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`
}
