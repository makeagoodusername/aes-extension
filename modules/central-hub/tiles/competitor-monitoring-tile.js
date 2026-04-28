"use strict"

/**
 * Competitor Monitoring tile — count of tracked competitor airlines on
 * the current server, plus their most recent overview snapshot age.
 *
 * Storage shape: any chrome.storage.local record with `type === "competitorMonitoring"`
 * is a tracked competitor. The legacy `displayCompetitorMonitoringAirlinesTable()`
 * (content_dashboard.js:1120) iterates the entire storage looking for these.
 * The hub mirrors that scan but only summarises.
 */
class CentralHubCompetitorMonitoringTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "competitor-monitoring"
        this.title = "Competitors"
        this.section = "routes"
        this.priority = 40
        this.requiresAirline = false

        this._focusedRoute = null       // CH-5d-1: {hub, dest} from RA row click
        this._focusedEnterprise = null  // CH-5d-5: enterpriseId pinned by pill click
    }

    watchedStorageKeys(ctx) {
        return [String(ctx && ctx.server || "") + ""]
    }

    openHandler() {
        return () => CentralHubLegacy.switchDropdownTo("competitorMonitoring")
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this.subscribeBus("focus-route", ({hub, dest}) => {
            if (!hub || !dest) return
            this._focusedRoute = {hub, dest}
            if (this.expanded) this._renderBodySafe()
        })
        this.subscribeBus("focus-enterprise", ({enterpriseId}) => {
            if (!enterpriseId) return
            this._focusedEnterprise = String(enterpriseId)
            if (!this.expanded) this.toggle()
            if (this.root) this.root.scrollIntoView({behavior: "smooth", block: "start"})
            this._renderBodySafe()
        })
    }

    async _loadCompetitors() {
        const server = (this.ctx && this.ctx.server) || ""
        if (!server) return []
        const all = await chrome.storage.local.get(null)
        const out = []
        for (const k in all) {
            const v = all[k]
            if (!v || typeof v !== "object") continue
            if (v.type !== "competitorMonitoring") continue
            if (v.server && v.server !== server) continue
            if (!v.tracking) continue
            out.push(v)
        }
        return out
    }

    async loadStatus() {
        const list = await this._loadCompetitors()
        if (!list.length) {
            return {
                badge: "0",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No competitor airlines tracked yet."
            }
        }
        const dates = []
        for (const c of list) {
            const tab0 = c.tab0 || {}
            for (const d in tab0) dates.push(d)
        }
        dates.sort()
        const newest = dates.length ? dates[dates.length - 1] : ""
        return {
            badge: String(list.length),
            badgeKind: window.CentralHubStatusBadges.KIND.DEFAULT,
            summary: list.length + " tracked"
                + (newest ? " · last overview " + AES.formatDateString(newest) : "")
        }
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        host.textContent = ""
        const list = await this._loadCompetitors()

        if (this._focusedRoute) {
            host.appendChild(this._renderRouteBanner(T))
        }
        if (this._focusedEnterprise) {
            const found = list.find(c => String(c.id) === this._focusedEnterprise)
            if (found) {
                host.appendChild(this._renderEnterpriseDeepHistory(found, T))
                host.appendChild(this._renderClearEnterpriseFooter(T))
                return
            }
            host.appendChild(this._renderEnterpriseNotFoundBanner(T))
        }

        if (!list.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "No competitors tracked. Open the section to start tracking airlines."
            host.appendChild(empty)
            return
        }
        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-family:"
            + T.font.mono + ";font-size:" + T.fs.body + ";letter-spacing:" + T.track.mono + ";"
        for (const c of list.slice(0, 10)) {
            const tab0 = c.tab0 || {}
            const dates = Object.keys(tab0).sort()
            const newest = dates.length ? tab0[dates[dates.length - 1]] : null
            const code = (newest && newest.code) || c.id
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";cursor:pointer;"
            tr.innerHTML =
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";'>"
                    + "<span class='aes-comp-pill' data-enterprise-id='" + escapeHtml(String(c.id || ""))
                    + "' style='display:inline-block;padding:1px " + T.sp[2] + ";background:" + T.color.bone2
                    + ";color:" + T.color.cobalt + ";border:" + T.geom.bw1 + " solid " + T.color.cobalt
                    + ";border-radius:" + T.geom.radius + ";cursor:pointer;'>"
                    + escapeHtml(code) + "</span></td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.oxide2 + ";'>"
                    + escapeHtml(newest && newest.displayName || "—") + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;color:"
                    + T.color.slate + ";'>" + (dates.length ? AES.formatDateString(dates[dates.length - 1]) : "—") + "</td>"
            const pill = tr.querySelector(".aes-comp-pill")
            if (pill) {
                pill.addEventListener("click", (e) => {
                    e.stopPropagation()
                    if (!window.CentralHubBus) return
                    window.CentralHubBus.emit("focus-enterprise", {
                        enterpriseId: String(c.id || ""),
                        source: "competitor-monitoring"
                    })
                })
            }
            table.appendChild(tr)
        }
        host.appendChild(table)
        if (list.length > 10) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (list.length - 10) + " more tracked competitors."
            host.appendChild(more)
        }
    }

    _renderRouteBanner(T) {
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
        label.textContent = "Route focus: " + this._focusedRoute.hub + "→" + this._focusedRoute.dest
            + " — open Inventory tile for per-route detail."
        const clear = document.createElement("button")
        clear.type = "button"
        clear.textContent = "× clear"
        clear.style.cssText = "background:transparent;color:" + T.color.amber
            + ";border:" + T.geom.bw1 + " solid " + T.color.amber + ";border-radius:" + T.geom.radius
            + ";padding:" + T.sp[0] + " " + T.sp[2] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        clear.addEventListener("click", () => {
            this._focusedRoute = null
            this._renderBodySafe()
        })
        banner.append(label, clear)
        return banner
    }

    _renderEnterpriseDeepHistory(record, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:" + T.sp[2] + ";background:" + T.color.bone2
            + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";margin-bottom:" + T.sp[2] + ";"

        const tab0 = record.tab0 || {}
        const dates = Object.keys(tab0).sort()
        const newest = dates.length ? tab0[dates[dates.length - 1]] : null
        const heading = document.createElement("h4")
        heading.textContent = (newest && newest.displayName) || record.id
        heading.style.cssText = "margin:0 0 " + T.sp[1] + " 0;font-family:" + T.font.display
            + ";font-size:" + T.fs.lead + ";font-weight:" + T.fw.display
            + ";text-transform:uppercase;letter-spacing:" + T.track.caps + ";color:" + T.color.oxide + ";"
        wrap.appendChild(heading)

        const subtitle = document.createElement("div")
        subtitle.style.cssText = "color:" + T.color.slate + ";font-family:" + T.font.mono
            + ";font-size:" + T.fs.micro + ";margin-bottom:" + T.sp[2] + ";"
        subtitle.textContent = "id " + record.id + " · "
            + dates.length + " overview snapshot" + (dates.length === 1 ? "" : "s")
        wrap.appendChild(subtitle)

        if (dates.length) {
            const list = document.createElement("ol")
            list.style.cssText = "margin:0;padding:0 0 0 " + T.sp[4]
                + ";font-family:" + T.font.mono + ";font-size:" + T.fs.body + ";color:" + T.color.oxide2 + ";"
            const ordered = dates.slice().reverse().slice(0, 8)
            for (const d of ordered) {
                const snap = tab0[d] || {}
                const li = document.createElement("li")
                li.textContent = AES.formatDateString(d) + " · "
                    + (snap.code || "—") + " · "
                    + (snap.displayName || "")
                list.appendChild(li)
            }
            wrap.appendChild(list)
        } else {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "No overview snapshots cached for this enterprise."
            wrap.appendChild(empty)
        }
        return wrap
    }

    _renderEnterpriseNotFoundBanner(T) {
        const banner = document.createElement("div")
        banner.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";margin-bottom:" + T.sp[2]
            + ";background:" + T.color.bone2 + ";color:" + T.color.slate
            + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";border-radius:" + T.geom.radius
            + ";font-family:" + T.font.display + ";font-size:" + T.fs.body + ";"
        banner.textContent = "Enterprise " + this._focusedEnterprise + " not in the tracked list."
        return banner
    }

    _renderClearEnterpriseFooter(T) {
        const footer = document.createElement("div")
        footer.style.cssText = "margin-top:" + T.sp[2] + ";text-align:right;"
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = "× clear focus"
        btn.style.cssText = "background:transparent;color:" + T.color.slate
            + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";border-radius:" + T.geom.radius
            + ";padding:" + T.sp[0] + " " + T.sp[2] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        btn.addEventListener("click", () => {
            this._focusedEnterprise = null
            this._renderBodySafe()
        })
        footer.appendChild(btn)
        return footer
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "competitor-monitoring",
        section: "routes",
        priority: 40,
        factory: () => new CentralHubCompetitorMonitoringTile()
    })
}
