"use strict"

/**
 * Weekly-review tile (Phase D2).
 *
 * One pane that surfaces "what needs your attention this week" by joining
 * three existing strategy sources:
 *
 *   1. Active service-profile A/B experiments
 *      (AesServiceExperimentStore.active())
 *   2. Pending decision-dispatch requests
 *      (AesStrategyDecisionDispatch.readPending())
 *   3. Recent applied changes (last 7 days) merged across every domain
 *      (AesChangeLogAggregator.loadAll({sinceMs}))
 *
 * Read-only — never writes any store. The tile claims `salienceDomains`
 * matching the Phase A2 signal kinds (crew-pressure, competitor-threat,
 * cash-low, wear-pressure) so the central-hub salience scorer floats it
 * up automatically when those bus signals are recent.
 *
 * Storage key watch list mirrors the aggregator's SOURCE_KEYS so the base
 * class auto-refreshes when applies / experiments / dispatches mutate.
 */
class CentralHubWeeklyReviewTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id    = "weekly-review"
        this.title = "Weekly review"
        this.section  = "tools"
        this.priority = 6
        this.requiresAirline = false
        // Phase C2 — claim the cross-feature signal kinds. The salience
        // scorer counts bus events under these names and boosts our rank
        // when they're recent.
        this.salienceDomains = [
            "crew-pressure", "competitor-threat", "cash-low", "wear-pressure"
        ]
    }

    watchedStorageKeys() {
        const agg = window.AesChangeLogAggregator
        const base = (agg && Array.isArray(agg.SOURCE_KEYS)) ? agg.SOURCE_KEYS.slice() : []
        return base.concat([
            "aesStrategy:serviceExperiments:outcomes"
        ])
    }

    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        // Refresh on direct-apply dispatch so the pending row clears
        // within the same paint cycle as the apply.
        if (window.AesDataBus && typeof window.AesDataBus.on === "function") {
            const off1 = window.AesDataBus.on("data:strategy:dispatch:applied", () => {
                this.refresh().catch(() => {})
            })
            const off2 = window.AesDataBus.on("data:strategy:serviceExperiment:concluded", () => {
                this.refresh().catch(() => {})
            })
            this._busDisposers = (this._busDisposers || []).concat([off1, off2])
        }
    }

    async _loadData() {
        const agg = window.AesChangeLogAggregator
        const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000
        const [active, pending, recent, outcomes] = await Promise.all([
            (agg && typeof agg.loadActiveExperiments === "function")
                ? agg.loadActiveExperiments() : Promise.resolve([]),
            (agg && typeof agg.loadPendingDispatches === "function")
                ? agg.loadPendingDispatches() : Promise.resolve([]),
            (agg && typeof agg.loadAll === "function")
                ? agg.loadAll({sinceMs: sevenDaysAgo, limit: 50})
                : Promise.resolve([]),
            (window.AesServiceExperimentStore
                && typeof window.AesServiceExperimentStore.outcomes === "function")
                ? window.AesServiceExperimentStore.outcomes()
                    .then(rows => (rows || []).filter(r => r && r.concludedAt && r.concludedAt > sevenDaysAgo))
                : Promise.resolve([])
        ])
        return {
            active:   active   || [],
            pending:  pending  || [],
            recent:   recent   || [],
            outcomes: outcomes || []
        }
    }

    async renderBody(ctx, hostEl) {
        hostEl.textContent = ""
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:12px;padding:8px 4px;"

        const data = await this._loadData()

        const title = document.createElement("div")
        title.textContent = "Weekly review"
        title.style.cssText = "font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;opacity:0.82;"
        wrap.appendChild(title)
        wrap.appendChild(this._buildPendingSection(data.pending))
        wrap.appendChild(this._buildActiveExperimentSection(data.active))
        wrap.appendChild(this._buildRecentApplySection(data.recent))
        if (data.outcomes.length) {
            wrap.appendChild(this._buildConcludedSection(data.outcomes))
        }

        const footer = document.createElement("div")
        footer.style.cssText = "font-size:11px;opacity:0.6;text-align:right;"
        const recentTotal = data.recent.length
        const activeTotal = data.active.length
        const pendingTotal = data.pending.length
        footer.textContent = pendingTotal + " pending · "
            + activeTotal + " active · "
            + recentTotal + " applied (7d)"
        wrap.appendChild(footer)

        hostEl.appendChild(wrap)
    }

    _buildPendingSection(pending) {
        const sec = this._buildSectionShell("Pending dispatches", "#fbbf24")
        if (!pending.length) {
            sec.appendChild(this._emptyRow("No compose requests waiting."))
            return sec
        }
        for (const e of pending) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:10px;font-size:12px;padding:3px 0;"
            const label = document.createElement("div")
            label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;"
            label.textContent = e.summary || ((e.scope && e.scope.routeKey) || "?")
            row.appendChild(label)
            const status = document.createElement("div")
            status.style.cssText = "flex:0 0 auto;opacity:0.7;"
            status.textContent = e.status === "failed" ? "failed — retry" : "pending"
            row.appendChild(status)
            sec.appendChild(row)
        }
        return sec
    }

    _buildActiveExperimentSection(active) {
        const sec = this._buildSectionShell("Active experiments", "#60a5fa")
        if (!active.length) {
            sec.appendChild(this._emptyRow("No A/B tests in progress."))
            return sec
        }
        for (const e of active) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:10px;font-size:12px;padding:3px 0;"
            const label = document.createElement("div")
            label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;"
            label.textContent = e.summary || ("profile #" + (e.scope && e.scope.profileId))
            row.appendChild(label)
            const meta = document.createElement("div")
            meta.style.cssText = "flex:0 0 auto;opacity:0.7;"
            meta.textContent = "active"
            row.appendChild(meta)
            sec.appendChild(row)
        }
        return sec
    }

    _buildRecentApplySection(recent) {
        const sec = this._buildSectionShell("Recent applies (7d)", "#86efac")
        if (!recent.length) {
            sec.appendChild(this._emptyRow("No applied changes in the last week."))
            return sec
        }
        const byDomain = {}
        for (const e of recent) {
            const d = e.domain || "?"
            byDomain[d] = (byDomain[d] || 0) + 1
        }
        const ordered = Object.keys(byDomain).sort((a, b) => byDomain[b] - byDomain[a])
        for (const d of ordered) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:10px;font-size:12px;padding:3px 0;"
            const label = document.createElement("div")
            label.style.cssText = "flex:1 1 auto;"
            label.textContent = d
            row.appendChild(label)
            const count = document.createElement("div")
            count.style.cssText = "flex:0 0 auto;opacity:0.8;"
            count.textContent = String(byDomain[d])
            row.appendChild(count)
            sec.appendChild(row)
        }
        return sec
    }

    _buildConcludedSection(outcomes) {
        const sec = this._buildSectionShell("Concluded experiments (7d)", "#a78bfa")
        for (const o of outcomes.slice(0, 8)) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:10px;font-size:12px;padding:3px 0;"
            const label = document.createElement("div")
            label.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;"
            label.textContent = (o.baseProfileName || ("#" + o.baseProfileId))
                + " · " + (o.state || "concluded")
            row.appendChild(label)
            const winner = (o.outcome && o.outcome.winner) || ""
            if (winner) {
                const meta = document.createElement("div")
                meta.style.cssText = "flex:0 0 auto;opacity:0.7;"
                meta.textContent = "winner: " + winner
                row.appendChild(meta)
            }
            sec.appendChild(row)
        }
        return sec
    }

    _buildSectionShell(title, accent) {
        const sec = document.createElement("div")
        sec.style.cssText = "border:1px solid rgba(127,127,127,0.2);border-radius:6px;"
            + "padding:8px;border-left:3px solid " + accent + ";"
        const h = document.createElement("div")
        h.textContent = title
        h.style.cssText = "font-weight:600;font-size:12px;margin-bottom:6px;color:" + accent + ";"
        sec.appendChild(h)
        return sec
    }

    _emptyRow(text) {
        const empty = document.createElement("div")
        empty.textContent = "—  " + text
        empty.style.cssText = "font-size:12px;opacity:0.6;"
        return empty
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id:       "weekly-review",
        section:  "tools",
        priority: 6,
        factory:  () => new CentralHubWeeklyReviewTile()
    })
}
