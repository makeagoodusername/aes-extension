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
        const next = sameAircraft ? Object.assign({}, prev, payload) : Object.assign({}, payload)
        if (!next.hub && window.AesAfpActiveDraftStore) {
            try {
                const draft = await window.AesAfpActiveDraftStore.load(this.server, next.aircraftId)
                if (draft && draft.hub) next.hub = draft.hub
            } catch (_) { /* fall through */ }
        }
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
        const flightMin = (payload && Number.isFinite(payload.flightMin)) ? payload.flightMin : 60
        const depTime = await window.AesRouteLauncherSlotFinder.findSlot(this.server, this.active.aircraftId, {
            strategy:             defaults.slotStrategy,
            defaultDepartureTime: defaults.defaultDepartureTime,
            turnaroundMin:        defaults.defaultTurnaroundMin,
            flightMin
        })

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

    async _loadPersistedActive() {
        if (!this.server) return null
        const key = this._activeKey()
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        return (rec && rec.aircraftId) ? rec : null
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
