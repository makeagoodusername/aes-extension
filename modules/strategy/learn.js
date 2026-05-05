"use strict"

/**
 * AES Strategy — closed-loop learner (Slice 5).
 *
 * Stores the airline's currently-effective scoring weights and adjusts
 * them based on observed outcomes from `outcomes.js`. Implements the
 * finite-difference gradient described in roadmap §III-Slice 5: for
 * each weight, partition outcomes into "weight-was-above-median" and
 * "weight-was-below-median" subsets and compute the profit-delta gap.
 * Positive gap when the weight was higher → positive gradient → step up.
 *
 * Storage:
 *   aesStrategy:learn:weights:current  ← current learnt weights, or
 *                                          null/missing = use DEFAULT_WEIGHTS
 *   aesStrategy:learn:weights:history  ← ring of past weight changes
 *                                          {ts, before, after, reason, gradient?}
 *                                          cap 52 (one game-year)
 *
 * Public API (window.AesStrategyLearn):
 *   getCurrentWeights()      → Promise<weights>            (merged with defaults)
 *   setCurrentWeights(w, r)  → Promise<weights>            (writes + history)
 *   resetWeights(reason?)    → Promise<weights>            (back to defaults)
 *   learn(opts?)             → Promise<{newWeights, oldWeights, gradient,
 *                                       reason, applied}>
 *   getHistory()             → Promise<historyEntry[]>
 *
 * `learn()` reads `AesStrategyOutcomes.loadAll()`, filters to outcomes
 * with both `before` and `after`, computes per-weight gradient, and
 * applies a step. Skips with `reason: "learning-paused"` when
 * `learningEnabled === false` and `opts.force !== true`. Skips with
 * `reason: "insufficient-data"` when fewer than `minSamples` outcomes
 * have been attributed (default 5). Skips with `reason: "no-defaults"`
 * when `AesStrategy.DEFAULT_WEIGHTS` isn't loaded yet.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyLearn) return

    const KEY_CURRENT = "aesStrategy:learn:weights:current"
    const KEY_HISTORY = "aesStrategy:learn:weights:history"
    const HISTORY_CAP = 52
    const DEFAULT_MIN_SAMPLES = 5
    const DEFAULT_STEP        = 0.05

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }
    function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

    /**
     * Per-account scoping (Slice 11). Sister airlines on the same server
     * may have different fleet mixes / route economics; sharing weights
     * means sister A's apply biases sister B's gradient. Scope each
     * airline's weights + history under the registry-derived accountId.
     * Reads fall back to the legacy unscoped key when the scoped slot is
     * empty so existing learners don't reset on the rollout boundary.
     */
    function _scopedKey(base, accountId) {
        return accountId ? base + ":acct:" + accountId : base
    }
    function _resolveAccountId(arg) {
        if (typeof arg === "string" && arg) return arg
        if (typeof window !== "undefined" && window.__aesAccountId) return window.__aesAccountId
        return null
    }

    function _defaultWeights() {
        const ns = window.AesStrategy
        if (ns && ns.DEFAULT_WEIGHTS && typeof ns.DEFAULT_WEIGHTS === "object") {
            return Object.assign({}, ns.DEFAULT_WEIGHTS)
        }
        return null
    }

    function _mergeWithDefaults(w) {
        const d = _defaultWeights()
        if (!d) return w ? Object.assign({}, w) : null
        const out = Object.assign({}, d)
        if (w && typeof w === "object") {
            for (const k of Object.keys(d)) {
                if (typeof w[k] === "number" && isFinite(w[k])) out[k] = w[k]
            }
        }
        return out
    }

    async function getCurrentWeights(accountId) {
        const id  = _resolveAccountId(accountId)
        const key = _scopedKey(KEY_CURRENT, id)
        try {
            const data = await chrome.storage.local.get([key])
            let stored = data[key]
            if (!stored && id) {
                // Scoped miss — read legacy so first-time scoped reads
                // still return whatever the airline has been using.
                const fb = await chrome.storage.local.get([KEY_CURRENT])
                stored = fb[KEY_CURRENT] || null
            }
            return _mergeWithDefaults(stored && stored.weights ? stored.weights : null)
        } catch (e) {
            console.warn("[AesStrategyLearn] getCurrentWeights failed", e)
            return _defaultWeights()
        }
    }

    async function _loadHistory(accountId) {
        const id  = _resolveAccountId(accountId)
        const key = _scopedKey(KEY_HISTORY, id)
        try {
            const data = await chrome.storage.local.get([key])
            const ring = Array.isArray(data[key]) ? data[key].slice() : []
            if (ring.length || !id) return ring
            const fb = await chrome.storage.local.get([KEY_HISTORY])
            return Array.isArray(fb[KEY_HISTORY]) ? fb[KEY_HISTORY].slice() : []
        } catch (_) { return [] }
    }

    async function getHistory(accountId) { return _loadHistory(accountId) }

    async function _writeHistoryEntry(entry, accountId) {
        const id  = _resolveAccountId(accountId)
        const key = _scopedKey(KEY_HISTORY, id)
        const ring = await _loadHistory(id)
        ring.unshift(entry)
        if (ring.length > HISTORY_CAP) ring.length = HISTORY_CAP
        const writes = {[KEY_HISTORY]: ring}
        if (id) writes[key] = ring
        try { await chrome.storage.local.set(writes) }
        catch (e) { console.warn("[AesStrategyLearn] history write failed", e) }
    }

    async function setCurrentWeights(newWeights, reason, extra, accountId) {
        const id     = _resolveAccountId(accountId)
        const key    = _scopedKey(KEY_CURRENT, id)
        const before = await getCurrentWeights(id)
        const after  = _mergeWithDefaults(newWeights)
        const ts     = Date.now()
        const payload = {weights: after, ts: ts, reason: reason || "manual", accountId: id}
        try {
            const writes = {[KEY_CURRENT]: payload}
            if (id) writes[key] = payload
            await chrome.storage.local.set(writes)
        } catch (e) {
            console.warn("[AesStrategyLearn] setCurrentWeights failed", e)
            return before
        }
        await _writeHistoryEntry(Object.assign({
            ts: ts, reason: reason || "manual", before: before, after: after
        }, extra || {}), id)
        _journal({
            action: "weight-change", accountId: id, ts: ts,
            before: {weights: before},
            after:  Object.assign({reason: reason || "manual", weights: after}, extra || {})
        })
        return after
    }

    async function resetWeights(reason, accountId) {
        const defaults = _defaultWeights()
        if (!defaults) {
            console.warn("[AesStrategyLearn] resetWeights — DEFAULT_WEIGHTS missing")
            return null
        }
        const id  = _resolveAccountId(accountId)
        const key = _scopedKey(KEY_CURRENT, id)
        const beforeWeights = await getCurrentWeights(id)   // pre-remove read still merges defaults
        try {
            const removeKeys = id ? [KEY_CURRENT, key] : [KEY_CURRENT]
            await chrome.storage.local.remove(removeKeys)
        } catch (_) { /* ignore */ }
        const ts = Date.now()
        await _writeHistoryEntry({
            ts: ts, reason: reason || "reset",
            before: beforeWeights,
            after:  defaults
        }, id)
        _journal({
            action: "weight-change", accountId: id, ts: ts,
            before: {weights: beforeWeights},
            after:  {reason: reason || "reset", weights: defaults}
        })
        return defaults
    }

    /**
     * Fire-and-forget journal record. Defensive: journal store may not be
     * loaded on every page that calls into learn.js, and a journal failure
     * must never break a weight write.
     */
    function _journal(payload) {
        try {
            if (window.AesStrategyJournal
                    && typeof window.AesStrategyJournal.record === "function") {
                window.AesStrategyJournal.record(Object.assign({source: "learn"}, payload))
                    .catch(e => console.warn("[AesStrategyLearn] journal record failed", e))
            }
        } catch (e) {
            console.warn("[AesStrategyLearn] journal record threw", e)
        }
    }

    /**
     * Pure: compute gradient + new weights from a list of attributed
     * outcomes. Exposed for unit-style smoke + future test harness.
     */
    function _gradient(outcomes, weightKeys) {
        const grad = {}
        for (const k of weightKeys) grad[k] = 0
        if (!outcomes.length) return grad

        // score[i] = (after.weeklyResult - before.weeklyResult) for each outcome.
        // Outcomes missing either weeklyResult drop out of the cohort.
        const cohort = []
        for (const o of outcomes) {
            if (!o.before || !o.after) continue
            const b = _num(o.before.weeklyResult, NaN)
            const a = _num(o.after.weeklyResult,  NaN)
            if (!isFinite(b) || !isFinite(a)) continue
            cohort.push({score: a - b, weights: o.weights || {}})
        }
        if (cohort.length < 2) return grad

        for (const k of weightKeys) {
            const vals = cohort.map(c => _num(c.weights[k], NaN)).filter(isFinite)
            if (vals.length < 2) { grad[k] = 0; continue }
            const sorted = vals.slice().sort((a, b) => a - b)
            const median = sorted[Math.floor(sorted.length / 2)]
            let above = [], below = []
            for (const c of cohort) {
                const v = _num(c.weights[k], NaN)
                if (!isFinite(v)) continue
                if (v >= median) above.push(c.score)
                else             below.push(c.score)
            }
            if (!above.length || !below.length) { grad[k] = 0; continue }
            const aMean = above.reduce((s, x) => s + x, 0) / above.length
            const bMean = below.reduce((s, x) => s + x, 0) / below.length
            // Normalize by the overall scale of scores so weights with large
            // dollar deltas don't dwarf weights with tight ones. v1 uses the
            // cohort's |max - min|; clamp to avoid /0 when everything's equal.
            const allScores = cohort.map(c => c.score)
            const range = Math.max(...allScores) - Math.min(...allScores)
            const denom = range > 0 ? range : 1
            grad[k] = (aMean - bMean) / denom
        }
        return grad
    }

    async function _loadSettingsSafe() {
        if (window.AesStrategySettings && typeof window.AesStrategySettings.load === "function") {
            try { return await window.AesStrategySettings.load() } catch (_) { /* fall through */ }
        }
        return null
    }

    async function learn(opts) {
        const o = opts || {}
        const accountId = _resolveAccountId(o.accountId)
        const settings = await _loadSettingsSafe()
        const stepSize = _num(o.stepSize,
            settings ? _num(settings.learningStepSize, DEFAULT_STEP) : DEFAULT_STEP)
        const minSamples = _num(o.minSamples, DEFAULT_MIN_SAMPLES)
        const force      = !!o.force
        if (!force && settings && settings.learningEnabled === false) {
            return {newWeights: null, oldWeights: null, gradient: null,
                    reason: "learning-paused", applied: false}
        }

        const defaults = _defaultWeights()
        if (!defaults) {
            return {newWeights: null, oldWeights: null, gradient: null,
                    reason: "no-defaults", applied: false}
        }

        const outcomes = window.AesStrategyOutcomes
            ? await window.AesStrategyOutcomes.loadAll(accountId)
            : []
        const attributed = outcomes.filter(o => o && o.before && o.after)
        if (attributed.length < minSamples) {
            return {newWeights: null, oldWeights: null, gradient: null,
                    reason: "insufficient-data", applied: false,
                    have: attributed.length, need: minSamples}
        }

        const weightKeys = Object.keys(defaults)
        const oldWeights = await getCurrentWeights(accountId)
        const grad = _gradient(attributed, weightKeys)

        const newWeights = {}
        for (const k of weightKeys) {
            newWeights[k] = _clamp(_num(oldWeights[k], defaults[k]) + stepSize * (grad[k] || 0), 0, 2)
        }

        await setCurrentWeights(newWeights, "auto-learn", {
            gradient: grad,
            stepSize: stepSize,
            sampleCount: attributed.length
        }, accountId)
        return {newWeights, oldWeights, gradient: grad, reason: "applied",
                applied: true, sampleCount: attributed.length, stepSize, accountId}
    }

    window.AesStrategyLearn = {
        getCurrentWeights:  getCurrentWeights,
        setCurrentWeights:  setCurrentWeights,
        resetWeights:       resetWeights,
        getHistory:         getHistory,
        learn:              learn,
        // Pure helper for tests
        _gradient:          _gradient,
        KEY_CURRENT:        KEY_CURRENT,
        KEY_HISTORY:        KEY_HISTORY,
        HISTORY_CAP:        HISTORY_CAP
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // gradient with two-cohort outcomes
            const fakeOutcomes = [
                {before: {weeklyResult: 100}, after: {weeklyResult: 200}, weights: {x: 0.8}},
                {before: {weeklyResult: 100}, after: {weeklyResult: 250}, weights: {x: 0.9}},
                {before: {weeklyResult: 100}, after: {weeklyResult: 110}, weights: {x: 0.2}},
                {before: {weeklyResult: 100}, after: {weeklyResult: 105}, weights: {x: 0.1}}
            ]
            const g = _gradient(fakeOutcomes, ["x"])
            console.assert(g.x > 0,
                "[smoke learn] high-x cohort outperformed → positive gradient")
            const g2 = _gradient([], ["x"])
            console.assert(g2.x === 0,                                       "[smoke learn] empty outcomes → zero gradient")
            const g3 = _gradient([{before: {weeklyResult: 100}, after: {weeklyResult: 200},
                                   weights: {x: 0.5}}], ["x"])
            console.assert(g3.x === 0,                                       "[smoke learn] cohort < 2 → zero gradient")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
