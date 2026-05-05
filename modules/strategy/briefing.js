"use strict"

/**
 * AES Strategy — Executive Briefing builder (Slice 16).
 *
 * Pure-function composition of an executive briefing report from already-
 * computed signals. Synthesises "since your last visit": the top 3
 * applied decisions with predicted-vs-observed deltas, the single largest
 * outcome drift with its weight nudge, the top 2 fresh opportunities,
 * and one risk flag.
 *
 * Reads only — never POSTs, never writes (the caller, the briefing tile,
 * owns the lastSeenAt watermark write so the builder stays pure).
 *
 * Public API (window.AesStrategyBriefing):
 *   buildBriefing(opts) → Promise<BriefingReport>
 *     opts = {accountId?, server?, airline?, sinceMs?, snapshot?, plan?}
 *
 * BriefingReport shape (see plan file for full annotation):
 *   {
 *     generatedAt, sinceMs, windowDays, accountId, server, airline,
 *     weekId,             // accounting weekId, null when accounting hasn't snapshotted
 *     autoOpenBucketId,   // always present — accounting weekId or synthetic 7-day bucket
 *     applied:       [BriefingAppliedItem],         // 0..3
 *     drifted:       BriefingDrift | null,
 *     opportunities: [BriefingOpportunity],         // 0..2
 *     risk:          BriefingRisk,                  // always present (kind:"none" when ok)
 *     diagnostics:   {missing: string[], notes: string[]}
 *   }
 *
 * Compounds with infrastructure landed in slice/e-integration:
 *   - AesChangeLogAggregator: applied feed across 6 domains.
 *   - AesStrategyOutcomes:    predicted-vs-observed measurements.
 *   - AesStrategyJournal:     rationale cross-reference per decision.
 *   - AesStrategyLearn:       weight nudges following drift.
 *   - AesStrategy.snapshot/diffPlan: fresh opportunity proposals.
 *   - AccountingProjector:    cash runway risk signal.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyBriefing) return

    const DEFAULT_WINDOW_DAYS = 7
    const HOUR_MS = 3_600_000
    const DAY_MS  = 24 * HOUR_MS

    function _num(v, f) { const n = Number(v); return isFinite(n) ? n : f }
    function _safeStr(v) { return (v == null) ? null : String(v) }

    /**
     * Resolve the active accountId. Prefers the opt parameter, falls back
     * to the global bootstrap variable. Returns null when neither is set —
     * downstream readers gracefully degrade to legacy unscoped storage.
     */
    function _resolveAccountId(opts) {
        if (opts && typeof opts.accountId === "string" && opts.accountId) return opts.accountId
        if (typeof window !== "undefined" && window.__aesAccountId) return window.__aesAccountId
        return null
    }

    async function _loadLastSeen(accountId) {
        const key = accountId
            ? "aesStrategy:lastSeenAt:acct:" + accountId
            : "aesStrategy:lastSeenAt"
        try {
            const got = await chrome.storage.local.get([key])
            const rec = got[key]
            if (rec && typeof rec.ts === "number") return rec
            return null
        } catch (_) { return null }
    }

    async function _loadAutoTickEnvelope(accountId) {
        const scoped = accountId ? "aesStrategy:autoTick:last:acct:" + accountId : null
        const keys = scoped ? [scoped, "aesStrategy:autoTick:last"] : ["aesStrategy:autoTick:last"]
        try {
            const got = await chrome.storage.local.get(keys)
            return got[scoped] || got["aesStrategy:autoTick:last"] || null
        } catch (_) { return null }
    }

    async function _loadPricingBreaker() {
        try {
            const got = await chrome.storage.local.get(["settings"])
            const apply = got
                && got.settings
                && got.settings.routeAssistant
                && got.settings.routeAssistant.pricing
                && got.settings.routeAssistant.pricing.apply
            if (!apply) return null
            return {
                trippedAt:  _num(apply.circuitBreakerTrippedAt, null),
                cooldownMs: _num(apply.circuitBreakerCooldownMs, 600000),
                haltReason: _safeStr(apply.circuitBreakerHaltReason)
            }
        } catch (_) { return null }
    }

    async function _loadCurrentWeekId(server, airline) {
        if (!server || !airline) return null
        try {
            if (typeof window.AccountingSnapshotStore !== "function"
                && typeof window.AccountingSnapshotStore !== "object") return null
            if (!window.AccountingSnapshotStore || typeof window.AccountingSnapshotStore.loadIndex !== "function") return null
            const index = await window.AccountingSnapshotStore.loadIndex(server, airline)
            return Array.isArray(index) && index.length ? (index[0].weekId || null) : null
        } catch (_) { return null }
    }

    /**
     * Compose a fresh plan (snapshot → score → allocate → diff). Returns
     * null when AesStrategy isn't loaded OR when any step throws — risk
     * signal still surfaces; opportunities just degrade to "none yet."
     */
    async function _composeFreshPlan(opts, snapshot) {
        const ns = window.AesStrategy
        if (!ns) return null
        try {
            const snap = snapshot || (typeof ns.snapshot === "function"
                ? await ns.snapshot({
                    server:      opts.server || null,
                    airlineCode: opts.airline || null,
                    accountId:   opts.accountId || null
                })
                : null)
            if (!snap) return null
            if (typeof ns.scoreRoutes !== "function" || typeof ns.allocateFleet !== "function"
                || typeof ns.diffPlan !== "function") {
                return {snapshot: snap, plan: null, diff: null}
            }
            let weights = null
            if (window.AesStrategyLearn && typeof window.AesStrategyLearn.getCurrentWeights === "function") {
                try { weights = await window.AesStrategyLearn.getCurrentWeights(opts.accountId || null) } catch (_) {}
            }
            const scored = ns.scoreRoutes(snap, weights || undefined)
            const plan   = await ns.allocateFleet(snap, scored, {})
            const diff   = ns.diffPlan(plan, snap, {})
            return {snapshot: snap, plan, diff}
        } catch (_) { return null }
    }

    // ── Pure helpers ────────────────────────────────────────────────────

    /**
     * Build the per-applied-item record. Joins each change-log entry with
     * its outcome record (matched by planId when available; otherwise by
     * applyTs-proximity within ±2 minutes) and surfaces the predicted/
     * observed deltas plus a one-line rationale lifted from the journal
     * (matched by route + ts proximity within ±5 minutes).
     */
    function _buildAppliedItems(unifiedEntries, outcomes, journal, n) {
        const out = []
        if (!Array.isArray(unifiedEntries) || unifiedEntries.length === 0) return out

        const outcomesByPlan = new Map()
        for (const o of (outcomes || [])) {
            if (o && o.planId) outcomesByPlan.set(String(o.planId), o)
        }

        const sorted = unifiedEntries.slice().sort((a, b) => _impactMagnitude(b) - _impactMagnitude(a))
        for (const e of sorted) {
            if (out.length >= n) break
            if (!e || !e.ts) continue
            if (e.status === "dry-run") continue
            if (e.status === "skipped") continue

            const planId = (e.scope && e.scope.planId) || (e.raw && e.raw.planId) || null
            const outcome = planId ? outcomesByPlan.get(String(planId)) : null

            const predicted = _extractPredicted(e, outcome)
            const observed  = _extractObserved(e, outcome)
            const drift     = _computeDrift(predicted, observed)
            const driftTone = _driftTone(drift)
            const rationale = _findRationale(e, journal)

            out.push({
                id:        String(e.id || ""),
                ts:        _num(e.ts, 0),
                domain:    _safeStr(e.domain),
                source:    _safeStr(e.source),
                scope:     {
                    hub:       (e.scope && e.scope.hub)       || null,
                    dest:      (e.scope && e.scope.dest)      || null,
                    tail:      (e.scope && e.scope.tail)      || null,
                    profileId: (e.scope && e.scope.profileId) || null,
                    planId:    planId
                },
                status:    _safeStr(e.status),
                summary:   _safeStr(e.summary),
                predicted: predicted,
                observed:  observed,
                drift:     drift,
                driftTone: driftTone,
                rationale: rationale,
                raw:       e
            })
        }
        return out
    }

    function _impactMagnitude(e) {
        if (!e) return 0
        const r = e.raw || {}
        // Pricing entries carry per-class deltas in `r.requestedPrices` /
        // `r.prevPrices`. We just want a coarse stable ordering, so take
        // the absolute average percentage move.
        if (e.domain === "pricing" && r.prevPrices && (r.newPrices || r.requestedPrices)) {
            const prev = r.prevPrices, next = r.newPrices || r.requestedPrices
            let mag = 0, n = 0
            for (const k of Object.keys(prev)) {
                if (!isFinite(prev[k]) || !isFinite(next[k])) continue
                if (prev[k] === 0) continue
                mag += Math.abs((next[k] - prev[k]) / prev[k])
                n++
            }
            return n > 0 ? (mag / n) * 100 : 0
        }
        // Strategy entries carry `report.totals.ok` / dollarImpactWeekly.
        if (e.domain === "strategy" && r.report && r.report.totals) {
            const t = r.report.totals
            return _num(t.ok, 0) + 0.5 * _num(t.failed, 0)
        }
        // Auto-scheduler entries: count of legs added/removed.
        if (e.domain === "auto-scheduler") {
            return _num(r.added, 0) + _num(r.removed, 0)
        }
        // Service-profile / flight-numbers / afp-audit: fall back to recency.
        return Math.max(0, 1000 - (Date.now() - _num(e.ts, 0)) / DAY_MS)
    }

    function _extractPredicted(entry, outcome) {
        // Strategy applies: `plan.summary.predictedWeeklyProfit` lands in
        // outcome.before.predictedWeeklyProfit per outcomes.measure(plan).
        if (outcome && outcome.before && typeof outcome.before.predictedWeeklyProfit === "number") {
            return {
                value: outcome.before.predictedWeeklyProfit,
                unit:  "$/wk",
                label: "predicted weekly profit"
            }
        }
        // Pricing entries can carry `r.deltaWeekly` from the apply preview;
        // surface as predicted weekly delta.
        const r = entry && entry.raw
        if (r && typeof r.deltaWeekly === "number") {
            return {value: r.deltaWeekly, unit: "$/wk", label: "predicted weekly delta"}
        }
        if (r && typeof r.predictedOrsLift === "number") {
            return {value: r.predictedOrsLift, unit: "ORS", label: "predicted ORS lift"}
        }
        return null
    }

    function _extractObserved(entry, outcome) {
        if (!outcome || !outcome.after) return null
        // Cash-balance delta over the window is the most reliable observed
        // signal we have today (closed-loop attribution per route is Slice 15).
        const before = outcome.before || {}
        const after  = outcome.after  || {}
        if (typeof before.weeklyResult === "number" && typeof after.weeklyResult === "number") {
            return {
                value: after.weeklyResult - before.weeklyResult,
                unit:  "$/wk",
                label: "observed weekly result Δ",
                ts:    _num(outcome.afterTs, null)
            }
        }
        if (typeof before.orsAvgY === "number" && typeof after.orsAvgY === "number") {
            return {
                value: after.orsAvgY - before.orsAvgY,
                unit:  "ORS",
                label: "observed ORS Δ",
                ts:    _num(outcome.afterTs, null)
            }
        }
        return null
    }

    function _computeDrift(predicted, observed) {
        if (!predicted || !observed) return null
        if (predicted.unit !== observed.unit) return null
        const denom = Math.max(Math.abs(predicted.value), 1e-9)
        return (observed.value - predicted.value) / denom
    }

    function _driftTone(drift) {
        if (drift == null) return "muted"
        const abs = Math.abs(drift)
        if (abs < 0.15) return "ok"
        if (abs < 0.40) return "warn"
        return "err"
    }

    function _findRationale(entry, journal) {
        if (!Array.isArray(journal) || journal.length === 0) return []
        const ts = _num(entry.ts, 0)
        const route = (entry.scope && entry.scope.hub && entry.scope.dest)
            ? entry.scope.hub + "-" + entry.scope.dest
            : null
        const out = []
        for (const j of journal) {
            if (!j || !j.ts) continue
            if (Math.abs(_num(j.ts, 0) - ts) > 5 * 60 * 1000) continue
            if (route && j.route && j.route !== route) continue
            if (j.action !== "apply-decision") continue
            if (typeof j.reasonText === "string" && j.reasonText) out.push(j.reasonText)
            if (out.length >= 3) break
        }
        return out
    }

    /**
     * Pick the outcome with the largest |drift| on a comparable-units
     * (predicted/observed) pair. Returns null when no outcome has both
     * before/after AND a usable predicted value.
     */
    function _largestDrift(outcomes, weightHistory) {
        if (!Array.isArray(outcomes) || outcomes.length === 0) return null
        let best = null
        let bestAbs = -1
        for (const o of outcomes) {
            if (!o || !o.after || !o.before) continue
            const candidates = [
                _driftPair("weeklyProfit",  o.before.predictedWeeklyProfit, o.after.weeklyResult),
                _driftPair("orsAvg",        o.before.predictedOrsAvg,       o.after.orsAvgY),
                _driftPair("paxLfMean",     o.before.paxLfMean,             o.after.paxLfMean)
            ].filter(Boolean)
            for (const c of candidates) {
                if (Math.abs(c.driftPct) > bestAbs) {
                    bestAbs = Math.abs(c.driftPct)
                    best    = {outcome: o, ...c}
                }
            }
        }
        if (!best) return null

        const dw = _findWeightNudgeAfter(weightHistory, best.outcome.afterTs || best.outcome.applyTs)
        return {
            outcomeId:    best.outcome.outcomeId || null,
            planId:       best.outcome.planId    || null,
            applyTs:      _num(best.outcome.applyTs, null),
            afterTs:      _num(best.outcome.afterTs, null),
            metric:       best.metric,
            predicted:    best.predicted,
            observed:     best.observed,
            driftPct:     best.driftPct,
            driftTone:    _driftTone(best.driftPct),
            deltaWeights: dw
        }
    }

    function _driftPair(metric, predicted, observed) {
        if (typeof predicted !== "number" || typeof observed !== "number") return null
        const denom = Math.max(Math.abs(predicted), 1e-9)
        return {
            metric:    metric,
            predicted: predicted,
            observed:  observed,
            driftPct:  (observed - predicted) / denom
        }
    }

    function _findWeightNudgeAfter(history, ts) {
        if (!Array.isArray(history) || !ts) return null
        for (const h of history) {
            if (!h || !h.ts) continue
            if (h.ts < ts) continue
            const before = h.before || {}
            const after  = h.after  || {}
            const out = {}
            for (const k of Object.keys(after)) {
                const b = _num(before[k], null), a = _num(after[k], null)
                if (b == null || a == null) continue
                if (Math.abs(a - b) > 1e-9) out[k] = a - b
            }
            return Object.keys(out).length ? out : null
        }
        return null
    }

    /**
     * Top-N opportunities from a freshly-composed PlanDiff. Skips reactive
     * (`competitorReaction`) decisions — those are answers to a competitor's
     * move, not new opportunities the user could pursue.
     */
    function _topOpportunities(diff, n) {
        if (!diff || !Array.isArray(diff.decisions) || diff.decisions.length === 0) return []
        const candidates = diff.decisions.filter(d => {
            if (!d || !d.applicable) return false
            if (d.kind === "competitorReaction") return false
            return true
        })
        candidates.sort((a, b) => _opportunityMagnitude(b) - _opportunityMagnitude(a))
        return candidates.slice(0, n).map(d => ({
            decisionId: _safeStr(d.id),
            kind:       _safeStr(d.kind),
            domain:     _safeStr(d.domain),
            title:      _safeStr(d.title),
            subtitle:   _safeStr(d.subtitle),
            impact:     d._impact ? {
                value: _num(d._impact.value, null),
                unit:  _safeStr(d._impact.unit),
                label: _safeStr(d._impact.label),
                tone:  _safeStr(d._impact.tone)
            } : null,
            rationale:  Array.isArray(d.rationale) ? d.rationale.slice(0, 5) : []
        }))
    }

    function _opportunityMagnitude(d) {
        if (!d || !d._impact) return 0
        const v = _num(d._impact.value, 0)
        if (d._impact.unit === "$/wk") return Math.abs(v)
        if (d._impact.unit === "ORS")  return Math.abs(v) * 1000   // scale ORS → $/wk-equivalent
        if (d._impact.unit === "ppl")  return Math.abs(v) * 100
        return Math.abs(v)
    }

    /**
     * Risk flag in priority order:
     *   cashRunway:err > breakerTripped > autoMuted > scrapeStale > none.
     * Each branch composes summary/detail/cta so the surface stays uniform.
     */
    function _buildRisk({snapshot, projection, breaker, autoTick, scrapeFreshnessMs}) {
        // 1. Cash runway — strongest red signal.
        if (projection && projection.available && Array.isArray(projection.weeks)) {
            for (const w of projection.weeks) {
                if (!w || w.projectedCash == null) continue
                if (w.projectedCash < 0) {
                    return {
                        kind:      "cashRunway",
                        severity:  "err",
                        summary:   "Negative projected cash by week " + w.index,
                        detail:    "Projected cash dips to $" + Math.round(w.projectedCash).toLocaleString()
                                    + " in " + w.index + " weeks at current run-rate.",
                        ctaLabel:  "Open accounting →",
                        ctaTarget: "/app/finance/accounting"
                    }
                }
            }
            if (projection.confidence === "amber" || projection.confidence === "red") {
                return {
                    kind:      "cashRunway",
                    severity:  "warn",
                    summary:   "Cash projection low confidence",
                    detail:    "Projection confidence is " + projection.confidence
                                + " — refresh accounting snapshots to tighten it.",
                    ctaLabel:  "Refresh accounting →",
                    ctaTarget: "/app/finance/accounting"
                }
            }
        }

        // 2. Pricing breaker tripped.
        if (breaker && breaker.trippedAt) {
            const now = Date.now()
            const elapsed = now - breaker.trippedAt
            if (elapsed < (breaker.cooldownMs || 600000)) {
                const remaining = Math.ceil(((breaker.cooldownMs || 600000) - elapsed) / 60000)
                return {
                    kind:      "breakerTripped",
                    severity:  "err",
                    summary:   "Pricing circuit breaker tripped",
                    detail:    "Cooling down for " + remaining + " more min."
                                + (breaker.haltReason ? " Reason: " + breaker.haltReason : ""),
                    ctaLabel:  "Reset breaker →",
                    ctaTarget: "open-pricing-settings"
                }
            }
        }

        // 3. Auto-driver muted / cooldown.
        if (autoTick && (autoTick.skippedReason === "first-activation-required"
                        || autoTick.skippedReason === "all-domains-capped")) {
            return {
                kind:      "autoMuted",
                severity:  "warn",
                summary:   autoTick.skippedReason === "first-activation-required"
                            ? "Auto-apply waiting on first-activation confirm"
                            : "Auto-apply silent-cap reached",
                detail:    "Last tick skipped: " + autoTick.skippedReason,
                ctaLabel:  "Open Strategy →",
                ctaTarget: "open-strategy-panel"
            }
        }

        // 4. Scrape staleness — most-recent strategy snapshot is older than 72h.
        if (typeof scrapeFreshnessMs === "number" && scrapeFreshnessMs > 72 * HOUR_MS) {
            const days = Math.floor(scrapeFreshnessMs / DAY_MS)
            return {
                kind:      "scrapeStale",
                severity:  "warn",
                summary:   "Scrape data " + days + "d old",
                detail:    "Refresh fleet, schedules, ORS, markets to get accurate proposals.",
                ctaLabel:  "Open Route Assistant →",
                ctaTarget: "open-ra-panel"
            }
        }

        // 5. Missing snapshot fields — diagnostic, not user-facing risk.
        if (snapshot && Array.isArray(snapshot.missing) && snapshot.missing.length > 5) {
            return {
                kind:      "scrapeStale",
                severity:  "warn",
                summary:   snapshot.missing.length + " data sources missing",
                detail:    "Open Settings → Data Flow to see which sources need a refresh.",
                ctaLabel:  "Open Settings →",
                ctaTarget: "open-settings"
            }
        }

        return {
            kind:      "none",
            severity:  "ok",
            summary:   "All systems nominal",
            detail:    "No risk flags this window.",
            ctaLabel:  null,
            ctaTarget: null
        }
    }

    function _scrapeFreshnessMs(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.fleet) || snapshot.fleet.length === 0) return null
        let newest = 0
        for (const a of snapshot.fleet) {
            if (a && typeof a.lastScrapedAt === "number" && a.lastScrapedAt > newest) {
                newest = a.lastScrapedAt
            }
        }
        if (!newest) return null
        return Date.now() - newest
    }

    // ── Main entry point ────────────────────────────────────────────────

    async function buildBriefing(opts) {
        opts = opts || {}
        const accountId = _resolveAccountId(opts)
        const generatedAt = Date.now()

        const lastSeen = await _loadLastSeen(accountId)
        const sinceMs  = _num(opts.sinceMs,
                              lastSeen ? lastSeen.ts : (generatedAt - DEFAULT_WINDOW_DAYS * DAY_MS))
        const windowDays = Math.max(1, Math.round((generatedAt - sinceMs) / DAY_MS))

        const composed = await _composeFreshPlan({
            server:    opts.server || null,
            airline:   opts.airline || null,
            accountId: accountId
        }, opts.snapshot || null)
        const snapshot = composed && composed.snapshot
        const diff     = composed && composed.diff
        const server   = (snapshot && snapshot.server)      || opts.server      || null
        const airline  = (snapshot && snapshot.airlineCode) || opts.airline     || null

        const [
            unified,
            outcomes,
            journal,
            weightHistory,
            autoTick,
            breaker,
            weekId
        ] = await Promise.all([
            _safeAggregator(sinceMs),
            _safeOutcomes(accountId),
            _safeJournal(accountId),
            _safeWeightHistory(accountId),
            _loadAutoTickEnvelope(accountId),
            _loadPricingBreaker(),
            _loadCurrentWeekId(server, airline)
        ])

        const applied = _buildAppliedItems(unified, outcomes, journal, 3)
        const drifted = _largestDrift(outcomes, weightHistory)
        const opportunities = _topOpportunities(diff, 2)

        let projection = null
        if (server && airline
            && typeof window.AccountingAggregator !== "undefined"
            && typeof window.AccountingAggregator.loadUnifiedLedger === "function"
            && typeof window.AccountingProjector !== "undefined"
            && typeof window.AccountingProjector.project === "function") {
            try {
                const ledger = await window.AccountingAggregator.loadUnifiedLedger(server, airline)
                if (ledger) projection = window.AccountingProjector.project(ledger, {weeks: 4})
            } catch (_) { /* projector missing inputs — leaves projection null */ }
        }

        const risk = _buildRisk({
            snapshot:           snapshot,
            projection:         projection,
            breaker:            breaker,
            autoTick:           autoTick,
            scrapeFreshnessMs:  _scrapeFreshnessMs(snapshot)
        })

        const riskRegister = await _buildRiskRegister({server, airline})

        const diagnostics = {missing: [], notes: []}
        if (!snapshot)             diagnostics.missing.push("snapshot")
        if (!diff)                 diagnostics.missing.push("plan")
        if (!unified.length)       diagnostics.notes.push("no applied decisions in window")
        if (!outcomes.length)      diagnostics.notes.push("outcomes ring empty")
        if (!projection)           diagnostics.missing.push("accounting projection")
        if (!weekId)               diagnostics.missing.push("weekId")

        const autoOpenBucketId = weekId
            || ("synth-" + Math.floor(generatedAt / (7 * DAY_MS)))

        try {
            if (window.CentralHubBus && typeof window.CentralHubBus.emit === "function") {
                window.CentralHubBus.emit("signal:briefing:risk-loaded", {
                    count: (riskRegister && riskRegister.count) || 0,
                    byCategory: (riskRegister && riskRegister.byCategory) || null
                })
            }
        } catch (_) { /* noop */ }

        return {
            generatedAt: generatedAt,
            sinceMs:     sinceMs,
            windowDays:  windowDays,
            accountId:   accountId,
            server:      server,
            airline:     airline,
            weekId:      weekId,
            autoOpenBucketId: autoOpenBucketId,
            applied:     applied,
            drifted:     drifted,
            opportunities: opportunities,
            risk:        risk,
            riskRegister: riskRegister,
            diagnostics: diagnostics
        }
    }

    // ── Risk register (K12 — Conductor scenario fires by category) ──────

    /** Map a Conductor scenarioId to a top-level risk category for the
     *  briefing modal. New scenarios default to "operational" until the
     *  curator extends this map. */
    const SCENARIO_CATEGORY = {
        CashStep:               "financial",
        CashRunwayDefence:      "financial",
        MaintenanceWatch:       "operational",
        ConditionWatch:         "operational",
        FleetIdle:              "operational",
        WaveStress:             "operational",
        CrewShortfall:          "operational",
        ProfitDecay:            "competitive",
        OrsRegression:          "competitive",
        CompetitorEntry:        "competitive",
        CompetitorExit:         "competitive",
        DemandShift:            "competitive",
        PricingSpiralRisk:      "competitive",
        ServiceDrift:           "operational",
        SisterCannibalisation:  "operational",
        HubImbalance:           "operational"
    }

    async function _buildRiskRegister(host) {
        // K12-full — delegate to the shared helper when loaded; legacy
        // inline fallback keeps the briefing functional in non-dashboard
        // scopes that don't yet load risk-register.js.
        if (window.AesConductorRiskRegister && typeof window.AesConductorRiskRegister.build === "function") {
            try {
                const reg = await window.AesConductorRiskRegister.build(host, {fireLimit: 5, proposalLimit: 10})
                if (reg) return reg
            } catch (_) { /* fall through to legacy */ }
        }

        const out = {count: 0, byCategory: {financial: 0, operational: 0, competitive: 0, regulatory: 0},
                     fires: [], driftProposals: []}
        if (!host || !host.server) return out
        const fires = await _safeConductorFires(host)
        const proposals = await _safeDriftProposals(host)
        // K9 — pre-fetch trust + fireUx settings so attention.score can rank.
        const trustByScenario = await _safeTrustLoad(host)
        const fireUxSettings  = await _safeFireUxSettings(host)

        const interestingFires = []
        for (const f of fires) {
            if (!f) continue
            if (f.dismissedAt) continue
            const sev = String(f.severity || "info")
            const fav = f.outcome && f.outcome.favourable === false
            const interesting = fav || sev === "alert" || sev === "warn"
            if (!interesting) continue
            const cat = SCENARIO_CATEGORY[f.scenarioId] || "operational"
            out.byCategory[cat] = (out.byCategory[cat] || 0) + 1
            interestingFires.push(f)
        }

        // K9 — attention-score sort when available; fall back to severity.
        let ranked
        if (window.AesConductorAttention && typeof window.AesConductorAttention.sortFires === "function") {
            ranked = window.AesConductorAttention.sortFires(interestingFires, trustByScenario, fireUxSettings, Date.now())
        } else {
            const sevWeight = (s) => s === "alert" ? 3 : s === "warn" ? 2 : 1
            ranked = interestingFires.slice().sort((a, b) => {
                const sw = sevWeight(b.severity || "info") - sevWeight(a.severity || "info")
                if (sw !== 0) return sw
                return (b.firedAt || 0) - (a.firedAt || 0)
            })
        }
        const candidates = ranked.map(f => ({
            fireId:      f.id,
            scenarioId:  f.scenarioId,
            label:       f.label || f.scenarioId,
            severity:    String(f.severity || "info"),
            category:    SCENARIO_CATEGORY[f.scenarioId] || "operational",
            rationale:   f.rationale || "",
            firedAt:     f.firedAt || 0,
            openUrl:     (f.payload && f.payload.openUrl) || null
        }))
        out.fires = candidates.slice(0, 5)
        out.count = candidates.length

        const recent = (proposals || []).slice(-10).reverse()
        out.driftProposals = recent.map(p => ({
            scenarioId: p.scenarioId,
            key:        p.key,
            current:    p.current,
            proposed:   p.proposed,
            reason:     p.reason || "",
            createdAt:  p.createdAt || 0,
            accepted:   !!p.accepted
        }))
        return out
    }

    async function _safeConductorFires(host) {
        try {
            if (window.AesConductorScenarioStore
                    && typeof window.AesConductorScenarioStore.all === "function") {
                const r = await window.AesConductorScenarioStore.all(host)
                return Array.isArray(r) ? r : []
            }
            const key = "aesConductor:fires:" + host.server + ":" + (host.airline || "")
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return Array.isArray(v) ? v : []
        } catch (_) { return [] }
    }

    async function _safeDriftProposals(host) {
        try {
            const key = "aesConductor:driftProposals:" + host.server + ":" + (host.airline || "")
            const blob = await chrome.storage.local.get([key])
            const v = blob && blob[key]
            return Array.isArray(v) ? v : []
        } catch (_) { return [] }
    }

    /** K9 — pre-fetch trust posterior map; gracefully degrade to {} so the
     *  fallback severity sort still works. */
    async function _safeTrustLoad(host) {
        try {
            if (window.AesConductorTrustStore && typeof window.AesConductorTrustStore.load === "function") {
                const r = await window.AesConductorTrustStore.load(host)
                return (r && typeof r === "object") ? r : {}
            }
        } catch (_) { /* noop */ }
        return {}
    }

    /** K9 — pre-fetch the per-fire UX settings (pin/snooze) for the
     *  attention scorer. Returns {fireUx: {}} when storage is unavailable. */
    async function _safeFireUxSettings(host) {
        try {
            if (window.AesConductorAttention && typeof window.AesConductorAttention.readFireUxSettings === "function") {
                const r = await window.AesConductorAttention.readFireUxSettings(host)
                return r || {fireUx: {}}
            }
        } catch (_) { /* noop */ }
        return {fireUx: {}}
    }

    // ── Defensive readers ───────────────────────────────────────────────

    async function _safeAggregator(sinceMs) {
        if (!window.AesChangeLogAggregator
            || typeof window.AesChangeLogAggregator.loadAll !== "function") return []
        try {
            return await window.AesChangeLogAggregator.loadAll({
                sinceMs: sinceMs,
                domains: ["pricing", "service-profile", "flight-numbers", "strategy", "auto-scheduler"],
                limit:   200
            })
        } catch (_) { return [] }
    }

    async function _safeOutcomes(accountId) {
        if (!window.AesStrategyOutcomes || typeof window.AesStrategyOutcomes.loadAll !== "function") return []
        try { return await window.AesStrategyOutcomes.loadAll(accountId) }
        catch (_) { return [] }
    }

    async function _safeJournal(accountId) {
        if (!window.AesStrategyJournal || typeof window.AesStrategyJournal.loadAll !== "function") return []
        try { return await window.AesStrategyJournal.loadAll(accountId) }
        catch (_) { return [] }
    }

    async function _safeWeightHistory(accountId) {
        if (!window.AesStrategyLearn || typeof window.AesStrategyLearn.getHistory !== "function") return []
        try { return await window.AesStrategyLearn.getHistory(accountId) }
        catch (_) { return [] }
    }

    window.AesStrategyBriefing = {
        buildBriefing: buildBriefing,
        // Pure helpers exported for the tile's inline rendering + tests.
        _buildAppliedItems:  _buildAppliedItems,
        _largestDrift:       _largestDrift,
        _topOpportunities:   _topOpportunities,
        _buildRisk:          _buildRisk,
        _buildRiskRegister:  _buildRiskRegister,
        _driftTone:          _driftTone,
        SCENARIO_CATEGORY:   SCENARIO_CATEGORY
    }
})()
