"use strict"

/**
 * User-defined geographic region groupings. Region membership is a bag
 * with three orthogonal selectors:
 *   - countries[]: AS countryId (number)
 *   - iso2Codes[]: ISO 3166-1 alpha-2 strings
 *   - continents[]: AesGeographyBase continent ids ("EU","NA",…)
 *
 * The region-resolver walks all three (specific → general) when computing
 * `tail.regionId` for a hub IATA. Default region seeds are sourced from
 * `AesGeographyBase.defaultRegions()` on first load.
 *
 * Storage: `aesCanopy:regions` — single canopy-scope blob.
 *
 *   {
 *     schemaVersion: 1,
 *     regions: { [regionId]: Region },
 *     defaults: { [regionId]: {defaultPresetId, utilizationTarget, maintTargetRatio} }
 *   }
 *
 * `defaults` is consumed by Lane B's wave-registry default-preset resolver
 * and by Lane C's per-region utilization roll-ups.
 */
;(function () {
    if (window.AesCanopyRegionsStore) return

    const KEY = "aesCanopy:regions"

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesAfp && window.AesAfp.bus) window.AesAfp.bus.emit(event, payload) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) window.AesStrategy.bus.emit(event, payload) } catch (_) {}
    }

    function _id() {
        return "rg" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
    }

    function _defaults() {
        return {schemaVersion: 1, regions: {}, defaults: {}}
    }

    async function _readRaw() {
        const out = await chrome.storage.local.get([KEY])
        return out[KEY] || null
    }

    async function _save(block) {
        await chrome.storage.local.set({[KEY]: block})
    }

    /**
     * Lazy-init: on first load, populate from `AesGeographyBase.defaultRegions()`.
     * Subsequent loads return whatever's stored. Idempotent — calling load()
     * many times only seeds once.
     */
    async function load() {
        const raw = await _readRaw()
        if (raw && raw.regions && Object.keys(raw.regions).length > 0) {
            return Object.assign(_defaults(), raw)
        }
        const seeds = (window.AesGeographyBase && typeof window.AesGeographyBase.defaultRegions === "function")
            ? window.AesGeographyBase.defaultRegions() : []
        const block = _defaults()
        for (const r of seeds) block.regions[r.id] = r
        await _save(block)
        return block
    }

    async function create(partial) {
        const block = await load()
        const now = Date.now()
        const region = Object.assign({
            id:          _id(),
            name:        "New region",
            description: "",
            colorToken:  "slate",
            countries:   [],
            iso2Codes:   [],
            continents:  [],
            createdAt:   now,
            updatedAt:   now
        }, partial || {})
        if (block.regions[region.id]) region.id = _id()
        block.regions[region.id] = region
        await _save(block)
        _emit("canopy:regions-changed", {regionId: region.id, action: "created"})
        return region
    }

    async function update(regionId, fields) {
        if (!regionId) return null
        const block = await load()
        const r = block.regions[regionId]
        if (!r) return null
        Object.assign(r, fields || {}, {updatedAt: Date.now()})
        await _save(block)
        _emit("canopy:regions-changed", {regionId, action: "updated"})
        return r
    }

    async function remove(regionId) {
        if (!regionId) return false
        const block = await load()
        if (!block.regions[regionId]) return false
        delete block.regions[regionId]
        if (block.defaults[regionId]) delete block.defaults[regionId]
        await _save(block)
        _emit("canopy:regions-changed", {regionId, action: "deleted"})
        return true
    }

    async function setDefault(regionId, fields) {
        if (!regionId) return null
        const block = await load()
        block.defaults[regionId] = Object.assign({}, block.defaults[regionId] || {}, fields || {})
        await _save(block)
        _emit("canopy:regions-changed", {regionId, action: "default-updated"})
        return block.defaults[regionId]
    }

    async function listRegions() {
        const block = await load()
        return Object.values(block.regions).sort((a, b) =>
            (a.createdAt || 0) - (b.createdAt || 0))
    }

    async function resetToSeeds() {
        await chrome.storage.local.remove([KEY])
        return load()    // re-seeds
    }

    window.AesCanopyRegionsStore = {
        load, create, update, remove, setDefault,
        listRegions, resetToSeeds,
        KEY
    }
})()
