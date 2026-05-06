/**
 * AES Station Automation — country / region scraping and filtering.
 *
 * Populates two things for the dashboard + worker:
 *   1. The list of countries (id / code / name) from /action/info/countries.
 *   2. The list of airports in a selected country, with size/capacity plus
 *      pax and cargo demand scored 0–10 from AS's bar-graph cells. Sources:
 *        - /action/info/country?id=<id> (airports listed directly)
 *        - /action/info/county?id=<id>  (region listing inside a larger
 *          country like the USA — AS spells the URL "county")
 *
 * Parsing is defensive: the scraper tolerates small markup changes, logs a
 * warning on failure rather than throwing, and returns an empty array so a
 * failure in one country doesn't abort the whole run.
 */
class CountryScraper {
    static FILL_CLASS_RE = /(^|[\s-_.])(fill(ed)?|active|on|good|green|high|ok|bar-filled|bar-on|demand-bar-filled)(\s|$|[-_.])/i
    static EMPTY_CLASS_RE = /(^|[\s-_.])(empty|off|inactive|bad|low|grey|gray|disabled|bar-empty|bar-off|demand-bar-empty)(\s|$|[-_.])/i
    static FILL_IMG_RE = /full|filled|on\b|active|high/
    static EMPTY_IMG_RE = /empty|off\b|inactive|low/
    static RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
    static FETCH_RETRY_LIMIT = 3
    static FETCH_BASE_BACKOFF_MS = 2500
    static FETCH_TIMEOUT_MS = 30000
    static REGION_FETCH_CONCURRENCY = 2
    static REGION_BATCH_DELAY_MS = 2000

    static async loadCountriesList(server) {
        const doc = await CountryScraper._fetchDoc(`https://${server}.airlinesim.aero/action/info/countries`)
        if (!doc) return []

        const byId = new Map()
        const tables = doc.getElementsByTagName("table")
        for (let i = 0; i < tables.length; i++) {
            const table = tables[i]
            const cols = CountryScraper._detectCountryColumns(table)
            if (cols.nameIdx == null) continue

            const rows = table.rows
            if (!rows) continue
            for (const row of rows) {
                if (row.getElementsByTagName("th").length && !row.getElementsByTagName("td").length) continue
                const cells = row.cells
                if (!cells || cells.length < 2) continue

                let idMatch = null
                const links = row.getElementsByTagName("a")
                for (let k = 0; k < links.length; k++) {
                    const href = links[k].getAttribute("href") || ""
                    if (href.indexOf("country?id=") !== -1) {
                        idMatch = href.match(/id=(\d+)/)
                        break
                    }
                }
                if (!idMatch) continue
                const id = idMatch[1]
                if (byId.has(id)) continue

                const name = (cells[cols.nameIdx]?.textContent || "").trim()
                    || (row.querySelector("a[href*='country?id=']")?.textContent || "").trim()
                const code = cols.codeIdx != null
                    ? (cells[cols.codeIdx]?.textContent || "").trim().toUpperCase()
                    : ""
                const airportsCount = cols.airportsIdx != null
                    ? parseInt((cells[cols.airportsIdx]?.textContent || "").replace(/\D+/g, ""), 10) || 0
                    : 0
                if (id && name) byId.set(id, {id, code, name, airportsCount})
            }
        }

        return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
    }

    static _detectCountryColumns(table) {
        const out = {nameIdx: null, codeIdx: null, airportsIdx: null}
        let hasLink = false
        const links = table.getElementsByTagName("a")
        for (let i = 0; i < links.length; i++) {
            if ((links[i].getAttribute("href") || "").indexOf("country?id=") !== -1) {
                hasLink = true
                break
            }
        }
        if (!hasLink) return out

        const head = table.tHead ? table.tHead.rows[0] : (table.rows.length > 0 ? table.rows[0] : null)
        const headerCells = head && head.cells ? Array.from(head.cells) : []
        headerCells.forEach((cell, i) => {
            const t = (cell.textContent || "").trim().toLowerCase()
            if (!t) return
            if (out.nameIdx == null && (t === "name" || t === "country" || t.includes("country name"))) out.nameIdx = i
            else if (out.codeIdx == null && (t === "code" || t.includes("iso") || t.includes("country code"))) out.codeIdx = i
            else if (out.airportsIdx == null && t.includes("airport")) out.airportsIdx = i
        })

        // Fall back to the historical "[flag] Name | Code | Airports" layout.
        if (out.nameIdx == null) {
            out.nameIdx = 1
            if (out.codeIdx == null) out.codeIdx = 2
            if (out.airportsIdx == null) out.airportsIdx = 3
        }
        return out
    }

    static async resolveStations(entry, server) {
        const airports = await CountryScraper._getAllAirportsForCountry(entry.countryId, server)
        const exceptions = new Set((entry.exceptions || []).map(s => String(s).toUpperCase()))
        // When `airportWhitelist` is set, the entry came from a bulk-target
        // flow (Schedule panel's "Open stations at scraped airports") that
        // already chose specific airports — thresholds are bypassed and only
        // listed IATAs pass. `exceptions` still applies as a defensive
        // overlap so a single revoke from the bulk list still works.
        const whitelist = entry.airportWhitelist && entry.airportWhitelist.length
            ? new Set(entry.airportWhitelist.map(s => String(s).toUpperCase()))
            : null
        const ranges = CountryScraper._normaliseStationFilter(entry)
        return airports.filter(a => {
            const iata = a.iata.toUpperCase()
            if (exceptions.has(iata)) return false
            if (whitelist) return whitelist.has(iata)
            return CountryScraper._scoreInRange(a.paxScore, ranges.paxMin, ranges.paxMax)
                && CountryScraper._scoreInRange(a.cargoScore, ranges.cargoMin, ranges.cargoMax)
                && CountryScraper._scoreInRange(a.sizeScore, ranges.sizeMin, ranges.sizeMax)
        })
    }

    static _normaliseStationFilter(entry) {
        const legacyPax = CountryScraper._scoreOrDefault(entry && entry.paxThreshold, 0)
        const legacyCargo = CountryScraper._scoreOrDefault(entry && entry.cargoThreshold, 0)
        return {
            paxMin:   CountryScraper._scoreOrDefault(entry && entry.paxMin, legacyPax),
            paxMax:   CountryScraper._scoreOrDefault(entry && entry.paxMax, 10),
            cargoMin: CountryScraper._scoreOrDefault(entry && entry.cargoMin, legacyCargo),
            cargoMax: CountryScraper._scoreOrDefault(entry && entry.cargoMax, 10),
            sizeMin:  CountryScraper._scoreOrDefault(entry && entry.sizeMin, 0),
            sizeMax:  CountryScraper._scoreOrDefault(entry && entry.sizeMax, 10),
        }
    }

    static _scoreOrDefault(value, fallback) {
        const n = Number(value)
        return Number.isFinite(n) ? clampScore(Math.round(n)) : fallback
    }

    static _scoreInRange(value, min, max) {
        const n = Number(value)
        if (!Number.isFinite(n)) return min <= 0 && max >= 10
        const lo = Math.min(min, max)
        const hi = Math.max(min, max)
        return n >= lo && n <= hi
    }

    /**
     * Scrapes /app/ops/stations for the IATA codes of the airline's existing
     * stations. Used by the dashboard before a run so we don't waste tabs
     * re-opening stations the airline already operates (including ones opened
     * by a previous, partial run — the airline's own state is the source of
     * truth for "where we left off").
     * @param {string} server
     * @returns {Promise<Set<string>>}
     */
    static async loadExistingStationIatas(server) {
        const doc = await CountryScraper._fetchDoc(`https://${server}.airlinesim.aero/app/ops/stations`)
        if (!doc) return new Set()
        const iatas = new Set()
        // 1. Links to station-detail pages carry the IATA in the path.
        const allLinks = doc.getElementsByTagName("a")
        for (let i = 0; i < allLinks.length; i++) {
            const href = allLinks[i].getAttribute("href") || ""
            if (href.indexOf("/ops/stations/") !== -1 || href.indexOf("ops/stations/") !== -1) {
                const m = href.match(/\/stations\/([A-Za-z]{3})(?:[/?#]|$)/)
                if (m) iatas.add(m[1].toUpperCase())
            }
        }
        // 2. Station-looking tables: any 3-letter all-caps cell is a plausible IATA.
        const allTables = doc.getElementsByTagName("table")
        const stationTables = Array.from(allTables).filter(t => {
            const head = t.tHead ? t.tHead.rows[0] : (t.rows.length > 0 ? t.rows[0] : null)
            const h = (head ? head.textContent : "").toLowerCase()
            return h.includes("iata") || h.includes("code") || h.includes("station") || h.includes("apt")
        })
        for (const table of stationTables) {
            const rows = table.rows
            if (!rows) continue
            for (const row of rows) {
                if (row.getElementsByTagName("th").length && !row.getElementsByTagName("td").length) continue
                const cells = row.cells
                if (!cells) continue
                for (const td of cells) {
                    const txt = (td.textContent || "").trim().toUpperCase()
                    if (/^[A-Z]{3}$/.test(txt)) iatas.add(txt)
                }
            }
        }
        console.log(`[AES stationAutomation] existing stations: ${iatas.size} (${Array.from(iatas).sort().join(", ") || "none"})`)
        return iatas
    }

    static async _getAllAirportsForCountry(countryId, server) {
        const doc = await CountryScraper._fetchDoc(
            `https://${server}.airlinesim.aero/action/info/country?id=${encodeURIComponent(countryId)}`
        )
        if (!doc) return []

        const direct = CountryScraper._parseAirportsTable(doc)
        if (direct.length) return direct

        const regionIds = []
        const links = doc.getElementsByTagName("a")
        for (let i = 0; i < links.length; i++) {
            const href = links[i].getAttribute("href") || ""
            if (href.indexOf("county?id=") !== -1) {
                const m = href.match(/id=(\d+)/)
                if (m && !regionIds.includes(m[1])) regionIds.push(m[1])
            }
        }

        // Throttle region fetches to avoid AS rate-limiting — a country like
        // USA has 50+ regions and firing them all at once had some regions
        // quietly come back 429/503 with 0 airports.
        const CONCURRENCY = Math.max(1, Number(CountryScraper.REGION_FETCH_CONCURRENCY) || 2)
        const regionResults = []
        let failedRegions = 0
        for (let i = 0; i < regionIds.length; i += CONCURRENCY) {
            const batch = regionIds.slice(i, i + CONCURRENCY)
            const results = await Promise.all(batch.map(id =>
                CountryScraper._fetchDoc(`https://${server}.airlinesim.aero/action/info/county?id=${encodeURIComponent(id)}`)
                    .then(regionDoc => {
                        if (!regionDoc) { failedRegions++; return [] }
                        return CountryScraper._parseAirportsTable(regionDoc)
                    })
            ))
            regionResults.push(...results)
            if (i + CONCURRENCY < regionIds.length) {
                await CountryScraper._sleep(CountryScraper.REGION_BATCH_DELAY_MS)
            }
        }

        const seen = new Set()
        const aggregated = []
        regionResults.forEach((airports, i) => {
            for (const ap of airports) {
                if (!ap.iata || seen.has(ap.iata)) continue
                seen.add(ap.iata)
                aggregated.push(ap)
            }
        })
        console.log(`[AES stationAutomation] country ${countryId}: ${regionIds.length} regions, ${failedRegions} failed, ${aggregated.length} airports.`)
        return aggregated
    }

    static _parseAirportsTable(doc) {
        const tables = doc.getElementsByTagName("table")
        for (let i = 0; i < tables.length; i++) {
            const table = tables[i]
            const head = table.tHead ? table.tHead.rows[0] : (table.rows.length > 0 ? table.rows[0] : null)
            const headerText = (head ? head.textContent : "").toLowerCase()
            // "passeng" matches both "Passengers" and "Passenger demand".
            if (!headerText.includes("iata") || !headerText.includes("passeng")) continue
            return CountryScraper._readAirportRows(table)
        }
        return []
    }

    static _readAirportRows(table) {
        const idx = {name: 0, iata: 1, icao: 2, runway: 3, size: 4, pax: 5, cargo: 6}
        const head = table.tHead ? table.tHead.rows[0] : (table.rows.length > 0 ? table.rows[0] : null)
        const headerCells = head && head.cells ? Array.from(head.cells) : []
        headerCells.forEach((th, i) => {
            const t = (th.textContent || "").trim().toLowerCase()
            if (!t) return
            if (t === "name") idx.name = i
            else if (t.includes("iata")) idx.iata = i
            else if (t.includes("icao")) idx.icao = i
            else if (t.includes("runway")) idx.runway = i
            else if (t.includes("size")) idx.size = i
            else if (t.includes("passeng") || t.includes("pax")) idx.pax = i
            else if (t.includes("cargo")) idx.cargo = i
        })

        const airports = []
        const tbody = table.tBodies.length > 0 ? table.tBodies[0] : null
        const rows = tbody ? tbody.rows : []
        for (const row of rows) {
            const cells = row.cells
            if (!cells || cells.length < 3) continue
            const iata = (cells[idx.iata]?.textContent || "").trim().toUpperCase()
            if (!/^[A-Z]{3}$/.test(iata)) continue
            const name = (cells[idx.name]?.textContent || "").trim()
            let airportLink = null
            const links = row.getElementsByTagName("a")
            for (let k = 0; k < links.length; k++) {
                if ((links[k].getAttribute("href") || "").indexOf("airport") !== -1) {
                    airportLink = links[k]
                    break
                }
            }
            const airportIdMatch = airportLink?.getAttribute("href")?.match(/id=(\d+)|airports\/(\d+)/)
            const airportId = airportIdMatch ? (airportIdMatch[1] || airportIdMatch[2]) : null
            airports.push({
                iata, name, airportId,
                sizeScore: CountryScraper._readDemandBars(cells[idx.size]),
                paxScore: CountryScraper._readDemandBars(cells[idx.pax]),
                cargoScore: CountryScraper._readDemandBars(cells[idx.cargo]),
            })
        }
        return airports
    }

    /**
     * Scores a demand cell 0–10. AS renders each cell as a single
     * `<img src=".../demand/<N>.png" alt="pax 8">` where the alt text carries
     * the 0–10 score directly — preferred when present. Unknown markup returns
     * 10 so the threshold filter fails open rather than silently dropping
     * every airport.
     */
    static _readDemandBars(cell) {
        if (!cell) return 0

        const imgs = cell.getElementsByTagName("img")
        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i]
            const alt = (img.getAttribute("alt") || "").trim()
            const m = alt.match(/(?:pax|passenger|cargo|demand)\s*(\d+)/i) || alt.match(/^(\d+)$/)
            if (m) return clampScore(parseInt(m[1], 10))
            const src = img.getAttribute("src") || ""
            const srcMatch = src.match(/demand\/(\d+)\.(?:png|jpg|gif|svg)/i)
            // The filename is 1-indexed (1.png = score 0, 11.png = score 10),
            // so subtract 1 to get the actual score.
            if (srcMatch) return clampScore(parseInt(srcMatch[1], 10) - 1)
        }

        const descendants = cell.getElementsByTagName("*")
        const attrBag = Array.from(descendants).concat(cell)
            .flatMap(el => [
                el.getAttribute?.("title"),
                el.getAttribute?.("aria-label"),
                el.getAttribute?.("data-demand"),
                el.getAttribute?.("data-value"),
            ]).filter(Boolean).join(" ")
        const slash = attrBag.match(/(\d+)\s*\/\s*10/)
        if (slash) return clampScore(parseInt(slash[1], 10))

        const bars = Array.from(descendants).filter(el => el.children.length === 0)

        if (bars.length >= 2) {
            let filled = 0, empty = 0
            for (const el of bars) {
                const cls = el.className?.baseVal ?? el.className ?? ""
                if (typeof cls !== "string") continue
                if (CountryScraper.FILL_CLASS_RE.test(cls)) filled++
                else if (CountryScraper.EMPTY_CLASS_RE.test(cls)) empty++
            }
            if (filled + empty >= 2) return scoreFromRatio(filled, filled + empty)
            if (filled > 0) return scoreFromRatio(filled, bars.length)

            let bgFilled = 0
            for (const el of bars) {
                const style = el.getAttribute("style") || ""
                if (/background(-color)?:\s*(?!transparent|none|#?0{3,6}\b|rgba?\([^)]*\b0\s*\))/i.test(style)) bgFilled++
            }
            if (bgFilled > 0) return scoreFromRatio(bgFilled, bars.length)
        }

        let pb = null
        for (let i = 0; i < descendants.length; i++) {
            const s = descendants[i].getAttribute("style") || ""
            if (s.indexOf("width") !== -1) {
                pb = descendants[i]
                break
            }
        }
        if (pb) {
            const m = (pb.getAttribute("style") || "").match(/width:\s*(\d+(?:\.\d+)?)%/)
            if (m) return clampScore(Math.round(parseFloat(m[1]) / 10))
        }

        if (imgs.length >= 2) {
            let filled = 0, empty = 0
            for (const img of imgs) {
                const src = (img.getAttribute("src") || "").toLowerCase()
                if (CountryScraper.FILL_IMG_RE.test(src)) filled++
                else if (CountryScraper.EMPTY_IMG_RE.test(src)) empty++
            }
            if (filled + empty >= 2) return scoreFromRatio(filled, filled + empty)
        }

        const text = (cell.textContent || "").trim()
        if (text) {
            const filledChars = (text.match(/[█■▓◼⬛]/g) || []).length
            if (filledChars) return Math.min(10, filledChars)
            const digitOnly = text.match(/^\s*(\d+)\s*$/)
            if (digitOnly) return clampScore(parseInt(digitOnly[1], 10))
        }

        if (!cell._aesDemandWarned) {
            console.warn("[AES stationAutomation] demand markup unrecognized; defaulting score=10. Cell:", cell)
            cell._aesDemandWarned = true
        }
        return 10
    }

    static async _fetchDoc(url) {
        const limit = Math.max(0, Number(CountryScraper.FETCH_RETRY_LIMIT) || 0)
        for (let attempt = 0; attempt <= limit; attempt++) {
            let timeoutId = null
            let controller = null
            try {
                const opts = {credentials: "include"}
                const timeoutMs = Math.max(0, Number(CountryScraper.FETCH_TIMEOUT_MS) || 0)
                if (timeoutMs && typeof AbortController !== "undefined") {
                    controller = new AbortController()
                    opts.signal = controller.signal
                    timeoutId = setTimeout(() => controller.abort(), timeoutMs)
                }
                const resp = await fetch(url, opts)
                if (!resp.ok) {
                    if (attempt < limit && CountryScraper.RETRY_STATUSES.has(resp.status)) {
                        const delay = CountryScraper._retryDelayMs(resp, attempt)
                        console.warn(`[AES stationAutomation] ${url} returned HTTP ${resp.status}; retrying in ${delay}ms`)
                        await CountryScraper._sleep(delay)
                        continue
                    }
                    console.warn(`[AES stationAutomation] ${url} returned HTTP ${resp.status}`)
                    return null
                }
                const html = await resp.text()
                return new DOMParser().parseFromString(html, "text/html")
            } catch (error) {
                const timedOut = error && error.name === "AbortError"
                if (attempt < limit) {
                    const delay = CountryScraper._retryDelayMs(null, attempt)
                    console.warn(`[AES stationAutomation] fetch ${timedOut ? "timed out" : "failed"} for ${url}; retrying in ${delay}ms`, error)
                    await CountryScraper._sleep(delay)
                    continue
                }
                console.warn(`[AES stationAutomation] fetch ${timedOut ? "timed out" : "failed"} for ${url}`, error)
                return null
            } finally {
                if (timeoutId) clearTimeout(timeoutId)
            }
        }
        return null
    }

    static _retryDelayMs(resp, attempt) {
        const retryAfter = resp && resp.headers && resp.headers.get
            ? resp.headers.get("retry-after")
            : null
        if (retryAfter) {
            const seconds = Number(retryAfter)
            if (Number.isFinite(seconds) && seconds >= 0) {
                return Math.min(60000, Math.max(1000, seconds * 1000))
            }
            const at = Date.parse(retryAfter)
            if (Number.isFinite(at)) {
                return Math.min(60000, Math.max(1000, at - Date.now()))
            }
        }
        const base = Number(CountryScraper.FETCH_BASE_BACKOFF_MS) || 2500
        return Math.min(60000, base * Math.pow(2, Math.max(0, attempt)))
    }

    static _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
    }
}

function clampScore(n) { return Math.max(0, Math.min(10, n)) }
function scoreFromRatio(filled, total) { return Math.max(1, Math.min(10, Math.round((filled / total) * 10))) }

if (typeof window !== "undefined") {
    window.CountryScraper = CountryScraper
} else if (typeof globalThis !== "undefined") {
    globalThis.CountryScraper = CountryScraper
}
