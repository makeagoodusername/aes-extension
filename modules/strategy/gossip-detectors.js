"use strict"

/**
 * AES Strategy — Markets Gossip detectors (Slice 27).
 *
 * Pure functions that read a chrome.storage.onChanged event (key,
 * oldValue, newValue) and return zero or more GossipEvent records. The
 * driver (`gossip-driver.js`) owns the subscription, dedup, and ring
 * persistence — detectors stay side-effect-free so they're testable in
 * isolation and can be re-run against fixtures.
 *
 * Detector registry shape (`AesStrategyGossipDetectors.DETECTORS`):
 *   [{name, match: (key) => boolean, run: (key, oldV, newV) => GossipEvent[]}]
 *
 * GossipEvent shape:
 *   {
 *     eventId:  "gsp-<base36-ts>-<rand>",
 *     ts:       number,
 *     kind:     string,          // detector name
 *     route?:   "<HUB>-<DEST>",
 *     iata?:    string,
 *     subject?: string,          // who/what (carrier code, route, etc.)
 *     severity: "low" | "med" | "high",
 *     summary:  string,          // user-readable one-liner
 *     evidence: object           // raw values for the modal/inspector
 *   }
 *
 * v1 ships three detectors; the registry is extensible without touching
 * the driver:
 *   - competitor-price-shift  — markets:competitors writes
 *   - new-entrant             — flightsFrom:<IATA> writes (carrier set diff)
 *   - own-lf-drop             — routeAssistant:topRoutes:* writes (LF Δ)
 *
 * Each detector is conservative: when oldValue is null (first scrape) it
 * returns []; the goal is "things that *changed*", not "things that
 * exist".
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyGossipDetectors) return

    const PCT_SHIFT_THRESHOLD = 0.20      // ≥ 20% price move → med severity
    const PCT_SHIFT_HIGH      = 0.30      // ≥ 30% → high
    const LF_DROP_THRESHOLD   = 0.10      // ≥ 10pp LF drop → med
    const LF_DROP_HIGH        = 0.20      // ≥ 20pp → high

    function _eventId() {
        return "gsp-" + Date.now().toString(36) + "-"
            + Math.floor(Math.random() * 1679616).toString(36).padStart(4, "0")
    }
    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _make(kind, severity, summary, extras) {
        return Object.assign({
            eventId:  _eventId(),
            ts:       Date.now(),
            kind:     kind,
            severity: severity,
            summary:  summary,
            evidence: {}
        }, extras || {})
    }

    // ── Detector 1: competitor-price-shift ─────────────────────────────
    // Key: routeAssistant:markets:competitors[:acct:<id>]:<HUB-DEST>
    function _matchCompetitorPrice(key) {
        return /^routeAssistant:markets:competitors(?::acct:[^:]+)?:[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/.test(key)
    }
    function _runCompetitorPrice(key, oldV, newV) {
        if (!oldV || !newV) return []
        const route = (key.match(/:([A-Z0-9]{3,4}-[A-Z0-9]{3,4})$/) || [])[1] || null
        if (!route) return []
        // Each rec carries a `flights[]` shape with per-carrier price data;
        // compute one event per carrier whose median price moved by
        // ≥ PCT_SHIFT_THRESHOLD across class Y. Cap to 3 events / write to
        // avoid spam on bulk re-scrapes.
        const events = []
        const oldByCarrier = _carrierPriceMap(oldV)
        const newByCarrier = _carrierPriceMap(newV)
        for (const code of newByCarrier.keys()) {
            const oldP = oldByCarrier.get(code)
            const newP = newByCarrier.get(code)
            if (!isFinite(oldP) || !isFinite(newP) || oldP <= 0) continue
            const pct = (newP - oldP) / oldP
            if (Math.abs(pct) < PCT_SHIFT_THRESHOLD) continue
            const severity = Math.abs(pct) >= PCT_SHIFT_HIGH ? "high" : "med"
            const direction = pct < 0 ? "dropped" : "raised"
            events.push(_make("competitor-price-shift", severity,
                code + " " + direction + " price on " + route + " by "
                + Math.round(Math.abs(pct) * 100) + "%",
                {route, subject: code, evidence: {oldP, newP, pct}}))
            if (events.length >= 3) break
        }
        return events
    }
    function _carrierPriceMap(rec) {
        const m = new Map()
        const flights = (rec && Array.isArray(rec.flights)) ? rec.flights
            : (rec && Array.isArray(rec.competitors)) ? rec.competitors
            : []
        for (const f of flights) {
            const code = f && (f.carrier || f.airline || f.code)
            const price = _num(f && (f.priceY || f.medianPrice || f.price), NaN)
            if (!code || !isFinite(price)) continue
            const cur = m.get(code)
            if (cur == null || price < cur) m.set(code, price)
        }
        return m
    }

    // ── Detector 2: new-entrant ────────────────────────────────────────
    // Key: flightsFrom:<IATA>
    function _matchNewEntrant(key) {
        return /^flightsFrom:[A-Z0-9]{3,4}$/.test(key)
    }
    function _runNewEntrant(key, oldV, newV) {
        if (!oldV || !newV) return []
        const iata = (key.match(/:([A-Z0-9]{3,4})$/) || [])[1] || null
        if (!iata) return []
        const oldCarriers = _carrierSet(oldV)
        const newCarriers = _carrierSet(newV)
        const newcomers = []
        for (const code of newCarriers) {
            if (!oldCarriers.has(code)) newcomers.push(code)
        }
        if (!newcomers.length) return []
        // Keep at most one event per write — bulk first-scrape would spam.
        return [_make("new-entrant", "med",
            (newcomers.length === 1 ? newcomers[0] : newcomers.length + " carriers")
            + " entered " + iata,
            {iata, subject: newcomers[0], evidence: {newcomers}})]
    }
    function _carrierSet(rec) {
        const out = new Set()
        const routes = (rec && Array.isArray(rec.routes)) ? rec.routes : []
        for (const r of routes) {
            const airlines = (r && Array.isArray(r.airlines)) ? r.airlines : []
            for (const a of airlines) {
                const code = a && (a.code || a.carrier || a.name)
                if (code) out.add(String(code))
            }
        }
        return out
    }

    // ── Detector 3: own-lf-drop ────────────────────────────────────────
    // Key: routeAssistant:topRoutes[:acct:<id>]:<HUB>
    function _matchOwnLfDrop(key) {
        return /^routeAssistant:topRoutes(?::acct:[^:]+)?:[A-Z0-9]{3,4}$/.test(key)
    }
    function _runOwnLfDrop(key, oldV, newV) {
        if (!oldV || !newV) return []
        const hub = (key.match(/:([A-Z0-9]{3,4})$/) || [])[1] || null
        if (!hub) return []
        const oldByDest = _lfMap(oldV, hub)
        const newByDest = _lfMap(newV, hub)
        const events = []
        for (const dest of newByDest.keys()) {
            const oldLf = oldByDest.get(dest)
            const newLf = newByDest.get(dest)
            if (!isFinite(oldLf) || !isFinite(newLf)) continue
            const drop = oldLf - newLf
            if (drop < LF_DROP_THRESHOLD) continue
            const severity = drop >= LF_DROP_HIGH ? "high" : "med"
            events.push(_make("own-lf-drop", severity,
                "LF dropped " + Math.round(drop * 100) + "pp on " + hub + "-" + dest,
                {route: hub + "-" + dest, evidence: {oldLf, newLf, drop}}))
            if (events.length >= 3) break
        }
        return events
    }
    function _lfMap(rec, hub) {
        const m = new Map()
        const routes = (rec && Array.isArray(rec.routes)) ? rec.routes
            : (rec && Array.isArray(rec.topRoutes)) ? rec.topRoutes
            : []
        for (const r of routes) {
            const dest = r && (r.dest || r.destIata)
            const lf = _num(r && (r.paxLF || r.loadFactor || r.lf), NaN)
            if (!dest || !isFinite(lf)) continue
            m.set(String(dest), lf)
        }
        return m
    }

    // ── Registry ────────────────────────────────────────────────────────
    const DETECTORS = [
        {name: "competitor-price-shift", match: _matchCompetitorPrice, run: _runCompetitorPrice},
        {name: "new-entrant",            match: _matchNewEntrant,      run: _runNewEntrant},
        {name: "own-lf-drop",            match: _matchOwnLfDrop,       run: _runOwnLfDrop}
    ]

    /**
     * Run every matching detector for a single (key, oldV, newV) triple.
     * Returns the concatenation of all detector outputs.
     */
    function runAll(key, oldV, newV) {
        const out = []
        for (const d of DETECTORS) {
            if (!d.match(key)) continue
            try {
                const evs = d.run(key, oldV, newV)
                if (Array.isArray(evs) && evs.length) out.push(...evs)
            } catch (e) {
                console.warn("[AesStrategyGossipDetectors] " + d.name + " threw", e)
            }
        }
        return out
    }

    window.AesStrategyGossipDetectors = {
        runAll:    runAll,
        DETECTORS: DETECTORS,
        // Expose internals for ?aes-debug + smoke harness.
        _carrierPriceMap: _carrierPriceMap,
        _carrierSet:      _carrierSet,
        _lfMap:           _lfMap
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            const e1 = runAll("routeAssistant:markets:competitors:JFK-LAX",
                {flights: [{carrier: "AA", priceY: 200}]},
                {flights: [{carrier: "AA", priceY: 140}]})
            console.assert(e1.length === 1 && e1[0].kind === "competitor-price-shift",
                "[smoke gossip] competitor price 30% drop detected")
            console.assert(e1[0].severity === "high", "[smoke gossip] severity high at 30%")

            const e2 = runAll("flightsFrom:LHR",
                {routes: [{destIata: "JFK", airlines: [{code: "BA"}]}]},
                {routes: [{destIata: "JFK", airlines: [{code: "BA"}, {code: "VS"}]}]})
            console.assert(e2.length === 1 && e2[0].kind === "new-entrant" && e2[0].subject === "VS",
                "[smoke gossip] new-entrant detected")

            const e3 = runAll("routeAssistant:topRoutes:JFK",
                {routes: [{dest: "LAX", paxLF: 0.85}]},
                {routes: [{dest: "LAX", paxLF: 0.65}]})
            console.assert(e3.length === 1 && e3[0].kind === "own-lf-drop" && e3[0].severity === "high",
                "[smoke gossip] own-lf-drop 20pp high")

            const eUnrelated = runAll("settings", {a: 1}, {a: 2})
            console.assert(eUnrelated.length === 0, "[smoke gossip] non-matching key ignored")

            const eFirstScrape = runAll("routeAssistant:markets:competitors:JFK-LAX",
                null, {flights: [{carrier: "AA", priceY: 100}]})
            console.assert(eFirstScrape.length === 0, "[smoke gossip] first scrape (no oldV) silent")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
