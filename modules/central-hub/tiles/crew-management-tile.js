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
        this.section = "operations"
        this.priority = 30
        this.requiresAirline = true
    }

    watchedStorageKeys() {
        const ak = window.AesAccountKey
        const overviewLatest = ak ? ak.acctKey("crewMgmt", "staffOverview:latest") : "crewMgmt:staffOverview:latest"
        return ["crewMgmt:pilots", overviewLatest]
    }

    openHref() { return "/action/enterprise/staffPilots" }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        // CH-5d-4: clicking the badge (e.g. "3 SHORT") drills into the tile
        // with the short-categories filter pre-applied.
        if (this.badgeEl) {
            this.badgeEl.style.cursor = "pointer"
            this.badgeEl.title = "Show short categories"
            this.badgeEl.addEventListener("click", (e) => {
                e.stopPropagation()
                if (!window.CentralHubBus) return
                const status = this._lastStatus
                if (!status || !status.badge || status.badge.indexOf("SHORT") < 0) {
                    if (!this.expanded) this.toggle()
                    return
                }
                window.CentralHubBus.emit("open-tile", {
                    tileId: "crew-management",
                    expand: true,
                    scrollIntoView: true,
                    filter: {type: "short"},
                    source: "crew-badge"
                })
            })
        }
    }

    async _loadRecord() {
        const blob = await chrome.storage.local.get(["crewMgmt:pilots"])
        return blob["crewMgmt:pilots"] || null
    }

    async loadStatus() {
        const KIND = window.CentralHubStatusBadges.KIND
        const rec = await this._loadRecord()
        const overview = window.CrewMgmtStaffOverviewStore
            ? await window.CrewMgmtStaffOverviewStore.loadLatest()
            : null
        const reputation = window.AesCompanyReputationStore
            ? await window.AesCompanyReputationStore.loadLatest()
            : null
        const costSummary = CentralHubCrewManagementTile._formatCostSummary(overview)
        const reputationSummary = CentralHubCrewManagementTile._formatReputationSummary(reputation)

        if (!rec || !Array.isArray(rec.categories) || !rec.categories.length) {
            return {
                badge:     "—",
                badgeKind: KIND.MUTED,
                summary:   "No crew data — visit /action/enterprise/staffPilots to seed." + costSummary + reputationSummary
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
                summary:   employed + "/" + required + " pilots employed · " + missing + " short across " + cats.length + " categor" + (cats.length === 1 ? "y" : "ies") + costSummary + reputationSummary
            }
        }
        return {
            badge:     employed + "/" + required,
            badgeKind: KIND.OK,
            summary:   cats.length + " categor" + (cats.length === 1 ? "y" : "ies") + " · all rated" + costSummary + reputationSummary
        }
    }

    static _formatCostSummary(overview) {
        if (!overview || !overview.totals) return ""
        const wk = overview.totals.weeklyTotal
        const next = overview.totals.nextWeekTotal
        if (!Number.isFinite(wk)) return ""
        const fmt = n => Math.round(n).toLocaleString() + " AS$"
        const tail = (Number.isFinite(next) && next !== wk)
            ? ` → ${fmt(next)} next wk`
            : ""
        return ` · payroll ${fmt(wk)}/wk${tail}`
    }

    static _formatReputationSummary(reputation) {
        if (!reputation || !reputation.ratingLabel) return ""
        return " · rating " + reputation.ratingLabel
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        host.textContent = ""

        // CH-5d-4: pin the short-only filter on the instance.
        if (focusFilter && focusFilter.type === "short") {
            this._shortOnly = true
        }

        const rec = await this._loadRecord()
        const overview = window.CrewMgmtStaffOverviewStore
            ? await window.CrewMgmtStaffOverviewStore.loadLatest()
            : null
        const reputation = window.AesCompanyReputationStore
            ? await window.AesCompanyReputationStore.loadLatest()
            : null
        const repStrip = this._renderReputationPayrollStrip(reputation, overview, T)
        if (repStrip) host.appendChild(repStrip)

        if (!rec || !Array.isArray(rec.categories) || !rec.categories.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Visit /action/enterprise/staffPilots to populate this tile."
            host.appendChild(empty)
            return
        }
        const server = (ctx && ctx.server) || ""

        const visible = this._shortOnly
            ? rec.categories.filter(c => (c.missing || 0) > 0)
            : rec.categories
        if (this._shortOnly) host.appendChild(this._renderShortBanner(visible.length, T))

        if (this._shortOnly && !visible.length) {
            const ok = document.createElement("p")
            ok.style.cssText = "color:" + T.color.moss + ";margin:" + T.sp[2] + " 0 0 0;"
            ok.textContent = "All categories rated. No shortages."
            host.appendChild(ok)
            return
        }

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
        for (const c of visible) {
            tbody.appendChild(this._buildRow(T, c, server))
        }
        table.appendChild(tbody)
        host.appendChild(table)

        const meta = document.createElement("div")
        meta.style.cssText = "margin-top:" + T.sp[3] + ";color:" + T.color.slate + ";font-family:" + T.font.mono + ";font-size:" + T.fs.body + ";"
        meta.textContent = "Last scraped " + new Date(rec.scrapedAt || 0).toLocaleString()
        host.appendChild(meta)
    }

    _renderReputationPayrollStrip(reputation, overview, T) {
        if (!reputation && !overview) return null
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:grid",
            "grid-template-columns:repeat(auto-fit,minmax(160px,1fr))",
            "gap:" + T.sp[2],
            "margin:0 0 " + T.sp[3] + " 0",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body
        ].join(";")
        const cells = []
        if (reputation && reputation.ratingLabel) {
            cells.push(["Rating", reputation.ratingLabel + " / " + (reputation.ratingScore || "—")])
        }
        if (overview && overview.totals) {
            const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString() + " AS$/wk" : "—"
            cells.push(["Payroll", fmt(overview.totals.weeklyTotal)])
            if (Number.isFinite(overview.totals.nextWeekTotal)
                    && overview.totals.nextWeekTotal !== overview.totals.weeklyTotal) {
                cells.push(["Next week", fmt(overview.totals.nextWeekTotal)])
            }
        }
        const risks = CentralHubCrewManagementTile._topPayRiskRoles(overview)
        if (risks.length) cells.push(["Pay risks", risks.join(", ")])
        for (const pair of cells) {
            const box = document.createElement("div")
            box.style.cssText = [
                "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "padding:" + T.sp[1] + " " + T.sp[2],
                "background:" + T.color.bone
            ].join(";")
            const label = document.createElement("div")
            label.textContent = pair[0]
            label.style.cssText = "color:" + T.color.slate + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
            const value = document.createElement("div")
            value.textContent = pair[1]
            value.style.cssText = "color:" + T.color.oxide + ";margin-top:" + T.sp[0] + ";"
            box.append(label, value)
            wrap.appendChild(box)
        }
        return wrap.childNodes.length ? wrap : null
    }

    static _topPayRiskRoles(overview) {
        if (!overview || !Array.isArray(overview.sections)) return []
        const rows = []
        for (const section of overview.sections) {
            for (const role of (section && section.roles) || []) {
                const shortfall = Math.max(0, (role.required || 0) - (role.active || 0))
                const moodRisk = (role.moodDigit != null && role.moodDigit <= 2) ? 1 : 0
                const trendRisk = role.moodTrend < 0 ? 1 : 0
                const pending = role.pendingChange ? -0.5 : 0
                const score = shortfall * 2 + moodRisk + trendRisk + pending
                if (score <= 0) continue
                rows.push({label: role.label || section.group, score})
            }
        }
        rows.sort((a, b) => b.score - a.score)
        return rows.slice(0, 3).map(r => r.label)
    }

    _renderShortBanner(count, T) {
        const banner = document.createElement("div")
        banner.style.cssText = [
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:" + T.sp[2],
            "padding:" + T.sp[1] + " " + T.sp[2],
            "margin-bottom:" + T.sp[2],
            "background:" + T.color.rustSoft,
            "color:" + T.color.rust,
            "border:" + T.geom.bw1 + " solid " + T.color.rust,
            "border-radius:" + T.geom.radius,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.body
        ].join(";")
        const label = document.createElement("span")
        label.textContent = count > 0
            ? "Showing " + count + " short categor" + (count === 1 ? "y" : "ies") + " — applier ready below."
            : "All categories rated."
        const clear = document.createElement("button")
        clear.type = "button"
        clear.textContent = "× show all"
        clear.style.cssText = "background:transparent;color:" + T.color.rust
            + ";border:" + T.geom.bw1 + " solid " + T.color.rust + ";border-radius:" + T.geom.radius
            + ";padding:" + T.sp[0] + " " + T.sp[2] + ";font-family:" + T.font.display
            + ";font-size:" + T.fs.micro + ";letter-spacing:" + T.track.caps
            + ";text-transform:uppercase;cursor:pointer;"
        clear.addEventListener("click", () => {
            this._shortOnly = false
            this._renderBodySafe()
        })
        banner.append(label, clear)
        return banner
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
