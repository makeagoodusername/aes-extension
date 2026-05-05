"use strict"

/**
 * Lane B Phase 2 — Fleet Command tile.
 *
 * Federated cross-account aircraft surface for users running multi-airline
 * sister networks. Reads `AesFleetCommand.build()` (the pure cross-account
 * aggregator) and surfaces the headline + top breakdown by the user's
 * default pivot. CTA opens the read-only Fleet Command modal panel.
 *
 * Section "fleet", priority 5 — sits above the per-account Fleet Hub tile
 * (10) and the Fleet Optimizer tile (9), because Fleet Command is the
 * canopy-wide aircraft view; Fleet Hub stays per-account; Fleet Optimizer
 * is the analytics overlay.
 *
 * Read-only Phase 2. No POSTs. No bulk apply (Phase 4).
 */
class CentralHubFleetCommandTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "fleet-command"
        this.title = "Fleet Command"
        this.section = "fleet"
        this.priority = 5
        this.requiresAirline = false
        this._lastView = null
        this._pivot = "byOrg"   // byOrg | byHub | byType | byRegion
    }

    watchedStorageKeys() {
        // Single-key prefixes (matched via `key.indexOf(p) === 0` by the
        // base class) — these all start at offset 0 in the actual key, so
        // they fire correctly. The fleet record key shape is
        // `<server><airlineCode>aircraftFleet` which CANNOT be matched by
        // an "aircraftFleet" prefix; that case is handled below in the
        // mount() override via a suffix-matching listener.
        return [
            "aesAccounts", "aesCanopy:orgs", "aesCanopy:regions",
            "aircraftFlightPlan:state", "aircraftFlightPlan:maintenance"
        ]
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        // Cross-account fleet refresh: keys are `<server><airlineCode>aircraftFleet`
        // — no shared prefix that the base class's prefix-matched listener
        // can hit. Add a dedicated suffix-matching listener so every fleet
        // scrape across any airline triggers a re-aggregate.
        this._fleetSuffixListener = (changes, area) => {
            if (area !== "local") return
            for (const k in changes) {
                if (k.length > "aircraftFleet".length
                    && k.lastIndexOf("aircraftFleet") === k.length - "aircraftFleet".length) {
                    this.refresh(); return
                }
            }
        }
        try { chrome.storage.onChanged.addListener(this._fleetSuffixListener) }
        catch (_) { /* tile still works without it */ }
    }

    dispose() {
        if (this._fleetSuffixListener) {
            try { chrome.storage.onChanged.removeListener(this._fleetSuffixListener) }
            catch (_) { /* noop */ }
            this._fleetSuffixListener = null
        }
        super.dispose()
    }

    openHref() { return "/app/fleets" }

    async _resolveView() {
        if (typeof window.AesFleetCommand === "undefined") return null
        try {
            const view = await window.AesFleetCommand.build({})
            this._lastView = view
            return view
        } catch (_) { return null }
    }

    async loadStatus() {
        const view = await this._resolveView()
        if (!view || !view.tails || !view.tails.length) {
            return {
                badge:     "NO DATA",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary:   "Visit a /app/fleets page on each airline to populate the cross-account roster."
            }
        }
        const t = view.totals
        return {
            badge:     "Σ " + t.tails,
            badgeKind: window.CentralHubStatusBadges.KIND.OK,
            summary:   t.tails + " tails · " + t.accounts + " account" + (t.accounts === 1 ? "" : "s")
                + " · " + t.orgs + " org" + (t.orgs === 1 ? "" : "s")
                + " · " + t.regions + " region" + (t.regions === 1 ? "" : "s")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        // Re-entrancy guard — concurrent renders from the shell's
        // open-tile flow + bus-driven refreshes would otherwise both
        // clear, both await `_resolveView`, then both append the full
        // headline + pivot bars + footer, duplicating the body.
        const gen = (this._renderGen = (this._renderGen || 0) + 1)
        host.textContent = ""
        const view = this._lastView || await this._resolveView()
        if (gen !== this._renderGen) return
        if (!view || !view.tails.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Visit each airline's /app/fleets page to populate the federated roster."
            host.appendChild(empty)
            return
        }

        host.appendChild(this._renderHeadline(view, T))
        host.appendChild(this._renderPivotControls(view, host, T))
        host.appendChild(this._renderTopGroups(view, T))
        host.appendChild(this._renderFooter(view, T))
    }

    _renderHeadline(view, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px;"
        const t = view.totals
        const items = [
            {label: "Tails",     value: t.tails},
            {label: "Accounts",  value: t.accounts},
            {label: "Orgs",      value: t.orgs},
            {label: "Regions",   value: t.regions}
        ]
        for (const it of items) {
            const cell = document.createElement("div")
            cell.style.cssText = "padding:8px;border-radius:4px;"
                + "background:" + (T.color.surfaceMuted || "rgba(148,163,184,0.10)") + ";"
            const lbl = document.createElement("div")
            lbl.style.cssText = "font-size:10px;color:" + T.color.slate + ";"
                + "text-transform:uppercase;letter-spacing:.04em;"
            lbl.textContent = it.label
            const val = document.createElement("div")
            val.style.cssText = "font-size:18px;font-weight:600;"
                + "color:" + (T.color.foreground || "#e2e8f0") + ";"
            val.textContent = String(it.value)
            cell.appendChild(lbl); cell.appendChild(val)
            wrap.appendChild(cell)
        }
        return wrap
    }

    _renderPivotControls(view, host, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:8px;"
            + "font-size:10px;color:" + T.color.slate + ";"
        const lbl = document.createElement("span")
        lbl.textContent = "Group by:"
        lbl.style.textTransform = "uppercase"
        lbl.style.letterSpacing = ".04em"
        wrap.appendChild(lbl)
        const PIVOTS = [
            ["byOrg",    "Org"],
            ["byHub",    "Hub"],
            ["byType",   "Type"],
            ["byRegion", "Region"]
        ]
        for (const [key, label] of PIVOTS) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = label
            const active = (this._pivot === key)
            btn.style.cssText = "padding:2px 8px;border-radius:3px;cursor:pointer;font-size:10px;"
                + "border:1px solid " + (active ? "#3b82f6" : "rgba(148,163,184,0.35)") + ";"
                + "background:" + (active ? "rgba(59,130,246,0.12)" : "transparent") + ";"
                + "color:" + (active ? "#cbd5e1" : T.color.slate) + ";"
            btn.addEventListener("click", () => {
                // F-9228-705: pass the live ctx instead of an empty object so
                // future ctx-aware logic in renderBody reads the right account
                // context. Aligns with the base-class re-render path.
                this._pivot = key
                this.renderBody(this.ctx || {}, host)
            })
            wrap.appendChild(btn)
        }
        return wrap
    }

    _renderTopGroups(view, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-bottom:12px;"
        const groupMap = view[this._pivot] || {}
        const groups = Object.values(groupMap)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
        if (!groups.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + T.color.slate + ";font-style:italic;"
            empty.textContent = "No groups yet — define orgs/regions in Settings."
            wrap.appendChild(empty)
            return wrap
        }
        const max = Math.max(...groups.map(g => g.count), 1)
        for (const g of groups) {
            const row = document.createElement("div")
            row.style.cssText = "display:grid;grid-template-columns:140px 1fr 40px;align-items:center;gap:8px;margin-bottom:3px;"
            const label = document.createElement("span")
            label.textContent = this._labelFor(g)
            label.style.cssText = "font-size:11px;color:" + (T.color.foreground || "#e2e8f0") + ";"
                + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            const bar = document.createElement("div")
            bar.style.cssText = "height:6px;border-radius:2px;background:rgba(148,163,184,0.10);position:relative;"
            const fill = document.createElement("div")
            const widthPct = (g.count / max) * 100
            fill.style.cssText = "height:100%;border-radius:2px;background:#3b82f6;width:" + widthPct + "%;"
            bar.appendChild(fill)
            const count = document.createElement("span")
            count.textContent = String(g.count)
            count.style.cssText = "text-align:right;font-family:ui-monospace,monospace;font-size:11px;"
                + "color:" + (T.color.foreground || "#e2e8f0") + ";"
            row.appendChild(label); row.appendChild(bar); row.appendChild(count)
            wrap.appendChild(row)
        }
        return wrap
    }

    _labelFor(g) {
        if (g.orgName)  return g.orgName
        if (g.hub)      return g.hub
        if (g.name)     return g.name
        return "—"
    }

    _renderFooter(view, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;"

        const diag = document.createElement("span")
        diag.style.cssText = "color:" + T.color.slate + ";"
        const t = view.totals
        diag.textContent = t.withRatio + "/" + t.tails + " with maint · "
            + t.withSchedule + "/" + t.tails + " with schedule"
        wrap.appendChild(diag)

        const cta = document.createElement("button")
        cta.type = "button"
        cta.textContent = "Open Fleet Command →"
        cta.style.cssText = "padding:4px 10px;border-radius:3px;border:1px solid rgba(148,163,184,0.35);"
            + "background:transparent;color:" + (T.color.foreground || "#e2e8f0") + ";cursor:pointer;font-size:11px;"
        cta.addEventListener("click", () => {
            if (window.AesFleetCommandPanel
                && typeof window.AesFleetCommandPanel.open === "function") {
                window.AesFleetCommandPanel.open({pivot: this._pivot})
            } else {
                window.location.href = "/app/fleets"
            }
        })
        wrap.appendChild(cta)
        return wrap
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "fleet-command",
        section: "fleet",
        priority: 5,
        factory: () => new CentralHubFleetCommandTile()
    })
}
