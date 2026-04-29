"use strict"

/**
 * Command Bridge slice CB-1 — priority board persistence.
 *
 * Holds the cross-enterprise priority deck under a single global key
 * (NOT account-scoped — priorities span subsidiaries by design).
 *
 *   chrome.storage.local["aes:command-bridge:priorities:v1"] = {
 *     version: 1,
 *     items: [{
 *       id, title, lane, rank,
 *       accountIds: [...], kinIds: [...],
 *       note, createdAt, updatedAt
 *     }]
 *   }
 *
 * Lanes are the strings "NOW" / "NEXT" / "LATER". Rank is a per-lane
 * float (gaps left for cheap insertion without re-numbering siblings).
 *
 * Cross-tab consistency: callers should subscribe via `subscribe(cb)`,
 * which wires a chrome.storage.onChanged listener and returns a
 * dispose function.
 */
class AesBridgePriorityStore {
    static KEY = "aes:command-bridge:priorities:v1"
    static LANES = ["NOW", "NEXT", "LATER"]

    static async load() {
        const got = await chrome.storage.local.get([AesBridgePriorityStore.KEY])
        const blob = got[AesBridgePriorityStore.KEY]
        if (!blob || typeof blob !== "object") return {version: 1, items: []}
        const items = Array.isArray(blob.items) ? blob.items.map(AesBridgePriorityStore._normalize) : []
        return {version: 1, items: items.filter(Boolean)}
    }

    static async save(blob) {
        const items = Array.isArray(blob && blob.items) ? blob.items.map(AesBridgePriorityStore._normalize).filter(Boolean) : []
        await chrome.storage.local.set({[AesBridgePriorityStore.KEY]: {version: 1, items}})
    }

    static async add({title, lane, accountIds, kinIds, note}) {
        const blob = await AesBridgePriorityStore.load()
        const useLane = AesBridgePriorityStore.LANES.indexOf(lane) >= 0 ? lane : "NOW"
        const sameLane = blob.items.filter(i => i.lane === useLane)
        const maxRank = sameLane.reduce((m, i) => Math.max(m, i.rank || 0), 0)
        const now = Date.now()
        const item = AesBridgePriorityStore._normalize({
            id:         AesBridgePriorityStore._newId(),
            title:      String(title || "").slice(0, 200),
            lane:       useLane,
            rank:       maxRank + 1000,
            accountIds: Array.isArray(accountIds) ? accountIds.slice() : [],
            kinIds:     Array.isArray(kinIds)     ? kinIds.slice()     : [],
            note:       String(note || "").slice(0, 1000),
            createdAt:  now,
            updatedAt:  now
        })
        blob.items.push(item)
        await AesBridgePriorityStore.save(blob)
        return item
    }

    static async update(id, patch) {
        const blob = await AesBridgePriorityStore.load()
        const idx = blob.items.findIndex(i => i.id === id)
        if (idx < 0) return null
        const merged = Object.assign({}, blob.items[idx], patch || {}, {updatedAt: Date.now()})
        blob.items[idx] = AesBridgePriorityStore._normalize(merged)
        await AesBridgePriorityStore.save(blob)
        return blob.items[idx]
    }

    static async remove(id) {
        const blob = await AesBridgePriorityStore.load()
        const next = blob.items.filter(i => i.id !== id)
        if (next.length === blob.items.length) return false
        await AesBridgePriorityStore.save({version: 1, items: next})
        return true
    }

    /**
     * Reorder by moving `id` into `lane` at the position before the item
     * with id `beforeId`. `beforeId === null` appends to the lane's tail.
     * Ranks are recomputed only for the destination lane.
     */
    static async move(id, lane, beforeId) {
        const blob = await AesBridgePriorityStore.load()
        const moving = blob.items.find(i => i.id === id)
        if (!moving) return null
        const useLane = AesBridgePriorityStore.LANES.indexOf(lane) >= 0 ? lane : moving.lane

        const others = blob.items.filter(i => i.id !== id && i.lane === useLane)
            .sort((a, b) => (a.rank || 0) - (b.rank || 0))
        const insertIdx = beforeId
            ? Math.max(0, others.findIndex(i => i.id === beforeId))
            : others.length
        others.splice(insertIdx, 0, Object.assign({}, moving, {lane: useLane}))

        // Re-rank the lane in 1000-unit gaps for clean future inserts.
        const reranked = others.map((it, i) => Object.assign({}, it, {
            rank:      (i + 1) * 1000,
            updatedAt: it.id === id ? Date.now() : it.updatedAt
        }))
        const untouched = blob.items.filter(i => i.lane !== useLane && i.id !== id)
        const next = untouched.concat(reranked)
        await AesBridgePriorityStore.save({version: 1, items: next})
        return reranked.find(i => i.id === id) || null
    }

    /**
     * Subscribe to cross-tab changes. cb fires with the fresh blob.
     * Returns a dispose function.
     */
    static subscribe(cb) {
        const listener = (changes, area) => {
            if (area !== "local") return
            if (!changes || !changes[AesBridgePriorityStore.KEY]) return
            AesBridgePriorityStore.load().then(cb).catch(() => {})
        }
        chrome.storage.onChanged.addListener(listener)
        return () => {
            try { chrome.storage.onChanged.removeListener(listener) } catch (_) { /* noop */ }
        }
    }

    static _newId() {
        return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
    }

    static _normalize(raw) {
        if (!raw || !raw.id || !raw.title) return null
        const lane = AesBridgePriorityStore.LANES.indexOf(raw.lane) >= 0 ? raw.lane : "NOW"
        return {
            id:         String(raw.id),
            title:      String(raw.title).slice(0, 200),
            lane:       lane,
            rank:       Number(raw.rank) || 0,
            accountIds: Array.isArray(raw.accountIds) ? raw.accountIds.map(String) : [],
            kinIds:     Array.isArray(raw.kinIds)     ? raw.kinIds.map(String)     : [],
            note:       String(raw.note || "").slice(0, 1000),
            createdAt:  Number(raw.createdAt) || Date.now(),
            updatedAt:  Number(raw.updatedAt) || Number(raw.createdAt) || Date.now()
        }
    }
}

if (typeof window !== "undefined") {
    window.AesBridgePriorityStore = AesBridgePriorityStore
}
