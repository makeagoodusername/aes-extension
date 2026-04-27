"use strict"

/**
 * Flight log scraper (Track 2 slice 2b.0).
 *
 * Reads `table#aircraft-flight-instances-table` on the per-aircraft
 * `/app/fleets/aircraft/<id>/1` page and extracts {flightNumber, depUtc,
 * arrUtc, blockMinutes, status, originIata, destinationIata} for every
 * row. Persists via AesAfpFlightLogStore.appendNew (de-duped on
 * flightNumber + depUtc).
 *
 * The existing `content_aircraftFlights.js` already pulls flightNumber +
 * depUtc + originIata + destinationIata + status from the same table. We
 * could read its `<server>aircraftFlights<aircraftId>` storage instead of
 * re-walking the DOM, but that record doesn't carry the arrival timestamp
 * or block-minute calc — both of which the wear-model needs. Re-walking is
 * cheap (one querySelectorAll over ~13 rows) and keeps this slice's data
 * shape independent of the older module's storage contract.
 *
 * Per-row time parsing pattern follows AircraftFlightsTab.getFlights at
 * `content_aircraftFlights.js:388-393`:
 *
 *   td:nth-child(4) span[title="DD.MM. HH:MM UTC / DD.MM. HH:MM HT / ..."]
 *
 * The UTC fragment is the only timezone-stable field; HT/LT are anchored to
 * the airline's home timezone, which we can't trust to remain constant.
 *
 * Status filter: only `finished` and `inflight` flights count toward
 * historical block hours. `booked` flights are forward-scheduled and skip
 * the wear contribution; `cancelled` / `diverted` are similarly excluded.
 */
;(function () {
    if (window.AesAfpFlightLogScraper) return

    const TABLE_SEL  = "#aircraft-flight-instances-table"
    const TIME_RE    = /(\d{2}\.\d{2}\.\s*\d{2}:\d{2})\s*UTC/
    const IATA_RE    = /^[A-Z]{3}$/
    const PATH_RE    = /\/aircraft\/(\d+)/
    const AIRCRAFT_PAGE_TAB1_RE = /\/fleets\/aircraft\/\d+\/1\b/
    const MINUTES_PER_DAY = 24 * 60

    /**
     * Pull the UTC fragment out of a "DD.MM. HH:MM UTC / ..." span title.
     * Returns the fragment as a normalised "DD.MM. HH:MM" (no timezone
     * suffix, single space after the second period) suitable for
     * AesAfpFlightLogStore.parseDepUtcToMs.
     */
    function _utcFromTitle(titleAttr) {
        if (!titleAttr) return null
        const m = String(titleAttr).match(TIME_RE)
        if (!m) return null
        return m[1].replace(/\s+/g, " ").trim()
    }

    function _resolveCtx() {
        const m = window.location.pathname.match(PATH_RE)
        const aircraftId = m ? m[1] : null
        let server = ""
        try { server = (typeof AES !== "undefined" && AES.getServerName) ? AES.getServerName() : "" }
        catch (_) { server = "" }
        if (!server || !aircraftId) return null
        return {server, aircraftId}
    }

    /**
     * Parse one row of the flights table into our flight log shape, or null
     * when the row is malformed (e.g. transfer flight, missing flight #,
     * unparseable departure time).
     */
    function _parseRow(row) {
        const flightNumberCell = row.querySelector("td:nth-child(2)")
        const flightNumber = (flightNumberCell?.innerText || "").trim()
        if (!flightNumber || flightNumber === "XFER") return null

        const orig = row.querySelector("td:nth-child(3) span")?.innerText.trim() || ""
        const dest = row.querySelector("td:nth-child(5) span")?.innerText.trim() || ""
        const depTitle = row.querySelector("td:nth-child(4) span")?.title || ""
        const arrTitle = row.querySelector("td:nth-child(6) span")?.title || ""
        const status   = row.querySelector(".flightStatusPanel")?.innerText.trim() || null

        const depUtc = _utcFromTitle(depTitle)
        const arrUtc = _utcFromTitle(arrTitle)
        if (!depUtc) return null

        let blockMinutes = null
        if (depUtc && arrUtc) {
            const now = Date.now()
            const depMs = AesAfpFlightLogStore.parseDepUtcToMs(depUtc, now)
            // Arrival uses the depMs as its temporal anchor — this nails
            // the year for an arrival within a few hours of departure even
            // when departure happened just before a year rollover.
            const arrMs = AesAfpFlightLogStore.parseDepUtcToMs(arrUtc, depMs || now)
            if (depMs != null && arrMs != null) {
                let diff = (arrMs - depMs) / 60000
                // Year-inference may put arrival before departure by exactly
                // a day on red-eye flights that cross midnight UTC. Bump by
                // a day so the block-time stays positive.
                if (diff < 0 && diff > -MINUTES_PER_DAY) diff += MINUTES_PER_DAY
                if (diff > 0 && diff < MINUTES_PER_DAY) blockMinutes = diff
            }
        }

        return {
            flightNumber,
            depUtc,
            arrUtc:          arrUtc || null,
            blockMinutes,
            status,
            originIata:      IATA_RE.test(orig) ? orig : null,
            destinationIata: IATA_RE.test(dest) ? dest : null
        }
    }

    let _inFlight = null

    async function scrapeNow() {
        if (_inFlight) return _inFlight
        _inFlight = (async () => {
            try {
                if (!AIRCRAFT_PAGE_TAB1_RE.test(window.location.pathname)) return null
                const ctx = _resolveCtx()
                if (!ctx) return null
                if (typeof AesAfpFlightLogStore === "undefined") {
                    console.warn("[AES AFP flight-log-scraper] store not loaded; check manifest order")
                    return null
                }
                const table = document.querySelector(TABLE_SEL)
                if (!table) return null

                const flights = []
                const rows = table.querySelectorAll("tbody tr")
                for (const row of rows) {
                    const parsed = _parseRow(row)
                    if (parsed) flights.push(parsed)
                }
                if (!flights.length) return null

                const saved = await AesAfpFlightLogStore.appendNew(ctx.server, ctx.aircraftId, flights)
                AesAfpFlightLogScraper.last = saved
                return saved
            } catch (e) {
                console.warn("[AES AFP flight-log-scraper] scrape threw", e)
                return null
            } finally {
                _inFlight = null
            }
        })()
        return _inFlight
    }

    function _bootstrap() {
        const kick = () => { scrapeNow() }
        if (document.readyState === "complete") kick()
        else window.addEventListener("load", kick)

        // The flights table can be Wicket-replaced when the user paginates
        // or re-sorts — re-scrape after a short debounce so newly-visible
        // rows make it into the store.
        const target = document.querySelector(".as-page-aircraft .col-md-10") || document.body
        if (!target) return
        let timer = null
        const obs = new MutationObserver(() => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => { timer = null; scrapeNow() }, 400)
        })
        obs.observe(target, {childList: true, subtree: true})
    }

    const AesAfpFlightLogScraper = {scrapeNow, last: null}
    window.AesAfpFlightLogScraper = AesAfpFlightLogScraper

    _bootstrap()
})()
