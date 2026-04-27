"use strict"

/**
 * Schedule Management tile — surfaces saved presets + recent generated
 * schedules for the current airline.
 *
 * Reads:
 *   SchedulePresets.load()                                    — preset CRUD
 *   <server><airlineCode>scheduleManagement:index             — id list
 *   <server><airlineCode>scheduleManagement:<scheduleId>      — record
 *
 * Open routes the user to the legacy in-page Schedule Management view
 * (the `displayScheduleManagement()` pane below the hub) by switching
 * the legacy dropdown — that gives access to the full SchedulePanel.
 */
class CentralHubScheduleManagementTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "schedule-management"
        this.title = "Schedule Mgmt"
        this.section = "routes"
        this.priority = 20
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        const server = (ctx && ctx.server) || ""
        return ["settings", server + (ctx && ctx.airline || "") + "scheduleManagement:"]
    }

    openHandler() {
        return () => CentralHubLegacy.switchDropdownTo("scheduleManagement")
    }

    async _loadPresets() {
        try {
            if (typeof window.SchedulePresets === "function") {
                return await window.SchedulePresets.load()
            }
        } catch (_) { /* fall through */ }
        const data = await chrome.storage.local.get(["settings"])
        return (data.settings && data.settings.scheduleManagement) || {presets: []}
    }

    async _loadRecentSchedules() {
        const server = (this.ctx && this.ctx.server) || ""
        const airline = (this.ctx && this.ctx.airline) || ""
        if (!server) return []
        const indexKey = server + airline + "scheduleManagement:index"
        const blob = await chrome.storage.local.get([indexKey])
        const idList = blob[indexKey]
        if (!Array.isArray(idList) || !idList.length) return []
        const keys = idList.slice(0, 5).map(id =>
            server + airline + "scheduleManagement:" + id)
        const records = await chrome.storage.local.get(keys)
        return keys.map(k => records[k]).filter(Boolean)
    }

    async loadStatus() {
        const block = await this._loadPresets()
        const presets = (block && block.presets) || []
        const recent  = await this._loadRecentSchedules()
        if (!presets.length && !recent.length) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No presets or generated schedules."
            }
        }
        return {
            badge: presets.length + " · " + recent.length,
            badgeKind: window.CentralHubStatusBadges.KIND.DEFAULT,
            summary: presets.length + " preset"
                + (presets.length === 1 ? "" : "s")
                + " · " + recent.length + " recent schedule"
                + (recent.length === 1 ? "" : "s")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const block = await this._loadPresets()
        const presets = (block && block.presets) || []
        const recent  = await this._loadRecentSchedules()

        if (presets.length) {
            const wrap = document.createElement("div")
            wrap.style.cssText = "margin-bottom:" + T.sp[3] + ";"
            const heading = document.createElement("h4")
            heading.textContent = "Presets"
            heading.style.cssText = this._headingStyle(T)
            wrap.appendChild(heading)
            const chips = document.createElement("div")
            chips.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2] + ";"
            for (const p of presets) {
                const chip = document.createElement("span")
                chip.style.cssText = this._chipStyle(T)
                chip.textContent = (p.name || "(unnamed)") + " · " + ((p.waves && p.waves.length) || 0) + " waves"
                chips.appendChild(chip)
            }
            wrap.appendChild(chips)
            host.appendChild(wrap)
        }

        if (recent.length) {
            const wrap = document.createElement("div")
            const heading = document.createElement("h4")
            heading.textContent = "Recent schedules"
            heading.style.cssText = this._headingStyle(T)
            wrap.appendChild(heading)
            const list = document.createElement("ul")
            list.style.cssText = "list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:" + T.sp[1] + ";"
            for (const r of recent) {
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
                const when = r.generatedAt ? new Date(r.generatedAt).toISOString().substring(0, 10) : "—"
                const flights = Array.isArray(r.flights) ? r.flights.length : 0
                li.textContent = (r.presetName || r.scheduleId) + " · "
                    + (r.hub || "—") + " · " + flights + " legs · " + when
                list.appendChild(li)
            }
            wrap.appendChild(list)
            host.appendChild(wrap)
        }

        if (!presets.length && !recent.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "No data yet — open the Schedule Management section to define a preset."
            host.appendChild(empty)
        }
    }

    _headingStyle(T) {
        return [
            "margin:0 0 " + T.sp[1] + " 0",
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "color:" + T.color.slate
        ].join(";")
    }

    _chipStyle(T) {
        return [
            "padding:2px " + T.sp[2],
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "text-transform:uppercase"
        ].join(";")
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "schedule-management",
        section: "routes",
        priority: 20,
        factory: () => new CentralHubScheduleManagementTile()
    })
}
