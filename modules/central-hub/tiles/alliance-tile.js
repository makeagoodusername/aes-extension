"use strict"

/**
 * Alliance tile — read-only roster of the airline's current alliance.
 *
 * Reads the cached record written by AllianceOverviewScraper (the
 * live-capture content script in modules/alliance/content-alliance.js
 * runs on every /app/alliance visit). The tile never mutates anything:
 * a quit-alliance affordance from a dashboard surface is too dangerous,
 * so the body is read-only and links out to /app/alliance for any
 * state-changing action.
 */
class CentralHubAllianceTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "alliance"
        this.title = "Alliance"
        this.section = "tools"
        this.priority = 40
        this.requiresAirline = true

        this._sortKey = "enterpriseName"
        this._sortDir = "asc"
    }

    watchedStorageKeys() {
        return [AllianceOverviewScraper.CACHE_KEY]
    }

    openHref() { return "/app/alliance" }

    async loadStatus() {
        const rec = await AllianceOverviewScraper.loadRecord()
        const KIND = window.CentralHubStatusBadges.KIND
        if (!rec) {
            return {
                badge:     "—",
                badgeKind: KIND.MUTED,
                summary:   "No alliance data — visit /app/alliance once to seed the cache."
            }
        }
        const members = Array.isArray(rec.members) ? rec.members : []
        const pending = Number(rec.pendingApplications) || 0
        const name = rec.allianceName || "Alliance"
        let summary = name + " · " + members.length + " member" + (members.length === 1 ? "" : "s")
        if (pending > 0) summary += " · " + pending + " pending"
        return {
            badge:     String(members.length),
            badgeKind: pending > 0 ? KIND.WARN : KIND.INFO,
            summary:   summary
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const rec = await AllianceOverviewScraper.loadRecord()

        const headerStrip = document.createElement("div")
        headerStrip.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:" + T.sp[2],
            "margin-bottom:" + T.sp[2]
        ].join(";")

        const meta = document.createElement("div")
        meta.style.cssText = "color:" + T.color.oxide2 + ";font-family:" + T.font.display + ";"
        if (rec) {
            meta.textContent = (rec.allianceName || "Alliance")
                + (rec.scrapedAt ? " · scraped " + new Date(rec.scrapedAt).toLocaleString() : "")
        } else {
            meta.textContent = "No alliance data cached yet."
        }

        const openBtn = document.createElement("a")
        openBtn.href = "/app/alliance"
        openBtn.textContent = "Open Alliance Page →"
        openBtn.style.cssText = [
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "text-decoration:none",
            "white-space:nowrap"
        ].join(";")

        headerStrip.append(meta, openBtn)
        host.appendChild(headerStrip)

        const members = (rec && Array.isArray(rec.members)) ? rec.members.slice() : []
        if (!members.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = rec
                ? "No members listed."
                : "Visit /app/alliance once to populate the roster."
            host.appendChild(empty)
            return
        }

        this._sortMembers(members)

        const table = document.createElement("table")
        table.style.cssText = [
            "width:100%",
            "border-collapse:collapse",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono
        ].join(";")

        const thead = document.createElement("thead")
        const headRow = document.createElement("tr")
        headRow.style.cssText = "border-bottom:" + T.geom.bw2 + " solid " + T.color.oxide + ";"
        const cols = [
            {key: null,             label: ""},
            {key: "enterpriseName", label: "Name"},
            {key: "code",           label: "Code"},
            {key: "country",        label: "Country"},
            {key: "hq",             label: "HQ"},
            {key: "role",           label: "Role"},
            {key: "remarks",        label: "Remarks"}
        ]
        for (const c of cols) {
            const th = document.createElement("th")
            th.textContent = c.label
            const isSortCol = c.key && c.key === this._sortKey
            const arrow = isSortCol ? (this._sortDir === "asc" ? " ▲" : " ▼") : ""
            if (arrow) th.textContent = c.label + arrow
            th.style.cssText = [
                "text-align:left",
                "padding:" + T.sp[1] + " " + T.sp[2],
                "font-family:" + T.font.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps,
                "color:" + T.color.oxide,
                "cursor:" + (c.key ? "pointer" : "default"),
                "user-select:none"
            ].join(";")
            if (c.key) {
                th.addEventListener("click", () => {
                    if (this._sortKey === c.key) {
                        this._sortDir = this._sortDir === "asc" ? "desc" : "asc"
                    } else {
                        this._sortKey = c.key
                        this._sortDir = "asc"
                    }
                    this._renderBodySafe()
                })
            }
            headRow.appendChild(th)
        }
        thead.appendChild(headRow)
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        for (const m of members) {
            const tr = document.createElement("tr")
            tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"

            const tdLogo = document.createElement("td")
            tdLogo.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";width:24px;"
            if (m.logoUrl) {
                const img = document.createElement("img")
                img.src = m.logoUrl
                img.alt = ""
                img.style.cssText = "width:24px;height:24px;object-fit:contain;display:block;"
                tdLogo.appendChild(img)
            }
            tr.appendChild(tdLogo)

            const tdName = document.createElement("td")
            tdName.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.oxide2 + ";"
            if (m.enterpriseUrl) {
                const a = document.createElement("a")
                a.href = m.enterpriseUrl
                a.target = "_blank"
                a.rel = "noopener noreferrer"
                a.textContent = m.enterpriseName || "(unnamed)"
                a.style.cssText = "color:" + T.color.cobalt + ";text-decoration:none;"
                tdName.appendChild(a)
            } else {
                tdName.textContent = m.enterpriseName || ""
            }
            tr.appendChild(tdName)

            const tdCode = document.createElement("td")
            tdCode.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.oxide + ";"
            tdCode.textContent = m.code || ""
            tr.appendChild(tdCode)

            const tdCountry = document.createElement("td")
            tdCountry.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.slate + ";"
            tdCountry.textContent = m.country || ""
            tr.appendChild(tdCountry)

            const tdHq = document.createElement("td")
            tdHq.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";"
            if (m.hqUrl) {
                const a = document.createElement("a")
                a.href = m.hqUrl
                a.target = "_blank"
                a.rel = "noopener noreferrer"
                a.textContent = m.hq || ""
                a.style.cssText = "color:" + T.color.cobalt + ";text-decoration:none;"
                tdHq.appendChild(a)
            } else {
                tdHq.textContent = m.hq || ""
            }
            tr.appendChild(tdHq)

            const tdRole = document.createElement("td")
            tdRole.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + (m.role ? T.color.amber : T.color.slate) + ";"
            tdRole.textContent = m.role || ""
            tr.appendChild(tdRole)

            const tdRemarks = document.createElement("td")
            tdRemarks.style.cssText = "padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.slate + ";"
            tdRemarks.textContent = m.role ? "" : (m.remarks || "")
            tr.appendChild(tdRemarks)

            tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        host.appendChild(table)

        if (rec && rec.pendingApplications > 0) {
            const note = document.createElement("p")
            note.style.cssText = "margin:" + T.sp[2] + " 0 0 0;color:" + T.color.amber + ";font-family:" + T.font.display + ";"
            note.textContent = rec.pendingApplications
                + " pending application" + (rec.pendingApplications === 1 ? "" : "s")
                + " — review on the alliance page."
            host.appendChild(note)
        }
    }

    _sortMembers(members) {
        const key = this._sortKey
        const dir = this._sortDir === "desc" ? -1 : 1
        members.sort((a, b) => {
            const av = (a && a[key] != null) ? String(a[key]) : ""
            const bv = (b && b[key] != null) ? String(b[key]) : ""
            return av.localeCompare(bv) * dir
        })
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "alliance",
        section:  "tools",
        priority: 40,
        factory:  () => new CentralHubAllianceTile()
    })
}
