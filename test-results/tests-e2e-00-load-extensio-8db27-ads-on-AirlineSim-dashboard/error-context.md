# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/e2e/00-load-extension.spec.ts >> AES extension loads on AirlineSim dashboard
- Location: tests/e2e/00-load-extension.spec.ts:17:5

# Error details

```
Error: browserType.launchPersistentContext: Target page, context or browser has been closed
Browser logs:

╔════════════════════════════════════════════════════════════════════════════════════════════════╗
║ Looks like you launched a headed browser without having a XServer running.                     ║
║ Set either 'headless: true' or use 'xvfb-run <your-playwright-app>' before running Playwright. ║
║                                                                                                ║
║ <3 Playwright Team                                                                             ║
╚════════════════════════════════════════════════════════════════════════════════════════════════╝
Call log:
  - <launching> /home/jules/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --enable-automation --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --no-sandbox --disable-extensions-except=/app --load-extension=/app --user-data-dir=/tmp/aes-e2e-profile-Xcju8K --remote-debugging-pipe about:blank
  - <launched> pid=119955
  - [pid=119955][err] [119955:119955:0506/155709.890098:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:256] Missing X server or $DISPLAY
  - [pid=119955][err] [119955:119955:0506/155709.890179:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.
  - [pid=119955] <gracefully close start>
  - [pid=119955] <kill>
  - [pid=119955] <will force kill>
  - [pid=119955] <process did exit: exitCode=1, signal=null>
  - [pid=119955] starting temporary directories cleanup
  - [pid=119955] finished temporary directories cleanup
  - [pid=119955] <gracefully close end>

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
  8  |  * Smoke 00 — verify the AES extension loads on the AS dashboard and
  9  |  * mounts its top-menu surface.
  10 |  *
  11 |  * Defaults to a mocked AirlineSim dashboard served at a real matching
  12 |  * `https://*.airlinesim.aero/app/enterprise/dashboard*` URL. That keeps
  13 |  * extension content-script matching intact while avoiding login state.
  14 |  *
  15 |  * Set AES_TEST_LIVE=1 to point the same smoke at a logged-in AS profile.
  16 |  */
  17 | test("AES extension loads on AirlineSim dashboard", async () => {
  18 |     const extPath = path.resolve(__dirname, "..", "..")
  19 |     const live = process.env.AES_TEST_LIVE === "1"
  20 |     const tmpProfile = live ? "" : fs.mkdtempSync(path.join(os.tmpdir(), "aes-e2e-profile-"))
  21 |     const profileDir = process.env.AES_TEST_PROFILE || tmpProfile || path.resolve(__dirname, ".profile")
  22 |     const dashboardUrl = process.env.AES_TEST_DASHBOARD_URL
  23 |         || "https://free1.airlinesim.aero/app/enterprise/dashboard?aes-fixture=1"
  24 |
> 25 |     const ctx = await chromium.launchPersistentContext(profileDir, {
     |                 ^ Error: browserType.launchPersistentContext: Target page, context or browser has been closed
  26 |         headless: false,
  27 |         args: [
  28 |             `--disable-extensions-except=${extPath}`,
  29 |             `--load-extension=${extPath}`,
  30 |         ],
  31 |     })
  32 |
  33 |     try {
  34 |         if (!live) {
  35 |             await installMockAirlineSimRoutes(ctx)
  36 |         }
  37 |
  38 |         const page = await ctx.newPage()
  39 |         await page.goto(dashboardUrl, {waitUntil: "domcontentloaded"})
  40 |
  41 |         // Top-menu surface is the cheapest "extension is alive" signal.
  42 |         // Mounted by modules/aes-menu.js after the AES content scripts run.
  43 |         await expect(page.locator(".aes-menu__trigger", {hasText: "AES"}).first())
  44 |             .toBeVisible({timeout: 10000})
  45 |
  46 |         // Central Hub shell mounts on the dashboard. Confirms the substrate
  47 |         // load order survived.
  48 |         await expect(page.locator("#aes-central-hub").first())
  49 |             .toBeVisible({timeout: 10000})
  50 |         await expect(page.locator(".aes-central-hub-tile[data-tile-id]").first())
  51 |             .toBeVisible({timeout: 10000})
  52 |     } finally {
  53 |         await ctx.close().catch(() => {})
  54 |         if (!live && tmpProfile) {
  55 |             fs.rmSync(tmpProfile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})
  56 |         }
  57 |     }
  58 | })
  59 |
```