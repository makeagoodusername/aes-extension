"use strict"

/**
 * CashRunwayDefence — bundled routine that watches for sustained cash
 * outflow at the account level. Singleton per (server, airline) — there's
 * one cash account, so target is the host pair.
 *
 * State machine:
 *   observing  — first CashStep fire seen for this account
 *   proposing  — 2+ negative CashStep fires accumulated within 7 days OR
 *                a single drop ≥ 5M → suggest reviewing capex / pricing
 *   completed  — cash.balance.changed signal with delta ≥ +1M (recovery)
 *   expired    — 30 days no qualifying activity
 *
 * Target shape: `<server>:<airline>` (account key).
 *
 * Why account-singleton: cash is a balance, not a per-resource attribute.
 * One routine per account is the right granularity — it folds every cash
 * move (capex, ops, lease payments, ticket revenue swings) into one
 * narrative. A future K12 risk-dashboard slice will show this routine's
 * state as the cash-runway pillar.
 *
 * Spawn-direction gating: resolveTarget returns null for non-drop CashStep
 * scenarios so spawn doesn't trigger on positive cash steps. Once a
 * routine is active, both directions feed advance() (recovery is what
 * completes it). Signals (cash.balance.changed) always advance regardless
 * of direction.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesConductorRoutines && window.AesConductorRoutines._defs
        && window.AesConductorRoutines._defs.CashRunwayDefence) return

    const PROPOSE_AFTER       = 2                          // negative CashSteps within window
    const PROPOSE_WINDOW_MS   = 7 * 24 * 60 * 60 * 1000
    const SINGLE_BIG_DROP     = 5_000_000                  // AS$ — escalate immediately
    const RECOVERY_DELTA      = 1_000_000                  // AS$ — completes routine
    const EXPIRE_AFTER_MS     = 30 * 24 * 60 * 60 * 1000

    function _accountKey(event) {
        if (!event || !event.server) return null
        return String(event.server) + ":" + String(event.airline || "")
    }

    const def = {
        id:               "CashRunwayDefence",
        label:            "Cash runway defence",
        watchScenarios:   ["CashStep"],
        watchSignalTypes: ["cash.balance.changed"],
        spawnFromScenarioFire: true,

        resolveTarget: (event) => {
            if (!event) return null
            // Scenario events: only return target if direction is a drop, so
            // spawn doesn't trigger on cash rises. Once a routine is active,
            // signal events still advance it for the recovery path.
            if (event.scenarioId === "CashStep") {
                const delta = (event.payload && event.payload.delta)
                if (typeof delta !== "number" || delta >= 0) return null
                return _accountKey(event)
            }
            if (event.type === "cash.balance.changed") {
                return _accountKey(event)
            }
            return null
        },

        initialState: "observing",
        initialScratch: (event) => {
            const p = (event && event.payload) || {}
            const delta = (typeof p.delta === "number") ? p.delta : null
            return {
                dropCount:    delta != null && delta < 0 ? 1 : 0,
                largestDrop:  delta != null && delta < 0 ? Math.abs(delta) : 0,
                firstFireAt:  Date.now(),
                lastFireAt:   Date.now(),
                latestCash:   (typeof p.to === "number") ? p.to : null
            }
        },

        advance: (instance, event, ctx) => {
            const scratch = Object.assign({}, instance.scratch || {})
            const now     = (ctx && ctx.now) || Date.now()
            const p       = (event && event.payload) || {}
            const delta   = (typeof p.delta === "number") ? p.delta : null
            const isScenario = !!event.scenarioId
            const isSignal   = !!event.type && !isScenario

            if (typeof p.to === "number" && isFinite(p.to)) scratch.latestCash = p.to

            // Recovery path — significant positive delta on the underlying signal.
            if (isSignal && delta != null && delta >= RECOVERY_DELTA && instance.state !== "completed") {
                return {
                    state:   "completed",
                    scratch: scratch,
                    reason:  "cash recovered +" + Math.round(delta / 1_000_000) + "M (now ≈"
                        + Math.round((scratch.latestCash || 0) / 1_000_000) + "M)"
                }
            }

            if (instance.state === "observing") {
                if (isScenario && event.scenarioId === "CashStep" && delta != null && delta < 0) {
                    scratch.dropCount  = (scratch.dropCount || 0) + 1
                    scratch.lastFireAt = now
                    const drop = Math.abs(delta)
                    if (drop > (scratch.largestDrop || 0)) scratch.largestDrop = drop
                    const inWindow = (now - (scratch.firstFireAt || now)) <= PROPOSE_WINDOW_MS
                    const escalate = drop >= SINGLE_BIG_DROP || (scratch.dropCount >= PROPOSE_AFTER && inWindow)
                    if (escalate) {
                        return {
                            state:   "proposing",
                            scratch: scratch,
                            reason:  drop >= SINGLE_BIG_DROP
                                ? "single drop of " + Math.round(drop / 1_000_000) + "M — review capex / lease commitments"
                                : scratch.dropCount + " cash drops in 7d — review burn rate"
                        }
                    }
                    return {scratch}
                }
                if ((now - (instance.spawnedAt || now)) > EXPIRE_AFTER_MS) {
                    return {state: "expired", scratch, reason: "no qualifying drops for 30 days"}
                }
                return null
            }

            if (instance.state === "proposing") {
                if (isScenario && event.scenarioId === "CashStep" && delta != null && delta < 0) {
                    scratch.dropCount  = (scratch.dropCount || 0) + 1
                    scratch.lastFireAt = now
                    const drop = Math.abs(delta)
                    if (drop > (scratch.largestDrop || 0)) scratch.largestDrop = drop
                    return {scratch}
                }
                if ((now - (instance.lastEventAt || now)) > EXPIRE_AFTER_MS) {
                    return {state: "expired", scratch, reason: "proposal idle 30 days"}
                }
                return null
            }

            return null
        }
    }

    if (!window.AesConductorRoutines) {
        window.AesConductorRoutines = {
            _defs: {},
            register(d) { if (d && d.id) this._defs[d.id] = d },
            all() { return Object.values(this._defs) }
        }
    }
    window.AesConductorRoutines.register(def)
    window.AesConductorRoutines.CashRunwayDefence = def
})()
