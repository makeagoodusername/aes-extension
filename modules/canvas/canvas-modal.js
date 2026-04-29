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

    static async open(opts) {
        const o = opts || {}
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

        this._overlayEl  = null
        this._bodyEl     = null
        this._statusEl   = null
        this._shell      = null
        this._keydownHandler = null
        this._scheduleUnwatch = null
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
            mountTimelineView:   (host) => this._mountTimelineHandoff(host),
            unmountTimelineView: (host) => { if (host) host.innerHTML = "" },
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

        // React to schedule store changes from any tab — we only listen for
        // AFP schedule writes here (the AS scrape pipeline is owned elsewhere).
        this._wireScheduleWatcher()

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
        if (this._railController) { try { this._railController.dispose() } catch (_) {} this._railController = null }
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
        close.title = "Close (Esc)"
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
        if (e.key === "Escape") { e.preventDefault(); this.close(); return }
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
        try {
            if (typeof FleetHubAircraftAggregator !== "undefined" && this.airlineCode) {
                const fleetKey = this.server + this.airlineCode + "aircraftFleet"
                const blob = await chrome.storage.local.get([fleetKey])
                const rec = blob[fleetKey]
                const fleet = (rec && Array.isArray(rec.fleet)) ? rec.fleet : []
                this.fleet = await FleetHubAircraftAggregator.enrich({
                    server: this.server, airlineCode: this.airlineCode, fleet
                })
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
    }

    _buildColoring() {
        if (typeof FleetScheduleGridColoring === "undefined") { this.coloring = null; return }
        try { this.coloring = FleetScheduleGridColoring.assign(this.schedules) }
        catch (e) { console.warn("[AES Canvas] coloring failed", e); this.coloring = null }
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
        const settings = (typeof window.AesAfpSettings !== "undefined" && window.AesAfpSettings._cache) || null
        const map = (settings && settings.activePresetIdByHub) || {}
        const pinnedId = map[HUB]
        if (pinnedId) {
            const found = this._presets.find(p => p && p.id === pinnedId)
            if (found) return found
        }
        return this._presets.find(p => p && String(p.hub || "").toUpperCase() === HUB) || null
    }

    /**
     * Timeline-view handoff: the canvas shell asked us to mount the
     * timeline body. Rather than embedding the legacy renderer (which
     * wants its own modal + side rail + wave overlay), we close the
     * canvas modal and re-open the legacy panel with the same hub and
     * aircraft selection. The user's view-toggle is honoured; they get
     * back to the canvas via the canvas button on the fleet page.
     */
    _mountTimelineHandoff(host) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        host.innerHTML = ""
        const wrap = document.createElement("div")
        wrap.style.cssText = "padding:32px;display:flex;flex-direction:column;align-items:center;gap:12px;color:" + (T ? T.color.oxide : "#2B2520") + ";"
        const lead = document.createElement("div")
        lead.style.cssText = "font-size:13px;font-weight:" + (T ? T.fw.bold : "700") + ";"
        lead.textContent = "Timeline view"
        const sub = document.createElement("div")
        sub.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";text-align:center;max-width:400px;"
        sub.textContent = "The legacy Fleet Schedule Grid handles time-axis editing with its own side rail and wave overlay. Open it now — the canvas will reopen when you close that modal."
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
                this._buildColoring()
                if (this._shell) this._shell.update({schedules: this.schedules, coloring: this.coloring})
            }
        }
        chrome.storage.onChanged.addListener(listener)
        this._scheduleUnwatch = () => chrome.storage.onChanged.removeListener(listener)
    }
}

if (typeof window !== "undefined") {
    window.CanvasModal = CanvasModal
}
