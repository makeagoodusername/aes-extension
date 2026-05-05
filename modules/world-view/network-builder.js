"use strict"

/**
 * WorldViewNetworkBuilder — pure function: snapshot + alliance + hub →
 * WorldViewNetwork.
 *
 * No I/O. Caller passes already-loaded inputs:
 *   snapshot     — from window.AesStrategy.snapshot()
 *   alliance     — from AllianceOverviewScraper.loadRecord() (nullable)
 *   partnerCache — Map<enterpriseId, [relationKind]>  (nullable; W3+)
 *   competitorCache — Map<enterpriseId, EnterpriseRecord>  (nullable; W3+)
 *   hub          — focused hub IATA (uppercase string)
 *
 * Returns the WorldViewNetwork shape documented in the plan, with W1
 * fields populated. carrierIndex.classifier is null in W1 (the caller
 * supplies a stub returning "own" until W3); banks is empty in W1
 * (synthesized in W2 wave-pane).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewNetworkBuilder) return

    function _norm(s) { return (s || "").toString().toUpperCase().trim() }

    function _normalize(x, lo, hi) {
        const ws = window.WorldViewStyles
        if (ws && ws.normalize) return ws.normalize(x, lo, hi)
        if (!isFinite(x)) return 0
        const range = hi - lo
        if (range <= 0) return 0
        const v = (x - lo) / range
        return v < 0 ? 0 : v > 1 ? 1 : v
    }

    function _clamp01(x) {
        if (!isFinite(x)) return 0
        if (x < 0) return 0
        if (x > 1) return 1
        return x
    }

    function _competitionScore(competitor, ourPaxShare) {
        if (!competitor || typeof competitor !== "object") {
            return {score: 0, components: {flights: 0, share: 0, seats: 0}}
        }
        const fc = Number(competitor.flightCount) || 0
        const sc = Number(competitor.seatCount)   || 0
        const s = _clamp01(Number(ourPaxShare))
        const flightsN = _normalize(fc, 0, 40)
        const seatsN   = _normalize(sc, 0, 6000)
        const sharePressure = 1 - s
        const score = 0.5 * flightsN + 0.3 * sharePressure + 0.2 * seatsN
        return {
            score: _clamp01(score),
            components: {flights: flightsN, share: sharePressure, seats: seatsN}
        }
    }

    function _sizeWeight(weeklyFlights, competitionScore, alreadyScheduled, watchlisted) {
        const base = Math.log1p(Math.max(1, Number(weeklyFlights) || 0))
        const compMult = 1 + 1.2 * competitionScore
        const schedMult = alreadyScheduled ? 1.0 : 0.6
        const watchMult = watchlisted ? 1.15 : 1.0
        return base * compMult * schedMult * watchMult
    }

    function _carrierClassFromPartners(dominantId, ownIds, partnerCache, alliancePresence) {
        if (dominantId == null) return "unknown"
        const id = String(dominantId)
        if (ownIds && ownIds.has(id)) return "own"
        if (partnerCache && partnerCache.get) {
            const rels = partnerCache.get(id) || []
            if (rels.includes("ALLIANCE") || rels.includes("alliance")) return "alliance"
            if (rels.includes("INTERLINING") || rels.includes("interline")) return "interline"
        }
        if (alliancePresence) return "alliance"
        return "unagreed"
    }

    function _allianceDestSet(alliance) {
        const set = new Set()
        if (!alliance || !Array.isArray(alliance.members)) return set
        for (const m of alliance.members) {
            const fp = (m && Array.isArray(m.routeFootprint)) ? m.routeFootprint : []
            for (const r of fp) {
                if (r && r.destIata) set.add(_norm(r.destIata))
            }
        }
        return set
    }

    function _allianceMemberIds(alliance) {
        const set = new Set()
        if (!alliance || !Array.isArray(alliance.members)) return set
        for (const m of alliance.members) {
            const candidates = [m && m.enterpriseId, m && m.id, m && m.code]
            for (const c of candidates) {
                if (c != null) set.add(String(c))
            }
        }
        return set
    }

    const WorldViewNetworkBuilder = {
        build(input) {
            const snapshot     = input && input.snapshot
            const alliance     = input && input.alliance
            const partnerCache = (input && input.partnerCache) || null
            const ownIds       = new Set(((input && input.ownEnterpriseIds) || []).map(String))
            const hub          = _norm(input && input.hub)

            const warnings = []
            const out = {
                ts: Date.now(),
                server: snapshot && snapshot.server || null,
                airlineCode: snapshot && snapshot.airlineCode || null,
                hub: hub,
                hubs: [],
                myAlliance: null,
                destinations: [],
                carrierIndex: {
                    ownEnterpriseIds: Array.from(ownIds),
                    partnerByEnterpriseId: partnerCache
                        ? Array.from(partnerCache.entries()).map(([id, rels]) => ({id, rels}))
                        : [],
                    leadByDest: [],
                    classifier: null
                },
                banks: [],
                metrics: {
                    routeCount: 0,
                    weeklyDepartures: 0,
                    topCompetitorShare: 0,
                    avgCompetitionScore: 0,
                    looseEndsCount: 0
                },
                sourceFreshness: {
                    snapshotTs: (snapshot && snapshot.ts) || null,
                    allianceTs: (alliance && alliance.scrapedAt) || null,
                    topRoutesTs: null
                },
                warnings: warnings
            }

            if (!snapshot || !Array.isArray(snapshot.hubs)) {
                warnings.push("snapshot-missing")
                return out
            }

            out.hubs = snapshot.hubs
                .map(h => _norm(h && h.iata))
                .filter(x => x)

            const hubRec = snapshot.hubs.find(h => _norm(h && h.iata) === hub)
            if (!hubRec) {
                warnings.push("hub-not-in-snapshot")
                return out
            }

            if (alliance && alliance.allianceName) {
                out.myAlliance = {
                    name: alliance.allianceName,
                    members: Array.isArray(alliance.members) ? alliance.members.slice() : [],
                    scrapedAt: alliance.scrapedAt || null
                }
            }
            const allianceDestSet = _allianceDestSet(alliance)

            const byRoute = Array.isArray(hubRec.byRoute) ? hubRec.byRoute : []
            let weeklyDepartures = 0
            let scoreSum = 0
            let scoreCount = 0
            let topCompShare = 0
            const leadByDest = []

            const destinations = byRoute.map(r => {
                const dest = _norm(r && r.dest)
                const wf = Number(r && r.weeklyFlights) || 0
                const ourShare = Number(r && r.ourPaxShare)
                const competitor = (r && r.competitor) || null
                const compRes = _competitionScore(competitor, ourShare)
                const score = compRes.score
                const alreadyScheduled = !!(r && r.alreadyScheduled)
                const watchlisted      = !!(r && r.watchlisted)
                const dominantId       = competitor && competitor.dominantEnterpriseId != null
                    ? String(competitor.dominantEnterpriseId)
                    : null
                const dominantCarrier  = competitor && competitor.dominantCarrier || null
                const alliancePresence = allianceDestSet.has(dest)
                const carrierClass = _carrierClassFromPartners(
                    dominantId, ownIds, partnerCache, alliancePresence
                )

                if (dominantId) leadByDest.push({dest, enterpriseId: dominantId})

                weeklyDepartures += wf
                if (compRes.score > 0) {
                    scoreSum += compRes.score
                    scoreCount += 1
                }
                if (competitor && isFinite(competitor.flightCount) && wf >= 0) {
                    const totalFlights = (Number(competitor.flightCount) || 0) + wf
                    if (totalFlights > 0) {
                        const compShare = (Number(competitor.flightCount) || 0) / totalFlights
                        if (compShare > topCompShare) topCompShare = compShare
                    }
                }

                return {
                    dest: dest,
                    destName: r && r.destName || null,
                    distanceKm: Number(r && r.distanceKm) || null,
                    weeklyFlights: wf,
                    paxScore: Number(r && r.paxScore) || null,
                    cargoScore: Number(r && r.cargoScore) || null,
                    ourPaxShare: isFinite(ourShare) ? ourShare : null,
                    competition: {
                        score: score,
                        flightCount: competitor && Number(competitor.flightCount) || null,
                        seatCount:   competitor && Number(competitor.seatCount)   || null,
                        dominantCarrier: dominantCarrier,
                        dominantEnterpriseId: dominantId,
                        priceMin: competitor && Number(competitor.priceMin) || null,
                        priceMax: competitor && Number(competitor.priceMax) || null
                    },
                    carrierClass: carrierClass,
                    alliancePresence: alliancePresence,
                    watchlisted: watchlisted,
                    alreadyScheduled: alreadyScheduled,
                    sizeWeight: _sizeWeight(wf, score, alreadyScheduled, watchlisted),
                    snapshotAt: (r && r.snapshotAt) || null
                }
            })

            destinations.sort((a, b) => (b.sizeWeight || 0) - (a.sizeWeight || 0))

            // Hard cap to keep storage and renderers bounded.
            const HARD_CAP = 200
            if (destinations.length > HARD_CAP) {
                warnings.push("dest-cap:" + destinations.length + ">" + HARD_CAP)
                destinations.length = HARD_CAP
            }

            out.destinations = destinations
            out.carrierIndex.leadByDest = leadByDest
            out.metrics.routeCount = destinations.length
            out.metrics.weeklyDepartures = weeklyDepartures
            out.metrics.topCompetitorShare = topCompShare
            out.metrics.avgCompetitionScore = scoreCount > 0 ? scoreSum / scoreCount : 0

            return out
        },

        // Helpers exported so tests / other modules can reuse the math.
        _competitionScore: _competitionScore,
        _sizeWeight: _sizeWeight,
        _allianceDestSet: _allianceDestSet,
        _allianceMemberIds: _allianceMemberIds
    }

    window.WorldViewNetworkBuilder = WorldViewNetworkBuilder
})()
