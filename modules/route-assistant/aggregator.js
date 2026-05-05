/**
 * Builds the unified per-destination route record that drives the Route
 * Assistant table. Pure: takes the data sources as inputs, returns an array
 * of rows. The panel decides how to render and score them.
 *
 *   buildRouteRows({hubIata, ffData, demandMap, ownSchedule, fleetContext, interlineByPair})
 *
 * Inputs:
 *   hubIata       — origin IATA the user is scheduling from.
 *   ffData        — FlightsFromStore record for the hub:
 *                   {iata, scrapedAt, routes: [{destIata, destName,
 *                    weeklyFlights, seatsPerWeek, distanceKm, airlines, aircraft}]}
 *   demandMap     — Map<IATA, demandRecord> from RouteAssistantDemandStore.getMany.
 *   interlineByPair — optional Map<"HUB-DEST", interlineRecord> (or plain
 *                   object keyed the same way — the bulkLoad return shape)
 *                   from RouteAssistantInterlineStore. When supplied, each
 *                   row gets an `interlineShares: {paxPercent, cargoPercent}`
 *                   field that the estimator uses to trim effective LF
 *                   for capacity sold via codeshare partners.
 *   ownSchedule   — record from chrome.storage.local["<server><airlineCode>schedule"].
 *                   Shape: {date: {<dateYYYYMMDD>: {date, schedule:
 *                     [{origin, destination, flightNumber: {<n>: {paxFreq,
 *                     cargoFreq, ...}}}]}}}
 *   afpSchedules  — array of per-aircraft AFP schedule records from
 *                   `aircraftFlightPlan:schedule:<server>:<aircraftId>`
 *                   keys (Track 7 / AesAfpScheduleStore). Each record
 *                   carries `legs[]` with `{origin, destination, flightCode}`.
 *                   The legacy ownSchedule is a manual snapshot that goes
 *                   stale; AFP records are written live whenever the user
 *                   visits an AFP page. Whichever source shows MORE weekly
 *                   freq for a given (hub, dest) pair wins per-pair, so a
 *                   route the user has built is correctly marked "operating"
 *                   even if only one of the two sources knows about it.
 *   fleetContext  — optional Phase 2 input for aircraft-aware columns:
 *                   {selectedSpec, fleetSpecs, falloffPct, economics, overrides}
 *                     selectedSpec — chosen aircraft spec to evaluate every
 *                       row against. When mode is "fleet", the panel passes
 *                       null and we pick per-row via fleetSpecs.
 *                     fleetSpecs   — array of all owned aircraft specs (for
 *                       "Fleet (any)" mode). The aggregator picks the most
 *                       economical fit per row.
 *                     overrides    — optional Map<"<HUB>-<DEST>", override>
 *                       from RouteAssistantRouteOverridesStore.getMany. The
 *                       per-row override beats the demand-driven LF curve
 *                       and configured base yield in the profit estimator.
 *                     falloffPct, economics — passed straight to the
 *                       profit estimator.
 *
 * Output rows have:
 *   destIata, destName, distanceKm, airlineCount,
 *   weeklyFlights, seatsPerWeek,
 *   paxScore, cargoScore (or null when demand is unresolved),
 *   ownPaxFreq, ownCargoFreq, ownTotalFreq,
 *   operating — boolean (true iff ownTotalFreq > 0)
 *   health    — "OK" | "UNDER" | "OVER" | "OOR" — independent of operating;
 *               an unflown route with paxScore ≥ 8 reads as UNDER (candidate),
 *               an unreachable spec reads as OOR, etc.
 *   status    — "NEW" | "OK" | "UNDER" | "OVER" | "OOR" — derived as
 *               `operating ? health : "NEW"`. Kept for back-compat with the
 *               status-history-store transition log + the right-click menu
 *               that gates the opening-checklist on status === "NEW".
 *
 * When `fleetContext` is provided, rows additionally carry:
 *   aircraftFit ("optimal"|"falloff"|"oor"|null), blockHours,
 *   profitPerFlight, profitPerWeek, fitOk (1|0|null), aircraftTypeName
 */
class RouteAssistantAggregator {
    static buildRouteRows(input) {
        const hubIata             = String((input && input.hubIata) || "").toUpperCase()
        const ffRoutes            = (input && input.ffData && input.ffData.routes) || []
        const demandMap           = (input && input.demandMap) || new Map()
        const overrideMap         = (input && input.overrideMap) || null
        const yieldHistoryMap     = (input && input.yieldHistoryMap) || null
        const serviceConfigMap    = (input && input.serviceConfigMap) || null
        const routeNoteMap        = (input && input.routeNoteMap) || null
        const serviceProfilesDef  = (input && input.serviceProfiles) || null
        const fleet               = (input && input.fleet) || null
        const ownByDest           = RouteAssistantAggregator._collectOwnFreq(input && input.ownSchedule, hubIata)
        const afpByDest           = RouteAssistantAggregator._collectAfpFreq(input && input.afpSchedules, hubIata)
        // Per-pair max merge — either source can undercount (legacy is a
        // manual snapshot, AFP only covers aircraft the user has visited),
        // so taking the max of each freq flips `operating` correctly when
        // ANY source shows the route is flown. This is the fix for the
        // "every route shows NEW" symptom: AFP-only users had ownTotalFreq=0.
        for (const [dest, afp] of afpByDest) {
            const cur = ownByDest.get(dest) || {paxFreq: 0, cargoFreq: 0}
            cur.paxFreq   = Math.max(cur.paxFreq   || 0, afp.paxFreq   || 0)
            cur.cargoFreq = Math.max(cur.cargoFreq || 0, afp.cargoFreq || 0)
            ownByDest.set(dest, cur)
        }
        const fleetCtx            = (input && input.fleetContext) || null
        const interlineByPair     = (input && input.interlineByPair) || null
        const ffDemandContext     = (typeof FlightsFromStore !== "undefined"
            && typeof FlightsFromStore.buildDemandContext === "function")
                ? FlightsFromStore.buildDemandContext(ffRoutes)
                : null

        return ffRoutes.map(r => {
            const destIata = String(r.destIata || "").toUpperCase()
            const demand   = demandMap.get(destIata) || null
            const hasPaxDemand = demand && demand.paxScore !== null && demand.paxScore !== undefined
                && isFinite(Number(demand.paxScore))
            const ffDemand = (!hasPaxDemand && ffDemandContext
                    && typeof FlightsFromStore.demandForRoute === "function")
                ? FlightsFromStore.demandForRoute(r, ffDemandContext)
                : null
            const own      = ownByDest.get(destIata) || {paxFreq: 0, cargoFreq: 0}
            const totalFreq = (own.paxFreq || 0) + (own.cargoFreq || 0)
            const weeklyFlights = Number(r.weeklyFlights) || 0
            const paxScore = hasPaxDemand ? demand.paxScore : (ffDemand ? ffDemand.paxScore : null)
            const distanceKm = typeof r.distanceKm === "number" ? r.distanceKm : null
            const override = overrideMap ? (overrideMap.get(hubIata + "-" + destIata) || null) : null
            const routeNote = routeNoteMap ? (routeNoteMap.get(hubIata + "-" + destIata) || null) : null
            const interlineRec = interlineByPair
                ? RouteAssistantAggregator._lookupInterlineRecord(interlineByPair, hubIata, destIata)
                : null
            const interlineShares = RouteAssistantAggregator._interlineSharesFromRecord(interlineRec)

            const row = {
                destIata:      destIata,
                destName:      r.destName || null,
                airportId:     demand ? (demand.airportId || null) : null,
                distanceKm:    distanceKm,
                airlineCount:  Array.isArray(r.airlines) ? r.airlines.length : null,
                airlines:      Array.isArray(r.airlines) ? r.airlines.slice() : null,
                weeklyFlights: weeklyFlights || null,
                seatsPerWeek:  typeof r.seatsPerWeek === "number" ? r.seatsPerWeek : null,
                paxScore:      paxScore,
                cargoScore:    demand ? demand.cargoScore : (ffDemand ? ffDemand.cargoScore : null),
                demandSource:  hasPaxDemand ? "route-assistant" : (ffDemand ? ffDemand.demandSource : null),
                demandBasis:   hasPaxDemand ? null : (ffDemand ? ffDemand.demandBasis : null),
                ownPaxFreq:    own.paxFreq || 0,
                ownCargoFreq:  own.cargoFreq || 0,
                ownTotalFreq:  totalFreq,
                congestionIndex:  null,
                override:         override,
                routeNote:        routeNote,
                routeNoteText:    (routeNote && typeof routeNote.text === "string") ? routeNote.text : null,
                interlineShares:  interlineShares,
                aircraftFit:      null,
                blockHours:       null,
                profitPerFlight:  null,
                profitPerWeek:    null,
                fitOk:            null,
                aircraftTypeName: null,
                isCargoOnly:      false,
                profitBreakdown:  null,
                actualProfitPerFlight: null,
                actualProfitPerWeek:   null,
                actualFrequency:       null,
                actualSnapshotAt:      null,
                actualAircraftTypes:   null,
                actualContributingTails: null,
                actualTotalKnownTails:   null,
                actualSnapshots:       null,
                actualSnapshotMode:    null,
                actualVariancePct:     null,
                serviceConfig:         null,
                classMix:              null,
                classMixSource:        null,
                serviceLevel:          null,
                serviceLevelSource:    null,
                seatsByClass:          null,
                weeklySeatsByClass:    null,
                weeklySeatsTotal:      null,
                classBreakdown:        null
            }

            if (yieldHistoryMap) RouteAssistantAggregator._applyYieldHistory(row, yieldHistoryMap, hubIata)
            if (fleetCtx) RouteAssistantAggregator._applyFleetContext(row, fleetCtx, totalFreq)
            if (serviceProfilesDef) {
                const svcRec = serviceConfigMap
                    ? (serviceConfigMap.get(hubIata + "-" + destIata) || null)
                    : null
                RouteAssistantAggregator._applyServiceProjection(row, serviceProfilesDef, svcRec, fleet)
            }

            // Slice S1 — congestion signal for the strategy proposers.
            // Pure function, no IO; safe to call always.
            if (typeof window !== "undefined"
                    && window.AesStrategyCongestion
                    && typeof window.AesStrategyCongestion.computeCongestion === "function") {
                try {
                    const c = window.AesStrategyCongestion.computeCongestion(row, null)
                    row.congestionIndex = c && typeof c.congestionIndex === "number"
                        ? c.congestionIndex : null
                } catch (_) { /* leave null */ }
            }

            RouteAssistantAggregator._assignStatus(row, totalFreq, paxScore, weeklyFlights)
            return row
        })
    }

    /**
     * Re-applies fleet context to existing rows, mutating in place.
     *
     * Call this after `buildRouteRows` once distances are populated (cached
     * distance pass + the lazy enrichment loop). Fleet fit/profit depend on
     * row.distanceKm — re-running here picks up any distance updates that
     * happened after the rows were built.
     *
     * Pass `fleetCtx = null` to clear fleet-derived fields (e.g. when the
     * user switches Mode back to None).
     */
    static applyFleetContext(rows, fleetCtx, opts) {
        if (!rows) return
        const serviceProfilesDef = (opts && opts.serviceProfiles) || null
        const serviceConfigMap   = (opts && opts.serviceConfigMap) || null
        const fleet              = (opts && opts.fleet) || null
        const hubIata            = String((opts && opts.hubIata) || "").toUpperCase()
        for (const row of rows) {
            if (fleetCtx) {
                RouteAssistantAggregator._applyFleetContext(row, fleetCtx, row.ownTotalFreq || 0)
            } else {
                row.aircraftFit      = null
                row.blockHours       = null
                row.profitPerFlight  = null
                row.profitPerWeek    = null
                row.fitOk            = null
                row.aircraftTypeName = null
                row.isCargoOnly      = false
                row.profitBreakdown  = null
                row.actualVariancePct = null
            }
            // Service projection depends on the estimator's per-flight seats
            // + LF + yield, so re-run it whenever fleet context changes.
            if (serviceProfilesDef) {
                const svcRec = (serviceConfigMap && hubIata)
                    ? (serviceConfigMap.get(hubIata + "-" + row.destIata) || null)
                    : (row.serviceConfig || null)
                RouteAssistantAggregator._applyServiceProjection(row, serviceProfilesDef, svcRec, fleet)
            } else {
                RouteAssistantAggregator._clearServiceProjection(row)
            }
            RouteAssistantAggregator._assignStatus(
                row,
                row.ownTotalFreq || 0,
                row.paxScore,
                row.weeklyFlights || 0
            )
        }
    }

    /**
     * Re-projects service config (class mix + level + per-class fares) onto
     * every row. Used by the panel after the user saves a service-config
     * popover or tweaks the defaults — independent of distance/spec changes
     * (which would go through applyFleetContext).
     */
    static applyServiceProjection(rows, serviceProfilesDef, serviceConfigMap, hubIata, fleet) {
        if (!rows) return
        const hub = String(hubIata || "").toUpperCase()
        for (const row of rows) {
            if (!serviceProfilesDef) {
                RouteAssistantAggregator._clearServiceProjection(row)
                continue
            }
            const svcRec = (serviceConfigMap && hub)
                ? (serviceConfigMap.get(hub + "-" + row.destIata) || null)
                : null
            RouteAssistantAggregator._applyServiceProjection(row, serviceProfilesDef, svcRec, fleet)
        }
    }

    /**
     * Re-projects yield-history snapshots onto every row. Cheap and pure —
     * call after a fresh snapshot run so the actuals columns reflect the
     * latest data without having to rebuild rows from flightsfrom data.
     */
    static applyYieldHistory(rows, yieldHistoryMap, hubIata) {
        if (!rows) return
        const hub = String(hubIata || "").toUpperCase()
        for (const row of rows) {
            if (yieldHistoryMap) {
                RouteAssistantAggregator._applyYieldHistory(row, yieldHistoryMap, hub)
            } else {
                row.actualProfitPerFlight   = null
                row.actualProfitPerWeek     = null
                row.actualFrequency         = null
                row.actualSnapshotAt        = null
                row.actualAircraftTypes     = null
                row.actualContributingTails = null
                row.actualTotalKnownTails   = null
                row.actualSnapshots         = null
                row.actualSnapshotMode      = null
                row.actualVariancePct       = null
            }
            // Variance depends on both the latest snapshot AND the estimator.
            // Recompute now in case either side changed since the row was built.
            RouteAssistantAggregator._recomputeVariance(row)
        }
    }

    /**
     * Mutates `row` to add the aircraft-aware fields. Picks the chosen spec —
     * either the explicit selectedSpec (Type/Tail mode), or the most-economical
     * fleet aircraft when fleetSpecs is provided (Fleet mode).
     */
    static _applyFleetContext(row, fleetCtx, totalFreq) {
        let chosenSpec = fleetCtx.selectedSpec || null
        if (!chosenSpec && Array.isArray(fleetCtx.fleetSpecs) && fleetCtx.fleetSpecs.length) {
            const pick = RouteAssistantProfitEstimator.pickEconomical(
                fleetCtx.fleetSpecs, row.distanceKm, fleetCtx.falloffPct
            )
            if (pick) chosenSpec = pick.spec
        }
        if (!chosenSpec) return

        row.aircraftTypeName = chosenSpec.typeName || null

        const est = RouteAssistantProfitEstimator.estimate({
            distanceKm:        row.distanceKm,
            spec:              chosenSpec,
            frequency:         totalFreq,
            paxScore:          row.paxScore,
            cargoScore:        row.cargoScore,
            // Letter K — opt-in real-demand inputs. Estimator falls back
            // to the paxScore-interpolated LF when these are null OR
            // when `useRealDemandForLF` is false.
            paxDemandPool:     row.paxDemandPool   != null ? row.paxDemandPool   : null,
            cargoDemandPool:   row.cargoDemandPool != null ? row.cargoDemandPool : null,
            useRealDemandForLF: !!fleetCtx.useRealDemandForLF,
            economics:         fleetCtx.economics,
            falloffPct:        fleetCtx.falloffPct,
            // Q3 — pass null when the override has an `expiresAt` in the
            // past. The record stays in storage + on the row (so the UI
            // can render an expired-indicator), but the estimator falls
            // back to demand-driven LF / configured base yield.
            override:          (row.override
                                && (typeof RouteAssistantRouteOverridesStore !== "undefined")
                                && RouteAssistantRouteOverridesStore.isExpired(row.override))
                                   ? null
                                   : (row.override || null),
            useDistanceFuel:   !!fleetCtx.useDistanceFuel,
            fuelPriceASc:      fleetCtx.fuelPriceASc,
            fuelBurnOverrides: fleetCtx.fuelBurnOverrides,
            // H slice 3b.2 — per-route codeshare/interline share trims
            // effective LF after source attribution. The row carries the
            // pre-computed {paxPercent, cargoPercent} from buildRouteRows
            // so the estimator stays Map-free and the re-applier (which
            // doesn't have hubIata at hand) inherits the same shares.
            interlineShares:   row.interlineShares || null
        })

        row.aircraftFit     = est.specOk ? est.fit : null
        row.blockHours      = est.blockHours
        row.profitPerFlight = est.profitPerFlight
        row.profitPerWeek   = est.profitPerWeek
        row.isCargoOnly     = est.isCargoOnly
        row.fitOk           = est.specOk ? (est.fit === "oor" ? 0 : 1) : null
        row.profitBreakdown = est.breakdown || null
        RouteAssistantAggregator._recomputeVariance(row)
    }

    /**
     * Pull the latest snapshot for `<hub>-<row.destIata>` and project its
     * fields onto the row. Multi-snapshot history is exposed for the
     * sparkline; the latest snapshot drives the column values.
     */
    static _applyYieldHistory(row, yieldHistoryMap, hubIata) {
        if (!row || !row.destIata) return
        const key = String(hubIata || "").toUpperCase() + "-" + String(row.destIata).toUpperCase()
        const rec = yieldHistoryMap.get(key) || null
        if (!rec || !Array.isArray(rec.snapshots) || !rec.snapshots.length) {
            row.actualProfitPerFlight   = null
            row.actualProfitPerWeek     = null
            row.actualFrequency         = null
            row.actualSnapshotAt        = null
            row.actualAircraftTypes     = null
            row.actualContributingTails = null
            row.actualTotalKnownTails   = null
            row.actualSnapshots         = null
            row.actualSnapshotMode      = null
            return
        }
        const latest = rec.snapshots[rec.snapshots.length - 1]
        row.actualProfitPerFlight   = numOrNull(latest.profitPerFlight)
        row.actualProfitPerWeek     = numOrNull(latest.profitPerWeek)
        row.actualFrequency         = numOrNull(latest.frequency)
        row.actualSnapshotAt        = latest.timestamp || rec.lastSnapshotAt || null
        row.actualAircraftTypes     = Array.isArray(latest.aircraftTypeNames) ? latest.aircraftTypeNames.slice() : null
        row.actualContributingTails = latest.contributingTails || null
        row.actualTotalKnownTails   = latest.totalKnownTails   || null
        row.actualSnapshots         = rec.snapshots.slice()
        row.actualSnapshotMode      = latest.mode || "cumulative"
    }

    /**
     * Variance % between the estimator's $/flt and the snapshot's $/flt.
     * Positive = actual exceeds estimate; negative = actual below estimate.
     * Returns null when either side is missing or the estimate is zero.
     */
    static _recomputeVariance(row) {
        if (!row) return
        const est = numOrNull(row.profitPerFlight)
        const act = numOrNull(row.actualProfitPerFlight)
        if (est === null || act === null || est === 0) {
            row.actualVariancePct = null
            return
        }
        row.actualVariancePct = Math.round(((act - est) / Math.abs(est)) * 100)
    }

    /**
     * Project per-class seat counts, weekly seats offered, and a class-aware
     * revenue/cost breakdown onto the row. Reads the estimator's existing
     * profitBreakdown (so we get the same seats/LF/yield/distRT it used) and
     * splits it across Y/C/F using the per-route classMix (or the defaults).
     *
     * The existing single-bucket $/flt and $/wk columns stay untouched —
     * this projection is informational, surfaced in a new "Seats/wk" column
     * and the service-config popover.
     */
    static _applyServiceProjection(row, defaults, record, fleet) {
        if (!row || !defaults) return
        const breakdown = row.profitBreakdown || null
        const seatsTotal = breakdown ? Number(breakdown.seats) : 0
        if (!seatsTotal || seatsTotal <= 0) {
            RouteAssistantAggregator._clearServiceProjection(row)
            return
        }

        // Tail-derived class mix from the assigned aircraft's seat counts
        // (auto-detected from /app/fleets). Falls through to the default
        // mix when the tail isn't in the cached fleet OR all three buckets
        // are zero (e.g. unconfigured aircraft).
        const tailMix = RouteAssistantAggregator._tailMixFromFleet(row, fleet)

        const eff = (typeof RouteAssistantServiceConfigStore !== "undefined")
            ? RouteAssistantServiceConfigStore.resolveEffective(record, defaults, tailMix)
            : null
        if (!eff) {
            RouteAssistantAggregator._clearServiceProjection(row)
            return
        }

        // Per-flight seat allocation. Largest-remainder distribution so the
        // class counts add up exactly to the spec total — `Math.floor` alone
        // would lose 1-2 seats on rounded mixes.
        const rawSeats = {
            Y: seatsTotal * (eff.classMix.Y || 0),
            C: seatsTotal * (eff.classMix.C || 0),
            F: seatsTotal * (eff.classMix.F || 0)
        }
        const seatsByClass = RouteAssistantAggregator._largestRemainder(rawSeats, seatsTotal)

        // Weekly seats — multiply by the user's own weekly frequency on this
        // route (departures only). Reverse direction populates the inbound
        // row independently.
        const weeklyFreq = Number(row.ownTotalFreq) || 0
        const weeklySeatsByClass = {}
        let weeklyTotal = 0
        for (const cls of ["Y", "C", "F"]) {
            const w = seatsByClass[cls] * weeklyFreq
            weeklySeatsByClass[cls] = w
            weeklyTotal += w
        }

        // Class-aware revenue + cost (per round-trip flight). Uses the
        // estimator's effective LF/yield/falloff so it stays internally
        // consistent with the displayed $/flt, then redistributes across
        // classes via classYieldMult and per-class costs.
        //
        // H slice 3b.2 follow-up — when an interline record is present,
        // applying the estimator's flat post-interline LF to every class
        // under-models C + F revenue when the codeshare is class-asymmetric
        // (e.g. "30% Y interlined, no C interlined" loses 30% of C revenue
        // it shouldn't). We resolve per-class accuracy by reading the
        // pre-interline LF off the breakdown and re-applying the per-class
        // share from `row.interlineShares.byClass`. The aggregate $/flt
        // (which doesn't know the class split) still uses the flat
        // reduction — that's the right call there because the breakdown
        // for the aggregate is unobservable downstream.
        const baseYield = Number(breakdown.yieldPerKm) || 0
        const yDemand   = Number(breakdown.yieldDemandMultiplier) || 1
        const yMult     = Number(breakdown.yieldMultiplier) || 1
        const lfPostInterline = Number(breakdown.paxLoadFactor) || 0
        const lfPreInterline  = Number(breakdown.paxLoadFactorPreInterline)
        const lfPre = isFinite(lfPreInterline) ? lfPreInterline : lfPostInterline
        const interlineByClass = (row.interlineShares && row.interlineShares.byClass) || null
        const distRT    = Number(breakdown.distanceRoundTripKm) || 0
        const svcLevelMult = eff.serviceLevelYieldMult
        const svcLevelPerPaxCost = eff.serviceLevelCostPerPax

        // Markets-page scraped fare per class — when present we derive an
        // effective yield from `currentPrice / one-way distance` and prefer
        // it over the configured class-yield-multiplier fallback. Manual
        // route overrides still win.
        const distanceOneWay = (Number(row.distanceKm) > 0) ? Number(row.distanceKm)
                            : (distRT > 0 ? distRT / 2 : 0)
        const scrapedFares = row.ownPricing || null

        const classes = {}
        let totalRevenue = 0
        let totalCost = 0
        for (const cls of ["Y", "C", "F"]) {
            const f = eff.classFares[cls]
            const seatsCls = seatsByClass[cls]
            const clsInterlinePct = interlineByClass
                ? Math.max(0, Math.min(100, Number(interlineByClass[cls]) || 0))
                : 0
            // Per-class LF: pre-interline LF reduced by the class-specific
            // share. Falls back to lfPostInterline (the estimator's flat
            // figure) when no interline record is present, which preserves
            // the previous behavior bit-for-bit on routes with no
            // codeshare data.
            const lfCls = (interlineByClass && lfPre)
                ? lfPre * (1 - clsInterlinePct / 100)
                : lfPostInterline
            const filled = seatsCls * lfCls
            const scrapedFare = scrapedFares && scrapedFares[cls]
            const scrapedYield = (typeof scrapedFare === "number" && scrapedFare > 0 && distanceOneWay > 0)
                ? (scrapedFare / distanceOneWay)
                : null
            let yieldUsed, yieldSource
            if (f.yieldPerKmOverride != null) {
                yieldUsed   = f.yieldPerKmOverride
                yieldSource = "override"
            } else if (scrapedYield != null) {
                yieldUsed   = scrapedYield
                yieldSource = "scraped"
            } else {
                yieldUsed   = baseYield * (f.yieldMult || 1) * yDemand * svcLevelMult
                yieldSource = "default"
            }
            const revenue = filled * yieldUsed * distRT * yMult
            const perPaxCost = (f.costPerPaxOverride != null ? f.costPerPaxOverride : (f.costPerPax || 0))
                + svcLevelPerPaxCost
            const cost = filled * perPaxCost
            classes[cls] = {
                seats:           seatsCls,
                seatsFilled:     Math.round(filled * 10) / 10,
                loadFactor:      Math.round(lfCls * 1000) / 1000,
                interlinePercent: clsInterlinePct,
                yieldPerKm:      Math.round(yieldUsed * 10000) / 10000,
                yieldOverride:   f.yieldPerKmOverride !== null,
                yieldSource:     yieldSource,
                scrapedFare:     (typeof scrapedFare === "number") ? scrapedFare : null,
                costPerPax:      Math.round(perPaxCost * 100) / 100,
                costOverride:    f.costPerPaxOverride !== null,
                revenuePerFlight: Math.round(revenue),
                costPerFlight:    Math.round(cost),
                revenuePerWeek:  Math.round(revenue * weeklyFreq),
                costPerWeek:     Math.round(cost * weeklyFreq),
                weeklySeats:     weeklySeatsByClass[cls]
            }
            totalRevenue += revenue
            totalCost += cost
        }

        row.serviceConfig       = record || null
        row.classMix             = eff.classMix
        row.classMixSource       = eff.source.classMix
        row.serviceLevel         = eff.serviceLevel
        row.serviceLevelSource   = eff.source.serviceLevel
        row.seatsByClass         = seatsByClass
        row.weeklySeatsByClass   = weeklySeatsByClass
        row.weeklySeatsTotal     = weeklyTotal
        row.classBreakdown       = {
            classes:               classes,
            totalRevenuePerFlight: Math.round(totalRevenue),
            totalCostPerFlight:    Math.round(totalCost),
            totalRevenuePerWeek:   Math.round(totalRevenue * weeklyFreq),
            totalCostPerWeek:      Math.round(totalCost * weeklyFreq),
            serviceLevelYieldMult: svcLevelMult,
            serviceLevelPerPaxCost: svcLevelPerPaxCost
        }
    }

    static _clearServiceProjection(row) {
        if (!row) return
        row.serviceConfig       = null
        row.classMix            = null
        row.classMixSource      = null
        row.serviceLevel        = null
        row.serviceLevelSource  = null
        row.seatsByClass        = null
        row.weeklySeatsByClass  = null
        row.weeklySeatsTotal    = null
        row.classBreakdown      = null
    }

    /**
     * Largest-remainder allocator — distributes `total` across the keys of
     * `raws` so the result sums to exactly `total` while keeping each
     * bucket as close to its raw fraction as possible.
     */
    /**
     * Derive the {Y, C, F} class-mix from the assigned tail's seat counts
     * (`fleet.aircraft[].seatsY/seatsC/seatsF`, scraped by
     * content_fleetManagement.js). Looks up by aircraftId first, falls back
     * to registration. Returns null when no tail is assigned, the fleet
     * record is missing, or all three buckets are zero — caller treats
     * that as "no signal" and falls through to the default mix.
     */
    static _tailMixFromFleet(row, fleet) {
        if (!row || !fleet || !Array.isArray(fleet.aircraft)) return null
        const id  = row.liveAircraftId
        const reg = row.liveAircraftReg
        if (!id && !reg) return null
        let tail = null
        if (id) tail = fleet.aircraft.find(a => a && Number(a.aircraftId) === Number(id))
        if (!tail && reg) tail = fleet.aircraft.find(a => a && a.registration === reg)
        if (!tail) return null
        const y = Number(tail.seatsY) || 0
        const c = Number(tail.seatsC) || 0
        const f = Number(tail.seatsF) || 0
        const total = y + c + f
        if (total <= 0) return null
        return {Y: y / total, C: c / total, F: f / total}
    }

    /**
     * H slice 3b.2 — fold the interline-store partner list into the
     * shape the profit estimator + service-projection expect.
     *
     * Two views are surfaced together because they serve different math:
     *   - `paxPercent` / `cargoPercent` — aggregate sums for the estimator,
     *     which computes a single $/flt against an aggregate LF. PAX/Y/C/F
     *     all reduce paxPercent; CARGO reduces cargoPercent.
     *   - `byClass` — per-class shares for the service-projection, which
     *     needs an accurate Y vs C vs F revenue split. A "PAX" partner is
     *     the umbrella code that applies to all three pax classes equally;
     *     specific Y/C/F partners only affect their class. This matters
     *     when interline is class-asymmetric (e.g. 30% Y interlined, no C
     *     interlined): the aggregate paxPercent under-models C + F revenue
     *     because the LF reduction is uniform across all classes; byClass
     *     restores precision in the service-projection layer.
     *
     * Returns null when the record is empty/missing so callers can skip
     * cheaply with truthy checks.
     */
    static _interlineSharesFromRecord(record) {
        if (!record || !Array.isArray(record.partners) || !record.partners.length) return null
        let pax = 0
        let cargo = 0
        let umbrellaPax = 0  // PAX = applies to Y, C, F equally
        const cls = {Y: 0, C: 0, F: 0}
        for (const p of record.partners) {
            const v = Number(p && p.sharePercent) || 0
            if (v <= 0) continue
            const k = p.productClass
            if (k === "CARGO") {
                cargo += v
                continue
            }
            pax += v
            if (k === "PAX") umbrellaPax += v
            else if (k === "Y" || k === "C" || k === "F") cls[k] += v
        }
        if (pax <= 0 && cargo <= 0) return null
        // Distribute the umbrella across each pax class — caps at 100 so an
        // over-allocation in the popover doesn't escape into negative seats.
        return {
            paxPercent:   Math.min(100, pax),
            cargoPercent: Math.min(100, cargo),
            byClass: {
                Y: Math.min(100, cls.Y + umbrellaPax),
                C: Math.min(100, cls.C + umbrellaPax),
                F: Math.min(100, cls.F + umbrellaPax)
            }
        }
    }

    /**
     * Look up an interline record from a Map<"HUB-DEST", record> or a
     * plain object keyed the same way (the bulkLoad return shape).
     */
    static _lookupInterlineRecord(interlineByPair, hubIata, destIata) {
        if (!interlineByPair) return null
        const key = String(hubIata || "").toUpperCase() + "-" + String(destIata || "").toUpperCase()
        if (typeof interlineByPair.get === "function") return interlineByPair.get(key) || null
        return interlineByPair[key] || null
    }

    static _largestRemainder(raws, total) {
        const keys = Object.keys(raws)
        const out = {}
        let used = 0
        const rems = []
        for (const k of keys) {
            const f = Math.floor(raws[k])
            out[k] = f
            used += f
            rems.push({k: k, r: raws[k] - f})
        }
        rems.sort((a, b) => b.r - a.r)
        let leftover = Math.max(0, total - used)
        for (const item of rems) {
            if (leftover <= 0) break
            out[item.k] += 1
            leftover -= 1
        }
        return out
    }

    /**
     * Returns Map<destIata, {paxFreq, cargoFreq}> for flights that depart
     * from `hubIata` in the most recent date entry of the saved schedule.
     */
    static _collectOwnFreq(scheduleRecord, hubIata) {
        const out = new Map()
        if (!scheduleRecord || !scheduleRecord.date) return out
        const dates = Object.keys(scheduleRecord.date).sort()
        if (!dates.length) return out
        const latest = scheduleRecord.date[dates[dates.length - 1]]
        if (!latest || !Array.isArray(latest.schedule)) return out

        for (const route of latest.schedule) {
            if (!route || !route.origin || !route.destination) continue
            if (String(route.origin).toUpperCase() !== hubIata) continue
            const dest = String(route.destination).toUpperCase()
            const acc  = out.get(dest) || {paxFreq: 0, cargoFreq: 0}
            for (const fnKey in (route.flightNumber || {})) {
                const fn = route.flightNumber[fnKey]
                if (!fn) continue
                acc.paxFreq   += Number(fn.paxFreq)   || 0
                acc.cargoFreq += Number(fn.cargoFreq) || 0
            }
            out.set(dest, acc)
        }
        return out
    }

    /**
     * Per-destination weekly frequency aggregated from per-aircraft AFP
     * schedule records (the modern source written live whenever the user
     * visits an AFP page). `afpSchedules` is an array of records loaded
     * from `aircraftFlightPlan:schedule:<server>:<aircraftId>` — each
     * carries a `legs[]` array. We only count legs whose `origin` matches
     * the current hub (an aircraft based at hub X but flying through hub Y
     * still has Y→Z legs that count for hub Y).
     *
     * AFP records carry no pax/cargo distinction per leg, so every leg
     * counts as paxFreq. Downstream code that reads `ownTotalFreq` is
     * correct either way; the rare consumer that needs a pax/cargo split
     * gets pax-only from AFP and the legacy schedule's split when it's
     * also present (max merge in `buildRouteRows`).
     */
    static _collectAfpFreq(afpSchedules, hubIata) {
        const out = new Map()
        if (!Array.isArray(afpSchedules) || !afpSchedules.length || !hubIata) return out
        for (const rec of afpSchedules) {
            if (!rec || !Array.isArray(rec.legs)) continue
            for (const leg of rec.legs) {
                if (!leg || !leg.origin || !leg.destination) continue
                if (String(leg.origin).toUpperCase() !== hubIata) continue
                const dest = String(leg.destination).toUpperCase()
                const acc  = out.get(dest) || {paxFreq: 0, cargoFreq: 0}
                acc.paxFreq += 1
                out.set(dest, acc)
            }
        }
        return out
    }

    /**
     * Health flag — orthogonal to operating. Computed for every route, flown
     * or not, so the user can see UNDER/OVER/OK/OOR independently from "do I
     * fly this":
     *   OOR   — selected aircraft can't reach the destination (overrides
     *           everything else; must fix fleet/aircraft choice first)
     *   UNDER — demand is high (paxScore ≥ 8) and your weekly freq is < 1/10
     *           of real-world. For an unflown route (ownTotalFreq = 0) this
     *           collapses to "high demand and you're not flying it" — i.e. a
     *           candidate to start.
     *   OVER  — you fly it more than 1/5 of real-world. Unflown routes can
     *           never be OVER (0 is not > anything).
     *   OK    — anything else.
     * weeklyFlights = 0 means "no real-world reference", so we fall back to OK.
     */
    static _healthFor(ownTotalFreq, paxScore, weeklyFlights, aircraftFit) {
        if (aircraftFit === "oor") return "OOR"
        if (!weeklyFlights) return "OK"
        if (typeof paxScore === "number" && paxScore >= 8 && ownTotalFreq < weeklyFlights / 10) return "UNDER"
        if (ownTotalFreq > weeklyFlights / 5) return "OVER"
        return "OK"
    }

    /**
     * Sets the three correlated fields on `row`:
     *   operating — boolean (true iff ownTotalFreq > 0)
     *   health    — OK / UNDER / OVER / OOR (always)
     *   status    — operating ? health : "NEW"  (legacy combined value)
     */
    static _assignStatus(row, ownTotalFreq, paxScore, weeklyFlights) {
        const operating = (ownTotalFreq || 0) > 0
        const health    = RouteAssistantAggregator._healthFor(
            ownTotalFreq || 0, paxScore, weeklyFlights || 0, row.aircraftFit
        )
        row.operating = operating
        row.health    = health
        row.status    = operating ? health : "NEW"
    }
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}
