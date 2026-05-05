"use strict"

/**
 * AES Strategy — auto route creation proposer (Slice 3 + 6).
 *
 * Pure function. Given a snapshot + scored routes, identifies high-scoring
 * (hub, dest) pairs the airline isn't yet flying and proposes the right
 * frequency, aircraft type, default service profile, and starting price.
 *
 * NO POSTs. Slice 4 (`apply()`) routes proposals through the existing
 * apply-batch pipeline; this module is pure decision.
 *
 * Public API:
 *   AesStrategy.proposeRouteCreations(snapshot, scoredRoutes, opts?) →
 *     RouteCreation[]
 *
 * RouteCreation shape:
 *   {hub, dest, distanceKm,
 *    proposedTypeIds: number[],       // suitable aircraft types in fleet
 *    proposedFrequency: number,       // weekly flights
 *    proposedPricePct: number,        // 100 = baseline
 *    proposedServiceProfileId: number | null,
 *    score, breakdown, rationale: string[]}
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeRouteCreations === "function") return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _suitableTypes(snapshot, distanceKm) {
        const out = new Set()
        if (!snapshot || !Array.isArray(snapshot.fleet)) return []
        for (const a of snapshot.fleet) {
            if (!a || a.typeId == null) continue
            const range = _num(a.rangeKm, 0)
            if (range > 0 && range >= distanceKm) out.add(Number(a.typeId))
        }
        return Array.from(out)
    }

    function _defaultServiceProfileId(snapshot, minOrsTarget) {
        const profiles = (snapshot && snapshot.serviceProfiles) || []
        if (!profiles.length) return null
        // Cheapest profile that clears the Y-class target. We don't have
        // cost data per profile in v1 (Slice 7 adds cost-per-pax) so we
        // rank by classScore.Y descending and pick the median — proxy
        // for "decent service, not wasteful." Slice 7 replaces this with
        // a real cost-aware optimizer.
        const ranked = profiles
            .filter(p => p && p.classScore && isFinite(_num(p.classScore.Y, NaN)))
            .sort((a, b) => _num(b.classScore.Y, 0) - _num(a.classScore.Y, 0))
        if (!ranked.length) return profiles[0].id || null
        const target = _num(minOrsTarget, 0.7)
        const aboveTarget = ranked.filter(p => _num(p.classScore.Y, 0) >= target)
        if (aboveTarget.length) {
            return aboveTarget[Math.floor(aboveTarget.length / 2)].id
        }
        return ranked[0].id
    }

    function _proposedFrequency(scoredRow, opts) {
        const c = scoredRow && scoredRow.competitor
        const minFreq = _num(opts && opts.minFrequency, 1)
        const maxFreq = _num(opts && opts.maxFrequency, 14)
        const demand  = (_num(scoredRow.paxScore, 0) + 0.5 * _num(scoredRow.cargoScore, 0))
        // Demand 0..15 → frequency 1..maxFreq. Subtract competitor flights
        // to avoid stuffing a saturated market.
        const ours    = c && _num(c.ourFlightCount, 0) || 0
        const others  = c && _num(c.flightCount,    0) || 0
        const slack   = Math.max(0, demand - 0.5 * (others - ours))
        const target  = Math.round(slack)
        return Math.max(minFreq, Math.min(maxFreq, target))
    }

    function _proposedPricePct(scoredRow, opts) {
        const c = scoredRow && scoredRow.competitor
        const defaultPct = _num(opts && opts.defaultPricePct, 100)
        if (!c || c.priceMin == null || c.priceMax == null) return defaultPct
        const mid = (_num(c.priceMin, defaultPct) + _num(c.priceMax, defaultPct)) / 2
        // Competitors quote absolute % bookings; we mirror that. Bound to
        // a reasonable band so a single outlier doesn't pin us at 200.
        return Math.round(Math.max(80, Math.min(140, mid)))
    }

    function proposeRouteCreations(snapshot, scoredRoutes, opts) {
        const o = opts || {}
        const out = []
        if (!snapshot || !scoredRoutes || !Array.isArray(scoredRoutes.routes)) return out

        const threshold = _num(o.threshold, 0.30)
        const minOrsTarget = _num(o.minOrsTarget, 0.7)

        // Hub set we can act on — only propose creations from hubs we own.
        const ownedHubs = new Set((snapshot.hubs || []).map(h => h && h.iata).filter(Boolean))

        for (const r of scoredRoutes.routes) {
            if (!r || r.alreadyScheduled) continue
            if (!ownedHubs.has(r.hub))      continue
            if ((r.score || 0) < threshold) continue
            if (r.distanceKm == null || r.distanceKm <= 0) continue

            const types = _suitableTypes(snapshot, r.distanceKm)
            if (!types.length) continue

            const freq    = _proposedFrequency(r, o)
            const pricePct = _proposedPricePct(r, o)
            const profileId = _defaultServiceProfileId(snapshot, minOrsTarget)

            const rationale = []
            rationale.push("[score] " + (r.score != null ? r.score.toFixed(3) : "?")
                         + " (over threshold " + threshold + ")")
            if (r.competitor && r.competitor.flightCount != null) {
                rationale.push("[market] " + r.competitor.flightCount + " competitor flights/wk")
            } else {
                rationale.push("[market] competitor intel not scanned — proposal is speculative")
            }
            if (r.paxScore != null)   rationale.push("[demand] pax " + r.paxScore)
            if (r.cargoScore != null) rationale.push("[demand] cargo " + r.cargoScore)
            rationale.push("[fleet] " + types.length + " type(s) in fleet match range")
            if (profileId == null) rationale.push("[ors] no service profiles cached — falling back to AS default")

            // Crude $/wk projection so the UI can show the bet's
            // expected magnitude. demand bar (0-10) × 50 pax per point ≈
            // weekly pax cap; multiply by a $20 average yield-per-pax-per-
            // distance approximation for a coarse "is this worth $5k/wk
            // or $50k/wk?" signal. Slice 9 replaces with elasticity-fit.
            const demandBar  = _num(r.paxScore, 0) + 0.5 * _num(r.cargoScore, 0)
            const weeklyPax  = Math.min(freq, demandBar) * 60   // 60 pax avg seat × LF guess
            const projWeekly = Math.round(weeklyPax * 20)       // ~$20/pax-flight rough

            out.push({
                hub:                       r.hub,
                dest:                      r.dest,
                destName:                  r.destName,
                distanceKm:                r.distanceKm,
                proposedTypeIds:           types,
                proposedFrequency:         freq,
                proposedPricePct:          pricePct,
                proposedServiceProfileId:  profileId,
                score:                     r.score,
                breakdown:                 r.breakdown,
                rationale:                 rationale,
                impactWeekly:              projWeekly
            })
        }

        out.sort((a, b) => (b.score || 0) - (a.score || 0))
        return out
    }

    ns.proposeRouteCreations = proposeRouteCreations
})()
