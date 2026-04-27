"use strict"

/**
 * Route Management tile — surfaces the most recently extracted weekly
 * schedule for the current airline.
 *
 * Storage: any record with `type === "schedule"` and matching `server` —
 * written by content_fligthSchedule.js when the user clicks Extract on
 * the enterprise schedule tab. The legacy `displayRouteManagement()`
 * (content_dashboard.js:87) builds a sortable table from this; the hub
 * shows a compact summary + the top recurring routes.
 */
class CentralHubRouteManagementTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "route-management"
        this.title = "Route Mgmt"
        this.section = "routes"
        this.priority = 50
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        return [String(ctx && ctx.server || "") + ""]
    }

    openHandler() {
        return () => CentralHubLegacy.switchDropdownTo("routeManagement")
    }

    async _loadSchedule() {
        const server = (this.ctx && this.ctx.server) || ""
        if (!server) return null
        const all = await chrome.storage.local.get(null)
        let best = null
        let bestDate = ""
        for (const k in all) {
            const v = all[k]
            if (!v || typeof v !== "object") continue
            if (v.type !== "schedule") continue
            if (v.server && v.server !== server) continue
            const when = v.date || ""
            if (!best || when > bestDate) { best = v; bestDate = when }
        }
        return best
    }

    async loadStatus() {
        const sched = await this._loadSchedule()
        if (!sched) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No schedule extracted. Visit /app/info/enterprises/<id>?tab=3."
            }
        }
        const flights = Array.isArray(sched.flights) ? sched.flights.length : 0
        const dest = new Set()
        for (const f of (sched.flights || [])) {
            if (f && f.destination) dest.add(f.destination)
        }
        const when = sched.date ? AES.formatDateString(sched.date) : ""
        return {
            badge: flights + " LEGS",
            badgeKind: window.CentralHubStatusBadges.KIND.DEFAULT,
            summary: flights + " legs · " + dest.size + " destinations"
                + (when ? " · extracted " + when : "")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const sched = await this._loadSchedule()
        if (!sched || !Array.isArray(sched.flights) || !sched.flights.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "No flights stored. Run Extract from the enterprise schedule tab."
            host.appendChild(empty)
            return
        }
        const byPair = new Map()
        for (const f of sched.flights) {
            if (!f || !f.origin || !f.destination) continue
            const key = f.origin + "→" + f.destination
            byPair.set(key, (byPair.get(key) || 0) + 1)
        }
        const top = Array.from(byPair.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)

        const list = document.createElement("ul")
        list.style.cssText = [
            "list-style:none",
            "padding:0",
            "margin:0",
            "display:grid",
            "grid-template-columns:repeat(auto-fit, minmax(160px, 1fr))",
            "gap:" + T.sp[1]
        ].join(";")
        for (const [pair, count] of top) {
            const li = document.createElement("li")
            li.style.cssText = [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:" + T.color.bone2,
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.body,
                "letter-spacing:" + T.track.mono,
                "color:" + T.color.oxide2,
                "display:flex",
                "justify-content:space-between"
            ].join(";")
            const left = document.createElement("span")
            left.textContent = pair
            const right = document.createElement("span")
            right.style.color = T.color.slate
            right.textContent = "× " + count
            li.append(left, right)
            list.appendChild(li)
        }
        host.appendChild(list)
        if (byPair.size > top.length) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (byPair.size - top.length) + " more route pairs in the schedule."
            host.appendChild(more)
        }
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "route-management",
        section: "routes",
        priority: 50,
        factory: () => new CentralHubRouteManagementTile()
    })
}
