"use strict"

/**
 * Flight Studio — per-server templates store (Slice F2).
 *
 * Persists named Flight Studio configurations ("Morning shuttle",
 * "Long-haul evening", "Cargo overnight") so the user can reload a
 * pricing/service/turn pattern in one click. Templates capture only the
 * parametric fields — never the OD pair — so the same template can
 * apply across many routes.
 *
 *   flightStudio:templates:<server>  →  Template[]
 *
 *   Template = {
 *       schemaVersion: 1,
 *       id:            "<id>",       // crypto.randomUUID()
 *       name:          "<string>",   // user-supplied, ≤ 60 chars, unique per server
 *       pricePct:      50..200,      // integer percent
 *       service:       "<string>",   // option value (e.g. "719"); "" = AS default
 *       depTimeLocal:  "HH:MM",      // captured but NOT applied back (metadata)
 *       turnMin:       0..1439,      // minutes
 *       fromIata?:     "JFK",        // optional metadata; never overwrites legs[].origin
 *       notes?:        "<string>",
 *       createdAt:     <ms>,
 *       updatedAt:     <ms>
 *   }
 *
 * `schemaVersion` lives on each Template so F3 can extend the shape (e.g.
 * multi-leg templates) without a storage migration — readers filter on
 * `schemaVersion === 1`, future writers bump.
 *
 * Server-local only — no cross-server export in F2 (deferred to a later
 * slice via `bulkLoad()`).
 */
;(function () {
    if (window.AesAfpFlightStudioTemplatesStore) return

    const PREFIX         = "flightStudio:templates:"
    const SCHEMA_VERSION = 1
    const MAX_NAME_LEN   = 60
    const MAX_NOTES_LEN  = 500

    function _key(server) {
        return PREFIX + String(server || "")
    }

    function _genId() {
        try {
            if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
                return crypto.randomUUID()
            }
        } catch (_) { /* fall through */ }
        return "tmpl-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
    }

    function _asPct(v) {
        if (v == null || v === "") return null
        const n = Math.round(Number(v))
        return (isFinite(n) && n >= 50 && n <= 200) ? n : null
    }

    function _asHHMM(v) {
        const s = String(v == null ? "" : v).trim()
        const m = s.match(/^(\d{1,2}):(\d{2})$/)
        if (!m) return null
        const h  = parseInt(m[1], 10)
        const mn = parseInt(m[2], 10)
        if (!(h >= 0 && h <= 23) || !(mn >= 0 && mn <= 59)) return null
        return (h < 10 ? "0" + h : String(h)) + ":" + (mn < 10 ? "0" + mn : String(mn))
    }

    function _asIata(v) {
        const s = String(v == null ? "" : v).trim().toUpperCase()
        return /^[A-Z]{3}$/.test(s) ? s : null
    }

    function _asTurn(v) {
        const n = Math.round(Number(v))
        return (isFinite(n) && n >= 0 && n < 1440) ? n : null
    }

    function _asName(v) {
        const s = String(v == null ? "" : v).trim()
        return s ? s.slice(0, MAX_NAME_LEN) : null
    }

    function _asNotes(v) {
        if (v == null) return null
        const s = String(v).trim()
        return s ? s.slice(0, MAX_NOTES_LEN) : null
    }

    /** Coerce + clamp an arbitrary object into a clean Template. Returns
     *  null when the required fields can't be resolved (missing name /
     *  pricePct / depTimeLocal). */
    function _normalize(t) {
        if (!t || typeof t !== "object") return null
        const name    = _asName(t.name)
        const price   = _asPct(t.pricePct)
        const dep     = _asHHMM(t.depTimeLocal)
        const turn    = _asTurn(t.turnMin)
        if (!name || price == null || !dep || turn == null) return null
        const now = Date.now()
        const out = {
            schemaVersion: SCHEMA_VERSION,
            id:            (typeof t.id === "string" && t.id) ? t.id : _genId(),
            name:          name,
            pricePct:      price,
            service:       typeof t.service === "string" ? t.service : "",
            depTimeLocal:  dep,
            turnMin:       turn,
            createdAt:     isFinite(t.createdAt) ? Number(t.createdAt) : now,
            updatedAt:     now
        }
        const from = _asIata(t.fromIata)
        if (from) out.fromIata = from
        const notes = _asNotes(t.notes)
        if (notes) out.notes = notes
        return out
    }

    /** Filter loaded array to schema-matched, well-formed entries. Sorted
     *  by name (case-insensitive) for stable dropdown order. */
    function _cleanArray(raw) {
        if (!Array.isArray(raw)) return []
        const out = []
        for (const t of raw) {
            if (!t || t.schemaVersion !== SCHEMA_VERSION) continue
            const norm = _normalize(t)
            if (norm) out.push(norm)
        }
        out.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"}))
        return out
    }

    /** All templates for `server`, sorted by name. Empty array when
     *  unset or malformed. */
    async function loadAll(server) {
        if (!server) return []
        const key = _key(server)
        const out = await chrome.storage.local.get([key])
        return _cleanArray(out[key])
    }

    /** Insert or update by id. New templates get a fresh id + createdAt;
     *  existing ones preserve createdAt and refresh updatedAt. Returns the
     *  saved Template (after normalization), or null when the input is
     *  unsalvageable. Names must be unique per server (case-insensitive);
     *  a duplicate name on a NEW template is rejected with `null`. */
    async function save(server, tmpl) {
        if (!server) return null
        const list = await loadAll(server)
        const incoming = _normalize(tmpl)
        if (!incoming) return null
        const lname = incoming.name.toLowerCase()
        const existingIdx = list.findIndex(t => t.id === incoming.id)
        const dupeIdx = list.findIndex(t => t.name.toLowerCase() === lname && t.id !== incoming.id)
        if (dupeIdx >= 0) return null
        if (existingIdx >= 0) {
            // Preserve original createdAt on update.
            incoming.createdAt = list[existingIdx].createdAt
            list[existingIdx] = incoming
        } else {
            list.push(incoming)
        }
        const next = _cleanArray(list)
        await chrome.storage.local.set({[_key(server)]: next})
        return incoming
    }

    /** Remove by id. No-op when absent. Returns true if a row was removed. */
    async function remove(server, id) {
        if (!server || !id) return false
        const list = await loadAll(server)
        const next = list.filter(t => t.id !== id)
        if (next.length === list.length) return false
        await chrome.storage.local.set({[_key(server)]: next})
        return true
    }

    /** Cross-server snapshot: `{<server>: Template[]}` for every key under
     *  `flightStudio:templates:`. Used by future export/import paths. */
    async function bulkLoad() {
        const all = await chrome.storage.local.get(null)
        const out = {}
        for (const k in all) {
            if (k.indexOf(PREFIX) !== 0) continue
            const server = k.slice(PREFIX.length)
            if (!server) continue
            out[server] = _cleanArray(all[k])
        }
        return out
    }

    window.AesAfpFlightStudioTemplatesStore = {
        SCHEMA_VERSION,
        MAX_NAME_LEN,
        MAX_NOTES_LEN,
        loadAll,
        save,
        remove,
        bulkLoad
    }
})()
