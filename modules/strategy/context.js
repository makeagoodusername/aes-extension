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
 *                       paxSatisfaction, orsAttraction, currentLocationIata, status,
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
 *                                  activeFlightControls: {inflight, avgCm5,
 *                                                cm5Count, missingFinancials,
 *                                                tailRegs, flightNumbers,
 *                                                flightIds, fnIds} | null,
 *                                  override: {paxLF, cargoLF, yieldPerKm, note,
 *                                              expiresAt} | null,
 *                                  watchlisted, alreadyScheduled,
 *                                  snapshotAt}]}],
 *    companyReputation: {displayName, airlineCode, enterpriseId,
 *                        ratingLabel, ratingScore, ratingNorm,
 *                        scrapedAt, source} | null,
 *    serviceProfiles: [{id, name, classScore: {Y, C, F}, scrapedAt}],
 *    serviceCategoryProfiles: {[profileId]: {profileId, profileName,
 *                              reputationExposure, weakestCategories}},
 *    crew:            {bySkillLabel: {employed, active, required,
 *                                       reserve, marketAvailable},
 *                       byPosition:   {[positionId]: {label, group, employed,
 *                                       active, required, redundant,
 *                                       salaryPerEmployee, nextWeekSalaryPerEmployee,
 *                                       countryAverage, payTierPctVsCountry,
 *                                       nextPayTierPctVsCountry, pendingChange,
 *                                       moodDigit, moodTrend}},
 *                       formContext:  {actionUrl, hidden, perRow, capturedAt} | null},
 *    crewRoleProfiles: {[positionId]: {responsibilityClass, reputationWeight,
 *                                      serviceWeight, reliabilityWeight,
 *                                      paySensitivity, weeklyPayCost}},
 *    cash:            {bankBalance, weeklyResult, runwayWeeks},
 *    sisters:         {leasing, capital, assets, cashflow},
 *    rivals:          [{enterpriseId, name, hubs, alliance, sharedRoutes}],
 *    alliance:        {membership: {name, members[], scrapedAt} | null,
 *                       partners:   [{partnerId, partnerName, partnerIata, relations[]}],
 *                       partnerIds: Set<string>,
 *                       allianceMemberIds: Set<string>,
 *                       ourEnterpriseId: string | null},
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

    function _num(v, fallback) {
        const n = Number(v)
        return Number.isFinite(n) ? n : fallback
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
                    // Lane C Phase 2 — null until fleetOptimizer.targetingEnabled.
                    out.targetWeeklyHours      = (b.targetWeeklyHours != null) ? b.targetWeeklyHours : null
                    out.floorPct               = (b.floorPct          != null) ? b.floorPct          : null
                    out.headroomPct            = (b.headroomPct       != null) ? b.headroomPct       : null
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
                orsAttraction:       spec ? (spec.orsAttraction   != null ? spec.orsAttraction   : null) : null,
                customerAttraction:  spec ? (spec.customerAttraction != null ? spec.customerAttraction : null) : null,
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
                        pricePin:   rec.pricePin   != null ? rec.pricePin   : null,
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

        // Slice 10 — capture priors so competitor-response.js has a
        // week-old reference next call. The store's capture() is itself
        // same-session safe (it only writes when the new record differs
        // from the most-recent entry, and its rolling backup preserves
        // the only week-old prior). Best-effort: missing store or single
        // route capture failure never fails the snapshot.
        const priorStore = window.AesStrategyCompetitorPriorStore
        if (priorStore && typeof priorStore.capture === "function") {
            for (const h of hubs) for (const r of h.byRoute) {
                if (!r.competitor) continue
                try { await priorStore.capture(h.iata, r.dest, r.competitor) }
                catch (_) {}
            }
        }
    }

    function _summarizeCompetitorRecord(rec) {
        // bulkLoadCache returns a route-family bundle
        // `{competitors, ownPricing, marketShare, historic}`, while older
        // callers may still pass flattened `{competitors[], pax[], cargo[]}`
        // records. Normalise both shapes so downstream world-view ranking can
        // recover the dominant competitor enterpriseId from market-share.
        const competitorList = Array.isArray(rec && rec.competitors)
            ? rec.competitors
            : ((rec && rec.competitors && Array.isArray(rec.competitors.competitors))
                ? rec.competitors.competitors
                : [])
        const pax = Array.isArray(rec && rec.pax)
            ? rec.pax
            : ((rec && rec.marketShare && Array.isArray(rec.marketShare.pax))
                ? rec.marketShare.pax
                : [])
        const cargo = Array.isArray(rec && rec.cargo)
            ? rec.cargo
            : ((rec && rec.marketShare && Array.isArray(rec.marketShare.cargo))
                ? rec.marketShare.cargo
                : [])
        const scrapedAt = (rec && rec.scrapedAt)
            || (rec && rec.marketShare && rec.marketShare.scrapedAt)
            || (rec && rec.competitors && rec.competitors.scrapedAt)
            || null

        const out = {
            flightCount:     null,
            seatCount:       null,
            ourFlightCount:  null,
            dominantCarrier: null,
            dominantEnterpriseId: null,
            priceMin:        null,
            priceMax:        null,
            byClass:         null,
            scrapedAt:       scrapedAt
        }
        if (competitorList.length) {
            out.flightCount = competitorList.length
            let prices = []
            let ours = 0
            // Per-class price arrays — every flight row carries serviceClass
            // ("Y" | "C" | "F" | "Cargo"). Pre-summary the autopricer compared
            // each class's own price against a band polluted by other classes;
            // splitting here lets _targetPct read a clean per-class band.
            const byCls = {Y: [], C: [], F: [], Cargo: []}
            for (const c of competitorList) {
                if (!c) continue
                if (c.isOurs) { ours++; continue }
                const px = Number(c.price)
                if (!isFinite(px)) continue
                prices.push(px)
                const cls = String(c.serviceClass || "").trim()
                if (byCls[cls]) byCls[cls].push(px)
            }
            out.ourFlightCount = ours
            if (prices.length) {
                out.priceMin = Math.min.apply(null, prices)
                out.priceMax = Math.max.apply(null, prices)
            }
            const byClass = {}
            let any = false
            for (const k of ["Y", "C", "F", "Cargo"]) {
                const arr = byCls[k]
                if (!arr.length) continue
                byClass[k] = {
                    priceMin: Math.min.apply(null, arr),
                    priceMax: Math.max.apply(null, arr),
                    samples:  arr.length
                }
                any = true
            }
            if (any) out.byClass = byClass
        }
        if (pax.length) {
            const top = pax[0]
            if (top && top.name) out.dominantCarrier = top.name
            if (top && top.enterpriseId != null) out.dominantEnterpriseId = top.enterpriseId
        } else if (cargo.length && !out.dominantCarrier) {
            const top = cargo[0]
            if (top && top.name) out.dominantCarrier = top.name
            if (top && top.enterpriseId != null) out.dominantEnterpriseId = top.enterpriseId
        }
        return out
    }

    // ── ORS cache + ownPricing attach (Velvet Cascade · PR 1A) ──────────

    async function _attachOrsCache(hubs) {
        if (!_has("RouteAssistantOrsScraper") && !_has("RouteAssistantOrsIntelligence")) return
        const pairs = []
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            if (r && r.dest) pairs.push([h.iata, r.dest])
        }
        if (!pairs.length) return
        let cache
        try {
            cache = window.RouteAssistantOrsIntelligence
                ? await window.RouteAssistantOrsIntelligence.bulkLoadRecords(pairs, {})
                : await window.RouteAssistantOrsScraper.bulkLoadCache(pairs, {})
        }
        catch (_) { return }
        if (!cache || typeof cache.get !== "function") return
        const svc = window.RouteAssistantOrsIntelligence
            ? new window.RouteAssistantOrsIntelligence()
            : null
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            const rec = cache.get(_routeKey(h.iata, r.dest))
            if (!rec) continue
            r.orsByClass    = rec.byClass || null
            r.orsScrapedAt  = rec.scrapedAt || null
            r.classesScraped = rec.classesScraped || null
            if (svc) {
                const composite = svc.getComposite({orsByClass: rec.byClass}, null)
                r.orsReadiness = {
                    usable: composite && (composite.rankAny != null || composite.rankNonstop != null
                        || composite.ourTopRating != null),
                    warnings: rec.oursDetection && rec.oursDetection.prefixFallbackOnly
                        ? ["prefix-fallback-only"] : [],
                    oursDetection: rec.oursDetection || null
                }
            }
        }
    }

    async function _attachOwnPricing(hubs) {
        if (!_has("RouteAssistantMarketsPageScraper")) return
        const pairs = []
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            if (r && r.dest) pairs.push([h.iata, r.dest])
        }
        if (!pairs.length) return
        let blob
        try { blob = await window.RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {}) }
        catch (_) { return }
        if (!blob || typeof blob.get !== "function") return
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            const fam = blob.get(_routeKey(h.iata, r.dest))
            if (!fam) continue
            if (fam.ownPricing && fam.ownPricing.prices) {
                r.ownPricing = {prices: Object.assign({}, fam.ownPricing.prices),
                                scrapedAt: fam.ownPricing.scrapedAt || null}
            }
            // Phase A5 — surface per-family scrapedAt so _attachCacheAges
            // can build a byKey staleness map. Lets the auto-driver
            // freshener pick the worst key, not be masked by one fresh one.
            if (fam.marketShare && isFinite(fam.marketShare.scrapedAt)) {
                r.marketShareScrapedAt = fam.marketShare.scrapedAt
            }
            if (fam.historic && isFinite(fam.historic.scrapedAt)) {
                r.historicScrapedAt = fam.historic.scrapedAt
            }
        }
    }

    /**
     * Surface per-route cache age — the staleness signal proposers and
     * the apply pipeline need to gate on. Reads existing `scrapedAt`
     * fields on competitor / ORS / ownPricing / marketShare / historic
     * records and projects them into milliseconds since now, plus a
     * `maxMs` worst-of for one-shot gating and a `byKey` map so the
     * freshener can pick the worst-stale family by name. All optional —
     * missing sources just don't populate that sub-field. Pure /
     * synchronous; runs after the parallel attaches.
     */
    function _attachCacheAges(hubs, ts) {
        const now = isFinite(ts) ? ts : Date.now()
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            if (!r) continue
            const ages = {byKey: {}}
            if (r.competitor && isFinite(r.competitor.scrapedAt)) {
                ages.competitorMs   = Math.max(0, now - r.competitor.scrapedAt)
                ages.byKey.competitors = ages.competitorMs
            }
            if (isFinite(r.orsScrapedAt)) {
                ages.orsMs       = Math.max(0, now - r.orsScrapedAt)
                ages.byKey.ors   = ages.orsMs
            }
            if (r.ownPricing && isFinite(r.ownPricing.scrapedAt)) {
                ages.ownPriceMs        = Math.max(0, now - r.ownPricing.scrapedAt)
                ages.byKey.ownPricing  = ages.ownPriceMs
            }
            if (isFinite(r.marketShareScrapedAt)) {
                ages.byKey.marketShare = Math.max(0, now - r.marketShareScrapedAt)
            }
            if (isFinite(r.historicScrapedAt)) {
                ages.byKey.historic    = Math.max(0, now - r.historicScrapedAt)
            }
            const finite = []
            for (const k of Object.keys(ages)) {
                if (k === "byKey") continue
                if (isFinite(ages[k])) finite.push(ages[k])
            }
            for (const k of Object.keys(ages.byKey)) {
                if (isFinite(ages.byKey[k])) finite.push(ages.byKey[k])
            }
            ages.maxMs = finite.length ? Math.max.apply(null, finite) : null
            // worstKey: the family name driving maxMs — surfaced so the
            // auto-driver freshener can re-fetch only what's stale.
            if (ages.maxMs != null) {
                for (const k of Object.keys(ages.byKey)) {
                    if (ages.byKey[k] === ages.maxMs) { ages.worstKey = k; break }
                }
            }
            r.cacheAge = ages
        }
    }

    /**
     * Attach calibration corpus per route — the saved sandbox scenarios
     * (user what-if runs at given price/LF/yield combinations) and the
     * recent ORS snapshots (calibration freeze-frames captured by the
     * route-sync orchestrator). Used by downstream proposers as evidence
     * the rationale strings can cite, e.g. "ORS rank trended 3.2 → 2.8 in
     * last 5 snapshots — current price likely below optimum".
     *
     * Defensive: typeof guards every store; per-route failures are
     * swallowed and just leave the field absent so the snapshot composer
     * never sinks on a calibration-store outage.
     */
    async function _attachCalibrationCorpus(hubs) {
        const pairs = []
        for (const h of hubs || []) {
            for (const r of (h && h.byRoute) || []) {
                if (r && r.dest) pairs.push([h.iata, r.dest])
            }
        }
        if (!pairs.length) return

        // ORS snapshot history — bulkList is the cheap path; one storage
        // read for the whole pair set, lightweight summaries returned.
        let orsByPair = null
        if (_has("RouteAssistantOrsSnapshotStore")
                && typeof window.RouteAssistantOrsSnapshotStore.bulkList === "function") {
            try {
                orsByPair = await window.RouteAssistantOrsSnapshotStore.bulkList(
                    pairs.map(p => ({hub: p[0], dest: p[1]}))
                )
            } catch (_) { orsByPair = null }
        }

        // Sandbox scenarios — no bulk API on the store, so fan out per-route.
        // Snapshot composition is not a render hot path (called minutes
        // cadence at most), so the per-route storage reads are acceptable.
        const sandboxByPair = new Map()
        if (_has("RouteAssistantSandboxScenariosStore")
                && typeof window.RouteAssistantSandboxScenariosStore.list === "function") {
            await Promise.all(pairs.map(async (p) => {
                try {
                    const scenarios = await window.RouteAssistantSandboxScenariosStore.list(p[0], p[1])
                    if (scenarios && scenarios.length) {
                        sandboxByPair.set(_routeKey(p[0], p[1]), scenarios)
                    }
                } catch (_) { /* per-route failure stays silent */ }
            }))
        }

        for (const h of hubs || []) {
            for (const r of (h && h.byRoute) || []) {
                if (!r || !r.dest) continue
                const k = _routeKey(h.iata, r.dest)
                if (orsByPair && typeof orsByPair.get === "function") {
                    const list = orsByPair.get(k)
                    if (Array.isArray(list) && list.length) {
                        r.orsHistory = list.slice(0, 5)
                    }
                }
                if (sandboxByPair.has(k)) {
                    r.sandboxScenarios = sandboxByPair.get(k)
                }
            }
        }
    }

    /**
     * Attach a representative aircraft spec per route — the smallest tail in
     * fleet whose range covers the round-trip + ~5% margin. Used by the
     * joint rank-target tuner so per-route projections have an estimator-
     * compatible spec without forcing each route to know its assigned tail.
     * Routes without a viable spec stay null; tuner skips them gracefully.
     */
    function _attachRouteSpec(hubs, fleet) {
        if (!Array.isArray(hubs) || !Array.isArray(fleet) || !fleet.length) return
        const candidates = fleet.filter(a => a
            && a.rangeKm != null && a.rangeKm > 0
            && a.seats   != null && a.seats   > 0
            && a.cruiseSpeedKmh != null && a.cruiseSpeedKmh > 0)
        if (!candidates.length) return
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            const dist = Number(r && r.distanceKm) || 0
            if (!dist) continue
            let best = null
            for (const c of candidates) {
                if (c.rangeKm < dist * 1.05) continue
                if (!best || c.seats < best.seats) best = c
            }
            if (best) {
                r.spec = {
                    seats:           best.seats,
                    cargoCapacity:   best.cargoCapacity,
                    range:           best.rangeKm,
                    speed:           best.cruiseSpeedKmh,
                    paxSatisfaction: best.paxSatisfaction,
                    orsAttraction:   best.orsAttraction,
                    customerAttraction: best.customerAttraction
                }
            }
        }
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
                    id:               p.id,
                    name:             p.name || (detail && detail.name) || null,
                    classScore:       detail && detail.classScore ? detail.classScore : {Y: null, C: null, F: null},
                    categories:       detail && detail.categories ? detail.categories : null,
                    categoryByPrefix: detail && detail.categoryByPrefix ? detail.categoryByPrefix : null,
                    scrapedAt:        detail && detail.scrapedAt   ? detail.scrapedAt   : null
                })
            }
            return out
        } catch (e) {
            console.warn("[AesStrategy] service profiles load failed", e)
            return null
        }
    }

    async function _loadCompanyReputation() {
        if (!_has("AesCompanyReputationStore")) return null
        try {
            return await window.AesCompanyReputationStore.loadLatest()
        } catch (e) {
            console.warn("[AesStrategy] company reputation load failed", e)
            return null
        }
    }

    const DEFAULT_ROLE_PROFILE = Object.freeze({
        responsibilityClass: "operations",
        reputationWeight:   0.35,
        serviceWeight:      0.30,
        reliabilityWeight:  0.55,
        paySensitivity:     0.50
    })
    const GROUP_ROLE_PROFILE = Object.freeze({
        "flight crew": Object.freeze({
            responsibilityClass: "flight",
            reputationWeight:   0.75,
            serviceWeight:      0.35,
            reliabilityWeight:  1.00,
            paySensitivity:     0.85
        }),
        "cabin crew": Object.freeze({
            responsibilityClass: "cabin",
            reputationWeight:   1.00,
            serviceWeight:      0.90,
            reliabilityWeight:  0.70,
            paySensitivity:     0.90
        }),
        "ground crew": Object.freeze({
            responsibilityClass: "ground",
            reputationWeight:   0.55,
            serviceWeight:      0.45,
            reliabilityWeight:  0.85,
            paySensitivity:     0.65
        })
    })
    const CATEGORY_REPUTATION_WEIGHT = Object.freeze({
        drinks:              0.80,
        snacks:              0.85,
        entrees:             1.00,
        additionalEntrees:   0.95,
        foodPresentation:    0.90,
        headphones:          0.65,
        newspapersMagazines: 0.45,
        flightMagazines:     0.40
    })

    function _resolveReputationPlanning(strategySettings) {
        const block = (strategySettings && strategySettings.reputationPlanning) || {}
        return {
            enabled:           block.enabled !== false,
            targetRatingScore: _num(block.targetRatingScore, 8),
            categoryWeights:   block.categoryWeights || {},
            roleWeights:       block.roleWeights || {}
        }
    }

    function _roleProfileFor(role, planning) {
        const groupKey = String(role && role.group || "").toLowerCase()
        const base = GROUP_ROLE_PROFILE[groupKey] || DEFAULT_ROLE_PROFILE
        const overrides = (planning && planning.roleWeights) || {}
        const key = base.responsibilityClass
        const override = _num(overrides[key], NaN)
        const reputationWeight = Number.isFinite(override)
            ? Math.max(0, Math.min(10, override))
            : base.reputationWeight
        const salary = _num(role && role.salaryPerEmployee, 0)
        const nextSalary = _num(role && role.nextWeekSalaryPerEmployee, salary)
        const employed = _num(role && role.employed, 0)
        const countryAvg = _num(role && role.countryAverage, 0)
        return {
            positionId:          role && role.positionId || null,
            label:               role && role.label || null,
            group:               role && role.group || null,
            responsibilityClass: base.responsibilityClass,
            reputationWeight:    reputationWeight,
            serviceWeight:       base.serviceWeight,
            reliabilityWeight:   base.reliabilityWeight,
            paySensitivity:      base.paySensitivity,
            currentPayTierPct:   countryAvg > 0 && salary > 0 ? Math.round((salary / countryAvg) * 100) : null,
            nextPayTierPct:      countryAvg > 0 && nextSalary > 0 ? Math.round((nextSalary / countryAvg) * 100) : null,
            weeklyPayCost:       salary * employed,
            nextWeeklyPayCost:   nextSalary * employed,
            moodDigit:           role && role.moodDigit != null ? role.moodDigit : null,
            moodTrend:           role && role.moodTrend != null ? role.moodTrend : null,
            pendingChange:       !!(role && role.pendingChange)
        }
    }

    function _deriveCrewRoleProfiles(crew, strategySettings) {
        const byPosition = crew && crew.byPosition
        if (!byPosition || typeof byPosition !== "object") return null
        const planning = _resolveReputationPlanning(strategySettings)
        const out = {}
        for (const positionId of Object.keys(byPosition)) {
            const role = Object.assign({positionId: positionId}, byPosition[positionId] || {})
            out[positionId] = _roleProfileFor(role, planning)
        }
        return out
    }

    function _deriveServiceCategoryProfiles(serviceProfiles, strategySettings) {
        if (!Array.isArray(serviceProfiles) || !serviceProfiles.length) return null
        const planning = _resolveReputationPlanning(strategySettings)
        const overrides = planning.categoryWeights || {}
        const out = {}
        for (const profile of serviceProfiles) {
            if (!profile || profile.id == null) continue
            const categories = profile.categories || {}
            const categoryWeights = {}
            const weakest = []
            let weightSum = 0
            let weightedStrength = 0
            for (const catKey of Object.keys(categories)) {
                const cat = categories[catKey] || {}
                const override = _num(overrides[catKey], NaN)
                const weight = Number.isFinite(override)
                    ? Math.max(0, Math.min(10, override))
                    : (CATEGORY_REPUTATION_WEIGHT[catKey] != null ? CATEGORY_REPUTATION_WEIGHT[catKey] : 0.50)
                categoryWeights[catKey] = weight
                const vals = ["Y", "C", "F"]
                    .map(cls => _num(cat[cls], NaN))
                    .filter(Number.isFinite)
                if (!vals.length) continue
                const avg = vals.reduce((s, v) => s + v, 0) / vals.length
                weightSum += weight
                weightedStrength += weight * avg
                weakest.push({category: catKey, avgLevel: avg, weight: weight})
            }
            weakest.sort((a, b) => (a.avgLevel - b.avgLevel) || (b.weight - a.weight))
            out[String(profile.id)] = {
                profileId:           profile.id,
                profileName:         profile.name || ("#" + profile.id),
                classScore:          profile.classScore || null,
                categories:          categories,
                categoryWeights:     categoryWeights,
                reputationExposure:  weightSum > 0 ? weightSum : 0,
                weightedLevel:       weightSum > 0 ? weightedStrength / weightSum : null,
                weakestCategories:   weakest.slice(0, 3),
                scrapedAt:           profile.scrapedAt || null
            }
        }
        return out
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

    /**
     * Slice 8 — load the staffOverview snapshot to expose pay-tier inputs
     * to the crew-tuner. Backwards-compatible with the existing crew shape:
     * callers that already read crew.bySkillLabel keep working; new readers
     * use crew.byPosition (keyed by AS positionId, the pay-tier applier's
     * unit). Returns null when the staffOverview store is empty so the
     * tuner can short-circuit gracefully (§4.8).
     */
    async function _loadStaffOverview() {
        if (!_has("CrewMgmtStaffOverviewScraper")) return null
        try {
            const key = window.CrewMgmtStaffOverviewScraper.STORAGE_KEY_LATEST
            if (!key) return null
            const out = await chrome.storage.local.get([key])
            const rec = out[key]
            if (!rec || !Array.isArray(rec.sections)) return null
            const byPosition = {}
            for (const section of rec.sections) {
                if (!section || !Array.isArray(section.roles)) continue
                for (const role of section.roles) {
                    if (!role || !role.positionId) continue
                    byPosition[role.positionId] = {
                        positionId:                 role.positionId,
                        label:                     role.label                     || null,
                        group:                     section.group                  || null,
                        employed:                  role.employed                  != null ? role.employed                  : null,
                        active:                    role.active                    != null ? role.active                    : null,
                        required:                  role.required                  != null ? role.required                  : null,
                        redundant:                 role.redundant                 != null ? role.redundant                 : null,
                        salaryPerEmployee:         role.salaryPerEmployee         != null ? role.salaryPerEmployee         : null,
                        nextWeekSalaryPerEmployee: role.nextWeekSalaryPerEmployee != null ? role.nextWeekSalaryPerEmployee : null,
                        countryAverage:            role.countryAverage            != null ? role.countryAverage            : null,
                        payTierPctVsCountry:       role.payTierPctVsCountry       != null ? role.payTierPctVsCountry       : null,
                        nextPayTierPctVsCountry:   role.nextPayTierPctVsCountry   != null ? role.nextPayTierPctVsCountry   : null,
                        pendingChange:             !!role.pendingChange,
                        moodDigit:                 role.moodDigit                 != null ? role.moodDigit                 : null,
                        moodTrend:                 role.moodTrend                 != null ? role.moodTrend                 : null
                    }
                }
            }
            return {
                byPosition,
                pressure:    _deriveCrewPressure(byPosition),
                formContext: rec.formContext || null,
                scrapedAt:   rec.scrapedAt || null,
                weekId:      rec.weekId    || null
            }
        } catch (_) { return null }
    }

    /**
     * Phase B1 — derive a per-snapshot crew-pressure block from byPosition.
     * Pure function; consumed by price-moves / service-moves to dampen
     * aggressive moves when staff are critically short. Severity scales
     * linearly to 1.0 at 50% shortfall (matches the same heuristic used by
     * `signal:strategy:crew-pressure` in content-staff-overview.js so panel
     * reasons line up with what subscribers see on the bus).
     *
     * Returns null when no role has a meaningful shortfall — proposers
     * short-circuit to "no gating" without a defensive null check.
     */
    function _deriveCrewPressure(byPosition) {
        if (!byPosition || typeof byPosition !== "object") return null
        let worst = 0
        const shortPositions = []
        const perPosition = {}
        for (const positionId of Object.keys(byPosition)) {
            const role = byPosition[positionId]
            const required = Number(role && role.required)
            const employed = Number(role && role.employed)
            if (!Number.isFinite(required) || required <= 0) continue
            if (!Number.isFinite(employed)) continue
            if (employed >= required) continue
            const shortfallPct = (required - employed) / required
            if (shortfallPct > worst) worst = shortfallPct
            const sev = Math.min(1, shortfallPct / 0.5)
            perPosition[positionId] = {shortfallPct, severity: sev, label: role.label || null}
            shortPositions.push(positionId)
        }
        if (worst <= 0) return null
        return {
            severity:           Math.min(1, worst / 0.5),
            worstShortfallPct:  worst,
            shortPositions,
            byPosition:         perPosition
        }
    }

    async function _loadLedger(server, airlineCode) {
        if (!_has("AccountingAggregator") || !server || !airlineCode) return null
        try { return await window.AccountingAggregator.loadUnifiedLedger(server, airlineCode) }
        catch (e) {
            console.warn("[AesStrategy] ledger load failed", e)
            return null
        }
    }

    // ── Live/in-flight controls ────────────────────────────────────────

    function _aircraftFlightsRecordMatches(key, rec, server, airlineCode) {
        if (!rec || rec.type !== "aircraftFlights" || !Array.isArray(rec.flights)) return false
        if (server && rec.server && String(rec.server) !== String(server)) return false
        if (server && String(key || "").indexOf(String(server)) !== 0) return false
        if (String(key || "").indexOf("aircraftFlights") < 0) return false
        // Newer records are airline-scoped. Legacy records do not carry
        // `airline`; keep them readable, but never mix a known other sister
        // airline into this snapshot.
        if (airlineCode && rec.airline && String(rec.airline) !== String(airlineCode)) return false
        return true
    }

    function _flightInfoFor(all, server, airlineCode, flightId) {
        if (flightId == null) return null
        const keys = []
        if (server && airlineCode) keys.push(String(server) + String(airlineCode) + "flightInfo" + flightId)
        if (server) keys.push(String(server) + "flightInfo" + flightId)
        for (const k of keys) {
            if (all[k]) return all[k]
        }
        return null
    }

    async function _loadActiveFlightsByRoute(server, airlineCode) {
        const map = new Map()
        if (!server || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            return map
        }
        let all = {}
        try { all = await chrome.storage.local.get(null) || {} }
        catch (_) { return map }
        const seenFlights = new Set()
        for (const key of Object.keys(all)) {
            const rec = all[key]
            if (!_aircraftFlightsRecordMatches(key, rec, server, airlineCode)) continue
            for (const f of rec.flights || []) {
                if (!f) continue
                const status = String(f.status || "").toLowerCase()
                if (status !== "inflight") continue
                const hub = String(f.originIata || "").toUpperCase()
                const dest = String(f.destinationIata || "").toUpperCase()
                if (!hub || !dest) continue
                const dedup = f.flightId != null
                    ? "id:" + String(f.flightId)
                    : "row:" + [f.flightNumber || "", f.flightNumberId || "",
                                f.depUtc || "", hub, dest].join("|")
                if (seenFlights.has(dedup)) continue
                seenFlights.add(dedup)

                const info = _flightInfoFor(all, server, rec.airline || airlineCode, f.flightId)
                    || _flightInfoFor(all, server, airlineCode, f.flightId)
                const cm5 = info && info.money && info.money.CM5 ? Number(info.money.CM5.Total) : NaN
                const actualPair = _routeKey(hub, dest)
                const routePairs = [actualPair]
                const reversePair = _routeKey(dest, hub)
                if (reversePair !== actualPair) routePairs.push(reversePair)
                for (const pair of routePairs) {
                    let slot = map.get(pair)
                    if (!slot) {
                        slot = {
                            inflight: 0,
                            cm5Total: 0,
                            cm5Count: 0,
                            missingFinancials: 0,
                            tailRegs: new Set(),
                            flightNumbers: new Set(),
                            flightIds: new Set(),
                            fnIds: new Set(),
                            aircraftIds: new Set(),
                            sourcePairs: new Set(),
                            newestDepUtc: null
                        }
                        map.set(pair, slot)
                    }
                    slot.inflight++
                    slot.sourcePairs.add(actualPair)
                    if (rec.registration) slot.tailRegs.add(String(rec.registration))
                    if (rec.aircraftId) slot.aircraftIds.add(String(rec.aircraftId))
                    if (f.flightNumber) slot.flightNumbers.add(String(f.flightNumber))
                    if (f.flightId != null) slot.flightIds.add(String(f.flightId))
                    if (f.flightNumberId != null) slot.fnIds.add(String(f.flightNumberId))
                    if (f.depUtc && (!slot.newestDepUtc || String(f.depUtc) > String(slot.newestDepUtc))) {
                        slot.newestDepUtc = f.depUtc
                    }
                    if (isFinite(cm5)) {
                        slot.cm5Total += cm5
                        slot.cm5Count++
                    } else {
                        slot.missingFinancials++
                    }
                }
            }
        }
        for (const [pair, slot] of map) {
            map.set(pair, {
                inflight:          slot.inflight,
                avgCm5:            slot.cm5Count ? slot.cm5Total / slot.cm5Count : null,
                cm5Total:          slot.cm5Count ? slot.cm5Total : null,
                cm5Count:          slot.cm5Count,
                missingFinancials: slot.missingFinancials,
                tailRegs:          Array.from(slot.tailRegs).slice(0, 8),
                flightNumbers:     Array.from(slot.flightNumbers).slice(0, 12),
                flightIds:         Array.from(slot.flightIds).slice(0, 12),
                fnIds:             Array.from(slot.fnIds).slice(0, 12),
                aircraftIds:       Array.from(slot.aircraftIds).slice(0, 8),
                sourcePairs:        Array.from(slot.sourcePairs).slice(0, 12),
                newestDepUtc:      slot.newestDepUtc
            })
        }
        return map
    }

    function _attachActiveFlightControls(hubs, activeByRoute) {
        if (!activeByRoute || typeof activeByRoute.get !== "function") return
        for (const h of hubs || []) {
            for (const r of (h && h.byRoute) || []) {
                if (!r || !r.dest) continue
                const rec = activeByRoute.get(_routeKey(h.iata, r.dest))
                if (rec && rec.inflight > 0) r.activeFlightControls = rec
            }
        }
    }

    /**
     * Slice 12 — load alliance roster + our contractual partners so the
     * alliance proposer (`AesStrategy.proposeAllianceMoves`) can read
     * everything from the snapshot without reaching back into stores.
     *
     * Output shape:
     *   {membership: {name, members[], scrapedAt} | null,
     *    partners:   [{partnerId, partnerName, partnerIata, relations[]}],
     *    partnerIds: Set<string>,             // we already have *some* relation
     *    allianceMemberIds: Set<string>,      // every alliance peer's id
     *    ourEnterpriseId: string | null}
     *
     * Best-effort: any store read failure leaves the corresponding field
     * empty/null and adds a "alliance.*" diagnostic to snapshot.missing.
     */
    async function _loadAllianceContext(server, airlineIdentity) {
        const out = {
            membership:        null,
            partners:          [],
            partnerIds:        new Set(),
            allianceMemberIds: new Set(),
            ourEnterpriseId:   null
        }
        const ourId = airlineIdentity && (airlineIdentity.enterpriseId
            || airlineIdentity.id || airlineIdentity.airlineId)
        if (ourId != null) out.ourEnterpriseId = String(ourId)

        if (_has("AllianceOverviewScraper")) {
            try {
                const rec = await window.AllianceOverviewScraper.loadRecord()
                if (rec && (rec.allianceName || (rec.members && rec.members.length))) {
                    out.membership = {
                        name:      rec.allianceName || null,
                        members:   Array.isArray(rec.members) ? rec.members : [],
                        scrapedAt: rec.scrapedAt || null
                    }
                    for (const m of out.membership.members) {
                        const id = m && (m.enterpriseId || m.id)
                        if (id != null) out.allianceMemberIds.add(String(id))
                    }
                }
            } catch (_) {}
        }

        if (out.ourEnterpriseId && _has("RouteAssistantContractualPartnersScraper")) {
            try {
                const rec = await window.RouteAssistantContractualPartnersScraper.loadRecord(
                    server, out.ourEnterpriseId)
                if (rec && Array.isArray(rec.partners)) {
                    out.partners = rec.partners.map(p => ({
                        partnerId:    p && p.partnerId    != null ? String(p.partnerId) : null,
                        partnerName:  p && p.partnerName  || null,
                        partnerIata:  p && p.partnerIata  || null,
                        relations:    Array.isArray(p && p.relations) ? p.relations.slice() : []
                    })).filter(p => p.partnerId)
                    for (const p of out.partners) out.partnerIds.add(p.partnerId)
                }
            } catch (_) {}
        }

        // Slice 12 — pre-compute partnerOnwardByDest for the connectivity
        // term in scoreRoutes(). Walks the union of contractual-partner IDs
        // and alliance-member IDs against the competitor-intel cache; for
        // each cached partner record, every hub IATA contributes the
        // partner to that dest's set. One batched chrome.storage.local.get;
        // missing partners contribute zero (the term degrades gracefully).
        out.partnerOnwardByDest = new Map()
        const partnerLookupIds = new Set()
        for (const id of out.partnerIds)        partnerLookupIds.add(id)
        for (const id of out.allianceMemberIds) partnerLookupIds.add(id)
        if (out.ourEnterpriseId) partnerLookupIds.delete(out.ourEnterpriseId)
        if (server && partnerLookupIds.size
                && typeof chrome !== "undefined"
                && chrome.storage && chrome.storage.local) {
            const keys = []
            for (const id of partnerLookupIds) {
                keys.push("competitorIntel:enterprise:" + server + ":" + id)
            }
            try {
                const all = await chrome.storage.local.get(keys)
                for (const id of partnerLookupIds) {
                    const rec = all["competitorIntel:enterprise:" + server + ":" + id]
                    if (!rec || !Array.isArray(rec.hubs)) continue
                    for (const hub of rec.hubs) {
                        const raw = hub && (hub.iata || hub)
                        if (typeof raw !== "string") continue
                        const upper = raw.toUpperCase().trim()
                        if (!upper) continue
                        if (!out.partnerOnwardByDest.has(upper)) {
                            out.partnerOnwardByDest.set(upper, new Set())
                        }
                        out.partnerOnwardByDest.get(upper).add(id)
                    }
                }
            } catch (_) { /* best-effort; empty map signals "no footprint cache" */ }
        }

        return out
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
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function"
                && Number.isFinite(out.runwayWeeks) && out.runwayWeeks < 8) {
            window.AesDataBus.emit("signal:strategy:cash-low", {
                runwayWeeks:  out.runwayWeeks,
                bankBalance:  out.bankBalance,
                weeklyResult: out.weeklyResult
            })
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

    async function _loadStrategySettings() {
        if (!_has("AesStrategySettings")) return null
        try { return await window.AesStrategySettings.load() }
        catch (_) { return null }
    }

    async function _loadRouteObjectives(hubs, accountId) {
        if (!_has("AesStrategyRouteObjectiveStore")) return new Map()
        const pairs = []
        for (const h of hubs || []) {
            for (const r of (h && h.byRoute) || []) {
                if (r && r.dest) pairs.push([h.iata, r.dest])
            }
        }
        if (!pairs.length) return new Map()
        try { return await window.AesStrategyRouteObjectiveStore.getMany(pairs, accountId) }
        catch (_) { return new Map() }
    }

    /**
     * Resolve the per-account scoping ID for this snapshot. Strategy
     * stores (route objectives, applied envelope, audit, outcomes,
     * learn) are all keyed under <prefix>:acct:<accountId>:* so two
     * sisters in the same world don't stomp each other's records.
     * Caller can pass `accountId` explicitly; otherwise we ask the
     * AesAccountRegistry. Null/throw → unscoped storage (legacy).
     */
    async function _resolveAccountId(server, airlineCode, explicit) {
        if (explicit) return explicit
        if (!server || !airlineCode) return null
        if (!_has("AesAccountRegistry")) return null
        try { return await window.AesAccountRegistry.computeId(server, airlineCode) }
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
        if (!_has("AesCompanyReputationStore")) missing.push("AesCompanyReputationStore")
        if (!_has("CrewMgmtStaffPilotsScraper"))    missing.push("CrewMgmtStaffPilotsScraper")
        if (!_has("RouteAssistantSettings"))        missing.push("RouteAssistantSettings")
        if (!_has("RouteAssistantOrsSnapshotStore"))     missing.push("RouteAssistantOrsSnapshotStore")
        if (!_has("RouteAssistantSandboxScenariosStore")) missing.push("RouteAssistantSandboxScenariosStore")

        const [
            ledger,
            serviceProfiles,
            companyReputation,
            crewBySkill,
            staffOverview,
            settings,
            strategySettings,
            alliance
        ] = await Promise.all([
            _loadLedger(server, airlineCode),
            _safe(_loadServiceProfiles(),  null),
            _safe(_loadCompanyReputation(), null),
            _safe(_loadCrew(),             null),
            _safe(_loadStaffOverview(),    null),
            _safe(_loadSettings(),         null),
            _safe(_loadStrategySettings(), null),
            _safe(_loadAllianceContext(server, airlineCode), null)
        ])
        if (!_has("AllianceOverviewScraper")) missing.push("AllianceOverviewScraper")
        if (!_has("RouteAssistantContractualPartnersScraper")) missing.push("RouteAssistantContractualPartnersScraper")
        if (!alliance || !alliance.membership) missing.push("alliance.membership")
        if (!alliance || !alliance.partners.length) missing.push("alliance.partners")
        // Slice 12 — only flag the partner-footprint cache missing when we
        // *expect* footprints (≥1 partner or alliance peer known) but the
        // pre-compute couldn't find any cached record. A no-alliance airline
        // doesn't get a spurious diagnostic.
        if (alliance
                && (alliance.partners.length > 0 || alliance.allianceMemberIds.size > 0)
                && (!alliance.partnerOnwardByDest || alliance.partnerOnwardByDest.size === 0)) {
            missing.push("alliance.partnerOnwardByDest")
        }

        // Slice 8 — merge the per-skill (pilots) view with the per-position
        // (staffOverview) view into one `crew` envelope. crew.byPosition +
        // crew.formContext are the new readers; crew.bySkillLabel stays
        // exactly as Slice 3 wrote it. crew is null only when both stores
        // are empty so the existing _has() / missing.push() invariants stay
        // truthful.
        let crew = null
        if (crewBySkill || staffOverview) {
            crew = Object.assign({},
                crewBySkill || {},
                staffOverview ? {
                    byPosition:  staffOverview.byPosition,
                    pressure:    staffOverview.pressure,
                    formContext: staffOverview.formContext,
                    staffOverviewScrapedAt: staffOverview.scrapedAt,
                    staffOverviewWeekId:    staffOverview.weekId
                } : {})
        }
        if (!_has("CrewMgmtStaffOverviewScraper")) missing.push("CrewMgmtStaffOverviewScraper")
        if (!staffOverview) missing.push("crew.byPosition")
        if (!companyReputation || !companyReputation.ratingLabel) missing.push("companyReputation.rating")

        const crewRoleProfiles = _deriveCrewRoleProfiles(crew, strategySettings)
        const serviceCategoryProfiles = _deriveServiceCategoryProfiles(serviceProfiles, strategySettings)

        const fleet = await _enrichFleet(server, fleetRaw, typesByTypeId, ledger)
        const hubs  = _buildHubs(ledger)

        await Promise.all([
            _attachDistance(hubs),
            _attachDemand(hubs, o.includeStaleDemand ? {includeStale: true} : undefined),
            _attachOverrides(hubs),
            _attachWatchlist(hubs),
            _attachCompetitorIntel(hubs),
            _attachOrsCache(hubs),
            _attachOwnPricing(hubs),
            _attachCalibrationCorpus(hubs)
        ])
        _attachActiveFlightControls(hubs, await _loadActiveFlightsByRoute(server, airlineCode))
        _attachRouteSpec(hubs, fleet)
        _attachCacheAges(hubs, Date.now())

        const cash    = _summarizeCash(ledger)
        const sisters = ledger ? (ledger.sisters || null) : null

        const accountId       = await _resolveAccountId(server, airlineCode, o.accountId)
        const routeObjectives = await _loadRouteObjectives(hubs, accountId)
        if (!_has("AesStrategySettings"))           missing.push("AesStrategySettings")
        if (!_has("AesStrategyRouteObjectiveStore")) missing.push("AesStrategyRouteObjectiveStore")

        return {
            ts:               Date.now(),
            server:           server,
            airlineCode:      airlineCode,
            accountId:        accountId,
            fleet:            fleet,
            hubs:             hubs,
            companyReputation: companyReputation,
            serviceProfiles:  serviceProfiles,
            serviceCategoryProfiles: serviceCategoryProfiles,
            crew:             crew,
            crewRoleProfiles: crewRoleProfiles,
            cash:             cash,
            sisters:          sisters,
            rivals:           [],   // populated in Slice 5 (cross-airline / enterprise scraper)
            alliance:         alliance,
            settings:         _trimSettings(settings),
            strategySettings: strategySettings,
            routeObjectives:  routeObjectives,
            missing:          missing
        }
    }

    window.AesStrategy = {snapshot}
})()
