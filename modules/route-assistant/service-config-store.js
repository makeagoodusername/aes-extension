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
 *   routeAssistant:serviceConfig:<HUB>-<DEST>  →
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
 * Pair key is **directional** (matches RouteAssistantTicketPriceScraper +
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
 */
class RouteAssistantServiceConfigStore {
    static PREFIX = "routeAssistant:serviceConfig:"
    static CLASSES = ["Y", "C", "F"]
    static SERVICE_LEVELS = ["budget", "standard", "premium"]

    static _key(hub, dest) {
        return RouteAssistantServiceConfigStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static async get(hub, dest) {
        const key = RouteAssistantServiceConfigStore._key(hub, dest)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const keys = pairs.map(([h, d]) => RouteAssistantServiceConfigStore._key(h, d))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            const pair = k.substring(RouteAssistantServiceConfigStore.PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Persist a service-config record. Pass null/undefined fields to clear
     * them — they'll fall through to the defaults block in settings. Empty
     * payloads remove the key entirely.
     */
    static async save(hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantServiceConfigStore._clean(fields || {})
        if (!RouteAssistantServiceConfigStore._hasAnyValue(cleaned)) {
            await RouteAssistantServiceConfigStore.remove(hubU, destU)
            return null
        }

        const key = RouteAssistantServiceConfigStore._key(hubU, destU)
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
        const key = RouteAssistantServiceConfigStore._key(hub, dest)
        await chrome.storage.local.remove([key])
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
}
