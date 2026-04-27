/**
 * Restructure slice E — Per-route wave-placement overrides.
 *
 * The wave-overlay's greedy assignment buckets routes by haul length and
 * fills each wave up to its composition count. Slice E lets the user
 * override that placement: drag an "Unplaced" chip onto a swim lane and
 * the route is force-assigned to that wave regardless of bucket capacity.
 *
 * Storage layout:
 *   key:   `routeAssistant:waveOverrides:<HUB>:<presetId>`
 *   value: { [destIata]: waveId }
 *
 * Per-(hub, preset) so overrides on one wave plan don't leak into
 * another, and per-hub so cross-hub view (slice 2) keeps overrides
 * scoped to the right schedule. Storage payload is tiny (3-letter keys,
 * 13-char values), no expiry needed.
 */
class RouteAssistantWaveOverridesStore {

    static _key(hubIata, presetId) {
        const hub = String(hubIata || "").toUpperCase()
        const pid = String(presetId || "")
        return "routeAssistant:waveOverrides:" + hub + ":" + pid
    }

    /** Load the override map for (hub, preset). Returns {} if none. */
    static async load(hubIata, presetId) {
        if (!hubIata || !presetId) return {}
        const key = RouteAssistantWaveOverridesStore._key(hubIata, presetId)
        try {
            const blob = await chrome.storage.local.get([key])
            const map = blob[key]
            return (map && typeof map === "object") ? map : {}
        } catch (e) {
            console.warn("[AES wave-overrides] load failed:", e)
            return {}
        }
    }

    /** Replace the override map for (hub, preset). Empty map deletes the key. */
    static async save(hubIata, presetId, map) {
        if (!hubIata || !presetId) return
        const key = RouteAssistantWaveOverridesStore._key(hubIata, presetId)
        try {
            const cleaned = {}
            for (const dest in (map || {})) {
                const d = String(dest).toUpperCase()
                const w = String(map[dest] || "")
                if (d && w) cleaned[d] = w
            }
            if (Object.keys(cleaned).length === 0) {
                await chrome.storage.local.remove([key])
            } else {
                await chrome.storage.local.set({[key]: cleaned})
            }
        } catch (e) {
            console.warn("[AES wave-overrides] save failed:", e)
        }
    }

    /** Convenience — set one (dest → wave) and persist. */
    static async set(hubIata, presetId, destIata, waveId) {
        const map = await RouteAssistantWaveOverridesStore.load(hubIata, presetId)
        map[String(destIata).toUpperCase()] = String(waveId)
        await RouteAssistantWaveOverridesStore.save(hubIata, presetId, map)
        return map
    }

    /** Convenience — clear one dest's override and persist. */
    static async clear(hubIata, presetId, destIata) {
        const map = await RouteAssistantWaveOverridesStore.load(hubIata, presetId)
        delete map[String(destIata).toUpperCase()]
        await RouteAssistantWaveOverridesStore.save(hubIata, presetId, map)
        return map
    }

    /** Convenience — drop every override for (hub, preset). */
    static async clearAll(hubIata, presetId) {
        await RouteAssistantWaveOverridesStore.save(hubIata, presetId, {})
    }

    /**
     * GC hook — caller passes the active preset's wave-id list and we
     * drop any override pointing at a wave that no longer exists. Useful
     * after the user deletes a wave; otherwise stale overrides accumulate.
     */
    static async pruneToWaves(hubIata, presetId, validWaveIds) {
        const valid = new Set((validWaveIds || []).map(String))
        const map = await RouteAssistantWaveOverridesStore.load(hubIata, presetId)
        let changed = false
        for (const d in map) {
            if (!valid.has(String(map[d]))) {
                delete map[d]
                changed = true
            }
        }
        if (changed) {
            await RouteAssistantWaveOverridesStore.save(hubIata, presetId, map)
        }
        return map
    }
}
