"use strict"

/**
 * User-defined organisations (groupings of accounts/aircraft) that span
 * the canopy. Orgs are intentionally orthogonal to L4 affiliations — a
 * user with 4 sister airlines may want to group them as 1 org (one
 * canopy), 4 orgs (each solo), or any cut they invent (e.g. "Asia Ops"
 * cutting across 3 of their airlines on different servers).
 *
 * Storage: `aesCanopy:orgs` — single canopy-scope blob, NOT per-account.
 *
 *   {
 *     schemaVersion: 1,
 *     orgs: { [orgId]: {id, name, description, colorToken,
 *                       members: [{accountId, server, airlineCode,
 *                                  aircraftIds: string[]|null}, ...],
 *                       defaultPresetId: string|null,
 *                       createdAt, updatedAt} },
 *     defaultDisplayOrgId: string|null,
 *     unassignedColorToken: "slate"
 *   }
 *
 * Single-writer rule: writes go through `save()` which read-modify-writes
 * atomically. Cross-tab consumers subscribe to `chrome.storage.onChanged`
 * for the key; the store also emits `canopy:orgs-changed` on the bus.
 */
;(function () {
    if (window.AesCanopyOrgsStore) return

    const KEY = "aesCanopy:orgs"

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesAfp && window.AesAfp.bus) window.AesAfp.bus.emit(event, payload) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) window.AesStrategy.bus.emit(event, payload) } catch (_) {}
    }

    function _defaults() {
        return {schemaVersion: 1, orgs: {}, defaultDisplayOrgId: null, unassignedColorToken: "slate"}
    }

    async function load() {
        const out = await chrome.storage.local.get([KEY])
        const raw = out[KEY] || _defaults()
        if (!raw.orgs || typeof raw.orgs !== "object") raw.orgs = {}
        return Object.assign(_defaults(), raw)
    }

    async function _save(block) {
        await chrome.storage.local.set({[KEY]: block})
    }

    function _id() {
        return "o" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
    }

    async function create(partial) {
        const block = await load()
        const now = Date.now()
        const org = Object.assign({
            id:              _id(),
            name:            "New organisation",
            description:     "",
            colorToken:      "blue",
            members:         [],
            defaultPresetId: null,
            createdAt:       now,
            updatedAt:       now
        }, partial || {})
        // Caller might pass id; honour but ensure uniqueness.
        if (block.orgs[org.id]) org.id = _id()
        block.orgs[org.id] = org
        if (!block.defaultDisplayOrgId) block.defaultDisplayOrgId = org.id
        await _save(block)
        _emit("canopy:orgs-changed", {orgId: org.id, action: "created"})
        return org
    }

    async function update(orgId, fields) {
        if (!orgId) return null
        const block = await load()
        const org = block.orgs[orgId]
        if (!org) return null
        Object.assign(org, fields || {}, {updatedAt: Date.now()})
        await _save(block)
        _emit("canopy:orgs-changed", {orgId, action: "updated"})
        return org
    }

    async function remove(orgId) {
        if (!orgId) return false
        const block = await load()
        if (!block.orgs[orgId]) return false
        delete block.orgs[orgId]
        if (block.defaultDisplayOrgId === orgId) {
            const ids = Object.keys(block.orgs)
            block.defaultDisplayOrgId = ids[0] || null
        }
        await _save(block)
        _emit("canopy:orgs-changed", {orgId, action: "deleted"})
        return true
    }

    /**
     * Resolve which org a tail belongs to. Walks members in updatedAt asc
     * order; first match wins. Match conditions:
     *   - `accountId` AND `server` AND `airlineCode` all match, AND
     *   - `aircraftIds === null` (all tails of this account) OR
     *     `aircraftIds.includes(aircraftId)`.
     * Returns orgId or null.
     */
    async function resolveOrgIdForTail(tail) {
        if (!tail || !tail.accountId) return null
        const block = await load()
        const list = Object.values(block.orgs).sort((a, b) =>
            (a.updatedAt || 0) - (b.updatedAt || 0))
        for (const org of list) {
            for (const m of (org.members || [])) {
                if (m.accountId !== tail.accountId) continue
                if (m.server && tail.server && m.server !== tail.server) continue
                if (m.airlineCode && tail.airlineCode && m.airlineCode !== tail.airlineCode) continue
                if (m.aircraftIds == null) return org.id
                if (Array.isArray(m.aircraftIds) && m.aircraftIds.indexOf(String(tail.aircraftId)) >= 0) return org.id
            }
        }
        return null
    }

    async function listOrgs() {
        const block = await load()
        return Object.values(block.orgs).sort((a, b) =>
            (a.createdAt || 0) - (b.createdAt || 0))
    }

    async function setDefaultDisplay(orgId) {
        const block = await load()
        block.defaultDisplayOrgId = orgId || null
        await _save(block)
    }

    window.AesCanopyOrgsStore = {
        load, create, update, remove,
        listOrgs, resolveOrgIdForTail,
        setDefaultDisplay,
        KEY
    }
})()
