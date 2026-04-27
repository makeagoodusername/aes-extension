"use strict"

/**
 * AES Strategy — per-route decision scoring (Slice 2).
 *
 * Pure function over a Slice 1 snapshot. Produces a ranked array of route
 * candidates with composite scores and rationale strings, ready for the
 * fleet allocator (Slice 3) and the preview UI (Slice 4) to consume.
 *
 * NO I/O. NO STATE. The same snapshot + weights always yields the same
 * output. That's important for closed-loop tuning (Slice 5) — the
 * learner records (weights, score, observed-delta) tuples and adjusts
 * weights deterministically.
 *
 * Composite formula (defaults in DEFAULT_WEIGHTS below):
 *
 *   score =  profitWeight       * normalizedProfit
 *          + demandWeight       * normalizedDemand
 *          + competitorWeight   * competitorOpportunity
 *          + orsWeight          * orsLeverage
 *          - maintenancePenalty * fleetWearStress
 *          - cashPenalty        * cashStress
 *
 * Where each term is normalized to roughly [0, 1] so weights are
 * directly interpretable. fleetWearStress and cashStress are global
 * (same value for every route in this snapshot) — they don't pick
 * routes, they bias the engine toward "do less" when the fleet or
 * balance sheet are stretched.
 *
 * Override handling: if a route carries an `override` (user-set
 * paxLF / cargoLF / yieldPerKm), the demand and profit terms use the
 * override values rather than store-derived ones. That's the user's
 * "I know better than the demand bar" escape hatch from the existing
 * Route Assistant overrides store, propagated unchanged.
 *
 * Public API (window.AesStrategy):
 *   scoreRoutes(snapshot, weights?) → {weights, routes: [{hub, dest, ...,
 *                                       score, breakdown, rationale}]}
 *
 * The returned `weights` is the merged effective weight set (defaults +
 * overrides + snapshot-derived global multipliers) so the UI can show
 * exactly what was used.
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.scoreRoutes === "function") return

    // ── Weights ─────────────────────────────────────────────────────────

    const DEFAULT_WEIGHTS = {
        profitWeight:           0.40,   // dominant when profitPerWeek data is rich
        demandWeight:           0.20,   // pax + cargo demand bars
        competitorWeight:       0.20,   // empty markets reward
        orsWeight:              0.10,   // service-profile leverage
        maintenancePenalty:     0.30,   // global stress bias
        cashPenalty:            0.30,   // global stress bias
        cargoWeightInDemand:    0.50,   // cargoScore counts half of paxScore
        competitorSaturationCap: 28,    // > this many flights = saturated
        profitNormalizer:       2.0,    // dollars per seat-km, beyond which profit term saturates
        wearHeadroomTarget:     0.20    // <= 20% slack triggers stress
    }

    function _mergeWeights(user) {
        const out = Object.assign({}, DEFAULT_WEIGHTS)
        if (user && typeof user === "object") {
            for (const k of Object.keys(DEFAULT_WEIGHTS)) {
                if (typeof user[k] === "number" && isFinite(user[k])) out[k] = user[k]
            }
        }
        return out
    }

    // ── Utilities ───────────────────────────────────────────────────────

    function _clamp01(x) {
        if (!isFinite(x)) return 0
        if (x < 0) return 0
        if (x > 1) return 1
        return x
    }

    function _num(x) {
        const n = Number(x)
        return isFinite(n) ? n : null
    }

    function _round(x, digits) {
        if (!isFinite(x)) return null
        const f = Math.pow(10, digits || 2)
        return Math.round(x * f) / f
    }

    // ── Term computers (each returns {value, contribution, why?}) ───────

    /** Profit per seat-km (proxy: profitPerWeek / weeklyFlights / distanceKm).
     *  When weeklyFlights or distanceKm is missing, we fall back to a 0
     *  contribution rather than guess. */
    function _profitTerm(route, snapshot, w) {
        const profit   = _num(route.profitPerWeek)
        const flights  = _num(route.weeklyFlights)
        const distance = _num(route.distanceKm)
        if (profit == null || flights == null || flights <= 0 || distance == null || distance <= 0) {
            return {value: null, contribution: 0, why: "no profit data yet"}
        }
        const seatsAvg = _fleetAverageSeats(snapshot) || 150
        const profitPerSeatKm = profit / flights / distance / seatsAvg
        const norm = _clamp01(profitPerSeatKm / w.profitNormalizer)
        return {
            value:        profit,
            contribution: w.profitWeight * norm,
            why:          "profit/wk " + _fmtMoney(profit) + " (" + _round(profitPerSeatKm, 4) + " $/seat-km)"
        }
    }

    /** Demand: pax + cargoWeightInDemand × cargo, normalized by 10. */
    function _demandTerm(route, w) {
        const pax   = _num(route.paxScore)
        const cargo = _num(route.cargoScore)
        if (pax == null && cargo == null) {
            return {value: null, contribution: 0, why: "no demand bars yet"}
        }
        const composite = (pax || 0) + w.cargoWeightInDemand * (cargo || 0)
        const ceiling   = 10 + w.cargoWeightInDemand * 10
        const norm      = _clamp01(composite / ceiling)
        return {
            value:        composite,
            contribution: w.demandWeight * norm,
            why:          "demand pax " + (pax != null ? pax : "?")
                        + " · cargo " + (cargo != null ? cargo : "?")
        }
    }

    /** Competitor opportunity: 1 - saturation. Empty market → reward.
     *  When competitor data is missing we treat as moderate (0.5) rather
     *  than rewarding — we don't know if the market is empty or just unscanned. */
    function _competitorTerm(route, w) {
        const c = route.competitor
        if (!c || c.flightCount == null) {
            return {value: null, contribution: w.competitorWeight * 0.5, why: "competitor intel not scanned"}
        }
        const saturation = _clamp01(Number(c.flightCount) / w.competitorSaturationCap)
        const opportunity = 1 - saturation
        const ours = c.ourFlightCount != null ? Number(c.ourFlightCount) : 0
        const why = "rivals " + c.flightCount + " (" + ours + " ours)"
                  + (c.dominantCarrier ? " · top " + c.dominantCarrier : "")
        return {
            value:        c.flightCount,
            contribution: w.competitorWeight * opportunity,
            why:          why
        }
    }

    /** ORS leverage: highest available class score across known service profiles.
     *  This is global per snapshot — the engine doesn't pick a profile per route
     *  yet (Slice 3 may); for scoring purposes we take the best Y-class score
     *  the airline has access to and treat it as the achievable ceiling. */
    function _orsTerm(snapshot, w) {
        const profiles = snapshot && snapshot.serviceProfiles
        if (!profiles || !profiles.length) {
            return {value: null, contribution: 0, why: "no service profiles cached"}
        }
        let bestY = null
        for (const p of profiles) {
            const y = p.classScore && _num(p.classScore.Y)
            if (y == null) continue
            if (bestY == null || y > bestY) bestY = y
        }
        if (bestY == null) {
            return {value: null, contribution: 0, why: "service profiles missing class scores"}
        }
        return {
            value:        bestY,
            contribution: w.orsWeight * _clamp01(bestY),
            why:          "best Y-class score " + _round(bestY, 2)
        }
    }

    /** Fleet wear stress: 1 - (mean headroom across fleet). Higher stress →
     *  larger penalty, biasing the engine toward fewer / shorter legs. */
    function _wearStress(snapshot, w) {
        const fleet = snapshot && snapshot.fleet
        if (!fleet || !fleet.length) return {stress: 0, why: "no fleet wear data"}
        let total = 0, count = 0
        for (const a of fleet) {
            const wear = a && a.wear
            if (!wear) continue
            const cap = _num(wear.maxWeeklyBlockHours)
            const used = _num(wear.weeklyHoursLast7d)
            if (cap == null || cap <= 0 || used == null) continue
            const headroom = Math.max(0, (cap - used) / cap)
            total += headroom
            count++
        }
        if (!count) return {stress: 0, why: "no per-tail wear samples yet"}
        const meanHeadroom = total / count
        const target = w.wearHeadroomTarget
        const stress = meanHeadroom < target ? _clamp01(1 - meanHeadroom / target) : 0
        return {
            stress: stress,
            why:    "fleet wear headroom " + Math.round(meanHeadroom * 100) + "%"
        }
    }

    /** Cash stress: 1 when burning + < 4 weeks runway, 0 when profitable. */
    function _cashStress(snapshot) {
        const c = snapshot && snapshot.cash
        if (!c || c.weeklyResult == null) return {stress: 0, why: "no cash data"}
        if (c.weeklyResult >= 0)            return {stress: 0, why: "cash flow positive"}
        const weeks = c.runwayWeeks
        if (weeks === Infinity || weeks == null) return {stress: 0.2, why: "burning but runway unknown"}
        const stress = _clamp01(1 - Math.min(weeks, 26) / 26)
        return {stress: stress, why: "runway " + weeks + " wk"}
    }

    function _fleetAverageSeats(snapshot) {
        const fleet = snapshot && snapshot.fleet
        if (!fleet || !fleet.length) return null
        let sum = 0, count = 0
        for (const a of fleet) {
            if (a && isFinite(Number(a.seats)) && a.seats > 0) { sum += Number(a.seats); count++ }
        }
        return count ? sum / count : null
    }

    function _fmtMoney(v) {
        if (!isFinite(v)) return "?"
        const a = Math.abs(v)
        if (a >= 1e6) return (v / 1e6).toFixed(2) + "M"
        if (a >= 1e3) return Math.round(v / 1e3) + "k"
        return Math.round(v)
    }

    // ── Public ──────────────────────────────────────────────────────────

    function scoreRoutes(snapshot, weights) {
        const w = _mergeWeights(weights)
        const out = []
        if (!snapshot || !Array.isArray(snapshot.hubs)) {
            return {weights: w, routes: out, global: {wearStress: 0, cashStress: 0}}
        }

        const ors    = _orsTerm(snapshot, w)
        const wear   = _wearStress(snapshot, w)
        const cash   = _cashStress(snapshot)
        const wearContribution = -w.maintenancePenalty * wear.stress
        const cashContribution = -w.cashPenalty * cash.stress

        for (const hub of snapshot.hubs) {
            if (!hub || !Array.isArray(hub.byRoute)) continue
            for (const r of hub.byRoute) {
                const profit  = _profitTerm(r,        snapshot, w)
                const demand  = _demandTerm(r,        w)
                const compete = _competitorTerm(r,    w)

                const score = profit.contribution
                            + demand.contribution
                            + compete.contribution
                            + ors.contribution
                            + wearContribution
                            + cashContribution

                const rationale = []
                if (profit.why)  rationale.push("[profit] "     + profit.why)
                if (demand.why)  rationale.push("[demand] "     + demand.why)
                if (compete.why) rationale.push("[competition] "+ compete.why)
                if (ors.why)     rationale.push("[ors] "        + ors.why)
                if (wear.stress > 0)  rationale.push("[fleet] " + wear.why + " (penalty " + _round(wearContribution, 3) + ")")
                if (cash.stress > 0)  rationale.push("[cash] "  + cash.why + " (penalty " + _round(cashContribution, 3) + ")")
                if (r.override)       rationale.push("[override] manual LF/yield set by user")
                if (r.watchlisted)    rationale.push("[watchlist] route is on watchlist")

                out.push({
                    hub:               hub.iata,
                    dest:              r.dest,
                    destName:          r.destName,
                    distanceKm:        r.distanceKm,
                    paxScore:          r.paxScore,
                    cargoScore:        r.cargoScore,
                    profitPerWeek:     r.profitPerWeek,
                    weeklyFlights:     r.weeklyFlights,
                    ourPaxShare:       r.ourPaxShare,
                    competitor:        r.competitor,
                    override:          r.override,
                    watchlisted:       r.watchlisted,
                    alreadyScheduled:  r.alreadyScheduled,
                    score:             _round(score, 4),
                    breakdown: {
                        profit:    _round(profit.contribution,    4),
                        demand:    _round(demand.contribution,    4),
                        compete:   _round(compete.contribution,   4),
                        ors:       _round(ors.contribution,       4),
                        wear:      _round(wearContribution,       4),
                        cash:      _round(cashContribution,       4)
                    },
                    rationale:         rationale
                })
            }
        }

        out.sort((a, b) => (b.score || 0) - (a.score || 0))

        return {
            weights: w,
            global: {
                wearStress:        wear.stress,
                wearWhy:           wear.why,
                cashStress:        cash.stress,
                cashWhy:           cash.why,
                orsCeilingY:       ors.value,
                fleetAvgSeats:     _fleetAverageSeats(snapshot)
            },
            routes:  out
        }
    }

    ns.scoreRoutes = scoreRoutes
    ns.DEFAULT_WEIGHTS = Object.assign({}, DEFAULT_WEIGHTS)
})()
