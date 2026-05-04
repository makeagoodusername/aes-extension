"use strict"

/**
 * Shared defaults for the legacy chrome.storage.local.settings blob.
 *
 * The background install hook seeds this shape, but content scripts can run
 * against missing, old, or partially edited settings records. Keep the shape
 * in one place so every legacy consumer normalizes before reading nested
 * fields.
 */
;(function (root) {
    if (!root || root.AesLegacySettingsDefaults) return

    function isPlainObject(value) {
        return !!value && typeof value === "object" && !Array.isArray(value)
    }

    function clone(value) {
        try { return JSON.parse(JSON.stringify(value)) }
        catch (_) {
            if (Array.isArray(value)) return value.slice()
            return isPlainObject(value) ? Object.assign({}, value) : value
        }
    }

    function deepMerge(base, patch) {
        if (!isPlainObject(base)) return isPlainObject(patch) ? clone(patch) : {}
        if (!isPlainObject(patch)) return clone(base)
        const out = clone(base)
        for (const key of Object.keys(patch)) {
            const pv = patch[key]
            if (pv === undefined) continue
            out[key] = isPlainObject(out[key]) && isPlainObject(pv)
                ? deepMerge(out[key], pv)
                : clone(pv)
        }
        return out
    }

    function schedule() {
        return {autoExtract: 0}
    }

    function stationAutomation() {
        return {
            defaultFilterMode: "minimum",
            defaultPaxThreshold: 0,
            defaultCargoThreshold: 0,
            defaultPaxMin: 1,
            defaultPaxMax: 9,
            defaultCargoMin: 2,
            defaultCargoMax: 10,
            defaultSizeMin: 1,
            defaultSizeMax: 8,
            thresholds: [0, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
            countriesCache: {}
        }
    }

    function usedAircraftScanner() {
        return {
            presets: [],
            typeFamilyOverrides: {},
            concurrency: 6,
            staggerMs: 2000,
            lastScanId: null
        }
    }

    function general() {
        return {defaultDashboard: "general"}
    }

    function personelManagement() {
        return {
            value: 0,
            type: "absolute",
            auto: 0,
            alreadyUpdated: []
        }
    }

    function flightInfo() {
        return {autoClose: 0}
    }

    function invPricingSteps() {
        return [
            {min:  0, max:  40, name: "Drop High",    step: -8},
            {min: 40, max:  60, name: "Drop Medium",  step: -4},
            {min: 60, max:  70, name: "Drop Low",     step: -2},
            {min: 70, max:  80, name: "Keep",         step:  0},
            {min: 80, max:  90, name: "Raise Low",    step:  1},
            {min: 90, max:  99, name: "Raise Medium", step:  2},
            {min: 99, max: 100, name: "Raise High",   step:  5}
        ]
    }

    function invPricing() {
        const block = {
            autoAnalysisSave: 1,
            autoPriceUpdate: 0,
            autoClose: 0,
            recommendation: {},
            historyTable: {
                showNow: 1,
                showOnlyPricing: 0,
                numberOfDates: "5"
            }
        }
        for (const cmp of ["Y", "C", "F", "Cargo"]) {
            block.recommendation[cmp] = {
                maxPrice: 200,
                minPrice: 60,
                steps: invPricingSteps()
            }
        }
        return block
    }

    function all() {
        return {
            invPricing:          invPricing(),
            general:             general(),
            schedule:            schedule(),
            stationAutomation:   stationAutomation(),
            usedAircraftScanner: usedAircraftScanner(),
            personelManagement:  personelManagement(),
            flightInfo:          flightInfo()
        }
    }

    function repairSettings(settings) {
        const out = isPlainObject(settings) ? settings : all()
        const invDefault = invPricing()
        if (!isPlainObject(out.invPricing)) out.invPricing = invDefault
        else {
            out.invPricing = deepMerge(invDefault, out.invPricing)
            if (!isPlainObject(out.invPricing.recommendation)) {
                out.invPricing.recommendation = invDefault.recommendation
            }
            for (const cmp of ["Y", "C", "F", "Cargo"]) {
                const cmpDefault = invDefault.recommendation[cmp]
                const cmpSettings = out.invPricing.recommendation[cmp]
                if (!isPlainObject(cmpSettings)) {
                    out.invPricing.recommendation[cmp] = cmpDefault
                    continue
                }
                out.invPricing.recommendation[cmp] = deepMerge(cmpDefault, cmpSettings)
                if (!Array.isArray(out.invPricing.recommendation[cmp].steps)) {
                    out.invPricing.recommendation[cmp].steps = cmpDefault.steps
                }
            }
        }

        out.personelManagement = isPlainObject(out.personelManagement)
            ? deepMerge(personelManagement(), out.personelManagement)
            : personelManagement()
        if (!Array.isArray(out.personelManagement.alreadyUpdated)) {
            out.personelManagement.alreadyUpdated = []
        }

        out.flightInfo = isPlainObject(out.flightInfo)
            ? deepMerge(flightInfo(), out.flightInfo)
            : flightInfo()

        return out
    }

    function mergeSettings(settings) {
        return repairSettings(deepMerge(all(), settings))
    }

    root.AesLegacySettingsDefaults = {
        createAll: all,
        createFlightInfo: flightInfo,
        createGeneral: general,
        createInvPricing: invPricing,
        createPersonelManagement: personelManagement,
        createSchedule: schedule,
        createStationAutomation: stationAutomation,
        createUsedAircraftScanner: usedAircraftScanner,
        mergeSettings: mergeSettings
    }
})(typeof globalThis !== "undefined"
    ? globalThis
    : (typeof window !== "undefined" ? window : null))
