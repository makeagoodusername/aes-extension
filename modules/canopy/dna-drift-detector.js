"use strict"

/**
 * Letter L slice L5 — DNA drift detector.
 *
 * Diff observed account state against the effective DNA. Returns a per-dim
 * report with `aligned / drifting / misaligned` status + delta + a one-line
 * message suitable for tile rendering.
 *
 * Two halves:
 *   - `diffObservedAgainstEffective(observed, effectiveDna)` — pure
 *   - `observedStateFor(accountId)`                          — reads storage
 *     (best-effort; missing data degrades the corresponding dim to "no data")
 *
 * Enum dims (networkShape, tempo, brandStance) are flagged "subjective —
 * review manually" because they're not reliably derivable from observation
 * in v1. The report still includes them so the editor can prompt.
 */
;(function () {
    if (window.AesCanopyDnaDrift) return

    const STATUS_ALIGNED    = "aligned"
    const STATUS_DRIFTING   = "drifting"
    const STATUS_MISALIGNED = "misaligned"
    const STATUS_NODATA     = "no-data"
    const STATUS_SUBJECTIVE = "subjective"

    function _clamp01(x) { return !isFinite(x) ? 0 : (x < 0 ? 0 : (x > 1 ? 1 : x)) }

    function _statusForContribution(c) {
        if (c == null) return STATUS_NODATA
        if (c >= 0.8)  return STATUS_ALIGNED
        if (c >= 0.5)  return STATUS_DRIFTING
        return STATUS_MISALIGNED
    }

    function _shareDelta(target, observed) {
        const keys = Object.keys(target || {})
        let sum = 0, any = false
        for (const k of keys) {
            const tv = Number(target[k]), ov = Number(observed && observed[k])
            if (!isFinite(tv) || !isFinite(ov)) continue
            sum += Math.abs(tv - ov)
            any = true
        }
        return any ? sum : null
    }

    function _shareMessage(label, target, observed) {
        const keys = Object.keys(target || {})
        const worst = keys.map(k => {
            const tv = Number(target[k]) || 0, ov = Number(observed && observed[k]) || 0
            return {k, delta: Math.abs(tv - ov), tv, ov}
        }).sort((a, b) => b.delta - a.delta)
        if (!worst.length || worst[0].delta < 0.05) return label + " roughly aligned"
        const w = worst[0]
        return label + ": observed " + w.k + " " + Math.round(w.ov * 100) + "% vs target " + Math.round(w.tv * 100) + "%"
    }

    function diffObservedAgainstEffective(observed, effectiveDna, opts) {
        const accountId = (opts && opts.accountId) || null
        const DIMS = (window.AesCanopyDnaStore && window.AesCanopyDnaStore.DIMENSIONS) || []
        const W = (window.AesCanopyDnaStore && window.AesCanopyDnaStore.WEIGHTS) || {}

        const dimensions = []
        let weightUsed = 0
        let weightedScore = 0

        for (const d of DIMS) {
            const target = effectiveDna ? effectiveDna[d.key] : null
            const obs = observed ? observed[d.key] : null

            // Subjective enum dims — flag but don't score, leave the user to decide
            if (d.kind === "enum" && (d.key === "networkShape" || d.key === "tempo" || d.key === "brandStance")) {
                dimensions.push({
                    dimName:       d.key,
                    label:         d.label,
                    status:        STATUS_SUBJECTIVE,
                    observedValue: obs == null ? null : obs,
                    targetValue:   target,
                    deltaPct:      null,
                    message:       d.label + " is subjective — review manually"
                })
                continue
            }

            // Risk profile — observed is the strategy setting, if mirrored
            if (d.key === "riskProfile") {
                const RISK = ["conservative", "balanced", "aggressive"]
                const a = RISK.indexOf(target), b = RISK.indexOf(obs)
                if (a < 0 || b < 0) {
                    dimensions.push({dimName: d.key, label: d.label, status: STATUS_NODATA, observedValue: obs, targetValue: target, deltaPct: null, message: "no observation"})
                    continue
                }
                const dist = Math.abs(a - b)
                const c = dist === 0 ? 1 : (dist === 1 ? 0.5 : 0)
                const status = _statusForContribution(c)
                dimensions.push({
                    dimName: d.key, label: d.label, status,
                    observedValue: obs, targetValue: target,
                    deltaPct: dist === 0 ? 0 : (dist * 50),
                    message: status === STATUS_ALIGNED ? "match" : (status === STATUS_DRIFTING ? "adjacent (" + obs + " vs " + target + ")" : "opposite (" + obs + " vs " + target + ")")
                })
                weightUsed += (Number(W[d.key]) || 0)
                weightedScore += (Number(W[d.key]) || 0) * c
                continue
            }

            if (d.kind === "number") {
                if (!isFinite(target) || !isFinite(obs)) {
                    dimensions.push({dimName: d.key, label: d.label, status: STATUS_NODATA, observedValue: obs, targetValue: target, deltaPct: null, message: "no observation"})
                    continue
                }
                const span = Math.max(Math.abs(target), 0.6)
                const c = _clamp01(1 - Math.abs(target - obs) / span)
                const deltaPct = Math.round(Math.abs(target - obs) / Math.max(target || 1, 0.01) * 100)
                const status = _statusForContribution(c)
                dimensions.push({
                    dimName: d.key, label: d.label, status,
                    observedValue: obs, targetValue: target,
                    deltaPct, message: d.label + " observed " + obs.toFixed(2) + " vs target " + Number(target).toFixed(2)
                })
                weightUsed += (Number(W[d.key]) || 0)
                weightedScore += (Number(W[d.key]) || 0) * c
                continue
            }

            if (d.kind === "object") {
                const delta = _shareDelta(target, obs)
                if (delta == null) {
                    dimensions.push({dimName: d.key, label: d.label, status: STATUS_NODATA, observedValue: obs, targetValue: target, deltaPct: null, message: "no observation"})
                    continue
                }
                const c = _clamp01(1 - delta / 2)
                const status = _statusForContribution(c)
                dimensions.push({
                    dimName: d.key, label: d.label, status,
                    observedValue: obs, targetValue: target,
                    deltaPct: Math.round(delta * 100),
                    message: _shareMessage(d.label, target, obs)
                })
                weightUsed += (Number(W[d.key]) || 0)
                weightedScore += (Number(W[d.key]) || 0) * c
                continue
            }
        }

        const driftScore = weightUsed > 0 ? _clamp01(weightedScore / weightUsed) : 0
        return {accountId, computedAt: Date.now(), driftScore, dimensions}
    }

    /**
     * Build the observed-state record for one account, best-effort. Missing
     * inputs degrade gracefully — each dim is filled only if the underlying
     * read succeeds.
     */
    async function observedStateFor(accountId) {
        const observed = {}
        if (!accountId) return observed

        // Fleet-derived dims: serviceMix, manufacturerPrefs, sizeMixTargets, cargoEmphasis
        try {
            if (window.AesFleetRoster && typeof window.AesFleetRoster.get === "function") {
                const roster = await window.AesFleetRoster.get(accountId)
                const fleetView = _fleetView(roster)
                if (fleetView.totalSeats > 0) {
                    observed.serviceMix = fleetView.serviceMix
                    observed.cargoEmphasis = fleetView.cargoShare
                }
                if (fleetView.totalTails > 0) {
                    observed.manufacturerPrefs = fleetView.manufacturerShare
                    observed.sizeMixTargets = fleetView.sizeShare
                }
                if (fleetView.totalTails > 0 && fleetView.weeklyGrowthRate != null) {
                    observed.growthPosture = {
                        newRoutesPerWeekTarget: fleetView.newRoutesPerWeek || 0,
                        fleetGrowthRatePerYear: fleetView.weeklyGrowthRate * 52
                    }
                }
            }
        } catch (_) {}

        // Country focus from topRoutes cache (per-account scoped key)
        try {
            const k = (window.acctKeyForAccount ? window.acctKeyForAccount("routeAssistant:topRoutes", accountId) : null)
            if (k) {
                const out = await chrome.storage.local.get([k])
                const rec = out[k]
                const country = _topRoutesCountryShare(rec)
                if (country) observed.countryFocus = country
            }
        } catch (_) {}

        // Risk profile mirror — strategy settings if present
        try {
            const out = await chrome.storage.local.get(["settings"])
            const rp = out.settings && out.settings.strategy && out.settings.strategy.riskProfile
            if (typeof rp === "string") observed.riskProfile = rp
        } catch (_) {}

        return observed
    }

    function _fleetView(roster) {
        const out = {totalTails: 0, totalSeats: 0, serviceMix: null, cargoShare: 0, manufacturerShare: null, sizeShare: null, weeklyGrowthRate: null, newRoutesPerWeek: 0}
        const tails = (roster && Array.isArray(roster.tails)) ? roster.tails : (Array.isArray(roster) ? roster : [])
        if (!tails.length) return out
        const mfg = {Boeing: 0, Airbus: 0, Embraer: 0, Other: 0}
        const size = {regional: 0, narrowbody: 0, widebody: 0}
        let yS = 0, cS = 0, fS = 0
        let cargoTails = 0
        for (const t of tails) {
            out.totalTails++
            const m = _normManufacturer(t.manufacturer || (t.type && t.type.manufacturer) || t.typeName || "")
            mfg[m] = (mfg[m] || 0) + 1
            const sc = _classifySize(t)
            if (sc) size[sc] = (size[sc] || 0) + 1
            const seats = t.seatsByClass || (t.type && t.type.seatsByClass) || null
            if (seats) {
                yS += Number(seats.Y) || 0
                cS += Number(seats.C) || 0
                fS += Number(seats.F) || 0
            }
            if (_isCargo(t)) cargoTails++
        }
        out.totalSeats = yS + cS + fS
        if (out.totalSeats > 0) {
            out.serviceMix = {Y: yS / out.totalSeats, C: cS / out.totalSeats, F: fS / out.totalSeats}
        }
        out.cargoShare = out.totalTails > 0 ? cargoTails / out.totalTails : 0
        out.manufacturerShare = _normalize(mfg)
        out.sizeShare = _normalize(size)
        return out
    }

    function _normalize(map) {
        let total = 0
        for (const k in map) total += Number(map[k]) || 0
        if (total === 0) return null
        const out = {}
        for (const k in map) out[k] = (Number(map[k]) || 0) / total
        return out
    }

    function _normManufacturer(raw) {
        const s = String(raw || "").toLowerCase()
        if (s.indexOf("boeing")  >= 0) return "Boeing"
        if (s.indexOf("airbus")  >= 0) return "Airbus"
        if (s.indexOf("embraer") >= 0) return "Embraer"
        return "Other"
    }

    function _classifySize(tail) {
        if (window.AesCanopyRoleDetector) {
            try {
                if (window.AesCanopyRoleDetector._isWideBody && window.AesCanopyRoleDetector._isWideBody(tail)) return "widebody"
                if (window.AesCanopyRoleDetector._isRegional && window.AesCanopyRoleDetector._isRegional(tail)) return "regional"
            } catch (_) {}
        }
        return "narrowbody"
    }

    function _isCargo(tail) {
        if (window.AesCanopyRoleDetector && window.AesCanopyRoleDetector._isCargo) {
            try { return !!window.AesCanopyRoleDetector._isCargo(tail) } catch (_) {}
        }
        const s = String((tail && (tail.type || tail.typeName || "")) || "").toLowerCase()
        return s.indexOf("cargo") >= 0 || s.indexOf("freighter") >= 0
    }

    function _topRoutesCountryShare(rec) {
        const rows = rec && (Array.isArray(rec.routes) ? rec.routes : Array.isArray(rec) ? rec : null)
        if (!rows || !rows.length) return null
        let dom = 0, cont = 0, inter = 0, total = 0
        for (const r of rows) {
            const oc = r.originCountry || (r.origin && r.origin.country)
            const dc = r.destCountry   || (r.dest   && r.dest.country)
            const oContinent = r.originContinent
            const dContinent = r.destContinent
            if (!oc || !dc) continue
            total++
            if (oc === dc) dom++
            else if (oContinent && oContinent === dContinent) cont++
            else inter++
        }
        if (!total) return null
        return {
            domesticShare:    dom / total,
            continentalShare: cont / total,
            intercontShare:   inter / total
        }
    }

    window.AesCanopyDnaDrift = {
        STATUS_ALIGNED, STATUS_DRIFTING, STATUS_MISALIGNED, STATUS_NODATA, STATUS_SUBJECTIVE,
        diffObservedAgainstEffective,
        observedStateFor
    }
})()
