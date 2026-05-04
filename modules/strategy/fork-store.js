"use strict"

/**
 * AesStrategyForkStore — Slice 21 fork persistence.
 *
 * Per-account ring of named forks. v1 caps at 5 forks per account (FIFO);
 * each fork blob ≤ 30KB by structure (snapshots are bounded). Read-only
 * by default per §4.1 — fork creation + simulation is pure inspection;
 * the only write to AS comes via promote() which still routes through
 * decision-dispatch's two-gate.
 *
 * Storage:
 *   aesStrategy:forks:<acctKey>  → Fork[]
 *
 * Fork shape (mirrors snapshot-fork.js output + lastResult):
 *   {forkId, parentRev, namedAs, createdAt, snapshot, interventions, lastResult}
 *
 * Bus emits:
 *   data:strategy:fork:created   {forkId, baseRev, namedAs}
 *   data:strategy:fork:promoted  {forkId, dispatchId}
 */
;(function () {
    if (typeof window === "undefined" || window.AesStrategyForkStore) return

    const PREFIX = "aesStrategy:forks"
    const CAP = 5

    function _bus() { return (typeof window !== "undefined" && window.CentralHubBus) || null }

    function _key() {
        if (window.AesAccountKey && typeof window.AesAccountKey.acctKey === "function") {
            return window.AesAccountKey.acctKey(PREFIX)
        }
        return PREFIX
    }

    async function _read() {
        const key = _key()
        if (typeof chrome === "undefined" || !chrome.storage) return []
        try {
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return Array.isArray(v) ? v : []
        } catch (_) { return [] }
    }

    async function _write(arr) {
        const key = _key()
        try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
    }

    async function list() {
        const arr = await _read()
        return arr.slice().reverse()                            // newest first
    }

    async function get(forkId) {
        const arr = await _read()
        return arr.find(f => f && f.forkId === forkId) || null
    }

    /** Create a fork. Caller passes a base snapshot from the engine. */
    async function create(baseSnapshot, opts) {
        const fork = window.AesStrategySnapshotFork
            && window.AesStrategySnapshotFork.forkSnapshot
            && window.AesStrategySnapshotFork.forkSnapshot(baseSnapshot, opts)
        if (!fork) return null
        const arr = await _read()
        arr.push(fork)
        if (arr.length > CAP) arr.splice(0, arr.length - CAP)
        await _write(arr)
        const b = _bus()
        if (b && typeof b.emit === "function") {
            try { b.emit("data:strategy:fork:created", {forkId: fork.forkId, baseRev: fork.parentRev, namedAs: fork.namedAs}) }
            catch (_) { /* noop */ }
        }
        return fork
    }

    async function update(fork) {
        if (!fork || !fork.forkId) return false
        const arr = await _read()
        const idx = arr.findIndex(f => f && f.forkId === fork.forkId)
        if (idx < 0) return false
        arr[idx] = fork
        await _write(arr)
        return true
    }

    async function remove(forkId) {
        const arr = await _read()
        const filtered = arr.filter(f => !f || f.forkId !== forkId)
        if (filtered.length === arr.length) return false
        await _write(filtered)
        return true
    }

    async function clear() {
        await _write([])
    }

    /** Promote a fork's first intervention into decision-dispatch. The
     *  dispatch path is the existing two-gate (apply-pipeline.applyEnabled
     *  + dryRunOnly) — fork only stages an intervention. The originForkId
     *  flows into the dispatch's reason string for provenance. */
    async function promote(forkId, opts) {
        opts = opts || {}
        const fork = await get(forkId)
        if (!fork) return {ok: false, reason: "fork not found"}
        if (!Array.isArray(fork.interventions) || !fork.interventions.length) {
            return {ok: false, reason: "fork has no interventions"}
        }
        const promoEnabled = opts.promotionEnabled === true
        if (!promoEnabled) {
            return {ok: false, reason: "fork.promotionEnabled is false (default per §4.18); flip aesStrategy:fork.promotionEnabled to enable"}
        }
        const dispatcher = window.AesStrategyDecisionDispatch
        if (!dispatcher || typeof dispatcher.composeFromIntervention !== "function") {
            return {ok: false, reason: "decision-dispatch.composeFromIntervention not available; v1 promotion requires K11.2"}
        }
        try {
            const dispatchId = await dispatcher.composeFromIntervention(fork.interventions[0], {
                originForkId: fork.forkId,
                reason: "from fork " + fork.forkId + ": simulator predicted weekly delta "
                    + (fork.lastResult && fork.lastResult.deltas ? fork.lastResult.deltas.weeklyResult : "?")
            })
            const b = _bus()
            if (b && typeof b.emit === "function") {
                try { b.emit("data:strategy:fork:promoted", {forkId: fork.forkId, dispatchId}) }
                catch (_) { /* noop */ }
            }
            return {ok: true, dispatchId}
        } catch (e) {
            return {ok: false, reason: "dispatcher threw: " + (e && e.message || "?")}
        }
    }

    window.AesStrategyForkStore = {
        list, get, create, update, remove, clear, promote, PREFIX, CAP
    }
})()
