/**
 * Dashboard UI for schedule management. Owns the entire panel — the
 * dashboard's displayScheduleManagement() function only needs to construct
 * one of these and call render().
 *
 * Pure DOM (no jQuery) to match the newer module style. The layout is two
 * columns: a preset list/editor on the left, factor + composition controls
 * on the right, plus a build/history strip below.
 *
 * Foundation scope: presets CRUD + editor + a "Generate" button that runs
 * the builder against an empty route list (so users can validate their
 * preset structure end-to-end). Wiring the builder up to actual AS routes
 * lives in a follow-up.
 */
class SchedulePanel {
    constructor(rootEl, context) {
        this.root = rootEl
        this.context = context || {}
        this.block = null
        this.editingId = null
    }

    async render() {
        this.block = await SchedulePresets.load()
        this.editingId = this.block.defaultPresetId
            || this.block.presets[0]?.id
            || null

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
        this.root.append(this._buildHistorySection())

        await this._refreshHistory()
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
            await SchedulePresets.update(preset.id, {name: v || preset.name})
            await this.render()
        }))
        wrap.append(this._textField("Hub (IATA, e.g. FRA)", preset.hub || "", async v => {
            await SchedulePresets.update(preset.id, {hub: (v || "").toUpperCase()})
        }, {maxLength: 4, style: "text-transform:uppercase"}))
        wrap.append(this._textField("Notes", preset.notes || "", async v => {
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
            const next = Object.assign({}, f, {[key]: value})
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
            await update("slotWindow", Object.assign({}, f.slotWindow, {start: v}))
        })
        const slotEnd = this._timeInput(f.slotWindow.end, async v => {
            await update("slotWindow", Object.assign({}, f.slotWindow, {end: v}))
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
            const next = preset.waves.slice()
            next[idx] = Object.assign({}, wave, {label: labelInput.value || wave.label})
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
            const next = preset.waves.slice()
            const updatedWindow = Object.assign({}, wave[which], {[key]: value})
            next[idx] = Object.assign({}, wave, {[which]: updatedWindow})
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
                const next = preset.waves.slice()
                const comp = Object.assign({}, wave.composition, {[bucket]: v})
                next[idx] = Object.assign({}, wave, {composition: comp})
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
            const preset = this.block.presets.find(p => p.id === this.editingId)
            if (!preset) { status.innerText = "Select a preset first."; return }
            const builder = new ScheduleBuilder(preset, this.context)
            const errors = builder.validatePreset()
            if (errors.length) {
                status.innerHTML = '<span class="bad">Preset issues:</span> ' + errors.join("; ")
                return
            }
            status.innerText = "Generating…"
            const record = builder.build([])
            await ScheduleStore.save(record)
            await SchedulePresets.save({lastBuildId: record.scheduleId})
            const flightCount = record.flights.length
            const warnCount = record.warnings.length
            status.innerHTML = `<span class="good">Saved schedule ${record.scheduleId}</span> — ${flightCount} flights, ${warnCount} warning(s)`
            await this._refreshHistory()
        })

        bar.append(buildBtn, status)

        const note = document.createElement("p")
        note.style.cssText = "color:#888; font-size:90%; margin-top:8px;"
        note.innerText = "Foundation build: routes are not yet pulled from your AS network. "
            + "The builder runs end-to-end against an empty route set so you can verify preset structure. "
            + "Route ingestion ships in a follow-up."
        bar.append(note)

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
            tr.innerHTML = `<td>${when}</td>
                <td>${entry.presetName || "(unnamed)"}</td>
                <td>${entry.hub || ""}</td>
                <td>${entry.flightCount}</td>
                <td>${entry.warningCount}</td>`
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
            if (ScheduleFactors.parseHHMM(input.value)) {
                onChange(input.value)
            }
        })
        return input
    }
}
