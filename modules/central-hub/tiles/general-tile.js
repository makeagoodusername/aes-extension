"use strict"

/**
 * General tile — schedule freshness + personnel salary freshness, ported
 * from `displayGeneral()` (content_dashboard.js:1073) which composed two
 * helper rows (generalAddScheduleRow / generalAddPersonelManagementRow at
 * lines 2701/2746).
 *
 * Reads:
 *   <server><airlineCode>schedule          — type:'schedule', date:YYYYMMDD
 *   <server><airlineFullName>personelManagement — date:YYYYMMDD
 *
 * Note the legacy keys mix airline.code (schedule) and airline.name
 * (personnel) — the tile mirrors that quirk so we look up the same
 * records the legacy script wrote.
 */
class CentralHubGeneralTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "general"
        this.title = "General"
        this.section = "finance"
        this.priority = 100
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        return [String(ctx && ctx.server || "") + ""]
    }

    openHref() { return "/app/enterprise/dashboard" }   // self-link as no-op

    _airlineFields() {
        try {
            const a = AES.getAirlineCode()
            return {code: (a && a.code) || "", name: (a && a.name) || ""}
        } catch (_) {
            return {code: (this.ctx && this.ctx.airline) || "", name: ""}
        }
    }

    async _loadRows() {
        const server = (this.ctx && this.ctx.server) || ""
        const {code, name} = this._airlineFields()
        if (!server) return null
        const scheduleKey = server + code + "schedule"
        const personnelKey = server + name + "personelManagement"
        const blob = await chrome.storage.local.get([scheduleKey, personnelKey])
        return {schedule: blob[scheduleKey] || null, personnel: blob[personnelKey] || null}
    }

    _daysAgo(dateStr) {
        if (!dateStr) return null
        try {
            const today = AES.getServerDate().date
            return AES.getDateDiff([today, dateStr])
        } catch (_) {
            return null
        }
    }

    async loadStatus() {
        const rows = await this._loadRows()
        if (!rows) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "Airline context unavailable."
            }
        }
        const sched = rows.schedule
        const pers = rows.personnel
        const sDays = this._daysAgo(sched && sched.date)
        const pDays = this._daysAgo(pers && pers.date)
        const stale = (n) => n == null ? null : (n >= 0 && n < 7)

        if (!sched && !pers) {
            return {
                badge: "STALE",
                badgeKind: window.CentralHubStatusBadges.KIND.WARN,
                summary: "No schedule or personnel data extracted."
            }
        }
        const sFresh = stale(sDays)
        const pFresh = stale(pDays)
        const both = sFresh && pFresh
        return {
            badge: both ? "FRESH" : "STALE",
            badgeKind: both
                ? window.CentralHubStatusBadges.KIND.OK
                : window.CentralHubStatusBadges.KIND.WARN,
            summary: "Schedule "
                + (sched ? AES.formatDaysAgo(sDays) : "not extracted")
                + " · Personnel "
                + (pers ? AES.formatDaysAgo(pDays) : "not extracted")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const rows = await this._loadRows()
        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-family:" + T.font.display
            + ";font-size:" + T.fs.body + ";"
        tbl.appendChild(this._buildRow(T, "Schedule", rows && rows.schedule, "schedule",
            "/app/info/enterprises/me?tab=3"))
        tbl.appendChild(this._buildRow(T, "Personnel Management", rows && rows.personnel, "personelManagement",
            "/action/enterprise/staffOverview"))
        host.appendChild(tbl)
    }

    _buildRow(T, label, rec, kind, href) {
        const tr = document.createElement("tr")
        tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
        const lblCell = document.createElement("td")
        lblCell.textContent = label
        lblCell.style.cssText = [
            "padding:" + T.sp[2] + " " + T.sp[2],
            "font-weight:" + T.fw.bold,
            "color:" + T.color.oxide,
            "width:30%"
        ].join(";")

        const statusCell = document.createElement("td")
        statusCell.style.cssText = "padding:" + T.sp[2] + " " + T.sp[2] + ";color:" + T.color.oxide2 + ";"
        if (rec) {
            const days = this._daysAgo(rec.date)
            const fresh = (days != null && days >= 0 && days < 7)
            const span = document.createElement("span")
            span.textContent = "Last update: " + AES.formatDateString(rec.date)
                + (days != null ? " (" + AES.formatDaysAgo(days) + ")" : "")
            span.style.color = fresh ? T.color.moss : T.color.amber
            statusCell.appendChild(span)
        } else {
            const span = document.createElement("span")
            span.textContent = "No data found."
            span.style.color = T.color.crimson
            statusCell.appendChild(span)
        }

        const actionCell = document.createElement("td")
        actionCell.style.cssText = "padding:" + T.sp[2] + " " + T.sp[2] + ";text-align:right;width:20%;"
        const link = document.createElement("a")
        link.href = href
        link.textContent = (kind === "schedule" ? "Extract schedule" : "Open personnel") + " →"
        link.style.cssText = "color:" + T.color.rust + ";text-decoration:none;font-weight:" + T.fw.bold + ";"
        actionCell.appendChild(link)

        tr.append(lblCell, statusCell, actionCell)
        return tr
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "general",
        section: "finance",
        priority: 100,
        factory: () => new CentralHubGeneralTile()
    })
}
