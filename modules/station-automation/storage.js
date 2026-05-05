/**
 * Storage wrapper for the station-automation feature.
 *
 * Two record kinds, both keyed under `<server><airlineId>stationAutomation`:
 *
 *   <server><airlineId>stationAutomationQueue   → user-maintained country queue
 *   <server><airlineId>stationAutomationRun:<runId>             → run session (chunks, state)
 *   <server><airlineId>stationAutomationRun:<runId>:r:<flatIdx> → per-airport outcome
 *
 * Splitting per-airport outcomes into their own keys avoids read-modify-write
 * races between concurrent worker tabs finishing at nearly the same time.
 *
 * Queue entry shape (one per country in the queue):
 *   {
 *     countryId, countryCode, countryName,
 *     filterMode?: "minimum"|"range",        // legacy entries omit this
 *     paxThreshold, cargoThreshold,           // legacy minimums, 0–10
 *     paxMin, paxMax, cargoMin, cargoMax,     // range mode, 0–10
 *     sizeMin, sizeMax,                       // airport size/capacity range, 0–10
 *                                             // all filters ignored when airportWhitelist is set
 *     exceptions: [iata...],                  // skip these IATAs
 *     airportWhitelist?: [iata...]            // optional — when set, only listed
 *                                             //   airports are opened; thresholds
 *                                             //   are bypassed. Used by the bulk
 *                                             //   Schedule-panel flow to enqueue
 *                                             //   specific airports per country.
 *   }
 */
class StationAutomationStorage {
    static _queueKey(server, airlineId) {
        return server + airlineId + "stationAutomationQueue"
    }

    static _runKey(server, airlineId, runId) {
        return server + airlineId + "stationAutomationRun:" + runId
    }

    static _resultKey(server, airlineId, runId, flatIdx) {
        return server + airlineId + "stationAutomationRun:" + runId + ":r:" + flatIdx
    }

    static _runPrefix(server, airlineId) {
        return server + airlineId + "stationAutomationRun:"
    }

    static _emptyQueueRecord(server, airlineId) {
        return {
            server,
            airlineId,
            type: "stationAutomationQueue",
            queue: [],
            activeRunId: null,
        }
    }

    // ---------- Queue (user-maintained) ----------

    static async load(server, airlineId) {
        const key = StationAutomationStorage._queueKey(server, airlineId)
        const fallback = StationAutomationStorage._emptyQueueRecord(server, airlineId)
        const result = await chrome.storage.local.get({[key]: fallback})
        const rec = result[key]
        if (!rec.queue) rec.queue = []
        return rec
    }

    static async save(record) {
        const key = StationAutomationStorage._queueKey(record.server, record.airlineId)
        await chrome.storage.local.set({[key]: record})
    }

    static async clear(server, airlineId) {
        await StationAutomationStorage.save(
            StationAutomationStorage._emptyQueueRecord(server, airlineId)
        )
    }

    static async enqueue(server, airlineId, entry) {
        const record = await StationAutomationStorage.load(server, airlineId)
        record.queue.push(entry)
        await StationAutomationStorage.save(record)
        return record
    }

    static async removeEntry(server, airlineId, index) {
        const record = await StationAutomationStorage.load(server, airlineId)
        if (index >= 0 && index < record.queue.length) record.queue.splice(index, 1)
        await StationAutomationStorage.save(record)
        return record
    }

    // ---------- Run session (per Add-all-stations press) ----------

    /**
     * Builds a fresh run record. Chunks is a 2D array of airport entries;
     * each entry has a flat idx so result writes can key on it.
     */
    static createRun({server, airlineId, chunks, concurrency}) {
        const runId = "sr-" + Date.now().toString(36)
        let flatIdx = 0
        const withIdx = chunks.map(chunk => chunk.map(entry => ({...entry, flatIdx: flatIdx++})))
        return {
            runId,
            server,
            airlineId,
            status: "running",
            startedAt: Date.now(),
            finishedAt: null,
            concurrency: concurrency || 6,
            chunks: withIdx,
            total: flatIdx,
        }
    }

    static async loadRun(server, airlineId, runId) {
        if (!runId) return null
        const key = StationAutomationStorage._runKey(server, airlineId, runId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    static async saveRun(record) {
        const key = StationAutomationStorage._runKey(record.server, record.airlineId, record.runId)
        await chrome.storage.local.set({[key]: record})
    }

    static async setActiveRun(server, airlineId, runId) {
        const rec = await StationAutomationStorage.load(server, airlineId)
        rec.activeRunId = runId
        await StationAutomationStorage.save(rec)
    }

    // ---------- Results (per-airport outcomes) ----------

    static async writeResult(server, airlineId, runId, flatIdx, blob) {
        const key = StationAutomationStorage._resultKey(server, airlineId, runId, flatIdx)
        await chrome.storage.local.set({[key]: blob})
    }

    static async loadResults(server, airlineId, runId) {
        const all = await chrome.storage.local.get(null)
        const prefix = StationAutomationStorage._runKey(server, airlineId, runId) + ":r:"
        const out = {}
        for (const k in all) {
            if (k.indexOf(prefix) === 0) {
                const flatIdx = parseInt(k.slice(prefix.length), 10)
                if (!isNaN(flatIdx)) out[flatIdx] = all[k]
            }
        }
        return out
    }

    /**
     * Remove the run session and every per-airport result blob.
     */
    static async deleteRun(server, airlineId, runId) {
        if (!runId) return
        const sessionKey = StationAutomationStorage._runKey(server, airlineId, runId)
        const runData = await chrome.storage.local.get([sessionKey])
        const runRec = runData[sessionKey]

        const toRemove = [sessionKey]

        if (runRec && typeof runRec.total === 'number') {
            for (let i = 0; i < runRec.total; i++) {
                toRemove.push(`${sessionKey}:r:${i}`)
            }
        } else {
            // Fallback for older formats or corrupted records without total
            const all = await chrome.storage.local.get(null)
            const prefix = sessionKey + ":r:"
            for (const k in all) {
                if (k.indexOf(prefix) === 0) toRemove.push(k)
            }
        }

        if (toRemove.length) await chrome.storage.local.remove(toRemove)
    }

    /**
     * GC orphan/old run keys. Called from the dashboard panel on load.
     */
    static async cleanupOldRuns(server, airlineId, keepRunId, maxAgeMs) {
        const all = await chrome.storage.local.get(null)
        const cutoff = Date.now() - (maxAgeMs || 24 * 60 * 60 * 1000)
        const keep = keepRunId ? StationAutomationStorage._runKey(server, airlineId, keepRunId) : null
        const keepPrefix = keep ? keep + ":r:" : null
        const runPrefix = StationAutomationStorage._runPrefix(server, airlineId)
        // F-9228-102: two-pass cleanup. The first pass identifies session
        // records to drop and seeds the deleted-set; the second pass walks
        // the result blobs (`:r:<idx>`) and removes any whose owner is
        // already gone OR is being dropped in this pass. Previously the
        // orphan check tested the snapshot (`all[owner]`), which is still
        // truthy in the same call, so blobs whose owners were marked for
        // deletion were left behind indefinitely.
        const deletedSessions = new Set()
        const toRemove = []
        for (const k in all) {
            if (k.indexOf(runPrefix) !== 0) continue
            if (keep && (k === keep || (keepPrefix && k.indexOf(keepPrefix) === 0))) continue
            if (k.indexOf(":r:") !== -1) continue
            const rec = all[k]
            if (!rec || !rec.startedAt || rec.startedAt < cutoff) {
                deletedSessions.add(k)
                toRemove.push(k)
            }
        }
        for (const k in all) {
            if (k.indexOf(runPrefix) !== 0) continue
            if (k.indexOf(":r:") === -1) continue
            if (keepPrefix && k.indexOf(keepPrefix) === 0) continue
            const owner = k.split(":r:")[0]
            if (!all[owner] || deletedSessions.has(owner)) toRemove.push(k)
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove)
    }
}

if (typeof window !== "undefined") {
    window.StationAutomationStorage = StationAutomationStorage
}
