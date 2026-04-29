"use strict"

/**
 * ORS snapshot store — versioned freeze-frames of the per-route ORS scrape
 * (rank, rating, connection list, price + service-profile + aircraft
 * context) so the user can build a reference dataset for time-series
 * comparison and model calibration.
 *
 * Why a separate store from the live ORS cache (`routeAssistant:ors:*`):
 *
 *   - The live cache holds the LATEST scrape; each scrape overwrites it.
 *     A user investigating "did my rank shift after I bumped the service
 *     profile?" needs both the before and after — not just the after.
 *   - Snapshots are user-meaningful checkpoints (after a config change,
 *     after a price move, before a competitor responds). Auto-archival on
 *     every scrape would flood the store; the slice gates archival behind
 *     `settings.ors.snapshotOnScrape` so the user opts in.
 *   - The context block in each snapshot (service profile, price snapshot,
 *     aircraft type, overrides) captures the ROUTE CONFIG that produced
 *     the ORS result — turning the snapshot set into a (config → result)
 *     calibration dataset for the projection model.
 *
 * One record per directional pair, holding an array of snapshots:
 *
 *   routeAssistant:orsSnapshot:<HUB>-<DEST>                  (legacy)
 *   routeAssistant:orsSnapshot:acct:<id>:<HUB>-<DEST>        (L2+)
 *     {
 *       hub, dest,
 *       snapshots: [
 *         {
 *           ts:      <ms — capture time>,
 *           label:   <string?, user-provided or auto>,
 *           reason:  <string?, why this was archived — "manual" | "post-scrape" | "post-apply">,
 *           record:  {
 *             scrapedAt, params, byClass, classesScraped,
 *             context: {serviceProfile, priceSnapshot, aircraft, overrides, serviceConfig}
 *           }
 *         },
 *         ...
 *       ],
 *       updatedAt: ms
 *     }
 *
 * Pair key is **directional** — same as the live ORS cache. Account-
 * scoped via `acctKey()`; legacy fallback during the canopy rollout
 * matches the route-overrides + sandbox-scenarios pattern.
 *
 * The cap (default MAX_PER_ROUTE) is enforced on archive — when the
 * (N+1)th lands, the oldest by `ts` is evicted. Manual `remove(hub, dest, ts)`
 * lets the user keep specific snapshots while making room.
 */
class RouteAssistantOrsSnapshotStore {
    static LEGACY_PREFIX = "routeAssistant:orsSnapshot:"
    static SCOPE_PREFIX  = "routeAssistant:orsSnapshot"
    static MAX_PER_ROUTE = 30
    static MAX_LABEL_LEN = 80

    static _pairKey(hub, dest) {
        return String(hub || "").toUpperCase() + "-" + String(dest || "").toUpperCase()
    }

    static _key(hub, dest) {
        return acctKey(RouteAssistantOrsSnapshotStore.SCOPE_PREFIX,
            RouteAssistantOrsSnapshotStore._pairKey(hub, dest))
    }

    static _legacyKey(hub, dest) {
        return RouteAssistantOrsSnapshotStore.LEGACY_PREFIX
            + RouteAssistantOrsSnapshotStore._pairKey(hub, dest)
    }

    /**
     * Read the full record. Returns the namespaced record if present;
     * otherwise falls back to the legacy unscoped key.
     */
    static async getRecord(hub, dest) {
        const ns = RouteAssistantOrsSnapshotStore._key(hub, dest)
        const lg = RouteAssistantOrsSnapshotStore._legacyKey(hub, dest)
        if (ns === lg) {
            const out = await chrome.storage.local.get([ns])
            return out[ns] || null
        }
        const out = await chrome.storage.local.get([ns, lg])
        if (out[ns] !== undefined) return out[ns]
        return out[lg] || null
    }

    /**
     * Lightweight list — drops the full connection arrays so a
     * snapshots-browser UI can render without paying full deserialisation
     * cost. Each entry has a `summary` block: rank-by-class, capacity
     * info, context highlights.
     */
    static async list(hub, dest) {
        const rec = await RouteAssistantOrsSnapshotStore.getRecord(hub, dest)
        if (!rec || !Array.isArray(rec.snapshots)) return []
        const out = []
        for (const s of rec.snapshots) {
            if (!s || !s.ts) continue
            out.push({
                ts:      s.ts,
                label:   s.label   || null,
                reason:  s.reason  || null,
                summary: RouteAssistantOrsSnapshotStore._summarise(s.record)
            })
        }
        // Most recent first.
        out.sort((a, b) => b.ts - a.ts)
        return out
    }

    /**
     * Load the full snapshot for one (hub, dest, ts) tuple. Returns null
     * when not found.
     */
    static async load(hub, dest, ts) {
        const rec = await RouteAssistantOrsSnapshotStore.getRecord(hub, dest)
        if (!rec || !Array.isArray(rec.snapshots)) return null
        for (const s of rec.snapshots) {
            if (s && s.ts === ts) return s
        }
        return null
    }

    /** Returns every snapshot for the route, most-recent first. Heavy — full records. */
    static async loadAll(hub, dest) {
        const rec = await RouteAssistantOrsSnapshotStore.getRecord(hub, dest)
        if (!rec || !Array.isArray(rec.snapshots)) return []
        return rec.snapshots.slice().sort((a, b) => b.ts - a.ts)
    }

    /**
     * Per-class competitor price timeseries built from the snapshot history.
     * Returns `[{ts, median, min, max, count}, ...]` sorted ascending by ts.
     * Skips snapshots whose class has no competitor nonstop. Pass cls as
     * "ECONOMY" / "BUSINESS" / "FIRST" / "CARGO".
     *
     * Cheap — walks the full record once per snapshot but reuses the same
     * stats helper as the summary, so the data shape matches what
     * bulkList consumers already see.
     */
    static async getCompetitorPriceTimeseries(hub, dest, cls) {
        const rec = await RouteAssistantOrsSnapshotStore.getRecord(hub, dest)
        if (!rec || !Array.isArray(rec.snapshots)) return []
        const out = []
        for (const s of rec.snapshots) {
            if (!s || !s.ts || !s.record || !s.record.byClass) continue
            const stats = RouteAssistantOrsSnapshotStore._competitorPriceStats(s.record.byClass[cls])
            if (!stats.count) continue
            out.push({ts: s.ts, median: stats.median, min: stats.min, max: stats.max, count: stats.count})
        }
        out.sort((a, b) => a.ts - b.ts)
        return out
    }

    /**
     * Archive one ORS scrape result as a snapshot. Caller passes the live
     * record (typically straight from `RouteAssistantOrsScraper.loadRecord`
     * or the result of `scrape()`); we deep-clone so subsequent mutations
     * upstream don't leak in.
     *
     * `opts.label` — optional human label.
     * `opts.reason` — "manual" | "post-scrape" | "post-apply" | string.
     * `opts.maxPerRoute` — override the per-route cap (defaults to MAX_PER_ROUTE).
     *
     * Returns the saved snapshot entry, or null if the input was rejected
     * (missing route or empty record).
     */
    static async archive(hub, dest, record, opts) {
        return RouteAssistantOrsSnapshotStore.archiveAt(
            currentAccountIdSync(), hub, dest, record, opts
        )
    }

    static async archiveAt(accountId, hub, dest, record, opts) {
        const hubU  = String(hub  || "").toUpperCase()
        const destU = String(dest || "").toUpperCase()
        if (!hubU || !destU) return null
        if (!record || typeof record !== "object") return null

        opts = opts || {}
        const cap = isFinite(opts.maxPerRoute) && opts.maxPerRoute > 0
            ? Math.floor(opts.maxPerRoute)
            : RouteAssistantOrsSnapshotStore.MAX_PER_ROUTE

        const entry = {
            ts:     Date.now(),
            label:  RouteAssistantOrsSnapshotStore._cleanLabel(opts.label),
            reason: typeof opts.reason === "string" ? opts.reason.slice(0, 60) : null,
            record: RouteAssistantOrsSnapshotStore._cloneRecord(record)
        }

        const key = accountId
            ? (RouteAssistantOrsSnapshotStore.SCOPE_PREFIX + ":acct:" + accountId + ":"
                + RouteAssistantOrsSnapshotStore._pairKey(hubU, destU))
            : RouteAssistantOrsSnapshotStore._legacyKey(hubU, destU)

        const out = await chrome.storage.local.get([key])
        const existing = out[key] || {hub: hubU, dest: destU, snapshots: []}
        const snapshots = Array.isArray(existing.snapshots) ? existing.snapshots.slice() : []
        snapshots.push(entry)

        // Enforce cap — drop oldest by `ts` until length <= cap.
        snapshots.sort((a, b) => b.ts - a.ts)
        while (snapshots.length > cap) snapshots.pop()

        const next = {
            hub:       hubU,
            dest:      destU,
            snapshots,
            updatedAt: Date.now()
        }
        await chrome.storage.local.set({[key]: next})
        return entry
    }

    /** Remove one snapshot by ts. */
    static async remove(hub, dest, ts) {
        const rec = await RouteAssistantOrsSnapshotStore.getRecord(hub, dest)
        if (!rec || !Array.isArray(rec.snapshots)) return false
        const next = rec.snapshots.filter(s => s && s.ts !== ts)
        if (next.length === rec.snapshots.length) return false
        const accountId = currentAccountIdSync()
        const key = accountId
            ? (RouteAssistantOrsSnapshotStore.SCOPE_PREFIX + ":acct:" + accountId + ":"
                + RouteAssistantOrsSnapshotStore._pairKey(hub, dest))
            : RouteAssistantOrsSnapshotStore._legacyKey(hub, dest)
        if (next.length === 0) {
            await chrome.storage.local.remove(key)
        } else {
            const updated = Object.assign({}, rec, {snapshots: next, updatedAt: Date.now()})
            await chrome.storage.local.set({[key]: updated})
        }
        return true
    }

    /** Wipe every snapshot for one route. */
    static async clearForRoute(hub, dest) {
        const ns = RouteAssistantOrsSnapshotStore._key(hub, dest)
        const lg = RouteAssistantOrsSnapshotStore._legacyKey(hub, dest)
        const keys = ns === lg ? [ns] : [ns, lg]
        await chrome.storage.local.remove(keys)
    }

    /**
     * Bulk-list — returns Map<pairKey, list> for many routes. Used by a
     * future "snapshots overview" UI that shows snapshot counts across
     * the whole network.
     */
    static async bulkList(pairs) {
        const out = new Map()
        if (!pairs || !pairs.length) return out
        const keys = []
        const pairKeys = []
        for (const p of pairs) {
            const [a, b] = Array.isArray(p) ? p : [p.hub, p.dest]
            const pk = RouteAssistantOrsSnapshotStore._pairKey(a, b)
            pairKeys.push(pk)
            keys.push(RouteAssistantOrsSnapshotStore._key(a, b))
            const lg = RouteAssistantOrsSnapshotStore._legacyKey(a, b)
            if (keys.indexOf(lg) < 0) keys.push(lg)
        }
        const blob = await chrome.storage.local.get(keys)
        for (let i = 0; i < pairs.length; i++) {
            const ns = RouteAssistantOrsSnapshotStore._key(pairs[i].hub || pairs[i][0], pairs[i].dest || pairs[i][1])
            const lg = RouteAssistantOrsSnapshotStore._legacyKey(pairs[i].hub || pairs[i][0], pairs[i].dest || pairs[i][1])
            const rec = blob[ns] !== undefined ? blob[ns] : (blob[lg] || null)
            if (!rec || !Array.isArray(rec.snapshots)) {
                out.set(pairKeys[i], [])
                continue
            }
            const list = []
            for (const s of rec.snapshots) {
                if (s && s.ts) {
                    list.push({
                        ts: s.ts,
                        label: s.label || null,
                        reason: s.reason || null,
                        summary: RouteAssistantOrsSnapshotStore._summarise(s.record)
                    })
                }
            }
            list.sort((a, b) => b.ts - a.ts)
            out.set(pairKeys[i], list)
        }
        return out
    }

    // --- internal helpers ---

    static _cleanLabel(raw) {
        if (raw == null) return null
        const s = String(raw).trim().slice(0, RouteAssistantOrsSnapshotStore.MAX_LABEL_LEN)
        return s || null
    }

    /**
     * Deep-clone the live ORS record so later mutations upstream don't
     * bleed into the archived snapshot. JSON round-trip is fine — every
     * field in the record is plain data (no functions, no Maps).
     */
    static _cloneRecord(record) {
        try {
            return JSON.parse(JSON.stringify(record))
        } catch (e) {
            // Defensive: if the record happens to carry something un-stringifiable
            // (shouldn't, but the scraper-output shape might evolve), drop those
            // fields rather than throwing.
            console.warn("[AES orsSnapshot] clone failed, falling back to shallow", e)
            return Object.assign({}, record)
        }
    }

    /**
     * Per-class competitor pricing stats from the connection list — median /
     * min / max across nonstop competitor (isOurs=false on every leg) prices.
     * Returns nulls when no competitor nonstop is in the cache. Multi-leg
     * connections are skipped: their `totalPrice` aggregates legs flown by
     * different carriers, so it can't be cleanly attributed to one competitor
     * for time-series modeling.
     */
    static _competitorPriceStats(classRec) {
        const out = {median: null, min: null, max: null, count: 0}
        if (!classRec || !Array.isArray(classRec.connections)) return out
        const prices = []
        for (const c of classRec.connections) {
            const flightLegs = (c.legs || []).filter(l => !l.isGround)
            if (!flightLegs.length || flightLegs.length > 1) continue
            if (flightLegs[0].isOurs) continue
            const p = Number(c.totalPrice)
            if (!isFinite(p) || p <= 0) continue
            prices.push(p)
        }
        if (!prices.length) return out
        prices.sort((a, b) => a - b)
        const mid = Math.floor(prices.length / 2)
        out.count  = prices.length
        out.min    = prices[0]
        out.max    = prices[prices.length - 1]
        out.median = (prices.length % 2)
            ? prices[mid]
            : Math.round((prices[mid - 1] + prices[mid]) / 2)
        return out
    }

    /**
     * Compact summary for the lightweight `list()` and `bulkList()` outputs.
     * Pulls per-class rank + rating + the top context highlights so a
     * snapshots-browser can render rows without paying full-record cost.
     */
    static _summarise(rec) {
        if (!rec) return null
        const out = {
            scrapedAt:        rec.scrapedAt || null,
            classesScraped:   Array.isArray(rec.classesScraped) ? rec.classesScraped.slice() : [],
            byClass:          {},
            totalConnections: 0,
            context:          null
        }
        if (rec.byClass && typeof rec.byClass === "object") {
            for (const cls in rec.byClass) {
                const c = rec.byClass[cls] || {}
                const compPrices = RouteAssistantOrsSnapshotStore._competitorPriceStats(c)
                out.byClass[cls] = {
                    rankAny:              c.rankAny              != null ? c.rankAny              : null,
                    rankFirstLegOurs:     c.rankFirstLegOurs     != null ? c.rankFirstLegOurs     : null,
                    rankBookable:         c.rankBookable         != null ? c.rankBookable         : null,
                    ourTopRating:         c.ourTopRating         != null ? c.ourTopRating         : null,
                    topCompetitorRating:  c.topCompetitorRating  != null ? c.topCompetitorRating  : null,
                    ratingGapToTop:       c.ratingGapToTop       != null ? c.ratingGapToTop       : null,
                    totalConnections:     c.totalConnections     != null ? c.totalConnections     : 0,
                    competitorPriceMedian: compPrices.median,
                    competitorPriceMin:    compPrices.min,
                    competitorPriceMax:    compPrices.max,
                    competitorPriceCount:  compPrices.count
                }
                out.totalConnections = Math.max(out.totalConnections, out.byClass[cls].totalConnections || 0)
            }
        }
        if (rec.context && typeof rec.context === "object") {
            const ctx = rec.context
            out.context = {
                serviceProfileName: (ctx.serviceProfile && ctx.serviceProfile.name) || null,
                priceY:             (ctx.priceSnapshot  && ctx.priceSnapshot.Y)     != null ? ctx.priceSnapshot.Y     : null,
                priceC:             (ctx.priceSnapshot  && ctx.priceSnapshot.C)     != null ? ctx.priceSnapshot.C     : null,
                priceF:             (ctx.priceSnapshot  && ctx.priceSnapshot.F)     != null ? ctx.priceSnapshot.F     : null,
                priceCargo:         (ctx.priceSnapshot  && ctx.priceSnapshot.Cargo) != null ? ctx.priceSnapshot.Cargo : null,
                aircraftType:       (ctx.aircraft       && ctx.aircraft.typeCode)   || null,
                weeklyFlights:      (ctx.aircraft       && ctx.aircraft.weeklyFlights) != null ? ctx.aircraft.weeklyFlights : null,
                serviceLevel:       (ctx.serviceConfig  && ctx.serviceConfig.serviceLevel) || null
            }
        }
        return out
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantOrsSnapshotStore = RouteAssistantOrsSnapshotStore
}
