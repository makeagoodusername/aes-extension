/**
 * RouteAssistantBulkPricingApplyModal
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantBulkPricingApplyModal {
    constructor(panel) {
        this.panel = panel;
    }

open() {
    this.panel._closePricingApplyModal()
    const apply = (this.panel.settings.pricing && this.panel.settings.pricing.apply) || {}
    const dryRunOnly = apply.dryRunOnly === true
    const bulkGate = this.panel._pricingApplyGate("bulk")
    const liveAvailable = bulkGate.liveWrites

    const rows = this.panel._collectBulkApplyRows()
    const state = {
        selected:    new Set(),
        deltaPct:    {Y: 0, C: 0, F: 0, Cargo: 0},
        scope:       Object.assign({}, apply.defaultScope || {}),
        running:     false,
        results:     new Map(),  // destIata → {status, msg}
        cooldownMap: new Map(),  // destIata → minutes until cooldown clears
        refreshBeforeApply: apply.refreshBeforeApply !== false
    }

    const overlay = document.createElement("div")
    overlay.id = "aes-pricing-apply-modal"
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;"
        + "display:flex;align-items:flex-start;justify-content:center;padding:60px 20px 20px 20px;"
    const dialog = document.createElement("div")
    dialog.style.cssText = "background:#0f1623;color:#e5e7eb;border:1px solid #475569;border-radius:6px;"
        + "padding:14px 18px;width:880px;max-width:95vw;font:12px/1.4 sans-serif;"
        + "max-height:calc(100vh - 80px);overflow-y:auto;"
    const stage = dryRunOnly ? "Dry-run only"
        : (!bulkGate.applyEnabled ? "Live writes disabled"
            : (bulkGate.scopeLiveAllowed ? "LIVE writes" : "Bulk scope dry-run"))
    const stageColor = dryRunOnly ? "#fbbf24"
        : (bulkGate.liveWrites ? "#34d399" : "#9ca3af")
    const head = document.createElement("div")
    head.innerHTML = "<strong style='font-size:13px;'>Bulk apply price · " + (this.panel.hubIata || "?") + "</strong>"
        + " <span style='color:" + stageColor + ";font-size:10px;font-weight:normal;'>" + stage + "</span>"
        + "<div style='color:#9ca3af;font-size:10px;margin-top:2px;'>"
        + "Apply a uniform Δ% to selected routes. Each route's current cached price × (1 + Δ%/100) "
        + "becomes the new price. Empty fields are sent at their current value."
        + "</div>"
    dialog.append(head)

    if (!rows.length) {
        const empty = document.createElement("div")
        empty.style.cssText = "color:#9ca3af;font-size:11px;margin:12px 0;"
        empty.textContent = "No routes have cached pricing yet — run the Market Analysis sync first."
        dialog.append(empty)
        const foot = document.createElement("div")
        foot.style.cssText = "display:flex;justify-content:flex-end;margin-top:10px;"
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "Close"
        closeBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #374151;"
            + "border-radius:3px;padding:5px 14px;font-size:11px;cursor:pointer;"
        closeBtn.addEventListener("click", () => this.panel._closePricingApplyModal())
        foot.append(closeBtn)
        dialog.append(foot)
        const onKeyEmpty = (e) => { if (e.key === "Escape") this.panel._closePricingApplyModal() }
        const onClickEmpty = (e) => { if (e.target === overlay) this.panel._closePricingApplyModal() }
        overlay.append(dialog)
        document.body.append(overlay)
        document.addEventListener("keydown", onKeyEmpty)
        overlay.addEventListener("click", onClickEmpty)
        this.panel._pricingApplyModal = {overlay, onKey: onKeyEmpty}
        return
    }

    // Per-class Δ% editor.
    const deltaWrap = document.createElement("div")
    deltaWrap.style.cssText = "display:flex;gap:10px;align-items:center;flex-wrap:wrap;"
        + "padding:8px 10px;background:#0b1220;border:1px solid #1f2937;border-radius:4px;margin-top:8px;"
    const deltaTitle = document.createElement("strong")
    deltaTitle.textContent = "Δ%"
    deltaTitle.style.cssText = "color:#c4b5fd;font-size:11px;"
    deltaWrap.append(deltaTitle)
    const deltaInputs = {}
    for (const cls of ["Y", "C", "F", "Cargo"]) {
        const lbl = document.createElement("label")
        lbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#cbd5e1;font-size:11px;"
        lbl.append(document.createTextNode(cls))
        const input = document.createElement("input")
        input.type = "number"
        input.step = "0.5"
        input.value = "0"
        input.style.cssText = "width:62px;background:#1e293b;color:#fff;border:1px solid #475569;"
            + "border-radius:3px;padding:3px 5px;font-size:11px;font-variant-numeric:tabular-nums;"
        input.addEventListener("input", () => {
            const v = parseFloat(input.value)
            state.deltaPct[cls] = isFinite(v) ? v : 0
            renderTable()
            refreshFooter()
        })
        lbl.append(input)
        deltaInputs[cls] = input
        deltaWrap.append(lbl)
    }
    const allBtn = document.createElement("button")
    allBtn.textContent = "Match Y across C/F/Cargo"
    Object.assign(allBtn.style, smallBtnStyle())
    allBtn.style.fontSize = "10px"
    allBtn.addEventListener("click", () => {
        const v = parseFloat(deltaInputs.Y.value)
        const pct = isFinite(v) ? v : 0
        for (const cls of ["C", "F", "Cargo"]) {
            deltaInputs[cls].value = String(pct)
            state.deltaPct[cls] = pct
        }
        renderTable()
        refreshFooter()
    })
    deltaWrap.append(allBtn)
    dialog.append(deltaWrap)

    // Selection summary row.
    const selRow = document.createElement("div")
    selRow.style.cssText = "display:flex;gap:10px;align-items:center;margin-top:8px;font-size:11px;"
    const selCount = document.createElement("span")
    selCount.style.cssText = "color:#c4b5fd;"
    const selectAllBtn = document.createElement("button")
    selectAllBtn.textContent = "Select all"
    Object.assign(selectAllBtn.style, smallBtnStyle())
    selectAllBtn.style.fontSize = "10px"
    selectAllBtn.addEventListener("click", () => {
        for (const {r} of rows) state.selected.add(r.destIata)
        renderTable()
        refreshFooter()
    })
    const clearBtn = document.createElement("button")
    clearBtn.textContent = "Clear"
    Object.assign(clearBtn.style, smallBtnStyle())
    clearBtn.style.fontSize = "10px"
    clearBtn.addEventListener("click", () => {
        state.selected.clear()
        renderTable()
        refreshFooter()
    })
    selRow.append(selCount, selectAllBtn, clearBtn)
    dialog.append(selRow)

    // Pre-apply refresh row — wired through _orchestratorPreApplySync.
    // The "Refresh visible" button runs against any row whose cached
    // schedule + ORS data is older than `refreshMaxAgeMinProjection`,
    // updating the table previews so the user picks Δ% off fresh data.
    // The checkbox controls whether Apply auto-runs the orchestrator
    // over the selected rows before each POST (defensive, gated by the
    // tighter `refreshMaxAgeMinApply` floor).
    const refreshRow = document.createElement("div")
    refreshRow.style.cssText = "display:flex;gap:10px;align-items:center;margin-top:6px;font-size:11px;"
        + "padding:6px 10px;background:rgba(124, 58, 237, 0.06);border:1px solid rgba(124, 58, 237, 0.25);"
        + "border-radius:4px;"
    const refreshLbl = document.createElement("label")
    refreshLbl.style.cssText = "display:flex;gap:6px;align-items:center;color:#cbd5e1;cursor:pointer;"
    const refreshCb = document.createElement("input")
    refreshCb.type = "checkbox"
    refreshCb.checked = state.refreshBeforeApply
    refreshCb.addEventListener("change", () => { state.refreshBeforeApply = !!refreshCb.checked })
    refreshLbl.append(refreshCb, document.createTextNode("Refresh data before each apply"))
    refreshLbl.title = "Runs schedule + ORS scrapes for selected routes before each POST so projections "
        + "and the cooldown gate see fresh data. Halts gracefully on rate-limit; you can choose to apply "
        + "to the synced subset and skip the rest."
    refreshRow.append(refreshLbl)

    const refreshBtn = document.createElement("button")
    refreshBtn.textContent = "Refresh visible"
    Object.assign(refreshBtn.style, smallBtnStyle())
    refreshBtn.style.fontSize = "10px"
    refreshBtn.title = "Manually run schedule + ORS scrapes against any visible row whose cached data "
        + "is older than the projection freshness window. Updates the current → proposed previews."
    refreshBtn.addEventListener("click", async () => {
        if (state.running) return
        state.running = true
        refreshBtn.disabled = true
        refreshBtn.textContent = "Refreshing…"
        // Disable Apply while pre-flight is in flight; the
        // user can't apply against partial mid-refresh state.
        try { refreshFooter() } catch (e) { /* refreshFooter not yet defined on first call — safe */ }
        try {
            const projectionMaxAge = isFinite(apply.refreshMaxAgeMinProjection)
                ? apply.refreshMaxAgeMinProjection : 5
            const pairs = rows.map(({r}) => ({hub: this.panel.hubIata, dest: r.destIata}))
            const sync = await this.panel._orchestratorPreApplySync(pairs, {
                maxAgeMin:       projectionMaxAge,
                progressId:      "route-sync-pre-bulk-visible",
                progressMessage: "Refreshing visible rows…"
            })
            // Re-collect cached snapshots from the freshly-loaded rows
            for (const item of rows) {
                const fresh = this.panel._lookupCachedOwnPricing(this.panel.hubIata, item.r.destIata)
                if (fresh) item.cached = fresh
            }
            renderTable()
            if (sync.halted && typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.warn("Refresh halted: " + (sync.reason || "rate limit"))
            }
        } catch (e) {
            console.warn("[AES bulk-modal refresh] threw", e)
        } finally {
            state.running = false
            refreshBtn.disabled = false
            refreshBtn.textContent = "Refresh visible"
            try { refreshFooter() } catch (e) { /* defensive */ }
        }
    })
    refreshRow.append(refreshBtn)
    dialog.append(refreshRow)

    // Table.
    const tableWrap = document.createElement("div")
    tableWrap.style.cssText = "max-height:380px;overflow-y:auto;margin-top:6px;border:1px solid #1f2937;border-radius:4px;"
    const tbl = document.createElement("table")
    tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
    const thead = document.createElement("thead")
    thead.style.cssText = "background:#0b1220;position:sticky;top:0;"
    const trH = document.createElement("tr")
    for (const h of ["", "Route", "Y now → new", "C now → new", "F now → new", "Cargo now → new", "Cooldown", "Status"]) {
        const th = document.createElement("th")
        th.textContent = h
        th.style.cssText = "text-align:left;padding:4px 6px;color:#9ca3af;font-size:10px;"
            + "text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #1f2937;"
        trH.append(th)
    }
    thead.append(trH); tbl.append(thead)
    const tbody = document.createElement("tbody")
    tbl.append(tbody)
    tableWrap.append(tbl)
    dialog.append(tableWrap)

    this.panel._hydrateBulkCooldownMap(rows, state.cooldownMap).then(() => renderTable())

    const renderTable = () => {
        tbody.innerHTML = ""
        for (const {r, cached} of rows) {
            const dest = r.destIata
            const trr = document.createElement("tr")
            trr.style.cssText = "border-bottom:1px solid rgba(31, 41, 55, 0.5);"
            if (state.selected.has(dest)) trr.style.background = "rgba(124, 58, 237, 0.08)"
            const cbTd = document.createElement("td")
            cbTd.style.cssText = "padding:3px 6px;"
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = state.selected.has(dest)
            cb.disabled = state.running
            cb.addEventListener("change", () => {
                if (cb.checked) state.selected.add(dest)
                else state.selected.delete(dest)
                trr.style.background = cb.checked ? "rgba(124, 58, 237, 0.08)" : ""
                refreshFooter()
            })
            cbTd.append(cb)
            trr.append(cbTd)
            const routeTd = document.createElement("td")
            routeTd.textContent = dest
            routeTd.style.cssText = "padding:3px 6px;color:#cbd5e1;font-weight:600;"
            trr.append(routeTd)
            const p = this.panel._silentAutoPrices(cached) || {}
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const cur = p[cls]
                const td = document.createElement("td")
                td.style.cssText = "padding:3px 6px;font-variant-numeric:tabular-nums;color:#cbd5e1;"
                if (cur == null) {
                    td.textContent = "—"
                } else {
                    const prop = this.panel._computeBulkProposedPrice(cur, state.deltaPct[cls], cls)
                    if (prop === cur) {
                        td.textContent = this.panel._formatRoutePrice(cls, cur)
                    } else {
                        const arrow = prop > cur ? "↑" : "↓"
                        const color = prop > cur ? "#34d399" : "#f87171"
                        td.innerHTML = this.panel._formatRoutePrice(cls, cur)
                            + " → <span style='color:" + color + ";font-weight:600;'>"
                            + this.panel._formatRoutePrice(cls, prop) + " " + arrow + "</span>"
                    }
                }
                trr.append(td)
            }
            const cdTd = document.createElement("td")
            cdTd.style.cssText = "padding:3px 6px;font-size:10px;"
            const cdMin = state.cooldownMap.get(dest)
            if (isFinite(cdMin) && cdMin > 0) {
                cdTd.innerHTML = "<span style='color:#fbbf24;'>" + cdMin + "m left</span>"
                trr.style.opacity = "0.65"
            } else {
                cdTd.textContent = "—"
            }
            trr.append(cdTd)
            const stTd = document.createElement("td")
            stTd.style.cssText = "padding:3px 6px;font-size:10px;"
            const res = state.results.get(dest)
            if (res) {
                const palette = {
                    verified: "#34d399", posted: "#34d399",
                    "dry-run": "#60a5fa",
                    skipped:  "#9ca3af",
                    failed:   "#f87171", aborted: "#f87171"
                }
                stTd.innerHTML = "<span style='color:" + (palette[res.status] || "#cbd5e1") + ";'>"
                    + res.status + (res.msg ? " · " + res.msg : "") + "</span>"
            }
            trr.append(stTd)
            tbody.append(trr)
        }
    }
    renderTable()

    // Footer.
    const foot = document.createElement("div")
    foot.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-top:10px;"
        + "padding-top:8px;border-top:1px solid #1f2937;"
    const summary = document.createElement("span")
    summary.style.cssText = "color:#9ca3af;font-size:10px;"
    const actBtns = document.createElement("div")
    actBtns.style.cssText = "display:flex;gap:6px;"
    const closeBtn = document.createElement("button")
    closeBtn.textContent = "Close"
    closeBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #374151;"
        + "border-radius:3px;padding:5px 14px;font-size:11px;cursor:pointer;"
    closeBtn.addEventListener("click", () => this.panel._closePricingApplyModal())
    const applyBtn = document.createElement("button")
    applyBtn.textContent = "Apply selected"
    Object.assign(applyBtn.style, smallBtnStyle())
    applyBtn.style.background = liveAvailable ? "#7c3aed" : "#374151"
    applyBtn.style.borderColor = liveAvailable ? "#6d28d9" : "#475569"
    applyBtn.style.color = liveAvailable ? "#fff" : "#9ca3af"
    applyBtn.addEventListener("click", () => onApplyClick())
    actBtns.append(closeBtn, applyBtn)
    foot.append(summary, actBtns)
    dialog.append(foot)

    const refreshFooter = () => {
        const n = state.selected.size
        const anyDelta = ["Y", "C", "F", "Cargo"].some(c => state.deltaPct[c] !== 0)
        selCount.textContent = n + " of " + rows.length + " selected"
        summary.textContent = n + " selected · "
            + (anyDelta ? "Δ% set — proposed prices in green/red" : "no Δ% — Apply round-trips current prices")
        const armed = n > 0 && !state.running
        applyBtn.disabled = !armed || !liveAvailable
        applyBtn.title = !liveAvailable
            ? (dryRunOnly
                ? "Dry-run gate is on. Settings → Auto-Pricing → turn off \"Dry-run only\" to commit writes."
                : (!bulkGate.applyEnabled
                    ? "Apply enabled is off. Settings → Auto-Pricing → flip \"Apply enabled\" to commit writes."
                    : "Bulk live scope is off. Settings → Auto-Pricing → live scopes: enable Bulk to commit writes."))
            : (n === 0 ? "Select at least one route." : "POST new prices to AS for " + n + " routes.")
    }
    refreshFooter()

    const onApplyClick = async () => {
        if (state.running) return
        if (!state.selected.size) return
        const selected = rows.filter(({r}) => state.selected.has(r.destIata))
        const ok = await this.panel._openBulkApplyConfirmModal({
            selected, deltaPct: state.deltaPct, hub: this.panel.hubIata
        })
        if (!ok) return
        state.running = true
        applyBtn.disabled = true
        applyBtn.textContent = "Applying…"
        try {
            await this.panel._runBulkPricingApply({
                selected, deltaPct: state.deltaPct, scope: state.scope, dryRun: false,
                refreshBeforeApply: state.refreshBeforeApply,
                onRowResult: (dest, result) => {
                    state.results.set(dest, this.panel._summariseBulkResult(result))
                    renderTable()
                }
            })
            this.panel._refreshAllOpenTier3LogPreviews()
        } catch (e) {
            if (typeof RouteAssistantToast !== "undefined") {
                RouteAssistantToast.error("Bulk apply threw: " + (e && e.message || e))
            }
        } finally {
            state.running = false
            applyBtn.disabled = false
            applyBtn.textContent = "Apply selected"
            refreshFooter()
        }
    }

    const onKey = (e) => { if (e.key === "Escape") this.panel._closePricingApplyModal() }
    const onOverlayClick = (e) => { if (e.target === overlay) this.panel._closePricingApplyModal() }
    overlay.append(dialog)
    document.body.append(overlay)
    document.addEventListener("keydown", onKey)
    overlay.addEventListener("click", onOverlayClick)
    this.panel._pricingApplyModal = {overlay, onKey}
}

/**
 * Returns [{r, cached}] for every visible row whose ownPricing snapshot
 * is in cache. Bulk-apply runs only against this set — without cached
 * prices we can't compute a Δ% transformation.
 */
}

window.RouteAssistantBulkPricingApplyModal = RouteAssistantBulkPricingApplyModal;
