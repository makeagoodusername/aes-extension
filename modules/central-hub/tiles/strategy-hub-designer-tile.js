"use strict"

// Keep helper names private to this tile. Strategy hub tiles are loaded
// into the same content-script world, so generic names like `_text` and
// `_topCard` otherwise shadow siblings that render later.
;(function () {

/**
 * Strategy Hub Designer tile (Slice 14).
 *
 * Surfaces `AesStrategy.designHubs(snapshot)` proposals on the Central
 * Hub. Status badge counts open/close candidates; body shows the top
 * open and top close inline. Click → opens the dedicated modal where
 * the user can scan the full list and copy IATA codes.
 *
 * Hub moves are advisory-only — no Apply path. The modal banner makes
 * that explicit; the tile keeps the "advisory" tone in the badge.
 */
class CentralHubStrategyHubDesignerTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "strategy-hub-designer"
        this.title = "Hub Network Designer"
        this.section = "operations"
        this.priority = 3
        this.requiresAirline = true
        this._report = null
    }

    watchedStorageKeys() {
        return [
            "aesStrategy:plan:applied",
            "accounting:lastSnapshotTs",
            "settings"
        ]
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this._mountCtx = ctx || null
        this.subscribeBus("strategy:decision-applied", () => { this.refresh().catch(() => {}) })
    }

    openHandler() {
        return () => this._openModal()
    }

    async loadStatus(ctx) {
        const KIND = window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND
        const muted = KIND ? KIND.MUTED : "muted"
        const ok    = KIND ? KIND.OK    : "ok"
        const warn  = KIND ? KIND.WARN  : "warn"

        if (!window.AesStrategy || typeof window.AesStrategy.designHubs !== "function") {
            return {badge: "OFF", badgeKind: muted,
                summary: "Hub Designer module not loaded — refresh the dashboard."}
        }

        const report = await this._build(ctx)
        if (!report) {
            return {badge: "—", badgeKind: muted,
                summary: "Snapshot too thin to design hubs (need fleet + routes)."}
        }
        this._report = report
        const s = report.summary
        const total = s.openProposals + s.closeProposals
        const tone = total === 0 ? muted : (s.closeProposals > 0 ? warn : ok)
        return {
            badge: total === 0 ? "NONE" : (s.openProposals + "↑/" + s.closeProposals + "↓"),
            badgeKind: tone,
            summary: s.ourHubCount + " hubs · " + s.candidateCount + " candidates"
                + " · network-effect " + s.networkEffectScore.toFixed(2)
                + " · advisory only"
        }
    }

    async renderBody(ctx, hostEl) {
        hostEl.textContent = ""
        const T = window.AESTokens
        const report = this._report || await this._build(ctx)
        if (!report) {
            hostEl.appendChild(_text(T, "Open the AS dashboard so the snapshot can populate."))
            return
        }
        this._report = report

        const grid = document.createElement("div")
        grid.style.cssText = [
            "display:grid",
            "grid-template-columns:1fr 1fr",
            "gap:" + T.sp[3],
            "margin-bottom:" + T.sp[3]
        ].join(";")
        grid.appendChild(_topCard(T, "Top open", report.opens[0], _renderOpenLine))
        grid.appendChild(_topCard(T, "Top close", report.closes[0], _renderCloseLine))
        hostEl.appendChild(grid)

        const footer = document.createElement("div")
        footer.style.cssText = [
            "display:flex", "justify-content:space-between", "align-items:center",
            "padding:" + T.sp[2] + " 0",
            "border-top:1px solid " + T.color.paperRule,
            "color:" + T.color.oxide2,
            "font:11px " + T.font.display
        ].join(";")
        const meta = document.createElement("span")
        meta.textContent = "advisory only · hubs never auto-apply"
        footer.appendChild(meta)

        const cta = document.createElement("button")
        cta.type = "button"
        cta.textContent = "Open designer →"
        cta.style.cssText = [
            "background:" + T.color.oxide, "color:" + T.color.bone,
            "border:none", "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font:600 11px " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        cta.addEventListener("click", () => this._openModal())
        footer.appendChild(cta)
        hostEl.appendChild(footer)
    }

    async _build(ctx) {
        const ns = window.AesStrategy
        if (!ns || typeof ns.snapshot !== "function" || typeof ns.designHubs !== "function") return null
        try {
            const snap = await ns.snapshot({
                server:      (ctx && ctx.server)  || null,
                airlineCode: (ctx && ctx.airline) || null,
                accountId:   (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
            })
            if (!snap) return null
            return ns.designHubs(snap) || null
        } catch (err) {
            console.warn("[AES hub-designer tile] build failed", err)
            return null
        }
    }

    _openModal() {
        const ctx = this._mountCtx || {}
        try {
            if (window.AesStrategyHubDesignerModal && typeof window.AesStrategyHubDesignerModal.open === "function") {
                window.AesStrategyHubDesignerModal.open({
                    server:    ctx.server  || null,
                    airline:   ctx.airline || null,
                    accountId: (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
                })
            }
        } catch (e) { console.warn("[AES hub-designer tile] open modal threw", e) }
        setTimeout(() => {
            const visibleDialog = Array.prototype.slice.call(
                document.querySelectorAll(".modal, [role='dialog'], .aes-strategy-modal")
            ).some(el => {
                try {
                    const rect = el.getBoundingClientRect()
                    const style = getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0
                        && style.display !== "none"
                        && style.visibility !== "hidden"
                } catch (_) { return false }
            })
            if (!visibleDialog && typeof this._showOpenFallbackFeedback === "function") {
                if (!this.expanded && typeof this.toggle === "function") {
                    this.toggle()
                } else {
                    this._showOpenFallbackFeedback()
                }
            }
        }, 160)
    }
}

function _text(T, s) {
    const el = document.createElement("div")
    el.style.cssText = "color:" + T.color.oxide2 + ";font:12px " + T.font.display + ";"
    el.textContent = s
    return el
}

function _topCard(T, title, item, renderInner) {
    const card = document.createElement("div")
    card.style.cssText = [
        "border:1px solid " + T.color.paperRule,
        "border-radius:" + T.geom.radius,
        "padding:" + T.sp[2] + " " + T.sp[3],
        "background:" + T.color.bone2,
        "min-height:90px"
    ].join(";")
    const h = document.createElement("div")
    h.textContent = title
    h.style.cssText = [
        "font:600 11px " + T.font.display,
        "letter-spacing:" + T.track.caps,
        "text-transform:uppercase",
        "color:" + T.color.oxide,
        "padding-bottom:" + T.sp[1],
        "margin-bottom:" + T.sp[2],
        "border-bottom:1px solid " + T.color.paperRule
    ].join(";")
    card.appendChild(h)
    if (!item) {
        card.appendChild(_text(T, "No proposals above threshold."))
        return card
    }
    renderInner(T, card, item)
    return card
}

function _renderOpenLine(T, card, c) {
    const head = document.createElement("div")
    head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;"
    const code = document.createElement("span")
    code.textContent = c.iata
    code.style.cssText = "font:600 16px " + T.font.mono + ";color:" + T.color.oxide + ";letter-spacing:0.06em;"
    head.appendChild(code)
    const fit = document.createElement("span")
    fit.textContent = "fit " + c.fitness.toFixed(2)
    fit.style.cssText = "font:11px " + T.font.mono + ";color:" + T.color.oxide2 + ";"
    head.appendChild(fit)
    card.appendChild(head)
    if (Array.isArray(c.rationale) && c.rationale.length) {
        const reason = document.createElement("div")
        reason.style.cssText = "font:12px " + T.font.display + ";color:" + T.color.oxide
            + ";margin-top:" + T.sp[1] + ";line-height:1.4;"
        reason.textContent = c.rationale[0]
        card.appendChild(reason)
    }
}

function _renderCloseLine(T, card, c) {
    const head = document.createElement("div")
    head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;"
    const code = document.createElement("span")
    code.textContent = c.iata
    code.style.cssText = "font:600 16px " + T.font.mono + ";color:" + T.color.oxide + ";letter-spacing:0.06em;"
    head.appendChild(code)
    const profit = document.createElement("span")
    const negative = c.weeklyProfit < 0
    profit.textContent = (negative ? "−$" : "$") + Math.abs(Math.round(c.weeklyProfit)).toLocaleString() + "/wk"
    profit.style.cssText = "font:600 11px " + T.font.mono
        + ";color:" + (negative ? T.color.crimson : T.color.moss) + ";"
    head.appendChild(profit)
    card.appendChild(head)
    if (Array.isArray(c.rationale) && c.rationale.length) {
        const reason = document.createElement("div")
        reason.style.cssText = "font:12px " + T.font.display + ";color:" + T.color.oxide
            + ";margin-top:" + T.sp[1] + ";line-height:1.4;"
        reason.textContent = c.rationale[0]
        card.appendChild(reason)
    }
}

window.CentralHubStrategyHubDesignerTile = CentralHubStrategyHubDesignerTile

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "strategy-hub-designer",
        section:  "operations",
        priority: 3,
        factory:  () => new CentralHubStrategyHubDesignerTile()
    })
}

})()
