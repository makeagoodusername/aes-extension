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
 *   routeAssistant:routeNote:<HUB>-<DEST>  →                       (legacy)
 *   routeAssistant:routeNote:acct:<id>:<HUB>-<DEST>  →             (L2+)
 *     {hub, dest, text, createdAt, updatedAt}
 *
 * Empty / whitespace-only text removes the key entirely so a deleted note
 * doesn't leave a tombstone in storage.
 *
 * L2 — namespaced key + legacy fallback (see route-overrides-store.js
 * for the canonical pattern). `saveAt(accountId, …)` is the explicit-
 * account API for Undo restore.
 */
class RouteAssistantRouteNoteStore {
    static LEGACY_PREFIX = "routeAssistant:routeNote:"
    static SCOPE_PREFIX  = "routeAssistant:routeNote"
    static MAX_TEXT_LEN  = 500

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantRouteNoteStore.SCOPE_PREFIX,
            RouteAssistantRouteNoteStore._pairKey(hub, dest))
    }

    static _keyForAccount(accountId, hub, dest) {
        const pair = RouteAssistantRouteNoteStore._pairKey(hub, dest)
        if (!accountId) return RouteAssistantRouteNoteStore.LEGACY_PREFIX + pair
        return RouteAssistantRouteNoteStore.SCOPE_PREFIX + ":acct:" + accountId + ":" + pair
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantRouteNoteStore.LEGACY_PREFIX
            + RouteAssistantRouteNoteStore._pairKey(hub, dest)
    }

    static async get(hub, dest) {
        const ns = RouteAssistantRouteNoteStore._key(hub, dest)
        const lg = RouteAssistantRouteNoteStore._legacyKey(hub, dest)
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
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const nsKeys = []
        const lgKeys = []
        const pairKeys = []
        for (const p of pairs) {
            const [h, d] = Array.isArray(p) ? p : [p.hub, p.dest]
            pairKeys.push(RouteAssistantRouteNoteStore._pairKey(h, d))
            nsKeys.push(RouteAssistantRouteNoteStore._key(h, d))
            lgKeys.push(RouteAssistantRouteNoteStore._legacyKey(h, d))
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
     * Persist a note under the current account scope. Empty or
     * whitespace-only text removes the key. Returns the stored
     * record, or null when removed.
     */
    static async save(hub, dest, fields) {
        return RouteAssistantRouteNoteStore.saveAt(
            currentAccountIdSync(), hub, dest, fields
        )
    }

    static async saveAt(accountId, hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantRouteNoteStore._clean(fields || {})
        if (cleaned.text === undefined) {
            await RouteAssistantRouteNoteStore.removeAt(accountId, hubU, destU)
            return null
        }

        const key = RouteAssistantRouteNoteStore._keyForAccount(accountId, hubU, destU)
        const existing = (await chrome.storage.local.get([key]))[key] || null
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

    static async remove(hub, dest) {
        return RouteAssistantRouteNoteStore.removeAt(
            currentAccountIdSync(), hub, dest
        )
    }

    static async removeAt(accountId, hub, dest) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return
        const ns = RouteAssistantRouteNoteStore._keyForAccount(accountId, hubU, destU)
        const lg = RouteAssistantRouteNoteStore._legacyKey(hubU, destU)
        const keys = (ns === lg) ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
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

    /** L2 deprecated — preserve for any reader still doing key arithmetic. */
    static get PREFIX() { return RouteAssistantRouteNoteStore.LEGACY_PREFIX }
}
