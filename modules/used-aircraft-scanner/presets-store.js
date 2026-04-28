/**
 * CRUD wrapper for `settings.usedAircraftScanner.presets`.
 *
 * A preset = { id, name, types: [string] } where each `type` is the AS Type
 * dropdown label (e.g. "Airbus A320-200 heavy"). Presets may mix families.
 *
 * Settings live inside the single `settings` key in chrome.storage.local —
 * mirrors the `settings.flightInfo` / `settings.routeManagement` etc. pattern
 * established elsewhere in the extension.
 */
class UsedAircraftPresets {
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
            // User-tunable weights for the absolute deal classifier (in-page
            // market panel). Numbers are relative — what matters is the share
            // each component takes of the total. `enabled` lets a user zero
            // out a component without losing its weight value.
            classifierWeights: {
                pricePerSeat:    35,
                seatKmYearCost:  15,
                fuelEfficiency:  20,
                condition:       10,
                age:             10,
                expiry:           5,
                fleetSynergy:     5,
                routeFit:        10,
                enabled: {
                    pricePerSeat: true, seatKmYearCost: true, fuelEfficiency: true,
                    condition: true, age: true, expiry: true, fleetSynergy: true, routeFit: true
                }
            },
            // Lease-economics handling. When leaseFirst is on, $/seat and
            // payback math use monthly lease × termMonths as the cost basis;
            // rows without a lease offer fall back to purchase math when
            // fallbackPurchase is on (otherwise they're scored without a
            // pricePerSeat component at all).
            leaseConfig: {
                leaseFirst:       true,
                termMonths:       60,
                fallbackPurchase: true
            },
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
        block.fuelConfig  = Object.assign({}, defaults.fuelConfig,  stored.fuelConfig  || {})
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
     * @param {string} name
     * @param {string[]} types
     * @returns {Promise<object>} the new preset
     */
    static async create(name, types) {
        const block = await UsedAircraftPresets.load()
        const preset = {
            id: "p" + Date.now().toString(36),
            name: (name || "Untitled").trim() || "Untitled",
            types: (types || []).map(t => t.trim()).filter(Boolean)
        }
        block.presets.push(preset)
        await UsedAircraftPresets.save({presets: block.presets})
        return preset
    }

    static async update(id, fields) {
        const block = await UsedAircraftPresets.load()
        const preset = block.presets.find(p => p.id === id)
        if (!preset) return null
        if (fields.name !== undefined) preset.name = fields.name.trim() || preset.name
        if (fields.types !== undefined) {
            preset.types = (fields.types || []).map(t => t.trim()).filter(Boolean)
        }
        await UsedAircraftPresets.save({presets: block.presets})
        return preset
    }

    static async remove(id) {
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
     * Clones the given preset's `name` (with " (copy)" appended) and `types`
     * into a fresh preset with a new id. Returns the new preset, or null when
     * the source id is unknown.
     */
    static async duplicate(id) {
        const block = await UsedAircraftPresets.load()
        const source = block.presets.find(p => p.id === id)
        if (!source) return null
        return UsedAircraftPresets.create(
            (source.name || "Untitled") + " (copy)",
            (source.types || []).slice()
        )
    }
}
