"use strict"

/**
 * Schedule Canvas — full-screen modal entry.
 *
 * Sibling to FleetScheduleGridPanel. The legacy panel keeps its time-axis
 * grid + side-rail layout untouched; this modal hosts the new wave-spine
 * canvas + assistant rail. Both modals are launchable from the fleet
 * management page; the canvas's "Timeline" view toggle hands off to the
 * legacy panel via close-and-reopen, so users have one fluid back-and-forth
 * between the two views.
 *
 * Single-instance: opening twice closes the previous instance first. ESC
 * closes; backdrop click closes; explicit X closes.
 *
 * Loads fleet + schedules via the same paths the legacy panel uses
 * (FleetHubAircraftAggregator → fleet roster, AesAfpScheduleStore →
 * stored Schedule per aircraft). No new scrape pipeline; the canvas
 * surfaces what's already in storage and renders empty cells where data
 * is missing.
 */
class CanvasModal {

    static OVERLAY_CLASS = "aes-canvas-modal-overlay"
    static _active = null
    static _lastOpenSig = null
    static _lastOpenAt  = 0

    static async open(opts) {
        const o = opts || {}
        // F-9224-LIVE-002 — Fleet Hub Command Center's Build-wave-schedule
        // button both emits open-tile AND directly invokes CanvasModal.open
        // for fallback. When the fleet-schedule-grid host is listening (the
        // common case on /app/fleets), the modal opens, immediately closes,
        // and reopens — a perceptible flicker. Dedupe back-to-back opens
        // with the same selectedHub/selectedAircraftId/railMode signature
        // within a short window: if the active modal already matches, skip.
        const sig = [
            o.server || "",
            o.airlineCode || "",
            o.selectedHub || "",
            o.selectedAircraftId != null ? String(o.selectedAircraftId) : "",
            o.railMode || ""
        ].join("␞")
        const now = Date.now()
        if (CanvasModal._active
            && CanvasModal._lastOpenSig === sig
            && now - CanvasModal._lastOpenAt < 250) {
            return CanvasModal._active
        }
        CanvasModal._lastOpenSig = sig
        CanvasModal._lastOpenAt  = now
        if (CanvasModal._active) CanvasModal._active.close()
        const m = new CanvasModal(o)
        CanvasModal._active = m
        await m._mount()
        return m
    }

    static close() {
        if (CanvasModal._active) CanvasModal._active.close()
    }

    constructor(deps) {
        const d = deps || {}
        this.server      = d.server || ""
        this.airlineCode = d.airlineCode || ""
        this._initialHub        = d.selectedHub || null
        this._initialAircraftId = d.selectedAircraftId != null ? String(d.selectedAircraftId) : null
        this._initialRailMode   = d.railMode || null

        this.fleet     = []
        this.schedules = new Map()
        this.maintenance = new Map()
        this.coloring  = null
        this._presets  = []  // SchedulePresets list, reloaded on demand
        this._afpSettings = null

        this._overlayEl  = null
        this._bodyEl     = null
        this._statusEl   = null
        this._shell      = null
        this._timelineSurface = null
        this._keydownHandler = null
        this._scheduleUnwatch = null
        this._scheduleScraper = null
    }

    async _mount() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const overlay = document.createElement("div")
        overlay.className = CanvasModal.OVERLAY_CLASS
        overlay.setAttribute("role", "dialog")
        overlay.setAttribute("aria-modal", "true")
        overlay.setAttribute("aria-label", "Schedule Canvas")
        overlay.style.cssText = [
            "position:fixed",
            "inset:0",
            "background:rgba(20,18,15,0.62)",
            "z-index:" + (T ? T.z.modal : 10000),
            "display:flex",
            "align-items:stretch",
            "justify-content:center",
            "padding:24px",
            "box-sizing:border-box"
        ].join(";")
        overlay.addEventListener("click", e => { if (e.target === overlay) this.close() })

        const modal = document.createElement("div")
        modal.style.cssText = [
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "border:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "border-radius:0",
            "flex:1 1 auto",
            "max-width:1600px",
            "display:flex",
            "flex-direction:column",
            "overflow:hidden",
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-size:" + (T ? T.fs.body : "12px")
        ].join(";")

        modal.appendChild(this._buildHeader(T))

        const body = document.createElement("div")
        body.style.cssText = "flex:1 1 auto;display:flex;flex-direction:column;overflow:hidden;min-height:0;"
        modal.appendChild(body)
        this._bodyEl = body

        overlay.appendChild(modal)
        document.body.appendChild(overlay)
        this._overlayEl = overlay

        // Phase K — modal-scoped keyboard shortcuts. Skip when the user is
        // typing in an input/textarea so single-letter keys (B, T, R) don't
        // hijack search boxes.
        this._keydownHandler = (e) => this._onKeydown(e)
        document.addEventListener("keydown", this._keydownHandler, true)

        // Apply deep-link state BEFORE the shell loads its state — so the
        // shell observes the right active hub on first render.
        if (this._initialHub) {
            try { await window.AesCanvasStateStore.save({activeHub: this._initialHub}) }
            catch (_) {}
        }
        if (this._initialAircraftId) {
            try { await window.AesCanvasStateStore.save({focusedAircraftId: this._initialAircraftId}) }
            catch (_) {}
        }
        if (this._initialRailMode === "builder" || this._initialRailMode === "advisor") {
            try { await window.AesCanvasStateStore.save({railMode: this._initialRailMode, railOpen: true}) }
            catch (_) {}
        }

        this._setStatus("Loading fleet…")
        await this._loadFleet()
        await this._loadSchedules()
        this._fillMissingFleetHubsFromSchedules()
        await this._loadMaintenance()
        await this._loadPresets()
        this._buildColoring()
        this._setStatus(this.fleet.length + " aircraft · " + this.schedules.size + " schedules")

        this._shell = new CanvasShell({
            server:      this.server,
            airlineCode: this.airlineCode,
            fleet:       this.fleet,
            schedules:   this.schedules,
            maintenance: this.maintenance,
            coloring:    this.coloring,
            mountTimelineView:   (host, state) => this._mountTimelineSurface(host, state),
            unmountTimelineView: (host) => this._unmountTimelineSurface(host),
            updateTimelineView:  (deps) => this._updateTimelineSurface(deps),
            getPresetForHub:     (hub) => this._presetForHub(hub),
            onStageEdits:        (edits, info) => {
                if (this._railController && typeof this._railController.stageEdits === "function") {
                    this._railController.stageEdits(edits, info)
                }
            }
        })
        await this._shell.mount(body)

        // Mount the assistant rail into the shell's rail slot. The rail
        // controller owns Builder + Advisor mode bodies and the staged-edit
        // commit flow.
        await this._mountRail()

        // React to schedule store changes from any tab, then refresh against
        // the same actual-schedule scraper used by the Fleet Schedule Grid.
        this._wireScheduleWatcher()
        this._refreshActualSchedules({force: false}).catch(err =>
            console.warn("[AES Canvas] actual schedule refresh failed", err))

        // Phase J — first-run overlay. Mounts inside the modal body so it
        // appears over the canvas chrome but inside the modal frame.
        if (typeof window !== "undefined" && window.CanvasFirstRunOverlay) {
            try { window.CanvasFirstRunOverlay.maybeShow({hostEl: this._bodyEl}) }
            catch (err) { console.warn("[AES Canvas] first-run overlay threw", err) }
        }
    }

    async _mountRail() {
        if (!this._shell || typeof window === "undefined" || typeof window.CanvasRailController === "undefined") return
        const railSlot = this._shell.getRailSlot ? this._shell.getRailSlot() : null
        if (!railSlot) return
        // Mirror the persisted state into a sticky cache so the rail mount
        // reads the right initial mode without an extra async load.
        try {
            window.__aesCanvasLastState = await window.AesCanvasStateStore.load()
        } catch (_) {}
        this._railController = new window.CanvasRailController({
            server:      this.server,
            airlineCode: this.airlineCode,
            ensurePresetForHub: async (hub) => {
                const preset = await this._ensureStarterPresetForHub(hub)
                if (preset) {
                    if (this._shell && typeof this._shell._renderCurrentView === "function") {
                        this._shell._renderCurrentView()
                    }
                    if (this._shell && typeof this._shell._refreshTelemetryStrip === "function") {
                        this._shell._refreshTelemetryStrip().catch(() => {})
                    }
                }
                return preset
            },
            getInputs:   () => ({
                hub:         (window.__aesCanvasLastState && window.__aesCanvasLastState.activeHub) || null,
                fleet:       this.fleet,
                schedules:   this.schedules,
                maintenance: this.maintenance,
                preset:      this._presetForHub((window.__aesCanvasLastState && window.__aesCanvasLastState.activeHub) || null)
            }),
            onRailClose: async () => {
                try { await window.AesCanvasStateStore.save({railOpen: false}) } catch (_) {}
                if (this._shell && this._shell._setRailOpen) await this._shell._setRailOpen(false)
            }
        })
        this._railController.mount(railSlot)
        // Re-run builder when the canvas hub changes — the controller already
        // wires HUB_CHANGED on the bus; the canvas-shell emits it on hub
        // picker change.
    }

    close() {
        if (this._keydownHandler) {
            document.removeEventListener("keydown", this._keydownHandler, true)
            this._keydownHandler = null
        }
        if (this._scheduleUnwatch) { try { this._scheduleUnwatch() } catch (_) {} this._scheduleUnwatch = null }
        if (this._scheduleScraper) { try { this._scheduleScraper.abort() } catch (_) {} this._scheduleScraper = null }
        if (this._railController) { try { this._railController.dispose() } catch (_) {} this._railController = null }
        this._unmountTimelineSurface(null)
        if (this._shell) { try { this._shell.dispose() } catch (_) {} this._shell = null }
        if (this._overlayEl && this._overlayEl.parentElement) {
            this._overlayEl.parentElement.removeChild(this._overlayEl)
        }
        this._overlayEl = this._bodyEl = this._statusEl = null
        if (CanvasModal._active === this) CanvasModal._active = null
    }

    _buildHeader(T) {
        const h = document.createElement("div")
        h.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:12px",
            "padding:10px 16px",
            "background:" + (T ? T.color.bone3 : "#E0DAC8"),
            "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520")
        ].join(";")

        const title = document.createElement("h2")
        title.style.cssText = [
            "margin:0",
            "font-size:" + (T ? T.fs.lead : "14px"),
            "font-weight:" + (T ? T.fw.display : "800"),
            "text-transform:uppercase",
            "letter-spacing:0.08em",
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "flex:0 0 auto"
        ].join(";")
        title.textContent = "Schedule Canvas"

        const subtitle = document.createElement("div")
        subtitle.style.cssText = "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";flex:0 0 auto;"
        subtitle.textContent = this.airlineCode || ""

        const status = document.createElement("div")
        status.style.cssText = [
            "flex:1 1 auto",
            "font-size:11px",
            "color:" + (T ? T.color.slate : "#7A6F66"),
            "font-family:" + (T ? T.font.mono : "monospace"),
            "text-align:right"
        ].join(";")
        status.textContent = "Initializing…"
        this._statusEl = status

        const close = document.createElement("button")
        close.type = "button"
        close.textContent = "× Close"
        close.title = "Close (Esc) · ? for shortcuts"
        close.style.cssText = [
            "padding:4px 10px",
            "cursor:pointer",
            "font-size:11px",
            "border:1px solid " + (T ? T.color.oxide : "#2B2520"),
            "border-radius:0",
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "text-transform:uppercase",
            "letter-spacing:0.06em",
            "font-weight:700",
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520")
        ].join(";")
        close.addEventListener("click", () => this.close())

        h.append(title, subtitle, status, close)
        return h
    }

    _setStatus(text) {
        if (this._statusEl) this._statusEl.textContent = text
    }

    _onKeydown(e) {
        if (e.key === "Escape") {
            if (typeof CanvasShortcutsLegend !== "undefined" && CanvasShortcutsLegend._active) {
                e.preventDefault(); CanvasShortcutsLegend.dismiss(); return
            }
            if ((typeof FleetScheduleGridFlightInspector !== "undefined" && FleetScheduleGridFlightInspector._active)
                    || (typeof FleetScheduleGridDropPopover !== "undefined" && FleetScheduleGridDropPopover._active)
                    || (typeof CanvasCellContextMenu !== "undefined" && CanvasCellContextMenu._active)) {
                return
            }
            e.preventDefault(); this.close(); return
        }
        // `?` legend toggle. `?` arrives as e.key === "?" on US layouts (Shift+/).
        // Allow Shift modifier (required to type ?), block other modifiers.
        if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const tgt = e.target
            const tag = tgt && tgt.tagName ? tgt.tagName.toUpperCase() : ""
            const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
                || (tgt && tgt.isContentEditable)
            if (editable) return
            e.preventDefault()
            if (typeof CanvasShortcutsLegend !== "undefined") {
                CanvasShortcutsLegend.toggle({hostEl: this._bodyEl})
            }
            return
        }
        // Skip text-input contexts so the user can search/edit normally.
        const tgt = e.target
        const tag = tgt && tgt.tagName ? tgt.tagName.toUpperCase() : ""
        const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
            || (tgt && tgt.isContentEditable)
        if (editable) return
        // Cmd/Ctrl+Enter → commit
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            if (this._railController && typeof this._railController._onCommit === "function") {
                this._railController._onCommit()
            }
            return
        }
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
        if (e.key === "b" || e.key === "B") {
            e.preventDefault()
            if (this._railController && this._railController._railShell) {
                const cur = this._railController._railShell.mode
                const next = cur === "advisor" ? "builder" : "advisor"
                this._railController._railShell.setMode(next)
                this._railController._onModeChange(next)
            }
            return
        }
        if (e.key === "t" || e.key === "T") {
            e.preventDefault()
            if (this._shell) {
                const cur = this._shell._state && this._shell._state.view
                const next = cur === "timeline" ? "waves" : "timeline"
                this._shell._setView(next)
            }
            return
        }
        if (e.key === "r" || e.key === "R") {
            e.preventDefault()
            if (this._shell) {
                const cur = !!(this._shell._state && this._shell._state.railOpen)
                this._shell._setRailOpen(!cur)
            }
            return
        }
    }

    /**
     * Load the fleet roster the same way the legacy panel does — through
     * FleetHubAircraftAggregator.enrich when available (gives hub + locIata),
     * falling back to AesFleetRoster.
     */
    async _loadFleet() {
        this._resolveRuntimeContext()
        try {
            const fleet = await this._readFleetRows()
            if (typeof FleetHubAircraftAggregator !== "undefined" && (this.airlineCode || fleet.length)) {
                this.fleet = await FleetHubAircraftAggregator.enrich({
                    server: this.server, airlineCode: this.airlineCode, fleet
                })
                this._mergeRawFleetLocations(fleet)
                if (this.fleet.length) return
            }
            if (fleet.length) {
                this.fleet = fleet.map(a => ({
                    aircraftId:   a.aircraftId,
                    registration: a.registration || "",
                    equipment:    a.equipment || "",
                    typeId:       a.typeId || null,
                    hub:          a.location || a.hub || null,
                    locIata:      a.location || a.locIata || null
                }))
                return
            }
            if (typeof AesFleetRoster !== "undefined") {
                const fleet = await AesFleetRoster.loadCurrent()
                this.fleet = (fleet && fleet.aircraft || []).map(a => ({
                    aircraftId:    a.aircraftId,
                    registration:  a.registration || "",
                    equipment:     a.equipment || "",
                    typeId:        a.typeId || null,
                    hub:           null,
                    locIata:       null
                }))
                return
            }
        } catch (e) {
            console.warn("[AES Canvas] fleet load failed", e)
        }
        this.fleet = []
    }

    _mergeRawFleetLocations(rawFleet) {
        if (!Array.isArray(rawFleet) || !Array.isArray(this.fleet) || !this.fleet.length) return
        const rawById = new Map(rawFleet.map(r => [String(r && r.aircraftId), r]))
        for (const row of this.fleet) {
            if (!row || row.aircraftId == null) continue
            const raw = rawById.get(String(row.aircraftId))
            const loc = String((raw && (raw.location || raw.hub || raw.locIata)) || "").toUpperCase()
            if (/^[A-Z]{3}$/.test(loc)) {
                if (!row.locIata) row.locIata = loc
                if (!row.hub) row.hub = loc
            }
        }
    }

    _fillMissingFleetHubsFromSchedules() {
        if (!this.fleet || !this.fleet.length || !this.schedules || !this.schedules.size) return
        for (const row of this.fleet) {
            if (!row || row.hub) continue
            const schedule = this.schedules.get(String(row.aircraftId))
            const hub = this._inferHubFromSchedule(schedule)
            if (hub) {
                row.hub = hub
                if (!row.locIata) row.locIata = hub
                row.derivedFrom = row.derivedFrom || "schedule"
            }
        }
    }

    _inferHubFromSchedule(schedule) {
        if (!schedule || !Array.isArray(schedule.legs)) return null
        const counts = new Map()
        for (const leg of schedule.legs) {
            for (const value of [leg && leg.origin, leg && leg.destination]) {
                const iata = String(value || "").toUpperCase()
                if (/^[A-Z]{3}$/.test(iata)) counts.set(iata, (counts.get(iata) || 0) + 1)
            }
        }
        let best = null
        let bestCount = 0
        for (const [iata, count] of counts) {
            if (count > bestCount) {
                best = iata
                bestCount = count
            }
        }
        return best
    }

    _resolveRuntimeContext() {
        if (!this.server) {
            try {
                if (typeof AES !== "undefined" && AES && typeof AES.getServerName === "function") {
                    this.server = AES.getServerName() || ""
                }
            } catch (_) {}
        }
        if (!this.server && typeof location !== "undefined" && location.hostname) {
            const m = /^([^.]+)\.airlinesim\.aero$/i.exec(location.hostname)
            if (m) this.server = m[1]
        }
        if (!this.airlineCode) {
            try {
                if (typeof fltmng_getAirlineName === "function") this.airlineCode = fltmng_getAirlineName() || ""
            } catch (_) {}
        }
    }

    async _readFleetRows() {
        const out = await this._readStoredFleetRows()
        if (out.length) return out
        if (typeof aircraftData !== "undefined" && Array.isArray(aircraftData)) {
            return aircraftData.filter(a => a && a.aircraftId != null)
        }
        return []
    }

    async _readStoredFleetRows() {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return []
        const preferredKey = this.server && this.airlineCode
            ? this.server + this.airlineCode + "aircraftFleet"
            : null
        try {
            if (preferredKey) {
                const blob = await chrome.storage.local.get([preferredKey])
                const rec = blob && blob[preferredKey]
                if (rec && Array.isArray(rec.fleet) && rec.fleet.length) return rec.fleet
            }
        } catch (_) {}
        try {
            const all = await chrome.storage.local.get(null)
            const keys = Object.keys(all || {}).filter(k => /aircraftFleet$/i.test(k))
            const preferred = keys.find(k =>
                (!this.server || k.indexOf(this.server) === 0)
                && (!this.airlineCode || k.toUpperCase().indexOf(String(this.airlineCode).toUpperCase()) !== -1)
            )
            const key = preferred || keys.find(k => {
                const rec = all[k]
                return rec && Array.isArray(rec.fleet) && rec.fleet.length
            })
            const rec = key ? all[key] : null
            if (rec && rec.server && !this.server) this.server = String(rec.server || "")
            if (rec && rec.airline && !this.airlineCode) this.airlineCode = String(rec.airline || "")
            return rec && Array.isArray(rec.fleet) ? rec.fleet : []
        } catch (_) {
            return []
        }
    }

    async _loadSchedules() {
        if (typeof AesAfpScheduleStore === "undefined") return
        if (!this.fleet.length) return
        const pairs = await Promise.all(this.fleet.map(async (r) => {
            try { return [String(r.aircraftId), await AesAfpScheduleStore.load(this.server, r.aircraftId)] }
            catch (_) { return [String(r.aircraftId), null] }
        }))
        this.schedules = new Map()
        for (const [id, s] of pairs) if (s) this.schedules.set(id, s)
    }

    async _refreshActualSchedules(opts) {
        if (typeof FleetScheduleGridScraper === "undefined") return
        if (!this.server || !this.fleet.length) return
        const force = !!(opts && opts.force)
        if (this._scheduleScraper) {
            try { this._scheduleScraper.abort() } catch (_) {}
        }
        const scraper = new FleetScheduleGridScraper(this.server, {maxConcurrency: 2})
        this._scheduleScraper = scraper
        const startedAt = Date.now()
        this._setStatus(this.fleet.length + " aircraft · " + this.schedules.size + " schedules · refreshing actual…")
        const result = await scraper.scrapeAll(this.fleet, {
            forceRefetch: force,
            maxAgeMs:     force ? 0 : (10 * 60 * 1000),
            onProgress:   (p) => {
                if (this._scheduleScraper !== scraper || scraper._aborted) return
                if (p && p.lastResult && p.lastResult.schedule) {
                    this.schedules.set(String(p.lastResult.aircraftId), p.lastResult.schedule)
                    this._pushScheduleUpdate()
                }
                if (p && p.total) {
                    this._setStatus(this.fleet.length + " aircraft · "
                        + this.schedules.size + " schedules · refreshed "
                        + (p.completed || 0) + "/" + p.total)
                }
            }
        })
        if (this._scheduleScraper !== scraper || scraper._aborted) return
        for (const [id, s] of result.schedules) this.schedules.set(String(id), s)
        this._pushScheduleUpdate()
        const failed = result.results.filter(r => !r.ok).length
        const fetched = result.results.filter(r => r.ok && r.source === "fetch").length
        const fresh = result.results.filter(r => r.ok && r.source === "store-fresh").length
        const sec = ((Date.now() - startedAt) / 1000).toFixed(1)
        this._setStatus(this.fleet.length + " aircraft · " + this.schedules.size
            + " schedules · " + fetched + " fetched · " + fresh + " cached"
            + (failed ? " · " + failed + " failed" : "")
            + " · " + sec + "s")
        this._scheduleScraper = null
    }

    async _loadMaintenance() {
        if (typeof AesAfpMaintenanceStore === "undefined" || !this.fleet.length) return
        const recs = await Promise.all(this.fleet.map(r =>
            AesAfpMaintenanceStore.load(this.server, r.aircraftId).catch(() => null)
        ))
        for (let i = 0; i < this.fleet.length; i++) {
            const rec = recs[i]
            if (rec) this.maintenance.set(String(this.fleet[i].aircraftId), rec)
        }
    }

    async _loadPresets() {
        if (typeof SchedulePresets === "undefined") { this._presets = []; return }
        try {
            const block = await SchedulePresets.load()
            this._presets = (block && Array.isArray(block.presets)) ? block.presets : []
        } catch (_) { this._presets = [] }
        await this._ensureStarterPresets()
        try {
            this._afpSettings = (typeof window.AesAfpSettings !== "undefined")
                ? await window.AesAfpSettings.load()
                : null
        } catch (_) { this._afpSettings = null }
    }

    async _ensureStarterPresets() {
        if (typeof SchedulePresets === "undefined") return
        const hubs = this._fleetHubs()
        if (!hubs.length) return
        for (const hub of hubs) {
            if (this._presets.some(p => p && String(p.hub || "").toUpperCase() === hub)) continue
            const preset = await this._createStarterPreset(hub)
            if (preset) this._presets.push(preset)
        }
    }

    async _ensureStarterPresetForHub(hub) {
        const HUB = String(hub || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(HUB)) return null
        const existing = this._presets.find(p => p && String(p.hub || "").toUpperCase() === HUB)
        if (existing) return existing
        const preset = await this._createStarterPreset(HUB)
        if (preset) this._presets.push(preset)
        return preset
    }

    async _createStarterPreset(hub) {
        try {
            let preset = null
            if (typeof window !== "undefined"
                && window.RouteAssistantWaveEditor
                && typeof window.RouteAssistantWaveEditor.createStarterPreset === "function") {
                preset = await window.RouteAssistantWaveEditor.createStarterPreset(hub)
            } else {
                const w = SchedulePresets.newWave("Wave 1")
                w.composition = {shortHaul: 4, mediumHaul: 2, longHaul: 1}
                preset = await SchedulePresets.create({
                    name:  "Wave plan for " + hub,
                    hub:   hub,
                    waves: [w]
                })
            }
            await this._pinPresetForHub(hub, preset)
            return preset
        } catch (e) {
            console.warn("[AES Canvas] starter preset create failed", hub, e)
            return null
        }
    }

    async _pinPresetForHub(hub, preset) {
        if (!preset || !preset.id) return
        if (typeof window === "undefined" || typeof window.AesAfpSettings === "undefined") return
        try {
            const map = {}
            map[String(hub || "").toUpperCase()] = preset.id
            this._afpSettings = await window.AesAfpSettings.save({
                activePresetIdByHub: map,
                lastSelectedPresetId: preset.id
            })
        } catch (_) {}
    }

    _fleetHubs() {
        const set = new Set()
        for (const r of this.fleet || []) {
            const hub = String((r && (r.hub || r.gravityHub || r.locIata || r.location)) || "").toUpperCase()
            if (/^[A-Z]{3}$/.test(hub)) set.add(hub)
        }
        return Array.from(set).sort()
    }

    _buildColoring() {
        if (typeof FleetScheduleGridColoring === "undefined") { this.coloring = null; return }
        try { this.coloring = FleetScheduleGridColoring.assign(this.schedules) }
        catch (e) { console.warn("[AES Canvas] coloring failed", e); this.coloring = null }
    }

    _pushScheduleUpdate() {
        this._buildColoring()
        if (this._shell) {
            this._shell.update({schedules: this.schedules, coloring: this.coloring})
            if (typeof this._shell._refreshTelemetryStrip === "function") {
                this._shell._refreshTelemetryStrip().catch(() => {})
            }
        }
    }

    /**
     * Resolve the active preset for a hub. Order:
     *   1. AesAfpSettings.activePresetIdByHub[HUB] — canonical pointer.
     *   2. First preset matching hub (case-insensitive).
     *   3. null — shell renders the "no preset" message.
     */
    _presetForHub(hub) {
        if (!hub) return null
        const HUB = String(hub).toUpperCase()
        const settings = this._afpSettings
            || (typeof window.AesAfpSettings !== "undefined" && window.AesAfpSettings._cache)
            || null
        const map = (settings && settings.activePresetIdByHub) || {}
        const pinnedId = map[HUB]
        if (pinnedId) {
            const found = this._presets.find(p => p && p.id === pinnedId)
            if (found) return found
        }
        return this._presets.find(p => p && String(p.hub || "").toUpperCase() === HUB) || null
    }

    /**
     * Timeline view: embed a real, canvas-owned Fleet Schedule Grid surface
     * so routes and departure times can be manipulated without leaving the
     * Schedule Canvas modal.
     */
    _mountTimelineSurface(host, state) {
        this._unmountTimelineSurface(host)
        if (!host) return
        const st = state || (this._shell && this._shell._state) || {}
        const activeHub = st.activeHub || this._initialHub || null
        if (typeof window !== "undefined" && window.CanvasTimelineSurface) {
            const surface = new window.CanvasTimelineSurface({
                rootEl:      host,
                server:      this.server,
                airlineCode: this.airlineCode,
                fleet:       this.fleet,
                schedules:   this.schedules,
                maintenance: this.maintenance,
                coloring:    this.coloring,
                activeHub,
                preset:      this._presetForHub(activeHub),
                focusedAircraftId: st.focusedAircraftId || null,
                onRefresh:   () => this._refreshActualSchedules({force: true}),
                onScheduleUpdated: (aircraftId, schedule) => {
                    if (aircraftId && schedule) {
                        this.schedules.set(String(aircraftId), schedule)
                        this._pushScheduleUpdate()
                    }
                },
                onFocusAircraft: (aircraftId) => {
                    if (window.CentralHubBus && window.AesCanvasEvents) {
                        window.CentralHubBus.emit(window.AesCanvasEvents.FOCUS_AIRCRAFT, {aircraftId})
                    }
                    if (aircraftId && window.AesCanvasStateStore) {
                        window.AesCanvasStateStore.save({focusedAircraftId: String(aircraftId)}).catch(() => {})
                    }
                },
                onStatus: (text) => this._setStatus(text)
            })
            this._timelineSurface = surface
            surface.mount(host)
            return
        }
        this._mountTimelineFallback(host)
    }

    _updateTimelineSurface(deps) {
        if (!this._timelineSurface) return
        const d = deps || {}
        const activeHub = d.activeHub || (this._shell && this._shell._state && this._shell._state.activeHub) || null
        this._timelineSurface.update(Object.assign({}, d, {
            activeHub,
            preset: d.preset || this._presetForHub(activeHub)
        }))
    }

    _unmountTimelineSurface(host) {
        if (this._timelineSurface) {
            try { this._timelineSurface.dispose({keepRoot: true}) } catch (_) {}
            this._timelineSurface = null
        }
        if (host) host.innerHTML = ""
    }

    _mountTimelineFallback(host) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        host.innerHTML = ""
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:32px;display:flex;flex-direction:column;align-items:center;gap:12px;color:" + (T ? T.color.oxide : "#2B2520") + ";"
        const lead = document.createElement("div")
        lead.style.cssText = "font-size:13px;font-weight:" + (T ? T.fw.bold : "700") + ";"
        lead.textContent = "Timeline view"
        const sub = document.createElement("div")
        sub.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";text-align:center;max-width:400px;"
        sub.textContent = "The embedded timeline module is unavailable. Open the legacy Fleet Schedule Grid as a fallback."
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = "Open legacy timeline"
        btn.style.cssText = [
            "padding:6px 14px",
            "cursor:pointer",
            "font-size:11px",
            "border:1px solid " + (T ? T.color.oxide : "#2B2520"),
            "background:" + (T ? T.color.rust : "#B8472A"),
            "color:" + (T ? T.color.rustFg || "#F4F1EA" : "#F4F1EA"),
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "text-transform:uppercase",
            "letter-spacing:0.06em",
            "font-weight:700"
        ].join(";")
        btn.addEventListener("click", async () => {
            // Reset view to waves so the next canvas open lands on the wave spine.
            try { await window.AesCanvasStateStore.save({view: "waves"}) } catch (_) {}
            const state = await window.AesCanvasStateStore.load()
            const hub = state.activeHub
            const aid = state.focusedAircraftId
            this.close()
            if (typeof FleetScheduleGridPanel !== "undefined") {
                FleetScheduleGridPanel.open({
                    server:             this.server,
                    airlineCode:        this.airlineCode,
                    selectedHub:        hub,
                    selectedAircraftId: aid
                })
            }
        })
        wrap.append(lead, sub, btn)
        host.appendChild(wrap)
    }

    _wireScheduleWatcher() {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        const prefix = (typeof AesAfpScheduleStore !== "undefined" && AesAfpScheduleStore.PREFIX)
            ? AesAfpScheduleStore.PREFIX + String(this.server || "") + ":"
            : null
        if (!prefix) return
        const listener = (changes, area) => {
            if (area !== "local") return
            let touched = false
            for (const key of Object.keys(changes)) {
                if (!key.startsWith(prefix)) continue
                const aircraftId = key.slice(prefix.length)
                const newVal = changes[key].newValue || null
                if (newVal) this.schedules.set(String(aircraftId), newVal)
                else        this.schedules.delete(String(aircraftId))
                touched = true
            }
            if (touched) {
                this._setStatus(this.fleet.length + " aircraft · " + this.schedules.size + " schedules")
                this._pushScheduleUpdate()
            }
        }
        chrome.storage.onChanged.addListener(listener)
        this._scheduleUnwatch = () => chrome.storage.onChanged.removeListener(listener)
    }
}

if (typeof window !== "undefined") {
    window.CanvasModal = CanvasModal
}
