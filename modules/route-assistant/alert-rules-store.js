"use strict"

/**
 * Alert rules persistence (Daily-driver QoL — Active Prompts).
 *
 * Stores user-defined "fire a notification when X" rules. Each rule
 * names a field tracked by the panel's diff system + an operator +
 * a threshold; on every panel mount the alert-evaluator walks the
 * scoredRows, applies each enabled rule, and fires a toast for any
 * that hit. Rules can be scoped to the watchlist (default) or all
 * visible routes.
 *
 * Storage: single global key `routeAssistant:alertRules` →
 *   {rules: [<RuleRecord>, ...], updatedAt}
 *
 * RuleRecord shape:
 *   {
 *     id:           "rule-<n>",
 *     label:        "RM% spike",                // shown in toast + settings UI
 *     field:        "rmTightness",              // one of RA_DIFF_TRACKED
 *     operator:     "increased_by" | "decreased_by" | "above" | "below",
 *     threshold:    number,                     // operator-dependent units
 *     scope:        "watchlist" | "all",        // default "watchlist"
 *     severity:     "warn" | "info" | "error",  // toast type — defaults to "warn"
 *     enabled:      bool,
 *     cooldownHours: number,                    // suppress same route+rule for N hours
 *     lastFiredByRoute: {<HUB>-<DEST>: msEpoch},
 *     createdAt:    ms,
 *     updatedAt:    ms
 *   }
 *
 * Operators:
 *   - "increased_by"  — fire when row._diff.<field> > threshold
 *   - "decreased_by"  — fire when row._diff.<field> < -threshold
 *   - "above"         — fire when row.<field> > threshold (absolute)
 *   - "below"         — fire when row.<field> < threshold (absolute)
 *
 * The store does not evaluate rules itself; it only persists them.
 * Evaluation lives in `RouteAssistantAlertEvaluator`.
 */
class RouteAssistantAlertRulesStore {
    static STORAGE_KEY = "routeAssistant:alertRules"

    static VALID_OPERATORS = ["increased_by", "decreased_by", "above", "below"]
    static VALID_SCOPES    = ["watchlist", "all"]
    static VALID_SEVERITIES = ["info", "warn", "error"]

    static _scopedKey(accountId) {
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(
                RouteAssistantAlertRulesStore.STORAGE_KEY, accountId)
        }
        return RouteAssistantAlertRulesStore.STORAGE_KEY
    }

    static _resolveAccountId(opts) {
        if (opts && typeof opts.accountId === "string" && opts.accountId) return opts.accountId
        if (typeof globalThis !== "undefined"
            && globalThis.AesAccountScopedKey
            && typeof globalThis.AesAccountScopedKey.currentAccountIdSync === "function") {
            return globalThis.AesAccountScopedKey.currentAccountIdSync()
        }
        return null
    }

    static async load(opts) {
        const acctId = RouteAssistantAlertRulesStore._resolveAccountId(opts)
        const scoped = RouteAssistantAlertRulesStore._scopedKey(acctId)
        const legacy = RouteAssistantAlertRulesStore.STORAGE_KEY
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const data = await chrome.storage.local.get(reqKeys)
        const rec = data[scoped] || data[legacy]
        if (!rec || !Array.isArray(rec.rules)) return {rules: [], updatedAt: null}
        return {
            rules:     rec.rules.map(r => RouteAssistantAlertRulesStore._normalise(r)).filter(Boolean),
            updatedAt: rec.updatedAt || null
        }
    }

    static async saveAll(rules, opts) {
        const acctId = RouteAssistantAlertRulesStore._resolveAccountId(opts)
        const cleaned = (rules || []).map(r => RouteAssistantAlertRulesStore._normalise(r)).filter(Boolean)
        const rec = {rules: cleaned, updatedAt: Date.now()}
        const scoped = RouteAssistantAlertRulesStore._scopedKey(acctId)
        await chrome.storage.local.set({[scoped]: rec})
        return rec
    }

    /** Add a new rule — generates an id, fills timestamps, persists. */
    static async add(partial, opts) {
        const acctId = RouteAssistantAlertRulesStore._resolveAccountId(opts)
        const {rules} = await RouteAssistantAlertRulesStore.load({accountId: acctId})
        const id = "rule-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36)
        const rule = RouteAssistantAlertRulesStore._normalise(Object.assign({
            id:        id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            enabled:   true,
            scope:     "watchlist",
            severity:  "warn",
            cooldownHours: 24,
            lastFiredByRoute: {}
        }, partial || {}))
        if (!rule) throw new Error("RouteAssistantAlertRulesStore: invalid rule")
        rules.push(rule)
        await RouteAssistantAlertRulesStore.saveAll(rules, {accountId: acctId})
        return rule
    }

    /** Patch an existing rule by id. Pass {enabled: false} etc. */
    static async update(id, patch, opts) {
        const acctId = RouteAssistantAlertRulesStore._resolveAccountId(opts)
        const {rules} = await RouteAssistantAlertRulesStore.load({accountId: acctId})
        const idx = rules.findIndex(r => r.id === id)
        if (idx < 0) return null
        const merged = Object.assign({}, rules[idx], patch || {}, {updatedAt: Date.now()})
        const cleaned = RouteAssistantAlertRulesStore._normalise(merged)
        if (!cleaned) return null
        rules[idx] = cleaned
        await RouteAssistantAlertRulesStore.saveAll(rules, {accountId: acctId})
        return cleaned
    }

    /** Record that a rule fired for a route — feeds the cooldown check. */
    static async recordFired(id, routeKey, opts) {
        if (!id || !routeKey) return
        const acctId = RouteAssistantAlertRulesStore._resolveAccountId(opts)
        const {rules} = await RouteAssistantAlertRulesStore.load({accountId: acctId})
        const idx = rules.findIndex(r => r.id === id)
        if (idx < 0) return
        const next = Object.assign({}, rules[idx])
        next.lastFiredByRoute = Object.assign({}, next.lastFiredByRoute || {})
        next.lastFiredByRoute[routeKey] = Date.now()
        next.updatedAt = Date.now()
        rules[idx] = next
        await RouteAssistantAlertRulesStore.saveAll(rules, {accountId: acctId})
    }

    static async remove(id, opts) {
        const acctId = RouteAssistantAlertRulesStore._resolveAccountId(opts)
        const {rules} = await RouteAssistantAlertRulesStore.load({accountId: acctId})
        const next = rules.filter(r => r.id !== id)
        await RouteAssistantAlertRulesStore.saveAll(next, {accountId: acctId})
    }

    /** Validate + coerce a rule record. Returns the cleaned record or null. */
    static _normalise(rule) {
        if (!rule || typeof rule !== "object") return null
        const id    = (typeof rule.id === "string" && rule.id) || null
        const field = (typeof rule.field === "string" && rule.field) || null
        const op    = RouteAssistantAlertRulesStore.VALID_OPERATORS.indexOf(rule.operator) >= 0 ? rule.operator : null
        const threshold = Number(rule.threshold)
        if (!id || !field || !op || !isFinite(threshold)) return null
        const scope    = RouteAssistantAlertRulesStore.VALID_SCOPES.indexOf(rule.scope) >= 0 ? rule.scope : "watchlist"
        const severity = RouteAssistantAlertRulesStore.VALID_SEVERITIES.indexOf(rule.severity) >= 0 ? rule.severity : "warn"
        const cooldownHours = (rule.cooldownHours != null && isFinite(Number(rule.cooldownHours)) && Number(rule.cooldownHours) >= 0)
            ? Number(rule.cooldownHours)
            : 24
        const lastFiredByRoute = (rule.lastFiredByRoute && typeof rule.lastFiredByRoute === "object")
            ? Object.fromEntries(
                Object.entries(rule.lastFiredByRoute).filter(([_, v]) => isFinite(Number(v)))
              )
            : {}
        const label = (typeof rule.label === "string" && rule.label.trim())
            ? rule.label.trim()
            : RouteAssistantAlertRulesStore._defaultLabel(field, op, threshold)
        return {
            id:               id,
            label:            label,
            field:            field,
            operator:         op,
            threshold:        threshold,
            scope:            scope,
            severity:         severity,
            enabled:          rule.enabled !== false,
            cooldownHours:    cooldownHours,
            lastFiredByRoute: lastFiredByRoute,
            createdAt:        Number(rule.createdAt) || Date.now(),
            updatedAt:        Number(rule.updatedAt) || Date.now()
        }
    }

    static _defaultLabel(field, op, threshold) {
        const opLabel = {
            increased_by:  "increased by",
            decreased_by:  "decreased by",
            above:         "above",
            below:         "below"
        }[op] || op
        return field + " " + opLabel + " " + threshold
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantAlertRulesStore
}
