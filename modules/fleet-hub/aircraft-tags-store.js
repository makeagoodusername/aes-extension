"use strict"

/**
 * Per-account aircraft tag store. Tags are the per-aircraft customisation
 * dimension that makes routines composable — a routine can target every
 * "spare" aircraft, every "rotation" tail, etc. without naming aircraft
 * individually.
 *
 * Vocabulary is intentionally controlled (not free-form strings) so a
 * routine's filter is portable across pages, sister airlines, and over
 * time. New vocabulary items go through this file's STATUSES / ROLES
 * exports rather than landing in storage as ad-hoc strings.
 *
 * Storage:
 *   aircraftTags                 → (legacy)
 *   aircraftTags:acct:<id>       → (L2+)
 *     {
 *       byAircraftId: {
 *         [aircraftId]: {
 *           status:    "operational" | "spare" | "maintenance" | "transit"
 *                    | "leased" | "reserve" | "training" | null,
 *           roles:     ("hub-anchor"|"rotation"|"feeder"|"charter"|"freight")[],
 *           notes:     string,
 *           updatedAt: ms
 *         }
 *       },
 *       updatedAt: ms
 *     }
 *
 * One key per account holds every aircraft's tag record — fleet sizes are
 * small (~50) so the whole map round-trips cheaply on each read/write.
 */
class AircraftTagsStore {
    static LEGACY_KEY   = "aircraftTags"
    static SCOPE_PREFIX = "aircraftTags"

    /** Status enum — one of these or null. Mutually exclusive. */
    static STATUSES = Object.freeze([
        "operational",
        "spare",
        "maintenance",
        "transit",
        "leased",
        "reserve",
        "training"
    ])

    /** Role enum — zero or many of these. Independent of status. */
    static ROLES = Object.freeze([
        "hub-anchor",
        "rotation",
        "feeder",
        "charter",
        "freight"
    ])

    /** Display labels for the controlled vocabularies. */
    static STATUS_LABELS = Object.freeze({
        operational: "Operational",
        spare:       "Spare",
        maintenance: "Maintenance",
        transit:     "Transit",
        leased:      "Leased out",
        reserve:     "Reserve",
        training:    "Training"
    })

    static ROLE_LABELS = Object.freeze({
        "hub-anchor": "Hub anchor",
        rotation:     "Rotation",
        feeder:       "Feeder",
        charter:      "Charter",
        freight:      "Freight"
    })

    static _key()       { return acctKey(AircraftTagsStore.SCOPE_PREFIX, "") }
    static _legacyKey() { return AircraftTagsStore.LEGACY_KEY }

    /**
     * Load the full tag map for the current account. Returns
     * {byAircraftId: {}, updatedAt: 0} when nothing's been written yet.
     */
    static async load() {
        const ns = AircraftTagsStore._key()
        const lg = AircraftTagsStore._legacyKey()
        const keys = (ns === lg) ? [ns] : [ns, lg]
        const out  = await chrome.storage.local.get(keys)
        const raw  = (out[ns] !== undefined) ? out[ns] : (out[lg] || null)
        const map  = (raw && typeof raw.byAircraftId === "object") ? raw.byAircraftId : {}
        return {
            byAircraftId: map,
            updatedAt: Number((raw && raw.updatedAt) || 0)
        }
    }

    /**
     * Read one aircraft's tag record. Returns an empty record (status:null,
     * roles:[]) when nothing's been set — callers can render the empty
     * state without a separate undefined-check.
     */
    static async get(aircraftId) {
        if (!aircraftId) return AircraftTagsStore._empty()
        const block = await AircraftTagsStore.load()
        const rec   = block.byAircraftId[String(aircraftId)]
        return rec ? Object.assign(AircraftTagsStore._empty(), rec) : AircraftTagsStore._empty()
    }

    /**
     * Patch one aircraft's tag record. Pass {status, roles?, notes?}; any
     * field not in the patch falls through. Validates against STATUSES /
     * ROLES — invalid entries silently dropped (defensive against future
     * vocabulary churn). Setting status to null clears it; passing an
     * empty roles[] removes every role.
     */
    static async set(aircraftId, patch) {
        if (!aircraftId) return null
        const block = await AircraftTagsStore.load()
        const map   = Object.assign({}, block.byAircraftId)
        const cur   = map[String(aircraftId)] || AircraftTagsStore._empty()
        const next  = Object.assign({}, cur)

        if (Object.prototype.hasOwnProperty.call(patch || {}, "status")) {
            const s = patch.status
            next.status = (s == null) ? null
                : (AircraftTagsStore.STATUSES.indexOf(s) >= 0 ? s : cur.status)
        }
        if (Array.isArray(patch && patch.roles)) {
            const seen = new Set()
            const clean = []
            for (const r of patch.roles) {
                if (typeof r !== "string") continue
                if (seen.has(r)) continue
                if (AircraftTagsStore.ROLES.indexOf(r) < 0) continue
                seen.add(r); clean.push(r)
            }
            next.roles = clean
        }
        if (typeof (patch && patch.notes) === "string") {
            next.notes = patch.notes
        }
        next.updatedAt = Date.now()

        // If the record reduces to "no information", drop the entry rather
        // than persisting an empty-but-present row — keeps the storage
        // footprint clean and the load() output truthy when meaningful.
        const isEmpty = (next.status == null
            && (!next.roles || !next.roles.length)
            && !next.notes)
        if (isEmpty) delete map[String(aircraftId)]
        else map[String(aircraftId)] = next

        await AircraftTagsStore._save(map)
        return next
    }

    /** Toggle one role on an aircraft. Adds when absent, removes when present. */
    static async toggleRole(aircraftId, role) {
        if (!aircraftId || AircraftTagsStore.ROLES.indexOf(role) < 0) return null
        const cur   = await AircraftTagsStore.get(aircraftId)
        const roles = (cur.roles || []).slice()
        const ix    = roles.indexOf(role)
        if (ix >= 0) roles.splice(ix, 1)
        else         roles.push(role)
        return AircraftTagsStore.set(aircraftId, {roles})
    }

    /** Wipe one aircraft's record entirely. */
    static async clear(aircraftId) {
        if (!aircraftId) return
        const block = await AircraftTagsStore.load()
        if (!block.byAircraftId[String(aircraftId)]) return
        const map = Object.assign({}, block.byAircraftId)
        delete map[String(aircraftId)]
        await AircraftTagsStore._save(map)
    }

    /**
     * Match an aircraft set against a tag filter. Pure — does not read
     * storage. Pass the rows to filter (from the aggregator) and the
     * already-loaded tags map. `filter` shape:
     *   {hubs?:string[], types?:string[], statuses?:string[], roles?:string[]}
     * Empty/missing arrays mean "any". Aircraft must match every present
     * filter dimension; within each array the match is OR.
     *
     * Roles are any-match: an aircraft tagged ["rotation","feeder"]
     * passes a filter wanting ["rotation"] OR ["feeder"]. To require
     * BOTH, list both and the caller can post-filter — this is rarely
     * needed in practice and keeps the matcher simple.
     */
    static match(rows, byAircraftId, filter) {
        const f = filter || {}
        const hubs     = (f.hubs     || []).map(s => String(s).toUpperCase())
        const types    = (f.types    || []).map(s => String(s))
        const statuses = (f.statuses || []).map(s => String(s))
        const roles    = (f.roles    || []).map(s => String(s))

        return rows.filter(r => {
            if (!r) return false
            if (hubs.length && (!r.hub || hubs.indexOf(String(r.hub).toUpperCase()) < 0)) return false
            if (types.length) {
                const t = r.typeId || r.equipment || ""
                if (types.indexOf(String(t)) < 0) return false
            }
            if (statuses.length || roles.length) {
                const tag = byAircraftId[String(r.aircraftId)]
                const tStatus = tag && tag.status
                const tRoles  = (tag && tag.roles) || []
                if (statuses.length && statuses.indexOf(tStatus) < 0) return false
                if (roles.length) {
                    let any = false
                    for (const role of roles) {
                        if (tRoles.indexOf(role) >= 0) { any = true; break }
                    }
                    if (!any) return false
                }
            }
            return true
        })
    }

    /** Distribution counts {status: n, role: n} for the KPI strip. */
    static distribution(byAircraftId) {
        const status = {}
        const role   = {}
        for (const k in byAircraftId) {
            const rec = byAircraftId[k]
            if (!rec) continue
            if (rec.status) status[rec.status] = (status[rec.status] || 0) + 1
            for (const r of (rec.roles || [])) {
                role[r] = (role[r] || 0) + 1
            }
        }
        return {status, role}
    }

    static async _save(byAircraftId) {
        const ns = AircraftTagsStore._key()
        await chrome.storage.local.set({[ns]: {byAircraftId, updatedAt: Date.now()}})
    }

    static _empty() {
        return {status: null, roles: [], notes: "", updatedAt: 0}
    }
}

if (typeof window !== "undefined") {
    window.AircraftTagsStore = AircraftTagsStore
}
