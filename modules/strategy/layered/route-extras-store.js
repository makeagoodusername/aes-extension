"use strict"

/**
 * AES Strategy — Route extras layer store (Slice 5).
 *
 * Per-route non-objective patch. Sits alongside the legacy
 * route-objective-store (which keeps owning the `objective` slot for
 * back-compat). The resolver merges both stores into a single route
 * layer; this store covers everything else (priceDeadband, weights,
 * fleetOptimizer.* tweaks, etc.).
 *
 * Storage:
 *   aesStrategy:layered:route:acct:<accountId>:HUB-DEST
 *
 * Per-layer kill switch: aesStrategy:layered:route:enabled
 *
 * Public API (window.AesStrategyLayeredRouteExtras):
 *   FEATURE_FLAG_KEY                          → string
 *   featureEnabled()                          → Promise<bool>
 *   keyFor(accountId, hub, dest)              → string
 *   load(accountId, hub, dest)                → Promise<record|null>
 *   save(accountId, hub, dest, {patch,pinned,label}) → Promise<record>
 *   clear(accountId, hub, dest)               → Promise<void>
 *   listForAccount(accountId)                 → Promise<[{pair, record}]>
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLayeredRouteExtras) return

    const PREFIX = "aesStrategy:layered:route"
    const FEATURE_FLAG_KEY = "aesStrategy:layered:route:enabled"
    let _featureFlagCached = null

    function _acctKey(prefix, accountId, suffix) {
        if (typeof acctKeyForAccount === "function") return acctKeyForAccount(prefix, accountId, suffix)
        const tail = (suffix == null || suffix === "") ? "" : (":" + suffix)
        return accountId ? (prefix + ":acct:" + accountId + tail) : (prefix + tail)
    }

    function _pair(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    function keyFor(accountId, hub, dest) {
        return _acctKey(PREFIX, accountId, _pair(hub, dest))
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
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(function (changes, area) {
                if (area !== "local") return
                if (changes && changes[FEATURE_FLAG_KEY]) _featureFlagCached = null
            })
        }
    } catch (_) {}

    function _emit(payload) {
        try { if (window.CentralHubBus) window.CentralHubBus.emit("strategy:layered:route-extras-changed", payload) } catch (_) {}
        try { if (window.AesDataBus && typeof window.AesDataBus.publish === "function") {
            window.AesDataBus.publish("data:strategy:layered:route-extras-changed", payload, "route-extras-store")
        } } catch (_) {}
    }

    function _normaliseRecord(blob) {
        const M = window.AesStrategyLayeredMigrations
        if (M && typeof M.migrateOnce === "function") return M.migrateOnce(blob, "route-extras")
        const meta = (blob && typeof blob === "object") ? blob : {}
        return {
            schemaVersion:      1,
            layerKind:          "route-extras",
            patch:              (meta.patch && typeof meta.patch === "object") ? meta.patch : {},
            pinned:             (meta.pinned && typeof meta.pinned === "object") ? meta.pinned : {},
            label:              typeof meta.label === "string" ? meta.label : "",
            updatedAt:          typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
            updatedByAccountId: typeof meta.updatedByAccountId === "string" ? meta.updatedByAccountId : ""
        }
    }

    async function load(accountId, hub, dest) {
        if (!hub || !dest) return null
        try {
            const k = keyFor(accountId, hub, dest)
            const data = await chrome.storage.local.get([k])
            return data[k] ? _normaliseRecord(data[k]) : null
        } catch (_) { return null }
    }

    async function save(accountId, hub, dest, args) {
        if (!hub || !dest) throw new Error("AesStrategyLayeredRouteExtras.save: hub + dest required")
        const existing = (await load(accountId, hub, dest)) || {}
        const merged = _normaliseRecord({
            patch:              (args && args.patch  != null) ? args.patch  : existing.patch,
            pinned:             (args && args.pinned != null) ? args.pinned : existing.pinned,
            label:              (args && args.label  != null) ? args.label  : existing.label,
            updatedAt:          Date.now(),
            updatedByAccountId: accountId || ""
        })
        await chrome.storage.local.set({[keyFor(accountId, hub, dest)]: merged})
        try {
            if (window.AesStrategyLayered && typeof window.AesStrategyLayered.invalidateCache === "function") {
                window.AesStrategyLayered.invalidateCache()
            }
        } catch (_) {}
        _emit({accountId, pair: _pair(hub, dest), action: "saved"})
        return merged
    }

    async function clear(accountId, hub, dest) {
        if (!hub || !dest) return
        try { await chrome.storage.local.remove([keyFor(accountId, hub, dest)]) } catch (_) {}
        try {
            if (window.AesStrategyLayered && typeof window.AesStrategyLayered.invalidateCache === "function") {
                window.AesStrategyLayered.invalidateCache()
            }
        } catch (_) {}
        _emit({accountId, pair: _pair(hub, dest), action: "cleared"})
    }

    async function listForAccount(accountId) {
        const out = []
        try {
            const all = await chrome.storage.local.get(null)
            const want = _acctKey(PREFIX, accountId, "")
            const wantPrefix = want.endsWith(":") ? want : (want + ":")
            for (const k of Object.keys(all)) {
                if (k.indexOf(wantPrefix) !== 0) continue
                const tail = k.slice(wantPrefix.length)
                if (!/^[A-Z]{3}-[A-Z]{3}$/.test(tail)) continue
                out.push({pair: tail, record: _normaliseRecord(all[k])})
            }
        } catch (_) {}
        return out
    }

    window.AesStrategyLayeredRouteExtras = {
        FEATURE_FLAG_KEY: FEATURE_FLAG_KEY,
        PREFIX:           PREFIX,
        keyFor:           keyFor,
        featureEnabled:   featureEnabled,
        load:             load,
        save:             save,
        clear:            clear,
        listForAccount:   listForAccount
    }

    // ── ?aes-debug smoke ─────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const k = keyFor("acctX", "lax", "nrt")
            console.assert(k.indexOf(PREFIX) === 0 && k.endsWith(":LAX-NRT"),
                "[route-extras/smoke] keyFor uppercases pair")
            const norm = _normaliseRecord({patch: {priceDeadband: 7},
                                            pinned: {priceDeadband: true}})
            console.assert(norm.patch.priceDeadband === 7,
                "[route-extras/smoke] patch leaf preserved")
            console.assert(norm.pinned.priceDeadband === true,
                "[route-extras/smoke] pin preserved")
            console.assert(norm.layerKind === "route-extras",
                "[route-extras/smoke] layerKind = route-extras")
        }
    } catch (_) {}
})()
