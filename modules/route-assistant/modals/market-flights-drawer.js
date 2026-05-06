/**
 * RouteAssistantMarketFlightsDrawer
 *
 * Extracted functionality from panel.js.
 */
class RouteAssistantMarketFlightsDrawer {
    constructor(panel) {
        this.panel = panel;
    }

open(row) {
    if (!row) return
    const flights = Array.isArray(row.competitorMarketFlights) ? row.competitorMarketFlights
        : (Array.isArray(row.competitorFlights) ? row.competitorFlights : [])
    const ffCarriers = Array.isArray(row.carriers) ? row.carriers : []
    const ffAirlines = Array.isArray(row.airlines) ? row.airlines : []
    if (!flights.length && !ffCarriers.length && !ffAirlines.length) return

    if (this.panel._marketFlightsDrawer && this.panel._marketFlightsDrawer.parentNode) {
        this.panel._marketFlightsDrawer.parentNode.removeChild(this.panel._marketFlightsDrawer)
    }

    const overlay = document.createElement("div")
    Object.assign(overlay.style, {
        position: "fixed", inset: "0",
        background: "rgba(0,0,0,0.6)",
        zIndex: "10001",
        display: "flex", alignItems: "center", justifyContent: "center"
    })
    const close = () => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        this.panel._marketFlightsDrawer = null
    }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

    const card = document.createElement("div")
    Object.assign(card.style, {
        background: "#1f2937", color: "#f3f4f6",
        border: "1px solid #0f766e", borderRadius: "6px",
        padding: "16px 18px", minWidth: "760px", maxWidth: "1120px",
        maxHeight: "82vh", overflowY: "auto",
        boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
        font: "12px/1.5 sans-serif"
    })
    const title = document.createElement("strong")
    title.textContent = "Market flights · " + this.panel.hubIata + " → " + row.destIata
    title.style.cssText = "color:#5eead4;display:block;margin-bottom:6px;font-size:14px;"
    card.append(title)

    const sub = document.createElement("div")
    sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
    sub.textContent = "AS Market Analysis: " + flights.length + " flight/class row"
        + (flights.length === 1 ? "" : "s")
        + (row.marketEnterpriseCount ? " · " + row.marketEnterpriseCount + " airline prefix"
            + (row.marketEnterpriseCount === 1 ? "" : "es") : "")
        + (row.marketsScrapedAt ? " · scraped " + new Date(row.marketsScrapedAt).toLocaleString() : "")
    card.append(sub)

    if (ffCarriers.length || ffAirlines.length || row.weeklyFlights || row.airlineCount) {
        const ref = document.createElement("div")
        ref.style.cssText = "color:#cbd5e1;font-size:11px;margin-bottom:10px;"
            + "background:rgba(14,165,233,0.07);border:1px solid rgba(14,165,233,0.28);"
            + "border-radius:3px;padding:6px 8px;"
        const parts = []
        if (row.weeklyFlights) parts.push("FlightsFrom listing " + row.weeklyFlights + "/wk")
        if (row.airlineCount) parts.push(row.airlineCount + " real-world airline" + (row.airlineCount === 1 ? "" : "s"))
        if (ffCarriers.length) {
            const names = ffCarriers.slice(0, 5).map(c => {
                const n = c && (c.name || c.code) || "?"
                return n + (c && c.weeklyFlights ? " " + c.weeklyFlights + "/wk" : "")
            }).join(", ")
            parts.push("carrier scrape: " + names + (ffCarriers.length > 5 ? ", +" + (ffCarriers.length - 5) : ""))
        } else if (ffAirlines.length) {
            const named = ffAirlines.filter(Boolean)
            parts.push("airport-list scrape: " + (named[0] || "?")
                + (ffAirlines.length > 1 ? " +" + (ffAirlines.length - 1) : ""))
        }
        ref.textContent = "FlightsFrom reference: " + (parts.join(" · ") || "cached but no carrier rows")
            + ". It is not used for AS prices/times/aircraft."
        card.append(ref)
    }

    const entryByPrefix = new Map()
    for (const entry of (row.competitorEntries || [])) {
        const p = this.panel._carrierPrefixForEntry(entry)
        if (p && !entryByPrefix.has(p)) entryByPrefix.set(p, entry)
    }
    const carrierLabel = (f) => {
        const p = (f && (f.flightPrefix || f.carrierPrefix)) || RouteAssistantPanel._flightCodePrefix(f && f.flightCode) || "?"
        const e = entryByPrefix.get(p)
        const name = e && e.name ? String(e.name).replace(/\s+·\s+\d+\s+flights?$/i, "") : null
        return name ? (name + " (" + p + ")") : p
    }
    const sorted = flights.slice().sort((a, b) => {
        const pa = String((a && (a.flightPrefix || a.carrierPrefix)) || "")
        const pb = String((b && (b.flightPrefix || b.carrierPrefix)) || "")
        if (pa !== pb) return pa.localeCompare(pb)
        const ta = String((a && (a.depDateLocal || a.depDateUtc)) || "") + " " + String((a && (a.depTimeLocal || a.depTimeUtc)) || "")
        const tb = String((b && (b.depDateLocal || b.depDateUtc)) || "") + " " + String((b && (b.depTimeLocal || b.depTimeUtc)) || "")
        if (ta !== tb) return ta.localeCompare(tb)
        return String((a && a.flightCode) || "").localeCompare(String((b && b.flightCode) || ""))
    })

    const table = document.createElement("table")
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
    table.innerHTML = "<thead><tr style='color:#9ca3af;text-align:left;'>"
        + "<th style='padding:4px;'>Airline / enterprise</th>"
        + "<th style='padding:4px;'>Flight</th>"
        + "<th style='padding:4px;'>Dep</th>"
        + "<th style='padding:4px;'>Arr</th>"
        + "<th style='padding:4px;'>Cls</th>"
        + "<th style='padding:4px;text-align:right;'>Price</th>"
        + "<th style='padding:4px;text-align:right;'>Cap</th>"
        + "<th style='padding:4px;text-align:right;'>Bkd / Load</th>"
        + "<th style='padding:4px;'>Aircraft</th>"
        + "<th style='padding:4px;'>Status</th>"
        + "</tr></thead>"
    const tbody = document.createElement("tbody")
    if (!sorted.length) {
        const tr = document.createElement("tr")
        tr.innerHTML = "<td colspan='10' style='padding:8px;color:#6b7280;text-align:center;'>"
            + "No AS Market Analysis flight rows cached for this route. Sync Market Analysis to populate prices, departures, aircraft and capacity.</td>"
        tbody.append(tr)
    }
    const clsLabel = f => this.panel._normaliseMarketFlightClass(f && f.serviceClass) || (f && f.serviceClass) || "—"
    const priceLabel = f => {
        if (!f || !isFinite(Number(f.price))) return "—"
        const cls = clsLabel(f)
        return cls === "Cargo" ? Number(f.price).toLocaleString() + " AS$/kg"
            : Number(f.price).toLocaleString() + " AS$"
    }
    for (const f of sorted) {
        const tr = document.createElement("tr")
        tr.style.borderBottom = "1px solid #2a3444"
        const cap = f && f.capacity != null ? Number(f.capacity)
            : Number(f && (f.seats != null ? f.seats : f.seatCapacity))
        const bkd = f && f.booked != null ? Number(f.booked) : null
        const load = f && f.loadPct != null ? Number(f.loadPct) : null
        const acLabel = f && (f.typeCode || f.typeName) || "—"
        const acHtml = f && f.typeId
            ? "<a href='/action/enterprise/aircraftsType?id=" + encodeURIComponent(String(f.typeId))
                + "' target='_blank' rel='noreferrer noopener' style='color:#93c5fd;text-decoration:none;'>"
                + escapeHtml(acLabel) + "</a>"
            : escapeHtml(acLabel)
        const flightHtml = f && f.flightId
            ? "<a href='/action/info/flight?id=" + encodeURIComponent(String(f.flightId))
                + "' target='_blank' rel='noreferrer noopener' style='color:#93c5fd;text-decoration:none;font-family:ui-monospace,monospace;'>"
                + escapeHtml(f.flightCode || "flight") + "</a>"
            : "<span style='font-family:ui-monospace,monospace;color:#93c5fd;'>" + escapeHtml(f && f.flightCode || "flight") + "</span>"
        tr.innerHTML =
            "<td style='padding:4px;color:#e5e7eb;'>" + escapeHtml(carrierLabel(f)) + "</td>"
            + "<td style='padding:4px;'>" + flightHtml + "</td>"
            + "<td style='padding:4px;font-family:ui-monospace,monospace;color:#cbd5e1;'>"
                + escapeHtml([f && (f.depDateLocal || f.depDateUtc), f && (f.depTimeLocal || f.depTimeUtc)].filter(Boolean).join(" ") || "—") + "</td>"
            + "<td style='padding:4px;font-family:ui-monospace,monospace;color:#cbd5e1;'>"
                + escapeHtml(f && (f.arrTimeLocal || f.arrTimeUtc) || "—") + "</td>"
            + "<td style='padding:4px;color:#fcd34d;'>" + escapeHtml(clsLabel(f)) + "</td>"
            + "<td style='padding:4px;text-align:right;color:#5eead4;'>" + escapeHtml(priceLabel(f)) + "</td>"
            + "<td style='padding:4px;text-align:right;color:#cbd5e1;'>"
                + (isFinite(cap) && cap > 0 ? cap.toLocaleString() : "—") + "</td>"
            + "<td style='padding:4px;text-align:right;color:#cbd5e1;'>"
                + (bkd != null && isFinite(bkd) ? bkd.toLocaleString() : "—")
                + (load != null && isFinite(load) ? " / " + load + "%" : "") + "</td>"
            + "<td style='padding:4px;'>" + acHtml + "</td>"
            + "<td style='padding:4px;color:#9ca3af;'>" + escapeHtml(f && f.status || "—") + "</td>"
        tbody.append(tr)
    }
    table.append(tbody)
    card.append(table)

    const closeBtn = document.createElement("button")
    closeBtn.textContent = "Close"
    Object.assign(closeBtn.style, smallBtnStyle())
    closeBtn.style.marginTop = "12px"
    closeBtn.style.background = "#475569"
    closeBtn.addEventListener("click", close)
    card.append(closeBtn)

    overlay.append(card)
    document.body.append(overlay)
    this.panel._marketFlightsDrawer = overlay
}

/**
 * Open a modal showing the cached ORS connection list for one route.
 * Lazy-rendered from cache only — never re-scrapes. Each connection row
 * shows its rank, rating, total price, total duration, and per-leg details.
 */
}

window.RouteAssistantMarketFlightsDrawer = RouteAssistantMarketFlightsDrawer;
