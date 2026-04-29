"use strict"

/**
 * AES Strategy — plan diff (Slice 4 cross-cutting).
 *
 * Pure function. Given a `FleetPlan` produced by `allocateFleet` and the
 * `Snapshot` it was generated from, returns a flat decision list +
 * counts that the strategy modal renders in its Diff and Decisions
 * columns.
 *
 * When the caller threads in `opts.currentSchedules` (a
 * `Map<aircraftId, currentLegs[]>` loaded from `AesAfpScheduleStore`),
 * the diff intersects each aircraft's plan legs against its currently-
 * scheduled legs via `AesAfpScheduleDiff.compare()` and produces real
 * `{kept, added, removed, locked}` counts both in the summary and on
 * each schedule decision (`d._diff`). Without that map the diff falls
 * back to the v1 approximation: every plan leg is "added" and nothing
 * is "removed" — that's also how aircraft with no cached schedule are
 * accounted for individually so the user can tell "no current data" from
 * "actually no change".
 *
 * Public API:
 *   AesStrategy.diffPlan(plan, snapshot, opts?) → PlanDiff
 *   opts.currentSchedules?: Map&lt;aircraftId, currentLegs[]&gt;
 *
 * PlanDiff shape:
 *   {
 *     summary: {addedLegs, removedLegs, repricedRoutes, profileChanges,
 *               crewHires, crewTraining, routeCreationProposals,
 *               predictedWeeklyProfit, predictedOrsAvg},
 *     decisions: [{
 *       id:            "<unique-string>",
 *       kind:          "schedule"|"service"|"price"|"crew"|"routeCreation"|"competitorReaction",
 *       domain:        "schedule"|"service"|"price"|"crew"|"routeCreation"|"competitorReaction",
 *       title:         "JFK → LAX × 7 legs"           // human label
 *       subtitle:      "tail N123AA · widebody · 65h" // optional 2nd line
 *       rationale:     [string],                      // bullet rationale
 *       payload:       <kind-specific>,               // raw decision the
 *                                                    //   apply pipeline acts on
 *       applicable:    bool,                          // false → engine knows
 *                                                    //   it can't apply this
 *                                                    //   in v1 (e.g. service
 *                                                    //   moves with empty changes)
 *       applicableNote: string                        // why-not when applicable=false
 *     }]
 *   }
 *
 * Determinism: the same (plan, snapshot) produces the same `decisions`
 * array (stable sort by domain, then by an inherent key — aircraftId for
 * schedules, profileId/hub-dest-classKey for moves, hub-dest for route
 * creations, skillLabel for crew). The Decisions UI uses `id` as React-
 * style key so the user's per-decision selection survives re-renders.
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.diffPlan === "function") return

    const _num = (window.AesUtils && window.AesUtils._num)
        || function (v, f) { const n = Number(v); return isFinite(n) ? n : f }

    /**
     * Map a strategy plan leg → the shape AesAfpScheduleDiff.compare()
     * matches on (`{origin, destination, depTimeLocal}`). Plan legs use
     * `depTime` (HH:MM) — alias to `depTimeLocal` so the diff engine's
     * IATA + HHMM regexes accept them. flightId pass-through stays null
     * (plan legs never carry one until they're applied + re-scraped).
     */
    function _planLegToMatchable(leg) {
        if (!leg) return null
        return {
            seq:           leg.seq,
            origin:        leg.origin || null,
            destination:   leg.destination || null,
            depTimeLocal:  leg.depTimeLocal || leg.depTime || null,
            flightId:      leg.flightId || null
        }
    }

    /**
     * Per-aircraft schedule diff against the cached current schedule.
     * Returns null when no current schedule was provided for this tail
     * (caller treats null as "no current data — every plan leg counts as
     * added", matching the v1 stub semantics for that one tail).
     */
    function _diffAircraft(aircraft, currentSchedules) {
        if (!currentSchedules || typeof currentSchedules.get !== "function") return null
        const cur = currentSchedules.get(String(aircraft.aircraftId))
        if (!cur) return null
        const D = (typeof window !== "undefined") ? window.AesAfpScheduleDiff : null
        if (!D || typeof D.compare !== "function") return null
        const proposed = (aircraft.legs || []).map(_planLegToMatchable).filter(Boolean)
        const result = D.compare(Array.isArray(cur) ? cur : [], proposed)
        return {
            kept:    result.keep.length,
            added:   result.add.length,
            removed: result.delete.length,
            locked:  result.locked.length,
            detail:  result
        }
    }

    /**
     * Per-decision headline metric. Returns `{value, unit, label, tone}`
     * or null when no impact can be computed for this kind. The UI
     * renders these as a chip on the right of the row + sums the dollar
     * ones for the footer total.
     *
     * tone semantics: "ok" = positive $/wk, "err" = negative $/wk,
     * "warn" = needs scrutiny (e.g. cost-only), "muted" = informational.
     */
    function _impactSchedule(aircraft) {
        const v = _num(aircraft && aircraft.plannedProfit, NaN)
        if (!isFinite(v) || v === 0) return null
        return {value: v, unit: "$/wk", tone: v > 0 ? "ok" : "err",
                label: (v > 0 ? "+$" : "-$") + Math.abs(Math.round(v)).toLocaleString() + "/wk"}
    }
    function _impactPrice(move) {
        const v = _num(move && move.impactWeekly, NaN)
        if (!isFinite(v) || v === 0) return null
        return {value: v, unit: "$/wk", tone: v > 0 ? "ok" : "err",
                label: (v > 0 ? "+$" : "-$") + Math.abs(Math.round(v)).toLocaleString() + "/wk est."}
    }
    function _impactService(move) {
        const v = _num(move && move.predictedOrsDelta, NaN)
        if (!isFinite(v) || v === 0) return null
        return {value: v, unit: "ORS", tone: v > 0 ? "ok" : "err",
                label: (v > 0 ? "+" : "") + v.toFixed(3) + " Y-class"}
    }
    function _impactRouteCreation(creation) {
        const v = _num(creation && creation.impactWeekly, NaN)
        if (!isFinite(v) || v === 0) return null
        return {value: v, unit: "$/wk", tone: v > 0 ? "ok" : "err",
                label: "~$" + Math.abs(Math.round(v)).toLocaleString() + "/wk projected"}
    }
    function _impactCrew(move) {
        if (!move || !move.amount) return null
        const tone = move.action === "hire" ? "ok" : "warn"
        return {value: move.amount, unit: "ppl", tone: tone,
                label: move.action + " " + move.amount + " · " + (move.flightsNeeded || "?") + " flt/wk needed"}
    }

    function _scheduleDecisions(plan, currentSchedules) {
        const out = []
        const aircraft = (plan && plan.perAircraft) || []
        for (const a of aircraft) {
            if (!a || !a.aircraftId) continue
            const legCount = (a.legs || []).length
            if (!legCount) continue
            const reg = a.registration ? "[" + a.registration + "] " : ""
            const hours = _num(a.utilization && a.utilization.weeklyHours, 0)
            const cap   = _num(a.utilization && a.utilization.capWeeklyHours, 0)
            const hubLabel = a.hub || "?"
            const eq = a.equipment || ("type " + (a.typeId || "?"))
            const adiff = _diffAircraft(a, currentSchedules)
            // Subtitle gets a diff hint when we have one — "+3 / -1" beats
            // a meaningless "12 legs on aircraft" when the user is trying
            // to gauge change vs. status quo.
            let subtitle = reg + eq + " · " + hubLabel
                + (cap > 0 ? " · " + hours.toFixed(1) + "/" + cap.toFixed(1) + "h" : "")
            if (adiff) {
                subtitle += " · keep " + adiff.kept + " · +" + adiff.added + " / -" + adiff.removed
                    + (adiff.locked ? " · locked " + adiff.locked : "")
            } else if (currentSchedules) {
                subtitle += " · no current schedule cached"
            }
            const dec = {
                id:           "schedule:" + a.aircraftId,
                kind:         "schedule",
                domain:       "schedule",
                title:        legCount + " leg" + (legCount === 1 ? "" : "s") + " on aircraft " + a.aircraftId,
                subtitle:     subtitle,
                rationale:    Array.isArray(a.rationale) ? a.rationale.slice() : [],
                payload:      {aircraftId: a.aircraftId, legs: a.legs, hub: a.hub},
                applicable:   true,
                applicableNote: ""
            }
            if (adiff) dec._diff = adiff
            const imp = _impactSchedule(a)
            if (imp) dec._impact = imp
            out.push(dec)
        }
        return out
    }

    function _serviceDecisions(plan) {
        const out = []
        for (const m of (plan && plan.serviceMoves) || []) {
            if (!m || m.profileId == null) continue
            const lift = _num(m.predictedOrsDelta, 0)
            const empty = !m.changes || !Object.keys(m.changes).length
            const dec = {
                id:           "service:" + m.profileId,
                kind:         "service",
                domain:       "service",
                title:        "Upgrade profile " + (m.profileName || ("#" + m.profileId)),
                subtitle:     "+ " + lift.toFixed(3) + " predicted Y-class lift",
                rationale:    Array.isArray(m.rationale) ? m.rationale.slice() : [],
                payload:      {profileId: m.profileId, changes: m.changes || {}},
                applicable:   !empty,
                applicableNote: empty
                    ? "Profile lacks scraped per-category detail — refresh service profiles to make this applicable."
                    : ""
            }
            const imp = _impactService(m)
            if (imp) dec._impact = imp
            out.push(dec)
        }
        return out
    }

    function _priceDecisions(plan) {
        const out = []
        for (const m of (plan && plan.priceMoves) || []) {
            if (!m || !m.hub || !m.dest) continue
            const cls = m.classKey || "Y"
            const id = "price:" + m.hub + "-" + m.dest + ":" + cls
            const sign = (m.deltaPct >= 0 ? "+" : "")
            const dec = {
                id:           id,
                kind:         "price",
                domain:       "price",
                title:        m.hub + " → " + m.dest + " · " + cls + " " + (m.fromPct != null ? m.fromPct + "%" : "?")
                                  + " → " + m.toPct + "%",
                subtitle:     "Δ " + sign + _num(m.deltaPct, 0).toFixed(0) + " pct points",
                rationale:    Array.isArray(m.rationale) ? m.rationale.slice() : [],
                payload:      m,
                applicable:   true,
                applicableNote: ""
            }
            const imp = _impactPrice(m)
            if (imp) dec._impact = imp
            out.push(dec)
        }
        return out
    }

    function _crewDecisions(plan) {
        const out = []
        for (const m of (plan && plan.crewMoves) || []) {
            if (!m || m.action === "none") continue
            const isPay = m.action === "raisePay" || m.action === "cutPay"
            const id = "crew:" + (m.skillLabel || ("type-" + m.typeId)) + ":" + m.action
            // Pay actions display the signed pp magnitude; hire/train show
            // the headcount the way they did pre-Slice-8.
            const titleAction = isPay
                ? (m.action === "raisePay" ? "RAISE PAY" : "CUT PAY")
                : m.action.toUpperCase()
            const titleAmount = isPay
                ? (m.amount > 0 ? "+" + m.amount + "pp" : m.amount + "pp")
                : m.amount
            const dec = {
                id:           id,
                kind:         "crew",
                domain:       "crew",
                title:        titleAction + " " + titleAmount + " · "
                                  + (m.skillLabel || ("type " + m.typeId)),
                subtitle:     "Need " + m.flightsNeeded + " · active "
                                  + (m.activeNow != null ? m.activeNow : "?"),
                rationale:    Array.isArray(m.rationale) ? m.rationale.slice() : [],
                payload:      m,
                applicable:   !isPay && m.skillId != null,
                applicableNote: isPay
                    ? "Pay-tier actuator not yet implemented — surface as a testable hypothesis; apply manually on /app/enterprise/staffPilots."
                    : (m.skillId == null
                        ? "Skill ID missing — open the staff page (/app/enterprise/staffPilots) to seed CrewMgmtStaffPilotsScraper."
                        : "")
            }
            const imp = _impactCrew(m)
            if (imp) dec._impact = imp
            out.push(dec)
        }
        return out
    }

    function _routeCreationDecisions(plan) {
        const out = []
        for (const r of (plan && plan.routeCreations) || []) {
            if (!r || !r.hub || !r.dest) continue
            const id = "routeCreation:" + r.hub + "-" + r.dest
            const eligible = Array.isArray(r.proposedTypeIds) ? r.proposedTypeIds.length : 0
            // Slice 6 ships the auto-route-creation actuator. Decisions are
            // applicable when at least one fleet type matches range. The
            // proposer (route-creation.js) already gates on `_suitableTypes`
            // so `eligible > 0` should always be the case when a creation
            // shows up here — defensive zero check keeps the contract clean.
            const applicable = eligible > 0
            const dec = {
                id:           id,
                kind:         "routeCreation",
                domain:       "routeCreation",
                title:        "Open new route " + r.hub + " → " + r.dest,
                subtitle:     (r.distanceKm != null ? r.distanceKm.toFixed(0) + " km · " : "")
                                  + r.proposedFrequency + "/wk · "
                                  + r.proposedPricePct + "% baseline · "
                                  + eligible + " type(s) match",
                rationale:    Array.isArray(r.rationale) ? r.rationale.slice() : [],
                payload:      r,
                applicable:   applicable,
                applicableNote: applicable
                    ? ""
                    : "No fleet type covers the route's distance — add an aircraft of suitable range."
            }
            const imp = _impactRouteCreation(r)
            if (imp) dec._impact = imp
            out.push(dec)
        }
        return out
    }

    function _competitorReactionDecisions(plan) {
        const out = []
        for (const m of (plan && plan.competitorMoves) || []) {
            if (!m || !m.hub || !m.dest || !m.event) continue
            const id = "competitorReaction:" + m.hub + "-" + m.dest + ":" + m.event
            const sign = (m.magnitude > 0 ? "+" : "")
            const subtitle = (m.action === "hold")
                ? "hold (" + m.event + ")"
                : (m.action + " · " + sign + m.magnitude
                    + (m.unit === "pp" ? "pp on " + (m.target || "?")
                                       : "/wk " + (m.target || "?")))
            const dec = {
                id:           id,
                kind:         "competitorReaction",
                domain:       "competitorReaction",
                title:        m.hub + " → " + m.dest + " · " + m.event.toUpperCase(),
                subtitle:     subtitle,
                rationale:    Array.isArray(m.rationale) ? m.rationale.slice() : [],
                payload:      m,
                applicable:   false,
                applicableNote: "Competitor-reaction routing not yet wired — surfaced as advisory; apply the recommended price/freq move via the price-moves or schedule slice."
            }
            out.push(dec)
        }
        return out
    }

    function _summary(plan, decisions, currentSchedules) {
        const summary = (plan && plan.summary) ? Object.assign({}, plan.summary) : {}
        if (typeof summary.repricedRoutes      !== "number") summary.repricedRoutes      = 0
        if (typeof summary.profileChanges      !== "number") summary.profileChanges      = 0
        if (typeof summary.crewHires           !== "number") summary.crewHires           = 0
        if (typeof summary.crewTraining        !== "number") summary.crewTraining        = 0
        if (typeof summary.routeCreationProposals !== "number") summary.routeCreationProposals = 0

        // Real per-aircraft schedule diff totals when we have current
        // schedules cached; v1 stub (added = total plan legs, removed = 0)
        // for tails without cached current data.
        let added = 0, removed = 0, kept = 0, locked = 0
        let aircraftWithDiff = 0, aircraftMissingDiff = 0
        for (const d of decisions) {
            if (d.kind !== "schedule") continue
            if (d._diff) {
                added   += d._diff.added
                removed += d._diff.removed
                kept    += d._diff.kept
                locked  += d._diff.locked
                aircraftWithDiff++
            } else {
                added += (d.payload && d.payload.legs ? d.payload.legs.length : 0)
                aircraftMissingDiff++
            }
        }
        summary.addedLegs        = added
        summary.removedLegs      = removed
        summary.keptLegs         = kept
        summary.lockedLegs       = locked
        summary.aircraftWithDiff = aircraftWithDiff
        summary.aircraftMissingDiff = aircraftMissingDiff
        summary.scheduleDiffMode = currentSchedules ? "real" : "stub"

        // Convenience counters for the UI even when the plan summary is empty.
        summary.byKind = {}
        for (const d of decisions) {
            summary.byKind[d.kind] = (summary.byKind[d.kind] || 0) + 1
        }
        summary.applicableTotal   = decisions.filter(d => d.applicable).length
        summary.advisoryTotal     = decisions.filter(d => !d.applicable).length

        // Aggregate $/wk impact across all decisions that ship a dollar
        // metric (schedule, price, routeCreation). Service ORS lift and
        // crew headcount are not summed here — they don't share units.
        let dollarImpact = 0
        for (const d of decisions) {
            if (d._impact && d._impact.unit === "$/wk") dollarImpact += _num(d._impact.value, 0)
        }
        summary.dollarImpactWeekly = dollarImpact
        return summary
    }

    function diffPlan(plan, _snapshot, opts) {
        const currentSchedules = opts && opts.currentSchedules ? opts.currentSchedules : null
        if (!plan) return {summary: _summary(null, [], currentSchedules), decisions: []}
        const decisions = []
            .concat(_scheduleDecisions(plan, currentSchedules))
            .concat(_serviceDecisions(plan))
            .concat(_priceDecisions(plan))
            .concat(_crewDecisions(plan))
            .concat(_routeCreationDecisions(plan))
            .concat(_competitorReactionDecisions(plan))
        // Stable order — domains in apply-pipeline order, then by id within
        // domain (already deterministic from the producers above). Competitor
        // reactions are advisory-only and sort last.
        const domainOrder = {schedule: 0, service: 1, price: 2, crew: 3,
                              routeCreation: 4, competitorReaction: 5}
        decisions.sort((a, b) => {
            const da = domainOrder[a.domain] ?? 99
            const db = domainOrder[b.domain] ?? 99
            if (da !== db) return da - db
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        })
        return {summary: _summary(plan, decisions, currentSchedules), decisions: decisions}
    }

    ns.diffPlan = diffPlan

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const d0 = diffPlan(null, null)
            console.assert(d0.decisions.length === 0,                "[smoke] null plan → empty decisions")
            console.assert(d0.summary.applicableTotal === 0,         "[smoke] null plan → no applicables")

            const fake = {
                perAircraft: [{aircraftId: "1", registration: "N1", equipment: "B737", hub: "ATL",
                               legs: [{origin: "ATL", destination: "MCO"}, {origin: "MCO", destination: "ATL"}],
                               utilization: {weeklyHours: 12, capWeeklyHours: 80}, rationale: ["[place] MCO"]}],
                serviceMoves:  [{profileId: 7, profileName: "Standard", predictedOrsDelta: 0.08,
                                 changes: {}, rationale: ["[gap]…"]}],
                priceMoves:    [{hub: "ATL", dest: "MCO", classKey: "Y", fromPct: 100, toPct: 105,
                                 deltaPct: 5, rationale: ["[market]…"]}],
                crewMoves:     [{skillLabel: "B737", skillId: 12, typeId: 100, action: "hire",
                                 amount: 2, flightsNeeded: 14, activeNow: 12, rationale: ["[move]…"]}],
                routeCreations:[{hub: "ATL", dest: "BOS", distanceKm: 1500,
                                 proposedTypeIds: [100], proposedFrequency: 7,
                                 proposedPricePct: 105, proposedServiceProfileId: 7,
                                 rationale: ["[score]…"]}],
                summary: {addedLegs: 2, repricedRoutes: 1, profileChanges: 1, crewHires: 2}
            }
            const d1 = diffPlan(fake, {})
            console.assert(d1.decisions.length === 5,                "[smoke] one decision per kind")
            console.assert(d1.decisions[0].kind === "schedule",      "[smoke] schedule sorts first")
            console.assert(d1.decisions[1].kind === "service",       "[smoke] service second")
            console.assert(d1.decisions[1].applicable === false,     "[smoke] empty-changes service marked advisory")
            console.assert(d1.decisions[2].kind === "price",         "[smoke] price third")
            console.assert(d1.decisions[2].applicable === true,      "[smoke] well-formed price applicable")
            console.assert(d1.decisions[3].kind === "crew",          "[smoke] crew fourth")
            console.assert(d1.decisions[4].kind === "routeCreation", "[smoke] route-creation last")
            console.assert(d1.decisions[4].applicable === true,      "[smoke] route-creation applicable post-Slice 6 (proposedTypeIds.length > 0)")
            console.assert(d1.summary.byKind.schedule === 1,         "[smoke] byKind summed")
            console.assert(d1.summary.applicableTotal === 4,         "[smoke] 4 applicable, 1 advisory (service moves only)")
            console.assert(d1.summary.scheduleDiffMode === "stub",   "[smoke] no currentSchedules → stub mode")
            console.assert(d1.summary.addedLegs === 2,               "[smoke] stub addedLegs = total plan legs")
            console.assert(d1.summary.removedLegs === 0,             "[smoke] stub removedLegs always 0")
            console.assert(!d1.decisions[0]._diff,                   "[smoke] no _diff on schedule decision when no currentSchedules")

            // Real-diff path: pass currentSchedules with one matching leg
            // and one extra current leg → kept=1, added=1, removed=1.
            if (typeof window !== "undefined" && window.AesAfpScheduleDiff) {
                const cs = new Map()
                cs.set("1", [
                    {seq: 1, origin: "ATL", destination: "MCO", depTimeLocal: "09:00"},
                    {seq: 2, origin: "MCO", destination: "DCA", depTimeLocal: "15:00"}
                ])
                // Plan legs need depTimeLocal for diff to match — alias of depTime.
                const fake2 = JSON.parse(JSON.stringify(fake))
                fake2.perAircraft[0].legs[0].depTimeLocal = "09:00"
                fake2.perAircraft[0].legs[1].depTimeLocal = "15:00"
                const d2 = diffPlan(fake2, {}, {currentSchedules: cs})
                console.assert(d2.summary.scheduleDiffMode === "real", "[smoke] currentSchedules → real mode")
                console.assert(d2.summary.keptLegs === 1,              "[smoke] real diff keptLegs counted")
                console.assert(d2.summary.addedLegs === 1,             "[smoke] real diff addedLegs counted")
                console.assert(d2.summary.removedLegs === 1,           "[smoke] real diff removedLegs (current MCO→DCA dropped)")
                console.assert(d2.decisions[0]._diff && d2.decisions[0]._diff.kept === 1,
                    "[smoke] schedule decision carries _diff.kept")
                console.assert(d2.summary.aircraftWithDiff === 1
                            && d2.summary.aircraftMissingDiff === 0,
                    "[smoke] aircraftWithDiff/Missing accounting")

                // Mixed: one tail with cached, one without → mixed counters.
                const fake3 = JSON.parse(JSON.stringify(fake2))
                fake3.perAircraft.push({
                    aircraftId: "2", registration: "N2", equipment: "B737", hub: "ATL",
                    legs: [{origin: "ATL", destination: "BOS", depTimeLocal: "10:00"}],
                    utilization: {weeklyHours: 6, capWeeklyHours: 80}, rationale: []
                })
                const d3 = diffPlan(fake3, {}, {currentSchedules: cs})
                console.assert(d3.summary.aircraftWithDiff === 1
                            && d3.summary.aircraftMissingDiff === 1,
                    "[smoke] mixed: one cached + one missing")
                console.assert(d3.summary.addedLegs === 2,            "[smoke] mixed addedLegs = real(1) + stub(1)")
            }
        }
    } catch (_) { /* never let smoke break the page */ }
})()
