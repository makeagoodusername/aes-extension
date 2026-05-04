/**
 * Forward N-week EBIT / EBITDA / cash trajectory.
 *
 * Hybrid model:
 *   - Variable lines come from the schedule the user already flies. Sum of
 *     `route.profitPerWeek` across every cached topRoutes record gives the
 *     variable contribution per future week (held flat — slice 6 adds
 *     scenario sliders).
 *   - Fixed lines come from the latest accounting income snapshot, taking
 *     each category's `current` actual as the run-rate. Categories the
 *     user has calibrated into route-assistant economics (via slice 4's
 *     Apply button) are dropped from the fixed side to avoid double-counting
 *     — they're already inside profitPerWeek.
 *   - Cash trajectory seeds from the captured navbar balance (slice 1's bank
 *     scraper) and accumulates the weekly net.
 *
 * Confidence pill mirrors the ORS Sandbox 3a vocabulary: green / amber / red
 * driven by snapshot count, topRoutes coverage, and the freshness of fixed-
 * cost run-rate.
 */
class AccountingProjector {
    static DEFAULT_HORIZONS = [4, 8, 12]

    static FIXED_FROM_INCOME = [
        "Salaries", "Maintenance", "Depreciation of flight equipment",
        "Depreciation of buildings", "Interest expenditure", "Leasing installments"
    ]

    /**
     * @param {object} ledger - from AccountingAggregator.loadUnifiedLedger
     * @param {object} opts - {weeks?: 4|8|12, calibratedFields?: string[]}
     * @returns {object} {available, weeks: [...], confidence, breakdown}
     */
    static project(ledger, opts = {}) {
        const horizon = AccountingProjector._resolveHorizon(opts.weeks)
        const calibrated = new Set(opts.calibratedFields || [])

        if (!ledger.periodActuals && (!ledger.routes || !ledger.routes.length)) {
            return {
                available: false,
                horizon,
                reason: "Need at least one stored income snapshot or one cached topRoutes record."
            }
        }

        const variableProfitPerWeek = AccountingProjector._sumVariableProfit(ledger.routes)
        const fixedCostsPerWeek = AccountingProjector._sumFixedCosts(ledger, calibrated)
        const cashStart = AccountingProjector._cashStart(ledger)

        const weeks = []
        let cash = cashStart != null ? cashStart : 0
        for (let i = 1; i <= horizon; i++) {
            const ebit = variableProfitPerWeek - fixedCostsPerWeek.totalCost
            const ebitda = ebit + (fixedCostsPerWeek.byCategory["Depreciation of flight equipment"] || 0)
                + (fixedCostsPerWeek.byCategory["Depreciation of buildings"] || 0)
            cash += ebit
            weeks.push({
                index: i,
                projectedEbit: ebit,
                projectedEbitda: ebitda,
                projectedCash: cashStart != null ? cash : null,
                variableProfit: variableProfitPerWeek,
                fixedCosts: fixedCostsPerWeek.totalCost,
                fixedByCategory: fixedCostsPerWeek.byCategory
            })
        }

        return {
            available: true,
            horizon,
            cashStart,
            cashStartSource: AccountingProjector._cashStartSource(ledger),
            variableProfitPerWeek,
            fixedCostsPerWeek,
            weeks,
            confidence: AccountingProjector._confidence(ledger)
        }
    }

    static _resolveHorizon(value) {
        const n = Number(value)
        if (AccountingProjector.DEFAULT_HORIZONS.includes(n)) return n
        return AccountingProjector.DEFAULT_HORIZONS[0]
    }

    static _sumVariableProfit(routes) {
        let sum = 0
        for (const r of routes) {
            if (r.profitPerWeek != null && Number.isFinite(r.profitPerWeek)) {
                sum += r.profitPerWeek
            }
        }
        return sum
    }

    static _sumFixedCosts(ledger, calibrated) {
        const incomeRows = ledger._latestIncomeRows || []
        const byCategory = {}
        let totalCost = 0
        for (const row of incomeRows) {
            if (!row || !AccountingProjector.FIXED_FROM_INCOME.includes(row.label)) continue
            if (calibrated.has(row.label)) continue
            const value = Number(row.current) || 0
            byCategory[row.label] = value
            totalCost += value
        }
        return {totalCost, byCategory}
    }

    static _cashStart(ledger) {
        const sisters = ledger.sisters || {}
        const cashflow = sisters.cashflow?.payload
        if (cashflow && Array.isArray(cashflow.tables)) {
            for (const t of cashflow.tables) {
                for (const row of t.rows || []) {
                    if (!row || !row.numericValues) continue
                    if (/cash|balance/i.test(row.label || "")) {
                        const v = AccountingProjector._firstNumeric(row)
                        if (v != null) return v
                    }
                }
            }
        }
        return null
    }

    static _cashStartSource(ledger) {
        return ledger.sisters?.cashflow ? "cashflow" : "none"
    }

    static _firstNumeric(row) {
        if (!row || !Array.isArray(row.numericValues)) return null
        for (const v of row.numericValues) {
            if (v && v.value != null && Number.isFinite(v.value)) return v.value
        }
        return null
    }

    /**
     * Three-signal pill modelled on `_buildOrsSandboxConfidencePill` in the
     * route-assistant panel. Score:
     *   +1 = good signal, 0 = OK, -1 = poor.
     *
     *   - Snapshot count: ≥4 → +1, 1-3 → 0, 0 → -1
     *   - topRoutes coverage: ≥1 hub → +1 (no partial scoring without seats)
     *   - Income freshness: <14d → +1, 14-30d → 0, ≥30d or null → -1
     *
     * Aggregate ≥+1 → green, ≥-1 → amber, lower → red.
     */
    static _confidence(ledger) {
        const signals = {}

        const snapCount = Number(ledger.snapshotIndexCount) || 0
        signals.snapshots = snapCount >= 4 ? 1 : snapCount >= 1 ? 0 : -1

        const hubCount = (ledger.hubs || []).length
        signals.coverage = hubCount >= 1 ? 1 : -1

        const incomeAt = ledger.periodActuals?.scrapedAt || 0
        const ageDays = incomeAt ? (Date.now() - incomeAt) / 86400000 : null
        signals.freshness = ageDays == null ? -1
            : ageDays < 14 ? 1
            : ageDays < 30 ? 0
            : -1

        const total = signals.snapshots + signals.coverage + signals.freshness
        const level = total >= 1 ? "green" : total >= -1 ? "amber" : "red"

        return {level, signals, total, snapCount, hubCount, ageDays}
    }

}

if (typeof window !== "undefined") {
    window.AccountingProjector = AccountingProjector
}
