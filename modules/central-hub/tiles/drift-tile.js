"use strict"

/**
 * Conductor Drift tile — K14 surface.
 *
 * One row per scenario whose CUSUM detector is currently in `drifted=true`,
 * plus a recent-history list of resolved proposals. Each row shows the
 * residual sparkline + polarity badge + Accept/Dismiss buttons. Accept
 * routes through threshold-store with `dryRunOnly:true` by default per
 * §4.18; user must flip the per-scenario gate explicitly to apply live.
 *
 * Refresh triggers:
 *   - on `signal:conductor:drift` bus event
 *   - on `data:conductor:drift:proposal:created` bus event
 *   - on storage change at `aesConductor:drift:` or `aesConductor:driftProposals:`
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    function _resolveHost() {
        if (typeof AES === "undefined") return null
        let server = ""
        try { server = AES.getServerName ? (AES.getServerName() || "") : "" } catch (_) { server = "" }
        if (!server) return null
        let airline = ""
        try {
            const code = AES.getAirlineCode ? AES.getAirlineCode() : null
            airline = (code && code.code) ? code.code : ""
        } catch (_) { airline = "" }
        return {server, airline}
    }

    function _fmtAge(ms) {
        if (!isFinite(ms) || ms <= 0) return "—"
        if (ms < 60_000)     return Math.max(1, Math.floor(ms / 1000)) + "s"
        if (ms < 3_600_000)  return Math.floor(ms / 60_000) + "m"
        if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h"
        return Math.floor(ms / 86_400_000) + "d"
    }

    function _sparkline(values, T, opts) {
        opts = opts || {}
        const w = opts.width || 110
        const h = opts.height || 18
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
        svg.setAttribute("width", w)
        svg.setAttribute("height", h)
        svg.setAttribute("viewBox", "0 0 " + w + " " + h)
        if (!Array.isArray(values) || !values.length) return svg
        let min = Infinity, max = -Infinity
        for (const v of values) {
            if (typeof v !== "number" || !isFinite(v)) continue
            if (v < min) min = v
            if (v > max) max = v
        }
        if (!isFinite(min) || !isFinite(max)) return svg
        const span = (max - min) || 1
        // baseline at zero if zero is in range, else mid
        const zero = (min < 0 && max > 0) ? (h - ((0 - min) / span) * h) : (h / 2)
        const baseline = document.createElementNS("http://www.w3.org/2000/svg", "line")
        baseline.setAttribute("x1", "0"); baseline.setAttribute("x2", String(w))
        baseline.setAttribute("y1", String(zero)); baseline.setAttribute("y2", String(zero))
        baseline.setAttribute("stroke", "rgba(148,163,184,0.4)")
        baseline.setAttribute("stroke-width", "1")
        svg.appendChild(baseline)
        const dx = w / Math.max(1, values.length - 1)
        let d = ""
        for (let i = 0; i < values.length; i++) {
            const v = values[i]
            const x = i * dx
            const y = h - ((v - min) / span) * h
            d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " "
        }
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
        path.setAttribute("d", d.trim())
        path.setAttribute("fill", "none")
        path.setAttribute("stroke", opts.color || "#facc15")
        path.setAttribute("stroke-width", "1.5")
        svg.appendChild(path)
        return svg
    }

    class CentralHubDriftTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "conductor-drift"
            this.title = "Drift detection"
            this.section = "tools"
            this.priority = 8
            this.requiresAirline = false
            this._cache = null
            this._wired = false
        }

        watchedStorageKeys() {
            return ["aesConductor:drift:", "aesConductor:driftProposals:"]
        }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    const handler = () => { this._cache = null; this.refresh && this.refresh() }
                    window.CentralHubBus.on("signal:conductor:drift", handler)
                    window.CentralHubBus.on("data:conductor:drift:proposal:created", handler)
                    window.CentralHubBus.on("data:conductor:threshold:applied", handler)
                }
            } catch (_) { /* noop */ }
        }

        async _read(key, fallback) {
            try {
                const blob = await chrome.storage.local.get([key])
                const v = blob && blob[key]
                return (v != null) ? v : fallback
            } catch (_) { return fallback }
        }

        _gateKey(host) {
            return "aesConductor:driftSettings:" + host.server + ":" + (host.airline || "")
        }

        async _liveEnabled(host) {
            const blob = await this._read(this._gateKey(host), {})
            return !!(blob && blob.liveApplyEnabled)
        }

        async _setLiveEnabled(host, value) {
            const key = this._gateKey(host)
            const blob = (await this._read(key, {})) || {}
            blob.liveApplyEnabled = !!value
            blob.liveApplyEnabledAt = Date.now()
            try { await chrome.storage.local.set({[key]: blob}) } catch (_) { /* noop */ }
        }

        async _compute() {
            this._wireBus()
            const host = _resolveHost()
            if (!host) return {drifted: [], proposals: [], reason: "no host", liveEnabled: false}
            const stateBlob = await this._read("aesConductor:drift:" + host.server + ":" + (host.airline || ""), {})
            const proposals = await this._read("aesConductor:driftProposals:" + host.server + ":" + (host.airline || ""), [])
            const liveEnabled = await this._liveEnabled(host)
            const drifted = []
            for (const id of Object.keys(stateBlob)) {
                const s = stateBlob[id]
                if (s && s.drifted) drifted.push(Object.assign({scenarioId: id}, s))
            }
            // newest tripping first
            drifted.sort((a, b) => (b.trippedAt || 0) - (a.trippedAt || 0))
            const recent = (proposals || []).slice(-10).reverse()
            return {drifted, proposals: recent, reason: null, liveEnabled}
        }

        async loadStatus() {
            this._cache = await this._compute()
            const KIND = window.CentralHubStatusBadges.KIND
            const n = (this._cache.drifted || []).length
            if (n === 0) {
                const p = (this._cache.proposals || []).length
                if (p === 0) return {badge: "OK", badgeKind: KIND.OK, summary: "No drift detected"}
                return {badge: String(p), badgeKind: KIND.MUTED, summary: p + " resolved proposal" + (p === 1 ? "" : "s")}
            }
            return {badge: n + " ⚠", badgeKind: KIND.WARN, summary: n + " scenario" + (n === 1 ? "" : "s") + " drifted"}
        }

        async renderBody(_ctx, hostEl) {
            const T = window.AESTokens
            hostEl.textContent = ""
            if (!this._cache) this._cache = await this._compute()
            const {drifted, proposals, reason} = this._cache

            if (!drifted.length && !proposals.length) {
                const p = document.createElement("p")
                p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";margin:0;font-size:11px;line-height:1.5"
                p.textContent = reason || "No drift signals. The CUSUM watchers run on every K10 verdict; trips appear here."
                hostEl.appendChild(p)
                return
            }

            if (drifted.length) {
                const h = document.createElement("div")
                h.style.cssText = "font-size:11px;font-weight:600;margin-bottom:6px;color:" + (T && T.color.text || "#e2e8f0")
                h.textContent = "Currently drifting"
                hostEl.appendChild(h)
                for (const e of drifted) hostEl.appendChild(this._renderDriftRow(e, T))
            }

            if (proposals.length) {
                const h2 = document.createElement("div")
                h2.style.cssText = "font-size:11px;font-weight:600;margin:10px 0 6px;color:" + (T && T.color.text || "#e2e8f0")
                h2.textContent = "Recent proposals"
                hostEl.appendChild(h2)
                for (const p of proposals) hostEl.appendChild(this._renderProposalRow(p, T))
            }

            const foot = document.createElement("div")
            foot.style.cssText = "margin-top:8px;font-size:10px;color:" + (T && T.color.slate || "#94a3b8") + ";line-height:1.4"
            foot.textContent = this._cache.liveEnabled
                ? "Live overlay ENABLED for this airline. Live applies write to aesConductor:thresholds; scenarios fire at the overlay value on next tick."
                : "Apply gate is dry-run by default. Click 'Apply (live)' to enable per-airline live overlay (one-time confirm)."
            hostEl.appendChild(foot)
        }

        _renderDriftRow(entry, T) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(248,113,113,0.08);"
                + "border-left:3px solid " + (entry.polarity === "pos" ? "#f97316" : "#ef4444")
                + ";border-radius:3px;margin-bottom:4px"
            const name = document.createElement("div")
            name.style.cssText = "font-size:11px;font-weight:600;flex:0 0 auto;min-width:120px"
            name.textContent = entry.scenarioId
            row.appendChild(name)

            const spark = _sparkline(entry.window || [], T, {color: entry.polarity === "pos" ? "#f97316" : "#ef4444"})
            spark.style.cssText = "flex:0 0 110px"
            row.appendChild(spark)

            const meta = document.createElement("div")
            meta.style.cssText = "flex:1 1 auto;font-size:10.5px;color:" + (T && T.color.slate || "#94a3b8") + ";line-height:1.3"
            meta.innerHTML = "<div>polarity " + (entry.polarity || "—") + " · mag " + (entry.magnitude || 0).toFixed(2) + "</div>"
                + "<div>tripped " + _fmtAge(Date.now() - (entry.trippedAt || 0)) + " ago</div>"
            row.appendChild(meta)
            return row
        }

        _renderProposalRow(p, T) {
            const row = document.createElement("div")
            row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(148,163,184,0.05);"
                + "border-radius:3px;margin-bottom:4px"
            const name = document.createElement("div")
            name.style.cssText = "font-size:11px;font-weight:600;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis"
            name.textContent = p.scenarioId + " · " + p.key
            name.title = p.reason || ""
            row.appendChild(name)
            const delta = document.createElement("div")
            delta.style.cssText = "font-size:10.5px;font-family:" + (T && T.font && T.font.mono || "monospace")
                + ";color:" + (T && T.color.text || "#e2e8f0")
            delta.textContent = (p.current != null ? p.current : "—") + " → " + (p.proposed != null ? p.proposed : "—")
            row.appendChild(delta)

            const dryBtn = document.createElement("button")
            dryBtn.type = "button"
            dryBtn.textContent = p.accepted ? "Previewed" : "Apply (dry-run)"
            dryBtn.disabled = !!p.accepted
            dryBtn.style.cssText = "background:transparent;border:1px solid " + (T && T.color.slate || "rgba(148,163,184,0.35)")
                + ";color:" + (T && T.color.text || "#e2e8f0")
                + ";padding:2px 8px;border-radius:3px;font-size:10.5px;cursor:" + (p.accepted ? "default" : "pointer")
            dryBtn.addEventListener("click", async () => {
                if (p.accepted) return
                const host = _resolveHost()
                const ts = window.AesConductorThresholdStore
                if (!host || !ts) return
                await ts.apply(host, p.scenarioId, p.key, p.proposed,
                               {enabled: false, dryRun: true, source: "drift"})
                p.accepted = true
                this._cache = null
                this.refresh && this.refresh()
            })
            row.appendChild(dryBtn)

            const liveBtn = document.createElement("button")
            liveBtn.type = "button"
            liveBtn.textContent = p.appliedLive ? "Live ✓" : "Apply (live)"
            liveBtn.disabled = !!p.appliedLive
            liveBtn.style.cssText = "background:transparent;border:1px solid " + (p.appliedLive ? "#34d399" : "#f97316")
                + ";color:" + (p.appliedLive ? "#34d399" : "#f97316")
                + ";padding:2px 8px;border-radius:3px;font-size:10.5px;margin-left:4px;cursor:" + (p.appliedLive ? "default" : "pointer")
            liveBtn.title = "Writes the proposed threshold to the overlay; scenarios fire at the new value on the next tick."
            liveBtn.addEventListener("click", async () => {
                if (p.appliedLive) return
                const host = _resolveHost()
                const ts = window.AesConductorThresholdStore
                if (!host || !ts) return
                let enabled = await this._liveEnabled(host)
                if (!enabled) {
                    const ok = window.confirm(
                        "Enable LIVE threshold overlays for " + host.server + "/" + (host.airline || "(global)") + "?\n\n"
                        + "Future drift proposals on this airline will write to aesConductor:thresholds; "
                        + "scenarios will fire at the overlay values until cleared. Reversible: clear the per-airline "
                        + "blob in DevTools storage to revert.\n\n"
                        + "First proposal applied: " + p.scenarioId + "." + p.key + " = " + p.proposed
                    )
                    if (!ok) return
                    await this._setLiveEnabled(host, true)
                    enabled = true
                }
                await ts.apply(host, p.scenarioId, p.key, p.proposed,
                               {enabled: true, dryRun: false, source: "drift-live"})
                p.appliedLive = true
                p.accepted = true
                this._cache = null
                this.refresh && this.refresh()
            })
            row.appendChild(liveBtn)
            return row
        }
    }

    if (typeof window !== "undefined") {
        window.CentralHubDriftTile = CentralHubDriftTile
        if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
            window.CentralHubTileRegistry.register({
                id:       "conductor-drift",
                section:  "tools",
                priority: 8,
                factory:  () => new CentralHubDriftTile()
            })
        }
    }
})()
