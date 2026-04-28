/**
 * F slice 1 — Wave Plan Diagnostics & Per-Wave Economics.
 *
 * Pure scorer that walks an already-built `RouteAssistantWaveOverlay.buildSchedule`
 * output plus the panel's scoredRows and produces a single rich diagnostic
 * record:
 *
 *   - planScore (0-100)         — weighted aggregate
 *   - perWave[]                  — slot utilisation, $/wk, connection mix
 *   - unplaceable                — count + profit forgone
 *   - demandCoverage             — placed paxScore / total
 *   - profitPerWeek              — total
 *   - capacityByHour[24]         — aircraft-bars-per-hour histogram
 *   - warnings[]                 — typed/severity-graded
 *
 * No DOM, no I/O. Reuses build.connections (already classified) — does NOT
 * recompute the connection graph.
 *
 * Each scoredRow carries `profitPerWeek` from aggregator when fleet context
 * is available; we degrade gracefully (show "—" sentinels) when it isn't.
 */
class RouteAssistantWavePlanDiagnostics {

    /**
     * Compute the diagnostics record for a build.
     *
     * @param {object} build - output of RouteAssistantWaveOverlay.buildSchedule
     * @param {Array}  scoredRows - panel's top-N scored rows (anchor for $/pax)
     * @param {object} ctx
     *   - hubIata: string
     *   - selectedSpec: aircraft spec or null
     *   - carrierClassifier: optional (kept for parity; we use build.connections)
     *   - fleetCount: number of fleet aircraft assigned to this preset (≥ 1)
     * @returns {object}
     */
    static scorePlan(build, scoredRows, ctx) {
        const c = ctx || {}
        const out = {
            planScore:       0,
            planGrade:       "n/a",
            perWave:         [],
            unplaceable:     {count: 0, totalProfitForgone: 0,
                              byBucket: {shortHaul: 0, mediumHaul: 0, longHaul: 0}},
            demandCoverage:  0,
            profitPerWeek:   0,
            revenuePerWeek:  0,
            connectionCount: 0,
            connectionMix:   {own: 0, interline: 0, alliance: 0},
            capacityByHour:  new Array(24).fill(0),
            warnings:        [],
            hasFleetContext: !!c.selectedSpec,
            componentScores: {utilization: 0, profit: 0, connections: 0,
                              demand: 0, warningsHealth: 0}
        }
        if (!build || !build.preset) return out

        const rowByDest = new Map()
        for (const row of scoredRows || []) {
            if (row && row.destIata) {
                rowByDest.set(String(row.destIata).toUpperCase(), row)
            }
        }

        out.perWave = RouteAssistantWavePlanDiagnostics._perWaveBreakdown(
            build, rowByDest, c)

        // Plan-level connection totals come from the build directly, NOT
        // from summing per-wave counts (a connection touches two waves and
        // would double-count).
        const realConn = (build.connections || []).filter(cn => !cn.overflow)
        out.connectionCount = realConn.length
        for (const cn of realConn) {
            if (out.connectionMix[cn.classification] !== undefined) {
                out.connectionMix[cn.classification]++
            }
        }

        // ---- Plan-level totals (aggregate from per-wave rows) ----
        let totalSlotsUsed  = 0
        let totalSlotsTotal = 0
        for (const pw of out.perWave) {
            totalSlotsUsed  += pw.slotsUsed
            totalSlotsTotal += pw.slotsTotal
            out.profitPerWeek  += pw.profitPerWeek  || 0
            out.revenuePerWeek += pw.revenuePerWeek || 0
        }

        // ---- Unplaceable summary ----
        const buckets = (build.preset.factors && build.preset.factors.rangeBuckets) || null
        for (const r of (build.unplaced || [])) {
            out.unplaceable.count++
            const row = rowByDest.get(String(r.destination || "").toUpperCase())
            if (row && typeof row.profitPerWeek === "number" && isFinite(row.profitPerWeek)) {
                out.unplaceable.totalProfitForgone += Math.max(0, row.profitPerWeek)
            }
            const bucket = (typeof ScheduleFactors !== "undefined" && buckets)
                ? ScheduleFactors.bucketize(r.distanceNm, buckets)
                : null
            if (bucket && out.unplaceable.byBucket[bucket] !== undefined) {
                out.unplaceable.byBucket[bucket]++
            }
        }

        // ---- Demand coverage ----
        let placedPax = 0
        const placedDests = new Set()
        for (const p of (build.placements || [])) {
            const dest = String(p.route && p.route.destination || "").toUpperCase()
            if (!dest || placedDests.has(dest)) continue
            placedDests.add(dest)
            const row = rowByDest.get(dest)
            const pax = row && Number(row.paxScore)
            if (isFinite(pax)) placedPax += pax
        }
        let totalPax = 0
        for (const row of rowByDest.values()) {
            const pax = Number(row && row.paxScore)
            if (isFinite(pax)) totalPax += pax
        }
        out.demandCoverage = totalPax > 0 ? Math.min(1, placedPax / totalPax) : 0

        // ---- Capacity by hour ----
        for (const f of (build.flights || [])) {
            const hhmm = f.depTimeLocal || f.arrTimeLocal
            if (!hhmm) continue
            const m = (typeof ScheduleFactors !== "undefined")
                ? ScheduleFactors.parseHHMM(hhmm)
                : NaN
            if (!isFinite(m)) continue
            const hour = Math.max(0, Math.min(23, Math.floor(m / 60)))
            out.capacityByHour[hour]++
        }

        // ---- Warnings (build warnings + plan-level checks) ----
        for (const w of (build.warnings || [])) {
            out.warnings.push({
                severity: "warn", source: "build",
                message:  w.message || String(w),
                waveId:   w.waveId || null
            })
        }
        if ((build.flights || []).length && out.connectionCount === 0) {
            out.warnings.push({
                severity: "warn", source: "diagnostics",
                message: "No valid inbound→outbound connections — passengers cannot transfer."
            })
        }
        if (out.unplaceable.count > 0) {
            out.warnings.push({
                severity: out.unplaceable.count >= 5 ? "high" : "info",
                source:   "diagnostics",
                message:  out.unplaceable.count + " route(s) couldn't be placed in any wave."
            })
        }
        for (const pw of out.perWave) {
            if (pw.slotsTotal > 0 && pw.slotsUsed === 0) {
                out.warnings.push({
                    severity: "high", source: "diagnostics",
                    message:  pw.label + " has " + pw.slotsTotal + " slot(s) but no flights placed.",
                    waveId:   pw.waveId
                })
            }
        }

        // ---- Component scores (each 0-100) ----
        const cs = out.componentScores
        cs.utilization = totalSlotsTotal > 0
            ? Math.round((totalSlotsUsed / totalSlotsTotal) * 100)
            : 0

        const theoreticalMax = RouteAssistantWavePlanDiagnostics._theoreticalProfit(
            scoredRows, totalSlotsTotal)
        if (theoreticalMax > 0 && out.profitPerWeek > 0) {
            cs.profit = Math.max(0, Math.min(100,
                Math.round((out.profitPerWeek / theoreticalMax) * 100)))
        } else if (out.profitPerWeek > 0) {
            // No theoretical anchor — give partial credit so the missing
            // signal doesn't drag the badge to red.
            cs.profit = 60
        } else {
            cs.profit = 0
        }

        const flightCount = (build.flights || []).length
        if (flightCount > 0) {
            // Target ~0.7 connections per leg (one transfer for ~70% of legs).
            const ratio = out.connectionCount / flightCount
            cs.connections = Math.max(0, Math.min(100, Math.round((ratio / 0.7) * 100)))
        }

        cs.demand = Math.round(out.demandCoverage * 100)

        // Warnings health: each "high" -10, each "warn" -5, each "info" -2.
        let penalty = 0
        for (const w of out.warnings) {
            if      (w.severity === "high") penalty += 10
            else if (w.severity === "warn") penalty += 5
            else                            penalty += 2
        }
        cs.warningsHealth = Math.max(0, Math.min(100, 100 - penalty))

        // ---- Weighted aggregate ----
        out.planScore = Math.round(
            cs.utilization     * 0.25
          + cs.profit          * 0.30
          + cs.connections     * 0.20
          + cs.demand          * 0.15
          + cs.warningsHealth  * 0.10
        )
        out.planGrade = RouteAssistantWavePlanDiagnostics._gradeScore(out.planScore)

        return out
    }

    /**
     * Group placements + flights + connections by wave id and produce
     * a per-wave row with capacity / economics / connection mix.
     */
    static _perWaveBreakdown(build, rowByDest, ctx) {
        const waves = (build.preset && build.preset.waves) || []
        const placementsByWave = new Map()
        for (const p of (build.placements || [])) {
            if (!placementsByWave.has(p.waveId)) placementsByWave.set(p.waveId, [])
            placementsByWave.get(p.waveId).push(p)
        }
        const flightsByWave = new Map()
        for (const f of (build.flights || [])) {
            if (!flightsByWave.has(f.waveId)) flightsByWave.set(f.waveId, [])
            flightsByWave.get(f.waveId).push(f)
        }
        // Connection lookup: flight.seq → flight.waveId.
        const seqToWave = new Map()
        for (const f of (build.flights || [])) seqToWave.set(f.seq, f.waveId)

        const realConn = (build.connections || []).filter(cn => !cn.overflow)

        const out = []
        for (const w of waves) {
            const placements = placementsByWave.get(w.id) || []
            const flights    = flightsByWave.get(w.id) || []
            const compTotal  = ((w.composition && w.composition.shortHaul)  || 0)
                             + ((w.composition && w.composition.mediumHaul) || 0)
                             + ((w.composition && w.composition.longHaul)   || 0)

            // De-duplicate to unique routes (each placement → outbound +
            // inbound pair). Use destination as the dedup key.
            const uniqueDests = new Set()
            for (const p of placements) {
                const dest = String(p.route && p.route.destination || "").toUpperCase()
                if (dest) uniqueDests.add(dest)
            }
            const slotsUsed = uniqueDests.size

            // Aggregate per-route economics from scoredRow back-references.
            let revenuePerWeek = 0
            let profitPerWeek  = 0
            let routesWithProfit = 0
            for (const dest of uniqueDests) {
                const row = rowByDest.get(dest)
                if (!row) continue
                if (typeof row.profitPerWeek === "number" && isFinite(row.profitPerWeek)) {
                    profitPerWeek += row.profitPerWeek
                    routesWithProfit++
                }
                if (row.classBreakdown
                        && typeof row.classBreakdown.totalRevenuePerWeek === "number") {
                    revenuePerWeek += row.classBreakdown.totalRevenuePerWeek
                }
            }

            // Connection breakdown for this wave.
            let connArrival = 0   // wave's INBOUND flights feeding outbounds
            let connDeparture = 0 // wave's OUTBOUND flights fed by inbounds
            const clsCount = {own: 0, interline: 0, alliance: 0}
            const seenIn  = new Set()
            const seenOut = new Set()
            for (const cn of realConn) {
                if (seqToWave.get(cn.inboundSeq) === w.id && !seenIn.has(cn.inboundSeq)) {
                    connArrival++
                    seenIn.add(cn.inboundSeq)
                }
                if (seqToWave.get(cn.outboundSeq) === w.id && !seenOut.has(cn.outboundSeq)) {
                    connDeparture++
                    seenOut.add(cn.outboundSeq)
                }
                if (seqToWave.get(cn.inboundSeq) === w.id
                        || seqToWave.get(cn.outboundSeq) === w.id) {
                    if (clsCount[cn.classification] !== undefined) {
                        clsCount[cn.classification]++
                    }
                }
            }

            const utilizationPct = compTotal > 0
                ? Math.round((slotsUsed / compTotal) * 100)
                : 0

            // Fit quality heuristic.
            let fitQuality
            if      (compTotal === 0)               fitQuality = "warn"
            else if (slotsUsed === 0)                fitQuality = "bad"
            else if (utilizationPct >= 80
                  && (connArrival + connDeparture) >= 1) fitQuality = "good"
            else if (utilizationPct >= 50)           fitQuality = "warn"
            else                                     fitQuality = "bad"

            out.push({
                waveId:           w.id,
                label:            w.label || ("Wave " + (out.length + 1)),
                slotsUsed:        slotsUsed,
                slotsTotal:       compTotal,
                utilizationPct:   utilizationPct,
                composition:      w.composition || {shortHaul: 0, mediumHaul: 0, longHaul: 0},
                arrivalWindow:    w.arrivalWindow,
                departureWindow:  w.departureWindow,
                flightCount:      flights.length,
                revenuePerWeek:   revenuePerWeek,
                profitPerWeek:    profitPerWeek,
                profitKnown:      routesWithProfit > 0,
                profitMissing:    Math.max(0, slotsUsed - routesWithProfit),
                connArrival:      connArrival,
                connDeparture:    connDeparture,
                ownConn:          clsCount.own,
                interlineConn:    clsCount.interline,
                allianceConn:     clsCount.alliance,
                fitQuality:       fitQuality
            })
        }
        return out
    }

    /**
     * Estimate the theoretical max profit if we'd somehow filled every
     * slot with the most profitable scored route. Caps at sum of top-N
     * profits where N = totalSlots so we don't reward overstuffed plans.
     */
    static _theoreticalProfit(scoredRows, totalSlots) {
        if (!totalSlots) return 0
        const profits = []
        for (const row of (scoredRows || [])) {
            const p = row && Number(row.profitPerWeek)
            if (isFinite(p) && p > 0) profits.push(p)
        }
        profits.sort((a, b) => b - a)
        let sum = 0
        for (let i = 0; i < Math.min(profits.length, totalSlots); i++) sum += profits[i]
        return sum
    }

    /**
     * Translate a 0–100 plan score to a coarse grade label. Used only
     * for display; the underlying numbers are what drives decisions.
     */
    static _gradeScore(score) {
        if (score >= 80) return "Excellent"
        if (score >= 65) return "Good"
        if (score >= 50) return "Fair"
        if (score >= 30) return "Weak"
        return "Poor"
    }

    /** Convenience — color hint for a plan score (CSS hex). */
    static colorForScore(score) {
        if (score >= 80) return "#10b981"  // emerald
        if (score >= 65) return "#22c55e"  // green
        if (score >= 50) return "#fbbf24"  // amber
        if (score >= 30) return "#f97316"  // orange
        return "#ef4444"                    // red
    }

    /** Convenience — color hint for a per-wave fitQuality value. */
    static colorForFit(fitQuality) {
        if (fitQuality === "good") return "#10b981"
        if (fitQuality === "warn") return "#fbbf24"
        return "#ef4444"
    }
}
