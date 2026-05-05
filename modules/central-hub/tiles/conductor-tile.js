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
    /** K9-aware sort. When AesConductorAttention is loaded, score by
     *  severity × trust × recency × pin/snooze. Falls back to the original
     *  severity-bucket sort when the module is missing. */
    function _sortFires(fires, trustByScenario, settings) {
        if (window.AesConductorAttention && typeof window.AesConductorAttention.sortFires === "function") {
            return window.AesConductorAttention.sortFires(fires, trustByScenario || {}, settings || {fireUx: {}}, Date.now())
        }
        return fires.slice().sort((a, b) => {
            const sa = SEVERITY_RANK[a.severity] || 0
            const sb = SEVERITY_RANK[b.severity] || 0
            if (sa !== sb) return sb - sa                         // higher severity first
            return (b.firedAt || 0) - (a.firedAt || 0)            // newer first within bucket
        })
    }

    /** K10 — render the outcome chip glyph + tooltip. Returns null when the
     *  scenario isn't instrumented (no `kpiWindowMs` declared) so the row
     *  can omit the chip entirely rather than show a confusing "—". */
    function _outcomeChip(T, fire) {
        if (!fire) return null
        const scenarios = (window.AesConductorScenarios && window.AesConductorScenarios.all)
            ? window.AesConductorScenarios.all() : []
        const scenario = scenarios.find(s => s && s.id === fire.scenarioId) || null
        if (!scenario || !scenario.kpiWindowMs) return null
        const o = fire.outcome
        let glyph, color, tip
        if (!o) {
            glyph = "?"; color = T.color.slate
            tip = "Awaiting outcome — KPI window " + Math.round(scenario.kpiWindowMs / 86_400_000) + "d"
        } else if (o.favourable === true) {
            glyph = "✓"; color = "#34d399"
            tip = o.reason || "Favourable outcome"
        } else if (o.favourable === false) {
            glyph = "✗"; color = "#f87171"
            tip = o.reason || "Unfavourable outcome"
        } else {
            glyph = "?"; color = T.color.slate
            tip = o.reason || "No verdict yet"
        }
        if (o && (o.observedDelta != null || o.expectedDelta != null)) {
            tip += "\nobs=" + (o.observedDelta != null ? Math.round(o.observedDelta * 100) / 100 : "—")
                + " exp=" + (o.expectedDelta != null ? Math.round(o.expectedDelta * 100) / 100 : "—")
        }
        const span = document.createElement("span")
        span.textContent = glyph
        span.title = tip
        span.style.cssText = "flex:0 0 auto;color:" + color + ";font-weight:700;"
            + "font-family:" + T.font.mono + ";min-width:10px;text-align:center;"
        return span
    }

    /** K15 — render a 1-line forecast chip "P50 -12% / 4w" when the fire's
     *  scenario declares a `forecast:` field and an envelope is reachable.
     *  Two sources, in order:
     *    1. fire.payload.{p10,p50,p90,horizonDays}  (scenarios that consume
     *       a forecast at match time, e.g. CashCrunchForecast)
     *    2. AesConductorForecastStore cache for the scenario's first
     *       declared (metric, scope, scopeId)
     *  Returns null when neither resolves. The chip is informational only —
     *  no click affordance — to keep row height stable. */
    function _forecastChip(T, fire) {
        if (!fire) return null
        const scenarios = (window.AesConductorScenarios && window.AesConductorScenarios.all)
            ? window.AesConductorScenarios.all() : []
        const scenario = scenarios.find(s => s && s.id === fire.scenarioId) || null
        if (!scenario || !scenario.forecast) return null

        let env = null
        const fp = fire.payload || {}
        if (typeof fp.p50 === "number" && isFinite(fp.p50)) {
            env = {p10: fp.p10, p50: fp.p50, p90: fp.p90, horizonDays: fp.horizonDays, model: fp.model}
        } else {
            const list = Array.isArray(scenario.forecast) ? scenario.forecast : [scenario.forecast]
            const spec = list[0]
            const fs = window.AesConductorForecastStore
            if (spec && fs && typeof fs.peek === "function") {
                const blob = fs.peek()
                if (blob) {
                    let composite = String(spec.metric) + ":" + String(spec.scope || "global")
                        + ":" + String(spec.scopeId == null ? "" : spec.scopeId)
                    let e = blob[composite]
                    if (!e && spec.scopeId === "*") {
                        const fp = fire.payload || {}
                        const rk = (fp.hub && fp.dest) ? (String(fp.hub).toUpperCase() + "-" + String(fp.dest).toUpperCase()) : ""
                        const id = spec.scope === "tail" ? (fp.aircraftId || "") : rk
                        if (id) {
                            composite = String(spec.metric) + ":" + String(spec.scope || "global") + ":" + id
                            e = blob[composite]
                        }
                    }
                    if (e && typeof e.p50 === "number") {
                        env = {p10: e.p10, p50: e.p50, p90: e.p90, horizonDays: e.horizon, model: e.model}
                    }
                }
            }
        }
        if (!env || typeof env.p50 !== "number" || !isFinite(env.p50)) return null

        const horizon = (typeof env.horizonDays === "number" && env.horizonDays > 0) ? env.horizonDays : null
        const horizonLabel = horizon != null
            ? (horizon >= 7 ? Math.round(horizon / 7) + "w" : horizon + "d")
            : ""
        const fmt = (v) => {
            if (typeof v !== "number" || !isFinite(v)) return "—"
            const a = Math.abs(v)
            if (a >= 1e6) return (v / 1e6).toFixed(1) + "M"
            if (a >= 1e3) return Math.round(v / 1e3) + "k"
            return Math.round(v).toString()
        }
        const text = "P50 " + fmt(env.p50) + (horizonLabel ? " / " + horizonLabel : "")
        const span = document.createElement("span")
        span.textContent = text
        span.title = (env.model ? env.model + " · " : "")
            + "P10 " + fmt(env.p10) + " · P50 " + fmt(env.p50) + " · P90 " + fmt(env.p90)
            + (horizonLabel ? " · horizon " + horizonLabel : "")
        span.style.cssText = "flex:0 0 auto;color:" + T.color.oxide2 + ";"
            + "font-family:" + T.font.mono + ";font-size:10px;"
            + "border:1px solid " + T.color.paperRule + ";border-radius:3px;"
            + "padding:0 4px;letter-spacing:" + T.track.mono + ";"
        return span
    }

    /** K4 — render the 🔒 glyph + tooltip when a routine is holding the
     *  fire's resource. Returns null when no lock matches.
     *  `locks` is the LockStore.loadCached(host) blob keyed by
     *  "<resType>:<resId>"; we resolve the fire's payload to candidate
     *  resource keys (aircraftId → aircraft, hub:dest → route) and pick
     *  the first match. */
    function _lockGlyph(T, fire, locks) {
        if (!fire || !locks || typeof locks !== "object") return null
        const p = fire.payload || {}
        const candidates = []
        if (p.aircraftId) candidates.push("aircraft:" + String(p.aircraftId))
        if (p.hub && p.dest) {
            candidates.push("route:" + String(p.hub).toUpperCase() + ":" + String(p.dest).toUpperCase())
        }
        if (fire.scenarioId === "CashStep" || fire.scenarioId === "CashCrunchForecast") {
            if (fire.server && fire.airline) candidates.push("account:" + fire.server + ":" + fire.airline)
        }
        let entry = null
        for (const k of candidates) {
            const e = locks[k]
            if (!e || typeof e !== "object") continue
            const ttlMs = (typeof e.ttlMs === "number") ? e.ttlMs : 600_000
            if (e.acquiredAt && (Date.now() - e.acquiredAt) > ttlMs) continue
            entry = {key: k, e}
            break
        }
        if (!entry) return null
        const span = document.createElement("span")
        span.textContent = "🔒"
        const owner = entry.e.owner || "?"
        const ageMs = entry.e.acquiredAt ? (Date.now() - entry.e.acquiredAt) : 0
        const ageStr = _fmtAge(ageMs)
        span.title = "Reserved by " + owner + " · " + entry.key + " · " + ageStr + " ago"
            + (entry.e.reason ? "\n" + entry.e.reason : "")
        span.style.cssText = "flex:0 0 auto;color:" + T.color.slate + ";"
            + "font-family:" + T.font.mono + ";font-size:11px;cursor:default;"
        return span
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
            this.priority        = 5
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
            // K9 — re-render when the user pins/snoozes a fire from any tab.
            keys.push("aesConductor:settings:" + tail)
            // K11 — re-render on trust posterior updates so the score reorders.
            if (window.AesConductorTrustStore) keys.push(window.AesConductorTrustStore.PREFIX + tail)
            // K4 — re-render lock glyph when a routine acquires/releases.
            if (window.AesConductorLockStore)  keys.push(window.AesConductorLockStore.PREFIX  + tail)
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

            const [allSignals, fires, routines, trustByScenario, fireUxSettings, locks] = await Promise.all([
                (typeof window.AesConductorSignalStore === "undefined")
                    ? Promise.resolve([])
                    : window.AesConductorSignalStore.recent(ctx, 200),
                (typeof window.AesConductorScenarioStore === "undefined")
                    ? Promise.resolve([])
                    : window.AesConductorScenarioStore.recent(ctx, 30),
                (typeof window.AesConductorRoutineStore === "undefined")
                    ? Promise.resolve([])
                    : window.AesConductorRoutineStore.all(ctx),
                (window.AesConductorTrustStore && typeof window.AesConductorTrustStore.load === "function")
                    ? window.AesConductorTrustStore.load(ctx).catch(() => ({}))
                    : Promise.resolve({}),
                (window.AesConductorAttention && typeof window.AesConductorAttention.readFireUxSettings === "function")
                    ? window.AesConductorAttention.readFireUxSettings(ctx).catch(() => ({fireUx: {}}))
                    : Promise.resolve({fireUx: {}}),
                (window.AesConductorLockStore && typeof window.AesConductorLockStore.loadCached === "function")
                    ? window.AesConductorLockStore.loadCached(ctx).catch(() => ({}))
                    : Promise.resolve({})
            ])

            // K15 — warm the forecast-store cache once per render so the
            // forecast chips can resolve sync without an await per row.
            try {
                const fs = window.AesConductorForecastStore
                if (fs && typeof fs.loadCached === "function") await fs.loadCached(ctx)
            } catch (_) { /* noop */ }
            const filterDef = FILTERS.find(f => f.id === this._activeFilter) || FILTERS[0]
            const filtered = filterDef.match ? allSignals.filter(s => filterDef.match(s.type || "")) : allSignals

            hostEl.appendChild(this._buildRoutinesSection(T, routines))
            hostEl.appendChild(this._buildScenarioSection(T, fires, ctx, trustByScenario, fireUxSettings, locks))
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

        _buildScenarioSection(T, fires, ctx, trustByScenario, fireUxSettings, locks) {
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

            const sorted = _sortFires(fires, trustByScenario, fireUxSettings)
            const now = Date.now()
            const limit = Math.min(sorted.length, 5)
            for (let i = 0; i < limit; i++) {
                wrap.appendChild(this._buildScenarioRow(T, sorted[i], now, ctx, fireUxSettings, locks))
            }
            return wrap
        }

        _buildScenarioRow(T, fire, now, ctx, fireUxSettings, locks) {
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

            // K4 — show 🔒 when a routine has reserved this fire's resource.
            const lockGlyph = _lockGlyph(T, fire, locks)
            if (lockGlyph) row.appendChild(lockGlyph)

            const chip = _outcomeChip(T, fire)
            if (chip) row.appendChild(chip)

            // K15 — forecast chip. CashCrunchForecast stamps the envelope on
            // the fire payload at match time; other scenarios with a declared
            // `forecast:` field read live from the cached store. Hidden when
            // no envelope is reachable. Compact "P50 -12% / 4w" style.
            const fc = _forecastChip(T, fire)
            if (fc) row.appendChild(fc)

            // K10 — Open CTA: deep-links to the scenario's recommended
            // surface (per scenario.openUrl) and writes acceptanceState.
            // Hidden when the scenario doesn't define openUrl (alert-tier
            // info scenarios where there's no canonical destination yet).
            const scenarios = (window.AesConductorScenarios && window.AesConductorScenarios.all)
                ? window.AesConductorScenarios.all() : []
            const scenario = scenarios.find(s => s && s.id === fire.scenarioId) || null
            if (ctx && fire.id && scenario && typeof scenario.openUrl === "function"
                    && fire.acceptanceState !== "dismissed" && !fire.dismissedAt
                    && window.AesConductorScenarioStore
                    && typeof window.AesConductorScenarioStore.accept === "function") {
                const url = scenario.openUrl(fire)
                if (url) {
                    const open = document.createElement("button")
                    open.type = "button"
                    open.textContent = (fire.acceptanceState === "accepted") ? "✓ Open" : "Open"
                    open.title = "Open " + url + " (records as accepted for K11 trust)"
                    open.style.cssText = "flex:0 0 auto;border:1px solid " + T.color.paperRule + ";"
                        + "background:transparent;color:" + T.color.oxide + ";cursor:pointer;"
                        + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                        + "padding:1px 6px;letter-spacing:" + T.track.mono + ";"
                    open.addEventListener("click", async (e) => {
                        e.stopPropagation()
                        try { await window.AesConductorScenarioStore.accept(ctx, fire.id) } catch (_) {}
                        try { window.open(url, "_blank") } catch (_) { /* noop */ }
                        this.refresh().catch(() => {})
                    })
                    row.appendChild(open)
                }
            }

            // K9 — Pin/Snooze affordances. Pin floats the fire to the top of
            // the attention queue across reloads; Snooze hides it for 24h.
            if (ctx && fire.id && window.AesConductorAttention
                    && typeof window.AesConductorAttention.applyFireUx === "function"
                    && fire.acceptanceState !== "dismissed" && !fire.dismissedAt) {
                const ux = (fireUxSettings && fireUxSettings.fireUx && fireUxSettings.fireUx[fire.id]) || null
                const pinned = !!(ux && ux.pinned)
                const snoozed = !!(ux && typeof ux.snoozedUntil === "number" && ux.snoozedUntil > now)

                const pinBtn = document.createElement("button")
                pinBtn.type = "button"
                pinBtn.textContent = pinned ? "★" : "☆"
                pinBtn.title = pinned ? "Unpin (drop attention bonus)" : "Pin (float to top of attention queue)"
                pinBtn.style.cssText = "flex:0 0 auto;border:none;background:transparent;"
                    + "color:" + (pinned ? "#facc15" : T.color.slate) + ";cursor:pointer;"
                    + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";padding:0 2px;"
                pinBtn.addEventListener("click", async (e) => {
                    e.stopPropagation()
                    try { await window.AesConductorAttention.applyFireUx(ctx, fire.id, pinned ? "unpin" : "pin") } catch (_) {}
                    this.refresh().catch(() => {})
                })
                row.appendChild(pinBtn)

                const snoozeBtn = document.createElement("button")
                snoozeBtn.type = "button"
                snoozeBtn.textContent = snoozed ? "⏰" : "⌛"
                snoozeBtn.title = snoozed ? "Unsnooze" : "Snooze 24h (hide from attention)"
                snoozeBtn.style.cssText = "flex:0 0 auto;border:none;background:transparent;"
                    + "color:" + (snoozed ? "#60a5fa" : T.color.slate) + ";cursor:pointer;"
                    + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";padding:0 2px;"
                snoozeBtn.addEventListener("click", async (e) => {
                    e.stopPropagation()
                    try { await window.AesConductorAttention.applyFireUx(ctx, fire.id, snoozed ? "unsnooze" : "snooze") } catch (_) {}
                    this.refresh().catch(() => {})
                })
                row.appendChild(snoozeBtn)
            }

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
            // Defensive — `new Date(undefined).toISOString()` throws RangeError,
            // which would tear the whole signal list down on a single
            // malformed entry. Older callers (or seeded fixtures) may lack
            // firedAt; surface "?" rather than crash.
            try { time.title = new Date(s.firedAt).toISOString() }
            catch (_) { time.title = "(no timestamp)" }

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
                + "font-family:" + T.font.mono + ";gap:" + T.sp[2] + ";flex-wrap:wrap;"

            const stats = document.createElement("span")
            stats.textContent = "Showing " + shown + " of " + total + " signals"
                + " · cap " + (window.AesConductorSignalStore && window.AesConductorSignalStore.CAP || 500)
            stats.style.cssText = "flex:1 1 auto;min-width:0;"

            const actions = document.createElement("div")
            actions.style.cssText = "display:flex;gap:" + T.sp[1] + ";flex:0 0 auto;flex-wrap:wrap;"

            const _btn = (label, title, onClick) => {
                const b = document.createElement("button")
                b.type = "button"
                b.textContent = label
                b.title = title || ""
                b.style.cssText = "padding:2px 8px;border:1px solid " + T.color.paperRule + ";"
                    + "background:transparent;color:" + T.color.oxide + ";cursor:pointer;"
                    + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                b.addEventListener("click", onClick)
                return b
            }

            // K10 outcome-driver — manual tick. Lets the user score open
            // fires now instead of waiting for the next interval.
            if (window.AesConductorOutcomeDriver
                    && typeof window.AesConductorOutcomeDriver.tickOnce === "function") {
                actions.appendChild(_btn("Tick outcomes",
                    "Run AesConductorOutcomeDriver.tickOnce({force:true}) — re-scores open fires now.",
                    async (ev) => {
                        const b = ev.currentTarget
                        b.disabled = true
                        try { await window.AesConductorOutcomeDriver.tickOnce({force: true}) }
                        catch (_) {}
                        finally { b.disabled = false }
                        this.refresh().catch(() => {})
                    }))
            }

            // Clear scenario fires.
            if (window.AesConductorScenarioStore
                    && typeof window.AesConductorScenarioStore.clear === "function") {
                actions.appendChild(_btn("Clear fires",
                    "Erase the per-airline scenario-fire ring.",
                    async () => {
                        if (!ctx) return
                        await window.AesConductorScenarioStore.clear(ctx)
                        this.refresh().catch(() => {})
                    }))
            }

            // Clear routines.
            if (window.AesConductorRoutineStore
                    && typeof window.AesConductorRoutineStore.clear === "function") {
                actions.appendChild(_btn("Clear routines",
                    "Erase active + archived routine instances for this airline.",
                    async () => {
                        if (!ctx) return
                        await window.AesConductorRoutineStore.clear(ctx)
                        this.refresh().catch(() => {})
                    }))
            }

            // Existing — clear signal ring.
            actions.appendChild(_btn("Clear signals",
                "Erase the per-airline conductor:signal ring.",
                async () => {
                    if (typeof window.AesConductorSignalStore === "undefined") return
                    await window.AesConductorSignalStore.clear(ctx)
                    this.refresh().catch(() => {})
                }))

            footer.append(stats, actions)
            return footer
        }
    }

    if (window.CentralHubTileRegistry) {
        window.CentralHubTileRegistry.register({
            id:       "conductor",
            section:  "tools",
            priority: 5,
            factory:  () => new CentralHubConductorTile()
        })
    }
})()
