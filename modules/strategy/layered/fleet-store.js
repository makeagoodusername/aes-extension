"use strict"

/**
 * AES Strategy — Fleet layer store (Slice 4).
 *
 * Per-account fleets: aircraft-by-type / -category / -id, or org-ref
 * groupings (cross-server when the org spans servers but the patch
 * still applies only to the active account's tails per the design
 * doc — cross-account spillover lives in the family layer).
 *
 * Storage:
 *   index:   aesStrategy:layered:fleetsIndex:acct:<accountId>
 *   record:  aesStrategy:layered:fleet:acct:<accountId>:<fleetId>
 *
 * Per the user's confirmed ordering, Fleet beats Division — the
 * resolver merges fleets AFTER divisions. Within fleet matches,
 * priority asc (lower wins later, i.e. higher priority) → updatedAt
 * asc deterministic ordering.
 *
 * Public API mirrors AesStrategyLayeredDivision exactly so callers
 * can swap them. See window.AesStrategyLayeredFleet.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredFleet) return

    const INDEX_PREFIX  = "aesStrategy:layered:fleetsIndex"
    const RECORD_PREFIX = "aesStrategy:layered:fleet"
    const FEATURE_FLAG_KEY = "aesStrategy:layered:fleet:enabled"
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
        return "f" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)
    }

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesDataBus && typeof window.AesDataBus.publish === "function") {
            window.AesDataBus.publish("data:strategy:layered:fleet-changed", payload, "fleet-store")
        } } catch (_) {}
    }

    function _normaliseDef(def) {
        const M = window.AesStrategyLayeredMembership
        const validKind = (M && M.KINDS.indexOf(def && def.kind) >= 0) ? def.kind : "aircraft-types"
        return {
            id:          def && def.id        ? String(def.id) : _id(),
            name:        def && def.name      ? String(def.name) : "Untitled fleet",
            description: def && def.description ? String(def.description) : "",
            color:       def && def.color     ? String(def.color) : "amber",
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
                fleets: (blob.fleets && typeof blob.fleets === "object") ? blob.fleets : {}
            }
        } catch (_) {
            return {schemaVersion: 1, fleets: {}}
        }
    }

    async function _saveIndex(accountId, block) {
        await chrome.storage.local.set({[_indexKey(accountId)]: block})
    }

    async function listForAccount(accountId) {
        const block = await loadIndex(accountId)
        return Object.values(block.fleets).sort((a, b) =>
            (a.priority - b.priority) || ((a.updatedAt || 0) - (b.updatedAt || 0)))
    }

    async function create(accountId, partial) {
        const block = await loadIndex(accountId)
        const def = _normaliseDef(partial || {})
        if (block.fleets[def.id]) def.id = _id()
        block.fleets[def.id] = def
        await _saveIndex(accountId, block)
        _emit("strategy:layered:fleet-changed", {accountId, fleetId: def.id, action: "created"})
        return def
    }

    async function updateDef(accountId, id, fields) {
        if (!id) return null
        const block = await loadIndex(accountId)
        const cur = block.fleets[id]
        if (!cur) return null
        const next = _normaliseDef(Object.assign({}, cur, fields || {}, {id, createdAt: cur.createdAt}))
        block.fleets[id] = next
        await _saveIndex(accountId, block)
        _emit("strategy:layered:fleet-changed", {accountId, fleetId: id, action: "updated"})
        return next
    }

    async function removeDef(accountId, id) {
        if (!id) return false
        const block = await loadIndex(accountId)
        if (!block.fleets[id]) return false
        delete block.fleets[id]
        try { await chrome.storage.local.remove([_recordKey(accountId, id)]) } catch (_) {}
        await _saveIndex(accountId, block)
        _emit("strategy:layered:fleet-changed", {accountId, fleetId: id, action: "deleted"})
        return true
    }

    function _normaliseRecord(blob) {
        const M = window.AesStrategyLayeredMigrations
        if (M && typeof M.migrateOnce === "function") return M.migrateOnce(blob, "fleet")
        const meta = (blob && typeof blob === "object") ? blob : {}
        return {
            schemaVersion:      1,
            layerKind:          "fleet",
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
        if (!id) throw new Error("AesStrategyLayeredFleet.saveRecord: id required")
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
        _emit("strategy:layered:fleet-changed", {accountId, fleetId: id, action: "record-saved"})
        return merged
    }

    /**
     * Resolve fleet matches for the given context. If the context lacks
     * `orgId` and `kind === "org-ref"` is in play, attempt one async
     * lookup via AesCanopyOrgsStore (best-effort; off-page tabs without
     * the orgs store loaded simply skip these matches).
     */
    async function matchingForContext(accountId, ctx) {
        const M = window.AesStrategyLayeredMembership
        if (!M) return []
        ctx = ctx || {}
        const defs = await listForAccount(accountId)
        if (!defs.length) return []

        // Resolve org-ref membership lazily: only if we have an
        // aircraftId+server+airline AND any def is org-ref.
        let resolvedOrgId = ctx.orgId || null
        const needsOrg = defs.some(d => d.kind === "org-ref")
        if (needsOrg && !resolvedOrgId &&
            ctx.aircraftId && ctx.server && ctx.airlineCode &&
            window.AesCanopyOrgsStore &&
            typeof window.AesCanopyOrgsStore.resolveOrgIdForTail === "function") {
            try {
                resolvedOrgId = await window.AesCanopyOrgsStore.resolveOrgIdForTail({
                    accountId:   accountId,
                    server:      ctx.server,
                    airlineCode: ctx.airlineCode,
                    aircraftId:  ctx.aircraftId
                })
            } catch (_) {}
        }
        const ctxAug = resolvedOrgId ? Object.assign({}, ctx, {orgId: resolvedOrgId}) : ctx

        const out = []
        for (const def of defs) {
            const member = {kind: def.kind, members: def.members}
            if (!M.matches(member, ctxAug)) continue
            const record = await loadRecord(accountId, def.id)
            if (!record || !record.patch) continue
            out.push({def: def, record: record})
        }
        return out
    }

    window.AesStrategyLayeredFleet = {
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
            const def = _normaliseDef({name: "Widebodies",
                                        kind: "aircraft-cats",
                                        members: {categories: ["wide", "heavy"]},
                                        priority: 90})
            console.assert(def.kind === "aircraft-cats" && def.priority === 90,
                "[fleet/smoke] aircraft-cats def shape")
            console.assert(_normaliseDef({}).kind === "aircraft-types",
                "[fleet/smoke] default kind = aircraft-types")
            console.assert(def.color === "amber",
                "[fleet/smoke] default fleet color amber")
        }
    } catch (_) {}
})()
