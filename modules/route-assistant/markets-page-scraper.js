"use strict"

/**
 * Markets-page scraper for the Route Assistant. Reads the AS Market Analysis
 * page at `/app/com/markets/<HUB><DEST>` — the per-route page that exposes
 * everything the scheduling page does NOT: every competitor flight on the
 * route with its actual price + availability + status, your own pricing form
 * (current + default + slider ranges), the market-share leaderboard for both
 * pax and cargo, and 25 weeks of historic capacity + price chart data.
 *
 * Two consumption paths (mirroring schedule-page-scraper.js):
 *
 *   1. Live-read — `parseFromDoc(document)` runs against the current markets
 *      page DOM when the user navigates to it (via content_markets.js).
 *
 *   2. Bulk-scrape — `scrape(hub, dest)` fetches the page HTML, parses, and
 *      writes the cache. Bulk batches are driven by panel.js via
 *      `bulkScrape(pairs, opts)` with concurrency + stagger.
 *
 * Storage — one fetch writes 4 directional keys atomically:
 *   routeAssistant:markets:competitors:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt, source, competitors: [{flightCode, flightId,
 *        typeCode, typeId, depDateUtc, depDateLocal, depTimeUtc, depTimeLocal,
 *        arrTimeUtc, arrTimeLocal, serviceClass, availability, price, status,
 *        isOurs}]}
 *
 *   routeAssistant:markets:ownPricing:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt, source, prices: {Y, C, F, Cargo},
 *        defaults: {…}, sliderRanges: {Y: [1, 296], …},
 *        generalSettings: {originTerminal, destinationTerminal, serviceProfile,
 *        boardingPreference, cargoPreference}}
 *
 *   routeAssistant:markets:marketShare:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt, source, period,
 *        pax:   [{rank, name, enterpriseId, sharePct, change}],
 *        cargo: [{rank, name, enterpriseId, sharePct, change}]}
 *
 *   routeAssistant:markets:historic:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt, source, payload, periods, capacities, prices}
 *
 * Pair key is **directional** — competitor flights and pricing differ by
 * direction. (The market-share leaderboard probably IS symmetric in practice
 * but storing it directionally is safer than assuming.)
 *
 * Why split into 4 keys: each family has a different cadence — competitors
 * mutate any time a competitor reschedules; ownPricing only when you change
 * a price; marketShare updates weekly; historic accumulates one row per week.
 * `bulkLoadCache` issues a single combined `chrome.storage.local.get` for
 * any subset of families, so the split costs no extra round trip.
 */
class RouteAssistantMarketsPageScraper {
    static CACHE_PREFIXES = {
        competitors: "routeAssistant:markets:competitors:",
        ownPricing:  "routeAssistant:markets:ownPricing:",
        marketShare: "routeAssistant:markets:marketShare:",
        historic:    "routeAssistant:markets:historic:"
    }

    static FAMILIES = ["competitors", "ownPricing", "marketShare", "historic"]

    constructor(server, opts) {
        if (!server) throw new Error("RouteAssistantMarketsPageScraper: server required")
        this.server = server
        this.maxAgeDays = RouteAssistantMarketsPageScraper._normaliseMaxAge(opts && opts.maxAgeDays)
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

    /**
     * Bulk-load cached records for a list of {hub, dest} pairs. Returns
     *   Map<pairKey, {family1: record1, family2: record2, …}>
     * Pass `opts.families` to limit which families are fetched (default: all 4).
     * Pass `opts.maxAge` as `{family: days}` to per-family-expire records.
     * One combined chrome.storage.local.get call regardless of split.
     */
    static async bulkLoadCache(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const families = (opts && Array.isArray(opts.families) && opts.families.length)
            ? opts.families
            : RouteAssistantMarketsPageScraper.FAMILIES
        const maxAge = (opts && opts.maxAge) || {}
        const keys = []
        const keyMeta = []   // parallel: [{pair, family, key}]
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            const pair = RouteAssistantMarketsPageScraper._pairKey(a, b)
            for (const fam of families) {
                const prefix = RouteAssistantMarketsPageScraper.CACHE_PREFIXES[fam]
                if (!prefix) continue
                const key = prefix + pair
                keys.push(key)
                keyMeta.push({pair, family: fam, key})
            }
        }
        if (!keys.length) return new Map()
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const meta of keyMeta) {
            let rec = out[meta.key]
            if (!rec) continue
            const ageDays = RouteAssistantMarketsPageScraper._normaliseMaxAge(maxAge[meta.family])
            if (RouteAssistantMarketsPageScraper._isExpired(rec, ageDays)) continue
            // Letter K — `historic` family migrated to a `byPayload` map.
            // Lazy-migrate legacy `{periods, capacities, prices, payload}`
            // records on read so already-cached routes still work.
            if (meta.family === "historic") {
                rec = RouteAssistantMarketsPageScraper._migrateHistoricRecord(rec)
            }
            let bucket = map.get(meta.pair)
            if (!bucket) { bucket = {}; map.set(meta.pair, bucket) }
            bucket[meta.family] = rec
        }
        return map
    }

    /**
     * Letter K — backwards-compat read for historic records. The legacy
     * shape stored a single payload's series at the top level
     * (`{payload, periods, capacities, prices}`). The new shape stores
     * every captured payload under `byPayload[NAME]`. This helper
     * upgrades the legacy shape to the new shape on read so callers
     * always see one consistent contract.
     *
     * Pure — does NOT write back to storage. The next `scrape()` for
     * this route will overwrite the legacy record with the new shape.
     */
    static _migrateHistoricRecord(rec) {
        if (!rec || typeof rec !== "object") return rec
        if (rec.byPayload && typeof rec.byPayload === "object") return rec
        if (!Array.isArray(rec.periods) || !rec.periods.length) return rec
        const payload = (typeof rec.payload === "string" && rec.payload) || "ECONOMY"
        return Object.assign({}, rec, {
            byPayload: {
                [payload]: {
                    periods:    rec.periods,
                    capacities: rec.capacities || [],
                    prices:     rec.prices || []
                }
            }
        })
    }

    /**
     * Single chrome.storage.local.set with one key per family the parser
     * produced. Skips families where the parser returned null (e.g., no
     * pricing fieldset present on a sub-page).
     */
    static async saveAllRecords(hub, dest, parsed, source) {
        const pair = RouteAssistantMarketsPageScraper._pairKey(hub, dest)
        const ts = Date.now()
        const base = {
            hub:       String(hub || "").toUpperCase(),
            dest:      String(dest || "").toUpperCase(),
            scrapedAt: ts,
            source:    source || "fetch"
        }
        const writes = {}
        const saved = {}
        // Read the existing historic record so a fresh single-payload
        // scrape doesn't wipe out previously-cached payloads. We write
        // the union under `byPayload`.
        let prevHistoric = null
        if (parsed && parsed.historic) {
            const histKey = RouteAssistantMarketsPageScraper.CACHE_PREFIXES.historic + pair
            const cur = await chrome.storage.local.get([histKey])
            prevHistoric = cur && cur[histKey] ? RouteAssistantMarketsPageScraper._migrateHistoricRecord(cur[histKey]) : null
        }
        for (const fam of RouteAssistantMarketsPageScraper.FAMILIES) {
            if (!parsed || !parsed[fam]) continue
            const key = RouteAssistantMarketsPageScraper.CACHE_PREFIXES[fam] + pair
            let payload = parsed[fam]
            if (fam === "historic") {
                // Letter K — coerce parser output into the byPayload map
                // shape, merging with any previously-cached payloads so a
                // single-payload refresh doesn't lose the others.
                payload = RouteAssistantMarketsPageScraper._mergeHistoric(prevHistoric, payload)
            }
            const rec = Object.assign({}, base, payload)
            writes[key] = rec
            saved[fam] = rec
        }
        if (Object.keys(writes).length) {
            await chrome.storage.local.set(writes)
        }
        return saved
    }

    /**
     * Letter K — fold a parser output into the byPayload map of a
     * cache record. Accepts either the legacy single-payload shape
     * (`{payload, periods, capacities, prices}`) or the new shape
     * (`{byPayload: {…}}`). Returns the new shape with the union of
     * everything we know about this route.
     */
    static _mergeHistoric(prev, incoming) {
        if (!incoming) return prev || {byPayload: {}}
        const out = {byPayload: {}}
        if (prev && prev.byPayload) {
            Object.assign(out.byPayload, prev.byPayload)
        }
        if (incoming.byPayload) {
            Object.assign(out.byPayload, incoming.byPayload)
        } else if (incoming.periods) {
            const payload = (typeof incoming.payload === "string" && incoming.payload) || "ECONOMY"
            out.byPayload[payload] = {
                periods:    incoming.periods,
                capacities: incoming.capacities || [],
                prices:     incoming.prices || []
            }
        }
        return out
    }

    /**
     * Single combined get for one route. Returns
     *   {competitors?, ownPricing?, marketShare?, historic?}
     * — present families only.
     */
    static async loadAll(hub, dest) {
        const pair = RouteAssistantMarketsPageScraper._pairKey(hub, dest)
        const keys = RouteAssistantMarketsPageScraper.FAMILIES.map(
            f => RouteAssistantMarketsPageScraper.CACHE_PREFIXES[f] + pair
        )
        const out = await chrome.storage.local.get(keys)
        const result = {}
        for (const fam of RouteAssistantMarketsPageScraper.FAMILIES) {
            const k = RouteAssistantMarketsPageScraper.CACHE_PREFIXES[fam] + pair
            if (out[k]) result[fam] = out[k]
        }
        return result
    }

    /**
     * Letter K — supported payload values for the per-class historic
     * fan-out. AS's payload dropdown on the markets page accepts these
     * keys (the URL responds to `?payload=NAME` for each). PAX is the
     * sum of ECONOMY+BUSINESS+FIRST; CARGO is its own series.
     */
    static HISTORIC_PAYLOADS = ["ECONOMY", "BUSINESS", "FIRST", "PAX", "CARGO"]

    /**
     * Fetch a single payload's historic series and merge it into the
     * route's existing `byPayload` cache record. Used by the demand-
     * depth bulk sync to fan out per-class fetches without losing
     * previously-cached payloads.
     *
     * Returns the parsed payload record `{periods, capacities, prices}`
     * or null on parse/fetch failure.
     */
    async scrapeHistoricPayload(hubIata, destIata, payload) {
        if (!payload || RouteAssistantMarketsPageScraper.HISTORIC_PAYLOADS.indexOf(payload) < 0) return null
        const url = "https://" + this.server + ".airlinesim.aero/app/com/markets/"
            + String(hubIata).toUpperCase() + String(destIata).toUpperCase()
            + "?payload=" + encodeURIComponent(payload)
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                console.warn("[AES marketsScraper] historic " + payload + " HTTP " + resp.status + " for " + hubIata + "-" + destIata)
                return null
            }
            const html = await resp.text()
            const parsed = RouteAssistantMarketsPageScraper._parseHistoricFromHtml(html)
            if (!parsed || !parsed.periods || !parsed.periods.length) return null
            // The query param drove which series the page rendered, so
            // override whatever the parser guessed.
            parsed.payload = payload
            // Persist into the byPayload union without disturbing the
            // other families.
            await RouteAssistantMarketsPageScraper.saveAllRecords(hubIata, destIata, {
                competitors: null, ownPricing: null, marketShare: null, historic: parsed
            }, "fetch")
            return {
                periods:    parsed.periods,
                capacities: parsed.capacities || [],
                prices:     parsed.prices || []
            }
        } catch (e) {
            console.warn("[AES marketsScraper] historic " + payload + " fetch failed for " + hubIata + "-" + destIata, e)
            return null
        }
    }

    /**
     * Letter K — fan out per-class historic fetches across the visible
     * route list, capped by `concurrency` and spaced by `staggerMs`.
     * Mirrors `bulkScrape` orchestration but issues one fetch per
     * (route, payload) tuple.
     *
     * `payloads` defaults to ["PAX", "CARGO"] (summary mode). Pass
     * the full HISTORIC_PAYLOADS for the heavy 5-payload sweep.
     */
    async bulkScrapeHistoric(pairs, opts) {
        opts = opts || {}
        const payloads    = (opts.payloads && opts.payloads.length) ? opts.payloads : ["PAX", "CARGO"]
        const concurrency = Math.max(1, Math.min(8, opts.concurrency || 3))
        const staggerMs   = Math.max(0, opts.staggerMs || 1200)
        const onProgress  = typeof opts.onProgress === "function" ? opts.onProgress : null

        // Build the work list as (pair, payload) tuples.
        const work = []
        for (const p of pairs || []) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            for (const pl of payloads) work.push({hub: a, dest: b, payload: pl})
        }
        const total = work.length
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
                    const job = work[idx]
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
                    this.scrapeHistoricPayload(job.hub, job.dest, job.payload)
                        .then(finish)
                        .catch(err => {
                            console.warn("[AES marketsScraper] historic bulk error:", err)
                            finish(null)
                        })
                }
            }
            tryDispatch()
        })
    }

    /**
     * Fetch + parse a single route's markets page. Saves all 4 families.
     * Returns {competitors?, ownPricing?, marketShare?, historic?} on success
     * or null on fetch failure.
     */
    async scrape(hubIata, destIata) {
        const pair = RouteAssistantMarketsPageScraper._pairKey(hubIata, destIata)
        if (this._sessionCache.has(pair)) return this._sessionCache.get(pair)

        const url = "https://" + this.server + ".airlinesim.aero/app/com/markets/"
            + String(hubIata).toUpperCase() + String(destIata).toUpperCase()
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                console.warn("[AES marketsScraper] HTTP " + resp.status + " for " + pair)
                return null
            }
            const html = await resp.text()
            const parsed = RouteAssistantMarketsPageScraper.parseFromHtml(html)
            const saved = await RouteAssistantMarketsPageScraper.saveAllRecords(
                hubIata, destIata, parsed, "fetch"
            )
            this._sessionCache.set(pair, saved)
            return saved
        } catch (e) {
            console.warn("[AES marketsScraper] fetch failed for " + pair, e)
            return null
        }
    }

    static parseFromHtml(html) {
        if (!html) return {competitors: null, ownPricing: null, marketShare: null, historic: null}
        const doc = new DOMParser().parseFromString(html, "text/html")
        // Historic chart data lives in inline <script> bodies that DOMParser
        // attaches to the document — but reading them from doc.querySelector
        // gives us the script text, which we can regex.
        const parsed = RouteAssistantMarketsPageScraper.parseFromDoc(doc)
        // historic parser needs the raw HTML too — DOMParser sometimes
        // strips or encodes inline JSON inside script tags. Re-parse from
        // raw if doc-based parse came back empty.
        if (!parsed.historic && /lineChart\(/i.test(html)) {
            parsed.historic = RouteAssistantMarketsPageScraper._parseHistoricFromHtml(html)
        }
        return parsed
    }

    /**
     * Pure parser — feed a Document, get back a record per family. Each
     * family is independently nullable so a partial parse on a malformed
     * page still produces useful storage.
     */
    static parseFromDoc(doc) {
        const out = {
            competitors: null,
            ownPricing:  null,
            marketShare: null,
            historic:    null
        }
        if (!doc) return out

        // ---- Competitors (Current Availability table)
        const competitors = RouteAssistantMarketsPageScraper._parseCompetitors(doc)
        if (competitors && competitors.length) {
            out.competitors = {competitors: competitors}
        }

        // ---- Own pricing (Airport Pair Settings → Pricing fieldset)
        const ownPricing = RouteAssistantMarketsPageScraper._parseOwnPricing(doc)
        if (ownPricing && ownPricing.prices && Object.keys(ownPricing.prices).length) {
            out.ownPricing = ownPricing
        }

        // ---- Market shares (Market Shares section)
        const marketShare = RouteAssistantMarketsPageScraper._parseMarketShare(doc)
        if (marketShare && (marketShare.pax.length || marketShare.cargo.length)) {
            out.marketShare = marketShare
        }

        // ---- Historic charts (inline lineChart setData calls)
        const historic = RouteAssistantMarketsPageScraper._parseHistoricFromDoc(doc)
        if (historic && historic.periods && historic.periods.length) {
            out.historic = historic
        }

        if (out.competitors || out.ownPricing || out.marketShare || out.historic) {
            const cN = out.competitors ? out.competitors.competitors.length : 0
            const oP = out.ownPricing  ? Object.keys(out.ownPricing.prices).join("/") : "—"
            const mS = out.marketShare ? (out.marketShare.pax.length + out.marketShare.cargo.length) : 0
            const hN = out.historic    ? out.historic.periods.length : 0
            console.log("[AES marketsScraper] parsed: competitors=" + cN
                + " pricing=" + oP + " share=" + mS + " hist=" + hN)
        }

        return out
    }

    // ------------------------------------------------------------------
    // Competitors parser
    // ------------------------------------------------------------------

    static _parseCompetitors(doc) {
        const table = doc.querySelector("#inventory-table")
        if (!table) return null
        const ourPrefix = RouteAssistantMarketsPageScraper._currentAirlinePrefixes()
        const list = []
        for (const tr of table.querySelectorAll("tbody tr")) {
            const cells = tr.querySelectorAll("td")
            if (cells.length < 8) continue

            // [0] flight code (span) + small (a typeId link)
            const flightCodeEl = cells[0].querySelector("span")
            const typeLinkEl   = cells[0].querySelector("a[href*='aircraftsType']")
            const flightCode = flightCodeEl ? (flightCodeEl.textContent || "").trim() : null
            let typeCode = typeLinkEl ? (typeLinkEl.textContent || "").trim() : null
            let typeId   = null
            if (typeLinkEl) {
                const m = /aircraftsType\?id=(\d+)/.exec(typeLinkEl.getAttribute("href") || "")
                if (m) typeId = parseInt(m[1], 10)
            }

            // [1] date — "2026-04-23" body, title="2026-04-24 UTC / 2026-04-23 HT / 2026-04-23 LT"
            const dateBody = (cells[1].textContent || "").trim()
            const dateTitle = cells[1].getAttribute("title") || ""
            const depDateUtc   = RouteAssistantMarketsPageScraper._extractTitlePart(dateTitle, "UTC")
            const depDateLocal = RouteAssistantMarketsPageScraper._extractTitlePart(dateTitle, "LT") || dateBody

            // [2] depTime — "20:30" body, title="01:30 UTC / 20:30 HT / 20:30 LT"
            const depTimeBody  = (cells[2].textContent || "").trim()
            const depTimeTitle = cells[2].getAttribute("title") || ""
            const depTimeUtc   = RouteAssistantMarketsPageScraper._extractTitlePart(depTimeTitle, "UTC")
            const depTimeLocal = RouteAssistantMarketsPageScraper._extractTitlePart(depTimeTitle, "LT") || depTimeBody

            // [3] arrTime — same shape
            const arrTimeBody  = (cells[3].textContent || "").trim()
            const arrTimeTitle = cells[3].getAttribute("title") || ""
            const arrTimeUtc   = RouteAssistantMarketsPageScraper._extractTitlePart(arrTimeTitle, "UTC")
            const arrTimeLocal = RouteAssistantMarketsPageScraper._extractTitlePart(arrTimeTitle, "LT") || arrTimeBody

            // [4] service class — Y / C / F / Cargo
            const serviceClass = (cells[4].textContent || "").trim()

            // [5] availability — number inside good/warning/bad div
            const availDiv = cells[5].querySelector("div")
            const availability = availDiv
                ? RouteAssistantMarketsPageScraper._parseInt(availDiv.textContent)
                : RouteAssistantMarketsPageScraper._parseInt(cells[5].textContent)

            // [6] price — "148 AS$"
            const price = RouteAssistantMarketsPageScraper._parseInt(cells[6].textContent)

            // [7] status — span text inside .flightStatusPanel
            const statusSpan = cells[7].querySelector("span")
            const status = statusSpan ? (statusSpan.textContent || "").trim() : (cells[7].textContent || "").trim()

            // [8] flight detail link → flight ID
            let flightId = null
            const flightLink = cells[cells.length - 1].querySelector("a[href*='flight?id=']")
            if (flightLink) {
                const m = /flight\?id=(\d+)/.exec(flightLink.getAttribute("href") || "")
                if (m) flightId = parseInt(m[1], 10)
            }

            const isOurs = RouteAssistantMarketsPageScraper.isOurFlightCode(flightCode, ourPrefix)

            list.push({
                flightCode, flightId, typeCode, typeId,
                depDateUtc, depDateLocal, depTimeUtc, depTimeLocal,
                arrTimeUtc, arrTimeLocal,
                serviceClass, availability, price, status, isOurs
            })
        }
        return list
    }

    static _currentAirlinePrefixes() {
        // Best-effort — only works on /app/* pages where AES.getAirlineIdentity
        // can read the navbar. Used as the "isOurs" hint for competitors so
        // we exclude our own flights from competitor-median calculations.
        // For most users the AS carrier code = initials of the display name
        // (verified: "FLY NYON." → "FN" matches actual code). For users
        // whose code DIFFERS from initials (rare), set the override in
        // settings.routeAssistant.ors.airlineCarrierPrefixOverride and
        // panel.js will re-flag isOurs at load time.
        try {
            if (typeof AES === "undefined" || !AES.getAirlineIdentity) return []
            const ident = AES.getAirlineIdentity() || ""
            if (!ident) return []
            const initials = ident.replace(/[^A-Za-z\s]/g, "")
                .split(/\s+/)
                .filter(Boolean)
                .map(w => w[0].toUpperCase())
                .join("")
            return initials ? [initials] : []
        } catch (e) {
            return []
        }
    }

    /**
     * Match a parsed flight code against a list of carrier prefixes.
     * Public so panel.js can re-flag `isOurs` after load using prefixes
     * derived from the schedule cache (RouteAssistantOrsScraper.
     * getOurCarrierPrefixes) when the user has set an override.
     */
    static isOurFlightCode(flightCode, prefixes) {
        if (!flightCode || !prefixes || !prefixes.length) return false
        const code = String(flightCode).trim().toUpperCase()
        for (const p of prefixes) {
            if (!p) continue
            const pu = String(p).toUpperCase()
            if (code.startsWith(pu + " ") || code === pu) return true
        }
        return false
    }

    static _extractTitlePart(title, marker) {
        if (!title || !marker) return null
        // title format: "2026-04-24 UTC / 2026-04-23 HT / 2026-04-23 LT"
        const parts = title.split("/").map(s => s.trim())
        for (const p of parts) {
            if (p.endsWith(" " + marker)) {
                return p.substring(0, p.length - marker.length - 1).trim()
            }
        }
        return null
    }

    static _parseInt(text) {
        if (text == null) return null
        const m = /-?\d[\d,.]*/.exec(String(text).replace(/[^\d,.\-]/g, " "))
        if (!m) return null
        const n = parseInt(m[0].replace(/[,.\s]/g, ""), 10)
        return isFinite(n) ? n : null
    }

    // ------------------------------------------------------------------
    // Own pricing parser
    // ------------------------------------------------------------------

    static _parseOwnPricing(doc) {
        // The pricing fieldset has <legend>Pricing</legend>.
        let pricingFs = null
        for (const fs of doc.querySelectorAll("fieldset")) {
            const legend = fs.querySelector("legend")
            if (legend && /^pricing$/i.test((legend.textContent || "").trim())) {
                pricingFs = fs
                break
            }
        }
        if (!pricingFs) return null

        const prices   = {}
        const defaults = {}
        const sliderRanges = {}

        const rows = pricingFs.querySelectorAll("table tbody tr")
        for (const tr of rows) {
            const cells = tr.querySelectorAll("td")
            if (cells.length < 5) continue
            // [0] class label, [1] current price, [2] new-price input,
            // [3] slider div, [4] default price + reset link
            const cls = (cells[0].textContent || "").trim()
            const cur = RouteAssistantMarketsPageScraper._parseInt(cells[1].textContent)
            const newInp = cells[2].querySelector("input[type='text']")
            const newVal = newInp ? RouteAssistantMarketsPageScraper._parseInt(newInp.getAttribute("value")) : cur
            const defSpan = cells[4].querySelector("span")
            const defVal = defSpan ? RouteAssistantMarketsPageScraper._parseInt(defSpan.textContent)
                                   : RouteAssistantMarketsPageScraper._parseInt(cells[4].textContent)
            if (cls) {
                prices[cls]   = newVal != null ? newVal : cur
                defaults[cls] = defVal
            }
        }

        // Slider ranges live in inline <script> body — regex out the slider({…}) calls.
        // Pattern: $("#idfXX").slider({ range: "min", value: NNN, min: 1, max: NNN, ... })
        // Each row's <td.slider-cell><div class="slider" id="idfXX"></div></td> ties an
        // id back to a row, but for the storage shape we only need per-class ranges,
        // so we walk in document order and pair sliders to the rows we just parsed.
        const scriptText = RouteAssistantMarketsPageScraper._collectScriptText(doc)
        const sliderRe = /slider\(\s*\{[^}]*?value:\s*(\d+)\s*,\s*min:\s*(\d+)\s*,\s*max:\s*(\d+)/g
        const sliderMatches = []
        let sm
        while ((sm = sliderRe.exec(scriptText)) !== null) {
            sliderMatches.push({value: +sm[1], min: +sm[2], max: +sm[3]})
        }
        const classOrder = Object.keys(prices)
        for (let i = 0; i < classOrder.length && i < sliderMatches.length; i++) {
            sliderRanges[classOrder[i]] = [sliderMatches[i].min, sliderMatches[i].max]
        }

        // General settings — four <select>s in the General Settings fieldset.
        const generalSettings = {}
        let generalFs = null
        for (const fs of doc.querySelectorAll("fieldset")) {
            const legend = fs.querySelector("legend")
            if (legend && /^general\s*settings$/i.test((legend.textContent || "").trim())) {
                generalFs = fs
                break
            }
        }
        if (generalFs) {
            const grab = (matchKey, outKey) => {
                for (const sel of generalFs.querySelectorAll("select")) {
                    const name = sel.getAttribute("name") || ""
                    if (name.toLowerCase().indexOf(matchKey) >= 0) {
                        const opt = sel.options[sel.selectedIndex]
                        generalSettings[outKey] = opt
                            ? ((opt.textContent || "").trim() || opt.getAttribute("value") || null)
                            : null
                        return
                    }
                }
            }
            grab("originterminal",      "originTerminal")
            grab("destinationterminal", "destinationTerminal")
            grab("serviceprofile",      "serviceProfile")
            grab("boardingpreference",  "boardingPreference")
            grab("cargopreference",     "cargoPreference")

            // Service profile *id* — separate from the label so the
            // service-profile-detail scraper can fetch /serviceProfile?id=N
            // for per-class catering quality without re-scraping this page.
            for (const sel of generalFs.querySelectorAll("select")) {
                const name = sel.getAttribute("name") || ""
                if (name.toLowerCase().indexOf("serviceprofile") < 0) continue
                const opt = sel.options[sel.selectedIndex]
                const v = opt && opt.getAttribute("value")
                if (v && /^\d+$/.test(v)) {
                    generalSettings.serviceProfileId = parseInt(v, 10)
                } else {
                    generalSettings.serviceProfileId = null
                }
                break
            }
        }

        return {prices, defaults, sliderRanges, generalSettings}
    }

    // ------------------------------------------------------------------
    // Market share parser
    // ------------------------------------------------------------------

    static _parseMarketShare(doc) {
        const out = {period: null, pax: [], cargo: []}

        // Period — .periodSelection .current span
        const periodEl = doc.querySelector(".periodSelection .current span")
        if (periodEl) out.period = (periodEl.textContent || "").trim() || null

        for (const block of doc.querySelectorAll(".marketShareData")) {
            const h4 = block.querySelector("h4")
            const heading = h4 ? (h4.textContent || "").trim().toLowerCase() : ""
            const rows = []
            // Each entry is two consecutive tr's — the first has rank/name/share,
            // the second has the colspan="3" progress bar (skip).
            for (const tr of block.querySelectorAll("tbody tr")) {
                const tds = tr.querySelectorAll("td")
                if (tds.length < 4) continue   // skip the colspan-3 progress row
                const rankEl = tds[0].querySelector("span")
                const rank = rankEl ? RouteAssistantMarketsPageScraper._parseInt(rankEl.textContent) : null
                const nameLink = tds[1].querySelector("a")
                const name = nameLink ? (nameLink.textContent || "").trim() : (tds[1].textContent || "").trim()
                let enterpriseId = null
                if (nameLink) {
                    const m = /enterprises\/(\d+)/.exec(nameLink.getAttribute("href") || "")
                    if (m) enterpriseId = parseInt(m[1], 10)
                }
                const sharePct = RouteAssistantMarketsPageScraper._parsePct(tds[2].textContent)
                const change   = RouteAssistantMarketsPageScraper._parsePct(tds[3].textContent)
                rows.push({rank, name, enterpriseId, sharePct, change})
            }
            if (heading.indexOf("passenger") >= 0) out.pax = rows
            else if (heading.indexOf("cargo") >= 0) out.cargo = rows
        }
        return out
    }

    static _parsePct(text) {
        if (!text) return null
        const m = /(-?\d+(?:\.\d+)?)\s*%/.exec(text)
        return m ? parseFloat(m[1]) : null
    }

    // ------------------------------------------------------------------
    // Historic chart parser
    // ------------------------------------------------------------------

    static _parseHistoricFromDoc(doc) {
        return RouteAssistantMarketsPageScraper._parseHistoricFromHtml(
            RouteAssistantMarketsPageScraper._collectScriptText(doc)
        )
    }

    static _parseHistoricFromHtml(html) {
        if (!html) return null
        // The page has two lineChart setData calls in order:
        //   idf08Chart.setData([{period, capacities}, …])   ← capacities
        //   idf09Chart.setData([{period, prices},     …])   ← prices
        // Match both .setData([…]) JSON arrays.
        const setDataRe = /\.setData\s*\(\s*(\[[\s\S]*?\])\s*\)/g
        const arrays = []
        let m
        while ((m = setDataRe.exec(html)) !== null) {
            try {
                const parsed = JSON.parse(m[1])
                if (Array.isArray(parsed)) arrays.push(parsed)
            } catch (e) { /* skip non-JSON */ }
        }
        if (arrays.length < 2) return null

        // arrays[0] = capacities, arrays[1] = prices. Each item:
        // {period: 202545, capacities: 0} or {period: 202545, prices: 149}
        const capArr = arrays[0]
        const priceArr = arrays[1]
        const periods = capArr.map(r => String(r.period))
        const capacities = capArr.map(r => Number(r.capacities) || 0)
        // Match prices to periods by position (both arrays cover the same window).
        const prices = priceArr.map(r => Number(r.prices) || 0)
        // Default rendered payload is whatever's selected in #idf07.
        // We can't tell from raw script text reliably, so default to ECONOMY
        // (the page's default-render selection per HTML sample).
        return {payload: "ECONOMY", periods, capacities, prices}
    }

    static _collectScriptText(doc) {
        if (!doc) return ""
        const out = []
        for (const s of doc.querySelectorAll("script")) {
            if (s.textContent) out.push(s.textContent)
        }
        return out.join("\n")
    }

    // ------------------------------------------------------------------
    // Bulk-scrape orchestrator (mirror of schedule-page-scraper.js 322–363)
    // ------------------------------------------------------------------

    /**
     * Run a bulk scrape over a list of {hub, dest} pairs with concurrency +
     * stagger control. Awaits the lot. Used by the "Sync market analysis for
     * all visible routes" CTA in the Market Analysis expander.
     *
     * @param {Array<{hub, dest}>} pairs
     * @param {object} opts - {concurrency, staggerMs, onProgress(done, total)}
     */
    async bulkScrape(pairs, opts) {
        opts = opts || {}
        const concurrency = Math.max(1, Math.min(10, opts.concurrency || 4))
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
