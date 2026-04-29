"use strict"

/**
 * Route Assistant — Yield heatmap view (panelMode = "heatmap").
 *
 * Hubs × destinations matrix coloured by the picked metric (score / profit
 * / share). Sourced from per-hub `routeAssistant:topRoutes:<HUB>` records
 * populated incrementally as the user visits each hub's panel. Click any
 * cell to open that route in AS.
 *
 * Restructure slice B — owns its own `_renderHeatmap` and `_buildHeader`
 * end-to-end (previously delegated back into `RouteAssistantPanel`). The
 * panel now exposes only `tableHost`, `settings`, `hubIata`, and
 * `_render()` for re-render-on-metric-change. Inter-hub data still
 * loads through `RouteAssistantPanel.loadAllHubTopRoutes` (a static
 * method that owns the hub-list normalisation).
 */
class RouteAssistantHeatmapView {

    static get id()    { return "heatmap" }
    static get label() { return "Heatmap" }
    static get glyph() { return "🗺" }

    static async render(panel, sorted) {
        if (!panel || !panel.tableHost) return
        panel.tableHost.innerHTML = ""
        const cfg = (panel.settings && panel.settings.heatmap) || {}
        const hubs = []
        if (panel.hubIata) hubs.push(String(panel.hubIata).toUpperCase())
        for (const h of (panel.settings && panel.settings.recentHubs) || []) {
            const hu = String(h).toUpperCase()
            if (!hubs.includes(hu)) hubs.push(hu)
        }

        panel.tableHost.append(RouteAssistantHeatmapView._buildHeader(panel, cfg))

        if (hubs.length < 2) {
            const empty = document.createElement("div")
            empty.style.cssText = "margin:18px 0;padding:14px;border:1px dashed #475569;"
                + "background:rgba(100,116,139,0.08);border-radius:4px;color:#cbd5e1;font-size:12px;line-height:1.5;"
            empty.innerHTML = "<strong>Heatmap needs at least 2 visited hubs.</strong><br>"
                + "Visit a different hub's <code>/app/com/scheduling</code> page (or use Alt+1..5 once you have one), "
                + "then return here. Each hub's topRoutes record is auto-saved on every panel render."
            panel.tableHost.append(empty)
            return
        }

        const blobs = await RouteAssistantPanel.loadAllHubTopRoutes(hubs)
        if (blobs.size === 0) {
            const empty = document.createElement("div")
            empty.style.cssText = "margin:18px 0;padding:14px;border:1px dashed #475569;"
                + "background:rgba(100,116,139,0.08);border-radius:4px;color:#cbd5e1;font-size:12px;"
            empty.textContent = "No cached topRoutes records found for any of your recent hubs. "
                + "Visit each hub's scheduling page once to populate the cache, then return here."
            panel.tableHost.append(empty)
            return
        }

        // X axis — union of every hub's destIatas, sorted by current hub's
        // score desc (best routes left), then alphabetic.
        const destSet = new Set()
        for (const b of blobs.values()) {
            for (const r of (b.rows || [])) {
                if (r.destIata) destSet.add(String(r.destIata).toUpperCase())
            }
        }
        const dests = Array.from(destSet)
        const currentHubBlob = blobs.get(String(panel.hubIata || "").toUpperCase())
        const currentScoreByDest = new Map()
        if (currentHubBlob) {
            for (const r of currentHubBlob.rows || []) {
                if (r.destIata && r.score != null) {
                    currentScoreByDest.set(String(r.destIata).toUpperCase(), r.score)
                }
            }
        }
        dests.sort((a, b) => {
            const sa = currentScoreByDest.get(a)
            const sb = currentScoreByDest.get(b)
            if (sa != null && sb != null) return sb - sa
            if (sa != null) return -1
            if (sb != null) return 1
            return a.localeCompare(b)
        })

        // Cell lookup: hub → dest → row.
        const lookup = new Map()
        for (const [hub, blob] of blobs.entries()) {
            const m = new Map()
            for (const r of (blob.rows || [])) {
                if (r.destIata) m.set(String(r.destIata).toUpperCase(), r)
            }
            lookup.set(hub, m)
        }

        // Global min/max so cell colours span the full visible range.
        const metric = cfg.metric === "profit" ? "profitPerWeek"
                     : cfg.metric === "share"  ? "ourPaxShare"
                     : "score"
        let minV = Infinity, maxV = -Infinity
        for (const m of lookup.values()) {
            for (const r of m.values()) {
                const v = r[metric]
                if (typeof v === "number" && isFinite(v)) {
                    if (v < minV) minV = v
                    if (v > maxV) maxV = v
                }
            }
        }
        if (!isFinite(minV) || !isFinite(maxV)) { minV = 0; maxV = 0 }

        // Grid table — sticky first column (hub label), sticky header row.
        const wrap = document.createElement("div")
        wrap.style.cssText = "overflow:auto;max-height:60vh;border:1px solid #374151;"
            + "border-radius:4px;background:#0f1623;margin-top:10px;"
        const tbl = document.createElement("table")
        tbl.style.cssText = "border-collapse:collapse;font-size:11px;color:#e5e7eb;"
            + "font-variant-numeric:tabular-nums;"
        const thead = document.createElement("thead")
        const headTr = document.createElement("tr")
        const cornerTh = document.createElement("th")
        cornerTh.textContent = "Hub \\ Dest"
        cornerTh.style.cssText = "padding:4px 8px;background:#0f1623;color:#9ca3af;"
            + "border-bottom:1px solid #374151;border-right:1px solid #374151;"
            + "position:sticky;top:0;left:0;z-index:3;text-align:left;"
            + "font-weight:600;min-width:90px;"
        headTr.append(cornerTh)
        for (const dest of dests) {
            const th = document.createElement("th")
            th.textContent = dest
            th.style.cssText = "padding:4px 6px;background:#0f1623;color:#cbd5e1;"
                + "border-bottom:1px solid #374151;font-weight:600;font-family:monospace;"
                + "position:sticky;top:0;z-index:2;text-align:center;min-width:48px;"
            headTr.append(th)
        }
        thead.append(headTr)
        tbl.append(thead)

        const tbody = document.createElement("tbody")
        for (const hub of hubs) {
            const tr = document.createElement("tr")
            const hubTd = document.createElement("th")
            hubTd.textContent = hub
            hubTd.style.cssText = "padding:4px 8px;background:#0f1623;color:#cbd5e1;"
                + "border-right:1px solid #374151;font-weight:600;font-family:monospace;"
                + "position:sticky;left:0;z-index:1;text-align:left;min-width:90px;"
            tr.append(hubTd)
            const m = lookup.get(hub) || new Map()
            for (const dest of dests) {
                const r = m.get(dest)
                const td = document.createElement("td")
                td.style.cssText = "padding:4px 4px;text-align:center;border-bottom:1px solid #1a2332;"
                    + "border-right:1px solid #1a2332;cursor:pointer;"
                if (!r) {
                    td.textContent = "·"
                    td.style.color = "#374151"
                    td.style.cursor = "default"
                } else {
                    const v = r[metric]
                    if (typeof v === "number" && isFinite(v)) {
                        const t = (maxV - minV > 0) ? (v - minV) / (maxV - minV) : 0.5
                        td.style.background = _heatmapColor(t)
                        td.style.color = t > 0.55 ? "#0f1623" : "#f3f4f6"
                        if (metric === "profitPerWeek") td.textContent = _formatCompactCurrency(v)
                        else if (metric === "ourPaxShare") td.textContent = (Math.round(v * 10) / 10) + "%"
                        else td.textContent = String(Math.round(v))
                        td.title = hub + "→" + dest
                            + "  ·  score " + (r.score != null ? Math.round(r.score) : "—")
                            + "  ·  profit/wk " + (r.profitPerWeek != null ? _formatCompactCurrency(r.profitPerWeek) : "—")
                            + "  ·  share " + (r.ourPaxShare != null ? (Math.round(r.ourPaxShare * 10) / 10) + "%" : "—")
                    } else {
                        td.textContent = "—"
                        td.style.color = "#6b7280"
                    }
                    td.addEventListener("click", () => {
                        window.open("/app/com/scheduling/" + hub + dest, "_blank")
                    })
                }
                tr.append(td)
            }
            tbody.append(tr)
        }
        tbl.append(tbody)
        wrap.append(tbl)
        panel.tableHost.append(wrap)

        const foot = document.createElement("div")
        foot.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.5;"
        foot.textContent = "Click any cell to open that route in AS. Empty cells (·) mean the destination isn't in that hub's cached topRoutes — visit the hub once to populate. Color scale spans the full visible range of the selected metric."
        panel.tableHost.append(foot)
    }

    static _buildHeader(panel, cfg) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 10px;"
            + "background:rgba(59,130,246,0.10);border:1px solid rgba(59,130,246,0.35);"
            + "border-radius:4px;color:#e5e7eb;font-size:12px;"
        const title = document.createElement("strong")
        title.textContent = "🗺 Yield heatmap"
        wrap.append(title)
        const hubsCount = ((panel.settings && panel.settings.recentHubs) || []).length
        const sub = document.createElement("span")
        sub.style.color = "#9ca3af"
        sub.textContent = " · " + hubsCount + " recent hub" + (hubsCount === 1 ? "" : "s")
        wrap.append(sub)

        const spacer = document.createElement("span")
        spacer.style.flex = "1"
        wrap.append(spacer)

        const metricLabel = document.createElement("label")
        metricLabel.style.cssText = "color:#9ca3af;display:flex;gap:5px;align-items:center;"
        metricLabel.append(document.createTextNode("Metric"))
        const metricSel = document.createElement("select")
        metricSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;"
            + "border-radius:3px;padding:1px 4px;font-size:11px;"
        for (const o of [{v: "score", l: "Score"}, {v: "profit", l: "Profit / week"}, {v: "share", l: "Pax share %"}]) {
            const opt = document.createElement("option")
            opt.value = o.v
            opt.textContent = o.l
            if (cfg.metric === o.v) opt.selected = true
            metricSel.append(opt)
        }
        metricSel.addEventListener("change", async () => {
            panel.settings.heatmap = Object.assign({}, panel.settings.heatmap || {}, {metric: metricSel.value})
            try { await RouteAssistantSettings.save({heatmap: panel.settings.heatmap}) }
            catch (e) { /* non-fatal */ }
            panel._render()
        })
        metricLabel.append(metricSel)
        wrap.append(metricLabel)

        return wrap
    }
}

/**
 * Three-stop interpolated cell colour: deep blue (cold) → muted amber (mid)
 * → vibrant green (hot). Avoids the green→red traffic-light convention
 * because the user can choose any metric — green is just "more of it".
 */
function _heatmapColor(t) {
    if (!isFinite(t)) t = 0
    t = Math.max(0, Math.min(1, t))
    const lerp = (a, b, k) => Math.round(a + (b - a) * k)
    let r, g, bl
    if (t < 0.5) {
        const k = t / 0.5
        r  = lerp(0x1e, 0x92, k)
        g  = lerp(0x3a, 0x72, k)
        bl = lerp(0x5f, 0x3a, k)
    } else {
        const k = (t - 0.5) / 0.5
        r  = lerp(0x92, 0x1a, k)
        g  = lerp(0x72, 0x8a, k)
        bl = lerp(0x3a, 0x4f, k)
    }
    return "rgb(" + r + "," + g + "," + bl + ")"
}

/**
 * Compact AS$ formatter — "$1.2M" / "$340k" / "$8,200" / "−$1.5k". Local
 * copy because panel.js's `_formatCompactCurrency` is file-scoped to that
 * module; duplicating ten lines beats coupling to panel internals.
 */
function _formatCompactCurrency(v) {
    const n = Number(v)
    if (!isFinite(n)) return "—"
    const sign = n < 0 ? "−" : ""
    const abs = Math.abs(n)
    if (abs >= 1e6) return sign + "$" + (Math.round(abs / 1e5) / 10) + "M"
    if (abs >= 1e4) return sign + "$" + Math.round(abs / 1e3) + "k"
    if (abs >= 1e3) return sign + "$" + (Math.round(abs / 100) / 10) + "k"
    return sign + "$" + Math.round(abs).toLocaleString()
}
