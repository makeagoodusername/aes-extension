"use strict"

/**
 * Lane C — fleet-optimizer settings + per-aircraft target resolver.
 *
 * Settings live inside `settings.strategy.fleetOptimizer` (canopy-aware
 * via the existing AesStrategySettings double-write). Defaults preserve
 * legacy behavior bit-for-bit:
 *
 *   ratioFloorPct:          95         // user comfort floor
 *   headroomPct:            2          // safety margin above floor
 *   underUtilWeight:        0          // §C.3 default 0 = backward-compat
 *   maxRebalancesPerWindow: 3          // §C.5 anti-spiral
 *   perAircraft:            {}         // per-aircraftId overrides
 *   targetingEnabled:       false      // master gate; default OFF
 *   readinessAck:           null       // {ts, settingsHash} two-gate ack
 *
 * `resolveTarget(tail, settings)` is the load-bearing helper. Given a
 * snapshot fleet entry (`{aircraftId, wear: {equilibriumWeeklyHours,...}}`),
 * returns the per-aircraft target shape:
 *
 *   {floorPct, headroomPct, targetEquilibriumPct, targetWeeklyHours}
 *
 * Math (per the approved plan §C.1):
 *
 *   floorPct = perAircraft.floorPct || global.ratioFloorPct
 *   headroomPct = perAircraft.headroomPct || global.headroomPct
 *   targetEquilibriumPct = floorPct + headroomPct
 *   eqWeeklyHours = wear.equilibriumWeeklyHours   (from regression fit)
 *   targetWeeklyHours = max(0, eqWeeklyHours · (1 - headroomPct/100))
 *
 * When the regression is unstable (eq null, slope >= 0), the resolver
 * returns `targetWeeklyHours: null` and consumers classify the tail as
 * `"unknown"` — refusing to propose changes. This is the spiral-guard
 * §4.17 calls for: don't optimize on a fallback fit.
 *
 * Settings hash: a cheap fingerprint of the settings sub-tree. Used by
 * the readinessAck gate so settings changes invalidate the ack and force
 * a re-confirm before the next auto-tick fires.
 */
;(function () {
    if (window.AesStrategyFleetOptimizerSettings) return

    function _defaults() {
        return {
            ratioFloorPct:          95,
            headroomPct:            2,
            underUtilWeight:        0,
            maxRebalancesPerWindow: 3,
            maxFloorRiseInWindow:   1,
            perAircraft:            {},
            targetingEnabled:       false,
            readinessAck:           null,
            apply: {
                enabled:           false,
                dryRunOnly:        true,
                cooldownMinutes:   60,
                maxAppliesPer24h:  6
            }
        }
    }

    function _normaliseApply(raw) {
        const d = _defaults().apply
        const r = (raw && typeof raw === "object") ? raw : {}
        const cd = Number(r.cooldownMinutes)
        const mx = Number(r.maxAppliesPer24h)
        return {
            enabled:           r.enabled === true,
            dryRunOnly:        r.dryRunOnly !== false,
            cooldownMinutes:   (isFinite(cd) && cd >= 0  && cd <= 1440) ? cd : d.cooldownMinutes,
            maxAppliesPer24h:  (isFinite(mx) && mx >= 0  && mx <= 200)  ? mx : d.maxAppliesPer24h
        }
    }

    function _normalise(raw) {
        const d = _defaults()
        const r = (raw && typeof raw === "object") ? raw : {}
        const fpc = Number(r.ratioFloorPct)
        const hpc = Number(r.headroomPct)
        const uw  = Number(r.underUtilWeight)
        const mrw = Number(r.maxRebalancesPerWindow)
        const mfr = Number(r.maxFloorRiseInWindow)
        return {
            ratioFloorPct:          (isFinite(fpc) && fpc >= 50 && fpc <= 100) ? fpc : d.ratioFloorPct,
            headroomPct:            (isFinite(hpc) && hpc >= 0  && hpc <= 20)  ? hpc : d.headroomPct,
            underUtilWeight:        (isFinite(uw)  && uw  >= 0  && uw  <= 100000) ? uw : d.underUtilWeight,
            maxRebalancesPerWindow: (isFinite(mrw) && mrw >= 0  && mrw <= 50)  ? mrw : d.maxRebalancesPerWindow,
            maxFloorRiseInWindow:   (isFinite(mfr) && mfr >= 0  && mfr <= 10)  ? mfr : d.maxFloorRiseInWindow,
            perAircraft:            (r.perAircraft && typeof r.perAircraft === "object") ? r.perAircraft : {},
            targetingEnabled:       r.targetingEnabled === true,
            readinessAck:           (r.readinessAck && typeof r.readinessAck === "object") ? r.readinessAck : null,
            apply:                  _normaliseApply(r.apply)
        }
    }

    async function load() {
        if (typeof window.AesStrategySettings === "undefined") return _defaults()
        try {
            const block = await window.AesStrategySettings.load()
            return _normalise(block && block.fleetOptimizer)
        } catch (_) { return _defaults() }
    }

    async function save(partial) {
        if (typeof window.AesStrategySettings === "undefined") return _defaults()
        const before = await load()
        const next = _normalise(Object.assign({}, before, partial || {}))
        await window.AesStrategySettings.save({fleetOptimizer: next})
        try {
            if (window.CentralHubBus) window.CentralHubBus.emit("fleet-optimizer:target-changed",
                {before, after: next, changedKeys: Object.keys(partial || {})})
            if (window.AesStrategy && window.AesStrategy.bus) {
                window.AesStrategy.bus.emit("fleet-optimizer:target-changed",
                    {before, after: next, changedKeys: Object.keys(partial || {})})
            }
        } catch (_) {}
        return next
    }

    /**
     * Per-aircraft target resolution. Pure (no DOM, no I/O). Caller
     * passes the snapshot-fleet entry plus the loaded settings block.
     */
    function resolveTarget(tail, settings) {
        const s = _normalise(settings || {})
        const aid = tail && (tail.aircraftId != null) ? String(tail.aircraftId) : null
        const ovr = (aid && s.perAircraft[aid]) || {}
        const floorPct  = isFinite(Number(ovr.floorPct))   ? Number(ovr.floorPct)   : s.ratioFloorPct
        const headPct   = isFinite(Number(ovr.headroomPct)) ? Number(ovr.headroomPct) : s.headroomPct
        const excl      = ovr.excludeFromOptimizer === true
        const wear      = (tail && tail.wear) || null
        const eq        = wear && isFinite(Number(wear.equilibriumWeeklyHours))
            ? Number(wear.equilibriumWeeklyHours) : null
        let targetWeeklyHours = null
        if (!excl && eq != null && eq > 0) {
            targetWeeklyHours = Math.max(0, eq * (1 - headPct / 100))
        }
        return {
            floorPct,
            headroomPct:          headPct,
            targetEquilibriumPct: floorPct + headPct,
            targetWeeklyHours,
            equilibriumWeeklyHours: eq,
            excluded: excl,
            unknown: !excl && (eq == null || eq <= 0)
        }
    }

    /**
     * Cheap fingerprint of the settings sub-tree. Stable across reloads
     * (sorted JSON over a small schema). Used by readinessAck to detect
     * silent drift without storing every prior settings snapshot.
     */
    function settingsHash(settings) {
        const s = _normalise(settings || {})
        const slim = {
            f:  s.ratioFloorPct,
            h:  s.headroomPct,
            u:  s.underUtilWeight,
            mr: s.maxRebalancesPerWindow,
            mf: s.maxFloorRiseInWindow,
            t:  s.targetingEnabled,
            ae: s.apply.enabled,
            ad: s.apply.dryRunOnly,
            ac: s.apply.cooldownMinutes,
            am: s.apply.maxAppliesPer24h,
            pa: s.perAircraft  // shallow — ok for fingerprint
        }
        // Stable JSON.stringify with sorted keys for the perAircraft map.
        const paKeys = Object.keys(slim.pa).sort()
        slim.pa = paKeys.map(k => k + ":" + JSON.stringify(slim.pa[k])).join("|")
        return JSON.stringify(slim)
    }

    function ackReadiness(settings) {
        return {ts: Date.now(), settingsHash: settingsHash(settings)}
    }

    function isAckValid(settings) {
        if (!settings || !settings.readinessAck) return false
        return settings.readinessAck.settingsHash === settingsHash(settings)
    }

    window.AesStrategyFleetOptimizerSettings = {
        load, save,
        resolveTarget, settingsHash,
        ackReadiness, isAckValid,
        defaults: _defaults
    }
})()
