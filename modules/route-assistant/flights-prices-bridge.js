"use strict";

/**
 * Formula → applier bridge for the AS `flightsPrices?adjust=true` panel.
 *
 * The pricing formula (`AesStrategy.proposePriceMoves`) and the per-route
 * applier (`RouteAssistantPricingApplier`) are both already shipped, but
 * nothing on the bulk-adjustment page has wired them together. This module
 * is the missing wire: it
 *
 *   1. Loads the airline's route fixture from the
 *      `routeAssistant:markets:ownPricing:*` cache populated by the
 *      markets-page scraper.
 *   2. Loads per-flight ground truth (load %, current Price/Unit, AS-stated
 *      Minimum Price) from the `flightInfo*` storage keys written by
 *      `content_flightInfo.js`. Aggregated to per-route signals: median
 *      load, max minimum price (the conservative safety floor).
 *   3. Calls `AesStrategy.snapshot()` + `AesStrategy.proposePriceMoves()`
 *      to get per-class recommendations, scopes them via
 *      `RouteAssistantFlightsPricesScope.resolveScope`, and translates
 *      `toPct` (% of baseline) → absolute integer prices.
 *   4. Provides `applySelected(rows, opts)` which loops through the existing
 *      `RouteAssistantPricingApplier.apply(...)` with `source:
 *      "bulkRecommended"`. The applier's existing gates, circuit breaker,
 *      audit log, and the new min-price clamp engage automatically.
 *
 * The bridge does NOT submit the AS bulk GET form — every write goes
 * through the existing per-route applier so the documented two-gate
 * model (apply.enabled + apply.dryRunOnly + liveScopes) is honoured.
 *
 * Public API:
 *   const bridge = new RouteAssistantFlightsPricesBridge(server, airline, settings);
 *   await bridge.loadRouteFixture()                  // → routes[]
 *   await bridge.loadFlightInfoIndex()               // → byPair Map
 *   await bridge.computeRecommendations(filter)      // → {rows, classes, scope}
 *   await bridge.applySelected(selectedRows, opts)   // → {results, summary}
 */
(function() {
    "use strict";

    const FLIGHT_INFO_KEY_RE = /^([a-z0-9]+)([A-Z0-9]{0,16})flightInfo(\d+)$/;

    function median(values) {
        if (!values || !values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return (sorted.length % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function maxFinite(values) {
        let best = null;
        for (const v of (values || [])) {
            if (!isFinite(v)) continue;
            if (best == null || v > best) best = v;
        }
        return best;
    }

    function parsePairFromOwnPricingKey(key) {
        // Two key shapes (legacy + airline-scoped):
        //   "routeAssistant:markets:ownPricing:HUB-DEST"
        //   "<acct>:routeAssistant:markets:ownPricing:HUB-DEST"
        const idx = key.indexOf("routeAssistant:markets:ownPricing:");
        if (idx < 0) return null;
        const tail = key.slice(idx + "routeAssistant:markets:ownPricing:".length);
        const m = /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})$/.exec(tail);
        return m ? { hub: m[1], dest: m[2] } : null;
    }

    class RouteAssistantFlightsPricesBridge {
        constructor(server, airline, settings) {
            this.server   = server || null;
            this.airline  = airline || "";
            this.settings = settings || {};
            this._routes  = [];                  // [{hub, dest, ownPricing, currentPrices, ...}]
            this._byPair  = new Map();           // "HUB-DEST" → flightInfo aggregate
            this._loaded  = { routes: false, flightInfo: false };
            // Strategy snapshot cache. AesStrategy.snapshot is heavy (it
            // walks every cached scrape, builds context, fits competitor
            // bands). Cache for ~60s mirrors the silent-auto loop's own
            // `_cachedStrategySnapshot` at panel.js:24665. Bypassed by
            // computeRecommendations({forceFresh:true}).
            this._snapshotCache = { snapshot: null, builtAt: 0 };
            this._snapshotMaxAgeMs = 60_000;
        }

        // ---------------------------------------------------------------
        // Loaders. Each fans out one chrome.storage.local.get() and parses
        // the result. Tolerant of missing data — empty fixture just means
        // nothing to recommend, not an error.
        // ---------------------------------------------------------------

        async loadRouteFixture() {
            const all = await this._getAll();
            const out = [];
            for (const k in all) {
                const pair = parsePairFromOwnPricingKey(k);
                if (!pair) continue;
                const rec = all[k];
                if (!rec || typeof rec !== "object") continue;
                const ownPrices = rec.prices || {};
                const classes = [];
                for (const cls of ["Y", "C", "F", "Cargo"]) {
                    if (isFinite(Number(ownPrices[cls]))) classes.push(cls);
                }
                out.push({
                    hub:               pair.hub,
                    dest:              pair.dest,
                    serviceProfileId:  rec.generalSettings && rec.generalSettings[
                        "serviceProfile-group:serviceProfile-group_body:serviceProfile"] || null,
                    classes:           classes.length ? classes : ["Y"],
                    ownPricing:        rec
                });
            }
            this._routes = out;
            this._loaded.routes = true;
            return out;
        }

        async loadFlightInfoIndex() {
            const all = await this._getAll();
            const byPair = new Map();
            for (const k in all) {
                const m = FLIGHT_INFO_KEY_RE.exec(k);
                if (!m) continue;
                const rec = all[k];
                if (!rec || rec.type !== "flightInfo") continue;
                const route = rec.route;
                if (!route || !route.hub || !route.dest) continue;
                const key = String(route.hub).toUpperCase() + "-" + String(route.dest).toUpperCase();
                if (!byPair.has(key)) byPair.set(key, []);
                byPair.get(key).push(rec);
            }
            // Aggregate per-pair → {Y,C,F,Cargo: {minPrice, currentLoad, currentPrice}}
            const aggregated = new Map();
            for (const [pair, recs] of byPair.entries()) {
                const cls = { Y: {}, C: {}, F: {}, Cargo: {} };
                for (const klass of ["Y", "C", "F", "Cargo"]) {
                    const mins = recs.map(r => r.prices && r.prices[klass] && r.prices[klass].min)
                        .filter(v => isFinite(v));
                    const loads = recs.map(r => r.loads && r.loads[klass] && r.loads[klass].loadPct)
                        .filter(v => isFinite(v));
                    const units = recs.map(r => r.prices && r.prices[klass] && r.prices[klass].unit)
                        .filter(v => isFinite(v));
                    cls[klass].minPrice    = maxFinite(mins);    // conservative — highest floor
                    cls[klass].currentLoad = median(loads);
                    cls[klass].currentPrice = median(units);
                    cls[klass].sampleCount = recs.length;
                }
                aggregated.set(pair, cls);
            }
            this._byPair = aggregated;
            this._loaded.flightInfo = true;
            return aggregated;
        }

        /** Force-clear caches so the next computeRecommendations re-reads
         *  storage and rebuilds the strategy snapshot from scratch. Wired
         *  to the panel's Refresh button. */
        invalidate() {
            this._loaded.routes = false;
            this._loaded.flightInfo = false;
            this._routes = [];
            this._byPair = new Map();
            this._snapshotCache = { snapshot: null, builtAt: 0 };
        }

        // ---------------------------------------------------------------
        // Recommendation pipeline.
        // ---------------------------------------------------------------

        /**
         * Run the formula for the given filter and return preview rows.
         * Each row: {hub, dest, classKey, fromPrice, toPrice, deltaPct,
         * minPrice, currentLoad, rationale, clampedToFloor}.
         */
        async computeRecommendations(filter, opts) {
            opts = opts || {};
            if (opts.forceFresh) this.invalidate();
            if (!this._loaded.routes)     await this.loadRouteFixture();
            if (!this._loaded.flightInfo) await this.loadFlightInfoIndex();

            const scopeApi = (typeof window !== "undefined")
                ? window.RouteAssistantFlightsPricesScope
                : (typeof require === "function" ? require("./flights-prices-scope.js") : null);
            if (!scopeApi) {
                return { rows: [], classes: [], scope: { reason: "noScopeApi" }, diagnostics: {} };
            }
            const scope = scopeApi.resolveScope(filter, this._routes);
            const diagnostics = {
                strategyAvailable: false,
                strategyError:     null,
                snapshotCached:    false,
                routesScanned:     this._routes.length,
                routesInScope:     scope.routes.length,
                routesWithFlightInfo: 0,
                routesWithoutFlightInfo: 0
            };
            if (!scope.routes.length) {
                return { rows: [], classes: scope.classes, scope, diagnostics };
            }

            // Strategy round-trip — cache the snapshot for ~60s so a
            // filter tweak doesn't re-scrape every store. When the scope
            // narrows to a single route we ask proposePriceMoves to
            // restrict to that pair so the joint-rank tuner short-circuits
            // its network-wide solve.
            let moves = [];
            try {
                const strat = (typeof window !== "undefined") ? window.AesStrategy : null;
                if (strat && typeof strat.snapshot === "function"
                          && typeof strat.proposePriceMoves === "function") {
                    diagnostics.strategyAvailable = true;
                    const snap = await this._getOrBuildSnapshot(strat);
                    diagnostics.snapshotCached = (Date.now() - this._snapshotCache.builtAt) > 50;
                    const moveOpts = { includeCargo: true };
                    if (scope.routes.length === 1) {
                        moveOpts.restrictTo = { hub: scope.routes[0].hub, dest: scope.routes[0].dest };
                    }
                    const rawMoves = strat.proposePriceMoves(snap, moveOpts);
                    moves = Array.isArray(rawMoves) ? rawMoves : [];
                }
            } catch (e) {
                console.warn("[AES flights-prices-bridge] proposePriceMoves threw", e);
                diagnostics.strategyError = String(e && e.message || e);
            }

            // Index moves by HUB-DEST → {Y,C,F,Cargo: move}.
            const movesByPair = new Map();
            for (const m of moves) {
                if (!m || !m.hub || !m.dest || !m.classKey) continue;
                const key = String(m.hub).toUpperCase() + "-" + String(m.dest).toUpperCase();
                let bucket = movesByPair.get(key);
                if (!bucket) { bucket = {}; movesByPair.set(key, bucket); }
                bucket[m.classKey] = m;
            }

            const baselineMode = (filter && filter.base === "current") ? "current" : "standard";
            const floorCfg = (this.settings && this.settings.routeAssistant
                && this.settings.routeAssistant.pricing
                && this.settings.routeAssistant.pricing.apply
                && this.settings.routeAssistant.pricing.apply.minPriceFloor) || { enabled: true, safetyMarginPct: 5 };
            const margin = isFinite(floorCfg.safetyMarginPct)
                ? Math.max(0, Number(floorCfg.safetyMarginPct)) : 0;
            const factor = 1 + margin / 100;

            const rows = [];
            for (const r of scope.routes) {
                const pair = r.hub + "-" + r.dest;
                const bucket = movesByPair.get(pair);
                const flightAgg = this._byPair.get(pair) || null;
                if (flightAgg) diagnostics.routesWithFlightInfo++;
                else           diagnostics.routesWithoutFlightInfo++;
                const baselineSrc = (baselineMode === "current"
                    ? (r.ownPricing && r.ownPricing.prices)
                    : (r.ownPricing && r.ownPricing.defaults)) || (r.ownPricing && r.ownPricing.prices) || {};
                for (const cls of scope.classes) {
                    const move = bucket ? bucket[cls] : null;
                    const baseline = Number(baselineSrc[cls]);
                    if (!isFinite(baseline) || baseline <= 0) continue;
                    if (!move) continue;
                    const toPct = Number(move.toPct);
                    const fromPct = Number(move.fromPct);
                    if (!isFinite(toPct)) continue;
                    const fromPrice = isFinite(fromPct) ? Math.round(baseline * fromPct / 100) : baseline;
                    let toPrice = Math.round(baseline * toPct / 100);
                    const minPrice = flightAgg && flightAgg[cls] ? flightAgg[cls].minPrice : null;
                    const currentLoad = flightAgg && flightAgg[cls] ? flightAgg[cls].currentLoad : null;
                    let clampedToFloor = false;
                    if (floorCfg.enabled !== false && isFinite(minPrice) && minPrice > 0) {
                        const effective = Math.ceil(minPrice * factor);
                        if (toPrice < effective) {
                            toPrice = effective;
                            clampedToFloor = true;
                        }
                    }
                    const sampleCount = flightAgg && flightAgg[cls]
                        ? flightAgg[cls].sampleCount : 0;
                    rows.push({
                        hub:             r.hub,
                        dest:            r.dest,
                        classKey:        cls,
                        baseline,
                        baselineMode,
                        fromPrice,
                        toPrice,
                        deltaPct:        baseline > 0 ? ((toPrice - baseline) / baseline) * 100 : 0,
                        minPrice:        isFinite(minPrice) ? minPrice : null,
                        currentLoad:     isFinite(currentLoad) ? currentLoad : null,
                        rationale:       Array.isArray(move.rationale) ? move.rationale.slice(0, 6) : [],
                        clampedToFloor,
                        flightInfoMissing: !flightAgg,
                        flightInfoSamples: sampleCount,
                        impactWeekly:    isFinite(move.impactWeekly) ? move.impactWeekly : null,
                        profitPerWeek:   isFinite(move.profitPerWeek) ? move.profitPerWeek : null
                    });
                }
            }
            return { rows, classes: scope.classes, scope, diagnostics };
        }

        // Cached snapshot reuse — mirrors the silent-auto loop's pattern.
        async _getOrBuildSnapshot(strat) {
            const ageMs = Date.now() - (this._snapshotCache.builtAt || 0);
            if (this._snapshotCache.snapshot && ageMs < this._snapshotMaxAgeMs) {
                return this._snapshotCache.snapshot;
            }
            const snap = await strat.snapshot({
                server:      this.server,
                airlineCode: this.airline || null
            });
            this._snapshotCache = { snapshot: snap, builtAt: Date.now() };
            return snap;
        }

        // ---------------------------------------------------------------
        // Apply fan-out — one call to the per-route applier per selected
        // (hub, dest) bucket. Multiple class rows on the same route are
        // merged into a single apply() call so AS sees one POST per route.
        // ---------------------------------------------------------------

        /**
         * @param {Array<Object>} rows           — preview rows the user kept.
         * @param {Object}        opts
         * @param {Object}        opts.applier    — RouteAssistantPricingApplier instance.
         * @param {Function}      [opts.onRow]    — called with each result envelope as it lands.
         * @param {String}        [opts.reason]   — audit-log reason string.
         */
        async applySelected(rows, opts) {
            opts = opts || {};
            const applier = opts.applier;
            if (!applier || typeof applier.apply !== "function") {
                throw new Error("flights-prices-bridge.applySelected: applier required");
            }
            const grouped = new Map();
            for (const row of (rows || [])) {
                const pair = row.hub + "-" + row.dest;
                if (!grouped.has(pair)) {
                    grouped.set(pair, {
                        hub:    row.hub,
                        dest:   row.dest,
                        prices: {},
                        minPrices: {},
                        rows:   []
                    });
                }
                const g = grouped.get(pair);
                g.prices[row.classKey] = row.toPrice;
                if (isFinite(row.minPrice)) g.minPrices[row.classKey] = row.minPrice;
                g.rows.push(row);
            }
            const floorCfg = (this.settings && this.settings.routeAssistant
                && this.settings.routeAssistant.pricing
                && this.settings.routeAssistant.pricing.apply
                && this.settings.routeAssistant.pricing.apply.minPriceFloor) || null;
            const reason = (opts.reason || "flightsPrices panel apply").slice(0, 240);
            const results = [];
            const summary = { total: 0, verified: 0, posted: 0, dryRun: 0, failed: 0, aborted: 0, clamped: 0 };
            for (const g of grouped.values()) {
                summary.total++;
                let res = null;
                try {
                    res = await applier.apply(g.hub, g.dest, g.prices, {
                        source:          "bulkRecommended",
                        scope:           { airportPair: true, flightNumbers: true },
                        reason,
                        minPrices:       g.minPrices,
                        minPriceFloor:   floorCfg
                    });
                } catch (e) {
                    res = { status: "failed", error: { code: "applierThrew", message: String(e && e.message || e) } };
                }
                if (res && res.clamped) summary.clamped++;
                if (res) {
                    if (res.status === "verified") summary.verified++;
                    else if (res.status === "posted") summary.posted++;
                    else if (res.status === "dry-run") summary.dryRun++;
                    else if (res.status === "aborted") summary.aborted++;
                    else summary.failed++;
                }
                results.push({ pair: g.hub + "-" + g.dest, hub: g.hub, dest: g.dest, result: res, rows: g.rows });
                if (typeof opts.onRow === "function") {
                    try { opts.onRow(results[results.length - 1]); } catch (e) { /* swallow */ }
                }
            }
            return { results, summary };
        }

        // ---------------------------------------------------------------
        // Internals
        // ---------------------------------------------------------------

        async _getAll() {
            return new Promise((resolve) => {
                if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
                    resolve({}); return;
                }
                chrome.storage.local.get(null, (items) => resolve(items || {}));
            });
        }
    }

    const api = {
        RouteAssistantFlightsPricesBridge,
        parsePairFromOwnPricingKey,
        median,
        maxFinite
    };

    if (typeof window !== "undefined") {
        RouteAssistantFlightsPricesBridge.RouteAssistantFlightsPricesBridge = RouteAssistantFlightsPricesBridge;
        RouteAssistantFlightsPricesBridge.parsePairFromOwnPricingKey = parsePairFromOwnPricingKey;
        RouteAssistantFlightsPricesBridge.median = median;
        RouteAssistantFlightsPricesBridge.maxFinite = maxFinite;
        window.RouteAssistantFlightsPricesBridge = RouteAssistantFlightsPricesBridge;
        window.RouteAssistantFlightsPricesBridgeAPI = api;
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
})();
