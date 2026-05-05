"use strict"

/**
 * AES Strategy — fleet-renewal proposers (Slice 13, advisory v1).
 *
 * Decides which aircraft to retire and which type to acquire next.
 * Convert (pax → cargo) is scaffolded but disabled in v1 — cargo
 * demand modelling needs data sources not yet audited; deferred to
 * Slice 13.1 once a cargo-demand index lands.
 *
 * v1 emits ADVISORY decisions only. No actuators. The user routes
 * lease/buy actions through Fleet Command (capex form) and the AS
 * "remove from fleet" UI for retire.
 *
 * Algorithm:
 *
 *   Retire — for each tail:
 *     score = w_age * ageYears/24
 *           + w_maint * (1 − ratio/100)
 *           + w_wear * wearPressure
 *     where wearPressure = clamp((nominalBlockHours − equilibriumWeeklyBlockHours) / nominalBlockHours, 0, 1)
 *     when AesAfpWearModel.fit returns a meaningful equilibrium; 0 otherwise.
 *     Surface top-N by score above a threshold (default 0.55).
 *
 *   Acquire — read the most recent used-aircraft-scanner session;
 *     join with `MarketScanDealMetrics` to get per-row score blends.
 *     Surface the top-N highest-scored offers whose category aligns
 *     with the airline's existing fleet bias (don't recommend a heavy
 *     widebody for a regional carrier).
 *
 *   Convert — placeholder. Returns [] in v1; the API stays for the
 *     same call signature as the other two so v1 callers can iterate
 *     them uniformly.
 *
 * Public API (window.AesStrategyFleetRenewal):
 *   proposeRetire(snapshot, opts?)  → Promise<Decision[]>
 *   proposeAcquire(snapshot, opts?) → Promise<Decision[]>
 *   proposeConvert(snapshot, opts?) → Promise<Decision[]>
 *   proposeAll(snapshot, opts?)     → Promise<Decision[]>
 *
 * Decision shape:
 *   {
 *     id, domain: "fleet-renewal", kind: "retire"|"acquire"|"convert",
 *     title, subtitle, rationale[], payload, applicable: false,
 *     applicableNote: "advisory only (Slice 13 v1 — no actuator)"
 *   }
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyFleetRenewal) return

    const DEFAULTS = {
        retire: {
            ageWeight:     0.40,
            maintWeight:   0.45,
            wearWeight:    0.15,
            scoreFloor:    0.55,
            topN:          5
        },
        acquire: {
            scoreFloor:    0.45,
            topN:          5,
            requireFamilyMatch: true
        },
        convert: {
            enabled: false
        }
    }

    const ADVISORY_NOTE = "advisory only (Slice 13 v1 — no actuator)"

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _ageYears(aircraft) {
        if (!aircraft) return 0
        const a = _num(aircraft.age, NaN)
        if (isFinite(a) && a >= 0) return a
        const am = _num(aircraft.ageMonths, NaN)
        if (isFinite(am)) return am / 12
        const dom = _num(aircraft.dateOfManufactureWeek, _num(aircraft.dateOfBuild, NaN))
        if (isFinite(dom)) {
            const nowSec = Date.now() / 1000
            return Math.max(0, (nowSec - dom) / (365.25 * 86400))
        }
        return 0
    }

    function _maintRatio(aircraft) {
        if (!aircraft) return 100
        const r = _num(aircraft.maintenance, _num(aircraft.maintanance,
                                                  _num(aircraft.maintenanceRatio, NaN)))
        if (isFinite(r) && r > 0) return r
        return 100
    }

    async function _wearPressure(server, aircraftId) {
        if (!server || aircraftId == null) return 0
        if (!window.AesAfpWearModel || typeof window.AesAfpWearModel.fit !== "function") return 0
        try {
            const fit = await window.AesAfpWearModel.fit(server, aircraftId)
            if (!fit) return 0
            const eq = _num(fit.equilibriumWeeklyBlockHours, NaN)
            if (!isFinite(eq) || eq <= 0) return 0
            // Nominal weekly block hours per category — coarse default 70h
            // (10h/day × 7d). When eq is well below nominal, the aircraft
            // can't meet a regular schedule without losing condition; that's
            // the renewal pressure.
            const nominal = 70
            const pressure = Math.max(0, Math.min(1, (nominal - eq) / nominal))
            return pressure
        } catch (_) { return 0 }
    }

    /**
     * Walk the fleet on the snapshot, score each tail, surface retire
     * candidates above scoreFloor sorted desc.
     */
    async function proposeRetire(snapshot, opts) {
        const o = Object.assign({}, DEFAULTS.retire, (opts && opts.retire) || {})
        const fleet = (snapshot && snapshot.fleet) || []
        if (!Array.isArray(fleet) || !fleet.length) return []
        const server = snapshot && snapshot.server
        const out = []
        for (const a of fleet) {
            if (!a) continue
            const ageY = _ageYears(a)
            const ratio = _maintRatio(a)
            const wear = await _wearPressure(server, a.aircraftId)
            const ageNorm = Math.max(0, Math.min(1, ageY / 24))
            const ratioNorm = Math.max(0, Math.min(1, (100 - ratio) / 100))
            const score = ageNorm * o.ageWeight
                        + ratioNorm * o.maintWeight
                        + wear * o.wearWeight
            if (score < o.scoreFloor) continue
            const ratEntries = []
            ratEntries.push("[age] " + ageY.toFixed(1) + "y (norm " + ageNorm.toFixed(2) + ")")
            ratEntries.push("[maint] ratio " + ratio.toFixed(0) + "% (gap norm " + ratioNorm.toFixed(2) + ")")
            if (wear > 0) ratEntries.push("[wear] equilibrium below nominal — pressure " + wear.toFixed(2))
            else ratEntries.push("[wear] equilibrium not yet fit (need more samples)")
            ratEntries.push("[score] " + score.toFixed(2) + " ≥ floor " + o.scoreFloor)
            out.push({
                id:    "fleet-renewal:retire:" + (a.aircraftId || a.registration || "?"),
                domain: "fleet-renewal",
                kind:   "retire",
                title:  "Retire " + (a.equipment || "tail")
                        + (a.registration ? " · " + a.registration : ""),
                subtitle: "score " + score.toFixed(2)
                          + " · age " + ageY.toFixed(1) + "y · ratio " + ratio.toFixed(0) + "%",
                rationale: ratEntries,
                payload: {
                    aircraftId:     a.aircraftId,
                    registration:   a.registration,
                    equipment:      a.equipment,
                    typeId:         a.typeId,
                    ageYears:       ageY,
                    maintenancePct: ratio,
                    wearPressure:   wear,
                    score:          score
                },
                applicable:     false,
                applicableNote: ADVISORY_NOTE
            })
        }
        out.sort((a, b) => (b.payload.score || 0) - (a.payload.score || 0))
        return out.slice(0, o.topN)
    }

    /**
     * Determine the airline's family bias from observed fleet. Returns
     *   {dominantFamily, dominantCategory, totalTails}
     * dominantCategory ∈ {commuter, turboprop, regional, narrowbody, widebody}
     */
    function _fleetFamilyBias(fleet) {
        const total = (fleet && fleet.length) || 0
        if (!total) return {dominantFamily: null, dominantCategory: null, totalTails: 0}
        const familyCounts = {}
        const categoryCounts = {commuter: 0, turboprop: 0, regional: 0, narrowbody: 0, widebody: 0}
        for (const a of fleet) {
            if (!a) continue
            const fam = a.family || (a.equipment && a.equipment.split(/\s+/)[0]) || null
            if (fam) familyCounts[fam] = (familyCounts[fam] || 0) + 1
            const seats = _num(a.seats, _num(a.seatCount, NaN))
            if (isFinite(seats)) {
                if (seats < 60) categoryCounts.commuter++
                else if (seats < 100) categoryCounts.regional++
                else if (seats < 200) categoryCounts.narrowbody++
                else categoryCounts.widebody++
            }
        }
        const sortedFam = Object.entries(familyCounts).sort((a, b) => b[1] - a[1])
        const sortedCat = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])
        return {
            dominantFamily:    sortedFam.length ? sortedFam[0][0] : null,
            dominantCategory:  sortedCat.length && sortedCat[0][1] > 0 ? sortedCat[0][0] : null,
            totalTails:        total
        }
    }

    /**
     * Read the most recent used-aircraft-scanner session and extract
     * top-scored offers. The scanner stores results under
     * `usedAircraftScanner:lastResults` (best-effort). Falls back to
     * empty when scanner hasn't run.
     */
    async function _loadScannerOffers() {
        try {
            const got = await chrome.storage.local.get(["usedAircraftScanner:lastResults"])
            const rec = got["usedAircraftScanner:lastResults"]
            if (!rec || !Array.isArray(rec.results)) return []
            return rec.results.slice()
        } catch (_) { return [] }
    }

    async function proposeAcquire(snapshot, opts) {
        const o = Object.assign({}, DEFAULTS.acquire, (opts && opts.acquire) || {})
        const fleet = (snapshot && snapshot.fleet) || []
        const offers = await _loadScannerOffers()
        if (!offers.length) return []
        const bias = _fleetFamilyBias(fleet)
        const candidates = []
        for (const offer of offers) {
            if (!offer) continue
            const score = _num(offer.score, _num(offer.dealScore,
                                                  _num(offer.totalScore, NaN)))
            if (!isFinite(score) || score < o.scoreFloor) continue
            if (o.requireFamilyMatch && bias.dominantCategory && offer.familyCategory) {
                if (offer.familyCategory !== bias.dominantCategory
                        // permit one-step-up acquisitions (regional → narrowbody)
                        // but never two steps (regional → widebody).
                        && !_oneStepUp(bias.dominantCategory, offer.familyCategory)) {
                    continue
                }
            }
            candidates.push({offer: offer, score: score})
        }
        candidates.sort((a, b) => b.score - a.score)
        return candidates.slice(0, o.topN).map(c => {
            const offer = c.offer
            return {
                id:    "fleet-renewal:acquire:"
                       + (offer.id || offer.offerId || (offer.equipment + "-" + offer.priceAS)),
                domain: "fleet-renewal",
                kind:   "acquire",
                title:  "Acquire " + (offer.equipment || offer.typeName || "tail")
                        + " · score " + c.score.toFixed(2),
                subtitle: (offer.familyCategory || "?")
                          + (offer.priceAS != null ? " · AS$ " + Math.round(offer.priceAS).toLocaleString() : ""),
                rationale: [
                    "[type] " + (offer.equipment || offer.typeName || "?")
                        + " · " + (offer.familyCategory || "?"),
                    "[fit] dominant fleet category " + (bias.dominantCategory || "?")
                        + " · totalTails " + bias.totalTails,
                    "[score] " + c.score.toFixed(2) + " ≥ floor " + o.scoreFloor,
                    "[deal] " + ["price", "totalProfitYears", "blockHourCost"]
                        .map(k => offer[k] != null ? k + "=" + offer[k] : null)
                        .filter(Boolean).join(" · ")
                ],
                payload: {
                    offerId:    offer.id || offer.offerId || null,
                    equipment:  offer.equipment || offer.typeName || null,
                    familyCategory: offer.familyCategory || null,
                    priceAS:    offer.priceAS != null ? offer.priceAS : null,
                    score:      c.score,
                    raw:        offer
                },
                applicable:     false,
                applicableNote: ADVISORY_NOTE
            }
        })
    }

    function _oneStepUp(from, to) {
        const order = ["commuter", "turboprop", "regional", "narrowbody", "widebody"]
        const i = order.indexOf(from)
        const j = order.indexOf(to)
        if (i < 0 || j < 0) return false
        return j - i === 1
    }

    /**
     * Convert proposer — placeholder. Disabled in v1; cargo-demand
     * model + per-route cargo profitability source needed first.
     */
    async function proposeConvert(snapshot, opts) {
        const o = Object.assign({}, DEFAULTS.convert, (opts && opts.convert) || {})
        if (!o.enabled) return []
        // v1 stub — no decisions emitted. Intentional: until cargo-demand
        // signal lands, suggesting "convert tail X to cargo" would be
        // pure guesswork.
        return []
    }

    async function proposeAll(snapshot, opts) {
        const [retire, acquire, convert] = await Promise.all([
            proposeRetire(snapshot, opts),
            proposeAcquire(snapshot, opts),
            proposeConvert(snapshot, opts)
        ])
        return [].concat(retire, acquire, convert)
    }

    window.AesStrategyFleetRenewal = {
        proposeRetire:   proposeRetire,
        proposeAcquire:  proposeAcquire,
        proposeConvert:  proposeConvert,
        proposeAll:      proposeAll,
        DEFAULTS:        JSON.parse(JSON.stringify(DEFAULTS)),
        ADVISORY_NOTE:   ADVISORY_NOTE,
        _fleetFamilyBias: _fleetFamilyBias,
        _ageYears:       _ageYears,
        _maintRatio:     _maintRatio,
        _oneStepUp:      _oneStepUp
    }

    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Family-bias smoke
            const bias = _fleetFamilyBias([
                {seats: 180, equipment: "B737"}, {seats: 180, equipment: "B737"},
                {seats: 90, equipment: "ERJ-145"}
            ])
            console.assert(bias.dominantCategory === "narrowbody",
                "[smoke s13] dominantCategory matches majority")
            console.assert(_oneStepUp("regional", "narrowbody"),
                "[smoke s13] regional → narrowbody is one step up")
            console.assert(!_oneStepUp("regional", "widebody"),
                "[smoke s13] regional → widebody is two steps")

            // Retire smoke (no wear data)
            ;(async function () {
                const out = await proposeRetire({
                    fleet: [
                        {aircraftId: "1", equipment: "B737-200", age: 22, maintanance: 60},
                        {aircraftId: "2", equipment: "B787-9",   age: 3,  maintanance: 99}
                    ],
                    server: null
                })
                console.assert(out.length === 1 && out[0].payload.aircraftId === "1",
                    "[smoke s13] only the old high-maint tail surfaces")
            })().catch(e => console.warn("[smoke s13] retire threw", e))
        }
    } catch (_) { /* never let smoke break the page */ }
})()
