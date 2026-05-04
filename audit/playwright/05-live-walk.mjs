// Live walk: login, walk key surfaces, exercise per-class silent-auto on one
// route with pricing.apply.enabled=true. User-authorized override of the
// dry-run rule. Spawns its own Chrome on port 9300 to avoid colliding with
// Codex's session on 9274.
//
// Usage:
//   node audit/playwright/05-live-walk.mjs           # full walk + live apply
//   node audit/playwright/05-live-walk.mjs --no-apply # walk only, no live apply

import {chromium} from "playwright"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT_DIR   = path.resolve(__dirname, "../../")
const PROFILE   = path.resolve(__dirname, ".profile-live-walk")
const SHOTS     = path.resolve(__dirname, "screenshots/live-walk")
const CREDS     = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../credentials.json"), "utf8"))
const ARGV      = new Set(process.argv.slice(2))
const NO_APPLY  = ARGV.has("--no-apply")

fs.mkdirSync(SHOTS, {recursive: true})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log   = (...a) => console.log("[walk]", ...a)
const errors = []
const pageErrors = []

;(async () => {
    log(`mode=${NO_APPLY ? "walk-only" : "walk+apply"} ext=${EXT_DIR}`)
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        viewport: {width: 1400, height: 900},
        args: [
            `--disable-extensions-except=${EXT_DIR}`,
            `--load-extension=${EXT_DIR}`,
            "--remote-debugging-port=9300",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    })

    const pages = ctx.pages()
    const page = pages.length ? pages[0] : await ctx.newPage()

    page.on("console", msg => {
        const t = msg.type()
        const txt = msg.text()
        if (t === "error") {
            errors.push(txt)
            log(`console.error: ${txt.slice(0, 200)}`)
        } else if (/\[AES/.test(txt) || t === "warning") {
            log(`console.${t}: ${txt.slice(0, 200)}`)
        }
    })
    page.on("pageerror", err => {
        pageErrors.push(err.message)
        log(`pageerror: ${err.message}`)
    })

    await ensureLoggedIn(page)

    const results = {}
    results.dashboard = await walk(page, `https://${CREDS.server}/app/enterprise/dashboard`, "01-dashboard")
    results.fleets    = await walk(page, `https://${CREDS.server}/app/fleets`, "02-fleets")
    results.markets   = await walk(page, `https://${CREDS.server}/app/info/markets`, "03-markets")

    // Scheduling page — pick first available aircraft → first flight from hub.
    // We need a route to exercise the RA panel + pricing applier.
    const schedUrl = await pickSchedulingUrl(page)
    log(`scheduling URL: ${schedUrl}`)
    if (schedUrl) {
        results.scheduling = await walk(page, schedUrl, "04-scheduling")

        if (!NO_APPLY) {
            results.silentAuto = await exerciseSilentAuto(page)
        } else {
            log("skipping live apply (--no-apply)")
        }
    } else {
        log("⚠ no scheduling page found — skipping silent-auto")
    }

    // Final summary
    const summary = {
        timestamp: new Date().toISOString(),
        mode: NO_APPLY ? "walk-only" : "walk+apply",
        results,
        consoleErrorsCount: errors.length,
        pageErrorsCount: pageErrors.length,
        consoleErrors: errors.slice(0, 20),
        pageErrors: pageErrors.slice(0, 20),
    }
    fs.writeFileSync(path.join(SHOTS, "summary.json"), JSON.stringify(summary, null, 2))
    log("=== SUMMARY ===")
    log(JSON.stringify(summary, null, 2))

    log("leaving browser open for inspection. Ctrl+C to exit.")
    await new Promise(() => {})
})().catch(e => {
    log("FATAL:", e.message)
    log(e.stack)
    process.exit(1)
})

async function ensureLoggedIn(page) {
    log(`→ login`)
    await page.goto("https://www.airlinesim.aero/auth/login", {waitUntil: "domcontentloaded", timeout: 60000})
    await sleep(2500)
    if (!/auth\/login/.test(page.url())) {
        log("already logged in:", page.url())
        return
    }
    const result = await page.evaluate(({email, password}) => {
        const f = document.querySelector("form")
        if (!f) return "no-form"
        const u = f.querySelector('input[name="login"]')
        const p = f.querySelector('input[name="password"]')
        if (!u || !p) return "fields-missing"
        const setNative = (el, val) => {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set
            setter.call(el, val)
            el.dispatchEvent(new Event("input", {bubbles: true}))
            el.dispatchEvent(new Event("change", {bubbles: true}))
        }
        setNative(u, email); setNative(p, password)
        const btn = f.querySelector('button[type="submit"], input[type="submit"]')
        if (btn) btn.click(); else f.submit()
        return "submitted"
    }, {email: CREDS.email, password: CREDS.password})
    log("login result:", result)
    await page.waitForLoadState("domcontentloaded", {timeout: 30000}).catch(() => {})
    await sleep(4000)
    if (/auth\/login/.test(page.url())) {
        await page.screenshot({path: path.join(SHOTS, "00-login-failed.png"), fullPage: true})
        throw new Error("Login failed")
    }
    log("logged in:", page.url())
}

async function walk(page, url, label) {
    log(`→ ${label}: ${url}`)
    await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000}).catch(e => log("nav warn:", e.message))
    await sleep(3500)
    await page.screenshot({path: path.join(SHOTS, `${label}.png`), fullPage: true})
    const probe = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        hasAesMenu: !!document.querySelector('[data-aes-menu], .aes-menu, #aes-menu'),
        hasAesAfp: !!window.AesAfp,
        hasRaPanel: !!document.querySelector('.aes-ra-panel, [data-aes-ra-panel]'),
        hasPricingApplier: !!window.RouteAssistantPricingApplier,
        hasPerClassProposer: !!window.RouteAssistantPerClassProposer,
        buttonsVisible: Array.from(document.querySelectorAll("button"))
            .filter(b => b.offsetWidth || b.offsetHeight)
            .length,
        h1Count: document.querySelectorAll("h1").length,
    }))
    log(`${label}: ${JSON.stringify(probe)}`)
    return probe
}

async function pickSchedulingUrl(page) {
    // Go to fleets, find first aircraft, derive a scheduling URL from its first flight.
    await page.goto(`https://${CREDS.server}/app/fleets`, {waitUntil: "domcontentloaded"})
    await sleep(2500)
    const aircraftHref = await page.evaluate(() => {
        const a = document.querySelector('a[href*="/app/fleets/aircraft/"]')
        return a ? a.href : null
    })
    if (!aircraftHref) return null
    log(`first aircraft: ${aircraftHref}`)
    await page.goto(aircraftHref, {waitUntil: "domcontentloaded"})
    await sleep(2500)
    // Look for a scheduling/route link.
    const url = await page.evaluate(() => {
        // Try a /app/com/scheduling/ link directly
        const sched = document.querySelector('a[href*="/app/com/scheduling/"]')
        if (sched) return sched.href
        // Or pick a link to flight info that we can derive from
        const fi = document.querySelector('a[href*="/app/info/flights/"]')
        return fi ? fi.href : null
    })
    return url
}

async function exerciseSilentAuto(page) {
    log("=== SILENT-AUTO LIVE EXERCISE ===")
    // Read current state, set per-class strategy, capture before/after.
    const before = await page.evaluate(() => new Promise(resolve => {
        chrome.storage.local.get(null, all => {
            const s = (all.settings && all.settings.pricing) || {}
            resolve({
                silentAutoEnabled: s.silentAutoEnabled,
                silentAutoStrategy: s.silentAutoStrategy,
                applyEnabled: s.apply && s.apply.enabled,
                applyDryRunOnly: s.apply && s.apply.dryRunOnly,
                lastTickResult: s.silentAutoLastTickResult,
                hasPerClass: !!window.RouteAssistantPerClassProposer,
                hasApplier: !!window.RouteAssistantPricingApplier,
                hasAutomator: !!window.AesRoutePriceAutomator,
                hasCmdRegistry: !!window.AESCommandRegistry,
            })
        })
    }))
    log("before:", JSON.stringify(before))

    // Flip to per-class + enable apply.
    const flipped = await page.evaluate(() => new Promise(resolve => {
        chrome.storage.local.get(null, all => {
            const settings = all.settings || {}
            settings.pricing = settings.pricing || {}
            settings.pricing.silentAutoEnabled = true
            settings.pricing.silentAutoStrategy = "per-class-elasticity"
            settings.pricing.apply = settings.pricing.apply || {}
            const prevEnabled = settings.pricing.apply.enabled
            const prevDryRun = settings.pricing.apply.dryRunOnly
            settings.pricing.apply.enabled = true
            settings.pricing.apply.dryRunOnly = false
            chrome.storage.local.set({settings}, () => {
                resolve({ok: true, prevEnabled, prevDryRun})
            })
        })
    }))
    log("flipped:", JSON.stringify(flipped))

    // Trigger silentAutoTick via AESCommandRegistry.
    const tickResult = await page.evaluate(() => new Promise(resolve => {
        const reg = window.AESCommandRegistry
        if (!reg || typeof reg.run !== "function") {
            resolve({ok: false, error: "no AESCommandRegistry.run"}); return
        }
        try {
            const p = reg.run("action.silentAutoTick", {})
            if (p && typeof p.then === "function") {
                p.then(r => resolve({ok: true, result: r})).catch(e => resolve({ok: false, error: String(e)}))
            } else {
                resolve({ok: true, result: p})
            }
        } catch (e) { resolve({ok: false, error: String(e && e.message || e)}) }
        setTimeout(() => resolve({ok: false, error: "timeout"}), 60000)
    }))
    log("tickResult:", JSON.stringify(tickResult).slice(0, 500))

    await sleep(8000)

    const after = await page.evaluate(() => new Promise(resolve => {
        chrome.storage.local.get(null, all => {
            const s = (all.settings && all.settings.pricing) || {}
            resolve({
                lastTickResult: s.silentAutoLastTickResult,
                applyEnabled: s.apply && s.apply.enabled,
            })
        })
    }))
    log("after:", JSON.stringify(after).slice(0, 500))

    // RESTORE — turn apply back off.
    const restored = await page.evaluate(() => new Promise(resolve => {
        chrome.storage.local.get(null, all => {
            const settings = all.settings || {}
            settings.pricing = settings.pricing || {}
            settings.pricing.apply = settings.pricing.apply || {}
            settings.pricing.apply.enabled = false
            settings.pricing.apply.dryRunOnly = true
            settings.pricing.silentAutoEnabled = false
            chrome.storage.local.set({settings}, () => resolve({ok: true}))
        })
    }))
    log("restored:", JSON.stringify(restored))
    await page.screenshot({path: path.join(SHOTS, "05-after-silent-auto.png"), fullPage: true})

    return {before, flipped, tickResult, after, restored}
}
