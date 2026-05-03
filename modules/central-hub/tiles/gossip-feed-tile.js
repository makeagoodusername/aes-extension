"use strict"

/**
 * Markets Gossip Feed tile — Slice 27 surface.
 *
 * Chronological feed of GossipEvent records from
 * `AesStrategyGossipStore`. Last 20 by default; click an event to
 * acknowledge (writes the eventId to the seen set; the badge count drops).
 *
 * Refresh triggers:
 *   - on tile expand
 *   - on `data:strategy:gossip:event` bus event
 *   - on storage change at `aesStrategy:gossip:`
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    const SEVERITY_COLOR = {
        low:  "#94a3b8",
        med:  "#facc15",
        high: "#f87171"
    }
    const KIND_GLYPH = {
        "competitor-price-shift": "$",
        "new-entrant":            "★",
        "own-lf-drop":            "↓"
    }

    function _fmtAge(ms) {
        if (!isFinite(ms) || ms <= 0) return "—"
        if (ms < 60_000)     return Math.max(1, Math.floor(ms / 1000)) + "s"
        if (ms < 3_600_000)  return Math.floor(ms / 60_000) + "m"
        if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h"
        return Math.floor(ms / 86_400_000) + "d"
    }

    function _resolveHost() {
        try {
            if (typeof AES === "undefined") return null
            const server  = (AES.getServerName && AES.getServerName()) || ""
            const codeRec = (AES.getAirlineCode && AES.getAirlineCode()) || null
            const airline = (codeRec && codeRec.code) || ""
            if (!server || !airline) return null
            return {server, airline}
        } catch (_) { return null }
    }

    class CentralHubGossipFeedTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "gossip-feed"
            this.title = "Markets gossip"
            this.section = "tools"
            this.priority = 11
            this.requiresAirline = true
            this._cache = null
            this._wired = false
        }

        watchedStorageKeys() { return ["aesStrategy:gossip:"] }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    window.CentralHubBus.on("data:strategy:gossip:event", () => {
                        this._cache = null
                        this.refresh && this.refresh()
                    })
                }
            } catch (_) {}
        }

        async _compute() {
            this._wireBus()
            const host = _resolveHost()
            const store = window.AesStrategyGossipStore
            if (!host || !store) return {events: [], seen: new Set(), reason: "no host"}
            const [events, seen] = await Promise.all([store.loadAll(host), store.loadSeen(host)])
            return {events: events || [], seen: seen || new Set(), reason: null, host}
        }

        async loadStatus() {
            this._cache = await this._compute()
            const KIND = window.CentralHubStatusBadges.KIND
            const {events, seen} = this._cache
            if (!events.length) {
                return {badge: "—", badgeKind: KIND.MUTED, summary: this._cache.reason || "no events yet"}
            }
            const fresh = events.filter(e => !seen.has(e.eventId)).length
            if (fresh === 0) {
                return {badge: String(events.length), badgeKind: KIND.MUTED,
                    summary: events.length + " event(s), all acknowledged"}
            }
            const highFresh = events.filter(e => !seen.has(e.eventId) && e.severity === "high").length
            return {
                badge:     String(fresh),
                badgeKind: highFresh > 0 ? KIND.WARN : KIND.OK,
                summary:   fresh + " unread"
                    + (highFresh > 0 ? " · " + highFresh + " high" : "")
            }
        }

        async renderBody(_ctx, hostEl) {
            const T = window.AESTokens
            hostEl.textContent = ""
            if (!this._cache) this._cache = await this._compute()
            const {events, seen, reason, host} = this._cache

            if (!events.length) {
                const p = document.createElement("p")
                p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8")
                    + ";margin:0;font-size:11px;line-height:1.5"
                p.textContent = reason
                    || "No gossip yet. Detectors fire when scraped markets, flightsfrom, or topRoutes data changes."
                hostEl.appendChild(p)
                return
            }

            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:340px;overflow:auto"
            for (const ev of events.slice(0, 20)) {
                list.appendChild(this._renderRow(ev, seen, host, T))
            }
            hostEl.appendChild(list)

            const foot = document.createElement("div")
            foot.style.cssText = "margin-top:8px;display:flex;gap:8px;font-size:10px;"
                + "color:" + (T && T.color.slate || "#94a3b8") + ";"
            foot.textContent = "Click row to acknowledge. Events older than 30 days drop on next write."
            hostEl.appendChild(foot)
        }

        _renderRow(event, seen, host, T) {
            const acknowledged = seen.has(event.eventId)
            const accent = SEVERITY_COLOR[event.severity] || "#94a3b8"
            const row = document.createElement("button")
            row.type = "button"
            row.style.cssText = "display:grid;grid-template-columns:18px 1fr 56px;gap:8px;"
                + "align-items:center;text-align:left;padding:6px 8px;background:rgba(148,163,184,0.05);"
                + "border:none;border-left:3px solid " + accent + ";border-radius:3px;"
                + "color:" + (T && T.color.text || "#e2e8f0") + ";cursor:pointer;"
                + "opacity:" + (acknowledged ? "0.55" : "1") + ";"
            row.title = (event.summary || "") + " · click to acknowledge"

            const glyph = document.createElement("span")
            glyph.style.cssText = "font-size:13px;font-weight:600;color:" + accent
            glyph.textContent = KIND_GLYPH[event.kind] || "•"
            row.appendChild(glyph)

            const desc = document.createElement("div")
            desc.style.cssText = "font-size:11.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            desc.textContent = event.summary || event.kind
            row.appendChild(desc)

            const age = document.createElement("div")
            age.style.cssText = "font-size:10.5px;color:" + (T && T.color.slate || "#94a3b8") + ";text-align:right"
            age.textContent = _fmtAge(Date.now() - Number(event.ts))
            row.appendChild(age)

            row.addEventListener("click", async () => {
                if (acknowledged) return
                if (!host || !window.AesStrategyGossipStore) return
                await window.AesStrategyGossipStore.markSeen(host, [event.eventId])
                this._cache = null
                this.refresh && this.refresh()
            })

            return row
        }
    }

    window.CentralHubGossipFeedTile = CentralHubGossipFeedTile
    if (window.CentralHubTileRegistry
            && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register({
            id:       "gossip-feed",
            section:  "tools",
            priority: 11,
            factory:  () => new CentralHubGossipFeedTile()
        })
    }
})()
