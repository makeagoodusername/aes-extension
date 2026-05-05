import { chromium, test, expect } from "@playwright/test"
import path from "path"

/**
 * Cross-territory integration smoke — Agents 2 + 3.
 *
 * Goal: prove that clicking Apply on the Strategy modal at apply-on-confirm
 * tier produces a pricing-applier audit-log entry tagged with
 * `source: "strategy"`. This locks down the bus contract between
 * `modules/strategy/apply-pipeline.js` (lines 483 / _applyPriceMoves) and
 * `modules/route-assistant/pricing-applier.js`.
 *
 * STATUS: scaffolded, NOT YET RUNNABLE. Blocked on:
 *   - logged-in AS profile (see audit/SHARED-NOTES.md 2026-05-01 10:50)
 *   - F-A3-003 / F-8-006 user decision: should strategy honor RA's
 *     `pricing.apply.{enabled, dryRunOnly}` settings? If yes, the test
 *     setup must seed those settings to "live" before clicking Apply.
 *
 * Note: pricing-applier.apply() is real-write. This test takes a
 * SHARED-NOTES.md real-write lock before the click, releases after, and
 * runs against a designated scratch route only.
 */
test.skip("strategy apply → RA pricing applier audit log entry", async () => {
    const extPath = path.resolve(__dirname, "..", "..")
    const profileDir = process.env.AES_TEST_PROFILE
        || path.resolve(__dirname, ".profile")

    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: [
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
        ],
    })

    const page = await ctx.newPage()
    await page.goto("https://www.airlinesim.aero/app/enterprise/dashboard")

    // 1. Open Strategy modal, set tier to apply-on-confirm.
    // 2. Tick a single price decision on a scratch route.
    // 3. Click Apply, confirm modal.
    // 4. Read storage `routeAssistant:pricingApplyLog`, assert most-recent
    //    entry has `source: "strategy"`.
    //
    // Implementation deferred to a session with a logged-in AS account.

    await ctx.close()
})
