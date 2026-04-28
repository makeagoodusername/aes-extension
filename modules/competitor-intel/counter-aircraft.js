"use strict"

/**
 * Counter-aircraft recommender.
 *
 * For one (route, competitor's setup) pair, score every plausible aircraft
 * we could put on the lane and recommend the best — preferring tails we
 * already own when they win, falling back to a purchase suggestion when
 * none of our existing tails can.
 *
 * Apples-to-apples comparison: every candidate is run through
 * `RouteAssistantProfitEstimator.estimate` with the same yieldPerKm
 * override (derived from the competitor's observed price) and the same
 * frequency. That way the only thing varying between candidates is the
 * aircraft spec — exactly the variable we want to optimise over.
 *
 * Verdicts:
 *   we-already-win — we currently fly the lane and out-earn them.
 *   tail-available — we don't fly it (or we do but trail), and at least
 *                    one tail in our fleet would out-earn them if assigned.
 *   buy-needed     — no tail wins, but a purchaseable type would.
 *   uncontested    — nobody else flies the lane and we don't either —
 *                    open opportunity.
 *   out-of-range   — nothing in the catalog fits the distance.
 *   no-data        — competitor's spec not resolvable, can't compare.
 */
class AesCounterAircraft {
    /**
     * @param {object} input
     * @param {number} input.distanceKm
     * @param {string} input.hub
     * @param {string} input.dest
     * @param {object} [input.theirSpec]            competitor's aircraft spec
     * @param {number} [input.theirEstProfit]       competitor's projected weekly profit
     * @param {number} [input.theirSeats]           competitor's per-flight seats
     * @param {number} [input.theirPrice]           competitor's observed price
     * @param {number} [input.theirFreq]            competitor's weekly flights
     * @param {number} [input.sharePct]             competitor's market share %
     * @param {Array<object>} input.ourFleetEnriched FleetHubAircraftAggregator rows
     * @param {Map<string, object>} input.specsByTypeId
     * @param {object} input.economics
     * @param {boolean} [input.oursHasFlights]      we already operate this lane
     * @param {number}  [input.oursEstProfit]       our current projected weekly profit
     */
    static recommend(input) {
        if (!input || !input.distanceKm || input.distanceKm <= 0) {
            return {verdict: "no-data"}
        }
        const distanceKm = Number(input.distanceKm)
        const economics = input.economics || {}

        // Frequency to score against — match the competitor when known,
        // otherwise pick a sensible default (daily round-trips).
        const targetFreq = isFinite(input.theirFreq) && input.theirFreq > 0
            ? Math.max(3, Math.min(28, input.theirFreq))
            : 7

        // Yield to score against — derive from observed price so all
        // candidates compare on the same revenue plane. Without theirPrice,
        // fall back to economics.yieldPerKm.
        const yieldPerKm = input.theirPrice && distanceKm > 0
            ? input.theirPrice / distanceKm
            : null

        // Edge case: competitor doesn't operate the lane at all.
        if (!input.theirFreq || input.theirFreq <= 0) {
            // Score the lane on its own merits — uncontested if both we
            // and they sit it out.
            if (!input.oursHasFlights) {
                return {verdict: "uncontested"}
            }
            // We're alone on the lane already — a counter-aircraft pass
            // doesn't apply.
            return {verdict: "we-already-win"}
        }

        // Existing-tail pass.
        const existingResults = AesCounterAircraft._scoreExistingTails({
            distanceKm:    distanceKm,
            targetFreq:    targetFreq,
            yieldPerKm:    yieldPerKm,
            ourFleet:      input.ourFleetEnriched || [],
            specsByTypeId: input.specsByTypeId,
            economics:     economics,
            hub:           input.hub
        })

        const theirEstProfit = isFinite(input.theirEstProfit) ? input.theirEstProfit : null

        const beatsTheirs = (profit) =>
            theirEstProfit === null || (isFinite(profit) && profit > theirEstProfit)

        // We already lead on the lane?
        if (input.oursHasFlights && isFinite(input.oursEstProfit)
            && (theirEstProfit === null || input.oursEstProfit > theirEstProfit)) {
            // Even when we lead, surface the best alternative tail so the
            // user has a "stretch" upgrade path documented.
            const top = existingResults[0] || null
            return {
                verdict:          "we-already-win",
                ourEstProfit:     input.oursEstProfit,
                theirEstProfit:   theirEstProfit,
                deltaVsThem:      isFinite(theirEstProfit) ? input.oursEstProfit - theirEstProfit : null,
                bestExistingTail: top
                    ? AesCounterAircraft._formatTail(top, theirEstProfit)
                    : null
            }
        }

        // Find the best winning tail.
        const winningTail = existingResults.find(r =>
            beatsTheirs(r.projectedProfitPerWeek))
        if (winningTail) {
            return {
                verdict:          "tail-available",
                bestExistingTail: AesCounterAircraft._formatTail(winningTail, theirEstProfit),
                theirEstProfit:   theirEstProfit
            }
        }

        // Purchase pass — search the type catalog (specsByTypeId carries
        // every typeId we've seen on the user's competitive landscape, so
        // it's a usable approximation of "buyable game types").
        const purchaseResult = AesCounterAircraft._scorePurchaseTypes({
            distanceKm:    distanceKm,
            targetFreq:    targetFreq,
            yieldPerKm:    yieldPerKm,
            specsByTypeId: input.specsByTypeId,
            economics:     economics,
            theirSpec:     input.theirSpec
        })
        if (purchaseResult && beatsTheirs(purchaseResult.projectedProfitPerWeek)) {
            return {
                verdict:           "buy-needed",
                bestPurchaseType:  AesCounterAircraft._formatPurchase(purchaseResult, theirEstProfit, input.theirSpec),
                theirEstProfit:    theirEstProfit,
                bestExistingTail:  existingResults[0]
                    ? AesCounterAircraft._formatTail(existingResults[0], theirEstProfit)
                    : null
            }
        }

        // Best-effort top-of-list — even if nothing strictly beats them,
        // surface the closest candidates so the user can judge the gap.
        if (existingResults.length) {
            return {
                verdict:           "tail-available",
                bestExistingTail:  AesCounterAircraft._formatTail(existingResults[0], theirEstProfit),
                theirEstProfit:    theirEstProfit,
                weakBeat:          true
            }
        }
        if (purchaseResult) {
            return {
                verdict:           "buy-needed",
                bestPurchaseType:  AesCounterAircraft._formatPurchase(purchaseResult, theirEstProfit, input.theirSpec),
                theirEstProfit:    theirEstProfit,
                weakBeat:          true
            }
        }
        return {verdict: "out-of-range", theirEstProfit: theirEstProfit}
    }

    static _scoreExistingTails(input) {
        if (typeof RouteAssistantProfitEstimator === "undefined") return []
        const out = []
        const seenTypes = new Set()
        for (const tail of input.ourFleet) {
            if (!tail || !tail.typeId) continue
            const spec = input.specsByTypeId.get(String(tail.typeId))
            if (!spec) continue
            // Range fit gate.
            if (!isFinite(spec.range) || spec.range * 0.95 < input.distanceKm) continue
            const override = input.yieldPerKm !== null ? {yieldPerKm: input.yieldPerKm} : null
            const r = RouteAssistantProfitEstimator.estimate({
                distanceKm: input.distanceKm,
                spec:       spec,
                frequency:  input.targetFreq,
                paxScore:   5,
                economics:  input.economics,
                override:   override
            })
            if (!r || r.profitPerWeek == null) continue
            // Penalize tails not at the route hub (repositioning cost).
            // Light penalty: 5% off projected profit per week if hub mismatch.
            let projected = r.profitPerWeek
            const hubMismatch = tail.hub && input.hub && tail.hub !== input.hub
            if (hubMismatch) projected = Math.round(projected * 0.95)
            // Prefer tails not currently on a draft plan.
            const idle = !tail.hasDraftedPlan
            seenTypes.add(String(tail.typeId))
            out.push({
                aircraftId:          tail.aircraftId,
                registration:        tail.registration,
                typeId:              tail.typeId,
                typeCode:            tail.equipment || (spec && spec.code) || null,
                hub:                 tail.hub,
                idle:                idle,
                hubMismatch:         hubMismatch,
                projectedProfitPerWeek: projected,
                fit:                 r.fit,
                spec:                spec
            })
        }
        // Sort: idle first, then by projected profit desc.
        out.sort((a, b) => {
            if (a.idle !== b.idle) return a.idle ? -1 : 1
            return (b.projectedProfitPerWeek || 0) - (a.projectedProfitPerWeek || 0)
        })
        return out
    }

    static _scorePurchaseTypes(input) {
        if (typeof RouteAssistantProfitEstimator === "undefined") return null
        const map = input.specsByTypeId
        if (!map || typeof map.forEach !== "function") return null
        let best = null
        map.forEach((spec, typeId) => {
            if (!spec || !isFinite(spec.range)) return
            if (spec.range * 0.95 < input.distanceKm) return
            const override = input.yieldPerKm !== null ? {yieldPerKm: input.yieldPerKm} : null
            const r = RouteAssistantProfitEstimator.estimate({
                distanceKm: input.distanceKm,
                spec:       spec,
                frequency:  input.targetFreq,
                paxScore:   5,
                economics:  input.economics,
                override:   override
            })
            if (!r || r.profitPerWeek == null) return
            const candidate = {
                typeId:                 String(typeId),
                typeCode:               spec.typeCode || spec.code || null,
                projectedProfitPerWeek: r.profitPerWeek,
                fit:                    r.fit,
                spec:                   spec
            }
            if (!best || candidate.projectedProfitPerWeek > best.projectedProfitPerWeek) {
                best = candidate
            }
        })
        return best
    }

    static _formatTail(tail, theirEstProfit) {
        if (!tail) return null
        const delta = isFinite(theirEstProfit) && isFinite(tail.projectedProfitPerWeek)
            ? tail.projectedProfitPerWeek - theirEstProfit
            : null
        return {
            aircraftId:             tail.aircraftId,
            registration:           tail.registration,
            typeCode:               tail.typeCode,
            typeId:                 tail.typeId,
            hub:                    tail.hub,
            idle:                   tail.idle,
            hubMismatch:            tail.hubMismatch,
            projectedProfitPerWeek: tail.projectedProfitPerWeek,
            deltaVsThem:            delta,
            fit:                    tail.fit
        }
    }

    static _formatPurchase(c, theirEstProfit, theirSpec) {
        if (!c) return null
        const delta = isFinite(theirEstProfit) && isFinite(c.projectedProfitPerWeek)
            ? c.projectedProfitPerWeek - theirEstProfit
            : null
        let reason = null
        if (theirSpec && c.spec) {
            if (isFinite(theirSpec.range) && isFinite(c.spec.range)
                && c.spec.range > theirSpec.range * 1.10) reason = "longer range"
            else if (isFinite(theirSpec.seats) && isFinite(c.spec.seats)
                && Math.abs(c.spec.seats - theirSpec.seats) >= 30) {
                reason = c.spec.seats > theirSpec.seats ? "more seats per flight" : "leaner seat fit"
            } else if (isFinite(theirSpec.speed) && isFinite(c.spec.speed)
                && c.spec.speed > theirSpec.speed * 1.05) reason = "faster turn"
            else reason = "lower trip cost"
        }
        return {
            typeId:                 c.typeId,
            typeCode:               c.typeCode,
            projectedProfitPerWeek: c.projectedProfitPerWeek,
            deltaVsThem:            delta,
            fit:                    c.fit,
            reason:                 reason
        }
    }
}

if (typeof window !== "undefined") {
    window.AesCounterAircraft = AesCounterAircraft
}
