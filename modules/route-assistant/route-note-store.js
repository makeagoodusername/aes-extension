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

    static _key(hub, dest) {
        return RouteAssistantRouteNoteStore.PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static async get(hub, dest) {
        const key = RouteAssistantRouteNoteStore._key(hub, dest)
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    /**
     * Bulk read for a list of [hub, dest] pairs. Returns
     * Map<pairKey, record> where pairKey is "<HUB>-<DEST>".
     */
    static async getMany(pairs) {
        if (!pairs || !pairs.length) return new Map()
        const keys = pairs.map(([h, d]) => RouteAssistantRouteNoteStore._key(h, d))
        const out = await chrome.storage.local.get(keys)
        const map = new Map()
        for (const k in out) {
            const rec = out[k]
            if (!rec) continue
            const pair = k.substring(RouteAssistantRouteNoteStore.PREFIX.length)
            map.set(pair, rec)
        }
        return map
    }

    /**
     * Persist a note. Empty or whitespace-only text removes the key.
     * Returns the stored record, or null when removed.
     */
    static async save(hub, dest, fields) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null

        const cleaned = RouteAssistantRouteNoteStore._clean(fields || {})
        if (cleaned.text === undefined) {
            await RouteAssistantRouteNoteStore.remove(hubU, destU)
            return null
        }

        const key = RouteAssistantRouteNoteStore._key(hubU, destU)
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
        const key = RouteAssistantRouteNoteStore._key(hub, dest)
        await chrome.storage.local.remove([key])
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
