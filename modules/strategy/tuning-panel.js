"use strict"

/**
 * AES Strategy — Tuning Panel (Slice 17).
 *
 * Risk-profile picker (Conservative / Balanced / Aggressive / Custom) plus
 * an Advanced expander exposing every individual scoring weight + threshold
 * as a slider. Manual slider movement flips the profile to "custom".
 * Mounts inline into a caller-supplied host element; caller's `onChange`
 * fires after every save so the strategy panel can re-score routes.
 *
 * Public API (window.AesStrategyTuningPanel):
 *   render(host, opts) → teardown()
 *     opts = {settings, onChange?: (newSettings) => void}
 *
 * Renders read-only when AesStrategySettings or AesStrategyRiskProfiles
 * isn't loaded (graceful-null per §4.8).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyTuningPanel) return

    const COLOR = {
        bg:       "#0f172a",
        panel:    "#1f2937",
        rule:     "#374151",
        text:     "#f3f4f6",
        muted:    "#9ca3af",
        accent:   "#a78bfa",
        chipBg:   "#111827"
    }

    // Slider definitions for the Advanced expander. Each row covers one
    // numeric setting; weights live under settings.weights, top-level
    // entries hang directly off settings.
    const WEIGHT_SLIDERS = [
        {key: "profitWeight",        label: "Profit weight",        min: 0,    max: 1,    step: 0.05, fmt: _f2},
        {key: "demandWeight",        label: "Demand weight",        min: 0,    max: 1,    step: 0.05, fmt: _f2},
        {key: "competitorWeight",    label: "Competitor weight",    min: 0,    max: 1,    step: 0.05, fmt: _f2},
        {key: "orsWeight",           label: "ORS weight",           min: 0,    max: 1,    step: 0.05, fmt: _f2},
        {key: "maintenancePenalty",  label: "Maintenance penalty",  min: 0,    max: 1,    step: 0.05, fmt: _f2},
        {key: "cashPenalty",         label: "Cash penalty",         min: 0,    max: 1,    step: 0.05, fmt: _f2},
        {key: "cargoWeightInDemand", label: "Cargo / pax mix",      min: 0,    max: 1,    step: 0.10, fmt: _f2},
        {key: "competitorSaturationCap", label: "Saturated at flights", min: 5,  max: 60, step: 1,   fmt: _f0},
        {key: "profitNormalizer",    label: "Profit normalizer ($/seat-km)", min: 0.5, max: 5.0, step: 0.1, fmt: _f2},
        {key: "wearHeadroomTarget",  label: "Wear headroom target", min: 0.05, max: 0.5,  step: 0.01, fmt: _f2}
    ]

    const TOPLEVEL_SLIDERS = [
        {key: "maxPriceMovePerWindow",  label: "Max price move per window (%)", min: 0,    max: 25,   step: 1,    fmt: _f0},
        {key: "priceDeadband",          label: "Price deadband (%)",            min: 1,    max: 15,   step: 1,    fmt: _f0},
        {key: "routeCreationThreshold", label: "Route-creation threshold",      min: 0.30, max: 0.95, step: 0.05, fmt: _f2},
        {key: "learningStepSize",       label: "Learning step size",            min: 0.01, max: 0.50, step: 0.01, fmt: _f2}
    ]

    function _f0(v) { return String(Math.round(Number(v))) }
    function _f2(v) { const n = Number(v); return isFinite(n) ? n.toFixed(2) : "—" }

    function _el(tag, cssText, text) {
        const el = document.createElement(tag)
        if (cssText) el.style.cssText = cssText
        if (text != null) el.textContent = text
        return el
    }

    function _section(titleText) {
        const sec = _el("div", "padding:8px 16px;border-bottom:1px solid " + COLOR.rule + ";")
        const h = _el("div", "color:" + COLOR.muted + ";font:600 10px sans-serif;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px;", titleText)
        sec.appendChild(h)
        return sec
    }

    function _slider(spec, value, onInput) {
        const row = _el("div", "display:grid;grid-template-columns:200px 1fr 60px;align-items:center;gap:10px;padding:3px 0;font:12px sans-serif;color:" + COLOR.text + ";")
        const lbl = _el("label", "color:" + COLOR.muted + ";", spec.label)
        const inp = _el("input")
        inp.type = "range"
        inp.min  = String(spec.min)
        inp.max  = String(spec.max)
        inp.step = String(spec.step)
        inp.value = String(value != null ? value : spec.min)
        inp.style.cssText = "width:100%;accent-color:" + COLOR.accent + ";"
        const out = _el("output", "color:" + COLOR.text + ";font:600 12px monospace;text-align:right;", spec.fmt(inp.value))
        inp.addEventListener("input", () => { out.textContent = spec.fmt(inp.value) })
        inp.addEventListener("change", () => { onInput(Number(inp.value)) })
        row.append(lbl, inp, out)
        return {row, input: inp, output: out}
    }

    function _resolveWeight(settings, key) {
        const w = settings && settings.weights
        if (w && typeof w[key] === "number" && isFinite(w[key])) return w[key]
        const ns = window.AesStrategy
        if (ns && ns.DEFAULT_WEIGHTS && typeof ns.DEFAULT_WEIGHTS[key] === "number") {
            return ns.DEFAULT_WEIGHTS[key]
        }
        return null
    }

    /**
     * Render the tuning panel into `host`. Returns a teardown function the
     * caller must call before re-rendering or destroying the host.
     */
    function render(host, opts) {
        if (!host) return () => {}
        host.textContent = ""
        opts = opts || {}
        const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {}
        const settings = opts.settings || {}

        if (!window.AesStrategySettings || !window.AesStrategyRiskProfiles) {
            host.appendChild(_el("div", "padding:12px 16px;color:" + COLOR.muted + ";font:12px sans-serif;",
                "Tuning panel needs AesStrategySettings + AesStrategyRiskProfiles — refresh the dashboard."))
            return () => {}
        }

        const RP = window.AesStrategyRiskProfiles
        const wrap = _el("div", "border-bottom:1px solid " + COLOR.rule + ";background:" + COLOR.bg + ";")

        // ── Profile radios ────────────────────────────────────────────────
        const head = _el("div", "display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 16px;background:#0b1220;border-bottom:1px solid " + COLOR.rule + ";")
        const headLbl = _el("label", "color:" + COLOR.muted + ";font:600 11px sans-serif;letter-spacing:0.04em;text-transform:uppercase;", "Risk")
        head.appendChild(headLbl)

        const groupName = "aes-strategy-risk-" + Math.random().toString(36).slice(2, 8)
        const detected  = RP.detect(settings)
        const profileNames = RP.names().concat(detected === "custom" ? ["custom"] : [])
        const blurbHost = _el("span", "color:" + COLOR.muted + ";font:11px sans-serif;flex:1;min-width:200px;", RP.describe(detected).blurb)

        async function _applyProfile(name) {
            try {
                if (name === "custom") {
                    // No-op — "custom" appears only when user diverges from a profile.
                    blurbHost.textContent = RP.describe("custom").blurb
                    return
                }
                const patch = RP.apply(name, settings)
                if (!patch) return
                await window.AesStrategySettings.save(patch)
                const next = await window.AesStrategySettings.load()
                blurbHost.textContent = RP.describe(name).blurb
                onChange(next)
            } catch (e) { console.warn("[AES tuning panel] applyProfile threw", e) }
        }

        for (const name of profileNames) {
            const lbl = _el("label", "display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:" + COLOR.text + ";font:12px sans-serif;")
            const radio = _el("input")
            radio.type = "radio"
            radio.name = groupName
            radio.value = name
            radio.checked = (detected === name)
            radio.style.cssText = "accent-color:" + COLOR.accent + ";"
            radio.addEventListener("change", () => { if (radio.checked) _applyProfile(name) })
            const desc = RP.describe(name)
            lbl.append(radio, _el("span", "", desc.label))
            head.appendChild(lbl)
        }
        head.appendChild(blurbHost)
        wrap.appendChild(head)

        // ── Advanced expander ─────────────────────────────────────────────
        const det = _el("details", "background:" + COLOR.bg + ";")
        const sum = _el("summary", "padding:8px 16px;cursor:pointer;color:" + COLOR.muted + ";font:600 11px sans-serif;letter-spacing:0.04em;text-transform:uppercase;list-style:none;",
            "Advanced — individual weights & thresholds")
        det.appendChild(sum)

        async function _saveSlider(field, key, raw) {
            const value = Number(raw)
            if (!isFinite(value)) return
            try {
                const cur = await window.AesStrategySettings.load()
                let patch
                if (field === "weights") {
                    const curW = (cur.weights && typeof cur.weights === "object") ? cur.weights : {}
                    patch = {weights: Object.assign({}, curW, {[key]: value}), riskProfile: "custom"}
                } else {
                    patch = {[key]: value, riskProfile: "custom"}
                }
                await window.AesStrategySettings.save(patch)
                const next = await window.AesStrategySettings.load()
                onChange(next)
            } catch (e) { console.warn("[AES tuning panel] saveSlider threw", e) }
        }

        const weightSec = _section("Scoring weights")
        for (const spec of WEIGHT_SLIDERS) {
            const value = _resolveWeight(settings, spec.key)
            const row = _slider(spec, value, (v) => _saveSlider("weights", spec.key, v))
            weightSec.appendChild(row.row)
        }
        det.appendChild(weightSec)

        const topSec = _section("Thresholds & learning")
        for (const spec of TOPLEVEL_SLIDERS) {
            const v = (settings && typeof settings[spec.key] === "number") ? settings[spec.key] : null
            const row = _slider(spec, v, (val) => _saveSlider("toplevel", spec.key, val))
            topSec.appendChild(row.row)
        }
        det.appendChild(topSec)

        // ── Reset to defaults ─────────────────────────────────────────────
        const resetWrap = _el("div", "padding:8px 16px;display:flex;justify-content:flex-end;")
        const resetBtn = _el("button", "background:" + COLOR.chipBg + ";color:" + COLOR.muted + ";border:1px solid " + COLOR.rule + ";border-radius:3px;padding:4px 10px;font:600 11px sans-serif;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;", "Reset to balanced")
        resetBtn.type = "button"
        resetBtn.addEventListener("click", () => {
            if (!window.confirm("Reset weights and thresholds to the Balanced profile?")) return
            _applyProfile("balanced")
        })
        resetWrap.appendChild(resetBtn)
        det.appendChild(resetWrap)

        wrap.appendChild(det)
        host.appendChild(wrap)

        return function teardown() {
            try { host.textContent = "" } catch (_) {}
        }
    }

    window.AesStrategyTuningPanel = {render: render}
})()
