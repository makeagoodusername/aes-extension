/**
 * Three-tier distance resolver for the Route Assistant.
 *
 * AS doesn't put route distance on flightsfrom's listing page, but it shows
 * up in three places — in priority order:
 *
 *   1. AS scheduling page header        — `/app/com/scheduling/<HUB><DEST>`
 *      renders e.g. "New York (JFK) – Atlanta (ATL) 1,221 km" in the
 *      page title bar. Authoritative since AS uses this same value for
 *      block-time / fuel calculations.
 *   2. Great-circle from AS airport coords. Fetch
 *      `/app/info/airports/<airportId>` once per airport, parse lat/lon,
 *      compute Haversine. Coords cache forever in DemandStore (extra
 *      `lat`/`lon` fields).
 *   3. flightsfrom detail page          — `https://www.flightsfrom.com/<HUB>-<DEST>`.
 *      Cross-origin but covered by host_permissions in manifest.
 *
 * Results are cached persistently keyed by the ordered pair, so reverse
 * routes share storage:
 *   routeAssistant:distance:<min>-<max>  → {distanceKm, source, resolvedAt}
 */
class RouteAssistantDistanceResolver {
    static CACHE_PREFIX = "routeAssistant:distance:"

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantDistanceResolver: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantDistanceResolver._normaliseMaxAge(opts && opts.maxAgeDays)
        this._sessionCache = new Map()
    }

    static _pairKey(a, b) {
        const x = String(a || "").toUpperCase()
        const y = String(b || "").toUpperCase()
        return (x < y ? x + "-" + y : y + "-" + x)
    }

    static _normaliseMaxAge(v) {
        const n = Number(v)
        return isFinite(n) && n > 0 ? n : null
    }

    /**
     * True when a cached record was resolved more than maxAgeDays ago.
     * Returns false (= keep) when maxAgeDays is null (never expire) or
     * the record predates the resolvedAt timestamp.
     */
    static _isExpired(record, maxAgeDays) {
        if (!maxAgeDays) return false
        if (!record || typeof record.resolvedAt !== "number") return false
        return Date.now() - record.resolvedAt > maxAgeDays * 86400000
    }

    /**
     * Bulk-load any cached distances for a list of pairs. Returns
     * Map<pairKey, {distanceKm, source}>. Used by the panel on mount to
     * paint distances instantly before the lazy fetch kicks in.
     *
     * Pass `{maxAgeDays: N}` to drop entries older than N days so the
     * panel treats them as missing and re-resolves them.
     */
    static async bulkLoadCache(pairs, opts) {
        const maxAgeDays = RouteAssistantDistanceResolver._normaliseMaxAge(opts && opts.maxAgeDays)
        const keys = pairs.map(([a, b]) => RouteAssistantDistanceResolver.CACHE_PREFIX + RouteAssistantDistanceResolver._pairKey(a, b))
        if (!keys.length) return new Map()
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec || typeof rec.distanceKm !== "number") continue
            if (RouteAssistantDistanceResolver._isExpired(rec, maxAgeDays)) continue
            const pair = k.substring(RouteAssistantDistanceResolver.CACHE_PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Resolve distance for one hub→dest pair. Returns
     * {distanceKm, source, resolvedAt} or null if every tier failed.
     */
    async resolve(hubIata, destIata) {
        const pair = RouteAssistantDistanceResolver._pairKey(hubIata, destIata)
        if (this._sessionCache.has(pair)) return this._sessionCache.get(pair)

        const cached = await this._loadCache(pair)
        if (cached && typeof cached.distanceKm === "number") {
            this._sessionCache.set(pair, cached)
            return cached
        }

        let result = await this._tryAsScheduling(hubIata, destIata)
        if (!result) result = await this._tryAsCoords(hubIata, destIata)
        if (!result) result = await this._tryFlightsfromDetail(hubIata, destIata)

        if (result) {
            const stamped = Object.assign({resolvedAt: Date.now()}, result)
            await this._saveCache(pair, stamped)
            this._sessionCache.set(pair, stamped)
            return stamped
        }
        return null
    }

    async _loadCache(pair) {
        const key = RouteAssistantDistanceResolver.CACHE_PREFIX + pair
        const out = await chrome.storage.local.get([key])
        const rec = out[key] || null
        if (RouteAssistantDistanceResolver._isExpired(rec, this.maxAgeDays)) return null
        return rec
    }

    async _saveCache(pair, record) {
        const key = RouteAssistantDistanceResolver.CACHE_PREFIX + pair
        await chrome.storage.local.set({[key]: record})
    }

    // ---------- Tier 1: AS scheduling URL ----------

    async _tryAsScheduling(hub, dest) {
        const url = `https://${this.server}.airlinesim.aero/app/com/scheduling/${hub.toUpperCase()}${dest.toUpperCase()}`
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return null
            const html = await resp.text()
            const km = parseDistanceFromAsSchedulingHtml(html)
            if (km) {
                console.log(`[AES routeAssistant] distance ${hub}-${dest} = ${km} km via as-scheduling`)
                return {distanceKm: km, source: "as-scheduling"}
            }
        } catch (e) { /* ignore */ }
        return null
    }

    // ---------- Tier 2: AS coords + great-circle ----------

    async _tryAsCoords(hub, dest) {
        if (typeof RouteAssistantDemandStore === "undefined") return null
        const [a, b] = await Promise.all([
            this._airportCoord(hub),
            this._airportCoord(dest)
        ])
        if (!a || !b) return null
        const km = greatCircleKm(a.lat, a.lon, b.lat, b.lon)
        if (!km) return null
        console.log(`[AES routeAssistant] distance ${hub}-${dest} = ${km} km via as-coords`)
        return {distanceKm: km, source: "as-coords"}
    }

    /**
     * Returns {lat, lon} for one airport. Reads cached coords from
     * DemandStore if present; otherwise fetches the AS airport page,
     * parses, and writes the coords back into the existing DemandStore
     * record so subsequent calls are free.
     */
    async _airportCoord(iata) {
        const demand = await RouteAssistantDemandStore.get(iata, {includeStale: true})
        if (demand && typeof demand.lat === "number" && typeof demand.lon === "number") {
            return {lat: demand.lat, lon: demand.lon}
        }
        if (!demand || !demand.airportId) return null

        const url = `https://${this.server}.airlinesim.aero/app/info/airports/${encodeURIComponent(demand.airportId)}`
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return null
            const html = await resp.text()
            const coords = parseCoordsFromAirportPage(html)
            if (coords) {
                await RouteAssistantDemandStore.save(Object.assign({}, demand, coords))
                return coords
            }
        } catch (e) { /* ignore */ }
        return null
    }

    // ---------- Tier 3: flightsfrom detail page ----------

    async _tryFlightsfromDetail(hub, dest) {
        const url = `https://www.flightsfrom.com/${hub.toUpperCase()}-${dest.toUpperCase()}`
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) return null
            const html = await resp.text()
            const km = parseDistanceFromFfDetail(html)
            if (km) {
                console.log(`[AES routeAssistant] distance ${hub}-${dest} = ${km} km via ff-detail`)
                return {distanceKm: km, source: "ff-detail"}
            }
        } catch (e) { /* ignore */ }
        return null
    }
}

// ---------- Parsers ----------

/**
 * AS scheduling page typically renders the title as
 *   "New York (JFK) – Atlanta (ATL) 1,221 km"
 * inside an <h1> / <h2> / page-header element. We scan likely heading
 * elements first; if nothing matches we fall back to the first km value
 * on the page.
 */
function parseDistanceFromAsSchedulingHtml(html) {
    if (!html) return null
    const doc = new DOMParser().parseFromString(html, "text/html")

    // Prefer headings and page-title containers.
    const candidates = doc.querySelectorAll("h1, h2, h3, .as-page-title, header, [class*='heading'], [class*='title']")
    for (const el of candidates) {
        const km = extractKmNumber(el.textContent || "")
        if (km !== null) return km
    }

    // Fallback: any text node on the page. AS scheduling pages have very
    // few "km" appearances besides the route distance, so this is safe.
    const km = extractKmNumber(doc.body ? doc.body.textContent : html)
    return km
}

/**
 * Extract a sane km number from `(\d{1,3}(?:,\d{3})*)\s*km` style text.
 * Returns null if no plausible match (1–25,000 km range).
 */
function extractKmNumber(text) {
    if (!text) return null
    const m = /(\d{1,3}(?:[,\.\s]\d{3})*|\d+)\s*km\b/i.exec(text)
    if (!m) return null
    const cleaned = m[1].replace(/[,\s\.]/g, "")
    const n = parseInt(cleaned, 10)
    if (!isFinite(n) || n <= 0 || n > 25000) return null
    return n
}

/**
 * AS airport pages: try schema.org meta tags, then a Latitude/Longitude
 * row in any table, then a free-text "lat,lon" pair.
 */
function parseCoordsFromAirportPage(html) {
    if (!html) return null
    const doc = new DOMParser().parseFromString(html, "text/html")

    // Strategy 1: schema.org
    const latEl = doc.querySelector("[itemprop='latitude']")
    const lonEl = doc.querySelector("[itemprop='longitude']")
    if (latEl && lonEl) {
        const lat = parseFloat(latEl.getAttribute("content") || latEl.textContent || "")
        const lon = parseFloat(lonEl.getAttribute("content") || lonEl.textContent || "")
        if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            return {lat: lat, lon: lon}
        }
    }

    // Strategy 2: table rows labeled Latitude/Longitude.
    let lat = null, lon = null
    for (const tr of doc.querySelectorAll("tr")) {
        const cells = tr.querySelectorAll("th, td")
        if (cells.length < 2) continue
        const label = (cells[0].textContent || "").toLowerCase()
        const val   = (cells[cells.length - 1].textContent || "").trim()
        if (lat === null && /\blatitude\b/.test(label))  lat = parseCoordValue(val, "lat")
        if (lon === null && /\blongitude\b/.test(label)) lon = parseCoordValue(val, "lon")
    }
    if (lat !== null && lon !== null) return {lat: lat, lon: lon}

    // Strategy 3: free-text "40.6413° N 73.7781° W" or "40.64,-73.78"
    const text = doc.body ? doc.body.textContent : ""
    const dms = /(-?\d+(?:\.\d+)?)\s*°?\s*([NS])\b[^0-9-]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])\b/i.exec(text)
    if (dms) {
        const a = Math.abs(parseFloat(dms[1])) * (dms[2].toUpperCase() === "S" ? -1 : 1)
        const b = Math.abs(parseFloat(dms[3])) * (dms[4].toUpperCase() === "W" ? -1 : 1)
        if (isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) return {lat: a, lon: b}
    }
    const csv = /(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)/.exec(text)
    if (csv) {
        const a = parseFloat(csv[1])
        const b = parseFloat(csv[2])
        if (isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) return {lat: a, lon: b}
    }

    return null
}

function parseCoordValue(text, axis) {
    if (!text) return null
    const m = /(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW]?)/i.exec(text)
    if (!m) return null
    let v = parseFloat(m[1])
    const dir = (m[2] || "").toUpperCase()
    if (dir === "S" || dir === "W") v = -Math.abs(v)
    if (dir === "N" || dir === "E") v =  Math.abs(v)
    if (!isFinite(v)) return null
    if (axis === "lat" && Math.abs(v) > 90)  return null
    if (axis === "lon" && Math.abs(v) > 180) return null
    return v
}

function parseDistanceFromFfDetail(html) {
    if (!html) return null
    const doc = new DOMParser().parseFromString(html, "text/html")
    // flightsfrom usually renders a "Distance" label near the top of the
    // detail page. Look for a class containing "distance" first.
    const distEl = doc.querySelector("[class*='distance' i]")
    if (distEl) {
        const km = extractKmNumber(distEl.textContent || "")
        if (km !== null) return km
    }
    // Fallback: first km-shaped value on the page.
    return extractKmNumber(doc.body ? doc.body.textContent : html)
}

/**
 * Great-circle distance in km between two lat/lon pairs (degrees).
 */
function greatCircleKm(lat1, lon1, lat2, lon2) {
    if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) return null
    const R = 6371
    const toRad = d => d * Math.PI / 180
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return Math.round(R * c)
}

if (typeof window !== "undefined") {
    window.RouteAssistantDistanceResolver = RouteAssistantDistanceResolver
}
