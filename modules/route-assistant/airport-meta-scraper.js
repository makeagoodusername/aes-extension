"use strict"

/**
 * Airport-metadata scraper for the Route Assistant.
 *
 * Fetches `/app/info/airports/<airportId>` and harvests the per-airport
 * facts the Flight Studio decision-support sidebar needs:
 *   runwayLengthM, sizeClass, noiseRestricted/noiseLabel,
 *   nightCurfew/curfewLabel, turnaroundMin.
 *
 * Sister scraper to `airport-overview-scraper.js` (carriers + alliance
 * pairs at a station) — same `/app/info/airports/<id>` page, different
 * extraction. Kept as a separate module so the carriers parse stays
 * lean and a future market-intel slice can call either independently.
 *
 * Cache:
 *   routeAssistant:airportMeta:<airportId>
 *     → {airportId, server, scrapedAt, iata,
 *        runwayLengthM, sizeClass,
 *        noiseRestricted, noiseLabel,
 *        nightCurfew, curfewLabel,
 *        turnaroundMin, parserNotes}
 *
 * TTL is caller-supplied (consumers default 30d — these facts are
 * near-static for an AS world).
 */
class RouteAssistantAirportMetaScraper {
    static CACHE_PREFIX = "routeAssistant:airportMeta:"

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantAirportMetaScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantAirportMetaScraper._normaliseMaxAge(opts && opts.maxAgeDays)
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

    static async bulkLoadCache(airportIds, opts) {
        if (!airportIds || !airportIds.length) return new Map()
        const maxAgeDays = RouteAssistantAirportMetaScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const keys = airportIds.map(id => RouteAssistantAirportMetaScraper.CACHE_PREFIX + String(id))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            if (RouteAssistantAirportMetaScraper._isExpired(rec, maxAgeDays)) continue
            const id = k.substring(RouteAssistantAirportMetaScraper.CACHE_PREFIX.length)
            map.set(id, rec)
        }
        return map
    }

    static async saveRecord(server, airportId, parsed) {
        const id = String(airportId)
        const key = RouteAssistantAirportMetaScraper.CACHE_PREFIX + id
        const rec = Object.assign({
            airportId:       id,
            server:          server,
            iata:            null,
            runwayLengthM:   null,
            sizeClass:       null,
            noiseRestricted: null,
            noiseLabel:      null,
            nightCurfew:     null,
            curfewLabel:     null,
            turnaroundMin:   null,
            parserNotes:     null
        }, parsed || {}, {scrapedAt: Date.now()})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    /** Fetch + parse one airport page. Idempotent within a session. */
    async scrape(airportId) {
        const id = String(airportId)
        if (this._sessionCache.has(id)) return this._sessionCache.get(id)

        const url = `https://${this.server}.airlinesim.aero/app/info/airports/${encodeURIComponent(id)}`
        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (resp.ok) html = await resp.text()
        } catch (e) {
            console.warn(`[AES airportMeta] fetch failed for #${id}:`, e)
        }

        const parsed = parseAirportMetaHtml(html)
        const record = await RouteAssistantAirportMetaScraper.saveRecord(this.server, id, parsed)
        this._sessionCache.set(id, record)
        return record
    }

    /** Concurrency-limited bulk scrape — same shape as airport-overview-scraper. */
    async bulkScrape(airportIds, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(20, opts.concurrency || 6))
        const staggerMs   = Math.max(0, opts.staggerMs || 800)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null

        const total = airportIds.length
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
                    const id = airportIds[idx]
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
                        console.warn("[AES airportMeta] scrape error:", err)
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
 * Walk every `<dl>/<dt>+<dd>` and `<table>/<tr>/<th>+<td>` pair on the
 * airport detail page and pick out the labelled facts we care about.
 * AS doesn't tag these with stable ids/classes, so we match on label
 * text (EN + DE) and only commit a value when the label is unambiguous.
 *
 * Defensive: every miss leaves the field `null` rather than guessing.
 * Returns the parsed shape (no airportId/server/scrapedAt — saveRecord
 * stamps those).
 */
function parseAirportMetaHtml(html) {
    const out = {
        iata:            null,
        runwayLengthM:   null,
        sizeClass:       null,
        noiseRestricted: null,
        noiseLabel:      null,
        nightCurfew:     null,
        curfewLabel:     null,
        turnaroundMin:   null,
        parserNotes:     null
    }
    if (!html) { out.parserNotes = "no HTML"; return out }

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        out.parserNotes = "DOMParser failed"
        return out
    }
    if (!doc || !doc.body) { out.parserNotes = "empty document"; return out }

    // IATA — title contains "Name (IATA)" or a row labelled IATA.
    const titleEl = doc.querySelector("h1, .as-page-title, [class*='page-title']")
    if (titleEl) {
        const m = /\(([A-Z0-9]{3,4})\)/.exec((titleEl.textContent || "").trim())
        if (m && /^[A-Z]{3}$/.test(m[1])) out.iata = m[1]
    }

    const labelPairs = collectLabelPairs(doc)
    const notes = []

    for (const {label, value} of labelPairs) {
        const lc = label.toLowerCase()

        if (out.runwayLengthM == null && /\b(runway|landebahn|piste)\b/.test(lc)) {
            const m = value.match(/([\d.,]+)\s*(m|ft|feet|meter)?/i)
            if (m) {
                let n = parseFloat(m[1].replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."))
                const unit = (m[2] || "m").toLowerCase()
                if (isFinite(n) && n > 0) {
                    if (unit.startsWith("ft") || unit.startsWith("feet")) n = n * 0.3048
                    out.runwayLengthM = Math.round(n)
                }
            }
        }

        if (out.sizeClass == null && /\b(size|class|category|klasse|kategorie)\b/.test(lc)) {
            const m = value.match(/\b(XL|S|M|L)\b/i)
                   || value.match(/\b(small|medium|large|extra[- ]large|extra)\b/i)
            if (m) {
                const t = m[1].toLowerCase()
                out.sizeClass = (t === "s" || t.startsWith("small")) ? "S"
                              : (t === "m" || t.startsWith("medium")) ? "M"
                              : (t === "l" || t.startsWith("large")) ? "L"
                              : "XL"
            }
        }

        if (out.noiseRestricted == null && /\b(noise|lärm|laerm)\b/.test(lc)) {
            out.noiseLabel = value || null
            out.noiseRestricted = _classifyRestriction(value)
        }

        if (out.nightCurfew == null
                && /\b(curfew|nighttime|night flight|sperrstunde|nachtflug|nachtflugverbot|nachtruhe)\b/.test(lc)) {
            out.curfewLabel = value || null
            out.nightCurfew = _classifyRestriction(value)
        }

        if (out.turnaroundMin == null
                && /\b(turn[- ]?around|ground[- ]?time|bodenzeit|standzeit)\b/.test(lc)) {
            const m = value.match(/(\d+)\s*(min|m|minutes?)?/i)
            if (m) {
                const n = parseInt(m[1], 10)
                if (isFinite(n) && n > 0 && n <= 600) out.turnaroundMin = n
            }
        }
    }

    // Derive size from runway when an explicit size class wasn't found.
    // Buckets mirror common AS-community guidance: <1500 short, 1500-2200
    // medium, 2200-3000 large, 3000+ extra-large.
    if (out.sizeClass == null && out.runwayLengthM != null) {
        const r = out.runwayLengthM
        out.sizeClass = (r < 1500) ? "S" : (r < 2200) ? "M" : (r < 3000) ? "L" : "XL"
    }

    if (out.runwayLengthM == null && out.sizeClass == null
            && out.noiseRestricted == null && out.nightCurfew == null
            && out.turnaroundMin == null) {
        notes.push("no facility labels matched")
    }
    if (notes.length) out.parserNotes = notes.join("; ")
    return out
}

/**
 * Classify a noise/curfew value cell into a boolean. Returns true when
 * the cell asserts a restriction, false when it explicitly negates one,
 * and null on ambiguity. Time patterns (e.g. "23:00-06:00"), positive
 * keywords (yes/restricted/closed/QC/stage) → true. Negative keywords
 * (none/no/allowed/24/7/unrestricted/open) → false.
 */
function _classifyRestriction(value) {
    if (!value) return null
    const v = value.trim().toLowerCase()
    if (!v || v === "—" || v === "-" || v === "n/a") return null
    if (/\d{1,2}[:.]\d{2}\s*[-–—to bis]\s*\d{1,2}[:.]\d{2}/.test(v)) return true
    if (/\b(qc[ -]?\d|stage[ -]?[34])\b/.test(v)) return true
    if (/\b(yes|ja|restricted|closed|geschlossen|verboten|prohibited)\b/.test(v)) return true
    if (/^(none|no|nein|keine|kein|allowed|unrestricted|open|geöffnet|frei|24[/\s]?7|never)$/.test(v)) return false
    if (/\b(none|no restriction|no curfew|kein|keine|allowed|unrestricted|24[/\s]?7)\b/.test(v)) return false
    // Anything else with a non-empty value — e.g. a numeric stage rating
    // or a free-text label — counts as a restriction by default. Tooltip
    // shows the raw text so the user can verify.
    return true
}

/**
 * Pull `{label, value}` pairs from every `<dl>` and definition-style
 * `<table>` on the page. The airport page layout varies by world skin,
 * so we scrape both. Whitespace-collapsed; empty values dropped.
 */
function collectLabelPairs(doc) {
    const pairs = []
    const norm = s => String(s || "").replace(/\s+/g, " ").trim()

    for (const dl of doc.querySelectorAll("dl")) {
        const kids = Array.from(dl.children)
        for (let i = 0; i < kids.length; i++) {
            const k = kids[i]
            if (!k || k.tagName !== "DT") continue
            const dd = kids[i + 1]
            if (!dd || dd.tagName !== "DD") continue
            const label = norm(k.textContent)
            const value = norm(dd.textContent)
            if (label && value) pairs.push({label, value})
        }
    }

    for (const tr of doc.querySelectorAll("table tr")) {
        const th = tr.querySelector("th, td.caption")
        if (!th) continue
        const td = th.nextElementSibling
        if (!td || td === th || (td.tagName !== "TD" && td.tagName !== "TH")) continue
        const label = norm(th.textContent)
        const value = norm(td.textContent)
        if (label && value && label !== value) pairs.push({label, value})
    }

    return pairs
}

if (typeof window !== "undefined") {
    window.RouteAssistantAirportMetaScraper = RouteAssistantAirportMetaScraper
    window._parseAirportMetaHtml            = parseAirportMetaHtml   // for tests
}
