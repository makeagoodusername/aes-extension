"use strict"

/**
 * CanvasDemandOverlay — paints small demand badges on empty wave cells.
 *
 * For each `[data-canvas-empty-cell="1"]` element under the spine host,
 * the overlay reads the active hub's cached top-routes
 * (`routeAssistant:topRoutes:<HUB>`) and shows the highest-paxScore
 * destination not already served by any aircraft in the same wave window.
 *
 * Click on a badge → seeds an Advisor suggestion via
 * `canvas:advisor-suggestion` so the user can adopt with one click. We
 * route through the bus rather than direct-staging because Phase E owns
 * the suggestion lifecycle (debouncing, dismissal history).
 *
 * Pure decorator: doesn't change the cell's empty state. The Builder
 * engine remains responsible for "fill all empty cells" runs; this
 * overlay is the "look here" hint at idle.
 */
class CanvasDemandOverlay {

    constructor(deps) {
        const d = deps || {}
        this.spineHostEl = d.spineHostEl || null
        this.activeHub   = d.activeHub || null
        this.fleet       = Array.isArray(d.fleet) ? d.fleet : []
        this.schedules   = d.schedules instanceof Map ? d.schedules : new Map()
        this.preset      = d.preset || null

        this._cellsDecorated = new WeakSet()
    }

    /** Read demand cache and paint badges. Idempotent — re-running paints
     *  any newly-added empty cells without flickering existing ones. */
    async paint() {
        if (!this.spineHostEl || !this.activeHub) return
        const demandRows = await this._loadDemandRows(this.activeHub)
        if (!demandRows || !demandRows.length) return
        // Build a per-wave used-destinations map so we don't recommend a
        // destination already covered in that wave window.
        const waves = (this.preset && Array.isArray(this.preset.waves)) ? this.preset.waves : []
        const usedByWave = new Map()
        for (const w of waves) usedByWave.set(w.id, new Set())
        for (const r of this.fleet) {
            const sched = this.schedules.get(String(r.aircraftId))
            if (!sched || !Array.isArray(sched.legs)) continue
            for (const leg of sched.legs) {
                if (!leg || !leg.destination) continue
                for (const w of waves) {
                    const dep = w.departureWindow || {}
                    const start = _hhmmToMin(dep.start)
                    const end = _hhmmToMin(dep.end)
                    const m = _hhmmToMin(leg.depTimeLocal)
                    if (start === null || end === null || m === null) continue
                    const inWindow = (start <= end) ? (m >= start && m <= end) : (m >= start || m <= end)
                    if (inWindow) usedByWave.get(w.id).add(leg.destination)
                }
            }
        }

        const empties = this.spineHostEl.querySelectorAll('[data-canvas-empty-cell="1"]')
        for (const cell of empties) {
            if (this._cellsDecorated.has(cell)) continue
            const waveId = cell.dataset.canvasWaveId
            if (!waveId) continue
            const used = usedByWave.get(waveId) || new Set()
            const aircraftId = cell.dataset.canvasAircraftId
            const aircraftRow = this.fleet.find(r => String(r.aircraftId) === String(aircraftId))
            const pick = this._pickDestination(demandRows, used, aircraftRow)
            if (!pick) continue
            this._decorate(cell, pick, aircraftId, waveId)
            this._cellsDecorated.add(cell)
        }
    }

    async _loadDemandRows(hub) {
        try {
            const key = "routeAssistant:topRoutes:" + String(hub).toUpperCase()
            const data = await chrome.storage.local.get([key])
            const blob = data[key]
            const rows = (blob && Array.isArray(blob.rows)) ? blob.rows : []
            return rows.map(r => this._normaliseDemandRow(r)).filter(Boolean)
        } catch (_) { return [] }
    }

    _normaliseDemandRow(row) {
        if (!row || typeof row !== "object") return null
        const dest = String(row.destIata || row.dest || row.iata || row.destination || "").trim().toUpperCase()
        if (!/^[A-Z]{3}$/.test(dest)) return null
        return Object.assign({}, row, {
            destIata:      dest,
            destName:      row.destName || row.name || row.airportName || "",
            distanceKm:    _num(row.distanceKm != null ? row.distanceKm : row.distance),
            paxScore:      _num(row.paxScore),
            cargoScore:    _num(row.cargoScore),
            profitPerWeek: _num(row.profitPerWeek)
        })
    }

    _pickDestination(rows, usedSet, aircraftRow) {
        const sorted = rows.slice().sort((a, b) => (b.paxScore || 0) - (a.paxScore || 0))
        for (const r of sorted) {
            if (!r || !r.destIata) continue
            if (usedSet.has(r.destIata)) continue
            if (aircraftRow && r.distanceKm) {
                const range = Number(aircraftRow.range)
                if (isFinite(range) && range > 0 && r.distanceKm > range * 1.05) continue
            }
            return r
        }
        return null
    }

    _decorate(cell, demand, aircraftId, waveId) {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const badge = document.createElement("div")
        badge.style.cssText = [
            "margin-top:4px",
            "padding:1px 4px",
            "font-family:" + (T ? T.font.mono : "monospace"),
            "font-size:9px",
            "background:" + (T ? T.color.bone3 : "#E0DAC8"),
            "border:1px dashed " + (T ? T.color.cobalt : "#3656A8"),
            "color:" + (T ? T.color.cobalt : "#3656A8"),
            "cursor:pointer",
            "letter-spacing:0.04em",
            "display:inline-flex",
            "gap:4px",
            "align-items:center"
        ].join(";")
        badge.title = "Demand · " + (demand.destName || demand.destIata) + " · paxScore " + (demand.paxScore || 0)
        badge.textContent = "+ " + demand.destIata + " · " + (demand.paxScore || 0)
        badge.addEventListener("click", (e) => {
            e.stopPropagation()
            this._seedSuggestion(demand, aircraftId, waveId)
        })
        cell.appendChild(badge)
    }

    _seedSuggestion(demand, aircraftId, waveId) {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        window.CentralHubBus.emit(window.AesCanvasEvents.ADVISOR_SUGGESTION, {
            id:         "s-demand-" + Date.now().toString(36),
            kind:       "demand-add",
            severity:   "info",
            signature:  aircraftId + ":" + (demand.destIata || ""),
            message:    "Add " + demand.destIata + " to aircraft " + aircraftId + "? paxScore " + (demand.paxScore || 0)
                + (demand.profitPerWeek ? ", projected AS$" + Math.round(demand.profitPerWeek) + "/wk" : ""),
            action:     {
                label: "Stage edit",
                run:   () => {
                    if (typeof window === "undefined" || !window.CentralHubBus) return
                    window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_STAGED, {
                        kind: "addRoute",
                        payload: {
                            kind:        "addRoute",
                            aircraftId:  aircraftId,
                            waveId:      waveId,
                            destIata:    demand.destIata,
                            destName:    demand.destName || "",
                            paxScore:    demand.paxScore || 0,
                            profitPerWeek: demand.profitPerWeek || null,
                            dayMask:     [true, true, true, true, true, true, true]
                        }
                    })
                }
            }
        })
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

function _num(value) {
    const n = Number(value)
    return isFinite(n) ? n : null
}

if (typeof window !== "undefined") {
    window.CanvasDemandOverlay = CanvasDemandOverlay
}
