"use strict"

/**
 * AesConductorRoutineEngine — runs routine state machines.
 *
 * A routine definition exposes:
 *   {
 *     id:             "MaintenanceRebalance",
 *     label:          "Maintenance rebalance",
 *     watchScenarios: ["MaintenanceWatch"],
 *     watchSignalTypes: ["maintenance.ratio.changed"],   // optional
 *     resolveTarget:  (event) => "<targetId>" | null,
 *     initialState:   "observing",
 *     spawnFromScenarioFire: true,
 *     advance:        (instance, event, ctx) => ({state, scratch?, reason?}) | null
 *   }
 *
 * The engine subscribes to conductor:scenario and conductor:signal. On
 * each event:
 *   1. For each active routine instance whose def matches, call advance()
 *      and persist any state change.
 *   2. For routines that opt into spawning (spawnFromScenarioFire) and
 *      have no active instance for the resolved target, spawn one.
 *
 * Storage cap is enforced by AesConductorRoutineStore. Bus dispatch:
 *   conductor:routine:spawned     {instance}
 *   conductor:routine:transition  {instance, from, to, reason}
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorRoutineEngine) return

    let _counter = 0
    function _instanceId(spawnedAt) { return String(spawnedAt) + "-" + (++_counter) }

    function _registry() {
        if (typeof window.AesConductorRoutines === "undefined") return []
        try { return window.AesConductorRoutines.all() || [] }
        catch (_) { return [] }
    }

    function _matchingDefs(event, kind) {
        const defs = _registry()
        const out = []
        for (const def of defs) {
            if (!def) continue
            if (kind === "scenario") {
                const list = def.watchScenarios || []
                if (list.indexOf(event.scenarioId) >= 0) out.push(def)
            } else if (kind === "signal") {
                const list = def.watchSignalTypes || []
                if (list.indexOf(event.type) >= 0) out.push(def)
            }
        }
        return out
    }

    async function _spawn(def, event, host) {
        if (!def.spawnFromScenarioFire) return null
        const target = (typeof def.resolveTarget === "function") ? def.resolveTarget(event) : null
        if (!target) return null
        const existing = await window.AesConductorRoutineStore.findActive(host, def.id, target)
        if (existing) return existing
        const spawnedAt = Date.now()
        const instance = {
            instanceId:    _instanceId(spawnedAt),
            routineDefId:  def.id,
            label:         def.label || def.id,
            target:        String(target),
            state:         def.initialState || "observing",
            spawnedAt:     spawnedAt,
            lastEventAt:   spawnedAt,
            completedAt:   null,
            history:       [{at: spawnedAt, from: null, to: def.initialState || "observing", reason: "spawned by " + (event.scenarioId || event.type)}],
            scratch:       (typeof def.initialScratch === "function") ? (def.initialScratch(event) || {}) : {}
        }
        await window.AesConductorRoutineStore.append(host, instance)
        try {
            if (window.CentralHubBus) window.CentralHubBus.emit("conductor:routine:spawned", instance)
        } catch (_) { /* noop */ }
        return instance
    }

    /** K4 — resolve a (resourceType, resourceId) for a routine instance from
     *  the def's `resourceType` declaration. Returns null when the routine
     *  doesn't opt into locks. Resource id defaults to instance.target;
     *  account-singleton routines override to `<server>:<airline>`. */
    function _lockSpec(def, instance, host) {
        if (!def || !def.resourceType) return null
        const resType = String(def.resourceType)
        let resId = instance && instance.target
        if (resType === "account") {
            resId = String(host.server) + ":" + String(host.airline || "")
        }
        if (!resId) return null
        return {resType, resId}
    }

    async function _step(def, instance, event, host) {
        if (typeof def.advance !== "function") return
        let result
        try { result = def.advance(instance, event, {now: Date.now()}) }
        catch (e) { console.warn("[AES Conductor] routine advance threw", def.id, e); return }
        if (!result) return
        const nextState = result.state
        if (!nextState || nextState === instance.state) {
            if (result.scratch) {
                instance.scratch = Object.assign({}, instance.scratch || {}, result.scratch)
                instance.lastEventAt = Date.now()
                await window.AesConductorRoutineStore.update(host, instance)
            }
            return
        }
        const transitionedAt = Date.now()
        const from = instance.state
        instance.state = nextState
        instance.lastEventAt = transitionedAt
        if (result.scratch) instance.scratch = Object.assign({}, instance.scratch || {}, result.scratch)
        if (nextState === "completed" || nextState === "expired") {
            instance.completedAt = transitionedAt
        }
        instance.history = (instance.history || []).concat([{
            at:     transitionedAt,
            from:   from,
            to:     nextState,
            reason: String(result.reason || "")
        }])
        if (instance.history.length > 20) instance.history = instance.history.slice(-20)
        await window.AesConductorRoutineStore.update(host, instance)

        // K4 — acquire lock on enter `proposing`; release on `completed`/`expired`.
        const ls = window.AesConductorLockStore
        const spec = _lockSpec(def, instance, host)
        if (ls && spec) {
            try {
                if (nextState === "proposing" && from !== "proposing") {
                    await ls.acquire(host, spec.resType, spec.resId, def.id, {
                        reason: result.reason || "",
                        ttlMs:  (typeof def.lockTtlMs === "number" && def.lockTtlMs > 0)
                            ? def.lockTtlMs : undefined
                    })
                } else if ((nextState === "completed" || nextState === "expired") && from !== nextState) {
                    await ls.release(host, spec.resType, spec.resId, def.id, {
                        reason: nextState === "completed" ? "owner" : "manual"
                    })
                }
            } catch (_) { /* noop */ }
        }

        try {
            if (window.CentralHubBus) {
                window.CentralHubBus.emit("conductor:routine:transition", {
                    instance, from, to: nextState, reason: result.reason || ""
                })
            }
        } catch (_) { /* noop */ }
    }

    async function _onEvent(event, kind) {
        if (!event) return
        const host = {server: event.server, airline: event.airline}
        if (!host.server) return

        const defs = _matchingDefs(event, kind)
        const active = await window.AesConductorRoutineStore.active(host)

        for (const def of defs) {
            const target = (typeof def.resolveTarget === "function") ? def.resolveTarget(event) : null
            if (target) {
                const matching = active.filter(i => i.routineDefId === def.id && i.target === String(target))
                for (const inst of matching) await _step(def, inst, event, host)
                if (kind === "scenario" && def.spawnFromScenarioFire && !matching.length) {
                    await _spawn(def, event, host)
                }
            }
        }
    }

    if (typeof window.CentralHubBus !== "undefined" && typeof window.CentralHubBus.on === "function") {
        window.CentralHubBus.on("conductor:scenario", (e) => _onEvent(e, "scenario").catch(() => {}))
        window.CentralHubBus.on("conductor:signal",   (e) => _onEvent(e, "signal").catch(() => {}))
    }

    window.AesConductorRoutineEngine = {evaluate: _onEvent}
})()
