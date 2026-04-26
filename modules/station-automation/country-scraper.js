/**
 * Resolves the list of stations for a country and applies the queue entry's
 * demand-threshold and exceptions filters.
 *
 * The actual DOM scraping is a stub until the AirlineSim country/region page
 * structure has been confirmed. Fill in `_scrapeCountryPage()` after inspecting:
 *   - URL of the "country info" / "stations in country" page
 *   - The table selector that lists airports
 *   - Which cells hold the IATA code, pax demand, cargo demand
 *
 * Every consumer goes through `resolveStations()` so changing the scrape
 * details touches only this file.
 */
class CountryScraper {
    /**
     * @param {object} entry - queue entry
     *   {country, paxThreshold, cargoThreshold, exceptions: string[]}
     * @param {string} server - e.g. "tristar"
     * @returns {Promise<string[]>} IATA codes that pass the filter
     */
    static async resolveStations(entry, server) {
        const stations = await CountryScraper._getCountryStations(entry.country, server)
        const exceptions = new Set((entry.exceptions || []).map(s => s.toUpperCase()))

        return stations
            .filter(station => !exceptions.has(station.iata.toUpperCase()))
            .filter(station => (station.paxDemand || 0) >= (entry.paxThreshold || 0))
            .filter(station => (station.cargoDemand || 0) >= (entry.cargoThreshold || 0))
            .map(station => station.iata)
    }

    /**
     * Returns the full list of stations for a country, using a simple
     * in-memory cache so repeat lookups within a session don't re-fetch.
     */
    static async _getCountryStations(countryCode, server) {
        if (!CountryScraper._cache) {
            CountryScraper._cache = {}
        }
        const cacheKey = server + ":" + countryCode
        if (!CountryScraper._cache[cacheKey]) {
            CountryScraper._cache[cacheKey] = await CountryScraper._scrapeCountryPage(countryCode, server)
        }
        return CountryScraper._cache[cacheKey]
    }

    /**
     * STUB: fetch the AS country page and parse station rows.
     *
     * Expected return: [{iata: "CDG", paxDemand: 120000, cargoDemand: 40000}, ...]
     *
     * TODO (requires live-AS discovery):
     *   1. Replace `path` with the correct AS country/region URL.
     *   2. Replace the table/row selectors with the ones from the actual page.
     *   3. Map the correct cell indices to iata / paxDemand / cargoDemand.
     *      Use `AES.cleanInteger()` to parse demand cells (handles thousands
     *      separators).
     */
    static async _scrapeCountryPage(countryCode, server) {
        const path = `/app/info/region/${encodeURIComponent(countryCode)}` // TODO: confirm URL
        const url = `https://${server}.airlinesim.aero${path}`

        let html
        try {
            const response = await fetch(url, {credentials: "include"})
            if (!response.ok) {
                console.warn(`[AES stationAutomation] country fetch ${url} returned ${response.status}`)
                return []
            }
            html = await response.text()
        } catch (error) {
            console.warn(`[AES stationAutomation] country fetch failed for ${url}`, error)
            return []
        }

        const doc = new DOMParser().parseFromString(html, "text/html")
        // TODO: replace selector once AS country page structure is confirmed
        const rows = doc.querySelectorAll("table tbody tr")
        const stations = []
        for (const row of rows) {
            const cells = row.querySelectorAll("td")
            if (cells.length < 3) continue
            // TODO: confirm cell indices on the live page
            const iata = (cells[0]?.innerText || "").trim().toUpperCase()
            const paxDemand = AES.cleanInteger(cells[1]?.innerText || "0") || 0
            const cargoDemand = AES.cleanInteger(cells[2]?.innerText || "0") || 0
            if (iata.length === 3) {
                stations.push({iata, paxDemand, cargoDemand})
            }
        }
        return stations
    }
}
