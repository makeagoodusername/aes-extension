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

    // Per-leg pipeline cost estimate used to project total batch duration
    // in slice 5b's confirmation modal. Calibrated against the existing
    // background.js single-leg flow: tab-load wait (~3s) + form fill +
    // submit + reload (~3s) + 500ms inter-leg gap. Slice 5c's progress
    // UI uses live timing once the pipeline runs; this constant only
    // drives the upfront estimate.
    const ESTIMATED_SECONDS_PER_LEG = 7

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
        settings:      null,
        // Slice 5d — live apply-batch mirror of AesAfpAutoApplyBatch.state.
        // Refreshed on every `auto-apply:start/progress/done/aborted/error`
        // bus event so the footer can render without polling.
        apply: {
            inFlight:       false,
            batchId:        null,
            total:          0,
            completed:      0,
            succeeded:      0,
            failed:         0,
            startedAt:      null,
            finishedAt:     null,
            lastLegResult:  null,    // {legIdx, seq, ok, error, at}
            currentLegIdx:  null,    // most recent leg-start; null between phases
            phase:          null,    // last seen phase
            error:          null,
            aborted:        false,
            results:        []
        },
        // Slice 5e — persisted retry-queue mirror, refreshed on mount,
        // on every `auto-apply:done`, and after the user clicks Dismiss.
        retryQueue: {
            batchId:  null,
            legs:     [],
            loadedAt: null
        },
        // Slice 8a — fleet-apply orchestrator mirror. Refreshed on each
        // `fleet-apply:*` bus event so the footer can render fleet-level
        // progress (alongside the per-aircraft `apply` block above).
        fleetApply: {
            inFlight:        false,
            runId:           null,
            total:           0,
            idx:             0,
            currentAircraft: null,
            startedAt:       null,
            finishedAt:      null,
            aborted:         false,
            perAircraft:     []
        }
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
        render:           () => _scheduleRender(),
        runAutoBuild:     () => _runAutoBuild(),
        openConfirmModal: (legs, opts) => _openConfirmModal(legs, opts),
        applyAll:         (legs, opts) => _applyAll(legs, opts),
        abortApply:       () => _abortApply(),
        retryFailed:      () => _retryFailed(),
        get lastBuild() { return _state.lastBuild },
        get applyState() { return Object.assign({}, _state.apply) }
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
        // Track 7 slice 7e — when the budget reserved hours for AS-managed
        // maintenance windows, surface the breakdown in the tooltip so the
        // user understands why the ceiling tightened.
        const reservedMaint = (_state.budget
            && isFinite(_state.budget.scheduledMaintenanceHoursPerWeek))
            ? Number(_state.budget.scheduledMaintenanceHoursPerWeek) : 0
        const rawMax = (_state.budget && isFinite(_state.budget.rawMaxWeeklyBlockHours))
            ? Number(_state.budget.rawMaxWeeklyBlockHours)
            : (meta && isFinite(meta.budgetMaxHours) ? meta.budgetMaxHours : null)
        const weeklyTitle = meta && isFinite(meta.budgetMaxHours)
            ? ("Used " + meta.budgetUsedHours.toFixed(1)
              + "h of " + meta.budgetMaxHours.toFixed(0) + "h ceiling"
              + (reservedMaint > 0 && rawMax != null
                  ? " (raw " + rawMax.toFixed(0) + "h − "
                    + reservedMaint.toFixed(1) + "h scheduled maintenance)"
                  : ""))
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

        // Apply-all CTA — gated behind the autoScheduler tier + enabled flag.
        // The button is always rendered (so the user knows it exists) but
        // disabled with an explanatory tooltip in the dormant state.
        const flights = (_state.lastBuild && _state.lastBuild.flights) || []
        const tier = _state.settings
            && _state.settings.autoScheduler
            && _state.settings.autoScheduler.tier
        const enabledFlag = _state.settings
            && _state.settings.autoScheduler
            && _state.settings.autoScheduler.enabled
        const armed = !!enabledFlag && tier === "apply-on-confirm"
        const maxLegs = (_state.settings && _state.settings.autoScheduler
            && Number(_state.settings.autoScheduler.maxLegsPerApply)) || 28
        const applyEnabled = !_state.running
            && _state.lastBuild
            && flights.length > 0
            && armed
            && flights.length <= maxLegs
        const applyBtn = document.createElement("button")
        applyBtn.type = "button"
        applyBtn.textContent = flights.length
            ? "Apply all " + flights.length + " flights…"
            : "Apply all flights…"
        applyBtn.disabled = !applyEnabled
        applyBtn.style.cssText = "background:" + (applyEnabled ? "#b91c1c" : "#374151") + ";"
            + "color:" + (applyEnabled ? "#fef2f2" : "#9ca3af") + ";"
            + "border:1px solid " + (applyEnabled ? "#7f1d1d" : "#374151") + ";"
            + "border-radius:3px;padding:4px 12px;font-size:11px;font-weight:600;"
            + "cursor:" + (applyEnabled ? "pointer" : "not-allowed") + ";"
        applyBtn.title = applyEnabled
            ? "Open the confirmation modal listing every leg AS will be POSTed."
            : _applyBlockedReason({armed, flights, maxLegs, tier, enabled: enabledFlag})
        applyBtn.addEventListener("click", () => {
            if (applyEnabled) _openConfirmModal()
        })
        _ctaEl.appendChild(applyBtn)

        // Tier-status hint for the dormant case so users know where to flip
        // the gate. Settings live in chrome.storage.local.settings, edited
        // via the diagnostics console (Phase-1 has no UI knob).
        if (_state.lastBuild && !armed) {
            const hint = document.createElement("span")
            hint.style.cssText = "color:#6b7280;font-size:11px;"
            hint.textContent = "Tier-gated — set"
                + " settings.aircraftFlightPlan.autoScheduler.enabled = true"
                + " + .tier = \"apply-on-confirm\" to unlock Apply-all."
            _ctaEl.appendChild(hint)
        }
    }

    function _applyBlockedReason(opts) {
        if (_state.running)                  return "Auto-build still running."
        if (!_state.lastBuild)               return "No build to apply — run Auto-build first."
        if (!opts.flights.length)            return "Build returned 0 flights."
        if (!opts.enabled)                   return "autoScheduler.enabled === false (default Phase-1 posture)."
        if (opts.tier !== "apply-on-confirm") return "autoScheduler.tier === \"" + (opts.tier || "?") + "\" — needs \"apply-on-confirm\"."
        if (opts.flights.length > opts.maxLegs) return "Build has " + opts.flights.length + " legs > maxLegsPerApply " + opts.maxLegs + "."
        return ""
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

        // Slice 8a — fleet apply takes precedence over per-aircraft apply
        // since the orchestrator runs them in serial and a per-aircraft
        // `apply.inFlight` flips on between aircraft. Surface the fleet
        // banner so the user sees the larger context.
        if (_state.fleetApply.inFlight) {
            _footerEl.appendChild(_renderFleetApplyProgress())
            return
        }
        if (_state.fleetApply.finishedAt && !_state.apply.inFlight) {
            _footerEl.appendChild(_renderFleetApplyResultBanner())
            return
        }

        // Live progress UI when a batch is in flight (slice 5d).
        if (_state.apply.inFlight) {
            _footerEl.appendChild(_renderApplyProgress())
            return
        }

        // Recently-finished batch summary — sticky until a new batch
        // starts or the user dismisses it. Surfaces failed legs as a
        // hand-off to slice 5e's retry queue.
        if (_state.apply.finishedAt) {
            _footerEl.appendChild(_renderApplyResultBanner())
            return
        }

        // Slice 5e — persisted retry queue (survives page reload after
        // a partial batch). Only surfaces when there are legs to retry.
        if (_state.retryQueue.legs && _state.retryQueue.legs.length) {
            _footerEl.appendChild(_renderPersistedRetryBanner())
            return
        }

        // Default tip.
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
            tip.textContent = "Apply-all wired — confirm modal lists every leg before posting."
        } else if (flights.length) {
            tip.textContent = "Preview-only tier. Per-leg edits persist into the active draft and are picked up by the Fleet Hub overlay."
        } else {
            tip.textContent = "Apply-all is gated behind settings.aircraftFlightPlan.autoScheduler.tier === \"apply-on-confirm\"."
        }
        _footerEl.appendChild(tip)
    }

    // ── Slice 5d — live progress UI + abort ────────────────────────────

    function _renderApplyProgress() {
        const wrap = document.createElement("div")
        wrap.className = "aes-afp-auto-progress"
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"
            + "padding:6px 4px;"

        // Top row — counters + abort.
        const top = document.createElement("div")
        top.style.cssText = "display:flex;align-items:center;gap:10px;font-size:11px;"
            + "color:#e5e7eb;"

        const a = _state.apply
        const total = a.total || 0
        const done  = a.completed || 0
        const sym = a.lastLegResult
            ? (a.lastLegResult.ok ? "✓" : "✗")
            : "·"
        const symColor = a.lastLegResult
            ? (a.lastLegResult.ok ? "#34d399" : "#f87171")
            : "#6b7280"

        const heading = document.createElement("span")
        heading.style.cssText = "font-weight:600;color:#f3f4f6;"
        const curIdx = a.currentLegIdx != null ? (a.currentLegIdx + 1) : done
        heading.textContent = "Applying leg " + curIdx + " of " + total + "…"
        top.appendChild(heading)

        const sep = document.createElement("span")
        sep.style.cssText = "color:#374151;"
        sep.textContent = "·"
        top.appendChild(sep)

        const lastSym = document.createElement("span")
        lastSym.style.cssText = "color:" + symColor + ";font-weight:700;"
            + "font-variant-numeric:tabular-nums;"
        lastSym.textContent = sym
        if (a.lastLegResult) {
            const r = a.lastLegResult
            const tag = r.ok
                ? "leg " + ((r.legIdx != null ? r.legIdx + 1 : "?")) + " ok"
                : "leg " + ((r.legIdx != null ? r.legIdx + 1 : "?")) + " failed"
                  + (r.error ? " — " + r.error : "")
            lastSym.title = tag
        }
        top.appendChild(lastSym)

        const ok = document.createElement("span")
        ok.style.cssText = "color:#34d399;"
        ok.textContent = a.succeeded + " ok"
        top.appendChild(ok)

        if (a.failed > 0) {
            const fail = document.createElement("span")
            fail.style.cssText = "color:#f87171;"
            fail.textContent = a.failed + " failed"
            top.appendChild(fail)
        }

        const eta = document.createElement("span")
        eta.style.cssText = "color:#9ca3af;flex:1 1 auto;text-align:right;"
            + "font-variant-numeric:tabular-nums;"
        const remaining = Math.max(0, total - done)
        const liveSec = _liveSecondsPerLeg()
        const remainingSec = Math.round(remaining * liveSec)
        eta.textContent = remaining
            ? "~" + _fmtDuration(remainingSec) + " remaining"
            : "finalizing…"
        top.appendChild(eta)

        const abort = document.createElement("button")
        abort.type = "button"
        abort.textContent = "Abort"
        abort.title = "Stop the batch + close the hidden tab. Already-applied legs stay in AS."
        abort.style.cssText = "background:#7f1d1d;color:#fef2f2;"
            + "border:1px solid #b91c1c;border-radius:3px;padding:3px 10px;"
            + "font-size:11px;font-weight:600;cursor:pointer;"
        abort.addEventListener("click", () => _abortApply())
        top.appendChild(abort)

        wrap.appendChild(top)

        // Progress bar.
        const bar = document.createElement("div")
        bar.style.cssText = "position:relative;height:6px;background:#0f1623;"
            + "border:1px solid #1f2937;border-radius:3px;overflow:hidden;"
        const pct = total > 0 ? (done / total) * 100 : 0
        const fill = document.createElement("div")
        fill.style.cssText = "position:absolute;left:0;top:0;bottom:0;"
            + "width:" + pct.toFixed(1) + "%;"
            + "background:linear-gradient(90deg,#1d4ed8,#3b82f6);"
            + "transition:width 200ms linear;"
        bar.appendChild(fill)
        wrap.appendChild(bar)

        // Status line — phase + last error.
        const status = document.createElement("div")
        status.style.cssText = "font-size:10px;color:#9ca3af;"
        const phase = a.phase || ""
        const phaseLabel = ({
            "queued":    "Waiting in queue",
            "tab-opened": "Hidden tab opened",
            "tab-loaded": "Tab loaded",
            "leg-start":  "Filling form…",
            "leg-done":   "Leg settled",
            "aborted":    "Aborted",
            "timeout":    "Timed out",
            "done":       "Done",
            "error":      "Error"
        })[phase] || phase
        const elapsed = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0
        status.textContent = "Phase: " + phaseLabel
            + " · " + a.batchId
            + " · elapsed " + _fmtDuration(elapsed)
        if (a.error) {
            status.textContent += " · " + a.error
            status.style.color = "#fca5a5"
        }
        wrap.appendChild(status)

        return wrap
    }

    function _renderApplyResultBanner() {
        const a = _state.apply
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;"
            + "padding:6px 8px;font-size:11px;"
            + "background:#0f1623;border:1px solid #1f2937;border-radius:3px;"
            + "color:#cbd5e1;"
        const summary = document.createElement("span")
        summary.style.cssText = "flex:1 1 auto;"
        const elapsed = (a.finishedAt && a.startedAt)
            ? Math.round((a.finishedAt - a.startedAt) / 1000) : 0
        const verb = a.aborted ? "Aborted" : (a.error ? "Errored" : "Done")
        summary.innerHTML = "<strong>" + verb + ":</strong> "
            + a.succeeded + " ok"
            + (a.failed ? " · <span style=\"color:#fca5a5;\">" + a.failed + " failed</span>" : "")
            + " · " + _fmtDuration(elapsed) + " elapsed"
            + (a.error ? " · " + escapeHtml(a.error) : "")
        wrap.appendChild(summary)

        if (a.failed > 0) {
            const retry = document.createElement("button")
            retry.type = "button"
            retry.textContent = a.failed + " failed — retry"
            retry.title = "Retry the failed legs from the audit log (slice 5e wires this)."
            retry.style.cssText = "background:#1d4ed8;color:#f8fafc;"
                + "border:1px solid #1e3a8a;border-radius:3px;padding:3px 10px;"
                + "font-size:11px;font-weight:600;cursor:pointer;"
            retry.addEventListener("click", () => _retryFailed())
            wrap.appendChild(retry)
        }

        const dismiss = document.createElement("button")
        dismiss.type = "button"
        dismiss.textContent = "Dismiss"
        dismiss.title = "Clear this banner."
        dismiss.style.cssText = "background:transparent;color:#9ca3af;"
            + "border:1px solid #374151;border-radius:3px;padding:3px 8px;"
            + "font-size:11px;cursor:pointer;"
        dismiss.addEventListener("click", () => {
            _state.apply.finishedAt = null
            _state.apply.lastLegResult = null
            _state.apply.results = []
            _renderFooter()
        })
        wrap.appendChild(dismiss)

        return wrap
    }

    function _liveSecondsPerLeg() {
        const a = _state.apply
        if (a.startedAt && a.completed > 0) {
            const elapsedMs = Date.now() - a.startedAt
            const rate = elapsedMs / a.completed / 1000
            // Clamp to a sensible band so a single fast/slow leg doesn't
            // wildly skew the projection.
            return Math.max(3, Math.min(20, rate))
        }
        return ESTIMATED_SECONDS_PER_LEG
    }

    function _abortApply() {
        if (!_state.apply.inFlight) return
        const batch = window.AesAfpAutoApplyBatch
        if (!batch || typeof batch.abort !== "function") {
            _toast("Apply-batch module not loaded — can't abort.", "error")
            return
        }
        try { batch.abort() }
        catch (e) {
            console.warn("[AES auto-5d] abort threw", e)
            _toast("Abort failed: " + ((e && e.message) || e), "error")
        }
    }

    /**
     * Slice 5e wires the actual retry pipeline. For 5d we surface the
     * intent on the bus + emit a toast hint so the user sees the click
     * landed; the `_state.apply.results` list carries enough context
     * (`{legIdx, seq, ok: false, error}`) for 5e's queue.
     */
    function _retryFailed() {
        const failedSeqs = (_state.apply.results || [])
            .filter(r => r && !r.ok)
            .map(r => r.seq)
        if (!failedSeqs.length) return
        const failedLegs = (_state.lastBuild && _state.lastBuild.flights || [])
            .filter(f => failedSeqs.indexOf(f.seq) !== -1)
        if (!failedLegs.length) {
            _toast("No matching legs in the current Build — re-run Auto-build first.", "warn")
            return
        }
        const ctxR = _ctx()
        const payload = {
            ctx:         {server: ctxR.server || "", aircraftId: ctxR.aircraftId || "",
                          currentLocationIata: ctxR.currentLocationIata || ""},
            legs:        _materialiseFailedLegs(failedLegs),
            requestedAt: Date.now(),
            source:      "retry-failed"
        }
        if (window.AesAfp && AesAfp.bus) {
            try { AesAfp.bus.emit("auto-apply:retry-requested", payload) }
            catch (_) { /* bus self-isolates */ }
        }
        _applyAll(payload.legs, {source: "retry-failed"})
    }

    function _materialiseFailedLegs(buildLegs) {
        const overlays = (_state.draft && _state.draft.perLegEdits) || {}
        const dpct = (_state.settings && isFinite(Number(_state.settings.defaultPricePct)))
            ? _state.settings.defaultPricePct : 100
        const dsvc = (_state.settings && typeof _state.settings.defaultService === "string")
            ? _state.settings.defaultService : ""
        return buildLegs.map(f => {
            const o = overlays[f.seq] || {}
            const eff = Object.assign({}, f, o)
            return {
                seq:         f.seq,
                waveId:      f.waveId,
                waveLabel:   f.waveLabel,
                direction:   eff.direction || f.direction,
                origin:      eff.origin      || f.origin      || null,
                destination: eff.destination || f.destination || null,
                depTime:     eff.depTimeLocal || f.depTimeLocal || null,
                distanceNm:  f.distanceNm,
                pricePct:    isFinite(Number(eff.pricePct)) ? Number(eff.pricePct) : dpct,
                service:     (typeof eff.service === "string") ? eff.service : dsvc
            }
        })
    }

    // Bus handlers fed by apply-batch.js.

    function _onApplyStart(payload) {
        const p = payload || {}
        _state.apply.inFlight      = true
        _state.apply.batchId       = p.batchId || null
        _state.apply.total         = Number(p.total) || 0
        _state.apply.completed     = 0
        _state.apply.succeeded     = 0
        _state.apply.failed        = 0
        _state.apply.startedAt     = p.startedAt || Date.now()
        _state.apply.finishedAt    = null
        _state.apply.lastLegResult = null
        _state.apply.currentLegIdx = null
        _state.apply.phase         = "queued"
        _state.apply.error         = null
        _state.apply.aborted       = false
        _state.apply.results       = []
        _renderFooter()
        _renderLegs()   // refresh appliedLegs styling
        _startApplyTicker()
    }

    function _onApplyProgress(payload) {
        const p = payload || {}
        if (_state.apply.batchId && p.batchId && p.batchId !== _state.apply.batchId) return
        if (p.phase) _state.apply.phase = p.phase
        if (p.phase === "leg-start") {
            _state.apply.currentLegIdx = (typeof p.legIdx === "number") ? p.legIdx : _state.apply.currentLegIdx
        }
        if (p.phase === "leg-done") {
            _state.apply.completed = (_state.apply.completed || 0) + 1
            if (p.ok) _state.apply.succeeded++
            else      _state.apply.failed++
            _state.apply.lastLegResult = {
                legIdx: p.legIdx, seq: p.seq, ok: !!p.ok, error: p.error || null, at: Date.now()
            }
            _state.apply.results.push({
                legIdx: p.legIdx, seq: p.seq, ok: !!p.ok, error: p.error || null
            })
        }
        if (p.phase === "error" && p.error) _state.apply.error = p.error
        _renderFooter()
    }

    function _onApplyDone(payload) {
        const p = payload || {}
        if (_state.apply.batchId && p.batchId && p.batchId !== _state.apply.batchId) return
        _state.apply.inFlight   = false
        _state.apply.finishedAt = p.finishedAt || Date.now()
        _state.apply.aborted    = !!p.aborted
        if (p.error && !_state.apply.error) _state.apply.error = p.error
        if (Array.isArray(p.results) && p.results.length) {
            _state.apply.results = p.results
            _state.apply.succeeded = p.results.filter(r => r && r.ok).length
            _state.apply.failed    = p.results.length - _state.apply.succeeded
            _state.apply.completed = p.results.length
        }
        _stopApplyTicker()
        _renderFooter()
        // Refresh the per-leg list so successful seqs show the
        // appliedLegs background tint via the active-draft listener
        // (apply-batch.js writes appliedLegs[seq] on every ok leg-done).
        _loadDraft().then(() => _renderLegs()).catch(() => _renderLegs())
        // Slice 5e — refresh the persisted retry queue so the next
        // mount (or the dismiss banner) sees the latest failed legs.
        _loadRetryQueue().catch(() => {})
    }

    function _onApplyAborted(payload) {
        const p = payload || {}
        if (_state.apply.batchId && p.batchId && p.batchId !== _state.apply.batchId) return
        _state.apply.inFlight   = false
        _state.apply.finishedAt = Date.now()
        _state.apply.aborted    = true
        _state.apply.phase      = "aborted"
        _stopApplyTicker()
        _renderFooter()
    }

    function _onApplyError(payload) {
        const p = payload || {}
        _state.apply.inFlight   = false
        _state.apply.finishedAt = Date.now()
        _state.apply.error      = p.error || "unknown error"
        _state.apply.phase      = "error"
        _stopApplyTicker()
        _renderFooter()
    }

    // ── Slice 5e — persisted retry queue ───────────────────────────────

    function _renderPersistedRetryBanner() {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:10px;"
            + "padding:6px 8px;font-size:11px;"
            + "background:rgba(127,29,29,0.15);"
            + "border:1px solid rgba(220,38,38,0.40);border-radius:3px;"
            + "color:#fecaca;"
        const summary = document.createElement("span")
        summary.style.cssText = "flex:1 1 auto;"
        const n = _state.retryQueue.legs.length
        summary.innerHTML = "<strong>" + n + " leg" + (n === 1 ? "" : "s")
            + " failed</strong> in batch <code style=\"font-size:10px;\">"
            + escapeHtml(_state.retryQueue.batchId || "?")
            + "</code> — retry the failures?"
        wrap.appendChild(summary)

        const retry = document.createElement("button")
        retry.type = "button"
        retry.textContent = "Retry " + n
        retry.title = "Re-dispatch the failed legs through the apply-batch pipeline. Modal is skipped."
        retry.style.cssText = "background:#1d4ed8;color:#f8fafc;"
            + "border:1px solid #1e3a8a;border-radius:3px;padding:3px 10px;"
            + "font-size:11px;font-weight:600;cursor:pointer;"
        retry.addEventListener("click", () => _retryPersistedQueue())
        wrap.appendChild(retry)

        const dismiss = document.createElement("button")
        dismiss.type = "button"
        dismiss.textContent = "Dismiss"
        dismiss.title = "Hide the queue. Underlying entries stay in the audit log."
        dismiss.style.cssText = "background:transparent;color:#fca5a5;"
            + "border:1px solid #b91c1c;border-radius:3px;padding:3px 8px;"
            + "font-size:11px;cursor:pointer;"
        dismiss.addEventListener("click", () => _dismissPersistedQueue())
        wrap.appendChild(dismiss)

        return wrap
    }

    /**
     * Materialise persisted retry-queue entries (which carry the leg's
     * origin/dest/depTime/pricePct/service from when the batch ran)
     * back into the form-driver leg shape and dispatch them through
     * apply-batch.js (no confirmation modal — this IS the retry).
     */
    function _retryPersistedQueue() {
        const queue = _state.retryQueue
        if (!queue.legs.length) return
        const ctxR = _ctx()
        const dpct = (_state.settings && isFinite(Number(_state.settings.defaultPricePct)))
            ? _state.settings.defaultPricePct : 100
        const dsvc = (_state.settings && typeof _state.settings.defaultService === "string")
            ? _state.settings.defaultService : ""
        const legs = queue.legs.map(e => ({
            seq:         e.seq,
            origin:      e.origin || null,
            destination: e.dest   || null,
            depTime:     e.depTime || null,
            direction:   e.direction || "outbound",
            waveLabel:   e.waveLabel || null,
            pricePct:    isFinite(Number(e.pricePct)) ? Number(e.pricePct) : dpct,
            service:     (typeof e.service === "string") ? e.service : dsvc
        })).filter(l => l.origin && l.destination)
        if (!legs.length) {
            _toast("Persisted retry queue couldn't be reconstructed (missing origin/dest).", "warn")
            return
        }
        const payload = {
            ctx:         {server: ctxR.server || "", aircraftId: ctxR.aircraftId || "",
                          currentLocationIata: ctxR.currentLocationIata || ""},
            legs:        legs,
            requestedAt: Date.now(),
            source:      "retry-persisted"
        }
        if (window.AesAfp && AesAfp.bus) {
            try { AesAfp.bus.emit("auto-apply:retry-requested", payload) }
            catch (_) { /* bus self-isolates */ }
        }
        _applyAll(legs, {source: "retry-persisted"})
    }

    function _dismissPersistedQueue() {
        const ctxR = _ctx()
        if (!ctxR.server || !ctxR.aircraftId) return
        if (typeof AesAfpAutoApplyLog === "undefined") return
        AesAfpAutoApplyLog.dismissRetryQueue(ctxR.server, ctxR.aircraftId)
            .then(() => _loadRetryQueue())
            .then(() => _renderFooter())
            .catch(err => console.warn("[AES auto-5e] dismiss queue failed", err))
    }

    async function _loadRetryQueue() {
        const ctxR = _ctx()
        if (!ctxR.server || !ctxR.aircraftId) return
        if (typeof AesAfpAutoApplyLog === "undefined") return
        try {
            const queue = await AesAfpAutoApplyLog.getRetryQueue(
                ctxR.server, ctxR.aircraftId
            )
            _state.retryQueue.batchId  = queue.batchId
            _state.retryQueue.legs     = Array.isArray(queue.legs) ? queue.legs : []
            _state.retryQueue.loadedAt = Date.now()
        } catch (err) {
            console.warn("[AES auto-5e] retry-queue load failed", err)
        }
    }

    /**
     * 1Hz ticker so the progress bar's "elapsed" / "remaining" lines
     * advance smoothly between leg-done events. Started on apply:start,
     * stopped on done/aborted/error.
     */
    let _applyTickTimer = null
    function _startApplyTicker() {
        _stopApplyTicker()
        _applyTickTimer = setInterval(() => {
            if (!_state.apply.inFlight) {
                _stopApplyTicker()
                return
            }
            _renderFooter()
        }, 1000)
    }
    function _stopApplyTicker() {
        if (_applyTickTimer) {
            clearInterval(_applyTickTimer)
            _applyTickTimer = null
        }
    }

    // ── Apply-all confirmation modal (slice 5b) ────────────────────────

    let _modalEl = null

    /**
     * Resolve the effective leg payload — base flight from the build
     * with `perLegEdits[seq]` overlay merged on top. Returns the shape
     * `AesAfpFormDriver.fill` (and the background-tab pipeline) expects:
     * `{seq, origin, destination, depTime, pricePct, service}`. Inbound
     * legs reverse origin/dest as already encoded in the build's
     * `direction` field.
     */
    function _materialiseLegs(build, draft) {
        const flights = (build && build.flights) || []
        const overlays = (draft && draft.perLegEdits) || {}
        const dpct = (_state.settings && isFinite(Number(_state.settings.defaultPricePct)))
            ? _state.settings.defaultPricePct : 100
        const dsvc = (_state.settings && typeof _state.settings.defaultService === "string")
            ? _state.settings.defaultService : ""
        const out = []
        for (const f of flights) {
            const o = overlays[f.seq] || {}
            const eff = Object.assign({}, f, o)
            out.push({
                seq:         f.seq,
                waveId:      f.waveId,
                waveLabel:   f.waveLabel,
                direction:   eff.direction || f.direction,
                origin:      eff.origin      || f.origin      || null,
                destination: eff.destination || f.destination || null,
                depTime:     eff.depTimeLocal || f.depTimeLocal || null,
                distanceNm:  f.distanceNm,
                pricePct:    isFinite(Number(eff.pricePct)) ? Number(eff.pricePct) : dpct,
                service:     (typeof eff.service === "string") ? eff.service : dsvc
            })
        }
        return out
    }

    /**
     * Open the leg-confirmation modal. Without arguments, materialises legs
     * from `_state.lastBuild` (the in-panel auto-build path). With
     * `externalLegs`, opens against any caller-provided leg list — Flight
     * Studio uses this so its "Apply" / "Automate" buttons reuse the same
     * mandatory-ack gate and locked-leg detection without duplicating the
     * modal markup. `externalOpts.source` flows through to the audit log.
     */
    function _openConfirmModal(externalLegs, externalOpts) {
        let legs
        if (Array.isArray(externalLegs) && externalLegs.length) {
            legs = externalLegs
        } else {
            if (!_state.lastBuild) return
            legs = _materialiseLegs(_state.lastBuild, _state.draft)
        }
        if (!legs.length) return
        _closeConfirmModal()

        const overlay = document.createElement("div")
        overlay.className = "aes-overlay"
        overlay.setAttribute("data-aes-afp-auto-confirm", "1")
        overlay.style.cssText = "position:fixed;inset:0;"
            + "background:rgba(15,23,42,0.78);z-index:99998;"
            + "display:flex;align-items:center;justify-content:center;padding:24px;"
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) _closeConfirmModal()
        })

        const modal = document.createElement("div")
        modal.className = "aes-afp-auto-confirm-modal"
        modal.style.cssText = "background:#0f1623;color:#e5e7eb;"
            + "border:1px solid #1f2937;border-radius:5px;"
            + "max-width:min(720px,94vw);max-height:88vh;width:100%;"
            + "display:flex;flex-direction:column;overflow:hidden;"
            + "font-size:12px;font-family:inherit;"

        // Header.
        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;gap:8px;"
            + "padding:10px 14px;border-bottom:1px solid #1f2937;"
            + "background:#111827;"
        const title = document.createElement("div")
        title.style.cssText = "font-weight:700;font-size:13px;color:#f3f4f6;"
            + "flex:1 1 auto;"
        title.textContent = "Apply " + legs.length + " flights — confirm"
        header.appendChild(title)
        const closeX = document.createElement("button")
        closeX.type = "button"
        closeX.textContent = "×"
        closeX.title = "Cancel"
        closeX.style.cssText = "background:transparent;color:#9ca3af;"
            + "border:0;font-size:18px;line-height:1;cursor:pointer;"
            + "padding:0 4px;"
        closeX.addEventListener("click", _closeConfirmModal)
        header.appendChild(closeX)
        modal.appendChild(header)

        // Body — leg list with checkboxes.
        const body = document.createElement("div")
        body.style.cssText = "padding:8px 14px;overflow-y:auto;flex:1 1 auto;"

        const subtitle = document.createElement("div")
        subtitle.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:6px;"
        const totalSecs = legs.length * ESTIMATED_SECONDS_PER_LEG
        subtitle.textContent = "Each checked leg posts one new flight number to AS."
            + " Estimated total: ~" + _fmtDuration(totalSecs)
            + " (" + ESTIMATED_SECONDS_PER_LEG + "s per leg)."
        body.appendChild(subtitle)

        const checked = new Set(legs.map(l => l.seq))   // default all on

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:0;"
            + "border:1px solid #1f2937;border-radius:3px;"
        legs.forEach((leg, idx) => {
            const row = document.createElement("label")
            row.style.cssText = "display:flex;align-items:center;gap:8px;"
                + "padding:5px 8px;font-size:11px;color:#cbd5e1;cursor:pointer;"
                + (idx % 2 ? "background:#0f1623;" : "background:#111827;")
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = true
            cb.style.cssText = "margin:0;flex:0 0 auto;"
            cb.addEventListener("change", () => {
                if (cb.checked) checked.add(leg.seq); else checked.delete(leg.seq)
                _updateModalCounts()
            })
            row.appendChild(cb)

            const idxLbl = document.createElement("span")
            idxLbl.style.cssText = "color:#6b7280;width:24px;flex:0 0 auto;"
                + "font-variant-numeric:tabular-nums;text-align:right;"
            idxLbl.textContent = String(idx + 1) + "."
            row.appendChild(idxLbl)

            const dirCol = (leg.direction === "inbound") ? "#10b981" : "#3b82f6"
            const dirAr  = (leg.direction === "inbound") ? "←" : "→"
            const dir = document.createElement("span")
            dir.style.cssText = "color:" + dirCol + ";font-weight:600;width:30px;flex:0 0 auto;"
            dir.textContent = (leg.direction || "").slice(0, 3)
            row.appendChild(dir)

            const od = document.createElement("span")
            od.style.cssText = "font-weight:600;color:#f8fafc;flex:1 1 auto;min-width:0;"
                + "font-variant-numeric:tabular-nums;"
            od.textContent = (leg.origin || "?") + " " + dirAr + " " + (leg.destination || "?")
            row.appendChild(od)

            const time = document.createElement("span")
            time.style.cssText = "color:#9ca3af;width:46px;flex:0 0 auto;text-align:right;"
                + "font-variant-numeric:tabular-nums;"
            time.textContent = leg.depTime || "—"
            row.appendChild(time)

            const price = document.createElement("span")
            price.style.cssText = "color:#9ca3af;width:42px;flex:0 0 auto;text-align:right;"
                + "font-size:10px;font-variant-numeric:tabular-nums;"
            price.textContent = (leg.pricePct != null ? leg.pricePct : 100) + "%"
            row.appendChild(price)

            const overlayTag = (_state.draft && _state.draft.perLegEdits
                && _state.draft.perLegEdits[leg.seq]) ? "edited" : ""
            if (overlayTag) {
                const tag = document.createElement("span")
                tag.style.cssText = "color:#fbbf24;font-size:10px;width:38px;flex:0 0 auto;"
                tag.textContent = overlayTag
                row.appendChild(tag)
            }

            list.appendChild(row)
        })
        body.appendChild(list)

        // I-understand checkbox — required to enable Apply.
        const ackWrap = document.createElement("label")
        ackWrap.style.cssText = "display:flex;align-items:flex-start;gap:8px;"
            + "padding:10px 8px 4px;font-size:11px;color:#fbbf24;cursor:pointer;"
        const ack = document.createElement("input")
        ack.type = "checkbox"
        ack.checked = false
        ack.style.cssText = "margin:3px 0 0;flex:0 0 auto;"
        ackWrap.appendChild(ack)
        const ackLbl = document.createElement("span")
        ackLbl.innerHTML = "I understand AS will receive <strong data-aes-acked-count>"
            + legs.length + "</strong> POSTs (one per leg) over"
            + " ~<strong data-aes-acked-est>" + _fmtDuration(totalSecs) + "</strong>"
            + ". Failed legs will surface in the audit log + retry queue."
        ackWrap.appendChild(ackLbl)
        body.appendChild(ackWrap)
        ack.addEventListener("change", _updateModalCounts)

        modal.appendChild(body)

        // Footer — Cancel + Apply.
        const footer = document.createElement("div")
        footer.style.cssText = "display:flex;gap:6px;align-items:center;"
            + "padding:8px 14px;border-top:1px solid #1f2937;background:#111827;"

        const counter = document.createElement("span")
        counter.setAttribute("data-aes-modal-counter", "1")
        counter.style.cssText = "color:#9ca3af;font-size:11px;flex:1 1 auto;"
        counter.textContent = legs.length + " of " + legs.length + " selected"
        footer.appendChild(counter)

        const cancel = document.createElement("button")
        cancel.type = "button"
        cancel.textContent = "Cancel"
        cancel.style.cssText = "background:transparent;color:#cbd5e1;"
            + "border:1px solid #374151;border-radius:3px;padding:4px 10px;"
            + "font-size:11px;cursor:pointer;"
        cancel.addEventListener("click", _closeConfirmModal)
        footer.appendChild(cancel)

        const apply = document.createElement("button")
        apply.type = "button"
        apply.setAttribute("data-aes-modal-apply", "1")
        apply.textContent = "Apply"
        apply.disabled = true
        apply.style.cssText = "background:#374151;color:#9ca3af;"
            + "border:1px solid #374151;border-radius:3px;padding:4px 14px;"
            + "font-size:11px;font-weight:600;cursor:not-allowed;"
        apply.addEventListener("click", () => {
            if (apply.disabled) return
            const selectedLegs = legs.filter(l => checked.has(l.seq))
            _closeConfirmModal()
            const source = (externalOpts && externalOpts.source) || "confirm-modal"
            _applyAll(selectedLegs, {source})
        })
        footer.appendChild(apply)

        modal.appendChild(footer)
        overlay.appendChild(modal)
        document.body.appendChild(overlay)
        _modalEl = overlay

        // Esc closes — same convention as wave-applier's modals.
        const onKey = (e) => {
            if (e.key === "Escape") {
                _closeConfirmModal()
                document.removeEventListener("keydown", onKey)
            }
        }
        document.addEventListener("keydown", onKey)

        // Cache per-modal state so _updateModalCounts can read it.
        _modalEl._aesState = {legs, checked, ack, totalSecs}
        _updateModalCounts()
    }

    function _updateModalCounts() {
        if (!_modalEl || !_modalEl._aesState) return
        const {legs, checked, ack} = _modalEl._aesState
        const counter = _modalEl.querySelector("[data-aes-modal-counter]")
        const apply   = _modalEl.querySelector("[data-aes-modal-apply]")
        const ackedCt = _modalEl.querySelector("[data-aes-acked-count]")
        const ackedEst = _modalEl.querySelector("[data-aes-acked-est]")
        const sel = checked.size
        if (counter) counter.textContent = sel + " of " + legs.length + " selected"
        if (ackedCt) ackedCt.textContent = String(sel)
        if (ackedEst) ackedEst.textContent = _fmtDuration(sel * ESTIMATED_SECONDS_PER_LEG)
        const enabled = !!(ack && ack.checked) && sel > 0
        if (apply) {
            apply.disabled = !enabled
            apply.style.background = enabled ? "#b91c1c" : "#374151"
            apply.style.color      = enabled ? "#fef2f2" : "#9ca3af"
            apply.style.borderColor = enabled ? "#7f1d1d" : "#374151"
            apply.style.cursor     = enabled ? "pointer" : "not-allowed"
        }
    }

    function _closeConfirmModal() {
        if (!_modalEl) return
        try { _modalEl.remove() } catch (_) { /* noop */ }
        _modalEl = null
    }

    /**
     * Slice 5b stub. Hands off to slice 5c's apply-batch.js when present
     * (`window.AesAfpAutoApplyBatch`); otherwise emits a bus event so
     * downstream wiring (audit log, retry queue) can observe the request
     * and toasts a "pipeline not loaded" message. Keeps the no-programmatic-
     * submit invariant intact — there is no AS POST here.
     *
     * Slice 6d (locked-confirm modal): before dispatch, run schedule-diff
     * against the current VFP and surface AesAfpLockedConfirmModal when
     * the request involves locked legs (proposed legs marked immutable +
     * current locked legs that won't be deletable). Three outcomes:
     *   - continue → original dispatch (apply-batch silently skips locked
     *                proposed legs; current locked stay in place)
     *   - override → run delete-batch on the current locked legs first,
     *                then dispatch the apply (defensive: if delete-batch
     *                refuses or partially fails, the apply still proceeds
     *                so the user gets some progress)
     *   - cancel   → bail completely; no apply, no delete
     */
    async function _applyAll(legs, opts) {
        const list = Array.isArray(legs) ? legs : []
        if (!list.length) return
        const ctxR = _ctx()
        const payload = {
            ctx:       {server: ctxR.server || "", aircraftId: ctxR.aircraftId || "",
                        currentLocationIata: ctxR.currentLocationIata || ""},
            legs:      list,
            requestedAt: Date.now(),
            source:    (opts && opts.source) || "preview-panel"
        }
        if (window.AesAfp && AesAfp.bus) {
            try { AesAfp.bus.emit("auto-apply:requested", payload) }
            catch (_) { /* bus self-isolates */ }
        }

        // Slice 6d — locked-leg pre-flight. Cheap synchronous detection on
        // proposed legs runs unconditionally; the schedule-diff comparison
        // (more expensive, requires the VFP reader) runs only if the AFP
        // page has it loaded. When the modal isn't loaded (manifest order
        // regression on a non-AFP page), fall through to the legacy path
        // so the apply still works.
        let diffResult = null
        try {
            if (typeof window.AesAfpScheduleDiff !== "undefined"
                    && window.AesAfp && typeof window.AesAfp.getCurrentSchedule === "function") {
                const currentLegs = window.AesAfp.getCurrentSchedule() || []
                if (Array.isArray(currentLegs) && currentLegs.length) {
                    diffResult = window.AesAfpScheduleDiff.compare(currentLegs, list)
                }
            }
        } catch (e) {
            console.warn("[AES auto-6d] schedule-diff for locked-confirm failed", e)
        }

        const lockedSurface = (typeof window.AesAfpLockedConfirmModal !== "undefined"
                && typeof window.AesAfpLockedConfirmModal.detect === "function")
            ? window.AesAfpLockedConfirmModal.detect({legs: list, diffResult: diffResult})
            : null

        if (lockedSurface) {
            let choice
            try {
                const r = await window.AesAfpLockedConfirmModal.open({
                    proposedLockedLegs: lockedSurface.proposedLockedLegs,
                    currentLockedStays: lockedSurface.currentLockedStays,
                    aircraftId:         payload.ctx.aircraftId,
                    hub:                payload.ctx.currentLocationIata,
                    allowOverride:      lockedSurface.currentLockedStays.length > 0
                })
                choice = r && r.choice
            } catch (e) {
                console.warn("[AES auto-6d] locked-confirm modal threw; treating as cancel", e)
                _toast("Locked-leg confirmation threw — apply cancelled.", "error")
                return
            }
            if (choice === "cancel") {
                _toast("Apply cancelled (locked-leg confirmation).", "info")
                return
            }
            if (choice === "override" && lockedSurface.currentLockedStays.length) {
                await _runOverrideDelete(lockedSurface.currentLockedStays, payload.ctx)
            }
        }

        const batch = window.AesAfpAutoApplyBatch
        if (batch && typeof batch.start === "function") {
            try { batch.start(payload) }
            catch (e) {
                console.warn("[AES auto-5b] apply-batch start threw", e)
                _toast("Apply-batch pipeline threw: " + ((e && e.message) || e), "error")
            }
            return
        }
        // Slice 5c hasn't shipped — surface the dormant state so the user
        // doesn't think the click silently failed.
        _toast("Apply-batch pipeline not loaded yet (slice 5c).", "warn")
    }

    /**
     * Slice 6d "override" path — fire a delete-batch for the current
     * locked legs before continuing with the apply. Best-effort: AS may
     * refuse to delete its own locked legs; per-leg errors land in the
     * audit log via the flight-deleter pipeline. We always proceed to the
     * apply step regardless, so the user gets the value of their other
     * proposed legs even when the override partially fails.
     */
    async function _runOverrideDelete(lockedLegs, ctx) {
        const flights = (lockedLegs || [])
            .filter(l => l && l.flightId != null)
            .map(l => ({
                flightId:   String(l.flightId),
                origin:     l.origin || "",
                destination: l.destination || "",
                depTime:    l.depTimeLocal || "",
                seq:        l.seq != null ? l.seq : null
            }))
        if (!flights.length) {
            _toast("Override skipped — no deletable flightIds on the locked legs.", "warn")
            return
        }
        const deleter = window.AesAfpAutoFlightDeleter
        if (!deleter || typeof deleter.start !== "function") {
            _toast("Delete-batch pipeline not loaded; skipping override.", "warn")
            return
        }
        try {
            await deleter.start({
                ctx:    {server: ctx.server, aircraftId: ctx.aircraftId,
                         currentLocationIata: ctx.currentLocationIata},
                flights: flights,
                source: "locked-confirm-override"
            })
        } catch (e) {
            console.warn("[AES auto-6d] override delete-batch threw", e)
            _toast("Override delete-batch threw — continuing with apply.", "warn")
        }
    }

    function _toast(msg, kind) {
        if (typeof RouteAssistantToast === "undefined") {
            console.warn("[AES auto-5b]", kind || "info", msg)
            return
        }
        try {
            const fn = (kind === "error") ? RouteAssistantToast.error
                     : (kind === "warn")  ? RouteAssistantToast.warn
                     : (kind === "success") ? RouteAssistantToast.success
                     :                        RouteAssistantToast.info
            if (typeof fn === "function") fn.call(RouteAssistantToast, msg)
            else if (typeof RouteAssistantToast.info === "function")
                RouteAssistantToast.info(msg)
        } catch (_) { /* never let toast break the panel */ }
    }

    function _fmtDuration(seconds) {
        const s = Math.max(0, Math.round(Number(seconds) || 0))
        if (s < 60) return s + "s"
        const m = Math.floor(s / 60)
        const rem = s % 60
        if (m < 60) {
            return rem ? (m + "m" + String(rem).padStart(2, "0") + "s")
                       : (m + "m")
        }
        const h = Math.floor(m / 60)
        const mm = m % 60
        return mm ? (h + "h" + String(mm).padStart(2, "0") + "m") : (h + "h")
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
            const scheduleInputs = await _scheduleDerivedInputs(ctxR.server, ctxR.aircraftId)
            const build = await AesAfpAutoScheduler.run({
                aircraftId:              ctxR.aircraftId,
                spec:                    _state.spec || undefined,
                persist:                 true,
                maintenanceWindows:      scheduleInputs.maintenanceWindows,
                perStationTurnaroundMin: scheduleInputs.perStationTurnaroundMin
            })
            _state.lastBuild = build || null
            // Re-pull the draft so per-leg edits show against the new flights.
            await Promise.all([_loadDraft(), _loadBudget()])
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

    /** Track 7d — derive `maintenanceWindows` + `perStationTurnaroundMin`
     *  from the cached Schedule so the allocator can pre-seed real
     *  maintenance bars and use observed station turnarounds.
     *  Returns `{maintenanceWindows: [], perStationTurnaroundMin: {}}`
     *  when the schedule is missing/stale — allocator treats both as
     *  empty and falls back to preset behaviour. */
    async function _scheduleDerivedInputs(server, aircraftId) {
        const empty = {maintenanceWindows: [], perStationTurnaroundMin: {}}
        if (!server || !aircraftId) return empty
        if (typeof AesAfpScheduleStore === "undefined") return empty
        let schedule = null
        try { schedule = await AesAfpScheduleStore.load(server, aircraftId) }
        catch (e) { console.warn("[AES auto-7d] schedule load failed", e); return empty }
        if (!schedule) return empty

        const maintenanceWindows = []
        const days = Array.isArray(schedule.days) ? schedule.days : []
        for (const day of days) {
            const blocks = (day && Array.isArray(day.blocks)) ? day.blocks : []
            for (const b of blocks) {
                if (!b || b.kind !== "maintenance") continue
                if (!Number.isInteger(b.dayIdx)) continue
                const sm = Number(b.startMin)
                const em = Number(b.endMin)
                if (!isFinite(sm) || !isFinite(em) || em <= sm) continue
                maintenanceWindows.push({dayIdx: b.dayIdx, startMin: sm, endMin: em})
            }
        }

        // Per-station turnaround: collect every observation of ground time
        // at each IATA — `turnaroundAfterMin` (after landing at destination)
        // and `turnaroundBeforeMin` (before departing from origin) — then
        // take the median. Median resists the occasional ULB-padded outlier.
        const samples = {}   // iata -> number[]
        const legs = Array.isArray(schedule.legs) ? schedule.legs : []
        for (const L of legs) {
            if (!L) continue
            const dest = String(L.destination || "").toUpperCase()
            const orig = String(L.origin || "").toUpperCase()
            const after  = Number(L.turnaroundAfterMin)
            const before = Number(L.turnaroundBeforeMin)
            if (dest && isFinite(after) && after > 0) {
                (samples[dest] = samples[dest] || []).push(after)
            }
            if (orig && isFinite(before) && before > 0) {
                (samples[orig] = samples[orig] || []).push(before)
            }
        }
        const perStationTurnaroundMin = {}
        for (const iata of Object.keys(samples)) {
            const arr = samples[iata].slice().sort((a, b) => a - b)
            const mid = Math.floor(arr.length / 2)
            const median = (arr.length % 2 === 1) ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
            perStationTurnaroundMin[iata] = Math.round(median)
        }

        return {maintenanceWindows, perStationTurnaroundMin}
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
        Promise.all([_loadSettings(), _loadDraft(), _loadBudget(), _loadRetryQueue()]).then(() => {
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
        // Track 7 slice 7e — schedule edits change reserved-maintenance hours,
        // so the wear ceiling shifts; reload the budget to repaint Weekly cell.
        bus.on("schedule:updated",    () => _loadBudget().then(_scheduleRender))
        // Slice 5d — apply-batch lifecycle.
        bus.on("auto-apply:start",    _onApplyStart)
        bus.on("auto-apply:progress", _onApplyProgress)
        bus.on("auto-apply:done",     _onApplyDone)
        bus.on("auto-apply:aborted",  _onApplyAborted)
        bus.on("auto-apply:error",    _onApplyError)
        // Slice 8a — fleet-apply orchestrator lifecycle.
        bus.on("fleet-apply:start",          _onFleetApplyStart)
        bus.on("fleet-apply:aircraft-start", _onFleetApplyAircraftStart)
        bus.on("fleet-apply:aircraft-done",  _onFleetApplyAircraftDone)
        bus.on("fleet-apply:done",           _onFleetApplyDone)
        bus.on("fleet-apply:aborted",        _onFleetApplyAborted)
    }

    // ── Slice 8a — fleet-apply orchestrator handlers + renderers ─────

    function _onFleetApplyStart(p) {
        const f = _state.fleetApply
        f.inFlight        = true
        f.runId           = (p && p.runId) || null
        f.total           = (p && Number(p.total)) || 0
        f.idx             = 0
        f.currentAircraft = null
        f.startedAt       = Date.now()
        f.finishedAt      = null
        f.aborted         = false
        f.perAircraft     = []
        _renderFooter()
    }
    function _onFleetApplyAircraftStart(p) {
        const f = _state.fleetApply
        if (!p || (f.runId && p.runId && p.runId !== f.runId)) return
        f.idx             = (typeof p.idx === "number") ? p.idx : f.idx
        f.currentAircraft = p.aircraftId || null
        _renderFooter()
    }
    function _onFleetApplyAircraftDone(p) {
        const f = _state.fleetApply
        if (!p || (f.runId && p.runId && p.runId !== f.runId)) return
        f.perAircraft.push({
            aircraftId: p.aircraftId,
            ok:         !!p.ok,
            succeeded:  Number(p.succeeded) || 0,
            failed:     Number(p.failed)    || 0,
            error:      p.error || null
        })
        _renderFooter()
    }
    function _onFleetApplyDone(p) {
        const f = _state.fleetApply
        if (!p || (f.runId && p.runId && p.runId !== f.runId)) return
        f.inFlight    = false
        f.finishedAt  = Date.now()
        f.aborted     = false
        if (p.perAircraft) f.perAircraft = p.perAircraft.slice()
        _renderFooter()
    }
    function _onFleetApplyAborted(p) {
        const f = _state.fleetApply
        if (!p || (f.runId && p.runId && p.runId !== f.runId)) return
        f.inFlight    = false
        f.finishedAt  = Date.now()
        f.aborted     = true
        _renderFooter()
    }

    function _renderFleetApplyProgress() {
        const f = _state.fleetApply
        const wrap = document.createElement("div")
        wrap.className = "aes-afp-fleet-apply-progress"
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;"
            + "padding:6px 8px;background:rgba(124,45,18,0.12);"
            + "border:1px solid rgba(154,52,18,0.55);border-radius:3px;"
        const head = document.createElement("div")
        head.style.cssText = "font-size:11px;font-weight:600;color:#fdba74;"
            + "display:flex;align-items:center;gap:8px;"
        const title = document.createElement("span")
        title.textContent = "Fleet apply — aircraft "
            + ((f.idx | 0) + 1) + " of " + (f.total | 0)
            + (f.currentAircraft ? " (" + f.currentAircraft + ")" : "")
        head.appendChild(title)
        const abortBtn = document.createElement("button")
        abortBtn.type = "button"
        abortBtn.textContent = "Abort"
        abortBtn.style.cssText = "background:transparent;color:#f87171;"
            + "border:1px solid #b91c1c;border-radius:3px;padding:1px 7px;"
            + "font-size:10px;cursor:pointer;"
        abortBtn.addEventListener("click", () => {
            if (typeof window.AesAfpFleetApplyOrchestrator !== "undefined"
                    && typeof window.AesAfpFleetApplyOrchestrator.abort === "function") {
                window.AesAfpFleetApplyOrchestrator.abort()
            }
        })
        head.appendChild(abortBtn)
        wrap.appendChild(head)

        // Per-aircraft mini-results so far.
        if (f.perAircraft.length) {
            const list = document.createElement("div")
            list.style.cssText = "font-size:10px;color:#cbd5e1;font-family:monospace;"
            for (const r of f.perAircraft.slice(-5)) {
                const line = document.createElement("div")
                line.textContent = (r.ok ? "✓ " : "✗ ") + r.aircraftId
                    + " — " + (r.succeeded || 0) + "/" + ((r.succeeded || 0) + (r.failed || 0))
                    + (r.error ? " · " + r.error : "")
                line.style.color = r.ok ? "#10b981" : "#f87171"
                list.appendChild(line)
            }
            wrap.appendChild(list)
        }
        return wrap
    }

    function _renderFleetApplyResultBanner() {
        const f = _state.fleetApply
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:6px 8px;border-radius:3px;font-size:11px;"
            + "display:flex;align-items:center;gap:10px;"
        const totalSucc = f.perAircraft.reduce((s, r) => s + (r.succeeded || 0), 0)
        const totalFail = f.perAircraft.reduce((s, r) => s + (r.failed    || 0), 0)
        const allOk = totalFail === 0 && !f.aborted
        wrap.style.background = allOk
            ? "rgba(16,185,129,0.10)"
            : "rgba(239,68,68,0.10)"
        wrap.style.border = "1px solid " + (allOk ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.40)")
        wrap.style.color = allOk ? "#34d399" : "#fca5a5"
        const text = document.createElement("span")
        text.style.flex = "1 1 auto"
        text.textContent = "Fleet apply " + (f.aborted ? "aborted" : "done")
            + " — " + totalSucc + " ok / " + totalFail + " failed"
            + " across " + f.perAircraft.length + " aircraft"
        wrap.appendChild(text)
        const dismiss = document.createElement("button")
        dismiss.type = "button"
        dismiss.textContent = "Dismiss"
        dismiss.style.cssText = "background:transparent;color:inherit;"
            + "border:1px solid currentColor;border-radius:3px;padding:1px 7px;"
            + "font-size:10px;cursor:pointer;opacity:0.7;"
        dismiss.addEventListener("click", () => {
            _state.fleetApply.finishedAt  = null
            _state.fleetApply.perAircraft = []
            _renderFooter()
        })
        wrap.appendChild(dismiss)
        return wrap
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
