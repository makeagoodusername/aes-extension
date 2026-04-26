/**
 * Storage wrapper for *generated* schedules — the output of running a
 * preset through ScheduleBuilder against a particular airline's fleet
 * and routes.
 *
 * Records are keyed by `<server><airlineCode>scheduleManagement:<scheduleId>`
 * so each airline keeps its own draft history; an index record lives at
 * `<server><airlineCode>scheduleManagement:index` listing scheduleIds in
 * reverse chronological order so the panel can render the history without
 * scanning all of chrome.storage.
 *
 * A schedule is treated as immutable once written. Editing means generating
 * a new one and (optionally) deleting the old.
 */
class ScheduleStore {
    static _scheduleKey(server, airlineCode, scheduleId) {
        return server + airlineCode + "scheduleManagement:" + scheduleId
    }

    static _indexKey(server, airlineCode) {
        return server + airlineCode + "scheduleManagement:index"
    }

    /**
     * Builds an empty schedule record. Caller fills `flights` and `warnings`
     * before calling save().
     * @param {object} args - {server, airlineCode, presetId, presetName, hub}
     */
    static newSchedule(args) {
        const scheduleId = "s" + Date.now().toString(36)
        return {
            scheduleId: scheduleId,
            server: args.server,
            airlineCode: args.airlineCode,
            presetId: args.presetId || null,
            presetName: args.presetName || "",
            hub: args.hub || "",
            generatedAt: Date.now(),
            status: "draft",
            flights: [],
            warnings: []
        }
    }

    /** Returns the schedule record, or null if not found. */
    static async load(server, airlineCode, scheduleId) {
        if (!scheduleId) return null
        const key = ScheduleStore._scheduleKey(server, airlineCode, scheduleId)
        const data = await chrome.storage.local.get([key])
        return data[key] || null
    }

    /**
     * Persists a schedule and updates the index. The index keeps a max of
     * 20 entries; older schedules are dropped on the next save.
     */
    static async save(record) {
        const key = ScheduleStore._scheduleKey(record.server, record.airlineCode, record.scheduleId)
        const indexKey = ScheduleStore._indexKey(record.server, record.airlineCode)
        const data = await chrome.storage.local.get([indexKey])
        const index = data[indexKey] || []

        const filtered = index.filter(e => e.scheduleId !== record.scheduleId)
        filtered.unshift({
            scheduleId: record.scheduleId,
            presetName: record.presetName,
            hub: record.hub,
            generatedAt: record.generatedAt,
            status: record.status,
            flightCount: record.flights.length,
            warningCount: record.warnings.length
        })

        const MAX_HISTORY = 20
        const trimmed = filtered.slice(0, MAX_HISTORY)
        const dropped = filtered.slice(MAX_HISTORY)
            .map(e => ScheduleStore._scheduleKey(record.server, record.airlineCode, e.scheduleId))

        await chrome.storage.local.set({[key]: record, [indexKey]: trimmed})
        if (dropped.length) await chrome.storage.local.remove(dropped)
    }

    /**
     * Returns the index list (newest first). Each entry is a summary; call
     * load() with a scheduleId to get the full flight list.
     */
    static async listIndex(server, airlineCode) {
        const key = ScheduleStore._indexKey(server, airlineCode)
        const data = await chrome.storage.local.get([key])
        return data[key] || []
    }

    /** Deletes one schedule and removes it from the index. */
    static async remove(server, airlineCode, scheduleId) {
        const key = ScheduleStore._scheduleKey(server, airlineCode, scheduleId)
        const indexKey = ScheduleStore._indexKey(server, airlineCode)
        const data = await chrome.storage.local.get([indexKey])
        const index = (data[indexKey] || []).filter(e => e.scheduleId !== scheduleId)
        await chrome.storage.local.set({[indexKey]: index})
        await chrome.storage.local.remove([key])
    }

    /** Wipes every schedule for the airline. Used by the "clear history" button. */
    static async clear(server, airlineCode) {
        const indexKey = ScheduleStore._indexKey(server, airlineCode)
        const data = await chrome.storage.local.get([indexKey])
        const index = data[indexKey] || []
        const keys = index.map(e => ScheduleStore._scheduleKey(server, airlineCode, e.scheduleId))
        keys.push(indexKey)
        await chrome.storage.local.remove(keys)
    }
}
