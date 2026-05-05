/**
 * Collapsible "Scoring" section for the in-page market panel.
 *
 * Lets the user tune the deal-classifier blend live: a strategic-intent
 * preset dropdown + Lease/Buy mode badge across the top, then per-component
 * sliders, a lease term input, and a fuel-efficiency master toggle.
 *
 * Pure rendering against the supplied `data` object — the panel owns state
 * and persists changes via callbacks.
 *
 *   data = {weights, enabled, leaseConfig, fuelConfig, open,
 *           presets: [{id, name, builtIn, mode, blurb}],
 *           activePresetId}
 *   cb   = {onChange(partial), onReset(), onToggleOpen(),
 *           onPresetApply(presetId), onPresetSave()}
 *
 * Partials passed to onChange always carry only the changed top-level keys
 * (classifierWeights, leaseConfig, fuelConfig), letting the panel debounce
 * + persist exactly what moved without re-saving the whole settings blob.
 */
class MarketPanelScoringControls {
    static COMPONENTS = [
        {key: "pricePerSeat",   label: "Price / seat"},
        {key: "seatKmYearCost", label: "Lifecycle ratio"},
        {key: "fuelEfficiency", label: "Fuel efficiency"},
        {key: "condition",      label: "Condition"},
        {key: "age",            label: "Age"},
        {key: "expiry",         label: "Bid expiry"},
        {key: "fleetSynergy",   label: "Fleet synergy"},
        {key: "routeFit",       label: "Route fit"}
    ]

    static render(host, data, cb) {
        host.innerHTML = ""
        host.style.cssText = [
            "background:var(--aes-bone)",
            "border-bottom:1px solid var(--aes-paper-rule)",
            "font-family:var(--aes-font-display)",
            "font-size:11px"
        ].join(";")

        const weights        = (data && data.weights)     || {}
        const enabled        = (data && data.enabled)     || {}
        const leaseConfig    = (data && data.leaseConfig) || {}
        const fuelConfig     = (data && data.fuelConfig)  || {}
        const open           = !!(data && data.open)
        const presets        = (data && Array.isArray(data.presets)) ? data.presets : []
        const activePresetId = (data && data.activePresetId) || null

        host.append(MarketPanelScoringControls._renderHeader(weights, enabled, leaseConfig, open, cb))
        if (!open) return

        const body = document.createElement("div")
        body.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:8px;"

        body.append(MarketPanelScoringControls._renderPresetBar(presets, activePresetId, leaseConfig, cb))
        body.append(MarketPanelScoringControls._renderGlobals(leaseConfig, fuelConfig, cb))
        body.append(MarketPanelScoringControls._renderSliders(weights, enabled, cb))
        body.append(MarketPanelScoringControls._renderFooter(cb))

        host.append(body)
    }

    static _renderPresetBar(presets, activeId, leaseConfig, cb) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;"

        const label = document.createElement("span")
        label.textContent = "Preset"
        label.style.cssText = "color:var(--aes-slate);font-family:var(--aes-font-display);font-size:11px;"

        const sel = document.createElement("select")
        sel.className = "aes-input"
        sel.style.cssText = "font-family:var(--aes-font-mono);font-size:11px;min-width:200px;"

        const customOpt = document.createElement("option")
        customOpt.value = ""
        customOpt.textContent = "— Custom —"
        sel.append(customOpt)

        const groups = [
            {label: "Built-in", items: presets.filter(p => p && p.builtIn)},
            {label: "Saved",    items: presets.filter(p => p && !p.builtIn)}
        ]
        for (const g of groups) {
            if (!g.items.length) continue
            const og = document.createElement("optgroup")
            og.label = g.label
            for (const p of g.items) {
                const opt = document.createElement("option")
                opt.value = p.id
                opt.textContent = p.name + (p.mode ? "  · " + p.mode : "")
                if (p.id === activeId) opt.selected = true
                og.append(opt)
            }
            sel.append(og)
        }
        if (!activeId) customOpt.selected = true

        sel.addEventListener("change", () => {
            const id = sel.value
            if (!id) return  // "Custom" — no-op; user keeps current settings.
            if (cb && typeof cb.onPresetApply === "function") cb.onPresetApply(id)
        })
        wrap.append(label, sel)

        const mode = (typeof MarketScanDealClassifier !== "undefined")
            ? MarketScanDealClassifier.normalizeMode(leaseConfig && leaseConfig.mode)
            : (leaseConfig && leaseConfig.mode === "buy" ? "buy" : "lease")
        const isLease = mode === "lease"
        const badge = document.createElement("span")
        badge.textContent = isLease ? "LEASE" : "BUY"
        badge.title = isLease
            ? "Lease mode: scoring by lease rate × term; LEASING RATE column shown. Rows without a lease offer drop out of price scoring."
            : "Buy mode: scoring still anchored on lease rate (asset value); displayed price columns swap to NEXT BID + IMMEDIATE PURCHASE so you see what you'll actually pay."
        badge.style.cssText = [
            "font-family:var(--aes-font-mono)",
            "font-size:10px",
            "letter-spacing:var(--aes-tracking-caps)",
            "padding:2px 8px",
            "border-radius:3px",
            "background:" + (isLease ? "#2F5F3F" : "#3656A8"),
            "color:#fff",
            "font-weight:bold"
        ].join(";")

        const modeBtn = document.createElement("button")
        modeBtn.type = "button"
        modeBtn.textContent = "Switch to " + (isLease ? "Buy" : "Lease")
        modeBtn.className = "aes-btn aes-btn--sm"
        modeBtn.style.cssText = "font-size:10px;"
        modeBtn.addEventListener("click", () => {
            cb.onChange({leaseConfig: {mode: isLease ? "buy" : "lease"}})
        })

        const save = document.createElement("button")
        save.type = "button"
        save.textContent = "Save as preset"
        save.className = "aes-btn aes-btn--sm"
        save.style.cssText = "font-size:10px;"
        save.addEventListener("click", () => {
            if (cb && typeof cb.onPresetSave === "function") cb.onPresetSave()
        })

        wrap.append(badge, modeBtn, save)
        return wrap
    }

    static _renderHeader(weights, enabled, leaseConfig, open, cb) {
        const header = document.createElement("button")
        header.type = "button"
        header.style.cssText = [
            "all:unset",
            "display:flex",
            "align-items:center",
            "gap:8px",
            "padding:6px 12px",
            "cursor:pointer",
            "width:100%",
            "box-sizing:border-box"
        ].join(";")

        const chevron = document.createElement("span")
        chevron.textContent = open ? "▾" : "▸"
        chevron.style.cssText = "font-family:var(--aes-font-mono);color:var(--aes-slate);width:10px;"

        const title = document.createElement("span")
        title.textContent = "Scoring"
        title.style.cssText = [
            "font:9px var(--aes-font-display)",
            "font-weight:var(--aes-fw-bold)",
            "letter-spacing:var(--aes-tracking-caps)",
            "text-transform:uppercase",
            "color:var(--aes-slate)"
        ].join(";")

        const summary = document.createElement("span")
        const activeCount = MarketPanelScoringControls.COMPONENTS.filter(
            c => enabled[c.key] !== false && Number(weights[c.key]) > 0
        ).length
        const basis = leaseConfig.mode === "buy" ? "buy mode" : "lease mode"
        summary.textContent = activeCount + " active · " + basis
        summary.style.cssText = "color:var(--aes-slate);font-family:var(--aes-font-mono);font-size:10px;flex:1 1 auto;"

        header.append(chevron, title, summary)
        header.addEventListener("click", () => cb.onToggleOpen && cb.onToggleOpen())
        return header
    }

    static _renderGlobals(leaseConfig, fuelConfig, cb) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;"

        const termWrap = document.createElement("label")
        termWrap.style.cssText = "display:flex;align-items:center;gap:6px;color:var(--aes-slate);"
        const termLabel = document.createElement("span")
        termLabel.textContent = "Lease term (months)"
        const termInput = document.createElement("input")
        termInput.type = "number"
        termInput.min = "12"
        termInput.max = "240"
        termInput.step = "1"
        termInput.value = String(Number(leaseConfig.termMonths) || 60)
        termInput.className = "aes-input"
        termInput.style.cssText = "width:64px;font-family:var(--aes-font-mono);font-size:11px;"
        termInput.addEventListener("change", () => {
            const next = Math.max(12, Math.min(240, Math.round(Number(termInput.value) || 60)))
            termInput.value = String(next)
            cb.onChange({leaseConfig: {termMonths: next}})
        })
        termWrap.append(termLabel, termInput)
        wrap.append(termWrap)

        wrap.append(MarketPanelScoringControls._toggle(
            "Include fuel efficiency",
            fuelConfig.enabled !== false,
            v => cb.onChange({
                fuelConfig:        {enabled: v},
                classifierWeights: {enabled: {fuelEfficiency: v}}
            })
        ))

        return wrap
    }

    static _renderSliders(weights, enabled, cb) {
        // "Effective influence" = weight ÷ Σ enabled-weights — same blend the
        // classifier uses so users see exactly what their current shares are.
        let totalEnabled = 0
        for (const c of MarketPanelScoringControls.COMPONENTS) {
            if (enabled[c.key] === false) continue
            const w = Math.max(0, Number(weights[c.key]) || 0)
            totalEnabled += w
        }

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr auto auto;gap:4px 8px;align-items:center;"

        for (const c of MarketPanelScoringControls.COMPONENTS) {
            const isOn = enabled[c.key] !== false
            const w    = Math.max(0, Math.min(100, Number(weights[c.key]) || 0))

            const checkbox = document.createElement("input")
            checkbox.type = "checkbox"
            checkbox.checked = isOn
            checkbox.addEventListener("change", () => {
                const partial = {classifierWeights: {enabled: {[c.key]: checkbox.checked}}}
                // Fuel efficiency mirrors fuelConfig.enabled — keep them in
                // sync so the master toggle and the per-component toggle
                // never disagree.
                if (c.key === "fuelEfficiency") {
                    partial.fuelConfig = {enabled: checkbox.checked}
                }
                cb.onChange(partial)
            })

            const label = document.createElement("span")
            label.textContent = c.label
            label.style.cssText = "color:var(--aes-oxide);font-family:var(--aes-font-display);"
            if (!isOn) label.style.opacity = "0.55"

            const slider = document.createElement("input")
            slider.type = "range"
            slider.min = "0"
            slider.max = "100"
            slider.step = "1"
            slider.value = String(w)
            slider.disabled = !isOn
            slider.style.cssText = "width:120px;"

            const valueEl = document.createElement("span")
            valueEl.style.cssText = "font-family:var(--aes-font-mono);color:var(--aes-slate);min-width:64px;text-align:right;font-size:10px;"
            const renderValue = (current) => {
                const share = isOn && totalEnabled > 0
                    ? Math.round((current / totalEnabled) * 100) + "%"
                    : "off"
                valueEl.textContent = current + " (" + share + ")"
            }
            renderValue(w)

            slider.addEventListener("input", () => renderValue(Number(slider.value)))
            slider.addEventListener("change", () => {
                cb.onChange({classifierWeights: {[c.key]: Number(slider.value)}})
            })

            grid.append(checkbox, label, slider, valueEl)
        }

        return grid
    }

    static _renderFooter(cb) {
        const footer = document.createElement("div")
        footer.style.cssText = "display:flex;justify-content:flex-end;"
        const reset = document.createElement("button")
        reset.type = "button"
        reset.textContent = "Reset to defaults"
        reset.className = "aes-btn aes-btn--sm"
        reset.addEventListener("click", () => cb.onReset && cb.onReset())
        footer.append(reset)
        return footer
    }

    static _toggle(label, value, onChange) {
        const wrap = document.createElement("label")
        wrap.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--aes-oxide);"
        const cb = document.createElement("input")
        cb.type = "checkbox"
        cb.checked = !!value
        cb.addEventListener("change", () => onChange(cb.checked))
        const text = document.createElement("span")
        text.textContent = label
        wrap.append(cb, text)
        return wrap
    }
}

if (typeof module !== "undefined" && module.exports) module.exports = MarketPanelScoringControls
