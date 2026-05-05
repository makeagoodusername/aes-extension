"use strict"

/**
 * Slide-in drilldown panel for the Competitor Intel hub. Renders detail
 * for the row the user clicked in any tab.
 *
 * Selection envelope: `{kind: "company"|"route"|"ors", id, row}`. The
 * panel dispatches per-kind renderers but shares the chrome (header,
 * close button, scrim).
 *
 * Mounted as a sibling of the hub-shell modal — sits over the main panel
 * with a translucent backdrop. Closing returns focus to the hub.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesCompetitorIntelDrilldown) return

    let _instance = null

    function open(parent, selection, ctx) {
        close()
        if (!selection || !parent) return

        const overlay = document.createElement("div")
        overlay.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,0.4);z-index:2;"
            + "display:flex;justify-content:flex-end;"
        const panel = document.createElement("div")
        panel.style.cssText = "background:#0b1220;border-left:1px solid #38bdf8;width:520px;max-width:90%;"
            + "height:100%;overflow:auto;display:flex;flex-direction:column;"
            + "box-shadow:-4px 0 16px rgba(0,0,0,0.5);"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
            + "padding:10px 16px;border-bottom:1px solid #1f2937;background:#0f1623;"
        const title = document.createElement("div")
        title.style.cssText = "color:#7dd3fc;font-size:13px;font-weight:600;"
        title.textContent = _titleFor(selection)
        const closeBtn = document.createElement("button")
        closeBtn.textContent = "✕"
        closeBtn.style.cssText = "background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:14px;"
        closeBtn.addEventListener("click", close)
        head.append(title, closeBtn)
        panel.append(head)

        const body = document.createElement("div")
        body.style.cssText = "flex:1;padding:14px 18px;color:#e5e7eb;font-size:12px;line-height:1.5;"
        panel.append(body)
        overlay.append(panel)
        parent.append(overlay)
        overlay.addEventListener("click", e => { if (e.target === overlay) close() })

        if (selection.kind === "company")     _renderCompany(body, selection, ctx)
        else if (selection.kind === "route")  _renderRoute(body, selection, ctx)
        else if (selection.kind === "ors")    _renderOrs(body, selection, ctx)
        else body.textContent = "Unsupported drilldown kind: " + selection.kind

        _instance = {overlay, parent}
    }

    function close() {
        if (!_instance) return
        if (_instance.overlay && _instance.overlay.parentNode) {
            _instance.overlay.parentNode.removeChild(_instance.overlay)
        }
        _instance = null
    }

    function _titleFor(sel) {
        if (sel.kind === "company") {
            const r = sel.row && sel.row.record
            return (r && r.name) ? r.name + " · drilldown" : "Company · drilldown"
        }
        if (sel.kind === "route") return sel.id + " · route detail"
        if (sel.kind === "ors") return sel.id + " · ORS detail"
        return "Detail"
    }

    function _renderCompany(host, sel, ctx) {
        const row = sel.row
        const rec = row && row.record
        if (!rec) { host.textContent = "No record."; return }

        // Stamp the IATA→enterpriseId pairing the moment a real drilldown
        // opens — the user has volunteered intent that this airline is worth
        // tracking, so future markets-derived rows for the same IATA can
        // upgrade to the rich AS profile link without waiting for the next
        // full hub data load.
        if (window.AesCompetitorIntelHost
                && typeof window.AesCompetitorIntelHost.stampIataMapping === "function") {
            const server = (ctx && ctx.server) || (rec && rec.server)
            window.AesCompetitorIntelHost.stampIataMapping(
                server, rec.iata, rec.enterpriseId, rec.name)
        }

        // Header strip — name, IATA, alliance, base country, freshness.
        const headStrip = document.createElement("div")
        headStrip.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;padding-bottom:10px;"
            + "border-bottom:1px solid #1f2937;margin-bottom:10px;"
        const facts = [
            ["IATA",     rec.iata],
            ["Alliance", rec.alliance && rec.alliance.name],
            ["Base",     rec.baseCountry && rec.baseCountry.name],
            ["Aircraft", rec.fleet && rec.fleet.aircraftCount],
            ["Stations", rec.fleet && rec.fleet.stationsCount],
            ["Routes",   Array.isArray(rec.routeFootprint) ? rec.routeFootprint.length : 0]
        ]
        for (const [k, v] of facts) {
            if (v == null || v === "") continue
            const cell = document.createElement("div")
            cell.style.cssText = "min-width:80px;"
            cell.innerHTML = `<div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">${k}</div>`
                + `<div style="color:#e5e7eb;font-size:13px;">${_escape(String(v))}</div>`
            headStrip.append(cell)
        }
        host.append(headStrip)

        // Threat breakdown
        if (row.threat) {
            const t = row.threat
            const block = document.createElement("div")
            block.style.cssText = "margin-bottom:12px;"
            block.innerHTML = `<div style="color:#7dd3fc;font-weight:600;margin-bottom:4px;">Threat · ${t.bucket} (${t.score}/100)</div>`
            const cs = t.components || {}
            const compList = ["fleet", "network", "momentum", "overlap", "alliance", "freshness"]
                .map(c => `${c}: ${(cs[c] != null ? cs[c].toFixed(1) : "—")}`).join(" · ")
            const compEl = document.createElement("div")
            compEl.style.cssText = "color:#cbd5e1;font-family:ui-monospace,monospace;font-size:11px;"
            compEl.textContent = compList
            block.append(compEl)
            if (t.rationale && t.rationale.length) {
                const ul = document.createElement("ul")
                ul.style.cssText = "margin:6px 0 0 18px;padding:0;color:#94a3b8;"
                for (const r of t.rationale) {
                    const li = document.createElement("li")
                    li.textContent = r
                    ul.append(li)
                }
                block.append(ul)
            }
            host.append(block)
        }

        // Hubs list
        const hubs = Array.isArray(rec.hubs) ? rec.hubs : []
        if (hubs.length) {
            const hubBlock = document.createElement("div")
            hubBlock.style.cssText = "margin-bottom:12px;"
            hubBlock.innerHTML = `<div style="color:#7dd3fc;font-weight:600;margin-bottom:4px;">Hubs (${hubs.length})</div>`
            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;"
            for (const h of hubs.slice(0, 30)) {
                const chip = document.createElement("span")
                chip.style.cssText = "padding:2px 8px;background:#1e293b;border:1px solid #334155;"
                    + "border-radius:3px;font-family:ui-monospace,monospace;color:#e5e7eb;font-size:11px;"
                chip.textContent = (h.iata || "?") + (h.weeklyDepartures ? " · " + h.weeklyDepartures + "/wk" : "")
                list.append(chip)
            }
            if (hubs.length > 30) {
                const more = document.createElement("span")
                more.style.cssText = "color:#94a3b8;font-size:11px;align-self:center;"
                more.textContent = "+" + (hubs.length - 30) + " more"
                list.append(more)
            }
            hubBlock.append(list)
            host.append(hubBlock)
        }

        // Recent diff feed (last 5 transitions)
        const snaps = row.snapshots || []
        if (snaps.length >= 2 && window.AesCompetitorDiff) {
            const feed = document.createElement("div")
            feed.style.cssText = "margin-bottom:12px;"
            feed.innerHTML = `<div style="color:#7dd3fc;font-weight:600;margin-bottom:4px;">Recent changes</div>`
            const events = []
            for (let i = snaps.length - 1; i > 0 && events.length < 8; i--) {
                const evs = window.AesCompetitorDiff.compare(snaps[i-1], snaps[i])
                for (const e of evs) events.push({event: e, at: snaps[i].at})
                if (events.length >= 8) break
            }
            if (!events.length) {
                feed.innerHTML += `<div style="color:#94a3b8;">No change events across cached snapshots.</div>`
            } else {
                const list = document.createElement("ul")
                list.style.cssText = "margin:0 0 0 18px;padding:0;color:#cbd5e1;"
                for (const {event, at} of events) {
                    const li = document.createElement("li")
                    li.style.cssText = "margin-bottom:3px;"
                    const isPositive = /\.(gained|added|entered|joined)$/.test(event.type)
                    const dot = isPositive ? "● " : ""
                    const dotColor = isPositive ? "#34d399" : "#94a3b8"
                    li.innerHTML = `<span style="color:${dotColor};">${dot}</span>`
                        + `<strong style="color:#e5e7eb;">${event.type}</strong> `
                        + `<span style="color:#6b7280;">${_fmtRelative(at)}</span>`
                    list.append(li)
                }
                feed.append(list)
            }
            host.append(feed)
        }

        // Open detail button — switch the hub content area to the rich
        // airline-detail view (map + waves + hubs + routes). Closes this
        // slide-in panel since the detail view replaces it. Falls back to
        // logging when the host shell isn't reachable (e.g. drilldown
        // mounted from a different surface in a future expansion).
        const detailBtn = document.createElement("button")
        detailBtn.textContent = "🗺 Open detail view →"
        detailBtn.style.cssText = "background:#1e3a8a;color:#e5e7eb;border:1px solid #67e8f9;"
            + "border-radius:3px;padding:6px 12px;cursor:pointer;font-size:11px;margin-right:8px;font-weight:600;"
        detailBtn.addEventListener("click", () => {
            const id = (rec && rec.enterpriseId) || sel.id
            if (!id) return
            close()
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                try {
                    window.CentralHubBus.emit("focus-enterprise", {
                        enterpriseId: String(id),
                        source: "competitor-intel-drilldown"
                    })
                } catch (e) { /* best-effort */ }
            }
        })
        host.append(detailBtn)

        // Open log button
        const logBtn = document.createElement("button")
        logBtn.textContent = "Open full change log →"
        logBtn.style.cssText = "background:#1e3a8a;color:#e5e7eb;border:1px solid #38bdf8;"
            + "border-radius:3px;padding:6px 12px;cursor:pointer;font-size:11px;"
        logBtn.addEventListener("click", () => {
            if (window.AesChangeLogModal && window.AesChangeLogModal.open) {
                window.AesChangeLogModal.open({
                    initialDomains: ["competitor-intel"],
                    initialSearch:  rec.name || rec.iata || ""
                })
            }
        })
        host.append(logBtn)
    }

    function _renderRoute(host, sel, ctx) {
        const row = sel.row
        const edge = row && row.edge
        if (!edge) { host.textContent = "No record."; return }

        const headStrip = document.createElement("div")
        headStrip.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;padding-bottom:10px;"
            + "border-bottom:1px solid #1f2937;margin-bottom:10px;"
        const facts = [
            ["Hub",       edge.hub],
            ["Dest",      edge.dest],
            ["Wk flights", edge.totals && edge.totals.totalWeeklyFlights],
            ["Wk seats",  edge.totals && edge.totals.totalSeats],
            ["Cmp count", row.competitors.length]
        ]
        for (const [k, v] of facts) {
            if (v == null || v === "") continue
            const cell = document.createElement("div")
            cell.style.cssText = "min-width:70px;"
            cell.innerHTML = `<div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">${k}</div>`
                + `<div style="color:#e5e7eb;font-size:13px;">${_escape(String(v))}</div>`
            headStrip.append(cell)
        }
        host.append(headStrip)

        // Competitor share table
        const cmpBlock = document.createElement("div")
        cmpBlock.innerHTML = `<div style="color:#7dd3fc;font-weight:600;margin-bottom:4px;">Competitors on this route</div>`
        const cmpTable = document.createElement("table")
        cmpTable.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        const thRow = document.createElement("tr")
        for (const h of ["Name", "Pax %", "Cargo %"]) {
            const th = document.createElement("th")
            th.style.cssText = "text-align:left;padding:4px 8px;border-bottom:1px solid #1f2937;color:#94a3b8;"
            th.textContent = h
            thRow.append(th)
        }
        cmpTable.append(thRow)
        const sorted = row.competitors.slice().sort((a, b) =>
            (b.sharePctPax || 0) - (a.sharePctPax || 0))
        for (const c of sorted) {
            const tr = document.createElement("tr")
            const nTd = document.createElement("td")
            nTd.style.cssText = "padding:4px 8px;color:#e5e7eb;"
            nTd.textContent = c.name || "—"
            tr.append(nTd)
            const pTd = document.createElement("td")
            pTd.style.cssText = "padding:4px 8px;color:#cbd5e1;font-family:ui-monospace,monospace;"
            pTd.textContent = c.sharePctPax != null ? c.sharePctPax.toFixed(1) + "%" : "—"
            tr.append(pTd)
            const cTd = document.createElement("td")
            cTd.style.cssText = "padding:4px 8px;color:#cbd5e1;font-family:ui-monospace,monospace;"
            cTd.textContent = c.sharePctCargo != null ? c.sharePctCargo.toFixed(1) + "%" : "—"
            tr.append(cTd)
            cmpTable.append(tr)
        }
        cmpBlock.append(cmpTable)
        host.append(cmpBlock)

        // Footer — link to ORS detail if cached
        if (row.hasOrs) {
            const link = document.createElement("div")
            link.style.cssText = "margin-top:12px;"
            link.innerHTML = `<span style="color:#67e8f9;">◎ ORS data cached — switch to ORS tab and search for ${edge.hub}-${edge.dest}.</span>`
            host.append(link)
        }
    }

    function _renderOrs(host, sel, ctx) {
        const row = sel.row
        const rec = row && row.record
        if (!rec) { host.textContent = "No record."; return }

        const headStrip = document.createElement("div")
        headStrip.style.cssText = "padding-bottom:10px;border-bottom:1px solid #1f2937;margin-bottom:10px;"
        headStrip.innerHTML = `<div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Route</div>`
            + `<div style="color:#e5e7eb;font-size:13px;font-family:ui-monospace,monospace;font-weight:600;">${row.routeKey}</div>`
            + `<div style="color:#6b7280;font-size:11px;margin-top:4px;">Scraped ${_fmtRelative(rec.scrapedAt)}</div>`
        host.append(headStrip)

        const byClass = rec.byClass || {}
        for (const cls of ["ECONOMY", "BUSINESS", "FIRST", "CARGO"]) {
            const c = byClass[cls]
            if (!c) continue
            const block = document.createElement("div")
            block.style.cssText = "margin-bottom:14px;padding:8px 10px;"
                + "background:rgba(15,23,42,0.5);border-left:3px solid #38bdf8;"
            block.innerHTML = `<div style="color:#7dd3fc;font-weight:600;margin-bottom:4px;">${cls}</div>`
            const stats = [
                ["Total connections", c.totalConnections],
                ["Our top rating",    c.ourTopRating != null ? c.ourTopRating.toFixed(2) : "—"],
                ["Top competitor",    c.topCompetitorRating != null ? c.topCompetitorRating.toFixed(2) : "—"],
                ["Gap to top",        c.ratingGapToTop != null ? (c.ratingGapToTop >= 0 ? "+" : "") + c.ratingGapToTop.toFixed(2) : "—"],
                ["Rank (any)",        c.rankAny],
                ["Rank (bookable)",   c.rankBookable]
            ]
            const grid = document.createElement("div")
            grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-size:11px;"
            for (const [k, v] of stats) {
                if (v == null || v === "") continue
                const row = document.createElement("div")
                row.innerHTML = `<span style="color:#94a3b8;">${k}:</span> <span style="color:#e5e7eb;font-family:ui-monospace,monospace;">${_escape(String(v))}</span>`
                grid.append(row)
            }
            block.append(grid)

            const ratings = c.competitorRatings || {}
            const carriers = Object.keys(ratings)
            if (carriers.length) {
                const cmpHead = document.createElement("div")
                cmpHead.style.cssText = "color:#94a3b8;font-size:11px;margin-top:8px;margin-bottom:4px;"
                cmpHead.textContent = "Competitor ratings"
                block.append(cmpHead)
                const list = document.createElement("div")
                list.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;"
                carriers.sort((a, b) => (ratings[b] || 0) - (ratings[a] || 0))
                for (const cr of carriers) {
                    const chip = document.createElement("span")
                    chip.style.cssText = "padding:2px 8px;background:#1e293b;border:1px solid #334155;"
                        + "border-radius:3px;font-family:ui-monospace,monospace;color:#e5e7eb;font-size:11px;"
                    chip.textContent = cr + " · " + (ratings[cr] != null ? ratings[cr].toFixed(2) : "—")
                    list.append(chip)
                }
                block.append(list)
            }
            host.append(block)
        }
    }

    function _escape(s) {
        return String(s).replace(/[<>&"']/g, ch =>
            ({"<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;"})[ch])
    }
    function _fmtRelative(ts) {
        if (!isFinite(ts) || ts <= 0) return "never"
        const diff = Date.now() - ts
        if (diff < 60_000)         return Math.max(1, Math.round(diff / 1000)) + "s ago"
        if (diff < 3600_000)       return Math.round(diff / 60000) + "m ago"
        if (diff < 86400_000)      return Math.round(diff / 3600000) + "h ago"
        if (diff < 7 * 86400_000)  return Math.round(diff / 86400000) + "d ago"
        return new Date(ts).toLocaleDateString()
    }

    window.AesCompetitorIntelDrilldown = {open, close}
})()
