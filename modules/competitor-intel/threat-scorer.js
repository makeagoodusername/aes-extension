"use strict"

/**
 * Pure-function competitor threat scorer.
 *
 * Reads a single enterprise's record (from `AesCompetitorStore.loadEnterprise`)
 * plus its snapshot history (from `AesCompetitorSnapshotStore.loadHistory`)
 * and an optional `ourHubs` set (uppercase IATA codes for hubs we operate).
 * Produces:
 *   {
 *     score:      0..100 (clipped),
 *     bucket:     "low" | "moderate" | "elevated" | "high",
 *     components: { fleet, network, momentum, overlap, alliance, freshness },
 *     rationale:  string[]    — human-readable, ordered by impact desc,
 *     flags:      { ... }     — booleans for downstream gates
 *   }
 *
 * Pure: no DOM, no I/O. Safe to call from render loops or background ticks.
 *
 * Component contributions (max additive total before clip):
 *   fleet      0..25    weight on aircraftCount (log-scaled)
 *   network    0..20    weight on routeCount + hubCount
 *   momentum   0..25    rate of route/fleet additions across recent snapshots
 *   overlap    0..20    overlap between their hubs and ours
 *   alliance   0..05    alliance-affiliated competitors get a small bump
 *   freshness  0..05    confidence prior — penalises stale records slightly
 */
class AesCompetitorThreatScorer {
    static MOMENTUM_WINDOW_MS = 30 * 86400000   // 30d window over recent snapshots
    static FRESHNESS_HORIZON_DAYS = 28          // beyond this, confidence prior decays

    /**
     * @param {object} input
     * @param {object} input.record         AesCompetitorStore enterprise record
     * @param {Array}  [input.snapshots]    AesCompetitorSnapshotStore history
     * @param {Array<string>} [input.ourHubs] uppercase IATAs of OUR hubs
     * @param {number} [input.now]          override clock (ms)
     */
    static score(input) {
        const record = input && input.record
        if (!record || typeof record !== "object") {
            return AesCompetitorThreatScorer._empty("no enterprise record")
        }
        const snapshots = Array.isArray(input.snapshots) ? input.snapshots : []
        const ourHubs = AesCompetitorThreatScorer._normHubs(input.ourHubs)
        const now = isFinite(input.now) ? Number(input.now) : Date.now()

        const fleet     = AesCompetitorThreatScorer._fleetComponent(record)
        const network   = AesCompetitorThreatScorer._networkComponent(record)
        const momentum  = AesCompetitorThreatScorer._momentumComponent(snapshots, now)
        const overlap   = AesCompetitorThreatScorer._overlapComponent(record, ourHubs)
        const alliance  = AesCompetitorThreatScorer._allianceComponent(record)
        const freshness = AesCompetitorThreatScorer._freshnessComponent(record, now)

        const raw = fleet.value + network.value + momentum.value
                  + overlap.value + alliance.value + freshness.value
        const score = Math.max(0, Math.min(100, Math.round(raw)))

        const rationale = []
        for (const c of [overlap, momentum, fleet, network, alliance, freshness]) {
            if (c.note) rationale.push(c.note)
        }

        return {
            score,
            bucket: AesCompetitorThreatScorer._bucket(score),
            components: {
                fleet:     fleet.value,
                network:   network.value,
                momentum:  momentum.value,
                overlap:   overlap.value,
                alliance:  alliance.value,
                freshness: freshness.value
            },
            rationale,
            flags: {
                hubOverlap:       overlap.flag,
                expanding:        momentum.expanding,
                contracting:      momentum.contracting,
                alliance:         alliance.flag,
                hasRecentChange:  momentum.hasRecentChange
            }
        }
    }

    static _bucket(score) {
        if (score >= 70) return "high"
        if (score >= 50) return "elevated"
        if (score >= 30) return "moderate"
        return "low"
    }

    static _empty(reason) {
        return {
            score: 0, bucket: "low",
            components: {fleet: 0, network: 0, momentum: 0, overlap: 0, alliance: 0, freshness: 0},
            rationale: reason ? [reason] : [],
            flags: {hubOverlap: false, expanding: false, contracting: false, alliance: false, hasRecentChange: false}
        }
    }

    static _fleetComponent(record) {
        const count = record.fleet && isFinite(record.fleet.aircraftCount)
            ? Number(record.fleet.aircraftCount) : 0
        if (count <= 0) return {value: 0, note: null}
        // log-scale: 5 tails ~ 7pts, 20 ~ 15, 60 ~ 22, 100+ → 25
        const value = Math.min(25, Math.round(5 + 10 * Math.log10(Math.max(1, count))))
        return {value, note: count + " tails"}
    }

    static _networkComponent(record) {
        const hubs = Array.isArray(record.hubs) ? record.hubs.length : 0
        const routes = Array.isArray(record.routeFootprint) ? record.routeFootprint.length : 0
        if (hubs + routes === 0) return {value: 0, note: null}
        const value = Math.min(20, Math.round(hubs * 2 + Math.log10(Math.max(1, routes)) * 4))
        const parts = []
        if (hubs)   parts.push(hubs   + " hub" + (hubs   === 1 ? "" : "s"))
        if (routes) parts.push(routes + " route" + (routes === 1 ? "" : "s"))
        return {value, note: parts.join(" · ") || null}
    }

    /**
     * Momentum: positive when the network is expanding (routes/fleet types added
     * in the recent snapshot window), negative-leaning when contracting. Bounded
     * 0..25 — a contracting competitor still scores 0 here, not negative; the
     * absence of expansion is itself a low-threat signal.
     */
    static _momentumComponent(snapshots, now) {
        if (!snapshots.length) return {value: 0, note: null, expanding: false, contracting: false, hasRecentChange: false}
        const cutoff = now - AesCompetitorThreatScorer.MOMENTUM_WINDOW_MS
        const recent = snapshots.filter(s => s && isFinite(s.at) && s.at >= cutoff)
        if (recent.length < 2) return {value: 0, note: null, expanding: false, contracting: false, hasRecentChange: false}

        const oldest = recent[0]
        const newest = recent[recent.length - 1]
        const routeDelta = (newest.routeCount || 0) - (oldest.routeCount || 0)
        const fleetDelta = (newest.aircraftCount || 0) - (oldest.aircraftCount || 0)
        const hubDelta   = (newest.hubCount    || 0) - (oldest.hubCount    || 0)

        const expanding = routeDelta > 0 || fleetDelta > 0 || hubDelta > 0
        const contracting = !expanding && (routeDelta < 0 || fleetDelta < 0 || hubDelta < 0)
        const hasRecentChange = routeDelta !== 0 || fleetDelta !== 0 || hubDelta !== 0

        let value = 0
        const parts = []
        if (routeDelta > 0) { value += Math.min(12, routeDelta * 2); parts.push("+" + routeDelta + " routes") }
        if (fleetDelta > 0) { value += Math.min(8,  fleetDelta * 2); parts.push("+" + fleetDelta + " tails") }
        if (hubDelta   > 0) { value += Math.min(5,  hubDelta * 3);   parts.push("+" + hubDelta + " hubs") }
        if (!expanding && contracting) parts.push("contracting")

        value = Math.min(25, Math.round(value))
        return {
            value,
            note: parts.length ? parts.join(", ") + " in recent window" : null,
            expanding, contracting, hasRecentChange
        }
    }

    static _overlapComponent(record, ourHubs) {
        if (!ourHubs || !ourHubs.size) return {value: 0, note: null, flag: false}
        const theirHubs = []
        for (const h of (record.hubs || [])) {
            if (h && h.iata) theirHubs.push(String(h.iata).toUpperCase())
        }
        if (!theirHubs.length) return {value: 0, note: null, flag: false}
        const overlap = theirHubs.filter(h => ourHubs.has(h))
        if (!overlap.length) return {value: 0, note: null, flag: false}
        const value = Math.min(20, overlap.length * 7)
        return {
            value,
            note: "overlaps our hubs at " + overlap.slice(0, 4).join(", ")
                + (overlap.length > 4 ? " (+" + (overlap.length - 4) + ")" : ""),
            flag: true
        }
    }

    static _allianceComponent(record) {
        if (!record.alliance || !record.alliance.id) return {value: 0, note: null, flag: false}
        return {
            value: 5,
            note: "in alliance " + (record.alliance.name || record.alliance.id),
            flag: true
        }
    }

    static _freshnessComponent(record, now) {
        const at = record.scrapedAt
        if (!isFinite(at)) return {value: 0, note: "never scraped"}
        const ageDays = (now - at) / 86400000
        if (ageDays < AesCompetitorThreatScorer.FRESHNESS_HORIZON_DAYS) return {value: 5, note: null}
        return {value: 0, note: "stale data (" + Math.round(ageDays) + "d old)"}
    }

    static _normHubs(arr) {
        if (!Array.isArray(arr)) return null
        const out = new Set()
        for (const h of arr) if (h) out.add(String(h).toUpperCase())
        return out
    }
}

if (typeof window !== "undefined") {
    window.AesCompetitorThreatScorer = AesCompetitorThreatScorer
}
