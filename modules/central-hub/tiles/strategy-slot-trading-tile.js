"use strict"

// IIFE-wrapped so the file-local `_text` helper at the bottom doesn't
// collide with the same-name helper in `strategy-briefing-tile.js`.
// Both declare `function _text(T, ...)` at top level; in the shared
// content-script lexical scope the later declaration shadows the
// earlier one, which crashed briefing's 1-arg call sites once this
// file loaded after briefing-tile. Same fix briefing-tile already has.
;(function () {

/**
 * Strategy Slot Trading tile (Slice 20).
 *
 * Surfaces the count of available slot opportunities scraped/seeded
 * for the current server, the top-scored slot, and the count of
 * pending bids. Body shows the top three opportunities inline; click →
 * opens the strategy panel where the slot-tuner decisions appear in
 * the unified decision list.
 *
 * Section "operations" priority 5 — sits below Hub Designer and
 * Portfolio. Hidden when no slot data is present (avoids tile
 * clutter on accounts that don't use the feature).
 */
class CentralHubStrategySlotTradingTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "strategy-slot-trading"
        this.title = "Slot & Gate Trading"
        this.section = "operations"
        this.priority = 5
        this.requiresAirline = true
        this._slots = []
        this._scored = []
        this._bids = []
    }

    watchedStorageKeys() {
        return [
            "aesStrategy:slots:bids"
        ]
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this._mountCtx = ctx || null
        this.subscribeBus("data:slots:available:updated", () => { this.refresh().catch(() => {}) })
        this.subscribeBus("data:slots:bid:queued",        () => { this.refresh().catch(() => {}) })
    }

    openHandler() {
        return () => this._openStrategyPanel()
    }

    async loadStatus(ctx) {
        const KIND = window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND
        const muted = KIND ? KIND.MUTED : "muted"
        const ok    = KIND ? KIND.OK    : "ok"

        if (!window.AesSlotStore) {
            return {badge: "OFF", badgeKind: muted, summary: "Slot module not loaded."}
        }
        const server = (ctx && ctx.server) || null
        if (!server) {
            return {badge: "—", badgeKind: muted, summary: "Open an AS dashboard to scope slots by server."}
        }

        await this._build(ctx)
        const total = this._slots.length
        const top   = this._scored[0]
        if (total === 0 && this._bids.length === 0) {
            return {badge: "NONE", badgeKind: muted,
                summary: "No slot data yet — visit /app/airport/<iata>/slots or paste records via AesSlotScraper.record()."}
        }
        return {
            badge:     total + " AVAIL",
            badgeKind: total > 0 ? ok : muted,
            summary:   total + " opportunities · "
                       + (top ? "top " + (top.slot.iata || "?") + " score " + top.score.toFixed(2) : "no scored slot")
                       + " · " + this._bids.length + " bids logged"
        }
    }

    async renderBody(ctx, hostEl) {
        hostEl.textContent = ""
        const T = window.AESTokens
        await this._build(ctx)
        if (!this._slots.length) {
            hostEl.appendChild(_text(T,
                "No slot records yet. Visit an airport's slots page in AS so the scraper can fire (parser stub-only in v1) "
                + "or paste records via DevTools: AesSlotScraper.record({iata:'JFK', slotId:'...', minBid:50000}, {server: '" + ((ctx && ctx.server) || "...") + "'})"))
            return
        }

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";margin-bottom:" + T.sp[3] + ";"
        for (const s of this._scored.slice(0, 3)) list.appendChild(this._renderRow(T, s))
        hostEl.appendChild(list)

        const footer = document.createElement("div")
        footer.style.cssText = [
            "display:flex", "justify-content:space-between", "align-items:center",
            "padding:" + T.sp[2] + " 0",
            "border-top:1px solid " + T.color.paperRule,
            "color:" + T.color.oxide2,
            "font:11px " + T.font.display
        ].join(";")
        const meta = document.createElement("span")
        meta.textContent = this._slots.length + " opportunities · "
                         + this._bids.length + " bids logged · advisory only"
        footer.appendChild(meta)
        const cta = document.createElement("button")
        cta.type = "button"
        cta.dataset.aesStrategySlotOpen = "1"
        cta.textContent = "Open strategy →"
        cta.style.cssText = [
            "background:" + T.color.oxide, "color:" + T.color.bone,
            "border:none", "border-radius:" + T.geom.radius,
            "padding:" + T.sp[1] + " " + T.sp[3],
            "font:600 11px " + T.font.display,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase",
            "cursor:pointer"
        ].join(";")
        cta.addEventListener("click", () => this._openStrategyPanel())
        footer.appendChild(cta)
        hostEl.appendChild(footer)
    }

    _renderRow(T, s) {
        const row = document.createElement("div")
        row.style.cssText = [
            "display:grid",
            "grid-template-columns:auto 1fr auto",
            "gap:" + T.sp[2],
            "align-items:center",
            "padding:" + T.sp[2] + " " + T.sp[3],
            "background:" + T.color.bone2,
            "border:1px solid " + T.color.paperRule,
            "border-radius:" + T.geom.radius
        ].join(";")
        const code = document.createElement("span")
        code.textContent = s.slot.iata || "—"
        code.style.cssText = "font:600 14px " + T.font.mono + ";color:" + T.color.oxide + ";letter-spacing:0.06em;"
        row.appendChild(code)

        const mid = document.createElement("div")
        mid.style.cssText = "min-width:0;"
        const reason = document.createElement("div")
        reason.style.cssText = "font:12px " + T.font.display + ";color:" + T.color.oxide
                             + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        reason.textContent = (s.rationale && s.rationale[0]) || "—"
        mid.appendChild(reason)
        const sub = document.createElement("div")
        sub.style.cssText = "font:11px " + T.font.display + ";color:" + T.color.oxide2 + ";"
        sub.textContent = (s.slot.runwayClass ? s.slot.runwayClass + " · " : "")
                        + (s.slot.weeklyOps ? s.slot.weeklyOps + " ops/wk" : "")
                        + (isFinite(s.slot.minBid) ? " · min $" + Math.round(s.slot.minBid).toLocaleString() : "")
        mid.appendChild(sub)
        row.appendChild(mid)

        const score = document.createElement("span")
        score.textContent = s.score.toFixed(2)
        score.style.cssText = "font:600 12px " + T.font.mono
                            + ";color:" + (s.score >= 0.7 ? T.color.moss : s.score >= 0.5 ? T.color.amber : T.color.oxide2) + ";"
        row.appendChild(score)
        return row
    }

    async _build(ctx) {
        const server = (ctx && ctx.server) || null
        if (!server || !window.AesSlotStore) {
            this._slots = []; this._scored = []; this._bids = []
            return
        }
        try {
            this._slots = await window.AesSlotStore.loadAvailable(server)
            this._bids  = await window.AesSlotStore.loadBids({server, limit: 50})
        } catch (_) {
            this._slots = []; this._bids = []
        }

        this._scored = []
        if (!this._slots.length || !window.AesSlotScorer || !window.AesStrategy
            || typeof window.AesStrategy.snapshot !== "function") return

        let snap = null
        try {
            snap = await window.AesStrategy.snapshot({
                server:      server,
                airlineCode: (ctx && ctx.airline) || null,
                accountId:   (typeof window.__aesAccountId === "string" ? window.__aesAccountId : null)
            })
        } catch (_) {}
        if (!snap) return

        for (const slot of this._slots) {
            const s = window.AesSlotScorer.score(slot, snap)
            this._scored.push(Object.assign({slot: slot}, s))
        }
        this._scored.sort((a, b) => b.score - a.score)
    }

    _openStrategyPanel() {
        try {
            if (window.AesStrategyPanel && typeof window.AesStrategyPanel.open === "function") {
                const ret = window.AesStrategyPanel.open({section: "decisions", domain: "slotBid", skipSeed: true})
                if (ret && typeof ret.catch === "function") {
                    ret.catch(e => console.warn("[AES slot tile] open strategy panel failed", e))
                }
            }
        } catch (e) { console.warn("[AES slot tile] open strategy panel threw", e) }
    }
}

function _text(T, s) {
    const el = document.createElement("div")
    el.style.cssText = "color:" + T.color.oxide2 + ";font:12px " + T.font.display + ";line-height:1.5;"
    el.textContent = s
    return el
}

window.CentralHubStrategySlotTradingTile = CentralHubStrategySlotTradingTile

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "strategy-slot-trading",
        section:  "operations",
        priority: 5,
        factory:  () => new CentralHubStrategySlotTradingTile()
    })
}

})()
