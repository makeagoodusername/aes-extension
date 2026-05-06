"use strict"

/**
 * RouteAssistantOrsIntelligence
 *
 * Shared facade over the ORS cache and sync pipeline. It keeps the
 * canonical `routeAssistant:ors:acct:<id>:<HUB>-<DEST>` / legacy fallback
 * behaviour in RouteAssistantOrsScraper, but gives dashboard, competitor,
 * canvas, strategy, and orchestrator callers one validated read/planning
 * surface instead of ad hoc key walking.
 */
class RouteAssistantOrsIntelligence {
    static HEALTH_PREFIX = "routeAssistant:orsHealth"
    static DEFAULT_CLASSES = ["ECONOMY", "BUSINESS", "FIRST", "CARGO"]
    static DEFAULT_STALE_MS = 7 * 86400000
    static DEFAULT_COOLDOWN_MS = 10 * 60 * 1000
    static DEFAULT_STAGGER_MS = 500
    static DEFAULT_CONCURRENCY = 4

    constructor(server, opts) {
        opts = opts || {}
        this.server = server || opts.server || RouteAssistantOrsIntelligence._currentServer()
        this.settings = opts.settings || null
        this.scraper = opts.scraper || null
        this.routeSync = opts.routeSync || null
    }

    static _currentServer() {
        try {
            if (typeof AES !== "undefined" && AES.getServerName) return AES.getServerName() || ""
        } catch (_) {}
        try {
            if (typeof location !== "undefined") {
                const m = String(location.hostname || "").match(/^([^.]+)\.airlinesim\.aero$/)
                if (m) return m[1]
            }
        } catch (_) {}
        return ""
    }

    static _accountId() {
        try {
            if (typeof currentAccountIdSync === "function") return currentAccountIdSync()
        } catch (_) {}
        try {
            if (window.AesAccountKey && typeof window.AesAccountKey.currentAccountIdSync === "function") {
                return window.AesAccountKey.currentAccountIdSync()
            }
        } catch (_) {}
        return null
    }

    static _acctKey(prefix, suffix) {
        try {
            if (typeof acctKey === "function") return acctKey(prefix, suffix)
        } catch (_) {}
        try {
            if (window.AesAccountKey && typeof window.AesAccountKey.acctKey === "function") {
                return window.AesAccountKey.acctKey(prefix, suffix)
            }
        } catch (_) {}
        return prefix + (suffix ? ":" + suffix : "")
    }

    static _orsScraperCtor() {
        if (typeof RouteAssistantOrsScraper !== "undefined") return RouteAssistantOrsScraper
        if (typeof window !== "undefined" && window.RouteAssistantOrsScraper) return window.RouteAssistantOrsScraper
        return null
    }

    static _routeSyncCtor() {
        if (typeof RouteAssistantRouteSync !== "undefined") return RouteAssistantRouteSync
        if (typeof window !== "undefined" && window.RouteAssistantRouteSync) return window.RouteAssistantRouteSync
        return null
    }

    static _pairKey(hub, dest) {
        const h = String(hub || "").toUpperCase()
        const d = String(dest || "").toUpperCase()
        return h && d ? h + "-" + d : ""
    }

    static _routeFromAny(route) {
        if (!route) return null
        const hub = String(route.hub || route.origin || route.hubIata || "").toUpperCase()
        const dest = String(route.dest || route.destination || route.destIata || route.iata || "").toUpperCase()
        if (!hub || !dest || hub === dest) return null
        return Object.assign({}, route, {hub, dest, pairKey: hub + "-" + dest})
    }

    static _normaliseRoutes(routes) {
        const out = []
        const seen = new Set()
        for (const raw of routes || []) {
            const r = RouteAssistantOrsIntelligence._routeFromAny(raw)
            if (!r || seen.has(r.pairKey)) continue
            seen.add(r.pairKey)
            out.push(r)
        }
        return out
    }

    static _orsSettings(policy) {
        const p = policy || {}
        if (p.ors) return p.ors
        const s = p.settings || {}
        return s.ors || s.routeAssistant && s.routeAssistant.ors || {}
    }

    static _classes(policy) {
        const cfg = RouteAssistantOrsIntelligence._orsSettings(policy)
        const val = (policy && policy.classesToScrape) || cfg.classesToScrape
        const list = Array.isArray(val) && val.length ? val : RouteAssistantOrsIntelligence.DEFAULT_CLASSES
        const seen = new Set()
        const out = []
        for (const c of list) {
            const u = String(c || "").toUpperCase()
            if (!u || seen.has(u)) continue
            seen.add(u)
            out.push(u)
        }
        return out.length ? out : RouteAssistantOrsIntelligence.DEFAULT_CLASSES.slice()
    }

    static _staleMs(policy) {
        if (policy && isFinite(policy.staleMs)) return Math.max(0, Number(policy.staleMs))
        const cfg = RouteAssistantOrsIntelligence._orsSettings(policy)
        if (isFinite(cfg.rankMaxAgeDays) && Number(cfg.rankMaxAgeDays) > 0) {
            return Number(cfg.rankMaxAgeDays) * 86400000
        }
        if (policy && isFinite(policy.maxAgeDays) && Number(policy.maxAgeDays) > 0) {
            return Number(policy.maxAgeDays) * 86400000
        }
        return RouteAssistantOrsIntelligence.DEFAULT_STALE_MS
    }

    static _healthKey(server) {
        const suffix = "server:" + String(server || "unknown")
        return RouteAssistantOrsIntelligence._acctKey(RouteAssistantOrsIntelligence.HEALTH_PREFIX, suffix)
    }

    static async loadHealth(server) {
        const key = RouteAssistantOrsIntelligence._healthKey(server || RouteAssistantOrsIntelligence._currentServer())
        const out = await chrome.storage.local.get([key])
        return out[key] || null
    }

    static async saveHealth(server, patch) {
        const key = RouteAssistantOrsIntelligence._healthKey(server || RouteAssistantOrsIntelligence._currentServer())
        const prior = await RouteAssistantOrsIntelligence.loadHealth(server) || {}
        const rec = Object.assign({}, prior, RouteAssistantOrsIntelligence._boundedHealthPatch(patch || {}), {
            server: String(server || prior.server || RouteAssistantOrsIntelligence._currentServer() || ""),
            accountId: RouteAssistantOrsIntelligence._accountId(),
            updatedAt: Date.now()
        })
        await chrome.storage.local.set({[key]: rec})
        if (typeof window !== "undefined" && window.AesDataBus && typeof window.AesDataBus.emit === "function") {
            window.AesDataBus.emit("data:route-assistant:ors:health", rec)
        }
        return rec
    }

    static _boundedHealthPatch(patch) {
        const next = Object.assign({}, patch || {})
        for (const key of ["missingRoutes", "staleRoutes", "failedRoutes", "warningRoutes"]) {
            if (Array.isArray(next[key]) && next[key].length > 100) next[key] = next[key].slice(0, 100)
        }
        if (next.coverage && typeof next.coverage === "object") {
            next.coverage = RouteAssistantOrsIntelligence._compactCoverage(next.coverage)
        }
        return next
    }

    static _breaker(policy, health) {
        const cfg = RouteAssistantOrsIntelligence._orsSettings(policy)
        const trippedAt = Number(cfg.circuitBreakerTrippedAt)
            || Number(health && health.breaker && health.breaker.trippedAt)
            || 0
        const cooldownMs = Number(cfg.circuitBreakerCooldownMs)
            || Number(health && health.breaker && health.breaker.cooldownMs)
            || RouteAssistantOrsIntelligence.DEFAULT_COOLDOWN_MS
        const remainingMs = trippedAt ? Math.max(0, cooldownMs - (Date.now() - trippedAt)) : 0
        return {
            trippedAt: trippedAt || null,
            cooldownMs,
            active: remainingMs > 0,
            remainingMs
        }
    }

    static _classCaptured(rec, cls) {
        const cr = rec && rec.byClass && rec.byClass[cls]
        return !!(cr && typeof cr.totalConnections === "number")
    }

    static _classUsable(rec, cls) {
        const cr = rec && rec.byClass && rec.byClass[cls]
        return !!(cr && Array.isArray(cr.connections) && cr.connections.length)
    }

    static _recordAgeMs(rec) {
        const ts = rec && Number(rec.scrapedAt)
        return isFinite(ts) && ts > 0 ? Math.max(0, Date.now() - ts) : Infinity
    }

    static _isScheduleFlown(rec) {
        if (!rec) return false
        if (Number(rec.weeklyFlights) > 0 || Number(rec.frequency) > 0) return true
        return Array.isArray(rec.flights) && rec.flights.length > 0
    }

    static _ownMatchCount(rec) {
        let matched = 0
        const byClass = rec && rec.byClass || {}
        for (const cls in byClass) {
            const od = byClass[cls] && byClass[cls].oursDetection
            if (od && isFinite(od.matchedOwnLegs)) matched += Number(od.matchedOwnLegs)
        }
        if (!matched && rec && rec.oursDetection && isFinite(rec.oursDetection.matchedOwnLegs)) {
            matched = Number(rec.oursDetection.matchedOwnLegs)
        }
        return matched
    }

    static _aggregateDetection(records) {
        const out = {
            routesWithOwnMatches: 0,
            routesPrefixFallbackOnly: 0,
            matchedOwnLegs: 0,
            flightNumberSources: {},
            carrierPrefixes: {}
        }
        for (const rec of records || []) {
            if (!rec) continue
            const od = rec.oursDetection || {}
            const matched = Number(od.matchedOwnLegs)
            if (isFinite(matched) && matched > 0) {
                out.routesWithOwnMatches++
                out.matchedOwnLegs += matched
            }
            if (od.prefixFallbackOnly) out.routesPrefixFallbackOnly++
            const source = od.flightNumbersSource || "unknown"
            out.flightNumberSources[source] = (out.flightNumberSources[source] || 0) + 1
            const prefixes = Array.isArray(od.carrierPrefixes)
                ? od.carrierPrefixes
                : (Array.isArray(rec.ourCarrierPrefixes) ? rec.ourCarrierPrefixes : [])
            for (const p of prefixes) {
                const u = String(p || "").toUpperCase()
                if (u) out.carrierPrefixes[u] = (out.carrierPrefixes[u] || 0) + 1
            }
        }
        return out
    }

    static _composeOrsAllMetrics(byClass, method, weights) {
        const METRICS = ["rankAny", "rankFirstLegOurs", "rankAllOurs", "rankNonstop", "rankBookable",
                         "ourTopRating", "ourBestNonstopRating", "topCompetitorRating", "ratingGapToTop"]
        const RANK_METRICS = {rankAny: 1, rankFirstLegOurs: 1, rankAllOurs: 1, rankNonstop: 1, rankBookable: 1}
        const out = {}
        const classes = ["ECONOMY", "BUSINESS", "FIRST"]
        for (const m of METRICS) {
            const samples = []
            const ws = []
            for (const cls of classes) {
                const cr = byClass && byClass[cls]
                if (!cr) continue
                const v = cr[m]
                if (v == null) continue
                samples.push(v)
                ws.push((weights && weights[cls]) || 0)
            }
            if (!samples.length) { out[m] = null; continue }
            let value
            if (method === "min") value = Math.min.apply(null, samples)
            else if (method === "max") value = Math.max.apply(null, samples)
            else if (method === "avg") value = samples.reduce((s, x) => s + x, 0) / samples.length
            else {
                const wsum = ws.reduce((s, x) => s + x, 0)
                if (wsum > 0) {
                    let acc = 0
                    for (let i = 0; i < samples.length; i++) acc += samples[i] * ws[i]
                    value = acc / wsum
                } else {
                    value = samples.reduce((s, x) => s + x, 0) / samples.length
                }
            }
            out[m] = RANK_METRICS[m] ? Math.round(value) : value
        }
        return out
    }

    static _resolvePrimary(rec, which) {
        if (!rec) return null
        switch (which) {
            case "rankAny":              return rec.rankAny
            case "rankFirstLegOurs":     return rec.rankFirstLegOurs
            case "rankAllOurs":          return rec.rankAllOurs
            case "rankNonstop":          return rec.rankNonstop
            case "rankBookable":         return rec.rankBookable
            case "ourTopRating":         return rec.ourTopRating
            case "ourBestNonstopRating": return rec.ourBestNonstopRating
            case "ratingGapToTop":
            default:                     return rec.ratingGapToTop
        }
    }

    getComposite(row, settings) {
        const cfg = RouteAssistantOrsIntelligence._orsSettings({settings: settings || this.settings})
        const byClass = (row && row.orsByClass) || (row && row.byClass) || {}
        const weights = cfg.classWeights || {ECONOMY: 0.75, BUSINESS: 0.20, FIRST: 0.05}
        const composite = RouteAssistantOrsIntelligence._composeOrsAllMetrics(
            byClass, cfg.combineMethod || "weighted", weights
        )
        const primaryCol = cfg.primaryColumn || "ratingGapToTop"
        composite.primaryColumn = primaryCol
        composite.primaryValue = RouteAssistantOrsIntelligence._resolvePrimary(composite, primaryCol)
        // Competition-density modulation. When the caller passes a row that
        // carries `competitorYsCount` (the panel + central-price-automator
        // do), scale ratingGapToTop by the competition weight so monopoly
        // routes stop being damped by ORS weakness. Pure additive: original
        // metrics untouched, two new fields surfaced.
        if (typeof window !== "undefined" && window.AesOrsCompetitionWeight) {
            const compCount = (row && row.competitorYsCount != null)
                ? Number(row.competitorYsCount)
                : (row && row.competitorCountsByClass && Number(row.competitorCountsByClass.Y)) || 0
            const weighted = window.AesOrsCompetitionWeight.applyToComposite(composite, compCount)
            composite.competitionWeight = weighted.competitionWeight
            composite.effectiveRatingGapToTop = weighted.effectiveRatingGapToTop
            composite.competitorCount = compCount
        }
        return composite
    }

    static async bulkLoadRecords(routes, opts) {
        const pairs = RouteAssistantOrsIntelligence._normaliseRoutes(routes)
        if (!pairs.length) return new Map()
        const Scraper = RouteAssistantOrsIntelligence._orsScraperCtor()
        if (Scraper && typeof Scraper.bulkLoadCache === "function") {
            return await Scraper.bulkLoadCache(pairs, opts || {})
        }
        return new Map()
    }

    async getCoverage(routes, policy) {
        policy = Object.assign({settings: this.settings}, policy || {})
        const routeList = RouteAssistantOrsIntelligence._normaliseRoutes(routes && routes.length
            ? routes
            : await RouteAssistantOrsIntelligence._routesFromTopRoutes(this.server))
        const required = RouteAssistantOrsIntelligence._classes(policy)
        const staleMs = RouteAssistantOrsIntelligence._staleMs(policy)
        const cache = await RouteAssistantOrsIntelligence.bulkLoadRecords(routeList, {maxAgeDays: null})
        const schedule = await RouteAssistantOrsIntelligence._loadScheduleCache(routeList)
        const priorHealth = await RouteAssistantOrsIntelligence.loadHealth(this.server).catch(() => null)
        const breaker = RouteAssistantOrsIntelligence._breaker(policy, priorHealth)

        const missingRoutes = []
        const staleRoutes = []
        const failedRoutes = []
        const warningRoutes = []
        const missingClasses = {}
        const records = []
        let coveredRoutes = 0
        let usableRoutes = 0
        let scheduleFlownRoutes = 0

        for (const route of routeList) {
            const rec = cache.get(route.pairKey)
            const sched = schedule.get(route.pairKey)
            const flown = RouteAssistantOrsIntelligence._isScheduleFlown(sched) || Number(route.weeklyFlights) > 0
            if (flown) scheduleFlownRoutes++
            if (!rec) {
                missingRoutes.push(route.pairKey)
                for (const cls of required) missingClasses[cls] = (missingClasses[cls] || 0) + 1
                if (flown) warningRoutes.push({route: route.pairKey, warning: "schedule-flown-no-ors"})
                continue
            }
            records.push(rec)
            const missing = required.filter(cls => !RouteAssistantOrsIntelligence._classCaptured(rec, cls))
            if (!missing.length) coveredRoutes++
            else {
                for (const cls of missing) missingClasses[cls] = (missingClasses[cls] || 0) + 1
            }
            if (required.some(cls => RouteAssistantOrsIntelligence._classUsable(rec, cls))) usableRoutes++
            if (RouteAssistantOrsIntelligence._recordAgeMs(rec) > staleMs) staleRoutes.push(route.pairKey)
            if (missing.length && rec.byClass) failedRoutes.push(route.pairKey)
            const composite = this.getComposite({orsByClass: rec.byClass}, policy.settings)
            if (flown && composite.rankAny == null && composite.rankNonstop == null) {
                warningRoutes.push({route: route.pairKey, warning: "schedule-flown-rank-null"})
            }
        }

        const total = routeList.length
        const coverage = {
            server: this.server || "",
            accountId: RouteAssistantOrsIntelligence._accountId(),
            generatedAt: Date.now(),
            totalRoutes: total,
            coveredRoutes,
            usableRoutes,
            missingRoutes,
            staleRoutes,
            failedRoutes,
            warningRoutes,
            scheduleFlownRoutes,
            requiredClasses: required,
            missingClasses,
            coveragePct: total ? Math.round(coveredRoutes * 1000 / total) / 10 : 0,
            stalePct: total ? Math.round(staleRoutes.length * 1000 / total) / 10 : 0,
            breaker,
            oursDetection: RouteAssistantOrsIntelligence._aggregateDetection(records),
            nextAction: RouteAssistantOrsIntelligence._nextAction({
                total, breaker, missingRoutes, staleRoutes, failedRoutes, warningRoutes
            })
        }
        if (policy.writeHealth !== false) {
            await RouteAssistantOrsIntelligence.saveHealth(this.server, coverage).catch(() => null)
        }
        return coverage
    }

    async getRouteSnapshot(hub, dest, settings) {
        const H = String(hub || "").toUpperCase()
        const D = String(dest || "").toUpperCase()
        if (!H || !D) return null
        const rec = await RouteAssistantOrsIntelligence._loadRecord(H, D)
        const schedule = await RouteAssistantOrsIntelligence._loadScheduleRecord(H, D)
        const composite = rec ? this.getComposite({orsByClass: rec.byClass}, settings || this.settings) : null
        const priceIndex = RouteAssistantOrsIntelligence._priceIndex(rec)
        const explanation = RouteAssistantOrsIntelligence._explainRecord(H, D, rec, schedule, composite)
        return {
            hub: H,
            dest: D,
            pairKey: H + "-" + D,
            record: rec,
            schedule,
            byClass: rec && rec.byClass || {},
            composite,
            priceIndex,
            usable: !!(rec && composite && (composite.rankAny != null || composite.rankNonstop != null
                || composite.ourTopRating != null || RouteAssistantOrsIntelligence._ownMatchCount(rec) > 0)),
            warnings: explanation.warnings,
            explanation
        }
    }

    async explainRoute(hub, dest) {
        const snap = await this.getRouteSnapshot(hub, dest)
        return snap ? snap.explanation : null
    }

    async planSync(routes, policy) {
        policy = Object.assign({settings: this.settings}, policy || {})
        const routeList = RouteAssistantOrsIntelligence._normaliseRoutes(routes)
        const required = RouteAssistantOrsIntelligence._classes(policy)
        const staleMs = RouteAssistantOrsIntelligence._staleMs(policy)
        const cache = await RouteAssistantOrsIntelligence.bulkLoadRecords(routeList, {maxAgeDays: null})
        const schedule = await RouteAssistantOrsIntelligence._loadScheduleCache(routeList)
        const health = await RouteAssistantOrsIntelligence.loadHealth(this.server).catch(() => null)
        const breaker = RouteAssistantOrsIntelligence._breaker(policy, health)
        const now = Date.now()
        const rows = []
        for (const route of routeList) {
            const rec = cache.get(route.pairKey)
            const sched = schedule.get(route.pairKey)
            const missingClasses = required.filter(cls => !RouteAssistantOrsIntelligence._classCaptured(rec, cls))
            const orsAgeMs = RouteAssistantOrsIntelligence._recordAgeMs(rec)
            const scheduleAgeMs = sched && isFinite(sched.scrapedAt) ? Math.max(0, now - sched.scrapedAt) : Infinity
            const stale = !rec || missingClasses.length > 0 || orsAgeMs > staleMs
            const active = RouteAssistantOrsIntelligence._isScheduleFlown(sched)
                || Number(route.weeklyFlights || route.flights || route.frequency) > 0
                || !!route.alreadyScheduled
            const watched = !!(route.watched || route.starred || route._starred || route.watchlisted)
            const highScore = isFinite(route.score) && Number(route.score) >= (policy.highScoreThreshold || 70)
            const sandbox = !!(route.sandboxStale || route.hasSandbox || route._sandboxActive)
            let priority = 5
            let reason = "visible"
            if (active) { priority = 1; reason = "active-flown-route" }
            else if (watched) { priority = 2; reason = "watched-route" }
            else if (highScore) { priority = 3; reason = "high-score-candidate" }
            else if (sandbox) { priority = 4; reason = "stale-sandbox-route" }
            if (!stale && policy.includeFresh !== true) priority += 10
            rows.push(Object.assign({}, route, {
                priority,
                reason,
                stale,
                missingClasses,
                orsAgeMs,
                scheduleAgeMs,
                estimatedRequests: required.length * 2 + 1
            }))
        }
        rows.sort((a, b) => (a.priority - b.priority)
            || ((b.stale ? 1 : 0) - (a.stale ? 1 : 0))
            || ((b.score || 0) - (a.score || 0))
            || (b.orsAgeMs - a.orsAgeMs)
            || a.pairKey.localeCompare(b.pairKey))
        const selected = policy.includeFresh === true ? rows : rows.filter(r => r.stale)
        const concurrency = Math.max(1, Number(policy.concurrency) || RouteAssistantOrsIntelligence.DEFAULT_CONCURRENCY)
        const staggerMs = Math.max(0, Number(policy.staggerMs) || RouteAssistantOrsIntelligence.DEFAULT_STAGGER_MS)
        const requests = selected.reduce((s, r) => s + r.estimatedRequests, 0)
        const estimatedMs = selected.length
            ? Math.ceil(selected.length / concurrency) * Math.max(staggerMs, required.length * 2500)
            : 0
        return {
            blocked: breaker.active,
            blockReason: breaker.active ? "ors-circuit-breaker" : null,
            breaker,
            generatedAt: Date.now(),
            routes: selected,
            skippedFresh: rows.length - selected.length,
            totalVisible: routeList.length,
            requiredClasses: required,
            estimatedRequests: requests,
            estimatedMs,
            notes: [
                "One Wicket GET plus POST is required per route/class.",
                "Schedule scrape runs first so flight numbers feed ORS ours detection."
            ]
        }
    }

    async sync(routes, policy) {
        policy = Object.assign({settings: this.settings}, policy || {})
        if (!this.server) return {ok: false, skipped: true, reason: "no-server"}
        const plan = await this.planSync(routes, policy)
        if (plan.blocked) {
            await RouteAssistantOrsIntelligence.saveHealth(this.server, {
                breaker: plan.breaker,
                lastPlan: RouteAssistantOrsIntelligence._compactPlan(plan),
                nextAction: "Wait for ORS cooldown or reset the breaker."
            }).catch(() => null)
            return {ok: false, skipped: true, reason: plan.blockReason, plan}
        }
        const routeList = plan.routes.map(r => ({hub: r.hub, dest: r.dest}))
        if (!routeList.length) return {ok: true, skipped: true, reason: "nothing-stale", plan, results: []}
        if (!this.routeSync) {
            const SyncCtor = RouteAssistantOrsIntelligence._routeSyncCtor()
            if (!SyncCtor) {
                return {ok: false, skipped: true, reason: "route-sync-missing", plan}
            }
            this.routeSync = new SyncCtor(this.server, {
                priceScraper: policy.priceScraper,
                orsScraper: policy.orsScraper || this.scraper
            })
        }
        const cfg = RouteAssistantOrsIntelligence._orsSettings(policy)
        const result = await this.routeSync.bulkSync(routeList, {
            concurrency: policy.concurrency || cfg.concurrency || RouteAssistantOrsIntelligence.DEFAULT_CONCURRENCY,
            staggerMs:   policy.staggerMs   || cfg.staggerMs   || RouteAssistantOrsIntelligence.DEFAULT_STAGGER_MS,
            orsParams: {
                classesToScrape: RouteAssistantOrsIntelligence._classes(policy),
                departureH:      cfg.defaultDepartureH,
                arrivalH:        cfg.defaultArrivalH,
                useGround:       cfg.defaultUseGround,
                carrierOverride: cfg.airlineCarrierPrefixOverride
            },
            contextBuilder: policy.contextBuilder,
            onProgress: policy.onProgress
        })
        const coverage = await this.getCoverage(routes, policy).catch(() => null)
        const runPatch = {
            lastRunAt: Date.now(),
            lastRun: {
                source: policy.source || "facade",
                totalRoutes: routeList.length,
                halted: !!(result && result.halted),
                reason: result && result.reason || null
            },
            lastPlan: RouteAssistantOrsIntelligence._compactPlan(plan),
            coverage: coverage ? RouteAssistantOrsIntelligence._compactCoverage(coverage) : null,
            breaker: RouteAssistantOrsIntelligence._breaker(policy, null)
        }
        if (result && !result.halted) runPatch.lastSuccessfulRunAt = Date.now()
        await RouteAssistantOrsIntelligence.saveHealth(this.server, runPatch).catch(() => null)
        return Object.assign({ok: !(result && result.halted), plan}, result || {})
    }

    static _compactPlan(plan) {
        return {
            generatedAt: plan && plan.generatedAt,
            totalVisible: plan && plan.totalVisible,
            totalRoutes: plan && plan.routes && plan.routes.length || 0,
            skippedFresh: plan && plan.skippedFresh || 0,
            estimatedRequests: plan && plan.estimatedRequests || 0,
            estimatedMs: plan && plan.estimatedMs || 0,
            requiredClasses: plan && plan.requiredClasses || []
        }
    }

    static _compactCoverage(c) {
        return {
            generatedAt: c.generatedAt,
            totalRoutes: c.totalRoutes,
            coveredRoutes: c.coveredRoutes,
            usableRoutes: c.usableRoutes,
            coveragePct: c.coveragePct,
            stalePct: c.stalePct,
            staleRoutes: c.staleRoutes && c.staleRoutes.slice(0, 20),
            failedRoutes: c.failedRoutes && c.failedRoutes.slice(0, 20),
            missingClasses: c.missingClasses,
            warningRoutes: c.warningRoutes && c.warningRoutes.slice(0, 20)
        }
    }

    static _nextAction(input) {
        if (input.breaker && input.breaker.active) return "Wait for ORS cooldown or reset the breaker."
        if (!input.total) return "Open Route Assistant on a scheduling hub to publish visible routes."
        if (input.missingRoutes && input.missingRoutes.length) return "Run the route-sync pipeline."
        if (input.failedRoutes && input.failedRoutes.length) return "Run Advanced ORS-only repair for failed classes."
        if (input.staleRoutes && input.staleRoutes.length) return "Refresh stale ORS routes through route-sync."
        if (input.warningRoutes && input.warningRoutes.length) return "Inspect schedule-flown routes with null ORS rank."
        return "ORS coverage healthy."
    }

    static async _loadRecord(hub, dest) {
        const Scraper = RouteAssistantOrsIntelligence._orsScraperCtor()
        if (Scraper && typeof Scraper.loadRecord === "function") {
            return await Scraper.loadRecord(hub, dest)
        }
        return null
    }

    static async _loadScheduleRecord(hub, dest) {
        if (typeof RouteAssistantSchedulePageScraper !== "undefined"
                && typeof RouteAssistantSchedulePageScraper.loadRecord === "function") {
            return await RouteAssistantSchedulePageScraper.loadRecord(hub, dest)
        }
        return null
    }

    static _priceIndex(rec, currentPrices) {
        const Index = typeof RouteAssistantOrsPriceIndex !== "undefined"
            ? RouteAssistantOrsPriceIndex
            : (typeof window !== "undefined" ? window.RouteAssistantOrsPriceIndex : null)
        if (!rec || !Index || typeof Index.indexRecord !== "function") return null
        try { return Index.indexRecord(rec, {currentPrices: currentPrices || {}}) }
        catch (_) { return null }
    }

    static async _loadScheduleCache(routes) {
        if (!routes || !routes.length
                || typeof RouteAssistantSchedulePageScraper === "undefined"
                || typeof RouteAssistantSchedulePageScraper.bulkLoadCache !== "function") {
            return new Map()
        }
        try { return await RouteAssistantSchedulePageScraper.bulkLoadCache(routes, {maxAgeDays: null}) }
        catch (_) { return new Map() }
    }

    static _explainRecord(hub, dest, rec, schedule, composite) {
        const warnings = []
        const lines = []
        const pair = hub + "-" + dest
        const flown = RouteAssistantOrsIntelligence._isScheduleFlown(schedule)
        if (!rec) {
            warnings.push(flown ? "schedule-flown-no-ors" : "no-ors-record")
            lines.push(pair + ": no ORS record cached.")
            return {pairKey: pair, usable: false, warnings, lines}
        }
        const classes = Object.keys(rec.byClass || {}).filter(k => rec.byClass[k])
        lines.push(pair + ": " + classes.length + " ORS class" + (classes.length === 1 ? "" : "es")
            + " cached, scraped " + (rec.scrapedAt ? new Date(rec.scrapedAt).toISOString() : "unknown time") + ".")
        const ownMatches = RouteAssistantOrsIntelligence._ownMatchCount(rec)
        if (!ownMatches) warnings.push("no-own-leg-detected")
        if (flown && composite && composite.rankAny == null && composite.rankNonstop == null) {
            warnings.push("schedule-flown-rank-null")
            lines.push("Schedule cache says the route is flown, but ORS did not identify an own-ranked connection.")
        }
        if (rec.oursDetection && rec.oursDetection.prefixFallbackOnly) {
            warnings.push("prefix-fallback-only")
            lines.push("Own-flight detection used carrier-prefix fallback only.")
        }
        return {
            pairKey: pair,
            usable: !warnings.includes("no-ors-record") && classes.length > 0,
            warnings,
            lines,
            oursDetection: rec.oursDetection || null
        }
    }

    static async _routesFromTopRoutes(server) {
        const out = []
        const seen = new Set()
        const all = await chrome.storage.local.get(null)
        for (const k in all) {
            if (k.indexOf("routeAssistant:topRoutes") !== 0) continue
            const rec = all[k]
            if (!rec || !Array.isArray(rec.rows)) continue
            if (server && rec.server && String(rec.server) !== String(server)) continue
            const hub = String(rec.hub || "").toUpperCase()
            if (!hub) continue
            for (const row of rec.rows) {
                const dest = String(row && (row.destIata || row.dest) || "").toUpperCase()
                const pk = hub && dest ? hub + "-" + dest : ""
                if (!pk || seen.has(pk)) continue
                seen.add(pk)
                out.push(Object.assign({}, row, {hub, dest, pairKey: pk}))
            }
        }
        return out
    }

    static async listCachedRoutes(server, opts) {
        opts = opts || {}
        const all = await chrome.storage.local.get(null)
        const map = new Map()
        const acctPrefix = "routeAssistant:ors:acct:"
        const legacyPrefix = "routeAssistant:ors:"
        for (const k in all) {
            if (k.indexOf(legacyPrefix) !== 0) continue
            const rec = all[k]
            if (!rec || typeof rec !== "object" || !rec.hub || !rec.dest) continue
            if (server && rec.server && String(rec.server) !== String(server)) continue
            const key = String(rec.hub).toUpperCase() + "-" + String(rec.dest).toUpperCase()
            const isAcct = k.indexOf(acctPrefix) === 0
            const prior = map.get(key)
            if (!prior || (isAcct && !prior._isAcct) || ((rec.scrapedAt || 0) > (prior.scrapedAt || 0))) {
                let out = rec
                const Scraper = RouteAssistantOrsIntelligence._orsScraperCtor()
                if (Scraper && typeof Scraper._migrateOrsRecord === "function") {
                    out = Scraper._migrateOrsRecord(rec)
                }
                map.set(key, Object.assign({_isAcct: isAcct, _key: k}, out))
            }
        }
        return map
    }
}

if (typeof window !== "undefined") {
    window.RouteAssistantOrsIntelligence = RouteAssistantOrsIntelligence
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = RouteAssistantOrsIntelligence
}
