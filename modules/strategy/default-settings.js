"use strict"

/**
 * AES Strategy — settings store (Slice 4 cross-cutting).
 *
 * Persists every strategy-layer knob under `settings.strategy` in
 * chrome.storage.local. Independent of `RouteAssistantSettings` so the
 * strategy namespace (`aesStrategy:*` keys, `settings.strategy` slot)
 * can evolve without touching the RA panel's settings shape.
 *
 * Storage shape:
 *   settings.strategy                   ← legacy / pre-canopy slot
 *   settings.acct.<id>.strategy         ← canopy-scoped slot (L2 pattern)
 *
 * Settings shape — see roadmap §III-Slice 4. Every field has a default
 * so callers never see undefined for a known key; new fields ship with
 * a sane default and existing users get them on next mount.
 *
 * Public API (window.AesStrategySettings):
 *   AesStrategySettings.load()                → Promise<Settings>
 *   AesStrategySettings.save(partial)         → Promise<Settings>
 *   AesStrategySettings.defaults()            → Settings   (pure)
 *   AesStrategySettings.resolveTier(s)        → "preview-only"|"apply-on-confirm"|"apply-auto"
 *   AesStrategySettings.canApply(s, domain)   → bool
 *
 * `domain` ∈ {"schedule", "service", "price", "crew", "routeCreation",
 *              "alliance", "slotBid"}.
 * `canApply` is the single point that combines the master tier gate
 * with the per-domain enable flag — every actuator call site reads it
 * so the safety contract can never drift between caller and store.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategySettings) return

    const TIERS = ["preview-only", "apply-on-confirm", "apply-auto"]
    const RISKS = ["conservative", "balanced", "aggressive"]
    const DOMAIN_FLAGS = {
        schedule:      "scheduleApplyEnabled",
        service:       "serviceMovesEnabled",
        price:         "priceMovesEnabled",
        crew:          "crewMovesEnabled",
        routeCreation: "routeCreationEnabled",
        alliance:      "allianceMovesEnabled",
        slotBid:       "slotBidApplyEnabled"
    }

    function _defaults() {
        return {
            permanentLiveMode:      true,
            tier:                   "apply-auto",
            riskProfile:            "balanced",
            weights:                null,             // null → use AesStrategy.DEFAULT_WEIGHTS
            crossAirlineEnabled:    false,
            scheduleApplyEnabled:   true,
            routeCreationEnabled:   true,
            priceMovesEnabled:      true,
            serviceMovesEnabled:    true,
            crewMovesEnabled:       true,
            allianceMovesEnabled:   true,
            slotBidApplyEnabled:    true,
            minOrsTarget:           0.7,
            routeCreationThreshold: 0.6,
            priceDeadband:          5,
            maxPriceMovePerWindow:  10,
            horizonDays:            7,
            learningStepSize:       0.05,
            learningEnabled:        false,
            autoSeedDisabled:       false,
            // Slice S1 — goal-driven pricing/service objective
            objective: {
                kind:   "balanced",
                custom: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
            },
            // Slice S1 — per-aircraft ORS rating modifier override table
            // Empty by default → AesStrategyAircraftOrsModifier.DEFAULT_TABLE applies.
            // Shape: {regional|narrow|wide|heavy: {short|medium|long: <delta>}}
            aircraftOrsModifier:    {},
            // Slice S1 — service-profile dry-run + auto loop scaffolding (S2 wires the loop)
            serviceApply: {
                dryRunOnly:           false,
                cooldownMinPerProfile: 60
            },
            // Slice S2 — apply-auto driver (modules/strategy/auto-driver.js).
            // Live-run builds keep every strategy domain available once the
            // tier is explicitly set to apply-auto.
            autoTick: {
                enabled:             true,
                intervalMin:         30,
                cooldownMin:         30,
                maxDecisionsPerTick: 5,
                // Velvet Cascade · PR 3 — silent-auto cap-window. The
                // auto-driver counts source="silent-auto" applies in the
                // last 24h across pricing + service apply logs and skips
                // the over-cap domain rather than aborting the whole
                // tick. Default 10 keeps two engines from spiraling
                // (§4.17) while leaving plenty of room for routine moves.
                silentAutoCap24h:    10,
                domains: {
                    schedule:      true,
                    service:       true,
                    price:         true,
                    crew:          true,
                    routeCreation: true,
                    alliance:      true,
                    slotBid:       true
                }
            },
            // Lane C Phase 2 — Fleet Optimizer slot, owned by
            // AesStrategyFleetOptimizerSettings (modules/strategy/fleet-optimizer-settings.js).
            // Permanent-live builds enable targeting by default; the
            // conservative `underUtilWeight: 0` still avoids surprise
            // rebalance pressure until scoring weights are tuned.
            // _merge passes the slot through unchanged via _normFleetOptimizer.
            fleetOptimizer: {
                ratioFloorPct:           95,
                headroomPct:             2,
                underUtilWeight:         0,
                maxRebalancesPerWindow:  3,
                perAircraft:             {},
                targetingEnabled:        true,
                readinessAck:            null
            },
            // Slice — evidence-based tunables. Mirrors the opts route-creation.js
            // already accepts; previously had no settings home so callers always
            // hit the in-function defaults. Defaults verbatim from
            // route-creation.js _proposedFrequency (1, 14) + _proposedPricePct (100).
            routeCreation: {
                minFrequency:    1,
                maxFrequency:    14,
                defaultPricePct: 100
            },
            // Anti-spiral economics floor consulted by price-moves and
            // service-moves (NORTH-STAR §4.17). Default 5000 mirrors the literal
            // currently inlined as the `_num(econ.competitorIncomeFloorWeekly, 5000)`
            // fallback in both engines.
            economics: {
                competitorIncomeFloorWeekly: 5000
            },
            // Slice 11 — sister coordination. crossAirlineEnabled is the
            // gate (declared above); coordinatedHubs is an opt-in roster
            // of "sister A owns FRA, sister B owns MUC" declarations
            // (entries shape: ["accountId:HUB"]). Empty list = let the
            // proposers infer specialization from observed fleet mixes.
            // sisterCoordination block tunes the three proposers.
            coordinatedHubs:        [],
            sisterCoordination: {
                maxPriceSpreadPct:         8,
                widebodyFractionThreshold: 0.55,
                regionalFractionThreshold: 0.45,
                leaseMinScore:             0.20,
                topNPerKind:               5
            },
            // Slice 7 — service-profile A/B tuner. The tuner clones a
            // candidate profile, partitions its routes ~50/50, lets a
            // game-week elapse, and reads outcomes to declare a winner.
            // Default `enabled: false` per §4.18 — explicit opt-in only.
            serviceTuner: {
                enabled:                 false,
                minPredictedLift:        0.06,
                assignmentRatio:         0.5,
                minRoutesPerExperiment:  2,
                maxRoutesPerExperiment:  10,
                durationDays:            7,
                autoConsolidate:         false,
                maxConcurrentPerAirline: 3
            },
            // Service-cost weights promoted out of service-moves.js
            // Object.freeze literals (was lines 131/141/147). Defaults are
            // byte-for-byte identical to the prior frozen tables — the engine
            // falls back to the literals when this block is absent so legacy
            // behaviour is preserved across the migration.
            serviceCosts: {
                categoryWeights: {
                    drinks:               1.0,
                    snacks:               1.5,
                    entrees:              4.0,
                    additionalEntrees:    4.0,
                    headphones:           1.0,
                    newspapersMagazines:  0.5,
                    flightMagazines:      0.5,
                    foodPresentation:     1.5
                },
                classMultipliers:    {Y: 1, C: 3.6, F: 9},
                defaultCategoryCost: 2.0
            },
            // Brand / reputation-aware planning. The company overall
            // rating is scraped opportunistically from dashboard /
            // enterprise overview and carried into the strategy snapshot.
            reputationPlanning: {
                enabled:                      true,
                targetRatingScore:            8,
                maxWeeklyReputationBudgetAS:  null,
                protectHighRating:            true,
                categoryWeights:              {},
                roleWeights:                  {}
            },
            crewPay: {
                weeklyBudgetAS$: null,
                targetSalaryPctAboveAverage: null,
                roleOverrides: {},
                apply: {
                    enabled:    true,
                    dryRunOnly: false
                }
            },
            // Slice 12 — alliance & IL codeshare optimisation. `apply` is
            // the two-gate model for `AllianceIlRequestApplier`:
            //   enabled    — user kill switch (defaults true so the per-card
            //                "Send IL request" affordance lights up; the
            //                surrounding `allianceMovesEnabled` flag is also
            //                live by default in live-run builds)
            //   dryRunOnly — explicit rehearsal override. Defaults false so
            //                the existing applier POST path can run live.
            // `proposers` mirrors `proposeAllianceMoves` opts; defaults
            // verbatim from `modules/strategy/alliance.js` DEFAULTS.
            alliance: {
                apply: {
                    enabled:    true,
                    dryRunOnly: false
                },
                proposers: {
                    minNewReach:          4,
                    maxOverlapFraction:   0.35,
                    maxProposalsPerCall:  8,
                    minAllianceMembers:   2,
                    maxAllianceProposals: 3
                }
            }
        }
    }

    function _normFleetOptimizer(block, fallback) {
        const f = fallback || {
            ratioFloorPct: 95, headroomPct: 2, underUtilWeight: 0,
            maxRebalancesPerWindow: 3, perAircraft: {},
            targetingEnabled: true, readinessAck: null
        }
        if (!block || typeof block !== "object") return Object.assign({}, f)
        const perAircraft = (block.perAircraft && typeof block.perAircraft === "object")
            ? block.perAircraft : {}
        return {
            ratioFloorPct:          _normNum(block.ratioFloorPct,          0,  100, f.ratioFloorPct),
            headroomPct:            _normNum(block.headroomPct,            0,  20,  f.headroomPct),
            underUtilWeight:        _normNum(block.underUtilWeight,        0,  1e6, f.underUtilWeight),
            maxRebalancesPerWindow: _normNum(block.maxRebalancesPerWindow, 0,  50,  f.maxRebalancesPerWindow),
            perAircraft:            perAircraft,
            targetingEnabled:       block.targetingEnabled !== false,
            readinessAck:           (typeof block.readinessAck === "string") ? block.readinessAck : null
        }
    }

    function _normTier(v) { return TIERS.indexOf(v) >= 0 ? v : "apply-auto" }
    function _normRisk(v) { return RISKS.indexOf(v) >= 0 ? v : "balanced"     }
    function _normNum(v, lo, hi, fallback) {
        const n = Number(v)
        if (!isFinite(n)) return fallback
        if (n < lo) return lo
        if (n > hi) return hi
        return n
    }

    const OBJECTIVE_KINDS = ["maxShare", "maxProfit", "balanced", "custom"]

    function _normObjective(block, fallback) {
        const f = fallback || {kind: "balanced",
                               custom: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}}
        if (!block || typeof block !== "object") return Object.assign({}, f)
        const kind = OBJECTIVE_KINDS.indexOf(block.kind) >= 0 ? block.kind : f.kind
        let custom = f.custom
        if (block.custom && typeof block.custom === "object") {
            const s = Math.max(0, Number(block.custom.shareWeight)  || 0)
            const p = Math.max(0, Number(block.custom.profitWeight) || 0)
            const r = Math.max(0, Number(block.custom.rankWeight)   || 0)
            const total = s + p + r
            custom = total > 0
                ? {shareWeight: s / total, profitWeight: p / total, rankWeight: r / total}
                : Object.assign({}, f.custom)
        }
        return {kind: kind, custom: custom}
    }

    function _normAircraftMod(block) {
        if (!block || typeof block !== "object") return {}
        const out = {}
        const cats = ["regional", "narrow", "wide", "heavy"]
        const bkts = ["short", "medium", "long"]
        for (const c of cats) {
            const row = block[c]
            if (!row || typeof row !== "object") continue
            const slot = {}
            for (const b of bkts) {
                const v = Number(row[b])
                if (Number.isFinite(v)) slot[b] = Math.max(-10, Math.min(10, v))
            }
            if (Object.keys(slot).length) out[c] = slot
        }
        return out
    }

    function _normServiceApply(block, fallback) {
        const f = fallback || {dryRunOnly: false, cooldownMinPerProfile: 60}
        if (!block || typeof block !== "object") return Object.assign({}, f)
        return {
            dryRunOnly:            block.dryRunOnly === true,
            cooldownMinPerProfile: _normNum(block.cooldownMinPerProfile, 0, 1440, f.cooldownMinPerProfile)
        }
    }

    function _normAutoTick(block, fallback) {
        const f = fallback
        if (!block || typeof block !== "object") return JSON.parse(JSON.stringify(f))
        const domains = {}
        const inDom = (block.domains && typeof block.domains === "object") ? block.domains : {}
        for (const k of Object.keys(DOMAIN_FLAGS)) {
            domains[k] = (inDom[k] === undefined) ? !!f.domains[k] : !!inDom[k]
        }
        return {
            enabled:             block.enabled !== false,
            intervalMin:         _normNum(block.intervalMin, 1, 1440, f.intervalMin),
            cooldownMin:         _normNum(block.cooldownMin, 0, 1440, f.cooldownMin),
            maxDecisionsPerTick: _normNum(block.maxDecisionsPerTick, 0, 100, f.maxDecisionsPerTick),
            silentAutoCap24h:    _normNum(block.silentAutoCap24h,    0, 1000, f.silentAutoCap24h),
            domains:             domains
        }
    }

    function _normRouteCreation(block, fallback) {
        const f = fallback || {minFrequency: 1, maxFrequency: 14, defaultPricePct: 100}
        if (!block || typeof block !== "object") return Object.assign({}, f)
        const minF = _normNum(block.minFrequency,    1, 28,  f.minFrequency)
        const maxF = _normNum(block.maxFrequency,    1, 28,  f.maxFrequency)
        return {
            minFrequency:    Math.min(minF, maxF),
            maxFrequency:    Math.max(minF, maxF),
            defaultPricePct: _normNum(block.defaultPricePct, 50, 200, f.defaultPricePct)
        }
    }

    function _normEconomics(block, fallback) {
        const f = fallback || {competitorIncomeFloorWeekly: 5000}
        if (!block || typeof block !== "object") return Object.assign({}, f)
        return {
            competitorIncomeFloorWeekly: _normNum(block.competitorIncomeFloorWeekly,
                                                  0, 1e9, f.competitorIncomeFloorWeekly)
        }
    }

    function _normCoordinatedHubs(block) {
        if (!Array.isArray(block)) return []
        const out = []
        for (const entry of block) {
            if (typeof entry !== "string") continue
            const trimmed = entry.trim()
            if (!trimmed || !/^[A-Za-z0-9_-]+:[A-Z]{3}$/i.test(trimmed)) continue
            const upper = trimmed.split(":")
            out.push(upper[0] + ":" + upper[1].toUpperCase())
        }
        return out
    }

    function _normSisterCoordination(block, fallback) {
        const f = fallback || _defaults().sisterCoordination
        if (!block || typeof block !== "object") return Object.assign({}, f)
        return {
            maxPriceSpreadPct:         _normNum(block.maxPriceSpreadPct,         0,    100, f.maxPriceSpreadPct),
            widebodyFractionThreshold: _normNum(block.widebodyFractionThreshold, 0,    1,   f.widebodyFractionThreshold),
            regionalFractionThreshold: _normNum(block.regionalFractionThreshold, 0,    1,   f.regionalFractionThreshold),
            leaseMinScore:             _normNum(block.leaseMinScore,             0,    10,  f.leaseMinScore),
            topNPerKind:               _normNum(block.topNPerKind,               1,    50,  f.topNPerKind)
        }
    }

    function _normServiceTuner(block, fallback) {
        const f = fallback || _defaults().serviceTuner
        if (!block || typeof block !== "object") return Object.assign({}, f)
        const minR = _normNum(block.minRoutesPerExperiment, 1, 100, f.minRoutesPerExperiment)
        const maxR = _normNum(block.maxRoutesPerExperiment, 1, 200, f.maxRoutesPerExperiment)
        return {
            enabled:                 !!block.enabled,
            minPredictedLift:        _normNum(block.minPredictedLift,        0,    1,   f.minPredictedLift),
            assignmentRatio:         _normNum(block.assignmentRatio,         0.2,  0.8, f.assignmentRatio),
            minRoutesPerExperiment:  Math.min(minR, maxR),
            maxRoutesPerExperiment:  Math.max(minR, maxR),
            durationDays:            _normNum(block.durationDays,            1,    60,  f.durationDays),
            autoConsolidate:         !!block.autoConsolidate,
            maxConcurrentPerAirline: _normNum(block.maxConcurrentPerAirline, 1,    20,  f.maxConcurrentPerAirline)
        }
    }

    function _normAlliance(block, fallback) {
        const f = fallback || _defaults().alliance
        if (!block || typeof block !== "object") return JSON.parse(JSON.stringify(f))
        const apply = (block.apply && typeof block.apply === "object") ? block.apply : {}
        const props = (block.proposers && typeof block.proposers === "object") ? block.proposers : {}
        return {
            apply: {
                enabled:    apply.enabled    !== false,
                dryRunOnly: apply.dryRunOnly === true
            },
            proposers: {
                minNewReach:          _normNum(props.minNewReach,          0,    50,  f.proposers.minNewReach),
                maxOverlapFraction:   _normNum(props.maxOverlapFraction,   0,    1,   f.proposers.maxOverlapFraction),
                maxProposalsPerCall:  _normNum(props.maxProposalsPerCall,  1,    50,  f.proposers.maxProposalsPerCall),
                minAllianceMembers:   _normNum(props.minAllianceMembers,   1,    50,  f.proposers.minAllianceMembers),
                maxAllianceProposals: _normNum(props.maxAllianceProposals, 0,    20,  f.proposers.maxAllianceProposals)
            }
        }
    }

    function _normServiceCosts(block, fallback) {
        const f = fallback || _defaults().serviceCosts
        if (!block || typeof block !== "object") return JSON.parse(JSON.stringify(f))
        const inWeights = (block.categoryWeights && typeof block.categoryWeights === "object")
            ? block.categoryWeights : {}
        const outWeights = Object.assign({}, f.categoryWeights)
        for (const k in inWeights) {
            const v = Number(inWeights[k])
            if (Number.isFinite(v) && v >= 0) outWeights[k] = Math.min(v, 100)
        }
        const inMul = (block.classMultipliers && typeof block.classMultipliers === "object")
            ? block.classMultipliers : {}
        const outMul = Object.assign({}, f.classMultipliers)
        for (const cls of ["Y", "C", "F"]) {
            const v = Number(inMul[cls])
            if (Number.isFinite(v) && v >= 0) outMul[cls] = Math.min(v, 100)
        }
        return {
            categoryWeights:     outWeights,
            classMultipliers:    outMul,
            defaultCategoryCost: _normNum(block.defaultCategoryCost, 0, 100, f.defaultCategoryCost)
        }
    }

    function _normOpenWeights(block) {
        const out = {}
        if (!block || typeof block !== "object") return out
        for (const k in block) {
            const v = Number(block[k])
            if (Number.isFinite(v) && v >= 0) out[k] = Math.min(v, 10)
        }
        return out
    }

    function _normReputationPlanning(block, fallback) {
        const f = fallback || _defaults().reputationPlanning
        if (!block || typeof block !== "object") return JSON.parse(JSON.stringify(f))
        const budget = Number(block.maxWeeklyReputationBudgetAS)
        return {
            enabled:                     block.enabled !== false,
            targetRatingScore:           _normNum(block.targetRatingScore, 1, 10, f.targetRatingScore),
            maxWeeklyReputationBudgetAS: Number.isFinite(budget) && budget >= 0 ? budget : null,
            protectHighRating:           block.protectHighRating !== false,
            categoryWeights:             _normOpenWeights(block.categoryWeights),
            roleWeights:                 _normOpenWeights(block.roleWeights)
        }
    }

    function _normCrewPay(block, fallback) {
        const f = fallback || _defaults().crewPay
        if (!block || typeof block !== "object") return JSON.parse(JSON.stringify(f))
        const budget = Number(block.weeklyBudgetAS$)
        const apply = (block.apply && typeof block.apply === "object") ? block.apply : {}
        const overrides = (block.roleOverrides && typeof block.roleOverrides === "object") ? block.roleOverrides : {}
        const safeOverrides = {}
        for (const k in overrides) {
            const v = Number(overrides[k])
            if (Number.isFinite(v) && v >= -100 && v <= 100) safeOverrides[k] = Math.round(v)
        }

        let targetPct = Number(block.targetSalaryPctAboveAverage)
        targetPct = isFinite(targetPct) ? Math.max(-50, Math.min(50, targetPct)) : null

        return {
            weeklyBudgetAS$: Number.isFinite(budget) && budget >= 0 ? budget : null,
            targetSalaryPctAboveAverage: targetPct !== null ? targetPct : f.targetSalaryPctAboveAverage,
            roleOverrides: safeOverrides,
            apply: {
                enabled:    apply.enabled !== false,
                dryRunOnly: apply.dryRunOnly === true
            }
        }
    }

    function _merge(block) {
        const d = _defaults()
        if (!block || typeof block !== "object") return d
        const liveMode = block.permanentLiveMode !== false
        const out = {
            permanentLiveMode:      liveMode,
            tier:                   liveMode ? "apply-auto" : _normTier(block.tier),
            riskProfile:            _normRisk(block.riskProfile),
            weights:                (block.weights && typeof block.weights === "object") ? block.weights : null,
            crossAirlineEnabled:    !!block.crossAirlineEnabled,
            scheduleApplyEnabled:   (typeof block.scheduleApplyEnabled === "boolean") ? block.scheduleApplyEnabled : d.scheduleApplyEnabled,
            routeCreationEnabled:   (typeof block.routeCreationEnabled === "boolean") ? block.routeCreationEnabled : d.routeCreationEnabled,
            priceMovesEnabled:      (typeof block.priceMovesEnabled === "boolean") ? block.priceMovesEnabled : d.priceMovesEnabled,
            serviceMovesEnabled:    (typeof block.serviceMovesEnabled === "boolean") ? block.serviceMovesEnabled : d.serviceMovesEnabled,
            crewMovesEnabled:       (typeof block.crewMovesEnabled === "boolean") ? block.crewMovesEnabled : d.crewMovesEnabled,
            allianceMovesEnabled:   (typeof block.allianceMovesEnabled === "boolean") ? block.allianceMovesEnabled : d.allianceMovesEnabled,
            slotBidApplyEnabled:    (typeof block.slotBidApplyEnabled === "boolean") ? block.slotBidApplyEnabled : d.slotBidApplyEnabled,
            minOrsTarget:           _normNum(block.minOrsTarget, 0, 1, d.minOrsTarget),
            routeCreationThreshold: _normNum(block.routeCreationThreshold, 0, 1, d.routeCreationThreshold),
            priceDeadband:          _normNum(block.priceDeadband, 0, 50, d.priceDeadband),
            maxPriceMovePerWindow:  _normNum(block.maxPriceMovePerWindow, 0, 50, d.maxPriceMovePerWindow),
            horizonDays:            _normNum(block.horizonDays, 1, 30, d.horizonDays),
            learningStepSize:       _normNum(block.learningStepSize, 0, 0.5, d.learningStepSize),
            learningEnabled:        !!block.learningEnabled,
            autoSeedDisabled:       !!block.autoSeedDisabled,
            objective:              _normObjective(block.objective,    d.objective),
            aircraftOrsModifier:    _normAircraftMod(block.aircraftOrsModifier),
            serviceApply:           _normServiceApply(block.serviceApply, d.serviceApply),
            autoTick:               _normAutoTick(block.autoTick,         d.autoTick),
            fleetOptimizer:         _normFleetOptimizer(block.fleetOptimizer, d.fleetOptimizer),
            routeCreation:          _normRouteCreation(block.routeCreation, d.routeCreation),
            economics:              _normEconomics(block.economics,         d.economics),
            coordinatedHubs:        _normCoordinatedHubs(block.coordinatedHubs),
            sisterCoordination:     _normSisterCoordination(block.sisterCoordination, d.sisterCoordination),
            serviceTuner:           _normServiceTuner(block.serviceTuner,   d.serviceTuner),
            serviceCosts:           _normServiceCosts(block.serviceCosts,   d.serviceCosts),
            reputationPlanning:     _normReputationPlanning(block.reputationPlanning, d.reputationPlanning),
            crewPay:                _normCrewPay(block.crewPay,             d.crewPay),
            alliance:               _normAlliance(block.alliance,           d.alliance)
        }
        if (liveMode) {
            out.scheduleApplyEnabled = true
            out.routeCreationEnabled = true
            out.priceMovesEnabled = true
            out.serviceMovesEnabled = true
            out.crewMovesEnabled = true
            out.allianceMovesEnabled = true
            if (out.alliance && out.alliance.apply) { out.alliance.apply.dryRunOnly = false }
            if (out.alliance && out.alliance.apply) { out.alliance.apply.enabled = true }
            out.slotBidApplyEnabled = true
            out.serviceApply.dryRunOnly = false
            out.autoTick.enabled = true
            out.autoTick.domains = Object.assign({}, out.autoTick.domains || {}, {
                schedule: true,
                service: true,
                price: true,
                crew: true,
                routeCreation: true,
                alliance: true,
                slotBid: true
            })
            out.fleetOptimizer.targetingEnabled = true
            if (out.fleetOptimizer.apply) {
                out.fleetOptimizer.apply.enabled = true
                out.fleetOptimizer.apply.dryRunOnly = false
            }
            out.crewPay.apply.enabled = true
            out.crewPay.apply.dryRunOnly = false
            if (out.alliance && out.alliance.apply) { out.alliance.apply.enabled = true }
            if (out.alliance && out.alliance.apply) { out.alliance.apply.dryRunOnly = false }
        }
        return out
    }

    function _accountId() {
        try { return (typeof currentAccountIdSync === "function") ? currentAccountIdSync() : null }
        catch (_) { return null }
    }

    async function _loadLegacy() {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const id = _accountId()
        let block = null
        if (id && settings.acct && settings.acct[id] && typeof settings.acct[id] === "object") {
            if (settings.acct[id].strategy && typeof settings.acct[id].strategy === "object") {
                block = settings.acct[id].strategy
            }
        }
        if (!block) block = settings.strategy || null
        return _merge(block)
    }

    async function _layeredEnabled() {
        try {
            return !!(window.AesStrategyLayered &&
                     typeof window.AesStrategyLayered.featureEnabled === "function" &&
                     await window.AesStrategyLayered.featureEnabled())
        } catch (_) { return false }
    }

    async function load() {
        try {
            if (await _layeredEnabled()) {
                const r = await window.AesStrategyLayered.resolveEffectiveStrategy({accountId: _accountId()})
                if (r && r.effective) return _merge(r.effective)
            }
            return await _loadLegacy()
        } catch (e) {
            console.warn("[AesStrategySettings] load failed", e)
            return _defaults()
        }
    }

    /**
     * Slice 1 — context-aware effective strategy. Callers that already
     * know the route hub/dest (and optionally an aircraftId) get the
     * fully-resolved block (family → account → division → fleet → route).
     * With the kill switch off this is identical to load().
     */
    async function loadForRoute(hub, dest, aircraftId) {
        try {
            if (await _layeredEnabled()) {
                const r = await window.AesStrategyLayered.resolveEffectiveStrategy({
                    accountId:  _accountId(),
                    hub:        hub        || null,
                    dest:       dest       || null,
                    aircraftId: aircraftId || null
                })
                if (r && r.effective) return _merge(r.effective)
            }
        } catch (e) {
            console.warn("[AesStrategySettings] loadForRoute failed", e)
        }
        return load()
    }

    async function save(partial) {
        const current = await load()
        const next = _merge(Object.assign({}, current, partial || {}))
        const id = _accountId()
        await window.AesSettings.saveAreaScoped("strategy", next, id)
        return next
    }

    function resolveTier(s)   { return s ? _normTier(s.tier) : "apply-auto" }
    function canApply(s, domain) {
        if (!s) return false
        if (resolveTier(s) === "preview-only") return false
        const flag = DOMAIN_FLAGS[domain]
        if (!flag) return false
        return !!s[flag]
    }

    window.AesStrategySettings = {
        load:           load,
        loadForRoute:   loadForRoute,
        save:           save,
        defaults:       _defaults,
        resolveTier:    resolveTier,
        canApply:       canApply,
        TIERS:          TIERS.slice(),
        RISKS:          RISKS.slice(),
        OBJECTIVE_KINDS: OBJECTIVE_KINDS.slice(),
        DOMAIN_FLAGS:   Object.assign({}, DOMAIN_FLAGS)
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const d = _defaults()
            console.assert(d.tier === "apply-auto",                      "[smoke] default tier apply-auto")
            console.assert(d.scheduleApplyEnabled === true,              "[smoke] default schedule enabled")
            console.assert(d.objective && d.objective.kind === "balanced", "[smoke] default objective balanced")
            console.assert(d.serviceApply && d.serviceApply.dryRunOnly === false, "[smoke] service live on")
            console.assert(d.autoTick && d.autoTick.enabled === true, "[smoke] autoTick enabled by default")
            console.assert(d.autoTick.domains.crew === true && d.autoTick.domains.routeCreation === true,
                "[smoke] crew + routeCreation default on in autoTick")
            const at = _merge({autoTick: {intervalMin: 0, domains: {price: false}}}).autoTick
            console.assert(at.intervalMin === 1, "[smoke] autoTick.intervalMin clamped to 1 min floor")
            console.assert(at.domains.price === true, "[smoke] permanent-live keeps price domain on")
            console.assert(at.domains.schedule === true, "[smoke] autoTick.domains unset key keeps default")
            console.assert(canApply({tier: "preview-only", scheduleApplyEnabled: true}, "schedule") === false,
                "[smoke] preview-only blocks schedule even when domain enabled")
            console.assert(canApply({tier: "apply-on-confirm", scheduleApplyEnabled: false}, "schedule") === false,
                "[smoke] domain disabled blocks schedule even when tier permits")
            console.assert(canApply({tier: "apply-on-confirm", priceMovesEnabled: true}, "price") === true,
                "[smoke] both gates clear → can apply")
            console.assert(canApply({tier: "apply-auto", scheduleApplyEnabled: true}, "bogus-domain") === false,
                "[smoke] unknown domain rejected")
            // Objective normalisation smoke
            const merged = _merge({objective: {kind: "custom",
                                                custom: {shareWeight: 2, profitWeight: 2, rankWeight: 0}}})
            console.assert(Math.abs(merged.objective.custom.shareWeight - 0.5) < 1e-9,
                "[smoke] custom weights normalised to sum 1")
            // Evidence-based tunables — defaults must match prior frozen literals.
            console.assert(d.routeCreation.minFrequency === 1 && d.routeCreation.maxFrequency === 14,
                "[smoke] routeCreation freq defaults match route-creation.js opts")
            console.assert(d.routeCreation.defaultPricePct === 100,
                "[smoke] routeCreation defaultPricePct mirrors prior literal")
            console.assert(d.economics.competitorIncomeFloorWeekly === 5000,
                "[smoke] economics floor mirrors prior price-moves/service-moves literal")
            console.assert(d.serviceCosts.categoryWeights.entrees === 4.0
                && d.serviceCosts.categoryWeights.drinks === 1.0
                && d.serviceCosts.categoryWeights.foodPresentation === 1.5,
                "[smoke] serviceCosts category weights mirror frozen CATEGORY_COST_WEIGHT")
            console.assert(d.serviceCosts.classMultipliers.Y === 1
                && d.serviceCosts.classMultipliers.C === 3.6
                && d.serviceCosts.classMultipliers.F === 9,
                "[smoke] serviceCosts class multipliers mirror frozen CLASS_COST_MULTIPLIER")
            console.assert(d.serviceCosts.defaultCategoryCost === 2.0,
                "[smoke] serviceCosts defaultCategoryCost mirrors prior literal")
            // Slice 12 — alliance defaults live in this build.
            console.assert(d.alliance && d.alliance.apply.enabled === true
                && d.alliance.apply.dryRunOnly === false,
                "[smoke] alliance apply gates default enabled+live")
            console.assert(d.allianceMovesEnabled === true,
                "[smoke] allianceMovesEnabled defaults TRUE")
            console.assert(d.alliance.proposers.minNewReach === 4
                && d.alliance.proposers.maxOverlapFraction === 0.35,
                "[smoke] alliance proposer defaults match alliance.js DEFAULTS")
            console.assert(canApply({tier: "apply-on-confirm", allianceMovesEnabled: true}, "alliance") === true,
                "[smoke] alliance domain gate honored when both flags clear")
            // Clamping smoke — out-of-range inputs fall back rather than throw.
            const clamped = _merge({
                routeCreation: {minFrequency: 30, maxFrequency: 0, defaultPricePct: 5},
                economics: {competitorIncomeFloorWeekly: -50},
                serviceCosts: {categoryWeights: {entrees: -10, drinks: 999}, classMultipliers: {F: -1}}
            })
            console.assert(clamped.routeCreation.minFrequency <= clamped.routeCreation.maxFrequency,
                "[smoke] routeCreation min/max swap repaired")
            console.assert(clamped.routeCreation.defaultPricePct >= 50,
                "[smoke] routeCreation defaultPricePct floor honored")
            console.assert(clamped.economics.competitorIncomeFloorWeekly === 0,
                "[smoke] economics floor clamped to non-negative")
            console.assert(clamped.serviceCosts.categoryWeights.entrees === 4.0,
                "[smoke] serviceCosts negative category weight rejects to default")
            console.assert(clamped.serviceCosts.classMultipliers.F !== -1,
                "[smoke] serviceCosts negative class mul rejected")
            // Slice 1 layered façade smoke — loadForRoute exists and,
            // with the kill switch off, equals load(). When on, the
            // resolver runs and the result still passes through _merge
            // so the shape contract is invariant.
            console.assert(typeof loadForRoute === "function",
                "[smoke] loadForRoute exposed on AesStrategySettings")
            ;(async function () {
                try {
                    const a = await load()
                    const b = await loadForRoute(null, null)
                    console.assert(JSON.stringify(a) === JSON.stringify(b),
                        "[smoke] loadForRoute equals load when no route context (layered off)")
                } catch (_) {}
            })()
        }
    } catch (_) { /* never let smoke break the page */ }
})()
