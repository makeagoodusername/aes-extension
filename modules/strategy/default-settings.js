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
 * `domain` ∈ {"schedule", "service", "price", "crew", "routeCreation"}.
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
        routeCreation: "routeCreationEnabled"
    }

    function _defaults() {
        return {
            tier:                   "preview-only",
            riskProfile:            "balanced",
            weights:                null,             // null → use AesStrategy.DEFAULT_WEIGHTS
            crossAirlineEnabled:    false,
            scheduleApplyEnabled:   false,
            routeCreationEnabled:   false,
            priceMovesEnabled:      false,
            serviceMovesEnabled:    false,
            crewMovesEnabled:       false,
            minOrsTarget:           0.7,
            routeCreationThreshold: 0.6,
            priceDeadband:          5,
            maxPriceMovePerWindow:  10,
            horizonDays:            7,
            learningStepSize:       0.05,
            learningEnabled:        false,
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
                dryRunOnly:           true,
                cooldownMinPerProfile: 60
            },
            // Slice S2 — apply-auto driver (modules/strategy/auto-driver.js).
            // Crew + routeCreation default off — riskier domains require an
            // explicit user opt-in before auto-firing.
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
                    crew:          false,
                    routeCreation: false
                }
            }
        }
    }

    function _normTier(v) { return TIERS.indexOf(v) >= 0 ? v : "preview-only" }
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
        const f = fallback || {dryRunOnly: true, cooldownMinPerProfile: 60}
        if (!block || typeof block !== "object") return Object.assign({}, f)
        return {
            dryRunOnly:            block.dryRunOnly !== false,
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

    function _merge(block) {
        const d = _defaults()
        if (!block || typeof block !== "object") return d
        return {
            tier:                   _normTier(block.tier),
            riskProfile:            _normRisk(block.riskProfile),
            weights:                (block.weights && typeof block.weights === "object") ? block.weights : null,
            crossAirlineEnabled:    !!block.crossAirlineEnabled,
            scheduleApplyEnabled:   !!block.scheduleApplyEnabled,
            routeCreationEnabled:   !!block.routeCreationEnabled,
            priceMovesEnabled:      !!block.priceMovesEnabled,
            serviceMovesEnabled:    !!block.serviceMovesEnabled,
            crewMovesEnabled:       !!block.crewMovesEnabled,
            minOrsTarget:           _normNum(block.minOrsTarget, 0, 1, d.minOrsTarget),
            routeCreationThreshold: _normNum(block.routeCreationThreshold, 0, 1, d.routeCreationThreshold),
            priceDeadband:          _normNum(block.priceDeadband, 0, 50, d.priceDeadband),
            maxPriceMovePerWindow:  _normNum(block.maxPriceMovePerWindow, 0, 50, d.maxPriceMovePerWindow),
            horizonDays:            _normNum(block.horizonDays, 1, 30, d.horizonDays),
            learningStepSize:       _normNum(block.learningStepSize, 0, 0.5, d.learningStepSize),
            learningEnabled:        !!block.learningEnabled,
            objective:              _normObjective(block.objective,    d.objective),
            aircraftOrsModifier:    _normAircraftMod(block.aircraftOrsModifier),
            serviceApply:           _normServiceApply(block.serviceApply, d.serviceApply),
            autoTick:               _normAutoTick(block.autoTick,         d.autoTick)
        }
    }

    function _accountId() {
        try { return (typeof currentAccountIdSync === "function") ? currentAccountIdSync() : null }
        catch (_) { return null }
    }

    async function load() {
        try {
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
        } catch (e) {
            console.warn("[AesStrategySettings] load failed", e)
            return _defaults()
        }
    }

    async function save(partial) {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const current = await load()
        const next = _merge(Object.assign({}, current, partial || {}))
        const id = _accountId()
        if (id) {
            settings.acct = (settings.acct && typeof settings.acct === "object") ? settings.acct : {}
            settings.acct[id] = (settings.acct[id] && typeof settings.acct[id] === "object") ? settings.acct[id] : {}
            settings.acct[id].strategy = next
        } else {
            settings.strategy = next
        }
        await chrome.storage.local.set({settings: settings})
        return next
    }

    function resolveTier(s)   { return s ? _normTier(s.tier) : "preview-only" }
    function canApply(s, domain) {
        if (!s) return false
        if (resolveTier(s) === "preview-only") return false
        const flag = DOMAIN_FLAGS[domain]
        if (!flag) return false
        return !!s[flag]
    }

    window.AesStrategySettings = {
        load:           load,
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
            console.assert(d.tier === "preview-only",                    "[smoke] default tier preview-only")
            console.assert(d.scheduleApplyEnabled === false,             "[smoke] default schedule disabled")
            console.assert(d.objective && d.objective.kind === "balanced", "[smoke] default objective balanced")
            console.assert(d.serviceApply && d.serviceApply.dryRunOnly === true, "[smoke] service dry-run on")
            console.assert(d.autoTick && d.autoTick.enabled === true, "[smoke] autoTick enabled by default")
            console.assert(d.autoTick.domains.crew === false && d.autoTick.domains.routeCreation === false,
                "[smoke] crew + routeCreation default off in autoTick")
            const at = _merge({autoTick: {intervalMin: 0, domains: {price: false}}}).autoTick
            console.assert(at.intervalMin === 1, "[smoke] autoTick.intervalMin clamped to 1 min floor")
            console.assert(at.domains.price === false, "[smoke] autoTick.domains override sticks")
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
        }
    } catch (_) { /* never let smoke break the page */ }
})()
