import { chromium } from "playwright"
import fs from "node:fs/promises"
import path from "node:path"

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname)
const OUT = path.join(ROOT, "audit", "pw-rb-shots")
const REPORT = path.join(ROOT, "audit", "pw-rb-workbench-report.json")
const CHROME = process.env.CHROME_BIN
    || "/Users/jihwan/.cache/chrome-for-testing/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
const SOURCE_PORT = Number(process.env.AES_SOURCE_PORT || 9241)
const AIRCRAFT = process.env.AES_AIRCRAFT_ID || "22092"
const HOST = "https://free1.airlinesim.aero"
const BASE_FN = Number(process.env.AES_BASE_FN || 34)

const report = { startedAt: new Date().toISOString(), ok: false, steps: [] }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function step(name, data = {}) {
    const row = Object.assign({ name, at: new Date().toISOString() }, data)
    report.steps.push(row)
    console.log(JSON.stringify(row))
}

async function writeReport() {
    await fs.writeFile(REPORT, JSON.stringify(report, null, 2))
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
                if (res && res.result && res.result.value === true) return { client, contextId: ctx.id }
            } catch (_) {
                // Navigations can retire isolated worlds.
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
        "window.AesAfp || window.AesAfpRouteBuilderPlanner || window.AesAfpAutoSchedulerPreview",
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

async function waitFor(page, fn, timeoutMs, label) {
    const start = Date.now()
    let last = null
    while (Date.now() - start < timeoutMs) {
        last = await fn()
        if (last && last.ok) return last
        await page.waitForTimeout(500)
    }
    throw new Error("timeout waiting for " + label + ": " + JSON.stringify(last))
}

async function clickButtonByText(page, text, scope = "document") {
    const out = await page.evaluate(({ text, scope }) => {
        const root = scope === "modal" ? document.querySelector("[data-aes-afp-auto-confirm]") : document
        if (!root) return { ok: false, error: "scope not found" }
        const wanted = String(text).toLowerCase()
        const buttons = Array.from(root.querySelectorAll("button, input[type='button'], input[type='submit']"))
        const btn = buttons.find(b => String(b.textContent || b.value || "").trim().toLowerCase() === wanted)
            || buttons.find(b => String(b.textContent || b.value || "").trim().toLowerCase().includes(wanted))
        if (!btn) {
            return { ok: false, error: "button not found",
                buttons: buttons.map(b => String(b.textContent || b.value || "").trim()).filter(Boolean) }
        }
        btn.scrollIntoView({ block: "center", inline: "center" })
        btn.click()
        return { ok: true, label: String(btn.textContent || btn.value || "").trim() }
    }, { text, scope })
    if (!out || !out.ok) throw new Error("click " + text + ": " + JSON.stringify(out))
    return out
}

async function setWorkbench(page, cfg) {
    const out = await page.evaluate((cfg) => {
        const title = Array.from(document.querySelectorAll("div"))
            .find(el => String(el.textContent || "").trim() === "Route builder workbench")
        const box = title && title.parentElement && title.parentElement.parentElement
        if (!box) return { ok: false, error: "workbench not found" }
        function label(name) {
            const target = String(name).toLowerCase()
            return Array.from(box.querySelectorAll("label")).find(l => {
                const span = l.querySelector("span")
                return span && String(span.textContent || "").trim().toLowerCase() === target
            })
        }
        function setValue(name, value) {
            const wrap = label(name)
            const input = wrap && wrap.querySelector("input, select")
            if (!input) return false
            input.value = String(value)
            input.dispatchEvent(new Event("input", { bubbles: true }))
            input.dispatchEvent(new Event("change", { bubbles: true }))
            return true
        }
        const ok = []
        if (cfg.flights != null) ok.push(setValue("Flights", cfg.flights))
        if (cfg.airports != null) ok.push(setValue("Auto airports", cfg.airports))
        if (cfg.structure != null) ok.push(setValue("Structure", cfg.structure))
        if (cfg.start != null) ok.push(setValue("Start", cfg.start))
        if (cfg.firstDay != null) ok.push(setValue("First day", cfg.firstDay))
        if (cfg.turn != null) ok.push(setValue("Turn", cfg.turn))
        if (cfg.included != null) {
            const wrap = label("Included airports")
            const input = wrap && wrap.querySelector("input")
            if (!input) ok.push(false)
            else {
                input.value = String(cfg.included)
                input.dispatchEvent(new Event("input", { bubbles: true }))
                input.dispatchEvent(new Event("change", { bubbles: true }))
                ok.push(true)
            }
        }
        return { ok: ok.every(Boolean), checks: ok, text: box.textContent.slice(0, 500) }
    }, cfg)
    if (!out || !out.ok) throw new Error("set workbench failed: " + JSON.stringify(out))
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
        return { ok: true, checkedCount: boxes.filter(b => b.checked).length, applyDisabled: !!(apply && apply.disabled) }
    })
    if (!out.ok || out.applyDisabled) throw new Error("modal ack failed: " + JSON.stringify(out))
    await clickButtonByText(page, "Apply", "modal")
    return out
}

async function seedWorkbench(page) {
    return await evalAes(page, `(
        async () => {
            const now = Date.now()
            await AesAfpSettings.save({
                defaultDepartureTime: "07:30",
                defaultPricePct: 100,
                autoScheduler: {
                    enabled: true,
                    tier: "apply-on-confirm",
                    requireConfirm: true,
                    maxLegsPerApply: 4,
                    fallbackMaxWeeklyBlockHours: 24,
                    fallbackMaxDailyBlockHours: 18,
                    fillToBudget: false
                }
            })
            const rows = [{
                hub: "LHR",
                destIata: "JFK",
                destName: "New York John F. Kennedy",
                distanceKm: 5535,
                distanceNm: 2989,
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
                source: "codex workbench validation"
            }]
            const blob = { server: "free1", hub: "LHR", scrapedAt: now, snapshotAt: now, rows }
            const writes = { "routeAssistant:topRoutes:LHR": blob }
            if (typeof acctKey === "function") writes[acctKey("routeAssistant:topRoutes", "LHR")] = blob
            await chrome.storage.local.set(writes)
            if (window.AesAfpRouteCandidates && typeof AesAfpRouteCandidates.compute === "function") {
                const ctx = window.AesAfp && window.AesAfp.ctx || {}
                const spec = window.AesAfpSpecResolver && AesAfpSpecResolver.last || null
                const settings = await AesAfpSettings.load()
                await AesAfpRouteCandidates.compute({
                    originIata: "LHR",
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
            if (window.AesAfpAutoSchedulerPreview && AesAfpAutoSchedulerPreview.render) {
                AesAfpAutoSchedulerPreview.render()
            }
            return {
                planner: !!window.AesAfpRouteBuilderPlanner,
                preview: !!window.AesAfpAutoSchedulerPreview,
                candidates: (window.AesAfpRouteCandidates && AesAfpRouteCandidates.last || [])
                    .map(c => ({ destIata: c.destIata, distanceKm: c.distanceKm, scoreBlend: c.scoreBlend }))
                    .slice(0, 10)
            }
        }
    )()`, 45000)
}

async function plannerBuild(page) {
    return await evalAes(page, `(
        () => {
            const b = window.AesAfpAutoSchedulerPreview && AesAfpAutoSchedulerPreview.lastBuild
            if (!b) return null
            return {
                validation: b.validation || [],
                metadata: b.metadata || {},
                flights: (b.flights || []).map(f => ({
                    seq: f.seq,
                    origin: f.origin,
                    destination: f.destination,
                    direction: f.direction,
                    depTimeLocal: f.depTimeLocal,
                    dayMask: f.dayMask,
                    rangeBucket: f.rangeBucket
                }))
            }
        }
    )()`)
}

async function setFlightNumbers(page, baseFn) {
    return await evalAes(page, `(
        async () => {
            const ctx = window.AesAfp && AesAfp.ctx || {}
            if (!ctx.server || !ctx.aircraftId) return { ok: false, error: "ctx missing" }
            await AesAfpActiveDraftStore.setEdit(ctx.server, ctx.aircraftId, 1, { flightNumberText: "${baseFn}" })
            await AesAfpActiveDraftStore.setEdit(ctx.server, ctx.aircraftId, 2, { flightNumberText: "${baseFn + 1}" })
            return {
                ok: true,
                draft: await AesAfpActiveDraftStore.load(ctx.server, ctx.aircraftId)
            }
        }
    )()`, 30000)
}

async function waitApplyDone(page) {
    return await waitFor(page, async () => {
        const state = await evalAes(page, `(
            () => {
                const s = window.AesAfpAutoApplyBatch && AesAfpAutoApplyBatch.state
                return s ? {
                    inFlight: s.inFlight,
                    total: s.total,
                    completed: s.completed,
                    succeeded: s.succeeded,
                    failed: s.failed,
                    lastError: s.lastError,
                    results: s.results || []
                } : null
            }
        )()`, 10000).catch(err => ({ error: String(err) }))
        return state && state.inFlight === false && state.total >= 2 && state.completed >= 2
            ? { ok: true, state }
            : { ok: false, state }
    }, 120000, "apply completion")
}

async function parseRosterAll(page) {
    await page.goto(HOST + "/app/com/numbers?rbw-roster=" + Date.now(), { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(1200)
    return await page.evaluate(() => {
        return Array.from(document.querySelectorAll("tbody#flightNumbers tr, table tbody tr"))
            .map(tr => {
                const cells = Array.from(tr.querySelectorAll("td"))
                    .map(td => (td.textContent || "").replace(/\s+/g, " ").trim())
                const link = tr.querySelector("a[href*='/app/com/numbers/'], a[href*='/numbers/']")
                const href = link && link.href || ""
                const m = href.match(/\/numbers\/(\d+)/)
                return {
                    flightId: m ? m[1] : "",
                    number: cells[1] || "",
                    days: cells[2] || "",
                    origin: cells[3] || "",
                    departure: cells[4] || "",
                    destination: cells[5] || "",
                    href,
                    text: (tr.textContent || "").replace(/\s+/g, " ").trim()
                }
            })
            .filter(row => row.flightId && row.number)
    })
}

async function parseRoster(page, nums) {
    const set = new Set((nums || []).map(String))
    const rows = await parseRosterAll(page)
    return rows.filter(row => set.has(String(row.number)))
}

async function findWorkbenchRows(page) {
    const rows = await parseRosterAll(page)
    return rows.filter(row => {
        const n = String(row.number)
        return n === String(BASE_FN) || n === String(BASE_FN + 1)
    })
}

async function readCurrentSchedule(page) {
    await page.goto(HOST + "/app/fleets/aircraft/" + AIRCRAFT + "/0?rbw-schedule=" + Date.now(), {
        waitUntil: "domcontentloaded"
    })
    await page.waitForTimeout(2500)
    return await evalAes(page, `(
        () => {
            const rows = (window.AesAfp && typeof AesAfp.getCurrentSchedule === "function")
                ? (AesAfp.getCurrentSchedule() || []) : []
            return rows.map(l => ({
                seq: l.seq,
                dayIdx: l.dayIdx,
                dayName: l.dayName,
                depTimeLocal: l.depTimeLocal,
                arrTimeLocal: l.arrTimeLocal,
                origin: l.origin,
                destination: l.destination,
                flightNumber: l.flightNumber,
                flightId: l.flightId,
                flightLink: l.flightLink
            }))
        }
    )()`, 30000)
}

async function verifySchedule(page, label, results) {
    const ids = (Array.isArray(results) ? results : [])
        .map(r => r && r.flightId != null ? String(r.flightId) : "")
        .filter(Boolean)
    if (ids.length < 2) throw new Error(label + " missing result flight IDs: " + JSON.stringify(results))
    const wantedIds = new Set(ids)
    const roster = await waitFor(page, async () => {
        const rows = (await parseRosterAll(page)).filter(row => wantedIds.has(String(row.flightId)))
        return rows.length >= ids.length ? { ok: true, rows } : { ok: false, rows }
    }, 120000, label + " roster")
    const schedule = await readCurrentSchedule(page)
    const hits = schedule.filter(l => wantedIds.has(String(l.flightId)))
    const valid = ids.every(id => {
        const rows = hits.filter(l => String(l.flightId) === id)
        return rows.length === 1 && rows[0].dayIdx === 0
    })
    if (!valid) throw new Error(label + " schedule validation failed: " + JSON.stringify(hits))
    return { roster: roster.rows, hits }
}

async function unassignAndDelete(page, rows) {
    const items = rows.map(r => ({
        number: String(r.number),
        flightId: String(r.flightId || ""),
        origin: String(r.origin || "").match(/[A-Z]{3}/)?.[0] || "",
        destination: String(r.destination || "").match(/[A-Z]{3}/)?.[0] || ""
    })).filter(r => r.flightId && r.origin && r.destination)
    for (const r of items) {
        await page.goto(HOST + "/app/com/scheduling/" + r.origin + r.destination + "?fnid=" + r.flightId,
            { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(1200)
        const removed = await page.evaluate(() => {
            const boxes = Array.from(document.querySelectorAll(
                "input[type='checkbox'][name*='daySelection:'][name*=':ticked']"))
            boxes.forEach(b => { if (!b.checked) b.click() })
            const btn = document.querySelector("input[type='submit'][name*='button-remove']")
                || Array.from(document.querySelectorAll("button,input[type='submit']"))
                    .find(b => /remove selected days/i.test(String(b.textContent || b.value || "")))
            if (!btn) return { ok: false, error: "remove button missing", boxes: boxes.length }
            btn.click()
            return { ok: true, boxes: boxes.length }
        })
        if (!removed.ok) throw new Error("unassign failed " + JSON.stringify({ r, removed }))
        await page.waitForTimeout(2500)
    }
    for (const r of items) {
        await page.goto(HOST + "/app/com/numbers/" + r.flightId, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(1200)
        const deleted = await page.evaluate(() => {
            const form = Array.from(document.querySelectorAll("form"))
                .find(f => String(f.getAttribute("action") || "").includes("-delete~form"))
            if (!form) return { ok: false, error: "delete form missing" }
            const btn = form.querySelector("input[type='submit'], button[type='submit'], button, input[type='button']")
            if (!btn) return { ok: false, error: "delete button missing" }
            btn.click()
            return { ok: true }
        })
        if (!deleted.ok) throw new Error("delete failed " + JSON.stringify({ r, deleted }))
        await page.waitForTimeout(2500)
    }
    const ids = new Set(items.map(r => String(r.flightId)))
    return (await parseRosterAll(page)).filter(row => ids.has(String(row.flightId)))
}

async function recommendWorkbench(page, cfg) {
    await page.goto(HOST + "/app/fleets/aircraft/" + AIRCRAFT + "/0?rbw=" + Date.now(), {
        waitUntil: "domcontentloaded"
    })
    await page.waitForTimeout(3000)
    await setWorkbench(page, cfg)
    await clickButtonByText(page, "Recommend schedule")
    return await waitFor(page, async () => {
        const b = await plannerBuild(page)
        return b && b.flights && b.flights.length === Number(cfg.flights)
            && b.metadata && b.metadata.scheduleType === cfg.structure
            ? { ok: true, build: b }
            : { ok: false, build: b }
    }, 45000, cfg.structure + " recommendation")
}

async function applyWorkbenchPair(page, label) {
    const built = await recommendWorkbench(page, {
        structure: "hubShuttle",
        flights: 2,
        airports: 1,
        start: "07:30",
        firstDay: 0,
        turn: 60,
        included: "JFK"
    })
    const numbered = await setFlightNumbers(page, BASE_FN)
    if (!numbered || !numbered.ok) {
        throw new Error(label + " failed to reserve workbench flight numbers: " + JSON.stringify(numbered))
    }
    step(label + "-numbered", {
        numbers: [String(BASE_FN), String(BASE_FN + 1)]
    })
    step(label + "-built", { build: built.build, shot: await screenshot(page, label + "-built") })
    await clickButtonByText(page, "Apply all 2 flights")
    await page.waitForSelector("[data-aes-afp-auto-confirm]", { timeout: 15000 })
    const ack = await ackAndApply(page)
    step(label + "-confirmed", ack)
    const done = await waitApplyDone(page)
    step(label + "-apply-done", done.state)
    if (!done.state || done.state.failed) {
        throw new Error(label + " apply failed: " + JSON.stringify(done.state))
    }
    const verified = await verifySchedule(page, label, done.state.results)
    step(label + "-verified", {
        roster: verified.roster,
        hits: verified.hits,
        shot: await screenshot(page, label + "-verified")
    })
    return verified
}

async function main() {
    const source = await chromium.connectOverCDP("http://127.0.0.1:" + SOURCE_PORT)
    const cookies = await source.contexts()[0].cookies(HOST)
    await source.close()
    step("copied-cookies", { count: cookies.length })

    const profile = "/tmp/aes-route-builder-workbench-" + Date.now()
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
    await context.addCookies(cookies)
    const page = context.pages()[0] || await context.newPage()
    page.on("console", msg => {
        const text = msg.text()
        if (/error|warn|AES/i.test(text)) report.steps.push({ name: "console", type: msg.type(), text: text.slice(0, 500) })
    })
    page.on("pageerror", err => report.steps.push({ name: "pageerror", text: String(err).slice(0, 500) }))

    try {
        await page.goto(HOST + "/app/fleets/aircraft/" + AIRCRAFT + "/0?rbw-load=" + Date.now(), {
            waitUntil: "domcontentloaded"
        })
        await page.waitForTimeout(3000)
        if (/login/i.test(page.url())) throw new Error("not logged in: " + page.url())
        step("loaded-afp", { url: page.url(), shot: await screenshot(page, "rbw-01-loaded") })
        const seed = await seedWorkbench(page)
        step("seeded", seed)

        const existing = await findWorkbenchRows(page)
        if (existing.length) {
            step("pre-clean-existing", { rows: existing })
            const afterClean = await unassignAndDelete(page, existing)
            if (afterClean.length) throw new Error("pre-clean left rows: " + JSON.stringify(afterClean))
            step("pre-clean-complete")
        }

        const chain = await recommendWorkbench(page, {
            structure: "chainLoop",
            flights: 3,
            airports: 1,
            start: "07:30",
            firstDay: 0,
            turn: 60,
            included: "JFK"
        })
        const chainRoutes = chain.build.flights.map(f => f.origin + "-" + f.destination)
        if (chainRoutes.join(",") !== "LHR-JFK,JFK-LHR,LHR-JFK") {
            throw new Error("chain routes invalid: " + chainRoutes.join(","))
        }
        step("chain-smoke", { routes: chainRoutes, build: chain.build,
            shot: await screenshot(page, "rbw-02-chain") })

        const first = await applyWorkbenchPair(page, "rbw-first")
        const afterDelete = await unassignAndDelete(page, first.roster)
        if (afterDelete.length) throw new Error("reverse left rows: " + JSON.stringify(afterDelete))
        step("reversed-first-apply", { remaining: afterDelete, shot: await screenshot(page, "rbw-05-reversed") })

        await applyWorkbenchPair(page, "rbw-final")
        report.ok = true
    } finally {
        await writeReport()
        await context.close()
        step("report-written", { report: path.relative(ROOT, REPORT) })
    }
}

main().catch(async err => {
    report.ok = false
    report.error = err && err.stack || String(err)
    await writeReport().catch(() => {})
    console.error(err && err.stack || err)
    process.exit(1)
})
