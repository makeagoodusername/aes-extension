"use strict"

/**
 * Central-hub Inventory tile — surfaces cached per-route inventory data
 * (load percentages, low-load flight count) and offers an inline
 * single-class quick-price update via CentralInventoryQuickPriceApplier.
 *
 * Data source: chrome.storage.local under
 *   routeAssistant:inventory:<HUB>-<DEST>
 * (populated by modules/route-assistant/inventory-page-scraper.js when
 *  the user visits an inventory page; this tile is read-only on that
 *  cache).
 */
class CentralHubInventoryTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "inventory"
        this.title = "Inventory"
        this.section = "routes"
        this.priority = 20
        this.requiresAirline = true

        this._sortKey = "scrapedAt"
        this._sortDir = "desc"
        this._applyingPair = null
        this._applier = null
        this._lastTopRoute = null
    }

    watchedStorageKeys() { return ["routeAssistant:inventory:"] }

    openHandler(ctx) {
        return () => {
            const top = this._lastTopRoute
            const url = top
                ? "/app/com/inventory/" + top.hub + top.dest
                : "/app/com/markets"
            window.open(url, "_blank")
        }
    }

    async loadStatus(ctx) {
        const {rows, totals} = await window.CentralInventorySummaryStore.loadAll({})
        if (!rows.length) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No inventory cached. Visit /app/com/inventory/<HUB><DEST> to seed."
            }
        }
        this._lastTopRoute = rows[0]
        const N = rows.length
        const K = totals.lowLoadFlightCount
        const summary = N + " route" + (N === 1 ? "" : "s") + " cached"
            + (K > 0 ? ", " + K + " low-load flight" + (K === 1 ? "" : "s") : "")
        return {
            badge: String(N),
            badgeKind: K > 0
                ? window.CentralHubStatusBadges.KIND.WARN
                : window.CentralHubStatusBadges.KIND.OK,
            summary
        }
    }

    async renderBody(ctx, host, focusFilter) {
        const T = window.AESTokens
        host.textContent = ""

        // CH-5d-1: a "single-route" focus from the RA tile sticks until
        // cleared. We persist on the instance so a subsequent storage-
        // listener refresh keeps the filter active.
        if (focusFilter && focusFilter.type === "single-route") {
            this._routeFilter = {hub: focusFilter.hub, dest: focusFilter.dest}
        }

        const {rows} = await window.CentralInventorySummaryStore.loadAll({})

        if (!rows.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Open /app/com/inventory/<HUB><DEST> to seed cached inventory."
            host.appendChild(empty)
            return
        }

        let visible = rows
        if (this._routeFilter) {
            const {hub, dest} = this._routeFilter
            host.appendChild(this._renderFilterBanner(hub, dest, T))
            visible = rows.filter(r => r.hub === hub && r.dest === dest)
            if (!visible.length) {
                const empty = document.createElement("p")
                empty.style.cssText = "color:" + T.color.slate + ";margin:" + T.sp[2] + " 0 0 0;"
                empty.textContent = "No inventory cached for " + hub + "→" + dest
                    + ". Visit /app/com/inventory/" + hub + dest + " to seed it."
                host.appendChild(empty)
                return
            }
        }

        const sorted = this._sortRows(visible)
        host.appendChild(this._renderTable(sorted, ctx, T))
    }

    _renderFilterBanner(hub, dest, T) {
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
        label.textContent = "Focused on " + hub + "→" + dest
        const clearBtn = document.createElement("button")
        clearBtn.type = "button"
        clearBtn.textContent = "× clear filter"
        clearBtn.style.cssText = [
            "background:transparent",
            "color:" + T.color.rust,
            "border:" + T.geom.bw1 + " solid " + T.color.rust,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[0] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        clearBtn.addEventListener("click", () => {
            this._routeFilter = null
            this._renderBodySafe()
        })
        banner.append(label, clearBtn)
        return banner
    }

    _sortRows(rows) {
        const key = this._sortKey
        const dir = this._sortDir === "asc" ? 1 : -1
        const get = (r) => {
            switch (key) {
                case "route":     return (r.hub + r.dest)
                case "scrapedAt": return r.scrapedAt || 0
                case "Y":         return r.loads.Y == null ? -1 : r.loads.Y
                case "C":         return r.loads.C == null ? -1 : r.loads.C
                case "F":         return r.loads.F == null ? -1 : r.loads.F
                case "lowLoad":   return r.lowLoadFlightCount || 0
                default:          return 0
            }
        }
        return rows.slice().sort((a, b) => {
            const av = get(a), bv = get(b)
            if (av < bv) return -1 * dir
            if (av > bv) return  1 * dir
            return 0
        })
    }

    _renderTable(rows, ctx, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "overflow-x:auto;"

        const table = document.createElement("table")
        table.style.cssText = [
            "width:100%",
            "border-collapse:collapse",
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.body,
            "letter-spacing:" + T.track.mono
        ].join(";")

        table.appendChild(this._renderHead(T))
        const tbody = document.createElement("tbody")
        for (const row of rows) {
            tbody.appendChild(this._renderRow(row, ctx, T))
        }
        table.appendChild(tbody)
        wrap.appendChild(table)
        return wrap
    }

    _renderHead(T) {
        const thead = document.createElement("thead")
        const tr = document.createElement("tr")
        const cols = [
            {key: "route",     label: "Route"},
            {key: "scrapedAt", label: "Last seen"},
            {key: "Y",         label: "Y%"},
            {key: "C",         label: "C%"},
            {key: "F",         label: "F%"},
            {key: "lowLoad",   label: "Low-load"},
            {key: null,        label: "Quick price"}
        ]
        for (const c of cols) {
            const th = document.createElement("th")
            th.textContent = c.label
            th.style.cssText = [
                "text-align:left",
                "padding:" + T.sp[1] + " " + T.sp[2],
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "color:" + T.color.oxide,
                "font-weight:" + T.fw.display,
                "text-transform:uppercase",
                "font-family:" + T.font.display,
                "letter-spacing:" + T.track.caps,
                "font-size:" + T.fs.micro,
                "white-space:nowrap"
            ].join(";")
            if (c.key) {
                th.style.cursor = "pointer"
                th.dataset.sortKey = c.key
                if (this._sortKey === c.key) {
                    th.textContent = c.label + " " + (this._sortDir === "asc" ? "▲" : "▼")
                }
                th.addEventListener("click", () => {
                    if (this._sortKey === c.key) {
                        this._sortDir = this._sortDir === "asc" ? "desc" : "asc"
                    } else {
                        this._sortKey = c.key
                        this._sortDir = (c.key === "route") ? "asc" : "desc"
                    }
                    this.refresh()
                })
            }
            tr.appendChild(th)
        }
        thead.appendChild(tr)
        return thead
    }

    _renderRow(row, ctx, T) {
        const tr = document.createElement("tr")
        tr.style.cssText = "cursor:pointer;"
        tr.addEventListener("mouseenter", () => { tr.style.background = T.color.bone2 })
        tr.addEventListener("mouseleave", () => { tr.style.background = "" })
        tr.addEventListener("click", (e) => {
            if (e.target.closest(".aes-inv-quick-price")) return
            const url = "/app/com/inventory/" + row.hub + row.dest
            window.open(url, "_blank")
        })

        const cells = [
            row.hub + row.dest,
            window.CentralInventorySummaryStore.formatRelative(row.scrapedAt),
            CentralHubInventoryTile._formatLoad(row.loads.Y),
            CentralHubInventoryTile._formatLoad(row.loads.C),
            CentralHubInventoryTile._formatLoad(row.loads.F),
            row.lowLoadFlightCount > 0 ? String(row.lowLoadFlightCount) : "—"
        ]
        for (let i = 0; i < cells.length; i++) {
            const td = document.createElement("td")
            td.textContent = cells[i]
            td.style.cssText = [
                "padding:" + T.sp[1] + " " + T.sp[2],
                "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule,
                "color:" + T.color.oxide2,
                "white-space:nowrap"
            ].join(";")
            if (i === 0) {
                td.style.color = T.color.oxide
                td.style.fontWeight = String(T.fw.display)
            }
            if (i === 5 && row.lowLoadFlightCount > 0) {
                td.style.color = T.color.amber
            }
            tr.appendChild(td)
        }

        const qpTd = document.createElement("td")
        qpTd.className = "aes-inv-quick-price"
        qpTd.style.cssText = [
            "padding:" + T.sp[1] + " " + T.sp[2],
            "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule
        ].join(";")
        qpTd.appendChild(this._renderQuickPriceCell(row, ctx, T, qpTd))
        tr.appendChild(qpTd)

        return tr
    }

    static _formatLoad(load) {
        if (load == null) return "—"
        return Math.round(load * 100) + "%"
    }

    _renderQuickPriceCell(row, ctx, T, hostTd) {
        const setBtn = document.createElement("button")
        setBtn.type = "button"
        setBtn.className = "aes-inv-qp-set"
        setBtn.textContent = "Set price"
        setBtn.style.cssText = [
            "background:transparent",
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[0] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        setBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            hostTd.textContent = ""
            hostTd.appendChild(this._renderQuickPriceForm(row, ctx, T, hostTd))
        })
        return setBtn
    }

    _renderQuickPriceForm(row, ctx, T, hostTd) {
        const form = document.createElement("div")
        form.style.cssText = "display:flex;align-items:center;gap:" + T.sp[1] + ";"

        const select = document.createElement("select")
        select.style.cssText = [
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "padding:0 " + T.sp[1],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro
        ].join(";")
        for (const cls of ["Y", "C", "F"]) {
            const opt = document.createElement("option")
            opt.value = cls
            opt.textContent = cls
            select.appendChild(opt)
        }

        const input = document.createElement("input")
        input.type = "number"
        input.min = "0"
        input.step = "1"
        input.placeholder = "price"
        input.style.cssText = [
            "width:70px",
            "background:" + T.color.bone,
            "color:" + T.color.oxide,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "padding:0 " + T.sp[1],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro
        ].join(";")

        const applyBtn = document.createElement("button")
        applyBtn.type = "button"
        applyBtn.textContent = "Apply"
        applyBtn.style.cssText = [
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "border:" + T.geom.bw1 + " solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[0] + " " + T.sp[2],
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")

        const cancelBtn = document.createElement("button")
        cancelBtn.type = "button"
        cancelBtn.textContent = "×"
        cancelBtn.title = "Cancel"
        cancelBtn.style.cssText = [
            "background:transparent",
            "color:" + T.color.slate,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "padding:" + T.sp[0] + " " + T.sp[2],
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "cursor:pointer"
        ].join(";")
        cancelBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            hostTd.textContent = ""
            hostTd.appendChild(this._renderQuickPriceCell(row, ctx, T, hostTd))
        })

        applyBtn.addEventListener("click", async (e) => {
            e.stopPropagation()
            const classKey = select.value
            const newPrice = parseInt(input.value, 10)
            if (!isFinite(newPrice) || newPrice < 0) {
                window.RouteAssistantToast.warn("Enter a non-negative integer price.")
                input.focus()
                return
            }
            applyBtn.disabled = true
            cancelBtn.disabled = true
            await this._doQuickPriceApply(row, ctx, classKey, newPrice)
            applyBtn.disabled = false
            cancelBtn.disabled = false
        })

        form.append(select, input, applyBtn, cancelBtn)

        for (const el of [select, input]) {
            el.addEventListener("click", (e) => e.stopPropagation())
        }

        return form
    }

    async _doQuickPriceApply(row, ctx, classKey, newPrice) {
        if (this._applyingPair) return
        const pairLabel = row.hub + "-" + row.dest
        this._applyingPair = pairLabel

        this._applier = this._applier || new window.CentralInventoryQuickPriceApplier({applyEnabled: true})

        const progress = window.RouteAssistantToast.progress(
            "Applying " + classKey + " " + newPrice + " on " + pairLabel,
            {progressPct: 30}
        )

        let result = null
        try {
            result = await this._applier.apply({
                hub:       row.hub,
                dest:      row.dest,
                classKey:  classKey,
                newPrice:  newPrice,
                server:    ctx && ctx.server
            })
        } catch (e) {
            result = {
                status: "failed",
                hub:    row.hub,
                dest:   row.dest,
                classKey,
                error:  {code: "applyThrew", message: e && e.message || String(e)}
            }
        }

        if (progress) {
            const status = result && result.status
            if (status === "verified") {
                progress.complete({
                    type:    "success",
                    message: classKey + " " + (result.prev != null ? result.prev : "?")
                           + " → " + result.new + " verified on " + pairLabel
                })
            } else if (status === "posted") {
                progress.complete({
                    type:    "warn",
                    message: classKey + " posted but not verified on " + pairLabel
                           + " — refresh inventory page to confirm"
                })
            } else if (status === "dry-run") {
                progress.complete({
                    type:    "info",
                    message: "Dry-run: would post " + classKey + " " + result.new + " on " + pairLabel
                })
            } else {
                const code = (result && result.error && result.error.code) || "failed"
                const msg  = (result && result.error && result.error.message) || ""
                progress.complete({
                    type:    "error",
                    message: code + (msg ? ": " + msg : "")
                })
            }
        }

        this._applyingPair = null
        await this.refresh()
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "inventory",
        section: "routes",
        priority: 20,
        factory: () => new CentralHubInventoryTile()
    })
}
