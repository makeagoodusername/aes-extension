/**
 * Maps a destination IATA to the AS countryId via the demand-store cache.
 *
 * AS doesn't expose a per-IATA airport lookup endpoint (no
 * `/action/info/airports?searchString=…` — that returns 404), so this
 * resolver is purely cache-backed. The cache is populated by the parallel
 * scanner's `seedAllCountries()` one-time bulk run, after which every IATA
 * in the game world is a hit.
 *
 * Returns null on miss; caller should treat that as "user hasn't seeded
 * yet" and surface the Seed button.
 */
class RouteAssistantCountryResolver {
    constructor(server) {
        if (!server) throw new Error("RouteAssistantCountryResolver: server required")
        this.server = server
        this._countryByIata  = new Map()  // IATA → countryId (session cache)
        this._airportIdByIata = new Map() // IATA → airportId (session cache)
    }

    /**
     * Resolve `{iata, airportId?, countryId?}` for a destination IATA.
     * Returns null if the demand-store has no record for that IATA — caller
     * must trigger `seedAllCountries()` first.
     */
    async resolve(iata) {
        if (!iata) return null
        iata = String(iata).toUpperCase()

        if (this._countryByIata.has(iata)) {
            return {
                iata: iata,
                airportId: this._airportIdByIata.get(iata) || null,
                countryId: this._countryByIata.get(iata)
            }
        }

        // Include stale: airportId/countryId don't expire even when scores do.
        const cached = await RouteAssistantDemandStore.get(iata, {includeStale: true})
        if (cached && cached.countryId) {
            this._countryByIata.set(iata, cached.countryId)
            if (cached.airportId) this._airportIdByIata.set(iata, cached.airportId)
            return {iata: iata, airportId: cached.airportId || null, countryId: cached.countryId}
        }

        return null
    }
}
