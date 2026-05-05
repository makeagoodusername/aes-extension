"use strict"

/**
 * Legacy settings read guard.
 *
 * Older content scripts read `chrome.storage.local.get(["settings"])` and then
 * immediately dereference nested areas. This guard normalizes that returned
 * blob in the content-script realm so missing or partial settings records do
 * not crash page load.
 */
;(function (root) {
    if (!root || root.__aesLegacySettingsGuardInstalled) return
    root.__aesLegacySettingsGuardInstalled = true

    const chromeApi = root.chrome
    const local = chromeApi && chromeApi.storage && chromeApi.storage.local
    if (!local || typeof local.get !== "function") return

    function isPlainObject(value) {
        return !!value && typeof value === "object" && !Array.isArray(value)
    }

    function fallbackSettings(settings) {
        const source = isPlainObject(settings) ? settings : {}
        const out = Object.assign({}, source)
        out.invPricing = isPlainObject(out.invPricing) ? out.invPricing : {}
        out.invPricing.recommendation = isPlainObject(out.invPricing.recommendation)
            ? out.invPricing.recommendation
            : {}
        for (const cmp of ["Y", "C", "F", "Cargo"]) {
            out.invPricing.recommendation[cmp] = isPlainObject(out.invPricing.recommendation[cmp])
                ? out.invPricing.recommendation[cmp]
                : {maxPrice: 200, minPrice: 60, steps: []}
            if (!Array.isArray(out.invPricing.recommendation[cmp].steps)) {
                out.invPricing.recommendation[cmp].steps = []
            }
        }
        out.personelManagement = isPlainObject(out.personelManagement)
            ? out.personelManagement
            : {value: 0, type: "absolute", auto: 0, alreadyUpdated: []}
        if (!Array.isArray(out.personelManagement.alreadyUpdated)) {
            out.personelManagement.alreadyUpdated = []
        }
        out.flightInfo = isPlainObject(out.flightInfo) ? out.flightInfo : {autoClose: 0}
        return out
    }

    function mergeSettings(settings) {
        const defaults = root.AesLegacySettingsDefaults
        if (defaults && typeof defaults.mergeSettings === "function") {
            return defaults.mergeSettings(settings)
        }
        return fallbackSettings(settings)
    }

    function wantsSettings(keys) {
        if (keys == null) return true
        if (keys === "settings") return true
        if (Array.isArray(keys)) return keys.includes("settings")
        return isPlainObject(keys) && Object.prototype.hasOwnProperty.call(keys, "settings")
    }

    function normalizeResult(keys, result) {
        if (!wantsSettings(keys)) return result
        const out = isPlainObject(result) ? Object.assign({}, result) : {}
        out.settings = mergeSettings(out.settings)
        return out
    }

    const rawGet = local.get.bind(local)
    local.get = function guardedLegacySettingsGet(keys, callback) {
        if (typeof callback === "function") {
            return rawGet(keys, function (result) {
                callback(normalizeResult(keys, result))
            })
        }
        const result = rawGet(keys)
        if (result && typeof result.then === "function") {
            return result.then(function (items) {
                return normalizeResult(keys, items)
            })
        }
        return normalizeResult(keys, result)
    }
})(typeof globalThis !== "undefined"
    ? globalThis
    : (typeof window !== "undefined" ? window : null))
