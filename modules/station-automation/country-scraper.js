/**
 * AES Station Automation — country / region scraping and filtering.
 *
 * Populates two things for the dashboard + worker:
 *   1. The list of countries (id / code / name) from /action/info/countries.
 *   2. The list of airports in a selected country, with pax and cargo demand
 *      scored 0–10 from AS's bar-graph cells. Sources:
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

    static async loadCountriesList(server) {
        const doc = await CountryScraper._fetchDoc(`https://${server}.airlinesim.aero/action/info/countries`)
        if (!doc) return []

        const byId = new Map()
        for (const table of doc.querySelectorAll("table")) {
            const cols = CountryScraper._detectCountryColumns(table)
            if (cols.nameIdx == null) continue

            for (const row of table.querySelectorAll("tbody tr, tr")) {
                if (row.querySelector("th") && !row.querySelector("td")) continue
                const cells = row.querySelectorAll("td")
                if (cells.length < 2) continue
                const idMatch = row.querySelector("a[href*='country?id=']")?.getAttribute("href")?.match(/id=(\d+)/)
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
        if (!table.querySelector("a[href*='country?id=']")) return out

        const headerCells = table.querySelectorAll("thead th, tr:first-child th, tr:first-child td")
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
        return airports.filter(a =>
            !exceptions.has(a.iata.toUpperCase()) &&
            (a.paxScore || 0) >= (entry.paxThreshold || 0) &&
            (a.cargoScore || 0) >= (entry.cargoThreshold || 0)
        )
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
        for (const a of doc.querySelectorAll("a[href*='/ops/stations/'], a[href*='ops/stations/']")) {
            const m = (a.getAttribute("href") || "").match(/\/stations\/([A-Za-z]{3})(?:[/?#]|$)/)
            if (m) iatas.add(m[1].toUpperCase())
        }
        // 2. Station-looking tables: any 3-letter all-caps cell is a plausible IATA.
        const stationTables = Array.from(doc.querySelectorAll("table")).filter(t => {
            const h = (t.querySelector("thead")?.textContent || t.querySelector("tr")?.textContent || "").toLowerCase()
            return h.includes("iata") || h.includes("code") || h.includes("station") || h.includes("apt")
        })
        for (const table of stationTables) {
            for (const row of table.querySelectorAll("tbody tr, tr")) {
                if (row.querySelector("th") && !row.querySelector("td")) continue
                for (const td of row.querySelectorAll("td")) {
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
        doc.querySelectorAll("a[href*='county?id=']").forEach(a => {
            const m = a.getAttribute("href").match(/id=(\d+)/)
            if (m && !regionIds.includes(m[1])) regionIds.push(m[1])
        })

        // Throttle region fetches to avoid AS rate-limiting — a country like
        // USA has 50+ regions and firing them all at once had some regions
        // quietly come back 429/503 with 0 airports.
        const CONCURRENCY = 6
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
        for (const table of doc.querySelectorAll("table")) {
            const headerText = (table.querySelector("thead, tr:first-child")?.textContent || "").toLowerCase()
            // "passeng" matches both "Passengers" and "Passenger demand".
            if (!headerText.includes("iata") || !headerText.includes("passeng")) continue
            return CountryScraper._readAirportRows(table)
        }
        return []
    }

    static _readAirportRows(table) {
        const idx = {name: 0, iata: 1, icao: 2, runway: 3, size: 4, pax: 5, cargo: 6}
        const headerCells = table.querySelectorAll("thead th, tr:first-child th, tr:first-child td")
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
        for (const row of table.querySelectorAll("tbody tr")) {
            const cells = row.querySelectorAll("td")
            if (cells.length < 3) continue
            const iata = (cells[idx.iata]?.textContent || "").trim().toUpperCase()
            if (!/^[A-Z]{3}$/.test(iata)) continue
            const name = (cells[idx.name]?.textContent || "").trim()
            const airportLink = row.querySelector("a[href*='airport']")
            const airportIdMatch = airportLink?.getAttribute("href")?.match(/id=(\d+)|airports\/(\d+)/)
            const airportId = airportIdMatch ? (airportIdMatch[1] || airportIdMatch[2]) : null
            airports.push({
                iata, name, airportId,
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

        for (const img of cell.querySelectorAll("img")) {
            const alt = (img.getAttribute("alt") || "").trim()
            const m = alt.match(/(?:pax|passenger|cargo|demand)\s*(\d+)/i) || alt.match(/^(\d+)$/)
            if (m) return clampScore(parseInt(m[1], 10))
            const src = img.getAttribute("src") || ""
            const srcMatch = src.match(/demand\/(\d+)\.(?:png|jpg|gif|svg)/i)
            // The filename is 1-indexed (1.png = score 0, 11.png = score 10),
            // so subtract 1 to get the actual score.
            if (srcMatch) return clampScore(parseInt(srcMatch[1], 10) - 1)
        }

        const descendants = cell.querySelectorAll("*")
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

        const pb = cell.querySelector("[style*='width']")
        if (pb) {
            const m = (pb.getAttribute("style") || "").match(/width:\s*(\d+(?:\.\d+)?)%/)
            if (m) return clampScore(Math.round(parseFloat(m[1]) / 10))
        }

        const imgs = cell.querySelectorAll("img")
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
        try {
            const resp = await fetch(url, {credentials: "include"})
            if (!resp.ok) {
                console.warn(`[AES stationAutomation] ${url} returned HTTP ${resp.status}`)
                return null
            }
            const html = await resp.text()
            return new DOMParser().parseFromString(html, "text/html")
        } catch (error) {
            console.warn(`[AES stationAutomation] fetch failed for ${url}`, error)
            return null
        }
    }
}

function clampScore(n) { return Math.max(0, Math.min(10, n)) }
function scoreFromRatio(filled, total) { return Math.max(1, Math.min(10, Math.round((filled / total) * 10))) }
