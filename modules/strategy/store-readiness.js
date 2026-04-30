"use strict"

/**
 * AES Strategy — Store readiness probe + auto-seed.
 *
 * The strategy panel composes its plan from a fan of stores: fleet roster
 * (DOM-scraped on /app/fleets), per-aircraft AFP schedules, market prices
 * per (hub, dest), crew, outcomes, etc. On a fresh tab where the user has
 * only opened /app/fleets, most of those stores are empty — so the panel
 * shows zeros and the decisions list is empty.
 *
 * This module:
 *   1. Probes each store's fill state and returns a structured report.
 *   2. Runs the auto-seedable scrapers (those that fetch HTML rather than
 *      requiring DOM scrape on a navigated page) for stores that are
 *      empty or stale, idempotently.
 *   3. Bootstraps a route list from snapshot/AFP/portfolio/fleets-DOM so
 *      the markets seeder has pairs to work with even before accounting
 *      has been visited.
 *
 * Public API (window.AesStrategyStoreReadiness):
 *   probe({snapshot, server, airline, accountId, currentSchedules}) →
 *     Promise<Item[]>
 *   seedMissing(opts, onProgress) →
 *     Promise<{ran, ok, errors}>
 *   bootstrapRoutesFromFleetsDom(doc?) → Array<{hub, dest}>
 *
 * Item shape:
 *   {key, label, status, count, detail, action, navigateTo?}
 *     status ∈ "filled" | "partial" | "empty" | "module-missing"
 *     action.kind ∈ "seed" (auto-seedable) | "nav" (one URL) | "nav-list"
 *
 * Graceful-null per the rest of the strategy module: every probe returns
 * a sensible "empty"/"module-missing" status when its dependencies aren't
 * loaded so the diagnostic block always renders something useful.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyStoreReadiness) return

    // Freshness windows. A "filled" status means present AND fresher than
    // these bounds — older records still count for "partial" so the user
    // sees the cached data is stale rather than missing entirely.
    const FRESH_MS = {
        markets:   24 * 3600 * 1000,
        pilots:     6 * 3600 * 1000,
        schedule:  12 * 3600 * 1000
    }
    const MARKET_MAX_AGE_DAYS_FOR_PROBE = 14

    function _ago(ts) {
        if (!ts) return "?"
        const ms = Date.now() - Number(ts)
        if (ms < 0) return "just now"
        const min = Math.floor(ms / 60000)
        if (min < 60) return min + "m ago"
        const hr = Math.floor(min / 60)
        if (hr < 48) return hr + "h ago"
        return Math.floor(hr / 24) + "d ago"
    }

    // ── Route enumeration ────────────────────────────────────────────────
    /**
     * Build a (hub, dest) pair list from whatever the snapshot already
     * knows. Falls through these sources in order:
     *   1. snapshot.hubs[*].routes — populated when accounting was visited
     *   2. snapshot.fleet.aircraft via cached AFP schedules
     *   3. portfolio routes (sister-airline scan often picks ours up too)
     *   4. /app/fleets DOM (current page) — last-resort heuristic
     * Deduped + uppercased.
     */
    function enumerateRoutes(opts) {
        const o = opts || {}
        const seen = new Set()
        const out = []
        const add = (hub, dest) => {
            const H = String(hub || "").toUpperCase()
            const D = String(dest || "").toUpperCase()
            if (!H || !D || H === D) return
            const k = H + "-" + D
            if (seen.has(k)) return
            seen.add(k)
            out.push({hub: H, dest: D})
        }

        // (1) snapshot hubs — most authoritative
        const snapshot = o.snapshot
        if (snapshot && Array.isArray(snapshot.hubs)) {
            for (const hub of snapshot.hubs) {
                const code = hub.iata || hub.code || hub.hub
                if (!code) continue
                const routes = hub.routes || hub.routesArray || []
                for (const r of routes) {
                    add(code, r.dest || r.destIata || r.iata || r.code)
                }
            }
        }

        // (2) cached current schedules — Map<aircraftId, legs[]>
        const cs = o.currentSchedules
        if (cs && typeof cs.forEach === "function") {
            cs.forEach((legs) => {
                if (!Array.isArray(legs)) return
                for (const l of legs) {
                    add(l.origin, l.destination)
                }
            })
        }

        // (3) portfolio overlap — sister-airline scan often surfaces
        //     routes the active airline flies even if hubs[] is empty
        const pf = o.portfolio
        if (pf && Array.isArray(pf.overlapRoutes)) {
            for (const r of pf.overlapRoutes) {
                add(r.hub, r.dest)
            }
        }

        // (4) /app/fleets DOM — last-resort heuristic
        if (!out.length && o.fleetsDoc) {
            for (const r of bootstrapRoutesFromFleetsDom(o.fleetsDoc)) {
                add(r.hub, r.dest)
            }
        }
        return out
    }

    /**
     * Heuristic: parse the /app/fleets DOM for IATA-shaped tokens grouped
     * by row. The fleets table sometimes shows aircraft hubbase + most-
     * recent destinations; we can't tell which is the hub vs the dest, so
     * we add cross-pairs and let the user/scraper sort it out. Conservative
     * cap at 50 pairs so a malformed page doesn't explode. Returns [] when
     * the page has no fleet table.
     */
    function bootstrapRoutesFromFleetsDom(doc) {
        const root = doc || (typeof document !== "undefined" ? document : null)
        if (!root) return []
        const out = []
        const seen = new Set()
        const add = (a, b) => {
            if (!a || !b || a === b) return
            const k = a + "-" + b
            if (seen.has(k)) return
            seen.add(k)
            out.push({hub: a, dest: b})
        }
        for (const t of root.querySelectorAll("table")) {
            const headTxt = (t.tHead && t.tHead.textContent) || ""
            if (!/aircraft|reg(istration)?/i.test(headTxt)) continue
            for (const tr of t.querySelectorAll("tbody tr")) {
                if (out.length >= 50) break
                const text = tr.textContent || ""
                const tokens = text.match(/\b[A-Z]{3}\b/g) || []
                if (tokens.length < 2) continue
                const hub = tokens[0]
                for (let i = 1; i < tokens.length; i++) {
                    add(hub, tokens[i])
                    if (out.length >= 50) break
                }
            }
        }
        return out
    }

    // ── Probes ───────────────────────────────────────────────────────────

    function _aircraftFromSnapshot(snapshot) {
        if (!snapshot || !snapshot.fleet) return []
        return Array.isArray(snapshot.fleet.aircraft) ? snapshot.fleet.aircraft : []
    }

    async function _probeFleet(o) {
        const aircraft = _aircraftFromSnapshot(o.snapshot)
        if (aircraft.length) {
            return {key: "fleet", label: "Fleet roster",
                    status: "filled", count: aircraft.length,
                    detail: aircraft.length + " tail" + (aircraft.length === 1 ? "" : "s") + " in roster",
                    action: null}
        }
        return {key: "fleet", label: "Fleet roster",
                status: "empty", count: 0,
                detail: "No aircraft cached for this airline. Open the Fleet Management page to seed.",
                action: {kind: "nav",
                         label: "Open /app/fleets →",
                         url: "/app/fleets"}}
    }

    async function _probeSchedules(o) {
        const aircraft = _aircraftFromSnapshot(o.snapshot)
        const total = aircraft.length
        if (!total) {
            return {key: "schedules", label: "AFP schedules",
                    status: "empty", count: 0,
                    detail: "Fleet missing — can't probe schedules until roster is loaded.",
                    action: null}
        }
        let cached = 0
        if (o.currentSchedules && typeof o.currentSchedules.size === "number") {
            cached = o.currentSchedules.size
        } else if (o.server && window.AesAfpScheduleStore
                && typeof window.AesAfpScheduleStore.load === "function") {
            const ids = aircraft.map(a => String(a.aircraftId || a.id || ""))
            const out = await Promise.all(ids.map(id =>
                id ? window.AesAfpScheduleStore.load(o.server, id).catch(() => null)
                   : Promise.resolve(null)
            ))
            cached = out.filter(s => s && Array.isArray(s.legs) && s.legs.length).length
        }
        const status = (cached >= total) ? "filled" : (cached > 0 ? "partial" : "empty")
        const item = {
            key: "schedules", label: "AFP schedules",
            status: status, count: cached,
            detail: cached + " of " + total + " tail" + (total === 1 ? "" : "s") + " cached"
                  + (cached < total ? ". Open /app/aircraft/<id>/0 per tail to seed." : "."),
            action: null
        }
        if (cached < total) {
            // Surface the first few uncached tails as nav links so the
            // user has a one-click path. Cap at 5 — any more becomes
            // visual noise; the rest the user can hit by sorting in the
            // tile portfolio.
            const idsCached = new Set()
            if (o.currentSchedules && typeof o.currentSchedules.forEach === "function") {
                o.currentSchedules.forEach((_v, k) => idsCached.add(String(k)))
            }
            const missing = aircraft.filter(a => !idsCached.has(String(a.aircraftId || a.id))).slice(0, 5)
            if (missing.length) {
                item.action = {kind: "nav-list",
                               label: "Seed by visiting:",
                               items: missing.map(a => ({
                                   label: (a.registration || a.aircraftId || a.id),
                                   url: "/app/aircraft/" + (a.aircraftId || a.id) + "/0"
                               }))}
            }
        }
        return item
    }

    async function _probeRoutes(o, routes) {
        if (routes.length) {
            return {key: "routes", label: "Routes known",
                    status: "filled", count: routes.length,
                    detail: routes.length + " (hub→dest) pair"
                          + (routes.length === 1 ? "" : "s")
                          + " from snapshot/AFP/portfolio",
                    action: null}
        }
        return {key: "routes", label: "Routes known",
                status: "empty", count: 0,
                detail: "No routes enumerable. Visit accounting once so per-route ledger seeds.",
                action: {kind: "nav",
                         label: "Open accounting →",
                         url: "/app/finance/accounting/0"}}
    }

    async function _probeMarkets(o, routes) {
        if (typeof window.RouteAssistantMarketsPageScraper === "undefined") {
            return {key: "markets", label: "Market data (competitors + own pricing)",
                    status: "module-missing", count: 0,
                    detail: "RouteAssistantMarketsPageScraper not loaded on this page.",
                    action: null}
        }
        if (!o.server) {
            return {key: "markets", label: "Market data (competitors + own pricing)",
                    status: "empty", count: 0,
                    detail: "Server unknown — can't construct scraper.",
                    action: null}
        }
        if (!routes.length) {
            return {key: "markets", label: "Market data (competitors + own pricing)",
                    status: "empty", count: 0,
                    detail: "No routes to probe (depends on Routes known).",
                    action: null}
        }
        let cache = new Map()
        try {
            cache = await window.RouteAssistantMarketsPageScraper.bulkLoadCache(routes, {
                families: ["competitors", "ownPricing"],
                maxAge:   {competitors: MARKET_MAX_AGE_DAYS_FOR_PROBE,
                           ownPricing:  MARKET_MAX_AGE_DAYS_FOR_PROBE}
            })
        } catch (e) {
            return {key: "markets", label: "Market data (competitors + own pricing)",
                    status: "empty", count: 0,
                    detail: "Probe failed: " + ((e && e.message) || String(e)),
                    action: null}
        }
        let filled = 0
        for (const v of cache.values()) {
            if (v && (v.competitors || v.ownPricing)) filled++
        }
        const total = routes.length
        const missingCount = total - filled
        const status = (filled === 0) ? "empty" : (filled < total ? "partial" : "filled")
        const item = {
            key: "markets", label: "Market data (competitors + own pricing)",
            status: status, count: filled,
            detail: filled + " of " + total + " route" + (total === 1 ? "" : "s")
                  + " cached" + (filled < total ? " · " + missingCount + " to seed" : ""),
            action: null
        }
        if (missingCount > 0) {
            item.action = {
                kind: "seed",
                label: "Seed " + missingCount + " market" + (missingCount === 1 ? "" : "s") + " →",
                run: async (subOpts) => {
                    const inst = new window.RouteAssistantMarketsPageScraper(o.server, {})
                    const missing = []
                    for (const r of routes) {
                        const k = r.hub + "-" + r.dest
                        const rec = cache.get(k)
                        if (!rec || !(rec.competitors || rec.ownPricing)) missing.push(r)
                    }
                    if (!missing.length) return
                    await inst.bulkScrape(missing, {
                        concurrency: 3,
                        staggerMs: 600,
                        onProgress: (done, total) => {
                            if (subOpts && subOpts.onProgress) {
                                subOpts.onProgress({sub: done + "/" + total + " routes"})
                            }
                        }
                    })
                }
            }
        }
        return item
    }

    async function _probeCrewPilots(o) {
        if (typeof window.CrewMgmtStaffPilotsScraper === "undefined") {
            return {key: "crewPilots", label: "Crew · pilots",
                    status: "module-missing", count: 0,
                    detail: "CrewMgmtStaffPilotsScraper not loaded.",
                    action: null}
        }
        let rec = null
        try {
            const out = await chrome.storage.local.get([window.CrewMgmtStaffPilotsScraper.STORAGE_KEY])
            rec = out[window.CrewMgmtStaffPilotsScraper.STORAGE_KEY] || null
        } catch (_) {}
        const cats = (rec && Array.isArray(rec.categories)) ? rec.categories : []
        const fresh = !!(rec && rec.scrapedAt && (Date.now() - rec.scrapedAt) < FRESH_MS.pilots)
        const status = fresh ? "filled" : (rec ? "partial" : "empty")
        const item = {
            key: "crewPilots", label: "Crew · pilots",
            status: status, count: cats.length,
            detail: rec
                ? cats.length + " skill categor" + (cats.length === 1 ? "y" : "ies")
                  + " · cached " + _ago(rec.scrapedAt) + (fresh ? "" : " (stale)")
                : "Not yet scraped.",
            action: null
        }
        if (status !== "filled" && o.server) {
            item.action = {
                kind: "seed",
                label: rec ? "Refresh crew →" : "Seed crew →",
                run: async () => {
                    const inst = new window.CrewMgmtStaffPilotsScraper()
                    await inst.scrape(o.server)
                }
            }
        }
        return item
    }

    async function _probeOutcomes(o) {
        if (typeof window.AesStrategyOutcomes === "undefined") {
            return {key: "outcomes", label: "Learning outcomes",
                    status: "module-missing", count: 0,
                    detail: "AesStrategyOutcomes not loaded.",
                    action: null}
        }
        try {
            const c = await window.AesStrategyOutcomes.countReady(undefined, o.accountId || null)
            const total = (Number(c.recorded) || 0)
            const status = total > 0 ? "filled" : "empty"
            return {key: "outcomes", label: "Learning outcomes",
                    status: status, count: total,
                    detail: (c.recorded || 0) + " recorded · "
                          + (c.attributed || 0) + " attributed · "
                          + (c.ready || 0) + " ready"
                          + (total === 0 ? " (need 24h post-apply)" : ""),
                    action: null}
        } catch (e) {
            return {key: "outcomes", label: "Learning outcomes",
                    status: "empty", count: 0,
                    detail: "Probe threw: " + ((e && e.message) || String(e)),
                    action: null}
        }
    }

    // ── Public API ───────────────────────────────────────────────────────

    /**
     * Probe every store. Routes are derived once (via enumerateRoutes) and
     * passed into both the routes probe and markets probe so the two stay
     * in sync — if routes is empty, markets reports the same.
     */
    async function probe(opts) {
        const o = opts || {}
        const routes = enumerateRoutes(o)
        const items = []
        items.push(await _probeFleet(o))
        items.push(await _probeSchedules(o))
        items.push(await _probeRoutes(o, routes))
        items.push(await _probeMarkets(o, routes))
        items.push(await _probeCrewPilots(o))
        items.push(await _probeOutcomes(o))
        return items
    }

    /**
     * Run every auto-seedable item that isn't already filled. Sequential
     * (not parallel) so the markets pump doesn't compete with the crew
     * fetch — both are HTTPing the same origin and we don't want to
     * trip rate limits. `onProgress` fires on stage transitions and
     * sub-progress notes from the seeders.
     */
    async function seedMissing(opts, onProgress) {
        const items = await probe(opts || {})
        const seedables = items.filter(it =>
            it.action && it.action.kind === "seed" && it.status !== "filled")
        const total = seedables.length
        const report = {ran: total, ok: 0, errors: []}
        if (onProgress) {
            onProgress({stage: "start", total: total})
        }
        if (!total) {
            if (onProgress) onProgress({stage: "done", total: 0, ok: 0})
            return report
        }
        let done = 0
        for (const item of seedables) {
            if (onProgress) {
                onProgress({stage: "seeding", label: item.label, done: done, total: total})
            }
            try {
                await item.action.run({
                    onProgress: (sub) => {
                        if (onProgress) {
                            onProgress(Object.assign(
                                {stage: "seeding", label: item.label, done: done, total: total},
                                sub
                            ))
                        }
                    }
                })
                report.ok++
            } catch (e) {
                report.errors.push({key: item.key, error: (e && e.message) || String(e)})
            }
            done++
        }
        if (onProgress) onProgress({stage: "done", total: total, ok: report.ok, errors: report.errors})
        return report
    }

    window.AesStrategyStoreReadiness = {
        probe:                       probe,
        seedMissing:                 seedMissing,
        enumerateRoutes:             enumerateRoutes,
        bootstrapRoutesFromFleetsDom: bootstrapRoutesFromFleetsDom
    }

    // ── ?aes-debug smoke ─────────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof probe === "function",
                "[smoke store-readiness] probe exposed")
            console.assert(typeof seedMissing === "function",
                "[smoke store-readiness] seedMissing exposed")
            console.assert(typeof enumerateRoutes === "function",
                "[smoke store-readiness] enumerateRoutes exposed")
            // enumerateRoutes on an empty snapshot returns []
            console.assert(enumerateRoutes({}).length === 0,
                "[smoke store-readiness] empty snapshot → 0 routes")
            // enumerateRoutes folds in cached schedules (Map) when hubs[] is empty
            const fakeSched = new Map()
            fakeSched.set("a1", [{origin: "ATL", destination: "JFK"}])
            const r = enumerateRoutes({currentSchedules: fakeSched})
            console.assert(r.length === 1 && r[0].hub === "ATL" && r[0].dest === "JFK",
                "[smoke store-readiness] schedule-derived route found")
        }
    } catch (_) { /* never break the page */ }
})()
