"use strict"

/**
 * Lane C — Fleet Optimizer tile (read-only Phase 1).
 *
 * Surfaces the fleet-wide maintenance-ratio gap headline + stress/cold
 * counts on the Central Hub dashboard. Reads via the pure aggregator
 * `AesStrategyFleetUtilization.compute()` over `AesStrategy.snapshot()`
 * + `AesStrategyFleetOptimizerSettings.load()`.
 *
 * Phase 1 ships the surface in read-only mode — no Apply buttons, no
 * proposers wired. Default `targetingEnabled: false` keeps every signal
 * advisory; Phase 3-4 wire the proposer + apply paths.
 *
 * Reads-only contract. No POSTs. No two-gate concerns yet.
 */
class CentralHubFleetOptimizerTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "fleet-optimizer"
        this.title = "Fleet Optimizer"
        this.section = "fleet"
        this.priority = 9      // just above fleet-hub (10)
        this.requiresAirline = false
        this._lastSummary = null
    }

    watchedStorageKeys(ctx) {
        // Fleet keys + maintenance keys + optimizer settings.
        const server = String(ctx && ctx.server || "")
        return [server, "settings", "settings.strategy", "aircraftFlightPlan"]
    }

    openHref() { return "/app/fleets" }

    async _resolveSummary() {
        if (typeof window.AesStrategy === "undefined" || !window.AesStrategy.snapshot) return null
        if (typeof window.AesStrategyFleetUtilization === "undefined") return null
        let snapshot = null
        try {
            const ctx = this.ctx || {}
            snapshot = await window.AesStrategy.snapshot({
                server: ctx.server, airlineCode: ctx.airline || ctx.airlineCode
            })
        } catch (_) { return null }
        if (!snapshot) return null
        let settings = null
        if (window.AesStrategyFleetOptimizerSettings) {
            try { settings = await window.AesStrategyFleetOptimizerSettings.load() }
            catch (_) {}
        }
        const summary = window.AesStrategyFleetUtilization.compute({
            snapshot, settings, fleetPlan: null, regions: null
        })
        this._lastSummary = summary
        return summary
    }

    async loadStatus() {
        const summary = await this._resolveSummary()
        if (!summary || !summary.perAircraft.length) {
            return {
                badge:     "NO DATA",
                badgeKind: window.CentralHubStatusBadges.KIND.MUTED,
                summary:   "Need fleet + wear samples — visit aircraft pages to populate."
            }
        }
        const gap = summary.rollups.ratioGapHeadlinePct
        const stress = summary.candidates.stress.length
        const cold = summary.candidates.slack.length
        const onTarget = summary.perAircraft.filter(r => r.classification === "on-target").length
        const unknown = summary.perAircraft.filter(r => r.classification === "unknown").length
        let badge = "—"
        let kind = window.CentralHubStatusBadges.KIND.MUTED
        if (gap != null) {
            const sign = gap > 0 ? "+" : ""
            badge = sign + gap.toFixed(1) + "pp"
            if (Math.abs(gap) <= 0.5) kind = window.CentralHubStatusBadges.KIND.OK
            else if (Math.abs(gap) <= 2) kind = window.CentralHubStatusBadges.KIND.WARN
            else                          kind = window.CentralHubStatusBadges.KIND.ERROR
        }
        return {
            badge,
            badgeKind: kind,
            summary: stress + " stress · " + cold + " cold · " + onTarget + " on-target"
                + (unknown ? " · " + unknown + " unknown" : "")
        }
    }

    async renderBody(ctx, host) {
        const T = window.AESTokens
        host.textContent = ""
        const summary = this._lastSummary || await this._resolveSummary()
        if (!summary || !summary.perAircraft.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;"
            empty.textContent = "Need a fleet snapshot + wear samples. Visit aircraft pages to populate."
            host.appendChild(empty)
            return
        }

        // Headline strip
        host.appendChild(this._renderHeadline(summary, T))

        // Top stressors + slackers
        if (summary.candidates.stress.length || summary.candidates.slack.length) {
            host.appendChild(this._renderCandidates(summary, T))
        }

        // Diagnostics + drilldown CTA
        host.appendChild(this._renderFooter(summary, T))
    }

    _renderHeadline(summary, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;"
        const r = summary.rollups
        const items = [
            {label: "Avg ratio (14d)",  value: r.fleetAvgRatioForecast14d, unit: "%"},
            {label: "Target avg ratio", value: r.fleetTargetAvgRatio,      unit: "%"},
            {label: "Avg utilization",  value: r.fleetAvgUtilizationPct,   unit: "%"}
        ]
        for (const it of items) {
            const cell = document.createElement("div")
            cell.style.cssText = "padding:8px;border-radius:4px;background:" + (T.color.surfaceMuted || "rgba(148,163,184,0.10)") + ";"
            const lbl = document.createElement("div")
            lbl.style.cssText = "font-size:10px;color:" + T.color.slate + ";text-transform:uppercase;letter-spacing:.04em;"
            lbl.textContent = it.label
            const val = document.createElement("div")
            val.style.cssText = "font-size:18px;font-weight:600;color:" + (T.color.foreground || "#e2e8f0") + ";"
            val.textContent = (it.value == null) ? "—" : (it.value.toFixed(1) + it.unit)
            cell.appendChild(lbl); cell.appendChild(val)
            wrap.appendChild(cell)
        }
        return wrap
    }

    _renderCandidates(summary, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;"

        const stressCol = this._renderCandidateColumn("Top stressors",
            summary.candidates.stress, "ratioGap", "pp", T, "#ef4444")
        const slackCol = this._renderCandidateColumn("Top slack tails",
            summary.candidates.slack, "headroomHours", "h", T, "#3b82f6")
        wrap.appendChild(stressCol)
        wrap.appendChild(slackCol)
        return wrap
    }

    _renderCandidateColumn(title, list, valueKey, unit, T, accent) {
        const col = document.createElement("div")
        const h = document.createElement("div")
        h.style.cssText = "font-size:10px;color:" + T.color.slate + ";text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;"
        h.textContent = title
        col.appendChild(h)
        if (!list.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + T.color.slate + ";font-style:italic;"
            empty.textContent = "—"
            col.appendChild(empty)
            return col
        }
        for (const r of list.slice(0, 3)) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:3px 0;"
            const left = document.createElement("span")
            left.style.cssText = "cursor:pointer;color:" + (T.color.foreground || "#e2e8f0") + ";"
            left.textContent = r.registration || r.aircraftId
            left.title = r.suggestion || ""
            left.addEventListener("click", () => {
                if (window.CentralHubBus) {
                    window.CentralHubBus.emit("focus-aircraft", {aircraftId: r.aircraftId})
                }
            })
            const right = document.createElement("span")
            right.style.cssText = "color:" + accent + ";font-family:ui-monospace,monospace;font-size:11px;"
            const v = r[valueKey]
            right.textContent = (v == null) ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(1) + unit
            row.appendChild(left); row.appendChild(right)
            col.appendChild(row)
        }
        return col
    }

    _renderFooter(summary, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;"

        const diag = document.createElement("span")
        diag.style.cssText = "color:" + T.color.slate + ";"
        const d = summary.diagnostics
        diag.textContent = "Wear: " + d.regressionAircraft + " regression · "
            + d.fallbackAircraft + " fallback"
            + (d.missingFit ? " · " + d.missingFit + " missing" : "")
        wrap.appendChild(diag)

        const cta = document.createElement("button")
        cta.type = "button"
        cta.textContent = "Open drill-down →"
        cta.style.cssText = "padding:4px 10px;border-radius:3px;border:1px solid rgba(148,163,184,0.35);"
            + "background:transparent;color:" + (T.color.foreground || "#e2e8f0") + ";cursor:pointer;font-size:11px;"
        cta.addEventListener("click", () => {
            if (window.AesFleetHubOptimizerDrilldown
                && typeof window.AesFleetHubOptimizerDrilldown.open === "function") {
                window.AesFleetHubOptimizerDrilldown.open({summary})
            } else {
                // Drilldown not yet loaded on this page — navigate to /app/fleets
                window.location.href = "/app/fleets"
            }
        })
        wrap.appendChild(cta)
        return wrap
    }
}

if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "fleet-optimizer",
        section: "fleet",
        priority: 9,
        factory: () => new CentralHubFleetOptimizerTile()
    })
}
