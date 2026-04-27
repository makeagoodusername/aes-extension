"use strict"

/**
 * Crew tile — surfaces pilot counts per aircraft category from the
 * staffPilots page and lets the user trigger hire-from-market or
 * train-new inline. Reads chrome.storage.local["crewMgmt:pilots"]
 * (seeded by the staffPilots content script and refreshed after each
 * apply).
 */
class CentralHubCrewManagementTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "crew-management"
        this.title = "Crew"
        this.section = "tools"
        this.priority = 30
        this.requiresAirline = true
    }

    watchedStorageKeys() { return ["crewMgmt:pilots"] }

    openHref() { return "/action/enterprise/staffPilots" }

    async _loadRecord() {
        const blob = await chrome.storage.local.get(["crewMgmt:pilots"])
        return blob["crewMgmt:pilots"] || null
    }

    async loadStatus() {
        const KIND = window.CentralHubStatusBadges.KIND
        const rec = await this._loadRecord()
        if (!rec || !Array.isArray(rec.categories) || !rec.categories.length) {
            return {
                badge:     "—",
                badgeKind: KIND.MUTED,
                summary:   "No crew data — visit /action/enterprise/staffPilots to seed."
            }
        }
        const cats = rec.categories
        const employed = cats.reduce((a, c) => a + (c.employed || 0), 0)
        const required = cats.reduce((a, c) => a + (c.required || 0), 0)
        const missing = cats.reduce((a, c) => a + (c.missing || 0), 0)
        if (missing > 0) {
            return {
                badge:     missing + " SHORT",
                badgeKind: KIND.ALERT,
                summary:   employed + "/" + required + " pilots employed · " + missing + " short across " + cats.length + " categor" + (cats.length === 1 ? "y" : "ies")
            }
        }
        return {
            badge:     employed + "/" + required,
            badgeKind: KIND.OK,
            summary:   cats.length + " categor" + (cats.length === 1 ? "y" : "ies") + " · all rated"
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const rec = await this._loadRecord()
        if (!rec || !Array.isArray(rec.categories) || !rec.categories.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Visit /action/enterprise/staffPilots to populate this tile."
            host.appendChild(empty)
            return
        }
        const server = (ctx && ctx.server) || ""

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
        for (const h of ["Category", "Emp/Req", "Short", "Market", "Hire/Train"]) {
            const th = document.createElement("th")
            th.textContent = h
            th.style.cssText = [
                "text-align:left",
                "padding:" + T.sp[1] + " " + T.sp[2],
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "color:" + T.color.slate,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "letter-spacing:" + T.track.caps
            ].join(";")
            headRow.appendChild(th)
        }
        thead.appendChild(headRow)
        table.appendChild(thead)

        const tbody = document.createElement("tbody")
        for (const c of rec.categories) {
            tbody.appendChild(this._buildRow(T, c, server))
        }
        table.appendChild(tbody)
        host.appendChild(table)

        const meta = document.createElement("div")
        meta.style.cssText = "margin-top:" + T.sp[3] + ";color:" + T.color.slate + ";font-family:" + T.font.mono + ";font-size:" + T.fs.body + ";"
        meta.textContent = "Last scraped " + new Date(rec.scrapedAt || 0).toLocaleString()
        host.appendChild(meta)
    }

    _buildRow(T, cat, server) {
        const tr = document.createElement("tr")
        tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"

        const cellPad = "padding:" + T.sp[1] + " " + T.sp[2] + ";vertical-align:middle;"

        const nameTd = document.createElement("td")
        nameTd.style.cssText = cellPad + "color:" + T.color.oxide + ";"
        nameTd.textContent = cat.label
        tr.appendChild(nameTd)

        const emp = document.createElement("td")
        emp.style.cssText = cellPad + "color:" + T.color.oxide2 + ";"
        emp.textContent = (cat.employed || 0) + "/" + (cat.required || 0)
        tr.appendChild(emp)

        const short = document.createElement("td")
        short.style.cssText = cellPad + "color:" + ((cat.missing || 0) > 0 ? T.color.rust : T.color.slate) + ";"
        short.textContent = String(cat.missing || 0)
        tr.appendChild(short)

        const market = document.createElement("td")
        market.style.cssText = cellPad + "color:" + T.color.oxide2 + ";"
        market.textContent = String(cat.jobMarketAvailable || 0)
        tr.appendChild(market)

        const formTd = document.createElement("td")
        formTd.style.cssText = cellPad
        const form = document.createElement("div")
        form.style.cssText = "display:flex;gap:" + T.sp[1] + ";align-items:center;flex-wrap:wrap;"

        const amount = document.createElement("input")
        amount.type = "number"
        amount.min = "1"
        amount.step = "1"
        amount.value = "1"
        amount.style.cssText = "width:64px;font-family:" + T.font.mono + ";font-size:" + T.fs.body + ";padding:" + T.sp[1] + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
        form.appendChild(amount)

        const mode = document.createElement("select")
        mode.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.body + ";padding:" + T.sp[1] + ";border:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
        const optHire = document.createElement("option")
        optHire.value = "hire"
        optHire.textContent = "hire"
        const optTrain = document.createElement("option")
        optTrain.value = "train"
        optTrain.textContent = "train"
        mode.appendChild(optHire)
        mode.appendChild(optTrain)
        form.appendChild(mode)

        const apply = document.createElement("button")
        apply.type = "button"
        apply.textContent = "Apply"
        apply.style.cssText = [
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "padding:" + T.sp[1] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body,
            "font-weight:" + T.fw.display,
            "text-transform:uppercase",
            "letter-spacing:" + T.track.caps,
            "cursor:pointer"
        ].join(";")
        form.appendChild(apply)

        const status = document.createElement("span")
        status.style.cssText = "font-family:" + T.font.mono + ";font-size:" + T.fs.body + ";color:" + T.color.slate + ";"
        form.appendChild(status)

        apply.addEventListener("click", async () => {
            if (!cat.skillId) { status.textContent = "no skillId"; status.style.color = T.color.rust; return }
            if (!server)      { status.textContent = "no server";  status.style.color = T.color.rust; return }
            const amt = parseInt(amount.value, 10)
            if (!Number.isFinite(amt) || amt <= 0) {
                status.textContent = "amount?"
                status.style.color = T.color.rust
                return
            }
            apply.disabled = true
            status.textContent = "submitting…"
            status.style.color = T.color.slate
            try {
                const result = await new window.CrewMgmtStaffPilotsApplier().hireOrTrain({
                    skillId: cat.skillId,
                    amount:  amt,
                    mode:    mode.value,
                    server:  server
                })
                if (result.status === "posted") {
                    status.textContent = "✓ submitted"
                    status.style.color = T.color.moss
                    try {
                        await new window.CrewMgmtStaffPilotsScraper().scrape(server)
                    } catch (refreshErr) {
                        console.warn("[AES crewMgmt] refresh after apply failed", refreshErr)
                    }
                } else {
                    const code = (result.error && result.error.code) || "failed"
                    status.textContent = "✗ " + code
                    status.style.color = T.color.rust
                }
            } catch (e) {
                status.textContent = "✗ threw"
                status.style.color = T.color.rust
                console.warn("[AES crewMgmt] apply threw", e)
            } finally {
                apply.disabled = false
            }
        })

        formTd.appendChild(form)
        tr.appendChild(formTd)
        return tr
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "crew-management",
        section:  "operations",
        priority: 30,
        factory:  () => new CentralHubCrewManagementTile()
    })
}
