"use strict"

/**
 * Inventory-page scraper for the Route Assistant — Letter K.
 *
 * Reads `/app/com/inventory/<HUB><DEST>` to capture data the Markets
 * page doesn't expose: per-class revenue-management buckets (booking
 * class allocations + remaining seats), forward availability for the
 * next N departures, and recent booking velocity when AS surfaces it.
 *
 * Storage (directional pair key):
 *   routeAssistant:inventory:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt, source: "fetch"|"live",
 *        classes: {Y, C, F, Cargo: {totalSeats, soldSeats, avgFare?}},
 *        departures: [{date, time, totalSeats, sold, classBreakdown?}],
 *        parserNotes?}
 *
 * Multi-strategy parser — AS markup may shift, so each section is
 * independently scoped. When a strategy fails the record stores
 * `parserNotes` describing what was tried so the panel can surface
 * the gap without claiming "no inventory".
 *
 * ORS-coordination note: this scraper hits the inventory page, not
 * `/app/info/ors`. Safe to run concurrently with an active ORS bulk
 * sync (different endpoint), though shared AS rate-limits suggest
 * keeping concurrency conservative.
 */
class RouteAssistantInventoryPageScraper {
    static CACHE_PREFIX = "routeAssistant:inventory:"

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantInventoryPageScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantInventoryPageScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        this._sessionCache = new Map()
        // Circuit-breaker — same shape as ors-scraper. Halts after
        // `breakerThreshold` consecutive 429/503 responses; bulk caller
        // checks `isBreakerOpen()` and short-circuits.
        this._breakerFailures = 0
        this._breakerOpen     = false
        this._breakerOpenAt   = 0
        this.breakerThreshold = (opts && opts.breakerThreshold) || 3
        this.breakerCooldownMs = (opts && opts.breakerCooldownMs) || 10 * 60 * 1000
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

    static async bulkLoadCache(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const maxAgeDays = RouteAssistantInventoryPageScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const keys = pairs.map(p => {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            return RouteAssistantInventoryPageScraper.CACHE_PREFIX + RouteAssistantInventoryPageScraper._pairKey(a, b)
        })
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            if (RouteAssistantInventoryPageScraper._isExpired(rec, maxAgeDays)) continue
            const pair = k.substring(RouteAssistantInventoryPageScraper.CACHE_PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    static async saveRecord(hub, dest, fields, source) {
        const pair = RouteAssistantInventoryPageScraper._pairKey(hub, dest)
        const key  = RouteAssistantInventoryPageScraper.CACHE_PREFIX + pair
        const rec = Object.assign({
            hub:       String(hub || "").toUpperCase(),
            dest:      String(dest || "").toUpperCase(),
            scrapedAt: Date.now(),
            source:    source || "fetch"
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    isBreakerOpen() {
        if (!this._breakerOpen) return false
        if (Date.now() - this._breakerOpenAt > this.breakerCooldownMs) {
            this._breakerOpen = false
            this._breakerFailures = 0
            return false
        }
        return true
    }

    /**
     * Fetch + parse one route. Idempotent inside a session via
     * `_sessionCache`; circuit-breaker on cumulative 429/503.
     * Returns the cached record or null on permanent failure.
     */
    async scrape(hubIata, destIata) {
        const pair = RouteAssistantInventoryPageScraper._pairKey(hubIata, destIata)
        if (this._sessionCache.has(pair)) return this._sessionCache.get(pair)
        if (this.isBreakerOpen()) return null

        const url = "https://" + this.server + ".airlinesim.aero/app/com/inventory/"
            + String(hubIata).toUpperCase() + String(destIata).toUpperCase()
        let html = null
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (resp.status === 429 || resp.status === 503) {
                this._breakerFailures++
                if (this._breakerFailures >= this.breakerThreshold) {
                    this._breakerOpen   = true
                    this._breakerOpenAt = Date.now()
                    console.warn("[AES inventoryScraper] circuit-breaker tripped after " + this._breakerFailures + " consecutive " + resp.status)
                }
                return null
            }
            if (!resp.ok) {
                console.warn("[AES inventoryScraper] HTTP " + resp.status + " for " + pair)
                return null
            }
            this._breakerFailures = 0   // any successful response resets the counter
            html = await resp.text()
        } catch (e) {
            console.warn("[AES inventoryScraper] fetch failed for " + pair, e)
            return null
        }

        const parsed = parseInventoryHtml(html)
        const record = await RouteAssistantInventoryPageScraper.saveRecord(
            hubIata, destIata,
            {
                classes:     parsed.classes,
                departures:  parsed.departures,
                parserNotes: parsed.parserNotes
            },
            "fetch"
        )
        this._sessionCache.set(pair, record)
        return record
    }

    /**
     * Concurrent bulk scrape. Same orchestration shape as the carriers
     * + markets scrapers so the panel's status UI can be reused. Halts
     * (returns early) when the breaker opens.
     */
    async bulkScrape(pairs, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(8, opts.concurrency || 3))
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
                if (this.isBreakerOpen()) {
                    // Short-circuit remaining work — leave their slots null
                    // so the caller can detect the early exit.
                    while (cursor < total) {
                        results[cursor++] = null
                        done++
                    }
                    if (onProgress) {
                        try { onProgress(done, total) } catch (e) { /* noop */ }
                    }
                    resolve(results)
                    return
                }
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
                    this.scrape(hub, dest)
                        .then(finish)
                        .catch(err => {
                            console.warn("[AES inventoryScraper] scrape error:", err)
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
 * Parse the inventory page for per-class buckets and forward
 * availability. Multi-strategy:
 *
 *   A. Per-class summary table — looks for rows containing class
 *      keywords (Economy/Business/First/Cargo) with seat columns.
 *   B. Per-departure availability — walks the schedule table and
 *      reads totalSeats + sold per row when columns are present.
 *   C. Fallback — if neither A nor B match, return parserNotes so the
 *      caller knows the page returned skeleton/SPA HTML and the
 *      record can be written empty (useful for "we tried, no data
 *      yet" UI states).
 */
function parseInventoryHtml(html) {
    const empty = {classes: null, departures: [], parserNotes: null}
    if (!html) return Object.assign({}, empty, {parserNotes: "no HTML returned"})

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        return Object.assign({}, empty, {parserNotes: "DOMParser failed"})
    }
    if (!doc || !doc.body) return Object.assign({}, empty, {parserNotes: "empty document"})

    const notes = []
    const classes = parseClassesTable(doc, notes)
    const departures = parseDeparturesTable(doc, notes)

    if (!classes && (!departures || !departures.length)) {
        return Object.assign({}, empty, {parserNotes: notes.length ? "tried: " + notes.join("; ") : "no inventory tables matched"})
    }

    return {
        classes:     classes,
        departures:  departures || [],
        parserNotes: notes.length ? notes.join("; ") : null
    }
}

/**
 * Strategy A — per-class summary. Walk every table on the page,
 * inspect each row's first cell for a class keyword, then pick the
 * "total seats" / "sold seats" / "avg fare" columns by header text.
 */
function parseClassesTable(doc, notes) {
    const KEYWORDS = {
        Y:     /\b(economy|coach|y[-\s]?class)\b/i,
        C:     /\b(business|c[-\s]?class)\b/i,
        F:     /\b(first|f[-\s]?class)\b/i,
        Cargo: /\bcargo\b/i
    }
    const result = {Y: null, C: null, F: null, Cargo: null}

    const tables = doc.querySelectorAll("table")
    let matched = 0
    for (const table of tables) {
        // Header column index map
        const head = table.querySelector("thead, tr:first-child")
        const headers = head ? Array.from(head.querySelectorAll("th, td")).map(c => (c.textContent || "").trim().toLowerCase()) : []
        if (!headers.length) continue
        const colIdx = (re) => headers.findIndex(h => re.test(h))
        const totalIdx = colIdx(/\b(total|capacity|seats|allotment)\b/)
        const soldIdx  = colIdx(/\b(sold|booked|reserved)\b/)
        const fareIdx  = colIdx(/\b(fare|avg|price|yield)\b/)
        if (totalIdx < 0 && soldIdx < 0) continue

        for (const tr of table.querySelectorAll("tbody tr, tr")) {
            const cells = tr.querySelectorAll("td, th")
            if (cells.length < 2) continue
            const label = (cells[0].textContent || "").trim()
            for (const cls in KEYWORDS) {
                if (!KEYWORDS[cls].test(label)) continue
                if (result[cls]) break   // first match per class wins
                const slot = {totalSeats: null, soldSeats: null, avgFare: null}
                if (totalIdx >= 0 && cells[totalIdx]) slot.totalSeats = parseIntSafe(cells[totalIdx].textContent)
                if (soldIdx  >= 0 && cells[soldIdx])  slot.soldSeats  = parseIntSafe(cells[soldIdx].textContent)
                if (fareIdx  >= 0 && cells[fareIdx])  slot.avgFare    = parseIntSafe(cells[fareIdx].textContent)
                if (slot.totalSeats != null || slot.soldSeats != null) {
                    result[cls] = slot
                    matched++
                }
                break
            }
        }
        if (matched > 0) break   // first table that yielded anything wins
    }

    if (!matched) {
        notes && notes.push("no per-class table matched (label keywords: economy/business/first/cargo)")
        return null
    }
    return result
}

/**
 * Strategy B — forward departure list. Pick a table with date/time
 * columns and per-row total/sold cells. Returns at most the first 30
 * matched rows so the cache stays small.
 */
function parseDeparturesTable(doc, notes) {
    const out = []
    for (const table of doc.querySelectorAll("table")) {
        const head = table.querySelector("thead, tr:first-child")
        if (!head) continue
        const headers = Array.from(head.querySelectorAll("th, td")).map(c => (c.textContent || "").trim().toLowerCase())
        const dateIdx = headers.findIndex(h => /\b(date|day|departure)\b/.test(h))
        const timeIdx = headers.findIndex(h => /\btime\b/.test(h))
        const totalIdx = headers.findIndex(h => /\b(total|capacity|seats)\b/.test(h))
        const soldIdx  = headers.findIndex(h => /\b(sold|booked)\b/.test(h))
        if (dateIdx < 0 && timeIdx < 0) continue
        if (totalIdx < 0 && soldIdx < 0) continue
        for (const tr of table.querySelectorAll("tbody tr, tr")) {
            const cells = tr.querySelectorAll("td, th")
            if (cells.length < 2) continue
            const date  = dateIdx  >= 0 && cells[dateIdx]  ? (cells[dateIdx].textContent  || "").trim() : null
            const time  = timeIdx  >= 0 && cells[timeIdx]  ? (cells[timeIdx].textContent  || "").trim() : null
            const total = totalIdx >= 0 && cells[totalIdx] ? parseIntSafe(cells[totalIdx].textContent) : null
            const sold  = soldIdx  >= 0 && cells[soldIdx]  ? parseIntSafe(cells[soldIdx].textContent)  : null
            if (!date && !time) continue
            if (total == null && sold == null) continue
            out.push({date: date, time: time, totalSeats: total, sold: sold})
            if (out.length >= 30) break
        }
        if (out.length) break
    }
    if (!out.length) notes && notes.push("no per-departure table matched")
    return out
}

/**
 * Parse a numeric cell from the inventory page. Tolerates thousand
 * separators (`,` or `.`) and an optional decimal portion — e.g.
 * `"1,234"` → 1234, `"$1,234.56"` → 1235 (rounded). Returns null when
 * no digit is present. Used for seat counts (always integer in AS) and
 * fare values (which may carry a decimal portion in some skin variants).
 */
function parseIntSafe(text) {
    if (!text) return null
    // Keep digits, dots, commas, and a leading sign. Strip currency
    // glyphs, whitespace, etc.
    const raw = String(text).replace(/[^0-9.,\-]/g, "")
    if (!raw) return null
    // Decide which separator is the decimal mark by looking at the LAST
    // separator in the string — that's the rightmost `.` or `,`. If the
    // remaining tail (after that mark) is 1-2 digits, it's a decimal;
    // otherwise it's another thousands separator.
    const lastDot   = raw.lastIndexOf(".")
    const lastComma = raw.lastIndexOf(",")
    const lastSep   = Math.max(lastDot, lastComma)
    let intPart, fracPart
    if (lastSep > 0 && /^[0-9]{1,2}$/.test(raw.slice(lastSep + 1))) {
        intPart  = raw.slice(0, lastSep).replace(/[.,]/g, "")
        fracPart = raw.slice(lastSep + 1)
    } else {
        intPart  = raw.replace(/[.,]/g, "")
        fracPart = ""
    }
    if (!intPart || intPart === "-") return null
    const n = fracPart
        ? Math.round(Number(intPart + "." + fracPart))
        : parseInt(intPart, 10)
    return isFinite(n) ? n : null
}
