"use strict"

/**
 * Slack-budget API (Track 2 slice 2c, extended in Track 7 slice 7e).
 *
 * Drop-in for `AesAfpAutoScheduler.run({budget})` at allocator.js:123 — the
 * output preserves the four contract fields the allocator/objective consume:
 *
 *     {maxWeeklyBlockHours, maxDailyBlockHours,
 *      mandatoryGroundHoursPerDay, ratioForecast, source}
 *
 * with widget-only enrichments (`currentRatio`, `currentCondition`,
 * `equilibriumRatio`, `currentScheduledWeeklyHours`, `fit`) appended.
 *
 * `mandatoryGroundHoursPerDay` survives in the output only because the
 * objective penalty function (objective.js:19) treats it as a soft daily
 * cap. The user-stated optimization target is "asymptote ratio just above
 * 100 %" — the load-bearing field is `maxWeeklyBlockHours`; the daily fold
 * is just `maxWeekly/7 − groundHours`.
 *
 * `targetUtilisationPct` lives in `settings.autoScheduler` (the namespace
 * the allocator already owns) — Track 2 does NOT introduce a parallel
 * top-level field.
 *
 * Track 7 slice 7e: when a Schedule is present (passed via opts.schedule
 * or loaded from AesAfpScheduleStore), sum its `kind === "maintenance"`
 * block durations into `scheduledMaintenanceHoursPerWeek` and SUBTRACT
 * them from `maxWeeklyBlockHours`. AS reserves those hours for hangar
 * activities — the allocator can't schedule flights into them, so they
 * shouldn't count toward the wear-budget ceiling either. Only applies
 * when source === "regression" (the fallback ceiling is already pessimistic).
 */
;(function () {
    if (window.AesAfpMaintenanceBudget) return

    const RATIO_FLOOR                    = 100
    const HOURS_PER_WEEK                 = 168
    const MANDATORY_GROUND_HOURS_PER_DAY = 4   // matches allocator's _fallbackBudget
    const FORECAST_RATIO_MIN             = 0
    const FORECAST_RATIO_MAX             = 200

    function _forecastRatio(currentRatio, fit, weeklyBlockHours, weeks) {
        if (!isFinite(currentRatio) || !fit || !fit.valid) return null
        if (!isFinite(weeklyBlockHours)) return null
        const deltaPerWeek = fit.slope * weeklyBlockHours + fit.intercept
        const next = currentRatio + deltaPerWeek * weeks
        return Math.max(FORECAST_RATIO_MIN, Math.min(FORECAST_RATIO_MAX, next))
    }

    /**
     * With a valid regression, solve for the weekly block hours that keep
     * the maintenance ratio at or above the target after the configured wait
     * horizon. At exactly the target ratio this collapses to equilibrium
     * weekly hours (the rate that holds Δratio ≈ 0). Above target, the tail
     * can spend that buffer; below target, the ceiling tightens so the next
     * schedule helps the ratio recover. Without a stable regression, fall
     * back to the autoScheduler's existing fallback constants. The (0, 168]
     * guard prevents a too-small sample set producing absurd budgets.
     */
    function _resolveCeiling(fit, settings, currentRatio) {
        const a = (settings && settings.autoScheduler) || {}
        const fallbackMaxWeekly = isFinite(a.fallbackMaxWeeklyBlockHours)
            ? Number(a.fallbackMaxWeeklyBlockHours) : 80
        const fallbackMaxDaily = isFinite(a.fallbackMaxDailyBlockHours)
            ? Number(a.fallbackMaxDailyBlockHours) : 14
        const targetRatio = isFinite(a.minMaintenanceRatio)
            ? Number(a.minMaintenanceRatio) : RATIO_FLOOR
        const waitDays = isFinite(a.maintenanceWaitDays) && Number(a.maintenanceWaitDays) > 0
            ? Number(a.maintenanceWaitDays) : 3

        const eq = fit && fit.valid ? fit.equilibriumWeeklyBlockHours : null
        if (isFinite(eq) && eq > 0 && eq <= HOURS_PER_WEEK) {
            const targetHours = _weeklyHoursForTargetRatio(
                currentRatio, fit, targetRatio, waitDays
            )
            const maxWeekly = isFinite(targetHours)
                ? Math.max(0, Math.min(HOURS_PER_WEEK, targetHours))
                : eq
            const dailyFromWeekly = Math.max(0, maxWeekly / 7 - MANDATORY_GROUND_HOURS_PER_DAY)
            return {
                maxWeeklyBlockHours:        maxWeekly,
                maxDailyBlockHours:         Math.min(dailyFromWeekly, fallbackMaxDaily),
                mandatoryGroundHoursPerDay: MANDATORY_GROUND_HOURS_PER_DAY,
                source:                     "regression",
                targetMaintenanceRatio:     targetRatio,
                maintenanceWaitDays:        waitDays,
                targetLimited:              isFinite(targetHours)
            }
        }
        return {
            maxWeeklyBlockHours:        fallbackMaxWeekly,
            maxDailyBlockHours:         fallbackMaxDaily,
            mandatoryGroundHoursPerDay: MANDATORY_GROUND_HOURS_PER_DAY,
            source:                     "fallback",
            targetMaintenanceRatio:     targetRatio,
            maintenanceWaitDays:        waitDays,
            targetLimited:              false
        }
    }

    function _weeklyHoursForTargetRatio(currentRatio, fit, targetRatio, waitDays) {
        if (!isFinite(currentRatio) || !fit || !fit.valid) return null
        const slope = Number(fit.slope)
        const intercept = Number(fit.intercept)
        const weeks = Number(waitDays) / 7
        if (!isFinite(slope) || !isFinite(intercept) || !isFinite(weeks) || weeks <= 0) return null
        // The useful regression shape is slope < 0: more flying consumes
        // maintenance ratio. If the fitted slope is flat/positive, the
        // equilibrium ceiling is safer than a target solve.
        if (slope >= 0) return null
        return ((Number(targetRatio) - Number(currentRatio)) / weeks - intercept) / slope
    }

    async function compute(opts) {
        const {server, aircraftId, spec, settings} = opts || {}
        if (!server || !aircraftId) return null

        const settingsResolved = settings || (typeof AesAfpSettings !== "undefined"
            ? await AesAfpSettings.load() : {})

        const maint = (typeof AesAfpMaintenanceStore !== "undefined")
            ? await AesAfpMaintenanceStore.load(server, aircraftId)
            : {ratio: null, condition: null, ratioStatus: null, conditionStatus: null}
        const fit = (typeof AesAfpWearModel !== "undefined")
            ? await AesAfpWearModel.fit(server, aircraftId)
            : {valid: false}
        const scheduledWeekly = (typeof AesAfpWearModel !== "undefined")
            ? await AesAfpWearModel.scheduledWeeklyBlockHours(spec)
            : null

        // Track 7 slice 7e — schedule-derived maintenance hours.
        // Caller may pass `opts.schedule` directly (preferred when the
        // panel already loaded one); otherwise we fetch from the store.
        // Defensive against AesAfpScheduleStore being absent on a
        // surface that doesn't load the AFP manifest block.
        let schedule = (opts && opts.schedule) || null
        if (!schedule && typeof AesAfpScheduleStore !== "undefined") {
            try { schedule = await AesAfpScheduleStore.load(server, aircraftId) }
            catch (_) { schedule = null }
        }
        const scheduledMaintenanceHoursPerWeek = _sumMaintenanceHours(schedule)

        const currentRatio = isFinite(maint.ratio) ? Number(maint.ratio) : null
        const ceiling = _resolveCeiling(fit, settingsResolved, currentRatio)
        // Subtract reserved AS-managed maintenance hours from the wear
        // ceiling — the allocator can't fly during those windows, so
        // they're not available block hours. Only when we're using a
        // regression ceiling (the fallback is pessimistic enough already).
        const useRegression = ceiling.source === "regression"
        const adjustedMaxWeekly = useRegression
            ? Math.max(0, ceiling.maxWeeklyBlockHours - scheduledMaintenanceHoursPerWeek)
            : ceiling.maxWeeklyBlockHours
        const adjustedMaxDaily = useRegression
            ? Math.max(0, adjustedMaxWeekly / 7 - ceiling.mandatoryGroundHoursPerDay)
            : ceiling.maxDailyBlockHours

        const forecastRatio7d = useRegression
            ? _forecastRatio(currentRatio, fit, scheduledWeekly, 1)
            : null
        const equilibriumRatio = useRegression
            ? _forecastRatio(currentRatio, fit, adjustedMaxWeekly, 1)
            : null
        const forecastRatioTargetDays = useRegression
            ? _forecastRatio(currentRatio, fit, adjustedMaxWeekly, ceiling.maintenanceWaitDays / 7)
            : null

        // Lane C Phase 2 — derive fleet-optimizer target hours dormantly.
        // null when:
        //   * fleetOptimizer settings missing
        //   * targetingEnabled === false (default)
        //   * regression unstable (slope >= 0 → equilibriumWeeklyBlockHours not finite)
        //   * tail explicitly excluded via perAircraft override
        // Bit-for-bit identical to pre-Phase-2 when null is returned.
        let targetWeeklyHours = null
        let floorPct = null
        let headroomPct = null
        try {
            const fos = (typeof window !== "undefined" && window.AesStrategyFleetOptimizerSettings)
                ? await window.AesStrategyFleetOptimizerSettings.load() : null
            if (fos && fos.targetingEnabled === true) {
                const per = (fos.perAircraft && fos.perAircraft[String(aircraftId)]) || null
                if (!(per && per.excludeFromOptimizer === true)) {
                    floorPct    = (per && isFinite(per.floorPct))    ? Number(per.floorPct)
                                : (isFinite(fos.ratioFloorPct) ? Number(fos.ratioFloorPct) : null)
                    headroomPct = (per && isFinite(per.headroomPct)) ? Number(per.headroomPct)
                                : (isFinite(fos.headroomPct) ? Number(fos.headroomPct) : null)
                    if (useRegression && isFinite(ceiling.maxWeeklyBlockHours) && headroomPct != null) {
                        targetWeeklyHours = Math.max(0,
                            ceiling.maxWeeklyBlockHours * (1 - headroomPct / 100))
                    }
                }
            }
        } catch (_) { /* dormant fallback */ }

        return {
            maxWeeklyBlockHours:               adjustedMaxWeekly,
            maxDailyBlockHours:                adjustedMaxDaily,
            mandatoryGroundHoursPerDay:        ceiling.mandatoryGroundHoursPerDay,
            ratioForecast:                     forecastRatio7d,
            source:                            ceiling.source,
            currentRatio,
            currentCondition:                  isFinite(maint.condition) ? Number(maint.condition) : null,
            ratioStatus:                       maint.ratioStatus || null,
            conditionStatus:                   maint.conditionStatus || null,
            currentScheduledWeeklyHours:       isFinite(scheduledWeekly) ? Number(scheduledWeekly) : null,
            equilibriumRatio,
            forecastRatio7d,
            forecastRatioTargetDays,
            ratioFloor:                        RATIO_FLOOR,
            fit:                               fit || null,
            scheduledMaintenanceHoursPerWeek,
            rawMaxWeeklyBlockHours:            ceiling.maxWeeklyBlockHours,
            targetMaintenanceRatio:            ceiling.targetMaintenanceRatio,
            maintenanceWaitDays:               ceiling.maintenanceWaitDays,
            targetLimited:                     ceiling.targetLimited,
            // Lane C Phase 2 — null until user opts in via fleetOptimizer settings.
            targetWeeklyHours,
            floorPct,
            headroomPct
        }
    }

    /**
     * Sum the duration of every `kind === "maintenance"` block across
     * the week. Returns 0 on empty / missing schedule. Defensive against
     * malformed blocks (NaN durations are skipped, not propagated).
     */
    function _sumMaintenanceHours(schedule) {
        if (!schedule || !Array.isArray(schedule.days)) return 0
        let totalMin = 0
        for (const day of schedule.days) {
            if (!day || !Array.isArray(day.blocks)) continue
            for (const b of day.blocks) {
                if (!b || b.kind !== "maintenance") continue
                const d = Number(b.durationMin)
                if (isFinite(d) && d > 0) totalMin += d
            }
        }
        return totalMin / 60
    }

    window.AesAfpMaintenanceBudget = {compute}
})()
