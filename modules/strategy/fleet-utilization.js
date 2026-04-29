"use strict"

/**
 * Lane C — fleet-wide utilization aggregator.
 *
 * Pure function (§4.7). No DOM, no chrome.storage, no awaits.
 * Composes pre-loaded snapshot + (optional) plan + (optional) regions
 * map into a FleetUtilSummary the tile + drill-down + closed-loop
 * outcome attribution all consume.
 *
 *   AesStrategyFleetUtilization.compute({
 *     snapshot,           // AesStrategy.snapshot() output (required)
 *     fleetPlan?,         // AesStrategy.allocateFleet() output (optional)
 *     settings?,          // AesStrategyFleetOptimizerSettings.load() (optional;
 *                         //   defaults applied via resolveTarget when null)
 *     schedules?,         // Map<aircraftId, Schedule> (optional)
 *     regions?            // Map<aircraftId, {regionId, regionName}> (optional;
 *                         //   provided by Fleet Command's fleet-command.js)
 *   }) → FleetUtilSummary
 *
 * Output shape:
 *   {
 *     ts,
 *     perAircraft: [{aircraftId, registration, equipment, typeId, hub,
 *                    org, regionId, regionName,
 *                    currentRatio, ratioForecast14d, equilibriumPct,
 *                    targetEquilibriumPct, ratioGap,
 *                    weeklyHoursPlanned, targetWeeklyHours,
 *                    maxWeeklyBlockHours, headroomHours, utilizationPct,
 *                    classification: "stress"|"cold"|"on-target"|"unknown",
 *                    rationale: string[]}],
 *     rollups:    {fleetAvgRatioForecast14d, fleetAvgUtilizationPct,
 *                  fleetTargetAvgRatio, ratioGapHeadlinePct,
 *                  byType[], byHub[], byOrg[], byRegion[]},
 *     candidates: {stress: [{aircraftId, ratioGap, suggestion}],
 *                  slack:  [{aircraftId, headroomHours, suggestion}]},
 *     diagnostics: {regressionAircraft, fallbackAircraft, missingFit}
 *   }
 *
 * Classification (constants here; no settings flag yet):
 *   stress      → ratioGap < -1.5pp        (over-flying eats the floor)
 *   cold        → headroomHours > 8h       (asset under-used)
 *   on-target   → otherwise (and target known)
 *   unknown     → wear regression unstable; refuse to propose changes
 *
 * Memoization: keyed on (snapshot.ts, settings hash, plan id). Avoids
 * recompute when called multiple times within the same render cycle.
 */
;(function () {
    if (window.AesStrategyFleetUtilization) return

    const STRESS_GAP_THRESHOLD_PP = 1.5
    const COLD_HEADROOM_HOURS     = 8

    let _memo = null    // {key, value}

    function _memoKey(snapshot, settings, fleetPlan) {
        const ts = (snapshot && snapshot.ts) || 0
        const planId = (fleetPlan && fleetPlan.planId) || ""
        let sHash = ""
        try {
            if (settings && window.AesStrategyFleetOptimizerSettings) {
                sHash = window.AesStrategyFleetOptimizerSettings.settingsHash(settings)
            }
        } catch (_) {}
        return ts + "|" + planId + "|" + sHash
    }

    function _resolveTarget(tail, settings) {
        if (window.AesStrategyFleetOptimizerSettings
            && typeof window.AesStrategyFleetOptimizerSettings.resolveTarget === "function") {
            return window.AesStrategyFleetOptimizerSettings.resolveTarget(tail, settings)
        }
        // Fallback when settings module not loaded — return safe nulls.
        return {
            floorPct:               null,
            headroomPct:            null,
            targetEquilibriumPct:   null,
            targetWeeklyHours:      null,
            equilibriumWeeklyHours: null,
            excluded:               false,
            unknown:                true
        }
    }

    function _planUtilForTail(fleetPlan, aircraftId) {
        if (!fleetPlan || !Array.isArray(fleetPlan.perAircraft)) return null
        const aid = String(aircraftId)
        for (const p of fleetPlan.perAircraft) {
            if (p && String(p.aircraftId) === aid) {
                return p.utilization || null
            }
        }
        return null
    }

    function _ratioForecast14d(currentRatio, fit, plannedHours) {
        if (!isFinite(currentRatio) || !fit || !fit.valid) return null
        if (!isFinite(plannedHours)) return null
        const delta = (fit.slope * plannedHours + fit.intercept) * 2  // 14d ≈ 2 weeks
        const next = currentRatio + delta
        return Math.max(0, Math.min(200, next))
    }

    function _classify(target, ratioGap, headroomHours) {
        if (target.unknown || target.excluded) return "unknown"
        if (ratioGap == null) return "unknown"
        if (ratioGap < -STRESS_GAP_THRESHOLD_PP) return "stress"
        if (headroomHours != null && headroomHours > COLD_HEADROOM_HOURS) return "cold"
        return "on-target"
    }

    function _buildRationale(target, plannedHours, ratioForecast14d, ratioGap) {
        const out = []
        if (target.unknown) {
            out.push("[wear] regression unstable — target unknown")
            return out
        }
        if (target.excluded) {
            out.push("[opt] excluded from optimizer per user override")
            return out
        }
        const hp = isFinite(plannedHours) ? Math.round(plannedHours) : "?"
        const tw = isFinite(target.targetWeeklyHours) ? Math.round(target.targetWeeklyHours) : "?"
        out.push("[gap] " + hp + "h/wk planned · target " + tw + "h")
        if (isFinite(ratioForecast14d)) {
            const sign = (ratioGap == null || ratioGap === 0) ? "" : (ratioGap > 0 ? "+" : "")
            out.push("[ratio] forecast " + ratioForecast14d.toFixed(1) + "%"
                + (ratioGap != null ? " · gap " + sign + ratioGap.toFixed(1) + "pp" : ""))
        }
        return out
    }

    function _byKey(rows, keyFn) {
        const m = new Map()
        for (const r of rows) {
            const k = keyFn(r)
            if (k == null) continue
            if (!m.has(k)) m.set(k, {key: k, count: 0, ratioSum: 0, ratioN: 0,
                                    utilSum: 0, utilN: 0, gapSum: 0, gapN: 0})
            const slot = m.get(k)
            slot.count++
            if (isFinite(r.ratioForecast14d)) { slot.ratioSum += r.ratioForecast14d; slot.ratioN++ }
            if (isFinite(r.utilizationPct))   { slot.utilSum  += r.utilizationPct;   slot.utilN++  }
            if (isFinite(r.ratioGap))         { slot.gapSum   += r.ratioGap;         slot.gapN++   }
        }
        const out = []
        for (const slot of m.values()) {
            out.push({
                key:       slot.key,
                count:     slot.count,
                avgRatio:  slot.ratioN ? slot.ratioSum / slot.ratioN : null,
                avgUtil:   slot.utilN  ? slot.utilSum  / slot.utilN  : null,
                avgGap:    slot.gapN   ? slot.gapSum   / slot.gapN   : null
            })
        }
        out.sort((a, b) => (b.avgGap || 0) - (a.avgGap || 0))
        return out
    }

    function compute(args) {
        const a = args || {}
        const snapshot = a.snapshot || null
        const settings = a.settings || null
        const fleetPlan = a.fleetPlan || null
        const regions = a.regions || null
        if (!snapshot || !Array.isArray(snapshot.fleet)) {
            return {
                ts: Date.now(),
                perAircraft: [],
                rollups: {fleetAvgRatioForecast14d: null, fleetAvgUtilizationPct: null,
                          fleetTargetAvgRatio: null, ratioGapHeadlinePct: null,
                          byType: [], byHub: [], byOrg: [], byRegion: []},
                candidates: {stress: [], slack: []},
                diagnostics: {regressionAircraft: 0, fallbackAircraft: 0, missingFit: 0}
            }
        }

        // Memoization fast-path.
        const memoKey = _memoKey(snapshot, settings, fleetPlan)
        if (_memo && _memo.key === memoKey) return _memo.value

        const perAircraft = []
        let totalRatio = 0, totalRatioN = 0
        let totalUtil  = 0, totalUtilN  = 0
        let totalTarget = 0, totalTargetN = 0
        let regressionAircraft = 0, fallbackAircraft = 0, missingFit = 0

        for (const tail of snapshot.fleet) {
            if (!tail || tail.aircraftId == null) continue
            const wear = tail.wear || {}
            const target = _resolveTarget(tail, settings)
            const planUtil = _planUtilForTail(fleetPlan, tail.aircraftId)
            const weeklyPlanned = planUtil && isFinite(planUtil.weeklyHours)
                ? Number(planUtil.weeklyHours)
                : (isFinite(wear.weeklyHoursLast7d) ? Number(wear.weeklyHoursLast7d) : null)
            const fit = wear.fit || null
            const currentRatio = isFinite(wear.ratio) ? Number(wear.ratio) : null
            const ratioForecast14d = _ratioForecast14d(currentRatio, fit, weeklyPlanned)
            const equilibriumPct = isFinite(wear.equilibriumWeeklyHours) ? null : null
            const ratioGap = (target.targetEquilibriumPct != null && ratioForecast14d != null)
                ? (target.targetEquilibriumPct - ratioForecast14d)
                : null
            const headroomHours = (target.targetWeeklyHours != null && weeklyPlanned != null)
                ? (target.targetWeeklyHours - weeklyPlanned)
                : null
            const utilizationPct = (target.targetWeeklyHours != null
                && target.targetWeeklyHours > 0
                && weeklyPlanned != null)
                ? 100 * weeklyPlanned / target.targetWeeklyHours
                : null
            const classification = _classify(target, ratioGap, headroomHours)
            const rationale = _buildRationale(target, weeklyPlanned, ratioForecast14d, ratioGap)

            // Diagnostic source bucketing
            if (wear.source === "regression") regressionAircraft++
            else if (wear.source === "fallback") fallbackAircraft++
            else if (!fit || !fit.valid) missingFit++

            // Region join (optional)
            let regionId = null, regionName = null
            if (regions && regions instanceof Map && regions.has(String(tail.aircraftId))) {
                const r = regions.get(String(tail.aircraftId))
                regionId = r && r.regionId || null
                regionName = r && r.regionName || null
            } else if (regions && typeof regions === "object" && regions[tail.aircraftId]) {
                const r = regions[tail.aircraftId]
                regionId = r.regionId || null
                regionName = r.regionName || null
            }

            const row = {
                aircraftId:   tail.aircraftId,
                registration: tail.registration || null,
                equipment:    tail.equipment || null,
                typeId:       tail.typeId != null ? Number(tail.typeId) : null,
                hub:          tail.currentLocationIata || tail.homeBase || null,
                org:          tail.org || null,
                regionId,
                regionName,
                currentRatio,
                ratioForecast14d,
                equilibriumPct: isFinite(target.equilibriumWeeklyHours) ? null : null,
                targetEquilibriumPct: target.targetEquilibriumPct,
                ratioGap,
                weeklyHoursPlanned: weeklyPlanned,
                targetWeeklyHours: target.targetWeeklyHours,
                maxWeeklyBlockHours: isFinite(wear.maxWeeklyBlockHours) ? Number(wear.maxWeeklyBlockHours) : null,
                headroomHours,
                utilizationPct,
                classification,
                rationale
            }
            perAircraft.push(row)

            if (isFinite(ratioForecast14d)) { totalRatio += ratioForecast14d; totalRatioN++ }
            if (isFinite(utilizationPct))   { totalUtil  += utilizationPct;   totalUtilN++  }
            if (isFinite(target.targetEquilibriumPct)) { totalTarget += target.targetEquilibriumPct; totalTargetN++ }
        }

        const fleetAvgRatioForecast14d = totalRatioN ? totalRatio / totalRatioN : null
        const fleetAvgUtilizationPct   = totalUtilN  ? totalUtil  / totalUtilN  : null
        const fleetTargetAvgRatio      = totalTargetN ? totalTarget / totalTargetN : null
        const ratioGapHeadlinePct = (fleetTargetAvgRatio != null && fleetAvgRatioForecast14d != null)
            ? (fleetTargetAvgRatio - fleetAvgRatioForecast14d)
            : null

        const stress = perAircraft.filter(r => r.classification === "stress")
            .sort((a, b) => (b.ratioGap || 0) - (a.ratioGap || 0))
            .slice(0, 5)
            .map(r => ({
                aircraftId: r.aircraftId,
                registration: r.registration,
                ratioGap: r.ratioGap,
                suggestion: "Reduce flights or reposition; +" +
                    ((r.ratioGap != null) ? r.ratioGap.toFixed(1) : "?") + "pp gap"
            }))
        const slack = perAircraft.filter(r => r.classification === "cold")
            .sort((a, b) => (b.headroomHours || 0) - (a.headroomHours || 0))
            .slice(0, 5)
            .map(r => ({
                aircraftId: r.aircraftId,
                registration: r.registration,
                headroomHours: r.headroomHours,
                suggestion: "Add flights; ~" +
                    ((r.headroomHours != null) ? Math.round(r.headroomHours) : "?") + "h slack"
            }))

        const result = {
            ts: Date.now(),
            perAircraft,
            rollups: {
                fleetAvgRatioForecast14d,
                fleetAvgUtilizationPct,
                fleetTargetAvgRatio,
                ratioGapHeadlinePct,
                byType:   _byKey(perAircraft, r => r.typeId    != null ? r.typeId    : null)
                              .map(s => ({typeId: s.key, count: s.count, avgRatio: s.avgRatio, avgUtil: s.avgUtil, avgGap: s.avgGap})),
                byHub:    _byKey(perAircraft, r => r.hub       || null)
                              .map(s => ({iata: s.key, count: s.count, avgRatio: s.avgRatio, avgUtil: s.avgUtil, avgGap: s.avgGap})),
                byOrg:    _byKey(perAircraft, r => r.org       || null)
                              .map(s => ({orgId: s.key, count: s.count, avgRatio: s.avgRatio, avgUtil: s.avgUtil, avgGap: s.avgGap})),
                byRegion: _byKey(perAircraft, r => r.regionId  || null)
                              .map(s => ({regionId: s.key, count: s.count, avgRatio: s.avgRatio, avgUtil: s.avgUtil, avgGap: s.avgGap}))
            },
            candidates: {stress, slack},
            diagnostics: {regressionAircraft, fallbackAircraft, missingFit}
        }
        _memo = {key: memoKey, value: result}
        return result
    }

    function clearCache() { _memo = null }

    window.AesStrategyFleetUtilization = {compute, clearCache,
        STRESS_GAP_THRESHOLD_PP, COLD_HEADROOM_HOURS}
})()
