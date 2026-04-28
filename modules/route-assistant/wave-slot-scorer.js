/**
 * F slice 3 — Wave Slot Scorer.
 *
 * Pure (route × wave-slot) scoring for the per-slot profit assignment
 * mode in `ScheduleBuilder._assignRoutesProfit`. Decouples "is this
 * route a good fit for THIS slot in THIS plan" from the assignment loop
 * itself so the algorithm stays simple and testable.
 *
 * The score combines five signals — range fit, profit fit, demand-hour
 * fit, aircraft availability, connection value — with the weights tuned
 * so that range/aircraft act as gates (low score → essentially viable=false)
 * and profit/demand drive the marginal ranking among viable candidates.
 *
 * No DOM, no I/O. Caller passes a context bag holding the precomputed
 * cross-route data (adjacency matrix, demand profile, fleet specs).
 */
class RouteAssistantWaveSlotScorer {

    /**
     * Score one (route, wave) candidate.
     *
     * @param {object} route - {destination, distanceNm, _scoredRow?}
     * @param {object} wave  - preset wave record
     * @param {object} ctx
     *   - preset:                 active preset
     *   - selectedSpec:           aircraft spec (single-aircraft mode)
     *   - fleetSpecs:             array of fleet specs (fleet mode)
     *   - profitMax:              top profitPerWeek across rows (anchor)
     *   - adjacencyMatrix:        Map<waveId, Set<waveId>> — connectable waves
     *   - waveSlotsRemaining:     Map<waveId, {shortHaul, mediumHaul, longHaul}>
     *   - demandHourMap:          {hour → demand 0-1} or null
     * @returns {{
     *   score: number,        // 0-100, post-weight
     *   breakdown: {rangeFit, profitFit, demandHourFit,
     *               aircraftAvailability, connectionValue},
     *   viable: boolean,
     *   marginalProfit: number,
     *   reasons: Array<string>,
     *   bucket: string|null
     * }}
     */
    static scoreSlotFit(route, wave, ctx) {
        const c = ctx || {}
        const result = {
            score: 0, viable: false, marginalProfit: 0,
            reasons: [], bucket: null,
            breakdown: {
                rangeFit: 0, profitFit: 0, demandHourFit: 0,
                aircraftAvailability: 0, connectionValue: 0
            }
        }
        if (!route || !wave) return result

        const buckets = (c.preset && c.preset.factors && c.preset.factors.rangeBuckets)
            || (typeof ScheduleFactors !== "undefined"
                ? ScheduleFactors.defaultRangeBuckets() : null)
        const bucket = (typeof ScheduleFactors !== "undefined" && buckets)
            ? ScheduleFactors.bucketize(route.distanceNm, buckets)
            : null
        result.bucket = bucket
        if (!bucket) {
            result.reasons.push("Distance not in any bucket.")
            return result
        }

        const spare = c.waveSlotsRemaining && c.waveSlotsRemaining.get(wave.id)
        const wantedThisBucket = (wave.composition && wave.composition[bucket]) | 0
        const spareThisBucket = spare ? (spare[bucket] || 0) : wantedThisBucket
        if (wantedThisBucket === 0) {
            result.reasons.push("Wave " + (wave.label || "") + " has no "
                + bucket.replace("Haul", "-haul") + " capacity.")
            // Still scored but viable=false; lets the optimiser distinguish
            // "wrong bucket" from "wrong wave" if it ever wants to.
        }

        // ---- 1. Range fit ----
        const aircraftRangeNm = route.aircraftRangeNm
            || (c.selectedSpec && c.selectedSpec.range
                ? (typeof ScheduleFactors !== "undefined"
                    ? ScheduleFactors.kmToNm(c.selectedSpec.range)
                    : c.selectedSpec.range)
                : null)
        if (aircraftRangeNm && route.distanceNm) {
            if (route.distanceNm > aircraftRangeNm) {
                result.breakdown.rangeFit = 0
                result.reasons.push("Out of range for picked aircraft.")
            } else {
                const slack = (aircraftRangeNm - route.distanceNm) / aircraftRangeNm
                // Closer to range = lower fit (less margin); 30%+ slack is ideal.
                if (slack >= 0.3 && slack <= 0.6) result.breakdown.rangeFit = 100
                else if (slack > 0.6)             result.breakdown.rangeFit = 70  // overspec
                else                              result.breakdown.rangeFit =
                    Math.round(50 + slack * 100)
            }
        } else {
            // No aircraft → neutral.
            result.breakdown.rangeFit = 60
        }

        // ---- 2. Profit fit ----
        const row = route._scoredRow
        const prof = row && Number(row.profitPerWeek)
        if (isFinite(prof) && prof > 0 && c.profitMax > 0) {
            result.breakdown.profitFit = Math.max(0, Math.min(100,
                Math.round((prof / c.profitMax) * 100)))
            result.marginalProfit = prof
        } else if (isFinite(prof) && prof > 0) {
            result.breakdown.profitFit = 60
            result.marginalProfit = prof
        } else if (!c.selectedSpec
                && (!c.fleetSpecs || !c.fleetSpecs.length)) {
            // No fleet → can't estimate; use paxScore as a neutral proxy.
            const px = row && Number(row.paxScore)
            result.breakdown.profitFit = isFinite(px)
                ? Math.max(30, Math.min(80, Math.round(px * 8)))
                : 50
        } else {
            result.breakdown.profitFit = 30
        }

        // ---- 3. Demand-hour fit ----
        // The hub's per-hour demand profile is computed by Track 4's
        // slot-optimizer when available. v1: if no map provided, score
        // neutrally; if provided, score by the avg of demand[h] across
        // the wave's combined arrival+departure window.
        if (c.demandHourMap) {
            const arrStart = (typeof ScheduleFactors !== "undefined" && wave.arrivalWindow)
                ? ScheduleFactors.parseHHMM(wave.arrivalWindow.start) : NaN
            const depEnd   = (typeof ScheduleFactors !== "undefined" && wave.departureWindow)
                ? ScheduleFactors.parseHHMM(wave.departureWindow.end) : NaN
            if (isFinite(arrStart) && isFinite(depEnd) && depEnd > arrStart) {
                let sum = 0, n = 0
                const h0 = Math.floor(arrStart / 60), h1 = Math.ceil(depEnd / 60)
                for (let h = h0; h < h1; h++) {
                    const d = c.demandHourMap[h % 24]
                    if (typeof d === "number") { sum += d; n++ }
                }
                const avg = n ? sum / n : 0.5
                result.breakdown.demandHourFit = Math.round(Math.max(0, Math.min(1, avg)) * 100)
            } else {
                result.breakdown.demandHourFit = 50
            }
        } else {
            result.breakdown.demandHourFit = 50
        }

        // ---- 4. Aircraft availability ----
        const fit = row && row.aircraftFit
        if (fit === "optimal") {
            result.breakdown.aircraftAvailability = 100
        } else if (fit === "falloff") {
            result.breakdown.aircraftAvailability = 65
        } else if (fit === "oor") {
            result.breakdown.aircraftAvailability = 0
            result.reasons.push("No fleet aircraft can fly this distance.")
        } else if (fit === null || fit === undefined) {
            result.breakdown.aircraftAvailability = 55
        } else {
            result.breakdown.aircraftAvailability = 35
        }

        // ---- 5. Connection value ----
        // Approximation: how many other waves share an adjacency edge
        // with this wave? More edges → more connection opportunities by
        // putting routes here.
        if (c.adjacencyMatrix) {
            const edges = c.adjacencyMatrix.get(wave.id)
            const edgeCount = edges ? edges.size : 0
            // 0 → 30, 1 → 60, 2+ → 90. Plateau quickly.
            result.breakdown.connectionValue = edgeCount === 0 ? 30
                : edgeCount === 1 ? 60
                : 90
        } else {
            result.breakdown.connectionValue = 60
        }

        // ---- Weighted aggregate ----
        const b = result.breakdown
        result.score = Math.round(
            b.rangeFit              * 0.20
          + b.profitFit             * 0.35
          + b.demandHourFit         * 0.10
          + b.aircraftAvailability  * 0.20
          + b.connectionValue       * 0.15
        )

        // Viability gate.
        result.viable = b.rangeFit > 0
            && b.aircraftAvailability > 0
            && spareThisBucket > 0

        if (result.viable && !result.reasons.length) {
            if (b.profitFit >= 70) result.reasons.push("Strong profit signal.")
            else if (b.connectionValue >= 80) result.reasons.push("Connects to multiple waves.")
            else if (b.aircraftAvailability >= 90) result.reasons.push("Aircraft fits this distance well.")
        }
        return result
    }

    /**
     * Build the helper structures the scorer needs once per build, from
     * the preset + routes. Returns a context bag the caller passes
     * into every `scoreSlotFit` invocation.
     *
     * Pure — no I/O. The caller decides whether to thread these into
     * ScheduleBuilder._assignRoutesProfit or rebuild on each profit-mode
     * placement.
     */
    static buildScoringContext(preset, routes, opts) {
        const o = opts || {}
        const ctx = {
            preset:               preset,
            selectedSpec:         o.selectedSpec || null,
            fleetSpecs:           o.fleetSpecs || null,
            profitMax:            0,
            adjacencyMatrix:      new Map(),
            waveSlotsRemaining:   new Map(),
            demandHourMap:        o.demandHourMap || null
        }

        for (const r of (routes || [])) {
            const row = r && r._scoredRow
            const p = row && Number(row.profitPerWeek)
            if (isFinite(p) && p > ctx.profitMax) ctx.profitMax = p
        }

        const waves = (preset && preset.waves) || []
        for (const w of waves) {
            const comp = w.composition || {shortHaul: 0, mediumHaul: 0, longHaul: 0}
            ctx.waveSlotsRemaining.set(w.id, {
                shortHaul:  comp.shortHaul  || 0,
                mediumHaul: comp.mediumHaul || 0,
                longHaul:   comp.longHaul   || 0
            })
        }

        if (typeof ScheduleFactors !== "undefined" && preset && preset.factors) {
            const minXfr = Number(preset.factors.minTransferMinutes) || 0
            const maxXfr = Number(preset.factors.maxTransferMinutes) || 240
            const midpoint = (window) => {
                if (!window) return NaN
                const s = ScheduleFactors.parseHHMM(window.start)
                const e = ScheduleFactors.parseHHMM(window.end)
                return (isFinite(s) && isFinite(e)) ? (s + e) / 2 : NaN
            }
            for (const wa of waves) {
                const arrMid = midpoint(wa.arrivalWindow)
                const edges = new Set()
                for (const wb of waves) {
                    if (wa.id === wb.id) continue
                    const depMid = midpoint(wb.departureWindow)
                    if (!isFinite(arrMid) || !isFinite(depMid)) continue
                    const gap = depMid - arrMid
                    if (gap >= minXfr && gap <= maxXfr) edges.add(wb.id)
                }
                ctx.adjacencyMatrix.set(wa.id, edges)
            }
        }

        return ctx
    }

    /** Decrement spare bucket capacity in the scoring context. */
    static consumeSlot(ctx, waveId, bucket) {
        if (!ctx || !ctx.waveSlotsRemaining) return
        const spare = ctx.waveSlotsRemaining.get(waveId)
        if (!spare) return
        if (spare[bucket] > 0) spare[bucket]--
    }
}
