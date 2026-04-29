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
 * Tier ordering:
 *   1. Joint rank-target tuner (`tuneJointly`) — when route ORS data is
 *      attached, the solver picks (Y, C, F) multipliers under the model
 *      with comfortDelta locked. Returns directly.
 *   2. S1 + Slice 9 fallback — no ORS data: emit per-class moves anchored
 *      at the route's `ownPricing.prices` (each class scored independently
 *      against the live competitor band), an asymmetric cargo move whose
 *      direction is driven by cargoScore × cargo competitor presence
 *      rather than mirroring pax, and an elasticity hint mined from
 *      `orsHistory` when ≥3 snapshots show our prior price moves
 *      degrading rank (yield-curve fit is direction-only — full curve
 *      lands when a competitor-price history store ships).
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
        const stratEcon     = (snapshot && snapshot.strategySettings
                               && snapshot.strategySettings.economics) || {}
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
        const floor = _num(econ.competitorIncomeFloorWeekly,
                           _num(stratEcon.competitorIncomeFloorWeekly, 5000))
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

        // Demand is the primary driver: paxScore ≥7 takes margin, ≤3
        // undercuts to fill. Combines additively with shareTilt.
        const pax = _num(route.paxScore, NaN)
        const demandTilt = isFinite(pax) && pax >= 7 ? +5
                        : isFinite(pax) && pax <= 3 ? -5 : 0

        return _round(Math.max(70, Math.min(150, target + shareTilt + demandTilt)), 0)
    }

    // ── Slice 9 — yield-curve elasticity hint ─────────────────────────
    //
    // Mine `r.orsHistory` for a coarse direction signal: when prior
    // upward price moves on this route correlated with rank degradation,
    // dampen the next upward move (and vice versa). Only emits a signal
    // when ≥3 snapshots and a clear sign-correlation; otherwise returns
    // `{available: false}` so the proposer keeps the legacy behaviour.
    //
    // This is intentionally not a full elasticity fit — full curve lands
    // when a per-route competitor-price history store ships and we can
    // cross-reference our price changes against competitor responses.
    // The direction-only signal is enough to flag obvious "we already
    // tried that and it cost us" cases.
    function _elasticityHint(route, classKey, intendedMove) {
        const hist = route && route.orsHistory
        if (!Array.isArray(hist) || hist.length < 3) return {available: false}
        const priceField = "price" + classKey
        const samples = []
        for (const s of hist) {
            if (!s || !s.context) continue
            const px   = _num(s.context[priceField], NaN)
            const cls  = s.byClass && s.byClass[classKey]
            const rank = cls && _num(cls.rankAny, NaN)
            const ts   = _num(s.scrapedAt, NaN)
            if (!isFinite(px) || !isFinite(rank) || !isFinite(ts)) continue
            samples.push({px: px, rank: rank, ts: ts})
        }
        if (samples.length < 3) return {available: false}
        samples.sort((a, b) => a.ts - b.ts)
        // Direction of price drift across the window — sum of consecutive
        // signed deltas. Same for rank. Lower rank value = better, so we
        // negate to align "rank up" with "rank improved".
        let priceDrift = 0
        let rankDrift  = 0
        for (let i = 1; i < samples.length; i++) {
            priceDrift += samples[i].px   - samples[i - 1].px
            rankDrift  -= samples[i].rank - samples[i - 1].rank   // sign-flip
        }
        // Hint fires only when we have a non-trivial price drift and a
        // contradicting rank drift (price ↑ but rank ↓, or price ↓ but
        // rank ↑). When the intended move shares the price-drift sign
        // we've been hurt by, dampen.
        if (Math.abs(priceDrift) < 1) return {available: false, samples: samples.length}
        const priceDir = Math.sign(priceDrift)
        const rankDir  = Math.sign(rankDrift)
        const damper = (priceDir === Math.sign(intendedMove) && rankDir < 0) ? 0.6 : 1
        return {
            available:  true,
            damper:     damper,
            samples:    samples.length,
            priceDrift: priceDrift,
            rankDrift:  rankDrift
        }
    }

    // ── Slice 9 — cargo asymmetric decision ───────────────────────────
    //
    // Cargo demand is decoupled from passenger pricing — it's driven by
    // freight network presence, not pax service quality. The pre-S9
    // heuristic mirrored pax move at half magnitude, which is wrong
    // direction in the (very common) "weak pax, strong cargo" case.
    //
    // Direction logic, ranked by signal strength:
    //   - cargoScore high (≥7) AND no observed competitor band on Cargo
    //     → undercut current Cargo by 4pp (capture share)
    //   - cargoScore high AND competitor priceMin/Max present (cargo lane
    //     contested) → match competitor mid-anchor
    //   - cargoScore mid (4-6) → small upward nudge (+2pp) when our price
    //     is below competitor mid; otherwise hold (no move emitted).
    //   - cargoScore low (<4) → no move.
    function _cargoAsymmetric(route, weights, opts) {
        const cargoScore = _num(route && route.cargoScore, 0)
        if (cargoScore < 4) return null
        const fallback = _num(opts && opts.fallbackPricePct, 100)
        const currentPct = _num(route && route.ownPricing
                                && route.ownPricing.prices
                                && route.ownPricing.prices.Cargo, fallback)
        const cargoComp = route && route.competitor   // shared with pax band today
        const hasBand = cargoComp && cargoComp.priceMin != null && cargoComp.priceMax != null
        let move = 0
        let reason = null
        if (cargoScore >= 7 && !hasBand) {
            move = -4
            reason = "cargoScore " + _round(cargoScore, 1)
                   + " · no competitor band → undercut to capture share"
        } else if (cargoScore >= 7 && hasBand) {
            const mid = (_num(cargoComp.priceMin, currentPct)
                       + _num(cargoComp.priceMax, currentPct)) / 2
            move = mid - currentPct
            reason = "cargoScore " + _round(cargoScore, 1)
                   + " · contested lane → match competitor mid " + _round(mid, 0) + "%"
        } else if (cargoScore >= 4 && hasBand) {
            const mid = (_num(cargoComp.priceMin, currentPct)
                       + _num(cargoComp.priceMax, currentPct)) / 2
            if (currentPct < mid - 2) {
                move = +2
                reason = "cargoScore " + _round(cargoScore, 1)
                       + " · room below competitor mid → nudge +2pp"
            }
        }
        // Dampen by profitWeight when we're proposing a discount — same
        // intuition as pax: profit-max users don't want surprise undercuts.
        if (move < 0 && weights.profitWeight > 0.5) move = move * 0.6
        return {move: move, currentPct: currentPct, reason: reason,
                cargoScore: cargoScore, hasBand: !!hasBand}
    }

    // Slice 9 — emit one move for a single class. Pure; takes the
    // pre-resolved weights, the per-class current pct, and the route's
    // band + congestion. Returns the move dict ready to push, or null
    // when the move falls under deadband/guardrails.
    function _classMove(route, classKey, currentPct, weights, opts, snapshot) {
        const deadband = _num(opts.deadband,         5)
        const maxMove  = _num(opts.maxMovePerWindow, 10)
        const target = _targetPct(route, weights, opts)
        let delta = target - currentPct
        if (Math.abs(delta) < deadband) return null
        const cong = _num(route.congestionIndex, 0)
        const damper = Math.max(0.4, 1 - 0.5 * cong)
        delta = delta * damper
        let move = Math.sign(delta) * Math.min(Math.abs(delta), maxMove)
        const guard = _competitorIncomeGuard(route, move, snapshot)
        if (guard.available && guard.damper < 1) move = move * guard.damper
        const elast = _elasticityHint(route, classKey, move)
        if (elast.available && elast.damper < 1) move = move * elast.damper
        // Phase B1 — crew-aware gating. When crew is critically short,
        // downward (demand-stimulating) price moves get dampened by
        // (1 − severity). Upward moves pass through untouched: they
        // reduce demand and so don't worsen the staffing crunch.
        const crewGuard = _crewPressureGuard(snapshot, move)
        if (crewGuard.available && crewGuard.damper < 1) move = move * crewGuard.damper
        if (Math.abs(move) < deadband) return null
        const toPct = _round(currentPct + move, 0)
        return {move: move, toPct: toPct, target: target, cong: cong, damper: damper,
                guard: guard, elast: elast, crewGuard: crewGuard, maxMove: maxMove}
    }

    /**
     * Phase B1 — crew-pressure gate. Reads `snapshot.crew.pressure` (built
     * by context.js#_deriveCrewPressure). When severity > 0.3 AND the
     * proposed move is downward (price cut → demand stimulus), scale by
     * (1 − severity) so we don't drive demand we can't staff. Upward
     * moves pass through.
     */
    function _crewPressureGuard(snapshot, move) {
        const pressure = snapshot && snapshot.crew && snapshot.crew.pressure
        if (!pressure || !isFinite(pressure.severity)) return {available: false}
        if (pressure.severity <= 0.3) return {available: true, damper: 1, severity: pressure.severity}
        if (move >= 0) return {available: true, damper: 1, severity: pressure.severity, direction: "up"}
        const damper = Math.max(0.2, 1 - pressure.severity)
        return {available: true, damper, severity: pressure.severity, direction: "down"}
    }

    function proposePriceMoves(snapshot, opts) {
        const o = opts || {}

        // Pricing Compass — single-route filter. Lets a caller compute the
        // moves for one (hub, dest) without solving the whole network. The
        // joint tuner gets the same flag so it skips its own per-route loop.
        const restrict = o.restrictTo
        const wantHub  = restrict && restrict.hub  ? String(restrict.hub).toUpperCase()  : null
        const wantDest = restrict && restrict.dest ? String(restrict.dest).toUpperCase() : null
        const inRestrict = (hub, dest) => {
            if (!wantHub && !wantDest) return true
            if (wantHub  && String(hub).toUpperCase()  !== wantHub)  return false
            if (wantDest && String(dest).toUpperCase() !== wantDest) return false
            return true
        }

        // Per-route price pin (manual override): when a route has
        // `override.pricePin` set, the auto path emits no moves for it.
        // Build the set up-front so both joint-tuner output and S1 loop
        // honour it without re-walking the snapshot.
        const pinned = new Set()
        for (const r of _flatten(snapshot)) {
            if (r && r.override && r.override.pricePin != null) {
                pinned.add(String(r.hub).toUpperCase() + "-" + String(r.dest).toUpperCase())
            }
        }
        const isPinned = (hub, dest) =>
            pinned.has(String(hub).toUpperCase() + "-" + String(dest).toUpperCase())

        // Velvet Cascade · PR 1A — prefer the joint rank-target tuner when
        // ORS data is in the snapshot. Falls through to the S1 competitor-
        // band heuristic when the tuner returns null (e.g. no ORS cache,
        // missing model module). The tuner's output already carries the
        // PriceMove shape this function returns, so we pass it through.
        // When restrictTo is set we bypass the snapshot's cached `_jointPlan`
        // (which holds the network-wide solve) and run a fresh single-route
        // tuner call so the returned moves match the caller's filter.
        if (typeof ns.tuneJointly === "function" && o.useJointTuner !== false) {
            const cached = (!wantHub && !wantDest) ? ((snapshot && snapshot._jointPlan) || null) : null
            const joint = cached || ns.tuneJointly(snapshot, {
                skipService: true,
                restrictTo:  restrict || null
            })
            if (joint && Array.isArray(joint.priceMoves) && joint.priceMoves.length) {
                if (snapshot && !cached && !wantHub && !wantDest) snapshot._jointPlan = joint
                const restrictFiltered = (wantHub || wantDest)
                    ? joint.priceMoves.filter(m => inRestrict(m.hub, m.dest))
                    : joint.priceMoves
                const filtered = pinned.size
                    ? restrictFiltered.filter(m => !isPinned(m.hub, m.dest))
                    : restrictFiltered
                if (filtered.length) return filtered
                // tuner returned moves but none matched the filter — fall
                // through to the S1 path below for this route.
            }
        }

        const fallbackPct   = _num(o.fallbackPricePct, 100)
        const includeCargo  = o.includeCargo !== false

        const moves = []
        for (const r of _flatten(snapshot)) {
            if (!inRestrict(r.hub, r.dest)) continue
            if (isPinned(r.hub, r.dest)) continue
            const resolved = _resolveWeights(snapshot, o, r.hub, r.dest)
            const w        = resolved.weights
            const profitPerWeek = _num(r.profitPerWeek, 0)
            const ownPrices = (r.ownPricing && r.ownPricing.prices) || null

            // Slice 9 — per-class iteration. When the route lacks
            // per-class own pricing data, fall back to a single Y move
            // anchored at the legacy override or fallbackPct.
            const classKeys = ownPrices
                ? ["Y", "C", "F"].filter(k => isFinite(_num(ownPrices[k], NaN)))
                : ["Y"]
            for (const cls of classKeys) {
                const currentPct = ownPrices ? _num(ownPrices[cls], fallbackPct)
                    : ((r.override && _num(r.override.yieldPerKm, NaN)) || fallbackPct)
                const m = _classMove(r, cls, currentPct, w, o, snapshot)
                if (!m) continue

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
                if (m.cong > 0) {
                    rationale.push("[congestion] index " + _round(m.cong, 2)
                        + " — move damped ×" + _round(m.damper, 2))
                }
                rationale.push("[" + cls + "] " + currentPct + "% → " + m.toPct + "% (cap ±" + m.maxMove + ")")
                if (Math.abs(m.target - currentPct) > m.maxMove) {
                    rationale.push("[guardrail] full target " + m.target + "% clipped to ±" + m.maxMove
                                + "pp — re-evaluate next window")
                }
                if (m.guard.available) {
                    if (m.guard.damper < 1) {
                        rationale.push("[anti-spiral] competitor income est ~$"
                            + Math.round(m.guard.estProfit) + "/wk below floor $"
                            + m.guard.floor + "/wk (confidence " + m.guard.confidence
                            + ") — downward move dampened ×" + m.guard.damper)
                    } else {
                        rationale.push("[anti-spiral] competitor income est ~$"
                            + Math.round(m.guard.estProfit) + "/wk (confidence " + m.guard.confidence
                            + ") — above floor $" + m.guard.floor + "/wk")
                    }
                } else {
                    rationale.push("[anti-spiral] competitor-income data unavailable — using legacy weights")
                }
                if (m.elast.available && m.elast.damper < 1) {
                    rationale.push("[elasticity] " + m.elast.samples
                        + " prior snapshots show same-direction price moves degraded rank — dampened ×"
                        + m.elast.damper + " (drift price " + _round(m.elast.priceDrift, 1)
                        + " / rank " + _round(m.elast.rankDrift, 1) + ")")
                } else if (m.elast.available) {
                    rationale.push("[elasticity] " + m.elast.samples
                        + " prior snapshots — no penalty (drift price "
                        + _round(m.elast.priceDrift, 1) + " / rank " + _round(m.elast.rankDrift, 1) + ")")
                }
                if (m.crewGuard && m.crewGuard.available && m.crewGuard.damper < 1) {
                    rationale.push("[crew-pressure] severity "
                        + _round(m.crewGuard.severity, 2)
                        + " — downward move dampened ×" + _round(m.crewGuard.damper, 2)
                        + " (avoid stimulating demand we can't staff)")
                }

                // Per-class impact weighting — Y carries most of the pax
                // P&L, so split 0.5 / 0.3 / 0.2 across Y / C / F.
                const impactWeight = cls === "Y" ? 0.5 : cls === "C" ? 0.3 : 0.2
                const impact = Math.round((m.move / 100) * profitPerWeek * impactWeight)
                moves.push({
                    hub:        r.hub,
                    dest:       r.dest,
                    classKey:   cls,
                    fromPct:    currentPct,
                    toPct:      m.toPct,
                    deltaPct:   m.move,
                    rationale:  rationale,
                    impactWeekly: impact,
                    profitPerWeek: profitPerWeek,
                    objective:  {kind: resolved.kind, weights: w}
                })
            }

            if (includeCargo) {
                const cargo = _cargoAsymmetric(r, w, o)
                if (cargo && Math.abs(cargo.move) >= _num(o.deadband, 5) / 2) {
                    const toPct = _round(cargo.currentPct + cargo.move, 0)
                    const cargoRationale = [
                        "[cargo asymmetric] " + cargo.reason,
                        "[Cargo] " + _round(cargo.currentPct, 0) + "% → " + toPct + "%"
                    ]
                    if (cargo.move < 0 && w.profitWeight > 0.5) {
                        cargoRationale.push("[goal] profit-tilted weights (" + _round(w.profitWeight, 2)
                            + ") dampened the discount ×0.6")
                    }
                    moves.push({
                        hub:        r.hub,
                        dest:       r.dest,
                        classKey:   "Cargo",
                        fromPct:    _round(cargo.currentPct, 0),
                        toPct:      toPct,
                        deltaPct:   cargo.move,
                        rationale:  cargoRationale,
                        impactWeekly: Math.round((cargo.move / 100) * profitPerWeek * 0.25),
                        profitPerWeek: profitPerWeek,
                        objective:  {kind: resolved.kind, weights: w}
                    })
                }
            }
        }

        return moves
    }

    ns.proposePriceMoves = proposePriceMoves

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Per-class S1 fallback — synthetic snapshot with no ORS data
            // (so joint-tuner short-circuit doesn't fire) but full per-class
            // ownPricing + competitor band.
            const snap = {
                hubs: [{iata: "FRA", byRoute: [{
                    dest: "LHR", profitPerWeek: 100000,
                    competitor: {priceMin: 90, priceMax: 110, dominantCarrier: "BA"},
                    // Each class above the balanced-objective target (~97%)
                    // by enough to clear deadband, so all three emit.
                    ownPricing: {prices: {Y: 130, C: 120, F: 115, Cargo: 130}},
                    cargoScore: 8
                }]}]
            }
            const movesAll = proposePriceMoves(snap, {useJointTuner: false,
                objective: {kind: "balanced"}})
            const cls = new Set(movesAll.map(m => m.classKey))
            console.assert(cls.has("Y") && cls.has("C") && cls.has("F"),
                "[smoke s9] per-class S1 emits Y, C, and F moves")
            console.assert(cls.has("Cargo"),
                "[smoke s9] cargo asymmetric emits independent move when cargoScore high")

            // Cargo direction independent of pax: build a route where pax
            // would move down (profit-tilt + competitor band) but cargo is
            // a high-score lane with no competitor band → undercut +4pp.
            const noBandSnap = {
                hubs: [{iata: "FRA", byRoute: [{
                    dest: "JFK", profitPerWeek: 50000,
                    competitor: null,                            // pax: no band
                    ownPricing: {prices: {Y: 100, C: 100, F: 100, Cargo: 100}},
                    cargoScore: 8
                }]}]
            }
            const movesCargo = proposePriceMoves(noBandSnap, {useJointTuner: false,
                objective: {kind: "balanced"}})
            const cargo = movesCargo.find(m => m.classKey === "Cargo")
            console.assert(cargo && cargo.deltaPct < 0,
                "[smoke s9] cargo undercuts when score high + no band")
            console.assert(cargo && /undercut to capture share/.test(cargo.rationale.join(" ")),
                "[smoke s9] cargo rationale explains the undercut")

            // Elasticity hint — three snapshots of price climbing while
            // rank degrades. Same-direction upward intent should dampen.
            const elastSnap = {
                hubs: [{iata: "FRA", byRoute: [{
                    dest: "MUC", profitPerWeek: 80000,
                    competitor: {priceMin: 95, priceMax: 130},     // wide band → big upward move available
                    ownPricing: {prices: {Y: 100, C: 100, F: 100}},
                    cargoScore: 0,
                    orsHistory: [
                        {scrapedAt: 1000, byClass: {Y: {rankAny: 2}}, context: {priceY: 95}},
                        {scrapedAt: 2000, byClass: {Y: {rankAny: 3}}, context: {priceY: 100}},
                        {scrapedAt: 3000, byClass: {Y: {rankAny: 5}}, context: {priceY: 105}}
                    ]
                }]}]
            }
            const movesElast = proposePriceMoves(elastSnap, {useJointTuner: false,
                objective: {kind: "maxProfit"}})    // pushes upward
            const yMove = movesElast.find(m => m.classKey === "Y")
            console.assert(yMove && /\[elasticity\]/.test(yMove.rationale.join(" ")),
                "[smoke s9] elasticity rationale present when orsHistory has ≥3 samples")
            console.assert(yMove && /degraded rank/.test(yMove.rationale.join(" ")),
                "[smoke s9] elasticity flags degraded-rank case for upward moves")

            // Pricing Compass — single-route filter on the S1 fallback. Two
            // routes in the snapshot, restrictTo names one; every returned
            // move must match that hub/dest.
            const restrictSnap = {
                hubs: [{iata: "FRA", byRoute: [
                    {dest: "LHR", profitPerWeek: 100000,
                     competitor: {priceMin: 90, priceMax: 110},
                     ownPricing: {prices: {Y: 130}}, cargoScore: 0},
                    {dest: "CDG", profitPerWeek: 100000,
                     competitor: {priceMin: 90, priceMax: 110},
                     ownPricing: {prices: {Y: 130}}, cargoScore: 0}
                ]}]
            }
            const restrictMoves = proposePriceMoves(restrictSnap, {
                useJointTuner: false,
                restrictTo:    {hub: "FRA", dest: "LHR"},
                objective:     {kind: "balanced"}
            })
            console.assert(restrictMoves.length > 0,
                "[smoke compass] restrictTo still emits moves for the named route")
            console.assert(restrictMoves.every(m => m.hub === "FRA" && m.dest === "LHR"),
                "[smoke compass] restrictTo filters S1 fallback to one route only")

            // Demand tilt — high paxScore lifts toPct above competitor mid;
            // low paxScore drops it below mid. Same competitor band, same
            // current price, different paxScore → opposite move directions.
            const demandSnapHi = {
                hubs: [{iata: "FRA", byRoute: [{
                    dest: "AMS", profitPerWeek: 50000,
                    competitor: {priceMin: 95, priceMax: 105},
                    ownPricing: {prices: {Y: 100}}, cargoScore: 0,
                    paxScore: 9
                }]}]
            }
            const demandSnapLo = {
                hubs: [{iata: "FRA", byRoute: [{
                    dest: "AMS", profitPerWeek: 50000,
                    competitor: {priceMin: 95, priceMax: 105},
                    ownPricing: {prices: {Y: 100}}, cargoScore: 0,
                    paxScore: 2
                }]}]
            }
            const hi = proposePriceMoves(demandSnapHi, {useJointTuner: false,
                deadband: 2,
                objective: {kind: "balanced"}}).find(m => m.classKey === "Y")
            const lo = proposePriceMoves(demandSnapLo, {useJointTuner: false,
                deadband: 2,
                objective: {kind: "balanced"}}).find(m => m.classKey === "Y")
            console.assert(hi && hi.toPct >= 100,
                "[smoke demand] high paxScore raises toPct to/above parity")
            console.assert(lo && lo.toPct <= 100,
                "[smoke demand] low paxScore drops toPct to/below parity")
            console.assert(hi && lo && hi.toPct > lo.toPct,
                "[smoke demand] high-pax toPct strictly greater than low-pax toPct")

            // Pin skip — pricePin set on a route → no moves emitted.
            const pinSnap = {
                hubs: [{iata: "FRA", byRoute: [{
                    dest: "LHR", profitPerWeek: 100000,
                    competitor: {priceMin: 90, priceMax: 110},
                    ownPricing: {prices: {Y: 130, C: 120, F: 115}},
                    cargoScore: 0,
                    override: {pricePin: 105}
                }]}]
            }
            const pinMoves = proposePriceMoves(pinSnap, {useJointTuner: false,
                objective: {kind: "balanced"}})
            console.assert(pinMoves.length === 0,
                "[smoke pin] pricePin suppresses all moves for that route")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
