"use strict"

/**
 * Diagnostics tile — Velvet Cascade · PR 1B.
 *
 * One pane that surfaces the cross-module recording layer the user asked
 * for: which signals are missing, which are stale, which apply paths are
 * failing, what the last auto-tick decided. Read-only — every datum
 * joins existing stores, no new persistence.
 *
 * Status badge:
 *   • "OK"     — no issues
 *   • count    — number of issue rows (stale + missing + failed combined)
 *   • "OFF"    — AesStrategy not loaded
 */
class CentralHubDiagnosticsTile extends window.CentralHubTile {
    constructor() {
        super()
        this.id = "diagnostics"
        this.title = "Diagnostics"
        this.section = "tools"
        this.priority = 9
        this.requiresAirline = false
    }

    watchedStorageKeys() {
        return [
            "aesStrategy:audit",
            "aesStrategy:autoTick:last",
            "routeAssistant:pricingApplyLog",
            "routeAssistant:serviceProfileApplyLog",
            "routeAssistant:ors:",
            "routeAssistant:orsSnapshot:"
        ]
    }

    /**
     * Bus subscription for strategy applies — `chrome.storage.onChanged`
     * already covers post-write refresh, but a strategy apply often
     * touches several keys in quick succession; the bus event arrives
     * synchronously per decision so the tile reflects fresh failures /
     * apply-log additions in the same paint cycle. Auto-disposed via the
     * base class's `_busDisposers` on `dispose()`.
     */
    async mount(container, ctx, opts) {
        await super.mount(container, ctx, opts)
        this.subscribeBus("strategy:decision-applied", () => {
            this.refresh().catch(err =>
                console.warn("[AES diagnostics tile] bus refresh failed", err))
        })
        // Track B — same-page wave preset edits (wave-strip / wave-editor)
        // bypass the watched storage keys; the bus event lets the WAVE
        // PLAN row repaint within the same paint cycle as the edit.
        this.subscribeBus("waves:preset-updated", () => {
            this.refresh().catch(err =>
                console.warn("[AES diagnostics tile] wave bus refresh failed", err))
        })
    }

    async _loadSnapshot() {
        if (!window.AesStrategy || typeof window.AesStrategy.snapshot !== "function") return null
        try { return await window.AesStrategy.snapshot() }
        catch (_) { return null }
    }

    async _loadAutoTick() {
        try {
            const got = await chrome.storage.local.get(["aesStrategy:autoTick:last"])
            return got["aesStrategy:autoTick:last"] || null
        } catch (_) { return null }
    }

    async _loadRecentFailures(limit) {
        const out = []
        try {
            if (window.RouteAssistantPricingApplyLog) {
                const log = new window.RouteAssistantPricingApplyLog()
                const r = await log.getRecent()
                for (const e of r.entries || []) {
                    if (!e || (e.status !== "failed" && !e.warning)) continue
                    out.push({
                        kind:    "price",
                        ts:      e.ts,
                        hub:     e.hub,
                        dest:    e.dest,
                        status:  e.status,
                        warning: e.warning,
                        error:   e.error && e.error.message
                    })
                    if (out.length >= limit) break
                }
            }
            if (window.RouteAssistantServiceProfileApplyLog && out.length < limit) {
                const log = new window.RouteAssistantServiceProfileApplyLog()
                const r = await log.getRecent()
                for (const e of r.entries || []) {
                    if (!e || (e.status !== "failed" && !e.warning)) continue
                    out.push({
                        kind:    "service",
                        ts:      e.ts,
                        profileId: e.profileId,
                        status:  e.status,
                        warning: e.warning,
                        error:   e.error && e.error.message
                    })
                    if (out.length >= limit) break
                }
            }
        } catch (_) {}
        out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
        return out.slice(0, limit)
    }

    /**
     * Survey snapshot routes for staleness. Returns the routes whose ORS
     * data is older than `maxDays` (default 7) — the joint solver
     * degrades to S1 fallback when ORS is missing, and rank attribution
     * needs fresh data, so this is the most actionable diagnostic.
     */
    _findStaleOrsRoutes(snapshot, maxDays) {
        const out = []
        const cutoff = Date.now() - (maxDays || 7) * 86400000
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) for (const r of (h && h.byRoute) || []) {
            if (!r || !r.dest) continue
            const ts = r.orsScrapedAt
            if (ts == null) {
                out.push({hub: h.iata, dest: r.dest, ageDays: null, scrapedAt: null})
            } else if (ts < cutoff) {
                out.push({hub: h.iata, dest: r.dest, ageDays: Math.round((Date.now() - ts) / 86400000), scrapedAt: ts})
            }
        }
        out.sort((a, b) => {
            const aa = a.ageDays == null ? 1e9 : a.ageDays
            const bb = b.ageDays == null ? 1e9 : b.ageDays
            return bb - aa
        })
        return out
    }

    async loadStatus() {
        const KIND = (window.CentralHubStatusBadges && window.CentralHubStatusBadges.KIND) || {}
        if (!window.AesStrategy) {
            return {badge: "OFF", badgeKind: KIND.MUTED || "muted",
                    summary: "AesStrategy not loaded — visit /app/enterprise/dashboard or /app/fleets/*."}
        }
        const [snap, autoTick, fails] = await Promise.all([
            this._loadSnapshot(),
            this._loadAutoTick(),
            this._loadRecentFailures(10)
        ])
        const missing = (snap && Array.isArray(snap.missing)) ? snap.missing.length : 0
        const stale   = snap ? this._findStaleOrsRoutes(snap, 7).length : 0
        const failed  = fails.length
        const total   = missing + stale + failed
        const badge   = total === 0 ? "OK" : String(total)
        const kind    = total === 0 ? (KIND.OK || "ok")
                      : total > 5  ? (KIND.WARN || "warn")
                      :              (KIND.NEUTRAL || "neutral")
        const lastTickTs = autoTick && autoTick.ts ? new Date(autoTick.ts).toLocaleTimeString() : "—"
        return {
            badge: badge, badgeKind: kind,
            summary: missing + " missing · " + stale + " stale ORS · "
                + failed + " failed · last auto-tick " + lastTickTs
        }
    }

    async renderBody(ctx, hostEl) {
        hostEl.textContent = ""
        const T = window.AESTokens || {}
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex; flex-direction:column; gap:12px; padding:8px 4px;"

        const [snap, autoTick, fails] = await Promise.all([
            this._loadSnapshot(),
            this._loadAutoTick(),
            this._loadRecentFailures(8)
        ])

        if (!snap) {
            const note = document.createElement("div")
            note.textContent = "Snapshot unavailable — open a fleets or dashboard page."
            wrap.appendChild(note)
            hostEl.appendChild(wrap)
            return
        }

        wrap.appendChild(this._buildSection("Missing data sources",
            (snap.missing || []).map(m => ({label: m, hint: "snapshot.missing[]"}))))

        const stale = this._findStaleOrsRoutes(snap, 7)
        wrap.appendChild(this._buildSection("Stale ORS (>7d)",
            stale.slice(0, 8).map(s => ({
                label: s.hub + " → " + s.dest,
                hint:  s.ageDays == null ? "no scrape on file" : (s.ageDays + "d old")
            }))))

        wrap.appendChild(this._buildSection("Recent apply failures + warnings",
            fails.map(f => ({
                label: f.kind === "price"
                    ? (f.hub + " → " + f.dest + " · price")
                    : ("profile #" + f.profileId + " · service"),
                hint:  f.warning || (f.error || f.status)
            }))))

        // Track B — wave plan health row. Hidden when SchedulePresets,
        // wave-overlay, or wave-plan-diagnostics aren't loaded on this
        // page, or when no preset is configured for any snapshot hub.
        const waveRow = await this._loadWavePlanRow(snap)
        if (waveRow) wrap.appendChild(this._buildWavePlanSection(waveRow))

        wrap.appendChild(this._buildAutoTickSection(autoTick))

        const note = document.createElement("div")
        note.style.cssText = "font-size:11px; opacity:0.7; margin-top:4px;"
        note.textContent = "Open Strategy → Diagnostics for per-route timeline (route-record stitcher)."
        wrap.appendChild(note)

        hostEl.appendChild(wrap)
    }

    /**
     * Compute a wave-plan diagnostic row for the most-active hub. Returns
     * null when any required module is missing OR no preset matches a
     * snapshot hub. Read-only — never writes to any store.
     */
    async _loadWavePlanRow(snap) {
        if (typeof window.SchedulePresets === "undefined") return null
        if (typeof window.RouteAssistantWaveOverlay === "undefined") return null
        if (typeof window.RouteAssistantWavePlanDiagnostics === "undefined") return null
        const hubs = (snap && Array.isArray(snap.hubs)) ? snap.hubs : []
        if (!hubs.length) return null

        let block
        try { block = await window.SchedulePresets.load() }
        catch (_) { return null }
        const presets = (block && Array.isArray(block.presets)) ? block.presets : []
        if (!presets.length) return null

        const presetByHub = new Map()
        for (const p of presets) {
            const h = String(p.hub || "").toUpperCase()
            if (h && !presetByHub.has(h)) presetByHub.set(h, p)
        }
        let preset = null
        let hubRec = null
        for (const h of hubs) {
            const iata = String(h.iata || "").toUpperCase()
            if (presetByHub.has(iata)) {
                preset = presetByHub.get(iata)
                hubRec = h
                break
            }
        }
        if (!preset && block.defaultPresetId) {
            preset = presets.find(p => p.id === block.defaultPresetId) || null
            const targetHub = String((preset && preset.hub) || "").toUpperCase()
            hubRec = hubs.find(h => String(h.iata || "").toUpperCase() === targetHub) || null
        }
        if (!preset || !hubRec) return null

        const scoredRows = (hubRec.byRoute || []).map(r => ({
            destIata:      r.dest,
            distanceKm:    r.distanceKm,
            paxScore:      r.paxScore,
            cargoScore:    r.cargoScore,
            weeklyFlights: r.weeklyFlights,
            profitPerWeek: r.profitPerWeek,
            aircraftFit:   null
        })).filter(r => r.destIata && typeof r.distanceKm === "number" && r.distanceKm > 0)

        let build
        try {
            build = window.RouteAssistantWaveOverlay.buildSchedule(preset, scoredRows, {
                hubIata: hubRec.iata,
                topN:    Math.max(1, Math.min(scoredRows.length, 50))
            })
        } catch (_) { return null }
        if (!build || !build.preset) return null

        let diag
        try {
            diag = window.RouteAssistantWavePlanDiagnostics.scorePlan(build, scoredRows, {
                hubIata: hubRec.iata
            })
        } catch (_) { return null }
        if (!diag) return null

        const warningWaveCount = (diag.perWave || []).filter(pw =>
            pw.fitQuality === "warn" || pw.fitQuality === "bad").length

        return {
            hub:          hubRec.iata,
            presetName:   preset.name || "(unnamed)",
            planScore:    diag.planScore || 0,
            planGrade:    diag.planGrade || "n/a",
            warningWaves: warningWaveCount,
            totalWaves:   (diag.perWave || []).length
        }
    }

    _buildWavePlanSection(row) {
        const sec = document.createElement("div")
        sec.style.cssText = "border:1px solid rgba(127,127,127,0.2); border-radius:6px;"
            + " padding:8px; display:flex; align-items:center; gap:10px;"

        const head = document.createElement("div")
        head.style.cssText = "font-weight:600; font-size:12px; flex:0 0 auto;"
        head.textContent = "WAVE PLAN"
        sec.appendChild(head)

        const chip = document.createElement("span")
        const color = (typeof window.RouteAssistantWavePlanDiagnostics !== "undefined")
            ? window.RouteAssistantWavePlanDiagnostics.colorForScore(row.planScore)
            : "#cbd5e1"
        chip.textContent = row.planGrade + " · " + row.planScore + "/100"
        chip.style.cssText = "padding:2px 8px; border-radius:10px; font-size:11px;"
            + " font-weight:600; background:rgba(0,0,0,0.25); border:1px solid " + color + ";"
            + " color:" + color + ";"
        sec.appendChild(chip)

        const meta = document.createElement("div")
        meta.style.cssText = "font-size:12px; opacity:0.8; flex:1 1 auto;"
            + " min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
        const warnFrag = row.warningWaves > 0
            ? row.warningWaves + "/" + row.totalWaves + " waves need attention"
            : "all " + row.totalWaves + " waves healthy"
        meta.textContent = row.hub + " · " + row.presetName + " · " + warnFrag
        sec.appendChild(meta)

        return sec
    }

    _buildSection(title, rows) {
        const sec = document.createElement("div")
        sec.style.cssText = "border:1px solid rgba(127,127,127,0.2); border-radius:6px; padding:8px;"
        const h = document.createElement("div")
        h.textContent = title
        h.style.cssText = "font-weight:600; font-size:12px; margin-bottom:6px;"
        sec.appendChild(h)
        if (!rows.length) {
            const empty = document.createElement("div")
            empty.textContent = "—  no entries"
            empty.style.cssText = "font-size:12px; opacity:0.6;"
            sec.appendChild(empty)
            return sec
        }
        for (const r of rows) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex; gap:10px; font-size:12px; padding:2px 0;"
            const label = document.createElement("div")
            label.textContent = r.label
            label.style.cssText = "flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
            const hint = document.createElement("div")
            hint.textContent = r.hint
            hint.style.cssText = "flex:0 0 auto; opacity:0.7;"
            row.appendChild(label)
            row.appendChild(hint)
            sec.appendChild(row)
        }
        return sec
    }

    _buildAutoTickSection(autoTick) {
        const sec = document.createElement("div")
        sec.style.cssText = "border:1px solid rgba(127,127,127,0.2); border-radius:6px; padding:8px;"
        const h = document.createElement("div")
        h.textContent = "Last auto-tick"
        h.style.cssText = "font-weight:600; font-size:12px; margin-bottom:6px;"
        sec.appendChild(h)
        if (!autoTick || !autoTick.ts) {
            const empty = document.createElement("div")
            empty.textContent = "Auto-tick has not run yet."
            empty.style.cssText = "font-size:12px; opacity:0.6;"
            sec.appendChild(empty)
            return sec
        }
        const lines = [
            "ts · " + new Date(autoTick.ts).toLocaleString(),
            "tier · " + (autoTick.tier || "—") + " · domains · " + (autoTick.domains
                ? Object.keys(autoTick.domains).filter(k => autoTick.domains[k]).join(", ") || "(none)"
                : "—"),
            "decisions · applied " + (autoTick.applied || 0)
                + " · skipped " + (autoTick.skipped || 0)
                + " · failed " + ((autoTick.failedDecisions && autoTick.failedDecisions.length) || 0)
        ]
        if (autoTick.skippedReason) lines.push("skipReason · " + autoTick.skippedReason)
        for (const l of lines) {
            const row = document.createElement("div")
            row.textContent = l
            row.style.cssText = "font-size:12px; padding:1px 0;"
            sec.appendChild(row)
        }
        if (Array.isArray(autoTick.failedDecisions) && autoTick.failedDecisions.length) {
            const ul = document.createElement("div")
            ul.style.cssText = "margin-top:6px;"
            for (const f of autoTick.failedDecisions.slice(0, 5)) {
                const row = document.createElement("div")
                row.textContent = "  ✗ " + (f.id || "?") + " · " + (f.error || "?")
                row.style.cssText = "font-size:11px; opacity:0.8;"
                ul.appendChild(row)
            }
            sec.appendChild(ul)
        }
        return sec
    }
}

if (typeof window !== "undefined") {
    window.CentralHubDiagnosticsTile = CentralHubDiagnosticsTile
}
if (typeof window !== "undefined" && window.CentralHubTileRegistry) {
    window.CentralHubTileRegistry.register({
        id: "diagnostics",
        section: "tools",
        priority: 9,
        factory: () => new CentralHubDiagnosticsTile()
    })
}
