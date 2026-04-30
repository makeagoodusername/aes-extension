"use strict"

/**
 * Pure aggregator for the Competitor Intelligence module. Joins records
 * from `AesCompetitorStore` (airport, enterprise, alliance, edge) and
 * Route Assistant's read-only stores (`routeAssistant:airportOverview:*`,
 * `:enterpriseMeta:*`, `:markets:*`) into the shapes the on-page panels
 * render.
 *
 * All RA accesses are wrapped in `try/catch` so the module degrades
 * cleanly when RA classes are absent. The competitor profile is also
 * persisted to `competitorIntel:profile:<server>:<id>` as a render cache
 * so the panel can paint instantly on next visit while a fresh build
 * runs in the background.
 */
class AesCompetitorAggregator {
    /**
     * View payload for the airport panel: the airport record plus
     * enterprise meta lookups for each carrier so the panel can render
     * banner/avatar synchronously.
     */
    static async buildAirportPanelView({server, airportId}) {
        if (!server || airportId == null) return null
        const airport = await AesCompetitorStore.loadAirport(server, airportId)
        if (!airport) return {server, airportId: String(airportId), airport: null, enterpriseMeta: new Map()}

        const ids = (airport.carriers || []).map(c => c.enterpriseId).filter(Boolean)
        let enterpriseMeta = new Map()
        try {
            if (typeof RouteAssistantEnterpriseMetaScraper !== "undefined") {
                enterpriseMeta = await RouteAssistantEnterpriseMetaScraper.bulkLoadCache(ids)
            }
        } catch (e) {
            console.warn("[AES competitor-intel] aggregator: RA enterprise meta unavailable", e)
        }

        return {server, airportId: String(airportId), airport, enterpriseMeta}
    }

    /**
     * Aggregated competitor profile for the enterprise panel. Joins:
     *   - the enterprise record (identity + alliance + base country + fleet + hubs)
     *   - cached airport records keyed by hub airportId — for country grouping
     *   - RA's markets:competitors:<pair> + marketShare:<pair> — for top-pair
     *     share rankings on routes the user has already explored
     */
    static async buildCompetitorProfile({server, enterpriseId}) {
        if (!server || enterpriseId == null) return null
        const enterprise = await AesCompetitorStore.loadEnterprise(server, enterpriseId)
        if (!enterprise) {
            return {server, enterpriseId: String(enterpriseId), enterprise: null,
                hubsByCountry: [], topPairsByFlights: [], topPairsByShare: [],
                freshness: AesCompetitorAggregator._emptyFreshness()}
        }

        const enrichedHubs = await AesCompetitorAggregator._enrichHubs(server, enterprise.hubs || [])
        const hubsByCountry = AesCompetitorAggregator._groupHubsByCountry(enrichedHubs)

        const topPairsByFlights = AesCompetitorAggregator._topByFlights(enterprise.routeFootprint || [])
        const topPairsByShare   = await AesCompetitorAggregator._topByShare(server, enterprise, enrichedHubs)

        const freshness = await AesCompetitorAggregator._computeFreshness(server, enterprise, enrichedHubs)

        const profile = {
            server,
            enterpriseId: String(enterpriseId),
            builtAt: Date.now(),
            enterprise,
            hubsByCountry,
            hubCount: enrichedHubs.length,
            countryCount: hubsByCountry.length,
            topPairsByFlights,
            topPairsByShare,
            freshness
        }

        try { await AesCompetitorStore.saveProfile(server, enterpriseId, profile) }
        catch (e) { /* render-cache write is best-effort */ }
        return profile
    }

    /**
     * Build / refresh an edge record from RA's markets cache. Returns
     * null when no RA data exists for the pair (caller renders a "visit
     * market page" hint).
     */
    static async buildEdgeRecord({server, hub, dest}) {
        if (!server || !hub || !dest) return null
        const pairKey = String(hub).toUpperCase() + "-" + String(dest).toUpperCase()

        let competitorsRec = null
        let marketShareRec = null
        try {
            const competitorsKey = "routeAssistant:markets:competitors:" + pairKey
            const marketShareKey = "routeAssistant:markets:marketShare:" + pairKey
            const data = await chrome.storage.local.get([competitorsKey, marketShareKey])
            competitorsRec = data[competitorsKey] || null
            marketShareRec = data[marketShareKey] || null
        } catch (e) {
            console.warn("[AES competitor-intel] aggregator: RA markets unavailable", e)
        }

        if (!competitorsRec && !marketShareRec) return null

        const byEnterprise = new Map()
        const nameToPrefix = new Map()
        if (competitorsRec && Array.isArray(competitorsRec.competitors)) {
            for (const c of competitorsRec.competitors) {
                if (!c || c.isOurs) continue
                const key = c.flightCode ? c.flightCode.replace(/\d+$/, "") : null
                if (!key) continue
                const existing = byEnterprise.get(key) || {flightCodePrefix: key, weeklyFlights: 0, weeklySeats: 0}
                existing.weeklyFlights += 1
                if (c.availability && c.availability.totalSeats) existing.weeklySeats += c.availability.totalSeats
                byEnterprise.set(key, existing)
                if (c.name) nameToPrefix.set(c.name, key)
            }
        }
        // Populate per-competitor weekly counts via the markets-page join:
        // marketShare entries are keyed by name; the byEnterprise map is
        // keyed by flight-code prefix. Use the name→prefix map built from
        // competitorsRec to bridge them. Where the join fails (no flight
        // code on the markets page), keep weeklyFlights/Seats as null so
        // downstream consumers can distinguish "no signal" from a real 0.
        const lookupCounts = (name) => {
            const prefix = name ? nameToPrefix.get(name) : null
            const rec = prefix ? byEnterprise.get(prefix) : null
            return rec
                ? {weeklyFlights: rec.weeklyFlights, weeklySeats: rec.weeklySeats}
                : {weeklyFlights: null, weeklySeats: null}
        }
        const competitors = []
        if (marketShareRec && Array.isArray(marketShareRec.pax)) {
            for (const r of marketShareRec.pax) {
                const counts = lookupCounts(r.name)
                competitors.push({
                    enterpriseId: r.enterpriseId ? String(r.enterpriseId) : null,
                    name: r.name,
                    sharePctPax: r.sharePct,
                    sharePctCargo: null,
                    weeklyFlights: counts.weeklyFlights,
                    weeklySeats: counts.weeklySeats
                })
            }
        }
        if (marketShareRec && Array.isArray(marketShareRec.cargo)) {
            for (const r of marketShareRec.cargo) {
                const existing = competitors.find(x => x.name === r.name)
                if (existing) existing.sharePctCargo = r.sharePct
                else {
                    const counts = lookupCounts(r.name)
                    competitors.push({
                        enterpriseId: r.enterpriseId ? String(r.enterpriseId) : null,
                        name: r.name,
                        sharePctPax: null,
                        sharePctCargo: r.sharePct,
                        weeklyFlights: counts.weeklyFlights,
                        weeklySeats: counts.weeklySeats
                    })
                }
            }
        }

        let totalFlights = 0
        let totalSeats = 0
        for (const v of byEnterprise.values()) {
            totalFlights += v.weeklyFlights
            totalSeats += v.weeklySeats
        }

        const edge = {
            server,
            hub: String(hub).toUpperCase(),
            dest: String(dest).toUpperCase(),
            scrapedAt: Date.now(),
            competitors,
            totals: {totalWeeklyFlights: totalFlights, totalSeats},
            source: "routeAssistantMarkets"
        }
        await AesCompetitorStore.saveEdge(server, hub, dest, edge)
        return edge
    }

    static async _enrichHubs(server, hubs) {
        if (!hubs || !hubs.length) return []
        const ids = hubs.map(h => h.airportId).filter(Boolean)
        const airports = ids.length
            ? await AesCompetitorStore.bulkLoadAirports(server, ids)
            : new Map()

        return hubs.map(h => {
            const rec = h.airportId ? airports.get(String(h.airportId)) : null
            const country = rec && (rec.countryName || rec.countryId)
                ? {countryId: rec.countryId, countryName: rec.countryName}
                : null
            return Object.assign({}, h, {
                airportName: rec ? (rec.name || null) : (h.airportName || null),
                countryId:   country ? country.countryId : (h.countryId || null),
                countryName: country ? country.countryName : (h.countryName || null)
            })
        })
    }

    static _groupHubsByCountry(hubs) {
        if (!hubs || !hubs.length) return []
        const groups = new Map()
        for (const h of hubs) {
            const cid = h.countryId || "_unknown"
            const cname = h.countryName || (cid === "_unknown" ? "Unknown" : cid)
            if (!groups.has(cid)) groups.set(cid, {countryId: cid, countryName: cname, hubs: []})
            groups.get(cid).hubs.push(h)
        }
        const out = Array.from(groups.values())
        out.forEach(g => g.hubs.sort((a, b) => (b.weeklyDepartures || 0) - (a.weeklyDepartures || 0)))
        out.sort((a, b) => {
            if (a.countryId === "_unknown" && b.countryId !== "_unknown") return 1
            if (b.countryId === "_unknown" && a.countryId !== "_unknown") return -1
            return (b.hubs.reduce((s, h) => s + (h.weeklyDepartures || 0), 0))
                 - (a.hubs.reduce((s, h) => s + (h.weeklyDepartures || 0), 0))
        })
        return out
    }

    static _topByFlights(routeFootprint) {
        if (!routeFootprint || !routeFootprint.length) return []
        const sorted = routeFootprint.slice()
            .sort((a, b) => (b.weeklyFlights || 0) - (a.weeklyFlights || 0))
        return sorted.slice(0, 20)
    }

    /**
     * Top routes by passenger market share, derived from RA markets keys
     * for any pair in the enterprise's `routeFootprint`. Pairs that the
     * user has never visited via the markets page yield no shares — the
     * panel surfaces a hint pointing the user to the markets page.
     */
    static async _topByShare(server, enterprise, hubs) {
        const footprint = (enterprise && enterprise.routeFootprint) || []
        if (!footprint.length) return []
        const enterpriseName = enterprise && enterprise.name
        const enterpriseId   = enterprise && enterprise.enterpriseId

        const keys = []
        const pairs = []
        for (const r of footprint) {
            const k = String(r.hub).toUpperCase() + "-" + String(r.dest).toUpperCase()
            keys.push("routeAssistant:markets:marketShare:" + k)
            pairs.push({hub: r.hub, dest: r.dest, weeklyFlights: r.weeklyFlights || 0})
        }

        let data = {}
        try { data = await chrome.storage.local.get(keys) }
        catch (e) {
            console.warn("[AES competitor-intel] aggregator: marketShare lookup failed", e)
            return []
        }

        const out = []
        for (let i = 0; i < pairs.length; i++) {
            const rec = data[keys[i]]
            if (!rec || !Array.isArray(rec.pax)) continue
            for (const r of rec.pax) {
                const matches =
                    (enterpriseId && String(r.enterpriseId) === String(enterpriseId)) ||
                    (enterpriseName && r.name === enterpriseName)
                if (!matches) continue
                out.push(Object.assign({sharePctPax: r.sharePct}, pairs[i]))
                break
            }
        }
        out.sort((a, b) => (b.sharePctPax || 0) - (a.sharePctPax || 0))
        return out.slice(0, 20)
    }

    static _emptyFreshness() {
        return {airports: "stale", meta: "stale", deep: "stale"}
    }

    static async _computeFreshness(server, enterprise, enrichedHubs) {
        const out = AesCompetitorAggregator._emptyFreshness()
        if (!enterprise || !enterprise.scrapedAt) return out

        const now = Date.now()
        const ageDays = (now - enterprise.scrapedAt) / 86400000
        out.meta = ageDays < 90 ? "fresh" : "stale"
        out.deep = ageDays < 14 ? "fresh" : "stale"

        const ids = enrichedHubs.map(h => h.airportId).filter(Boolean)
        if (!ids.length) {
            out.airports = "missing"
            return out
        }
        const airports = await AesCompetitorStore.bulkLoadAirports(server, ids)
        let freshCount = 0
        for (const id of ids) {
            const rec = airports.get(String(id))
            if (rec && rec.scrapedAt && (now - rec.scrapedAt) / 86400000 < 7) freshCount++
        }
        if (freshCount === 0) out.airports = "stale"
        else if (freshCount === ids.length) out.airports = "fresh"
        else out.airports = "partial"

        return out
    }
}
