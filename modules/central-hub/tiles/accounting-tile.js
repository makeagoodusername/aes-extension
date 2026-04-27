"use strict"

/**
 * Accounting tile — surfaces the most recent income/balance/bank week the
 * user has scraped, plus the four sister-page records (leasing, capital,
 * assets, cashflow). The full snapshot history + profitability cuts +
 * reconciliation views live in `modules/accounting/panel.js` on the
 * /app/finance/accounting* pages; this tile shows the latest at a glance
 * and routes the user to whichever finance page they want to refresh.
 *
 * Reads chrome.storage.local directly with the keying scheme documented
 * in `modules/accounting/snapshot-store.js`:
 *   <server><airline>accounting:index
 *   <server><airline>accounting:income:<weekId>     (etc.)
 *   <server><airline>accounting:leasing             (sister, single blob)
 */
class CentralHubAccountingTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "accounting"
        this.title = "Accounting"
        this.section = "finance"
        this.priority = 10
        this.requiresAirline = false
    }

    watchedStorageKeys(ctx) {
        return [String(ctx && ctx.server || "") + ""]
    }

    openHref() { return "/app/finance/accounting" }

    _airlineKey() {
        try {
            const a = AES.getAirlineCode()
            if (a && a.code) return a.code
        } catch (_) { /* fall through */ }
        return (this.ctx && this.ctx.airline) || ""
    }

    async _loadIndexAndSisters() {
        const server = (this.ctx && this.ctx.server) || ""
        const airline = this._airlineKey()
        if (!server || !airline) return null
        const indexKey = server + airline + "accounting:index"
        const sisterKeys = ["leasing", "capital", "assets", "cashflow"].map(t =>
            server + airline + "accounting:" + t)
        const blob = await chrome.storage.local.get([indexKey].concat(sisterKeys))
        return {
            index: Array.isArray(blob[indexKey]) ? blob[indexKey] : [],
            sisters: sisterKeys.reduce((acc, k) => {
                const t = k.split("accounting:").pop()
                acc[t] = blob[k] || null
                return acc
            }, {})
        }
    }

    async loadStatus() {
        const data = await this._loadIndexAndSisters()
        if (!data) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "Airline context unavailable; visit /app/finance/accounting."
            }
        }
        const sisters = Object.values(data.sisters).filter(Boolean).length
        const idx = data.index
        if (!idx.length && !sisters) {
            return {
                badge: "—",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary: "No accounting snapshots yet. Visit /app/finance/accounting/{0,1,2}."
            }
        }
        const newest = idx[0] || null
        const week = newest && (newest.weekId || newest.weekClosesAt) || ""
        const tabsHave = newest
            ? [newest.hasIncome ? "income" : null, newest.hasBalance ? "balance" : null, newest.hasBank ? "bank" : null].filter(Boolean)
            : []
        return {
            badge: idx.length + " WEEKS",
            badgeKind: window.CentralHubStatusBadges.KIND.OK,
            summary: idx.length + " weeks · "
                + (week ? "newest " + week + (tabsHave.length ? " (" + tabsHave.join(", ") + ")" : "") + " · " : "")
                + sisters + "/4 sister pages"
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const data = await this._loadIndexAndSisters()
        if (!data || (!data.index.length && !Object.values(data.sisters).filter(Boolean).length)) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Visit /app/finance/accounting/{0,1,2} or the leasing/capital/assets/cashflow pages to populate."
            host.appendChild(empty)
            return
        }

        if (data.index.length) {
            const heading = document.createElement("h4")
            heading.textContent = "Recent weeks"
            heading.style.cssText = this._headingStyle(T)
            host.appendChild(heading)
            const table = document.createElement("table")
            table.style.cssText = "width:100%;border-collapse:collapse;font-family:"
                + T.font.mono + ";font-size:" + T.fs.body + ";letter-spacing:" + T.track.mono + ";margin-bottom:" + T.sp[3] + ";"
            for (const r of data.index.slice(0, 6)) {
                const tr = document.createElement("tr")
                tr.style.cssText = "border-bottom:" + T.geom.bw1 + " solid " + T.color.paperRule + ";"
                const tabs = [r.hasIncome ? "I" : "·", r.hasBalance ? "B" : "·", r.hasBank ? "K" : "·"].join("")
                tr.innerHTML =
                    "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";'>" + escapeHtml(r.weekId || "?") + "</td>" +
                    "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";color:" + T.color.oxide2 + ";'>"
                        + escapeHtml(r.weekClosesAt || "—") + "</td>" +
                    "<td style='padding:" + T.sp[1] + " " + T.sp[2] + ";text-align:right;color:" + T.color.slate + ";'>"
                        + tabs + "</td>"
                table.appendChild(tr)
            }
            host.appendChild(table)
        }

        const heading2 = document.createElement("h4")
        heading2.textContent = "Sister pages"
        heading2.style.cssText = this._headingStyle(T)
        host.appendChild(heading2)
        const links = [
            {type: "leasing",  href: "/app/finance/leasing",   label: "Leasing"},
            {type: "capital",  href: "/app/finance/capital",   label: "Capital"},
            {type: "assets",   href: "/app/finance/assets",    label: "Assets"},
            {type: "cashflow", href: "/app/finance/cashflow", label: "Cash flow"}
        ]
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[2] + ";"
        for (const l of links) {
            const have = !!data.sisters[l.type]
            const a = document.createElement("a")
            a.href = l.href
            a.textContent = l.label + (have ? " ✓" : " —")
            a.style.cssText = [
                "padding:" + T.sp[1] + " " + T.sp[3],
                "background:" + (have ? T.color.mossSoft : T.color.bone2),
                "color:" + (have ? T.color.moss : T.color.oxide2),
                "border:" + T.geom.bw1 + " solid " + (have ? T.color.moss : T.color.paperRule),
                "font-family:" + T.font.display,
                "font-size:" + T.fs.body,
                "text-decoration:none"
            ].join(";")
            wrap.appendChild(a)
        }
        host.appendChild(wrap)
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
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "accounting",
        section: "finance",
        priority: 10,
        factory: () => new CentralHubAccountingTile()
    })
}
