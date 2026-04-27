/**
 * Pure-function profitability cuts. Each takes the unified ledger from
 * `AccountingAggregator.loadUnifiedLedger` and returns a structured result
 * the panel renders. No I/O, no DOM — keeps the cuts cheap to recompute on
 * every panel render and trivial to unit-test once a test rig exists.
 *
 * Slice 3 ships four cuts. `byClassAirlineWide` is intentionally a stub
 * because the necessary perClass primitive isn't yet in the topRoutes
 * snapshot — see aggregator.js for the gap notes. When that snapshot is
 * extended, this cut fills in.
 */
class AccountingProfitabilityCuts {
    /**
     * Aggregates `profitPerWeek` by hub. Each hub's record carries a sum,
     * an average, route count, and a status histogram so users can see at a
     * glance whether a hub bleeds because of OOR routes vs. simply unprofitable.
     */
    static byHub(ledger) {
        const groups = new Map()
        for (const r of ledger.routes) {
            if (!r.hub) continue
            let g = groups.get(r.hub)
            if (!g) {
                g = {
                    hub: r.hub,
                    routeCount: 0,
                    profitedRouteCount: 0,
                    profitPerWeekSum: 0,
                    distanceKmSum: 0,
                    weeklyFlightsSum: 0,
                    statusCounts: {NEW: 0, OK: 0, UNDER: 0, OVER: 0, OOR: 0, OTHER: 0},
                    snapshotAt: null
                }
                groups.set(r.hub, g)
            }
            g.routeCount++
            if (r.profitPerWeek != null) {
                g.profitPerWeekSum += r.profitPerWeek
                if (r.profitPerWeek !== 0) g.profitedRouteCount++
            }
            if (r.distanceKm != null) g.distanceKmSum += r.distanceKm
            if (r.weeklyFlights != null) g.weeklyFlightsSum += r.weeklyFlights
            const status = r.status || "OTHER"
            g.statusCounts[status] = (g.statusCounts[status] || 0) + 1
            if (r.snapshotAt && (!g.snapshotAt || r.snapshotAt > g.snapshotAt)) {
                g.snapshotAt = r.snapshotAt
            }
        }

        const rows = Array.from(groups.values())
        rows.forEach(g => {
            g.profitPerRouteAvg = g.routeCount > 0 ? g.profitPerWeekSum / g.routeCount : 0
        })
        rows.sort((a, b) => b.profitPerWeekSum - a.profitPerWeekSum)

        return {
            rows,
            totalHubs: rows.length,
            totalProfitPerWeek: rows.reduce((s, g) => s + g.profitPerWeekSum, 0),
            totalRoutes: rows.reduce((s, g) => s + g.routeCount, 0)
        }
    }

    /**
     * Per-aircraft-type cumulative profit from the aircraft-flights store.
     * "Type" here is the `equipment` string AS surfaces (e.g. "Embraer 190
     * E2") — that's what aircraft-flights captures. When two tails carry the
     * same equipment string, their lifetime profits sum into one row.
     */
    static byAircraftType(ledger) {
        const groups = new Map()
        for (const a of ledger.aircraft) {
            const key = a.equipment || "(unknown)"
            let g = groups.get(key)
            if (!g) {
                g = {equipment: key, tailCount: 0, profitSum: 0, flightCountSum: 0}
                groups.set(key, g)
            }
            g.tailCount++
            if (a.profit != null) g.profitSum += a.profit
            if (a.flightCount != null) g.flightCountSum += a.flightCount
        }
        const rows = Array.from(groups.values())
        rows.forEach(g => {
            g.profitPerTailAvg = g.tailCount > 0 ? g.profitSum / g.tailCount : 0
            g.profitPerFlightAvg = g.flightCountSum > 0 ? g.profitSum / g.flightCountSum : 0
        })
        rows.sort((a, b) => b.profitSum - a.profitSum)
        return {
            rows,
            totalTypes: rows.length,
            totalTails: rows.reduce((s, g) => s + g.tailCount, 0),
            totalProfit: rows.reduce((s, g) => s + g.profitSum, 0)
        }
    }

    /**
     * Per-tail margin: cumulative aircraft-flights profit, joined with
     * leasing installments and asset book value when those sister records
     * have a matching `registration`. The leasing/asset table-row matcher
     * is fuzzy: any cell exactly matching the registration string anchors
     * the row. Sharper matching once the leasing-page capture is taken.
     */
    static byTail(ledger) {
        const leasingByReg = AccountingProfitabilityCuts._indexSisterByRegistration(ledger.sisters.leasing)
        const assetsByReg = AccountingProfitabilityCuts._indexSisterByRegistration(ledger.sisters.assets)

        const rows = ledger.aircraft.map(a => {
            const lease = a.registration ? leasingByReg.get(a.registration) : null
            const asset = a.registration ? assetsByReg.get(a.registration) : null
            return {
                aircraftId: a.aircraftId,
                registration: a.registration,
                equipment: a.equipment,
                profit: a.profit,
                flightCount: a.flightCount,
                leasingMatched: !!lease,
                leasingInstallment: lease ? AccountingProfitabilityCuts._firstNumeric(lease) : null,
                assetMatched: !!asset,
                assetBookValue: asset ? AccountingProfitabilityCuts._firstNumeric(asset) : null
            }
        })
        rows.sort((a, b) => (b.profit || 0) - (a.profit || 0))
        return {
            rows,
            totalTails: rows.length,
            totalProfit: rows.reduce((s, r) => s + (r.profit || 0), 0),
            leasingMatched: rows.filter(r => r.leasingMatched).length,
            assetMatched: rows.filter(r => r.assetMatched).length
        }
    }

    /**
     * Headline unit economics computable from topRoutes alone. Without seat
     * counts (which need fleet × type joins) we can't emit RASK/CASK — those
     * are deferred to slice 3.5 once a perClass-or-seats snapshot lands.
     * What's reported now: total profit/week, total route-km flown weekly
     * (distance × frequency × 2 round-trips), profit per route-km, plus a
     * status histogram across the airline.
     */
    static unitEconomics(ledger) {
        let totalProfitPerWeek = 0
        let totalRouteKmPerWeek = 0
        let routesWithFreq = 0
        const statusCounts = {NEW: 0, OK: 0, UNDER: 0, OVER: 0, OOR: 0, OTHER: 0}
        const profitByStatus = {NEW: 0, OK: 0, UNDER: 0, OVER: 0, OOR: 0, OTHER: 0}

        for (const r of ledger.routes) {
            if (r.profitPerWeek != null) totalProfitPerWeek += r.profitPerWeek
            if (r.distanceKm != null && r.weeklyFlights != null) {
                totalRouteKmPerWeek += r.distanceKm * r.weeklyFlights * 2
                if (r.weeklyFlights > 0) routesWithFreq++
            }
            const status = r.status || "OTHER"
            statusCounts[status] = (statusCounts[status] || 0) + 1
            profitByStatus[status] = (profitByStatus[status] || 0) + (r.profitPerWeek || 0)
        }

        return {
            routeCount: ledger.routes.length,
            routesWithFreq,
            totalProfitPerWeek,
            totalRouteKmPerWeek,
            profitPerRouteKm: totalRouteKmPerWeek > 0
                ? totalProfitPerWeek / totalRouteKmPerWeek
                : null,
            statusCounts,
            profitByStatus
        }
    }

    /**
     * Stub: needs perClass snapshot from route-assistant. Returns the
     * not-yet-available marker so the panel can render the right message.
     */
    static byClassAirlineWide(_ledger) {
        return {
            available: false,
            reason: "Per-class breakdowns aren't in the topRoutes snapshot yet. Will be populated once route-assistant emits a perClass companion record."
        }
    }

    static _indexSisterByRegistration(sisterRecord) {
        const map = new Map()
        const tables = sisterRecord?.payload?.tables
        if (!Array.isArray(tables)) return map
        for (const t of tables) {
            for (const row of t.rows || []) {
                if (!row || !Array.isArray(row.cells)) continue
                for (const cell of row.cells) {
                    const m = String(cell || "").trim().match(/\b([A-Z][A-Z0-9-]{2,7})\b/)
                    if (m) {
                        const reg = m[1]
                        if (!map.has(reg)) map.set(reg, row)
                    }
                }
            }
        }
        return map
    }

    static _firstNumeric(row) {
        if (!row || !Array.isArray(row.numericValues)) return null
        for (const v of row.numericValues) {
            if (v && v.value != null && Number.isFinite(v.value)) return v.value
        }
        return null
    }
}
