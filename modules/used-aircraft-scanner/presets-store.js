/**
 * CRUD wrapper for `settings.usedAircraftScanner.presets`.
 *
 * A preset describes a strategic-intent scan profile:
 *   {
 *     id,                              // "p<base36ts>" or built-in slug
 *     name,
 *     builtIn?,                        // true → read-only, refuses update/remove
 *     blurb?,                          // optional UI description
 *     mode,                            // "lease" | "buy"  (drives basis)
 *     termMonths?,                     // lease amortisation horizon
 *     weights?,                        // partial classifierWeights override
 *     filters?,                        // {minRangeKm, categories, classes}
 *     types: [string]                  // AS Type dropdown labels (existing)
 *   }
 *
 * Backwards compatibility: legacy presets without `mode` default to "buy"
 * when applied (the pre-rework behaviour) so older user blobs keep working
 * until the user picks a mode-aware preset.
 *
 * Settings live inside the single `settings` key in chrome.storage.local —
 * mirrors the `settings.flightInfo` / `settings.routeManagement` etc. pattern
 * established elsewhere in the extension.
 */
class UsedAircraftPresets {

    /**
     * Strategic-intent built-ins. Read-only; surface alongside user-saved
     * presets. Each bundles a mode, term, weight overrides, and filters so
     * picking one sets the whole scanner context in a single click. Modeled
     * after `modules/strategy/risk-profiles.js` (Slice 17) — same {label,
     * blurb, weights, settings} shape, applied via UsedAircraftPresets.apply.
     *
     * Why these three: the user explicitly framed the scanner's job as
     * "find planes to lease", so all three are lease-mode. They split the
     * space along the axis the user actually thinks about — chasing route
     * demand, hunting long-haul replacements, or expanding regional reach
     * cheaply. Users can save more bespoke variants; built-ins refuse
     * mutation so they keep working as a stable reset reference.
     */
    static BUILT_IN_PRESETS = [
        {
            id: "lease-for-routes",
            name: "Lease for high-demand routes",
            builtIn: true,
            blurb: "Lease the cheapest seat that fits your top routes. Heavy on route fit + fuel efficiency.",
            mode: "lease",
            termMonths: 60,
            weights: {
                pricePerSeat:   40,
                seatKmYearCost: 10,
                fuelEfficiency: 25,
                condition:      10,
                age:             5,
                expiry:          5,
                fleetSynergy:    5,
                routeFit:       20
            },
            filters: {minRangeKm: null, categories: []},
            types: []
        },
        {
            id: "long-haul-hunt",
            name: "Long-haul widebody hunt",
            builtIn: true,
            blurb: "Hunt long-range leases. Range floor 8000km; rewards fuel efficiency + fleet synergy.",
            mode: "lease",
            termMonths: 60,
            weights: {
                pricePerSeat:   35,
                seatKmYearCost: 10,
                fuelEfficiency: 30,
                condition:      15,
                age:            10,
                expiry:          5,
                fleetSynergy:   10,
                routeFit:       10
            },
            filters: {minRangeKm: 8000, categories: ["widebody"]},
            types: []
        },
        {
            id: "budget-commuter",
            name: "Budget commuter expansion",
            builtIn: true,
            blurb: "Cheapest lease/seat in commuter + turboprop bands. Low entry cost over fleet polish.",
            mode: "lease",
            termMonths: 60,
            weights: {
                pricePerSeat:   50,
                seatKmYearCost: 10,
                fuelEfficiency: 20,
                condition:      15,
                age:             5,
                expiry:          5,
                fleetSynergy:    5,
                routeFit:       10
            },
            filters: {minRangeKm: null, categories: ["commuter", "turboprop"]},
            types: []
        },
        // Buy-mode bundles. Scoring is still anchored on lease rate (the
        // used market's auction prices are too noisy for a useful $/seat),
        // but the weight bundles bias toward signals that matter for
        // outright ownership: condition + age over routes-of-the-moment,
        // fleet synergy heavier (you live with these airframes for years).
        // The displayed price columns swap to NEXT BID + IMMEDIATE PURCHASE
        // automatically when mode === "buy" — that lives in results-table.
        {
            id: "buy-narrowbody-hunt",
            name: "Narrowbody buyout hunt",
            builtIn: true,
            blurb: "Outright-buy 737/A320-class narrowbodies. Heavy on condition + age + fleet synergy.",
            mode: "buy",
            termMonths: 60,
            weights: {
                pricePerSeat:   25,
                seatKmYearCost: 10,
                fuelEfficiency: 20,
                condition:      20,
                age:            10,
                expiry:          0,
                fleetSynergy:   10,
                routeFit:        5
            },
            filters: {minRangeKm: 3000, categories: ["narrowbody"]},
            types: []
        },
        {
            id: "buy-widebody-expansion",
            name: "Widebody fleet expansion buy",
            builtIn: true,
            blurb: "Add long-haul capacity. Range floor 8000km; rewards lifecycle cost + condition + payback.",
            mode: "buy",
            termMonths: 60,
            weights: {
                pricePerSeat:   20,
                seatKmYearCost: 25,
                fuelEfficiency: 15,
                condition:      20,
                age:            10,
                expiry:          0,
                fleetSynergy:    5,
                routeFit:        5
            },
            filters: {minRangeKm: 8000, categories: ["widebody"]},
            types: []
        },
        {
            id: "buy-regional-quick",
            name: "Quick regional buy",
            builtIn: true,
            blurb: "Small-op regionals + commuters. Reliability matters most — heavy on condition + age.",
            mode: "buy",
            termMonths: 60,
            weights: {
                pricePerSeat:   25,
                seatKmYearCost: 10,
                fuelEfficiency: 15,
                condition:      25,
                age:            15,
                expiry:          0,
                fleetSynergy:    5,
                routeFit:        5
            },
            filters: {minRangeKm: null, categories: ["regional", "commuter"]},
            types: []
        }
    ]

    /**
     * Read-only lookup of every preset (built-ins first, then user-saved
     * from the supplied block). Callers that only need built-ins can read
     * BUILT_IN_PRESETS directly.
     */
    static allPresets(block) {
        const user = (block && Array.isArray(block.presets)) ? block.presets : []
        return UsedAircraftPresets.BUILT_IN_PRESETS.concat(user)
    }

    static findPreset(block, id) {
        if (!id) return null
        const all = UsedAircraftPresets.allPresets(block)
        return all.find(p => p && p.id === id) || null
    }

    static isBuiltIn(id) {
        return UsedAircraftPresets.BUILT_IN_PRESETS.some(p => p.id === id)
    }

    /**
     * Build the settings patch for a named preset. Pure function — caller
     * passes the result to UsedAircraftPresets.save(). Modeled after
     * AesStrategyRiskProfiles.apply: weights deep-merge so non-preset
     * weight overrides survive a switch (the user's tweak to e.g. expiry
     * isn't blown away by picking a route-fit-heavy preset).
     */
    static apply(presetId, currentBlock) {
        const block = currentBlock || {}
        const preset = UsedAircraftPresets.findPreset(block, presetId)
        if (!preset) return null
        const curWeights = block.classifierWeights || {}
        const curEnabled = curWeights.enabled || {}
        const nextWeights = Object.assign({}, curWeights, preset.weights || {})
        nextWeights.enabled = Object.assign({}, curEnabled)
        const curLease = block.leaseConfig || {}
        const nextLease = Object.assign({}, curLease, {
            mode:       preset.mode || curLease.mode || "lease",
            termMonths: preset.termMonths || curLease.termMonths || 60
        })
        const presetFilters = preset.filters || {}
        const curRouteFilter = block.routeFilter || {}
        const nextRouteFilter = Object.assign({}, curRouteFilter,
            ("minRangeKm" in presetFilters) ? {minRangeKm: presetFilters.minRangeKm} : {})
        return {
            activePresetId:    preset.id,
            classifierWeights: nextWeights,
            leaseConfig:       nextLease,
            routeFilter:       nextRouteFilter
        }
    }

    /**
     * Returns the active preset id ("lease-for-routes", "p1234abc", etc.)
     * when the saved block has one stamped, or null if the user has
     * diverged from any known preset.
     */
    static detect(block) {
        return (block && typeof block.activePresetId === "string") ? block.activePresetId : null
    }

    static _defaults() {
        return {
            presets: [],
            typeFamilyOverrides: {},
            concurrency: 6,
            staggerMs: 2000,
            lastScanId: null,
            routeFilter: {
                // Aircraft must have at least this range (km) to be kept in
                // results. Null = no route filter applied.
                minRangeKm: null
            },
            routeFit: {
                // Per-flight seats threshold scale used by the route-fit
                // metric (J slice 4 v2). For a Route Assistant top-route with
                // paxScore=N, the aircraft is considered to fit only when
                // seats × LF ≥ N × paxSeatsPerScorePoint AND range covers the
                // distance. Tunable so users can dial it for their server's
                // demand profile; default 15 makes paxScore=10 require a
                // ~150-effective-seat aircraft (small narrowbody minimum).
                paxSeatsPerScorePoint: 15,
                // Weekly seats threshold scale (J slice 4 v3). After the
                // per-flight gate passes, the aircraft must also keep up at
                // the route's published weekly frequency:
                // weeklyFlights × seats × LF ≥ paxScore × weeklyDemandPerScorePoint.
                // Default 100 means paxScore=10 needs 1000 effective weekly
                // seats — a 150-seat narrowbody at LF 0.75 satisfies it at
                // ~9 flights/wk. Routes without a published weeklyFlights
                // skip this gate (no penalty).
                weeklyDemandPerScorePoint: 100
            },
            scoring: {
                ageYears:          {enabled: true,  weight: 1, min: null, max: null},
                conditionPct:      {enabled: false, weight: 1, min: null, max: null},
                seats:             {enabled: false, weight: 1, min: null, max: null},
                cargoCapacity:     {enabled: false, weight: 1, min: null, max: null},
                speed:             {enabled: false, weight: 1, min: null, max: null},
                range:             {enabled: false, weight: 1, min: null, max: null},
                paxSatisfaction:   {enabled: false, weight: 1, min: null, max: null},
                nextBid:           {enabled: true,  weight: 1, min: null, max: null},
                immediatePurchase: {enabled: false, weight: 1, min: null, max: null},
                leasingRate:       {enabled: false, weight: 1, min: null, max: null},
                // Slice-2 deal-scoring fields. pricePerSeat on by default
                // (universally relevant); the rest off so the score blend
                // doesn't shift on existing presets without user opt-in.
                pricePerSeat:      {enabled: true,  weight: 1, min: null, max: null},
                seatKmYearCost:    {enabled: false, weight: 1, min: null, max: null},
                breakEvenDays:     {enabled: false, weight: 1, min: null, max: null},
                routeFitCount:     {enabled: false, weight: 1, min: null, max: null}
            },
            // User-tunable weights for the absolute deal classifier. Numbers
            // are relative shares; `enabled` lets a user zero out a
            // component without losing its weight value. Defaults mirror
            // MarketScanDealClassifier.MODE_WEIGHTS.lease (the default mode).
            classifierWeights: {
                pricePerSeat:    30,
                seatKmYearCost:  10,
                fuelEfficiency:  25,
                condition:       10,
                age:              5,
                expiry:           5,
                fleetSynergy:     5,
                routeFit:        20,
                enabled: {
                    pricePerSeat: true, seatKmYearCost: true, fuelEfficiency: true,
                    condition: true, age: true, expiry: true, fleetSynergy: true, routeFit: true
                }
            },
            // Lease-economics handling.
            //   mode === "lease": $/seat math uses monthly lease × termMonths;
            //     rows without a lease offer drop out of price scoring.
            //   mode === "buy":   purchase price drives $/seat; lease ignored.
            // Default lease — the scanner exists to find planes to lease.
            leaseConfig: {
                mode:       "lease",
                termMonths: 60
            },
            // Stamp of the currently-applied built-in or user preset id, if
            // any. Used by the UI to highlight the active option in the
            // preset dropdown. null = user is on custom (no preset clicked
            // since last manual edit).
            activePresetId: null,
            // Fuel-efficiency component knobs. The classifier reuses
            // RouteAssistantFuelBurn.heuristic — overrideFuelPriceASc lets a
            // user pin the fuel price (cents/litre) instead of pulling it
            // from RouteAssistantSettings.economics.
            fuelConfig: {
                enabled:              true,
                overrideFuelPriceASc: null
            },
            // Persisted collapse state for the dashboard panel sections.
            // Filters open by default since they're high-utility; advanced and
            // queue tucked away by default. scoringOpen is the in-page market
            // panel's Scoring section.
            uiState: {
                advancedOpen: false,
                filtersOpen:  true,
                queueOpen:    false,
                scoringOpen:  false
            },
            // Per-type watchlist surfaced on the in-page panel's model-overview
            // cards. STEAL classifications inside any of these types fire a
            // chrome notification on scan completion. Plain string array so
            // older blobs without it can upgrade trivially.
            watchlist: [],
            // Tab-bound auto-rescan. Honest scope: ticks while the market tab
            // is mounted — full background scheduling needs cross-tab
            // orchestration we haven't built yet. presetId pins the scope of
            // the rescan; lastRunAt stamps the most recent kick.
            schedule: {
                enabled:    false,
                cadenceMin: 60,
                presetId:   null,
                lastRunAt:  null
            }
        }
    }

    /**
     * Reads `settings.usedAircraftScanner`, lazily initialising it if missing.
     * Always returns a fully-populated object: nested keys (uiState, routeFilter,
     * scoring) are deep-merged against defaults so an older blob with partial
     * sub-objects doesn't drop newly-introduced keys.
     */
    static async load() {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const defaults = UsedAircraftPresets._defaults()
        const stored   = settings.usedAircraftScanner || {}
        const block = Object.assign({}, defaults, stored)
        block.uiState     = Object.assign({}, defaults.uiState,     stored.uiState     || {})
        block.routeFilter = Object.assign({}, defaults.routeFilter, stored.routeFilter || {})
        block.routeFit    = Object.assign({}, defaults.routeFit,    stored.routeFit    || {})
        block.scoring     = Object.assign({}, defaults.scoring)
        for (const k in (stored.scoring || {})) {
            block.scoring[k] = Object.assign(
                {enabled: false, weight: 1, min: null, max: null},
                defaults.scoring[k] || {},
                stored.scoring[k] || {}
            )
        }
        // New (lease-first rework) blocks. Sub-merge so older blobs missing
        // these keys get the defaults without overwriting any partial overrides.
        block.classifierWeights = Object.assign(
            {}, defaults.classifierWeights, stored.classifierWeights || {}
        )
        block.classifierWeights.enabled = Object.assign(
            {}, defaults.classifierWeights.enabled,
            (stored.classifierWeights && stored.classifierWeights.enabled) || {}
        )
        block.leaseConfig = Object.assign({}, defaults.leaseConfig, stored.leaseConfig || {})
        // Migrate pre-mode blobs: a stored `leaseFirst === false` meant the
        // user had opted into purchase-first scoring, so map it to "buy".
        // Anything else (lease-first or absent) becomes "lease". After
        // migration we strip the legacy keys so they don't drift back in.
        if (!block.leaseConfig.mode) {
            block.leaseConfig.mode = stored.leaseConfig && stored.leaseConfig.leaseFirst === false
                ? "buy" : "lease"
        }
        delete block.leaseConfig.leaseFirst
        delete block.leaseConfig.fallbackPurchase
        block.fuelConfig  = Object.assign({}, defaults.fuelConfig,  stored.fuelConfig  || {})
        block.watchlist   = Array.isArray(stored.watchlist) ? stored.watchlist.slice() : []
        block.schedule    = Object.assign({}, defaults.schedule,   stored.schedule    || {})
        if (!settings.usedAircraftScanner) {
            settings.usedAircraftScanner = block
            await chrome.storage.local.set({settings: settings})
        }
        return block
    }

    /**
     * Persists a partial update to settings.usedAircraftScanner.
     * Pass an object with only the fields you want to change.
     */
    static async save(partial) {
        const data = await chrome.storage.local.get(["settings"])
        const settings = data.settings || {}
        const current = Object.assign(
            {}, UsedAircraftPresets._defaults(),
            settings.usedAircraftScanner || {},
            partial
        )
        settings.usedAircraftScanner = current
        await chrome.storage.local.set({settings: settings})
        return current
    }

    /**
     * Create a new user preset. The legacy two-arg form
     * `create(name, types)` still works; pass a single object to set the
     * full strategic-intent shape (mode, weights, filters, termMonths,
     * blurb).
     *
     * @param {string|object} nameOrFields
     * @param {string[]} [types]
     * @returns {Promise<object>} the new preset
     */
    static async create(nameOrFields, types) {
        const fields = (nameOrFields && typeof nameOrFields === "object")
            ? nameOrFields : {name: nameOrFields, types: types}
        const block = await UsedAircraftPresets.load()
        const preset = {
            id:    "p" + Date.now().toString(36),
            name:  (fields.name || "Untitled").trim() || "Untitled",
            types: (fields.types || []).map(t => t.trim()).filter(Boolean)
        }
        if (fields.mode === "lease" || fields.mode === "buy") preset.mode = fields.mode
        if (fields.termMonths !== undefined) preset.termMonths = Number(fields.termMonths) || 60
        if (fields.weights && typeof fields.weights === "object") preset.weights = Object.assign({}, fields.weights)
        if (fields.filters && typeof fields.filters === "object") preset.filters = Object.assign({}, fields.filters)
        if (typeof fields.blurb === "string") preset.blurb = fields.blurb
        block.presets.push(preset)
        await UsedAircraftPresets.save({presets: block.presets})
        return preset
    }

    static async update(id, fields) {
        if (UsedAircraftPresets.isBuiltIn(id)) return null
        const block = await UsedAircraftPresets.load()
        const preset = block.presets.find(p => p.id === id)
        if (!preset) return null
        if (fields.name !== undefined) preset.name = fields.name.trim() || preset.name
        if (fields.types !== undefined) {
            preset.types = (fields.types || []).map(t => t.trim()).filter(Boolean)
        }
        if (fields.mode === "lease" || fields.mode === "buy") preset.mode = fields.mode
        if (fields.termMonths !== undefined) preset.termMonths = Number(fields.termMonths) || preset.termMonths || 60
        if (fields.weights && typeof fields.weights === "object") {
            preset.weights = Object.assign({}, preset.weights || {}, fields.weights)
        }
        if (fields.filters && typeof fields.filters === "object") {
            preset.filters = Object.assign({}, preset.filters || {}, fields.filters)
        }
        if (typeof fields.blurb === "string") preset.blurb = fields.blurb
        await UsedAircraftPresets.save({presets: block.presets})
        return preset
    }

    static async remove(id) {
        if (UsedAircraftPresets.isBuiltIn(id)) return false
        const block = await UsedAircraftPresets.load()
        const before = block.presets.length
        block.presets = block.presets.filter(p => p.id !== id)
        if (block.presets.length !== before) {
            await UsedAircraftPresets.save({presets: block.presets})
            return true
        }
        return false
    }

    /**
     * Clones the given preset (built-in or user) into a fresh user preset
     * with a new id and the full strategic-intent payload. Returns the new
     * preset, or null when the source id is unknown.
     */
    static async duplicate(id) {
        const block = await UsedAircraftPresets.load()
        const source = UsedAircraftPresets.findPreset(block, id)
        if (!source) return null
        return UsedAircraftPresets.create({
            name:       (source.name || "Untitled") + " (copy)",
            types:      (source.types || []).slice(),
            mode:       source.mode,
            termMonths: source.termMonths,
            weights:    source.weights ? Object.assign({}, source.weights) : undefined,
            filters:    source.filters ? Object.assign({}, source.filters) : undefined,
            blurb:      source.blurb
        })
    }
}
