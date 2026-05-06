"use strict"

/**
 * Ticket-price scraper for the Route Assistant. Reads the user's current
 * ticket price + yield + ORS rank per route from
 * `/app/com/scheduling/<HUB><DEST>` — the same Wicket-rendered page
 * `RouteAssistantDistanceResolver` already taps for tier-1 distance.
 *
 * Two consumption paths:
 *
 *   1. Live-read — `parseFromDoc(document)` runs against the current
 *      scheduling page DOM when the panel mounts. Free per-route capture
 *      organic to the user's navigation.
 *
 *   2. Bulk-scrape — `scrape(hub, dest)` fetches the page HTML, parses,
 *      and writes the cache. Bulk batches are driven by panel.js with
 *      a small concurrency + stagger window, mirroring the distance
 *      enrichment flow.
 *
 * Cache:
 *   routeAssistant:ticketPrice:<HUB>-<DEST>
 *     → {hub, dest, ourPrice, ourYield, orsRank, fareClasses?,
 *        scrapedAt, source: "fetch"|"live"}
 *
 * Pair key is **directional** — a price is set per direction (HUB→DEST
 * differs from DEST→HUB). Distance-resolver's symmetric pair key would
 * be wrong here.
 *
 * AS scheduling page format hasn't been sampled in this repo yet, so the
 * parsers are heuristic: they walk every table row and label-match
 * "ticket"/"fare"/"price"/"yield"/"ORS"/"rank". First-run logging surfaces
 * fields that didn't parse so the user can supply a sample HTML and we
 * tighten the selectors. Returns `null` per-field rather than throwing,
 * so a partial parse still produces a usable cache record.
 */
class RouteAssistantSchedulePageScraper {
    /**
     * L3 — Class B refactor: scrape output (own pricing + frequency
     * details) belongs to the airline that flew it, so per-account
     * scoping prevents one account's prices leaking into another's
     * profit estimator.
     */
    static LEGACY_PREFIX = "routeAssistant:ticketPrice:"
    static SCOPE_PREFIX  = "routeAssistant:ticketPrice"

    /** L3 deprecated — preserve for any reader still doing key arithmetic. */
    static get CACHE_PREFIX() { return RouteAssistantSchedulePageScraper.LEGACY_PREFIX }

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantSchedulePageScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantSchedulePageScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        this._sessionCache = new Map()
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantSchedulePageScraper.SCOPE_PREFIX,
            RouteAssistantSchedulePageScraper._pairKey(hub, dest))
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantSchedulePageScraper.LEGACY_PREFIX
            + RouteAssistantSchedulePageScraper._pairKey(hub, dest)
    }

    static _normaliseMaxAge(v) {
        const n = Number(v)
        return isFinite(n) && n > 0 ? n : null
    }

    static _handleInvalidatedContext(err) {
        const msg = err && err.message ? err.message : String(err || "")
        if (!/Extension context invalidated/i.test(msg)) return false
        try {
            if (window.AESSiteSkin?.handleInvalidatedContext?.(err)) return true
        } catch (_) {}
        return true
    }

    static _isExpired(record, maxAgeDays) {
        if (!maxAgeDays) return false
        if (!record || typeof record.scrapedAt !== "number") return false
        return Date.now() - record.scrapedAt > maxAgeDays * 86400000
    }

    /**
     * Bulk-load cached records for a list of {hub, dest} pairs (or
     * [hub, dest] tuples). Returns Map<pairKey, record>. Used by panel.js
     * on mount to paint pricing columns instantly before any fetch.
     */
    static async bulkLoadCache(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const maxAgeDays = RouteAssistantSchedulePageScraper._normaliseMaxAge(opts && opts.maxAgeDays)
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantSchedulePageScraper._pairKey(a, b))
            nsKeys.push(RouteAssistantSchedulePageScraper._key(a, b))
            lgKeys.push(RouteAssistantSchedulePageScraper._legacyKey(a, b))
        }
        const all = []
        for (const k of nsKeys) all.push(k)
        for (const k of lgKeys) if (all.indexOf(k) < 0) all.push(k)
        let out = {}
        try {
            out = await chrome.storage.local.get(all)
        } catch (e) {
            if (RouteAssistantSchedulePageScraper._handleInvalidatedContext(e)) return new Map()
            throw e
        }
        const map = new Map()
        for (let i = 0; i < pairs.length; i++) {
            const ns = nsKeys[i]
            const lg = lgKeys[i]
            const rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
            if (!rec) continue
            if (RouteAssistantSchedulePageScraper._isExpired(rec, maxAgeDays)) continue
            map.set(pairKeys[i], rec)
        }
        return map
    }

    /**
     * Persists a record. Live-read path calls this directly with
     * source="live"; the fetch path calls it via scrape().
     */
    static async saveRecord(hub, dest, fields, source) {
        const key = RouteAssistantSchedulePageScraper._key(hub, dest)
        const rec = Object.assign({
            hub:       String(hub || "").toUpperCase(),
            dest:      String(dest || "").toUpperCase(),
            scrapedAt: Date.now(),
            source:    source || "fetch"
        }, fields || {})
        try {
            await chrome.storage.local.set({[key]: rec})
        } catch (e) {
            if (RouteAssistantSchedulePageScraper._handleInvalidatedContext(e)) return rec
            throw e
        }
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:route-assistant:schedule:updated", {
                hub:  rec.hub,
                dest: rec.dest
            })
        }
        return rec
    }

    static async loadRecord(hub, dest) {
        const ns = RouteAssistantSchedulePageScraper._key(hub, dest)
        const lg = RouteAssistantSchedulePageScraper._legacyKey(hub, dest)
        try {
            if (ns === lg) {
                const out = await chrome.storage.local.get([ns])
                return out[ns] || null
            }
            const out = await chrome.storage.local.get([ns, lg])
            if (out[ns] !== undefined) return out[ns]
            return out[lg] || null
        } catch (e) {
            if (RouteAssistantSchedulePageScraper._handleInvalidatedContext(e)) return null
            throw e
        }
    }

    /**
     * Fetch + parse a single route's scheduling page. Returns the saved
     * record or null if the fetch failed. Parse failures still save
     * (with null fields) so the panel knows the route was attempted.
     */
    async scrape(hubIata, destIata) {
        const pair = RouteAssistantSchedulePageScraper._pairKey(hubIata, destIata)
        if (this._sessionCache.has(pair)) return this._sessionCache.get(pair)

        const url = "https://" + this.server + ".airlinesim.aero/app/com/scheduling/"
            + String(hubIata).toUpperCase() + String(destIata).toUpperCase()
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                console.warn("[AES priceScraper] HTTP " + resp.status + " for " + pair)
                return null
            }
            const html = await resp.text()
            const fields = RouteAssistantSchedulePageScraper.parseFromHtml(html)
            const rec = await RouteAssistantSchedulePageScraper.saveRecord(hubIata, destIata, fields, "fetch")
            this._sessionCache.set(pair, rec)
            return rec
        } catch (e) {
            console.warn("[AES priceScraper] fetch failed for " + pair, e)
            return null
        }
    }

    static parseFromHtml(html) {
        if (!html) return {ourPrice: null, ourYield: null, orsRank: null, fareClasses: null}
        const doc = new DOMParser().parseFromString(html, "text/html")
        return RouteAssistantSchedulePageScraper.parseFromDoc(doc)
    }

    /**
     * Pure parser — feed it a Document (live or fetched) and get back
     * `{ourPrice, ourYield, orsRank, fareClasses}`. Each field is
     * independently nullable so a partial parse is still useful.
     */
    /**
     * Pure parser — feed it a Document and get back a record of live route
     * data. `/app/com/scheduling/<HUB><DEST>` carries no fares or ORS rank
     * (those live on `/app/com/markets/...` and `/app/com/inventory/...`),
     * so the price/yield/ORS fields stay null in Tier 1. The rich data this
     * page DOES expose — assigned aircraft, departure time, frequency
     * pattern, cruise speed — is captured here for the panel's Live-route
     * columns and as foundation for the wave/yield-feedback tiers.
     */
    static parseFromDoc(doc) {
        const out = {
            // Reserved for Tier 2 scrapers. Kept on the shape so cache
            // records stay stable as later tiers fill them in.
            ourPrice: null, ourYield: null, orsRank: null, fareClasses: null,
            // Live route data from the scheduling page.
            flights:                [],
            primaryAircraftType:    null,
            primaryAircraftTypeId:  null,
            primaryAircraftReg:     null,
            departureTime:          null,
            // weeklyFlights = total departures per week (counts multi-daily).
            // dailyFlights  = [Mon..Sun] departures per day.
            // daysPerWeek   = number of unique days at least one flight runs.
            weeklyFlights:          0,
            dailyFlights:           [0, 0, 0, 0, 0, 0, 0],
            daysPerWeek:            0,
            cruiseSpeedKmh:         null
        }
        if (!doc) return out

        // ---- Flight Numbers overview table (legend = "Flight Numbers")
        let flightTable = null
        const fieldsets = doc.getElementsByClassName("as-fieldset")
        for (let i = 0; i < fieldsets.length; i++) {
            const fs = fieldsets[i]
            const legends = fs.getElementsByClassName("legend")
            const legend = legends.length > 0 ? legends[0] : null
            if (legend && /flight\s*numbers?/i.test(legend.textContent || "")) {
                const tables = fs.getElementsByTagName("table")
                if (tables.length > 0) flightTable = tables[0]
                break
            }
        }

        if (flightTable) {
            const tbody = flightTable.tBodies.length > 0 ? flightTable.tBodies[0] : null
            if (tbody) {
                for (const tr of tbody.rows) {
                    const cells = tr.cells
                    if (!cells || cells.length < 4) continue
                    const flightNumber  = (cells[0].textContent || "").trim()
                    const departureTime = (cells[1].textContent || "").trim().replace(/\s*HT\s*$/i, "")
                    const frequencyDays = (cells[2].textContent || "").trim()
                    const acCell        = cells[3]

                    let regLink = null
                    let typeLink = null
                    const links = acCell.getElementsByTagName("a")
                    for (let j = 0; j < links.length; j++) {
                        const href = links[j].getAttribute("href") || ""
                        if (!regLink && href.indexOf("/fleets/aircraft/") !== -1) regLink = links[j]
                        if (!typeLink && href.indexOf("aircraftsType") !== -1) typeLink = links[j]
                    }
                    const registration  = regLink  ? (regLink.textContent  || "").trim() : null
                    const typeName      = typeLink ? (typeLink.textContent || "").trim() : null
                    let typeId = null
                    if (typeLink) {
                        const m = /aircraftsType\?id=(\d+)/.exec(typeLink.getAttribute("href") || "")
                        if (m) typeId = parseInt(m[1], 10)
                    }
                    out.flights.push({
                        flightNumber:   flightNumber,
                        departureTime:  departureTime,
                        frequencyDays:  frequencyDays,
                        registration:   registration,
                        typeId:         typeId,
                        typeName:       typeName
                    })
                    // Each character at position i is the day-number digit when
                    // operated, "_" when not. Sum across all flights so multi-
                    // daily routes (FN24 + FN25 both flying every day) collapse
                    // to per-day counts like [2,2,2,2,2,2,2].
                    for (let i = 0; i < 7 && i < frequencyDays.length; i++) {
                        const ch = frequencyDays.charAt(i)
                        if (ch >= "1" && ch <= "7") out.dailyFlights[i] += 1
                    }
                }
            }
        }
        out.weeklyFlights = out.dailyFlights.reduce((s, n) => s + n, 0)
        out.daysPerWeek   = out.dailyFlights.filter(n => n > 0).length

        // Pick the most common aircraft + departure time across flights.
        const mostCommon = (key) => {
            const m = {}
            for (const f of out.flights) {
                const v = f[key]
                if (v == null || v === "") continue
                m[v] = (m[v] || 0) + 1
            }
            let best = null, bestCount = 0
            for (const k in m) if (m[k] > bestCount) { best = k; bestCount = m[k] }
            return best
        }
        out.primaryAircraftType = mostCommon("typeName")
        out.departureTime       = mostCommon("departureTime")
        if (out.primaryAircraftType) {
            const sample = out.flights.find(f => f.typeName === out.primaryAircraftType)
            if (sample) {
                out.primaryAircraftTypeId = sample.typeId
                out.primaryAircraftReg    = sample.registration
            }
        }

        // ---- Cruise speed — first numeric "NNN km/h" cell on a row whose
        // first cell label starts with "Cruise Speed" (segments matrix).
        const tables = doc.getElementsByTagName("table")
        outer: for (let i = 0; i < tables.length; i++) {
            const table = tables[i]
            for (const tr of table.rows) {
                const firstCell = tr.cells.length > 0 ? tr.cells[0] : null
                if (!firstCell) continue
                // Depending on the layout the first cell could be <th> or <td class="caption">
                if (!/^cruise\s*speed\b/i.test((firstCell.textContent || "").trim())) continue
                for (const c of tr.cells) {
                    const m = /(\d+)\s*km\/?h/i.exec(c.textContent || "")
                    if (m) { out.cruiseSpeedKmh = parseInt(m[1], 10); break }
                }
                if (out.cruiseSpeedKmh) break outer
            }
        }

        if (out.flights.length) {
            console.log("[AES routeAssistant] scheduling page parsed: "
                + out.flights.length + " flight(s)"
                + ", primary=" + out.primaryAircraftType
                + ", dep=" + out.departureTime
                + ", " + out.weeklyFlights + "/wk pattern=" + out.dailyFlights.join("")
                + ", cruise=" + (out.cruiseSpeedKmh || "—") + "km/h")
        }

        return out
    }

    static _matchClass(labelLow) {
        if (/^y\b|economy|coach/i.test(labelLow)) return "Y"
        if (/^c\b|business/i.test(labelLow)) return "C"
        if (/^f\b|first/i.test(labelLow)) return "F"
        return null
    }

    /**
     * Extract a numeric value from a cell of currency / yield / rank text.
     * Handles thousand separators ("1,234" / "1.234" / "1 234"), decimal
     * notation, currency prefixes, and trailing units.
     */
    static _parseNumber(text) {
        if (!text) return null
        const stripped = String(text).replace(/[^\d.,\s-]/g, " ").trim()
        if (!stripped) return null
        const m = /(-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)/.exec(stripped)
        if (!m) return null
        // Heuristic: if there are both "," and "." in the number, the rightmost
        // is the decimal separator. Otherwise treat the trailing "."/"," as
        // decimal only when followed by 1–2 digits, else as thousands.
        let raw = m[1]
        if (raw.indexOf(",") >= 0 && raw.indexOf(".") >= 0) {
            // Mixed — strip the leftmost (thousands), keep the rightmost (decimal).
            const lastComma = raw.lastIndexOf(",")
            const lastDot   = raw.lastIndexOf(".")
            if (lastComma > lastDot) {
                raw = raw.replace(/\./g, "").replace(",", ".")
            } else {
                raw = raw.replace(/,/g, "")
            }
        } else if (raw.indexOf(",") >= 0) {
            const after = raw.split(",").pop()
            raw = (after.length === 3) ? raw.replace(/,/g, "") : raw.replace(",", ".")
        } else if (raw.indexOf(" ") >= 0) {
            raw = raw.replace(/\s+/g, "")
        }
        const n = parseFloat(raw)
        return isFinite(n) ? n : null
    }

    /**
     * Run a bulk scrape over a list of {hub, dest} pairs with concurrency
     * + stagger control. Awaits the lot. Used by the "Scan prices for
     * all visible routes" CTA in the Auto-Pricing expander.
     *
     * @param {Array<{hub, dest}>} pairs
     * @param {object} opts - {concurrency, staggerMs, onProgress(done, total)}
     */
    async bulkScrape(pairs, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(20, opts.concurrency || 8))
        const staggerMs   = Math.max(0, opts.staggerMs || 800)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null

        const results = []
        const total = pairs.length
        if (!total) return results

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
                    })
                }
            }
            tryDispatch()
        })
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantSchedulePageScraper = RouteAssistantSchedulePageScraper
}
