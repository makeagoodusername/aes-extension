"use strict"

const {test, expect} = require("@playwright/test")

test.use({
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: {width: 1440, height: 1000}
})

function captureErrors(page, base) {
    const errors = []
    page.on("pageerror", err => errors.push("pageerror: " + (err && err.message || String(err))))
    page.on("console", msg => {
        if (msg.type() === "error") errors.push("console: " + msg.text())
    })
    page.on("response", resp => {
        const url = resp.url()
        if (url.indexOf(base) === 0 && resp.status() >= 400) {
            errors.push("http " + resp.status() + ": " + url)
        }
    })
    page.on("requestfailed", req => {
        const failure = req.failure()
        errors.push("requestfailed: " + req.method() + " " + req.resourceType() + " "
            + req.url() + " :: " + (failure && failure.errorText || "unknown"))
    })
    return errors
}

function isLocalTimeoutError(err, base) {
    if (!/net::ERR_CONNECTION_TIMED_OUT/i.test(String(err || ""))) return false
    if (/^console: Failed to load resource:/i.test(err)) return true
    return String(err).indexOf(base) >= 0
}

function onlyLocalTimeoutErrors(errors, base) {
    return errors.length > 0 && errors.every(err => isLocalTimeoutError(err, base))
}

async function gotoHarnessPage(page, base, path, errors, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        errors.length = 0
        await page.goto(base + path, {waitUntil: "domcontentloaded"})
        await page.waitForTimeout(750)
        if (!onlyLocalTimeoutErrors(errors, base) || attempt === attempts - 1) return
    }
}

test("dashboard harness pages load cleanly in Chrome", async ({browser}) => {
    test.slow()
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const paths = [
        "/tools/dashboard-harness.html",
        "/tools/dashboard-harness-t2.html",
        "/tools/dashboard-harness-t3.html",
        "/tools/dashboard-harness-t4.html",
        "/tools/dashboard-harness-t5.html",
        "/tools/dashboard-harness-t6.html"
    ]
    const allErrors = []

    for (const path of paths) {
        const page = await browser.newPage({viewport: {width: 1440, height: 1000}})
        const errors = captureErrors(page, base)
        try {
            await gotoHarnessPage(page, base, path, errors)
            allErrors.push(...errors.map(err => path + " :: " + err))
        } finally {
            await page.close()
        }
    }

    expect(allErrors).toEqual([])
})

test("dashboard T6 expands every Central Hub tile in Chrome", async ({page}) => {
    test.slow()
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)

    await page.addInitScript(() => {
        window.__t6_preloadStorage = {
            "centralHub:settings": {
                activeSection: "fleet",
                expandedTiles: [],
                cascadePromptDismissed: true,
                layoutMode: "classic"
            }
        }
    })
    await page.goto(base + "/tools/dashboard-harness-t6.html", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() =>
        !!window.__aesCentralHub
        && !!window.__aesCentralHub.tilesById
        && window.__aesCentralHub.tilesById.size > 0)

    const outcomes = await page.evaluate(async () => {
        const shell = window.__aesCentralHub
        const rows = []
        const brokenPattern = /\[object [^\]]+\]|\bundefined\b|\bNaN\b|\bInfinity\b/i
        for (const [id, tile] of shell.tilesById.entries()) {
            if (!tile.expanded && typeof tile.toggle === "function") tile.toggle()
            if (typeof tile._renderBodySafe === "function") await tile._renderBodySafe()
            await new Promise(resolve => setTimeout(resolve, 20))
            const root = document.getElementById("aes-central-hub-tile-" + id)
            const body = root && root.querySelector(".aes-central-hub-tile__body")
            const text = body ? (body.textContent || "").trim() : ""
            const broken = text.match(brokenPattern)
            rows.push({
                id,
                expanded: !!tile.expanded,
                hasBody: !!body,
                textLength: text.length,
                brokenValue: broken ? broken[0] : null
            })
        }
        return rows
    })

    expect(outcomes.length).toBeGreaterThanOrEqual(30)
    expect(outcomes.filter(row => !row.expanded || !row.hasBody || row.textLength === 0)).toEqual([])
    expect(outcomes.filter(row => row.brokenValue)).toEqual([])
    expect(errors).toEqual([])
})

test("dashboard T6 Mainboard shows seeded scrape readiness", async ({page}) => {
    test.slow()
    const base = process.env.AES_HARNESS_BASE || "http://127.0.0.1:8765"
    const errors = captureErrors(page, base)

    await page.addInitScript(() => {
        const now = Date.now()
        const weekId = "2026-W18"
        window.__t6_preloadStorage = {
            "centralHub:settings": {
                activeSection: "fleet",
                expandedTiles: ["mainboard"],
                cascadePromptDismissed: true,
                layoutMode: "classic"
            },
            "scrapeOrchestrator:phase:TEST:AB:foundation": {
                phaseId: "foundation",
                completedAt: now - 30 * 60 * 1000,
                total: 10,
                succeeded: 10,
                failed: 0
            },
            "scrapeOrchestrator:phase:TEST:AB:per-hub": {
                phaseId: "per-hub",
                completedAt: now - 8 * 60 * 60 * 1000,
                total: 2,
                succeeded: 2,
                failed: 0
            },
            "scrapeOrchestrator:lastRun": {
                runId: "seed-run",
                source: "manual",
                startedAt: now - 15 * 60 * 1000,
                completedAt: now - 10 * 60 * 1000,
                durationMs: 5 * 60 * 1000,
                aborted: false,
                perPhase: {
                    foundation: {label: "Foundation", total: 10, succeeded: 10, failed: 0},
                    "per-hub": {label: "Per-hub scheduling", total: 2, succeeded: 1, failed: 1}
                },
                failedJobs: [{
                    phaseId: "per-hub",
                    jobId: "per-hub-JFK",
                    url: "/app/com/scheduling/JFK",
                    error: "seed failure"
                }]
            },
            "routeAssistant:topRoutes:JFK": {
                hub: "JFK",
                scrapedAt: now - 20 * 60 * 1000,
                rows: [{
                    destIata: "LAX",
                    destName: "Los Angeles",
                    weeklyFlights: 7,
                    snapshotAt: now - 20 * 60 * 1000,
                    orsScrapedAt: now - 6 * 60 * 60 * 1000
                }]
            },
            "TESTABaircraftFleet": {
                server: "TEST",
                airline: "AB",
                type: "aircraftFleet",
                scrapedAt: now - 20 * 60 * 1000,
                fleet: [{
                    aircraftId: "100",
                    registration: "N100AB",
                    equipment: "A320",
                    typeId: 1,
                    date: "20260503",
                    time: "12:00"
                }]
            },
            "aircraftFlightPlan:maintenance:TEST:100": {
                server: "TEST",
                aircraftId: "100",
                scrapedAt: now - 20 * 60 * 1000,
                ratio: 100,
                condition: 100
            },
            "aircraftFlightPlan:flightLog:TEST:100": {
                server: "TEST",
                aircraftId: "100",
                scrapedAt: now - 20 * 60 * 1000,
                flights: []
            },
            "TESTABaccounting:index": [{
                weekId,
                weekClosesAt: "20260503",
                scrapedAt: now - 20 * 60 * 1000,
                hasIncome: true,
                hasBalance: true,
                hasBank: true
            }],
            ["TESTABaccounting:income:" + weekId]: {
                weekId,
                type: "income",
                scrapedAt: now - 20 * 60 * 1000,
                payload: {totals: {netResult: 1000, bankBalance: 200000}, rows: []}
            },
            ["TESTABaccounting:balance:" + weekId]: {
                weekId,
                type: "balance",
                scrapedAt: now - 20 * 60 * 1000,
                payload: {rows: []}
            },
            ["TESTABaccounting:bank:" + weekId]: {
                weekId,
                type: "bank",
                scrapedAt: now - 20 * 60 * 1000,
                payload: {cashBalance: 200000, rows: []}
            }
        }
    })

    await page.goto(base + "/tools/dashboard-harness-t6.html", {waitUntil: "domcontentloaded"})
    await page.waitForFunction(() =>
        !!window.__aesCentralHub
        && !!window.__aesCentralHub.tilesById
        && window.__aesCentralHub.tilesById.has("mainboard")
        && document.querySelector("#aes-central-hub-tile-mainboard .aes-central-hub-tile__body"))

    const text = (await page.locator("#aes-central-hub-tile-mainboard").innerText()).toLowerCase()
    expect(text).toContain("mainboard")
    expect(text).toContain("foundation")
    expect(text).toContain("fresh")
    expect(text).toContain("per-hub scheduling")
    expect(text).toContain("stale")
    expect(text).toContain("failed jobs")
    expect(text).toContain("1 failed")
    expect(errors).toEqual([])
})
