"use strict"

/**
 * Track 7 slice 7f — decorate the historical-flights table on
 * `/app/fleets/aircraft/<id>/1*` with a "scheduled" pill on every row
 * whose flight-number id matches a leg in the persisted Schedule.
 *
 * The AFP page's `.block.flight` overlay link carries the Flight Number
 * id (`/app/com/numbers/<id>`); `vfp-reader.js` stores it on
 * `Schedule.legs[].flightId` (and the legacy adapter aliases it as
 * `flightNumberId`). The aircraft-flights table on the /1 page exposes
 * the same id via the FN link in column 2 — `content_aircraftFlights.js`
 * already pulls it as `flight.flightNumberId`. Joining on that id gives
 * us a per-row "this row is one of the scheduled legs" decoration.
 *
 * Read-only: never writes to the store, never mutates the AS table
 * structure. Only inserts a small pill span at the start of the FN cell.
 *
 * Refresh path: chrome.storage.onChanged on the schedule key (debounced
 * 500ms — paired with the 500ms cap so AFP-page Wicket-storm writes
 * don't trigger a re-decorate per fragment). The decorator is idempotent
 * — running it twice on the same table replaces existing pills rather
 * than stacking them.
 */
;(function () {
    if (window.AesAircraftFlightsScheduledDecorator) return

    const PILL_ATTR  = "data-aes-scheduled-pill"
    const TABLE_SEL  = "#aircraft-flight-instances-table"
    const FN_LINK_SEL = "td:nth-child(2) a[href*='/com/numbers/']"
    const REPAINT_DEBOUNCE_MS = 500
    const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    let _server     = ""
    let _aircraftId = ""
    let _legByFnId  = null
    let _repaintTimer = null
    let _listenerFn   = null

    function _extractAircraftIdFromUrl() {
        const m = (window.location.pathname || "").match(/\/aircraft\/(\d+)\//)
        return m ? m[1] : ""
    }

    function _resolveServer() {
        try {
            if (typeof AES !== "undefined" && typeof AES.getServerName === "function") {
                return AES.getServerName() || ""
            }
        } catch (_) { /* fall through */ }
        const host = window.location && window.location.hostname || ""
        const dot  = host.indexOf(".")
        return dot > 0 ? host.slice(0, dot) : ""
    }

    /** Build a Map<flightId, scheduleLeg> from the stored Schedule. */
    function _indexLegs(schedule) {
        const map = new Map()
        if (!schedule || !Array.isArray(schedule.legs)) return map
        for (const leg of schedule.legs) {
            if (!leg) continue
            const fid = leg.flightId
            if (fid == null) continue
            map.set(String(fid), leg)
        }
        return map
    }

    function _formatPillLabel(leg) {
        const day = (Number.isInteger(leg.dayIdx) && leg.dayIdx >= 0 && leg.dayIdx <= 6)
            ? DAY_NAMES[leg.dayIdx] : (leg.dayName || "")
        const time = leg.depTimeLocal || ""
        const parts = []
        if (day)  parts.push(day)
        if (time) parts.push(time)
        return (parts.join(" ") || "scheduled") + " · scheduled"
    }

    function _pillFor(leg) {
        const span = document.createElement("span")
        span.setAttribute(PILL_ATTR, "1")
        span.style.cssText = "display:inline-block;margin-right:6px;padding:1px 6px;"
            + "border-radius:8px;background:#1d4ed8;color:#f8fafc;font-size:10px;"
            + "font-weight:600;vertical-align:middle;"
        span.title = "This flight number appears in the persisted AFP schedule"
            + (leg.origin && leg.destination
                ? " (" + leg.origin + " → " + leg.destination + ")"
                : "")
        span.textContent = _formatPillLabel(leg)
        return span
    }

    function _stripExistingPills(table) {
        const olds = table.querySelectorAll("[" + PILL_ATTR + "]")
        for (const el of olds) el.remove()
    }

    function _decorate() {
        const table = document.querySelector(TABLE_SEL)
        if (!table) return
        _stripExistingPills(table)
        if (!_legByFnId || !_legByFnId.size) return
        const rows = table.querySelectorAll("tbody tr")
        for (const row of rows) {
            const link = row.querySelector(FN_LINK_SEL)
            if (!link) continue
            const m = (link.getAttribute("href") || "").match(/\/numbers\/(\d+)/)
            if (!m) continue
            const leg = _legByFnId.get(m[1])
            if (!leg) continue
            const fnCell = row.querySelector("td:nth-child(2)")
            if (!fnCell) continue
            fnCell.insertBefore(_pillFor(leg), fnCell.firstChild)
        }
    }

    async function _loadAndDecorate() {
        if (typeof AesAfpScheduleStore === "undefined") return
        // Re-resolve from the URL so SPA navigation to a different
        // aircraft picks up the right schedule on the next repaint.
        const aircraftId = _extractAircraftIdFromUrl() || _aircraftId
        if (!_server || !aircraftId) return
        _aircraftId = aircraftId
        let schedule = null
        try { schedule = await AesAfpScheduleStore.load(_server, aircraftId) }
        catch (e) { console.warn("[AES /1 scheduled-decorator] load failed", e); return }
        _legByFnId = _indexLegs(schedule)
        _decorate()
    }

    function _scheduleRepaint() {
        if (_repaintTimer) clearTimeout(_repaintTimer)
        _repaintTimer = setTimeout(() => {
            _repaintTimer = null
            _loadAndDecorate()
        }, REPAINT_DEBOUNCE_MS)
    }

    function _attachStorageListener() {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        if (typeof AesAfpScheduleStore === "undefined") return
        // Detach any previous handle so a fresh content-script injection
        // doesn't stack listeners.
        if (_listenerFn) {
            try { chrome.storage.onChanged.removeListener(_listenerFn) }
            catch (_) { /* listener was never registered */ }
            _listenerFn = null
        }
        _listenerFn = (changes, area) => {
            if (area !== "local") return
            // Re-key dynamically so post-navigation writes for the current
            // aircraft fire the repaint (the previous aircraft's key would
            // be stale after SPA nav).
            const aircraftId = _extractAircraftIdFromUrl()
            if (!aircraftId || !_server) return
            const myKey = AesAfpScheduleStore._key(_server, aircraftId)
            if (!Object.prototype.hasOwnProperty.call(changes, myKey)) return
            _scheduleRepaint()
        }
        chrome.storage.onChanged.addListener(_listenerFn)
    }

    /**
     * Wait for the AS table to land in the DOM. The AFP-family content
     * scripts run at document_idle but Wicket sometimes streams the
     * flights table asynchronously. Mirror the polling pattern from
     * `flight-log-scraper.js`: try every 100ms for ~5s, then give up.
     */
    function _waitForTable() {
        let tries = 0
        const id = setInterval(() => {
            tries++
            if (document.querySelector(TABLE_SEL)) {
                clearInterval(id)
                _loadAndDecorate()
            } else if (tries > 50) {
                clearInterval(id)
            }
        }, 100)
    }

    function _init() {
        _aircraftId = _extractAircraftIdFromUrl()
        _server     = _resolveServer()
        if (!_aircraftId || !_server) return
        _waitForTable()
        _attachStorageListener()
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _init, {once: true})
    } else {
        _init()
    }

    window.AesAircraftFlightsScheduledDecorator = {
        // Exposed for diagnostics + manual repaints (e.g. from console).
        repaint: () => { _loadAndDecorate() }
    }
})()
