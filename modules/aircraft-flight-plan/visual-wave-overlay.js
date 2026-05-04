"use strict"

/**
 * Visual Flight Plan wave overlay.
 *
 * Paints the active SchedulePresets wave windows and candidate/build bars
 * directly on top of AS's `.visual-flight-plan` Gantt. The sidebar wave
 * applier remains the source of generated plans; this module adds the missing
 * spatial link between that plan and the actual schedule rows.
 */
;(function () {
    if (window.AesAfpVisualWaveOverlay) return

    const PANEL_SEL = ".as-panel.visual-flight-plan"
    const DAY_SEL   = ".vfp.vfp-main .day, .vfp .day"
    const LAYER_ATTR = "data-aes-afp-vwo-layer"
    const CONTROLS_ATTR = "data-aes-afp-vwo-controls"
    const MAX_HEATMAP_CANDIDATES = 16
    const DEFAULT_BLOCK_MIN = 75
    const KM_PER_NM = 1.852

    const WAVE_COLORS = [
        "#38bdf8", "#f59e0b", "#22c55e", "#ef4444", "#8b5cf6",
        "#ec4899", "#eab308", "#06b6d4", "#f97316", "#84cc16"
    ]
    const DENSITY_COLORS = [
        "#38bdf8", "#f97316", "#22c55e", "#eab308", "#a855f7",
        "#ef4444", "#14b8a6", "#f43f5e", "#84cc16", "#60a5fa",
        "#f59e0b", "#06b6d4"
    ]

    const _state = {
        attached: false,
        enabled: true,
        densityEnabled: true,
        candidates: [],
        spec: null,
        presets: [],
        defaultPresetId: null,
        presetsLoaded: false,
        presetsError: null,
        selectedPresetId: null,
        lastBuild: null,
        buildStale: false,
        renderTimer: 0,
        renderSeq: 0,
        routeMetricsByHub: Object.create(null),
        routeMetricsPromises: Object.create(null),
        observer: null,
        observedNode: null,
        suppressObserver: false
    }

    let _presetsPromise = null

    function _bus() {
        return (window.AesAfp && window.AesAfp.bus) || null
    }

    function _ctx() {
        return (window.AesAfp && window.AesAfp.ctx) || {}
    }

    function _activeHub() {
        if (window.AesAfp && typeof window.AesAfp.getActiveHub === "function") {
            try {
                const h = window.AesAfp.getActiveHub()
                if (h) return String(h).toUpperCase()
            } catch (_) { /* keep fallback */ }
        }
        const ctx = _ctx()
        return String(ctx.currentLocationIata || "").toUpperCase()
    }

    function _candidateList() {
        if (_state.candidates && _state.candidates.length) return _state.candidates
        if (window.AesAfpRouteCandidates && Array.isArray(window.AesAfpRouteCandidates.last)) {
            return window.AesAfpRouteCandidates.last
        }
        return []
    }

    function _currentSpec() {
        return _state.spec
            || (window.AesAfpSpecResolver && window.AesAfpSpecResolver.last)
            || null
    }

    function _syncFromWaveApplier() {
        const build = window.AesAfpWaveApplier && window.AesAfpWaveApplier.last
        if (build && build.preset && build.preset.id && _buildHasUsableFlights(build)) {
            _state.lastBuild = _buildWithUsableFlights(build)
            _state.buildStale = false
            if (build.preset && build.preset.id) _state.selectedPresetId = build.preset.id
        }
    }

    function _scheduleRender(delay) {
        if (_state.renderTimer) clearTimeout(_state.renderTimer)
        _state.renderTimer = setTimeout(() => {
            _state.renderTimer = 0
            _render().catch(err => console.warn("[AES AFP] visual wave overlay render failed", err))
        }, delay == null ? 80 : delay)
    }

    async function _loadPresets() {
        if (_presetsPromise) return _presetsPromise
        if (typeof SchedulePresets === "undefined") {
            _state.presetsLoaded = true
            _state.presetsError = "SchedulePresets not loaded"
            return null
        }
        _presetsPromise = SchedulePresets.load().then(block => {
            _state.presets = block && Array.isArray(block.presets) ? block.presets : []
            _state.defaultPresetId = block && block.defaultPresetId || null
            _state.presetsLoaded = true
            _state.presetsError = null
            return block
        }).catch(err => {
            _state.presetsLoaded = true
            _state.presetsError = String(err && err.message || err)
            console.warn("[AES AFP] visual wave overlay preset load failed", err)
            return null
        })
        return _presetsPromise
    }

    async function _resolvePreset() {
        await _loadPresets()
        const presets = _state.presets || []
        if (!presets.length) return null

        const stripId = window.AesAfpWaveStrip && window.AesAfpWaveStrip.activePresetId
        const wantedId = _state.selectedPresetId || stripId || null
        let preset = wantedId ? presets.find(p => p && p.id === wantedId) : null

        const buildPreset = _state.lastBuild && _state.lastBuild.preset
        if (!preset && buildPreset && buildPreset.id) {
            preset = presets.find(p => p && p.id === buildPreset.id) || buildPreset
        }
        if (!preset && _state.defaultPresetId) {
            preset = presets.find(p => p && p.id === _state.defaultPresetId) || null
        }
        const hub = _activeHub()
        if (!preset && hub) {
            preset = presets.find(p => String((p && p.hub) || "").toUpperCase() === hub) || null
        }
        if (!preset) preset = presets[0] || null
        if (preset && preset.id) _state.selectedPresetId = preset.id
        return preset
    }

    function _activeBuildForPreset(preset) {
        const build = _state.lastBuild
        if (!build || !Array.isArray(build.flights) || !build.flights.length) return null
        const bp = build.preset
        if (!bp || !bp.id) return null
        if (!_buildHasUsableFlights(build)) return null
        if (preset && preset.id && bp && bp.id && bp.id !== preset.id) return null
        return build
    }

    async function _render() {
        const seq = ++_state.renderSeq
        _syncFromWaveApplier()
        const panel = document.querySelector(PANEL_SEL)
        if (!panel) return

        const preset = await _resolvePreset()
        if (seq !== _state.renderSeq) return
        const hub = _presetHub(preset)
        const routeMetrics = hub ? await _loadRouteMetrics(hub) : new Map()
        if (seq !== _state.renderSeq) return

        _installCss()
        _installObserver(panel)
        const build = _activeBuildForPreset(preset)
        const liveSchedule = _state.densityEnabled ? _readCurrentSchedule() : null
        const densityStats = _scheduleDensityStats(liveSchedule, hub)
        const hasDensity = !!(_state.densityEnabled && densityStats && densityStats.legs)
        _renderControls(panel, preset, build, routeMetrics, densityStats)

        if (!_state.enabled || (!preset && !hasDensity)) {
            _clearLayers(panel)
            return
        }

        const days = Array.from(panel.querySelectorAll(DAY_SEL))
            .filter((day, idx, arr) => arr.indexOf(day) === idx)
        if (!days.length) return

        _withObserverSuppressed(() => {
            const dayMask = _dayMask(preset)
            days.forEach((day, dayIdx) => {
                const blocks = day.querySelector(".blocks")
                if (!blocks) return
                const layer = _ensureLayer(blocks)
                layer.innerHTML = ""
                if (dayMask && dayMask[dayIdx] === false) {
                    _markDensity(blocks, false)
                    return
                }
                if (preset) _renderWaveWindows(layer, preset, dayIdx)
                if (hasDensity) {
                    _markDensity(blocks, true)
                    _renderExistingRouteDensity(layer, liveSchedule, dayIdx, hub)
                } else {
                    _markDensity(blocks, false)
                }
                if (preset) {
                    if (build) _renderBuildBars(layer, preset, build, dayIdx, routeMetrics)
                    else _renderHeatBars(layer, preset, dayIdx, routeMetrics)
                }
            })
        })
    }

    function _renderControls(panel, preset, build, routeMetrics, densityStats) {
        let controls = panel.querySelector("[" + CONTROLS_ATTR + "]")
        if (!controls) {
            controls = document.createElement("div")
            controls.setAttribute(CONTROLS_ATTR, "1")
            controls.className = "aes-afp-vwo-controls"
            const anchor = _directPanelChild(panel)
            try {
                if (anchor && anchor.parentElement === panel) panel.insertBefore(controls, anchor)
                else panel.appendChild(controls)
            } catch (_) {
                panel.appendChild(controls)
            }
        }
        controls.innerHTML = ""

        const left = document.createElement("div")
        left.className = "aes-afp-vwo-controls-left"

        const title = document.createElement("strong")
        title.textContent = "Wave overlay"
        left.appendChild(title)

        const meta = document.createElement("span")
        const candidates = _candidateList()
        const waves = preset && Array.isArray(preset.waves) ? preset.waves.length : 0
        const flights = build && Array.isArray(build.flights) ? build.flights.length : 0
        const hub = _presetHub(preset)
        const ranked = _rankedHeatCandidates(_candidatePoolForHub(candidates, hub), routeMetrics)
        const profitKnown = ranked.filter(entry => Number.isFinite(entry.metrics.profitPerWeek)).length
        const name = preset ? (preset.name || "preset") : (_state.presetsError || "no preset")
        meta.textContent = " " + name
            + (waves ? " - " + waves + " waves" : "")
            + (flights ? " - " + flights + " planned legs"
                : candidates.length ? " - " + Math.min(ranked.length, MAX_HEATMAP_CANDIDATES) + " heat routes"
                    : "")
            + (_state.densityEnabled && densityStats && densityStats.legs
                ? " - live density " + densityStats.legs + " legs"
                    + (densityStats.gaps ? "/" + densityStats.gaps + " gaps" : "")
                : "")
            + (profitKnown ? " - profit heat" : ranked.length ? " - score heat" : "")
            + (_state.buildStale && build ? " - stale" : "")
        left.appendChild(meta)
        const heatSummary = _heatSummary(ranked)
        if (heatSummary) {
            const heat = document.createElement("span")
            heat.className = "aes-afp-vwo-heat-summary"
            heat.textContent = heatSummary
            heat.title = "Top visible route signals used to color the heat bars."
            left.appendChild(heat)
        }
        controls.appendChild(left)

        const actions = document.createElement("div")
        actions.className = "aes-afp-vwo-actions"

        const planBtn = document.createElement("button")
        planBtn.type = "button"
        planBtn.textContent = build ? "Regenerate" : "Plan"
        const planCandidates = _candidatePoolForHub(_candidateList(), hub)
        const hasDistanceResolvedCandidate = planCandidates.some(_hasRouteDistance)
        const canPlan = !!(preset && planCandidates.length && hasDistanceResolvedCandidate && _currentSpec()
            && window.AesAfpWaveApplier
            && typeof window.AesAfpWaveApplier.buildFromCandidates === "function")
        planBtn.disabled = !canPlan
        planBtn.title = canPlan ? "Build a wave plan from the current candidates and paint it on the Visual Flight Plan."
            : !hasDistanceResolvedCandidate && _candidateList().length
                ? "Distance data is not resolved yet; density bars remain available for manual pre-fill."
                : "Needs a preset, aircraft spec, route candidates, and the wave applier module."
        planBtn.addEventListener("click", () => {
            if (!planBtn.disabled) _buildPlanFromOverlay()
        })
        actions.appendChild(planBtn)

        const densityToggle = document.createElement("button")
        densityToggle.type = "button"
        densityToggle.textContent = _state.densityEnabled ? "Density On" : "Density Off"
        densityToggle.className = _state.densityEnabled ? "is-active" : ""
        densityToggle.title = _state.densityEnabled
            ? "Hide the faint existing-route and ground-gap density layer."
            : "Show existing routes and open ground gaps with multiply-blended density."
        densityToggle.addEventListener("click", () => {
            _state.densityEnabled = !_state.densityEnabled
            _scheduleRender(0)
        })
        actions.appendChild(densityToggle)

        const toggle = document.createElement("button")
        toggle.type = "button"
        toggle.textContent = _state.enabled ? "Hide" : "Show"
        toggle.title = _state.enabled ? "Hide the wave overlay." : "Show the wave overlay."
        toggle.addEventListener("click", () => {
            _state.enabled = !_state.enabled
            _scheduleRender(0)
        })
        actions.appendChild(toggle)

        controls.appendChild(actions)
    }

    async function _buildPlanFromOverlay() {
        const preset = await _resolvePreset()
        const candidates = _candidatePoolForHub(_candidateList(), _presetHub(preset))
        const spec = _currentSpec()
        if (!preset || !candidates.length || !spec || !window.AesAfpWaveApplier) {
            _toast("Wave overlay needs a preset, spec, and route candidates before planning.", "warn")
            return
        }
        let build = null
        try {
            build = window.AesAfpWaveApplier.buildFromCandidates({
                preset,
                candidates,
                ctx: _ctx(),
                spec
            })
        } catch (err) {
            console.warn("[AES AFP] visual overlay plan build failed", err)
            _toast("Wave overlay plan failed: " + String(err && err.message || err), "error")
            return
        }
        build = _buildWithUsableFlights(build)
        const count = build && Array.isArray(build.flights) ? build.flights.length : 0
        if (!count) {
            _state.lastBuild = null
            _state.buildStale = false
            _toast("No distance-resolved wave plan yet; keeping the route density overlay.", "warn")
            _scheduleRender(0)
            return
        }
        _state.lastBuild = build
        _state.buildStale = false
        if (preset && preset.id) _state.selectedPresetId = preset.id
        _persistBuildToDraft(preset, build)
        const bus = _bus()
        if (bus) {
            try { bus.emit("wave:built", {build}) }
            catch (err) { console.warn("[AES AFP] visual overlay wave:built emit failed", err) }
        }
        _toast(count ? "Wave overlay planned " + count + " legs." : "Wave overlay planned no legs.", count ? "success" : "warn")
        _scheduleRender(0)
    }

    function _persistBuildToDraft(preset, build) {
        const ctx = _ctx()
        if (!ctx.server || !ctx.aircraftId) return
        if (!window.AesAfpActiveDraftStore || typeof window.AesAfpActiveDraftStore.setFlights !== "function") return
        const flights = build && Array.isArray(build.flights) ? build.flights : []
        window.AesAfpActiveDraftStore.setFlights(ctx.server, ctx.aircraftId, {
            hub: (preset && preset.hub) || _activeHub() || null,
            presetId: preset ? preset.id : null,
            flights,
            generatedAt: Date.now()
        }).catch(err => console.warn("[AES AFP] visual overlay draft persist failed", err))
    }

    function _renderWaveWindows(layer, preset, dayIdx) {
        const waves = Array.isArray(preset.waves) ? preset.waves : []
        waves.forEach((wave, idx) => {
            const color = WAVE_COLORS[idx % WAVE_COLORS.length]
            _windowSegments(wave.arrivalWindow).forEach(seg => {
                _appendSpan(layer, seg.start, seg.end, {
                    className: "aes-afp-vwo-window aes-afp-vwo-arrival",
                    top: "0",
                    height: "100%",
                    background: "rgba(16,185,129,0.08)",
                    borderColor: "rgba(16,185,129,0.28)",
                    label: dayIdx === 0 ? _waveName(wave, idx) + " ARR" : "",
                    title: _waveName(wave, idx) + " arrival " + _fmtMin(seg.start) + "-" + _fmtMin(seg.end),
                    color
                })
            })
            _windowSegments(wave.departureWindow).forEach(seg => {
                _appendSpan(layer, seg.start, seg.end, {
                    className: "aes-afp-vwo-window aes-afp-vwo-departure",
                    top: "0",
                    height: "100%",
                    background: "rgba(59,130,246,0.08)",
                    borderColor: "rgba(59,130,246,0.30)",
                    label: dayIdx === 0 ? _waveName(wave, idx) + " DEP" : "",
                    title: _waveName(wave, idx) + " departure " + _fmtMin(seg.start) + "-" + _fmtMin(seg.end),
                    color
                })
            })
        })
    }

    function _renderBuildBars(layer, preset, build, dayIdx, routeMetrics) {
        const flights = Array.isArray(build.flights) ? build.flights : []
        const hub = String((preset && preset.hub) || _activeHub() || "").toUpperCase()
        flights.forEach((flight, idx) => {
            if (!_flightRunsOnDay(flight, dayIdx)) return
            if (!_isUsableFlight(flight)) return
            const waveIdx = _waveIndex(preset, flight.waveId)
            const depMin = _parseHHMM(flight.depTimeLocal)
            if (!Number.isFinite(depMin)) return
            const blockMin = _flightBlockMin(flight)
            const inbound = flight.direction === "inbound"
            const start = inbound ? depMin - blockMin : depMin
            const end = inbound ? depMin : depMin + blockMin
            const peer = inbound ? flight.origin : flight.destination
            const metrics = _metricsForDest(peer, routeMetrics)
            const heat = _heatFromMetrics(metrics)
            const top = (inbound ? 22 : 7) + ((waveIdx % 2) * 4)
            const metricLabel = _metricShortLabel(metrics)
            _appendSpan(layer, start, end, {
                className: "aes-afp-vwo-route aes-afp-vwo-build aes-afp-vwo-planned",
                top: top + "px",
                height: "12px",
                background: _heatBackground(heat, inbound, metrics),
                borderColor: _heatBorder(heat, metrics, WAVE_COLORS[Math.max(0, waveIdx) % WAVE_COLORS.length]),
                label: (peer || "") + (metricLabel ? " " + metricLabel : ""),
                title: (inbound ? "IN " : "OUT ")
                    + (flight.origin || "?") + " -> " + (flight.destination || "?")
                    + " " + (flight.depTimeLocal || "--:--")
                    + " " + (_waveNameById(preset, flight.waveId) || "")
                    + _metricTitleSuffix(metrics),
                onClick: () => _applyFlight(flight, hub)
            })
        })
    }

    function _renderHeatBars(layer, preset, dayIdx, routeMetrics) {
        const hub = _presetHub(preset)
        const candidates = _rankedHeatCandidates(_candidatePoolForHub(_candidateList(), hub), routeMetrics)
            .slice(0, MAX_HEATMAP_CANDIDATES)
        if (!candidates.length) return

        const waves = Array.isArray(preset.waves) ? preset.waves : []
        waves.forEach((wave, waveIdx) => {
            const arr = _windowMidpoint(wave.arrivalWindow)
            const dep = _windowMidpoint(wave.departureWindow)
            candidates.forEach((entry, rank) => {
                const candidate = entry.candidate || entry
                const blockMin = _candidateBlockMin(candidate)
                const track = rank % 4
                const label = _heatRouteLabel(entry, rank)
                const titleBase = _heatRouteTitle(candidate, entry, wave, hub)
                if (Number.isFinite(dep)) {
                    const start = dep + _slotOffset(rank, candidates.length, wave.departureWindow)
                    _appendSpan(layer, start, start + blockMin, {
                        className: "aes-afp-vwo-route aes-afp-vwo-heat",
                        top: (4 + track * 9) + "px",
                        height: "8px",
                        background: _heatBackground(entry.heat, false, entry.metrics),
                        borderColor: _heatBorder(entry.heat, entry.metrics, WAVE_COLORS[waveIdx % WAVE_COLORS.length]),
                        label,
                        title: "OUT " + hub + " -> " + candidate.destIata
                            + " near " + _fmtMin(start) + titleBase,
                        onClick: () => _applyCandidate(candidate, hub, start, "outbound", wave, preset)
                    })
                }
                if (Number.isFinite(arr)) {
                    const end = arr + _slotOffset(rank, candidates.length, wave.arrivalWindow)
                    _appendSpan(layer, end - blockMin, end, {
                        className: "aes-afp-vwo-route aes-afp-vwo-heat aes-afp-vwo-heat-in",
                        top: (4 + track * 9) + "px",
                        height: "8px",
                        background: _heatBackground(entry.heat, true, entry.metrics),
                        borderColor: _heatBorder(entry.heat, entry.metrics, WAVE_COLORS[waveIdx % WAVE_COLORS.length]),
                        label,
                        title: "IN " + candidate.destIata + " -> " + hub
                            + " arriving near " + _fmtMin(end) + titleBase,
                        onClick: () => _applyCandidate(candidate, hub, Math.max(0, end - blockMin), "inbound", wave, preset)
                    })
                }
            })
        })
    }

    function _readCurrentSchedule() {
        const reader = window.AesAfpVfpReader
        if (!reader || typeof reader.read !== "function") return null
        const ctx = _ctx()
        try {
            const schedule = reader.read({
                server: ctx.server || "",
                aircraftId: ctx.aircraftId || "",
                hubIata: _activeHub()
            })
            return schedule && Array.isArray(schedule.legs) ? schedule : null
        } catch (err) {
            console.warn("[AES AFP] visual overlay live schedule read failed", err)
            return null
        }
    }

    function _scheduleDensityStats(schedule, hub) {
        const legs = schedule && Array.isArray(schedule.legs) ? schedule.legs : []
        if (!legs.length) return {legs: 0, routes: 0, gaps: 0}
        const routeKeys = new Set()
        let usable = 0
        let gaps = 0
        const hubU = String(hub || "").toUpperCase()
        for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
            const spans = _densityLegSpansForDay(schedule, dayIdx, hubU)
            spans.forEach(item => {
                usable++
                routeKeys.add(item.routeKey || item.origin + "-" + item.destination)
            })
            gaps += _densityGaps(spans, hubU).length
        }
        return {legs: usable, routes: routeKeys.size, gaps}
    }

    function _renderExistingRouteDensity(layer, schedule, dayIdx, hub) {
        const spans = _densityLegSpansForDay(schedule, dayIdx, hub)
        if (!spans.length) return

        const gaps = _densityGaps(spans, hub)
        gaps.forEach(gap => {
            const color = _densityColor(gap.station || gap.routeKey)
            const alpha = gap.isHub ? 0.19 : 0.10
            _appendSpan(layer, gap.start, gap.end, {
                className: "aes-afp-vwo-density aes-afp-vwo-density-gap"
                    + (gap.isHub ? " aes-afp-vwo-density-gap-hub" : ""),
                top: "0",
                height: "100%",
                background: _rgba(color, alpha),
                borderColor: _rgba(color, gap.isHub ? 0.28 : 0.18),
                title: "Open ground gap at " + (gap.station || "station")
                    + " " + _fmtMin(gap.start) + "-" + _fmtMin(gap.end)
                    + " after " + _densityRouteLabel(gap.prev)
                    + " before " + _densityRouteLabel(gap.next)
            })
        })

        spans.forEach(item => {
            const color = _densityColor(item.routeKey)
            const top = _densityTrack(item.routeKey)
            _appendSpan(layer, item.start, item.end, {
                className: "aes-afp-vwo-density aes-afp-vwo-density-flight",
                top: top + "px",
                height: "2px",
                background: _rgba(color, 0.42),
                borderColor: "transparent",
                title: "Existing " + _densityRouteLabel(item)
                    + " " + _fmtMin(item.start) + "-" + _fmtMin(item.end)
                    + (item.flightNumber ? " " + item.flightNumber : "")
            })
        })
    }

    function _densityLegSpansForDay(schedule, dayIdx, hub) {
        const legs = schedule && Array.isArray(schedule.legs) ? schedule.legs : []
        const hubU = String(hub || "").toUpperCase()
        return legs
            .filter(leg => Number(leg && leg.dayIdx) === dayIdx && _isDensityFlight(leg))
            .map(leg => _densityLegSpan(leg, hubU))
            .filter(Boolean)
            .sort((a, b) => {
                if (a.start !== b.start) return a.start - b.start
                return a.end - b.end
            })
    }

    function _densityLegSpan(leg, hub) {
        const start = _parseHHMM(leg && leg.depTimeLocal)
        if (!Number.isFinite(start)) return null
        const duration = Number(leg && leg.durationMin)
        let end = _parseHHMM(leg && leg.arrTimeLocal)
        if (Number.isFinite(duration) && duration > 0) {
            end = start + Math.round(duration)
        } else if (Number.isFinite(end) && end <= start) {
            end += 1440
        }
        if (!Number.isFinite(end) || end <= start) end = start + DEFAULT_BLOCK_MIN
        const origin = String(leg.origin || "").toUpperCase()
        const destination = String(leg.destination || "").toUpperCase()
        if (!origin && !destination) return null
        const routeKey = _routeKeyForLeg(origin, destination, hub)
        return {
            leg,
            start,
            end,
            origin,
            destination,
            routeKey,
            flightNumber: leg.flightNumber || leg.flightCode || ""
        }
    }

    function _densityGaps(spans, hub) {
        const out = []
        const hubU = String(hub || "").toUpperCase()
        for (let i = 1; i < spans.length; i++) {
            const prev = spans[i - 1]
            const next = spans[i]
            const start = Math.max(prev.end, prev.start)
            const end = next.start
            const gapMin = end - start
            if (!Number.isFinite(gapMin) || gapMin < 20) continue
            const station = _gapStation(prev, next, hubU)
            out.push({
                start,
                end,
                prev,
                next,
                station,
                routeKey: station || prev.routeKey || next.routeKey,
                isHub: !!(station && hubU && station === hubU)
            })
        }
        return out
    }

    function _gapStation(prev, next, hub) {
        const prevDest = String(prev && prev.destination || "").toUpperCase()
        const nextOrigin = String(next && next.origin || "").toUpperCase()
        if (prevDest && nextOrigin && prevDest === nextOrigin) return prevDest
        if (prevDest && hub && prevDest === hub) return prevDest
        if (nextOrigin && hub && nextOrigin === hub) return nextOrigin
        return prevDest || nextOrigin || ""
    }

    function _routeKeyForLeg(origin, destination, hub) {
        const o = String(origin || "").toUpperCase()
        const d = String(destination || "").toUpperCase()
        const h = String(hub || "").toUpperCase()
        if (h && o === h && d) return d
        if (h && d === h && o) return o
        if (h && o === h) return d || h
        if (h && d === h) return o || h
        return o && d ? o + "-" + d : (o || d || "route")
    }

    function _densityColor(key) {
        const idx = Math.abs(_hashString(String(key || "route"))) % DENSITY_COLORS.length
        return DENSITY_COLORS[idx]
    }

    function _densityTrack(key) {
        return 4 + (Math.abs(_hashString(String(key || "route"))) % 11) * 3
    }

    function _densityRouteLabel(item) {
        const origin = String(item && item.origin || "?").toUpperCase()
        const destination = String(item && item.destination || "?").toUpperCase()
        return origin + "->" + destination
    }

    function _markDensity(blocks, active) {
        if (!blocks) return
        if (active) blocks.setAttribute("data-aes-afp-vwo-density", "1")
        else blocks.removeAttribute("data-aes-afp-vwo-density")
    }

    function _applyFlight(flight) {
        if (window.AesAfpWaveApplier && typeof window.AesAfpWaveApplier.applyLeg === "function") {
            window.AesAfpWaveApplier.applyLeg(flight)
            return
        }
        _applyCandidate({
            destIata: flight.direction === "inbound" ? flight.origin : flight.destination,
            distanceNm: flight.distanceNm
        }, flight.origin, _parseHHMM(flight.depTimeLocal), flight.direction, {
            id: flight.waveId,
            label: flight.waveLabel
        }, null)
    }

    function _applyCandidate(candidate, hub, minute, direction, wave, preset) {
        const bus = _bus()
        const dest = String(candidate.destIata || "").toUpperCase()
        const depTime = _fmtMin(minute)
        const origin = direction === "inbound" ? dest : hub
        const destination = direction === "inbound" ? hub : dest
        const enriched = Object.assign({}, candidate, {
            destIata: destination,
            __wave: {
                origin,
                destination,
                depTime,
                direction,
                waveId: wave && wave.id || null,
                waveLabel: wave && wave.label || null
            }
        })
        if (bus) {
            try {
                bus.emit("candidate:selected", {
                    candidate: enriched,
                    source: "wave-leg",
                    depTime
                })
            } catch (err) {
                console.warn("[AES AFP] visual overlay candidate emit failed", err)
            }
        } else if (window.AesAfpFormDriver && typeof window.AesAfpFormDriver.fill === "function") {
            window.AesAfpFormDriver.fill({origin, destination, depTime})
        }
        _toast((direction === "inbound" ? "Inbound" : "Outbound")
            + " leg pre-filled: " + origin + " -> " + destination + " " + depTime, "info")
    }

    function _ensureLayer(blocks) {
        if (!blocks.style.position || blocks.style.position === "static") {
            blocks.style.position = "relative"
        }
        let layer = blocks.querySelector("[" + LAYER_ATTR + "]")
        if (!layer) {
            layer = document.createElement("div")
            layer.setAttribute(LAYER_ATTR, "1")
            layer.className = "aes-afp-vwo-layer"
            blocks.appendChild(layer)
        }
        return layer
    }

    function _directPanelChild(panel) {
        if (!panel) return null
        let node = panel.querySelector(":scope > .vfp.vfp-main, :scope > .vfp")
        if (node) return node
        node = panel.querySelector(".vfp.vfp-main, .vfp")
        while (node && node.parentElement !== panel) node = node.parentElement
        return node && node.parentElement === panel ? node : null
    }

    function _clearLayers(root) {
        const host = root || document
        host.querySelectorAll("[" + LAYER_ATTR + "]").forEach(el => el.remove())
        host.querySelectorAll(".blocks[data-aes-afp-vwo-density]").forEach(blocks => _markDensity(blocks, false))
    }

    function _appendSpan(layer, startMin, endMin, opts) {
        let start = Number(startMin)
        let end = Number(endMin)
        if (!Number.isFinite(start) || !Number.isFinite(end)) return
        if (end <= start) end = start + 10

        const spans = []
        if (start < 0) {
            spans.push({start: 0, end: Math.max(0, Math.min(1440, end))})
        } else if (end > 1440) {
            spans.push({start, end: 1440})
            if (end - 1440 > 0) spans.push({start: 0, end: Math.min(1440, end - 1440)})
        } else {
            spans.push({start, end})
        }

        spans.forEach(seg => {
            const width = seg.end - seg.start
            if (width <= 0) return
            const el = document.createElement("div")
            el.className = opts.className || ""
            el.style.left = (seg.start / 1440 * 100) + "%"
            el.style.width = Math.max(0.18, width / 1440 * 100) + "%"
            if (opts.top != null) el.style.top = opts.top
            if (opts.height != null) el.style.height = opts.height
            if (opts.background) el.style.background = opts.background
            if (opts.borderColor) el.style.borderColor = opts.borderColor
            if (opts.color) el.style.setProperty("--aes-vwo-wave-color", opts.color)
            if (opts.title) el.title = opts.title
            if (opts.label) {
                const label = document.createElement("span")
                label.textContent = opts.label
                el.appendChild(label)
            }
            if (typeof opts.onClick === "function") {
                el.addEventListener("click", ev => {
                    ev.preventDefault()
                    ev.stopPropagation()
                    opts.onClick(ev)
                })
            }
            layer.appendChild(el)
        })
    }

    function _windowSegments(win) {
        if (!win) return []
        const start = _parseHHMM(win.start)
        const end = _parseHHMM(win.end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return []
        if (end > start) return [{start, end}]
        return [{start, end: 1440}, {start: 0, end}]
    }

    function _windowMidpoint(win) {
        const segs = _windowSegments(win)
        if (!segs.length) return null
        const first = segs[0]
        return Math.round((first.start + first.end) / 2)
    }

    function _spreadOffset(rank, count, win) {
        const start = _parseHHMM(win && win.start)
        const end = _parseHHMM(win && win.end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || count <= 1) return 0
        const width = Math.max(0, end - start)
        if (!width) return 0
        const centered = rank - ((count - 1) / 2)
        return Math.round(centered * Math.min(5, width / Math.max(1, count - 1)))
    }

    function _slotOffset(rank, count, win) {
        const start = _parseHHMM(win && win.start)
        const end = _parseHHMM(win && win.end)
        if (!Number.isFinite(start) || !Number.isFinite(end) || count <= 1) return 0
        const width = end >= start ? (end - start) : (1440 - start + end)
        if (!width) return 0
        const centered = rank - ((count - 1) / 2)
        const span = Math.min(110, Math.max(20, width * 0.72))
        return Math.round(centered * span / Math.max(1, count - 1))
    }

    async function _loadRouteMetrics(hub) {
        const hubU = String(hub || "").toUpperCase()
        if (!hubU) return new Map()
        if (_state.routeMetricsByHub[hubU]) return _state.routeMetricsByHub[hubU]
        if (_state.routeMetricsPromises[hubU]) return _state.routeMetricsPromises[hubU]
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
            const empty = new Map()
            _state.routeMetricsByHub[hubU] = empty
            return empty
        }
        const legacyKey = "routeAssistant:topRoutes:" + hubU
        const keys = [legacyKey]
        if (typeof acctKey === "function") {
            try {
                const scoped = acctKey("routeAssistant:topRoutes", hubU)
                if (scoped && keys.indexOf(scoped) < 0) keys.unshift(scoped)
            } catch (_) { /* legacy key is enough */ }
        }
        _state.routeMetricsPromises[hubU] = _storageGet(keys).then(out => {
            const blob = keys.map(k => out && out[k]).find(v => v && Array.isArray(v.rows)) || null
            const map = new Map()
            for (const row of (blob && blob.rows) || []) {
                const dest = String(row && row.destIata || "").toUpperCase()
                if (!dest) continue
                map.set(dest, {
                    destIata: dest,
                    profitPerWeek: _numOrNull(row.profitPerWeek),
                    score: _numOrNull(row.score),
                    ourPaxShare: _numOrNull(row.ourPaxShare),
                    paxScore: _numOrNull(row.paxScore),
                    cargoScore: _numOrNull(row.cargoScore),
                    weeklyFlights: _numOrNull(row.weeklyFlights),
                    source: "topRoutes"
                })
            }
            _state.routeMetricsByHub[hubU] = map
            delete _state.routeMetricsPromises[hubU]
            return map
        }).catch(err => {
            console.warn("[AES AFP] visual overlay route metrics load failed", err)
            const empty = new Map()
            _state.routeMetricsByHub[hubU] = empty
            delete _state.routeMetricsPromises[hubU]
            return empty
        })
        return _state.routeMetricsPromises[hubU]
    }

    function _rankedHeatCandidates(candidates, routeMetrics) {
        const base = (Array.isArray(candidates) ? candidates : [])
            .filter(c => c && c.destIata && c.fits !== "oor" && c.aircraftFit !== "oor")
        let maxProfit = 0
        let maxScore = 0
        const entries = base.map(candidate => {
            const metrics = _candidateMetrics(candidate, routeMetrics)
            if (Number.isFinite(metrics.profitPerWeek) && metrics.profitPerWeek > maxProfit) {
                maxProfit = metrics.profitPerWeek
            }
            if (Number.isFinite(metrics.score) && metrics.score > maxScore) maxScore = metrics.score
            return {candidate, metrics, destIata: String(candidate.destIata || "").toUpperCase()}
        })
        entries.forEach(entry => {
            entry.heat = _heatFromMetrics(entry.metrics, {maxProfit, maxScore})
        })
        entries.sort((a, b) => {
            if (b.heat !== a.heat) return b.heat - a.heat
            const bp = Number.isFinite(b.metrics.profitPerWeek) ? b.metrics.profitPerWeek : -Infinity
            const ap = Number.isFinite(a.metrics.profitPerWeek) ? a.metrics.profitPerWeek : -Infinity
            if (bp !== ap) return bp - ap
            return (b.metrics.score || 0) - (a.metrics.score || 0)
        })
        return entries
    }

    function _candidateMetrics(candidate, routeMetrics) {
        const dest = String(candidate && candidate.destIata || "").toUpperCase()
        const stored = routeMetrics && routeMetrics.get ? routeMetrics.get(dest) : null
        return {
            destIata: dest,
            profitPerWeek: _firstNumber(candidate && candidate.profitPerWeek, stored && stored.profitPerWeek),
            score: _firstNumber(
                candidate && candidate.scoreBlend,
                candidate && candidate.score,
                stored && stored.score
            ),
            ourPaxShare: _firstNumber(candidate && candidate.ourPaxShare, stored && stored.ourPaxShare),
            paxScore: _firstNumber(candidate && candidate.paxScore, stored && stored.paxScore),
            cargoScore: _firstNumber(candidate && candidate.cargoScore, stored && stored.cargoScore),
            weeklyFlights: _firstNumber(candidate && candidate.weeklyFlights, stored && stored.weeklyFlights),
            source: stored ? stored.source : "candidate"
        }
    }

    function _metricsForDest(dest, routeMetrics) {
        const key = String(dest || "").toUpperCase()
        const stored = routeMetrics && routeMetrics.get ? routeMetrics.get(key) : null
        return stored ? Object.assign({destIata: key}, stored) : {destIata: key}
    }

    function _heatFromMetrics(metrics, bounds) {
        const m = metrics || {}
        const b = bounds || {}
        const score = Number.isFinite(m.score) ? Math.max(0, Math.min(100, m.score)) / 100 : null
        let heat
        if (Number.isFinite(m.profitPerWeek)) {
            if (m.profitPerWeek <= 0) heat = 0.08
            else {
                const maxProfit = Number.isFinite(b.maxProfit) && b.maxProfit > 0
                    ? b.maxProfit : m.profitPerWeek
                const profitNorm = maxProfit > 0 ? Math.max(0, Math.min(1, m.profitPerWeek / maxProfit)) : 0.5
                heat = (profitNorm * 0.72) + ((score != null ? score : 0.45) * 0.28)
            }
        } else if (score != null) {
            const maxScore = Number.isFinite(b.maxScore) && b.maxScore > 0 ? b.maxScore : 100
            heat = Math.max(0.12, Math.min(1, (m.score || 0) / maxScore))
        } else {
            const pax = Number.isFinite(m.paxScore) ? m.paxScore / 10 : 0.35
            const cargo = Number.isFinite(m.cargoScore) ? m.cargoScore / 10 : 0.25
            heat = Math.max(0.1, Math.min(0.7, (pax * 0.65) + (cargo * 0.35)))
        }
        return Math.max(0.05, Math.min(1, heat))
    }

    function _heatBackground(heat, inbound, metrics) {
        const h = Math.max(0, Math.min(1, Number(heat) || 0))
        const profit = metrics && metrics.profitPerWeek
        if (Number.isFinite(profit) && profit < 0) {
            return "linear-gradient(90deg, rgba(239,68,68,0.95), rgba(127,29,29,0.72))"
        }
        if (h >= 0.72) {
            return inbound
                ? "linear-gradient(90deg, rgba(34,197,94,0.95), rgba(132,204,22,0.70))"
                : "linear-gradient(90deg, rgba(20,184,166,0.95), rgba(34,197,94,0.72))"
        }
        if (h >= 0.45) {
            return "linear-gradient(90deg, rgba(245,158,11,0.90), rgba(250,204,21,0.58))"
        }
        return inbound
            ? "linear-gradient(90deg, rgba(56,189,248,0.72), rgba(14,116,144,0.45))"
            : "linear-gradient(90deg, rgba(96,165,250,0.72), rgba(29,78,216,0.45))"
    }

    function _heatBorder(heat, metrics, fallback) {
        const profit = metrics && metrics.profitPerWeek
        if (Number.isFinite(profit) && profit < 0) return "#f87171"
        const h = Math.max(0, Math.min(1, Number(heat) || 0))
        if (h >= 0.72) return "#bbf7d0"
        if (h >= 0.45) return "#fde68a"
        return fallback || "#93c5fd"
    }

    function _heatRouteLabel(entry, rank) {
        const dest = entry && (entry.destIata || (entry.candidate && entry.candidate.destIata)) || ""
        const metric = _metricShortLabel(entry && entry.metrics)
        if (rank < 8 && metric) return dest + " " + metric
        return dest
    }

    function _heatRouteTitle(candidate, entry, wave, hub) {
        const waveName = wave ? (" · " + (wave.label || wave.id || "wave")) : ""
        const block = _candidateBlockMin(candidate)
        return " · " + _scoreLabel(candidate)
            + _metricTitleSuffix(entry && entry.metrics)
            + (Number.isFinite(block) ? " · block " + Math.round(block) + "m" : "")
            + (hub ? " · hub " + hub : "")
            + waveName
    }

    function _metricShortLabel(metrics) {
        const m = metrics || {}
        if (Number.isFinite(m.profitPerWeek)) return _formatCompactMoney(m.profitPerWeek)
        if (Number.isFinite(m.score)) return String(Math.round(m.score))
        if (Number.isFinite(m.weeklyFlights)) return Math.round(m.weeklyFlights) + "x"
        return ""
    }

    function _metricTitleSuffix(metrics) {
        const m = metrics || {}
        const parts = []
        if (Number.isFinite(m.profitPerWeek)) parts.push("profit/wk " + _formatCompactMoney(m.profitPerWeek))
        if (Number.isFinite(m.score)) parts.push("score " + Math.round(m.score))
        if (Number.isFinite(m.weeklyFlights)) parts.push("weekly " + Math.round(m.weeklyFlights))
        if (Number.isFinite(m.ourPaxShare)) parts.push("share " + (Math.round(m.ourPaxShare * 10) / 10) + "%")
        return parts.length ? " · " + parts.join(" · ") : ""
    }

    function _heatSummary(ranked) {
        const items = (ranked || []).slice(0, 3).map(entry => {
            const metric = _metricShortLabel(entry.metrics)
            return entry.destIata + (metric ? " " + metric : "")
        })
        return items.length ? "Hot: " + items.join(" | ") : ""
    }

    function _formatCompactMoney(value) {
        const n = Number(value)
        if (!Number.isFinite(n)) return ""
        const sign = n < 0 ? "-" : ""
        const abs = Math.abs(n)
        if (abs >= 1000000) return sign + "$" + (Math.round(abs / 100000) / 10) + "M"
        if (abs >= 10000) return sign + "$" + Math.round(abs / 1000) + "k"
        if (abs >= 1000) return sign + "$" + (Math.round(abs / 100) / 10) + "k"
        return sign + "$" + Math.round(abs)
    }

    function _firstNumber() {
        for (let i = 0; i < arguments.length; i++) {
            const n = _numOrNull(arguments[i])
            if (n != null) return n
        }
        return null
    }

    function _numOrNull(value) {
        const n = Number(value)
        return Number.isFinite(n) ? n : null
    }

    function _hashString(value) {
        const str = String(value || "")
        let hash = 0
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i)
            hash |= 0
        }
        return hash
    }

    function _rgba(hex, alpha) {
        const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i)
        if (!m) return "rgba(56,189,248," + Math.max(0, Math.min(1, Number(alpha) || 0)) + ")"
        const raw = m[1]
        const r = parseInt(raw.slice(0, 2), 16)
        const g = parseInt(raw.slice(2, 4), 16)
        const b = parseInt(raw.slice(4, 6), 16)
        const a = Math.max(0, Math.min(1, Number(alpha) || 0))
        return "rgba(" + r + "," + g + "," + b + "," + a + ")"
    }

    function _storageGet(keys) {
        try {
            const result = chrome.storage.local.get(keys)
            if (result && typeof result.then === "function") return result
        } catch (err) {
            return Promise.reject(err)
        }
        return new Promise((resolve, reject) => {
            try {
                chrome.storage.local.get(keys, out => {
                    const err = chrome.runtime && chrome.runtime.lastError
                    if (err) reject(new Error(err.message || String(err)))
                    else resolve(out || {})
                })
            } catch (err) {
                reject(err)
            }
        })
    }

    function _candidateBlockMin(candidate) {
        const direct = Number(candidate && candidate.blockMin)
        if (Number.isFinite(direct) && direct > 0) return Math.max(20, Math.round(direct))
        const spec = _currentSpec()
        const speed = Number(spec && spec.cruiseSpeedKmh)
        const km = Number(candidate && candidate.distanceKm)
        if (Number.isFinite(speed) && speed > 0 && Number.isFinite(km) && km > 0) {
            return Math.max(20, Math.round((km / speed) * 60))
        }
        const nm = Number(candidate && candidate.distanceNm)
        if (Number.isFinite(speed) && speed > 0 && Number.isFinite(nm) && nm > 0) {
            return Math.max(20, Math.round(((nm * KM_PER_NM) / speed) * 60))
        }
        return DEFAULT_BLOCK_MIN
    }

    function _hasRouteDistance(candidate) {
        if (!candidate) return false
        const km = Number(candidate.distanceKm)
        const nm = Number(candidate.distanceNm)
        return (Number.isFinite(km) && km > 0) || (Number.isFinite(nm) && nm > 0)
    }

    function _presetHub(preset) {
        return String((preset && preset.hub) || _activeHub() || "").toUpperCase()
    }

    function _candidatePoolForHub(candidates, hub) {
        const hubU = String(hub || "").toUpperCase()
        return (Array.isArray(candidates) ? candidates : []).filter(candidate => {
            const dest = String((candidate && candidate.destIata) || "").toUpperCase()
            return dest && (!hubU || dest !== hubU)
        })
    }

    function _isUsableFlight(flight) {
        if (!flight) return false
        const origin = String(flight.origin || "").toUpperCase()
        const destination = String(flight.destination || "").toUpperCase()
        return !!(origin && destination && origin !== destination)
    }

    function _isDensityFlight(flight) {
        if (!flight) return false
        const origin = String(flight.origin || "").toUpperCase()
        const destination = String(flight.destination || "").toUpperCase()
        if (!origin && !destination) return false
        return !(origin && destination && origin === destination)
    }

    function _buildHasUsableFlights(build) {
        return !!(build && Array.isArray(build.flights) && build.flights.some(_isUsableFlight))
    }

    function _buildWithUsableFlights(build) {
        if (!build || !Array.isArray(build.flights)) return build
        const flights = build.flights.filter(_isUsableFlight)
        return Object.assign({}, build, {flights})
    }

    function _flightBlockMin(flight) {
        const direct = Number(flight && flight.blockMin)
        if (Number.isFinite(direct) && direct > 0) return Math.max(20, Math.round(direct))
        const spec = _currentSpec()
        const speed = Number(spec && spec.cruiseSpeedKmh)
        const nm = Number(flight && flight.distanceNm)
        if (Number.isFinite(speed) && speed > 0 && Number.isFinite(nm) && nm > 0) {
            return Math.max(20, Math.round(((nm * KM_PER_NM) / speed) * 60))
        }
        return DEFAULT_BLOCK_MIN
    }

    function _dayMask(preset) {
        const schedMask = preset && preset.schedule && preset.schedule.dayMask
        if (Array.isArray(schedMask) && schedMask.length >= 7) return schedMask.map(Boolean)
        const factors = preset && preset.factors
        if (window.ScheduleFactors && typeof window.ScheduleFactors.resolveDayMask === "function") {
            try { return window.ScheduleFactors.resolveDayMask(factors && factors.dayPattern, factors && factors.dayMask) }
            catch (_) { /* fallback below */ }
        }
        return [true, true, true, true, true, true, true]
    }

    function _flightRunsOnDay(flight, dayIdx) {
        if (!flight || !Array.isArray(flight.dayMask)) return true
        return flight.dayMask[dayIdx] !== false
    }

    function _waveIndex(preset, waveId) {
        const waves = preset && Array.isArray(preset.waves) ? preset.waves : []
        const idx = waves.findIndex(w => w && w.id === waveId)
        return idx >= 0 ? idx : 0
    }

    function _waveName(wave, idx) {
        return (wave && wave.label) || ("W" + (idx + 1))
    }

    function _waveNameById(preset, waveId) {
        const waves = preset && Array.isArray(preset.waves) ? preset.waves : []
        const idx = waves.findIndex(w => w && w.id === waveId)
        if (idx < 0) return ""
        return _waveName(waves[idx], idx)
    }

    function _scoreLabel(candidate) {
        const score = Number(candidate && (candidate.scoreBlend != null ? candidate.scoreBlend : candidate.score))
        return Number.isFinite(score) ? "score " + Math.round(score) : "candidate"
    }

    function _parseHHMM(value) {
        if (window.ScheduleFactors && typeof window.ScheduleFactors.parseHHMM === "function") {
            try {
                const n = window.ScheduleFactors.parseHHMM(value)
                if (Number.isFinite(n)) return n
            } catch (_) { /* local fallback */ }
        }
        const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
    }

    function _fmtMin(min) {
        const raw = Math.round(Number(min) || 0)
        const m = ((raw % 1440) + 1440) % 1440
        const h = Math.floor(m / 60)
        const mm = m % 60
        return String(h).padStart(2, "0") + ":" + String(mm).padStart(2, "0")
    }

    function _installObserver(panel) {
        const vfp = panel.querySelector(".vfp.vfp-main, .vfp")
        if (!vfp || _state.observedNode === vfp) return
        if (_state.observer) {
            try { _state.observer.disconnect() } catch (_) {}
        }
        _state.observedNode = vfp
        _state.observer = new MutationObserver(mutations => {
            if (_state.suppressObserver) return
            const onlyOverlay = mutations.every(m => _mutationIsOverlayOnly(m))
            if (!onlyOverlay) _scheduleRender(120)
        })
        _state.observer.observe(vfp, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style"]
        })
    }

    function _mutationIsOverlayOnly(mutation) {
        const nodes = []
        if (mutation.target) nodes.push(mutation.target)
        if (mutation.addedNodes) nodes.push.apply(nodes, Array.from(mutation.addedNodes))
        if (mutation.removedNodes) nodes.push.apply(nodes, Array.from(mutation.removedNodes))
        return nodes.every(node => {
            if (!node || node.nodeType !== 1) return true
            return !!(node.closest && node.closest("[" + LAYER_ATTR + "]"))
                || !!(node.matches && node.matches("[" + LAYER_ATTR + "]"))
        })
    }

    function _withObserverSuppressed(fn) {
        _state.suppressObserver = true
        try { fn() }
        finally {
            setTimeout(() => { _state.suppressObserver = false }, 0)
        }
    }

    function _installCss() {
        if (document.getElementById("aes-afp-visual-wave-overlay-css")) return
        const style = document.createElement("style")
        style.id = "aes-afp-visual-wave-overlay-css"
        style.textContent = [
            ".aes-afp-vwo-controls{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0;padding:7px 9px;background:#101827;border:1px solid #315071;color:#cbd5e1;font-size:11px;box-shadow:0 0 0 1px rgba(56,189,248,.08) inset;}",
            ".aes-afp-vwo-controls-left{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap;}",
            ".aes-afp-vwo-controls-left strong{color:#f8fafc;white-space:nowrap;}",
            ".aes-afp-vwo-controls-left span{color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
            ".aes-afp-vwo-heat-summary{max-width:42vw;color:#fde68a!important;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.32);border-radius:3px;padding:1px 5px;font-family:monospace;font-size:10px;}",
            ".aes-afp-vwo-actions{display:flex;align-items:center;gap:5px;flex:0 0 auto;}",
            ".aes-afp-vwo-actions button{background:#172033;color:#dbeafe;border:1px solid #334155;border-radius:2px;padding:2px 7px;font-size:10px;font-weight:600;cursor:pointer;}",
            ".aes-afp-vwo-actions button.is-active{background:#163044;border-color:#2b6f93;color:#e0f2fe;}",
            ".aes-afp-vwo-actions button:disabled{color:#64748b;background:#111827;cursor:not-allowed;}",
            ".aes-afp-vwo-layer{position:absolute;inset:0;z-index:8;pointer-events:none;overflow:hidden;}",
            ".aes-afp-vwo-window{position:absolute;z-index:4;box-sizing:border-box;border-left:1px solid;border-right:1px solid;pointer-events:none;mix-blend-mode:screen;}",
            ".aes-afp-vwo-window span{position:absolute;top:1px;left:4px;color:#e5e7eb;font-size:9px;font-weight:800;text-shadow:0 1px 2px #000;white-space:nowrap;}",
            ".aes-afp-vwo-window:before{content:\"\";position:absolute;top:0;bottom:0;left:0;width:3px;background:var(--aes-vwo-wave-color,#60a5fa);opacity:.9;}",
            ".blocks[data-aes-afp-vwo-density=\"1\"]>.block.flight{opacity:.58;filter:saturate(.62) brightness(.9);}",
            ".blocks[data-aes-afp-vwo-density=\"1\"]>.block.location{opacity:.74;}",
            ".aes-afp-vwo-density{position:absolute;box-sizing:border-box;pointer-events:none;mix-blend-mode:multiply;}",
            ".aes-afp-vwo-density-gap{z-index:7;border-left:1px solid;border-right:1px solid;opacity:.78;}",
            ".aes-afp-vwo-density-gap:after{content:\"\";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(255,255,255,.20) 0 1px,transparent 1px 6px);opacity:.16;}",
            ".aes-afp-vwo-density-gap-hub{opacity:.9;}",
            ".aes-afp-vwo-density-flight{z-index:9;border-left:0;border-radius:999px;box-shadow:0 0 0 1px rgba(15,23,42,.18),0 0 6px rgba(255,255,255,.16);opacity:.72;}",
            ".aes-afp-vwo-route{position:absolute;box-sizing:border-box;border-left:3px solid;border-radius:2px;pointer-events:auto;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#f8fafc;font-size:9px;line-height:10px;font-weight:800;padding-left:3px;text-shadow:0 1px 2px #000;box-shadow:0 0 0 1px rgba(15,23,42,.72),0 2px 6px rgba(0,0,0,.28);}",
            ".aes-afp-vwo-heat{z-index:16;opacity:.96;}",
            ".aes-afp-vwo-heat-in{filter:saturate(1.08);}",
            ".aes-afp-vwo-heat:hover{height:14px!important;margin-top:-3px;opacity:1;z-index:28;filter:brightness(1.12) saturate(1.12);}",
            ".aes-afp-vwo-build{z-index:20;box-shadow:0 0 0 1px rgba(15,23,42,.85),0 2px 8px rgba(0,0,0,.35);}",
            ".aes-afp-vwo-build:hover{filter:brightness(1.25);z-index:22;}"
        ].join("\n")
        document.head.appendChild(style)
    }

    function _toast(msg, tone) {
        const host = window.RouteAssistantToast
        const fn = host && (tone === "error" ? host.error
            : tone === "warn" ? host.warn
            : tone === "success" ? host.success
            : host.info)
        if (typeof fn === "function") {
            try { fn.call(host, msg); return } catch (_) {}
        }
        try { console.info("[AES AFP] " + msg) } catch (_) {}
    }

    function _attach() {
        if (_state.attached) return
        if (!window.AesAfp || !window.AesAfp.bus) {
            setTimeout(_attach, 80)
            return
        }
        _state.attached = true
        const bus = _bus()
        bus.on("ctx:ready", () => {
            _syncFromWaveApplier()
            _loadPresets().then(() => _scheduleRender(0))
            _scheduleRender(0)
        })
        bus.on("spec:resolved", payload => {
            _state.spec = payload && payload.spec || null
            _state.buildStale = !!_state.lastBuild
            _scheduleRender()
        })
        bus.on("candidates:updated", payload => {
            _state.candidates = payload && Array.isArray(payload.candidates) ? payload.candidates : []
            _state.buildStale = !!_state.lastBuild
            _scheduleRender()
        })
        bus.on("wave:built", payload => {
            if (payload && payload.build && payload.build.preset && payload.build.preset.id) {
                if (!_buildHasUsableFlights(payload.build)) {
                    _state.lastBuild = null
                    _state.buildStale = false
                    _scheduleRender(0)
                    return
                }
                _state.lastBuild = _buildWithUsableFlights(payload.build)
                _state.buildStale = false
                if (payload.build.preset && payload.build.preset.id) {
                    _state.selectedPresetId = payload.build.preset.id
                }
                _scheduleRender(0)
            }
        })
        bus.on("wavestrip:preset-changed", payload => {
            _state.selectedPresetId = payload && payload.presetId || null
            _scheduleRender(0)
        })
        bus.on("schedule:updated", () => _scheduleRender())

        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== "local") return
                if (Object.prototype.hasOwnProperty.call(changes, "settings")) {
                    _presetsPromise = null
                    _loadPresets().then(() => _scheduleRender())
                }
                if (Object.keys(changes || {}).some(k => k.indexOf("routeAssistant:topRoutes") === 0)) {
                    _state.routeMetricsByHub = Object.create(null)
                    _state.routeMetricsPromises = Object.create(null)
                    _scheduleRender()
                }
            })
        }
    }

    window.AesAfpVisualWaveOverlay = {
        attach: _attach,
        render: () => _scheduleRender(0),
        setEnabled(value) {
            _state.enabled = !!value
            _scheduleRender(0)
        },
        buildPlan: _buildPlanFromOverlay
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _attach, {once: true})
    } else {
        _attach()
    }
})()
