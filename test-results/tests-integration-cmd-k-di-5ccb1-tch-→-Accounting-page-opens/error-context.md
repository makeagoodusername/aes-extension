# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/integration/cmd-k-dispatch.spec.ts >> Cmd-K dispatch → Accounting page opens
- Location: tests/integration/cmd-k-dispatch.spec.ts:20:5

# Error details

```
Error: browserType.launchPersistentContext: Executable doesn't exist at /home/jules/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
```

# Test source

```ts
  1  | import { chromium, test, expect } from "@playwright/test"
  2  | import fs from "fs"
  3  | import os from "os"
  4  | import path from "path"
  5  | import { installMockAirlineSimRoutes } from "../support/airlinesim-fixtures"
  6  |
  7  | /**
  8  |  * Cross-territory integration smoke — Agent 6 (substrate / palette).
  9  |  *
  10 |  * Goal: dashboard → Cmd-K → verify live palette rows → "Go to Accounting"
  11 |  * dispatches to the accounting page. This uses the exact read-only flow
  12 |  * verified against the live Free1 dashboard on 2026-05-01.
  13 |  *
  14 |  * Also checks the F-AGENT6-001 follow-up: "Create Strategy Fork" should
  15 |  * appear in the default palette results on the dashboard.
  16 |  *
  17 |  * Defaults to mocked AS pages so the read-only command path is runnable
  18 |  * without a logged-in profile. Set AES_TEST_LIVE=1 to use a live profile.
  19 |  */
  20 | test("Cmd-K dispatch → Accounting page opens", async () => {
  21 |     const extPath = path.resolve(__dirname, "..", "..")
  22 |     const live = process.env.AES_TEST_LIVE === "1"
  23 |     const tmpProfile = live ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "aes-cmdk-profile-"))
  24 |     const profileDir = process.env.AES_TEST_PROFILE || tmpProfile || path.resolve(__dirname, ".profile")
  25 |     const dashboardUrl = process.env.AES_TEST_DASHBOARD_URL
  26 |         || "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=1"
  27 |     const modKey = process.platform === "darwin" ? "Meta" : "Control"
  28 |
> 29 |     const ctx = await chromium.launchPersistentContext(profileDir, {
     |                 ^ Error: browserType.launchPersistentContext: Executable doesn't exist at /home/jules/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell
  30 |         headless: true,
  31 |         args: [
  32 |             `--disable-extensions-except=${extPath}`,
  33 |             `--load-extension=${extPath}`,
  34 |             "--disable-features=DisableLoadExtensionCommandLineSwitch",
  35 |         ],
  36 |     })
  37 |
  38 |     try {
  39 |         if (!live) {
  40 |             await installMockAirlineSimRoutes(ctx)
  41 |         }
  42 |
  43 |         const page = await ctx.newPage()
  44 |         await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"})
  45 |
  46 |         await expect(page.locator(".aes-menu__trigger", {hasText: "AES"}).first())
  47 |             .toBeVisible({timeout: 10000})
  48 |         await expect(page.locator("#aes-central-hub").first())
  49 |             .toBeVisible({timeout: 10000})
  50 |
  51 |         await page.keyboard.press(`${modKey}+K`)
  52 |
  53 |         const palette = page.locator("#aes-command-palette")
  54 |         const paletteInput = page.locator("#aes-command-palette-input")
  55 |         const rows = page.locator("#aes-command-palette-list .row")
  56 |
  57 |         await expect(palette).toBeVisible({timeout: 10000})
  58 |         await expect(paletteInput).toBeFocused()
  59 |
  60 |         await paletteInput.fill("strategy fork")
  61 |         await expect(rows.filter({hasText: "Create Strategy Fork"}).first())
  62 |             .toBeVisible({timeout: 10000})
  63 |
  64 |         await paletteInput.fill("go to accounting")
  65 |         await expect(rows.filter({hasText: "Go to Accounting"}))
  66 |             .toHaveCount(1, {timeout: 10000})
  67 |
  68 |         await page.keyboard.press("Enter")
  69 |         await expect(page).toHaveURL(/\/app\/finance\/accounting(?:[?#].*)?$/)
  70 |     } finally {
  71 |         await ctx.close().catch(() => {})
  72 |         if (!live && tmpProfile) {
  73 |             fs.rmSync(tmpProfile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
  74 |         }
  75 |     }
  76 | })
  77 |
```