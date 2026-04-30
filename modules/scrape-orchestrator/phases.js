"use strict"

/**
 * ScrapeOrchestratorPhases — declarative phase definitions for the
 * "Scrape everything" orchestrator.
 *
 * Each phase has:
 *   id          string identifier
 *   label       UI label
 *   optional    user-toggleable in the ToS modal (default false)
 *   concurrency how many hidden tabs at once for this phase
 *   staggerMs   delay between dispatch
 *   buildJobs   async function (host) → [{jobId, phaseId, url, expectStorageKeyPrefix, settleMs}, …]
 *               where `host` exposes:
 *                 .server        current AS server (e.g. "free1")
 *                 .airline       current airline code
 *                 .origin        page origin (e.g. "https://free1.airlinesim.aero")
 *                 .enumerators   the ScrapeOrchestratorEnumerators namespace
 *
 * Each phase's buildJobs is called AFTER all prior phases complete so
 * fan-out enumerations see fresh storage.
 *
 * Phase 4 (per-route) intentionally does NOT include ORS — the existing
 * `RouteAssistantOrsScraper.bulkLoad()` + dispatch loop is fetch-based
 * and stays in-tab; the orchestrator triggers it separately after
 * Phase 4's tab work completes.
 */

class ScrapeOrchestratorPhases {
    // Single source of truth for foundation-phase targets. Both
    // `estimate()` and `_foundation().buildJobs()` derive from this list
    // so the ToS modal count cannot drift from the actual dispatch.
    // Substring fragments — see background-tab-pool.js:_snapshotStorageKeys
    // for why we use canonical suffixes instead of `<server><airline>` prefixes.
    // Excluded by design:
    //   /app/alliance?tabs=1 — the alliance scraper visits this URL
    //     internally on /app/alliance, so a separate job duplicates work.
    //   /action/info/countries — no content script matches that path; the
    //     countries list is fetched lazily by callers (open-stations-modal,
    //     parallel-scanner) via CountryScraper.loadCountriesList.
    //   /app/aircraft/market — passive visit only mounts MarketPanel and
    //     never writes a `marketScan:` key (those land only during an
    //     active scan session driven by ScanController).
    //   /app/finance/cashflow — AS returns 404 on this path (the cashflow
    //     view was retired); the other /app/finance/* siblings still exist.
    static FOUNDATION_TARGETS = [
        {path: "/app/fleets",                       key: "aircraftFleet"},
        {path: "/app/finance/accounting/0",         key: "accounting:income:"},
        {path: "/app/finance/accounting/1",         key: "accounting:balance:"},
        {path: "/app/finance/accounting/2",         key: "accounting:bank:"},
        {path: "/app/finance/leasing",              key: "accounting:leasing"},
        {path: "/app/finance/capital",              key: "accounting:capital"},
        {path: "/app/finance/assets",               key: "accounting:assets"},
        {path: "/app/alliance",                     key: "alliance:overview"},
        {path: "/action/enterprise/staffPilots",    key: "crewMgmt:pilots"},
        {path: "/action/enterprise/staffOverview",  key: "crewMgmt:staffOverview:latest"}
    ]

    static all() {
        return [
            ScrapeOrchestratorPhases._foundation(),
            ScrapeOrchestratorPhases._perHub(),
            ScrapeOrchestratorPhases._perAircraft(),
            ScrapeOrchestratorPhases._perRoute(),
            ScrapeOrchestratorPhases._perCompetitor(),
            ScrapeOrchestratorPhases._flightsFrom()
        ]
    }

    /**
     * Estimates job counts BEFORE buildJobs runs — used by the ToS modal
     * to show realistic numbers up front.
     */
    static async estimate(host) {
        const E = host.enumerators
        const hubs        = await E.enumerateHubs(host.server, host.airline)
        const aircraft    = await E.enumerateAircraft(host.server, host.airline)
        const routes      = await E.enumerateAllRoutes(host.server)      // pre-existing topRoutes cache
        const competitors = await E.enumerateCompetitorIds(host.server)
        const airports    = await E.enumerateAirportsForFlightsFrom(hubs, routes)
        return {
            foundation:   ScrapeOrchestratorPhases.FOUNDATION_TARGETS.length,
            perHub:       hubs.length,
            perAircraft:  aircraft.length * 2,
            perRoute:     routes.length * 2,    // markets + inventory per route
            perCompetitor: competitors.length,
            flightsFrom:  airports.length,
            hubs:         hubs.length,
            aircraft:     aircraft.length,
            routes:       routes.length,
            competitors:  competitors.length,
            airports:     airports.length
        }
    }

    static _foundation() {
        return {
            id:          "foundation",
            label:       "Foundation",
            optional:    false,
            concurrency: 3,
            staggerMs:   1500,
            buildJobs:   async (host) => {
                const o = host.origin
                return ScrapeOrchestratorPhases.FOUNDATION_TARGETS.map((t, i) => ({
                    jobId:                  "foundation-" + i,
                    phaseId:                "foundation",
                    url:                    o + t.path,
                    expectStorageKeyPrefix: t.key,
                    settleMs:               1500
                }))
            }
        }
    }

    static _perHub() {
        return {
            id:          "per-hub",
            label:       "Per-hub scheduling",
            optional:    false,
            concurrency: 2,
            staggerMs:   1500,
            buildJobs:   async (host) => {
                const hubs = await host.enumerators.enumerateHubs(host.server, host.airline)
                if (!hubs.length) return []
                return hubs.map((hub, i) => ({
                    jobId:                  "per-hub-" + hub,
                    phaseId:                "per-hub",
                    url:                    host.origin + "/app/com/scheduling/" + encodeURIComponent(hub),
                    expectStorageKeyPrefix: "topRoutes:" + String(hub).toUpperCase(),
                    settleMs:               2000,
                    // RA panel runs the scoring pipeline on mount; the
                    // topRoutes publish typically lands within 10–20s.
                    storagePollMs:          25000
                }))
            }
        }
    }

    static _perAircraft() {
        return {
            id:          "per-aircraft",
            label:       "Per-aircraft (plan + flights)",
            optional:    false,
            concurrency: 3,
            staggerMs:   1500,
            buildJobs:   async (host) => {
                const aircraft = await host.enumerators.enumerateAircraft(host.server, host.airline)
                const jobs = []
                for (const a of aircraft) {
                    jobs.push({
                        jobId:                  "aircraft-" + a.aircraftId + "-plan",
                        phaseId:                "per-aircraft",
                        // wearObservations: is sampled every ~6.5 days, so it's
                        // unreliable as a per-visit confirmation. The maintenance
                        // scraper writes aircraftFlightPlan:maintenance:<server>:<id>
                        // on every plan-page mount, which is the right signal that
                        // the page rendered and was scraped.
                        url:                    host.origin + "/app/fleets/aircraft/" + encodeURIComponent(a.aircraftId) + "/0",
                        expectStorageKeyPrefix: "aircraftFlightPlan:maintenance:" + host.server + ":" + a.aircraftId,
                        settleMs:               1500
                    })
                    jobs.push({
                        jobId:                  "aircraft-" + a.aircraftId + "-flights",
                        phaseId:                "per-aircraft",
                        url:                    host.origin + "/app/fleets/aircraft/" + encodeURIComponent(a.aircraftId) + "/1",
                        expectStorageKeyPrefix: "aircraftFlights" + a.aircraftId,
                        settleMs:               1500
                    })
                }
                return jobs
            }
        }
    }

    static _perRoute() {
        return {
            id:          "per-route",
            label:       "Per-route markets + inventory",
            optional:    false,
            concurrency: 2,
            staggerMs:   1500,
            buildJobs:   async (host) => {
                const routes = await host.enumerators.enumerateAllRoutes(host.server)
                const jobs = []
                for (const r of routes) {
                    const pair = String(r.hub).toUpperCase() + String(r.dest).toUpperCase()
                    jobs.push({
                        jobId:                  "markets-" + pair,
                        phaseId:                "per-route",
                        url:                    host.origin + "/app/com/markets/" + encodeURIComponent(pair),
                        expectStorageKeyPrefix: "markets:competitors:" + r.hub + "-" + r.dest,
                        settleMs:               1800
                    })
                    jobs.push({
                        jobId:                  "inventory-" + pair,
                        phaseId:                "per-route",
                        url:                    host.origin + "/app/com/inventory/" + encodeURIComponent(pair),
                        expectStorageKeyPrefix: "inventory:" + r.hub + "-" + r.dest,
                        settleMs:               1500
                    })
                }
                return jobs
            },
            // After the per-route tabs settle, kick off the existing ORS
            // bulk runner via fetch (in-tab, no hidden tab needed). The
            // orchestrator calls this hook between phase tab work and
            // moving on.
            postRun: async (host) => {
                if (!window.RouteAssistantOrsScraper) return {skipped: true, reason: "ORS scraper not loaded"}
                const routes = await host.enumerators.enumerateAllRoutes(host.server)
                if (!routes.length) return {skipped: true, reason: "no routes"}
                try {
                    const scraper = new window.RouteAssistantOrsScraper(host.server, {})
                    if (typeof scraper.bulkScrape !== "function") {
                        return {skipped: true, reason: "ORS bulkScrape unavailable"}
                    }
                    const out = await scraper.bulkScrape(routes, {concurrency: 2, staggerMs: 1500})
                    return {ok: true, totalRoutes: routes.length, ...out}
                } catch (e) {
                    return {ok: false, error: (e && e.message) || String(e)}
                }
            }
        }
    }

    static _perCompetitor() {
        return {
            id:          "per-competitor",
            label:       "Per-competitor enrichment",
            optional:    true,
            defaultEnabled: false,
            concurrency: 2,
            staggerMs:   1500,
            buildJobs:   async (host) => {
                const ids = await host.enumerators.enumerateCompetitorIds(host.server)
                return ids.map(id => ({
                    jobId:                  "competitor-" + id,
                    phaseId:                "per-competitor",
                    url:                    host.origin + "/app/info/enterprises/" + encodeURIComponent(id),
                    expectStorageKeyPrefix: "routeAssistant:enterpriseMeta:" + id,
                    settleMs:               1500
                }))
            }
        }
    }

    static _flightsFrom() {
        return {
            id:          "flightsfrom",
            label:       "FlightsFrom (cross-origin)",
            optional:    true,
            defaultEnabled: false,
            concurrency: 2,
            staggerMs:   2000,
            buildJobs:   async (host) => {
                const hubs   = await host.enumerators.enumerateHubs(host.server, host.airline)
                const routes = await host.enumerators.enumerateAllRoutes(host.server)
                const airports = await host.enumerators.enumerateAirportsForFlightsFrom(hubs, routes)
                return airports.map(iata => ({
                    jobId:                  "ffrom-" + iata,
                    phaseId:                "flightsfrom",
                    url:                    "https://www.flightsfrom.com/" + encodeURIComponent(iata),
                    expectStorageKeyPrefix: "flightsFrom:" + iata,
                    settleMs:               3000
                }))
            }
        }
    }
}

if (typeof window !== "undefined") {
    window.ScrapeOrchestratorPhases = ScrapeOrchestratorPhases
}
