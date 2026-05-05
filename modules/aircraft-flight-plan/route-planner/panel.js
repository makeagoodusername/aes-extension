"use strict"

/**
 * Route Planner — host panel.
 *
 * Composes:
 *   • Header summary (hub + aircraft)
 *   • Multi-airport selector (chip-style add/remove)
 *   • Total flight count input + Recommend CTA
 *   • Embedded AesAfpRoutePlannerMockSchedule grid (editable preview)
 *   • Apply schedule CTA → AesAfpFleetApplyOrchestrator.start
 *
 * Mounts into a host element (typically a modal overlay). Reads aircraft
 * spec from AesAfpSpecResolver.last and candidate destinations from
 * AesAfpRouteCandidates.last. Falls back gracefully when neither has
 * loaded yet (renders an "awaiting data" hint).
 *
 * Apply path uses the EXISTING AesAfpFleetApplyOrchestrator — no new POST
 * surface. Subject to the same gates the orchestrator enforces.
 *
 * Public API (window.AesAfpRoutePlannerPanel):
 *   open()           — open as a modal overlay
 *   close()          — close current modal
 *   mount(host, opts) — mount inline into host (no overlay)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesAfpRoutePlannerPanel) return

    let _activeOverlay = null

    function _mkEl(tag, css, text) {
        const el = document.createElement(tag)
        if (css) el.style.cssText = css
        if (text != null) el.textContent = text
        return el
    }

    function _getHub() {
        try {
            if (window.AesAfp && typeof window.AesAfp.getActiveHub === "function") {
                return window.AesAfp.getActiveHub() || null
            }
        } catch (_) {}
        return (window.AesAfp && window.AesAfp.ctx && window.AesAfp.ctx.currentLocationIata) || null
    }

    function _getSpec() {
        try {
            if (window.AesAfpSpecResolver && window.AesAfpSpecResolver.last) {
                return window.AesAfpSpecResolver.last
            }
        } catch (_) {}
        return null
    }

    function _getCandidates() {
        try {
            if (window.AesAfpRouteCandidates && window.AesAfpRouteCandidates.last) {
                return window.AesAfpRouteCandidates.last
            }
        } catch (_) {}
        return []
    }

    function _getCtx() {
        return (window.AesAfp && window.AesAfp.ctx) || {}
    }

    function _renderHeader(spec, hub) {
        const head = _mkEl("div",
            "display:flex;justify-content:space-between;align-items:baseline;"
            + "margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1f2937;")
        const title = _mkEl("div", "display:flex;flex-direction:column;gap:2px;")
        title.appendChild(_mkEl("strong",
            "color:#cbd5e1;font-size:14px;letter-spacing:0.05em;",
            "Route Planner"))
        const sub = _mkEl("div", "color:#9ca3af;font-size:11px;",
            "Hub: " + (hub || "?")
            + " · Aircraft: " + (spec && spec.typeName ? spec.typeName : "?")
            + (spec && spec.cruiseSpeedKmh ? " · " + spec.cruiseSpeedKmh + " km/h" : "")
            + (spec && spec.range ? " · " + spec.range + " km range" : ""))
        title.appendChild(sub)
        head.appendChild(title)
        return head
    }

    function _renderSelector(state, candidates, onChange) {
        const wrap = _mkEl("div",
            "background:rgba(255,255,255,0.02);border:1px solid #1f2937;"
            + "border-radius:4px;padding:10px;margin-bottom:10px;")
        const lbl = _mkEl("div",
            "color:#9ca3af;font-size:10px;text-transform:uppercase;"
            + "letter-spacing:0.5px;margin-bottom:6px;",
            "Destinations (" + state.selected.length + " selected)")
        wrap.appendChild(lbl)

        const chipsRow = _mkEl("div",
            "display:flex;flex-wrap:wrap;gap:4px;min-height:28px;align-items:center;")

        function _renderChips() {
            chipsRow.textContent = ""
            for (const iata of state.selected) {
                const chip = _mkEl("div",
                    "display:inline-flex;align-items:center;gap:4px;"
                    + "background:#1e3a5f;color:#bfdbfe;padding:3px 6px;"
                    + "border-radius:3px;font-size:11px;font-weight:600;")
                const cand = candidates.find(c => String(c.destIata).toUpperCase() === iata)
                chip.appendChild(_mkEl("span", "", iata))
                if (cand && cand.distanceKm) {
                    chip.appendChild(_mkEl("span", "color:#94a3b8;font-weight:400;font-size:10px;",
                        Math.round(cand.distanceKm) + "km"))
                }
                const xBtn = _mkEl("span",
                    "cursor:pointer;color:#94a3b8;margin-left:2px;font-weight:600;",
                    "×")
                xBtn.addEventListener("click", () => {
                    state.selected = state.selected.filter(x => x !== iata)
                    _renderChips()
                    onChange()
                })
                chip.appendChild(xBtn)
                chipsRow.appendChild(chip)
            }
            if (!state.selected.length) {
                chipsRow.appendChild(_mkEl("span", "color:#6b7280;font-style:italic;",
                    "No destinations selected — pick from the dropdown below"))
            }
            lbl.textContent = "Destinations (" + state.selected.length + " selected)"
        }
        wrap.appendChild(chipsRow)

        // Add-destination dropdown
        const addRow = _mkEl("div",
            "display:flex;gap:4px;margin-top:8px;")
        const sel = document.createElement("select")
        sel.style.cssText = "flex:1;background:#0a0f1a;color:#e5e7eb;"
            + "border:1px solid #374151;padding:4px 6px;font-size:11px;"
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "— Add destination —"
        sel.appendChild(placeholder)
        // Sort candidates by distance ascending; filter already-selected
        const available = candidates
            .filter(c => c && c.destIata && c.distanceKm > 0)
            .filter(c => !state.selected.includes(String(c.destIata).toUpperCase()))
            .sort((a, b) => a.distanceKm - b.distanceKm)
        for (const c of available) {
            const opt = document.createElement("option")
            opt.value = String(c.destIata).toUpperCase()
            opt.textContent = opt.value
                + (c.destName ? " — " + c.destName : "")
                + " · " + Math.round(c.distanceKm) + "km"
            sel.appendChild(opt)
        }
        const addBtn = document.createElement("button")
        addBtn.type = "button"
        addBtn.textContent = "+ Add"
        addBtn.style.cssText = "background:#1e3a5f;color:#bfdbfe;border:1px solid #1d4ed8;"
            + "padding:4px 10px;border-radius:3px;cursor:pointer;font-size:11px;"
        addBtn.addEventListener("click", () => {
            const v = sel.value
            if (v && !state.selected.includes(v)) {
                state.selected.push(v)
                _renderChips()
                onChange()
                // Re-render selector so it picks up new available list
            }
        })
        addRow.appendChild(sel)
        addRow.appendChild(addBtn)
        // "Add all visible" helper
        const addAllBtn = document.createElement("button")
        addAllBtn.type = "button"
        addAllBtn.textContent = "+ Add top 5"
        addAllBtn.title = "Add the 5 closest available destinations"
        addAllBtn.style.cssText = "background:#374151;color:#cbd5e1;border:1px solid #475569;"
            + "padding:4px 8px;border-radius:3px;cursor:pointer;font-size:11px;"
        addAllBtn.addEventListener("click", () => {
            for (const c of available.slice(0, 5)) {
                const v = String(c.destIata).toUpperCase()
                if (!state.selected.includes(v)) state.selected.push(v)
            }
            _renderChips()
            onChange()
        })
        addRow.appendChild(addAllBtn)
        wrap.appendChild(addRow)

        if (!candidates.length) {
            wrap.appendChild(_mkEl("div",
                "color:#fbbf24;font-size:11px;margin-top:8px;",
                "Awaiting destination data (load AesAfpRouteCandidates first)."))
        }

        _renderChips()
        return wrap
    }

    function _renderControls(state, onRecommend) {
        const wrap = _mkEl("div",
            "display:flex;gap:10px;align-items:center;margin-bottom:10px;"
            + "padding:8px;background:rgba(255,255,255,0.02);"
            + "border:1px solid #1f2937;border-radius:4px;")
        const lbl = _mkEl("label", "color:#cbd5e1;font-size:11px;font-weight:600;",
            "Total flights/wk:")
        wrap.appendChild(lbl)
        const inp = document.createElement("input")
        inp.type = "number"
        inp.min = "1"
        inp.max = "200"
        inp.value = String(state.targetFlightCount)
        inp.style.cssText = "background:#0a0f1a;color:#fff;border:1px solid #374151;"
            + "padding:4px 6px;width:70px;font-size:11px;text-align:right;"
        inp.addEventListener("change", () => {
            const v = parseInt(inp.value, 10)
            if (Number.isFinite(v) && v >= 1) state.targetFlightCount = v
        })
        wrap.appendChild(inp)
        const recBtn = document.createElement("button")
        recBtn.type = "button"
        recBtn.textContent = "Recommend"
        recBtn.style.cssText = "background:#7c3aed;color:#fff;border:1px solid #6d28d9;"
            + "padding:5px 14px;border-radius:3px;cursor:pointer;font-size:11px;"
            + "font-weight:600;margin-left:auto;"
        recBtn.addEventListener("click", onRecommend)
        wrap.appendChild(recBtn)
        return {el: wrap, button: recBtn, input: inp}
    }

    function mount(host, opts) {
        if (!host) return null
        const o = opts || {}
        const onClose = typeof o.onClose === "function" ? o.onClose : null

        const state = {
            selected:           [],
            targetFlightCount:  7,
            currentPlan:        null,
            currentLegs:        []
        }

        const spec = _getSpec()
        const hub  = _getHub()
        const candidates = _getCandidates()
        // Normalise candidate shape for the selector: ensure destIata + distanceKm
        const normCands = candidates.map(c => ({
            destIata:  c.destIata || c.iata || c.code,
            destName:  c.destName || c.name,
            distanceKm: Number(c.distanceKm)
        })).filter(c => c.destIata && Number.isFinite(c.distanceKm))

        host.textContent = ""
        const root = _mkEl("div",
            "background:#0f1623;color:#e5e7eb;padding:14px 16px;"
            + "border:1px solid #475569;border-radius:6px;font:12px sans-serif;"
            + "max-height:90vh;overflow-y:auto;")

        root.appendChild(_renderHeader(spec, hub))

        let selectorEl = _renderSelector(state, normCands, () => { /* selection change */ })
        root.appendChild(selectorEl)

        const ctrls = _renderControls(state, () => _onRecommend())
        root.appendChild(ctrls.el)

        // Status / warnings area
        const statusEl = _mkEl("div",
            "margin:8px 0;padding:6px 8px;font-size:11px;"
            + "background:rgba(31,41,55,0.4);border-radius:3px;color:#9ca3af;",
            "Pick destinations + a target, then click Recommend.")
        root.appendChild(statusEl)

        // Mock schedule host
        const scheduleHost = _mkEl("div", "margin-top:10px;")
        root.appendChild(scheduleHost)

        // Apply CTA row
        const applyRow = _mkEl("div",
            "display:flex;justify-content:space-between;align-items:center;"
            + "margin-top:12px;padding-top:10px;border-top:1px solid #1f2937;")
        const summarySpan = _mkEl("span",
            "color:#9ca3af;font-size:11px;",
            "0 legs ready")
        applyRow.appendChild(summarySpan)

        const btnRow = _mkEl("div", "display:flex;gap:6px;")
        const cancelBtn = document.createElement("button")
        cancelBtn.type = "button"
        cancelBtn.textContent = "Close"
        cancelBtn.style.cssText = "background:#1f2937;color:#cbd5e1;border:1px solid #374151;"
            + "padding:5px 14px;border-radius:3px;cursor:pointer;font-size:11px;"
        if (onClose) cancelBtn.addEventListener("click", onClose)
        btnRow.appendChild(cancelBtn)

        const dryBtn = document.createElement("button")
        dryBtn.type = "button"
        dryBtn.textContent = "Dry-run"
        dryBtn.title = "Build the leg payload + log to console without POSTing to AS"
        dryBtn.style.cssText = "background:#374151;color:#cbd5e1;border:1px solid #475569;"
            + "padding:5px 14px;border-radius:3px;cursor:pointer;font-size:11px;"
        dryBtn.disabled = true
        btnRow.appendChild(dryBtn)

        const applyBtn = document.createElement("button")
        applyBtn.type = "button"
        applyBtn.textContent = "Apply schedule"
        applyBtn.style.cssText = "background:#7c3aed;color:#fff;border:1px solid #6d28d9;"
            + "padding:5px 14px;border-radius:3px;cursor:pointer;font-size:11px;"
            + "font-weight:600;"
        applyBtn.disabled = true
        btnRow.appendChild(applyBtn)
        applyRow.appendChild(btnRow)
        root.appendChild(applyRow)

        host.appendChild(root)

        // Mock schedule instance
        const schedule = window.AesAfpRoutePlannerMockSchedule
            ? window.AesAfpRoutePlannerMockSchedule.render(scheduleHost, [], {
                onChange: (legs) => { state.currentLegs = legs; _refreshSummary() }
            })
            : null
        if (!schedule) {
            scheduleHost.appendChild(_mkEl("div",
                "color:#fbbf24;font-size:11px;",
                "Mock schedule module not loaded."))
        }

        function _refreshSummary() {
            const legs = state.currentLegs || []
            const totalFreq = legs.reduce((s, l) =>
                s + (l._meta && l._meta.freqPerWeek ? l._meta.freqPerWeek : 0), 0)
            summarySpan.textContent = totalFreq + " flights/wk · " + legs.length + " flight number(s)"
            const ready = legs.length > 0
            applyBtn.disabled = !ready
            dryBtn.disabled = !ready
        }

        function _onRecommend() {
            const R = window.AesAfpRoutePlannerRecommender
            if (!R || typeof R.recommend !== "function") {
                statusEl.textContent = "Recommender module not loaded."
                statusEl.style.color = "#f87171"
                return
            }
            if (!state.selected.length) {
                statusEl.textContent = "Pick at least one destination."
                statusEl.style.color = "#fbbf24"
                return
            }
            const dests = state.selected.map(iata => {
                const c = normCands.find(x => x.destIata === iata)
                return c ? {iata: iata, distanceKm: c.distanceKm} : null
            }).filter(Boolean)
            const plan = R.recommend({
                hub:               hub,
                spec:              spec || {},
                destinations:      dests,
                targetFlightCount: state.targetFlightCount
            })
            state.currentPlan = plan
            state.currentLegs = plan.legs
            if (schedule && schedule.update) schedule.update(plan.legs)
            const w = plan.warnings.length
                ? " · " + plan.warnings.length + " warning(s): " + plan.warnings.join("; ")
                : ""
            statusEl.textContent = plan.summary.totalLegs + " flights/wk allocated · "
                + plan.summary.utilizationPct + "% utilization" + w
            statusEl.style.color = plan.warnings.length ? "#fbbf24" : "#10b981"
            _refreshSummary()
        }

        async function _onApply(forceDryRun) {
            const ctx = _getCtx()
            const legs = (state.currentLegs || []).map(l => Object.assign({}, l,
                {dayMask: l.dayMask.slice()}))
            if (!legs.length) {
                statusEl.textContent = "No legs to apply."
                statusEl.style.color = "#f87171"
                return
            }
            if (!ctx.aircraftId) {
                statusEl.textContent = "Missing aircraftId from AesAfp.ctx — open from an aircraft page."
                statusEl.style.color = "#f87171"
                return
            }
            if (forceDryRun) {
                statusEl.textContent = "Dry-run: " + legs.length
                    + " leg(s) prepared. See console for full payload."
                statusEl.style.color = "#10b981"
                console.info("[AES route-planner] dry-run payload",
                    {ctx, legs: legs.map(_stripMeta)})
                return
            }
            const orchestrator = window.AesAfpFleetApplyOrchestrator
            if (!orchestrator || typeof orchestrator.start !== "function") {
                statusEl.textContent = "Orchestrator not loaded — cannot apply."
                statusEl.style.color = "#f87171"
                return
            }
            applyBtn.disabled = true
            applyBtn.textContent = "Applying…"
            statusEl.textContent = "Submitting batch…"
            statusEl.style.color = "#9ca3af"
            try {
                const result = await orchestrator.start({
                    runs: [{
                        aircraftId: String(ctx.aircraftId),
                        legs:       legs.map(_stripMeta)
                    }],
                    ctx: {server: ctx.server || ""},
                    source: "route-planner"
                })
                if (result && result.aborted) {
                    statusEl.textContent = "Apply aborted: " + (result.error || "unknown")
                    statusEl.style.color = "#fbbf24"
                } else if (result && result.ok !== false) {
                    // Orchestrator's done envelope carries totalSucceeded/totalFailed
                    // aggregates across all aircraft runs. Fall back to perAircraft[0]
                    // for the legacy mock-shape used in some tests.
                    const okN = (result.totalSucceeded != null)
                        ? result.totalSucceeded
                        : (result.perAircraft && result.perAircraft[0]
                            && result.perAircraft[0].succeeded) || 0
                    const failN = (result.totalFailed != null)
                        ? result.totalFailed
                        : (result.perAircraft && result.perAircraft[0]
                            && result.perAircraft[0].failed) || 0
                    statusEl.textContent = "Applied · " + okN + " ok / " + failN + " failed"
                    statusEl.style.color = "#10b981"
                } else {
                    statusEl.textContent = "Apply failed: " + ((result && result.error) || "unknown")
                    statusEl.style.color = "#f87171"
                }
            } catch (e) {
                statusEl.textContent = "Apply threw: " + ((e && e.message) || String(e))
                statusEl.style.color = "#f87171"
            } finally {
                applyBtn.disabled = false
                applyBtn.textContent = "Apply schedule"
            }
        }

        function _stripMeta(leg) {
            const out = Object.assign({}, leg)
            delete out._meta
            return out
        }

        applyBtn.addEventListener("click", () => _onApply(false))
        dryBtn.addEventListener("click",  () => _onApply(true))

        return {
            getState: () => Object.assign({}, state, {
                selected: state.selected.slice(),
                currentLegs: state.currentLegs.slice()
            }),
            setSelected: (iatas) => {
                state.selected = (iatas || []).filter(Boolean).map(s => String(s).toUpperCase())
                // Re-render selector so chips update
                const fresh = _renderSelector(state, normCands, () => {})
                root.replaceChild(fresh, selectorEl)
                selectorEl = fresh
            },
            recommend: _onRecommend,
            apply:     (forceDryRun) => _onApply(!!forceDryRun),
            destroy:   () => { host.textContent = "" }
        }
    }

    function open() {
        if (_activeOverlay) return
        const overlay = _mkEl("div",
            "position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10003;"
            + "display:flex;align-items:center;justify-content:center;padding:30px;")
        const dialogHost = _mkEl("div", "width:920px;max-width:96vw;")
        overlay.appendChild(dialogHost)
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            document.removeEventListener("keydown", onKey)
            _activeOverlay = null
        }
        const onKey = (e) => { if (e.key === "Escape") close() }
        const onOverlayClick = (e) => { if (e.target === overlay) close() }
        document.body.appendChild(overlay)
        document.addEventListener("keydown", onKey)
        overlay.addEventListener("click", onOverlayClick)
        const inst = mount(dialogHost, {onClose: close})
        _activeOverlay = {overlay, instance: inst, close}
        return inst
    }

    function close() {
        if (_activeOverlay && typeof _activeOverlay.close === "function") {
            _activeOverlay.close()
        }
    }

    window.AesAfpRoutePlannerPanel = {
        mount: mount,
        open:  open,
        close: close
    }
})()
