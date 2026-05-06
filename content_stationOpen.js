"use strict";

/**
 * AES Station Automation — per-tab worker.
 *
 * Runs on /app/info/airports/<id> and /app/ops/stations*. A single parent tab
 * (the AES dashboard) spawns up to N worker tabs via window.open, each with a
 * URL hash like `#aesStationChunk=<runId>:<chunkIdx>` that identifies a slice
 * of the run's airport list. Each tab processes its slice sequentially:
 *
 *   airport page → click "Open Station" → success page → write result →
 *   navigate to next airport in chunk → (repeat) → close tab.
 *
 * State lives in sessionStorage so the click-through navigation within one
 * tab carries the chunk and position forward. Per-airport results are written
 * to chrome.storage under a runId-keyed prefix so the dashboard can aggregate
 * live progress without contending with other tabs.
 */

const SESSION_STATE_KEY = "aes-station-worker"
const ACTION_WAIT_MS = 10000
const ACTION_POLL_MS = 300

window.addEventListener("load", async () => {
    await workerTick()
})

async function workerTick() {
    const server = AES.getServerName()
    const airlineId = AES.getAirlineIdentity()
    if (!airlineId) return

    let state = readSessionState()
    const hashCtx = parseHashContext()
    if (hashCtx) {
        // First load of this tab — hydrate state from the run session.
        const run = await StationAutomationStorage.loadRun(server, airlineId, hashCtx.runId)
        if (!run || run.status !== "running" || !run.chunks[hashCtx.chunkIdx]) {
            console.warn("[AES stationAutomation] chunk not found or run not active", hashCtx)
            window.close()
            return
        }
        state = {
            runId: hashCtx.runId,
            chunkIdx: hashCtx.chunkIdx,
            chunk: run.chunks[hashCtx.chunkIdx],
            positionIdx: 0,
            pending: null,
        }
        writeSessionState(state)
        // Drop the hash so future in-tab navigations aren't repeatedly re-hydrated.
        history.replaceState(null, "", window.location.pathname + window.location.search)
    }

    if (!state) return // manual visit, not part of a run

    // If the run was cancelled elsewhere, bail out.
    const run = await StationAutomationStorage.loadRun(server, airlineId, state.runId)
    if (!run || run.status !== "running") {
        window.close()
        return
    }

    // Reconcile a pending click from the previous page (success-page load).
    if (state.pending) {
        const {iata, flatIdx} = state.pending
        const outcome = detectOutcome(iata)
        await StationAutomationStorage.writeResult(server, airlineId, state.runId, flatIdx, {
            iata,
            status: outcome.status,
            detail: outcome.detail,
            finishedAt: Date.now(),
        })
        state.pending = null
        state.positionIdx++
        writeSessionState(state)
    }

    if (state.positionIdx >= state.chunk.length) {
        window.close()
        return
    }

    const target = state.chunk[state.positionIdx]
    if (!target.airportId) {
        await StationAutomationStorage.writeResult(server, airlineId, state.runId, target.flatIdx, {
            iata: target.iata,
            status: "failed",
            detail: "No airportId resolved from country page.",
            finishedAt: Date.now(),
        })
        state.positionIdx++
        writeSessionState(state)
        return workerTick()
    }

    if ((target.exceptions || []).map(s => String(s).toUpperCase()).includes((target.iata || "").toUpperCase())) {
        await StationAutomationStorage.writeResult(server, airlineId, state.runId, target.flatIdx, {
            iata: target.iata,
            status: "skipped",
            detail: "In exceptions list.",
            finishedAt: Date.now(),
        })
        state.positionIdx++
        writeSessionState(state)
        // Same tab but different airport → need to navigate there before continuing.
        return navigateToTarget(server, state)
    }

    const currentAirportId = parseAirportIdFromUrl()
    if (currentAirportId !== String(target.airportId)) {
        return navigateToTarget(server, state)
    }

    if (alreadyOperatingHere(target.iata)) {
        await StationAutomationStorage.writeResult(server, airlineId, state.runId, target.flatIdx, {
            iata: target.iata,
            status: "skipped-existing",
            detail: "Already in your network.",
            finishedAt: Date.now(),
        })
        state.positionIdx++
        writeSessionState(state)
        return navigateToTarget(server, state)
    }

    const action = await waitForOpenStationAction()
    if (!action) {
        await StationAutomationStorage.writeResult(server, airlineId, state.runId, target.flatIdx, {
            iata: target.iata,
            status: "failed",
            detail: "Open-station action not found. Visible: " + listActionableElements(),
            finishedAt: Date.now(),
        })
        state.positionIdx++
        writeSessionState(state)
        return navigateToTarget(server, state)
    }

    state.pending = {iata: target.iata, flatIdx: target.flatIdx}
    writeSessionState(state)

    try { action.focus() } catch (_) {}
    action.click()

    const outcome = await waitForClickOutcome(target.iata)
    if (outcome === "navigating") return // the next page load reconciles

    // No navigation within the timeout — record outcome in place and move on.
    const inPageFeedback = findAnyFeedbackText()
    const skippedExisting = inPageFeedback && ALREADY_EXISTS_RE.test(inPageFeedback)
    await StationAutomationStorage.writeResult(server, airlineId, state.runId, target.flatIdx, {
        iata: target.iata,
        status: outcome === "opened" ? "ok" : skippedExisting ? "skipped-existing" : "failed",
        detail: outcome === "opened" ? "Opened."
            : skippedExisting ? inPageFeedback
            : inPageFeedback || (outcome === "error" ? "Server rejected." : "No result after click."),
        finishedAt: Date.now(),
    })
    state.pending = null
    state.positionIdx++
    writeSessionState(state)
    return navigateToTarget(server, state)
}

function navigateToTarget(server, state) {
    if (state.positionIdx >= state.chunk.length) {
        window.close()
        return
    }
    const next = state.chunk[state.positionIdx]
    if (!next.airportId) {
        // Skip and continue; avoids a broken navigation.
        return workerTick()
    }
    window.location.assign(airportUrl(server, next.airportId))
}

function readSessionState() {
    try {
        const raw = sessionStorage.getItem(SESSION_STATE_KEY)
        return raw ? JSON.parse(raw) : null
    } catch (_) { return null }
}

function writeSessionState(state) {
    try { sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(state)) } catch (_) {}
}

function parseHashContext() {
    const m = window.location.hash.match(/#aesStationChunk=([^:]+):(\d+)/)
    return m ? {runId: m[1], chunkIdx: parseInt(m[2], 10)} : null
}

function airportUrl(server, airportId) {
    return `https://${server}.airlinesim.aero/app/info/airports/${airportId}`
}

function parseAirportIdFromUrl() {
    const m = window.location.pathname.match(/\/app\/info\/airports\/(\d+)/)
    return m ? m[1] : null
}

const ALREADY_EXISTS_RE = /(already\s+(operate|open|have|has|running|in)|station.*already|exist|in\s+your\s+network)/i

/**
 * After the click navigates to the success page, classify the outcome by
 * looking for AS's feedbackPanel and/or the Close-Station button. AS replies
 * with a WARNING-class feedback when the airline already operates at the
 * target airport — treat that as skipped-existing, not failed.
 */
function detectOutcome(iata) {
    if (successBannerPresent()) return {status: "ok", detail: "Opened."}
    if (appearsInStationsTable(iata) || alreadyOperatingHere(iata)) return {status: "ok", detail: "Opened."}
    const feedback = findAnyFeedbackText()
    if (feedback && ALREADY_EXISTS_RE.test(feedback)) {
        return {status: "skipped-existing", detail: feedback}
    }
    if (feedback) return {status: "failed", detail: feedback}
    return {status: "failed", detail: "Click completed but no success indicator."}
}

function successBannerPresent() {
    return !!document.querySelector(".feedbackPanelSUCCESS, .feedbackPanelINFO")
}

function findAnyFeedbackText() {
    for (const el of document.querySelectorAll(".feedbackPanelSUCCESS, .feedbackPanelINFO, .feedbackPanelWARNING, .feedbackPanelERROR, .feedbackPanelFATAL, .alert, .error")) {
        const t = (el.innerText || "").trim()
        if (t) return t
    }
    return findErrorBannerText()
}

const OPERATING_ACTION_RE = /close\s*station|shut\s*(down)?\s*station|abandon\s*station/i

/**
 * True when this page shows a "Close Station" / "Shut down station" action —
 * reliable only on the station-detail page (/app/ops/stations/<IATA>). On the
 * airport info page (/app/info/airports/<id>) AS shows a generic "XYZ Station"
 * link for every airport, so link-based signals would false-positive and
 * cause the worker to skip airports that aren't actually open. Relies on the
 * dashboard's pre-filter and the post-click feedback-panel check for the
 * airport-page side of the "already open" detection.
 */
function alreadyOperatingHere(iata) {
    for (const el of document.querySelectorAll("a, button")) {
        const t = (el.innerText || el.value || "").trim()
        if (OPERATING_ACTION_RE.test(t)) return true
    }
    return false
}

function appearsInStationsTable(iata) {
    const want = iata.toUpperCase()
    const wantWord = new RegExp(`\\b${want}\\b`)
    const paren = `(${want})`
    const tables = document.getElementsByTagName("table")
    for (let i = 0; i < tables.length; i++) {
        const table = tables[i]
        const headRow = table.tHead ? table.tHead.rows[0] : table.rows[0]
        const h = (headRow ? (headRow.innerText || headRow.textContent || "") : "").toLowerCase()

        if (!(h.includes("iata") || h.includes("code") || h.includes("apt") || h.includes("station"))) {
             continue;
        }

        const rows = table.rows;
        for (let j = 0; j < rows.length; j++) {
            const row = rows[j];

            let hasTh = false;
            let hasTd = false;
            for (let k = 0; k < row.cells.length; k++) {
                const tagName = row.cells[k].tagName;
                if (tagName === "TH") hasTh = true;
                if (tagName === "TD") hasTd = true;
            }
            if (hasTh && !hasTd) continue;

            const txt = (row.innerText || row.textContent || "").toUpperCase()
            if (!txt) continue
            if (txt.includes(paren) || wantWord.test(txt)) return true
        }
    }
    return false
}

const OPEN_ACTION_RE = /(open\s*(new\s*|a\s*)?station|\+\s*station|\+\s*open|^\s*open\s*$|apply\s*to\s*open|request\s*station|found\s*station|establish\s*station|new\s*station|launch\s*station|station\s*here|base\s*here)/i

function findOpenStationAction() {
    for (const el of document.querySelectorAll("a, button, input[type='submit'], [role='button']")) {
        if (el.disabled) continue
        const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim()
        if (OPEN_ACTION_RE.test(text)) return el
        const href = el.getAttribute?.("href") || ""
        if (/\bopen\b/i.test(href) && /station|airport/i.test(href)) return el
    }
    return null
}

/** Polls briefly for an AJAX-rendered action. */
async function waitForOpenStationAction(maxMs = 3000, stepMs = 250) {
    const started = Date.now()
    while (true) {
        const action = findOpenStationAction()
        if (action) return action
        if (Date.now() - started >= maxMs) return null
        await new Promise(r => setTimeout(r, stepMs))
    }
}

function waitForClickOutcome(iata) {
    return new Promise(resolve => {
        const started = Date.now()
        let done = false
        const finish = outcome => {
            if (done) return
            done = true
            clearInterval(timer)
            window.removeEventListener("beforeunload", onUnload)
            resolve(outcome)
        }
        const onUnload = () => finish("navigating")
        window.addEventListener("beforeunload", onUnload, {once: true})
        const timer = setInterval(() => {
            if (successBannerPresent() || appearsInStationsTable(iata) || alreadyOperatingHere(iata)) return finish("opened")
            if (findErrorBannerText()) return finish("error")
            if (Date.now() - started >= ACTION_WAIT_MS) return finish("timeout")
        }, ACTION_POLL_MS)
    })
}

const ERROR_BANNER_SELECTORS = [
    ".feedbackPanelERROR", ".feedbackPanelFATAL", ".feedbackPanelWARNING",
    ".alert-danger", ".alert-warning",
    "[class*='error' i]:not(input)", "[class*='danger' i]:not(button)",
    ".alert", ".error",
]

const COMBINED_ERROR_BANNER_SELECTOR = ERROR_BANNER_SELECTORS.join(', ');

function findErrorBannerText() {
    for (const el of document.querySelectorAll(COMBINED_ERROR_BANNER_SELECTOR)) {
        const text = (el.innerText || "").trim()
        if (text && text.length < 500) return text
    }
    return ""
}

function listActionableElements() {
    const items = []
    for (const el of document.querySelectorAll("a.btn, a[role='button'], button, input[type='submit'], .as-action-bar a, .as-action-bar button")) {
        const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().replace(/\s+/g, " ")
        if (!text) continue
        items.push(text.slice(0, 60))
        if (items.length >= 12) break
    }
    return items.length ? items.join(" | ") : "no visible buttons/links"
}

// --- BENCHMARK ---
try {
    if (typeof window !== "undefined" && window.location && window.location.search && window.location.search.includes("aes-debug")) {
        console.assert(appearsInStationsTable("XYZ") === false, "Smoke test: XYZ not in table");

        window.aesBenchmarkStationOpen = function() {
            const iataToFind = "XYZ";
            const ITERATIONS = 1000;

            console.log(`Starting benchmark for appearsInStationsTable('${iataToFind}')...`);
            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) {
                appearsInStationsTable(iataToFind);
            }
            const end = performance.now();
            console.log(`Benchmark completed. Execution time for ${ITERATIONS} iterations: ${(end - start).toFixed(2)} ms`);
        };
    }
} catch (e) {
    // Ignore execution contexts without window
}
