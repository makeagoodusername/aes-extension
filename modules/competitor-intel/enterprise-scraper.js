"use strict"

/**
 * Enterprise scraper for the Competitor Intelligence module.
 *
 * Wraps `RouteAssistantEnterpriseMetaScraper` for the meta fields
 * (name/IATA/banner/avatar) and adds a deep-parse pass over two pages:
 *
 *   - `/app/info/enterprises/<id>`         — Information tab: alliance,
 *      base country, fleet/stations/employees counts, pax/cargo carried.
 *   - `/app/info/enterprises/<id>?tab=3`   — Schedule tab: hub list
 *      derived from `.flight-schedule` origins (each `important origin`
 *      row is a hub, weeklyDepartures = sum of origin's leg frequencies).
 *
 * Defensive multi-strategy DOM walk: each field has a primary selector
 * and a fallback; failures get logged into `parserNotes` so the panel
 * surfaces gaps rather than silently treating "no data" as "unknown".
 *
 * Cache is the per-enterprise record at
 * `competitorIntel:enterprise:<server>:<id>` — `AesCompetitorEnterpriseScraper`
 * skips the network round-trips when the cached record is fresh per the
 * settings TTL.
 */
class AesCompetitorEnterpriseScraper {
    constructor(server, opts) {
        if (!server) throw new Error("AesCompetitorEnterpriseScraper: server required")
        this.server = server
        this.opts = opts || {}
        this._sessionCache = new Map()
        this._meta = null
        if (typeof RouteAssistantEnterpriseMetaScraper !== "undefined") {
            this._meta = new RouteAssistantEnterpriseMetaScraper(server, {maxAgeDays: 90})
        }
    }

    async scrape(enterpriseId) {
        const id = String(enterpriseId)
        if (this._sessionCache.has(id)) return this._sessionCache.get(id)

        const meta = this._meta ? await this._safeMeta(id) : {}
        const deep = await this._scrapeDeep(id)
        const merged = AesCompetitorEnterpriseScraper._merge(meta, deep)

        const rec = await AesCompetitorStore.saveEnterprise(this.server, id, merged)
        this._sessionCache.set(id, rec)
        return rec
    }

    async _safeMeta(id) {
        try {
            const rec = await this._meta.scrape(id)
            return rec || {}
        } catch (e) {
            console.warn("[AES competitor-intel] RA meta scrape failed:", e)
            return {parserNotesMeta: "RA meta scrape failed"}
        }
    }

    async _scrapeDeep(id) {
        const baseUrl = `https://${this.server}.airlinesim.aero/app/info/enterprises/${encodeURIComponent(id)}`
        const [tab0Html, tab3Html] = await Promise.all([
            AesCompetitorEnterpriseScraper._fetchHtml(baseUrl),
            AesCompetitorEnterpriseScraper._fetchHtml(baseUrl + "?tab=3")
        ])
        const tab0 = parseEnterpriseTab0(tab0Html)
        const tab3 = parseEnterpriseScheduleTab(tab3Html)

        const notes = []
        if (tab0.parserNotes) notes.push("tab0: " + tab0.parserNotes)
        if (tab3.parserNotes) notes.push("tab3: " + tab3.parserNotes)

        return {
            alliance:       tab0.alliance,
            baseCountry:    tab0.baseCountry,
            fleet:          tab0.fleet,
            hubs:           tab3.hubs,
            routeFootprint: tab3.routeFootprint,
            parserNotesDeep: notes.length ? notes.join("; ") : null
        }
    }

    static async _fetchHtml(url) {
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return null
            return await resp.text()
        } catch (e) {
            console.warn("[AES competitor-intel] fetch failed:", url, e)
            return null
        }
    }

    static _merge(meta, deep) {
        const notes = []
        if (meta && meta.parserNotes) notes.push("meta: " + meta.parserNotes)
        if (meta && meta.parserNotesMeta) notes.push("meta: " + meta.parserNotesMeta)
        if (deep && deep.parserNotesDeep) notes.push(deep.parserNotesDeep)
        const merged = {
            name:        meta && meta.name || null,
            iata:        meta && meta.iata || null,
            bannerUrl:   meta && meta.bannerUrl || null,
            avatarUrl:   meta && meta.avatarUrl || null,
            alliance:    deep && deep.alliance || null,
            baseCountry: deep && deep.baseCountry || null,
            fleet:       deep && deep.fleet || null,
            hubs:        (deep && deep.hubs) || [],
            routeFootprint: (deep && deep.routeFootprint) || [],
            parserNotes: notes.length ? notes.join("; ") : null
        }
        return merged
    }

    /**
     * Bulk scrape — concurrency 3 default, stagger 800ms. Mirrors RA's
     * orchestration shape so the progress UI in slice 4 can use the same
     * pattern.
     */
    async bulkScrape(ids, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(5, opts.concurrency || 3))
        const staggerMs   = Math.max(0, opts.staggerMs || 800)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null
        const abortRef    = opts.abortRef || null

        const total = ids.length
        if (!total) return []
        const results = new Array(total)

        let cursor = 0
        let inflight = 0
        let done = 0
        let lastDispatchAt = 0

        return new Promise(resolve => {
            const tryDispatch = () => {
                while (inflight < concurrency && cursor < total) {
                    if (abortRef && abortRef.aborted) {
                        resolve(results)
                        return
                    }
                    const sinceLast = Date.now() - lastDispatchAt
                    if (sinceLast < staggerMs) {
                        setTimeout(tryDispatch, staggerMs - sinceLast)
                        return
                    }
                    const idx = cursor++
                    const id = ids[idx]
                    inflight++
                    lastDispatchAt = Date.now()
                    const finish = (rec) => {
                        results[idx] = rec
                        inflight--
                        done++
                        if (onProgress) {
                            try { onProgress({phase: "enterprise", done, total, currentId: id}) } catch (e) { /* noop */ }
                        }
                        if (done >= total || (abortRef && abortRef.aborted)) resolve(results)
                        else tryDispatch()
                    }
                    this.scrape(id).then(finish).catch(err => {
                        console.warn("[AES competitor-intel] enterprise bulk scrape error:", err)
                        finish(null)
                    })
                }
            }
            tryDispatch()
        })
    }
}

// ---------- Parsers ----------

/**
 * Parse the default Information tab. Returns:
 *   { alliance: {id, name}|null, baseCountry: {id, name}|null,
 *     fleet: {aircraftCount, stationsCount, employeeCount, paxCarried, cargoCarried, rating}|null,
 *     parserNotes: string|null }
 */
function parseEnterpriseTab0(html) {
    if (!html) return {alliance: null, baseCountry: null, fleet: null, parserNotes: "no HTML"}
    let doc
    try { doc = new DOMParser().parseFromString(html, "text/html") } catch (e) {
        return {alliance: null, baseCountry: null, fleet: null, parserNotes: "DOMParser failed"}
    }
    if (!doc || !doc.body) return {alliance: null, baseCountry: null, fleet: null, parserNotes: "empty document"}

    const notes = []

    // Alliance — any link to /alliances/N inside the enterprise page
    let alliance = null
    const allianceLink = doc.querySelector("a[href*='/info/alliances/'], a[href*='/alliances/']")
    if (allianceLink) {
        const m = /\/alliances\/(\d+)/.exec(allianceLink.getAttribute("href") || "")
        if (m) {
            alliance = {
                id: m[1],
                name: (allianceLink.textContent || "").trim() || null
            }
        }
    }

    // Base country — first link to /info/countries/...
    let baseCountry = null
    const countryLink = doc.querySelector("a[href*='/info/countries/']")
    if (countryLink) {
        const href = countryLink.getAttribute("href") || ""
        const m = /\/countries\/([^?#/]+)/.exec(href)
        if (m) {
            baseCountry = {
                id: decodeURIComponent(m[1]),
                name: (countryLink.textContent || "").trim() || null
            }
        }
    }

    // Counts — try labelled rows first, fall back to legacy positional.
    const fleet = parseFleetCounts(doc)
    if (!fleet) notes.push("fleet counts not parsed")
    if (!alliance) notes.push("alliance not parsed")
    if (!baseCountry) notes.push("baseCountry not parsed")

    return {
        alliance,
        baseCountry,
        fleet,
        parserNotes: notes.length ? notes.join("; ") : null
    }
}

function parseFleetCounts(doc) {
    const fields = {
        aircraftCount: ["fleet", "flotte", "aircraft"],
        stationsCount: ["stations", "stationen", "airports"],
        employeeCount: ["employees", "mitarbeiter", "personnel"],
        paxCarried:    ["passengers", "passagiere", "pax"],
        cargoCarried:  ["cargo", "fracht"],
        rating:        ["rating", "bewertung"]
    }
    const out = {}
    let matched = 0

    for (const tr of doc.querySelectorAll("tr, dl > div, li")) {
        const cells = tr.querySelectorAll("td, dt, dd, span")
        if (!cells.length) continue
        const labelText = ((cells[0] && cells[0].textContent) || "").trim().toLowerCase()
        if (!labelText) continue
        const valueText = ((cells[1] && cells[1].textContent) || "").trim()

        for (const key in fields) {
            if (out[key] != null) continue
            for (const kw of fields[key]) {
                if (labelText.indexOf(kw) === 0 || labelText === kw) {
                    if (key === "rating") {
                        const r = valueText.replace(/[^A-Za-z0-9]/g, "")
                        if (r) { out[key] = r; matched++ }
                    } else {
                        const n = parseInt(valueText.split("(")[0].replace(/\D/g, ""), 10)
                        if (isFinite(n)) { out[key] = n; matched++ }
                    }
                    break
                }
            }
        }
    }

    if (matched === 0) {
        const tables = doc.querySelectorAll(".layout-col-md-4 > .as-fieldset table tbody")
        if (tables.length >= 2) {
            const tb = tables[1]
            const rows = tb.querySelectorAll("tr")
            const nthInt = (n) => {
                const r = rows[n]
                if (!r) return null
                const tds = r.querySelectorAll("td")
                if (tds.length < 2) return null
                const x = parseInt((tds[1].textContent || "").split("(")[0].replace(/\D/g, ""), 10)
                return isFinite(x) ? x : null
            }
            const v0 = nthInt(0), v1 = nthInt(1), v2 = nthInt(2), v3 = nthInt(3), v4 = nthInt(4)
            if ([v0, v1, v2, v3, v4].some(x => x != null)) {
                if (v0 != null) out.paxCarried = v0
                if (v1 != null) out.cargoCarried = v1
                if (v2 != null) out.stationsCount = v2
                if (v3 != null) out.aircraftCount = v3
                if (v4 != null) out.employeeCount = v4
                matched = 1
            }
        }
    }

    return matched > 0 ? out : null
}

/**
 * Parse the Schedule tab (?tab=3). Walks `.flight-schedule table tbody`
 * rows where each route block is `<tr.important.origin>` followed by
 * `<tr.destination>` and `<tr>` flight rows. Counts unique IATA origins
 * (hubs) and the full route footprint (origin → dest pairs).
 *
 * Returns:
 *   { hubs: [{iata, weeklyDepartures, isHub}],
 *     routeFootprint: [{hub, dest, weeklyFlights}],
 *     parserNotes: string|null }
 */
function parseEnterpriseScheduleTab(html) {
    if (!html) return {hubs: [], routeFootprint: [], parserNotes: "no HTML"}
    let doc
    try { doc = new DOMParser().parseFromString(html, "text/html") } catch (e) {
        return {hubs: [], routeFootprint: [], parserNotes: "DOMParser failed"}
    }
    if (!doc || !doc.body) return {hubs: [], routeFootprint: [], parserNotes: "empty document"}

    const tbodies = doc.querySelectorAll(".flight-schedule table tbody")
    if (!tbodies.length) {
        return {hubs: [], routeFootprint: [], parserNotes: "flight-schedule tables not found"}
    }

    const originStats = new Map()
    const iataToAirportId = new Map()
    const pairs = []

    for (const tbody of tbodies) {
        let currentOrigin = null
        let currentDest = null
        let pairFlights = 0

        const flushPair = () => {
            if (currentOrigin && currentDest && pairFlights > 0) {
                pairs.push({hub: currentOrigin, dest: currentDest, weeklyFlights: pairFlights})
                const stat = originStats.get(currentOrigin) || {iata: currentOrigin, weeklyDepartures: 0}
                stat.weeklyDepartures += pairFlights
                originStats.set(currentOrigin, stat)
            }
            currentDest = null
            pairFlights = 0
        }

        for (const tr of tbody.querySelectorAll("tr")) {
            const cls = tr.className || ""
            if (cls.indexOf("origin") >= 0) {
                flushPair()
                const parsed = AesCompetitorEnterpriseScraper._airportFromRow(tr)
                currentOrigin = parsed.iata
                if (parsed.iata && parsed.airportId) iataToAirportId.set(parsed.iata, parsed.airportId)
            } else if (cls.indexOf("destination") >= 0) {
                flushPair()
                const parsed = AesCompetitorEnterpriseScraper._airportFromRow(tr)
                currentDest = parsed.iata
                if (parsed.iata && parsed.airportId) iataToAirportId.set(parsed.iata, parsed.airportId)
            } else if (cls === "head" || cls.indexOf("head") >= 0) {
                // skip header rows
            } else {
                const days = (tr.querySelector(".days") || {}).textContent || ""
                for (let i = 0; i < days.length; i++) {
                    const ch = days.charAt(i)
                    if (ch >= "0" && ch <= "9") pairFlights++
                }
            }
        }
        flushPair()
    }

    const hubs = []
    for (const stat of originStats.values()) {
        if (!stat.iata) continue
        hubs.push({
            iata: stat.iata,
            airportId: iataToAirportId.get(stat.iata) || null,
            weeklyDepartures: stat.weeklyDepartures,
            isHub: true
        })
    }
    hubs.sort((a, b) => (b.weeklyDepartures || 0) - (a.weeklyDepartures || 0))

    const notes = []
    if (!hubs.length) notes.push("no hubs derived (schedule may be empty)")

    return {hubs, routeFootprint: pairs, parserNotes: notes.length ? notes.join("; ") : null}
}

AesCompetitorEnterpriseScraper._airportFromRow = function(tr) {
    let iata = null
    let airportId = null
    const link = tr.querySelector("a[href*='/airports/']")
    if (link) {
        const text = (link.textContent || "").trim()
        const m = /\b([A-Z]{3})\b/.exec(text)
        if (m) iata = m[1]
        else if (text) iata = text
        const hm = /\/airports\/(\d+)/.exec(link.getAttribute("href") || "")
        if (hm) airportId = hm[1]
    } else {
        const altLink = tr.querySelector("a")
        if (altLink) {
            const text = (altLink.textContent || "").trim()
            const m = /\b([A-Z]{3})\b/.exec(text)
            if (m) iata = m[1]
        }
    }
    if (!iata) {
        const text = (tr.textContent || "").trim()
        const m = /\b([A-Z]{3})\b/.exec(text)
        if (m) iata = m[1]
    }
    return {iata, airportId}
}
