import { chromium, test, expect } from "@playwright/test"
import path from "path"

test("AES extension loads on Canopy Dashboard", async () => {
    const extPath = path.resolve(__dirname, "..", "..")

    const ctx = await chromium.launchPersistentContext("", {
        headless: true,
        args: [
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
        ],
    })

    try {
        const page = await ctx.newPage()
        await page.goto("http://127.0.0.1:8765/tools/dashboard-harness-t6.html", {waitUntil: "domcontentloaded"})

        await expect(page.locator("h3", {hasText: "Combined Canopy Overview"}).first())
            .toBeVisible({timeout: 10000})

        // Also check if expansion planner is available
        await expect(page.locator("h3", {hasText: "Regional Expansion Planner"}).first())
            .toBeVisible({timeout: 10000})

    } finally {
        await ctx.close().catch(() => {})
    }
})
