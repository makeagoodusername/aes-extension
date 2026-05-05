"use strict"

/**
 * AesHandoffQueue — sequential wrapper around window.AesHandoffStore.
 *
 * window.AesHandoffStore.set() holds at most one pending record (60s TTL). Many
 * canvas commit batches need to hand off multiple records — multi-leg
 * adds, plus the scaffold paths for moveRoute / removeRoute. This queue
 * persists a FIFO list and pumps records into the active slot one at a
 * time. When the AFP page consumer calls window.AesHandoffStore.consume(), the
 * active key clears, the storage.onChanged listener fires, and the
 * queue advances to the next record.
 *
 * Storage:
 *   `_shared:handoff:queue` = {writtenAt: epochMs, records: [...]}
 *     5-minute TTL on the array as a whole — stale queues drop on next
 *     enqueue/peek so a forgotten session can't surprise the user.
 *
 * Public API:
 *   .enqueue(records)       — append + start the chain if active is empty.
 *   .advance()              — manual pop next; usually triggered by the
 *                             auto-advance listener.
 *   .peekQueue()            — non-destructive read of the pending records.
 *   .clear()                — drop queue + active record.
 *   .installAutoAdvance()   — install the chrome.storage.onChanged listener
 *                             that calls advance() when the active record
 *                             clears. Idempotent.
 *
 * Note: this slice scaffolds the queue plumbing only. addRoute records
 * still flow through the existing dnd-grid AFP wave-applier. moveRoute
 * and removeRoute records sit in the active slot (dnd-grid source style)
 * until TTL expires — no AFP-side consumer acts on them yet. A future
 * slice wires the gated delete writer behind apply.enabled +
 * apply.dryRunOnly, at which point this queue already provides the
 * sequencing they need.
 */
class AesHandoffQueue {
    static QUEUE_KEY = "_shared:handoff:queue"
    static QUEUE_TTL_MS = 5 * 60 * 1000
    static MAX_RECORDS = 16
    static _autoAdvanceInstalled = false

    static async enqueue(records) {
        if (!Array.isArray(records) || !records.length) return 0
        const valid = records.filter(r => r && r.aircraftId)
        if (!valid.length) return 0
        const cur = await AesHandoffQueue._readQueue() || []
        const merged = cur.concat(valid).slice(0, AesHandoffQueue.MAX_RECORDS)
        await AesHandoffQueue._writeQueue(merged)
        // Start the chain if no active record is in flight.
        const active = await window.AesHandoffStore.peek()
        if (!active) await AesHandoffQueue.advance()
        return valid.length
    }

    static async advance() {
        const cur = await AesHandoffQueue._readQueue() || []
        if (!cur.length) return null
        const next = cur.shift()
        await AesHandoffQueue._writeQueue(cur)
        try {
            await window.AesHandoffStore.set(next)
            return next
        } catch (e) {
            console.warn("[AES Handoff Queue] set() rejected record, dropping", e)
            // Recurse to try the next one.
            return AesHandoffQueue.advance()
        }
    }

    static async peekQueue() {
        return (await AesHandoffQueue._readQueue()) || []
    }

    static async clear() {
        try { await chrome.storage.local.remove(AesHandoffQueue.QUEUE_KEY) } catch (_) {}
        try { await window.AesHandoffStore.clear() } catch (_) {}
    }

    static installAutoAdvance() {
        if (AesHandoffQueue._autoAdvanceInstalled) return
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return
        const listener = (changes, area) => {
            if (area !== "local") return
            const ch = changes[window.AesHandoffStore.KEY]
            if (!ch) return
            if (ch.newValue == null && ch.oldValue != null) {
                AesHandoffQueue.advance().catch(e =>
                    console.warn("[AES Handoff Queue] advance failed", e))
            }
        }
        chrome.storage.onChanged.addListener(listener)
        AesHandoffQueue._autoAdvanceInstalled = true
    }

    static async _readQueue() {
        const got = await chrome.storage.local.get(AesHandoffQueue.QUEUE_KEY)
        const blob = got && got[AesHandoffQueue.QUEUE_KEY]
        if (!blob || !Array.isArray(blob.records)) return null
        const t = Number(blob.writtenAt) || 0
        if (t > 0 && (Date.now() - t) > AesHandoffQueue.QUEUE_TTL_MS) {
            try { await chrome.storage.local.remove(AesHandoffQueue.QUEUE_KEY) } catch (_) {}
            return null
        }
        return blob.records
    }

    static async _writeQueue(records) {
        if (!Array.isArray(records) || !records.length) {
            try { await chrome.storage.local.remove(AesHandoffQueue.QUEUE_KEY) } catch (_) {}
            return
        }
        await chrome.storage.local.set({
            [AesHandoffQueue.QUEUE_KEY]: {writtenAt: Date.now(), records}
        })
    }
}

if (typeof window !== "undefined") {
    window.AesHandoffQueue = AesHandoffQueue
    if (typeof window.AesHandoffStore !== "undefined") {
        try { AesHandoffQueue.installAutoAdvance() } catch (_) {}
    }
}
