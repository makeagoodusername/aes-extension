/**
 * Owns the chrome.storage.local records for one in-flight scan.
 *
 * Two record kinds, both keyed under `<server>marketScan:<scanId>`:
 *
 *   <server>marketScan:<scanId>           → session record (queue, state)
 *   <server>marketScan:<scanId>:r:<slug>  → one result blob per type
 *
 * Splitting the result blobs avoids a read-modify-write race when up to
 * `concurrency` child tabs finish at nearly the same time.
 */
class MarketScanSession {
    static _sessionKey(server, scanId) {
        return server + "marketScan:" + scanId
    }

    static _resultKey(server, scanId, type) {
        return server + "marketScan:" + scanId + ":r:" + MarketScanSession.slug(type)
    }

    /**
     * Filesystem-safe slug for a type name: "Airbus A320-200 heavy" → "Airbus_A320_200_heavy".
     */
    static slug(type) {
        return String(type || "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")
    }

    /**
     * Builds a fresh session record. Caller must persist via save().
     * @param {object} args - {server, presetId, presetName, queue: [{type, family, familyFallback?, status?, error?}], concurrency, staggerMs}
     */
    static create(args) {
        const scanId = Date.now().toString(36)
        const queue = (args.queue || []).map((entry, idx) => ({
            idx: idx,
            type: entry.type,
            family: entry.family,
            familyFallback: !!entry.familyFallback,
            status: entry.status || "pending",
            error: entry.error || null,
            startedAt: null,
            finishedAt: null
        }))
        return {
            scanId: scanId,
            server: args.server,
            presetId: args.presetId || null,
            presetName: args.presetName || "",
            status: "running",
            startedAt: Date.now(),
            finishedAt: null,
            concurrency: args.concurrency || 6,
            staggerMs: args.staggerMs || 2000,
            inFlight: 0,
            lastDispatchAt: 0,
            queue: queue
        }
    }

    static async loadSession(server, scanId) {
        if (!scanId) return null
        const key = MarketScanSession._sessionKey(server, scanId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    static async saveSession(record) {
        const key = MarketScanSession._sessionKey(record.server, record.scanId)
        await chrome.storage.local.set({[key]: record})
    }

    /**
     * Reads per-type result blobs for a session. Returns an object keyed by
     * the type name → {status, rows, error}.
     *
     * `knownTypes` (optional) caps the read to those exact result keys, so we
     * skip a full-storage scan during in-flight refreshes. Falls back to the
     * legacy prefix sweep when the caller doesn't know the type set.
     */
    static async loadResults(server, scanId, knownTypes) {
        const out = {}
        if (Array.isArray(knownTypes) && knownTypes.length) {
            const keys = knownTypes.map(t => MarketScanSession._resultKey(server, scanId, t))
            const data = await chrome.storage.local.get(keys)
            for (const k in data) {
                const blob = data[k]
                if (blob && blob.type) out[blob.type] = blob
            }
            return out
        }
        const all = await chrome.storage.local.get(null)
        const prefix = server + "marketScan:" + scanId + ":r:"
        for (const k in all) {
            if (k.indexOf(prefix) === 0) {
                const blob = all[k]
                if (blob && blob.type) out[blob.type] = blob
            }
        }
        return out
    }

    /**
     * Writes one per-type result blob. Called from child tabs.
     */
    static async saveResult(server, scanId, blob) {
        const key = MarketScanSession._resultKey(server, scanId, blob.type)
        await chrome.storage.local.set({[key]: blob})
    }

    /**
     * Removes the session record and all per-type result blobs for a scan.
     */
    static async deleteScan(server, scanId) {
        if (!scanId) return
        const all = await chrome.storage.local.get(null)
        const sessionKey = MarketScanSession._sessionKey(server, scanId)
        const prefix = sessionKey + ":r:"
        const toRemove = []
        for (const k in all) {
            if (k === sessionKey || k.indexOf(prefix) === 0) toRemove.push(k)
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
    }

    /**
     * Garbage-collect any market scan keys older than `maxAgeMs` for this server.
     * Called from the dashboard panel on load.
     */
    static async cleanupOld(server, keepScanId, maxAgeMs) {
        const all = await chrome.storage.local.get(null)
        const cutoff = Date.now() - (maxAgeMs || 24 * 60 * 60 * 1000)
        const keepSession = MarketScanSession._sessionKey(server, keepScanId)
        const keepPrefix = keepSession + ":r:"
        const toRemove = []
        const sessionPrefix = server + "marketScan:"
        for (const k in all) {
            if (k.indexOf(sessionPrefix) !== 0) continue
            if (k === keepSession || k.indexOf(keepPrefix) === 0) continue
            const isSession = k.indexOf(":r:") === -1
            if (isSession) {
                const rec = all[k]
                if (!rec || !rec.startedAt || rec.startedAt < cutoff) {
                    toRemove.push(k)
                }
            } else {
                // Orphan result blob with no live session — drop it.
                const owner = k.split(":r:")[0]
                if (!all[owner]) toRemove.push(k)
            }
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
    }
}

if (typeof window !== "undefined") {
    window.MarketScanSession = MarketScanSession
}
