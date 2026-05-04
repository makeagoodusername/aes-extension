"use strict"

/**
 * AesConductorTrustDriver — K11 bus subscriber.
 *
 * Listens for `conductor:outcome:applied` (the K10 emit point) and feeds
 * each terminal verdict into AesConductorTrustStore. Idempotent on fireId
 * via a TTL ring so an evaluator that re-fires the same `outcome.terminal`
 * verdict doesn't double-count the observation.
 *
 * Bus emits after every successful trust mutation:
 *   data:conductor:trust:updated  {scenarioId, tq, lcb, tier, n}
 *   signal:conductor:tier:promoted {scenarioId, fromTier, toTier, reason}
 *   data:conductor:trust:decayed  {scenarioId, fromTier, toTier, halfLifeWeeks}
 *
 * K11.1 decay: a daily sweep walks the persisted blob, applies the decay
 * helper, persists the decayed entry, and emits `:decayed` when a tier
 * actually changed. Without this sweep the decay still reaches readers (load/
 * get apply it lazily) but the persisted blob would lag. The sweep keeps
 * downstream consumers (tile, briefing, K9 attention) coherent without
 * forcing them to re-decay on every render.
 *
 * Storage:
 *   aesConductor:trustSeen:<server>:<airline>  → string[]   // last 200 fireIds
 *
 * Self-installs at load time. Idempotent re-load via window guard.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorTrustDriver) return

    const SEEN_PREFIX = "aesConductor:trustSeen:"
    const SEEN_CAP    = 200

    function _bus() {
        return (typeof window !== "undefined" && window.CentralHubBus) || null
    }

    function _seenKey(host) {
        if (!host || !host.server) return null
        return SEEN_PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    async function _readSeen(key) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return []
        try {
            const blob = await chrome.storage.local.get([key])
            const arr = blob && blob[key]
            return Array.isArray(arr) ? arr : []
        } catch (_) { return [] }
    }

    async function _writeSeen(key, arr) {
        try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
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
        if (!airline && AES.getAirlineIdentity) {
            try { airline = AES.getAirlineIdentity() || "" } catch (_) { airline = "" }
        }
        return {server, airline}
    }

    /** Single in-flight queue so concurrent bus events don't race on the
     *  shared seen-ring read-modify-write. */
    let _q = Promise.resolve()
    function _serial(fn) { _q = _q.then(fn).catch(() => {}); return _q }

    async function _onOutcomeApplied(evt) {
        if (!evt || !evt.fireId || !evt.scenarioId || !evt.outcome) return
        const o = evt.outcome
        if (!o.terminal) return                                  // only terminal verdicts feed trust
        if (o.favourable !== true && o.favourable !== false) return
        const host = _resolveHost()
        if (!host) return
        const seenKey = _seenKey(host)
        if (!seenKey) return
        const store = window.AesConductorTrustStore
        if (!store || typeof store.record !== "function") return

        await _serial(async () => {
            const seen = await _readSeen(seenKey)
            if (seen.indexOf(evt.fireId) >= 0) return            // already counted
            const prevEntry = await store.get(host, evt.scenarioId)
            const prevTier = prevEntry && prevEntry.tier
            const next = await store.record(host, evt.scenarioId, o.favourable === true)
            seen.push(evt.fireId)
            if (seen.length > SEEN_CAP) seen.splice(0, seen.length - SEEN_CAP)
            await _writeSeen(seenKey, seen)

            const b = _bus()
            if (b && typeof b.emit === "function" && next) {
                try {
                    b.emit("data:conductor:trust:updated", {
                        scenarioId: evt.scenarioId,
                        tq:   next.tq,
                        lcb:  next.lcb,
                        tier: next.tier,
                        n:    next.n
                    })
                    if (prevTier && prevTier !== next.tier) {
                        b.emit("signal:conductor:tier:promoted", {
                            scenarioId: evt.scenarioId,
                            fromTier:   prevTier,
                            toTier:     next.tier,
                            reason: "TQ=" + next.tq.toFixed(2)
                                + " LCB=" + next.lcb.toFixed(2)
                                + " (n=" + next.n + ")"
                        })
                    }
                } catch (_) { /* noop */ }
            }
        })
    }

    /** K11.1 — sweep the persisted trust blob, apply decay, write back tier
     *  changes, and emit `data:conductor:trust:decayed` per scenario whose
     *  tier moved. Defensive: no-op when host can't be resolved or store is
     *  unavailable. Runs at most once per `SWEEP_MIN_INTERVAL_MS`. */
    const DECAY_KEY_PREFIX = "aesConductor:trust:"
    const DECAY_LAST_KEY   = "aesConductor:trustDecaySweptAt"
    const SWEEP_MIN_INTERVAL_MS = 6 * 3600 * 1000   // every 6h is dense enough for a 16-week half-life

    async function _sweepDecay() {
        if (typeof chrome === "undefined" || !chrome.storage) return {swept: 0}
        const host = _resolveHost()
        const store = window.AesConductorTrustStore
        if (!host || !store || typeof store._decayPosterior !== "function") return {swept: 0}
        const blobKey = DECAY_KEY_PREFIX + String(host.server) + ":" + String(host.airline || "")
        try {
            const ck = await chrome.storage.local.get([blobKey, DECAY_LAST_KEY])
            const lastSwept = (ck && typeof ck[DECAY_LAST_KEY] === "number") ? ck[DECAY_LAST_KEY] : 0
            const now = Date.now()
            if (now - lastSwept < SWEEP_MIN_INTERVAL_MS) return {swept: 0, skipped: true}
            const blob = (ck && ck[blobKey] && typeof ck[blobKey] === "object") ? ck[blobKey] : null
            if (!blob) {
                await chrome.storage.local.set({[DECAY_LAST_KEY]: now})
                return {swept: 0}
            }
            const halfLifeWeeks = store.DEFAULT_HALF_LIFE_WEEKS
            const transitions = []
            let mutated = false
            for (const sid of Object.keys(blob)) {
                const prev = blob[sid]
                if (!prev || typeof prev !== "object") continue
                const decayed = store._decayPosterior(prev, now, halfLifeWeeks)
                if (!decayed || decayed === prev) continue
                if (decayed.tier !== prev.tier
                    || Math.abs((decayed.alpha || 0) - (prev.alpha || 0)) > 0.01
                    || Math.abs((decayed.beta  || 0) - (prev.beta  || 0)) > 0.01) {
                    blob[sid] = decayed
                    mutated = true
                    if (decayed.tier !== prev.tier) {
                        transitions.push({scenarioId: sid, fromTier: prev.tier, toTier: decayed.tier})
                    }
                }
            }
            if (mutated) await chrome.storage.local.set({[blobKey]: blob, [DECAY_LAST_KEY]: now})
            else         await chrome.storage.local.set({[DECAY_LAST_KEY]: now})
            const b = _bus()
            if (b && typeof b.emit === "function") {
                for (const t of transitions) {
                    try {
                        b.emit("data:conductor:trust:decayed", {
                            scenarioId:    t.scenarioId,
                            fromTier:      t.fromTier,
                            toTier:        t.toTier,
                            halfLifeWeeks: halfLifeWeeks
                        })
                    } catch (_) { /* noop */ }
                }
            }
            return {swept: transitions.length}
        } catch (_) { return {swept: 0} }
    }

    function attach() {
        const b = _bus()
        if (!b || typeof b.on !== "function") return false
        b.on("conductor:outcome:applied", (evt) => { _onOutcomeApplied(evt).catch(() => {}) })
        // Opportunistic decay sweep — piggy-backs on the existing baseline tick
        // (24h) so we don't add another chrome.alarms entry. Also runs once
        // shortly after attach so a fresh page load reflects elapsed decay.
        b.on("signal:conductor:baseline:tick", () => { _sweepDecay().catch(() => {}) })
        setTimeout(() => { _sweepDecay().catch(() => {}) }, 30_000)
        return true
    }

    window.AesConductorTrustDriver = {attach, _onOutcomeApplied, _sweepDecay}

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
