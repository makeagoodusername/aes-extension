"use strict"

/**
 * CanvasOrsTooltip — hover tooltip for canvas cells (filled or empty).
 *
 * On mouseenter of a cell with `data-canvas-aircraft-id` and
 * `data-canvas-wave-id`, the tooltip:
 *   - For empty cells: looks up the cached top demand candidate for the
 *     wave (same logic the demand overlay uses) and runs
 *     RouteAssistantOrsModel.project() against it for a quick projected-
 *     revenue + competitor share readout.
 *   - For filled cells: shows current legs (destination, departure time,
 *     duration) for that aircraft in that wave.
 *
 * The tooltip is a single floating div re-positioned per hover; only one
 * lookup runs at a time. The ORS projection is debounced 80 ms to avoid
 * spinning up calls while the user sweeps the mouse across cells.
 *
 * Cleanly removable: detach() removes all listeners and the floating div.
 */
class CanvasOrsTooltip {

    static DEBOUNCE_MS = 80

    constructor(deps) {
        const d = deps || {}
        this.spineHostEl = d.spineHostEl || null
        this.activeHub   = d.activeHub || null
        this.fleet       = Array.isArray(d.fleet) ? d.fleet : []
        this.schedules   = d.schedules instanceof Map ? d.schedules : new Map()
        this.preset      = d.preset || null

        this._tipEl = null
        this._mouseOverHandler = null
        this._mouseLeaveHandler = null
        this._mouseMoveHandler = null
        this._debounceTimer = null
        this._lastCell = null
    }

    attach() {
        if (!this.spineHostEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null

        this._tipEl = document.createElement("div")
        this._tipEl.className = "aes-canvas-ors-tip"
        this._tipEl.style.cssText = [
            "position:fixed",
            "z-index:" + (T ? T.z.toast : 10001),
            "padding:8px 10px",
            "max-width:240px",
            "background:" + (T ? T.color.oxide : "#2B2520"),
            "color:" + (T ? T.color.boneFg || "#F4F1EA" : "#F4F1EA"),
            "font-family:" + (T ? T.font.mono : "monospace"),
            "font-size:11px",
            "line-height:1.4",
            "border-radius:2px",
            "box-shadow:0 4px 12px rgba(0,0,0,0.4)",
            "pointer-events:none",
            "display:none"
        ].join(";")
        document.body.appendChild(this._tipEl)

        this._mouseOverHandler = (e) => {
            const cell = e.target && e.target.closest && e.target.closest("[data-canvas-aircraft-id][data-canvas-wave-id]")
            if (!cell || cell === this._lastCell) return
            this._lastCell = cell
            if (this._debounceTimer) clearTimeout(this._debounceTimer)
            this._debounceTimer = setTimeout(() => {
                this._populateTip(cell).catch(err => console.warn("[AES Canvas] ORS tip failed", err))
            }, CanvasOrsTooltip.DEBOUNCE_MS)
        }
        this._mouseLeaveHandler = (e) => {
            // Hide when leaving the spine host entirely.
            if (e.target === this.spineHostEl) {
                this._hide()
                this._lastCell = null
                if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null }
            }
        }
        this._mouseMoveHandler = (e) => {
            if (this._tipEl && this._tipEl.style.display !== "none") {
                const offset = 14
                this._tipEl.style.left = Math.min(e.clientX + offset, window.innerWidth - 260) + "px"
                this._tipEl.style.top  = Math.min(e.clientY + offset, window.innerHeight - 120) + "px"
            }
        }

        this.spineHostEl.addEventListener("mouseover", this._mouseOverHandler)
        this.spineHostEl.addEventListener("mouseleave", this._mouseLeaveHandler)
        document.addEventListener("mousemove", this._mouseMoveHandler)
    }

    detach() {
        if (this.spineHostEl) {
            if (this._mouseOverHandler)  this.spineHostEl.removeEventListener("mouseover", this._mouseOverHandler)
            if (this._mouseLeaveHandler) this.spineHostEl.removeEventListener("mouseleave", this._mouseLeaveHandler)
        }
        if (this._mouseMoveHandler) document.removeEventListener("mousemove", this._mouseMoveHandler)
        if (this._tipEl && this._tipEl.parentElement) this._tipEl.parentElement.removeChild(this._tipEl)
        if (this._debounceTimer) clearTimeout(this._debounceTimer)
        this._tipEl = null
        this._lastCell = null
    }

    async _populateTip(cell) {
        if (!cell || !this._tipEl) return
        const aircraftId = cell.dataset.canvasAircraftId
        const waveId = cell.dataset.canvasWaveId
        const isEmpty = cell.dataset.canvasEmptyCell === "1"
        const wave = this._waveById(waveId)
        if (!wave) { this._hide(); return }
        const lines = []

        if (!isEmpty) {
            const sched = this.schedules.get(String(aircraftId))
            const legs = this._legsInWave(sched, wave)
            lines.push(_strong("Aircraft " + aircraftId + " · " + (wave.label || "Wave")))
            for (const leg of legs.slice(0, 5)) {
                lines.push("→ " + leg.destination + " " + (leg.depTimeLocal || "?")
                    + " · " + (leg.durationMin || "?") + "m")
            }
            if (legs.length > 5) lines.push("… +" + (legs.length - 5) + " more")
        } else {
            const top = await this._topDemandFor(this.activeHub)
            if (!top) {
                lines.push(_strong("Empty · " + (wave.label || "Wave")))
                lines.push("No cached demand for " + (this.activeHub || "this hub") + ".")
            } else {
                lines.push(_strong("Empty · " + (wave.label || "Wave")))
                lines.push("Top demand: " + top.destIata + " (paxScore " + (top.paxScore || 0) + ")")
                if (top.profitPerWeek) lines.push("Est. AS$" + Math.round(top.profitPerWeek).toLocaleString() + "/week")
                if (top.weeklyFlights) lines.push("Currently " + top.weeklyFlights + "× weekly across the market")
                // ORS projection is heavy; skip in the tip and surface a "press to project" hint instead.
                lines.push("(click cell → Builder for full ORS projection)")
            }
        }

        this._tipEl.innerHTML = lines.join("<br>")
        this._tipEl.style.display = "block"
    }

    _hide() {
        if (this._tipEl) this._tipEl.style.display = "none"
    }

    _waveById(id) {
        if (!this.preset || !Array.isArray(this.preset.waves)) return null
        return this.preset.waves.find(w => w && w.id === id) || null
    }

    _legsInWave(sched, wave) {
        const out = []
        if (!sched || !Array.isArray(sched.legs)) return out
        const dep = wave.departureWindow || {}
        const start = _hhmmToMin(dep.start)
        const end   = _hhmmToMin(dep.end)
        if (start === null || end === null) return out
        for (const leg of sched.legs) {
            const m = _hhmmToMin(leg.depTimeLocal)
            if (m === null) continue
            const inWindow = (start <= end) ? (m >= start && m <= end) : (m >= start || m <= end)
            if (inWindow) out.push(leg)
        }
        return out
    }

    async _topDemandFor(hub) {
        if (!hub) return null
        try {
            const key = "routeAssistant:topRoutes:" + String(hub).toUpperCase()
            const data = await chrome.storage.local.get([key])
            const blob = data[key]
            const rows = (blob && Array.isArray(blob.rows)) ? blob.rows : []
            return rows.sort((a, b) => (b.paxScore || 0) - (a.paxScore || 0))[0] || null
        } catch (_) { return null }
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

function _strong(text) {
    return "<strong>" + _escape(text) + "</strong>"
}

function _escape(s) {
    return String(s).replace(/[&<>"']/g, c => (
        c === "&" ? "&amp;" :
        c === "<" ? "&lt;" :
        c === ">" ? "&gt;" :
        c === '"' ? "&quot;" : "&#39;"
    ))
}

if (typeof window !== "undefined") {
    window.CanvasOrsTooltip = CanvasOrsTooltip
}
