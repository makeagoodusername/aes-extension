"use strict"

/**
 * Fleet Schedule Grid — drag/drop bridge.
 *
 * Wires HTML5 drag-and-drop on the grid root via event delegation. Listens
 * for `dragover` and `drop` events whose `dataTransfer` carries a destination
 * payload (set by `dnd-source-panel.js`). Renders a translucent ghost block
 * during dragover so the user can see where the flight will land; on drop,
 * fires `onDrop({aircraftId, dayIdx, dropMin, destIata, destName,
 * sourceWaveLayerId?, conflictBlock?})` and lets the panel open the
 * confirmation popover.
 *
 * Key invariant: `dragover` MUST `preventDefault()` for the drop event to
 * fire at all (HTML5 spec). One handler at the grid root.
 *
 * Snap: drop time snaps to the nearest 15-min boundary by default.
 */
class FleetScheduleGridDndBridge {

    static DT_TYPE = "application/x-aes-dnd-dest"
    static SNAP_MIN = 15
    static GHOST_CLASS = "aes-fsg-dnd-ghost"

    constructor(opts) {
        const o = opts || {}
        this.gridEl = o.gridEl || null
        this.onDrop = typeof o.onDrop === "function" ? o.onDrop : (() => {})
        this.getScheduleForLane = typeof o.getScheduleForLane === "function" ? o.getScheduleForLane : (() => null)
        this._handlers = null
        this._currentLane = null
        this._currentGhost = null
    }

    attach() {
        if (!this.gridEl || this._handlers) return
        const onDragOver = (e) => this._onDragOver(e)
        const onDragLeave = (e) => this._onDragLeave(e)
        const onDrop = (e) => this._onDrop(e)
        this.gridEl.addEventListener("dragover", onDragOver)
        this.gridEl.addEventListener("dragleave", onDragLeave)
        this.gridEl.addEventListener("drop", onDrop)
        this._handlers = {onDragOver, onDragLeave, onDrop}
    }

    detach() {
        if (!this.gridEl || !this._handlers) return
        this.gridEl.removeEventListener("dragover", this._handlers.onDragOver)
        this.gridEl.removeEventListener("dragleave", this._handlers.onDragLeave)
        this.gridEl.removeEventListener("drop", this._handlers.onDrop)
        this._handlers = null
        this._removeGhost()
    }

    _hasOurPayload(dt) {
        if (!dt) return false
        const types = dt.types || []
        for (const t of types) {
            if (t === FleetScheduleGridDndBridge.DT_TYPE) return true
        }
        return false
    }

    _onDragOver(e) {
        if (!this._hasOurPayload(e.dataTransfer)) return
        const lane = e.target && e.target.closest ? e.target.closest("[data-aircraft-id][data-day-idx]") : null
        if (!lane) {
            this._removeGhost()
            return
        }
        // CRITICAL: must preventDefault for drop to fire.
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        const min = this._snap(FleetScheduleGridRenderer.pxToMinutes(lane, e.clientX))
        this._renderGhost(lane, min)
    }

    _onDragLeave(e) {
        // dragleave fires when the pointer leaves the grid root entirely; not on lane→lane.
        if (e.target === this.gridEl) this._removeGhost()
    }

    _onDrop(e) {
        if (!this._hasOurPayload(e.dataTransfer)) return
        const lane = e.target && e.target.closest ? e.target.closest("[data-aircraft-id][data-day-idx]") : null
        if (!lane) { this._removeGhost(); return }
        e.preventDefault()
        let payload = null
        try {
            const raw = e.dataTransfer.getData(FleetScheduleGridDndBridge.DT_TYPE)
            payload = raw ? JSON.parse(raw) : null
        } catch (_) {}
        const aircraftId = lane.dataset.aircraftId
        const dayIdx = +lane.dataset.dayIdx
        const dropMin = this._snap(FleetScheduleGridRenderer.pxToMinutes(lane, e.clientX))
        const ghost = this._currentGhost
        this._removeGhost()
        if (!payload || !payload.destIata) return
        // Detect conflict with an existing flight block at this time.
        const conflictBlock = this._findConflict(lane, dropMin)
        try {
            this.onDrop({
                aircraftId,
                dayIdx,
                dropMin,
                destIata:        payload.destIata,
                destName:        payload.destName || payload.destIata,
                sourceWaveLayerId: payload.sourceWaveLayerId || null,
                lane,
                anchorRect:       ghost ? ghost.getBoundingClientRect() : lane.getBoundingClientRect(),
                conflictBlock
            })
        } catch (err) { console.warn("[AES FSG] onDrop handler threw", err) }
    }

    _snap(min) {
        if (min == null || !isFinite(min)) return null
        const s = FleetScheduleGridDndBridge.SNAP_MIN
        return Math.max(0, Math.min(1440, Math.round(min / s) * s))
    }

    _renderGhost(lane, min) {
        if (lane !== this._currentLane) {
            this._removeGhost()
            this._currentLane = lane
        }
        if (!this._currentGhost) {
            const T = (typeof window !== "undefined" && window.AESTokens) || null
            const g = document.createElement("div")
            g.className = FleetScheduleGridDndBridge.GHOST_CLASS
            g.style.cssText = "position:absolute;top:1px;bottom:1px;"
                + "background:" + (T ? T.color.cobalt : "#3656A8") + ";"
                + "border:1.5px solid " + (T ? T.color.oxide : "#2B2520") + ";"
                + "opacity:0.55;pointer-events:none;z-index:6;"
                + "display:flex;align-items:center;justify-content:center;"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
                + "font-size:10px;color:" + (T ? T.color.boneFg : "#F4F1EA") + ";font-weight:700;"
            lane.appendChild(g)
            this._currentGhost = g
        }
        const widthMin = 75   // visual hint of a "typical" leg footprint
        const left = (Math.max(0, min) / 1440) * 100
        const width = (widthMin / 1440) * 100
        this._currentGhost.style.left = left + "%"
        this._currentGhost.style.width = width + "%"
        const hh = Math.floor(min / 60), mm = min % 60
        const lbl = (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm)
        this._currentGhost.textContent = lbl

        // Soft conflict tint if the ghost overlaps a real flight block.
        const conflict = this._findConflict(lane, min)
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        if (conflict) {
            this._currentGhost.style.background = (T ? T.color.amber : "#B8861F")
            this._currentGhost.title = "Will overlap " + (conflict.flight && conflict.flight.flightCode || "(flight)") + " — drop to confirm replacement"
        } else {
            this._currentGhost.style.background = (T ? T.color.cobalt : "#3656A8")
            this._currentGhost.title = ""
        }
    }

    _removeGhost() {
        if (this._currentGhost && this._currentGhost.parentElement) {
            this._currentGhost.parentElement.removeChild(this._currentGhost)
        }
        this._currentGhost = null
        this._currentLane = null
    }

    _findConflict(lane, min) {
        const sched = this.getScheduleForLane(lane)
        if (!sched) return null
        const dayIdx = +lane.dataset.dayIdx
        const day = sched.days && sched.days[dayIdx]
        if (!day) return null
        for (const b of (day.blocks || [])) {
            if (b.kind !== "flight") continue
            if (b.startMin == null || b.endMin == null) continue
            if (min >= b.startMin && min <= b.endMin) return b
        }
        return null
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridDndBridge = FleetScheduleGridDndBridge
}
