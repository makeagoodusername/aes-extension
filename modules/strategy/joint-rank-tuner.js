"use strict"

/**
 * AES Strategy — joint pricing + service rank-target tuner (Velvet Cascade · PR 1A).
 *
 * Pure function over a `snapshot` enriched with `orsByClass`, `ownPricing`,
 * and `spec` per route (attached by `context.js::snapshot()` at PR 1A).
 *
 * Two-pass coordination so service and price decisions don't double-count:
 *
 *   PASS 1 — service comfortDelta per profile.
 *     Service-profile changes are batch effects: one upgrade lifts ORS
 *     rating across every route the profile is mounted on. Without a
 *     route→profile mapping in the snapshot today, v1 evaluates the
 *     comfortDelta as a network-wide lever — pick the value of
 *     comfortDelta ∈ {0, +1, +2} that maximises total objective J across
 *     all routes (held at current prices). Apply the same comfortDelta
 *     uniformly. Higher-fidelity per-profile mapping ships in PR 2.
 *
 *   PASS 2 — per-route price tuple GIVEN pass-1 comfortDelta.
 *     For each route, call AesStrategy.solveRankTarget with comfortDelta
 *     locked. Solver picks (Y, C, F) multipliers that maximise J subject
 *     to anti-spiral guardrails (price floor at marginalCost × 1.05,
 *     ±10pp per-window cap).
 *
 * Output is shape-compatible with the existing `proposePriceMoves` and
 * `proposeServiceMoves` returns so `diff-plan.js` consumes it unchanged.
 *
 * Returns null when the snapshot lacks the prerequisites (ORS data /
 * own pricing / spec / model module). Callers fall back to S1.
 *
 * Public API:
 *   AesStrategy.tuneJointly(snapshot, opts?) →
 *     {priceMoves, serviceMoves, summary} | null
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.tuneJointly === "function") return

    const COMFORT_GRID = [0, 1, 2]
    const PRICE_DEADBAND_PCT = 2     // skip moves below 2pp net
    const SOLVER = () => window.AesStrategy && window.AesStrategy.solveRankTarget

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    function _hasOrs(route) {
        if (!route || !route.orsByClass) return false
        for (const k in route.orsByClass) {
            const c = route.orsByClass[k]
            if (c && Array.isArray(c.connections) && c.connections.length) return true
        }
        return false
    }

    /**
     * Build the per-route input bundle that `solveRankTarget` (and
     * `RouteAssistantOrsModel.project`) consumes. Returns null when the
     * route is not solveable (missing ORS / spec / pricing).
     */
    function _buildRouteInput(snapshot, hub, route, weights, comfortMax) {
        if (!route || !route.dest) return null
        if (!_hasOrs(route)) return null
        if (!route.spec) return null
        if (!route.ownPricing || !route.ownPricing.prices) return null

        const settings   = (snapshot && snapshot.settings) || {}
        const economics  = settings.economics || {}
        const orsParams  = settings.ors || {}
        const useReal    = !!(economics.useRealDemandForLF || orsParams.useRealDemandForLF)

        const modelParams = {
            ratingPriceElasticity: orsParams.ratingPriceElasticity != null
                ? Number(orsParams.ratingPriceElasticity) : undefined,
            ratingComfortLift:     orsParams.ratingComfortLift != null
                ? Number(orsParams.ratingComfortLift) : undefined,
            shareTemperature:      orsParams.shareTemperature != null
                ? Number(orsParams.shareTemperature) : undefined
        }

        return {
            route: {
                hub:               hub,
                dest:              route.dest,
                distanceKm:        route.distanceKm,
                ownPricing:        route.ownPricing,
                orsByClass:        route.orsByClass,
                spec:              route.spec,
                currentFrequency:  route.weeklyFlights,
                paxScore:          route.paxScore,
                cargoScore:        route.cargoScore,
                paxDemandPool:     route.paxDemandPool,
                paxElasticity:     route.paxElasticity,
                aircraftAge:       null,
                falloffPct:        economics.falloffPct
            },
            economics:          economics,
            modelParams:        modelParams,
            useRealDemandForLF: useReal,
            weights:            weights,
            bounds:             {priceMaxMove: 0.10, comfortMax: comfortMax}
        }
    }

    /**
     * PASS 1 — pick the network-wide comfortDelta that maximises Σ J.
     * Sums per-route best-cell J for each candidate comfortDelta. Returns
     * the winning delta plus the per-route projections used by Pass 2.
     */
    function _pickGlobalComfortDelta(snapshot, opts) {
        const out = {comfortDelta: 0, totalJ: 0, perDelta: {}}
        const hubs = (snapshot && snapshot.hubs) || []
        if (!hubs.length) return out

        const solver = SOLVER()
        if (!solver) return out

        // For each candidate delta, sum the best-J across all eligible routes.
        for (const delta of COMFORT_GRID) {
            let total = 0
            let evaluated = 0
            for (const h of hubs) for (const r of (h && h.byRoute) || []) {
                const weights = window.AesStrategyObjective
                    ? window.AesStrategyObjective.resolveForRoute(snapshot, h.iata, r.dest).weights
                    : {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
                const input = _buildRouteInput(snapshot, h.iata, r, weights, delta)
                if (!input) continue
                input.bounds.comfortMax = delta
                const res = solver(input)
                if (!res || !res.best) continue
                total += res.best.J
                evaluated++
            }
            out.perDelta[delta] = {totalJ: total, evaluated}
            if (delta === 0 || total > out.totalJ) {
                out.totalJ = total
                out.comfortDelta = delta
            }
        }
        return out
    }

    /**
     * PASS 2 — per-route price solve with comfortDelta locked. Returns the
     * priceMoves array compatible with the existing PriceMove shape.
     *
     * `restrictTo: {hub, dest}` — Pricing Compass single-route filter. Pass 1
     * still runs network-wide so the comfort delta lock doesn't drift on
     * one route; Pass 2 just skips routes that don't match.
     */
    function _solvePricesPerRoute(snapshot, comfortDelta, restrictTo) {
        const out = []
        const hubs = (snapshot && snapshot.hubs) || []
        const solver = SOLVER()
        if (!solver) return out
        const wantHub  = restrictTo && restrictTo.hub  ? String(restrictTo.hub).toUpperCase()  : null
        const wantDest = restrictTo && restrictTo.dest ? String(restrictTo.dest).toUpperCase() : null

        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            if (wantHub  && String(h.iata).toUpperCase()  !== wantHub)  continue
            if (wantDest && String(r.dest).toUpperCase()  !== wantDest) continue
            const weights = window.AesStrategyObjective
                ? window.AesStrategyObjective.resolveForRoute(snapshot, h.iata, r.dest)
                : null
            const w = (weights && weights.weights) || {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
            const kind = (weights && weights.kind) || "balanced"

            const input = _buildRouteInput(snapshot, h.iata, r, w, comfortDelta)
            if (!input) continue
            input.bounds.comfortMax = comfortDelta
            const res = solver(input)
            if (!res || !res.best) continue

            const prices = (r.ownPricing && r.ownPricing.prices) || {}
            for (const cls of ["Y", "C", "F"]) {
                const mult = res.best.priceMultipliers[cls]
                if (!isFinite(mult)) continue
                const fromPct = 100  // multipliers are relative to current
                const toPct   = _round(mult * 100, 0)
                const deltaPct = toPct - fromPct
                if (Math.abs(deltaPct) < PRICE_DEADBAND_PCT) continue
                const observed = _num(prices[cls], null)
                const newPrice = (observed != null) ? _round(observed * mult, 0) : null

                const rationale = res.rationale.slice()
                if (observed != null && newPrice != null) {
                    rationale.push("[" + cls + "] " + observed + " → " + newPrice + " (×" + _round(mult, 3) + ")")
                }
                rationale.push("[goal] " + kind
                    + " · share=" + _round(w.shareWeight, 2)
                    + " profit=" + _round(w.profitWeight, 2)
                    + " rank=" + _round(w.rankWeight, 2))

                const profitDelta = _num(res.best.profitDelta, 0)
                out.push({
                    hub:           h.iata,
                    dest:          r.dest,
                    classKey:      cls,
                    fromPct:       fromPct,
                    toPct:         toPct,
                    deltaPct:      deltaPct,
                    rationale:     rationale,
                    impactWeekly:  Math.round(profitDelta / 3),  // each class shares the projected delta
                    profitPerWeek: _num(r.profitPerWeek, 0),
                    objective:     {kind: kind, weights: w},
                    _solver: {
                        coarseEvaluations:    res.grid.coarseEvaluations,
                        fineEvaluations:      res.grid.fineEvaluations,
                        floorClamped:         res.grid.floorClamped,
                        projectedShare:       res.best.projectedShare,
                        baselineShare:        res.best.baselineShare,
                        projectedRankAny:     res.best.projectedRankAny,
                        projectedProfitWeekly: res.best.projectedProfitWeekly,
                        comfortDeltaApplied:  res.best.comfortDelta,
                        priceMultipliers:     Object.assign({}, res.best.priceMultipliers)
                    }
                })
            }
        }
        return out
    }

    /**
     * Translate a global comfortDelta into per-profile per-category
     * `changes` payloads. v1 picks the lowest-Y category in each profile
     * and bumps it by 1 (for delta +1) or the two lowest by 1 each (for
     * delta +2). Reads `categories` and `categoryByPrefix` attached by
     * the extended `_loadServiceProfiles` aggregator.
     */
    function _buildServiceMoves(snapshot, comfortDelta) {
        if (!comfortDelta) return []
        const profiles = (snapshot && snapshot.serviceProfiles) || []
        if (!profiles.length) return []
        const out = []
        for (const p of profiles) {
            if (!p || !p.categories) continue
            const cats = p.categories
            const ranked = []
            for (const catKey in cats) {
                const cat = cats[catKey]
                if (!cat) continue
                const yVal = _num(cat.Y, null)
                if (yVal == null) continue
                ranked.push({catKey, yVal})
            }
            if (!ranked.length) continue
            ranked.sort((a, b) => a.yVal - b.yVal)
            const targetCount = Math.min(comfortDelta, ranked.length)
            const changes = {}
            const picked = []
            for (let i = 0; i < targetCount; i++) {
                const pick = ranked[i]
                changes[pick.catKey] = {Y: pick.yVal + 1}
                picked.push(pick.catKey + " Y=" + pick.yVal + "→" + (pick.yVal + 1))
            }

            const yNow = _num(p.classScore && p.classScore.Y, null)
            const cNow = _num(p.classScore && p.classScore.C, null)
            const fNow = _num(p.classScore && p.classScore.F, null)

            const rationale = [
                "[joint] global comfortΔ=+" + comfortDelta + " selected by Pass 1 (network-wide profit + rank score)",
                "[picks] " + picked.join(", "),
                "[note] v1 maps comfortΔ to bottom-up Y category bumps; PR 2 introduces full Slice 7 ranking"
            ]
            if (p.scrapedAt) {
                const ageDays = (Date.now() - p.scrapedAt) / (24 * 3600 * 1000)
                if (ageDays > 14) rationale.push("[stale] profile detail scraped " + Math.round(ageDays) + "d ago")
            }

            out.push({
                profileId:         p.id,
                profileName:       p.name || ("#" + p.id),
                currentClassScore: {Y: yNow, C: cNow, F: fNow},
                targetClassScore:  {Y: yNow, C: cNow, F: fNow},
                changes:           changes,
                predictedOrsDelta: comfortDelta * 0.05,
                rationale:         rationale,
                objective:         null,
                _solver:           {comfortDeltaApplied: comfortDelta, picks: picked}
            })
        }
        return out
    }

    function tuneJointly(snapshot, opts) {
        if (!snapshot || !Array.isArray(snapshot.hubs) || !snapshot.hubs.length) return null
        if (typeof window.RouteAssistantOrsModel === "undefined") return null
        if (!SOLVER()) return null

        // Skip the pass-1 comfort sweep when the user has muted service moves.
        const o = opts || {}
        const skipService = !!o.skipService

        let comfortDelta = 0
        let pass1 = null
        if (!skipService) {
            pass1 = _pickGlobalComfortDelta(snapshot, o)
            comfortDelta = pass1.comfortDelta || 0
        }

        const priceMoves   = _solvePricesPerRoute(snapshot, comfortDelta, o.restrictTo || null)
        const serviceMoves = _buildServiceMoves(snapshot, comfortDelta)

        return {
            priceMoves:   priceMoves,
            serviceMoves: serviceMoves,
            summary: {
                comfortDelta: comfortDelta,
                priceMoveCount:   priceMoves.length,
                serviceMoveCount: serviceMoves.length,
                pass1:            pass1
            }
        }
    }

    ns.tuneJointly = tuneJointly
})()
