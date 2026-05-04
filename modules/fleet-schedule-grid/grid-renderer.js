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
        this._showBlockLabels = o.showBlockLabels !== false
        this._lastEls      = []                    // {el, routeKey}
    }

    setHub(hub)         { this._filterHub = hub || null;     this.render() }
    setDay(dayMode)     { this._dayMode   = (dayMode == null ? "all" : dayMode); this.render() }
    setRouteFilter(key) { this._filterRoute = key || null;   this.render() }
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

        for (const row of visibleFleet) {
            const block = this._buildAircraftBlock(row, T)
            this.rootEl.appendChild(block)
        }

        // Notify overlays / drag handlers that the grid DOM has been rebuilt
        // so they can re-attach band painters and drop targets.
        try {
            this.rootEl.dispatchEvent(new CustomEvent("aes-fsg:rendered", {
                detail: {visibleFleet},
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
                const blockEl = this._buildBlock(b, T)
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

    _buildBlock(b, T) {
        if (!b || b.startMin == null || b.durationMin == null || b.durationMin <= 0) return null
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
            const fill = routeKey && this.coloring ? this.coloring.colorOf(routeKey) : "#cfe9d2"
            const edge = routeKey && this.coloring ? this.coloring.edgeOf(routeKey) : "#5a8a6a"
            el.style.background = fill
            el.style.border = "1px solid " + edge
            label = (b.flight.flightCode || (o + "→" + d))
            titleParts = [
                b.flight.flightCode || "(no code)",
                o + " → " + d,
                (b.startLocal || "??:??") + "–" + (b.endLocal || "??:??"),
                "Day " + (FleetScheduleGridRenderer.DAY_NAMES[b.dayIdx] || b.dayIdx),
                Math.round(b.durationMin) + " min"
            ]
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
            el.style.background = T ? T.color.slate : "#7A6F66"
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

        if (routeKey) {
            el.dataset.routeKey = routeKey
            el.addEventListener("mouseenter", () => this.setHoveredRoute(routeKey))
            el.addEventListener("mouseleave", () => this.setHoveredRoute(null))
            this._lastEls.push({el, routeKey})
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
            el.title += " · click: inspect · drag: shift time · right-click: filter route"
            el.addEventListener("contextmenu", (ev) => {
                if (!routeKey) return
                ev.preventDefault()
                this._filterRoute = (this._filterRoute === routeKey) ? null : routeKey
                this.render()
                this._fireFilterEvent()
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

    _fireFilterEvent() {
        if (!this.rootEl) return
        try {
            this.rootEl.dispatchEvent(new CustomEvent("aes-fsg:filter-changed", {
                detail: {routeKey: this._filterRoute},
                bubbles: true
            }))
        } catch (_) { /* noop */ }
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
