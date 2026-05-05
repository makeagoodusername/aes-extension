"use strict"

/**
 * AesConductorAttention — K9 attention scorer for Conductor scenario fires.
 *
 * Pure function. Replaces the severity-bucket sort in conductor-tile and the
 * sevWeight sort in briefing's risk-register. Output is unbounded; only
 * relative ordering matters.
 *
 *   score = severityWeight × trustFactor × recencyDecay × pinBonus × snoozeMul
 *
 *   severityWeight: alert=3, warn=2, info=1
 *   trustFactor:    1 + entry.lcb (range [1,2]); default 1.5 when no entry
 *                   (neutral prior; matches Beta(2,2) tq=0.5 + small headroom)
 *   recencyDecay:   exp(-Δt / halfLife) with halfLife = 6h (21_600_000 ms)
 *   pinBonus:       2.0 when settings.fireUx[fireId].pinned, else 1.0
 *   snoozeMul:      0 when settings.fireUx[fireId].snoozedUntil > now, else 1
 *
 * Storage shape consumed (Class C, sparse, written by conductor-tile):
 *   aesConductor:settings:<server>:<airline>.fireUx[<fireId>] = {
 *     pinned?:        boolean,
 *     snoozedUntil?:  number          // epoch ms
 *   }
 *
 * No I/O — caller must prefetch trust + settings once per render.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorAttention) return

    const SEVERITY_WEIGHT = {alert: 3, warn: 2, info: 1}
    const HALF_LIFE_MS    = 6 * 3600 * 1000
    const PIN_BONUS       = 2.0
    const NEUTRAL_TRUST   = 1.5

    function _severityWeight(s) {
        const w = SEVERITY_WEIGHT[s]
        return (typeof w === "number") ? w : 1
    }

    function _trustFactor(entry) {
        if (!entry || typeof entry.lcb !== "number" || !isFinite(entry.lcb)) return NEUTRAL_TRUST
        const lcb = Math.max(0, Math.min(1, entry.lcb))
        return 1 + lcb
    }

    function _recencyDecay(firedAt, now) {
        const t = (typeof firedAt === "number" && isFinite(firedAt)) ? firedAt : 0
        const dt = Math.max(0, (now || Date.now()) - t)
        return Math.exp(-dt / HALF_LIFE_MS)
    }

    function _readUx(settings, fireId) {
        if (!settings || !fireId) return null
        const ux = settings.fireUx
        if (!ux || typeof ux !== "object") return null
        return ux[fireId] || null
    }

    /** Pure score — high is "more attention". */
    function score(fire, trustEntry, settings, now) {
        if (!fire) return 0
        const t = (typeof now === "number" && isFinite(now)) ? now : Date.now()
        const ux = _readUx(settings, fire.id)
        if (ux && typeof ux.snoozedUntil === "number" && ux.snoozedUntil > t) return 0
        const sev = _severityWeight(fire.severity)
        const trust = _trustFactor(trustEntry)
        const recency = _recencyDecay(fire.firedAt, t)
        const pin = (ux && ux.pinned) ? PIN_BONUS : 1.0
        return sev * trust * recency * pin
    }

    /** Sort fires in-place-safe: returns a NEW array sorted high-score first.
     *  `trustByScenario` is a {scenarioId: trustEntry} map (e.g. result of
     *  `AesConductorTrustStore.load(host)`); pass `{}` if absent.
     *  `settings` is the parsed `aesConductor:settings:<…>` blob. */
    function sortFires(fires, trustByScenario, settings, now) {
        const list = Array.isArray(fires) ? fires.slice() : []
        const t = (typeof now === "number" && isFinite(now)) ? now : Date.now()
        const tMap = trustByScenario || {}
        const cache = new Map()
        const _scoreOf = (f) => {
            if (!f) return 0
            if (cache.has(f)) return cache.get(f)
            const s = score(f, tMap[f.scenarioId] || null, settings, t)
            cache.set(f, s)
            return s
        }
        list.sort((a, b) => {
            const sa = _scoreOf(a), sb = _scoreOf(b)
            if (sb !== sa) return sb - sa
            return (b.firedAt || 0) - (a.firedAt || 0)
        })
        return list
    }

    /** Convenience reader for the settings blob; returns the shape every
     *  consumer expects even when storage is empty / unavailable. */
    async function readFireUxSettings(host) {
        const out = {fireUx: {}}
        if (!host || !host.server || typeof chrome === "undefined" || !chrome.storage) return out
        try {
            const key = "aesConductor:settings:" + String(host.server) + ":" + String(host.airline || "")
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            if (v && typeof v === "object" && v.fireUx && typeof v.fireUx === "object") {
                return {fireUx: v.fireUx, _key: key, _raw: v}
            }
            return {fireUx: {}, _key: key, _raw: v || {}}
        } catch (_) { return out }
    }

    /** Read-modify-write helper. Caller passes the action ("pin"|"unpin"|
     *  "snooze"|"unsnooze") and an optional snoozeUntil ts. Emits the
     *  data:conductor:fireUx:saved bus event. */
    async function applyFireUx(host, fireId, action, opts) {
        if (!host || !host.server || !fireId) return null
        const key = "aesConductor:settings:" + String(host.server) + ":" + String(host.airline || "")
        try {
            const blob = await chrome.storage.local.get([key])
            const cur = (blob && blob[key] && typeof blob[key] === "object") ? blob[key] : {}
            const ux = (cur.fireUx && typeof cur.fireUx === "object") ? cur.fireUx : {}
            const entry = (ux[fireId] && typeof ux[fireId] === "object") ? Object.assign({}, ux[fireId]) : {}
            switch (action) {
                case "pin":       entry.pinned = true; break
                case "unpin":     delete entry.pinned; break
                case "snooze": {
                    const until = (opts && typeof opts.snoozedUntil === "number" && isFinite(opts.snoozedUntil))
                        ? opts.snoozedUntil
                        : (Date.now() + 24 * 3600 * 1000)
                    entry.snoozedUntil = until
                    break
                }
                case "unsnooze": delete entry.snoozedUntil; break
                default: return null
            }
            const empty = !entry.pinned && entry.snoozedUntil == null
            if (empty) delete ux[fireId]
            else       ux[fireId] = entry
            cur.fireUx = ux
            await chrome.storage.local.set({[key]: cur})
            try {
                if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                    window.CentralHubBus.emit("data:conductor:fireUx:saved", {
                        server:  host.server,
                        airline: host.airline || "",
                        fireId:  fireId,
                        action:  action
                    })
                }
            } catch (_) { /* noop */ }
            return entry
        } catch (_) { return null }
    }

    window.AesConductorAttention = {
        score, sortFires, readFireUxSettings, applyFireUx,
        SEVERITY_WEIGHT, HALF_LIFE_MS, PIN_BONUS
    }
})()
