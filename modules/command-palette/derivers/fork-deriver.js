"use strict"

/**
 * Slice 21 — fork actions for the command palette.
 * Three actions: create fork, simulate last fork (4 wk + 12 wk).
 * The palette is the keyboard surface; the counterfactual-lab tile is the
 * visual surface. Commands therefore both mutate the fork store and open the
 * tile so the user sees the result instead of firing a silent no-op.
 */
;(function () {
    if (typeof window === "undefined") return

    function _api() { return window.AESCommandRegistry || null }
    function _alreadyAttached(api) {
        if (!api) return false
        if (window.__aesForkDeriverRegistry === api) return true
        window.__aesForkDeriverRegistry = api
        return false
    }

    function _register(spec) {
        const api = _api()
        if (!api || typeof api.register !== "function") return null
        try { return api.register(spec) } catch (_) { return null }
    }

    function _hasCreateDeps() {
        const ns = window.AesStrategy
        return !!(ns && typeof ns.snapshot === "function"
            && window.AesStrategyForkStore
            && window.AesStrategySnapshotFork)
    }

    function _hasSimDeps() {
        return !!(window.AesStrategyForkStore && window.AesStrategyForwardSimulator)
    }

    function _openLab() {
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("open-tile", {
                    tileId: "counterfactual-lab",
                    expand: true,
                    scrollIntoView: true,
                    source: "command-palette:fork"
                })
            }
        } catch (_) { /* best-effort UI focus */ }
    }

    async function _createFork() {
        const ns = window.AesStrategy
        const store = window.AesStrategyForkStore
        if (!_hasCreateDeps()) return null
        const snap = await ns.snapshot()
        const fork = await store.create(snap, {namedAs: "Fork " + new Date().toISOString().slice(11, 19)})
        _openLab()
        return fork
    }

    async function _simulateLast(weeks) {
        const store = window.AesStrategyForkStore
        const sim = window.AesStrategyForwardSimulator
        if (!_hasSimDeps()) return null
        const list = await store.list()
        if (!list.length) { _openLab(); return null }
        const fork = list[0]
        const r = await sim.simulateForward(fork, {weeks: weeks || 4})
        if (r && r.ok) { fork.lastResult = r; await store.update(fork) }
        _openLab()
        return r || null
    }

    function _attach() {
        const api = _api()
        if (!api) return false
        if (_alreadyAttached(api)) return true
        _register({
            id:       "strategy.fork.create",
            scope:    "any",
            label:    "Create Strategy Fork",
            hint:     "Clone the current strategy snapshot and open Counterfactual Lab",
            keywords: ["strategy", "fork", "what if", "counterfactual", "branch"],
            available: _hasCreateDeps,
            run:      () => _createFork()
        })
        _register({
            id:       "strategy.fork.simulate4",
            scope:    "any",
            label:    "Simulate Latest Strategy Fork 4 Weeks",
            hint:     "Run the newest counterfactual fork forward and open Counterfactual Lab",
            keywords: ["strategy", "simulate", "fork", "project"],
            available: _hasSimDeps,
            run:      () => _simulateLast(4)
        })
        _register({
            id:       "strategy.fork.simulate12",
            scope:    "any",
            label:    "Simulate Latest Strategy Fork 12 Weeks",
            hint:     "Run the newest counterfactual fork forward and open Counterfactual Lab",
            keywords: ["strategy", "simulate", "fork", "project", "long"],
            available: _hasSimDeps,
            run:      () => _simulateLast(12)
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

    window.AESForkDeriver = {attach: _attach}
})()
