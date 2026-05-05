"use strict"

/**
 * Counterfactual Lab tile — Slice 21 surface.
 *
 * Master/detail UI: left rail lists saved forks; right pane shows the
 * selected fork's interventions, deltas, and apply-intervention picker.
 * "Promote to Dispatch" routes through the existing two-gate pipeline
 * (default OFF per §4.18). Read-only otherwise — forking + simulating are
 * pure inspection paths.
 *
 * Slice D2 — Pending intervention footer band:
 *   When `decision-dispatch.readPendingIntervention()` returns a payload
 *   (i.e. a fork was promoted via K11.2 → composeFromIntervention), the
 *   tile renders a footer band showing the staged intervention summary,
 *   dispatch ID, origin fork link, and (gated) Apply controls. The Apply
 *   button is disabled by default per §4.18 gating; clicking it routes
 *   through `decision-dispatch.applyPending` which reuses the existing
 *   apply pipeline. No new POST path is added here.
 */
;(function () {
    if (typeof window === "undefined" || !window.CentralHubTile) return

    function _fmtNum(v) {
        if (v == null || !isFinite(v)) return "—"
        const abs = Math.abs(v)
        if (abs >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M"
        if (abs >= 1_000)     return (v / 1_000).toFixed(1) + "k"
        if (abs >= 1)         return v.toFixed(2)
        return v.toFixed(3)
    }

    class CentralHubCounterfactualLabTile extends window.CentralHubTile {
        constructor() {
            super()
            this.id = "counterfactual-lab"
            this.title = "Counterfactual lab"
            this.section = "tools"
            this.priority = 9
            this.requiresAirline = false
            this._forks = []
            this._selected = null
            this._wired = false
        }

        watchedStorageKeys() {
            return [
                "aesStrategy:forks",
                "aesStrategy:interventionPending"   // Slice D2 — re-render the footer band on stage/clear
            ]
        }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    const handler = () => { this.refresh && this.refresh() }
                    window.CentralHubBus.on("data:strategy:fork:created", handler)
                    window.CentralHubBus.on("data:strategy:fork:simulated", handler)
                    window.CentralHubBus.on("data:strategy:fork:promoted", handler)
                    window.CentralHubBus.on("data:strategy:intervention:pending", handler)
                    window.CentralHubBus.on("data:strategy:dispatch:applied", handler)
                }
            } catch (_) { /* noop */ }
        }

        async _load() {
            this._wireBus()
            const store = window.AesStrategyForkStore
            this._forks = (store && typeof store.list === "function") ? await store.list() : []
            if (!this._selected || !this._forks.find(f => f && f.forkId === this._selected)) {
                this._selected = this._forks[0] && this._forks[0].forkId
            }
            const dd = window.AesStrategyDecisionDispatch
            this._pendingIntervention = (dd && typeof dd.readPendingIntervention === "function")
                ? await dd.readPendingIntervention().catch(() => null)
                : null
        }

        async loadStatus() {
            await this._load()
            const KIND = window.CentralHubStatusBadges.KIND
            const n = this._forks.length
            if (!n) return {badge: "—", badgeKind: KIND.MUTED, summary: "No forks yet"}
            const simmed = this._forks.filter(f => f && f.lastResult && f.lastResult.ok).length
            return {badge: String(n) + "/5", badgeKind: KIND.OK,
                    summary: simmed + " simulated · " + (n - simmed) + " pending"}
        }

        async renderBody(_ctx, hostEl) {
            const T = window.AESTokens
            hostEl.textContent = ""
            await this._load()

            const actions = document.createElement("div")
            actions.style.cssText = "display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap"
            const newBtn = document.createElement("button")
            newBtn.type = "button"
            newBtn.textContent = "New fork"
            newBtn.style.cssText = this._btnStyle(T)
            newBtn.addEventListener("click", () => { this._createFork().catch(() => {}) })
            actions.appendChild(newBtn)
            hostEl.appendChild(actions)

            if (!this._forks.length) {
                const p = document.createElement("p")
                p.style.cssText = "color:" + (T && T.color.slate || "#94a3b8") + ";margin:0;font-size:11px;line-height:1.5"
                p.textContent = "No forks yet. Click New fork to clone the current snapshot for what-if simulation. Up to 5 named forks per account."
                hostEl.appendChild(p)
                return
            }

            const layout = document.createElement("div")
            layout.style.cssText = "display:grid;grid-template-columns:160px 1fr;gap:10px"
            const left = document.createElement("div")
            left.style.cssText = "display:flex;flex-direction:column;gap:4px"
            for (const f of this._forks) {
                const item = document.createElement("button")
                item.type = "button"
                const active = f.forkId === this._selected
                item.style.cssText = "background:" + (active ? "rgba(96,165,250,0.15)" : "transparent")
                    + ";border:1px solid " + (active ? "rgba(96,165,250,0.6)" : (T && T.color.slate || "rgba(148,163,184,0.35)"))
                    + ";color:" + (T && T.color.text || "#e2e8f0")
                    + ";padding:6px 8px;border-radius:3px;text-align:left;cursor:pointer;font-size:10.5px"
                const sim = f.lastResult && f.lastResult.ok ? "✓" : "·"
                item.innerHTML = "<div style='font-weight:600'>" + (f.namedAs || f.forkId) + "</div>"
                    + "<div style='color:#94a3b8'>" + sim + " " + (f.interventions || []).length + " int</div>"
                item.addEventListener("click", () => {
                    this._selected = f.forkId
                    this.refresh && this.refresh()
                })
                left.appendChild(item)
            }
            layout.appendChild(left)

            const right = document.createElement("div")
            right.style.cssText = "display:flex;flex-direction:column;gap:8px"
            const sel = this._forks.find(f => f && f.forkId === this._selected)
            if (sel) right.appendChild(this._renderForkDetail(sel, T))
            layout.appendChild(right)
            hostEl.appendChild(layout)

            const foot = document.createElement("div")
            foot.style.cssText = "margin-top:10px;font-size:10px;color:" + (T && T.color.slate || "#94a3b8")
            foot.textContent = "Forks reuse pure decide-routes scoring on a structuredClone'd snapshot. Simulation projects up to 12 weeks deterministically; no AS POSTs."
            hostEl.appendChild(foot)

            // Slice D2 — pending intervention band (only when promoted).
            if (this._pendingIntervention) {
                hostEl.appendChild(this._renderPendingInterventionBand(this._pendingIntervention, T))
            }
        }

        _renderPendingInterventionBand(pending, T) {
            const root = document.createElement("div")
            const applied = !!pending.applied
            const failed  = !!pending.failed
            const accent  = applied ? "#34d399" : (failed ? "#f87171" : "#facc15")
            root.style.cssText = "margin-top:10px;padding:8px 10px;border:1px solid " + accent
                + ";border-radius:4px;background:rgba(250,204,21,0.06);display:flex;flex-direction:column;gap:6px"

            const head = document.createElement("div")
            head.style.cssText = "display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:11px"
            const title = document.createElement("div")
            const status = applied ? "Applied" : failed ? "Failed" : "Pending"
            title.innerHTML = "<b>Intervention dispatch — " + status + "</b>"
            const id = document.createElement("code")
            id.style.cssText = "font-size:9.5px;color:#94a3b8"
            id.textContent = pending.dispatchId || ""
            head.appendChild(title)
            head.appendChild(id)
            root.appendChild(head)

            const summary = document.createElement("div")
            summary.style.cssText = "font-size:10.5px;color:" + (T && T.color.text || "#e2e8f0")
            summary.textContent = pending.summary
                || (pending.intervention && pending.intervention.kind)
                || "—"
            root.appendChild(summary)

            const meta = document.createElement("div")
            meta.style.cssText = "font-size:10px;color:#94a3b8"
            const parts = []
            if (pending.originForkId && pending.originForkId !== "anon") parts.push("from fork " + pending.originForkId)
            if (pending.reason) parts.push(pending.reason)
            if (pending.requestedAt) {
                const dt = new Date(pending.requestedAt)
                parts.push("staged " + dt.toLocaleTimeString())
            }
            if (failed) parts.push("error: " + pending.failed)
            meta.textContent = parts.join(" · ") || ""
            root.appendChild(meta)

            const btns = document.createElement("div")
            btns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:2px"

            // Preview reads the current snapshot and re-derives what the
            // apply pipeline would propose for this intervention. Uses
            // existing pure helpers; no POST.
            const previewBtn = document.createElement("button")
            previewBtn.type = "button"
            previewBtn.textContent = "Preview"
            previewBtn.style.cssText = this._btnStyle(T)
            previewBtn.addEventListener("click", () => { this._previewIntervention(pending, root, T).catch(() => {}) })
            btns.appendChild(previewBtn)

            // Apply button routes through the same pipeline composeMove uses.
            // The button disables when applied/failed already so a double-click
            // cannot re-fire.
            const applyBtn = document.createElement("button")
            applyBtn.type = "button"
            applyBtn.textContent = "Apply"
            applyBtn.style.cssText = this._btnStyle(T)
            applyBtn.disabled = applied
            applyBtn.title = "Routes through the existing apply pipeline."
            applyBtn.addEventListener("click", () => { this._applyIntervention(pending, root, T).catch(() => {}) })
            btns.appendChild(applyBtn)

            const dismissBtn = document.createElement("button")
            dismissBtn.type = "button"
            dismissBtn.textContent = "Dismiss"
            dismissBtn.style.cssText = this._btnStyle(T)
            dismissBtn.addEventListener("click", () => { this._clearPendingIntervention().catch(() => {}) })
            btns.appendChild(dismissBtn)

            root.appendChild(btns)
            return root
        }

        async _previewIntervention(pending, bandEl, T) {
            // Pure preview: re-derive what the intervention would change
            // without any side-effects. setWeight previews show the weight
            // delta vs current; addAircraft / dropRoute / flipDna preview
            // their natural fork-side mutation. Read-only by construction.
            const intv = pending && pending.intervention
            if (!intv) return
            const previewLine = document.createElement("div")
            previewLine.style.cssText = "font-size:10px;color:#60a5fa;margin-top:4px"
            try {
                const types = window.AesStrategyInterventionTypes
                const summarize = types && types.summarize
                if (intv.kind === "setWeight") {
                    const ns = window.AesStrategy
                    const cur = (ns && ns.getWeights && ns.getWeights()) || {}
                    const before = (typeof cur[intv.name] === "number") ? cur[intv.name].toFixed(3) : "default"
                    previewLine.textContent = "Preview: weight " + intv.name + " " + before + " → " + intv.value.toFixed(3)
                } else if (summarize) {
                    previewLine.textContent = "Preview: " + summarize(intv) + " (no apply)"
                } else {
                    previewLine.textContent = "Preview: " + intv.kind + " (no apply)"
                }
            } catch (e) {
                previewLine.textContent = "Preview unavailable: " + (e && e.message || "—")
                previewLine.style.color = "#f87171"
            }
            // Replace any earlier preview line so repeated clicks don't stack.
            const prior = bandEl.querySelector("[data-aes-intv-preview]")
            if (prior) prior.remove()
            previewLine.setAttribute("data-aes-intv-preview", "1")
            bandEl.appendChild(previewLine)
        }

        async _applyIntervention(pending, bandEl, T) {
            const intv = pending && pending.intervention
            if (!intv) return
            const ns = window.AesStrategy
            if (!ns || typeof ns.apply !== "function" || typeof ns.snapshot !== "function") {
                this._setBandStatus(bandEl, "pipeline-missing", "#f87171", T)
                return
            }
            // Two-gate model. setWeight is a settings-only mutation (no AS
            // POST), so we apply it directly via setWeights. addAircraft /
            // dropRoute / flipDna would each route through different
            // pipelines (fleet POST / schedule POST); those remain deferred
            // until each has its own gated writer. Keep this surface honest:
            // refuse non-setWeight kinds with a clear reason rather than
            // pretending to apply.
            if (intv.kind !== "setWeight") {
                this._setBandStatus(bandEl, "kind " + intv.kind + " has no live applier yet — preview only", "#facc15", T)
                return
            }
            try {
                if (typeof ns.setWeights === "function") {
                    const before = (typeof ns.getWeights === "function") ? Object.assign({}, ns.getWeights() || {}) : {}
                    const next = Object.assign({}, before, {[intv.name]: intv.value})
                    await ns.setWeights(next)
                    // Stamp applied + emit applied topic so subscribers (briefing,
                    // dispatch-feed) re-render. We reuse the existing topic that
                    // applyPending fires — same shape the rest of the system
                    // already understands.
                    const dd = window.AesStrategyDecisionDispatch
                    const stamped = Object.assign({}, pending, {applied: true, appliedAt: Date.now()})
                    try { await chrome.storage.local.set({[dd.KEY_INTV]: stamped}) } catch (_) { /* noop */ }
                    try {
                        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
                            window.AesDataBus.emit(dd.APPLIED_TOPIC, {
                                kind:        "setWeight",
                                weightName:  intv.name,
                                weightValue: intv.value,
                                dispatchId:  pending.dispatchId,
                                source:      "intervention-apply"
                            })
                        }
                    } catch (_) { /* noop */ }
                    this._setBandStatus(bandEl, "Applied: " + intv.name + " = " + intv.value.toFixed(3), "#34d399", T)
                    this.refresh && this.refresh()
                    return
                }
                this._setBandStatus(bandEl, "AesStrategy.setWeights unavailable", "#f87171", T)
            } catch (e) {
                this._setBandStatus(bandEl, "Apply failed: " + (e && e.message || e), "#f87171", T)
            }
        }

        _setBandStatus(bandEl, text, color, T) {
            const prior = bandEl.querySelector("[data-aes-intv-status]")
            if (prior) prior.remove()
            const line = document.createElement("div")
            line.style.cssText = "font-size:10px;color:" + (color || "#94a3b8") + ";margin-top:4px"
            line.setAttribute("data-aes-intv-status", "1")
            line.textContent = text
            bandEl.appendChild(line)
        }

        async _clearPendingIntervention() {
            const dd = window.AesStrategyDecisionDispatch
            if (!dd || typeof dd.clearPendingIntervention !== "function") return
            await dd.clearPendingIntervention()
            this._pendingIntervention = null
            this.refresh && this.refresh()
        }

        _renderForkDetail(fork, T) {
            const root = document.createElement("div")
            root.style.cssText = "display:flex;flex-direction:column;gap:8px"

            const head = document.createElement("div")
            head.style.cssText = "font-size:11px"
            head.innerHTML = "<div style='font-weight:600'>" + (fork.namedAs || fork.forkId) + "</div>"
                + "<div style='color:#94a3b8'>parent rev " + (fork.parentRev || "—") + "</div>"
            root.appendChild(head)

            if (Array.isArray(fork.interventions) && fork.interventions.length) {
                const ul = document.createElement("ul")
                ul.style.cssText = "margin:0;padding-left:18px;font-size:10.5px;color:" + (T && T.color.text || "#e2e8f0")
                for (const i of fork.interventions) {
                    const li = document.createElement("li")
                    const summarize = window.AesStrategyInterventionTypes
                        && window.AesStrategyInterventionTypes.summarize
                    li.textContent = summarize ? summarize(i) : i.kind
                    ul.appendChild(li)
                }
                root.appendChild(ul)
            } else {
                const p = document.createElement("p")
                p.style.cssText = "margin:0;font-size:10.5px;color:#94a3b8"
                p.textContent = "No interventions yet — pick one below."
                root.appendChild(p)
            }

            if (fork.lastResult && fork.lastResult.ok) {
                const r = fork.lastResult
                const tbl = document.createElement("div")
                tbl.style.cssText = "display:grid;grid-template-columns:auto 80px 80px 80px;gap:4px 8px;font-size:10.5px;font-family:" + (T && T.font && T.font.mono || "monospace")
                tbl.innerHTML = "<b></b><b>baseline</b><b>last wk</b><b>Δ</b>"
                const baseline = r.baseline || {}
                const last = r.weeks && r.weeks[r.weeks.length - 1] || {}
                const rows = [
                    ["weeklyResult", baseline.weeklyResult, last.weeklyResult, r.deltas && r.deltas.weeklyResult],
                    ["orsRankSum",   baseline.orsRankSum,   last.orsRankSum,   r.deltas && r.deltas.orsRankSum],
                    ["fleetSize",    baseline.fleetSize,    last.fleetSize,    r.deltas && r.deltas.fleetSize],
                    ["dnaFit",       baseline.dnaFit,       last.dnaFit,       r.deltas && r.deltas.dnaFit]
                ]
                for (const row of rows) {
                    tbl.innerHTML += "<span>" + row[0] + "</span>"
                        + "<span>" + _fmtNum(row[1]) + "</span>"
                        + "<span>" + _fmtNum(row[2]) + "</span>"
                        + "<span style='color:" + ((row[3] != null && row[3] > 0) ? "#34d399" : (row[3] != null && row[3] < 0 ? "#f87171" : "#94a3b8"))
                        + "'>" + _fmtNum(row[3]) + "</span>"
                }
                root.appendChild(tbl)
            }

            const btns = document.createElement("div")
            btns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap"
            const runBtn = document.createElement("button")
            runBtn.type = "button"
            runBtn.textContent = "Simulate 4 wk"
            runBtn.style.cssText = this._btnStyle(T)
            runBtn.addEventListener("click", () => { this._simulate(fork.forkId, 4).catch(() => {}) })
            btns.appendChild(runBtn)
            const run12Btn = document.createElement("button")
            run12Btn.type = "button"
            run12Btn.textContent = "Simulate 12 wk"
            run12Btn.style.cssText = this._btnStyle(T)
            run12Btn.addEventListener("click", () => { this._simulate(fork.forkId, 12).catch(() => {}) })
            btns.appendChild(run12Btn)
            const promoteBtn = document.createElement("button")
            promoteBtn.type = "button"
            promoteBtn.textContent = "Promote to Dispatch"
            promoteBtn.style.cssText = this._btnStyle(T)
            promoteBtn.disabled = !fork.interventions || !fork.interventions.length
            promoteBtn.addEventListener("click", () => { this._promote(fork.forkId).catch(() => {}) })
            btns.appendChild(promoteBtn)
            const removeBtn = document.createElement("button")
            removeBtn.type = "button"
            removeBtn.textContent = "Remove"
            removeBtn.style.cssText = this._btnStyle(T)
            removeBtn.addEventListener("click", () => { this._remove(fork.forkId).catch(() => {}) })
            btns.appendChild(removeBtn)
            root.appendChild(btns)

            const quick = document.createElement("div")
            quick.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;margin-top:4px"
            const setW = document.createElement("button")
            setW.type = "button"
            setW.textContent = "+ connectivityWeight=0.18"
            setW.style.cssText = this._btnStyle(T) + ";font-size:10px"
            setW.addEventListener("click", () => {
                this._addIntervention(fork.forkId, {kind: "setWeight", name: "connectivityWeight", value: 0.18}).catch(() => {})
            })
            quick.appendChild(setW)
            const setW2 = document.createElement("button")
            setW2.type = "button"
            setW2.textContent = "+ profitWeight=0.50"
            setW2.style.cssText = this._btnStyle(T) + ";font-size:10px"
            setW2.addEventListener("click", () => {
                this._addIntervention(fork.forkId, {kind: "setWeight", name: "profitWeight", value: 0.50}).catch(() => {})
            })
            quick.appendChild(setW2)
            root.appendChild(quick)

            return root
        }

        async _createFork() {
            const ns = window.AesStrategy
            if (!ns || typeof ns.snapshot !== "function") {
                console.warn("[Counterfactual Lab] AesStrategy.snapshot() not available")
                return
            }
            const snap = await ns.snapshot()
            const store = window.AesStrategyForkStore
            if (!store) return
            const fork = await store.create(snap, {namedAs: "Fork " + (this._forks.length + 1)})
            if (fork) this._selected = fork.forkId
            this.refresh && this.refresh()
        }

        async _simulate(forkId, weeks) {
            const store = window.AesStrategyForkStore
            const sim = window.AesStrategyForwardSimulator
            if (!store || !sim) return
            const fork = await store.get(forkId)
            if (!fork) return
            const r = await sim.simulateForward(fork, {weeks})
            if (r && r.ok) {
                fork.lastResult = r
                await store.update(fork)
            }
            this.refresh && this.refresh()
        }

        async _addIntervention(forkId, intervention) {
            const store = window.AesStrategyForkStore
            const apply = window.AesStrategySnapshotFork && window.AesStrategySnapshotFork.applyIntervention
            if (!store || !apply) return
            const fork = await store.get(forkId)
            if (!fork) return
            apply(fork, intervention)
            await store.update(fork)
            this.refresh && this.refresh()
        }

        async _promote(forkId) {
            const store = window.AesStrategyForkStore
            if (!store) return
            const r = await store.promote(forkId, {promotionEnabled: false})
            if (r && !r.ok) console.warn("[Counterfactual Lab] promote refused:", r.reason)
        }

        async _remove(forkId) {
            const store = window.AesStrategyForkStore
            if (!store) return
            await store.remove(forkId)
            if (this._selected === forkId) this._selected = null
            this.refresh && this.refresh()
        }

        _btnStyle(T) {
            return "background:" + (T && T.color.bone || "#1e293b")
                + ";border:1px solid " + (T && T.color.slate || "rgba(148,163,184,0.35)")
                + ";color:" + (T && T.color.text || "#e2e8f0")
                + ";padding:4px 10px;border-radius:3px;cursor:pointer;font-size:10.5px"
        }
    }

    if (typeof window !== "undefined") {
        window.CentralHubCounterfactualLabTile = CentralHubCounterfactualLabTile
        if (window.CentralHubTileRegistry && typeof window.CentralHubTileRegistry.register === "function") {
            window.CentralHubTileRegistry.register({
                id:       "counterfactual-lab",
                section:  "tools",
                priority: 9,
                factory:  () => new CentralHubCounterfactualLabTile()
            })
        }
    }
})()
