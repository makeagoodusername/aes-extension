"use strict"

/**
 * Station Automation tile — current queue + last run summary.
 *
 * Reads `StationAutomationStorage.load(server, airlineCode)` (storage.js
 * is loaded on the dashboard via manifest block 6). Open switches the
 * legacy dashboard dropdown to the station-automation pane where the full
 * form/queue UI from `displayStationAutomation()` mounts.
 */
class CentralHubStationAutomationTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "station-automation"
        this.title = "Station Auto"
        this.section = "routes"
        this.priority = 30
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        return ["stationAutomation:" + (ctx && ctx.server || "") + ":"]
    }

    openHandler() {
        return () => CentralHubLegacy.switchDropdownTo("stationAutomation")
    }

    _airlineKey() {
        try {
            const id = AES.getAirlineIdentity()
            if (id) return id
        } catch (_) { /* fall through */ }
        return (this.ctx && this.ctx.airline) || ""
    }

    async _loadRecord() {
        const server = (this.ctx && this.ctx.server) || ""
        const airlineCode = this._airlineKey()
        if (!server || !airlineCode) return null
        try {
            if (typeof window.StationAutomationStorage === "function") {
                return await window.StationAutomationStorage.load(server, airlineCode)
            }
        } catch (_) { /* fall through */ }
        return null
    }

    async loadStatus() {
        const rec = await this._loadRecord()
        if (!rec) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "Storage not initialised yet."
            }
        }
        const queue = Array.isArray(rec.queue) ? rec.queue : []
        const active = !!rec.activeRunId
        const totalCountries = queue.length
        if (active) {
            return {
                badge: "RUNNING",
                badgeKind: window.CentralHubStatusBadges.KIND.WARN,
                summary: "Active run · " + totalCountries + " countries queued"
            }
        }
        if (!totalCountries) {
            return {
                badge: "EMPTY",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "Queue empty — open the section to add countries."
            }
        }
        return {
            badge: String(totalCountries),
            badgeKind: window.CentralHubStatusBadges.KIND.DEFAULT,
            summary: totalCountries + " countr" + (totalCountries === 1 ? "y" : "ies") + " queued · idle"
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const rec = await this._loadRecord()
        if (!rec || !Array.isArray(rec.queue) || !rec.queue.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Queue empty. Open the section to add countries + thresholds."
            host.appendChild(empty)
            return
        }
        const list = document.createElement("ul")
        list.style.cssText = [
            "list-style:none",
            "padding:0",
            "margin:0",
            "display:flex",
            "flex-direction:column",
            "gap:" + T.sp[1]
        ].join(";")
        for (const entry of rec.queue.slice(0, 8)) {
            const li = document.createElement("li")
            li.style.cssText = [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:" + T.color.bone2,
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "font-family:" + T.font.mono,
                "font-size:" + T.fs.body,
                "letter-spacing:" + T.track.mono,
                "color:" + T.color.oxide2
            ].join(";")
            const country = entry.countryName || entry.countryCode || entry.countryId
            li.textContent = country
                + " · pax ≥ " + (entry.paxThreshold || 0)
                + " · cargo ≥ " + (entry.cargoThreshold || 0)
                + ((entry.exceptions && entry.exceptions.length) ? " · skip " + entry.exceptions.join(",") : "")
            list.appendChild(li)
        }
        host.appendChild(list)
        if (rec.queue.length > 8) {
            const more = document.createElement("p")
            more.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.slate + ";font-style:italic;"
            more.textContent = "+ " + (rec.queue.length - 8) + " more entries."
            host.appendChild(more)
        }
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "station-automation",
        section: "routes",
        priority: 30,
        factory: () => new CentralHubStationAutomationTile()
    })
}
