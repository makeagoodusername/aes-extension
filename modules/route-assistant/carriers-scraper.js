"use strict"

/**
 * Per-route carrier scraper for the Route Assistant — Letter F.
 *
 * Reads the per-pair detail page on flightsfrom.com to extract the full
 * list of carriers operating between two airports, with each carrier's
 * weekly frequency and (when available) the aircraft types they fly.
 *
 * Two consumption paths mirror RouteAssistantTicketPriceScraper:
 *
 *   1. `scrape(hub, dest)`              — direct cross-origin fetch +
 *                                         DOMParser. Single pair.
 *   2. `bulkScrape(pairs, {concurrency, staggerMs, onProgress})`
 *                                       — drives the Sync CTA in the
 *                                         Route Assistant panel.
 *
 * Cache (persistent, directional):
 *   routeAssistant:carriers:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt, source, carriers: [{name, code?, country?,
 *        weeklyFlights?, aircraftTypes?: string[]}], totalAirlines,
 *        totalWeeklyFlights, parserNotes?}
 *
 * Pair key is **directional** even though carrier service is usually
 * symmetric — flightsfrom's URL pattern is direction-explicit, so we
 * key the record the same way to avoid silent reverse-direction
 * collisions if the data ever diverges.
 *
 * Parsing limitation:
 *   flightsfrom.com is a client-rendered SPA. The initial fetched HTML
 *   sometimes contains the carrier list (SSR for SEO), sometimes just a
 *   skeleton. Selectors below try several DOM shapes; when nothing
 *   matches, the record is saved with `carriers: []` plus a parserNotes
 *   string the panel can surface so the user knows scraping failed
 *   rather than the route having zero carriers.
 *
 *   A future slice can add a child-tab worker (like
 *   content_flightsFrom.js does for the per-IATA listing) so the carrier
 *   list is always extractable; deferred until we have a sample of a
 *   page that doesn't SSR.
 */
class RouteAssistantCarriersScraper {
    static CACHE_PREFIX = "routeAssistant:carriers:"

    constructor(opts) {
        this.maxAgeDays = RouteAssistantCarriersScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        this._accountId = (opts && typeof opts.accountId === "string" && opts.accountId) || null
        this._sessionCache = new Map()
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
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

    static _legacyKey(hub, dest) {
        return RouteAssistantCarriersScraper.CACHE_PREFIX
            + RouteAssistantCarriersScraper._pairKey(hub, dest)
    }

    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantCarriersScraper._legacyKey(hub, dest)
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(legacy, accountId)
        }
        return legacy
    }

    static _resolveAccountId(opts) {
        if (opts && typeof opts.accountId === "string" && opts.accountId) return opts.accountId
        if (typeof globalThis !== "undefined"
            && globalThis.AesAccountScopedKey
            && typeof globalThis.AesAccountScopedKey.currentAccountIdSync === "function") {
            return globalThis.AesAccountScopedKey.currentAccountIdSync()
        }
        return null
    }

    /**
     * Bulk-load cached records for a list of {hub, dest} pairs (or
     * [hub, dest] tuples). Returns Map<pairKey, record>. Account-scoped
     * first with a legacy-key fallback so pre-L3 caches stay readable.
     */
    static async bulkLoadCache(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId     = RouteAssistantCarriersScraper._resolveAccountId(opts)
        const maxAgeDays = RouteAssistantCarriersScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const pairList   = []
        const scopedKeys = []
        const legacyKeys = []
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairList.push(RouteAssistantCarriersScraper._pairKey(a, b))
            scopedKeys.push(RouteAssistantCarriersScraper._key(a, b, acctId))
            legacyKeys.push(RouteAssistantCarriersScraper._legacyKey(a, b))
        }
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const out     = await chrome.storage.local.get(reqKeys)
        const map     = new Map()
        for (let i = 0; i < pairList.length; i++) {
            const rec = out[scopedKeys[i]] || out[legacyKeys[i]] || null
            if (!rec) continue
            if (RouteAssistantCarriersScraper._isExpired(rec, maxAgeDays)) continue
            map.set(pairList[i], rec)
        }
        return map
    }

    static async saveRecord(hub, dest, fields, source, opts) {
        const acctId = RouteAssistantCarriersScraper._resolveAccountId(opts)
        const key    = RouteAssistantCarriersScraper._key(hub, dest, acctId)
        const rec    = Object.assign({
            hub:       String(hub || "").toUpperCase(),
            dest:      String(dest || "").toUpperCase(),
            scrapedAt: Date.now(),
            source:    source || "fetch"
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    /**
     * Fetches the per-pair detail page, parses, persists, and returns
     * the cached record. Idempotent within a session — repeated calls
     * for the same pair short-circuit through the session cache.
     */
    async scrape(hubIata, destIata) {
        const pair = RouteAssistantCarriersScraper._pairKey(hubIata, destIata)
        if (this._sessionCache.has(pair)) return this._sessionCache.get(pair)

        const url = `https://www.flightsfrom.com/${hubIata.toUpperCase()}-${destIata.toUpperCase()}`
        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (resp.ok) html = await resp.text()
        } catch (e) {
            console.warn(`[AES carriersScraper] fetch failed for ${hubIata}-${destIata}:`, e)
        }

        const parsed = parseCarriersHtml(html)
        const record = await RouteAssistantCarriersScraper.saveRecord(
            hubIata, destIata,
            {
                carriers:           parsed.carriers,
                totalAirlines:      parsed.totalAirlines,
                totalWeeklyFlights: parsed.totalWeeklyFlights,
                parserNotes:        parsed.parserNotes
            },
            "ff-detail",
            {accountId: this._accountId}
        )
        this._sessionCache.set(pair, record)
        return record
    }

    /**
     * Concurrent bulk scrape — same orchestration shape as
     * RouteAssistantTicketPriceScraper.bulkScrape so the panel can
     * reuse the existing progress + stagger UI. Returns when every
     * pair has resolved.
     */
    async bulkScrape(pairs, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(10, opts.concurrency || 3))
        const staggerMs   = Math.max(0, opts.staggerMs || 1200)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null

        const total = pairs.length
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
                    const {hub, dest} = pairs[idx]
                    inflight++
                    lastDispatchAt = Date.now()
                    this.scrape(hub, dest).then(rec => {
                        results[idx] = rec
                        inflight--
                        done++
                        if (onProgress) {
                            try { onProgress(done, total) } catch (e) { /* noop */ }
                        }
                        if (done >= total) resolve(results)
                        else tryDispatch()
                    }).catch(err => {
                        console.warn("[AES carriersScraper] scrape error:", err)
                        results[idx] = null
                        inflight--
                        done++
                        if (onProgress) {
                            try { onProgress(done, total) } catch (e) { /* noop */ }
                        }
                        if (done >= total) resolve(results)
                        else tryDispatch()
                    })
                }
            }
            tryDispatch()
        })
    }

    /**
     * Three-band competitive-intensity classifier. Used by the panel
     * to color the Cmp cell. Tuning: AS routes with 1 carrier are
     * effectively a monopoly opportunity; 2-3 means established but
     * still room; 4+ is a saturated trunk route where pricing power
     * is limited. Boundaries chosen to match real-world airline
     * planning intuition rather than a precise statistical fit.
     */
    static intensity(airlineCount) {
        const n = Number(airlineCount)
        if (!isFinite(n) || n <= 0) return null
        if (n <= 1) return "low"
        if (n <= 3) return "mid"
        return "high"
    }

    static intensityColor(level) {
        if (level === "low")  return "#22c55e"
        if (level === "mid")  return "#fbbf24"
        if (level === "high") return "#ef4444"
        return "#9ca3af"
    }
}

// ---------- Parsers ----------

/**
 * Parse the per-pair detail page for carrier data.
 *
 * flightsfrom.com renders this page client-side and the markup has
 * shifted across releases, so each strategy is independently scoped
 * and any one of them can fail without aborting the whole parse.
 *
 * Returns:
 *   {carriers: [{name, code?, weeklyFlights?, aircraftTypes?: []}],
 *    totalAirlines, totalWeeklyFlights, parserNotes}
 *
 * carriers may be empty when the SPA didn't pre-render the list. In
 * that case parserNotes describes which strategies tried and failed,
 * so the panel can surface a "no SSR carrier list — try again from a
 * fresh tab" message instead of silently hiding the route.
 */
function parseCarriersHtml(html) {
    const empty = {carriers: [], totalAirlines: null, totalWeeklyFlights: null, parserNotes: null}
    if (!html) return Object.assign({}, empty, {parserNotes: "no HTML returned"})

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        return Object.assign({}, empty, {parserNotes: "DOMParser failed"})
    }
    if (!doc || !doc.body) return Object.assign({}, empty, {parserNotes: "empty document"})

    const notes = []
    const carriers = []

    // Strategy A: explicit airline-list selector. Pages that SSR the
    // list use class names containing "airline" / "carrier".
    const airlineRows = doc.querySelectorAll(
        ".ff-airline-row, [class*='airline-row'], [class*='carrier-row'], "
        + "ul.airlines li, ul.carriers li, [data-testid='carrier-row']"
    )
    if (airlineRows.length) {
        for (const row of airlineRows) {
            const c = extractCarrierFromRow(row)
            if (c && c.name) carriers.push(c)
        }
        notes.push("airline-row matched (" + airlineRows.length + ")")
    }

    // Strategy B: image alt-text under any "Airlines" heading. Many
    // flightsfrom pages list carriers as logo grids with alt="Carrier
    // Name" and the heading nearby.
    if (!carriers.length) {
        const airlinesSection = findSectionByHeading(doc, /\bairlines?\b|\bcarriers?\b/i)
        if (airlinesSection) {
            const imgs = airlinesSection.querySelectorAll("img[alt]")
            for (const img of imgs) {
                const alt = (img.getAttribute("alt") || "").trim()
                if (alt && alt.length >= 2 && alt.length < 80) {
                    carriers.push({name: alt})
                }
            }
            if (carriers.length) notes.push("logo-alt under heading (" + carriers.length + ")")
        }
    }

    // Strategy C: any anchor pointing at /<airline>/ inside main.
    if (!carriers.length) {
        const main = doc.querySelector("main") || doc.body
        const links = main.querySelectorAll("a[href*='/airline/'], a[href*='/airlines/']")
        const seen = new Set()
        for (const a of links) {
            const txt = (a.textContent || "").trim()
            if (!txt || seen.has(txt)) continue
            // Reject obvious nav anchors ("All airlines", "View all").
            if (/^(view|all|see|browse)\b/i.test(txt)) continue
            seen.add(txt)
            carriers.push({name: txt})
        }
        if (carriers.length) notes.push("airline-link anchors (" + carriers.length + ")")
    }

    // Headline totals — page header often shows "X airlines · Y flights/week".
    let totalAirlines = null
    let totalWeeklyFlights = null
    const summaryText = doc.body ? doc.body.textContent : ""
    const aMatch = /(\d+)\s+airlines?\b/i.exec(summaryText)
    if (aMatch) totalAirlines = parseInt(aMatch[1], 10)
    const wMatch = /(\d+(?:[,\.\s]\d{3})*)\s+(?:weekly\s+)?flights?(?:\s*\/?\s*(?:week|wk))?/i.exec(summaryText)
    if (wMatch) {
        const cleaned = wMatch[1].replace(/[,\s\.]/g, "")
        const n = parseInt(cleaned, 10)
        if (isFinite(n) && n > 0 && n < 50000) totalWeeklyFlights = n
    }
    if (!totalAirlines && carriers.length) totalAirlines = carriers.length

    return {
        carriers:           dedupeCarriers(carriers),
        totalAirlines:      totalAirlines,
        totalWeeklyFlights: totalWeeklyFlights,
        parserNotes:        carriers.length ? null : (notes.length ? "tried: " + notes.join(", ") : "no airline markup matched")
    }
}

/**
 * Extract one carrier from a row-shaped element. Looks for the name
 * via image alt + visible text, plus any number-of-flights badge.
 */
function extractCarrierFromRow(row) {
    if (!row) return null
    const img = row.querySelector("img[alt]")
    const nameFromImg = img ? (img.getAttribute("alt") || "").trim() : ""
    const nameFromText = (row.textContent || "").trim().split(/\s{2,}|\n/)[0].trim()
    const name = nameFromImg || nameFromText
    if (!name) return null

    let weeklyFlights = null
    const freqEl = row.querySelector("[class*='freq'], [class*='flights-week']")
    if (freqEl) {
        const m = /(\d+)/.exec(freqEl.textContent || "")
        if (m) {
            const n = parseInt(m[1], 10)
            if (isFinite(n) && n > 0) weeklyFlights = n
        }
    }

    let code = null
    const codeEl = row.querySelector("[class*='iata'], [class*='code']")
    if (codeEl) {
        const t = (codeEl.textContent || "").trim()
        if (/^[A-Z0-9]{2,3}$/.test(t)) code = t
    }

    return {name: name, code: code, weeklyFlights: weeklyFlights}
}

/**
 * Returns the nearest container element whose preceding heading text
 * matches the regex. Walks h1–h6; returns the heading's parent so
 * children searches stay scoped to the section.
 */
function findSectionByHeading(doc, re) {
    const headings = doc.querySelectorAll("h1, h2, h3, h4, h5, h6")
    for (const h of headings) {
        if (re.test(h.textContent || "")) return h.parentElement || h
    }
    return null
}

/**
 * Strip duplicate carriers (same name) — strategies often overlap and
 * we want one record per airline. First-occurrence wins so the
 * richer-shape strategy (A, with weekly counts) outranks the bare
 * Strategy C anchor.
 */
function dedupeCarriers(list) {
    const seen = new Set()
    const out = []
    for (const c of list) {
        const key = (c.name || "").toLowerCase().trim()
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(c)
    }
    return out
}
