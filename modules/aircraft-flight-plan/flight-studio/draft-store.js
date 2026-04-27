"use strict"

/**
 * Flight Studio — per-aircraft draft store (Slice S1).
 *
 * Persists the in-flight FlightSpec the user is composing in the Studio
 * panel, keyed by `<server>:<aircraftId>`. Mirrors `AesAfpStateStore` so
 * the storage layout reads consistently across the AFP module family.
 *
 *   aircraftFlightPlan:studioDraft:<server>:<aircraftId> →
 *     {
 *       server, aircraftId,
 *       spec:    FlightSpec | null,         // current draft
 *       history: FlightSpec[]                // ring buffer (capped)
 *                                             newest first; head = previous
 *                                             draft, NOT current
 *       createdAt, updatedAt
 *     }
 *
 * Slice S1 ships:
 *   - load / save / clear / watch  — basic CRUD
 *   - pushHistory / popHistory     — undo support (ring buffer, cap 10)
 *
 * Save is straightforward replace-write. Debouncing lives in the panel
 * (it's a UI concern, not a storage concern). The store never auto-clears;
 * S5 will hook clearing to `studio:applied` for successful submits.
 *
 * Slice F invariant (HANDOVER §10): the storage prefix is
 * `aircraftFlightPlan:` — never `routeAssistant:`. Single-writer is
 * `flight-studio/panel.js`; other surfaces read but do not write.
 */
class AesAfpStudioDraftStore {
    static PREFIX     = "aircraftFlightPlan:studioDraft:"
    static MAX_HISTORY = 10

    static _key(server, aircraftId) {
        return AesAfpStudioDraftStore.PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    static _emptyRecord(server, aircraftId) {
        return {
            server:     String(server || ""),
            aircraftId: String(aircraftId || ""),
            spec:       null,
            history:    [],
            createdAt:  null,
            updatedAt:  null
        }
    }

    /** Returns the stored record, or a fresh empty one. Always populated. */
    static async load(server, aircraftId) {
        if (!server || !aircraftId) return AesAfpStudioDraftStore._emptyRecord(server, aircraftId)
        const key = AesAfpStudioDraftStore._key(server, aircraftId)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") {
            return AesAfpStudioDraftStore._emptyRecord(server, aircraftId)
        }
        const empty = AesAfpStudioDraftStore._emptyRecord(server, aircraftId)
        return {
            server:     rec.server     || empty.server,
            aircraftId: rec.aircraftId || empty.aircraftId,
            spec:       (rec.spec && typeof rec.spec === "object")  ? rec.spec    : null,
            history:    Array.isArray(rec.history) ? rec.history.slice(0, AesAfpStudioDraftStore.MAX_HISTORY) : [],
            createdAt:  isFinite(rec.createdAt) ? Number(rec.createdAt) : null,
            updatedAt:  isFinite(rec.updatedAt) ? Number(rec.updatedAt) : null
        }
    }

    /**
     * Replace the spec. Pass `{spec, pushPrev: true}` to also push the
     * previous spec onto the history ring before overwriting. Returns the
     * merged record after save.
     *
     * Storage write is content-checked: if the incoming spec is structurally
     * equal to the stored spec (ignoring `updatedAt`), skip the write so
     * `chrome.storage.onChanged` doesn't fan out a no-op event to other
     * tabs (mirrors the wave-applier no-op convention in EVENTS.md §2).
     */
    static async save(server, aircraftId, spec, opts) {
        if (!server || !aircraftId) return null
        const o = opts || {}
        const existing = await AesAfpStudioDraftStore.load(server, aircraftId)
        const now = Date.now()

        // No-op short-circuit. We compare a normalised projection so the
        // user typing a transient invalid char (e.g. partial IATA) without
        // an updatedAt change still skips the write.
        if (existing.spec && spec && _stableEqual(_strip(existing.spec), _strip(spec))) {
            return existing
        }

        let history = existing.history
        if (o.pushPrev && existing.spec) {
            history = [existing.spec].concat(history).slice(0, AesAfpStudioDraftStore.MAX_HISTORY)
        }

        const next = {
            server:     String(server),
            aircraftId: String(aircraftId),
            spec:       spec || null,
            history:    history,
            createdAt:  existing.createdAt || now,
            updatedAt:  now
        }
        const key = AesAfpStudioDraftStore._key(server, aircraftId)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    /**
     * Pop the most recent history entry, restore it as the current spec,
     * and write it back. Returns `{spec, history}` or null if no history.
     *
     * The current spec is NOT pushed onto history during pop — undo unwinds
     * one step; redo (S2+) is a separate concern.
     */
    static async popHistory(server, aircraftId) {
        if (!server || !aircraftId) return null
        const existing = await AesAfpStudioDraftStore.load(server, aircraftId)
        if (!existing.history || !existing.history.length) return null
        const restored = existing.history[0]
        const remaining = existing.history.slice(1)
        const next = Object.assign({}, existing, {
            spec:      restored,
            history:   remaining,
            updatedAt: Date.now()
        })
        const key = AesAfpStudioDraftStore._key(server, aircraftId)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    /** Wipe one aircraft's draft + history. Useful on successful submit
     *  (S5) and Reset CTA. */
    static async clear(server, aircraftId) {
        if (!server || !aircraftId) return
        const key = AesAfpStudioDraftStore._key(server, aircraftId)
        await chrome.storage.local.remove([key])
    }

    /**
     * Subscribe to draft updates across tabs. Mirrors
     * `AesAfpStateStore.watch`. Callback receives
     * `{server, aircraftId, draft, oldDraft}`; returns an unwatch fn.
     */
    static watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                if (key.indexOf(AesAfpStudioDraftStore.PREFIX) !== 0) continue
                const tail = key.slice(AesAfpStudioDraftStore.PREFIX.length)
                const sep = tail.indexOf(":")
                if (sep < 0) continue
                const server     = tail.slice(0, sep)
                const aircraftId = tail.slice(sep + 1)
                try {
                    cb({
                        server,
                        aircraftId,
                        draft:    changes[key].newValue || null,
                        oldDraft: changes[key].oldValue || null
                    })
                } catch (e) { console.warn("[AES studio-draft] watch handler threw", e) }
            }
        }
        try { chrome.storage.onChanged.addListener(handler) }
        catch (_) { return () => {} }
        return () => {
            try { chrome.storage.onChanged.removeListener(handler) }
            catch (_) { /* noop */ }
        }
    }
}

// ── Internals ────────────────────────────────────────────────────────────

/** Strip volatile fields so structural-equality compares only user-content. */
function _strip(spec) {
    if (!spec) return spec
    const c = Object.assign({}, spec)
    delete c.updatedAt
    delete c.createdAt
    return c
}

/** Stable JSON equality with key sort. Cheap; specs are tiny (≤ a few KB). */
function _stableEqual(a, b) {
    return _stableStringify(a) === _stableStringify(b)
}

function _stableStringify(v) {
    if (v == null) return JSON.stringify(v)
    if (typeof v !== "object") return JSON.stringify(v)
    if (Array.isArray(v)) return "[" + v.map(_stableStringify).join(",") + "]"
    const keys = Object.keys(v).sort()
    return "{" + keys.map(k => JSON.stringify(k) + ":" + _stableStringify(v[k])).join(",") + "}"
}

if (typeof window !== "undefined") {
    window.AesAfpStudioDraftStore = AesAfpStudioDraftStore
}
