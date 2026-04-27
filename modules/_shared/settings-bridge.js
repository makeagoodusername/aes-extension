"use strict"

/**
 * Track 8 slice 8d — single read/write bridge for the shared `settings`
 * blob in chrome.storage.local.
 *
 * Each AES module owns one top-level area inside that blob:
 *
 *   chrome.storage.local["settings"] = {
 *     aircraftFlightPlan: { … },     // owned by AesAfpSettings
 *     routeAssistant:     { … },     // owned by RouteAssistantSettings
 *     scheduleManagement: { … },     // owned by SchedulePresets et al
 *     flightInfo:         { … },     // owned by content_flightInfo.js
 *     usedAircraftScanner:{ … },
 *     centralHub:         { … },
 *     …
 *   }
 *
 * Every existing module has its own `load()` / `save()` reimplementing the
 * same storage I/O (read whole `settings`, splice in/out one area, write
 * back). This bridge replaces that boilerplate with two small primitives:
 *
 *   AesSettings.getArea(area)             → raw block (no defaults merge)
 *   AesSettings.saveArea(area, block)     → splice block back, preserve siblings
 *
 * Module-specific defaults + validation (e.g. `_mergeAircraftFlightPlan`)
 * stay in their owning modules — the bridge is intentionally untyped at
 * the area level. `deepMerge` is exposed as a primitive for those merge
 * helpers; it's NOT a substitute for them (numeric ranges, enum guards,
 * etc. still need typed validation per module).
 *
 * Module-prefix isolation (HANDOVER §10): the bridge only ever touches
 * `chrome.storage.local["settings"]`. It never reads or writes any other
 * storage key.
 */
class AesSettings {
    static SETTINGS_KEY = "settings"

    /**
     * Read one area block. Returns the raw stored object, or {} if the
     * area has never been written. Does NOT merge with module defaults —
     * that's the module's `_mergeXxx` helper's job.
     */
    static async getArea(area) {
        if (!area) return {}
        const data = await chrome.storage.local.get([AesSettings.SETTINGS_KEY])
        const settings = data[AesSettings.SETTINGS_KEY] || {}
        const block = settings[area]
        return (block && typeof block === "object" && !Array.isArray(block)) ? block : {}
    }

    /**
     * Write one area block back, preserving every sibling area. Pass the
     * full block you want stored — this is replace, not merge. Module
     * `save()` helpers should compute the merged value first, then call
     * this as the storage I/O step.
     */
    static async saveArea(area, block) {
        if (!area) return null
        const data = await chrome.storage.local.get([AesSettings.SETTINGS_KEY])
        const settings = data[AesSettings.SETTINGS_KEY] || {}
        settings[area] = block
        await chrome.storage.local.set({[AesSettings.SETTINGS_KEY]: settings})
        return block
    }

    /**
     * Generic deep-merge primitive. Plain objects recurse; arrays and
     * scalars from `patch` replace the corresponding value in `base`.
     * `undefined` in patch keeps base; `null` in patch sets target null.
     *
     * Module-specific `_mergeXxx` helpers can use this as a base before
     * applying their typed validation (numeric ranges, enum guards).
     */
    static deepMerge(base, patch) {
        if (patch === undefined) return base
        if (base === undefined || base === null) return patch
        const isObj = (v) => v && typeof v === "object" && !Array.isArray(v)
        if (!isObj(base) || !isObj(patch)) return patch
        const out = Object.assign({}, base)
        for (const k of Object.keys(patch)) {
            const pv = patch[k]
            const bv = base[k]
            if (pv === undefined) continue
            if (isObj(bv) && isObj(pv)) out[k] = AesSettings.deepMerge(bv, pv)
            else out[k] = pv
        }
        return out
    }

    /** Diagnostics — returns the whole `settings` blob. Avoid in hot paths. */
    static async loadAll() {
        const data = await chrome.storage.local.get([AesSettings.SETTINGS_KEY])
        return data[AesSettings.SETTINGS_KEY] || {}
    }
}

if (typeof window !== "undefined") {
    window.AesSettings = AesSettings
}
