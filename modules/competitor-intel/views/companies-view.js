"use strict"

/**
 * Companies tab — sortable, searchable table of cached competitor
 * enterprises for the active server. One row per enterprise.
 *
 * Columns: avatar+name, IATA, alliance, fleet, hubs, routes, threat pill,
 * freshness dot. Click → drilldown panel with snapshot history + diff feed.
 *
 * Data plumbing:
 *   - Reads `data.enterprises` (Map<id, enterpriseRecord>) from host.
 *   - Pulls `data.snapshots` per enterprise to feed AesCompetitorThreatScorer.
 *   - `data.ourHubs` (Set<iata>) feeds the overlap component of the threat score.
 *
 * Pure renderer — no storage writes. Sort/filter state is owned by the
 * shell and passed in via opts.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelCompaniesView) return

    const FRESH_OK_MS    = 7  * 86400000  // ≤7d  green
    const FRESH_WARN_MS  = 30 * 86400000  // ≤30d amber, else red

    const COLUMNS = [
        {field: "name",       label: "Name",      sortable: true,  width: "auto"},
        {field: "iata",       label: "IATA",      sortable: true,  width: "60px",  align: "center"},
        {field: "alliance",   label: "Alliance",  sortable: true,  width: "150px"},
        {field: "fleet",      label: "Fleet",     sortable: true,  width: "60px",  align: "right"},
        {field: "hubs",       label: "Hubs",      sortable: true,  width: "60px",  align: "right"},
        {field: "routes",     label: "Routes",    sortable: true,  width: "70px",  align: "right"},
        {field: "threat",     label: "Threat",    sortable: true,  width: "90px",  align: "center"},
        {field: "freshness",  label: "Scraped",   sortable: true,  width: "100px", align: "right"}
    ]

    /**
     * Build the per-row enriched record from the raw enterprise + snapshots.
     * Pure — no storage reads. Reused by sort + render.
     */
    function buildRows(data) {
        const rows = []
        const ourHubs = data.ourHubs ? Array.from(data.ourHubs) : []
        const now = Date.now()
        for (const [id, rec] of data.enterprises) {
            const snaps = data.snapshots.get(id) || []
            let threat = null
            if (window.AesCompetitorThreatScorer) {
                try {
                    threat = window.AesCompetitorThreatScorer.score({
                        record: rec, snapshots: snaps, ourHubs, now
                    })
                } catch (_) { threat = null }
            }
            const fleet = rec.fleet || {}
            const hubs = Array.isArray(rec.hubs) ? rec.hubs : []
            const footprint = Array.isArray(rec.routeFootprint) ? rec.routeFootprint : []
            rows.push({
                id,
                record:    rec,
                snapshots: snaps,
                threat,
                _sort: {
                    name:      String(rec.name || "").toLowerCase(),
                    iata:      String(rec.iata || "").toLowerCase(),
                    alliance:  String((rec.alliance && rec.alliance.name) || "").toLowerCase(),
                    fleet:     Number(fleet.aircraftCount) || 0,
                    hubs:      hubs.length,
                    routes:    footprint.length,
                    threat:    threat ? threat.score : -1,
                    freshness: Number(rec.scrapedAt) || 0
                }
            })
        }
        return rows
    }

    function applyFilter(rows, query) {
        if (!query) return rows
        const q = query.toLowerCase()
        return rows.filter(r => {
            const rec = r.record
            if (String(rec.name || "").toLowerCase().includes(q)) return true
            if (String(rec.iata || "").toLowerCase().includes(q)) return true
            const alliance = (rec.alliance && rec.alliance.name) || ""
            if (alliance.toLowerCase().includes(q)) return true
            const country = (rec.baseCountry && rec.baseCountry.name) || ""
            if (country.toLowerCase().includes(q)) return true
            return false
        })
    }

    function sortRows(rows, sort) {
        if (!sort || !sort.field) return rows
        const key = sort.field
        const dir = sort.dir === 1 ? 1 : -1
        return rows.slice().sort((a, b) => {
            const av = a._sort[key], bv = b._sort[key]
            if (typeof av === "number" && typeof bv === "number") {
                return (av - bv) * dir
            }
            return String(av).localeCompare(String(bv)) * dir
        })
    }

    function render(host, data, opts) {
        host.innerHTML = ""
        host.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;"
        const rows = applyFilter(buildRows(data), opts && opts.search)
        const sorted = sortRows(rows, opts && opts.sort)

        const summary = document.createElement("div")
        summary.style.cssText = "padding:6px 14px;color:#94a3b8;font-size:11px;"
            + "border-bottom:1px solid #1f2937;background:rgba(15,23,42,0.4);"
        summary.textContent = sorted.length === 0
            ? (rows.length === 0 ? "No competitor enterprises cached for this server yet." : "No matches.")
            : (sorted.length + " of " + rows.length + " enterprises"
                + (data.ourHubs && data.ourHubs.size ? " · ourHubs=" + Array.from(data.ourHubs).join(",") : ""))
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
        const rec = row.record
        const tr = document.createElement("tr")
        tr.style.cssText = "border-bottom:1px solid #1f2937;cursor:pointer;"
        tr.addEventListener("mouseenter", () => tr.style.background = "rgba(56,189,248,0.08)")
        tr.addEventListener("mouseleave", () => tr.style.background = "")
        tr.addEventListener("click", () => {
            if (opts && opts.onSelect) opts.onSelect({kind: "company", id: row.id, row})
        })

        // Name + avatar
        const nameTd = document.createElement("td")
        nameTd.style.cssText = "padding:6px 8px;color:#e5e7eb;"
        const inner = document.createElement("div")
        inner.style.cssText = "display:flex;align-items:center;gap:6px;"
        if (rec.avatarUrl) {
            const img = document.createElement("img")
            img.src = rec.avatarUrl
            img.style.cssText = "width:18px;height:18px;border-radius:2px;object-fit:cover;"
            inner.append(img)
        }
        const nameSpan = document.createElement("span")
        nameSpan.textContent = rec.name || "(unknown)"
        inner.append(nameSpan)
        nameTd.append(inner)
        tr.append(nameTd)

        // IATA
        const iataTd = document.createElement("td")
        iataTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:center;font-family:ui-monospace,monospace;"
        iataTd.textContent = rec.iata || "—"
        tr.append(iataTd)

        // Alliance
        const allTd = document.createElement("td")
        allTd.style.cssText = "padding:6px 8px;color:#a78bfa;"
        allTd.textContent = (rec.alliance && rec.alliance.name) || "—"
        tr.append(allTd)

        // Fleet
        const fleetTd = document.createElement("td")
        fleetTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        fleetTd.textContent = (rec.fleet && rec.fleet.aircraftCount) || "—"
        tr.append(fleetTd)

        // Hubs
        const hubsTd = document.createElement("td")
        hubsTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        hubsTd.textContent = (Array.isArray(rec.hubs) ? rec.hubs.length : 0)
        tr.append(hubsTd)

        // Routes
        const routesTd = document.createElement("td")
        routesTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        routesTd.textContent = (Array.isArray(rec.routeFootprint) ? rec.routeFootprint.length : 0)
        tr.append(routesTd)

        // Threat
        const threatTd = document.createElement("td")
        threatTd.style.cssText = "padding:6px 8px;text-align:center;"
        threatTd.append(_threatPill(row.threat))
        tr.append(threatTd)

        // Freshness
        const freshTd = document.createElement("td")
        const age = Date.now() - (Number(rec.scrapedAt) || 0)
        const dot = age <= FRESH_OK_MS ? "●" : age <= FRESH_WARN_MS ? "●" : "●"
        const color = age <= FRESH_OK_MS ? "#34d399" : age <= FRESH_WARN_MS ? "#fbbf24" : "#f87171"
        freshTd.style.cssText = "padding:6px 8px;text-align:right;font-size:11px;color:#94a3b8;"
        freshTd.innerHTML = `<span style="color:${color};margin-right:4px;">${dot}</span>${_fmtRelative(rec.scrapedAt)}`
        tr.append(freshTd)
        return tr
    }

    function _threatPill(threat) {
        const span = document.createElement("span")
        if (!threat) {
            span.textContent = "—"
            span.style.color = "#6b7280"
            return span
        }
        const colors = {
            low:      "#22c55e",
            moderate: "#fbbf24",
            elevated: "#fb923c",
            high:     "#ef4444"
        }
        const c = colors[threat.bucket] || "#6b7280"
        span.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:1px 8px;"
            + "border-radius:999px;font-size:11px;font-weight:600;"
            + "border:1px solid " + c + ";color:" + c + ";"
            + "background:" + c + "1a;"
        span.textContent = threat.bucket + " · " + threat.score
        if (threat.rationale && threat.rationale.length) {
            span.title = threat.rationale.join("\n")
        }
        return span
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

    window.AesCompetitorIntelCompaniesView = {
        render, buildRows, applyFilter, sortRows,
        DEFAULT_SORT: {field: "threat", dir: -1}
    }
})()
