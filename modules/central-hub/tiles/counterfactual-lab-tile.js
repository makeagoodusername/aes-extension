"use strict"

/**
 * Counterfactual Lab tile — Slice 21 surface.
 *
 * Master/detail UI: left rail lists saved forks; right pane shows the
 * selected fork's interventions, deltas, and apply-intervention picker.
 * "Promote to Dispatch" routes through the existing two-gate pipeline
 * (default OFF per §4.18). Read-only otherwise — forking + simulating are
 * pure inspection paths.
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

        watchedStorageKeys() { return ["aesStrategy:forks"] }

        _wireBus() {
            if (this._wired) return
            this._wired = true
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
                    const handler = () => { this.refresh && this.refresh() }
                    window.CentralHubBus.on("data:strategy:fork:created", handler)
                    window.CentralHubBus.on("data:strategy:fork:simulated", handler)
                    window.CentralHubBus.on("data:strategy:fork:promoted", handler)
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
