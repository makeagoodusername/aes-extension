/**
 * Modeled-vs-actual reconciliation. Pulls the latest accounting income
 * statement out of the ledger, indexes its rows by AS's labels, and produces
 * a category-by-category comparison against route-assistant's modelled
 * costs. Where route-assistant currently zeros the cost (Maintenance,
 * Salaries, Leasing installments — see profit-estimator.js out-of-scope
 * notes), the gap = the actual, and we suggest a calibration value that
 * would make the model match.
 *
 * Approximations are intentional and labelled for the user:
 *   - "per-flight" suggestion = actual / total weekly flights (round-trips).
 *     Easy to apply via `economics.otherFixedPerFlight`.
 *   - "per-block-hour" suggestion = actual / sum(blockHours/wk), where
 *     blockHours per round-trip is approximated as `2 × distance / 800kph
 *     + 0.5h` (matches profit-estimator's FIXED_TURN_HOURS).
 *
 * The applier is in `panel.js` — it reads RouteAssistantSettings, merges
 * the chosen suggestion into the economics block, and saves.
 */
class AccountingReconciliation {
    static AVG_CRUISE_KMH = 800

    static CATEGORIES = [
        {label: "Passenger revenue", side: "revenue", modeledFromRoutes: false},
        {label: "Cargo revenue", side: "revenue", modeledFromRoutes: false},
        {label: "Fuel", side: "cost", modeledFromRoutes: true,
            suggest: "perBlockHour", suggestField: "fuelCostPerHour"},
        {label: "Maintenance", side: "cost", modeledZero: true,
            suggest: "perBlockHour", suggestField: "maintenanceCostPerHour"},
        {label: "Salaries", side: "cost", modeledZero: true,
            suggest: "perBlockHour", suggestField: "crewCostPerHour"},
        {label: "Leasing installments", side: "cost", modeledZero: true,
            suggest: "perFlight", suggestField: "otherFixedPerFlight"},
        {label: "Depreciation of flight equipment", side: "cost", modeledZero: true,
            suggest: null, note: "Not modelled per route — surfaced for projector use."},
        {label: "Depreciation of buildings", side: "cost", modeledZero: true,
            suggest: null, note: "Airline-wide overhead — not per-route."},
        {label: "Interest expenditure", side: "cost", modeledZero: true,
            suggest: null, note: "Airline-wide overhead — projector only."}
    ]

    /**
     * @param {object} ledger - from AccountingAggregator.loadUnifiedLedger
     * @returns {object} {categories: [...], operatingMetrics: {...}, available: bool, reason?}
     */
    static reconcile(ledger) {
        const periodActuals = ledger.periodActuals
        if (!periodActuals || !periodActuals.totals) {
            return {
                available: false,
                reason: "No accounting income snapshot stored yet. Visit the Income Statement tab to capture."
            }
        }

        const incomeRows = AccountingReconciliation._extractIncomeRows(ledger)
        if (!incomeRows) {
            return {
                available: false,
                reason: "Stored snapshot is missing detailed rows — re-visit the Income Statement tab."
            }
        }

        const operating = AccountingReconciliation._operatingMetrics(ledger)

        const categories = AccountingReconciliation.CATEGORIES.map(cat => {
            const actual = incomeRows[cat.label] || null
            const result = {
                label: cat.label,
                side: cat.side,
                modeledZero: !!cat.modeledZero,
                suggestField: cat.suggestField || null,
                actualCurrent: actual?.current ?? null,
                actualLast: actual?.last ?? null,
                actualPrevious: actual?.previous ?? null,
                actualTotal: actual?.total ?? null,
                modeledCurrent: AccountingReconciliation._modeledForCategory(cat, ledger),
                gap: null,
                gapPct: null,
                suggestion: null,
                note: cat.note || null
            }
            if (result.actualCurrent != null && result.modeledCurrent != null) {
                result.gap = result.actualCurrent - result.modeledCurrent
                if (result.modeledCurrent !== 0) {
                    result.gapPct = (result.gap / Math.abs(result.modeledCurrent)) * 100
                }
            }
            if (cat.suggest && result.actualCurrent != null) {
                result.suggestion = AccountingReconciliation._suggest(
                    cat, result.actualCurrent, operating
                )
            }
            return result
        })

        return {
            available: true,
            weekId: periodActuals.weekId,
            categories,
            operatingMetrics: operating
        }
    }

    /**
     * Loads the row map from the latest stored income snapshot. Slice 1 saves
     * the full row list under `payload.rows`; we re-index by `label` here so
     * lookups are O(1).
     */
    static _extractIncomeRows(ledger) {
        const wk = ledger.periodActuals?.weekId
        if (!wk) return null
        const periodTotals = ledger.periodActuals?.totals
        if (!periodTotals) return null

        const rowsArray = ledger._latestIncomeRows
        if (Array.isArray(rowsArray)) {
            return AccountingReconciliation._indexRows(rowsArray)
        }
        return null
    }

    static _indexRows(rows) {
        const map = {}
        for (const r of rows) {
            if (r && r.label) map[r.label] = r
        }
        return map
    }

    static _operatingMetrics(ledger) {
        let weeklyFlights = 0
        let weeklyKm = 0
        let weeklyBlockHours = 0
        for (const r of ledger.routes) {
            if (r.weeklyFlights && r.distanceKm) {
                weeklyFlights += r.weeklyFlights
                weeklyKm += r.weeklyFlights * r.distanceKm * 2
                const perRtBh = (r.distanceKm * 2) / AccountingReconciliation.AVG_CRUISE_KMH + 0.5
                weeklyBlockHours += r.weeklyFlights * perRtBh
            }
        }
        return {weeklyFlights, weeklyKm, weeklyBlockHours}
    }

    static _modeledForCategory(cat, ledger) {
        if (cat.modeledZero) return 0
        return null
    }

    static _suggest(cat, actualCurrent, operating) {
        if (cat.suggest === "perFlight") {
            if (!operating.weeklyFlights) return null
            return {
                method: "perFlight",
                value: actualCurrent / operating.weeklyFlights,
                field: cat.suggestField,
                explanation: `${actualCurrent.toLocaleString()} AS$ / ${operating.weeklyFlights} round-trips per week`
            }
        }
        if (cat.suggest === "perBlockHour") {
            if (!operating.weeklyBlockHours) return null
            return {
                method: "perBlockHour",
                value: actualCurrent / operating.weeklyBlockHours,
                field: cat.suggestField,
                explanation: `${actualCurrent.toLocaleString()} AS$ / ~${operating.weeklyBlockHours.toFixed(1)} block-hours per week (avg cruise 800 km/h)`
            }
        }
        return null
    }

    /**
     * Applies a suggested calibration value into the route-assistant economics
     * block. Reads the current settings to preserve sibling fields, merges
     * the new value, and saves. Returns the updated economics block on
     * success or null when route-assistant settings aren't available.
     */
    static async applySuggestion(field, value) {
        if (typeof RouteAssistantSettings === "undefined") return null
        if (!field || !Number.isFinite(value)) return null
        const current = await RouteAssistantSettings.load()
        const economics = Object.assign({}, current.economics, {[field]: value})
        await RouteAssistantSettings.save({economics})
        return economics
    }
}
