/**
 * Fuel-price scraper for the Route Assistant.
 *
 * AS exposes the world fuel price on:
 *   /action/portal/index            (holding portal landing page — has a
 *                                    readable table beneath the chart)
 *   /action/holding/stockexchanges  (chart only)
 *
 * Two extraction strategies, in order:
 *
 * 1. **Table** (preferred). Beneath the chart, AS lists the last few weekly
 *    snapshots as plain text rows like:
 *        2026-04-14    44.24 ASc$/l
 *        2026-04-07    44.95 ASc$/l
 *    The unit is ASc$ per liter (1 AS$ = 100 ASc$). Reliable, absolute,
 *    survives chart-rendering changes.
 *
 * 2. **SVG chart fallback**. When the table isn't present (e.g. on the
 *    stockexchanges page), parse `path.area`'s rightmost data anchor and
 *    convert via `g.y.axis g.tick` labels. Returns a chart-scale index
 *    (typically 10–90), NOT an absolute unit. Usable for relative scaling
 *    only when the user calibrates against this same scale.
 *
 * Persisted as:
 *   routeAssistant:fuelPriceIndex → {
 *       value:     <number>,
 *       unit:      "ASc$/l" | "index",
 *       date:      "YYYY-MM-DD" | <year-fractional> | null,
 *       scrapedAt: <epoch-ms>,
 *       source:    "table" | "svg",
 *       sourceUrl: "https://...",
 *       history?:  [{date, value}, ...]   // last N entries from table
 *   }
 */
class RouteAssistantFuelPriceScraper {
    static CACHE_KEY = "routeAssistant:fuelPriceIndex"
    static URLS = ["/action/portal/index", "/action/holding/stockexchanges"]
    static MAX_AGE_FRESH_MS = 6 * 3600e3   // re-scrape if older than 6h

    /**
     * Lazy single-key TTL wrapper. wrapSingleKey ships in
     * modules/_shared/ttl-cache.js (slice-1 foundation); we resolve it on
     * first access so this file works the same when loaded into a context
     * that doesn't include the shared block (defensive, since fuel-price
     * scraping is also called from RA settings flows).
     */
    static _cache() {
        if (!RouteAssistantFuelPriceScraper._cacheInst) {
            if (typeof wrapSingleKey === "undefined") return null
            RouteAssistantFuelPriceScraper._cacheInst = wrapSingleKey(
                RouteAssistantFuelPriceScraper.CACHE_KEY,
                RouteAssistantFuelPriceScraper.MAX_AGE_FRESH_MS,
                {freshnessField: "scrapedAt"}
            )
        }
        return RouteAssistantFuelPriceScraper._cacheInst
    }

    constructor(server) {
        if (!server) throw new Error("RouteAssistantFuelPriceScraper: server required")
        this.server = server
    }

    /**
     * Try each candidate URL. For each, prefer the readable table; fall back
     * to SVG parsing. Returns the stored record, or null if every page failed.
     *
     * On success, emits `data:route-assistant:fuel-price:updated` with the
     * fresh `{value, unit}` so cross-surface consumers (scanner panel,
     * dashboard tiles) re-decorate without polling. The scalar carry is the
     * documented exception to the minimal-payload rule (see
     * modules/_shared/data-bus-topics.js).
     */
    async scrape() {
        for (const path of RouteAssistantFuelPriceScraper.URLS) {
            const url = `https://${this.server}.airlinesim.aero${path}`
            try {
                const resp = await fetch(url, {credentials: "include"})
                if (!resp.ok) continue
                const html = await resp.text()
                const doc = new DOMParser().parseFromString(html, "text/html")

                const table = parseFuelTable(doc)
                if (table) {
                    const record = {
                        value:     table.latest.value,
                        unit:      "ASc$/l",
                        date:      table.latest.date,
                        scrapedAt: Date.now(),
                        source:    "table",
                        sourceUrl: url,
                        history:   table.history
                    }
                    await RouteAssistantFuelPriceScraper._write(record)
                    console.log(`[AES routeAssistant] fuel price ${record.value.toFixed(2)} ASc$/l (${record.date}) via ${url}`)
                    return record
                }

                const svg = parseFuelSvg(doc)
                if (svg) {
                    const record = {
                        value:     svg.value,
                        unit:      "index",
                        date:      svg.date,
                        scrapedAt: Date.now(),
                        source:    "svg",
                        sourceUrl: url
                    }
                    await RouteAssistantFuelPriceScraper._write(record)
                    console.log(`[AES routeAssistant] fuel index ${record.value.toFixed(2)} (chart-scale) via ${url}`)
                    return record
                }
            } catch (e) { /* try next URL */ }
        }
        return null
    }

    static async _write(record) {
        const cache = RouteAssistantFuelPriceScraper._cache()
        if (cache) await cache.set(record)
        else await chrome.storage.local.set({[RouteAssistantFuelPriceScraper.CACHE_KEY]: record})
        if (typeof AesDataBus !== "undefined") {
            // publish() caches the scalar so cross-module consumers
            // (auto-driver, scanner, RA panel) can read AesDataBus.last(...)
            // synchronously without a storage round-trip.
            AesDataBus.publish("data:route-assistant:fuel-price:updated", {
                value:     record.value,
                unit:      record.unit,
                scrapedAt: record.scrapedAt
            })
        }
    }

    static async getCached() {
        const cache = RouteAssistantFuelPriceScraper._cache()
        if (cache) return cache.getStale()
        const out = await chrome.storage.local.get([RouteAssistantFuelPriceScraper.CACHE_KEY])
        return out[RouteAssistantFuelPriceScraper.CACHE_KEY] || null
    }

    /**
     * Returns the cached record only if it's still inside MAX_AGE_FRESH_MS.
     * Use this from cross-module consumers (e.g. the scanner panel) that
     * want a fresh value or null — saves them the `isStale` check and the
     * raw `chrome.storage.local.get` reach.
     */
    static async getCachedFresh() {
        const cache = RouteAssistantFuelPriceScraper._cache()
        if (cache) return cache.get()
        const rec = await RouteAssistantFuelPriceScraper.getCached()
        return rec && !RouteAssistantFuelPriceScraper.isStale(rec) ? rec : null
    }

    static isStale(record) {
        if (!record || typeof record.scrapedAt !== "number") return true
        return Date.now() - record.scrapedAt > RouteAssistantFuelPriceScraper.MAX_AGE_FRESH_MS
    }
}

// ---------- Table parsing (primary) ----------

/**
 * Walk text nodes for `<value> ASc$/l` mentions. For each, walk up the DOM
 * up to 5 levels to find a sibling YYYY-MM-DD date. Pair them, sort by date
 * descending, return the latest plus a small history window.
 *
 * Tolerates any wrapping markup (table, list, definition list) — the only
 * assumption is that the date and value share an ancestor within 5 levels.
 */
function parseFuelTable(doc) {
    if (!doc || !doc.body) return null
    const candidates = []
    const seen = new Set()

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
        const text = node.textContent || ""
        if (text.indexOf("ASc$/l") < 0) continue
        const m = /(\d+(?:\.\d+)?)\s*ASc\$\/l/.exec(text)
        if (!m) continue
        const value = parseFloat(m[1])
        if (!isFinite(value) || value <= 0 || value > 1e6) continue

        let container = node.parentElement
        let date = null
        for (let depth = 0; depth < 5 && container && !date; depth++) {
            const text = container.textContent || ""
            const dm = /(\d{4}-\d{2}-\d{2})/.exec(text)
            if (dm) date = dm[1]
            container = container.parentElement
        }

        const key = (date || "?") + ":" + value
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({date: date, value: value})
    }
    if (!candidates.length) return null

    candidates.sort((a, b) => {
        if (a.date && b.date) return b.date.localeCompare(a.date)
        if (a.date) return -1
        if (b.date) return 1
        return 0
    })
    return {
        latest:  candidates[0],
        history: candidates.slice(0, 10)
    }
}

// ---------- SVG parsing (fallback) ----------

function parseFuelSvg(doc) {
    const container = doc.querySelector("#fuel-prices-container")
    if (!container) return null
    const focus = container.querySelector("g.chart.focus") || container.querySelector("svg")
    if (!focus) return null

    const yScale = readAxisScale(focus, "y")
    if (!yScale) return null
    const xScale = readAxisScale(focus, "x")

    const path = focus.querySelector("path.area") || container.querySelector("path.area")
    if (!path) return null
    const points = parsePathDataAnchors(path.getAttribute("d") || "")
    if (!points.length) return null

    let latest = null
    for (const p of points) {
        if (!latest || p.x > latest.x) latest = p
    }
    if (!latest) return null
    const value = yScale.toValue(latest.y)
    if (!isFinite(value)) return null

    return {value: value, date: xScale ? xScale.toValue(latest.x) : null}
}

/**
 * Build a pixel→value linear scale from `g.{x|y}.axis g.tick` elements.
 */
function readAxisScale(focus, axis) {
    const ticks = []
    const sel = `g.${axis}.axis g.tick`
    for (const tick of focus.querySelectorAll(sel)) {
        const t = tick.getAttribute("transform") || ""
        const m = /translate\(\s*([\-\d.]+)\s*[,\s]\s*([\-\d.]+)/.exec(t)
        if (!m) continue
        const pixel = parseFloat(axis === "x" ? m[1] : m[2])
        const text = (tick.querySelector("text") || {}).textContent || ""
        const value = parseFloat(text)
        if (isFinite(pixel) && isFinite(value)) ticks.push({pixel: pixel, value: value})
    }
    if (ticks.length < 2) return null
    ticks.sort((a, b) => a.pixel - b.pixel)
    const a = ticks[0]
    const b = ticks[ticks.length - 1]
    if (a.pixel === b.pixel) return null
    const slope = (b.value - a.value) / (b.pixel - a.pixel)
    return {toValue: (pixel) => a.value + slope * (pixel - a.pixel)}
}

/**
 * Extract data-point anchors from the area path's `d` attribute. d3's area
 * generator emits M<start> C<...> S<...> ... L<rightX>,<bottomY> <bottom
 * edge tracing> Z. Data anchors live before the first `L`.
 */
function parsePathDataAnchors(d) {
    if (!d) return []
    const lIdx = d.indexOf("L")
    const segment = lIdx >= 0 ? d.substring(0, lIdx) : d

    const points = []
    const re = /([CSM])([^CSLMZ]*)/g
    let m
    while ((m = re.exec(segment)) !== null) {
        const cmd = m[1]
        const args = m[2].split(/[,\s]+/).filter(Boolean).map(Number)
        if (cmd === "M") {
            if (args.length >= 2 && isFinite(args[0]) && isFinite(args[1])) {
                points.push({x: args[0], y: args[1]})
            }
        } else if (cmd === "C") {
            for (let i = 0; i + 6 <= args.length; i += 6) {
                points.push({x: args[i + 4], y: args[i + 5]})
            }
        } else if (cmd === "S") {
            for (let i = 0; i + 4 <= args.length; i += 4) {
                points.push({x: args[i + 2], y: args[i + 3]})
            }
        }
    }
    return points
}
