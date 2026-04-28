"use strict"

/**
 * Competitor Outline tile — single-view rival intel + counter-aircraft.
 *
 * Surfaces the threat scoreboard summary in the Central Hub and opens a
 * full-screen outline panel where the user can scan every tracked rival's
 * routes, prices, fleet composition, ORS, and our recommended counter-
 * aircraft for each lane.
 *
 * Data is computed on-demand by `AesCompetitorOutlineAggregator.build()`,
 * which joins the four competitor-data stores. The tile body shows a
 * preview (top-3 threats), so the user can decide whether the panel is
 * worth opening.
 */
class CentralHubCompetitorOutlineTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "competitor-outline"
        this.title = "Outline"
        this.section = "routes"
        this.priority = 35
        this.requiresAirline = false
        this._cachedOutline = null
        this._lastBuildAt = 0
    }

    watchedStorageKeys() {
        return [
            "competitorIntel:enterprise:",
            "competitorIntel:edge:",
            "routeAssistant:markets:competitors:",
            "routeAssistant:ors:"
        ]
    }

    openHandler() {
        return (ctx) => {
            const server = (ctx && ctx.server) || ""
            if (typeof window.AesCompetitorOutlinePanel === "undefined") {
                console.warn("[AES competitor-outline] panel module missing")
                return
            }
            window.AesCompetitorOutlinePanel.show({server: server})
        }
    }

    async _ensureOutline(ctx) {
        const now = Date.now()
        if (this._cachedOutline && (now - this._lastBuildAt) < 30000) {
            return this._cachedOutline
        }
        const server = (ctx && ctx.server) || ""
        if (!server || typeof window.AesCompetitorOutlineAggregator === "undefined") {
            return null
        }
        try {
            this._cachedOutline = await window.AesCompetitorOutlineAggregator.build({server})
            this._lastBuildAt = Date.now()
            return this._cachedOutline
        } catch (e) {
            console.warn("[AES competitor-outline] tile aggregator failed", e)
            return null
        }
    }

    async loadStatus(ctx) {
        const outline = await this._ensureOutline(ctx)
        const Kind = window.CentralHubStatusBadges.KIND
        if (!outline || !outline.competitors.length) {
            return {
                badge:     "0",
                badgeKind: Kind.MUTED,
                summary:   "No outline data yet. Open a competitor profile or hit Refresh."
            }
        }
        const threats = outline.competitors.filter(c => (c.summary.threatScore || 0) > 0).length
        const open = outline.uncontested
        return {
            badge:     String(threats),
            badgeKind: threats > 0 ? Kind.WARN : Kind.OK,
            summary:   threats + " threat" + (threats === 1 ? "" : "s")
                + " · " + outline.competitors.length + " rivals"
                + " · " + outline.totalRoutes + " routes"
                + (open > 0 ? " · " + open + " open lanes" : "")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const outline = await this._ensureOutline(ctx)
        if (!outline || !outline.competitors.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "No competitors aggregated yet. Visit a competitor's profile (e.g. /app/info/enterprises/<id>) to seed data, then click \"Open →\" to see the full outline."
            host.appendChild(empty)
            return
        }

        const intro = document.createElement("p")
        intro.style.cssText = "margin:0 0 " + T.sp[2] + " 0;color:" + T.color.oxide2 + ";"
        intro.textContent = "Top threats — open the panel for routes, prices, fleet age, ORS, and counter-aircraft."
        host.appendChild(intro)

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
        const top = outline.competitors
            .slice()
            .sort((a, b) => (b.summary.threatScore || 0) - (a.summary.threatScore || 0))
            .slice(0, 3)
        for (const c of top) {
            list.appendChild(this._buildPreviewRow(c, T))
        }
        host.appendChild(list)

        if (outline.competitors.length > 3) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (outline.competitors.length - 3) + " more rivals — Open → for the full outline."
            host.appendChild(more)
        }
    }

    _buildPreviewRow(c, T) {
        const row = document.createElement("div")
        row.style.cssText = [
            "display:flex", "align-items:baseline",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body
        ].join(";")
        const name = document.createElement("strong")
        name.textContent = (c.code ? "[" + c.code + "] " : "") + c.name
        name.style.cssText = "color:" + T.color.oxide + ";flex:0 0 auto;font-family:" + T.font.display + ";"
        const stats = document.createElement("span")
        stats.style.cssText = "color:" + T.color.slate + ";flex:1 1 auto;"
        const partsStats = []
        partsStats.push("threat " + c.summary.threatScore)
        partsStats.push(c.summary.totalRoutes + " routes")
        partsStats.push(c.summary.totalWeeklyFlights + " flights/wk")
        if (c.summary.counterableRoutes > 0)  partsStats.push(c.summary.counterableRoutes + " counterable")
        if (c.summary.uncontestedRoutes > 0)  partsStats.push(c.summary.uncontestedRoutes + " open")
        if (c.summary.weAlreadyWinRoutes > 0) partsStats.push(c.summary.weAlreadyWinRoutes + " we lead")
        stats.textContent = partsStats.join(" · ")
        row.append(name, stats)
        return row
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "competitor-outline",
        section: "routes",
        priority: 35,
        factory: () => new CentralHubCompetitorOutlineTile()
    })
}
