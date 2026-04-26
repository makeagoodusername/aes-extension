/**
 * chrome.storage.local wrapper for flightsfrom.com scraped data.
 *
 * One record per airport, keyed by IATA:
 *
 *   flightsFrom:<IATA>        → {iata, scrapedAt, airportName, routes: [...]}
 *   flightsFrom:<IATA>:status → {iata, scanId, status, error, progress}
 *
 * The status record is written by the child tab as it scrapes, so the
 * dashboard (or scheduling-page overlay) can surface progress without
 * waiting for the full dataset.
 */
class FlightsFromStore {
    static _dataKey(iata)   { return "flightsFrom:" + String(iata || "").toUpperCase() }
    static _statusKey(iata) { return "flightsFrom:" + String(iata || "").toUpperCase() + ":status" }

    static async saveAirport(record) {
        if (!record || !record.iata) throw new Error("saveAirport: iata required")
        const key = FlightsFromStore._dataKey(record.iata)
        const toStore = Object.assign({scrapedAt: Date.now()}, record,
            {iata: String(record.iata).toUpperCase()})
        await chrome.storage.local.set({[key]: toStore})
        return toStore
    }

    static async loadAirport(iata) {
        if (!iata) return null
        const key = FlightsFromStore._dataKey(iata)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    static async deleteAirport(iata) {
        if (!iata) return
        await chrome.storage.local.remove([
            FlightsFromStore._dataKey(iata),
            FlightsFromStore._statusKey(iata)
        ])
    }

    static async listAirports() {
        const all = await chrome.storage.local.get(null)
        const prefix = "flightsFrom:"
        const out = []
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            if (k.indexOf(":status") !== -1) continue
            const rec = all[k]
            if (rec && rec.iata) {
                out.push({
                    iata: rec.iata,
                    airportName: rec.airportName || null,
                    scrapedAt: rec.scrapedAt || null,
                    routeCount: (rec.routes || []).length
                })
            }
        }
        return out.sort((a, b) => a.iata.localeCompare(b.iata))
    }

    static async saveStatus(iata, status) {
        const key = FlightsFromStore._statusKey(iata)
        await chrome.storage.local.set({[key]: Object.assign({iata: String(iata).toUpperCase()}, status)})
    }

    static async loadStatus(iata) {
        const key = FlightsFromStore._statusKey(iata)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }
}
