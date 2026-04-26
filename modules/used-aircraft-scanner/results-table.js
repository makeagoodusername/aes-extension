/**
 * Renders aggregated scan results as a sortable HTML table inside a target
 * element, plus a "Download CSV" button. CSV is opened cleanly by Excel /
 * Numbers / Google Sheets.
 *
 * Optional scoring + filtering: set a scoring config via setScoring() and the
 * table filters rows (min/max per variable) and computes a 0–100 score column
 * that blends every enabled variable (age/price lower-is-better, condition
 * higher-is-better, etc.). Score is normalised within the current result set,
 * so ranking is relative — the "best deal" visible is always 100, the worst 0.
 */
class MarketScanResultsTable {
    constructor(targetEl) {
        this.target = targetEl
        this.rows = []
        this.sortField = null
        this.sortDir = 1   // 1 = asc, -1 = desc
        this.scoring = null
        this.routeFilter = null
        this.overrides = null   // settings.usedAircraftScanner.typeFamilyOverrides
        // Cross-feature context for deal-scoring (slice 2 of J).
        // Defaults are nulls so the table works without RA loaded.
        this.context = {fleetByType: null, economics: null, topRoutes: null, topRoutesHub: null}
    }

    /** Replace the rows and re-render. */
    render(rows) {
        this.rows = rows || []
        this._draw()
    }

    /**
     * Update the scoring/filter config and re-render.
     * Config shape matches UsedAircraftPresets._defaults().scoring.
     */
    setScoring(config) {
        this.scoring = config || null
        this._draw()
    }

    /**
     * Update the route filter and re-render. Currently a single hard filter:
     * {minRangeKm: number} — drops offers whose aircraft can't reach that
     * distance. Rows with unknown range are kept (graceful) so a missed
     * type-spec fetch doesn't accidentally hide everything.
     */
    setRouteFilter(filter) {
        this.routeFilter = filter || null
        this._draw()
    }

    /**
     * Provide the user's `typeFamilyOverrides` so family resolution in the
     * Family column matches what the controller sees at scan time. Pass null
     * to clear.
     */
    setOverrides(overrides) {
        this.overrides = overrides || null
        this._draw()
    }

    /**
     * Provide cross-feature context for deal-scoring metrics ($/seat,
     * break-even days, fleet synergy, route-fit). Shape:
     *   {fleetByType: Map|null, economics: object|null,
     *    topRoutes: array|null, topRoutesHub: string|null}
     * Any field may be null — the corresponding metric will simply
     * fall through to em-dash. Pass null to clear.
     */
    setContext(ctx) {
        this.context = ctx || {fleetByType: null, economics: null, topRoutes: null, topRoutesHub: null}
        this._draw()
    }

    _draw() {
        this.target.innerHTML = ""

        const scoringActive = this._scoringActive()
        // Enrich BEFORE filter/score/sort so familyName participates in sort
        // and survives _scoreRows()'s Object.assign spread. Deal metrics
        // (pricePerSeat, breakEvenDays, etc.) are decorated in the same pass
        // so they're available for both filtering and the score blend.
        const enriched = this._enrichDeal(this._enrichFamily(this.rows))
        const filteredRows = this._applyFilters(enriched)
        const scoredRows = scoringActive ? this._scoreRows(filteredRows) : filteredRows

        // Default to sorting by Score when scoring is active and the user
        // hasn't picked a different column yet.
        if (scoringActive && !this.sortField) {
            this.sortField = "score"
            this.sortDir = -1
        }

        if (!scoredRows.length) {
            const empty = document.createElement("p")
            empty.className = "warning"
            empty.innerText = this.rows.length
                ? "No offers match the current filters."
                : "No offers found yet."
            this.target.append(empty)
            return
        }

        const columns = this._activeColumns(scoringActive)
        const sorted = this._sortedRows(columns, scoredRows)

        const table = document.createElement("table")
        table.className = "table table-bordered table-striped table-hover"
        table.id = "aes-marketScan-resultsTable"

        const thead = document.createElement("thead")
        const headRow = document.createElement("tr")
        for (const col of columns) {
            const th = document.createElement("th")
            th.style.cursor = "pointer"
            th.innerText = col.label + (this.sortField === col.field
                ? (this.sortDir === 1 ? " ▲" : " ▼") : "")
            th.addEventListener("click", () => {
                if (this.sortField === col.field) this.sortDir = -this.sortDir
                else { this.sortField = col.field; this.sortDir = col.defaultDir || 1 }
                this._draw()
            })
            if (col.align === "right") th.style.textAlign = "right"
            headRow.append(th)
        }
        thead.append(headRow)
        table.append(thead)

        const tbody = document.createElement("tbody")
        for (const row of sorted) {
            const tr = document.createElement("tr")
            let isFirst = true
            for (const col of columns) {
                const td = document.createElement("td")
                if (isFirst) {
                    // Color rail — first cell gets a 4px left border in the
                    // family-category color so each row's family is obvious
                    // at a glance even when the table is sorted away from
                    // the Family column.
                    td.style.borderLeft = "4px solid " + (row._familyColor || "#ddd")
                    td.style.paddingLeft = "8px"
                    isFirst = false
                }
                if (col.align === "right") td.className = "text-right"
                const value = row[col.field]
                if (col.field === "offerUrl") {
                    if (value) {
                        const a = document.createElement("a")
                        a.href = value
                        a.target = "_blank"
                        a.rel = "noreferrer noopener"
                        a.innerText = "Open offer"
                        td.append(a)
                    } else {
                        td.innerText = "—"
                    }
                } else if (col.field === "score") {
                    MarketScanResultsTable._renderScoreCell(td, value)
                } else if (col.renderer === "maintPill") {
                    MarketScanResultsTable._renderMaintCell(td, row)
                } else if (col.renderer === "fleetBadge") {
                    MarketScanResultsTable._renderFleetCell(td, row)
                } else if (col.currency) {
                    if (value === null || value === undefined || value === "") {
                        td.innerText = "—"
                    } else if (typeof AES !== "undefined" && AES.formatCurrency) {
                        td.append(AES.formatCurrency(value))
                    } else {
                        td.innerText = String(value)
                    }
                } else if (value === null || value === undefined || value === "") {
                    td.innerText = "—"
                } else {
                    td.innerText = String(value)
                }
                tr.append(td)
            }
            tbody.append(tr)
        }
        table.append(tbody)

        const well = document.createElement("div")
        well.className = "as-table-well"
        well.append(table)
        this.target.append(well)
    }

    _scoringActive() {
        if (!this.scoring) return false
        for (const f of MarketScanResultsTable.scoringFields()) {
            if (this.scoring[f.field] && this.scoring[f.field].enabled) return true
        }
        return false
    }

    _activeColumns(scoringActive) {
        const cols = MarketScanResultsTable.columns().slice()
        if (scoringActive) {
            cols.unshift({field: "score", label: "Score", align: "right", number: true, defaultDir: -1})
        }
        // When the user has a Route Assistant hub published, name it in
        // the Route-fit header so the count is unambiguous about which
        // hub's top-N it's measuring against.
        const hub = this.context && this.context.topRoutesHub
        if (hub) {
            const fit = cols.find(c => c.field === "routeFitLabel")
            if (fit) fit.label = "Route-fit (" + hub + ")"
        }
        return cols
    }

    _applyFilters(rows) {
        let result = rows.slice()

        // Route-requirements filter: drop offers whose aircraft can't reach
        // the configured route distance. Unknown range => keep (rows where
        // type-spec fetch missed shouldn't silently disappear).
        const minRangeKm = this.routeFilter && numOrNull(this.routeFilter.minRangeKm)
        if (minRangeKm !== null && minRangeKm > 0) {
            result = result.filter(r => {
                const v = r.range
                if (v === null || v === undefined || v === "") return true
                return Number(v) >= minRangeKm
            })
        }

        if (!this.scoring) return result
        const fields = MarketScanResultsTable.scoringFields()
        const filters = []
        for (const f of fields) {
            const cfg = this.scoring[f.field]
            if (!cfg) continue
            const min = numOrNull(cfg.min)
            const max = numOrNull(cfg.max)
            if (min === null && max === null) continue
            filters.push({field: f.field, min: min, max: max})
        }
        if (!filters.length) return result
        return result.filter(r => filters.every(f => {
            const v = r[f.field]
            if (v === null || v === undefined || v === "") return true  // don't reject missing data
            if (f.min !== null && Number(v) < f.min) return false
            if (f.max !== null && Number(v) > f.max) return false
            return true
        }))
    }

    _scoreRows(rows) {
        const fields = MarketScanResultsTable.scoringFields()
            .filter(f => this.scoring[f.field] && this.scoring[f.field].enabled)
        if (!fields.length) return rows.slice()

        // Precompute min/max per enabled variable across the visible set.
        const ranges = {}
        for (const f of fields) {
            let lo = Infinity, hi = -Infinity
            for (const r of rows) {
                const v = r[f.field]
                if (v === null || v === undefined || v === "") continue
                const n = Number(v)
                if (!isFinite(n)) continue
                if (n < lo) lo = n
                if (n > hi) hi = n
            }
            ranges[f.field] = {lo: lo, hi: hi}
        }

        return rows.map(r => {
            // Weighted average across enabled scoring fields. weight=1 for
            // every field reduces to the simple mean (current behaviour).
            // A field that's missing on this row contributes neither to the
            // numerator nor the denominator — so rows with missing data
            // aren't penalised for it.
            let weightedSum = 0, weightTotal = 0
            for (const f of fields) {
                const cfg = this.scoring[f.field]
                const w = numericWeight(cfg && cfg.weight)
                if (w <= 0) continue
                const v = r[f.field]
                if (v === null || v === undefined || v === "") continue
                const n = Number(v)
                if (!isFinite(n)) continue
                const {lo, hi} = ranges[f.field]
                let norm
                if (hi === lo) norm = 1
                else norm = (n - lo) / (hi - lo)
                const directional = f.direction === "lower" ? (1 - norm) : norm
                weightedSum += directional * w
                weightTotal += w
            }
            const score = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) : null
            return Object.assign({score: score}, r)
        })
    }

    _sortedRows(columns, rows) {
        if (!this.sortField) return rows.slice()
        const col = columns.find(c => c.field === this.sortField)
        const key = (col && col.sortKey) || this.sortField
        const num = !!(col && (col.currency || col.number || col.sortKey))
        const dir = this.sortDir
        return rows.slice().sort((a, b) => {
            const va = a[key]
            const vb = b[key]
            if (va === vb) return 0
            if (va === null || va === undefined || va === "") return 1
            if (vb === null || vb === undefined || vb === "") return -1
            if (num) return (Number(va) - Number(vb)) * dir
            return String(va).localeCompare(String(vb)) * dir
        })
    }

    /** Triggers a CSV download in the user's browser. */
    downloadCsv(filename) {
        const scoringActive = this._scoringActive()
        const enriched = this._enrichDeal(this._enrichFamily(this.rows))
        const filtered = this._applyFilters(enriched)
        const scored = scoringActive ? this._scoreRows(filtered) : filtered
        const columns = this._activeColumns(scoringActive)
        const headers = columns.map(c => c.label)
        const lines = [headers.map(MarketScanResultsTable._csvEscape).join(",")]
        for (const row of scored) {
            const cells = columns.map(c => {
                if (c.csv) return c.csv(row)
                return row[c.field]
            })
            lines.push(cells.map(MarketScanResultsTable._csvEscape).join(","))
        }
        const blob = new Blob([lines.join("\r\n")], {type: "text/csv;charset=utf-8;"})
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename || ("aes-market-scan-" + Date.now() + ".csv")
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    static _csvEscape(value) {
        if (value === null || value === undefined) return ""
        const s = String(value)
        if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
        return s
    }

    /**
     * Decorates each row with the slice-2 deal metrics (pricePerSeat,
     * seatKmYearCost, breakEvenDays, fleetOwned/Count/Label, routeFit*,
     * maintLevel/Label/Color). Mutates row copies — does not touch
     * this.rows.
     *
     * Context comes from setContext({fleetByType, economics, topRoutes}).
     * Missing context = metric stays null = em-dash in cell + score
     * blend skips that variable for that row (it's not zeroed, just
     * weight-deducted).
     */
    _enrichDeal(rows) {
        if (typeof MarketScanDealMetrics === "undefined") return rows
        const ctx = this.context || {}
        return rows.map(r => MarketScanDealMetrics.decorate(Object.assign({}, r), ctx))
    }

    /**
     * Adds {familyName, familyCategory, _familyColor} to each row by
     * resolving its aircraftType through TypeFamilyMap, honouring any user
     * overrides set via setOverrides(). Returns a new array — does not
     * mutate this.rows.
     */
    _enrichFamily(rows) {
        const overrides = this.overrides || {}
        return rows.map(r => {
            const family = r.aircraftType
                ? (TypeFamilyMap.resolve(r.aircraftType, overrides) || "")
                : ""
            const category = TypeFamilyMap.category(family)
            return Object.assign({}, r, {
                familyName:     family,
                familyCategory: category,
                _familyColor:   TypeFamilyMap.categoryColor(category)
            })
        })
    }

    static _renderScoreCell(td, value) {
        if (value === null || value === undefined) {
            td.innerText = "—"
            return
        }
        const n = Math.max(0, Math.min(100, Number(value) || 0))
        // Red → yellow → green gradient.
        const hue = Math.round((n / 100) * 120)
        td.style.backgroundColor = `hsl(${hue}, 70%, 40%)`
        td.style.color = "white"
        td.style.fontWeight = "bold"
        td.innerText = String(n)
    }

    /**
     * Maintenance trajectory pill — green/amber/red badge from
     * MarketScanDealMetrics.maintenanceTrajectory(). Tooltip carries the
     * raw inputs so the user can sanity-check the bucket if they suspect
     * the row landed in the wrong band.
     */
    static _renderMaintCell(td, row) {
        if (!row.maintLevel) { td.innerText = "—"; return }
        const pill = document.createElement("span")
        pill.textContent = row.maintLabel || row.maintLevel
        pill.style.display      = "inline-block"
        pill.style.padding      = "2px 8px"
        pill.style.borderRadius = "10px"
        pill.style.background   = row.maintColor || "#666"
        pill.style.color        = "white"
        pill.style.fontSize     = "85%"
        pill.style.fontWeight   = "600"
        const cond = (row.conditionPct !== null && row.conditionPct !== undefined) ? row.conditionPct + "%" : "?"
        const age  = (row.ageYears     !== null && row.ageYears     !== undefined) ? row.ageYears     + "y" : "?"
        pill.title = "Condition: " + cond + " · Age: " + age
        td.append(pill)
    }

    /**
     * Fleet-synergy badge — small green pill when the user already
     * operates this typeId, otherwise em-dash. Sourced from
     * RouteAssistantFleetStore via context.fleetByType.
     */
    static _renderFleetCell(td, row) {
        if (!row.fleetOwned) {
            td.innerText = "—"
            return
        }
        const pill = document.createElement("span")
        pill.textContent = row.fleetLabel || "✓"
        pill.style.display      = "inline-block"
        pill.style.padding      = "2px 8px"
        pill.style.borderRadius = "10px"
        pill.style.background   = "#16a34a"
        pill.style.color        = "white"
        pill.style.fontSize     = "85%"
        pill.style.fontWeight   = "600"
        pill.title = "Already in your fleet — no new training/maintenance footprint"
        td.append(pill)
    }

    static columns() {
        return [
            {field: "familyName",        label: "Family"},
            {field: "aircraftType",      label: "Aircraft Type"},
            {field: "seats",             label: "Seats",        align: "right", number: true},
            {field: "cargoCapacity",     label: "Cargo (kg)",   align: "right", number: true},
            {field: "speed",             label: "Speed (km/h)", align: "right", number: true},
            {field: "range",             label: "Range (km)",   align: "right", number: true},
            {field: "paxSatisfaction",   label: "Pax Sat.",     align: "right", number: true},
            {field: "age",               label: "Age",          sortKey: "ageYears"},
            {field: "condition",         label: "Condition",    sortKey: "conditionPct"},
            // Slice-2 deal metrics — render between condition and the price
            // columns so "buy / hold / fits" reads left-to-right.
            {field: "pricePerSeat",      label: "$/seat",       align: "right", currency: true,
                csv: r => r.pricePerSeat},
            {field: "seatKmYearCost",    label: "$/seat·km/yr", align: "right", number: true,
                csv: r => r.seatKmYearCost},
            {field: "breakEvenDays",     label: "BE (days)",    align: "right", number: true,
                csv: r => r.breakEvenDays},
            {field: "maintLevel",        label: "Maint.",       sortKey: "maintRank",
                renderer: "maintPill",
                csv: r => r.maintLabel},
            {field: "fleetLabel",        label: "Fleet",        sortKey: "fleetOwnedCount",
                renderer: "fleetBadge",
                csv: r => r.fleetOwned ? ("owned (" + (r.fleetOwnedCount || 0) + ")") : ""},
            {field: "routeFitLabel",     label: "Route-fit",    align: "right", sortKey: "routeFitCount",
                csv: r => r.routeFitLabel || ""},
            {field: "nextBid",           label: "Next Bid",           align: "right", currency: true},
            {field: "immediatePurchase", label: "Immediate Purchase", align: "right", currency: true},
            {field: "leasingRate",       label: "Leasing Rate",       align: "right", currency: true},
            {field: "location",          label: "Location"},
            {field: "registration",      label: "Registration"},
            {field: "owner",             label: "Owner"},
            {field: "bidInterval",       label: "Bid Interval", sortKey: "bidIntervalMs"},
            {field: "offerUrl",          label: "Link"}
        ]
    }

    /**
     * Variables eligible for scoring/filtering, with the direction that means
     * "this offer is better" (so we can flip age/price vs condition correctly).
     *
     * Slice-2 additions (pricePerSeat, seatKmYearCost, breakEvenDays) all use
     * direction="lower" — cheaper-per-seat / cheaper-per-life-unit / faster-payback
     * is always preferred. Maintenance trajectory and fleet synergy are NOT
     * scored: maint is a categorical signal and synergy is binary, so neither
     * has a meaningful gradient inside the visible result set.
     */
    static scoringFields() {
        return [
            {field: "ageYears",          label: "Age (years)",       direction: "lower"},
            {field: "conditionPct",      label: "Condition (%)",     direction: "higher"},
            {field: "seats",             label: "Seats",             direction: "higher"},
            {field: "cargoCapacity",     label: "Cargo (kg)",        direction: "higher"},
            {field: "speed",             label: "Speed (km/h)",      direction: "higher"},
            {field: "range",             label: "Range (km)",        direction: "higher"},
            {field: "paxSatisfaction",   label: "Pax satisfaction",  direction: "higher"},
            {field: "nextBid",           label: "Next bid (AS$)",    direction: "lower"},
            {field: "immediatePurchase", label: "Immediate (AS$)",   direction: "lower"},
            {field: "leasingRate",       label: "Leasing rate (AS$)", direction: "lower"},
            {field: "pricePerSeat",      label: "$/seat",            direction: "lower"},
            {field: "seatKmYearCost",    label: "$/seat·km/yr",      direction: "lower"},
            {field: "breakEvenDays",     label: "Break-even days",   direction: "lower"},
            {field: "routeFitCount",     label: "Route-fit count",   direction: "higher"}
        ]
    }
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

function numericWeight(v) {
    if (v === null || v === undefined || v === "") return 1
    const n = Number(v)
    if (!isFinite(n) || n < 0) return 1
    return n
}
