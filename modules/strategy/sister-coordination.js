"use strict"

/**
 * AES Strategy — sister coordination proposers (Slice 11).
 *
 * Three advisory proposers that reason about the whole portfolio of
 * owned airlines on one server, not just the active airline:
 *
 *   1. proposeLeaseBetweenSisters(server, opts)
 *      — when sister A has an idle tail whose type fits sister B's
 *        undersupplied hub→dest pair, emit a "lease A's <reg> to B"
 *        suggestion. Uses the existing Slice-1 scanForServer hint as
 *        the source so we don't duplicate scoring.
 *
 *   2. proposeHubAssignment(server, opts)
 *      — for hubs both sisters base aircraft at, recommend a
 *        specialisation split (sister A → long-haul, sister B →
 *        short-haul) when their fleet mixes already lean that way.
 *        Reduces inadvertent overlap on the same routes.
 *
 *   3. proposeJointPricing(server, opts)
 *      — for routes BOTH sisters fly today, recommend both stop
 *        underpricing each other and converge on a competitor-aware
 *        common price. The advisory carries each sister's current
 *        own-pricing alongside the suggested shared target.
 *
 * v1 stays advisory: no new actuators. The user routes through:
 *   - Fleet Command (lease/swap)
 *   - Hub assignment (manual)
 *   - Inventory pricing per sister (existing applier path)
 *
 * Settings consulted (`settings.strategy`):
 *   crossAirlineEnabled  (default false — gate; nothing emits when off)
 *   coordinatedHubs      (default []   — opt-in declaration of which
 *                          hubs each sister "owns"; entries shape:
 *                          ["accountId:HUB"], e.g. ["abc-123:FRA"])
 *   sisterCoordination:
 *     joint pricing:
 *       maxPriceSpreadPct        — recommend convergence when sisters
 *                                   are >N pct apart (default 8)
 *     hub assignment:
 *       widebodyFractionThreshold — sister leans long-haul when ≥X%
 *                                   widebody (default 0.55)
 *     lease:
 *       reuse cross-airline-opportunities scoring; expose `minScore`
 *       (default 0.20) to filter weak hints out.
 *
 * Public API (window.AesStrategySisterCoordination):
 *   proposeLeaseBetweenSisters(server, opts?) → Promise<Decision[]>
 *   proposeHubAssignment(server, opts?)        → Promise<Decision[]>
 *   proposeJointPricing(server, opts?)         → Promise<Decision[]>
 *   proposeAll(server, opts?)                  → Promise<Decision[]>
 *
 * Decision shape (matches diff-plan's existing extension domains):
 *   {
 *     id:             "sister:<kind>:<hubOrRoute>:<acctA?>:<acctB?>",
 *     domain:         "sister",
 *     kind:           "lease" | "hub-assignment" | "joint-pricing",
 *     title:          string,
 *     subtitle:       string,
 *     rationale:      string[],
 *     payload:        <kind-specific>,
 *     applicable:     false,
 *     applicableNote: "advisory only (Slice 11 v1 — no actuator)"
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategySisterCoordination) return

    const DEFAULTS = {
        maxPriceSpreadPct:        8,
        widebodyFractionThreshold: 0.55,
        regionalFractionThreshold: 0.45,
        leaseMinScore:             0.20,
        topNPerKind:               5
    }

    const ADVISORY_NOTE = "advisory only (Slice 11 v1 — no actuator)"

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    async function _enabled() {
        if (!window.AesStrategySettings || typeof window.AesStrategySettings.load !== "function") {
            return false
        }
        try {
            const s = await window.AesStrategySettings.load()
            return !!(s && s.crossAirlineEnabled)
        } catch (_) { return false }
    }

    async function _loadCoordinatedHubs() {
        if (!window.AesStrategySettings || typeof window.AesStrategySettings.load !== "function") {
            return []
        }
        try {
            const s = await window.AesStrategySettings.load()
            const list = (s && s.coordinatedHubs)
            return Array.isArray(list) ? list.slice() : []
        } catch (_) { return [] }
    }

    async function _loadPortfolio(server) {
        if (!window.AesStrategyPortfolio || typeof window.AesStrategyPortfolio.scanServer !== "function") {
            return null
        }
        try { return await window.AesStrategyPortfolio.scanServer(server) }
        catch (_) { return null }
    }

    /**
     * Proposer 1 — lease between sisters. Wraps the existing Slice-1
     * scanForServer hint into Decision envelopes filtered by minScore.
     */
    async function proposeLeaseBetweenSisters(server, opts) {
        if (!await _enabled()) return []
        const o = Object.assign({}, DEFAULTS, opts || {})
        if (!server) return []
        if (!window.AesCrossAirlineOpportunities
                || typeof window.AesCrossAirlineOpportunities.scanForServer !== "function") {
            return []
        }
        let matches
        try { matches = await window.AesCrossAirlineOpportunities.scanForServer(server, o) }
        catch (_) { return [] }
        if (!Array.isArray(matches) || !matches.length) return []
        const filtered = matches.filter(m => _num(m && m.score, 0) >= o.leaseMinScore)
        const top = filtered.slice(0, o.topNPerKind)
        return top.map(m => ({
            id:    "sister:lease:"
                   + (m.sourceAccountId || "?") + ":"
                   + (m.shortageAccountId || "?") + ":"
                   + (m.aircraftId || "?") + ":"
                   + (m.hub || "?") + "-" + (m.dest || "?"),
            domain:    "sister",
            kind:      "lease",
            title:     "Lease " + (m.equipment || m.typeCode || "tail")
                       + " · " + (m.sourceAirline || "sister")
                       + " → " + (m.shortageAirline || "sister"),
            subtitle:  "(" + (m.hub || "?") + " → " + (m.dest || "?")
                       + ") · score " + _num(m.score, 0).toFixed(2),
            rationale: [
                "[lease] " + (m.sourceAirline || "?") + " has "
                    + (m.equipment || "tail") + (m.aircraftId ? " #" + m.aircraftId : ""),
                "[demand] " + (m.shortageAirline || "?") + " short on "
                    + (m.hub || "?") + "→" + (m.dest || "?")
                    + (m.paxScore != null ? " (paxScore " + m.paxScore + ")" : ""),
                "[score] " + _num(m.score, 0).toFixed(2)
                    + " · seatFit " + _num(m.seatFit, 0).toFixed(2)
                    + " · headroomFrac " + _num(m.headroomFrac, 0).toFixed(2)
            ],
            payload: m,
            applicable:     false,
            applicableNote: ADVISORY_NOTE
        }))
    }

    /**
     * Compute a sister's fleet-mix bias from its hub aircraft. Returns
     *   {hub, accountId, airline, totals: {regional, narrow, wide, heavy},
     *    widebodyFrac, regionalFrac}
     * The classifier uses `_classifyAircraft` if AesCanopyRoleDetector is
     * loaded; falls back to a coarse seat-bucket heuristic otherwise.
     */
    function _classifySister(sister, hub) {
        const totals = {regional: 0, narrow: 0, wide: 0, heavy: 0, total: 0}
        const aircraft = (sister && sister.aircraft) || []
        for (const a of aircraft) {
            if (!a) continue
            if (a.currentLocationIata && hub
                    && String(a.currentLocationIata).toUpperCase() !== String(hub).toUpperCase()) continue
            let bucket = null
            const seats = _num(a.seats, _num(a.seatCount, NaN))
            if (window.AesCanopyRoleDetector
                    && typeof window.AesCanopyRoleDetector._isWideBody === "function") {
                if (window.AesCanopyRoleDetector._isWideBody(a)) bucket = "wide"
                else if (window.AesCanopyRoleDetector._isRegional
                         && window.AesCanopyRoleDetector._isRegional(a)) bucket = "regional"
            }
            if (!bucket && isFinite(seats)) {
                if (seats < 100) bucket = "regional"
                else if (seats < 200) bucket = "narrow"
                else if (seats < 350) bucket = "wide"
                else bucket = "heavy"
            }
            if (!bucket) continue
            totals[bucket]++
            totals.total++
        }
        return {
            totals:        totals,
            widebodyFrac:  totals.total ? (totals.wide + totals.heavy) / totals.total : 0,
            regionalFrac:  totals.total ? totals.regional / totals.total : 0
        }
    }

    /**
     * Proposer 2 — hub assignment specialization. For each overlap hub
     * (both sisters base tails there), if one sister's fleet mix is
     * already long-haul-leaning (≥ widebodyFractionThreshold widebody)
     * and the other regional-leaning, suggest the split formally.
     */
    async function proposeHubAssignment(server, opts) {
        if (!await _enabled()) return []
        const o = Object.assign({}, DEFAULTS, opts || {})
        if (!server) return []
        const portfolio = await _loadPortfolio(server)
        if (!portfolio || !Array.isArray(portfolio.airlines)) return []
        const overlapHubs = portfolio.overlapHubs || []
        if (!overlapHubs.length) return []
        const out = []
        for (const oh of overlapHubs) {
            if (!oh || !oh.iata || !Array.isArray(oh.airlines) || oh.airlines.length < 2) continue
            const profiles = oh.airlines.map(name => {
                const sister = portfolio.airlines.find(a => a && a.airline === name) || null
                if (!sister) return null
                let aircraftDetails = []
                if (window.AesFleetRoster && typeof window.AesFleetRoster.load === "function") {
                    // best-effort sync read via cached roster shape on portfolio.airlines
                    aircraftDetails = sister.aircraft || []
                }
                const classification = _classifySister({aircraft: aircraftDetails}, oh.iata)
                return Object.assign({sister: sister}, classification)
            }).filter(Boolean)
            if (profiles.length < 2) continue
            profiles.sort((a, b) => b.widebodyFrac - a.widebodyFrac)
            const longH = profiles[0]
            const shortH = profiles[profiles.length - 1]
            if (!longH || !shortH || longH === shortH) continue
            if (longH.widebodyFrac < o.widebodyFractionThreshold) continue
            if (shortH.regionalFrac < o.regionalFractionThreshold) continue
            out.push({
                id:    "sister:hub-assignment:" + oh.iata + ":"
                       + (longH.sister.accountId || longH.sister.airline) + ":"
                       + (shortH.sister.accountId || shortH.sister.airline),
                domain:    "sister",
                kind:      "hub-assignment",
                title:     oh.iata + " · " + longH.sister.airline
                           + " → long-haul, " + shortH.sister.airline + " → regional",
                subtitle:  "fleet mix already leans this way — formalise the split",
                rationale: [
                    "[hub] " + oh.iata + " is shared by " + oh.airlines.length + " sisters",
                    "[long] " + longH.sister.airline
                        + " · " + Math.round(longH.widebodyFrac * 100) + "% widebody"
                        + " · " + (longH.totals.wide + longH.totals.heavy) + " heavy tails",
                    "[short] " + shortH.sister.airline
                        + " · " + Math.round(shortH.regionalFrac * 100) + "% regional"
                        + " · " + shortH.totals.regional + " regional tails"
                ],
                payload: {
                    hub: oh.iata,
                    longHaulAirline:  longH.sister.airline,
                    longHaulProfile:  longH.totals,
                    regionalAirline:  shortH.sister.airline,
                    regionalProfile:  shortH.totals
                },
                applicable:     false,
                applicableNote: ADVISORY_NOTE
            })
        }
        return out.slice(0, o.topNPerKind)
    }

    /**
     * Proposer 3 — joint pricing. For each route both sisters fly,
     * if their own-prices diverge by more than maxPriceSpreadPct on
     * the Y-class, recommend converging on a shared price (the
     * higher of the two — protects margin; matches "undercut competitors,
     * not each other"). Reads each sister's `routeAssistant:markets:ownPricing:<HUB>-<DEST>`.
     */
    async function proposeJointPricing(server, opts) {
        if (!await _enabled()) return []
        const o = Object.assign({}, DEFAULTS, opts || {})
        if (!server) return []
        const portfolio = await _loadPortfolio(server)
        if (!portfolio || !Array.isArray(portfolio.overlapRoutes) || !portfolio.overlapRoutes.length) {
            return []
        }
        const out = []
        for (const ov of portfolio.overlapRoutes) {
            if (!ov || !ov.route || !Array.isArray(ov.airlines) || ov.airlines.length < 2) continue
            const [hub, dest] = ov.route.split("-")
            if (!hub || !dest) continue
            const prices = []
            for (const airline of ov.airlines) {
                const sister = portfolio.airlines.find(a => a && a.airline === airline) || null
                if (!sister || !sister.accountId) continue
                let key = "routeAssistant:markets:ownPricing:" + hub + "-" + dest
                if (window.acctKey && typeof window.acctKey === "function") {
                    try {
                        const scoped = window.acctKey("routeAssistant:markets:ownPricing", hub + "-" + dest, sister.accountId)
                        if (scoped) key = scoped
                    } catch (_) { /* fall through to bare key */ }
                }
                let rec = null
                try {
                    const got = await chrome.storage.local.get([key])
                    rec = got[key]
                } catch (_) { /* skip */ }
                const yPrice = rec && rec.prices && _num(rec.prices.Y, NaN)
                if (isFinite(yPrice) && yPrice > 0) {
                    prices.push({airline: airline, accountId: sister.accountId, yPrice: yPrice})
                }
            }
            if (prices.length < 2) continue
            prices.sort((a, b) => a.yPrice - b.yPrice)
            const lo = prices[0]
            const hi = prices[prices.length - 1]
            if (lo.yPrice <= 0 || hi.yPrice <= 0) continue
            const spreadPct = ((hi.yPrice - lo.yPrice) / lo.yPrice) * 100
            if (spreadPct < o.maxPriceSpreadPct) continue
            out.push({
                id:    "sister:joint-pricing:" + ov.route + ":"
                       + (lo.accountId || lo.airline) + ":"
                       + (hi.accountId || hi.airline),
                domain:    "sister",
                kind:      "joint-pricing",
                title:     ov.route + " · converge sister Y price",
                subtitle:  "spread " + Math.round(spreadPct) + "% across " + ov.airlines.length + " sisters",
                rationale: [
                    "[route] " + ov.route + " flown by " + ov.airlines.length + " sisters",
                    "[low] " + lo.airline + " · Y " + Math.round(lo.yPrice) + "%",
                    "[high] " + hi.airline + " · Y " + Math.round(hi.yPrice) + "%",
                    "[suggest] both move to " + Math.round(hi.yPrice)
                        + "% (higher — protects margin, undercut competitors not each other)"
                ],
                payload: {
                    hub:     hub,
                    dest:    dest,
                    sisters: prices,
                    suggestedY: Math.round(hi.yPrice)
                },
                applicable:     false,
                applicableNote: ADVISORY_NOTE
            })
        }
        return out.slice(0, o.topNPerKind)
    }

    async function proposeAll(server, opts) {
        const [lease, hubs, pricing] = await Promise.all([
            proposeLeaseBetweenSisters(server, opts),
            proposeHubAssignment(server, opts),
            proposeJointPricing(server, opts)
        ])
        return [].concat(lease, hubs, pricing)
    }

    window.AesStrategySisterCoordination = {
        proposeLeaseBetweenSisters: proposeLeaseBetweenSisters,
        proposeHubAssignment:       proposeHubAssignment,
        proposeJointPricing:        proposeJointPricing,
        proposeAll:                 proposeAll,
        DEFAULTS:                   Object.assign({}, DEFAULTS),
        ADVISORY_NOTE:              ADVISORY_NOTE,
        _classifySister:            _classifySister
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Pure classifier smoke
            const c = _classifySister({aircraft: [
                {currentLocationIata: "FRA", seats: 380},
                {currentLocationIata: "FRA", seats: 320},
                {currentLocationIata: "FRA", seats: 80},
                {currentLocationIata: "MUC", seats: 380}
            ]}, "FRA")
            console.assert(c.totals.total === 3, "[smoke s11] only FRA-based tails counted")
            console.assert(c.widebodyFrac > 0.6,  "[smoke s11] FRA mix dominated by widebody")
            console.assert(c.regionalFrac < 0.4, "[smoke s11] regional fraction low at FRA")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
