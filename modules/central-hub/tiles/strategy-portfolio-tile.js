"use strict"

// Keep helper names private to this tile. Strategy hub tiles are loaded
// into the same content-script world, so generic names like `_text` and
// `_chip` otherwise shadow siblings that render later.
;(function () {

/**
 * Strategy Portfolio tile (Slice 18 — Multi-Game-World Federation).
 *
 * Renders only when the user has registered ≥ 2 game worlds. Shows
 * per-world rows (profit, bank balance, runway) sorted by allocation
 * priority, plus the engine's one-line recommendation. Click a row →
 * opens the strategy panel scoped to that world's (server, airline).
 *
 * Section "operations" priority 4 — sits below the Hub Designer tile.
 */
class CentralHubStrategyPortfolioTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "strategy-portfolio"
        this.title = "Portfolio (Multi-World)"
        this.section = "operations"
        this.priority = 4
        this.requiresAirline = false       // visible even on aggregator pages
        this._report = null
    }

    watchedStorageKeys() {
        return [
            "aesStrategy:portfolio:multiWorld",
            "aesAccounts"
        ]
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this._mountCtx = ctx || null
        this.subscribeBus("strategy:portfolio:rebuilt", () => { this.refresh().catch(() => {}) })
    }

    openHandler() {
        return () => this._openLeader()
    }

    async loadStatus(ctx) {
        const KIND = window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND
        const muted = KIND ? KIND.MUTED : "muted"
        const ok    = KIND ? KIND.OK    : "ok"
        const warn  = KIND ? KIND.WARN  : "warn"

        const portfolio = window.AesStrategyMultiWorldPortfolio
        if (!portfolio) {
            return {badge: "OFF", badgeKind: muted,
                summary: "Portfolio module not loaded — refresh the dashboard."}
        }

        const worlds = await portfolio.listWorlds()
        if (worlds.length < 2) {
            return {badge: "—", badgeKind: muted,
                summary: worlds.length === 0
                    ? "No registered worlds yet — visit a dashboard to register one."
                    : "Single-world account — portfolio activates with a 2nd world."}
        }

        let report
        try { report = await portfolio.build() }
        catch (err) {
            console.warn("[AES portfolio tile] build failed", err)
            return {badge: "ERR", badgeKind: warn, summary: "Portfolio build failed — see console."}
        }
        this._report = report

        const tone = report.totals.profitWeekly < 0 ? warn : ok
        return {
            badge:     report.totals.worldCount + " WORLDS",
            badgeKind: tone,
            summary:   report.totals.tailCount + " tails · "
                       + _fmtMoney(report.totals.profitWeekly) + "/wk · "
                       + _fmtMoney(report.totals.bankBalance) + " bank"
        }
    }

    async renderBody(ctx, hostEl) {
        hostEl.textContent = ""
        const T = window.AESTokens
        const portfolio = window.AesStrategyMultiWorldPortfolio
        if (!portfolio) {
            hostEl.appendChild(_text(T, "Portfolio module not loaded."))
            return
        }
        const worlds = await portfolio.listWorlds()
        if (worlds.length < 2) {
            hostEl.appendChild(_text(T, "Visit a 2nd game world's dashboard so AES can register it; the portfolio activates automatically."))
            return
        }

        const report = this._report || await portfolio.build()
        this._report = report

        const recommendation = document.createElement("div")
        recommendation.style.cssText = [
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "border:1px solid " + T.color.paperRule,
            "border-left:3px solid " + T.color.oxide,
            "border-radius:" + T.geom.radius,
            "margin-bottom:" + T.sp[3],
            "font:600 12px " + T.font.display,
            "color:" + T.color.oxide
        ].join(";")
        recommendation.textContent = report.recommendation
        hostEl.appendChild(recommendation)

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";"
        const sorted = report.worlds.slice().sort((a, b) => b.allocationPriority - a.allocationPriority)
        for (const w of sorted) list.appendChild(this._renderWorldRow(T, w))
        hostEl.appendChild(list)

        const footer = document.createElement("div")
        footer.style.cssText = [
            "display:flex", "justify-content:space-between", "align-items:center",
            "margin-top:" + T.sp[3],
            "padding:" + T.sp[2] + " 0",
            "border-top:1px solid " + T.color.paperRule,
            "color:" + T.color.oxide2,
            "font:11px " + T.font.display
        ].join(";")
        const meta = document.createElement("span")
        const ageMin = Math.max(0, Math.round((Date.now() - report.builtAt) / 60000))
        meta.textContent = "Built " + (ageMin < 1 ? "just now" : ageMin + "m ago")
                         + " · sandbox-isolated reads · advisory aggregation"
        footer.appendChild(meta)
        const refresh = document.createElement("button")
        refresh.type = "button"
        refresh.textContent = "Rebuild"
        refresh.style.cssText = [
            "background:" + T.color.oxide, "color:" + T.color.bone,
            "border:none", "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font:600 11px " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        refresh.addEventListener("click", () => {
            portfolio.build({force: true}).then(r => {
                this._report = r
                this.refresh().catch(() => {})
            }).catch(() => {})
        })
        footer.appendChild(refresh)
        hostEl.appendChild(footer)
    }

    _renderWorldRow(T, w) {
        const row = document.createElement("div")
        row.dataset.aesStrategyPortfolioWorld = w.server || ""
        row.dataset.aesStrategyPortfolioAirline = w.airlineIdentity || w.airline || ""
        row.style.cssText = [
            "display:grid",
            "grid-template-columns:1fr auto auto auto",
            "gap:" + T.sp[2],
            "align-items:center",
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "border:1px solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius,
            "cursor:pointer"
        ].join(";")
        row.addEventListener("click", () => this._openWorld(w))

        const left = document.createElement("div")
        left.style.cssText = "min-width:0;"
        const name = document.createElement("div")
        name.style.cssText = "font:600 12px " + T.font.display + ";color:" + T.color.oxide
                           + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        name.textContent = w.displayName + " · " + w.server
        left.appendChild(name)
        const sub = document.createElement("div")
        sub.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
        sub.textContent = w.tailCount + " tails · " + (w.seatTotal ? w.seatTotal.toLocaleString() + " seats" : "—")
                        + (w.cashRunwayWeeks != null ? " · runway " + w.cashRunwayWeeks.toFixed(1) + "w" : "")
        left.appendChild(sub)
        row.appendChild(left)

        const profit = document.createElement("div")
        const negative = w.profitWeekly < 0
        profit.textContent = _fmtMoney(w.profitWeekly) + "/wk"
        profit.style.cssText = "font:600 12px " + T.font.mono
                             + ";color:" + (negative ? T.color.crimson : T.color.moss) + ";text-align:right;"
        row.appendChild(profit)

        const bank = document.createElement("div")
        bank.textContent = _fmtMoney(w.bankBalance)
        bank.style.cssText = "font:11px " + T.font.mono + ";color:" + T.color.oxide2 + ";text-align:right;"
        row.appendChild(bank)

        const prio = _chip(T, "p " + w.allocationPriority.toFixed(2),
            w.allocationPriority >= 0.7 ? "ok" : w.allocationPriority >= 0.4 ? "warn" : "muted")
        row.appendChild(prio)
        return row
    }

    _openWorld(w) {
        try {
            if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                const ret = window.AesStrategyPanel.open({
                    server:      w.server,
                    airlineCode: w.airlineIdentity || w.airline || null
                })
                if (ret && typeof ret.catch === "function") {
                    ret.catch(e => console.warn("[AES portfolio tile] open panel failed", e))
                }
            }
        } catch (e) { console.warn("[AES portfolio tile] open panel threw", e) }
    }

    _openLeader() {
        if (!this._report || !this._report.worlds.length) return
        const top = this._report.worlds.slice()
            .sort((a, b) => b.allocationPriority - a.allocationPriority)[0]
        this._openWorld(top)
    }
}

function _text(T, s) {
    const el = document.createElement("div")
    el.style.cssText = "color:" + T.color.oxide2 + ";font:12px " + T.font.display + ";"
    el.textContent = s
    return el
}

function _chip(T, label, tone) {
    const map = {
        ok:    {color: T.color.moss,    bg: T.color.mossSoft},
        warn:  {color: T.color.amber,   bg: T.color.amberSoft},
        err:   {color: T.color.crimson, bg: T.color.crimsonSoft},
        muted: {color: T.color.oxide2,  bg: "transparent"}
    }
    const s = map[tone] || map.muted
    const chip = document.createElement("span")
    chip.textContent = label
    chip.style.cssText = [
        "display:inline-block", "padding:1px 8px",
        "border:1px solid " + s.color, "border-radius:10px",
        "background:" + s.bg, "color:" + s.color,
        "font:600 10px " + T.font.mono,
        "letter-spacing:0.04em", "text-transform:uppercase"
    ].join(";")
    return chip
}

function _fmtMoney(v) {
    if (!isFinite(v)) return "—"
    const abs = Math.abs(v)
    if (abs >= 1e9) return (v < 0 ? "−$" : "$") + (abs / 1e9).toFixed(2) + "B"
    if (abs >= 1e6) return (v < 0 ? "−$" : "$") + (abs / 1e6).toFixed(1) + "M"
    if (abs >= 1e3) return (v < 0 ? "−$" : "$") + (abs / 1e3).toFixed(0) + "k"
    return (v < 0 ? "−$" : "$") + Math.round(abs)
}

window.CentralHubStrategyPortfolioTile = CentralHubStrategyPortfolioTile

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "strategy-portfolio",
        section:  "operations",
        priority: 4,
        factory:  () => new CentralHubStrategyPortfolioTile()
    })
}

})()
