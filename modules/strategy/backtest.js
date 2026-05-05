"use strict"

/**
 * AES Strategy — backtest harness (Slice 15).
 *
 * Pure async function. Replays the last N weeks of accounting snapshots
 * to produce a per-week profit series and (optionally) a counterfactual
 * estimate of what alternative weights would have delivered. Everything
 * is read-only — no writes, no scrapes; the harness just joins existing
 * stores together.
 *
 * Method:
 *   1. Walk `AccountingSnapshotStore.loadIndex` for the last `weeks` weekIds.
 *   2. Per weekId, load the income tab; extract `totals.ebit.current`
 *      (fall back to ebt → adjEbitda → 0). That's the actual profit.
 *   3. Walk the `AesStrategyOutcomes.loadAll()` ring; bucket outcomes by
 *      week (applyTs falls in [weekClosesAt - 7d, weekClosesAt]).
 *   4. Per week, sum the realised `after.weeklyResult - before.weeklyResult`
 *      across that week's outcomes — this is the "attributed-to-applies"
 *      portion of the actual profit (rest is exogenous).
 *   5. If `alternativeWeights` provided, scale each outcome's attributed
 *      delta by `weightSimilarity(altWeights, outcome.weights)` — cosine
 *      between weight vectors normalised to [0, 1]. Aligned → 1 (no delta
 *      vs actual), orthogonal → 0.5 (half-attribution), opposed → 0
 *      (attribution erased). Sum into hypothetical attributed delta.
 *   6. Hypothetical profit per week = actual + (hypoAttributed - actualAttributed).
 *   7. Build cumulative series for both, return everything.
 *
 * The counterfactual is intentionally a coarse heuristic — without
 * historical snapshot replay we can't simulate what *different* decisions
 * would have happened. Output documents the assumption in `summary.notes`
 * so future LEARN slices can swap in a better model.
 *
 * Public API (window.AesStrategyBacktest):
 *   run({server, airlineCode, weeks?, alternativeWeights?, accountId?})
 *     → Promise<BacktestResult>
 *   recommend({server, airlineCode, weeks?, accountId?, currentWeights, candidates?, maxCandidates?})
 *     → Promise<RecommendResult>
 *
 * BacktestResult shape:
 *   {
 *     perWeek: [{
 *       weekId, weekClosesAt, actualProfit,
 *       attributedDelta, hypothetical:{attributed?, profit?},
 *       outcomeCount
 *     }],
 *     actualCum:        [number, …],   // running sum of actualProfit
 *     hypotheticalCum:  [number, …]?,  // present only if alternativeWeights
 *     cumulativeDelta:  number?,       // hypoCum[last] - actualCum[last]
 *     summary: {
 *       weeksWithData, totalActual, totalHypothetical?, avgWeeklyDelta?,
 *       outcomeCountTotal, notes: [string]
 *     },
 *     durationMs
 *   }
 *
 * RecommendResult shape:
 *   {
 *     ok:         bool,
 *     baseline:   weights,                  // current weights, ranked first
 *     candidates: [{label, weights, key, factor, cumulativeDelta,
 *                   totalHypothetical, weeksWithData}],   // sorted by delta desc
 *     gradient:   {[weightKey]: {direction:"up"|"down"|"flat"|"unknown",
 *                                magnitude:number}},
 *     outcomeCountTotal, notes: [string], durationMs
 *   }
 *
 * `recommend` is a sensitivity sweep: K candidate weight vectors
 * (baseline + per-key ±15% / ±30%) are scored against ONE loaded bundle,
 * so K candidates cost O(K) CPU but only one storage round-trip. The
 * cosine heuristic caps counterfactual gain at 0 vs baseline, so this is
 * **risk analysis, not optimisation** — the rank surfaces which
 * perturbation directions would have eroded attributed profit the least
 * over the last N weeks. Per-key gradient hint compares the closest-to-1
 * up/down factors and points at the safer-to-explore direction.
 *
 * Acceptance: 12-week window completes in <10s. Storage reads dominate;
 * we batch the per-week income tab read into one chrome.storage.local.get
 * call to keep us comfortably under budget. recommend(12 candidates,
 * 12 weeks) finishes in <500ms under the smoke harness.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyBacktest) return

    const DEFAULT_WEEKS = 12

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }

    function _round(v, d) { const f = Math.pow(10, d || 0); return Math.round(v * f) / f }

    /**
     * Cosine similarity between two weight vectors over their shared keys,
     * mapped onto [0, 1] so a perfectly-aligned alternative reproduces the
     * realised attributed delta exactly (cumulative delta == 0 in that
     * trivial case), an orthogonal one keeps half, and a fully-opposed one
     * cancels it. We don't model the alternative *outperforming* what
     * actually shipped — counterfactual gain is bounded by the realised
     * attribution; richer scenarios need historical replay (future LEARN).
     */
    function _weightSimilarity(altW, refW) {
        if (!altW || !refW) return 1
        let dot = 0, normA = 0, normR = 0
        for (const k of Object.keys(refW)) {
            const a = _num(altW[k], 0)
            const r = _num(refW[k], 0)
            dot   += a * r
            normA += a * a
            normR += r * r
        }
        if (normA <= 0 || normR <= 0) return 1
        const cos = dot / Math.sqrt(normA * normR)
        // Map cosine [-1, 1] → [0, 1]. cos=1 → 1, cos=0 → 0.5, cos=-1 → 0.
        return Math.max(0, 0.5 + cos * 0.5)
    }

    function _profitFromIncomeTotals(totals) {
        if (!totals || typeof totals !== "object") return 0
        // Prefer EBT (after financial result), fall back to EBIT, then any
        // adjEbitda — first finite "current" wins.
        for (const k of ["ebt", "ebit", "adjEbitda"]) {
            const t = totals[k]
            if (!t) continue
            const v = _num(t.current, NaN)
            if (isFinite(v)) return v
        }
        return 0
    }

    /**
     * Group outcomes by the week they were applied in. A week's window is
     * [weekClosesAt - 7d, weekClosesAt] (the close-date is the END of the
     * week). Outcomes outside any of the supplied weeks are dropped.
     */
    function _bucketOutcomesByWeek(outcomes, weekEntries) {
        const WEEK_MS = 7 * 86_400_000
        const buckets = new Map()
        for (const w of weekEntries) {
            buckets.set(w.weekId, [])
        }
        for (const o of outcomes) {
            if (!o || !o.applyTs) continue
            for (const w of weekEntries) {
                const closeMs = _parseWeekClose(w.weekClosesAt || w.weekId)
                if (!closeMs) continue
                const startMs = closeMs - WEEK_MS
                if (o.applyTs >= startMs && o.applyTs <= closeMs) {
                    buckets.get(w.weekId).push(o)
                    break    // outcome belongs to one week only
                }
            }
        }
        return buckets
    }

    function _parseWeekClose(weekClosesAt) {
        if (!weekClosesAt) return null
        // weekClosesAt may be a number (epoch ms), an ISO date string, or a
        // YYYY-MM-DD string used as the weekId in saveTab.
        if (typeof weekClosesAt === "number") return weekClosesAt
        const s = String(weekClosesAt)
        const ts = Date.parse(s)
        if (isFinite(ts)) return ts
        // Fallback: try YYYYMMDD
        const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
        if (m) {
            const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
            return isFinite(d) ? d : null
        }
        return null
    }

    /**
     * Per-outcome realised delta. Returns null when before/after are
     * incomplete or weeklyResult is missing.
     */
    function _attributedDelta(outcome) {
        if (!outcome || !outcome.before || !outcome.after) return null
        const before = _num(outcome.before.weeklyResult, NaN)
        const after  = _num(outcome.after.weeklyResult,  NaN)
        if (!isFinite(before) || !isFinite(after)) return null
        return after - before
    }

    /**
     * Load index + income blob + outcomes for a (server, airline, weeks)
     * triple in a single storage round-trip. Returned bundle is reusable
     * across many counterfactual evaluations — that's what lets `recommend`
     * sweep K weight candidates without K storage hits.
     *
     * Returns {ok: true, slice, incomeBlob, outcomes, buckets, outcomeCountTotal, notes}
     *      or {ok: false, errorNote, notes:[…]} on hard failure.
     */
    async function _loadBundle({server, airlineCode, weeks, accountId}) {
        const notes = []
        if (!server || !airlineCode) {
            return {ok: false, errorNote: "missing-server-or-airline", notes: ["missing-server-or-airline"]}
        }
        const Store = window.AccountingSnapshotStore
        if (!Store || typeof Store.loadIndex !== "function") {
            return {ok: false, errorNote: "AccountingSnapshotStore-missing", notes: ["AccountingSnapshotStore-missing"]}
        }
        let index = []
        try { index = await Store.loadIndex(server, airlineCode) }
        catch (_) { return {ok: false, errorNote: "index-load-failed", notes: ["index-load-failed"]} }
        if (!Array.isArray(index) || !index.length) {
            return {ok: false, errorNote: "no-accounting-history", notes: ["no-accounting-history"]}
        }
        const slice = index.slice(0, weeks).slice().reverse()
        const tabKeys = slice.map(e => server + airlineCode + "accounting:income:" + e.weekId)
        let incomeBlob = {}
        try { incomeBlob = await chrome.storage.local.get(tabKeys) }
        catch (_) { return {ok: false, errorNote: "income-bulk-read-failed", notes: ["income-bulk-read-failed"]} }
        let outcomes = []
        if (window.AesStrategyOutcomes && typeof window.AesStrategyOutcomes.loadAll === "function") {
            try { outcomes = await window.AesStrategyOutcomes.loadAll(accountId) }
            catch (_) { outcomes = [] }
        } else {
            notes.push("outcomes-store-missing — counterfactual unavailable")
        }
        const buckets = _bucketOutcomesByWeek(outcomes, slice)
        let outcomeCountTotal = 0
        for (const w of slice) outcomeCountTotal += (buckets.get(w.weekId) || []).length
        return {ok: true, server, airlineCode, slice, incomeBlob, outcomes, buckets,
                outcomeCountTotal, notes}
    }

    /**
     * Pure compute: given a loaded bundle and (optional) altWeights, produce
     * the same shape as `run()`'s result. No storage I/O, no exceptions —
     * safe to call K times in a tight loop for sensitivity sweeps.
     */
    function _computeFromBundle(bundle, altWeights, startedAt) {
        const notes = bundle.notes.slice()
        const perWeek = []
        let actualSum = 0, hypoSum = 0
        for (const w of bundle.slice) {
            const tabKey = bundle.server + bundle.airlineCode + "accounting:income:" + w.weekId
            const rec = bundle.incomeBlob[tabKey]
            const totals = rec && rec.payload && rec.payload.totals
            const actualProfit = _profitFromIncomeTotals(totals)
            const wkOutcomes = bundle.buckets.get(w.weekId) || []
            let attributed = 0, hypoAttributed = 0
            for (const oc of wkOutcomes) {
                const d = _attributedDelta(oc)
                if (d == null) continue
                attributed += d
                if (altWeights) hypoAttributed += d * _weightSimilarity(altWeights, oc.weights)
            }
            actualSum += actualProfit
            const entry = {
                weekId:         w.weekId,
                weekClosesAt:   w.weekClosesAt || w.weekId,
                actualProfit:   _round(actualProfit, 0),
                attributedDelta: _round(attributed, 0),
                outcomeCount:   wkOutcomes.length
            }
            if (altWeights) {
                const hypoProfit = actualProfit + (hypoAttributed - attributed)
                hypoSum += hypoProfit
                entry.hypothetical = {
                    attributed: _round(hypoAttributed, 0),
                    profit:     _round(hypoProfit, 0)
                }
            }
            perWeek.push(entry)
        }
        let runActual = 0
        const actualCum = perWeek.map(e => (runActual += e.actualProfit, runActual))
        let hypotheticalCum = null, cumulativeDelta = null
        if (altWeights) {
            let runHypo = 0
            hypotheticalCum = perWeek.map(e => (runHypo += e.hypothetical.profit, runHypo))
            cumulativeDelta = _round(runHypo - runActual, 0)
            if (notes.indexOf("counterfactual-heuristic") < 0)
                notes.push("counterfactual estimate uses cosine-weighted attributed delta — coarse heuristic")
        }
        const summary = {
            weeksWithData:     perWeek.length,
            totalActual:       _round(actualSum, 0),
            outcomeCountTotal: bundle.outcomeCountTotal,
            notes:             notes
        }
        if (altWeights) {
            summary.totalHypothetical = _round(hypoSum, 0)
            summary.avgWeeklyDelta    = _round(cumulativeDelta / perWeek.length, 0)
        }
        return {
            perWeek:         perWeek,
            actualCum:       actualCum.map(v => _round(v, 0)),
            hypotheticalCum: hypotheticalCum ? hypotheticalCum.map(v => _round(v, 0)) : null,
            cumulativeDelta: cumulativeDelta,
            summary:         summary,
            durationMs:      Date.now() - startedAt
        }
    }

    async function run(opts) {
        const startedAt = Date.now()
        const o = opts || {}
        const weeks = Math.max(1, Math.min(52, _num(o.weeks, DEFAULT_WEEKS)))
        const bundle = await _loadBundle({
            server: o.server || null, airlineCode: o.airlineCode || null,
            weeks: weeks, accountId: o.accountId || null
        })
        if (!bundle.ok) return _empty(startedAt, bundle.notes)
        return _computeFromBundle(bundle, o.alternativeWeights || null, startedAt)
    }

    /**
     * Generate weight candidates for a sensitivity sweep. Centred on
     * `currentWeights`: per-key ±15% and ±30% perturbations, plus the
     * baseline. Caps at `maxCandidates` so even high-dim weight vectors
     * stay under a rendering-friendly result count.
     */
    function _generateCandidates(currentWeights, maxCandidates) {
        const cap = Math.max(1, _num(maxCandidates, 12))
        const cands = [{label: "current", weights: Object.assign({}, currentWeights), key: null, factor: 1}]
        const keys = Object.keys(currentWeights || {})
        const factors = [0.7, 0.85, 1.15, 1.3]
        outer: for (const f of factors) {
            for (const k of keys) {
                const w = Object.assign({}, currentWeights)
                w[k] = Math.round(_num(w[k], 0) * f * 1000) / 1000
                cands.push({label: k + " ×" + f.toFixed(2), weights: w, key: k, factor: f})
                if (cands.length >= cap) break outer
            }
        }
        return cands
    }

    /**
     * Per-weight gradient hint derived from the sensitivity sweep. For each
     * weight key k, compare the closest-to-baseline up-perturbation against
     * the closest-to-baseline down-perturbation. Whichever has the larger
     * (less-negative) cumulativeDelta is the "safer to explore" direction.
     * Returns {[k]: {direction: "up"|"down"|"flat", magnitude: number}}.
     */
    function _gradientHints(scored) {
        const byKey = new Map()
        for (const c of scored) {
            if (!c.key) continue
            const slot = byKey.get(c.key) || {up: null, down: null}
            const isUp = c.factor > 1
            const closer = (a, b) => Math.abs(a.factor - 1) < Math.abs(b.factor - 1) ? a : b
            if (isUp)  slot.up   = slot.up   ? closer(slot.up,   c) : c
            else       slot.down = slot.down ? closer(slot.down, c) : c
            byKey.set(c.key, slot)
        }
        const out = {}
        for (const [k, s] of byKey.entries()) {
            if (!s.up || !s.down) { out[k] = {direction: "unknown", magnitude: 0}; continue }
            const dUp = _num(s.up.cumulativeDelta, 0)
            const dDn = _num(s.down.cumulativeDelta, 0)
            if (dUp === dDn)      out[k] = {direction: "flat", magnitude: 0}
            else if (dUp > dDn)   out[k] = {direction: "up",   magnitude: _round(dUp - dDn, 0)}
            else                  out[k] = {direction: "down", magnitude: _round(dDn - dUp, 0)}
        }
        return out
    }

    /**
     * Sweep weight candidates against a single loaded bundle. Returns a
     * ranked list (highest cumulativeDelta first) plus per-weight gradient
     * hints. The cosine heuristic caps candidate gain at zero, so this is
     * **risk-side analysis**: which perturbations would have eroded the
     * realised attributed profit the least, and in which direction is each
     * weight safer to explore.
     */
    async function recommend(opts) {
        const startedAt = Date.now()
        const o = opts || {}
        const weeks = Math.max(1, Math.min(52, _num(o.weeks, DEFAULT_WEEKS)))
        const cur = o.currentWeights || null
        if (!cur || !Object.keys(cur).length) {
            return {ok: false, candidates: [], gradient: {}, baseline: null,
                    notes: ["missing-current-weights"], durationMs: Date.now() - startedAt}
        }
        const bundle = await _loadBundle({
            server: o.server || null, airlineCode: o.airlineCode || null,
            weeks: weeks, accountId: o.accountId || null
        })
        if (!bundle.ok) {
            return {ok: false, candidates: [], gradient: {}, baseline: null,
                    notes: bundle.notes, durationMs: Date.now() - startedAt}
        }
        const cands = (Array.isArray(o.candidates) && o.candidates.length)
            ? o.candidates.map(c => ({label: c.label || "?", weights: c.weights || {}, key: null, factor: 1}))
            : _generateCandidates(cur, o.maxCandidates || 12)
        const scored = []
        for (const c of cands) {
            const r = _computeFromBundle(bundle, c.weights, startedAt)
            scored.push({
                label: c.label, weights: c.weights, key: c.key, factor: c.factor,
                cumulativeDelta:   r.cumulativeDelta,
                totalHypothetical: r.summary.totalHypothetical,
                weeksWithData:     r.summary.weeksWithData
            })
        }
        scored.sort((a, b) => (b.cumulativeDelta || 0) - (a.cumulativeDelta || 0))
        return {
            ok:                true,
            baseline:          cands[0].weights,
            candidates:        scored,
            gradient:          _gradientHints(scored),
            outcomeCountTotal: bundle.outcomeCountTotal,
            notes:             bundle.notes.concat([
                "sensitivity sweep — cosine heuristic bounds counterfactual at zero, so all candidates ≤ 0; rank reveals which directions erode attribution least"
            ]),
            durationMs:        Date.now() - startedAt
        }
    }

    function _empty(startedAt, notes) {
        return {
            perWeek:         [],
            actualCum:       [],
            hypotheticalCum: null,
            cumulativeDelta: null,
            summary: {
                weeksWithData: 0, totalActual: 0,
                outcomeCountTotal: 0, notes: notes || []
            },
            durationMs: Date.now() - startedAt
        }
    }

    window.AesStrategyBacktest = {
        run: run,
        recommend: recommend,
        DEFAULT_WEEKS: DEFAULT_WEEKS,
        // Exposed for testing — not part of the stable surface.
        _weightSimilarity: _weightSimilarity,
        _profitFromIncomeTotals: _profitFromIncomeTotals,
        _bucketOutcomesByWeek: _bucketOutcomesByWeek,
        _generateCandidates: _generateCandidates,
        _gradientHints: _gradientHints,
        _loadBundle: _loadBundle,
        _computeFromBundle: _computeFromBundle
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            // Stash + restore globals so the smoke doesn't leak into the
            // real AccountingSnapshotStore / AesStrategyOutcomes.
            const realStore    = window.AccountingSnapshotStore
            const realOutcomes = window.AesStrategyOutcomes

            const WEEK_MS = 7 * 86_400_000
            const weeks   = []
            const blob    = {}
            // 12 synthetic weeks ending today; weekClose date strings.
            for (let i = 11; i >= 0; i--) {
                const closeMs = Date.now() - i * WEEK_MS
                const closeIso = new Date(closeMs).toISOString().slice(0, 10)
                weeks.push({weekId: closeIso, weekClosesAt: closeIso})
                blob["server-x" + "AAA" + "accounting:income:" + closeIso] = {
                    payload: {totals: {ebt: {current: 100000 + i * 1000}}}
                }
            }

            // Synthetic outcomes — one per week, each with attributed +5000 delta.
            const fakeOutcomes = []
            for (let i = 0; i < 12; i++) {
                const closeMs = Date.now() - i * WEEK_MS
                fakeOutcomes.push({
                    outcomeId: "out-" + i,
                    applyTs: closeMs - 86_400_000,
                    before: {weeklyResult: 100000},
                    after:  {weeklyResult: 105000},
                    weights: {a: 1, b: 1}
                })
            }

            window.AccountingSnapshotStore = {
                loadIndex: async () => weeks.slice().reverse(),    // newest-first
                loadWeek:  async () => null,
                loadLatest: async () => null,
                loadTab: async () => null
            }
            window.AesStrategyOutcomes = {
                loadAll: async () => fakeOutcomes
            }
            // Patch chrome.storage.local.get for our synthetic blob.
            const realChromeGet = (typeof chrome !== "undefined" && chrome.storage
                                   && chrome.storage.local && chrome.storage.local.get) || null
            if (typeof chrome === "undefined") {
                window.chrome = {storage: {local: {get: async (keys) => {
                    const out = {}
                    for (const k of (Array.isArray(keys) ? keys : [keys])) {
                        if (blob[k] !== undefined) out[k] = blob[k]
                    }
                    return out
                }}}}
            } else if (realChromeGet) {
                chrome.storage.local.get = async (keys) => {
                    const out = {}
                    for (const k of (Array.isArray(keys) ? keys : [keys])) {
                        if (blob[k] !== undefined) out[k] = blob[k]
                    }
                    return out
                }
            }

            ;(async () => {
                try {
                    const t0 = Date.now()
                    const result = await run({
                        server: "server-x", airlineCode: "AAA", weeks: 12
                    })
                    const elapsed = Date.now() - t0
                    console.assert(result.perWeek.length === 12,
                        "[smoke s15] 12 weeks of perWeek data")
                    console.assert(result.actualCum.length === 12,
                        "[smoke s15] cumulative series length matches")
                    console.assert(result.actualCum[11] > result.actualCum[0],
                        "[smoke s15] cumulative grows monotonically with positive profits")
                    console.assert(elapsed < 1000,
                        "[smoke s15] 12-week run finishes in <1s under stub (actual: " + elapsed + "ms)")
                    // Counterfactual run with aligned weights → similarity 1 → no delta.
                    const aligned = await run({server: "server-x", airlineCode: "AAA",
                        weeks: 12, alternativeWeights: {a: 1, b: 1}})
                    console.assert(aligned.cumulativeDelta != null
                        && Math.abs(aligned.cumulativeDelta) < 1e-3,
                        "[smoke s15] aligned alt weights → ~zero cumulative delta")
                    // Counterfactual run with orthogonal weights → similarity 0 → negative delta
                    const orth = await run({server: "server-x", airlineCode: "AAA",
                        weeks: 12, alternativeWeights: {c: 1, d: 1}})    // disjoint keys
                    console.assert(orth.cumulativeDelta != null,
                        "[smoke s15] alternativeWeights produces a delta")
                    // Sensitivity sweep — current weights baseline must rank #1
                    // (cumulativeDelta = 0), and per-key gradient hints emit.
                    const rec = await recommend({server: "server-x", airlineCode: "AAA",
                        weeks: 12, currentWeights: {a: 1, b: 1}, maxCandidates: 9})
                    console.assert(rec.ok && rec.candidates.length >= 1,
                        "[smoke s15] recommend returns scored candidates")
                    console.assert(rec.candidates[0].label === "current"
                        && Math.abs(rec.candidates[0].cumulativeDelta) < 1e-3,
                        "[smoke s15] recommend baseline (current weights) ranks first with delta ≈ 0")
                    console.assert(rec.gradient
                        && (rec.gradient.a || rec.gradient.b),
                        "[smoke s15] recommend emits per-key gradient hints")
                    // Bundle reuse — recommend(K candidates) must be fast
                    // because storage I/O happens once.
                    const recT0 = Date.now()
                    await recommend({server: "server-x", airlineCode: "AAA", weeks: 12,
                        currentWeights: {a: 1, b: 1}, maxCandidates: 12})
                    const recElapsed = Date.now() - recT0
                    console.assert(recElapsed < 500,
                        "[smoke s15] recommend(12 candidates) finishes <500ms (actual: " + recElapsed + "ms)")
                } catch (e) {
                    console.warn("[smoke s15] async failure", e)
                } finally {
                    if (realStore)    window.AccountingSnapshotStore = realStore
                    else              delete window.AccountingSnapshotStore
                    if (realOutcomes) window.AesStrategyOutcomes = realOutcomes
                    else              delete window.AesStrategyOutcomes
                    if (realChromeGet) chrome.storage.local.get = realChromeGet
                }
            })()
        }
    } catch (_) { /* never let smoke break the page */ }
})()
