"use strict"

/**
 * AES Strategy — Time Scrubber (Slice 25).
 *
 * Broadcasts the user's chosen "view-time" so other panels can re-render
 * deltas against an arbitrary historical snapshot from
 * `AccountingSnapshotStore`. The scrubber is a thin pure-ish helper —
 * the consumer (the network-graph tile) renders the slider; this module
 * owns the bus event + index resolution + a small shared state that any
 * panel can read on first paint.
 *
 * State:
 *   {weekId: string|null, ts: number|null}
 *   weekId === null means "live" — no scrubbing, panels render against
 *   the live snapshot.
 *
 * Public API (window.AesStrategyTimeScrubber):
 *   .listAvailable(host)              → Promise<{weekId, ts}[]>
 *   .scrubTo({weekId, ts})            → void   (emits view-time:scrubbed)
 *   .reset()                          → void   (emits view-time:scrubbed null)
 *   .currentState()                   → {weekId, ts}
 *   .onChange(handler)                → off()  (subscribe to local changes)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyTimeScrubber) return

    let _state = {weekId: null, ts: null}
    const _handlers = new Set()

    function _resolveHost() {
        try {
            if (typeof AES === "undefined") return null
            const server  = (AES.getServerName && AES.getServerName()) || ""
            const codeRec = (AES.getAirlineCode && AES.getAirlineCode()) || null
            const airline = (codeRec && codeRec.code) || ""
            if (!server || !airline) return null
            return {server, airline}
        } catch (_) { return null }
    }

    async function listAvailable(hostArg) {
        const host = hostArg || _resolveHost()
        if (!host) return []
        const store = window.AccountingSnapshotStore
        if (!store || typeof store.loadIndex !== "function") return []
        try {
            const index = await store.loadIndex(host.server, host.airline)
            const weeks = (index && Array.isArray(index.weeks)) ? index.weeks : (Array.isArray(index) ? index : [])
            return weeks.map(w => ({
                weekId: String(w.weekId || w.id || ""),
                ts:     Number(w.ts || w.savedAt || w.lastUpdated || 0)
            })).filter(e => e.weekId).sort((a, b) => b.ts - a.ts)
        } catch (e) {
            console.warn("[AesStrategyTimeScrubber] listAvailable failed", e)
            return []
        }
    }

    function _emit() {
        const payload = {weekId: _state.weekId, ts: _state.ts}
        for (const h of _handlers) {
            try { h(payload) } catch (_) {}
        }
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("view-time:scrubbed", payload)
            }
        } catch (_) {}
    }

    function scrubTo(opts) {
        const o = opts || {}
        const weekId = o.weekId != null ? String(o.weekId) : null
        const ts     = Number(o.ts) > 0 ? Number(o.ts) : null
        if (_state.weekId === weekId && _state.ts === ts) return
        _state = {weekId, ts}
        _emit()
    }

    function reset() {
        if (_state.weekId == null && _state.ts == null) return
        _state = {weekId: null, ts: null}
        _emit()
    }

    function currentState() {
        return {weekId: _state.weekId, ts: _state.ts}
    }

    function onChange(handler) {
        if (typeof handler !== "function") return () => {}
        _handlers.add(handler)
        return () => _handlers.delete(handler)
    }

    window.AesStrategyTimeScrubber = {
        listAvailable: listAvailable,
        scrubTo:       scrubTo,
        reset:         reset,
        currentState:  currentState,
        onChange:      onChange
    }
})()
