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

    static _store() {
        // Lazy: createPrefixStore loads earlier in the manifest, but build on
        // first use so the class is safe to evaluate at import time too.
        if (!RouteAssistantTypeSpecsStore.__store) {
            RouteAssistantTypeSpecsStore.__store = window.createPrefixStore({
                prefix: RouteAssistantTypeSpecsStore.PREFIX
            })
        }
        return RouteAssistantTypeSpecsStore.__store
    }

    /**
     * @returns {Promise<object|null>} the cached record or null.
     */
    static async get(typeId) {
        if (!typeId) return null
        return await RouteAssistantTypeSpecsStore._store().get(typeId)
    }

    /**
     * Bulk read — returns Map<typeId, record> for the typeIds that have a
     * cached entry. typeIds without an entry are simply absent from the map.
     */
    static async getMany(typeIds) {
        const ids = (typeIds || []).filter(Boolean)
        if (!ids.length) return new Map()
        const raw = await RouteAssistantTypeSpecsStore._store().bulkGet(ids)
        // Re-key by record.typeId so callers don't depend on suffix being the typeId,
        // matching the prior contract.
        const map = new Map()
        for (const [, rec] of raw) {
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
        await RouteAssistantTypeSpecsStore._store().set(record.typeId, stamped)
        return true
    }
}
