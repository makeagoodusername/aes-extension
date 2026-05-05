import {chromium} from "playwright"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PORT = process.env.AES_LIVE_CHROME_PORT || "9326"
const BASE = process.env.AES_LIVE_SERVER || "https://free1.airlinesim.aero"
const DASHBOARD_PATH = process.env.AES_LIVE_DASHBOARD_PATH || "/app/enterprise/dashboard"
const LAUNCH = process.env.AES_LIVE_CHROME_LAUNCH === "1"
const PROFILE_DIR = process.env.AES_LIVE_CHROME_PROFILE
    || path.join(os.tmpdir(), `aes-live-smoke-${PORT}`)
const CHROME_PATH = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const OUT = path.resolve(process.env.AES_LIVE_SMOKE_OUT || "audit/live-real-integrated-report-20260504.json")
const SHOT_DIR = path.resolve(process.env.AES_LIVE_SHOT_DIR || "audit/live-real-shots-20260504")

fs.mkdirSync(SHOT_DIR, {recursive: true})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const report = {
    startedAt: new Date().toISOString(),
    port: PORT,
    base: BASE,
    mode: "real-airlinesim-read-only",
    checks: {},
    errors: [],
    pageErrors: [],
    consoleErrors: [],
    screenshots: []
}

async function dismissScrapeOverlays(page) {
    await page.evaluate(() => {
        const selectors = [".aes-scrape-tos-overlay", ".aes-scrape-modal-overlay"]
        for (const selector of selectors) {
            for (const overlay of document.querySelectorAll(selector)) {
                const button = Array.from(overlay.querySelectorAll("button"))
                    .find(btn => /cancel|close/i.test(btn.textContent || ""))
                if (button) {
                    try { button.click() } catch (_) {}
                }
            }
        }
    }).catch(() => {})
    await sleep(500)
    await page.evaluate(() => {
        document.querySelectorAll(".aes-scrape-tos-overlay, .aes-scrape-modal-overlay")
            .forEach(overlay => overlay.remove())
    }).catch(() => {})
}

async function dismissAesSurfaceModals(page) {
    await page.keyboard.press("Escape").catch(() => {})
    await sleep(500)
    await page.evaluate(() => {
        const selectors = [
            ".aes-briefing-modal",
            ".aes-briefing-dialog",
            ".aes-strategy-modal",
            ".aes-strategy-panel",
            "[data-aes-strategy-surface]"
        ]
        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(el => {
                const root = el.closest("[data-aes-strategy-surface], .aes-strategy-modal, .aes-briefing-modal, .aes-strategy-panel") || el
                if (root && typeof root.remove === "function") root.remove()
            })
        }
        if (!document.querySelector("[role='dialog'], .modal.fade.in, .aes-briefing-modal, .aes-strategy-modal")) {
            document.body.classList.remove("modal-open")
        }
    }).catch(() => {})
}

function ok(name, detail) {
    report.checks[name] = Object.assign({ok: true}, detail || {})
    console.log("[ok]", name)
}

function fail(name, error, detail) {
    report.checks[name] = Object.assign({
        ok: false,
        error: error && error.message ? error.message : String(error)
    }, detail || {})
    report.errors.push({name, error: report.checks[name].error})
    console.log("[fail]", name, report.checks[name].error)
}

async function getAesContext(page) {
    const session = await page.context().newCDPSession(page)
    const contexts = []
    session.on("Runtime.executionContextCreated", ev => contexts.push(ev.context))
    await session.send("Runtime.enable")
    await sleep(500)
    for (const ctx of contexts) {
        if (ctx.name === "AirlineSim Enhancement Suite"
            || String(ctx.origin || "").startsWith("chrome-extension://")) {
            return {session, contextId: ctx.id}
        }
    }
    for (const ctx of contexts) {
        try {
            const probe = await session.send("Runtime.evaluate", {
                contextId: ctx.id,
                expression: "typeof AesDataBus !== 'undefined' || typeof CentralHubBus !== 'undefined'",
                returnByValue: true
            })
            if (probe.result && probe.result.value) return {session, contextId: ctx.id}
        } catch (_) {}
    }
    return {session, contextId: null}
}

async function evalAes(page, expression) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
        const {session, contextId} = await getAesContext(page)
        try {
            if (!contextId) throw new Error("AES isolated world not found")
            const res = await session.send("Runtime.evaluate", {
                contextId,
                expression,
                awaitPromise: true,
                returnByValue: true
            })
            if (res.exceptionDetails) {
                throw new Error(res.exceptionDetails.text || "Runtime.evaluate exception")
            }
            return res.result ? res.result.value : null
        } catch (err) {
            lastError = err
            const text = String(err && err.message || err)
            if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(text)) {
                throw err
            }
            await sleep(500)
        } finally {
            await session.detach().catch(() => {})
        }
    }
    throw lastError || new Error("AES isolated world evaluate failed")
}

async function nav(page, url, name) {
    console.log("[nav]", name, url)
    let alreadyThere = page.url() === url
    if (!alreadyThere && /^0[12]-dashboard/.test(name)) {
        try {
            const current = new URL(page.url())
            const target = new URL(url)
            alreadyThere = current.origin === target.origin
                && current.pathname === target.pathname
        } catch (_) {}
    }
    if (!alreadyThere) {
        let navError = null
        const completed = await Promise.race([
            page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000})
                .then(() => true)
                .catch(err => {
                    if (!/ERR_ABORTED/.test(String(err))) navError = err
                    return true
                }),
            sleep(12000).then(() => false)
        ])
        if (navError) throw navError
        if (!completed) console.log("[nav:continue]", name, page.url())
        await page.waitForLoadState("networkidle", {timeout: 15000}).catch(() => {})
    } else {
        console.log("[nav:skip]", name, page.url())
    }
    await sleep(2000)
    await dismissBlockingOverlays(page)
    const shot = path.join(SHOT_DIR, name + ".png")
    await page.screenshot({path: shot, fullPage: true, timeout: 10000}).catch(() => {})
    report.screenshots.push(shot)
}

async function dismissBlockingOverlays(page) {
    await page.evaluate(() => {
        function clickByText(root, patterns) {
            const nodes = Array.from(root.querySelectorAll("button, a"))
            const target = nodes.find(node => {
                const text = String(node.innerText || node.textContent || "").trim()
                return patterns.some(re => re.test(text))
            })
            if (target && typeof target.click === "function") {
                target.click()
                return true
            }
            return false
        }

        const release = document.querySelector("#aes-release-notes-dialog")
        if (release) {
            clickByText(release, [/got it/i, /close/i, /^×$/])
        }

        const scrapeTos = document.querySelector(".aes-scrape-tos-overlay")
        if (scrapeTos) {
            clickByText(scrapeTos, [/cancel/i, /close/i])
        }

        const scrapeProgress = document.querySelector(".aes-scrape-modal-overlay")
        if (scrapeProgress) {
            clickByText(scrapeProgress, [/cancel/i, /close/i])
        }
    }).catch(() => {})

    await sleep(800)

    await page.evaluate(() => {
        const selectors = [
            "#aes-release-notes-dialog",
            ".aes-release-notes-backdrop",
            ".modal-backdrop.fade.in",
            ".aes-scrape-tos-overlay",
            ".aes-scrape-modal-overlay"
        ]
        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(el => {
                if (el && typeof el.remove === "function") el.remove()
            })
        }
        if (!document.querySelector(".modal.fade.in[aria-modal='true']")) {
            document.body.classList.remove("modal-open")
        }
    }).catch(() => {})
}

async function requireVisible(page, selector, label) {
    const loc = page.locator(selector).first()
    await loc.waitFor({state: "visible", timeout: 15000})
    return label || selector
}

async function runCheck(name, fn) {
    console.log("[run]", name)
    try {
        const detail = await fn()
        ok(name, detail)
    } catch (e) {
        fail(name, e)
    }
}

function interestingConsole(text) {
    if (/Failed to load resource/i.test(text)) return false
    if (/favicon/i.test(text)) return false
    if (/net::ERR_ABORTED/i.test(text)) return false
    if (/jquery\.checkboxes\.js/i.test(text) && /MIME type/i.test(text)) return false
    return true
}

let browser = null
let context = null
if (LAUNCH) {
    fs.mkdirSync(PROFILE_DIR, {recursive: true})
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath(),
        headless: false,
        viewport: {width: 1440, height: 1000},
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
            `--disable-extensions-except=${process.cwd()}`,
            `--load-extension=${process.cwd()}`,
            `--remote-debugging-port=${PORT}`,
            "--remote-allow-origins=*",
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--disable-background-timer-throttling",
            "--no-first-run",
            "--no-default-browser-check"
        ]
    })
    browser = context.browser()
} else {
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + PORT)
    context = browser.contexts()[0]
}
if (!context) throw new Error("No browser context for live smoke")
if (LAUNCH) await sleep(2500)
const page = context.pages().find(p => /airlinesim\.aero/.test(p.url())) || await context.newPage()

page.on("console", msg => {
    if (msg.type() === "error" && interestingConsole(msg.text())) {
        report.consoleErrors.push(msg.text())
    }
})
page.on("pageerror", err => {
    report.pageErrors.push((err && err.message) || String(err))
})

await runCheck("dashboard boots with AES menu and Central Hub", async () => {
    await nav(page, BASE + DASHBOARD_PATH, "01-dashboard")
    await requireVisible(page, ".aes-menu__trigger", "AES menu")
    await requireVisible(page, "#aes-central-hub", "Central Hub")
    const data = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        tileIds: Array.from(document.querySelectorAll(".aes-central-hub-tile"))
            .map(el => el.dataset.tileId)
            .filter(Boolean),
        tileCount: document.querySelectorAll(".aes-central-hub-tile").length
    }))
    if (!/Dashboard/i.test(data.title)) throw new Error("not on dashboard: " + data.title)
    if (data.tileCount < 10) throw new Error("too few hub tiles: " + data.tileCount)
    return data
})

await runCheck("all Central Hub tiles expand without body-render crashes", async () => {
    const expanded = await page.evaluate(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms))
        const roots = Array.from(document.querySelectorAll(".aes-central-hub-tile"))
        for (const root of roots) {
            const toggle = root.querySelector("button.aes-central-hub-tile__toggle")
            if (toggle && /▸/.test(toggle.textContent || "")) {
                toggle.click()
                await wait(80)
            }
        }
        await wait(1500)
        return roots.map(root => ({
            id: root.dataset.tileId,
            bodyText: (root.querySelector(".aes-central-hub-tile__body")?.innerText || "").slice(0, 300),
            buttonCount: root.querySelectorAll("button").length
        }))
    })
    const empty = expanded.filter(row => !row.bodyText && row.id !== "mainboard")
    if (empty.length > 3) throw new Error("many empty tile bodies: " + empty.map(x => x.id).join(", "))
    return {expandedCount: expanded.length, emptyBodies: empty.map(x => x.id), sample: expanded.slice(0, 8)}
})

await runCheck("Mainboard shows demand-store readiness row", async () => {
    const text = await page.locator("#aes-central-hub-tile-mainboard").innerText()
    if (!/Demand store/i.test(text)) throw new Error("Demand store row missing")
    return {excerpt: text.split("\n").filter(line => /Demand store|Optional seed|airports cached/i.test(line)).slice(0, 4)}
})

await runCheck("AES isolated world has registered integration topics and notifications API", async () => {
    const out = await evalAes(page, `(() => {
        const audit = AesDataBus.auditTopics();
        const registered = new Set((audit.registered || []).map(x => x.topic));
        const required = [
            "data:notifications:posted",
            "data:route-assistant:ors:health",
            "data:route-assistant:flight-number-pricing:updated",
            "data:strategy:company-reputation:saved",
            "data:slots:available:updated",
            "data:slots:bid:queued"
        ];
        return {
            dataBus: typeof AesDataBus,
            notifications: typeof AesNotifications,
            missing: required.filter(t => !registered.has(t)),
            registeredCount: registered.size
        };
    })()`)
    if (out.missing.length) throw new Error("missing topics: " + out.missing.join(", "))
    if (out.notifications !== "function") throw new Error("AesNotifications missing")
    return out
})

await runCheck("notifications API posts real in-page toast and bus event", async () => {
    const out = await evalAes(page, `(() => {
        const seen = [];
        const off = AesDataBus.on("data:notifications:posted", payload => seen.push(payload));
        new AesNotifications().add("AES live smoke toast", {type: "warning", duration: 0});
        if (typeof off === "function") off();
        const panel = document.querySelector(".feedbackPanel");
        const last = panel && panel.lastElementChild;
        return {
            panelCount: panel ? panel.children.length : 0,
            lastClass: last ? last.className : null,
            lastText: last ? last.innerText : null,
            emitted: seen.length,
            emittedType: seen[0] && seen[0].type
        };
    })()`)
    if (out.panelCount < 1 || out.lastClass !== "feedbackPanelWARNING") {
        throw new Error("toast did not render correctly")
    }
    if (out.emitted !== 1 || out.emittedType !== "warning") {
        throw new Error("toast bus event missing")
    }
    return out
})

await runCheck("scrape orchestrator demand-seed is linked but opt-in/no tab fan-out", async () => {
    const out = await evalAes(page, `Promise.resolve().then(async () => {
        const phases = ScrapeOrchestratorPhases.all();
        const ids = phases.map(p => p.id);
        const demand = phases.find(p => p.id === "demand-seed");
        const jobs = demand ? await demand.buildJobs({server: "free1"}) : null;
        return {
            ids,
            optional: demand && demand.optional,
            defaultEnabled: demand && demand.defaultEnabled,
            label: demand && demand.label,
            jobCount: jobs && jobs.length
        };
    })`)
    if (!out.ids.includes("demand-seed")) throw new Error("phase not registered")
    if (out.optional !== true || out.defaultEnabled !== false || out.jobCount !== 0) {
        throw new Error("demand-seed gate/buildJobs shape wrong")
    }
    return out
})

await runCheck("AesDataBus refresh topics emit without tile crashes", async () => {
    const beforeErrors = report.consoleErrors.length + report.pageErrors.length
    const out = await evalAes(page, `(() => {
        const topics = [
            ["data:route-assistant:ors:health", {server:"free1", updatedAt:Date.now(), source:"live-smoke"}],
            ["data:route-assistant:flight-number-pricing:updated", {server:"free1", hub:"JFK", dest:"ORD", keysTouched:["smoke"]}],
            ["data:strategy:company-reputation:saved", {displayName:"Smoke", ratingLabel:"OK", scrapedAt:Date.now(), source:"live-smoke"}],
            ["data:slots:available:updated", {server:"free1", count:0}],
            ["data:slots:bid:queued", {server:"free1", iata:"JFK"}]
        ];
        for (const [topic, payload] of topics) AesDataBus.emit(topic, payload);
        return {emitted: topics.map(t => t[0])};
    })()`)
    await sleep(1000)
    const afterErrors = report.consoleErrors.length + report.pageErrors.length
    if (afterErrors > beforeErrors) throw new Error("errors after bus emits")
    return out
})

await runCheck("Command palette lists fork command and navigates to Accounting", async () => {
    const mod = process.platform === "darwin" ? "Meta" : "Control"
    await page.keyboard.press(mod + "+K")
    await requireVisible(page, "#aes-command-palette", "command palette")
    await page.locator("#aes-command-palette-input").fill("strategy fork")
    await page.locator("#aes-command-palette-list .row", {hasText: "Create Strategy Fork"}).first().waitFor({state: "visible", timeout: 10000})
    await page.locator("#aes-command-palette-input").fill("go to accounting")
    const rows = page.locator("#aes-command-palette-list .row", {hasText: "Go to Accounting"})
    await rows.first().waitFor({state: "visible", timeout: 10000})
    const count = await rows.count()
    if (count !== 1) throw new Error("expected one accounting command, got " + count)
    await page.keyboard.press("Enter")
    await page.waitForURL(/\/app\/finance\/accounting/, {timeout: 15000})
    await sleep(1000)
    return {url: page.url()}
})

await runCheck("Strategy and briefing surfaces open on real dashboard", async () => {
    await nav(page, BASE + DASHBOARD_PATH, "02-dashboard-return")
    await dismissBlockingOverlays(page)
    await dismissScrapeOverlays(page)
    await page.evaluate(() => {
        const ids = ["strategy", "strategy-briefing", "strategy-slot-trading"]
        for (const id of ids) {
            const root = document.querySelector('.aes-central-hub-tile[data-tile-id="' + id + '"]')
            const toggle = root && root.querySelector("button.aes-central-hub-tile__toggle")
            if (toggle && /▸/.test(toggle.textContent || "")) toggle.click()
        }
    })
    await sleep(1500)
    const strategyOpen = page.locator('#aes-central-hub-tile-strategy button:has-text("Open")').first()
    if (await strategyOpen.count()) {
        await dismissBlockingOverlays(page)
        await strategyOpen.click()
        await sleep(1000)
    }
    const strategyModal = await page.evaluate(() => !!document.querySelector('[data-aes-strategy-menu="connected"], .aes-strategy-panel, [data-aes-strategy-panel]'))
    await page.keyboard.press("Escape").catch(() => {})
    const briefingOpen = page.locator('#aes-central-hub-tile-strategy-briefing button:has-text("Open")').first()
    if (await briefingOpen.count()) {
        await dismissBlockingOverlays(page)
        await briefingOpen.click()
        await sleep(1000)
    }
    const briefingModal = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[role='dialog'], .aes-modal, .aes-strategy-briefing-modal"))
            .some(el => /briefing|risk|strategy/i.test(el.innerText || "")))
    await page.keyboard.press("Escape").catch(() => {})
    if (!strategyModal) throw new Error("strategy panel did not open")
    if (!briefingModal) throw new Error("briefing modal did not open")
    return {strategyModal, briefingModal}
})

await runCheck("Backtest CTA executes without exception", async () => {
    await dismissScrapeOverlays(page)
    await dismissBlockingOverlays(page)
    await dismissAesSurfaceModals(page)
    const beforeErrors = report.consoleErrors.length + report.pageErrors.length
    const root = page.locator('#aes-central-hub-tile-strategy-backtest')
    if (!await root.count()) throw new Error("strategy-backtest tile missing")
    const toggle = root.locator("button.aes-central-hub-tile__toggle").first()
    if (await toggle.count()) {
        const t = await toggle.innerText()
        if (/▸/.test(t)) await toggle.click()
    }
    await sleep(1000)
    const btn = root.locator("button", {hasText: /Run backtest/i}).first()
    if (!await btn.count()) throw new Error("Run backtest button missing")
    await btn.click()
    await sleep(2500)
    const text = await root.innerText()
    const afterErrors = report.consoleErrors.length + report.pageErrors.length
    if (afterErrors > beforeErrors) throw new Error("errors after backtest")
    if (!/backtest|week|Δ|delta/i.test(text)) throw new Error("backtest result not visible")
    return {excerpt: text.slice(0, 500)}
})

await runCheck("Fleets, AFP plan, aircraft flights, scheduling, alliance pages load AES surfaces", async () => {
    const out = {}
    await nav(page, BASE + "/app/fleets", "03-fleets")
    await requireVisible(page, ".aes-menu__trigger")
    out.fleets = await page.evaluate(() => ({
        url: location.href,
        text: document.body.innerText.slice(0, 400),
        aircraftHref: document.querySelector('a[href*="/app/fleets/aircraft/"], a[href*="fleets/aircraft/"]')?.href || null
    }))
    if (!out.fleets.aircraftHref) throw new Error("no aircraft link on fleets page")

    const aircraftBase = out.fleets.aircraftHref.replace(/\/[01](?:[?#].*)?$/, "")
    await nav(page, aircraftBase + "/0", "04-afp-plan")
    await requireVisible(page, ".aes-menu__trigger")
    out.afp = await evalAes(page, `(() => ({
        hasAfp: typeof AesAfp !== "undefined",
        hasFormDriver: typeof AesAfpFormDriver !== "undefined",
        hasRouteCandidates: typeof AesAfpRouteCandidates !== "undefined",
        hasWaveApplier: typeof AesAfpWaveApplier !== "undefined",
        routeBuilderText: document.body.innerText.includes("AES Route Builder")
    }))()`)
    if (!out.afp.hasAfp || !out.afp.hasFormDriver || !out.afp.hasRouteCandidates) throw new Error("AFP modules missing")

    await nav(page, aircraftBase + "/1", "05-aircraft-flights")
    await requireVisible(page, ".aes-menu__trigger")
    out.aircraftFlights = await page.evaluate(() => ({
        hasProfitLoss: /Profit\/Loss/i.test(document.body.innerText),
        hasExtracted: /Extracted/i.test(document.body.innerText),
        tableCount: document.querySelectorAll("table").length
    }))

    await nav(page, BASE + "/app/alliance", "06-alliance")
    await requireVisible(page, ".aes-menu__trigger")
    out.alliance = await evalAes(page, `(() => ({
        scraper: typeof AllianceOverviewScraper,
        title: document.title,
        hasAllianceText: /alliance/i.test(document.body.innerText)
    }))()`)

    await nav(page, BASE + "/app/com/scheduling/JFKORD", "07-scheduling")
    await requireVisible(page, ".aes-menu__trigger")
    out.scheduling = await evalAes(page, `(() => ({
        hasSettings: typeof AesSettings !== "undefined",
        hasTokens: typeof AESTokens !== "undefined",
        hasScheduleStore: typeof AesAfpScheduleStore !== "undefined",
        hasPricingApplier: typeof RouteAssistantPricingApplier !== "undefined" || typeof window.RouteAssistantPricingApplier !== "undefined",
        title: document.title
    }))()`)
    if (!out.scheduling.hasSettings || !out.scheduling.hasTokens) throw new Error("scheduling substrate missing")
    return out
})

report.finishedAt = new Date().toISOString()
report.summary = {
    checks: Object.keys(report.checks).length,
    passed: Object.values(report.checks).filter(x => x.ok).length,
    failed: Object.values(report.checks).filter(x => !x.ok).length,
    pageErrors: report.pageErrors.length,
    consoleErrors: report.consoleErrors.length
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report.summary, null, 2))
console.log("[report]", OUT)

if (LAUNCH && context) {
    await context.close().catch(() => {})
}

process.exit(report.summary.failed > 0 || report.pageErrors.length || report.consoleErrors.length ? 1 : 0)
