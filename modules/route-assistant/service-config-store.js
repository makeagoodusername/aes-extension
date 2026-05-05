"use strict"

/**
 * Per-route service-config store for the Route Assistant.
 *
 * Holds the user's class-mix (Y/C/F seat split) and service-level posture
 * for a single route, plus optional per-class yield + per-pax cost
 * overrides. The aggregator + profit estimator read these to project
 * seats-offered-per-class-per-week and a class-aware revenue/cost
 * breakdown.
 *
 *   routeAssistant:serviceConfig:<HUB>-<DEST>  →                       (legacy)
 *   routeAssistant:serviceConfig:acct:<id>:<HUB>-<DEST>  →             (L2+)
 *     {hub, dest,
 *      classMix:    {Y, C, F},                           // fractions, sum to 1
 *      serviceLevel: "budget"|"standard"|"premium"|null, // null = inherit defaults
 *      classFares: {
 *        Y: {yieldPerKm?, costPerPax?},                  // null = inherit defaults
 *        C: {yieldPerKm?, costPerPax?},
 *        F: {yieldPerKm?, costPerPax?}
 *      },
 *      note?, createdAt, updatedAt}
 *
 * Pair key is **directional** (matches RouteAssistantSchedulePageScraper +
 * RouteAssistantRouteOverridesStore) — class mix and service level might
 * legitimately differ outbound vs inbound (e.g. business-heavy outbound,
 * leisure-heavy inbound).
 *
 * Class codes follow IATA conventions:
 *   Y = Economy
 *   C = Business
 *   F = First
 * AS uses similar single-letter codes on the inventory page; if Tier 2b
 * brings real fares we'll cross-check.
 *
 * L2 — namespaced key + legacy fallback (audit/streamline-A7.md F-3):
 *   - `_key` routes through `acctKey()` so writes land in the
 *     account-namespaced slot once `window.__aesAccountId` is set.
 *   - `get` / `getMany` read the namespaced key first, then fall back
 *     to the legacy key. Migration is additive; legacy stays live as
 *     fallback so sister-airline data already on disk still resolves.
 *   - `saveAt(accountId, …)` is the explicit-account API. `save()` is
 *     a thin wrapper that captures `currentAccountIdSync()` and
 *     delegates.
 *   - `remove` clears BOTH the namespaced AND legacy key — explicit
 *     user removes are intentionally absolute.
 */
class RouteAssistantServiceConfigStore {
    static LEGACY_PREFIX = "routeAssistant:serviceConfig:"
    static SCOPE_PREFIX  = "routeAssistant:serviceConfig"
    static CLASSES = ["Y", "C", "F"]
    static SERVICE_LEVELS = ["budget", "standard", "premium"]

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        const pair = RouteAssistantServiceConfigStore._pairKey(hub, dest)
        if (typeof acctKey === "function") {
            return acctKey(RouteAssistantServiceConfigStore.SCOPE_PREFIX, pair)
        }
        // No global acctKey helper available — fall through to legacy
        // shape so reads/writes still hit a stable slot.
        return RouteAssistantServiceConfigStore.LEGACY_PREFIX + pair
    }

    static _keyForAccount(accountId, hub, dest) {
        const pair = RouteAssistantServiceConfigStore._pairKey(hub, dest)
        if (!accountId) return RouteAssistantServiceConfigStore.LEGACY_PREFIX + pair
        if (typeof acctKeyForAccount === "function") {
            return acctKeyForAccount(RouteAssistantServiceConfigStore.SCOPE_PREFIX, accountId, pair)
        }
        if (typeof window !== "undefined"
                && window.AesAccountKey
                && typeof window.AesAccountKey.acctKeyForAccount === "function") {
            return window.AesAccountKey.acctKeyForAccount(
                RouteAssistantServiceConfigStore.SCOPE_PREFIX, accountId, pair)
        }
        return RouteAssistantServiceConfigStore.SCOPE_PREFIX + ":acct:" + accountId + ":" + pair
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantServiceConfigStore.LEGACY_PREFIX
            + RouteAssistantServiceConfigStore._pairKey(hub, dest)
    }

    static async get(hub, dest) {
        const accountId = (typeof currentAccountIdSync === "function")
            ? currentAccountIdSync()
            : null
        return RouteAssistantServiceConfigStore.getAt(accountId, hub, dest)
    }

    static async getAt(accountId, hub, dest) {
        const ns = RouteAssistantServiceConfigStore._keyForAccount(accountId, hub, dest)
        const lg = RouteAssistantServiceConfigStore._legacyKey(hub, dest)
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            return out[ns] || null
        }
        const out = await chrome.storage.local.get([ns, lg])
        if (out[ns] !== undefined) return out[ns]
        return out[lg] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs. Returns
     * Map<pairKey, record> where pairKey is "<HUB>-<DEST>".
     * Namespaced wins per pair; legacy fills gaps so pre-migration
     * records are still surfaced until they are rewritten.
     */
    static async getMany(pairs) {
        const accountId = (typeof currentAccountIdSync === "function")
            ? currentAccountIdSync()
            : null
        return RouteAssistantServiceConfigStore.getManyAt(accountId, pairs)
    }

    static async getManyAt(accountId, pairs) {
        if (!pairs || !pairs.length) return new Map()
        const nsKeys   = []
        const lgKeys   = []
        const pairKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantServiceConfigStore._pairKey(h, d))
            nsKeys.push(RouteAssistantServiceConfigStore._keyForAccount(accountId, h, d))
            lgKeys.push(RouteAssistantServiceConfigStore._legacyKey(h, d))
        }
        const all = []
        for (const k of nsKeys) all.push(k)
        for (const k of lgKeys) if (all.indexOf(k) < 0) all.push(k)
        const out = await chrome.storage.local.get(all)
        const map = new Map()
        for (let i = 0; i < pairs.length; i++) {
            const ns = nsKeys[i]
            const lg = lgKeys[i]
            const rec = out[ns] !== undefined ? out[ns] : (out[lg] || null)
            if (rec) map.set(pairKeys[i], rec)
        }
        return map
    }

    /**
     * Persist a service-config record. Pass null/undefined fields to clear
     * them — they'll fall through to the defaults block in settings. Empty
     * payloads remove the key entirely.
     */
    static async save(hub, dest, fields) {
        const accountId = (typeof currentAccountIdSync === "function")
            ? currentAccountIdSync()
            : null
        return RouteAssistantServiceConfigStore.saveAt(accountId, hub, dest, fields)
    }

    static async saveAt(accountId, hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantServiceConfigStore._clean(fields || {})
        if (!RouteAssistantServiceConfigStore._hasAnyValue(cleaned)) {
            await RouteAssistantServiceConfigStore.removeAt(accountId, hubU, destU)
            return null
        }

        const key = RouteAssistantServiceConfigStore._keyForAccount(accountId, hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
        const now = Date.now()
        const record = Object.assign(
            {hub: hubU, dest: destU, createdAt: (existing && existing.createdAt) || now},
            cleaned,
            {hub: hubU, dest: destU, updatedAt: now}
        )
        await chrome.storage.local.set({[key]: record})
        return record
    }

    static async remove(hub, dest) {
        const accountId = (typeof currentAccountIdSync === "function")
            ? currentAccountIdSync()
            : null
        return RouteAssistantServiceConfigStore.removeAt(accountId, hub, dest)
    }

    static async removeAt(accountId, hub, dest) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return
        const ns = RouteAssistantServiceConfigStore._keyForAccount(accountId, hubU, destU)
        const lg = RouteAssistantServiceConfigStore._legacyKey(hubU, destU)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
    }

    /**
     * Sanitise an incoming fields object: classMix gets renormalised to sum
     * to 1; service level is enum-checked; per-class fares get bounds-checked
     * the same way the LF/yield override store does.
     */
    static _clean(fields) {
        const out = {}
        // classMix
        const mix = fields.classMix
        if (mix && typeof mix === "object") {
            const norm = RouteAssistantServiceConfigStore.normaliseMix(mix)
            if (norm) out.classMix = norm
        }
        // serviceLevel
        if (typeof fields.serviceLevel === "string"
                && RouteAssistantServiceConfigStore.SERVICE_LEVELS.includes(fields.serviceLevel)) {
            out.serviceLevel = fields.serviceLevel
        }
        // classFares
        if (fields.classFares && typeof fields.classFares === "object") {
            const cf = {}
            for (const cls of RouteAssistantServiceConfigStore.CLASSES) {
                const src = fields.classFares[cls]
                if (!src || typeof src !== "object") continue
                const dst = {}
                const y = Number(src.yieldPerKm)
                const c = Number(src.costPerPax)
                if (isFinite(y) && y >= 0 && y <= 100) dst.yieldPerKm = y
                if (isFinite(c) && c >= 0 && c <= 100000) dst.costPerPax = c
                if (Object.keys(dst).length) cf[cls] = dst
            }
            if (Object.keys(cf).length) out.classFares = cf
        }
        if (typeof fields.note === "string" && fields.note.trim() !== "") {
            out.note = fields.note.trim().substring(0, 200)
        }
        return out
    }

    static _hasAnyValue(cleaned) {
        return cleaned.classMix !== undefined
            || cleaned.serviceLevel !== undefined
            || cleaned.classFares !== undefined
            || cleaned.note !== undefined
    }

    /**
     * Normalise a {Y, C, F} mix to fractions summing to 1. Accepts percent
     * (0-100) inputs via auto-detection: any value > 1.5 forces percent
     * interpretation. Returns null when the input is empty or all zero.
     */
    static normaliseMix(raw) {
        if (!raw) return null
        const vals = {}
        let total = 0
        let asPct = false
        for (const cls of RouteAssistantServiceConfigStore.CLASSES) {
            const v = Number(raw[cls])
            if (!isFinite(v) || v < 0) { vals[cls] = 0; continue }
            vals[cls] = v
            total += v
            if (v > 1.5) asPct = true
        }
        if (total <= 0) return null
        if (asPct) total = total / 100  // rescale assuming user-entered percents
        const factor = total > 0 ? (1 / (asPct ? total * 100 : total)) : 1
        const out = {}
        let sum = 0
        for (const cls of RouteAssistantServiceConfigStore.CLASSES) {
            out[cls] = Math.max(0, Math.min(1, vals[cls] * factor))
            sum += out[cls]
        }
        // Floating-point cleanup: ensure exact 1.0 by adjusting the largest bucket.
        if (sum > 0 && Math.abs(sum - 1) > 1e-6) {
            let bigKey = "Y", bigVal = -1
            for (const cls of RouteAssistantServiceConfigStore.CLASSES) {
                if (out[cls] > bigVal) { bigKey = cls; bigVal = out[cls] }
            }
            out[bigKey] += (1 - sum)
        }
        return out
    }

    /**
     * Resolve the effective config for a route, deep-merging the per-route
     * record with the settings defaults so the aggregator gets a fully-
     * populated object regardless of which fields the user has tuned.
     *
     * Resolution priority for class mix:
     *   1. record.classMix (per-route override)
     *   2. tailMix (auto-detected from the assigned tail's seat counts)
     *   3. defaults.defaultClassMix (settings)
     *   4. {Y: 1, C: 0, F: 0} (single-class fallback)
     */
    static resolveEffective(record, defaults, tailMix) {
        const cls = RouteAssistantServiceConfigStore.CLASSES
        const def = defaults || {}
        const out = {
            classMix:     null,
            serviceLevel: null,
            classFares:   {},
            source:       {classMix: "default", serviceLevel: "default"}
        }
        const routeMix = record && record.classMix
            ? RouteAssistantServiceConfigStore.normaliseMix(record.classMix) : null
        const tail     = tailMix
            ? RouteAssistantServiceConfigStore.normaliseMix(tailMix) : null
        if (routeMix) {
            out.classMix = routeMix
            out.source.classMix = "route"
        } else if (tail) {
            out.classMix = tail
            out.source.classMix = "tail"
        } else {
            out.classMix = RouteAssistantServiceConfigStore.normaliseMix(def.defaultClassMix)
                           || {Y: 1, C: 0, F: 0}
            out.source.classMix = "default"
        }
        // Service level
        out.serviceLevel = (record && record.serviceLevel) || def.defaultServiceLevel || "standard"
        out.source.serviceLevel = (record && record.serviceLevel) ? "route" : "default"
        // Class fares — start from defaults, override with record.
        const defYieldMult     = def.classYieldMult     || {Y: 1.0, C: 2.5, F: 4.5}
        const defCostPerPax    = def.classCostPerPax    || {Y: 5,   C: 18,  F: 45}
        const recFares = (record && record.classFares) || {}
        for (const cl of cls) {
            const r = recFares[cl] || {}
            out.classFares[cl] = {
                yieldMult:        defYieldMult[cl]  != null ? Number(defYieldMult[cl])  : 1,
                costPerPax:       defCostPerPax[cl] != null ? Number(defCostPerPax[cl]) : 0,
                yieldPerKmOverride: r.yieldPerKm != null ? Number(r.yieldPerKm) : null,
                costPerPaxOverride: r.costPerPax != null ? Number(r.costPerPax) : null
            }
        }
        // Service-level multiplier — applied on top of yields.
        const levels = def.serviceLevels || {}
        const lvl = levels[out.serviceLevel] || {}
        out.serviceLevelYieldMult = isFinite(Number(lvl.yieldMult)) ? Number(lvl.yieldMult) : 1
        out.serviceLevelCostPerPax = isFinite(Number(lvl.costPerPax)) ? Number(lvl.costPerPax) : 0
        return out
    }

    /** L2 deprecated alias — preserve for any reader still doing key arithmetic. */
    static get PREFIX() { return RouteAssistantServiceConfigStore.LEGACY_PREFIX }
}

if (typeof window !== "undefined") {
    window.RouteAssistantServiceConfigStore = RouteAssistantServiceConfigStore
}
