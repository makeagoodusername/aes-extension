/**
 * F slice 5 — Wave Plan Backtest.
 *
 * Replay a plan against historical yield-history snapshots so the user
 * can answer "would my plan have selected better routes given the
 * demand we observed?". For each historical week, the engine constructs
 * synthetic per-route scoredRows from that week's snapshots, runs the
 * existing `RouteAssistantWaveOverlay.buildSchedule` against them, and
 * compares the would-have-been profit to the actual sum across all
 * scored routes in that week.
 *
 * Caveat (surfaced in the modal copy): this measures ROUTE SELECTION
 * quality, not full counterfactual revenue. We do not simulate a demand
 * regression — passenger demand reflects the user's actual real-world
 * frequency at the time, not what the plan would have flown.
 *
 * Pure: no DOM, no I/O. The caller passes `yieldHistoryByPair` already
 * loaded (typically via `RouteAssistantYieldHistoryStore.getMany`).
 */
class RouteAssistantWavePlanBacktest {

    /** Minimum weeks of usable history before the chart renders. */
    static MIN_WEEKS = 4

    /** Default look-back window. */
    static DEFAULT_WEEKS = 12

    /**
     * Run a backtest.
     *
     * @param {object} preset      - SchedulePresets record (the plan)
     * @param {Array}  scoredRows  - panel's top-N scoredRows (anchor for routes
     *                                that exist today; we replay snapshots for
     *                                only these destinations)
     * @param {Map}    yieldHistoryByPair - Map<"HUB-DEST", record> from
     *                                       RouteAssistantYieldHistoryStore.getMany
     * @param {object} ctx
     *   - hubIata, server, airlineCode
     *   - selectedSpec
     *   - weeksWindow (default DEFAULT_WEEKS)
     *   - topN
     * @returns {object} {
     *   weeks: [{
     *     ts, weekIso, planProfit, actualProfit, delta,
     *     placedRouteCount, totalRouteCount
     *   }],
     *   summary: {
     *     weekCount, avgPlanProfit, avgActualProfit, avgDelta,
     *     winRate, volatility, totalDelta
     *   },
     *   winnerRoutes: [{destIata, totalDelta}],   // routes plan helped most
     *   loserRoutes:  [{destIata, totalDelta}],   // routes plan hurt most
     *   insufficient: bool                         // true when < MIN_WEEKS
     * }
     */
    static backtestPlan(preset, scoredRows, yieldHistoryByPair, ctx) {
        const c = ctx || {}
        const weeksWindow = Math.max(1, Math.min(52,
            Number(c.weeksWindow) || RouteAssistantWavePlanBacktest.DEFAULT_WEEKS))
        const out = {
            weeks: [], summary: {
                weekCount: 0, avgPlanProfit: 0, avgActualProfit: 0,
                avgDelta: 0, winRate: 0, volatility: 0, totalDelta: 0
            },
            winnerRoutes: [],
            loserRoutes:  [],
            insufficient: false
        }
        if (!preset || !yieldHistoryByPair || !yieldHistoryByPair.size) {
            out.insufficient = true
            return out
        }

        const hubU = String(c.hubIata || preset.hub || "").toUpperCase()

        // Index snapshots by week-bucket. A week-bucket is the most recent
        // Sunday at 00:00 UTC; this aligns weekly snapshots that drift by
        // a few hours.
        const WEEK_MS = 7 * 24 * 60 * 60 * 1000
        const weekBucket = (ts) => Math.floor(ts / WEEK_MS) * WEEK_MS

        // Map<weekTs, Map<destIata, snapshot>>
        const weekly = new Map()
        for (const [pair, record] of yieldHistoryByPair.entries()) {
            const dest = pair.split("-").slice(-1)[0]
            for (const snap of (record.snapshots || [])) {
                const ts = Number(snap && snap.timestamp)
                if (!isFinite(ts)) continue
                const wk = weekBucket(ts)
                if (!weekly.has(wk)) weekly.set(wk, new Map())
                const wkMap = weekly.get(wk)
                // If multiple snapshots in same week-bucket, prefer the most recent.
                const existing = wkMap.get(dest)
                if (!existing || Number(existing.timestamp) < ts) wkMap.set(dest, snap)
            }
        }

        const sortedWeeks = Array.from(weekly.keys()).sort((a, b) => a - b)
        const recentWeeks = sortedWeeks.slice(-weeksWindow)
        if (recentWeeks.length < RouteAssistantWavePlanBacktest.MIN_WEEKS) {
            out.insufficient = true
            return out
        }

        const routeBaselines = new Map()
        for (const row of (scoredRows || [])) {
            if (row && row.destIata) {
                routeBaselines.set(String(row.destIata).toUpperCase(), row)
            }
        }
        const topN = Math.max(1, Math.min(200, Number(c.topN) || 50))

        // Per-route delta accumulators for winner/loser identification.
        const perRouteDelta = new Map()

        for (const wkTs of recentWeeks) {
            const snaps = weekly.get(wkTs)
            if (!snaps || !snaps.size) continue

            // Synthesise scoredRows for this week from snapshots.
            const synthRows = []
            let actualProfit = 0
            for (const [dest, snap] of snaps.entries()) {
                const baseline = routeBaselines.get(dest)
                const profit = Number(snap.profitPerWeek)
                if (!baseline) continue   // route no longer in scored set
                if (isFinite(profit)) actualProfit += profit
                const synth = Object.assign({}, baseline, {
                    profitPerWeek: isFinite(profit) ? profit : baseline.profitPerWeek,
                    actualProfitPerWeek: isFinite(profit) ? profit : null,
                    actualSnapshotAt: Number(snap.timestamp) || null
                })
                synthRows.push(synth)
            }
            if (synthRows.length < 2) continue

            const trimmed = synthRows.slice(0, topN)

            // Run the plan against this week's data.
            const build = RouteAssistantWaveOverlay.buildSchedule(preset, trimmed, {
                server:       c.server || "",
                airlineCode:  c.airlineCode || "",
                hubIata:      hubU,
                selectedSpec: c.selectedSpec || null,
                topN:         topN,
                overrides:    {},
                optimize:     false
            })
            const placedDests = new Set()
            for (const p of (build.placements || [])) {
                const d = String(p.route && p.route.destination || "").toUpperCase()
                if (d) placedDests.add(d)
            }
            let planProfit = 0
            for (const dest of placedDests) {
                const snap = snaps.get(dest)
                if (!snap) continue
                const p = Number(snap.profitPerWeek)
                if (isFinite(p)) planProfit += p
            }

            // Per-route accounting: a route under the plan vs. the
            // user's actual share of profit. We approximate the actual
            // share as profit/totalSnaps (uniform), so the delta is
            // "did the plan keep this profitable route?".
            for (const [dest, snap] of snaps.entries()) {
                const profit = Number(snap.profitPerWeek)
                if (!isFinite(profit)) continue
                const cur = perRouteDelta.get(dest) || {totalDelta: 0, weeks: 0}
                cur.totalDelta += placedDests.has(dest) ? profit : -profit
                cur.weeks++
                perRouteDelta.set(dest, cur)
            }

            const weekIso = new Date(wkTs).toISOString().slice(0, 10)
            out.weeks.push({
                ts:               wkTs,
                weekIso:          weekIso,
                planProfit:       planProfit,
                actualProfit:     actualProfit,
                delta:            planProfit - actualProfit,
                placedRouteCount: placedDests.size,
                totalRouteCount:  snaps.size
            })
        }

        if (out.weeks.length < RouteAssistantWavePlanBacktest.MIN_WEEKS) {
            out.insufficient = true
            return out
        }

        // Summary stats.
        const n = out.weeks.length
        let sumPlan = 0, sumAct = 0, sumDelta = 0, wins = 0
        for (const w of out.weeks) {
            sumPlan  += w.planProfit
            sumAct   += w.actualProfit
            sumDelta += w.delta
            if (w.planProfit >= w.actualProfit) wins++
        }
        const avgDelta = sumDelta / n
        let varSum = 0
        for (const w of out.weeks) varSum += (w.delta - avgDelta) ** 2
        out.summary = {
            weekCount:        n,
            avgPlanProfit:    sumPlan / n,
            avgActualProfit:  sumAct  / n,
            avgDelta:         avgDelta,
            winRate:          wins / n,
            volatility:       Math.sqrt(varSum / n),
            totalDelta:       sumDelta
        }

        // Top winners + losers — routes the plan picked / dropped most
        // consistently relative to their profit.
        const ranked = []
        for (const [dest, agg] of perRouteDelta.entries()) {
            ranked.push({destIata: dest, totalDelta: agg.totalDelta, weeks: agg.weeks})
        }
        ranked.sort((a, b) => b.totalDelta - a.totalDelta)
        out.winnerRoutes = ranked.slice(0, 5)
        out.loserRoutes  = ranked.slice(-5).reverse()

        return out
    }
}
