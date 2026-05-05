"use strict"

/**
 * AES Strategy — competitor prior-state store (Slice 10).
 *
 * Tiny chrome.storage.local store that captures `r.competitor` summaries
 * by (hub, dest) with a timestamp, so the competitor-response engine can
 * compute a week-over-week diff. Keeps the most recent prior per route
 * and a single rolling backup so a same-session re-capture doesn't blow
 * away the only week-old reference.
 *
 * Storage shape:
 *   aesStrategy:competitorPrior:<HUB>-<DEST> → {
 *     hub, dest,
 *     entries: [
 *       {ts, summary: {flightCount, seatCount, ourFlightCount,
 *                      dominantCarrier, priceMin, priceMax, scrapedAt}},
 *       …                                          // newest-first, capped at MAX_ENTRIES
 *     ],
 *     updatedAt
 *   }
 *
 * The engine reads via `loadPrior(hub, dest, opts?)` which returns the
 * most recent entry whose `ts` is older than `minAgeDays` (default 6) —
 * so same-session re-runs don't compare against themselves.
 *
 * Public API (window.AesStrategyCompetitorPriorStore):
 *   loadPrior(hub, dest, opts?)        → entry | null
 *   loadAll(hub, dest)                 → entries[] (newest-first)
 *   capture(hub, dest, summary, opts?) → {written: bool, reason}
 *   bulkLoadPrior(pairs, opts?)        → Map<"HUB-DEST", entry>
 *   clear(hub, dest)                   → void
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyCompetitorPriorStore) return

    const PREFIX             = "aesStrategy:competitorPrior:"
    const MAX_ENTRIES        = 4                 // 4 weeks of context, capped
    const DEFAULT_MIN_AGE_D  = 6
    const DEFAULT_DEBOUNCE_H = 1                 // skip writes < 1h apart

    function _key(hub, dest) {
        return PREFIX
            + String(hub  || "").toUpperCase() + "-"
            + String(dest || "").toUpperCase()
    }

    function _now() { return Date.now() }

    function _hours(ms) { return ms / 3_600_000 }

    function _days(ms)  { return ms / 86_400_000 }

    function _normSummary(summary) {
        if (!summary || typeof summary !== "object") return null
        return {
            flightCount:     summary.flightCount     != null ? Number(summary.flightCount)     : null,
            seatCount:       summary.seatCount       != null ? Number(summary.seatCount)       : null,
            ourFlightCount:  summary.ourFlightCount  != null ? Number(summary.ourFlightCount)  : null,
            dominantCarrier: summary.dominantCarrier || null,
            priceMin:        summary.priceMin        != null ? Number(summary.priceMin)        : null,
            priceMax:        summary.priceMax        != null ? Number(summary.priceMax)        : null,
            scrapedAt:       summary.scrapedAt       != null ? Number(summary.scrapedAt)       : null
        }
    }

    async function _readRecord(hub, dest) {
        const k = _key(hub, dest)
        try {
            const got = await chrome.storage.local.get([k])
            return got[k] || null
        } catch (_) { return null }
    }

    async function _writeRecord(hub, dest, rec) {
        const k = _key(hub, dest)
        try {
            await chrome.storage.local.set({[k]: rec})
        } catch (e) {
            console.warn("[AES competitorPriorStore] write failed", e)
        }
    }

    /**
     * Most recent entry whose timestamp is older than `minAgeDays`.
     * Returns null when no such entry exists (route is too new to diff,
     * or all priors are still inside the same-session window).
     */
    async function loadPrior(hub, dest, opts) {
        const minAgeDays = (opts && opts.minAgeDays != null)
            ? Number(opts.minAgeDays) : DEFAULT_MIN_AGE_D
        const rec = await _readRecord(hub, dest)
        if (!rec || !Array.isArray(rec.entries) || !rec.entries.length) return null
        const cutoff = _now() - minAgeDays * 86_400_000
        for (const e of rec.entries) {
            if (e && e.ts && e.ts <= cutoff && e.summary) return e
        }
        return null
    }

    async function loadAll(hub, dest) {
        const rec = await _readRecord(hub, dest)
        return (rec && Array.isArray(rec.entries)) ? rec.entries.slice() : []
    }

    /**
     * Bulk variant — one storage read for many pairs. Returns Map keyed
     * by "HUB-DEST". Missing pairs are absent from the map.
     */
    async function bulkLoadPrior(pairs, opts) {
        const out = new Map()
        if (!Array.isArray(pairs) || !pairs.length) return out
        const minAgeDays = (opts && opts.minAgeDays != null)
            ? Number(opts.minAgeDays) : DEFAULT_MIN_AGE_D
        const cutoff = _now() - minAgeDays * 86_400_000
        const keys = pairs.map(p => _key(p[0], p[1]))
        let blob = {}
        try { blob = await chrome.storage.local.get(keys) } catch (_) { return out }
        for (const p of pairs) {
            const rec = blob[_key(p[0], p[1])]
            if (!rec || !Array.isArray(rec.entries)) continue
            for (const e of rec.entries) {
                if (e && e.ts && e.ts <= cutoff && e.summary) {
                    out.set(String(p[0]).toUpperCase() + "-" + String(p[1]).toUpperCase(), e)
                    break
                }
            }
        }
        return out
    }

    /**
     * Append a new prior entry. Debounced — when the most recent entry
     * is younger than `debounceHours` (default 1h), skip the write so
     * same-session re-captures don't spam storage. Returns
     * {written: bool, reason} so the caller can log.
     */
    async function capture(hub, dest, summary, opts) {
        const norm = _normSummary(summary)
        if (!norm) return {written: false, reason: "empty-summary"}
        const debounceH = (opts && opts.debounceHours != null)
            ? Number(opts.debounceHours) : DEFAULT_DEBOUNCE_H
        const now = _now()
        const rec = (await _readRecord(hub, dest))
            || {hub: String(hub).toUpperCase(), dest: String(dest).toUpperCase(),
                entries: [], updatedAt: 0}
        const last = rec.entries && rec.entries[0]
        if (last && last.ts && _hours(now - last.ts) < debounceH) {
            return {written: false, reason: "debounced"}
        }
        const next = {ts: now, summary: norm}
        rec.entries  = [next].concat(rec.entries || []).slice(0, MAX_ENTRIES)
        rec.updatedAt = now
        await _writeRecord(hub, dest, rec)
        return {written: true, reason: last ? "appended" : "first"}
    }

    async function clear(hub, dest) {
        try { await chrome.storage.local.remove([_key(hub, dest)]) }
        catch (_) { /* swallow */ }
    }

    window.AesStrategyCompetitorPriorStore = {
        loadPrior:     loadPrior,
        loadAll:       loadAll,
        bulkLoadPrior: bulkLoadPrior,
        capture:       capture,
        clear:         clear,
        PREFIX:        PREFIX,
        MAX_ENTRIES:   MAX_ENTRIES,
        DEFAULT_MIN_AGE_DAYS:  DEFAULT_MIN_AGE_D,
        DEFAULT_DEBOUNCE_HOURS: DEFAULT_DEBOUNCE_H
    }
})()
