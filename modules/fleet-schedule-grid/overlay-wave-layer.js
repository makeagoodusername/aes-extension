"use strict"

/**
 * Fleet Schedule Grid — wave overlay renderer.
 *
 * Pure stateless painter. Given a lane element (one (aircraft, day) row) and
 * a set of WaveLayers, draws translucent vertical bands at each wave's
 * arrival and departure time windows.
 *
 * Each lane gets a single layer-container child appended:
 *
 *   .aes-fsg-wave-layers (position:absolute, inset:0, pointer-events:none,
 *                         mix-blend-mode: multiply)
 *     ├ .aes-fsg-wave-band[data-layer-id][data-band-kind=arr]   ← clickable
 *     ├ .aes-fsg-wave-band[data-layer-id][data-band-kind=dep]
 *     └ ...
 *
 * Bands are positioned by percentage of 24h (matches grid-renderer's
 * coordinate system). Hub-matched aircraft get full opacity; non-matching
 * aircraft show the same band at `opacity * fadeRatio` (default 0.25).
 *
 * `pickLayerAt(laneEl, x, y)` returns the topmost band's
 * `{layerId, bandKind, bandEl}` under a pointer position — used by the
 * Slice-2 drag-to-shift interaction.
 *
 * Time semantics — every effective band time uses (window.start +
 * timeShiftMin + arrShiftMin OR depShiftMin) so that:
 *   - Default drag shifts both windows together via `timeShiftMin`.
 *   - Alt-drag shifts only the grabbed window via `arrShiftMin`/`depShiftMin`.
 */
class FleetScheduleGridWaveOverlay {

    static MIN_PER_DAY = 1440
    static CONTAINER_CLASS = "aes-fsg-wave-layers"
    static BAND_CLASS = "aes-fsg-wave-band"

    /**
     * Parse "HH:MM" → minutes-from-midnight. Returns null on bad input.
     * Tolerant — handles "0600", "06:00", "6:00".
     */
    static parseHHMM(s) {
        if (s == null) return null
        const str = String(s).trim()
        if (!str) return null
        let h, m
        const colon = str.match(/^(\d{1,2}):(\d{2})$/)
        if (colon) { h = +colon[1]; m = +colon[2] }
        else if (/^\d{4}$/.test(str)) { h = +str.slice(0, 2); m = +str.slice(2) }
        else if (/^\d{1,2}$/.test(str)) { h = +str; m = 0 }
        else return null
        if (!isFinite(h) || !isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
        return h * 60 + m
    }

    /** Wrap minutes within 0..1440 (drags can push windows past midnight). */
    static _wrapMin(m) {
        if (m == null || !isFinite(m)) return null
        const mod = ((m % FleetScheduleGridWaveOverlay.MIN_PER_DAY) + FleetScheduleGridWaveOverlay.MIN_PER_DAY) % FleetScheduleGridWaveOverlay.MIN_PER_DAY
        return mod
    }

    static _minToHHMM(m) {
        const w = FleetScheduleGridWaveOverlay._wrapMin(m)
        if (w == null) return ""
        const h = Math.floor(w / 60), mm = w % 60
        return (h < 10 ? "0" + h : h) + ":" + (mm < 10 ? "0" + mm : mm)
    }

    /**
     * Compute the effective time window for one band of a layer, given the
     * layer's saved shifts. Returns {startMin, endMin, label} or null.
     *
     * The layer carries the wave's saved `arrivalWindow` / `departureWindow`
     * times directly (cached via picker so we don't have to re-resolve via
     * SchedulePresets on every paint).
     */
    static effectiveWindow(layer, kind) {
        if (!layer) return null
        const win = (kind === "arr") ? layer.arrivalWindow : layer.departureWindow
        if (!win) return null
        const startMin = FleetScheduleGridWaveOverlay.parseHHMM(win.start)
        const endMin   = FleetScheduleGridWaveOverlay.parseHHMM(win.end)
        if (startMin == null || endMin == null) return null
        const shift = (layer.timeShiftMin || 0) + ((kind === "arr") ? (layer.arrShiftMin || 0) : (layer.depShiftMin || 0))
        const a = FleetScheduleGridWaveOverlay._wrapMin(startMin + shift)
        const b = FleetScheduleGridWaveOverlay._wrapMin(endMin + shift)
        return {
            startMin: a,
            endMin:   b,
            label:    (kind === "arr" ? "A" : "D"),
            startLocal: FleetScheduleGridWaveOverlay._minToHHMM(a),
            endLocal:   FleetScheduleGridWaveOverlay._minToHHMM(b)
        }
    }

    /**
     * Paint all visible layers' bands for one lane. Idempotent — replaces
     * any prior layer-container in this lane on every call.
     *
     * @param {HTMLElement} laneEl  position:relative div from grid-renderer
     * @param {object} args
     *   - dayIdx: 0..6
     *   - layers: WaveLayer[] (already filtered for `days[dayIdx]`)
     *   - hubMatch: (layer) => boolean
     *   - fadeRatio: number 0..1, default 0.25
     */
    static paint(laneEl, args) {
        if (!laneEl) return
        FleetScheduleGridWaveOverlay.removeBands(laneEl)
        const layers = (args && Array.isArray(args.layers)) ? args.layers : []
        if (!layers.length) return
        const fadeRatio = (typeof (args && args.fadeRatio) === "number" && args.fadeRatio >= 0 && args.fadeRatio <= 1)
            ? args.fadeRatio : 0.25
        const hubMatch = (typeof (args && args.hubMatch) === "function") ? args.hubMatch : (() => true)

        const container = document.createElement("div")
        container.className = FleetScheduleGridWaveOverlay.CONTAINER_CLASS
        container.style.cssText = "position:absolute;inset:0;pointer-events:none;"
            + "mix-blend-mode:multiply;z-index:2;"

        for (const layer of layers) {
            const matches = !!hubMatch(layer)
            const effOp = matches ? layer.opacity : (layer.opacity * fadeRatio)
            for (const kind of ["arr", "dep"]) {
                const win = FleetScheduleGridWaveOverlay.effectiveWindow(layer, kind)
                if (!win || win.startMin == null || win.endMin == null) continue
                const a = win.startMin, b = win.endMin
                if (a === b) continue
                if (a < b) {
                    container.appendChild(FleetScheduleGridWaveOverlay._buildBand(layer, kind, win, a, b, effOp, matches))
                } else {
                    // Wraps midnight — split into two bands.
                    container.appendChild(FleetScheduleGridWaveOverlay._buildBand(layer, kind, win, a, FleetScheduleGridWaveOverlay.MIN_PER_DAY, effOp, matches))
                    container.appendChild(FleetScheduleGridWaveOverlay._buildBand(layer, kind, win, 0, b, effOp, matches))
                }
            }
        }
        laneEl.appendChild(container)
    }

    static _buildBand(layer, kind, win, startMin, endMin, opacity, hubMatched) {
        const left  = (startMin / FleetScheduleGridWaveOverlay.MIN_PER_DAY) * 100
        const width = Math.max(0.05, ((endMin - startMin) / FleetScheduleGridWaveOverlay.MIN_PER_DAY) * 100)
        const el = document.createElement("div")
        el.className = FleetScheduleGridWaveOverlay.BAND_CLASS
            + " " + FleetScheduleGridWaveOverlay.BAND_CLASS + "--" + kind
            + (hubMatched ? "" : " " + FleetScheduleGridWaveOverlay.BAND_CLASS + "--faded")
        el.dataset.layerId = layer.id
        el.dataset.bandKind = kind
        el.dataset.startMin = String(startMin)
        el.dataset.endMin   = String(endMin)
        // Slightly different visual treatment per band kind so users can
        // distinguish arrival vs departure on the same layer color:
        //   arr — solid fill
        //   dep — diagonal stripe
        const stripeBg = (kind === "dep")
            ? "background:repeating-linear-gradient(45deg, " + layer.color + " 0 6px, rgba(255,255,255,0.18) 6px 10px);"
            : "background:" + layer.color + ";"
        el.style.cssText = "position:absolute;top:0;bottom:0;"
            + "left:" + left + "%;width:" + width + "%;"
            + stripeBg
            + "opacity:" + opacity + ";"
            + "border-left:1.5px solid rgba(0,0,0,0.45);"
            + "border-right:1.5px solid rgba(0,0,0,0.45);"
            + "pointer-events:auto;cursor:ew-resize;"
            + "transition:opacity 80ms linear;"
        // Tiny label inside, top-left corner.
        const lbl = document.createElement("span")
        lbl.style.cssText = "position:absolute;top:1px;left:2px;"
            + "font-size:9px;font-weight:700;color:rgba(0,0,0,0.7);"
            + "font-family:'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;"
            + "letter-spacing:0.04em;line-height:1;pointer-events:none;"
            + "text-shadow:0 0 1px rgba(255,255,255,0.7);"
        lbl.textContent = win.label
        el.appendChild(lbl)
        el.title = layer.name + " · " + (kind === "arr" ? "Arrival" : "Departure")
            + " " + win.startLocal + "–" + win.endLocal
            + (hubMatched ? "" : " · (different hub — faded)")
        return el
    }

    /** Remove any prior layer-container from this lane. Idempotent. */
    static removeBands(laneEl) {
        if (!laneEl) return
        const prior = laneEl.querySelector(":scope > ." + FleetScheduleGridWaveOverlay.CONTAINER_CLASS)
        if (prior && prior.parentElement) prior.parentElement.removeChild(prior)
    }

    /**
     * Given a pointer position (laneEl-relative), return the topmost band
     * under it as `{layerId, bandKind, bandEl}` or null. Slice 2 drag
     * handlers use this for hit-testing.
     */
    static pickLayerAt(laneEl, clientX, clientY) {
        if (!laneEl) return null
        const els = document.elementsFromPoint(clientX, clientY)
        for (const el of els) {
            if (!el || !el.classList) continue
            if (!el.classList.contains(FleetScheduleGridWaveOverlay.BAND_CLASS)) continue
            return {
                layerId:  el.dataset.layerId,
                bandKind: el.dataset.bandKind,
                bandEl:   el
            }
        }
        return null
    }

    /** Repaint just one layer's bands across all lanes — fast path used by
     *  drag-to-shift in Slice 2 to avoid re-running the full grid render. */
    static repaintLayerInAllLanes(gridRoot, layer, args) {
        if (!gridRoot || !layer) return
        const fadeRatio = (typeof (args && args.fadeRatio) === "number") ? args.fadeRatio : 0.25
        const hubMatch  = (typeof (args && args.hubMatch)  === "function") ? args.hubMatch  : (() => true)
        const layersByLane = (laneEl) => (typeof (args && args.layersForLane) === "function" ? args.layersForLane(laneEl) : [layer])
        const lanes = gridRoot.querySelectorAll("[data-aircraft-id][data-day-idx]")
        for (const lane of lanes) {
            FleetScheduleGridWaveOverlay.paint(lane, {
                dayIdx:    +lane.dataset.dayIdx,
                layers:    layersByLane(lane),
                hubMatch,
                fadeRatio
            })
        }
    }
}

if (typeof window !== "undefined") {
    window.FleetScheduleGridWaveOverlay = FleetScheduleGridWaveOverlay
}
