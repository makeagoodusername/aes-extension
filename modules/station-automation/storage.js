/**
 * Storage wrapper for the station-automation queue.
 *
 * The queue record is keyed by `<server><airlineCode>stationAutomationQueue`
 * so each airline on each server keeps its own queue.
 */
class StationAutomationStorage {
    static _key(server, airlineCode) {
        return server + airlineCode + "stationAutomationQueue"
    }

    static _empty(server, airlineCode) {
        return {
            server: server,
            airlineCode: airlineCode,
            type: "stationAutomationQueue",
            queue: [],
            running: 0,
            currentEntry: 0,
            currentStationIdx: 0,
            resolvedStations: [],
            processedStations: [],
            log: []
        }
    }

    /**
     * Returns the stored queue record, or a default empty one.
     * @returns {Promise<object>}
     */
    static async load(server, airlineCode) {
        const key = StationAutomationStorage._key(server, airlineCode)
        const fallback = StationAutomationStorage._empty(server, airlineCode)
        const result = await chrome.storage.local.get({[key]: fallback})
        return result[key]
    }

    /**
     * Persists a queue record.
     * @param {object} record
     * @returns {Promise<void>}
     */
    static async save(record) {
        const key = StationAutomationStorage._key(record.server, record.airlineCode)
        await chrome.storage.local.set({[key]: record})
    }

    /**
     * Clears the queue but preserves server/airline metadata.
     */
    static async clear(server, airlineCode) {
        await StationAutomationStorage.save(
            StationAutomationStorage._empty(server, airlineCode)
        )
    }

    /**
     * Appends a single country configuration to the queue.
     * @param {object} entry {country, countryName, paxThreshold, cargoThreshold, exceptions}
     */
    static async enqueue(server, airlineCode, entry) {
        const record = await StationAutomationStorage.load(server, airlineCode)
        record.queue.push(entry)
        await StationAutomationStorage.save(record)
        return record
    }

    /**
     * Removes the queued entry at the given index.
     */
    static async removeEntry(server, airlineCode, index) {
        const record = await StationAutomationStorage.load(server, airlineCode)
        if (index >= 0 && index < record.queue.length) {
            record.queue.splice(index, 1)
        }
        await StationAutomationStorage.save(record)
        return record
    }
}
