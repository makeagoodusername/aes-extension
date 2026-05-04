"use strict"

/**
 * Airline detail view — rich per-airline exploration inside the
 * Competitor Intel hub.
 *
 * Replaces the modal slide-in for the "company" selection kind: instead
 * of a 520px right pane, we take over the full content area with a map,
 * hubs+routes grid, wave-pattern strip, and ORS-overlay edges.
 *
 * Pure renderer contract (matches companies-view / explore-map-view):
 *   render(host, data, opts)
 *     host  — HTMLElement, exclusive ownership
 *     data  — competitor-intel host's loadServerData() shape
 *             (Maps for enterprises, snapshots, edges, orsRoutes, ourHubs)
 *     opts  — {airlineId, onSelect, onClose, search, sort}
 *               airlineId is required; everything else is optional.
 *               onSelect({kind:"switchTab",tab,search}) returns to a tab.
 *
 * No storage writes. No bus emits. The shell is the only thing that
 * reads `state.airlineId` and dispatches to this view.
 *
 * Map projection: equirectangular SVG (1000×500 viewBox), same as
 * explore-map-view. Reuses WorldViewAirportCoords for lat/lon when
 * available; airports without coords land in a footer note.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelAirlineDetailView) return

    const VW = 1000, VH = 500
    const NS_SVG = "http://www.w3.org/2000/svg"
    const HUB_RADIUS = 7
    const DEST_RADIUS_BASE = 3.5

    const COL_HUB    = "#fbbf24"   // amber
    const COL_DEST   = "#7dd3fc"   // sky
    const COL_ROUTE  = "#475569"   // slate
    const COL_ORS_ME = "#34d399"   // emerald
    const COL_ORS_HI = "#f87171"   // rose
    const COL_OURS   = "#38bdf8"   // bright sky
    const COL_TEXT   = "#e5e7eb"
    const COL_DIM    = "#94a3b8"

    function _svg(tag, attrs, children) {
        const el = document.createElementNS(NS_SVG, tag)
        if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k])
        if (children) for (const c of children) if (c) el.appendChild(c)
        return el
    }

    function _project(lat, lon) {
        const x = (Number(lon) + 180) / 360
        const y = (90 - Number(lat)) / 180
        return {x: Math.max(0, Math.min(1, x)) * VW, y: Math.max(0, Math.min(1, y)) * VH}
    }

    function _coords() { return window.WorldViewAirportCoords }

    function _escape(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({
            "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
        }[ch]))
    }

    function _fmtRelative(ts) {
        if (!isFinite(ts) || ts <= 0) return "—"
        const ms = Date.now() - Number(ts)
        if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + "s ago"
        if (ms < 3600000) return Math.round(ms / 60000) + "m ago"
        if (ms < 86400000) return Math.round(ms / 3600000) + "h ago"
        return Math.round(ms / 86400000) + "d ago"
    }

    /**
     * Build a per-airline view model from the host data + airlineId.
     * Pure — returns {record, hubs, routes, ors, snapshots, threat, ourId}.
     * `routes` is the airline's routeFootprint with hub/dest IATAs normalised
     * and weeklyFlights coerced to a finite number; `ors` is the subset of
     * data.orsRoutes that touches any of this airline's routes.
     */
    function buildModel(data, airlineId) {
        const record = data && data.enterprises ? data.enterprises.get(String(airlineId)) : null
        const snapshots = data && data.snapshots ? (data.snapshots.get(String(airlineId)) || []) : []
        const hubs = []
        const routes = []
        const orsHits = []
        const seenRoute = new Set()

        if (record) {
            const rawHubs = Array.isArray(record.hubs) ? record.hubs : []
            for (const h of rawHubs) {
                const code = (h && (h.iata || h.airportIata)) || ""
                const iata = String(code || "").toUpperCase()
                if (!/^[A-Z]{3}$/.test(iata)) continue
                hubs.push({
                    iata,
                    weeklyDepartures: Number(h && h.weeklyDepartures) || 0,
                    airportId: (h && h.airportId) || null,
                    isHub: true
                })
            }

            const rawRoutes = Array.isArray(record.routeFootprint) ? record.routeFootprint : []
            for (const r of rawRoutes) {
                if (!r) continue
                const hub = String(r.hub || r.origin || "").toUpperCase()
                const dest = String(r.dest || r.destination || "").toUpperCase()
                if (!/^[A-Z]{3}$/.test(hub) || !/^[A-Z]{3}$/.test(dest)) continue
                const k = hub + "-" + dest
                if (seenRoute.has(k)) continue
                seenRoute.add(k)
                routes.push({
                    hub, dest,
                    weeklyFlights: Number(r.weeklyFlights) || 0
                })
            }
        }

        // ORS overlay: any route in data.orsRoutes whose (hub,dest) matches
        // one of our routes — gives a sense of where we (the user) sit
        // versus this airline. ORS is keyed off our scrapes, so the signal
        // is "places where we have ORS data that overlaps with their network".
        if (data && data.orsRoutes && typeof data.orsRoutes.forEach === "function" && seenRoute.size) {
            for (const [key, rec] of data.orsRoutes) {
                if (!seenRoute.has(key)) continue
                orsHits.push({
                    key,
                    hub: rec.hub, dest: rec.dest,
                    scrapedAt: Number(rec.scrapedAt) || 0,
                    classes: rec.byClass || null,
                    ourRank: rec.ourRank || (rec.byClass && rec.byClass.Y && rec.byClass.Y.ourRank) || null
                })
            }
        }

        let threat = null
        if (record && window.AesCompetitorThreatScorer) {
            try {
                threat = window.AesCompetitorThreatScorer.score({
                    record, snapshots,
                    ourHubs: data.ourHubs ? Array.from(data.ourHubs) : [],
                    now: Date.now()
                })
            } catch (_) { threat = null }
        }

        return {record, hubs, routes, ors: orsHits, snapshots, threat}
    }

    function _renderHeader(host, model, airlineId, opts) {
        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:flex-start;gap:14px;padding:8px 14px 12px;"
            + "border-bottom:1px solid #1f2937;background:linear-gradient(180deg,#0b1220,#0f1623);"
        const back = document.createElement("button")
        back.textContent = "← Companies"
        back.title = "Return to the airlines list"
        back.style.cssText = "background:#1e293b;color:#cbd5e1;border:1px solid #334155;border-radius:3px;"
            + "padding:6px 10px;cursor:pointer;font-size:11px;flex-shrink:0;"
        back.addEventListener("click", () => {
            if (opts && typeof opts.onSelect === "function") {
                opts.onSelect({kind:"switchTab", tab:"companies"})
            }
        })
        head.appendChild(back)

        const titleBox = document.createElement("div")
        titleBox.style.cssText = "flex:1;min-width:0;"
        const rec = model.record
        const name = (rec && rec.name) || ("#" + airlineId)
        const iata = rec && rec.iata ? String(rec.iata).toUpperCase() : null
        const t1 = document.createElement("div")
        t1.style.cssText = "color:#7dd3fc;font-size:16px;font-weight:700;display:flex;align-items:baseline;gap:8px;"
        t1.innerHTML = `<span>${_escape(name)}</span>`
            + (iata ? `<span style="font-size:12px;color:#94a3b8;font-weight:400;">${_escape(iata)}</span>` : "")
        titleBox.appendChild(t1)

        const factsRow = document.createElement("div")
        factsRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;color:#cbd5e1;font-size:11px;"
            + "margin-top:6px;font-family:ui-monospace,monospace;"
        const facts = [
            ["alliance", rec && rec.alliance && rec.alliance.name],
            ["base",     rec && rec.baseCountry && rec.baseCountry.name],
            ["fleet",    rec && rec.fleet && rec.fleet.aircraftCount],
            ["hubs",     model.hubs.length],
            ["routes",   model.routes.length],
            ["ORS hits", model.ors.length],
            ["threat",   model.threat ? `${model.threat.score}/100 · ${model.threat.bucket}` : null],
            ["scraped",  rec && rec.scrapedAt ? _fmtRelative(rec.scrapedAt) : null]
        ]
        for (const [k, v] of facts) {
            if (v == null || v === "") continue
            const cell = document.createElement("span")
            cell.innerHTML = `<span style="color:#64748b;">${_escape(k)}</span> `
                + `<span style="color:#e5e7eb;">${_escape(String(v))}</span>`
            factsRow.appendChild(cell)
        }
        titleBox.appendChild(factsRow)
        head.appendChild(titleBox)

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:6px;flex-shrink:0;"
        if (rec && rec.enterpriseId) {
            const asPage = document.createElement("a")
            asPage.textContent = "AS profile ↗"
            asPage.href = "/app/info/enterprises/" + encodeURIComponent(rec.enterpriseId)
            asPage.target = "_blank"
            asPage.style.cssText = "background:#1e3a8a;color:#e5e7eb;border:1px solid #38bdf8;"
                + "border-radius:3px;padding:6px 10px;font-size:11px;text-decoration:none;cursor:pointer;"
            actions.appendChild(asPage)
        }
        const logBtn = document.createElement("button")
        logBtn.textContent = "📋 Log"
        logBtn.title = "Open the change log filtered to this airline"
        logBtn.style.cssText = "background:#1e3a8a;color:#e5e7eb;border:1px solid #38bdf8;"
            + "border-radius:3px;padding:6px 10px;cursor:pointer;font-size:11px;"
        logBtn.addEventListener("click", () => {
            if (window.AesChangeLogModal && window.AesChangeLogModal.open) {
                window.AesChangeLogModal.open({
                    initialDomains: ["competitor-intel"],
                    initialSearch: name || iata || ""
                })
            }
        })
        actions.appendChild(logBtn)
        head.appendChild(actions)

        host.appendChild(head)
    }

    function _renderEmpty(host, airlineId) {
        const box = document.createElement("div")
        box.style.cssText = "padding:18px;color:#cbd5e1;font-size:12px;"
        box.innerHTML = `<div style="color:#fbbf24;font-weight:600;margin-bottom:6px;">`
            + `No cached record for airline #${_escape(airlineId)}.</div>`
            + `<div style="color:#94a3b8;">Open the Companies tab and run a competitor scan, `
            + `or visit /app/info/enterprises/${_escape(airlineId)} to populate the cache.</div>`
        host.appendChild(box)
    }

    /**
     * Inline equirectangular SVG with the airline's network on top.
     * Returns the wrapper div for further composition.
     */
    function _renderMap(host, model, ourHubs) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:12px 14px 6px;border-bottom:1px solid #1f2937;"
        const title = document.createElement("div")
        title.style.cssText = "color:#7dd3fc;font-size:11px;font-weight:600;letter-spacing:0.05em;"
            + "text-transform:uppercase;margin-bottom:6px;"
        title.textContent = "Network footprint"
        wrap.appendChild(title)

        const svg = _svg("svg", {
            viewBox: "0 0 " + VW + " " + VH,
            width: "100%",
            preserveAspectRatio: "xMidYMid meet",
            style: "background:#0b1220;border:1px solid #1f2937;border-radius:3px;"
        })
        // graticule
        const grat = _svg("g", {opacity:"0.18"})
        for (let lat = -60; lat <= 60; lat += 30) {
            const y = (90 - lat) / 180 * VH
            grat.appendChild(_svg("line", {x1:0,x2:VW,y1:y,y2:y, stroke:"#475569","stroke-width":"0.5"}))
        }
        for (let lon = -150; lon <= 150; lon += 30) {
            const x = (lon + 180) / 360 * VW
            grat.appendChild(_svg("line", {x1:x,x2:x,y1:0,y2:VH, stroke:"#475569","stroke-width":"0.5"}))
        }
        svg.appendChild(grat)

        const coords = _coords()
        const missing = []
        const placedHubs = new Map()
        const placedDests = new Map()

        // Draw routes first (under bubbles)
        const routeLayer = _svg("g", {opacity:"0.7"})
        for (const r of model.routes) {
            const hc = coords && coords.get(r.hub)
            const dc = coords && coords.get(r.dest)
            if (!hc || !dc) {
                if (!hc) missing.push(r.hub)
                if (!dc) missing.push(r.dest)
                continue
            }
            const a = _project(hc.lat, hc.lon)
            const b = _project(dc.lat, dc.lon)
            const w = Math.max(0.4, Math.min(2.4, Math.log10(1 + (r.weeklyFlights || 0) * 4) * 0.8))
            routeLayer.appendChild(_svg("line", {
                x1:a.x, y1:a.y, x2:b.x, y2:b.y,
                stroke: COL_ROUTE, "stroke-width": String(w), "stroke-linecap":"round"
            }))
            placedHubs.set(r.hub, a)
            placedDests.set(r.dest, b)
        }
        svg.appendChild(routeLayer)

        // ORS overlay edges
        if (model.ors.length) {
            const orsLayer = _svg("g", {opacity:"0.95"})
            for (const o of model.ors) {
                const hc = coords && coords.get(o.hub)
                const dc = coords && coords.get(o.dest)
                if (!hc || !dc) continue
                const a = _project(hc.lat, hc.lon)
                const b = _project(dc.lat, dc.lon)
                const stroke = (o.ourRank && Number(o.ourRank) <= 3) ? COL_ORS_ME : COL_ORS_HI
                orsLayer.appendChild(_svg("line", {
                    x1:a.x, y1:a.y, x2:b.x, y2:b.y,
                    stroke, "stroke-width": "1.6", "stroke-dasharray": "4 3"
                }))
            }
            svg.appendChild(orsLayer)
        }

        // Destinations (smaller bubbles)
        const destLayer = _svg("g", {})
        const hubSet = new Set(model.hubs.map(h => h.iata))
        for (const [iata, p] of placedDests) {
            if (hubSet.has(iata)) continue
            destLayer.appendChild(_svg("circle", {
                cx:p.x, cy:p.y, r:String(DEST_RADIUS_BASE),
                fill: COL_DEST, "fill-opacity":"0.7",
                stroke:"#0b1220","stroke-width":"0.6"
            }))
        }
        svg.appendChild(destLayer)

        // Hubs (larger ringed)
        const hubLayer = _svg("g", {})
        for (const h of model.hubs) {
            const c = coords && coords.get(h.iata)
            if (!c) { missing.push(h.iata); continue }
            const p = _project(c.lat, c.lon)
            const isOurs = ourHubs && ourHubs.has && ourHubs.has(h.iata)
            const fill = isOurs ? COL_OURS : COL_HUB
            const r = HUB_RADIUS + Math.min(7, Math.sqrt(Math.max(0, h.weeklyDepartures || 0) / 12))
            hubLayer.appendChild(_svg("circle", {
                cx:p.x, cy:p.y, r:String(r),
                fill, "fill-opacity":"0.9",
                stroke: isOurs ? "#0ea5e9" : "#92400e", "stroke-width":"1.5"
            }))
            // IATA label
            const label = _svg("text", {
                x:p.x, y:p.y - r - 2,
                "text-anchor":"middle",
                fill: COL_TEXT,
                "font-size":"9","font-family":"ui-monospace,monospace","font-weight":"600"
            })
            label.textContent = h.iata
            hubLayer.appendChild(label)
        }
        svg.appendChild(hubLayer)

        wrap.appendChild(svg)

        // Legend + missing-coords note
        const legend = document.createElement("div")
        legend.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:10px;color:#94a3b8;"
        legend.innerHTML =
            `<span><span style="color:${COL_HUB};">●</span> hub</span>`
            + `<span><span style="color:${COL_OURS};">●</span> hub we share</span>`
            + `<span><span style="color:${COL_DEST};">●</span> destination</span>`
            + `<span><span style="color:${COL_ORS_ME};">– – –</span> ORS rank ≤3 (us)</span>`
            + `<span><span style="color:${COL_ORS_HI};">– – –</span> ORS rank &gt;3</span>`
        wrap.appendChild(legend)
        if (missing.length) {
            const uniq = Array.from(new Set(missing))
            const note = document.createElement("div")
            note.style.cssText = "color:#64748b;font-size:10px;margin-top:4px;"
            note.textContent = "Missing coords: " + uniq.slice(0, 8).join(", ")
                + (uniq.length > 8 ? ` (+${uniq.length - 8} more)` : "")
            wrap.appendChild(note)
        }
        host.appendChild(wrap)
    }

    /**
     * Wave-pattern strip — one row per hub. Buckets weekly departures
     * across 24 1-hour slots. We don't have AS-side per-flight scheduling
     * data for competitors yet, so the wave is computed from per-hub
     * `weeklyDepartures` evenly distributed as a baseline. When Slot K
     * data lands we'll switch to actual hour buckets.
     */
    function _renderWaves(host, model) {
        if (!model.hubs.length) return
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:10px 14px 6px;border-bottom:1px solid #1f2937;"
        const title = document.createElement("div")
        title.style.cssText = "color:#7dd3fc;font-size:11px;font-weight:600;letter-spacing:0.05em;"
            + "text-transform:uppercase;margin-bottom:6px;"
        title.textContent = "Wave pattern · weekly departures by hub (synthesised hourly)"
        wrap.appendChild(title)

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:60px 1fr 60px;gap:4px 8px;align-items:center;"
        for (const h of model.hubs.slice(0, 12)) {
            const lab = document.createElement("div")
            lab.style.cssText = "color:#fbbf24;font-family:ui-monospace,monospace;font-size:11px;"
            lab.textContent = h.iata
            const stripWrap = document.createElement("div")
            stripWrap.style.cssText = "display:flex;gap:1px;height:12px;"
            const total = Number(h.weeklyDepartures) || 0
            // 24 buckets, evenly distributed (pure baseline; replace
            // with real hour buckets when Slot K wires per-flight data).
            for (let b = 0; b < 24; b++) {
                const cell = document.createElement("div")
                const v = total / 24
                const intensity = Math.min(1, v / 4)
                cell.style.cssText = "flex:1;background:rgba(56,189,248," + (0.18 + intensity * 0.7).toFixed(2)
                    + ");border-radius:1px;"
                cell.title = `${h.iata} ${String(b).padStart(2,"0")}:00 ≈ ${v.toFixed(1)}/wk`
                stripWrap.appendChild(cell)
            }
            const num = document.createElement("div")
            num.style.cssText = "color:#cbd5e1;font-family:ui-monospace,monospace;font-size:11px;text-align:right;"
            num.textContent = total + "/wk"
            grid.appendChild(lab)
            grid.appendChild(stripWrap)
            grid.appendChild(num)
        }
        wrap.appendChild(grid)

        if (model.hubs.length > 12) {
            const more = document.createElement("div")
            more.style.cssText = "color:#64748b;font-size:10px;margin-top:4px;"
            more.textContent = `+${model.hubs.length - 12} more hubs`
            wrap.appendChild(more)
        }
        host.appendChild(wrap)
    }

    function _renderHubsAndRoutes(host, model, opts) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:10px 14px;display:grid;grid-template-columns:1fr 2fr;gap:14px;"
            + "border-bottom:1px solid #1f2937;"

        // Hubs grid
        const hubsBox = document.createElement("div")
        const hubsTitle = document.createElement("div")
        hubsTitle.style.cssText = "color:#7dd3fc;font-size:11px;font-weight:600;letter-spacing:0.05em;"
            + "text-transform:uppercase;margin-bottom:6px;"
        hubsTitle.textContent = `Hubs (${model.hubs.length})`
        hubsBox.appendChild(hubsTitle)
        const hubsList = document.createElement("div")
        hubsList.style.cssText = "display:flex;flex-direction:column;gap:3px;max-height:240px;overflow:auto;"
        const hubsSorted = model.hubs.slice().sort((a, b) =>
            (b.weeklyDepartures || 0) - (a.weeklyDepartures || 0))
        const maxHubW = hubsSorted.length ? hubsSorted[0].weeklyDepartures || 1 : 1
        for (const h of hubsSorted) {
            const row = document.createElement("div")
            row.style.cssText = "display:grid;grid-template-columns:55px 1fr 60px;gap:6px;align-items:center;"
                + "padding:2px 4px;border-radius:2px;cursor:pointer;"
            row.addEventListener("mouseenter", () => row.style.background = "#1e293b")
            row.addEventListener("mouseleave", () => row.style.background = "")
            row.addEventListener("click", () => {
                if (opts && typeof opts.onSelect === "function") {
                    opts.onSelect({kind:"switchTab", tab:"map", search: h.iata})
                }
            })
            const code = document.createElement("span")
            code.textContent = h.iata
            code.style.cssText = "color:#fbbf24;font-family:ui-monospace,monospace;font-size:11px;"
            const bar = document.createElement("div")
            bar.style.cssText = "height:8px;background:#1e293b;border-radius:1px;position:relative;"
            const fill = document.createElement("div")
            const pct = Math.max(0, Math.min(100, (h.weeklyDepartures / maxHubW) * 100))
            fill.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${pct.toFixed(1)}%;background:#fbbf24;border-radius:1px;`
            bar.appendChild(fill)
            const num = document.createElement("span")
            num.style.cssText = "color:#cbd5e1;font-family:ui-monospace,monospace;font-size:11px;text-align:right;"
            num.textContent = (h.weeklyDepartures || 0) + "/wk"
            row.append(code, bar, num)
            hubsList.appendChild(row)
        }
        if (!hubsSorted.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:#94a3b8;font-size:11px;"
            empty.textContent = "No hubs cached."
            hubsList.appendChild(empty)
        }
        hubsBox.appendChild(hubsList)
        wrap.appendChild(hubsBox)

        // Routes grid
        const routesBox = document.createElement("div")
        const routesTitle = document.createElement("div")
        routesTitle.style.cssText = "color:#7dd3fc;font-size:11px;font-weight:600;letter-spacing:0.05em;"
            + "text-transform:uppercase;margin-bottom:6px;"
        routesTitle.textContent = `Routes (${model.routes.length})`
        routesBox.appendChild(routesTitle)
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const thead = document.createElement("thead")
        thead.innerHTML = `<tr style="color:#94a3b8;text-align:left;">`
            + `<th style="padding:4px 6px;font-weight:600;">Route</th>`
            + `<th style="padding:4px 6px;font-weight:600;text-align:right;">/wk</th>`
            + `<th style="padding:4px 6px;font-weight:600;">ORS</th>`
            + `</tr>`
        tbl.appendChild(thead)
        const tbody = document.createElement("tbody")
        const routesSorted = model.routes.slice().sort((a, b) =>
            (b.weeklyFlights || 0) - (a.weeklyFlights || 0))
        const orsByKey = new Map()
        for (const o of model.ors) orsByKey.set(o.key, o)
        for (const r of routesSorted.slice(0, 80)) {
            const key = r.hub + "-" + r.dest
            const o = orsByKey.get(key)
            const tr = document.createElement("tr")
            tr.style.cssText = "color:#cbd5e1;cursor:pointer;border-top:1px solid #1f2937;"
            tr.addEventListener("mouseenter", () => tr.style.background = "#1e293b")
            tr.addEventListener("mouseleave", () => tr.style.background = "")
            tr.addEventListener("click", () => {
                if (opts && typeof opts.onSelect === "function") {
                    opts.onSelect({kind:"switchTab", tab:"routes", search: key})
                }
            })
            tr.innerHTML = `<td style="padding:3px 6px;font-family:ui-monospace,monospace;">`
                + `<span style="color:#fbbf24;">${_escape(r.hub)}</span>`
                + `<span style="color:#64748b;"> → </span>`
                + `<span style="color:#7dd3fc;">${_escape(r.dest)}</span></td>`
                + `<td style="padding:3px 6px;font-family:ui-monospace,monospace;text-align:right;">`
                + `${_escape(String(r.weeklyFlights || 0))}</td>`
                + `<td style="padding:3px 6px;font-family:ui-monospace,monospace;color:`
                + (o && o.ourRank && Number(o.ourRank) <= 3 ? "#34d399" : (o ? "#f87171" : "#475569"))
                + `;">`
                + (o ? "rank " + (o.ourRank != null ? o.ourRank : "?") : "—")
                + `</td>`
            tbody.appendChild(tr)
        }
        tbl.appendChild(tbody)
        routesBox.appendChild(tbl)
        if (routesSorted.length > 80) {
            const more = document.createElement("div")
            more.style.cssText = "color:#64748b;font-size:10px;margin-top:4px;"
            more.textContent = `+${routesSorted.length - 80} more (showing top 80 by /wk)`
            routesBox.appendChild(more)
        }
        wrap.appendChild(routesBox)

        host.appendChild(wrap)
    }

    function render(host, data, opts) {
        host.textContent = ""
        const airlineId = opts && opts.airlineId ? String(opts.airlineId) : null
        if (!airlineId) {
            const box = document.createElement("div")
            box.style.cssText = "padding:18px;color:#94a3b8;font-size:12px;"
            box.textContent = "No airline selected. Click an airline row from the Companies tab "
                + "or click an enterprise on the World map to drill in here."
            host.appendChild(box)
            return
        }

        const model = buildModel(data, airlineId)
        _renderHeader(host, model, airlineId, opts)
        if (!model.record) {
            _renderEmpty(host, airlineId)
            return
        }

        // Body scrolls; header is sticky-on-host (host owns the wrapper).
        const body = document.createElement("div")
        body.style.cssText = "flex:1;overflow:auto;display:flex;flex-direction:column;"
        host.appendChild(body)

        const ourHubs = data && data.ourHubs
        _renderMap(body, model, ourHubs)
        _renderWaves(body, model)
        _renderHubsAndRoutes(body, model, opts)
    }

    window.AesCompetitorIntelAirlineDetailView = {
        render,
        buildModel,
        DEFAULT_SORT: null
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const data = {
                enterprises: new Map([["77", {
                    enterpriseId: "77", name: "Test Air", iata: "TST",
                    alliance: {name: "OneTest"},
                    fleet: {aircraftCount: 12},
                    hubs: [
                        {iata: "LHR", weeklyDepartures: 168},
                        {iata: "JFK", weeklyDepartures: 84}
                    ],
                    routeFootprint: [
                        {hub:"LHR", dest:"JFK", weeklyFlights: 14},
                        {hub:"LHR", dest:"CDG", weeklyFlights: 28},
                        {hub:"JFK", dest:"LHR", weeklyFlights: 14}
                    ],
                    scrapedAt: Date.now() - 2 * 86400000
                }]]),
                snapshots: new Map(),
                edges: new Map(),
                orsRoutes: new Map([["LHR-JFK", {hub:"LHR",dest:"JFK",ourRank:2,scrapedAt:Date.now()}]]),
                ourHubs: new Set(["LHR"])
            }
            const m = buildModel(data, "77")
            console.assert(m.record && m.record.iata === "TST", "[smoke airline-detail] record loads")
            console.assert(m.hubs.length === 2 && m.routes.length === 3, "[smoke] hubs+routes count")
            console.assert(m.ors.length === 1, "[smoke] ORS overlay finds matching edge")
            console.assert(m.ors[0].ourRank === 2, "[smoke] ORS rank carried")
        }
    } catch (_) { /* never break the page */ }
})()
