"use strict"

/**
 * Letter L slice L5 — Strategy DNA store (hybrid scope).
 *
 * Holds two layers:
 *   - `aesCanopy:dna`                       — global template (one blob, canopy-wide)
 *   - `aesCanopy:dnaOverride:acct:<id>`     — sparse per-account override (one blob per account)
 *
 * Consumers MUST go through `effectiveDna(accountId)` — `deepMerge(template, override)`
 * at leaf level. Reading template alone or override alone breaks invariant L5-A.
 *
 * DNA dimensions (10):
 *
 *   serviceMix         { Y, C, F }                      — cabin-class revenue blend, leaves sum ≈ 1
 *   networkShape       enum: hub-spoke|point-to-point|balanced
 *   cargoEmphasis      number 0..1                      — share of revenue from cargo target
 *   manufacturerPrefs  { Boeing, Airbus, Embraer, Other } — sum ≤ 1
 *   sizeMixTargets     { regional, narrowbody, widebody } — sum ≈ 1
 *   riskProfile        enum: conservative|balanced|aggressive   — reuses AesStrategyRiskProfiles
 *   countryFocus       { domesticShare, continentalShare, intercontShare } — sum ≈ 1
 *   tempo              enum: patient|steady|expansionist
 *   brandStance        enum: discount-volume|premium-utility|luxury-flagship
 *   growthPosture      { newRoutesPerWeekTarget, fleetGrowthRatePerYear }
 *
 * Object-dimensions have only scalar leaves — `deepMerge` is one level deep
 * from each top-level dim, results unambiguous.
 *
 * Single-writer rule: writes go through `_save*()` which read-modify-writes
 * atomically. Cross-tab consumers subscribe to `chrome.storage.onChanged`;
 * the store also emits `canopy:dna-changed` and `canopy:dna-override-changed`
 * on the bus.
 *
 * Schema-drift defense (NORTH-STAR §4.8): `_normTemplate` and `_normOverride`
 * deep-fill missing leaves from `DEFAULT_TEMPLATE`. Future dimensions added
 * by L5.x land as defaults; existing storage degrades gracefully.
 *
 * Override key uses the explicit accountId — NOT `acctKey()` — because the
 * resolver always knows which account to read for, and we want the read
 * deterministic, not context-dependent.
 */
;(function () {
    if (window.AesCanopyDnaStore) return

    const KEY_TEMPLATE = "aesCanopy:dna"
    const KEY_OVERRIDE_PREFIX = "aesCanopy:dnaOverride:acct:"

    const NETWORK_SHAPES = ["hub-spoke", "point-to-point", "balanced"]
    const RISK_PROFILES  = ["conservative", "balanced", "aggressive"]
    const TEMPO_VALUES   = ["patient", "steady", "expansionist"]
    const BRAND_STANCES  = ["discount-volume", "premium-utility", "luxury-flagship"]

    const DEFAULT_TEMPLATE = {
        schemaVersion:     1,
        authoredAt:        0,
        serviceMix:        { Y: 0.65, C: 0.25, F: 0.10 },
        networkShape:      "balanced",
        cargoEmphasis:     0.15,
        manufacturerPrefs: { Boeing: 0.5, Airbus: 0.5, Embraer: 0, Other: 0 },
        sizeMixTargets:    { regional: 0.20, narrowbody: 0.55, widebody: 0.25 },
        riskProfile:       "balanced",
        countryFocus:      { domesticShare: 0.40, continentalShare: 0.40, intercontShare: 0.20 },
        tempo:             "steady",
        brandStance:       "premium-utility",
        growthPosture:     { newRoutesPerWeekTarget: 1, fleetGrowthRatePerYear: 0.10 }
    }

    // Dimension metadata — ordered for UI rendering, also drives the wizard.
    // `kind` controls how the editor renders (object = per-leaf inputs, enum = radio,
    // number = single slider). `leaves` lists the editable leaf keys for object dims.
    const DIMENSIONS = [
        {key: "serviceMix",        label: "Service mix",         kind: "object", leaves: ["Y", "C", "F"],                                  range: {min: 0, max: 1, step: 0.05},  sumTo: 1},
        {key: "networkShape",      label: "Network shape",       kind: "enum",   options: NETWORK_SHAPES},
        {key: "cargoEmphasis",     label: "Cargo emphasis",      kind: "number", range: {min: 0, max: 0.6, step: 0.05}},
        {key: "manufacturerPrefs", label: "Manufacturer prefs",  kind: "object", leaves: ["Boeing", "Airbus", "Embraer", "Other"],          range: {min: 0, max: 1, step: 0.05},  sumTo: 1},
        {key: "sizeMixTargets",    label: "Size-mix targets",    kind: "object", leaves: ["regional", "narrowbody", "widebody"],            range: {min: 0, max: 1, step: 0.05},  sumTo: 1},
        {key: "riskProfile",       label: "Risk profile",        kind: "enum",   options: RISK_PROFILES},
        {key: "countryFocus",      label: "Country focus",       kind: "object", leaves: ["domesticShare", "continentalShare", "intercontShare"], range: {min: 0, max: 1, step: 0.05}, sumTo: 1},
        {key: "tempo",             label: "Tempo",               kind: "enum",   options: TEMPO_VALUES},
        {key: "brandStance",       label: "Brand stance",        kind: "enum",   options: BRAND_STANCES},
        {key: "growthPosture",     label: "Growth posture",      kind: "object", leaves: ["newRoutesPerWeekTarget", "fleetGrowthRatePerYear"], range: {min: 0, max: 5, step: 0.1}}
    ]

    // Uniform weights — every dim contributes equally to the fit score.
    const WEIGHTS = (function () {
        const w = {}
        const each = 1 / DIMENSIONS.length
        for (const d of DIMENSIONS) w[d.key] = each
        return w
    })()

    function _emit(event, payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit(event, payload) } catch (_) {}
        try { if (window.AesAfp && window.AesAfp.bus) window.AesAfp.bus.emit(event, payload) } catch (_) {}
        try { if (window.AesStrategy && window.AesStrategy.bus) window.AesStrategy.bus.emit(event, payload) } catch (_) {}
    }

    function _isPlainObject(x) {
        return x && typeof x === "object" && !Array.isArray(x)
    }

    function _clampEnum(value, options, fallback) {
        return (typeof value === "string" && options.indexOf(value) >= 0) ? value : fallback
    }

    function _normTemplate(raw) {
        const src = _isPlainObject(raw) ? raw : {}
        const out = {schemaVersion: 1, authoredAt: Number(src.authoredAt) || 0}
        for (const d of DIMENSIONS) {
            const def = DEFAULT_TEMPLATE[d.key]
            const cur = src[d.key]
            if (d.kind === "enum") {
                out[d.key] = _clampEnum(cur, d.options, def)
            } else if (d.kind === "number") {
                const n = Number(cur)
                out[d.key] = isFinite(n) ? n : def
            } else { // object
                const filled = {}
                const curObj = _isPlainObject(cur) ? cur : {}
                for (const leaf of d.leaves) {
                    const n = Number(curObj[leaf])
                    filled[leaf] = isFinite(n) ? n : def[leaf]
                }
                out[d.key] = filled
            }
        }
        return out
    }

    // Override blobs are sparse — only present leaves are kept. Defensive
    // normalization filters out unknown dim keys + unknown leaf keys, but
    // does NOT fill missing fields (that's the resolver's job).
    function _normOverride(raw) {
        const src = _isPlainObject(raw) ? raw : {}
        const out = {}
        for (const d of DIMENSIONS) {
            if (!(d.key in src)) continue
            const cur = src[d.key]
            if (d.kind === "enum") {
                if (typeof cur === "string" && d.options.indexOf(cur) >= 0) out[d.key] = cur
            } else if (d.kind === "number") {
                const n = Number(cur)
                if (isFinite(n)) out[d.key] = n
            } else { // object
                if (!_isPlainObject(cur)) continue
                const sub = {}
                for (const leaf of d.leaves) {
                    if (!(leaf in cur)) continue
                    const n = Number(cur[leaf])
                    if (isFinite(n)) sub[leaf] = n
                }
                if (Object.keys(sub).length) out[d.key] = sub
            }
        }
        return out
    }

    /**
     * Pure resolver — every consumer MUST use this. Object dims merge at
     * leaf level (override leaves replace template leaves; absent leaves
     * inherit). Enum + number dims are whole-dim replace.
     */
    function effectiveDnaSync(template, override) {
        const t = _normTemplate(template)
        const o = _normOverride(override)
        const out = {schemaVersion: t.schemaVersion, authoredAt: t.authoredAt}
        for (const d of DIMENSIONS) {
            if (!(d.key in o)) {
                out[d.key] = (d.kind === "object") ? Object.assign({}, t[d.key]) : t[d.key]
                continue
            }
            if (d.kind === "object") {
                out[d.key] = Object.assign({}, t[d.key], o[d.key])
            } else {
                out[d.key] = o[d.key]
            }
        }
        return out
    }

    async function loadTemplate() {
        const out = await chrome.storage.local.get([KEY_TEMPLATE])
        return _normTemplate(out[KEY_TEMPLATE])
    }

    async function _saveTemplateRaw(block) {
        await chrome.storage.local.set({[KEY_TEMPLATE]: block})
    }

    /**
     * Merge `partial` into the template. Object dims merge at leaf level
     * (so `saveTemplate({serviceMix: {Y: 0.7}})` updates Y but preserves
     * C and F); enum + number dims replace if present.
     */
    async function saveTemplate(partial) {
        const cur = await loadTemplate()
        const next = _mergeIntoTemplate(cur, partial)
        await _saveTemplateRaw(next)
        _emit("canopy:dna-changed", {action: "saveTemplate"})
        return next
    }

    function _mergeIntoTemplate(cur, partial) {
        const src = _isPlainObject(partial) ? partial : {}
        const next = {schemaVersion: cur.schemaVersion, authoredAt: cur.authoredAt}
        for (const d of DIMENSIONS) {
            if (!(d.key in src)) {
                next[d.key] = (d.kind === "object") ? Object.assign({}, cur[d.key]) : cur[d.key]
                continue
            }
            const incoming = src[d.key]
            if (d.kind === "enum") {
                next[d.key] = _clampEnum(incoming, d.options, cur[d.key])
            } else if (d.kind === "number") {
                const n = Number(incoming)
                next[d.key] = isFinite(n) ? n : cur[d.key]
            } else {
                if (!_isPlainObject(incoming)) {
                    next[d.key] = Object.assign({}, cur[d.key])
                    continue
                }
                const merged = Object.assign({}, cur[d.key])
                for (const leaf of d.leaves) {
                    if (!(leaf in incoming)) continue
                    const n = Number(incoming[leaf])
                    if (isFinite(n)) merged[leaf] = n
                }
                next[d.key] = merged
            }
        }
        return next
    }

    async function resetTemplateToDefaults() {
        const next = _normTemplate({})
        await _saveTemplateRaw(next)
        _emit("canopy:dna-changed", {action: "resetTemplateToDefaults"})
        return next
    }

    async function hasTemplate() {
        const out = await chrome.storage.local.get([KEY_TEMPLATE])
        const raw = out[KEY_TEMPLATE]
        return !!(raw && Number(raw.authoredAt) > 0)
    }

    async function markTemplateAuthored() {
        const cur = await loadTemplate()
        cur.authoredAt = Date.now()
        await _saveTemplateRaw(cur)
        _emit("canopy:dna-changed", {action: "markTemplateAuthored"})
        return cur
    }

    function _overrideKey(accountId) {
        return KEY_OVERRIDE_PREFIX + String(accountId)
    }

    async function loadOverride(accountId) {
        if (!accountId) return {}
        const k = _overrideKey(accountId)
        const out = await chrome.storage.local.get([k])
        return _normOverride(out[k])
    }

    async function _saveOverrideRaw(accountId, block) {
        const k = _overrideKey(accountId)
        if (!block || !Object.keys(block).length) {
            await chrome.storage.local.remove([k])
            return
        }
        await chrome.storage.local.set({[k]: block})
    }

    /**
     * Merge `partial` into the override. Object dims merge at leaf level —
     * passing `{serviceMix: {Y: 0.8}}` sets only the Y leaf; C and F stay
     * inherited from the template (no override leaves stored for them).
     * Whole-dim enums replace.
     */
    async function saveOverride(accountId, partial) {
        if (!accountId) return {}
        const cur = await loadOverride(accountId)
        const next = _mergeIntoOverride(cur, partial)
        await _saveOverrideRaw(accountId, next)
        _emit("canopy:dna-override-changed", {accountId, action: "saveOverride"})
        return next
    }

    function _mergeIntoOverride(cur, partial) {
        const src = _isPlainObject(partial) ? partial : {}
        const next = {}
        for (const d of DIMENSIONS) {
            const had = (d.key in cur)
            const incoming = (d.key in src)
            if (!had && !incoming) continue
            if (d.kind === "enum") {
                if (incoming) {
                    const v = _clampEnum(src[d.key], d.options, undefined)
                    if (v !== undefined) next[d.key] = v
                } else {
                    next[d.key] = cur[d.key]
                }
            } else if (d.kind === "number") {
                if (incoming) {
                    const n = Number(src[d.key])
                    if (isFinite(n)) next[d.key] = n
                } else {
                    next[d.key] = cur[d.key]
                }
            } else { // object — leaf-level merge
                const merged = Object.assign({}, cur[d.key] || {})
                if (incoming && _isPlainObject(src[d.key])) {
                    for (const leaf of d.leaves) {
                        if (!(leaf in src[d.key])) continue
                        const raw = src[d.key][leaf]
                        if (raw === null) {
                            delete merged[leaf]
                        } else {
                            const n = Number(raw)
                            if (isFinite(n)) merged[leaf] = n
                        }
                    }
                }
                if (Object.keys(merged).length) next[d.key] = merged
            }
        }
        return next
    }

    async function clearOverrideDimension(accountId, dimName) {
        if (!accountId || !dimName) return null
        const cur = await loadOverride(accountId)
        if (!(dimName in cur)) return cur
        delete cur[dimName]
        await _saveOverrideRaw(accountId, cur)
        _emit("canopy:dna-override-changed", {accountId, action: "clearDim", dimName})
        return cur
    }

    async function clearOverrideLeaf(accountId, path) {
        if (!accountId || !Array.isArray(path) || path.length !== 2) return null
        const [dimName, leaf] = path
        const cur = await loadOverride(accountId)
        if (!cur[dimName] || !_isPlainObject(cur[dimName])) return cur
        if (!(leaf in cur[dimName])) return cur
        delete cur[dimName][leaf]
        if (!Object.keys(cur[dimName]).length) delete cur[dimName]
        await _saveOverrideRaw(accountId, cur)
        _emit("canopy:dna-override-changed", {accountId, action: "clearLeaf", path})
        return cur
    }

    async function clearAllOverrides(accountId) {
        if (!accountId) return
        await _saveOverrideRaw(accountId, {})
        _emit("canopy:dna-override-changed", {accountId, action: "clearAll"})
    }

    async function effectiveDna(accountId) {
        const k = accountId ? _overrideKey(accountId) : null
        const keys = [KEY_TEMPLATE]
        if (k) keys.push(k)
        const out = await chrome.storage.local.get(keys)
        return effectiveDnaSync(out[KEY_TEMPLATE], k ? out[k] : null)
    }

    /** Map of all per-account overrides — for editor enumeration only. */
    async function loadAllOverrides() {
        const items = await chrome.storage.local.get(null)
        const map = {}
        for (const k in items) {
            if (k.indexOf(KEY_OVERRIDE_PREFIX) !== 0) continue
            const accountId = k.slice(KEY_OVERRIDE_PREFIX.length)
            map[accountId] = _normOverride(items[k])
        }
        return map
    }

    window.AesCanopyDnaStore = {
        // keys
        KEY_TEMPLATE,
        KEY_OVERRIDE_PREFIX,
        // metadata
        DIMENSIONS,
        DEFAULT_TEMPLATE,
        WEIGHTS,
        NETWORK_SHAPES,
        RISK_PROFILES,
        TEMPO_VALUES,
        BRAND_STANCES,
        // template
        loadTemplate,
        saveTemplate,
        resetTemplateToDefaults,
        hasTemplate,
        markTemplateAuthored,
        // override
        loadOverride,
        saveOverride,
        clearOverrideDimension,
        clearOverrideLeaf,
        clearAllOverrides,
        loadAllOverrides,
        // resolver — invariant L5-A: this is the only path
        effectiveDna,
        effectiveDnaSync
    }
})()
