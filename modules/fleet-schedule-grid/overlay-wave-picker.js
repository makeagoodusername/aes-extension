"use strict"

/**
 * Fleet Schedule Grid — wave picker (Side-rail "Waves" tab).
 *
 * Lists the user's saved `SchedulePresets` grouped by hub. Clicking a wave
 * inside a preset adds it as an overlay layer (cap 5). Active layers show
 * up at the top with name, color swatch, opacity slider, time-shift readout,
 * and a remove button.
 *
 * No mutation of the underlying preset — all state goes into
 * `FleetScheduleGridWaveLayoutStore`. Clicking the same wave twice removes
 * its layer (toggle).
 *
 * `onChange` callback fires after every store mutation so the panel can
 * repaint the grid's wave bands without re-rendering the picker.
 */
class FleetScheduleGridWavePicker {

    /**
     * Stable distinct color palette. Bone-skin friendly hues, picked so
     * pairwise overlap under mix-blend-mode: multiply still reads clearly.
     */
    static PALETTE = [
        "hsl(202,72%,72%)",   // sky blue
        "hsl(338,68%,72%)",   // rose
        "hsl(122,52%,68%)",   // moss
        "hsl(38,82%,68%)",    // amber
        "hsl(266,58%,72%)",   // violet
        "hsl(15,72%,68%)",    // rust
        "hsl(180,52%,62%)",   // teal
        "hsl(48,72%,62%)"     // ochre
    ]

    /**
     * @param {object} opts
     *   - server, airlineCode
     *   - currentHub: hub IATA to default-expand (best guess: most common in fleet)
     *   - onChange: () => void  // fires after upsertLayer / removeLayer / updateLayer
     */
    constructor(opts) {
        const o = opts || {}
        this.server      = o.server || ""
        this.airlineCode = o.airlineCode || ""
        this.currentHub  = (o.currentHub || "").toUpperCase()
        this.onChange    = typeof o.onChange === "function" ? o.onChange : () => {}
        this.paneEl      = null
        this._presets    = []
        this._block      = {layers: [], fadeRatio: 0.25}
    }

    /** Build the pane element (called by the panel before mounting in side-rail). */
    buildPane() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const pane = document.createElement("div")
        pane.style.cssText = "padding:10px 12px;display:flex;flex-direction:column;gap:10px;"

        const activeSection = document.createElement("div")
        activeSection.dataset.section = "active"
        const sourceSection = document.createElement("div")
        sourceSection.dataset.section = "source"

        pane.append(activeSection, sourceSection)
        this.paneEl = pane
        return pane
    }

    /** Refresh both presets list and active layer block; rebuild DOM. */
    async refresh() {
        if (!this.paneEl) return
        this._presets = []
        if (typeof SchedulePresets !== "undefined") {
            try {
                const block = await SchedulePresets.load()
                this._presets = (block && Array.isArray(block.presets)) ? block.presets : []
            } catch (_) {}
        }
        if (typeof FleetScheduleGridWaveLayoutStore !== "undefined") {
            try { this._block = await FleetScheduleGridWaveLayoutStore.load(this.server, this.airlineCode) }
            catch (_) {}
        }
        this._render()
    }

    _render() {
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const activeSection = this.paneEl.querySelector("[data-section=active]")
        const sourceSection = this.paneEl.querySelector("[data-section=source]")
        if (!activeSection || !sourceSection) return
        activeSection.innerHTML = ""
        sourceSection.innerHTML = ""

        // ── Active layers ──────────────────────────────────────────────
        const activeHeader = document.createElement("div")
        activeHeader.style.cssText = this._sectionTitleCss(T)
        activeHeader.textContent = "Active layers (" + this._block.layers.length + "/" + (typeof FleetScheduleGridWaveLayoutStore !== "undefined" ? FleetScheduleGridWaveLayoutStore.MAX_LAYERS : 5) + ")"
        activeSection.appendChild(activeHeader)

        if (!this._block.layers.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "font-style:italic;padding:6px 0 0 0;"
            empty.textContent = "No active layers — add one from the list below."
            activeSection.appendChild(empty)
        } else {
            for (const layer of this._block.layers) {
                activeSection.appendChild(this._renderActiveLayerChip(layer, T))
            }
        }

        // ── Source list ────────────────────────────────────────────────
        const sourceHeader = document.createElement("div")
        sourceHeader.style.cssText = this._sectionTitleCss(T) + "margin-top:14px;"
        sourceHeader.textContent = "Wave templates"
        sourceSection.appendChild(sourceHeader)

        if (!this._presets.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "font-style:italic;padding:6px 0;"
            empty.innerHTML = "No saved presets yet — open Route Assistant and create a wave preset for one of your hubs."
            sourceSection.appendChild(empty)
            return
        }

        const groups = new Map() // hub -> Preset[]
        for (const p of this._presets) {
            const hub = (p.hub || "").toUpperCase() || "—"
            if (!groups.has(hub)) groups.set(hub, [])
            groups.get(hub).push(p)
        }
        const hubsSorted = Array.from(groups.keys()).sort((a, b) => {
            if (a === this.currentHub) return -1
            if (b === this.currentHub) return 1
            return a.localeCompare(b)
        })

        for (const hub of hubsSorted) {
            const group = document.createElement("div")
            group.style.cssText = "margin-top:8px;"
            const hubLabel = document.createElement("div")
            hubLabel.style.cssText = "font-size:11px;font-weight:700;letter-spacing:0.05em;"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "padding:4px 6px;background:" + (T ? T.color.bone3 : "#E0DAC8") + ";"
                + "border-left:3px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
            hubLabel.textContent = hub === "—" ? "(no hub)" : hub
            group.appendChild(hubLabel)
            for (const preset of groups.get(hub)) {
                group.appendChild(this._renderPresetCard(preset, T))
            }
            sourceSection.appendChild(group)
        }
    }

    _sectionTitleCss(T) {
        return "font-size:10px;font-weight:700;letter-spacing:0.08em;"
             + "text-transform:uppercase;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
             + "padding-bottom:4px;border-bottom:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
    }

    _renderActiveLayerChip(layer, T) {
        const card = document.createElement("div")
        card.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:6px;"
            + "padding:6px 8px;background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "border-left:4px solid " + layer.color + ";"

        // Header row: swatch, name, remove.
        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:6px;"

        const swatch = document.createElement("div")
        swatch.style.cssText = "width:14px;height:14px;flex:0 0 14px;"
            + "background:" + layer.color + ";border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "cursor:pointer;"
        swatch.title = "Click to cycle color"
        swatch.addEventListener("click", () => this._cycleColor(layer))

        const name = document.createElement("div")
        name.style.cssText = "flex:1 1 auto;font-size:11px;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        name.textContent = layer.name

        const remove = document.createElement("button")
        remove.type = "button"
        remove.style.cssText = "padding:1px 6px;cursor:pointer;font-size:10px;"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:transparent;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        remove.textContent = "×"
        remove.title = "Remove this layer"
        remove.addEventListener("click", () => this._removeLayer(layer.id))

        head.append(swatch, name, remove)
        card.appendChild(head)

        // Opacity slider row.
        const oprow = document.createElement("div")
        oprow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;"
            + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        const oplabel = document.createElement("span")
        oplabel.textContent = "OPACITY"
        oplabel.style.cssText = "letter-spacing:0.05em;flex:0 0 auto;font-weight:600;"
        const slider = document.createElement("input")
        slider.type = "range"
        slider.min = "5"; slider.max = "100"; slider.step = "5"
        slider.value = String(Math.round((layer.opacity || 0.35) * 100))
        slider.style.cssText = "flex:1 1 auto;"
        const opval = document.createElement("span")
        opval.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";flex:0 0 30px;text-align:right;"
        opval.textContent = slider.value + "%"
        slider.addEventListener("input", () => { opval.textContent = slider.value + "%" })
        slider.addEventListener("change", () => {
            this._updateLayer(layer.id, {opacity: (+slider.value) / 100})
        })
        oprow.append(oplabel, slider, opval)
        card.appendChild(oprow)

        // Shift readout row.
        const shiftRow = document.createElement("div")
        shiftRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;"
            + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        const totalShift = layer.timeShiftMin || 0
        const arrShift   = layer.arrShiftMin  || 0
        const depShift   = layer.depShiftMin  || 0
        const fmt = (m) => (m === 0 ? "0" : (m > 0 ? "+" + m : String(m))) + "m"
        let txt = "shift " + fmt(totalShift)
        if (arrShift) txt += " · A " + fmt(arrShift)
        if (depShift) txt += " · D " + fmt(depShift)
        shiftRow.textContent = txt
        const reset = document.createElement("button")
        reset.type = "button"
        reset.textContent = "reset"
        reset.style.cssText = "padding:1px 6px;cursor:pointer;font-size:10px;margin-left:auto;"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "background:transparent;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
        reset.disabled = (totalShift === 0 && arrShift === 0 && depShift === 0)
        if (reset.disabled) reset.style.opacity = "0.4"
        reset.addEventListener("click", () => {
            this._updateLayer(layer.id, {timeShiftMin: 0, arrShiftMin: 0, depShiftMin: 0})
        })
        shiftRow.appendChild(reset)
        card.appendChild(shiftRow)

        // Day toggles row (compact).
        const dayRow = document.createElement("div")
        dayRow.style.cssText = "display:flex;gap:2px;font-size:10px;"
        const DN = ["M", "T", "W", "T", "F", "S", "S"]
        for (let i = 0; i < 7; i++) {
            const b = document.createElement("button")
            b.type = "button"
            b.textContent = DN[i]
            b.title = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"][i]
            const on = !!layer.days[i]
            b.style.cssText = "flex:1 1 0;padding:2px 0;cursor:pointer;"
                + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "background:" + (on ? layer.color : "transparent") + ";"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
                + "font-weight:" + (on ? "700" : "400") + ";"
                + "opacity:" + (on ? "1" : "0.45") + ";"
            b.addEventListener("click", () => {
                const days = layer.days.slice()
                days[i] = !days[i]
                this._updateLayer(layer.id, {days})
            })
            dayRow.appendChild(b)
        }
        card.appendChild(dayRow)

        return card
    }

    _renderPresetCard(preset, T) {
        const card = document.createElement("div")
        card.style.cssText = "padding:6px 8px;margin-top:4px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
        const name = document.createElement("div")
        name.style.cssText = "font-size:11px;font-weight:700;color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        name.textContent = preset.name
        card.appendChild(name)

        const waves = (Array.isArray(preset.waves) ? preset.waves : [])
        if (!waves.length) {
            const empty = document.createElement("div")
            empty.style.cssText = "font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";font-style:italic;"
            empty.textContent = "(no waves defined)"
            card.appendChild(empty)
            return card
        }

        for (const wave of waves) {
            const isActive = !!this._block.layers.find(l => l.presetId === preset.id && l.waveId === wave.id)
            const row = document.createElement("button")
            row.type = "button"
            row.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;"
                + "padding:3px 4px;margin-top:2px;cursor:pointer;"
                + "background:" + (isActive ? (T ? T.color.bone3 : "#E0DAC8") : "transparent") + ";"
                + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "color:" + (T ? T.color.oxide : "#2B2520") + ";text-align:left;"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";font-size:10px;"
            const lbl = document.createElement("span")
            lbl.style.cssText = "flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            lbl.textContent = wave.label || "wave"
            const arr = (wave.arrivalWindow && wave.arrivalWindow.start) || "??:??"
            const dep = (wave.departureWindow && wave.departureWindow.start) || "??:??"
            const times = document.createElement("span")
            times.style.cssText = "color:" + (T ? T.color.oxide2 : "#4A413B") + ";flex:0 0 auto;"
            times.textContent = "A " + arr + " · D " + dep
            const flag = document.createElement("span")
            flag.style.cssText = "flex:0 0 auto;font-weight:700;color:" + (isActive ? (T ? T.color.rust : "#B8472A") : (T ? T.color.slate : "#7A6F66")) + ";"
            flag.textContent = isActive ? "✓ on" : "+ add"
            row.append(lbl, times, flag)
            row.title = isActive ? "Click to remove this layer" : "Click to add as overlay layer"
            row.addEventListener("click", () => this._togglePresetWave(preset, wave))
            card.appendChild(row)
        }

        return card
    }

    async _togglePresetWave(preset, wave) {
        const existing = this._block.layers.find(l => l.presetId === preset.id && l.waveId === wave.id)
        if (existing) {
            await this._removeLayer(existing.id)
            return
        }
        if (this._block.layers.length >= (typeof FleetScheduleGridWaveLayoutStore !== "undefined" ? FleetScheduleGridWaveLayoutStore.MAX_LAYERS : 5)) {
            this._toast("Layer cap reached — remove one first.")
            return
        }
        const color = FleetScheduleGridWavePicker.PALETTE[
            this._block.layers.length % FleetScheduleGridWavePicker.PALETTE.length
        ]
        const layer = {
            id:           "L-" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
            presetId:     preset.id,
            waveId:       wave.id,
            hub:          (preset.hub || "").toUpperCase(),
            name:         preset.name + " — " + (wave.label || "wave"),
            color,
            opacity:      0.35,
            timeShiftMin: 0,
            arrShiftMin:  0,
            depShiftMin:  0,
            days:         [true, true, true, true, true, true, true],
            arrivalWindow:   wave.arrivalWindow   ? {start: wave.arrivalWindow.start,   end: wave.arrivalWindow.end}   : null,
            departureWindow: wave.departureWindow ? {start: wave.departureWindow.start, end: wave.departureWindow.end} : null,
            addedAt: Date.now()
        }
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        const next = await FleetScheduleGridWaveLayoutStore.upsertLayer(this.server, this.airlineCode, layer)
        if (next) { this._block = next; this._render(); this.onChange() }
    }

    async _removeLayer(layerId) {
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        const next = await FleetScheduleGridWaveLayoutStore.removeLayer(this.server, this.airlineCode, layerId)
        if (next) { this._block = next; this._render(); this.onChange() }
    }

    async _updateLayer(layerId, fields) {
        const layer = this._block.layers.find(l => l.id === layerId)
        if (!layer) return
        const merged = Object.assign({}, layer, fields)
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        const next = await FleetScheduleGridWaveLayoutStore.upsertLayer(this.server, this.airlineCode, merged)
        if (next) { this._block = next; this._render(); this.onChange() }
    }

    async _cycleColor(layer) {
        const idx = FleetScheduleGridWavePicker.PALETTE.indexOf(layer.color)
        const nextIdx = (idx + 1) % FleetScheduleGridWavePicker.PALETTE.length
        await this._updateLayer(layer.id, {color: FleetScheduleGridWavePicker.PALETTE[nextIdx]})
    }

    _toast(msg) {
        if (typeof RouteAssistantToastHost !== "undefined" && typeof RouteAssistantToastHost.show === "function") {
            try { RouteAssistantToastHost.show(msg, "warn") } catch (_) {}
            return
        }
        console.warn("[AES FSG]", msg)
    }

    /** Public read of current layers — called by the panel during repaint. */
    getLayers() { return this._block.layers.slice() }
    getFadeRatio() { return this._block.fadeRatio }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridWavePicker = FleetScheduleGridWavePicker
}
