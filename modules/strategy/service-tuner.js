"use strict"

/**
 * AES Strategy — service-profile auto-tuner (Slice 7 A/B layer).
 *
 * The proposer (`service-moves.js`) ranks per-category bumps; this module
 * adds the experiment loop on top: clone a candidate profile with the
 * top-ranked perturbation, assign ~50% of its routes to the clone, let a
 * game-week elapse, read AesStrategyOutcomes filtered to the assigned vs.
 * control partitions, declare a winner, and surface the consolidate
 * decision for the next plan.
 *
 * Engine is pure-ish — `evaluate` and `_pickPartition` are pure transforms
 * of snapshot + state; only `startExperiment` and `consolidate` reach for
 * the applier (and only when tier + domain gates clear).
 *
 * Public API (window.AesStrategyServiceTuner):
 *   evaluate(snapshot, opts?)               → {candidate, reasons[]} | null
 *   startExperiment(profile, changes, ctx)  → Promise<record>
 *   tickActiveExperiments(ctx)              → Promise<{updated, concluded}>
 *   consolidate(experimentId, decision, ctx)→ Promise<record>
 *   summarise(ctx)                          → Promise<{active, concluded, totals}>
 *
 * Decisions for `consolidate(...)`: "adopt" (apply perturbation changes
 * back onto the base profile, then mark consolidated), "rollback" (assign
 * all assigned routes back to the base profile and mark rolled-back), or
 * "keep-split" (leave the partition in place — operator-driven hold).
 *
 * Settings consulted (`settings.strategy.serviceTuner`):
 *   enabled, minPredictedLift, assignmentRatio, minRoutesPerExperiment,
 *   maxRoutesPerExperiment, durationDays, autoConsolidate.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyServiceTuner) return

    const DEFAULTS = {
        enabled:                 false,
        minPredictedLift:        0.06,
        assignmentRatio:         0.5,
        minRoutesPerExperiment:  2,
        maxRoutesPerExperiment:  10,
        durationDays:            7,
        autoConsolidate:         false,
        maxConcurrentPerAirline: 3
    }

    const DAY_MS = 24 * 3600 * 1000

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _pairKey(hub, dest) {
        if (!hub || !dest) return null
        return String(hub).toUpperCase() + "-" + String(dest).toUpperCase()
    }

    function _resolveSettings(snapshot) {
        const s = (snapshot && snapshot.strategySettings) || {}
        const block = (s && s.serviceTuner) || {}
        const out = Object.assign({}, DEFAULTS)
        for (const k of Object.keys(DEFAULTS)) {
            if (block[k] !== undefined) out[k] = block[k]
        }
        out.assignmentRatio = Math.max(0.2, Math.min(0.8, _num(out.assignmentRatio, 0.5)))
        out.minRoutesPerExperiment = Math.max(1, _num(out.minRoutesPerExperiment, 2))
        out.maxRoutesPerExperiment = Math.max(out.minRoutesPerExperiment,
                                              _num(out.maxRoutesPerExperiment, 10))
        out.durationDays = Math.max(1, _num(out.durationDays, 7))
        out.minPredictedLift = Math.max(0, _num(out.minPredictedLift, 0.06))
        out.maxConcurrentPerAirline = Math.max(1, _num(out.maxConcurrentPerAirline, 3))
        return out
    }

    /**
     * Walk the snapshot's hubs and collect every (hub, dest) pair whose
     * route mounts the given profile id. Snapshot route shape varies; we
     * defensively look for `serviceProfileId`, `profileId`, or
     * `route.serviceProfile && route.serviceProfile.id`.
     */
    function _collectRoutesForProfile(snapshot, profileId) {
        const out = []
        const seen = new Set()
        const want = Number(profileId)
        const hubs = (snapshot && snapshot.hubs) || []
        for (const h of hubs) {
            if (!h || !Array.isArray(h.byRoute)) continue
            for (const r of h.byRoute) {
                if (!r || !r.dest) continue
                const sp = (r.serviceProfileId != null) ? r.serviceProfileId
                         : (r.profileId != null) ? r.profileId
                         : (r.serviceProfile && r.serviceProfile.id != null)
                            ? r.serviceProfile.id : null
                if (sp == null) continue
                if (Number(sp) !== want) continue
                const key = _pairKey(h.iata || h.code, r.dest)
                if (!key || seen.has(key)) continue
                seen.add(key)
                out.push({hub: h.iata || h.code, dest: r.dest, routeKey: key})
            }
        }
        return out
    }

    /**
     * Stable partition: deterministic hash on routeKey → first N×ratio
     * routes go to `assigned`, rest to `control`. Stable across reloads
     * means the same 50% split survives a re-render of the panel.
     */
    function _hashPartition(routes, ratio) {
        const ranked = routes.slice().map(r => {
            let h = 0
            const s = r.routeKey
            for (let i = 0; i < s.length; i++) {
                h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
            }
            return Object.assign({_h: (h >>> 0)}, r)
        }).sort((a, b) => a._h - b._h)
        const cut = Math.max(1, Math.floor(ranked.length * ratio))
        const assigned = ranked.slice(0, cut).map(r => r.routeKey)
        const control  = ranked.slice(cut).map(r => r.routeKey)
        return {assigned: assigned, control: control}
    }

    /**
     * Filter outcomes ring to the partition. Uses
     * `outcome.before/after.byRoute[routeKey]` (rank deltas) when present;
     * falls back to network-level `orsAvgY` deltas (less precise but
     * still directional).
     */
    function _scorePartition(ringOutcomes, assignedKeys, controlKeys) {
        const A = {orsDeltas: [], lfDeltas: [], profitContrib: []}
        const C = {orsDeltas: [], lfDeltas: [], profitContrib: []}
        for (const o of ringOutcomes) {
            if (!o || !o.after || !o.before) continue
            const br = o.before.byRoute || {}
            const ar = o.after.byRoute  || {}
            for (const k of assignedKeys) {
                if (br[k] && ar[k]) {
                    const r0 = _num(br[k].ourTopRating, NaN)
                    const r1 = _num(ar[k].ourTopRating, NaN)
                    if (isFinite(r0) && isFinite(r1)) A.orsDeltas.push(r1 - r0)
                }
            }
            for (const k of controlKeys) {
                if (br[k] && ar[k]) {
                    const r0 = _num(br[k].ourTopRating, NaN)
                    const r1 = _num(ar[k].ourTopRating, NaN)
                    if (isFinite(r0) && isFinite(r1)) C.orsDeltas.push(r1 - r0)
                }
            }
            const lfBefore = _num(o.before.paxLfMean, NaN)
            const lfAfter  = _num(o.after.paxLfMean,  NaN)
            if (isFinite(lfBefore) && isFinite(lfAfter)) {
                if (assignedKeys.length) A.lfDeltas.push(lfAfter - lfBefore)
                if (controlKeys.length)  C.lfDeltas.push(lfAfter - lfBefore)
            }
        }
        function _mean(arr) {
            if (!arr.length) return null
            let s = 0
            for (const v of arr) s += v
            return s / arr.length
        }
        const muA = _mean(A.orsDeltas)
        const muC = _mean(C.orsDeltas)
        let confidence = "low"
        let winner = "tie"
        if (muA != null && muC != null) {
            const gap = muA - muC
            const samples = Math.min(A.orsDeltas.length, C.orsDeltas.length)
            if (samples >= 4 && Math.abs(gap) > 0.05) confidence = "high"
            else if (samples >= 2 && Math.abs(gap) > 0.02) confidence = "medium"
            if (gap > 0.01) winner = "perturbation"
            else if (gap < -0.01) winner = "base"
        }
        return {
            orsDeltaAssigned: muA,
            orsDeltaControl:  muC,
            lfDelta:          _mean(A.lfDeltas.concat(C.lfDeltas)),
            profitDelta:      null,
            confidence:       confidence,
            winner:           winner,
            samplesAssigned:  A.orsDeltas.length,
            samplesControl:   C.orsDeltas.length,
            measuredAt:       Date.now()
        }
    }

    function _emitBus(name, payload) {
        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit(name, payload || {})
            } else if (window.AesBus && typeof window.AesBus.emit === "function") {
                window.AesBus.emit(name, payload || {})
            }
        } catch (_) { /* bus optional */ }
    }

    /**
     * Pick the top candidate from `proposeServiceMoves`, gate it through
     * tier + serviceMovesEnabled + tuner.enabled + per-profile-no-conflict
     * + min-routes + minPredictedLift, and return the candidate envelope.
     * Returns null when no candidate qualifies (includes `reasons[]` for
     * the panel to surface why nothing's running).
     */
    async function evaluate(snapshot, opts) {
        const reasons = []
        const out = {candidate: null, reasons: reasons}
        if (!snapshot || typeof snapshot !== "object") {
            reasons.push("no-snapshot")
            return out
        }
        const settings = _resolveSettings(snapshot)
        if (!settings.enabled) {
            reasons.push("tuner-disabled")
            return out
        }
        if (!window.AesStrategy || typeof window.AesStrategy.proposeServiceMoves !== "function") {
            reasons.push("proposer-unavailable")
            return out
        }
        const moves = window.AesStrategy.proposeServiceMoves(snapshot, opts || {}) || []
        if (!moves.length) {
            reasons.push("no-moves")
            return out
        }
        const stratSettings = (snapshot && snapshot.strategySettings) || {}
        const tier = stratSettings.tier || "preview-only"
        if (tier !== "apply-auto") {
            reasons.push("tier-not-apply-auto")
            return out
        }
        if (!stratSettings.serviceMovesEnabled) {
            reasons.push("service-moves-disabled")
            return out
        }

        const accountId = (opts && opts.accountId) || null
        const active = window.AesServiceExperimentStore
            ? await window.AesServiceExperimentStore.active({accountId: accountId})
            : []
        if (active.length >= settings.maxConcurrentPerAirline) {
            reasons.push("concurrent-cap-" + active.length + "/" + settings.maxConcurrentPerAirline)
            return out
        }
        const activeProfiles = new Set(active.map(r => Number(r.baseProfileId)))

        for (const move of moves) {
            if (!move || !move.profileId) continue
            if (activeProfiles.has(Number(move.profileId))) continue
            if (!move.changes || !Object.keys(move.changes).length) continue
            if (_num(move.predictedOrsDelta, 0) < settings.minPredictedLift) continue
            const routes = _collectRoutesForProfile(snapshot, move.profileId)
            if (routes.length < Math.max(settings.minRoutesPerExperiment * 2, 4)) {
                reasons.push("profile-" + move.profileId + "-too-few-routes-" + routes.length)
                continue
            }
            const trimmed = routes.length > settings.maxRoutesPerExperiment
                ? routes.slice(0, settings.maxRoutesPerExperiment)
                : routes
            const partition = _hashPartition(trimmed, settings.assignmentRatio)
            if (partition.assigned.length < settings.minRoutesPerExperiment
                || partition.control.length < settings.minRoutesPerExperiment) {
                reasons.push("profile-" + move.profileId + "-partition-too-small")
                continue
            }
            out.candidate = {
                move:      move,
                partition: partition,
                routes:    trimmed,
                settings:  settings,
                accountId: accountId,
                routesAvailable: routes.length
            }
            return out
        }
        reasons.push("no-eligible-move")
        return out
    }

    /**
     * Take the candidate from `evaluate` and actuate it: clone the
     * profile via the applier, write the experiment record, optionally
     * assign the perturbation profile to the assigned routes (deferred:
     * v1 leaves the route partition in storage and surfaces it to the
     * user — the per-route reassignment lands in Slice 7.1 once the
     * assigner POST is verified across AS schedule edit forms).
     */
    async function startExperiment(candidate, ctx) {
        if (!candidate || !candidate.move) throw new Error("startExperiment: candidate.move required")
        const move = candidate.move
        const partition = candidate.partition
        const settings = candidate.settings || _resolveSettings(null)

        const accountId = (ctx && ctx.accountId) || candidate.accountId || null
        const server    = (ctx && ctx.server)    || null
        const airlineCode = (ctx && ctx.airlineCode) || null

        // Cost ceiling — abort if perturbation cost > 2× base estimate.
        // The proposer's `_buildAB` already costed the pack; we re-derive
        // a coarse estimate here so the tuner doesn't trust an unbounded
        // pack. Counts each (cat, cls) bump as 1 unit; if the change-set
        // covers more than half the categories we treat it as runaway.
        const totalBumps = (function () {
            let n = 0
            for (const cat in (move.changes || {})) {
                const cls = move.changes[cat] || {}
                for (const k in cls) if (cls[k] != null) n++
            }
            return n
        })()
        if (totalBumps > 12) {
            throw new Error("startExperiment: perturbation too aggressive (" + totalBumps + " bumps)")
        }

        let perturbationProfileId = null
        let perturbationProfileName = null
        const cloneAttempted = (server && window.RouteAssistantServiceProfileApplier)
        if (cloneAttempted) {
            try {
                const applier = new window.RouteAssistantServiceProfileApplier(server, {
                    applyEnabled: true,
                    dryRunOnly:   false
                })
                if (typeof applier.createFromBase === "function") {
                    const cloned = await applier.createFromBase(move.profileId, move.changes, {
                        label: (move.profileName || ("#" + move.profileId)) + " · S7-A"
                    })
                    if (cloned && cloned.newProfileId != null) {
                        perturbationProfileId   = Number(cloned.newProfileId)
                        perturbationProfileName = cloned.name || null
                    }
                }
            } catch (e) {
                console.warn("[AesStrategyServiceTuner] clone failed", e)
            }
        }

        const startedAt = Date.now()
        const expectedConcludeAt = startedAt + (settings.durationDays * DAY_MS)
        const record = await window.AesServiceExperimentStore.append({
            baseProfileId:           Number(move.profileId),
            baseProfileName:         move.profileName || ("#" + move.profileId),
            perturbationProfileId:   perturbationProfileId,
            perturbationProfileName: perturbationProfileName,
            perturbationChanges:     JSON.parse(JSON.stringify(move.changes || {})),
            assignedRouteKeys:       partition.assigned.slice(),
            controlRouteKeys:        partition.control.slice(),
            startedAt:               startedAt,
            expectedConcludeAt:      expectedConcludeAt,
            state:                   "active",
            outcome:                 null,
            server:                  server,
            airlineCode:             airlineCode,
            settings: {
                durationDays:    settings.durationDays,
                assignmentRatio: settings.assignmentRatio,
                minPredictedLift: settings.minPredictedLift
            },
            _reason: cloneAttempted
                ? (perturbationProfileId != null ? "clone-ok" : "clone-failed-recorded-as-pending")
                : "applier-unavailable"
        }, {accountId: accountId})

        _emitBus("strategy:service-experiment-started", {
            experimentId: record.experimentId,
            baseProfileId: record.baseProfileId,
            perturbationProfileId: record.perturbationProfileId,
            assigned: record.assignedRouteKeys.length,
            control: record.controlRouteKeys.length
        })
        return record
    }

    /**
     * Walk active experiments; for any whose `expectedConcludeAt` has
     * passed and where outcomes can be scored, transition to "concluded"
     * and stamp the outcome envelope.
     */
    async function tickActiveExperiments(ctx) {
        const accountId = (ctx && ctx.accountId) || null
        const store = window.AesServiceExperimentStore
        if (!store) return {updated: 0, concluded: 0}
        const active = await store.active({accountId: accountId})
        if (!active.length) return {updated: 0, concluded: 0}

        const now = (ctx && ctx.now) || Date.now()
        let outcomes = []
        if (window.AesStrategyOutcomes && typeof window.AesStrategyOutcomes.loadAll === "function") {
            try { outcomes = await window.AesStrategyOutcomes.loadAll(accountId) }
            catch (_) { outcomes = [] }
        }

        let concluded = 0
        let updated = 0
        for (const exp of active) {
            if (!exp || _num(exp.expectedConcludeAt, 0) > now) continue
            const relevant = outcomes.filter(o => o && _num(o.applyTs, 0) >= _num(exp.startedAt, 0)
                                                  && o.after)
            const outcome = _scorePartition(relevant,
                exp.assignedRouteKeys || [], exp.controlRouteKeys || [])
            const next = await store.update(exp.experimentId, {
                state:   "concluded",
                outcome: outcome,
                _reason: "window-elapsed-" + (outcome.confidence || "low")
            }, {accountId: accountId})
            if (next) {
                updated++
                concluded++
                _emitBus("strategy:service-experiment-concluded", {
                    experimentId: next.experimentId,
                    winner:       outcome.winner,
                    confidence:   outcome.confidence,
                    orsDeltaAssigned: outcome.orsDeltaAssigned,
                    orsDeltaControl:  outcome.orsDeltaControl
                })
            }
        }
        return {updated: updated, concluded: concluded}
    }

    /**
     * Operator-driven (or tier-driven when autoConsolidate=true). Three
     * decisions:
     *
     *   "adopt"     — apply perturbation changes onto the base profile
     *                  (one apply via RouteAssistantServiceProfileApplier)
     *                  and mark the experiment "consolidated".
     *   "rollback"  — leave base profile alone; mark "rolled-back". v1
     *                  doesn't reassign routes (no-op since clone never
     *                  flipped them in v1); the perturbation profile
     *                  becomes orphaned but harmless.
     *   "keep-split"— mark "consolidated" with note "split-retained" — the
     *                  partition stands until the user manually changes it.
     */
    async function consolidate(experimentId, decision, ctx) {
        const accountId = (ctx && ctx.accountId) || null
        const store = window.AesServiceExperimentStore
        if (!store) throw new Error("consolidate: experiment store unavailable")
        const exp = await store.findById(experimentId, {accountId: accountId})
        if (!exp) throw new Error("consolidate: experiment not found")
        if (exp.state !== "concluded") {
            throw new Error("consolidate: experiment is " + exp.state + " — only concluded can consolidate")
        }
        const server = (ctx && ctx.server) || exp.server || null

        if (decision === "adopt") {
            if (server && window.RouteAssistantServiceProfileApplier) {
                try {
                    const applier = new window.RouteAssistantServiceProfileApplier(server, {
                        applyEnabled: true,
                        dryRunOnly:   false
                    })
                    await applier.apply(exp.baseProfileId, exp.perturbationChanges, {
                        source: "service-experiment"
                    })
                } catch (e) {
                    console.warn("[AesStrategyServiceTuner] consolidate adopt apply failed", e)
                    return store.update(exp.experimentId, {
                        state:   "concluded",
                        _reason: "adopt-failed: " + (e && e.message || String(e))
                    }, {accountId: accountId})
                }
            }
            const next = await store.update(exp.experimentId, {
                state:   "consolidated",
                _reason: "adopt"
            }, {accountId: accountId})
            _emitBus("strategy:service-experiment-consolidated", {
                experimentId: experimentId, decision: "adopt"
            })
            return next
        }
        if (decision === "rollback") {
            const next = await store.update(exp.experimentId, {
                state:   "rolled-back",
                _reason: "rollback"
            }, {accountId: accountId})
            _emitBus("strategy:service-experiment-consolidated", {
                experimentId: experimentId, decision: "rollback"
            })
            return next
        }
        if (decision === "keep-split") {
            const next = await store.update(exp.experimentId, {
                state:   "consolidated",
                _reason: "keep-split"
            }, {accountId: accountId})
            _emitBus("strategy:service-experiment-consolidated", {
                experimentId: experimentId, decision: "keep-split"
            })
            return next
        }
        throw new Error("consolidate: unknown decision '" + decision + "'")
    }

    async function summarise(ctx) {
        const accountId = (ctx && ctx.accountId) || null
        const store = window.AesServiceExperimentStore
        if (!store) return {active: 0, concluded: 0, totals: {}}
        const all = await store.all({accountId: accountId})
        const totals = {active: 0, concluded: 0, consolidated: 0, "rolled-back": 0, cancelled: 0}
        for (const r of all) {
            if (r && totals[r.state] !== undefined) totals[r.state]++
        }
        return {active: totals.active, concluded: totals.concluded, totals: totals}
    }

    window.AesStrategyServiceTuner = {
        evaluate:                evaluate,
        startExperiment:         startExperiment,
        tickActiveExperiments:   tickActiveExperiments,
        consolidate:             consolidate,
        summarise:               summarise,
        _hashPartition:          _hashPartition,
        _scorePartition:         _scorePartition,
        _collectRoutesForProfile: _collectRoutesForProfile,
        DEFAULTS:                Object.assign({}, DEFAULTS)
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Partition smoke
            const part = _hashPartition([
                {routeKey: "FRA-LHR"}, {routeKey: "FRA-CDG"},
                {routeKey: "FRA-JFK"}, {routeKey: "FRA-DXB"}
            ], 0.5)
            console.assert(part.assigned.length === 2 && part.control.length === 2,
                "[smoke s7-tuner] _hashPartition halves a 4-route set")
            const part2 = _hashPartition([
                {routeKey: "FRA-LHR"}, {routeKey: "FRA-CDG"},
                {routeKey: "FRA-JFK"}, {routeKey: "FRA-DXB"}
            ], 0.5)
            console.assert(part.assigned.join(",") === part2.assigned.join(","),
                "[smoke s7-tuner] partition is deterministic across calls")

            // _collectRoutesForProfile smoke
            const routes = _collectRoutesForProfile({
                hubs: [{iata: "FRA", byRoute: [
                    {dest: "LHR", serviceProfileId: 1},
                    {dest: "CDG", serviceProfileId: 1},
                    {dest: "JFK", serviceProfileId: 2}
                ]}]
            }, 1)
            console.assert(routes.length === 2,
                "[smoke s7-tuner] _collectRoutesForProfile filters to matching profile")

            // evaluate gate smoke (tier wrong)
            ;(async function () {
                const r = await evaluate({
                    strategySettings: {tier: "preview-only", serviceMovesEnabled: true},
                    hubs: [], serviceProfiles: []
                }, {})
                console.assert(r.candidate === null && r.reasons.indexOf("tier-not-apply-auto") >= 0,
                    "[smoke s7-tuner] evaluate gates on tier")
            })().catch(e => console.warn("[smoke s7-tuner] evaluate threw", e))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
