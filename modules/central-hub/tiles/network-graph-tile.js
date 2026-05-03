"use strict"

/**
 * Network Graph + Time-Scrubber tile — Slice 25 surface.
 *
 * Renders a force-directed full-network view inside the tile body when
 * expanded. Hubs are larger, our hubs accent-coloured; edges thickened
 * by frequency. A scrubber strip below the canvas lets the user
 * broadcast `view-time:scrubbed` on the bus so other panels (RA panel,
 * briefing tile) can re-render against a prior weekly snapshot.
 *
 * The tile is read-only — clicking a node deep-links to RA panel filtered
 * by hub via `focus-route` (existing bus event, already consumed by RA).
 *
 * Refresh triggers:
 *   - on tile expand (initial paint + settle)
 *   - on `view-time:scrubbed` event (no re-layout — graph stays put)
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    const SETTLE_ITERS_PER_FRAME = 4
    const MAX_SETTLE_FRAMES      = 60

    function _fmtWeekLabel(entry) {
        if (!entry) return "live"
        if (entry.weekId) return entry.weekId
        if (entry.ts) {
            const d = new Date(Number(entry.ts))
            return d.toISOString().slice(0, 10)
        }
        return "live"
    }

    class CentralHubNetworkGraphTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "network-graph"
            this.title = "Network graph"
            this.section = "tools"
            this.priority = 12
            this.requiresAirline = true
            this._state = null
            this._raf = null
            this._settleFrames = 0
            this._scrubberWeeks = null
            this._wired = false
        }

        watchedStorageKeys() { return [] }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    window.CentralHubBus.on("view-time:scrubbed", () => {
                        const T = window.AESTokens
                        if (this._scrubberLabel) {
                            const cur = window.AesStrategyTimeScrubber
                                && window.AesStrategyTimeScrubber.currentState
                                && window.AesStrategyTimeScrubber.currentState()
                            this._scrubberLabel.textContent = "Viewing: " + _fmtWeekLabel(cur)
                            this._scrubberLabel.style.color = (cur && cur.weekId)
                                ? (T && T.color.amber || "#f59e0b")
                                : (T && T.color.slate || "#94a3b8")
                        }
                    })
                }
            } catch (_) {}
        }

        async loadStatus() {
            this._wireBus()
            const KIND = window.CentralHubStatusBadges.KIND
            const snap = await this._loadSnapshot()
            if (!snap || !Array.isArray(snap.hubs) || !snap.hubs.length) {
                return {badge: "—", badgeKind: KIND.MUTED, summary: "no snapshot yet"}
            }
            let nodeCount = 0
            for (const h of snap.hubs) {
                nodeCount++
                const br = (h && Array.isArray(h.byRoute)) ? h.byRoute : []
                nodeCount += br.length
            }
            return {badge: String(nodeCount), badgeKind: KIND.MUTED,
                summary: snap.hubs.length + " hubs · " + nodeCount + " nodes"}
        }

        async _loadSnapshot() {
            try {
                if (window.AesStrategy && typeof window.AesStrategy.snapshot === "function") {
                    return await window.AesStrategy.snapshot({})
                }
            } catch (e) {
                console.warn("[network-graph tile] snapshot fetch failed", e)
            }
            return null
        }

        async renderBody(_ctx, hostEl) {
            const T = window.AESTokens
            hostEl.textContent = ""
            this._stopSettle()

            const view = window.AesStrategyNetworkGraphView
            if (!view) {
                const p = document.createElement("p")
                p.textContent = "network-graph-view module not loaded"
                p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";font-size:11px"
                hostEl.appendChild(p)
                return
            }

            const snap = await this._loadSnapshot()
            if (!snap || !Array.isArray(snap.hubs) || !snap.hubs.length) {
                const p = document.createElement("p")
                p.textContent = "No snapshot available — open RA panel on a populated airline first."
                p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";font-size:11px"
                hostEl.appendChild(p)
                return
            }

            // Canvas
            const w = 720, h = 380
            const canvas = document.createElement("canvas")
            canvas.width = w; canvas.height = h
            canvas.style.cssText = "display:block;width:100%;height:auto;"
                + "background:" + (T && T.color.bone || "#0b1220") + ";"
                + "border:1px solid " + (T && T.color.paperRule || "rgba(148,163,184,0.25)")
            hostEl.appendChild(canvas)
            this._canvas = canvas

            // Build state + settle in animation loop.
            this._state = view.build(snap, {w, h})
            this._settleFrames = 0
            const ctx2d = canvas.getContext("2d")
            const tileT0 = performance.now()
            const animate = () => {
                const v = window.AesStrategyNetworkGraphView
                if (!v || !this._state) return
                for (let i = 0; i < SETTLE_ITERS_PER_FRAME; i++) v.step(this._state)
                this._draw(ctx2d, this._state, T)
                this._settleFrames++
                if (this._state.temperature > 0.05 && this._settleFrames < MAX_SETTLE_FRAMES) {
                    this._raf = requestAnimationFrame(animate)
                } else {
                    this._raf = null
                    try {
                        if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                            window.CentralHubBus.emit("data:strategy:network:rendered", {
                                nodeCount: this._state.nodes.length,
                                edgeCount: this._state.edges.length,
                                durationMs: performance.now() - tileT0
                            })
                        }
                    } catch (_) {}
                }
            }
            this._raf = requestAnimationFrame(animate)

            // Click-to-focus — basic hit test against node positions.
            canvas.addEventListener("click", (e) => {
                if (!this._state) return
                const rect = canvas.getBoundingClientRect()
                const sx = canvas.width / rect.width
                const sy = canvas.height / rect.height
                const x = (e.clientX - rect.left) * sx
                const y = (e.clientY - rect.top)  * sy
                let hit = null, best = 200
                for (const node of this._state.nodes) {
                    const d = (node.x - x) * (node.x - x) + (node.y - y) * (node.y - y)
                    if (d < best) { best = d; hit = node }
                }
                if (!hit) return
                try {
                    if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                        window.CentralHubBus.emit("focus-route", {hub: hit.iata, dest: null})
                    }
                } catch (_) {}
            })

            // Time-scrubber strip below canvas.
            await this._renderScrubber(hostEl, T)
        }

        _draw(ctx, state, T) {
            const w = state.bounds.w, h = state.bounds.h
            ctx.clearRect(0, 0, w, h)
            // Edges first.
            ctx.lineCap = "round"
            for (const edge of state.edges) {
                const a = state.nodes.find(n => n.iata === edge.from)
                const b = state.nodes.find(n => n.iata === edge.to)
                if (!a || !b) continue
                const lf = Math.max(0, Math.min(1, edge.lf))
                const tone = lf >= 0.75 ? (T && T.color.moss   || "#34d399")
                          : lf >= 0.55 ? (T && T.color.amber  || "#facc15")
                          :              (T && T.color.crimson || "#f87171")
                ctx.strokeStyle = tone
                ctx.globalAlpha = 0.55
                ctx.lineWidth = Math.max(0.5, Math.min(4, Math.log1p(edge.frequency)))
                ctx.beginPath()
                ctx.moveTo(a.x, a.y)
                ctx.lineTo(b.x, b.y)
                ctx.stroke()
            }
            ctx.globalAlpha = 1
            // Nodes.
            for (const node of state.nodes) {
                const r = node.isOurHub ? 8 : 4
                ctx.fillStyle = node.isOurHub
                    ? (T && T.color.cobalt || "#60a5fa")
                    : (T && T.color.slate  || "#94a3b8")
                ctx.beginPath()
                ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
                ctx.fill()
                if (node.isOurHub) {
                    ctx.fillStyle = (T && T.color.text || "#e2e8f0")
                    ctx.font = "10px " + (T && T.font.mono || "monospace")
                    ctx.fillText(node.iata, node.x + r + 2, node.y + 3)
                }
            }
        }

        async _renderScrubber(hostEl, T) {
            const scrubberWrap = document.createElement("div")
            scrubberWrap.style.cssText = "margin-top:10px;display:flex;flex-direction:column;gap:6px"
            const label = document.createElement("div")
            label.style.cssText = "font-size:10.5px;color:" + (T && T.color.slate || "#94a3b8") + ";"
            const cur = window.AesStrategyTimeScrubber
                && window.AesStrategyTimeScrubber.currentState()
            label.textContent = "Viewing: " + _fmtWeekLabel(cur)
            this._scrubberLabel = label
            scrubberWrap.appendChild(label)

            const row = document.createElement("div")
            row.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap"

            const scrubber = window.AesStrategyTimeScrubber
            if (!scrubber) {
                const p = document.createElement("span")
                p.style.cssText = "font-size:11px;color:" + (T && T.color.slate || "#94a3b8")
                p.textContent = "Time-scrubber module not loaded"
                row.appendChild(p)
                scrubberWrap.appendChild(row)
                hostEl.appendChild(scrubberWrap)
                return
            }
            const weeks = await scrubber.listAvailable()
            this._scrubberWeeks = weeks

            if (!weeks.length) {
                const p = document.createElement("span")
                p.style.cssText = "font-size:11px;color:" + (T && T.color.slate || "#94a3b8")
                p.textContent = "No accounting snapshots — scrub disabled"
                row.appendChild(p)
                scrubberWrap.appendChild(row)
                hostEl.appendChild(scrubberWrap)
                return
            }

            // Live chip + per-week chips, newest first, cap 12.
            const chips = [{weekId: null, ts: null, label: "live"}]
                .concat(weeks.slice(0, 11).map(w => ({weekId: w.weekId, ts: w.ts,
                    label: _fmtWeekLabel(w)})))
            for (const c of chips) {
                const chip = document.createElement("button")
                chip.type = "button"
                chip.textContent = c.label
                chip.style.cssText = "background:transparent;border:1px solid "
                    + (T && T.color.slate || "rgba(148,163,184,0.35)")
                    + ";color:" + (T && T.color.text || "#e2e8f0")
                    + ";padding:2px 8px;border-radius:3px;font-size:10.5px;cursor:pointer"
                chip.addEventListener("click", () => {
                    if (c.weekId == null) scrubber.reset()
                    else scrubber.scrubTo({weekId: c.weekId, ts: c.ts})
                })
                row.appendChild(chip)
            }
            scrubberWrap.appendChild(row)
            hostEl.appendChild(scrubberWrap)
        }

        _stopSettle() {
            if (this._raf) {
                try { cancelAnimationFrame(this._raf) } catch (_) {}
                this._raf = null
            }
        }

        dispose() {
            this._stopSettle()
            if (typeof super.dispose === "function") super.dispose()
        }
    }

    window.CentralHubNetworkGraphTile = CentralHubNetworkGraphTile
    if (window.CentralHubTileRegistry
            && typeof window.CentralHubTileRegistry.register === "function") {
        window.CentralHubTileRegistry.register({
            id:       "network-graph",
            section:  "tools",
            priority: 12,
            factory:  () => new CentralHubNetworkGraphTile()
        })
    }
})()
