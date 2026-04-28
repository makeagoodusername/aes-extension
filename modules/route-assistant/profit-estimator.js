/**
 * Pure profit estimator for the Route Assistant.
 *
 * Given a route distance, an aircraft spec, and a small economics block, the
 * estimator returns:
 *   {fit, blockHours, profitPerFlight, profitPerWeek}
 *
 * The model is intentionally rough — labelled as such in the UI. v1 covers:
 *   - Pax revenue: seats × loadFactor × yieldPerKm × distance × 2 (round trip)
 *   - Fuel cost:   fuelCostPerHour × blockHours
 *   - Block hours: distance × 2 / speed + 0.5h fixed taxi/approach
 *   - Fall-off zone: revenue scaled by `falloffYieldMultiplier`
 *   - Out-of-range: blocked at 95% of max range (matching ScheduleFactors)
 *
 * Cargo aircraft (seats null but cargoCapacity > 0) skip profit but still
 * report fit + block hours so the user sees the route is reachable.
 *
 * Things deliberately out of scope (see HANDOVER §7 backburner):
 *   - Cargo revenue contribution
 *   - Crew, maintenance, leasing/loan service
 *   - Per-route load factors / yield curves
 *   - Realistic payload-range tradeoff (seats × LF should drop in falloff zone)
 */
class RouteAssistantProfitEstimator {
    static SAFETY_MARGIN = 0.95   // matches ScheduleFactors.aircraftCanFly
    static FIXED_TURN_HOURS = 0.5 // round-trip taxi+approach overhead

    /**
     * @param {object} input
     * @param {number} input.distanceKm
     * @param {object} input.spec       aircraft type spec {seats, range, speed, cargoCapacity}
     * @param {number} [input.frequency=0]    user's weekly frequency on the route
     * @param {number} [input.paxScore]       AS in-game pax demand 0-10. Drives load factor.
     * @param {object} input.economics        {loadFactor, loadFactorMin, loadFactorMax,
     *                                         yieldPerKm, fuelCostPerHour, falloffYieldMultiplier}
     * @param {number} [input.falloffPct=10]  amber-zone width (% of max range)
     * @param {object} [input.interlineShares] H 3b.2 — `{paxPercent, cargoPercent}` to
     *                                         reduce effective LF by the share of
     *                                         capacity sold via interline / codeshare
     *                                         partners. Both values are clamped to
     *                                         [0, 100]; missing fields default to 0
     *                                         (no reduction). The reduction is
     *                                         applied AFTER LF is sourced from
     *                                         override / real-demand / score so the
     *                                         provenance attribution stays clean.
     * @returns {object} with `breakdown` exposing every term that fed into profit
     *   so the UI can show the full math in a tooltip.
     */
    static estimate(input) {
        const distanceKm = numOrNull(input && input.distanceKm)
        const spec       = (input && input.spec) || {}
        const econ       = (input && input.economics) || {}
        const override   = (input && input.override)  || null
        const freq       = Number((input && input.frequency) || 0)
        const paxScore   = numOrNull(input && input.paxScore)
        const cargoScore = numOrNull(input && input.cargoScore)
        const falloffPct = numOrNull(input && input.falloffPct)
        const falloff    = (falloffPct === null || falloffPct < 0) ? 10 : falloffPct
        // Letter K — opt-in real-demand inputs. When the user enables
        // `useRealDemandForLF`, these supersede the paxScore-interpolated
        // LF below. Both fields stay null on routes where the demand-
        // depth scrape hasn't run, in which case we silently fall back
        // to the paxScore path so existing behaviour is preserved.
        const useRealDemand    = !!(input && input.useRealDemandForLF)
        const paxDemandPool    = numOrNull(input && input.paxDemandPool)
        const cargoDemandPool  = numOrNull(input && input.cargoDemandPool)
        const overridePaxLF      = override ? numOrNull(override.paxLF)             : null
        const overrideCargoLF    = override ? numOrNull(override.cargoLF)           : null
        const overrideYield      = override ? numOrNull(override.yieldPerKm)        : null
        const overrideCargoYield = override ? numOrNull(override.cargoYieldPerKgKm) : null

        const range = numOrNull(spec.range)
        const speed = numOrNull(spec.speed)
        const seats = numOrNull(spec.seats)
        const cargo = numOrNull(spec.cargoCapacity)

        const result = {
            fit: "optimal",
            blockHours: null,
            profitPerFlight: null,
            profitPerWeek: null,
            isCargoOnly: false,
            specOk: false,
            breakdown: null
        }

        if (distanceKm === null || range === null) return result
        result.specOk = true

        const safeRange    = range * RouteAssistantProfitEstimator.SAFETY_MARGIN
        const optimalRange = range * (1 - falloff / 100)
        if (distanceKm > safeRange)         result.fit = "oor"
        else if (distanceKm > optimalRange) result.fit = "falloff"
        else                                result.fit = "optimal"

        if (speed && speed > 0) {
            result.blockHours = round2((distanceKm * 2) / speed + RouteAssistantProfitEstimator.FIXED_TURN_HOURS)
        }

        const cargoOnly = (seats === null || seats === 0) && cargo && cargo > 0
        if (cargoOnly) result.isCargoOnly = true

        if (result.fit === "oor") return result
        if (result.blockHours === null) return result
        // Pure-pax aircraft with no spec is unusable (no seats, no cargo).
        if (!cargoOnly && (seats === null || seats <= 0) && (!cargo || cargo <= 0)) return result

        // ---------- Pax load factor (demand-driven) ----------
        const paxLfMin       = clamp(numOrNull(econ.loadFactorMin), 0, 1, 0.50)
        const paxLfMax       = clamp(numOrNull(econ.loadFactorMax), 0, 1, 0.95)
        const paxLfFallback  = clamp(numOrNull(econ.loadFactor),    0, 1, (paxLfMin + paxLfMax) / 2)

        let paxLoadFactor, paxLfSource
        // Weekly aircraft seat capacity = seats × frequency. Used by
        // the real-demand path to translate "pool size" (estimated
        // bookings/week) into an LF for THIS aircraft + frequency.
        const paxWeeklyCap = (seats > 0 && freq > 0) ? (seats * freq) : null
        if (overridePaxLF !== null) {
            paxLoadFactor = clamp(overridePaxLF, 0, 1, paxLfFallback)
            paxLfSource   = "override"
        } else if (useRealDemand && paxDemandPool !== null && paxWeeklyCap !== null) {
            // Real demand-pool path (Letter K). LF = demand / capacity,
            // clamped to [paxLfMin, paxLfMax] so a single noisy week
            // doesn't push the model to 100% or 0%.
            const ratio = paxDemandPool / paxWeeklyCap
            paxLoadFactor = clamp(ratio, paxLfMin, paxLfMax, paxLfFallback)
            paxLfSource   = "real-demand"
        } else if (paxScore !== null && paxLfMax >= paxLfMin) {
            paxLoadFactor = paxLfMin + Math.max(0, Math.min(1, paxScore / 10)) * (paxLfMax - paxLfMin)
            paxLfSource   = "demand"
        } else {
            paxLoadFactor = paxLfFallback
            paxLfSource   = "fallback"
        }

        // ---------- Cargo load factor (demand-driven) ----------
        const cargoLfMin      = clamp(numOrNull(econ.cargoLoadFactorMin), 0, 1, 0.40)
        const cargoLfMax      = clamp(numOrNull(econ.cargoLoadFactorMax), 0, 1, 0.85)
        const cargoLfFallback = clamp(numOrNull(econ.cargoLoadFactor),    0, 1, (cargoLfMin + cargoLfMax) / 2)

        let cargoLoadFactor, cargoLfSource
        const cargoWeeklyCap = (cargo > 0 && freq > 0) ? (cargo * freq) : null
        if (overrideCargoLF !== null) {
            cargoLoadFactor = clamp(overrideCargoLF, 0, 1, cargoLfFallback)
            cargoLfSource   = "override"
        } else if (useRealDemand && cargoDemandPool !== null && cargoWeeklyCap !== null) {
            const ratio = cargoDemandPool / cargoWeeklyCap
            cargoLoadFactor = clamp(ratio, cargoLfMin, cargoLfMax, cargoLfFallback)
            cargoLfSource   = "real-demand"
        } else if (cargoScore !== null && cargoLfMax >= cargoLfMin) {
            cargoLoadFactor = cargoLfMin + Math.max(0, Math.min(1, cargoScore / 10)) * (cargoLfMax - cargoLfMin)
            cargoLfSource   = "demand"
        } else {
            cargoLoadFactor = cargoLfFallback
            cargoLfSource   = "fallback"
        }

        // ---------- Interline-share reduction (H slice 3b.2) ----------
        // Capacity sold via codeshare / interline partners doesn't accrue
        // to our airline's revenue line, so we trim effective LF by the
        // recorded share. Computed AFTER the source-attributed LF above
        // so paxLfSource / cargoLfSource still reflect "where the LF
        // came from" and the reduction is observable as a separate term
        // in the breakdown.
        const interlineShares = (input && input.interlineShares) || null
        const paxInterlinePct = clamp(
            numOrNull(interlineShares && interlineShares.paxPercent), 0, 100, 0)
        const cargoInterlinePct = clamp(
            numOrNull(interlineShares && interlineShares.cargoPercent), 0, 100, 0)
        const paxLoadFactorPreInterline   = paxLoadFactor
        const cargoLoadFactorPreInterline = cargoLoadFactor
        if (paxInterlinePct > 0)   paxLoadFactor   *= (1 - paxInterlinePct   / 100)
        if (cargoInterlinePct > 0) cargoLoadFactor *= (1 - cargoInterlinePct / 100)

        // ---------- Yields (with optional demand modulation) ----------
        // Demand sensitivity 0-1: at sensitivity=0 yield is flat (backward
        // compatible). At sensitivity=1, yield ranges ±20% by demand
        // (clamped to [0.5x, 1.5x] so an extreme score never inverts the
        // sign or zero-outs revenue).
        // Override beats configured base yield. Demand modulation still
        // applies on top — the override is the "calibrated unmodulated yield"
        // for this route. Set sensitivity to 0 alongside the override if the
        // overridden number already factors in observed demand.
        const baseYieldPerKm          = Math.max(0, numOrNull(econ.yieldPerKm)        || 0.10)
        const baseCargoYieldPerKgKm   = Math.max(0, numOrNull(econ.cargoYieldPerKgKm) || 0)
        const yieldPerKm        = overrideYield      !== null ? Math.max(0, overrideYield)      : baseYieldPerKm
        const cargoYieldPerKgKm = overrideCargoYield !== null ? Math.max(0, overrideCargoYield) : baseCargoYieldPerKgKm
        const yieldSource       = overrideYield      !== null ? "override" : "base"
        const cargoYieldSource  = overrideCargoYield !== null ? "override" : "base"
        const yieldDemandSensitivity    = clamp(numOrNull(econ.yieldDemandSensitivity),         0, 1, 0)
        const cargoYieldDemandSens      = clamp(numOrNull(econ.cargoYieldDemandSensitivity),    0, 1, 0)
        const yieldDemandMult     = (yieldDemandSensitivity > 0 && paxScore !== null)
            ? clamp(1 + yieldDemandSensitivity * (paxScore - 5) / 5, 0.5, 1.5, 1)
            : 1
        const cargoYieldDemandMult = (cargoYieldDemandSens > 0 && cargoScore !== null)
            ? clamp(1 + cargoYieldDemandSens * (cargoScore - 5) / 5, 0.5, 1.5, 1)
            : 1
        const effectivePaxYield   = yieldPerKm * yieldDemandMult
        const effectiveCargoYield = cargoYieldPerKgKm * cargoYieldDemandMult

        // ---------- Costs ----------
        // Aircraft age comes from the fleet record. Per-tail mode → exact tail
        // age. Per-type / Fleet mode → average age across owned aircraft of
        // that type. When age + penalty are both > 0, fuel-per-hour scales
        // linearly: a 12-year-old plane at 0.5%/year burns 6% more than new.
        const aircraftAge            = numOrNull((input && input.aircraftAge) != null ? input.aircraftAge : spec.aircraftAge)
        const fuelAgePenaltyPerYear  = Math.max(0, numOrNull(econ.fuelAgePenaltyPerYear) || 0)
        const ageFuelMult = (fuelAgePenaltyPerYear > 0 && aircraftAge !== null && aircraftAge > 0)
            ? Math.min(2, 1 + fuelAgePenaltyPerYear * aircraftAge)
            : 1

        const baseFuelPerHour        = Math.max(0, numOrNull(econ.fuelCostPerHour)        || 2500)
        const effectiveFuelPerHour   = baseFuelPerHour * ageFuelMult
        const crewCostPerHour        = Math.max(0, numOrNull(econ.crewCostPerHour)        || 0)
        const maintenanceCostPerHour = Math.max(0, numOrNull(econ.maintenanceCostPerHour) || 0)
        const otherFixedPerFlight    = Math.max(0, numOrNull(econ.otherFixedPerFlight)    || 0)
        const falloffMult            = clamp(numOrNull(econ.falloffYieldMultiplier), 0, 1.5, 0.85)
        const yieldMult              = result.fit === "falloff" ? falloffMult : 1

        const distanceRoundTripKm = distanceKm * 2
        const paxSeats   = (seats > 0) ? seats : 0
        const paxRevenue = paxSeats > 0
            ? paxSeats * paxLoadFactor * effectivePaxYield * distanceRoundTripKm * yieldMult
            : 0
        const cargoKg    = cargo > 0 ? cargo : 0
        const cargoRevenue = (cargoKg > 0 && effectiveCargoYield > 0)
            ? cargoKg * cargoLoadFactor * effectiveCargoYield * distanceRoundTripKm * yieldMult
            : 0
        const revenue = paxRevenue + cargoRevenue

        // ---------- Fuel cost: distance-based when AS price + spec available ----------
        // Preferred path: AS computes fuel as (cycle_L + per_km_L × dist) ×
        // priceASc / 100. We use that when the user's enabled the per-type
        // model AND we have a current AS price AND the spec is usable.
        // Otherwise fall back to the legacy time-based model so existing
        // setups keep working.
        const useDistanceFuel = !!(input && input.useDistanceFuel)
        const fuelPriceASc    = numOrNull(input && input.fuelPriceASc)
        let fuelL = null, fuelCost, fuelMethod
        if (useDistanceFuel && fuelPriceASc && fuelPriceASc > 0
                && typeof RouteAssistantFuelBurn !== "undefined") {
            const burn = RouteAssistantFuelBurn.estimate(spec, input && input.fuelBurnOverrides)
            if (burn) {
                const cost = RouteAssistantFuelBurn.costPerFlight(
                    burn, distanceKm, fuelPriceASc, ageFuelMult
                )
                if (cost) {
                    fuelL    = cost.fuelL
                    fuelCost = cost.fuelCost
                    fuelMethod = "perType"
                }
            }
        }
        if (fuelCost === undefined) {
            fuelCost = effectiveFuelPerHour * result.blockHours
            fuelMethod = "perHour"
        }
        const crewCost            = crewCostPerHour * result.blockHours
        const maintenanceCost     = maintenanceCostPerHour * result.blockHours
        const totalCost           = fuelCost + crewCost + maintenanceCost + otherFixedPerFlight
        const profit              = Math.round(revenue - totalCost)

        // Cargo-only aircraft show profit only when the user has enabled
        // cargo yield. Otherwise leave null so the cell falls back to "—"
        // with the existing "cargo aircraft" tooltip.
        const profitDefined = cargoOnly ? (cargoYieldPerKgKm > 0) : (paxSeats > 0 || cargoYieldPerKgKm > 0)
        if (profitDefined) {
            result.profitPerFlight = profit
            if (freq > 0) result.profitPerWeek = Math.round(profit * freq)
        }

        result.breakdown = {
            seats:                    paxSeats,
            cargoCapacityKg:          cargoKg,
            speed:                    speed,
            distanceKm:               distanceKm,
            distanceRoundTripKm:      distanceRoundTripKm,
            paxScore:                 paxScore,
            cargoScore:               cargoScore,
            paxLoadFactor:                round3(paxLoadFactor),
            paxLoadFactorSource:          paxLfSource,
            paxLoadFactorPreInterline:    round3(paxLoadFactorPreInterline),
            paxInterlineSharePercent:     paxInterlinePct,
            cargoLoadFactor:              round3(cargoLoadFactor),
            cargoLoadFactorSource:        cargoLfSource,
            cargoLoadFactorPreInterline:  round3(cargoLoadFactorPreInterline),
            cargoInterlineSharePercent:   cargoInterlinePct,
            yieldPerKm:               yieldPerKm,
            yieldSource:              yieldSource,
            cargoYieldSource:         cargoYieldSource,
            hasOverride:              !!override,
            overrideNote:             (override && override.note) || null,
            effectivePaxYield:        round4(effectivePaxYield),
            yieldDemandMultiplier:    round3(yieldDemandMult),
            yieldDemandSensitivity:   yieldDemandSensitivity,
            cargoYieldPerKgKm:        cargoYieldPerKgKm,
            effectiveCargoYield:      round4(effectiveCargoYield),
            cargoYieldDemandMultiplier: round3(cargoYieldDemandMult),
            cargoYieldDemandSens:     cargoYieldDemandSens,
            yieldMultiplier:          yieldMult,
            paxRevenue:               Math.round(paxRevenue),
            cargoRevenue:             Math.round(cargoRevenue),
            revenue:                  Math.round(revenue),
            blockHours:               result.blockHours,
            aircraftAge:              aircraftAge,
            fuelAgePenaltyPerYear:    fuelAgePenaltyPerYear,
            ageFuelMultiplier:        round3(ageFuelMult),
            fuelCostPerHour:          baseFuelPerHour,
            effectiveFuelPerHour:     Math.round(effectiveFuelPerHour),
            fuelCost:                 Math.round(fuelCost),
            fuelMethod:               fuelMethod,
            fuelLiters:               fuelL !== null ? Math.round(fuelL) : null,
            fuelPriceASc:             fuelPriceASc,
            crewCostPerHour:          crewCostPerHour,
            crewCost:                 Math.round(crewCost),
            maintenanceCostPerHour:   maintenanceCostPerHour,
            maintenanceCost:          Math.round(maintenanceCost),
            otherFixedPerFlight:      otherFixedPerFlight,
            totalCost:                Math.round(totalCost),
            profitPerFlight:          result.profitPerFlight,
            frequency:                freq,
            profitPerWeek:            result.profitPerWeek
        }
        return result
    }

    /**
     * Pick the most-economical fleet aircraft for a given distance.
     *
     * "Most economical" = the aircraft with the smallest range that still
     * achieves the best fit class for this distance. This avoids assigning a
     * 777 to a 1500 km regional just because the 777 happens to be the
     * longest-ranged thing in the fleet.
     *
     * @param {Array<object>} specs   array of aircraft type specs (each must have range)
     * @param {number} distanceKm
     * @param {number} [falloffPct=10]
     * @returns {{spec, fit}|null}
     */
    static pickEconomical(specs, distanceKm, falloffPct) {
        const dist = numOrNull(distanceKm)
        if (dist === null || !Array.isArray(specs) || !specs.length) return null
        const falloff = (falloffPct === null || falloffPct === undefined || falloffPct < 0) ? 10 : falloffPct

        const ranked = []
        for (const s of specs) {
            const range = numOrNull(s && s.range)
            if (range === null) continue
            const safe    = range * RouteAssistantProfitEstimator.SAFETY_MARGIN
            const optimal = range * (1 - falloff / 100)
            let fit
            if (dist > safe)         fit = "oor"
            else if (dist > optimal) fit = "falloff"
            else                     fit = "optimal"
            ranked.push({spec: s, range: range, fit: fit})
        }
        if (!ranked.length) return null

        // Find the best fit class present in the fleet.
        const order = {optimal: 3, falloff: 2, oor: 1}
        let bestClass = "oor"
        for (const r of ranked) {
            if (order[r.fit] > order[bestClass]) bestClass = r.fit
        }
        // Within that class, pick the smallest-range aircraft.
        const candidates = ranked.filter(r => r.fit === bestClass)
        candidates.sort((a, b) => a.range - b.range)
        return {spec: candidates[0].spec, fit: candidates[0].fit}
    }
}

// ---------- Helpers ----------

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

function round2(v) {
    return Math.round(v * 100) / 100
}

function round3(v) {
    return Math.round(v * 1000) / 1000
}

function round4(v) {
    return Math.round(v * 10000) / 10000
}
