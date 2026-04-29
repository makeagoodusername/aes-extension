"use strict"

/**
 * Per-account "starred presets" map. Pinning lives on the canonical
 * preset record (`preset.pinned: true` in SchedulePresets); starring
 * is per-account because two sister airlines may have different
 * favorite-preset shortlists.
 *
 * Storage:
 *   routeAssistant:waveFavorites              → (legacy)
 *   routeAssistant:waveFavorites:acct:<id>    → (L2+)
 *     {byPresetId: {<presetId>: {starredAt: ms, useCount: int, lastUsedAt: ms}}}
 *
 * The wave palette uses `useCount` and `lastUsedAt` to populate the
 * "Recent" ring at the top of the result list.
 */
class RouteAssistantWaveFavoritesStore {
    static LEGACY_KEY   = "routeAssistant:waveFavorites"
    static SCOPE_PREFIX = "routeAssistant:waveFavorites"

    static _key()       { return acctKey(RouteAssistantWaveFavoritesStore.SCOPE_PREFIX, "") }
    static _legacyKey() { return RouteAssistantWaveFavoritesStore.LEGACY_KEY }

    static async load() {
        const ns = RouteAssistantWaveFavoritesStore._key()
        const lg = RouteAssistantWaveFavoritesStore._legacyKey()
        const keys = (ns === lg) ? [ns] : [ns, lg]
        const out  = await chrome.storage.local.get(keys)
        const raw  = (out[ns] !== undefined) ? out[ns] : (out[lg] || null)
        const map  = (raw && typeof raw.byPresetId === "object") ? raw.byPresetId : {}
        return {byPresetId: map}
    }

    static async _save(byPresetId) {
        const ns = RouteAssistantWaveFavoritesStore._key()
        await chrome.storage.local.set({[ns]: {byPresetId, updatedAt: Date.now()}})
    }

    static async toggleStar(presetId) {
        if (!presetId) return null
        const block = await RouteAssistantWaveFavoritesStore.load()
        const map   = Object.assign({}, block.byPresetId)
        if (map[presetId]) {
            delete map[presetId]
        } else {
            map[presetId] = {starredAt: Date.now(), useCount: 0, lastUsedAt: null}
        }
        await RouteAssistantWaveFavoritesStore._save(map)
        return map[presetId] || null
    }

    static async noteUsed(presetId) {
        if (!presetId) return
        const block = await RouteAssistantWaveFavoritesStore.load()
        const map   = Object.assign({}, block.byPresetId)
        const rec   = map[presetId] || {starredAt: null, useCount: 0, lastUsedAt: null}
        rec.useCount   = Number(rec.useCount || 0) + 1
        rec.lastUsedAt = Date.now()
        map[presetId]  = rec
        await RouteAssistantWaveFavoritesStore._save(map)
    }

    static async isStarred(presetId) {
        if (!presetId) return false
        const block = await RouteAssistantWaveFavoritesStore.load()
        return !!(block.byPresetId && block.byPresetId[presetId] && block.byPresetId[presetId].starredAt)
    }

    static async listStarred() {
        const block = await RouteAssistantWaveFavoritesStore.load()
        const out   = []
        for (const id in block.byPresetId) {
            if (block.byPresetId[id] && block.byPresetId[id].starredAt) {
                out.push({presetId: id, ...block.byPresetId[id]})
            }
        }
        out.sort((a, b) => (b.starredAt || 0) - (a.starredAt || 0))
        return out
    }

    static async listRecent(limit) {
        const block = await RouteAssistantWaveFavoritesStore.load()
        const out   = []
        for (const id in block.byPresetId) {
            const rec = block.byPresetId[id]
            if (rec && rec.lastUsedAt) out.push({presetId: id, ...rec})
        }
        out.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
        return out.slice(0, Number(limit) || 10)
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantWaveFavoritesStore = RouteAssistantWaveFavoritesStore
}
