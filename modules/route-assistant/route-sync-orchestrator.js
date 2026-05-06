"use strict"

/**
 * Route-sync orchestrator. One entry point that runs:
 *
 *   schedule scrape (live route data + flight numbers + freq)
 *   → harvest fresh flight numbers
 *   → ORS scrape (with the harvested fnSet unioned into "ours" detection)
 *
 * for one route or many. Replaces the old "click Sync route data, wait,
 * click Sync ORS rank, wait" two-button dance with a single coherent
 * pipeline whose phases see each other.
 *
 * Why this matters:
 *
 *   - Without this, ORS reads `getOurFlightNumbers` from the legacy
 *     `<server><airline>schedule` cache (written by content_fligthSchedule.js
 *     on the enterprise schedule tab). On a freshly-scraped route whose
 *     flights aren't in that cache yet, every leg tags as "not ours" and
 *     all rank flavors come back null — silent corruption that looks like
 *     "we don't fly this route" rather than "the cache was stale".
 *
 *   - The orchestrator captures the flight-number list straight from the
 *     scheduling page that JUST ran and threads it through the ORS scrape
 *     via `params.ourFlightNumbersOverride` (ors-scraper.js:570). Stale
 *     legacy cache no longer matters for the freshly-scraped route.
 *
 *   - Model recompute is intentionally OUT of scope here. The model needs
 *     fleet specs, distance, demand pool, etc. that live on the panel, not
 *     in this orchestrator. The panel calls its own `_applyCachedPrices`
 *     + `_applyCachedOrs` (+ optional `_recomputeOrsSandbox`) once the
 *     orchestrator finishes — same pattern as today's per-scraper buttons.
 *
 * Progress events:
 *
 *   onProgress({
 *     phase:  "stage" | "route-done" | "halted",
 *     route:  {hub, dest},
 *     stage:  "schedule" | "ors",            // only when phase === "stage"
 *     done:   <int>, total: <int>,
 *     halted: <bool>, reason: <string?>
 *   })
 *
 *   Stage events fire BEFORE each scraper runs so the panel can show
 *   "Scheduling JFK→MCO" before the long ORS phase. `done` counts COMPLETED
 *   routes (both phases finished); `total` is the route count.
 *
 * Circuit breaker:
 *
 *   The orchestrator owns its own consecutive-rate-limit counter. Three
 *   consecutive ORS rate-limit errors trip a halt — same threshold the ORS
 *   scraper's own bulkScrape uses (ors-scraper.js:920). When tripped, the
 *   bulk run drains in-flight work, emits `phase:"halted"`, and resolves.
 *   Schedule scraper failures do NOT count toward the breaker.
 *
 * Load-order: wrapped in idempotent IIFE guard. Same shape as
 * silent-auto-proposers.js / parallel-scanner.js so future double-listing
 * or SPA re-injection no-ops cleanly instead of throwing
 * `SyntaxError: Identifier 'RouteAssistantRouteSync' has already been declared`.
 */
;(function () {
    const root = (typeof window !== "undefined")
        ? window
        : ((typeof globalThis !== "undefined") ? globalThis : null)
    if (root && root.RouteAssistantRouteSync) return

class RouteAssistantRouteSync {

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantRouteSync: server required")
        opts = opts || {}
        this.server = server
        const ScheduleScraper = typeof RouteAssistantSchedulePageScraper !== "undefined"
            ? RouteAssistantSchedulePageScraper
            : (typeof window !== "undefined" ? window.RouteAssistantSchedulePageScraper : null)
        const OrsScraper = typeof RouteAssistantOrsScraper !== "undefined"
            ? RouteAssistantOrsScraper
            : (typeof window !== "undefined" ? window.RouteAssistantOrsScraper : null)
        if (!opts.priceScraper && !ScheduleScraper) {
            throw new Error("RouteAssistantRouteSync: schedule scraper missing")
        }
        if (!opts.orsScraper && !OrsScraper) {
            throw new Error("RouteAssistantRouteSync: ORS scraper missing")
        }
        this.priceScraper = opts.priceScraper || new ScheduleScraper(server, {
            maxAgeDays: opts.scheduleMaxAgeDays
        })
        this.orsScraper = opts.orsScraper || new OrsScraper(server, {
            maxAgeDays:                opts.orsMaxAgeDays,
            circuitBreakerCooldownMs:  opts.orsCircuitBreakerCooldownMs
        })
        this._consecutiveRateLimitErrors = 0
    }

    /**
     * Sync one route: schedule → ORS. Returns
     *   {schedule: <rec|null>, ors: <rec|null>, halted: <bool>, reason: <string?>}
     *
     * Throws RouteAssistantOrsScraper._RateLimitError so the bulk caller
     * can count it toward the circuit breaker. All other errors are
     * caught and surfaced via the result's null fields + console.warn.
     *
     * @param {string} hub
     * @param {string} dest
     * @param {object} [opts]
     * @param {object} [opts.orsParams] - {classesToScrape, departureH, arrivalH, useGround, carrierOverride}
     * @param {function} [opts.onStage] - ({stage:"schedule"|"ors", route}) before each phase
     * @param {function} [opts.contextBuilder] - async ({hub, dest, scheduleRec})
     *   → context object. Called after the schedule scrape; the return
     *   value threads into ORS scrape via `params.context` and lands in
     *   the saved record under `record.context`. The orchestrator stays
     *   ignorant of context shape — the panel-side helper that wires this
     *   is the single source of truth for "what describes this route".
     */
    async syncRoute(hub, dest, opts) {
        opts = opts || {}
        const onStage   = typeof opts.onStage        === "function" ? opts.onStage        : null
        const ctxBuild  = typeof opts.contextBuilder === "function" ? opts.contextBuilder : null
        const orsParams = opts.orsParams || {}
        const out = {schedule: null, ors: null, halted: false, reason: null}

        // ---- Phase 1: schedule scrape -----------------------------------
        if (onStage) try { onStage({stage: "schedule", route: {hub, dest}}) } catch (e) { /* noop */ }
        try {
            out.schedule = await this.priceScraper.scrape(hub, dest)
        } catch (e) {
            // priceScraper.scrape() catches its own errors and returns null,
            // so this branch is defensive.
            console.warn("[AES routeSync] schedule scrape threw for " + hub + "-" + dest, e)
            out.schedule = null
        }

        // ---- Build fnSet from the freshly-scraped schedule --------------
        // Each row in `flights` carries the AS-rendered flight number
        // (e.g. "FGM 12") via schedule-page-scraper.js:206. Trim defensively
        // — AS occasionally pads cells with non-breaking spaces.
        const fnSet = new Set()
        if (out.schedule && Array.isArray(out.schedule.flights)) {
            for (const f of out.schedule.flights) {
                if (f && f.flightNumber) fnSet.add(String(f.flightNumber).trim())
            }
        }

        // ---- Optional context build (calibration set / snapshot) --------
        // Builder failures are swallowed — context is best-effort metadata
        // and an outage shouldn't sink the actual scrape.
        let context = null
        if (ctxBuild) {
            try {
                context = await ctxBuild({hub, dest, scheduleRec: out.schedule})
            } catch (e) {
                console.warn("[AES routeSync] contextBuilder threw for " + hub + "-" + dest, e)
                context = null
            }
        }

        // ---- Phase 2: ORS scrape ----------------------------------------
        if (onStage) try { onStage({stage: "ors", route: {hub, dest}}) } catch (e) { /* noop */ }
        const orsCallParams = Object.assign({}, orsParams)
        if (fnSet.size) orsCallParams.ourFlightNumbersOverride = fnSet
        if (context)    orsCallParams.context                  = context
        try {
            out.ors = await this.orsScraper.scrape(hub, dest, orsCallParams)
        } catch (e) {
            if (e && e._isRateLimit) throw e
            console.warn("[AES routeSync] ORS scrape threw for " + hub + "-" + dest, e)
            out.ors = null
        }

        return out
    }

    /**
     * Sync many routes with route-level concurrency + stagger. Mirrors
     * the dispatch loop in RouteAssistantOrsScraper.bulkScrape but operates
     * one level up — each "unit" is a syncRoute (schedule + ORS), not a
     * single fetch.
     *
     * Defaults to concurrency=2 / staggerMs=1500 — same as ORS bulkScrape
     * because each route does up to 1 schedule fetch + N class-cabin ORS
     * fetches and we cannot go faster than the ORS fetch budget allows.
     *
     * @param {Array<{hub, dest}>} pairs
     * @param {object} [opts]
     * @param {number} [opts.concurrency=2]
     * @param {number} [opts.staggerMs=1500]
     * @param {object} [opts.orsParams]    - forwarded to syncRoute
     * @param {function} [opts.onProgress] - see class doc for shape
     * @returns {Promise<{results, halted, reason}>}
     */
    async bulkSync(pairs, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(10, opts.concurrency || 4))
        const staggerMs   = Math.max(0, opts.staggerMs != null ? opts.staggerMs : 1500)
        const orsParams   = opts.orsParams || {}
        const onProgress  = typeof opts.onProgress     === "function" ? opts.onProgress     : null
        const ctxBuild    = typeof opts.contextBuilder === "function" ? opts.contextBuilder : null
        const errorThreshold = 3   // matches ors-scraper bulkScrape

        const total = pairs.length
        const results = new Array(total)
        if (!total) return {results, halted: false, reason: null}

        let cursor = 0
        let inflight = 0
        let done = 0
        let lastDispatchAt = 0
        let halted = false
        let haltReason = null

        const emit = (patch) => {
            if (!onProgress) return
            try {
                onProgress(Object.assign({
                    done, total, halted, reason: haltReason
                }, patch))
            } catch (e) { /* swallow — listener bug shouldn't break sync */ }
        }

        return new Promise(resolve => {
            const finish = () => {
                if (halted) emit({phase: "halted"})
                resolve({results, halted, reason: haltReason})
            }

            const tryDispatch = () => {
                if (halted && inflight === 0) return finish()
                while (!halted && inflight < concurrency && cursor < total) {
                    const sinceLast = Date.now() - lastDispatchAt
                    if (sinceLast < staggerMs) {
                        setTimeout(tryDispatch, staggerMs - sinceLast)
                        return
                    }
                    const idx = cursor++
                    const pair = pairs[idx]
                    inflight++
                    lastDispatchAt = Date.now()
                    this.syncRoute(pair.hub, pair.dest, {
                        orsParams:      orsParams,
                        contextBuilder: ctxBuild,
                        onStage: ({stage, route}) => emit({phase: "stage", stage, route})
                    }).then(rec => {
                        results[idx] = rec
                        // Reset rate-limit counter on a successful ORS scrape
                        // — matches ors-scraper.js:618 where its own counter
                        // resets on success.
                        if (rec && rec.ors) this._consecutiveRateLimitErrors = 0
                    }).catch(e => {
                        results[idx] = {schedule: null, ors: null, halted: false, reason: null}
                        if (e && e._isRateLimit) {
                            this._consecutiveRateLimitErrors++
                            if (this._consecutiveRateLimitErrors >= errorThreshold && !halted) {
                                halted = true
                                haltReason = "Rate-limited (HTTP " + e.status + ") "
                                    + this._consecutiveRateLimitErrors
                                    + "× in a row — circuit breaker tripped."
                            }
                        } else {
                            console.warn("[AES routeSync] unexpected error", e)
                        }
                    }).finally(() => {
                        inflight--
                        done++
                        emit({phase: "route-done", route: {hub: pair.hub, dest: pair.dest}})
                        if (done >= total || (halted && inflight === 0)) finish()
                        else tryDispatch()
                    })
                }
                if (halted && inflight === 0) finish()
            }
            tryDispatch()
        })
    }
}

    if (root) {
        root.RouteAssistantRouteSync = RouteAssistantRouteSync
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = RouteAssistantRouteSync
    }
})()
