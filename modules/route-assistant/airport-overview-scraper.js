"use strict"

/**
 * Airport-overview scraper for the Route Assistant.
 *
 * Fetches `/app/info/airports/<stationId>` and harvests the Stations
 * table — the per-airport list of every operating enterprise plus the
 * alliance (if any) each one belongs to. One fetch per station yields
 * a complete `{enterpriseId → allianceId}` map for every competitor at
 * that station, which the Cmp popover uses to render alliance logos
 * next to each carrier row.
 *
 * Why a separate scraper from `enterprise-meta-scraper.js`: that one
 * fetches /app/info/enterprises/<id> per-enterprise just for the
 * banner/avatar art. Alliance membership is not exposed there in a
 * machine-readable way and would need an additional drill into the
 * "Alliance" tab. The airport-overview page lists ALL competitors at
 * an airport with both their enterprise id AND alliance id in one shot
 * — so a single fetch covers an entire destination's competitor set.
 *
 * Cache (per-station, NOT per-route — alliance membership is a
 * property of the enterprise so the same map is reusable across every
 * route that touches the station):
 *   routeAssistant:airportOverview:<stationId>
 *     → {stationId, server, scrapedAt, pairs: [[entId, allianceId|null], ...]}
 *
 * Cache TTL: caller-supplied via `maxAgeDays` (panel uses 7d — alliance
 * membership churns slowly but isn't truly static).
 */
class RouteAssistantAirportOverviewScraper {
    static CACHE_PREFIX = "routeAssistant:airportOverview:"

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantAirportOverviewScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantAirportOverviewScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        this._sessionCache = new Map()
    }

    static _normaliseMaxAge(v) {
        const n = Number(v)
        return isFinite(n) && n > 0 ? n : null
    }

    static _isExpired(record, maxAgeDays) {
        if (!maxAgeDays) return false
        if (!record || typeof record.scrapedAt !== "number") return false
        return Date.now() - record.scrapedAt > maxAgeDays * 86400000
    }

    /**
     * Bulk-load cached records for a list of station IDs. Returns
     * Map<stationId-as-string, record>. Used by the panel on mount so
     * the popover can decorate entries with alliance ids without any
     * fetch.
     */
    static async bulkLoadCache(stationIds, opts) {
        if (!stationIds || !stationIds.length) return new Map()
        const maxAgeDays = RouteAssistantAirportOverviewScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const keys = stationIds.map(id => RouteAssistantAirportOverviewScraper.CACHE_PREFIX + String(id))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            if (RouteAssistantAirportOverviewScraper._isExpired(rec, maxAgeDays)) continue
            const id = k.substring(RouteAssistantAirportOverviewScraper.CACHE_PREFIX.length)
            map.set(id, rec)
        }
        return map
    }

    static async saveRecord(server, stationId, pairs) {
        const id = String(stationId)
        const key = RouteAssistantAirportOverviewScraper.CACHE_PREFIX + id
        const rec = {
            stationId: id,
            server:    server,
            pairs:     pairs || [],
            scrapedAt: Date.now()
        }
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    /**
     * Flatten cache records into a single Map<enterpriseId, allianceId>.
     * `null` allianceIds are preserved so callers can distinguish
     * "scraped, no alliance" from "never scraped".
     */
    static buildAllianceMap(records) {
        const out = new Map()
        if (!records) return out
        const iter = (records instanceof Map) ? records.values() : records
        for (const rec of iter) {
            if (!rec || !Array.isArray(rec.pairs)) continue
            for (const pair of rec.pairs) {
                if (!pair || !pair[0]) continue
                // First write wins for non-null; later non-null overwrites
                // a null. Same enterprise should always report the same
                // alliance regardless of which station we scraped.
                const existing = out.get(pair[0])
                if (existing == null && pair[1] != null) out.set(pair[0], pair[1])
                else if (!out.has(pair[0])) out.set(pair[0], pair[1])
            }
        }
        return out
    }

    /**
     * Fetch + parse one airport's Stations table. Idempotent within
     * the session — repeated calls short-circuit through `_sessionCache`.
     */
    async scrape(stationId) {
        const id = String(stationId)
        if (this._sessionCache.has(id)) return this._sessionCache.get(id)

        const url = `https://${this.server}.airlinesim.aero/app/info/airports/${encodeURIComponent(id)}`
        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (resp.ok) html = await resp.text()
        } catch (e) {
            console.warn(`[AES airportOverview] fetch failed for #${id}:`, e)
        }

        if (html) this._sessionCache.set(id + ":html", html)

        const pairs = parseAirportOverviewHtml(html)
        const record = await RouteAssistantAirportOverviewScraper.saveRecord(this.server, id, pairs)
        this._sessionCache.set(id, record)
        return record
    }

    /**
     * Concurrent bulk scrape — same orchestration shape as the other
     * RA scrapers (markets / carriers / enterpriseMeta). Resolves once
     * every station id has either persisted or errored.
     */
    async bulkScrape(stationIds, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(10, opts.concurrency || 3))
        const staggerMs   = Math.max(0, opts.staggerMs || 800)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null

        const total = stationIds.length
        if (!total) return []
        const results = new Array(total)

        let cursor = 0
        let inflight = 0
        let done = 0
        let lastDispatchAt = 0

        return new Promise(resolve => {
            const tryDispatch = () => {
                while (inflight < concurrency && cursor < total) {
                    const sinceLast = Date.now() - lastDispatchAt
                    if (sinceLast < staggerMs) {
                        setTimeout(tryDispatch, staggerMs - sinceLast)
                        return
                    }
                    const idx = cursor++
                    const id = stationIds[idx]
                    inflight++
                    lastDispatchAt = Date.now()
                    const finish = (rec) => {
                        results[idx] = rec
                        inflight--
                        done++
                        if (onProgress) {
                            try { onProgress(done, total) } catch (e) { /* noop */ }
                        }
                        if (done >= total) resolve(results)
                        else tryDispatch()
                    }
                    this.scrape(id).then(finish).catch(err => {
                        console.warn("[AES airportOverview] scrape error:", err)
                        finish(null)
                    })
                }
            }
            tryDispatch()
        })
    }
}

// ---------- Parser ----------

/**
 * Parse the airport-overview HTML for the Stations table. Returns an
 * array of `[enterpriseId, allianceId|null]` pairs.
 *
 * Strategy: locate the Stations table by its header text ("Enterprise"
 * in EN, "Unternehmen" in DE) since AS Wicket generates dynamic ids
 * (e.g. `id50d`) that change between page renders. Then walk its tbody
 * rows. Each row is `[alliance logo cell][enterprise logo cell][name
 * link]…`; enterprise id comes from the name link's href, alliance id
 * (if any) from the alliance cell's anchor href.
 */
function parseAirportOverviewHtml(html) {
    if (!html) return []

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        return []
    }
    if (!doc || !doc.body) return []

    let stationsTable = null
    for (const th of doc.querySelectorAll("table th")) {
        const text = (th.textContent || "").trim()
        if (text === "Enterprise" || text === "Unternehmen") {
            stationsTable = th.closest("table")
            break
        }
    }
    if (!stationsTable) return []

    const pairs = []
    const seen = new Set()
    for (const tr of stationsTable.querySelectorAll("tbody tr")) {
        const enterpriseLink = tr.querySelector("a[href*='/enterprises/']")
        if (!enterpriseLink) continue
        const em = /\/enterprises\/(\d+)/.exec(enterpriseLink.getAttribute("href") || "")
        if (!em) continue
        const enterpriseId = em[1]
        if (seen.has(enterpriseId)) continue
        seen.add(enterpriseId)

        let allianceId = null
        const allianceLink = tr.querySelector(
            "td.alliance a[href*='/alliances/'], td.logo.alliance a[href*='/alliances/']"
        )
        if (allianceLink) {
            const am = /\/alliances\/(\d+)/.exec(allianceLink.getAttribute("href") || "")
            if (am) allianceId = am[1]
        }

        pairs.push([enterpriseId, allianceId])
    }

    return pairs
}
