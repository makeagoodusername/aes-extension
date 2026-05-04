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
        this._cacheKey = ""
    }

    watchedStorageKeys(ctx) {
        const server = String(ctx && ctx.server || "")
        const airline = this._airlineKey(ctx)
        const keys = [
            "competitorIntel:enterprise:",
            "competitorIntel:edge:",
            "routeAssistant:markets:competitors:",
            "routeAssistant:ors:",
            "aesCanopy:affiliations"
        ]
        if (server && airline) keys.push(server + airline + "accounting:")
        return keys
    }

    openHandler() {
        return (ctx) => {
            const server = (ctx && ctx.server) || ""
            const airline = this._airlineKey(ctx)
            if (typeof window.AesCompetitorOutlinePanel === "undefined") {
                console.warn("[AES competitor-outline] panel module missing")
                return
            }
            window.AesCompetitorOutlinePanel.show({server: server, airline: airline})
        }
    }

    async _ensureOutline(ctx) {
        const now = Date.now()
        const server = (ctx && ctx.server) || ""
        const airline = this._airlineKey(ctx)
        const cacheKey = String(server) + ":" + String(airline)
        if (this._cachedOutline && this._cacheKey === cacheKey && (now - this._lastBuildAt) < 30000) {
            return this._cachedOutline
        }
        if (!server || typeof window.AesCompetitorOutlineAggregator === "undefined") {
            return null
        }
        try {
            this._cachedOutline = await window.AesCompetitorOutlineAggregator.build({server, airline})
            this._lastBuildAt = Date.now()
            this._cacheKey = cacheKey
            return this._cachedOutline
        } catch (e) {
            console.warn("[AES competitor-outline] tile aggregator failed", e)
            return null
        }
    }

    _airlineKey(ctx) {
        try {
            if (typeof AES !== "undefined" && AES.getAirlineIdentity) {
                const id = AES.getAirlineIdentity()
                if (id) return id
            }
        } catch (_) {}
        return String(ctx && ctx.airline || "")
    }

    _rivals(outline) {
        return (outline && Array.isArray(outline.competitors) ? outline.competitors : [])
            .filter(c => !c.relationship || c.relationship.includedAsRival !== false)
    }

    async loadStatus(ctx) {
        const outline = await this._ensureOutline(ctx)
        const Kind = window.CentralHubStatusBadges.KIND
        const rivals = this._rivals(outline)
        if (!outline || !rivals.length) {
            return {
                badge:     "0",
                badgeKind: Kind.MUTED,
                summary:   outline && outline.excludedCount
                    ? "No rivals in default view · " + outline.excludedCount + " excluded partner/self rows"
                    : "No outline data yet. Open a competitor profile or hit Refresh."
            }
        }
        const threats = rivals.filter(c => (c.summary.threatScore || 0) > 0).length
        const open = outline.uncontested
        return {
            badge:     String(threats),
            badgeKind: threats > 0 ? Kind.WARN : Kind.OK,
            summary:   threats + " threat" + (threats === 1 ? "" : "s")
                + " · " + rivals.length + " rivals"
                + (outline.excludedCount ? " · " + outline.excludedCount + " excluded" : "")
                + " · " + outline.totalRoutes + " routes"
                + (open > 0 ? " · " + open + " open lanes" : "")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const outline = await this._ensureOutline(ctx)
        const rivals = this._rivals(outline)
        if (!outline || !rivals.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0 0 " + T.sp[2] + " 0;"
            empty.textContent = outline && outline.excludedCount
                ? "Observed enterprises are currently classified as kin, allied, interline, or codeshare. Open the panel and switch to Excluded partners to inspect them."
                : "No competitors aggregated yet. Visit a competitor's profile (e.g. /app/info/enterprises/<id>) to seed data, then click \"Open →\" to see the full outline."
            host.appendChild(empty)
            // F-DASH-503 — keep the action row available in the empty state so
            // the user can kick off "Refresh stale rivals" without leaving the
            // tile. Without this they hit a dead end and have no in-tile way
            // to recover from a fresh install.
            host.appendChild(this._buildActionsRow(ctx, T))
            return
        }

        const intro = document.createElement("p")
        intro.style.cssText = "margin:0 0 " + T.sp[2] + " 0;color:" + T.color.oxide2 + ";"
        intro.textContent = "Top rivals — relationship, estimated finance, routes, prices, ORS, and counter-aircraft."
        host.appendChild(intro)

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
        const top = rivals
            .slice()
            .sort((a, b) => (b.summary.threatScore || 0) - (a.summary.threatScore || 0))
            .slice(0, 3)
        for (const c of top) {
            list.appendChild(this._buildPreviewRow(c, T))
        }
        host.appendChild(list)

        if (rivals.length > 3) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (rivals.length - 3) + " more rivals"
                + (outline.excludedCount ? " · " + outline.excludedCount + " excluded partners/self" : "")
                + " — Open → for the full outline."
            host.appendChild(more)
        }

        host.appendChild(this._buildActionsRow(ctx, T))
    }

    _buildActionsRow(ctx, T) {
        // F-DASH-503 — utility actions row. Extracted so the empty-state
        // branch can render the same actions (Refresh stale rivals is the
        // primary recovery path from a cold-start tile).
        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2]
            + ";margin-top:" + T.sp[3] + ";"
        const openBtn = this._mkBtn(T, "Open full outline →", () => {
            if (window.AesCompetitorOutlinePanel
                    && typeof window.AesCompetitorOutlinePanel.show === "function") {
                window.AesCompetitorOutlinePanel.show({
                    server: (ctx && ctx.server) || "",
                    airline: this._airlineKey(ctx)
                })
            }
        })
        actions.append(openBtn)
        const runnerAvail = !!(window.AesCompetitorOutlineRunner
            && typeof window.AesCompetitorOutlineRunner.runForServer === "function")
        const refreshBtn = this._mkBtn(T, "Refresh stale rivals", async () => {
            const server = (ctx && ctx.server) || ""
            if (!server || !runnerAvail) return
            refreshBtn.disabled = true
            const orig = refreshBtn.textContent
            refreshBtn.textContent = "Refreshing…"
            try {
                const res = await window.AesCompetitorOutlineRunner.runForServer({server})
                refreshBtn.textContent = res && res.success
                    ? "Refreshed " + (res.refreshed || 0)
                    : "Refresh failed"
            } catch (e) {
                console.warn("[AES competitor-outline] tile refresh failed", e)
                refreshBtn.textContent = "Refresh failed"
            }
            setTimeout(() => {
                refreshBtn.textContent = orig
                refreshBtn.disabled = false
                this._cachedOutline = null
                this.refresh().catch(() => {})
            }, 2500)
        })
        refreshBtn.disabled = !runnerAvail
        if (!runnerAvail) refreshBtn.title = "Outline runner not loaded on this page."
        actions.append(refreshBtn)
        return actions
    }

    _mkBtn(T, label, onClick) {
        const b = document.createElement("button")
        b.type = "button"
        b.textContent = label
        b.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.small,
            "cursor:pointer"
        ].join(";")
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick() })
        return b
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
        partsStats.push("lead " + c.summary.threatScore)
        if (c.relationship && c.relationship.label) partsStats.push(c.relationship.label)
        if (c.financials && c.financials.totalEstimatedWeeklyProfit != null) {
            partsStats.push("est " + this._fmtMoney(c.financials.totalEstimatedWeeklyProfit) + "/wk")
        }
        partsStats.push(c.summary.totalRoutes + " routes")
        partsStats.push(c.summary.totalWeeklyFlights + " flights/wk")
        const freshAt = c.financials && c.financials.freshness && c.financials.freshness.routeAt
            || c.summary && c.summary.freshness && c.summary.freshness.enterpriseAt
        if (freshAt) partsStats.push(this._fmtAgo(freshAt))
        if (c.summary.counterableRoutes > 0)  partsStats.push(c.summary.counterableRoutes + " counterable")
        if (c.summary.uncontestedRoutes > 0)  partsStats.push(c.summary.uncontestedRoutes + " open")
        if (c.summary.weAlreadyWinRoutes > 0) partsStats.push(c.summary.weAlreadyWinRoutes + " we lead")
        stats.textContent = partsStats.join(" · ")
        row.append(name, stats)
        return row
    }

    _fmtMoney(n) {
        if (n == null || !isFinite(n)) return "—"
        const abs = Math.abs(n)
        if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B"
        if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M"
        if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k"
        return String(Math.round(n))
    }

    _fmtAgo(ms) {
        if (!ms) return "—"
        const d = Date.now() - ms
        if (d < 60000) return "fresh"
        if (d < 3600000) return Math.round(d / 60000) + "m old"
        if (d < 86400000) return Math.round(d / 3600000) + "h old"
        return Math.round(d / 86400000) + "d old"
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
