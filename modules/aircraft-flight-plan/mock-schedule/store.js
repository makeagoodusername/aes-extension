"use strict"

/**
 * Mock-schedule store — persistence for the studio's draft schedule.
 *
 * Storage shape (per aircraft):
 *   key  = aircraftFlightPlan:mockSchedule:<server>:<aircraftId>
 *   acct = aircraftFlightPlan:mockSchedule:acct:<acctId>:<server>:<aircraftId>
 *   value = {
 *     server, aircraftId,
 *     hub,                 // current hub at save time
 *     spec,                // aircraft spec snapshot
 *     selectedAirports,    // [{iata, distanceKm}]
 *     flightsTarget,       // number
 *     opts,                // builder opts overrides (workingHours, ground times)
 *     legs,                // last-recommended legs
 *     warnings,            // last-recommendation warnings
 *     savedAt              // ms epoch
 *   }
 *
 * Two reads: `load(server, aircraftId)` returns the latest record (acct-scoped
 * preferred, legacy fallback). One write: `save(record)` writes both the
 * acct-scoped key (when an account id is available) and the legacy key in a
 * single chrome.storage.local.set so a partial failure can't desync the two.
 *
 * No DOM, no recommend logic — pure storage glue.
 */
;(function () {
    const PREFIX = "aircraftFlightPlan:mockSchedule"

    function _server(s) { return String(s || "").trim() }
    function _aid(a)    { return String(a || "").trim() }

    function _legacyKey(server, aircraftId) {
        return PREFIX + ":" + _server(server) + ":" + _aid(aircraftId)
    }
    function _scopedKey(server, aircraftId) {
        if (typeof window === "undefined") return null
        const helper = window.AesAccountKey
        if (!helper || typeof helper.acctKey !== "function") return null
        return helper.acctKey(PREFIX, _server(server) + ":" + _aid(aircraftId))
    }

    async function _read(key) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return null
        return new Promise(resolve => {
            try {
                chrome.storage.local.get([key], data => {
                    if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return }
                    resolve((data && data[key]) || null)
                })
            } catch (_) { resolve(null) }
        })
    }

    async function _write(map) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return false
        return new Promise(resolve => {
            try {
                chrome.storage.local.set(map, () => {
                    if (chrome.runtime && chrome.runtime.lastError) { resolve(false); return }
                    resolve(true)
                })
            } catch (_) { resolve(false) }
        })
    }

    async function load(server, aircraftId) {
        const scoped = _scopedKey(server, aircraftId)
        const legacy = _legacyKey(server, aircraftId)
        if (scoped) {
            const v = await _read(scoped)
            if (v) return v
        }
        return await _read(legacy)
    }

    async function save(record) {
        if (!record || !record.server || !record.aircraftId) {
            return {ok: false, error: "save: server + aircraftId required"}
        }
        const out = Object.assign({}, record, {savedAt: Date.now()})
        const legacy = _legacyKey(out.server, out.aircraftId)
        const scoped = _scopedKey(out.server, out.aircraftId)
        const map = {[legacy]: out}
        if (scoped && scoped !== legacy) map[scoped] = out
        const ok = await _write(map)
        return ok ? {ok: true, record: out} : {ok: false, error: "chrome.storage.set failed"}
    }

    async function clear(server, aircraftId) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return false
        const legacy = _legacyKey(server, aircraftId)
        const scoped = _scopedKey(server, aircraftId)
        const keys = scoped && scoped !== legacy ? [legacy, scoped] : [legacy]
        return new Promise(resolve => {
            try {
                chrome.storage.local.remove(keys, () => {
                    if (chrome.runtime && chrome.runtime.lastError) { resolve(false); return }
                    resolve(true)
                })
            } catch (_) { resolve(false) }
        })
    }

    const api = {
        load,
        save,
        clear,
        PREFIX,
        _internal: {_legacyKey, _scopedKey}
    }

    if (typeof window !== "undefined") {
        window.AesAfpMockScheduleStore = api
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api
    }
})()
