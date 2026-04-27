"use strict"

/**
 * Pure-function deal metrics for the Used Aircraft Scanner — slice 2 of J.
 *
 * Inputs are an offer row (shape produced by content_marketScan.js +
 * type-spec enrichment) plus optional context (RA economics block, fleet
 * inventory, top-routes cache). All helpers return null when their inputs
 * are missing — the table renders an em-dash so missing data never hides
 * an offer entirely.
 *
 * Why one module: every metric is consumed in two places (the score blend
 * inside results-table.js and the rendered cell), and they share helpers
 * for picking the cheapest available price + flight-hour budgets. Keeping
 * the logic in one file avoids two places to update when the formula
 * shifts.
 */
class MarketScanDealMetrics {

    /**
     * Daily block-hour budget assumed by the break-even estimator. Varies
     * by aircraft category — small regionals turn fewer hours/day than
     * widebodies. Reads `row.familyCategory` (set by `_enrichFamily`
     * before `decorate()`) and falls back to the legacy 10h default for
     * rows without a category. Conservative middle values per band so the
     * metric reads as "earliest sensible payback" rather than optimistic.
     */
    static BLOCK_HOURS_BY_CATEGORY = {
        commuter:   8,
        turboprop:  8,
        regional:   8,
        narrowbody: 12,
        widebody:   14
    }
    static DAILY_BLOCK_HOURS = 10  // legacy fallback / external alias

    static _blockHoursFor(row) {
        const cat = row && row.familyCategory
        const h = cat && MarketScanDealMetrics.BLOCK_HOURS_BY_CATEGORY[cat]
        return isFiniteNumber(h) && h > 0 ? h : MarketScanDealMetrics.DAILY_BLOCK_HOURS
    }

    /**
     * Maximum service life used by `seatKmYearCost`. Most AS players
     * retire well before this; 25 years is the upper bound on what
     * remaining-life can contribute to the lifecycle ratio.
     */
    static MAX_LIFE_YEARS = 25

    /**
     * Picks the cheapest upfront acquisition price available on an offer.
     * Leasing is excluded — it's a recurring cost, not an acquisition price,
     * so mixing it into "$/seat" makes auctions look artificially better
     * than outright sales.
     */
    static acquisitionPrice(row) {
        if (!row) return null
        const candidates = [row.nextBid, row.immediatePurchase].filter(v => isFiniteNumber(v) && v > 0)
        if (!candidates.length) return null
        return Math.min.apply(null, candidates)
    }

    /**
     * AS$ per seat — purchase efficiency. Lower is better.
     */
    static pricePerSeat(row) {
        const price = MarketScanDealMetrics.acquisitionPrice(row)
        const seats = numOrNull(row && row.seats)
        if (price === null || seats === null || seats <= 0) return null
        return Math.round(price / seats)
    }

    /**
     * Lifecycle cost ratio: AS$ per seat per km of range per remaining
     * year of service. Captures price, capacity, range, and remaining
     * life in a single number. Lower is better.
     *
     * Remaining life floor is 1 year so a 25-year-old aircraft doesn't
     * divide by zero — instead it's penalised by the seatKm denominator.
     */
    static seatKmYearCost(row) {
        const b = MarketScanDealMetrics.seatKmYearCostBreakdown(row)
        return b ? b.value : null
    }

    /**
     * Same calculation as `seatKmYearCost` but returns the inputs alongside
     * the value so the table can render a "why" tooltip.
     *
     *   {value, price, seats, range, age, remainingYears}
     *
     * Returns null only when the value can't be computed (matching
     * `seatKmYearCost`'s null contract). This ordering matches the formula
     * shown in the tooltip: price ÷ (seats × range × remainingYears).
     */
    static seatKmYearCostBreakdown(row) {
        const price = MarketScanDealMetrics.acquisitionPrice(row)
        const seats = numOrNull(row && row.seats)
        const range = numOrNull(row && row.range)
        const age   = numOrNull(row && row.ageYears)
        if (price === null || seats === null || seats <= 0) return null
        if (range === null || range <= 0) return null
        const remaining = Math.max(1, MarketScanDealMetrics.MAX_LIFE_YEARS - (age || 0))
        const value = Math.round((price / (seats * range * remaining)) * 10000) / 10000
        return {
            value:          value,
            price:          price,
            seats:          seats,
            range:          range,
            age:            age,
            remainingYears: remaining,
            maxLifeYears:   MarketScanDealMetrics.MAX_LIFE_YEARS
        }
    }

    /**
     * Days-to-break-even at the user's current Route Assistant economics.
     *
     * Models a representative day: DAILY_BLOCK_HOURS of flight time at
     * the aircraft's cruise speed, pax revenue at panel-yield × LF,
     * cargo revenue at panel-cargo-yield × cargo-LF, less fuel/crew/
     * maintenance per block hour. Returns the integer days for the
     * acquisition price to be recouped from net daily profit.
     *
     * Returns null when:
     *   - Economics block missing
     *   - Acquisition price missing
     *   - Aircraft speed/seats missing
     *   - Daily profit ≤ 0 (uneconomic at these settings)
     *
     * The ≤0 case is deliberately surfaced as null rather than Infinity
     * so the score blend ignores the row instead of clamping it to the
     * worst-rank slot.
     */
    static daysToBreakEven(row, economics) {
        const b = MarketScanDealMetrics.daysToBreakEvenBreakdown(row, economics)
        return b ? b.value : null
    }

    /**
     * Same calculation as `daysToBreakEven` but returns the full input set +
     * derived intermediates ($/day pax revenue, $/day cargo revenue, $/day
     * operating cost) so the table can show users exactly what produced the
     * payback estimate.
     *
     * Returns null when the value can't be computed (no economics, missing
     * spec, daily profit ≤ 0). Uneconomic rows still surface a *partial*
     * breakdown internally; the public API normalises to null so the cell
     * stays an em-dash and the score blend skips the row.
     */
    static daysToBreakEvenBreakdown(row, economics) {
        if (!row || !economics) return null
        const price = MarketScanDealMetrics.acquisitionPrice(row)
        if (price === null) return null
        const speed = numOrNull(row.speed)
        const seats = numOrNull(row.seats)
        if (speed === null || speed <= 0) return null
        if (seats === null || seats <= 0) return null

        const lf       = numOrDefault(economics.loadFactor, 0.75)
        const yieldKm  = numOrDefault(economics.yieldPerKm, 0)
        const cargo    = numOrNull(row.cargoCapacity) || 0
        const cargoLf  = numOrDefault(economics.cargoLoadFactor, 0)
        const cargoY   = numOrDefault(economics.cargoYieldPerKgKm, 0)

        const fuel  = numOrDefault(economics.fuelCostPerHour, 0)
        const crew  = numOrDefault(economics.crewCostPerHour, 0)
        const maint = numOrDefault(economics.maintenanceCostPerHour, 0)

        const hours       = MarketScanDealMetrics._blockHoursFor(row)
        const dailyKm     = hours * speed
        const paxRev      = dailyKm * seats  * lf      * yieldKm
        const cargoRev    = dailyKm * cargo  * cargoLf * cargoY
        const opCost      = hours   * (fuel + crew + maint)
        const profitPerDay = paxRev + cargoRev - opCost
        if (!isFinite(profitPerDay) || profitPerDay <= 0) return null
        return {
            value:        Math.round(price / profitPerDay),
            price:        price,
            speed:        speed,
            seats:        seats,
            cargo:        cargo,
            hours:        hours,
            dailyKm:      dailyKm,
            loadFactor:   lf,
            yieldPerKm:   yieldKm,
            cargoLoadFactor:    cargoLf,
            cargoYieldPerKgKm:  cargoY,
            fuelPerHour:  fuel,
            crewPerHour:  crew,
            maintPerHour: maint,
            paxRev:       paxRev,
            cargoRev:     cargoRev,
            opCost:       opCost,
            profitPerDay: profitPerDay
        }
    }

    /**
     * Fleet synergy lookup. Returns:
     *   {owned: true,  count, label}  if the offer's typeId is already in
     *                                 the user's fleet
     *   {owned: false, label: null}   otherwise (caller renders em-dash)
     *   null                          when fleet context is unavailable
     *
     * Synergy is binary by typeId — same type = no extra training,
     * shared maintenance, common parts pool. Family-level synergy
     * (different type, same family) is intentionally NOT counted; AS
     * doesn't share crew ratings across types within a family.
     */
    static fleetSynergy(row, fleetByType) {
        if (!fleetByType) return null
        if (!row || !row.typeId) return {owned: false, count: 0, label: null}
        const slot = fleetByType.get
            ? fleetByType.get(row.typeId)
            : fleetByType[row.typeId]
        if (!slot) return {owned: false, count: 0, label: null}
        const count = slot.count || 0
        return {owned: count > 0, count: count, label: count > 0 ? ("✓ " + count) : null}
    }

    /**
     * Route-fit cross-link. Counts how many of the user's top-N scored
     * Route Assistant routes the offer's aircraft can profitably fly.
     *
     * v1 (J slice 2) checked range only. v2 added per-flight demand
     * (seats × LF ≥ paxScore × paxSeatsPerScorePoint). v3 (J slice 4)
     * adds the weekly-frequency gate using the `weeklyFlights` field
     * already published on `topRoutes`: a small regional that fits one
     * flight's demand can still fail at a route that's flown 14×/wk by a
     * widebody. Three sequential gates per route — range, per-flight
     * demand, weekly frequency — counted separately so the tooltip
     * surfaces *why* a route was rejected.
     *
     * Routes lacking `weeklyFlights` skip the frequency gate (no penalty)
     * because we'd rather under-count than penalise routes that haven't
     * been scraped via Tier 1 yet.
     *
     * Returns:
     *   {fit, total, label,
     *    rangeOnly,           // passes range check
     *    demandLimited,       // range fits but seats×LF < paxScore×scale
     *    frequencyLimited,    // demand fits but wf×seats×LF < paxScore×wScale
     *    weeklyDemandPerScorePoint}  // echoed for the tooltip
     *   null when topRoutes is unavailable.
     *
     * Routes with unknown distanceKm are excluded from the denominator
     * — they don't help or hurt the fit count.
     *
     * @param {object} options
     *   {loadFactor, paxSeatsPerScorePoint, weeklyDemandPerScorePoint}
     *   — falls back to defaults of 0.75, 15, and 100.
     */
    static routeFit(row, topRoutes, options) {
        if (!Array.isArray(topRoutes)) return null
        const range = numOrNull(row && row.range)
        const seats = numOrNull(row && row.seats)
        const known = topRoutes.filter(r => r && isFiniteNumber(r.distanceKm) && r.distanceKm > 0)
        const total = known.length
        if (total === 0) {
            return {fit: 0, total: 0, label: "0 / 0",
                    rangeOnly: 0, demandLimited: 0, frequencyLimited: 0,
                    weeklyDemandPerScorePoint: null}
        }
        if (range === null || range <= 0) {
            return {fit: null, total: total, label: "—",
                    rangeOnly: null, demandLimited: 0, frequencyLimited: 0,
                    weeklyDemandPerScorePoint: null}
        }

        const lf       = numOrDefault(options && options.loadFactor, 0.75)
        const scale    = numOrDefault(options && options.paxSeatsPerScorePoint, 15)
        const wScale   = numOrDefault(options && options.weeklyDemandPerScorePoint, 100)
        const effSeats = (seats !== null && seats > 0) ? seats * lf : null

        let fit = 0
        let rangeOnly = 0
        let demandLimited = 0
        let frequencyLimited = 0
        for (const r of known) {
            if (r.distanceKm > range) continue
            rangeOnly++
            const ps = numOrNull(r.paxScore)
            if (ps !== null && ps > 0 && effSeats !== null) {
                if (effSeats < ps * scale) {
                    demandLimited++
                    continue
                }
                const wf = numOrNull(r.weeklyFlights)
                if (wf !== null && wf > 0 && wf * effSeats < ps * wScale) {
                    frequencyLimited++
                    continue
                }
            }
            fit++
        }
        const parts = []
        if (demandLimited > 0)    parts.push("−" + demandLimited + " demand")
        if (frequencyLimited > 0) parts.push("−" + frequencyLimited + " freq")
        const label = parts.length
            ? fit + " / " + total + "  (" + parts.join(", ") + ")"
            : fit + " / " + total
        return {
            fit: fit, total: total, label: label,
            rangeOnly: rangeOnly,
            demandLimited: demandLimited,
            frequencyLimited: frequencyLimited,
            weeklyDemandPerScorePoint: wScale
        }
    }

    /**
     * Maintenance trajectory pill. Rolls condition + age into a coarse
     * red / amber / green signal for at-a-glance scanning.
     *
     * Bands chosen so:
     *   green — fresh fleet candidate (<10y, ≥80% condition)
     *   amber — workable middle ground
     *   red   — needs heavy maintenance soon OR near retirement
     *
     * Returns {level, label, color} or null if both inputs missing.
     */
    static maintenanceTrajectory(row) {
        const cond = numOrNull(row && row.conditionPct)
        const age  = numOrNull(row && row.ageYears)
        if (cond === null && age === null) return null

        // Worst-case rule wins — a 5-year-old plane at 30% condition is
        // still a red regardless of its age.
        if ((cond !== null && cond < 50) || (age !== null && age >= 25)) {
            return {level: "red", label: "Heavy", color: "#dc2626"}
        }
        if ((cond !== null && cond < 75) || (age !== null && age >= 15)) {
            return {level: "amber", label: "Mid-life", color: "#d97706"}
        }
        return {level: "green", label: "Fresh", color: "#16a34a"}
    }

    /**
     * Convenience: compute every metric for a row in one pass and
     * decorate the row in-place with named scalars/labels suitable for
     * the table renderer. Mutates and returns the row for chaining.
     *
     * Decorated keys:
     *   pricePerSeat        — number | null
     *   seatKmYearCost      — number | null
     *   breakEvenDays       — number | null
     *   fleetOwned          — true | false | null   (null = no fleet ctx)
     *   fleetOwnedCount     — number | null
     *   routeFitCount       — number | null         (null = no topRoutes)
     *   routeFitTotal       — number | null
     *   routeFitLabel       — "x / y" | "—" | null
     *   routeFitRangeOnly         — number | null
     *   routeFitDemandLimited     — number | null
     *   routeFitFrequencyLimited  — number | null
     *   routeFitWeeklyScale       — number | null   (echoed weeklyDemandPerScorePoint)
     *   maintLevel          — "green" | "amber" | "red" | null
     *   maintLabel          — "Fresh" | "Mid-life" | "Heavy" | null
     *   maintColor          — hex string | null
     */
    static decorate(row, ctx) {
        ctx = ctx || {}
        row.pricePerSeat   = MarketScanDealMetrics.pricePerSeat(row)
        const seatKm = MarketScanDealMetrics.seatKmYearCostBreakdown(row)
        row.seatKmYearCost      = seatKm ? seatKm.value : null
        row.seatKmYearBreakdown = seatKm
        const be = MarketScanDealMetrics.daysToBreakEvenBreakdown(row, ctx.economics)
        row.breakEvenDays      = be ? be.value : null
        row.breakEvenBreakdown = be

        const synergy = MarketScanDealMetrics.fleetSynergy(row, ctx.fleetByType)
        row.fleetOwned       = synergy ? synergy.owned : null
        row.fleetOwnedCount  = synergy ? synergy.count : null
        row.fleetLabel       = synergy ? synergy.label : null

        const fit = MarketScanDealMetrics.routeFit(row, ctx.topRoutes, {
            loadFactor:                ctx.economics && ctx.economics.loadFactor,
            paxSeatsPerScorePoint:     ctx.routeFitConfig && ctx.routeFitConfig.paxSeatsPerScorePoint,
            weeklyDemandPerScorePoint: ctx.routeFitConfig && ctx.routeFitConfig.weeklyDemandPerScorePoint
        })
        row.routeFitCount            = fit ? fit.fit : null
        row.routeFitTotal            = fit ? fit.total : null
        row.routeFitLabel            = fit ? fit.label : null
        row.routeFitRangeOnly        = fit ? fit.rangeOnly : null
        row.routeFitDemandLimited    = fit ? fit.demandLimited : null
        row.routeFitFrequencyLimited = fit ? fit.frequencyLimited : null
        row.routeFitWeeklyScale      = fit ? fit.weeklyDemandPerScorePoint : null

        const maint = MarketScanDealMetrics.maintenanceTrajectory(row)
        row.maintLevel = maint ? maint.level : null
        row.maintLabel = maint ? maint.label : null
        row.maintColor = maint ? maint.color : null
        // Numeric rank for sorting (1 = best). String "green"/"amber"/"red"
        // would sort alphabetically — meaningless for a quality signal.
        row.maintRank  = maint ? ({green: 1, amber: 2, red: 3}[maint.level] || null) : null
        return row
    }
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

function numOrDefault(v, fallback) {
    const n = numOrNull(v)
    return n === null ? fallback : n
}

function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v)
}
