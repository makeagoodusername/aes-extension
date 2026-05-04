"use strict"

/**
 * AesPhaseCadenceStore — per-phase last-run timestamps + staleness math
 * for the background auto-drive layer. Storage keyed per server+airline so
 * multi-account use stays isolated.
 *
 * Storage:
 *   scrapeOrchestrator:phase:<server>:<airline>:<phaseId>
 *     -> {phaseId, startedAt, completedAt, total, succeeded, failed, haltReason}
 *
 * Cadences are intentionally generous — drip-style, not exhaustive. The
 * heavy optional phases (per-competitor, flightsfrom) are NOT in the
 * mandatory list the auto-driver consults; users still trigger those via
 * the Scrape-everything button.
 */
;(function () {
    if (typeof window === "undefined" || window.AesPhaseCadenceStore) return

    const PREFIX = "scrapeOrchestrator:phase:"

    const DEFAULT_CADENCE_MS = {
        "foundation":     2 * 60 * 60 * 1000,
        "per-hub":        6 * 60 * 60 * 1000,
        "per-aircraft":  12 * 60 * 60 * 1000,
        "per-route":     24 * 60 * 60 * 1000,
        // ORS rank turns over fast (competitor schedule changes, our own
        // applies, fare moves) and the silent auto-pricer reads it on
        // every tick. 4h keeps the analyser current without burning the
        // ORS rate budget. Cheaper than per-route because the phase has
        // no tab-fan-out — only the postRun ORS sync runs.
        "ors-rank":       4 * 60 * 60 * 1000,
        "per-competitor": 2 * 24 * 60 * 60 * 1000,
        "flightsfrom":    7 * 24 * 60 * 60 * 1000
    }

    function _key(server, airline, phaseId) {
        return PREFIX + String(server || "") + ":" + String(airline || "") + ":" + String(phaseId || "")
    }

    async function record(host, phaseId, result) {
        if (!host || !host.server || !phaseId) return null
        const key = _key(host.server, host.airline, phaseId)
        const rec = {
            phaseId:     phaseId,
            startedAt:   (result && result.startedAt) || null,
            completedAt: Date.now(),
            total:       (result && result.total)     || 0,
            succeeded:   (result && result.succeeded) || 0,
            failed:      (result && result.failed)    || 0,
            haltReason:  (result && result.haltReason) || null
        }
        try { await chrome.storage.local.set({[key]: rec}) } catch (_) { /* noop */ }
        return rec
    }

    async function load(host, phaseId) {
        if (!host || !host.server || !phaseId) return null
        const key = _key(host.server, host.airline, phaseId)
        try {
            const out = await chrome.storage.local.get([key])
            return out[key] || null
        } catch (_) { return null }
    }

    async function loadAll(host, phaseIds) {
        const ids = phaseIds || Object.keys(DEFAULT_CADENCE_MS)
        const keys = ids.map(id => _key(host.server, host.airline, id))
        let blob = {}
        try { blob = await chrome.storage.local.get(keys) } catch (_) {}
        const out = {}
        for (let i = 0; i < ids.length; i++) {
            out[ids[i]] = blob[keys[i]] || null
        }
        return out
    }

    function ageMs(record) {
        if (!record || !record.completedAt) return Infinity
        return Date.now() - record.completedAt
    }

    function isStale(record, phaseId, override) {
        const cad = (override && override[phaseId]) || DEFAULT_CADENCE_MS[phaseId]
        if (!isFinite(cad)) return false
        return ageMs(record) >= cad
    }

    /**
     * Pick the most-overdue phase from the candidate list. Phases that
     * have never run land first (Infinity overdue ratio); among those that
     * have run, the one furthest past its cadence wins. Returns null when
     * everything is fresh.
     */
    async function pickStalest(host, phaseIds, cadenceOverride) {
        const records = await loadAll(host, phaseIds)
        let best = null
        let bestScore = -Infinity
        for (const id of phaseIds) {
            const r = records[id]
            const cad = (cadenceOverride && cadenceOverride[id]) || DEFAULT_CADENCE_MS[id]
            if (!isFinite(cad)) continue
            const age = ageMs(r)
            if (age < cad) continue
            const score = age / cad
            if (score > bestScore) { bestScore = score; best = id }
        }
        return best
    }

    window.AesPhaseCadenceStore = {
        record, load, loadAll, ageMs, isStale, pickStalest,
        DEFAULT_CADENCE_MS, PREFIX
    }
})()
