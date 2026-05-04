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
