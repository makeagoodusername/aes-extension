import { chromium, test, expect } from "@playwright/test"
import fs from "fs"
import os from "os"
import path from "path"
import { installMockAirlineSimRoutes } from "../support/airlinesim-fixtures"

/**
 * Cross-territory integration smoke — Agent 6 (substrate / palette).
 *
 * Goal: dashboard → Cmd-K → verify live palette rows → "Go to Accounting"
 * dispatches to the accounting page. This uses the exact read-only flow
 * verified against the live Free1 dashboard on 2026-05-01.
 *
 * Also checks the F-AGENT6-001 follow-up: "Create Strategy Fork" should
 * appear in the default palette results on the dashboard.
 *
 * Defaults to mocked AS pages so the read-only command path is runnable
 * without a logged-in profile. Set AES_TEST_LIVE=1 to use a live profile.
 */
test("Cmd-K dispatch → Accounting page opens", async () => {
    const extPath = path.resolve(__dirname, "..", "..")
    const live = process.env.AES_TEST_LIVE === "1"
    const tmpProfile = live ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "aes-cmdk-profile-"))
    const profileDir = process.env.AES_TEST_PROFILE || tmpProfile || path.resolve(__dirname, ".profile")
    const dashboardUrl = process.env.AES_TEST_DASHBOARD_URL
        || "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=1"
    const modKey = process.platform === "darwin" ? "Meta" : "Control"

    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: [
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
        ],
    })

    try {
        if (!live) {
            await installMockAirlineSimRoutes(ctx)
        }

        const page = await ctx.newPage()
        await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"})

        await expect(page.locator(".aes-menu__trigger", {hasText: "AES"}).first())
            .toBeVisible({timeout: 10000})
        await expect(page.locator("#aes-central-hub").first())
            .toBeVisible({timeout: 10000})

        await page.keyboard.press(`${modKey}+K`)

        const palette = page.locator("#aes-command-palette")
        const paletteInput = page.locator("#aes-command-palette-input")
        const rows = page.locator("#aes-command-palette-list .row")

        await expect(palette).toBeVisible({timeout: 10000})
        await expect(paletteInput).toBeFocused()

        await paletteInput.fill("strategy fork")
        await expect(rows.filter({hasText: "Create Strategy Fork"}).first())
            .toBeVisible({timeout: 10000})

        await paletteInput.fill("go to accounting")
        await expect(rows.filter({hasText: "Go to Accounting"}))
            .toHaveCount(1, {timeout: 10000})

        await page.keyboard.press("Enter")
        await expect(page).toHaveURL(/\/app\/finance\/accounting(?:[?#].*)?$/)
    } finally {
        await ctx.close().catch(() => {})
        if (!live && tmpProfile) {
            fs.rmSync(tmpProfile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
        }
    }
})
