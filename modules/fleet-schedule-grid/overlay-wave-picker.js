"use strict"

/**
 * Fleet Schedule Grid — Hub Plan Workbench (side-rail "Waves" tab).
 *
 * Reframes the panel from "layer overlay manager" into "hub plan
 * workbench". Each hub gets ONE Active plan — the one that drives the
 * auto-scheduler — plus up to 2 Comparison overlays for what-if
 * exploration. Other hubs collapse to a one-line summary.
 *
 * Data sources:
 *   SchedulePresets                       — global wave templates (TEMPLATE)
 *   FleetScheduleGridWaveLayoutStore      — per-grid layer state with role
 *                                           ("active" | "comparison")
 *   AesAfpSettings.activePresetIdByHub    — per-hub canonical active pointer
 *                                           (allocator + slot-optimizer read
 *                                           it; this panel writes it)
 *   getHubSummary(hub) → {count,total,...} — passed by the panel to power
 *                                           the Hub Plan Header card
 *
 * `_setActive` writes through to BOTH the layout store (visual) and
 * AesAfpSettings.activePresetIdByHub (allocator). It also mirrors the
 * value to lastSelectedPresetId for legacy fallback paths.
 *
 * `_setCompare` adds a role:"comparison" layer (capped at 2 per focused
 * hub in the UI; the store still allows up to MAX_LAYERS total).
 *
 * Section order:
 *   1. Hub Plan Header (active plan summary for `currentHub`)
 *   2. ACTIVE         — one layer for `currentHub`
 *   3. COMPARING      — ≤ 2 ghost overlays for `currentHub`
 *   4. OTHER PLANS    — presets for `currentHub` not currently active/comparing
 *   5. OTHER HUBS     — collapsed one-liners; click switches focus
 *   6. Footer         — "+ new plan" affordances
 */
class FleetScheduleGridWavePicker {

    /**
     * Stable distinct color palette. Bone-skin friendly hues, picked so
     * pairwise overlap under mix-blend-mode: multiply still reads clearly.
     * Used to pick a comparison-layer color (active layers always use the
     * preset's first wave color, hashed to a stable palette index).
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

    static MAX_COMPARES = 2
    static DEFAULT_ACTIVE_OPACITY = 0.4
    static DEFAULT_COMPARE_OPACITY = 0.22

    /**
     * @param {object} opts
     *   - server, airlineCode
     *   - currentHub: hub IATA to default-focus (best guess: most common in fleet)
     *   - getHubSummary: (hub) => {count, total, hubs} or null  // panel-supplied
     *   - onChange: () => void  // fires after any store/settings mutation
     */
    constructor(opts) {
        const o = opts || {}
        this.server         = o.server || ""
        this.airlineCode    = o.airlineCode || ""
        this.currentHub     = (o.currentHub || "").toUpperCase()
        this._focusHub      = this.currentHub
        this.onChange       = typeof o.onChange === "function" ? o.onChange : () => {}
        this.getHubSummary  = typeof o.getHubSummary === "function" ? o.getHubSummary : null
        this.paneEl         = null
        this._presets       = []
        this._block         = {layers: [], fadeRatio: 0.25}
        this._activeMap     = {}    // hub → presetId (from AesAfpSettings)
    }

    setCurrentHub(hub) {
        const HUB = String(hub || "").toUpperCase()
        if (HUB === this.currentHub) return
        this.currentHub = HUB
        if (!this._focusHub || this._presetsForHub(this._focusHub).length === 0) {
            this._focusHub = HUB
        }
        if (this.paneEl) this._render()
    }

    /** Build the pane element (called by the panel before mounting in side-rail). */
    buildPane() {
        const pane = document.createElement("div")
        pane.style.cssText = "padding:10px 12px;display:flex;flex-direction:column;gap:10px;"
        const sec = (id) => {
            const d = document.createElement("div")
            d.dataset.section = id
            return d
        }
        pane.append(
            sec("header"),
            sec("active"),
            sec("compare"),
            sec("other-plans"),
            sec("other-hubs"),
            sec("footer")
        )
        this.paneEl = pane
        return pane
    }

    /** Refresh presets, layers, and the per-hub active map. Triggers re-render. */
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
        // Pull the per-hub active map from AesAfpSettings. Allocator + the
        // slot-optimizer read this same map, so writing through here
        // ensures the panel and the scheduler agree on "the active plan".
        this._activeMap = {}
        if (typeof AesAfpSettings !== "undefined") {
            try {
                const s = await AesAfpSettings.load()
                this._activeMap = (s && s.activePresetIdByHub) ? Object.assign({}, s.activePresetIdByHub) : {}
            } catch (_) {}
        }
        if (!this._focusHub && this.currentHub) this._focusHub = this.currentHub
        if (!this._focusHub) {
            const firstHub = this._presets.find(p => p && p.hub)
            this._focusHub = firstHub ? String(firstHub.hub).toUpperCase() : ""
        }
        // Self-heal: if activePresetIdByHub points at a real preset but no
        // role:"active" layer exists yet (e.g. fresh install with a legacy
        // lastSelectedPresetId, or layout store cleared while settings
        // persisted), seed the layer so the Hub Header agrees with the
        // Active section.
        await this._reconcileActiveLayers()
        this._render()
    }

    async _reconcileActiveLayers() {
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        let dirty = false
        for (const hub of Object.keys(this._activeMap)) {
            const presetId = this._activeMap[hub]
            const preset = this._presets.find(p => p && p.id === presetId)
            if (!preset) continue
            const has = this._block.layers.find(l => l.role === "active" && l.hub === hub)
            if (has) continue
            const wave = (preset.waves && preset.waves[0]) || null
            const layer = this._buildLayer(preset, wave, "active")
            const next = await FleetScheduleGridWaveLayoutStore.setActiveForHub(
                this.server, this.airlineCode, hub, layer
            )
            if (next) { this._block = next; dirty = true }
        }
        // Inverse self-heal: if the layout store has an active layer for a
        // hub but settings disagrees, drop the orphan visual to avoid the
        // panel showing one plan as active while the allocator schedules a
        // different one.
        const orphaned = this._block.layers.filter(l =>
            l.role === "active" && (
                !this._activeMap[l.hub] || this._activeMap[l.hub] !== l.presetId
            )
        )
        for (const l of orphaned) {
            const next = await FleetScheduleGridWaveLayoutStore.removeLayer(
                this.server, this.airlineCode, l.id
            )
            if (next) { this._block = next; dirty = true }
        }
        if (dirty) this.onChange()
    }

    // ── Rendering ────────────────────────────────────────────────────────

    _render() {
        if (!this.paneEl) return
        const T = (typeof window !== "undefined" && window.AESTokens) || null
        const hub = this._focusHub
        const sections = {
            header:       this.paneEl.querySelector("[data-section=header]"),
            active:       this.paneEl.querySelector("[data-section=active]"),
            compare:      this.paneEl.querySelector("[data-section=compare]"),
            otherPlans:   this.paneEl.querySelector("[data-section=other-plans]"),
            otherHubs:    this.paneEl.querySelector("[data-section=other-hubs]"),
            footer:       this.paneEl.querySelector("[data-section=footer]")
        }
        Object.values(sections).forEach(s => { if (s) s.innerHTML = "" })

        if (!this._presets.length) {
            sections.footer.appendChild(this._renderCreateCTA(T))
            return
        }

        // ── Hub Plan Header ───────────────────────────────────────────
        if (hub) {
            const activePreset = this._activePresetFor(hub)
            sections.header.appendChild(this._renderHubHeader(hub, activePreset, T))
        }

        // ── Active section ────────────────────────────────────────────
        sections.active.appendChild(this._renderSectionTitle("Active", T))
        const activeLayer = this._block.layers.find(l => l.role === "active" && l.hub === hub)
        if (activeLayer) {
            sections.active.appendChild(this._renderLayerChip(activeLayer, "active", T))
        } else {
            sections.active.appendChild(this._renderEmptySectionLine(
                hub
                    ? "No active plan for " + hub + " — pick one below."
                    : "Pick a hub below to set an active plan.",
                T
            ))
        }

        // ── Comparing section ─────────────────────────────────────────
        const compareLayers = this._block.layers
            .filter(l => l.role === "comparison" && l.hub === hub)
        sections.compare.appendChild(this._renderSectionTitle(
            "Comparing (" + compareLayers.length + "/" + FleetScheduleGridWavePicker.MAX_COMPARES + ")",
            T,
            "ghosted on grid"
        ))
        if (compareLayers.length === 0) {
            sections.compare.appendChild(this._renderEmptySectionLine(
                "What-if overlays go here — click [Compare] on any plan below.",
                T
            ))
        } else {
            for (const layer of compareLayers) {
                sections.compare.appendChild(this._renderLayerChip(layer, "comparison", T))
            }
        }

        // ── Other plans for current hub ───────────────────────────────
        const inUseIds = new Set(
            this._block.layers
                .filter(l => l.hub === hub)
                .map(l => l.presetId)
        )
        const otherForHub = (hub ? this._presetsForHub(hub) : [])
            .filter(p => !inUseIds.has(p.id))
        if (otherForHub.length) {
            sections.otherPlans.appendChild(this._renderSectionTitle(
                "Other plans for " + hub, T
            ))
            for (const preset of otherForHub) {
                sections.otherPlans.appendChild(this._renderPresetRow(preset, T))
            }
        }

        // ── Other hubs ────────────────────────────────────────────────
        const allHubs = this._allHubsSorted().filter(h => h && h !== hub)
        if (allHubs.length) {
            sections.otherHubs.appendChild(this._renderSectionTitle(
                "Other hubs", T
            ))
            for (const otherHub of allHubs) {
                sections.otherHubs.appendChild(this._renderOtherHubRow(otherHub, T))
            }
        }

        // ── Footer ────────────────────────────────────────────────────
        sections.footer.appendChild(this._renderCreateFooter(T))
    }

    _renderHubHeader(hub, activePreset, T) {
        const card = document.createElement("div")
        card.style.cssText = "padding:8px 10px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "border-left:4px solid " + (T ? T.color.rust : "#B8472A") + ";"
            + "display:flex;flex-direction:column;gap:4px;"

        const title = document.createElement("div")
        title.style.cssText = "display:flex;align-items:baseline;gap:8px;"
        const hubBadge = document.createElement("span")
        hubBadge.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "font-size:13px;font-weight:800;letter-spacing:0.05em;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
        hubBadge.textContent = hub
        const planName = document.createElement("span")
        planName.style.cssText = "font-size:11px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        if (activePreset) {
            planName.textContent = "Active: " + this._displayName(activePreset)
        } else {
            planName.textContent = "No active plan"
            planName.style.fontStyle = "italic"
            planName.style.color = T ? T.color.slate : "#7A6F66"
        }
        title.append(hubBadge, planName)
        card.appendChild(title)

        // Stats row.
        const stats = document.createElement("div")
        stats.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;"
            + "font-size:10px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        if (activePreset) {
            const summary = this._summarisePreset(activePreset)
            const stat = (label, value) => {
                const s = document.createElement("span")
                s.innerHTML = "<span style=\"opacity:0.65\">" + label + "</span> "
                    + "<strong>" + value + "</strong>"
                return s
            }
            stats.appendChild(stat("waves", String(summary.waveCount)))
            stats.appendChild(stat("comp", summary.compFingerprint))
            if (summary.peakHHMM) stats.appendChild(stat("peak", summary.peakHHMM))
        }
        if (this.getHubSummary) {
            try {
                const fleetInfo = this.getHubSummary(hub)
                if (fleetInfo && isFinite(fleetInfo.count) && isFinite(fleetInfo.total)) {
                    const tail = document.createElement("span")
                    tail.innerHTML = "<span style=\"opacity:0.65\">aircraft</span> "
                        + "<strong>" + fleetInfo.count + "/" + fleetInfo.total + "</strong>"
                    stats.appendChild(tail)
                }
            } catch (_) {}
        }
        if (stats.children.length) card.appendChild(stats)

        return card
    }

    _renderSectionTitle(text, T, sub) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "font-size:10px;font-weight:700;letter-spacing:0.08em;"
            + "text-transform:uppercase;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "padding:0 0 4px 0;border-bottom:1px solid "
            + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "display:flex;align-items:baseline;justify-content:space-between;"
            + "margin-top:6px;"
        const main = document.createElement("span")
        main.textContent = text
        wrap.appendChild(main)
        if (sub) {
            const sm = document.createElement("span")
            sm.style.cssText = "font-size:9px;font-weight:500;letter-spacing:0.05em;"
                + "text-transform:none;font-style:italic;"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            sm.textContent = sub
            wrap.appendChild(sm)
        }
        return wrap
    }

    _renderEmptySectionLine(message, T) {
        const el = document.createElement("div")
        el.style.cssText = "font-size:11px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
            + "font-style:italic;padding:6px 0 0 0;"
        el.textContent = message
        return el
    }

    /**
     * Active or comparison layer chip. Both share day-of-week toggles and
     * shift readout + reset; only the active chip lacks the [×] remove
     * button (use "Set active" on a different plan to replace it).
     */
    _renderLayerChip(layer, role, T) {
        const card = document.createElement("div")
        const accent = (T ? T.color.rust : "#B8472A")
        card.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:6px;"
            + "padding:6px 8px;background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px " + (role === "active" ? "solid" : "dashed") + " "
            + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "border-left:4px " + (role === "active" ? "solid" : "dashed") + " "
            + (role === "active" ? accent : layer.color) + ";"

        const head = document.createElement("div")
        head.style.cssText = "display:flex;align-items:center;gap:6px;"

        const swatch = document.createElement("div")
        swatch.style.cssText = "width:10px;height:10px;flex:0 0 10px;border-radius:1px;"
            + "background:" + layer.color + ";"
            + "border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
        head.appendChild(swatch)

        const tag = document.createElement("span")
        tag.style.cssText = "font-size:9px;font-weight:700;letter-spacing:0.05em;"
            + "text-transform:uppercase;flex:0 0 auto;"
            + "padding:1px 4px;color:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "background:" + (role === "active" ? accent : (T ? T.color.oxide2 : "#4A413B")) + ";"
        tag.textContent = role === "active" ? "ACTIVE" : "COMPARE"
        head.appendChild(tag)

        const name = document.createElement("div")
        name.style.cssText = "flex:1 1 auto;font-size:11px;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        name.textContent = layer.name
        head.appendChild(name)

        if (role === "comparison") {
            const remove = document.createElement("button")
            remove.type = "button"
            remove.style.cssText = "padding:1px 6px;cursor:pointer;font-size:10px;"
                + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"
                + "background:transparent;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            remove.textContent = "×"
            remove.title = "Stop comparing"
            remove.addEventListener("click", () => this._removeLayer(layer.id))
            head.appendChild(remove)
        }
        card.appendChild(head)

        // Shift readout (drag-to-shift writes here via Slice 2 logic).
        const totalShift = layer.timeShiftMin || 0
        const arrShift   = layer.arrShiftMin  || 0
        const depShift   = layer.depShiftMin  || 0
        if (totalShift || arrShift || depShift) {
            const shiftRow = document.createElement("div")
            shiftRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:10px;"
                + "color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
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
            reset.addEventListener("click", () => {
                this._updateLayer(layer.id, {timeShiftMin: 0, arrShiftMin: 0, depShiftMin: 0})
            })
            shiftRow.appendChild(reset)
            card.appendChild(shiftRow)
        }

        // Day toggles row — view-only filter, doesn't affect allocator.
        const dayRow = document.createElement("div")
        dayRow.style.cssText = "display:flex;gap:2px;font-size:10px;"
        const DN = ["M", "T", "W", "T", "F", "S", "S"]
        const DT = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
        for (let i = 0; i < 7; i++) {
            const b = document.createElement("button")
            b.type = "button"
            b.textContent = DN[i]
            b.title = DT[i] + " · view-only — doesn't affect auto-scheduler"
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

    /**
     * Render one row of an "Other plans" preset listing with [Set active]
     * and [Compare] buttons. Replaces the wave-by-wave toggle list — for
     * MVP we operate at the preset level (its first wave drives the
     * layer). Multi-wave presets show "+N more" in the fingerprint.
     */
    _renderPresetRow(preset, T) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:4px;"
            + "padding:6px 8px;background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        const top = document.createElement("div")
        top.style.cssText = "display:flex;align-items:center;gap:6px;"
        const dot = document.createElement("span")
        dot.style.cssText = "width:8px;height:8px;border-radius:50%;"
            + "background:" + this._presetColor(preset) + ";"
            + "border:1px solid " + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "flex:0 0 8px;"
        const name = document.createElement("span")
        name.style.cssText = "flex:1 1 auto;font-size:11px;"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";"
        name.textContent = this._displayName(preset)
        top.append(dot, name)
        row.appendChild(top)

        // If user customised the preset name, show the fingerprint as muted
        // sub-text so the same plan's identity is obvious anyway.
        const fp = this._fingerprintLabel(preset)
        if (fp && this._displayName(preset) !== fp) {
            const sub = document.createElement("div")
            sub.style.cssText = "font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
                + "font-family:" + (T ? T.font.mono : "monospace") + ";"
                + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            sub.textContent = fp
            row.appendChild(sub)
        }

        // Buttons.
        const btns = document.createElement("div")
        btns.style.cssText = "display:flex;gap:6px;margin-top:2px;"
        const setActiveBtn = document.createElement("button")
        setActiveBtn.type = "button"
        setActiveBtn.textContent = "Set active"
        setActiveBtn.title = "Make this the plan that drives auto-scheduling for "
            + (preset.hub || "") + "."
        setActiveBtn.style.cssText = "padding:3px 10px;font-size:11px;cursor:pointer;"
            + "background:" + (T ? T.color.rust : "#B8472A") + ";"
            + "color:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.rust : "#B8472A") + ";"
            + "font-weight:700;letter-spacing:0.05em;"
        setActiveBtn.addEventListener("click", () => this._setActive(preset))

        const compareBtn = document.createElement("button")
        compareBtn.type = "button"
        compareBtn.textContent = "Compare"
        compareBtn.title = "Show this plan as a ghosted overlay alongside the active one."
        compareBtn.style.cssText = "padding:3px 10px;font-size:11px;cursor:pointer;"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border:1px dashed " + (T ? T.color.oxide2 : "#4A413B") + ";"
        compareBtn.addEventListener("click", () => this._setCompare(preset))

        btns.append(setActiveBtn, compareBtn)
        row.appendChild(btns)
        return row
    }

    /**
     * Compact one-liner for "Other hubs" — clicking it switches focus so
     * the entire panel pivots to that hub's plans.
     */
    _renderOtherHubRow(hub, T) {
        const row = document.createElement("button")
        row.type = "button"
        row.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;"
            + "margin-top:4px;padding:4px 8px;cursor:pointer;text-align:left;"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border:1px solid " + (T ? T.color.paperRule : "#C9C0B0") + ";"

        const badge = document.createElement("span")
        badge.style.cssText = "font-family:" + (T ? T.font.mono : "monospace") + ";"
            + "font-size:11px;font-weight:700;letter-spacing:0.05em;flex:0 0 auto;"
        badge.textContent = hub

        const sep = document.createElement("span")
        sep.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";"
        sep.textContent = "·"

        const summary = document.createElement("span")
        summary.style.cssText = "font-size:10px;color:" + (T ? T.color.oxide2 : "#4A413B") + ";"
            + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
            + "font-family:" + (T ? T.font.mono : "monospace") + ";flex:1 1 auto;"
        const ap = this._activePresetFor(hub)
        summary.textContent = ap ? ("Active: " + this._displayName(ap)) : "no active plan"

        const arrow = document.createElement("span")
        arrow.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            + "font-size:11px;flex:0 0 auto;"
        arrow.textContent = "→"

        row.append(badge, sep, summary, arrow)
        row.addEventListener("click", () => {
            this._focusHub = hub
            this._render()
        })
        return row
    }

    // ── Footer / create-plan ─────────────────────────────────────────────

    _renderCreateCTA(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:8px;padding:10px;font-size:11px;"
            + "background:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "display:flex;flex-direction:column;gap:6px;"
        const lbl = document.createElement("div")
        lbl.style.cssText = "color:" + (T ? T.color.slate : "#7A6F66") + ";line-height:1.4;"
        lbl.textContent = "No wave plans yet. Create one here — it'll show up in "
            + "Route Assistant Wave View, the AFP wave strip, and the Fleet Command Center."
        wrap.appendChild(lbl)
        wrap.appendChild(this._renderCreateButtons(T))
        return wrap
    }

    _renderCreateFooter(T) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding-top:8px;"
            + "border-top:1px dashed " + (T ? T.color.paperRule : "#C9C0B0") + ";"
            + "display:flex;flex-direction:column;gap:4px;"
        const lbl = document.createElement("div")
        lbl.style.cssText = "font-size:10px;color:" + (T ? T.color.slate : "#7A6F66") + ";"
            + "letter-spacing:0.05em;text-transform:uppercase;"
        lbl.textContent = "Add a new plan"
        wrap.appendChild(lbl)
        wrap.appendChild(this._renderCreateButtons(T))
        return wrap
    }

    _renderCreateButtons(T) {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;"
        const canCreate = typeof RouteAssistantWaveEditor !== "undefined"
            && typeof SchedulePresets !== "undefined"
        if (!canCreate) {
            const note = document.createElement("span")
            note.style.cssText = "font-size:10px;font-style:italic;"
                + "color:" + (T ? T.color.slate : "#7A6F66") + ";"
            note.textContent = "Wave editor not loaded — open Route Assistant to create one."
            row.appendChild(note)
            return row
        }
        const btnCss = "padding:3px 10px;font-size:11px;cursor:pointer;"
            + "background:" + (T ? T.color.rust : "#B8472A") + ";"
            + "color:" + (T ? T.color.bone : "#F4F1EA") + ";"
            + "border:1px solid " + (T ? T.color.rust : "#B8472A") + ";"
            + "font-weight:700;letter-spacing:0.05em;"
        const focus = this._focusHub || this.currentHub
        if (focus) {
            const hubBtn = document.createElement("button")
            hubBtn.type = "button"
            hubBtn.textContent = "+ for " + focus
            hubBtn.title = "Create a starter wave plan for " + focus
                + " (1 wave, 4S/2M/1L composition)."
            hubBtn.style.cssText = btnCss
            hubBtn.addEventListener("click", () => this._createForHub(hubBtn, focus))
            row.appendChild(hubBtn)
        }
        const otherBtn = document.createElement("button")
        otherBtn.type = "button"
        otherBtn.textContent = focus ? "+ for another hub…" : "+ create plan…"
        otherBtn.title = "Prompt for a hub IATA and create a starter wave plan."
        otherBtn.style.cssText = "padding:3px 10px;font-size:11px;cursor:pointer;"
            + "background:transparent;color:" + (T ? T.color.oxide : "#2B2520") + ";"
            + "border:1px dashed " + (T ? T.color.oxide2 : "#4A413B") + ";"
        otherBtn.addEventListener("click", () => this._promptCreateForHub(otherBtn))
        row.appendChild(otherBtn)
        return row
    }

    async _promptCreateForHub(btn) {
        const raw = window.prompt("Hub IATA for the new wave plan:",
            this._focusHub || this.currentHub || "")
        if (!raw) return
        const hub = String(raw).trim().toUpperCase()
        if (!/^[A-Z]{3}$/.test(hub)) {
            window.alert("Hub IATA must be three letters (e.g. JFK).")
            return
        }
        await this._createForHub(btn, hub)
    }

    async _createForHub(btn, hub) {
        if (typeof RouteAssistantWaveEditor === "undefined") return
        const prevText = btn ? btn.textContent : ""
        if (btn) { btn.disabled = true; btn.textContent = "Creating…" }
        try {
            await RouteAssistantWaveEditor.createStarterPreset(hub)
            this._focusHub = hub
            await this.refresh()
            this.onChange()
        } catch (e) {
            console.warn("[AES FSG wave-picker] create starter preset failed", e)
            this._toast("Couldn't create the wave plan — check the console.")
            if (btn) { btn.disabled = false; btn.textContent = prevText }
        }
    }

    // ── Active / Compare wiring ──────────────────────────────────────────

    /**
     * Make this preset the active plan for its hub. Writes through to:
     *   1) FleetScheduleGridWaveLayoutStore — replaces any prior
     *      role:"active" layer with the same hub (visual)
     *   2) AesAfpSettings.activePresetIdByHub[hub] — allocator + slot-
     *      optimizer read this to pick which preset to schedule against
     *   3) AesAfpSettings.lastSelectedPresetId — kept in sync for legacy
     *      consumers (back-compat fallback chain)
     */
    async _setActive(preset) {
        if (!preset || !preset.hub) return
        const HUB = String(preset.hub).toUpperCase()
        const wave = (preset.waves && preset.waves[0]) || null
        const layer = this._buildLayer(preset, wave, "active")
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        const next = await FleetScheduleGridWaveLayoutStore.setActiveForHub(
            this.server, this.airlineCode, HUB, layer
        )
        if (!next) {
            this._toast("Layer cap reached — remove a comparison first.")
            return
        }
        this._block = next

        // Mirror to AesAfpSettings so the allocator + slot-optimizer
        // resolve to the same preset.
        if (typeof AesAfpSettings !== "undefined") {
            try {
                const map = Object.assign({}, this._activeMap, {[HUB]: preset.id})
                await AesAfpSettings.save({
                    activePresetIdByHub: map,
                    lastSelectedPresetId: preset.id
                })
                this._activeMap = map
            } catch (e) {
                console.warn("[AES FSG wave-picker] settings.save failed", e)
            }
        }

        this._focusHub = HUB
        this._render()
        this.onChange()
    }

    /**
     * Add this preset as a comparison overlay. Cap-checked at MAX_COMPARES
     * per focused hub. If the preset is already active or already
     * comparing, no-op.
     */
    async _setCompare(preset) {
        if (!preset || !preset.hub) return
        const HUB = String(preset.hub).toUpperCase()
        // Already in use?
        if (this._block.layers.find(l => l.hub === HUB && l.presetId === preset.id)) {
            this._toast("Already showing this plan.")
            return
        }
        const compareCount = this._block.layers
            .filter(l => l.role === "comparison" && l.hub === HUB).length
        if (compareCount >= FleetScheduleGridWavePicker.MAX_COMPARES) {
            this._toast("Comparison limit (" + FleetScheduleGridWavePicker.MAX_COMPARES
                + ") reached — remove one first.")
            return
        }
        const wave = (preset.waves && preset.waves[0]) || null
        const layer = this._buildLayer(preset, wave, "comparison")
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        const next = await FleetScheduleGridWaveLayoutStore.upsertLayer(
            this.server, this.airlineCode, layer
        )
        if (!next) {
            this._toast("Layer cap reached — remove one first.")
            return
        }
        this._block = next
        this._focusHub = HUB
        this._render()
        this.onChange()
    }

    _buildLayer(preset, wave, role) {
        const HUB = String(preset.hub || "").toUpperCase()
        const color = (role === "active")
            ? this._presetColor(preset)
            : FleetScheduleGridWavePicker.PALETTE[
                  this._block.layers.length % FleetScheduleGridWavePicker.PALETTE.length
              ]
        const opacity = (role === "active")
            ? FleetScheduleGridWavePicker.DEFAULT_ACTIVE_OPACITY
            : FleetScheduleGridWavePicker.DEFAULT_COMPARE_OPACITY
        return {
            id:           "L-" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
            presetId:     preset.id,
            waveId:       (wave && wave.id) || "",
            hub:          HUB,
            name:         this._displayName(preset),
            color,
            role,
            opacity,
            timeShiftMin: 0,
            arrShiftMin:  0,
            depShiftMin:  0,
            days:         [true, true, true, true, true, true, true],
            arrivalWindow:   wave && wave.arrivalWindow   ? {start: wave.arrivalWindow.start,   end: wave.arrivalWindow.end}   : null,
            departureWindow: wave && wave.departureWindow ? {start: wave.departureWindow.start, end: wave.departureWindow.end} : null,
            addedAt: Date.now()
        }
    }

    async _removeLayer(layerId) {
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        const next = await FleetScheduleGridWaveLayoutStore.removeLayer(
            this.server, this.airlineCode, layerId
        )
        if (next) { this._block = next; this._render(); this.onChange() }
    }

    async _updateLayer(layerId, fields) {
        const layer = this._block.layers.find(l => l.id === layerId)
        if (!layer) return
        const merged = Object.assign({}, layer, fields)
        if (typeof FleetScheduleGridWaveLayoutStore === "undefined") return
        const next = await FleetScheduleGridWaveLayoutStore.upsertLayer(
            this.server, this.airlineCode, merged
        )
        if (next) { this._block = next; this._render(); this.onChange() }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    _presetsForHub(hub) {
        const HUB = String(hub || "").toUpperCase()
        return this._presets.filter(p => p && String(p.hub || "").toUpperCase() === HUB)
    }

    _activePresetFor(hub) {
        const HUB = String(hub || "").toUpperCase()
        const id = this._activeMap[HUB]
        if (!id) return null
        return this._presets.find(p => p && p.id === id) || null
    }

    _allHubsSorted() {
        const set = new Set()
        for (const p of this._presets) {
            if (p && p.hub) set.add(String(p.hub).toUpperCase())
        }
        return Array.from(set).sort((a, b) => {
            if (a === this.currentHub) return -1
            if (b === this.currentHub) return 1
            return a.localeCompare(b)
        })
    }

    /**
     * Display name. Replaces the default starter name "Wave plan for <HUB>"
     * with a self-describing fingerprint so duplicates are visible at a
     * glance — that was the screenshot's biggest UX failure (two layers
     * both labelled "Wave plan for JFK — Wave 1"). User-customised names
     * are kept verbatim; the fingerprint shows up as muted sub-text in the
     * preset row.
     */
    _displayName(preset) {
        if (!preset) return ""
        const name = String(preset.name || "")
        const hub = String(preset.hub || "").toUpperCase()
        const isDefault = !name
            || name === ("Wave plan for " + hub)
            || name === "Wave plan"
        if (isDefault) {
            const fp = this._fingerprintLabel(preset)
            return fp || (name || hub || "(unnamed)")
        }
        return name
    }

    /**
     * Self-describing fingerprint for a preset: hub, first wave's
     * arrival→departure window, composition counts. Used in display name
     * fallback and as muted sub-text under custom names.
     */
    _fingerprintLabel(preset) {
        if (!preset) return ""
        const hub = String(preset.hub || "").toUpperCase()
        const waves = Array.isArray(preset.waves) ? preset.waves : []
        if (!waves.length) return hub + " · (no waves)"
        const w0 = waves[0]
        const arr = (w0.arrivalWindow && w0.arrivalWindow.start) || "??:??"
        const dep = (w0.departureWindow && w0.departureWindow.start) || "??:??"
        const comp = w0.composition || {}
        const compStr = (comp.shortHaul | 0) + "S/"
                      + (comp.mediumHaul | 0) + "M/"
                      + (comp.longHaul | 0) + "L"
        let s = hub + " · " + arr + "→" + dep + " · " + compStr
        if (waves.length > 1) s += " · +" + (waves.length - 1) + " more"
        return s
    }

    /** Aggregate composition + peak across all waves; used in the header. */
    _summarisePreset(preset) {
        const waves = Array.isArray(preset && preset.waves) ? preset.waves : []
        let s = 0, m = 0, l = 0
        let earliest = null
        for (const w of waves) {
            const c = w.composition || {}
            s += (c.shortHaul  | 0)
            m += (c.mediumHaul | 0)
            l += (c.longHaul   | 0)
            const dep = (w.departureWindow && w.departureWindow.start) || ""
            if (dep && /^\d{1,2}:\d{2}$/.test(dep)) {
                if (!earliest || dep < earliest) earliest = dep
            }
        }
        return {
            waveCount:       waves.length,
            compFingerprint: s + "S/" + m + "M/" + l + "L",
            peakHHMM:        earliest
        }
    }

    /**
     * Stable per-preset color, hashed from preset id into the palette.
     * Means re-opening the grid shows the same preset in the same color
     * even when no layer is active yet.
     */
    _presetColor(preset) {
        const id = String((preset && preset.id) || "")
        let h = 0
        for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
        const idx = Math.abs(h) % FleetScheduleGridWavePicker.PALETTE.length
        return FleetScheduleGridWavePicker.PALETTE[idx]
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
