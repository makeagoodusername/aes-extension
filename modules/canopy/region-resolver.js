"use strict"

/**
 * Pure resolver: given a hub IATA + server, return the region/country/
 * continent classification used by Fleet Command + Lane C utilization
 * rollups + the wave palette's geography filter.
 *
 * No DOM, no chrome.storage. The caller passes pre-loaded snapshots:
 *   - demand: per-IATA RouteAssistantDemandStore record (carries countryId)
 *   - countryIdMap: per-server map (loaded from `aesCanopy:geography:countryIdMap:<server>`)
 *   - regionsBlock: AesCanopyRegionsStore.load() output
 *   - geographyBase: window.AesGeographyBase
 *
 * Resolution order:
 *   IATA → demand.countryId → countryIdMap[countryId].iso2 → continent
 *        → user region (countries[] then iso2Codes[] then continents[])
 *        → fallback to a continent-only region if any
 *        → null
 *
 * Returns `{iata, countryId, iso2, continent, regionId, regionName}` —
 * any of `countryId`, `iso2`, `continent`, `regionId`, `regionName` may
 * be null when upstream data is missing.
 */
;(function () {
    if (window.AesCanopyRegionResolver) return

    function resolve(args) {
        const a = args || {}
        const iata = String(a.iata || "").toUpperCase()
        const out = {iata, countryId: null, iso2: null, continent: null, regionId: null, regionName: null}
        if (!iata) return out

        const demand = a.demand || null
        const countryIdMap = (a.countryIdMap && a.countryIdMap.byCountryId) || null
        const regionsBlock = a.regionsBlock || null
        const geo = a.geographyBase || (typeof window !== "undefined" ? window.AesGeographyBase : null)

        if (demand && demand.countryId != null) out.countryId = Number(demand.countryId)
        if (out.countryId != null && countryIdMap && countryIdMap[out.countryId]) {
            const rec = countryIdMap[out.countryId]
            if (rec.iso2) out.iso2 = String(rec.iso2).toUpperCase()
        }
        if (!out.iso2 && demand && demand.iso2) out.iso2 = String(demand.iso2).toUpperCase()
        if (out.iso2 && geo && typeof geo.continentOfIso2 === "function") {
            out.continent = geo.continentOfIso2(out.iso2)
        }

        if (regionsBlock && regionsBlock.regions) {
            // first pass: countryId match (most specific)
            for (const r of Object.values(regionsBlock.regions)) {
                if (out.countryId != null && Array.isArray(r.countries) && r.countries.indexOf(out.countryId) >= 0) {
                    out.regionId = r.id; out.regionName = r.name; return out
                }
            }
            // second pass: iso2 match
            for (const r of Object.values(regionsBlock.regions)) {
                if (out.iso2 && Array.isArray(r.iso2Codes) && r.iso2Codes.indexOf(out.iso2) >= 0) {
                    out.regionId = r.id; out.regionName = r.name; return out
                }
            }
            // third pass: continent match
            for (const r of Object.values(regionsBlock.regions)) {
                if (out.continent && Array.isArray(r.continents) && r.continents.indexOf(out.continent) >= 0) {
                    out.regionId = r.id; out.regionName = r.name; return out
                }
            }
        }
        return out
    }

    window.AesCanopyRegionResolver = {resolve}
})()
