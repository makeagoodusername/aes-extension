"use strict"

/**
 * Append-only ring buffer of compact competitor snapshots, one buffer per
 * (server, enterpriseId). Lets the diff + threat scorer + watchlist read
 * change-over-time without re-scraping. The full enterprise record at
 * `competitorIntel:enterprise:<server>:<id>` carries the latest detail;
 * this store carries the last N snapshots (default 16) of the few fields
 * that change meaningfully — fleet counts/composition, hubs, route footprint
 * size, alliance, baseCountry, headline counts.
 *
 * Storage key: `competitorIntel:snapshots:<server>:<enterpriseId>`
 *   { server, enterpriseId, snapshots: [{ at, ...compact fields }, ...] }
 *
 * Append rule: a new snapshot is only added when at least one tracked field
 * differs from the most recent prior. This keeps the buffer biased toward
 * change events rather than scrape cadence.
 */
class AesCompetitorSnapshotStore {
    static NS = "competitorIntel:snapshots:"
    static CAP = 16

    static _key(server, enterpriseId) {
        return AesCompetitorSnapshotStore.NS + server + ":" + String(enterpriseId)
    }

    /**
     * Project a full enterprise record into the compact snapshot shape.
     * Defensive — every field is read with a fallback so a partial scrape
     * never throws.
     */
    static project(record) {
        if (!record || typeof record !== "object") return null
        const fleet = record.fleet || {}
        const fleetByType = Array.isArray(record.fleetByType) ? record.fleetByType : []
        const hubs = Array.isArray(record.hubs) ? record.hubs : []
        const footprint = Array.isArray(record.routeFootprint) ? record.routeFootprint : []

        const fleetTypes = fleetByType.map(f => ({
            typeId:   f && f.typeId != null ? String(f.typeId) : null,
            typeCode: f && f.typeCode || null,
            count:    f && isFinite(f.count) ? Number(f.count) : 0,
            avgAgeMonths: f && isFinite(f.avgAgeMonths) ? Number(f.avgAgeMonths) : null
        })).filter(f => f.typeId)
        fleetTypes.sort((a, b) => String(a.typeId).localeCompare(String(b.typeId)))

        const hubIatas = hubs
            .map(h => h && h.iata ? String(h.iata).toUpperCase() : null)
            .filter(Boolean)
        hubIatas.sort()

        const routeKeys = footprint
            .filter(r => r && r.hub && r.dest)
            .map(r => String(r.hub).toUpperCase() + "-" + String(r.dest).toUpperCase())
        routeKeys.sort()

        return {
            at:                 typeof record.scrapedAt === "number" ? record.scrapedAt : Date.now(),
            allianceId:         record.alliance && record.alliance.id ? String(record.alliance.id) : null,
            allianceName:       record.alliance && record.alliance.name || null,
            baseCountryId:      record.baseCountry && record.baseCountry.id ? String(record.baseCountry.id) : null,
            baseCountryName:    record.baseCountry && record.baseCountry.name || null,
            aircraftCount:      isFinite(fleet.aircraftCount) ? Number(fleet.aircraftCount) : null,
            stationsCount:      isFinite(fleet.stationsCount) ? Number(fleet.stationsCount) : null,
            employeeCount:      isFinite(fleet.employeeCount) ? Number(fleet.employeeCount) : null,
            paxCarried:         isFinite(fleet.paxCarried)    ? Number(fleet.paxCarried)    : null,
            cargoCarried:       isFinite(fleet.cargoCarried)  ? Number(fleet.cargoCarried)  : null,
            rating:             fleet.rating || null,
            fleetTypes:         fleetTypes,
            hubIatas:           hubIatas,
            routeKeys:          routeKeys,
            hubCount:           hubIatas.length,
            routeCount:         routeKeys.length,
            fleetTypeCount:     fleetTypes.length
        }
    }

    /**
     * Returns true when projected snapshot differs from the prior one in any
     * tracked field. Pure comparison — no storage reads.
     */
    static differs(prev, curr) {
        if (!prev || !curr) return !!curr
        const scalarKeys = [
            "allianceId", "baseCountryId",
            "aircraftCount", "stationsCount", "employeeCount",
            "paxCarried", "cargoCarried", "rating",
            "hubCount", "routeCount", "fleetTypeCount"
        ]
        for (const k of scalarKeys) {
            if (prev[k] !== curr[k]) return true
        }
        if (!_arrayEq(prev.hubIatas, curr.hubIatas)) return true
        if (!_arrayEq(prev.routeKeys, curr.routeKeys)) return true
        if (!_fleetTypesEq(prev.fleetTypes, curr.fleetTypes)) return true
        return false
    }

    static async loadHistory(server, enterpriseId) {
        const key = AesCompetitorSnapshotStore._key(server, enterpriseId)
        const data = await chrome.storage.local.get([key])
        const rec = data[key]
        if (!rec || !Array.isArray(rec.snapshots)) return []
        return rec.snapshots.slice()
    }

    static async loadLatest(server, enterpriseId) {
        const list = await AesCompetitorSnapshotStore.loadHistory(server, enterpriseId)
        return list.length ? list[list.length - 1] : null
    }

    /**
     * Append a snapshot derived from `record` if it differs from the prior.
     * Returns the appended snapshot (or null when no change). Caps the
     * buffer at CAP entries by dropping oldest first.
     */
    static async record(server, enterpriseId, record) {
        if (!server || enterpriseId == null || !record) return null
        const key = AesCompetitorSnapshotStore._key(server, enterpriseId)
        const data = await chrome.storage.local.get([key])
        const existing = data[key] && Array.isArray(data[key].snapshots)
            ? data[key].snapshots.slice()
            : []
        const projected = AesCompetitorSnapshotStore.project(record)
        if (!projected) return null
        const prior = existing.length ? existing[existing.length - 1] : null
        if (!AesCompetitorSnapshotStore.differs(prior, projected)) return null
        existing.push(projected)
        while (existing.length > AesCompetitorSnapshotStore.CAP) existing.shift()
        await chrome.storage.local.set({[key]: {
            server, enterpriseId: String(enterpriseId), snapshots: existing
        }})
        if (window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:competitor-intel:enterprise:updated", {
                server, eid: String(enterpriseId)
            })
            if (prior && window.AesCompetitorDiff
                    && typeof window.AesCompetitorDiff.compare === "function") {
                try {
                    const events = window.AesCompetitorDiff.compare(prior, projected)
                    if (events && events.length) {
                        window.AesDataBus.emit("data:competitor-intel:enterprise:diff", {
                            server,
                            eid:        String(enterpriseId),
                            eventCount: events.length,
                            types:      events.map(e => e.type)
                        })
                        const newRoutes = []
                        for (const e of events) {
                            if (e.type === "route.entered" && e.payload && Array.isArray(e.payload.routes)) {
                                newRoutes.push(...e.payload.routes)
                            }
                        }
                        const fleetUp = events.some(e => e.type === "fleet.gained" || e.type === "fleet.type.added")
                        if (newRoutes.length || fleetUp) {
                            window.AesDataBus.emit("signal:strategy:competitor-threat", {
                                server,
                                eid:    String(enterpriseId),
                                kind:   newRoutes.length ? "newRoute" : "capacityHike",
                                routes: newRoutes
                            })
                        }
                    }
                } catch (_) { /* never block save on diff failures */ }
            }
        }
        return projected
    }

    static async clearAll(server) {
        const all = await chrome.storage.local.get(null)
        const prefix = AesCompetitorSnapshotStore.NS + (server ? server + ":" : "")
        const toRemove = []
        for (const k in all) if (k.indexOf(prefix) === 0) toRemove.push(k)
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
        return toRemove.length
    }
}

function _arrayEq(a, b) {
    if (a === b) return true
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

function _fleetTypesEq(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return a === b
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i]
        if (!x || !y) return false
        if (x.typeId !== y.typeId) return false
        if (x.count  !== y.count)  return false
    }
    return true
}

if (typeof window !== "undefined") {
    window.AesCompetitorSnapshotStore = AesCompetitorSnapshotStore
}
