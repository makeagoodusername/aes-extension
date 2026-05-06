import { chromium, test, expect } from "@playwright/test"
import fs from "fs"
import os from "os"
import path from "path"
import { installMockAirlineSimRoutes } from "../support/airlinesim-fixtures"

/**
 * Smoke 00 — verify the AES extension loads on the AS dashboard and
 * mounts its top-menu surface.
 *
 * Defaults to a mocked AirlineSim dashboard served at a real matching
 * `https://*.airlinesim.aero/app/enterprise/dashboard*` URL. That keeps
 * extension content-script matching intact while avoiding login state.
 *
 * Set AES_TEST_LIVE=1 to point the same smoke at a logged-in AS profile.
 */
test("AES extension loads on AirlineSim dashboard", async () => {
    const extPath = path.resolve(__dirname, "..", "..")
    const live = process.env.AES_TEST_LIVE === "1"
    const tmpProfile = live ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "aes-e2e-profile-"))
    const profileDir = process.env.AES_TEST_PROFILE || tmpProfile || path.resolve(__dirname, ".profile")
    const dashboardUrl = process.env.AES_TEST_DASHBOARD_URL
        || "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=1"

    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        args: [
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
        ],
    })

    try {
        if (!live) {
            await installMockAirlineSimRoutes(ctx)
        }

        const page = await ctx.newPage()
        await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"})

        // Top-menu surface is the cheapest "extension is alive" signal.
        // Mounted by modules/aes-menu.js after the AES content scripts run.
        await expect(page.locator(".aes-menu__trigger", {hasText: "AES"}).first())
            .toBeVisible({timeout: 10000})

        // Central Hub shell mounts on the dashboard. Confirms the substrate
        // load order survived.
        await expect(page.locator("#aes-central-hub").first())
            .toBeVisible({timeout: 10000})
        await expect(page.locator(".aes-central-hub-tile[data-tile-id]").first())
            .toBeVisible({timeout: 10000})
    } finally {
        await ctx.close().catch(() => {})
        if (!live && tmpProfile) {
            fs.rmSync(tmpProfile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
        }
    }
})
