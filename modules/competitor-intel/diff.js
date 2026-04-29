"use strict"

/**
 * Pure-function diff between two competitor snapshots (the projection
 * shape produced by `AesCompetitorSnapshotStore.project`).
 *
 * Returns an array of typed events describing the move from `prev` to
 * `curr`. Each event has:
 *   { type: string,
 *     severity: "info" | "warn" | "critical",
 *     payload:  object  — type-specific fields }
 *
 * Event types:
 *   alliance.changed         — allianceId moved (joined / left / switched)
 *   baseCountry.changed      — base of operations moved
 *   fleet.gained             — one or more new tail counts on existing types
 *   fleet.retired            — one or more tail counts dropped on existing types
 *   fleet.type.added         — entirely new aircraft type acquired
 *   fleet.type.removed       — aircraft type fully retired
 *   fleet.size.changed       — overall aircraftCount delta (when not derivable above)
 *   hub.added                — new hub iata in hubIatas
 *   hub.retreated            — hub iata removed from hubIatas
 *   route.entered            — new (hub,dest) pair in routeKeys
 *   route.exited             — pair removed from routeKeys
 *   employees.changed        — employeeCount delta beyond a noise floor
 *   pax.changed              — paxCarried delta beyond a noise floor
 *   cargo.changed            — cargoCarried delta beyond a noise floor
 *   rating.changed           — financial rating string moved
 *
 * Severity heuristic: structural moves (alliance, baseCountry, fleet type
 * add/remove, hub add/retreat) are warn or critical; numeric drift is info.
 */
class AesCompetitorDiff {
    static EMPLOYEE_NOISE = 0.05
    static PAX_NOISE = 0.05
    static CARGO_NOISE = 0.05

    static compare(prev, curr) {
        if (!curr) return []
        if (!prev) return [{
            type: "competitor.observed",
            severity: "info",
            payload: {
                routeCount: curr.routeCount || 0,
                hubCount:   curr.hubCount   || 0,
                fleetCount: curr.aircraftCount || 0
            }
        }]

        const out = []

        if (prev.allianceId !== curr.allianceId) {
            out.push({
                type: "alliance.changed",
                severity: "warn",
                payload: {
                    prevAllianceId:   prev.allianceId,
                    prevAllianceName: prev.allianceName,
                    currAllianceId:   curr.allianceId,
                    currAllianceName: curr.allianceName,
                    direction: !prev.allianceId ? "joined"
                             : !curr.allianceId ? "left" : "switched"
                }
            })
        }
        if (prev.baseCountryId !== curr.baseCountryId) {
            out.push({
                type: "baseCountry.changed",
                severity: "warn",
                payload: {
                    prev: prev.baseCountryName || prev.baseCountryId,
                    curr: curr.baseCountryName || curr.baseCountryId
                }
            })
        }

        AesCompetitorDiff._fleetEvents(prev, curr, out)
        AesCompetitorDiff._setDiff(prev.hubIatas,  curr.hubIatas,  "hub.added", "hub.retreated", "warn", out, "iata")
        AesCompetitorDiff._setDiff(prev.routeKeys, curr.routeKeys, "route.entered", "route.exited", "info", out, "route")

        AesCompetitorDiff._numericDelta(prev.employeeCount, curr.employeeCount,
            AesCompetitorDiff.EMPLOYEE_NOISE, "employees.changed", out)
        AesCompetitorDiff._numericDelta(prev.paxCarried, curr.paxCarried,
            AesCompetitorDiff.PAX_NOISE, "pax.changed", out)
        AesCompetitorDiff._numericDelta(prev.cargoCarried, curr.cargoCarried,
            AesCompetitorDiff.CARGO_NOISE, "cargo.changed", out)

        if (prev.rating !== curr.rating && (prev.rating || curr.rating)) {
            out.push({
                type: "rating.changed",
                severity: "info",
                payload: {prev: prev.rating, curr: curr.rating}
            })
        }
        return out
    }

    static _fleetEvents(prev, curr, out) {
        const prevByType = AesCompetitorDiff._fleetMap(prev.fleetTypes)
        const currByType = AesCompetitorDiff._fleetMap(curr.fleetTypes)
        const seen = new Set()
        let derivedFleetDelta = 0

        const gained = []
        const retired = []
        const added = []
        const removed = []

        for (const [typeId, p] of prevByType) {
            seen.add(typeId)
            const c = currByType.get(typeId)
            if (!c) {
                removed.push({typeId, typeCode: p.typeCode, count: p.count})
                derivedFleetDelta -= p.count
                continue
            }
            const delta = (c.count || 0) - (p.count || 0)
            if (delta > 0) gained.push({typeId, typeCode: c.typeCode, prev: p.count, curr: c.count, delta})
            else if (delta < 0) retired.push({typeId, typeCode: c.typeCode, prev: p.count, curr: c.count, delta})
            derivedFleetDelta += delta
        }
        for (const [typeId, c] of currByType) {
            if (seen.has(typeId)) continue
            added.push({typeId, typeCode: c.typeCode, count: c.count})
            derivedFleetDelta += c.count
        }

        if (added.length) out.push({type: "fleet.type.added", severity: "warn", payload: {types: added}})
        if (removed.length) out.push({type: "fleet.type.removed", severity: "warn", payload: {types: removed}})
        if (gained.length) out.push({type: "fleet.gained", severity: "info", payload: {types: gained}})
        if (retired.length) out.push({type: "fleet.retired", severity: "info", payload: {types: retired}})

        const reportedFleetCountDelta = (curr.aircraftCount || 0) - (prev.aircraftCount || 0)
        if (reportedFleetCountDelta !== 0
            && Math.abs(reportedFleetCountDelta - derivedFleetDelta) >= 1) {
            out.push({
                type: "fleet.size.changed",
                severity: "info",
                payload: {
                    prev:  prev.aircraftCount,
                    curr:  curr.aircraftCount,
                    delta: reportedFleetCountDelta
                }
            })
        }
    }

    static _fleetMap(fleetTypes) {
        const m = new Map()
        if (!Array.isArray(fleetTypes)) return m
        for (const f of fleetTypes) {
            if (!f || f.typeId == null) continue
            m.set(String(f.typeId), {
                typeCode: f.typeCode || null,
                count:    isFinite(f.count) ? Number(f.count) : 0
            })
        }
        return m
    }

    static _setDiff(prevArr, currArr, addedType, removedType, severity, out, label) {
        const prevSet = new Set(Array.isArray(prevArr) ? prevArr : [])
        const currSet = new Set(Array.isArray(currArr) ? currArr : [])
        const added = []
        const removed = []
        for (const v of currSet) if (!prevSet.has(v)) added.push(v)
        for (const v of prevSet) if (!currSet.has(v)) removed.push(v)
        if (added.length) {
            const payload = {}
            payload[label === "iata" ? "iatas" : "routes"] = added
            out.push({type: addedType, severity, payload})
        }
        if (removed.length) {
            const payload = {}
            payload[label === "iata" ? "iatas" : "routes"] = removed
            out.push({type: removedType, severity, payload})
        }
    }

    static _numericDelta(prevVal, currVal, noiseFloor, type, out) {
        if (!isFinite(prevVal) || !isFinite(currVal)) return
        if (prevVal === currVal) return
        const base = Math.max(Math.abs(prevVal), 1)
        const ratio = Math.abs(currVal - prevVal) / base
        if (ratio < noiseFloor) return
        out.push({
            type, severity: "info",
            payload: {
                prev:  prevVal,
                curr:  currVal,
                delta: currVal - prevVal,
                ratio: Number(ratio.toFixed(3))
            }
        })
    }
}

if (typeof window !== "undefined") {
    window.AesCompetitorDiff = AesCompetitorDiff
}
