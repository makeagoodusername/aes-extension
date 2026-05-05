"use strict"

/**
 * AES Strategy — global hub network graph (Slice 14).
 *
 * Pure utility consumed by `hub-designer.js`. Builds a single in-memory
 * graph across every hub in `snapshot.hubs[]`, plus per-airport
 * competitor presence and pair-wise redundancy between our hubs.
 *
 * No DOM, no I/O, no storage. Sync. Returns `null` when the snapshot
 * has no hubs so callers can short-circuit.
 *
 * Public API:
 *   AesStrategyNetworkGraph.build(snapshot, opts?) → {
 *     ourHubs:        Set<iata>,
 *     competitorHubs: Set<iata>,
 *     nodes:          Map<iata, NodeRecord>,
 *     edges:          EdgeRecord[],
 *     byHub:          Map<iata, HubBucket>,
 *     redundantPairs: PairRecord[],
 *     summary:        {hubCount, edgeCount, candidatePool, builtAt}
 *   } | null
 */

;(function () {
    function build(snapshot, _opts) {
        if (!snapshot || !Array.isArray(snapshot.hubs) || !snapshot.hubs.length) return null

        const ourHubs        = new Set()
        const competitorHubs = new Set()
        const nodes          = new Map()
        const edges          = []
        const byHub          = new Map()

        function _node(iata) {
            const key = String(iata || "").toUpperCase()
            if (!key) return null
            if (!nodes.has(key)) {
                nodes.set(key, {
                    iata:               key,
                    isOurHub:           false,
                    isCompetitorHub:    false,
                    demandIn:           0,
                    demandOut:          0,
                    competitorCarriers: new Set(),
                    competitorFlights:  0,
                    competitorPresence: 0,
                    touchedByHubs:      new Set()
                })
            }
            return nodes.get(key)
        }

        // 1. Our hubs + edges from snapshot.hubs[].byRoute[].
        for (const h of snapshot.hubs) {
            if (!h || !h.iata) continue
            const hub = String(h.iata).toUpperCase()
            ourHubs.add(hub)
            const hubNode = _node(hub)
            hubNode.isOurHub = true
            if (!byHub.has(hub)) {
                byHub.set(hub, {
                    edges:        [],
                    totalProfit:  0,
                    totalFlights: 0,
                    destinations: new Set()
                })
            }
            const bucket = byHub.get(hub)

            for (const r of (h.byRoute || [])) {
                if (!r || !r.dest) continue
                const dest     = String(r.dest).toUpperCase()
                const destNode = _node(dest)
                destNode.touchedByHubs.add(hub)
                hubNode.touchedByHubs.add(dest)
                bucket.destinations.add(dest)

                const pax    = Number(r.paxScore)      || 0
                const cargo  = Number(r.cargoScore)    || 0
                const wf     = Number(r.weeklyFlights) || 0
                const profit = Number(r.profitPerWeek) || 0

                hubNode.demandOut += pax
                destNode.demandIn += pax

                if (r.competitor) {
                    const fc    = Number(r.competitor.flightCount)    || 0
                    const ours  = Number(r.competitor.ourFlightCount) || 0
                    const rival = Math.max(0, fc - ours)
                    if (rival > destNode.competitorFlights) destNode.competitorFlights = rival
                    if (r.competitor.dominantCarrier) {
                        destNode.competitorCarriers.add(String(r.competitor.dominantCarrier))
                    }
                }

                const edge = {
                    from:          hub,
                    to:            dest,
                    distanceKm:    Number(r.distanceKm) || null,
                    weeklyFlights: wf,
                    profitPerWeek: profit,
                    paxScore:      pax,
                    cargoScore:    cargo,
                    ourPaxShare:   Number(r.ourPaxShare) || 0
                }
                edges.push(edge)
                bucket.edges.push(edge)
                bucket.totalProfit  += profit
                bucket.totalFlights += wf
            }
        }

        // Cache competitor-presence count after the pass.
        for (const node of nodes.values()) {
            node.competitorPresence = node.competitorCarriers.size
        }

        // 2. Competitor hubs from `snapshot.rivals` (Slice 5+; today usually []).
        // Tolerates two shapes: `r.hubIatas: string[]` or `r.hubs: [{iata}]`.
        if (Array.isArray(snapshot.rivals)) {
            for (const r of snapshot.rivals) {
                if (!r) continue
                let list = null
                if (Array.isArray(r.hubIatas)) {
                    list = r.hubIatas
                } else if (Array.isArray(r.hubs)) {
                    list = r.hubs.map(h => h && (typeof h === "string" ? h : h.iata))
                }
                if (!Array.isArray(list)) continue
                for (const iata of list) {
                    if (!iata) continue
                    const k = String(iata).toUpperCase()
                    competitorHubs.add(k)
                    _node(k).isCompetitorHub = true
                }
            }
        }

        // 3. Redundant hub pairs: Jaccard-style overlap on destination sets,
        //    using min-set size as the denominator so a small hub fully
        //    contained in a large one scores 1.0 (the closure case).
        const redundantPairs = []
        const hubArr = Array.from(byHub.entries())
        for (let i = 0; i < hubArr.length; i++) {
            for (let j = i + 1; j < hubArr.length; j++) {
                const a = hubArr[i], b = hubArr[j]
                const setA = a[1].destinations, setB = b[1].destinations
                if (!setA.size || !setB.size) continue
                const sharedDests = []
                for (const d of setA) if (setB.has(d)) sharedDests.push(d)
                if (!sharedDests.length) continue
                const denom = Math.min(setA.size, setB.size)
                redundantPairs.push({
                    a:               a[0],
                    b:               b[0],
                    sharedDests:     sharedDests,
                    overlapFraction: sharedDests.length / denom
                })
            }
        }
        redundantPairs.sort((x, y) => y.overlapFraction - x.overlapFraction)

        let candidatePool = 0
        for (const node of nodes.values()) {
            if (!node.isOurHub && (node.touchedByHubs.size > 0 || node.isCompetitorHub)) {
                candidatePool++
            }
        }

        return {
            ourHubs:        ourHubs,
            competitorHubs: competitorHubs,
            nodes:          nodes,
            edges:          edges,
            byHub:          byHub,
            redundantPairs: redundantPairs,
            summary: {
                hubCount:      ourHubs.size,
                edgeCount:     edges.length,
                candidatePool: candidatePool,
                builtAt:       Date.now()
            }
        }
    }

    window.AesStrategyNetworkGraph = {build: build}
})()
