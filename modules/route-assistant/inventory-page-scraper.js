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
 *        departures: [{date, time, flight, flightNumberId, totalSeats, sold, classBreakdown?}],
 *        flightNumbers: [{code, flightNumberId}],
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
    /**
     * L3 — Class B refactor: per-account scoping. Inventory rows
     * (RM tightness, sold/booked seats) belong to whichever airline
     * is logged in when the scrape ran.
     */
    static LEGACY_PREFIX = "routeAssistant:inventory:"
    static SCOPE_PREFIX  = "routeAssistant:inventory"

    /** L3 deprecated — preserve for any reader still doing key arithmetic. */
    static get CACHE_PREFIX() { return RouteAssistantInventoryPageScraper.LEGACY_PREFIX }

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

    static _key(hub, dest) {
        return acctKey(RouteAssistantInventoryPageScraper.SCOPE_PREFIX,
            RouteAssistantInventoryPageScraper._pairKey(hub, dest))
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantInventoryPageScraper.LEGACY_PREFIX
            + RouteAssistantInventoryPageScraper._pairKey(hub, dest)
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
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantInventoryPageScraper._pairKey(a, b))
            nsKeys.push(RouteAssistantInventoryPageScraper._key(a, b))
            lgKeys.push(RouteAssistantInventoryPageScraper._legacyKey(a, b))
        }
        const all = []
        for (const k of nsKeys) all.push(k)
        for (const k of lgKeys) if (all.indexOf(k) < 0) all.push(k)
        const out = await chrome.storage.local.get(all)
        const map = new Map()
        for (let i = 0; i < pairs.length; i++) {
            const ns = nsKeys[i]
            const lg = lgKeys[i]
            const rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
            if (!rec) continue
            if (RouteAssistantInventoryPageScraper._isExpired(rec, maxAgeDays)) continue
            map.set(pairKeys[i], rec)
        }
        return map
    }

    static async saveRecord(hub, dest, fields, source) {
        const key = RouteAssistantInventoryPageScraper._key(hub, dest)
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
                flightNumbers: parsed.flightNumbers,
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
    const empty = {classes: null, departures: [], flightNumbers: [], parserNotes: null}
    if (!html) return Object.assign({}, empty, {parserNotes: "no HTML returned"})

    let doc
    try {
        doc = new DOMParser().parseFromString(html, "text/html")
    } catch (e) {
        return Object.assign({}, empty, {parserNotes: "DOMParser failed"})
    }
    if (!doc || !doc.body) return Object.assign({}, empty, {parserNotes: "empty document"})

    const notes = []
    const summary = parseLoadSummaryTable(doc, notes)
    const listing = parseInventoryTable(doc, notes)
    let classes = parseClassesTable(doc, notes) || null
    let departures = parseDeparturesTable(doc, notes) || []
    let flightNumbers = parseInventoryFlightNumbers(doc, listing && listing.flightNumbers)

    if (!classes && listing && listing.classes) {
        classes = listing.classes
        removeParserNote(notes, "no per-class table matched")
    }
    classes = mergeInventoryClasses(classes, summary)
    if ((!departures || !departures.length) && listing && listing.departures && listing.departures.length) {
        departures = listing.departures
        removeParserNote(notes, "no per-departure table matched")
    }

    if (!classes && (!departures || !departures.length)) {
        return Object.assign({}, empty, {parserNotes: notes.length ? "tried: " + notes.join("; ") : "no inventory tables matched"})
    }

    return {
        classes:     classes,
        departures:  departures || [],
        flightNumbers: flightNumbers || [],
        parserNotes: notes.length ? notes.join("; ") : null
    }
}

function removeParserNote(notes, prefix) {
    if (!Array.isArray(notes) || !prefix) return
    for (let i = notes.length - 1; i >= 0; i--) {
        if (String(notes[i] || "").indexOf(prefix) === 0) {
            notes.splice(i, 1)
        }
    }
}

function parseInventoryTable(doc, notes) {
    const table = doc.querySelector("#inventory-table")
    if (!table) {
        notes && notes.push("no #inventory-table matched")
        return null
    }

    const classes = {Y: null, C: null, F: null, Cargo: null}
    const departures = new Map()
    const flightNumbers = new Map()
    let matched = 0

    const tbody = table.tBodies.length > 0 ? table.tBodies[0] : null
    if (!tbody) return null

    for (const tr of tbody.rows) {
        const cells = tr.cells
        if (!cells || cells.length < 8) continue

        const serviceInfo = extractInventoryServiceClass(cells)
        if (!serviceInfo) continue

        const cls = serviceInfo.classKey
        const serviceIdx = serviceInfo.index
        const capacity = parseIntSafe(cells[serviceIdx + 1] && cells[serviceIdx + 1].textContent)
        const booked = parseIntSafe(cells[serviceIdx + 2] && cells[serviceIdx + 2].textContent)
        const price = parsePriceSafe(cells[serviceIdx + 4] && cells[serviceIdx + 4].textContent, cls)
        const flight = textAt(cells, 1)
        const flightLink = cells[1] && cells[1].querySelector
            ? cells[1].querySelector("a[href*='/app/com/numbers/'], a[href*='app/com/numbers/'], a[href*='com/numbers/']")
            : null
        const flightNumberId = parseFlightNumberId(flightLink && flightLink.getAttribute("href"))
        const date = textAt(cells, 2)
        const time = textAt(cells, 3)

        if (capacity == null && booked == null) continue
        matched++
        addFlightNumber(flightNumbers, flight, flightNumberId)

        if (!classes[cls]) {
            classes[cls] = {totalSeats: 0, soldSeats: 0, avgFare: null}
        }
        if (capacity != null) classes[cls].totalSeats += capacity
        if (booked != null) classes[cls].soldSeats += booked
        if (price != null) classes[cls].avgFare = price

        const depKey = [flight, date, time].join("|")
        let dep = departures.get(depKey)
        if (!dep) {
            dep = {
                date: date || null,
                time: time || null,
                flight: flight || null,
                flightNumberId: flightNumberId != null ? flightNumberId : null,
                totalSeats: 0,
                sold: 0,
                classBreakdown: {}
            }
            departures.set(depKey, dep)
        }
        dep.classBreakdown[cls] = {
            totalSeats: capacity,
            sold: booked
        }
    }

    if (!matched) {
        notes && notes.push("inventory table present but no class rows matched")
        return null
    }

    for (const key in classes) {
        const slot = classes[key]
        if (!slot) continue
        if ((!isFinite(slot.totalSeats) || slot.totalSeats <= 0)
                && (!isFinite(slot.soldSeats) || slot.soldSeats <= 0)) {
            classes[key] = null
        }
    }

    const departuresOut = Array.from(departures.values()).map(dep => {
        let totalSeats = 0
        let sold = 0
        let sawPax = false
        for (const cls of ["Y", "C", "F"]) {
            const slot = dep.classBreakdown[cls]
            if (!slot) continue
            if (isFinite(slot.totalSeats) && slot.totalSeats > 0) {
                totalSeats += slot.totalSeats
                sawPax = true
            }
            if (isFinite(slot.sold)) sold += slot.sold
        }
        dep.totalSeats = sawPax ? totalSeats : null
        dep.sold = sawPax ? sold : null
        return dep
    })

    return {classes, departures: departuresOut, flightNumbers: Array.from(flightNumbers.values())}
}

function extractInventoryServiceClass(cells) {
    for (const idx of [5, 4]) {
        const cls = normalizeInventoryClass(textAt(cells, idx))
        if (cls) return {classKey: cls, index: idx}
    }
    return null
}

function normalizeInventoryClass(text) {
    const raw = String(text || "").trim()
    if (!raw) return null
    if (/^cargo$/i.test(raw)) return "Cargo"
    if (/^y$/i.test(raw)) return "Y"
    if (/^c$/i.test(raw)) return "C"
    if (/^f$/i.test(raw)) return "F"
    return null
}

function textAt(cells, idx) {
    return cells[idx] ? (cells[idx].textContent || "").trim() : ""
}

function parseInventoryFlightNumbers(doc, listingFlightNumbers) {
    const byKey = new Map()
    if (Array.isArray(listingFlightNumbers)) {
        for (const fn of listingFlightNumbers) {
            if (!fn) continue
            addFlightNumber(byKey, fn.code, fn.flightNumberId)
        }
    }

    const links = doc.querySelectorAll("a[href*='/app/com/numbers/'], a[href*='app/com/numbers/'], a[href*='com/numbers/']")
    for (const a of links) {
        const code = (a.textContent || "").trim()
        const id = parseFlightNumberId(a.getAttribute("href"))
        addFlightNumber(byKey, code, id)
    }

    return Array.from(byKey.values()).sort((a, b) => {
        if (a.flightNumberId != null && b.flightNumberId != null) return a.flightNumberId - b.flightNumberId
        return String(a.code || "").localeCompare(String(b.code || ""))
    })
}

function addFlightNumber(map, code, flightNumberId) {
    if (!map) return
    const cleanCode = String(code || "").replace(/\s+/g, " ").trim()
    const id = flightNumberId != null && isFinite(flightNumberId) ? Number(flightNumberId) : null
    if (!cleanCode && id == null) return
    const key = id != null ? "id:" + id : "code:" + cleanCode.toUpperCase()
    const prev = map.get(key) || {}
    map.set(key, {
        code: cleanCode || prev.code || null,
        flightNumberId: id != null ? id : (prev.flightNumberId != null ? prev.flightNumberId : null)
    })
}

function parseFlightNumberId(href) {
    const m = /\/app\/com\/numbers\/(\d+)/i.exec(String(href || ""))
        || /(?:^|\/)com\/numbers\/(\d+)/i.exec(String(href || ""))
    if (!m) return null
    const n = parseInt(m[1], 10)
    return isFinite(n) ? n : null
}

/**
 * Parse AS's "Load Summary (all flight numbers)" table. This table is
 * often more complete than the live listing because it summarizes every
 * flight number even when the listing-side filters only show one service
 * class. Each date cell is rendered as "sold / total (pct)"; summing those
 * cells gives route-level class load across all visible forward dates.
 */
function parseLoadSummaryTable(doc, notes) {
    const result = {Y: null, C: null, F: null, Cargo: null}
    let matched = 0
    const headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4,legend"))
    const summaryHeading = headings.find(h => /load\s+summary/i.test(h.textContent || ""))
    const roots = summaryHeading
        ? [summaryHeading.parentElement || doc.body]
        : Array.from(doc.querySelectorAll("table")).map(t => t.parentElement || t)

    for (const root of roots) {
        const tables = root.getElementsByTagName ? root.getElementsByTagName("table") : []
        for (const table of tables) {
            const rows = table.rows
            if (!rows) continue
            for (const tr of rows) {
                const cells = tr.cells
                if (!cells || cells.length < 2) continue
                const cls = normalizeInventoryClass(cells[0].textContent)
                if (!cls) continue
                let sold = 0, total = 0, saw = false
                for (let i = 1; i < cells.length; i++) {
                    const pair = parseSoldTotalCell(cells[i].textContent)
                    if (!pair) continue
                    sold += pair.sold
                    total += pair.total
                    saw = true
                }
                if (!saw || total <= 0) continue
                result[cls] = {
                    totalSeats: total,
                    soldSeats: sold,
                    avgFare: result[cls] && result[cls].avgFare != null ? result[cls].avgFare : null
                }
                matched++
            }
            if (matched) return result
        }
    }
    if (!matched) notes && notes.push("no load summary table matched")
    return null
}

function parseSoldTotalCell(text) {
    const raw = String(text || "").replace(/\s+/g, " ").trim()
    const m = /([0-9][0-9.,]*)\s*\/\s*([0-9][0-9.,]*)/.exec(raw)
    if (!m) return null
    const sold = parseIntSafe(m[1])
    const total = parseIntSafe(m[2])
    if (sold == null || total == null) return null
    return {sold, total}
}

function mergeInventoryClasses(primary, summary) {
    if (!summary) return primary || null
    const out = Object.assign({Y: null, C: null, F: null, Cargo: null}, primary || {})
    let saw = false
    for (const cls of ["Y", "C", "F", "Cargo"]) {
        const p = out[cls]
        const s = summary[cls]
        if (s) {
            const next = Object.assign({}, s)
            if (p && p.avgFare != null) next.avgFare = p.avgFare
            out[cls] = next
        }
        if (out[cls]) saw = true
    }
    return saw ? out : null
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

    const tables = doc.getElementsByTagName("table")
    let matched = 0
    for (const table of tables) {
        // Header column index map
        const head = table.tHead ? table.tHead.rows[0] : (table.rows.length > 0 ? table.rows[0] : null)
        const headers = head && head.cells ? Array.from(head.cells).map(c => (c.textContent || "").trim().toLowerCase()) : []
        if (!headers.length) continue
        const colIdx = (re) => headers.findIndex(h => re.test(h))
        const totalIdx = colIdx(/\b(total|capacity|seats|allotment)\b/)
        const soldIdx  = colIdx(/\b(sold|booked|reserved)\b/)
        const fareIdx  = colIdx(/\b(fare|avg|price|yield)\b/)
        if (totalIdx < 0 && soldIdx < 0) continue

        const rows = table.rows
        if (!rows) continue
        for (const tr of rows) {
            const cells = tr.cells
            if (!cells || cells.length < 2) continue
            const label = (cells[0].textContent || "").trim()
            for (const cls in KEYWORDS) {
                if (!KEYWORDS[cls].test(label)) continue
                if (result[cls]) break   // first match per class wins
                const slot = {totalSeats: null, soldSeats: null, avgFare: null}
                if (totalIdx >= 0 && cells[totalIdx]) slot.totalSeats = parseIntSafe(cells[totalIdx].textContent)
                if (soldIdx  >= 0 && cells[soldIdx])  slot.soldSeats  = parseIntSafe(cells[soldIdx].textContent)
                if (fareIdx  >= 0 && cells[fareIdx])  slot.avgFare    = parsePriceSafe(cells[fareIdx].textContent, cls)
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
    for (const table of doc.getElementsByTagName("table")) {
        const head = table.tHead ? table.tHead.rows[0] : (table.rows.length > 0 ? table.rows[0] : null)
        if (!head) continue
        const headers = head.cells ? Array.from(head.cells).map(c => (c.textContent || "").trim().toLowerCase()) : []
        const dateIdx = headers.findIndex(h => /\b(date|day|departure)\b/.test(h))
        const timeIdx = headers.findIndex(h => /\btime\b/.test(h))
        const totalIdx = headers.findIndex(h => /\b(total|capacity|seats)\b/.test(h))
        const soldIdx  = headers.findIndex(h => /\b(sold|booked)\b/.test(h))
        if (dateIdx < 0 && timeIdx < 0) continue
        if (totalIdx < 0 && soldIdx < 0) continue

        const rows = table.rows
        if (!rows) continue
        for (const tr of rows) {
            const cells = tr.cells
            if (!cells || cells.length < 2) continue
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

function parsePriceSafe(text, cls) {
    if (cls !== "Cargo") return parseIntSafe(text)
    if (!text) return null
    const raw = String(text).replace(/[^0-9.,\-]/g, "")
    if (!raw || raw === "-") return null
    const sign = raw.charAt(0) === "-" ? -1 : 1
    const body = sign < 0 ? raw.slice(1) : raw
    const sep = Math.max(body.lastIndexOf("."), body.lastIndexOf(","))
    if (sep >= 0) {
        const whole = body.slice(0, sep).replace(/\D/g, "")
        const frac = body.slice(sep + 1).replace(/\D/g, "")
        if (frac.length > 0 && frac.length <= 2) {
            const n = Number((whole || "0") + "." + frac)
            return isFinite(n) ? Math.round(sign * n * 100) / 100 : null
        }
    }
    const n = Number(body.replace(/\D/g, ""))
    return isFinite(n) ? sign * n : null
}
