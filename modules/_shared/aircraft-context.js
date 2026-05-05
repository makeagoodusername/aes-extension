"use strict"

/**
 * Track 8 slice 8b — read-only facade aggregating the per-aircraft
 * stores under the `aircraftFlightPlan:` namespace.
 *
 * Bundles the five storage-backed stores (schedule, draft, state,
 * flight log, maintenance) plus a best-effort spec lookup under one
 * accessor so consumers stop importing 4–6 globals manually. Pure
 * pass-through — no business logic, no caching, no writes.
 *
 * Usage (subscribing view, recommended for panels):
 *
 *   const view = AesAircraftContext.create(server, aircraftId)
 *   const snap = await view.snapshot()         // all six areas
 *   const sched = await view.getSchedule()
 *   const off = view.onChange("schedule", ({schedule, oldSchedule}) => …)
 *   off()              // unwatch one area
 *   view.dispose()     // unwatch every area registered through this view
 *
 * Usage (one-shot, no subscription):
 *
 *   const snap = await AesAircraftContext.snapshot(server, aircraftId)
 *
 * Slice isolation: looks up `window.AesAfp*Store` globals lazily at call
 * time. Stores that aren't loaded on a given page (per manifest) silently
 * return null — adding this facade to a manifest entry does NOT require
 * every store to be present. Spec is best-effort from
 * `window.AesAfpSpecResolver.last` (only populated on the AFP page); 8d
 * will replace it with a dedicated AircraftSpec facade.
 *
 * Module-prefix isolation (HANDOVER §10): reads only `aircraftFlightPlan:*`
 * keys. The audit log is intentionally NOT exposed here — it isn't
 * per-aircraft state and consumers that need the breadcrumb timeline
 * should call `AesAfpAuditLog.watch()` directly.
 */
class AesAircraftContext {
    static AREAS = ["schedule", "draft", "state", "log", "maintenance"]

    constructor(server, aircraftId) {
        this.server     = String(server || "")
        this.aircraftId = String(aircraftId || "")
        this._unwatches = []
    }

    static create(server, aircraftId) {
        return new AesAircraftContext(server, aircraftId)
    }

    /** Static one-shot sugar — convenient when no subscription is needed. */
    static async snapshot(server, aircraftId) {
        return AesAircraftContext.create(server, aircraftId).snapshot()
    }

    /* ─────── one-shot reads ─────── */

    async getSchedule()    { return AesAircraftContext._loadFrom(window.AesAfpScheduleStore,    this.server, this.aircraftId) }
    async getDraft()       { return AesAircraftContext._loadFrom(window.AesAfpActiveDraftStore, this.server, this.aircraftId) }
    async getState()       { return AesAircraftContext._loadFrom(window.AesAfpStateStore,       this.server, this.aircraftId) }
    async getLog()         { return AesAircraftContext._loadFrom(window.AesAfpFlightLogStore,   this.server, this.aircraftId) }
    async getMaintenance() { return AesAircraftContext._loadFrom(window.AesAfpMaintenanceStore, this.server, this.aircraftId) }

    /** Best-effort spec — only resolved on the AFP page. */
    async getSpec() {
        if (typeof window === "undefined") return null
        const r = window.AesAfpSpecResolver
        return (r && r.last) ? r.last : null
    }

    /**
     * Read all six areas in parallel. Each missing store contributes null.
     * Returns `{server, aircraftId, schedule, draft, state, log, maintenance, spec}`.
     */
    async snapshot() {
        const [schedule, draft, state, log, maintenance, spec] = await Promise.all([
            this.getSchedule(),
            this.getDraft(),
            this.getState(),
            this.getLog(),
            this.getMaintenance(),
            this.getSpec()
        ])
        return {
            server:     this.server,
            aircraftId: this.aircraftId,
            schedule, draft, state, log, maintenance, spec
        }
    }

    /* ─────── subscriptions ─────── */

    /**
     * Subscribe to one area's cross-tab updates, filtered to THIS
     * aircraft. Returns an unwatch fn; the unwatch is also tracked so
     * `dispose()` cleans every subscription registered through this
     * view in one call.
     *
     * Areas: "schedule" | "draft" | "state" | "log" | "maintenance"
     *
     * Handler payload mirrors the underlying store's watch():
     *   schedule    → {server, aircraftId, schedule,    oldSchedule}
     *   draft       → {server, aircraftId, draft,       oldDraft}
     *   state       → {server, aircraftId, state,       oldState}
     *   log         → {server, aircraftId, log,         oldLog}
     *   maintenance → {server, aircraftId, maintenance, oldMaintenance}
     */
    onChange(area, handler) {
        if (typeof handler !== "function") return () => {}
        const Store = AesAircraftContext._storeFor(area)
        if (!Store || typeof Store.watch !== "function") return () => {}
        const wrapped = (ev) => {
            if (!ev || ev.server !== this.server || ev.aircraftId !== this.aircraftId) return
            try { handler(ev) }
            catch (e) { console.warn("[AES] aircraft-context onChange handler threw", e) }
        }
        const off = Store.watch(wrapped)
        this._unwatches.push(off)
        return () => {
            const idx = this._unwatches.indexOf(off)
            if (idx >= 0) this._unwatches.splice(idx, 1)
            try { off() } catch (_) { /* noop */ }
        }
    }

    /**
     * Subscribe to ANY area's update for this aircraft; payload is
     * `{area, ...areaPayload}`. Useful for "repaint when anything
     * about this aircraft changes" callers. Returns one unwatch fn
     * that releases all five subscriptions.
     */
    onAnyChange(handler) {
        if (typeof handler !== "function") return () => {}
        const offs = AesAircraftContext.AREAS.map(area =>
            this.onChange(area, (ev) => handler(Object.assign({area}, ev)))
        )
        return () => { for (const off of offs) try { off() } catch (_) { /* noop */ } }
    }

    /** Release every subscription this view registered. Idempotent. */
    dispose() {
        const arr = this._unwatches.slice()
        this._unwatches.length = 0
        for (const off of arr) try { off() } catch (_) { /* noop */ }
    }

    /* ─────── internals ─────── */

    static _storeFor(area) {
        if (typeof window === "undefined") return null
        switch (area) {
            case "schedule":    return window.AesAfpScheduleStore
            case "draft":       return window.AesAfpActiveDraftStore
            case "state":       return window.AesAfpStateStore
            case "log":         return window.AesAfpFlightLogStore
            case "maintenance": return window.AesAfpMaintenanceStore
            default:            return null
        }
    }

    static async _loadFrom(Store, server, aircraftId) {
        if (!Store || typeof Store.load !== "function") return null
        return Store.load(server, aircraftId)
    }
}

if (typeof window !== "undefined") {
    window.AesAircraftContext = AesAircraftContext
}
