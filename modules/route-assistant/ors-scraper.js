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
 *        totalConnections, ourFlightIds, ourCarrierPrefixes,
 *        rankAny, rankFirstLegOurs, rankAllOurs, rankNonstop, rankBookable,
 *        ourTopRating, ourBestNonstopRating, topCompetitorRating, ratingGapToTop,
 *        connections: [{idx, rating, totalDuration, totalPrice, bookable,
 *          legs: [{flightCode, flightId, typeCode, typeId, rating, price,
 *                  serviceClass, status, isOurs, isGround}]}]}
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
    static CACHE_PREFIX = "routeAssistant:ors:"

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
     * Returns Map<pairKey, record>.
     */
    static async bulkLoadCache(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const maxAgeDays = RouteAssistantOrsScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const keys = pairs.map(p => {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            return RouteAssistantOrsScraper.CACHE_PREFIX + RouteAssistantOrsScraper._pairKey(a, b)
        })
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            if (RouteAssistantOrsScraper._isExpired(rec, maxAgeDays)) continue
            const pair = k.substring(RouteAssistantOrsScraper.CACHE_PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    static async saveRecord(hub, dest, fields) {
        const pair = RouteAssistantOrsScraper._pairKey(hub, dest)
        const key = RouteAssistantOrsScraper.CACHE_PREFIX + pair
        const rec = Object.assign({
            hub:       String(hub || "").toUpperCase(),
            dest:      String(dest || "").toUpperCase(),
            scrapedAt: Date.now()
        }, fields || {})
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    static async loadRecord(hub, dest) {
        const key = RouteAssistantOrsScraper.CACHE_PREFIX
            + RouteAssistantOrsScraper._pairKey(hub, dest)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
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

    /**
     * Return Array<string> of carrier prefixes — first the user override,
     * then unique prefixes harvested from the flight-number set, then a
     * last-resort initials guess from the airline display name.
     */
    static async getOurCarrierPrefixes(server, airline, override) {
        if (override && typeof override === "string" && override.trim()) {
            return override.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
        }
        const fns = await RouteAssistantOrsScraper.getOurFlightNumbers(server, airline)
        const prefixes = new Set()
        for (const fn of fns) {
            // "FGM 1" → "FGM"; "UAF 1001" → "UAF". Take everything before
            // the first space, fall back to leading-letter run.
            const m = /^([A-Z0-9]+)/.exec(fn.trim().toUpperCase())
            if (m && m[1]) prefixes.add(m[1])
        }
        if (prefixes.size) return Array.from(prefixes)
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

    static _parseInt(text) {
        if (text == null) return null
        const m = /-?\d[\d,.]*/.exec(String(text).replace(/[^\d,.\-]/g, " "))
        if (!m) return null
        const n = parseInt(m[0].replace(/[,.\s]/g, ""), 10)
        return isFinite(n) ? n : null
    }

    // ------------------------------------------------------------------
    // Rank computation
    // ------------------------------------------------------------------

    /**
     * Decorate connections with isOurs per leg, then compute every rank
     * flavor + rating summary. Returns the summary plus the mutated
     * connections array.
     */
    static computeRanks(connections, ourFlightNumberSet, ourCarrierPrefixes) {
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
            ratingGapToTop:       null
        }
        const fnSet = ourFlightNumberSet instanceof Set ? ourFlightNumberSet : new Set(ourFlightNumberSet || [])
        const prefixes = (ourCarrierPrefixes || []).map(p => String(p).toUpperCase())

        const isOursCode = (code) => {
            if (!code) return false
            const c = code.trim().toUpperCase()
            if (fnSet.has(code) || fnSet.has(c)) return true
            for (const p of prefixes) {
                if (c.startsWith(p + " ") || c === p) return true
            }
            return false
        }

        // Mutate isOurs per leg.
        for (const conn of connections) {
            for (const leg of conn.legs || []) {
                if (leg.isGround) continue
                leg.isOurs = isOursCode(leg.flightCode)
            }
        }

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
     * Run a single ORS scrape for one route. Returns the saved record or
     * null on irrecoverable failure. Throws on circuit-breaker-relevant
     * errors (HTTP 429/503/timeout) so bulkScrape can count them.
     */
    async scrape(hubIata, destIata, params) {
        const pair = RouteAssistantOrsScraper._pairKey(hubIata, destIata)
        if (this._sessionCache.has(pair)) return this._sessionCache.get(pair)

        params = params || {}
        const payload      = params.payload      || "ECONOMY"
        const departureH   = params.departureH != null ? params.departureH : 0
        const arrivalH     = params.arrivalH   != null ? params.arrivalH   : 72
        const useGround    = params.useGround !== false
        const carrierOverride = params.carrierOverride || null

        const baseUrl = "https://" + this.server + ".airlinesim.aero"
        const orsUrl  = baseUrl + "/app/info/ors"

        // Step 1 — GET to harvest Wicket session + form action.
        let initialHtml
        try {
            const resp = await fetch(orsUrl, {credentials: "include"})
            if (!resp.ok) {
                if (resp.status === 429 || resp.status === 503) {
                    throw new RouteAssistantOrsScraper._RateLimitError(resp.status, "GET ors")
                }
                console.warn("[AES orsScraper] GET HTTP " + resp.status + " for " + pair)
                return null
            }
            initialHtml = await resp.text()
        } catch (e) {
            if (e && e._isRateLimit) throw e
            console.warn("[AES orsScraper] GET fetch failed for " + pair, e)
            return null
        }

        const formAction = RouteAssistantOrsScraper.parseFormAction(initialHtml)
        if (!formAction) {
            console.warn("[AES orsScraper] couldn't locate form action for " + pair
                + " — page format may have changed")
            return null
        }
        const initialDoc = new DOMParser().parseFromString(initialHtml, "text/html")
        const formId = (() => {
            const f = initialDoc.querySelector("form[method='post']")
            return f ? f.getAttribute("id") : null
        })()
        const hiddenFields = RouteAssistantOrsScraper.parseHiddenFields(initialDoc, formId)

        // Step 2 — resolve airport names + build POST body.
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
            const resp = await fetch(postUrl, {
                method:      "POST",
                credentials: "include",
                headers:     {"Content-Type": "application/x-www-form-urlencoded"},
                body:        body.toString()
            })
            if (!resp.ok) {
                if (resp.status === 429 || resp.status === 503) {
                    throw new RouteAssistantOrsScraper._RateLimitError(resp.status, "POST ors")
                }
                console.warn("[AES orsScraper] POST HTTP " + resp.status + " for " + pair)
                return null
            }
            resultHtml = await resp.text()
        } catch (e) {
            if (e && e._isRateLimit) throw e
            console.warn("[AES orsScraper] POST fetch failed for " + pair, e)
            return null
        }

        // Watch for Wicket page-expiration silent fail.
        if (/PageExpiredException/i.test(resultHtml)) {
            console.warn("[AES orsScraper] PageExpiredException for " + pair
                + " — wicket session went stale (should not happen with per-route handshake)")
            return null
        }

        // Step 3 — parse page 1 + walk pagination.
        let resultDoc = new DOMParser().parseFromString(resultHtml, "text/html")
        let parsed = RouteAssistantOrsScraper.parseResultPage(resultDoc)
        const allConnections = parsed.connections.slice()

        const maxPages = Math.max(1, parsed.pagination ? parsed.pagination.totalPages : 1)
        const safetyCap = 10   // hard cap so a parser bug can't loop us
        let page = 1
        let nextHref = parsed.pagination && parsed.pagination.nextHref
        while (nextHref && page < maxPages && page < safetyCap) {
            page++
            const pageUrl = baseUrl + "/app/info/ors?" + nextHref.replace(/^\.\/ors\?/, "")
            try {
                const r = await fetch(pageUrl, {credentials: "include"})
                if (!r.ok) {
                    if (r.status === 429 || r.status === 503) {
                        throw new RouteAssistantOrsScraper._RateLimitError(r.status, "GET page " + page)
                    }
                    console.warn("[AES orsScraper] page " + page + " HTTP " + r.status + " for " + pair)
                    break
                }
                const html = await r.text()
                resultDoc = new DOMParser().parseFromString(html, "text/html")
                parsed = RouteAssistantOrsScraper.parseResultPage(resultDoc)
                for (const c of parsed.connections) allConnections.push(c)
                nextHref = parsed.pagination && parsed.pagination.nextHref
            } catch (e) {
                if (e && e._isRateLimit) throw e
                console.warn("[AES orsScraper] page " + page + " fetch failed for " + pair, e)
                break
            }
        }

        // Step 4 — derive carrier prefixes + flight-number set, compute ranks.
        let airline = null
        try {
            if (typeof AES !== "undefined" && AES.getAirlineIdentity) airline = AES.getAirlineIdentity()
        } catch (e) { /* ignore */ }
        const fnSet = await RouteAssistantOrsScraper.getOurFlightNumbers(this.server, airline)
        const prefixes = await RouteAssistantOrsScraper.getOurCarrierPrefixes(
            this.server, airline, carrierOverride
        )
        const ranks = RouteAssistantOrsScraper.computeRanks(allConnections, fnSet, prefixes)

        // Add idx + collect our flight IDs.
        const ourFlightIds = []
        const compactConnections = []
        for (let i = 0; i < allConnections.length; i++) {
            const c = allConnections[i]
            const compactLegs = []
            for (const leg of c.legs || []) {
                compactLegs.push({
                    flightCode:   leg.flightCode,
                    flightId:     leg.flightId,
                    typeCode:     leg.typeCode,
                    typeId:       leg.typeId,
                    rating:       leg.rating,
                    price:        leg.price,
                    serviceClass: leg.serviceClass,
                    status:       leg.status,
                    isOurs:       !!leg.isOurs,
                    isGround:     !!leg.isGround
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

        const fields = Object.assign({}, ranks, {
            params: {payload, departureH, arrivalH, useGround},
            ourFlightIds:       Array.from(new Set(ourFlightIds)),
            ourCarrierPrefixes: prefixes,
            connections:        compactConnections
        })
        const saved = await RouteAssistantOrsScraper.saveRecord(hubIata, destIata, fields)
        this._sessionCache.set(pair, saved)
        this._consecutiveErrors = 0
        return saved
    }

    // Custom rate-limit error so the bulk runner can detect it.
    static _RateLimitError = class extends Error {
        constructor(status, where) {
            super("ORS rate limit (" + status + ") at " + where)
            this._isRateLimit = true
            this.status = status
        }
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
