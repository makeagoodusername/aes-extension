"use strict"

/**
 * AES Strategy — crew move proposer (Slice 3 + 8).
 *
 * Pure function. Given a snapshot + a fleet plan (per-aircraft legs),
 * computes per-skill flight-hours-required and compares to crew reserve
 * capacity. Proposes hires (when market has supply) or training (when
 * market is dry). v1 only handles pilots; flight-attendants & ground
 * staff land in Slice 8.
 *
 * Slice 8 — pay-tier proposals layered on top of hire/train via
 * AesStrategyPayPerception. The perception model surfaces a *testable
 * hypothesis* (e.g. "raise pay +10pp → +4 recruits/wk over 4wk") rather
 * than a calibrated curve, since per-tier-pay history isn't recorded
 * on the snapshot today. Pay decisions ride alongside hire/train but
 * are flagged advisory by diff-plan until the pay-tier actuator ships
 * — they exist so the user can act on the hypothesis manually and the
 * future LEARN slice can score it against reality.
 *
 * NO POSTs. Slice 4 (`apply()`) routes through
 * CrewMgmtStaffPilotsApplier.hireOrTrain({server, skillId, amount, mode}).
 *
 * Public API:
 *   AesStrategy.proposeCrewMoves(snapshot, fleetPlan, opts?) → CrewMove[]
 *
 * CrewMove shape:
 *   {skillLabel,                        // e.g. "B737"
 *    skillId,                           // numeric AS skill id (passthrough)
 *    typeId,                            // mapped via fleet roster
 *    flightsNeeded,                     // weekly flights this skill must crew
 *    activeNow, reserveNow,             // from CrewMgmtStaffPilotsScraper
 *    action: "hire"|"train"|"raisePay"|"cutPay"|"none",
 *    amount: number,                    // headcount for hire/train, signed pp for pay
 *    rationale: string[],
 *    payHypothesis?: {predictedRecruitDelta, confidence, inputs}}
 */
;(function () {
    if (typeof window === "undefined") return
    const ns = window.AesStrategy || (window.AesStrategy = {})
    if (typeof ns.proposeCrewMoves === "function") return

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _flightsByTypeId(fleetPlan) {
        const out = new Map()
        if (!fleetPlan || !Array.isArray(fleetPlan.perAircraft)) return out
        // Build typeId-by-aircraftId from plan or fallback to caller-provided lookup.
        for (const a of fleetPlan.perAircraft) {
            if (!a || !Array.isArray(a.legs) || a.typeId == null) continue
            const t = Number(a.typeId)
            out.set(t, (out.get(t) || 0) + a.legs.length)
        }
        return out
    }

    function _typeIdToSkillLabel(snapshot, typeId) {
        // The CrewMgmtStaffPilotsScraper keys by skill label like "B737";
        // we approximate by matching the equipment string of any tail of
        // that typeId. Best-effort — Slice 8 introduces a proper mapping
        // table in modules/crew-management/skill-map.js.
        const fleet = (snapshot && snapshot.fleet) || []
        for (const a of fleet) {
            if (a && Number(a.typeId) === Number(typeId) && a.equipment) {
                // Strip trailing variant codes ("Boeing 737-800 BGW" → "737-800")
                const m = String(a.equipment).match(/(\d{3,4})(?:-\d{2,3})?/)
                if (m) return m[0]
                return String(a.equipment).split(/\s+/).pop()
            }
        }
        return null
    }

    function _findCrewSlot(crew, skillLabel) {
        if (!crew || !crew.bySkillLabel || !skillLabel) return null
        // Try exact, then prefix, then contains.
        if (crew.bySkillLabel[skillLabel]) return crew.bySkillLabel[skillLabel]
        const keys = Object.keys(crew.bySkillLabel)
        const exact = keys.find(k => k.toLowerCase() === skillLabel.toLowerCase())
        if (exact) return crew.bySkillLabel[exact]
        const pref  = keys.find(k => k.startsWith(skillLabel) || skillLabel.startsWith(k))
        if (pref)  return crew.bySkillLabel[pref]
        const ctn   = keys.find(k => k.includes(skillLabel) || skillLabel.includes(k))
        return ctn ? crew.bySkillLabel[ctn] : null
    }

    /**
     * Resolve the active objective weights for the network — used by the
     * pay-perception model to decide whether to propose pay cuts under
     * profit-tilted goals. Mirrors the global resolution in price-moves
     * + service-moves so the trio stays consistent.
     */
    function _resolveWeights(snapshot, opts) {
        const O = window.AesStrategyObjective
        const s = (snapshot && snapshot.strategySettings) || {}
        const obj = (opts && opts.objective) || s.objective
            || {kind: "balanced", custom: null}
        if (O && typeof O.resolve === "function") {
            return O.resolve(obj.kind, obj.custom, null)
        }
        return {kind: obj.kind || "balanced",
                weights: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}}
    }

    /**
     * Pay-perception consultation. Returns null when the model isn't
     * loaded (defensive — manifest order keeps this rare) or when the
     * skill slot is absent. Otherwise returns the perception envelope so
     * the caller can decide whether to emit a pay move alongside the
     * hire/train decision.
     */
    function _consultPayPerception(slot, weights, opts) {
        const ns = window.AesStrategyPayPerception
        if (!ns || typeof ns.evaluate !== "function") return null
        if (!slot) return null
        const o = (opts && opts.payPerception) || {}
        return ns.evaluate({skillSlot: slot, weights: weights, opts: o})
    }

    function proposeCrewMoves(snapshot, fleetPlan, opts) {
        const o = opts || {}
        const safetyBuffer = _num(o.reserveBuffer, 0.10)   // hire 10% above need
        const out = []
        if (!snapshot || !fleetPlan) return out

        const flightsByType = _flightsByTypeId(fleetPlan)
        const crew = snapshot.crew
        const resolved = _resolveWeights(snapshot, o)

        for (const [typeId, flights] of flightsByType.entries()) {
            const skillLabel = _typeIdToSkillLabel(snapshot, typeId)
            const slot = _findCrewSlot(crew, skillLabel)
            const activeNow  = slot ? _num(slot.active,  null) : null
            const reserveNow = slot ? _num(slot.reserve, null) : null
            const market     = slot ? _num(slot.marketAvailable, 0) : 0
            const skillId    = slot ? slot.skillId : null

            const needed = Math.ceil(flights * (1 + safetyBuffer))
            const haveActive = activeNow != null ? activeNow : 0
            const shortfall = Math.max(0, needed - haveActive)
            const rationale = []
            rationale.push("[plan] " + flights + " weekly flights for type " + typeId
                         + " (label " + (skillLabel || "?") + ")")
            rationale.push("[crew] active " + (activeNow != null ? activeNow : "?")
                         + " · reserve " + (reserveNow != null ? reserveNow : "?")
                         + " · market " + market)

            if (!slot) {
                rationale.push("[gap] no crew snapshot for this skill — visit the staff page to populate")
                out.push({
                    skillLabel, skillId, typeId,
                    flightsNeeded: flights,
                    activeNow, reserveNow,
                    action: "none", amount: 0,
                    rationale
                })
                continue
            }

            if (shortfall > 0) {
                const action = market >= shortfall ? "hire" : "train"
                const amount = action === "hire"
                    ? shortfall
                    : Math.max(shortfall - market, 1)
                rationale.push("[move] " + action + " " + amount
                             + " (shortfall " + shortfall + ", market " + market + ")")
                out.push({
                    skillLabel, skillId, typeId,
                    flightsNeeded: flights,
                    activeNow, reserveNow,
                    action, amount,
                    rationale
                })
            } else {
                rationale.push("[ok] no hire/train action needed")
                out.push({
                    skillLabel, skillId, typeId,
                    flightsNeeded: flights,
                    activeNow, reserveNow,
                    action: "none", amount: 0,
                    rationale
                })
            }

            // Slice 8 — pay perception runs in parallel with hire/train
            // so a chronic missing pulse + a successful raise hypothesis
            // don't suppress each other. Emitted as a separate move so
            // diff-plan can flag pay as advisory until the actuator ships.
            const perception = _consultPayPerception(slot, resolved.weights, o)
            if (perception && perception.action !== "hold") {
                const payRationale = [
                    "[pay] " + perception.action + " " + perception.amountPp + "pp · confidence "
                        + perception.confidence + " · goal " + resolved.kind,
                    perception.hypothesis,
                    "[advisory] pay-tier actuator not yet implemented — apply manually on the staff page"
                ]
                out.push({
                    skillLabel, skillId, typeId,
                    flightsNeeded: flights,
                    activeNow, reserveNow,
                    action:        perception.action,
                    amount:        perception.amountPp,
                    rationale:     payRationale,
                    payHypothesis: {
                        predictedRecruitDelta: perception.predictedRecruitDelta,
                        confidence:            perception.confidence,
                        inputs:                perception.inputs
                    }
                })
            }
        }

        return out
    }

    ns.proposeCrewMoves = proposeCrewMoves

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Snapshot with two type-skill mappings:
            //   B737 — chronic missing + dry market → expect train + raisePay
            //   A320 — overstaffed reserve, profit-tilted → expect cutPay only
            const snap = {
                fleet: [
                    {typeId: 100, equipment: "Boeing 737-800"},
                    {typeId: 200, equipment: "Airbus A320-200"}
                ],
                crew: {bySkillLabel: {
                    "737-800": {skillId: 12, active: 8,  reserve: 1,  required: 12,
                                missing: 4, marketAvailable: 0},
                    "320-200": {skillId: 13, active: 10, reserve: 18, required: 8,
                                missing: 0, marketAvailable: 5}
                }},
                strategySettings: {objective: {kind: "maxProfit"}}
            }
            const plan = {perAircraft: [
                {typeId: 100, legs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]},
                {typeId: 200, legs: [1, 2, 3]}
            ]}
            const moves = proposeCrewMoves(snap, plan)
            const byActionFor = (label) => moves.filter(m => m.skillLabel === label)
                .map(m => m.action)

            const b737 = byActionFor("737-800")
            console.assert(b737.indexOf("raisePay") >= 0,
                "[smoke crew] B737 dry market + missing → raisePay surfaces")
            console.assert(b737.indexOf("hire") >= 0 || b737.indexOf("train") >= 0,
                "[smoke crew] B737 also gets hire-or-train")

            const a320 = byActionFor("320-200")
            console.assert(a320.indexOf("cutPay") >= 0,
                "[smoke crew] A320 overstaff + profit-tilt → cutPay surfaces")
            console.assert(a320.indexOf("hire") < 0 && a320.indexOf("train") < 0,
                "[smoke crew] A320 has no hire/train (no shortfall)")

            const payMove = moves.find(m => m.action === "raisePay")
            console.assert(payMove && payMove.payHypothesis
                && payMove.payHypothesis.predictedRecruitDelta != null,
                "[smoke crew] raisePay carries testable hypothesis envelope")
            console.assert(payMove && /pay-tier actuator not yet implemented/.test(payMove.rationale.join(" ")),
                "[smoke crew] pay rationale flags missing actuator")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
