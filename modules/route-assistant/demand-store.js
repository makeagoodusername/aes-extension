/**
 * Per-destination demand cache for the Route Assistant.
 *
 * Records are keyed by IATA and hold the AS pax/cargo demand scores (0-10)
 * that CountryScraper extracts, plus the airportId / countryId we needed to
 * fetch them. The scheduling-page panel reads from this cache; the
 * parallel-scanner writes to it.
 *
 *   routeAssistant:demand:<IATA> → {iata, name?, airportId?, countryId?,
 *                                    paxScore, cargoScore, scrapedAt}
 *
 * Country-level lookups (every airport in country X) are written in bulk via
 * `saveCountryAirports()` so a single CountryScraper run populates dozens of
 * destinations at once. Stale entries (older than `MAX_AGE_MS`) are not
 * served by `get()`; callers should treat a miss as "needs rescrape".
 */
class RouteAssistantDemandStore {
    static KEY_PREFIX = "routeAssistant:demand:"
    static MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days; demand bars change very slowly

    static _key(iata) {
        return RouteAssistantDemandStore.KEY_PREFIX + String(iata || "").toUpperCase()
    }

    /**
     * Returns a demand record for `iata`, or null if absent or stale.
     * Pass `{includeStale: true}` to bypass the freshness check.
     */
    static async get(iata, opts) {
        if (!iata) return null
        const key = RouteAssistantDemandStore._key(iata)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec) return null
        if (!(opts && opts.includeStale)) {
            if (!rec.scrapedAt || Date.now() - rec.scrapedAt > RouteAssistantDemandStore.MAX_AGE_MS) {
                return null
            }
        }
        return rec
    }

    /**
     * Bulk read for many destinations at once. Returns a Map<IATA, record>
     * containing only fresh hits.
     */
    static async getMany(iatas) {
        if (!iatas || !iatas.length) return new Map()
        const keys = iatas.map(RouteAssistantDemandStore._key)
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        const cutoff = Date.now() - RouteAssistantDemandStore.MAX_AGE_MS
        for (const k in out) {
            const rec = out[k]
            if (!rec || !rec.iata || !rec.scrapedAt || rec.scrapedAt < cutoff) continue
            map.set(rec.iata, rec)
        }
        return map
    }

    /**
     * Writes a single airport's demand record. Caller-supplied fields beyond
     * the standard shape are preserved (the parallel scanner attaches the
     * countryId so subsequent lookups in the same scan don't re-resolve).
     */
    static async save(record) {
        if (!record || !record.iata) throw new Error("save: iata required")
        const key = RouteAssistantDemandStore._key(record.iata)
        const toStore = Object.assign({scrapedAt: Date.now()}, record,
            {iata: String(record.iata).toUpperCase()})
        await chrome.storage.local.set({[key]: toStore})
        return toStore
    }

    /**
     * Bulk-save every airport returned by a single CountryScraper run.
     * `airports` is the array shape {iata, name, airportId, paxScore,
     * cargoScore} — all entries share the same `countryId`.
     */
    static async saveCountryAirports(countryId, airports) {
        if (!airports || !airports.length) return
        const writes = {}
        const now = Date.now()
        for (const a of airports) {
            if (!a || !a.iata) continue
            const iata = String(a.iata).toUpperCase()
            writes[RouteAssistantDemandStore.KEY_PREFIX + iata] = {
                iata:       iata,
                name:       a.name || null,
                airportId:  a.airportId || null,
                countryId:  countryId || null,
                paxScore:   typeof a.paxScore   === "number" ? a.paxScore   : null,
                cargoScore: typeof a.cargoScore === "number" ? a.cargoScore : null,
                scrapedAt:  now
            }
        }
        if (Object.keys(writes).length) await chrome.storage.local.set(writes)
    }

    /**
     * Drops every demand record. Useful from DevTools when debugging.
     */
    static async clearAll() {
        const all = await chrome.storage.local.get(null)
        const drop = []
        for (const k in all) {
            if (k.indexOf(RouteAssistantDemandStore.KEY_PREFIX) === 0) drop.push(k)
        }
        if (drop.length) await chrome.storage.local.remove(drop)
        return drop.length
    }
}
