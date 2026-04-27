"use strict"

/**
 * FlightsFrom tile — cached real-world airport route counts from
 * flightsfrom.com scrapes. The full scan controller + per-airport drill
 * lives in `displayFlightsFrom()` (content_dashboard.js:3847); this tile
 * surfaces a compact list of cached airports + their freshness.
 *
 * Reads via window.FlightsFromStore.listAirports() (data-store.js is
 * loaded on the dashboard).
 */
class CentralHubFlightsFromTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "flightsfrom"
        this.title = "FlightsFrom"
        this.section = "routes"
        this.priority = 60
        this.requiresAirline = false
    }

    watchedStorageKeys() { return ["flightsFrom:"] }

    openHandler() {
        return () => CentralHubLegacy.switchDropdownTo("flightsFrom")
    }

    async _listAirports() {
        try {
            if (window.FlightsFromStore && typeof window.FlightsFromStore.listAirports === "function") {
                return await window.FlightsFromStore.listAirports()
            }
        } catch (_) { /* fall through */ }
        const all = await chrome.storage.local.get(null)
        const out = []
        for (const k in all) {
            if (k.indexOf("flightsFrom:") !== 0) continue
            const iata = k.substring("flightsFrom:".length)
            const rec = all[k]
            if (!rec) continue
            out.push({
                iata,
                airportName: rec.airportName || "",
                routeCount: Array.isArray(rec.routes) ? rec.routes.length : 0,
                scrapedAt: rec.scrapedAt || 0
            })
        }
        out.sort((a, b) => (b.scrapedAt || 0) - (a.scrapedAt || 0))
        return out
    }

    async loadStatus() {
        const list = await this._listAirports()
        if (!list.length) {
            return {
                badge: "0",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No airports cached. Use the section below or RA's Rescan."
            }
        }
        const totalRoutes = list.reduce((acc, a) => acc + (a.routeCount || 0), 0)
        const newest = list[0].scrapedAt
            ? new Date(list[0].scrapedAt).toISOString().substring(0, 10) : ""
        return {
            badge: list.length + " AIRPORTS",
            badgeKind: window.CentralHubStatusBadges.KIND.OK,
            summary: list.length + " airport" + (list.length === 1 ? "" : "s")
                + " · " + totalRoutes + " routes" + (newest ? " · newest " + newest : "")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const list = await this._listAirports()
        if (!list.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Run a flightsfrom.com scan from the section below to seed."
            host.appendChild(empty)
            return
        }
        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-family:"
            + T.font.mono + ";font-size:" + T.fs.body + ";letter-spacing:" + T.track.mono + ";"
        const head = document.createElement("thead")
        head.innerHTML = "<tr>"
            + "<th style='text-align:left;padding:" + T.sp[1] + " " + T.sp[2]
                + ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";'>IATA</th>"
            + "<th style='text-align:left;padding:" + T.sp[1] + " " + T.sp[2]
                + ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";'>Airport</th>"
            + "<th style='text-align:right;padding:" + T.sp[1] + " " + T.sp[2]
                + ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";'>Routes</th>"
            + "<th style='text-align:right;padding:" + T.sp[1] + " " + T.sp[2]
                + ";border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";'>Scraped</th>"
            + "</tr>"
        const body = document.createElement("tbody")
        for (const a of list.slice(0, 10)) {
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
            const ageHrs = a.scrapedAt ? Math.round((Date.now() - a.scrapedAt) / 3600e3) : null
            const ageStr = ageHrs == null ? "—" : (ageHrs < 24 ? ageHrs + "h" : Math.round(ageHrs / 24) + "d") + " ago"
            tr.innerHTML =
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";'>" + escapeHtml(a.iata) + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.oxide2 + ";'>"
                    + escapeHtml(a.airportName) + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;'>" + (a.routeCount || 0) + "</td>" +
                "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;color:" + T.color.slate + ";'>"
                    + ageStr + "</td>"
            body.appendChild(tr)
        }
        table.append(head, body)
        host.appendChild(table)
        if (list.length > 10) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (list.length - 10) + " more cached airports."
            host.appendChild(more)
        }
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "flightsfrom",
        section: "routes",
        priority: 60,
        factory: () => new CentralHubFlightsFromTile()
    })
}
