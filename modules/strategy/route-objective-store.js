"use strict"

/**
 * AES Strategy — per-route objective override store (Slice S1).
 *
 * Persists per-route goal overrides. Each record is small —
 * `{kind, custom?, updatedAt}` — so we read/write each pair as its own
 * key (mirrors service-config-store) rather than a single mega-blob.
 *
 * Why per-route override matters: the user picks a global goal in the
 * Strategy panel (max share, max profit, balanced, custom), but some
 * routes need a different goal — e.g. share-leader on a hub-trunk while
 * profit-maxing on a thin spoke. The proposers consult this store first,
 * fall back to global settings if absent.
 *
 * Per-account scoping (Slice 11): two sisters in the same world used to
 * share a single `aesStrategy:routeObjective:HUB-DEST` key, so sister A
 * setting JFK-LHR=maxShare silently overrode sister B's intent. Each
 * record now lives at `aesStrategy:routeObjective:acct:<accountId>:HUB-DEST`.
 * Reads fall back to the legacy unscoped key when the scoped slot is
 * empty so prior overrides keep working during the rollout window.
 *
 * Public API (window.AesStrategyRouteObjectiveStore):
 *   get(hub, dest, accountId?)        → Promise<rec|null>
 *   getMany(pairs, accountId?)        → Promise<Map<"HUB-DEST", rec>>
 *   save(hub, dest, fields, accountId?) → Promise<rec>
 *   remove(hub, dest, accountId?)     → Promise<bool>
 *   list(accountId?)                  → Promise<Array<rec>>      // diagnostic / settings view
 *
 * `fields` shape (all optional except kind):
 *   {kind: "maxShare"|"maxProfit"|"balanced"|"custom",
 *    custom?: {shareWeight, profitWeight, rankWeight},
 *    note?: string}
 */
class AesStrategyRouteObjectiveStore {
    static PREFIX = "aesStrategy:routeObjective:"
    static SCOPE  = "acct:"
    static VALID_KINDS = ["maxShare", "maxProfit", "balanced", "custom"]

    static _pair(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _legacyKey(hub, dest) {
        return AesStrategyRouteObjectiveStore.PREFIX + AesStrategyRouteObjectiveStore._pair(hub, dest)
    }

    static _scopedKey(hub, dest, accountId) {
        if (!accountId) return AesStrategyRouteObjectiveStore._legacyKey(hub, dest)
        return AesStrategyRouteObjectiveStore.PREFIX + AesStrategyRouteObjectiveStore.SCOPE
            + accountId + ":" + AesStrategyRouteObjectiveStore._pair(hub, dest)
    }

    static _normaliseCustom(custom) {
        if (!custom || typeof custom !== "object") return null
        const s = Math.max(0, Number(custom.shareWeight)  || 0)
        const p = Math.max(0, Number(custom.profitWeight) || 0)
        const r = Math.max(0, Number(custom.rankWeight)   || 0)
        const total = s + p + r
        if (total <= 0) return null
        return {shareWeight: s / total, profitWeight: p / total, rankWeight: r / total}
    }

    static async get(hub, dest, accountId) {
        try {
            const scoped = AesStrategyRouteObjectiveStore._scopedKey(hub, dest, accountId)
            const legacy = AesStrategyRouteObjectiveStore._legacyKey(hub, dest)
            const data = scoped === legacy
                ? await chrome.storage.local.get([scoped])
                : await chrome.storage.local.get([scoped, legacy])
            return data[scoped] || data[legacy] || null
        } catch (_) { return null }
    }

    static async getMany(pairs, accountId) {
        const out = new Map()
        if (!pairs || !pairs.length) return out
        const scopedKeys = []
        const legacyKeys = []
        const scopedToPair = new Map()
        const legacyToPair = new Map()
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            if (!h || !d) continue
            const pair    = AesStrategyRouteObjectiveStore._pair(h, d)
            const scoped  = AesStrategyRouteObjectiveStore._scopedKey(h, d, accountId)
            const legacy  = AesStrategyRouteObjectiveStore._legacyKey(h, d)
            scopedKeys.push(scoped)
            scopedToPair.set(scoped, pair)
            if (scoped !== legacy) {
                legacyKeys.push(legacy)
                legacyToPair.set(legacy, pair)
            }
        }
        if (!scopedKeys.length) return out
        try {
            const data = await chrome.storage.local.get(scopedKeys.concat(legacyKeys))
            // Legacy first so scoped entries overwrite when both exist.
            for (const k of legacyKeys) {
                const rec = data[k]
                if (!rec) continue
                const pair = legacyToPair.get(k)
                if (pair) out.set(pair, rec)
            }
            for (const k of scopedKeys) {
                const rec = data[k]
                if (!rec) continue
                const pair = scopedToPair.get(k)
                if (pair) out.set(pair, rec)
            }
        } catch (_) { /* return whatever we got */ }
        return out
    }

    static async save(hub, dest, fields, accountId) {
        if (!hub || !dest) throw new Error("AesStrategyRouteObjectiveStore.save: hub and dest required")
        const f = fields || {}
        const kind = AesStrategyRouteObjectiveStore.VALID_KINDS.indexOf(f.kind) >= 0
            ? f.kind : "balanced"
        const rec = {
            hub:       String(hub).toUpperCase(),
            dest:      String(dest).toUpperCase(),
            accountId: accountId || null,
            kind:      kind,
            custom:    kind === "custom" ? AesStrategyRouteObjectiveStore._normaliseCustom(f.custom) : null,
            note:      f.note ? String(f.note).slice(0, 240) : null,
            updatedAt: Date.now()
        }
        for (const k in rec) if (rec[k] == null) delete rec[k]
        const key = AesStrategyRouteObjectiveStore._scopedKey(hub, dest, accountId)
        await chrome.storage.local.set({[key]: rec})
        return rec
    }

    static async remove(hub, dest, accountId) {
        const scoped = AesStrategyRouteObjectiveStore._scopedKey(hub, dest, accountId)
        const legacy = AesStrategyRouteObjectiveStore._legacyKey(hub, dest)
        try {
            // Drop both so the override doesn't resurrect via legacy fallback
            // after the user clears it.
            await chrome.storage.local.remove(scoped === legacy ? [scoped] : [scoped, legacy])
            return true
        } catch (_) { return false }
    }

    static async list(accountId) {
        try {
            const all = await chrome.storage.local.get(null)
            const out = []
            const scopedPrefix = accountId
                ? AesStrategyRouteObjectiveStore.PREFIX + AesStrategyRouteObjectiveStore.SCOPE + accountId + ":"
                : null
            for (const k in all) {
                if (!k.startsWith(AesStrategyRouteObjectiveStore.PREFIX)) continue
                const rec = all[k]
                if (!rec) continue
                if (scopedPrefix) {
                    // Caller asked for a specific account → include scoped
                    // matches and legacy entries (so unscoped rows still
                    // surface during the rollout).
                    if (k.startsWith(scopedPrefix)) {
                        out.push(rec)
                    } else if (!k.startsWith(AesStrategyRouteObjectiveStore.PREFIX + AesStrategyRouteObjectiveStore.SCOPE)) {
                        out.push(rec)
                    }
                } else {
                    out.push(rec)
                }
            }
            out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            return out
        } catch (_) { return [] }
    }
}

if (typeof window !== "undefined") {
    window.AesStrategyRouteObjectiveStore = AesStrategyRouteObjectiveStore
}
