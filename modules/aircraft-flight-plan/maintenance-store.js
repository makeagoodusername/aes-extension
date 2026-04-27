"use strict"

/**
 * Per-aircraft maintenance scrape store (Track 2 slice 2a).
 *
 * Persists the most recent {ratio, condition} reading from the aircraft-page
 * sidebar so the wear-model + budget API can read it without re-scraping the
 * DOM, and so cross-tab consumers (Fleet Hub) can react via storage events.
 *
 *   aircraftFlightPlan:maintenance:<server>:<aircraftId> →
 *     {server, aircraftId,
 *      ratio:           number | null,    // % e.g. 124.8
 *      condition:       number | null,    // %
 *      ratioStatus:     "good" | "warn" | "bad" | null,
 *      conditionStatus: same,
 *      scrapedAt:       ms epoch | null,  // when the scraper read the DOM
 *      createdAt, updatedAt}
 *
 * Mirrors the shape of `AesAfpStateStore` (state-store.js); same `save()`
 * semantics — partial patch, fields omitted fall through to the existing
 * record. A repeat save with identical {ratio, condition, ratioStatus,
 * conditionStatus} returns the existing record without writing, so a
 * Wicket re-render that re-fires `ctx:ready` doesn't spam storage.
 */
class AesAfpMaintenanceStore {
    static PREFIX = "aircraftFlightPlan:maintenance:"

    static _key(server, aircraftId) {
        return AesAfpMaintenanceStore.PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    static _empty(server, aircraftId) {
        return {
            server:          String(server || ""),
            aircraftId:      String(aircraftId || ""),
            ratio:           null,
            condition:       null,
            ratioStatus:     null,
            conditionStatus: null,
            scrapedAt:       null,
            createdAt:       null,
            updatedAt:       null
        }
    }

    static async load(server, aircraftId) {
        if (!server || !aircraftId) return AesAfpMaintenanceStore._empty(server, aircraftId)
        const key = AesAfpMaintenanceStore._key(server, aircraftId)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") {
            return AesAfpMaintenanceStore._empty(server, aircraftId)
        }
        const empty = AesAfpMaintenanceStore._empty(server, aircraftId)
        const asFinite = v => (typeof v === "number" && isFinite(v)) ? v : null
        const asStatus = v => (v === "good" || v === "warn" || v === "bad") ? v : null
        return {
            server:          rec.server     || empty.server,
            aircraftId:      rec.aircraftId || empty.aircraftId,
            ratio:           asFinite(rec.ratio),
            condition:       asFinite(rec.condition),
            ratioStatus:     asStatus(rec.ratioStatus),
            conditionStatus: asStatus(rec.conditionStatus),
            scrapedAt:       asFinite(rec.scrapedAt),
            createdAt:       asFinite(rec.createdAt),
            updatedAt:       asFinite(rec.updatedAt)
        }
    }

    /**
     * Patch save. Returns the merged record, or `null` when the patch is a
     * pure no-op (the four scrape fields all match the existing record).
     * The no-op path lets callers skip a chrome.storage write — important
     * because storage.onChanged fires for every set() and would otherwise
     * thrash the Fleet Hub on every Wicket re-render.
     */
    static async save(server, aircraftId, patch) {
        if (!server || !aircraftId) return null
        const existing = await AesAfpMaintenanceStore.load(server, aircraftId)
        const p = patch || {}

        const asFinite = v => isFinite(Number(v)) ? Number(v) : null
        const asStatus = v => (v === "good" || v === "warn" || v === "bad") ? v : null
        const pick = (key, current, validator) =>
            Object.prototype.hasOwnProperty.call(p, key) ? validator(p[key]) : current

        const next = {
            server:          String(server),
            aircraftId:      String(aircraftId),
            ratio:           pick("ratio",           existing.ratio,           asFinite),
            condition:       pick("condition",       existing.condition,       asFinite),
            ratioStatus:     pick("ratioStatus",     existing.ratioStatus,     asStatus),
            conditionStatus: pick("conditionStatus", existing.conditionStatus, asStatus),
            scrapedAt:       pick("scrapedAt",       existing.scrapedAt,       asFinite),
            createdAt:       existing.createdAt || Date.now(),
            updatedAt:       Date.now()
        }

        if (existing.ratio           === next.ratio
         && existing.condition       === next.condition
         && existing.ratioStatus     === next.ratioStatus
         && existing.conditionStatus === next.conditionStatus
         && existing.createdAt       != null) {
            return existing
        }

        const key = AesAfpMaintenanceStore._key(server, aircraftId)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    /**
     * Subscribe to maintenance-store updates across tabs. Mirrors
     * `AesAfpScheduleStore.watch`. Callback receives
     * `{server, aircraftId, maintenance, oldMaintenance}`; returns an
     * unwatch fn.
     */
    static watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                if (key.indexOf(AesAfpMaintenanceStore.PREFIX) !== 0) continue
                const tail = key.slice(AesAfpMaintenanceStore.PREFIX.length)
                const sep = tail.indexOf(":")
                if (sep < 0) continue
                const server     = tail.slice(0, sep)
                const aircraftId = tail.slice(sep + 1)
                try {
                    cb({
                        server,
                        aircraftId,
                        maintenance:    changes[key].newValue || null,
                        oldMaintenance: changes[key].oldValue || null
                    })
                } catch (e) { console.warn("[AES AFP] maintenance-store watch handler threw", e) }
            }
        }
        try { chrome.storage.onChanged.addListener(handler) }
        catch (_) { return () => {} }
        return () => {
            try { chrome.storage.onChanged.removeListener(handler) }
            catch (_) { /* noop */ }
        }
    }
}

if (typeof window !== "undefined") {
    window.AesAfpMaintenanceStore = AesAfpMaintenanceStore
}
