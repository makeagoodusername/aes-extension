/**
 * Dashboard UI for schedule management. Owns the entire panel — the
 * dashboard's displayScheduleManagement() function only needs to construct
 * one of these and call render().
 *
 * Pure DOM (no jQuery) to match the newer module style. The layout is two
 * columns: a preset list/editor on the left, factor + composition controls
 * on the right, plus a build/history strip below.
 *
 * When `context.aircraftId` is provided (from the Fleet Hub overlay), the
 * panel also renders a per-leg editor synced to AesAfpActiveDraftStore so
 * the user's micro-edits flow bi-directionally with the AFP wave-applier
 * sidebar on /app/fleets/aircraft/<id>/0. Without aircraftId (the original
 * dashboard scope) the leg-list section is suppressed.
 */
class SchedulePanel {
    constructor(rootEl, context) {
        this.root = rootEl
        this.context = context || {}
        this.block = null
        this.editingId = null
        this.draft = null
        this._draftListener = null
        this._draftReloadTimer = null
        this._legStatusBySeq = {}  // transient submit-queue state, not persisted
        // Track 7 slice 7f — persisted Schedule for the overlay aircraft,
        // loaded alongside draft and re-fetched when the broadcaster
        // publishes a fresh scrape. Drives the Current-vs-Proposed diff
        // summary above the legs table.
        this.schedule = null
        this._scheduleListener = null
        this._afpSettings = null
    }

    /** Returns true when this panel is per-aircraft (overlay use) vs dashboard. */
    _isOverlayMode() {
        return !!(this.context.server && this.context.aircraftId)
    }

    static _isValidHHMM(value) {
        if (!value) return false
        if (typeof ScheduleFactors === "undefined"
            || typeof ScheduleFactors.parseHHMM !== "function") {
            return true
        }
        return Number.isFinite(ScheduleFactors.parseHHMM(value))
    }

    async render() {
        this.block = await SchedulePresets.load()
        if (this._isOverlayMode()) {
            // Track 7 slice 7f — load the persisted Schedule in parallel
            // with the draft so the Current-vs-Proposed summary lights up
            // on first paint when the AFP page has been visited recently.
            const [draft, schedule, afpSettings] = await Promise.all([
                AesAfpActiveDraftStore.load(
                    this.context.server, this.context.aircraftId),
                (typeof AesAfpScheduleStore !== "undefined")
                    ? AesAfpScheduleStore.load(
                          this.context.server, this.context.aircraftId).catch(() => null)
                    : Promise.resolve(null),
                (typeof AesAfpSettings !== "undefined" && typeof AesAfpSettings.load === "function")
                    ? AesAfpSettings.load().catch(() => null)
                    : Promise.resolve(null)
            ])
            this.draft = draft
            this.schedule = schedule || null
            this._afpSettings = afpSettings || null
            // Mirror remote preset selection into editingId when present
            // — keeps the panel in sync with the AFP wave-applier's choice.
            this.editingId = this.draft.presetId
                || this.block.defaultPresetId
                || this.block.presets[0]?.id
                || null
            this._attachDraftListener()
            this._attachScheduleListener()
        } else {
            this.draft = null
            this.schedule = null
            this._afpSettings = null
            this.editingId = this.block.defaultPresetId
                || this.block.presets[0]?.id
                || null
        }

        this.root.innerHTML = ""
        this.root.append(this._buildHeader())

        const layout = document.createElement("div")
        layout.className = "row"
        layout.style.marginTop = "12px"
        const left = document.createElement("div")
        left.className = "col-md-5"
        const right = document.createElement("div")
        right.className = "col-md-7"
        layout.append(left, right)
        this.root.append(layout)

        left.append(this._buildPresetListColumn())
        right.append(this._buildEditorColumn())

        this.root.append(this._buildBuildBar())
        if (this._isOverlayMode()) {
            this.root.append(this._buildDraftLegsSection())
        }
        this.root.append(this._buildOpenStationsBar())
        this.root.append(this._buildHistorySection())

        await this._refreshHistory()
    }

    /**
     * Detach storage listener + status strip. The overlay's close path
     * calls this; the dashboard mount doesn't need it (page navigation
     * tears the panel down anyway).
     */
    dispose() {
        if (this._draftListener) {
            try { chrome.storage.onChanged.removeListener(this._draftListener) }
            catch (_) { /* noop */ }
            this._draftListener = null
        }
        if (this._scheduleListener) {
            try { chrome.storage.onChanged.removeListener(this._scheduleListener) }
            catch (_) { /* noop */ }
            this._scheduleListener = null
        }
        if (this._draftReloadTimer) {
            clearTimeout(this._draftReloadTimer)
            this._draftReloadTimer = null
        }
        if (this._statusStrip) {
            try { this._statusStrip.dispose() } catch (_) { /* noop */ }
            this._statusStrip = null
        }
    }

    _buildHeader() {
        const wrap = document.createElement("div")
        const h = document.createElement("h3")
        h.innerText = "Schedule Management"
        const sub = document.createElement("p")
        sub.style.color = "#888"
        sub.innerText = "Design wave-aware schedule presets — set arrival/departure banks, "
            + "composition by haul-length, and the factors (transfer time, range, slot window) "
            + "the builder must respect."
        wrap.append(h, sub)
        return wrap
    }

    _buildPresetListColumn() {
        const panel = document.createElement("div")
        panel.className = "as-panel"

        const title = document.createElement("h4")
        title.innerText = "Presets"
        panel.append(title)

        const list = document.createElement("div")
        list.id = "aes-sm-preset-list"
        panel.append(list)

        const actions = document.createElement("div")
        actions.style.cssText = "display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;"

        const newBtn = document.createElement("button")
        newBtn.type = "button"
        newBtn.className = "btn btn-default btn-sm"
        newBtn.innerText = "New preset"
        newBtn.addEventListener("click", async () => {
            const created = await SchedulePresets.create({name: "New schedule preset"})
            this.editingId = created.id
            await this.render()
        })

        const dupBtn = document.createElement("button")
        dupBtn.type = "button"
        dupBtn.className = "btn btn-default btn-sm"
        dupBtn.innerText = "Duplicate"
        dupBtn.addEventListener("click", async () => {
            if (!this.editingId) return
            const copy = await SchedulePresets.duplicate(this.editingId)
            if (copy) { this.editingId = copy.id; await this.render() }
        })

        const delBtn = document.createElement("button")
        delBtn.type = "button"
        delBtn.className = "btn btn-default btn-sm"
        delBtn.innerText = "Delete"
        delBtn.addEventListener("click", async () => {
            if (!this.editingId) return
            if (!confirm("Delete this preset? This cannot be undone.")) return
            await SchedulePresets.remove(this.editingId)
            this.editingId = null
            await this.render()
        })

        actions.append(newBtn, dupBtn, delBtn)
        panel.append(actions)

        this._populatePresetList(list)
        return panel
    }

    _populatePresetList(container) {
        container.innerHTML = ""
        if (!this.block.presets.length) {
            const empty = document.createElement("p")
            empty.style.color = "#888"
            empty.innerText = "No presets yet. Click \"New preset\" to start."
            container.append(empty)
            return
        }
        const ul = document.createElement("ul")
        ul.className = "list-group"
        for (const preset of this.block.presets) {
            const li = document.createElement("li")
            li.className = "list-group-item"
            li.style.cursor = "pointer"
            if (preset.id === this.editingId) {
                li.style.fontWeight = "bold"
                li.style.background = "#e7f0ff"
            }
            const name = document.createElement("div")
            name.innerText = preset.name
            const meta = document.createElement("small")
            meta.style.color = "#888"
            const waveCount = (preset.waves || []).length
            meta.innerText = (preset.hub || "no hub") + " • "
                + waveCount + " wave" + (waveCount === 1 ? "" : "s")
            li.append(name, meta)
            li.addEventListener("click", async () => {
                this.editingId = preset.id
                if (this._isOverlayMode()) {
                    await AesAfpActiveDraftStore.setPreset(
                        this.context.server, this.context.aircraftId, preset.id)
                }
                await this.render()
            })
            ul.append(li)
        }
        container.append(ul)
    }

    _buildEditorColumn() {
        const panel = document.createElement("div")
        panel.className = "as-panel"

        const preset = this.block.presets.find(p => p.id === this.editingId)
        if (!preset) {
            const empty = document.createElement("p")
            empty.style.color = "#888"
            empty.innerText = "Select a preset on the left, or create one to begin editing."
            panel.append(empty)
            return panel
        }

        panel.append(this._buildIdentitySection(preset))
        panel.append(this._buildFactorsSection(preset))
        panel.append(this._buildWavesSection(preset))
        return panel
    }

    _buildIdentitySection(preset) {
        const wrap = document.createElement("fieldset")
        const legend = document.createElement("legend")
        legend.innerText = "Identity"
        legend.style.fontSize = "14px"
        wrap.append(legend)

        wrap.append(this._textField("Name", preset.name, async v => {
            preset.name = v || preset.name
            await SchedulePresets.update(preset.id, {name: preset.name})
            await this.render()
        }))
        wrap.append(this._textField("Hub (IATA, e.g. FRA)", preset.hub || "", async v => {
            preset.hub = (v || "").toUpperCase()
            await SchedulePresets.update(preset.id, {hub: preset.hub})
            await this.render()
        }, {maxLength: 4, style: "text-transform:uppercase"}))
        wrap.append(this._textField("Notes", preset.notes || "", async v => {
            preset.notes = v
            await SchedulePresets.update(preset.id, {notes: v})
        }))
        return wrap
    }

    _buildFactorsSection(preset) {
        const wrap = document.createElement("fieldset")
        wrap.style.marginTop = "12px"
        const legend = document.createElement("legend")
        legend.innerText = "Factors"
        legend.style.fontSize = "14px"
        wrap.append(legend)

        const f = preset.factors

        const update = async (key, value) => {
            const next = Object.assign({}, preset.factors || f, {[key]: value})
            preset.factors = next
            await SchedulePresets.update(preset.id, {factors: next})
        }

        const row = (label, child) => {
            const r = document.createElement("div")
            r.className = "form-group"
            const l = document.createElement("label")
            l.innerText = label
            l.style.display = "block"
            r.append(l, child)
            return r
        }

        wrap.append(row("Min transfer (minutes)",
            this._numberInput(f.minTransferMinutes, 0, 720, v => update("minTransferMinutes", v))))
        wrap.append(row("Max transfer (minutes)",
            this._numberInput(f.maxTransferMinutes, 0, 720, v => update("maxTransferMinutes", v))))
        wrap.append(row("Turnaround buffer (minutes)",
            this._numberInput(f.turnaroundBuffer, 0, 240, v => update("turnaroundBuffer", v))))

        const slotRow = document.createElement("div")
        slotRow.className = "form-group"
        const slotLabel = document.createElement("label")
        slotLabel.innerText = "Hub slot window"
        slotLabel.style.display = "block"
        const slotStart = this._timeInput(f.slotWindow.start, async v => {
            const current = (preset.factors && preset.factors.slotWindow) || f.slotWindow
            await update("slotWindow", Object.assign({}, current, {start: v}))
        })
        const slotEnd = this._timeInput(f.slotWindow.end, async v => {
            const current = (preset.factors && preset.factors.slotWindow) || f.slotWindow
            await update("slotWindow", Object.assign({}, current, {end: v}))
        })
        const dash = document.createElement("span")
        dash.innerText = " – "
        dash.style.margin = "0 8px"
        slotRow.append(slotLabel, slotStart, dash, slotEnd)
        wrap.append(slotRow)

        const dayRow = document.createElement("div")
        dayRow.className = "form-group"
        const dayLabel = document.createElement("label")
        dayLabel.innerText = "Day pattern"
        dayLabel.style.display = "block"
        const daySelect = document.createElement("select")
        daySelect.className = "form-control"
        for (const opt of [["daily", "Daily"], ["weekdays", "Weekdays"],
                           ["weekends", "Weekends"], ["custom", "Custom"]]) {
            const o = document.createElement("option")
            o.value = opt[0]; o.innerText = opt[1]
            if (f.dayPattern === opt[0]) o.selected = true
            daySelect.append(o)
        }
        daySelect.addEventListener("change", async () => {
            await update("dayPattern", daySelect.value)
            await this.render()
        })
        dayRow.append(dayLabel, daySelect)
        wrap.append(dayRow)

        if (f.dayPattern === "custom") {
            const maskRow = document.createElement("div")
            maskRow.style.cssText = "display:flex; gap:6px; margin-top:6px;"
            const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            const mask = ScheduleFactors.resolveDayMask("custom", f.dayMask)
            days.forEach((d, i) => {
                const lbl = document.createElement("label")
                lbl.style.cssText = "display:inline-flex; align-items:center; gap:3px;"
                const cb = document.createElement("input")
                cb.type = "checkbox"
                cb.checked = !!mask[i]
                cb.addEventListener("change", async () => {
                    const next = mask.slice()
                    next[i] = cb.checked ? 1 : 0
                    await update("dayMask", next)
                })
                lbl.append(cb, document.createTextNode(" " + d))
                maskRow.append(lbl)
            })
            wrap.append(maskRow)
        }

        const nightRow = document.createElement("div")
        nightRow.className = "form-group"
        const nightLbl = document.createElement("label")
        nightLbl.style.cssText = "display:inline-flex; align-items:center; gap:6px;"
        const nightCb = document.createElement("input")
        nightCb.type = "checkbox"
        nightCb.checked = !!f.nightArrivalsAllowed
        nightCb.addEventListener("change", () => update("nightArrivalsAllowed", nightCb.checked))
        nightLbl.append(nightCb, document.createTextNode(" Allow arrivals outside slot window"))
        nightRow.append(nightLbl)
        wrap.append(nightRow)

        return wrap
    }

    _buildWavesSection(preset) {
        const wrap = document.createElement("fieldset")
        wrap.style.marginTop = "12px"
        const legend = document.createElement("legend")
        legend.innerText = "Waves"
        legend.style.fontSize = "14px"
        wrap.append(legend)

        if (!preset.waves.length) {
            const empty = document.createElement("p")
            empty.style.color = "#888"
            empty.innerText = "No waves yet."
            wrap.append(empty)
        }

        preset.waves.forEach((wave, idx) => {
            wrap.append(this._buildWaveCard(preset, wave, idx))
        })

        const addBtn = document.createElement("button")
        addBtn.type = "button"
        addBtn.className = "btn btn-default btn-sm"
        addBtn.innerText = "Add wave"
        addBtn.addEventListener("click", async () => {
            const next = preset.waves.concat([
                SchedulePresets.newWave("Wave " + (preset.waves.length + 1))
            ])
            await SchedulePresets.update(preset.id, {waves: next})
            await this.render()
        })
        wrap.append(addBtn)
        return wrap
    }

    _buildWaveCard(preset, wave, idx) {
        const card = document.createElement("div")
        card.className = "as-panel"
        card.style.cssText = "padding:8px; margin:6px 0; background:#fafafa;"

        const header = document.createElement("div")
        header.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:6px;"
        const labelInput = document.createElement("input")
        labelInput.type = "text"
        labelInput.className = "form-control input-sm"
        labelInput.style.flex = "1"
        labelInput.value = wave.label
        labelInput.addEventListener("change", async () => {
            const updated = Object.assign({}, wave, {label: labelInput.value || wave.label})
            const next = preset.waves.slice()
            next[idx] = updated
            preset.waves = next
            wave = updated
            await SchedulePresets.update(preset.id, {waves: next})
        })

        const removeBtn = document.createElement("button")
        removeBtn.type = "button"
        removeBtn.className = "btn btn-default btn-xs"
        removeBtn.innerText = "Remove"
        removeBtn.addEventListener("click", async () => {
            const next = preset.waves.slice()
            next.splice(idx, 1)
            await SchedulePresets.update(preset.id, {waves: next})
            await this.render()
        })
        header.append(labelInput, removeBtn)
        card.append(header)

        const updateWindow = async (which, key, value) => {
            const currentWindow = wave[which] || {}
            const updatedWindow = Object.assign({}, currentWindow, {[key]: value})
            const updated = Object.assign({}, wave, {[which]: updatedWindow})
            const next = preset.waves.slice()
            next[idx] = updated
            preset.waves = next
            wave = updated
            await SchedulePresets.update(preset.id, {waves: next})
        }

        const windowRow = (label, win, which) => {
            const row = document.createElement("div")
            row.style.cssText = "display:flex; gap:8px; align-items:center; margin:4px 0;"
            const lbl = document.createElement("span")
            lbl.style.cssText = "min-width:130px;"
            lbl.innerText = label
            const start = this._timeInput(win.start, v => updateWindow(which, "start", v))
            const end   = this._timeInput(win.end,   v => updateWindow(which, "end", v))
            const dash = document.createElement("span"); dash.innerText = "–"
            row.append(lbl, start, dash, end)
            return row
        }
        card.append(windowRow("Arrival window",   wave.arrivalWindow,   "arrivalWindow"))
        card.append(windowRow("Departure window", wave.departureWindow, "departureWindow"))

        const compRow = document.createElement("div")
        compRow.style.cssText = "display:flex; gap:12px; align-items:center; margin-top:6px; flex-wrap:wrap;"
        const compLbl = document.createElement("span")
        compLbl.style.cssText = "min-width:130px;"
        compLbl.innerText = "Composition"
        compRow.append(compLbl)
        for (const bucket in preset.factors.rangeBuckets) {
            const bucketCfg = preset.factors.rangeBuckets[bucket]
            const group = document.createElement("label")
            group.style.cssText = "display:inline-flex; align-items:center; gap:4px;"
            const txt = document.createElement("span")
            txt.style.cssText = "font-size:90%;"
            txt.innerText = bucketCfg.label || bucket
            const input = this._numberInput(wave.composition[bucket] | 0, 0, 99, async v => {
                const comp = Object.assign({}, wave.composition, {[bucket]: v})
                const updated = Object.assign({}, wave, {composition: comp})
                const next = preset.waves.slice()
                next[idx] = updated
                preset.waves = next
                wave = updated
                await SchedulePresets.update(preset.id, {waves: next})
            })
            input.style.width = "70px"
            group.append(txt, input)
            compRow.append(group)
        }
        card.append(compRow)
        return card
    }

    _buildBuildBar() {
        const bar = document.createElement("div")
        bar.className = "as-panel"
        bar.style.marginTop = "16px"

        const title = document.createElement("h4")
        title.innerText = "Build"
        bar.append(title)

        const buildBtn = document.createElement("button")
        buildBtn.type = "button"
        buildBtn.className = "btn btn-primary"
        buildBtn.innerText = "Generate schedule"
        buildBtn.style.marginRight = "8px"

        const status = document.createElement("span")
        status.id = "aes-sm-build-status"
        status.style.marginLeft = "8px"

        buildBtn.addEventListener("click", async () => {
            if (buildBtn.disabled) return
            buildBtn.disabled = true
            try {
                this.block = await SchedulePresets.load()
                const preset = this.block.presets.find(p => p.id === this.editingId)
                if (!preset) { status.innerText = "Select a preset first."; return }
                const builder = new ScheduleBuilder(preset, this.context)
                const errors = builder.validatePreset()
                if (errors.length) {
                    status.innerHTML = '<span class="bad">Preset issues:</span> ' + errors.join("; ")
                    return
                }
                status.innerText = "Loading dynamic route candidates..."
                const routePack = await this._loadDynamicRoutesForBuild(preset)
                if (!routePack.routes.length) {
                    status.innerText = routePack.blocker || "No dynamic route candidates available for this preset."
                    return
                }
                status.innerText = "Generating from " + routePack.routes.length + " route candidate"
                    + (routePack.routes.length === 1 ? "" : "s") + "..."
                const record = builder.build(routePack.routes)
                record.metadata = Object.assign({}, record.metadata || {}, {
                    routeSource: routePack.metadata
                })
                if (routePack.warnings.length) {
                    record.warnings = record.warnings.concat(routePack.warnings)
                }
                await ScheduleStore.save(record)
                await SchedulePresets.save({lastBuildId: record.scheduleId})
                // Mirror into the per-aircraft active draft so the AFP wave
                // applier can pick up the preset selection and generated flights.
                // setFlights clears the per-leg edit/apply/dismiss overlay since
                // seq numbers are regenerated on each build.
                if (this._isOverlayMode()) {
                    await AesAfpActiveDraftStore.setFlights(
                        this.context.server, this.context.aircraftId, {
                            hub:         preset.hub || this.context.hub || null,
                            presetId:    preset.id,
                            flights:     record.flights || [],
                            generatedAt: Date.now()
                        })
                }
                const flightCount = record.flights.length
                const warnCount = record.warnings.length
                status.innerHTML = `<span class="good">Saved schedule ${record.scheduleId}</span> — ${flightCount} flights, ${warnCount} warning(s)`
                    + " from " + routePack.routes.length + " " + routePack.sourceLabel
                await this._refreshHistory()
                await this.render()
            } catch (err) {
                console.warn("[AES Schedule Management] build failed", err)
                status.innerText = "Build failed: " + (err && err.message ? err.message : String(err))
            } finally {
                buildBtn.disabled = false
            }
        })

        bar.append(buildBtn, status)

        const note = document.createElement("p")
        note.style.cssText = "color:#888; font-size:90%; margin-top:8px;"
        note.innerText = "Generate uses dynamic route candidates from AFP, Route Assistant top-routes, "
            + "or FlightsFrom plus cached distances; it saves a local draft schedule and does not post to AS."
        bar.append(note)

        return bar
    }

    async _loadDynamicRoutesForBuild(preset) {
        const hub = SchedulePanel._normaliseHub(
            preset && preset.hub || this.context.hub || this.context.currentHub)
        const out = {
            routes: [],
            warnings: [],
            blocker: "",
            sourceLabel: "dynamic route candidates",
            metadata: {
                hub,
                sources: [],
                candidateCount: 0,
                selectedCount: 0,
                skippedNoDistance: 0,
                skippedNoCapacity: 0,
                skippedNoBucket: 0
            }
        }
        if (!hub) {
            out.blocker = "Set a hub on the preset before generating a dynamic schedule."
            return out
        }

        const capacity = SchedulePanel._capacityByBucket(preset)
        out.metadata.capacityByBucket = capacity.byBucket
        out.metadata.capacityTotal = capacity.total
        if (capacity.total <= 0) {
            out.blocker = "Add at least one route to a wave composition before generating."
            return out
        }

        const rawRows = []
        const pushRows = (source, rows, meta) => {
            if (!Array.isArray(rows) || !rows.length) return
            for (const row of rows) rawRows.push({source, row})
            out.metadata.sources.push(Object.assign({
                source,
                count: rows.length
            }, meta || {}))
        }

        pushRows("AFP candidates", this._inPageCandidateRows(hub))

        const topRoutes = await this._loadTopRoutesRows(hub)
        pushRows("Route Assistant top-routes", topRoutes.rows, topRoutes.meta)

        const flightsFrom = await this._loadFlightsFromRows(hub)
        pushRows("FlightsFrom cache", flightsFrom.rows, flightsFrom.meta)

        if (!rawRows.length) {
            out.blocker = "No cached routes for " + hub
                + ". Open Route Assistant for this hub or scrape FlightsFrom first."
            return out
        }

        const mergedRows = SchedulePanel._dedupeRouteRows(rawRows)
        await this._backfillCachedDistances(hub, mergedRows)

        const routeBuild = SchedulePanel._rowsToBuildRoutes(mergedRows, {
            selectedSpec: this.context.selectedSpec || null
        })
        out.metadata.candidateCount = mergedRows.length
        out.metadata.skippedNoDistance = routeBuild.skippedNoDistance

        const selected = SchedulePanel._selectRoutesForPresetCapacity(routeBuild.routes, preset)
        out.routes = selected.routes
        out.metadata.selectedCount = selected.routes.length
        out.metadata.skippedNoCapacity = selected.skippedNoCapacity
        out.metadata.skippedNoBucket = selected.skippedNoBucket
        out.metadata.selectedByBucket = selected.selectedByBucket

        if (routeBuild.skippedNoDistance) {
            out.warnings.push({
                seq: 0,
                type: "candidateNoDistance",
                message: routeBuild.skippedNoDistance + " candidate route"
                    + (routeBuild.skippedNoDistance === 1 ? " was" : "s were")
                    + " skipped because no cached distance was available"
            })
        }
        if (selected.skippedNoCapacity) {
            out.warnings.push({
                seq: 0,
                type: "candidateOverCapacity",
                message: selected.skippedNoCapacity + " extra candidate route"
                    + (selected.skippedNoCapacity === 1 ? " was" : "s were")
                    + " left out after filling the preset's wave capacity"
            })
        }
        if (selected.skippedNoBucket) {
            out.warnings.push({
                seq: 0,
                type: "candidateNoBucket",
                message: selected.skippedNoBucket + " candidate route"
                    + (selected.skippedNoBucket === 1 ? " did" : "s did")
                    + " not match any configured range bucket"
            })
        }

        if (!out.routes.length) {
            if (routeBuild.skippedNoDistance >= mergedRows.length) {
                out.blocker = "Routes were found for " + hub
                    + ", but none have cached distances yet. Open Route Assistant once for this hub to resolve distances."
            } else {
                out.blocker = "Routes were found for " + hub
                    + ", but none fit the preset's range buckets and wave composition."
            }
            return out
        }

        const sourceNames = out.metadata.sources.map(s => s.source)
        out.sourceLabel = sourceNames.length === 1
            ? sourceNames[0]
            : "dynamic route candidates"
        return out
    }

    _inPageCandidateRows(hub) {
        if (typeof AesAfpRouteCandidates === "undefined") return []
        const ctx = AesAfpRouteCandidates._lastCtx || null
        const origin = SchedulePanel._normaliseHub(ctx && ctx.originIata)
        if (origin && origin !== hub) return []
        const rows = Array.isArray(AesAfpRouteCandidates.last)
            ? AesAfpRouteCandidates.last : []
        return rows.filter(r => r && r.destIata)
    }

    async _loadTopRoutesRows(hub) {
        const empty = {rows: [], meta: null}
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return empty
        const keys = []
        try {
            if (typeof acctKey === "function") {
                const scoped = acctKey("routeAssistant:topRoutes", hub)
                if (scoped) keys.push(scoped)
            }
        } catch (_) { /* account key unavailable */ }
        keys.push("routeAssistant:topRoutes:" + hub, "routeAssistant:topRoutes")
        const uniqueKeys = Array.from(new Set(keys))
        let data = {}
        try { data = await chrome.storage.local.get(uniqueKeys) }
        catch (_) { return empty }
        for (const key of uniqueKeys) {
            const blob = data[key]
            if (!blob || !Array.isArray(blob.rows)) continue
            if (SchedulePanel._normaliseHub(blob.hub) !== hub) continue
            if (blob.server && this.context.server
                    && String(blob.server) !== String(this.context.server)) continue
            return {
                rows: blob.rows,
                meta: {
                    key,
                    scrapedAt: blob.scrapedAt || null,
                    accountId: blob.accountId || null
                }
            }
        }
        return empty
    }

    async _loadFlightsFromRows(hub) {
        const empty = {rows: [], meta: null}
        if (typeof FlightsFromStore === "undefined"
                || typeof FlightsFromStore.loadAirport !== "function") return empty
        try {
            const rec = await FlightsFromStore.loadAirport(hub)
            if (!rec || !Array.isArray(rec.routes)) return empty
            return {
                rows: rec.routes,
                meta: {
                    key: "flightsFrom:" + hub,
                    scrapedAt: rec.scrapedAt || null
                }
            }
        } catch (_) {
            return empty
        }
    }

    async _backfillCachedDistances(hub, rows) {
        const missing = (rows || []).filter(r =>
            r && r.destIata && !SchedulePanel._positiveNumber(r.distanceKm)
                && !SchedulePanel._positiveNumber(r.distanceNm))
        if (!missing.length) return
        const pairs = missing.map(r => [hub, r.destIata])
        let cache = null

        if (typeof RouteAssistantDistanceResolver !== "undefined"
                && typeof RouteAssistantDistanceResolver.bulkLoadCache === "function") {
            try { cache = await RouteAssistantDistanceResolver.bulkLoadCache(pairs, {}) }
            catch (_) { cache = null }
        }
        if (!cache && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            const keys = pairs.map(([a, b]) =>
                "routeAssistant:distance:" + SchedulePanel._distancePairKey(a, b))
            try {
                const data = await chrome.storage.local.get(keys)
                cache = new Map()
                for (const key of keys) {
                    const rec = data[key]
                    if (!rec || !SchedulePanel._positiveNumber(rec.distanceKm)) continue
                    cache.set(key.substring("routeAssistant:distance:".length), rec)
                }
            } catch (_) { cache = null }
        }
        if (!cache) return
        for (const row of missing) {
            const rec = cache.get(SchedulePanel._distancePairKey(hub, row.destIata))
            if (rec && SchedulePanel._positiveNumber(rec.distanceKm)) {
                row.distanceKm = Number(rec.distanceKm)
                row.distanceSource = rec.source || "distance-cache"
            }
        }
    }

    static _normaliseHub(value) {
        const text = String(value || "").trim().toUpperCase()
        return /^[A-Z]{3}$/.test(text) ? text : ""
    }

    static _distancePairKey(a, b) {
        const x = String(a || "").toUpperCase()
        const y = String(b || "").toUpperCase()
        return x < y ? x + "-" + y : y + "-" + x
    }

    static _positiveNumber(value) {
        const n = Number(value)
        return isFinite(n) && n > 0 ? n : null
    }

    static _routeRank(row) {
        if (!row) return 0
        const score = SchedulePanel._positiveNumber(row.score)
            || SchedulePanel._positiveNumber(row.scoreBlend)
            || null
        if (score != null) return score
        const pax = Number(row.paxScore) || 0
        const cargo = Number(row.cargoScore) || 0
        const weekly = Number(row.weeklyFlights) || 0
        const competition = Number(row.airlineCount) || 0
        return pax * 10 + cargo * 5 + Math.min(weekly, 100) * 0.25 - competition
    }

    static _dedupeRouteRows(entries) {
        const byDest = new Map()
        for (const entry of entries || []) {
            const row = entry && entry.row || null
            const dest = SchedulePanel._normaliseHub(row && (row.destIata || row.dest || row.destination))
            if (!dest) continue
            const normalised = Object.assign({}, row, {
                destIata: dest,
                _source: entry.source || "unknown",
                _rankScore: SchedulePanel._routeRank(row)
            })
            const prev = byDest.get(dest)
            if (!prev) {
                byDest.set(dest, normalised)
                continue
            }
            for (const key in normalised) {
                if (prev[key] == null || prev[key] === "") prev[key] = normalised[key]
            }
            prev._source = prev._source || normalised._source
            prev._rankScore = Math.max(prev._rankScore || 0, normalised._rankScore || 0)
        }
        return Array.from(byDest.values()).sort((a, b) =>
            (b._rankScore || 0) - (a._rankScore || 0))
    }

    static _rowsToBuildRoutes(rows, opts) {
        const spec = opts && opts.selectedSpec || null
        const aircraftType = spec && (spec.typeName || spec.name) || null
        const aircraftRangeNm = spec && spec.range
            ? ScheduleFactors.kmToNm(Number(spec.range))
            : null
        const routes = []
        let skippedNoDistance = 0
        for (const row of rows || []) {
            const dest = SchedulePanel._normaliseHub(row && row.destIata)
            if (!dest) continue
            const km = SchedulePanel._positiveNumber(row.distanceKm)
            const nm = SchedulePanel._positiveNumber(row.distanceNm)
                || (km ? ScheduleFactors.kmToNm(km) : null)
            if (!nm) {
                skippedNoDistance++
                continue
            }
            routes.push({
                destination:       dest,
                distanceNm:        nm,
                distanceKm:        km || ScheduleFactors.nmToKm(nm),
                aircraftType:      aircraftType || row.aircraftTypeName || row.aircraftType || null,
                aircraftRangeNm:   aircraftRangeNm || row.aircraftRangeNm || null,
                turnaroundMinutes: Number(row.turnaroundMinutes) || undefined,
                _rankScore:        row._rankScore || SchedulePanel._routeRank(row),
                _scoredRow:        row
            })
        }
        routes.sort((a, b) => (b._rankScore || 0) - (a._rankScore || 0))
        return {routes, skippedNoDistance}
    }

    static _capacityByBucket(preset) {
        const buckets = preset && preset.factors && preset.factors.rangeBuckets
            || ScheduleFactors.defaultRangeBuckets()
        const byBucket = {}
        for (const key in buckets) byBucket[key] = 0
        for (const wave of (preset && preset.waves || [])) {
            if (wave && wave.archivedAt) continue
            const comp = wave && wave.composition || {}
            for (const key in buckets) {
                byBucket[key] += Math.max(0, Number(comp[key]) || 0)
            }
        }
        let total = 0
        for (const key in byBucket) total += byBucket[key]
        return {byBucket, total}
    }

    static _selectRoutesForPresetCapacity(routes, preset) {
        const buckets = preset && preset.factors && preset.factors.rangeBuckets
            || ScheduleFactors.defaultRangeBuckets()
        const capacity = SchedulePanel._capacityByBucket(preset)
        const used = {}
        for (const key in capacity.byBucket) used[key] = 0
        const selected = []
        let skippedNoCapacity = 0
        let skippedNoBucket = 0
        const seen = new Set()
        for (const route of routes || []) {
            const dest = SchedulePanel._normaliseHub(route && route.destination)
            if (!dest || seen.has(dest)) continue
            const bucket = ScheduleFactors.bucketize(route.distanceNm, buckets)
            if (!bucket) {
                skippedNoBucket++
                continue
            }
            if ((used[bucket] || 0) >= (capacity.byBucket[bucket] || 0)) {
                skippedNoCapacity++
                continue
            }
            used[bucket] = (used[bucket] || 0) + 1
            seen.add(dest)
            selected.push(route)
        }
        return {
            routes: selected,
            skippedNoCapacity,
            skippedNoBucket,
            selectedByBucket: used
        }
    }

    _buildOpenStationsBar() {
        const bar = document.createElement("div")
        bar.className = "as-panel"
        bar.style.marginTop = "12px"

        const title = document.createElement("h4")
        title.innerText = "Open stations from scraped airports"
        bar.append(title)

        const note = document.createElement("p")
        note.style.cssText = "color:#888; font-size:90%; margin:4px 0 10px 0;"
        note.innerText = "Pulls candidates from the demand scraper, FlightsFrom, "
            + "watchlist, and top-routes. Group by country, confirm, and enqueue "
            + "for the Station Automation worker."
        bar.append(note)

        // Live status strip — queue size, active-run progress, last-run summary.
        // Re-render disposes the previous strip so its storage listener doesn't
        // leak into the new mount.
        if (this._statusStrip) { this._statusStrip.dispose(); this._statusStrip = null }
        const stripHost = document.createElement("div")
        stripHost.style.marginBottom = "10px"
        bar.append(stripHost)
        if (this.context.server && this.context.airlineCode) {
            this._statusStrip = new StationAutomationStatusStrip({
                server:      this.context.server,
                airlineCode: this.context.airlineCode,
                container:   stripHost,
                style:       "full",
            })
            this._statusStrip.mount().catch(err => console.warn("[AES status-strip] mount failed", err))
        }

        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "btn btn-primary"
        btn.innerText = "Open stations at scraped airports…"
        btn.addEventListener("click", () => {
            const modal = new OpenStationsModal({
                server:      this.context.server,
                airlineCode: this.context.airlineCode,
                currentHub:  this.context.currentHub || null,
            })
            modal.open()
        })
        bar.append(btn)

        return bar
    }

    _buildHistorySection() {
        const wrap = document.createElement("div")
        wrap.className = "as-panel"
        wrap.style.marginTop = "12px"

        const title = document.createElement("h4")
        title.innerText = "Recent schedules"
        wrap.append(title)

        const list = document.createElement("div")
        list.id = "aes-sm-history"
        wrap.append(list)
        return wrap
    }

    async _refreshHistory() {
        const target = this.root.querySelector("#aes-sm-history")
        if (!target) return
        target.innerHTML = ""
        const ctx = this.context
        if (!ctx.server || !ctx.airlineCode) {
            const p = document.createElement("p")
            p.style.color = "#888"
            p.innerText = "(history requires server + airline context)"
            target.append(p)
            return
        }
        const index = await ScheduleStore.listIndex(ctx.server, ctx.airlineCode)
        if (!index.length) {
            const p = document.createElement("p")
            p.style.color = "#888"
            p.innerText = "No schedules generated yet."
            target.append(p)
            return
        }
        const table = document.createElement("table")
        table.className = "table table-bordered table-striped"
        const head = document.createElement("thead")
        head.innerHTML = "<tr><th>When</th><th>Preset</th><th>Hub</th>"
            + "<th>Flights</th><th>Warnings</th><th></th></tr>"
        const body = document.createElement("tbody")
        for (const entry of index) {
            const tr = document.createElement("tr")
            const when = new Date(entry.generatedAt).toLocaleString()
            // F-9228-302: presetName + hub flow back from user-typed input
            // (Identity → Name field, hub free-text), so innerHTML interpolation
            // is an XSS vector. Build cells with textContent to keep markup escaped.
            const mkCell = (txt) => {
                const td = document.createElement("td")
                td.textContent = txt == null ? "" : String(txt)
                return td
            }
            tr.append(
                mkCell(when),
                mkCell(entry.presetName || "(unnamed)"),
                mkCell(entry.hub || ""),
                mkCell(entry.flightCount),
                mkCell(entry.warningCount)
            )
            const td = document.createElement("td")
            const del = document.createElement("button")
            del.type = "button"
            del.className = "btn btn-default btn-xs"
            del.innerText = "Delete"
            del.addEventListener("click", async () => {
                await ScheduleStore.remove(ctx.server, ctx.airlineCode, entry.scheduleId)
                await this._refreshHistory()
            })
            td.append(del)
            tr.append(td)
            body.append(tr)
        }
        table.append(head, body)
        target.append(table)
    }

    _textField(label, value, onChange, opts) {
        opts = opts || {}
        const wrap = document.createElement("div")
        wrap.className = "form-group"
        const lbl = document.createElement("label")
        lbl.innerText = label
        lbl.style.display = "block"
        const input = document.createElement("input")
        input.type = "text"
        input.className = "form-control"
        input.value = value
        if (opts.maxLength) input.maxLength = opts.maxLength
        if (opts.style) input.setAttribute("style", opts.style)
        input.addEventListener("change", () => onChange(input.value))
        wrap.append(lbl, input)
        return wrap
    }

    _numberInput(value, min, max, onChange) {
        const input = document.createElement("input")
        input.type = "number"
        input.className = "form-control"
        input.value = value
        if (min !== undefined) input.min = min
        if (max !== undefined) input.max = max
        input.addEventListener("change", () => {
            const v = parseInt(input.value, 10)
            onChange(isNaN(v) ? 0 : v)
        })
        return input
    }

    _timeInput(value, onChange) {
        const input = document.createElement("input")
        input.type = "time"
        input.className = "form-control"
        input.style.width = "120px"
        input.style.display = "inline-block"
        input.value = value
        input.addEventListener("change", () => {
            if (SchedulePanel._isValidHHMM(input.value)) {
                onChange(input.value)
            }
        })
        return input
    }

    // ── Active-draft sync (overlay mode only) ──────────────────────────

    /**
     * Subscribe to chrome.storage.onChanged for one storage key. Re-renders
     * (debounced) when that key changes. Both the draft and the persisted
     * Schedule listeners share the same debounce timer so back-to-back
     * writes from the broadcaster don't repaint twice. Idempotent —
     * caller passes a slot name (`draft` or `schedule`) and the listener
     * is stored at `this._<slot>Listener`.
     */
    _attachStorageReloadListener(slot, key, label) {
        const slotKey = "_" + slot + "Listener"
        if (this[slotKey] || !this._isOverlayMode() || !key) return
        const handler = (changes, area) => {
            if (area !== "local") return
            if (!Object.prototype.hasOwnProperty.call(changes, key)) return
            if (this._draftReloadTimer) clearTimeout(this._draftReloadTimer)
            this._draftReloadTimer = setTimeout(() => {
                this._draftReloadTimer = null
                this.render().catch(err =>
                    console.warn("[AES schedule-panel] " + label + " repaint failed", err))
            }, 200)
        }
        try {
            chrome.storage.onChanged.addListener(handler)
            this[slotKey] = handler
        } catch (_) { this[slotKey] = null }
    }

    _attachDraftListener() {
        this._attachStorageReloadListener("draft",
            AesAfpActiveDraftStore._key(this.context.server, this.context.aircraftId),
            "draft")
    }

    _attachScheduleListener() {
        if (typeof AesAfpScheduleStore === "undefined") return
        this._attachStorageReloadListener("schedule",
            AesAfpScheduleStore._key(this.context.server, this.context.aircraftId),
            "schedule")
    }

    /**
     * Track 7 slice 7f — render the current-vs-proposed diff summary.
     * Compares persisted schedule legs (current state in AS) against the
     * draft's flights (proposed by the wave-applier) using the slice-6b
     * matcher. Returns null when either side is missing — the consumer
     * just doesn't append the row.
     */
    _buildScheduleDiffSummary() {
        if (typeof AesAfpScheduleDiff === "undefined") return null
        if (!this.schedule || !Array.isArray(this.schedule.legs)) return null
        const proposed = (this.draft && Array.isArray(this.draft.flights))
            ? this.draft.flights : []
        if (!this.schedule.legs.length && !proposed.length) return null
        // F-9228-305: schedule.legs and draft.flights are reloaded from
        // chrome.storage on every render(), so reference-equality cache
        // checks never hit. Drop the cache — the compare is cheap and
        // accumulating dead memo state was misleading.
        let diff
        const diffOpts = (this._afpSettings && this._afpSettings.autoScheduler
            && this._afpSettings.autoScheduler.diff) || null
        try { diff = AesAfpScheduleDiff.compare(this.schedule.legs, proposed, diffOpts) }
        catch (e) { console.warn("[AES schedule-panel] diff threw", e); return null }

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin:0 0 10px 0;padding:6px 10px;border:1px solid #d4d4d8;"
            + "border-radius:4px;background:#f9fafb;font-size:12px;display:flex;"
            + "align-items:center;gap:12px;flex-wrap:wrap;"
        const lbl = document.createElement("strong")
        lbl.textContent = "Current vs Proposed:"
        wrap.append(lbl)

        const ageMs = AesAfpScheduleStore.getStaleness(this.schedule)
        const fresh = AesAfpScheduleStore.isFresh(this.schedule, 5 * 60 * 1000)
        const age = isFinite(ageMs) ? this._sageLabel(ageMs) : "?"

        const mkPill = (label, count, color, tip) => {
            const span = document.createElement("span")
            span.title = tip
            span.style.cssText = "padding:2px 8px;border-radius:10px;font-weight:600;"
                + "background:" + color + ";color:#fff;"
            span.textContent = label + " " + count
            return span
        }
        wrap.append(mkPill("keep",   diff.keep.length,   "#10803a",
            "Legs in both — current schedule already matches proposal."))
        wrap.append(mkPill("delete", diff.delete.length, "#b91c1c",
            "Legs that will be removed when the proposal is applied."))
        wrap.append(mkPill("add",    diff.add.length,    "#1f4cad",
            "New legs the proposal will create."))
        // The 7e locked bucket may or may not be present depending on the
        // diff engine version. Render only when populated.
        if (Array.isArray(diff.locked) && diff.locked.length) {
            wrap.append(mkPill("locked", diff.locked.length, "#a16207",
                "AS-locked legs we won't touch — surfaced separately so apply-batch skips them."))
        }
        const meta = document.createElement("span")
        meta.style.cssText = "color:" + (fresh ? "#10803a" : "#a16207") + ";font-size:90%;margin-left:auto;"
        meta.textContent = "schedule scraped " + age + " ago" + (fresh ? "" : " · stale")
        wrap.append(meta)

        // Slice 8c — handoff to AFP page where the full apply-batch lives
        // (with the slice 6d locked-confirm pre-flight). Schedule-panel
        // only has per-leg Apply buttons; users wanting to apply N legs
        // at once need to land on the AFP page. We deep-link via the
        // shared handoff store so they don't re-pick the preset.
        if (this._isOverlayMode()
                && proposed.length > 1
                && typeof window.AesHandoffStore !== "undefined") {
            const handoffBtn = document.createElement("button")
            handoffBtn.type = "button"
            handoffBtn.textContent = "Apply all in AFP →"
            handoffBtn.title = "Open this aircraft's Flight Plan page with the wave preset"
                + " preloaded so you can run the full apply-batch (with locked-leg"
                + " confirmation) instead of clicking Apply per leg."
            handoffBtn.style.cssText = "background:#7c2d12;color:#fed7aa;"
                + "border:1px solid #9a3412;border-radius:3px;padding:2px 8px;"
                + "font-size:11px;font-weight:600;cursor:pointer;margin-left:6px;"
            handoffBtn.addEventListener("click", () => this._handoffToAfp())
            wrap.append(handoffBtn)
        }
        return wrap
    }

    /**
     * Slice 8c — write a wave-designer handoff record + open the AFP
     * page in a new tab. The wave-applier on the other side consumes
     * the handoff, pre-selects the preset, and auto-Generates so the
     * user lands ready to apply-batch.
     */
    async _handoffToAfp() {
        if (!this._isOverlayMode()) return
        const ctx = this.context || {}
        const aircraftId = ctx.aircraftId
        // F-9228-301: this._presets was never assigned anywhere on the panel —
        // the fallback evaluated to null. Use the panel's currently-edited
        // preset (this.editingId), which is the user's actual selection,
        // and fall back to the first preset in the loaded block.
        const presetId = (this.draft && this.draft.presetId)
            || this.editingId
            || (this.block && this.block.presets && this.block.presets[0] && this.block.presets[0].id)
            || null
        if (!aircraftId || !presetId) {
            if (typeof RouteAssistantToast !== "undefined" && RouteAssistantToast.warn) {
                try { RouteAssistantToast.warn("Cannot hand off: missing aircraftId or presetId.") }
                catch (_) { /* noop */ }
            }
            return
        }
        try {
            await window.AesHandoffStore.set({
                aircraftId: aircraftId,
                presetId:   typeof presetId === "string" ? presetId : presetId.id,
                hub:        (this.draft && this.draft.hub) || ctx.hub || "",
                generatedAt: Date.now(),
                source:     "schedule-panel-overlay"
            })
        } catch (e) {
            console.warn("[AES schedule-panel] handoff write failed", e)
            return
        }
        const url = "/app/fleets/aircraft/" + encodeURIComponent(aircraftId) + "/0"
        try { window.open(url, "_blank", "noopener") }
        catch (e) { window.location.href = url }
    }

    _sageLabel(ms) {
        if (!isFinite(ms) || ms < 0) return "?"
        const s = Math.floor(ms / 1000)
        if (s < 60)   return s + "s"
        const m = Math.floor(s / 60)
        if (m < 60)   return m + "m"
        const h = Math.floor(m / 60)
        if (h < 24)   return h + "h"
        const d = Math.floor(h / 24)
        return d + "d"
    }

    _buildDraftLegsSection() {
        const wrap = document.createElement("div")
        wrap.className = "as-panel"
        wrap.style.marginTop = "12px"

        const title = document.createElement("h4")
        title.innerText = "Schedule legs"
        wrap.append(title)

        const note = document.createElement("p")
        note.style.cssText = "color:#888; font-size:90%; margin:4px 0 10px 0;"
        note.innerText = "Edits, applies and dismisses sync live with the per-aircraft "
            + "Flight Plan page (P button). Apply opens that page in a hidden tab and "
            + "submits the leg; status updates here when it completes."
        wrap.append(note)

        // Track 7 slice 7f — show keep/delete/add (and locked when 7e diff
        // is loaded) counts so the user sees at a glance how the proposal
        // differs from what AS currently has scheduled. Suppressed when no
        // schedule is cached yet (no AFP page visit).
        const diffSummary = this._buildScheduleDiffSummary()
        if (diffSummary) wrap.append(diffSummary)

        const flights = (this.draft && Array.isArray(this.draft.flights)) ? this.draft.flights : []
        if (!flights.length) {
            const empty = document.createElement("p")
            empty.style.color = "#888"
            empty.innerText = "No flight legs yet. Generate a wave plan on the per-aircraft "
                + "Flight Plan page to populate this list, or generate above to set the "
                + "preset and build the foundation."
            wrap.append(empty)
            return wrap
        }

        const table = document.createElement("table")
        table.className = "table table-bordered table-condensed"
        table.style.cssText = "margin-bottom:0; font-size:12px;"
        const thead = document.createElement("thead")
        thead.innerHTML = "<tr>"
            + "<th style=\"width:48px;\">Wave</th>"
            + "<th style=\"width:46px;\">Dir</th>"
            + "<th>Origin</th>"
            + "<th>Dest</th>"
            + "<th style=\"width:74px;\">Flight #</th>"
            + "<th style=\"width:96px;\">Dep time</th>"
            + "<th style=\"width:84px;\">Price %</th>"
            + "<th style=\"width:70px;\">Status</th>"
            + "<th style=\"width:140px;\"></th>"
            + "</tr>"
        const tbody = document.createElement("tbody")
        for (const f of flights) tbody.append(this._buildLegRow(f))
        table.append(thead, tbody)
        wrap.append(table)
        return wrap
    }

    _buildLegRow(flight) {
        return SchedulePanel.buildLegRow(flight, {
            perLegEdits:   (this.draft && this.draft.perLegEdits)   || {},
            appliedLegs:   (this.draft && this.draft.appliedLegs)   || {},
            dismissedLegs: (this.draft && this.draft.dismissedLegs) || {}
        }, {
            transient:           this._legStatusBySeq,
            onLegEdit:           (seq, patch) => this._patchLegEdit(seq, patch),
            onLegApply:          (seq)        => this._onLegApply(seq),
            onLegDismissToggle:  (seq, makeDismissed) => this._onLegDismissToggle(seq, makeDismissed)
        })
    }

    /**
     * Pure leg-row builder. Lifted out of `_buildLegRow` so Fleet Command
     * Center can render the same per-leg editor inline without depending
     * on SchedulePanel's overlay-mode state machine.
     *
     * @param {object} flight  — flight envelope (seq, direction, waveLabel, origin, destination, depTimeLocal, pricePct)
     * @param {object} state   — {perLegEdits, appliedLegs, dismissedLegs} maps from AesAfpActiveDraftStore
     * @param {object} opts
     *   - opts.transient                  optional {[seq]: "submitting"|"error"} for status pill + apply-button disable
     *   - opts.onLegEdit(seq, patch)      called when destination/time/price changes
     *   - opts.onLegApply(seq)            called when Apply / Re-apply clicked
     *   - opts.onLegDismissToggle(seq, makeDismissed)  called when Dismiss / Restore clicked
     */
    static buildLegRow(flight, state, opts) {
        const o = opts || {}
        const s = state || {}
        const tr = document.createElement("tr")
        const seq = flight.seq
        const overlay = (s.perLegEdits || {})[seq] || {}
        const eff = Object.assign({}, flight, overlay)
        const applied   = !!(s.appliedLegs   || {})[seq]
        const dismissed = !!(s.dismissedLegs || {})[seq]
        const transient = (o.transient && o.transient[seq]) || null

        if (dismissed) {
            tr.style.cssText = "opacity:0.45;"
        } else if (applied) {
            tr.style.cssText = "background:#eaf6ea;"
        }

        const td = (txt) => { const c = document.createElement("td"); c.textContent = txt; return c }
        tr.append(td(eff.waveLabel || eff.waveId || "—"))

        const dir = (flight.direction || "").slice(0, 3)
        const dirCell = td(dir)
        dirCell.style.cssText = (flight.direction === "inbound")
            ? "color:#10803a;font-weight:600;"
            : "color:#1f4cad;font-weight:600;"
        tr.append(dirCell)

        tr.append(td(eff.origin || "—"))

        // Destination — editable text input.
        const destCell = document.createElement("td")
        const destInput = SchedulePanel._mkLegTextInput(eff.destination || "", (v) => {
            if (typeof o.onLegEdit !== "function") return
            const norm = String(v || "").toUpperCase().trim()
            return o.onLegEdit(seq, {destination: norm || null})
        }, {maxLength: 4, style: "text-transform:uppercase;width:64px;"})
        destCell.append(destInput)
        tr.append(destCell)

        // Flight number — optional 1..4 digit suffix; blank lets AS assign.
        const fnCell = document.createElement("td")
        const fnInput = SchedulePanel._mkLegTextInput(
            eff.flightNumberText || SchedulePanel._flightNumberTextFrom(eff.flightNumber || eff.flightCode || ""),
            (v) => {
                if (typeof o.onLegEdit !== "function") return
                const cleaned = SchedulePanel._cleanFlightNumberText(v)
                return o.onLegEdit(seq, {flightNumberText: cleaned || null})
            },
            {maxLength: 4, style: "width:58px;"})
        fnInput.inputMode = "numeric"
        fnInput.addEventListener("input", () => {
            fnInput.value = SchedulePanel._cleanFlightNumberText(fnInput.value)
        })
        fnCell.append(fnInput)
        tr.append(fnCell)

        // Departure time — HH:MM input.
        const timeCell = document.createElement("td")
        const timeInput = document.createElement("input")
        timeInput.type = "time"
        timeInput.className = "form-control input-sm"
        timeInput.style.cssText = "width:90px;"
        timeInput.value = eff.depTimeLocal || ""
        timeInput.addEventListener("change", () => {
            if (typeof o.onLegEdit !== "function") return
            const v = timeInput.value
            if (SchedulePanel._isValidHHMM(v)) {
                o.onLegEdit(seq, {depTimeLocal: v})
            }
        })
        timeCell.append(timeInput)
        tr.append(timeCell)

        // Price % — numeric.
        const priceCell = document.createElement("td")
        const priceInput = document.createElement("input")
        priceInput.type = "number"
        priceInput.className = "form-control input-sm"
        priceInput.style.cssText = "width:72px;"
        priceInput.value = (typeof eff.pricePct === "number") ? eff.pricePct : 100
        priceInput.min = 0
        priceInput.max = 200
        priceInput.addEventListener("change", () => {
            if (typeof o.onLegEdit !== "function") return
            const v = parseInt(priceInput.value, 10)
            o.onLegEdit(seq, {pricePct: isNaN(v) ? 100 : v})
        })
        priceCell.append(priceInput)
        tr.append(priceCell)

        // Status pill.
        const statusCell = document.createElement("td")
        statusCell.style.cssText = "font-size:11px;"
        if (transient === "submitting") {
            statusCell.innerHTML = '<span style="color:#1f4cad;">submitting…</span>'
        } else if (transient === "error") {
            statusCell.innerHTML = '<span style="color:#a33;" title="Click Apply to retry.">error</span>'
        } else if (applied) {
            statusCell.innerHTML = '<span style="color:#10803a;">applied</span>'
        } else if (dismissed) {
            statusCell.innerHTML = '<span style="color:#888;">dismissed</span>'
        } else {
            statusCell.innerHTML = '<span style="color:#888;">pending</span>'
        }
        tr.append(statusCell)

        // Actions: Apply, Dismiss / Restore.
        const actionsCell = document.createElement("td")
        actionsCell.style.cssText = "white-space:nowrap;"
        if (!dismissed) {
            const applyBtn = document.createElement("button")
            applyBtn.type = "button"
            applyBtn.className = "btn btn-primary btn-xs"
            applyBtn.textContent = applied ? "Re-apply" : "Apply"
            applyBtn.title = "Open the per-aircraft Flight Plan page in a hidden tab and submit this leg."
            applyBtn.disabled = (transient === "submitting")
            if (typeof o.onLegApply === "function") {
                applyBtn.addEventListener("click", () => o.onLegApply(seq))
            } else {
                applyBtn.disabled = true
                applyBtn.title = "Apply requires AFP submit-bridge — open this aircraft's Flight Plan page."
            }
            actionsCell.append(applyBtn)
            actionsCell.append(document.createTextNode(" "))
        }
        const dismissBtn = document.createElement("button")
        dismissBtn.type = "button"
        dismissBtn.className = "btn btn-default btn-xs"
        dismissBtn.textContent = dismissed ? "Restore" : "Dismiss"
        if (typeof o.onLegDismissToggle === "function") {
            dismissBtn.addEventListener("click", () => o.onLegDismissToggle(seq, !dismissed))
        } else {
            dismissBtn.disabled = true
        }
        actionsCell.append(dismissBtn)
        tr.append(actionsCell)

        return tr
    }

    /** Internal helper — pure text input wrapper, used by the static row builder. */
    static _mkLegTextInput(value, onChange, opts) {
        opts = opts || {}
        const input = document.createElement("input")
        input.type = "text"
        input.className = "form-control input-sm"
        input.value = value
        if (opts.maxLength) input.maxLength = opts.maxLength
        if (opts.style) input.setAttribute("style", opts.style)
        input.addEventListener("change", () => onChange(input.value))
        return input
    }

    static _cleanFlightNumberText(value) {
        return String(value == null ? "" : value).replace(/[^0-9]/g, "").slice(0, 4)
    }

    static _flightNumberTextFrom(value) {
        const m = String(value || "").match(/(\d{1,4})\s*$/)
        return m ? m[1] : ""
    }

    async _patchLegEdit(seq, patch) {
        if (!this._isOverlayMode()) return
        await AesAfpActiveDraftStore.setEdit(
            this.context.server, this.context.aircraftId, seq, patch)
    }

    async _onLegDismissToggle(seq, makeDismissed) {
        if (!this._isOverlayMode()) return
        await AesAfpActiveDraftStore.setDismissed(
            this.context.server, this.context.aircraftId, seq,
            makeDismissed ? Date.now() : null)
    }

    /**
     * Submit one leg via the background-tab bridge. The wave-applier on the
     * AFP page itself uses a different code path (in-page bus pre-fill,
     * user clicks AS Submit) — this entry point is overlay-only.
     */
    async _onLegApply(seq) {
        if (!this._isOverlayMode()) return
        const record = this.draft || {}
        const eff = AesAfpActiveDraftStore.effectiveLeg(record, seq)
        if (!eff) return

        const inbound = (eff.direction === "inbound")
        const origin = inbound
            ? (eff.origin || (record.hub || this.context.hub))
            : (record.hub || this.context.hub || eff.origin)
        const destination = inbound
            ? (record.hub || this.context.hub || eff.origin)
            : eff.destination

        const leg = {
            origin:       origin || null,
            destination:  destination || null,
            depTimeLocal: eff.depTimeLocal || null,
            depTime:      eff.depTimeLocal || null,
            pricePct:     (typeof eff.pricePct === "number") ? eff.pricePct : 100,
            service:      eff.service || null,
            flightNumberText: SchedulePanel._cleanFlightNumberText(eff.flightNumberText || "")
        }

        this._legStatusBySeq[seq] = "submitting"
        await this.render()

        const resp = await AesAfpSubmitBridge.submitLegInBackground({
            server:     this.context.server,
            aircraftId: this.context.aircraftId,
            hub:        record.hub || this.context.hub || null,
            leg
        })

        if (resp && resp.ok) {
            delete this._legStatusBySeq[seq]
            await AesAfpActiveDraftStore.setApplied(
                this.context.server, this.context.aircraftId, seq, Date.now())
            // setApplied triggers storage.onChanged → render() via listener.
        } else {
            console.warn("[AES schedule-panel] leg apply failed", resp)
            this._legStatusBySeq[seq] = "error"
            await this.render()
        }
    }
}

if (typeof window !== "undefined") {
    window.SchedulePanel = SchedulePanel
}
