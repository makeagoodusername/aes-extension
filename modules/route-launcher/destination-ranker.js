"use strict"

/**
 * Route Launcher — destination ranker.
 *
 * Pure data function (no DOM). Given (server, hub), returns a scored,
 * sorted list of plausible destinations using:
 *   - FlightsFromStore           routes from hub (real-world frequency)
 *   - RouteAssistantDemandStore  AS pax/cargo demand bars
 *   - active-draft-store         to flag already-scheduled destinations
 *
 * Cached per hub at:
 *   chrome.storage.local["routeLauncher:rankCache:<server>:<hub>"]
 * with TTL 24h. Stale or missing → recompute.
 *
 * Output:
 *   [{destIata, distanceKm, weeklyFlights, paxScore, cargoScore,
 *     score, alreadyScheduled, hasDemandData, demandSource, demandBasis}]
 *
 * No range/runway fitness here yet — surfaced fields let the UI add a
 * fitness badge later. The dispatcher will fail loudly if the AS form
 * rejects the leg, which is acceptable for a v1 that prefers shipping
 * over over-engineering.
 */
class AesRouteLauncherRanker {
    static CACHE_PREFIX = "routeLauncher:rankCache:"
    static CACHE_TTL_MS = 24 * 60 * 60 * 1000
    static CACHE_SCHEMA_VERSION = 2

    static _cacheKey(server, hub) {
        return AesRouteLauncherRanker.CACHE_PREFIX
            + String(server || "") + ":"
            + String(hub || "").toUpperCase()
    }

    static async rank(server, hub, opts) {
        if (!server || !hub) return {entries: [], source: "no-input", scrapedAt: null}
        const HUB = String(hub).toUpperCase()
        const useCache = !(opts && opts.skipCache)

        if (useCache) {
            const cached = await AesRouteLauncherRanker._readCache(server, HUB)
            if (cached) return cached
        }

        const ff = (typeof FlightsFromStore !== "undefined")
            ? await FlightsFromStore.loadAirport(HUB).catch(() => null) : null
        if (!ff || !Array.isArray(ff.routes) || !ff.routes.length) {
            return {entries: [], source: "no-flightsfrom", scrapedAt: null}
        }

        const dests = []
        const seen = new Set()
        const sourceRouteByDest = new Map()
        for (const r of ff.routes) {
            if (!r || !r.destIata) continue
            const d = String(r.destIata).toUpperCase()
            if (d === HUB || seen.has(d)) continue
            seen.add(d)
            sourceRouteByDest.set(d, r)
            dests.push({
                destIata:      d,
                distanceKm:    Number(r.distanceKm) || null,
                weeklyFlights: Number(r.weeklyFlights) || 0,
                seatsPerWeek:  Number(r.seatsPerWeek) || 0,
                airlineCount:  Number(r.airlineCount) || 0
            })
        }

        const flightsFromDemandContext =
            (typeof FlightsFromStore !== "undefined" && typeof FlightsFromStore.buildDemandContext === "function")
                ? FlightsFromStore.buildDemandContext(ff.routes)
                : null
        let demandMap = new Map()
        if (typeof RouteAssistantDemandStore !== "undefined" && dests.length) {
            try {
                demandMap = await RouteAssistantDemandStore.getMany(dests.map(d => d.destIata))
            } catch (_) { /* fall through with empty demand */ }
        }

        for (const d of dests) {
            let dem = demandMap.get(d.destIata) || null
            if (!dem && typeof FlightsFromStore !== "undefined"
                    && typeof FlightsFromStore.demandForRoute === "function") {
                dem = FlightsFromStore.demandForRoute(
                    sourceRouteByDest.get(d.destIata),
                    flightsFromDemandContext
                )
            }
            d.paxScore   = dem && typeof dem.paxScore   === "number" ? dem.paxScore   : null
            d.cargoScore = dem && typeof dem.cargoScore === "number" ? dem.cargoScore : null
            d.hasDemandData = !!dem
            d.demandSource = (dem && (dem.demandSource || dem.source)) || null
            d.demandBasis  = (dem && dem.demandBasis) || null
            d.score = AesRouteLauncherRanker._scoreOf(d)
        }
        dests.sort((a, b) => (b.score || 0) - (a.score || 0))

        const entry = {
            schemaVersion: AesRouteLauncherRanker.CACHE_SCHEMA_VERSION,
            entries:    dests,
            source:     "computed",
            hub:        HUB,
            scrapedAt:  ff.scrapedAt || null,
            computedAt: Date.now()
        }
        await AesRouteLauncherRanker._writeCache(server, HUB, entry)
        return entry
    }

    /** Demand bars (0–10) dominate, frequency provides a tiebreaker, competition lightly penalises. */
    static _scoreOf(d) {
        const pax  = (typeof d.paxScore   === "number") ? d.paxScore   : 0
        const carg = (typeof d.cargoScore === "number") ? d.cargoScore : 0
        const wkly = d.weeklyFlights || 0
        const air  = d.airlineCount  || 0
        return (pax * 10) + (carg * 5) + Math.sqrt(wkly) - (air * 0.5)
    }

    static async markScheduled(server, aircraftId, destSet, entries) {
        if (!destSet || !destSet.size) return entries
        for (const e of entries) {
            e.alreadyScheduled = destSet.has(e.destIata)
        }
        return entries
    }

    static async _readCache(server, hub) {
        const key = AesRouteLauncherRanker._cacheKey(server, hub)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || !rec.computedAt) return null
        if (rec.schemaVersion !== AesRouteLauncherRanker.CACHE_SCHEMA_VERSION) return null
        if (Date.now() - rec.computedAt > AesRouteLauncherRanker.CACHE_TTL_MS) return null
        return rec
    }

    static async _writeCache(server, hub, entry) {
        const key = AesRouteLauncherRanker._cacheKey(server, hub)
        await chrome.storage.local.set({[key]: entry})
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherRanker = AesRouteLauncherRanker
}
