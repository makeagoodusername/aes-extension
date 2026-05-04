"use strict"

/**
 * CanvasTimelineSurface
 *
 * Embeds the existing Fleet Schedule Grid renderer inside Schedule Canvas.
 * This gives the Canvas "Timeline" tab a real route/time manipulation
 * surface instead of a handoff placeholder:
 *   - 24h aircraft/day lanes from FleetScheduleGridRenderer
 *   - route legend filtering and hover highlighting
 *   - destination-card drops through FleetScheduleGridDndBridge
 *   - flight-block drag-to-time proposal through FleetScheduleGridFlightInspector
 *   - active wave transfer windows painted over each lane
 */
class CanvasTimelineSurface {

    static FLIGHT_DRAG_THRESHOLD_PX = 4
    static FLIGHT_SNAP_MIN = 15

    constructor(opts) {
        const o = opts || {}
        this.rootEl      = o.rootEl || null
        this.server      = o.server || ""
        this.airlineCode = o.airlineCode || ""
        this.fleet       = Array.isArray(o.fleet) ? o.fleet : []
        this.schedules   = o.schedules instanceof Map ? o.schedules : new Map()
        this.maintenance = o.maintenance instanceof Map ? o.maintenance : new Map()
        this.coloring    = o.coloring || null
        this.activeHub   = o.activeHub || null
        this.preset      = o.preset || null
        this.focusedAircraftId = o.focusedAircraftId || null
        this.onRefresh = typeof o.onRefresh === "function" ? o.onRefresh : null
        this.onScheduleUpdated = typeof o.onScheduleUpdated === "function" ? o.onScheduleUpdated : null
        this.onFocusAircraft = typeof o.onFocusAircraft === "function" ? o.onFocusAircraft : null
        this.onStatus = typeof o.onStatus === "function" ? o.onStatus : null

        this._surfaceEl = null
        this._gridEl = null
        this._legendEl = null
        this._statusEl = null
        this._daySelect = null
        this._renderer = null
        this._dndBridge = null
        this._dndSourcePanel = null
        this._filterRoute = null
        this._dayMode = "all"
        this._flightBlockAttached = false
        this._flightDragState = null
        this._flightDragSuppressClick = false
        this._docMove = null
        this._docUp = null
        this._gridRenderedHandler = null
    }

    mount(rootEl) {
        if (rootEl) this.rootEl = rootEl
        if (!this.rootEl) return
        this.dispose({keepRoot: true})

        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this.rootEl.innerHTML = ""

        const surface = document.createElement("div")
        surface.className = "aes-canvas-timeline-surface"
        surface.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "min-height:100%",
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif")
        ].join(";")

        const styleEl = document.createElement("style")
        styleEl.textContent = [
            ".aes-canvas-timeline-surface .aes-fsg-block{transition:opacity 80ms linear,box-shadow 80ms linear,transform 80ms linear;}",
            ".aes-canvas-timeline-surface .aes-fsg-block.aes-fsg-dim{opacity:0.18;}",
            ".aes-canvas-timeline-surface .aes-fsg-block.aes-fsg-hot{box-shadow:0 0 0 2px " + (T ? T.color.oxide : "#2B2520") + ",0 1px 6px rgba(0,0,0,0.3);z-index:4;transform:translateY(-1px);}",
            ".aes-canvas-timeline-surface .aes-fsg-block:hover{z-index:3;}"
        ].join("\n")
        surface.appendChild(styleEl)

        surface.appendChild(this._buildToolbar(T))

        const gridScroll = document.createElement("div")
        gridScroll.style.cssText = "flex:1 1 auto;min-height:360px;overflow:auto;"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        const gridEl = document.createElement("div")
        gridEl.className = "aes-canvas-timeline-grid"
        gridScroll.appendChild(gridEl)
        surface.appendChild(gridScroll)

        const legendEl = document.createElement("div")
        legendEl.style.cssText = "flex:0 0 auto;max-height:20vh;overflow:auto;"
        surface.appendChild(legendEl)

        this._mountDestinationDock(surface, T)

        this.rootEl.appendChild(surface)
        this._surfaceEl = surface
        this._gridEl = gridEl
        this._legendEl = legendEl

        if (typeof FleetScheduleGridRenderer === "undefined") {
            this._renderUnavailable(T, "Timeline renderer module is not loaded.")
            return
        }

        this._renderer = new FleetScheduleGridRenderer({
            rootEl:      gridEl,
            fleet:       this.fleet,
            schedules:   this.schedules,
            maintenance: this.maintenance,
            coloring:    this.coloring
        })

        this._gridRenderedHandler = () => this._paintWaveBands()
        gridEl.addEventListener("aes-fsg:rendered", this._gridRenderedHandler)

        this._renderAll()
        this._mountDndBridge()
        this._attachFlightBlockHandler()
    }

    dispose(opts) {
        if (this._dndBridge) {
            try { this._dndBridge.detach() } catch (_) {}
            this._dndBridge = null
        }
        if (this._gridEl && this._gridRenderedHandler) {
            try { this._gridEl.removeEventListener("aes-fsg:rendered", this._gridRenderedHandler) } catch (_) {}
        }
        this._gridRenderedHandler = null
        this._removeDocDragHandlers()
        this._hideFlightDragReadout()
        if (this._surfaceEl && this._surfaceEl.parentElement) {
            this._surfaceEl.parentElement.removeChild(this._surfaceEl)
        }
        if (!(opts && opts.keepRoot) && this.rootEl) this.rootEl.innerHTML = ""
        this._surfaceEl = null
        this._gridEl = null
        this._legendEl = null
        this._statusEl = null
        this._daySelect = null
        this._renderer = null
        this._dndSourcePanel = null
        this._flightBlockAttached = false
        this._flightDragState = null
    }

    update(opts) {
        const o = opts || {}
        if (o.fleet !== undefined) this.fleet = Array.isArray(o.fleet) ? o.fleet : []
        if (o.schedules !== undefined) this.schedules = o.schedules instanceof Map ? o.schedules : new Map()
        if (o.maintenance !== undefined) this.maintenance = o.maintenance instanceof Map ? o.maintenance : new Map()
        if (o.coloring !== undefined) this.coloring = o.coloring
        if (o.activeHub !== undefined) this.activeHub = o.activeHub || null
        if (o.preset !== undefined) this.preset = o.preset || null
        if (o.focusedAircraftId !== undefined) this.focusedAircraftId = o.focusedAircraftId || null
        this._renderAll()
    }

    _buildToolbar(T) {
        const bar = document.createElement("div")
        bar.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:10px",
            "padding:8px 12px",
            "background:" + (T ? T.color.bone2 : "#ECE7DC"),
            "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "font-size:11px"
        ].join(";")

        const hub = document.createElement("div")
        hub.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-weight:700;"
        hub.textContent = this.activeHub ? "Hub " + this.activeHub : "All hubs"

        const dayLabel = document.createElement("label")
        dayLabel.style.cssText = "text-transform:uppercase;letter-spacing:0.06em;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        dayLabel.textContent = "Day"

        const daySelect = document.createElement("select")
        daySelect.style.cssText = this._selectCss(T)
        const opts = [["all", "Mon-Sun"], ["0", "Monday"], ["1", "Tuesday"], ["2", "Wednesday"], ["3", "Thursday"], ["4", "Friday"], ["5", "Saturday"], ["6", "Sunday"]]
        for (const pair of opts) {
            const o = document.createElement("option")
            o.value = pair[0]
            o.textContent = pair[1]
            if (String(this._dayMode) === pair[0]) o.selected = true
            daySelect.appendChild(o)
        }
        daySelect.addEventListener("change", () => {
            this._dayMode = daySelect.value === "all" ? "all" : +daySelect.value
            this._renderAll()
        })
        this._daySelect = daySelect

        const clear = document.createElement("button")
        clear.type = "button"
        clear.textContent = "Clear route filter"
        clear.style.cssText = this._btnCss(T, "default")
        clear.addEventListener("click", () => {
            this._filterRoute = null
            this._renderAll()
        })

        const refresh = document.createElement("button")
        refresh.type = "button"
        refresh.textContent = "Refresh schedules"
        refresh.style.cssText = this._btnCss(T, "rust")
        refresh.addEventListener("click", async () => {
            if (!this.onRefresh) return
            refresh.disabled = true
            try { await this.onRefresh() }
            finally { refresh.disabled = false }
        })

        const status = document.createElement("div")
        status.style.cssText = "margin-left:auto;font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";"
        this._statusEl = status

        bar.append(hub, this._sep(T), dayLabel, daySelect, this._sep(T), clear, refresh, status)
        return bar
    }

    _mountDestinationDock(surface, T) {
        if (typeof FleetScheduleGridDndSourcePanel === "undefined") return
        const details = document.createElement("details")
        details.open = true
        details.style.cssText = "flex:0 0 auto;border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
        const summary = document.createElement("summary")
        summary.style.cssText = "cursor:pointer;padding:7px 12px;font-size:10px;font-weight:" + (T ? T.fw.bold : "700") + ";"
            + "letter-spacing:0.08em;text-transform:uppercase;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        summary.textContent = "Destinations"
        details.appendChild(summary)

        const panel = new FleetScheduleGridDndSourcePanel({
            server: this.server,
            airlineCode: this.airlineCode
        })
        details.appendChild(panel.buildPane())
        surface.appendChild(details)
        try { panel.refresh() } catch (_) {}
        this._dndSourcePanel = panel
    }

    _renderUnavailable(T, message) {
        if (!this._gridEl) return
        this._gridEl.innerHTML = ""
        const msg = document.createElement("div")
        msg.style.cssText = "padding:36px;text-align:center;color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:12px;"
        msg.textContent = message
        this._gridEl.appendChild(msg)
    }

    _renderAll() {
        if (!this._renderer) return
        if (!this.coloring && typeof FleetScheduleGridColoring !== "undefined") {
            try { this.coloring = FleetScheduleGridColoring.assign(this.schedules) }
            catch (_) { this.coloring = null }
        }
        this._renderer.fleet = this.fleet
        this._renderer.schedules = this.schedules
        this._renderer.maintenance = this.maintenance
        this._renderer.coloring = this.coloring
        this._renderer._filterHub = this.activeHub || null
        this._renderer._filterRoute = this._filterRoute || null
        this._renderer._dayMode = this._dayMode
        this._renderer.render()
        this._renderLegend()
        this._paintWaveBands()
        this._setLocalStatus()
    }

    _renderLegend() {
        if (!this._legendEl) return
        this._legendEl.innerHTML = ""
        if (!this.coloring || typeof FleetScheduleGridRenderer === "undefined") return
        const legend = FleetScheduleGridRenderer.buildLegend(this.coloring, {
            filterRoute: this._filterRoute,
            onClick: (key, route, mode) => {
                if (!this._renderer) return
                if (mode === "hover-in") {
                    this._renderer.setHoveredRoute(key)
                    return
                }
                if (mode === "hover-out") {
                    this._renderer.setHoveredRoute(null)
                    return
                }
                this._filterRoute = (this._filterRoute === key) ? null : key
                this._renderAll()
            }
        })
        this._legendEl.appendChild(legend)
    }

    _mountDndBridge() {
        if (this._dndBridge || !this._gridEl) return
        if (typeof FleetScheduleGridDndBridge === "undefined") return
        this._dndBridge = new FleetScheduleGridDndBridge({
            gridEl: this._gridEl,
            getScheduleForLane: (lane) => {
                const id = lane && lane.dataset && lane.dataset.aircraftId
                return id ? this.schedules.get(String(id)) || null : null
            },
            onDrop: (drop) => this._onDestinationDrop(drop)
        })
        this._dndBridge.attach()
    }

    _onDestinationDrop(drop) {
        if (!drop || !drop.aircraftId || !drop.destIata) return
        if (typeof FleetScheduleGridDropPopover === "undefined") return
        const fleetRow = this.fleet.find(r => String(r.aircraftId) === String(drop.aircraftId)) || null
        const schedule = this.schedules.get(String(drop.aircraftId)) || null
        const layers = this._waveLayers()
        const sourceWaveLayer = drop.sourceWaveLayerId
            ? layers.find(l => l.id === drop.sourceWaveLayerId) || null
            : null
        FleetScheduleGridDropPopover.openAt({
            dropCtx: drop,
            deps: {
                server: this.server,
                fleetRow,
                schedule,
                sourceWaveLayer
            },
            onApplied: () => {
                this._rescrapeAircraft(drop.aircraftId).catch(err =>
                    console.warn("[AES Canvas Timeline] post-apply rescrape failed", err))
            }
        })
    }

    async _rescrapeAircraft(aircraftId) {
        if (!aircraftId || typeof FleetScheduleGridScraper === "undefined") return
        try {
            const fetcher = (typeof window !== "undefined") ? window.__aesFsgProxyFetcher : null
            if (fetcher && typeof fetcher.invalidate === "function") fetcher.invalidate(aircraftId)
        } catch (_) {}
        const oneShot = new FleetScheduleGridScraper(this.server, {maxConcurrency: 1})
        const res = await oneShot.scrapeOne(aircraftId, {force: true})
        if (res && res.ok && res.schedule) {
            this.schedules.set(String(aircraftId), res.schedule)
            if (this.onScheduleUpdated) {
                try { this.onScheduleUpdated(aircraftId, res.schedule) } catch (_) {}
            }
            this._renderAll()
            this._emitStatus("Updated aircraft " + aircraftId)
        } else if (res && !res.ok) {
            this._emitStatus("Rescrape failed: " + ((res.error && res.error.code) || "?"))
        }
    }

    _paintWaveBands() {
        if (!this._gridEl || typeof FleetScheduleGridWaveOverlay === "undefined") return
        const layers = this._waveLayers()
        const lanes = this._gridEl.querySelectorAll("[data-aircraft-id][data-day-idx]")
        for (const lane of lanes) {
            const dayIdx = +lane.dataset.dayIdx
            const hub = (lane.dataset.hub || "").toUpperCase()
            const visible = layers.filter(l => l.days[dayIdx])
            FleetScheduleGridWaveOverlay.paint(lane, {
                dayIdx,
                layers: visible,
                hubMatch: (l) => !l.hub || hub === l.hub,
                fadeRatio: 0.18
            })
            const bands = lane.querySelectorAll(".aes-fsg-wave-band")
            for (const b of bands) b.style.pointerEvents = "none"
        }
    }

    _waveLayers() {
        const preset = this.preset
        if (!preset || !Array.isArray(preset.waves)) return []
        const colors = (typeof FleetScheduleGridWavePicker !== "undefined" && FleetScheduleGridWavePicker.PALETTE)
            ? FleetScheduleGridWavePicker.PALETTE
            : ["hsl(202,72%,72%)", "hsl(38,82%,68%)", "hsl(122,52%,68%)", "hsl(338,68%,72%)"]
        const HUB = String(preset.hub || this.activeHub || "").toUpperCase()
        return preset.waves
            .filter(w => w && !w.archivedAt)
            .map((w, idx) => ({
                id: "canvas:" + (preset.id || "preset") + ":" + (w.id || idx),
                presetId: preset.id || "",
                waveId: w.id || "",
                hub: HUB,
                name: (w.label || ("Wave " + (idx + 1))),
                color: colors[idx % colors.length],
                role: "active",
                opacity: 0.24,
                timeShiftMin: 0,
                arrShiftMin: 0,
                depShiftMin: 0,
                days: [true, true, true, true, true, true, true],
                arrivalWindow: w.arrivalWindow ? {start: w.arrivalWindow.start, end: w.arrivalWindow.end} : null,
                departureWindow: w.departureWindow ? {start: w.departureWindow.start, end: w.departureWindow.end} : null
            }))
    }

    _attachFlightBlockHandler() {
        if (this._flightBlockAttached || !this._gridEl) return
        this._flightBlockAttached = true
        this._gridEl.addEventListener("mousedown", (e) => this._onFlightMouseDown(e))
        this._gridEl.addEventListener("click", (e) => this._onFlightClickGuard(e), true)
    }

    _onFlightClickGuard(e) {
        if (this._flightDragSuppressClick) {
            this._flightDragSuppressClick = false
            e.stopPropagation()
            return
        }
        const blockEl = e.target && e.target.closest && e.target.closest(".aes-fsg-block--flight")
        if (!blockEl) return
        if (e.target && e.target.closest && e.target.closest(".aes-fsg-wave-band")) return
        this._openInspectorForBlock(blockEl, null)
    }

    _onFlightMouseDown(e) {
        if (e.button !== 0) return
        if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
        const blockEl = e.target && e.target.closest && e.target.closest(".aes-fsg-block--flight")
        if (!blockEl) return
        if (e.target && e.target.closest && e.target.closest(".aes-fsg-wave-band")) return
        const lane = blockEl.closest("[data-aircraft-id][data-day-idx]")
        if (!lane) return
        const origStartMin = +blockEl.dataset.startMin
        if (!isFinite(origStartMin)) return

        const rect = lane.getBoundingClientRect()
        this._flightDragState = {
            blockEl,
            lane,
            laneRect: rect,
            startX: e.clientX,
            startY: e.clientY,
            origStartMin,
            origEndMin: +blockEl.dataset.endMin,
            durationMin: (+blockEl.dataset.endMin) - origStartMin,
            deltaMin: 0,
            dragging: false
        }
        this._docMove = (ev) => this._onFlightDragMove(ev)
        this._docUp = (ev) => this._onFlightDragUp(ev)
        document.addEventListener("mousemove", this._docMove, true)
        document.addEventListener("mouseup", this._docUp, true)
    }

    _onFlightDragMove(ev) {
        const s = this._flightDragState
        if (!s) return
        const dxPx = ev.clientX - s.startX
        const dyPx = ev.clientY - s.startY
        if (!s.dragging) {
            if (Math.hypot(dxPx, dyPx) < CanvasTimelineSurface.FLIGHT_DRAG_THRESHOLD_PX) return
            s.dragging = true
            s.blockEl.style.transition = "none"
            s.blockEl.style.zIndex = "8"
            s.blockEl.style.cursor = "grabbing"
            s.blockEl.style.boxShadow = "0 0 0 2px #2B2520,0 6px 16px rgba(0,0,0,0.35)"
        }
        const widthMin = FleetScheduleGridRenderer.MIN_PER_DAY
        const rawMin = (dxPx / s.laneRect.width) * widthMin
        const snapped = Math.round(rawMin / CanvasTimelineSurface.FLIGHT_SNAP_MIN) * CanvasTimelineSurface.FLIGHT_SNAP_MIN
        const newStart = Math.max(0, Math.min(widthMin - s.durationMin, s.origStartMin + snapped))
        s.deltaMin = newStart - s.origStartMin
        const pxPerMin = s.laneRect.width / widthMin
        s.blockEl.style.transform = "translateX(" + (s.deltaMin * pxPerMin) + "px)"
        this._showFlightDragReadout(s)
    }

    _onFlightDragUp() {
        this._removeDocDragHandlers()
        const s = this._flightDragState
        this._flightDragState = null
        if (!s) return
        if (!s.dragging) return
        s.blockEl.style.transform = ""
        s.blockEl.style.transition = ""
        s.blockEl.style.zIndex = ""
        s.blockEl.style.cursor = ""
        s.blockEl.style.boxShadow = ""
        this._hideFlightDragReadout()
        this._flightDragSuppressClick = true
        const proposed = (s.deltaMin === 0) ? null : (s.origStartMin + s.deltaMin)
        this._openInspectorForBlock(s.blockEl, {
            proposedDepMin: proposed,
            origDepMin: s.origStartMin
        })
    }

    _removeDocDragHandlers() {
        if (this._docMove) document.removeEventListener("mousemove", this._docMove, true)
        if (this._docUp) document.removeEventListener("mouseup", this._docUp, true)
        this._docMove = null
        this._docUp = null
    }

    _openInspectorForBlock(blockEl, dragResult) {
        if (typeof FleetScheduleGridFlightInspector === "undefined") return
        const lane = blockEl.closest("[data-aircraft-id][data-day-idx]")
        if (!lane) return
        const aircraftId = lane.dataset.aircraftId
        const dayIdx = +lane.dataset.dayIdx
        const flightId = blockEl.dataset.flightId || null
        const flightCode = blockEl.dataset.flightCode || null
        const startMin = +blockEl.dataset.startMin
        const sched = this.schedules.get(String(aircraftId)) || null
        let block = null
        if (sched && Array.isArray(sched.days) && sched.days[dayIdx]) {
            for (const b of (sched.days[dayIdx].blocks || [])) {
                if (b.kind !== "flight" || !b.flight) continue
                if (flightId && String(b.flight.flightId) === flightId) { block = b; break }
                if (!flightId && b.startMin === startMin && b.flight.flightCode === flightCode) { block = b; break }
            }
        }
        if (!block) return
        const fleetRow = this.fleet.find(r => String(r.aircraftId) === String(aircraftId)) || null
        FleetScheduleGridFlightInspector.open({
            block,
            aircraftId,
            fleetRow,
            schedule: sched,
            anchorRect: blockEl.getBoundingClientRect(),
            proposedDepMin: dragResult ? dragResult.proposedDepMin : null,
            origDepMin: dragResult ? dragResult.origDepMin : null,
            filterRouteKey: this._filterRoute || null,
            onFilter: (routeKey, on) => {
                this._filterRoute = on ? routeKey : null
                this._renderAll()
            },
            onOpenCockpit: (id) => {
                if (this.onFocusAircraft) {
                    try { this.onFocusAircraft(id) } catch (_) {}
                }
            }
        })
    }

    _showFlightDragReadout(s) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        if (!this._flightDragReadoutEl) {
            const el = document.createElement("div")
            el.style.cssText = "position:fixed;z-index:" + (T ? T.z.toast : 10001) + ";"
                + "padding:6px 10px;background:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "color:" + (T ? T.color.boneFg : "#F4F1EA") + ";"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:11px;"
                + "border-radius:2px;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.4);"
                + "top:auto;bottom:24px;left:50%;transform:translateX(-50%);white-space:nowrap;"
            document.body.appendChild(el)
            this._flightDragReadoutEl = el
        }
        const fmt = (m) => {
            const mm = Math.max(0, Math.min(1439, Math.round(m)))
            const h = Math.floor(mm / 60), r = mm % 60
            return (h < 10 ? "0" + h : h) + ":" + (r < 10 ? "0" + r : r)
        }
        const sign = s.deltaMin > 0 ? "+" : ""
        this._flightDragReadoutEl.textContent =
            "Dep " + fmt(s.origStartMin) + " -> " + fmt(s.origStartMin + s.deltaMin)
            + " (" + sign + s.deltaMin + " min)"
    }

    _hideFlightDragReadout() {
        if (this._flightDragReadoutEl && this._flightDragReadoutEl.parentElement) {
            this._flightDragReadoutEl.parentElement.removeChild(this._flightDragReadoutEl)
        }
        this._flightDragReadoutEl = null
    }

    _setLocalStatus() {
        const text = this.fleet.length + " aircraft - " + this.schedules.size + " schedules"
            + (this.preset && this.preset.waves ? " - " + this.preset.waves.length + " wave windows" : "")
        if (this._statusEl) this._statusEl.textContent = text
    }

    _emitStatus(text) {
        if (this._statusEl) this._statusEl.textContent = text
        if (this.onStatus) {
            try { this.onStatus(text) } catch (_) {}
        }
    }

    _btnCss(T, variant) {
        const base = "padding:4px 10px;cursor:pointer;font-size:11px;"
            + "border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "border-radius:0;font-family:" + (T ? T.font.display : "system-ui, sans-serif") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"
        if (variant === "rust") {
            return base + "background:" + (T ? T.color.rust : "#B8472A") + ";"
                + "color:" + (T ? T.color.rustFg : "#F4F1EA") + ";"
        }
        return base + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
    }

    _selectCss(T) {
        return "padding:3px 6px;font-size:11px;border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
    }

    _sep(T) {
        const s = document.createElement("div")
        s.style.cssText = "width:1px;height:18px;background:" + (T ? T.color.paperRule : "#C9C0B0") + ";"
        return s
    }
}

if (typeof window !== "undefined") {
    window.CanvasTimelineSurface = CanvasTimelineSurface
}
