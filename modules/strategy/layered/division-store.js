"use strict"

/**
 * AES Strategy — Division layer store (Slice 3).
 *
 * Per-account divisions: regions, hub clusters, manual route sets.
 * Each division carries a strategy patch + pinned mask, identical
 * shape to the family layer record but scoped to one account. The
 * resolver iterates user-defined divisions; each that matches the
 * resolution context contributes its patch (deep-merge wins later).
 *
 * Storage keys (per-account, via acctKeyForAccount):
 *   index:   aesStrategy:layered:divisionsIndex:acct:<accountId>
 *   record:  aesStrategy:layered:division:acct:<accountId>:<divisionId>
 *
 * Index shape:
 *   {
 *     schemaVersion: 1,
 *     divisions: {
 *       [divisionId]: {
 *         id, name, description, color,
 *         kind, members,                     // per division-membership.js
 *         priority,                          // lower wins later (higher priority)
 *         createdAt, updatedAt
 *       }, ...
 *     }
 *   }
 *
 * Record shape (matches AesStrategyLayeredMigrations v1).
 *
 * Public API (window.AesStrategyLayeredDivision):
 *   FEATURE_FLAG_KEY                          → string
 *   featureEnabled()                          → Promise<bool>
 *   loadIndex(accountId)                      → Promise<index>
 *   listForAccount(accountId)                 → Promise<[divDef]>
 *   create(accountId, partial)                → Promise<divDef>
 *   updateDef(accountId, id, fields)          → Promise<divDef|null>
 *   removeDef(accountId, id)                  → Promise<bool>
 *   loadRecord(accountId, id)                 → Promise<record|null>
 *   saveRecord(accountId, id, {patch,pinned,label}) → Promise<record>
 *   matchingForContext(accountId, ctx)        → Promise<[{def, record}]>
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredDivision) return

    const INDEX_PREFIX  = "aesStrategy:layered:divisionsIndex"
    const RECORD_PREFIX = "aesStrategy:layered:division"
    const FEATURE_FLAG_KEY = "aesStrategy:layered:division:enabled"
    let _featureFlagCached = null

    function _acctKey(prefix, accountId, suffix) {
        if (typeof acctKeyForAccount === "function") return acctKeyForAccount(prefix, accountId, suffix)
        const tail = (suffix == null || suffix === "") ? "" : (":" + suffix)
        return accountId ? (prefix + ":acct:" + accountId + tail) : (prefix + tail)
    }

    function _indexKey(accountId)        { return _acctKey(INDEX_PREFIX,  accountId, null) }
    function _recordKey(accountId, id)   { return _acctKey(RECORD_PREFIX, accountId, id)   }

    async function featureEnabled() {
        if (_featureFlagCached !== null) return _featureFlagCached
        try {
            const data = await chrome.storage.local.get([FEATURE_FLAG_KEY])
            _featureFlagCached = !!data[FEATURE_FLAG_KEY]
        } catch (_) {
            _featureFlagCached = false
        }
        return _featureFlagCached
    }
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return
                if (changes && changes[FEATURE_FLAG_KEY]) _featureFlagCached = null
            })
        }
    } catch (_) {}

    function _id() {
        return "d" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
    }

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesDataBus && typeof window.AesDataBus.publish === "function") {
            window.AesDataBus.publish("data:strategy:layered:division-changed", payload, "division-store")
        } } catch (_) {}
    }

    function _normaliseDef(def) {
        const M = window.AesStrategyLayeredMembership
        const validKind = (M && M.KINDS.indexOf(def && def.kind) >= 0) ? def.kind : "manual"
        return {
            id:          def && def.id        ? String(def.id) : _id(),
            name:        def && def.name      ? String(def.name) : "Untitled division",
            description: def && def.description ? String(def.description) : "",
            color:       def && def.color     ? String(def.color) : "blue",
            kind:        validKind,
            members:     (def && def.members && typeof def.members === "object") ? def.members : {},
            priority:    Number.isFinite(Number(def && def.priority)) ? Number(def.priority) : 100,
            createdAt:   Number.isFinite(Number(def && def.createdAt)) ? Number(def.createdAt) : Date.now(),
            updatedAt:   Date.now()
        }
    }

    async function loadIndex(accountId) {
        try {
            const k = _indexKey(accountId)
            const data = await chrome.storage.local.get([k])
            const blob = data[k] || {}
            return {
                schemaVersion: 1,
                divisions: (blob.divisions && typeof blob.divisions === "object") ? blob.divisions : {}
            }
        } catch (_) {
            return {schemaVersion: 1, divisions: {}}
        }
    }

    async function _saveIndex(accountId, block) {
        await chrome.storage.local.set({[_indexKey(accountId)]: block})
    }

    async function listForAccount(accountId) {
        const block = await loadIndex(accountId)
        return Object.values(block.divisions).sort((a, b) =>
            (a.priority - b.priority) || ((a.updatedAt || 0) - (b.updatedAt || 0)))
    }

    async function create(accountId, partial) {
        const block = await loadIndex(accountId)
        const def = _normaliseDef(partial || {})
        if (block.divisions[def.id]) def.id = _id()
        block.divisions[def.id] = def
        await _saveIndex(accountId, block)
        _emit("strategy:layered:division-changed", {accountId, divisionId: def.id, action: "created"})
        return def
    }

    async function updateDef(accountId, id, fields) {
        if (!id) return null
        const block = await loadIndex(accountId)
        const cur = block.divisions[id]
        if (!cur) return null
        const next = _normaliseDef(Object.assign({}, cur, fields || {}, {id, createdAt: cur.createdAt}))
        block.divisions[id] = next
        await _saveIndex(accountId, block)
        _emit("strategy:layered:division-changed", {accountId, divisionId: id, action: "updated"})
        return next
    }

    async function removeDef(accountId, id) {
        if (!id) return false
        const block = await loadIndex(accountId)
        if (!block.divisions[id]) return false
        delete block.divisions[id]
        try { await chrome.storage.local.remove([_recordKey(accountId, id)]) } catch (_) {}
        await _saveIndex(accountId, block)
        _emit("strategy:layered:division-changed", {accountId, divisionId: id, action: "deleted"})
        return true
    }

    function _normaliseRecord(blob) {
        const M = window.AesStrategyLayeredMigrations
        if (M && typeof M.migrateOnce === "function") return M.migrateOnce(blob, "division")
        const meta = (blob && typeof blob === "object") ? blob : {}
        return {
            schemaVersion:      1,
            layerKind:          "division",
            patch:              (meta.patch && typeof meta.patch === "object") ? meta.patch : {},
            pinned:             (meta.pinned && typeof meta.pinned === "object") ? meta.pinned : {},
            label:              typeof meta.label === "string" ? meta.label : "",
            updatedAt:          typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
            updatedByAccountId: typeof meta.updatedByAccountId === "string" ? meta.updatedByAccountId : ""
        }
    }

    async function loadRecord(accountId, id) {
        if (!id) return null
        try {
            const k = _recordKey(accountId, id)
            const data = await chrome.storage.local.get([k])
            return data[k] ? _normaliseRecord(data[k]) : null
        } catch (_) { return null }
    }

    async function saveRecord(accountId, id, args) {
        if (!id) throw new Error("AesStrategyLayeredDivision.saveRecord: id required")
        const existing = (await loadRecord(accountId, id)) || {}
        const merged = _normaliseRecord({
            patch:              (args && args.patch  != null) ? args.patch  : existing.patch,
            pinned:             (args && args.pinned != null) ? args.pinned : existing.pinned,
            label:              (args && args.label  != null) ? args.label  : existing.label,
            updatedAt:          Date.now(),
            updatedByAccountId: accountId || ""
        })
        await chrome.storage.local.set({[_recordKey(accountId, id)]: merged})
        try {
            if (window.AesStrategyLayered && typeof window.AesStrategyLayered.invalidateCache === "function") {
                window.AesStrategyLayered.invalidateCache()
            }
        } catch (_) {}
        _emit("strategy:layered:division-changed", {accountId, divisionId: id, action: "record-saved"})
        return merged
    }

    async function matchingForContext(accountId, ctx) {
        const M = window.AesStrategyLayeredMembership
        if (!M) return []
        const defs = await listForAccount(accountId)
        const out = []
        for (const def of defs) {
            const member = {kind: def.kind, members: def.members}
            if (!M.matches(member, ctx || {})) continue
            const record = await loadRecord(accountId, def.id)
            if (!record || !record.patch) continue
            out.push({def: def, record: record})
        }
        return out
    }

    window.AesStrategyLayeredDivision = {
        FEATURE_FLAG_KEY:    FEATURE_FLAG_KEY,
        INDEX_PREFIX:        INDEX_PREFIX,
        RECORD_PREFIX:       RECORD_PREFIX,
        featureEnabled:      featureEnabled,
        loadIndex:           loadIndex,
        listForAccount:      listForAccount,
        create:              create,
        updateDef:           updateDef,
        removeDef:           removeDef,
        loadRecord:          loadRecord,
        saveRecord:          saveRecord,
        matchingForContext:  matchingForContext
    }

    // ── ?aes-debug smoke ─────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const def = _normaliseDef({name: "Asia",
                                        kind: "manual",
                                        members: {hubs: ["NRT"]},
                                        priority: 50})
            console.assert(def.id && def.kind === "manual" && def.priority === 50,
                "[division/smoke] _normaliseDef shape preserved")
            console.assert(def.color === "blue",
                "[division/smoke] default color blue")
            // Unknown kind falls back to "manual".
            console.assert(_normaliseDef({kind: "bogus"}).kind === "manual",
                "[division/smoke] unknown kind → manual fallback")
        }
    } catch (_) {}
})()
