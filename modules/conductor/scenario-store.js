"use strict"

/**
 * AesConductorScenarioStore — storage-backed ring buffer of scenario fires.
 * Mirrors AesConductorSignalStore but keyed per-scenario so K10 outcome
 * attribution can join outcomes onto the right fire.
 *
 * Storage:
 *   aesConductor:fires:<server>:<airline>  → Fire[] (oldest-first, capped 200)
 *
 * A Fire record:
 *   {
 *     id:               "<firedAt>-<counter>",
 *     scenarioId:       "MaintenanceWatch",
 *     server, airline, firedAt,
 *     severity:         "info" | "warn" | "alert",
 *     rationale:        "<one-line user-readable reason>",
 *     payload:          {...},               // arbitrary scenario-specific data
 *     signalIds:        ["<id1>", ...],      // signals that triggered this fire
 *     dismissedAt:      number|null,         // K6 — user dismissed
 *     // K10 outcome attribution:
 *     acceptanceState:  "open" | "accepted" | "dismissed",
 *     acceptedAt:       number|null,
 *     outcome:          {observedDelta, expectedDelta, favourable, terminal, reason} | null,
 *     outcomeAt:        number|null
 *   }
 *
 * 200 cap matches CONDUCTOR-ROADMAP §V's per-scenario fire cap; we share
 * one buffer across all scenarios for the thin slice and partition in K10.
 */
;(function () {
    if (typeof window === "undefined" || window.AesConductorScenarioStore) return

    const PREFIX = "aesConductor:fires:"
    const CAP    = 200

    function _key(host) {
        if (!host || !host.server) return null
        return PREFIX + String(host.server) + ":" + String(host.airline || "")
    }

    async function _read(key) {
        if (!key || typeof chrome === "undefined" || !chrome.storage) return []
        try {
            const blob = await chrome.storage.local.get([key])
            const arr = blob && blob[key]
            return Array.isArray(arr) ? arr : []
        } catch (_) { return [] }
    }

    async function append(host, fire) {
        const key = _key(host)
        if (!key || !fire) return
        const arr = await _read(key)
        arr.push(fire)
        if (arr.length > CAP) arr.splice(0, arr.length - CAP)
        try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
    }

    async function recent(host, n, opts) {
        const arr = await _read(_key(host))
        const includeDismissed = !!(opts && opts.includeDismissed)
        const filtered = includeDismissed ? arr : arr.filter(f => !f || !f.dismissedAt)
        const cap = isFinite(n) && n > 0 ? Math.min(n, filtered.length) : filtered.length
        return filtered.slice(filtered.length - cap).reverse()
    }

    async function dismiss(host, fireId) {
        const key = _key(host)
        if (!key || !fireId) return
        const arr = await _read(key)
        let mutated = false
        for (const f of arr) {
            if (f && f.id === fireId && !f.dismissedAt) {
                f.dismissedAt = Date.now()
                f.acceptanceState = "dismissed"
                mutated = true
                break
            }
        }
        if (mutated) {
            try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
        }
    }

    /** K10 — record that the user opened the fire's recommended surface.
     *  Sets acceptanceState=accepted + acceptedAt. Idempotent on a fire
     *  that's already accepted; will not overwrite a prior dismissal. */
    async function accept(host, fireId) {
        const key = _key(host)
        if (!key || !fireId) return
        const arr = await _read(key)
        let mutated = false
        for (const f of arr) {
            if (!f || f.id !== fireId) continue
            if (f.acceptanceState === "dismissed" || f.dismissedAt) break
            if (f.acceptanceState === "accepted")  break
            f.acceptanceState = "accepted"
            f.acceptedAt      = Date.now()
            mutated = true
            break
        }
        if (mutated) {
            try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
        }
    }

    /** K10 — write an evaluator outcome onto a fire. Called from the
     *  outcome-driver. No-op when the fire is missing or its outcome is
     *  already terminal (so a steady-state fire isn't re-scored once a
     *  scenario decides). */
    async function applyOutcome(host, fireId, outcome) {
        const key = _key(host)
        if (!key || !fireId || !outcome) return
        const arr = await _read(key)
        let mutated = false
        for (const f of arr) {
            if (!f || f.id !== fireId) continue
            if (f.outcome && f.outcome.terminal) break
            f.outcome   = outcome
            f.outcomeAt = Date.now()
            mutated = true
            break
        }
        if (mutated) {
            try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
        }
    }

    /** Snapshot every fire across the ring, regardless of dismissal state.
     *  The outcome-driver iterates this directly to avoid the recent()
     *  filter — even dismissed fires are still attributable for K11 trust. */
    async function all(host) {
        const arr = await _read(_key(host))
        return arr.slice()
    }

    async function clear(host) {
        const key = _key(host)
        if (!key) return
        try { await chrome.storage.local.set({[key]: []}) } catch (_) { /* noop */ }
    }

    window.AesConductorScenarioStore = {
        append, recent, dismiss, accept, applyOutcome, all, clear,
        PREFIX, CAP
    }
})()
