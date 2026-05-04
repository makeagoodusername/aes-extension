// Live Playwright harness for the AES Route Builder.
// Launches Chromium with the AES extension loaded, logs in to AirlineSim
// if the persistent profile isn't authenticated, and stops on the first
// aircraft's AFP page so the harness can drive the Route Builder.
//
// Usage:
//   node audit/playwright/launch.mjs              # interactive, leaves browser open
//   node audit/playwright/launch.mjs --probe      # inspects Route Builder state and exits
//   node audit/playwright/launch.mjs --apply      # walks Route Builder apply path (dry-run)

import {chromium} from "playwright"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT_DIR   = path.resolve(__dirname, "../../")
const PROFILE   = path.resolve(__dirname, ".profile")
const SHOTS     = path.resolve(__dirname, "screenshots")
const CREDS     = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../credentials.json"), "utf8"))

const ARGV = new Set(process.argv.slice(2))
const MODE = ARGV.has("--probe") ? "probe"
           : ARGV.has("--apply") ? "apply"
           : "interactive"

fs.mkdirSync(SHOTS, {recursive: true})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log   = (...a) => console.log("[harness]", ...a)

;(async () => {
    log(`mode=${MODE} ext=${EXT_DIR} profile=${PROFILE}`)
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        viewport: {width: 1400, height: 900},
        args: [
            `--disable-extensions-except=${EXT_DIR}`,
            `--load-extension=${EXT_DIR}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=ChromeWhatsNewUI",
        ],
    })

    // First page already exists in persistent context.
    const pages = ctx.pages()
    const page  = pages.length ? pages[0] : await ctx.newPage()

    page.on("console", msg => {
        const t = msg.type()
        if (t === "error" || t === "warning" || /\[AES/.test(msg.text())) {
            log(`page.${t}:`, msg.text())
        }
    })
    page.on("pageerror", err => log("pageerror:", err.message))

    await ensureLoggedIn(page)

    // Navigate to the fleets page so we can pick an aircraft.
    const fleetsUrl = `https://${CREDS.server}/app/fleets`
    log(`→ ${fleetsUrl}`)
    await page.goto(fleetsUrl, {waitUntil: "domcontentloaded", timeout: 60000})
    await sleep(3000)

    // Map the AES surfaces available on this airline. No-aircraft fleets
    // can't host the AFP Route Builder, so we have to discover what *is*
    // mountable here.
    await page.screenshot({path: path.join(SHOTS, "01-fleets.png"), fullPage: true})
    const fleetsMap = await page.evaluate(() => {
        const mapNav = (sel) => Array.from(document.querySelectorAll(sel)).map(a => ({
            text: (a.textContent || "").trim().slice(0, 80),
            href: a.href || null
        }))
        const acft = Array.from(document.querySelectorAll('a[href*="/app/fleets/aircraft/"]')).map(a => a.href)
        const aesBtns = Array.from(document.querySelectorAll("button, a"))
            .filter(b => /SCHEDULE GRID|SCHEDULE CANVAS|ROUTE BUILDER|FLEET HUB|AES/i.test(b.textContent || ""))
            .slice(0, 30)
            .map(b => ({tag: b.tagName, text: (b.textContent || "").trim().slice(0, 60), id: b.id, cls: b.className}))
        const aesMenu = mapNav('a[href*="aes"], a[href*="/app/com"], a[href*="/app/fleets"], a[href*="/app/scheduling"]').slice(0, 60)
        return {
            url: location.href,
            aircraftCount: acft.length,
            aircraftLinks: acft.slice(0, 5),
            aesButtons: aesBtns,
            navLinks: aesMenu,
            hasAesMenu: !!document.querySelector("[data-aes-menu], .aes-menu, #aes-menu"),
        }
    })
    fs.writeFileSync(path.join(SHOTS, "01-fleets-map.json"), JSON.stringify(fleetsMap, null, 2))
    log("fleets map:", JSON.stringify(fleetsMap, null, 2))

    if (fleetsMap.aircraftCount === 0) {
        log("⚠ no aircraft — AFP-based Route Builder cannot mount. Continuing to map other AES surfaces.")
    }

    // Try OPEN FLEET SCHEDULE GRID since that looks like a Route Builder candidate.
    const gridBtn = await page.$('button:has-text("Open Fleet Schedule Grid"), button:has-text("OPEN FLEET SCHEDULE GRID")')
    if (gridBtn) {
        log("clicking OPEN FLEET SCHEDULE GRID")
        await gridBtn.click({force: true}).catch(e => log("click failed:", e.message))
        await sleep(2500)
        await page.screenshot({path: path.join(SHOTS, "02-fleet-schedule-grid.png"), fullPage: true})

        // Map what this overlay contains — buttons, headings, route-builder hooks.
        const gridMap = await page.evaluate(() => {
            const overlay = document.querySelector(".aes-fleet-schedule-grid-overlay, [class*='schedule-grid']")
            if (!overlay) return {present: false}
            const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
            const text = (overlay.textContent || "").slice(0, 800)
            const buttons = Array.from(overlay.querySelectorAll("button")).filter(visible).map(b => ({
                text: (b.textContent || "").trim().slice(0, 60), disabled: !!b.disabled, cls: b.className
            }))
            const headings = Array.from(overlay.querySelectorAll("h1,h2,h3,h4")).map(h => (h.textContent || "").trim())
            return {present: true, headings, buttons, textPreview: text}
        })
        fs.writeFileSync(path.join(SHOTS, "02-grid-map.json"), JSON.stringify(gridMap, null, 2))
        log("grid map:", JSON.stringify(gridMap, null, 2))

        // Close overlay before next click.
        await page.evaluate(() => {
            const closer = document.querySelector(".aes-fleet-schedule-grid-overlay [aria-label='Close'], .aes-fleet-schedule-grid-overlay button[title*='Close'], .aes-fleet-schedule-grid-overlay .close, .aes-fleet-schedule-grid-overlay [data-close]")
            if (closer) closer.click()
            else {
                const overlay = document.querySelector(".aes-fleet-schedule-grid-overlay")
                if (overlay) overlay.remove()
            }
        })
        await sleep(800)
    }

    // Try OPEN SCHEDULE CANVAS
    const canvasBtn = await page.$('button:has-text("Open Schedule Canvas"), button:has-text("OPEN SCHEDULE CANVAS")')
    if (canvasBtn) {
        log("clicking OPEN SCHEDULE CANVAS")
        await canvasBtn.click({force: true}).catch(e => log("click failed:", e.message))
        await sleep(2500)
        await page.screenshot({path: path.join(SHOTS, "03-schedule-canvas.png"), fullPage: true})

        const canvasMap = await page.evaluate(() => {
            const overlay = document.querySelector(".aes-schedule-canvas, [class*='schedule-canvas'], [class*='canvas-overlay']")
            if (!overlay) return {present: false, allOverlays: Array.from(document.querySelectorAll("[class*='overlay'], [class*='modal']")).map(e => e.className)}
            const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
            const buttons = Array.from(overlay.querySelectorAll("button")).filter(visible).map(b => ({
                text: (b.textContent || "").trim().slice(0, 60), disabled: !!b.disabled, cls: b.className
            }))
            const headings = Array.from(overlay.querySelectorAll("h1,h2,h3,h4")).map(h => (h.textContent || "").trim())
            return {present: true, headings, buttons, textPreview: (overlay.textContent || "").slice(0, 600)}
        })
        fs.writeFileSync(path.join(SHOTS, "03-canvas-map.json"), JSON.stringify(canvasMap, null, 2))
        log("canvas map:", JSON.stringify(canvasMap, null, 2))
    }

    // Try the AES dropdown in main nav.
    const aesNav = await page.$('a:has-text("AES"), button:has-text("AES")')
    if (aesNav) {
        log("hovering AES nav")
        await aesNav.hover().catch(() => {})
        await sleep(800)
        await page.screenshot({path: path.join(SHOTS, "04-aes-nav-open.png"), fullPage: true})
        // Capture menu items.
        const menuItems = await page.evaluate(() => {
            const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
            return Array.from(document.querySelectorAll("a, button"))
                .filter(visible)
                .map(a => ({text: (a.textContent || "").trim().slice(0, 60), href: a.href || null}))
                .filter(o => o.text && o.text.length < 80)
                .slice(0, 60)
        })
        fs.writeFileSync(path.join(SHOTS, "04-nav-items.json"), JSON.stringify(menuItems, null, 2))
    }

    // Probe Route Builder state.
    const probe = await page.evaluate(() => {
        const out = {
            url: location.href,
            title: document.title,
            hasAesAfp: !!window.AesAfp,
            hasFormDriver: !!window.AesAfpFormDriver,
            hasApplyBatch: !!window.AesAfpAutoApplyBatch,
            hasPreview: !!window.AesAfpAutoSchedulerPreview,
            hasFlightStudio: !!window.AesAfpFlightStudio,
            hasLegSpec: !!window.AesAfpLegSpec,
            hasOrchestrator: !!window.AesAfpScheduleApplyOrchestrator,
            hasDraftStore: !!window.AesAfpActiveDraftStore,
            wideHostExists: !!document.querySelector('[data-aes-afp-wide-host], #aes-afp-wide-host, .aes-afp-wide-host'),
            studioRoot: null,
            buttons: [],
        }
        // Find Route Builder heading.
        const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4")).filter(h =>
            /AES Route Builder/i.test(h.textContent || ""))
        out.routeBuilderHeading = headings.map(h => h.textContent.trim())

        // Find buttons inside the Route Builder area.
        const wide = document.querySelector('[data-aes-afp-wide-host]')
                  || (headings[0] ? headings[0].closest("section,div,fieldset") : null)
        if (wide) {
            out.studioRoot = wide.tagName + (wide.id ? "#" + wide.id : "")
                           + (wide.className ? "." + String(wide.className).split(/\s+/).join(".") : "")
            out.buttons = Array.from(wide.querySelectorAll("button")).map(b => ({
                text: (b.textContent || "").trim().slice(0, 60),
                disabled: !!b.disabled,
                visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
                cls: b.className || ""
            }))
        }
        return out
    })
    log("probe:", JSON.stringify(probe, null, 2))

    fs.writeFileSync(path.join(SHOTS, "01-probe.json"), JSON.stringify(probe, null, 2))

    if (MODE === "probe") {
        log("probe complete; closing browser")
        await ctx.close()
        return
    }

    if (MODE === "apply") {
        log("apply mode — would walk Route Builder flow here (TODO)")
    }

    log("interactive — leaving browser open. Ctrl+C to exit.")
    // Keep alive
    await new Promise(() => {})
})()

async function ensureLoggedIn(page) {
    log("→ https://www.airlinesim.aero/auth/login")
    await page.goto("https://www.airlinesim.aero/auth/login", {waitUntil: "domcontentloaded", timeout: 60000})
    await sleep(2000)
    const url = page.url()
    if (!/auth\/login/.test(url)) {
        log("already logged in:", url)
        return
    }
    log("logging in as", CREDS.email)
    const result = await page.evaluate(({email, password}) => {
        const f = document.querySelector("form")
        if (!f) return "no-form"
        const u = f.querySelector('input[name="login"]')
        const p = f.querySelector('input[name="password"]')
        if (!u || !p) return "fields-missing"
        const setNative = (el, val) => {
            const proto = Object.getPrototypeOf(el)
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set
            setter.call(el, val)
            el.dispatchEvent(new Event("input", {bubbles: true}))
            el.dispatchEvent(new Event("change", {bubbles: true}))
        }
        setNative(u, email)
        setNative(p, password)
        const btn = f.querySelector('button[type="submit"], input[type="submit"]')
        if (btn) btn.click()
        else f.submit()
        return "submitted"
    }, {email: CREDS.email, password: CREDS.password})
    log("login result:", result)
    await page.waitForLoadState("domcontentloaded", {timeout: 30000}).catch(() => {})
    await sleep(4000)
    log("after login, url=", page.url())
    if (/auth\/login/.test(page.url())) {
        await page.screenshot({path: path.join(SHOTS, "00-login-failed.png"), fullPage: true})
        throw new Error("Login failed — see screenshots/00-login-failed.png")
    }
}
