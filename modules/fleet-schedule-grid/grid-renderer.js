"use strict"

/**
 * Fleet Schedule Grid — renderer.
 *
 * Paints all loaded schedules as a stacked Gantt:
 *
 *   ┌─ G-XYZ1 · 738 · JFK ──────────────────────────────────────────────┐
 *   │ Mon ▭ MIA  ▭▭▭▭ JFK→LHR  ▭▭▭ LHR→JFK ▭▭▭ JFK ▭ MIA               │
 *   │ Tue ▭ MIA  ▭▭▭▭ JFK→LHR  ▭▭▭ LHR→JFK ▭▭▭ JFK ▭ MIA               │
 *   │ ...                                                                │
 *   └────────────────────────────────────────────────────────────────────┘
 *   ┌─ G-XYZ2 · A320 · LHR ─────────────────────────────────────────────┐
 *   │ ...                                                                │
 *
 * Each row is a 24h timeline (0..1440 min). Flight blocks are filled with
 * the route color from `FleetScheduleGridColoring`; location/turnaround/
 * ready blocks render in muted gray to keep the focus on the routes.
 *
 * Hover any block: all blocks for the same route across the whole grid
 * highlight, others dim — that's the route overlay the user asked for.
 *
 * The renderer is data-stateless: every paint takes the full input set.
 * `setHoveredRoute(key)` just toggles CSS classes on existing nodes.
 */
class FleetScheduleGridRenderer {

    static MIN_PER_DAY = 1440
    static DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    constructor(opts) {
        const o = opts || {}
        this.rootEl    = o.rootEl    || null
        this.fleet     = o.fleet     || []         // RowRecord[] from FleetHubAircraftAggregator
        this.schedules = o.schedules || new Map()  // Map<aircraftId, Schedule>
        this.maintenance = o.maintenance || new Map() // Map<aircraftId, MaintenanceRecord>
        this.coloring  = o.coloring  || null
        this._hoveredRoute = null
        this._filterRoute  = null
        this._filterHub    = null
        this._dayMode      = "all"                 // "all" or 0..6
        this._rowMode      = o.rowMode   || "aircraftByDay" // "aircraftByDay" | "dayOverlay"
        this._colorMode    = o.colorMode || "route"         // "route" | "aircraft" | "day"
        this._overrides    = o.overrides || null            // AesScheduleColorOverrides state
        this._showBlockLabels = o.showBlockLabels !== false
        this._lastEls      = []                    // {el, routeKey}
    }

    setHub(hub)         { this._filterHub = hub || null;     this.render() }
    setDay(dayMode)     { this._dayMode   = (dayMode == null ? "all" : dayMode); this.render() }
    setRouteFilter(key) { this._filterRoute = key || null;   this.render() }
    setRowMode(mode) {
        const next = (mode === "dayOverlay") ? "dayOverlay" : "aircraftByDay"
        if (this._rowMode === next) return
        this._rowMode = next
        this.render()
    }
    setColorMode(mode) {
        const next = (mode === "aircraft" || mode === "day") ? mode : "route"
        if (this._colorMode === next) return
        this._colorMode = next
        this.render()
    }
    setOverrides(overrides) {
        this._overrides = overrides || null
        this.render()
    }
    setBlockLabelsVisible(visible) {
        const next = visible !== false
        if (this._showBlockLabels === next) return
        this._showBlockLabels = next
        this.render()
    }

    /** Hover highlight — pure DOM toggle, no re-render. */
    setHoveredRoute(routeKey) {
        if (this._hoveredRoute === routeKey) return
        this._hoveredRoute = routeKey
        for (const {el, routeKey: rk} of this._lastEls) {
            if (!routeKey)          el.classList.remove("aes-fsg-dim", "aes-fsg-hot")
            else if (rk === routeKey) {
                el.classList.add("aes-fsg-hot")
                el.classList.remove("aes-fsg-dim")
            } else {
                el.classList.add("aes-fsg-dim")
                el.classList.remove("aes-fsg-hot")
            }
        }
    }

    render() {
        if (!this.rootEl) return
        this.rootEl.innerHTML = ""
        this._lastEls = []

        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const visibleFleet = this.fleet.filter(row => {
            if (this._filterHub && row.hub !== this._filterHub) return false
            return true
        })

        if (!visibleFleet.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "padding:24px;text-align:center;color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:13px;"
            empty.textContent = "No aircraft to display."
            this.rootEl.appendChild(empty)
            return
        }

        // Time-axis header — a single ruler shared by every aircraft block.
        this.rootEl.appendChild(this._buildTimeAxis(T))

        if (this._rowMode === "dayOverlay") {
            // 7 day-rows (or 1 if dayMode filters to a single day). Each row's
            // lane overlays every visible aircraft's flights for that day.
            const days = this._daysToRender()
            for (const dayIdx of days) {
                this.rootEl.appendChild(this._buildDayOverlayRow(dayIdx, visibleFleet, T))
            }
        } else {
            for (const row of visibleFleet) {
                const block = this._buildAircraftBlock(row, T)
                this.rootEl.appendChild(block)
            }
        }

        // Notify overlays / drag handlers that the grid DOM has been rebuilt
        // so they can re-attach band painters and drop targets.
        try {
            this.rootEl.dispatchEvent(new CustomEvent("aes-fsg:rendered", {
                detail: {visibleFleet, rowMode: this._rowMode, colorMode: this._colorMode},
                bubbles: false
            }))
        } catch (_) {}
    }

    /** Convert pointer x (clientX) within a lane element to minutes-of-day. */
    static pxToMinutes(laneEl, clientX) {
        if (!laneEl) return null
        const rect = laneEl.getBoundingClientRect()
        if (!rect.width) return null
        const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
        return Math.round((x / rect.width) * FleetScheduleGridRenderer.MIN_PER_DAY)
    }

    /** Convert minutes-of-day to a percentage of the lane's 24h width. */
    static minutesToPct(min) {
        if (min == null || !isFinite(min)) return 0
        return Math.max(0, Math.min(100, (min / FleetScheduleGridRenderer.MIN_PER_DAY) * 100))
    }

    _buildTimeAxis(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:stretch;"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "position:sticky;top:0;z-index:5;"

        const labelGutter = document.createElement("div")
        labelGutter.style.cssText = "flex:0 0 140px;padding:6px 8px;font-size:11px;font-weight:700;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "text-transform:uppercase;letter-spacing:0.06em;"
            + "border-right:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        labelGutter.textContent = "Aircraft / Day"

        const lane = document.createElement("div")
        lane.style.cssText = "flex:1 1 auto;position:relative;height:22px;"

        for (let h = 0; h <= 24; h++) {
            const pct = (h / 24) * 100
            const tick = document.createElement("div")
            tick.style.cssText = "position:absolute;left:" + pct + "%;top:0;bottom:0;"
                + "width:1px;background:" + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + (h % 6 === 0 ? "background:" + (T ? T.color.oxide2 : "#4A413B") + ";" : "")
            lane.appendChild(tick)
            if (h < 24 && h % 3 === 0) {
                const lbl = document.createElement("div")
                lbl.style.cssText = "position:absolute;left:" + pct + "%;top:2px;"
                    + "transform:translateX(2px);font-size:10px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
                    + "font-family:" + (T ? T.font.mono : "monospace") + ";"
                lbl.textContent = (h < 10 ? "0" + h : h) + ":00"
                lane.appendChild(lbl)
            }
        }

        wrap.append(labelGutter, lane)
        return wrap
    }

    _buildAircraftBlock(row, T) {
        const block = document.createElement("div")
        block.style.cssText = "border-bottom:2px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
        const sched = this.schedules.get(String(row.aircraftId))

        // Day rows — one per day, or one row total when filtered to a single day.
        const days = this._daysToRender()
        for (const dayIdx of days) {
            block.appendChild(this._buildDayRow(row, dayIdx, sched, T))
        }
        return block
    }

    _daysToRender() {
        if (this._dayMode === "all") return [0, 1, 2, 3, 4, 5, 6]
        const d = +this._dayMode
        return (Number.isInteger(d) && d >= 0 && d < 7) ? [d] : [0, 1, 2, 3, 4, 5, 6]
    }

    _selectedDayIdx() {
        if (this._dayMode === "all") return null
        const d = +this._dayMode
        return (Number.isInteger(d) && d >= 0 && d < 7) ? d : null
    }

    _summaryTextForSchedule(sched) {
        const dayIdx = this._selectedDayIdx()
        if (dayIdx != null) {
            const day = sched && Array.isArray(sched.days) ? sched.days[dayIdx] : null
            const blocks = day && Array.isArray(day.blocks) ? day.blocks : []
            const flights = blocks.filter(b => b && b.kind === "flight")
            const minutes = flights.reduce((sum, b) => {
                const m = Number(b.durationMin)
                return sum + (Number.isFinite(m) ? m : 0)
            }, 0)
            const label = FleetScheduleGridRenderer.DAY_NAMES[dayIdx] || ("Day " + dayIdx)
            return label + " · " + flights.length + " flight" + (flights.length === 1 ? "" : "s")
                + " · " + (minutes / 60).toFixed(1) + "h block"
        }
        const m = sched && sched.summary ? (sched.summary.weeklyBlockMinutes || 0) : 0
        const fc = sched && sched.summary ? (sched.summary.flightCount || 0) : 0
        return "Mon-Sun · " + fc + " flight" + (fc === 1 ? "" : "s")
            + " · " + (m / 60).toFixed(1) + "h block"
    }

    _buildDayRow(row, dayIdx, sched, T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:stretch;border-bottom:1px solid "
            + (T ? T.color.bone2 : "#ECE7DC") + ";"

        const labelGutter = document.createElement("div")
        labelGutter.style.cssText = "flex:0 0 140px;padding:0 8px;display:flex;align-items:center;gap:6px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "border-right:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "cursor:pointer;overflow:hidden;"
        labelGutter.dataset.aircraftId = String(row.aircraftId)
        labelGutter.tabIndex = 0
        labelGutter.title = this._aircraftTitle(row, sched)
        const reg = document.createElement("span")
        reg.style.cssText = "font-weight:700;color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        reg.textContent = row.registration || row.aircraftId
        const dayLabel = document.createElement("span")
        dayLabel.style.cssText = "margin-left:auto;flex:0 0 auto;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        dayLabel.textContent = FleetScheduleGridRenderer.DAY_NAMES[dayIdx] || ("D" + dayIdx)
        labelGutter.append(reg, dayLabel)
        const selectAircraft = () => this._fireAircraftSelected(row.aircraftId)
        labelGutter.addEventListener("click", selectAircraft)
        labelGutter.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return
            ev.preventDefault()
            selectAircraft()
        })

        const lane = document.createElement("div")
        lane.dataset.aircraftId = String(row.aircraftId)
        lane.dataset.dayIdx = String(dayIdx)
        lane.dataset.hub = row.hub || ""
        lane.style.cssText = "flex:1 1 auto;position:relative;height:30px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"

        // Hour gridlines for visual rhythm.
        for (let h = 1; h < 24; h++) {
            const pct = (h / 24) * 100
            const tick = document.createElement("div")
            tick.style.cssText = "position:absolute;left:" + pct + "%;top:0;bottom:0;"
                + "width:1px;background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
                + (h % 6 === 0 ? "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";" : "")
            lane.appendChild(tick)
        }

        if (sched && Array.isArray(sched.days) && sched.days[dayIdx]) {
            const day = sched.days[dayIdx]
            for (const b of (day.blocks || [])) {
                const blockEl = this._buildBlock(b, T, {aircraftId: row.aircraftId, dayIdx})
                if (blockEl) lane.appendChild(blockEl)
            }
        } else if (sched) {
            // Schedule loaded but this day has no entry — leave lane blank.
        } else {
            const ph = document.createElement("div")
            ph.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;"
                + "justify-content:center;font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "font-style:italic;"
            ph.textContent = "(schedule not loaded)"
            lane.appendChild(ph)
        }

        wrap.append(labelGutter, lane)
        return wrap
    }

    _fireAircraftSelected(aircraftId) {
        try {
            this.rootEl && this.rootEl.dispatchEvent(new CustomEvent("aes-fsg:aircraft-selected", {
                detail: {aircraftId},
                bubbles: true
            }))
        } catch (_) { /* noop */ }
    }

    _aircraftTitle(row, sched) {
        const parts = [row.registration || row.aircraftId]
        if (row.equipment) parts.push(row.equipment)
        if (row.hub) parts.push("Hub " + row.hub)
        if (sched && sched.summary) {
            parts.push(this._summaryTextForSchedule(sched))
            parts.push("scraped " + this._fmtAge(sched.scrapedAt))
        } else {
            parts.push("schedule not loaded")
        }
        parts.push("click to inspect")
        return parts.join(" · ")
    }

    _buildBlock(b, T, ctx) {
        if (!b || b.startMin == null || b.durationMin == null || b.durationMin <= 0) return null
        const aircraftId = (ctx && ctx.aircraftId != null) ? String(ctx.aircraftId) : null
        const dayIdx     = (ctx && ctx.dayIdx     != null) ? +ctx.dayIdx : (b.dayIdx != null ? +b.dayIdx : null)
        const left = (b.startMin / FleetScheduleGridRenderer.MIN_PER_DAY) * 100
        const width = Math.max(0.05, (b.durationMin / FleetScheduleGridRenderer.MIN_PER_DAY) * 100)
        const el = document.createElement("div")
        el.className = "aes-fsg-block aes-fsg-block--" + b.kind
        el.style.cssText = "position:absolute;top:3px;bottom:3px;"
            + "left:" + left + "%;width:" + width + "%;"
            + "border-radius:1px;font-size:10px;color:#1a1612;"
            + "overflow:hidden;display:flex;align-items:center;justify-content:center;"
            + "transition:opacity 80ms linear,box-shadow 80ms linear;"
            + "cursor:pointer;"

        let label = ""
        let routeKey = null
        let titleParts = []

        if (b.kind === "flight" && b.flight) {
            const o = b.flight.origin || "?", d = b.flight.destination || "?"
            routeKey = this.coloring ? this.coloring.keyOf(b.flight) : null
            const colors = this._resolveBlockColors(b, {routeKey, aircraftId, dayIdx})
            el.style.background = colors.fill
            el.style.border = "1px solid " + colors.edge
            label = (b.flight.flightCode || (o + "→" + d))
            titleParts = [
                b.flight.flightCode || "(no code)",
                o + " → " + d,
                (b.startLocal || "??:??") + "–" + (b.endLocal || "??:??"),
                "Day " + (FleetScheduleGridRenderer.DAY_NAMES[b.dayIdx] || b.dayIdx),
                Math.round(b.durationMin) + " min"
            ]

            // ORS INTEGRATION: Try to append ORS/pricing data if it is available in the scrape
            if (b.flight && b.flight.orsMetrics) {
                 const loadFactor = Math.round(b.flight.orsMetrics.loadFactor * 100);
                 titleParts.push("ORS: " + loadFactor + "% LF (" + b.flight.orsMetrics.rating + "★)");

                 // Show a tiny dot indicator for poor ORS load factor directly on the block UI
                 if (loadFactor < 50) {
                     const warningDot = document.createElement("div");
                     warningDot.style.cssText = "position:absolute;bottom:2px;right:2px;width:6px;height:6px;border-radius:50%;background-color:" + (T ? T.color.rust : "#B8472A") + ";";
                     warningDot.title = "Poor ORS load factor (" + loadFactor + "%)";
                     el.appendChild(warningDot);
                     el.style.border = "1px solid " + (T ? T.color.rustDeep : "#8B3520");
                     titleParts.unshift("⚠️ LOW LF");
                 }
            }
        } else if (b.kind === "location") {
            const iata = b.location && b.location.iata ? b.location.iata : ""
            el.style.background = T ? T.color.bone3 : "#E0DAC8"
            el.style.border = "1px solid " + (T ? T.color.paperRule : "#C9C0B0")
            label = iata
            titleParts = ["Ground @ " + iata, (b.startLocal || "") + "–" + (b.endLocal || "")]
        } else if (b.kind === "turnaround") {
            el.style.background = T ? T.color.amberSoft : "rgba(184,134,31,0.14)"
            el.style.border = "1px solid " + (T ? T.color.amber : "#B8861F")
            label = ""
            titleParts = ["Turnaround", Math.round(b.durationMin) + " min"]
        } else if (b.kind === "ready") {
            el.style.background = T ? T.color.mossSoft : "rgba(47,95,63,0.14)"
            el.style.border = "1px dashed " + (T ? T.color.moss : "#2F5F3F")
            label = ""
            titleParts = ["Ready", Math.round(b.durationMin) + " min"]
        } else if (b.kind === "maintenance") {
            const mxFill = (this._overrides && this._overrides.maintenance)
                || (window.AesScheduleColorOverrides && window.AesScheduleColorOverrides.defaultMaintenance())
                || "#1A1612"
            el.style.background = mxFill
            el.style.color = T ? T.color.boneFg : "#F4F1EA"
            el.style.border = "1px solid " + (T ? T.color.oxide : "#2B2520")
            label = "MX"
            titleParts = ["Maintenance", Math.round(b.durationMin) + " min"]
        } else if (b.kind === "overlap") {
            el.style.background = "transparent"
            el.style.border = "1px dashed " + (T ? T.color.slate : "#7A6F66")
            label = ""
            titleParts = ["Day boundary"]
        } else {
            return null
        }

        // Filter — collapse to opacity 0.15 if filtered out.
        if (this._filterRoute && routeKey !== this._filterRoute && b.kind === "flight") {
            el.style.opacity = "0.15"
        } else if (this._filterRoute && b.kind !== "flight") {
            el.style.opacity = "0.25"
        }

        if (label && this._showBlockLabels) {
            const span = document.createElement("span")
            span.style.cssText = "padding:0 3px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-weight:600;"
            span.textContent = label
            el.appendChild(span)
        }
        el.title = titleParts.join(" · ")
        if (el.title) el.setAttribute("aria-label", el.title)

        if (aircraftId) el.dataset.aircraftId = aircraftId
        if (dayIdx != null && Number.isFinite(dayIdx)) el.dataset.dayIdx = String(dayIdx)

        if (routeKey) {
            el.dataset.routeKey = routeKey
            el.addEventListener("mouseenter", () => this.setHoveredRoute(routeKey))
            el.addEventListener("mouseleave", () => this.setHoveredRoute(null))
            this._lastEls.push({el, routeKey})
        }

        if (b.kind === "maintenance") {
            // Right-click MX → "Set maintenance color" popover.
            el.addEventListener("contextmenu", (ev) => {
                ev.preventDefault()
                this._openColorPicker({
                    scope: "maintenance",
                    key: null,
                    label: "Maintenance",
                    currentColor: (this._overrides && this._overrides.maintenance) || "",
                    anchorEl: el
                })
            })
        }

        if (b.kind === "flight") {
            // The flight block becomes a manipulation handle. Click opens the
            // Flight Inspector (rich detail + AS deep-links); right-click keeps
            // the "filter to this route" affordance for power users; a
            // mousedown that moves past the drag threshold starts an in-lane
            // drag-to-suggest-time gesture. panel.js owns both the inspector
            // and the drag arbiter wiring — we just publish enough state on
            // the block element so the handler can resolve the flight without
            // re-walking the schedule.
            el.dataset.kind = "flight"
            if (b.flight && b.flight.flightId)   el.dataset.flightId = String(b.flight.flightId)
            if (b.flight && b.flight.flightCode) el.dataset.flightCode = String(b.flight.flightCode)
            el.dataset.startMin = String(b.startMin)
            el.dataset.endMin   = String(b.endMin != null ? b.endMin : (b.startMin + b.durationMin))
            el.dataset.dayIdx   = String(b.dayIdx != null ? b.dayIdx : "")
            el.title += " · click: inspect · drag: shift time · right-click: menu"
            el.addEventListener("contextmenu", (ev) => {
                ev.preventDefault()
                this._openFlightContextMenu({
                    block: b, el, routeKey, aircraftId, dayIdx,
                    pageX: ev.pageX, pageY: ev.pageY,
                    clientX: ev.clientX, clientY: ev.clientY
                })
            })
        }

        // Day-spanning markers — paint a slim notch at the spanning edge.
        if (b.classifiers && b.classifiers.spansIntoNext) {
            const notch = document.createElement("div")
            notch.style.cssText = "position:absolute;right:-2px;top:0;bottom:0;width:4px;"
                + "background:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "clip-path:polygon(0 0, 100% 50%, 0 100%);"
            el.appendChild(notch)
        }
        if (b.classifiers && b.classifiers.spansFromPrev) {
            const notch = document.createElement("div")
            notch.style.cssText = "position:absolute;left:-2px;top:0;bottom:0;width:4px;"
                + "background:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "clip-path:polygon(100% 0, 0 50%, 100% 100%);"
            el.appendChild(notch)
        }

        return el
    }

    _checkCollisions(block, aircraftId, dayIdx) {
        // If wave layers are loaded via a parent component (like the wave picker in panel.js),
        // they are passed down in `this._waveLayers`. We do a quick check to see if the block
        // time window overlaps but falls partially outside an expected connection window.
        if (!this._waveLayers || !this._waveLayers.length || block.kind !== "flight") return null;

        const startMin = block.startMin;
        const endMin = block.endMin != null ? block.endMin : (block.startMin + block.durationMin);
        let collisions = [];

        for (const layer of this._waveLayers) {
            if (!layer.days || !layer.days[dayIdx] || layer.role !== "active") continue;

            // Example collision logic based on arrival/departure windows.
            if (layer.arrivalWindow && layer.departureWindow) {
                const arrWinStart = (this._parseHHMM(layer.arrivalWindow.start) || 0) + (layer.timeShiftMin || 0) + (layer.arrShiftMin || 0);
                const arrWinEnd = (this._parseHHMM(layer.arrivalWindow.end) || 0) + (layer.timeShiftMin || 0) + (layer.arrShiftMin || 0);
                const depWinStart = (this._parseHHMM(layer.departureWindow.start) || 0) + (layer.timeShiftMin || 0) + (layer.depShiftMin || 0);
                const depWinEnd = (this._parseHHMM(layer.departureWindow.end) || 0) + (layer.timeShiftMin || 0) + (layer.depShiftMin || 0);

                // If a flight's arrival happens AFTER the departure window starts, or its departure happens BEFORE the arrival window ends,
                // it fundamentally breaks the wave connectivity pattern.
                if (endMin > depWinStart && startMin < depWinEnd) {
                     collisions.push(layer);
                }
            }
        }
        return collisions;
    }

    _parseHHMM(timeStr) {
        if (!timeStr) return null;
        const parts = timeStr.split(":");
        if (parts.length !== 2) return null;
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    _fireFilterEvent() {
        if (!this.rootEl) return
        try {
            this.rootEl.dispatchEvent(new CustomEvent("aes-fsg:filter-changed", {
                detail: {routeKey: this._filterRoute},
                bubbles: true
            }))
        } catch (_) { /* noop */ }
    }

    /**
     * Resolve {fill, edge} for a flight block under the active color mode.
     * Override-aware: if the user has set a custom color for the active
     * dimension's key, that wins; otherwise fall back to the deterministic
     * palette from FleetScheduleGridColoring.
     */
    _resolveBlockColors(b, ids) {
        const ov = this._overrides
        const FALLBACK_FILL = "#cfe9d2", FALLBACK_EDGE = "#5a8a6a"
        if (this._colorMode === "aircraft") {
            const out = (typeof FleetScheduleGridColoring !== "undefined")
                ? FleetScheduleGridColoring.colorOfAircraft(ids.aircraftId, ov)
                : null
            return out || {fill: FALLBACK_FILL, edge: FALLBACK_EDGE}
        }
        if (this._colorMode === "day") {
            const out = (typeof FleetScheduleGridColoring !== "undefined")
                ? FleetScheduleGridColoring.colorOfDay(ids.dayIdx, ov)
                : null
            return out || {fill: FALLBACK_FILL, edge: FALLBACK_EDGE}
        }
        // Route mode — let coloring.colorOf consult byRoute overrides.
        const rk = ids.routeKey
        const fill = (rk && this.coloring) ? this.coloring.colorOf(rk) : FALLBACK_FILL
        const edge = (rk && this.coloring) ? this.coloring.edgeOf(rk) : FALLBACK_EDGE
        return {fill, edge}
    }

    _openFlightContextMenu(ctx) {
        if (typeof document === "undefined") return
        // Single-instance — close any prior menu first.
        const prior = document.querySelector(".aes-fsg-ctx-menu")
        if (prior && prior.parentElement) prior.parentElement.removeChild(prior)

        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const menu = document.createElement("div")
        menu.className = "aes-fsg-ctx-menu"
        menu.style.cssText = [
            "position:fixed",
            "z-index:" + (T ? T.z.popover || 9999 : 9999),
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "border:1px solid " + (T ? T.color.oxide : "#2B2520"),
            "box-shadow:0 4px 14px rgba(0,0,0,0.25)",
            "min-width:200px",
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-size:11px",
            "padding:4px 0"
        ].join(";")

        const addItem = (label, fn) => {
            const item = document.createElement("button")
            item.type = "button"
            item.textContent = label
            item.style.cssText = "display:block;width:100%;text-align:left;border:0;cursor:pointer;"
                + "background:transparent;padding:7px 12px;font-size:11px;"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            item.addEventListener("mouseenter", () => {
                item.style.background = T ? T.color.bone2 : "#ECE7DC"
            })
            item.addEventListener("mouseleave", () => { item.style.background = "transparent" })
            item.addEventListener("click", () => { close(); fn() })
            menu.appendChild(item)
        }

        const close = () => {
            if (menu.parentElement) menu.parentElement.removeChild(menu)
            document.removeEventListener("mousedown", onDocDown, true)
            document.removeEventListener("keydown",   onKey,     true)
        }
        const onDocDown = (ev) => { if (!menu.contains(ev.target)) close() }
        const onKey     = (ev) => { if (ev.key === "Escape") close() }

        if (ctx.routeKey) {
            const filterLabel = (this._filterRoute === ctx.routeKey)
                ? "Clear route filter"
                : "Filter to this route"
            addItem(filterLabel, () => {
                this._filterRoute = (this._filterRoute === ctx.routeKey) ? null : ctx.routeKey
                this.render()
                this._fireFilterEvent()
            })
        }

        const scope = (this._colorMode === "aircraft") ? "aircraft"
                    : (this._colorMode === "day")      ? "day"
                    : "route"
        const scopeKey = scope === "aircraft" ? ctx.aircraftId
                      : scope === "day"      ? (ctx.dayIdx != null ? String(ctx.dayIdx) : null)
                      : ctx.routeKey
        const scopeLabel = scope === "aircraft" ? this._labelForAircraft(ctx.aircraftId)
                        : scope === "day"      ? (FleetScheduleGridRenderer.DAY_NAMES[ctx.dayIdx] || ("Day " + ctx.dayIdx))
                        : (ctx.routeKey || "Route")
        const currentColor = this._currentOverrideFor(scope, scopeKey)
        addItem("Set color…", () => {
            this._openColorPicker({
                scope, key: scopeKey, label: scopeLabel,
                currentColor, anchorEl: ctx.el
            })
        })

        document.body.appendChild(menu)
        // Position near pointer, then clamp inside viewport.
        const vw = window.innerWidth || 1024
        const vh = window.innerHeight || 768
        const w = menu.offsetWidth || 220
        const h = menu.offsetHeight || 80
        let left = ctx.clientX != null ? ctx.clientX : 100
        let top  = ctx.clientY != null ? ctx.clientY : 100
        if (left + w + 8 > vw) left = vw - w - 8
        if (top  + h + 8 > vh) top  = vh - h - 8
        menu.style.left = left + "px"
        menu.style.top  = top + "px"

        setTimeout(() => {
            document.addEventListener("mousedown", onDocDown, true)
            document.addEventListener("keydown",   onKey,     true)
        }, 0)
    }

    _openColorPicker(opts) {
        if (typeof window === "undefined" || !window.FleetScheduleGridColorPicker) return
        const anchorRect = (opts.anchorEl && opts.anchorEl.getBoundingClientRect)
            ? opts.anchorEl.getBoundingClientRect()
            : null
        window.FleetScheduleGridColorPicker.open({
            scope:        opts.scope,
            key:          opts.key,
            label:        opts.label,
            currentColor: opts.currentColor || "",
            anchorRect,
            onApplied: (next) => {
                this._overrides = next
                this.render()
                if (this.rootEl) {
                    try {
                        this.rootEl.dispatchEvent(new CustomEvent("aes-fsg:overrides-changed", {
                            detail: {overrides: next},
                            bubbles: true
                        }))
                    } catch (_) {}
                }
            }
        })
    }

    _currentOverrideFor(scope, key) {
        const ov = this._overrides
        if (!ov) return ""
        if (scope === "route"    && ov.byRoute    && key) return ov.byRoute[key]    || ""
        if (scope === "aircraft" && ov.byAircraft && key) return ov.byAircraft[key] || ""
        if (scope === "day"      && ov.byDay      && key) return ov.byDay[key]      || ""
        return ""
    }

    _labelForAircraft(aircraftId) {
        if (!aircraftId) return "Aircraft"
        const row = (this.fleet || []).find(r => String(r.aircraftId) === String(aircraftId))
        return (row && (row.registration || row.aircraftId)) || String(aircraftId)
    }

    /**
     * Day-overlay row: a single 24h lane that overlays every visible
     * aircraft's flights for `dayIdx`. Each block carries data-aircraft-id
     * so the inspector / drag handlers can still resolve the source flight.
     * Visual treatment: opacity 0.55 + mix-blend-mode multiply, so overlap
     * shows as darker shades — intentional density signal.
     */
    _buildDayOverlayRow(dayIdx, visibleFleet, T) {
        const wrap = document.createElement("div")
        wrap.className = "aes-fsg-day-row aes-fsg-day-row--overlay"
        wrap.style.cssText = "display:flex;align-items:stretch;border-bottom:2px solid "
            + (T ? T.color.oxide : "#2B2520") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"

        // Stat the row — count flights and aircraft contributing this day.
        let flightCount = 0
        const aircraftSet = new Set()
        const blocksByAircraft = []
        for (const row of visibleFleet) {
            const sched = this.schedules.get(String(row.aircraftId))
            const day = sched && Array.isArray(sched.days) ? sched.days[dayIdx] : null
            if (!day) continue
            const blocks = (day.blocks || [])
            const flights = blocks.filter(b => b && b.kind === "flight")
            if (!flights.length && !blocks.length) continue
            blocksByAircraft.push({row, blocks})
            if (flights.length) {
                flightCount += flights.length
                aircraftSet.add(String(row.aircraftId))
            }
        }

        const labelGutter = document.createElement("div")
        labelGutter.style.cssText = "flex:0 0 140px;padding:0 8px;display:flex;flex-direction:column;justify-content:center;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "font-size:11px;color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border-right:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        const dayName = document.createElement("span")
        dayName.style.cssText = "font-weight:700;letter-spacing:0.06em;text-transform:uppercase;"
        dayName.textContent = FleetScheduleGridRenderer.DAY_NAMES[dayIdx] || ("Day " + dayIdx)
        const stat = document.createElement("span")
        stat.style.cssText = "font-size:10px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        stat.textContent = flightCount + " flight" + (flightCount === 1 ? "" : "s")
            + " · " + aircraftSet.size + " ✈"
        labelGutter.append(dayName, stat)

        const lane = document.createElement("div")
        lane.dataset.dayIdx = String(dayIdx)
        lane.dataset.rowMode = "dayOverlay"
        lane.style.cssText = "flex:1 1 auto;position:relative;height:60px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"

        // Hour gridlines.
        for (let h = 1; h < 24; h++) {
            const pct = (h / 24) * 100
            const tick = document.createElement("div")
            tick.style.cssText = "position:absolute;left:" + pct + "%;top:0;bottom:0;"
                + "width:1px;background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
                + (h % 6 === 0 ? "background:" + (T ? T.color.bone3 : "#E0DAC8") + ";" : "")
            lane.appendChild(tick)
        }

        // Paint blocks with overlay treatment.
        for (const {row, blocks} of blocksByAircraft) {
            for (const b of blocks) {
                const blockEl = this._buildBlock(b, T, {aircraftId: row.aircraftId, dayIdx})
                if (!blockEl) continue
                blockEl.classList.add("aes-fsg-block--overlay")
                blockEl.style.opacity   = blockEl.style.opacity || "0.55"
                blockEl.style.mixBlendMode = "multiply"
                lane.appendChild(blockEl)
            }
        }

        wrap.append(labelGutter, lane)
        return wrap
    }

    _fmtAge(ts) {
        if (!ts) return "(unknown)"
        const ms = Date.now() - ts
        if (ms < 60_000)        return Math.floor(ms / 1000) + "s ago"
        if (ms < 3600_000)      return Math.floor(ms / 60_000) + "m ago"
        if (ms < 86_400_000)    return Math.floor(ms / 3600_000) + "h ago"
        return Math.floor(ms / 86_400_000) + "d ago"
    }

    /**
     * Append " · MX X% · Cond Y%" to the row-header summary span. Values are
     * read from AesAfpMaintenanceStore (populated when the user opens the AFP
     * page for the tail). Status colors mirror the AFP sidebar widget so the
     * two surfaces look consistent. When no reading exists the chips render
     * dashes in muted gray.
     */
    _appendMaintenanceChips(parentEl, row, T) {
        const STATUS_COLOR = {good: "#34d399", warn: "#facc15", bad: "#f87171"}
        const muted = T ? T.color.slate : "#7A6F66"
        const rec = this.maintenance.get(String(row.aircraftId)) || null

        const ratio = rec && typeof rec.ratio === "number" && isFinite(rec.ratio) ? rec.ratio : null
        const cond  = rec && typeof rec.condition === "number" && isFinite(rec.condition) ? rec.condition : null
        const ratioColor = (rec && STATUS_COLOR[rec.ratioStatus]) || muted
        const condColor  = (rec && STATUS_COLOR[rec.conditionStatus]) || muted

        const sep1 = document.createTextNode(" · ")
        const mxChip = document.createElement("span")
        mxChip.style.cssText = "color:" + ratioColor + ";"
        mxChip.textContent = "MX " + (ratio != null ? ratio.toFixed(1) + "%" : "—")
        mxChip.title = "Maintenance ratio (read at last AFP scrape)"

        const sep2 = document.createTextNode(" · ")
        const condChip = document.createElement("span")
        condChip.style.cssText = "color:" + condColor + ";"
        condChip.textContent = "Cond " + (cond != null ? Math.round(cond) + "%" : "—")
        condChip.title = "Airframe condition (read at last AFP scrape)"

        parentEl.append(sep1, mxChip, sep2, condChip)
    }

    /** Build a legend element from coloring.routes. Caller embeds. */
    static buildLegend(coloring, opts) {
        const o = opts || {}
        const onClick = typeof o.onClick === "function" ? o.onClick : null
        const filterRoute = o.filterRoute || null
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px 8px;padding:8px 12px;"
            + "border-top:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:" + (T ? T.color.bone2 : "#ECE7DC") + ";"
            + "font-size:11px;color:" + (T ? T.color.oxide : "#2B2520") + ";"

        if (!coloring || !coloring.routes || !coloring.routes.length) {
            wrap.textContent = "No routes loaded yet."
            return wrap
        }

        const title = document.createElement("div")
        title.style.cssText = "flex:0 0 100%;font-weight:700;text-transform:uppercase;"
            + "letter-spacing:0.06em;font-size:10px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "margin-bottom:2px;"
        title.textContent = "Routes (" + coloring.routes.length + ")"
        wrap.appendChild(title)

        for (const r of coloring.routes) {
            const chip = document.createElement("button")
            chip.type = "button"
            const isFiltered = filterRoute === r.key
            chip.style.cssText = "display:inline-flex;align-items:center;gap:5px;"
                + "padding:2px 7px;border-radius:2px;cursor:pointer;font-size:11px;"
                + "background:" + r.color + ";"
                + "border:1.5px solid " + (isFiltered ? (T ? T.color.oxide : "#2B2520") : r.colorEdge) + ";"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
                + (isFiltered ? "box-shadow:0 0 0 1px " + (T ? T.color.oxide : "#2B2520") + " inset;" : "")
            const label = document.createElement("span")
            label.textContent = r.origin + "→" + r.destination
            const stat = document.createElement("span")
            stat.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";font-size:10px;"
            stat.textContent = "·" + r.count + "·" + r.aircraftCount + "✈"
            chip.append(label, stat)
            chip.title = "Filter by " + r.origin + " → " + r.destination
                + " · " + r.count + " flight" + (r.count === 1 ? "" : "s")
                + " across " + r.aircraftCount + " aircraft"
            chip.addEventListener("click", () => onClick && onClick(r.key, r))
            chip.addEventListener("mouseenter", () => onClick && onClick(r.key, r, "hover-in"))
            chip.addEventListener("mouseleave", () => onClick && onClick(r.key, r, "hover-out"))
            wrap.appendChild(chip)
        }

        return wrap
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridRenderer = FleetScheduleGridRenderer
}
