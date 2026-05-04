"use strict"

/**
 * AesStrategySnapshotFork — Slice 21 fork primitives.
 *
 * `forkSnapshot(base)` returns a structured-cloned copy of a strategy
 * snapshot with a synthesized forkId + parentRev so consumers can identify
 * forks by id without holding object references. `applyIntervention(fork,
 * intervention)` mutates the fork in-place per the intervention schema in
 * intervention-types.js and returns the fork.
 *
 * Pure transforms only — no I/O, no bus emits. The fork-store handles
 * persistence and the bus topic.
 *
 * The clone is structured-deep enough for the simulator's needs but
 * intentionally drops circular handlers (functions, DOM refs) so the
 * blob is JSON-serializable.
 */
;(function () {
    if (typeof window === "undefined" || window.AesStrategySnapshotFork) return

    let _idCounter = 0
    function _genForkId(rev) {
        _idCounter++
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
        return "F-" + stamp + "-" + _idCounter + "-" + (rev || "x").toString().slice(-6)
    }

    function _safeClone(v) {
        if (typeof structuredClone === "function") {
            try { return structuredClone(v) }
            catch (_) { /* fallthrough */ }
        }
        // JSON fallback — strips functions + DOM, which is exactly what we want.
        try { return JSON.parse(JSON.stringify(v)) }
        catch (_) { return null }
    }

    /** Returns {forkId, parentRev, snapshot, interventions: []}. */
    function forkSnapshot(baseSnapshot, opts) {
        opts = opts || {}
        if (!baseSnapshot || typeof baseSnapshot !== "object") {
            return null
        }
        const cloned = _safeClone(baseSnapshot)
        if (!cloned) return null
        const parentRev = (baseSnapshot.ts && String(baseSnapshot.ts)) || "unknown"
        const forkId = opts.forkId || _genForkId(parentRev)
        return {
            forkId:        forkId,
            parentRev:     parentRev,
            namedAs:       opts.namedAs || forkId,
            createdAt:     Date.now(),
            snapshot:      cloned,
            interventions: [],
            lastResult:    null
        }
    }

    function applyIntervention(fork, intervention) {
        if (!fork || !fork.snapshot) return {ok: false, reason: "no fork"}
        const validate = window.AesStrategyInterventionTypes
            && window.AesStrategyInterventionTypes.validate
        if (validate) {
            const v = validate(intervention)
            if (!v.ok) return v
        }
        const snap = fork.snapshot
        switch (intervention.kind) {
            case "setWeight": {
                snap.weightOverrides = snap.weightOverrides || {}
                snap.weightOverrides[intervention.name] = intervention.value
                break
            }
            case "addAircraft": {
                snap.fleet = Array.isArray(snap.fleet) ? snap.fleet : []
                for (let i = 0; i < intervention.count; i++) {
                    snap.fleet.push({
                        aircraftId:        "fork-" + intervention.typeId + "-" + i,
                        registration:      "FRK" + i,
                        equipment:         intervention.typeId,
                        typeId:            intervention.typeId,
                        age:               0,
                        seats:              0,
                        cargoCapacity:      0,
                        rangeKm:            0,
                        cruiseSpeedKmh:     0,
                        currentLocationIata: intervention.hub || null,
                        status:            "synthetic-fork",
                        wear:              null,
                        profit:            {lifetime: 0, finishedFlights: 0, totalFlights: 0}
                    })
                }
                break
            }
            case "dropRoute": {
                if (Array.isArray(snap.hubs)) {
                    for (const h of snap.hubs) {
                        if (h && h.iata === intervention.hub && Array.isArray(h.byRoute)) {
                            h.byRoute = h.byRoute.filter(r => !r || r.dest !== intervention.dest)
                        }
                    }
                }
                break
            }
            case "flipDna": {
                snap.dnaOverride = snap.dnaOverride || {}
                snap.dnaOverride[intervention.dimension] = intervention.value
                break
            }
            default:
                return {ok: false, reason: "unknown kind: " + intervention.kind}
        }
        fork.interventions.push({
            ...intervention,
            appliedAt: Date.now()
        })
        return {ok: true, fork}
    }

    window.AesStrategySnapshotFork = {forkSnapshot, applyIntervention}
})()
