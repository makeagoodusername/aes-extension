"use strict"

/**
 * CentralInventorySummaryStore — read-side aggregator for the central hub
 * Inventory tile. Walks chrome.storage.local for cached inventory records
 * written by `modules/route-assistant/inventory-page-scraper.js` and
 * produces summary rows. Pure read; never mutates storage.
 *
 * Cached record shape (from inventory-page-scraper.js):
 *   routeAssistant:inventory:<HUB>-<DEST>
 *     → {hub, dest, scrapedAt, source,
 *        classes: {Y, C, F, Cargo: {totalSeats, soldSeats, avgFare?}},
 *        departures: [{date, time, flight, flightNumberId, totalSeats, sold, classBreakdown?}],
 *        flightNumbers: [{code, flightNumberId}],
 *        parserNotes?}
 *
 * Output row shape (from loadAll):
 *   { hub, dest, scrapedAt,
 *     loads: {Y, C, F, Cargo, cargo, overall} (each number|null),
 *     lowLoadFlightCount, departureCount, flightNumberCount, flightNumbers,
 *     parserNotes }
 *
 * Loads are computed lazily here — the cache stores totalSeats/soldSeats per
 * class, not pre-computed percentages, because the scraper's data shape is
 * intentionally close to the AS source.
 */
class CentralInventorySummaryStore {
    static CACHE_PREFIX = "routeAssistant:inventory:"
    static LOW_LOAD_THRESHOLD = 0.5

    static _keyAccountId(key) {
        const m = /^routeAssistant:inventory:acct:([^:]+):/i.exec(String(key || ""))
        return m ? m[1] : null
    }

    static _effectiveAccountId(opts) {
        if (opts && opts.accountId) return String(opts.accountId)
        if (typeof currentAccountIdSync === "function") {
            try { return currentAccountIdSync() || null } catch (_) { /* noop */ }
        }
        if (window.AesAccountKey
                && typeof window.AesAccountKey.currentAccountIdSync === "function") {
            try { return window.AesAccountKey.currentAccountIdSync() || null } catch (_) { /* noop */ }
        }
        return null
    }

    static _preferCandidate(next, prev, accountId) {
        if (!prev) return true
        if (accountId) {
            const nextMatch = next.accountId === accountId
            const prevMatch = prev.accountId === accountId
            if (nextMatch !== prevMatch) return nextMatch
        }
        if (!!next.accountId !== !!prev.accountId) return !!next.accountId
        return (next.row.scrapedAt || 0) > (prev.row.scrapedAt || 0)
    }

    /**
     * @param {object} [opts]
     * @param {string} [opts.hub]               filter to one hub
     * @param {number} [opts.maxAgeDays]        drop records older than this
     * @param {number} [opts.lowLoadThreshold]  default 0.5
     * @returns {Promise<{rows: object[], totals: object}>}
     */
    static async loadAll(opts) {
        opts = opts || {}
        const threshold = isFinite(opts.lowLoadThreshold)
            ? Math.max(0, Math.min(1, opts.lowLoadThreshold))
            : CentralInventorySummaryStore.LOW_LOAD_THRESHOLD
        const hubFilter = opts.hub ? String(opts.hub).toUpperCase() : null
        const accountId = CentralInventorySummaryStore._effectiveAccountId(opts)
        const maxAgeMs = (isFinite(opts.maxAgeDays) && opts.maxAgeDays > 0)
            ? opts.maxAgeDays * 86400000
            : null

        const all = await chrome.storage.local.get(null)
        const prefix = CentralInventorySummaryStore.CACHE_PREFIX
        const now = Date.now()
        const rowsByPair = new Map()

        for (const k in all) {
            if (k.indexOf(prefix) !== 0) continue
            if (k.length === prefix.length) continue
            const keyAccountId = CentralInventorySummaryStore._keyAccountId(k)
            if (accountId && keyAccountId && keyAccountId !== accountId) continue
            const rec = all[k]
            if (!rec) continue
            if (hubFilter && String(rec.hub || "").toUpperCase() !== hubFilter) continue
            if (maxAgeMs && typeof rec.scrapedAt === "number"
                && (now - rec.scrapedAt) > maxAgeMs) continue

            const classes = rec.classes || {}
            const loads = {
                Y:     CentralInventorySummaryStore._classLoad(classes.Y),
                C:     CentralInventorySummaryStore._classLoad(classes.C),
                F:     CentralInventorySummaryStore._classLoad(classes.F),
                Cargo: CentralInventorySummaryStore._classLoad(classes.Cargo),
                overall: CentralInventorySummaryStore._overallPaxLoad(classes)
            }
            // Backward-compatible alias for older tile code/tests that used
            // the lowercase key before Cargo became a first-class column.
            loads.cargo = loads.Cargo
            const departures = Array.isArray(rec.departures) ? rec.departures : []
            const flightNumbers = CentralInventorySummaryStore._flightNumbers(rec, departures)

            const row = {
                hub:                String(rec.hub  || "").toUpperCase(),
                dest:               String(rec.dest || "").toUpperCase(),
                scrapedAt:          typeof rec.scrapedAt === "number" ? rec.scrapedAt : null,
                loads:              loads,
                lowLoadFlightCount: CentralInventorySummaryStore._countLowLoadDepartures(departures, threshold),
                departureCount:     departures.length,
                flightNumberCount:  flightNumbers.length,
                flightNumbers:      flightNumbers,
                parserNotes:        rec.parserNotes || null
            }
            const pairKey = row.hub + "-" + row.dest
            const next = {row, accountId: keyAccountId}
            const prev = rowsByPair.get(pairKey)
            if (CentralInventorySummaryStore._preferCandidate(next, prev, accountId)) {
                rowsByPair.set(pairKey, next)
            }
        }

        const rows = Array.from(rowsByPair.values()).map(entry => entry.row)
        rows.sort((a, b) => (b.scrapedAt || 0) - (a.scrapedAt || 0))

        const totals = {
            routeCount:         rows.length,
            lowLoadFlightCount: rows.reduce((s, r) => s + (r.lowLoadFlightCount || 0), 0),
            flightNumberCount:  rows.reduce((s, r) => s + (r.flightNumberCount || 0), 0),
            oldestScrapedAt:    rows.length ? Math.min.apply(null, rows.map(r => r.scrapedAt || Infinity)) : null,
            newestScrapedAt:    rows.length ? rows[0].scrapedAt : null
        }
        if (totals.oldestScrapedAt === Infinity) totals.oldestScrapedAt = null

        return {rows, totals}
    }

    static _classLoad(classRec) {
        if (!classRec) return null
        const total = Number(classRec.totalSeats)
        const sold  = Number(classRec.soldSeats)
        if (!isFinite(total) || total <= 0) return null
        if (!isFinite(sold)) return null
        return sold / total
    }

    static _flightNumbers(rec, departures) {
        const out = new Map()
        const add = (code, id) => {
            const cleanCode = String(code || "").replace(/\s+/g, " ").trim()
            const numId = id != null && isFinite(id) ? Number(id) : null
            if (!cleanCode && numId == null) return
            const key = numId != null ? "id:" + numId : "code:" + cleanCode.toUpperCase()
            const prev = out.get(key) || {}
            out.set(key, {
                code: cleanCode || prev.code || null,
                flightNumberId: numId != null ? numId : (prev.flightNumberId != null ? prev.flightNumberId : null)
            })
        }

        if (rec && Array.isArray(rec.flightNumbers)) {
            for (const fn of rec.flightNumbers) {
                if (!fn) continue
                add(fn.code || fn.flight || fn.flightNumber, fn.flightNumberId)
            }
        }
        if (Array.isArray(departures)) {
            for (const dep of departures) {
                if (!dep) continue
                add(dep.flight || dep.flightNumber, dep.flightNumberId)
            }
        }
        return Array.from(out.values()).sort((a, b) => {
            if (a.flightNumberId != null && b.flightNumberId != null) return a.flightNumberId - b.flightNumberId
            return String(a.code || "").localeCompare(String(b.code || ""))
        })
    }

    /**
     * Aggregate pax-class load: sum of sold across Y+C+F divided by sum of
     * totalSeats across Y+C+F. Cargo is excluded — it's volumetric, not
     * pax-comparable.
     */
    static _overallPaxLoad(classes) {
        if (!classes) return null
        let sumSold = 0, sumTotal = 0, sawAny = false
        for (const cls of ["Y", "C", "F"]) {
            const c = classes[cls]
            if (!c) continue
            const t = Number(c.totalSeats)
            const s = Number(c.soldSeats)
            if (!isFinite(t) || t <= 0 || !isFinite(s)) continue
            sumSold += s
            sumTotal += t
            sawAny = true
        }
        if (!sawAny || sumTotal <= 0) return null
        return sumSold / sumTotal
    }

    /**
     * Count departures whose overall pax load is below the threshold.
     * Prefers `classBreakdown` (Y+C+F sums) when present, falls back to
     * row-level `sold`/`totalSeats`. Skips rows where the denominator is
     * zero or missing — those don't count as "low" because we can't tell.
     */
    static _countLowLoadDepartures(departures, threshold) {
        if (!Array.isArray(departures)) return 0
        let count = 0
        for (const dep of departures) {
            if (!dep) continue
            let sold = null, total = null
            const cb = dep.classBreakdown
            if (cb && typeof cb === "object") {
                let s = 0, t = 0, sawAny = false
                for (const cls of ["Y", "C", "F"]) {
                    const cc = cb[cls]
                    if (!cc) continue
                    const ct = Number(cc.totalSeats)
                    const cs = Number(cc.sold != null ? cc.sold : cc.soldSeats)
                    if (!isFinite(ct) || ct <= 0 || !isFinite(cs)) continue
                    s += cs
                    t += ct
                    sawAny = true
                }
                if (sawAny && t > 0) { sold = s; total = t }
            }
            if (sold == null || total == null) {
                const t = Number(dep.totalSeats)
                const s = Number(dep.sold)
                if (isFinite(t) && t > 0 && isFinite(s)) { sold = s; total = t }
            }
            if (sold == null || total == null || total <= 0) continue
            if ((sold / total) < threshold) count++
        }
        return count
    }

    /**
     * Format a millisecond timestamp as a short relative string for tile
     * display: "just now" / "12 min ago" / "3h ago" / "Apr 26".
     */
    static formatRelative(ts, now) {
        if (!isFinite(ts)) return ""
        const cur = isFinite(now) ? now : Date.now()
        const diffSec = Math.max(0, Math.round((cur - ts) / 1000))
        if (diffSec < 60) return "just now"
        const diffMin = Math.round(diffSec / 60)
        if (diffMin < 60) return diffMin + " min ago"
        const diffHr = Math.round(diffMin / 60)
        if (diffHr < 24) return diffHr + "h ago"
        const d = new Date(ts)
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        return months[d.getMonth()] + " " + d.getDate()
    }
}

if (typeof window !== "undefined") {
    window.CentralInventorySummaryStore = CentralInventorySummaryStore
}
