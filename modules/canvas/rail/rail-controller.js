"use strict"

/**
 * CanvasRailController — orchestrates the assistant rail.
 *
 * Owns the cross-cutting interaction:
 *   - Mount rail-shell into the canvas's rail slot.
 *   - When Builder is active and a hub-changed/proposal-rerun is requested,
 *     ask the builder engine to stream proposals; render each as a card.
 *   - When Advisor is active (Phase E), subscribe to canvas:edit-staged
 *     and forward to the advisor engine; render its suggestions.
 *   - Track staged edits in memory; reflect count in rail footer.
 *   - Commit/discard buttons emit canvas:edit-committed / EDIT_DISCARDED.
 *
 * The controller does NOT load data itself — the canvas-modal supplies a
 * `getInputs()` callback returning {hub, fleet, schedules, preset}. This
 * keeps the controller pure and re-mountable on other surfaces.
 */
class CanvasRailController {

    constructor(deps) {
        const d = deps || {}
        this.getInputs = typeof d.getInputs === "function" ? d.getInputs : (() => ({}))
        this.onRailClose = typeof d.onRailClose === "function" ? d.onRailClose : null
        this.ensurePresetForHub = typeof d.ensurePresetForHub === "function" ? d.ensurePresetForHub : null
        this.server      = d.server || ""
        this.airlineCode = d.airlineCode || ""
        this.builderEngine = (d.builderEngine !== undefined) ? d.builderEngine
            : (typeof window !== "undefined" && window.CanvasBuilderEngine
                ? new window.CanvasBuilderEngine() : null)
        this.advisorEngine = (d.advisorEngine !== undefined) ? d.advisorEngine
            : (typeof window !== "undefined" && window.CanvasAdvisorEngine
                ? new window.CanvasAdvisorEngine({getInputs: this.getInputs}) : null)
        this.commitBar = (typeof window !== "undefined" && window.CanvasCommitBar)
            ? new window.CanvasCommitBar({
                server:      this.server,
                airlineCode: this.airlineCode,
                getInputs:   this.getInputs,
                getStaged:   () => this._stagedEdits.slice(),
                clearStaged: () => { this._stagedEdits = [] }
            })
            : null

        this._stagedEdits = []
        this._railShell = null
        this._busOff = []
        this._activeBuilderRunId = 0
        this._builderProposalCount = 0
        this._routePlanRows = []
        this._lastRoutePlanMessage = ""
        // Phase K — last-N advisor suggestions (live + resolved), newest first.
        this._advisorHistory = []
        this._advisorTab = "live"
    }

    static HISTORY_MAX = 5

    /** Public: stage one or more edits from outside the rail (drop bridge,
     *  context menu, demand badges). Same envelope shape as Builder stage. */
    stageEdits(edits, info) {
        if (!Array.isArray(edits)) edits = [edits]
        this._stageEdits(edits.filter(Boolean), info || {})
    }

    mount(railSlotEl) {
        if (!railSlotEl) return
        const inputs = this._safeInputs()
        const initialMode = this._initialModeFromState()
        this._railShell = new window.CanvasRailShell({
            activeHub:    inputs && inputs.hub,
            mode:         initialMode,
            onModeChange: (mode) => this._onModeChange(mode),
            onClose:      () => { if (this.onRailClose) this.onRailClose() },
            onCommit:     () => this._onCommit(),
            onDiscard:    () => this._onDiscard()
        })
        this._railShell.mount(railSlotEl)
        this._railShell.setStagedCount(0)
        this._renderModeBody(initialMode)

        if (this.advisorEngine && typeof this.advisorEngine.start === "function") {
            try { this.advisorEngine.start() } catch (_) {}
        }
        this._wireBus()
    }

    dispose() {
        for (const off of this._busOff) { try { off() } catch (_) {} }
        this._busOff = []
        if (this.advisorEngine && typeof this.advisorEngine.stop === "function") {
            try { this.advisorEngine.stop() } catch (_) {}
        }
        this._railShell = null
    }

    /** Re-run the builder for the current hub. Cancels in-flight work. */
    async rerunBuilder() {
        const mode = this._currentMode()
        if (mode !== window.CanvasRailShell.MODE_BUILDER) return
        await this._runBuilder()
    }

    _initialModeFromState() {
        try {
            // Read the canvas state synchronously via a sticky in-memory copy
            // when one exists (canvas-state-store.load is async; this read
            // happens during rail mount before the state has resolved).
            // Fall back to "builder" as the default first-mount mode.
            const last = (typeof window !== "undefined" && window.__aesCanvasLastState) || null
            if (last && (last.railMode === "advisor" || last.railMode === "builder")) {
                return last.railMode
            }
        } catch (_) {}
        return window.CanvasRailShell.MODE_BUILDER
    }

    _currentMode() {
        return this._railShell ? this._railShell.mode : window.CanvasRailShell.MODE_BUILDER
    }

    async _onModeChange(mode) {
        if (typeof window !== "undefined" && window.AesCanvasStateStore) {
            try { await window.AesCanvasStateStore.save({railMode: mode}) }
            catch (_) {}
        }
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.RAIL_MODE_CHANGED, {mode})
        }
        this._renderModeBody(mode)
    }

    _renderModeBody(mode) {
        if (!this._railShell) return
        if (mode === window.CanvasRailShell.MODE_ADVISOR) {
            this._renderAdvisorBody()
        } else {
            this._renderBuilderBody()
        }
    }

    _renderBuilderBody() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;"

        const lead = document.createElement("div")
        lead.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";line-height:1.4;"
        lead.textContent = "Builder fills empty wave cells using cached demand. Stage a plan, then Apply to create the routes in AirlineSim and refresh the schedule."
        wrap.append(lead)

        const inputs = this._safeInputs()
        if (!inputs || !inputs.hub) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;padding:24px 0;text-align:center;"
            empty.textContent = "Pick a hub to run the builder."
            wrap.append(empty)
            this._railShell.setBody(wrap)
            return
        }

        if (!inputs.preset) {
            const empty = document.createElement("div")
            empty.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:18px 0;text-align:center;"
            const msg = document.createElement("div")
            msg.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;"
            msg.textContent = "No wave plan for " + inputs.hub + "."
            empty.append(msg)
            if (this.ensurePresetForHub) {
                const btn = document.createElement("button")
                btn.type = "button"
                btn.textContent = "Create starter waves"
                btn.style.cssText = this._buttonStyle(T, "primary") + ";align-self:center;"
                btn.addEventListener("click", async () => {
                    btn.disabled = true
                    btn.textContent = "Creating…"
                    await this.ensurePresetForHub(inputs.hub)
                    this._renderBuilderBody()
                })
                empty.append(btn)
            }
            wrap.append(empty)
            this._railShell.setBody(wrap)
            return
        }

        const planner = this._buildRoutePlanBuilder(inputs, T)
        if (planner) wrap.append(planner)

        const status = document.createElement("div")
        status.style.cssText = "font-size:10px;font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";"
        status.textContent = "Streaming proposals…"
        wrap.append(status)
        this._builderStatusEl = status
        this._builderProposalsHost = wrap
        this._railShell.setBody(wrap)

        // Kick off
        this._runBuilder().catch(e => console.warn("[AES Canvas] builder run failed", e))
    }

    _buildQuickRouteForm(inputs, T) {
        const hub = String(inputs && inputs.hub || "").toUpperCase()
        const preset = inputs && inputs.preset
        const waves = ((preset && preset.waves) || []).filter(w => w && !w.archivedAt)
        const fleet = this._fleetRowsForRoutePlan(inputs, hub)
        if (!hub || !waves.length || !fleet.length) return null
        if (this._routePlanRows.some(r => r && r.hub && r.hub !== hub)) this._routePlanRows = []

        const wrap = document.createElement("div")
        wrap.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "gap:6px",
            "padding:8px",
            "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "background:" + (T ? T.color.bone : "#F4F1EA")
        ].join(";")

        const title = document.createElement("div")
        title.style.cssText = "font-size:10px;font-weight:" + (T ? T.fw.bold : "700") + ";text-transform:uppercase;letter-spacing:0.06em;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        title.textContent = "Quick route"
        wrap.append(title)

        const aircraftSel = document.createElement("select")
        aircraftSel.style.cssText = this._inputStyle(T)
        for (const r of fleet) {
            const o = document.createElement("option")
            o.value = String(r.aircraftId)
            o.textContent = (r.registration || r.aircraftId) + (r.equipment ? " · " + r.equipment : "")
            aircraftSel.append(o)
        }

        const waveSel = document.createElement("select")
        waveSel.style.cssText = this._inputStyle(T)
        for (const w of waves) {
            const o = document.createElement("option")
            o.value = String(w.id)
            const dep = w.departureWindow && w.departureWindow.start ? " · " + w.departureWindow.start : ""
            o.textContent = (w.label || w.name || w.id) + dep
            waveSel.append(o)
        }

        const destInput = document.createElement("input")
        destInput.type = "text"
        destInput.maxLength = 3
        destInput.placeholder = "DEST"
        destInput.setAttribute("aria-label", "Destination IATA")
        destInput.style.cssText = this._inputStyle(T) + ";text-transform:uppercase;"

        const timeInput = document.createElement("input")
        timeInput.type = "time"
        timeInput.step = "300"
        timeInput.value = this._waveDeparture(waves[0]) || "09:00"
        timeInput.style.cssText = this._inputStyle(T)

        const fnInput = document.createElement("input")
        fnInput.type = "text"
        fnInput.inputMode = "numeric"
        fnInput.maxLength = 4
        fnInput.placeholder = "FLIGHT #"
        fnInput.setAttribute("aria-label", "Flight number")
        fnInput.style.cssText = this._inputStyle(T)

        waveSel.addEventListener("change", () => {
            const wave = waves.find(w => String(w.id) === String(waveSel.value))
            timeInput.value = this._waveDeparture(wave) || timeInput.value || "09:00"
        })

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:5px;"
        grid.append(aircraftSel, waveSel, destInput, timeInput, fnInput)

        const stage = document.createElement("button")
        stage.type = "button"
        stage.textContent = "Stage route"
        stage.style.cssText = this._buttonStyle(T, "primary") + ";grid-column:1 / -1;"
        grid.append(stage)
        wrap.append(grid)

        const status = document.createElement("div")
        status.style.cssText = "min-height:14px;font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        wrap.append(status)

        const submit = () => {
            const dest = String(destInput.value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3)
            destInput.value = dest
            if (!/^[A-Z]{3}$/.test(dest)) {
                status.textContent = "Enter a three-letter destination."
                return
            }
            if (dest === hub) {
                status.textContent = "Destination must differ from " + hub + "."
                return
            }
            const wave = waves.find(w => String(w.id) === String(waveSel.value)) || waves[0]
            this._stageEdits([{
                kind:       "addRoute",
                aircraftId: aircraftSel.value,
                waveId:     wave && wave.id,
                presetId:   preset && preset.id,
                hub:        hub,
                destIata:   dest,
                depTime:    timeInput.value || this._waveDeparture(wave) || "09:00",
                flightNumberText: String(fnInput.value || "").replace(/[^0-9]/g, "").slice(0, 4),
                dayMask:    [true, true, true, true, true, true, true],
                source:     "quick-builder"
            }], {source: "quick-builder", fragment: true})
            status.textContent = "Staged " + hub + " -> " + dest + "."
            destInput.value = ""
        }
        stage.addEventListener("click", submit)
        destInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault()
                submit()
            }
        })

        return wrap
    }

    _buildRoutePlanBuilder(inputs, T) {
        const hub = String(inputs && inputs.hub || "").toUpperCase()
        const preset = inputs && inputs.preset
        const waves = ((preset && preset.waves) || []).filter(w => w && !w.archivedAt)
        const schedules = inputs && inputs.schedules instanceof Map ? inputs.schedules : new Map()
        const fleet = this._fleetRowsForRoutePlan(inputs, hub)
        if (!hub || !waves.length || !fleet.length) return null
        if (this._routePlanRows.some(r => r && r.hub && r.hub !== hub)) this._routePlanRows = []

        const wrap = document.createElement("div")
        wrap.className = "aes-route-plan-builder"
        wrap.style.cssText = [
            "display:flex",
            "flex-direction:column",
            "gap:7px",
            "padding:8px",
            "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "background:" + (T ? T.color.bone : "#F4F1EA")
        ].join(";")

        const title = document.createElement("div")
        title.style.cssText = "font-size:10px;font-weight:" + (T ? T.fw.bold : "700") + ";text-transform:uppercase;letter-spacing:0.06em;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        title.textContent = "Route plan builder"
        wrap.append(title)

        const destInput = document.createElement("textarea")
        destInput.rows = 2
        destInput.placeholder = "LHR JFK CDG"
        destInput.setAttribute("aria-label", "Destination airports")
        destInput.style.cssText = this._inputStyle(T) + ";resize:vertical;line-height:1.35;text-transform:uppercase;"

        const countInput = document.createElement("input")
        countInput.type = "number"
        countInput.min = "1"
        countInput.max = "28"
        countInput.step = "1"
        countInput.value = "3"
        countInput.setAttribute("aria-label", "Flights to create")
        countInput.style.cssText = this._inputStyle(T)

        const modeSel = document.createElement("select")
        modeSel.setAttribute("aria-label", "Schedule structure")
        modeSel.style.cssText = this._inputStyle(T)
        for (const opt of [
            ["balanced", "Balanced waves"],
            ["sequential", "Sequential mix"],
            ["long-haul", "Long-haul sequence"]
        ]) {
            const o = document.createElement("option")
            o.value = opt[0]
            o.textContent = opt[1]
            modeSel.append(o)
        }

        const row = document.createElement("div")
        row.style.cssText = "display:grid;grid-template-columns:1fr 76px;gap:5px;"
        row.append(destInput, countInput)
        wrap.append(row)
        wrap.append(modeSel)

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;"
        const generateBtn = document.createElement("button")
        generateBtn.type = "button"
        generateBtn.textContent = "Generate"
        generateBtn.style.cssText = this._buttonStyle(T, "primary")
        const stageBtn = document.createElement("button")
        stageBtn.type = "button"
        stageBtn.textContent = "Stage mock"
        stageBtn.disabled = true
        stageBtn.style.cssText = this._buttonStyle(T, "ghost")
        const applyBtn = document.createElement("button")
        applyBtn.type = "button"
        applyBtn.textContent = "Apply now"
        applyBtn.disabled = true
        applyBtn.style.cssText = this._buttonStyle(T, "primary")
        actions.append(generateBtn, stageBtn, applyBtn)
        wrap.append(actions)

        const status = document.createElement("div")
        status.style.cssText = "min-height:14px;font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        wrap.append(status)

        const preview = document.createElement("div")
        preview.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto;"
        wrap.append(preview)

        const renderPreview = () => {
            this._renderRoutePlanPreview(preview, {
                rows: this._routePlanRows,
                fleet,
                waves,
                preset,
                hub,
                T
            })
            const hasRows = this._routePlanRows.length > 0
            stageBtn.disabled = !hasRows
            applyBtn.disabled = !hasRows
        }

        generateBtn.addEventListener("click", async () => {
            generateBtn.disabled = true
            status.textContent = "Generating…"
            try {
                const dests = this._parseAirportList(destInput.value).filter(d => d !== hub)
                const count = Math.max(1, Math.min(28, parseInt(countInput.value, 10) || 1))
                if (!dests.length) {
                    status.textContent = "Add at least one destination airport outside " + hub + "."
                    this._routePlanRows = []
                    renderPreview()
                    return
                }
                const demandRows = await this._loadTopRoutes(hub)
                this._routePlanRows = this._generateRoutePlanRows({
                    hub,
                    dests,
                    count,
                    mode: modeSel.value,
                    fleet,
                    schedules,
                    waves,
                    preset,
                    demandRows
                })
                status.textContent = this._lastRoutePlanMessage
                    || (this._routePlanRows.length + " flight" + (this._routePlanRows.length === 1 ? "" : "s") + " generated.")
                renderPreview()
            } finally {
                generateBtn.disabled = false
            }
        })

        stageBtn.addEventListener("click", () => {
            const edits = this._routePlanEditsFromRows()
            if (!edits.length) {
                status.textContent = "No valid rows to stage."
                return
            }
            this._stageEdits(edits, {source: "route-plan-builder", fragment: true})
            status.textContent = "Staged " + edits.length + " flight" + (edits.length === 1 ? "" : "s") + "."
        })

        applyBtn.addEventListener("click", async () => {
            const edits = this._routePlanEditsFromRows()
            if (!edits.length) {
                status.textContent = "No valid rows to apply."
                return
            }
            applyBtn.disabled = true
            status.textContent = "Applying…"
            this._stageEdits(edits, {source: "route-plan-builder", fragment: true})
            await this._onCommit()
            status.textContent = "Apply run handed to AirlineSim."
            applyBtn.disabled = false
        })

        renderPreview()
        return wrap
    }

    _parseAirportList(value) {
        const seen = new Set()
        const out = []
        const matches = String(value || "").toUpperCase().match(/[A-Z]{3}/g) || []
        for (const m of matches) {
            if (seen.has(m)) continue
            seen.add(m)
            out.push(m)
        }
        return out
    }

    _generateRoutePlanRows(args) {
        const a = args || {}
        const hub = String(a.hub || "").toUpperCase()
        const dests = Array.isArray(a.dests) ? a.dests : []
        const fleet = Array.isArray(a.fleet) ? a.fleet : []
        const schedules = a.schedules instanceof Map ? a.schedules : new Map()
        const waves = Array.isArray(a.waves) ? a.waves : []
        const rows = []
        this._lastRoutePlanMessage = ""
        if (!hub || !dests.length || !fleet.length || !waves.length) return rows
        const demand = this._demandByDestination(a.demandRows)
        const count = Math.max(1, Math.min(28, Number(a.count) || 1))
        const mode = a.mode || "balanced"
        const used = new Map()
        const skipped = []
        let planned = 0
        let attempts = 0
        while (rows.length < count && attempts < count * Math.max(3, dests.length)) {
            const i = attempts++
            const dest = dests[i % dests.length]
            const wave = waves[i % waves.length]
            const rec = demand.get(dest) || null
            const distanceKm = Number(rec && rec.distanceKm)
            const longRoute = mode === "long-haul"
                || (Number.isFinite(distanceKm) && distanceKm >= 4500)
            const sequential = mode === "sequential" || mode === "long-haul" || longRoute
            const fit = this._pickRoutePlanSlot({
                fleet,
                schedules,
                hub,
                dest,
                distanceKm,
                mode,
                idx: i,
                used
            })
            if (!fit) {
                if (!skipped.includes(dest)) skipped.push(dest)
                continue
            }
            const aircraft = fit.aircraft
            const group = "rp-" + Date.now().toString(36) + "-" + planned
            const outDay = fit.outDay
            const backDay = fit.backDay
            rows.push({
                aircraftId: String(aircraft.aircraftId || ""),
                waveId:     wave && wave.id,
                presetId:   a.preset && a.preset.id,
                hub,
                originIata: hub,
                destIata:   dest,
                depTime:    fit.outDepTime,
                dayMask:    this._singleDayMask(outDay),
                distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
                mode,
                sequence:   sequential ? "sequential" : "paired",
                sequenceGroup: group,
                sequenceOrder: 0,
                legRole:    "out",
                fit:        "verified"
            })
            rows.push({
                aircraftId: String(aircraft.aircraftId || ""),
                waveId:     wave && wave.id,
                presetId:   a.preset && a.preset.id,
                hub,
                originIata: dest,
                destIata:   hub,
                depTime:    fit.backDepTime,
                dayMask:    this._singleDayMask(backDay),
                distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
                mode,
                sequence:   "return",
                sequenceGroup: group,
                sequenceOrder: 1,
                legRole:    "return",
                fit:        "verified"
            })
            planned++
        }
        if (!rows.length) {
            this._lastRoutePlanMessage = "No schedulable hub window found; open/fetch schedules or lower the route length."
        } else if (rows.length > count) {
            this._lastRoutePlanMessage = rows.length + " paired legs generated; rounded up to keep aircraft returning to " + hub + "."
        } else if (skipped.length) {
            this._lastRoutePlanMessage = rows.length + " paired legs generated; skipped " + skipped.join(", ") + " without a clear window."
        } else {
            this._lastRoutePlanMessage = rows.length + " paired legs generated."
        }
        return rows
    }

    _fleetRowsForRoutePlan(inputs, hub) {
        const rows = (inputs && Array.isArray(inputs.fleet)) ? inputs.fleet : []
        const schedules = inputs && inputs.schedules instanceof Map ? inputs.schedules : new Map()
        const withHubWindows = rows.filter(r => {
            const id = String(r && r.aircraftId || "")
            return this._scheduleHasHubWindow(schedules.get(id), hub)
        })
        if (withHubWindows.length) return withHubWindows
        return rows.filter(r => this._rowHub(r) === hub)
    }

    _scheduleHasHubWindow(schedule, hub) {
        return this._routePlanWindowsForSchedule(schedule, hub, 15).length > 0
    }

    _pickRoutePlanSlot(args) {
        const a = args || {}
        const hub = String(a.hub || "").toUpperCase()
        const oneWayMin = this._estimateOneWayMin(a.distanceKm, a.mode)
        const remoteTurn = this._remoteTurnMin(a.mode, a.distanceKm)
        const hubTurn = 20
        const requiredMin = oneWayMin * 2 + remoteTurn + hubTurn
        const candidates = []
        for (const aircraft of a.fleet || []) {
            const aircraftId = String(aircraft && aircraft.aircraftId || "")
            const schedule = a.schedules instanceof Map ? a.schedules.get(aircraftId) : null
            const windows = this._routePlanWindowsForSchedule(schedule, hub, requiredMin)
            for (const win of windows) candidates.push({aircraft, win})
        }
        candidates.sort((x, y) => (x.win.startAbs - y.win.startAbs)
            || String(x.aircraft.aircraftId || "").localeCompare(String(y.aircraft.aircraftId || "")))
        for (const c of candidates) {
            const win = c.win
            const key = String(c.aircraft.aircraftId || "") + ":" + win.dayIdx + ":" + win.startAbs + ":" + win.endAbs
            const readyLead = win.direction === "inbound" ? 45 : 10
            const usedUntil = a.used && a.used.has(key) ? a.used.get(key) : null
            const baseStart = Math.max(win.startAbs + readyLead, usedUntil || 0)
            const slack = win.endAbs - baseStart - (oneWayMin * 2 + remoteTurn)
            if (slack < 0) continue
            const irregular = a.mode === "long-haul" || a.mode === "sequential"
                ? Math.min(slack, ((Number(a.idx) || 0) * 25) % Math.max(1, slack + 1))
                : 0
            const outAbs = baseStart + irregular
            const backAbs = outAbs + oneWayMin + remoteTurn
            const doneAbs = backAbs + oneWayMin
            if (doneAbs + hubTurn > win.endAbs) continue
            if (a.used) a.used.set(key, doneAbs + hubTurn)
            return {
                aircraft: c.aircraft,
                outAbs,
                backAbs,
                outDay: this._weekDayFromAbs(outAbs),
                backDay: this._weekDayFromAbs(backAbs),
                outDepTime: this._minToHHMM(outAbs),
                backDepTime: this._minToHHMM(backAbs),
                oneWayMin,
                remoteTurn
            }
        }
        return null
    }

    _routePlanWindowsForSchedule(schedule, hub, minDuration) {
        const out = []
        if (!schedule || !Array.isArray(schedule.days)) return out
        for (const day of schedule.days) {
            const dayIdx = Number.isFinite(day && day.dayIdx) ? day.dayIdx : 0
            for (const block of (day && day.blocks) || []) {
                if (!block || block.kind !== "location" || !block.location) continue
                const iata = String(block.location.iata || "").toUpperCase()
                if (iata !== hub) continue
                const start = this._weekMinute(dayIdx, block.startLocal)
                let end = this._weekMinute(dayIdx, block.endLocal)
                if (start == null || end == null) continue
                if (end <= start) end += 1440
                const duration = end - start
                if (duration < Math.max(1, Number(minDuration) || 1)) continue
                out.push({
                    dayIdx,
                    startAbs: start,
                    endAbs: end,
                    duration,
                    direction: block.location.direction || ""
                })
            }
        }
        return out
    }

    _weekMinute(dayIdx, hhmm) {
        const min = this._hhmmToMin(hhmm)
        if (min == null) return null
        return Math.max(0, Math.min(6, Number(dayIdx) || 0)) * 1440 + min
    }

    _weekDayFromAbs(absMin) {
        const n = Math.max(0, Math.floor(Number(absMin) || 0))
        return Math.max(0, Math.min(6, Math.floor(n / 1440) % 7))
    }

    _estimateOneWayMin(distanceKm, mode) {
        const km = Number(distanceKm)
        if (Number.isFinite(km) && km > 0) {
            return Math.max(45, Math.min(960, Math.round((km / 830) * 60 + 50)))
        }
        if (mode === "long-haul") return 720
        if (mode === "sequential") return 120
        return 90
    }

    _remoteTurnMin(mode, distanceKm) {
        const km = Number(distanceKm)
        if (mode === "long-haul" || (Number.isFinite(km) && km >= 4500)) return 120
        if (mode === "sequential" || (Number.isFinite(km) && km >= 1800)) return 70
        return 45
    }

    _renderRoutePlanPreview(host, args) {
        if (!host) return
        const a = args || {}
        const rows = Array.isArray(a.rows) ? a.rows : []
        const T = a.T
        host.innerHTML = ""
        if (!rows.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;"
            empty.textContent = "No mock schedule generated."
            host.append(empty)
            return
        }
        rows.forEach((r, idx) => {
            host.append(this._buildRoutePlanRow(r, idx, a))
        })
    }

    _buildRoutePlanRow(row, idx, args) {
        const T = args && args.T
        const card = document.createElement("div")
        card.dataset.routePlanIdx = String(idx)
        card.style.cssText = [
            "display:grid",
            "grid-template-columns:1fr 58px 56px 24px",
            "gap:4px",
            "align-items:center",
            "padding:5px",
            "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "background:" + (T ? T.color.bone2 : "#ECE7DC")
        ].join(";")

        const aircraft = document.createElement("select")
        aircraft.style.cssText = this._inputStyle(T)
        for (const f of args.fleet || []) {
            const o = document.createElement("option")
            o.value = String(f.aircraftId || "")
            o.textContent = f.registration || f.aircraftId || "Aircraft"
            if (String(row.aircraftId) === o.value) o.selected = true
            aircraft.append(o)
        }
        aircraft.addEventListener("change", () => { row.aircraftId = aircraft.value })

        const dest = document.createElement("input")
        dest.type = "text"
        dest.maxLength = 3
        dest.value = row.destIata || ""
        dest.style.cssText = this._inputStyle(T) + ";text-transform:uppercase;"
        dest.addEventListener("input", () => {
            row.destIata = String(dest.value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3)
            dest.value = row.destIata
        })

        const time = document.createElement("input")
        time.type = "time"
        time.step = "300"
        time.value = row.depTime || "09:00"
        time.style.cssText = this._inputStyle(T)
        time.addEventListener("change", () => { row.depTime = time.value || "09:00" })

        const day = document.createElement("select")
        day.style.cssText = this._inputStyle(T)
        const dayOptions = [["daily", "Daily"], ["0", "Mon"], ["1", "Tue"], ["2", "Wed"], ["3", "Thu"], ["4", "Fri"], ["5", "Sat"], ["6", "Sun"]]
        const currentDay = this._singleDayFromMask(row.dayMask)
        for (const opt of dayOptions) {
            const o = document.createElement("option")
            o.value = opt[0]
            o.textContent = opt[1]
            if ((currentDay == null && opt[0] === "daily") || String(currentDay) === opt[0]) o.selected = true
            day.append(o)
        }
        day.addEventListener("change", () => {
            row.dayMask = day.value === "daily"
                ? [true, true, true, true, true, true, true]
                : this._singleDayMask(Number(day.value))
            row.sequence = day.value === "daily" ? "daily" : "sequential"
        })

        const rm = document.createElement("button")
        rm.type = "button"
        rm.textContent = "×"
        rm.title = "Remove"
        rm.style.cssText = "height:25px;padding:0;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";background:" + (T ? T.color.bone : "#F4F1EA") + ";cursor:pointer;"
        rm.addEventListener("click", () => {
            this._routePlanRows.splice(idx, 1)
            this._renderBuilderBody()
        })

        const meta = document.createElement("div")
        meta.style.cssText = "grid-column:1 / -1;font-size:9px;font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";"
        const origin = row.originIata || row.hub || "?"
        meta.textContent = origin + " -> " + (row.destIata || "?")
            + " · " + this._maskLabel(row.dayMask)
            + (row.distanceKm ? " · " + Math.round(row.distanceKm) + " km" : "")
            + (row.legRole === "return" ? " · return" : (row.sequence === "sequential" ? " · seq" : " · out"))

        card.append(aircraft, dest, time, rm, day, meta)
        return card
    }

    _routePlanEditsFromRows() {
        const inputs = this._safeInputs()
        const hub = String((inputs && inputs.hub) || "").toUpperCase()
        const preset = inputs && inputs.preset
        const rows = Array.isArray(this._routePlanRows) ? this._routePlanRows : []
        return rows.map(r => ({
            kind:       "addRoute",
            aircraftId: String(r.aircraftId || ""),
            waveId:     r.waveId || null,
            presetId:   r.presetId || (preset && preset.id) || null,
            hub:        String(r.originIata || r.hub || hub).toUpperCase(),
            destIata:   String(r.destIata || "").toUpperCase(),
            depTime:    r.depTime || "09:00",
            dayMask:    Array.isArray(r.dayMask) ? r.dayMask.slice(0, 7).map(Boolean) : null,
            flightNumberText: "",
            source:     "route-plan-builder"
        })).filter(e => e.aircraftId && /^[A-Z]{3}$/.test(e.destIata) && /^[A-Z]{3}$/.test(e.hub) && e.destIata !== e.hub)
    }

    _demandByDestination(rows) {
        const map = new Map()
        for (const row of rows || []) {
            const dest = String(row && (row.destIata || row.destination || row.iata) || "").toUpperCase()
            if (!/^[A-Z]{3}$/.test(dest) || map.has(dest)) continue
            map.set(dest, row)
        }
        return map
    }

    _sequentialOffsetMin(idx, distanceKm) {
        const km = Number(distanceKm)
        const block = Number.isFinite(km) && km > 0
            ? Math.max(300, Math.min(1380, Math.round((km / 850) * 60 + 95)))
            : 720
        return (idx * block + (idx % 3) * 25) % 10080
    }

    _singleDayMask(dayIdx) {
        const d = Math.max(0, Math.min(6, Number(dayIdx) || 0))
        return [0, 1, 2, 3, 4, 5, 6].map(i => i === d)
    }

    _singleDayFromMask(mask) {
        if (!Array.isArray(mask) || mask.length < 7) return null
        const on = mask.map(Boolean).reduce((n, v) => n + (v ? 1 : 0), 0)
        if (on !== 1) return null
        return mask.findIndex(Boolean)
    }

    _maskLabel(mask) {
        const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        const single = this._singleDayFromMask(mask)
        if (single != null) return names[single]
        if (Array.isArray(mask) && mask.length >= 7 && mask.every(Boolean)) return "Daily"
        return "Custom"
    }

    _inputStyle(T) {
        return [
            "box-sizing:border-box",
            "width:100%",
            "min-width:0",
            "padding:4px 6px",
            "font-size:10px",
            "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "background:" + (T ? T.color.bone2 : "#ECE7DC"),
            "color:" + (T ? T.color.oxide : "#2B2520"),
            "font-family:" + (T ? T.font.mono : "monospace")
        ].join(";")
    }

    _buttonStyle(T, kind) {
        const primary = kind === "primary"
        return [
            "padding:4px 8px",
            "font-size:10px",
            "border:1px solid " + (primary ? (T ? T.color.rust : "#B8472A") : (T ? T.color.oxide : "#2B2520")),
            "background:" + (primary ? (T ? T.color.rust : "#B8472A") : (T ? T.color.bone : "#F4F1EA")),
            "color:" + (primary ? (T ? T.color.rustFg || "#F4F1EA" : "#F4F1EA") : (T ? T.color.oxide : "#2B2520")),
            "cursor:pointer",
            "text-transform:uppercase",
            "letter-spacing:0.06em",
            "font-weight:" + (T ? T.fw.bold : "700")
        ].join(";")
    }

    _rowHub(row) {
        return String((row && (row.hub || row.gravityHub || row.locIata || row.location)) || "").toUpperCase()
    }

    _waveDeparture(wave) {
        return wave && wave.departureWindow && wave.departureWindow.start
            ? String(wave.departureWindow.start)
            : null
    }

    _hhmmToMin(value) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""))
        if (!m) return null
        const h = Number(m[1])
        const min = Number(m[2])
        if (!Number.isFinite(h) || !Number.isFinite(min)) return null
        return h * 60 + min
    }

    _minToHHMM(value) {
        const n = Math.max(0, Math.round(Number(value) || 0)) % 1440
        const h = Math.floor(n / 60)
        const m = n % 60
        return (h < 10 ? "0" + h : String(h)) + ":" + (m < 10 ? "0" + m : String(m))
    }

    _renderAdvisorBody() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;"

        this._advisorTabsEl = this._buildAdvisorTabs(T)
        wrap.append(this._advisorTabsEl)

        this._advisorPaneEl = document.createElement("div")
        this._advisorPaneEl.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        wrap.append(this._advisorPaneEl)

        this._railShell.setBody(wrap)
        this._renderAdvisorPane()
    }

    _refreshAdvisorTabs() {
        if (!this._advisorTabsEl || !this._advisorTabsEl.parentElement) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const next = this._buildAdvisorTabs(T)
        this._advisorTabsEl.parentElement.replaceChild(next, this._advisorTabsEl)
        this._advisorTabsEl = next
    }

    _buildAdvisorTabs(T) {
        const row = document.createElement("div")
        row.style.cssText = "display:inline-flex;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";align-self:flex-start;"
        const make = (id, label) => {
            const isActive = this._advisorTab === id
            const btn = document.createElement("button")
            btn.type = "button"
            btn.textContent = label
            btn.style.cssText = [
                "padding:2px 8px",
                "font-size:9px",
                "text-transform:uppercase",
                "letter-spacing:0.06em",
                "border:0",
                "border-right:1px solid " + (T ? T.color.oxide : "#2B2520"),
                "background:" + (isActive ? (T ? T.color.oxide : "#2B2520") : (T ? T.color.bone : "#F4F1EA")),
                "color:" + (isActive ? (T ? T.color.boneFg || "#F4F1EA" : "#F4F1EA") : (T ? T.color.oxide : "#2B2520")),
                "cursor:pointer",
                "font-family:" + (T ? T.font.display : "system-ui, sans-serif"),
                "font-weight:" + (T ? T.fw.bold : "700")
            ].join(";")
            btn.addEventListener("click", () => {
                if (this._advisorTab === id) return
                this._advisorTab = id
                this._renderAdvisorBody()
            })
            return btn
        }
        const liveBtn = make("live", "Live")
        const histLabel = "History" + (this._advisorHistory.length ? " (" + this._advisorHistory.length + ")" : "")
        const histBtn = make("history", histLabel)
        row.append(liveBtn, histBtn)
        if (row.lastChild) row.lastChild.style.borderRight = "0"
        return row
    }

    _renderAdvisorPane() {
        if (!this._advisorPaneEl) return
        this._advisorPaneEl.innerHTML = ""
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        if (this._advisorTab === "history") {
            this._advisorListEl = null
            this._renderAdvisorHistoryInto(this._advisorPaneEl, T)
            return
        }
        // Live (default)
        const lead = document.createElement("div")
        lead.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";line-height:1.4;"
        lead.textContent = "Advisor surfaces conflicts and suggestions as you edit. Drag a route to a cell to start."
        this._advisorPaneEl.append(lead)

        // Phase H — auto-proposer surfacing CTA. Runs the configured silent-auto
        // proposer over the active hub's cached top routes; positive proposals
        // appear as Advisor cards via surface().
        const proposerRow = document.createElement("div")
        proposerRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        const proposerBtn = document.createElement("button")
        proposerBtn.type = "button"
        proposerBtn.textContent = "Run proposers now"
        proposerBtn.style.cssText = "padding:3px 8px;font-size:10px;border:1px solid " + (T ? T.color.oxide : "#2B2520") + ";"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "cursor:pointer;text-transform:uppercase;letter-spacing:0.06em;font-weight:" + (T ? T.fw.bold : "700") + ";"
        const proposerStatus = document.createElement("span")
        proposerStatus.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";color:" + (T ? T.color.slate : "#7A6F66") + ";font-size:10px;"
        proposerBtn.addEventListener("click", async () => {
            proposerBtn.disabled = true
            proposerStatus.textContent = "Running…"
            const n = await this._runProposerSurfaceTick()
            proposerStatus.textContent = n + " surfaced"
            proposerBtn.disabled = false
        })
        proposerRow.append(proposerBtn, proposerStatus)
        this._advisorPaneEl.append(proposerRow)

        this._advisorListEl = document.createElement("div")
        this._advisorListEl.setAttribute("role", "list")
        this._advisorListEl.setAttribute("aria-label", "Advisor suggestions")
        this._advisorListEl.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        this._advisorPaneEl.append(this._advisorListEl)
    }

    _renderAdvisorHistoryInto(host, T) {
        if (!this._advisorHistory.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;padding:24px 0;text-align:center;"
            empty.textContent = "No advisor activity yet."
            host.append(empty)
            return
        }
        const list = document.createElement("div")
        list.setAttribute("role", "list")
        list.setAttribute("aria-label", "Recent advisor suggestions")
        list.style.cssText = "display:flex;flex-direction:column;gap:6px;"
        for (const entry of this._advisorHistory) {
            list.append(this._renderHistoryEntry(entry, T))
        }
        host.append(list)
    }

    _renderHistoryEntry(entry, T) {
        const sev = entry.severity || "info"
        const borderColor = sev === "error" ? (T ? T.color.crimson : "#A02034")
            : sev === "warn"  ? (T ? T.color.amber   : "#B8861F")
            :                    (T ? T.color.cobalt  : "#3656A8")
        const card = document.createElement("article")
        card.setAttribute("role", "listitem")
        card.style.cssText = [
            "background:" + (T ? T.color.bone2 : "#ECE7DC"),
            "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0"),
            "border-left:3px solid " + borderColor,
            "padding:6px 8px",
            "display:flex",
            "flex-direction:column",
            "gap:2px",
            "opacity:" + (entry.disposition === "pending" ? "1" : "0.78")
        ].join(";")

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:baseline;gap:6px;"
        const sevTag = document.createElement("span")
        sevTag.textContent = sev.toUpperCase()
        sevTag.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;letter-spacing:0.08em;color:" + borderColor + ";"
        const kind = document.createElement("span")
        kind.style.cssText = "flex:1 1 auto;font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        kind.textContent = entry.kind || ""
        const age = document.createElement("span")
        age.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
        age.textContent = this._formatAge(entry.at)
        head.append(sevTag, kind, age)
        card.append(head)

        const msg = document.createElement("div")
        msg.style.cssText = "font-size:11px;line-height:1.35;color:" + (T ? T.color.oxide : "#2B2520") + ";"
        msg.textContent = entry.message || ""
        card.append(msg)

        const dispText = entry.disposition === "accepted" ? "✓ accepted"
            : entry.disposition === "dismissed" ? "✕ dismissed"
            : "· pending"
        const disp = document.createElement("div")
        disp.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;color:" + (T ? T.color.slate : "#7A6F66") + ";letter-spacing:0.04em;"
        disp.textContent = dispText
        card.append(disp)
        return card
    }

    _formatAge(at) {
        if (!isFinite(at)) return ""
        const sec = Math.max(0, Math.floor((Date.now() - at) / 1000))
        if (sec < 60) return sec + "s ago"
        const min = Math.floor(sec / 60)
        if (min < 60) return min + "m ago"
        const hr = Math.floor(min / 60)
        return hr + "h ago"
    }

    async _runBuilder() {
        if (!this.builderEngine) return
        const inputs = this._safeInputs()
        if (!inputs || !inputs.hub || !inputs.preset) {
            if (this._builderStatusEl) {
                this._builderStatusEl.textContent = !inputs || !inputs.hub
                    ? "Builder waiting for a hub."
                    : "Builder needs an active wave preset."
            }
            return
        }
        // Clear prior cards (other than the leading status line).
        const host = this._builderProposalsHost
        if (!host) return
        // Remove existing builder cards from this host (siblings of the status line).
        for (const child of Array.from(host.querySelectorAll(".aes-canvas-builder-card"))) {
            child.remove()
        }
        if (this._builderStatusEl) this._builderStatusEl.textContent = "Streaming proposals…"
        this._builderProposalCount = 0
        const runId = ++this._activeBuilderRunId
        try {
            await this.builderEngine.propose({
                hub:       inputs.hub,
                fleet:     inputs.fleet || [],
                schedules: inputs.schedules || new Map(),
                preset:    inputs.preset,
                server:    this.server,
                airlineCode: this.airlineCode,
                demandRows: null
            })
            if (runId !== this._activeBuilderRunId) return
            if (this._builderStatusEl) {
                this._builderStatusEl.textContent = this._builderProposalCount
                    ? "Done — stage a plan, then Apply routes."
                    : "No proposals — check demand, fleet, station, and preset diagnostics."
            }
        } catch (e) {
            if (this._builderStatusEl) this._builderStatusEl.textContent = "Builder error — see console."
            throw e
        }
    }

    _onProposal(proposal) {
        if (this._currentMode() !== window.CanvasRailShell.MODE_BUILDER) return
        const host = this._builderProposalsHost
        if (!host) return
        this._builderProposalCount++
        const card = window.CanvasBuilderCard.render(proposal, {
            onAdopt: (edits, info) => this._stageEdits(edits, info)
        })
        host.appendChild(card)
    }

    _stageEdits(edits, info) {
        if (!Array.isArray(edits) || !edits.length) return
        const batchId = "b-" + Date.now().toString(36)
        const stagedKeys = new Set(this._stagedEdits.map(e => this._stageEditKey(e)).filter(Boolean))
        for (const e of edits) {
            const key = this._stageEditKey(e)
            if (key && stagedKeys.has(key)) continue
            if (key) stagedKeys.add(key)
            this._stagedEdits.push(Object.assign({_batch: batchId}, e))
            if (typeof window !== "undefined" && window.CentralHubBus) {
                window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_STAGED,
                    {kind: e.kind, payload: e, batchId})
            }
        }
        this._paintBuilderPreview(edits)
        if (this._railShell) this._railShell.setStagedCount(this._stagedEdits.length)
        // Auto-flip to Advisor on first staged batch (per plan).
        if (info && !info.fragment && this._currentMode() === window.CanvasRailShell.MODE_BUILDER) {
            this._railShell.setMode(window.CanvasRailShell.MODE_ADVISOR)
            this._onModeChange(window.CanvasRailShell.MODE_ADVISOR)
        }
    }

    _stageEditKey(edit) {
        const p = edit && edit.payload && typeof edit.payload === "object" ? edit.payload : edit
        if (!p) return ""
        const mask = Array.isArray(p.dayMask) ? p.dayMask.slice(0, 7).map(v => v ? "1" : "0").join("") : ""
        return [
            edit && edit.kind || p.kind || "",
            p.aircraftId || "",
            p.hub || "",
            p.destIata || p.destination || "",
            p.waveId || "",
            p.depTime || p.depTimeLocal || "",
            mask
        ].join("|")
    }

    _paintBuilderPreview(edits) {
        if (typeof document === "undefined" || !Array.isArray(edits)) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        for (const e of edits) {
            if (!e || !e.aircraftId || !e.waveId) continue
            const aid = String(e.aircraftId).replace(/"/g, "\\\"")
            const wid = String(e.waveId).replace(/"/g, "\\\"")
            const cell = document.querySelector('[data-canvas-aircraft-id="' + aid + '"][data-canvas-wave-id="' + wid + '"]')
            if (!cell) continue
            cell.dataset.canvasBuilderPreview = "1"
            cell.style.outline = "2px dotted " + (T ? T.color.rust : "#B8472A")
            cell.style.outlineOffset = "-3px"
            cell.style.background = T ? T.color.bone3 : "#E0DAC8"
            let tag = cell.querySelector("[data-canvas-builder-preview-label]")
            if (!tag) {
                tag = document.createElement("div")
                tag.dataset.canvasBuilderPreviewLabel = "1"
                tag.style.cssText = "margin-top:4px;font-family:" + (T ? T.font.mono : "monospace") + ";font-size:9px;color:" + (T ? T.color.rust : "#B8472A") + ";"
                cell.appendChild(tag)
            }
            tag.textContent = "staged -> " + (e.destIata || "?")
        }
    }

    async _onCommit() {
        if (!this._stagedEdits.length) return
        if (this.commitBar) {
            await this.commitBar.commit()
            if (this._railShell) this._railShell.setStagedCount(0)
            return
        }
        // Fallback path when commit-bar isn't loaded — emit + clear so the
        // rail returns to a clean state.
        const batchId = "c-" + Date.now().toString(36)
        const edits = this._stagedEdits.slice()
        this._stagedEdits = []
        if (this._railShell) this._railShell.setStagedCount(0)
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_COMMITTED, {batchId, edits})
        }
    }

    _onDiscard() {
        if (!this._stagedEdits.length) return
        if (this.commitBar) {
            this.commitBar.discard()
            if (this._railShell) this._railShell.setStagedCount(0)
            return
        }
        const batchId = "d-" + Date.now().toString(36)
        this._stagedEdits = []
        if (this._railShell) this._railShell.setStagedCount(0)
        if (typeof window !== "undefined" && window.CentralHubBus) {
            window.CentralHubBus.emit(window.AesCanvasEvents.EDIT_DISCARDED, {batchId})
        }
    }

    _safeInputs() {
        try { return this.getInputs() || {} }
        catch (e) { console.warn("[AES Canvas] rail getInputs failed", e); return {} }
    }

    /**
     * Phase H — manual proposer surface. Reads the active hub's cached
     * topRoutes + per-route price cache, runs the configured silent-auto
     * proposer through `surface()` (which emits ADVISOR_SUGGESTION on a
     * positive proposal). Returns the count of suggestions emitted so the
     * caller can update its status text.
     *
     * Reads settings via RouteAssistantSettings; uses the configured
     * `pricing.silentAutoStrategy` (defaults to "per-class-elasticity").
     * Skips when surface() isn't available — older bundles without the
     * Phase 8 wrapper still work via the silent loop in panel.js.
     */
    _classEnabledMap(src) {
        const out = {Y: true, C: true, F: true, Cargo: true}
        if (!src || typeof src !== "object") return out
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            if (typeof src[cls] === "boolean") out[cls] = src[cls]
        }
        return out
    }

    _classNumberMap() {
        const out = {}
        for (let i = 0; i < arguments.length; i++) {
            const src = arguments[i]
            if (!src || typeof src !== "object") continue
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                if (out[cls] != null) continue
                if (src[cls] === null || src[cls] === undefined || src[cls] === "") continue
                const n = Number(src[cls])
                if (isFinite(n)) out[cls] = n
            }
        }
        return out
    }

    _silentAutoCfgFromSettings(settings) {
        const p = (settings && settings.pricing) || {}
        const apply = p.apply || {}
        return {
            silentAutoEnabled:      !!p.silentAutoEnabled,
            silentAutoTickMin:       isFinite(p.silentAutoTickMin)     ? p.silentAutoTickMin     : 30,
            silentAutoMaxPerDay:     isFinite(p.silentAutoMaxPerDay)   ? p.silentAutoMaxPerDay   : 20,
            silentAutoMaxPerHour:    isFinite(p.silentAutoMaxPerHour)  ? p.silentAutoMaxPerHour  : 5,
            silentAutoMinDeltaPct:   isFinite(p.silentAutoMinDeltaPct) ? p.silentAutoMinDeltaPct : 3,
            silentAutoMaxStepPct:    isFinite(p.silentAutoMaxStepPct)  ? p.silentAutoMaxStepPct  : 10,
            silentAutoStrategy:      p.silentAutoStrategy || "per-class-elasticity",
            silentAutoFollowMode:    p.silentAutoFollowMode || "watchlist",
            silentAutoLastTickAt:    isFinite(p.silentAutoLastTickAt) ? p.silentAutoLastTickAt : null,
            silentAutoLastTickResult: p.silentAutoLastTickResult || null,
            silentAutoMutedUntil:    isFinite(p.silentAutoMutedUntil) ? p.silentAutoMutedUntil : null,
            silentAutoCompetitorMinCount: isFinite(apply.silentAutoCompetitorMinCount)
                ? apply.silentAutoCompetitorMinCount : 2,
            silentAutoOrsMaxAgeMin: isFinite(apply.silentAutoOrsMaxAgeMin)
                ? apply.silentAutoOrsMaxAgeMin : 60,
            silentAutoStaleCompetitorWarnDays: isFinite(apply.silentAutoStaleCompetitorWarnDays)
                ? apply.silentAutoStaleCompetitorWarnDays : 7,
            silentAutoBlockOnStaleCompetitors: !!apply.silentAutoBlockOnStaleCompetitors,
            silentAutoStrategySnapshotMaxAgeMin: isFinite(apply.silentAutoStrategySnapshotMaxAgeMin)
                ? apply.silentAutoStrategySnapshotMaxAgeMin : 10,
            silentAutoControlVariablesEnabled: apply.silentAutoControlVariablesEnabled !== false,
            silentAutoPerClassEnabled: this._classEnabledMap(p.silentAutoPerClassEnabled),
            silentAutoPerClassMaxStepPct: this._classNumberMap(p.silentAutoPerClassMaxStepPct),
            silentAutoPerClassMinDemandPool: this._classNumberMap(p.silentAutoPerClassMinDemandPool),
            applyClassGates: (apply && apply.classes && typeof apply.classes === "object")
                ? apply.classes : null
        }
    }

    async _runProposerSurfaceTick() {
        const inputs = this._safeInputs()
        const hub = inputs && inputs.hub
        if (!hub) return 0
        if (typeof window === "undefined") return 0
        if (!window.RouteAssistantSilentAutoProposers
                || typeof window.RouteAssistantSilentAutoProposers.surface !== "function") {
            return 0
        }
        let settings = {pricing: {}}
        try {
            if (window.RouteAssistantSettings) {
                settings = await window.RouteAssistantSettings.load()
            }
        } catch (_) {}
        const cfg = this._silentAutoCfgFromSettings(settings)
        const strategy = cfg.silentAutoStrategy || "per-class-elasticity"
        const rows = await this._loadTopRoutes(hub)
        if (!rows || !rows.length) return 0
        const ctx = {
            hub,
            settings,
            server: this.server,
            airlineCode: this.airlineCode,
            now: Date.now(),
            strategy
        }
        let n = 0
        for (const r of rows) {
            if (!r || !r.destIata) continue
            const prices = await this._loadCachedPrices(hub, r.destIata)
            if (!prices) continue
            const result = window.RouteAssistantSilentAutoProposers.surface(strategy, r, prices, cfg, ctx)
            if (result && result.ok) n++
        }
        return n
    }

    async _loadTopRoutes(hub) {
        try {
            const hubU = String(hub || "").toUpperCase()
            const legacyKey = "routeAssistant:topRoutes:" + hubU
            const scopedKey = this._accountScopedKey("routeAssistant:topRoutes", hubU)
            const keys = scopedKey && scopedKey !== legacyKey ? [scopedKey, legacyKey] : [legacyKey]
            const data = await chrome.storage.local.get(keys)
            const blob = this._pickScopedRecord(data, keys, (rec) => {
                if (!rec || !Array.isArray(rec.rows)) return false
                const recHub = String(rec.hub || hubU || "").toUpperCase()
                return !hubU || !recHub || recHub === hubU
            })
            return (blob && Array.isArray(blob.rows)) ? blob.rows : []
        } catch (_) { return [] }
    }

    async _loadCachedPrices(hub, dest) {
        try {
            const pair = String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
            const ownLegacy = "routeAssistant:markets:ownPricing:" + pair
            const ownScoped = this._accountScopedKey("routeAssistant:markets:ownPricing", pair)
            const oldLegacy = "routeAssistant:prices:" + pair
            const keys = []
            if (ownScoped && ownScoped !== ownLegacy) keys.push(ownScoped)
            keys.push(ownLegacy, oldLegacy)
            const data = await chrome.storage.local.get(keys)
            const blob = this._pickScopedRecord(data, keys, (rec) => {
                if (!rec) return false
                const recHub = String(rec.hub || hub || "").toUpperCase()
                const recDest = String(rec.dest || rec.destIata || dest || "").toUpperCase()
                return (!recHub || recHub === String(hub || "").toUpperCase())
                    && (!recDest || recDest === String(dest || "").toUpperCase())
                    && !!this._normalisePriceBlob(rec)
            })
            if (!blob) return null
            return this._normalisePriceBlob(blob)
        } catch (_) { return null }
    }

    _accountScopedKey(prefix, suffix) {
        try {
            if (typeof window !== "undefined" && window.AesAccountKey
                && typeof window.AesAccountKey.acctKey === "function") {
                return window.AesAccountKey.acctKey(prefix, suffix)
            }
        } catch (_) {}
        try {
            if (typeof acctKey !== "undefined" && typeof acctKey === "function") {
                return acctKey(prefix, suffix)
            }
        } catch (_) {}
        return prefix + ":" + suffix
    }

    _pickScopedRecord(data, keys, predicate) {
        for (const key of (keys || [])) {
            const rec = data && data[key]
            if (predicate(rec, key)) return rec
        }
        return null
    }

    _normalisePriceBlob(blob) {
        if (!blob) return null
        if (blob.prices && typeof blob.prices === "object" && Object.keys(blob.prices).length) {
            return blob.prices
        }
        // Bare-map shape: prices live at the top level.
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            if (isFinite(blob[cls])) return {
                Y: blob.Y,
                C: blob.C,
                F: blob.F,
                Cargo: blob.Cargo
            }
        }
        return null
    }

    _wireBus() {
        if (typeof window === "undefined" || !window.CentralHubBus) return
        const sub = (event, handler) => {
            const off = window.CentralHubBus.on(event, handler)
            this._busOff.push(off)
        }
        sub(window.AesCanvasEvents.BUILDER_PROPOSAL, (p) => this._onProposal(p))
        // Re-run builder when the active hub changes.
        sub(window.AesCanvasEvents.HUB_CHANGED, () => {
            if (this._currentMode() === window.CanvasRailShell.MODE_BUILDER) {
                this._renderBuilderBody()
            }
        })
        sub(window.AesCanvasEvents.ADVISOR_SUGGESTION, (s) => this._onAdvisorSuggestion(s))
        sub(window.AesCanvasEvents.ADVISOR_SUGGESTION_RESOLVED, (p) => this._onAdvisorResolved(p))
        // External stage events — advisor card actions, the demand-overlay
        // "Stage edit" badge, the silent-auto-proposer surface() wrapper, etc.
        // The controller's own _stageEdits emits also flow through here; we
        // skip those by checking for the controller-stamped batchId.
        sub(window.AesCanvasEvents.EDIT_STAGED, (e) => this._onExternalEditStaged(e))
    }

    _onExternalEditStaged(event) {
        if (!event || !event.payload) return
        // Guard: the controller's own _stageEdits emits with batchId `b-…`.
        // Skip those to avoid double-staging.
        if (event.batchId && /^b-/.test(String(event.batchId))) return
        const payload = event.payload
        const kind = event.kind || payload.kind
        if (!kind) return
        const edit = (payload.kind && payload.payload) ? payload : {kind, payload}
        // Don't recurse: bypass _stageEdits' bus emit by pushing directly.
        const batchId = "x-" + Date.now().toString(36)
        this._stagedEdits.push(Object.assign({_batch: batchId}, edit))
        if (this._railShell) this._railShell.setStagedCount(this._stagedEdits.length)
    }

    _onAdvisorSuggestion(suggestion) {
        if (!suggestion) return
        this._recordHistory(suggestion)
        // Always queue advisor suggestions in the list. Mode-flipping is
        // handled in _stageEdits; if the user is in Builder mode we still
        // collect suggestions silently so they show up the moment they
        // flip to Advisor.
        if (this._currentMode() !== window.CanvasRailShell.MODE_ADVISOR) return
        if (this._advisorTab !== "live") {
            // History tab is showing; refresh the pane so the new entry appears.
            this._renderAdvisorPane()
            this._refreshAdvisorTabs()
            return
        }
        if (!this._advisorListEl) {
            // Re-render advisor body lazily so the list element exists.
            this._renderAdvisorBody()
        }
        if (!this._advisorListEl) return
        const card = window.CanvasAdvisorCard.render(suggestion)
        // Newest at the top — feels more reactive to the user's last action.
        this._advisorListEl.insertBefore(card, this._advisorListEl.firstChild)
        this._refreshAdvisorTabs()
    }

    _recordHistory(suggestion) {
        const entry = {
            id:          suggestion.id || null,
            kind:        suggestion.kind || "",
            severity:    suggestion.severity || "info",
            message:     suggestion.message || "",
            at:          Date.now(),
            disposition: "pending"
        }
        this._advisorHistory.unshift(entry)
        if (this._advisorHistory.length > CanvasRailController.HISTORY_MAX) {
            this._advisorHistory.length = CanvasRailController.HISTORY_MAX
        }
    }

    _onAdvisorResolved(payload) {
        if (!payload || !payload.id) return
        const entry = this._advisorHistory.find(e => e.id === payload.id)
        if (!entry) return
        entry.disposition = payload.accepted ? "accepted" : "dismissed"
        // Refresh history view if it's the active tab so the disposition
        // badge updates without waiting for the next mode switch.
        if (this._currentMode() === window.CanvasRailShell.MODE_ADVISOR && this._advisorTab === "history") {
            this._renderAdvisorPane()
        }
    }
}

if (typeof window !== "undefined") {
    window.CanvasRailController = CanvasRailController
}
