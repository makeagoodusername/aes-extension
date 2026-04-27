"use strict"

/**
 * Host for the Competitor Intelligence airport panel — runs the passive
 * scrape lifecycle on `/app/info/airports/<id>` and mounts
 * `AesCompetitorAirportPanel`.
 *
 * Lifecycle:
 *   1. Extract `airportId` from the URL.
 *   2. Read settings (autoScrapeOnVisit + airport TTL).
 *   3. Load cached airport record from `AesCompetitorStore`.
 *   4. If absent/stale and autoScrapeOnVisit, run the RA airport-overview
 *      scraper (which fetches + stashes the page HTML), then enrich with
 *      weeklyDepartures + interlining + officeId + isOurs + airport metadata.
 *   5. Aggregate (joins enterprise meta from RA cache where available).
 *   6. Mount the panel.
 */
class AesCompetitorAirportHost {
    constructor() {
        this._panel = null
        this._airportId = null
        this._server = null
        this._settings = null
    }

    async mount() {
        this._airportId = AesCompetitorAirportHost._extractAirportId()
        if (!this._airportId) {
            console.warn("[AES competitor-intel] no airportId in URL; skipping")
            return
        }
        this._server = AES.getServerName()
        if (!this._server) {
            console.warn("[AES competitor-intel] no server name; skipping")
            return
        }

        this._settings = await AesCompetitorSettings.load()
        const settings = this._settings
        const ttlMs = AesCompetitorSettings.airportTtlMs(settings)
        let cached = await AesCompetitorStore.loadAirport(this._server, this._airportId)
        const stale = !cached || AesCompetitorStore.isExpired(cached, ttlMs)

        if (stale && settings.autoScrapeOnVisit) {
            try {
                cached = await AesCompetitorAirportHost._scrapeAndSave(this._server, this._airportId)
            } catch (err) {
                console.warn("[AES competitor-intel] airport scrape failed:", err)
                if (!cached) {
                    cached = await AesCompetitorStore.saveAirport(this._server, this._airportId, {
                        carriers: [],
                        parserNotes: "scrape failed: " + (err && err.message || String(err))
                    })
                }
            }
        }

        const view = await AesCompetitorAggregator.buildAirportPanelView({
            server: this._server,
            airportId: this._airportId
        })

        this._panel = new AesCompetitorAirportPanel({
            host: this,
            settings
        })
        this._panel.render(view)
    }

    /**
     * Re-run the airport scrape (single fetch). Used by simple refreshes
     * that don't need the full carriers sweep.
     */
    async resync() {
        try {
            const rec = await AesCompetitorAirportHost._scrapeAndSave(this._server, this._airportId)
            const view = await AesCompetitorAggregator.buildAirportPanelView({
                server: this._server,
                airportId: this._airportId
            })
            if (this._panel) this._panel.render(view)
            return rec
        } catch (err) {
            console.warn("[AES competitor-intel] resync failed:", err)
            return null
        }
    }

    /**
     * Bulk Sync now: refresh this airport AND every enterprise listed in
     * its Stations table that isn't already fresh per the meta TTL. Reports
     * progress through `onProgress` and respects `scanner.abort()` for the
     * abort button.
     *
     * Returns the scanner so the caller can call `.abort()` and observe
     * `.aborted`. The promise resolves with the refreshed view.
     */
    bulkSync(onProgress) {
        const settings = this._settings
        const concurrency = (settings && settings.scan && settings.scan.concurrency) || 3
        const staggerMs   = (settings && settings.scan && settings.scan.staggerMs) || 800
        const scanner = new AesCompetitorBulkScanner({concurrency, staggerMs})

        const promise = (async () => {
            const airportRec = await AesCompetitorAirportHost._scrapeAndSave(this._server, this._airportId)
            const carriers = (airportRec && airportRec.carriers) || []
            const ids = carriers.map(c => c.enterpriseId).filter(Boolean)

            const metaCutoffMs = 90 * 86400000
            const cached = await AesCompetitorStore.bulkLoadEnterprises(this._server, ids)
            const stale = ids.filter(id => {
                const rec = cached.get(String(id))
                return !rec || AesCompetitorStore.isExpired(rec, metaCutoffMs)
            })

            const scraper = new AesCompetitorEnterpriseScraper(this._server)
            const jobs = stale.map(id => ({
                label: "enterprise #" + id,
                run: () => scraper.scrape(id)
            }))

            await scanner.run(jobs, onProgress)

            const view = await AesCompetitorAggregator.buildAirportPanelView({
                server: this._server,
                airportId: this._airportId
            })
            if (this._panel) this._panel.render(view)
            return view
        })()

        return {scanner, promise}
    }

    static _extractAirportId() {
        const m = /\/app\/info\/airports\/(\d+)/.exec(window.location.pathname)
        return m ? m[1] : null
    }

    static async _scrapeAndSave(server, airportId) {
        if (typeof RouteAssistantAirportOverviewScraper === "undefined") {
            throw new Error("RA airport-overview scraper unavailable")
        }
        const scraper = new RouteAssistantAirportOverviewScraper(server)
        await scraper.scrape(airportId)
        const html = scraper._sessionCache.get(String(airportId) + ":html") || null

        const enriched = parseAirportPageEnriched(html, airportId)
        const record = await AesCompetitorStore.saveAirport(server, airportId, enriched)
        return record
    }
}

/**
 * Parse `/app/info/airports/<id>` HTML for the carriers table + airport
 * metadata. Returns the shape expected by `AesCompetitorStore.saveAirport`
 * (everything except `server`, `airportId`, `scrapedAt` — those are added
 * by the store).
 *
 * Defensive multi-strategy walk: picks the Stations table by its header
 * text ("Enterprise" / "Unternehmen") and reads structural columns rather
 * than localised ones for the numeric departures cell. Any field that
 * fails to parse appears in `parserNotes` so the panel can surface the
 * gap gracefully.
 */
function parseAirportPageEnriched(html, airportId) {
    const fallback = {
        iata: null,
        name: null,
        countryId: null,
        countryName: null,
        carriers: [],
        parserNotes: null
    }
    if (!html) return Object.assign({}, fallback, {parserNotes: "no HTML returned"})

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        return Object.assign({}, fallback, {parserNotes: "DOMParser failed"})
    }
    if (!doc || !doc.body) return Object.assign({}, fallback, {parserNotes: "empty document"})

    const notes = []
    const result = Object.assign({}, fallback)

    // ---------- Airport metadata ----------
    const titleEl = doc.querySelector("h1, .as-page-title, [class*='page-title']")
    if (titleEl) {
        const text = (titleEl.textContent || "").trim()
        result.name = text.replace(/\s*\([A-Z0-9]{3,4}\)\s*$/, "").trim() || text
        const m = /\(([A-Z0-9]{3,4})\)/.exec(text)
        if (m) result.iata = m[1]
    }
    if (!result.iata) {
        for (const row of doc.querySelectorAll("tr, dl > div, li")) {
            const text = (row.textContent || "").trim()
            const m = /\bIATA\b[^A-Z0-9]*([A-Z0-9]{3})\b/i.exec(text)
            if (m) { result.iata = m[1].toUpperCase(); break }
        }
    }

    const countryLink = doc.querySelector("a[href*='/info/countries/']")
    if (countryLink) {
        const href = countryLink.getAttribute("href") || ""
        const m = /\/countries\/([^?#/]+)/.exec(href)
        if (m) result.countryId = decodeURIComponent(m[1])
        result.countryName = (countryLink.textContent || "").trim() || null
    }

    // ---------- Stations table ----------
    let stationsTable = null
    for (const th of doc.querySelectorAll("table th")) {
        const text = (th.textContent || "").trim()
        if (text === "Enterprise" || text === "Unternehmen") {
            stationsTable = th.closest("table")
            break
        }
    }
    if (!stationsTable) {
        notes.push("stations table not found")
        if (notes.length) result.parserNotes = notes.join("; ")
        return result
    }

    const ourIdentity = (typeof AES !== "undefined" && AES.getAirlineIdentity)
        ? AES.getAirlineIdentity() : null
    const seen = new Set()
    const carriers = []

    for (const tr of stationsTable.querySelectorAll("tbody tr")) {
        const enterpriseLink = tr.querySelector("a[href*='/enterprises/']")
        if (!enterpriseLink) continue
        const em = /\/enterprises\/(\d+)/.exec(enterpriseLink.getAttribute("href") || "")
        if (!em) continue
        const enterpriseId = em[1]
        if (seen.has(enterpriseId)) continue
        seen.add(enterpriseId)

        const enterpriseName = (enterpriseLink.textContent || "").trim()

        let allianceId = null
        const allianceLink = tr.querySelector(
            "td.alliance a[href*='/alliances/'], td.logo.alliance a[href*='/alliances/']"
        )
        if (allianceLink) {
            const am = /\/alliances\/(\d+)/.exec(allianceLink.getAttribute("href") || "")
            if (am) allianceId = am[1]
        }

        let weeklyDepartures = 0
        for (const td of tr.querySelectorAll("td")) {
            const text = (td.textContent || "").trim()
            const m = /^(\d+(?:[.,]\d+)*)\s*(Departures?|Abflüge|Abflug)?\s*$/i.exec(text)
            if (m) {
                const n = parseInt(m[1].replace(/[.,]/g, ""), 10)
                if (isFinite(n)) { weeklyDepartures = n; break }
            }
        }

        const isInterlining = !!tr.querySelector("span.fa-random, i.fa-random, [class*='fa-random']")

        let officeId = null
        const timetableLink = tr.querySelector("a[href*='timetable']")
        if (timetableLink) {
            const om = /office=(\d+)/.exec(timetableLink.getAttribute("href") || "")
            if (om) officeId = om[1]
        }

        const isOurs = !!ourIdentity && enterpriseName && enterpriseName.toLowerCase() === ourIdentity.toLowerCase()

        carriers.push({
            enterpriseId,
            enterpriseName,
            allianceId,
            weeklyDepartures,
            isInterlining,
            officeId,
            isOurs
        })
    }

    if (!carriers.length) notes.push("stations table empty (page may still be loading)")
    if (!result.iata) notes.push("airport IATA not parsed")
    if (!result.countryId) notes.push("airport country not parsed")

    result.carriers = carriers
    if (notes.length) result.parserNotes = notes.join("; ")
    return result
}
