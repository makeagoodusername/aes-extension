"use strict"

/**
 * Letter L slice L5 — Strategy DNA wizard.
 *
 * Two modes:
 *   - `open({reason: "first-run"})` — 5-page stepper, no Cancel; user must Finish.
 *   - `open({reason: "edit"})`      — single scrollable page with Save/Close.
 *
 * Both modes share the same dimension widgets. The wizard accumulates the
 * full DNA into a local `_draft` and writes through `AesCanopyDnaStore.saveTemplate`
 * only on Finish/Save — no partial commits during navigation.
 *
 * Page → dimensions:
 *   P1 Identity        riskProfile · tempo · brandStance
 *   P2 Network         networkShape · countryFocus
 *   P3 Cabin & cargo   serviceMix · cargoEmphasis
 *   P4 Fleet           manufacturerPrefs · sizeMixTargets
 *   P5 Cadence         growthPosture · confirmation
 */
;(function () {
    if (window.AesCanopyDnaWizard) return

    const PAGES = [
        {key: "identity",   title: "Identity",            blurb: "How does your airline behave at a glance?",                                            dims: ["riskProfile", "tempo", "brandStance"]},
        {key: "network",    title: "Network",             blurb: "Where does the route map go?",                                                          dims: ["networkShape", "countryFocus"]},
        {key: "cabinCargo", title: "Cabin & cargo",       blurb: "What share of revenue comes from each cabin and cargo?",                                dims: ["serviceMix", "cargoEmphasis"]},
        {key: "fleet",      title: "Fleet",               blurb: "What aircraft do you prefer to run?",                                                   dims: ["manufacturerPrefs", "sizeMixTargets"]},
        {key: "cadence",    title: "Cadence",             blurb: "How fast do you grow?",                                                                 dims: ["growthPosture"]}
    ]

    let _modal = null
    let _state = {mode: "edit", pageIndex: 0, draft: null}

    function _esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }

    function _ensureModal() {
        if (_modal) return _modal
        const root = document.createElement("div")
        root.id = "aes-dna-wizard"
        root.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.65);z-index:999988;display:none;align-items:flex-start;justify-content:center;padding-top:6vh;"
        root.addEventListener("click", (e) => { if (e.target === root && _state.mode !== "first-run") close() })
        const box = document.createElement("div")
        box.style.cssText = "width:min(720px,94vw);max-height:86vh;background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,0.25);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif;"
        root.appendChild(box)

        const header = document.createElement("div")
        header.id = "aes-dna-wiz-header"
        header.style.cssText = "padding:14px 18px;border-bottom:1px solid rgba(148,163,184,0.18)"
        box.appendChild(header)

        const body = document.createElement("div")
        body.id = "aes-dna-wiz-body"
        body.style.cssText = "padding:14px 18px;overflow-y:auto;flex:1"
        box.appendChild(body)

        const footer = document.createElement("div")
        footer.id = "aes-dna-wiz-footer"
        footer.style.cssText = "padding:10px 18px;border-top:1px solid rgba(148,163,184,0.18);display:flex;justify-content:space-between;align-items:center;gap:8px"
        box.appendChild(footer)

        document.body.appendChild(root)
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && root.style.display !== "none" && _state.mode !== "first-run") close()
        })
        _modal = root
        return root
    }

    function _render() {
        const header = document.getElementById("aes-dna-wiz-header")
        const body   = document.getElementById("aes-dna-wiz-body")
        const footer = document.getElementById("aes-dna-wiz-footer")
        if (!header || !body || !footer) return

        const isFirstRun = _state.mode === "first-run"
        const total = PAGES.length

        // Header: title + (stepper if multi-page mode)
        header.innerHTML = ""
        const titleRow = document.createElement("div")
        titleRow.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;gap:12px"
        const titleEl = document.createElement("div")
        titleEl.innerHTML = '<div style="font-weight:600;font-size:14px">Strategy DNA' + (isFirstRun ? " — first-run setup" : "") + '</div>' +
            '<div style="font-size:11px;color:#94a3b8;margin-top:3px">Define how your airline behaves so cross-kin proposers + DNA-fit pills know what to optimise for.</div>'
        titleRow.appendChild(titleEl)
        if (!isFirstRun) {
            const closeBtn = document.createElement("button")
            closeBtn.textContent = "✕"
            closeBtn.style.cssText = "background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:18px;line-height:1"
            closeBtn.addEventListener("click", () => close())
            titleRow.appendChild(closeBtn)
        }
        header.appendChild(titleRow)

        if (isFirstRun) {
            const stepper = document.createElement("div")
            stepper.style.cssText = "display:flex;gap:6px;margin-top:10px"
            for (let i = 0; i < total; i++) {
                const dot = document.createElement("div")
                const active = i <= _state.pageIndex
                dot.style.cssText = "flex:1;height:4px;border-radius:2px;background:" + (active ? "#3b82f6" : "rgba(148,163,184,0.2)")
                stepper.appendChild(dot)
            }
            header.appendChild(stepper)
        }

        // Body
        body.innerHTML = ""
        if (isFirstRun) {
            _renderPage(body, PAGES[_state.pageIndex])
        } else {
            for (const p of PAGES) {
                _renderPage(body, p, {asSection: true})
            }
        }

        // Footer
        footer.innerHTML = ""
        if (isFirstRun) {
            const stepLabel = document.createElement("div")
            stepLabel.style.cssText = "font-size:11px;color:#94a3b8"
            stepLabel.textContent = "Step " + (_state.pageIndex + 1) + " of " + total + " · " + PAGES[_state.pageIndex].title
            footer.appendChild(stepLabel)
            const actions = document.createElement("div")
            actions.style.cssText = "display:flex;gap:6px"
            if (_state.pageIndex > 0) {
                const back = document.createElement("button")
                back.textContent = "← Back"
                back.style.cssText = _btnStyle("ghost")
                back.addEventListener("click", () => { _state.pageIndex--; _render() })
                actions.appendChild(back)
            }
            const isLast = _state.pageIndex === total - 1
            const next = document.createElement("button")
            next.textContent = isLast ? "Finish" : "Next →"
            next.style.cssText = _btnStyle("primary")
            next.addEventListener("click", async () => {
                if (isLast) {
                    await _commit()
                    close()
                } else {
                    _state.pageIndex++
                    _render()
                }
            })
            actions.appendChild(next)
            footer.appendChild(actions)
        } else {
            const help = document.createElement("div")
            help.style.cssText = "font-size:11px;color:#94a3b8"
            help.textContent = "Edits apply to the global template. Per-account overrides are managed in the Per-account DNA editor."
            footer.appendChild(help)
            const actions = document.createElement("div")
            actions.style.cssText = "display:flex;gap:6px"
            const reset = document.createElement("button")
            reset.textContent = "Reset to defaults"
            reset.title = "Wipe the template back to seed defaults. Per-account overrides remain."
            reset.style.cssText = _btnStyle("ghost")
            reset.addEventListener("click", async () => {
                if (!window.confirm("Reset DNA template to defaults? Per-account overrides remain.")) return
                await window.AesCanopyDnaStore.resetTemplateToDefaults()
                await _hydrateDraft()
                _render()
            })
            actions.appendChild(reset)
            const save = document.createElement("button")
            save.textContent = "Save & close"
            save.style.cssText = _btnStyle("primary")
            save.addEventListener("click", async () => {
                await _commit()
                close()
            })
            actions.appendChild(save)
            footer.appendChild(actions)
        }
    }

    function _renderPage(host, page, opts) {
        const asSection = !!(opts && opts.asSection)
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:" + (asSection ? "12px 0" : "4px 0") + ";" +
            (asSection ? "border-bottom:1px dashed rgba(148,163,184,0.18);margin-bottom:8px" : "")
        const title = document.createElement("div")
        title.style.cssText = "font-size:13px;font-weight:600;margin-bottom:2px"
        title.textContent = page.title
        wrap.appendChild(title)
        const blurb = document.createElement("div")
        blurb.style.cssText = "font-size:11px;color:#94a3b8;margin-bottom:10px"
        blurb.textContent = page.blurb
        wrap.appendChild(blurb)
        for (const dimKey of page.dims) {
            const dim = (window.AesCanopyDnaStore.DIMENSIONS || []).find(d => d.key === dimKey)
            if (!dim) continue
            wrap.appendChild(_renderDimWidget(dim))
        }
        host.appendChild(wrap)
    }

    function _renderDimWidget(dim) {
        const row = document.createElement("div")
        row.style.cssText = "padding:8px 10px;background:rgba(148,163,184,0.06);border-radius:4px;margin-bottom:8px"
        const head = document.createElement("div")
        head.style.cssText = "font-size:12px;font-weight:600;color:#e2e8f0;margin-bottom:6px"
        head.textContent = dim.label
        row.appendChild(head)

        if (dim.kind === "enum") {
            const grp = document.createElement("div")
            grp.style.cssText = "display:flex;gap:6px;flex-wrap:wrap"
            for (const opt of dim.options) {
                const btn = document.createElement("button")
                btn.type = "button"
                btn.textContent = opt
                const selected = _state.draft[dim.key] === opt
                btn.style.cssText = [
                    "padding:5px 10px",
                    "font-size:11px",
                    "border-radius:3px",
                    "cursor:pointer",
                    "border:1px solid " + (selected ? "#3b82f6" : "rgba(148,163,184,0.35)"),
                    "background:" + (selected ? "rgba(59,130,246,0.18)" : "transparent"),
                    "color:" + (selected ? "#dbeafe" : "#cbd5e1")
                ].join(";")
                btn.addEventListener("click", () => { _state.draft[dim.key] = opt; _render() })
                grp.appendChild(btn)
            }
            row.appendChild(grp)
        } else if (dim.kind === "number") {
            const r = dim.range || {min: 0, max: 1, step: 0.05}
            const cur = Number(_state.draft[dim.key])
            row.appendChild(_buildSlider(dim.key, cur, r, (v) => {
                _state.draft[dim.key] = v
            }))
        } else if (dim.kind === "object") {
            const r = dim.range || {min: 0, max: 1, step: 0.05}
            const cur = Object.assign({}, _state.draft[dim.key] || {})
            const sumTo = dim.sumTo
            const grid = document.createElement("div")
            grid.style.cssText = "display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center"
            for (const leaf of dim.leaves) {
                const lab = document.createElement("label")
                lab.style.cssText = "font-size:11px;color:#94a3b8;text-align:right;min-width:80px"
                lab.textContent = leaf
                grid.appendChild(lab)
                const slider = _buildSliderInline(dim.key + "." + leaf, Number(cur[leaf]) || 0, r, (v) => {
                    _state.draft[dim.key] = Object.assign({}, _state.draft[dim.key] || {}, {[leaf]: v})
                    if (sumTo) _rebalanceLeaves(dim, leaf)
                    _render()
                })
                grid.appendChild(slider.range)
                grid.appendChild(slider.value)
            }
            row.appendChild(grid)
            if (sumTo) {
                const sum = dim.leaves.reduce((s, l) => s + (Number(_state.draft[dim.key] && _state.draft[dim.key][l]) || 0), 0)
                const note = document.createElement("div")
                const off = Math.abs(sum - sumTo) > 0.02
                note.style.cssText = "font-size:10px;margin-top:4px;color:" + (off ? "#fbbf24" : "#94a3b8")
                note.textContent = "Sum: " + sum.toFixed(2) + (off ? " (target " + sumTo + ")" : "")
                row.appendChild(note)
            }
        }
        return row
    }

    function _buildSlider(key, cur, range, onChange) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center"
        const inp = document.createElement("input")
        inp.type = "range"
        inp.min = range.min; inp.max = range.max; inp.step = range.step
        inp.value = isFinite(cur) ? cur : range.min
        inp.style.cssText = "width:100%"
        const val = document.createElement("div")
        val.style.cssText = "font-family:ui-monospace,monospace;font-size:11px;color:#cbd5e1;min-width:50px;text-align:right"
        val.textContent = Number(inp.value).toFixed(2)
        inp.addEventListener("input", () => {
            val.textContent = Number(inp.value).toFixed(2)
            onChange(Number(inp.value))
        })
        wrap.appendChild(inp); wrap.appendChild(val)
        return wrap
    }

    function _buildSliderInline(key, cur, range, onChange) {
        const inp = document.createElement("input")
        inp.type = "range"
        inp.min = range.min; inp.max = range.max; inp.step = range.step
        inp.value = isFinite(cur) ? cur : range.min
        inp.style.cssText = "width:100%"
        const val = document.createElement("div")
        val.style.cssText = "font-family:ui-monospace,monospace;font-size:11px;color:#cbd5e1;min-width:50px;text-align:right"
        val.textContent = Number(inp.value).toFixed(2)
        inp.addEventListener("input", () => {
            val.textContent = Number(inp.value).toFixed(2)
            onChange(Number(inp.value))
        })
        return {range: inp, value: val}
    }

    /**
     * When a sum-to-1 dimension's leaf changes, scale the OTHER leaves
     * proportionally to preserve the constraint. If the others sum to 0,
     * distribute the residual evenly.
     */
    function _rebalanceLeaves(dim, changedLeaf) {
        const sumTo = dim.sumTo
        const dims = _state.draft[dim.key] || {}
        const others = dim.leaves.filter(l => l !== changedLeaf)
        const fixedV = Number(dims[changedLeaf]) || 0
        const residual = Math.max(0, sumTo - fixedV)
        let othersSum = others.reduce((s, l) => s + (Number(dims[l]) || 0), 0)
        const out = {[changedLeaf]: fixedV}
        if (othersSum <= 0.0001) {
            const each = residual / others.length
            for (const l of others) out[l] = each
        } else {
            for (const l of others) out[l] = (Number(dims[l]) || 0) / othersSum * residual
        }
        // Round to step grain
        const step = (dim.range && dim.range.step) || 0.05
        for (const k in out) out[k] = Math.round(out[k] / step) * step
        _state.draft[dim.key] = out
    }

    function _btnStyle(kind) {
        if (kind === "primary") return "background:#3b82f6;border:1px solid #3b82f6;color:#fff;padding:6px 16px;border-radius:3px;cursor:pointer;font-size:11px"
        return "background:transparent;border:1px solid rgba(148,163,184,0.35);color:#cbd5e1;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:11px"
    }

    async function _hydrateDraft() {
        const t = await window.AesCanopyDnaStore.loadTemplate()
        _state.draft = JSON.parse(JSON.stringify(t))
    }

    async function _commit() {
        if (!window.AesCanopyDnaStore) return
        const cleaned = JSON.parse(JSON.stringify(_state.draft))
        delete cleaned.schemaVersion
        delete cleaned.authoredAt
        await window.AesCanopyDnaStore.saveTemplate(cleaned)
        await window.AesCanopyDnaStore.markTemplateAuthored()
    }

    async function open(opts) {
        opts = opts || {}
        _state.mode = opts.reason === "first-run" ? "first-run" : "edit"
        _state.pageIndex = 0
        _ensureModal()
        await _hydrateDraft()
        _render()
        _modal.style.display = "flex"
    }

    function close() {
        if (_modal) _modal.style.display = "none"
    }

    /**
     * One-shot first-run prompt — call from a tile or shell boot. Resolves
     * to true if the wizard was opened, false if the user already has a
     * template (or the dna store isn't loaded).
     */
    async function maybePromptFirstRun() {
        if (!window.AesCanopyDnaStore) return false
        if (await window.AesCanopyDnaStore.hasTemplate()) return false
        await open({reason: "first-run"})
        return true
    }

    window.AesCanopyDnaWizard = {open, close, maybePromptFirstRun}
})()
