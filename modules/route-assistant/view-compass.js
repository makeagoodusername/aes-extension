"use strict"

/**
 * Route Assistant — Pricing Compass view (panelMode = "compass").
 *
 * Per-route surface that integrates the strategy chain (objective + risk
 * profile + per-route override) with all the per-route signals (competitor
 * band, ORS, congestion, demand, anti-spiral, elasticity) and visualises
 * an "advantageous price range" against the competitor band on a single
 * horizontal axis.
 *
 * Read-only in v1. The "Compose" button per class hands the requested
 * price off to AesStrategyDecisionDispatch — the strategy panel scrolls
 * to the matching decision and pre-selects it, but the user still applies
 * through the existing pipeline.
 *
 * Mirrors the shape of view-table.js / view-sandbox.js — a thin static
 * adaptor that the panel's _activeView() picks up. State that's
 * compass-specific lives on the panel as `panel._compassRoute`.
 */
class RouteAssistantCompassView {

    static get id()    { return "compass" }
    static get label() { return "Compass" }
    static get glyph() { return "🧭" }

    static render(panel, sorted) {
        if (!panel || !panel.tableHost) return
        panel.tableHost.innerHTML = ""

        const route = panel._compassRoute || null
        // Restore last-used compass route on first render after toggle-on.
        const cfg = (panel.settings && panel.settings.compass) || {}
        if (!route && cfg.lastRouteIata) {
            const restored = (sorted || []).find(r =>
                String(r.destIata).toUpperCase() === String(cfg.lastRouteIata).toUpperCase())
            if (restored) {
                panel._compassRoute = {hub: panel.hubIata, dest: restored.destIata, _row: restored}
            }
        }

        panel.tableHost.append(RouteAssistantCompassView._buildHeader(panel, sorted))

        if (!panel._compassRoute) {
            panel.tableHost.append(RouteAssistantCompassView._buildPicker(panel, sorted))
            return
        }

        const row = panel._compassRoute._row
            || (sorted || []).find(r =>
                String(r.destIata).toUpperCase() === String(panel._compassRoute.dest).toUpperCase())
        if (!row) {
            panel.tableHost.append(RouteAssistantCompassView._buildMissingRow())
            return
        }
        panel._compassRoute._row = row

        const detailHost = document.createElement("div")
        detailHost.style.cssText = "margin-top:12px;color:#e5e7eb;"
        panel.tableHost.append(detailHost)

        // Loading placeholder while compute runs (single async pass).
        const placeholder = document.createElement("div")
        placeholder.style.cssText = "padding:18px;color:#9ca3af;font-size:12px;"
        placeholder.textContent = "Computing pricing compass…"
        detailHost.append(placeholder)

        if (!window.AesPricingCompass
            || typeof window.AesPricingCompass.computeForRoute !== "function") {
            placeholder.textContent = "AesPricingCompass not loaded — reload the extension."
            return
        }

        window.AesPricingCompass.computeForRoute({
            hub: panel.hubIata, dest: row.destIata, route: row
        }).then(env => {
            detailHost.innerHTML = ""
            if (!env) {
                detailHost.append(RouteAssistantCompassView._buildEmptyEnv())
                return
            }
            RouteAssistantCompassView._renderDetail(panel, detailHost, row, env)
        }).catch(e => {
            console.warn("[AES compass] compute failed", e)
            detailHost.innerHTML = ""
            const err = document.createElement("div")
            err.style.cssText = "padding:14px;border:1px dashed #b91c1c;color:#fecaca;"
            err.textContent = "Compass compute failed: " + ((e && e.message) || String(e))
            detailHost.append(err)
        })
    }

    // ── Header ────────────────────────────────────────────────────────
    static _buildHeader(panel, sorted) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:10px 14px;border:1px solid #475569;border-radius:4px;"
            + "background:rgba(15,22,35,0.7);color:#e5e7eb;display:flex;align-items:center;"
            + "justify-content:space-between;gap:12px;flex-wrap:wrap;"

        const left = document.createElement("div")
        left.style.cssText = "display:flex;align-items:center;gap:10px;"
        const title = document.createElement("strong")
        title.style.cssText = "color:#f3f4f6;font-size:14px;"
        title.textContent = "🧭 Pricing Compass"
        left.append(title)
        const sub = document.createElement("span")
        sub.style.cssText = "color:#9ca3af;font-size:11px;"
        sub.textContent = "Per-route advantageous price range. Read-only in v1."
        left.append(sub)
        wrap.append(left)

        const right = document.createElement("div")
        right.style.cssText = "display:flex;gap:6px;align-items:center;"
        if (panel._compassRoute) {
            const change = document.createElement("button")
            change.type = "button"
            change.textContent = "Change route"
            change.style.cssText = "background:#1f2937;color:#e5e7eb;border:1px solid #475569;"
                + "padding:4px 9px;font-size:11px;border-radius:3px;cursor:pointer;"
            change.addEventListener("click", () => {
                panel._compassRoute = null
                panel._render()
            })
            right.append(change)
        }
        wrap.append(right)
        return wrap
    }

    // ── Route picker ──────────────────────────────────────────────────
    static _buildPicker(panel, sorted) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:14px;padding:14px;border:1px solid #475569;border-radius:4px;"
            + "background:rgba(15,22,35,0.7);color:#e5e7eb;"
        const candidates = (sorted || []).slice()
        const title = document.createElement("div")
        title.style.cssText = "font-size:12px;color:#cbd5e1;margin-bottom:8px;"
        if (!candidates.length) {
            title.innerHTML = "<strong>No routes in the current view.</strong> "
                + "Adjust filters in the Table tab, then return here."
            wrap.append(title)
            return wrap
        }
        title.innerHTML = "<strong>Pick a route.</strong> "
            + "Compass works on every route in the current view "
            + "(<span style='color:#9ca3af;'>" + candidates.length + " visible</span>). "
            + "Routes with no own-pricing or competitor band still render — "
            + "the health banner will tell you what's missing."
        wrap.append(title)

        const sel = document.createElement("select")
        sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #475569;border-radius:3px;"
            + "padding:4px 6px;font-size:12px;width:100%;max-width:520px;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "— select a route —"
        placeholder.selected = true
        sel.append(placeholder)
        for (const r of candidates) {
            const opt = document.createElement("option")
            opt.value = r.destIata
            const score = (typeof r.score === "number") ? Math.round(r.score) : "—"
            const ownY = (r.ownPricing && r.ownPricing.prices && r.ownPricing.prices.Y != null)
                ? Math.round(r.ownPricing.prices.Y) + "%" : "?"
            opt.textContent = String(r.destIata).toUpperCase() + " · " + (r.destName || "")
                + "  (score " + score + " · Y " + ownY + ")"
            sel.append(opt)
        }
        sel.addEventListener("change", () => {
            const dest = sel.value
            if (!dest) return
            const row = candidates.find(r => r.destIata === dest)
            if (!row) return
            panel._compassRoute = {hub: panel.hubIata, dest: row.destIata, _row: row}
            const cfg = Object.assign({}, panel.settings.compass || {})
            cfg.lastRouteIata = row.destIata
            panel.settings.compass = cfg
            try {
                if (typeof RouteAssistantSettings !== "undefined"
                    && RouteAssistantSettings && typeof RouteAssistantSettings.save === "function") {
                    RouteAssistantSettings.save({compass: cfg}).catch(() => {})
                }
            } catch (_) { /* persistence is best-effort */ }
            panel._render()
        })
        wrap.append(sel)
        return wrap
    }

    static _buildMissingRow() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:14px;padding:14px;border:1px dashed #475569;border-radius:4px;"
            + "background:rgba(100,116,139,0.08);color:#cbd5e1;font-size:12px;line-height:1.5;"
        wrap.textContent = "Selected route is not in the current view (filters may have hidden it). "
            + "Click Change route or relax filters."
        return wrap
    }

    static _buildEmptyEnv() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:14px;padding:14px;border:1px dashed #475569;border-radius:4px;"
            + "background:rgba(100,116,139,0.08);color:#cbd5e1;font-size:12px;"
        wrap.textContent = "Compass compute returned nothing. The strategy snapshot couldn't be built — "
            + "check that AesStrategy is loaded and at least one hub/route is in scope."
        return wrap
    }

    // ── Detail render ─────────────────────────────────────────────────
    static _renderDetail(panel, host, row, env) {
        // 1 · Header strip with goal + risk profile.
        host.append(RouteAssistantCompassView._buildContextStrip(env))

        // 2 · Health banner (only if blockers).
        if (env.health && env.health.blockers && env.health.blockers.length) {
            host.append(RouteAssistantCompassView._buildHealthBanner(env))
        }

        // 3 · Range axis — one SVG per class. Stacked vertically.
        const axisWrap = document.createElement("div")
        axisWrap.style.cssText = "margin-top:12px;padding:12px;border:1px solid #475569;border-radius:4px;"
            + "background:rgba(15,22,35,0.55);"
        const axisTitle = document.createElement("div")
        axisTitle.style.cssText = "color:#cbd5e1;font-size:11px;text-transform:uppercase;"
            + "letter-spacing:0.04em;margin-bottom:6px;"
        axisTitle.textContent = "Price range — competitor band shaded · ◉ now · ★ target · range envelope"
        axisWrap.append(axisTitle)

        const classes = ["Y", "C", "F", "Cargo"]
        let renderedAny = false
        for (const cls of classes) {
            const entry = env.perClass && env.perClass[cls]
            if (!entry) continue
            renderedAny = true
            axisWrap.append(RouteAssistantCompassView._buildRangeAxis(cls, entry, env))
        }
        if (!renderedAny) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:#9ca3af;font-size:12px;padding:6px 0;"
            empty.textContent = "No price moves proposed for this route. "
                + "The proposer typically falls silent when (a) no competitor band cached, "
                + "or (b) every class is already inside the deadband. See signals strip below."
            axisWrap.append(empty)
        }
        host.append(axisWrap)

        // 4 · Per-class table with Compose buttons.
        host.append(RouteAssistantCompassView._buildClassTable(panel, env))

        // 4.5 · Phase C3 — cross-feature gating banner. Renders when
        // `env.gates` carries crewPressure or cashLow entries so the user
        // sees why moves were dampened or which domains are vetoed.
        const gatesBanner = RouteAssistantCompassView._buildGatesBanner(env)
        if (gatesBanner) host.append(gatesBanner)

        // 5 · Why card.
        host.append(RouteAssistantCompassView._buildWhyCard(env))

        // 6 · Signals strip.
        host.append(RouteAssistantCompassView._buildSignalsStrip(env))
    }

    /**
     * Phase C3 — render any active cross-feature gates from env.gates.
     * Returns null when nothing is gating so the banner is skipped.
     */
    static _buildGatesBanner(env) {
        const gates = env && env.gates
        if (!gates || !Object.keys(gates).length) return null
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:10px 12px;border-left:3px solid #f59e0b;"
            + "background:rgba(245,158,11,0.08);color:#fde68a;font-size:12px;line-height:1.5;"
            + "border-radius:4px;"
        const title = document.createElement("div")
        title.style.cssText = "color:#fbbf24;font-weight:600;margin-bottom:6px;"
        title.textContent = "Cross-feature gates active"
        wrap.append(title)
        if (gates.crewPressure) {
            const row = document.createElement("div")
            const sevPct = Math.round((gates.crewPressure.severity || 0) * 100)
            const positions = (gates.crewPressure.shortPositions || []).join(", ")
            row.innerHTML = "<strong>crew pressure</strong> · severity " + sevPct + "%"
                + (positions ? " · short on <em>" + positions + "</em>" : "")
                + "<div style='color:#cbd5e1;margin-top:2px;'>"
                + gates.crewPressure.effect + "</div>"
            row.style.cssText = "margin-bottom:6px;"
            wrap.append(row)
        }
        if (gates.cashLow) {
            const row = document.createElement("div")
            row.innerHTML = "<strong>cash runway</strong> · "
                + Math.round(gates.cashLow.runwayWeeks) + " wk"
                + "<div style='color:#cbd5e1;margin-top:2px;'>"
                + gates.cashLow.effect + "</div>"
            wrap.append(row)
        }
        return wrap
    }

    static _buildContextStrip(env) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:10px 12px;border:1px solid #2d3a4f;border-radius:4px;"
            + "background:rgba(20,28,42,0.55);color:#cbd5e1;font-size:12px;display:flex;"
            + "flex-wrap:wrap;gap:14px;align-items:center;"

        const route = document.createElement("div")
        route.innerHTML = "<strong style='color:#f3f4f6;'>"
            + (env.hub || "?") + " → " + (env.dest || "?")
            + "</strong>"
        wrap.append(route)

        const goal = document.createElement("div")
        const objKind = (env.resolvedObjective && env.resolvedObjective.kind) || "?"
        const objSrc  = (env.resolvedObjective && env.resolvedObjective.source) || "default"
        goal.innerHTML = "<span style='color:#9ca3af;'>goal:</span> "
            + "<strong>" + objKind + "</strong> "
            + "<span style='color:#6b7280;'>(" + objSrc + ")</span>"
        wrap.append(goal)

        const risk = document.createElement("div")
        const rp = env.riskProfile || {}
        risk.innerHTML = "<span style='color:#9ca3af;'>risk:</span> "
            + "<strong>" + (rp.name || "?") + "</strong> "
            + "<span style='color:#6b7280;'>"
            + "clamp ±" + (rp.maxMovePerWindowPct || "?") + "pp · "
            + "deadband ±" + (rp.deadbandPct || "?") + "pp</span>"
        wrap.append(risk)

        if (env.solver && env.solver.available) {
            const solver = document.createElement("div")
            solver.innerHTML = "<span style='color:#9ca3af;'>source:</span> "
                + "<strong style='color:#86efac;'>solver</strong> "
                + "<span style='color:#6b7280;'>(joint rank-target tuner)</span>"
            wrap.append(solver)
        } else {
            const fallback = document.createElement("div")
            fallback.innerHTML = "<span style='color:#9ca3af;'>source:</span> "
                + "<strong style='color:#fcd34d;'>fallback</strong> "
                + "<span style='color:#6b7280;'>(competitor-band heuristic)</span>"
            wrap.append(fallback)
        }
        return wrap
    }

    static _buildHealthBanner(env) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:10px 12px;border-left:3px solid #fbbf24;"
            + "background:rgba(251,191,36,0.08);color:#fde68a;font-size:12px;line-height:1.5;"
        const title = document.createElement("strong")
        title.style.cssText = "color:#fbbf24;display:block;margin-bottom:4px;"
        title.textContent = "Compass needs:"
        wrap.append(title)
        const list = document.createElement("ul")
        list.style.cssText = "margin:0;padding-left:18px;"
        for (const b of env.health.blockers) {
            const li = document.createElement("li")
            li.textContent = b
            list.append(li)
        }
        wrap.append(list)
        // Deep-link to markets page when own-pricing or competitor band missing.
        if (env.health.blockers.some(b => /own-price|competitor band/.test(b))) {
            const link = document.createElement("a")
            link.href = "/app/com/markets/" + (env.hub || "") + (env.dest || "")
            link.target = "_blank"
            link.textContent = "Open /app/com/markets/" + (env.hub || "") + (env.dest || "") + " ↗"
            link.style.cssText = "display:inline-block;margin-top:6px;color:#fbbf24;text-decoration:underline;"
            wrap.append(link)
        }
        return wrap
    }

    /**
     * SVG range axis. Domain spans 70%–150%; coordinates project linearly.
     * Renders: competitor band shading, range envelope, current ◉, target ★.
     */
    static _buildRangeAxis(cls, entry, env) {
        const W = 620, H = 56
        const PAD_L = 28, PAD_R = 14, PAD_T = 14, PAD_B = 22
        const lo = 70, hi = 150
        const x = pct => PAD_L + ((Math.max(lo, Math.min(hi, pct)) - lo) / (hi - lo)) * (W - PAD_L - PAD_R)
        const NS = "http://www.w3.org/2000/svg"

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:6px;display:flex;align-items:center;gap:10px;"

        const label = document.createElement("div")
        label.style.cssText = "min-width:60px;color:#cbd5e1;font-size:12px;font-weight:600;"
        const deltaTxt = (entry.deltaPct >= 0 ? "+" : "") + Math.round(entry.deltaPct) + "pp"
        const deltaColor = entry.deltaPct > 0 ? "#86efac" : entry.deltaPct < 0 ? "#fca5a5" : "#9ca3af"
        label.innerHTML = cls
            + "<div style='color:" + deltaColor + ";font-size:10px;font-weight:400;'>" + deltaTxt + "</div>"
        wrap.append(label)

        const svg = document.createElementNS(NS, "svg")
        svg.setAttribute("width", String(W))
        svg.setAttribute("height", String(H))
        svg.setAttribute("viewBox", "0 0 " + W + " " + H)
        svg.style.cssText = "display:block;"

        // Axis baseline.
        const axis = document.createElementNS(NS, "line")
        axis.setAttribute("x1", String(PAD_L))
        axis.setAttribute("x2", String(W - PAD_R))
        axis.setAttribute("y1", String(H - PAD_B))
        axis.setAttribute("y2", String(H - PAD_B))
        axis.setAttribute("stroke", "#475569")
        axis.setAttribute("stroke-width", "1")
        svg.appendChild(axis)

        // Tick marks every 10pp.
        for (let p = 70; p <= 150; p += 10) {
            const t = document.createElementNS(NS, "line")
            t.setAttribute("x1", String(x(p))); t.setAttribute("x2", String(x(p)))
            t.setAttribute("y1", String(H - PAD_B - 3))
            t.setAttribute("y2", String(H - PAD_B + 3))
            t.setAttribute("stroke", "#475569")
            svg.appendChild(t)
            const lbl = document.createElementNS(NS, "text")
            lbl.setAttribute("x", String(x(p)))
            lbl.setAttribute("y", String(H - PAD_B + 14))
            lbl.setAttribute("fill", "#6b7280")
            lbl.setAttribute("font-size", "9")
            lbl.setAttribute("text-anchor", "middle")
            lbl.textContent = String(p) + "%"
            svg.appendChild(lbl)
        }

        // Competitor band shading.
        const band = env.signals && env.signals.competitorBand
        if (band && isFinite(band.priceMin) && isFinite(band.priceMax)) {
            const bx = x(band.priceMin)
            const bw = Math.max(2, x(band.priceMax) - bx)
            const rect = document.createElementNS(NS, "rect")
            rect.setAttribute("x", String(bx))
            rect.setAttribute("y", String(PAD_T))
            rect.setAttribute("width", String(bw))
            rect.setAttribute("height", String(H - PAD_B - PAD_T))
            rect.setAttribute("fill", "rgba(96,165,250,0.18)")
            rect.setAttribute("stroke", "rgba(96,165,250,0.45)")
            rect.setAttribute("stroke-width", "1")
            rect.setAttribute("stroke-dasharray", "3,2")
            svg.appendChild(rect)
        }

        // Range envelope.
        if (isFinite(entry.rangeLoPct) && isFinite(entry.rangeHiPct)) {
            const rx = x(entry.rangeLoPct)
            const rw = Math.max(3, x(entry.rangeHiPct) - rx)
            const env_ = document.createElementNS(NS, "rect")
            env_.setAttribute("x", String(rx))
            env_.setAttribute("y", String(PAD_T + 4))
            env_.setAttribute("width", String(rw))
            env_.setAttribute("height", String(H - PAD_B - PAD_T - 8))
            env_.setAttribute("fill", "rgba(134,239,172,0.18)")
            env_.setAttribute("stroke", "#86efac")
            env_.setAttribute("stroke-width", "1.5")
            env_.setAttribute("rx", "2")
            svg.appendChild(env_)
        }

        // Current ◉ marker.
        if (isFinite(entry.currentPct)) {
            const cx = x(entry.currentPct)
            const cy = H - PAD_B - 7
            const dot = document.createElementNS(NS, "circle")
            dot.setAttribute("cx", String(cx)); dot.setAttribute("cy", String(cy))
            dot.setAttribute("r", "5")
            dot.setAttribute("fill", "#f3f4f6"); dot.setAttribute("stroke", "#0f1623"); dot.setAttribute("stroke-width", "1.5")
            svg.appendChild(dot)
            const lbl = document.createElementNS(NS, "text")
            lbl.setAttribute("x", String(cx)); lbl.setAttribute("y", String(PAD_T))
            lbl.setAttribute("fill", "#cbd5e1"); lbl.setAttribute("font-size", "9")
            lbl.setAttribute("text-anchor", "middle")
            lbl.textContent = "now " + Math.round(entry.currentPct) + "%"
            svg.appendChild(lbl)
        }

        // Target ★ marker.
        if (isFinite(entry.targetPct)) {
            const tx = x(entry.targetPct)
            const ty = H - PAD_B - 7
            const star = document.createElementNS(NS, "text")
            star.setAttribute("x", String(tx)); star.setAttribute("y", String(ty + 4))
            star.setAttribute("fill", "#fbbf24"); star.setAttribute("font-size", "16")
            star.setAttribute("text-anchor", "middle")
            star.textContent = "★"
            svg.appendChild(star)
            const lbl = document.createElementNS(NS, "text")
            lbl.setAttribute("x", String(tx)); lbl.setAttribute("y", String(PAD_T + 9))
            lbl.setAttribute("fill", "#fbbf24"); lbl.setAttribute("font-size", "9")
            lbl.setAttribute("text-anchor", "middle")
            lbl.textContent = "target " + Math.round(entry.targetPct) + "%"
            svg.appendChild(lbl)
        }

        wrap.append(svg)
        return wrap
    }

    static _buildClassTable(panel, env) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:12px;padding:10px;border:1px solid #2d3a4f;border-radius:4px;"
            + "background:rgba(15,22,35,0.55);color:#e5e7eb;"
        const head = document.createElement("div")
        head.style.cssText = "color:#cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;"
        head.textContent = "Per-class proposal"
        wrap.append(head)

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;"
        const thead = document.createElement("thead")
        thead.innerHTML = "<tr style='color:#9ca3af;text-align:left;'>"
            + "<th style='padding:4px 8px;'>Class</th>"
            + "<th style='padding:4px 8px;'>Now → Target</th>"
            + "<th style='padding:4px 8px;'>Range</th>"
            + "<th style='padding:4px 8px;'>Δ</th>"
            + "<th style='padding:4px 8px;'>Est. $/wk</th>"
            + "<th style='padding:4px 8px;'>Action</th>"
            + "</tr>"
        table.append(thead)
        const tbody = document.createElement("tbody")
        const classes = ["Y", "C", "F", "Cargo"]
        let any = false
        for (const cls of classes) {
            const e = env.perClass && env.perClass[cls]
            if (!e) continue
            any = true
            const tr = document.createElement("tr")
            tr.style.cssText = "border-top:1px solid #2d3a4f;"
            const deltaColor = e.deltaPct > 0 ? "#86efac" : e.deltaPct < 0 ? "#fca5a5" : "#9ca3af"
            tr.innerHTML = "<td style='padding:5px 8px;font-weight:600;'>" + cls + "</td>"
                + "<td style='padding:5px 8px;'>" + Math.round(e.currentPct) + "% → "
                + "<strong>" + Math.round(e.targetPct) + "%</strong></td>"
                + "<td style='padding:5px 8px;color:#9ca3af;'>"
                + Math.round(e.rangeLoPct) + "%–" + Math.round(e.rangeHiPct) + "%</td>"
                + "<td style='padding:5px 8px;color:" + deltaColor + ";'>"
                + (e.deltaPct >= 0 ? "+" : "") + Math.round(e.deltaPct) + "pp</td>"
                + "<td style='padding:5px 8px;color:" + (e.impactWeekly > 0 ? "#86efac" : "#fca5a5") + ";'>"
                + (e.impactWeekly == null ? "—"
                    : (e.impactWeekly > 0 ? "+" : "") + "$"
                        + Math.abs(Math.round(e.impactWeekly)).toLocaleString())
                + "</td>"

            const td = document.createElement("td")
            td.style.cssText = "padding:5px 8px;"
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = "Compose"
            btn.title = "Hand off to the strategy panel — pre-selects this decision so you can apply via the existing pipeline."
            btn.style.cssText = "background:#1f2937;color:#e5e7eb;border:1px solid #475569;"
                + "padding:3px 8px;font-size:11px;border-radius:3px;cursor:pointer;"
            btn.addEventListener("click", () => {
                btn.disabled = true
                const orig = btn.textContent
                btn.textContent = "Composing…"
                if (window.AesStrategyDecisionDispatch
                    && typeof window.AesStrategyDecisionDispatch.composeMove === "function") {
                    window.AesStrategyDecisionDispatch.composeMove({
                        hub: env.hub, dest: env.dest, classKey: cls,
                        toPct: e.targetPct, source: "compass"
                    }).then(() => {
                        btn.textContent = "✓ pending"
                        btn.style.color = "#86efac"
                    }).catch(() => {
                        btn.textContent = orig
                        btn.disabled = false
                    })
                } else {
                    btn.textContent = "(dispatch n/a)"
                }
            })
            td.append(btn)
            tr.append(td)
            tbody.append(tr)
        }
        if (!any) {
            const tr = document.createElement("tr")
            tr.innerHTML = "<td colspan='6' style='padding:10px;color:#9ca3af;text-align:center;'>"
                + "No per-class proposals — the proposer didn't emit any move for this route."
                + "</td>"
            tbody.append(tr)
        }
        table.append(tbody)
        wrap.append(table)
        return wrap
    }

    static _buildWhyCard(env) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:12px;padding:10px;border:1px solid #2d3a4f;border-radius:4px;"
            + "background:rgba(15,22,35,0.55);color:#e5e7eb;"
        const head = document.createElement("div")
        head.style.cssText = "color:#cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;"
        head.textContent = "Why"
        wrap.append(head)

        const buckets = new Map()
        const order = ["[market]", "[goal]", "[share]", "[congestion]", "[anti-spiral]",
                       "[elasticity]", "[guardrail]", "[joint]", "[picks]", "[note]"]
        const otherKey = "[other]"
        const collect = (text) => {
            if (!text) return
            let key = otherKey
            for (const k of order) if (text.indexOf(k) === 0) { key = k; break }
            if (!buckets.has(key)) buckets.set(key, [])
            buckets.get(key).push(text)
        }
        const cls = ["Y", "C", "F", "Cargo"]
        const seen = new Set()
        for (const c of cls) {
            const e = env.perClass && env.perClass[c]
            if (!e || !Array.isArray(e.rationale)) continue
            for (const r of e.rationale) {
                if (seen.has(r)) continue
                seen.add(r)
                collect(r)
            }
        }
        if (!buckets.size) {
            const empty = document.createElement("div")
            empty.style.cssText = "color:#9ca3af;font-size:12px;"
            empty.textContent = "No rationale available — proposer emitted no moves for this route."
            wrap.append(empty)
            return wrap
        }
        const list = document.createElement("ul")
        list.style.cssText = "margin:0;padding-left:18px;font-size:12px;line-height:1.55;color:#cbd5e1;"
        const visitOrder = order.concat([otherKey])
        for (const k of visitOrder) {
            if (!buckets.has(k)) continue
            for (const line of buckets.get(k)) {
                const li = document.createElement("li")
                li.textContent = line
                list.append(li)
            }
        }
        wrap.append(list)

        // Solver projection footer.
        if (env.solver && env.solver.available) {
            const foot = document.createElement("div")
            foot.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px dashed #2d3a4f;"
                + "color:#cbd5e1;font-size:11px;display:flex;flex-wrap:wrap;gap:10px;"
            const chip = (label, value, tone) => {
                const c = document.createElement("span")
                c.style.cssText = "padding:2px 6px;border-radius:3px;background:" + (tone || "rgba(96,165,250,0.18)")
                    + ";color:#e5e7eb;font-family:monospace;"
                c.textContent = label + ": " + value
                return c
            }
            const s = env.solver
            const dShare = (s.projectedShare != null && s.baselineShare != null)
                ? ((s.projectedShare - s.baselineShare) * 100).toFixed(1) + "pp"
                : "?"
            foot.append(chip("Δshare", dShare))
            if (s.projectedRankAny != null) foot.append(chip("rank→", s.projectedRankAny.toFixed(1)))
            if (s.projectedProfitWeekly != null) {
                const v = Math.round(s.projectedProfitWeekly).toLocaleString()
                foot.append(chip("profit/wk", "$" + v))
            }
            if (s.comfortDeltaApplied != null) foot.append(chip("comfortΔ", "+" + s.comfortDeltaApplied))
            wrap.append(foot)
        }
        return wrap
    }

    static _buildSignalsStrip(env) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));"
            + "gap:8px;"

        const tile = (title, body, tone) => {
            const t = document.createElement("div")
            t.style.cssText = "padding:8px 10px;border:1px solid " + (tone || "#2d3a4f")
                + ";border-radius:3px;background:rgba(15,22,35,0.55);color:#cbd5e1;font-size:12px;"
            const h = document.createElement("div")
            h.style.cssText = "color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px;"
            h.textContent = title
            t.append(h)
            const b = document.createElement("div")
            b.style.cssText = "color:#e5e7eb;line-height:1.4;"
            if (typeof body === "string") b.innerHTML = body
            else b.append(body)
            t.append(b)
            return t
        }
        const missing = (title, hint) => tile(title,
            "<span style='color:#9ca3af;'>missing</span><br>"
            + "<span style='color:#6b7280;font-size:10px;'>" + hint + "</span>",
            "rgba(251,191,36,0.45)")
        const fmtAge = (ms) => {
            if (!isFinite(ms)) return "?"
            const m = Math.round(ms / 60000)
            if (m < 60)   return m + "m"
            if (m < 1440) return Math.round(m / 60) + "h"
            return Math.round(m / 1440) + "d"
        }

        const s = env.signals || {}
        // Competitor band
        if (s.competitorBand) {
            const cb = s.competitorBand
            const age = cb.scrapedAt ? fmtAge(Date.now() - cb.scrapedAt) : "?"
            wrap.append(tile("Competitor",
                "Band <strong>" + cb.priceMin + "–" + cb.priceMax + "%</strong>"
                + "<br><span style='color:#9ca3af;'>"
                + (cb.dominantCarrier ? cb.dominantCarrier + " · " : "")
                + (cb.flightCount != null ? cb.flightCount + " flt/wk · " : "")
                + "scraped " + age + " ago</span>"))
        } else {
            wrap.append(missing("Competitor", "scrape /app/com/markets/" + env.hub + env.dest))
        }
        // ORS
        if (s.ors) {
            const age = s.ors.scrapedAt ? fmtAge(Date.now() - s.ors.scrapedAt) : "?"
            const rank = (s.ors.rankAny != null) ? s.ors.rankAny.toFixed(1) : "?"
            const classCount = s.ors.byClass ? Object.keys(s.ors.byClass).length : 0
            wrap.append(tile("ORS",
                "Rank <strong>" + rank + "</strong> · " + classCount + " class(es)"
                + "<br><span style='color:#9ca3af;'>scraped " + age + " ago</span>"))
        } else {
            wrap.append(missing("ORS", "Settings → ORS Rank → Sync"))
        }
        // Congestion
        if (s.congestion) {
            const idx = (s.congestion.index != null) ? s.congestion.index.toFixed(2) : "?"
            const ops = (s.congestion.operatorCount != null) ? s.congestion.operatorCount : "?"
            wrap.append(tile("Congestion",
                "Index <strong>" + idx + "</strong>"
                + "<br><span style='color:#9ca3af;'>" + ops + " operator(s) on lane</span>"))
        } else {
            wrap.append(missing("Congestion", "needs ledger + ORS in snapshot"))
        }
        // Demand
        if (s.demand) {
            const px = (s.demand.paxScore != null) ? s.demand.paxScore.toFixed(1) : "?"
            const cg = (s.demand.cargoScore != null) ? s.demand.cargoScore.toFixed(1) : "?"
            wrap.append(tile("Demand",
                "Pax <strong>" + px + "</strong> · Cargo <strong>" + cg + "</strong>"))
        } else {
            wrap.append(missing("Demand", "scrape demand-store"))
        }
        // Anti-spiral
        if (s.competitorIncome && s.competitorIncome.available) {
            const ci = s.competitorIncome
            const tone = ci.damped ? "rgba(251,191,36,0.45)" : "rgba(134,239,172,0.45)"
            wrap.append(tile("Anti-spiral",
                "Comp est <strong>$" + (ci.estProfitPerWeek != null
                    ? ci.estProfitPerWeek.toLocaleString() : "?") + "/wk</strong>"
                + " vs floor $" + (ci.floor != null ? ci.floor.toLocaleString() : "?") + "/wk"
                + "<br><span style='color:#9ca3af;'>conf " + (ci.confidence || "?")
                + (ci.damped ? " · move dampened" : "") + "</span>",
                tone))
        } else {
            wrap.append(missing("Anti-spiral", "needs competitor income inputs"))
        }
        // Elasticity
        if (s.elasticity && s.elasticity.available) {
            const tone = s.elasticity.damped ? "rgba(251,191,36,0.45)" : "rgba(134,239,172,0.45)"
            wrap.append(tile("Elasticity",
                "<strong>" + (s.elasticity.samples || "?") + " snapshots</strong>"
                + (s.elasticity.damped ? " · history says dampen" : " · no penalty"),
                tone))
        } else {
            wrap.append(missing("Elasticity", "needs ≥3 ORS snapshots"))
        }
        // Cache age
        if (s.cacheAges && isFinite(s.cacheAges.maxMs)) {
            const ma = fmtAge(s.cacheAges.maxMs)
            wrap.append(tile("Cache age",
                "Worst-of <strong>" + ma + "</strong> ago"
                + "<br><span style='color:#9ca3af;'>"
                + "comp " + fmtAge(s.cacheAges.competitorMs) + " · "
                + "ors " + fmtAge(s.cacheAges.orsMs) + " · "
                + "own " + fmtAge(s.cacheAges.ownPriceMs) + "</span>"))
        }
        return wrap
    }
}

// ── ?aes-debug smoke ──────────────────────────────────────────────────
try {
    if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
        console.assert(RouteAssistantCompassView.id === "compass",
            "[smoke compass-view] static id stable")
        console.assert(RouteAssistantCompassView.label === "Compass",
            "[smoke compass-view] static label stable")
        console.assert(typeof RouteAssistantCompassView.render === "function",
            "[smoke compass-view] render() exposed")
        // Defensive: render must not throw when panel is malformed.
        try { RouteAssistantCompassView.render(null, []) } catch (e) {
            console.assert(false, "[smoke compass-view] render(null) must not throw: " + e)
        }
        try { RouteAssistantCompassView.render({tableHost: null}, []) } catch (e) {
            console.assert(false, "[smoke compass-view] render({tableHost:null}) must not throw: " + e)
        }
    }
} catch (_) { /* smoke must never break the page */ }
