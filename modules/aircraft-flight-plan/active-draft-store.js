"use strict"

/**
 * Per-aircraft live schedule draft — the bi-directional sync surface between
 * the Fleet Hub overlay (on /app/fleets) and the AFP wave-applier slot
 * (on /app/fleets/aircraft/<id>/0). Both panels read this record, write to
 * it, and re-render via chrome.storage.onChanged when the other side edits.
 *
 *   aircraftFlightPlan:draft:<server>:<aircraftId> →
 *     {server, aircraftId, hub,
 *      presetId:    string | null,
 *      generatedAt: number | null,
 *      flights:     Build.flights[],            // canonical (RouteAssistantWaveOverlay shape)
 *      perLegEdits: { [seq]: {origin?, destination?, depTimeLocal?, pricePct?, service?} },
 *      appliedLegs: { [seq]: appliedAt },
 *      dismissedLegs: { [seq]: dismissedAt },
 *      createdAt, updatedAt}
 *
 * `seq` is the canonical leg identifier produced by ScheduleBuilder /
 * RouteAssistantWaveOverlay.buildSchedule (used today by warnings filter
 * at modules/aircraft-flight-plan/wave-applier.js:418).
 *
 * Distinct from AesAfpStateStore (`aircraftFlightPlan:state:`):
 *   - state-store holds the user's manual draftedPlan + dismissedCandidates
 *     + per-aircraft location, written from the AFP page on every mount.
 *   - active-draft-store holds the wave-built schedule plus the per-leg
 *     edit/apply/dismiss overlay; it's only populated once Generate runs
 *     on either surface, and is shared bi-directionally.
 *
 * `setApplied` / `setDismissed` / `setEdit` / `setPreset` / `setFlights`
 * are read-modify-write helpers so callers don't have to fetch first.
 */
class AesAfpActiveDraftStore {
    static PREFIX = "aircraftFlightPlan:draft:"

    static _key(server, aircraftId) {
        return AesAfpActiveDraftStore.PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    static _emptyState(server, aircraftId) {
        return {
            server:        String(server || ""),
            aircraftId:    String(aircraftId || ""),
            hub:           null,
            presetId:      null,
            generatedAt:   null,
            flights:       [],
            // Track-3 build.metadata snapshot — preserves budgetUsedHours /
            // totalScore / algo so the auto-preview's WEEKLY / SCORE cells
            // can survive a page reload. null when nothing has been built
            // yet, or for non-allocator-sourced drafts.
            metadata:      null,
            perLegEdits:   {},
            appliedLegs:   {},
            dismissedLegs: {},
            createdAt:     null,
            updatedAt:     null
        }
    }

    /**
     * Returns the stored draft, or a fresh empty record if nothing has been
     * persisted yet. Always returns a fully-populated object — defensive
     * default-fill so callers don't have to.
     */
    static async load(server, aircraftId) {
        if (!server || !aircraftId) return AesAfpActiveDraftStore._emptyState(server, aircraftId)
        const key = AesAfpActiveDraftStore._key(server, aircraftId)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") {
            return AesAfpActiveDraftStore._emptyState(server, aircraftId)
        }
        const empty = AesAfpActiveDraftStore._emptyState(server, aircraftId)
        const asString = v => typeof v === "string" ? v : null
        const asFinite = v => (typeof v === "number" && isFinite(v)) ? v : null
        const asArray  = v => Array.isArray(v) ? v : []
        const asMap    = v => (v && typeof v === "object" && !Array.isArray(v)) ? v : {}
        return {
            server:        rec.server     || empty.server,
            aircraftId:    rec.aircraftId || empty.aircraftId,
            hub:           asString(rec.hub),
            presetId:      asString(rec.presetId),
            generatedAt:   asFinite(rec.generatedAt),
            flights:       asArray(rec.flights),
            metadata:      (rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata))
                ? rec.metadata : null,
            perLegEdits:   asMap(rec.perLegEdits),
            appliedLegs:   asMap(rec.appliedLegs),
            dismissedLegs: asMap(rec.dismissedLegs),
            createdAt:     asFinite(rec.createdAt),
            updatedAt:     asFinite(rec.updatedAt)
        }
    }

    /**
     * Persist a partial patch. Fields omitted from `patch` fall through.
     * Returns the merged record.
     *
     * F-9228-901: serialised per-key through a tail Promise so concurrent
     * setApplied / setDismissed / setEdit calls (and any other read-modify-
     * write helper) don't lose each other's writes via the same
     * load-then-set race that bit AesSettings.saveArea (F-9223-002). Same
     * realm/single-tab coverage; cross-tab races on the same key remain
     * inherent and would need a background single-writer for full coverage.
     */
    static async save(server, aircraftId, patch) {
        if (!server || !aircraftId) return null
        return AesAfpActiveDraftStore._enqueue(server, aircraftId, () =>
            AesAfpActiveDraftStore._saveImpl(server, aircraftId, patch))
    }

    static _enqueue(server, aircraftId, task) {
        const key = AesAfpActiveDraftStore._key(server, aircraftId)
        const queue = AesAfpActiveDraftStore._saveQueue
        const tail = queue.get(key) || Promise.resolve()
        const next = tail.then(task)
        // Swallow rejections in the chain so a single failure doesn't poison
        // every subsequent save; callers still see their own rejection.
        queue.set(key, next.catch(() => {}))
        return next
    }

    static async _saveImpl(server, aircraftId, patch) {
        const existing = await AesAfpActiveDraftStore.load(server, aircraftId)
        const now = Date.now()
        const p = patch || {}
        const has = k => Object.prototype.hasOwnProperty.call(p, k)

        const next = {
            server:        String(server),
            aircraftId:    String(aircraftId),
            hub:           has("hub")           ? (p.hub || null)             : existing.hub,
            presetId:      has("presetId")      ? (p.presetId || null)        : existing.presetId,
            generatedAt:   has("generatedAt")   ? (p.generatedAt || null)     : existing.generatedAt,
            flights:       has("flights")       ? (Array.isArray(p.flights) ? p.flights.slice() : [])
                                                : existing.flights,
            metadata:      has("metadata")
                ? ((p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata))
                    ? p.metadata : null)
                : existing.metadata,
            perLegEdits:   has("perLegEdits")   ? Object.assign({}, p.perLegEdits || {})   : existing.perLegEdits,
            appliedLegs:   has("appliedLegs")   ? Object.assign({}, p.appliedLegs || {})   : existing.appliedLegs,
            dismissedLegs: has("dismissedLegs") ? Object.assign({}, p.dismissedLegs || {}) : existing.dismissedLegs,
            createdAt:     existing.createdAt || now,
            updatedAt:     now
        }
        const key = AesAfpActiveDraftStore._key(server, aircraftId)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    static _saveQueue = new Map()

    /**
     * Replace the canonical build output (preset + flights). Clears
     * perLegEdits / appliedLegs / dismissedLegs since seq numbers are
     * regenerated on each build — keeping stale overlays would attach
     * old edits to unrelated legs.
     */
    static async setFlights(server, aircraftId, opts) {
        const o = opts || {}
        return AesAfpActiveDraftStore.save(server, aircraftId, {
            hub:           o.hub || null,
            presetId:      o.presetId || null,
            generatedAt:   o.generatedAt || Date.now(),
            flights:       Array.isArray(o.flights) ? o.flights : [],
            // Pass-through Track-3 build.metadata when supplied so the
            // auto-preview can repaint WEEKLY/SCORE without a re-run.
            // Coerced to null in save() if shape isn't an object.
            metadata:      (o.metadata && typeof o.metadata === "object") ? o.metadata : null,
            perLegEdits:   {},
            appliedLegs:   {},
            dismissedLegs: {}
        })
    }

    /** Mirror preset-selection without touching the build. */
    static async setPreset(server, aircraftId, presetId) {
        return AesAfpActiveDraftStore.save(server, aircraftId, {
            presetId: presetId || null
        })
    }

    /** Patch a single leg's edit overlay. Pass `null` to clear that leg's edits. */
    static async setEdit(server, aircraftId, seq, patch) {
        if (seq == null) return null
        return AesAfpActiveDraftStore._enqueue(server, aircraftId, async () => {
            const cur = await AesAfpActiveDraftStore.load(server, aircraftId)
            const edits = Object.assign({}, cur.perLegEdits)
            if (patch === null) {
                delete edits[seq]
            } else {
                edits[seq] = Object.assign({}, edits[seq] || {}, patch || {})
            }
            return AesAfpActiveDraftStore._saveImpl(server, aircraftId, {perLegEdits: edits})
        })
    }

    static async setApplied(server, aircraftId, seq, appliedAt) {
        if (seq == null) return null
        return AesAfpActiveDraftStore._enqueue(server, aircraftId, async () => {
            const cur = await AesAfpActiveDraftStore.load(server, aircraftId)
            const next = Object.assign({}, cur.appliedLegs)
            if (appliedAt === null) delete next[seq]
            else next[seq] = appliedAt || Date.now()
            return AesAfpActiveDraftStore._saveImpl(server, aircraftId, {appliedLegs: next})
        })
    }

    static async setDismissed(server, aircraftId, seq, dismissedAt) {
        if (seq == null) return null
        return AesAfpActiveDraftStore._enqueue(server, aircraftId, async () => {
            const cur = await AesAfpActiveDraftStore.load(server, aircraftId)
            const next = Object.assign({}, cur.dismissedLegs)
            if (dismissedAt === null) delete next[seq]
            else next[seq] = dismissedAt || Date.now()
            return AesAfpActiveDraftStore._saveImpl(server, aircraftId, {dismissedLegs: next})
        })
    }

    /**
     * Materialise a leg with its per-leg edits applied on top of the base
     * flight from the build. Returns null if seq isn't in the build.
     */
    static effectiveLeg(record, seq) {
        const base = (record.flights || []).find(f => f && f.seq === seq)
        if (!base) return null
        const overlay = (record.perLegEdits || {})[seq] || {}
        return Object.assign({}, base, overlay)
    }

    /** Wipe one aircraft's draft entirely. Useful for a future "reset" CTA. */
    static async remove(server, aircraftId) {
        if (!server || !aircraftId) return
        const key = AesAfpActiveDraftStore._key(server, aircraftId)
        await chrome.storage.local.remove([key])
    }

    /**
     * Subscribe to active-draft updates across tabs. Mirrors
     * `AesAfpScheduleStore.watch`. Callback receives
     * `{server, aircraftId, draft, oldDraft}` where `draft` is the new
     * value (or null on key delete) and `oldDraft` the previous value
     * (or null on first write). Returns an unwatch fn.
     */
    static watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                if (key.indexOf(AesAfpActiveDraftStore.PREFIX) !== 0) continue
                const tail = key.slice(AesAfpActiveDraftStore.PREFIX.length)
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
                } catch (e) { console.warn("[AES AFP] active-draft-store watch handler threw", e) }
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

if (typeof window !== "undefined") {
    window.AesAfpActiveDraftStore = AesAfpActiveDraftStore
}
