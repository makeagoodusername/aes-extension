"use strict"

/**
 * Flight numbers tab — derived from `<server>aircraftFlights<aircraftId>`
 * records (own-fleet only). Each row is one (flightNumberId, route)
 * combination with the aircraft tail(s) flying it and the current
 * weekly frequency.
 *
 * v1 honest about the limitation: AS does not expose competitor flight
 * numbers in any public scrape. The header note flags this so the user
 * doesn't expect a parity feature.
 *
 * Loaded lazily on first render — flight number records aren't part of
 * the host's eager load. Cached on the view module so subsequent renders
 * within the same session are cheap.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelFlightNumbersView) return

    let _cached = null   // {server, rows, loadedAt}

    async function _loadOwnFlightNumbers(server) {
        if (!server) return []
        const all = await chrome.storage.local.get(null)
        const byKey = new Map()  // "fnId:HUB-DEST" → row
        const prefix = server + "aircraftFlights"
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.flights)) continue
            const aircraftId   = rec.aircraftId   || k.slice(prefix.length)
            const registration = rec.registration || rec.tailNumber || aircraftId
            const aircraftType = rec.aircraftType || rec.typeName || null
            for (const env of rec.flights) {
                if (!env || !env.originIata || !env.destinationIata) continue
                const fnId = env.flightNumberId
                if (typeof fnId !== "number" || !isFinite(fnId)) continue
                const route = String(env.originIata).toUpperCase()
                    + "-" + String(env.destinationIata).toUpperCase()
                const key = fnId + ":" + route
                let row = byKey.get(key)
                if (!row) {
                    row = {
                        flightNumberId: fnId,
                        route,
                        aircraftAssignments: new Map(),  // tail → {registration, aircraftType, legCount}
                        weeklyLegs: 0
                    }
                    byKey.set(key, row)
                }
                row.weeklyLegs += 1
                const a = row.aircraftAssignments.get(aircraftId) || {
                    aircraftId, registration, aircraftType, legCount: 0
                }
                a.legCount += 1
                row.aircraftAssignments.set(aircraftId, a)
            }
        }
        const rows = []
        for (const r of byKey.values()) {
            const tails = Array.from(r.aircraftAssignments.values())
            tails.sort((a, b) => b.legCount - a.legCount)
            rows.push({
                flightNumberId: r.flightNumberId,
                route:          r.route,
                weeklyLegs:     r.weeklyLegs,
                tails,
                _sort: {
                    fnId:        r.flightNumberId,
                    route:       r.route,
                    weeklyLegs:  r.weeklyLegs,
                    tails:       tails.length,
                    typeCount:   new Set(tails.map(t => t.aircraftType).filter(Boolean)).size
                }
            })
        }
        return rows
    }

    const COLUMNS = [
        {field: "fnId",        label: "FN id",     sortable: true,  width: "80px",   align: "right"},
        {field: "route",       label: "Route",     sortable: true,  width: "120px",  align: "left"},
        {field: "weeklyLegs",  label: "Wk legs",   sortable: true,  width: "80px",   align: "right"},
        {field: "tails",       label: "Tails",     sortable: true,  width: "60px",   align: "right"},
        {field: "typeCount",   label: "Types",     sortable: true,  width: "60px",   align: "right"}
    ]

    function applyFilter(rows, query) {
        if (!query) return rows
        const q = query.toLowerCase()
        return rows.filter(r => {
            if (String(r.flightNumberId).includes(q)) return true
            if (r.route.toLowerCase().includes(q)) return true
            for (const t of r.tails) {
                if (t.registration && t.registration.toLowerCase().includes(q)) return true
                if (t.aircraftType && t.aircraftType.toLowerCase().includes(q)) return true
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

    async function render(host, data, opts) {
        host.innerHTML = ""
        host.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;"

        const note = document.createElement("div")
        note.style.cssText = "padding:6px 14px;color:#fbbf24;font-size:11px;line-height:1.5;"
            + "border-bottom:1px solid #1f2937;background:rgba(251,191,36,0.05);"
        note.innerHTML = "<strong>v1 limitation:</strong> AS does not expose competitor flight-number rosters; "
            + "this tab shows your <strong>own fleet's</strong> flight numbers only, derived from per-aircraft "
            + "schedule records. Competitor flight-number stats would require an inferential scraper "
            + "combining ORS connection legs + flightsfrom carrier data — deferred."
        host.append(note)

        const summary = document.createElement("div")
        summary.style.cssText = "padding:6px 14px;color:#94a3b8;font-size:11px;"
            + "border-bottom:1px solid #1f2937;background:rgba(15,23,42,0.4);"
        summary.textContent = "Loading own-fleet flight numbers…"
        host.append(summary)

        const tableWrap = document.createElement("div")
        tableWrap.style.cssText = "flex:1;min-height:0;overflow:auto;"
        host.append(tableWrap)

        if (!_cached || _cached.server !== data.server) {
            const rows = await _loadOwnFlightNumbers(data.server)
            _cached = {server: data.server, rows, loadedAt: Date.now()}
        }
        const filtered = applyFilter(_cached.rows, opts && opts.search)
        const sorted = sortRows(filtered, opts && opts.sort)
        summary.textContent = sorted.length === 0
            ? (_cached.rows.length === 0
                ? "No own-fleet flight-number records cached. Visit /app/fleets/aircraft/<id>/0 to populate."
                : "No matches.")
            : (sorted.length + " of " + _cached.rows.length + " (fnId, route) pairs · own fleet")

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
        for (const row of sorted) tbody.append(_renderRow(row))
    }

    function _renderRow(row) {
        const tr = document.createElement("tr")
        tr.style.cssText = "border-bottom:1px solid #1f2937;"

        const fnTd = document.createElement("td")
        fnTd.style.cssText = "padding:6px 8px;color:#7dd3fc;text-align:right;font-family:ui-monospace,monospace;font-weight:600;"
        fnTd.textContent = row.flightNumberId
        tr.append(fnTd)

        const routeTd = document.createElement("td")
        routeTd.style.cssText = "padding:6px 8px;color:#cbd5e1;font-family:ui-monospace,monospace;"
        routeTd.textContent = row.route
        tr.append(routeTd)

        const legsTd = document.createElement("td")
        legsTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        legsTd.textContent = row.weeklyLegs
        tr.append(legsTd)

        const tailsTd = document.createElement("td")
        tailsTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        tailsTd.textContent = row.tails.length
        const tailNames = row.tails.map(t => t.registration || t.aircraftId).join("\n")
        if (tailNames) tailsTd.title = tailNames
        tr.append(tailsTd)

        const typeTd = document.createElement("td")
        typeTd.style.cssText = "padding:6px 8px;color:#cbd5e1;text-align:right;font-family:ui-monospace,monospace;"
        const types = new Set(row.tails.map(t => t.aircraftType).filter(Boolean))
        typeTd.textContent = types.size
        if (types.size) typeTd.title = Array.from(types).join("\n")
        tr.append(typeTd)
        return tr
    }

    function invalidateCache() { _cached = null }

    window.AesCompetitorIntelFlightNumbersView = {
        render, applyFilter, sortRows, invalidateCache,
        DEFAULT_SORT: {field: "weeklyLegs", dir: -1}
    }
})()
