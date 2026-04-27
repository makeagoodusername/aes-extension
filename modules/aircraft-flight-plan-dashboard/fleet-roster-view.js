"use strict"

/**
 * AFP Dashboard — fleet roster adapter.
 *
 * Thin wrapper around `FleetHubAircraftAggregator.enrich()`. Returns the
 * aircraft row the dashboard panel needs in one place so panel.js doesn't
 * have to re-replicate the storage round-trip.
 *
 * Why not just call FleetHubAircraftAggregator directly? Because the
 * dashboard could re-aggregate per-row instead of in bulk (the Fleet Hub
 * host already aggregated for the table; we just want one row). But the
 * aggregator's API is bulk-only, so we filter post-aggregate and provide
 * a thin sync adapter for the panel.
 */
class AesAfpDashboardFleetRoster {
    constructor(opts) {
        const o = opts || {}
        this.server      = o.server      || ""
        this.airlineCode = o.airlineCode || ""
        this._cache = null
        this._cacheAt = 0
    }

    static CACHE_TTL_MS = 30 * 1000

    async _loadFleet() {
        const fleetKey = this.server + this.airlineCode + "aircraftFleet"
        const got = await chrome.storage.local.get([fleetKey])
        const rec = got[fleetKey]
        return (rec && Array.isArray(rec.fleet)) ? rec.fleet : []
    }

    async loadAll() {
        const now = Date.now()
        if (this._cache && (now - this._cacheAt) < AesAfpDashboardFleetRoster.CACHE_TTL_MS) {
            return this._cache
        }
        const fleet = await this._loadFleet()
        if (!fleet.length) {
            this._cache = []; this._cacheAt = now
            return this._cache
        }
        if (typeof FleetHubAircraftAggregator === "undefined") {
            console.warn("[AES afp-dashboard] FleetHubAircraftAggregator missing; returning raw fleet")
            this._cache = fleet.map(a => ({
                aircraftId:    a.aircraftId,
                registration:  a.registration,
                equipment:     a.equipment,
                typeId:        a.typeId || null,
                hub:           null,
                locIata:       null,
                hasDraftedPlan: false,
                scheduleStatus: null
            }))
            this._cacheAt = now
            return this._cache
        }
        try {
            this._cache = await FleetHubAircraftAggregator.enrich({
                server:      this.server,
                airlineCode: this.airlineCode,
                fleet
            })
        } catch (e) {
            console.warn("[AES afp-dashboard] aggregator threw", e)
            this._cache = []
        }
        this._cacheAt = now
        return this._cache
    }

    async getById(aircraftId) {
        const rows = await this.loadAll()
        const wanted = String(aircraftId)
        return rows.find(r => String(r.aircraftId) === wanted) || null
    }

    invalidate() { this._cache = null; this._cacheAt = 0 }
}

if (typeof window !== "undefined") {
    window.AesAfpDashboardFleetRoster = AesAfpDashboardFleetRoster
}
