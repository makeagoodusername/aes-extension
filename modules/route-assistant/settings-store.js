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
                fleetFlyableOnly: false
            },
            flightsfromMaxAgeDays: 7,
            distanceMaxAgeDays:    null,    // null = never expire; set to N to re-resolve entries older than N days
            collapsed: false,
            panelWidth: 1100,               // px, user-resizable via left-edge drag handle (clamp 600–3000)
            compactView: false,             // master toggle in the panel header — hides heavy column groups in one click
            // Tabbed view selector (Pax / Cargo / All). Default "all"
            // preserves the existing combined table for users without a
            // strong mode preference. Tab switches column visibility
            // and the scoring-field set; the underlying row data is
            // shared across all three.
            viewMode: "all",
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

                // Tier 2/3 — placeholders. Auto-pricing UI gates land in
                // future slices; storing the keys now keeps deep-merge
                // happy when those tiers ship.
                autonomyMode:       "off",   // off | suggest | oneClick | batch
                silentAutoEnabled:  false,   // separate explicit gate for silent auto-apply
                targetMargin:       null,
                competitorAdjust:   null
            },
            // Letter K — deeper per-route demand from AS market analysis.
            // Surfaces real demand-pool size + price elasticity per route
            // and per class, derived from the markets-page historic chart
            // (per-payload) plus the inventory page's RM buckets.
            demandDepth: {
                showDemandColumns:    true,    // gate the new column group
                classCoverage:        "summary",   // "summary" (PAX+CARGO) | "full" (5 payloads)
                useRealDemandForLF:   false,   // opt-in profit-estimator switch
                concurrency:          3,       // gentle — coexists with parallel ORS sync
                staggerMs:            1200,
                historicWindowPeriods: 12,     // last N weeks for the elasticity regression
                lastBulkScrapeAt:     null,
                historicMaxAgeDays:   null,    // markets historic — null = forever
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
                showAllianceGlyph:         false   // ✦ for alliance partners (off by default)
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
                defaultPayloadChart:  "ECONOMY"   // PAX | ECONOMY | BUSINESS | FIRST | FREIGHT
            },
            ors: {
                // Tier 2b — ORS rank scraper for /app/info/ors. Submits the
                // connection-search form per route, walks all result pages,
                // computes every rank flavor + ratings. Per user direction
                // (MAXIMISE OPTIONS): store all rank flavors + full connection
                // list so the panel can re-derive any metric at render time
                // without re-scraping.
                showColumns:          true,
                concurrency:          2,        // ORS = expensive AS solver, be gentle
                staggerMs:            1500,
                lastBulkScrapeAt:     null,
                rankMaxAgeDays:       null,

                // Default scrape parameters (user-tunable in expander):
                defaultPayload:       "ECONOMY", // ECONOMY | BUSINESS | FIRST | CARGO
                defaultDepartureH:    0,         // 0..48
                defaultArrivalH:      72,        // 24..72
                defaultUseGround:     true,

                // Display preferences — every rank flavor surfaceable.
                primaryColumn:        "ratingGapToTop",
                // valid: ratingGapToTop | rankAny | rankFirstLegOurs | rankAllOurs |
                //        rankNonstop | rankBookable | ourTopRating | ourBestNonstopRating
                showRankAnyColumn:           true,
                showRankNonstopColumn:       true,
                showRatingGapColumn:         true,
                showCompetitorCountColumn:   true,
                minRatingThresholdDisplay:   null,   // hide values where ourTopRating < N

                // Carrier identification — flight-number set is primary, prefix is
                // fallback. User can override comma-separated list e.g. "FGM,NYO".
                airlineCarrierPrefixOverride: null,

                // Circuit breaker telemetry. If trip is recent, bulk button is
                // disabled for 10 min and a red banner shows in the expander.
                circuitBreakerTrippedAt: null,
                circuitBreakerCooldownMs: 600000  // 10 min
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
            viewMode:              (block.viewMode === "pax" || block.viewMode === "cargo" || block.viewMode === "all")
                                       ? block.viewMode
                                       : defaults.viewMode,
            aircraft:              Object.assign({}, defaults.aircraft,      block.aircraft      || {}),
            economics:             Object.assign({}, defaults.economics,     block.economics     || {}),
            pricing:               Object.assign({}, defaults.pricing,       block.pricing       || {}),
            yieldFeedback:         Object.assign({}, defaults.yieldFeedback,   block.yieldFeedback   || {}),
            carriers:              Object.assign({}, defaults.carriers,        block.carriers        || {}),
            marketAnalysis:        Object.assign({}, defaults.marketAnalysis,  block.marketAnalysis  || {}),
            demandDepth:           Object.assign({}, defaults.demandDepth,     block.demandDepth     || {}),
            ors:                   Object.assign({}, defaults.ors,             block.ors             || {}),
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
