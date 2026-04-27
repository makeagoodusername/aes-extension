/**
 * Per-route free-text note store for the Route Assistant.
 *
 * Long-running games accumulate context that doesn't fit any of the
 * structured override fields ("tried 2x daily, dropped — too much C-class
 * capacity"; "watching for AA entry"; "served by partner under interline").
 * This store keeps that text tied to the specific route the user is
 * thinking about, surfaced inline as a 📝 glyph on the Dest cell of the
 * Route Assistant panel.
 *
 * Pair key is **directional** to match `RouteAssistantRouteOverridesStore`
 * — outbound vs inbound notes are uncommon but cheap to support, and
 * users may want to distinguish "JFK→LAX is my flagship" from "LAX→JFK
 * struggles with cargo demand".
 *
 *   routeAssistant:routeNote:<HUB>-<DEST>  →
 *     {hub, dest, text, createdAt, updatedAt}
 *
 * Empty / whitespace-only text removes the key entirely so a deleted note
 * doesn't leave a tombstone in storage.
 */
class RouteAssistantRouteNoteStore {
    static PREFIX = "routeAssistant:routeNote:"
    static MAX_TEXT_LEN = 500

    static _legacyKey(hub, dest) {
        return RouteAssistantRouteNoteStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _key(hub, dest, accountId) {
        const legacy = RouteAssistantRouteNoteStore._legacyKey(hub, dest)
        if (typeof globalThis !== "undefined" && globalThis.AesAccountScopedKey) {
            return globalThis.AesAccountScopedKey.acctKey(legacy, accountId)
        }
        return legacy
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

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static async get(hub, dest, opts) {
        const acctId = RouteAssistantRouteNoteStore._resolveAccountId(opts)
        const scoped = RouteAssistantRouteNoteStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRouteNoteStore._legacyKey(hub, dest)
        const reqKeys = scoped === legacy ? [scoped] : [scoped, legacy]
        const out = await chrome.storage.local.get(reqKeys)
        return out[scoped] || out[legacy] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs. Returns
     * Map<pairKey, record> where pairKey is "<HUB>-<DEST>".
     */
    static async getMany(pairs, opts) {
        if (!pairs || !pairs.length) return new Map()
        const acctId = RouteAssistantRouteNoteStore._resolveAccountId(opts)
        const scopedKeys = []
        const legacyKeys = []
        const pairList   = []
        for (const [h, d] of pairs) {
            scopedKeys.push(RouteAssistantRouteNoteStore._key(h, d, acctId))
            legacyKeys.push(RouteAssistantRouteNoteStore._legacyKey(h, d))
            pairList.push(RouteAssistantRouteNoteStore._pairKey(h, d))
        }
        const reqKeys = acctId ? scopedKeys.concat(legacyKeys) : scopedKeys
        const out = await chrome.storage.local.get(reqKeys)
        const map = new Map()
        for (let i = 0; i < pairList.length; i++) {
            const rec = out[scopedKeys[i]] || out[legacyKeys[i]] || null
            if (rec) map.set(pairList[i], rec)
        }
        return map
    }

    /**
     * Persist a note. Empty or whitespace-only text removes the key.
     * Returns the stored record, or null when removed.
     */
    static async save(hub, dest, fields, opts) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        const acctId = RouteAssistantRouteNoteStore._resolveAccountId(opts)

        const cleaned = RouteAssistantRouteNoteStore._clean(fields || {})
        if (cleaned.text === undefined) {
            await RouteAssistantRouteNoteStore.remove(hubU, destU, {accountId: acctId})
            return null
        }

        const key = RouteAssistantRouteNoteStore._key(hubU, destU, acctId)
        const legacy = RouteAssistantRouteNoteStore._legacyKey(hubU, destU)
        const reqKeys = key === legacy ? [key] : [key, legacy]
        const existingMap = await chrome.storage.local.get(reqKeys)
        const existing = existingMap[key] || existingMap[legacy] || null
        const now = Date.now()
        const record = {
            hub:       hubU,
            dest:      destU,
            text:      cleaned.text,
            createdAt: (existing && existing.createdAt) || now,
            updatedAt: now
        }
        await chrome.storage.local.set({[key]: record})
        return record
    }

    static async remove(hub, dest, opts) {
        const acctId = RouteAssistantRouteNoteStore._resolveAccountId(opts)
        const key = RouteAssistantRouteNoteStore._key(hub, dest, acctId)
        const legacy = RouteAssistantRouteNoteStore._legacyKey(hub, dest)
        const toRemove = key === legacy ? [key] : [key, legacy]
        await chrome.storage.local.remove(toRemove)
    }

    /**
     * Trim + bound the note text. Returns `{}` for empty / non-string
     * input so save() collapses it into a remove().
     */
    static _clean(fields) {
        const out = {}
        if (typeof fields.text !== "string") return out
        const trimmed = fields.text.trim()
        if (!trimmed) return out
        out.text = trimmed.substring(0, RouteAssistantRouteNoteStore.MAX_TEXT_LEN)
        return out
    }
}
