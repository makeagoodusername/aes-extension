"use strict"

/**
 * AES Strategy — pricing proposer (Slice 3 + 9 + S1).
 *
 * Pure function. Given a snapshot, proposes per-route price changes that
 * move our price toward an objective-weighted target derived from the
 * competitor band and the route's congestion. The objective triple
 * (share/profit/rank) is resolved per-route via AesStrategyObjective so
 * the user's global goal AND per-route overrides both apply.
 *
 * S1 keeps the proposer cheap: it does NOT load full ORS projections per
 * route; instead it computes an objective-weighted target percent in the
 * competitor band, applies a congestion damper, and clips to the
 * deadband + max-move-per-window guardrails. S2 will widen this to a
 * full ORS-model curve sweep when route ORS data is in the snapshot.
 *
 * NO POSTs. Slice 4 (`apply()`) routes through RouteAssistantPricingApplier.
 *
 * Public API:
 *   AesStrategy.proposePriceMoves(snapshot, opts?) → PriceMove[]
 *
 * Opts (all optional):
 *   {deadband, maxMovePerWindow, fallbackPricePct, includeCargo,
 *    objective: {kind, custom?}}    // explicit override; otherwise read
 *                                      from snapshot.strategySettings.objective
 *
 * PriceMove shape (unchanged for back-compat with diff-plan):
 *   {hub, dest, classKey: "Y"|"C"|"F"|"Cargo",
 *    fromPct, toPct, deltaPct, rationale: string[],
 *    impactWeekly, profitPerWeek,
 *    objective?: {kind, weights}}   // S1 — surface for audit/UI
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposePriceMoves === "function") return

    const DEFAULT_BALANCED = {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    /**
     * Anti-spiral guard (NORTH-STAR §4.17). When `RouteAssistantCompetitorIncome`
     * is loaded, estimate the competitor's current weekly profit on this lane.
     * If they're already below a configurable floor, downward price moves get
     * dampened so we don't drive them into the dirt and trigger a race-to-zero.
     *
     * Returns one of:
     *   {damper: 1,   estProfit, floor, confidence, available: true}   — full move OK
     *   {damper: 0.5, estProfit, floor, confidence, available: true}   — dampen
     *   {available: false}                                              — module / data missing
     *
     * Defensive: every store, field, and arithmetic step is null-guarded; any
     * failure falls back to `available: false` so legacy behaviour holds.
     */
    function _competitorIncomeGuard(route, move, snapshot) {
        if (typeof RouteAssistantCompetitorIncome === "undefined") return {available: false}
        const c = route && route.competitor
        if (!c) return {available: false}
        const dist = _num(route && route.distanceKm, 0)
        if (dist <= 0) return {available: false}
        const totalFlights = _num(c.flightCount, 0)
        const ourFlights   = _num(c.ourFlightCount, 0)
        const compFreq     = totalFlights - ourFlights
        if (compFreq <= 0) return {available: false}
        // Use the lower bound of the observed competitor band as a conservative
        // proxy for what they're charging — it under-estimates revenue, which
        // makes the floor check err on the safe side (more dampening, not less).
        const compPrice = _num(c.priceMin, NaN)
        if (!isFinite(compPrice) || compPrice <= 0) return {available: false}
        const spec = route.spec || null
        if (!spec || !spec.seats || !spec.range || !spec.speed) return {available: false}
        const ourShare      = _num(route.ourPaxShare, 0)
        const compSharePct  = Math.max(0, Math.min(100, (1 - ourShare) * 100))
        const econ          = (snapshot && snapshot.settings && snapshot.settings.economics) || {}
        let result
        try {
            result = RouteAssistantCompetitorIncome.estimate({
                distanceKm:       dist,
                price:            compPrice,
                frequency:        compFreq,
                aircraftSpec:     spec,
                observedSharePct: compSharePct,
                economics:        econ
            })
        } catch (_) { return {available: false} }
        if (!result || result.confidence === "low") return {available: false}
        const estProfit = _num(result.estProfitPerWeek, NaN)
        if (!isFinite(estProfit)) return {available: false}
        const floor = _num(econ.competitorIncomeFloorWeekly, 5000)
        // Only downward moves trigger the spiral risk — upward moves give
        // competitor breathing room, not the opposite.
        const dampen = move < 0 && estProfit < floor
        return {
            available:  true,
            damper:     dampen ? 0.5 : 1,
            estProfit:  estProfit,
            floor:      floor,
            confidence: result.confidence
        }
    }

    function _flatten(snapshot) {
        const out = []
        const hubs = snapshot && snapshot.hubs
        if (!Array.isArray(hubs)) return out
        for (const h of hubs) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                if (!r || !r.dest) continue
                out.push(Object.assign({hub: h.iata}, r))
            }
        }
        return out
    }

    function _resolveGlobal(snapshot, opts) {
        if (opts && opts.objective && opts.objective.kind) return opts.objective
        const s = (snapshot && snapshot.strategySettings) || {}
        if (s.objective) return s.objective
        return {kind: "balanced", custom: DEFAULT_BALANCED}
    }

    function _resolveWeights(snapshot, opts, hub, dest) {
        const global = _resolveGlobal(snapshot, opts)
        const O = window.AesStrategyObjective
        let perRoute = null
        const map = snapshot && snapshot.routeObjectives
        if (map && hub && dest) {
            const k = String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
            perRoute = (typeof map.get === "function") ? map.get(k) : map[k]
        }
        if (O && typeof O.resolve === "function") {
            return O.resolve(global.kind, global.custom, perRoute)
        }
        return {kind: global.kind || "balanced", weights: DEFAULT_BALANCED}
    }

    /**
     * Compute the target price percent for a route given the resolved
     * objective weights. Blends three anchor points in the competitor band:
     *   rank-max  → just below competitor floor (price-leader)
     *   share-max → competitor mid - 5pp (undercut)
     *   profit-max → competitor mid + 5pp (capture margin)
     * The result is the weighted sum of these anchors. Falls back to the
     * caller's `fallbackPricePct` when competitor data is absent.
     */
    function _targetPct(route, weights, opts) {
        const c = route && route.competitor
        const fallback = _num(opts && opts.fallbackPricePct, 100)
        if (!c || c.priceMin == null || c.priceMax == null) return fallback
        const lo  = _num(c.priceMin, fallback)
        const hi  = _num(c.priceMax, fallback)
        const mid = (lo + hi) / 2

        const rankAnchor   = lo - 5
        const shareAnchor  = mid - 5
        const profitAnchor = mid + 5

        const target = weights.rankWeight   * rankAnchor
                     + weights.shareWeight  * shareAnchor
                     + weights.profitWeight * profitAnchor

        const share = _num(route.ourPaxShare, NaN)
        const shareTilt = isFinite(share) && share < 0.15 ? -2
                       : isFinite(share) && share > 0.40 ? +2 : 0

        return _round(Math.max(70, Math.min(150, target + shareTilt)), 0)
    }

    function proposePriceMoves(snapshot, opts) {
        const o = opts || {}

        // Velvet Cascade · PR 1A — prefer the joint rank-target tuner when
        // ORS data is in the snapshot. Falls through to the S1 competitor-
        // band heuristic when the tuner returns null (e.g. no ORS cache,
        // missing model module). The tuner's output already carries the
        // PriceMove shape this function returns, so we pass it through.
        if (typeof ns.tuneJointly === "function" && o.useJointTuner !== false) {
            const cached = (snapshot && snapshot._jointPlan) || null
            const joint = cached || ns.tuneJointly(snapshot, {skipService: true})
            if (joint && Array.isArray(joint.priceMoves) && joint.priceMoves.length) {
                if (snapshot && !cached) snapshot._jointPlan = joint
                return joint.priceMoves
            }
        }

        const deadband      = _num(o.deadband,            5)
        const maxMove       = _num(o.maxMovePerWindow,    10)
        const fallbackPct   = _num(o.fallbackPricePct,    100)
        const includeCargo  = o.includeCargo !== false

        const moves = []
        for (const r of _flatten(snapshot)) {
            const resolved = _resolveWeights(snapshot, o, r.hub, r.dest)
            const w        = resolved.weights

            const currentPct = (r.override && _num(r.override.yieldPerKm, NaN))
                || fallbackPct
            const target     = _targetPct(r, w, o)
            let delta        = target - currentPct
            if (Math.abs(delta) < deadband) continue

            // Congestion damper — damp moves on saturated routes so we
            // don't kick off a price war that other tiles will match.
            const cong = _num(r.congestionIndex, 0)
            const damper = Math.max(0.4, 1 - 0.5 * cong)
            delta = delta * damper

            let move = Math.sign(delta) * Math.min(Math.abs(delta), maxMove)
            // Anti-spiral guard (§4.17): consult competitor-income-estimator
            // before committing the downward portion of the move.
            const guard = _competitorIncomeGuard(r, move, snapshot)
            if (guard.available && guard.damper < 1) move = move * guard.damper
            if (Math.abs(move) < deadband) continue
            const toPct = _round(currentPct + move, 0)

            const rationale = []
            const c = r.competitor
            if (c && c.priceMin != null && c.priceMax != null) {
                rationale.push("[market] competitor band " + c.priceMin + "–" + c.priceMax + "%")
            }
            if (c && c.dominantCarrier) rationale.push("[market] dominant carrier " + c.dominantCarrier)
            if (r.ourPaxShare != null) rationale.push("[share] our pax share "
                + Math.round(_num(r.ourPaxShare, 0) * 100) + "%")
            rationale.push("[goal] " + resolved.kind
                + " · weights share=" + _round(w.shareWeight, 2)
                + " profit=" + _round(w.profitWeight, 2)
                + " rank=" + _round(w.rankWeight, 2))
            if (cong > 0) {
                rationale.push("[congestion] index " + _round(cong, 2)
                    + " — move damped ×" + _round(damper, 2))
            }
            rationale.push("[move] " + currentPct + "% → " + toPct + "% (capped at ±" + maxMove + ")")
            if (Math.abs(target - currentPct) > maxMove) {
                rationale.push("[guardrail] full target " + target + "% clipped to ±" + maxMove
                            + "pp — re-evaluate next window")
            }
            if (guard.available) {
                if (guard.damper < 1) {
                    rationale.push("[anti-spiral] competitor income est ~$"
                        + Math.round(guard.estProfit) + "/wk below floor $"
                        + guard.floor + "/wk (confidence " + guard.confidence
                        + ") — downward move dampened ×" + guard.damper)
                } else {
                    rationale.push("[anti-spiral] competitor income est ~$"
                        + Math.round(guard.estProfit) + "/wk (confidence " + guard.confidence
                        + ") — above floor $" + guard.floor + "/wk")
                }
            } else {
                rationale.push("[anti-spiral] competitor-income data unavailable — using legacy weights")
            }

            const profitPerWeek = _num(r.profitPerWeek, 0)
            const impact = Math.round((move / 100) * profitPerWeek * 0.5)
            moves.push({
                hub:        r.hub,
                dest:       r.dest,
                classKey:   "Y",
                fromPct:    currentPct,
                toPct:      toPct,
                deltaPct:   move,
                rationale:  rationale,
                impactWeekly: impact,
                profitPerWeek: profitPerWeek,
                objective:  {kind: resolved.kind, weights: w}
            })

            if (includeCargo && r.cargoScore != null && _num(r.cargoScore, 0) >= 5) {
                const cargoMove = Math.sign(move) * Math.min(Math.abs(move) / 2, maxMove / 2)
                if (Math.abs(cargoMove) >= deadband / 2) {
                    moves.push({
                        hub:        r.hub,
                        dest:       r.dest,
                        classKey:   "Cargo",
                        fromPct:    100,
                        toPct:      _round(100 + cargoMove, 0),
                        deltaPct:   cargoMove,
                        rationale:  ["[mirror] cargo follows pax move at half magnitude (v1 heuristic)"],
                        impactWeekly: Math.round((cargoMove / 100) * profitPerWeek * 0.25),
                        profitPerWeek: profitPerWeek,
                        objective:  {kind: resolved.kind, weights: w}
                    })
                }
            }
        }

        return moves
    }

    ns.proposePriceMoves = proposePriceMoves
})()
