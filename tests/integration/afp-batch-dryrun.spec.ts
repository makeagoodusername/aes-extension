import { chromium, test, expect } from "@playwright/test"
import path from "path"

/**
 * Cross-territory integration smoke — Agents 4 + 7.
 *
 * Goal: prove that AFP Auto-build → Apply-all in dry-run mode produces
 * ZERO POSTs to AS. Locks down the SACRED PATH invariant from
 * F4-001 (form-driver no-auto-submit) and the Tier 1 zero-POST guarantee
 * from F4-006.
 *
 * STATUS: scaffolded, NOT YET RUNNABLE. Blocked on logged-in AS profile.
 *
 * Strategy: open AFP page, click Auto-build, click Apply-all. The whole
 * batch-apply pipeline goes through `_background/afp-submit-queue.js`,
 * which messages the AFP tab via `aes:afp:fill-and-submit`. In dry-run
 * mode the form-driver MUST NOT call `submitBtn.click()`. Network
 * monitor watches every request; assertion fails if any non-GET hits
 * `/app/aircraft/.../flightplan` during the run.
 */
test.skip("AFP batch apply (dry-run) emits zero AS POSTs", async () => {
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

    // POST monitor: any non-GET to AS during the run is a violation.
    const posts: string[] = []
    page.on("request", req => {
        if (req.method() !== "GET" && /airlinesim\.aero/.test(req.url())) {
            posts.push(req.method() + " " + req.url())
        }
    })

    await page.goto("https://www.airlinesim.aero/app/fleets")

    // 1. Click an aircraft row to open AFP page.
    // 2. Click Auto-build (route-candidates panel).
    // 3. Click Apply-all in dry-run mode.
    // 4. Wait for `auto-apply:done` bus event.
    // 5. Assert `posts.length === 0`.
    //
    // Implementation deferred to a session with a logged-in AS account.

    expect(posts).toEqual([])
    await ctx.close()
})
