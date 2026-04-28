"use strict"

/**
 * Fleet Schedule Grid — bulk scraper.
 *
 * Walks a fleet roster and produces a Map<aircraftId, Schedule> by:
 *   1. Reading the persisted Schedule from `AesAfpScheduleStore` when fresh
 *      (AFP page was visited within `maxAgeMs` — default 10 min).
 *   2. Otherwise GET-fetching `/app/fleets/aircraft/<id>/0` (credentials
 *      included), parsing the HTML with `DOMParser`, running
 *      `AesAfpVfpReader.readFromRoot()` on the parsed Document, and
 *      persisting the result via `AesAfpScheduleStore.save()`.
 *
 * Concurrency capped at 3 by default — AS Wicket bookkeeping doesn't love
 * a flood of concurrent fetches against the same session. The cap is also
 * the right place to back off if AS starts returning login forms.
 *
 * Mirrors the proxy-page-fetcher's GET shape (credentials:include, login
 * form detection) but parses the *visualFlightPlan* panel instead of the
 * New Flight Number form. Both are present on the same page.
 *
 * Reports progress via `opts.onProgress({phase, completed, total, current,
 * lastResult})` so the panel can paint a live progress strip without
 * polling. Phases: "scanning" (per aircraft, before fetch), "fetching",
 * "parsed", "saved", "skipped-fresh", "failed", "done".
 */
class FleetScheduleGridScraper {
    static DEFAULT_CONCURRENCY = 3
    static DEFAULT_MAX_AGE_MS  = 10 * 60 * 1000   // 10 minutes
    static FETCH_TIMEOUT_MS    = 15000             // hard ceiling per page

    constructor(server, opts) {
        if (!server) throw new Error("FleetScheduleGridScraper: server required")
        const o = opts || {}
        this.server = server
        this.maxConcurrency = Math.max(1, Math.min(6, +o.maxConcurrency || FleetScheduleGridScraper.DEFAULT_CONCURRENCY))
        this._aborted = false
    }

    abort() { this._aborted = true }

    static aircraftPageUrl(server, aircraftId) {
        return "https://" + server + ".airlinesim.aero/app/fleets/aircraft/" + aircraftId + "/0"
    }

    /**
     * @param {Array} fleet  - aircraft objects with `aircraftId` and optionally `registration`
     * @param {object} opts  - {forceRefetch, maxAgeMs, onProgress}
     * @returns Promise<{schedules: Map<aircraftId, Schedule>, results: Array<{aircraftId, ok, source, error?}>}>
     */
    async scrapeAll(fleet, opts) {
        opts = opts || {}
        const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : (() => {})
        const force = !!opts.forceRefetch
        const maxAge = (typeof opts.maxAgeMs === "number" && opts.maxAgeMs >= 0)
            ? opts.maxAgeMs
            : FleetScheduleGridScraper.DEFAULT_MAX_AGE_MS

        const ids = (fleet || []).map(a => String(a.aircraftId)).filter(Boolean)
        const total = ids.length
        const schedules = new Map()
        const results = []
        let completed = 0

        const next = (() => {
            let i = 0
            return () => (i < ids.length ? ids[i++] : null)
        })()

        const worker = async () => {
            while (true) {
                if (this._aborted) return
                const aircraftId = next()
                if (!aircraftId) return
                onProgress({phase: "scanning", completed, total, current: aircraftId})
                let res
                try {
                    res = await this._processOne(aircraftId, {force, maxAge, onProgress, completed, total})
                } catch (e) {
                    res = {aircraftId, ok: false, error: {code: "threw", message: (e && e.message) || String(e)}}
                }
                completed++
                if (res.ok && res.schedule) schedules.set(aircraftId, res.schedule)
                results.push(res)
                onProgress({
                    phase: res.ok ? (res.source === "store-fresh" ? "skipped-fresh" : "saved") : "failed",
                    completed,
                    total,
                    current: aircraftId,
                    lastResult: res
                })
            }
        }

        const workers = []
        for (let n = 0; n < Math.min(this.maxConcurrency, total); n++) {
            workers.push(worker())
        }
        await Promise.all(workers)
        onProgress({phase: "done", completed, total})
        return {schedules, results, aborted: this._aborted}
    }

    /**
     * Re-scrape a single aircraft, bypassing concurrency orchestration.
     * Used after a successful Apply so the grid repaints just that aircraft
     * without re-fetching the whole fleet (which is a 2-3 minute hit).
     *
     * @param {string|number} aircraftId
     * @param {object} [opts]  - {force=true, maxAgeMs}
     * @returns Promise<{aircraftId, ok, source, schedule?, error?, url?}>
     */
    async scrapeOne(aircraftId, opts) {
        const o = opts || {}
        const force = o.force !== false
        const maxAge = (typeof o.maxAgeMs === "number" && o.maxAgeMs >= 0)
            ? o.maxAgeMs
            : FleetScheduleGridScraper.DEFAULT_MAX_AGE_MS
        return await this._processOne(String(aircraftId), {
            force,
            maxAge,
            onProgress: () => {},
            completed: 0,
            total: 1
        })
    }

    async _processOne(aircraftId, ctx) {
        if (typeof AesAfpScheduleStore === "undefined") {
            return {aircraftId, ok: false, error: {code: "storeMissing", message: "AesAfpScheduleStore not loaded"}}
        }
        if (!ctx.force) {
            const stored = await AesAfpScheduleStore.load(this.server, aircraftId).catch(() => null)
            if (stored && AesAfpScheduleStore.isFresh(stored, ctx.maxAge)) {
                return {aircraftId, ok: true, source: "store-fresh", schedule: stored}
            }
        }
        ctx.onProgress({phase: "fetching", completed: ctx.completed, total: ctx.total, current: aircraftId})

        const url = FleetScheduleGridScraper.aircraftPageUrl(this.server, aircraftId)
        let html = null
        try {
            const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null
            const tid = ctrl ? setTimeout(() => ctrl.abort(), FleetScheduleGridScraper.FETCH_TIMEOUT_MS) : null
            const resp = await fetch(url, {credentials: "include", signal: ctrl ? ctrl.signal : undefined})
            if (tid) clearTimeout(tid)
            if (!resp.ok) {
                return {aircraftId, ok: false, error: {code: "fetchFailed", httpStatus: resp.status}, url}
            }
            html = await resp.text()
        } catch (e) {
            return {aircraftId, ok: false, error: {code: "fetchThrew", message: (e && e.message) || String(e)}, url}
        }

        if (/<form[^>]+action=["'][^"']*\/login/i.test(html)) {
            return {aircraftId, ok: false, error: {code: "notLoggedIn", message: "Sign into AS in this tab and retry."}, url}
        }

        if (typeof AesAfpVfpReader === "undefined" || typeof AesAfpVfpReader.readFromRoot !== "function") {
            return {aircraftId, ok: false, error: {code: "readerMissing", message: "AesAfpVfpReader.readFromRoot not loaded"}, url}
        }

        let doc = null
        try { doc = new DOMParser().parseFromString(html, "text/html") }
        catch (e) {
            return {aircraftId, ok: false, error: {code: "parseFailed", message: (e && e.message) || String(e)}, url}
        }

        const schedule = AesAfpVfpReader.readFromRoot(doc, {
            server:     this.server,
            aircraftId,
            hubIata:    null
        })

        // Parsed but truly empty (no VFP panel on the page) — don't clobber
        // a previously-stored Schedule, but DO record an "empty" result so
        // the grid can show a "no flights" badge for this aircraft.
        const isEmpty = (!schedule.legs || schedule.legs.length === 0)
            && !(schedule.planningMatrix && schedule.planningMatrix.isPresent)
        if (isEmpty) {
            return {aircraftId, ok: true, source: "fetch-empty", schedule, empty: true, url}
        }

        try { await AesAfpScheduleStore.save(this.server, aircraftId, schedule) }
        catch (e) { /* persist failure is non-fatal — caller still gets schedule in-memory */ }

        return {aircraftId, ok: true, source: "fetch", schedule, url}
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridScraper = FleetScheduleGridScraper
}
