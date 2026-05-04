"use strict"

/**
 * CanvasWaveSpineRenderer — wave-columns × aircraft-rows view.
 *
 * Differs from FleetScheduleGridRenderer (the legacy "Timeline" view) by
 * making the wave the primary axis. Each column is one wave from the
 * active preset; each row is one aircraft. A cell holds the flights this
 * aircraft flies in that wave's window across the week, summarised as:
 *
 *   - Top destination (most-frequent across the 7 days)
 *   - Day-pill strip (M T W T F S S; filled if a flight exists that day)
 *   - Flight count, total block minutes
 *
 * Empty cells render an "open" affordance so they're drop-targets for the
 * dnd source panel + builder previews. Demand and ORS overlays in Phase F
 * paint on top.
 *
 * Pure renderer: takes data via constructor + setters, emits DOM events on
 * the rootEl. State (active hub, focused aircraft) lives in the canvas
 * shell or canvas-state-store, NOT here.
 */
class CanvasWaveSpineRenderer {

    static EVENT_AIRCRAFT_CLICK = "canvas:wave-spine:aircraft-click"
    static EVENT_WAVE_CLICK     = "canvas:wave-spine:wave-click"
    static EVENT_CELL_CLICK     = "canvas:wave-spine:cell-click"
    static EVENT_OPEN_TIMELINE  = "canvas:wave-spine:open-timeline"

    static DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"]

    constructor(deps) {
        const d = deps || {}
        this.rootEl    = d.rootEl
        this.fleet     = Array.isArray(d.fleet) ? d.fleet : []
        this.preset    = d.preset || null
        this.schedules = d.schedules instanceof Map ? d.schedules : new Map()
        this.coloring  = d.coloring || null
        this.activeHub = d.activeHub || null
        this.focusedAircraftId = d.focusedAircraftId || null
    }

    update(deps) {
        if (!deps) return
        if (deps.fleet     !== undefined) this.fleet = Array.isArray(deps.fleet) ? deps.fleet : []
        if (deps.preset    !== undefined) this.preset = deps.preset
        if (deps.schedules !== undefined) {
            this.schedules = deps.schedules instanceof Map ? deps.schedules : new Map()
        }
        if (deps.coloring  !== undefined) this.coloring = deps.coloring
        if (deps.activeHub !== undefined) this.activeHub = deps.activeHub
        if (deps.focusedAircraftId !== undefined) this.focusedAircraftId = deps.focusedAircraftId
    }

    render() {
        if (!this.rootEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        this.rootEl.innerHTML = ""
        this.rootEl.style.cssText = [
            "display:grid",
            "grid-auto-rows:max-content",
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
            "font-size:" + (T ? T.fs.body : "12px"),
            "min-height:240px",
            "position:relative"
        ].join(";")

        const rows = this._fleetForActiveHub()
        const waves = this._waves()

        if (!rows.length) {
            this.rootEl.appendChild(this._buildEmptyHubMessage(T))
            return
        }
        if (!waves.length) {
            this.rootEl.appendChild(this._buildNoPresetMessage(T))
            return
        }

        // Column template: aircraft-name column + N wave columns.
        const cols = "240px " + waves.map(() => "minmax(160px, 1fr)").join(" ")
        this.rootEl.style.gridTemplateColumns = cols

        // Header row.
        this.rootEl.appendChild(this._buildCornerCell(T))
        for (const w of waves) this.rootEl.appendChild(this._buildWaveHeader(T, w))

        // Aircraft rows.
        for (const row of rows) {
            this.rootEl.appendChild(this._buildAircraftCell(T, row))
            for (const w of waves) {
                this.rootEl.appendChild(this._buildScheduleCell(T, row, w))
            }
        }
    }

    /**
     * Filter the fleet to aircraft that belong on the active hub canvas.
     * Prefer explicit fleet hub/location metadata, but do not hide a cached
     * schedule just because the fleet row has not been enriched yet. A
     * schedule whose hubIata or legs touch the active hub is still actionable
     * in the wave view and should render.
     */
    _fleetForActiveHub() {
        if (!this.activeHub) return this.fleet.slice()
        const target = String(this.activeHub).toUpperCase()
        return this.fleet.filter(r => {
            if (!r) return false
            if (String(r.hub || "").toUpperCase() === target) return true
            if (String(r.locIata || "").toUpperCase() === target) return true
            if (String(r.gravityHub || "").toUpperCase() === target) return true
            const sched = this.schedules.get(String(r.aircraftId))
            return this._scheduleTouchesHub(sched, target)
        })
    }

    _scheduleTouchesHub(schedule, hub) {
        const HUB = String(hub || "").toUpperCase()
        if (!HUB || !schedule) return false
        if (String(schedule.hubIata || "").toUpperCase() === HUB) return true
        const legs = Array.isArray(schedule.legs) ? schedule.legs : []
        for (const leg of legs) {
            if (String(leg && leg.origin || "").toUpperCase() === HUB) return true
            if (String(leg && leg.destination || "").toUpperCase() === HUB) return true
        }
        return false
    }

    _waves() {
        if (!this.preset || !Array.isArray(this.preset.waves)) return []
        return this.preset.waves.filter(w => w && !w.archivedAt)
    }

    _buildCornerCell(T) {
        const el = document.createElement("div")
        el.style.cssText = [
            "padding:8px 10px",
            "background:" + (T ? T.color.bone3 : "#E0DAC8"),
            "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "border-right:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "font-weight:" + (T ? T.fw.display : "800"),
            "font-size:11px",
            "letter-spacing:0.08em",
            "text-transform:uppercase",
            "position:sticky",
            "top:0",
            "left:0",
            "z-index:3"
        ].join(";")
        el.textContent = (this.activeHub || "Hub") + " · Aircraft"
        return el
    }

    _buildWaveHeader(T, wave) {
        const el = document.createElement("div")
        el.dataset.canvasWaveId = wave.id
        el.style.cssText = [
            "padding:8px 10px",
            "background:" + (T ? T.color.bone3 : "#E0DAC8"),
            "border-bottom:" + (T ? T.geom.bw2 : "2px") + " solid " + (T ? T.color.oxide : "#2B2520"),
            "border-right:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "position:sticky",
            "top:0",
            "z-index:2",
            "cursor:pointer"
        ].join(";")
        const name = document.createElement("div")
        name.style.cssText = "font-weight:" + (T ? T.fw.display : "800") + ";font-size:11px;letter-spacing:0.06em;text-transform:uppercase;"
        name.textContent = wave.label || "Wave"
        const win = document.createElement("div")
        win.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
        const a = wave.arrivalWindow || {}
        const d = wave.departureWindow || {}
        win.textContent = "ARR " + (a.start || "—") + "–" + (a.end || "—") + "  ·  DEP " + (d.start || "—") + "–" + (d.end || "—")
        const comp = wave.composition || {}
        const compStr = "S " + (comp.shortHaul || 0) + " · M " + (comp.mediumHaul || 0) + " · L " + (comp.longHaul || 0)
        const sub = document.createElement("div")
        sub.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
        sub.textContent = compStr
        el.append(name, win, sub)
        el.addEventListener("click", () => {
            this.rootEl.dispatchEvent(new CustomEvent(CanvasWaveSpineRenderer.EVENT_WAVE_CLICK,
                {bubbles: true, detail: {presetId: this.preset && this.preset.id, waveId: wave.id}}))
        })
        return el
    }

    _buildAircraftCell(T, row) {
        const el = document.createElement("div")
        const focused = this.focusedAircraftId && String(row.aircraftId) === String(this.focusedAircraftId)
        el.dataset.canvasAircraftId = row.aircraftId
        el.style.cssText = [
            "padding:10px 12px",
            "background:" + (focused ? (T ? T.color.bone3 : "#E0DAC8") : (T ? T.color.bone : "#F4F1EA")),
            "border-right:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "position:sticky",
            "left:0",
            "z-index:1",
            "cursor:pointer"
        ].join(";")
        const reg = document.createElement("div")
        reg.style.cssText = "font-weight:" + (T ? T.fw.display : "800") + ";font-size:12px;letter-spacing:0.04em;"
        reg.textContent = row.registration || row.aircraftId
        const sub = document.createElement("div")
        sub.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
        sub.textContent = (row.equipment || row.typeId || "—")
        const links = document.createElement("div")
        links.style.cssText = "display:flex;gap:8px;margin-top:4px;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;"
        const fp = document.createElement("a")
        fp.href = "/app/fleets/aircraft/" + encodeURIComponent(row.aircraftId) + "/0"
        fp.target = "_blank"
        fp.rel = "noopener"
        fp.textContent = "Flight plan"
        fp.style.cssText = "color:" + (T ? T.color.rust : "#B8472A") + ";text-decoration:none;"
        fp.addEventListener("click", ev => ev.stopPropagation())
        const hist = document.createElement("a")
        hist.href = "/app/fleets/aircraft/" + encodeURIComponent(row.aircraftId) + "/1"
        hist.target = "_blank"
        hist.rel = "noopener"
        hist.textContent = "Flights"
        hist.style.cssText = "color:" + (T ? T.color.rust : "#B8472A") + ";text-decoration:none;"
        hist.addEventListener("click", ev => ev.stopPropagation())
        links.append(fp, hist)
        el.append(reg, sub, links)
        el.addEventListener("click", () => {
            this.rootEl.dispatchEvent(new CustomEvent(CanvasWaveSpineRenderer.EVENT_AIRCRAFT_CLICK,
                {bubbles: true, detail: {aircraftId: row.aircraftId}}))
        })
        return el
    }

    _buildScheduleCell(T, row, wave) {
        const el = document.createElement("div")
        el.dataset.canvasAircraftId = row.aircraftId
        el.dataset.canvasWaveId = wave.id
        const summary = this._summariseWaveCell(row, wave)
        const isEmpty = summary.flightCount === 0
        el.dataset.canvasEmptyCell = isEmpty ? "1" : "0"
        el.style.cssText = [
            "padding:6px 8px",
            "border-right:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "min-height:64px",
            "background:" + (isEmpty ? "transparent" : (T ? T.color.bone2 : "#ECE7DC")),
            "cursor:pointer",
            "position:relative",
            "transition:background 80ms linear"
        ].join(";")
        if (isEmpty) {
            const hint = document.createElement("div")
            hint.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:11px;font-style:italic;opacity:0.6;"
            hint.textContent = "+ open"
            el.append(hint)
        } else {
            el.draggable = true
            el.title = "Drag this scheduled cell onto another wave or aircraft to stage a move."
            el.addEventListener("dragstart", (ev) => this._onCellDragStart(ev, row, wave, summary))
            const head = document.createElement("div")
            head.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;gap:8px;"
            const dest = document.createElement("span")
            dest.style.cssText = "font-weight:" + (T ? T.fw.bold : "700") + ";font-size:12px;"
            dest.textContent = summary.topDest || "—"
            const cnt = document.createElement("span")
            cnt.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
            cnt.textContent = summary.flightCount + "× · " + Math.round(summary.totalBlockMin / 6) / 10 + "h"
            head.append(dest, cnt)
            const days = document.createElement("div")
            days.style.cssText = "display:flex;gap:2px;margin-top:4px;"
            for (let i = 0; i < 7; i++) {
                const pill = document.createElement("span")
                const filled = summary.dayMask[i]
                pill.style.cssText = [
                    "width:14px",
                    "height:10px",
                    "display:inline-flex",
                    "align-items:center",
                    "justify-content:center",
                    "font-family:" + (T ? T.font.mono : "monospace"),
                    "font-size:8px",
                    "color:" + (filled ? "#fff" : (T ? T.color.slate : "#7A6F66")),
                    "background:" + (filled ? (summary.color || (T ? T.color.cobalt : "#3656A8")) : "transparent"),
                    "border:1px solid " + (filled ? (summary.color || (T ? T.color.cobalt : "#3656A8")) : (T ? T.color.paperRule : "#C9C0B0")),
                    "border-radius:1px"
                ].join(";")
                pill.textContent = CanvasWaveSpineRenderer.DAY_LETTERS[i]
                pill.title = filled
                    ? "Flight to " + (summary.topDest || "—") + " on " + ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i]
                    : "no flight"
                days.append(pill)
            }
            const legList = this._buildLegList(T, summary)
            el.append(head, days)
            if (legList) el.append(legList)
        }
        el.addEventListener("click", () => {
            this.rootEl.dispatchEvent(new CustomEvent(CanvasWaveSpineRenderer.EVENT_CELL_CLICK,
                {bubbles: true, detail: {aircraftId: row.aircraftId, presetId: this.preset && this.preset.id, waveId: wave.id, isEmpty}}))
        })
        return el
    }

    _buildLegList(T, summary) {
        const legs = Array.isArray(summary.legs) ? summary.legs : []
        if (!legs.length) return null
        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-top:5px;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;"
            + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        for (const leg of legs.slice(0, 3)) {
            const line = document.createElement("div")
            line.style.cssText = "display:flex;align-items:center;gap:5px;min-width:0;"
            const fnText = leg.flightNumber || leg.flightCode || (leg.flightId ? "#" + leg.flightId : "#auto")
            let fnNode
            if (leg.flightLink) {
                const a = document.createElement("a")
                a.href = leg.flightLink
                a.target = "_blank"
                a.rel = "noopener"
                a.textContent = fnText
                a.title = "Open flight number"
                a.style.cssText = "color:" + (T ? T.color.rust : "#B8472A") + ";text-decoration:none;font-weight:700;white-space:nowrap;"
                a.addEventListener("click", ev => ev.stopPropagation())
                fnNode = a
            } else {
                fnNode = document.createElement("span")
                fnNode.textContent = fnText
                fnNode.style.cssText = "font-weight:700;white-space:nowrap;"
            }
            const day = document.createElement("span")
            day.textContent = CanvasWaveSpineRenderer.DAY_LETTERS[leg.dayIdx] || "?"
            day.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            const route = document.createElement("span")
            route.textContent = (leg.origin || "?") + "→" + (leg.destination || "?")
            route.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
            const time = document.createElement("span")
            time.textContent = leg.depTimeLocal || "—"
            time.style.cssText = "margin-left:auto;color:" + (T ? T.color.slate : "#7A6F66") + ";white-space:nowrap;"
            line.append(fnNode, day, route, time)
            list.append(line)
        }
        if (legs.length > 3) {
            const more = document.createElement("div")
            more.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:9px;"
            more.textContent = "+" + (legs.length - 3) + " more"
            list.append(more)
        }
        return list
    }

    _onCellDragStart(ev, row, wave, summary) {
        if (!ev || !ev.dataTransfer || !summary || !summary.flightCount) return
        const leg = Array.isArray(summary.legs) && summary.legs.length ? summary.legs[0] : null
        const payload = {
            kind:             "canvas.schedule-cell",
            aircraftId:       String(row.aircraftId || ""),
            registration:     row.registration || "",
            presetId:         this.preset && this.preset.id || null,
            waveId:           wave && wave.id || null,
            hub:              this.activeHub || row.hub || "",
            destIata:         summary.topDest || (leg && leg.destination) || "",
            flightCount:      summary.flightCount,
            sourceLegSeq:     leg && leg.seq != null ? leg.seq : null,
            flightId:         leg && leg.flightId || null,
            flightNumber:     leg && (leg.flightNumber || leg.flightCode) || null,
            origin:           leg && leg.origin || null,
            destination:      leg && leg.destination || summary.topDest || null,
            depTimeLocal:     leg && leg.depTimeLocal || null
        }
        const dtType = (typeof window !== "undefined"
                && window.CanvasDropBridge
                && window.CanvasDropBridge.DT_CELL_TYPE)
            || "application/x-aes-canvas-cell"
        try {
            ev.dataTransfer.effectAllowed = "move"
            ev.dataTransfer.setData(dtType, JSON.stringify(payload))
            ev.dataTransfer.setData("text/plain", payload.destIata || "schedule-cell")
        } catch (_) { /* noop */ }
    }

    /**
     * Bucket this aircraft's legs into the given wave window. Outbound legs
     * belong by departure window; inbound legs belong by arrival window.
     * When the hub side is unknown, fall back to either window so cached
     * schedules still surface instead of showing a false "+ open" cell.
     */
    _summariseWaveCell(row, wave) {
        const out = {flightCount: 0, totalBlockMin: 0, topDest: null, dayMask: [false,false,false,false,false,false,false], color: null, legs: []}
        const sched = this.schedules.get(String(row.aircraftId))
        if (!sched || !Array.isArray(sched.legs) || !sched.legs.length) return out
        const dep = wave.departureWindow || {}
        const arr = wave.arrivalWindow || {}
        const depStartMin = _hhmmToMin(dep.start)
        const depEndMin = _hhmmToMin(dep.end)
        const arrStartMin = _hhmmToMin(arr.start)
        const arrEndMin = _hhmmToMin(arr.end)
        if ((depStartMin === null || depEndMin === null)
                && (arrStartMin === null || arrEndMin === null)) return out
        const hub = String(this.activeHub || row.hub || row.locIata || sched.hubIata || "").toUpperCase()
        const destCounts = new Map()
        for (const leg of sched.legs) {
            const match = this._legWaveMatch(leg, {
                hub,
                depStartMin,
                depEndMin,
                arrStartMin,
                arrEndMin
            })
            if (!match) continue
            out.flightCount++
            out.totalBlockMin += Number(leg.durationMin) || 0
            const dayIdx = Number(leg.dayIdx)
            if (dayIdx >= 0 && dayIdx < 7) out.dayMask[dayIdx] = true
            const dest = match.station || ""
            if (dest) destCounts.set(dest, (destCounts.get(dest) || 0) + 1)
            out.legs.push({
                seq:          leg.seq,
                dayIdx:       leg.dayIdx,
                origin:       leg.origin || null,
                destination:  leg.destination || null,
                depTimeLocal: leg.depTimeLocal || null,
                arrTimeLocal: leg.arrTimeLocal || null,
                waveDirection: match.direction,
                flightCode:   leg.flightCode || null,
                flightNumber: leg.flightNumber || leg.flightCode || null,
                flightId:     leg.flightId || null,
                flightLink:   leg.flightLink || null
            })
        }
        let topDest = null, topN = 0
        for (const [d, n] of destCounts) if (n > topN) { topDest = d; topN = n }
        out.topDest = topDest
        if (this.coloring && topDest) {
            const key = (row.locIata || row.hub || this.activeHub || "") + "-" + topDest
            const colored = this.coloring.get ? this.coloring.get(key) : null
            if (colored && colored.color) out.color = colored.color
        }
        return out
    }

    _legWaveMatch(leg, ctx) {
        if (!leg) return null
        const origin = String(leg.origin || "").toUpperCase()
        const dest = String(leg.destination || "").toUpperCase()
        const hub = String(ctx && ctx.hub || "").toUpperCase()
        const depMin = _hhmmToMin(leg.depTimeLocal)
        const arrMin = _hhmmToMin(leg.arrTimeLocal)
        const depOk = _minInWindow(depMin, ctx.depStartMin, ctx.depEndMin)
        const arrOk = _minInWindow(arrMin, ctx.arrStartMin, ctx.arrEndMin)

        if (hub && origin === hub && depOk) {
            return {direction: "outbound", station: dest || origin}
        }
        if (hub && dest === hub && arrOk) {
            return {direction: "inbound", station: origin || dest}
        }
        if (!hub) {
            if (depOk) return {direction: "departure", station: dest || origin}
            if (arrOk) return {direction: "arrival", station: dest || origin}
            return null
        }
        if (depOk || arrOk) {
            const station = (origin === hub) ? dest : ((dest === hub) ? origin : (dest || origin))
            return {direction: depOk ? "departure" : "arrival", station}
        }
        return null
    }

    _buildEmptyHubMessage(T) {
        const el = document.createElement("div")
        el.style.cssText = "padding:48px 32px;text-align:center;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        el.textContent = this.activeHub
            ? "No aircraft assigned to " + this.activeHub + "."
            : "Pick a hub above to populate the wave canvas."
        return el
    }

    _buildNoPresetMessage(T) {
        const el = document.createElement("div")
        el.style.cssText = "padding:48px 32px;text-align:center;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        const lead = document.createElement("div")
        lead.style.cssText = "font-size:13px;font-weight:" + (T ? T.fw.bold : "700") + ";margin-bottom:8px;"
        lead.textContent = "No wave preset for " + (this.activeHub || "this hub")
        const sub = document.createElement("div")
        sub.style.cssText = "font-size:11px;margin-bottom:14px;"
        sub.textContent = "Create one from Route Assistant Waves, or use Timeline to schedule without wave cells."
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = "Open Timeline"
        btn.style.cssText = [
            "padding:6px 12px",
            "font-size:10px",
            "font-weight:" + (T ? T.fw.bold : "700"),
            "letter-spacing:0.06em",
            "text-transform:uppercase",
            "border:1px solid " + (T ? T.color.oxide : "#2B2520"),
            "background:" + (T ? T.color.bone : "#F4F1EA"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "cursor:pointer"
        ].join(";")
        btn.addEventListener("click", () => {
            this.rootEl.dispatchEvent(new CustomEvent(CanvasWaveSpineRenderer.EVENT_OPEN_TIMELINE,
                {bubbles: true, detail: {hub: this.activeHub || ""}}))
        })
        el.append(lead, sub, btn)
        return el
    }
}

function _hhmmToMin(s) {
    if (typeof s !== "string") return null
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const h = +m[1], min = +m[2]
    if (h < 0 || h > 23 || min < 0 || min > 59) return null
    return h * 60 + min
}

function _minInWindow(value, start, end) {
    if (value === null || start === null || end === null) return false
    return (start <= end)
        ? (value >= start && value <= end)
        : (value >= start || value <= end)
}

if (typeof window !== "undefined") {
    window.CanvasWaveSpineRenderer = CanvasWaveSpineRenderer
}
