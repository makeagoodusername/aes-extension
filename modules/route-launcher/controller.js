"use strict"

/**
 * Route Launcher — singleton orchestrator.
 *
 * Window-scoped (`window.RouteLauncher`). Keeps the active aircraft
 * selection in storage so it survives hub remount, listens to
 * CentralHubBus `focus-aircraft` events, and exposes the high-level
 * launchTo(destIata) action used by the destination ranker UI.
 *
 * Wiring:
 *   picker  → setActive(aircraftId)
 *   ranker  → renders dests for active.hub
 *   click   → launchTo(destIata) → slot-finder → dispatcher → log
 *   feed    → reads log, re-renders on storage change
 */
class AesRouteLauncherController {
    static ACTIVE_KEY_PREFIX = "routeLauncher:activeAircraft:"

    constructor() {
        this.server      = ""
        this.airlineCode = ""
        this.active      = null   // {aircraftId, registration, equipment, typeId, hub}
        this.dispatcher  = null
        this._statusListeners = new Set()
        this._activeListeners = new Set()
    }

    async init(ctx) {
        const c = ctx || {}
        this.server      = String(c.server || "")
        this.airlineCode = String(c.airline || c.airlineCode || "")
        this.dispatcher = new window.AesRouteLauncherDispatcher({
            server:      this.server,
            airlineCode: this.airlineCode,
            onStatus:    (e) => this._fireStatus(e)
        })
        const restored = await this._loadPersistedActive()
        if (restored) this.active = restored

        if (window.CentralHubBus && typeof window.CentralHubBus.on === "function") {
            window.CentralHubBus.on("focus-aircraft", (payload) => {
                if (!payload || !payload.aircraftId) return
                this.setActive({aircraftId: String(payload.aircraftId), registration: payload.registration || null})
            })
        }
    }

    onStatus(fn) {
        if (typeof fn !== "function") return () => {}
        this._statusListeners.add(fn)
        return () => this._statusListeners.delete(fn)
    }

    onActiveChange(fn) {
        if (typeof fn !== "function") return () => {}
        this._activeListeners.add(fn)
        return () => this._activeListeners.delete(fn)
    }

    async setActive(payload) {
        if (!payload || !payload.aircraftId) return
        // F-9230-001: only inherit prior fields when the aircraft id is unchanged.
        // Bus emitters (focus-aircraft) send `{aircraftId, ...}` without hub /
        // equipment, so merging across an id flip stamps the previous aircraft's
        // hub onto the new selection — the ranker then renders rows from the wrong
        // base and launchTo posts an impossible leg.
        const prev = this.active || {}
        const sameAircraft = String(prev.aircraftId || "") === String(payload.aircraftId)
        let next = sameAircraft ? Object.assign({}, prev, payload) : Object.assign({}, payload)
        if (!next.hub) next.hub = await this._resolveHubForAircraft(next.aircraftId)
        next = await this._hydrateActiveDetails(next)
        this.active = next
        await this._persistActive(next)
        this._fireActive(next)
    }

    getActive() { return this.active }

    async launchTo(payload) {
        if (!this.active || !this.active.aircraftId) {
            return {ok: false, error: "No aircraft selected. Pick one from the left column."}
        }
        if (!this.active.hub) {
            return {ok: false, error: "Active aircraft has no known hub. Open it once on /app/fleets/aircraft/<id>/0 to seed the hub."}
        }
        const dest = String((payload && payload.destIata) || "").toUpperCase()
        if (!/^[A-Z]{3}$/.test(dest)) {
            return {ok: false, error: "Invalid destination IATA: " + dest}
        }

        const defaults = await window.AesRouteLauncherDefaults.load()
        const hasFlightMin = !!(payload && Number.isFinite(payload.flightMin))
        const flightMin = hasFlightMin ? payload.flightMin : null
        const depTime = await window.AesRouteLauncherSlotFinder.findSlot(this.server, this.active.aircraftId, {
            strategy:             defaults.slotStrategy,
            defaultDepartureTime: defaults.defaultDepartureTime,
            turnaroundMin:        defaults.defaultTurnaroundMin,
            flightMin,
            originIata:           this.active.hub,
            requireConflictFree:  defaults.slotStrategy === "earliest-gap",
            requireKnownDuration: defaults.slotStrategy === "earliest-gap"
        })
        if (!depTime) {
            return await this._recordPreflightFailure({
                dest,
                error: "No conflict-free departure slot found from " + this.active.hub
                    + ". Open the aircraft Flight Plan page and choose a time manually."
            })
        }

        return await this.dispatcher.launch({
            aircraftId:   this.active.aircraftId,
            registration: this.active.registration,
            hub:          this.active.hub,
            dest,
            depTime,
            pricePct:     defaults.defaultPricePct,
            service:      defaults.defaultService
        })
    }

    async _recordPreflightFailure(opts) {
        const o = opts || {}
        const error = String(o.error || "Route Launcher preflight failed.")
        if (window.AesRouteLauncherLog && this.server && this.active && this.active.aircraftId) {
            const record = await window.AesRouteLauncherLog.append({
                server:       this.server,
                airline:      this.airlineCode,
                aircraftId:   String(this.active.aircraftId),
                registration: this.active.registration || null,
                hub:          this.active.hub || null,
                dest:         o.dest || null,
                depTime:      null,
                pricePct:     null,
                service:      null,
                status:       "failed",
                error
            })
            this._fireStatus({phase: "failed", record})
            return {ok: false, logId: record && record.id, error}
        }
        return {ok: false, error}
    }

    async retry(record) {
        if (!record || !record.dest || !record.hub || !record.aircraftId) {
            return {ok: false, error: "retry: missing fields on record"}
        }
        const prevActive = this.active
        await this.setActive({
            aircraftId:   record.aircraftId,
            registration: record.registration,
            hub:          record.hub
        })
        const r = await this.launchTo({destIata: record.dest})
        if (prevActive && prevActive.aircraftId !== record.aircraftId) {
            await this.setActive(prevActive)
        }
        return r
    }

    _fireStatus(event) {
        for (const fn of this._statusListeners) {
            try { fn(event) } catch (e) { console.warn("[RouteLauncher] status listener threw", e) }
        }
    }

    _fireActive(active) {
        for (const fn of this._activeListeners) {
            try { fn(active) } catch (e) { console.warn("[RouteLauncher] active listener threw", e) }
        }
    }

    _activeKey() {
        return AesRouteLauncherController.ACTIVE_KEY_PREFIX + this.server
    }

    async _resolveHubForAircraft(aircraftId) {
        if (!aircraftId) return null
        const asIata = v => /^[A-Z]{3}$/.test(String(v || "").toUpperCase())
            ? String(v).toUpperCase() : null

        if (window.AesAfpActiveDraftStore) {
            try {
                const draft = await window.AesAfpActiveDraftStore.load(this.server, aircraftId)
                const hub = asIata(draft && draft.hub)
                if (hub) return hub
            } catch (_) { /* fall through */ }
        }

        if (window.AesAfpStateStore) {
            try {
                const state = await window.AesAfpStateStore.load(this.server, aircraftId)
                const hub = asIata(state && state.currentLocationIata)
                if (hub) return hub
            } catch (_) { /* fall through */ }
        }

        if (window.AesFleetRoster) {
            try {
                const fleet = await window.AesFleetRoster.load(this.server, this.airlineCode || null)
                const aircraft = window.AesFleetRoster.findByAircraftId(fleet, aircraftId)
                const hub = asIata(aircraft && aircraft.location)
                if (hub) return hub
            } catch (_) { /* fall through */ }
        }
        return null
    }

    async _hydrateActiveDetails(active) {
        if (!active || !active.aircraftId || !window.AesFleetRoster) return active
        if (active.registration && active.equipment && active.typeId) return active
        try {
            const fleet = await window.AesFleetRoster.load(this.server, this.airlineCode || null)
            const aircraft = window.AesFleetRoster.findByAircraftId(fleet, active.aircraftId)
            if (!aircraft) return active
            const next = Object.assign({}, active)
            if (!next.registration && aircraft.registration) next.registration = aircraft.registration
            if (!next.equipment && aircraft.equipment) next.equipment = aircraft.equipment
            if (!next.typeId && aircraft.typeId) next.typeId = aircraft.typeId
            return next
        } catch (_) {
            return active
        }
    }

    async _loadPersistedActive() {
        if (!this.server) return null
        const key = this._activeKey()
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        return (rec && rec.aircraftId) ? this._hydrateActiveDetails(rec) : null
    }

    async _persistActive(active) {
        if (!this.server) return
        const key = this._activeKey()
        await chrome.storage.local.set({[key]: active})
    }
}

if (typeof window !== "undefined") {
    window.AesRouteLauncherController = AesRouteLauncherController
    if (!window.RouteLauncher) window.RouteLauncher = new AesRouteLauncherController()
}
