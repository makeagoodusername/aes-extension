"use strict"

/**
 * Yield-snapshot engine for the Route Assistant.
 *
 * Closes the loop between the rough profit estimator and the user's actual
 * realised profits. Each `takeSnapshot` run:
 *
 *   1. Walks every `<server>aircraftFlights<aircraftId>` record in
 *      chrome.storage.local. Those are written by `content_aircraftFlights.js`
 *      whenever the user visits an aircraft's flight-history page; each
 *      contains lifetime `profit` (sum across `profitFlights` extracted
 *      flights) plus `equipment` and `registration`.
 *
 *   2. Reads every `routeAssistant:ticketPrice:*` record (written by
 *      `RouteAssistantTicketPriceScraper`) — those carry the assigned-tail
 *      list per route. The intersection (tail × route) is the join we need.
 *
 *   3. For each tail T flying route R with weekly flights f(T,R), assumes
 *      T's lifetime average $/flt is approximately the same on every route
 *      it flies (the simplest defensible attribution given no per-route
 *      profit data). Then route R's actual $/wk is sum over contributing
 *      tails of (T.$/flt × f(T,R)), and $/flt is $/wk ÷ Σf(T,R).
 *
 *   4. Persists one snapshot per route via RouteAssistantYieldHistoryStore.
 *
 * Limits to disclose in UI:
 *   - Only routes whose ticket-price record has been scraped get attribution.
 *     Run "Sync route data for all visible routes" first.
 *   - Tails the user hasn't visited via /app/fleets/aircraft/<id>/1 won't
 *     appear in the join. The snapshot reports `tailsMissingProfit` so the
 *     panel can nudge the user.
 *   - aircraftFlights profits are CUMULATIVE. v1 stores cumulative averages;
 *     a future variant will track snapshot-to-snapshot deltas for true
 *     periodic yield. Useful enough today for forecast-vs-actual.
 *
 * Attribution modes (settings.routeAssistant.yieldFeedback.attributionMode):
 *   - "frequency" (default) — split by weekly flights per route.
 *   - "distance"            — split by km flown per route per week.
 *   - "equal"               — split equally across routes the tail flies.
 */
class RouteAssistantYieldSnapshot {
    /**
     * Baseline storage — single global key holding the lifetime profit /
     * profitFlights of every contributing tail at the time of the previous
     * snapshot. Delta mode subtracts these from the current `aircraftFlights`
     * record to compute the *periodic* $/flt since the last run instead of a
     * cumulative lifetime average.
     */
    static BASELINE_KEY = "routeAssistant:yieldBaselines"

    /**
     * @param {object} input
     * @param {string} input.server          AS server name (e.g. "free1").
     * @param {string} [input.hubIata]       Optional: scope to routes leaving
     *                                        this hub. Default: all hubs.
     * @param {string} [input.attributionMode="frequency"]
     * @param {number} [input.historyLimit=12]
     * @param {boolean} [input.deltaMode=false]
     *   When true, per-tail $/flt is computed from the change in the tail's
     *   `aircraftFlights` profit/flights since the last snapshot baseline,
     *   instead of the cumulative-lifetime average. Tails with no prior
     *   baseline (first snapshot, newly visited tails) silently fall back to
     *   cumulative for that run — the result records `mode: "delta"` either
     *   way so the panel can show the user what was used.
     * @param {Map<string,{distanceKm}>} [input.distanceMap]
     *   Optional map of pairKey → cached distance, used when attributionMode
     *   is "distance". Falls back to "frequency" for any pair without cache.
     * @returns {Promise<{routesUpdated, tailsUsed, tailsMissingProfit,
     *                    routesScanned, snapshotAt, hubsTouched, snapshots,
     *                    mode, tailsUsingDelta}>}
     */
    static async takeSnapshot(input) {
        input = input || {}
        const server          = String(input.server || "").trim()
        const hubFilter       = input.hubIata ? String(input.hubIata).toUpperCase() : null
        const requestedMode   = (input.attributionMode === "distance" || input.attributionMode === "equal"
                                 || input.attributionMode === "per-flight")
            ? input.attributionMode : "frequency"
        const historyLimit    = input.historyLimit || 12
        const distanceMap     = (input.distanceMap instanceof Map) ? input.distanceMap : null
        const deltaMode       = !!input.deltaMode

        if (!server) throw new Error("RouteAssistantYieldSnapshot.takeSnapshot: server required")

        const all = await chrome.storage.local.get(null)
        const aircraftRecs   = RouteAssistantYieldSnapshot._collectAircraftFlights(all, server)
        const priceRecs      = RouteAssistantYieldSnapshot._collectTicketPriceRecords(all, hubFilter)
        const baselines      = deltaMode ? (all[RouteAssistantYieldSnapshot.BASELINE_KEY] || {}) : null
        const regToProfit    = RouteAssistantYieldSnapshot._buildRegProfitMap(aircraftRecs, baselines)

        // Pre-pass — for "equal" / "distance" we need to know, per tail, the
        // full set of routes it flies + their weights. Build that even for
        // "frequency" because we use it to enrich the per-route numerator.
        const tailRoutes = RouteAssistantYieldSnapshot._buildTailRouteMap(priceRecs, distanceMap)

        // Per-flight aggregator (G slice 4) — when `requestedMode === "per-flight"`,
        // walks every tail's `flights[]` envelope and joins each finished/inflight
        // entry with its <server>flightInfo<flightId> record for the AS$ profit.
        // Aggregates by the envelope's own (originIata, destinationIata) pair —
        // exact attribution, no frequency weighting, multi-leg FNs handled
        // naturally because each leg's envelope carries its own route. Built
        // unconditionally so the snapshot diagnostics can report what would
        // have been available even when the user is on a different mode.
        const perFlightMap = RouteAssistantYieldSnapshot._collectPerFlightProfits(
            all, server, hubFilter, aircraftRecs
        )

        const entries           = []
        const contributingTails = new Set()
        const seenTails         = new Set()
        const tailsMissingSet   = new Set()
        const hubsTouched       = new Set()
        const tailsUsingDelta   = new Set()
        let routesWithPerFlight = 0
        let routesFellBack      = 0

        for (const rec of priceRecs) {
            const routeKey = rec.hub + "-" + rec.dest

            // Per-flight short-circuit. When the mode is "per-flight" AND the
            // route has at least one measured flight (envelope + flightInfo
            // both present), use the exact aggregate and skip the tail-based
            // weighting entirely. Otherwise fall through to the legacy path.
            const perFlight = (requestedMode === "per-flight")
                ? (perFlightMap.get(routeKey) || null)
                : null
            if (perFlight && perFlight.count > 0) {
                hubsTouched.add(rec.hub)
                routesWithPerFlight++
                for (const r of perFlight.tailRegs) {
                    seenTails.add(r); contributingTails.add(r)
                }
                entries.push({
                    hub:  rec.hub,
                    dest: rec.dest,
                    snapshot: {
                        timestamp:             Date.now(),
                        profitPerFlight:       Math.round(perFlight.profit / perFlight.count),
                        profitPerWeek:         Math.round(perFlight.profit / perFlight.count
                                                    * RouteAssistantYieldSnapshot._weeklyFreqOf(rec)),
                        frequency:             perFlight.count,
                        aircraftTypeNames:     Array.from(perFlight.typeNames),
                        aircraftRegistrations: Array.from(perFlight.tailRegs),
                        contributingTails:     perFlight.tailRegs.size,
                        totalKnownTails:       perFlight.tailRegs.size,
                        attributionMode:       "per-flight",
                        contributingFlights:   perFlight.count,
                        mode:                  "per-flight"
                    }
                })
                continue
            }

            // Per-route map<reg, weeklyFreq>. Multiple flightNumber rows can
            // share a registration; sum them up.
            const tailFreqOnRoute = new Map()
            for (const f of (rec.flights || [])) {
                if (!f || !f.registration) continue
                const days = RouteAssistantYieldSnapshot._countActiveDays(f.frequencyDays)
                if (!days) continue
                tailFreqOnRoute.set(f.registration,
                    (tailFreqOnRoute.get(f.registration) || 0) + days)
            }
            if (!tailFreqOnRoute.size) continue
            if (requestedMode === "per-flight") routesFellBack++

            // For per-flight requests that fell back, run the per-tail
            // weighting in plain "frequency" mode — distance/equal weights
            // are the wrong default to lean on as a fallback.
            const fallbackMode = (requestedMode === "per-flight") ? "frequency" : requestedMode

            let totalFreq         = 0
            let totalProfit       = 0
            let totalKnownTails   = 0
            let routeContribTails = 0
            const typeNames       = new Set()
            const regs            = new Set()

            for (const [reg, freq] of tailFreqOnRoute) {
                seenTails.add(reg)
                totalKnownTails++
                const stats = regToProfit.get(reg)
                if (!stats || !stats.profitFlights || stats.profitFlights <= 0) {
                    tailsMissingSet.add(reg)
                    continue
                }
                const tailPpf = stats.tailPpf  // already delta-aware (see _buildRegProfitMap)
                if (stats.usedDelta) tailsUsingDelta.add(reg)
                const weight  = RouteAssistantYieldSnapshot._weightForTail(
                    reg, freq, routeKey, fallbackMode, tailRoutes
                )
                totalFreq   += weight.frequency
                totalProfit += tailPpf * weight.share
                if (stats.equipment) typeNames.add(stats.equipment)
                regs.add(reg)
                routeContribTails++
                contributingTails.add(reg)
            }

            if (!routeContribTails || totalFreq <= 0) continue

            const profitPerFlight = totalProfit / totalFreq
            const profitPerWeek   = totalProfit
            hubsTouched.add(rec.hub)
            entries.push({
                hub:  rec.hub,
                dest: rec.dest,
                snapshot: {
                    timestamp:             Date.now(),
                    profitPerFlight:       Math.round(profitPerFlight),
                    profitPerWeek:         Math.round(profitPerWeek),
                    frequency:             totalFreq,
                    aircraftTypeNames:     Array.from(typeNames),
                    aircraftRegistrations: Array.from(regs),
                    contributingTails:     routeContribTails,
                    totalKnownTails:       totalKnownTails,
                    attributionMode:       fallbackMode,
                    mode:                  deltaMode ? "delta" : "cumulative"
                }
            })
        }

        const updated = entries.length
            ? await RouteAssistantYieldHistoryStore.appendSnapshots(entries, {historyLimit})
            : new Map()

        // Refresh the global baseline map from the *current* aircraftFlights
        // numbers so the next delta-mode run can subtract them. We do this
        // even when the run was cumulative so a future toggle to delta-mode
        // gets a meaningful starting point. Only persist tails we actually
        // saw — pruning keeps the baseline blob small.
        if (contributingTails.size || seenTails.size) {
            await RouteAssistantYieldSnapshot._saveBaselines(aircraftRecs, seenTails)
        }

        return {
            routesUpdated:        updated.size,
            routesScanned:        priceRecs.length,
            tailsUsed:            contributingTails.size,
            tailsSeen:            seenTails.size,
            tailsMissingProfit:   tailsMissingSet.size,
            tailsMissingList:     Array.from(tailsMissingSet),
            hubsTouched:          Array.from(hubsTouched),
            snapshotAt:           Date.now(),
            snapshots:            updated,
            mode:                 deltaMode ? "delta" : "cumulative",
            tailsUsingDelta:      tailsUsingDelta.size,
            attributionMode:      requestedMode,
            routesWithPerFlight:  routesWithPerFlight,
            routesFellBack:       routesFellBack,
            perFlightAvailable:   perFlightMap.size  // routes where per-flight COULD have attributed
        }
    }

    /**
     * Weekly frequency for a ticket-price record — sums days/wk across every
     * `flightNumber` row in `rec.flights[]`. Used by per-flight attribution
     * to project the per-flight $/flt up to a $/wk number that's directly
     * comparable to the existing column.
     */
    static _weeklyFreqOf(rec) {
        if (!rec || !Array.isArray(rec.flights)) return 0
        let n = 0
        for (const f of rec.flights) {
            if (!f) continue
            n += RouteAssistantYieldSnapshot._countActiveDays(f.frequencyDays) || 0
        }
        return n
    }

    /**
     * Per-flight aggregator — walks every `<server>aircraftFlights<id>`
     * record's `flights[]` envelope (G slice 4 wrote those) and joins each
     * envelope with its `<server>flightInfo<flightId>` financial record.
     *
     * Aggregates per `{originIata, destinationIata}` route key (using the
     * envelope's own origin/dest, not the schedule cache — multi-leg FNs are
     * naturally handled because each leg's envelope carries its own route).
     *
     * Skips:
     *   - Envelopes missing originIata/destinationIata (legacy cache, pre-slice 4)
     *   - Envelopes whose status is not "finished"/"inflight" (no profit yet)
     *   - Envelopes whose flightInfo record is missing (user hasn't visited
     *     the flight detail page) — these don't contribute, but their tail
     *     reg is recorded so the diag can report coverage gaps.
     *
     * Returns Map<"HUB-DEST", {profit, count, tailRegs:Set, typeNames:Set,
     *                          fnIds:Set, missingFinancials}>.
     */
    static _collectPerFlightProfits(all, server, hubFilter, aircraftRecs) {
        const out = new Map()
        const tag = "flightInfo"
        for (const rec of aircraftRecs) {
            if (!rec || !Array.isArray(rec.flights)) continue
            for (const env of rec.flights) {
                if (!env || !env.originIata || !env.destinationIata) continue
                if (env.status !== "finished" && env.status !== "inflight") continue
                if (hubFilter && env.originIata !== hubFilter) continue
                const flightInfoKey = server + tag + env.flightId
                const fi = all[flightInfoKey]
                const totalAmount = (fi && fi.money && fi.money.CM5)
                    ? Number(fi.money.CM5.Total) : null
                const routeKey = env.originIata + "-" + env.destinationIata
                let slot = out.get(routeKey)
                if (!slot) {
                    slot = {
                        profit: 0, count: 0,
                        tailRegs: new Set(), typeNames: new Set(),
                        fnIds: new Set(), missingFinancials: 0
                    }
                    out.set(routeKey, slot)
                }
                if (rec.registration) slot.tailRegs.add(rec.registration)
                if (rec.equipment)    slot.typeNames.add(rec.equipment)
                if (typeof env.flightNumberId === "number") slot.fnIds.add(env.flightNumberId)
                if (totalAmount !== null && isFinite(totalAmount)) {
                    slot.profit += totalAmount
                    slot.count++
                } else {
                    slot.missingFinancials++
                }
            }
        }
        // Drop routes where every flight was missing financials — no signal.
        for (const [k, slot] of out) {
            if (slot.count === 0) out.delete(k)
        }
        return out
    }

    /**
     * Map<reg, {profit, profitFlights, equipment, aircraftId, savedAt,
     *           tailPpf, usedDelta}> from every <server>aircraftFlights*
     * record in storage. Skips entries with no profit data so the snapshot
     * loop can short-circuit cleanly.
     *
     * `tailPpf` is the per-flight profit the snapshot loop should attribute
     * to this tail. When `baselines` (the global previous-snapshot baseline
     * blob) is provided AND the tail had a meaningful prior baseline, it's
     * the *delta* since the last snapshot — `(profit − prevProfit) /
     * (profitFlights − prevProfitFlights)`. Otherwise it's the cumulative
     * lifetime average. `usedDelta` records which path was taken so the
     * caller can surface the count.
     *
     * Pass `baselines = null` to force pure cumulative mode (the v1
     * behaviour).
     */
    static _buildRegProfitMap(aircraftRecs, baselines) {
        const m = new Map()
        for (const rec of aircraftRecs) {
            if (!rec || !rec.registration) continue
            const profit        = Number(rec.profit) || 0
            const profitFlights = Number(rec.profitFlights) || 0
            if (!profitFlights || profitFlights <= 0) continue

            let tailPpf = profit / profitFlights
            let usedDelta = false
            if (baselines) {
                const prev = baselines[rec.registration]
                if (prev && typeof prev.profitFlights === "number" && prev.profitFlights > 0) {
                    const dFlights = profitFlights - prev.profitFlights
                    const dProfit  = profit - (Number(prev.profit) || 0)
                    if (dFlights > 0) {
                        tailPpf   = dProfit / dFlights
                        usedDelta = true
                    }
                    // dFlights == 0 (no new flights since baseline) → tail
                    // hasn't moved. Falls through to cumulative so the row
                    // still reflects something rather than NaN — but it'll
                    // be flat across snapshots, which the sparkline reveals.
                }
            }

            m.set(rec.registration, {
                profit:        profit,
                profitFlights: profitFlights,
                equipment:     rec.equipment || null,
                aircraftId:    rec.aircraftId || null,
                savedAt:       rec.date || null,
                tailPpf:       tailPpf,
                usedDelta:     usedDelta
            })
        }
        return m
    }

    /**
     * Persist the current cumulative profit / profitFlights for every tail
     * we observed this run, keyed by registration. Future delta-mode runs
     * subtract these from the next aircraftFlights record to get periodic
     * yield. We only update tails that had data this round; stale tails
     * keep their last-known baseline.
     */
    static async _saveBaselines(aircraftRecs, observedTails) {
        const all = await chrome.storage.local.get([RouteAssistantYieldSnapshot.BASELINE_KEY])
        const blob = all[RouteAssistantYieldSnapshot.BASELINE_KEY] || {}
        const now = Date.now()
        for (const rec of aircraftRecs) {
            if (!rec || !rec.registration) continue
            if (!observedTails.has(rec.registration)) continue
            const profitFlights = Number(rec.profitFlights) || 0
            if (profitFlights <= 0) continue
            blob[rec.registration] = {
                profit:        Number(rec.profit) || 0,
                profitFlights: profitFlights,
                savedAt:       now
            }
        }
        await chrome.storage.local.set({[RouteAssistantYieldSnapshot.BASELINE_KEY]: blob})
    }

    /**
     * Bulk pass through storage to find `<server>aircraftFlights<id>` records.
     * They share a server-prefixed naming scheme with no separator between
     * the magic word and the id, so we filter by prefix + suffix on the type
     * marker that `content_aircraftFlights.js` writes.
     */
    static _collectAircraftFlights(allStorage, server) {
        const out = []
        const tag = "aircraftFlights"
        for (const key in allStorage) {
            if (key.indexOf(server) !== 0) continue
            if (key.indexOf(tag, server.length) !== server.length) continue
            const rec = allStorage[key]
            if (!rec || rec.type !== tag) continue
            out.push(rec)
        }
        return out
    }

    /**
     * All cached scheduling-page scrapes. Ticket-price records key by
     * routeAssistant:ticketPrice:<HUB>-<DEST>. Optionally filter to those
     * leaving a specific hub.
     */
    static _collectTicketPriceRecords(allStorage, hubFilter) {
        const prefix = RouteAssistantTicketPriceScraper.CACHE_PREFIX
        const out = []
        for (const key in allStorage) {
            if (key.indexOf(prefix) !== 0) continue
            const rec = allStorage[key]
            if (!rec || !rec.hub || !rec.dest) continue
            if (hubFilter && String(rec.hub).toUpperCase() !== hubFilter) continue
            if (!Array.isArray(rec.flights) || !rec.flights.length) continue
            out.push(rec)
        }
        return out
    }

    /**
     * Map<reg, {totalFreq, totalDistanceFreq, routes: Map<routeKey, {freq, distanceKm?}>}>
     * — what every tail flies, used for attribution modes that need the
     * tail's full picture (equal split, distance-weighted).
     */
    static _buildTailRouteMap(priceRecs, distanceMap) {
        const m = new Map()
        for (const rec of priceRecs) {
            const routeKey = rec.hub + "-" + rec.dest
            const distKm   = distanceMap ? RouteAssistantYieldSnapshot._lookupDistance(distanceMap, rec.hub, rec.dest) : null
            for (const f of (rec.flights || [])) {
                if (!f || !f.registration) continue
                const days = RouteAssistantYieldSnapshot._countActiveDays(f.frequencyDays)
                if (!days) continue
                let slot = m.get(f.registration)
                if (!slot) {
                    slot = {totalFreq: 0, totalDistanceFreq: 0, routes: new Map()}
                    m.set(f.registration, slot)
                }
                const route = slot.routes.get(routeKey) || {freq: 0, distanceKm: distKm}
                route.freq += days
                slot.routes.set(routeKey, route)
                slot.totalFreq += days
                if (distKm) slot.totalDistanceFreq += days * distKm
            }
        }
        return m
    }

    /**
     * Distance-resolver pair keys are alphabetically sorted (symmetric).
     * Try both orderings without committing to one when looking up.
     */
    static _lookupDistance(distanceMap, hub, dest) {
        const a = String(hub  || "").toUpperCase()
        const b = String(dest || "").toUpperCase()
        const k1 = a + "-" + b
        const k2 = b + "-" + a
        const v1 = distanceMap.get(k1)
        if (v1 && typeof v1.distanceKm === "number") return v1.distanceKm
        const v2 = distanceMap.get(k2)
        if (v2 && typeof v2.distanceKm === "number") return v2.distanceKm
        return null
    }

    /**
     * Count digits 1-7 in an AS frequency-days string (e.g. "1234567",
     * "_234567", "1__4567"). Each digit = one departure on that day; "_"
     * means not flown. Returns the number of departures per week for this
     * particular flight-number row.
     */
    static _countActiveDays(s) {
        if (!s) return 0
        let n = 0
        for (let i = 0; i < s.length; i++) {
            const ch = s.charAt(i)
            if (ch >= "1" && ch <= "7") n++
        }
        return n
    }

    /**
     * Compute the attribution weight a tail contributes to one route, given
     * the chosen mode. Returns {frequency, share} where:
     *   frequency = weekly flights credited to this route
     *   share     = the multiplier on the tail's $/flt for this route
     *
     * For "frequency" both are equal to f(tail, route): tail's $/flt × f
     * is added to the route's profit, and f is added to the route's freq.
     *
     * For "equal": the tail's $/flt is spread evenly across every route it
     * flies, so share = ppf × (1 / nRoutes(tail)) — but our aggregator does
     * (sumProfit / sumFreq), so we make `share` carry the "this route gets
     * 1/N of the tail's *typical* flight" idea by setting share = freq/N
     * relative to ppf-as-a-rate. Easier framing: equal-mode pretends every
     * route the tail flies has the same effective freq weight regardless of
     * how often the tail visits it. We approximate by giving each route
     * weight = totalFreq / nRoutes.
     *
     * For "distance": share is proportional to (freq × distance) / total
     * distance-flights for the tail.
     */
    static _weightForTail(reg, freq, routeKey, mode, tailRoutes) {
        if (mode === "frequency") {
            return {frequency: freq, share: freq}
        }
        const slot = tailRoutes.get(reg)
        if (!slot) return {frequency: freq, share: freq}

        if (mode === "equal") {
            const n = slot.routes.size || 1
            const w = slot.totalFreq / n
            return {frequency: w, share: w}
        }

        if (mode === "distance") {
            const route = slot.routes.get(routeKey)
            const dist  = route && route.distanceKm
            if (!dist || !slot.totalDistanceFreq) {
                // No distance available — silently fall back to frequency
                // for this tail-route pair so the snapshot still produces a
                // useful number.
                return {frequency: freq, share: freq}
            }
            const distFreq = freq * dist
            const w = slot.totalFreq * (distFreq / slot.totalDistanceFreq)
            return {frequency: w, share: w}
        }
        return {frequency: freq, share: freq}
    }
}
