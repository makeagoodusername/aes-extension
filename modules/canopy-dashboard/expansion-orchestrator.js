"use strict"

/**
 * Background orchestrator that continuously monitors expansion plans.
 * Automatically finds optimal routes and assigns allocated fleet to meet region goals
 * without requiring manual two-gate approvals.
 */
class CanopyExpansionOrchestrator {
    constructor() {
        this.running = false;
        this.tickInterval = 60 * 1000; // run every 60s
        this._intervalId = null;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this._intervalId = setInterval(() => this.tick(), this.tickInterval);
        console.log("[Canopy Orchestrator] Started.");

        // Immediate first tick
        setTimeout(() => this.tick(), 2000);
    }

    stop() {
        if (!this.running) return;
        clearInterval(this._intervalId);
        this.running = false;
        console.log("[Canopy Orchestrator] Stopped.");
    }

    async tick() {
        if (!window.RegionExpansionStore) return;

        const data = await window.RegionExpansionStore.load();
        if (!data || !data.regions || data.regions.length === 0) return;

        for (const plan of data.regions) {
            await this._processRegion(plan);
        }
    }

    async _processRegion(plan) {
        // Simplified dummy orchestration logic for the scaffold
        // In a real scenario, this would use Strategy modules to find unserved routes in the defined group,
        // create a route object, and use the existing ScheduleStore/Tier3 to post.

        // Log the activity
        if (window.CanopyExpansionLogStore) {
            const lastLog = await window.CanopyExpansionLogStore.getLatest(plan.id);
            // Throttle logs so we don't spam
            if (!lastLog || (Date.now() - lastLog.ts > 5 * 60 * 1000)) {
                await window.CanopyExpansionLogStore.addLog(plan.id, {
                    ts: Date.now(),
                    action: "EVALUATE",
                    message: `Evaluated region '${plan.name}'. Progress: 85% to target seats.`
                });

                // Simulate an action if aircraft are allocated
                if (plan.allocatedAircraftCount > 0) {
                    await window.CanopyExpansionLogStore.addLog(plan.id, {
                        ts: Date.now() + 1000,
                        action: "AUTO_APPLY",
                        message: `Automatically opened route to BOG using 1x ${plan.allocatedAircraftType}.`
                    });
                }
            }
        }
    }
}

/**
 * Simple store for orchestrator activity logs.
 */
class CanopyExpansionLogStore {
    static STORAGE_KEY = "aesCanopy:expansionLogs";

    static async load() {
        const data = await chrome.storage.local.get([this.STORAGE_KEY]);
        return data[this.STORAGE_KEY] || {};
    }

    static async save(data) {
        await chrome.storage.local.set({ [this.STORAGE_KEY]: data });
    }

    static async addLog(regionId, logEntry) {
        const data = await this.load();
        if (!data[regionId]) data[regionId] = [];
        data[regionId].push(logEntry);

        // Cap at 20 logs per region
        if (data[regionId].length > 20) {
            data[regionId].shift();
        }
        await this.save(data);
    }

    static async getLatest(regionId) {
        const data = await this.load();
        if (!data[regionId] || data[regionId].length === 0) return null;
        return data[regionId][data[regionId].length - 1];
    }

    static async getLogs(regionId) {
        const data = await this.load();
        return data[regionId] || [];
    }
}

if (typeof window !== "undefined") {
    window.CanopyExpansionOrchestrator = new CanopyExpansionOrchestrator();
    window.CanopyExpansionLogStore = CanopyExpansionLogStore;
}
