"use strict"

/**
 * ORS scraper for the Route Assistant.
 *
 * Submits the AS Online Reservation System form at `/app/info/ors` (the same
 * search engine simulated passengers use) and parses the connection-list
 * result page, computing the user's flight rank under several flavors.
 *
 * Why a separate scraper from the markets page: ORS is the actual sort the
 * AS demand model runs against. Top-ranked connections fill first; ranks 8+
 * are scraps. The markets page tells you who else flies the route, but only
 * ORS tells you whether your flight WINS the booking.
 *
 * Cache (1 directional key per route — bigger blob, ~10KB):
 *   routeAssistant:ors:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt,
 *        params: {payload, departureH, arrivalH, useGround},
 *        pricingIndex: {byClass: {Y|C|F|Cargo: {...}}},  // derived from ORS result list
 *        totalConnections, ourFlightIds, ourCarrierPrefixes,
 *        rankAny, rankFirstLegOurs, rankAllOurs, rankNonstop, rankBookable,
 *        ourTopRating, ourBestNonstopRating, topCompetitorRating, ratingGapToTop,
 *        connections: [{idx, rating, totalDuration, totalPrice, bookable,
 *          legs: [{flightCode, flightId, typeCode, typeId, rating, price,
 *                  serviceClass, status, isOurs, isGround}]}],
 *        context?: {                              // optional — populated by
 *          serviceProfile?, priceSnapshot?,       // orchestrator's contextBuilder.
 *          aircraft?,       overrides?,           // Used by the snapshot store
 *          serviceConfig?,  capturedAt           // for (config → ORS rank)
 *        }}                                       // calibration time-series.
 *
 * Pair key is **directional** — ORS rank differs by direction (different
 * competitors, different alternatives via different hubs).
 *
 * Wicket form mechanics:
 *   1. GET /app/info/ors → parse the wicket session ID + form action URL
 *   2. POST the form (application/x-www-form-urlencoded, credentials:include)
 *      with origin/destination as full airport names from DemandStore
 *   3. Parse result page (page 1)
 *   4. Walk pagination — fetch pages 2..N from .navigation > a.next
 *   5. computeRanks() against our flight-number set + carrier prefixes
 *
 * Per-route GET → POST handshake (no shared session across batch). Wicket
 * page-version IDs increment per interaction; reusing a stale session
 * returns a `PageExpiredException` page that parses as zero results
 * (silent corruption). Doubling request count is acceptable at concurrency=2
 * / stagger=1500ms.
 *
 * Circuit breaker: 3 consecutive 429/503/timeout errors halt the bulk run,
 * persist `circuitBreakerTrippedAt` in settings, and disable the bulk button
 * for 10 min.
 */
class RouteAssistantOrsScraper {
    /**
     * L3 — Class B refactor: namespaced via `acctKey()`. ORS rank +
     * connection lists depend on which airline is "ours" (the rank
     * column reports our position in the leaderboard), so per-account
     * scoping prevents one account's vantage point leaking into
     * another's projections.
     */
    static LEGACY_PREFIX = "routeAssistant:ors:"
    static SCOPE_PREFIX  = "routeAssistant:ors"

    static PAYLOAD_RADIO = {
        ECONOMY:  "radio0",
        BUSINESS: "radio1",
        FIRST:    "radio2",
        CARGO:    "radio3"
    }

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantOrsScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantOrsScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        this._sessionCache = new Map()
        this._consecutiveErrors = 0
        this._haltedReason = null
        this.circuitBreakerCooldownMs = (opts && opts.circuitBreakerCooldownMs) || 600000   // 10 min
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _normaliseClassesToScrape(params) {
        params = params || {}
        const raw = (Array.isArray(params.classesToScrape) && params.classesToScrape.length)
            ? params.classesToScrape
            : (params.payload ? [params.payload] : ["ECONOMY", "BUSINESS", "FIRST", "CARGO"])
        const valid = {ECONOMY: 1, BUSINESS: 1, FIRST: 1, CARGO: 1}
        const seen = new Set()
        const out = []
        for (const c of raw) {
            const key = String(c || "").toUpperCase()
            if (!valid[key] || seen.has(key)) continue
            seen.add(key)
            out.push(key)
        }
        return out.length ? out : ["ECONOMY", "BUSINESS", "FIRST", "CARGO"]
    }

    static _scrapeMemoKey(hub, dest, params) {
        params = params || {}
        const fnOverride = params.ourFlightNumbersOverride
        const fns = []
        if (fnOverride instanceof Set) {
            for (const fn of fnOverride) if (fn) fns.push(String(fn).trim().toUpperCase())
        } else if (Array.isArray(fnOverride)) {
            for (const fn of fnOverride) if (fn) fns.push(String(fn).trim().toUpperCase())
        }
        fns.sort()
        return JSON.stringify({
            pair:       RouteAssistantOrsScraper._pairKey(hub, dest),
            classes:    RouteAssistantOrsScraper._normaliseClassesToScrape(params),
            departureH: params.departureH != null ? params.departureH : 0,
            arrivalH:   params.arrivalH   != null ? params.arrivalH   : 72,
            useGround:  params.useGround !== false,
            carrier:    params.carrierOverride || null,
            pageStaggerMs: params.pageStaggerMs != null ? params.pageStaggerMs : 750,
            fnOverride: fns
        })
    }

    static _sleep(ms) {
        const n = Number(ms)
        if (!isFinite(n) || n <= 0) return Promise.resolve()
        return new Promise(resolve => setTimeout(resolve, n))
    }

    static async _fetchWithRateLimitRetry(url, options, retryMs) {
        let resp = await fetch(url, options || {})
        if (!resp.ok && (resp.status === 429 || resp.status === 503)
                && Number(retryMs) > 0) {
            await RouteAssistantOrsScraper._sleep(retryMs)
            resp = await fetch(url, options || {})
        }
        return resp
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantOrsScraper.SCOPE_PREFIX,
            RouteAssistantOrsScraper._pairKey(hub, dest))
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantOrsScraper.LEGACY_PREFIX
            + RouteAssistantOrsScraper._pairKey(hub, dest)
    }

    /** L3 deprecated — preserve for any reader still doing key arithmetic. */
    static get CACHE_PREFIX() { return RouteAssistantOrsScraper.LEGACY_PREFIX }

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
     * Bulk-load cached records for a list of {hub, dest} pairs.
     * Returns Map<pairKey, record>. Records are lazy-migrated to the
     * `byClass` shape on read so legacy single-class caches keep working.
     */
    static async bulkLoadCache(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const maxAgeDays = RouteAssistantOrsScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantOrsScraper._pairKey(a, b))
            nsKeys.push(RouteAssistantOrsScraper._key(a, b))
            lgKeys.push(RouteAssistantOrsScraper._legacyKey(a, b))
        }
        const all = []
        for (const k of nsKeys) all.push(k)
        for (const k of lgKeys) if (all.indexOf(k) < 0) all.push(k)
        const out = await chrome.storage.local.get(all)
        const map = new Map()
        for (let i = 0; i < pairs.length; i++) {
            const ns = nsKeys[i]
            const lg = lgKeys[i]
            let rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
            if (!rec) continue
            if (RouteAssistantOrsScraper._isExpired(rec, maxAgeDays)) continue
            rec = RouteAssistantOrsScraper._migrateOrsRecord(rec)
            map.set(pairKeys[i], rec)
        }
        return map
    }

    /**
     * Lazy-migrate a legacy single-class ORS record to the new byClass
     * shape. Pure — does NOT write back to storage. The next scrape()
     * for this route will overwrite the legacy record with the new shape.
     *
     * Legacy: {…, params: {payload, ...}, totalConnections, rankAny, …, connections}
     * New:    {…, params: {departureH, arrivalH, useGround},
     *          byClass: {<payload>: {totalConnections, rankAny, …, connections}},
     *          classesScraped: [<payload>]}
     */
    static _migrateOrsRecord(rec) {
        if (!rec || typeof rec !== "object") return rec
        if (rec.byClass && typeof rec.byClass === "object") return rec
        // Pre-byClass record. Wrap whatever single-class data exists into
        // a byClass map keyed by the original payload.
        const cls = (rec.params && rec.params.payload) || "ECONOMY"
        const classRecord = {
            scrapedAt:            rec.scrapedAt,
            totalConnections:     rec.totalConnections != null ? rec.totalConnections : 0,
            rankAny:              rec.rankAny           || null,
            rankFirstLegOurs:     rec.rankFirstLegOurs  || null,
            rankAllOurs:          rec.rankAllOurs       || null,
            rankNonstop:          rec.rankNonstop       || null,
            rankBookable:         rec.rankBookable      || null,
            ourTopRating:         rec.ourTopRating         != null ? rec.ourTopRating         : null,
            ourBestNonstopRating: rec.ourBestNonstopRating != null ? rec.ourBestNonstopRating : null,
            topCompetitorRating:  rec.topCompetitorRating  != null ? rec.topCompetitorRating  : null,
            ratingGapToTop:       rec.ratingGapToTop       != null ? rec.ratingGapToTop       : null,
            connections:          Array.isArray(rec.connections) ? rec.connections : []
        }
        const newParams = {
            departureH: rec.params && rec.params.departureH != null ? rec.params.departureH : 0,
            arrivalH:   rec.params && rec.params.arrivalH   != null ? rec.params.arrivalH   : 72,
            useGround:  rec.params ? rec.params.useGround !== false : true
        }
        return Object.assign({}, rec, {
            params:         newParams,
            byClass:        {[cls]: classRecord},
            classesScraped: [cls]
        })
    }

    static async saveRecord(hub, dest, fields) {
        const key = RouteAssistantOrsScraper._key(hub, dest)
        const rec = Object.assign({
            hub:       String(hub || "").toUpperCase(),
            dest:      String(dest || "").toUpperCase(),
            scrapedAt: Date.now()
        }, fields || {})
        if (!rec.pricingIndex) {
            const pricingIndex = RouteAssistantOrsScraper.buildPricingIndex(rec)
            if (pricingIndex) rec.pricingIndex = pricingIndex
        }
        await chrome.storage.local.set({[key]: rec})
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:route-assistant:ors:updated", {
                hub:  rec.hub,
                dest: rec.dest
            })
        }
        return rec
    }

    static async loadRecord(hub, dest) {
        const ns = RouteAssistantOrsScraper._key(hub, dest)
        const lg = RouteAssistantOrsScraper._legacyKey(hub, dest)
        let rec = null
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            rec = out[ns] || null
        } else {
            const out = await chrome.storage.local.get([ns, lg])
            rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
        }
        return rec ? RouteAssistantOrsScraper._migrateOrsRecord(rec) : null
    }

    // ------------------------------------------------------------------
    // Airport name resolution (for ORS form submission)
    // ------------------------------------------------------------------

    /**
     * Return the full airport name for an IATA from the DemandStore cache.
     * Falls back to the IATA literal — autocomplete accepts unique IATAs.
     */
    static async resolveAirportName(iata) {
        if (!iata) return ""
        try {
            if (typeof RouteAssistantDemandStore !== "undefined") {
                const rec = await RouteAssistantDemandStore.get(iata, {includeStale: true})
                if (rec && rec.name) return rec.name
            }
        } catch (e) { /* fall through */ }
        return String(iata).toUpperCase()
    }

    // ------------------------------------------------------------------
    // Carrier identification (for "isOurs" detection)
    // ------------------------------------------------------------------

    /**
     * Return a Set<flightNumber> harvested from the user's schedule cache
     * (`<server><airline>schedule`, written by content_fligthSchedule.js).
     * Each schedule record has `route.flightNumber: {FN1: {...}, FN2: {...}}`
     * — collect every key.
     */
    static async getOurFlightNumbers(server, airline) {
        const out = new Set()
        if (!server || !airline) return out
        const key = String(server) + String(airline) + "schedule"
        try {
            const data = await chrome.storage.local.get([key])
            const rec = data[key]
            if (!rec || !rec.date) return out
            for (const day in rec.date) {
                const sched = rec.date[day] && rec.date[day].schedule
                if (!Array.isArray(sched)) continue
                for (const route of sched) {
                    if (!route || !route.flightNumber) continue
                    for (const fn in route.flightNumber) {
                        if (fn) out.add(fn.trim())
                    }
                }
            }
        } catch (e) { /* swallow — empty set is a safe fallback */ }
        return out
    }

    static _carrierPrefixesFromFlightNumbers(flightNumbers) {
        const out = new Set()
        const iter = flightNumbers instanceof Set
            ? flightNumbers
            : (Array.isArray(flightNumbers) ? flightNumbers : [])
        for (const fn of iter) {
            const prefix = RouteAssistantOrsScraper._carrierPrefixFromCode(fn)
            if (prefix && /[A-Z]/.test(prefix)) out.add(prefix)
        }
        return Array.from(out)
    }

    /**
     * Return Array<string> of carrier prefixes — first the user override,
     * then unique prefixes harvested from the flight-number set, then a
     * last-resort initials guess from the airline display name.
     */
    static async getOurCarrierPrefixes(server, airline, override, opts) {
        opts = opts || {}
        if (override && typeof override === "string" && override.trim()) {
            return override.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
        }
        const fns = await RouteAssistantOrsScraper.getOurFlightNumbers(server, airline)
        const prefixes = new Set()
        for (const prefix of RouteAssistantOrsScraper._carrierPrefixesFromFlightNumbers(fns)) {
            prefixes.add(prefix)
        }
        if (prefixes.size) return Array.from(prefixes)
        if (opts.includeInitials === false) return []
        // Last resort: initials from airline display name.
        try {
            if (typeof AES !== "undefined" && AES.getAirlineIdentity) {
                const ident = AES.getAirlineIdentity() || ""
                const init = ident.replace(/[^A-Za-z\s]/g, "").split(/\s+/).filter(Boolean)
                    .map(w => w[0].toUpperCase()).join("")
                if (init) return [init]
            }
        } catch (e) { /* ignore */ }
        return []
    }

    // ------------------------------------------------------------------
    // Wicket form parsing (from initial GET)
    // ------------------------------------------------------------------

    static parseSessionId(html) {
        if (!html) return null
        // <script id="wicket-ajax-base-url">Wicket.Ajax.baseUrl="info/ors?399";</script>
        const m = /Wicket\.Ajax\.baseUrl\s*=\s*["']info\/ors\?(\d+)/i.exec(html)
        return m ? m[1] : null
    }

    static parseFormAction(html) {
        if (!html) return null
        // <form ... id="idff6" method="post" action="./ors?399-2.-form">
        // The form whose action ends in "-form" (no panel suffix) is the search form.
        const m = /<form[^>]+method=["']post["'][^>]+action=["']\.\/ors\?([^"']+\.-form)["']/i.exec(html)
        return m ? m[1] : null
    }

    /**
     * Parse hidden inputs from the initial GET — Wicket sometimes injects a
     * hidden CSRF-like token inside the form's hidden-fields div. Returns
     * Object<name, value>. Empty when none found (sample shows none).
     */
    static parseHiddenFields(doc, formId) {
        const out = {}
        if (!doc) return out
        // Locate the form by id; the hidden-fields div is its first child.
        const form = formId ? doc.getElementById(formId) : doc.querySelector("form[method='post']")
        if (!form) return out
        for (const inp of form.querySelectorAll("input[type='hidden']")) {
            const name = inp.getAttribute("name")
            if (name) out[name] = inp.getAttribute("value") || ""
        }
        return out
    }

    // ------------------------------------------------------------------
    // Connection-list parser
    // ------------------------------------------------------------------

    /**
     * Parse one ORS result page. Returns
     *   {connections: [...], pagination: {currentPage, totalPages, nextHref}}
     */
    static parseResultPage(doc) {
        const out = {connections: [], pagination: null, totalText: null}
        if (!doc) return out

        // "Found a total of N connections, displaying X at 30 per page."
        const totalP = doc.querySelector(".ors-result p")
        if (totalP) out.totalText = (totalP.textContent || "").trim()

        for (const tbody of doc.querySelectorAll(".ors-result tbody")) {
            const cls = tbody.getAttribute("class") || ""
            if (!/\b(?:bookable|unbookable)\b/.test(cls)) continue
            const conn = RouteAssistantOrsScraper._parseConnectionTbody(tbody)
            if (conn) out.connections.push(conn)
        }

        // Pagination — `.navigation` block, look for the next page or last page link.
        const nav = doc.querySelector(".ors-result .navigation")
        if (nav) {
            const links = nav.querySelectorAll("a")
            let currentPage = 1, totalPages = 1, nextHref = null
            for (const a of links) {
                const txt = (a.textContent || "").trim()
                const href = a.getAttribute("href") || ""
                const disabled = a.getAttribute("disabled") === "disabled"
                if (/^\d+$/.test(txt) && disabled) {
                    currentPage = parseInt(txt, 10)
                }
                if (/^\d+$/.test(txt)) {
                    const n = parseInt(txt, 10)
                    if (n > totalPages) totalPages = n
                }
                if (a.classList.contains("next") && !disabled && href) {
                    nextHref = href
                }
            }
            out.pagination = {currentPage, totalPages, nextHref}
        }

        return out
    }

    static _parseConnectionTbody(tbody) {
        const cls = tbody.getAttribute("class") || ""
        const bookable = /\bbookable\b/.test(cls) && !/\bunbookable\b/.test(cls)
        const trs = Array.from(tbody.querySelectorAll("tr"))
        if (!trs.length) return null

        // First tr is header (Date | From | To | Flight | Rating / Eq | Price)
        // Last tr (class="totals") is the connection summary.
        // Middle trs are legs.
        const totalsTr = trs.find(t => t.classList.contains("totals"))
        const legTrs = trs.filter(t => !t.classList.contains("totals")
            && !t.querySelector("th"))   // skip header tr (has <th> cells)

        const legs = []
        for (const tr of legTrs) {
            const tds = tr.querySelectorAll("td")
            if (tds.length < 6) continue
            // tds: [date, origin, destination, flight, aircraft, price]
            const dateCell = tds[0]
            const dateText = (dateCell.textContent || "").trim()
            const dateUtcAttr = dateCell.getAttribute("title") || ""

            const flightCell = tds[3]
            const flightLink = flightCell.querySelector("a[href*='flight?id=']")
            let flightCode = null, flightId = null, isGround = false
            if (flightLink) {
                flightCode = (flightLink.textContent || "").trim()
                const m = /flight\?id=(\d+)/.exec(flightLink.getAttribute("href") || "")
                if (m) flightId = parseInt(m[1], 10)
            } else if (flightCell.querySelector(".fa-subway, .fa-bus, .fa-ship")) {
                isGround = true
                flightCode = "ground"
            }

            const aircraftCell = tds[4]
            const ratingImg = aircraftCell.querySelector("img[title*='rating']")
            let legRating = null
            if (ratingImg) {
                const m = /rating\s+(\d+)/i.exec(ratingImg.getAttribute("title") || "")
                if (m) legRating = parseInt(m[1], 10)
            }
            const typeLink = aircraftCell.querySelector("a[href*='aircraftsType']")
            let typeCode = null, typeId = null
            if (typeLink) {
                typeCode = (typeLink.textContent || "").trim()
                const m = /aircraftsType\?id=(\d+)/.exec(typeLink.getAttribute("href") || "")
                if (m) typeId = parseInt(m[1], 10)
            }

            const priceCell = tds[5]
            const priceSpans = priceCell.querySelectorAll("span")
            let price = null, serviceClass = null, status = null
            if (priceSpans.length) {
                price = RouteAssistantOrsScraper._parseInt(priceSpans[0].textContent)
            }
            // Service class is in the second span (e.g., "(Y)")
            for (let i = 1; i < priceSpans.length; i++) {
                const t = (priceSpans[i].textContent || "").trim()
                if (/^[YCFT]$/.test(t) || /^cargo$/i.test(t)) { serviceClass = t; break }
            }
            const statusDiv = priceCell.querySelector("div.good, div.bad, div.warning")
            if (statusDiv) status = (statusDiv.textContent || "").trim()

            legs.push({
                flightCode, flightId, typeCode, typeId,
                rating: legRating, price, serviceClass, status,
                isOurs: false, isGround
            })
        }

        // Totals row
        let totalRating = null, totalDuration = null, totalPrice = null
        if (totalsTr) {
            const tds = totalsTr.querySelectorAll("td")
            // Cells: [colspan=3 spacer, duration, rating, price]
            for (const td of tds) {
                if (td.classList.contains("duration")) {
                    totalDuration = (td.textContent || "").trim()
                } else if (td.classList.contains("rating")) {
                    const img = td.querySelector("img[title*='rating']")
                    if (img) {
                        const m = /rating\s+(\d+)/i.exec(img.getAttribute("title") || "")
                        if (m) totalRating = parseInt(m[1], 10)
                    }
                } else if (td.classList.contains("price")) {
                    totalPrice = RouteAssistantOrsScraper._parseInt(td.textContent)
                }
            }
        }

        return {
            rating: totalRating,
            totalDuration,
            totalPrice,
            bookable,
            legs
        }
    }

    /**
     * Extract a carrier prefix from a flightCode like "AAL 123" → "AAL".
     * Returns null when the code is empty or has no leading-letter run.
     * Used for per-competitor ORS rating attribution and for the outline
     * aggregator to resolve carrierPrefix → enterpriseId via marketShare.
     */
    static _carrierPrefixFromCode(code) {
        if (!code) return null
        const m = /^([A-Z0-9]+)/.exec(String(code).trim().toUpperCase())
        return m && m[1] ? m[1] : null
    }

    static _parseInt(text) {
        if (text == null) return null
        const m = /-?\d[\d,.]*/.exec(String(text).replace(/[^\d,.\-]/g, " "))
        if (!m) return null
        const n = parseInt(m[0].replace(/[,.\s]/g, ""), 10)
        return isFinite(n) ? n : null
    }

    static _pricingIndexNum(v) {
        if (v === null || v === undefined || v === "") return null
        const n = Number(v)
        return isFinite(n) ? n : null
    }

    static _payloadForPriceClass(cls) {
        switch (String(cls || "")) {
            case "Y": return "ECONOMY"
            case "C": return "BUSINESS"
            case "F": return "FIRST"
            case "Cargo": return "CARGO"
            default: return null
        }
    }

    static _roundPriceForClass(cls, value) {
        const n = RouteAssistantOrsScraper._pricingIndexNum(value)
        if (n == null) return null
        return cls === "Cargo" && Math.abs(n) < 10
            ? Math.round(n * 100) / 100
            : Math.round(n)
    }

    static _medianPriceForClass(cls, values) {
        const vals = (values || [])
            .map(v => RouteAssistantOrsScraper._pricingIndexNum(v))
            .filter(v => v != null && v > 0)
            .sort((a, b) => a - b)
        if (!vals.length) return null
        const mid = Math.floor(vals.length / 2)
        const raw = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2
        return RouteAssistantOrsScraper._roundPriceForClass(cls, raw)
    }

    static _connectionPrice(conn) {
        const direct = RouteAssistantOrsScraper._pricingIndexNum(conn && conn.totalPrice)
        if (direct != null && direct > 0) return direct
        let sum = 0
        let seen = false
        for (const leg of (conn && conn.legs) || []) {
            if (!leg || leg.isGround) continue
            const p = RouteAssistantOrsScraper._pricingIndexNum(leg.price)
            if (p == null || p <= 0) continue
            sum += p
            seen = true
        }
        return seen ? sum : null
    }

    static _connectionCarrierPrefix(conn) {
        const legs = (conn && conn.legs || []).filter(l => l && !l.isGround)
        const first = legs[0] || null
        return first && (first.carrierPrefix
            || RouteAssistantOrsScraper._carrierPrefixFromCode(first.flightCode)) || null
    }

    /**
     * Build the compact ORS pricing index consumed by auto-pricing.
     * The raw ORS cache keeps every connection for auditability; this index
     * extracts the per-class competitor density and fare band needed by the
     * pricing calculations without walking the full result list each time.
     */
    static buildPricingIndex(record) {
        if (!record || typeof record !== "object") return null
        if (record.pricingIndex && record.pricingIndex.byClass) return record.pricingIndex
        const rawByClass = record.byClass && typeof record.byClass === "object"
            ? record.byClass
            : null
        const byClass = rawByClass || (Array.isArray(record.connections)
            ? {ECONOMY: record}
            : null)
        if (!byClass) return null

        const indexed = {
            source: "ors-search",
            scrapedAt: RouteAssistantOrsScraper._pricingIndexNum(record.scrapedAt),
            indexedAt: Date.now(),
            byClass: {},
            classes: {},
            competitorPricesByClass: {},
            competitorCountsByClass: {},
            ownPricesByClass: {}
        }

        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const payload = RouteAssistantOrsScraper._payloadForPriceClass(cls)
            const classRec = byClass[payload] || byClass[cls] || null
            if (!classRec) continue

            const ownPrices = []
            const competitorPrices = []
            const carrierCounts = {}
            let ownConnectionCount = 0
            let competitorConnectionCount = 0
            let bookableCount = 0
            let bookableOwnCount = 0
            let bookableCompetitorCount = 0
            let topCompetitorCarrier = null
            let topCompetitorPrice = null

            for (const conn of (Array.isArray(classRec.connections) ? classRec.connections : [])) {
                if (!conn) continue
                if (conn.bookable) bookableCount++
                const flightLegs = (conn.legs || []).filter(l => l && !l.isGround)
                if (!flightLegs.length) continue
                const anyOurs = flightLegs.some(l => !!l.isOurs)
                const price = RouteAssistantOrsScraper._connectionPrice(conn)
                if (anyOurs) {
                    ownConnectionCount++
                    if (conn.bookable) bookableOwnCount++
                    if (price != null && price > 0) ownPrices.push(price)
                    continue
                }

                competitorConnectionCount++
                if (conn.bookable) bookableCompetitorCount++
                if (price != null && price > 0) competitorPrices.push(price)
                const carrier = RouteAssistantOrsScraper._connectionCarrierPrefix(conn)
                if (carrier) {
                    carrierCounts[carrier] = (carrierCounts[carrier] || 0) + 1
                    if (!topCompetitorCarrier) topCompetitorCarrier = carrier
                }
                if (topCompetitorPrice == null && price != null && price > 0) topCompetitorPrice = price
            }

            const bestOwnPrice = ownPrices.length ? Math.min.apply(null, ownPrices) : null
            const bestCompetitorPrice = competitorPrices.length ? Math.min.apply(null, competitorPrices) : null
            const priceGapToBest = bestOwnPrice != null && bestCompetitorPrice != null
                ? RouteAssistantOrsScraper._roundPriceForClass(cls, bestOwnPrice - bestCompetitorPrice)
                : null
            const entry = {
                payload,
                rankAny:              RouteAssistantOrsScraper._pricingIndexNum(classRec.rankAny),
                rankNonstop:          RouteAssistantOrsScraper._pricingIndexNum(classRec.rankNonstop),
                rankBookable:         RouteAssistantOrsScraper._pricingIndexNum(classRec.rankBookable),
                ourTopRating:         RouteAssistantOrsScraper._pricingIndexNum(classRec.ourTopRating),
                topCompetitorRating:  RouteAssistantOrsScraper._pricingIndexNum(classRec.topCompetitorRating),
                ratingGapToTop:       RouteAssistantOrsScraper._pricingIndexNum(classRec.ratingGapToTop),
                totalConnections:     RouteAssistantOrsScraper._pricingIndexNum(classRec.totalConnections),
                connectionCount:      Array.isArray(classRec.connections) ? classRec.connections.length : 0,
                bookableCount,
                ownConnectionCount,
                competitorConnectionCount,
                bookableOwnCount,
                bookableCompetitorCount,
                competitorCarrierCount: Object.keys(carrierCounts).length,
                topCompetitorCarrier,
                topCompetitorPrice:   RouteAssistantOrsScraper._roundPriceForClass(cls, topCompetitorPrice),
                bestOwnPrice:         RouteAssistantOrsScraper._roundPriceForClass(cls, bestOwnPrice),
                bestCompetitorPrice:  RouteAssistantOrsScraper._roundPriceForClass(cls, bestCompetitorPrice),
                ownMedianPrice:       RouteAssistantOrsScraper._medianPriceForClass(cls, ownPrices),
                competitorMedianPrice: RouteAssistantOrsScraper._medianPriceForClass(cls, competitorPrices),
                priceGapToBest,
                priceGapPctToBest: bestOwnPrice != null && bestOwnPrice > 0 && bestCompetitorPrice != null
                    ? Math.round(((bestOwnPrice - bestCompetitorPrice) / bestOwnPrice) * 1000) / 10
                    : null
            }
            entry.classKey = cls
            entry.competitorCount = entry.competitorConnectionCount
            entry.competitorMedian = entry.competitorMedianPrice
            indexed.byClass[cls] = entry
            indexed.classes[cls] = entry
            indexed.competitorCountsByClass[cls] = entry.competitorCount
            if (entry.competitorMedianPrice != null) indexed.competitorPricesByClass[cls] = entry.competitorMedianPrice
            if (entry.ownMedianPrice != null) indexed.ownPricesByClass[cls] = entry.ownMedianPrice
        }

        indexed.classCount = Object.keys(indexed.byClass).length
        indexed.labels = indexed.classCount ? ["ORS", "ORS-prices"] : []
        return indexed.classCount ? indexed : null
    }

    // ------------------------------------------------------------------
    // Rank computation
    // ------------------------------------------------------------------

    /**
     * Decorate connections with isOurs per leg, then compute every rank
     * flavor + rating summary. Returns the summary plus the mutated
     * connections array.
     */
    static computeRanks(connections, ourFlightNumberSet, ourCarrierPrefixes, opts) {
        opts = opts || {}
        const summary = {
            totalConnections:     connections.length,
            rankAny:              null,
            rankFirstLegOurs:     null,
            rankAllOurs:          null,
            rankNonstop:          null,
            rankBookable:         null,
            ourTopRating:         null,
            ourBestNonstopRating: null,
            topCompetitorRating:  null,
            ratingGapToTop:       null,
            // Per-competitor max nonstop rating, keyed by carrier prefix
            // (the leading flightCode token, e.g. "AAL" from "AAL 123").
            // Populated only for non-us, single-leg connections so
            // outline-aggregator can answer "what ORS does competitor X
            // get on this lane?" The map is empty when no competitor
            // operates a nonstop on the lane.
            competitorRatings:    {},
            oursDetection: {
                flightNumbersSource: opts.flightNumbersSource || "schedule-cache",
                flightNumberCount:   0,
                matchedOwnLegs:      0,
                exactFlightNumberMatches: 0,
                prefixMatches:       0,
                carrierPrefixes:     [],
                prefixFallbackOnly:  false
            }
        }
        const fnSet = ourFlightNumberSet instanceof Set ? ourFlightNumberSet : new Set(ourFlightNumberSet || [])
        const fnSetUpper = new Set()
        for (const fn of fnSet) {
            if (fn) fnSetUpper.add(String(fn).trim().toUpperCase())
        }
        const prefixes = (ourCarrierPrefixes || []).map(p => String(p).toUpperCase()).filter(Boolean)
        summary.oursDetection.flightNumberCount = fnSetUpper.size
        summary.oursDetection.carrierPrefixes = prefixes.slice()

        const ownMatchSource = (code) => {
            if (!code) return null
            const c = code.trim().toUpperCase()
            if (fnSet.has(code) || fnSet.has(c) || fnSetUpper.has(c)) return "flight-number"
            for (const p of prefixes) {
                if (c.startsWith(p + " ") || c === p) return "carrier-prefix"
            }
            return null
        }

        // Mutate isOurs per leg.
        for (const conn of connections) {
            for (const leg of conn.legs || []) {
                if (leg.isGround) continue
                const source = ownMatchSource(leg.flightCode)
                leg.isOurs = !!source
                if (source) {
                    leg.oursDetectionSource = source
                    summary.oursDetection.matchedOwnLegs++
                    if (source === "flight-number") summary.oursDetection.exactFlightNumberMatches++
                    if (source === "carrier-prefix") summary.oursDetection.prefixMatches++
                }
            }
        }
        summary.oursDetection.prefixFallbackOnly = summary.oursDetection.matchedOwnLegs > 0
            && summary.oursDetection.exactFlightNumberMatches === 0
            && summary.oursDetection.prefixMatches > 0

        // Pass 1 — compute rank flavors.
        for (let i = 0; i < connections.length; i++) {
            const conn = connections[i]
            const flightLegs = (conn.legs || []).filter(l => !l.isGround)
            if (!flightLegs.length) continue

            const anyOurs    = flightLegs.some(l => l.isOurs)
            const allOurs    = flightLegs.every(l => l.isOurs)
            const firstOurs  = flightLegs[0].isOurs
            const isNonstop  = flightLegs.length === 1
            const rankPos    = i + 1

            if (anyOurs && summary.rankAny === null)             summary.rankAny = rankPos
            if (firstOurs && summary.rankFirstLegOurs === null)  summary.rankFirstLegOurs = rankPos
            if (allOurs && summary.rankAllOurs === null)         summary.rankAllOurs = rankPos
            if (allOurs && isNonstop && summary.rankNonstop === null) summary.rankNonstop = rankPos
            if (anyOurs && conn.bookable && summary.rankBookable === null) summary.rankBookable = rankPos

            // Track best ratings.
            if (anyOurs) {
                if (summary.ourTopRating == null || (conn.rating != null && conn.rating > summary.ourTopRating)) {
                    summary.ourTopRating = conn.rating
                }
                if (allOurs && isNonstop) {
                    if (summary.ourBestNonstopRating == null
                        || (conn.rating != null && conn.rating > summary.ourBestNonstopRating)) {
                        summary.ourBestNonstopRating = conn.rating
                    }
                }
            } else {
                if (summary.topCompetitorRating == null
                    || (conn.rating != null && conn.rating > summary.topCompetitorRating)) {
                    summary.topCompetitorRating = conn.rating
                }
                // Per-competitor: only count nonstop "all theirs" connections
                // so the rating cleanly attributes to one carrier. Multi-leg
                // mixed-carrier connections wouldn't tell you whose schedule
                // produced the rating.
                if (isNonstop && conn.rating != null) {
                    const prefix = RouteAssistantOrsScraper._carrierPrefixFromCode(flightLegs[0] && flightLegs[0].flightCode)
                    if (prefix) {
                        const cur = summary.competitorRatings[prefix]
                        if (cur == null || conn.rating > cur) {
                            summary.competitorRatings[prefix] = conn.rating
                        }
                    }
                }
            }
        }

        if (summary.ourTopRating != null && summary.topCompetitorRating != null) {
            summary.ratingGapToTop = summary.ourTopRating - summary.topCompetitorRating
        } else if (summary.ourTopRating != null && summary.topCompetitorRating == null) {
            // No competitor — own the route.
            summary.ratingGapToTop = summary.ourTopRating
        }

        return summary
    }

    // ------------------------------------------------------------------
    // Form submission + pagination
    // ------------------------------------------------------------------

    /**
     * Run an ORS scrape for one route across one or more cabin classes.
     * Returns the saved record (with a `byClass` map keyed by ECONOMY /
     * BUSINESS / FIRST / CARGO) or null on irrecoverable failure. Throws
     * on circuit-breaker-relevant errors (HTTP 429/503/timeout) so
     * bulkScrape can count them.
     *
     * Per-class failure isolation: an empty result (e.g. FIRST returns
     * zero connections on a regional route with no F cabin) is STORED
     * as {totalConnections: 0, …all nulls} rather than dropping the class.
     * Only HTTP 429/503/timeout propagates to the caller's circuit breaker.
     */
    async scrape(hubIata, destIata, params) {
        const pair = RouteAssistantOrsScraper._pairKey(hubIata, destIata)

        params = params || {}
        const departureH   = params.departureH != null ? params.departureH : 0
        const arrivalH     = params.arrivalH   != null ? params.arrivalH   : 72
        const useGround    = params.useGround !== false
        const carrierOverride = params.carrierOverride || null
        const pageStaggerMs = params.pageStaggerMs != null ? Math.max(0, Number(params.pageStaggerMs) || 0) : 750
        const pageRateLimitRetryMs = params.pageRateLimitRetryMs != null
            ? Math.max(0, Number(params.pageRateLimitRetryMs) || 0)
            : 3000
        // Backwards-compat: if a single `payload` is passed (legacy callers),
        // wrap into a single-element classesToScrape. Default includes Cargo
        // so the analyser and cargo autopricer have the same freshness path
        // as Y/C/F.
        const classesToScrape = RouteAssistantOrsScraper._normaliseClassesToScrape(params)
        const memoKey = RouteAssistantOrsScraper._scrapeMemoKey(hubIata, destIata, Object.assign({}, params, {
            classesToScrape,
            departureH,
            arrivalH,
            useGround,
            carrierOverride,
            pageStaggerMs
        }))
        if (!params.context && this._sessionCache.has(memoKey)) return this._sessionCache.get(memoKey)

        // Resolve carrier prefixes + flight-number set ONCE — they're
        // identical across classes and the schedule cache lookup is cheap
        // but we may as well not repeat it.
        let airline = null
        try {
            if (typeof AES !== "undefined" && AES.getAirlineIdentity) airline = AES.getAirlineIdentity()
        } catch (e) { /* ignore */ }
        const fnSet = await RouteAssistantOrsScraper.getOurFlightNumbers(this.server, airline)
        let flightNumbersSource = fnSet.size ? "enterprise-schedule-cache" : "none"
        // Orchestrator path — the route-sync orchestrator harvests fresh flight
        // numbers from the schedule-page scrape that just ran for this route
        // and unions them in here. Without this, a freshly-scraped route whose
        // flights aren't in the legacy `<server><airline>schedule` cache yet
        // tags every leg as "not ours" and rank flavors come back null.
        const fnOverride = params.ourFlightNumbersOverride
        if (fnOverride) {
            const iter = fnOverride instanceof Set
                ? fnOverride
                : (Array.isArray(fnOverride) ? fnOverride : [])
            for (const fn of iter) {
                if (fn) fnSet.add(String(fn).trim())
            }
            flightNumbersSource = "route-sync-schedule-scrape"
        }
        const prefixes = await RouteAssistantOrsScraper.getOurCarrierPrefixes(
            this.server, airline, carrierOverride, {includeInitials: !fnSet.size}
        )
        if (!carrierOverride) {
            const seenPrefixes = new Set(prefixes.map(p => String(p).toUpperCase()))
            for (const prefix of RouteAssistantOrsScraper._carrierPrefixesFromFlightNumbers(fnSet)) {
                if (!seenPrefixes.has(prefix)) {
                    prefixes.push(prefix)
                    seenPrefixes.add(prefix)
                }
            }
        }

        const byClass = {}
        const classesScraped = []
        const allOurFlightIds = new Set()

        for (let i = 0; i < classesToScrape.length; i++) {
            const cls = classesToScrape[i]
            const tag = pair + " " + cls + " (" + (i + 1) + "/" + classesToScrape.length + ")"
            try {
                const result = await this._scrapeOneClass(hubIata, destIata, {
                    payload: cls, departureH, arrivalH, useGround,
                    flightNumbersSource,
                    pageStaggerMs,
                    pageRateLimitRetryMs
                }, fnSet, prefixes)
                if (result) {
                    byClass[cls] = result.classRecord
                    for (const id of result.ourFlightIds) allOurFlightIds.add(id)
                    classesScraped.push(cls)
                    console.log("[AES orsScraper] " + tag + " done — "
                        + result.classRecord.totalConnections + " connections, "
                        + "rankNonstop=" + (result.classRecord.rankNonstop != null
                            ? "#" + result.classRecord.rankNonstop : "—"))
                } else {
                    // Non-rate-limit failure (parser miss, fetch fail). Class
                    // is recorded as null so the migration helper / panel
                    // can render "—" instead of treating it as untried.
                    byClass[cls] = null
                    console.warn("[AES orsScraper] " + tag + " — no result")
                }
            } catch (e) {
                if (e && e._isRateLimit) throw e   // propagate to circuit breaker
                console.warn("[AES orsScraper] " + tag + " threw", e)
                byClass[cls] = null
            }
        }

        const fields = {
            server: this.server,
            params: {departureH, arrivalH, useGround},
            ourFlightIds:       Array.from(allOurFlightIds),
            ourCarrierPrefixes: prefixes,
            byClass,
            classesScraped,
            oursDetection: RouteAssistantOrsScraper._aggregateOursDetection(
                byClass, fnSet, prefixes, flightNumbersSource
            )
        }
        // Calibration-set context — opaque passthrough. Caller (typically the
        // orchestrator's contextBuilder) supplies a snapshot of the route
        // config that produced this scrape (service profile, current price,
        // aircraft type, overrides, service config). Stored verbatim under
        // `record.context`; the snapshot store reads it for time-series
        // (config → ORS rank) calibration.
        if (params.context && typeof params.context === "object") {
            fields.context = params.context
        }
        const saved = await RouteAssistantOrsScraper.saveRecord(hubIata, destIata, fields)
        if (!params.context) this._sessionCache.set(memoKey, saved)
        this._consecutiveErrors = 0

        // Slice 2c — log a rating observation for the per-route per-class
        // α regression. Inside the scraper (NOT the panel) so bulkScrape
        // — which loops calling scrape() at ors-scraper.js:809 — also
        // logs. Failure is non-fatal — never break the scrape on a
        // logging miss.
        try {
            await RouteAssistantOrsScraper._logRatingObservation(this.server, hubIata, destIata, saved)
        } catch (e) {
            console.warn("[AES orsScraper] rating observation log failed", e)
        }

        return saved
    }

    /**
     * Slice 2c — append one (price, rating, …) observation record to the
     * rating-observation store. Reads the matching markets-page
     * ownPricing snapshot to source per-class observed fares; per-class
     * ratings come from the freshly-saved ORS record. Connection counts
     * are computed from the cached `byClass.<cls>.connections` so the
     * derivator can apply the own-frequency / competitor-churn confounder
     * filters without re-fetching.
     *
     * Honored gates (early-return without writing):
     *   - settings.routeAssistant.orsSandbox.ratingObservations.autoLogOnScrape
     *     missing or false → do not log.
     *   - validation in store._isValidObservation: at least one class
     *     must have a finite positive price AND a finite positive rating.
     */
    static async _logRatingObservation(server, hubIata, destIata, savedRecord) {
        if (typeof RouteAssistantRatingObservationStore === "undefined") return
        if (!savedRecord || !savedRecord.byClass) return

        // Settings gate. One get(["settings"]) is acceptable — the
        // scraper only runs at user action and bulk-sync cadence is
        // capped by concurrency=2 + stagger=1500ms.
        let autoLog = true
        try {
            const sb = await chrome.storage.local.get(["settings"])
            const ro = sb && sb.settings && sb.settings.routeAssistant
                && sb.settings.routeAssistant.orsSandbox
                && sb.settings.routeAssistant.orsSandbox.ratingObservations
            if (ro && ro.autoLogOnScrape === false) autoLog = false
        } catch (e) { /* best-effort — fall through to logging */ }
        if (!autoLog) return

        // Read the matching markets-page ownPricing snapshot. Prefer the
        // account-scoped loader; fall back to direct key reads for stripped
        // contexts/tests where the markets scraper module is absent.
        const pair = String(hubIata || "").toUpperCase() + "-" + String(destIata || "").toUpperCase()
        let ownPricing = null
        try {
            if (typeof RouteAssistantMarketsPageScraper !== "undefined"
                    && typeof RouteAssistantMarketsPageScraper.bulkLoadCache === "function") {
                const map = await RouteAssistantMarketsPageScraper.bulkLoadCache(
                    [{hub: hubIata, dest: destIata}],
                    {families: ["ownPricing"]}
                )
                const bucket = map && map.get(pair)
                ownPricing = bucket && bucket.ownPricing || null
            }
        } catch (e) { /* best-effort */ }
        if (!ownPricing) {
            try {
                const keys = ["routeAssistant:markets:ownPricing:" + pair]
                try {
                    if (typeof acctKey === "function") {
                        const scoped = acctKey("routeAssistant:markets:ownPricing", pair)
                        if (keys.indexOf(scoped) < 0) keys.unshift(scoped)
                    }
                } catch (_) {}
                const out = await chrome.storage.local.get(keys)
                for (const k of keys) {
                    if (out && out[k]) { ownPricing = out[k]; break }
                }
            } catch (e) { /* best-effort */ }
        }

        const prices = (ownPricing && ownPricing.prices) || {}
        const byClass = savedRecord.byClass || {}
        const CLASS_PAYLOAD = {Y: "ECONOMY", C: "BUSINESS", F: "FIRST"}

        const obs = {
            at:                    Date.now(),
            prices:                {Y: null, C: null, F: null},
            ratings:               {Y: null, C: null, F: null},
            ownConnections:        {Y: 0,    C: 0,    F: 0},
            competitorConnections: {Y: 0,    C: 0,    F: 0},
            comfortLevel:          null,
            pricingScrapedAt:      (ownPricing && typeof ownPricing.scrapedAt === "number") ? ownPricing.scrapedAt : null,
            orsScrapedAt:          (typeof savedRecord.scrapedAt === "number") ? savedRecord.scrapedAt : Date.now()
        }

        for (const cls of ["Y", "C", "F"]) {
            const p = Number(prices[cls])
            if (isFinite(p) && p > 0) obs.prices[cls] = p
            const classRec = byClass[CLASS_PAYLOAD[cls]] || null
            if (classRec) {
                const r = Number(classRec.ourTopRating)
                if (isFinite(r) && r > 0) obs.ratings[cls] = r
                if (Array.isArray(classRec.connections)) {
                    let own = 0, comp = 0
                    for (const c of classRec.connections) {
                        const flightLegs = (c.legs || []).filter(l => !l.isGround)
                        if (!flightLegs.length) continue
                        if (flightLegs.every(l => !!l.isOurs)) own++
                        else comp++
                    }
                    obs.ownConnections[cls]        = own
                    obs.competitorConnections[cls] = comp
                }
            }
        }

        // ServiceProfile from ownPricing — int when AS exposes a level,
        // null otherwise. Comfort changes between observations are a
        // confounder and the derivator drops obs that change comfort.
        if (ownPricing && ownPricing.generalSettings) {
            const sp = ownPricing.generalSettings.serviceProfile
            const n = Number(sp)
            if (isFinite(n)) obs.comfortLevel = n
        }

        await RouteAssistantRatingObservationStore.add(hubIata, destIata, obs)
    }

    /**
     * Scrape one cabin class for one route. Pure helper extracted from
     * the original single-class `scrape()`. Returns
     *   {classRecord: {totalConnections, rankAny, …, connections[]},
     *    ourFlightIds: [...]}
     * or null on non-rate-limit failure. Throws on rate-limit errors.
     */
    async _scrapeOneClass(hubIata, destIata, params, fnSet, prefixes) {
        const pair = RouteAssistantOrsScraper._pairKey(hubIata, destIata)
        const payload     = params.payload
        const departureH  = params.departureH
        const arrivalH    = params.arrivalH
        const useGround   = params.useGround
        const pageStaggerMs = params.pageStaggerMs != null ? Math.max(0, Number(params.pageStaggerMs) || 0) : 750
        const pageRateLimitRetryMs = params.pageRateLimitRetryMs != null
            ? Math.max(0, Number(params.pageRateLimitRetryMs) || 0)
            : 3000
        const baseUrl     = "https://" + this.server + ".airlinesim.aero"
        const orsUrl      = baseUrl + "/app/info/ors"

        // Step 1 — GET to harvest Wicket session + form action. Each class
        // needs its own handshake (Wicket page-version IDs invalidate per
        // POST; sharing the session across classes returns PageExpiredException).
        let initialHtml
        try {
            const resp = await RouteAssistantOrsScraper._fetchWithRateLimitRetry(
                orsUrl,
                {credentials: "include", referrer: orsUrl},
                pageRateLimitRetryMs
            )
            if (!resp.ok) {
                if (resp.status === 429 || resp.status === 503) {
                    throw new RouteAssistantOrsScraper._RateLimitError(resp.status, "GET ors")
                }
                console.warn("[AES orsScraper] GET HTTP " + resp.status + " for " + pair + " " + payload)
                return null
            }
            initialHtml = await resp.text()
        } catch (e) {
            if (e && e._isRateLimit) throw e
            console.warn("[AES orsScraper] GET fetch failed for " + pair + " " + payload, e)
            return null
        }

        const formAction = RouteAssistantOrsScraper.parseFormAction(initialHtml)
        if (!formAction) {
            console.warn("[AES orsScraper] couldn't locate form action for " + pair + " " + payload
                + " — page format may have changed")
            return null
        }
        const initialDoc = new DOMParser().parseFromString(initialHtml, "text/html")
        // The page now ships TWO post forms: a 1-input "searchQuery" bar
        // (`-base.search`) plus the structured ORS form (`-form`). Pick the
        // structured one by matching the action so hidden-field harvesting
        // reads from the right form if AS ever adds CSRF tokens.
        const formId = (() => {
            const forms = initialDoc.querySelectorAll("form[method='post']")
            for (const f of forms) {
                const action = f.getAttribute("action") || ""
                if (/\.-form(?:\b|$)/.test(action)) return f.getAttribute("id")
            }
            return forms[0] ? forms[0].getAttribute("id") : null
        })()
        const hiddenFields = RouteAssistantOrsScraper.parseHiddenFields(initialDoc, formId)

        // Step 2 — POST the form for this class.
        const hubName  = await RouteAssistantOrsScraper.resolveAirportName(hubIata)
        const destName = await RouteAssistantOrsScraper.resolveAirportName(destIata)
        const radio    = RouteAssistantOrsScraper.PAYLOAD_RADIO[payload] || "radio0"

        const body = new URLSearchParams()
        for (const k in hiddenFields) body.set(k, hiddenFields[k])
        body.set("origin-group:origin-group_body:origin",           hubName)
        body.set("destination-group:destination-group_body:destination", destName)
        body.set("departure-group:departure-group_body:departure",  String(departureH))
        body.set("arrival-group:arrival-group_body:arrival",        String(arrivalH))
        body.set("payload",                                         radio)
        if (useGround) body.set("ground:useGroundNetwork", "on")

        const postUrl = baseUrl + "/app/info/ors?" + formAction
        let resultHtml
        try {
            // referrer must be the ORS page itself; AS rejects /app/info/ors
            // POSTs from foreign Referers with HTTP 500 (Spring/Wicket layer).
            const resp = await RouteAssistantOrsScraper._fetchWithRateLimitRetry(postUrl, {
                method:      "POST",
                credentials: "include",
                referrer:    orsUrl,
                headers:     {"Content-Type": "application/x-www-form-urlencoded"},
                body:        body.toString()
            }, pageRateLimitRetryMs)
            if (!resp.ok) {
                if (resp.status === 429 || resp.status === 503) {
                    throw new RouteAssistantOrsScraper._RateLimitError(resp.status, "POST ors")
                }
                console.warn("[AES orsScraper] POST HTTP " + resp.status + " for " + pair + " " + payload)
                return null
            }
            resultHtml = await resp.text()
        } catch (e) {
            if (e && e._isRateLimit) throw e
            console.warn("[AES orsScraper] POST fetch failed for " + pair + " " + payload, e)
            return null
        }

        // Watch for Wicket page-expiration silent fail — happens when the
        // form session ID we harvested in Step 1 has been invalidated by
        // another tab's interaction. Per-class handshakes (one Step 1 + 2
        // pair per cabin) make this rare but it can still surface.
        if (/PageExpiredException/i.test(resultHtml)) {
            console.warn("[AES orsScraper] PageExpiredException for " + pair + " " + payload)
            return null
        }

        // Step 3 — parse page 1 + walk pagination.
        let resultDoc = new DOMParser().parseFromString(resultHtml, "text/html")
        let parsed = RouteAssistantOrsScraper.parseResultPage(resultDoc)
        const allConnections = parsed.connections.slice()

        const maxPages = Math.max(1, parsed.pagination ? parsed.pagination.totalPages : 1)
        const safetyCap = 10   // hard cap so a parser bug can't loop us indefinitely
        let page = 1
        let nextHref = parsed.pagination && parsed.pagination.nextHref
        while (nextHref && page < maxPages && page < safetyCap) {
            page++
            const pageUrl = baseUrl + "/app/info/ors?" + nextHref.replace(/^\.\/ors\?/, "")
            try {
                await RouteAssistantOrsScraper._sleep(pageStaggerMs)
                let r = await RouteAssistantOrsScraper._fetchWithRateLimitRetry(
                    pageUrl,
                    {credentials: "include", referrer: orsUrl},
                    pageRateLimitRetryMs
                )
                if (!r.ok) {
                    if (r.status === 429 || r.status === 503) {
                        throw new RouteAssistantOrsScraper._RateLimitError(r.status, "GET page " + page)
                    }
                    console.warn("[AES orsScraper] page " + page + " HTTP " + r.status + " for " + pair + " " + payload)
                    break
                }
                const html = await r.text()
                resultDoc = new DOMParser().parseFromString(html, "text/html")
                parsed = RouteAssistantOrsScraper.parseResultPage(resultDoc)
                for (const c of parsed.connections) allConnections.push(c)
                nextHref = parsed.pagination && parsed.pagination.nextHref
            } catch (e) {
                if (e && e._isRateLimit) throw e
                console.warn("[AES orsScraper] page " + page + " fetch failed for " + pair + " " + payload, e)
                break
            }
        }

        // Step 4 — compute ranks for THIS class. Empty results (zero
        // connections) are valid and produce all-null rank flavors.
        const ranks = RouteAssistantOrsScraper.computeRanks(allConnections, fnSet, prefixes, {
            flightNumbersSource: params.flightNumbersSource || "schedule-cache"
        })

        const ourFlightIds = []
        const compactConnections = []
        for (let i = 0; i < allConnections.length; i++) {
            const c = allConnections[i]
            const compactLegs = []
            for (const leg of c.legs || []) {
                compactLegs.push({
                    flightCode:    leg.flightCode,
                    flightId:      leg.flightId,
                    typeCode:      leg.typeCode,
                    typeId:        leg.typeId,
                    rating:        leg.rating,
                    price:         leg.price,
                    serviceClass:  leg.serviceClass,
                    status:        leg.status,
                    isOurs:        !!leg.isOurs,
                    isGround:      !!leg.isGround,
                    oursDetectionSource: leg.oursDetectionSource || null,
                    carrierPrefix: leg.isGround
                        ? null
                        : RouteAssistantOrsScraper._carrierPrefixFromCode(leg.flightCode)
                })
                if (leg.isOurs && leg.flightId != null) ourFlightIds.push(leg.flightId)
            }
            compactConnections.push({
                idx: i,
                rating:        c.rating,
                totalDuration: c.totalDuration,
                totalPrice:    c.totalPrice,
                bookable:      !!c.bookable,
                legs:          compactLegs
            })
        }

        const classRecord = Object.assign({scrapedAt: Date.now()}, ranks, {
            connections: compactConnections
        })
        return {classRecord, ourFlightIds}
    }

    static _aggregateOursDetection(byClass, fnSet, prefixes, source) {
        const out = {
            flightNumbersSource: source || "schedule-cache",
            flightNumberCount:   0,
            matchedOwnLegs:      0,
            exactFlightNumberMatches: 0,
            prefixMatches:       0,
            carrierPrefixes:     (prefixes || []).map(p => String(p).toUpperCase()).filter(Boolean),
            prefixFallbackOnly:  false,
            classes:             {}
        }
        const set = fnSet instanceof Set ? fnSet : new Set(fnSet || [])
        out.flightNumberCount = set.size
        for (const cls in (byClass || {})) {
            const det = byClass[cls] && byClass[cls].oursDetection
            if (!det) continue
            out.classes[cls] = {
                matchedOwnLegs: det.matchedOwnLegs || 0,
                exactFlightNumberMatches: det.exactFlightNumberMatches || 0,
                prefixMatches: det.prefixMatches || 0,
                prefixFallbackOnly: !!det.prefixFallbackOnly
            }
            out.matchedOwnLegs += det.matchedOwnLegs || 0
            out.exactFlightNumberMatches += det.exactFlightNumberMatches || 0
            out.prefixMatches += det.prefixMatches || 0
        }
        out.prefixFallbackOnly = out.matchedOwnLegs > 0
            && out.exactFlightNumberMatches === 0
            && out.prefixMatches > 0
        return out
    }

    // Custom rate-limit error so the bulk runner can detect it.
    static _RateLimitError = class extends Error {
        constructor(status, where) {
            super("ORS rate limit (" + status + ") at " + where)
            this._isRateLimit = true
            this.status = status
            // Cross-context signal: the scrape-orchestrator's background-tab
            // pool listens for `chrome.storage.onChanged` on this key so it
            // can trip its breaker IMMEDIATELY (skip the 3-strike threshold)
            // when ORS reports 429/503. Fire-and-forget; service-worker may
            // be unavailable in some contexts.
            try { RouteAssistantOrsScraper._signalRateLimit(status, where) }
            catch (e) { /* noop */ }
        }
    }

    /**
     * Write a transient hint to chrome.storage.local under
     * `aes:scrape-orchestrator:rateLimitSignal`. The background-tab-pool
     * subscribes to chrome.storage.onChanged on this key and trips its
     * circuit breaker on the next job-result. Best-effort — failures are
     * swallowed since the bulk runner's own breaker still applies.
     */
    static _signalRateLimit(status, where) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return
        const signal = {
            status: status,
            source: "ors-scraper",
            at:     Date.now(),
            where:  where || null
        }
        try {
            chrome.storage.local.set({"aes:scrape-orchestrator:rateLimitSignal": signal}, () => {
                void (chrome.runtime && chrome.runtime.lastError)
            })
        } catch (e) { /* noop */ }
    }

    // ------------------------------------------------------------------
    // Bulk-scrape with circuit breaker
    // ------------------------------------------------------------------

    /**
     * @param {Array<{hub, dest}>} pairs
     * @param {object} opts - {concurrency, staggerMs, scrapeParams,
     *                         onProgress(progress)}
     *   progress = {done, total, halted?, reason?}
     */
    async bulkScrape(pairs, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(5, opts.concurrency || 2))
        const staggerMs   = Math.max(0, opts.staggerMs || 1500)
        const scrapeParams = opts.scrapeParams || {}
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null
        const errorThreshold = 3   // consecutive 429/503/timeout → halt

        const results = []
        const total = pairs.length
        if (!total) return results

        let cursor = 0
        let inflight = 0
        let done = 0
        let lastDispatchAt = 0
        let halted = false
        let haltReason = null

        return new Promise(resolve => {
            const finish = () => resolve({results, halted, reason: haltReason})

            const tryDispatch = () => {
                if (halted && inflight === 0) return finish()
                while (!halted && inflight < concurrency && cursor < total) {
                    const sinceLast = Date.now() - lastDispatchAt
                    if (sinceLast < staggerMs) {
                        setTimeout(tryDispatch, staggerMs - sinceLast)
                        return
                    }
                    const idx = cursor++
                    const {hub, dest} = pairs[idx]
                    inflight++
                    lastDispatchAt = Date.now()
                    this.scrape(hub, dest, scrapeParams).then(rec => {
                        results[idx] = rec
                    }).catch(e => {
                        if (e && e._isRateLimit) {
                            this._consecutiveErrors++
                            if (this._consecutiveErrors >= errorThreshold && !halted) {
                                halted = true
                                haltReason = "Rate-limited (HTTP " + e.status + ") "
                                    + this._consecutiveErrors + "× in a row — circuit breaker tripped."
                                this._haltedReason = haltReason
                            }
                        } else {
                            console.warn("[AES orsScraper] unexpected error", e)
                        }
                    }).finally(() => {
                        inflight--
                        done++
                        if (onProgress) {
                            try { onProgress({done, total, halted, reason: haltReason}) }
                            catch (e) { /* noop */ }
                        }
                        if (done >= total || (halted && inflight === 0)) finish()
                        else tryDispatch()
                    })
                }
                if (halted && inflight === 0) finish()
            }
            tryDispatch()
        })
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantOrsScraper = RouteAssistantOrsScraper
}
