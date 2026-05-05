"use strict"

/**
 * WorldViewWorldMap — equirectangular SVG of the network with bubbles
 * for each destination, sized by network.destination.sizeWeight,
 * colored by competition pressure, glyph by carrier class.
 *
 * render(host, network, opts)
 *   opts: {height?, onPick?(dest), onPickEnterprise?(enterpriseId, dest)}
 *
 * Geometry: SVG viewBox "0 0 1000 500" (2:1 equirectangular). The host
 * is sized via CSS — width 100%, height as opts.height or 280px. The
 * SVG scales to fit. Coordinates come from WorldViewAirportCoords.
 *
 * Hub bubble is drawn last and ringed so it's always visible. Missing-
 * coordinate destinations are surfaced in a footer note.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewWorldMap) return

    const VW = 1000
    const VH = 500

    function _project(lat, lon) {
        const x = (Number(lon) + 180) / 360
        const y = (90 - Number(lat)) / 180
        return {
            x: Math.max(0, Math.min(1, x)) * VW,
            y: Math.max(0, Math.min(1, y)) * VH
        }
    }

    function _radius(sizeWeight, maxSizeWeight) {
        if (!isFinite(sizeWeight) || sizeWeight <= 0) return 3
        const s = maxSizeWeight > 0 ? sizeWeight / maxSizeWeight : 0
        // sqrt scaling so area is proportional, not radius.
        return 4 + Math.sqrt(Math.max(0, Math.min(1, s))) * 14
    }

    function _svg(tag, attrs, children) {
        const NS = "http://www.w3.org/2000/svg"
        const el = document.createElementNS(NS, tag)
        if (attrs) {
            for (const k in attrs) el.setAttribute(k, attrs[k])
        }
        if (children) {
            for (const c of children) if (c) el.appendChild(c)
        }
        return el
    }

    function _graticule() {
        const T = window.AESTokens
        const stroke = T.color.paperRule
        const heavy = T.color.slate
        const g = _svg("g", {opacity: "0.5"})

        // Latitude lines every 30°: y = (90 - lat) / 180 * VH
        for (let lat = -60; lat <= 60; lat += 30) {
            const y = (90 - lat) / 180 * VH
            const ln = _svg("line", {
                x1: "0", y1: y, x2: VW, y2: y,
                stroke: lat === 0 ? heavy : stroke,
                "stroke-width": lat === 0 ? "1" : "0.5"
            })
            g.appendChild(ln)
        }
        // Longitude lines every 30°.
        for (let lon = -150; lon <= 150; lon += 30) {
            const x = (lon + 180) / 360 * VW
            const ln = _svg("line", {
                x1: x, y1: "0", x2: x, y2: VH,
                stroke: lon === 0 ? heavy : stroke,
                "stroke-width": lon === 0 ? "1" : "0.5"
            })
            g.appendChild(ln)
        }
        return g
    }

    function _regionLabels() {
        const T = window.AESTokens
        const labels = [
            {text: "N AMERICA", lat: 50, lon: -100},
            {text: "S AMERICA", lat: -20, lon: -60},
            {text: "EUROPE",    lat: 55, lon: 15},
            {text: "AFRICA",    lat: 0,  lon: 20},
            {text: "ASIA",      lat: 50, lon: 100},
            {text: "OCEANIA",   lat: -25, lon: 140}
        ]
        const g = _svg("g", {opacity: "0.35"})
        for (const l of labels) {
            const p = _project(l.lat, l.lon)
            const t = _svg("text", {
                x: p.x, y: p.y,
                fill: T.color.slate,
                "font-family": "monospace",
                "font-size": "11",
                "letter-spacing": "1.5",
                "text-anchor": "middle"
            })
            t.textContent = l.text
            g.appendChild(t)
        }
        return g
    }

    function render(host, network, opts) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        const coords = window.WorldViewAirportCoords
        host.textContent = ""

        const onPick = opts && opts.onPick
        const onPickEnterprise = opts && opts.onPickEnterprise
        const height = (opts && opts.height) || 280

        const wrapper = document.createElement("div")
        wrapper.style.cssText = ws.panelBox()
            + ";position:relative;margin-bottom:" + T.sp[3] + ";"

        const titleContainer = document.createElement("div")
        titleContainer.style.cssText = "display:flex; justify-content:space-between; align-items:center;"

        const title = document.createElement("h4")
        title.style.cssText = ws.paneTitle()
        title.textContent = "WORLD MAP — destinations sized by frequency × competition"
        titleContainer.appendChild(title)

        // Map toggle
        const toggleContainer = document.createElement("div")
        toggleContainer.style.cssText = "display:flex; gap:8px; font-size:10px; font-family:monospace;"
        const styles = [
            { id: "vintage", label: "VINTAGE" },
            { id: "dark", label: "DARK" },
            { id: "vanilla", label: "VANILLA" }
        ];

        let currentMapStyle = localStorage.getItem("aes_map_style") || "vintage";

        styles.forEach(s => {
            const btn = document.createElement("button")
            btn.textContent = s.label
            btn.style.cssText = "background:none; border:1px solid #ccc; cursor:pointer; padding:2px 6px; border-radius:3px;"
            if (s.id === currentMapStyle) {
                btn.style.background = "#ccc";
                btn.style.color = "#000";
            } else {
                btn.style.color = T.color.slate || "#666";
            }
            btn.addEventListener("click", () => {
                localStorage.setItem("aes_map_style", s.id);
                // trigger re-render
                render(host, network, opts);
            });
            toggleContainer.appendChild(btn)
        });

        titleContainer.appendChild(toggleContainer)
        wrapper.appendChild(titleContainer)

        // SVG canvas
        const svgWrap = document.createElement("div")
        svgWrap.style.cssText = "position:relative;width:100%;height:" + height + "px;"

        const svg = _svg("svg", {
            viewBox: "0 0 " + VW + " " + VH,
            width: "100%",
            height: "100%",
            preserveAspectRatio: "xMidYMid meet"
        })
        svg.style.background = T.color.bone2;
        // Background map handling
        const mapStyle = localStorage.getItem("aes_map_style") || "vintage";
        function updateMapBackground() {
            if (mapStyle === "vintage") {
                svg.style.backgroundImage = "url(" + chrome.runtime.getURL("images/vintage-map.jpg") + ")";
                svg.style.backgroundSize = "cover";
                svg.style.backgroundPosition = "center";
            } else if (mapStyle === "dark") {
                svg.style.backgroundImage = "url(" + chrome.runtime.getURL("images/vintage-map-dark.svg") + ")";
                svg.style.backgroundSize = "cover";
                svg.style.backgroundPosition = "center";
            } else {
                svg.style.backgroundImage = "none";
                svg.style.background = T.color.bone2;
            }
        }
        updateMapBackground();
        svg.style.border = T.geom.bw1 + " solid " + T.color.paperRule

        svg.appendChild(_graticule())
        svg.appendChild(_regionLabels())

        // Tooltip element (in DOM, positioned over svg)
        const tooltip = document.createElement("div")
        tooltip.style.cssText = [
            "position:absolute",
            "pointer-events:none",
            "padding:" + T.sp[1] + " " + T.sp[2],
            "background:" + T.color.oxide,
            "color:" + T.color.bone,
            "font-family:" + T.font.mono,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.mono,
            "border-radius:" + T.geom.radius,
            "white-space:nowrap",
            "z-index:" + T.z.popover,
            "transition:opacity " + T.tr.fast,
            "opacity:0",
            "transform:translate(-50%, -100%)"
        ].join(";")
        svgWrap.appendChild(tooltip)

        function showTooltip(text, clientX, clientY) {
            const r = svgWrap.getBoundingClientRect()
            tooltip.textContent = text
            tooltip.style.left = (clientX - r.left) + "px"
            tooltip.style.top = (clientY - r.top - 6) + "px"
            tooltip.style.opacity = "1"
        }
        function hideTooltip() { tooltip.style.opacity = "0" }

        // Compute max sizeWeight for radius scaling.
        const dests = (network && Array.isArray(network.destinations)) ? network.destinations : []
        let maxSize = 0
        for (const d of dests) if (d.sizeWeight > maxSize) maxSize = d.sizeWeight

        // Track missing coords for the footer note.
        const missing = []
        const bubbles = _svg("g", {})
        let hubBubble = null

        // Hub origin marker — use the hub IATA from network.
        const hubIata = (network && network.hub) || ""

        // First pass: routes (skip the hub itself; render at the end).
        for (const d of dests) {
            if (!d || !d.dest) continue
            const c = coords && coords.get ? coords.get(d.dest) : null
            if (!c) { missing.push(d.dest); continue }
            const p = _project(c.lat, c.lon)
            const r = _radius(d.sizeWeight, maxSize)
            const press = ws.pressureColor(d.competition && d.competition.score)
            const glyph = ws.carrierGlyph(d.carrierClass)

            const grp = _svg("g", {
                "data-dest": d.dest,
                cursor: "pointer",
                style: "transition:opacity " + T.tr.fast
            })
            const circle = _svg("circle", {
                cx: p.x, cy: p.y, r: r,
                fill: press.bg,
                stroke: press.border,
                "stroke-width": d.watchlisted ? "1.5" : "0.8"
            })
            grp.appendChild(circle)
            // Carrier glyph centered.
            const txt = _svg("text", {
                x: p.x, y: p.y + 3.5,
                fill: glyph.color,
                "font-family": "monospace",
                "font-size": Math.max(7, Math.min(12, r)),
                "text-anchor": "middle",
                "pointer-events": "none"
            })
            txt.textContent = glyph.char
            grp.appendChild(txt)

            // IATA label below.
            if (r >= 7) {
                const lbl = _svg("text", {
                    x: p.x, y: p.y + r + 9,
                    fill: T.color.oxide2,
                    "font-family": "monospace",
                    "font-size": "9",
                    "letter-spacing": "0.5",
                    "text-anchor": "middle",
                    "pointer-events": "none"
                })
                lbl.textContent = d.dest
                grp.appendChild(lbl)
            }

            grp.addEventListener("mouseenter", (e) => {
                grp.style.opacity = "0.85"
                circle.setAttribute("stroke-width", "2")
                const tip = d.dest
                    + (d.destName ? " · " + d.destName : "")
                    + " · " + d.weeklyFlights + "x/wk"
                    + " · pressure " + Math.round((d.competition.score || 0) * 100) + "%"
                    + (d.competition.dominantCarrier ? " · vs " + d.competition.dominantCarrier : "")
                showTooltip(tip, e.clientX, e.clientY)
            })
            grp.addEventListener("mousemove", (e) => {
                showTooltip(tooltip.textContent, e.clientX, e.clientY)
            })
            grp.addEventListener("mouseleave", () => {
                grp.style.opacity = "1"
                circle.setAttribute("stroke-width", d.watchlisted ? "1.5" : "0.8")
                hideTooltip()
            })
            grp.addEventListener("click", () => {
                if (onPick) onPick(d)
                if (onPickEnterprise && d.competition && d.competition.dominantEnterpriseId) {
                    onPickEnterprise(d.competition.dominantEnterpriseId, d)
                }
            })
            bubbles.appendChild(grp)
        }

        // Hub marker — drawn last so it sits on top.
        if (hubIata) {
            const hc = coords && coords.get ? coords.get(hubIata) : null
            if (hc) {
                const p = _project(hc.lat, hc.lon)
                const grp = _svg("g", {})
                const ring = _svg("circle", {
                    cx: p.x, cy: p.y, r: 12,
                    fill: "none",
                    stroke: T.color.rust,
                    "stroke-width": "1.5",
                    "stroke-dasharray": "3 2"
                })
                const dot = _svg("circle", {
                    cx: p.x, cy: p.y, r: 5,
                    fill: T.color.rust,
                    stroke: T.color.bone,
                    "stroke-width": "1.2"
                })
                const lbl = _svg("text", {
                    x: p.x, y: p.y - 16,
                    fill: T.color.rust,
                    "font-family": "monospace",
                    "font-size": "11",
                    "font-weight": "bold",
                    "letter-spacing": "1",
                    "text-anchor": "middle"
                })
                lbl.textContent = hubIata + " ★"
                grp.appendChild(ring)
                grp.appendChild(dot)
                grp.appendChild(lbl)
                hubBubble = grp
            } else {
                missing.push(hubIata + " (hub)")
            }
        }

        svg.appendChild(bubbles)
        if (hubBubble) svg.appendChild(hubBubble)

        svgWrap.insertBefore(svg, tooltip)
        wrapper.appendChild(svgWrap)

        // Legend.
        const legend = document.createElement("div")
        legend.style.cssText = [
            "display:flex",
            "flex-wrap:wrap",
            "align-items:center",
            "gap:" + T.sp[3],
            "margin-top:" + T.sp[1],
            "color:" + T.color.slate,
            "font-family:" + T.font.display,
            "font-size:" + T.fs.micro,
            "letter-spacing:" + T.track.caps,
            "text-transform:uppercase"
        ].join(";")
        const items = [
            {dot: "●", color: T.color.cobalt, label: "OWN"},
            {dot: "★", color: T.color.cobalt, label: "ALLIANCE"},
            {dot: "⇄", color: T.color.amber,  label: "INTERLINE"},
            {dot: "▲", color: T.color.slate,  label: "UNAGREED"},
            {dot: "■", color: T.color.moss,    label: "QUIET"},
            {dot: "■", color: T.color.amber,   label: "CONTESTED"},
            {dot: "■", color: T.color.crimson, label: "FIERCE"}
        ]
        for (const it of items) {
            const span = document.createElement("span")
            span.style.cssText = "display:inline-flex;align-items:center;gap:" + T.sp[1] + ";"
            const dot = document.createElement("span")
            dot.textContent = it.dot
            dot.style.cssText = "color:" + it.color + ";font-family:monospace;font-size:" + T.fs.body + ";"
            const lbl = document.createElement("span")
            lbl.textContent = it.label
            span.append(dot, lbl)
            legend.appendChild(span)
        }
        wrapper.appendChild(legend)

        if (missing.length) {
            const note = document.createElement("div")
            note.style.cssText = "margin-top:" + T.sp[1] + ";color:" + T.color.slate
                + ";font-family:" + T.font.display + ";font-size:" + T.fs.micro + ";"
            const sample = missing.slice(0, 6).join(", ")
            note.textContent = missing.length + " destination" + (missing.length === 1 ? "" : "s")
                + " without coordinates: " + sample + (missing.length > 6 ? ", …" : "")
            wrapper.appendChild(note)
        }

        host.appendChild(wrapper)
    }

    window.WorldViewWorldMap = {render: render}
})()
