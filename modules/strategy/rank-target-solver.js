"use strict"

/**
 * AES Strategy — rank-target solver (Velvet Cascade · PR 1A).
 *
 * Pure function. Given a fully-prepared per-route bundle (compatible with
 * RouteAssistantOrsModel.project), find the (priceMultY, priceMultC,
 * priceMultF, serviceComfortDelta) tuple that maximises an
 * objective-weighted blend of:
 *
 *   J = rankWeight   × projectedShare    (continuous proxy for low rank)
 *     + profitWeight × profitDeltaWeekly (from the model's estimator)
 *     + shareWeight  × (projectedShare − baselineShare)
 *
 * Continuous `projectedShare` is the rank-as-objective proxy: shares come
 * from the same softmax that drives AS's rank ordering, so monotone in
 * share ⇒ monotone-or-equal in rank. Discrete rank is derived for display
 * only; the optimisation runs on smooth gradient.
 *
 * Coarse-to-fine sweep:
 *   - Coarse:  Y ∈ {0.90, 0.95, 1.00, 1.05, 1.10}; C, F ∈ {0.90, 1.00, 1.10};
 *              comfortΔ ∈ {0, +1, +2}                          → 5×3×3×3 = 135 cells
 *   - Fine:    around coarse winner — Y ±0.05 step 0.01;
 *              C, F ±0.05 step 0.025; comfort fixed at coarse  → 11×3×3 = 99 cells
 *
 * Anti-spiral guards (NORTH-STAR §4.17) applied IN-loop:
 *   - Price-floor: reject any cell where projected revenue/pax < marginalCost × 1.05.
 *     marginalCost is read from `economics.marginalCostPerSeat` when
 *     available, else from the baseline estimator's breakdown.
 *   - Per-window cap: grid bounds enforce ±10pp via the multiplier range.
 *   - Service comfort cap: comfortΔ ∈ {0, +1, +2} only.
 *
 * Public API:
 *   AesStrategy.solveRankTarget(input) →
 *     {best, projection, grid, rationale, fallback?: false} | null
 *
 * Input shape (`input`):
 *   {
 *     route:       <RouteAssistantOrsModel.project route arg>,
 *     economics:   <RouteAssistantOrsModel.project economics arg>,
 *     modelParams: <RouteAssistantOrsModel.project modelParams arg>,
 *     useRealDemandForLF: bool,
 *     weights:     {rankWeight, profitWeight, shareWeight},
 *     bounds?:     {priceMaxMove?, comfortMax?},   // priceMaxMove default 0.10 (±10pp)
 *     priceFloorMultiplier?: 1.05                  // safety margin over marginal cost
 *   }
 *
 * Output:
 *   best:       {priceMultipliers: {Y, C, F}, comfortDelta,
 *                projectedShare, projectedProfitWeekly,
 *                projectedRankAny?, J}
 *   projection: full ors-model.project result for the best cell
 *   grid:       {coarseEvaluations, fineEvaluations, floorClamped, withinBounds}
 *   rationale:  string[]
 *
 * Returns null when the route lacks ORS data (caller falls back to S1).
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.solveRankTarget === "function") return

    const COARSE_Y = [0.90, 0.95, 1.00, 1.05, 1.10]
    const COARSE_CF = [0.90, 1.00, 1.10]
    const COARSE_COMFORT = [0, 1, 2]
    const FINE_Y_HALF_WINDOW = 0.05
    const FINE_Y_STEP = 0.01
    const FINE_CF_OFFSETS = [-0.05, 0, 0.05]
    const DEFAULT_PRICE_MAX_MOVE = 0.10
    const DEFAULT_COMFORT_MAX = 2
    const DEFAULT_FLOOR_MULTIPLIER = 1.05

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    function _hasOrsData(route) {
        if (!route || !route.orsByClass) return false
        for (const k in route.orsByClass) {
            const c = route.orsByClass[k]
            if (c && Array.isArray(c.connections) && c.connections.length) return true
        }
        return false
    }

    /**
     * Estimate marginal cost per seat from the baseline projection's
     * breakdown. Used to enforce the §4.17 price-floor guard. When the
     * economics map carries an explicit `marginalCostPerSeat` we honour it;
     * otherwise we derive from the estimator's per-flight cost / seats.
     */
    function _resolveMarginalCostPerSeat(input, baseline) {
        const econ = input.economics || {}
        const explicit = _num(econ.marginalCostPerSeat, NaN)
        if (isFinite(explicit) && explicit > 0) return explicit
        if (!baseline || !baseline.projectedEcon) return null
        const seats = _num(input.route && input.route.spec && input.route.spec.seats, 0)
        const breakdown = baseline.projectedEcon.breakdown || {}
        const cost = _num(breakdown.fuelCostPerFlight, 0) + _num(breakdown.crewCostPerFlight, 0)
        if (!seats || !cost) return null
        return cost / seats
    }

    /**
     * Evaluate one grid cell. Returns null if the cell violates an in-loop
     * guard (priceFloor); otherwise the score envelope.
     */
    function _evaluateCell(input, my, mc, mf, comfortDelta, baseline, floorPerSeat) {
        const scenario = {
            priceMultipliers: {Y: my, C: mc, F: mf},
            cargoMultiplier:  1,
            comfortDelta:     comfortDelta,
            frequency:        null
        }
        const projection = window.RouteAssistantOrsModel.project({
            route:              input.route,
            scenario:           scenario,
            modelParams:        input.modelParams || {},
            economics:          input.economics || {},
            useRealDemandForLF: !!input.useRealDemandForLF
        })
        if (!projection || !projection.projected) return null
        const proj = projection.projected
        const base = projection.baseline || {}

        // Price-floor — reject when scaled Y price falls under floor × marginalCost.
        if (floorPerSeat != null) {
            const scaledY = projection.scaledPrices && _num(projection.scaledPrices.Y, NaN)
            if (isFinite(scaledY) && scaledY > 0 && scaledY < floorPerSeat) {
                return {floorClamped: true}
            }
        }

        const projShare   = _num(proj.share, 0)
        const baseShare   = _num(base.share, 0)
        const profitDelta = _num(proj.profitPerWeek, 0) - _num(base.profitPerWeek, 0)
        return {
            projection:    projection,
            projShare:     projShare,
            baseShare:     baseShare,
            profitDelta:   profitDelta,
            profitWeekly:  _num(proj.profitPerWeek, 0),
            rankAny:       proj.rank ? _num(proj.rank.any, null) : null
        }
    }

    /**
     * Score a cell. Delegates to AesStrategyObjective.score() so the same
     * weighting rule that ranks routes elsewhere ranks solver cells here.
     * Maps the model's outputs to the {share, baselineShare, profit,
     * baselineProfit, rank, baselineRank} contract.
     */
    function _scoreCell(cell, weights, baseline) {
        if (typeof window.AesStrategyObjective !== "object"
            || typeof window.AesStrategyObjective.score !== "function") {
            // Defensive fallback — additive on share+profit only.
            const denom = Math.max(1, Math.abs(_num(baseline && baseline.baseline
                                                    && baseline.baseline.profitPerWeek, 0)))
            return weights.rankWeight  * cell.projShare
                 + weights.shareWeight * (cell.projShare - cell.baseShare)
                 + weights.profitWeight * (cell.profitDelta / denom)
        }
        const baseRank = baseline && baseline.baseline && baseline.baseline.rank
            ? _num(baseline.baseline.rank.any, null) : null
        const baseProfit = baseline && baseline.baseline
            ? _num(baseline.baseline.profitPerWeek, null) : null
        return window.AesStrategyObjective.score({
            share:         cell.projShare,
            baselineShare: cell.baseShare,
            profit:        cell.profitWeekly,
            baselineProfit: baseProfit,
            rank:          cell.rankAny,
            baselineRank:  baseRank
        }, weights)
    }

    function _bound(v, max) {
        if (v > 1 + max) return 1 + max
        if (v < 1 - max) return 1 - max
        return v
    }

    /**
     * Coarse pass — full grid sweep at 5pp/10pp resolution.
     * Returns {best, evaluations, floorClampedCells}.
     */
    function _coarsePass(input, weights, comfortMax, floorPerSeat, baseline) {
        let best = null
        let evaluations = 0
        let floorClamped = 0
        const yGrid = COARSE_Y
        const cfGrid = COARSE_CF
        const comfortGrid = COARSE_COMFORT.filter(c => c <= comfortMax)
        for (const my of yGrid) {
            for (const mc of cfGrid) {
                for (const mf of cfGrid) {
                    for (const cd of comfortGrid) {
                        evaluations++
                        const cell = _evaluateCell(input, my, mc, mf, cd, baseline, floorPerSeat)
                        if (!cell) continue
                        if (cell.floorClamped) { floorClamped++; continue }
                        const J = _scoreCell(cell, weights, baseline)
                        if (best == null || J > best.J) {
                            best = Object.assign({J, my, mc, mf, comfortDelta: cd}, cell)
                        }
                    }
                }
            }
        }
        return {best, evaluations, floorClamped}
    }

    /**
     * Fine pass around the coarse winner. Y at 1pp resolution, C/F at
     * 2.5pp offsets, comfortDelta fixed at coarse winner. Bounded to
     * stay inside priceMaxMove.
     */
    function _finePass(input, weights, coarseBest, priceMaxMove, floorPerSeat, baseline) {
        if (!coarseBest) return {best: null, evaluations: 0, floorClamped: 0}
        let best = coarseBest
        let evaluations = 0
        let floorClamped = 0
        const yLo = Math.max(coarseBest.my - FINE_Y_HALF_WINDOW, 1 - priceMaxMove)
        const yHi = Math.min(coarseBest.my + FINE_Y_HALF_WINDOW, 1 + priceMaxMove)
        const yCount = Math.max(0, Math.round((yHi - yLo) / FINE_Y_STEP))
        for (let i = 0; i <= yCount; i++) {
            const my = _round(yLo + i * FINE_Y_STEP, 4)
            for (const dc of FINE_CF_OFFSETS) {
                const mc = _round(_bound(coarseBest.mc + dc, priceMaxMove), 4)
                for (const df of FINE_CF_OFFSETS) {
                    const mf = _round(_bound(coarseBest.mf + df, priceMaxMove), 4)
                    evaluations++
                    const cell = _evaluateCell(input, my, mc, mf, coarseBest.comfortDelta,
                                               baseline, floorPerSeat)
                    if (!cell) continue
                    if (cell.floorClamped) { floorClamped++; continue }
                    const J = _scoreCell(cell, weights, baseline)
                    if (J > best.J) {
                        best = Object.assign({J, my, mc, mf, comfortDelta: coarseBest.comfortDelta}, cell)
                    }
                }
            }
        }
        return {best, evaluations, floorClamped}
    }

    /**
     * Resolve the bounds object with defaults.
     */
    function _resolveBounds(b) {
        const bb = b || {}
        return {
            priceMaxMove: _num(bb.priceMaxMove, DEFAULT_PRICE_MAX_MOVE),
            comfortMax:   Math.max(0, Math.floor(_num(bb.comfortMax, DEFAULT_COMFORT_MAX)))
        }
    }

    function _resolveWeights(w) {
        const ww = w || {}
        return {
            rankWeight:   _num(ww.rankWeight,   0.2),
            profitWeight: _num(ww.profitWeight, 0.4),
            shareWeight:  _num(ww.shareWeight,  0.4)
        }
    }

    /**
     * Public entry. Returns null when the route lacks ORS data so the
     * caller can degrade to the S1 competitor-band heuristic (§4.8).
     */
    function solveRankTarget(input) {
        if (!input || !input.route) return null
        if (typeof window.RouteAssistantOrsModel === "undefined") return null
        if (!_hasOrsData(input.route)) return null

        const weights = _resolveWeights(input.weights)
        const bounds  = _resolveBounds(input.bounds)
        const floorMul = _num(input.priceFloorMultiplier, DEFAULT_FLOOR_MULTIPLIER)

        // Baseline projection (multipliers all = 1, comfort = 0). Used to
        // derive baselineProfit + marginalCost reference.
        const baseline = window.RouteAssistantOrsModel.project({
            route:              input.route,
            scenario:           {priceMultipliers: {Y: 1, C: 1, F: 1}, comfortDelta: 0},
            modelParams:        input.modelParams || {},
            economics:          input.economics || {},
            useRealDemandForLF: !!input.useRealDemandForLF
        })
        if (!baseline || !baseline.projected) return null

        const marginalCost = _resolveMarginalCostPerSeat(input, baseline)
        const floorPerSeat = (marginalCost != null) ? marginalCost * floorMul : null

        const coarse = _coarsePass(input, weights, bounds.comfortMax, floorPerSeat, baseline)
        if (!coarse.best) {
            return {
                best:       null,
                projection: baseline,
                grid: {
                    coarseEvaluations: coarse.evaluations,
                    fineEvaluations:   0,
                    floorClamped:      coarse.floorClamped,
                    withinBounds:      true
                },
                rationale: [
                    "[solver] coarse 5×3×3×" + COARSE_COMFORT.length
                        + " yielded no admissible cell (all rejected by price-floor or guards)",
                    "[guardrail] price floor at marginalCost × " + floorMul
                        + (marginalCost != null ? " (" + _round(marginalCost, 0) + "/seat)" : " (cost unknown)")
                ]
            }
        }

        const fine = _finePass(input, weights, coarse.best, bounds.priceMaxMove,
                               floorPerSeat, baseline)
        const best = fine.best || coarse.best

        const rationale = []
        rationale.push("[solver] coarse 5×3×3×" + COARSE_COMFORT.length
            + " (" + coarse.evaluations + " cells) → fine 11×3×3 (" + fine.evaluations + " cells)")
        rationale.push("[best] Y×" + _round(best.my, 3)
            + " C×" + _round(best.mc, 3)
            + " F×" + _round(best.mf, 3)
            + " comfortΔ=+" + best.comfortDelta)
        const dShare = (best.projShare - best.baseShare) * 100
        rationale.push("[projected] share " + _round(best.baseShare * 100, 1) + "% → "
            + _round(best.projShare * 100, 1) + "% (Δ " + (dShare >= 0 ? "+" : "") + _round(dShare, 1) + "pp)"
            + (best.rankAny != null ? " · rank #" + best.rankAny : ""))
        rationale.push("[goal] rankWeight=" + _round(weights.rankWeight, 2)
            + " profitWeight=" + _round(weights.profitWeight, 2)
            + " shareWeight=" + _round(weights.shareWeight, 2))
        if (floorPerSeat != null) {
            rationale.push("[guardrail] price floor at marginalCost × " + floorMul
                + " (" + _round(marginalCost, 0) + "/seat)"
                + ((coarse.floorClamped + fine.floorClamped) > 0
                    ? " · " + (coarse.floorClamped + fine.floorClamped) + " cells clamped"
                    : ""))
        } else {
            rationale.push("[guardrail] price floor unavailable — marginalCost unknown")
        }
        rationale.push("[bounds] priceMaxMove=±" + _round(bounds.priceMaxMove * 100, 0)
            + "pp · comfortMax=+" + bounds.comfortMax)

        return {
            best: {
                priceMultipliers:       {Y: best.my, C: best.mc, F: best.mf},
                comfortDelta:           best.comfortDelta,
                projectedShare:         best.projShare,
                baselineShare:          best.baseShare,
                projectedProfitWeekly:  best.profitWeekly,
                profitDelta:            best.profitDelta,
                projectedRankAny:       best.rankAny,
                J:                      best.J
            },
            projection: best.projection,
            grid: {
                coarseEvaluations: coarse.evaluations,
                fineEvaluations:   fine.evaluations,
                floorClamped:      coarse.floorClamped + fine.floorClamped,
                withinBounds:      true
            },
            rationale:  rationale,
            weights:    weights,
            bounds:     bounds
        }
    }

    ns.solveRankTarget = solveRankTarget
})()
