"use strict"

/**
 * Slice 21 — fork actions for the command palette.
 * Three actions: create fork, simulate last fork (4 wk + 12 wk).
 * Defensive: every dependency missing → no-op. The palette is the only
 * keyboard surface in v1; the tile carries the visual UI.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.__aesForkDeriverInstalled) return
    window.__aesForkDeriverInstalled = true

    function _api() { return window.AESCommandRegistry || null }

    function _register(spec) {
        const api = _api()
        if (!api || typeof api.register !== "function") return null
        try { return api.register(spec) } catch (_) { return null }
    }

    async function _createFork() {
        const ns = window.AesStrategy
        const store = window.AesStrategyForkStore
        if (!ns || !store) return
        const snap = await ns.snapshot()
        await store.create(snap, {namedAs: "Fork " + new Date().toISOString().slice(11, 19)})
    }

    async function _simulateLast(weeks) {
        const store = window.AesStrategyForkStore
        const sim = window.AesStrategyForwardSimulator
        if (!store || !sim) return
        const list = await store.list()
        if (!list.length) return
        const fork = list[0]
        const r = await sim.simulateForward(fork, {weeks: weeks || 4})
        if (r && r.ok) { fork.lastResult = r; await store.update(fork) }
    }

    function _attach() {
        const api = _api()
        if (!api) return false
        _register({
            id:       "strategy.fork.create",
            label:    "Fork current snapshot",
            hint:     "Counterfactual Lab",
            keywords: ["fork", "what if", "counterfactual", "branch"],
            run:      () => { _createFork().catch(() => {}) }
        })
        _register({
            id:       "strategy.fork.simulate4",
            label:    "Run last fork forward 4 weeks",
            hint:     "Counterfactual Lab",
            keywords: ["simulate", "fork", "project"],
            run:      () => { _simulateLast(4).catch(() => {}) }
        })
        _register({
            id:       "strategy.fork.simulate12",
            label:    "Run last fork forward 12 weeks",
            hint:     "Counterfactual Lab",
            keywords: ["simulate", "fork", "project", "long"],
            run:      () => { _simulateLast(12).catch(() => {}) }
        })
        return true
    }

    if (!_attach()) {
        let tries = 0
        const poll = () => {
            tries++
            if (_attach()) return
            if (tries < 120) requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
    }
})()
