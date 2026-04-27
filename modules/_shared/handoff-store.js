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
 * Single key: `_shared:handoff:wave-designer`. Holds at most one
 * pending handoff at a time (last writer wins). 60-second TTL prevents
 * a forgotten record from auto-applying days later when the user
 * happens to open an AFP page.
 *
 * Public API (window.AesHandoffStore):
 *   .set({aircraftId, presetId, hub, generatedAt?, source?})
 *     → Promise<void> — overwrites any existing pending handoff.
 *   .consume(aircraftId)
 *     → Promise<record|null> — read + delete in one shot. Returns null
 *       when no record matches the aircraftId or when TTL expired.
 *   .peek()
 *     → Promise<record|null> — non-destructive read for UI hints.
 *   .clear()
 *     → Promise<void> — explicit cleanup (rarely needed; consume is
 *       the normal disposal path).
 *
 * The record shape:
 *   {
 *     aircraftId:  "12345",
 *     presetId:    "preset-uuid",
 *     hub:         "JFK",
 *     generatedAt: 1714123456789,
 *     source:      "wave-designer" | …,
 *     writtenAt:   1714123456789  // server-set on write
 *   }
 */
class AesHandoffStore {
    static KEY = "_shared:handoff:wave-designer"
    static TTL_MS = 60 * 1000

    static async set(record) {
        if (!record || !record.aircraftId || !record.presetId) {
            throw new Error("AesHandoffStore.set: aircraftId + presetId required")
        }
        const payload = {
            aircraftId:  String(record.aircraftId),
            presetId:    String(record.presetId),
            hub:         record.hub ? String(record.hub).toUpperCase() : "",
            generatedAt: Number(record.generatedAt) || Date.now(),
            source:      (record.source && String(record.source).slice(0, 32)) || "wave-designer",
            writtenAt:   Date.now()
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
