"use strict"

/**
 * Contractual partners scraper for the Route Assistant — Letter F slice 3.
 *
 * Fetches `/app/info/enterprises/<id>?tab=1` ("Contractual partners")
 * and parses the partners table. AS surfaces every business relation
 * the enterprise has — Alliance, Interlining, Lessor, and any future
 * relation types — in a single table where each row carries one or
 * more `<span class="type ALLIANCE">` / `<span class="type INTERLINING">`
 * etc. badges. One fetch per *own* enterprise yields the full set of
 * partner enterprise IDs which the Cmp popover then cross-references
 * to render an ⇄ glyph next to interlining partners.
 *
 * Why fetch *your own* enterprise rather than each competitor:
 * the partners table on enterprise X lists X's relations. To know who
 * YOU have an IL agreement with, fetch your own enterprise's tab=1.
 * One request covers the whole popover; iterating over every visible
 * competitor would be wasteful and wouldn't tell us about reciprocity
 * either way.
 *
 * Cache (NOT directional — these are properties of the enterprise that
 * holds the agreements, not of the route):
 *   routeAssistant:contractualPartners:<enterpriseId>
 *     → {enterpriseId, server, scrapedAt,
 *        partners: [{partnerId, partnerName, partnerIata, hqCity,
 *                    hqIata, country, relations: [...]}],
 *        parserNotes?}
 *
 * Default TTL is 30 days — agreements are stable but less stable than
 * enterprise branding (which uses a 90-day cache in
 * `enterprise-meta-scraper.js`). User can dial via
 * `settings.routeAssistant.carriers.partnersMaxAgeDays`.
 *
 * Parser keeps the relation tag verbatim (the second classname token
 * on the `<span class="type X">` element) so unknown future relation
 * types still surface — UI gates them on a known-tag whitelist for
 * rendering, but storage captures everything.
 */
class RouteAssistantContractualPartnersScraper {
    static CACHE_PREFIX = "routeAssistant:contractualPartners:"

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantContractualPartnersScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantContractualPartnersScraper._normaliseMaxAge(opts && opts.maxAgeDays)
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

    static async loadRecord(server, enterpriseId) {
        const key = RouteAssistantContractualPartnersScraper.CACHE_PREFIX + String(enterpriseId)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    /**
     * Bulk-load cached records for a list of enterprise IDs. Returns
     * Map<enterpriseId-as-string, record>. Used by the panel on mount
     * + after a refresh so the popover paints with whatever's already
     * cached even when the user hasn't pressed refresh in this session.
     */
    static async bulkLoadCache(ids, opts) {
        if (!ids || !ids.length) return new Map()
        const maxAgeDays = RouteAssistantContractualPartnersScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const keys = ids.map(id => RouteAssistantContractualPartnersScraper.CACHE_PREFIX + String(id))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            if (RouteAssistantContractualPartnersScraper._isExpired(rec, maxAgeDays)) continue
            const id = k.substring(RouteAssistantContractualPartnersScraper.CACHE_PREFIX.length)
            map.set(id, rec)
        }
        return map
    }

    static async saveRecord(server, enterpriseId, fields) {
        const id = String(enterpriseId)
        const key = RouteAssistantContractualPartnersScraper.CACHE_PREFIX + id
        const rec = Object.assign({
            enterpriseId: id,
            server:       server,
            scrapedAt:    Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    /**
     * Fetch + parse one enterprise's Contractual partners tab.
     * Idempotent within the session — repeated calls short-circuit
     * through `_sessionCache`.
     */
    async scrape(enterpriseId) {
        const id = String(enterpriseId)
        if (this._sessionCache.has(id)) return this._sessionCache.get(id)

        const url = `https://${this.server}.airlinesim.aero/app/info/enterprises/${encodeURIComponent(id)}?tab=1`
        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (resp.ok) html = await resp.text()
        } catch (e) {
            console.warn(`[AES partnersScraper] fetch failed for #${id}:`, e)
        }

        const parsed = parsePartnersHtml(html)
        const record = await RouteAssistantContractualPartnersScraper.saveRecord(this.server, id, parsed)
        const suffix = parsed.parserNotes ? " (" + parsed.parserNotes + ")" : ""
        console.log("[AES partnersScraper] saved partners for enterprise " + id + ": "
            + (parsed.partners ? parsed.partners.length : 0) + " entries" + suffix)
        this._sessionCache.set(id, record)
        return record
    }

    /**
     * Concurrent bulk scrape — same orchestration shape as the sibling
     * RA scrapers. Typical use is 1-2 IDs (canopy users have multiple
     * own enterprises) so concurrency defaults are conservative.
     */
    async bulkScrape(ids, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(20, opts.concurrency || 4))
        const staggerMs   = Math.max(0, opts.staggerMs || 400)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null

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
                            try { onProgress(done, total) } catch (e) { /* noop */ }
                        }
                        if (done >= total) resolve(results)
                        else tryDispatch()
                    }
                    this.scrape(id).then(finish).catch(err => {
                        console.warn("[AES partnersScraper] scrape error:", err)
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
 * Parse the `?tab=1` HTML for the partners table. Returns:
 *   {partners: [{partnerId, partnerName, partnerIata, hqCity?, hqIata?,
 *                country?, relations: [...]}],
 *    parserNotes?}
 *
 * Rows where the enterprise link is missing or unparseable are skipped
 * — without an ID we can't cross-reference. Rows with no relation
 * spans are still kept (they at least confirm the link exists), with
 * `relations: []` so the consumer doesn't crash.
 */
function parsePartnersHtml(html) {
    const fallback = {partners: []}
    if (!html) return Object.assign({}, fallback, {parserNotes: "no HTML returned"})

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        return Object.assign({}, fallback, {parserNotes: "DOMParser failed"})
    }
    if (!doc || !doc.body) return Object.assign({}, fallback, {parserNotes: "empty document"})

    const table = doc.querySelector("table.partners")
    if (!table) {
        return Object.assign({}, fallback, {parserNotes: "table.partners not found — page may be tab=0 or login redirect"})
    }

    const rows = table.querySelectorAll("tbody > tr")
    if (!rows.length) {
        return {partners: [], parserNotes: "table.partners has no rows (no partners yet)"}
    }

    const idRe = /\/enterprises\/(\d+)/
    const partners = []
    let dropped = 0
    for (const tr of rows) {
        const tds = tr.querySelectorAll("td")
        if (!tds.length) continue

        const col1 = tds[0]
        const link = col1 && col1.querySelector("a[href*='/enterprises/']")
        if (!link) { dropped++; continue }
        const m = idRe.exec(link.getAttribute("href") || "")
        if (!m) { dropped++; continue }
        const partnerId = m[1]
        const partnerName = (link.textContent || "").trim() || null
        const iataSpan = col1.querySelector("span")
        const partnerIata = iataSpan ? ((iataSpan.textContent || "").trim() || null) : null

        let hqCity = null
        let hqIata = null
        if (tds[1]) {
            const hqLink = tds[1].querySelector("a")
            if (hqLink) hqCity = (hqLink.textContent || "").trim() || null
            const hqSpan = tds[1].querySelector("span")
            if (hqSpan) hqIata = (hqSpan.textContent || "").trim() || null
        }

        let country = null
        if (tds[2]) {
            const img = tds[2].querySelector("img[title]")
            if (img) country = (img.getAttribute("title") || "").trim() || null
        }

        const relations = []
        if (tds[3]) {
            for (const span of tds[3].querySelectorAll("span.type")) {
                const cls = (span.getAttribute("class") || "").split(/\s+/)
                const tag = cls.find(t => t && t !== "type")
                if (tag && relations.indexOf(tag) === -1) relations.push(tag)
            }
        }

        partners.push({
            partnerId:   partnerId,
            partnerName: partnerName,
            partnerIata: partnerIata,
            hqCity:      hqCity,
            hqIata:      hqIata,
            country:     country,
            relations:   relations
        })
    }

    const notes = []
    if (dropped > 0) notes.push(dropped + " row(s) without parseable enterprise link skipped")
    return {
        partners: partners,
        parserNotes: notes.length ? notes.join("; ") : null
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantContractualPartnersScraper = RouteAssistantContractualPartnersScraper
}
