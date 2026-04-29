"use strict"

/**
 * CanvasDropBridge — HTML5 drag/drop on the wave-spine cells.
 *
 * Sibling to FleetScheduleGridDndBridge (which targets the legacy time-axis
 * grid). Listens on the spine root for drops carrying the same payload type
 * (`application/x-aes-dnd-dest`) the source panel emits, then resolves the
 * drop to a wave cell `{aircraftId, waveId, isEmpty, destIata, destName}`.
 *
 * On a drop:
 *   - Empty cell → opens CanvasRouteCreateModal for fares, then fires
 *     onDrop with kind="addRoute" and the collected fares.
 *   - Filled cell → fires onDrop with kind="moveRoute" — caller can decide
 *     whether to confirm. Phase 7 just stages the intent.
 */
class CanvasDropBridge {

    static DT_TYPE = "application/x-aes-dnd-dest"

    constructor(deps) {
        const d = deps || {}
        this.spineHostEl = d.spineHostEl || null
        this.activeHub   = d.activeHub || null
        this.fleet       = Array.isArray(d.fleet) ? d.fleet : []
        this.onDrop      = typeof d.onDrop === "function" ? d.onDrop : (() => {})
        this._handlers = null
        this._currentCell = null
    }

    attach() {
        if (!this.spineHostEl || this._handlers) return
        const onDragOver = (e) => this._onDragOver(e)
        const onDragLeave = (e) => this._onDragLeave(e)
        const onDrop = (e) => this._onDrop(e)
        this.spineHostEl.addEventListener("dragover", onDragOver)
        this.spineHostEl.addEventListener("dragleave", onDragLeave)
        this.spineHostEl.addEventListener("drop", onDrop)
        this._handlers = {onDragOver, onDragLeave, onDrop}
    }

    detach() {
        if (!this.spineHostEl || !this._handlers) return
        this.spineHostEl.removeEventListener("dragover", this._handlers.onDragOver)
        this.spineHostEl.removeEventListener("dragleave", this._handlers.onDragLeave)
        this.spineHostEl.removeEventListener("drop", this._handlers.onDrop)
        this._handlers = null
        this._clearHover()
    }

    update(deps) {
        if (!deps) return
        if (deps.activeHub !== undefined) this.activeHub = deps.activeHub
        if (deps.fleet     !== undefined) this.fleet = Array.isArray(deps.fleet) ? deps.fleet : []
    }

    _hasOurPayload(dt) {
        if (!dt) return false
        const types = dt.types || []
        for (const t of types) if (t === CanvasDropBridge.DT_TYPE) return true
        return false
    }

    _findCell(target) {
        if (!target || !target.closest) return null
        return target.closest("[data-canvas-aircraft-id][data-canvas-wave-id]")
    }

    _onDragOver(e) {
        if (!this._hasOurPayload(e.dataTransfer)) return
        const cell = this._findCell(e.target)
        if (!cell) { this._clearHover(); return }
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        this._setHover(cell)
    }

    _onDragLeave(e) {
        if (e.target === this.spineHostEl) this._clearHover()
    }

    async _onDrop(e) {
        if (!this._hasOurPayload(e.dataTransfer)) return
        const cell = this._findCell(e.target)
        this._clearHover()
        if (!cell) return
        e.preventDefault()
        let payload = null
        try {
            const raw = e.dataTransfer.getData(CanvasDropBridge.DT_TYPE)
            payload = raw ? JSON.parse(raw) : null
        } catch (_) {}
        if (!payload || !payload.destIata) return
        const aircraftId = cell.dataset.canvasAircraftId
        const waveId     = cell.dataset.canvasWaveId
        const isEmpty    = cell.dataset.canvasEmptyCell === "1"
        const destIata   = String(payload.destIata).toUpperCase()
        const destName   = payload.destName || destIata

        if (isEmpty) {
            const aircraftRow = this.fleet.find(r => String(r.aircraftId) === String(aircraftId))
            let fares = {}
            if (typeof window !== "undefined" && window.CanvasRouteCreateModal) {
                fares = await window.CanvasRouteCreateModal.open({
                    hub:          this.activeHub || (aircraftRow && aircraftRow.hub) || "",
                    destIata,
                    destName,
                    aircraftId,
                    registration: aircraftRow && aircraftRow.registration || ""
                })
                if (fares == null) return  // user cancelled
            }
            try {
                this.onDrop({
                    kind:        "addRoute",
                    aircraftId,
                    waveId,
                    destIata,
                    destName,
                    fares,
                    hub:         this.activeHub || (aircraftRow && aircraftRow.hub) || ""
                })
            } catch (err) { console.warn("[AES Canvas] addRoute drop handler threw", err) }
        } else {
            try {
                this.onDrop({
                    kind:        "moveRoute",
                    aircraftId,
                    waveId,
                    destIata,
                    destName,
                    hub:         this.activeHub || ""
                })
            } catch (err) { console.warn("[AES Canvas] moveRoute drop handler threw", err) }
        }
    }

    _setHover(cell) {
        if (cell === this._currentCell) return
        this._clearHover()
        this._currentCell = cell
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        cell.dataset.canvasDropHover = "1"
        cell.style.outline = "2px dashed " + (T ? T.color.cobalt : "#3656A8")
        cell.style.outlineOffset = "-2px"
    }

    _clearHover() {
        if (!this._currentCell) return
        delete this._currentCell.dataset.canvasDropHover
        this._currentCell.style.outline = ""
        this._currentCell.style.outlineOffset = ""
        this._currentCell = null
    }
}

if (typeof window !== "undefined") {
    window.CanvasDropBridge = CanvasDropBridge
}
