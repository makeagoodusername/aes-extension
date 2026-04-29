"use strict"

/**
 * CentralHubBus — single in-memory pub/sub shared by the hub shell, the
 * hero KPI strip, and any tile that opts in via CentralHubTile.subscribeBus().
 *
 * Mirrors the proven AesAfp.bus pattern (modules/aircraft-flight-plan/host.js).
 * Synchronous emit; handlers are wrapped so one bad subscriber cannot poison
 * the channel. Intentionally tiny — no priority queues, no async.
 *
 * Single-record replay is supported (one record per event name) so a
 * late-mounting tile can recover the most recent open-tile / focus-* intent
 * without each producer keeping its own re-emit logic. Mirrors the API
 * shape of AesDataBus.replay (last record only, not a history ring).
 *
 * Canonical events (CH-5c reserves the names; emitters arrive across CH-5d/e):
 *   "open-tile"        {tileId, expand?, scrollIntoView?, filter?, source}
 *   "focus-route"      {hub, dest, source}
 *   "focus-aircraft"   {aircraftId, source}
 *   "focus-enterprise" {enterpriseId, source}
 *   "focus-preset"     {presetId, kind, source}
 *
 * Filter payloads are simple plain objects ({type: "fired-alerts"} etc.);
 * receivers ignore unknown shapes.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.CentralHubBus) return

    const handlers = new Map()  // event -> Set<handler>
    const lastEmit = new Map()  // event -> last payload

    function on(event, handler) {
        if (!event || typeof handler !== "function") return () => {}
        let set = handlers.get(event)
        if (!set) { set = new Set(); handlers.set(event, set) }
        set.add(handler)
        return () => off(event, handler)
    }

    function off(event, handler) {
        const set = handlers.get(event)
        if (!set) return
        set.delete(handler)
        if (!set.size) handlers.delete(event)
    }

    function emit(event, payload) {
        lastEmit.set(event, payload)
        const set = handlers.get(event)
        if (!set || !set.size) return
        for (const handler of Array.from(set)) {
            try { handler(payload) }
            catch (err) { console.warn("[AES Hub bus] handler threw", event, err) }
        }
    }

    /**
     * Returns the last payload emitted for `event`, or undefined when nothing
     * has fired. Late-mounting tiles can call replay() once after attaching
     * to recover the most recent intent (e.g. the open-tile request issued
     * before the dashboard finished mounting).
     */
    function replay(event) {
        return lastEmit.get(event)
    }

    window.CentralHubBus = {on, off, emit, replay}
})()
