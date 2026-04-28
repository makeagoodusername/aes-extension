"use strict"

/**
 * Route Assistant tile — top routes across all known hubs.
 *
 * Reads `routeAssistant:topRoutes:<HUB>` snapshots auto-published by the
 * Route Assistant panel on /app/com/scheduling*. The hub doesn't run RA
 * itself; it surfaces what RA has already cached and routes the user to
 * the scheduling page where the panel mounts and a real refresh happens.
 */
class CentralHubRouteAssistantTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "route-assistant"
        this.title = "Route Assistant"
        this.section = "routes"
        this.priority = 10
        this.requiresAirline = false
    }

    watchedStorageKeys() { return ["routeAssistant:topRoutes:"] }

    openHref() { return "/app/com/scheduling" }

    async _loadHubs() {
        const entries = await this._loadByPrefix("routeAssistant:topRoutes")
        const out = []
        for (const e of entries) {
            // Skip ":perClass:" companion snapshots and any deeper-keyed siblings.
            if (e.suffix.indexOf(":") >= 0) continue
            if (!e.suffix || !e.value) continue
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
                summary: "No top-routes cached. Open /app/com/scheduling/<HUB> to seed."
            }
        }
        const totalRows = hubs.reduce(
            (acc, h) => acc + ((h.record.rows && h.record.rows.length) || 0), 0)
        const newest = hubs[0].record.snapshotAt
            ? new Date(hubs[0].record.snapshotAt).toISOString().substring(0, 10)
            : ""
        return {
            badge: hubs.length + " HUBS",
            badgeKind: window.CentralHubStatusBadges.KIND.OK,
            summary: totalRows + " scored routes across " + hubs.length + " hub"
                + (hubs.length === 1 ? "" : "s") + (newest ? " · refreshed " + newest : "")
        }
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        host.textContent = ""

        // CH-5d-2: pin the filter on the instance so a storage refresh keeps it.
        if (focusFilter && focusFilter.type === "fired-alerts") {
            this._filter = "fired-alerts"
        }

        const hubs = await this._loadHubs()
        if (!hubs.length) {
            this._renderEmptyState(host, "Visit a /app/com/scheduling/<HUB> page (e.g. ATL) to publish a topRoutes snapshot.")
            return
        }

        if (this._filter === "fired-alerts") {
            const firedKeys = await this._loadFiredAlertRoutes()
            host.appendChild(this._renderFilterBanner(firedKeys.size, T))
            if (!firedKeys.size) {
                this._renderEmptyState(host, "No alert rules fired in the last 24 h.", {marginTop: T.sp[2]})
                return
            }
            const filteredHubs = hubs
                .map(h => ({
                    hub: h.hub,
                    record: Object.assign({}, h.record, {
                        rows: (h.record.rows || []).filter(r =>
                            firedKeys.has(h.hub + "-" + (r.destIata || r.dest)))
                    })
                }))
                .filter(h => h.record.rows && h.record.rows.length)

            if (!filteredHubs.length) {
                this._renderEmptyState(host,
                    firedKeys.size + " fired route"
                        + (firedKeys.size === 1 ? "" : "s") + " — none in cached topRoutes snapshots.",
                    {marginTop: T.sp[2]})
                return
            }
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[3] + ";"
            for (const h of filteredHubs) wrap.appendChild(this._renderHub(h, T))
            host.appendChild(wrap)
            return
        }

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[3] + ";"

        for (const h of hubs.slice(0, 3)) {
            wrap.appendChild(this._renderHub(h, T))
        }
        host.appendChild(wrap)

        if (hubs.length > 3) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (hubs.length - 3) + " more hubs cached."
            host.appendChild(more)
        }
    }

    /**
     * Walks every persisted alert-rule record (legacy + acct-namespaced) and
     * collects the route-keys (`<HUB>-<DEST>`) whose lastFiredByRoute
     * timestamp lands in the trailing 24 h.
     */
    async _loadFiredAlertRoutes() {
        const entries = await this._loadByPrefix("routeAssistant:alertRules", {includeExactKey: true})
        const cutoff = Date.now() - 24 * 3600 * 1000
        const fired = new Set()
        for (const e of entries) {
            const rec = e.value
            if (!rec || !Array.isArray(rec.rules)) continue
            for (const rule of rec.rules) {
                if (!rule || rule.enabled === false) continue
                const map = rule.lastFiredByRoute
                if (!map || typeof map !== "object") continue
                for (const route in map) {
                    const t = Number(map[route])
                    if (Number.isFinite(t) && t >= cutoff) fired.add(route)
                }
            }
        }
        return fired
    }

    _renderFilterBanner(count, T) {
        const banner = document.createElement("div")
        banner.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "margin-bottom:" + T.sp[2],
            "background:" + T.color.amberSoft,
            "color:" + T.color.amber,
            "border:" + T.geom.bw1 + " solid " + T.color.amber,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body
        ].join(";")
        const label = document.createElement("span")
        label.textContent = count + " alert" + (count === 1 ? "" : "s")
            + " fired in the last 24 h"
        const clear = document.createElement("button")
        clear.type = "button"
        clear.textContent = "× show all routes"
        clear.style.cssText = "background:transparent;color:" + T.color.amber
            + ";border:" + T.geom.bw1 + " solid " + T.color.amber + ";border-radius:" + T.geom.radius
            + ";padding:" + T.sp[0] + " " + T.sp[2] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        clear.addEventListener("click", () => {
            this._filter = null
            this._renderBodySafe()
        })
        banner.append(label, clear)
        return banner
    }

    _renderHub(hubInfo, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "border:" + T.geom.bw1 + " solid " + T.color.paperRule
            + ";padding:" + T.sp[2] + " " + T.sp[3] + ";background:" + T.color.bone2 + ";"

        const heading = document.createElement("div")
        heading.style.cssText = [
            "display:flex",
            "justify-content:space-between",
            "align-items:baseline",
            "margin-bottom:" + T.sp[1],
            "font-family:" + T.font.display
        ].join(";")
        const hubName = document.createElement("span")
        hubName.style.cssText = "font-weight:" + T.fw.display + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;color:" + T.color.oxide + ";"
        hubName.textContent = hubInfo.hub
        const link = document.createElement("a")
        link.href = "/app/com/scheduling/" + encodeURIComponent(hubInfo.hub) + encodeURIComponent(hubInfo.hub)
        link.textContent = "Open scheduling →"
        link.style.cssText = "color:" + T.color.rust + ";font-size:" + T.fs.body + ";text-decoration:none;"
        heading.append(hubName, link)
        wrap.appendChild(heading)

        const rows = (hubInfo.record.rows || []).slice(0, 5)
        if (!rows.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Snapshot has no rows."
            wrap.appendChild(empty)
            return wrap
        }

        // CB3 — branch to polyhedral cards when cubist mode is active.
        if (CentralHubRouteAssistantTile._isCubist()) {
            wrap.appendChild(this._renderRoutePolyhedronGrid(rows, hubInfo, T))
            return wrap
        }

        const list = document.createElement("ol")
        list.style.cssText = "margin:0;padding:0 0 0 " + T.sp[4] + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.body + ";letter-spacing:" + T.track.mono + ";"
        for (const r of rows) {
            const li = document.createElement("li")
            const dest = r.destIata || r.dest || "?"
            const score = (r.score != null) ? Math.round(r.score) : "—"
            const flights = r.flights || r.weeklyFlights || ""
            li.textContent = dest + " · score " + score + (flights ? " · " + flights + "/wk" : "")
            li.style.color = T.color.oxide2
            li.style.cursor = "pointer"
            li.addEventListener("mouseenter", () => { li.style.color = T.color.rust })
            li.addEventListener("mouseleave", () => { li.style.color = T.color.oxide2 })
            li.addEventListener("click", () => {
                if (!window.CentralHubBus) return
                const payload = {hub: hubInfo.hub, dest, source: "route-assistant"}
                window.CentralHubBus.emit("focus-route", payload)
                window.CentralHubBus.emit("open-tile", {
                    tileId: "inventory",
                    expand: true, scrollIntoView: true,
                    filter: {type: "single-route", hub: hubInfo.hub, dest},
                    source: "route-assistant"
                })
            })
            list.appendChild(li)
        }
        wrap.appendChild(list)
        return wrap
    }

    // ── CB3 — Polyhedral route cards ─────────────────────────────────────
    //
    // Replaces the orthogonal <ol> with a grid of hexagonal polyhedra. Each
    // route becomes a 6-facet card: demand (wedge-tl), profit (trapezoid-t),
    // ORS (wedge-tr), competitor (wedge-bl), pax-mix (trapezoid-b), schedule
    // (wedge-br). Hover dims adjacent facets via cubist.css; click any facet
    // emits focus-route + open-tile (inventory) on the bus, identical to the
    // orthogonal-mode click target.
    //
    // Reuses only fields already present on `topRoutes:<HUB>` rows. No extra
    // storage reads — perf safe at the 3-hubs × 5-routes density the tile
    // exposes (15 polyhedra × 6 facets = 90 clip-pathed nodes per render).

    static _isCubist() {
        try {
            return typeof document !== "undefined"
                && document.body && document.body.classList
                && document.body.classList.contains("aes-cubist")
                && !!window.AESCubistPrimitives
        } catch (_) { return false }
    }

    _renderRoutePolyhedronGrid(rows, hubInfo, T) {
        const grid = document.createElement("div")
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(auto-fill, minmax(200px, 1fr))",
            "gap:" + T.sp[2],
            "margin-top:" + T.sp[1]
        ].join(";")
        for (const r of rows) {
            grid.appendChild(this._renderRoutePolyhedron(r, hubInfo, T))
        }
        return grid
    }

    _renderRoutePolyhedron(row, hubInfo, T) {
        const P = window.AESCubistPrimitives
        const dest = row.destIata || row.dest || "?"
        const onClick = () => {
            if (!window.CentralHubBus) return
            const payload = {hub: hubInfo.hub, dest, source: "route-assistant"}
            window.CentralHubBus.emit("focus-route", payload)
            window.CentralHubBus.emit("open-tile", {
                tileId: "inventory",
                expand: true, scrollIntoView: true,
                filter: {type: "single-route", hub: hubInfo.hub, dest},
                source: "route-assistant"
            })
        }

        const facets = [
            this._buildDemandFacet(row, T),
            this._buildProfitFacet(row, dest, T),
            this._buildOrsFacet(row, T),
            this._buildCompetitorFacet(row, T),
            this._buildPaxMixFacet(row, T),
            this._buildScheduleFacet(row, T)
        ]
        for (const f of facets) {
            f.style.cursor = "pointer"
            f.addEventListener("click", (e) => { e.preventDefault(); onClick() })
        }

        const poly = P.Polyhedron({
            entity: "route:" + hubInfo.hub + "-" + dest,
            facets: facets,
            pivot: true,
            density: "compact",
            layout: "repeat(2, minmax(48px, auto)) / repeat(3, 1fr)"
        })
        poly.style.cssText += [
            ";gap:" + T.geom.bw1,
            "background:" + T.color.oxide,
            "border:" + T.geom.bw2 + " solid " + T.color.oxide,
            "min-height:120px"
        ].join(";")
        return poly
    }

    _buildDemandFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-start")
        inner.appendChild(P.Stencil({text: "Demand"}))
        const score = Number(row.paxScore ?? row.score)
        const filled = Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score))) : 0
        const bar = document.createElement("div")
        bar.style.cssText = "display:flex;gap:1px;width:100%;margin-top:" + T.sp[1]
        for (let i = 0; i < 10; i++) {
            const cell = document.createElement("span")
            cell.style.cssText = "flex:1 1 0;height:6px;background:"
                + (i < filled ? T.color.cobalt : T.color.bone3)
            bar.appendChild(cell)
        }
        inner.appendChild(bar)
        return this._frameFacet(P.Facet({
            shape: "wedge-tl", perspective: "demand", content: inner
        }), T)
    }

    _buildProfitFacet(row, dest, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "center")
        const destLabel = document.createElement("div")
        destLabel.textContent = dest
        destLabel.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide,
            "line-height:" + T.lh.tight
        ].join(";")
        const profit = Number(row.profitPerWeek)
        const profitEl = document.createElement("div")
        if (Number.isFinite(profit)) {
            const sign = profit >= 0 ? "" : "-"
            const abs = Math.abs(profit)
            const compact = abs >= 1e9 ? (abs / 1e9).toFixed(2) + "B"
                : abs >= 1e6 ? (abs / 1e6).toFixed(2) + "M"
                : abs >= 1e3 ? (abs / 1e3).toFixed(1) + "k"
                : Math.round(abs)
            profitEl.textContent = sign + "$" + compact + "/wk"
            profitEl.style.color = profit >= 0 ? T.color.moss : T.color.crimson
        } else {
            profitEl.textContent = "— /wk"
            profitEl.style.color = T.color.slate
        }
        profitEl.style.cssText += [
            ";font-family:" + T.font.mono,
            "font-size:" + T.fs.small,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono
        ].join(";")
        inner.append(destLabel, profitEl)
        return this._frameFacet(P.Facet({
            shape: "trapezoid-t", perspective: "profit", content: inner
        }), T, /*emphasis*/ true)
    }

    _buildOrsFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-end")
        inner.appendChild(P.Stencil({text: "ORS"}))
        const rank = row.orsRank ?? row.rankAny
        const value = document.createElement("div")
        value.textContent = (rank == null) ? "—" : "#" + Math.round(Number(rank))
        const rankColor = !Number.isFinite(Number(rank)) ? T.color.slate
            : Number(rank) <= 2 ? T.color.moss
            : Number(rank) <= 4 ? T.color.amber
            : T.color.crimson
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + rankColor,
            "margin-top:" + T.sp[1]
        ].join(";")
        inner.appendChild(value)
        return this._frameFacet(P.Facet({
            shape: "wedge-tr", perspective: "ors", content: inner
        }), T)
    }

    _buildCompetitorFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-start")
        inner.appendChild(P.Stencil({text: "Cmpt"}))
        const count = Number(row.competitors ?? row.competitorCount ?? row.cmpCount)
        const value = document.createElement("div")
        value.textContent = Number.isFinite(count) ? String(count) : "—"
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide
        ].join(";")
        const dots = document.createElement("div")
        dots.style.cssText = "display:flex;gap:2px;margin-top:" + T.sp[1] + ";flex-wrap:wrap"
        const drawDots = Number.isFinite(count) ? Math.min(count, 8) : 0
        for (let i = 0; i < drawDots; i++) {
            const dot = document.createElement("span")
            dot.style.cssText = "width:5px;height:5px;background:" + T.color.rust
                + ";display:inline-block"
            dots.appendChild(dot)
        }
        inner.append(value, dots)
        return this._frameFacet(P.Facet({
            shape: "wedge-bl", perspective: "competitors", content: inner
        }), T)
    }

    _buildPaxMixFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "center")
        inner.appendChild(P.Stencil({text: "Pax mix"}))
        // Y/C/F slivers as diagonal stripes — width-weighted by mix percent.
        const y = Number(row.yShare ?? row.paxShareY)
        const c = Number(row.cShare ?? row.paxShareC)
        const f = Number(row.fShare ?? row.paxShareF)
        const known = [y, c, f].some(v => Number.isFinite(v))
        const stripes = document.createElement("div")
        stripes.style.cssText = "display:flex;width:100%;height:10px;margin-top:" + T.sp[1]
        if (known) {
            const total = (Number.isFinite(y) ? y : 0)
                + (Number.isFinite(c) ? c : 0)
                + (Number.isFinite(f) ? f : 0)
            const mk = (frac, color) => {
                const s = document.createElement("span")
                const pct = total > 0 ? Math.max(0, frac / total * 100) : 0
                s.style.cssText = "flex:" + Math.max(0.001, pct).toFixed(2)
                    + " 0 0;background:" + color
                    + ";clip-path:polygon(8% 0, 100% 0, 92% 100%, 0 100%)"
                stripes.appendChild(s)
            }
            mk(Number.isFinite(y) ? y : 0, T.color.cobalt)
            mk(Number.isFinite(c) ? c : 0, T.color.amber)
            mk(Number.isFinite(f) ? f : 0, T.color.rust)
        } else {
            const note = document.createElement("span")
            note.textContent = "—"
            note.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono
                + ";font-size:" + T.fs.micro
            stripes.appendChild(note)
        }
        inner.appendChild(stripes)
        return this._frameFacet(P.Facet({
            shape: "trapezoid-b", perspective: "pax-mix", content: inner
        }), T)
    }

    _buildScheduleFacet(row, T) {
        const P = window.AESCubistPrimitives
        const inner = document.createElement("div")
        inner.style.cssText = this._facetInnerCss(T, "flex-end")
        inner.appendChild(P.Stencil({text: "Sched"}))
        const flights = Number(row.flights ?? row.weeklyFlights)
        const value = document.createElement("div")
        value.textContent = Number.isFinite(flights) ? flights + "×" : "—"
        value.style.cssText = [
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.lead,
            "font-weight:" + T.fw.display,
            "letter-spacing:" + T.track.mono,
            "color:" + T.color.oxide
        ].join(";")
        // Mini radial sweep — quarter arc with N tick marks for flights/wk.
        const arc = document.createElement("div")
        arc.style.cssText = "position:relative;width:100%;height:14px;margin-top:" + T.sp[1]
            + ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
        const ticks = Number.isFinite(flights) ? Math.min(flights, 14) : 0
        for (let i = 0; i < ticks; i++) {
            const t = document.createElement("span")
            t.style.cssText = "position:absolute;left:" + ((i + 0.5) / 14 * 100) + "%"
                + ";bottom:0;width:1px;height:" + (4 + (i % 3) * 2) + "px"
                + ";background:" + T.color.viridian
            arc.appendChild(t)
        }
        inner.append(value, arc)
        return this._frameFacet(P.Facet({
            shape: "wedge-br", perspective: "schedule", content: inner
        }), T)
    }

    _facetInnerCss(T, justify) {
        return [
            "display:flex",
            "flex-direction:column",
            "justify-content:" + (justify || "flex-start"),
            "gap:2px",
            "padding:" + T.sp[2],
            "min-height:48px",
            "box-sizing:border-box",
            "width:100%"
        ].join(";")
    }

    _frameFacet(facet, T, emphasis) {
        facet.style.cssText += [
            ";background:" + (emphasis ? T.color.bone : T.color.bone2),
            "color:" + T.color.oxide
        ].join(";")
        return facet
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "route-assistant",
        section: "routes",
        priority: 10,
        factory: () => new CentralHubRouteAssistantTile()
    })
}
