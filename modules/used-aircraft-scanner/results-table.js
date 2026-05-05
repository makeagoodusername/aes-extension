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
        // Cross-feature context for deal-scoring (slice 2 of J + slice 4).
        // Defaults are nulls so the table works without RA loaded.
        this.context = {fleetByType: null, economics: null, topRoutes: null,
                        topRoutesHub: null, routeFitConfig: null}
        // When set, replaces the within-set relative scorer with an absolute
        // composite score + deal-class bucketing. The market panel passes
        // one in; the dashboard tile leaves it null and uses the legacy
        // relative scorer so existing behaviour is preserved verbatim.
        this.classifier = null
        // Drives mode-aware price-column visibility: lease mode shows
        // leasingRate, buy mode shows nextBid + immediatePurchase. Default
        // null = legacy behaviour (all three columns shown in wide mode).
        this.leaseConfig = null
        // Narrow mode hides low-priority columns and tightens padding so
        // the table fits inside a sidebar without horizontal scroll.
        this.narrowMode = false
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
     *    topRoutes: array|null, topRoutesHub: string|null,
     *    routeFitConfig: {paxSeatsPerScorePoint?} | null}
     * Any field may be null — the corresponding metric will simply
     * fall through to em-dash. Pass null to clear.
     */
    setContext(ctx) {
        this.context = ctx || {fleetByType: null, economics: null, topRoutes: null,
                               topRoutesHub: null, routeFitConfig: null}
        this._draw()
    }

    /**
     * Provide a `MarketScanDealClassifier` instance. When present the
     * relative `_scoreRows` blender is bypassed; the classifier decorates
     * each row with {dealScore, dealClass, dealLabel, dealColor,
     * dealReasons, dealBreakdown} and the score column reads from
     * `dealScore`. A "Class" badge column is also added.
     *
     * Pass null to revert to the legacy relative scorer.
     */
    setClassifier(classifier) {
        this.classifier = classifier || null
        this._draw()
    }

    /**
     * Provide the active lease/buy config so the table can swap which
     * price columns are visible: lease shows LEASING RATE, buy shows
     * NEXT BID + IMMEDIATE PURCHASE. Pass null to restore the legacy
     * "show everything" behaviour.
     */
    setLeaseConfig(leaseConfig) {
        this.leaseConfig = leaseConfig || null
        this._draw()
    }

    /**
     * Toggles narrow mode for embedding inside a sidebar:
     *   - hides cargoCapacity, paxSatisfaction, lease pair columns when
     *     no leaseConfig is active (mode-aware visibility wins otherwise)
     *   - tightens td/th padding via a one-shot stylesheet
     * Re-renders. Pass false to restore the full column set.
     */
    setNarrowMode(narrow) {
        this.narrowMode = !!narrow
        if (this.narrowMode) MarketScanResultsTable._ensureNarrowStyle()
        this._draw()
    }

    static _ensureNarrowStyle() {
        if (document.getElementById("aes-marketScan-narrow-style")) return
        const s = document.createElement("style")
        s.id = "aes-marketScan-narrow-style"
        s.textContent = "table#aes-marketScan-resultsTable.narrow td,"
                      + "table#aes-marketScan-resultsTable.narrow th {"
                      + "padding:3px 6px !important;font-size:11px;line-height:1.3;}"
                      + "table#aes-marketScan-resultsTable.narrow th {"
                      + "letter-spacing:0.02em;}"
        document.head.appendChild(s)
    }

    _draw() {
        this.target.innerHTML = ""

        const scoringActive = this._scoringActive()
        // When a classifier is set, the caller (the in-page market panel) is
        // expected to have pre-decorated rows with family + deal metrics +
        // dealScore. Skipping re-decoration eliminates the dominant CPU
        // cost on rapid filter/sort interactions. The dashboard tile path
        // still passes through the legacy enrich + relative-scorer flow.
        let enriched
        if (this.classifier) {
            enriched = this.rows
            for (const r of enriched) r.score = r.dealScore
        } else {
            enriched = this._enrichDeal(this._enrichFamily(this.rows))
        }
        const filteredRows = this._applyFilters(enriched)
        const useRelativeScorer = scoringActive && !this.classifier
        const scoredRows = useRelativeScorer ? this._scoreRows(filteredRows) : filteredRows

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
            + (this.narrowMode ? " narrow" : "")
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
                } else if (col.renderer === "dealBadge") {
                    MarketScanResultsTable._renderDealCell(td, row)
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
                if (typeof col.tooltip === "function") {
                    const tip = col.tooltip(row)
                    if (tip) td.title = tip
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
        // Classifier always activates the score column — it produces a score
        // for every row that has any input signal at all.
        if (this.classifier) return true
        if (!this.scoring) return false
        for (const f of MarketScanResultsTable.scoringFields()) {
            if (this.scoring[f.field] && this.scoring[f.field].enabled) return true
        }
        return false
    }

    _activeColumns(scoringActive) {
        let cols = MarketScanResultsTable.columns().slice()
        if (this.classifier) {
            // Score column reads from dealScore (mapped to `score` in _draw).
            // Class badge sits at position 0 so the strongest signal — the
            // bucket — is the leftmost cell after the family rail.
            cols.unshift({field: "score", label: "Score", align: "right",
                          number: true, defaultDir: -1})
            cols.unshift({field: "dealClass", label: "Class",
                          renderer: "dealBadge", sortKey: "dealScore",
                          defaultDir: -1, csv: r => r.dealLabel || ""})
        } else if (scoringActive) {
            cols.unshift({field: "score", label: "Score", align: "right",
                          number: true, defaultDir: -1})
        }
        // When the user has a Route Assistant hub published, name it in
        // the Route-fit header so the count is unambiguous about which
        // hub's top-N it's measuring against.
        const hub = this.context && this.context.topRoutesHub
        if (hub) {
            const fit = cols.find(c => c.field === "routeFitLabel")
            if (fit) fit.label = "Route-fit (" + hub + ")"
        }
        if (this.narrowMode) {
            const hide = new Set([
                "cargoCapacity", "paxSatisfaction",
                "speed",
                "seatKmYearCost", "breakEvenDays",
                "currentBid"
            ])
            cols = cols.filter(c => !hide.has(c.field))
        }
        // Mode-aware price columns: lease mode hides the full-purchase pair
        // and surfaces leasingRate + leasingDepot (the only money the user
        // actually pays — recurring rent + the one-time upfront deposit).
        // Buy mode hides the lease pair and shows nextBid + immediatePurchase
        // (the auction prices that matter for outright purchase).
        const mode = this.leaseConfig && this.leaseConfig.mode === "buy" ? "buy" : "lease"
        if (this.leaseConfig) {
            const hideByMode = mode === "lease"
                ? new Set(["nextBid", "immediatePurchase"])
                : new Set(["leasingRate", "leasingDepot"])
            cols = cols.filter(c => !hideByMode.has(c.field))
        } else if (this.narrowMode) {
            cols = cols.filter(c => c.field !== "leasingRate" && c.field !== "leasingDepot")
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

    /**
     * Multi-line tooltip explaining the BE (days) value — exposes the daily
     * revenue, daily cost, and net daily profit alongside the constants
     * (block hours, panel LF, panel yields, op-cost rates) that produced
     * them. Empty when the metric was missing.
     */
    static _formatBreakEvenTooltip(row) {
        if (!row || !row.breakEvenBreakdown) {
            if (row && row.breakEvenDays === null && row.acquisitionPrice === null) return ""
            return "Break-even unavailable — missing acquisition price, speed, seats, or Route Assistant economics. "
                + "Open the Route Assistant panel and tune economics to populate."
        }
        const b = row.breakEvenBreakdown
        const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "?" : Math.round(n).toLocaleString()
        const fmt2 = n => (n === null || n === undefined || !isFinite(n)) ? "?" : Number(n).toFixed(2)
        const fmt4 = n => (n === null || n === undefined || !isFinite(n)) ? "?" : Number(n).toFixed(4)
        const lines = []
        lines.push("BE (days) = price ÷ profit/day = AS$" + fmt(b.price)
            + " ÷ AS$" + fmt(b.profitPerDay) + "/day = " + b.value + " days")
        lines.push("")
        lines.push("Daily envelope: " + b.hours + "h × " + fmt(b.speed) + " km/h = "
            + fmt(b.dailyKm) + " km/day")
        lines.push("Pax revenue:    " + fmt(b.dailyKm) + " km × " + b.seats + " seats × LF "
            + fmt2(b.loadFactor) + " × y AS$" + fmt4(b.yieldPerKm) + "/pax-km = AS$" + fmt(b.paxRev))
        if (b.cargoRev > 0) {
            lines.push("Cargo revenue:  " + fmt(b.dailyKm) + " km × " + b.cargo + " kg × LF "
                + fmt2(b.cargoLoadFactor) + " × y AS$" + fmt4(b.cargoYieldPerKgKm) + "/kg-km = AS$" + fmt(b.cargoRev))
        }
        const costParts = []
        if (b.fuelPerHour)  costParts.push("fuel AS$" + fmt(b.fuelPerHour))
        if (b.crewPerHour)  costParts.push("crew AS$" + fmt(b.crewPerHour))
        if (b.maintPerHour) costParts.push("maint AS$" + fmt(b.maintPerHour))
        lines.push("Op cost:        " + b.hours + "h × ("
            + (costParts.length ? costParts.join(" + ") : "0")
            + ")/h = AS$" + fmt(b.opCost))
        lines.push("Profit/day:     AS$" + fmt(b.paxRev) + " + AS$" + fmt(b.cargoRev)
            + " − AS$" + fmt(b.opCost) + " = AS$" + fmt(b.profitPerDay))
        lines.push("")
        lines.push("Block hours/day = " + b.hours + "h (by family category — regional 8h, "
            + "narrowbody 12h, widebody 14h). Tuned for 'earliest sensible payback'.")
        return lines.join("\n")
    }

    /**
     * Tooltip for the Route-fit cell — explains all three sequential gates
     * (range, per-flight demand, weekly frequency) so users can see why a
     * regional aircraft scored lower than its range alone would suggest.
     */
    static _formatRouteFitTooltip(row) {
        if (!row || row.routeFitTotal === null || row.routeFitTotal === undefined) return ""
        if (row.routeFitTotal === 0) {
            return "No Route Assistant top-routes published yet. Open the RA panel "
                + "on /app/com/scheduling so it writes a snapshot to "
                + "routeAssistant:topRoutes."
        }
        const fit    = row.routeFitCount === null ? "?" : row.routeFitCount
        const total  = row.routeFitTotal
        const range  = row.routeFitRangeOnly === null ? "?" : row.routeFitRangeOnly
        const demand = row.routeFitDemandLimited || 0
        const freq   = row.routeFitFrequencyLimited || 0
        const lines = []
        lines.push("Route-fit = routes where the aircraft can reach the destination,")
        lines.push("service the per-flight demand, AND meet the weekly demand at the")
        lines.push("route's published frequency.")
        lines.push("")
        lines.push("Range check passes:    " + range + " / " + total)
        lines.push("Demand-limited:        " + demand
            + (demand ? " (range fits but seats × LF below paxScore × scale)" : ""))
        lines.push("Frequency-limited:     " + freq
            + (freq ? " (per-flight fits but weeklyFlights × seats × LF below paxScore × weekly scale)" : ""))
        lines.push("Full fit (final):      " + fit + " / " + total)
        lines.push("")
        lines.push("Tune the per-flight threshold via routeFit.paxSeatsPerScorePoint")
        lines.push("(default 15, so paxScore=10 needs ~150 effective seats per flight).")
        lines.push("Tune the weekly threshold via routeFit.weeklyDemandPerScorePoint")
        lines.push("(default 100, so paxScore=10 needs 1000 effective weekly seats).")
        lines.push("Routes without published weeklyFlights skip the freq gate.")
        return lines.join("\n")
    }

    /**
     * Tooltip for the lifecycle cost ratio. Exposes price ÷ (seats × range
     * × remaining-life) — the four numbers that drive the metric and the
     * 25-year MAX_LIFE assumption that turns age into remaining service.
     */
    static _formatSeatKmYearTooltip(row) {
        if (!row || !row.seatKmYearBreakdown) return ""
        const b = row.seatKmYearBreakdown
        const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "?" : Math.round(n).toLocaleString()
        const lines = []
        lines.push("$/seat·km/yr = price ÷ (seats × range × remaining years)")
        lines.push("            = AS$" + fmt(b.price)
            + " ÷ (" + b.seats + " × " + fmt(b.range)
            + " × " + b.remainingYears + ")")
        lines.push("            = " + b.value)
        lines.push("")
        const ageStr = (b.age === null || b.age === undefined) ? "unknown" : (b.age + " years old")
        lines.push("Remaining years = max(1, " + b.maxLifeYears + " − age) "
            + "where age is " + ageStr + ".")
        lines.push("Lower is better — captures price, capacity, range, and "
            + "remaining life in one ratio.")
        return lines.join("\n")
    }

    /**
     * Tooltip for the $/seat cell. Branches on the row's resolved
     * `priceBasis` ("lease" | "purchase") so the formula and units match
     * what's actually being displayed:
     *   lease    → AS$/seat/mo (monthly lease ÷ seats)
     *   purchase → AS$/seat    (next-bid or immediate-purchase ÷ seats)
     */
    static _formatPricePerSeatTooltip(row) {
        if (!row || row.pricePerSeat === null || row.pricePerSeat === undefined) return ""
        if (!row.seats) return ""
        if (row.priceBasis === "lease") {
            const monthly = isFiniteNumber(row.monthlyLease) ? row.monthlyLease : null
            if (monthly === null) return ""
            return [
                "$/seat/mo = monthly lease ÷ seats",
                "          = AS$" + Math.round(monthly).toLocaleString() + " ÷ " + row.seats,
                "          = AS$" + row.pricePerSeat.toLocaleString() + "/mo",
                "",
                "Cost basis: monthly lease — purchase price is ignored when",
                "lease-first is on (Used Aircraft Scanner → scoring controls)."
            ].join("\n")
        }
        const price = MarketScanDealMetrics.acquisitionPrice(row)
        if (price === null) return ""
        const hasBid = isFiniteNumber(row.nextBid) && row.nextBid > 0
        const hasIp  = isFiniteNumber(row.immediatePurchase) && row.immediatePurchase > 0
        let source
        if (hasBid && hasIp) {
            source = price === row.nextBid
                ? "next bid (cheaper than immediate purchase)"
                : "immediate purchase (cheaper than next bid)"
        } else if (hasBid) {
            source = "next bid (no immediate purchase listed)"
        } else {
            source = "immediate purchase (no bid)"
        }
        return [
            "$/seat = acquisition price ÷ seats",
            "       = AS$" + Math.round(price).toLocaleString() + " ÷ " + row.seats,
            "       = AS$" + row.pricePerSeat.toLocaleString(),
            "",
            "Cost basis: " + source + ".",
            "Lease rate is unavailable for this offer, so the purchase price was used."
        ].join("\n")
    }

    /**
     * Tooltip for the Maintenance pill — surfaces the inputs (condition,
     * age) and the band rules so users can sanity-check why a row landed
     * on a particular colour.
     */
    static _formatMaintTooltip(row) {
        if (!row || !row.maintLevel) return ""
        const cond = (row.conditionPct === null || row.conditionPct === undefined) ? "?" : row.conditionPct + "%"
        const age  = (row.ageYears    === null || row.ageYears    === undefined) ? "?" : row.ageYears + "y"
        return [
            "Maint. = " + row.maintLabel + " (" + row.maintLevel + ")",
            "",
            "Inputs:  condition " + cond + ",  age " + age,
            "",
            "Bands (worst-case rule wins):",
            "  red    cond < 50%  OR  age ≥ 25y  → Heavy",
            "  amber  cond < 75%  OR  age ≥ 15y  → Mid-life",
            "  green  otherwise                  → Fresh"
        ].join("\n")
    }

    /**
     * Tooltip for the Fleet badge — names the typeId match and the
     * synergy-only-counts-by-typeId rule so users don't expect a soft
     * "same family" badge.
     */
    static _formatFleetTooltip(row) {
        if (!row || row.fleetOwned === null || row.fleetOwned === undefined) {
            return "Fleet synergy unavailable — Route Assistant fleet store not loaded yet."
        }
        if (!row.fleetOwned) return "Not currently in your fleet."
        return [
            "✓ Already in your fleet — " + row.fleetOwnedCount + " of this typeId",
            "",
            "Synergy is binary by typeId: same type means no extra crew training,",
            "shared maintenance, common parts pool. Family-level synergy across",
            "different types in the same family is intentionally NOT counted."
        ].join("\n")
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
        td.append(pill)
    }

    /**
     * Deal-class badge — Steal/Great/Good/Fair/Pass with the class color from
     * the classifier. Tooltip lists the rationale chips so the user can see
     * *why* the row landed where it did without opening the side panel.
     */
    static _renderDealCell(td, row) {
        if (!row || !row.dealClass) { td.innerText = "—"; return }
        const pill = document.createElement("span")
        pill.textContent = row.dealLabel || row.dealClass
        pill.style.cssText = "display:inline-block;padding:2px 8px;border-radius:10px;"
            + "background:" + (row.dealColor || "#666") + ";"
            + "color:#fff;font-size:85%;font-weight:700;"
            + "text-transform:uppercase;letter-spacing:0.04em;"
        td.append(pill)
        // Prefer the woven narrative when it's available — full prose
        // beats the chip dump for "why is this a Great deal?". Fall back
        // to the rationale chip list when narrative module is absent
        // (dashboard context doesn't load it).
        let tip = null
        if (typeof MarketScanDealNarrative !== "undefined") {
            tip = MarketScanDealNarrative.summarize(row)
        }
        if (!tip && row.dealReasons && row.dealReasons.length) {
            tip = row.dealReasons.join(" · ")
        }
        if (tip) td.title = tip
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
                csv: r => r.pricePerSeat,
                tooltip: r => MarketScanResultsTable._formatPricePerSeatTooltip(r)},
            {field: "seatKmYearCost",    label: "$/seat·km/yr", align: "right", number: true,
                csv: r => r.seatKmYearCost,
                tooltip: r => MarketScanResultsTable._formatSeatKmYearTooltip(r)},
            {field: "breakEvenDays",     label: "BE (days)",    align: "right", number: true,
                csv: r => r.breakEvenDays,
                tooltip: r => MarketScanResultsTable._formatBreakEvenTooltip(r)},
            {field: "maintLevel",        label: "Maint.",       sortKey: "maintRank",
                renderer: "maintPill",
                csv: r => r.maintLabel,
                tooltip: r => MarketScanResultsTable._formatMaintTooltip(r)},
            {field: "fleetLabel",        label: "Fleet",        sortKey: "fleetOwnedCount",
                renderer: "fleetBadge",
                csv: r => r.fleetOwned ? ("owned (" + (r.fleetOwnedCount || 0) + ")") : "",
                tooltip: r => MarketScanResultsTable._formatFleetTooltip(r)},
            {field: "routeFitLabel",     label: "Route-fit",    align: "right", sortKey: "routeFitCount",
                csv: r => r.routeFitLabel || "",
                tooltip: r => MarketScanResultsTable._formatRouteFitTooltip(r)},
            {field: "nextBid",           label: "Next Bid",           align: "right", currency: true},
            {field: "immediatePurchase", label: "Immediate Purchase", align: "right", currency: true},
            {field: "leasingRate",       label: "Leasing Rate",       align: "right", currency: true},
            {field: "leasingDepot",      label: "Lease Deposit",      align: "right", currency: true},
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
