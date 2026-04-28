/**
 * Slice 4c — saved named scenarios per route for the ORS Sandbox.
 *
 * Persists up to 5 named scenarios per directional pair so the user can
 * snap between "Cut Y 10%", "Premium pricing test", "Freq +20%" without
 * re-keying every slider. Mirrors the route-overrides + route-note
 * stores: directional pair-key, account-scoped via the L2 helper
 * (`acctKey()`), legacy fallback during the canopy rollout.
 *
 *   routeAssistant:sandboxScenarios:<HUB>-<DEST>                    (legacy)
 *   routeAssistant:sandboxScenarios:acct:<id>:<HUB>-<DEST>          (L2+)
 *     {
 *       hub:       "JFK",
 *       dest:      "LAX",
 *       scenarios: [
 *         {id, name, scenario, createdAt, updatedAt},
 *         ...
 *       ],
 *       updatedAt: ms
 *     }
 *
 * `scenario` shape mirrors what `RouteAssistantOrsModel.project()` reads:
 *   {priceMultipliers: {Y, C, F}, cargoMultiplier, frequency, comfortDelta}
 *
 * The cap (5) is enforced on save — older entries fall off when a sixth
 * is added. Manual `remove()` lets the user keep specific entries while
 * making room for new ones.
 */
class RouteAssistantSandboxScenariosStore {
    static LEGACY_PREFIX = "routeAssistant:sandboxScenarios:"
    static SCOPE_PREFIX  = "routeAssistant:sandboxScenarios"
    static MAX_PER_ROUTE = 5
    static MAX_NAME_LEN  = 60

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantSandboxScenariosStore.SCOPE_PREFIX,
            RouteAssistantSandboxScenariosStore._pairKey(hub, dest))
    }

    static _keyForAccount(accountId, hub, dest) {
        const pair = RouteAssistantSandboxScenariosStore._pairKey(hub, dest)
        if (!accountId) return RouteAssistantSandboxScenariosStore.LEGACY_PREFIX + pair
        return RouteAssistantSandboxScenariosStore.SCOPE_PREFIX + ":acct:" + accountId + ":" + pair
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantSandboxScenariosStore.LEGACY_PREFIX
            + RouteAssistantSandboxScenariosStore._pairKey(hub, dest)
    }

    /**
     * Read the full record. Returns the namespaced record if present;
     * otherwise falls back to the legacy unscoped key (canopy rollout
     * compatibility — see route-overrides-store.js for the rationale).
     */
    static async getRecord(hub, dest) {
        const ns = RouteAssistantSandboxScenariosStore._key(hub, dest)
        const lg = RouteAssistantSandboxScenariosStore._legacyKey(hub, dest)
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            return out[ns] || null
        }
        const out = await chrome.storage.local.get([ns, lg])
        if (out[ns] !== undefined) return out[ns]
        return out[lg] || null
    }

    /**
     * List saved scenarios for a route, most-recently-updated first.
     * Returns [] when no record exists.
     */
    static async list(hub, dest) {
        const rec = await RouteAssistantSandboxScenariosStore.getRecord(hub, dest)
        if (!rec || !Array.isArray(rec.scenarios)) return []
        return rec.scenarios.slice()
    }

    /**
     * Add a new scenario or update an existing one (by id). Caps at
     * MAX_PER_ROUTE — when adding a sixth, the oldest entry by
     * `updatedAt` is evicted. Returns the saved entry, or null when
     * the input was rejected.
     */
    static async save(hub, dest, fields) {
        return RouteAssistantSandboxScenariosStore.saveAt(
            currentAccountIdSync(), hub, dest, fields
        )
    }

    static async saveAt(accountId, hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantSandboxScenariosStore._cleanEntry(fields || {})
        if (!cleaned) return null

        const key = RouteAssistantSandboxScenariosStore._keyForAccount(accountId, hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
        const now = Date.now()
        const list = (existing && Array.isArray(existing.scenarios))
            ? existing.scenarios.slice() : []
        const idx = cleaned.id
            ? list.findIndex(s => s && s.id === cleaned.id)
            : -1
        if (idx >= 0) {
            list[idx] = Object.assign({}, list[idx], cleaned, {updatedAt: now})
        } else {
            const id = cleaned.id || RouteAssistantSandboxScenariosStore._mkId()
            list.push(Object.assign({id, createdAt: now}, cleaned, {updatedAt: now}))
        }
        // Sort newest-first so the dropdown surfaces recent edits at the top.
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        // Cap by evicting the oldest tail entries when over the limit.
        if (list.length > RouteAssistantSandboxScenariosStore.MAX_PER_ROUTE) {
            list.length = RouteAssistantSandboxScenariosStore.MAX_PER_ROUTE
        }
        const record = {
            hub:       hubU,
            dest:      destU,
            scenarios: list,
            updatedAt: now
        }
        await chrome.storage.local.set({[key]: record})
        return list.find(s => s.name === cleaned.name && s.updatedAt === now) || list[0]
    }

    /**
     * Remove a single scenario by id. Drops the whole record when the
     * last entry is gone so a deleted route doesn't leave a tombstone.
     * Returns the remaining list (possibly empty).
     */
    static async remove(hub, dest, id) {
        return RouteAssistantSandboxScenariosStore.removeAt(
            currentAccountIdSync(), hub, dest, id
        )
    }

    static async removeAt(accountId, hub, dest, id) {
        if (!id) return await RouteAssistantSandboxScenariosStore.list(hub, dest)
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        const key = RouteAssistantSandboxScenariosStore._keyForAccount(accountId, hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
        const list = (existing && Array.isArray(existing.scenarios))
            ? existing.scenarios.filter(s => s && s.id !== id) : []
        if (!list.length) {
            await chrome.storage.local.remove([key])
            return []
        }
        const record = {
            hub:       hubU,
            dest:      destU,
            scenarios: list,
            updatedAt: Date.now()
        }
        await chrome.storage.local.set({[key]: record})
        return list
    }

    static async clear(hub, dest) {
        return RouteAssistantSandboxScenariosStore.clearAt(
            currentAccountIdSync(), hub, dest
        )
    }

    static async clearAt(accountId, hub, dest) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        const ns = RouteAssistantSandboxScenariosStore._keyForAccount(accountId, hubU, destU)
        const lg = RouteAssistantSandboxScenariosStore._legacyKey(hubU, destU)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
    }

    /**
     * Validate + bound an incoming entry. Rejects (returns null) when
     * `name` or `scenario.priceMultipliers.Y` is missing — those are
     * the two fields the dropdown UI relies on. Optional fields fall
     * back to neutral values so a partial scenario still applies.
     */
    static _cleanEntry(fields) {
        const id = (typeof fields.id === "string" && fields.id) ? fields.id : null
        const name = (typeof fields.name === "string") ? fields.name.trim() : ""
        if (!name) return null
        const sc = fields.scenario || {}
        const pm = sc.priceMultipliers || {}
        const y = Number(pm.Y), c = Number(pm.C), f = Number(pm.F)
        if (!isFinite(y) || y <= 0) return null
        const cleaned = {
            priceMultipliers: {
                Y: RouteAssistantSandboxScenariosStore._clampMultiplier(y),
                C: RouteAssistantSandboxScenariosStore._clampMultiplier(isFinite(c) && c > 0 ? c : y),
                F: RouteAssistantSandboxScenariosStore._clampMultiplier(isFinite(f) && f > 0 ? f : y)
            },
            cargoMultiplier: RouteAssistantSandboxScenariosStore._clampMultiplier(
                isFinite(sc.cargoMultiplier) && sc.cargoMultiplier > 0 ? sc.cargoMultiplier : 1
            ),
            frequency: (sc.frequency == null) ? null
                : (isFinite(sc.frequency) && sc.frequency >= 0 ? Math.round(sc.frequency) : null),
            comfortDelta: isFinite(sc.comfortDelta) ? Math.max(-3, Math.min(3, Math.round(sc.comfortDelta))) : 0
        }
        return {
            id,
            name:     name.substring(0, RouteAssistantSandboxScenariosStore.MAX_NAME_LEN),
            scenario: cleaned
        }
    }

    static _clampMultiplier(v) {
        const n = Number(v)
        if (!isFinite(n) || n <= 0) return 1
        return Math.max(0.30, Math.min(3.00, Math.round(n * 1000) / 1000))
    }

    static _mkId() {
        return "sc-" + Date.now().toString(36) + "-"
            + Math.floor(Math.random() * 1e6).toString(36)
    }

    /** L2 deprecated — preserve for any reader still doing key arithmetic. */
    static get PREFIX() { return RouteAssistantSandboxScenariosStore.LEGACY_PREFIX }
}
