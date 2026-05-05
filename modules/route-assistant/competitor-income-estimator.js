"use strict"

/**
 * Competitor income estimator. The game does not expose competitor
 * revenue/profit directly, but every other input is observable:
 *
 *   - Their ticket price        (markets-page scraper)
 *   - Their seats per flight    (markets-page scraper / type spec)
 *   - Their weekly frequency    (count of their flights on the route)
 *   - Their aircraft spec       (typeId from markets-page → AESAircraftTypeSpecs)
 *   - Their market share        (marketShare leaderboard)
 *   - Route distance            (DistanceResolver)
 *
 * We funnel all of that through the existing `RouteAssistantProfitEstimator`
 * so the cost model (block hours, fuel, age penalty) stays consistent
 * with what the user sees for their own routes — the estimator becomes
 * the single source of truth for "would this route make money?" and the
 * income estimator just supplies overrides for yieldPerKm + paxLF derived
 * from the competitor's observable price + share.
 *
 * Confidence:
 *   high — full inputs (price + share + spec + freq).
 *   med  — price + spec + freq, no share (LF defaulted from configured base).
 *   low  — anything missing; caller renders "—" rather than a number.
 */
class RouteAssistantCompetitorIncome {
    /**
     * @param {object} input
     * @param {number} input.distanceKm
     * @param {number} [input.seats]            seats on this aircraft (override of spec.seats)
     * @param {number} input.price              one-way economy price the competitor charges
     * @param {number} input.frequency          weekly flights they operate on this lane
     * @param {object} input.aircraftSpec       {seats, range, speed, cargoCapacity}
     * @param {number} [input.observedSharePct] market share % (0-100) on this lane, if known
     * @param {object} input.economics          settings.routeAssistant economics block
     *                                          (loadFactorMin/Max, fuelCostPerHour, etc.)
     * @returns {{estRevenuePerWeek, estProfitPerWeek, confidence, breakdown}}
     */
    static estimate(input) {
        const out = {
            estRevenuePerWeek: null,
            estProfitPerWeek:  null,
            confidence:        "low",
            breakdown:         null
        }
        if (!input) return out
        const distanceKm = numOrNull(input.distanceKm)
        const price      = numOrNull(input.price)
        const frequency  = numOrNull(input.frequency)
        const spec       = input.aircraftSpec || null
        const econ       = input.economics    || {}
        if (distanceKm === null || distanceKm <= 0) return out
        if (frequency === null  || frequency  <= 0) return out
        if (!spec) return out

        const seats = numOrNull(input.seats != null ? input.seats : spec.seats)
        if (seats === null || seats <= 0) return out

        // Observed price → yield/km. AS one-way fares scale roughly linearly
        // with route distance, so price/distanceKm is a usable yield proxy
        // even without per-class breakdown. If the price field came from the
        // markets page average, this slightly underestimates yield on premium-
        // heavy routes — confidence is reported alongside so the UI can hint
        // at uncertainty.
        const yieldPerKm = price !== null && price > 0
            ? price / distanceKm
            : null

        // Observed share → load factor. We don't have their actual booking
        // depth, but a competitor with high share is by definition selling
        // a lot of seats — translate share into LF inside the configured
        // [paxLfMin, paxLfMax] band.
        let paxLF = null
        const sharePct = numOrNull(input.observedSharePct)
        if (sharePct !== null && sharePct > 0) {
            const lfMin = clamp(numOrNull(econ.loadFactorMin), 0, 1, 0.50)
            const lfMax = clamp(numOrNull(econ.loadFactorMax), 0, 1, 0.95)
            // 0% share → lfMin, 100% share → lfMax. Linear is rough but
            // share already encodes both demand and competitive position.
            const t = Math.max(0, Math.min(1, sharePct / 100))
            paxLF = lfMin + t * (lfMax - lfMin)
        }

        const specForEstimator = Object.assign({}, spec, {seats: seats})
        const override = {}
        if (yieldPerKm !== null) override.yieldPerKm = yieldPerKm
        if (paxLF      !== null) override.paxLF      = paxLF

        if (typeof RouteAssistantProfitEstimator === "undefined") return out
        const result = RouteAssistantProfitEstimator.estimate({
            distanceKm: distanceKm,
            spec:       specForEstimator,
            frequency:  frequency,
            paxScore:   5,
            economics:  econ,
            override:   Object.keys(override).length ? override : null
        })

        if (!result || !result.breakdown) return out
        out.estProfitPerWeek = result.profitPerWeek
        const revenuePerFlight = result.breakdown.revenue
        if (isFinite(revenuePerFlight) && frequency > 0) {
            out.estRevenuePerWeek = Math.round(revenuePerFlight * frequency)
        }
        out.breakdown = result.breakdown

        if (yieldPerKm !== null && paxLF !== null)      out.confidence = "high"
        else if (yieldPerKm !== null)                    out.confidence = "med"
        else                                             out.confidence = "low"
        return out
    }
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

function clamp(v, lo, hi, fallback) {
    if (v === null || !isFinite(v)) return fallback
    if (v < lo) return lo
    if (v > hi) return hi
    return v
}

if (typeof window !== "undefined") {
    window.RouteAssistantCompetitorIncome = RouteAssistantCompetitorIncome
}
