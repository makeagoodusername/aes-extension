/**
 * Settings persistence for the Route Assistant.
 *
 * Lives inside the shared `settings` blob in chrome.storage.local under the
 * `routeAssistant` namespace, mirroring the pattern used by
 * UsedAircraftPresets / FlightsFromStore. Defaults are filled in lazily so
 * that adding new fields in future versions doesn't require migration.
 */
class RouteAssistantSettings {
    static _defaults() {
        return {
            scoring: {
                paxScore:            {enabled: true,  weight: 2, direction: "higher", min: null, max: null},
                cargoScore:          {enabled: true,  weight: 1, direction: "higher", min: null, max: null},
                weeklyFlights:       {enabled: true,  weight: 1, direction: "higher", min: null, max: null},
                airlineCount:        {enabled: true,  weight: 1, direction: "lower",  min: null, max: null},
                profitPerWeek:       {enabled: false, weight: 2, direction: "higher", min: null, max: null},
                fitOk:               {enabled: false, weight: 2, direction: "higher", min: null, max: null},
                actualProfitPerWeek: {enabled: false, weight: 2, direction: "higher", min: null, max: null}
            },
            filters: {
                minScore:        null,
                maxDistanceKm:   null,
                statuses:        {NEW: true, OK: true, UNDER: true, OVER: true, OOR: true},
                fleetFlyableOnly: false,
                // Q1 quick-filter chips — fast-path toggles paired with the
                // status statuses{} above. All default false (off) so the
                // existing behaviour is preserved for users on their first
                // mount after the upgrade.
                watchlistOnly:   false,   // restrict to ★-starred routes
                lossMakers:      false,   // restrict to rows where profitPerWeek < 0
                hasOverride:     false,   // restrict to rows with a saved override
                hasNote:         false,   // restrict to rows with a saved route note
                // "Only changed" innovation — when true, _applyFilters drops
                // rows whose `_diff` shows no movement on any tracked field.
                // Pairs with the existing diff-against-last-visit badges.
                onlyChanged:     false
            },
            // Q15 hub keyboard quick-swap — most-recent-first list of hubs
            // the user has opened the panel on. Capped at 5; deduplicated
            // case-insensitively. Surfaces as a chip row in the controls
            // bar (clickable + Alt+1..5 keyboard navigation).
            recentHubs: [],
            flightsfromMaxAgeDays: 7,
            distanceMaxAgeDays:    null,    // null = never expire; set to N to re-resolve entries older than N days
            collapsed: false,
            panelWidth: 1100,               // px, user-resizable via left-edge drag handle (clamp 600–3000)
            compactView: false,             // master toggle in the panel header — hides heavy column groups in one click
            // Daily-driver QoL — Q12 free-text search. Survives across mounts.
            // Filters table rows by IATA / city-name substring / route-note
            // text (case-insensitive). Empty string disables filtering.
            searchQuery: "",
            // Q4 saved table views — named bookmarks of {filters,
            // viewMode, sortField, sortDir, compactView}. Quick-switch
            // dropdown in the controls bar. Each entry: {id, name,
            // filters, viewMode, sortField, sortDir, compactView,
            // createdAt}. Selecting one writes the snapshot back into
            // settings (deep-merge for filters.statuses) and re-renders.
            savedViews: [],
            // Q7 strategy presets — named bookmarks of the FULL RA
            // configuration (scoring weights, filters, economics, ORS,
            // service profiles, columnPrefs, etc). Mirror of savedViews
            // shape, but the snapshot scope is the whole settings tree
            // minus per-route caches and self-references. Each entry:
            // {id, name, createdAt, snapshot}. Apply via the existing
            // import-diff modal so the user previews changes first.
            strategyPresets: [],
            // U7 + U3 — column visibility chooser + collapsible groups.
            //   hiddenFields:    Array<COLUMNS[].field> hidden in the
            //                    table. "score" + "destIata" are frozen
            //                    sticky-left and filtered out of any
            //                    incoming list defensively (see
            //                    _mergeColumnPrefs). Empty = all visible.
            //   collapsedGroups: Array<COLUMN_GROUPS key> rendered as a
            //                    single "…" placeholder cell with a
            //                    chevron group-header. Empty = all
            //                    expanded — DO NOT seed with all keys.
            columnPrefs: {
                hiddenFields:    [],
                collapsedGroups: []
            },
            // Tabbed view selector (Pax / Cargo / All). Default "all"
            // preserves the existing combined table for users without a
            // strong mode preference. Tab switches column visibility
            // and the scoring-field set; the underlying row data is
            // shared across all three.
            viewMode: "all",
            // Restructure slice A — single-source-of-truth for which of the
            // four panel render branches is active (table / waves / sandbox
            // / heatmap). Replaces the three separate booleans below
            // (`waveView`, `orsSandbox.enabled`, `heatmap.enabled`) which
            // were hidden behind icon-only toggles in the header — easy to
            // hit accidentally, hard to discover the way back. Slice B
            // exposes this as a pill bar; the legacy booleans stay for one
            // version so unmigrated saves still light up the right view.
            panelMode: "table",
            // Restructure slice F — master-detail inspector pane. When ON,
            // the body splits horizontally with a 360px right pane that
            // shows the selected route's full record (score breakdown,
            // fleet fit, override, note, quick actions). Persists so the
            // user doesn't have to re-open it each session.
            inspectorOpen: false,
            // H slice 1 — Wave View toggle. When ON, _renderRows hands
            // the sorted scoredRows to RouteAssistantWaveOverlay which
            // replaces the table with a Gantt-style timeline of the
            // recommended schedule for the top-N rows.
            // Deprecated by `panelMode` in slice A; kept as a one-time
            // migration source.
            waveView: false,
            waveOverlay: {
                lastPresetId:    null,   // user's last picked SchedulePresets id
                topN:            20,     // 5..100 — how many scored rows feed the build
                showWarnings:    true,   // gate the warnings panel below the Gantt
                showUnplaced:    true,   // gate the unplaced strip
                // Slice 2 — multi-hub picker memory. null = follow this.hubIata.
                // When set, the build runs against routeAssistant:topRoutes:<HUB>
                // instead of the panel's mounted-hub scoredRows.
                lastHub:         null,
                // Slice 2 — toggle the SVG connection-graph overlay. The legend
                // still renders even when off, so the user knows the feature
                // exists. Default ON since the graph is the whole point.
                showConnections: true
            },
            // Q13 yield heatmap — hubs × destinations matrix view. New
            // panel mode toggled by 🗺 in the panel header. Mutually
            // exclusive with Wave View and ORS Sandbox; render branch
            // order in panel.js gates it third.
            heatmap: {
                enabled: false,
                metric:  "score"   // "score" | "profit" | "share"
            },
            // Letter I slice 1 — ORS Sandbox. New panel mode that replaces
            // the table with a per-route projection sandbox (price /
            // frequency / comfort sliders → projected rank, share, pax/wk,
            // revenue/wk, profit/wk). Read-only against AS — the
            // sandbox never writes prices back; that's Auto-Pricing T3.
            // Mutual exclusion with waveView is enforced by the render
            // branch order in panel.js (Wave View wins when both on).
            orsSandbox: {
                enabled:       false,    // top-level mode toggle
                lastRouteIata: null,     // restore route on next mount
                // Slider positions, persisted per-route. Switching to a route
                // with no entry falls back to neutral defaults rather than
                // inheriting the previous route's settings (which were almost
                // always wrong for the new route).
                lastScenarioByRoute: {}, // {<HUB>-<DEST>: {priceMultiplier, frequency, comfortDelta}}
                modelParams: {
                    ratingPriceElasticity: 8,    // rating points per ±100% price change
                    ratingComfortLift:     5,    // rating points per service-level step
                    shareTemperature:      25.0  // softmax T (rating points). Lower = sharper share-by-rank.
                },
                // Calibrated softmax T per route. Populated by the Calibrate
                // button; the calibratedAt sibling map carries the timestamp
                // so the results card can surface staleness (markets drift,
                // 30-day-old calibrations should be re-run).
                perRouteTemperature:             {},  // {<HUB>-<DEST>: T}
                perRouteTemperatureCalibratedAt: {},  // {<HUB>-<DEST>: ms epoch}
                // Slice 2c — per-route per-class rating-price elasticity.
                // Auto-log default `true` is STABLE across versions: flipping
                // it would silently change user-observable behaviour (the
                // observation log fills as a side effect of normal scrapes).
                // If a future redesign requires the flip, version it via a
                // one-time migration that preserves the user's last explicit
                // choice, do NOT change this default.
                ratingObservations: {
                    autoLogOnScrape:              true,
                    minObservationsForDerivation: 4,      // min surviving obs after filters before regression fits
                    maxAgeDays:                   90,     // observations older than this are pruned on every read
                    priceDevRangeGate:            0.08,   // require max−min priceDev% ≥ 8% (lever arm for the slope)
                    distinctBucketsRequired:      2,      // require ≥2 distinct priceDev% buckets at 1% rounding
                    allowSiblingClassFallback:    true,   // when class X has too few obs, try sibling-class derived α
                    allowFleetMedianFallback:     true    // and then fleet-median across the user's routes
                }
            },
            aircraft: {
                mode:                null,    // null | "fleet" | "type" | "registration"
                typeId:              null,    // when mode === "type"
                registration:        null,    // when mode === "registration"
                falloffPct:          10,      // 1–25; amber zone width as % of max range
                showAircraftColumns: true     // toggle the new column group
            },
            economics: {
                loadFactor:             0.75,    // pax fallback LF when paxScore is unresolved
                loadFactorMin:          0.50,    // pax LF when AS pax demand = 0
                loadFactorMax:          0.95,    // pax LF when AS pax demand = 10
                yieldPerKm:             0.10,    // AS$ per pax-km
                yieldDemandSensitivity: 0,       // 0-1 — scales yield by demand. 0 = flat (default).
                cargoYieldPerKgKm:      0,       // AS$ per kg-km — 0 = cargo revenue disabled
                cargoLoadFactor:        0.60,    // cargo fallback LF when cargoScore is unresolved
                cargoLoadFactorMin:     0.40,    // cargo LF when AS cargo demand = 0
                cargoLoadFactorMax:     0.85,    // cargo LF when AS cargo demand = 10
                cargoYieldDemandSensitivity: 0,  // same idea, for cargo
                fuelCostPerHour:        2500,    // AS$ per block hour (base, before age penalty)
                fuelPriceAutoEnabled:   false,   // when true and baseline set, scale fuel cost by current/baseline AS price ratio
                fuelPriceBaselineCost:  null,    // captured fuelCostPerHour at calibration time (AS$/h)
                fuelPriceBaselineValue: null,    // captured fuel price at calibration time (matching units of current scrape)
                fuelPriceBaselineUnit:  null,    // "ASc$/l" | "index" — guards against mixing scales
                fuelAgePenaltyPerYear:  0,       // 0–~0.02 — fraction extra fuel per aircraft-year. Default 0 = OFF.
                crewCostPerHour:        0,       // AS$ per block hour (default 0 = disabled)
                maintenanceCostPerHour: 0,       // AS$ per block hour (default 0 = disabled)
                otherFixedPerFlight:    0,       // AS$ per round-trip — leasing/insurance amortised
                falloffYieldMultiplier: 0.85
            },
            pricing: {
                // Tier 1 — visibility layer.
                showPricingColumns: true,    // gate the ourPrice / ourYield / orsRank columns
                concurrency:        4,       // parallel fetches during bulk scrape
                staggerMs:          800,     // ms between launches in a wave
                lastBulkScrapeAt:   null,    // unix-ms; surfaces in the expander
                priceMaxAgeDays:    null,    // null = never expire; set to N to re-scrape entries older than N days

                // Tier 3 — apply / write-back configuration. Two gates have to
                // be cleared for a real POST: `apply.enabled` (top-level kill
                // switch) AND `apply.dryRunOnly === false`. Tier 3.1 ships
                // with `apply.dryRunOnly = true` so the user can rehearse the
                // full pipeline (preflight, body construction, apply log)
                // without any AS-side effect. Tier 3.2 flips dryRunOnly's
                // default to false; Tier 3.3 adds the silent-auto loop.
                apply: {
                    enabled:               false,   // top-level kill switch — false = no writes regardless of dryRunOnly
                    dryRunOnly:            true,    // 3.1 hard gate; 3.2 default flips to false
                    defaultScope: {
                        airportPair:         true,
                        flightNumbers:       true,
                        returnAirportPair:   false,
                        returnFlightNumbers: false
                    },
                    roundPolicy:           "nearest",  // "nearest" | "floor" | "ceil"
                    cooldownMinPerRoute:   60,         // 0 = disabled
                    warnAboveDeltaPct:     5,          // preflight warning threshold
                    requireConfirmAboveDeltaPct: 15,   // additional confirm step for large changes (3.2)
                    pricingApplyLogLimit:  200,        // global timeline cap
                    perRouteApplyLogLimit: 20,
                    submitButton:          "submit-prices",  // submit-prices | p::submit | submit-settings
                    showRecentApplies:     true,       // gate the "Recent applies" list under the expander
                    recentApplyPreviewCount: 10
                },

                // Pre-staged for Tier 3.3 silent-auto loop. Both must be
                // explicitly enabled by the user; the panel surfaces a
                // confirm modal on the first flip.
                autonomyMode:       "off",   // off | suggest | oneClick | batch
                silentAutoEnabled:  false,   // separate explicit gate for silent auto-apply
                silentAutoMaxPerDay:    20,
                silentAutoMaxPerHour:   5,
                silentAutoMinDeltaPct:  3,
                targetMargin:       null,
                competitorAdjust:   null
            },
            // Letter K — deeper per-route demand from AS market analysis.
            // Surfaces real demand-pool size + price elasticity per route
            // and per class, derived from the markets-page historic chart
            // (per-payload) plus the inventory page's RM buckets.
            demandDepth: {
                showDemandColumns:    true,    // gate the new column group
                // "full" by default (5 payloads — ECONOMY/BUSINESS/FIRST/PAX/CARGO).
                // Per-class historic is needed for ORS-aware pricing simulation
                // (Letter I, the next big-ticket build) and the user opted in.
                // Existing users keep their persisted preference via deep-merge.
                classCoverage:        "full",
                // Default ON. The estimator silently falls back to paxScore-based
                // LF when the demand-pool inputs are missing (profit-estimator.js
                // line 119-121), so this is safe for routes without cached data.
                // Existing users with persisted false stay false.
                useRealDemandForLF:   true,
                concurrency:          3,       // gentle — coexists with parallel ORS sync
                staggerMs:            1200,
                historicWindowPeriods: 12,     // last N weeks for the elasticity regression
                lastBulkScrapeAt:     null,
                historicMaxAgeDays:   14,      // 14-day cadence aligns with auto-refresh threshold below
                inventoryMaxAgeDays:  3        // RM data is volatile; expire after 3d
            },
            yieldFeedback: {
                // Roadmap G — yield-timeline / actual-yields feedback loop.
                showColumns:         true,    // gate the Actual $/flt + Δ% columns
                varianceWarnPct:     25,      // ±X% triggers the variance highlight
                attributionMode:     "frequency",  // frequency | distance | equal
                historyLimit:        12,      // keep newest N snapshots per route
                lastSnapshotAt:      null,    // unix-ms; surfaces in the expander
                autoSnapshotOnMount: false,   // when true, mount() fires a snapshot once after refresh
                deltaMode:           false    // when true, snapshot uses tail.profit delta since last snapshot
                                              // (true periodic yield), instead of cumulative-lifetime average
            },
            carriers: {
                // Letter F — full carrier list per route. Scrapes
                // flightsfrom.com per-pair detail pages on demand to
                // enrich the Cmp column with a colored intensity badge +
                // hover tooltip showing each carrier and their weekly
                // frequency.
                showCarrierIntensity: true,   // gate the colored intensity badge
                concurrency:          3,      // flightsfrom is slower than AS — keep it gentle
                staggerMs:            1200,
                lastBulkScrapeAt:     null,
                carriersMaxAgeDays:   30,     // 30d default; competitor moves don't need to be intra-day
                // F slice 2 — AS-native enterprise enrichment. Fetches
                // /app/info/enterprises/<id> per AS competitor seen in
                // marketShare data so the Cmp popover can render
                // banners + avatars + clickable enterprise links.
                enterpriseMetaConcurrency: 4,
                enterpriseMetaStaggerMs:   600,
                enterpriseMetaMaxAgeDays:  90,    // enterprises rarely rebrand
                lastEnterpriseMetaSyncAt:  null,
                // F slice 3 — Contractual partners. Fetches
                // /app/info/enterprises/<your_id>?tab=1 per own
                // enterprise to know who YOU have alliance / IL /
                // lessor agreements with. Cross-referenced at popover
                // render time to surface a ⇄ glyph next to interlining
                // partners (and optionally a ✦ for alliance partners).
                myEnterpriseIds:           [],     // user's own enterprise ids; UI accepts comma-separated entry
                partnersConcurrency:       2,      // typically 1-2 ids — small concurrency is fine
                partnersStaggerMs:         400,
                partnersMaxAgeDays:        30,     // less generous than meta — agreements move
                lastPartnersSyncAt:        null,
                showInterliningGlyph:      true,   // ⇄ next to IL partners in the popover
                showAllianceGlyph:         false,  // ✦ for alliance partners (off by default)
                // Cmp popover logo strip — alliance + enterprise banner
                // images sourced directly from /app/logo/<id>/enterprise-s.png
                // (enterprise) and the airport-overview Stations table
                // (alliance ids). When showAllianceLogos is off the
                // alliance slot is suppressed and the banner column takes
                // the row's full width.
                showAllianceLogos:         true,
                airportOverviewMaxAgeDays: 7       // alliance membership churns slowly
            },
            marketAnalysis: {
                // Tier 2a — markets-page scraper for /app/com/markets/<HUB><DEST>.
                // Sources: per-route competitor flights with prices + availability,
                // own pricing form snapshot, market-share leaderboard, 25-week
                // historic capacity/price charts. Stored split across 4
                // chrome.storage.local key families (competitors / ownPricing /
                // marketShare / historic) so each can have its own cadence.
                showColumns:          true,    // gates Mkt Share / Cmp# / Cmp$ / Drift cols
                concurrency:          4,
                staggerMs:            800,
                lastBulkScrapeAt:     null,
                competitorMaxAgeDays: null,    // null = never expire
                shareMaxAgeDays:      7,       // weekly cadence
                historicMaxAgeDays:   null,
                defaultPayloadChart:  "ECONOMY",   // PAX | ECONOMY | BUSINESS | FIRST | FREIGHT
                // Auto-refresh: when lastBulkScrapeAt exceeds staleThresholdDays,
                // the panel kicks off a background sync on mount (Markets +
                // demand depth, since the two are folded). User can dismiss via
                // a Skip button, suppressed for the same threshold window.
                autoRefreshOnMount:   true,
                staleThresholdDays:   14,
                lastAutoRefreshSkipAt: null
            },
            ors: {
                // Tier 2b — ORS rank scraper for /app/info/ors. Submits the
                // connection-search form per route (one query per cabin
                // class), walks all result pages, computes per-class rank
                // flavors + ratings, then projects a composite score using
                // user-configurable class weights. Storage lives at
                // `routeAssistant:ors:<HUB>-<DEST>.byClass.{ECONOMY,BUSINESS,FIRST}`.
                showColumns:          true,
                concurrency:          2,        // ORS = expensive AS solver, be gentle
                staggerMs:            1500,
                lastBulkScrapeAt:     null,
                rankMaxAgeDays:       null,

                // Default scrape parameters (user-tunable in expander):
                classesToScrape:      ["ECONOMY", "BUSINESS", "FIRST"],   // 1-3, multi-select
                defaultDepartureH:    0,         // 0..48
                defaultArrivalH:      72,        // 24..72
                defaultUseGround:     true,

                // Composite combining — how the per-class metrics merge into
                // the headline ORS score shown in the table.
                //   capacityWeighted (default) — derive weights from picked
                //     aircraft's cabin config; falls back to "standard"
                //     preset when no aircraft / specs unknown.
                //   weighted — fixed weights from `classWeights` (current preset).
                //   min / max / avg — pessimistic / optimistic / equal blend.
                combineMethod:        "capacityWeighted",
                weightPreset:         "capacityWeighted",   // matches a key in ORS_WEIGHT_PRESETS
                                                              // or "custom" when sliders are touched.
                classWeights:         {ECONOMY: 0.75, BUSINESS: 0.20, FIRST: 0.05},   // Standard

                // The "headline" class shown in compact view + drill-in
                // default tab. Used when one class needs to stand for all.
                primaryClass:         "ECONOMY",

                // Display preferences — every rank flavor surfaceable.
                primaryColumn:        "ratingGapToTop",
                // valid: ratingGapToTop | rankAny | rankFirstLegOurs | rankAllOurs |
                //        rankNonstop | rankBookable | ourTopRating | ourBestNonstopRating
                showRankAnyColumn:           true,
                showRankNonstopColumn:       true,
                showRatingGapColumn:         true,
                showCompetitorCountColumn:   true,
                showPerClassColumns:         true,    // Y / C / F per-class cols (auto-off in Compact view)
                minRatingThresholdDisplay:   null,    // hide values where ourTopRating < N

                // Carrier identification — flight-number set is primary, prefix is
                // fallback. User can override comma-separated list e.g. "FN,NY".
                airlineCarrierPrefixOverride: null,

                // Circuit breaker telemetry. If trip is recent, bulk button is
                // disabled for 10 min and a red banner shows in the expander.
                circuitBreakerTrippedAt: null,
                circuitBreakerCooldownMs: 600000  // 10 min
            },
            watchlist: {
                // Daily-driver QoL — per-row star toggle persists in
                // RouteAssistantWatchlistStore (single global key
                // `routeAssistant:watchlist`). The two settings here gate
                // the panel's *display* behaviour, not the storage:
                //   floatStarredToTop — pin starred rows above unstarred
                //     ones regardless of the user's chosen sort field.
                //   showAlertBadges   — render a red dot next to the star
                //     when the row's diff vs last visit shows a "worse"
                //     change in any RA_WATCH_TRIGGERS field.
                floatStarredToTop: true,
                showAlertBadges:   true
            },
            serviceProfiles: {
                // Per-route Y/C/F class mix + service-level posture. Each
                // route may pin its own override via the service-config
                // popover; otherwise the defaults below apply.
                showServiceColumns:    true,
                defaultClassMix:       {Y: 1.0, C: 0,  F: 0},   // single-class economy by default
                defaultServiceLevel:   "standard",
                // Per-class yield multipliers — applied to base yieldPerKm.
                // Y is the reference (1.0). C/F default to industry rules of
                // thumb. User-tunable.
                classYieldMult:        {Y: 1.0, C: 2.5, F: 4.5},
                // Per-pax variable cost (catering, lounges, comfort kit).
                // Applied per filled seat — distinct from block-hour costs.
                classCostPerPax:       {Y: 5,   C: 18,  F: 45},
                // Service-level posture multiplies the *effective* yield and
                // adds a fixed per-pax cost on top. Coarse model — proxies
                // ORS comfort/IFE/legroom contribution without scraping AS's
                // detailed service settings.
                serviceLevels: {
                    budget:   {yieldMult: 0.85, costPerPax: 3,  label: "Budget"},
                    standard: {yieldMult: 1.00, costPerPax: 8,  label: "Standard"},
                    premium:  {yieldMult: 1.20, costPerPax: 22, label: "Premium"}
                }
            }
        }
    }

    static async load() {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const defaults = RouteAssistantSettings._defaults()
        const block = settings.routeAssistant || {}

        // Top-level deep-fill, plus per-section deep-fill so each new field
        // arrives with its default without overwriting user-tuned siblings.
        const merged = {
            scoring:               Object.assign({}, defaults.scoring, block.scoring || {}),
            filters:               Object.assign({}, defaults.filters, block.filters || {}),
            flightsfromMaxAgeDays: block.flightsfromMaxAgeDays || defaults.flightsfromMaxAgeDays,
            distanceMaxAgeDays:    (typeof block.distanceMaxAgeDays === "number" && block.distanceMaxAgeDays > 0)
                                       ? block.distanceMaxAgeDays
                                       : defaults.distanceMaxAgeDays,
            collapsed:             !!block.collapsed,
            panelWidth:            (typeof block.panelWidth === "number" && block.panelWidth >= 600 && block.panelWidth <= 3000)
                                       ? block.panelWidth
                                       : defaults.panelWidth,
            compactView:           !!block.compactView,
            searchQuery:           (typeof block.searchQuery === "string") ? block.searchQuery : defaults.searchQuery,
            recentHubs:            Array.isArray(block.recentHubs)
                                       ? block.recentHubs.filter(h => typeof h === "string" && /^[A-Z]{3}$/.test(h)).slice(0, 5)
                                       : defaults.recentHubs,
            savedViews:            Array.isArray(block.savedViews)
                                       ? block.savedViews.filter(v => v && typeof v === "object" && typeof v.id === "string" && typeof v.name === "string")
                                       : defaults.savedViews,
            strategyPresets:       Array.isArray(block.strategyPresets)
                                       ? block.strategyPresets.filter(p => p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string" && p.snapshot && typeof p.snapshot === "object")
                                       : defaults.strategyPresets,
            columnPrefs:           RouteAssistantSettings._mergeColumnPrefs(defaults.columnPrefs, block.columnPrefs),
            viewMode:              (block.viewMode === "pax" || block.viewMode === "cargo" || block.viewMode === "all")
                                       ? block.viewMode
                                       : defaults.viewMode,
            panelMode:             RouteAssistantSettings._resolvePanelMode(block, defaults.panelMode),
            inspectorOpen:         !!block.inspectorOpen,
            waveView:              !!block.waveView,
            waveOverlay:           Object.assign({}, defaults.waveOverlay,   block.waveOverlay   || {}),
            heatmap:               Object.assign({}, defaults.heatmap,       block.heatmap       || {}),
            orsSandbox:            RouteAssistantSettings._mergeOrsSandbox(defaults.orsSandbox, block.orsSandbox),
            aircraft:              Object.assign({}, defaults.aircraft,      block.aircraft      || {}),
            economics:             Object.assign({}, defaults.economics,     block.economics     || {}),
            pricing:               RouteAssistantSettings._mergePricing(defaults.pricing, block.pricing),
            yieldFeedback:         Object.assign({}, defaults.yieldFeedback,   block.yieldFeedback   || {}),
            carriers:              Object.assign({}, defaults.carriers,        block.carriers        || {}),
            marketAnalysis:        Object.assign({}, defaults.marketAnalysis,  block.marketAnalysis  || {}),
            demandDepth:           Object.assign({}, defaults.demandDepth,     block.demandDepth     || {}),
            ors:                   RouteAssistantSettings._mergeOrs(defaults.ors, block.ors),
            watchlist:             Object.assign({}, defaults.watchlist,       block.watchlist       || {}),
            serviceProfiles:       RouteAssistantSettings._mergeServiceProfiles(defaults.serviceProfiles, block.serviceProfiles)
        }
        for (const key in defaults.scoring) {
            merged.scoring[key] = Object.assign({}, defaults.scoring[key], block.scoring && block.scoring[key] || {})
        }
        merged.filters.statuses = Object.assign({}, defaults.filters.statuses,
            (block.filters && block.filters.statuses) || {})

        if (!settings.routeAssistant) {
            settings.routeAssistant = merged
            await chrome.storage.local.set({settings: settings})
        }
        return merged
    }

    /**
     * Restructure slice A — resolve the active panel mode from either the
     * new `panelMode` string or the legacy boolean trio. Priority:
     *   1. explicit `panelMode` string (already migrated)
     *   2. legacy `waveView` flag (Wave View was in mutex group, so it wins)
     *   3. legacy `orsSandbox.enabled`
     *   4. legacy `heatmap.enabled`
     *   5. fall back to default ("table")
     *
     * The legacy booleans stay in storage for one release so a downgrade
     * doesn't strand the user in an unrecognised mode.
     */
    static _resolvePanelMode(block, fallback) {
        const VALID = {table: 1, waves: 1, sandbox: 1, heatmap: 1}
        if (block && typeof block.panelMode === "string" && VALID[block.panelMode]) {
            return block.panelMode
        }
        if (block && block.waveView) return "waves"
        if (block && block.orsSandbox && block.orsSandbox.enabled) return "sandbox"
        if (block && block.heatmap && block.heatmap.enabled) return "heatmap"
        return fallback || "table"
    }

    /**
     * Deep-merge the pricing block. Tier 3 introduces a nested `apply`
     * sub-object whose own `defaultScope` map needs deep-merge too —
     * a saved partial `{airportPair: false}` shouldn't blow away the
     * other three scope flags. Same pattern as `_mergeOrs`.
     */
    static _mergePricing(defaults, block) {
        const def = defaults || {}
        const b   = block    || {}
        const out = Object.assign({}, def, b)
        // Apply sub-block — deep-merge; the user-tuned siblings under
        // `pricing.apply` must survive a partial save (e.g., the modal
        // only writes `apply.enabled` but the other 11 fields stay put).
        const defApply = def.apply || {}
        const bApply   = b.apply   || {}
        out.apply = Object.assign({}, defApply, bApply)
        out.apply.defaultScope = Object.assign(
            {},
            defApply.defaultScope || {},
            bApply.defaultScope   || {}
        )
        return out
    }

    /**
     * Deep-merge serviceProfiles so newly-introduced classes / service-level
     * keys arrive with their defaults without wiping user-tuned siblings.
     */
    static _mergeServiceProfiles(defaults, block) {
        const def = defaults || {}
        const b = block || {}
        const out = Object.assign({}, def, b)
        const mergeMap = (defMap, bMap) => {
            const o = Object.assign({}, defMap || {})
            for (const k in (bMap || {})) {
                const v = Number(bMap[k])
                if (isFinite(v)) o[k] = v
            }
            return o
        }
        out.defaultClassMix  = mergeMap(def.defaultClassMix,  b.defaultClassMix)
        out.classYieldMult   = mergeMap(def.classYieldMult,   b.classYieldMult)
        out.classCostPerPax  = mergeMap(def.classCostPerPax,  b.classCostPerPax)
        out.serviceLevels    = Object.assign({}, def.serviceLevels || {})
        for (const lvl in (b.serviceLevels || {})) {
            out.serviceLevels[lvl] = Object.assign({},
                out.serviceLevels[lvl] || {},
                b.serviceLevels[lvl] || {})
        }
        return out
    }

    /**
     * Deep-merge ors block — preserves nested classWeights/classesToScrape
     * shape and lazy-renames the legacy `defaultPayload` field to
     * `primaryClass` so existing user settings keep working.
     */
    static _mergeOrs(defaults, block) {
        const out = Object.assign({}, defaults || {}, block || {})
        // Lazy rename defaultPayload → primaryClass, then drop the legacy
        // key so subsequent saves don't keep round-tripping a dead field.
        if (block && block.defaultPayload && !block.primaryClass) {
            out.primaryClass = block.defaultPayload
        }
        delete out.defaultPayload
        // Ensure classesToScrape is an array of valid class names.
        const VALID = {ECONOMY: 1, BUSINESS: 1, FIRST: 1, CARGO: 1}
        if (Array.isArray(block && block.classesToScrape)) {
            const filtered = block.classesToScrape.filter(c => VALID[c])
            out.classesToScrape = filtered.length ? filtered : defaults.classesToScrape
        }
        // classWeights — merge with defaults so a partial save (e.g. only Y
        // changed) doesn't drop C/F. Renormalise to sum to 1.0 so a stored
        // partial like {ECONOMY: 1.00} doesn't end up as {1.00, 0.20, 0.05}
        // (sum 1.25), which the composite scorer doesn't renormalise itself.
        const merged = Object.assign({}, defaults.classWeights || {},
            (block && block.classWeights) || {})
        out.classWeights = RouteAssistantSettings._renormaliseWeights(merged, defaults.classWeights)
        return out
    }

    /**
     * Deep-merge orsSandbox so nested modelParams / lastScenarioByRoute /
     * perRouteTemperature blocks gain new defaults without wiping user-
     * tuned siblings. The two flat maps (lastScenarioByRoute,
     * perRouteTemperature, perRouteTemperatureCalibratedAt) are preserved
     * verbatim with type validation per entry.
     *
     * Migration: the legacy global `lastScenario` field is preserved on
     * the output as `_legacyLastScenario` exactly once if `lastRouteIata`
     * is set and `lastScenarioByRoute` has no entry for that route — the
     * panel reads it as a one-time fallback so the user's last slider
     * positions don't reset across the upgrade. Subsequent saves drop it.
     */
    static _mergeOrsSandbox(defaults, block) {
        const def = defaults || {}
        const b = block || {}
        const out = {
            enabled:       !!b.enabled,
            lastRouteIata: typeof b.lastRouteIata === "string" ? b.lastRouteIata : def.lastRouteIata,
            lastScenarioByRoute:             {},
            modelParams:   Object.assign({}, def.modelParams || {}, b.modelParams || {}),
            perRouteTemperature:             {},
            perRouteTemperatureCalibratedAt: {},
            // Slice 2c — deep-merge nested ratingObservations block. Booleans
            // pass through `!!` so a stored stale string can't break the
            // downstream auto-log gate. Numerics fall through Object.assign
            // and are coerced at the read site.
            ratingObservations: Object.assign(
                {}, def.ratingObservations || {}, b.ratingObservations || {})
        }
        // Validate per-route scenarios — every entry must carry per-class
        // priceMultipliers (Y/C/F numeric in [0.30, 3.00]) or the legacy
        // single priceMultiplier (auto-migrated to all three classes).
        // Drop malformed records silently rather than crash.
        const sbr = b.lastScenarioByRoute
        if (sbr && typeof sbr === "object") {
            for (const k in sbr) {
                const v = sbr[k]
                if (!v || typeof v !== "object") continue
                const pms = RouteAssistantSettings._coerceScenarioMultipliers(v)
                if (!pms) continue
                const cd  = Number(v.comfortDelta)
                const cm  = RouteAssistantSettings._coerceCargoMultiplier(v.cargoMultiplier)
                out.lastScenarioByRoute[k] = {
                    priceMultipliers: pms,
                    cargoMultiplier:  cm,
                    frequency:        (v.frequency == null ? null
                                        : (isFinite(Number(v.frequency)) ? Number(v.frequency) : null)),
                    comfortDelta:     isFinite(cd) ? cd : 0
                }
            }
        }
        // Per-route T — number, positive.
        const ts = b.perRouteTemperature
        if (ts && typeof ts === "object") {
            for (const k in ts) {
                const v = Number(ts[k])
                if (isFinite(v) && v > 0) out.perRouteTemperature[k] = v
            }
        }
        // calibratedAt — ms epoch, positive integer. Only kept for keys
        // that also have a T entry (a stamp without a T is meaningless).
        const cs = b.perRouteTemperatureCalibratedAt
        if (cs && typeof cs === "object") {
            for (const k in cs) {
                if (out.perRouteTemperature[k] == null) continue
                const v = Number(cs[k])
                if (isFinite(v) && v > 0) out.perRouteTemperatureCalibratedAt[k] = v
            }
        }
        // One-time legacy migration: surface the pre-per-route lastScenario
        // for the route that was last open. Never persisted under this key
        // — the panel reads it once on first render of `lastRouteIata` and
        // promotes it into `lastScenarioByRoute` on the next save.
        if (b.lastScenario && typeof b.lastScenario === "object" && b.lastRouteIata) {
            out._legacyLastScenario = Object.assign({}, b.lastScenario)
        }
        return out
    }

    /**
     * U7 + U3 — coerce columnPrefs to the documented shape and drop
     * frozen-column entries from `hiddenFields`. The chooser modal in
     * panel.js renders `score` and `destIata` as disabled-checked but
     * defensive layering keeps a malformed save from removing the
     * sticky-left identity columns. `collapsedGroups` keys are NOT
     * validated here against COLUMN_GROUPS — the panel filters at
     * render time so a future group rename gets a graceful fallback
     * (the unknown key is simply ignored, no rows lost).
     */
    static _mergeColumnPrefs(defaults, block) {
        const def = defaults || {hiddenFields: [], collapsedGroups: []}
        const b = block || {}
        const FROZEN = {score: 1, destIata: 1}
        const hidden = Array.isArray(b.hiddenFields)
            ? b.hiddenFields.filter(f => typeof f === "string" && !FROZEN[f])
            : (def.hiddenFields || []).slice()
        const collapsed = Array.isArray(b.collapsedGroups)
            ? b.collapsedGroups.filter(g => typeof g === "string")
            : (def.collapsedGroups || []).slice()
        return {hiddenFields: hidden, collapsedGroups: collapsed}
    }

    /**
     * Coerce a saved per-route scenario into the slice 2 shape:
     *   priceMultipliers: {Y, C, F}, each in [0.30, 3.00].
     * Accepts the slice 1 shape (single `priceMultiplier` numeric) and
     * fans the legacy value out to all three classes. Returns null when
     * neither shape provides a usable Y multiplier (caller drops the
     * record entirely).
     */
    static _coerceScenarioMultipliers(v) {
        const clamp = (n) => {
            const x = Number(n)
            if (!isFinite(x) || x <= 0) return null
            return Math.max(0.30, Math.min(3.00, x))
        }
        const pm = v && v.priceMultipliers
        if (pm && typeof pm === "object") {
            const Y = clamp(pm.Y), C = clamp(pm.C), F = clamp(pm.F)
            if (Y == null && C == null && F == null) return null
            return {Y: Y != null ? Y : 1, C: C != null ? C : 1, F: F != null ? F : 1}
        }
        const legacy = clamp(v && v.priceMultiplier)
        if (legacy == null) return null
        return {Y: legacy, C: legacy, F: legacy}
    }

    /** Coerce a `cargoMultiplier` numeric to [0.30, 3.00]; absent → 1.0. */
    static _coerceCargoMultiplier(v) {
        const x = Number(v)
        if (!isFinite(x) || x <= 0) return 1
        return Math.max(0.30, Math.min(3.00, x))
    }

    /**
     * Renormalise a {ECONOMY, BUSINESS, FIRST, …} weights object so the
     * non-negative entries sum to 1.0. If the input is degenerate (sum ≤ 0
     * or all non-finite), fall back to `fallback` (typically the default
     * weights). Negative entries are clamped to 0.
     */
    static _renormaliseWeights(weights, fallback) {
        if (!weights || typeof weights !== "object") return Object.assign({}, fallback || {})
        let sum = 0
        const cleaned = {}
        for (const k in weights) {
            const v = Number(weights[k])
            const safe = isFinite(v) && v > 0 ? v : 0
            cleaned[k] = safe
            sum += safe
        }
        if (sum <= 0) return Object.assign({}, fallback || {})
        for (const k in cleaned) cleaned[k] = cleaned[k] / sum
        return cleaned
    }

    /**
     * Partial update — pass only the keys you want to change.
     */
    static async save(partial) {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const current = await RouteAssistantSettings.load()
        const next = Object.assign({}, current, partial || {})
        settings.routeAssistant = next
        await chrome.storage.local.set({settings: settings})
        return next
    }
}

/**
 * Multi-class ORS scoring weight presets — model different airline
 * playstyles. Values are passenger-mix percentages (Y / C / F) tuned
 * against typical real-world airline cabin configurations.
 *
 * "capacityWeighted" is special — weights are derived at composite-time
 * from the picked aircraft's seat config, not from this table. The entry
 * below is a fallback used when no aircraft is selected.
 */
RouteAssistantSettings.ORS_WEIGHT_PRESETS = {
    "allEconomy":       {label: "All Economy",       weights: {ECONOMY: 1.00, BUSINESS: 0.00, FIRST: 0.00},
                         description: "Pure leisure carrier, LCC, regional, Y-only fleet."},
    "standard":         {label: "Standard",          weights: {ECONOMY: 0.75, BUSINESS: 0.20, FIRST: 0.05},
                         description: "Most full-service narrowbody / domestic widebody — close to industry average."},
    "twoClass":         {label: "Two-class",         weights: {ECONOMY: 0.60, BUSINESS: 0.40, FIRST: 0.00},
                         description: "Modern long-haul without F (Lufthansa, BA, Air Canada style)."},
    "businessHeavy":    {label: "Business-heavy",    weights: {ECONOMY: 0.40, BUSINESS: 0.50, FIRST: 0.10},
                         description: "Premium business hubs, transcon (JFK-LAX, JFK-SFO style)."},
    "premiumLongHaul":  {label: "Premium long-haul", weights: {ECONOMY: 0.30, BUSINESS: 0.40, FIRST: 0.30},
                         description: "Flagship A380 / 777-300ER (Emirates, Singapore, Etihad)."},
    "capacityWeighted": {label: "Capacity-weighted (auto)", weights: {ECONOMY: 0.75, BUSINESS: 0.20, FIRST: 0.05},
                         description: "Derived from picked aircraft's cabin config. Falls back to Standard when no aircraft selected."},
    "custom":           {label: "Custom",            weights: null,
                         description: "Manually tuned via the per-class weight inputs in More options."}
}
