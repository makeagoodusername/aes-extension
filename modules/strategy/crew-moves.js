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
 *    action: "hire"|"train"|"none",
 *    amount: number,
 *    rationale: string[]}
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

    function proposeCrewMoves(snapshot, fleetPlan, opts) {
        const o = opts || {}
        const safetyBuffer = _num(o.reserveBuffer, 0.10)   // hire 10% above need
        const out = []
        if (!snapshot || !fleetPlan) return out

        const flightsByType = _flightsByTypeId(fleetPlan)
        const crew = snapshot.crew

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

            if (shortfall <= 0) {
                rationale.push("[ok] no crew action needed")
                out.push({
                    skillLabel, skillId, typeId,
                    flightsNeeded: flights,
                    activeNow, reserveNow,
                    action: "none", amount: 0,
                    rationale
                })
                continue
            }

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
        }

        return out
    }

    ns.proposeCrewMoves = proposeCrewMoves
})()
