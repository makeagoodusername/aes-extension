"use strict"

/**
 * AesAfpSettings — configuration for the Aircraft Flight Plan suite.
 *
 * Reuses AesSettings (settings-bridge.js) for storage I/O.
 */
class AesAfpSettings {
    static _defaults() {
        return {
            enabled: true,
            defaultTopN: 10,
            defaultPricePct: 100,
            defaultService: "",
            showWavePreview: true,
            candidateChips: {
                rangeFitOnly: false,
                hideAlreadyScheduled: false,
                watchlistOnly: false
            },
            lastSelectedPresetId: null,
            autoScheduler: {
                enabled: true,
                tier: "apply-on-confirm",
                maxLegsPerApply: 28,
                diff: {
                    toleranceMin: 15
                }
            }
        }
    }

    static async load() {
        if (typeof window.AesSettings === "undefined") return AesAfpSettings._defaults()
        const block = await window.AesSettings.getArea("aircraftFlightPlan")
        const merged = window.AesSettings.deepMerge(AesAfpSettings._defaults(), block)
        AesAfpSettings._cached = merged
        return merged
    }

    static async save(patch) {
        if (typeof window.AesSettings === "undefined") return null
        const current = await AesAfpSettings.load()
        const merged = window.AesSettings.deepMerge(current, patch)
        AesAfpSettings._cached = merged
        return await window.AesSettings.saveArea("aircraftFlightPlan", merged)
    }

    static cached() {
        return { aircraftFlightPlan: AesAfpSettings._cached || AesAfpSettings._defaults() }
    }
}

if (typeof window !== "undefined") {
    window.AesAfpSettings = AesAfpSettings
}
