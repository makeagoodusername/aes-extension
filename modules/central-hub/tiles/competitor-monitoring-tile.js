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
    }

    watchedStorageKeys(ctx) {
        return [String(ctx && ctx.server || "") + ""]
    }

    openHandler() {
        return () => CentralHubLegacy.switchDropdownTo("competitorMonitoring")
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

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const list = await this._loadCompetitors()
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
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
            tr.innerHTML =
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";'>"
                    + escapeHtml(newest && newest.code || c.id) + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.oxide2 + ";'>"
                    + escapeHtml(newest && newest.displayName || "—") + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;color:"
                    + T.color.slate + ";'>" + (dates.length ? AES.formatDateString(dates[dates.length - 1]) : "—") + "</td>"
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
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "competitor-monitoring",
        section: "routes",
        priority: 40,
        factory: () => new CentralHubCompetitorMonitoringTile()
    })
}
