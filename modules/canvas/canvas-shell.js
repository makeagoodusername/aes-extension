"use strict"

/**
 * CanvasShell — top-level layout for the Schedule Canvas.
 *
 * Owns the visible chrome around the canvas:
 *   - Header: hub picker · view toggle (Waves|Timeline) · rail toggle · advanced toggle
 *   - Main pane: hosts the active renderer (wave-spine or legacy grid)
 *   - Rail slot: a fixed-width column on the right that Phase C+ fills
 *
 * The shell is rendering-only — state lives in `AesCanvasStateStore`. The
 * shell reads state on mount and on watch fires, and writes via save().
 *
 * Hosting: mounted by `fleet-schedule-grid/panel.js` into the modal body.
 * Could mount into a full-page surface in a later slice; the contract is
 * just `mount(hostEl)` and `dispose()`.
 *
 * Renderer plumbing: the shell does NOT import the legacy grid renderer
 * directly — the panel passes a `mountTimelineView(host)` callback that
 * mounts the existing FleetScheduleGridRenderer + side rail. This keeps
 * the legacy view path untouched and lets the shell stay agnostic about
 * what "Timeline" actually is.
 */
class CanvasShell {

    static VIEW_WAVES    = "waves"
    static VIEW_TIMELINE = "timeline"

    constructor(deps) {
        const d = deps || {}
        this.server      = d.server || ""
        this.airlineCode = d.airlineCode || ""
        this.fleet       = Array.isArray(d.fleet) ? d.fleet : []
        this.schedules   = d.schedules instanceof Map ? d.schedules : new Map()
        this.maintenance = d.maintenance instanceof Map ? d.maintenance : new Map()
        this.coloring    = d.coloring || null
        // Caller-provided hooks. The panel still owns the legacy timeline view
        // (existing grid renderer + side rail) — we just give it a host element.
        this.mountTimelineView   = typeof d.mountTimelineView   === "function" ? d.mountTimelineView   : null
        this.unmountTimelineView = typeof d.unmountTimelineView === "function" ? d.unmountTimelineView : null
        this.updateTimelineView  = typeof d.updateTimelineView  === "function" ? d.updateTimelineView  : null
        this.getPresetForHub     = typeof d.getPresetForHub     === "function" ? d.getPresetForHub     : null
        // Phase G — staging callback so cell drops + context-menu items can
        // route into the rail-controller's edit list.
        this.onStageEdits        = typeof d.onStageEdits        === "function" ? d.onStageEdits        : null

        this._rootEl       = null
        this._headerEl     = null
        this._mainEl       = null
        this._railEl       = null
        this._mainBodyEl   = null
        this._spineRenderer = null
        this._spineHostEl  = null
        this._dropBridge   = null
        this._contextMenu  = null
        this._demandOverlay = null
        this._orsTooltip    = null
        this._dndSourceDock = null
        this._dndSourcePanel = null
        this._stateUnwatch = null
        this._presetUnwatch = null
        this._state = null
    }

    async mount(hostEl) {
        if (!hostEl) return
        this._state = await window.AesCanvasStateStore.load()
        this._state = await this._reconcileActiveHub(this._state)

        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const root = document.createElement("div")
        root.className = "aes-canvas-shell"
        root.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "flex:1 1 auto",
            "min-width:0",
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520")
        ].join(";")

        const header = this._buildHeader(T)
        const split = document.createElement("div")
        split.style.cssText = "flex:1 1 auto;display:flex;flex-direction:row;min-width:0;min-height:0;"

        const main = document.createElement("div")
        main.className = "aes-canvas-main"
        main.style.cssText = "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden;"
        const mainBody = document.createElement("div")
        mainBody.style.cssText = "flex:1 1 auto;overflow:auto;"
        main.appendChild(mainBody)

        // Rail slot — fixed width when open; hidden when closed. Phase C
        // mounts content into this element via setRailContent().
        const rail = document.createElement("aside")
        rail.className = "aes-canvas-rail-slot"
        rail.setAttribute("aria-label", "Schedule Canvas assistant rail")
        rail.style.cssText = [
            "flex:0 0 320px",
            "min-width:320px",
            "max-width:320px",
            "border-left:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "background:" + (T ? T.color.bone2 : "#ECE7DC"),
            "display:" + (this._state.railOpen ? "flex" : "none"),
            "flex-direction:column",
            "overflow:hidden",
            "transition:background " + (T ? T.tr.medium : "260ms ease")
        ].join(";")

        split.append(main, rail)
        root.append(header, split)
        hostEl.appendChild(root)

        this._rootEl = root
        this._headerEl = header
        this._mainEl = main
        this._mainBodyEl = mainBody
        this._railEl = rail

        this._renderCurrentView()
        this._attachWatchers()
    }

    dispose() {
        if (this._stateUnwatch) { try { this._stateUnwatch() } catch (_) {} this._stateUnwatch = null }
        if (this._presetUnwatch) { try { this._presetUnwatch() } catch (_) {} this._presetUnwatch = null }
        if (this._dropBridge) { try { this._dropBridge.detach() } catch (_) {} this._dropBridge = null }
        if (this._contextMenu) { try { this._contextMenu.detach() } catch (_) {} this._contextMenu = null }
        this._teardownOverlays()
        if (this._state && this._state.view === CanvasShell.VIEW_TIMELINE && this.unmountTimelineView) {
            try { this.unmountTimelineView(this._mainBodyEl) } catch (_) {}
        }
        if (this._rootEl && this._rootEl.parentElement) {
            this._rootEl.parentElement.removeChild(this._rootEl)
        }
        this._rootEl = this._headerEl = this._mainEl = this._mainBodyEl = this._railEl = null
        this._spineRenderer = null
        this._spineHostEl = null
        this._demandOverlay = null
        this._orsTooltip = null
        this._dndSourceDock = null
        this._dndSourcePanel = null
    }

    /** Push fresh data through to whichever renderer is mounted. */
    update(deps) {
        if (!deps) return
        if (deps.fleet       !== undefined) this.fleet       = Array.isArray(deps.fleet) ? deps.fleet : []
        if (deps.schedules   !== undefined) this.schedules   = deps.schedules   instanceof Map ? deps.schedules   : new Map()
        if (deps.maintenance !== undefined) this.maintenance = deps.maintenance instanceof Map ? deps.maintenance : new Map()
        if (deps.coloring    !== undefined) this.coloring    = deps.coloring
        if (this._state && this._state.view === CanvasShell.VIEW_WAVES && this._spineRenderer) {
            this._spineRenderer.update({
                fleet:     this.fleet,
                schedules: this.schedules,
                coloring:  this.coloring,
                activeHub: this._state.activeHub,
                preset:    this._currentPreset(),
                focusedAircraftId: this._state.focusedAircraftId
            })
            this._spineRenderer.render()
            this._mountOverlays()
        }
        if (this._state && this._state.view === CanvasShell.VIEW_TIMELINE && this.updateTimelineView) {
            try {
                this.updateTimelineView({
                    fleet:       this.fleet,
                    schedules:   this.schedules,
                    maintenance: this.maintenance,
                    coloring:    this.coloring,
                    activeHub:   this._state.activeHub,
                    preset:      this._currentPreset(),
                    focusedAircraftId: this._state.focusedAircraftId
                })
            } catch (err) { console.warn("[AES Canvas] timeline update failed", err) }
        }
        if (this._dropBridge) {
            this._dropBridge.update({activeHub: this._state && this._state.activeHub, fleet: this.fleet})
        }
        if (this._contextMenu) {
            this._contextMenu.update({hub: this._state && this._state.activeHub, fleet: this.fleet, schedules: this.schedules})
        }
        if (this._dndSourcePanel) {
            if (typeof this._dndSourcePanel.update === "function") {
                this._dndSourcePanel.update({
                    activeHub: this._state && this._state.activeHub,
                    schedules: this.schedules,
                    fleet:     this.fleet
                })
            }
            if (typeof this._dndSourcePanel.refresh === "function") {
                const refreshed = this._dndSourcePanel.refresh()
                if (refreshed && typeof refreshed.catch === "function") refreshed.catch(() => {})
            }
        }
    }

    /** Phase C+: mount a node into the rail body. */
    setRailContent(node) {
        if (!this._railEl) return
        this._railEl.innerHTML = ""
        if (node) this._railEl.appendChild(node)
    }

    /** Returns the rail slot DOM so callers can mount their own structure. */
    getRailSlot() {
        return this._railEl
    }

    _buildHeader(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:12px",
            "padding:8px 12px",
            "background:" + (T ? T.color.bone2 : "#ECE7DC"),
            "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "font-size:11px"
        ].join(";")

        // Hub picker
        const hubLabel = document.createElement("span")
        hubLabel.style.cssText = "text-transform:uppercase;letter-spacing:0.06em;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        hubLabel.textContent = "Hub"
        const hubSel = document.createElement("select")
        hubSel.setAttribute("aria-label", "Active hub")
        hubSel.style.cssText = "padding:3px 6px;font-size:11px;border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";background:" + (T ? T.color.bone : "#F4F1EA") + ";color:" + (T ? T.color.oxide : "#2B2520") + ";font-family:" + (T ? T.font.mono : "monospace") + ";"
        for (const hub of this._listHubs()) {
            const o = document.createElement("option")
            o.value = hub
            o.textContent = hub
            if (hub === this._state.activeHub) o.selected = true
            hubSel.appendChild(o)
        }
        hubSel.addEventListener("change", () => this._setActiveHub(hubSel.value))
        wrap.append(hubLabel, hubSel)

        wrap.append(this._sep(T))

        // View toggle (Waves | Timeline)
        const viewToggle = this._buildSegmented(T,
            [
                {id: CanvasShell.VIEW_WAVES,    label: "Waves"},
                {id: CanvasShell.VIEW_TIMELINE, label: "Timeline"}
            ],
            this._state.view,
            (id) => this._setView(id))
        wrap.append(viewToggle)

        wrap.append(this._sep(T))

        // Rail toggle
        const railBtn = document.createElement("button")
        railBtn.type = "button"
        railBtn.textContent = this._state.railOpen ? "Hide assistant ▸" : "◂ Show assistant"
        railBtn.className = "aes-btn aes-btn--sm"
        railBtn.setAttribute("aria-label", this._state.railOpen ? "Hide assistant rail" : "Show assistant rail")
        railBtn.setAttribute("aria-pressed", this._state.railOpen ? "true" : "false")
        railBtn.title = "Toggle assistant rail (R)"
        railBtn.style.cssText = "font-size:10px;padding:4px 8px;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";background:" + (T ? T.color.bone : "#F4F1EA") + ";cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;"
            + "transition:background " + (T ? T.tr.fast : "150ms ease") + ";"
        railBtn.addEventListener("click", () => this._setRailOpen(!this._state.railOpen))
        wrap.append(railBtn)

        // Phase J — Advanced toggle. Pill that exposes a telemetry strip
        // under the wave spine.
        if (typeof window !== "undefined" && window.CanvasAdvancedToggle) {
            const advisorPrefs = (this._state && this._state.advisorPrefs) || {}
            const advBuilt = window.CanvasAdvancedToggle.build({
                initialOn: !!advisorPrefs.advancedOn,
                onToggle:  (on) => this._setAdvancedOn(on)
            })
            this._advancedBtn = advBuilt
            wrap.append(advBuilt.el)
        }

        // Filler + caption
        const cap = document.createElement("div")
        cap.style.cssText = "flex:1 1 auto;text-align:right;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;font-size:10px;"
        cap.textContent = "Wave is the canvas — drag to take over"
        wrap.append(cap)

        return wrap
    }

    _buildSegmented(T, options, activeId, onChange) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:inline-flex;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
        for (const opt of options) {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = opt.label
            const isActive = opt.id === activeId
            btn.style.cssText = [
                "padding:4px 10px",
                "font-size:10px",
                "text-transform:uppercase",
                "letter-spacing:0.06em",
                "border:0",
                "border-right:1px solid " + (T ? T.color.oxide : "#2B2520"),
                "background:" + (isActive ? (T ? T.color.oxide : "#2B2520") : (T ? T.color.bone : "#F4F1EA")),
                "color:" + (isActive ? (T ? T.color.boneFg || "#F4F1EA" : "#F4F1EA") : (T ? T.color.oxide : "#2B2520")),
                "cursor:pointer",
                "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
                "font-weight:" + (T ? T.fw.bold : "700")
            ].join(";")
            btn.addEventListener("click", () => onChange(opt.id))
            wrap.appendChild(btn)
        }
        // Strip the trailing border-right from the last child for a tidy edge.
        if (wrap.lastChild) wrap.lastChild.style.borderRight = "0"
        return wrap
    }

    _sep(T) {
        const s = document.createElement("div")
        s.style.cssText = "width:1px;height:18px;background:" + (T ? T.color.paperRule : "#C9C0B0") + ";"
        return s
    }

    _listHubs() {
        const set = new Set()
        for (const r of this.fleet) if (r && r.hub) set.add(String(r.hub).toUpperCase())
        return Array.from(set).sort()
    }

    /**
     * On first mount we may have no activeHub stored yet. Pick the first
     * hub we have aircraft for so the canvas isn't blank. If the stored
     * hub is no longer present (account switched, hub abandoned), reset
     * to the first available.
     */
    async _reconcileActiveHub(state) {
        const hubs = this._listHubs()
        if (state.activeHub && hubs.indexOf(state.activeHub) !== -1) return state
        if (!hubs.length) return state
        const next = Object.assign({}, state, {activeHub: hubs[0]})
        await window.AesCanvasStateStore.save({activeHub: hubs[0]})
        return next
    }

    async _setActiveHub(hub) {
        if (!hub || hub === this._state.activeHub) return
        this._state = Object.assign({}, this._state, {activeHub: hub})
        await window.AesCanvasStateStore.save({activeHub: hub})
        if (window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.HUB_CHANGED, {hub})
        }
        this._renderHeader()
        this._renderCurrentView()
        this._refreshTelemetryStrip().catch(() => {})
    }

    async _setView(view) {
        if (view !== CanvasShell.VIEW_WAVES && view !== CanvasShell.VIEW_TIMELINE) return
        if (view === this._state.view) return
        // Tear down whichever view is currently showing before mounting the
        // other — the legacy grid mounts its own DOM via the panel's
        // callback, so we need to give it a chance to dispose listeners.
        if (this._state.view === CanvasShell.VIEW_TIMELINE && this.unmountTimelineView) {
            try { this.unmountTimelineView(this._mainBodyEl) } catch (_) {}
        }
        this._state = Object.assign({}, this._state, {view})
        await window.AesCanvasStateStore.save({view})
        if (window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.VIEW_CHANGED, {view})
        }
        this._renderHeader()
        this._renderCurrentView()
    }

    async _setRailOpen(open) {
        const next = !!open
        if (next === this._state.railOpen) return
        this._state = Object.assign({}, this._state, {railOpen: next})
        await window.AesCanvasStateStore.save({railOpen: next})
        if (window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.RAIL_OPEN_CHANGED, {open: next})
        }
        if (this._railEl) this._railEl.style.display = next ? "flex" : "none"
        this._renderHeader()
    }

    async _setAdvancedOn(on) {
        const next = !!on
        const prefs = Object.assign({}, (this._state && this._state.advisorPrefs) || {}, {advancedOn: next})
        this._state = Object.assign({}, this._state, {advisorPrefs: prefs})
        try { await window.AesCanvasStateStore.save({advisorPrefs: {advancedOn: next}}) } catch (_) {}
        await this._refreshTelemetryStrip()
    }

    async _refreshTelemetryStrip() {
        const on = !!(this._state && this._state.advisorPrefs && this._state.advisorPrefs.advancedOn)
        // Strip lives under the spine in the wave view — only render in waves.
        if (!this._mainBodyEl || (this._state && this._state.view !== CanvasShell.VIEW_WAVES)) {
            if (this._telemetryStripEl && this._telemetryStripEl.parentElement) {
                this._telemetryStripEl.parentElement.removeChild(this._telemetryStripEl)
            }
            this._telemetryStripEl = null
            return
        }
        if (!on) {
            if (this._telemetryStripEl && this._telemetryStripEl.parentElement) {
                this._telemetryStripEl.parentElement.removeChild(this._telemetryStripEl)
            }
            this._telemetryStripEl = null
            return
        }
        if (!this._telemetryStripEl) {
            const strip = document.createElement("div")
            this._telemetryStripEl = strip
            // Insert at the top of the main body so it sits between the
            // header and the spine — ahead of the destinations dock.
            this._mainBodyEl.insertBefore(strip, this._mainBodyEl.firstChild)
        }
        if (typeof window === "undefined" || !window.CanvasAdvancedToggle) return
        const hub = this._state && this._state.activeHub
        const [topRoutes, demand] = await Promise.all([
            window.CanvasAdvancedToggle.readTopRoutesFreshness(hub),
            window.CanvasAdvancedToggle.readDemandFreshness(hub)
        ])
        const preset = this._currentPreset()
        await window.CanvasAdvancedToggle.renderStrip(this._telemetryStripEl, {
            hub,
            fleetCount:    this.fleet.length,
            scheduleCount: this.schedules ? this.schedules.size : 0,
            topRoutes,
            demand,
            preset:        preset
                ? {name: preset.name, waveCount: (preset.waves || []).length}
                : null
        })
    }

    _renderHeader() {
        if (!this._headerEl || !this._rootEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const next = this._buildHeader(T)
        this._rootEl.replaceChild(next, this._headerEl)
        this._headerEl = next
    }

    _renderCurrentView() {
        if (!this._mainBodyEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        if (this._state.view === CanvasShell.VIEW_TIMELINE) {
            if (this._dropBridge) { try { this._dropBridge.detach() } catch (_) {} this._dropBridge = null }
            if (this._contextMenu) { try { this._contextMenu.detach() } catch (_) {} this._contextMenu = null }
            this._teardownOverlays()
            if (this.unmountTimelineView) {
                try { this.unmountTimelineView(this._mainBodyEl) } catch (_) {}
            }
            this._mainBodyEl.innerHTML = ""
            if (this.mountTimelineView) {
                try { this.mountTimelineView(this._mainBodyEl, this._state) }
                catch (err) { console.warn("[AES Canvas] timeline mount failed", err) }
            } else {
                this._mainBodyEl.appendChild(this._buildPlaceholder("Timeline view unavailable in this surface."))
            }
            this._spineRenderer = null
            return
        }
        // Default: waves view
        if (this.unmountTimelineView) {
            try { this.unmountTimelineView(this._mainBodyEl) } catch (_) {}
        }
        // Tear down any drop/context wiring from a prior render.
        if (this._dropBridge) { try { this._dropBridge.detach() } catch (_) {} this._dropBridge = null }
        if (this._contextMenu) { try { this._contextMenu.detach() } catch (_) {} this._contextMenu = null }
        this._teardownOverlays()
        this._mainBodyEl.innerHTML = ""
        const inner = document.createElement("div")
        inner.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:0;"
        this._mainBodyEl.appendChild(inner)
        const spineHost = document.createElement("div")
        inner.appendChild(spineHost)
        this._spineHostEl = spineHost

        this._spineRenderer = new CanvasWaveSpineRenderer({
            rootEl:    spineHost,
            fleet:     this.fleet,
            schedules: this.schedules,
            coloring:  this.coloring,
            activeHub: this._state.activeHub,
            preset:    this._currentPreset(),
            focusedAircraftId: this._state.focusedAircraftId
        })
        this._spineRenderer.render()
        // Forward cell/aircraft/wave clicks onto the bus so other modules
        // (advisor, builder) can react without depending on the renderer.
        spineHost.addEventListener(CanvasWaveSpineRenderer.EVENT_AIRCRAFT_CLICK, (e) => {
            if (window.CentralHubBus && e && e.detail) {
                window.CentralHubBus.emit(window.AesCanvasEvents.FOCUS_AIRCRAFT, {aircraftId: e.detail.aircraftId})
            }
        })
        spineHost.addEventListener(CanvasWaveSpineRenderer.EVENT_WAVE_CLICK, (e) => {
            if (window.CentralHubBus && e && e.detail) {
                window.CentralHubBus.emit(window.AesCanvasEvents.FOCUS_WAVE, e.detail)
            }
        })
        spineHost.addEventListener(CanvasWaveSpineRenderer.EVENT_OPEN_TIMELINE, () => {
            this._setView(CanvasShell.VIEW_TIMELINE).catch(err =>
                console.warn("[AES Canvas] timeline switch failed", err))
        })

        // Phase G: drop bridge + context menu + drag-source dock. Only mount
        // them when the wave renderer produced real schedule cells; otherwise
        // the UI implies drops that cannot land anywhere.
        if (this._hasWaveScheduleCells()) {
            this._mountDestinationsDock(inner, T)
            this._wireSpineActions()
            this._mountOverlays()
        }

        // Phase J: telemetry strip (Advanced toggle).
        this._refreshTelemetryStrip().catch(e => console.warn("[AES Canvas] strip refresh failed", e))
    }

    _hasWaveScheduleCells() {
        return !!(this._spineHostEl && this._spineHostEl.querySelector("[data-canvas-aircraft-id][data-canvas-wave-id]"))
    }

    _mountOverlays() {
        if (!this._spineHostEl) return
        this._teardownOverlays()
        const common = {
            spineHostEl: this._spineHostEl,
            activeHub:   this._state && this._state.activeHub,
            fleet:       this.fleet,
            schedules:   this.schedules,
            preset:      this._currentPreset()
        }
        if (typeof window !== "undefined" && window.CanvasDemandOverlay) {
            try {
                this._demandOverlay = new window.CanvasDemandOverlay(common)
                this._demandOverlay.paint().catch(e =>
                    console.warn("[AES Canvas] demand overlay failed", e))
            } catch (e) {
                console.warn("[AES Canvas] demand overlay mount failed", e)
            }
        }
        if (typeof window !== "undefined" && window.CanvasOrsTooltip) {
            try {
                this._orsTooltip = new window.CanvasOrsTooltip(common)
                this._orsTooltip.attach()
            } catch (e) {
                console.warn("[AES Canvas] ORS tooltip mount failed", e)
            }
        }
    }

    _teardownOverlays() {
        if (this._orsTooltip && typeof this._orsTooltip.detach === "function") {
            try { this._orsTooltip.detach() } catch (_) {}
        }
        this._orsTooltip = null
        this._demandOverlay = null
    }

    _mountDestinationsDock(parentEl, T) {
        if (typeof window === "undefined" || typeof window.FleetScheduleGridDndSourcePanel === "undefined") {
            return
        }
        const dock = document.createElement("div")
        dock.style.cssText = "margin-top:12px;border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
        const head = document.createElement("div")
        head.style.cssText = "padding:6px 12px;font-size:10px;font-weight:" + (T ? T.fw.bold : "700") + ";"
            + "letter-spacing:0.08em;text-transform:uppercase;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        head.textContent = "Destinations — drag onto a cell to schedule"
        dock.appendChild(head)
        const panel = new window.FleetScheduleGridDndSourcePanel({
            server: this.server, airlineCode: this.airlineCode,
            activeHub: this._state && this._state.activeHub,
            schedules: this.schedules,
            fleet: this.fleet
        })
        dock.appendChild(panel.buildPane())
        parentEl.appendChild(dock)
        // Render the watchlist + custom rows now that the pane is mounted.
        try { panel.refresh() } catch (_) {}
        this._dndSourceDock = dock
        this._dndSourcePanel = panel
    }

    _wireSpineActions() {
        if (!this._spineHostEl) return
        if (typeof window !== "undefined" && window.CanvasDropBridge) {
            this._dropBridge = new window.CanvasDropBridge({
                spineHostEl: this._spineHostEl,
                activeHub:   this._state.activeHub,
                fleet:       this.fleet,
                onDrop:      (drop) => this._onCellDrop(drop)
            })
            this._dropBridge.attach()
        }
        if (typeof window !== "undefined" && window.CanvasCellContextMenu) {
            this._contextMenu = window.CanvasCellContextMenu.install({
                spineHostEl: this._spineHostEl,
                hub:         this._state.activeHub,
                fleet:       this.fleet,
                schedules:   this.schedules,
                onStage:     (edit) => this._stageEdit(edit)
            })
        }
    }

    _onCellDrop(drop) {
        if (!drop || !drop.kind) return
        if (drop.kind === "addRoute") {
            this._stageEdit({
                kind:    "addRoute",
                payload: {
                    aircraftId: drop.aircraftId,
                    waveId:     drop.waveId,
                    destIata:   drop.destIata,
                    destName:   drop.destName,
                    fares:      drop.fares || {},
                    pricePct:   drop.pricePct,
                    service:    drop.service || "",
                    flightNumberText: drop.flightNumberText || "",
                    depTimeLocal:     drop.depTimeLocal || drop.depTime || null,
                    depTime:          drop.depTime || drop.depTimeLocal || null,
                    replaceExisting:  !!drop.replaceExisting,
                    hub:        drop.hub || this._state.activeHub
                }
            })
        } else if (drop.kind === "moveRoute") {
            this._stageEdit({
                kind:    "moveRoute",
                payload: {
                    aircraftId:       drop.aircraftId,
                    waveId:           drop.waveId,
                    destIata:         drop.destIata,
                    destName:         drop.destName,
                    sourceAircraftId: drop.sourceAircraftId || null,
                    sourceWaveId:     drop.sourceWaveId || null,
                    sourceLegSeq:     drop.sourceLegSeq != null ? drop.sourceLegSeq : null,
                    flightId:         drop.flightId || null,
                    flightNumber:     drop.flightNumber || null,
                    flightNumberText: drop.flightNumberText || "",
                    depTimeLocal:     drop.depTimeLocal || null,
                    replaceExisting:  !!drop.replaceExisting,
                    hub:              drop.hub || this._state.activeHub
                }
            })
        }
    }

    _stageEdit(edit) {
        if (!edit) return
        this._syncEditToDraft(edit).catch(err =>
            console.warn("[AES Canvas] draft sync failed", err))
        if (this.onStageEdits) {
            try { this.onStageEdits([edit], {source: "canvas-cell"}) } catch (_) {}
            return
        }
        // Fallback: fire on the bus so the rail-controller (or any other
        // listener) can pick it up. The controller already listens for
        // EDIT_STAGED to keep its mode-flip logic in sync.
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_STAGED,
                {kind: edit.kind, payload: edit.payload})
        }
    }

    async _syncEditToDraft(edit) {
        if (typeof window === "undefined" || !window.AesAfpActiveDraftStore) return
        if (!this.server) return
        const kind = edit && edit.kind
        const p = edit && edit.payload ? edit.payload : edit
        if (!p || !p.aircraftId) return
        if (kind === "addRoute") {
            await this._upsertDraftFlight(p)
        } else if (kind === "moveRoute") {
            await this._syncMoveRoute(p)
        } else if (kind === "removeRoute") {
            const seq = p.sourceLegSeq != null ? p.sourceLegSeq : p.seq
            if (seq != null) {
                await window.AesAfpActiveDraftStore.setDismissed(
                    this.server, p.aircraftId, seq, Date.now())
            }
        }
    }

    async _syncMoveRoute(payload) {
        const p = payload || {}
        const sourceAircraftId = p.sourceAircraftId != null ? String(p.sourceAircraftId) : ""
        const targetAircraftId = p.aircraftId != null ? String(p.aircraftId) : ""
        const sourceSeq = p.sourceLegSeq != null ? p.sourceLegSeq : null
        if (sourceAircraftId && sourceSeq != null && sourceAircraftId === targetAircraftId) {
            const wave = this._findWaveById(p.waveId)
            const patch = {
                waveId:           p.waveId || null,
                waveLabel:        (wave && (wave.label || wave.name)) || p.waveId || "",
                destination:      p.destIata || p.destination || null
            }
            if (p.depTimeLocal || p.depTime) patch.depTimeLocal = p.depTimeLocal || p.depTime
            if (p.flightNumberText != null) {
                patch.flightNumberText = this._cleanFlightNumberText(p.flightNumberText)
            }
            await window.AesAfpActiveDraftStore.setEdit(this.server, targetAircraftId, sourceSeq, patch)
            return
        }
        if (sourceAircraftId && sourceSeq != null) {
            await window.AesAfpActiveDraftStore.setDismissed(
                this.server, sourceAircraftId, sourceSeq, Date.now())
        }
        await this._upsertDraftFlight(Object.assign({}, p, {kind: "addRoute"}))
    }

    async _upsertDraftFlight(payload) {
        const p = payload || {}
        const aircraftId = p.aircraftId != null ? String(p.aircraftId) : ""
        const dest = String(p.destIata || p.destination || "").toUpperCase()
        if (!aircraftId || !/^[A-Z]{3}$/.test(dest)) return
        const store = window.AesAfpActiveDraftStore
        const cur = await store.load(this.server, aircraftId)
        const flights = Array.isArray(cur.flights) ? cur.flights.slice() : []
        const wave = this._findWaveById(p.waveId)
        const hub = String(p.hub || cur.hub || this._state.activeHub || (this._currentPreset() && this._currentPreset().hub) || "").toUpperCase()
        const depTime = p.depTimeLocal || p.depTime
            || (wave && wave.departureWindow && wave.departureWindow.start)
            || "09:00"
        const key = this._draftFlightKey({aircraftId, waveId: p.waveId, destIata: dest, sourceLegSeq: p.sourceLegSeq})
        let idx = flights.findIndex(f => f && f._canvasKey === key)
        if (idx < 0 && p.sourceLegSeq != null) {
            idx = flights.findIndex(f => f && String(f.seq) === String(p.sourceLegSeq))
        }
        const seq = idx >= 0 && flights[idx] && flights[idx].seq != null
            ? flights[idx].seq
            : this._nextDraftSeq(flights)
        const pricePct = Number(p.pricePct)
        const next = Object.assign({}, idx >= 0 ? flights[idx] : {}, {
            seq,
            _canvasKey:        key,
            _canvasSource:     "schedule-canvas",
            direction:         "outbound",
            waveId:            p.waveId || null,
            waveLabel:         (wave && (wave.label || wave.name)) || p.waveId || "",
            origin:            hub || p.origin || "",
            destination:       dest,
            destIata:          dest,
            destName:          p.destName || "",
            depTimeLocal:      depTime,
            pricePct:          Number.isFinite(pricePct) && pricePct > 0 ? pricePct : 100,
            service:           typeof p.service === "string" ? p.service : "",
            flightNumberText:  this._cleanFlightNumberText(p.flightNumberText),
            sourceFlightId:    p.flightId || null,
            sourceFlightNumber: p.flightNumber || null
        })
        if (idx >= 0) flights[idx] = next
        else flights.push(next)
        await store.save(this.server, aircraftId, {
            hub:         hub || cur.hub || null,
            presetId:    (this._currentPreset() && this._currentPreset().id) || cur.presetId || null,
            generatedAt: cur.generatedAt || Date.now(),
            flights
        })
    }

    _draftFlightKey(p) {
        return [
            p.aircraftId || "",
            p.waveId || "",
            p.destIata || "",
            p.sourceLegSeq != null ? String(p.sourceLegSeq) : ""
        ].join(":")
    }

    _nextDraftSeq(flights) {
        let max = 0
        for (const f of flights || []) {
            const n = Number(f && f.seq)
            if (Number.isFinite(n) && n > max) max = n
        }
        return max + 1
    }

    _findWaveById(waveId) {
        const preset = this._currentPreset()
        if (!waveId || !preset || !Array.isArray(preset.waves)) return null
        return preset.waves.find(w => w && String(w.id) === String(waveId)) || null
    }

    _cleanFlightNumberText(value) {
        return String(value || "").replace(/[^0-9]/g, "").slice(0, 4)
    }

    _buildPlaceholder(message) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const el = document.createElement("div")
        el.style.cssText = "padding:32px;text-align:center;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        el.textContent = message
        return el
    }

    /** Resolve the active preset for the active hub via the caller hook. */
    _currentPreset() {
        if (!this.getPresetForHub) return null
        try { return this.getPresetForHub(this._state.activeHub) }
        catch (_) { return null }
    }

    _attachWatchers() {
        // Cross-tab state sync. Another tab editing the same account's
        // canvas state should make this canvas re-read and re-render.
        this._stateUnwatch = window.AesCanvasStateStore.watch((next) => {
            this._state = next || window.AesCanvasStateStore.defaults()
            if (this._railEl) this._railEl.style.display = this._state.railOpen ? "flex" : "none"
            this._renderHeader()
            this._renderCurrentView()
        })
    }
}

if (typeof window !== "undefined") {
    window.CanvasShell = CanvasShell
}
