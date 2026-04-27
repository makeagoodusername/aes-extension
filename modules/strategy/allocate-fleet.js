"use strict"

/**
 * AES Strategy — fleet co-allocator (Slice 3).
 *
 * Pure function. Lifts the per-aircraft greedy allocator
 * (`auto-scheduler/allocator.js`) to fleet-level co-allocation. Given a
 * Slice 1 snapshot + Slice 2 scored routes, returns a `FleetPlan`
 * describing per-aircraft schedules, route creation proposals, price
 * moves, service-profile moves, and crew adjustments. NO POSTs — Slice
 * 4 (`apply()`) is the only writer.
 *
 * v1 algorithm:
 *
 *   1. Pre-compute per-aircraft weekly block-hour budget from
 *      snapshot.fleet[i].wear.maxWeeklyBlockHours (falls back to 80h).
 *   2. For each aircraft, build a candidate route list — routes from
 *      its current location with distance ≤ aircraft range.
 *   3. Score each (aircraft × route) tuple with a per-tail multiplier
 *      that boosts seat utilisation: tupleScore = routeScore × seatFit
 *      where seatFit = clamp(seats / segmentDemandSeats, 0.5, 1.5).
 *   4. Greedy: pick the highest-scoring tuple, place it as a round-trip
 *      leg pair on the aircraft's grid (origin→dest, dest→origin), bill
 *      the aircraft's budget for 2× block-hours, remove both endpoints
 *      from the pool of available demand for this week, repeat.
 *   5. Stop placing on an aircraft when budget < next leg's hours, or
 *      when no candidate clears a minScore threshold.
 *   6. After all aircraft are filled, run sub-proposers:
 *        proposeRouteCreations, proposePriceMoves, proposeServiceMoves,
 *        proposeCrewMoves(plan).
 *   7. Compute summary: leg counts, predicted weekly profit, predicted
 *      ORS average.
 *
 * v2+ improvements (deferred):
 *   - True bipartite assignment (Hungarian) when candidate count is small.
 *   - Multi-leg waves with non-hub overnights.
 *   - Maintenance-window pre-seeding from MaintenanceBudget.
 *   - Inter-aircraft swap balancer (mirrors allocator.js round-robin).
 *
 * Output shape — see docs/STRATEGY-ROADMAP.md Slice 3 for full schema.
 *
 * Public API:
 *   AesStrategy.allocateFleet(snapshot, scoredRoutes, opts?) → FleetPlan
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.allocateFleet === "function") return

    function _scoring()    { return window.AesStrategyScoring }
    function _num(v, f)    { const n = Number(v); return isFinite(n) ? n : f }
    function _clamp(v, l, h) { return v < l ? l : v > h ? h : v }

    const FALLBACK_WEEKLY_HOURS = 80
    const MIN_TUPLE_SCORE       = 0.05    // skip below this — engine prefers idle
    const SEAT_FIT_LO           = 0.5
    const SEAT_FIT_HI           = 1.5

    function _planId() {
        return "plan-" + Date.now().toString(36) + "-"
            + Math.random().toString(36).slice(2, 8)
    }

    // ── Per-aircraft candidate generation ───────────────────────────────

    function _candidatesForAircraft(aircraft, scored, snapshot) {
        const range = _num(aircraft.rangeKm, 0)
        const hub   = aircraft.currentLocationIata || _firstHub(snapshot)
        if (!hub) return []
        const list = []
        for (const r of scored.routes) {
            if (!r || !r.dest || r.hub !== hub) continue
            if (r.distanceKm == null || r.distanceKm <= 0) continue
            if (range > 0 && r.distanceKm > range) continue
            list.push(r)
        }
        return list
    }

    function _firstHub(snapshot) {
        return snapshot && snapshot.hubs && snapshot.hubs[0] && snapshot.hubs[0].iata || null
    }

    /** Tuple score = routeScore × seatFit, where seatFit penalises a
     *  747 on a 30-pax-demand route and rewards a 737 on a high-pax route.
     *  segmentDemand is approximated as paxScore × 50 (pax demand bar 0-10
     *  scaled to ~500 pax/wk per point of demand). v2 will use real
     *  forecast load factor from elasticity-fit. */
    function _seatFit(seats, paxScore) {
        const s = _num(seats, 150)
        const demand = Math.max(50, _num(paxScore, 5) * 50)
        return _clamp(s / demand, SEAT_FIT_LO, SEAT_FIT_HI)
    }

    // ── Per-aircraft greedy filler ──────────────────────────────────────

    function _fillAircraft(aircraft, candidates, opts) {
        const scoring = _scoring()
        const speed   = _num(aircraft.cruiseSpeedKmh, 800)
        const wear    = aircraft.wear || {}
        const cap     = _num(wear.maxWeeklyBlockHours, FALLBACK_WEEKLY_HOURS)
        const used0   = _num(wear.weeklyHoursLast7d, 0)
        let usedHours = used0
        const legs    = []
        const placed  = new Set()
        const rationale = []

        // Sort by descending tuple score (re-score per-tail).
        const tupled = candidates.map(r => {
            const seatFit = _seatFit(aircraft.seats, r.paxScore)
            return {route: r, tupleScore: (r.score || 0) * seatFit, seatFit}
        }).sort((a, b) => b.tupleScore - a.tupleScore)

        rationale.push("[budget] cap " + cap.toFixed(1)
                     + "h · used last 7d " + used0.toFixed(1) + "h"
                     + (wear.source ? " · source " + wear.source : ""))
        if (cap <= used0) {
            rationale.push("[skip] no headroom this week")
            return {legs, rationale, plannedHours: 0, plannedProfit: 0}
        }

        let plannedProfit = 0
        for (const t of tupled) {
            if (t.tupleScore < MIN_TUPLE_SCORE) break
            if (placed.has(t.route.dest)) continue
            const flightMin = scoring.flightTimeMin(t.route.distanceKm, speed)
            if (flightMin == null) continue
            const rtHours = (flightMin * 2) / 60     // round-trip
            if (usedHours + rtHours > cap)            continue

            // Build outbound + return legs.
            const seq = legs.length + 1
            legs.push({
                origin:        aircraft.currentLocationIata || t.route.hub,
                destination:   t.route.dest,
                depTime:       opts.depTime || "09:00",
                pricePct:      _num(opts.pricePct, 100),
                service:       opts.service || "",
                seq:           seq,
                _strategy:     {
                    routeScore: t.route.score,
                    seatFit:    t.seatFit,
                    tupleScore: t.tupleScore,
                    blockMin:   flightMin
                }
            })
            legs.push({
                origin:        t.route.dest,
                destination:   aircraft.currentLocationIata || t.route.hub,
                depTime:       opts.returnDepTime || "15:00",
                pricePct:      _num(opts.pricePct, 100),
                service:       opts.service || "",
                seq:           seq + 1,
                _strategy:     {
                    routeScore: t.route.score,
                    seatFit:    t.seatFit,
                    tupleScore: t.tupleScore,
                    blockMin:   flightMin,
                    return:     true
                }
            })
            usedHours += rtHours
            placed.add(t.route.dest)
            const legProfit = _num(t.route.profitPerWeek, 0) / Math.max(1, _num(t.route.weeklyFlights, 1))
            plannedProfit += legProfit * 2   // round trip
            if (legs.length / 2 <= 3) {
                rationale.push("[place] " + t.route.dest
                    + " (score " + t.tupleScore.toFixed(3)
                    + ", seatFit " + t.seatFit.toFixed(2)
                    + ", " + rtHours.toFixed(1) + "h)")
            }
        }
        if (legs.length > 6) {
            rationale.push("[place] …+" + (legs.length / 2 - 3) + " more legs")
        }
        rationale.push("[final] " + (legs.length / 2) + " round-trips · "
            + usedHours.toFixed(1) + "/" + cap.toFixed(1) + "h"
            + (cap > 0 ? " (" + Math.round(usedHours / cap * 100) + "%)" : ""))

        return {legs, rationale, plannedHours: usedHours, plannedProfit}
    }

    // ── Public ──────────────────────────────────────────────────────────

    function allocateFleet(snapshot, scoredRoutes, opts) {
        const o = opts || {}
        const planId = _planId()
        if (!_scoring()) {
            return {
                planId, error: "AesStrategyScoring not loaded",
                perAircraft: [], routeCreations: [], priceMoves: [],
                serviceMoves: [], crewMoves: [], summary: {}
            }
        }

        const perAircraft = []
        let totalProfit = 0
        let totalLegs   = 0

        for (const a of (snapshot && snapshot.fleet) || []) {
            if (!a || !a.aircraftId) continue
            const cands = _candidatesForAircraft(a, scoredRoutes, snapshot)
            const fill  = _fillAircraft(a, cands, {
                depTime:       o.depTime,
                returnDepTime: o.returnDepTime,
                pricePct:      o.defaultPricePct,
                service:       o.defaultService
            })
            totalProfit += fill.plannedProfit
            totalLegs   += fill.legs.length

            perAircraft.push({
                aircraftId:    a.aircraftId,
                registration:  a.registration,
                equipment:     a.equipment,
                typeId:        a.typeId,
                hub:           a.currentLocationIata,
                legs:          fill.legs,
                ground:        [],
                utilization: {
                    weeklyHours:    fill.plannedHours,
                    capWeeklyHours: _num(a.wear && a.wear.maxWeeklyBlockHours, FALLBACK_WEEKLY_HOURS),
                    ratioForecast:  a.wear && a.wear.ratioForecast7d
                },
                rationale:     fill.rationale
            })
        }

        // Sub-proposers
        const routeCreations = (typeof ns.proposeRouteCreations === "function")
            ? ns.proposeRouteCreations(snapshot, scoredRoutes, o.routeCreation || {})
            : []
        const priceMoves = (typeof ns.proposePriceMoves === "function")
            ? ns.proposePriceMoves(snapshot, o.priceMoves || {})
            : []
        const serviceMoves = (typeof ns.proposeServiceMoves === "function")
            ? ns.proposeServiceMoves(snapshot, o.serviceMoves || {})
            : []

        // Crew moves depend on the fleet plan's per-typeId leg counts.
        const planSoFar = {planId, perAircraft}
        const crewMoves = (typeof ns.proposeCrewMoves === "function")
            ? ns.proposeCrewMoves(snapshot, planSoFar, o.crewMoves || {})
            : []

        // ORS prediction = mean Y-class score of profiles currently used.
        // v1 doesn't track per-route profile assignment, so we average all
        // available profiles' Y scores as a rough ceiling.
        const profiles = (snapshot && snapshot.serviceProfiles) || []
        const ys = profiles.map(p => p.classScore && _num(p.classScore.Y, NaN)).filter(isFinite)
        const predictedOrsAvg = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null

        const summary = {
            addedLegs:               totalLegs,
            removedLegs:             0,                   // v1 doesn't propose deletes
            repricedRoutes:          priceMoves.length,
            profileChanges:          serviceMoves.length,
            crewHires:               crewMoves.filter(m => m.action === "hire")
                                                         .reduce((a, m) => a + (m.amount || 0), 0),
            crewTraining:            crewMoves.filter(m => m.action === "train")
                                                         .reduce((a, m) => a + (m.amount || 0), 0),
            routeCreationProposals:  routeCreations.length,
            predictedWeeklyProfit:   totalProfit,
            predictedOrsAvg:         predictedOrsAvg
        }

        return {
            planId:        planId,
            ts:            Date.now(),
            server:        snapshot && snapshot.server,
            airlineCode:   snapshot && snapshot.airlineCode,
            horizonDays:   _num(o.horizonDays, 7),
            perAircraft:   perAircraft,
            routeCreations: routeCreations,
            priceMoves:    priceMoves,
            serviceMoves:  serviceMoves,
            crewMoves:     crewMoves,
            summary:       summary
        }
    }

    ns.allocateFleet = allocateFleet
})()
