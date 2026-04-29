/**
 * Restructure slice B — Mode pill selector.
 *
 * The four panel modes (Table / Waves / Sandbox / Heatmap) used to live
 * behind icon-only header toggles (📊 🧪 🗺) — easy to hit accidentally,
 * impossible to discover the way back. This module renders an inline
 * pill bar above the chip bar so the active mode is always visible and
 * one click away from any other.
 *
 * Pure renderer — owns its DOM but no state. The panel passes in the
 * current mode + per-mode summary metadata + an `onChange(mode)` callback.
 * Click → callback → panel writes `panelMode` and re-renders. Right side
 * of the row is reserved for mode-specific quick actions (e.g. Compact
 * toggle for Table mode); these are passed in by the panel as
 * `rightActions: [{label, glyph, title, active, onClick}]`.
 */
class RouteAssistantModeTabs {

    /** Stable list of modes — order = pill order in the bar. */
    static get MODES() {
        return [
            {id: "table",   label: "Table",   glyph: "≡",  view: typeof RouteAssistantTableView   !== "undefined" ? RouteAssistantTableView   : null},
            {id: "waves",   label: "Waves",   glyph: "📊", view: typeof RouteAssistantWaveView    !== "undefined" ? RouteAssistantWaveView    : null},
            {id: "sandbox", label: "Sandbox", glyph: "🧪", view: typeof RouteAssistantSandboxView !== "undefined" ? RouteAssistantSandboxView : null},
            {id: "heatmap", label: "Heatmap", glyph: "🗺", view: typeof RouteAssistantHeatmapView !== "undefined" ? RouteAssistantHeatmapView : null},
            {id: "compass", label: "Compass", glyph: "🧭", view: typeof RouteAssistantCompassView !== "undefined" ? RouteAssistantCompassView : null}
        ]
    }

    /**
     * Render the pill bar into `host`. Wipes prior contents first.
     *
     * @param {HTMLElement} host
     * @param {object} opts
     *   - activeMode: "table" | "waves" | "sandbox" | "heatmap" | "federation"
     *   - summaries:  optional {<modeId>: "171 routes" | "no preset" | …}
     *                 small secondary text rendered under each pill label
     *   - onChange:   (mode) => void
     *   - rightActions: optional [{label, glyph, title, active, onClick}]
     *   - extraModes: optional [{id, label, glyph}] appended after the
     *                 baseline four modes. Phase 4 Lane B uses this for
     *                 the canopy/federation pill (gated to multi-account
     *                 installs by the panel before passing in).
     */
    static render(host, opts) {
        if (!host) return
        host.innerHTML = ""
        const o = opts || {}
        const active = o.activeMode || "table"
        const summaries = o.summaries || {}

        Object.assign(host.style, {
            display:        "flex",
            alignItems:     "center",
            gap:            "var(--aes-sp-1)",
            padding:        "var(--aes-sp-1) var(--aes-sp-3)",
            background:     "var(--aes-bone)",
            borderBottom:   "var(--aes-bw-1) solid var(--aes-paper-rule)",
            fontFamily:     "var(--aes-font-display)",
            fontSize:       "var(--aes-fs-small)",
            color:          "var(--aes-oxide)",
            flexShrink:     "0"
        })

        const pillRow = document.createElement("div")
        pillRow.style.cssText = "display:flex;align-items:stretch;gap:0;flex:1;min-width:0;"
        host.append(pillRow)

        const allModes = Array.isArray(o.extraModes) && o.extraModes.length
            ? RouteAssistantModeTabs.MODES.concat(o.extraModes)
            : RouteAssistantModeTabs.MODES
        for (const mode of allModes) {
            pillRow.append(RouteAssistantModeTabs._mkPill(
                mode,
                mode.id === active,
                summaries[mode.id] || "",
                () => o.onChange && o.onChange(mode.id)
            ))
        }

        const rightActions = Array.isArray(o.rightActions) ? o.rightActions : []
        if (rightActions.length) {
            const rightSlot = document.createElement("div")
            rightSlot.style.cssText = "display:flex;align-items:center;gap:var(--aes-sp-1);"
                + "padding-left:var(--aes-sp-2);margin-left:auto;"
            for (const a of rightActions) {
                rightSlot.append(RouteAssistantModeTabs._mkActionBtn(a))
            }
            host.append(rightSlot)
        }
    }

    /** One pill — caps label + tiny secondary line. */
    static _mkPill(mode, isActive, summary, onClick) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.title = isActive
            ? `${mode.label} mode — currently active.`
            : `Switch to ${mode.label} mode.`
        Object.assign(btn.style, {
            display:        "inline-flex",
            flexDirection:  "column",
            alignItems:     "center",
            justifyContent: "center",
            gap:            "0",
            padding:        "var(--aes-sp-1) var(--aes-sp-3)",
            minWidth:       "92px",
            background:     isActive ? "var(--aes-rust)" : "var(--aes-bone-2)",
            color:          isActive ? "var(--aes-bone)" : "var(--aes-oxide)",
            border:         "var(--aes-bw-1) solid " + (isActive ? "var(--aes-rust)" : "var(--aes-paper-rule)"),
            borderRight:    "none",
            cursor:         isActive ? "default" : "pointer",
            fontFamily:     "var(--aes-font-display)",
            textTransform:  "uppercase",
            letterSpacing:  "var(--aes-tracking-caps)",
            lineHeight:     "var(--aes-lh-tight)"
        })
        btn.dataset.modeId = mode.id

        const top = document.createElement("span")
        top.style.cssText = "display:inline-flex;align-items:center;gap:6px;"
            + "font-size:var(--aes-fs-small);font-weight:var(--aes-fw-bold);"
        const glyph = document.createElement("span")
        glyph.textContent = mode.glyph
        glyph.style.cssText = "font-size:11px;opacity:0.8;"
        const label = document.createElement("span")
        label.textContent = mode.label
        top.append(glyph, label)
        btn.append(top)

        if (summary) {
            const sub = document.createElement("span")
            sub.textContent = summary
            sub.style.cssText = "font-size:9px;opacity:0.75;"
                + "font-family:var(--aes-font-mono);text-transform:none;letter-spacing:0;"
                + "margin-top:2px;"
            btn.append(sub)
        }

        if (!isActive && onClick) {
            btn.addEventListener("click", (e) => {
                e.preventDefault()
                onClick()
            })
            btn.addEventListener("mouseenter", () => {
                btn.style.background = "var(--aes-bone-3, var(--aes-bone-2))"
                btn.style.borderColor = "var(--aes-oxide)"
            })
            btn.addEventListener("mouseleave", () => {
                btn.style.background = "var(--aes-bone-2)"
                btn.style.borderColor = "var(--aes-paper-rule)"
            })
        }
        return btn
    }

    /** Right-side mode-specific quick action (compact toggle, etc.). */
    static _mkActionBtn(a) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.title = a.title || a.label || ""
        Object.assign(btn.style, {
            display:       "inline-flex",
            alignItems:    "center",
            gap:           "4px",
            padding:       "4px 10px",
            background:    a.active ? "var(--aes-rust)" : "transparent",
            color:         a.active ? "var(--aes-bone)" : "var(--aes-oxide)",
            border:        "var(--aes-bw-1) solid " + (a.active ? "var(--aes-rust)" : "var(--aes-paper-rule)"),
            cursor:        "pointer",
            fontFamily:    "var(--aes-font-display)",
            fontSize:      "var(--aes-fs-small)",
            textTransform: "uppercase",
            letterSpacing: "var(--aes-tracking-caps)"
        })
        if (a.glyph) {
            const g = document.createElement("span")
            g.textContent = a.glyph
            g.style.cssText = "font-size:11px;"
            btn.append(g)
        }
        if (a.label) {
            const l = document.createElement("span")
            l.textContent = a.label
            btn.append(l)
        }
        if (a.onClick) {
            btn.addEventListener("click", (e) => {
                e.preventDefault()
                a.onClick(e)
            })
        }
        return btn
    }

    /**
     * Helper for the panel — turn the panel's runtime state into the
     * `summaries` map the renderer expects. Centralises the per-mode
     * label logic so the wiring stays one-liner in `_renderRows`.
     */
    static buildSummaries(panel) {
        const s = panel && panel.settings || {}
        const out = {}
        const rowCount = (panel && panel.scoredRows && panel.scoredRows.length) || 0
        out.table = rowCount ? `${rowCount} route${rowCount === 1 ? "" : "s"}`
                              : "no rows"

        const wo = s.waveOverlay || {}
        if (panel && panel._wavePresets) {
            const presets = (panel._wavePresets.presets || [])
            const pickedId = wo.lastPresetId || panel._wavePresets.defaultPresetId
            const preset = pickedId ? presets.find(p => p.id === pickedId) : null
            out.waves = preset ? `top-${wo.topN || 20}` : "no preset"
        } else {
            out.waves = `top-${wo.topN || 20}`
        }

        const sb = s.orsSandbox || {}
        out.sandbox = sb.lastRouteIata ? sb.lastRouteIata : "pick route"

        const hm = s.heatmap || {}
        out.heatmap = hm.metric ? hm.metric : "score"
        return out
    }
}
