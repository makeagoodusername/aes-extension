/**
 * AES Accounting panel — surfaces stored snapshot history + the most-recent
 * Income Statement totals on the `/app/finance/accounting` page.
 *
 * Slice 1 scope: read the active tab on mount, persist the scrape, render a
 * minimal "stored snapshots" history + latest totals card. Subsequent slices
 * (3, 4, 5) extend `_renderBody()` with profitability cuts, reconciliation,
 * and projection cards — this class is the single mount point for all of
 * them. Re-mount on Wicket DOM swaps via the MutationObserver hook in
 * content_finance_accounting.js (which calls `mount()` again).
 */
class AccountingPanel {
    constructor() {
        this._container = null
    }

    /**
     * Idempotent mount. Detects the active tab, runs the matching scraper,
     * persists the result, and renders the panel. Logs and swallows scraper
     * errors so a parse failure never leaves the page without the panel.
     */
    async mount() {
        const server = AES.getServerName()
        const airline = AES.getAirlineIdentity()
        if (!server || !airline) return

        const activeTab = AccountingPanel._activeTab()

        let weekClosesAt = null
        try {
            if (activeTab === "income") {
                weekClosesAt = await this._captureIncome(server, airline)
            } else if (activeTab === "balance") {
                weekClosesAt = await this._captureBalance(server, airline)
            } else if (activeTab === "bank") {
                weekClosesAt = await this._captureBank(server, airline)
            }
        } catch (err) {
            console.warn("[AES Accounting] capture failed", err)
        }

        await this._render(server, airline, activeTab, weekClosesAt)
    }

    async _captureIncome(server, airline) {
        const scraped = AccountingIncomeScraper.scrape()
        if (!scraped || !scraped.weekClosesAt) return null
        await AccountingSnapshotStore.saveTab({
            server, airline,
            weekId: scraped.weekClosesAt,
            type: "income",
            payload: scraped,
            weekClosesAt: scraped.weekClosesAt
        })
        return scraped.weekClosesAt
    }

    async _captureBalance(server, airline) {
        const scraped = AccountingBalanceScraper.scrape()
        if (!scraped || !scraped.rows.length) return null
        const weekId = await AccountingPanel._inferWeekIdFallback(server, airline)
        if (!weekId) return null
        await AccountingSnapshotStore.saveTab({
            server, airline,
            weekId,
            type: "balance",
            payload: scraped,
            weekClosesAt: weekId
        })
        return weekId
    }

    async _captureBank(server, airline) {
        const scraped = AccountingBankScraper.scrape()
        if (!scraped) return null
        const weekId = await AccountingPanel._inferWeekIdFallback(server, airline)
        if (!weekId) return null
        await AccountingSnapshotStore.saveTab({
            server, airline,
            weekId,
            type: "bank",
            payload: scraped,
            weekClosesAt: weekId
        })
        return weekId
    }

    async _render(server, airline, activeTab, weekClosesAt) {
        const index = await AccountingSnapshotStore.loadIndex(server, airline)
        const latest = index.length
            ? await AccountingSnapshotStore.loadWeek(server, airline, index[0].weekId)
            : null
        const sisters = await AccountingSnapshotStore.loadAllSisters(server, airline)
        const ledger = await AccountingAggregator.loadUnifiedLedger(server, airline)

        let container = document.querySelector(".aes-accounting-panel")
        if (!container) {
            container = document.createElement("div")
            container.className = "aes-accounting-panel"
            const anchor = AccountingPanel._mountAnchor()
            if (!anchor) return
            anchor.after(container)
        }
        container.innerHTML = ""
        container.append(this._buildHeading())
        container.append(this._buildPanel({index, latest, sisters, ledger, activeTab, weekClosesAt}))

        this._container = container
    }

    _buildHeading() {
        const h = document.createElement("h3")
        h.innerText = "AES — Accounting"
        return h
    }

    _buildPanel({index, latest, sisters, ledger, activeTab, weekClosesAt}) {
        const panel = document.createElement("div")
        panel.className = "as-panel"

        panel.append(this._buildStatusLine({index, activeTab, weekClosesAt}))
        if (latest) panel.append(this._buildLatestCard(latest))
        panel.append(this._buildSisterFreshnessCard(sisters))
        panel.append(this._buildUnitEconomicsCard(ledger))
        panel.append(this._buildReconciliationCard(ledger))
        panel.append(this._buildProjectionCard(ledger))
        panel.append(this._buildByHubCard(ledger))
        panel.append(this._buildByAircraftTypeCard(ledger))
        panel.append(this._buildByTailCard(ledger))
        panel.append(this._buildByClassCard(ledger))
        panel.append(this._buildHistoryCard(index))

        return panel
    }

    _buildUnitEconomicsCard(ledger) {
        const cut = AccountingProfitabilityCuts.unitEconomics(ledger)
        const wrap = AccountingPanel._fieldset("Unit economics")
        if (!cut.routeCount) {
            wrap.append(AccountingPanel._noDataParagraph(
                "No route data cached yet. Visit `/app/com/scheduling/<HUB>` for each hub to populate `routeAssistant:topRoutes:<HUB>`."
            ))
            return wrap
        }
        const grid = document.createElement("div")
        grid.style.display = "grid"
        grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(180px, 1fr))"
        grid.style.gap = "8px"

        const stat = (label, valueText) => {
            const cell = document.createElement("div")
            const l = document.createElement("div")
            l.style.fontSize = "0.8em"
            l.style.opacity = "0.7"
            l.innerText = label
            const v = document.createElement("div")
            v.style.fontSize = "1.1em"
            v.style.fontWeight = "bold"
            v.innerText = valueText
            cell.append(l, v)
            return cell
        }
        grid.append(
            stat("Routes tracked", String(cut.routeCount)),
            stat("Routes flown (freq>0)", String(cut.routesWithFreq)),
            stat("Profit / week (sum)", AccountingPanel._fmtCurrency(cut.totalProfitPerWeek)),
            stat("Route-km / week", cut.totalRouteKmPerWeek.toLocaleString()),
            stat("Profit per route-km",
                cut.profitPerRouteKm != null
                    ? AccountingPanel._fmtCurrency(cut.profitPerRouteKm) + " / km"
                    : "—")
        )
        wrap.append(grid)

        const statusTbl = document.createElement("table")
        statusTbl.className = "table table-hover"
        statusTbl.style.marginTop = "8px"
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        for (const h of ["Status", "Routes", "Profit / week"]) {
            const th = document.createElement("th"); th.innerText = h; tr.append(th)
        }
        thead.append(tr); statusTbl.append(thead)

        const tbody = document.createElement("tbody")
        for (const status of ["NEW", "OK", "UNDER", "OVER", "OOR", "OTHER"]) {
            if (!cut.statusCounts[status]) continue
            const row = document.createElement("tr")
            const sTd = document.createElement("td"); sTd.innerText = status; row.append(sTd)
            const cTd = document.createElement("td"); cTd.innerText = cut.statusCounts[status]; row.append(cTd)
            const pTd = document.createElement("td"); pTd.className = "number"
            pTd.append(AES.formatCurrency(cut.profitByStatus[status] || 0, "right"))
            row.append(pTd)
            tbody.append(row)
        }
        statusTbl.append(tbody)
        wrap.append(AccountingPanel._tableWell(statusTbl))

        wrap.append(AccountingPanel._noteParagraph(
            "RASK / CASK / breakeven LF need seat counts per route — coming once route-assistant adds a perClass companion to topRoutes."
        ))
        return wrap
    }

    _buildByHubCard(ledger) {
        const cut = AccountingProfitabilityCuts.byHub(ledger)
        const wrap = AccountingPanel._fieldset("Profitability by hub")
        if (!cut.totalHubs) {
            wrap.append(AccountingPanel._noDataParagraph("No hub snapshots yet."))
            return wrap
        }
        const summary = document.createElement("p")
        summary.innerText = `${cut.totalHubs} hub(s), ${cut.totalRoutes} routes, total profit/week ${AccountingPanel._fmtCurrency(cut.totalProfitPerWeek)}.`
        wrap.append(summary)

        const tbl = document.createElement("table")
        tbl.className = "table table-hover"
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        for (const h of ["Hub", "Routes", "Profit / wk", "Avg / route", "Distance / wk", "Last snapshot"]) {
            const th = document.createElement("th"); th.innerText = h; tr.append(th)
        }
        thead.append(tr); tbl.append(thead)

        const tbody = document.createElement("tbody")
        for (const g of cut.rows) {
            const row = document.createElement("tr")
            const hTd = document.createElement("td"); hTd.innerText = g.hub; row.append(hTd)
            const rTd = document.createElement("td"); rTd.innerText = g.routeCount; row.append(rTd)
            const pTd = document.createElement("td"); pTd.className = "number"
            pTd.append(AES.formatCurrency(g.profitPerWeekSum, "right")); row.append(pTd)
            const aTd = document.createElement("td"); aTd.className = "number"
            aTd.append(AES.formatCurrency(g.profitPerRouteAvg, "right")); row.append(aTd)
            const dTd = document.createElement("td"); dTd.className = "number"
            dTd.innerText = (g.distanceKmSum * 2).toLocaleString() + " km"
            row.append(dTd)
            const sTd = document.createElement("td")
            sTd.innerText = g.snapshotAt ? AccountingPanel._formatRelative(g.snapshotAt) : "—"
            row.append(sTd)
            tbody.append(row)
        }
        tbl.append(tbody)
        wrap.append(AccountingPanel._tableWell(tbl))
        return wrap
    }

    _buildByAircraftTypeCard(ledger) {
        const cut = AccountingProfitabilityCuts.byAircraftType(ledger)
        const wrap = AccountingPanel._fieldset("Cumulative profit by aircraft type")
        if (!cut.totalTypes) {
            wrap.append(AccountingPanel._noDataParagraph(
                "No aircraft-flights records cached yet. Visit `/app/fleets/aircraft/<id>/1` for each tail to populate."
            ))
            return wrap
        }
        const summary = document.createElement("p")
        summary.innerText = `${cut.totalTypes} type(s), ${cut.totalTails} tails, lifetime profit ${AccountingPanel._fmtCurrency(cut.totalProfit)}.`
        wrap.append(summary)

        const tbl = document.createElement("table")
        tbl.className = "table table-hover"
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        for (const h of ["Equipment", "Tails", "Profit (lifetime)", "Avg / tail", "Avg / flight"]) {
            const th = document.createElement("th"); th.innerText = h; tr.append(th)
        }
        thead.append(tr); tbl.append(thead)

        const tbody = document.createElement("tbody")
        for (const g of cut.rows) {
            const row = document.createElement("tr")
            const eTd = document.createElement("td"); eTd.innerText = g.equipment; row.append(eTd)
            const tTd = document.createElement("td"); tTd.innerText = g.tailCount; row.append(tTd)
            const pTd = document.createElement("td"); pTd.className = "number"
            pTd.append(AES.formatCurrency(g.profitSum, "right")); row.append(pTd)
            const apTd = document.createElement("td"); apTd.className = "number"
            apTd.append(AES.formatCurrency(g.profitPerTailAvg, "right")); row.append(apTd)
            const afTd = document.createElement("td"); afTd.className = "number"
            afTd.append(AES.formatCurrency(g.profitPerFlightAvg, "right")); row.append(afTd)
            tbody.append(row)
        }
        tbl.append(tbody)
        wrap.append(AccountingPanel._tableWell(tbl))
        return wrap
    }

    _buildByTailCard(ledger) {
        const cut = AccountingProfitabilityCuts.byTail(ledger)
        const wrap = AccountingPanel._fieldset("Per-tail margin")
        if (!cut.totalTails) {
            wrap.append(AccountingPanel._noDataParagraph("No aircraft-flights records cached yet."))
            return wrap
        }
        const summary = document.createElement("p")
        summary.innerText = `${cut.totalTails} tails. Leasing matched: ${cut.leasingMatched}. Asset matched: ${cut.assetMatched}. Lifetime profit ${AccountingPanel._fmtCurrency(cut.totalProfit)}.`
        wrap.append(summary)

        const tbl = document.createElement("table")
        tbl.className = "table table-hover"
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        for (const h of ["Reg.", "Equipment", "Profit (lifetime)", "Flights", "Lease", "Book value"]) {
            const th = document.createElement("th"); th.innerText = h; tr.append(th)
        }
        thead.append(tr); tbl.append(thead)

        const tbody = document.createElement("tbody")
        const ROW_LIMIT = 50
        for (const r of cut.rows.slice(0, ROW_LIMIT)) {
            const row = document.createElement("tr")
            const regTd = document.createElement("td"); regTd.innerText = r.registration || "—"; row.append(regTd)
            const eqTd = document.createElement("td"); eqTd.innerText = r.equipment || "—"; row.append(eqTd)
            const pTd = document.createElement("td"); pTd.className = "number"
            pTd.append(AES.formatCurrency(r.profit || 0, "right")); row.append(pTd)
            const fTd = document.createElement("td"); fTd.innerText = r.flightCount ?? "—"; row.append(fTd)
            const lTd = document.createElement("td"); lTd.className = "number"
            lTd.innerText = r.leasingInstallment != null ? AccountingPanel._fmtCurrency(r.leasingInstallment) : "—"
            row.append(lTd)
            const bTd = document.createElement("td"); bTd.className = "number"
            bTd.innerText = r.assetBookValue != null ? AccountingPanel._fmtCurrency(r.assetBookValue) : "—"
            row.append(bTd)
            tbody.append(row)
        }
        tbl.append(tbody)
        wrap.append(AccountingPanel._tableWell(tbl))
        if (cut.rows.length > ROW_LIMIT) {
            const more = document.createElement("p")
            more.innerText = `+${cut.rows.length - ROW_LIMIT} more tails not shown.`
            wrap.append(more)
        }
        return wrap
    }

    _buildProjectionCard(ledger) {
        const wrap = AccountingPanel._fieldset("Forward projection (schedule × run-rate)")

        const horizonRow = document.createElement("p")
        const horizonLabel = document.createElement("span")
        horizonLabel.innerText = "Horizon: "
        horizonRow.append(horizonLabel)

        const horizons = AccountingProjector.DEFAULT_HORIZONS
        const buttons = []
        const renderFor = (h) => {
            const result = AccountingProjector.project(ledger, {weeks: h})
            const old = wrap.querySelector(".aes-projection-body")
            if (old) old.remove()
            const body = document.createElement("div")
            body.className = "aes-projection-body"
            body.append(this._renderProjectionBody(result))
            wrap.append(body)
            buttons.forEach((b, i) => {
                b.classList.toggle("btn-primary", horizons[i] === h)
                b.classList.toggle("btn-default", horizons[i] !== h)
            })
        }
        for (const h of horizons) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.className = "btn btn-default btn-xs"
            btn.style.marginRight = "4px"
            btn.innerText = `${h} wks`
            btn.addEventListener("click", () => renderFor(h))
            buttons.push(btn)
            horizonRow.append(btn)
        }
        wrap.append(horizonRow)
        renderFor(horizons[0])
        return wrap
    }

    _renderProjectionBody(result) {
        const root = document.createElement("div")
        if (!result.available) {
            root.append(AccountingPanel._noDataParagraph(result.reason))
            return root
        }

        const pillRow = document.createElement("p")
        const pill = document.createElement("span")
        pill.innerText = `Confidence: ${result.confidence.level.toUpperCase()}`
        pill.style.display = "inline-block"
        pill.style.padding = "2px 8px"
        pill.style.borderRadius = "10px"
        pill.style.fontSize = "0.8em"
        pill.style.background = result.confidence.level === "green" ? "#1a472a"
            : result.confidence.level === "amber" ? "#7c2d12" : "#7f1d1d"
        pill.style.color = "#fff"
        pill.title = `Snapshots: ${result.confidence.snapCount} · Hubs: ${result.confidence.hubCount} · Income age: ${result.confidence.ageDays != null ? result.confidence.ageDays.toFixed(1) + "d" : "—"}`
        pillRow.append(pill)
        const summary = document.createElement("span")
        summary.style.marginLeft = "8px"
        summary.innerText = ` Variable profit/wk ${AccountingPanel._fmtCurrency(result.variableProfitPerWeek)} · Fixed/wk ${AccountingPanel._fmtCurrency(result.fixedCostsPerWeek.totalCost)}`
        pillRow.append(summary)
        root.append(pillRow)

        const tbl = document.createElement("table")
        tbl.className = "table table-hover"
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        for (const h of ["Wk", "EBIT", "EBITDA", "Cash"]) {
            const th = document.createElement("th"); th.innerText = h; tr.append(th)
        }
        thead.append(tr); tbl.append(thead)

        const tbody = document.createElement("tbody")
        for (const w of result.weeks) {
            const row = document.createElement("tr")
            const wTd = document.createElement("td"); wTd.innerText = "+" + w.index; row.append(wTd)
            const eTd = document.createElement("td"); eTd.className = "number"
            eTd.append(AES.formatCurrency(w.projectedEbit, "right")); row.append(eTd)
            const ebTd = document.createElement("td"); ebTd.className = "number"
            ebTd.append(AES.formatCurrency(w.projectedEbitda, "right")); row.append(ebTd)
            const cTd = document.createElement("td"); cTd.className = "number"
            if (w.projectedCash != null) cTd.append(AES.formatCurrency(w.projectedCash, "right"))
            else cTd.innerText = "— (no cash seed)"
            row.append(cTd)
            tbody.append(row)
        }
        tbl.append(tbody)
        root.append(AccountingPanel._tableWell(tbl))

        const breakdown = document.createElement("details")
        const breakdownSummary = document.createElement("summary")
        breakdownSummary.innerText = "Fixed-cost breakdown (per week)"
        breakdown.append(breakdownSummary)
        const ul = document.createElement("ul")
        for (const [label, value] of Object.entries(result.fixedCostsPerWeek.byCategory)) {
            const li = document.createElement("li")
            li.innerText = `${label}: ${AccountingPanel._fmtCurrency(value)}`
            ul.append(li)
        }
        breakdown.append(ul)
        root.append(breakdown)

        if (result.cashStart == null) {
            root.append(AccountingPanel._noteParagraph(
                "Cash trajectory not seeded — visit the Bank Account tab and the Cash Flow page to capture the starting balance."
            ))
        }
        return root
    }

    _buildReconciliationCard(ledger) {
        const rec = AccountingReconciliation.reconcile(ledger)
        const wrap = AccountingPanel._fieldset("Reconciliation — modeled vs actual")
        if (!rec.available) {
            wrap.append(AccountingPanel._noDataParagraph(rec.reason))
            return wrap
        }

        const summary = document.createElement("p")
        const op = rec.operatingMetrics
        summary.innerText = `Week ${rec.weekId} · ${op.weeklyFlights} round-trips, ~${op.weeklyBlockHours.toFixed(1)} block-hours, ${op.weeklyKm.toLocaleString()} km flown.`
        wrap.append(summary)

        const tbl = document.createElement("table")
        tbl.className = "table table-hover"
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        for (const h of ["Category", "Actual (current)", "Modeled", "Gap", "Suggestion", ""]) {
            const th = document.createElement("th"); th.innerText = h; tr.append(th)
        }
        thead.append(tr); tbl.append(thead)

        const tbody = document.createElement("tbody")
        for (const c of rec.categories) {
            const row = document.createElement("tr")
            const lTd = document.createElement("td"); lTd.innerText = c.label; row.append(lTd)

            const aTd = document.createElement("td"); aTd.className = "number"
            if (c.actualCurrent != null) aTd.append(AES.formatCurrency(c.actualCurrent, "right"))
            else aTd.innerText = "—"
            row.append(aTd)

            const mTd = document.createElement("td"); mTd.className = "number"
            if (c.modeledCurrent != null) {
                mTd.append(AES.formatCurrency(c.modeledCurrent, "right"))
                if (c.modeledZero) {
                    const tag = document.createElement("span")
                    tag.style.fontSize = "0.75em"; tag.style.opacity = "0.6"
                    tag.innerText = " (not modeled)"
                    mTd.append(tag)
                }
            } else mTd.innerText = "—"
            row.append(mTd)

            const gTd = document.createElement("td"); gTd.className = "number"
            if (c.gap != null) gTd.append(AES.formatCurrency(c.gap, "right"))
            else gTd.innerText = "—"
            row.append(gTd)

            const sTd = document.createElement("td")
            if (c.suggestion) {
                const v = AccountingPanel._fmtCurrency(c.suggestion.value)
                sTd.innerText = `${c.suggestion.field} = ${v}`
                sTd.title = c.suggestion.explanation
            } else if (c.note) {
                sTd.innerText = c.note
                sTd.style.fontSize = "0.85em"
                sTd.style.opacity = "0.7"
            } else {
                sTd.innerText = "—"
            }
            row.append(sTd)

            const bTd = document.createElement("td")
            if (c.suggestion && c.suggestion.field) {
                const btn = document.createElement("button")
                btn.type = "button"
                btn.className = "btn btn-default btn-xs"
                btn.innerText = "Apply"
                btn.title = `Sets routeAssistant economics.${c.suggestion.field} = ${c.suggestion.value.toFixed(2)}`
                btn.addEventListener("click", async () => {
                    btn.disabled = true
                    btn.innerText = "Applying…"
                    try {
                        const updated = await AccountingReconciliation.applySuggestion(
                            c.suggestion.field, c.suggestion.value
                        )
                        if (!updated) {
                            btn.innerText = "Unavailable"
                            btn.title = "RouteAssistantSettings is not loaded on this page."
                            return
                        }
                        btn.innerText = "Applied ✓"
                    } catch (err) {
                        console.warn("[AES Accounting] applySuggestion failed", err)
                        btn.disabled = false
                        btn.innerText = "Retry"
                    }
                })
                bTd.append(btn)
            }
            row.append(bTd)

            tbody.append(row)
        }
        tbl.append(tbody)
        wrap.append(AccountingPanel._tableWell(tbl))

        wrap.append(AccountingPanel._noteParagraph(
            "Suggestions divide actual cost by total weekly block-hours (or round-trips for leasing). " +
            "Applies overwrite the matching field under route-assistant settings.economics; existing siblings preserved."
        ))
        return wrap
    }

    _buildByClassCard(ledger) {
        const cut = AccountingProfitabilityCuts.byClassAirlineWide(ledger)
        const wrap = AccountingPanel._fieldset("Class-level (Y/C/F/Cargo) airline-wide")
        const p = document.createElement("p")
        p.innerText = cut.available
            ? "Class breakdown available."
            : (cut.reason || "Not yet available.")
        wrap.append(p)
        return wrap
    }

    static _fieldset(legendText) {
        const wrap = document.createElement("div")
        wrap.className = "as-fieldset"
        const legend = document.createElement("span")
        legend.className = "legend"
        legend.innerText = legendText
        wrap.append(legend)
        return wrap
    }

    static _tableWell(table) {
        const w = document.createElement("div")
        w.className = "as-table-well"
        w.append(table)
        return w
    }

    static _noDataParagraph(text) {
        const p = document.createElement("p")
        p.innerText = text
        return p
    }

    static _noteParagraph(text) {
        const p = document.createElement("p")
        p.style.fontSize = "0.85em"
        p.style.opacity = "0.7"
        p.innerText = text
        return p
    }

    static _fmtCurrency(value) {
        if (value == null || !Number.isFinite(value)) return "—"
        const sign = value < 0 ? "-" : ""
        return sign + Math.abs(Math.round(value)).toLocaleString() + " AS$"
    }

    _buildSisterFreshnessCard(sisters) {
        const wrap = document.createElement("div")
        wrap.className = "as-fieldset"
        const legend = document.createElement("span")
        legend.className = "legend"
        legend.innerText = "Sister-page data freshness"
        wrap.append(legend)

        const tableWell = document.createElement("div")
        tableWell.className = "as-table-well"
        const table = document.createElement("table")
        table.className = "table table-hover"

        const thead = document.createElement("thead")
        const headRow = document.createElement("tr")
        for (const label of ["Page", "Captured", "Tables / blocks"]) {
            const th = document.createElement("th")
            th.innerText = label
            headRow.append(th)
        }
        thead.append(headRow)
        table.append(thead)

        const tbody = document.createElement("tbody")
        const pages = [
            {key: "leasing", label: "Leasing", url: "/app/finance/leasing"},
            {key: "capital", label: "Corporate Finance", url: "/app/finance/capital"},
            {key: "assets", label: "Asset Management", url: "/app/finance/assets"},
            {key: "cashflow", label: "Cash Flow", url: "/action/enterprise/schedule"}
        ]
        for (const p of pages) {
            const rec = sisters[p.key]
            const tr = document.createElement("tr")

            const labelTd = document.createElement("td")
            const link = document.createElement("a")
            link.href = p.url
            link.innerText = p.label
            labelTd.append(link)
            tr.append(labelTd)

            const capturedTd = document.createElement("td")
            capturedTd.innerText = rec ? AccountingPanel._formatRelative(rec.scrapedAt) : "never"
            tr.append(capturedTd)

            const sizeTd = document.createElement("td")
            const tables = rec?.payload?.tables?.length ?? 0
            sizeTd.innerText = rec ? `${tables} table(s)` : "—"
            tr.append(sizeTd)

            tbody.append(tr)
        }
        table.append(tbody)
        tableWell.append(table)
        wrap.append(tableWell)

        return wrap
    }

    _buildStatusLine({index, activeTab, weekClosesAt}) {
        const p = document.createElement("p")
        const stored = index.length
        const tabLabel = activeTab === "income" ? "Income Statement"
            : activeTab === "balance" ? "Balance Sheet"
            : activeTab === "bank" ? "Bank Account"
            : "Unknown tab"
        const weekText = weekClosesAt ? ` for week closing ${weekClosesAt}` : ""
        p.innerText = `Stored snapshots: ${stored}. Captured ${tabLabel}${weekText} on this visit.`
        return p
    }

    _buildLatestCard(latest) {
        const wrap = document.createElement("div")
        wrap.className = "as-fieldset"
        const legend = document.createElement("span")
        legend.className = "legend"
        legend.innerText = `Latest snapshot — week of ${latest.weekId}`
        wrap.append(legend)

        const income = latest.income?.payload
        if (!income || !income.totals) {
            const p = document.createElement("p")
            p.innerText = "Income Statement not yet captured for this week. Visit the Income Statement tab to capture."
            wrap.append(p)
            return wrap
        }

        const tableWell = document.createElement("div")
        tableWell.className = "as-table-well"
        const table = document.createElement("table")
        table.className = "table table-hover"
        table.append(this._buildIncomeTotalsHeader())
        table.append(this._buildIncomeTotalsBody(income.totals))
        tableWell.append(table)
        wrap.append(tableWell)

        const captured = AccountingPanel._buildCapturedFlags(latest)
        wrap.append(captured)

        return wrap
    }

    _buildIncomeTotalsHeader() {
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        for (const label of ["Subtotal", "Current", "Last", "Previous"]) {
            const th = document.createElement("th")
            th.innerText = label
            tr.append(th)
        }
        thead.append(tr)
        return thead
    }

    _buildIncomeTotalsBody(totals) {
        const tbody = document.createElement("tbody")
        const order = ["revenue", "adjEbitda", "ebitda", "ebit", "ebt"]
        for (const key of order) {
            const t = totals[key]
            if (!t) continue
            const tr = document.createElement("tr")

            const labelTd = document.createElement("td")
            labelTd.innerText = t.label
            tr.append(labelTd)

            for (const v of [t.current, t.last, t.previous]) {
                const td = document.createElement("td")
                td.className = "number"
                td.append(AES.formatCurrency(v || 0, "right"))
                tr.append(td)
            }
            tbody.append(tr)
        }
        return tbody
    }

    _buildHistoryCard(index) {
        const wrap = document.createElement("div")
        wrap.className = "as-fieldset"
        const legend = document.createElement("span")
        legend.className = "legend"
        legend.innerText = "Snapshot history"
        wrap.append(legend)

        if (!index.length) {
            const p = document.createElement("p")
            p.innerText = "No snapshots stored yet. Visit the Income Statement, Balance Sheet, and Bank Account tabs to capture this week."
            wrap.append(p)
            return wrap
        }

        const tableWell = document.createElement("div")
        tableWell.className = "as-table-well"
        const table = document.createElement("table")
        table.className = "table table-hover"

        const thead = document.createElement("thead")
        const headRow = document.createElement("tr")
        for (const label of ["Week closes", "Income", "Balance", "Bank", "Last scraped"]) {
            const th = document.createElement("th")
            th.innerText = label
            headRow.append(th)
        }
        thead.append(headRow)
        table.append(thead)

        const tbody = document.createElement("tbody")
        const HISTORY_LIMIT = 12
        for (const e of index.slice(0, HISTORY_LIMIT)) {
            const tr = document.createElement("tr")

            const weekTd = document.createElement("td")
            weekTd.innerText = e.weekClosesAt || e.weekId
            tr.append(weekTd)

            for (const flag of ["hasIncome", "hasBalance", "hasBank"]) {
                const td = document.createElement("td")
                td.innerText = e[flag] ? "✓" : "—"
                tr.append(td)
            }

            const scrapedTd = document.createElement("td")
            scrapedTd.innerText = e.scrapedAt ? AccountingPanel._formatRelative(e.scrapedAt) : "—"
            tr.append(scrapedTd)

            tbody.append(tr)
        }
        table.append(tbody)
        tableWell.append(table)
        wrap.append(tableWell)

        if (index.length > HISTORY_LIMIT) {
            const more = document.createElement("p")
            more.innerText = `+${index.length - HISTORY_LIMIT} older snapshots stored.`
            wrap.append(more)
        }

        return wrap
    }

    static _buildCapturedFlags(latest) {
        const p = document.createElement("p")
        const flags = []
        for (const t of ["income", "balance", "bank"]) {
            flags.push(`${t}: ${latest[t] ? "✓" : "—"}`)
        }
        p.innerText = "Tabs captured this week — " + flags.join(" · ")
        return p
    }

    /**
     * Detects which accounting tab is currently active. Reads the URL trailing
     * /0|/1|/2 first (most reliable) and falls back to the highlighted tab
     * `<li>` if AS reordered the URL scheme.
     */
    static _activeTab() {
        const path = window.location.pathname
        if (path.endsWith("/0")) return "income"
        if (path.endsWith("/1")) return "balance"
        if (path.endsWith("/2")) return "bank"

        const active = document.querySelector(".nav-tabs li.active")
        if (active?.classList.contains("tab0")) return "income"
        if (active?.classList.contains("tab1")) return "balance"
        if (active?.classList.contains("tab2")) return "bank"

        return "income"
    }

    /** Where to inject the AES panel — after the existing AS panel on the page. */
    static _mountAnchor() {
        const existing = document.querySelector(".aes-accounting-panel")
        if (existing) return existing.previousElementSibling
        const firstPanel = document.querySelector("h1 + .as-panel")
            || document.querySelector(".as-panel")
        return firstPanel
    }

    /**
     * Balance-sheet and bank tabs don't carry the "week closes on" footer the
     * income tab does. Falls back to the most-recent weekId in the index so
     * those tabs still attach to the right period.
     */
    static async _inferWeekIdFallback(server, airline) {
        const index = await AccountingSnapshotStore.loadIndex(server, airline)
        return index.length ? index[0].weekId : null
    }

    static _formatRelative(ts) {
        const diff = Date.now() - ts
        const sec = Math.round(diff / 1000)
        if (sec < 60) return sec + "s ago"
        const min = Math.round(sec / 60)
        if (min < 60) return min + "m ago"
        const hr = Math.round(min / 60)
        if (hr < 24) return hr + "h ago"
        const d = Math.round(hr / 24)
        return d + "d ago"
    }
}
