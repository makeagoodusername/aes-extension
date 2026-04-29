"use strict"

/**
 * AES Strategy — Hub Network Designer (Slice 14).
 *
 * Advisory-only proposer. Recommends where to open or close hubs based
 * on demand catchment, competitor saturation, slot availability (best-
 * effort), fleet-range compatibility, and pair-wise hub redundancy.
 *
 * Per the roadmap, hub moves never auto-apply: AirlineSim has no hub
 * designation endpoint, and the decision is too capital-heavy to gate
 * on a script anyway. Every candidate carries `advisoryOnly: true`.
 *
 * Public API:
 *   AesStrategy.designHubs(snapshot, opts?) → {
 *     opens:   OpenCandidate[],
 *     closes:  CloseCandidate[],
 *     summary: {ourHubCount, candidateCount, openProposals,
 *               closeProposals, networkEffectScore, builtAt}
 *   } | null
 *
 * Defaults (override via opts):
 *   minOpenFitness:    0.55
 *   maxOpenProposals:  3
 *   maxRedundancy:     0.50
 *   maxCloseProposals: 3
 */

;(function () {
    const SOURCE = "hub-designer"
    const DEFAULTS = {
        minOpenFitness:    0.55,
        maxOpenProposals:  3,
        maxRedundancy:     0.50,
        maxCloseProposals: 3
    }

    function designHubs(snapshot, opts) {
        const Graph = window.AesStrategyNetworkGraph
        if (!Graph || typeof Graph.build !== "function") return null
        const graph = Graph.build(snapshot)
        if (!graph) return null

        const o = Object.assign({}, DEFAULTS, opts || {})
        const distIdx = _buildDistanceIndex(graph)

        const opens  = _scoreOpens(graph, snapshot, o, distIdx)
        const closes = _scoreCloses(graph, o)
        const networkEffectScore = _networkEffect(graph, snapshot, opens, distIdx)

        return {
            opens:  opens,
            closes: closes,
            summary: {
                ourHubCount:        graph.summary.hubCount,
                candidateCount:     graph.summary.candidatePool,
                openProposals:      opens.length,
                closeProposals:     closes.length,
                networkEffectScore: networkEffectScore,
                builtAt:            Date.now()
            }
        }
    }

    // ── Open candidates ────────────────────────────────────────────────

    function _scoreOpens(graph, snapshot, opts, distIdx) {
        // Pool: airports we touch as destinations + competitor hubs we don't operate.
        const inboundPaxByIata = new Map()
        for (const e of graph.edges) {
            inboundPaxByIata.set(e.to, (inboundPaxByIata.get(e.to) || 0) + e.paxScore)
        }

        const candidates = []
        for (const node of graph.nodes.values()) {
            if (node.isOurHub) continue
            const inPool = node.touchedByHubs.size > 0 || node.isCompetitorHub
            if (!inPool) continue
            candidates.push({
                node:         node,
                catchmentRaw: inboundPaxByIata.get(node.iata) || 0
            })
        }
        if (!candidates.length) return []

        const maxCatchment = candidates.reduce((m, c) => c.catchmentRaw > m ? c.catchmentRaw : m, 0) || 1

        const ourHubArr = Array.from(graph.ourHubs)
        const ranges = _fleetRanges(snapshot)

        const out = []
        for (const c of candidates) {
            const node       = c.node
            const catchment  = c.catchmentRaw / maxCatchment
            const saturation = Math.min(5, node.competitorPresence) / 5
            const slotAvail  = 1.0   // v1 placeholder; awaits airport-info-store enrichment.

            const distsToHubs = ourHubArr
                .map(hub => _lookupDistance(distIdx, node.iata, hub))
                .filter(d => d != null)
            let fleetCompat = 1.0
            if (distsToHubs.length && ranges.length) {
                const median = _median(distsToHubs)
                fleetCompat = ranges.filter(r => r >= median).length / ranges.length
            }

            const fitness = 0.40 * catchment
                          + 0.30 * (1 - saturation)
                          + 0.20 * slotAvail
                          + 0.10 * fleetCompat

            const expectedConnectingHubs = ourHubArr.filter(hub => {
                const d = _lookupDistance(distIdx, node.iata, hub)
                if (d == null) return false
                return ranges.some(r => r >= d)
            })

            out.push({
                iata:                   node.iata,
                fitness:                +fitness.toFixed(4),
                components: {
                    catchment:   +catchment.toFixed(4),
                    saturation:  +saturation.toFixed(4),
                    slotAvail:   +slotAvail.toFixed(4),
                    fleetCompat: +fleetCompat.toFixed(4)
                },
                rationale:              _openRationale(node, catchment, saturation, fleetCompat),
                expectedConnectingHubs: expectedConnectingHubs,
                advisoryOnly:           true,
                source:                 SOURCE
            })
        }

        out.sort((a, b) => b.fitness - a.fitness)
        return out
            .filter(x => x.fitness >= opts.minOpenFitness)
            .slice(0, opts.maxOpenProposals)
    }

    function _openRationale(node, catchment, saturation, fleetCompat) {
        const lines = []
        if (catchment > 0.6)         lines.push("strong inbound demand evidence from our existing network")
        else if (catchment > 0.3)    lines.push("moderate inbound demand evidence")
        if (saturation < 0.2)        lines.push("low competitor presence at this airport")
        else if (saturation > 0.6)   lines.push("competitor presence high — entry friction expected")
        if (fleetCompat >= 0.5)      lines.push("most of our fleet can reach our hubs from here")
        else if (fleetCompat < 0.2)  lines.push("limited fleet range coverage from this airport")
        if (node.isCompetitorHub)    lines.push("operated as a hub by at least one rival")
        return lines
    }

    // ── Close candidates ───────────────────────────────────────────────

    function _scoreCloses(graph, opts) {
        // Per-hub overlap index from precomputed redundantPairs.
        const overlapByHub = new Map()
        for (const p of graph.redundantPairs) {
            if (!overlapByHub.has(p.a)) overlapByHub.set(p.a, [])
            if (!overlapByHub.has(p.b)) overlapByHub.set(p.b, [])
            overlapByHub.get(p.a).push({other: p.b, overlap: p.overlapFraction})
            overlapByHub.get(p.b).push({other: p.a, overlap: p.overlapFraction})
        }

        const out = []
        for (const entry of graph.byHub.entries()) {
            const iata = entry[0], bucket = entry[1]
            const overlaps = overlapByHub.get(iata) || []
            const worst = overlaps.reduce(
                (m, o) => o.overlap > m.overlap ? o : m,
                {overlap: 0, other: null}
            )
            if (worst.overlap < opts.maxRedundancy) continue
            if (bucket.totalProfit >= 0) continue

            const redundantWith = overlaps
                .filter(o => o.overlap >= opts.maxRedundancy)
                .map(o => o.other)

            out.push({
                iata:            iata,
                redundancyScore: +worst.overlap.toFixed(4),
                weeklyProfit:    +bucket.totalProfit.toFixed(2),
                redundantWith:   redundantWith,
                rationale: [
                    "hub running at a weekly loss",
                    "destination set " + Math.round(worst.overlap * 100) +
                        "% overlapped with " + worst.other,
                    bucket.destinations.size + " destinations served from " + iata
                ],
                advisoryOnly:    true,
                source:          SOURCE
            })
        }
        out.sort((a, b) => {
            if (a.weeklyProfit !== b.weeklyProfit) return a.weeklyProfit - b.weeklyProfit
            return b.redundancyScore - a.redundancyScore
        })
        return out.slice(0, opts.maxCloseProposals)
    }

    // ── Network-effect score (advisory diagnostic) ─────────────────────

    function _networkEffect(graph, snapshot, opens, distIdx) {
        if (!opens.length) return 0
        const ranges = _fleetRanges(snapshot)
        if (!ranges.length) return 0
        const medianRange = _median(ranges)
        const ourHubArr = Array.from(graph.ourHubs)
        if (!ourHubArr.length) return 0
        let total = 0
        for (const o of opens) {
            let reachable = 0
            for (const hub of ourHubArr) {
                const d = _lookupDistance(distIdx, o.iata, hub)
                if (d != null && d <= medianRange) reachable++
            }
            total += reachable / ourHubArr.length
        }
        return +(total / opens.length).toFixed(4)
    }

    // ── Helpers ────────────────────────────────────────────────────────

    function _fleetRanges(snapshot) {
        const fleet = Array.isArray(snapshot && snapshot.fleet) ? snapshot.fleet : []
        const out = []
        for (const a of fleet) {
            const r = Number(a && a.rangeKm)
            if (isFinite(r) && r > 0) out.push(r)
        }
        return out
    }

    function _buildDistanceIndex(graph) {
        const idx = new Map()
        for (const e of graph.edges) {
            if (e.distanceKm == null) continue
            idx.set(e.from + "→" + e.to, e.distanceKm)
            idx.set(e.to + "→" + e.from, e.distanceKm)
        }
        return idx
    }

    function _lookupDistance(idx, a, b) {
        if (a === b) return 0
        const v = idx.get(a + "→" + b)
        return v == null ? null : v
    }

    function _median(arr) {
        const s = arr.slice().sort((x, y) => x - y)
        const n = s.length
        if (!n) return 0
        return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])
    }

    const ns = window.AesStrategy || (window.AesStrategy = {})
    ns.designHubs = designHubs
})()
