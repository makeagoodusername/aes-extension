"use strict"

/**
 * AesConductorDriftDriver — K14 driver.
 *
 * Subscribes to `conductor:outcome:applied`, pulls the K10 verdict's
 * expectedDelta + observedDelta, feeds the residual into the per-(account,
 * scenarioId) CUSUM detector, and on a `tripped-*` transition:
 *   1. emits `signal:conductor:drift {scenarioId, polarity, magnitude}`
 *   2. writes a threshold-patch proposal record (capped 30 per account)
 *   3. clamps the K11 tier ceiling for that scenario by one notch
 *
 * On a `cleared` transition:
 *   - emits a follow-up signal:conductor:drift with `{cleared:true}`
 *   - clears the K11 ceiling clamp
 *
 * Idempotent on outcome.terminal=false (only terminal verdicts feed
 * residuals — non-terminal updates would re-count the same divergence).
 *
 * Storage:
 *   aesConductor:drift:<server>:<airline>          → {scenarioId: detectorState}
 *   aesConductor:driftProposals:<server>:<airline> → Proposal[]   (cap 30)
 *
 * Proposal:
 *   {
 *     id:         "<scenarioId>-<at>",
 *     scenarioId: string,
 *     key:        string,            // threshold key per scenario (e.g. "PROFIT_DECAY_PCT")
 *     current:    number,
 *     proposed:   number,
 *     polarity:   "pos" | "neg",
 *     magnitude:  number,
 *     reason:     string,
 *     createdAt:  number,
 *     accepted:   boolean
 *   }
 *
 * Threshold-patch heuristic (per-scenario):
 *   - polarity:"pos" (over-fires) → loosen threshold by 25%
 *   - polarity:"neg" (under-fires) → tighten by 25%
 * Bounded to ±50% of shipped default. Conservative, easy to read in tile.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorDriftDriver) return

    const STATE_PREFIX     = "aesConductor:drift:"
    const PROPOSAL_PREFIX  = "aesConductor:driftProposals:"
    const PROPOSAL_CAP     = 30

    /** Per-scenario residual stream → threshold patch heuristic. Each entry
     *  describes which threshold to nudge and the shipped default we patch
     *  relative to. The keys here are arbitrary strings the threshold-store
     *  resolver pulls back via resolveThreshold(scenarioId, key, default).
     *  scenarios.js calls resolveThreshold by these same keys. */
    const PATCH_RECIPES = {
        ProfitDecay:     {key: "PROFIT_DECAY_PCT",   shippedDefault: 0.25, minPct: 0.10, maxPct: 0.50},
        ProfitRecovery:  {key: "PROFIT_RECOVER_PCT", shippedDefault: 0.25, minPct: 0.10, maxPct: 0.50},
        OrsRegression:   {key: "ORS_RANK_DROP_MIN",  shippedDefault: 2,    minPct: 1,    maxPct: 5},
        OrsRecovery:     {key: "ORS_RANK_DROP_MIN",  shippedDefault: 2,    minPct: 1,    maxPct: 5},
        MaintenanceWatch:{key: "RATIO_FLOOR",        shippedDefault: 105,  minPct: 95,   maxPct: 115},
        ConditionWatch:  {key: "CONDITION_FLOOR",    shippedDefault: 60,   minPct: 50,   maxPct: 75}
    }

    function _bus() { return (typeof window !== "undefined" && window.CentralHubBus) || null }

    function _stateKey(host) {
        if (!host || !host.server) return null
        return STATE_PREFIX + String(host.server) + ":" + String(host.airline || "")
    }
    function _proposalKey(host) {
        if (!host || !host.server) return null
        return PROPOSAL_PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    async function _read(key, fallback) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return fallback
        try {
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return (v != null) ? v : fallback
        } catch (_) { return fallback }
    }
    async function _write(key, val) {
        try { await chrome.storage.local.set({[key]: val}) } catch (_) { /* noop */ }
    }

    function _resolveHost() {
        if (typeof AES === "undefined") return null
        let server = ""
        try { server = AES.getServerName ? (AES.getServerName() || "") : "" } catch (_) { server = "" }
        if (!server) return null
        let airline = ""
        try {
            const code = AES.getAirlineCode ? AES.getAirlineCode() : null
            airline = (code && code.code) ? code.code : ""
        } catch (_) { airline = "" }
        return {server, airline}
    }

    /** Compute the proposed threshold value given the recipe + current
     *  drift polarity. The detector's `magnitude` could refine the size of
     *  the nudge but in v1 we use a fixed 25% step for readability. */
    function _proposeValue(recipe, current, polarity) {
        const base = (typeof current === "number" && isFinite(current)) ? current : recipe.shippedDefault
        const step = base * 0.25
        let next = (polarity === "pos") ? (base + step) : (base - step)
        if (next < recipe.minPct) next = recipe.minPct
        if (next > recipe.maxPct) next = recipe.maxPct
        return next
    }

    let _q = Promise.resolve()
    function _serial(fn) { _q = _q.then(fn).catch(() => {}); return _q }

    async function _onOutcomeApplied(evt) {
        if (!evt || !evt.scenarioId || !evt.outcome) return
        const o = evt.outcome
        if (!o.terminal) return
        if (typeof o.observedDelta !== "number" || !isFinite(o.observedDelta)) return
        if (typeof o.expectedDelta !== "number" || !isFinite(o.expectedDelta)) return
        const host = _resolveHost()
        if (!host) return
        const detector = window.AesConductorDriftDetector
        if (!detector || typeof detector.update !== "function") return

        await _serial(async () => {
            const stateKey = _stateKey(host)
            if (!stateKey) return
            const all = await _read(stateKey, {})
            const prev = all[evt.scenarioId] || detector.emptyState()
            const residual = o.observedDelta - o.expectedDelta
            const {next, transition} = detector.update(prev, residual)
            all[evt.scenarioId] = next
            await _write(stateKey, all)
            if (!transition) return

            // Trip / clear handling
            const recipe = PATCH_RECIPES[evt.scenarioId]
            const b = _bus()

            if (transition === "tripped-pos" || transition === "tripped-neg") {
                const polarity = (transition === "tripped-pos") ? "pos" : "neg"

                if (recipe) {
                    const proposalKey = _proposalKey(host)
                    const proposals = (await _read(proposalKey, [])) || []
                    const ts = window.AesConductorThresholdStore
                    const current = ts && typeof ts.resolve === "function"
                        ? await ts.resolve(host, evt.scenarioId, recipe.key, recipe.shippedDefault)
                        : recipe.shippedDefault
                    const proposed = _proposeValue(recipe, current, polarity)
                    const proposal = {
                        id:         evt.scenarioId + "-" + Date.now(),
                        scenarioId: evt.scenarioId,
                        key:        recipe.key,
                        current:    current,
                        proposed:   proposed,
                        polarity:   polarity,
                        magnitude:  next.magnitude,
                        reason:     "Residual cusum tripped " + polarity + " (mag=" + next.magnitude.toFixed(2) + ")",
                        createdAt:  Date.now(),
                        accepted:   false
                    }
                    proposals.push(proposal)
                    if (proposals.length > PROPOSAL_CAP) proposals.splice(0, proposals.length - PROPOSAL_CAP)
                    await _write(proposalKey, proposals)
                    if (b && typeof b.emit === "function") {
                        try { b.emit("data:conductor:drift:proposal:created", proposal) } catch (_) { /* noop */ }
                    }
                }

                // Clamp K11 tier ceiling — pos polarity demotes one notch,
                // neg polarity demotes harder (under-firing is more serious
                // since the engine misses real conditions).
                const trust = window.AesConductorTrustStore
                if (trust && typeof trust.setCeiling === "function" && trust.TIER_ORDER) {
                    const cur = await trust.get(host, evt.scenarioId)
                    const order = trust.TIER_ORDER
                    const curIdx = order.indexOf(cur && cur.tier || "alert")
                    let demoteTo = "alert"
                    if (polarity === "pos") {
                        const target = Math.max(0, curIdx - 1)
                        demoteTo = order[target]
                    } else {
                        demoteTo = "alert"
                    }
                    await trust.setCeiling(host, evt.scenarioId, demoteTo)
                }

                if (b && typeof b.emit === "function") {
                    try {
                        b.emit("signal:conductor:drift", {
                            scenarioId: evt.scenarioId,
                            polarity:   polarity,
                            magnitude:  next.magnitude,
                            cleared:    false
                        })
                    } catch (_) { /* noop */ }
                }
            }

            if (transition === "cleared") {
                // Drop ceiling clamp + emit clear signal
                const trust = window.AesConductorTrustStore
                if (trust && typeof trust.setCeiling === "function") {
                    await trust.setCeiling(host, evt.scenarioId, null)
                }
                if (b && typeof b.emit === "function") {
                    try {
                        b.emit("signal:conductor:drift", {
                            scenarioId: evt.scenarioId,
                            polarity:   null,
                            magnitude:  0,
                            cleared:    true
                        })
                    } catch (_) { /* noop */ }
                }
            }
        })
    }

    function attach() {
        const b = _bus()
        if (!b || typeof b.on !== "function") return false
        b.on("conductor:outcome:applied", (evt) => { _onOutcomeApplied(evt).catch(() => {}) })
        return true
    }

    window.AesConductorDriftDriver = {attach, _onOutcomeApplied, PATCH_RECIPES}

    if (!attach()) {
        let tries = 0
        const poll = () => {
            tries++
            if (attach()) return
            if (tries < 120) requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
    }
})()
