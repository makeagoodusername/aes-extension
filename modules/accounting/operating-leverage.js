"use strict"

/**
 * Operating-leverage analytics on top of the accounting ledger + the staff-
 * overview snapshot + the strategy outcomes ring.
 *
 * "Financial leverage required" is interpreted as cost-structure leverage:
 *   - Degree of Operating Leverage  (DOL = Contribution / EBIT)
 *   - Break-even revenue            (FixedCosts / ContributionMarginRatio)
 *   - Margin of safety              (Revenue − BreakEvenRevenue)
 *   - Cash runway weeks             (Cash / max(0, weekly deficit))
 *
 * Statistical significance comes from the strategy outcomes ring. With ≥6
 * weekly weeklyResult samples we bootstrap a 90% CI on EBIT (and DOL) by
 * resampling 500× with replacement; the gate passes when the EBIT CI does
 * not cross zero. Bootstrap chosen over analytic σ-propagation because EBIT
 * sits near zero often enough that 1/EBIT analytic intervals blow up.
 *
 * Salary source policy: prefer the staff-overview "next week" total (the
 * forward commitment the user has already locked in via the per-row form)
 * when it post-dates the income snapshot AND any role has a pending change.
 * Otherwise fall back to the income-statement Salaries actual. This catches
 * the one-tick lag between user pay edits and the income line moving.
 */
class AccountingOperatingLeverage {
    static FIXED_LABELS = {
        salaries:           "Salaries",
        maintenance:        "Maintenance",
        depreciationFleet:  "Depreciation of flight equipment",
        depreciationBldgs:  "Depreciation of buildings",
        interest:           "Interest expenditure",
        leasing:            "Leasing installments"
    }

    static REVENUE_LABELS = ["Passenger revenue", "Cargo revenue", "Other revenue"]
    static FUEL_LABEL     = "Fuel"

    static BOOTSTRAP_DRAWS = 500
    static MIN_SAMPLES     = 6

    /**
     * @param {object} args - {ledger, staffSnapshot?, outcomes?}
     *   ledger:        AccountingAggregator.loadUnifiedLedger result
     *   staffSnapshot: CrewMgmtStaffOverviewStore.loadLatest() result | null
     *   outcomes:      array of weekly EBIT samples | null
     *                  (caller pulls from AesStrategyOutcomes.loadAll())
     * @returns leverage report (see field comments below)
     */
    static compute(args) {
        const a = args || {}
        const ledger = a.ledger
        const incomeRows = (ledger && ledger._latestIncomeRows) || []
        if (!incomeRows.length) {
            return {
                available: false,
                reason: "No income snapshot — visit /app/finance/accounting/0 to capture."
            }
        }
        const periodScrapedAt = (ledger.periodActuals && ledger.periodActuals.scrapedAt) || 0
        const staffSnapshot   = a.staffSnapshot || null
        const samples         = AccountingOperatingLeverage._collectSamples(a.outcomes)

        const fixed = AccountingOperatingLeverage._fixed(incomeRows, staffSnapshot, periodScrapedAt)
        const variable = AccountingOperatingLeverage._variable(incomeRows)

        const contribution = variable.revenue - variable.totalVariable
        const cmr          = variable.revenue > 0 ? contribution / variable.revenue : null
        const breakEvenRevenue = (cmr != null && cmr > 0)
            ? fixed.total / cmr
            : (fixed.total === 0 ? 0 : Infinity)
        const marginOfSafety    = variable.revenue - breakEvenRevenue
        const marginOfSafetyPct = variable.revenue > 0 ? marginOfSafety / variable.revenue : null

        const ebit = contribution - fixed.total
        const dol  = (Number.isFinite(ebit) && ebit !== 0) ? contribution / ebit : null

        const cashStart     = AccountingOperatingLeverage._cashStart(ledger)
        const weeklyDeficit = Math.max(0, -ebit)
        let runwayWeeks
        if (cashStart != null && weeklyDeficit > 0) runwayWeeks = cashStart / weeklyDeficit
        else if (weeklyDeficit === 0)               runwayWeeks = Infinity
        else                                        runwayWeeks = null

        const significance = AccountingOperatingLeverage._significance(samples, fixed.total)
        const dolCI        = significance.dolCI
        const badges       = AccountingOperatingLeverage._badges({
            significance, fixed, variable, cmr, ebit, runwayWeeks, marginOfSafety
        })

        return {
            available: true,
            weekId: ledger.periodActuals && ledger.periodActuals.weekId,
            fixed,
            variable,
            contribution,
            contributionMarginRatio: cmr,
            breakEvenRevenue,
            marginOfSafety,
            marginOfSafetyPct,
            ebit,
            dol,
            dolCI,
            cashStart,
            weeklyDeficit,
            runwayWeeks,
            significance,
            badges
        }
    }

    static _fixed(incomeRows, staffSnapshot, periodScrapedAt) {
        const get = (label) => {
            const row = incomeRows.find(r => r && r.label === label)
            return row && Number.isFinite(row.current) ? row.current : 0
        }
        const incomeSalaries = get(AccountingOperatingLeverage.FIXED_LABELS.salaries)

        let salaries = incomeSalaries
        let salariesSource = "income"
        if (staffSnapshot
            && staffSnapshot.totals
            && Number.isFinite(staffSnapshot.totals.nextWeekTotal)
            && staffSnapshot.scrapedAt > periodScrapedAt
            && AccountingOperatingLeverage._hasPendingChange(staffSnapshot)) {
            salaries = staffSnapshot.totals.nextWeekTotal
            salariesSource = "staffOverview"
        }

        const maintenance       = get(AccountingOperatingLeverage.FIXED_LABELS.maintenance)
        const depreciationFleet = get(AccountingOperatingLeverage.FIXED_LABELS.depreciationFleet)
        const depreciationBldgs = get(AccountingOperatingLeverage.FIXED_LABELS.depreciationBldgs)
        const depreciation      = depreciationFleet + depreciationBldgs
        const interest          = get(AccountingOperatingLeverage.FIXED_LABELS.interest)
        const leasing           = get(AccountingOperatingLeverage.FIXED_LABELS.leasing)

        const total = salaries + maintenance + depreciation + interest + leasing
        return {salaries, maintenance, depreciation, depreciationFleet, depreciationBldgs,
                interest, leasing, total, salariesSource}
    }

    static _variable(incomeRows) {
        let revenue = 0
        for (const label of AccountingOperatingLeverage.REVENUE_LABELS) {
            const row = incomeRows.find(r => r && r.label === label)
            if (row && Number.isFinite(row.current)) revenue += row.current
        }
        const fuelRow = incomeRows.find(r => r && r.label === AccountingOperatingLeverage.FUEL_LABEL)
        const fuel    = fuelRow && Number.isFinite(fuelRow.current) ? fuelRow.current : 0
        // Only Fuel is reliably variable in AS; everything else is treated
        // as fixed for the purpose of break-even / DOL.
        const totalVariable = fuel
        return {revenue, fuel, otherVariable: 0, totalVariable}
    }

    static _hasPendingChange(staffSnapshot) {
        for (const s of (staffSnapshot.sections || [])) {
            for (const r of (s.roles || [])) {
                if (r.pendingChange) return true
            }
        }
        return false
    }

    static _cashStart(ledger) {
        const sisters = (ledger && ledger.sisters) || {}
        const cashflow = sisters.cashflow && sisters.cashflow.payload
        if (cashflow && Array.isArray(cashflow.tables)) {
            for (const t of cashflow.tables) {
                for (const row of t.rows || []) {
                    if (!row || !Array.isArray(row.numericValues)) continue
                    if (/cash|balance/i.test(row.label || "")) {
                        for (const v of row.numericValues) {
                            if (v && v.value != null && Number.isFinite(v.value)) return v.value
                        }
                    }
                }
            }
        }
        return null
    }

    static _collectSamples(outcomes) {
        if (!Array.isArray(outcomes)) return []
        const out = []
        for (const o of outcomes) {
            if (!o) continue
            const v = (o.after && Number(o.after.weeklyResult))
                ?? (o.before && Number(o.before.weeklyResult))
            if (Number.isFinite(v)) out.push(v)
        }
        return out
    }

    static _significance(samples, fixedTotal) {
        const sampleCount = samples.length
        if (sampleCount < AccountingOperatingLeverage.MIN_SAMPLES) {
            return {
                sampleCount,
                gatePassed: false,
                ebitCI: null,
                ebitCrossesZero: null,
                dolCI: null
            }
        }

        const ebitDraws = []
        const dolDraws  = []
        const N = AccountingOperatingLeverage.BOOTSTRAP_DRAWS
        for (let i = 0; i < N; i++) {
            let sum = 0
            for (let j = 0; j < sampleCount; j++) {
                sum += samples[Math.floor(Math.random() * sampleCount)]
            }
            const drawEbit = sum / sampleCount
            const drawCont = drawEbit + fixedTotal
            ebitDraws.push(drawEbit)
            if (drawEbit !== 0) dolDraws.push(drawCont / drawEbit)
        }
        ebitDraws.sort((a, b) => a - b)
        dolDraws.sort((a, b) => a - b)

        const pick = (arr, q) => {
            if (!arr.length) return null
            const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * q)))
            return arr[idx]
        }
        const ebitCI = {p05: pick(ebitDraws, 0.05), p95: pick(ebitDraws, 0.95)}
        const dolCI  = {
            p05: pick(dolDraws, 0.05),
            p50: pick(dolDraws, 0.50),
            p95: pick(dolDraws, 0.95)
        }
        const ebitCrossesZero = ebitCI.p05 != null && ebitCI.p95 != null
            && ebitCI.p05 < 0 && ebitCI.p95 > 0
        return {
            sampleCount,
            gatePassed: !ebitCrossesZero,
            ebitCI,
            ebitCrossesZero,
            dolCI
        }
    }

    static _badges(args) {
        const badges = []
        const sig = args.significance
        if (!sig.gatePassed) {
            const reason = sig.sampleCount < AccountingOperatingLeverage.MIN_SAMPLES
                ? "Need ≥" + AccountingOperatingLeverage.MIN_SAMPLES + " weekly outcomes for a confidence band — have " + sig.sampleCount + "."
                : "EBIT confidence interval crosses zero — leverage estimates not yet statistically significant."
            badges.push({kind: "warning", text: reason})
        }
        if (args.fixed.salariesSource === "staffOverview") {
            badges.push({kind: "info", text: "Salaries reflect a forward commitment from staff overview (pending change)."})
        }
        if (args.cmr != null && args.cmr <= 0) {
            badges.push({kind: "warning", text: "Contribution margin ≤ 0 — variable costs exceed revenue. Break-even is undefined."})
        }
        if (args.runwayWeeks != null && Number.isFinite(args.runwayWeeks) && args.runwayWeeks < 8) {
            badges.push({kind: "warning", text: "Cash runway under 8 weeks at current burn."})
        }
        return badges
    }
}

if (typeof window !== "undefined") {
    window.AccountingOperatingLeverage = AccountingOperatingLeverage
}
