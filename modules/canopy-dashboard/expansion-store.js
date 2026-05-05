"use strict"

/**
 * Store for Regional Expansion Plans.
 * Persists custom region definitions, goals (market share, weekly seats),
 * and direct fleet allocations.
 */
class RegionExpansionStore {
    static STORAGE_KEY = "aesCanopy:expansionPlans";

    static async load() {
        const data = await chrome.storage.local.get([this.STORAGE_KEY]);
        return data[this.STORAGE_KEY] || { regions: [] };
    }

    static async save(data) {
        await chrome.storage.local.set({ [this.STORAGE_KEY]: data });
    }

    static async addRegion(regionDef) {
        const data = await this.load();
        regionDef.id = "region_" + Date.now();
        data.regions.push(regionDef);
        await this.save(data);
        return regionDef.id;
    }

    static async updateRegion(regionId, updates) {
        const data = await this.load();
        const idx = data.regions.findIndex(r => r.id === regionId);
        if (idx !== -1) {
            data.regions[idx] = { ...data.regions[idx], ...updates };
            await this.save(data);
        }
    }

    static async removeRegion(regionId) {
        const data = await this.load();
        data.regions = data.regions.filter(r => r.id !== regionId);
        await this.save(data);
    }
}

if (typeof window !== "undefined") {
    window.RegionExpansionStore = RegionExpansionStore;
}
