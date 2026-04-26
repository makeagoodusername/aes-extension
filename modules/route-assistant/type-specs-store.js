/**
 * Persistent cache for AS aircraft type specs.
 *
 * Stored as one chrome.storage.local key per typeId so a `get(typeId)` is a
 * single read and the resolver can fan out concurrent reads without loading
 * every type at once. Type specs are server- and airline-agnostic (they
 * describe game physics, not enterprise data) so this store is shared across
 * every game world.
 *
 *   chrome.storage.local["routeAssistant:typeSpec:<typeId>"] = {
 *       typeId, typeName, seats, cargoCapacity, speed, range,
 *       paxSatisfaction, fetchedAt
 *   }
 *
 * Failed fetches are NOT cached — `save()` rejects records that have no usable
 * data so the next mount can retry instead of being stuck with a permanent
 * placeholder.
 */
class RouteAssistantTypeSpecsStore {
    static PREFIX = "routeAssistant:typeSpec:"

    static _key(typeId) {
        return RouteAssistantTypeSpecsStore.PREFIX + String(typeId)
    }

    /**
     * @returns {Promise<object|null>} the cached record or null.
     */
    static async get(typeId) {
        if (!typeId) return null
        const key = RouteAssistantTypeSpecsStore._key(typeId)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    /**
     * Bulk read — returns Map<typeId, record> for the typeIds that have a
     * cached entry. typeIds without an entry are simply absent from the map.
     */
    static async getMany(typeIds) {
        const ids = (typeIds || []).filter(Boolean)
        if (!ids.length) return new Map()
        const keys = ids.map(id => RouteAssistantTypeSpecsStore._key(id))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec || !rec.typeId) continue
            map.set(rec.typeId, rec)
        }
        return map
    }

    /**
     * Persist a spec record. Drops records with no usable data so future calls
     * can retry. Stamps `fetchedAt` if the caller hasn't.
     * @returns {Promise<boolean>} true if written, false if the record was
     *   too empty to keep.
     */
    static async save(record) {
        if (!record || !record.typeId) return false
        // The detail page sometimes returns a 200 with an empty / login-redirect
        // body — record.seats and record.range both null is the tell. Skip
        // saving so the next mount retries.
        const hasAnyData = (record.seats != null && record.seats > 0)
                        || (record.range != null && record.range > 0)
                        || (record.cargoCapacity != null && record.cargoCapacity > 0)
        if (!hasAnyData) return false

        const stamped = Object.assign({fetchedAt: Date.now()}, record)
        const key = RouteAssistantTypeSpecsStore._key(record.typeId)
        await chrome.storage.local.set({[key]: stamped})
        return true
    }
}
