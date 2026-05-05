"use strict"

/**
 * AES Strategy — Family layer store (Slice 2).
 *
 * One blob per kin family at `aesStrategy:layered:family:<kinId>`,
 * cross-account by design: any sister account in the kin can read the
 * record; only sisters whose own affiliation is `kind: "self"` AND
 * whose `kinId` matches can write it (HANDOVER §10 "kinId is the
 * grouping primitive"). Non-self / non-kin accounts are silently
 * blocked from writes (resolver still safely reads).
 *
 * Storage shape (matches AesStrategyLayeredMigrations v1):
 *   {
 *     schemaVersion: 1,
 *     layerKind: "family",
 *     patch:    {<partial AesStrategySettings>},
 *     pinned:   {<dottedPath>: true},
 *     label:    "",
 *     updatedAt: <ms>,
 *     updatedByAccountId: "<accountId>"
 *   }
 *
 * Public API (window.AesStrategyLayeredFamily):
 *   FEATURE_FLAG_KEY                                 → string
 *   featureEnabled()                                 → Promise<bool>
 *   keyFor(kinId)                                    → string
 *   load(kinId)                                      → Promise<record|null>
 *   resolveActiveKinId({accountId?})                 → Promise<{kinId, enterpriseId}|null>
 *   resolveActiveKinForWrite({accountId?})           → Promise<...|null>
 *   listKinSisters(kinId)                            → Promise<[{enterpriseId, accountId}]>
 *   save({kinId, patch, pinned, label, accountId?})  → Promise<record>
 *   clearLeaf(kinId, dottedPath)                     → Promise<record>
 *   clearAll(kinId)                                  → Promise<void>
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredFamily) return

    const KEY_PREFIX = "aesStrategy:layered:family:"
    const FEATURE_FLAG_KEY = "aesStrategy:layered:family:enabled"
    let _featureFlagCached = null

    function keyFor(kinId) {
        if (!kinId) throw new Error("AesStrategyLayeredFamily: kinId required")
        return KEY_PREFIX + String(kinId)
    }

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

    // Storage-watch invalidator — same prefix the resolver listens to,
    // but we cache the family kill-switch independently.
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return
                if (changes && changes[FEATURE_FLAG_KEY]) _featureFlagCached = null
            })
        }
    } catch (_) { /* no-op outside extension */ }

    function _activeAccountId() {
        if (typeof currentAccountIdSync === "function") {
            try { return currentAccountIdSync() || null } catch (_) {}
        }
        return (typeof window !== "undefined" && window.__aesAccountId) ? window.__aesAccountId : null
    }

    async function _resolveActiveSelfRecord(accountId) {
        // Find the affiliation record for the active account that's
        // kind:"self" and has a kinId. Returns null if affiliations
        // module isn't loaded or no matching record exists.
        const A = window.AesCanopyAffiliations
        if (!A || typeof A.getAll !== "function") return null
        const want = accountId || _activeAccountId()
        if (!want) return null
        try {
            const all = await A.getAll()
            for (const id in all) {
                const rec = all[id]
                if (!rec || rec.kind !== "self") continue
                if (!rec.kinId) continue
                if (String(rec.accountId || "") === String(want)) {
                    return {enterpriseId: id, kinId: rec.kinId, accountId: rec.accountId}
                }
            }
        } catch (_) { /* fall through */ }
        return null
    }

    async function resolveActiveKinId(opts) {
        const r = await _resolveActiveSelfRecord(opts && opts.accountId)
        if (!r) return null
        return {kinId: r.kinId, enterpriseId: r.enterpriseId, accountId: r.accountId}
    }

    async function resolveActiveKinForWrite(opts) {
        // Same as resolveActiveKinId — the kind:"self" predicate IS the
        // write gate for slice 2 ("any sister account in the kin can write").
        return resolveActiveKinId(opts)
    }

    async function listKinSisters(kinId) {
        const out = []
        const A = window.AesCanopyAffiliations
        if (!A || typeof A.getAll !== "function" || !kinId) return out
        try {
            const all = await A.getAll()
            for (const id in all) {
                const rec = all[id]
                if (!rec || rec.kind !== "self") continue
                if (String(rec.kinId || "") !== String(kinId)) continue
                out.push({enterpriseId: id, accountId: rec.accountId || null})
            }
        } catch (_) {}
        return out
    }

    function _normaliseRecord(blob) {
        const M = window.AesStrategyLayeredMigrations
        if (M && typeof M.migrateOnce === "function") {
            return M.migrateOnce(blob, "family")
        }
        // Fallback if migrations module isn't loaded for some reason.
        const meta = (blob && typeof blob === "object") ? blob : {}
        return {
            schemaVersion:      1,
            layerKind:          "family",
            patch:              (meta.patch && typeof meta.patch === "object") ? meta.patch : {},
            pinned:             (meta.pinned && typeof meta.pinned === "object") ? meta.pinned : {},
            label:              typeof meta.label === "string" ? meta.label : "",
            updatedAt:          typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
            updatedByAccountId: typeof meta.updatedByAccountId === "string" ? meta.updatedByAccountId : ""
        }
    }

    async function load(kinId) {
        if (!kinId) return null
        try {
            const k = keyFor(kinId)
            const data = await chrome.storage.local.get([k])
            const blob = data[k]
            return blob ? _normaliseRecord(blob) : null
        } catch (_) { return null }
    }

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) window.AesStrategy.bus.emit(event, payload) } catch (_) {}
        try { if (window.AesDataBus && typeof window.AesDataBus.publish === "function") {
            window.AesDataBus.publish("data:strategy:layered:family-changed", payload, "family-store")
        } } catch (_) {}
    }

    async function save(args) {
        args = args || {}
        const kinId = args.kinId
        if (!kinId) throw new Error("AesStrategyLayeredFamily.save: kinId required")
        // Write-gate: caller must be a kin sister of `kinId` (kind:"self").
        const active = await resolveActiveKinForWrite({accountId: args.accountId})
        if (!active) {
            throw new Error("AesStrategyLayeredFamily.save: active account is not a kin sister")
        }
        if (String(active.kinId) !== String(kinId)) {
            throw new Error("AesStrategyLayeredFamily.save: active account belongs to a different kinId")
        }

        const existing = (await load(kinId)) || {}
        const merged = _normaliseRecord({
            patch:              args.patch  != null ? args.patch  : existing.patch,
            pinned:             args.pinned != null ? args.pinned : existing.pinned,
            label:              args.label  != null ? args.label  : existing.label,
            updatedAt:          Date.now(),
            updatedByAccountId: active.accountId || _activeAccountId() || ""
        })
        await chrome.storage.local.set({[keyFor(kinId)]: merged})
        // Invalidate the resolver's effective cache.
        try {
            if (window.AesStrategyLayered && typeof window.AesStrategyLayered.invalidateCache === "function") {
                window.AesStrategyLayered.invalidateCache()
            }
        } catch (_) {}
        _emit("strategy:layered:family-changed", {kinId: kinId, updatedAt: merged.updatedAt})
        return merged
    }

    async function clearLeaf(kinId, dottedPath) {
        if (!kinId || !dottedPath) throw new Error("AesStrategyLayeredFamily.clearLeaf: kinId + path required")
        const rec = (await load(kinId)) || _normaliseRecord(null)
        const parts = String(dottedPath).split(".")
        const last = parts.pop()
        let cursor = rec.patch
        for (const p of parts) {
            if (!cursor || typeof cursor !== "object" || !(p in cursor)) {
                cursor = null
                break
            }
            cursor = cursor[p]
        }
        if (cursor && typeof cursor === "object" && (last in cursor)) {
            delete cursor[last]
        }
        if (rec.pinned && (dottedPath in rec.pinned)) {
            delete rec.pinned[dottedPath]
        }
        return save({kinId: kinId, patch: rec.patch, pinned: rec.pinned, label: rec.label})
    }

    async function clearAll(kinId) {
        if (!kinId) return
        try { await chrome.storage.local.remove([keyFor(kinId)]) } catch (_) {}
        try {
            if (window.AesStrategyLayered && typeof window.AesStrategyLayered.invalidateCache === "function") {
                window.AesStrategyLayered.invalidateCache()
            }
        } catch (_) {}
        _emit("strategy:layered:family-changed", {kinId: kinId, cleared: true, updatedAt: Date.now()})
    }

    window.AesStrategyLayeredFamily = {
        FEATURE_FLAG_KEY:        FEATURE_FLAG_KEY,
        KEY_PREFIX:              KEY_PREFIX,
        featureEnabled:          featureEnabled,
        keyFor:                  keyFor,
        load:                    load,
        resolveActiveKinId:      resolveActiveKinId,
        resolveActiveKinForWrite: resolveActiveKinForWrite,
        listKinSisters:          listKinSisters,
        save:                    save,
        clearLeaf:               clearLeaf,
        clearAll:                clearAll
    }

    // ── ?aes-debug smoke ─────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            (async function () {
                // Smoke is non-destructive: never writes to a real kin record.
                console.assert(typeof keyFor("kinX") === "string" && keyFor("kinX").indexOf(KEY_PREFIX) === 0,
                    "[family/smoke] keyFor returns the expected key")
                const norm = _normaliseRecord({patch: {weights: {profitWeight: 0.7}},
                                                pinned: {"weights.profitWeight": true}, label: "ACME Group"})
                console.assert(norm.schemaVersion === 1,                                  "[family/smoke] schemaVersion = 1")
                console.assert(norm.layerKind === "family",                               "[family/smoke] layerKind = family")
                console.assert(norm.patch.weights.profitWeight === 0.7,                   "[family/smoke] patch leaf preserved")
                console.assert(norm.pinned["weights.profitWeight"] === true,              "[family/smoke] pin preserved")
                console.assert(norm.label === "ACME Group",                               "[family/smoke] label preserved")
                // Save without an active kin sister must throw.
                let threw = false
                try { await save({kinId: "__smoke__never__written__"}) } catch (_) { threw = true }
                console.assert(threw,
                    "[family/smoke] save throws when active account is not a kin sister of the target kinId")
            })().catch(function (e) { console.warn("[family/smoke] failed", e) })
        }
    } catch (_) { /* never let smoke break the page */ }
})()
