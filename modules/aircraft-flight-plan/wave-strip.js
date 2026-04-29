"use strict"

/**
 * Compact wave-pattern overlay for the Flight Studio candidate panel.
 *
 * Renders the active hub's `SchedulePresets` waves as stacked horizontal
 * lanes — each lane has an arrival window (green) and a departure window
 * (blue) the user can grab and drag (translate the whole window) or
 * grab the edges to resize start/end. Saves through the same
 * `RouteAssistantWaveEditor.updateWaveTime` path the Route Assistant's
 * Wave View uses, so edits round-trip there immediately.
 *
 * Design points:
 *  - Mounts ABOVE the candidates table (route-candidates.js calls
 *    `AesAfpWaveStrip.render()` when the "🌊 Waves" chip is on).
 *  - 5+ waves supported: each lane is 16px tall so 5 waves + ruler
 *    fit in ~94px.
 *  - Drag is mouse-based with 5-min snap; persistence is debounced so
 *    a fast drag emits one storage write per edge.
 *  - Storage is the cross-extension SchedulePresets — no new keys.
 *  - chrome.storage.onChanged keeps the strip in sync with the Route
 *    Assistant Wave View if the user edits there in another tab.
 *
 * Bus contract (additions):
 *   in:  hub:changed, ctx:ready
 *   out: wavestrip:preset-changed {presetId}
 */
;(function () {
    if (window.AesAfpWaveStrip) return

    const LANE_HEIGHT_PX  = 16
    const RULER_HEIGHT_PX = 14
    const LABEL_WIDTH_PX  = 96
    const SNAP_MIN        = 5
    const EDGE_HIT_PX     = 6
    const COLOR_ARRIVAL   = "rgba(16,185,129,0.45)"
    const COLOR_DEPARTURE = "rgba(59,130,246,0.45)"
    const COLOR_ARRIVAL_HOVER   = "rgba(16,185,129,0.65)"
    const COLOR_DEPARTURE_HOVER = "rgba(59,130,246,0.65)"
    const WAVE_COLORS = [
        "#7dd3fc", "#fcd34d", "#86efac", "#fca5a5", "#a78bfa",
        "#f9a8d4", "#fde68a", "#67e8f9", "#fda4af", "#a3e635"
    ]

    let _attached         = false
    let _activePresetId   = null   // user's pick; falls back to per-hub default
    let _lastHost         = null
    let _lastHub          = null
    let _renderInFlight   = false
    let _renderRetry      = 0

    function _bus() { return (window.AesAfp && window.AesAfp.bus) || null }

    function _activeHub() {
        if (window.AesAfp && typeof window.AesAfp.getActiveHub === "function") {
            try { return window.AesAfp.getActiveHub() || null } catch (_) { return null }
        }
        return null
    }

    /**
     * Pick the preset to show: prefer user's _activePresetId, then the
     * default-id, then the first preset matching the hub, then any preset.
     */
    async function _resolveActivePreset(hubIata) {
        if (typeof SchedulePresets === "undefined") return {preset: null, presets: []}
        const block = await SchedulePresets.load()
        const presets = Array.isArray(block.presets) ? block.presets : []
        if (!presets.length) return {preset: null, presets: presets}
        const hubU = String(hubIata || "").toUpperCase()
        let preset = _activePresetId ? presets.find(p => p.id === _activePresetId) : null
        if (!preset && block.defaultPresetId) {
            preset = presets.find(p => p.id === block.defaultPresetId) || null
        }
        if (!preset && hubU) {
            preset = presets.find(p => String(p.hub || "").toUpperCase() === hubU) || null
        }
        if (!preset) preset = presets[0]
        if (preset) _activePresetId = preset.id
        return {preset, presets}
    }

    /** Re-render against the last (host, hub). Idempotent if no host yet. */
    async function _reRender() {
        if (!_lastHost) return
        await render(_lastHost, _lastHub)
    }

    /** Public — replace-render the strip into `host`. */
    async function render(host, hubIata) {
        if (!host) return
        _lastHost = host
        _lastHub  = hubIata || _activeHub()
        if (_renderInFlight) { _renderRetry++; return }
        _renderInFlight = true
        try {
            host.innerHTML = ""
            const hub = _lastHub
            if (!hub || !/^[A-Z]{3}$/.test(String(hub).toUpperCase())) {
                _renderEmpty(host, "Pick a planning hub to see waves.")
                return
            }
            if (typeof SchedulePresets === "undefined"
                    || typeof ScheduleFactors === "undefined"
                    || typeof RouteAssistantWaveEditor === "undefined") {
                _renderEmpty(host, "Wave infrastructure not loaded on this page.")
                return
            }
            const {preset, presets} = await _resolveActivePreset(hub)
            if (!preset) {
                _renderCreateCTA(host, String(hub).toUpperCase())
                return
            }
            _renderHeader(host, preset, presets, String(hub).toUpperCase())
            _renderStrip(host, preset)
        } catch (e) {
            console.warn("[AES afp] wave-strip render failed", e)
        } finally {
            _renderInFlight = false
            if (_renderRetry > 0) {
                _renderRetry = 0
                _reRender()
            }
        }
    }

    function _renderEmpty(host, msg) {
        const div = document.createElement("div")
        div.style.cssText = "padding:6px 8px;color:#9ca3af;font-size:11px;font-style:italic;"
        div.textContent = msg
        host.append(div)
    }

    function _renderCreateCTA(host, hubIata) {
        const card = document.createElement("div")
        card.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;"
            + "padding:6px 8px;border:1px dashed #7c3aed;background:rgba(124,58,237,0.06);"
            + "border-radius:4px;color:#cbd5e1;font-size:11px;"
        const lbl = document.createElement("div")
        lbl.innerHTML = "🌊 No wave plan for <strong>" + hubIata + "</strong> yet."
        const btn = document.createElement("button")
        btn.type = "button"
        btn.textContent = "+ Create starter plan"
        btn.title = "Creates a one-wave starter plan — edit in-strip or in Route Assistant Wave View."
        btn.style.cssText = "background:#1e40af;color:#dbeafe;border:1px solid #3b82f6;"
            + "border-radius:3px;padding:3px 10px;font-size:11px;cursor:pointer;"
        btn.addEventListener("click", async () => {
            btn.disabled = true
            try {
                const created = await RouteAssistantWaveEditor.createStarterPreset(hubIata)
                if (created) {
                    _activePresetId = created.id
                    const b = _bus()
                    if (b) try { b.emit("wavestrip:preset-changed", {presetId: created.id}) } catch (_) {}
                    _emitWavesPresetUpdated(created.id, created.hub || hubIata)
                    await _reRender()
                }
            } catch (e) {
                console.warn("[AES afp] create starter wave plan failed", e)
                btn.disabled = false
            }
        })
        card.append(lbl, btn)
        host.append(card)
    }

    function _renderHeader(host, preset, presets, hubIata) {
        const header = document.createElement("div")
        header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:3px;"
            + "font-size:11px;color:#9ca3af;flex-wrap:wrap;"

        const title = document.createElement("strong")
        title.textContent = "🌊 Waves"
        title.style.cssText = "color:#cbd5e1;"
        header.append(title)

        if (presets.length > 1) {
            const sel = document.createElement("select")
            sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
                + "border-radius:3px;padding:1px 4px;font-size:10px;"
            sel.title = "Switch active wave preset"
            for (const p of presets) {
                const opt = document.createElement("option")
                opt.value = p.id
                opt.textContent = p.name + (p.hub ? " — " + p.hub : "")
                if (p.id === preset.id) opt.selected = true
                sel.append(opt)
            }
            sel.addEventListener("change", () => {
                _activePresetId = sel.value
                const b = _bus()
                if (b) try { b.emit("wavestrip:preset-changed", {presetId: sel.value}) } catch (_) {}
                const picked = presets.find(p => p.id === sel.value) || null
                _emitWavesPresetUpdated(sel.value, picked ? (picked.hub || hubIata) : hubIata)
                _reRender()
            })
            header.append(sel)
        } else {
            const name = document.createElement("span")
            name.textContent = preset.name + (preset.hub ? " · " + preset.hub : "")
            name.style.cssText = "color:#94a3b8;"
            header.append(name)
        }

        const addBtn = document.createElement("button")
        addBtn.type = "button"
        addBtn.textContent = "+ wave"
        addBtn.title = "Append a new wave (staggered ~4h after the last)."
        addBtn.style.cssText = "background:transparent;color:#9ca3af;border:1px dashed #475569;"
            + "border-radius:3px;padding:1px 6px;font-size:10px;cursor:pointer;margin-left:auto;"
        addBtn.addEventListener("click", async () => {
            addBtn.disabled = true
            try {
                await RouteAssistantWaveEditor.addWave(preset.id)
                await _reRender()
            } finally { addBtn.disabled = false }
        })
        header.append(addBtn)

        const hint = document.createElement("span")
        hint.textContent = "drag bands to move · edges to resize"
        hint.style.cssText = "color:#6b7280;font-size:9px;font-style:italic;"
        header.append(hint)

        host.append(header)
    }

    function _renderStrip(host, preset) {
        const slot = (preset.factors && preset.factors.slotWindow) || null
        const cropMin = slot ? Math.floor(ScheduleFactors.parseHHMM(slot.start) / 60) : 0
        const cropMax = slot ? Math.ceil(ScheduleFactors.parseHHMM(slot.end) / 60) : 24
        const totalMin = Math.max(60, (cropMax - cropMin) * 60)
        const startMin = cropMin * 60
        const ctx = {cropMin, cropMax, totalMin, startMin, preset}

        const wrap = document.createElement("div")
        wrap.style.cssText = "border:1px solid #1f2937;border-radius:4px;background:#0a1019;"
            + "overflow:hidden;"
        host.append(wrap)

        // Hour ruler (offset by label column).
        const ruler = document.createElement("div")
        ruler.style.cssText = "position:relative;height:" + RULER_HEIGHT_PX + "px;"
            + "border-bottom:1px solid #1f2937;color:#6b7280;font-size:9px;"
            + "font-family:monospace;margin-left:" + LABEL_WIDTH_PX + "px;"
        const showEvery = (cropMax - cropMin) <= 12 ? 1 : (cropMax - cropMin) <= 18 ? 2 : 3
        for (let h = cropMin; h <= cropMax; h++) {
            const left = ((h - cropMin) * 60 / totalMin) * 100
            const tick = document.createElement("div")
            tick.style.cssText = "position:absolute;left:" + left + "%;bottom:0;"
                + "width:1px;height:4px;background:#374151;"
            ruler.append(tick)
            if (h % showEvery === 0) {
                const lbl = document.createElement("div")
                lbl.style.cssText = "position:absolute;left:" + left + "%;top:0;"
                    + "transform:translateX(-50%);"
                lbl.textContent = String(h).padStart(2, "0")
                ruler.append(lbl)
            }
        }
        wrap.append(ruler)

        // Lanes
        for (let i = 0; i < preset.waves.length; i++) {
            wrap.append(_renderLane(preset.waves[i], i, ctx))
        }
    }

    function _renderLane(wave, idx, ctx) {
        const lane = document.createElement("div")
        lane.style.cssText = "display:flex;align-items:stretch;height:" + LANE_HEIGHT_PX + "px;"
            + "border-bottom:1px solid #0f1623;"

        // Label column
        const label = document.createElement("div")
        label.style.cssText = "width:" + LABEL_WIDTH_PX + "px;flex-shrink:0;padding:0 6px;"
            + "background:#0f1623;color:#cbd5e1;font-size:10px;display:flex;"
            + "align-items:center;justify-content:space-between;border-right:1px solid #1f2937;"
        const swatch = document.createElement("span")
        swatch.style.cssText = "display:inline-block;width:6px;height:6px;border-radius:50%;"
            + "background:" + WAVE_COLORS[idx % WAVE_COLORS.length] + ";margin-right:4px;flex:0 0 6px;"
        const nameSpan = document.createElement("span")
        nameSpan.textContent = (wave.label || "Wave " + (idx + 1))
        nameSpan.style.cssText = "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        const left = document.createElement("div")
        left.style.cssText = "display:flex;align-items:center;flex:1;min-width:0;"
        left.append(swatch, nameSpan)
        const del = document.createElement("button")
        del.type = "button"
        del.textContent = "✕"
        del.title = "Delete this wave"
        del.style.cssText = "background:transparent;color:#6b7280;border:0;font-size:9px;"
            + "cursor:pointer;padding:0 2px;flex:0 0 auto;"
        del.addEventListener("click", async (e) => {
            e.preventDefault(); e.stopPropagation()
            if (!ctx.preset || ctx.preset.waves.length <= 1) return
            del.disabled = true
            await RouteAssistantWaveEditor.removeWave(ctx.preset.id, wave.id)
            await _reRender()
        })
        label.append(left, del)
        lane.append(label)

        // Strip area — relatively positioned canvas for absolute bands.
        const strip = document.createElement("div")
        strip.style.cssText = "position:relative;flex:1;height:100%;background:#0a1019;"
            + "background-image:linear-gradient(to right, #131b29 1px, transparent 1px);"
            + "background-size:" + (100 / Math.max(1, ctx.cropMax - ctx.cropMin)) + "% 100%;"
        strip.dataset.aesWaveStripLane = "1"
        // Phase A2 — tag the lane with its wave id so coordsToWave can
        // identify it without walking band children, and surface ctx
        // dimensions so coordsToMinute can convert pointer X without a
        // separate ctx ref.
        strip.dataset.aesWaveLaneId = wave.id
        strip.dataset.aesWaveStartMin = String(ctx.startMin)
        strip.dataset.aesWaveTotalMin = String(ctx.totalMin)
        lane.append(strip)

        // Bands — arrival (green) and departure (blue).
        if (wave.arrivalWindow && wave.arrivalWindow.start && wave.arrivalWindow.end) {
            strip.append(_renderBand(wave.arrivalWindow,   ctx, wave, "arrival",   strip))
        }
        if (wave.departureWindow && wave.departureWindow.start && wave.departureWindow.end) {
            strip.append(_renderBand(wave.departureWindow, ctx, wave, "departure", strip))
        }
        return lane
    }

    function _renderBand(win, ctx, wave, kind, strip) {
        const startMin = ScheduleFactors.parseHHMM(win.start)
        const endMin   = ScheduleFactors.parseHHMM(win.end)
        const safeStart = isFinite(startMin) ? startMin : ctx.startMin
        const safeEnd   = isFinite(endMin)   ? endMin   : (ctx.startMin + 30)
        const widthMin  = Math.max(SNAP_MIN, safeEnd - safeStart)
        const leftPct   = ((safeStart - ctx.startMin) / ctx.totalMin) * 100
        const widthPct  = (widthMin / ctx.totalMin) * 100

        const band = document.createElement("div")
        band.dataset.aesWaveKind = kind
        band.dataset.aesWaveId   = wave.id
        const baseColor  = (kind === "arrival") ? COLOR_ARRIVAL   : COLOR_DEPARTURE
        const hoverColor = (kind === "arrival") ? COLOR_ARRIVAL_HOVER : COLOR_DEPARTURE_HOVER
        band.style.cssText = "position:absolute;top:1px;height:" + (LANE_HEIGHT_PX - 2) + "px;"
            + "left:" + leftPct + "%;width:" + widthPct + "%;background:" + baseColor + ";"
            + "border:1px solid " + (kind === "arrival" ? "#10b981" : "#3b82f6") + ";"
            + "border-radius:2px;cursor:grab;color:#0f172a;font-size:9px;font-weight:600;"
            + "display:flex;align-items:center;justify-content:center;overflow:hidden;"
            + "user-select:none;"
        const tag = document.createElement("span")
        tag.style.cssText = "padding:0 3px;font-family:monospace;color:#0f172a;"
            + "white-space:nowrap;pointer-events:none;"
        tag.textContent = (kind === "arrival" ? "↘ " : "↗ ") + win.start + "–" + win.end
        band.append(tag)

        band.addEventListener("mouseenter", () => { band.style.background = hoverColor })
        band.addEventListener("mouseleave", () => {
            if (!band.dataset.aesDragging) band.style.background = baseColor
        })
        _wireBandDrag(band, win, ctx, wave, kind, strip, tag)
        return band
    }

    /** Mouse-driven move/resize. 5-min snap; persists on mouseup via wave-editor.
     *
     * Phase A1: lifted into AesDragArbiter so ESC cancels universally and
     * snap math stays consistent with FSG / wave-overlay. The legacy inline
     * path is preserved as fallback for pages where the arbiter hasn't
     * loaded — same behavior, no ESC.
     */
    let _arbGestureRegistered = false

    function _ensureArbGesture() {
        if (_arbGestureRegistered) return
        if (!window.AesDragArbiter) return
        _arbGestureRegistered = true
        window.AesDragArbiter.register({
            id:       "afp.waveStrip.band",
            surface:  "afp",
            priority: 100,
            matches:  (e, c) => !!(c && c.kind === "afp.waveStrip.band"),
            feedback: {
                onMove:   (ev, c)   => _arbBandMove(ev, c),
                onCancel: (c, info) => _arbBandCancel(c, info)
            },
            effect:   (drop) => _arbBandDrop(drop)
        })
    }

    function _wireBandDrag(band, win, ctx, wave, kind, strip, tag) {
        const fStart = (kind === "arrival") ? "arrivalStart" : "departureStart"
        const fEnd   = (kind === "arrival") ? "arrivalEnd"   : "departureEnd"
        const minDayMin = 0
        const maxDayMin = 24 * 60 - 1

        function snap(min)  { return Math.round(min / SNAP_MIN) * SNAP_MIN }
        function clamp(min) { return Math.max(minDayMin, Math.min(maxDayMin, min)) }

        band.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return
            _ensureArbGesture()
            const stripRect = strip.getBoundingClientRect()
            const bandRect  = band.getBoundingClientRect()
            const fromLeft  = e.clientX - bandRect.left
            const fromRight = bandRect.right - e.clientX
            const mode = (fromLeft  < EDGE_HIT_PX) ? "resize-start"
                       : (fromRight < EDGE_HIT_PX) ? "resize-end"
                       : "move"
            const startMouse  = e.clientX
            const initStart   = ScheduleFactors.parseHHMM(win.start)
            const initEnd     = ScheduleFactors.parseHHMM(win.end)

            const arbCtx = {
                kind: "afp.waveStrip.band",
                band, win, waveCtx: ctx, wave, kindBand: kind, strip, tag,
                fStart, fEnd, mode, stripRect,
                origLeftPct:  band.style.left,
                origWidthPct: band.style.width,
                origTagText:  tag.textContent,
                initStart, initEnd, startMouse,
                pendingStart: initStart, pendingEnd: initEnd
            }
            if (!window.AesDragArbiter || !window.AesDragArbiter.startManual(e, arbCtx)) return
            e.preventDefault()
            band.dataset.aesDragging = "1"
            document.body.style.cursor = (mode === "move") ? "grabbing" : "ew-resize"
            band.style.cursor = document.body.style.cursor
        })
    }

    function _arbBandMove(ev, c) {
        const minDayMin = 0
        const maxDayMin = 24 * 60 - 1
        const dxPx  = ev.clientX - c.startMouse
        const dxMin = (dxPx / c.stripRect.width) * c.waveCtx.totalMin
        const initStart = c.initStart, initEnd = c.initEnd
        const snapV = (m) => Math.round(m / SNAP_MIN) * SNAP_MIN
        const clamp = (m) => Math.max(minDayMin, Math.min(maxDayMin, m))
        let newStart = initStart, newEnd = initEnd
        if (c.mode === "move") {
            newStart = clamp(initStart + dxMin)
            newEnd   = clamp(initEnd   + dxMin)
            const len = initEnd - initStart
            if (newStart + len > maxDayMin) { newStart = maxDayMin - len; newEnd = maxDayMin }
            if (newStart < minDayMin)       { newStart = minDayMin;       newEnd = minDayMin + len }
            newStart = snapV(newStart)
            newEnd   = snapV(newStart + len)
        } else if (c.mode === "resize-start") {
            newStart = clamp(snapV(initStart + dxMin))
            if (newStart >= initEnd - SNAP_MIN) newStart = initEnd - SNAP_MIN
            newEnd = initEnd
        } else {
            newEnd = clamp(snapV(initEnd + dxMin))
            if (newEnd <= initStart + SNAP_MIN) newEnd = initStart + SNAP_MIN
            newStart = initStart
        }
        c.pendingStart = newStart
        c.pendingEnd   = newEnd
        const leftPct  = ((newStart - c.waveCtx.startMin) / c.waveCtx.totalMin) * 100
        const widthPct = ((newEnd - newStart) / c.waveCtx.totalMin) * 100
        c.band.style.left  = leftPct + "%"
        c.band.style.width = widthPct + "%"
        c.tag.textContent = (c.kindBand === "arrival" ? "↘ " : "↗ ")
            + ScheduleFactors.formatHHMM(newStart)
            + "–" + ScheduleFactors.formatHHMM(newEnd)
    }

    function _arbBandCancel(c) {
        // ESC pressed mid-drag — revert visual state, no persistence.
        document.body.style.cursor = ""
        c.band.style.cursor = "grab"
        delete c.band.dataset.aesDragging
        if (c.origLeftPct  != null) c.band.style.left  = c.origLeftPct
        if (c.origWidthPct != null) c.band.style.width = c.origWidthPct
        if (c.origTagText  != null) c.tag.textContent  = c.origTagText
    }

    async function _arbBandDrop(drop) {
        const c = drop.ctx
        document.body.style.cursor = ""
        c.band.style.cursor = "grab"
        delete c.band.dataset.aesDragging
        const newStartStr = ScheduleFactors.formatHHMM(c.pendingStart)
        const newEndStr   = ScheduleFactors.formatHHMM(c.pendingEnd)
        const writes = []
        if (newStartStr !== c.win.start) writes.push([c.fStart, newStartStr])
        if (newEndStr   !== c.win.end)   writes.push([c.fEnd,   newEndStr])
        if (!writes.length) {
            return {ok: true, audit: {kind: "afp-wavestrip-band", outcome: "no-change"}}
        }
        try {
            for (const [field, val] of writes) {
                await RouteAssistantWaveEditor.updateWaveTime(
                    c.waveCtx.preset.id, c.wave.id, field, val)
            }
            await _reRender()
            return {ok: true, audit: {
                kind:     "afp-wavestrip-band",
                mode:     c.mode,
                presetId: c.waveCtx.preset.id,
                waveId:   c.wave.id,
                bandKind: c.kindBand,
                before:   {start: c.win.start, end: c.win.end},
                after:    {start: newStartStr, end: newEndStr}
            }}
        } catch (err) {
            console.warn("[AES afp] wave-strip persist failed", err)
            return {ok: false, message: String(err && err.message || err)}
        }
    }

    // ---- Bus + storage observer -------------------------------------------

    function _emitWavesPresetUpdated(presetId, hub) {
        if (typeof window === "undefined") return
        if (typeof window.CentralHubBus === "undefined") return
        try {
            window.CentralHubBus.emit("waves:preset-updated", {
                presetId: presetId || null,
                hub:      hub ? String(hub).toUpperCase() : null,
                source:   "wave-strip"
            })
        } catch (_) { /* non-fatal */ }
    }

    function _attach() {
        if (_attached) return
        _attached = true
        const b = _bus()
        if (b && typeof b.on === "function") {
            b.on("hub:changed", () => { _activePresetId = null; _reRender() })
            b.on("ctx:ready",   () => { _reRender() })
        }
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== "local") return
                if (Object.prototype.hasOwnProperty.call(changes, "settings")) _reRender()
            })
        }
        // Track B — same-page bus listener for cross-module preset edits
        // (e.g. RA wave-editor on a different surface). Filter our own
        // emits so wave-strip drag/CTA paths don't double-render.
        if (typeof window !== "undefined" && window.CentralHubBus
                && typeof window.CentralHubBus.on === "function") {
            window.CentralHubBus.on("waves:preset-updated", (payload) => {
                if (!payload || payload.source === "wave-strip") return
                const myHub = String(_lastHub || "").toUpperCase()
                const theirHub = String((payload && payload.hub) || "").toUpperCase()
                if (theirHub && myHub && theirHub !== myHub) return
                _reRender()
            })
        }
    }

    /**
     * Phase A2 — pure helpers used by drag-to-schedule. Both functions
     * accept any wave-strip lane element (i.e. one tagged with
     * `data-aes-wave-strip-lane="1"`) and return a wave-id (coordsToWave)
     * or a minute-of-day (coordsToMinute), or null when the strip element
     * is missing/malformed.
     */
    function coordsToMinute(stripEl, clientX) {
        if (!stripEl || !stripEl.getBoundingClientRect) return null
        const rect = stripEl.getBoundingClientRect()
        if (!rect.width) return null
        const startMin = Number(stripEl.dataset.aesWaveStartMin) || 0
        const totalMin = Number(stripEl.dataset.aesWaveTotalMin) || (24 * 60)
        const x = clientX - rect.left
        const min = Math.round((x / rect.width) * totalMin + startMin)
        const snapped = Math.round(min / SNAP_MIN) * SNAP_MIN
        return Math.max(0, Math.min(24 * 60 - 1, snapped))
    }

    function coordsToWave(rootEl, clientY) {
        if (!rootEl || !rootEl.querySelectorAll) return null
        const lanes = rootEl.querySelectorAll('[data-aes-wave-strip-lane="1"]')
        let best = null
        let bestDist = Infinity
        for (const lane of lanes) {
            const r = lane.getBoundingClientRect()
            if (!r.height) continue
            const mid = r.top + r.height / 2
            const d = Math.abs(mid - clientY)
            if (d < bestDist) {
                bestDist = d
                best = {
                    lane,
                    waveId: lane.dataset.aesWaveLaneId || null,
                    rect:   r
                }
            }
        }
        return best
    }

    window.AesAfpWaveStrip = {
        render,
        attach: _attach,
        coordsToMinute,
        coordsToWave,
        get activePresetId() { return _activePresetId },
        clearActivePreset() { _activePresetId = null }
    }

    // Auto-attach on load — bus may not exist yet, so retry a few times.
    let _bootRetry = 0
    function _boot() {
        if (window.AesAfp && window.AesAfp.bus) { _attach(); return }
        if (_bootRetry++ < 40) setTimeout(_boot, 100)
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _boot, {once: true})
    } else {
        _boot()
    }
})()
