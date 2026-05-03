"use strict"

/**
 * Track 8 slice 8c — cross-page handoff store for the route-assistant
 * Wave Designer → AFP wave-applier deep link.
 *
 * The Wave View on `/app/com/scheduling/<HUB>` lets the user pick a
 * single aircraft and "open in flight plan…". That writes a handoff
 * record under one well-known key, then opens a new tab at
 * `/app/fleets/aircraft/<id>/0`. The AFP wave-applier reads the key
 * on mount, pre-selects the matching preset, and auto-Generates the
 * Gantt — no second navigation, no manual preset re-pick.
 *
 * Track C extension — fleet-schedule-grid drag-to-schedule drop also
 * writes through this store with `source: "dnd-grid"`, carrying
 * `destIata` + `dropMin` instead of a `presetId`. AFP consumers branch
 * on `source` to either pre-select a preset (wave-designer) or scroll
 * to the matching candidate row (dnd-grid).
 *
 * Single key: `_shared:handoff:wave-designer`. Holds at most one
 * pending handoff at a time (last writer wins). 60-second TTL prevents
 * a forgotten record from auto-applying days later when the user
 * happens to open an AFP page.
 *
 * Public API (window.AesHandoffStore):
 *   .set({aircraftId, presetId, hub, generatedAt?, source?})
 *     → Promise<void> — overwrites any existing pending handoff.
 *     Required fields by source:
 *       - default / "wave-designer": aircraftId + presetId
 *       - "dnd-grid":                aircraftId + destIata
 *   .consume(aircraftId)
 *     → Promise<record|null> — read + delete in one shot. Returns null
 *       when no record matches the aircraftId or when TTL expired.
 *   .peek()
 *     → Promise<record|null> — non-destructive read for UI hints.
 *   .clear()
 *     → Promise<void> — explicit cleanup (rarely needed; consume is
 *       the normal disposal path).
 *
 * Record shapes:
 *   wave-designer (Schedule Panel + RA panel):
 *     {
 *       aircraftId:  "12345",
 *       presetId:    "preset-uuid",
 *       hub:         "JFK",
 *       generatedAt: 1714123456789,
 *       source:      "wave-designer",
 *       writtenAt:   1714123456789
 *     }
 *
 *   dnd-grid (Fleet Schedule Grid drop popover):
 *     {
 *       aircraftId:  "12345",
 *       destIata:    "MIA",
 *       dropMin:     540,            // 0..1439, optional
 *       depTime:     "09:00",        // optional; preferred over dropMin
 *       dayMask:     [true,false,…], // optional Mon..Sun operating days
 *       flightNumberText: "42",      // optional 1..4 digit suffix
 *       fillForm:    true,           // optional; AFP page may pre-fill form
 *       source:      "dnd-grid",
 *       writtenAt:   1714123456789
 *     }
 */
class AesHandoffStore {
    static KEY = "_shared:handoff:wave-designer"
    static TTL_MS = 60 * 1000

    static async set(record) {
        if (!record || !record.aircraftId) {
            throw new Error("AesHandoffStore.set: aircraftId required")
        }
        const source = (record.source && String(record.source).slice(0, 32)) || "wave-designer"
        const KINDS = {addRoute: 1, removeRoute: 1, moveRoute: 1}
        const kind = (record.kind && KINDS[record.kind]) ? record.kind : "addRoute"
        const payload = {
            aircraftId:  String(record.aircraftId),
            generatedAt: Number(record.generatedAt) || Date.now(),
            source:      source,
            kind:        kind,
            writtenAt:   Date.now()
        }
        if (kind === "removeRoute" || kind === "moveRoute") {
            if (!record.destIata) {
                throw new Error("AesHandoffStore.set: destIata required for " + kind + " kind")
            }
            payload.destIata = String(record.destIata).toUpperCase()
            if (record.hub) payload.hub = String(record.hub).toUpperCase()
            if (record.flightNumberText != null) {
                payload.flightNumberText = String(record.flightNumberText)
                    .replace(/[^0-9]/g, "").slice(0, 4)
            }
            if (kind === "moveRoute") {
                if (!record.targetAircraftId) {
                    throw new Error("AesHandoffStore.set: targetAircraftId required for moveRoute kind")
                }
                payload.targetAircraftId = String(record.targetAircraftId)
            }
            await chrome.storage.local.set({[AesHandoffStore.KEY]: payload})
            return
        }
        if (source === "dnd-grid") {
            if (!record.destIata) {
                throw new Error("AesHandoffStore.set: destIata required for dnd-grid source")
            }
            payload.destIata = String(record.destIata).toUpperCase()
            if (record.dropMin != null && isFinite(record.dropMin)) {
                payload.dropMin = Math.max(0, Math.min(1439, Math.round(Number(record.dropMin))))
            }
            if (record.hub) payload.hub = String(record.hub).toUpperCase()
            if (record.depTime && /^(\d{1,2}):(\d{2})$/.test(String(record.depTime))) {
                payload.depTime = String(record.depTime)
            }
            if (Array.isArray(record.dayMask) && record.dayMask.length >= 7) {
                payload.dayMask = record.dayMask.slice(0, 7).map(Boolean)
            }
            if (record.flightNumberText != null) {
                payload.flightNumberText = String(record.flightNumberText)
                    .replace(/[^0-9]/g, "").slice(0, 4)
            }
            if (record.pricePct != null && isFinite(record.pricePct)) {
                payload.pricePct = Number(record.pricePct)
            }
            if (typeof record.service === "string") payload.service = record.service
            if (record.fillForm === true) payload.fillForm = true
        } else {
            if (!record.presetId) {
                throw new Error("AesHandoffStore.set: presetId required for " + source + " source")
            }
            payload.presetId = String(record.presetId)
            payload.hub = record.hub ? String(record.hub).toUpperCase() : ""
        }
        await chrome.storage.local.set({[AesHandoffStore.KEY]: payload})
    }

    static async peek() {
        const got = await chrome.storage.local.get(AesHandoffStore.KEY)
        const rec = got && got[AesHandoffStore.KEY]
        if (!rec) return null
        if (!AesHandoffStore._fresh(rec)) {
            // Expired — clean it up so future peeks short-circuit.
            try { await chrome.storage.local.remove(AesHandoffStore.KEY) } catch (_) { /* noop */ }
            return null
        }
        return rec
    }

    static async consume(aircraftId) {
        const rec = await AesHandoffStore.peek()
        if (!rec) return null
        if (aircraftId != null && String(rec.aircraftId) !== String(aircraftId)) {
            // Belongs to a different aircraft; leave it for the right tab.
            return null
        }
        try { await chrome.storage.local.remove(AesHandoffStore.KEY) } catch (_) { /* noop */ }
        return rec
    }

    static async clear() {
        try { await chrome.storage.local.remove(AesHandoffStore.KEY) } catch (_) { /* noop */ }
    }

    static _fresh(rec) {
        const t = Number(rec && rec.writtenAt) || 0
        return t > 0 && (Date.now() - t) <= AesHandoffStore.TTL_MS
    }
}

if (typeof window !== "undefined") {
    window.AesHandoffStore = AesHandoffStore

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined"
                && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(typeof AesHandoffStore.set     === "function",
                "[AES auto-8c smoke] set() exposed")
            console.assert(typeof AesHandoffStore.consume === "function",
                "[AES auto-8c smoke] consume() exposed")
            console.assert(typeof AesHandoffStore.peek    === "function",
                "[AES auto-8c smoke] peek() exposed")
            // Round-trip
            ;(async () => {
                await AesHandoffStore.clear()
                await AesHandoffStore.set({aircraftId: "smoke-1", presetId: "p-1", hub: "JFK"})
                const peek = await AesHandoffStore.peek()
                console.assert(peek && peek.aircraftId === "smoke-1",
                    "[AES auto-8c smoke] peek round-trips")
                const wrong = await AesHandoffStore.consume("nope-2")
                console.assert(wrong === null,
                    "[AES auto-8c smoke] consume(wrongId) returns null")
                const right = await AesHandoffStore.consume("smoke-1")
                console.assert(right && right.aircraftId === "smoke-1",
                    "[AES auto-8c smoke] consume(rightId) returns record")
                const after = await AesHandoffStore.peek()
                console.assert(after === null,
                    "[AES auto-8c smoke] peek after consume returns null")
            })().catch(e => console.warn("[AES auto-8c smoke] async chain threw", e))
        }
    } catch (_) { /* never let smoke break the page */ }
}
