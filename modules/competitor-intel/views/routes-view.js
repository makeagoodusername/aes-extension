"use strict"

/**
 * Routes tab — sortable, searchable browse of cached `competitorIntel:edge`
 * records. One row per (server, hub, dest) pair.
 *
 * Columns: HUB-DEST, competitor count, leader name+share, our-share, total
 * weekly flights, freshness. Click → drilldown panel with full competitor
 * list + share splits + linked ORS record (if cached).
 *
 * Data plumbing:
 *   - Reads `data.edges` (Map<routeKey, edgeRecord>) from host.
 *   - Cross-references `data.orsRoutes` to mark which routes also have
 *     ORS scrapes cached (link icon).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelRoutesView) return

    const FRESH_OK_MS    = 7  * 86400000
    const FRESH_WARN_MS  = 30 * 86400000

    const COLUMNS = [
        {field: "route",      label: "Route",        sortable: true,  width: "120px",  align: "left",  font: "mono"},
        {field: "competitors",label: "Cmp",          sortable: true,  width: "60px",   align: "right"},
        {field: "leader",     label: "Leader",       sortable: true,  width: "auto",   align: "left"},
        {field: "leaderShare",label: "Lead %",       sortable: true,  width: "70px",   align: "right"},
        {field: "totalFlights",label: "Wk flts",     sortable: true,  width: "70px",   align: "right"},
        {field: "hasOrs",     label: "ORS",          sortable: true,  width: "50px",   align: "center"},
        {field: "freshness",  label: "Scraped",      sortable: true,  width: "100px",  align: "right"}
    ]

    function buildRows(data) {
        const rows = []
        for (const [routeKey, edge] of data.edges) {
            const competitors = Array.isArray(edge.competitors) ? edge.competitors : []
            const sortedShare = competitors.slice().sort((a, b) =>
                ((b.sharePctPax || 0) - (a.sharePctPax || 0)))
            const leader = sortedShare[0] || null
            const totals = edge.totals || {}
            const hasOrs = data.orsRoutes && data.orsRoutes.has(routeKey)
            rows.push({
                routeKey,
                edge,
                competitors,
                leader,
                hasOrs,
                _sort: {
                    route:        routeKey,
                    competitors:  competitors.length,
                    leader:       String((leader && leader.name) || "").toLowerCase(),
                    leaderShare:  Number(leader && leader.sharePctPax) || 0,
                    totalFlights: Number(totals.totalWeeklyFlights) || 0,
                    hasOrs:       hasOrs ? 1 : 0,
                    freshness:    Number(edge.scrapedAt) || 0
                }
            })
        }
        return rows
    }

    function applyFilter(rows, query) {
        if (!query) return rows
        const q = query.toLowerCase()
        return rows.filter(r => {
            if (r.routeKey.toLowerCase().includes(q)) return true
            for (const c of r.competitors) {
                if (c && c.name && c.name.toLowerCase().includes(q)) return true
            }
            return false
        })
    }

    function sortRows(rows, sort) {
        if (!sort || !sort.field) return rows
        const dir = sort.dir === 1 ? 1 : -1
        return rows.slice().sort((a, b) => {
            const av = a._sort[sort.field], bv = b._sort[sort.field]
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir
            return String(av).localeCompare(String(bv)) * dir
        })
    }

    function render(host, data, opts) {
        host.innerHTML = ""
        host.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;"
        const all = buildRows(data)
        const filtered = applyFilter(all, opts && opts.search)
        const sorted = sortRows(filtered, opts && opts.sort)

        const summary = document.createElement("div")
        summary.style.cssText = "padding:6px 14px;color:#94a3b8;font-size:11px;"
            + "border-bottom:1px solid #1f2937;background:rgba(15,23,42,0.4);"
        summary.textContent = sorted.length === 0
            ? (all.length === 0
                ? "No edge records cached yet — visit /app/com/markets/<HUB><DEST> on a route or run the bulk markets sync."
                : "No matches.")
            : (sorted.length + " of " + all.length + " routes cached")
        host.append(summary)

        const tableWrap = document.createElement("div")
        tableWrap.style.cssText = "flex:1;min-height:0;overflow:auto;"
        host.append(tableWrap)
        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
        tableWrap.append(table)

        const thead = document.createElement("thead")
        thead.style.cssText = "position:sticky;top:0;background:#0f1623;z-index:1;"
        const headRow = document.createElement("tr")
        for (const col of COLUMNS) {
            const th = document.createElement("th")
            th.style.cssText = "padding:6px 8px;border-bottom:1px solid #1f2937;color:#7dd3fc;"
                + "text-align:" + (col.align || "left") + ";font-weight:600;cursor:"
                + (col.sortable ? "pointer" : "default") + ";white-space:nowrap;"
            const isActive = opts && opts.sort && opts.sort.field === col.field
            const arrow = isActive ? (opts.sort.dir === 1 ? " ▲" : " ▼") : ""
            th.textContent = col.label + arrow
            if (col.width !== "auto") th.style.width = col.width
            if (col.sortable) {
                th.addEventListener("click", () => {
                    const cur = opts && opts.sort
                    const nextDir = (cur && cur.field === col.field && cur.dir === -1) ? 1 : -1
                    if (opts && opts.onSort) opts.onSort({field: col.field, dir: nextDir})
                })
            }
            headRow.append(th)
        }
        thead.append(headRow)
        table.append(thead)

        const tbody = document.createElement("tbody")
        table.append(tbody)
        for (const row of sorted) {
            tbody.append(_renderRow(row, opts))
        }
    }

    function _renderRow(row, opts) {
        const tr = document.createElement("tr")
        tr.style.cssText = "border-bottom:1px solid #1f2937;cursor:pointer;"
        tr.addEventListener("mouseenter", () => tr.style.background = "rgba(56,189,248,0.08)")
        tr.addEventListener("mouseleave", () => tr.style.background = "")
        tr.addEventListener("click", () => {
            if (opts && opts.onSelect) opts.onSelect({kind: "route", id: row.routeKey, row})
        })

        // Route
        const routeTd = document.createElement("td")
        routeTd.style.cssText = "padding:6px 8px;color:#7dd3fc;font-family:ui-monospace,monospace;font-weight:600;"
        routeTd.textContent = row.routeKey
        tr.append(routeTd)

        // Cmp count
        const cmpTd = document.createElement("td")
        cmpTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        const cmp = row.competitors.length
        cmpTd.textContent = cmp || "0"
        if (cmp >= 5) cmpTd.style.color = "#fb923c"
        else if (cmp >= 3) cmpTd.style.color = "#fbbf24"
        else cmpTd.style.color = "#86efac"
        tr.append(cmpTd)

        // Leader
        const leadTd = document.createElement("td")
        leadTd.style.cssText = "padding:6px 8px;color:#e5e7eb;"
        leadTd.textContent = (row.leader && row.leader.name) || "—"
        tr.append(leadTd)

        // Leader share
        const leadShareTd = document.createElement("td")
        leadShareTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        const ls = row.leader && row.leader.sharePctPax
        leadShareTd.textContent = (typeof ls === "number") ? ls.toFixed(1) + "%" : "—"
        tr.append(leadShareTd)

        // Total weekly flights
        const flightsTd = document.createElement("td")
        flightsTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        const flights = row.edge.totals && row.edge.totals.totalWeeklyFlights
        flightsTd.textContent = flights || "—"
        tr.append(flightsTd)

        // ORS link icon
        const orsTd = document.createElement("td")
        orsTd.style.cssText = "padding:6px 8px;text-align:center;"
        if (row.hasOrs) {
            orsTd.innerHTML = '<span style="color:#67e8f9;font-size:14px;" title="ORS data cached">◎</span>'
        } else {
            orsTd.innerHTML = '<span style="color:#475569;" title="No ORS scrape">·</span>'
        }
        tr.append(orsTd)

        // Freshness
        const freshTd = document.createElement("td")
        const age = Date.now() - (Number(row.edge.scrapedAt) || 0)
        const color = age <= FRESH_OK_MS ? "#34d399" : age <= FRESH_WARN_MS ? "#fbbf24" : "#f87171"
        freshTd.style.cssText = "padding:6px 8px;text-align:right;font-size:11px;color:#94a3b8;"
        freshTd.innerHTML = `<span style="color:${color};margin-right:4px;">●</span>${_fmtRelative(row.edge.scrapedAt)}`
        tr.append(freshTd)
        return tr
    }

    function _fmtRelative(ts) {
        if (!isFinite(ts) || ts <= 0) return "never"
        const diff = Date.now() - ts
        if (diff < 0)              return "just now"
        if (diff < 60_000)         return Math.max(1, Math.round(diff / 1000)) + "s"
        if (diff < 3600_000)       return Math.round(diff / 60000) + "m"
        if (diff < 86400_000)      return Math.round(diff / 3600000) + "h"
        if (diff < 7 * 86400_000)  return Math.round(diff / 86400000) + "d"
        return new Date(ts).toLocaleDateString()
    }

    window.AesCompetitorIntelRoutesView = {
        render, buildRows, applyFilter, sortRows,
        DEFAULT_SORT: {field: "competitors", dir: -1}
    }
})()
