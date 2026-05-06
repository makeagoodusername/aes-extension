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

    const FALLBACK_WEEKLY_HOURS  = 80
    const FALLBACK_TURNAROUND_MIN = 45
    const HOURS_PER_WEEK         = 168
    const MIN_TUPLE_SCORE        = 0.05    // skip below this — engine prefers idle
    const SEAT_FIT_LO            = 0.5
    const SEAT_FIT_HI            = 1.5

    function _planId() {
        return "plan-" + Date.now().toString(36) + "-"
            + Math.random().toString(36).slice(2, 8)
    }

    /**
     * Round-trip turnaround budget per route. Prefers a per-route override
     * (`route.turnaroundMin` plumbed by upstream candidates), then a snapshot
     * setting, then the 45-min default. Counted once per round-trip — the
     * outbound turn at the spoke; the hub turn is absorbed by the depTime
     * gap between outbound and return legs and not double-counted.
     */
    function _turnaroundFor(route, snapshot) {
        if (route && Number.isFinite(Number(route.turnaroundMin))) {
            return Number(route.turnaroundMin)
        }
        const fb = snapshot && snapshot.settings && snapshot.settings.autoScheduler
            && snapshot.settings.autoScheduler.fallbackTurnaroundMin
        if (Number.isFinite(Number(fb))) return Number(fb)
        return FALLBACK_TURNAROUND_MIN
    }

    // ── Per-aircraft candidate generation ───────────────────────────────

    function _candidatesForAircraft(aircraft, scored, snapshot) {
        const range = _num(aircraft.rangeKm, 0)
        const hub   = aircraft.currentLocationIata || _firstHub(snapshot)
        if (!hub) return []

        const overrides = snapshot && snapshot.settings && snapshot.settings.strategy && snapshot.settings.strategy.automationOverrides || {};
        const allowCrossHubRouting = !!overrides.allowCrossHubRouting;

        const list = []
        for (const r of scored.routes) {
            if (!r || !r.dest) continue
            if (!allowCrossHubRouting && r.hub !== hub) continue
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

    function _fillAircraft(aircraft, candidates, opts, snapshot) {
        const scoring = _scoring()
        const speed   = _num(aircraft.cruiseSpeedKmh, 800)
        const wear    = aircraft.wear || {}
        const cap     = _num(wear.maxWeeklyBlockHours, FALLBACK_WEEKLY_HOURS)
        const used0   = _num(wear.weeklyHoursLast7d, 0)
        let usedHours = used0
        const legs    = []
        const placedCounts = new Map()    // dest -> placements so far
        const routeMeta    = new Map()    // dest -> {rtHours, maxFreqByTime, turnaroundMin}
        const rationale = []

        // Pre-resolve per-candidate constants once. flightMin / rtHours /
        // maxFreqByTime / per-leg profit are pure functions of (route, speed,
        // turnaround) — recomputing them every pass is wasted work for
        // candidate sets that grow with hub size.
        const tupled = candidates.map(r => {
            const seatFit       = _seatFit(aircraft.seats, r.paxScore)
            const flightMin     = scoring.flightTimeMin(r.distanceKm, speed)
            const turnaroundMin = _turnaroundFor(r, snapshot)
            const rtHours       = (flightMin != null)
                ? ((flightMin * 2) + turnaroundMin) / 60 : null
            const maxFreqByTime = (rtHours != null && rtHours > 0)
                ? Math.max(0, Math.floor(HOURS_PER_WEEK / rtHours)) : 0
            const legProfit     = _num(r.profitPerWeek, 0) / Math.max(1, _num(r.weeklyFlights, 1))
            return {
                route: r, tupleScore: (r.score || 0) * seatFit, seatFit,
                flightMin, turnaroundMin, rtHours, maxFreqByTime, legProfit
            }
        })
        .filter(t => t.flightMin != null && t.maxFreqByTime >= 1)
        .sort((a, b) => b.tupleScore - a.tupleScore)

        rationale.push("[budget] cap " + cap.toFixed(1)
                     + "h · used last 7d " + used0.toFixed(1) + "h"
                     + (wear.source ? " · source " + wear.source : ""))
        // Lane C Phase 2 — surface the optimizer target gap when present.
        // null when fleetOptimizer.targetingEnabled is false (default).
        const targetWeeklyHours = (wear.targetWeeklyHours != null)
            ? Number(wear.targetWeeklyHours) : null
        if (isFinite(targetWeeklyHours) && targetWeeklyHours > 0) {
            const gap = targetWeeklyHours - used0
            rationale.push("[target] " + targetWeeklyHours.toFixed(1) + "h · gap "
                + (gap >= 0 ? "+" : "") + gap.toFixed(1) + "h"
                + (wear.floorPct != null ? " · floor " + wear.floorPct + "%" : ""))
        }
        if (cap <= used0) {
            rationale.push("[skip] no headroom this week")
            return {legs, rationale, plannedHours: 0, plannedProfit: 0,
                    placedCounts, routeMeta}
        }

        let plannedProfit = 0
        let exhaustedHeadroom = false
        // Conflict resolution override strategy.
        const conflictStrat = snapshot && snapshot.settings && snapshot.settings.strategy && snapshot.settings.strategy.automationOverrides && snapshot.settings.strategy.automationOverrides.conflictResolutionStrategy || "skip";

        for (let pass = 0; pass < 32 && !exhaustedHeadroom; pass++) {
            let placedThisPass = false
            for (const t of tupled) {
                if (t.tupleScore < MIN_TUPLE_SCORE) break

                const placed = placedCounts.get(t.route.dest) || 0
                if (placed >= t.maxFreqByTime) continue // hit absolute time-cap

                let proposedRtHours = t.rtHours;
                if (usedHours + proposedRtHours > cap) {
                    if (conflictStrat === "skip") continue; // hit weekly cap
                    // Handle "rebalance" by reducing the proposed route hours to fit the remaining limit (e.g., partial round trip scheduling if it is supported)
                    if (conflictStrat === "rebalance" && (cap - usedHours >= proposedRtHours * 0.5)) {
                       // We have enough time for at least a one-way, but AS requires RT. Skip for now to maintain valid legs.
                       continue;
                    }
                    if (conflictStrat === "force") {
                       // AS physically rejects schedules over the cap. "Force" will skip to prevent API failure, but logs an override attempt.
                       rationale.push("[force-override] Attempted to force schedule for " + t.route.dest + " but failed due to AS physical cap limits.");
                       continue;
                    }
                    continue;
                }

                routeMeta.set(t.route.dest, {
                    rtHours: proposedRtHours,
                    maxFreqByTime: t.maxFreqByTime,
                    turnaroundMin: t.turnaroundMin
                })

                const seq = legs.length + 1
                const legStrategy = {
                    routeScore:    t.route.score,
                    seatFit:       t.seatFit,
                    tupleScore:    t.tupleScore,
                    blockMin:      t.flightMin,
                    rtHours:       proposedRtHours,
                    turnaroundMin: t.turnaroundMin,
                    maxFreqByTime: t.maxFreqByTime,
                    proposedFreqAtPlacement: placed + 1,
                    conflictStrat: conflictStrat
                }
                legs.push({
                    origin:      aircraft.currentLocationIata || t.route.hub,
                    destination: t.route.dest,
                    depTime:     opts.depTime || "09:00",
                    pricePct:    _num(opts.pricePct, 100),
                    service:     opts.service || "",
                    seq:         seq,
                    _strategy:   legStrategy
                })
                legs.push({
                    origin:      t.route.dest,
                    destination: aircraft.currentLocationIata || t.route.hub,
                    depTime:     opts.returnDepTime || "15:00",
                    pricePct:    _num(opts.pricePct, 100),
                    service:     opts.service || "",
                    seq:         seq + 1,
                    _strategy:   Object.assign({}, legStrategy, {return: true})
                })
                usedHours += t.rtHours
                placedCounts.set(t.route.dest, placed + 1)
                placedThisPass = true
                plannedProfit += t.legProfit * 2
            }
            if (!placedThisPass) exhaustedHeadroom = true
        }

        // Rationale: top 3 destinations by frequency, then a tail summary.
        const freqRows = Array.from(placedCounts.entries())
            .sort((a, b) => b[1] - a[1])
        for (let i = 0; i < Math.min(3, freqRows.length); i++) {
            const [dest, freq] = freqRows[i]
            const meta = routeMeta.get(dest) || {}
            rationale.push("[place] " + dest + " ×" + freq
                + " (rt " + (meta.rtHours || 0).toFixed(1) + "h"
                + ", cap " + (meta.maxFreqByTime != null ? meta.maxFreqByTime : "?") + ")")
        }
        if (freqRows.length > 3) {
            const moreRT = freqRows.slice(3).reduce((a, [, n]) => a + n, 0)
            rationale.push("[place] …+" + moreRT + " more rt across " + (freqRows.length - 3) + " dests")
        }
        const totalRT = freqRows.reduce((a, [, n]) => a + n, 0)
        rationale.push("[final] " + totalRT + " round-trips · "
            + usedHours.toFixed(1) + "/" + cap.toFixed(1) + "h"
            + (cap > 0 ? " (" + Math.round(usedHours / cap * 100) + "%)" : ""))

        return {legs, rationale, plannedHours: usedHours, plannedProfit,
                placedCounts, routeMeta}
    }

    // ── Public ──────────────────────────────────────────────────────────

    async function allocateFleet(snapshot, scoredRoutes, opts) {
        const o = opts || {}
        const planId = _planId()
        if (!_scoring()) {
            return {
                planId, error: "AesStrategyScoring not loaded",
                perAircraft: [], routeCreations: [], priceMoves: [],
                serviceMoves: [], crewMoves: [], rebalanceMoves: [], summary: {}
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
            }, snapshot)
            totalProfit += fill.plannedProfit
            totalLegs   += fill.legs.length

            const routeFrequency = []
            if (fill.placedCounts) {
                for (const [dest, freq] of fill.placedCounts) {
                    const meta = (fill.routeMeta && fill.routeMeta.get(dest)) || {}
                    routeFrequency.push({
                        dest:           dest,
                        proposedFreq:   freq,
                        maxFreqByTime:  meta.maxFreqByTime != null ? meta.maxFreqByTime : null,
                        rtHours:        meta.rtHours != null ? meta.rtHours : null,
                        turnaroundMin:  meta.turnaroundMin != null ? meta.turnaroundMin : null
                    })
                }
                routeFrequency.sort((a, b) => b.proposedFreq - a.proposedFreq)
            }

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
                    maxDailyBlockHours: _num(a.wear && a.wear.maxDailyBlockHours, null),
                    ratioForecast:  a.wear && a.wear.ratioForecast7d
                },
                routeFrequency: routeFrequency,
                plannedProfit: fill.plannedProfit,
                rationale:     fill.rationale
            })
        }

        // Sub-proposers
        const routeCreations = (typeof ns.proposeRouteCreations === "function")
            ? ns.proposeRouteCreations(snapshot, scoredRoutes, o.routeCreation || {})
            : []
        let priceMoves = (typeof ns.proposePriceMoves === "function")
            ? ns.proposePriceMoves(snapshot, o.priceMoves || {})
            : []

        // Phase 3: Probabilistic Risk Fanning
        if (window.AesStrategyProbabilistic && typeof window.AesStrategyProbabilistic.augmentPriceMovesWithRisk === "function") {
            try {
                priceMoves = window.AesStrategyProbabilistic.augmentPriceMovesWithRisk(priceMoves, snapshot, o.priceMoves || {})
            } catch (e) {
                console.warn("[AesStrategy allocateFleet] augmentPriceMovesWithRisk failed", e)
            }
        }
        const serviceMoves = (typeof ns.proposeServiceMoves === "function")
            ? ns.proposeServiceMoves(snapshot, o.serviceMoves || {})
            : []

        // Phase 3 Lane C — fleet-rebalance proposer (preview-only).
        // Surfaces wave-add / wave-densify / service-profile-promote
        // proposals based on the fleet utilization summary's cold-tail
        // candidates. Pure read against snapshot + summary; no apply path
        // wired this phase. Empty when AesStrategyFleetUtilization isn't
        // loaded or there are no cold tails.
        let rebalanceMoves = []
        if (typeof ns.proposeRebalanceMoves === "function"
            && typeof window !== "undefined"
            && window.AesStrategyFleetUtilization) {
            try {
                const summary = window.AesStrategyFleetUtilization.compute({
                    snapshot, settings: snapshot && snapshot.settings, fleetPlan: null
                })
                const fos = (snapshot && snapshot.settings
                    && snapshot.settings.strategy && snapshot.settings.strategy.fleetOptimizer)
                    || (snapshot && snapshot.settings && snapshot.settings.fleetOptimizer)
                    || null
                rebalanceMoves = ns.proposeRebalanceMoves(snapshot, summary, {fleetOptimizer: fos})
                if (!Array.isArray(rebalanceMoves)) rebalanceMoves = []
            } catch (e) {
                console.warn("[AES allocateFleet] proposeRebalanceMoves failed", e)
                rebalanceMoves = []
            }
        }

        // Crew moves depend on the fleet plan's per-typeId leg counts.
        const planSoFar = {planId, perAircraft}
        let crewMoves = (typeof ns.proposeCrewMoves === "function")
            ? ns.proposeCrewMoves(snapshot, planSoFar, o.crewMoves || {})
            : []
        if (typeof ns.tuneCrewMoves === "function") {
            try {
                const tuned = ns.tuneCrewMoves(snapshot, Object.assign({},
                    o.crewMoves || {}, {fleetPlan: planSoFar, skipService: true}))
                if (tuned && Array.isArray(tuned.payMoves)) {
                    const base = crewMoves.filter(m => m && m.action !== "raisePay" && m.action !== "cutPay")
                    const pay = tuned.payMoves.map(_crewPayMoveToLegacy)
                    crewMoves = base.concat(pay)
                }
            } catch (e) {
                console.warn("[AES allocateFleet] tuneCrewMoves failed", e)
            }
        }

        // Slice 10 — competitor reactions are async (storage read for the
        // prior). Defensive: an empty array on missing module / failure.
        let competitorMoves = []
        if (typeof ns.proposeCompetitorMoves === "function") {
            try {
                competitorMoves = await ns.proposeCompetitorMoves(snapshot,
                    o.competitorMoves || {})
                if (!Array.isArray(competitorMoves)) competitorMoves = []
            } catch (e) {
                console.warn("[AES allocateFleet] proposeCompetitorMoves failed", e)
                competitorMoves = []
            }
        }

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
            crewPayWeeklyCostDelta:  crewMoves.filter(m => m.action === "raisePay" || m.action === "cutPay")
                                                         .reduce((a, m) => a + (m.weeklyCostDelta || 0), 0),
            routeCreationProposals:  routeCreations.length,
            competitorReactions:     competitorMoves.length,
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
            competitorMoves: competitorMoves,
            // Phase 3 Lane C — preview-only rebalance proposals.
            rebalanceMoves: rebalanceMoves,
            summary:       summary
        }
    }

    function _crewPayMoveToLegacy(move) {
        const action = _num(move && move.payTierPp, 0) >= 0 ? "raisePay" : "cutPay"
        const rationale = Array.isArray(move && move.rationale) ? move.rationale.slice() : []
        if (move && move.weeklyCostDelta != null) {
            rationale.push("[cost] weekly payroll delta "
                + Math.round(_num(move.weeklyCostDelta, 0)).toLocaleString() + " AS$")
        }
        return {
            skillLabel:       move && move.label || null,
            skillId:          null,
            typeId:           null,
            positionId:       move && move.positionId || null,
            group:            move && move.group || null,
            responsibilityClass: move && move.responsibilityClass || null,
            flightsNeeded:    move && move.required || null,
            activeNow:        move && move.active || null,
            reserveNow:       null,
            action:           action,
            amount:           move && move.payTierPp || 0,
            currentSalary:    move && move.currentSalary || null,
            recommendedSalary: move && move.recommendedSalary || null,
            countryAverage:   move && move.countryAverage || null,
            weeklyCostDelta:  move && move.weeklyCostDelta || 0,
            expectedRecruitDelta: move && move.expectedRecruitDelta || null,
            expectedOrsLiftPp: move && move.expectedOrsLiftPp || null,
            expectedReputationLiftPp: move && move.expectedReputationLiftPp || null,
            reputationValue:  move && move.reputationValue || null,
            reputationRating: move && move.reputationRating || null,
            accepted:         move ? move.accepted !== false : true,
            rationale:        rationale,
            payHypothesis: {
                predictedRecruitDelta: move && move.expectedRecruitDelta || null,
                confidence:            move && move.perceptionConfidence || null,
                inputs:                move && move.perceptionHypothesis || null
            }
        }
    }

    ns.allocateFleet = allocateFleet
})()
