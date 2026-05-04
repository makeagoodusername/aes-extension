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
        // Watch only the two specific keys we read (schedule + personnel).
        // The earlier `[server + ""]` form devolved to "" when ctx.server was
        // missing, which the storage listener treats as "match every key" and
        // triggers a refresh on every write across the whole extension —
        // F-9223-015 in the existing audit. Returning concrete prefixes keeps
        // the listener scoped to data this tile actually consumes.
        const server = String(ctx && ctx.server || "")
        if (!server) return []
        let code = "", name = ""
        try {
            const a = AES.getAirlineCode()
            code = (a && a.code) || ""
            name = (a && a.name) || ""
        } catch (_) { /* dashboard not yet rendered */ }
        const out = []
        if (code) out.push(server + code + "schedule")
        if (name) out.push(server + name + "personelManagement")
        return out
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

        // Greeting strip — surfaces the current server day (and time) so the
        // tile gives the user an at-a-glance "today is Y, this scrape was N
        // days ago" frame for the data-freshness rows below. Falls back
        // silently when the navbar isn't rendered (cold-start, non-dashboard
        // pages — `getServerDate` parses `.as-navbar-bottom`).
        try {
            const dt = AES.getServerDate()
            if (dt && dt.date) {
                const greeting = document.createElement("p")
                greeting.style.cssText = "margin:0 0 " + T.sp[3] + " 0;color:"
                    + T.color.oxide2 + ";font-family:" + T.font.display
                    + ";font-size:" + T.fs.body + ";"
                greeting.textContent = "Game day " + AES.formatDateString(dt.date)
                    + (dt.time ? " · " + dt.time : "")
                host.appendChild(greeting)
            }
        } catch (_) { /* navbar missing — skip greeting */ }

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
