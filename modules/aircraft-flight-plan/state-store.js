"use strict"

/**
 * Per-aircraft state store for the Aircraft Flight Plan Assistant (Slice F).
 *
 * Persists the user's in-progress plan + dismissals + last-picked preset for
 * one aircraft at a time. Keyed by `<server>:<aircraftId>` because the same
 * aircraft id space is per-server in AS, and the user may run multiple
 * servers from one browser profile.
 *
 *   aircraftFlightPlan:state:<server>:<aircraftId> →
 *     {server, aircraftId,
 *      draftedPlan: Leg[],
 *      dismissedCandidates: string[],   // destIata uppercased
 *      selectedPresetId: string | null,
 *      lastFilledAt: number | null,
 *      currentLocationIata: string | null,        // last seen "Last airport" IATA
 *      currentLocationName: string | null,        // tooltip / full name
 *      currentLocationAirportId: number | null,   // /app/info/airports/<id>
 *      lastSeenAt: number | null,                 // ms epoch of last AFP mount
 *      createdAt, updatedAt}
 *
 * The currentLocation* + lastSeenAt fields are written by host.js on every
 * AFP mount so consumers like the Fleet Hub (running on /app/fleets) can
 * show a Loc column + station link without re-scraping each aircraft page.
 *
 * Mirrors `RouteAssistantRouteOverridesStore`: PREFIX + _key + static get /
 * save / remove. `save()` is full-replace per record — fields not in the
 * patch fall through to the existing record (deep-merge), but the caller
 * must pass the FULL desired draftedPlan / dismissedCandidates arrays since
 * arrays don't merge meaningfully. The dismissCandidate / undismissCandidate
 * helpers wrap the read-modify-write so callers don't have to.
 *
 * `dismissedCandidates` is stored as an array (not a Set) for JSON safety.
 *
 * Slice F invariant: storage prefix is `aircraftFlightPlan:` — never
 * collides with `routeAssistant:`. Don't reuse this store for any other
 * surface.
 */
class AesAfpStateStore {
    static PREFIX = "aircraftFlightPlan:state:"

    static _key(server, aircraftId) {
        return AesAfpStateStore.PREFIX
            + String(server || "")
            + ":"
            + String(aircraftId || "")
    }

    static _emptyState(server, aircraftId) {
        return {
            server:                    String(server || ""),
            aircraftId:                String(aircraftId || ""),
            draftedPlan:               [],
            dismissedCandidates:       [],
            selectedPresetId:          null,
            lastFilledAt:              null,
            currentLocationIata:       null,
            currentLocationName:       null,
            currentLocationAirportId:  null,
            lastSeenAt:                null,
            createdAt:                 null,
            updatedAt:                 null
        }
    }

    /**
     * Returns the stored state for one aircraft, or a fresh empty state
     * if nothing has been persisted yet. Always returns a fully-populated
     * object so callers don't need to default-fill.
     */
    static async load(server, aircraftId) {
        if (!server || !aircraftId) return AesAfpStateStore._emptyState(server, aircraftId)
        const key = AesAfpStateStore._key(server, aircraftId)
        const out = await chrome.storage.local.get([key])
        const rec = out[key]
        if (!rec || typeof rec !== "object") {
            return AesAfpStateStore._emptyState(server, aircraftId)
        }
        // Defensive default-fill so a partially-stored older shape doesn't
        // throw at the read site.
        const empty = AesAfpStateStore._emptyState(server, aircraftId)
        const asString  = v => typeof v === "string" ? v : null
        const asFinite  = v => (typeof v === "number" && isFinite(v)) ? v : null
        const asArray   = v => Array.isArray(v) ? v : []
        return {
            server:                    rec.server     || empty.server,
            aircraftId:                rec.aircraftId || empty.aircraftId,
            draftedPlan:               asArray(rec.draftedPlan),
            dismissedCandidates:       asArray(rec.dismissedCandidates),
            selectedPresetId:          asString(rec.selectedPresetId),
            lastFilledAt:              asFinite(rec.lastFilledAt),
            currentLocationIata:       asString(rec.currentLocationIata),
            currentLocationName:       asString(rec.currentLocationName),
            currentLocationAirportId:  asFinite(rec.currentLocationAirportId),
            lastSeenAt:                asFinite(rec.lastSeenAt),
            createdAt:                 asFinite(rec.createdAt),
            updatedAt:                 asFinite(rec.updatedAt)
        }
    }

    /**
     * If `patch` declares `key`, return the validated value (validator
     * returns null for invalid input); otherwise pass `existing` through.
     * Lets each scalar field collapse from a 4-line ternary to one line.
     */
    static _pickField(patch, key, existing, validator) {
        if (!patch || !Object.prototype.hasOwnProperty.call(patch, key)) return existing
        return validator(patch[key])
    }

    /**
     * Persist a partial patch. Fields omitted from `patch` fall through
     * to the existing stored record. Pass an explicit array (even empty)
     * to replace `draftedPlan` or `dismissedCandidates` — those don't
     * merge meaningfully across calls.
     *
     * Returns the merged record after save.
     */
    static async save(server, aircraftId, patch) {
        if (!server || !aircraftId) return null
        const existing = await AesAfpStateStore.load(server, aircraftId)
        const now = Date.now()

        const asString    = v => (typeof v === "string" && v) ? v : null
        const asFinite    = v => isFinite(Number(v)) ? Number(v) : null
        const asIataArray = v => Array.isArray(v)
            ? v.map(s => String(s || "").toUpperCase()).filter(Boolean)
            : existing.dismissedCandidates
        const asPlan      = v => Array.isArray(v) ? v.slice() : existing.draftedPlan
        const pick = (k, validator) => AesAfpStateStore._pickField(patch, k, existing[k], validator)

        const next = {
            server:                    String(server),
            aircraftId:                String(aircraftId),
            draftedPlan:               (patch && Array.isArray(patch.draftedPlan)) ? asPlan(patch.draftedPlan) : existing.draftedPlan,
            dismissedCandidates:       (patch && Array.isArray(patch.dismissedCandidates)) ? asIataArray(patch.dismissedCandidates) : existing.dismissedCandidates,
            selectedPresetId:          pick("selectedPresetId",         v => typeof v === "string" ? v : null),
            lastFilledAt:              pick("lastFilledAt",             asFinite),
            currentLocationIata:       pick("currentLocationIata",      asString),
            currentLocationName:       pick("currentLocationName",      asString),
            currentLocationAirportId:  pick("currentLocationAirportId", asFinite),
            lastSeenAt:                pick("lastSeenAt",               asFinite),
            createdAt:                 existing.createdAt || now,
            updatedAt:                 now
        }
        const key = AesAfpStateStore._key(server, aircraftId)
        await chrome.storage.local.set({[key]: next})
        return next
    }

    /**
     * Append destIata to dismissedCandidates if not already present.
     * Idempotent — the same destIata in twice is one entry.
     */
    static async dismissCandidate(server, aircraftId, destIata) {
        const dest = String(destIata || "").toUpperCase()
        if (!dest) return
        const cur = await AesAfpStateStore.load(server, aircraftId)
        if (cur.dismissedCandidates.indexOf(dest) >= 0) return
        const next = cur.dismissedCandidates.concat([dest])
        await AesAfpStateStore.save(server, aircraftId, {dismissedCandidates: next})
    }

    /**
     * Remove destIata from dismissedCandidates. No-op if absent.
     */
    static async undismissCandidate(server, aircraftId, destIata) {
        const dest = String(destIata || "").toUpperCase()
        if (!dest) return
        const cur = await AesAfpStateStore.load(server, aircraftId)
        if (cur.dismissedCandidates.indexOf(dest) < 0) return
        const next = cur.dismissedCandidates.filter(d => d !== dest)
        await AesAfpStateStore.save(server, aircraftId, {dismissedCandidates: next})
    }

    /**
     * Wipe one aircraft's state entirely. Not currently surfaced in the
     * UI; useful for tests + future "Reset this aircraft" CTA.
     */
    static async remove(server, aircraftId) {
        if (!server || !aircraftId) return
        const key = AesAfpStateStore._key(server, aircraftId)
        await chrome.storage.local.remove([key])
    }

    /**
     * Subscribe to state-store updates across tabs. Mirrors
     * `AesAfpScheduleStore.watch`. Callback receives
     * `{server, aircraftId, state, oldState}`; returns an unwatch fn.
     */
    static watch(cb) {
        if (typeof cb !== "function") return () => {}
        const handler = (changes, area) => {
            if (area !== "local") return
            for (const key of Object.keys(changes)) {
                if (key.indexOf(AesAfpStateStore.PREFIX) !== 0) continue
                const tail = key.slice(AesAfpStateStore.PREFIX.length)
                const sep = tail.indexOf(":")
                if (sep < 0) continue
                const server     = tail.slice(0, sep)
                const aircraftId = tail.slice(sep + 1)
                try {
                    cb({
                        server,
                        aircraftId,
                        state:    changes[key].newValue || null,
                        oldState: changes[key].oldValue || null
                    })
                } catch (e) { console.warn("[AES AFP] state-store watch handler threw", e) }
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
    window.AesAfpStateStore = AesAfpStateStore
}
