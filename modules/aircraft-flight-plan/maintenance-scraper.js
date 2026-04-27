"use strict"

/**
 * Sidebar maintenance scraper (Track 2 slice 2a).
 *
 * Reads the per-aircraft sidebar table on `/app/fleets/aircraft/<id>/0` AND
 * `/app/fleets/aircraft/<id>/1` (the table is identical on both tabs) and
 * extracts:
 *   - Maintenance ratio (e.g. 124.8%)
 *   - Condition        (e.g. 100%)
 *
 * Exact DOM shape (confirmed in two captures, aircraft 6968 + 13536):
 *   <tr><th>Maintenance ratio</th>
 *       <td class="number"><span class="good">124.8%</span></td></tr>
 *   <tr><th>Condition</th>
 *       <td class="number"><span class="good">100%</span></td></tr>
 *
 * The wrapping span carries a status class (`good` / `warn` / `bad`) that
 * mirrors AS's traffic-light colouring. We capture it so the widget can
 * honour the in-game cue without re-deriving thresholds.
 *
 * Persists to AesAfpMaintenanceStore. Emits `maintenance:scraped` on the
 * AesAfp bus when the bus is available (`/0` tab); on `/1` the bus isn't
 * loaded, so only the storage write happens — that's enough for cross-tab
 * consumers via storage.onChanged.
 *
 * Public API:
 *   AesAfpMaintenanceScraper.scrapeNow() -> Promise<record | null>
 *   AesAfpMaintenanceScraper.last        -> record | null
 *
 * Bootstrapping:
 *   - On `/0` (AesAfp host present) — subscribes to `ctx:ready` so the
 *     scrape runs after host.js has fully populated AesAfp.ctx, and re-runs
 *     after every Wicket re-mount.
 *   - On `/1` (no AesAfp) — kicks off on `window.load`, then re-runs on
 *     a small MutationObserver attached to the sidebar column.
 */
;(function () {
    if (window.AesAfpMaintenanceScraper) return

    const STATUS_CLASSES = ["good", "warn", "bad"]
    const SIDEBAR_TABLE_SEL = ".as-page-aircraft .col-md-2 .as-table-well table"
    const AIRCRAFT_PATH_RE  = /\/aircraft\/(\d+)/

    /** Pull a status token from a span's class list, or null. */
    function _statusFromSpan(span) {
        if (!span) return null
        for (const c of STATUS_CLASSES) {
            if (span.classList && span.classList.contains(c)) return c
        }
        return null
    }

    /**
     * Walk the sidebar table looking for the Maintenance ratio + Condition
     * rows. Return {ratio, condition, ratioStatus, conditionStatus} or null
     * when the table can't be found / neither row is present.
     */
    function _readSidebar() {
        const table = document.querySelector(SIDEBAR_TABLE_SEL)
        if (!table) return null

        let ratio = null, condition = null
        let ratioStatus = null, conditionStatus = null
        let any = false

        for (const tr of table.querySelectorAll("tr")) {
            const th = tr.querySelector("th")
            if (!th) continue
            const label = (th.textContent || "").trim().toLowerCase()
            if (label.startsWith("maintenance ratio")) {
                const span = tr.querySelector("td span")
                const text = (tr.querySelector("td")?.textContent || "").trim()
                const num  = parseFloat(text)
                if (isFinite(num)) { ratio = num; any = true }
                ratioStatus = _statusFromSpan(span)
            } else if (label.startsWith("condition")) {
                const span = tr.querySelector("td span")
                const text = (tr.querySelector("td")?.textContent || "").trim()
                const num  = parseFloat(text)
                if (isFinite(num)) { condition = num; any = true }
                conditionStatus = _statusFromSpan(span)
            }
        }
        if (!any) return null
        return {ratio, condition, ratioStatus, conditionStatus}
    }

    /**
     * Resolve {server, aircraftId} for the page. Prefers AesAfp.ctx when
     * present (most accurate), falls back to URL pathname + AES.getServerName
     * so the scraper works on `/1` where AesAfp isn't loaded.
     */
    function _resolveCtx() {
        if (window.AesAfp && AesAfp.ctx && AesAfp.ctx.server && AesAfp.ctx.aircraftId) {
            return {server: AesAfp.ctx.server, aircraftId: String(AesAfp.ctx.aircraftId)}
        }
        const m = window.location.pathname.match(AIRCRAFT_PATH_RE)
        const aircraftId = m ? m[1] : null
        let server = ""
        try { server = (typeof AES !== "undefined" && AES.getServerName) ? AES.getServerName() : "" }
        catch (_) { server = "" }
        if (!aircraftId || !server) return null
        return {server, aircraftId}
    }

    let _inFlight = null

    async function scrapeNow() {
        if (_inFlight) return _inFlight
        _inFlight = (async () => {
            try {
                const ctx = _resolveCtx()
                if (!ctx) return null
                const reading = _readSidebar()
                if (!reading) return null
                if (typeof AesAfpMaintenanceStore === "undefined") {
                    console.warn("[AES AFP maintenance-scraper] store not loaded; check manifest order")
                    return null
                }
                const saved = await AesAfpMaintenanceStore.save(ctx.server, ctx.aircraftId, {
                    ratio:           reading.ratio,
                    condition:       reading.condition,
                    ratioStatus:     reading.ratioStatus,
                    conditionStatus: reading.conditionStatus,
                    scrapedAt:       Date.now()
                })
                AesAfpMaintenanceScraper.last = saved
                if (window.AesAfp && AesAfp.bus) {
                    try {
                        AesAfp.bus.emit("maintenance:scraped", {
                            ratio:           reading.ratio,
                            condition:       reading.condition,
                            ratioStatus:     reading.ratioStatus,
                            conditionStatus: reading.conditionStatus,
                            scrapedAt:       saved && saved.scrapedAt
                        })
                    } catch (e) { console.warn("[AES AFP maintenance-scraper] bus emit failed", e) }
                }
                return saved
            } catch (e) {
                console.warn("[AES AFP maintenance-scraper] scrape threw", e)
                return null
            } finally {
                _inFlight = null
            }
        })()
        return _inFlight
    }

    /**
     * Standalone bootstrap for the `/1` (Flights) tab where AesAfp isn't
     * loaded. Run once on window.load, then watch the sidebar column for
     * Wicket re-renders so a sidebar Settings submission still triggers a
     * fresh scrape.
     */
    function _bootstrapStandalone() {
        const kick = () => { scrapeNow() }
        if (document.readyState === "complete") kick()
        else window.addEventListener("load", kick)

        const col = document.querySelector(".as-page-aircraft .col-md-2") || document.body
        if (!col) return
        let timer = null
        const obs = new MutationObserver(() => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => { timer = null; scrapeNow() }, 250)
        })
        obs.observe(col, {childList: true, subtree: true})
    }

    const AesAfpMaintenanceScraper = {scrapeNow, last: null}
    window.AesAfpMaintenanceScraper = AesAfpMaintenanceScraper

    // Wire to the AesAfp bus when present (`/0` tab); otherwise bootstrap
    // standalone (`/1` tab).
    if (window.AesAfp && window.AesAfp.bus) {
        window.AesAfp.bus.on("ctx:ready", () => { scrapeNow() })
    } else {
        _bootstrapStandalone()
    }
})()
