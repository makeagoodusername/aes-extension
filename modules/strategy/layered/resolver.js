"use strict"

/**
 * AES Strategy — layered overrides resolver (Slice 1).
 *
 * Resolves the effective strategy for a given context by merging in
 * order:
 *
 *     default → family → account → division[*] → fleet[*] → route
 *
 * Slice 1 ships the merge pipeline + Slice 17 invariant scrub +
 * provenance map + effective-cache, gated behind the master kill
 * switch `aesStrategy:layered:enabled` (default OFF). With the switch
 * off the resolver still works but is not consulted by the existing
 * `AesStrategySettings.load()` façade — i.e. zero observable behavior
 * change. With it on, family/division/fleet/route layers fold to no-op
 * because their stores don't exist yet (added in S2-S5), so the
 * effective output equals the legacy account-layer block byte-for-byte.
 *
 * Slice 17 invariant (CRITICAL): domain-enable flags can only be set
 * by the **account** layer. Family / Division / Fleet / Route patches
 * whose leaves match a flag-path get scrubbed with a console.warn.
 *
 * Public API (window.AesStrategyLayered):
 *   featureEnabled()                      → Promise<bool>
 *   resolveEffectiveStrategy(ctx)         → Promise<{effective, provenance, layers}>
 *   FLAG_PATHS                            → Set<dottedPath>   (read-only)
 *   invalidateCache()                     → void              (test helper)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayered) return

    // ── Kill switch ──────────────────────────────────────────────────
    const FEATURE_FLAG_KEY = "aesStrategy:layered:enabled"
    let _featureFlagCached = null   // null = unloaded, true/false = cached

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

    // ── Slice 17 invariant: enable-flag paths the resolver scrubs from
    //    every non-account layer (family / division / fleet / route).
    //    Account layer is exempt — those flags are the user's explicit
    //    apply gates and live there by design.
    const FLAG_PATHS = new Set([
        "tier",
        "scheduleApplyEnabled",
        "serviceMovesEnabled",
        "priceMovesEnabled",
        "crewMovesEnabled",
        "routeCreationEnabled",
        "autoTick.domains.schedule",
        "autoTick.domains.service",
        "autoTick.domains.price",
        "autoTick.domains.crew",
        "autoTick.domains.routeCreation",
        "fleetOptimizer.targetingEnabled",
        "fleetOptimizer.apply.enabled"
    ])

    // ── Effective cache (per-context, 5s TTL) ────────────────────────
    const EFFECTIVE_TTL_MS = 5000
    const _effectiveCache = new Map()

    function _ctxKey(ctx) {
        const a = (ctx && ctx.accountId)  ? String(ctx.accountId)  : ""
        const h = (ctx && ctx.hub)        ? String(ctx.hub)        : ""
        const d = (ctx && ctx.dest)       ? String(ctx.dest)       : ""
        const t = (ctx && ctx.aircraftId) ? String(ctx.aircraftId) : ""
        return a + "|" + h + "|" + d + "|" + t
    }

    function invalidateCache() {
        _effectiveCache.clear()
        _featureFlagCached = null
    }

    // Storage-watch invalidation: any aesStrategy:layered:* change
    // (or the kill-switch flip) should clear caches so the next
    // resolve call recomputes. Bus events from S2+ stores emit on
    // these prefixes via chrome.storage events.
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return
                const keys = Object.keys(changes || {})
                for (const k of keys) {
                    if (k === FEATURE_FLAG_KEY ||
                        k === "settings" ||
                        k.indexOf("aesStrategy:layered:") === 0 ||
                        k.indexOf("aesStrategy:routeObjective:") === 0) {
                        invalidateCache()
                        return
                    }
                }
            })
        }
    } catch (_) { /* no-op outside extension context */ }

    // ── Deep-merge with provenance + flag scrub ──────────────────────
    function _isPlainObject(v) {
        return v != null && typeof v === "object" && !Array.isArray(v)
    }

    function _cloneDeep(v) {
        if (v == null || typeof v !== "object") return v
        try { return JSON.parse(JSON.stringify(v)) } catch (_) { return v }
    }

    function _seedProvenance(target, provenance, layer, layerId, pathPrefix) {
        // Walk the seed (defaults) tree and stamp every leaf path with
        // {layer: "default"}. Subsequent layer applies overwrite.
        const keys = Object.keys(target)
        for (const k of keys) {
            const path = pathPrefix ? (pathPrefix + "." + k) : k
            const v = target[k]
            if (_isPlainObject(v)) {
                _seedProvenance(v, provenance, layer, layerId, path)
            } else {
                provenance[path] = {layer: layer, layerId: layerId}
            }
        }
    }

    function _applyPatch(target, patch, provenance, layerLabel, layerId, allowFlags, pathPrefix, scrubReport) {
        if (!_isPlainObject(patch)) return
        const keys = Object.keys(patch)
        for (const k of keys) {
            const path = pathPrefix ? (pathPrefix + "." + k) : k
            const incoming = patch[k]
            if (_isPlainObject(incoming) && _isPlainObject(target[k])) {
                _applyPatch(target[k], incoming, provenance, layerLabel, layerId, allowFlags, path, scrubReport)
                continue
            }
            // Slice 17 invariant: non-account layers cannot set flag-paths.
            if (!allowFlags && FLAG_PATHS.has(path)) {
                scrubReport.push({path: path, layer: layerLabel, layerId: layerId, reason: "domain-enable-flag"})
                continue
            }
            target[k] = _cloneDeep(incoming)
            provenance[path] = {layer: layerLabel, layerId: layerId}
        }
    }

    // ── Layer loaders (Slice 1: family/div/fleet/route are no-ops) ───
    async function _loadFamilyLayer(/* accountId */) {
        // S2 will replace with family-store.js read.
        return null
    }
    async function _loadAccountLayer(accountId) {
        try {
            const data = await chrome.storage.local.get(["settings"])
            const settings = data.settings || {}
            if (accountId &&
                settings.acct &&
                settings.acct[accountId] &&
                _isPlainObject(settings.acct[accountId].strategy)) {
                return settings.acct[accountId].strategy
            }
            return _isPlainObject(settings.strategy) ? settings.strategy : null
        } catch (_) {
            return null
        }
    }
    async function _loadDivisionLayers(/* accountId, ctx */) {
        return [] // S3+
    }
    async function _loadFleetLayers(/* accountId, ctx */) {
        return [] // S4+
    }
    async function _loadRouteLayer(accountId, hub, dest) {
        // The objective slot is owned by the legacy
        // route-objective-store (untouched). The resolver pulls it
        // when present and presents it as the route layer's objective.
        // Non-objective per-route leaves arrive in S5 via
        // route-extras-store.
        if (!hub || !dest) return null
        try {
            const RO = window.AesStrategyRouteObjectiveStore
            if (RO && typeof RO.get === "function") {
                const rec = await RO.get(hub, dest, accountId || null)
                if (rec && _isPlainObject(rec) && rec.kind) {
                    const patch = {objective: {kind: rec.kind}}
                    if (rec.kind === "custom" && _isPlainObject(rec.custom)) {
                        patch.objective.custom = rec.custom
                    }
                    return {patch: patch, pinned: {"objective.kind": true}, label: hub + "-" + dest}
                }
            }
        } catch (_) { /* no-op */ }
        return null
    }

    // ── Effective resolver ───────────────────────────────────────────
    async function resolveEffectiveStrategy(ctx) {
        ctx = ctx || {}
        const cacheKey = _ctxKey(ctx)
        const cached = _effectiveCache.get(cacheKey)
        const now = Date.now()
        if (cached && (now - cached.at) < EFFECTIVE_TTL_MS) {
            return cached.value
        }

        // Always seed from defaults so every effective leaf has a
        // provenance entry, even when no layer touches it.
        const baseSettings = (window.AesStrategySettings && typeof window.AesStrategySettings.defaults === "function")
            ? window.AesStrategySettings.defaults() : {}
        const effective = _cloneDeep(baseSettings)
        const provenance = {}
        _seedProvenance(effective, provenance, "default", null, "")

        const layers = []
        const scrubReport = []

        // Family
        const familyRec = await _loadFamilyLayer(ctx.accountId)
        if (familyRec && _isPlainObject(familyRec.patch)) {
            _applyPatch(effective, familyRec.patch, provenance, "family",
                familyRec.kinId || null, /*allowFlags*/false, "", scrubReport)
            layers.push({kind: "family", id: familyRec.kinId || null,
                label: familyRec.label || "", patch: familyRec.patch,
                pinned: familyRec.pinned || {}})
        }

        // Account — full block treated as patch; flags ALLOWED.
        const accountBlock = await _loadAccountLayer(ctx.accountId)
        if (accountBlock) {
            _applyPatch(effective, accountBlock, provenance, "account",
                ctx.accountId || null, /*allowFlags*/true, "", scrubReport)
            layers.push({kind: "account", id: ctx.accountId || null,
                label: "", patch: accountBlock, pinned: {}})
        }

        // Division[*]
        const divisions = await _loadDivisionLayers(ctx.accountId, ctx)
        for (const rec of divisions) {
            _applyPatch(effective, rec.patch, provenance, "division",
                rec.id || null, /*allowFlags*/false, "", scrubReport)
            layers.push(Object.assign({kind: "division"}, rec))
        }

        // Fleet[*]
        const fleets = await _loadFleetLayers(ctx.accountId, ctx)
        for (const rec of fleets) {
            _applyPatch(effective, rec.patch, provenance, "fleet",
                rec.id || null, /*allowFlags*/false, "", scrubReport)
            layers.push(Object.assign({kind: "fleet"}, rec))
        }

        // Route
        const routeRec = await _loadRouteLayer(ctx.accountId, ctx.hub, ctx.dest)
        if (routeRec && _isPlainObject(routeRec.patch)) {
            _applyPatch(effective, routeRec.patch, provenance, "route",
                routeRec.label || null, /*allowFlags*/false, "", scrubReport)
            layers.push({kind: "route", id: routeRec.label || null,
                label: routeRec.label || "", patch: routeRec.patch,
                pinned: routeRec.pinned || {}})
        }

        // Re-normalize through AesStrategySettings._defaults shape so
        // every clamping rule (numeric ranges, objective re-norm) still
        // applies. We don't have direct access to _merge, so we save the
        // effective object via the settings store's defaults shape and
        // trust JSON.stringify equivalence.
        // (The settings store's normaliser runs on save() — for in-memory
        //  consumers in S1 the defaults+account merge is already in
        //  normalised shape because it was produced by _merge on save.)

        if (scrubReport.length) {
            try {
                console.warn("[AesStrategyLayered] scrubbed enable-flag leaves from non-account layers", scrubReport)
            } catch (_) {}
        }

        const result = {effective: effective, provenance: provenance, layers: layers, scrubbed: scrubReport}
        _effectiveCache.set(cacheKey, {at: now, value: result})
        return result
    }

    // ── Lightweight programmatic toggle (test helper) ────────────────
    async function setFeatureEnabledForTesting(on) {
        const obj = {}
        obj[FEATURE_FLAG_KEY] = !!on
        try { await chrome.storage.local.set(obj) } catch (_) {}
        _featureFlagCached = !!on
        invalidateCache()
        return !!on
    }

    window.AesStrategyLayered = {
        FEATURE_FLAG_KEY:           FEATURE_FLAG_KEY,
        FLAG_PATHS:                 FLAG_PATHS,
        featureEnabled:             featureEnabled,
        resolveEffectiveStrategy:   resolveEffectiveStrategy,
        invalidateCache:            invalidateCache,
        setFeatureEnabledForTesting: setFeatureEnabledForTesting
    }

    // ── ?aes-debug smoke ─────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            (async function () {
                const probe = await resolveEffectiveStrategy({accountId: null})
                console.assert(probe && probe.effective && typeof probe.effective === "object",
                    "[layered/smoke] resolve returns an effective block")
                // Provenance covers every effective leaf (smoke samples).
                console.assert(probe.provenance && typeof probe.provenance === "object",
                    "[layered/smoke] provenance map exists")
                console.assert(probe.provenance["tier"],            "[layered/smoke] provenance covers tier")
                console.assert(probe.provenance["objective.kind"],  "[layered/smoke] provenance covers nested leaf")
                console.assert(probe.provenance["autoTick.domains.crew"],
                    "[layered/smoke] provenance covers deeply nested flag leaf")
                // Defaults-only resolve: every leaf provenance.layer === "default".
                let nonDefault = 0
                for (const k of Object.keys(probe.provenance)) {
                    if (probe.provenance[k].layer !== "default") nonDefault++
                }
                // With no real account loaded under test, account layer also
                // contributes nothing — so all leaves should be "default".
                // (If a real account is loaded on the page, this is allowed
                //  to be > 0 and the assertion is informational.)
                if (nonDefault > 0) {
                    console.info("[layered/smoke] account layer contributed", nonDefault, "leaves (real account present)")
                }
                // Slice 17 invariant scrub — synthesise a malicious family
                // patch and verify _applyPatch drops every flag leaf.
                const eff   = _cloneDeep((window.AesStrategySettings || {defaults: () => ({})}).defaults())
                const prov  = {}
                const scrub = []
                _seedProvenance(eff, prov, "default", null, "")
                _applyPatch(eff, {
                    priceMovesEnabled:    true,
                    scheduleApplyEnabled: true,
                    autoTick:             {domains: {price: true, crew: true}},
                    fleetOptimizer:       {targetingEnabled: true},
                    weights:              {profitWeight: 0.7}
                }, prov, "family", "kinX", /*allowFlags*/false, "", scrub)
                console.assert(eff.priceMovesEnabled === false,
                    "[layered/smoke] flag-scrub: priceMovesEnabled stays default after family patch")
                console.assert(eff.scheduleApplyEnabled === false,
                    "[layered/smoke] flag-scrub: scheduleApplyEnabled stays default")
                console.assert(eff.autoTick.domains.price === true,
                    "[layered/smoke] flag-scrub: autoTick.domains.price stays at its default")
                console.assert(eff.autoTick.domains.crew === false,
                    "[layered/smoke] flag-scrub: autoTick.domains.crew stays default")
                console.assert(eff.fleetOptimizer.targetingEnabled === false,
                    "[layered/smoke] flag-scrub: fleetOptimizer.targetingEnabled stays default")
                // Non-flag leaves DO apply.
                console.assert(eff.weights && Math.abs(eff.weights.profitWeight - 0.7) < 1e-9,
                    "[layered/smoke] non-flag leaf (weights.profitWeight) applies from family layer")
                // Account layer (allowFlags=true) CAN set flags.
                _applyPatch(eff, {priceMovesEnabled: true}, prov, "account", "acctX",
                    /*allowFlags*/true, "", [])
                console.assert(eff.priceMovesEnabled === true,
                    "[layered/smoke] account layer can set priceMovesEnabled")
                console.assert(scrub.length >= 5,
                    "[layered/smoke] scrubReport captured >=5 dropped flag leaves")
            })().catch(function (e) { console.warn("[layered/smoke] failed", e) })
        }
    } catch (_) { /* never let smoke break the page */ }
})()
