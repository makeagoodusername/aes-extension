"use strict"

/**
 * Risk dashboard tile — K12-full surface.
 *
 * Promotes the inline briefing risk-register into a standalone dashboard
 * tile. Aggregates Conductor scenario fires (`aesConductor:fires:*`) by
 * risk category, surfaces top-N attention-ranked fires, and lists the
 * most-recent K14 drift threshold proposals.
 *
 * Reads only — never POSTs, never writes. Tile lives in `tools` at
 * priority 6 (between conductor=5 and conductor-trust=7).
 *
 * Filter tabs: All · Financial · Operational · Competitive · Regulatory.
 * Drift sub-section toggle keeps the body compact for users who only
 * care about scenario fires.
 *
 * Refresh triggers:
 *   - storage change at scenario / drift-proposal / threshold / fireUx
 *   - bus event data:conductor:fireUx:saved (re-render attention order)
 *   - bus event data:conductor:drift:proposal:created
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    const CATEGORY_FILTERS = [
        {id: "all",          label: "All",        category: null},
        {id: "financial",    label: "Fin",        category: "financial"},
        {id: "operational",  label: "Ops",        category: "operational"},
        {id: "competitive",  label: "Cmp",        category: "competitive"},
        {id: "regulatory",   label: "Reg",        category: "regulatory"}
    ]

    const SEVERITY_COLOR = {
        alert: "#f87171",
        warn:  "#facc15",
        info:  "#94a3b8"
    }

    function _fmtAge(ms) {
        if (!isFinite(ms) || ms <= 0) return "—"
        if (ms < 60_000)     return Math.max(1, Math.floor(ms / 1000)) + "s"
        if (ms < 3_600_000)  return Math.floor(ms / 60_000) + "m"
        if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h"
        return Math.floor(ms / 86_400_000) + "d"
    }

    function _fmtNum(v) {
        if (typeof v !== "number" || !isFinite(v)) return "—"
        const a = Math.abs(v)
        if (a >= 1e6) return (v / 1e6).toFixed(1) + "M"
        if (a >= 1e3) return Math.round(v / 1e3) + "k"
        return Math.round(v).toString()
    }

    class CentralHubRiskDashboardTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id              = "risk-dashboard"
            this.title           = "Risk dashboard"
            this.section         = "tools"
            this.priority        = 6
            this.requiresAirline = true
            this._activeFilter   = "all"
            this._showDrift      = true
            this._wired          = false
        }

        watchedStorageKeys(ctx) {
            if (!ctx || !ctx.server || !ctx.airline) return []
            const tail = ctx.server + ":" + ctx.airline
            const keys = []
            if (window.AesConductorScenarioStore) keys.push(window.AesConductorScenarioStore.PREFIX + tail)
            keys.push("aesConductor:driftProposals:" + tail)
            keys.push("aesConductor:thresholds:" + tail)
            keys.push("aesConductor:settings:" + tail)
            if (window.AesConductorTrustStore) keys.push(window.AesConductorTrustStore.PREFIX + tail)
            return keys
        }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    const handler = () => { this.refresh && this.refresh().catch(() => {}) }
                    window.CentralHubBus.on("data:conductor:fireUx:saved", handler)
                    window.CentralHubBus.on("data:conductor:drift:proposal:created", handler)
                }
            } catch (_) { /* noop */ }
        }

        async loadStatus(ctx) {
            this._wireBus()
            if (typeof window.AesConductorRiskRegister === "undefined") {
                return {badge: "OFF", badgeKind: "muted", summary: "Risk-register helper not loaded."}
            }
            const reg = await window.AesConductorRiskRegister.build(ctx, {fireLimit: 50, proposalLimit: 30})
            const c = reg.byCategory || {}
            const total = (c.financial || 0) + (c.operational || 0) + (c.competitive || 0) + (c.regulatory || 0)
            const summary = total === 0
                ? "No active risks"
                : "Active: " + (c.financial || 0) + " fin · " + (c.operational || 0) + " ops · "
                    + (c.competitive || 0) + " cmp · " + (c.regulatory || 0) + " reg"
                    + (reg.driftProposals && reg.driftProposals.length
                        ? " · " + reg.driftProposals.length + " drift"
                        : "")
            return {
                badge: String(total),
                badgeKind: total > 0 ? "default" : "muted",
                summary: summary
            }
        }

        async renderBody(ctx, hostEl) {
            this._wireBus()
            const T = window.AESTokens
            hostEl.textContent = ""
            hostEl.style.cssText = "display:flex;flex-direction:column;gap:" + T.sp[2] + ";padding:" + T.sp[3] + ";"

            if (typeof window.AesConductorRiskRegister === "undefined") {
                const note = document.createElement("div")
                note.style.cssText = "color:" + T.color.slate + ";font-size:" + T.fs.micro + ";font-style:italic;"
                note.textContent = "Risk-register helper not loaded — risk-register.js manifest entry missing."
                hostEl.appendChild(note)
                return
            }

            const filterDef = CATEGORY_FILTERS.find(f => f.id === this._activeFilter) || CATEGORY_FILTERS[0]
            const reg = await window.AesConductorRiskRegister.build(ctx, {
                fireLimit:        50,
                proposalLimit:    30,
                filterCategory:   filterDef.category
            })

            hostEl.appendChild(this._buildCountStrip(T, reg))
            hostEl.appendChild(this._buildFilterRow(T))
            hostEl.appendChild(this._buildFiresList(T, reg, ctx))
            hostEl.appendChild(this._buildDriftSection(T, reg))
        }

        _buildCountStrip(T, reg) {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;align-items:baseline;gap:" + T.sp[2] + ";"
                + "border:1px solid " + T.color.paperRule + ";"
                + "background:" + T.color.bone3 + ";padding:6px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"

            const c = reg.byCategory || {}
            const cats = [
                {label: "Fin", n: c.financial   || 0, color: "#f472b6"},
                {label: "Ops", n: c.operational || 0, color: "#34d399"},
                {label: "Cmp", n: c.competitive || 0, color: "#f59e0b"},
                {label: "Reg", n: c.regulatory  || 0, color: "#a78bfa"}
            ]
            for (const cat of cats) {
                const chip = document.createElement("span")
                chip.style.cssText = "display:inline-flex;gap:4px;align-items:baseline;"
                    + "color:" + (cat.n > 0 ? T.color.oxide : T.color.slate) + ";"
                    + "letter-spacing:" + T.track.mono + ";"

                const dot = document.createElement("span")
                dot.style.cssText = "display:inline-block;width:6px;height:6px;border-radius:50%;"
                    + "background:" + (cat.n > 0 ? cat.color : T.color.paperRule) + ";"
                chip.append(dot, document.createTextNode(cat.label + " " + cat.n))
                wrap.appendChild(chip)
            }

            const spacer = document.createElement("span")
            spacer.style.cssText = "flex:1 1 auto;"
            wrap.appendChild(spacer)

            const totalChip = document.createElement("span")
            totalChip.style.cssText = "color:" + T.color.oxide + ";font-weight:700;"
            totalChip.textContent = "Total " + (reg.count || 0)
            wrap.appendChild(totalChip)
            return wrap
        }

        _buildFilterRow(T) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;flex-wrap:wrap;gap:" + T.sp[1] + ";"

            for (const f of CATEGORY_FILTERS) {
                const btn = document.createElement("button")
                btn.type = "button"
                btn.textContent = f.label
                const active = (this._activeFilter === f.id)
                btn.style.cssText = "padding:2px 8px;"
                    + "border:1px solid " + (active ? T.color.oxide : T.color.paperRule) + ";"
                    + "background:" + (active ? T.color.bone3 : "transparent") + ";"
                    + "color:" + T.color.oxide + ";font-family:" + T.font.mono + ";"
                    + "font-size:" + T.fs.micro + ";letter-spacing:" + T.track.mono + ";"
                    + "text-transform:uppercase;cursor:pointer;"
                btn.addEventListener("click", () => {
                    this._activeFilter = f.id
                    this.refresh().catch(() => {})
                })
                row.appendChild(btn)
            }

            const spacer = document.createElement("span")
            spacer.style.cssText = "flex:1 1 auto;"
            row.appendChild(spacer)

            const driftBtn = document.createElement("button")
            driftBtn.type = "button"
            driftBtn.textContent = this._showDrift ? "Drift ▾" : "Drift ▸"
            driftBtn.title = "Toggle drift proposals section"
            driftBtn.style.cssText = "padding:2px 8px;border:1px solid " + T.color.paperRule + ";"
                + "background:transparent;color:" + T.color.oxide + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "letter-spacing:" + T.track.mono + ";text-transform:uppercase;cursor:pointer;"
            driftBtn.addEventListener("click", () => {
                this._showDrift = !this._showDrift
                this.refresh().catch(() => {})
            })
            row.appendChild(driftBtn)
            return row
        }

        _buildFiresList(T, reg, ctx) {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:1px;"
                + "border:1px solid " + T.color.paperRule + ";"
                + "background:" + T.color.bone2 + ";"
                + "max-height:280px;overflow:auto;"

            const fires = reg.fires || []
            if (!fires.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "padding:" + T.sp[2] + " " + T.sp[3] + ";"
                    + "color:" + T.color.slate + ";font-size:" + T.fs.micro + ";font-style:italic;"
                empty.textContent = "No risks in this category."
                wrap.appendChild(empty)
                return wrap
            }
            const now = Date.now()
            for (const f of fires) wrap.appendChild(this._buildFireRow(T, f, now, ctx))
            return wrap
        }

        _buildFireRow(T, f, now, ctx) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;align-items:baseline;gap:" + T.sp[2] + ";"
                + "padding:4px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "border-bottom:1px solid " + T.color.bone3 + ";"
                + (f.openUrl ? "cursor:pointer;" : "")

            const dot = document.createElement("span")
            dot.style.cssText = "display:inline-block;width:6px;height:6px;border-radius:50%;"
                + "background:" + (SEVERITY_COLOR[f.severity] || SEVERITY_COLOR.info) + ";"
                + "flex:0 0 auto;"
            dot.title = f.severity + (f.tier ? " · tier " + f.tier : "")

            const cat = document.createElement("span")
            cat.textContent = (f.category || "ops").slice(0, 3).toUpperCase()
            cat.style.cssText = "color:" + T.color.slate + ";flex:0 0 auto;letter-spacing:" + T.track.mono + ";"

            const age = document.createElement("span")
            age.textContent = _fmtAge(now - (f.firedAt || 0))
            age.style.cssText = "color:" + T.color.slate + ";flex:0 0 auto;font-size:10px;"

            const id = document.createElement("span")
            id.textContent = f.scenarioId || f.label || "?"
            id.style.cssText = "color:" + T.color.oxide + ";flex:0 0 auto;font-weight:700;"

            const rationale = document.createElement("span")
            rationale.textContent = f.rationale || ""
            rationale.style.cssText = "color:" + T.color.oxide2 + ";flex:1 1 auto;"
                + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            rationale.title = f.rationale || ""

            row.append(dot, cat, age, id, rationale)

            if (f.outcome && f.outcome.favourable === false) {
                const o = document.createElement("span")
                o.textContent = "✗"
                o.title = f.outcome.reason || "unfavourable outcome"
                o.style.cssText = "color:#f87171;font-weight:700;flex:0 0 auto;"
                row.appendChild(o)
            }

            if (f.openUrl) {
                row.addEventListener("click", () => {
                    try {
                        if (ctx && f.fireId && window.AesConductorScenarioStore
                                && typeof window.AesConductorScenarioStore.accept === "function") {
                            window.AesConductorScenarioStore.accept(ctx, f.fireId).catch(() => {})
                        }
                        window.open(f.openUrl, "_blank")
                    } catch (_) { /* noop */ }
                })
            }
            return row
        }

        _buildDriftSection(T, reg) {
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;flex-direction:column;gap:1px;"
                + "border:1px solid " + T.color.paperRule + ";"
                + "background:" + T.color.bone3 + ";"
            const header = document.createElement("div")
            header.style.cssText = "padding:4px " + T.sp[2] + ";"
                + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                + "letter-spacing:" + T.track.caps + ";text-transform:uppercase;"
                + "color:" + T.color.oxide2 + ";font-weight:700;"
                + "border-bottom:1px solid " + T.color.paperRule + ";"
            header.textContent = "Self-tuning · " + (reg.driftProposals ? reg.driftProposals.length : 0)
            wrap.appendChild(header)

            if (!this._showDrift) return wrap

            if (!reg.driftProposals || !reg.driftProposals.length) {
                const empty = document.createElement("div")
                empty.style.cssText = "padding:" + T.sp[2] + " " + T.sp[3] + ";"
                    + "color:" + T.color.slate + ";font-size:" + T.fs.micro + ";font-style:italic;"
                empty.textContent = "No drift proposals yet — K14 fires when a scenario's residual stream trips its CUSUM."
                wrap.appendChild(empty)
                return wrap
            }
            for (const p of reg.driftProposals) {
                const row = document.createElement("div")
                row.style.cssText = "display:flex;align-items:baseline;gap:" + T.sp[2] + ";"
                    + "padding:3px " + T.sp[2] + ";"
                    + "font-family:" + T.font.mono + ";font-size:" + T.fs.micro + ";"
                    + "border-bottom:1px solid " + T.color.bone2 + ";"
                    + (p.accepted ? "" : "opacity:0.85;")
                const sid = document.createElement("span")
                sid.textContent = p.scenarioId
                sid.style.cssText = "color:" + T.color.oxide + ";font-weight:700;flex:0 0 auto;"
                const key = document.createElement("span")
                key.textContent = "/" + p.key
                key.style.cssText = "color:" + T.color.slate + ";flex:0 0 auto;"
                const move = document.createElement("span")
                move.textContent = _fmtNum(p.current) + " → " + _fmtNum(p.proposed)
                move.style.cssText = "color:" + T.color.oxide2 + ";flex:0 0 auto;letter-spacing:" + T.track.mono + ";"
                const reason = document.createElement("span")
                reason.textContent = p.reason || ""
                reason.style.cssText = "color:" + T.color.slate + ";flex:1 1 auto;"
                    + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;"
                reason.title = p.reason || ""
                const status = document.createElement("span")
                status.textContent = p.accepted ? "applied" : "pending"
                status.style.cssText = "color:" + (p.accepted ? "#34d399" : T.color.slate) + ";flex:0 0 auto;"
                    + "letter-spacing:" + T.track.caps + ";text-transform:uppercase;font-size:10px;"
                row.append(sid, key, move, reason, status)
                wrap.appendChild(row)
            }
            return wrap
        }
    }

    if (window.CentralHubTileRegistry) {
        window.CentralHubTileRegistry.register({
            id:       "risk-dashboard",
            section:  "tools",
            priority: 6,
            factory:  () => new CentralHubRiskDashboardTile()
        })
    }
})()
