"use strict"

/**
 * AES Strategy — context synthesis (Slice 1).
 *
 * Single read-only entry point that pulls every signal the strategy
 * engine needs from chrome.storage.local — demand, distance, competitor
 * intel, ORS / service profiles, maintenance + wear, flight log, ledger
 * P&L, sister airlines, crew, fleet roster, type specs, settings — and
 * returns one normalized snapshot.
 *
 * NO SCRAPING, NO POSTING. Every store this module touches is read-only;
 * if a store isn't loaded on the current page (e.g. the AFP wear-model is
 * only registered on aircraft-detail pages), the corresponding field
 * comes back null and is listed in `snapshot.missing` so the caller can
 * tell graceful-null from real data.
 *
 * Slices 2+ (decide-routes, allocate-fleet, panel) consume this snapshot
 * exclusively — they never reach back to the underlying stores. That
 * keeps the dependency graph single-direction and makes the strategy
 * layer testable in isolation.
 *
 * Public API (window.AesStrategy):
 *   snapshot({server?, airlineCode?, includeStaleDemand?}) → Promise<Snapshot>
 *
 * Snapshot shape (all fields nullable; consumers must handle nulls):
 *   {ts, server, airlineCode,
 *    fleet:           [{aircraftId, registration, equipment, typeId, age,
 *                       seats, cargoCapacity, rangeKm, cruiseSpeedKmh,
 *                       paxSatisfaction, currentLocationIata, status,
 *                       wear: {ratio, ratioStatus, condition, conditionStatus,
 *                              equilibriumWeeklyHours, weeklyHoursLast7d,
 *                              ratioForecast7d, maxWeeklyBlockHours,
 *                              maxDailyBlockHours, source},
 *                       profit: {lifetime, finishedFlights, totalFlights}}],
 *    hubs:            [{iata,
 *                       byRoute: [{dest, distanceKm, paxScore, cargoScore,
 *                                  weeklyFlights, ourPaxShare, profitPerWeek,
 *                                  status, score,
 *                                  competitor: {flightCount, seatCount,
 *                                                ourFlightCount, dominantCarrier,
 *                                                priceMin, priceMax, scrapedAt},
 *                                  override: {paxLF, cargoLF, yieldPerKm, note,
 *                                              expiresAt} | null,
 *                                  watchlisted, alreadyScheduled,
 *                                  snapshotAt}]}],
 *    serviceProfiles: [{id, name, classScore: {Y, C, F}, scrapedAt}],
 *    crew:            {byTypeId | bySkillLabel: {employed, active, required,
 *                                                  reserve, marketAvailable}},
 *    cash:            {bankBalance, weeklyResult, runwayWeeks},
 *    sisters:         {leasing, capital, assets, cashflow},
 *    rivals:          [{enterpriseId, name, hubs, alliance, sharedRoutes}],
 *    settings:        {scoring, economics, ors, autoScheduler, serviceProfiles},
 *    missing:         [string]   ← which stores were unavailable, for diagnostics}
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategy && window.AesStrategy.snapshot) return

    // ── Resolution helpers ──────────────────────────────────────────────

    function _resolveServer() {
        try {
            if (typeof AES !== "undefined" && AES.getServer) return AES.getServer() || null
        } catch (_) {}
        return null
    }

    function _resolveAirlineCode() {
        try {
            if (typeof AES !== "undefined" && AES.getAirlineIdentity) return AES.getAirlineIdentity() || null
        } catch (_) {}
        return null
    }

    function _has(name) { return typeof window[name] !== "undefined" }

    function _safe(p, fallback) {
        return p.catch(() => fallback)
    }

    // ── Fleet + per-tail enrichment ─────────────────────────────────────

    async function _loadFleetRaw(server, airlineCode) {
        if (!_has("AesFleetRoster")) return null
        try {
            return await window.AesFleetRoster.load(server, airlineCode || null)
        } catch (e) {
            console.warn("[AesStrategy] fleet load failed", e)
            return null
        }
    }

    async function _resolveTypeSpecs(typeIds) {
        const out = new Map()
        if (!typeIds.length) return out
        if (!_has("RouteAssistantTypeSpecsStore")) return out
        try {
            const records = await window.RouteAssistantTypeSpecsStore.getMany(typeIds)
            if (records && typeof records.forEach === "function") {
                records.forEach((rec, id) => out.set(Number(id), rec))
            } else if (Array.isArray(records)) {
                for (const r of records) if (r && r.typeId != null) out.set(Number(r.typeId), r)
            } else if (records && typeof records === "object") {
                for (const k of Object.keys(records)) {
                    const r = records[k]
                    if (r && r.typeId != null) out.set(Number(r.typeId), r)
                }
            }
        } catch (e) {
            console.warn("[AesStrategy] type-specs load failed", e)
        }
        // Per-typeId fallback in case getMany shape varies
        for (const id of typeIds) {
            if (out.has(Number(id))) continue
            try {
                const rec = await window.RouteAssistantTypeSpecsStore.get(id)
                if (rec) out.set(Number(id), rec)
            } catch (_) {}
        }
        return out
    }

    async function _enrichWear(server, aircraftId) {
        const out = {
            ratio:                  null,
            ratioStatus:            null,
            condition:              null,
            conditionStatus:        null,
            equilibriumWeeklyHours: null,
            weeklyHoursLast7d:      null,
            ratioForecast7d:        null,
            maxWeeklyBlockHours:    null,
            maxDailyBlockHours:     null,
            source:                 null
        }
        if (!server || !aircraftId) return out

        if (_has("AesAfpMaintenanceStore")) {
            try {
                const m = await window.AesAfpMaintenanceStore.load(server, aircraftId)
                if (m) {
                    out.ratio           = m.ratio
                    out.ratioStatus     = m.ratioStatus
                    out.condition       = m.condition
                    out.conditionStatus = m.conditionStatus
                }
            } catch (_) {}
        }
        if (_has("AesAfpFlightLogStore")) {
            try { out.weeklyHoursLast7d = await window.AesAfpFlightLogStore.weeklyBlockHours(server, aircraftId) }
            catch (_) {}
        }
        if (_has("AesAfpMaintenanceBudget")) {
            try {
                const b = await window.AesAfpMaintenanceBudget.compute({server, aircraftId})
                if (b) {
                    out.equilibriumWeeklyHours = b.fit && b.fit.equilibriumWeeklyBlockHours || null
                    out.ratioForecast7d        = b.forecastRatio7d != null ? b.forecastRatio7d : b.ratioForecast
                    out.maxWeeklyBlockHours    = b.maxWeeklyBlockHours
                    out.maxDailyBlockHours     = b.maxDailyBlockHours
                    out.source                 = b.source
                }
            } catch (_) {}
        }
        return out
    }

    function _buildPerTailProfit(ledger, aircraftId) {
        if (!ledger || !Array.isArray(ledger.aircraft)) {
            return {lifetime: null, finishedFlights: null, totalFlights: null}
        }
        const want = String(aircraftId)
        const row = ledger.aircraft.find(a => a && String(a.aircraftId) === want)
        if (!row) return {lifetime: null, finishedFlights: null, totalFlights: null}
        return {
            lifetime:        row.profit,
            finishedFlights: row.finishedFlights,
            totalFlights:    row.totalFlights
        }
    }

    async function _enrichFleet(server, fleetRaw, typesByTypeId, ledger) {
        if (!fleetRaw || !Array.isArray(fleetRaw.aircraft)) return []
        const out = []
        for (const a of fleetRaw.aircraft) {
            if (!a) continue
            const typeId = a.typeId != null ? Number(a.typeId) : null
            const spec   = typeId != null ? typesByTypeId.get(typeId) : null
            const wear   = await _enrichWear(server, a.aircraftId)
            const profit = _buildPerTailProfit(ledger, a.aircraftId)
            out.push({
                aircraftId:          a.aircraftId,
                registration:        a.registration || null,
                equipment:           a.equipment    || null,
                typeId:              typeId,
                age:                 isFinite(a.age) ? Number(a.age) : null,
                seats:               spec ? (spec.seats          != null ? spec.seats          : null) : null,
                cargoCapacity:       spec ? (spec.cargoCapacity  != null ? spec.cargoCapacity  : null) : null,
                rangeKm:             spec ? (spec.range          != null ? spec.range          : null) : null,
                cruiseSpeedKmh:      spec ? (spec.speed          != null ? spec.speed          : null) : null,
                paxSatisfaction:     spec ? (spec.paxSatisfaction != null ? spec.paxSatisfaction : null) : null,
                currentLocationIata: a.currentLocationIata || a.locationIata || null,
                status:              a.status || null,
                wear:                wear,
                profit:              profit
            })
        }
        return out
    }

    // ── Hub + route synthesis ───────────────────────────────────────────

    function _routeKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    function _buildHubs(ledger) {
        const hubMap = new Map()
        if (!ledger || !Array.isArray(ledger.routes)) return []
        for (const r of ledger.routes) {
            if (!r || !r.hub) continue
            const hub = String(r.hub).toUpperCase()
            if (!hubMap.has(hub)) hubMap.set(hub, {iata: hub, byRoute: []})
            hubMap.get(hub).byRoute.push({
                dest:              r.destIata,
                destName:          r.destName,
                distanceKm:        r.distanceKm,
                paxScore:          r.paxScore,
                cargoScore:        r.cargoScore,
                weeklyFlights:     r.weeklyFlights,
                ourPaxShare:       r.ourPaxShare,
                profitPerWeek:     r.profitPerWeek,
                status:            r.status,
                score:             r.score,
                competitor:        null,
                override:          null,
                watchlisted:       false,
                alreadyScheduled:  (Number(r.weeklyFlights) || 0) > 0,
                snapshotAt:        r.snapshotAt
            })
        }
        return Array.from(hubMap.values())
    }

    async function _attachDistance(hubs) {
        if (!_has("RouteAssistantDistanceResolver")) return
        const pairs = []
        for (const h of hubs) for (const r of h.byRoute) {
            if (r.dest && (r.distanceKm == null)) pairs.push([h.iata, r.dest])
        }
        if (!pairs.length) return
        try {
            const cache = await window.RouteAssistantDistanceResolver.bulkLoadCache(pairs, {})
            if (!cache || typeof cache.get !== "function") return
            for (const h of hubs) for (const r of h.byRoute) {
                if (r.distanceKm != null) continue
                const rec = cache.get(_routeKey(h.iata, r.dest))
                if (rec && isFinite(rec.distanceKm)) r.distanceKm = rec.distanceKm
            }
        } catch (_) {}
    }

    async function _attachDemand(hubs, opts) {
        if (!_has("RouteAssistantDemandStore")) return
        const iatas = new Set()
        for (const h of hubs) for (const r of h.byRoute) {
            if (r.dest && (r.paxScore == null || r.cargoScore == null)) iatas.add(r.dest)
        }
        if (!iatas.size) return
        try {
            const recs = await window.RouteAssistantDemandStore.getMany(Array.from(iatas), opts)
            if (!recs || typeof recs.get !== "function") return
            for (const h of hubs) for (const r of h.byRoute) {
                const rec = recs.get(String(r.dest || "").toUpperCase())
                if (!rec) continue
                if (r.paxScore   == null && rec.paxScore   != null) r.paxScore   = rec.paxScore
                if (r.cargoScore == null && rec.cargoScore != null) r.cargoScore = rec.cargoScore
            }
        } catch (_) {}
    }

    async function _attachOverrides(hubs) {
        if (!_has("RouteAssistantRouteOverridesStore")) return
        const pairs = []
        for (const h of hubs) for (const r of h.byRoute) {
            if (r.dest) pairs.push([h.iata, r.dest])
        }
        if (!pairs.length) return
        try {
            const recs = await window.RouteAssistantRouteOverridesStore.getMany(pairs)
            if (!recs || typeof recs.get !== "function") return
            for (const h of hubs) for (const r of h.byRoute) {
                const rec = recs.get(_routeKey(h.iata, r.dest))
                if (rec) {
                    r.override = {
                        paxLF:      rec.paxLF      != null ? rec.paxLF      : null,
                        cargoLF:    rec.cargoLF    != null ? rec.cargoLF    : null,
                        yieldPerKm: rec.yieldPerKm != null ? rec.yieldPerKm : null,
                        note:       rec.note       || null,
                        expiresAt:  rec.expiresAt  || null
                    }
                }
            }
        } catch (_) {}
    }

    async function _attachWatchlist(hubs) {
        if (!_has("RouteAssistantWatchlistStore")) return
        try {
            const keys = await window.RouteAssistantWatchlistStore.loadKeys()
            if (!keys || typeof keys.has !== "function") return
            for (const h of hubs) for (const r of h.byRoute) {
                if (keys.has(_routeKey(h.iata, r.dest))) r.watchlisted = true
            }
        } catch (_) {}
    }

    async function _attachCompetitorIntel(hubs) {
        if (!_has("RouteAssistantMarketsPageScraper")) return
        const pairs = []
        for (const h of hubs) for (const r of h.byRoute) {
            if (r.dest) pairs.push([h.iata, r.dest])
        }
        if (!pairs.length) return
        let cache = null
        try {
            cache = await window.RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {})
        } catch (_) { return }
        if (!cache || typeof cache.get !== "function") return

        for (const h of hubs) for (const r of h.byRoute) {
            const rec = cache.get(_routeKey(h.iata, r.dest))
            if (!rec) continue
            const summary = _summarizeCompetitorRecord(rec)
            r.competitor = summary
        }
    }

    function _summarizeCompetitorRecord(rec) {
        // Records may carry `competitors[]` or `pax[]` (market-share family);
        // we surface a tolerant summary that doesn't assume one shape.
        const out = {
            flightCount:     null,
            seatCount:       null,
            ourFlightCount:  null,
            dominantCarrier: null,
            priceMin:        null,
            priceMax:        null,
            scrapedAt:       rec.scrapedAt || null
        }
        if (Array.isArray(rec.competitors)) {
            out.flightCount = rec.competitors.length
            let prices = []
            let ours = 0
            for (const c of rec.competitors) {
                if (!c) continue
                if (c.isOurs) ours++
                if (isFinite(Number(c.price))) prices.push(Number(c.price))
            }
            out.ourFlightCount = ours
            if (prices.length) {
                out.priceMin = Math.min.apply(null, prices)
                out.priceMax = Math.max.apply(null, prices)
            }
        }
        if (Array.isArray(rec.pax) && rec.pax.length) {
            const top = rec.pax[0]
            if (top && top.name) out.dominantCarrier = top.name
        } else if (Array.isArray(rec.cargo) && rec.cargo.length && !out.dominantCarrier) {
            const top = rec.cargo[0]
            if (top && top.name) out.dominantCarrier = top.name
        }
        return out
    }

    // ── Service profiles, crew, cash, sisters, settings ─────────────────

    async function _loadServiceProfiles() {
        if (!_has("RouteAssistantServiceProfileScraper")) return null
        try {
            const list = await window.RouteAssistantServiceProfileScraper.loadList()
            const profiles = (list && list.profiles) || []
            const out = []
            for (const p of profiles) {
                if (!p || !p.id) continue
                let detail = null
                try { detail = await window.RouteAssistantServiceProfileScraper.loadDetail(p.id) }
                catch (_) {}
                out.push({
                    id:         p.id,
                    name:       p.name || (detail && detail.name) || null,
                    classScore: detail && detail.classScore ? detail.classScore : {Y: null, C: null, F: null},
                    scrapedAt:  detail && detail.scrapedAt   ? detail.scrapedAt   : null
                })
            }
            return out
        } catch (e) {
            console.warn("[AesStrategy] service profiles load failed", e)
            return null
        }
    }

    async function _loadCrew() {
        if (!_has("CrewMgmtStaffPilotsScraper")) return null
        try {
            const key = window.CrewMgmtStaffPilotsScraper.STORAGE_KEY
            if (!key) return null
            const out = await chrome.storage.local.get([key])
            const rec = out[key]
            if (!rec || !Array.isArray(rec.categories)) return null
            const bySkillLabel = {}
            for (const c of rec.categories) {
                if (!c || !c.label) continue
                bySkillLabel[c.label] = {
                    skillId:           c.skillId         != null ? c.skillId         : null,
                    employed:          c.employed        != null ? c.employed        : null,
                    active:            c.active          != null ? c.active          : null,
                    required:          c.required        != null ? c.required        : null,
                    reserve:           c.reserve         != null ? c.reserve         : null,
                    missing:           c.missing         != null ? c.missing         : null,
                    marketAvailable:   c.jobMarketAvailable != null ? c.jobMarketAvailable : null
                }
            }
            return {bySkillLabel, scrapedAt: rec.scrapedAt || null}
        } catch (_) { return null }
    }

    async function _loadLedger(server, airlineCode) {
        if (!_has("AccountingAggregator") || !server || !airlineCode) return null
        try { return await window.AccountingAggregator.loadUnifiedLedger(server, airlineCode) }
        catch (e) {
            console.warn("[AesStrategy] ledger load failed", e)
            return null
        }
    }

    function _summarizeCash(ledger) {
        const out = {bankBalance: null, weeklyResult: null, runwayWeeks: null}
        if (!ledger) return out
        const totals = ledger.periodActuals && ledger.periodActuals.totals
        if (totals && typeof totals === "object") {
            if (isFinite(Number(totals.netResult)))     out.weeklyResult = Number(totals.netResult)
            else if (isFinite(Number(totals.profit)))   out.weeklyResult = Number(totals.profit)
            if (isFinite(Number(totals.bankBalance)))   out.bankBalance  = Number(totals.bankBalance)
            else if (isFinite(Number(totals.cash)))     out.bankBalance  = Number(totals.cash)
        }
        if (out.bankBalance != null && out.weeklyResult != null && out.weeklyResult < 0) {
            out.runwayWeeks = Math.max(0, Math.floor(out.bankBalance / Math.abs(out.weeklyResult)))
        } else if (out.weeklyResult != null && out.weeklyResult >= 0) {
            out.runwayWeeks = Infinity
        }
        return out
    }

    function _trimSettings(settings) {
        if (!settings || typeof settings !== "object") return null
        const ra = settings.routeAssistant || settings
        return {
            scoring:         ra.scoring         || null,
            economics:       ra.economics       || null,
            ors:             ra.ors             || null,
            serviceProfiles: ra.serviceProfiles || null,
            autoScheduler:   settings.autoScheduler || null
        }
    }

    async function _loadSettings() {
        if (!_has("RouteAssistantSettings")) return null
        try { return await window.RouteAssistantSettings.load() }
        catch (_) { return null }
    }

    // ── Public entry ────────────────────────────────────────────────────

    async function snapshot(opts) {
        const o = opts || {}
        const server      = o.server      || _resolveServer()
        let airlineCode   = o.airlineCode || _resolveAirlineCode()
        const missing     = []

        if (!server) missing.push("server")

        const fleetRaw = await _loadFleetRaw(server, airlineCode)
        if (!fleetRaw)                         missing.push("AesFleetRoster")
        if (!airlineCode && fleetRaw && fleetRaw.airline) airlineCode = fleetRaw.airline

        const typeIds = (fleetRaw && fleetRaw.aircraft || [])
            .map(a => (a && a.typeId != null) ? Number(a.typeId) : null)
            .filter(Boolean)
        const dedupTypeIds = Array.from(new Set(typeIds))
        const typesByTypeId = await _resolveTypeSpecs(dedupTypeIds)
        if (!_has("RouteAssistantTypeSpecsStore")) missing.push("RouteAssistantTypeSpecsStore")
        if (!_has("AesAfpMaintenanceStore"))       missing.push("AesAfpMaintenanceStore")
        if (!_has("AesAfpMaintenanceBudget"))      missing.push("AesAfpMaintenanceBudget")
        if (!_has("AesAfpFlightLogStore"))         missing.push("AesAfpFlightLogStore")
        if (!_has("AccountingAggregator"))         missing.push("AccountingAggregator")
        if (!_has("RouteAssistantDemandStore"))    missing.push("RouteAssistantDemandStore")
        if (!_has("RouteAssistantDistanceResolver")) missing.push("RouteAssistantDistanceResolver")
        if (!_has("RouteAssistantRouteOverridesStore")) missing.push("RouteAssistantRouteOverridesStore")
        if (!_has("RouteAssistantWatchlistStore"))  missing.push("RouteAssistantWatchlistStore")
        if (!_has("RouteAssistantMarketsPageScraper")) missing.push("RouteAssistantMarketsPageScraper")
        if (!_has("RouteAssistantServiceProfileScraper")) missing.push("RouteAssistantServiceProfileScraper")
        if (!_has("CrewMgmtStaffPilotsScraper"))    missing.push("CrewMgmtStaffPilotsScraper")
        if (!_has("RouteAssistantSettings"))        missing.push("RouteAssistantSettings")

        const [
            ledger,
            serviceProfiles,
            crew,
            settings
        ] = await Promise.all([
            _loadLedger(server, airlineCode),
            _safe(_loadServiceProfiles(), null),
            _safe(_loadCrew(),            null),
            _safe(_loadSettings(),        null)
        ])

        const fleet = await _enrichFleet(server, fleetRaw, typesByTypeId, ledger)
        const hubs  = _buildHubs(ledger)

        await Promise.all([
            _attachDistance(hubs),
            _attachDemand(hubs, o.includeStaleDemand ? {includeStale: true} : undefined),
            _attachOverrides(hubs),
            _attachWatchlist(hubs),
            _attachCompetitorIntel(hubs)
        ])

        const cash    = _summarizeCash(ledger)
        const sisters = ledger ? (ledger.sisters || null) : null

        return {
            ts:              Date.now(),
            server:          server,
            airlineCode:     airlineCode,
            fleet:           fleet,
            hubs:            hubs,
            serviceProfiles: serviceProfiles,
            crew:            crew,
            cash:            cash,
            sisters:         sisters,
            rivals:          [],   // populated in Slice 5 (cross-airline / enterprise scraper)
            settings:        _trimSettings(settings),
            missing:         missing
        }
    }

    window.AesStrategy = {snapshot}
})()
