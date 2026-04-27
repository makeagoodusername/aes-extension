"use strict"

/**
 * Track 8 slice 8d — unified aircraft spec resolver.
 *
 * Wraps the three sources of truth that exist today:
 *
 *   1. RouteAssistantTypeSpecsStore   — cache by typeId (when loaded)
 *   2. AESAircraftTypeSpecs.fetchById — fresh fetch from AS (when loaded)
 *   3. window.AesAfpSpecResolver.last — already-resolved spec from the
 *      AFP page (when on /app/fleets/aircraft/*\/0)
 *
 * Plus the typeId resolution path that `spec-resolver.js` does
 * inline today: equipment → fleet roster lookup → typeId.
 *
 * Public API:
 *
 *   AesAircraftSpec.get({typeId})                          → Promise<Spec|null>
 *   AesAircraftSpec.get({equipment, server, airlineCode})  → Promise<Spec|null>
 *   AesAircraftSpec.get({aircraftId, server, airlineCode}) → Promise<Spec|null>
 *
 * Optional `forceFetch: true` bypasses the cache.
 *
 * Sync read of the AFP page's already-resolved spec (no I/O):
 *
 *   AesAircraftSpec.current()  → Spec | null
 *
 * Spec shape (matches `spec-resolver.js`'s output):
 *
 *   {typeId, typeName, seats, cargoCapacity, cruiseSpeedKmh, range,
 *    paxSatisfaction, source}
 *   source ∈ "current" | "cached" | "fetched"
 *
 * Graceful degradation: when `RouteAssistantTypeSpecsStore` or
 * `AESAircraftTypeSpecs` aren't loaded on the calling page, the
 * corresponding step is skipped. If both are missing and `current()` has
 * nothing cached, `get()` resolves to null.
 */
class AesAircraftSpec {
    /** Sync read of AFP page's already-resolved spec (null off-page). */
    static current() {
        if (typeof window === "undefined") return null
        const r = window.AesAfpSpecResolver
        return (r && r.last) ? r.last : null
    }

    /**
     * Full resolution. Never throws — resolves to null on any failure
     * (missing stores, fleet roster miss, fetch error).
     */
    static async get(req) {
        const r = req || {}
        const forceFetch = !!r.forceFetch

        let typeId    = isFinite(Number(r.typeId)) ? Number(r.typeId) : null
        let equipment = r.equipment || null

        if (!typeId && r.server && (r.equipment || r.aircraftId)) {
            try {
                typeId = await AesAircraftSpec._resolveTypeIdFromRoster(r, equipment)
                if (!equipment && typeId) equipment = r.equipment || null
            } catch (e) {
                console.warn("[AesAircraftSpec] roster lookup failed", e)
            }
        }
        if (!typeId) return null

        if (!forceFetch && typeof RouteAssistantTypeSpecsStore !== "undefined") {
            try {
                const cached = await RouteAssistantTypeSpecsStore.get(typeId)
                if (cached) return AesAircraftSpec._buildSpec(cached, equipment, "cached")
            } catch (e) {
                console.warn("[AesAircraftSpec] cache read failed", e)
            }
        }

        if (typeof AESAircraftTypeSpecs === "undefined") return null
        let fetched = null
        try { fetched = await AESAircraftTypeSpecs.fetchById(typeId) }
        catch (e) {
            console.warn("[AesAircraftSpec] fetch failed", e)
            return null
        }
        if (!fetched) return null

        const record = Object.assign(
            {typeId, typeName: equipment || fetched.typeName || ""},
            fetched
        )
        if (typeof RouteAssistantTypeSpecsStore !== "undefined") {
            try { await RouteAssistantTypeSpecsStore.save(record) }
            catch (e) { console.warn("[AesAircraftSpec] cache save failed", e) }
        }
        return AesAircraftSpec._buildSpec(record, equipment, "fetched")
    }

    /* ─────── internals ─────── */

    static async _resolveTypeIdFromRoster(req, equipment) {
        if (typeof AesFleetRoster === "undefined") return null
        const fleet = await AesFleetRoster.load(req.server, req.airlineCode || null)

        if (req.aircraftId != null) {
            const a = AesFleetRoster.findByAircraftId(fleet, req.aircraftId)
            return (a && a.typeId) ? Number(a.typeId) : null
        }
        if (equipment) {
            const wanted = String(equipment).trim().toLowerCase()
            for (const slot of (fleet.byType || new Map()).values()) {
                if (!slot || !slot.typeId) continue
                if (String(slot.typeName || "").trim().toLowerCase() === wanted) {
                    return Number(slot.typeId)
                }
            }
        }
        return null
    }

    static _buildSpec(record, equipment, source) {
        return {
            typeId:          record.typeId,
            typeName:        equipment || record.typeName || "",
            seats:           record.seats          != null ? record.seats          : null,
            cargoCapacity:   record.cargoCapacity  != null ? record.cargoCapacity  : null,
            cruiseSpeedKmh:  record.speed          != null ? record.speed          : null,
            range:           record.range          != null ? record.range          : null,
            paxSatisfaction: record.paxSatisfaction != null ? record.paxSatisfaction : null,
            source
        }
    }
}

if (typeof window !== "undefined") {
    window.AesAircraftSpec = AesAircraftSpec
}
