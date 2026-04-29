"use strict"

/**
 * Conductor tile — live feed of typed signals derived by the K1 signal
 * layer. Read-only telemetry surface; K2 will layer scenario fires on top
 * of the same stream.
 *
 * Header: count of signals in last hour + most-recent type/age.
 * Body:   filter chips (all / maint / schedule / scrape / competitor /
 *         cash / auto-drive) + scrollable recency-sorted list, "Clear"
 *         affordance in the footer.
 *
 * Refresh strategy: the base class's _attachStorageListener watches
 * `aesConductor:signals:<server>:<airline>` so every append re-renders.
 * No polling; no manual ticking.
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    const FILTERS = [
        {id: "all",        label: "All",      match: null},
        {id: "maint",      label: "Maint",    match: t => t.indexOf("maintenance.") === 0},
        {id: "schedule",   label: "Schedule", match: t => t.indexOf("schedule.") === 0},
        {id: "scrape",     label: "Scrape",   match: t => t.indexOf("scrape.") === 0},
        {id: "competitor", label: "Compet",   match: t => t.indexOf("competitor.") === 0},
        {id: "cash",       label: "Cash",     match: t => t.indexOf("cash.") === 0},
        {id: "drive",      label: "Drive",    match: t => t.indexOf("auto-drive.") === 0}
    ]

    const TYPE_COLOR = {
        "maintenance.ratio.changed":     "#34d399",
        "maintenance.condition.changed": "#34d399",
        "schedule.scraped":              "#60a5fa",
        "scrape.phase.completed":        "#a78bfa",
        "competitor.changed":            "#f59e0b",
        "cash.balance.changed":          "#f472b6",
        "auto-drive.ticked":             "#7a6f66"
    }

    function _fmtAge(ms) {
        if (!isFinite(ms)) return "—"
        if (ms < 60_000)         return Math.max(1, Math.floor(ms / 1000)) + "s"
        if (ms < 3_600_000)      return Math.floor(ms / 60_000) + "m"
        if (ms < 86_400_000)     return Math.floor(ms / 3_600_000) + "h"
        return Math.floor(ms / 86_400_000) + "d"
    }

    function _fmtTime(ts) {
        if (!isFinite(ts)) return "--:--:--"
        const d = new Date(ts)
        const pad = n => (n < 10 ? "0" + n : "" + n)
        return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
    }

    function _fmtPct(v) { return (v == null || !isFinite(v)) ? "—" : (Math.round(v * 10) / 10) + "%" }
    function _fmtNum(v) { return (v == null || !isFinite(v)) ? "—" : String(Math.round(v)) }

    const SEVERITY_RANK = {alert: 3, warn: 2, info: 1}
    function _sortFires(fires) {
        return fires.slice().sort((a, b) => {
            const sa = SEVERITY_RANK[a.severity] || 0
            const sb = SEVERITY_RANK[b.severity] || 0
            if (sa !== sb) return sb - sa                         // higher severity first
            return (b.firedAt || 0) - (a.firedAt || 0)            // newer first within bucket
        })
    }

    function _payloadSummary(s) {
        const p = s.payload || {}
        switch (s.type) {
            case "maintenance.ratio.changed":
                return (p.aircraftId || "?") + " · ratio " + _fmtPct(p.from) + " → " + _fmtPct(p.to)
            case "maintenance.condition.changed":
                return (p.aircraftId || "?") + " · cond " + _fmtPct(p.from) + " → " + _fmtPct(p.to)
            case "schedule.scraped":
                return (p.aircraftId || "?") + " · " + _fmtNum(p.flightCount) + " flights · "
                    + (p.weeklyBlockMinutes != null ? (p.weeklyBlockMinutes / 60).toFixed(1) + "h block" : "—")
            case "scrape.phase.completed":
                return (p.phaseId || "?") + " · " + _fmtNum(p.succeeded) + "/" + _fmtNum(p.total)
                    + (p.failed ? " · " + _fmtNum(p.failed) + "f" : "")
            case "competitor.changed":
                return (p.routeKey || "?") + " · " + _fmtNum(p.before) + " → " + _fmtNum(p.after)
                    + (p.delta != null ? " (Δ " + (p.delta > 0 ? "+" : "") + p.delta + ")" : "")
            case "cash.balance.changed":
                return _fmtNum(p.from) + " → " + _fmtNum(p.to)
                    + (p.delta != null ? " (Δ " + (p.delta > 0 ? "+" : "") + _fmtNum(p.delta) + ")" : "")
            case "auto-drive.ticked":
                return "reason=" + (p.reason || "?")
                    + (p.ranPhase ? " · ran=" + p.ranPhase : "")
                    + (p.skipped  ? " · skipped=" + p.skipped : "")
            default: {
                try { return JSON.stringify(p).slice(0, 80) } catch (_) { return "" }
            }
        }
    }

    class CentralHubConductorTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id              = "conductor"
            this.title           = "Conductor"
            this.section         = "tools"
            this.priority        = 7
            this.requiresAirline = true
            this._activeFilter   = "all"
        }

        watchedStorageKeys(ctx) {
            if (!ctx || !ctx.server || !ctx.airline) return []
            const tail = ctx.server + ":" + ctx.airline
            const keys = []
            if (window.AesConductorSignalStore)   keys.push(window.AesConductorSignalStore.PREFIX   + tail)
            if (window.AesConductorScenarioStore) keys.push(window.AesConductorScenarioStore.PREFIX + tail)
            if (window.AesConductorRoutineStore)  keys.push(window.AesConductorRoutineStore.PREFIX  + tail)
            return keys
        }

        async loadStatus(ctx) {
            if (typeof window.AesConductorSignalStore === "undefined") {
                return {badge: "OFF", badgeKind: "muted", summary: "Signal store not loaded."}
            }
            const [signals, fires] = await Promise.all([
                window.AesConductorSignalStore.recent(ctx, 500),
                (window.AesConductorScenarioStore
                    ? window.AesConductorScenarioStore.recent(ctx, 200)
                    : Promise.resolve([]))
            ])
            const now = Date.now()
            const lastHourFires = fires.filter(f => (now - (f.firedAt || 0)) < 3_600_000)
            const types = new Set(signals.map(s => s.type))
            const newestFire = fires[0]
            let summary
            if (!signals.length) {
                summary = "0 signals — waiting for the auto-drive to tick"
            } else if (!fires.length) {
                summary = signals.length + " signals · " + types.size + " types · 0 scenarios fired"
            } else {
                summary = signals.length + " signals · " + fires.length + " fires"
                    + (newestFire ? " · last " + newestFire.scenarioId + " " + _fmtAge(now - newestFire.firedAt) + " ago" : "")
            }
            return {
                badge:     String(lastHourFires.length || signals.filter(s => (now - (s.firedAt || 0)) < 3_600_000).length),
                badgeKind: lastHourFires.length > 0 ? "default" : "muted",
                summary:   summary
            }
        }

        async renderBody(ctx, hostEl) {
            const T = window.AESTokens
            hostEl.textContent = ""
            hostEl.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";padding:" + T.sp[3] + ";"

            const [allSignals, fires, routines] = await Promise.all([
                (typeof window.AesConductorSignalStore === "undefined")
                    ? Promise.resolve([])
                    : window.AesConductorSignalStore.recent(ctx, 200),
                (typeof window.AesConductorScenarioStore === "undefined")
                    ? Promise.resolve([])
                    : window.AesConductorScenarioStore.recent(ctx, 30),
                (typeof window.AesConductorRoutineStore === "undefined")
                    ? Promise.resolve([])
                    : window.AesConductorRoutineStore.all(ctx)
            ])
            const filterDef = FILTERS.find(f => f.id === this._activeFilter) || FILTERS[0]
            const filtered = filterDef.match ? allSignals.filter(s => filterDef.match(s.type || "")) : allSignals

            hostEl.appendChild(this._buildRoutinesSection(T, routines))
            hostEl.appendChild(this._buildScenarioSection(T, fires, ctx))
            hostEl.appendChild(this._buildFilterRow(T))
            hostEl.appendChild(this._buildList(T, filtered))
            hostEl.appendChild(this._buildFooter(T, filtered.length, allSignals.length, ctx))
        }

        _buildRoutinesSection(T, routines) {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:1px;"
                + "border:1px solid " + T.color.paperRule + ";"
                + "background:" + T.color.bone3 + ";"

            const active   = routines.filter(r => r.state !== "completed" && r.state !== "expired")
            const archived = routines.filter(r => r.state === "completed" || r.state === "expired")

            const header = document.createElement("div")
            header.style.cssText = "padding:4px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
                + "color:" + T.color.oxide + ";font-weight:700;"
                + "border-bottom:1px solid " + T.color.paperRule + ";"
            header.textContent = "Routines · " + active.length + " active"
                + (archived.length ? " · " + archived.length + " archived" : "")
            wrap.appendChild(header)

            if (!active.length && !archived.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "padding:" + T.sp[2] + " " + T.sp[3] + ";"
                    + "color:" + T.color.slate + ";font-size:" + T.fs.micro + ";font-style:italic;"
                empty.textContent = "No routines spawned yet — they appear when a scenario fires repeatedly for the same target."
                wrap.appendChild(empty)
                return wrap
            }

            const now = Date.now()
            for (const r of active.slice(0, 6))   wrap.appendChild(this._buildRoutineRow(T, r, now, false))
            for (const r of archived.slice(0, 3)) wrap.appendChild(this._buildRoutineRow(T, r, now, true))
            return wrap
        }

        _buildRoutineRow(T, r, now, archived) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;align-items:baseline;gap:" + T.sp[2] + ";"
                + "padding:4px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "border-bottom:1px solid " + T.color.bone2 + ";"
                + (archived ? "opacity:0.55;" : "")

            const stateColor =
                r.state === "completed" ? "#34d399" :
                r.state === "expired"   ? T.color.slate :
                r.state === "proposing" ? "#facc15" :
                                          "#60a5fa"
            const dot = document.createElement("span")
            dot.style.cssText = "display:inline-block;width:6px;height:6px;border-radius:50%;"
                + "background:" + stateColor + ";flex:0 0 auto;"
            dot.title = String(r.state || "?")

            const def = document.createElement("span")
            def.textContent = r.routineDefId
            def.style.cssText = "color:" + T.color.oxide + ";font-weight:700;flex:0 0 auto;"

            const target = document.createElement("span")
            target.textContent = r.target || "?"
            target.style.cssText = "color:" + T.color.oxide2 + ";flex:0 0 auto;"

            const state = document.createElement("span")
            state.textContent = r.state
            state.style.cssText = "color:" + stateColor + ";flex:0 0 auto;text-transform:uppercase;"
                + "letter-spacing:" + T.track.caps + ";"

            const last = document.createElement("span")
            const at = r.lastEventAt || r.spawnedAt || 0
            last.textContent = "last " + _fmtAge(now - at) + " ago"
            last.style.cssText = "color:" + T.color.slate + ";flex:1 1 auto;font-size:10px;"

            const reasonAt = (r.history || []).slice(-1)[0]
            if (reasonAt && reasonAt.reason) {
                row.title = reasonAt.reason
            }

            row.append(dot, def, target, state, last)
            return row
        }

        _buildScenarioSection(T, fires, ctx) {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:1px;"
                + "border:1px solid " + T.color.paperRule + ";"
                + "background:" + T.color.bone2 + ";"

            const counts = {alert: 0, warn: 0, info: 0}
            for (const f of fires) {
                if (counts[f.severity] != null) counts[f.severity]++
                else counts.info++
            }
            const header = document.createElement("div")
            header.style.cssText = "padding:4px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
                + "color:" + T.color.oxide2 + ";"
                + "border-bottom:1px solid " + T.color.paperRule + ";"
            const headerBits = []
            if (counts.alert) headerBits.push(counts.alert + " alert")
            if (counts.warn)  headerBits.push(counts.warn + " warn")
            if (counts.info)  headerBits.push(counts.info + " info")
            header.textContent = "Scenarios · " + (headerBits.length ? headerBits.join(" · ") : (fires.length + " recent"))
            wrap.appendChild(header)

            if (!fires.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "padding:" + T.sp[2] + " " + T.sp[3] + ";"
                    + "color:" + T.color.slate + ";font-size:" + T.fs.micro + ";font-style:italic;"
                empty.textContent = "No scenarios have fired yet — they trigger when signals match a bundled rule."
                wrap.appendChild(empty)
                return wrap
            }

            const sorted = _sortFires(fires)
            const now = Date.now()
            const limit = Math.min(sorted.length, 5)
            for (let i = 0; i < limit; i++) {
                wrap.appendChild(this._buildScenarioRow(T, sorted[i], now, ctx))
            }
            return wrap
        }

        _buildScenarioRow(T, fire, now, ctx) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;align-items:baseline;gap:" + T.sp[2] + ";"
                + "padding:4px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "border-bottom:1px solid " + T.color.bone3 + ";"

            const sevColor = fire.severity === "alert" ? "#f87171"
                          : fire.severity === "warn"   ? "#facc15"
                                                       : T.color.slate
            const dot = document.createElement("span")
            dot.style.cssText = "display:inline-block;width:6px;height:6px;border-radius:50%;"
                + "background:" + sevColor + ";flex:0 0 auto;"
            dot.title = String(fire.severity || "info")

            const time = document.createElement("span")
            time.textContent = _fmtTime(fire.firedAt)
            time.style.cssText = "color:" + T.color.slate + ";flex:0 0 auto;"

            const age = document.createElement("span")
            age.textContent = _fmtAge(now - fire.firedAt) + " ago"
            age.style.cssText = "color:" + T.color.slate + ";flex:0 0 auto;font-size:10px;"

            const id = document.createElement("span")
            id.textContent = fire.scenarioId || "?"
            id.style.cssText = "color:" + T.color.oxide + ";flex:0 0 auto;font-weight:700;"

            const rationale = document.createElement("span")
            rationale.textContent = fire.rationale || ""
            rationale.style.cssText = "color:" + T.color.oxide2 + ";flex:1 1 auto;"
                + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            rationale.title = fire.rationale || ""

            row.append(dot, time, age, id, rationale)

            if (ctx && fire.id && window.AesConductorScenarioStore && typeof window.AesConductorScenarioStore.dismiss === "function") {
                const dismiss = document.createElement("button")
                dismiss.type = "button"
                dismiss.textContent = "✕"
                dismiss.title = "Dismiss"
                dismiss.style.cssText = "flex:0 0 auto;border:none;background:transparent;"
                    + "color:" + T.color.slate + ";cursor:pointer;font-family:" + T.font.mono + ";"
                    + "font-size:" + T.fs.micro + ";padding:0 4px;"
                dismiss.addEventListener("click", async (e) => {
                    e.stopPropagation()
                    try { await window.AesConductorScenarioStore.dismiss(ctx, fire.id) } catch (_) {}
                    this.refresh().catch(() => {})
                })
                row.appendChild(dismiss)
            }
            return row
        }

        _buildFilterRow(T) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[1] + ";"
            for (const f of FILTERS) {
                const btn = document.createElement("button")
                btn.type = "button"
                btn.textContent = f.label
                const active = (this._activeFilter === f.id)
                btn.style.cssText = [
                    "padding:2px 8px",
                    "border:1px solid " + (active ? T.color.oxide : T.color.paperRule),
                    "background:" + (active ? T.color.bone3 : "transparent"),
                    "color:" + T.color.oxide,
                    "font-family:" + T.font.mono,
                    "font-size:" + T.fs.micro,
                    "letter-spacing:" + T.track.mono,
                    "text-transform:uppercase",
                    "cursor:pointer"
                ].join(";")
                btn.addEventListener("click", () => {
                    this._activeFilter = f.id
                    this._renderBodySafe().catch(() => {})
                })
                row.appendChild(btn)
            }
            return row
        }

        _buildList(T, signals) {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:1px;"
                + "max-height:360px;overflow:auto;"
                + "border-top:1px solid " + T.color.paperRule + ";"
                + "border-bottom:1px solid " + T.color.paperRule + ";"
            if (!signals.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "padding:" + T.sp[3] + ";color:" + T.color.slate
                    + ";font-size:" + T.fs.micro + ";font-style:italic;"
                empty.textContent = "No signals match this filter yet."
                wrap.appendChild(empty)
                return wrap
            }
            const now = Date.now()
            for (const s of signals) {
                wrap.appendChild(this._buildRow(T, s, now))
            }
            return wrap
        }

        _buildRow(T, s, now) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;align-items:baseline;gap:" + T.sp[2] + ";"
                + "padding:3px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "border-bottom:1px solid " + T.color.bone3 + ";"

            const time = document.createElement("span")
            time.textContent = _fmtTime(s.firedAt)
            time.style.cssText = "color:" + T.color.slate + ";flex:0 0 auto;"
            time.title = new Date(s.firedAt).toISOString()

            const age = document.createElement("span")
            age.textContent = _fmtAge(now - s.firedAt) + " ago"
            age.style.cssText = "color:" + T.color.slate + ";flex:0 0 auto;font-size:10px;"

            const type = document.createElement("span")
            type.textContent = s.type
            type.style.cssText = "color:" + (TYPE_COLOR[s.type] || T.color.oxide) + ";"
                + "flex:0 0 auto;font-weight:600;"

            const payload = document.createElement("span")
            payload.textContent = _payloadSummary(s)
            payload.style.cssText = "color:" + T.color.oxide + ";flex:1 1 auto;"
                + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            payload.title = (() => { try { return JSON.stringify(s.payload, null, 2) } catch (_) { return "" } })()

            row.append(time, age, type, payload)
            return row
        }

        _buildFooter(T, shown, total, ctx) {
            const footer = document.createElement("div")
            footer.style.cssText = "display:flex;align-items:center;justify-content:space-between;"
                + "color:" + T.color.slate + ";font-size:" + T.fs.micro + ";"
                + "font-family:" + T.font.mono + ";"

            const stats = document.createElement("span")
            stats.textContent = "Showing " + shown + " of " + total + " signals"
                + " · cap " + (window.AesConductorSignalStore && window.AesConductorSignalStore.CAP || 500)

            const clear = document.createElement("button")
            clear.type = "button"
            clear.textContent = "Clear"
            clear.style.cssText = "padding:2px 8px;border:1px solid " + T.color.paperRule + ";"
                + "background:transparent;color:" + T.color.oxide + ";cursor:pointer;"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
            clear.addEventListener("click", async () => {
                if (typeof window.AesConductorSignalStore === "undefined") return
                await window.AesConductorSignalStore.clear(ctx)
                this.refresh().catch(() => {})
            })

            footer.append(stats, clear)
            return footer
        }
    }

    if (window.CentralHubTileRegistry) {
        window.CentralHubTileRegistry.register({
            id:       "conductor",
            section:  "tools",
            priority: 7,
            factory:  () => new CentralHubConductorTile()
        })
    }
})()
