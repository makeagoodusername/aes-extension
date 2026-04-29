"use strict"

/**
 * Phase 4 Lane B — region map view for the Fleet Command modal.
 *
 * Pure SVG renderer. One bubble per hub, sized by tail count, colored by
 * the hub's resolved region. Hover surfaces hub / count / region. The
 * Fleet Command panel slots this into the centre column when the user
 * flips the table-vs-map toggle in the filters pane.
 *
 * Equirectangular projection straight from world-view/airport-coords:
 *     x = (lon + 180) / 360 × width
 *     y = (90  - lat) / 180 × height
 *
 * No new storage. No bus events. Read-only against the data the panel
 * already has in memory (the FleetCommandView the aggregator returns).
 *
 * Public API (window.AesRegionMapView):
 *   .render(host, {tails, regions?, onHubClick?, onTailClick?,
 *                  selectedAircraftIds?})
 *   .isAvailable() → bool   // requires WorldViewAirportCoords
 */
;(function () {
    if (window.AesRegionMapView) return

    const W = 720
    const H = 360
    const MARGIN_X = 8
    const MARGIN_Y = 8
    const MIN_R = 4
    const MAX_R = 22

    const PALETTE = [
        "#60a5fa", "#f472b6", "#34d399", "#fbbf24",
        "#a78bfa", "#fb7185", "#22d3ee", "#facc15",
        "#86efac", "#fca5a5", "#c084fc", "#67e8f9"
    ]
    const FALLBACK_COLOR = "#94a3b8"

    function _esc(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    }

    function isAvailable() {
        return typeof window.WorldViewAirportCoords !== "undefined"
            && typeof window.WorldViewAirportCoords.lookup === "function"
    }

    function _project(lat, lon) {
        const x = ((lon + 180) / 360) * (W - MARGIN_X * 2) + MARGIN_X
        const y = ((90 - lat) / 180) * (H - MARGIN_Y * 2) + MARGIN_Y
        return {x, y}
    }

    function _bubbleRadius(count, maxCount) {
        if (!count || !maxCount) return MIN_R
        const t = Math.min(1, count / maxCount)
        return MIN_R + (MAX_R - MIN_R) * Math.sqrt(t)
    }

    function _regionColorMap(regions) {
        const ids = Object.keys(regions || {})
        const out = {}
        ids.forEach((id, i) => { out[id] = PALETTE[i % PALETTE.length] })
        return out
    }

    /**
     * Group tails by hub IATA, retaining a count + the dominant regionId
     * per hub (first-seen wins on ties — stable across re-renders).
     */
    function _aggregateHubs(tails) {
        const by = new Map()
        for (const t of tails || []) {
            if (!t) continue
            const hub = String(t.hub || t.locIata || "").toUpperCase()
            if (!hub) continue
            let entry = by.get(hub)
            if (!entry) {
                entry = {
                    hub,
                    count: 0,
                    tails: [],
                    regionVotes: new Map(),
                    coords: null
                }
                by.set(hub, entry)
            }
            entry.count += 1
            entry.tails.push(t)
            if (t.regionId) {
                entry.regionVotes.set(t.regionId,
                    (entry.regionVotes.get(t.regionId) || 0) + 1)
            }
        }
        for (const entry of by.values()) {
            let best = null, bestVotes = -1
            for (const [regionId, votes] of entry.regionVotes.entries()) {
                if (votes > bestVotes) { best = regionId; bestVotes = votes }
            }
            entry.dominantRegionId = best
            if (isAvailable()) {
                entry.coords = window.WorldViewAirportCoords.lookup(entry.hub) || null
            }
        }
        return Array.from(by.values())
    }

    function _drawGraticule(svg) {
        const lines = []
        for (let lon = -180; lon <= 180; lon += 30) {
            const x = ((lon + 180) / 360) * (W - MARGIN_X * 2) + MARGIN_X
            lines.push('<line x1="' + x.toFixed(1) + '" y1="' + MARGIN_Y
                + '" x2="' + x.toFixed(1) + '" y2="' + (H - MARGIN_Y)
                + '" stroke="rgba(148,163,184,0.10)" stroke-width="0.5"/>')
        }
        for (let lat = -60; lat <= 60; lat += 30) {
            const y = ((90 - lat) / 180) * (H - MARGIN_Y * 2) + MARGIN_Y
            lines.push('<line x1="' + MARGIN_X + '" y1="' + y.toFixed(1)
                + '" x2="' + (W - MARGIN_X) + '" y2="' + y.toFixed(1)
                + '" stroke="rgba(148,163,184,0.10)" stroke-width="0.5"/>')
        }
        // Equator stronger
        const eqY = ((90) / 180) * (H - MARGIN_Y * 2) + MARGIN_Y
        lines.push('<line x1="' + MARGIN_X + '" y1="' + eqY.toFixed(1)
            + '" x2="' + (W - MARGIN_X) + '" y2="' + eqY.toFixed(1)
            + '" stroke="rgba(148,163,184,0.18)" stroke-width="0.5"/>')
        const frame = '<rect x="' + MARGIN_X + '" y="' + MARGIN_Y
            + '" width="' + (W - MARGIN_X * 2) + '" height="' + (H - MARGIN_Y * 2)
            + '" fill="rgba(15,23,42,0.55)" stroke="rgba(148,163,184,0.20)" stroke-width="0.6"/>'
        svg.insertAdjacentHTML("beforeend", frame + lines.join(""))
    }

    function _drawLegend(host, regions, colorMap, hubGroups, hubsWithoutCoords) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;padding:6px 10px 4px;"
            + "font-size:10px;color:#cbd5e1;border-top:1px solid rgba(148,163,184,0.18);"
            + "background:rgba(15,23,42,0.4);"
        const seenRegions = new Set()
        for (const g of hubGroups) {
            if (g.dominantRegionId) seenRegions.add(g.dominantRegionId)
        }
        if (!seenRegions.size) {
            const note = document.createElement("span")
            note.style.cssText = "color:#64748b;font-style:italic;"
            note.textContent = "No regions resolved — assign tails to regions in Settings → Geographic regions."
            wrap.appendChild(note)
        } else {
            for (const regionId of seenRegions) {
                const region = regions && regions[regionId]
                const name = region && region.name ? region.name : regionId
                const color = colorMap[regionId] || FALLBACK_COLOR
                const swatch = document.createElement("span")
                swatch.style.cssText = "display:inline-flex;align-items:center;gap:4px;"
                swatch.innerHTML =
                    '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;'
                    + 'background:' + color + ';"></span>'
                    + '<span>' + _esc(name) + '</span>'
                wrap.appendChild(swatch)
            }
        }
        if (hubsWithoutCoords > 0) {
            const note = document.createElement("span")
            note.style.cssText = "margin-left:auto;color:#fbbf24;font-style:italic;"
            note.textContent = hubsWithoutCoords + " hub"
                + (hubsWithoutCoords === 1 ? "" : "s") + " without coordinates"
            wrap.appendChild(note)
        }
        host.appendChild(wrap)
    }

    /**
     * @param {HTMLElement} host
     * @param {object} opts
     *   - tails:               TailRow[]   required
     *   - regions:             {[id]: {id, name, ...}}  optional
     *   - onHubClick:          (hub, group) => void  optional
     *   - onTailClick:         (tail) => void  optional
     *   - selectedAircraftIds: Set<string> | null  highlights selected tails' hubs
     */
    function render(host, opts) {
        if (!host) return
        host.innerHTML = ""
        const o = opts || {}
        const tails = Array.isArray(o.tails) ? o.tails : []
        const regions = o.regions || {}
        const colorMap = _regionColorMap(regions)
        const selected = (o.selectedAircraftIds instanceof Set) ? o.selectedAircraftIds : null

        if (!isAvailable()) {
            host.innerHTML = '<div style="padding:24px;color:#64748b;font-size:12px;'
                + 'font-style:italic;text-align:center">'
                + 'WorldViewAirportCoords not loaded — manifest order issue.</div>'
            return
        }

        if (!tails.length) {
            host.innerHTML = '<div style="padding:24px;color:#64748b;font-size:12px;'
                + 'font-style:italic;text-align:center">No tails to plot.</div>'
            return
        }

        const groups = _aggregateHubs(tails)
        const withCoords = groups.filter(g => g.coords)
        const without = groups.length - withCoords.length
        const maxCount = withCoords.reduce((acc, g) => Math.max(acc, g.count), 0)

        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;flex-direction:column;height:100%;"

        const svgWrap = document.createElement("div")
        svgWrap.style.cssText = "flex:1 1 auto;display:flex;align-items:center;justify-content:center;"
            + "padding:8px;overflow:hidden;"

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
        svg.setAttribute("viewBox", "0 0 " + W + " " + H)
        svg.setAttribute("width",  "100%")
        svg.style.cssText = "max-width:100%;height:auto;display:block;"
        svgWrap.appendChild(svg)
        wrap.appendChild(svgWrap)

        _drawGraticule(svg)

        // Tooltip layer (HTML, positioned absolutely over the SVG host).
        const tip = document.createElement("div")
        tip.style.cssText = "position:absolute;display:none;background:rgba(15,23,42,0.95);"
            + "color:#e2e8f0;border:1px solid rgba(148,163,184,0.30);border-radius:3px;"
            + "padding:4px 8px;font-size:11px;font-family:ui-monospace,monospace;"
            + "pointer-events:none;z-index:5;white-space:nowrap;"
        wrap.style.position = "relative"
        wrap.appendChild(tip)

        for (const g of withCoords) {
            const {x, y} = _project(g.coords.lat, g.coords.lon)
            const r = _bubbleRadius(g.count, maxCount || g.count)
            const color = colorMap[g.dominantRegionId] || FALLBACK_COLOR
            const isSelected = selected
                ? g.tails.some(t => selected.has(String(t.aircraftId)))
                : false

            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle")
            circle.setAttribute("cx", x.toFixed(1))
            circle.setAttribute("cy", y.toFixed(1))
            circle.setAttribute("r",  r.toFixed(1))
            circle.setAttribute("fill", color)
            circle.setAttribute("fill-opacity", isSelected ? "0.95" : "0.65")
            circle.setAttribute("stroke", isSelected ? "#fbbf24" : "rgba(15,23,42,0.85)")
            circle.setAttribute("stroke-width", isSelected ? "1.6" : "0.7")
            circle.style.cursor = "pointer"

            const regionName = g.dominantRegionId && regions[g.dominantRegionId]
                ? regions[g.dominantRegionId].name : "—"
            const tipText = g.hub + " · " + g.count + " tail"
                + (g.count === 1 ? "" : "s") + " · " + regionName

            circle.addEventListener("mouseenter", (e) => {
                tip.textContent = tipText
                tip.style.display = "block"
            })
            circle.addEventListener("mousemove", (e) => {
                const rect = wrap.getBoundingClientRect()
                tip.style.left = (e.clientX - rect.left + 10) + "px"
                tip.style.top  = (e.clientY - rect.top  + 10) + "px"
            })
            circle.addEventListener("mouseleave", () => {
                tip.style.display = "none"
            })
            circle.addEventListener("click", (e) => {
                e.stopPropagation()
                if (typeof o.onHubClick === "function") {
                    try { o.onHubClick(g.hub, g) }
                    catch (err) { console.warn("[region-map] onHubClick threw", err) }
                }
            })

            svg.appendChild(circle)

            if (g.count > 1 && r >= 10) {
                const txt = document.createElementNS("http://www.w3.org/2000/svg", "text")
                txt.setAttribute("x", x.toFixed(1))
                txt.setAttribute("y", (y + 3).toFixed(1))
                txt.setAttribute("text-anchor", "middle")
                txt.setAttribute("font-size", "9")
                txt.setAttribute("font-family", "ui-monospace,monospace")
                txt.setAttribute("fill", "#0f172a")
                txt.setAttribute("font-weight", "600")
                txt.style.pointerEvents = "none"
                txt.textContent = String(g.count)
                svg.appendChild(txt)
            } else {
                const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text")
                lbl.setAttribute("x", (x + r + 2).toFixed(1))
                lbl.setAttribute("y", (y + 3).toFixed(1))
                lbl.setAttribute("font-size", "9")
                lbl.setAttribute("font-family", "ui-monospace,monospace")
                lbl.setAttribute("fill", "#cbd5e1")
                lbl.style.pointerEvents = "none"
                lbl.textContent = g.hub
                svg.appendChild(lbl)
            }
        }

        _drawLegend(wrap, regions, colorMap, withCoords, without)
        host.appendChild(wrap)
    }

    window.AesRegionMapView = {render, isAvailable}
})()
