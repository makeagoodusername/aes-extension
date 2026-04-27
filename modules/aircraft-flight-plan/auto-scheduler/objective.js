"use strict"

/**
 * Track 3 slice 3b — Phase-1 objective function for the auto-scheduler.
 *
 * Pure function. No DOM, no chrome.storage, no AS knowledge beyond the
 * Slice C `Candidate` shape and the aircraft spec resolved by Slice B.
 *
 * Phase-1 formula (per `~/.claude/plans/structured-toasting-origami.md` §
 * Track 3 / 3b):
 *
 *   gross         = (paxScore + cargoScore × cargoWeight)
 *                 × seats × (pricePct/100) × distanceFactor
 *   distanceFactor = clamp(distanceNm / distanceSaturationNm, distanceFloor, 1)
 *   fuelKgPerLeg  = (cycleL + perKmL × distanceKm) × KG_PER_LITRE_JETA
 *   fuelCost$     = fuelKgPerLeg × fuelCostPerKg
 *   slackPenalty  = max(0, projectedWeeklyHours − maxWeeklyBlockHours)
 *                 × slackPenaltyPerHour
 *                 + max(0, projectedDailyHours − maxDailyBlockHours)
 *                 × dailyOverrunPenaltyPerHour
 *   total         = gross × grossWeight − fuelCost × fuelWeight − slackPenalty
 *
 * `slackPenalty` is the lever the allocator uses to honour the weekly /
 * daily block-hour budget (Track 2's slack budget) without a hard rejection
 * — when budget is comfortably available the penalty is zero, and as the
 * grid fills past budget the penalty grows linearly so the greedy pass
 * starts preferring shorter / more efficient legs.
 *
 * Public API (window.AesAfpAutoSchedulerObjective):
 *   .score({candidate, leg, gridState, budget, weights, spec, pricePct,
 *           fuelBurn, fuelPriceASc, fuelCostPerKg})
 *     → {total, parts: {gross, fuelCost, slackPenalty, distanceFactor}}
 *   .fuelCostPerKgFromASc(fuelPriceASc) → number | null
 *   .KG_PER_LITRE_JETA — numeric constant (mirrors route-candidates.js:55)
 */
;(function () {
    if (window.AesAfpAutoSchedulerObjective) return

    // 1 L Jet A ≈ 0.8 kg — same constant the AS Performance Check tool
    // uses when it converts liters to mass for payload planning. Mirrors
    // route-candidates.js:55. Keep both copies in sync.
    const KG_PER_LITRE_JETA = 0.8

    function _num(v, fallback) {
        const n = Number(v)
        return (isFinite(n)) ? n : fallback
    }

    function _clamp(v, lo, hi) {
        if (v < lo) return lo
        if (v > hi) return hi
        return v
    }

    /**
     * Convert AS fuel price (ASc$ per litre) to AS$ per kilogram.
     *   AS$ / kg = (ASc$ / L) ÷ 100 ÷ (kg/L)
     *
     * Returns null when the input isn't a positive finite number so the
     * caller can fall back to a settings-supplied default (see Phase-1
     * `fallbackFuelCostPerKg`).
     */
    function fuelCostPerKgFromASc(fuelPriceASc) {
        const v = _num(fuelPriceASc, NaN)
        if (!isFinite(v) || v <= 0) return null
        return (v / 100) / KG_PER_LITRE_JETA
    }

    /**
     * Score a single candidate-leg assignment. Inputs are passed in a bag
     * so the allocator can vary just one or two fields per call without
     * shuffling positional args.
     *
     * @param {object} args
     *   - candidate: Slice C Candidate (see route-candidates.js:24-28)
     *   - leg: {dayIdx, depMin, arrMin?, distanceNm, distanceKm,
     *           blockMinutes, direction?}
     *   - gridState: AesAfpAutoSchedulerGrid (current placements)
     *   - budget: {maxWeeklyBlockHours, maxDailyBlockHours}
     *   - weights: settings.aircraftFlightPlan.autoScheduler.weights
     *   - spec: aircraft type spec ({seats, …}); spec.seats=null → falls back to 1
     *   - pricePct: 0..200 (defaults to 100 if missing)
     *   - fuelBurn: result of RouteAssistantFuelBurn.estimate(spec) — null OK
     *   - fuelPriceASc: ASc$/L from RouteAssistantFuelPriceScraper — null OK
     *   - fuelCostPerKg: optional pre-computed override (AS$/kg); when both
     *     this and fuelPriceASc are present, this wins
     */
    function score(args) {
        const a = args || {}
        const cand   = a.candidate || {}
        const leg    = a.leg || {}
        const grid   = a.gridState
        const budget = a.budget || {}
        const w      = a.weights || {}
        const spec   = a.spec || {}

        const paxScore   = _num(cand.paxScore,   0)
        const cargoScore = _num(cand.cargoScore, 0)
        const seats      = (() => {
            const s = _num(spec.seats, NaN)
            return (isFinite(s) && s > 0) ? s : 1
        })()
        const pricePct = _num(a.pricePct, 100)

        const distanceNm = _num(leg.distanceNm, _num(cand.distanceNm, 0))
        const distanceKm = _num(leg.distanceKm, _num(cand.distanceKm, 0))

        const cargoWeight          = _num(w.cargoWeight,                0.5)
        const grossWeight          = _num(w.grossWeight,                1.0)
        const fuelWeight           = _num(w.fuelWeight,                 1.0)
        const distanceSaturationNm = Math.max(1, _num(w.distanceSaturationNm, 2500))
        const distanceFloor        = _clamp(_num(w.distanceFloor,       0.2), 0, 1)
        const slackPenPerHour      = _num(w.slackPenaltyPerHour,        5000)
        const dailyOverrunPenPerHr = _num(w.dailyOverrunPenaltyPerHour, 10000)

        const distanceFactor = _clamp(distanceNm / distanceSaturationNm, distanceFloor, 1)

        const gross = (paxScore + cargoScore * cargoWeight)
                    * seats
                    * (pricePct / 100)
                    * distanceFactor

        // Fuel cost. Single-leg: cycleL + perKmL × distance_km. The
        // costPerFlight helper in fuel-burn-estimator.js doubles distance
        // for round-trip; the allocator scores legs individually so we
        // don't double here.
        let fuelKg = 0
        if (a.fuelBurn && isFinite(a.fuelBurn.cycleL) && isFinite(a.fuelBurn.perKmL) && distanceKm > 0) {
            const fuelL = a.fuelBurn.cycleL + a.fuelBurn.perKmL * distanceKm
            fuelKg = fuelL * KG_PER_LITRE_JETA
        }
        let fuelCostPerKg = _num(a.fuelCostPerKg, NaN)
        if (!isFinite(fuelCostPerKg) || fuelCostPerKg < 0) {
            const derived = fuelCostPerKgFromASc(a.fuelPriceASc)
            fuelCostPerKg = (derived !== null) ? derived : 0
        }
        const fuelCost = fuelKg * fuelCostPerKg

        // Slack penalty — projected weekly/daily hours after this leg.
        const blockHours = _num(leg.blockMinutes, 0) / 60
        const usedWeekly = (grid && typeof grid.weeklyBlockHours === "function")
            ? grid.weeklyBlockHours() : 0
        const usedDaily  = (grid && typeof grid.dailyBlockHours === "function" && Number.isInteger(leg.dayIdx))
            ? grid.dailyBlockHours(leg.dayIdx) : 0
        const projectedWeekly = usedWeekly + blockHours
        const projectedDaily  = usedDaily  + blockHours

        const maxWeekly = _num(budget.maxWeeklyBlockHours, Infinity)
        const maxDaily  = _num(budget.maxDailyBlockHours,  Infinity)
        const weeklyExcess = Math.max(0, projectedWeekly - maxWeekly)
        const dailyExcess  = Math.max(0, projectedDaily  - maxDaily)
        const slackPenalty = weeklyExcess * slackPenPerHour
                           + dailyExcess  * dailyOverrunPenPerHr

        const total = gross * grossWeight - fuelCost * fuelWeight - slackPenalty
        return {
            total: total,
            parts: {
                gross:          gross,
                fuelCost:       fuelCost,
                slackPenalty:   slackPenalty,
                distanceFactor: distanceFactor
            }
        }
    }

    window.AesAfpAutoSchedulerObjective = {
        score:                  score,
        fuelCostPerKgFromASc:   fuelCostPerKgFromASc,
        KG_PER_LITRE_JETA:      KG_PER_LITRE_JETA
    }
})()
