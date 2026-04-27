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
        const all = await chrome.storage.local.get(null)
        const prefix = "routeAssistant:topRoutes:"
        const out = []
        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            if (k.indexOf(":perClass:") >= 0) continue   // companion snapshot
            const hub = k.substring(prefix.length)
            if (!hub || hub.indexOf(":") >= 0) continue
            const rec = all[k]
            if (!rec) continue
            out.push({hub, record: rec})
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

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const hubs = await this._loadHubs()
        if (!hubs.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Visit a /app/com/scheduling/<HUB> page (e.g. ATL) to publish a topRoutes snapshot."
            host.appendChild(empty)
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
            list.appendChild(li)
        }
        wrap.appendChild(list)
        return wrap
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
