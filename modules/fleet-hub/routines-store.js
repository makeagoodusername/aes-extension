"use strict"

/**
 * Per-account fleet routines. A routine is a named bundle of
 *   - aircraft-selection criteria (hubs, types, statuses, roles),
 *   - schedule preset choice,
 *   - strategy policy overrides (tier + per-domain enables + per-aircraft
 *     overrides) layered on top of AesStrategySettings for the apply
 *     window,
 *   - and (later, Phase 5) a list of sister-airline accounts to dispatch
 *     against.
 *
 * Routines are the orchestration unit the fleet command center consumes:
 * "Apply the JFK Morning Wave routine" resolves to a matched aircraft set,
 * runs the AFP candidate pipeline per tail, and executes any enabled
 * strategy moves under the routine's policy.
 *
 * Storage:
 *   fleetRoutines                  → (legacy)
 *   fleetRoutines:acct:<id>        → (L2+)
 *     {
 *       routines: [Routine, …],
 *       updatedAt: ms
 *     }
 *
 * Routine schema:
 *   {
 *     id:               "r" + Date.now().toString(36),
 *     name:             string,
 *     description:      string,
 *     aircraftFilter: {
 *       hubs:     string[],   // empty = any
 *       types:    string[],   // typeId or equipment, empty = any
 *       statuses: string[],   // tag.status values
 *       roles:    string[]    // tag.role values (any-match within roles)
 *     },
 *     presetId:         string | null,      // null = pick by hub at apply time
 *     strategyPolicy: {
 *       tier:    "preview-only" | "apply-on-confirm" | "apply-auto" | null,  // null = inherit
 *       domains: {           // null/missing = inherit per-domain
 *         scheduleApplyEnabled?: bool,
 *         priceMovesEnabled?:   bool,
 *         serviceMovesEnabled?: bool,
 *         crewMovesEnabled?:    bool,
 *         routeCreationEnabled?: bool
 *       },
 *       perAircraftOverrides: {
 *         [aircraftId]: {
 *           skipDomains?: string[],    // ["price","crew", …] — domain shortcuts
 *           notes?:       string
 *         }
 *       }
 *     },
 *     accountIds:       string[],          // empty/null = current account only
 *     createdAt, updatedAt,
 *     lastAppliedAt?:   ms,
 *     lastAppliedReport?: {                // most recent run summary
 *       startedAt, finishedAt,
 *       matchedAircraftIds: string[],
 *       perAircraft: {[id]: {ok:bool, error?:string, applied?:int}},
 *       totals: {ok:int, fail:int, applied:int}
 *     }
 *   }
 */
class FleetRoutinesStore {
    static LEGACY_KEY   = "fleetRoutines"
    static SCOPE_PREFIX = "fleetRoutines"

    /** Allowed tier values (mirrors AesStrategySettings.tier). */
    static TIERS = Object.freeze([
        "preview-only",
        "apply-on-confirm",
        "apply-auto"
    ])

    /** Strategy domain shortcuts used by perAircraftOverrides.skipDomains. */
    static DOMAINS = Object.freeze([
        "schedule",
        "service",
        "price",
        "crew",
        "routeCreation"
    ])

    static DOMAIN_TO_SETTING = Object.freeze({
        schedule:      "scheduleApplyEnabled",
        service:       "serviceMovesEnabled",
        price:         "priceMovesEnabled",
        crew:          "crewMovesEnabled",
        routeCreation: "routeCreationEnabled"
    })

    static _key()       { return acctKey(FleetRoutinesStore.SCOPE_PREFIX, "") }
    static _legacyKey() { return FleetRoutinesStore.LEGACY_KEY }

    static async load() {
        const ns = FleetRoutinesStore._key()
        const lg = FleetRoutinesStore._legacyKey()
        const keys = (ns === lg) ? [ns] : [ns, lg]
        const out  = await chrome.storage.local.get(keys)
        const raw  = (out[ns] !== undefined) ? out[ns] : (out[lg] || null)
        const list = (raw && Array.isArray(raw.routines)) ? raw.routines : []
        return {
            routines: list.map(FleetRoutinesStore._normalize),
            updatedAt: Number((raw && raw.updatedAt) || 0)
        }
    }

    static async list() {
        const block = await FleetRoutinesStore.load()
        return block.routines.slice()
    }

    static async get(id) {
        if (!id) return null
        const block = await FleetRoutinesStore.load()
        return block.routines.find(r => r.id === id) || null
    }

    /**
     * Insert a new routine. Caller passes a partial; missing fields fall
     * to the defaults from `_normalize`. Returns the inserted routine
     * (with generated id + timestamps).
     */
    static async create(partial) {
        const block = await FleetRoutinesStore.load()
        const now = Date.now()
        const draft = FleetRoutinesStore._normalize(Object.assign(
            {id: FleetRoutinesStore._mkId(), createdAt: now, updatedAt: now},
            partial || {}
        ))
        const next = block.routines.slice()
        next.unshift(draft)
        await FleetRoutinesStore._save(next)
        return draft
    }

    /** Shallow-merge a patch onto an existing routine. */
    static async update(id, patch) {
        if (!id || !patch) return null
        const block = await FleetRoutinesStore.load()
        const ix = block.routines.findIndex(r => r.id === id)
        if (ix < 0) return null
        const merged = FleetRoutinesStore._normalize(Object.assign(
            {}, block.routines[ix], patch, {id, updatedAt: Date.now()}
        ))
        const next = block.routines.slice()
        next[ix] = merged
        await FleetRoutinesStore._save(next)
        return merged
    }

    static async remove(id) {
        if (!id) return false
        const block = await FleetRoutinesStore.load()
        const next  = block.routines.filter(r => r.id !== id)
        if (next.length === block.routines.length) return false
        await FleetRoutinesStore._save(next)
        return true
    }

    /**
     * Convenience write — record the most recent apply outcome on a
     * routine. Called by the orchestrator (Phase 4). Bumps lastAppliedAt
     * + lastAppliedReport without disturbing other fields.
     */
    static async markApplied(id, report) {
        if (!id) return null
        return FleetRoutinesStore.update(id, {
            lastAppliedAt:     Date.now(),
            lastAppliedReport: report || null
        })
    }

    /**
     * Resolve the effective strategy settings for one aircraft under one
     * routine. Layers:
     *   base = existing AesStrategySettings (passed in)
     *   + routine.strategyPolicy (tier + domains)
     *   + perAircraftOverrides[aircraftId] (skipDomains)
     *
     * Pure — does not write. Returns a new settings object with the
     * routine's overrides applied. Callers feed this to the apply pipeline
     * for the apply window, then restore the base settings.
     *
     * `inherit` semantics: a null/undefined tier or domain bool means
     * "use the base value". This lets a routine narrow scope (disable
     * crew moves) without forcing a full settings replacement.
     */
    static resolveEffectiveSettings(baseSettings, routine, aircraftId) {
        const out = Object.assign({}, baseSettings || {})
        const pol = (routine && routine.strategyPolicy) || {}

        if (pol.tier && FleetRoutinesStore.TIERS.indexOf(pol.tier) >= 0) {
            out.tier = pol.tier
        }
        const domains = pol.domains || {}
        for (const k of [
            "scheduleApplyEnabled", "priceMovesEnabled", "serviceMovesEnabled",
            "crewMovesEnabled", "routeCreationEnabled"
        ]) {
            if (typeof domains[k] === "boolean") out[k] = domains[k]
        }

        // Per-aircraft skipDomains layer — resolves shortcut domain keys
        // (price, crew, …) to their settings field name and forces false.
        const perAc = pol.perAircraftOverrides || {}
        const ov = perAc[String(aircraftId)] || null
        if (ov && Array.isArray(ov.skipDomains)) {
            for (const dk of ov.skipDomains) {
                const field = FleetRoutinesStore.DOMAIN_TO_SETTING[dk]
                if (field) out[field] = false
            }
        }
        return out
    }

    static async _save(routines) {
        const ns = FleetRoutinesStore._key()
        await chrome.storage.local.set({[ns]: {routines, updatedAt: Date.now()}})
    }

    static _mkId() {
        return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    }

    /**
     * Defensive shape coercion. Any field missing from input falls to its
     * default. Unknown fields are dropped — keeps the persisted record
     * tidy and removes a class of forward-compat bugs (a stale UI writing
     * an obsolete field can't bloat the store).
     */
    static _normalize(input) {
        const i = input || {}
        const ar = (v) => Array.isArray(v) ? v.filter(x => typeof x === "string") : []
        const filterIn = i.aircraftFilter || {}
        const policyIn = i.strategyPolicy || {}
        const domainsIn = policyIn.domains || {}
        const perAcIn   = policyIn.perAircraftOverrides || {}

        const perAcOut = {}
        for (const k in perAcIn) {
            const v = perAcIn[k] || {}
            perAcOut[String(k)] = {
                skipDomains: ar(v.skipDomains).filter(d =>
                    FleetRoutinesStore.DOMAINS.indexOf(d) >= 0),
                notes: typeof v.notes === "string" ? v.notes : ""
            }
        }

        return {
            id:          String(i.id || FleetRoutinesStore._mkId()),
            name:        String(i.name || "(unnamed routine)"),
            description: String(i.description || ""),
            aircraftFilter: {
                hubs:     ar(filterIn.hubs).map(s => s.toUpperCase()),
                types:    ar(filterIn.types),
                statuses: ar(filterIn.statuses),
                roles:    ar(filterIn.roles)
            },
            presetId: i.presetId ? String(i.presetId) : null,
            strategyPolicy: {
                tier: (i.strategyPolicy && FleetRoutinesStore.TIERS.indexOf(i.strategyPolicy.tier) >= 0)
                    ? i.strategyPolicy.tier : null,
                domains: {
                    scheduleApplyEnabled: typeof domainsIn.scheduleApplyEnabled === "boolean"
                        ? domainsIn.scheduleApplyEnabled : null,
                    priceMovesEnabled:    typeof domainsIn.priceMovesEnabled    === "boolean"
                        ? domainsIn.priceMovesEnabled    : null,
                    serviceMovesEnabled:  typeof domainsIn.serviceMovesEnabled  === "boolean"
                        ? domainsIn.serviceMovesEnabled  : null,
                    crewMovesEnabled:     typeof domainsIn.crewMovesEnabled     === "boolean"
                        ? domainsIn.crewMovesEnabled     : null,
                    routeCreationEnabled: typeof domainsIn.routeCreationEnabled === "boolean"
                        ? domainsIn.routeCreationEnabled : null
                },
                perAircraftOverrides: perAcOut
            },
            accountIds: ar(i.accountIds),
            createdAt:        Number(i.createdAt) || Date.now(),
            updatedAt:        Number(i.updatedAt) || Date.now(),
            lastAppliedAt:    Number(i.lastAppliedAt) || null,
            lastAppliedReport: (i.lastAppliedReport && typeof i.lastAppliedReport === "object")
                ? i.lastAppliedReport : null
        }
    }
}

if (typeof window !== "undefined") {
    window.FleetRoutinesStore = FleetRoutinesStore
}
