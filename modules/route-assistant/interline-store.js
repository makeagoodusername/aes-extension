/**
 * H slice 3b — per-route interlining / codeshare metadata.
 *
 * Companion to the F slice 3 contractual-partners-scraper (which captures
 * which carriers you have a *bilateral agreement with*, globally) and the
 * H slice 2 wave-overlay carrier classifier (which buckets connections as
 * own / interline / alliance based on those globals).
 *
 * This store layers OPERATIONAL detail on top of the contractual layer:
 * for a given route, which partner carriers actually share capacity, on
 * which product class, and at what share percent. The data is manual
 * entry today — AS doesn't expose per-route codeshare splits anywhere
 * scrapable. Future scrapers can populate this on the user's behalf.
 *
 * Storage layout:
 *   key:    `routeAssistant:interline:<HUB>-<DEST>` (directional)
 *   value:  {pair, partners: [...], updatedAt}
 *   each partner: {partnerEnterpriseId, partnerName, productClass,
 *                   sharePercent, relationType, notes, addedAt}
 *
 * Pair key is **directional** — `<HUB>-<DEST>` matches the orientation
 * of `route-overrides`, `route-note`, `ticket-price`, etc. The reverse
 * direction `<DEST>-<HUB>` is treated as an independent record because
 * codeshare splits aren't necessarily symmetric (you might block-buy
 * 30 Y seats outbound but only 10 Y seats inbound).
 *
 * Empty partners arrays drop the storage key entirely (no tombstones)
 * so the chrome.storage namespace stays compact.
 */
class RouteAssistantInterlineStore {

    static KEY_PREFIX = "routeAssistant:interline:"

    static VALID_PRODUCT_CLASSES = ["PAX", "Y", "C", "F", "CARGO"]
    static VALID_RELATION_TYPES  = ["INTERLINING", "ALLIANCE", "CODESHARE", "BLOCK_SPACE", "WET_LEASE"]

    static _key(hubIata, destIata) {
        return RouteAssistantInterlineStore.KEY_PREFIX
            + String(hubIata || "").toUpperCase()
            + "-"
            + String(destIata || "").toUpperCase()
    }

    static _normalisePartner(raw) {
        if (!raw || typeof raw !== "object") return null
        const partnerEnterpriseId = String(raw.partnerEnterpriseId || "").trim()
        if (!partnerEnterpriseId) return null
        const productClass = RouteAssistantInterlineStore.VALID_PRODUCT_CLASSES
            .indexOf(raw.productClass) !== -1 ? raw.productClass : "PAX"
        const relationType = RouteAssistantInterlineStore.VALID_RELATION_TYPES
            .indexOf(raw.relationType) !== -1 ? raw.relationType : "INTERLINING"
        const sharePct = Number(raw.sharePercent)
        return {
            partnerEnterpriseId: partnerEnterpriseId,
            partnerName:         String(raw.partnerName || "").slice(0, 80),
            productClass:        productClass,
            sharePercent:        isFinite(sharePct) ? Math.max(0, Math.min(100, sharePct)) : 0,
            relationType:        relationType,
            notes:               String(raw.notes || "").slice(0, 280),
            addedAt:             Number(raw.addedAt) || Date.now()
        }
    }

    /**
     * Load the per-route partners record. Returns a freshly-constructed
     * empty record (not null) when no key exists, so callers can render
     * a uniform "0 partners" UI without null-checking.
     */
    static async load(hubIata, destIata) {
        if (!hubIata || !destIata) return RouteAssistantInterlineStore._emptyRecord(hubIata, destIata)
        const key = RouteAssistantInterlineStore._key(hubIata, destIata)
        try {
            const blob = await chrome.storage.local.get([key])
            const rec = blob[key]
            if (!rec || !Array.isArray(rec.partners)) {
                return RouteAssistantInterlineStore._emptyRecord(hubIata, destIata)
            }
            return rec
        } catch (e) {
            console.warn("[AES interline] load failed:", e)
            return RouteAssistantInterlineStore._emptyRecord(hubIata, destIata)
        }
    }

    static _emptyRecord(hubIata, destIata) {
        return {
            pair:      String(hubIata || "").toUpperCase() + "-" + String(destIata || "").toUpperCase(),
            partners:  [],
            updatedAt: null
        }
    }

    /**
     * Replace the partners list for (hub, dest). Empty list deletes the
     * storage key. Returns the saved record (or null when cleared).
     */
    static async save(hubIata, destIata, partners) {
        if (!hubIata || !destIata) return null
        const key = RouteAssistantInterlineStore._key(hubIata, destIata)
        const cleaned = []
        const seen = new Set()
        for (const p of (partners || [])) {
            const norm = RouteAssistantInterlineStore._normalisePartner(p)
            if (!norm) continue
            // Dedupe on (partnerEnterpriseId, productClass) — one entry per
            // partner per class. Re-adding the same pair overwrites.
            const dedupeKey = norm.partnerEnterpriseId + ":" + norm.productClass
            if (seen.has(dedupeKey)) continue
            seen.add(dedupeKey)
            cleaned.push(norm)
        }
        if (cleaned.length === 0) {
            try { await chrome.storage.local.remove([key]) }
            catch (e) { console.warn("[AES interline] remove failed:", e) }
            return null
        }
        const rec = {
            pair: String(hubIata).toUpperCase() + "-" + String(destIata).toUpperCase(),
            partners:  cleaned,
            updatedAt: Date.now()
        }
        try {
            await chrome.storage.local.set({[key]: rec})
        } catch (e) {
            console.warn("[AES interline] save failed:", e)
            return null
        }
        return rec
    }

    /**
     * Upsert a single partner entry. (partnerEnterpriseId, productClass)
     * is the dedup key — re-adding overwrites in place rather than
     * stacking duplicates.
     */
    static async addPartner(hubIata, destIata, partner) {
        const rec = await RouteAssistantInterlineStore.load(hubIata, destIata)
        const norm = RouteAssistantInterlineStore._normalisePartner(partner)
        if (!norm) return rec
        const dedupeKey = norm.partnerEnterpriseId + ":" + norm.productClass
        const filtered = (rec.partners || []).filter(p =>
            (p.partnerEnterpriseId + ":" + p.productClass) !== dedupeKey)
        filtered.push(norm)
        return await RouteAssistantInterlineStore.save(hubIata, destIata, filtered)
    }

    /**
     * Remove every entry matching `partnerEnterpriseId`. When `productClass`
     * is supplied, only that class is removed; omitting clears all classes
     * for that partner on the route.
     */
    static async removePartner(hubIata, destIata, partnerEnterpriseId, productClass) {
        const rec = await RouteAssistantInterlineStore.load(hubIata, destIata)
        const pid = String(partnerEnterpriseId || "")
        if (!pid) return rec
        const filtered = (rec.partners || []).filter(p => {
            if (p.partnerEnterpriseId !== pid) return true
            if (productClass != null && p.productClass !== productClass) return true
            return false
        })
        return await RouteAssistantInterlineStore.save(hubIata, destIata, filtered)
    }

    /** Drop the entire record for a route. */
    static async clear(hubIata, destIata) {
        if (!hubIata || !destIata) return
        const key = RouteAssistantInterlineStore._key(hubIata, destIata)
        try { await chrome.storage.local.remove([key]) }
        catch (e) { console.warn("[AES interline] clear failed:", e) }
    }

    /**
     * Batched read for the panel's bulk-render path. `pairs` is an array
     * of `[hub, dest]` tuples; returns a `{pair: record}` map keyed by
     * `<HUB>-<DEST>`. Missing routes are omitted from the result so
     * callers can `if (map[pair])` cheaply.
     */
    static async bulkLoad(pairs) {
        if (!Array.isArray(pairs) || !pairs.length) return {}
        const keys = pairs.map(([h, d]) => RouteAssistantInterlineStore._key(h, d))
        try {
            const blob = await chrome.storage.local.get(keys)
            const out = {}
            for (let i = 0; i < pairs.length; i++) {
                const rec = blob[keys[i]]
                if (rec && Array.isArray(rec.partners) && rec.partners.length) {
                    out[rec.pair] = rec
                }
            }
            return out
        } catch (e) {
            console.warn("[AES interline] bulkLoad failed:", e)
            return {}
        }
    }

    /**
     * Walk every key in chrome.storage.local with the interline prefix
     * and return the records. Used for the settings expander summary +
     * debug tooling. Cheap on small enterprises (≤200 routes) but
     * unscoped — callers that only care about a single hub should bulk
     * load with the explicit pair list instead.
     */
    static async loadAll() {
        try {
            const all = await chrome.storage.local.get(null)
            const out = []
            for (const key in all) {
                if (key.indexOf(RouteAssistantInterlineStore.KEY_PREFIX) !== 0) continue
                const rec = all[key]
                if (rec && Array.isArray(rec.partners) && rec.partners.length) out.push(rec)
            }
            return out
        } catch (e) {
            console.warn("[AES interline] loadAll failed:", e)
            return []
        }
    }

    /**
     * Sum the share percent across every partner on a route, optionally
     * filtered by productClass. The wave-overlay tooltip uses this to
     * surface "Y class: 35% interlined to 2 partners" without forcing
     * the consumer to walk the array. Capped at 100 — over-allocations
     * indicate user data-entry error rather than a real impossibility,
     * but the cap keeps consumer math sane.
     */
    static totalShare(record, productClass) {
        if (!record || !Array.isArray(record.partners)) return 0
        let total = 0
        for (const p of record.partners) {
            if (productClass != null && p.productClass !== productClass) continue
            total += Number(p.sharePercent) || 0
        }
        return Math.min(100, Math.max(0, total))
    }
}
