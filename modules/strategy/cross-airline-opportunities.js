"use strict"

/**
 * AES Strategy — cross-airline allocator hint (slice 1).
 *
 * Pure read facade. Given the user's known sister airlines on a server,
 * surface (idle aircraft of sister A) ↔ (high-demand-but-undersupplied
 * route at sister B's hub) matches.
 *
 * Two entry points:
 *   scanForServer(server, opts) → Match[]
 *       Used by the central-hub strategy tile to render the
 *       "Cross-airline opportunities" card. Considers all sister
 *       combinations and returns top-N by score.
 *
 *   findForRoute(server, originIata, destIata, opts) → SisterAircraft[]
 *       Used by the Flight Studio sidebar. The shortage side is
 *       hard-pinned to the caller's leg; result is the idle aircraft
 *       across other sisters that could fly it.
 *
 * Both gate on `settings.strategy.crossAirlineEnabled` (default false)
 * and degrade silently when the portfolio scanner / demand store /
 * fleet roster aren't loaded — no throws to caller.
 *
 * NO SCRAPING, NO POSTING. Reads:
 *   AesStrategyPortfolio.scanServer       (sister enumeration + routeLegs)
 *   AesFleetRoster.load                   (per-airline aircraft + wear)
 *   RouteAssistantDemandStore.getMany     (paxScore by IATA)
 *   RouteAssistantDistanceResolver.bulkLoadCache (best-effort distance)
 *   AesStrategySettings.load              (feature flag)
 *
 * Scoring (mirrors allocate-fleet.js's tuple intent so suggestions feel
 * consistent with the in-airline allocator):
 *
 *   seatFit         = clamp(seats / max(50, paxScore * 50), 0.5, 1.5)
 *   headroomFrac    = clamp(headroom / capWeeklyHours, 0, 1)
 *   demandWeight    = paxScore / 10
 *   locationDiscount= aircraft at hub ? 1.0 : 0.6
 *   score           = seatFit * headroomFrac * demandWeight * locationDiscount
 *
 * Slice 1 simplifications:
 *   - Shortage heuristic = paxScore >= 7 AND ownLegs(hub→dest) < paxScore.
 *     Cheaper than re-running aggregator's UNDER classifier across sisters
 *     and good enough for an opt-in hint surface.
 *   - Distances are best-effort: only cached pairs from
 *     RouteAssistantDistanceResolver are used; we never trigger fetches.
 *     Pairs with no cached distance pass through with distanceKm=null.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCrossAirlineOpps) return

    const MIN_SPARE_HOURS         = 15
    const MIN_DEMAND_SCORE        = 7
    const SEAT_FIT_LO             = 0.5
    const SEAT_FIT_HI             = 1.5
    const LOCATION_DISCOUNT_FERRY = 0.6
    const MIN_MATCH_SCORE         = 0.05
    const STALE_MS                = 7 * 86400000
    const DIST_MAX_AGE_DAYS       = 90
    const DEFAULT_TOP_N_SCAN      = 8
    const DEFAULT_TOP_N_ROUTE     = 5

    function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

    function _seatFit(seats, paxScore) {
        const s = Number(seats) > 0 ? Number(seats) : 150
        const demand = Math.max(50, (Number(paxScore) || 5) * 50)
        return _clamp(s / demand, SEAT_FIT_LO, SEAT_FIT_HI)
    }

    function _normIdentity(x) {
        return String(x || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase()
    }

    function _isSameAirline(rec, identity) {
        if (!rec || !identity) return false
        const i = _normIdentity(identity)
        if (!i) return false
        return _normIdentity(rec.airline) === i || _normIdentity(rec.displayName) === i
    }

    /** Best-effort fleet load — same fallback the portfolio scanner uses. */
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

    async function _featureEnabled() {
        if (!window.AesStrategySettings) return false
        try {
            const s = await window.AesStrategySettings.load()
            return !!(s && s.crossAirlineEnabled)
        } catch (_) { return false }
    }

    function _pairKey(a, b) {
        const x = String(a || "").toUpperCase()
        const y = String(b || "").toUpperCase()
        return x < y ? x + "-" + y : y + "-" + x
    }

    /** Bulk-cache lookup wrapper. Returns Map<pairKey, distanceKm>. */
    async function _loadDistanceCache(pairs) {
        if (!pairs || !pairs.length) return new Map()
        if (typeof RouteAssistantDistanceResolver === "undefined") return new Map()
        try {
            const raw = await RouteAssistantDistanceResolver.bulkLoadCache(
                pairs, {maxAgeDays: DIST_MAX_AGE_DAYS})
            const out = new Map()
            for (const [k, rec] of raw.entries()) {
                if (rec && Number(rec.distanceKm) > 0) out.set(k, Number(rec.distanceKm))
            }
            return out
        } catch (_) { return new Map() }
    }

    function _gatherIdleAircraft(sisters) {
        const pool = []
        for (const s of sisters) {
            for (const ac of (s.aircraft || [])) {
                if (!ac) continue
                const wear = ac.wear || {}
                const cap = Number(wear.maxWeeklyBlockHours) || 0
                const used = Number(wear.weeklyHoursLast7d) || 0
                const headroom = cap - used
                if (cap <= 0 || headroom < MIN_SPARE_HOURS) continue
                pool.push({
                    airlineRec:     s,
                    aircraft:       ac,
                    headroom:       headroom,
                    capWeeklyHours: cap,
                    baseIata:       ac.currentLocationIata || null
                })
            }
        }
        return pool
    }

    async function _expandSisters(server, portfolio) {
        const out = []
        for (const a of (portfolio.airlines || [])) {
            const fleet = await _loadFleet(server, a.airline)
            out.push(Object.assign({}, a, {aircraft: (fleet && fleet.aircraft) || []}))
        }
        return out
    }

    function _isStale(ts) {
        return !!(ts && Date.now() - ts > STALE_MS)
    }

    // ── scanForServer ────────────────────────────────────────────────────

    async function scanForServer(server, opts) {
        opts = opts || {}
        if (!server) return []
        if (!(await _featureEnabled())) return []
        if (!window.AesStrategyPortfolio) return []
        if (!window.RouteAssistantDemandStore) return []

        let portfolio = null
        try { portfolio = await window.AesStrategyPortfolio.scanServer(server) }
        catch (e) { console.warn("[AES crossAirline] portfolio scan failed", e); return [] }
        if (!portfolio || !Array.isArray(portfolio.airlines) || portfolio.airlines.length < 2) return []

        const sisters = await _expandSisters(server, portfolio)
        const idlePool = _gatherIdleAircraft(sisters)
        if (!idlePool.length) return []

        // Candidate destinations = union of every sister's known route
        // destinations + every sister's hub (sisters might want to fly to
        // each other's hubs). Capped implicitly by storage realism.
        const destSet = new Set()
        for (const s of sisters) {
            for (const h of (s.hubs || [])) destSet.add(String(h).toUpperCase())
            for (const r of (s.routes || [])) {
                const idx = String(r).indexOf("-")
                if (idx > 0) destSet.add(String(r).substring(idx + 1).toUpperCase())
            }
        }
        if (!destSet.size) return []

        let demandMap = new Map()
        try { demandMap = await window.RouteAssistantDemandStore.getMany(Array.from(destSet)) }
        catch (e) { console.warn("[AES crossAirline] demand getMany failed", e) }

        // Build the pair list we'll query distance for: (hub, dest) for
        // every sister hub × candidate dest, plus (idleBase, hub) for ferry.
        const pairSet = new Set()
        const queueDistance = (a, b) => {
            if (!a || !b || a === b) return
            pairSet.add(_pairKey(a, b))
        }
        for (const s of sisters) {
            for (const hub of (s.hubs || [])) {
                for (const dest of destSet) queueDistance(hub, dest)
            }
        }
        for (const idle of idlePool) {
            if (!idle.baseIata) continue
            for (const s of sisters) {
                for (const hub of (s.hubs || [])) queueDistance(idle.baseIata, hub)
            }
        }
        const distMap = await _loadDistanceCache(
            Array.from(pairSet).map(k => k.split("-")))

        const matches = []

        for (const s of sisters) {
            for (const hub of (s.hubs || [])) {
                const HUB = String(hub).toUpperCase()
                for (const dest of destSet) {
                    if (dest === HUB) continue
                    const demand = demandMap.get(dest)
                    if (!demand || !Number.isFinite(demand.paxScore)) continue
                    if (demand.paxScore < MIN_DEMAND_SCORE) continue

                    const ownLegs = (s.routeLegs && Number(s.routeLegs[HUB + "-" + dest])) || 0
                    if (ownLegs >= demand.paxScore) continue   // not "short"

                    const distanceKm = distMap.get(_pairKey(HUB, dest)) || null

                    for (const idle of idlePool) {
                        if (idle.airlineRec === s) continue
                        if (idle.airlineRec.airline === s.airline) continue

                        const range = Number(idle.aircraft.rangeKm) || 0
                        if (distanceKm != null && range > 0 && distanceKm > range * 1.05) continue

                        const seatFit = _seatFit(idle.aircraft.seats, demand.paxScore)
                        const headroomFrac = idle.capWeeklyHours > 0
                            ? Math.min(1, idle.headroom / idle.capWeeklyHours) : 0
                        const demandWeight = demand.paxScore / 10
                        const locationDiscount = idle.baseIata === HUB ? 1.0 : LOCATION_DISCOUNT_FERRY
                        const score = seatFit * headroomFrac * demandWeight * locationDiscount
                        if (score < MIN_MATCH_SCORE) continue

                        let ferryKm = 0
                        if (idle.baseIata && idle.baseIata !== HUB) {
                            ferryKm = distMap.get(_pairKey(idle.baseIata, HUB)) || 0
                        }

                        const stale = []
                        if (_isStale(idle.airlineRec.lastScrape)) stale.push(idle.airlineRec.displayName || idle.airlineRec.airline)
                        if (_isStale(s.lastScrape))               stale.push(s.displayName || s.airline)

                        matches.push({
                            idleAirline: {
                                accountId:   idle.airlineRec.accountId,
                                airline:     idle.airlineRec.airline,
                                displayName: idle.airlineRec.displayName
                            },
                            idleAircraft: {
                                aircraftId:     idle.aircraft.aircraftId,
                                registration:   idle.aircraft.registration,
                                equipment:      idle.aircraft.equipment,
                                seats:          Number(idle.aircraft.seats) || 0,
                                rangeKm:        range,
                                baseIata:       idle.baseIata,
                                headroomHours:  idle.headroom,
                                capWeeklyHours: idle.capWeeklyHours
                            },
                            shortAirline: {
                                accountId:   s.accountId,
                                airline:     s.airline,
                                displayName: s.displayName
                            },
                            hub:          HUB,
                            dest:         dest,
                            paxScore:     demand.paxScore,
                            ownLegs:      ownLegs,
                            distanceKm:   distanceKm,
                            ferryKm:      ferryKm,
                            score:        score,
                            staleAirlines: Array.from(new Set(stale))
                        })
                    }
                }
            }
        }

        matches.sort((a, b) => b.score - a.score)
        const topN = Number(opts.topN) > 0 ? Number(opts.topN) : DEFAULT_TOP_N_SCAN
        return matches.slice(0, topN)
    }

    // ── findForRoute ─────────────────────────────────────────────────────

    async function findForRoute(server, originIata, destIata, opts) {
        opts = opts || {}
        if (!server || !originIata || !destIata) return []
        if (!(await _featureEnabled())) return []
        if (!window.AesStrategyPortfolio) return []

        let portfolio = null
        try { portfolio = await window.AesStrategyPortfolio.scanServer(server) }
        catch (e) { console.warn("[AES crossAirline] portfolio scan failed", e); return [] }
        if (!portfolio || !Array.isArray(portfolio.airlines) || portfolio.airlines.length < 2) return []

        const ORIG = String(originIata).toUpperCase()
        const DEST = String(destIata).toUpperCase()

        const curAirline = opts.currentAirline
            || ((typeof AES !== "undefined" && AES.getAirlineIdentity)
                ? AES.getAirlineIdentity() : null)

        const sisters = await _expandSisters(server, portfolio)
        const otherSisters = sisters.filter(s => !_isSameAirline(s, curAirline))
        if (!otherSisters.length) return []

        // Resolve paxScore (caller may pass it; else demand store)
        let paxScore = Number.isFinite(Number(opts.paxScore)) ? Number(opts.paxScore) : null
        if (paxScore == null && window.RouteAssistantDemandStore) {
            try {
                const rec = await window.RouteAssistantDemandStore.get(DEST)
                if (rec && Number.isFinite(Number(rec.paxScore))) paxScore = Number(rec.paxScore)
            } catch (_) {}
        }
        if (paxScore == null) paxScore = 5  // neutral fallback

        // Gather pairs we need distances for: leg + each idle aircraft's
        // base→origin (ferry).
        const pairSet = new Set()
        pairSet.add(_pairKey(ORIG, DEST))
        const baseSeen = new Set()
        for (const s of otherSisters) {
            for (const ac of (s.aircraft || [])) {
                const base = ac && ac.currentLocationIata
                if (base && base !== ORIG && !baseSeen.has(base)) {
                    baseSeen.add(base)
                    pairSet.add(_pairKey(base, ORIG))
                }
            }
        }
        const distMap = await _loadDistanceCache(
            Array.from(pairSet).map(k => k.split("-")))

        let resolvedDistanceKm = Number(opts.distanceKm) > 0 ? Number(opts.distanceKm)
            : (distMap.get(_pairKey(ORIG, DEST)) || null)

        const out = []

        for (const s of otherSisters) {
            for (const ac of (s.aircraft || [])) {
                if (!ac) continue
                const wear = ac.wear || {}
                const cap = Number(wear.maxWeeklyBlockHours) || 0
                const used = Number(wear.weeklyHoursLast7d) || 0
                const headroom = cap - used
                if (cap <= 0 || headroom < MIN_SPARE_HOURS) continue

                const range = Number(ac.rangeKm) || 0
                if (resolvedDistanceKm != null && range > 0
                    && resolvedDistanceKm > range * 1.05) continue

                const baseIata = ac.currentLocationIata || null
                const seatFit = _seatFit(ac.seats, paxScore)
                const headroomFrac = cap > 0 ? Math.min(1, headroom / cap) : 0
                const demandWeight = paxScore / 10
                const locationDiscount = baseIata === ORIG ? 1.0 : LOCATION_DISCOUNT_FERRY
                const score = seatFit * headroomFrac * demandWeight * locationDiscount
                if (score < MIN_MATCH_SCORE) continue

                let ferryKm = 0
                if (baseIata && baseIata !== ORIG) {
                    ferryKm = distMap.get(_pairKey(baseIata, ORIG)) || 0
                }

                out.push({
                    idleAirline: {
                        accountId:   s.accountId,
                        airline:     s.airline,
                        displayName: s.displayName
                    },
                    idleAircraft: {
                        aircraftId:     ac.aircraftId,
                        registration:   ac.registration,
                        equipment:      ac.equipment,
                        seats:          Number(ac.seats) || 0,
                        rangeKm:        range,
                        baseIata:       baseIata,
                        headroomHours:  headroom,
                        capWeeklyHours: cap
                    },
                    seatFit:       seatFit,
                    headroomHours: headroom,
                    ferryKm:       ferryKm,
                    score:         score,
                    staleAirline:  _isStale(s.lastScrape)
                })
            }
        }

        out.sort((a, b) => b.score - a.score)
        const topN = Number(opts.topN) > 0 ? Number(opts.topN) : DEFAULT_TOP_N_ROUTE
        return out.slice(0, topN)
    }

    window.AesCrossAirlineOpps = {scanForServer, findForRoute}

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const sf1 = _seatFit(180, 9)         // 180 / 450 = 0.4 → clamped to 0.5
            console.assert(Math.abs(sf1 - 0.5) < 1e-9, "[smoke] seatFit clamps low")
            const sf2 = _seatFit(180, 4)         // 180 / 200 = 0.9
            console.assert(Math.abs(sf2 - 0.9) < 1e-9, "[smoke] seatFit mid range")
            const sf3 = _seatFit(450, 5)         // 450 / 250 = 1.8 → clamped to 1.5
            console.assert(Math.abs(sf3 - 1.5) < 1e-9, "[smoke] seatFit clamps high")
            console.assert(_pairKey("LHR", "FRA") === "FRA-LHR", "[smoke] pair key sorted")
            console.assert(_pairKey("FRA", "LHR") === "FRA-LHR", "[smoke] pair key reverse same")
            console.assert(_isSameAirline({airline: "BA", displayName: "British"}, "ba"),
                "[smoke] same-airline by code")
            console.assert(_isSameAirline({airline: "Lufthansa", displayName: "Lufthansa"}, "luft hansa"),
                "[smoke] same-airline alphanum-strip + lowercase")
            console.assert(!_isSameAirline({airline: "BA"}, "LH"),
                "[smoke] different airlines distinguished")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
