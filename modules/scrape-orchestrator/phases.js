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
 * Phase 4 (per-route) runs markets + inventory in hidden tabs, then uses
 * the ORS intelligence facade in-tab for schedule → ORS sync. ORS still
 * needs one Wicket GET → POST handshake per route/class, but the schedule
 * scrape now feeds fresh flight numbers into the ORS pass.
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
        {path: "/action/enterprise/staffPilots",    key: "pilots"},
        {path: "/action/enterprise/staffOverview",  key: "staffOverview:latest"}
    ]

    static all() {
        return [
            ScrapeOrchestratorPhases._foundation(),
            ScrapeOrchestratorPhases._demandSeed(),
            ScrapeOrchestratorPhases._perAircraft(),
            ScrapeOrchestratorPhases._perHub(),
            ScrapeOrchestratorPhases._perRoute(),
            ScrapeOrchestratorPhases._orsRank(),
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
            demandSeed:   1,
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
                    expectStorageKeyPrefix: "routeAssistant:topRoutes:" + String(hub).toUpperCase(),
                    settleMs:               2000,
                    // RA panel runs the scoring pipeline on mount; the
                    // topRoutes publish typically lands within 10–20s.
                    storagePollMs:          25000
                }))
            }
        }
    }

    /**
     * Demand-seed — runs the parallel-scanner's `seedAllCountries()` so
     * `routeAssistant:demand:<IATA>` is populated for every airport in the
     * game world. Without this phase, demand scoring stays empty after a
     * "Scrape everything" run because the scanner is otherwise only
     * reachable via the RA panel's "Seed All Countries" button.
     *
     * Slow (5–15 minutes — country fan-out via CountryScraper region
     * fetches), so kept `optional: true` and `defaultEnabled: false` —
     * users opt in from the ToS modal.
     *
     * No tab fan-out (the scanner uses fetch() + chrome.storage.local
     * writes), so buildJobs returns an empty list and the entire payload
     * runs in postRun. Mirrors `_orsRank()`.
     *
     * No new POSTs to AS — CountryScraper does GETs only.
     */
    static _demandSeed() {
        return {
            id:             "demand-seed",
            label:          "Demand store (slow — country fan-out)",
            optional:       true,
            defaultEnabled: false,
            concurrency:    1,
            staggerMs:      0,
            buildJobs:      async () => [],
            postRun:        async (host) => {
                if (!window.RouteAssistantParallelScanner) {
                    return {skipped: true, reason: "parallel-scanner not loaded"}
                }
                try {
                    const ps = new window.RouteAssistantParallelScanner(host.server, {
                        concurrency: 3,
                        staggerMs:   1500
                    })
                    const out = await ps.seedAllCountries()
                    return {
                        ok:              out && out.phase === "done",
                        countries:       (out && out.total)          || 0,
                        fetched:         (out && out.fetched)        || 0,
                        airportsSeeded:  (out && out.airportsSeeded) || 0,
                        failedCountries: ((out && out.failedCountries) || []).length
                    }
                } catch (e) {
                    return {ok: false, error: (e && e.message) || String(e)}
                }
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
            // After the per-route tabs settle, run the route-sync pipeline
            // (schedule scrape first, ORS second) so ORS owns detection gets
            // fresh flight numbers from the just-scraped scheduling page.
            postRun: async (host) => {
                if (!window.RouteAssistantOrsIntelligence) return {skipped: true, reason: "ORS intelligence not loaded"}
                if (!window.RouteAssistantRouteSync) return {skipped: true, reason: "route-sync not loaded"}
                const routes = await host.enumerators.enumerateAllRoutes(host.server)
                if (!routes.length) return {skipped: true, reason: "no routes"}
                try {
                    let settings = null
                    try {
                        const got = await chrome.storage.local.get(["settings"])
                        settings = got && got.settings && got.settings.routeAssistant || null
                    } catch (_) {}
                    const svc = new window.RouteAssistantOrsIntelligence(host.server, {settings})
                    const out = await svc.sync(routes, {
                        settings,
                        includeFresh: true,
                        source: "scrape-orchestrator",
                        concurrency: 2,
                        staggerMs: 1500
                    })
                    return {ok: !!(out && out.ok), totalRoutes: routes.length, ...out}
                } catch (e) {
                    return {ok: false, error: (e && e.message) || String(e)}
                }
            }
        }
    }

    /**
     * ORS-rank — runs the ORS intelligence sync on its own cadence so the
     * analyser keeps fresh competitive-rank data even when per-route's
     * markets/inventory tabs are still within their 24h window. The phase
     * has no own jobs (no hidden tabs); the entire payload is the postRun
     * which calls `RouteAssistantOrsIntelligence.sync()` against the live
     * topRoutes set.
     *
     * Why a separate phase from per-route's existing postRun: per-route
     * gates ORS on a 24h cadence and only runs when per-route is the
     * stalest mandatory phase. Auto-pricing decisions read ORS rank +
     * rating gap on every tick — letting that data go stale for a full
     * day under-fits the silent loop and the competitive analyser. This
     * phase's cadence (DEFAULT_CADENCE_MS["ors-rank"] = 4h) means the
     * auto-driver can pick it on its own.
     *
     * Honours the per-route postRun gate — if RouteAssistantOrsIntelligence
     * isn't loaded on this tab the phase no-ops cleanly.
     */
    static _orsRank() {
        return {
            id:          "ors-rank",
            label:       "ORS rank refresh",
            optional:    false,
            concurrency: 1,
            staggerMs:   0,
            // No tab-fan-out — the buildJobs returns an empty list so the
            // orchestrator's tab pool stays idle and we run straight into
            // postRun. Mirrors how per-route's postRun is structured but
            // without the markets+inventory pre-warm.
            buildJobs:   async () => [],
            postRun:     async (host) => {
                if (!window.RouteAssistantOrsIntelligence) {
                    return {skipped: true, reason: "ORS intelligence not loaded"}
                }
                if (!window.RouteAssistantRouteSync) {
                    return {skipped: true, reason: "route-sync not loaded"}
                }
                const routes = await host.enumerators.enumerateAllRoutes(host.server)
                if (!routes.length) return {skipped: true, reason: "no routes"}
                let settings = null
                try {
                    const got = await chrome.storage.local.get(["settings"])
                    settings = got && got.settings && got.settings.routeAssistant || null
                } catch (_) { /* defaults below */ }
                try {
                    const svc = new window.RouteAssistantOrsIntelligence(host.server, {settings})
                    // includeFresh:false — the dedicated cadence already
                    // guarantees we re-enter periodically, so each run
                    // refreshes only the stale slice instead of the full
                    // network. Smaller bursts = better rate-limit behaviour.
                    const out = await svc.sync(routes, {
                        settings,
                        includeFresh: false,
                        source:       "ors-rank-phase",
                        concurrency:  2,
                        staggerMs:    1500
                    })
                    return {ok: !!(out && out.ok), totalRoutes: routes.length, ...out}
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
