"use strict"

/**
 * Pure analytics over a CrewMgmtStaffOverviewScraper snapshot + history ring.
 * No I/O — caller passes (latestSnapshot, history) and consumes the report.
 *
 * Surfaces three slices the panel needs:
 *   - byGroup: 4-week trend (slope, R²) per crew section
 *   - byRole:  per-position waste / country-avg deviation / hiring-gap cost
 *   - rollups: redundancy total, country-avg weighted deviation, hiring gap
 */
class CrewMgmtPersonnelCostModel {
    static GROUPS = ["Flight crew", "Cabin crew", "Ground crew"]

    static analyze(latestSnapshot, history) {
        const empty = CrewMgmtPersonnelCostModel._empty()
        if (!latestSnapshot || !Array.isArray(latestSnapshot.sections)) return empty

        const ring = Array.isArray(history) ? history.slice().reverse() : []
        // Reversed so [0] = oldest, last = newest — natural x-axis for slope.

        const byGroup = {}
        for (const groupName of CrewMgmtPersonnelCostModel.GROUPS) {
            byGroup[CrewMgmtPersonnelCostModel._groupKey(groupName)]
                = CrewMgmtPersonnelCostModel._groupAnalysis(groupName, latestSnapshot, ring)
        }

        const byRole = []
        let redundancyTotalWaste     = 0
        let hiringGapTotalWeeklyCost = 0
        let countryAvgNumerator      = 0   // headcount-weighted (salary - countryAvg)
        let countryAvgDenominator    = 0   // headcount-weighted countryAvg

        for (const section of latestSnapshot.sections) {
            for (const r of section.roles || []) {
                const redundancyWaste   = (r.redundant || 0) * (r.salaryPerEmployee || 0)
                const vsCountryAvgPct   = r.countryAverage > 0
                    ? ((r.salaryPerEmployee || 0) - r.countryAverage) / r.countryAverage * 100
                    : null
                const hiringGap         = Math.max(0, (r.required || 0) - (r.employed || 0))
                const hiringGapWeeklyCost = hiringGap * (r.salaryPerEmployee || 0)

                byRole.push({
                    label: r.label,
                    group: section.group,
                    currentWeekly: r.salaryTotal || 0,
                    nextWeekly:    r.nextWeekSalaryTotal || 0,
                    redundancyWaste,
                    vsCountryAvgPct,
                    hiringGapWeeklyCost
                })

                redundancyTotalWaste     += redundancyWaste
                hiringGapTotalWeeklyCost += hiringGapWeeklyCost
                if (r.countryAverage > 0 && r.employed > 0) {
                    countryAvgNumerator   += r.employed * ((r.salaryPerEmployee || 0) - r.countryAverage)
                    countryAvgDenominator += r.employed * r.countryAverage
                }
            }
        }

        const countryAvgWeightedDeviationPct = countryAvgDenominator > 0
            ? (countryAvgNumerator / countryAvgDenominator) * 100
            : null

        return {
            byGroup,
            byRole,
            redundancyTotalWaste,
            hiringGapTotalWeeklyCost,
            countryAvgWeightedDeviationPct,
            coverage: {
                snapshotCount: ring.length,
                weeksSpanned:  ring.length
            }
        }
    }

    static _groupAnalysis(groupName, latestSnapshot, ring) {
        const section = (latestSnapshot.sections || []).find(s => s.group === groupName)
        let currentWeekly = 0, nextWeekly = 0, headcount = 0
        if (section) {
            for (const r of section.roles || []) {
                currentWeekly += r.salaryTotal || 0
                nextWeekly    += r.nextWeekSalaryTotal || 0
                headcount     += r.employed || 0
            }
        }
        const deltaPct = currentWeekly > 0
            ? (nextWeekly - currentWeekly) / currentWeekly * 100
            : null

        // Pull last 4 history points for this group.
        const series = ring
            .map(h => (h.sectionsSummary || []).find(s => s.group === groupName))
            .filter(Boolean)
            .slice(-4)
            .map(s => s.weeklyTotal || 0)
        const trend = CrewMgmtPersonnelCostModel._linfit(series)

        return {
            currentWeekly,
            nextWeekly,
            deltaPct,
            headcount,
            slope4w: trend.slope,
            r2_4w:   trend.r2,
            series   // exposed for sparkline rendering
        }
    }

    /** Linear fit on (i, y) for i = 0..n-1. Returns {slope, intercept, r2}. */
    static _linfit(ys) {
        const n = ys.length
        if (n < 2) return {slope: null, intercept: null, r2: null}
        let sx = 0, sy = 0, sxx = 0, sxy = 0
        for (let i = 0; i < n; i++) {
            sx  += i
            sy  += ys[i]
            sxx += i * i
            sxy += i * ys[i]
        }
        const denom = n * sxx - sx * sx
        if (denom === 0) return {slope: null, intercept: null, r2: null}
        const slope     = (n * sxy - sx * sy) / denom
        const intercept = (sy - slope * sx) / n

        let ssTot = 0, ssRes = 0
        const yMean = sy / n
        for (let i = 0; i < n; i++) {
            const yhat = intercept + slope * i
            ssRes += (ys[i] - yhat) ** 2
            ssTot += (ys[i] - yMean) ** 2
        }
        const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null
        return {slope, intercept, r2}
    }

    static _groupKey(groupName) {
        if (groupName === "Flight crew") return "flight"
        if (groupName === "Cabin crew")  return "cabin"
        if (groupName === "Ground crew") return "ground"
        return groupName.toLowerCase().replace(/\s+/g, "_")
    }

    static _empty() {
        return {
            byGroup: {flight: null, cabin: null, ground: null},
            byRole: [],
            redundancyTotalWaste: 0,
            hiringGapTotalWeeklyCost: 0,
            countryAvgWeightedDeviationPct: null,
            coverage: {snapshotCount: 0, weeksSpanned: 0}
        }
    }
}

if (typeof window !== "undefined") {
    window.CrewMgmtPersonnelCostModel = CrewMgmtPersonnelCostModel
}
