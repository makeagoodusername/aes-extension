"use strict"

/**
 * ORS tab — sortable, searchable browse of cached ORS records (account-
 * scoped + legacy). One row per (hub, dest) pair; expand a row to see the
 * per-class breakdown and competitor ratings.
 *
 * Columns: HUB-DEST, classes scraped, our top rating, gap to top, total
 * connections, freshness. Click → drilldown panel with full snapshot
 * timeline (via AesRouteAssistantOrsSnapshotStore.getCompetitorPriceTimeseries
 * when available).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelOrsView) return

    const FRESH_OK_MS    = 7  * 86400000
    const FRESH_WARN_MS  = 30 * 86400000
    const CLASS_ORDER    = ["ECONOMY", "BUSINESS", "FIRST", "CARGO"]
    const CLASS_GLYPH    = {ECONOMY: "Y", BUSINESS: "C", FIRST: "F", CARGO: "K"}

    const COLUMNS = [
        {field: "route",       label: "Route",      sortable: true,  width: "120px",  align: "left"},
        {field: "classes",     label: "Classes",    sortable: true,  width: "100px",  align: "center"},
        {field: "ourTopRating",label: "Our top",    sortable: true,  width: "80px",   align: "right"},
        {field: "topRating",   label: "Top",        sortable: true,  width: "70px",   align: "right"},
        {field: "ratingGap",   label: "Gap",        sortable: true,  width: "70px",   align: "right"},
        {field: "connections", label: "Conn",       sortable: true,  width: "60px",   align: "right"},
        {field: "freshness",   label: "Scraped",    sortable: true,  width: "100px",  align: "right"}
    ]

    function buildRows(data) {
        const rows = []
        for (const [routeKey, rec] of data.orsRoutes) {
            const byClass = rec.byClass || {}
            const classesPresent = Object.keys(byClass).filter(k => byClass[k] && byClass[k].totalConnections != null)
            // Aggregate metrics — pick the best (max) of per-class values
            // since ORS_ANY_CLASS reflects the highest-rated path.
            let ourTop = null, top = null, gap = null, conn = 0
            for (const cls of classesPresent) {
                const c = byClass[cls]
                if (typeof c.ourTopRating === "number") {
                    ourTop = (ourTop == null) ? c.ourTopRating : Math.max(ourTop, c.ourTopRating)
                }
                if (typeof c.topCompetitorRating === "number") {
                    top = (top == null) ? c.topCompetitorRating : Math.max(top, c.topCompetitorRating)
                }
                if (typeof c.ratingGapToTop === "number") {
                    gap = (gap == null) ? c.ratingGapToTop : Math.min(gap, c.ratingGapToTop)
                }
                if (typeof c.totalConnections === "number") conn += c.totalConnections
            }
            rows.push({
                routeKey,
                record: rec,
                classesPresent,
                ourTop, top, gap, conn,
                _sort: {
                    route:        routeKey,
                    classes:      classesPresent.length,
                    ourTopRating: ourTop != null ? ourTop : -1,
                    topRating:    top != null ? top : -1,
                    ratingGap:    gap != null ? gap : Infinity,
                    connections:  conn,
                    freshness:    Number(rec.scrapedAt) || 0
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
            // Search competitor carrier prefixes too.
            for (const cls of r.classesPresent) {
                const c = r.record.byClass[cls] || {}
                const ratings = c.competitorRatings || {}
                for (const carrier in ratings) {
                    if (carrier.toLowerCase().includes(q)) return true
                }
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
                ? "No ORS records cached yet — sync ORS rank from the route assistant."
                : "No matches.")
            : (sorted.length + " of " + all.length + " ORS-scraped routes")
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
            if (opts && opts.onSelect) opts.onSelect({kind: "ors", id: row.routeKey, row})
        })

        // Route
        const routeTd = document.createElement("td")
        routeTd.style.cssText = "padding:6px 8px;color:#7dd3fc;font-family:ui-monospace,monospace;font-weight:600;"
        routeTd.textContent = row.routeKey
        tr.append(routeTd)

        // Classes
        const clsTd = document.createElement("td")
        clsTd.style.cssText = "padding:6px 8px;text-align:center;font-family:ui-monospace,monospace;"
        const classChips = []
        for (const cls of CLASS_ORDER) {
            if (row.classesPresent.includes(cls)) {
                classChips.push(`<span style="color:#67e8f9;font-weight:600;">${CLASS_GLYPH[cls]}</span>`)
            } else {
                classChips.push(`<span style="color:#475569;">${CLASS_GLYPH[cls]}</span>`)
            }
        }
        clsTd.innerHTML = classChips.join(" ")
        tr.append(clsTd)

        // Our top rating
        const ourTopTd = document.createElement("td")
        ourTopTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        ourTopTd.textContent = row.ourTop != null ? row.ourTop.toFixed(2) : "—"
        tr.append(ourTopTd)

        // Top
        const topTd = document.createElement("td")
        topTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        topTd.textContent = row.top != null ? row.top.toFixed(2) : "—"
        tr.append(topTd)

        // Gap
        const gapTd = document.createElement("td")
        gapTd.style.cssText = "padding:6px 8px;text-align:right;font-family:ui-monospace,monospace;"
        if (row.gap != null && isFinite(row.gap)) {
            const sign = row.gap >= 0 ? "+" : ""
            gapTd.textContent = sign + row.gap.toFixed(2)
            gapTd.style.color = row.gap >= 0 ? "#86efac" : "#fca5a5"
        } else {
            gapTd.textContent = "—"
            gapTd.style.color = "#6b7280"
        }
        tr.append(gapTd)

        // Connections
        const connTd = document.createElement("td")
        connTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        connTd.textContent = row.conn || "—"
        tr.append(connTd)

        // Freshness
        const freshTd = document.createElement("td")
        const age = Date.now() - (Number(row.record.scrapedAt) || 0)
        const color = age <= FRESH_OK_MS ? "#34d399" : age <= FRESH_WARN_MS ? "#fbbf24" : "#f87171"
        freshTd.style.cssText = "padding:6px 8px;text-align:right;font-size:11px;color:#94a3b8;"
        freshTd.innerHTML = `<span style="color:${color};margin-right:4px;">●</span>${_fmtRelative(row.record.scrapedAt)}`
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

    window.AesCompetitorIntelOrsView = {
        render, buildRows, applyFilter, sortRows,
        CLASS_ORDER, CLASS_GLYPH,
        DEFAULT_SORT: {field: "freshness", dir: -1}
    }
})()
