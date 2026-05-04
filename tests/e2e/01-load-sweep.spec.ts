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
    test.setTimeout(120000)

    const extPath = path.resolve(__dirname, "..", "..")
    const scenarios = [
        {
            name: "fresh profile / missing settings",
            seedStorage: null,
            urls: URLS,
        },
        {
            name: "corrupted shared caches",
            seedStorage: {
                settings: "corrupt-settings-blob",
                "free1CFLAIRflightInfo12345": null,
                "free1flightInfo12345": "old-corrupt-flight-info",
            },
            urls: URLS,
        },
    ]

    for (const scenario of scenarios) {
        const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "aes-load-sweep-"))
        const ctx = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${extPath}`,
                `--load-extension=${extPath}`,
            ],
        })

        try {
            if (scenario.seedStorage) {
                const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", {timeout: 10000})
                await worker.evaluate(async (items) => {
                    await chrome.storage.local.set(items)
                }, scenario.seedStorage)
            }

            await ctx.route("https://free1.airlinesim.aero/**", route => route.fulfill({
                status: 200,
                contentType: "text/html",
                body: fixturePage(),
            }))

            const failures: string[] = []
            for (const url of scenario.urls) {
                const page = await ctx.newPage()
                const errors: string[] = []
                page.on("pageerror", err => errors.push(`pageerror: ${err.message}`))
                page.on("console", msg => {
                    if (msg.type() === "error") {
                        errors.push(`console.error: ${msg.text()}`)
                    }
                })

                await page.goto(url, {waitUntil: "domcontentloaded"})
                await page.waitForSelector(".aes-menu__trigger", {timeout: 10000})

                if (url.includes("/app/enterprise/dashboard")) {
                    await page.waitForSelector("#aes-central-hub", {timeout: 10000})
                }

                const status = await getAesBootStatus(page)

                const failed = status && Array.isArray(status.failed) ? status.failed : []
                const skippedAnchors = status && Array.isArray(status.skippedAnchors) ? status.skippedAnchors : []
                if (failed.length) {
                    errors.push(`AesBoot failed: ${failed.map((row: any) => `${row.id}:${row.reason || row.error || ""}`).join(", ")}`)
                }
                if (!skippedAnchors.some((row: any) => row.id === "test-intentional-missing-anchor")) {
                    errors.push("AesBoot skippedAnchors did not include intentional missing anchor")
                }

                if (errors.length) {
                    failures.push(`${scenario.name}: ${url}\n${errors.map(err => `  ${err}`).join("\n")}`)
                }
                await page.close()
            }

            expect(failures, failures.join("\n\n")).toEqual([])
        } finally {
            await ctx.close().catch(() => {})
            fs.rmSync(profileDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
        }
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

async function getAesBootStatus(page: any) {
    const session = await page.context().newCDPSession(page)
    const contexts: any[] = []
    session.on("Runtime.executionContextCreated", (event: any) => {
        contexts.push(event.context)
    })
    await session.send("Runtime.enable")
    await page.waitForTimeout(100)

    try {
        for (const context of contexts) {
            const probe = await session.send("Runtime.evaluate", {
                contextId: context.id,
                expression: "typeof AesBoot !== 'undefined' && !!AesBoot.__aesBoot",
                returnByValue: true,
            }).catch(() => null)
            if (!probe || !probe.result || !probe.result.value) continue

            const evaluated = await session.send("Runtime.evaluate", {
                contextId: context.id,
                awaitPromise: true,
                returnByValue: true,
                expression: `;(async function(){
                    AesBoot.register({
                        id: "test-intentional-missing-anchor",
                        matches: function(){ return true },
                        anchor: "#aes-intentional-missing-anchor",
                        anchorTimeoutMs: 50,
                        init: function(){
                            throw new Error("intentional missing anchor should skip before init")
                        }
                    });
                    var deadline = Date.now() + 1500;
                    while (Date.now() < deadline) {
                        var current = AesBoot.status();
                        if (current.skippedAnchors.some(function(row){
                            return row.id === "test-intentional-missing-anchor";
                        })) {
                            return current;
                        }
                        await new Promise(function(resolve){ setTimeout(resolve, 50); });
                    }
                    return AesBoot.status();
                })()`,
            })
            return evaluated.result.value
        }
        return null
    } finally {
        await session.detach().catch(() => {})
    }
}
