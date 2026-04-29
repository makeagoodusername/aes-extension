"use strict"

/**
 * AES Strategy — competitor response engine (Slice 10).
 *
 * Pure function. Reads `r.competitor` for each route, joins against the
 * AesStrategyCompetitorPriorStore prior, classifies week-over-week
 * events (entry, exit, priceCut, priceHike, freqAdd, freqDrop), and
 * proposes a counter-move per event:
 *
 *   Defensive (competitor attacks our share):
 *     - priceCut    → undercut +Y class price by 3pp (capped, anti-spiral)
 *     - freqAdd     → match: propose +N weekly flights on this route
 *     - entry       → defensive undercut + freq match if dominant carrier we lost
 *
 *   Opportunistic (competitor backs off):
 *     - priceHike   → hold (capture the margin tailwind)
 *     - freqDrop    → expand: propose +1 weekly flight
 *     - exit        → raise price 2pp + propose +2 weekly flights
 *
 * Anti-spiral guardrail (NORTH-STAR §4.17): every downward counter-move
 * is dampened when RouteAssistantCompetitorIncome estimates competitor
 * profit < configurable floor. Mirrors the pattern in price-moves.js;
 * duplicated here so this module stays decoupled from price-moves.
 *
 * Output shape — `competitorMove`:
 *   {hub, dest, event, eventDetail, action, magnitude, unit,
 *    rationale: [...], antiSpiral?: {dampened, ratio, estProfit, floor}}
 *
 * The whole proposer is read-only — no apply, no captures. The auto-driver
 * (or panel CTA) is expected to call AesStrategyCompetitorPriorStore.capture
 * separately so priors keep rolling forward.
 *
 * Public API:
 *   AesStrategy.proposeCompetitorMoves(snapshot, opts?) → Promise<CompetitorMove[]>
 *
 * Opts (all optional):
 *   {minAgeDays:6, priceCutThresholdPct:5, priceHikeThresholdPct:5,
 *    freqChangeThresholdPct:15, undercutPp:3, opportunisticRaisePp:2,
 *    freqMatchCap:3}
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeCompetitorMoves === "function") return

    const DEFAULTS = Object.freeze({
        minAgeDays:             6,
        priceCutThresholdPct:   5,
        priceHikeThresholdPct:  5,
        freqChangeThresholdPct: 15,
        undercutPp:             3,
        opportunisticRaisePp:   2,
        freqMatchCap:           3,
        antiSpiralDamper:       0.5,
        // Spec: "max 1 frequency increase per route per 2 weeks"
        // (NORTH-STAR §4.17 anti-spiral). Suppresses any freq-increase
        // proposal (matchFreq, expand) when this module proposed a
        // freq move on the same route within the window.
        freqProposalCooldownDays: 14
    })

    const FREQ_COOLDOWN_KEY_PREFIX = "aesStrategy:competitorFreqProposalTs:"

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    function _resolveOpts(opts) {
        const o = opts || {}
        const out = {}
        for (const k in DEFAULTS) {
            out[k] = (o[k] != null) ? Number(o[k]) : DEFAULTS[k]
        }
        return out
    }

    /**
     * §4.17 anti-spiral check — when we're proposing a downward counter-
     * move and the competitor is already estimated below the income
     * floor, dampen the magnitude. Mirrors price-moves.js so the two
     * proposers stay aligned. Returns one of:
     *   {available: true,  damper, estProfit, floor, confidence}
     *   {available: false}
     */
    function _antiSpiralGuard(route, snapshot, opts) {
        if (typeof RouteAssistantCompetitorIncome === "undefined") return {available: false}
        const c = route && route.competitor
        if (!c) return {available: false}
        const dist = _num(route && route.distanceKm, 0)
        if (dist <= 0) return {available: false}
        const totalFlights = _num(c.flightCount, 0)
        const ourFlights   = _num(c.ourFlightCount, 0)
        const compFreq     = totalFlights - ourFlights
        if (compFreq <= 0) return {available: false}
        const compPrice = _num(c.priceMin, NaN)
        if (!isFinite(compPrice) || compPrice <= 0) return {available: false}
        const spec = route.spec || null
        if (!spec || !spec.seats || !spec.range || !spec.speed) return {available: false}
        const ourShare = _num(route.ourPaxShare, 0)
        const compSharePct = Math.max(0, Math.min(100, (1 - ourShare) * 100))
        const econ = (snapshot && snapshot.settings && snapshot.settings.economics) || {}
        let result
        try {
            result = RouteAssistantCompetitorIncome.estimate({
                distanceKm:       dist,
                price:            compPrice,
                frequency:        compFreq,
                aircraftSpec:     spec,
                observedSharePct: compSharePct,
                economics:        econ
            })
        } catch (_) { return {available: false} }
        if (!result || result.confidence === "low") return {available: false}
        const estProfit = _num(result.estProfitPerWeek, NaN)
        if (!isFinite(estProfit)) return {available: false}
        const floor = _num(econ.competitorIncomeFloorWeekly, 5000)
        const dampen = estProfit < floor
        return {
            available:  true,
            damper:     dampen ? opts.antiSpiralDamper : 1,
            estProfit:  estProfit,
            floor:      floor,
            confidence: result.confidence
        }
    }

    /**
     * Classify week-over-week events. Returns an array of {event, detail}
     * — there can be multiple events per route (e.g. priceCut + freqAdd
     * happens often when a competitor really attacks).
     */
    function _classifyEvents(prior, current, opts) {
        const events = []
        const pFreq = _num(prior  && prior.flightCount,  0)
        const cFreq = _num(current && current.flightCount, 0)
        const pMin  = _num(prior  && prior.priceMin,    null)
        const cMin  = _num(current && current.priceMin, null)

        // Entry / exit are dominant — only one of {entry, exit, freq*} fires.
        if (pFreq <= 0 && cFreq > 0) {
            events.push({event: "entry", detail: {priorFlights: pFreq, currentFlights: cFreq}})
        } else if (pFreq > 0 && cFreq <= 0) {
            events.push({event: "exit", detail: {priorFlights: pFreq, currentFlights: cFreq}})
        } else if (pFreq > 0 && cFreq > 0) {
            const freqDeltaPct = ((cFreq - pFreq) / pFreq) * 100
            if (freqDeltaPct >= opts.freqChangeThresholdPct) {
                events.push({event: "freqAdd",
                    detail: {priorFlights: pFreq, currentFlights: cFreq,
                             deltaPct: _round(freqDeltaPct, 1)}})
            } else if (freqDeltaPct <= -opts.freqChangeThresholdPct) {
                events.push({event: "freqDrop",
                    detail: {priorFlights: pFreq, currentFlights: cFreq,
                             deltaPct: _round(freqDeltaPct, 1)}})
            }
        }

        // Price events ride alongside freq events (pricing can shift
        // independently of capacity).
        if (isFinite(pMin) && isFinite(cMin) && pMin > 0) {
            const priceDeltaPct = ((cMin - pMin) / pMin) * 100
            if (priceDeltaPct <= -opts.priceCutThresholdPct) {
                events.push({event: "priceCut",
                    detail: {priorMin: pMin, currentMin: cMin,
                             deltaPct: _round(priceDeltaPct, 1)}})
            } else if (priceDeltaPct >= opts.priceHikeThresholdPct) {
                events.push({event: "priceHike",
                    detail: {priorMin: pMin, currentMin: cMin,
                             deltaPct: _round(priceDeltaPct, 1)}})
            }
        }
        return events
    }

    /**
     * Map event → counter-move shape. Returns null for events that don't
     * warrant action (e.g. priceHike when we're already mid-band).
     */
    function _counterMove(event, detail, route, opts) {
        switch (event.event) {
            case "priceCut": {
                // Defensive undercut on Y — magnitude bounded by undercutPp.
                return {
                    action:    "undercut",
                    magnitude: -opts.undercutPp,
                    unit:      "pp",
                    target:    "Y price",
                    summary:   "competitor min " + detail.priorMin + "% → " + detail.currentMin
                                + "% (Δ" + detail.deltaPct + "%)"
                }
            }
            case "freqAdd": {
                const pFreq = _num(detail.priorFlights, 0)
                const cFreq = _num(detail.currentFlights, 0)
                const gap   = cFreq - pFreq
                const match = Math.max(1, Math.min(opts.freqMatchCap, Math.ceil(gap / 2)))
                return {
                    action:    "matchFreq",
                    magnitude: match,
                    unit:      "weeklyFlights",
                    target:    "frequency",
                    summary:   "competitor freq " + pFreq + " → " + cFreq
                                + " (+" + (cFreq - pFreq) + "/wk)"
                }
            }
            case "entry": {
                return {
                    action:    "defendEntry",
                    magnitude: -opts.undercutPp,
                    unit:      "pp",
                    target:    "Y price",
                    summary:   "new competitor entered with " + detail.currentFlights + " weekly flights"
                }
            }
            case "exit": {
                return {
                    action:    "captureExit",
                    magnitude: opts.opportunisticRaisePp,
                    unit:      "pp",
                    target:    "Y price",
                    summary:   "competitor exited (was " + detail.priorFlights + "/wk)"
                }
            }
            case "freqDrop": {
                return {
                    action:    "expand",
                    magnitude: 1,
                    unit:      "weeklyFlights",
                    target:    "frequency",
                    summary:   "competitor freq " + detail.priorFlights + " → " + detail.currentFlights
                                + " (" + detail.deltaPct + "%) — opportunistic +1/wk"
                }
            }
            case "priceHike": {
                return {
                    action:    "hold",
                    magnitude: 0,
                    unit:      "pp",
                    target:    "Y price",
                    summary:   "competitor min " + detail.priorMin + "% → " + detail.currentMin
                                + "% — hold to capture margin tailwind"
                }
            }
            default: return null
        }
    }

    function _buildMove(route, hub, eventEnvelope, counter, guard) {
        const rationale = []
        rationale.push("[event] " + eventEnvelope.event + " · " + counter.summary)
        rationale.push("[counter] " + counter.action
            + (counter.magnitude !== 0
                ? " · magnitude " + (counter.magnitude > 0 ? "+" : "")
                  + counter.magnitude + counter.unit + " on " + counter.target
                : " (no change)"))
        let magnitude = counter.magnitude
        let antiSpiral = null
        if (counter.magnitude < 0 && guard && guard.available) {
            if (guard.damper < 1) {
                magnitude = _round(counter.magnitude * guard.damper, 1)
                antiSpiral = {
                    dampened:   true,
                    damper:     guard.damper,
                    estProfit:  guard.estProfit,
                    floor:      guard.floor,
                    confidence: guard.confidence
                }
                rationale.push("[anti-spiral] competitor profit est ~$"
                    + Math.round(guard.estProfit) + "/wk below floor $"
                    + guard.floor + "/wk (confidence " + guard.confidence
                    + ") — counter-move dampened ×" + guard.damper
                    + " (" + counter.magnitude + counter.unit + " → " + magnitude + counter.unit + ")")
            } else {
                antiSpiral = {dampened: false, estProfit: guard.estProfit,
                              floor: guard.floor, confidence: guard.confidence}
                rationale.push("[anti-spiral] competitor profit est ~$"
                    + Math.round(guard.estProfit) + "/wk (confidence " + guard.confidence
                    + ") — above floor $" + guard.floor + "/wk")
            }
        } else if (counter.magnitude < 0) {
            rationale.push("[anti-spiral] competitor-income data unavailable — counter-move applied at full magnitude")
        }
        return {
            hub:         hub,
            dest:        route.dest,
            event:       eventEnvelope.event,
            eventDetail: eventEnvelope.detail,
            action:      counter.action,
            magnitude:   magnitude,
            unit:        counter.unit,
            target:      counter.target,
            rationale:   rationale,
            antiSpiral:  antiSpiral
        }
    }

    /**
     * Bulk-load the per-route last-proposal timestamps for the freq-doubling
     * cooldown gate. Returns Map<"HUB-DEST", ts>. Best-effort: any storage
     * read failure returns an empty map so the engine still proposes; the
     * cooldown is a guard, not a correctness invariant.
     */
    async function _loadFreqCooldownMap(pairs) {
        const out = new Map()
        if (!pairs || !pairs.length) return out
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return out
        const keys = pairs.map(([h, d]) =>
            FREQ_COOLDOWN_KEY_PREFIX + String(h).toUpperCase() + "-" + String(d).toUpperCase())
        let got
        try { got = await chrome.storage.local.get(keys) }
        catch (_) { return out }
        for (const k of keys) {
            const rec = got && got[k]
            if (rec && isFinite(rec.ts)) {
                out.set(k.slice(FREQ_COOLDOWN_KEY_PREFIX.length), Number(rec.ts))
            }
        }
        return out
    }

    /**
     * Persist a fresh freq-proposal timestamp. Fire-and-forget — the move
     * has already been pushed to the output array; failure to record the
     * cooldown only means we might re-propose the same move next call.
     */
    function _writeFreqCooldown(hub, dest, ts) {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return
        const k = FREQ_COOLDOWN_KEY_PREFIX + String(hub).toUpperCase()
            + "-" + String(dest).toUpperCase()
        try {
            chrome.storage.local.set({[k]: {ts: ts, hub: hub, dest: dest}})
                .catch && chrome.storage.local.set({[k]: {ts: ts, hub: hub, dest: dest}})
                    .catch(() => {})
        } catch (_) {}
    }

    /**
     * Convert a freq-increase move into a "watch" no-op when the route is
     * inside the cooldown window. Preserves the move shape so downstream
     * diff-plan / panel renderers don't have to special-case suppression.
     */
    function _suppressedFreqMove(move, lastTs, cooldownDays) {
        const ageDays = _round((Date.now() - lastTs) / 86_400_000, 1)
        const remainingDays = _round(cooldownDays - ageDays, 1)
        const supp = Object.assign({}, move, {
            action:      "watch",
            magnitude:   0,
            rationale:   move.rationale.slice(),
            suppressed:  {reason: "freqCooldown", lastTs, ageDays, cooldownDays, remainingDays}
        })
        supp.rationale.push("[cooldown] last freq proposal " + ageDays + "d ago"
            + " — suppressing for " + remainingDays + "d more"
            + " (max 1 increase per " + cooldownDays + "d, NORTH-STAR §4.17 anti-spiral)")
        return supp
    }

    async function proposeCompetitorMoves(snapshot, opts) {
        const o = _resolveOpts(opts)
        const out = []
        if (!snapshot || !Array.isArray(snapshot.hubs)) return out
        const store = window.AesStrategyCompetitorPriorStore
        if (!store || typeof store.bulkLoadPrior !== "function") return out

        // Collect (hub, dest) pairs that have any competitor signal.
        const pairs = []
        for (const h of snapshot.hubs) for (const r of (h && h.byRoute) || []) {
            if (h.iata && r && r.dest) pairs.push([h.iata, r.dest])
        }
        if (!pairs.length) return out

        const [priorMap, cooldownMap] = await Promise.all([
            store.bulkLoadPrior(pairs, {minAgeDays: o.minAgeDays}),
            _loadFreqCooldownMap(pairs)
        ])
        const cooldownMs = Math.max(0, o.freqProposalCooldownDays * 86_400_000)
        const now = Date.now()

        for (const h of snapshot.hubs) for (const r of (h && h.byRoute) || []) {
            if (!h.iata || !r || !r.dest) continue
            const k = String(h.iata).toUpperCase() + "-" + String(r.dest).toUpperCase()
            const priorEntry = priorMap.get(k)
            if (!priorEntry || !priorEntry.summary) continue
            const events = _classifyEvents(priorEntry.summary, r.competitor, o)
            if (!events.length) continue
            const guard = _antiSpiralGuard(r, snapshot, o)
            for (const ev of events) {
                const counter = _counterMove(ev, ev.detail, r, o)
                if (!counter) continue
                let move = _buildMove(r, h.iata, ev, counter, guard)

                // Frequency-doubling cooldown — suppress freq increases
                // (matchFreq, expand) within the window. Price moves and
                // freqDrop->expand are still suppressed if expand emits a
                // weeklyFlights >0 magnitude. Watches stay informational.
                const isFreqIncrease = move.unit === "weeklyFlights"
                                       && Number(move.magnitude) > 0
                if (isFreqIncrease) {
                    const lastTs = cooldownMap.get(k)
                    if (lastTs && (now - lastTs) < cooldownMs) {
                        move = _suppressedFreqMove(move, lastTs, o.freqProposalCooldownDays)
                    } else {
                        // Roll the cooldown forward; same-session duplicate
                        // events on the same route also self-suppress via
                        // the in-memory map.
                        cooldownMap.set(k, now)
                        _writeFreqCooldown(h.iata, r.dest, now)
                    }
                }

                // Surface the prior age so the user knows the diff window.
                const ageDays = _round((now - priorEntry.ts) / 86_400_000, 1)
                move.rationale.push("[diff window] prior captured "
                    + ageDays + "d ago (" + new Date(priorEntry.ts).toISOString().slice(0, 10) + ")")
                out.push(move)
            }
        }
        return out
    }

    ns.proposeCompetitorMoves = proposeCompetitorMoves

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    // Stash + restore the real prior-store global so the smoke's stubs
    // don't permanently clobber it for the rest of the session.
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const realStore = window.AesStrategyCompetitorPriorStore
            const fakePriors = new Map()
            window.AesStrategyCompetitorPriorStore = {
                bulkLoadPrior: async function () { return fakePriors }
            }
            const SEVEN_DAYS = 7 * 86_400_000
            const longAgo    = Date.now() - SEVEN_DAYS
            fakePriors.set("FRA-LHR", {ts: longAgo, summary: {
                flightCount: 14, priceMin: 100, priceMax: 120, ourFlightCount: 7
            }})
            fakePriors.set("FRA-CDG", {ts: longAgo, summary: {
                flightCount: 7, priceMin: 95, priceMax: 105, ourFlightCount: 0
            }})
            fakePriors.set("FRA-MAD", {ts: longAgo, summary: {
                flightCount: 7, priceMin: 100, priceMax: 110, ourFlightCount: 0
            }})
            const snap = {
                hubs: [{iata: "FRA", byRoute: [
                    {dest: "LHR", competitor: {flightCount: 14, priceMin: 90,   priceMax: 110, ourFlightCount: 7}},
                    {dest: "CDG", competitor: {flightCount: 0,  priceMin: null, priceMax: null, ourFlightCount: 0}},
                    {dest: "MAD", competitor: {flightCount: 10, priceMin: 100,  priceMax: 110, ourFlightCount: 0}}
                ]}]
            }
            ;(async () => {
                try {
                    const moves = await proposeCompetitorMoves(snap)
                    const byHubDest = (h, d) => moves.filter(m => m.hub === h && m.dest === d)
                    const lhr = byHubDest("FRA", "LHR")
                    console.assert(lhr.some(m => m.event === "priceCut" && m.action === "undercut"),
                        "[smoke s10] FRA-LHR priceCut → undercut surfaced")
                    const cdg = byHubDest("FRA", "CDG")
                    console.assert(cdg.some(m => m.event === "exit" && m.action === "captureExit"),
                        "[smoke s10] FRA-CDG exit → captureExit surfaced")
                    const mad = byHubDest("FRA", "MAD")
                    console.assert(mad.some(m => m.event === "freqAdd" && m.action === "matchFreq"),
                        "[smoke s10] FRA-MAD freqAdd → matchFreq surfaced")
                    const undercut = lhr.find(m => m.action === "undercut")
                    console.assert(undercut && undercut.magnitude < 0,
                        "[smoke s10] undercut magnitude is negative")
                    console.assert(undercut && /diff window/.test(undercut.rationale.join(" ")),
                        "[smoke s10] rationale carries diff-window age")
                } catch (e) {
                    console.warn("[smoke s10] async failure", e)
                } finally {
                    // Restore the real store so production code paths keep working.
                    if (realStore) window.AesStrategyCompetitorPriorStore = realStore
                    else delete window.AesStrategyCompetitorPriorStore
                }
            })()
        }
    } catch (_) { /* never let smoke break the page */ }
})()
