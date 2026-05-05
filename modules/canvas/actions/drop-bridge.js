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
 *   - Destination card → opens CanvasRouteCreateModal for route details,
 *     then fires onDrop with kind="addRoute" and the collected values.
 *   - Schedule cell → fires onDrop with kind="moveRoute" so existing canvas
 *     legs can be moved between aircraft/waves.
 */
class CanvasDropBridge {

    static DT_TYPE = "application/x-aes-dnd-dest"
    static DT_CELL_TYPE = "application/x-aes-canvas-cell"

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

    _hasType(dt, type) {
        if (!dt) return false
        const types = dt.types || []
        for (const t of types) if (t === type) return true
        return false
    }

    _hasOurPayload(dt) {
        return this._hasType(dt, CanvasDropBridge.DT_TYPE)
            || this._hasType(dt, CanvasDropBridge.DT_CELL_TYPE)
    }

    _readPayload(dt, type) {
        if (!dt || !type) return null
        try {
            const raw = dt.getData(type)
            return raw ? JSON.parse(raw) : null
        } catch (_) { return null }
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
        e.dataTransfer.dropEffect = this._hasType(e.dataTransfer, CanvasDropBridge.DT_CELL_TYPE) ? "move" : "copy"
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
        const cellPayload = this._readPayload(e.dataTransfer, CanvasDropBridge.DT_CELL_TYPE)
        if (cellPayload) {
            this._handleCellMoveDrop(cell, cellPayload)
            return
        }
        const payload = this._readPayload(e.dataTransfer, CanvasDropBridge.DT_TYPE)
        if (!payload || !payload.destIata) return
        const aircraftId = cell.dataset.canvasAircraftId
        const waveId     = cell.dataset.canvasWaveId
        const isEmpty    = cell.dataset.canvasEmptyCell === "1"
        const destIata   = String(payload.destIata).toUpperCase()
        const destName   = payload.destName || destIata

        const aircraftRow = this.fleet.find(r => String(r.aircraftId) === String(aircraftId))
        let modalResult = {}
        if (typeof window !== "undefined" && window.CanvasRouteCreateModal) {
            modalResult = await window.CanvasRouteCreateModal.open({
                hub:          this.activeHub || (aircraftRow && aircraftRow.hub) || "",
                destIata,
                destName,
                aircraftId,
                registration: aircraftRow && aircraftRow.registration || "",
                replaceExisting: !isEmpty
            })
            if (modalResult == null) return  // user cancelled
        }
        const create = this._normaliseCreateResult(modalResult)
        const finalDestIata = create.destIata || destIata
        const finalDestName = create.destName || destName || finalDestIata
        try {
            this.onDrop({
                kind:        "addRoute",
                aircraftId,
                waveId,
                destIata:    finalDestIata,
                destName:    finalDestName,
                replaceExisting: !isEmpty,
                fares:       create.fares,
                pricePct:    create.pricePct,
                service:     create.service,
                flightNumberText: create.flightNumberText,
                depTimeLocal:     create.depTimeLocal,
                depTime:          create.depTimeLocal,
                hub:         this.activeHub || (aircraftRow && aircraftRow.hub) || ""
            })
        } catch (err) { console.warn("[AES Canvas] addRoute drop handler threw", err) }
    }

    _normaliseCreateResult(result) {
        const r = result && typeof result === "object" ? result : {}
        const fares = (r.fares && typeof r.fares === "object") ? r.fares : r
        const destIataRaw = String(r.destIata || r.destination || "").trim().toUpperCase()
        const destIata = /^[A-Z]{3}$/.test(destIataRaw) ? destIataRaw : ""
        const pricePctN = Number(r.pricePct)
        const pricePct = Number.isFinite(pricePctN) && pricePctN > 0 ? Math.round(pricePctN) : 100
        const service = typeof r.service === "string" ? r.service.trim() : ""
        const flightNumberText = String(r.flightNumberText || "")
            .replace(/[^0-9]/g, "").slice(0, 4)
        const depTimeLocal = this._normaliseHHMM(r.depTimeLocal || "")
        return {
            destIata,
            destName: r.destName || destIata,
            fares,
            pricePct,
            service,
            flightNumberText,
            depTimeLocal
        }
    }

    _normaliseHHMM(value) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim())
        if (!m) return ""
        const h = Number(m[1])
        const min = Number(m[2])
        if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return ""
        return (h < 10 ? "0" + h : String(h)) + ":" + (min < 10 ? "0" + min : String(min))
    }

    _handleCellMoveDrop(cell, payload) {
        if (!cell || !payload) return
        const aircraftId = cell.dataset.canvasAircraftId
        const waveId = cell.dataset.canvasWaveId
        if (!aircraftId || !waveId) return
        const sourceAircraftId = payload.aircraftId != null ? String(payload.aircraftId) : ""
        const sourceWaveId = payload.waveId != null ? String(payload.waveId) : ""
        if (sourceAircraftId === String(aircraftId) && sourceWaveId === String(waveId)) return

        const aircraftRow = this.fleet.find(r => String(r.aircraftId) === String(aircraftId))
        const destIata = String(payload.destination || payload.destIata || "").toUpperCase()
        if (!destIata) return
        const fnText = this._flightNumberText(payload.flightNumber)
        try {
            this.onDrop({
                kind:             "moveRoute",
                aircraftId,
                waveId,
                destIata,
                destName:         payload.destName || destIata,
                hub:              this.activeHub || (aircraftRow && aircraftRow.hub) || "",
                sourceAircraftId,
                sourceWaveId,
                sourceLegSeq:     payload.sourceLegSeq != null ? payload.sourceLegSeq : null,
                flightId:         payload.flightId || null,
                flightNumber:     payload.flightNumber || null,
                flightNumberText: fnText,
                depTimeLocal:     payload.depTimeLocal || null
            })
        } catch (err) { console.warn("[AES Canvas] cell move drop handler threw", err) }
    }

    _flightNumberText(value) {
        const m = String(value || "").match(/(\d{1,4})\s*$/)
        return m ? m[1] : ""
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
