"use strict"

/**
 * Aircraft Flight Plan Assistant — Slice E (wave-aware applier).
 *
 * Renders into AesAfp.slot("wave") on the per-aircraft Flight Plan page
 * (`/app/fleets/aircraft/<id>/0`). Wraps RouteAssistantWaveOverlay so the
 * sidebar can produce a multi-wave plan from Slice C's scored candidates ×
 * a saved schedule preset, then surface each placed flight as a per-leg
 * "Apply" row that delegates to Slice D's form-driver via the bus.
 *
 * Slice E is a renderer + thin wrapper — it does not POST, persist, or
 * touch any other slot. The user always clicks AS's own green Submit
 * button. See HANDOVER §10 ("Slice D never calls submit programmatically").
 *
 * Public API:
 *   AesAfpWaveApplier.buildFromCandidates({preset, candidates, ctx, spec}) -> Build
 *   AesAfpWaveApplier.renderPreview(host, build) -> void
 *   AesAfpWaveApplier.applyLeg(flight) -> void
 *   AesAfpWaveApplier.last -> Build | null   (diagnostic accessor)
 *
 * Bus contract:
 *   in:  ctx:ready, spec:resolved, candidates:updated
 *   out: wave:built {build}, candidate:selected {candidate, source: "wave-leg"}
 *
 * Reuses (read-only):
 *   RouteAssistantWaveOverlay.buildSchedule / .renderGantt — wave pipeline
 *   SchedulePresets.load — same preset list the dashboard panel manages
 *   ScheduleBuilder + ScheduleFactors — invoked transitively by buildSchedule
 *   RouteAssistantToast (defensive) — "Wave plan generated", "Leg applied"
 */
;(function () {
    if (window.AesAfpWaveApplier) return

    const TOP_N = 20
    const KM_PER_NM = 1.852

    const _state = {
        ctxReady:        false,
        spec:            null,    // last spec from spec:resolved (may be null)
        candidates:      null,    // last candidates from candidates:updated
        presets:         [],
        defaultPresetId: null,
        selectedPresetId: null,
        presetsLoaded:   false,
        presetsError:    null,
        lastBuild:       null,
        buildStale:      false,
        // Phase-4: when true, only presets whose preset.hub matches the
        // aircraft's current location IATA are listed in the picker.
        // Toggle off to access cross-hub presets (e.g. ferry flights).
        hubFilterEnabled: true,
        draft:           null,   // last AesAfpActiveDraftStore record (for apply/dismiss/edit overlay)
        draftListener:   null,   // chrome.storage listener for draft key
        draftReloadTimer: null
    }

    let _toolbarEl = null
    let _statusEl  = null
    let _buildEl   = null

    // ── Public API ─────────────────────────────────────────────────────

    /**
     * Map candidates → wave-overlay scoredRow shape and run the build.
     * Slice C's Candidate already carries `destIata`, `distanceKm`, and
     * `aircraftFit` ("optimal"|"falloff"|"oor"|null), so the mapping is a
     * defensive pass-through (the wave-overlay's buildRoutesFromScoredRows
     * only reads those three fields, but we forward the rest for tooltip
     * enrichment via its `_scoredRow` back-reference).
     */
    function buildFromCandidates(opts) {
        const o = opts || {}
        const preset = o.preset || null
        const candidates = Array.isArray(o.candidates) ? o.candidates : []
        const ctx = o.ctx || (window.AesAfp && AesAfp.ctx) || {}
        const spec = o.spec
            || (window.AesAfpSpecResolver && AesAfpSpecResolver.last)
            || null

        if (typeof RouteAssistantWaveOverlay === "undefined") {
            return _emptyBuildWith("RouteAssistantWaveOverlay not loaded — manifest order?", preset)
        }

        const scoredRows = candidates.map(_candidateToScoredRow)
        const buildCtx = {
            server:            ctx.server || "",
            airlineCode:       ctx.airlineCode || ctx.airlineId || "",
            hubIata:           String(ctx.currentLocationIata || "").toUpperCase(),
            selectedSpec:      spec,
            topN:              TOP_N,
            carrierClassifier: null
        }
        return RouteAssistantWaveOverlay.buildSchedule(preset, scoredRows, buildCtx)
    }

    /**
     * Render a wave Build into the host. Delegates the Gantt visual to
     * RouteAssistantWaveOverlay.renderGantt (which clears the host); we
     * wrap it in our own div so we can append the per-leg apply list
     * underneath without the renderer wiping it.
     */
    function renderPreview(host, build) {
        if (!host) return
        host.innerHTML = ""
        if (!build) { _renderEmpty(host, "No build to preview."); return }
        if (Array.isArray(build.validation) && build.validation.length) {
            _renderValidationErrors(host, build); return
        }
        if (typeof RouteAssistantWaveOverlay === "undefined") {
            _renderEmpty(host, "Wave overlay not loaded."); return
        }

        // Result-section header so the rendered Gantt has an obvious anchor
        // (users had no visual cue that the Generate button's output landed
        // here). Counts come from the build itself; falls back gracefully
        // when fields are missing.
        const flightCount = (build.flights || []).length
        const waveCount   = new Set((build.flights || [])
            .map(f => f && f.waveId).filter(v => v != null)).size
        const presetName  = (build.preset && build.preset.name) || "(unnamed preset)"
        const headerEl = document.createElement("div")
        headerEl.style.cssText = "font-size:11px;font-weight:600;color:#cbd5e1;"
            + "padding:4px 6px;margin-bottom:4px;"
            + "background:#0f1623;border-left:3px solid #1d4ed8;border-radius:2px;"
        headerEl.textContent = "Generated wave plan — " + presetName
            + " · " + flightCount + " flight" + (flightCount === 1 ? "" : "s")
            + (waveCount ? " · " + waveCount + " wave" + (waveCount === 1 ? "" : "s") : "")
        host.appendChild(headerEl)

        const ganttHost = document.createElement("div")
        ganttHost.className = "aes-afp-wave-gantt"
        host.appendChild(ganttHost)

        const hubIata = String(
            (window.AesAfp && AesAfp.ctx && AesAfp.ctx.currentLocationIata) || ""
        ).toUpperCase()

        try {
            RouteAssistantWaveOverlay.renderGantt(ganttHost, build, {
                hubIata,
                onFlightClick: (flight) => applyLeg(flight)
            })
        } catch (e) {
            console.warn("[AFP-E] renderGantt threw", e)
            _renderEmpty(ganttHost, "Gantt render failed: " + ((e && e.message) || e))
        }

        const flights = (build.flights) || []
        if (!flights.length) {
            const note = document.createElement("div")
            note.style.cssText = "margin-top:6px;font-size:11px;color:#9ca3af;font-style:italic;"
            note.textContent = "No flights placed — see warnings/shortfall above."
            host.appendChild(note)
            return
        }

        const legsHost = document.createElement("div")
        legsHost.className = "aes-afp-wave-legs"
        legsHost.style.cssText = "margin-top:10px;padding-top:8px;border-top:1px solid #1f2937;"
        _renderLegList(legsHost, build)
        host.appendChild(legsHost)
    }

    /**
     * Pre-fill the New Flight Number form for one leg by emitting
     * candidate:selected on the bus. Slice D's stock subscriber maps that
     * to AesAfpFormDriver.fill({destination: candidate.destIata}); the
     * `__wave` hint bag attached here lets a future Slice D enhancement
     * also pull origin / depTime when source === "wave-leg".
     */
    function applyLeg(flight) {
        if (!flight) return
        const candidate = _flightToCandidate(flight)
        if (window.AesAfp && AesAfp.bus) {
            try { AesAfp.bus.emit("candidate:selected", {candidate, source: "wave-leg"}) }
            catch (e) { console.warn("[AFP-E] bus emit failed", e) }
        }
        if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.info) {
            const arrow = (flight.direction === "inbound") ? "←" : "→"
            const msg = "Leg applied: " + (flight.origin || "?")
                + " " + arrow + " " + (flight.destination || "?")
                + (flight.depTimeLocal ? " · " + flight.depTimeLocal : "")
            try { RouteAssistantToast.info(msg) } catch (_) { /* non-fatal */ }
        }
        // Mirror the apply into the per-aircraft draft so the Fleet Hub
        // overlay's leg-list shows this leg as applied. We don't auto-submit
        // here — the AFP page's user clicks AS's green Submit themselves.
        _markLegAppliedInDraft(flight && flight.seq)
    }

    function _dismissLeg(flight) {
        if (!flight || flight.seq == null) return
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        if (!ctx.server || !ctx.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        AesAfpActiveDraftStore.setDismissed(ctx.server, ctx.aircraftId, flight.seq, Date.now())
            .catch(err => console.warn("[AFP-E] dismiss persist failed", err))
    }

    // ── Render lifecycle ───────────────────────────────────────────────

    function _renderRoot() {
        const slot = (window.AesAfp && AesAfp.slot) ? AesAfp.slot("wave") : null
        if (!slot) return
        slot.innerHTML = ""

        const root = document.createElement("div")
        root.className = "aes-afp-wave-root"
        root.style.cssText = "margin-top:10px;padding-top:8px;border-top:1px solid #1f2937;"

        // Section title + one-line help so users understand what the
        // preset/Generate flow does without having to dig into the manual.
        const sectionHead = document.createElement("div")
        sectionHead.style.cssText = "display:flex;align-items:baseline;gap:8px;margin-bottom:2px;"
        const sectionTitle = document.createElement("span")
        sectionTitle.textContent = "Wave plan"
        sectionTitle.style.cssText = "font-weight:600;color:#cbd5e1;font-size:11px;"
        sectionHead.appendChild(sectionTitle)
        const help = document.createElement("span")
        help.style.cssText = "font-size:10px;color:#6b7280;line-height:1.4;"
        help.appendChild(document.createTextNode(
            "Build a multi-leg schedule from the candidates above × a saved preset. "
        ))
        const presetsLink = document.createElement("a")
        presetsLink.href = "/app/com/scheduling"
        presetsLink.target = "_blank"
        presetsLink.rel = "noopener"
        presetsLink.textContent = "Manage presets"
        presetsLink.style.cssText = "color:#60a5fa;text-decoration:underline;"
        help.appendChild(presetsLink)
        help.appendChild(document.createTextNode("."))
        sectionHead.appendChild(help)
        root.appendChild(sectionHead)

        _toolbarEl = document.createElement("div")
        _toolbarEl.className = "aes-afp-wave-toolbar"
        _toolbarEl.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;"
            + "font-size:11px;color:#cbd5e1;"
        root.appendChild(_toolbarEl)

        _statusEl = document.createElement("div")
        _statusEl.className = "aes-afp-wave-status"
        _statusEl.style.cssText = "font-size:11px;color:#9ca3af;margin-top:4px;"
        root.appendChild(_statusEl)

        _buildEl = document.createElement("div")
        _buildEl.className = "aes-afp-wave-build"
        _buildEl.style.cssText = "margin-top:8px;"
        root.appendChild(_buildEl)

        slot.appendChild(root)

        _renderToolbar()
        _renderStatus()
        // Re-mount path: if we already have a build, re-render it into the
        // newly-acquired _buildEl so the user's Gantt survives Wicket's
        // sidebar re-render. Otherwise show the placeholder so the area
        // explains what would land here.
        if (_state.lastBuild) renderPreview(_buildEl, _state.lastBuild)
        else _renderBuildPlaceholder(_buildEl)
    }

    /** Placeholder shown in _buildEl before the user runs Generate, so the
     *  area isn't a confusing empty void below the toolbar. */
    function _renderBuildPlaceholder(host) {
        if (!host) return
        host.innerHTML = ""
        const ph = document.createElement("div")
        ph.style.cssText = "padding:10px;border:1px dashed #374151;border-radius:4px;"
            + "color:#9ca3af;font-size:11px;font-style:italic;text-align:center;"
        ph.textContent = "No wave plan yet. Pick a preset above and click Generate."
        host.appendChild(ph)
    }

    function _renderToolbar() {
        if (!_toolbarEl) return
        _toolbarEl.innerHTML = ""

        const label = document.createElement("span")
        label.textContent = "Preset:"
        label.style.color = "#9ca3af"
        _toolbarEl.appendChild(label)

        const sel = document.createElement("select")
        sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 4px;font-size:11px;flex:1 1 auto;min-width:120px;"

        const hub = String((window.AesAfp && AesAfp.ctx && AesAfp.ctx.currentLocationIata) || "").toUpperCase()
        const visible = _visiblePresets(hub)

        if (!_state.presetsLoaded) {
            sel.appendChild(_opt("", "Loading…")); sel.disabled = true
        } else if (_state.presetsError) {
            sel.appendChild(_opt("", "(presets failed to load)")); sel.disabled = true
        } else if (!visible.length) {
            const noteText = (_state.hubFilterEnabled && hub && _state.presets.length)
                ? "(no presets for " + hub + ")"
                : "(no presets — create on dashboard)"
            sel.appendChild(_opt("", noteText)); sel.disabled = true
        } else {
            for (const p of visible) {
                // Track 4 slice 4e — hide transient slot-optimizer scratch
                // presets (created by SlotOptimizer.selectBest, removed in
                // finally). Visible only in the brief race-window between
                // create and remove; this filter makes orphans invisible.
                if (p.name && p.name.indexOf("__aes-auto-tmp-") === 0) continue
                const tweakedGlyph = p.tweakedFrom ? "🔧 " : ""
                const o = _opt(p.id, tweakedGlyph + (p.name || "(unnamed)") + (p.hub ? " · " + p.hub : ""))
                if (_state.selectedPresetId && p.id === _state.selectedPresetId) o.selected = true
                sel.appendChild(o)
            }
        }
        sel.addEventListener("change", () => {
            _state.selectedPresetId = sel.value || null
            _markBuildStale()
            _renderToolbar()
            _renderStatus()
            _persistPresetToDraft(_state.selectedPresetId)
        })
        _toolbarEl.appendChild(sel)

        if (_state.presetsLoaded && _state.presets.length && hub) {
            const hubLbl = document.createElement("label")
            hubLbl.style.cssText = "display:inline-flex;align-items:center;gap:3px;color:#9ca3af;cursor:pointer;"
            hubLbl.title = "Restrict the preset list to ones whose hub matches " + hub + "."
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = _state.hubFilterEnabled
            cb.style.cssText = "margin:0;"
            cb.addEventListener("change", () => {
                _state.hubFilterEnabled = cb.checked
                if (_state.selectedPresetId
                    && !_visiblePresets(hub).some(p => p.id === _state.selectedPresetId)) {
                    _state.selectedPresetId = _resolveInitialPresetId()
                    _markBuildStale()
                }
                _renderToolbar()
                _renderStatus()
            })
            const cbTxt = document.createElement("span")
            cbTxt.textContent = hub + " only"
            hubLbl.appendChild(cb)
            hubLbl.appendChild(cbTxt)
            _toolbarEl.appendChild(hubLbl)
        }

        if (_state.presetsLoaded && hub && !visible.length) {
            const newBtn = document.createElement("button")
            newBtn.type = "button"
            newBtn.textContent = "+ New for " + hub
            newBtn.title = "Create a starter preset hosted at " + hub
                + " and open the dashboard for further editing."
            newBtn.style.cssText = "background:#0f1623;color:#cbd5e1;border:1px solid #374151;"
                + "border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;"
            newBtn.addEventListener("click", () => _onCreatePresetForHub(hub))
            _toolbarEl.appendChild(newBtn)
        }

        const enabled = _generateEnabled()
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = _state.lastBuild ? "Regenerate" : "Generate wave plan"
        btn.disabled = !enabled
        btn.style.cssText = "background:" + (enabled ? "#1d4ed8" : "#374151") + ";"
            + "color:" + (enabled ? "#f8fafc" : "#9ca3af") + ";"
            + "border:1px solid " + (enabled ? "#1e3a8a" : "#374151") + ";"
            + "border-radius:3px;padding:3px 9px;font-size:11px;font-weight:600;"
            + "cursor:" + (enabled ? "pointer" : "not-allowed") + ";"
        btn.title = _generateBlockedReason()
            || "Build a wave plan from the current candidates and preset."
        btn.addEventListener("click", () => { if (_generateEnabled()) _onGenerate() })
        _toolbarEl.appendChild(btn)

        // Slice 8a — Fleet apply CTA. Visible only when a build exists +
        // both fleet modules loaded. Disabled when the build is stale or
        // empty so the user doesn't dispatch an obviously broken payload.
        if (typeof window.AesAfpFleetPickerModal !== "undefined"
                && typeof window.AesAfpFleetApplyOrchestrator !== "undefined") {
            const flightCount = _state.lastBuild
                && Array.isArray(_state.lastBuild.flights)
                ? _state.lastBuild.flights.length : 0
            const fleetEnabled = !!_state.lastBuild && flightCount > 0 && !_state.buildStale
            const fleetBtn = document.createElement("button")
            fleetBtn.type = "button"
            fleetBtn.textContent = "Apply to fleet…"
            fleetBtn.disabled = !fleetEnabled
            fleetBtn.style.cssText = "background:" + (fleetEnabled ? "#7c2d12" : "#374151") + ";"
                + "color:" + (fleetEnabled ? "#fed7aa" : "#9ca3af") + ";"
                + "border:1px solid " + (fleetEnabled ? "#9a3412" : "#374151") + ";"
                + "border-radius:3px;padding:3px 9px;font-size:11px;font-weight:600;"
                + "cursor:" + (fleetEnabled ? "pointer" : "not-allowed") + ";"
            fleetBtn.title = !_state.lastBuild
                ? "Generate a wave plan first."
                : _state.buildStale
                    ? "Wave plan is stale — regenerate before fleet apply."
                    : flightCount + " leg(s) will fan out to every selected aircraft."
            fleetBtn.addEventListener("click", () => {
                if (fleetEnabled) _onApplyToFleet()
            })
            _toolbarEl.appendChild(fleetBtn)
        }
    }

    /**
     * Slice 8a — open the fleet picker, then orchestrate per-aircraft
     * apply across the picked aircraft using the current build's flights.
     *
     * Same legs go to every aircraft (the picker's range-fit filter
     * keeps only fit-eligible aircraft visible). The orchestrator owns
     * the serial loop + audit logging; this function just plumbs the
     * picker → orchestrator handoff and surfaces a tiny progress toast.
     */
    async function _onApplyToFleet() {
        if (!_state.lastBuild) return
        const flights = (_state.lastBuild.flights) || []
        if (!flights.length) return
        const preset = _state.lastBuild.preset
            || (_state.presets || []).find(p => p && p.id === _state.selectedPresetId)
            || null
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        const hub = String(ctx.currentLocationIata || "").toUpperCase()

        let pick
        try {
            pick = await window.AesAfpFleetPickerModal.open({
                preset:        preset,
                hub:           hub,
                title:         "Apply wave plan to fleet",
                server:        ctx.server || "",
                airlineCode:   ctx.airlineCode || ""
            })
        } catch (e) {
            console.warn("[AFP-8a] fleet picker threw", e)
            if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.error) {
                RouteAssistantToast.error("Fleet picker failed: " + ((e && e.message) || e))
            }
            return
        }
        if (!pick || pick.cancelled || !pick.aircraftIds || !pick.aircraftIds.length) return

        const runs = pick.aircraftIds.map(aircraftId => ({
            aircraftId: aircraftId,
            legs:       flights.slice(),
            hub:        hub
        }))
        if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.info) {
            try { RouteAssistantToast.info("Fleet apply: " + runs.length + " aircraft × "
                + flights.length + " legs queued.") } catch (_) { /* noop */ }
        }
        try {
            const result = await window.AesAfpFleetApplyOrchestrator.start({
                runs:   runs,
                ctx:    {server: ctx.server || ""},
                source: "wave-applier-fleet"
            })
            if (typeof RouteAssistantToast !== "undefined") {
                const tone = result.aborted ? "warn" : (result.totalFailed ? "warn" : "success")
                const fn = (tone === "warn") ? RouteAssistantToast.warn : RouteAssistantToast.success
                if (typeof fn === "function") {
                    fn.call(RouteAssistantToast, "Fleet apply " + (result.aborted ? "aborted" : "done")
                        + " — " + (result.totalSucceeded || 0) + " ok / "
                        + (result.totalFailed || 0) + " failed across " + runs.length + " aircraft.")
                }
            }
        } catch (e) {
            console.warn("[AFP-8a] fleet orchestrator threw", e)
            if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.error) {
                RouteAssistantToast.error("Fleet apply threw: " + ((e && e.message) || e))
            }
        }
    }

    function _renderStatus() {
        if (!_statusEl) return
        const msg = _statusMessage()
        if (!msg) {
            _statusEl.style.display = "none"
            _statusEl.textContent = ""
            return
        }
        _statusEl.style.display = ""
        if (msg.html) _statusEl.innerHTML = msg.html
        else _statusEl.textContent = msg.text
        _statusEl.style.color = (msg.tone === "warn")  ? "#fbbf24"
                              : (msg.tone === "error") ? "#fca5a5"
                              : "#9ca3af"
    }

    function _statusMessage() {
        if (!_state.presetsLoaded)
            return {text: "Loading wave presets…", tone: "info"}
        if (_state.presetsError)
            return {text: "Could not load presets: " + _state.presetsError, tone: "error"}
        if (!_state.presets.length) {
            return {
                html: 'No wave presets found. Create one on the AES dashboard → '
                    + '<a href="/app/enterprise/dashboard" target="_blank" rel="noopener" '
                    + 'style="color:#60a5fa;">Schedule Management</a>.',
                tone: "warn"
            }
        }
        if (!_state.spec)
            return {text: "Waiting for aircraft spec…", tone: "info"}
        if (!_state.candidates || !_state.candidates.length)
            return {text: "Waiting for route candidates…", tone: "info"}
        if (!_state.selectedPresetId)
            return {text: "Pick a preset to enable Generate.", tone: "info"}
        if (_state.buildStale && _state.lastBuild)
            return {text: "Underlying data changed — click Regenerate to refresh.", tone: "warn"}
        return null
    }

    function _generateEnabled() {
        return !!(_state.presetsLoaded
                  && _state.presets.length
                  && _state.selectedPresetId
                  && _state.spec
                  && _state.candidates && _state.candidates.length)
    }

    function _generateBlockedReason() {
        if (!_state.presetsLoaded)   return "Waiting for presets to load"
        if (_state.presetsError)     return "Presets failed to load"
        if (!_state.presets.length)  return "No presets configured"
        if (!_state.spec)            return "Waiting for aircraft spec (Slice B)"
        if (!_state.candidates || !_state.candidates.length)
                                     return "Waiting for route candidates (Slice C)"
        if (!_state.selectedPresetId) return "Pick a preset"
        return null
    }

    function _markBuildStale() {
        if (_state.lastBuild) _state.buildStale = true
    }

    // ── Generate handler ───────────────────────────────────────────────

    function _selectedPreset() {
        if (!_state.selectedPresetId) return null
        return _state.presets.find(p => p.id === _state.selectedPresetId) || null
    }

    function _onGenerate() {
        const preset = _selectedPreset()
        if (!preset) return
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        const build = buildFromCandidates({
            preset,
            candidates: _state.candidates,
            ctx,
            spec: _state.spec
        })
        _state.lastBuild = build
        _state.buildStale = false

        if (_buildEl) renderPreview(_buildEl, build)
        if (window.AesAfp && AesAfp.bus) {
            try { AesAfp.bus.emit("wave:built", {build}) }
            catch (e) { console.warn("[AFP-E] wave:built emit failed", e) }
        }
        _persistBuildToDraft(preset, build, ctx)
        _renderToolbar()  // swap "Generate" → "Regenerate"
        _renderStatus()

        if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.success) {
            const flightCount = (build.flights || []).length
            const waveCount = new Set((build.flights || []).map(f => f.waveId)).size
            const txt = flightCount
                ? "Wave plan generated: " + flightCount + " legs across " + waveCount + " waves"
                : "Wave plan generated — no flights placed (see warnings)"
            try { RouteAssistantToast.success(txt) } catch (_) { /* non-fatal */ }
        }
    }

    // ── Per-leg list ───────────────────────────────────────────────────

    function _renderLegList(host, build) {
        const flights = (build && build.flights) || []
        const byWave = new Map()
        for (const f of flights) {
            const key = f.waveId || "?"
            let arr = byWave.get(key)
            if (!arr) { arr = []; byWave.set(key, arr) }
            arr.push(f)
        }

        const hdr = document.createElement("div")
        hdr.style.cssText = "font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:4px;"
        hdr.textContent = "Per-leg apply (" + flights.length + "):"
        host.appendChild(hdr)

        for (const waveFlights of byWave.values()) {
            const wh = document.createElement("div")
            wh.style.cssText = "font-size:10px;font-weight:600;color:#cbd5e1;margin-top:6px;"
                + "text-transform:uppercase;letter-spacing:0.4px;"
            wh.textContent = waveFlights[0].waveLabel || waveFlights[0].waveId || "Wave"
            host.appendChild(wh)

            for (const f of waveFlights) host.appendChild(_renderLegRow(f, build))
        }
    }

    function _renderLegRow(f, build) {
        const row = document.createElement("div")
        const applied   = !!(_state.draft && _state.draft.appliedLegs   && _state.draft.appliedLegs[f.seq])
        const dismissed = !!(_state.draft && _state.draft.dismissedLegs && _state.draft.dismissedLegs[f.seq])
        const baseStyle = "display:flex;align-items:center;gap:5px;padding:3px 0;"
            + "font-size:11px;color:#cbd5e1;border-bottom:1px solid #0f172a;"
        row.style.cssText = baseStyle
            + (dismissed ? "opacity:0.45;"
                : applied ? "background:rgba(16,185,129,0.08);" : "")

        const inbound = (f.direction === "inbound")
        const arrow = inbound ? "←" : "→"
        const dirColor = inbound ? "#10b981" : "#3b82f6"

        const dir = document.createElement("span")
        dir.style.cssText = "color:" + dirColor + ";font-weight:600;width:34px;flex:0 0 auto;"
        dir.textContent = (f.direction || "").slice(0, 3)
        row.appendChild(dir)

        const od = document.createElement("span")
        od.style.cssText = "font-weight:600;color:#f8fafc;flex:1 1 auto;min-width:0;"
        od.textContent = (f.origin || "?") + " " + arrow + " " + (f.destination || "?")
        row.appendChild(od)

        const time = document.createElement("span")
        time.style.cssText = "color:#9ca3af;width:42px;flex:0 0 auto;text-align:right;"
            + "font-variant-numeric:tabular-nums;"
        time.textContent = f.depTimeLocal || "—"
        row.appendChild(time)

        const dist = document.createElement("span")
        dist.style.cssText = "color:#6b7280;width:50px;flex:0 0 auto;text-align:right;font-size:10px;"
        dist.textContent = f.distanceNm ? Math.round(f.distanceNm) + "nm" : "—"
        row.appendChild(dist)

        const bucket = _bucketLabel(f.rangeBucket)
        if (bucket) {
            const b = document.createElement("span")
            b.style.cssText = "color:#9ca3af;font-size:10px;width:30px;flex:0 0 auto;text-align:center;"
            b.textContent = bucket
            row.appendChild(b)
        }

        const warnings = ((build && build.warnings) || []).filter(w => w && w.seq === f.seq)
        if (warnings.length) {
            const wIcon = document.createElement("span")
            wIcon.title = warnings.map(x => x.message || x.type || "warning").join("\n")
            wIcon.textContent = "⚠"
            wIcon.style.cssText = "color:#fbbf24;font-size:11px;cursor:help;flex:0 0 auto;"
            row.appendChild(wIcon)
        }

        if (!dismissed) {
            const apply = document.createElement("button")
            apply.type = "button"
            apply.textContent = applied ? "Re-apply" : "Apply"
            apply.title = "Pre-fill the New Flight Number form for this leg (you click Submit)."
            apply.style.cssText = "background:#1d4ed8;color:#f8fafc;border:1px solid #1e3a8a;"
                + "border-radius:3px;padding:2px 6px;font-size:10px;font-weight:600;"
                + "cursor:pointer;flex:0 0 auto;"
            apply.addEventListener("click", () => applyLeg(f))
            row.appendChild(apply)
        }

        const dismissBtn = document.createElement("button")
        dismissBtn.type = "button"
        dismissBtn.textContent = dismissed ? "Restore" : "Dismiss"
        dismissBtn.title = dismissed
            ? "Restore this leg into the active draft."
            : "Mark this leg dismissed so the Fleet Hub overlay hides it from Apply."
        dismissBtn.style.cssText = "background:transparent;color:#9ca3af;"
            + "border:1px solid #374151;border-radius:3px;padding:2px 6px;"
            + "font-size:10px;cursor:pointer;flex:0 0 auto;"
        dismissBtn.addEventListener("click", () => {
            if (dismissed) {
                const ctx = (window.AesAfp && AesAfp.ctx) || {}
                if (ctx.server && ctx.aircraftId && typeof AesAfpActiveDraftStore !== "undefined") {
                    AesAfpActiveDraftStore.setDismissed(ctx.server, ctx.aircraftId, f.seq, null)
                        .catch(err => console.warn("[AFP-E] restore persist failed", err))
                }
            } else {
                _dismissLeg(f)
            }
        })
        row.appendChild(dismissBtn)

        return row
    }

    function _bucketLabel(bucket) {
        if (bucket === "shortHaul")  return "shrt"
        if (bucket === "mediumHaul") return "med"
        if (bucket === "longHaul")   return "long"
        return null
    }

    function _renderValidationErrors(host, build) {
        const box = document.createElement("div")
        box.style.cssText = "margin-top:6px;padding:6px;background:rgba(239,68,68,0.08);"
            + "border:1px solid rgba(239,68,68,0.40);border-radius:3px;color:#fca5a5;font-size:11px;"
        const h = document.createElement("strong")
        h.textContent = "Preset \"" + ((build.preset && build.preset.name) || "?")
            + "\" has issues:"
        h.style.cssText = "display:block;margin-bottom:4px;"
        box.appendChild(h)
        for (const err of build.validation) {
            const line = document.createElement("div")
            line.textContent = "• " + String(err)
            box.appendChild(line)
        }
        host.appendChild(box)
    }

    function _renderEmpty(host, msg) {
        const div = document.createElement("div")
        div.style.cssText = "padding:6px;color:#9ca3af;font-size:11px;font-style:italic;"
        div.textContent = msg
        host.appendChild(div)
    }

    // ── Mapping helpers ────────────────────────────────────────────────

    function _candidateToScoredRow(c) {
        if (!c) return {destIata: null, distanceKm: null, aircraftFit: null}
        const af = c.aircraftFit || _mapFits(c.fits)
        return {
            destIata:      c.destIata,
            destName:      c.destName || null,
            distanceKm:    c.distanceKm,
            aircraftFit:   af,
            paxScore:      c.paxScore,
            cargoScore:    c.cargoScore,
            weeklyFlights: c.weeklyFlights,
            airlineCount:  c.airlineCount,
            score:         (typeof c.score === "number") ? c.score
                         : (typeof c.scoreBlend === "number") ? c.scoreBlend
                         : null
        }
    }

    function _mapFits(fits) {
        if (fits === "oor")   return "oor"
        if (fits === "fit")   return "optimal"
        if (fits === "tight") return "falloff"
        return null
    }

    function _flightToCandidate(flight) {
        const inbound = (flight.direction === "inbound")
        const partner = inbound ? flight.origin : flight.destination
        const distanceNm = Number(flight.distanceNm) || 0
        const distanceKm = distanceNm ? Math.round(distanceNm * KM_PER_NM * 10) / 10 : null
        return {
            destIata:         partner,
            destName:         null,
            distanceKm:       distanceKm,
            distanceNm:       distanceNm || null,
            paxScore:         null,
            cargoScore:       null,
            weeklyFlights:    null,
            airlineCount:     null,
            fits:             "fit",
            aircraftFit:      null,
            scoreBlend:       null,
            alreadyScheduled: false,
            notes:            ["Wave leg: "
                                  + (flight.waveLabel || flight.waveId || "?")
                                  + " " + (flight.direction || "?")],
            // Hint bag for a future Slice D enhancement that can read
            // origin / depTime when source === "wave-leg".  Slice D's stock
            // subscriber today only reads candidate.destIata.
            __wave: {
                origin:      flight.origin,
                destination: flight.destination,
                depTime:     flight.depTimeLocal,
                direction:   flight.direction,
                waveId:      flight.waveId,
                waveLabel:   flight.waveLabel,
                seq:         flight.seq
            }
        }
    }

    function _emptyBuildWith(reason, preset) {
        return {
            validation:  [reason], routes: [], flights: [], warnings: [],
            placements:  [], unplaced: [], shortfall: {}, skipped: [],
            connections: [], preset: preset || null
        }
    }

    function _opt(value, text) {
        const o = document.createElement("option")
        o.value = value; o.textContent = text
        return o
    }

    // ── Presets loader ─────────────────────────────────────────────────

    let _presetsPromise = null

    function _loadPresets() {
        if (_presetsPromise) return _presetsPromise
        if (typeof SchedulePresets === "undefined") {
            _state.presetsLoaded = true
            _state.presetsError  = "SchedulePresets not loaded"
            return Promise.resolve(null)
        }
        _presetsPromise = SchedulePresets.load().then(p => {
            _state.presets         = (p && Array.isArray(p.presets)) ? p.presets : []
            _state.defaultPresetId = (p && p.defaultPresetId) || null
            _state.presetsLoaded   = true
            _state.presetsError    = null
            if (!_state.selectedPresetId) {
                _state.selectedPresetId = _resolveInitialPresetId()
            }
            return p
        }).catch(e => {
            _state.presetsLoaded = true
            _state.presetsError  = (e && e.message) || String(e)
            console.warn("[AFP-E] presets load failed", e)
            return null
        })
        return _presetsPromise
    }

    function _resolveInitialPresetId() {
        const hub = String((window.AesAfp && AesAfp.ctx && AesAfp.ctx.currentLocationIata) || "").toUpperCase()
        const visible = _visiblePresets(hub)
        if (_state.defaultPresetId && visible.find(p => p.id === _state.defaultPresetId)) {
            return _state.defaultPresetId
        }
        return visible[0] ? visible[0].id : null
    }

    /**
     * Apply the in-state hub filter to the preset list. Returns ALL presets
     * when the filter is disabled or the hub is unknown — defensive so the
     * picker is never empty when it could otherwise have entries.
     */
    function _visiblePresets(hub) {
        if (!_state.hubFilterEnabled || !hub) return _state.presets
        const filtered = _state.presets.filter(p =>
            String((p && p.hub) || "").toUpperCase() === hub
        )
        return filtered.length ? filtered : []
    }

    /**
     * Create a starter preset hub-stamped to the current aircraft location
     * and open the dashboard so the user can finish editing waves /
     * composition / factors. Selects the new preset on success.
     */
    function _onCreatePresetForHub(hub) {
        if (typeof SchedulePresets === "undefined" || !hub) return
        SchedulePresets.create({name: "Wave plan for " + hub, hub}).then(preset => {
            if (!preset) return
            _state.presets.push(preset)
            _state.selectedPresetId = preset.id
            _markBuildStale()
            _renderToolbar()
            _renderStatus()
            try { window.open("/app/enterprise/dashboard", "_blank") } catch (_) { /* noop */ }
        }).catch(err => console.warn("[AFP-E] preset create failed", err))
    }

    // ── Bus wiring ─────────────────────────────────────────────────────

    function _onCtxReady() {
        _state.ctxReady = true
        _renderRoot()
        _attachDraftListener()
        _hydrateFromDraft()
        _maybeConsumeHandoff()
    }

    /**
     * Slice 8c — read the cross-page handoff (set by route-assistant
     * Wave Designer's "Open in flight plan…" CTA), pre-select the
     * matching preset, and auto-Generate so the user lands on a
     * populated Gantt without re-picking.
     *
     * Race-safe: requires both ctx:ready AND presets loaded. Called
     * from _onCtxReady AND _loadPresets's resolve, whichever runs second
     * is the one that actually triggers consume. Also checks the
     * handoff is for THIS aircraft (consume() short-circuits otherwise).
     */
    async function _maybeConsumeHandoff() {
        if (!_state.ctxReady || !_state.presetsLoaded) return
        if (typeof window.AesHandoffStore === "undefined") return
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        if (!ctx.aircraftId) return
        // Ensure we only consume once per mount lifecycle.
        if (_state._handoffConsumed) return
        // Track C — peek first so dnd-grid records (no presetId) stay in
        // the store for route-candidates.js to consume. Only claim records
        // that carry a presetId.
        let rec
        try { rec = await window.AesHandoffStore.peek() }
        catch (e) { console.warn("[AFP-8c] handoff peek threw", e); return }
        if (!rec) return
        if (String(rec.aircraftId) !== String(ctx.aircraftId)) return
        if (rec.source === "dnd-grid" || !rec.presetId) return
        _state._handoffConsumed = true
        try { rec = await window.AesHandoffStore.consume(ctx.aircraftId) }
        catch (e) { console.warn("[AFP-8c] handoff consume threw", e); return }
        if (!rec) return
        // Find the preset; if missing (deleted between handoff and arrival),
        // surface a hint and bail.
        const preset = (_state.presets || []).find(p => p && p.id === rec.presetId)
        if (!preset) {
            if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.warn) {
                try { RouteAssistantToast.warn("Wave Designer handoff: preset "
                    + rec.presetId + " no longer exists.") } catch (_) { /* noop */ }
            }
            return
        }
        _state.selectedPresetId = preset.id
        _markBuildStale()
        _renderToolbar()
        _renderStatus()
        if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.info) {
            try { RouteAssistantToast.info("Loaded from Wave Designer — "
                + (preset.name || "preset") + ". Generating…") } catch (_) { /* noop */ }
        }
        // Auto-generate so the user lands on a Gantt, not a blank toolbar.
        if (_generateEnabled()) {
            try { _onGenerate() } catch (e) { console.warn("[AFP-8c] auto-generate threw", e) }
        }
    }

    function _onSpecResolved(payload) {
        _state.spec = (payload && payload.spec) || null
        _markBuildStale()
        _renderToolbar()
        _renderStatus()
    }

    function _onCandidatesUpdated(payload) {
        _state.candidates = (payload && Array.isArray(payload.candidates))
            ? payload.candidates : []
        _markBuildStale()
        _renderToolbar()
        _renderStatus()
    }

    // ── Active-draft sync (cross-tab with the Fleet Hub overlay) ───────

    function _persistPresetToDraft(presetId) {
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        if (!ctx.server || !ctx.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        AesAfpActiveDraftStore.setPreset(ctx.server, ctx.aircraftId, presetId || null)
            .catch(err => console.warn("[AFP-E] preset persist failed", err))
    }

    function _persistBuildToDraft(preset, build, ctx) {
        if (!ctx || !ctx.server || !ctx.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        const flights = (build && Array.isArray(build.flights)) ? build.flights : []
        AesAfpActiveDraftStore.setFlights(ctx.server, ctx.aircraftId, {
            hub:         (ctx.currentLocationIata || (preset && preset.hub) || null),
            presetId:    preset ? preset.id : null,
            flights,
            generatedAt: Date.now()
        }).catch(err => console.warn("[AFP-E] build persist failed", err))
    }

    function _markLegAppliedInDraft(seq) {
        if (seq == null) return
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        if (!ctx.server || !ctx.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        AesAfpActiveDraftStore.setApplied(ctx.server, ctx.aircraftId, seq, Date.now())
            .catch(err => console.warn("[AFP-E] applied persist failed", err))
    }

    /**
     * Pull the latest draft into _state.draft (so leg rows can read overlay
     * state) and re-render. Also hydrates _state.lastBuild + selectedPresetId
     * if the local in-memory state is empty — this is what makes the AFP
     * sidebar pick up a build the Fleet Hub overlay generated.
     */
    function _hydrateFromDraft() {
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        if (!ctx.server || !ctx.aircraftId) return Promise.resolve()
        if (typeof AesAfpActiveDraftStore === "undefined") return Promise.resolve()
        return AesAfpActiveDraftStore.load(ctx.server, ctx.aircraftId).then(rec => {
            _state.draft = rec
            if (!_state.selectedPresetId && rec.presetId) {
                _state.selectedPresetId = rec.presetId
            }
            // Treat the persisted flights as a synthesized lastBuild so the
            // wave gantt + leg list have something to render until the user
            // hits Generate locally. presets/spec/candidates may not yet be
            // resolved, but renderPreview only needs flights + warnings.
            if (!_state.lastBuild && rec.flights && rec.flights.length) {
                _state.lastBuild = {
                    validation: [], routes: [], placements: [], unplaced: [],
                    shortfall: {}, skipped: [], connections: [],
                    flights: rec.flights, warnings: [],
                    preset: null
                }
            }
            if (_state.ctxReady) {
                _renderToolbar()
                _renderStatus()
                if (_buildEl && _state.lastBuild) renderPreview(_buildEl, _state.lastBuild)
            }
        }).catch(err => console.warn("[AFP-E] draft hydrate failed", err))
    }

    function _attachDraftListener() {
        if (_state.draftListener) return
        const ctx = (window.AesAfp && AesAfp.ctx) || {}
        if (!ctx.server || !ctx.aircraftId) return
        if (typeof AesAfpActiveDraftStore === "undefined") return
        const key = AesAfpActiveDraftStore._key(ctx.server, ctx.aircraftId)
        _state.draftListener = (changes, area) => {
            if (area !== "local") return
            if (!Object.prototype.hasOwnProperty.call(changes, key)) return
            if (_state.draftReloadTimer) clearTimeout(_state.draftReloadTimer)
            _state.draftReloadTimer = setTimeout(() => {
                _state.draftReloadTimer = null
                AesAfpActiveDraftStore.load(ctx.server, ctx.aircraftId).then(rec => {
                    _state.draft = rec
                    // Adopt remote preset selection if it changed.
                    if (rec.presetId && rec.presetId !== _state.selectedPresetId) {
                        _state.selectedPresetId = rec.presetId
                        _renderToolbar()
                    }
                    // Adopt remote build if our local one is empty/stale.
                    if (rec.flights && rec.flights.length
                            && (!_state.lastBuild
                                || (_state.lastBuild.flights || []).length !== rec.flights.length)) {
                        _state.lastBuild = {
                            validation: [], routes: [], placements: [], unplaced: [],
                            shortfall: {}, skipped: [], connections: [],
                            flights: rec.flights, warnings: [],
                            preset: _state.lastBuild ? _state.lastBuild.preset : null
                        }
                    }
                    if (_buildEl && _state.lastBuild) renderPreview(_buildEl, _state.lastBuild)
                    _renderStatus()
                }).catch(err => console.warn("[AFP-E] draft reload failed", err))
            }, 200)
        }
        chrome.storage.onChanged.addListener(_state.draftListener)
    }

    function _attach() {
        if (!window.AesAfp || !AesAfp.bus || typeof AesAfp.bus.on !== "function") {
            // Manifest order should guarantee Slice A is loaded; defer once defensively.
            setTimeout(_attach, 50)
            return
        }
        AesAfp.bus.on("ctx:ready",          _onCtxReady)
        AesAfp.bus.on("spec:resolved",      _onSpecResolved)
        AesAfp.bus.on("candidates:updated", _onCandidatesUpdated)
        _loadPresets().then(() => {
            // If ctx:ready fired before presets resolved, the toolbar is
            // already in the DOM (with "Loading…" state) — refresh it now.
            if (_state.ctxReady) { _renderToolbar(); _renderStatus() }
            // Slice 8c — also try to consume a pending handoff once presets
            // are loaded; the other direction (presets-then-ctx) is handled
            // in _onCtxReady.
            _maybeConsumeHandoff()
        })
    }

    // ── Public namespace + boot ────────────────────────────────────────

    window.AesAfpWaveApplier = {
        buildFromCandidates,
        renderPreview,
        applyLeg,
        get last() { return _state.lastBuild }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _attach, {once: true})
    } else {
        _attach()
    }
})()
