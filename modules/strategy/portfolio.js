"use strict"

/**
 * AES Strategy — multi-airline portfolio scanner (Slice 11 — single
 * game world).
 *
 * Pure read facade over the account registry, fleet roster, and
 * persisted schedules. Produces a per-server portfolio: every owned
 * airline (sister) on the server, plus its hubs / routes / fleet
 * counts, and the cross-airline overlap (hubs and routes both fly).
 *
 * Why this lives in modules/strategy: the strategy modal + tile both
 * render this; consolidating here keeps the lookup logic in one place
 * and lets future Slice 11 rebalancers (lease-between-sisters,
 * coordinated hub assignment, joint pricing) consume the same shape.
 *
 * NO SCRAPING, NO POSTING. Reads only:
 *   - AesAccountRegistry              (server, airlineIdentity tuples)
 *   - AesFleetRoster                  (per-airline aircraft list)
 *   - AesAfpScheduleStore             (per-aircraft schedule legs)
 *
 * Public API (window.AesStrategyPortfolio):
 *   scanServer(server) → Promise<PortfolioServer>
 *
 * PortfolioServer shape:
 *   {
 *     server,
 *     scrapedAt,
 *     airlines: [{
 *       accountId, server, airline, displayName,
 *       fleetCount, scheduleLegCount,
 *       hubs: string[],          // unique IATA codes ordered by tail count desc
 *       routes: string[],        // unique "ORIG-DEST" pairs from cached schedules
 *       lastScrape: number       // max scrapedAt across this airline's schedules
 *     }],
 *     overlapHubs:   [{iata, airlines: string[]}],
 *     overlapRoutes: [{route: "ORIG-DEST", airlines: string[]}]
 *   }
 *
 * Single-server only — multi-game-world aggregation is Slice 18 territory.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyPortfolio) return

    function _empty(server) {
        return {server: server || null, scrapedAt: Date.now(),
                airlines: [], overlapHubs: [], overlapRoutes: []}
    }

    /** Best-effort fleet load: try the registry's display name, then a
     *  stripped (alphanumeric-only) variant — content_fleetManagement.js
     *  writes the storage record's `airline` field after stripping non-
     *  alphanumerics, so the registry's raw name doesn't always match. */
    async function _loadFleet(server, airline) {
        if (!window.AesFleetRoster) return null
        try {
            const direct = await window.AesFleetRoster.load(server, airline)
            if (direct && Array.isArray(direct.aircraft) && direct.aircraft.length) return direct
        } catch (_) {}
        const stripped = String(airline || "").replace(/[^A-Za-z0-9]/g, "")
        if (stripped && stripped !== airline) {
            try {
                const alt = await window.AesFleetRoster.load(server, stripped)
                if (alt && Array.isArray(alt.aircraft) && alt.aircraft.length) return alt
            } catch (_) {}
        }
        return null
    }

    /**
     * Read the per-account scoped applied envelope for one (server,
     * airline) pair. Returns the v1 unscoped fallback for accounts that
     * haven't applied since per-account scoping went live. The portfolio
     * surfaces the timestamp + tier + ok/err totals so the user can spot
     * which sister was touched most recently.
     */
    async function _loadAppliedFor(server, airline) {
        if (!server || !airline) return null
        if (!window.AesStrategy || typeof window.AesStrategy.getApplied !== "function") return null
        if (!window.AesStrategy.computeAccountId) return null
        try {
            const id = await window.AesStrategy.computeAccountId(server, airline)
            return await window.AesStrategy.getApplied(id)
        } catch (_) { return null }
    }

    async function _loadAircraftSchedules(server, fleet) {
        if (!fleet || !Array.isArray(fleet.aircraft) || !fleet.aircraft.length) return []
        if (!window.AesAfpScheduleStore || typeof window.AesAfpScheduleStore.load !== "function") return []
        const out = []
        await Promise.all(fleet.aircraft.map(async a => {
            if (!a || !a.aircraftId) return
            try {
                const sched = await window.AesAfpScheduleStore.load(server, a.aircraftId)
                if (sched && Array.isArray(sched.legs)) out.push({aircraftId: a.aircraftId, schedule: sched})
            } catch (_) {}
        }))
        return out
    }

    function _aggregateAirline(account, fleet, schedules) {
        const aircraft = (fleet && fleet.aircraft) || []
        const hubCounts = new Map()
        for (const a of aircraft) {
            const iata = a && a.currentLocationIata ? String(a.currentLocationIata).toUpperCase() : null
            if (!iata) continue
            hubCounts.set(iata, (hubCounts.get(iata) || 0) + 1)
        }
        // Per-direction leg counter so the overlap card can show concrete
        // weekly figures per shared route ("me 7/wk · SisterB 5/wk")
        // instead of just the route name.
        const routeLegs = new Map()
        let scheduleLegCount = 0
        let lastScrape = 0
        for (const {schedule} of schedules) {
            if (typeof schedule.scrapedAt === "number" && schedule.scrapedAt > lastScrape) {
                lastScrape = schedule.scrapedAt
            }
            for (const leg of schedule.legs || []) {
                if (!leg || !leg.origin || !leg.destination) continue
                scheduleLegCount++
                const orig = String(leg.origin).toUpperCase()
                const dest = String(leg.destination).toUpperCase()
                if (!/^[A-Z]{3}$/.test(orig) || !/^[A-Z]{3}$/.test(dest)) continue
                const key = orig + "-" + dest
                routeLegs.set(key, (routeLegs.get(key) || 0) + 1)
            }
        }
        const hubs = Array.from(hubCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([iata]) => iata)
        const routeLegsObj = {}
        for (const [k, v] of routeLegs.entries()) routeLegsObj[k] = v
        return {
            accountId:        account.id,
            server:           account.server,
            airline:          account.airlineIdentity || account.displayName,
            displayName:      account.displayName || account.airlineIdentity,
            fleetCount:       aircraft.length,
            scheduleLegCount,
            hubs,
            routes:           Array.from(routeLegs.keys()).sort(),
            routeLegs:        routeLegsObj,
            lastScrape
        }
    }

    function _overlapCounts(airlines) {
        // Hub overlap: any IATA appearing in 2+ airlines' hub lists.
        const hubCounts = new Map()      // iata → Set<airline>
        for (const a of airlines) {
            for (const h of a.hubs) {
                if (!hubCounts.has(h)) hubCounts.set(h, new Set())
                hubCounts.get(h).add(a.airline)
            }
        }
        const overlapHubs = []
        for (const [iata, set] of hubCounts.entries()) {
            if (set.size >= 2) overlapHubs.push({iata, airlines: Array.from(set).sort()})
        }
        overlapHubs.sort((a, b) => b.airlines.length - a.airlines.length || (a.iata < b.iata ? -1 : 1))

        const routeCounts = new Map()
        const routeLegsByAirline = new Map()  // route → {airline → legs}
        for (const a of airlines) {
            for (const r of a.routes) {
                if (!routeCounts.has(r)) routeCounts.set(r, new Set())
                routeCounts.get(r).add(a.airline)
                if (a.routeLegs && typeof a.routeLegs[r] === "number") {
                    if (!routeLegsByAirline.has(r)) routeLegsByAirline.set(r, {})
                    routeLegsByAirline.get(r)[a.airline] = a.routeLegs[r]
                }
            }
        }
        const overlapRoutes = []
        for (const [route, set] of routeCounts.entries()) {
            if (set.size >= 2) {
                overlapRoutes.push({
                    route,
                    airlines: Array.from(set).sort(),
                    legs:     routeLegsByAirline.get(route) || null
                })
            }
        }
        overlapRoutes.sort((a, b) => b.airlines.length - a.airlines.length || (a.route < b.route ? -1 : 1))

        return {overlapHubs, overlapRoutes}
    }

    async function scanServer(server) {
        const result = _empty(server)
        if (!server) return result
        if (!window.AesAccountRegistry) return result
        let accounts = []
        try { accounts = await window.AesAccountRegistry.list() } catch (_) { return result }
        const onServer = accounts.filter(a => a && a.server === server)
        if (!onServer.length) return result

        const built = []
        for (const acct of onServer) {
            const ident = acct.airlineIdentity || acct.displayName
            const fleet = await _loadFleet(server, ident)
            const schedules = await _loadAircraftSchedules(server, fleet)
            const agg = _aggregateAirline(acct, fleet, schedules)
            // Multi-account: load this airline's own applied envelope
            // rather than whatever sister last wrote the legacy global.
            const applied = await _loadAppliedFor(server, ident)
            if (applied && applied.ts) {
                const r = applied.applyReport || {}
                const t = r.totals || {}
                agg.lastApplied = {
                    ts:    applied.ts,
                    tier:  r.tier || null,
                    ok:    Number(t.ok)      || 0,
                    failed: Number(t.failed) || 0,
                    skipped: Number(t.skipped) || 0,
                    aborted: !!r.aborted
                }
            }
            built.push(agg)
        }
        // Drop empty airlines (no fleet AND no routes) — they're stale
        // registry rows from one-off page visits where no scrape ran.
        const airlines = built.filter(a => a.fleetCount > 0 || a.routes.length > 0)
        airlines.sort((a, b) => b.fleetCount - a.fleetCount || (a.airline < b.airline ? -1 : 1))

        const {overlapHubs, overlapRoutes} = _overlapCounts(airlines)
        result.airlines = airlines
        result.overlapHubs = overlapHubs
        result.overlapRoutes = overlapRoutes
        return result
    }

    /** Convenience: every server in the registry, scanned in parallel.
     *  Returns Map<server, PortfolioServer>. */
    async function scanAll() {
        const out = new Map()
        if (!window.AesAccountRegistry) return out
        let accounts = []
        try { accounts = await window.AesAccountRegistry.list() } catch (_) { return out }
        const servers = Array.from(new Set(accounts.map(a => a && a.server).filter(Boolean)))
        await Promise.all(servers.map(async s => {
            try { out.set(s, await scanServer(s)) } catch (_) { /* per-server failure shouldn't blank the rest */ }
        }))
        return out
    }

    window.AesStrategyPortfolio = {scanServer, scanAll}

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // _overlapCounts is internal but we can validate via the public
            // API on synthetic input shapes (window.AesStrategyPortfolio is
            // declared above this block).
            const fakeAirlines = [
                {airline: "Sky", hubs: ["JFK", "LAX"], routes: ["JFK-LAX", "JFK-BOS"]},
                {airline: "Sun", hubs: ["JFK", "MIA"], routes: ["JFK-LAX", "MIA-ORD"]}
            ]
            const o = _overlapCounts(fakeAirlines)
            console.assert(o.overlapHubs.length === 1 && o.overlapHubs[0].iata === "JFK",
                "[smoke] portfolio overlap hub = JFK")
            console.assert(o.overlapRoutes.length === 1 && o.overlapRoutes[0].route === "JFK-LAX",
                "[smoke] portfolio overlap route = JFK-LAX")
            console.assert(o.overlapHubs[0].airlines.length === 2,
                "[smoke] hub overlap names both airlines")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
