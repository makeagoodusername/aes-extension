"use strict"

/**
 * AES Strategy — Pricing Compass (compute).
 *
 * Per-route view that resolves the strategy chain (global goal → per-route
 * override → risk profile clamps), runs the existing proposer/solver, and
 * derives an "advantageous price range" plus the supporting signals.
 *
 * Pure compute — no DOM. The render module
 * `modules/route-assistant/view-compass.js` consumes the envelope.
 *
 * Public API:
 *   AesPricingCompass.computeForRoute({snapshot?, hub, dest, settings?})
 *     → CompassEnvelope | null
 *
 * The function reuses every existing proposer mechanic:
 *   - AesStrategyObjective.resolveForRoute  for the goal triple
 *   - AesStrategyRiskProfiles.detect         for the active clamp
 *   - AesStrategy.tuneJointly                solver path (when ORS data)
 *   - AesStrategy.proposePriceMoves          S1 fallback path
 *
 * Range model (hybrid, locked this slice):
 *   - solver path: take the contiguous neighbourhood of fineEvaluations
 *     within RANGE_TOL of the optimum J; widen to ±deadband if narrower.
 *   - fallback:    [target − maxMove/2, target + maxMove/2], clipped by
 *                  the actual max move per window from the route's risk
 *                  profile, then [70, 150] hard floor/ceiling.
 *
 * Returns null when snapshot is unusable or hub/dest aren't in it; the
 * UI renders a "snapshot missing" banner from that.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesPricingCompass) return

    const RANGE_TOL = 0.05  // solver path: range = J within 5% of optimum
    const HARD_LO   = 70
    const HARD_HI   = 150

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }
    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }
    function _upper(s) { return String(s == null ? "" : s).toUpperCase() }
    function _now() { return Date.now() }

    /**
     * Locate a route in the snapshot. Returns {hub, route} or null.
     */
    function _findRoute(snapshot, hub, dest) {
        const wantHub  = _upper(hub)
        const wantDest = _upper(dest)
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) {
            if (_upper(h && h.iata) !== wantHub) continue
            for (const r of (h.byRoute) || []) {
                if (_upper(r && r.dest) === wantDest) return {hub: h.iata, route: r}
            }
        }
        return null
    }

    /**
     * Resolve the active objective for this route. Source flag tells the
     * UI whether the user picked it for this route specifically, inherited
     * from global, or fell back to the package default.
     */
    function _resolveObjective(snapshot, hub, dest) {
        const O = window.AesStrategyObjective
        if (O && typeof O.resolveForRoute === "function") {
            const map = (snapshot && snapshot.routeObjectives) || null
            const k = _upper(hub) + "-" + _upper(dest)
            const hasPerRoute = map
                && ((typeof map.get === "function") ? map.get(k) : map[k])
            const r = O.resolveForRoute(snapshot, hub, dest)
            const source = hasPerRoute ? "per-route"
                : (snapshot && snapshot.strategySettings
                   && snapshot.strategySettings.objective
                   && snapshot.strategySettings.objective.kind)
                    ? "global" : "default"
            return Object.assign({source: source}, r)
        }
        return {kind: "balanced",
                weights: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2},
                source: "default"}
    }

    /**
     * Read clamp values from settings + risk profile. The proposer reads
     * these via `opts.deadband` / `opts.maxMovePerWindow`; we mirror the
     * defaults that price-moves.js falls back to when opts are unset.
     */
    function _resolveRiskProfile(settings) {
        const RP = window.AesStrategyRiskProfiles
        const name = (RP && typeof RP.detect === "function") ? RP.detect(settings) : "custom"
        // The proposer hardcodes deadband=5 / maxMove=10 when opts unset
        // (price-moves.js:293-294). When the user has set explicit values
        // through risk-profile apply, those land on top-level settings.
        const deadband  = _num(settings && settings.priceDeadband,         5)
        const maxMove   = _num(settings && settings.maxPriceMovePerWindow, 10)
        const econ      = (settings && settings.economics) || {}
        const floor     = _num(econ.competitorIncomeFloorWeekly, 5000)
        return {name: name, deadbandPct: deadband, maxMovePerWindowPct: maxMove,
                profitFloor: floor}
    }

    /**
     * Surface the per-route signals the UI shows in its tile strip. All
     * fields nullable — render module displays "missing" placeholders.
     */
    function _collectSignals(route) {
        if (!route) {
            return {competitorBand: null, ownPricing: null, ors: null,
                    congestion: null, demand: null, competitorIncome: null,
                    elasticity: null, cacheAges: null}
        }
        const c = route.competitor || null
        const competitorBand = (c && c.priceMin != null && c.priceMax != null) ? {
            priceMin:        _num(c.priceMin, null),
            priceMax:        _num(c.priceMax, null),
            dominantCarrier: c.dominantCarrier || null,
            flightCount:     _num(c.flightCount, null),
            seatCount:       _num(c.seatCount, null),
            scrapedAt:       _num(c.scrapedAt, null)
        } : null
        const ownPricing = (route.ownPricing && route.ownPricing.prices) ? {
            Y:         _num(route.ownPricing.prices.Y, null),
            C:         _num(route.ownPricing.prices.C, null),
            F:         _num(route.ownPricing.prices.F, null),
            Cargo:     _num(route.ownPricing.prices.Cargo, null),
            scrapedAt: _num(route.ownPricing.scrapedAt, null)
        } : null
        const ors = route.orsByClass ? {
            byClass:   route.orsByClass,
            rankAny:   _num(route.orsByClass && route.orsByClass.rankAny, null),
            scrapedAt: _num(route.orsScrapedAt, null)
        } : null
        const congestion = isFinite(route.congestionIndex) ? {
            index:           _num(route.congestionIndex, null),
            operatorCount:   _num(route.operatorCount, null),
            ourFreqShare:    _num(route.ourFreqShare, null)
        } : null
        const demand = (route.paxScore != null || route.cargoScore != null) ? {
            paxScore:   _num(route.paxScore, null),
            cargoScore: _num(route.cargoScore, null),
            scrapedAt:  _num(route.demandScrapedAt, null)
        } : null
        return {
            competitorBand: competitorBand,
            ownPricing:     ownPricing,
            ors:            ors,
            congestion:     congestion,
            demand:         demand,
            competitorIncome: null,           // attached post-proposer (rationale-derived)
            elasticity:       null,           // attached post-proposer
            cacheAges:        route.cacheAge || null
        }
    }

    /**
     * Build the per-class entry from a single price-move. Range derivation
     * differs by source — solver path has a fineEvaluations grid, S1 path
     * doesn't, so we emit a synthetic ±maxMove/2 window in that case.
     */
    function _buildClassEntry(move, source, currentPct, risk, solverGrid) {
        const target = _num(move.toPct, currentPct)
        let rangeLo, rangeHi
        if (source === "joint-tuner" && solverGrid && Array.isArray(solverGrid.fineEvaluations)) {
            const evals = solverGrid.fineEvaluations.slice()
                .filter(e => e && isFinite(e.J))
                .sort((a, b) => b.J - a.J)
            if (evals.length) {
                const optJ = evals[0].J
                const tolJ = optJ - Math.abs(optJ) * RANGE_TOL
                const within = evals.filter(e => e.J >= tolJ && isFinite(e.priceY))
                if (within.length) {
                    let lo = Infinity, hi = -Infinity
                    for (const e of within) {
                        const px = _num(e.priceY, null)
                        if (px == null) continue
                        if (px < lo) lo = px
                        if (px > hi) hi = px
                    }
                    if (isFinite(lo) && isFinite(hi)) {
                        rangeLo = _round(lo, 0)
                        rangeHi = _round(hi, 0)
                    }
                }
            }
        }
        if (rangeLo == null || rangeHi == null) {
            const half = Math.max(1, Math.round((risk.maxMovePerWindowPct || 10) / 2))
            rangeLo = target - half
            rangeHi = target + half
        }
        if (rangeHi - rangeLo < risk.deadbandPct) {
            const mid = (rangeLo + rangeHi) / 2
            rangeLo = Math.round(mid - risk.deadbandPct / 2)
            rangeHi = Math.round(mid + risk.deadbandPct / 2)
        }
        rangeLo = Math.max(HARD_LO, Math.min(HARD_HI, rangeLo))
        rangeHi = Math.max(HARD_LO, Math.min(HARD_HI, rangeHi))
        return {
            currentPct: _num(currentPct, target),
            targetPct:  target,
            deltaPct:   _num(move.deltaPct, target - currentPct),
            rangeLoPct: rangeLo,
            rangeHiPct: rangeHi,
            rationale:  Array.isArray(move.rationale) ? move.rationale.slice() : [],
            impactWeekly: _num(move.impactWeekly, null),
            objective:  move.objective || null,
            source:     source
        }
    }

    /**
     * Run the proposer for one route. Returns:
     *   {moves, source}     where source ∈ {"joint-tuner", "s1-fallback"}
     *
     * The proposer's restrictTo opt scopes the work to a single route so
     * we don't pay the network-wide solve cost on every compass open.
     */
    function _runProposer(snapshot, hub, dest) {
        const ns = window.AesStrategy
        if (!ns || typeof ns.proposePriceMoves !== "function") {
            return {moves: [], source: "s1-fallback", solver: null}
        }
        const restrict = {hub: hub, dest: dest}
        // Try the joint tuner first (solver path).
        let solverInfo = null
        let solverMoves = []
        if (typeof ns.tuneJointly === "function") {
            try {
                const joint = ns.tuneJointly(snapshot, {
                    skipService: true,
                    restrictTo:  restrict
                })
                if (joint && Array.isArray(joint.priceMoves) && joint.priceMoves.length) {
                    solverMoves = joint.priceMoves.filter(m =>
                        _upper(m.hub) === _upper(hub) && _upper(m.dest) === _upper(dest))
                    if (solverMoves.length) {
                        const first = solverMoves[0]
                        solverInfo = first._solver || null
                    }
                }
            } catch (_) { /* fall through to S1 */ }
        }
        if (solverMoves.length) {
            return {moves: solverMoves, source: "joint-tuner", solver: solverInfo}
        }
        // S1 fallback — explicitly disable the joint tuner so we get the
        // competitor-band heuristic moves even when the snapshot has ORS.
        let s1Moves = []
        try {
            s1Moves = ns.proposePriceMoves(snapshot, {
                useJointTuner: false,
                restrictTo:    restrict
            }) || []
        } catch (_) { s1Moves = [] }
        return {moves: s1Moves, source: "s1-fallback", solver: null}
    }

    /**
     * Health blockers — the most useful "fix me" hints for the user. The
     * UI renders these at the top of the compass with deep-links.
     */
    function _buildHealth(signals) {
        const blockers = []
        if (!signals.competitorBand) blockers.push("no competitor band cached")
        if (!signals.ownPricing)     blockers.push("no own-price cached")
        if (!signals.ors)            blockers.push("no ORS data cached")
        return {
            hasCompetitorBand: !!signals.competitorBand,
            hasOwnPricing:     !!signals.ownPricing,
            hasOrs:            !!signals.ors,
            hasDemand:         !!signals.demand,
            blockers:          blockers
        }
    }

    /**
     * Public API. Synchronous when caller supplies a snapshot; takes a
     * snapshot lazily otherwise.
     */
    async function computeForRoute(input) {
        const i = input || {}
        const hub  = i.hub
        const dest = i.dest
        if (!hub || !dest) return null

        let snapshot = i.snapshot || null
        if (!snapshot) {
            const ns = window.AesStrategy
            if (!ns || typeof ns.snapshot !== "function") return null
            try { snapshot = await ns.snapshot({}) } catch (_) { return null }
        }
        if (!snapshot) return null

        const located = _findRoute(snapshot, hub, dest)
        const route   = located ? located.route : null
        const settings = i.settings
            || (snapshot && snapshot.settings)
            || (snapshot && snapshot.strategySettings)
            || {}

        const resolvedObjective = _resolveObjective(snapshot, hub, dest)
        const riskProfile        = _resolveRiskProfile(settings)
        const signals            = _collectSignals(route)
        const health             = _buildHealth(signals)

        const perClass = {Y: null, C: null, F: null, Cargo: null}
        let solverEnvelope = null

        if (route) {
            const out = _runProposer(snapshot, hub, dest)
            if (out.source === "joint-tuner" && out.solver) {
                solverEnvelope = {
                    available:             true,
                    projectedShare:        out.solver.projectedShare,
                    baselineShare:         out.solver.baselineShare,
                    projectedRankAny:      out.solver.projectedRankAny,
                    projectedProfitWeekly: out.solver.projectedProfitWeekly,
                    comfortDeltaApplied:   out.solver.comfortDeltaApplied,
                    grid:                  out.solver.grid || null
                }
            }
            const ownPrices = (route.ownPricing && route.ownPricing.prices) || {}
            for (const m of out.moves) {
                const cls = m.classKey || "Y"
                const currentPct = _num(m.fromPct,
                    _num(ownPrices[cls], 100))
                const grid = solverEnvelope && solverEnvelope.grid || null
                const entry = _buildClassEntry(m, out.source, currentPct, riskProfile, grid)
                if (perClass.hasOwnProperty(cls)) perClass[cls] = entry

                // Mine the rationale strings for the anti-spiral / elasticity
                // info so the signals strip can display them without re-
                // computing. Cheap string match — the proposer's strings
                // are stable enough for v1.
                for (const r of entry.rationale) {
                    if (!signals.competitorIncome
                        && /\[anti-spiral\] competitor income/.test(r)) {
                        const profitMatch = /est ~\$(-?\d[\d,]*)/.exec(r)
                        const floorMatch  = /floor \$(\d[\d,]*)/.exec(r)
                        const confMatch   = /confidence ([a-z]+)/.exec(r)
                        signals.competitorIncome = {
                            estProfitPerWeek: profitMatch ? Number(profitMatch[1].replace(/,/g, "")) : null,
                            floor:            floorMatch  ? Number(floorMatch[1].replace(/,/g, ""))  : null,
                            confidence:       confMatch   ? confMatch[1] : null,
                            available:        true,
                            damped:           /dampened/.test(r)
                        }
                    }
                    if (!signals.elasticity && /\[elasticity\]/.test(r)) {
                        const sampMatch = /(\d+) prior snapshots/.exec(r)
                        signals.elasticity = {
                            available: true,
                            samples:   sampMatch ? Number(sampMatch[1]) : null,
                            damped:    /dampened/.test(r)
                        }
                    }
                }
            }
        }

        // Phase C3 — surface cross-feature gating reasons so the route view
        // can render "gated by crew pressure" / "gated by cash runway"
        // callouts inline next to suppressed moves.
        const gates = _buildGates(snapshot)

        return {
            hub:         _upper(hub),
            dest:        _upper(dest),
            accountId:   (snapshot && snapshot.accountId) || null,
            server:      (snapshot && snapshot.server)    || null,
            airlineCode: (snapshot && snapshot.airlineCode) || null,
            resolvedObjective: resolvedObjective,
            riskProfile: riskProfile,
            signals:     signals,
            gates:       gates,
            perClass:    perClass,
            solver:      solverEnvelope,
            health:      health,
            composedAt:  _now()
        }
    }

    /**
     * Phase C3 — assemble cross-feature gates from the snapshot. Returns
     * an object with present-only entries; the renderer iterates entries
     * and shows a callout per active gate. Empty when nothing is gating.
     */
    function _buildGates(snapshot) {
        if (!snapshot) return {}
        const out = {}
        const pressure = snapshot.crew && snapshot.crew.pressure
        if (pressure && isFinite(pressure.severity) && pressure.severity > 0.3) {
            out.crewPressure = {
                severity:           pressure.severity,
                worstShortfallPct:  pressure.worstShortfallPct || null,
                shortPositions:     Array.isArray(pressure.shortPositions)
                    ? pressure.shortPositions.slice(0, 4) : [],
                effect: "Downward (demand-stimulating) price moves dampened to avoid stimulating demand we can't staff."
            }
        }
        const runway = snapshot.cash && snapshot.cash.runwayWeeks
        if (Number.isFinite(runway) && runway < 8) {
            out.cashLow = {
                runwayWeeks:  runway,
                bankBalance:  snapshot.cash.bankBalance || null,
                weeklyResult: snapshot.cash.weeklyResult || null,
                effect: "Route-creation candidates vetoed and aggressive moves de-prioritised until runway recovers."
            }
        }
        return out
    }

    window.AesPricingCompass = {
        computeForRoute: computeForRoute,
        // Exposed for the render module's range-axis helper. Kept as a
        // getter so a future change to RANGE_TOL doesn't drift between
        // compute and render.
        RANGE_TOL: RANGE_TOL,
        HARD_LO:   HARD_LO,
        HARD_HI:   HARD_HI
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Smoke 1 — null inputs return null cleanly.
            (async () => {
                const r = await computeForRoute({hub: null, dest: null})
                console.assert(r === null, "[smoke compass] null hub/dest → null envelope")
            })()

            // Smoke 2 — synthetic snapshot with competitor band but no
            // proposer in scope still emits the envelope shape with empty
            // perClass and a health blocker.
            ;(async () => {
                const snap = {
                    hubs: [{iata: "FRA", byRoute: [{
                        dest: "JFK",
                        competitor: {priceMin: 90, priceMax: 110, scrapedAt: Date.now()},
                        ownPricing: {prices: {Y: 110, C: 105, F: 100, Cargo: 100},
                                     scrapedAt: Date.now()},
                        congestionIndex: 0.3,
                        paxScore: 6, cargoScore: 4
                    }]}],
                    accountId: "smoke", server: "test",
                    strategySettings: {objective: {kind: "balanced"}}
                }
                const env = await computeForRoute({snapshot: snap, hub: "FRA", dest: "JFK"})
                console.assert(env && env.hub === "FRA" && env.dest === "JFK",
                    "[smoke compass] envelope echoes hub/dest")
                console.assert(env && env.signals && env.signals.competitorBand
                    && env.signals.competitorBand.priceMin === 90,
                    "[smoke compass] competitor band surfaced")
                console.assert(env && env.resolvedObjective.kind === "balanced",
                    "[smoke compass] global objective resolved")
                console.assert(env && env.resolvedObjective.source === "global",
                    "[smoke compass] source=global when no per-route override")
                console.assert(env && env.signals.ors === null,
                    "[smoke compass] no ORS on this snapshot")
                console.assert(env && Array.isArray(env.health.blockers)
                    && env.health.blockers.indexOf("no ORS data cached") >= 0,
                    "[smoke compass] missing ORS surfaces as blocker")
            })()

            // Smoke 3 — per-route override → source="per-route".
            ;(async () => {
                const snap = {
                    hubs: [{iata: "FRA", byRoute: [{dest: "LHR",
                        competitor: {priceMin: 90, priceMax: 110},
                        ownPricing: {prices: {Y: 100}}}]}],
                    routeObjectives: new Map([["FRA-LHR", {kind: "maxShare"}]]),
                    strategySettings: {objective: {kind: "balanced"}}
                }
                const env = await computeForRoute({snapshot: snap, hub: "FRA", dest: "LHR"})
                console.assert(env && env.resolvedObjective.kind === "maxShare",
                    "[smoke compass] per-route override beats global")
                console.assert(env && env.resolvedObjective.source === "per-route",
                    "[smoke compass] source=per-route flag set")
            })()

            // Smoke 4 — risk profile clamps surfaced.
            ;(async () => {
                const snap = {hubs: [], strategySettings: {}}
                const env = await computeForRoute({
                    snapshot: snap, hub: "X", dest: "Y",
                    settings: {riskProfile: "aggressive",
                               maxPriceMovePerWindow: 15, priceDeadband: 3}
                })
                console.assert(env && env.riskProfile.deadbandPct === 3
                    && env.riskProfile.maxMovePerWindowPct === 15,
                    "[smoke compass] risk-profile clamps surfaced")
            })()
        }
    } catch (_) { /* smoke must never break the page */ }
})()
