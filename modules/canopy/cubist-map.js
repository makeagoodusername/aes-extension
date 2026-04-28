"use strict"

/**
 * AESCubistMap — CB4 (FACET overhaul · Voronoi-style network map).
 *
 * Renders a hub's network as a radial Cubist composition: hub at center
 * (large oxide pentagon), top destinations as wedge facets fanning outward
 * to a cell ring, route lines connecting center to each wedge, demand
 * contours drawn as concentric dotted arcs, and competitor presence shown
 * as small rust hatching dots inside each wedge.
 *
 * Per the plan, CB4's "true canopy" version is gated on Letter L7 (combined
 * supply across kin airlines). This shipping form is the **per-hub stub**:
 * one hub picker, one metric toggle, four metrics (score / profit / ORS /
 * pax-demand). When L7 lands, the renderer swaps `_loadHubs()` for a kin-
 * aggregated source and the metric set extends with kin-share + gap.
 *
 * The map itself is SVG (so arcs and lines render cleanly across viewports);
 * the chrome (hub picker, metric chips) is HTML-on-bone.
 *
 * Registers as a Central Hub tile in the "routes" section so it surfaces
 * alongside the Route Assistant tile and the Polyhedral Route Card. Reads
 * only `routeAssistant:topRoutes:<HUB>` — no scrapes, no writes.
 */
class CentralHubCubistMapTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "cubist-map"
        this.title = "Cubist Map"
        this.section = "routes"
        this.priority = 50
        this.requiresAirline = false
        this._metric = "score"
        this._selectedHub = null
    }

    watchedStorageKeys() { return ["routeAssistant:topRoutes:"] }

    async _loadHubs() {
        const entries = await this._loadByPrefix("routeAssistant:topRoutes")
        const out = []
        for (const e of entries) {
            if (e.suffix.indexOf(":") >= 0) continue
            if (!e.suffix || !e.value) continue
            if (!Array.isArray(e.value.rows) || !e.value.rows.length) continue
            out.push({hub: e.suffix, record: e.value})
        }
        out.sort((a, b) => (b.record.snapshotAt || 0) - (a.record.snapshotAt || 0))
        return out
    }

    async loadStatus() {
        const hubs = await this._loadHubs()
        if (!hubs.length) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "Cubist Map needs at least one hub's topRoutes snapshot."
            }
        }
        return {
            badge: hubs.length + " HUBS",
            badgeKind: window.CentralHubStatusBadges.KIND.INFO,
            summary: "Cubist Map · radial Voronoi-style view of any hub's network."
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""

        const hubs = await this._loadHubs()
        if (!hubs.length) {
            this._renderEmptyState(host,
                "Visit a /app/com/scheduling/<HUB> page to seed topRoutes.")
            return
        }

        if (!this._selectedHub || !hubs.find(h => h.hub === this._selectedHub)) {
            this._selectedHub = hubs[0].hub
        }

        host.appendChild(this._buildControls(hubs, T))

        const canvasWrap = document.createElement("div")
        canvasWrap.style.cssText = [
            "position:relative",
            "width:100%",
            "min-height:480px",
            "background:" + T.color.bone2,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "margin-top:" + T.sp[2],
            "overflow:hidden",
            "box-sizing:border-box"
        ].join(";")
        host.appendChild(canvasWrap)

        const hubInfo = hubs.find(h => h.hub === this._selectedHub) || hubs[0]
        this._renderMap(canvasWrap, hubInfo, T)

        host.appendChild(this._buildLegend(T))
    }

    _buildControls(hubs, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "align-items:center",
            "gap:" + T.sp[2]
        ].join(";")

        const hubLabel = document.createElement("span")
        hubLabel.textContent = "HUB"
        hubLabel.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.display
            + ";text-transform:uppercase;letter-spacing:" + T.track.caps
            + ";font-size:" + T.fs.micro + ";"
        wrap.appendChild(hubLabel)

        const select = document.createElement("select")
        select.style.cssText = "background:" + T.color.bone + ";color:" + T.color.oxide
            + ";border:" + T.geom.bw1 + " solid " + T.color.oxide
            + ";padding:" + T.sp[1] + " " + T.sp[2]
            + ";font-family:" + T.font.mono + ";font-size:" + T.fs.body
            + ";letter-spacing:" + T.track.mono + ";"
        for (const h of hubs) {
            const opt = document.createElement("option")
            opt.value = h.hub
            opt.textContent = h.hub
            if (h.hub === this._selectedHub) opt.selected = true
            select.appendChild(opt)
        }
        select.addEventListener("change", () => {
            this._selectedHub = select.value
            this.refresh()
        })
        wrap.appendChild(select)

        const sep = document.createElement("span")
        sep.textContent = "·"
        sep.style.cssText = "color:" + T.color.slate + ";margin:0 " + T.sp[1] + ";"
        wrap.appendChild(sep)

        const metricLabel = document.createElement("span")
        metricLabel.textContent = "METRIC"
        metricLabel.style.cssText = hubLabel.style.cssText
        wrap.appendChild(metricLabel)

        const metrics = [
            {id: "score",  label: "Score"},
            {id: "profit", label: "Profit"},
            {id: "ors",    label: "ORS"},
            {id: "pax",    label: "Pax"}
        ]
        for (const m of metrics) {
            const chip = document.createElement("button")
            chip.type = "button"
            chip.textContent = m.label
            const active = this._metric === m.id
            chip.style.cssText = [
                "background:" + (active ? T.color.oxide : T.color.bone),
                "color:"      + (active ? T.color.bone  : T.color.oxide),
                "border:" + T.geom.bw1 + " solid " + T.color.oxide,
                "padding:" + T.sp[1] + " " + T.sp[2],
                "font-family:" + T.font.display,
                "font-size:" + T.fs.small,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "cursor:pointer"
            ].join(";")
            chip.addEventListener("click", () => {
                this._metric = m.id
                this.refresh()
            })
            wrap.appendChild(chip)
        }

        return wrap
    }

    _renderMap(canvas, hubInfo, T) {
        canvas.innerHTML = ""
        const hub = hubInfo.hub
        const rows = (hubInfo.record.rows || []).slice()
        if (!rows.length) {
            canvas.textContent = "No routes in snapshot."
            return
        }
        rows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))

        const W = 800, H = 480
        const cx = W / 2, cy = H / 2
        const innerR = 64, outerR = 220

        const NS = "http://www.w3.org/2000/svg"
        const svg = document.createElementNS(NS, "svg")
        svg.setAttribute("viewBox", "0 0 " + W + " " + H)
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet")
        svg.style.cssText = "display:block;width:100%;height:100%;"

        // Demand-contour layer — three concentric dotted arcs.
        for (let i = 1; i <= 3; i++) {
            const r = innerR + i * ((outerR - innerR) / 3)
            const arc = document.createElementNS(NS, "circle")
            arc.setAttribute("cx", cx)
            arc.setAttribute("cy", cy)
            arc.setAttribute("r",  r)
            arc.setAttribute("fill", "none")
            arc.setAttribute("stroke", "#7A6F66") // slate literal
            arc.setAttribute("stroke-dasharray", "1,4")
            arc.setAttribute("stroke-width", "1")
            arc.setAttribute("opacity", "0.6")
            svg.appendChild(arc)
        }

        const N = Math.min(rows.length, 14)
        const segs = 16
        const PAD = 0.035

        for (let i = 0; i < N; i++) {
            const row = rows[i]
            const a0 = (i / N) * 2 * Math.PI - Math.PI / 2
            const a1 = ((i + 1) / N) * 2 * Math.PI - Math.PI / 2
            const aMid = (a0 + a1) / 2

            // Wedge polygon — Voronoi-cell stand-in for this destination.
            const points = []
            for (let j = 0; j <= segs; j++) {
                const a = a0 + PAD + (a1 - a0 - 2 * PAD) * j / segs
                points.push((cx + Math.cos(a) * innerR).toFixed(1)
                    + "," + (cy + Math.sin(a) * innerR).toFixed(1))
            }
            for (let j = segs; j >= 0; j--) {
                const a = a0 + PAD + (a1 - a0 - 2 * PAD) * j / segs
                points.push((cx + Math.cos(a) * outerR).toFixed(1)
                    + "," + (cy + Math.sin(a) * outerR).toFixed(1))
            }
            const wedge = document.createElementNS(NS, "polygon")
            wedge.setAttribute("points", points.join(" "))
            wedge.setAttribute("fill",   this._metricFill(row, T))
            wedge.setAttribute("stroke", "#2B2520") // oxide literal
            wedge.setAttribute("stroke-width", "1")
            wedge.style.cursor = "pointer"
            wedge.addEventListener("click", () => {
                if (!window.CentralHubBus) return
                window.CentralHubBus.emit("focus-route", {
                    hub, dest: row.destIata, source: "cubist-map"
                })
                window.CentralHubBus.emit("open-tile", {
                    tileId: "inventory",
                    expand: true, scrollIntoView: true,
                    filter: {type: "single-route", hub, dest: row.destIata},
                    source: "cubist-map"
                })
            })
            const titleEl = document.createElementNS(NS, "title")
            titleEl.textContent = (row.destIata || "?")
                + " · score " + (row.score != null ? Math.round(row.score) : "—")
                + (row.profitPerWeek != null
                    ? " · " + this._formatProfit(row.profitPerWeek) + "/wk" : "")
            wedge.appendChild(titleEl)
            svg.appendChild(wedge)

            // Route line — center to wedge edge.
            const line = document.createElementNS(NS, "line")
            line.setAttribute("x1", cx)
            line.setAttribute("y1", cy)
            line.setAttribute("x2", (cx + Math.cos(aMid) * (innerR + 2)).toFixed(1))
            line.setAttribute("y2", (cy + Math.sin(aMid) * (innerR + 2)).toFixed(1))
            line.setAttribute("stroke", "#2B2520")
            line.setAttribute("stroke-width", "1.2")
            line.setAttribute("opacity", "0.6")
            svg.appendChild(line)

            // Destination IATA label outside the wedge.
            const lblR = outerR + 16
            const label = document.createElementNS(NS, "text")
            label.setAttribute("x", (cx + Math.cos(aMid) * lblR).toFixed(1))
            label.setAttribute("y", (cy + Math.sin(aMid) * lblR).toFixed(1))
            label.setAttribute("text-anchor", "middle")
            label.setAttribute("dominant-baseline", "central")
            label.setAttribute("font-family", "JetBrains Mono, monospace")
            label.setAttribute("font-size", "11")
            label.setAttribute("font-weight", "700")
            label.setAttribute("fill", "#2B2520")
            label.textContent = row.destIata || "?"
            svg.appendChild(label)

            // Competitor hatch — small rust dot cluster inside the wedge.
            const cmp = Number(row.competitors ?? row.competitorCount ?? row.cmpCount)
            if (Number.isFinite(cmp) && cmp > 0) {
                const dotR = (innerR + outerR) / 2
                const draw = Math.min(cmp, 5)
                for (let d = 0; d < draw; d++) {
                    const off = (d - (draw - 1) / 2) * 5
                    const dx = cx + Math.cos(aMid) * dotR
                        + Math.cos(aMid + Math.PI / 2) * off
                    const dy = cy + Math.sin(aMid) * dotR
                        + Math.sin(aMid + Math.PI / 2) * off
                    const dot = document.createElementNS(NS, "circle")
                    dot.setAttribute("cx", dx.toFixed(1))
                    dot.setAttribute("cy", dy.toFixed(1))
                    dot.setAttribute("r", "1.6")
                    dot.setAttribute("fill", "#B8472A") // rust
                    dot.setAttribute("opacity", "0.85")
                    svg.appendChild(dot)
                }
            }
        }

        // Hub center disk + IATA label.
        const hubCircle = document.createElementNS(NS, "circle")
        hubCircle.setAttribute("cx", cx)
        hubCircle.setAttribute("cy", cy)
        hubCircle.setAttribute("r",  innerR - 6)
        hubCircle.setAttribute("fill", "#2B2520")
        hubCircle.setAttribute("stroke", "#2B2520")
        hubCircle.setAttribute("stroke-width", "2")
        svg.appendChild(hubCircle)

        const hubLabel = document.createElementNS(NS, "text")
        hubLabel.setAttribute("x", cx)
        hubLabel.setAttribute("y", cy)
        hubLabel.setAttribute("text-anchor", "middle")
        hubLabel.setAttribute("dominant-baseline", "central")
        hubLabel.setAttribute("font-family", "JetBrains Mono, monospace")
        hubLabel.setAttribute("font-size", "20")
        hubLabel.setAttribute("font-weight", "900")
        hubLabel.setAttribute("fill", "#F4F1EA")
        hubLabel.textContent = String(hub).slice(0, 4)
        svg.appendChild(hubLabel)

        // Snapshot stamp.
        const ts = hubInfo.record.snapshotAt
        if (ts) {
            const stamp = document.createElementNS(NS, "text")
            stamp.setAttribute("x", W - 10)
            stamp.setAttribute("y", H - 8)
            stamp.setAttribute("text-anchor", "end")
            stamp.setAttribute("font-family", "JetBrains Mono, monospace")
            stamp.setAttribute("font-size", "9")
            stamp.setAttribute("fill", "#7A6F66")
            stamp.textContent = "snap · " + new Date(ts).toISOString().substring(0, 10)
            svg.appendChild(stamp)
        }

        canvas.appendChild(svg)
    }

    _buildLegend(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "gap:" + T.sp[3],
            "margin-top:" + T.sp[2],
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "color:" + T.color.oxide2,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase"
        ].join(";")
        const items = [
            "wedges · per-destination cells",
            "··· · demand contours",
            "● · competitor presence",
            "L7 will swap to canopy aggregation"
        ]
        for (const t of items) {
            const span = document.createElement("span")
            span.textContent = t
            wrap.appendChild(span)
        }
        return wrap
    }

    _metricFill(row, T) {
        switch (this._metric) {
            case "score": {
                const v = Number(row.score)
                if (!Number.isFinite(v)) return T.color.bone3
                return v >= 80 ? T.color.viridianSoft
                     : v >= 50 ? T.color.amberSoft
                     : T.color.crimsonSoft
            }
            case "profit": {
                const v = Number(row.profitPerWeek)
                if (!Number.isFinite(v)) return T.color.bone3
                return v >  0 ? T.color.mossSoft
                     : v <  0 ? T.color.crimsonSoft
                     : T.color.bone3
            }
            case "ors": {
                const v = Number(row.orsRank ?? row.rankAny)
                if (!Number.isFinite(v)) return T.color.bone3
                return v <= 2 ? T.color.viridianSoft
                     : v <= 4 ? T.color.amberSoft
                     : T.color.crimsonSoft
            }
            case "pax": {
                const v = Number(row.paxScore)
                if (!Number.isFinite(v)) return T.color.bone3
                return v >= 7 ? T.color.cobaltSoft
                     : v >= 4 ? T.color.cobaltSoft
                     : T.color.bone3
            }
        }
        return T.color.bone3
    }

    _formatProfit(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return "—"
        const sign = n < 0 ? "-" : ""
        const abs = Math.abs(n)
        if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B"
        if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M"
        if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "k"
        return sign + "$" + Math.round(abs)
    }
}

if (typeof window !== "undefined") {
    window.CentralHubCubistMapTile = CentralHubCubistMapTile
    if (window.CentralHubTileRegistry) {
        window.CentralHubTileRegistry.register({
            id: "cubist-map",
            section: "routes",
            priority: 50,
            factory: () => new CentralHubCubistMapTile()
        })
    }
}
