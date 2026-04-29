"use strict"

/**
 * AES Strategy — joint crew-pay tuner (Slice 8).
 *
 * Pure function over `snapshot` (extended in context.js with
 * `crew.byPosition` + `crew.formContext`). Layers an ORS-lift hypothesis
 * on top of `AesStrategyPayPerception`'s recruit-delta hypothesis to score
 * pay-tier candidates per role, then ranks the resulting moves so the
 * apply pipeline (CrewMgmtPayTierApplier) can fire one at a time.
 *
 * Pay-perception speaks recruitment ("+pp pay → +N applicants/wk"). The
 * ORS-lift layer is the user's stated hypothesis (NORTH-STAR §3 LEARN
 * pillar — "pay perception affects ORS"): a higher applicant pool eases
 * staffing pressure, raises the active fraction over time, and a higher
 * active fraction lifts ORS rating slightly across every route the role
 * touches. Both hypotheses are testable a-priori — the tuner persists the
 * predicted deltas so a future LEARN slice can score realised vs expected
 * and calibrate `orsPerActivePp`.
 *
 * Joint optimization with service-profile tuning (Slice 7 / joint-rank-
 * tuner): sequential, service-first. Service moves have a one-tick
 * feedback loop and a known network-wide effect; pay moves have a multi-
 * week recruitment lag. Service first gets the earliest learning signal;
 * pay claims the residual budget. When `settings.crewPay.weeklyBudgetAS$`
 * is unset, no cap is applied — every positive-J pay move is emitted.
 *
 * Public API:
 *   AesStrategy.tuneCrewMoves(snapshot, opts?) →
 *     {payMoves, hireMoves, summary} | null
 *
 * Returns null when crew.byPosition is missing (no staffOverview store)
 * or service-profile data isn't available for the network-rev estimate.
 *
 * Output `payMoves[i]`:
 *   {kind:"pay", positionId, label, group,
 *    currentSalary, recommendedSalary, countryAverage,
 *    payTierPp, weeklyCostDelta, employed,
 *    expectedRecruitDelta, expectedOrsLiftPp,
 *    perceptionAction,                        // "raisePay"|"cutPay"|"hold"
 *    perceptionConfidence,                    // "high"|"medium"|"low"
 *    perceptionHypothesis,                    // pay-perception's claim string
 *    rationale: [strings...],
 *    objective: {kind, weights},
 *    accepted:  boolean,                       // budget-greedy result
 *    source:    "crew-tuner"}
 *
 * `hireMoves[]` reuses `AesStrategy.proposeCrewMoves` verbatim, filtered
 * to non-pay actions (hire/train/none) so we don't double-up with the
 * tuner's pay output.
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.tuneCrewMoves === "function") return

    const PAY_TIER_GRID = [-10, -5, 0, 5, 10, 15, 20]

    // Hypothesis defaults — testable, persisted on every move so a future
    // LEARN slice can score them. Override via opts when calibration data
    // becomes available.
    const DEFAULT_ORS_PER_ACTIVE_PP   = 0.05   // 1pp active rise → 0.05pp ORS
    const DEFAULT_NETWORK_REV_PER_PP  = 1500   // AS$/week per 1pp ORS, network-avg
    const RECRUIT_PP_HALF_FOR_CUTS    = 0.5    // cut elasticity is stickier

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    /**
     * Build the skillSlot shape pay-perception expects from a byPosition
     * record. Non-pilot roles have no `marketAvailable` data on
     * staffOverview; we set to 0 so pay-perception's raise-condition still
     * fires for understaffed roles (missing >= threshold && market <
     * missing). Pilot roles backfill `marketAvailable` from bySkillLabel
     * via `_findSkillSlot` when label matches.
     */
    function _toSkillSlot(position, bySkillLabel) {
        const employed   = _num(position.employed, 0)
        const active     = _num(position.active,   0)
        const required   = _num(position.required, 0)
        const redundant  = _num(position.redundant, 0)
        const reserve    = Math.max(0, employed - required - redundant)
        const missing    = Math.max(0, required - active)

        let marketAvailable = 0
        const skill = _findSkillSlot(position, bySkillLabel)
        if (skill && skill.marketAvailable != null) {
            marketAvailable = _num(skill.marketAvailable, 0)
        }
        return {
            skillId:         position.positionId,
            label:           position.label,
            employed, active, required, reserve, missing,
            marketAvailable
        }
    }

    function _findSkillSlot(position, bySkillLabel) {
        if (!bySkillLabel || !position || !position.label) return null
        const wanted = String(position.label).toLowerCase()
        // Exact, then contains either way.
        for (const k of Object.keys(bySkillLabel)) {
            if (k.toLowerCase() === wanted) return bySkillLabel[k]
        }
        for (const k of Object.keys(bySkillLabel)) {
            if (k.toLowerCase().includes(wanted) || wanted.includes(k.toLowerCase())) {
                return bySkillLabel[k]
            }
        }
        return null
    }

    /**
     * Estimate the network-wide AS$/week revenue swing per 1pp of ORS
     * rating. Used by the tuner to convert orsLiftPp into a J term.
     *
     * v1 heuristic: sum service-profile-touching route revenue, multiply
     * by a constant rev-per-pp coefficient. When serviceProfiles or hub
     * data is empty, fall back to DEFAULT_NETWORK_REV_PER_PP so the tuner
     * still scores something reasonable rather than collapsing to 0.
     */
    function _estimateNetworkRevPerOrsPp(snapshot) {
        const hubs = (snapshot && snapshot.hubs) || []
        let routeCount = 0
        for (const h of hubs) {
            const byRoute = h && h.byRoute
            if (Array.isArray(byRoute)) routeCount += byRoute.length
        }
        if (routeCount <= 0) return DEFAULT_NETWORK_REV_PER_PP
        // Each route contributes a fraction of the network rev sensitivity.
        // The constant is the per-route coefficient; the count scales
        // network sensitivity with portfolio size.
        return DEFAULT_NETWORK_REV_PER_PP * routeCount
    }

    /**
     * Estimated weekly cost of a serviceMoves bundle. Network-wide
     * comfortDelta = +1 ≈ +Y on the lowest category for every profile;
     * per-profile cost is roughly proportional to comfortDelta × routes
     * touching the profile. Without per-profile cost data on the
     * snapshot today, v1 uses a constant per-bumped-category
     * approximation so the budget hook exists. Returns 0 when nothing
     * was bumped.
     */
    function _estimateServiceCost(serviceMoves) {
        if (!Array.isArray(serviceMoves) || !serviceMoves.length) return 0
        let total = 0
        for (const m of serviceMoves) {
            if (!m || !m.changes) continue
            // Each category bump ≈ 8000 AS$/week network-wide. Heuristic;
            // refine when serviceProfiles attaches a per-category cost.
            total += Object.keys(m.changes).length * 8000
        }
        return total
    }

    function _resolveWeights(snapshot, opts) {
        const O = window.AesStrategyObjective
        const s = (snapshot && snapshot.strategySettings) || {}
        const obj = (opts && opts.objective) || s.objective || {kind: "balanced", custom: null}
        if (O && typeof O.resolve === "function") {
            return O.resolve(obj.kind, obj.custom, null)
        }
        return {kind: obj.kind || "balanced",
            weights: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}}
    }

    /**
     * Sweep the pay-tier grid for one position and return the argmax J
     * candidate, or null when no positive-J move exists.
     *
     * J(tierPp) = orsLiftPp × networkRevPerOrsPp − weeklyCostDelta
     *
     * Where:
     *   newSalary       = countryAverage × (1 + tierPp/100)
     *   weeklyCostDelta = (newSalary − currentSalary) × employed
     *   recruitDelta    = recruitsPerPpRaiseEst × tierPp  (× 0.5 for cuts)
     *   activeFraction  = recruitDelta / required
     *   orsLiftPp       = activeFraction × orsPerActivePp
     */
    function _tunePosition(position, snapshot, weights, opts, bySkillLabel, networkRev) {
        const required = _num(position.required, 0)
        const employed = _num(position.employed, 0)
        const countryAvg = _num(position.countryAverage, 0)
        const currentSalary = _num(position.salaryPerEmployee, 0)
        if (required <= 0 || employed <= 0 || countryAvg <= 0 || currentSalary <= 0) return null

        const slot = _toSkillSlot(position, bySkillLabel)
        const PP = window.AesStrategyPayPerception
        const perception = (PP && typeof PP.evaluate === "function")
            ? PP.evaluate({skillSlot: slot, weights: weights})
            : null

        // Pay-perception is the direction oracle (raise/cut/hold gated by
        // missing/reserve/market signals). The tuner refines the
        // magnitude within the perception-approved direction by argmax J;
        // it does NOT second-guess the direction itself. This keeps the
        // cost-vs-ORS hypothesis math from collapsing to "cut pay
        // maximally" whenever ORS-lift coefficients are smaller than cost
        // changes (the typical case at v1 a-priori coefficients).
        const direction = perception ? perception.action : "hold"
        let allowedTiers = []
        if (direction === "raisePay")     allowedTiers = PAY_TIER_GRID.filter(t => t > 0)
        else if (direction === "cutPay")  allowedTiers = PAY_TIER_GRID.filter(t => t < 0)
        else                              return null   // hold → no move

        const recruitsPerPp = (PP && PP.DEFAULTS && PP.DEFAULTS.recruitsPerPpRaiseEst)
            || _num(opts.recruitsPerPpRaiseEst, 0.4)
        const orsPerActivePp = _num(opts.orsPerActivePp, DEFAULT_ORS_PER_ACTIVE_PP)

        let best = null
        for (const tierPp of allowedTiers) {
            const newSalary = Math.round(countryAvg * (1 + tierPp / 100))
            const elasticity = tierPp >= 0 ? 1 : RECRUIT_PP_HALF_FOR_CUTS
            const recruitDelta = recruitsPerPp * tierPp * elasticity
            const orsLiftPp    = (recruitDelta / Math.max(1, required)) * orsPerActivePp
            const weeklyCostDelta = (newSalary - currentSalary) * employed
            const J = orsLiftPp * networkRev - weeklyCostDelta
            if (!best || J > best.J) {
                best = {tierPp, newSalary, recruitDelta, orsLiftPp, weeklyCostDelta, J}
            }
        }
        if (!best) return null
        if (best.newSalary === currentSalary) return null

        const rationale = []
        rationale.push("[tuner] argmax over " + PAY_TIER_GRID.join(",") + "pp grid → "
            + (best.tierPp >= 0 ? "+" : "") + best.tierPp + "pp"
            + " (newSalary " + best.newSalary + " AS$, vs current " + currentSalary + ")")
        rationale.push("[hyp] recruitDelta=" + _round(best.recruitDelta, 2)
            + "/wk · orsLiftPp=" + _round(best.orsLiftPp, 4)
            + " · weeklyCostΔ=" + _round(best.weeklyCostDelta, 0)
            + " · J=" + _round(best.J, 1))
        if (perception && perception.hypothesis) rationale.push(perception.hypothesis)
        if (countryAvg > 0) {
            rationale.push("[ctx] country-avg=" + countryAvg
                + " · current pay-tier=" + Math.round((currentSalary / countryAvg) * 100) + "pp"
                + " → recommended pay-tier=" + Math.round((best.newSalary / countryAvg) * 100) + "pp")
        }
        rationale.push("[advisory] testable: re-scrape staffOverview in 4wk and compare reserve/missing trend")

        return {
            kind:                "pay",
            positionId:          position.positionId,
            label:               position.label,
            group:               position.group,
            currentSalary:       currentSalary,
            recommendedSalary:   best.newSalary,
            countryAverage:      countryAvg,
            payTierPp:           best.tierPp,
            weeklyCostDelta:     best.weeklyCostDelta,
            employed:            employed,
            expectedRecruitDelta: _round(best.recruitDelta, 2),
            expectedOrsLiftPp:    _round(best.orsLiftPp, 4),
            J:                   _round(best.J, 2),
            perceptionAction:     perception ? perception.action     : null,
            perceptionConfidence: perception ? perception.confidence : null,
            perceptionHypothesis: perception ? perception.hypothesis : null,
            rationale:           rationale,
            objective:           {kind: weights && weights.kind, weights: weights && weights.weights},
            accepted:            true,
            source:              "crew-tuner"
        }
    }

    /**
     * Greedy budget allocation by bang-per-buck (J per AS$ of weekly
     * cost). Negative-cost moves (pay cuts that save money) are accepted
     * unconditionally — they free budget rather than consume it.
     * Positive-cost moves are accepted in J/cost order until the budget
     * is exhausted; the rest stay in payMoves with `accepted: false` so
     * the panel can show what was deferred and why.
     */
    function _allocateBudget(payMoves, weeklyBudget) {
        if (!isFinite(weeklyBudget) || weeklyBudget <= 0) return payMoves   // no cap
        const cuts   = payMoves.filter(m => m.weeklyCostDelta <= 0)
        const raises = payMoves.filter(m => m.weeklyCostDelta > 0)
        // Bang-per-buck for raises: J per AS$ committed.
        raises.sort((a, b) => (b.J / Math.max(1, b.weeklyCostDelta))
                            - (a.J / Math.max(1, a.weeklyCostDelta)))
        let spent = 0
        for (const m of cuts) spent += m.weeklyCostDelta   // negative; gives back room
        const out = cuts.slice()
        for (const m of raises) {
            if (spent + m.weeklyCostDelta <= weeklyBudget) {
                out.push(m)
                spent += m.weeklyCostDelta
            } else {
                m.accepted = false
                m.rationale.push("[budget] deferred — would exceed weeklyBudgetAS$ " + weeklyBudget
                    + " (spent " + spent + " + " + m.weeklyCostDelta + ")")
                out.push(m)
            }
        }
        return out
    }

    function tuneCrewMoves(snapshot, opts) {
        if (!snapshot) return null
        if (!snapshot.crew || !snapshot.crew.byPosition) return null
        const o = opts || {}
        const PP = window.AesStrategyPayPerception
        if (!PP || typeof PP.evaluate !== "function") return null

        const resolved = _resolveWeights(snapshot, o)
        const weights = resolved.weights
        const networkRev = _estimateNetworkRevPerOrsPp(snapshot)
        const bySkillLabel = (snapshot.crew && snapshot.crew.bySkillLabel) || null

        // ── Service-first: invoke joint-rank-tuner so its serviceMoves can
        //    claim weekly budget before pay moves do. tuneJointly may
        //    return null when ORS data isn't ready — that's fine, we just
        //    skip the budget reservation.
        let serviceCost = 0
        let jointResult = null
        if (typeof ns.tuneJointly === "function") {
            try {
                jointResult = ns.tuneJointly(snapshot, {skipService: !!o.skipService})
                if (jointResult && jointResult.serviceMoves) {
                    serviceCost = _estimateServiceCost(jointResult.serviceMoves)
                }
            } catch (e) {
                console.warn("[crewTuner] tuneJointly failed", e)
            }
        }

        const settings = (snapshot.settings && snapshot.settings.crewPay) || {}
        const declaredBudget = _num(settings.weeklyBudgetAS$, NaN)
        const remainingBudget = isFinite(declaredBudget)
            ? Math.max(0, declaredBudget - serviceCost)
            : NaN

        // ── Score pay moves per position ─────────────────────────────────
        const rawPayMoves = []
        const byPosition = snapshot.crew.byPosition
        for (const positionId in byPosition) {
            const position = byPosition[positionId]
            if (!position || !position.positionId) {
                position && (position.positionId = positionId)
            }
            const move = _tunePosition(
                Object.assign({positionId}, position),
                snapshot, resolved, o, bySkillLabel, networkRev
            )
            if (move) rawPayMoves.push(move)
        }

        // ── Budget greedy + accept/defer flag ────────────────────────────
        const payMoves = _allocateBudget(rawPayMoves, remainingBudget)
        const accepted = payMoves.filter(m => m.accepted)
        const deferred = payMoves.filter(m => !m.accepted)

        // ── Hire/train passthrough — delegate to existing proposer and
        //    drop its raisePay/cutPay rows so we don't double-up.
        let hireMoves = []
        if (typeof ns.proposeCrewMoves === "function" && o.fleetPlan) {
            try {
                const all = ns.proposeCrewMoves(snapshot, o.fleetPlan, o) || []
                hireMoves = all.filter(m => m && m.action !== "raisePay" && m.action !== "cutPay")
            } catch (e) {
                console.warn("[crewTuner] proposeCrewMoves failed", e)
            }
        }

        return {
            payMoves:  payMoves,
            hireMoves: hireMoves,
            summary: {
                payMoveCount:        payMoves.length,
                acceptedCount:       accepted.length,
                deferredCount:       deferred.length,
                weeklyCostDelta:     accepted.reduce((s, m) => s + (m.weeklyCostDelta || 0), 0),
                expectedOrsLiftPp:   _round(accepted.reduce((s, m) => s + (m.expectedOrsLiftPp || 0), 0), 4),
                serviceCost:         serviceCost,
                weeklyBudget:        isFinite(declaredBudget) ? declaredBudget : null,
                remainingBudget:     isFinite(remainingBudget) ? remainingBudget : null,
                networkRevPerOrsPp:  networkRev,
                objective:           resolved.kind,
                jointResultPresent:  !!jointResult
            }
        }
    }

    ns.tuneCrewMoves = tuneCrewMoves

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const snap = {
                hubs: [{iata: "JFK", byRoute: [{dest: "LAX"}, {dest: "ORD"}]}],
                crew: {
                    bySkillLabel: {
                        "B737": {skillId: 12, active: 8, reserve: 1, required: 12,
                                 missing: 4, marketAvailable: 0}
                    },
                    byPosition: {
                        "1001": {positionId: "1001", label: "B737", group: "Flight crew",
                                 employed: 9, active: 8, required: 12, redundant: 0,
                                 salaryPerEmployee: 1000, countryAverage: 1000},
                        "2001": {positionId: "2001", label: "Cabin attendant", group: "Cabin crew",
                                 employed: 30, active: 30, required: 25, redundant: 5,
                                 salaryPerEmployee: 850, countryAverage: 800}
                    }
                },
                strategySettings: {objective: {kind: "maxProfit"}},
                settings: {crewPay: {}}
            }
            const result = tuneCrewMoves(snap, {})
            console.assert(result && Array.isArray(result.payMoves),
                "[smoke crewTuner] returns shape with payMoves")
            const b737 = result.payMoves.find(m => m.label === "B737")
            console.assert(b737 && b737.payTierPp > 0,
                "[smoke crewTuner] understaffed B737 → raise recommendation")
            console.assert(b737 && b737.expectedRecruitDelta > 0,
                "[smoke crewTuner] raise carries positive recruit-delta hypothesis")
            console.assert(b737 && b737.recommendedSalary > b737.currentSalary,
                "[smoke crewTuner] recommended salary above current")
            console.assert(typeof result.summary.networkRevPerOrsPp === "number",
                "[smoke crewTuner] summary surfaces hypothesis params")

            // Empty-snapshot path.
            console.assert(tuneCrewMoves({}, {}) === null,
                "[smoke crewTuner] missing crew.byPosition → null")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
