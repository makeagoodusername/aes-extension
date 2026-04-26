/**
 * Per-route override store for the Route Assistant.
 *
 * AS in-game demand 0–10 is too coarse for a specific route the user has
 * actually flown and measured. This store lets the user pin a per-route
 * load-factor / yield value that the profit estimator reads before falling
 * back to the demand-driven LF curve and configured base yield.
 *
 * Keyed directionally as <HUB>-<DEST>: outbound-different-from-inbound is
 * uncommon in AS but cheap to support, and matches the schedule extractor's
 * directional record shape.
 *
 *   routeAssistant:override:<HUB>-<DEST>  →
 *     {hub, dest, paxLF?, cargoLF?, yieldPerKm?, cargoYieldPerKgKm?, note?, createdAt, updatedAt}
 *
 * Any field on the override is optional — a partial override only changes
 * the keys that are set and leaves the rest to fall through to the
 * demand-driven defaults. Removing a route's override clears the key
 * entirely.
 */
class RouteAssistantRouteOverridesStore {
    static PREFIX = "routeAssistant:override:"

    static _key(hub, dest) {
        return RouteAssistantRouteOverridesStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    /**
     * Returns the override record for a single (hub, dest) pair, or null.
     */
    static async get(hub, dest) {
        const key = RouteAssistantRouteOverridesStore._key(hub, dest)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs. Returns
     * Map<pairKey, override> where pairKey is "<HUB>-<DEST>".
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const keys = pairs.map(([h, d]) => RouteAssistantRouteOverridesStore._key(h, d))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            const pair = k.substring(RouteAssistantRouteOverridesStore.PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Persist an override. Pass null/undefined for any field to clear it.
     * Returns the stored record. Pass an empty fields object to clear the
     * override entirely (delegates to remove()).
     */
    static async save(hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantRouteOverridesStore._clean(fields || {})
        if (!RouteAssistantRouteOverridesStore._hasAnyValue(cleaned)) {
            await RouteAssistantRouteOverridesStore.remove(hubU, destU)
            return null
        }

        const key = RouteAssistantRouteOverridesStore._key(hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
        const now = Date.now()
        // The editor shows every field, so save() takes the full new state:
        // fields not in `cleaned` were intentionally cleared and must NOT
        // carry over from `existing`. Only createdAt is preserved.
        const record = Object.assign(
            {hub: hubU, dest: destU, createdAt: (existing && existing.createdAt) || now},
            cleaned,
            {hub: hubU, dest: destU, updatedAt: now}
        )
        await chrome.storage.local.set({[key]: record})
        return record
    }

    static async remove(hub, dest) {
        const key = RouteAssistantRouteOverridesStore._key(hub, dest)
        await chrome.storage.local.remove([key])
    }

    /**
     * Strip non-numeric / out-of-range fields. `note` keeps its string form;
     * everything else is coerced through Number and dropped if not finite or
     * out of plausible bounds.
     */
    static _clean(fields) {
        const out = {}
        const numField = (k, lo, hi) => {
            const v = fields[k]
            if (v === null || v === undefined || v === "") return
            const n = Number(v)
            if (!isFinite(n)) return
            if (n < lo || n > hi) return
            out[k] = n
        }
        numField("paxLF",             0, 1)
        numField("cargoLF",           0, 1)
        numField("yieldPerKm",        0, 100)
        numField("cargoYieldPerKgKm", 0, 100)
        if (typeof fields.note === "string" && fields.note.trim() !== "") {
            out.note = fields.note.trim().substring(0, 200)
        }
        return out
    }

    static _hasAnyValue(cleaned) {
        return cleaned.paxLF !== undefined
            || cleaned.cargoLF !== undefined
            || cleaned.yieldPerKm !== undefined
            || cleaned.cargoYieldPerKgKm !== undefined
            || cleaned.note !== undefined
    }
}
