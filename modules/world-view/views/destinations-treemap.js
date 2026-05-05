"use strict"

/**
 * WorldViewDestinationsTreemap — vanilla DOM squarified treemap.
 *
 * Bruls–Huijsing–van Wijk algorithm: place items into rows along the
 * shorter side, accept items into the current row while the worst
 * aspect-ratio improves, otherwise commit the row and start a new one
 * along the new shorter side.
 *
 * render(host, network, opts)
 *   opts: {height?, onPick?(dest), onPickEnterprise?(enterpriseId, dest)}
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.WorldViewDestinationsTreemap) return

    /**
     * Layout `items` (each with `.value > 0`) into the rectangle
     * (x, y, w, h). Returns array of {item, rect: {x,y,w,h}}.
     */
    function _squarify(items, x, y, w, h) {
        const total = items.reduce((s, it) => s + Math.max(0, it.value || 0), 0)
        const out = []
        if (!total || w <= 0 || h <= 0) return out
        // Scale values to the available area.
        const scale = (w * h) / total
        const queue = items.map(it => ({item: it, value: Math.max(0, (it.value || 0) * scale)}))

        let cx = x, cy = y, cw = w, ch = h

        while (queue.length) {
            const short = Math.min(cw, ch)
            const row = []
            let rowSum = 0
            let bestRatio = Infinity

            // Greedily extend the row while worst aspect ratio improves.
            while (queue.length) {
                const next = queue[0]
                const trial = row.concat([next])
                const trialSum = rowSum + next.value
                const trialRatio = _worstRatio(trial, trialSum, short)
                if (row.length === 0 || trialRatio <= bestRatio) {
                    row.push(next)
                    rowSum = trialSum
                    bestRatio = trialRatio
                    queue.shift()
                } else {
                    break
                }
            }

            // Commit the row.
            const long = rowSum / short
            let off = 0
            for (const r of row) {
                const segment = r.value / short
                if (cw <= ch) {
                    out.push({item: r.item, rect: {x: cx + off, y: cy, w: segment, h: long}})
                    off += segment
                } else {
                    out.push({item: r.item, rect: {x: cx, y: cy + off, w: long, h: segment}})
                    off += segment
                }
            }
            // Shrink the canvas.
            if (cw <= ch) {
                cy += long
                ch -= long
            } else {
                cx += long
                cw -= long
            }
        }
        return out
    }

    function _worstRatio(row, sum, short) {
        if (!sum) return Infinity
        let max = 0, min = Infinity
        for (const r of row) {
            if (r.value > max) max = r.value
            if (r.value < min) min = r.value
        }
        const s2 = short * short
        const sumSq = sum * sum
        const ratioA = (s2 * max) / sumSq
        const ratioB = sumSq / (s2 * min)
        return Math.max(ratioA, ratioB)
    }

    function render(host, network, opts) {
        const T = window.AESTokens
        const ws = window.WorldViewStyles
        host.textContent = ""

        const onPick = opts && opts.onPick
        const onPickEnterprise = opts && opts.onPickEnterprise
        const height = (opts && opts.height) || 240

        const wrapper = document.createElement("div")
        wrapper.style.cssText = ws.panelBox() + ";"

        const title = document.createElement("h4")
        title.style.cssText = ws.paneTitle()
        title.textContent = "DESTINATIONS — sized by frequency × competition"
        wrapper.appendChild(title)

        const dests = (network && Array.isArray(network.destinations))
            ? network.destinations.filter(d => d && d.sizeWeight > 0)
            : []

        if (!dests.length) {
            const empty = document.createElement("p")
            empty.style.cssText = "color:" + T.color.slate + ";margin:0;font-family:" + T.font.display + ";font-size:" + T.fs.body + ";"
            empty.textContent = "No destinations to render. Visit /app/com/scheduling/" + ((network && network.hub) || "<HUB>") + " to seed top-routes."
            wrapper.appendChild(empty)
            host.appendChild(wrapper)
            return
        }

        const canvas = document.createElement("div")
        canvas.style.cssText = [
            "position:relative",
            "width:100%",
            "height:" + height + "px",
            "background:" + T.color.bone2,
            "border:" + T.geom.bw1 + " solid " + T.color.paperRule,
            "overflow:hidden"
        ].join(";")
        wrapper.appendChild(canvas)
        host.appendChild(wrapper)

        // Layout in nominal pixel space, then position absolutely.
        const items = dests.map(d => ({
            dest: d,
            value: Math.max(0.0001, d.sizeWeight)
        }))

        // Defer layout until we have a canvas size.
        requestAnimationFrame(() => {
            const r = canvas.getBoundingClientRect()
            const W = Math.max(40, r.width)
            const H = Math.max(40, r.height)
            const placed = _squarify(items, 0, 0, W, H)

            for (const p of placed) {
                const d = p.item && p.item.dest
                if (!d) continue
                const rect = p.rect
                const press = ws.pressureColor(d.competition && d.competition.score)
                const glyph = ws.carrierGlyph(d.carrierClass)

                const tile = document.createElement("div")
                tile.dataset.dest = d.dest
                tile.style.cssText = [
                    "position:absolute",
                    "left:" + rect.x + "px",
                    "top:" + rect.y + "px",
                    "width:" + Math.max(0, rect.w - 1) + "px",
                    "height:" + Math.max(0, rect.h - 1) + "px",
                    "background:" + press.bg,
                    "border:" + T.geom.bw1 + " solid " + press.border,
                    "color:" + press.fg,
                    "cursor:pointer",
                    "padding:2px 4px",
                    "box-sizing:border-box",
                    "font-family:" + T.font.mono,
                    "font-size:" + T.fs.small,
                    "letter-spacing:" + T.track.mono,
                    "overflow:hidden",
                    "transition:filter " + T.tr.fast
                ].join(";")

                // Inner content: IATA + glyph + (mini) freq.
                const minDim = Math.min(rect.w, rect.h)
                if (minDim >= 36) {
                    const code = document.createElement("div")
                    code.textContent = d.dest
                    code.style.cssText = "color:" + T.color.oxide + ";font-weight:bold;"
                    tile.appendChild(code)

                    if (minDim >= 48) {
                        const meta = document.createElement("div")
                        meta.textContent = d.weeklyFlights + "× · " + Math.round((d.competition.score || 0) * 100) + "%"
                        meta.style.cssText = "color:" + T.color.oxide2 + ";font-size:" + T.fs.micro + ";"
                        tile.appendChild(meta)
                    }

                    const corner = document.createElement("div")
                    corner.textContent = glyph.char
                    corner.style.cssText = "position:absolute;top:2px;right:4px;color:" + glyph.color + ";"
                    tile.appendChild(corner)

                    if (d.watchlisted) {
                        const star = document.createElement("div")
                        star.textContent = "★"
                        star.style.cssText = "position:absolute;bottom:2px;right:4px;color:" + T.color.rust + ";"
                        tile.appendChild(star)
                    }
                } else if (minDim >= 16) {
                    const code = document.createElement("div")
                    code.textContent = d.dest
                    code.style.cssText = "color:" + T.color.oxide + ";font-size:" + T.fs.micro + ";"
                    tile.appendChild(code)
                }

                tile.title = d.dest
                    + (d.destName ? " · " + d.destName : "")
                    + " · " + d.weeklyFlights + "x/wk"
                    + " · pressure " + Math.round((d.competition.score || 0) * 100) + "%"
                    + (d.competition.dominantCarrier ? " · vs " + d.competition.dominantCarrier : "")

                tile.addEventListener("mouseenter", () => { tile.style.filter = "brightness(1.08)" })
                tile.addEventListener("mouseleave", () => { tile.style.filter = "none" })
                tile.addEventListener("click", () => {
                    if (onPick) onPick(d)
                    if (onPickEnterprise && d.competition && d.competition.dominantEnterpriseId) {
                        onPickEnterprise(d.competition.dominantEnterpriseId, d)
                    }
                })

                canvas.appendChild(tile)
            }
        })
    }

    window.WorldViewDestinationsTreemap = {render: render}
})()
