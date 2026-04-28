"use strict"

/**
 * AES Strategy — auto route creation applier (Slice 6).
 *
 * Takes a `RouteCreation` proposal from `route-creation.js` (Slice 3+6)
 * and turns it into real legs on a real aircraft via the existing
 * fleet-apply-orchestrator. Strategy never POSTs directly — this module
 * is a pure orchestration layer over `AesAfpFleetApplyOrchestrator.start`.
 *
 * Aircraft selection (priority order):
 *   1. Tails of one of `proposedTypeIds` whose `currentLocationIata`
 *      matches the creation's hub, sorted by remaining wear-budget
 *      headroom (`maxWeeklyBlockHours - weeklyHoursLast7d`) descending.
 *   2. Fallback: any tail of the right type, sorted by headroom desc.
 *
 * Leg construction:
 *   - Builds N round-trip leg pairs where N = `proposedFrequency`,
 *     clamped to [1, 14] weekly flights.
 *   - Departures spread evenly across the operating window 06:00–22:00
 *     so two waves don't bunch on the same hour.
 *   - Each pair = {origin → dest at depTime, dest → origin at retTime},
 *     where retTime = depTime + flightMin + 60 min ground turn.
 *   - Service is "" (AS default) and pricePct = `proposedPricePct`.
 *
 * Tier gate: this module does NOT enforce the strategy tier gate or the
 * `routeCreationEnabled` flag — those checks live in `apply-pipeline.js`'s
 * `canApply()`. The orchestrator downstream still enforces the AFP tier
 * gate (`autoScheduler.enabled === true && tier === "apply-on-confirm"`),
 * so even if strategy authorises the apply, AFP can still abort.
 *
 * Public API (window.AesStrategyRouteCreationApplier):
 *   apply(creation, snapshot, opts) → Promise<{
 *     ok, aircraft?, legs?, result?, error?, reason?
 *   }>
 *   pickAircraft(creation, snapshot)         → aircraft | null   (pure)
 *   buildLegs(creation, aircraft)            → leg[] | null      (pure)
 *
 * `opts.server` — required for the orchestrator ctx. Falls back to
 * `snapshot.server` when missing.
 * `opts.source` — audit tag; default `"aesStrategy-routeCreation"`.
 *
 * Failure modes (returned via `{ok: false, reason}`):
 *   - "no-fleet"             — no eligible tail in the snapshot
 *   - "leg-build-failed"     — couldn't compute flight time (missing speed/distance)
 *   - "missing-orchestrator" — AesAfpFleetApplyOrchestrator not loaded on this page
 *   - "missing-server"       — neither opts.server nor snapshot.server set
 *   - "orchestrator-aborted" — orchestrator returned aborted=true (tier gate dormant, etc.)
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyRouteCreationApplier) return

    const TAXI_MIN          = 20      // matches scoring-primitives default
    const GROUND_TURN_MIN   = 60      // min between arrival and return depart
    const DAY_START_HOUR    = 6
    const DAY_END_HOUR      = 22
    const FREQ_MIN          = 1
    const FREQ_MAX          = 14
    const FALLBACK_HOURS    = 80
    const FALLBACK_SPEED    = 800

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _scoring() { return window.AesStrategyScoring || null }

    function _formatHHMM(hourFloat) {
        let h = Math.floor(hourFloat) % 24
        if (h < 0) h += 24
        const m = Math.round((hourFloat - Math.floor(hourFloat)) * 60) % 60
        const hh = h < 10 ? "0" + h : String(h)
        const mm = m < 10 ? "0" + m : String(m)
        return hh + ":" + mm
    }

    function _headroom(a) {
        const cap  = _num(a && a.wear && a.wear.maxWeeklyBlockHours, FALLBACK_HOURS)
        const used = _num(a && a.wear && a.wear.weeklyHoursLast7d,  0)
        return Math.max(0, cap - used)
    }

    function pickAircraft(creation, snapshot) {
        if (!creation || !snapshot || !Array.isArray(snapshot.fleet)) return null
        const types = creation.proposedTypeIds || []
        if (!types.length) return null
        const wanted = new Set(types.map(Number))
        const fleet = snapshot.fleet.filter(a => a && a.aircraftId && wanted.has(Number(a.typeId)))
        if (!fleet.length) return null

        const atHub = fleet.filter(a => a.currentLocationIata === creation.hub)
        const ranked = (atHub.length ? atHub : fleet)
            .slice()
            .sort((a, b) => _headroom(b) - _headroom(a))
        return ranked[0] || null
    }

    /**
     * Spread N departures across the operating window 06:00–22:00 so the
     * waves don't bunch. Returns N float-hours in [DAY_START_HOUR, DAY_END_HOUR).
     */
    function _spreadDepHours(n) {
        const cnt = Math.max(1, n | 0)
        const span = DAY_END_HOUR - DAY_START_HOUR
        if (cnt === 1) return [DAY_START_HOUR + span / 2]
        const out = []
        const step = span / cnt
        for (let i = 0; i < cnt; i++) out.push(DAY_START_HOUR + step * i + step / 2)
        return out
    }

    function buildLegs(creation, aircraft) {
        if (!creation || !aircraft) return null
        const sc = _scoring()
        const dist  = _num(creation.distanceKm, 0)
        const speed = _num(aircraft.cruiseSpeedKmh, FALLBACK_SPEED)
        if (dist <= 0) return null
        const flightMin = sc && sc.flightTimeMin ? sc.flightTimeMin(dist, speed, TAXI_MIN) : null
        if (flightMin == null || flightMin <= 0) return null

        const freq = Math.max(FREQ_MIN, Math.min(FREQ_MAX, _num(creation.proposedFrequency, FREQ_MIN)))
        const pricePct = _num(creation.proposedPricePct, 100)
        const hub = (aircraft.currentLocationIata || creation.hub || "").toUpperCase()
        const dest = (creation.dest || "").toUpperCase()
        if (!hub || !dest) return null

        const depHours = _spreadDepHours(freq)
        const legs = []
        let seq = 1
        for (const depH of depHours) {
            const depTime = _formatHHMM(depH)
            const retH = (depH + flightMin / 60 + GROUND_TURN_MIN / 60) % 24
            const retTime = _formatHHMM(retH)
            legs.push({
                seq:           seq++,
                origin:        hub,
                destination:   dest,
                depTimeLocal:  depTime,
                pricePct:      pricePct,
                service:       "",
                _strategy:     {newRoute: true, distanceKm: dist, flightMin: flightMin}
            })
            legs.push({
                seq:           seq++,
                origin:        dest,
                destination:   hub,
                depTimeLocal:  retTime,
                pricePct:      pricePct,
                service:       "",
                _strategy:     {newRoute: true, distanceKm: dist, flightMin: flightMin, return: true}
            })
        }
        return legs
    }

    async function apply(creation, snapshot, opts) {
        const o = opts || {}
        if (!creation || !creation.hub || !creation.dest) {
            return {ok: false, error: "creation missing hub/dest", reason: "bad-input"}
        }
        if (typeof window.AesAfpFleetApplyOrchestrator === "undefined"
                || typeof window.AesAfpFleetApplyOrchestrator.start !== "function") {
            return {ok: false, error: "AesAfpFleetApplyOrchestrator not loaded", reason: "missing-orchestrator"}
        }

        const aircraft = pickAircraft(creation, snapshot)
        if (!aircraft) {
            return {ok: false, error: "no eligible aircraft for creation " + creation.hub + "→" + creation.dest,
                    reason: "no-fleet"}
        }
        const legs = buildLegs(creation, aircraft)
        if (!legs || !legs.length) {
            return {ok: false, error: "could not build legs", reason: "leg-build-failed"}
        }

        const server = o.server || (snapshot && snapshot.server) || null
        if (!server) {
            return {ok: false, error: "no server context",
                    reason: "missing-server", aircraft: aircraft, legs: legs}
        }

        let result = null
        try {
            result = await window.AesAfpFleetApplyOrchestrator.start({
                runs:   [{aircraftId: String(aircraft.aircraftId), legs: legs, hub: creation.hub}],
                ctx:    {server: server},
                source: o.source || "aesStrategy-routeCreation"
            })
        } catch (e) {
            return {ok: false, error: (e && e.message) || String(e),
                    reason: "orchestrator-threw", aircraft: aircraft, legs: legs}
        }
        if (result && result.aborted) {
            return {ok: false, error: "orchestrator aborted",
                    reason: "orchestrator-aborted",
                    aircraft: aircraft, legs: legs, result: result}
        }
        return {ok: !!(result && result.ok),
                aircraft: aircraft, legs: legs, result: result}
    }

    window.AesStrategyRouteCreationApplier = {
        apply:         apply,
        pickAircraft:  pickAircraft,
        buildLegs:     buildLegs,
        // Internal helpers exposed for ?aes-debug smoke + future tests
        _spreadDepHours: _spreadDepHours,
        _formatHHMM:     _formatHHMM
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // _spreadDepHours
            const s1 = _spreadDepHours(1)
            console.assert(s1.length === 1 && Math.abs(s1[0] - 14) < 1e-9,
                "[smoke routeCreation] freq=1 → midday")
            const s4 = _spreadDepHours(4)
            console.assert(s4.length === 4 && s4[0] < s4[3],
                "[smoke routeCreation] freq=4 → 4 ascending hours")
            console.assert(s4.every(h => h >= DAY_START_HOUR && h < DAY_END_HOUR),
                "[smoke routeCreation] depHours within operating window")

            // _formatHHMM
            console.assert(_formatHHMM(9.5) === "09:30", "[smoke routeCreation] 9.5h → 09:30")
            console.assert(_formatHHMM(15.25) === "15:15", "[smoke routeCreation] 15.25h → 15:15")
            console.assert(_formatHHMM(25) === "01:00", "[smoke routeCreation] wrap")

            // pickAircraft
            const fakeSnap = {
                fleet: [
                    {aircraftId: "1", typeId: 100, currentLocationIata: "ATL", wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 70}},
                    {aircraftId: "2", typeId: 100, currentLocationIata: "ATL", wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 30}},
                    {aircraftId: "3", typeId: 200, currentLocationIata: "ATL"},
                    {aircraftId: "4", typeId: 100, currentLocationIata: "ORD", wear: {maxWeeklyBlockHours: 80, weeklyHoursLast7d: 10}}
                ]
            }
            const pickHub = pickAircraft({hub: "ATL", proposedTypeIds: [100]}, fakeSnap)
            console.assert(pickHub && pickHub.aircraftId === "2",
                "[smoke routeCreation] pick ATL tail with most headroom")
            const pickFallback = pickAircraft({hub: "DFW", proposedTypeIds: [100]}, fakeSnap)
            console.assert(pickFallback && pickFallback.aircraftId === "4",
                "[smoke routeCreation] no ATL tail at hub → fallback to most-headroom anywhere")
            const noFleet = pickAircraft({hub: "ATL", proposedTypeIds: [999]}, fakeSnap)
            console.assert(noFleet === null,
                "[smoke routeCreation] no fleet of right type → null")

            // buildLegs
            const ac = {aircraftId: "2", currentLocationIata: "ATL", cruiseSpeedKmh: 800}
            const legs = buildLegs({hub: "ATL", dest: "MCO", distanceKm: 600, proposedFrequency: 2, proposedPricePct: 105}, ac)
            console.assert(legs && legs.length === 4, "[smoke routeCreation] freq=2 → 4 legs")
            console.assert(legs[0].origin === "ATL" && legs[0].destination === "MCO",
                "[smoke routeCreation] outbound leg shape")
            console.assert(legs[1].origin === "MCO" && legs[1].destination === "ATL",
                "[smoke routeCreation] return leg shape")
            console.assert(legs[0].pricePct === 105, "[smoke routeCreation] pricePct threaded")
            console.assert(legs[0]._strategy && legs[0]._strategy.newRoute === true,
                "[smoke routeCreation] _strategy.newRoute marker")

            const noLegsZero = buildLegs({hub: "ATL", dest: "MCO", distanceKm: 0, proposedFrequency: 1}, ac)
            console.assert(noLegsZero === null, "[smoke routeCreation] zero distance → null")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
