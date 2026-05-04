import { chromium } from "playwright"
import fs from "node:fs/promises"
import path from "node:path"

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname)
const OUT = path.join(ROOT, "audit", "pw-rb-shots")
const REPORT = path.join(ROOT, "audit", "pw-rb-live-final-report.json")
const CREDENTIALS = path.join(ROOT, "audit", "credentials.json")
const CHROME = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const SOURCE_PORT = Number(process.env.AES_SOURCE_PORT || 0)
const AIRCRAFT = process.env.AES_AIRCRAFT_ID || "22092"
const ENTERPRISE_ID = process.env.AES_TEST_ENTERPRISE_ID || process.env.AES_ENTERPRISE_ID || "775"
const BASE_FN = Number(process.env.AES_BASE_FN || 34)
const TARGET_DEST = String(process.env.AES_ROUTE_DEST || process.env.AES_ROUTE_BUILDER_DEST || "").trim().toUpperCase()
const VERIFY_EXISTING = process.env.AES_VERIFY_EXISTING === "1"
const ALLOW_MANUAL_FALLBACK = process.env.AES_ALLOW_MANUAL_FALLBACK === "1"
const HOST = "https://free1.airlinesim.aero"

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const report = { startedAt: new Date().toISOString(), steps: [], ok: false }

function step(name, data = {}) {
    const row = Object.assign({ name, at: new Date().toISOString() }, data)
    report.steps.push(row)
    console.log(JSON.stringify(row))
}

async function screenshot(page, name) {
    await fs.mkdir(OUT, { recursive: true })
    const file = path.join(OUT, name + ".png")
    await page.screenshot({ path: file, fullPage: false })
    return path.relative(ROOT, file)
}

async function findAesContext(page, predicate, timeoutMs = 30000) {
    const client = await page.context().newCDPSession(page)
    const contexts = new Map()
    client.on("Runtime.executionContextCreated", ev => {
        if (ev && ev.context && ev.context.id) contexts.set(ev.context.id, ev.context)
    })
    await client.send("Runtime.enable")
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        for (const ctx of contexts.values()) {
            try {
                const res = await client.send("Runtime.evaluate", {
                    contextId: ctx.id,
                    expression: "(() => { try { return !!(" + predicate + ") } catch (_) { return false } })()",
                    returnByValue: true,
                    timeout: 2000
                })
                if (res && res.result && res.result.value === true) {
                    return { client, contextId: ctx.id }
                }
            } catch (_) {
                // Contexts can disappear during Wicket navigation.
            }
        }
        await sleep(250)
    }
    await client.detach().catch(() => {})
    throw new Error("AES isolated context not found")
}

async function evalAes(page, expression, timeoutMs = 30000) {
    const { client, contextId } = await findAesContext(
        page,
        "window.AesAfp || window.AesAfpFormDriver || window.AesSettings",
        timeoutMs
    )
    try {
        const res = await client.send("Runtime.evaluate", {
            contextId,
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: timeoutMs
        })
        if (res && res.exceptionDetails) {
            throw new Error(res.exceptionDetails.text
                || (res.exceptionDetails.exception && res.exceptionDetails.exception.description)
                || "Runtime.evaluate exception")
        }
        return res && res.result ? res.result.value : undefined
    } finally {
        await client.detach().catch(() => {})
    }
}

async function clickButtonByText(page, text, scope = "document") {
    const out = await page.evaluate(({ text, scope }) => {
        const root = scope === "modal"
            ? document.querySelector("[data-aes-afp-auto-confirm]")
            : document
        if (!root) return { ok: false, error: "scope not found" }
        const buttons = Array.from(root.querySelectorAll("button, input[type='button'], input[type='submit']"))
        const wanted = String(text).toLowerCase()
        const btn = buttons.find(b => String(b.textContent || b.value || "").trim().toLowerCase() === wanted)
            || buttons.find(b => String(b.textContent || b.value || "").trim().toLowerCase().includes(wanted))
        if (!btn) {
            return {
                ok: false,
                error: "button not found",
                buttons: buttons.map(b => String(b.textContent || b.value || "").trim()).filter(Boolean)
            }
        }
        btn.scrollIntoView({ block: "center", inline: "center" })
        btn.click()
        return { ok: true, label: String(btn.textContent || btn.value || "").trim() }
    }, { text, scope })
    if (!out || !out.ok) throw new Error("click " + text + ": " + JSON.stringify(out))
    return out
}

async function waitFor(page, fn, timeoutMs = 30000, label = "condition") {
    const start = Date.now()
    let last
    while (Date.now() - start < timeoutMs) {
        last = await fn()
        if (last && last.ok) return last
        await page.waitForTimeout(500)
    }
    throw new Error("timeout waiting for " + label + ": " + JSON.stringify(last))
}

async function parseRoster(page, nums) {
    await page.goto(HOST + "/app/com/numbers", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1200)
    return await page.evaluate((wanted) => {
        const set = new Set(wanted.map(String))
        return Array.from(document.querySelectorAll("tbody#flightNumbers tr, table tbody tr"))
            .map(tr => {
                const cells = Array.from(tr.querySelectorAll("td"))
                    .map(td => (td.textContent || "").replace(/\s+/g, " ").trim())
                const link = tr.querySelector("a[href*='/app/com/numbers/'], a[href*='/numbers/']")
                return {
                    number: cells[1] || "",
                    days: cells[2] || "",
                    origin: cells[3] || "",
                    departure: cells[4] || "",
                    destination: cells[5] || "",
                    href: link && link.href || "",
                    text: (tr.textContent || "").replace(/\s+/g, " ").trim()
                }
            })
            .filter(row => set.has(String(row.number)))
    }, nums)
}

async function loginIfNeeded(page) {
    await page.goto(HOST + "/app/enterprise/dashboard?codex-login=" + Date.now(), { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle").catch(() => {})
    if (!/\/auth\/login|\/app\/login/.test(page.url())) {
        return { ok: true, url: page.url(), usedCredentials: false }
    }

    const creds = JSON.parse(await fs.readFile(CREDENTIALS, "utf8"))
    if (!creds.email || !creds.password) throw new Error("audit/credentials.json is missing email/password")

    await page.goto("https://www.airlinesim.aero/auth/login", { waitUntil: "domcontentloaded" })
    const loginInput = page.locator([
        "input[name='login']",
        "input[type='email']",
        "input[name*='email']",
        "input[name*='username']",
        "input[type='text']"
    ].join(", ")).first()
    await loginInput.fill(creds.email)
    await page.locator("input[type='password']").first().fill(creds.password)
    await Promise.all([
        page.waitForURL(url => !/\/auth\/login/.test(url.pathname), { timeout: 60000 }),
        page.locator("button[type='submit'], input[type='submit'], button:has-text('Log in')").first().click()
    ])
    await page.goto(HOST + "/app/enterprise/dashboard?codex-login-verify=" + Date.now(), { waitUntil: "domcontentloaded" })
    await page.waitForLoadState("networkidle").catch(() => {})
    if (/\/auth\/login|\/app\/login/.test(page.url())) throw new Error("login did not produce an AirlineSim app session")
    return { ok: true, url: page.url(), usedCredentials: true }
}

async function seedRouteBuilder(page) {
    const forcedDest = JSON.stringify(TARGET_DEST)
    return await evalAes(page, `(
        async () => {
            const now = Date.now()
            const ctx = window.AesAfp && window.AesAfp.ctx || {}
            const hub = String(ctx.currentLocationIata || ctx.hubIata || "").trim().toUpperCase()
            if (!/^[A-Z]{3}$/.test(hub)) throw new Error("AFP hub context not resolved")
            const forcedDest = ${forcedDest}
            const dest = /^[A-Z]{3}$/.test(forcedDest) && forcedDest !== hub
                ? forcedDest
                : (hub === "LHR" ? "JFK" : "LHR")
            const routeMeta = {
                JFK: { name: "New York John F. Kennedy", distanceKm: hub === "LHR" ? 5535 : 0, distanceNm: hub === "LHR" ? 2989 : 0 },
                LHR: { name: "London Heathrow", distanceKm: hub === "JFK" ? 5535 : 0, distanceNm: hub === "JFK" ? 2989 : 0 },
                CDG: { name: "Paris Charles de Gaulle", distanceKm: 344, distanceNm: 186 }
            }
            const meta = routeMeta[dest] || { name: dest, distanceKm: 1200, distanceNm: 648 }
            if (!meta.distanceKm) {
                meta.distanceKm = 1200
                meta.distanceNm = 648
            }
            const presetId = "p-codex-final-route-builder"
            const waveId = "w-codex-final-route-builder"
            const dayMask = [true, false, false, false, false, false, false]
            const factors = Object.assign({}, ScheduleFactors.defaultFactors(), {
                dayPattern: "custom",
                dayMask: dayMask.slice(),
                slotWindow: { start: "07:30", end: "07:30" }
            })
            const preset = {
                id: presetId,
                name: "Codex live Route Builder check",
                hub,
                waves: [{
                    id: waveId,
                    label: "Monday " + dest,
                    arrivalWindow: { start: "06:30", end: "06:30" },
                    departureWindow: { start: "07:30", end: "07:30" },
                    composition: { shortHaul: 0, mediumHaul: 1, longHaul: 0, byDay: null },
                    subBands: [],
                    priority: 90,
                    pinDestinations: [dest],
                    preferredAircraft: { ids: ["${AIRCRAFT}"], types: [] },
                    kin: { coordinatedHubs: [], allianceTier: "none" },
                    geo: { region: null, country: null },
                    routePolicy: "auto",
                    notes: "Codex live validation preset",
                    archivedAt: null
                }],
                factors,
                schedule: { weekPattern: "custom", dayMask: dayMask.slice() },
                notes: "Temporary live Route Builder validation preset",
                createdAt: now,
                updatedAt: now,
                pinned: true,
                starredAt: now,
                geography: { region: null, country: null, federation: null },
                kinPresetId: null,
                templateRevision: 1,
                appliesToFleets: []
            }
            const block = await SchedulePresets.load()
            const list = Array.isArray(block.presets) ? block.presets.filter(p => p && p.id !== presetId) : []
            list.push(preset)
            await AesSettings.saveArea("scheduleManagement", Object.assign({}, block, {
                presets: list,
                defaultPresetId: presetId
            }))
            await AesAfpSettings.save({
                defaultDepartureTime: "07:30",
                defaultPricePct: 100,
                lastSelectedPresetId: presetId,
                activePresetIdByHub: Object.assign({}, (await AesAfpSettings.load()).activePresetIdByHub || {}, { [hub]: presetId }),
                autoScheduler: {
                    enabled: true,
                    tier: "apply-on-confirm",
                    requireConfirm: true,
                    maxLegsPerApply: 4,
                    fallbackMaxWeeklyBlockHours: 24,
                    fallbackMaxDailyBlockHours: 18,
                    fillToBudget: false,
                    weights: {
                        minPlacementsPerCandidate: 1,
                        maxPlacementsPerCandidate: 1,
                        denseRepeatMultiplier: 1,
                        weeklyFlightsDivisor: 28,
                        slotResolutionMin: 1,
                        tightSlotResolutionMin: 1
                    }
                }
            })
            const rows = [{
                hub,
                destIata: dest,
                destName: meta.name,
                distanceKm: meta.distanceKm,
                distanceNm: meta.distanceNm,
                paxScore: 980,
                cargoScore: 920,
                weeklyFlights: 1,
                flights: 1,
                airlineCount: 1,
                score: 990,
                scoreBlend: 990,
                seatsPerWeek: 260,
                paxDemandPool: 1200,
                cargoDemandPool: 6000,
                demandPoolByClass: { Y: 900, C: 160, F: 45, Cargo: 6000 },
                rmTightnessByClass: { Y: 0.92, C: 0.84, F: 0.78, Cargo: 0.9 },
                competitorPricesByClass: { Y: 410, C: 1020, F: 1950, Cargo: 260 },
                source: "codex live validation"
            }]
            const blob = {
                server: "free1",
                hub,
                scrapedAt: now,
                snapshotAt: now,
                rows
            }
            const writes = { ["routeAssistant:topRoutes:" + hub]: blob }
            if (typeof acctKey === "function") writes[acctKey("routeAssistant:topRoutes", hub)] = blob
            await chrome.storage.local.set(writes)
            if (window.AesAfpRouteCandidates && typeof AesAfpRouteCandidates.compute === "function") {
                const spec = window.AesAfpSpecResolver && AesAfpSpecResolver.last || null
                const settings = await AesAfpSettings.load()
                await AesAfpRouteCandidates.compute({
                    originIata: hub,
                    spec,
                    settings,
                    scheduledDestSet: new Set(),
                    scheduledFlightIds: new Set(),
                    scheduleLegs: []
                })
                const host = window.AesAfp && AesAfp.slot && AesAfp.slot("candidates")
                if (host && AesAfpRouteCandidates.render) {
                    AesAfpRouteCandidates.render(host, AesAfpRouteCandidates.last || [], { ctx })
                }
            }
            return {
                presetId,
                hub,
                dest,
                topRoutes: rows.length,
                candidates: (window.AesAfpRouteCandidates && AesAfpRouteCandidates.last || []).map(c => ({
                    destIata: c.destIata,
                    distanceKm: c.distanceKm,
                    scoreBlend: c.scoreBlend,
                    fits: c.fits
                })).slice(0, 10),
                settings: await AesAfpSettings.load()
            }
        }
    )()`, 45000)
}

async function setFlightNumber(page, baseFn) {
    const out = await page.evaluate((fn) => {
        const input = document.querySelector("[data-aes-studio-fn]")
        if (!input) return { ok: false, error: "flight number input missing" }
        input.focus()
        input.value = String(fn)
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.dispatchEvent(new Event("change", { bubbles: true }))
        return { ok: true, value: input.value }
    }, baseFn)
    if (!out.ok) throw new Error(JSON.stringify(out))
    return out
}

async function ackAndApply(page) {
    const out = await page.evaluate(() => {
        const modal = document.querySelector("[data-aes-afp-auto-confirm]")
        if (!modal) return { ok: false, error: "modal missing" }
        const boxes = Array.from(modal.querySelectorAll("input[type='checkbox']"))
        if (!boxes.length) return { ok: false, error: "checkboxes missing" }
        const ack = boxes[boxes.length - 1]
        if (!ack.checked) ack.click()
        const apply = modal.querySelector("[data-aes-modal-apply]")
        return {
            ok: true,
            checkedCount: boxes.filter(b => b.checked).length,
            applyDisabled: !!(apply && apply.disabled)
        }
    })
    if (!out.ok || out.applyDisabled) throw new Error("modal ack failed: " + JSON.stringify(out))
    await clickButtonByText(page, "Apply", "modal")
    return out
}

async function readCurrentSchedule(page) {
    await page.goto(HOST + "/app/fleets/aircraft/" + AIRCRAFT + "/0?codex-final-verify=" + Date.now(), {
        waitUntil: "domcontentloaded"
    })
    await page.waitForTimeout(2500)
    return await evalAes(page, `(
        () => {
            const rows = (window.AesAfp && typeof AesAfp.getCurrentSchedule === "function")
                ? (AesAfp.getCurrentSchedule() || [])
                : []
            return rows.map(l => ({
                seq: l.seq,
                dayIdx: l.dayIdx,
                dayName: l.dayName,
                depTimeLocal: l.depTimeLocal,
                arrTimeLocal: l.arrTimeLocal,
                origin: l.origin,
                destination: l.destination,
                flightCode: l.flightCode,
                flightNumber: l.flightNumber,
                flightId: l.flightId,
                flightLink: l.flightLink
            }))
        }
    )()`, 30000)
}

async function submitManualSingleLeg(page, seed) {
    const dest = JSON.stringify((seed && seed.dest) || TARGET_DEST || "LHR")
    const baseFn = JSON.stringify(String(BASE_FN))
    return await evalAes(page, `(
        async () => {
            const ctx = window.AesAfp && window.AesAfp.ctx || {}
            const hub = String(ctx.currentLocationIata || ctx.hubIata || "").trim().toUpperCase()
            const dest = ${dest}
            if (!/^[A-Z]{3}$/.test(hub)) return {ok: false, error: "manual-submit: hub context missing"}
            if (!/^[A-Z]{3}$/.test(dest) || dest === hub) return {ok: false, error: "manual-submit: destination invalid", hub, dest}
            if (!window.AesAfpAutoApplyBatch || typeof AesAfpAutoApplyBatch.start !== "function") {
                return {ok: false, error: "manual-submit: apply-batch missing"}
            }
            const leg = {
                seq: 1,
                origin: hub,
                destination: dest,
                depTime: "07:30",
                depTimeLocal: "07:30",
                pricePct: 100,
                service: "",
                dayMask: [true, false, false, false, false, false, false],
                direction: "outbound",
                flightNumberText: ${baseFn}
            }
            const resp = await AesAfpAutoApplyBatch.start({
                source: "flight-studio-codex-live-fallback",
                ctx: ctx,
                legs: [leg],
                reloadOnDone: true
            })
            return {ok: !!(resp && resp.ok), response: resp, leg}
        }
    )()`, 180000)
}

function verifyScheduleHits(schedule, numbers) {
    const suffix = (value) => {
        const m = String(value == null ? "" : value).match(/(\d{1,4})\s*$/)
        return m ? m[1] : String(value == null ? "" : value)
    }
    const wanted = new Set(numbers.map(String))
    const hits = schedule.filter(l => wanted.has(suffix(l.flightNumber || l.flightCode)))
    const byNumber = {}
    for (const h of hits) {
        const k = suffix(h.flightNumber || h.flightCode)
        if (!byNumber[k]) byNumber[k] = []
        byNumber[k].push(h)
    }
    const valid = numbers.map(String).every(n =>
        Array.isArray(byNumber[n]) && byNumber[n].length === 1 && byNumber[n][0].dayIdx === 0
    )
    return {valid, hits, byNumber}
}

async function main() {
    let cookies = []
    if (SOURCE_PORT > 0) {
        const source = await chromium.connectOverCDP("http://127.0.0.1:" + SOURCE_PORT)
        const sourceContext = source.contexts()[0]
        cookies = await sourceContext.cookies(HOST)
        await source.close()
        step("copied-cookies", { count: cookies.length, sourcePort: SOURCE_PORT })
    } else {
        step("own-chrome-login", { sourcePort: SOURCE_PORT })
    }

    const profile = "/tmp/aes-route-builder-final-" + Date.now()
    const context = await chromium.launchPersistentContext(profile, {
        headless: false,
        executablePath: CHROME,
        args: [
            "--disable-extensions-except=" + ROOT,
            "--load-extension=" + ROOT,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check"
        ],
        viewport: { width: 1440, height: 1000 }
    })
    if (cookies.length) await context.addCookies(cookies)
    const page = context.pages()[0] || await context.newPage()
    page.on("console", msg => {
        const text = msg.text()
        if (/error|warn|AES/i.test(text)) report.steps.push({ name: "console", type: msg.type(), text: text.slice(0, 400) })
    })
    page.on("pageerror", err => report.steps.push({ name: "pageerror", text: String(err).slice(0, 400) }))

    try {
        const login = await loginIfNeeded(page)
        step("login-ready", login)

        await page.goto(HOST + "/app/enterprise/dashboard?select=" + encodeURIComponent(ENTERPRISE_ID), {
            waitUntil: "domcontentloaded"
        })
        await page.waitForLoadState("networkidle").catch(() => {})
        step("enterprise-selected", { enterpriseId: ENTERPRISE_ID, url: page.url() })

        const existingNumbers = await parseRoster(page, [String(BASE_FN), String(BASE_FN + 1)])
        step("preflight-flight-numbers", {
            baseFn: BASE_FN,
            targetNumbers: [String(BASE_FN), String(BASE_FN + 1)],
            existing: existingNumbers
        })
        if (existingNumbers.length) {
            if (VERIFY_EXISTING) {
                const schedule = await readCurrentSchedule(page)
                const verification = verifyScheduleHits(schedule, [BASE_FN])
                step("schedule-verified-existing", {
                    valid: verification.valid,
                    hits: verification.hits,
                    existing: existingNumbers,
                    shot: await screenshot(page, "route-builder-final-05-schedule")
                })
                if (!verification.valid) throw new Error("existing flight schedule verification failed")
                report.ok = true
                return
            }
            throw new Error("target flight numbers already exist: " + JSON.stringify(existingNumbers))
        }

        await page.goto(HOST + "/app/fleets/aircraft/" + AIRCRAFT + "/0?codex-final=" + Date.now(), {
            waitUntil: "domcontentloaded"
        })
        await page.waitForTimeout(3000)
        if (/login/i.test(page.url())) throw new Error("not logged in: " + page.url())
        step("loaded-afp", { url: page.url(), shot: await screenshot(page, "route-builder-final-01-loaded") })

        const seed = await seedRouteBuilder(page)
        step("seeded-route-builder", {
            presetId: seed.presetId,
            candidates: seed.candidates,
            tier: seed.settings && seed.settings.autoScheduler && seed.settings.autoScheduler.tier
        })

        await page.waitForTimeout(1000)
        await clickButtonByText(page, "Build draft")
        let built = null
        try {
            built = await waitFor(page, async () => {
                const state = await page.evaluate(() => {
                    const el = document.querySelector("[data-aes-studio-auto-build]")
                    const hint = document.querySelector("[data-aes-studio-hint]")
                    return {
                        text: el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "",
                        hint: hint ? (hint.textContent || "").replace(/\s+/g, " ").trim() : ""
                    }
                })
                return /Auto-build .*2 legs/.test(state.text) ? Object.assign({ ok: true }, state) : Object.assign({ ok: false }, state)
            }, 45000, "auto-build 2 legs")
        } catch (buildErr) {
            const state = await page.evaluate(() => {
                const hint = document.querySelector("[data-aes-studio-hint]")
                return {hint: hint ? (hint.textContent || "").replace(/\s+/g, " ").trim() : ""}
            }).catch(() => ({hint: ""}))
            step("auto-build-blocked", {
                error: (buildErr && buildErr.message) || String(buildErr),
                hint: state.hint
            })
            if (!ALLOW_MANUAL_FALLBACK) {
                throw new Error("auto-build produced no conflict-free legs; manual live fallback disabled")
            }
            const manual = await submitManualSingleLeg(page, seed)
            step("manual-single-leg-submit", manual)
            if (!manual || !manual.ok) {
                throw new Error("manual single-leg submit failed: " + JSON.stringify(manual))
            }
            const singleRoster = await waitFor(page, async () => {
                const rows = await parseRoster(page, [String(BASE_FN)])
                return rows.length >= 1 ? { ok: true, rows } : { ok: false, rows }
            }, 120000, "single roster row")
            step("roster-created", { rows: singleRoster.rows, shot: await screenshot(page, "route-builder-final-04-roster") })
            const schedule = await readCurrentSchedule(page)
            const verification = verifyScheduleHits(schedule, [BASE_FN])
            step("schedule-verified", {
                valid: verification.valid,
                hits: verification.hits,
                shot: await screenshot(page, "route-builder-final-05-schedule")
            })
            if (!verification.valid) throw new Error("single-leg schedule day-mask validation failed")
            report.ok = true
            return
        }
        step("built-draft", { text: built.text, shot: await screenshot(page, "route-builder-final-02-built") })

        step("set-flight-number", await setFlightNumber(page, BASE_FN))
        await clickButtonByText(page, "Preview")
        await page.waitForTimeout(2000)
        const dry = await page.evaluate(() => {
            const el = document.querySelector("[data-aes-studio-dry-body]")
            return el ? (el.textContent || "").slice(0, 1200) : ""
        })
        step("previewed", { dryRunSnippet: dry, shot: await screenshot(page, "route-builder-final-03-preview") })

        await clickButtonByText(page, "Create flights")
        await page.waitForSelector("[data-aes-afp-auto-confirm]", { timeout: 15000 })
        const ack = await ackAndApply(page)
        step("confirmed-apply", ack)

        const roster = await waitFor(page, async () => {
            const rows = await parseRoster(page, [String(BASE_FN), String(BASE_FN + 1)])
            return rows.length >= 2 ? { ok: true, rows } : { ok: false, rows }
        }, 120000, "roster rows")
        step("roster-created", { rows: roster.rows, shot: await screenshot(page, "route-builder-final-04-roster") })

        const schedule = await readCurrentSchedule(page)
        const verification = verifyScheduleHits(schedule, [BASE_FN, BASE_FN + 1])
        step("schedule-verified", {
            valid: verification.valid,
            hits: verification.hits,
            shot: await screenshot(page, "route-builder-final-05-schedule")
        })
        if (!verification.valid) throw new Error("final schedule day-mask validation failed")
        report.ok = true
    } finally {
        await fs.writeFile(REPORT, JSON.stringify(report, null, 2))
        await context.close()
        step("report-written", { report: path.relative(ROOT, REPORT) })
    }
}

main().catch(async err => {
    report.ok = false
    report.error = err && err.stack || String(err)
    await fs.writeFile(REPORT, JSON.stringify(report, null, 2)).catch(() => {})
    console.error(err && err.stack || err)
    process.exit(1)
})
