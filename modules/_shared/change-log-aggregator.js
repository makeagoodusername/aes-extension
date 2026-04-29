"use strict"

/**
 * Cross-domain change-log aggregator.
 *
 * Virtual log — no new storage. At call time, fans out reads to every
 * registered domain's existing audit/apply log in parallel, normalises each
 * entry into a unified `UnifiedEntry` envelope, merges by ts desc, returns
 * a bounded slice. Per-domain logs remain canonical; each adapter is a
 * one-way mapping from the source schema to the unified shape.
 *
 * Why virtual: the four sources have different write paths (pricing,
 * service-profile, flight-numbers, strategy) and different retention
 * policies. A physical mirror would mean every applier opts into a second
 * write and a migration story for legacy entries. The aggregator dodges all
 * that — adding a new domain is one new adapter (no schema change to
 * existing logs).
 *
 * Public API:
 *   AesChangeLogAggregator.loadAll({sinceMs, domains, limit})
 *     → Promise<UnifiedEntry[]>
 *
 *   AesChangeLogAggregator.loadByPair({hub, dest, sinceMs, domains, limit})
 *     → Promise<UnifiedEntry[]>
 *     Filters entries whose `scope.hub` and `scope.dest` match. Domains that
 *     don't carry hub/dest scope (e.g., flight-numbers keyed by aircraftId)
 *     are skipped from the by-pair view entirely.
 *
 *   AesChangeLogAggregator.DOMAINS
 *     → ["pricing", "service-profile", "flight-numbers", "strategy"]
 *
 * UnifiedEntry shape:
 *   {
 *     id:       "<domain>:<sourceId>",       // collision-safe across domains
 *     ts:       <ms epoch>,
 *     domain:   "pricing" | "service-profile" | "flight-numbers" | "strategy",
 *     source:   "manual" | "silent-auto" | "sandbox" | "batch" | "strategy" | "auto-scheduler" | "tile" | ...,
 *     scope:    { hub?, dest?, tail?, profileId?, planId?, routeKey? },
 *     status:   "verified" | "posted" | "dry-run" | "failed" | "aborted" | "skipped" | <domain-specific>,
 *     summary:  "<short human-readable sentence>",
 *     prev:     <opaque, domain-specific>,
 *     next:     <opaque, domain-specific>,
 *     reason:   <string?>,
 *     dryRun:   <bool?>,
 *     count:    <int? — 1 for non-deduped>,
 *     raw:      <pointer to source's original entry — for the audit modal's
 *               "show full envelope" affordance>
 *   }
 *
 * Adding a new domain:
 *   1. Add an adapter function in the ADAPTERS table below — name keys by
 *      the domain string. Adapter signature:
 *        async (opts) → UnifiedEntry[]
 *      where opts is the same envelope passed to loadAll/loadByPair.
 *   2. Push the new domain string into DOMAINS at the top of the file.
 *   3. Ensure the new domain's storage script loads BEFORE this module in
 *      manifest.json (so its static keys are accessible). Most adapters
 *      use bare key strings to avoid the load-order dependency.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesChangeLogAggregator) return

    const DOMAINS = [
        "pricing", "service-profile", "flight-numbers", "strategy",
        "auto-scheduler", "afp-audit", "competitor-intel",
        "service-experiment"
    ]

    const PRICING_KEY        = "routeAssistant:pricingApplyLog"
    const SERVICE_KEY        = "routeAssistant:serviceProfileApplyLog"
    const FLIGHT_NUM_KEY     = "aircraftFlightPlan:fnApplyLog"
    const STRATEGY_KEY       = "aesStrategy:audit"
    const AUTO_SCHEDULER_KEY = "aircraftFlightPlan:autoApplyLog"
    const AFP_AUDIT_KEY      = "aircraftFlightPlan:auditLog"
    const COMPETITOR_KEY     = "competitorIntel:snapshots:"  // prefix, not a single key
    const SERVICE_EXP_KEY    = "aesStrategy:serviceExperiments"  // also matches :acct:* via prefix scan

    /**
     * Storage keys watched by the modal's live-update listener. Exported so
     * the consumer (panel.js) can register a single chrome.storage.onChanged
     * handler and refresh whenever any source mutates.
     */
    const SOURCE_KEYS = [
        PRICING_KEY, SERVICE_KEY, FLIGHT_NUM_KEY, STRATEGY_KEY,
        AUTO_SCHEDULER_KEY, AFP_AUDIT_KEY,
        // Trailing colon stays — modal's onStorage scans for prefix matches
        // ("k.startsWith(sk + ':')") so this entry covers every per-server,
        // per-enterprise snapshot key.
        COMPETITOR_KEY,
        // Bare key + per-account scope both share this prefix; the modal's
        // prefix matcher handles `aesStrategy:serviceExperiments` and
        // `aesStrategy:serviceExperiments:acct:<id>` alike.
        SERVICE_EXP_KEY
    ]

    const DEFAULT_LIMIT = 1000

    /**
     * Pricing adapter — 1:1 mapping from RouteAssistantPricingApplyLog
     * entries. The pricing log already carries the richest envelope
     * (dryRun, batchId, undone, prev/new/verifiedPrices); we just
     * normalise the field names + build a per-class delta summary.
     */
    async function _pricingAdapter() {
        const got = await chrome.storage.local.get([PRICING_KEY]).catch(() => ({}))
        const rec = got[PRICING_KEY]
        if (!rec || !Array.isArray(rec.entries)) return []
        return rec.entries.map(e => {
            if (!e) return null
            const prev = e.prevPrices || {}
            const next = e.newPrices || e.verifiedPrices || e.requestedPrices || {}
            return {
                id:       "p:" + (e.id || (e.ts + ":" + (e.hub || "?") + ":" + (e.dest || "?"))),
                ts:       e.ts || 0,
                domain:   "pricing",
                source:   e.source || "manual",
                scope:    {
                    hub:      e.hub || null,
                    dest:     e.dest || null,
                    routeKey: (e.hub && e.dest) ? (e.hub + "-" + e.dest) : null
                },
                status:   e.status || "unknown",
                summary:  _summarisePricingDelta(prev, next),
                prev,
                next,
                reason:   e.reason || null,
                dryRun:   !!e.dryRun,
                count:    isFinite(e.count) ? e.count : 1,
                raw:      e
            }
        }).filter(Boolean)
    }

    /**
     * Service-profile adapter. Profile changes are keyed by `profileId` (an
     * AS service-profile primary key), not hub/dest, so the by-pair view
     * skips this domain entirely. Summary names changed amenities + Δ.
     */
    async function _serviceProfileAdapter() {
        const got = await chrome.storage.local.get([SERVICE_KEY]).catch(() => ({}))
        const rec = got[SERVICE_KEY]
        if (!rec || !Array.isArray(rec.entries)) return []
        return rec.entries.map(e => {
            if (!e) return null
            return {
                id:       "s:" + (e.id || (e.ts + ":" + (e.profileId || "?"))),
                ts:       e.ts || 0,
                domain:   "service-profile",
                source:   e.source || "tile",
                scope:    {profileId: e.profileId != null ? Number(e.profileId) : null},
                status:   e.status || "unknown",
                summary:  _summariseServiceChanges(e.requestedChanges || e.newValues || {}, e.prevValues || {}),
                prev:     e.prevValues || null,
                next:     e.newValues || e.verifiedValues || null,
                reason:   null,
                dryRun:   !!e.dryRun,
                count:    isFinite(e.count) ? e.count : 1,
                raw:      e
            }
        }).filter(Boolean)
    }

    /**
     * Flight-numbers adapter. Keyed per (server, aircraftId). The leg's
     * destination IATA — when present — is hoisted into scope.dest so the
     * by-pair filter can match a route's flight-number rewrites alongside
     * its pricing changes.
     */
    async function _flightNumbersAdapter() {
        const got = await chrome.storage.local.get([FLIGHT_NUM_KEY]).catch(() => ({}))
        const rec = got[FLIGHT_NUM_KEY]
        if (!rec || !Array.isArray(rec.entries)) return []
        return rec.entries.map(e => {
            if (!e) return null
            const leg = e.leg || {}
            return {
                id:       "fn:" + (e.id || (e.ts + ":" + (e.aircraftId || "?"))),
                ts:       e.ts || 0,
                domain:   "flight-numbers",
                source:   e.source || "manual",
                scope:    {
                    hub:        leg.from || null,
                    dest:       leg.to   || null,
                    routeKey:   (leg.from && leg.to) ? (leg.from + "-" + leg.to) : null,
                    tail:       e.aircraftId || null,
                    server:     e.server || null,
                    equipment:  e.equipment || null,
                    registration: e.registration || null
                },
                status:   e.status || "unknown",
                summary:  _summariseFlightNumberChange(leg, e),
                prev:     null,
                next:     leg,
                reason:   e.reason || null,
                dryRun:   e.status === "dry-run",
                count:    isFinite(e.count) ? e.count : 1,
                raw:      e
            }
        }).filter(Boolean)
    }

    /**
     * Strategy audit adapter. The strategy audit ring stores ONE entry per
     * `apply()` call, where each entry's `report.applied[]` describes the
     * sub-decisions actually applied (could be 0–N across domains). For
     * the unified view we surface the run as a single event with the
     * applied/skipped tallies — drilling into individual sub-decisions is
     * already covered by the per-domain logs (a strategy-driven price move
     * lands in `pricingApplyLog` with `source: "strategy"`).
     */
    async function _strategyAdapter() {
        const got = await chrome.storage.local.get([STRATEGY_KEY]).catch(() => ({}))
        const ring = Array.isArray(got[STRATEGY_KEY]) ? got[STRATEGY_KEY] : []
        return ring.map(e => {
            if (!e) return null
            const report = e.report || {}
            const totals = report.totals || {}
            return {
                id:       "st:" + ((e.planId || "noplan") + ":" + (e.ts || 0)),
                ts:       e.ts || 0,
                domain:   "strategy",
                source:   e.source || "strategy",
                scope:    {
                    planId:      e.planId || null,
                    server:      e.server || null,
                    airlineCode: e.airlineCode || null,
                    accountId:   e.accountId || null
                },
                status:   _strategyStatus(report),
                summary:  _summariseStrategyRun(report),
                prev:     null,
                next:     null,
                reason:   report.objective ? ("objective: " + report.objective) : null,
                dryRun:   report.tier === "dry-run" || report.tier === 1,
                count:    1,
                raw:      e
            }
        }).filter(Boolean)
    }

    /**
     * Auto-scheduler adapter (`aircraftFlightPlan:autoApplyLog`). Each entry
     * is either a per-leg result (status: ok/failed/aborted) or a batch
     * lifecycle event (queued/started/done/error/queue-dismissed). Per-leg
     * entries carry origin/dest IATAs which we hoist into scope.hub +
     * scope.dest so the by-pair filter works for them; lifecycle entries
     * fall through with hub-only scope.
     */
    async function _autoSchedulerAdapter() {
        const got = await chrome.storage.local.get([AUTO_SCHEDULER_KEY]).catch(() => ({}))
        const rec = got[AUTO_SCHEDULER_KEY]
        if (!rec || !Array.isArray(rec.entries)) return []
        return rec.entries.map(e => {
            if (!e) return null
            const isLeg = e.origin && e.dest
            return {
                id:       "as:" + (e.id || (e.ts + ":" + (e.aircraftId || "?"))),
                ts:       e.ts || 0,
                domain:   "auto-scheduler",
                source:   e.source || "auto-scheduler",
                scope:    {
                    hub:        isLeg ? e.origin : (e.hub || null),
                    dest:       isLeg ? e.dest   : null,
                    routeKey:   isLeg ? (e.origin + "-" + e.dest) : null,
                    tail:       e.aircraftId || null,
                    server:     e.server || null,
                    batchId:    e.batchId || null
                },
                status:   e.status || "unknown",
                summary:  _summariseAutoSchedulerEntry(e),
                prev:     null,
                next:     isLeg ? {flightSeq: e.seq, depTime: e.depTime, pricePct: e.pricePct, service: e.service} : null,
                reason:   e.error || null,
                dryRun:   false,
                count:    1,
                raw:      e
            }
        }).filter(Boolean)
    }

    /**
     * AFP audit-log adapter (`aircraftFlightPlan:auditLog`). Captures
     * coarser-grained AFP events than the auto-scheduler — flight-plan
     * mutations, service edits, manual overrides — keyed per (server,
     * aircraftId). When the entry references a (hub, dest) pair, the
     * by-pair view picks it up alongside that route's pricing changes.
     */
    async function _afpAuditAdapter() {
        const got = await chrome.storage.local.get([AFP_AUDIT_KEY]).catch(() => ({}))
        const rec = got[AFP_AUDIT_KEY]
        if (!rec || !Array.isArray(rec.entries)) return []
        return rec.entries.map(e => {
            if (!e) return null
            return {
                id:       "afp:" + (e.id || (e.ts + ":" + (e.aircraftId || "?"))),
                ts:       e.ts || 0,
                domain:   "afp-audit",
                source:   e.source || "afp",
                scope:    {
                    hub:        e.hub || null,
                    dest:       e.dest || null,
                    routeKey:   (e.hub && e.dest) ? (e.hub + "-" + e.dest) : null,
                    tail:       e.aircraftId || null,
                    server:     e.server || null,
                    registration: e.registration || null
                },
                status:   "applied",
                summary:  _summariseAfpAuditEntry(e),
                prev:     null,
                next:     {pricePct: e.pricePct, service: e.service, depTime: e.depTime},
                reason:   null,
                dryRun:   false,
                count:    1,
                raw:      e
            }
        }).filter(Boolean)
    }

    /**
     * Competitor-intel adapter — delegates to the standalone module
     * `modules/competitor-intel/change-log-adapter.js`. Returns [] when
     * the module hasn't loaded (e.g. on pages that don't bundle the
     * canopy stack), keeping the aggregator robust to load-order skew.
     */
    async function _competitorIntelAdapter(opts) {
        if (!window.AesCompetitorChangeLogAdapter) return []
        return window.AesCompetitorChangeLogAdapter.load(opts || {})
    }

    /**
     * Service-experiment adapter — delegates to the standalone module
     * `modules/strategy/service-experiment-change-log-adapter.js`. Returns
     * [] when the module isn't loaded so the aggregator stays robust on
     * pages that don't bundle the strategy stack.
     */
    async function _serviceExperimentAdapter(opts) {
        if (!window.AesServiceExperimentChangeLogAdapter) return []
        return window.AesServiceExperimentChangeLogAdapter.load(opts || {})
    }

    const ADAPTERS = {
        "pricing":            _pricingAdapter,
        "service-profile":    _serviceProfileAdapter,
        "flight-numbers":     _flightNumbersAdapter,
        "strategy":           _strategyAdapter,
        "auto-scheduler":     _autoSchedulerAdapter,
        "afp-audit":          _afpAuditAdapter,
        "competitor-intel":   _competitorIntelAdapter,
        "service-experiment": _serviceExperimentAdapter
    }

    /**
     * Run every requested adapter in parallel and merge results desc by ts.
     * `domains` defaults to all known domains; `limit` defaults to 1000
     * (sum across domains, applied AFTER merge). `sinceMs` filters before
     * merge so a stale strategy ring (older entries) doesn't dilute the
     * effective limit.
     */
    async function loadAll(opts) {
        opts = opts || {}
        const want = Array.isArray(opts.domains) && opts.domains.length
            ? opts.domains.filter(d => ADAPTERS[d])
            : DOMAINS
        const sinceMs = isFinite(opts.sinceMs) ? opts.sinceMs : 0
        const limit = isFinite(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT
        const lists = await Promise.all(want.map(d => ADAPTERS[d](opts).catch(e => {
            console.warn("[AES change-log] adapter " + d + " threw", e)
            return []
        })))
        const all = []
        for (const list of lists) {
            for (const e of list) {
                if (!e || !isFinite(e.ts)) continue
                if (sinceMs > 0 && e.ts < sinceMs) continue
                all.push(e)
            }
        }
        all.sort((a, b) => (b.ts || 0) - (a.ts || 0))
        return all.slice(0, limit)
    }

    /**
     * Filter merged entries to those that scope to a specific (hub, dest)
     * pair. Service-profile + strategy carry no such scope, so they're
     * implicitly excluded — same as a domain filter that selects only
     * pricing + flight-numbers.
     */
    async function loadByPair(opts) {
        opts = opts || {}
        if (!opts.hub || !opts.dest) return []
        const hub = String(opts.hub).toUpperCase()
        const dest = String(opts.dest).toUpperCase()
        const list = await loadAll(Object.assign({}, opts, {
            domains: opts.domains || ["pricing", "flight-numbers"]
        }))
        return list.filter(e => {
            const sh = e.scope && e.scope.hub  ? String(e.scope.hub).toUpperCase()  : null
            const sd = e.scope && e.scope.dest ? String(e.scope.dest).toUpperCase() : null
            return sh === hub && sd === dest
        })
    }

    // ── Summary builders ─────────────────────────────────────────────────

    function _summarisePricingDelta(prev, next) {
        const parts = []
        for (const cls of ["Y", "C", "F", "Cargo"]) {
            const p = prev[cls], n = next[cls]
            if (p == null && n == null) continue
            if (p == null || n == null) {
                parts.push(cls + " " + (p != null ? p : "?") + "→" + (n != null ? n : "?"))
                continue
            }
            const d = n - p
            if (!d) continue
            parts.push(cls + " " + p + "→" + n + " (" + (d > 0 ? "+" : "") + d + ")")
        }
        return parts.length ? parts.join(" · ") : "no change"
    }

    function _summariseServiceChanges(changes, prev) {
        const out = []
        for (const cat in (changes || {})) {
            const cls = changes[cat] || {}
            for (const k in cls) {
                if (cls[k] == null) continue
                const before = (prev && prev[cat] && prev[cat][k] != null) ? prev[cat][k] : "?"
                out.push(cat + "/" + k + " " + before + "→" + cls[k])
            }
        }
        if (!out.length) return "no change"
        if (out.length > 4) return out.slice(0, 4).join(" · ") + " · +" + (out.length - 4) + " more"
        return out.join(" · ")
    }

    function _summariseFlightNumberChange(leg, e) {
        const fn = leg && leg.flightNumber
        const route = leg && leg.from && leg.to ? leg.from + "→" + leg.to : "?"
        const tail = e && e.registration ? " (" + e.registration + ")" : ""
        if (fn) return "FN " + fn + " · " + route + tail
        return route + tail
    }

    function _summariseStrategyRun(report) {
        const t = report.totals || {}
        const ok = isFinite(t.ok) ? t.ok : 0
        const failed = isFinite(t.failed) ? t.failed : 0
        const skipped = isFinite(t.skipped) ? t.skipped : 0
        const pieces = []
        pieces.push(ok + " applied")
        if (failed)  pieces.push(failed  + " failed")
        if (skipped) pieces.push(skipped + " skipped")
        if (report.aborted) pieces.push("aborted: " + (report.abortReason || "unspecified"))
        return pieces.join(" · ")
    }

    function _strategyStatus(report) {
        if (!report) return "unknown"
        if (report.aborted) return "aborted"
        const t = report.totals || {}
        if (t.failed && !t.ok) return "failed"
        if (t.ok) return "verified"
        return "skipped"
    }

    function _summariseAutoSchedulerEntry(e) {
        // Per-leg entries.
        if (e.origin && e.dest) {
            const route = e.origin + "→" + e.dest
            const seq   = e.seq != null ? "#" + e.seq : ""
            const dep   = e.depTime ? " " + e.depTime : ""
            const px    = isFinite(e.pricePct) ? " · " + e.pricePct + "%" : ""
            return [route, seq, dep].filter(Boolean).join(" ").trim() + px
        }
        // Batch lifecycle entries.
        const t  = isFinite(e.total) ? e.total : null
        const ok = isFinite(e.succeeded) ? e.succeeded : null
        const f  = isFinite(e.failed) ? e.failed : null
        const tail = e.aircraftId ? " · tail " + e.aircraftId : ""
        if (e.status === "queued")          return "batch queued · " + (t || "?") + " legs" + tail
        if (e.status === "started")         return "batch started" + tail
        if (e.status === "done")            return "batch done · " + (ok || 0) + "/" + (t || 0) + " ok"
                                                + (f ? " · " + f + " failed" : "") + tail
        if (e.status === "error")           return "batch error" + (e.error ? " · " + e.error : "") + tail
        if (e.status === "aborted")         return "batch aborted" + tail
        if (e.status === "queue-dismissed") return "queue dismissed" + tail
        return (e.status || "event") + tail
    }

    function _summariseAfpAuditEntry(e) {
        const tail = e.registration ? "(" + e.registration + ")" : "tail " + (e.aircraftId || "?")
        const route = (e.hub && e.dest) ? (e.hub + "→" + e.dest) : ""
        const dep = e.depTime ? " " + e.depTime : ""
        const action = e.action || "edit"
        const px = isFinite(e.pricePct) ? " · " + e.pricePct + "%" : ""
        return [action, route, dep, tail].filter(Boolean).join(" ").trim() + px
    }

    /**
     * Best-effort detection of the route the current AS page is scoped to.
     * Used by the change-log modal to pre-fill its search filter when the
     * user opens the modal from a route-specific page (markets / route
     * overview), so they don't have to type the route they're already
     * looking at. Returns null on non-route pages (dashboard, finance,
     * inventory, fleet listing, …).
     *
     * Sources, in order:
     *   1. URL path:   /app/info/marketrouteoverview/<HUB>-<DEST>/
     *                  /app/com/markets/<HUB>-<DEST>/...
     *                  /app/com/markets/edit/.../?from=<HUB>&to=<DEST>
     *   2. URL query string `from`+`to` (case-insensitive)
     *   3. RA panel's currently-selected row, if exposed
     *      (`window.RouteAssistantPanel.getActiveRoute()`)
     *
     * IATA matcher is forgiving: 3 letters, optionally with digits
     * (some cargo/charter codes), uppercase-on-output. Bails on anything
     * that doesn't look IATA-shaped (e.g. file extensions, ids).
     */
    function detectActiveRoute() {
        try {
            const loc = (typeof window !== "undefined" && window.location) ? window.location : null
            if (loc) {
                const path = loc.pathname || ""
                // Match /<HUB>-<DEST>/ where HUB/DEST are 3-letter IATA-ish
                const m = path.match(/\/([A-Z]{3})-([A-Z]{3})(?:\/|$)/i)
                if (m) {
                    return {hub: m[1].toUpperCase(), dest: m[2].toUpperCase()}
                }
                const params = new URLSearchParams(loc.search || "")
                const from = params.get("from") || params.get("hub")
                const to   = params.get("to")   || params.get("dest")
                if (from && to && /^[A-Z]{3}$/i.test(from) && /^[A-Z]{3}$/i.test(to)) {
                    return {hub: from.toUpperCase(), dest: to.toUpperCase()}
                }
            }
            const panel = (typeof window !== "undefined") ? window.RouteAssistantPanel : null
            if (panel && typeof panel.getActiveRoute === "function") {
                const r = panel.getActiveRoute()
                if (r && r.hub && r.dest) {
                    return {hub: String(r.hub).toUpperCase(), dest: String(r.dest).toUpperCase()}
                }
            }
        } catch (_) { /* non-fatal */ }
        return null
    }

    /**
     * Phase D3 — virtual section: in-flight service-profile A/B experiments.
     * These are not "applied changes" but they share the modal's mental
     * model: a record of strategy activity. Returns UnifiedEntry-shaped
     * rows tagged `domain: "service-experiment-active"` so renderers can
     * style them differently from concluded entries.
     */
    async function loadActiveExperiments() {
        const store = window.AesServiceExperimentStore
        if (!store || typeof store.active !== "function") return []
        try {
            const rows = await store.active()
            return (rows || []).filter(Boolean).map(r => ({
                id:       "se-active:" + r.experimentId,
                ts:       r.startedAt || 0,
                domain:   "service-experiment-active",
                source:   "tuner",
                scope:    {profileId: r.baseProfileId != null ? Number(r.baseProfileId) : null},
                status:   "active",
                summary:  (r.baseProfileName || ("#" + r.baseProfileId))
                          + " · perturb " + (r.perturbationProfileName || "?")
                          + (r.expectedConcludeAt
                              ? " · concludes "
                                + new Date(r.expectedConcludeAt).toISOString().slice(0, 10)
                              : ""),
                prev:     null,
                next:     null,
                reason:   null,
                dryRun:   false,
                count:    1,
                raw:      r
            }))
        } catch (e) {
            console.warn("[AES change-log] loadActiveExperiments threw", e)
            return []
        }
    }

    /**
     * Phase D3 — virtual section: pending decision-dispatch requests.
     * Reads `aesStrategy:dispatchPending` via the decision-dispatch
     * facade. Pending entries have no `applied` flag yet. Already-applied
     * payloads are filtered out (decision-dispatch.applyPending sets
     * `applied: true` on the storage payload).
     */
    async function loadPendingDispatches() {
        const dispatch = window.AesStrategyDecisionDispatch
        if (!dispatch || typeof dispatch.readPending !== "function") return []
        try {
            const p = await dispatch.readPending()
            if (!p || p.applied) return []
            return [{
                id:       "dp:" + (p.requestedAt || 0),
                ts:       p.requestedAt || 0,
                domain:   "dispatch-pending",
                source:   p.source || "compass",
                scope:    {hub: p.hub || null, dest: p.dest || null,
                           routeKey: (p.hub && p.dest) ? (p.hub + "-" + p.dest) : null},
                status:   p.failed ? "failed" : "pending",
                summary:  (p.hub || "?") + " → " + (p.dest || "?")
                          + " · " + (p.classKey || "?")
                          + (isFinite(p.toPct) ? " → " + p.toPct + "%" : "")
                          + (p.failed ? " · " + p.failed : ""),
                prev:     null,
                next:     null,
                reason:   p.failed || null,
                dryRun:   false,
                count:    1,
                raw:      p
            }]
        } catch (e) {
            console.warn("[AES change-log] loadPendingDispatches threw", e)
            return []
        }
    }

    window.AesChangeLogAggregator = {
        DOMAINS,
        SOURCE_KEYS,
        loadAll,
        loadByPair,
        loadActiveExperiments,
        loadPendingDispatches,
        detectActiveRoute
    }
})()
