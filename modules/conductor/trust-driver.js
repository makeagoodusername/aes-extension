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

    function attach() {
        const b = _bus()
        if (!b || typeof b.on !== "function") return false
        b.on("conductor:outcome:applied", (evt) => { _onOutcomeApplied(evt).catch(() => {}) })
        return true
    }

    window.AesConductorTrustDriver = {attach, _onOutcomeApplied}

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
