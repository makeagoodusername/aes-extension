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
     * Filter the fleet to aircraft whose home hub matches the active hub.
     * Aircraft with no hub field stay out (they'd render incorrectly under
     * a wave that targets a specific airport). The Fleet Command Center
     * "Unassigned" callout already handles those rows.
     */
    _fleetForActiveHub() {
        if (!this.activeHub) return this.fleet.slice()
        const target = String(this.activeHub).toUpperCase()
        return this.fleet.filter(r => r && String(r.hub || "").toUpperCase() === target)
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
        el.append(reg, sub)
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
            "transition:background 80ms linear"
        ].join(";")
        if (isEmpty) {
            const hint = document.createElement("div")
            hint.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:11px;font-style:italic;opacity:0.6;"
            hint.textContent = "+ open"
            el.append(hint)
        } else {
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
            el.append(head, days)
        }
        el.addEventListener("click", () => {
            this.rootEl.dispatchEvent(new CustomEvent(CanvasWaveSpineRenderer.EVENT_CELL_CLICK,
                {bubbles: true, detail: {aircraftId: row.aircraftId, presetId: this.preset && this.preset.id, waveId: wave.id, isEmpty}}))
        })
        return el
    }

    /**
     * Bucket this aircraft's legs into the given wave window. A leg
     * belongs to a wave when its `depTimeLocal` falls inside the wave's
     * departure window (HH:MM–HH:MM). Cross-midnight wraps would need
     * extra care; for now we treat midnight-spanning windows as a single
     * range for assignment (legs whose dep falls in the wrapped half just
     * miss this wave — acceptable for v1, since AS rarely flies through
     * midnight windows).
     */
    _summariseWaveCell(row, wave) {
        const out = {flightCount: 0, totalBlockMin: 0, topDest: null, dayMask: [false,false,false,false,false,false,false], color: null}
        const sched = this.schedules.get(String(row.aircraftId))
        if (!sched || !Array.isArray(sched.legs) || !sched.legs.length) return out
        const dep = wave.departureWindow || {}
        const startMin = _hhmmToMin(dep.start)
        const endMin = _hhmmToMin(dep.end)
        if (startMin === null || endMin === null) return out
        const destCounts = new Map()
        for (const leg of sched.legs) {
            const m = _hhmmToMin(leg.depTimeLocal)
            if (m === null) continue
            const inWindow = (startMin <= endMin)
                ? (m >= startMin && m <= endMin)
                : (m >= startMin || m <= endMin)  // wrap
            if (!inWindow) continue
            out.flightCount++
            out.totalBlockMin += Number(leg.durationMin) || 0
            const dayIdx = Number(leg.dayIdx)
            if (dayIdx >= 0 && dayIdx < 7) out.dayMask[dayIdx] = true
            const dest = leg.destination || ""
            if (dest) destCounts.set(dest, (destCounts.get(dest) || 0) + 1)
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
        sub.style.cssText = "font-size:11px;"
        sub.textContent = "Create one from Route Assistant → Waves, or open the Timeline view to schedule without a wave spine."
        el.append(lead, sub)
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

if (typeof window !== "undefined") {
    window.CanvasWaveSpineRenderer = CanvasWaveSpineRenderer
}
