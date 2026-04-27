"use strict"

/**
 * Track 5 — Auto-scheduler preview panel.
 *
 * Mounts on `/app/fleets/aircraft/<id>/0` via the AFP family content-script
 * block. Renders into `AesAfp.slot("auto-preview")` (registered in host.js's
 * WIDE_SLOT_NAMES). Visually replaces the role of the AS "Assign a new
 * flight" form for users who opt into the auto-scheduler — the form
 * itself is left alone (we never delete AS DOM).
 *
 * Slice 5a only — render. Slices 5b/5c/5d/5e add the Apply-all CTA, the
 * batch fillAndSubmit pipeline, the live progress UI, and the audit log.
 *
 * Public API (window.AesAfpAutoSchedulerPreview):
 *   .render()         — re-render from current state (idempotent)
 *   .runAutoBuild()   — call the auto-scheduler, persist into the draft store
 *   .lastBuild        — diagnostic accessor (Build | null)
 *
 * Bus contract (in):
 *   ctx:ready              → first paint
 *   auto-schedule:built    → swap in the new build
 *   spec:resolved          → recompute summary stats
 *   candidates:updated     → re-enable the Build button
 *
 * Storage events listened to:
 *   aircraftFlightPlan:draft:<server>:<aircraftId>  → repaint
 *
 * Reuses (read-only):
 *   RouteAssistantWaveOverlay.renderGantt — Gantt visual (slot for slot)
 *   AesAfpActiveDraftStore                — draft + per-leg overlay store
 *   AesAfpAutoScheduler.run               — Track 3 entry point
 *   AesAfpMaintenanceBudget.compute       — Track 2 forecast
 *   AesAfpSettings.load                   — autoScheduler.enabled / tier gate
 */
;(function () {
    if (window.AesAfpAutoSchedulerPreview) return

    const SLOT_NAME = "auto-preview"
    const STORAGE_REPAINT_DEBOUNCE_MS = 200

    const _state = {
        ctxReady:      false,
        spec:          null,
        candidatesLen: 0,
        lastBuild:     null,
        draft:         null,
        budget:        null,
        running:       false,
        runError:      null,
        editingSeq:    null,
        storageTimer:  null,
        storageListener: null,
        settings:      null
    }

    let _rootEl       = null   // container injected into the slot
    let _summaryEl    = null
    let _ctaEl        = null
    let _statusEl     = null
    let _previewEl    = null
    let _legsEl       = null
    let _footerEl     = null

    // Public surface (re-assigned at the bottom). Slices 5b-5e patch
    // additional handles onto this object as their CTAs / hooks ship.
    const AesAfpAutoSchedulerPreview = {
        render:       () => _scheduleRender(),
        runAutoBuild: () => _runAutoBuild(),
        get lastBuild() { return _state.lastBuild }
    }

    // ── Slot helpers ───────────────────────────────────────────────────

    function _slot() {
        try {
            return (window.AesAfp && typeof window.AesAfp.slot === "function")
                ? window.AesAfp.slot(SLOT_NAME)
                : null
        } catch (_) { return null }
    }

    function _ctx() {
        return (window.AesAfp && AesAfp.ctx) || {}
    }

    /**
     * Build (or rebuild) the panel's static scaffold inside the slot.
     * Idempotent — replaces innerHTML; subsequent partial repaints
     * (`_renderSummary`, `_renderPreview`, `_renderLegs`) target the
     * cached element handles only.
     */
    function _renderRoot() {
        const slot = _slot()
        if (!slot) return
        slot.innerHTML = ""

        const root = document.createElement("div")
        root.className = "aes-afp-auto-preview-root"
        root.style.cssText = "margin-top:10px;padding-top:8px;"
            + "border-top:1px solid #1f2937;"

        const heading = document.createElement("div")
        heading.style.cssText = "display:flex;align-items:center;gap:8px;"
            + "font-size:11px;color:#cbd5e1;font-weight:600;"
            + "text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;"
        const hLabel = document.createElement("span")
        hLabel.textContent = "Auto-build (preview)"
        heading.appendChild(hLabel)
        const hHint = document.createElement("span")
        hHint.style.cssText = "color:#6b7280;font-weight:400;text-transform:none;"
            + "letter-spacing:0;font-size:10px;"
        hHint.textContent = "scoring × maintenance budget → weekly grid"
        heading.appendChild(hHint)
        root.appendChild(heading)

        _summaryEl = document.createElement("div")
        _summaryEl.className = "aes-afp-auto-preview-summary"
        _summaryEl.style.cssText = "display:flex;flex-wrap:wrap;gap:14px;"
            + "padding:6px 8px;background:#0f1623;border:1px solid #1f2937;"
            + "border-radius:3px;font-size:11px;color:#cbd5e1;margin-bottom:6px;"
        root.appendChild(_summaryEl)

        _ctaEl = document.createElement("div")
        _ctaEl.className = "aes-afp-auto-preview-cta"
        _ctaEl.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;"
            + "gap:6px;font-size:11px;color:#cbd5e1;margin-bottom:6px;"
        root.appendChild(_ctaEl)

        _statusEl = document.createElement("div")
        _statusEl.className = "aes-afp-auto-preview-status"
        _statusEl.style.cssText = "font-size:11px;color:#9ca3af;margin-bottom:6px;"
            + "display:none;"
        root.appendChild(_statusEl)

        _previewEl = document.createElement("div")
        _previewEl.className = "aes-afp-auto-preview-gantt"
        _previewEl.style.cssText = "margin-top:6px;"
        root.appendChild(_previewEl)

        _legsEl = document.createElement("div")
        _legsEl.className = "aes-afp-auto-preview-legs"
        _legsEl.style.cssText = "margin-top:8px;padding-top:8px;"
            + "border-top:1px solid #1f2937;"
        root.appendChild(_legsEl)

        _footerEl = document.createElement("div")
        _footerEl.className = "aes-afp-auto-preview-footer"
        _footerEl.style.cssText = "margin-top:8px;padding-top:6px;"
            + "border-top:1px solid #0f172a;font-size:11px;color:#6b7280;"
        root.appendChild(_footerEl)

        slot.appendChild(root)
        _rootEl = root

        _renderSummary()
        _renderCta()
        _renderStatus()
        _renderPreview()
        _renderLegs()
        _renderFooter()
    }

    // ── Partial re-renders ─────────────────────────────────────────────

    function _renderSummary() {
        if (!_summaryEl) return
        _summaryEl.innerHTML = ""

        const flights = (_state.lastBuild && _state.lastBuild.flights) || []
        const meta    = (_state.lastBuild && _state.lastBuild.metadata) || null

        // Leg count.
        _summaryEl.appendChild(_summaryCell(
            "Legs",
            flights.length ? String(flights.length) : "—",
            flights.length ? "round-trips × 2 = leg count" : "Run Auto-build to populate."
        ))

        // Weekly block hours.
        const weeklyHours = meta && isFinite(meta.budgetUsedHours)
            ? meta.budgetUsedHours.toFixed(1) + "h"
            : "—"
        const weeklyTitle = meta && isFinite(meta.budgetMaxHours)
            ? "Used " + meta.budgetUsedHours.toFixed(1)
              + "h of " + meta.budgetMaxHours.toFixed(0) + "h ceiling"
            : null
        _summaryEl.appendChild(_summaryCell("Weekly", weeklyHours, weeklyTitle))

        // Projected revenue (best-effort — sum of placement gross from objective.parts).
        // For Phase-1 we don't have direct revenue; we show "objective" instead.
        const totalScore = meta && isFinite(meta.totalScore) ? meta.totalScore : null
        _summaryEl.appendChild(_summaryCell(
            "Score",
            totalScore != null ? totalScore.toFixed(0) : "—",
            "Σ objective scores from Track 3 (higher = better)."
        ))

        // Maintenance forecast (Track 2).
        if (_state.budget && isFinite(_state.budget.forecastRatio7d)) {
            const ratio = _state.budget.forecastRatio7d.toFixed(0) + "%"
            const color = (_state.budget.forecastRatio7d < 100)            ? "#f87171"
                        : (_state.budget.forecastRatio7d < 105)            ? "#facc15"
                        :                                                    "#34d399"
            const cell = _summaryCell("Maint 7d", ratio,
                "Projected maintenance ratio in 7 days at this load.")
            const valEl = cell.querySelector("[data-aes-cell-val]")
            if (valEl) valEl.style.color = color
            _summaryEl.appendChild(cell)
        } else if (_state.budget && isFinite(_state.budget.currentRatio)) {
            _summaryEl.appendChild(_summaryCell(
                "Maint now",
                _state.budget.currentRatio.toFixed(0) + "%",
                "Current ratio — wear regression not fitted yet."
            ))
        } else {
            _summaryEl.appendChild(_summaryCell(
                "Maint",
                "—",
                "Waiting on Track 2 budget."
            ))
        }

        // Algorithm + last-built timestamp.
        if (meta && meta.generatedAt) {
            const when = _ago(meta.generatedAt)
            _summaryEl.appendChild(_summaryCell(
                "Built",
                when,
                "Algorithm: " + (meta.algo || "?")
            ))
        }
    }

    function _summaryCell(label, value, title) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:1px;min-width:60px;"
        if (title) wrap.title = title
        const lbl = document.createElement("span")
        lbl.style.cssText = "color:#6b7280;font-size:10px;text-transform:uppercase;"
            + "letter-spacing:0.4px;"
        lbl.textContent = label
        const val = document.createElement("span")
        val.setAttribute("data-aes-cell-val", "1")
        val.style.cssText = "color:#f3f4f6;font-size:13px;font-weight:600;"
            + "font-variant-numeric:tabular-nums;"
        val.textContent = value
        wrap.appendChild(lbl)
        wrap.appendChild(val)
        return wrap
    }

    function _renderCta() {
        if (!_ctaEl) return
        _ctaEl.innerHTML = ""
        const ctxR  = _ctx()
        const ready = _state.ctxReady && !!ctxR.aircraftId
        const hasCandidates = _state.candidatesLen > 0
        const hasSpec = !!_state.spec

        const enabled = !_state.running && ready && hasCandidates && hasSpec
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = _state.lastBuild ? "Re-run auto-build" : "Auto-build week"
        btn.disabled = !enabled
        btn.style.cssText = "background:" + (enabled ? "#1d4ed8" : "#374151") + ";"
            + "color:" + (enabled ? "#f8fafc" : "#9ca3af") + ";"
            + "border:1px solid " + (enabled ? "#1e3a8a" : "#374151") + ";"
            + "border-radius:3px;padding:4px 12px;font-size:11px;font-weight:600;"
            + "cursor:" + (enabled ? "pointer" : "not-allowed") + ";"
        btn.title = enabled
            ? "Run the Track 3 allocator against current candidates + budget."
            : _ctaBlockedReason()
        btn.addEventListener("click", () => { if (enabled) _runAutoBuild() })
        _ctaEl.appendChild(btn)

        // Slice 5b will append the "Apply all" CTA here once the tier
        // gate flips to "apply-on-confirm". Render a placeholder hint
        // describing the dormant state so the user knows where to look.
        const tier = _state.settings
            && _state.settings.autoScheduler
            && _state.settings.autoScheduler.tier
        const enabledFlag = _state.settings
            && _state.settings.autoScheduler
            && _state.settings.autoScheduler.enabled
        if (_state.lastBuild && (!enabledFlag || tier !== "apply-on-confirm")) {
            const hint = document.createElement("span")
            hint.style.cssText = "color:#6b7280;font-size:11px;"
            hint.textContent = "Preview only — set"
                + " settings.aircraftFlightPlan.autoScheduler.tier ="
                + " \"apply-on-confirm\" + .enabled = true to unlock Apply-all."
            _ctaEl.appendChild(hint)
        }
    }

    function _ctaBlockedReason() {
        if (_state.running)             return "Auto-build in progress…"
        if (!_state.ctxReady)           return "Waiting for AFP context."
        if (!_ctx().aircraftId)         return "No aircraft id resolved."
        if (!_state.spec)               return "Waiting for aircraft spec (Track B)."
        if (!_state.candidatesLen)      return "Waiting for route candidates (Slice C)."
        return ""
    }

    function _renderStatus() {
        if (!_statusEl) return
        if (_state.runError) {
            _statusEl.style.display = ""
            _statusEl.style.color = "#fca5a5"
            _statusEl.textContent = "Auto-build failed: " + _state.runError
            return
        }
        if (_state.running) {
            _statusEl.style.display = ""
            _statusEl.style.color = "#9ca3af"
            _statusEl.textContent = "Running auto-build…"
            return
        }
        const validation = (_state.lastBuild && _state.lastBuild.validation) || []
        if (validation.length) {
            _statusEl.style.display = ""
            _statusEl.style.color = "#fbbf24"
            _statusEl.textContent = "Validation: " + validation.join(" · ")
            return
        }
        _statusEl.style.display = "none"
        _statusEl.textContent = ""
    }

    function _renderPreview() {
        if (!_previewEl) return
        _previewEl.innerHTML = ""
        const build = _state.lastBuild
        if (!build || !(build.flights || []).length) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:8px;color:#6b7280;font-size:11px;"
                + "font-style:italic;background:#0f1623;border:1px dashed #1f2937;"
                + "border-radius:3px;"
            empty.textContent = build
                ? "Auto-build returned no flights — see status above."
                : "No build yet. Click \"Auto-build week\" to generate a proposal."
            _previewEl.appendChild(empty)
            return
        }
        if (typeof RouteAssistantWaveOverlay === "undefined") {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:6px;color:#9ca3af;font-size:11px;"
            empty.textContent = "Wave overlay not loaded — manifest order regression?"
            _previewEl.appendChild(empty)
            return
        }
        const hubIata = String(_ctx().currentLocationIata || "").toUpperCase()
        try {
            RouteAssistantWaveOverlay.renderGantt(_previewEl, build, {
                hubIata,
                onFlightClick: (flight) => _onLegClick(flight)
            })
        } catch (e) {
            console.warn("[AES auto-5a] renderGantt threw", e)
            _previewEl.innerHTML = ""
            const err = document.createElement("div")
            err.style.cssText = "padding:6px;color:#fca5a5;font-size:11px;"
            err.textContent = "Gantt render failed: " + ((e && e.message) || e)
            _previewEl.appendChild(err)
        }
    }

    /**
     * Per-leg list with inline edit row. Each leg shows the canonical
     * outbound/inbound shape from the build PLUS any user overlay from
     * AesAfpActiveDraftStore.perLegEdits. Click "Edit" to mutate the
     * overlay; click "Reset" to clear it.
     */
    function _renderLegs() {
        if (!_legsEl) return
        _legsEl.innerHTML = ""
        const build = _state.lastBuild
        const flights = (build && build.flights) || []
        if (!flights.length) return

        const hdr = document.createElement("div")
        hdr.style.cssText = "font-size:11px;font-weight:600;color:#9ca3af;"
            + "margin-bottom:4px;"
        hdr.textContent = "Per-leg overlay (" + flights.length + "):"
        _legsEl.appendChild(hdr)

        for (const f of flights) _legsEl.appendChild(_renderLegRow(f, build))
    }

    function _renderLegRow(flight, build) {
        const overlay = (_state.draft && _state.draft.perLegEdits
            && _state.draft.perLegEdits[flight.seq]) || null
        const eff = overlay ? Object.assign({}, flight, overlay) : flight
        const editing = _state.editingSeq === flight.seq

        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-direction:column;gap:2px;"
            + "padding:4px 0;border-bottom:1px solid #0f172a;"
            + (overlay ? "background:rgba(251,191,36,0.05);" : "")

        const top = document.createElement("div")
        top.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;"
            + "color:#cbd5e1;"

        const inbound = (eff.direction === "inbound")
        const arrow   = inbound ? "←" : "→"
        const dirCol  = inbound ? "#10b981" : "#3b82f6"

        const dir = document.createElement("span")
        dir.style.cssText = "color:" + dirCol + ";font-weight:600;width:30px;flex:0 0 auto;"
        dir.textContent = (eff.direction || "").slice(0, 3)
        top.appendChild(dir)

        const od = document.createElement("span")
        od.style.cssText = "font-weight:600;color:#f8fafc;flex:1 1 auto;min-width:0;"
        od.textContent = (eff.origin || "?") + " " + arrow + " " + (eff.destination || "?")
        top.appendChild(od)

        const time = document.createElement("span")
        time.style.cssText = "color:#9ca3af;width:46px;flex:0 0 auto;text-align:right;"
            + "font-variant-numeric:tabular-nums;"
        time.textContent = eff.depTimeLocal || "—"
        top.appendChild(time)

        const dist = document.createElement("span")
        dist.style.cssText = "color:#6b7280;width:50px;flex:0 0 auto;text-align:right;"
            + "font-size:10px;"
        dist.textContent = eff.distanceNm ? Math.round(eff.distanceNm) + "nm" : "—"
        top.appendChild(dist)

        const pricePctVal = (overlay && isFinite(Number(overlay.pricePct))) ? overlay.pricePct
            : (_state.settings && isFinite(Number(_state.settings.defaultPricePct))
                ? _state.settings.defaultPricePct : null)
        if (pricePctVal != null) {
            const price = document.createElement("span")
            price.style.cssText = "color:#9ca3af;width:42px;flex:0 0 auto;text-align:right;"
                + "font-size:10px;font-variant-numeric:tabular-nums;"
            price.textContent = pricePctVal + "%"
            top.appendChild(price)
        }

        if (overlay) {
            const tag = document.createElement("span")
            tag.style.cssText = "color:#fbbf24;font-size:10px;"
            tag.title = "Per-leg edit overlay applied. Reset to use the build defaults."
            tag.textContent = "edited"
            top.appendChild(tag)
        }

        const editBtn = document.createElement("button")
        editBtn.type = "button"
        editBtn.textContent = editing ? "Close" : "Edit"
        editBtn.style.cssText = "background:transparent;color:#cbd5e1;"
            + "border:1px solid #374151;border-radius:3px;padding:1px 6px;"
            + "font-size:10px;cursor:pointer;flex:0 0 auto;"
        editBtn.addEventListener("click", () => {
            _state.editingSeq = editing ? null : flight.seq
            _renderLegs()
        })
        top.appendChild(editBtn)

        if (overlay) {
            const reset = document.createElement("button")
            reset.type = "button"
            reset.textContent = "Reset"
            reset.title = "Clear per-leg overlay for this seq."
            reset.style.cssText = "background:transparent;color:#fbbf24;"
                + "border:1px solid #b45309;border-radius:3px;padding:1px 6px;"
                + "font-size:10px;cursor:pointer;flex:0 0 auto;"
            reset.addEventListener("click", () => _clearLegEdit(flight.seq))
            top.appendChild(reset)
        }

        row.appendChild(top)

        if (editing) row.appendChild(_renderLegEditor(flight, overlay))
        return row
    }

    function _renderLegEditor(flight, overlay) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 10px;"
            + "padding:6px 4px 4px 36px;font-size:10px;color:#9ca3af;"

        const seq = flight.seq
        const eff = overlay ? Object.assign({}, flight, overlay) : flight

        wrap.appendChild(_editorField("Origin (IATA)", eff.origin || "", v => {
            v = String(v || "").trim().toUpperCase().slice(0, 3)
            if (v && !/^[A-Z]{3}$/.test(v)) return false
            _setLegEdit(seq, {origin: v || null})
            return true
        }))
        wrap.appendChild(_editorField("Dest (IATA)", eff.destination || "", v => {
            v = String(v || "").trim().toUpperCase().slice(0, 3)
            if (v && !/^[A-Z]{3}$/.test(v)) return false
            _setLegEdit(seq, {destination: v || null})
            return true
        }))
        wrap.appendChild(_editorField("Dep (HH:MM)", eff.depTimeLocal || "", v => {
            v = String(v || "").trim()
            if (v && !/^\d{1,2}:\d{2}$/.test(v)) return false
            _setLegEdit(seq, {depTimeLocal: v || null})
            return true
        }))
        wrap.appendChild(_editorField("Price %", eff.pricePct != null ? String(eff.pricePct) : "", v => {
            const n = Number(v)
            if (v === "" || v == null) { _setLegEdit(seq, {pricePct: null}); return true }
            if (!isFinite(n) || n < 1 || n > 500) return false
            _setLegEdit(seq, {pricePct: n})
            return true
        }))
        wrap.appendChild(_editorField("Service", eff.service != null ? String(eff.service) : "", v => {
            v = String(v || "").slice(0, 64)
            _setLegEdit(seq, {service: v || null})
            return true
        }))

        return wrap
    }

    function _editorField(label, value, onChange) {
        const wrap = document.createElement("label")
        wrap.style.cssText = "display:inline-flex;flex-direction:column;gap:2px;"
            + "font-size:10px;color:#9ca3af;"
        const lbl = document.createElement("span")
        lbl.textContent = label
        const inp = document.createElement("input")
        inp.type = "text"
        inp.value = value == null ? "" : String(value)
        inp.style.cssText = "background:#0f1623;color:#f3f4f6;"
            + "border:1px solid #374151;border-radius:3px;padding:2px 4px;"
            + "font-size:10px;width:80px;font-variant-numeric:tabular-nums;"
        inp.addEventListener("change", () => {
            const ok = onChange(inp.value)
            inp.style.borderColor = ok ? "#374151" : "#ef4444"
        })
        wrap.appendChild(lbl)
        wrap.appendChild(inp)
        return wrap
    }

    function _renderFooter() {
        if (!_footerEl) return
        _footerEl.innerHTML = ""
        const tip = document.createElement("div")
        const flights = (_state.lastBuild && _state.lastBuild.flights) || []
        const tier = _state.settings
            && _state.settings.autoScheduler
            && _state.settings.autoScheduler.tier
        const enabled = _state.settings
            && _state.settings.autoScheduler
            && _state.settings.autoScheduler.enabled
        const armed = enabled && tier === "apply-on-confirm"
        if (armed && flights.length) {
            tip.textContent = "Apply-all CTA is wired by slice 5b — active when settings unlocked."
        } else if (flights.length) {
            tip.textContent = "Preview-only tier. Per-leg edits persist into the active draft and are picked up by the Fleet Hub overlay."
        } else {
            tip.textContent = "Apply-all is gated behind settings.aircraftFlightPlan.autoScheduler.tier === \"apply-on-confirm\"."
        }
        _footerEl.appendChild(tip)
    }

    // ── State mutators ─────────────────────────────────────────────────

    function _onLegClick(flight) {
        if (!flight) return
        _state.editingSeq = (flight.seq != null) ? flight.seq : null
        _renderLegs()
    }

    async function _setLegEdit(seq, patch) {
        const ctxR = _ctx()
        if (!ctxR.server || !ctxR.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        try {
            const next = await AesAfpActiveDraftStore.setEdit(
                ctxR.server, ctxR.aircraftId, seq, patch
            )
            _state.draft = next || _state.draft
            _renderLegs()
        } catch (err) {
            console.warn("[AES auto-5a] setEdit failed", err)
        }
    }

    async function _clearLegEdit(seq) {
        const ctxR = _ctx()
        if (!ctxR.server || !ctxR.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        try {
            const next = await AesAfpActiveDraftStore.setEdit(
                ctxR.server, ctxR.aircraftId, seq, null
            )
            _state.draft = next || _state.draft
            _renderLegs()
        } catch (err) {
            console.warn("[AES auto-5a] clearEdit failed", err)
        }
    }

    // ── Auto-build ─────────────────────────────────────────────────────

    async function _runAutoBuild() {
        if (_state.running) return
        if (typeof window.AesAfpAutoScheduler === "undefined"
                || typeof AesAfpAutoScheduler.run !== "function") {
            _state.runError = "AesAfpAutoScheduler not loaded — manifest order?"
            _renderStatus()
            return
        }
        _state.running  = true
        _state.runError = null
        _renderCta()
        _renderStatus()
        try {
            const ctxR = _ctx()
            const build = await AesAfpAutoScheduler.run({
                aircraftId: ctxR.aircraftId,
                spec:       _state.spec || undefined,
                persist:    true
            })
            _state.lastBuild = build || null
            // Re-pull the draft so per-leg edits show against the new flights.
            await _loadDraft()
            await _loadBudget()
        } catch (e) {
            _state.runError = (e && e.message) || String(e)
            console.warn("[AES auto-5a] run threw", e)
        } finally {
            _state.running = false
            _renderCta()
            _renderStatus()
            _renderSummary()
            _renderPreview()
            _renderLegs()
            _renderFooter()
        }
    }

    // ── Draft + budget loaders ─────────────────────────────────────────

    async function _loadDraft() {
        const ctxR = _ctx()
        if (!ctxR.server || !ctxR.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        try {
            _state.draft = await AesAfpActiveDraftStore.load(
                ctxR.server, ctxR.aircraftId
            )
            // Adopt the persisted flights when our in-memory build is empty —
            // the user might have generated on a previous session and is
            // returning to the page; otherwise keep the live build.
            if (!_state.lastBuild && _state.draft
                    && Array.isArray(_state.draft.flights)
                    && _state.draft.flights.length) {
                _state.lastBuild = {
                    validation: [], routes: [], placements: [], unplaced: [],
                    shortfall: {}, skipped: [], connections: [],
                    flights:  _state.draft.flights.slice(),
                    warnings: [],
                    preset:   null,
                    metadata: null
                }
            }
        } catch (err) {
            console.warn("[AES auto-5a] draft load failed", err)
        }
    }

    async function _loadBudget() {
        const ctxR = _ctx()
        if (!ctxR.server || !ctxR.aircraftId) return
        if (typeof AesAfpMaintenanceBudget === "undefined") return
        try {
            _state.budget = await AesAfpMaintenanceBudget.compute({
                server:     ctxR.server,
                aircraftId: ctxR.aircraftId,
                spec:       _state.spec || undefined,
                settings:   _state.settings || undefined
            })
        } catch (err) {
            console.warn("[AES auto-5a] budget compute failed", err)
        }
    }

    async function _loadSettings() {
        if (typeof AesAfpSettings === "undefined") return
        try { _state.settings = await AesAfpSettings.load() }
        catch (err) { console.warn("[AES auto-5a] settings load failed", err) }
    }

    // ── Bus + storage wiring ───────────────────────────────────────────

    let _renderTimer = null
    function _scheduleRender() {
        if (_renderTimer) clearTimeout(_renderTimer)
        _renderTimer = setTimeout(() => {
            _renderTimer = null
            if (!_rootEl) {
                _renderRoot()
            } else {
                _renderSummary()
                _renderCta()
                _renderStatus()
                _renderPreview()
                _renderLegs()
                _renderFooter()
            }
        }, 60)
    }

    function _attachStorageListener() {
        if (_state.storageListener) return
        const ctxR = _ctx()
        if (!ctxR.server || !ctxR.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        const draftKey = AesAfpActiveDraftStore._key(ctxR.server, ctxR.aircraftId)
        _state.storageListener = (changes, area) => {
            if (area !== "local") return
            if (!Object.prototype.hasOwnProperty.call(changes, draftKey)) return
            if (_state.storageTimer) clearTimeout(_state.storageTimer)
            _state.storageTimer = setTimeout(async () => {
                _state.storageTimer = null
                await _loadDraft()
                _renderLegs()
                _renderSummary()
            }, STORAGE_REPAINT_DEBOUNCE_MS)
        }
        chrome.storage.onChanged.addListener(_state.storageListener)
    }

    function _onCtxReady() {
        _state.ctxReady = true
        Promise.all([_loadSettings(), _loadDraft(), _loadBudget()]).then(() => {
            _renderRoot()
            _attachStorageListener()
        }).catch(err => {
            console.warn("[AES auto-5a] ctx:ready hydration failed", err)
            _renderRoot()
        })
    }

    function _onSpecResolved(payload) {
        _state.spec = (payload && payload.spec) || _state.spec
        _loadBudget().then(_scheduleRender).catch(() => _scheduleRender())
    }

    function _onCandidatesUpdated(payload) {
        _state.candidatesLen = (payload && Array.isArray(payload.candidates))
            ? payload.candidates.length : 0
        _scheduleRender()
    }

    function _onAutoBuilt(payload) {
        const build = payload && payload.build
        if (!build) return
        _state.lastBuild = build
        _loadDraft().then(() => _scheduleRender())
    }

    function _attach() {
        const bus = window.AesAfp && window.AesAfp.bus
        if (!bus || typeof bus.on !== "function") {
            // Manifest order should guarantee Slice A loads first; defer once.
            setTimeout(_attach, 50)
            return
        }
        bus.on("ctx:ready",          _onCtxReady)
        bus.on("spec:resolved",      _onSpecResolved)
        bus.on("candidates:updated", _onCandidatesUpdated)
        bus.on("auto-schedule:built", _onAutoBuilt)
        bus.on("maintenance:scraped", () => _loadBudget().then(_scheduleRender))
        bus.on("wear:updated",        () => _loadBudget().then(_scheduleRender))
    }

    // ── Helpers ────────────────────────────────────────────────────────

    function _ago(ts) {
        const dt = Math.max(0, Date.now() - (Number(ts) || Date.now()))
        const s  = Math.floor(dt / 1000)
        if (s < 60)  return s + "s ago"
        const m = Math.floor(s / 60)
        if (m < 60)  return m + "m ago"
        const h = Math.floor(m / 60)
        if (h < 24)  return h + "h ago"
        const d = Math.floor(h / 24)
        return d + "d ago"
    }

    window.AesAfpAutoSchedulerPreview = AesAfpAutoSchedulerPreview

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _attach, {once: true})
    } else {
        _attach()
    }

    // ── ?aes-debug smoke tests (no test runner — project convention) ───
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof AesAfpAutoSchedulerPreview.render === "function",
                "[AES auto-5a smoke] render() exposed")
            console.assert(typeof AesAfpAutoSchedulerPreview.runAutoBuild === "function",
                "[AES auto-5a smoke] runAutoBuild() exposed")
            console.assert(_ago(Date.now() - 30 * 1000).indexOf("s ago") > 0,
                "[AES auto-5a smoke] _ago seconds branch")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
