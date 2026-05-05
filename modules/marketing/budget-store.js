"use strict"

/**
 * AES Marketing — per-region budget store (Slice 19).
 *
 * Persists per-region marketing-budget records (the data the engine
 * needs to optimise spend). v1 schema is intentionally narrow — the
 * scraper/applier round-trip lays down whatever AS exposes; the tuner
 * reads back via this same store.
 *
 * Storage keys:
 *   aesMarketing:budgets:<server>:<airline>            (legacy)
 *   aesMarketing:budgets:acct:<id>                     (per-account, preferred)
 *
 * Record shape:
 *   {
 *     scrapedAt:  ms epoch,
 *     server:     string,
 *     airline:    string,
 *     accountId:  string,
 *     regions: [
 *       {
 *         regionId:        string,        // AS region key (e.g. "europe")
 *         regionName:      string,        // human label
 *         currentBudgetAS: number | null, // weekly spend in AS$
 *         maxBudgetAS:     number | null, // hard cap if AS exposes it
 *         observedDemand:  number | null, // demand bar value, when scrape captures it
 *         lastChangedAt:   ms epoch | null
 *       }
 *     ]
 *   }
 *
 * Public API (window.AesMarketingBudgetStore):
 *   load(ctx?)             → Promise<record | null>
 *   save(record, ctx?)     → Promise<record>
 *   clear(ctx?)            → Promise<void>
 *   updateRegion(regionId, patch, ctx?) → Promise<record>
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesMarketingBudgetStore) return

    const KEY_BASE = "aesMarketing:budgets"

    function _scopedKey(ctx) {
        const id = ctx && ctx.accountId
        if (id) return KEY_BASE + ":acct:" + id
        if (ctx && ctx.server && ctx.airline) {
            return KEY_BASE + ":" + ctx.server + ":" + ctx.airline
        }
        return KEY_BASE
    }

    async function load(ctx) {
        const key = _scopedKey(ctx)
        // F-9227-002: only fall back to the legacy KEY_BASE when the caller
        // has NO accountId hint. With an accountId hint, a missing scoped
        // record must surface as null — the legacy global may belong to a
        // different account that hand-seeded without registry mapping.
        const allowLegacyFallback = !(ctx && ctx.accountId)
        try {
            const got = await chrome.storage.local.get([key, KEY_BASE])
            if (got[key] !== undefined) return got[key]
            if (allowLegacyFallback && got[KEY_BASE] !== undefined) return got[KEY_BASE]
            return null
        } catch (e) {
            console.warn("[AesMarketingBudgetStore] load failed", e)
            return null
        }
    }

    async function save(record, ctx) {
        if (!record || typeof record !== "object") {
            throw new Error("AesMarketingBudgetStore.save: record required")
        }
        const stamped = Object.assign({scrapedAt: Date.now()}, record, {
            server:    (ctx && ctx.server)    || record.server    || null,
            airline:   (ctx && ctx.airline)   || record.airline   || null,
            accountId: (ctx && ctx.accountId) || record.accountId || null
        })
        const writes = {}
        writes[_scopedKey(ctx)] = stamped
        if (!stamped.accountId) writes[KEY_BASE] = stamped
        try { await chrome.storage.local.set(writes) }
        catch (e) { console.warn("[AesMarketingBudgetStore] save failed", e) }
        return stamped
    }

    async function updateRegion(regionId, patch, ctx) {
        if (!regionId) throw new Error("updateRegion: regionId required")
        const cur = await load(ctx)
        if (!cur) throw new Error("updateRegion: no existing record")
        const regions = (cur.regions || []).slice()
        const idx = regions.findIndex(r => r && r.regionId === regionId)
        if (idx < 0) {
            regions.push(Object.assign({regionId: regionId}, patch || {}))
        } else {
            regions[idx] = Object.assign({}, regions[idx], patch || {})
        }
        const next = Object.assign({}, cur, {regions: regions, scrapedAt: Date.now()})
        return save(next, ctx)
    }

    async function clear(ctx) {
        const keys = [_scopedKey(ctx)]
        if (!ctx || !ctx.accountId) keys.push(KEY_BASE)
        try { await chrome.storage.local.remove(keys) }
        catch (e) { console.warn("[AesMarketingBudgetStore] clear failed", e) }
    }

    window.AesMarketingBudgetStore = {
        load:         load,
        save:         save,
        updateRegion: updateRegion,
        clear:        clear,
        KEY_BASE:     KEY_BASE
    }
})()
