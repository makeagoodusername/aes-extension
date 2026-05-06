/**
 * RouteAssistantCompareModal
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantCompareModal {
    constructor(panel) {
        this.panel = panel;
    }

open(selectedRows) {
    const rows = Array.isArray(selectedRows) ? selectedRows.filter(Boolean) : []
    if (rows.length !== 2) return
    const a = rows[0], b = rows[1]
    const prior = document.getElementById("aes-compare-modal")
    if (prior && prior.parentNode) prior.parentNode.removeChild(prior)

    const overlay = document.createElement("div")
    overlay.id = "aes-compare-modal"
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);"
        + "z-index:10001;display:flex;align-items:center;justify-content:center;"
    const card = document.createElement("div")
    card.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
        + "border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);"
        + "max-width:760px;max-height:80vh;width:90%;display:flex;flex-direction:column;"
        + "font:12px/1.4 sans-serif;"
    overlay.append(card)

    const hubU = String(this.panel.hubIata || "").toUpperCase()
    const aDest = String(a.destIata || "").toUpperCase()
    const bDest = String(b.destIata || "").toUpperCase()
    const header = document.createElement("div")
    header.style.cssText = "padding:10px 14px;border-bottom:1px solid #374151;"
        + "display:flex;align-items:center;gap:10px;"
    const title = document.createElement("strong")
    title.innerHTML = hubU + "→" + aDest + "  <span style='color:#9ca3af;font-weight:normal;'>vs</span>  " + hubU + "→" + bDest
    title.style.flex = "1"
    title.style.color = "#3b82f6"
    header.append(title)
    const closeBtnHdr = document.createElement("button")
    closeBtnHdr.type = "button"
    closeBtnHdr.textContent = "×"
    closeBtnHdr.style.cssText = "background:transparent;color:#9ca3af;border:none;cursor:pointer;"
        + "font-size:18px;line-height:1;padding:0 4px;"
    const close = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        document.removeEventListener("keydown", onKey)
    }
    closeBtnHdr.addEventListener("click", close)
    header.append(closeBtnHdr)
    card.append(header)

    const legend = document.createElement("div")
    legend.style.cssText = "padding:6px 14px;color:#6b7280;font-size:10px;"
        + "border-bottom:1px solid #374151;"
    legend.textContent = "— means field unavailable for one or both routes; "
        + "Δ shaded green/red when one side is meaningfully better (direction-aware)."
    card.append(legend)

    const body = document.createElement("div")
    body.style.cssText = "padding:10px 14px;overflow-y:auto;flex:1;"

    // Field catalog. `dir` defines the Δ-coloring direction:
    //   "higher" — A wins when A > B (green tints the Δ cell)
    //   "lower"  — A wins when A < B
    //   null     — neutral grey (no notion of "better")
    const fieldSpecs = [
        {label: "Score",                key: "score",              fmt: "int",   dir: "higher"},
        {label: "Pax demand (0–10)",    key: "paxScore",           fmt: "int",   dir: "higher"},
        {label: "Cargo demand (0–10)",  key: "cargoScore",         fmt: "int",   dir: "higher"},
        {label: "Distance (km)",        key: "distanceKm",         fmt: "int",   dir: null},
        {label: "Weekly flights",       key: "weeklyFlights",      fmt: "int",   dir: "higher"},
        {label: "Real-world airlines",  key: "airlineCount",       fmt: "int",   dir: "lower"},
        {label: "AS competitors",       key: "competitorCount",    fmt: "int",   dir: "lower"},
        {label: "Profit / week",        key: "profitPerWeek",      fmt: "money", dir: "higher"},
        {label: "Our pax share %",      key: "ourPaxShare",        fmt: "pct1",  dir: "higher"},
        {label: "ORS rating gap to top", key: "orsRatingGapToTop", fmt: "int",   dir: "higher"},
        {label: "Pax demand pool",      key: "paxDemandPool",      fmt: "int",   dir: "higher"},
        {label: "RM tightness",         key: "rmTightness",        fmt: "pct2",  dir: null},
        {label: "Yield override",       key: "_overrideYield",     fmt: "yield", dir: null,
         read: r => r.override && r.override.yieldPerKm != null ? r.override.yieldPerKm : null},
        {label: "Pax LF override",      key: "_overrideLF",        fmt: "pct1",  dir: null,
         read: r => r.override && r.override.paxLF != null ? r.override.paxLF : null},
        {label: "Route note",           key: "_routeNote",         fmt: "bool",  dir: null,
         read: r => r.routeNoteText ? "yes" : "no"}
    ]

    const tbl = document.createElement("table")
    tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
    const thead = document.createElement("thead")
    const headTr = document.createElement("tr")
    for (const colTitle of ["", aDest, bDest, "Δ"]) {
        const th = document.createElement("th")
        th.textContent = colTitle
        th.style.cssText = "padding:5px 8px;color:#9ca3af;font-weight:600;font-size:11px;"
            + "text-align:" + (colTitle === "" ? "left" : "right") + ";"
            + "border-bottom:1px solid #374151;"
        headTr.append(th)
    }
    thead.append(headTr)
    tbl.append(thead)

    const tbody = document.createElement("tbody")
    for (const f of fieldSpecs) {
        const reader = f.read || (r => r[f.key])
        const va = reader(a)
        const vb = reader(b)
        const tr = document.createElement("tr")
        const labCell = document.createElement("td")
        labCell.textContent = f.label
        labCell.style.cssText = "padding:4px 8px;color:#cbd5e1;border-bottom:1px solid #1f2937;"
        tr.append(labCell)
        const fmtCell = (v) => {
            const td = document.createElement("td")
            td.style.cssText = "padding:4px 8px;text-align:right;color:#e5e7eb;"
                + "font-variant-numeric:tabular-nums;border-bottom:1px solid #1f2937;"
            td.textContent = _formatCompareValue(v, f.fmt)
            return td
        }
        tr.append(fmtCell(va))
        tr.append(fmtCell(vb))
        const dTd = document.createElement("td")
        dTd.style.cssText = "padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums;"
            + "border-bottom:1px solid #1f2937;"
        const numA = (typeof va === "number" && isFinite(va)) ? va : null
        const numB = (typeof vb === "number" && isFinite(vb)) ? vb : null
        if (numA == null || numB == null) {
            dTd.textContent = "—"
            dTd.style.color = "#6b7280"
        } else {
            const diff = numA - numB
            dTd.textContent = (diff > 0 ? "+" : "") + _formatCompareValue(diff, f.fmt)
            if (diff === 0 || !f.dir) {
                dTd.style.color = "#9ca3af"
            } else if ((f.dir === "higher" && diff > 0) || (f.dir === "lower" && diff < 0)) {
                dTd.style.color = "#34d399"
                dTd.style.background = "rgba(52,211,153,0.10)"
            } else {
                dTd.style.color = "#f87171"
                dTd.style.background = "rgba(248,113,113,0.10)"
            }
        }
        tr.append(dTd)
        tbody.append(tr)
    }
    tbl.append(tbody)
    body.append(tbl)
    card.append(body)

    const foot = document.createElement("div")
    foot.style.cssText = "padding:10px 14px;border-top:1px solid #374151;"
        + "display:flex;justify-content:flex-end;gap:8px;align-items:center;"
    const closeFootBtn = document.createElement("button")
    closeFootBtn.type = "button"
    closeFootBtn.textContent = "Close"
    closeFootBtn.style.cssText = "background:#475569;color:#f3f4f6;border:none;border-radius:3px;"
        + "padding:5px 14px;font-size:11px;cursor:pointer;margin-right:auto;"
    closeFootBtn.addEventListener("click", close)
    foot.append(closeFootBtn)
    for (const dest of [aDest, bDest]) {
        const link = document.createElement("a")
        link.textContent = "↗ Open " + dest + " in AS"
        link.href = "/app/com/scheduling/" + hubU + dest
        link.target = "_blank"
        link.style.cssText = "color:#60a5fa;font-size:11px;text-decoration:none;"
            + "border:1px solid #475569;border-radius:3px;padding:4px 10px;"
        foot.append(link)
    }
    card.append(foot)

    const onKey = (e) => { if (e.key === "Escape") close() }
    document.addEventListener("keydown", onKey)
    document.body.append(overlay)
}

/**
 * Q6 aircraft retirement planner — modal listing every owned aircraft
 * sorted by age desc with retirement timeline + per-row "Find
 * replacement" link to the dashboard's Used Aircraft Scanner.
 * Threshold input (default 24 months) drives the highlight window.
 * Reads from `this.panel.fleet.aircraft` (populated by RouteAssistantFleetStore);
 * each tail's `age` is in years (from content_fleetManagement.js).
 */
}

window.RouteAssistantCompareModal = RouteAssistantCompareModal;
