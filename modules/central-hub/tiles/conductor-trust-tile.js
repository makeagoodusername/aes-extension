"use strict"

/**
 * Conductor Trust tile — K11 surface.
 *
 * Shows per-scenario Trust Quotient (posterior mean), 5%-percentile lower
 * confidence bound, observed-fire count, and the K11 tier the engine has
 * promoted the scenario to. Sortable by tier, TQ, n, or last update. Reset
 * button per-row clears that scenario's posterior back to the prior.
 *
 * Read-only: the tile reports trust; user changes happen in unified-settings
 * → Conductor → Trust (per-scenario ceilings + global max). When the K14
 * drift driver lands, the tile also reflects drift-clamps via the entry's
 * `ceiling` field.
 *
 * Refresh triggers:
 *   - on tile expand
 *   - on `data:conductor:trust:updated` bus event
 *   - on storage change at `aesConductor:trust:`
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    const SORTS = [
        {id: "tier",   label: "Tier"},
        {id: "tq",     label: "TQ"},
        {id: "n",      label: "n"},
        {id: "recent", label: "Recent"}
    ]

    const TIER_COLOR = {
        "alert":          "#94a3b8",
        "suggest":        "#60a5fa",
        "apply-confirm":  "#facc15",
        "apply-auto":     "#34d399"
    }

    function _fmtAge(ms) {
        if (!isFinite(ms) || ms <= 0) return "—"
        if (ms < 60_000)     return Math.max(1, Math.floor(ms / 1000)) + "s"
        if (ms < 3_600_000)  return Math.floor(ms / 60_000) + "m"
        if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h"
        return Math.floor(ms / 86_400_000) + "d"
    }

    function _resolveHost() {
        if (typeof AES === "undefined") return null
        let server = ""
        try { server = AES.getServerName ? (AES.getServerName() || "") : "" } catch (_) { server = "" }
        if (!server) return null
        let airline = ""
        try {
            const code = AES.getAirlineCode ? AES.getAirlineCode() : null
            airline = (code && code.code) ? code.code : ""
        } catch (_) { airline = "" }
        return {server, airline}
    }

    class CentralHubConductorTrustTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "conductor-trust"
            this.title = "Trust quotient"
            this.section = "tools"
            this.priority = 7
            this.requiresAirline = false
            this._cache = null               // {entries: [{scenarioId, ...trust}], scenarios: Map}
            this._sortBy = "tier"
            this._wired = false
        }

        watchedStorageKeys() {
            return ["aesConductor:trust:"]
        }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    const handler = () => { this._cache = null; this.refresh && this.refresh() }
                    window.CentralHubBus.on("data:conductor:trust:updated", handler)
                    window.CentralHubBus.on("signal:conductor:tier:promoted", handler)
                }
            } catch (_) { /* noop */ }
        }

        async _compute() {
            this._wireBus()
            const host = _resolveHost()
            if (!host) return {entries: [], reason: "no host", scenarios: new Map()}
            const store = window.AesConductorTrustStore
            if (!store || typeof store.load !== "function") {
                return {entries: [], reason: "trust store not loaded", scenarios: new Map()}
            }
            const blob = await store.load(host)
            const scenarios = new Map()
            const all = (window.AesConductorScenarios && window.AesConductorScenarios.all)
                ? window.AesConductorScenarios.all() : []
            for (const s of all) if (s && s.id) scenarios.set(s.id, s)

            const entries = []
            for (const id of Object.keys(blob)) {
                entries.push(Object.assign({scenarioId: id}, blob[id]))
            }
            // Surface scenarios with no observations as alert-tier rows so
            // the user can see what's tracked. Skip if too many — cap at 30.
            const seenIds = new Set(entries.map(e => e.scenarioId))
            for (const [id, s] of scenarios) {
                if (entries.length >= 30) break
                if (seenIds.has(id)) continue
                if (!s.kpiWindowMs) continue                          // not instrumented
                entries.push({
                    scenarioId: id,
                    alpha: store.PRIOR_ALPHA,
                    beta:  store.PRIOR_BETA,
                    n: 0, tq: 0.5, lcb: 0,
                    tier: "alert", ceiling: null, lastAt: 0
                })
            }
            return {entries, scenarios, reason: null}
        }

        _sorted(entries) {
            const ord = window.AesConductorTrustStore && window.AesConductorTrustStore.TIER_ORDER
                ? window.AesConductorTrustStore.TIER_ORDER : ["alert","suggest","apply-confirm","apply-auto"]
            const cp = entries.slice()
            switch (this._sortBy) {
                case "tq":     cp.sort((a, b) => b.tq - a.tq); break
                case "n":      cp.sort((a, b) => b.n - a.n); break
                case "recent": cp.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)); break
                case "tier":
                default:       cp.sort((a, b) => ord.indexOf(b.tier) - ord.indexOf(a.tier) || b.tq - a.tq); break
            }
            return cp
        }

        async loadStatus() {
            this._cache = await this._compute()
            const KIND = window.CentralHubStatusBadges.KIND
            const entries = this._cache.entries || []
            if (!entries.length) {
                return {badge: "—", badgeKind: KIND.MUTED, summary: this._cache.reason || "no trust data"}
            }
            const promoted = entries.filter(e => e.tier !== "alert").length
            if (promoted > 0) {
                return {badge: String(promoted), badgeKind: KIND.OK, summary: promoted + " of " + entries.length + " promoted"}
            }
            return {badge: String(entries.length), badgeKind: KIND.MUTED, summary: entries.length + " tracked · all alert"}
        }

        async renderBody(_ctx, hostEl) {
            const T = window.AESTokens
            hostEl.textContent = ""
            if (!this._cache) this._cache = await this._compute()
            const {entries, scenarios, reason} = this._cache

            // Sort chips
            const head = document.createElement("div")
            head.style.cssText = "display:flex;gap:6px;margin-bottom:8px;align-items:center;flex-wrap:wrap"
            const lbl = document.createElement("span")
            lbl.style.cssText = "font-size:10.5px;color:" + (T && T.color.slate || "#94a3b8")
            lbl.textContent = "Sort"
            head.appendChild(lbl)
            for (const s of SORTS) {
                const chip = document.createElement("button")
                chip.type = "button"
                chip.textContent = s.label
                const active = this._sortBy === s.id
                chip.style.cssText = "background:" + (active ? (T && T.color.bone || "#1e293b") : "transparent")
                    + ";border:1px solid " + (T && T.color.slate || "rgba(148,163,184,0.35)")
                    + ";color:" + (T && T.color.text || "#e2e8f0")
                    + ";padding:2px 8px;border-radius:3px;font-size:10.5px;cursor:pointer"
                chip.addEventListener("click", () => {
                    this._sortBy = s.id
                    this.refresh && this.refresh()
                })
                head.appendChild(chip)
            }
            hostEl.appendChild(head)

            if (!entries.length) {
                const p = document.createElement("p")
                p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";margin:0;font-size:11px;line-height:1.5"
                p.textContent = reason || "No instrumented scenarios have fired yet. Trust accrues as outcomes arrive."
                hostEl.appendChild(p)
                return
            }

            const list = document.createElement("div")
            list.style.cssText = "display:flex;flex-direction:column;gap:4px"
            const sorted = this._sorted(entries)
            for (const e of sorted) {
                list.appendChild(this._renderRow(e, scenarios.get(e.scenarioId), T))
            }
            hostEl.appendChild(list)

            const foot = document.createElement("div")
            foot.style.cssText = "margin-top:8px;font-size:10px;color:" + (T && T.color.slate || "#94a3b8") + ";line-height:1.4"
            foot.textContent = "Tier promotes on LCB ≥ 0.40 (suggest) · 0.60 (confirm) · 0.80 (auto). Beta(2,2) prior; one observation moves mean ±0.10."
            hostEl.appendChild(foot)
        }

        _renderRow(entry, scenario, T) {
            const row = document.createElement("div")
            row.style.cssText = "display:grid;grid-template-columns:1fr 60px 64px 36px 36px 56px;gap:8px;"
                + "align-items:center;padding:6px 8px;background:rgba(148,163,184,0.05);border-radius:3px;"
                + "border-left:3px solid " + (TIER_COLOR[entry.tier] || "#94a3b8")
            // Name
            const name = document.createElement("div")
            name.style.cssText = "font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            name.textContent = (scenario && scenario.label) || entry.scenarioId
            name.title = entry.scenarioId
            row.appendChild(name)

            // TQ bar
            const bar = document.createElement("div")
            bar.style.cssText = "position:relative;height:14px;background:rgba(148,163,184,0.18);border-radius:2px;overflow:hidden"
            const fill = document.createElement("div")
            const w = Math.max(0, Math.min(1, entry.tq))
            fill.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:" + (w * 100).toFixed(0)
                + "%;background:" + (TIER_COLOR[entry.tier] || "#60a5fa") + ";opacity:0.55"
            bar.appendChild(fill)
            const lcbMark = document.createElement("div")
            const lw = Math.max(0, Math.min(1, entry.lcb))
            lcbMark.style.cssText = "position:absolute;top:0;bottom:0;left:" + (lw * 100).toFixed(0)
                + "%;width:1px;background:" + (T && T.color.text || "#e2e8f0")
            bar.appendChild(lcbMark)
            bar.title = "TQ=" + entry.tq.toFixed(3) + "  LCB=" + entry.lcb.toFixed(3)
            row.appendChild(bar)

            // Tier pill
            const pill = document.createElement("span")
            pill.textContent = entry.tier
            pill.style.cssText = "font-size:10px;padding:2px 6px;border-radius:9px;text-align:center;"
                + "background:" + (TIER_COLOR[entry.tier] || "#94a3b8") + "33;"
                + "color:" + (TIER_COLOR[entry.tier] || "#94a3b8") + ";font-weight:600"
            if (entry.ceiling) pill.title = "Drift ceiling: " + entry.ceiling
            row.appendChild(pill)

            // n
            const n = document.createElement("div")
            n.style.cssText = "font-size:10.5px;text-align:right;color:" + (T && T.color.slate || "#94a3b8")
                + ";font-family:" + (T && T.font && T.font.mono || "monospace")
            n.textContent = String(entry.n || 0)
            row.appendChild(n)

            // Age
            const age = document.createElement("div")
            age.style.cssText = "font-size:10.5px;text-align:right;color:" + (T && T.color.slate || "#94a3b8")
            age.textContent = entry.lastAt ? _fmtAge(Date.now() - entry.lastAt) : "—"
            row.appendChild(age)

            // Reset
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = "Reset"
            btn.style.cssText = "background:transparent;border:1px solid " + (T && T.color.slate || "rgba(148,163,184,0.35)")
                + ";color:" + (T && T.color.text || "#e2e8f0")
                + ";padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer"
            btn.disabled = entry.n === 0
            btn.addEventListener("click", async () => {
                const host = _resolveHost()
                if (!host || !window.AesConductorTrustStore) return
                await window.AesConductorTrustStore.reset(host, entry.scenarioId)
                this._cache = null
                this.refresh && this.refresh()
            })
            row.appendChild(btn)
            return row
        }
    }

    if (typeof window !== "undefined") {
        window.CentralHubConductorTrustTile = CentralHubConductorTrustTile
        if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
            window.CentralHubTileRegistry.register({
                id:       "conductor-trust",
                section:  "tools",
                priority: 7,
                factory:  () => new CentralHubConductorTrustTile()
            })
        }
    }
})()
