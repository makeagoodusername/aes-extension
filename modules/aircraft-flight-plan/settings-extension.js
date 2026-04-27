"use strict"

/**
 * Settings extension for the Aircraft Flight Plan Assistant (Slice F).
 *
 * Defines a NEW top-level block `settings.aircraftFlightPlan` inside the
 * shared `settings` blob in chrome.storage.local. Sibling-of (NOT child-of)
 * `settings.routeAssistant` — the slice family ships independently of the
 * Route Assistant panel and must not contend with `RouteAssistantSettings`
 * for that namespace.
 *
 * Mirrors the SHAPE of `RouteAssistantSettings.load/save` (deep-fill on
 * load, partial-update save) but lives in its own top-level namespace.
 * Crucially, we do NOT mutate `settings.routeAssistant` — only our own
 * key is read or written. Adding new fields in a future version is safe;
 * `_mergeAircraftFlightPlan` deep-fills them on the next load.
 *
 * Slice F invariants (also documented in HANDOVER §10 once consolidated):
 *   - `settings.aircraftFlightPlan` is a TOP-LEVEL block, NOT a sub-block
 *     of routeAssistant.
 *   - `_mergeAircraftFlightPlan` is the canonical merge path. Don't add
 *     a second deep-merge helper for this block elsewhere.
 *   - `candidateChips` deep-merges so a partial save of one chip flag
 *     doesn't blow away the other two.
 */
class AesAfpSettings {
    static _defaults() {
        return {
            enabled:           true,
            defaultTopN:       10,
            defaultPricePct:   100,        // "Route or default prices"
            defaultService:    "",         // "" = "Route or default profile"
            showWavePreview:   true,
            candidateChips: {
                rangeFitOnly:           true,
                hideAlreadyScheduled:   true,
                watchlistOnly:          false
            },
            lastSelectedPresetId: null,
            // Track 3 — auto-scheduler. Phase-1 ships disabled behind the
            // "preview-only" tier gate; consumers (Track 5) flip the tier when
            // the user opts in. `weights` deep-merges so a future tuning agent
            // can patch one field without clobbering siblings.
            autoScheduler: {
                enabled:                     false,
                tier:                        "preview-only",   // "preview-only" | "apply-on-confirm"
                requireConfirm:              true,
                maxLegsPerApply:             28,
                minMaintenanceRatio:         100,
                targetUtilisationPct:        90,
                fallbackMaxWeeklyBlockHours: 80,
                fallbackMaxDailyBlockHours:  14,
                fallbackFuelCostPerKg:       0.40,
                weights: {
                    cargoWeight:                0.5,
                    grossWeight:                1.0,
                    // fuelWeight is small by default because `gross` is a
                    // demand-weighted seat count (unit-less) while fuelCost
                    // is in AS$. Calibrated against an MCO A320: setting
                    // fuelWeight to 1.0 makes fuelCost dominate (every
                    // placement scores negative). 0.05 turns fuel into a
                    // tiebreaker rather than a vetoer; users can tune up.
                    fuelWeight:                 0.05,
                    distanceSaturationNm:       2500,
                    distanceFloor:              0.2,
                    slackPenaltyPerHour:        5000,
                    dailyOverrunPenaltyPerHour: 10000,
                    cycleMinutes:               30,
                    slotResolutionMin:          5,
                    weeklyFlightsDivisor:       4
                },
                // Slice 6b-followup — diff calibration knob. ScheduleDiff
                // matches a current leg with a proposed leg when the dep
                // time delta is ≤ toleranceMin. The default 15 matches
                // slice 6b's hard-coded behaviour. Per-call override on
                // `compare(c, p, {toleranceMin})` always wins; this value
                // is the project-wide default for surfaces that don't
                // pass an opt arg.
                diff: {
                    toleranceMin: 15
                }
            },
            // Track 9 — Flight Studio (Slice S1+). Compose-and-apply
            // surface for the AS New Flight Number form, reachable from
            // AESMenu. Independent from autoScheduler — one's per-flight
            // composition, the other's whole-aircraft optimisation.
            // S1 ships in dry-run mode by default; pre-fill (S2) and
            // submit (S5) tiers gate behind defaultMode + featureFlags.
            studio: {
                enabled:                  true,
                defaultMode:              "dry-run",   // "dry-run" | "pre-fill" | "submit"
                confirmBeforeSubmit:      true,
                autoCaptureFlightNumbers: true,
                paste:        { tolerantTimes: true },
                featureFlags: {
                    paste:           false,   // S3
                    templates:       false,   // S4
                    registry:        false,   // S5
                    vfpEditOverlay:  false    // S6
                }
            }
        }
    }

    /**
     * Deep-merge the aircraftFlightPlan block. Top-level scalars fall
     * through Object.assign against defaults; numeric fields are
     * validated as positive integers (fall back to default on invalid);
     * `candidateChips` deep-merges as a sub-object.
     *
     * Single canonical merge path — see the HANDOVER §10 invariant.
     */
    static _mergeAircraftFlightPlan(defaults, block) {
        const def = defaults || {}
        const b   = block    || {}
        const numField = (v, fallback) => {
            const n = Number(v)
            return (isFinite(n) && n > 0) ? n : fallback
        }
        const numFieldNonNeg = (v, fallback) => {
            const n = Number(v)
            return (isFinite(n) && n >= 0) ? n : fallback
        }
        const defAuto = def.autoScheduler || {}
        const bAuto   = b.autoScheduler   || {}
        const defW    = defAuto.weights   || {}
        const bW      = bAuto.weights     || {}
        const defDiff = defAuto.diff      || {}
        const bDiff   = bAuto.diff        || {}
        const defStudio = def.studio      || {}
        const bStudio   = b.studio        || {}
        const defStudioPaste = defStudio.paste        || {}
        const bStudioPaste   = bStudio.paste          || {}
        const defStudioFlags = defStudio.featureFlags || {}
        const bStudioFlags   = bStudio.featureFlags   || {}
        const validStudioMode = (m) => (m === "dry-run" || m === "pre-fill" || m === "submit")
        const studio = {
            enabled:                  (typeof bStudio.enabled === "boolean")             ? bStudio.enabled             : defStudio.enabled,
            defaultMode:              validStudioMode(bStudio.defaultMode)               ? bStudio.defaultMode         : defStudio.defaultMode,
            confirmBeforeSubmit:      (typeof bStudio.confirmBeforeSubmit === "boolean") ? bStudio.confirmBeforeSubmit : defStudio.confirmBeforeSubmit,
            autoCaptureFlightNumbers: (typeof bStudio.autoCaptureFlightNumbers === "boolean") ? bStudio.autoCaptureFlightNumbers : defStudio.autoCaptureFlightNumbers,
            paste: {
                tolerantTimes: (typeof bStudioPaste.tolerantTimes === "boolean") ? bStudioPaste.tolerantTimes : defStudioPaste.tolerantTimes
            },
            featureFlags: {
                paste:           (typeof bStudioFlags.paste === "boolean")          ? bStudioFlags.paste          : defStudioFlags.paste,
                templates:       (typeof bStudioFlags.templates === "boolean")      ? bStudioFlags.templates      : defStudioFlags.templates,
                registry:        (typeof bStudioFlags.registry === "boolean")       ? bStudioFlags.registry       : defStudioFlags.registry,
                vfpEditOverlay:  (typeof bStudioFlags.vfpEditOverlay === "boolean") ? bStudioFlags.vfpEditOverlay : defStudioFlags.vfpEditOverlay
            }
        }
        const autoScheduler = {
            enabled:                     (typeof bAuto.enabled === "boolean") ? bAuto.enabled : defAuto.enabled,
            tier:                        (bAuto.tier === "apply-on-confirm" || bAuto.tier === "preview-only") ? bAuto.tier : defAuto.tier,
            requireConfirm:              (typeof bAuto.requireConfirm === "boolean") ? bAuto.requireConfirm : defAuto.requireConfirm,
            maxLegsPerApply:             numField(bAuto.maxLegsPerApply,             defAuto.maxLegsPerApply),
            minMaintenanceRatio:         numField(bAuto.minMaintenanceRatio,         defAuto.minMaintenanceRatio),
            targetUtilisationPct:        numField(bAuto.targetUtilisationPct,        defAuto.targetUtilisationPct),
            fallbackMaxWeeklyBlockHours: numField(bAuto.fallbackMaxWeeklyBlockHours, defAuto.fallbackMaxWeeklyBlockHours),
            fallbackMaxDailyBlockHours:  numField(bAuto.fallbackMaxDailyBlockHours,  defAuto.fallbackMaxDailyBlockHours),
            fallbackFuelCostPerKg:       numFieldNonNeg(bAuto.fallbackFuelCostPerKg, defAuto.fallbackFuelCostPerKg),
            weights: {
                cargoWeight:                numFieldNonNeg(bW.cargoWeight,                defW.cargoWeight),
                grossWeight:                numFieldNonNeg(bW.grossWeight,                defW.grossWeight),
                fuelWeight:                 numFieldNonNeg(bW.fuelWeight,                 defW.fuelWeight),
                distanceSaturationNm:       numField(bW.distanceSaturationNm,             defW.distanceSaturationNm),
                distanceFloor:              numFieldNonNeg(bW.distanceFloor,              defW.distanceFloor),
                slackPenaltyPerHour:        numFieldNonNeg(bW.slackPenaltyPerHour,        defW.slackPenaltyPerHour),
                dailyOverrunPenaltyPerHour: numFieldNonNeg(bW.dailyOverrunPenaltyPerHour, defW.dailyOverrunPenaltyPerHour),
                cycleMinutes:               numFieldNonNeg(bW.cycleMinutes,               defW.cycleMinutes),
                slotResolutionMin:          numField(bW.slotResolutionMin,                defW.slotResolutionMin),
                weeklyFlightsDivisor:       numField(bW.weeklyFlightsDivisor,             defW.weeklyFlightsDivisor)
            },
            diff: {
                toleranceMin: numFieldNonNeg(bDiff.toleranceMin, defDiff.toleranceMin)
            }
        }
        return {
            enabled:               (typeof b.enabled === "boolean") ? b.enabled : def.enabled,
            defaultTopN:           numField(b.defaultTopN,     def.defaultTopN),
            defaultPricePct:       numField(b.defaultPricePct, def.defaultPricePct),
            defaultService:        (typeof b.defaultService === "string") ? b.defaultService : def.defaultService,
            showWavePreview:       (typeof b.showWavePreview === "boolean") ? b.showWavePreview : def.showWavePreview,
            candidateChips:        Object.assign({}, def.candidateChips || {}, b.candidateChips || {}),
            lastSelectedPresetId:  (typeof b.lastSelectedPresetId === "string") ? b.lastSelectedPresetId : def.lastSelectedPresetId,
            autoScheduler:         autoScheduler,
            studio:                studio
        }
    }

    /**
     * Read the merged aircraftFlightPlan block. Always returns a fully-
     * populated object — callers don't need to default-fill.
     *
     * Does NOT lazy-write defaults back to storage on first load; we leave
     * the settings blob untouched until the user actually saves.
     * RouteAssistantSettings.load does a one-time write to bootstrap its
     * block, but that's a side effect of its earlier lazy-init pattern,
     * not a contract — Slice F can skip it cleanly.
     */
    /**
     * L2 — read namespaced first, fall back to legacy.
     *
     * Storage shape post-L2:
     *   settings.aircraftFlightPlan                  (legacy — pre-L2)
     *   settings.acct.<id>.aircraftFlightPlan        (namespaced — L2+)
     */
    static async load() {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const id = (typeof currentAccountIdSync === "function") ? currentAccountIdSync() : null
        let block = null
        if (id && settings.acct && settings.acct[id] && typeof settings.acct[id] === "object") {
            const ns = settings.acct[id].aircraftFlightPlan
            if (ns && typeof ns === "object") block = ns
        }
        if (!block) block = settings.aircraftFlightPlan || {}
        return AesAfpSettings._mergeAircraftFlightPlan(AesAfpSettings._defaults(), block)
    }

    /**
     * Partial update — pass only the keys you want to change. The merged
     * result is written back to `settings.aircraftFlightPlan`. Other
     * top-level settings keys (routeAssistant, usedAircraftScanner, etc.)
     * are preserved verbatim.
     */
    static async save(patch) {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const current = await AesAfpSettings.load()
        const p = patch || {}
        // autoScheduler has nested `weights` and `diff` objects that must
        // deep-merge (same convention as candidateChips) so a single-knob
        // save doesn't wipe sibling weights or the diff tolerance.
        const mergedAuto = Object.assign(
            {},
            current.autoScheduler || {},
            p.autoScheduler || {},
            {weights: Object.assign(
                {},
                (current.autoScheduler && current.autoScheduler.weights) || {},
                (p.autoScheduler && p.autoScheduler.weights) || {}
            )},
            {diff: Object.assign(
                {},
                (current.autoScheduler && current.autoScheduler.diff) || {},
                (p.autoScheduler && p.autoScheduler.diff) || {}
            )}
        )
        // Studio mirrors candidateChips: nested `paste` and `featureFlags`
        // sub-objects must deep-merge so a single-knob save doesn't wipe
        // sibling flags.
        const mergedStudio = Object.assign(
            {},
            current.studio || {},
            p.studio || {},
            {paste: Object.assign(
                {},
                (current.studio && current.studio.paste) || {},
                (p.studio && p.studio.paste) || {}
            )},
            {featureFlags: Object.assign(
                {},
                (current.studio && current.studio.featureFlags) || {},
                (p.studio && p.studio.featureFlags) || {}
            )}
        )
        const next = AesAfpSettings._mergeAircraftFlightPlan(
            AesAfpSettings._defaults(),
            Object.assign({}, current, p,
                // Patch's candidateChips must merge with current, not replace.
                {candidateChips: Object.assign(
                    {},
                    current.candidateChips || {},
                    p.candidateChips || {}
                )},
                {autoScheduler: mergedAuto},
                {studio:        mergedStudio}
            )
        )
        const id = (typeof currentAccountIdSync === "function") ? currentAccountIdSync() : null
        if (id) {
            settings.acct = (settings.acct && typeof settings.acct === "object") ? settings.acct : {}
            settings.acct[id] = (settings.acct[id] && typeof settings.acct[id] === "object") ? settings.acct[id] : {}
            settings.acct[id].aircraftFlightPlan = next
        } else {
            settings.aircraftFlightPlan = next
        }
        await chrome.storage.local.set({settings: settings})
        return next
    }
}

if (typeof window !== "undefined") {
    window.AesAfpSettings = AesAfpSettings
}
