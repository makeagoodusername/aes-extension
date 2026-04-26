/**
 * Route Assistant — fixed-position side panel for the AS scheduling page.
 *
 * Replaces the older FlightsFromSchedulePanel with a richer, scored view that
 * blends:
 *   - flightsfrom.com cached routes for the hub
 *   - AS station demand (pax/cargo 0-10) per destination
 *   - the user's own existing frequency to each destination
 *   - airline-count from flightsfrom (competition proxy)
 *
 * Mount lifecycle:
 *   const panel = new RouteAssistantPanel({resolveOriginIata})
 *   panel.mount()    // attaches to document.body, calls render()
 *   panel.dispose()  // tears down
 */
class RouteAssistantPanel {
    constructor(opts) {
        this.resolveOriginIata = opts && opts.resolveOriginIata
        this.server = window.location.hostname.split(".")[0]
        this.root = null
        this.body = null
        this.statusBar = null
        this.controlsHost = null   // hosts the Mode + Aircraft dropdowns
        this.tableHost = null
        this.settingsHost = null
        this.collapsed = false

        this.settings = null      // RouteAssistantSettings.load() result
        this.hubIata = null
        this.ffData = null
        this.demandMap = new Map()
        this.ownSchedule = null
        this.rows = []
        this.scoredRows = []
        this.sortField = "score"
        this.sortDir = -1

        this.scanController = null
        this.scanner = null
        this.distanceResolver = null
        this.distanceProgress = null  // {total, done} while a fetch is running
        this.overrideMap = new Map()
        this.yieldHistoryMap = new Map()    // routeAssistant:yieldHistory:<HUB>-<DEST>
        this.serviceConfigMap = new Map()   // routeAssistant:serviceConfig:<HUB>-<DEST>
        this.serviceProfilesCache = new Map()  // Map<id, profileDetail> from RouteAssistantServiceProfileScraper
        this._serviceProfilesList = null    // {profiles, scrapedAt}
        this._serviceProfileSyncRunning = false
        this._snapshotRunning = false
        this._snapshotStatusEl = null
        this.fuelPrice = null         // RouteAssistantFuelPriceScraper cached record
        this._fuelScrapeInFlight = false
        this.fuelBurnOverrides = new Map()  // Map<typeId, {cycleL, perKmL}>

        // Phase 2 — fleet awareness
        this.fleet = null              // RouteAssistantFleetStore.loadFleet result, or null
        this.typeSpecs = new Map()     // Map<typeId, spec record>
        this.typeSpecsProgress = null  // {total, done} while specs fetch in flight
        this.selectedSpec = null       // resolved spec for Type/Tail mode
        this.fleetSpecs = null         // array of specs for Fleet mode
        this._storageListener = null
        this._storageDebounceTimer = null

        // Re-entry / lifecycle guards. The two enrichment loops can be
        // triggered both by user action (refresh) and by storage events,
        // so guard against running twice in parallel and against firing
        // a re-render after dispose.
        this._disposed = false
        this._enrichingDistances = false
        this._enrichingTypeSpecs = false

        // Debounce timer for live Economics input typing — coalesces a
        // multi-keystroke value (e.g. "0.123") into one save + recompute.
        this._economicsDebounceTimer = null
    }

    async mount() {
        if (this.root) return
        this.settings = await RouteAssistantSettings.load()
        this.collapsed = !!this.settings.collapsed

        this._buildSkeleton()
        document.body.append(this.root)
        this._attachStorageListener()
        await this.refresh()
        this._maybeAutoSnapshot()
    }

    /**
     * If the user opted into auto-snapshot, fire one snapshot pass once after
     * mount/refresh has populated rows + cached live-route data. Skipped
     * silently when the prerequisite caches are empty so a brand-new install
     * doesn't burn cycles for no benefit. Runs as fire-and-forget — the UI
     * keeps rendering while the snapshot completes; `_runYieldSnapshot` will
     * re-render when finished.
     */
    _maybeAutoSnapshot() {
        const cfg = this.settings && this.settings.yieldFeedback
        if (!cfg || !cfg.autoSnapshotOnMount) return
        if (this._snapshotRunning) return
        if (!this.hubIata || !this.rows || !this.rows.length) return
        const liveCount = this.rows.filter(r => r.liveAircraftType || r.liveDeparture).length
        if (!liveCount) return
        this._runYieldSnapshot()
    }

    dispose() {
        this._disposed = true
        if (this.scanner) this.scanner.abort()
        this._detachStorageListener()
        this._closeProfitPopover()
        this._closeServicePopover()
        this._closeCarrierPopover()
        if (this._overrideEditor && this._overrideEditor.parentNode) {
            this._overrideEditor.parentNode.removeChild(this._overrideEditor)
            this._overrideEditor = null
        }
        if (this._fuelBurnEditor && this._fuelBurnEditor.parentNode) {
            this._fuelBurnEditor.parentNode.removeChild(this._fuelBurnEditor)
            this._fuelBurnEditor = null
        }
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root)
        this.root = null
    }

    /**
     * React to fleet/type-spec writes from sibling tabs without forcing the
     * user to click refresh. Phase 2 introduced two background writers:
     *  - content_fleetManagement.js (writes <server><airline>aircraftFleet)
     *  - content_marketScan.js / our own _enrichTypeSpecsAsync (writes
     *    routeAssistant:typeSpec:<typeId>)
     * Either can populate the cache while the panel is mounted.
     */
    _attachStorageListener() {
        if (!chrome.storage || !chrome.storage.onChanged) return
        this._storageListener = (changes, areaName) => {
            if (areaName !== "local") return
            let interesting = false
            for (const key in changes) {
                if (key.endsWith("aircraftFleet")) interesting = true
                else if (key.startsWith(RouteAssistantTypeSpecsStore.PREFIX)) interesting = true
                if (interesting) break
            }
            if (!interesting) return
            // Debounce — a fleet rescan writes one big record, but the
            // sibling specs enrichment writes one key per type. Avoid
            // re-rendering N times.
            clearTimeout(this._storageDebounceTimer)
            this._storageDebounceTimer = setTimeout(() => this.refresh(), 500)
        }
        chrome.storage.onChanged.addListener(this._storageListener)
    }

    _detachStorageListener() {
        if (this._storageListener && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.removeListener(this._storageListener)
        }
        this._storageListener = null
        clearTimeout(this._storageDebounceTimer)
        this._storageDebounceTimer = null
        clearTimeout(this._economicsDebounceTimer)
        this._economicsDebounceTimer = null
    }

    /**
     * Cheap re-aggregation that re-applies fleet context to the existing
     * `this.rows` and re-renders the table. Used by Economics input
     * handlers and the falloff% selector — neither invalidates fleet,
     * schedule, distance, or spec caches, so calling the full `refresh()`
     * (with two `chrome.storage.local.get(null)` reads) per keystroke
     * would be wasteful.
     */
    _recomputeProfit() {
        if (!this.rows || !this.rows.length) return
        RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
        this._renderRows()
    }

    // ---------- Skeleton ----------

    _buildSkeleton() {
        this.root = document.createElement("div")
        this.root.id = "aes-route-assistant"
        Object.assign(this.root.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            // Width: comfortable default that fits the column groups
            // (real / aircraft / pricing / yield / carriers / market
            // analysis) without horizontal scroll. Caps at viewport
            // minus 32px so small displays don't push the panel off
            // the right edge.
            width: "1100px",
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "95vh",
            background: "#1f2937",
            color: "#f3f4f6",
            border: "1px solid #374151",
            borderRadius: "6px",
            boxShadow: "0 4px 20px rgba(0,0,0,.35)",
            zIndex: "9999",
            font: "13px/1.4 sans-serif",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
        })

        // Link styling — scoped to #aes-route-assistant so the hover rules
        // don't leak into AS's own UI. The icon row stays muted until the
        // user hovers a row, then pops to full opacity.
        const linkStyle = document.createElement("style")
        linkStyle.textContent = `
            #aes-route-assistant a.aes-iata { color: #f3f4f6; font-weight: bold; text-decoration: none; }
            #aes-route-assistant a.aes-iata:hover { color: #93c5fd; text-decoration: underline; }
            #aes-route-assistant .aes-iata-icons { font-size: 10px; margin-left: 4px; opacity: 0.5; white-space: nowrap; }
            #aes-route-assistant .aes-iata-icons a { color: #cbd5e1; text-decoration: none; margin-right: 3px; }
            #aes-route-assistant .aes-iata-icons a:hover { color: #93c5fd; }
            #aes-route-assistant tr:hover .aes-iata-icons { opacity: 1; }
            #aes-route-assistant a.aes-link { color: #93c5fd; text-decoration: none; }
            #aes-route-assistant a.aes-link:hover { color: #dbeafe; text-decoration: underline; }
            #aes-route-assistant a.aes-aircraft-link { color: inherit; text-decoration: none; }
            #aes-route-assistant a.aes-aircraft-link:hover { text-decoration: underline; filter: brightness(1.2); }
        `
        this.root.append(linkStyle)

        const header = document.createElement("div")
        Object.assign(header.style, {
            padding: "8px 12px",
            background: "#111827",
            borderBottom: "1px solid #374151",
            display: "flex",
            alignItems: "center",
            gap: "8px"
        })
        const title = document.createElement("strong")
        title.textContent = "Route Assistant"
        title.style.flex = "1"

        const refreshBtn = makeBtn("↻", "Refresh from cache", () => this.refresh())
        const settingsBtn = makeBtn("⚙", "Score weights & filters", () => this._toggleSettings())
        const toggleBtn = makeBtn("_", "Minimise", () => this._toggleCollapse())
        header.append(title, refreshBtn, settingsBtn, toggleBtn)

        this.statusBar = document.createElement("div")
        Object.assign(this.statusBar.style, {
            padding: "6px 12px",
            background: "#111827",
            borderBottom: "1px solid #374151",
            color: "#9ca3af",
            fontSize: "11px",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center"
        })

        // Aircraft picker row — Mode + Aircraft dropdowns. Hidden until at
        // least one fleet aircraft is loaded; the banner stack handles the
        // empty-fleet case.
        this.controlsHost = document.createElement("div")
        Object.assign(this.controlsHost.style, {
            padding: "6px 12px",
            background: "#0f1623",
            borderBottom: "1px solid #374151",
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: "11px"
        })

        this.settingsHost = document.createElement("div")
        Object.assign(this.settingsHost.style, {
            padding: "8px 12px",
            background: "#0f1623",
            borderBottom: "1px solid #374151",
            display: "none",
            // Cap at 50vh so the table below always gets meaningful
            // space — the drawer grew with the pricing / yield /
            // carriers / market-analysis expanders and was crowding
            // body to 0 height. Settings scroll internally; user
            // never loses the table.
            maxHeight: "50vh",
            overflowY: "auto",
            flexShrink: "0",
            fontSize: "11px"
        })

        this.body = document.createElement("div")
        Object.assign(this.body.style, {
            padding: "8px 12px",
            overflowY: "auto",
            flex: "1"
        })

        // Tabbed view selector lives ABOVE tableHost so the bar
        // survives `tableHost.innerHTML = ""` resets (every empty /
        // seed / draw call wipes tableHost — the tabs would flicker
        // if they lived inside it).
        this.tabBar = document.createElement("div")
        this.body.append(this.tabBar)

        this.tableHost = document.createElement("div")
        this.body.append(this.tableHost)

        this.root.append(header, this.statusBar, this.controlsHost, this.settingsHost, this.body)
        if (this.collapsed) {
            this.statusBar.style.display = "none"
            this.controlsHost.style.display = "none"
            this.body.style.display = "none"
        }
    }

    _toggleCollapse() {
        this.collapsed = !this.collapsed
        this.statusBar.style.display = this.collapsed ? "none" : "flex"
        this.controlsHost.style.display = this.collapsed
            ? "none"
            : (this.controlsHost.dataset.populated === "1" ? "flex" : "none")
        this.body.style.display = this.collapsed ? "none" : "block"
        this.settingsHost.style.display = this.collapsed ? "none"
            : (this.settingsHost.dataset.open === "1" ? "block" : "none")
        RouteAssistantSettings.save({collapsed: this.collapsed})
    }

    _toggleSettings() {
        const open = this.settingsHost.dataset.open !== "1"
        this.settingsHost.dataset.open = open ? "1" : "0"
        this.settingsHost.style.display = open ? "block" : "none"
        // When drawer is open, cap the body so the drawer wins the height
        // contest. Body keeps a small window so the user can still glance at
        // top-scoring routes while tweaking settings.
        this.body.style.maxHeight = open ? "25vh" : ""
        if (open) this._renderSettings()
    }

    // ---------- Data refresh ----------

    /**
     * Reload everything from cache (no AS / flightsfrom hits) and re-render.
     * Used on mount, after settings changes, and after a scan completes.
     */
    async refresh() {
        const iata = this.resolveOriginIata ? this.resolveOriginIata() : null
        if (!iata) {
            this.hubIata = null
            this._renderEmpty("Couldn't detect the origin airport on this page. Set the origin in the scheduler and click ↻.")
            return
        }
        this.hubIata = iata

        this.ffData = await FlightsFromStore.loadAirport(iata)
        this.ownSchedule = await this._loadOwnSchedule()
        this.fuelPrice = await RouteAssistantFuelPriceScraper.getCached()
        if (RouteAssistantFuelPriceScraper.isStale(this.fuelPrice)) this._scrapeFuelPriceAsync()

        // Pin fleet to the schedule's airline when available — multi-airline
        // accounts otherwise pick by largest fleet, which is usually right but
        // worth marking ambiguous.
        const airlineCode = this.ownSchedule && this.ownSchedule.airline || null
        this.fleet = await RouteAssistantFleetStore.loadFleet(this.server, airlineCode)
        await this._loadCachedTypeSpecs()
        const fleetTypeIds = RouteAssistantFleetStore.typeIdsIn(this.fleet)
        this.fuelBurnOverrides = await RouteAssistantFuelBurn.getOverrides(fleetTypeIds)
        this._resolveSelection()

        const dests = this.ffData && this.ffData.routes
            ? this.ffData.routes.map(r => String(r.destIata || "").toUpperCase()).filter(Boolean)
            : []
        this.demandMap = await RouteAssistantDemandStore.getMany(dests)
        this.overrideMap = await RouteAssistantRouteOverridesStore.getMany(
            dests.map(d => [iata, d])
        )
        this.yieldHistoryMap = await RouteAssistantYieldHistoryStore.getMany(
            dests.map(d => [iata, d])
        )
        this.serviceConfigMap = (typeof RouteAssistantServiceConfigStore !== "undefined")
            ? await RouteAssistantServiceConfigStore.getMany(dests.map(d => [iata, d]))
            : new Map()
        // Service-profile cache (auto-detected from /action/enterprise/*)
        if (typeof RouteAssistantServiceProfileScraper !== "undefined") {
            this.serviceProfilesCache = await RouteAssistantServiceProfileScraper.loadAllDetails()
            this._serviceProfilesList = await RouteAssistantServiceProfileScraper.loadList()
        }

        this.rows = RouteAssistantAggregator.buildRouteRows({
            hubIata:          iata,
            ffData:           this.ffData,
            demandMap:        this.demandMap,
            overrideMap:      this.overrideMap,
            yieldHistoryMap:  this.yieldHistoryMap,
            serviceConfigMap: this.serviceConfigMap,
            serviceProfiles:  (this.settings && this.settings.serviceProfiles) || null,
            fleet:            this.fleet,
            ownSchedule:      this.ownSchedule
        })

        // Paint instantly with any distances we already have cached, then
        // kick off lazy enrichment in the background for missing pairs.
        // Fleet context is applied AFTER distances so fit/profit see the
        // populated distance values rather than null.
        await this._applyCachedDistances()
        await this._applyCachedPrices()
        await this._applyCachedCarriers()
        await this._applyCachedMarkets()
        await this._applyCachedEnterpriseMeta()
        await this._applyCachedOrs()
        RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
        this._render()
        this._enrichDistancesAsync()
        this._enrichTypeSpecsAsync()
    }

    /**
     * Returns the service-projection context for `applyFleetContext` so the
     * aggregator can refresh class breakdowns whenever fleet/economics
     * change. Includes the per-route map and the global defaults.
     */
    _serviceContext() {
        return {
            serviceProfiles:  (this.settings && this.settings.serviceProfiles) || null,
            serviceConfigMap: this.serviceConfigMap || null,
            fleet:            this.fleet || null,
            hubIata:          this.hubIata || null
        }
    }

    /**
     * Returns the fleet context to feed into the aggregator, or null when no
     * aircraft is selected (Phase 1 view — fit/profit columns hidden).
     */
    _fleetContext() {
        const a = this.settings && this.settings.aircraft
        if (!a || !a.mode) return null
        const common = this._fuelContextFields()
        if (a.mode === "fleet") {
            if (!this.fleetSpecs || !this.fleetSpecs.length) return null
            return Object.assign({
                selectedSpec: null,
                fleetSpecs:   this.fleetSpecs,
                falloffPct:   a.falloffPct,
                economics:    this._economicsForEstimator()
            }, common)
        }
        if (!this.selectedSpec) return null
        return Object.assign({
            selectedSpec: this.selectedSpec,
            fleetSpecs:   null,
            falloffPct:   a.falloffPct,
            economics:    this._economicsForEstimator()
        }, common)
    }

    /**
     * The fuel-related fields the estimator needs in order to switch from
     * the legacy AS$/h × blockHours model to the AS-accurate (cycle_L +
     * per_km_L × dist) × priceASc / 100 model.
     *
     * Per-type fuel kicks in only when:
     *   - economics.fuelPriceAutoEnabled (toggle in Cache section)
     *   - we have a current scraped price in ASc$/l (the table format —
     *     the SVG fallback's chart-scale "index" can't drive cost).
     * Otherwise the estimator falls back to fuelCostPerHour × blockHours.
     */
    /**
     * Cruise-asymptotic fuel rate (AS$/h) for the currently picked aircraft.
     * Used to display a meaningful AS$/h in the Fuel field when per-type
     * fuel is on. Distance-dependent in reality (cycle dilutes on long
     * flights) — we report the cruise rate (per_km × speed × price) which
     * is the limiting value for long-haul and a reasonable single-number
     * summary.
     *
     * In Fleet mode (no single selectedSpec), returns the seat-weighted
     * average across the fleet. Returns null if nothing usable.
     */
    _computeCruiseFuelRate(fuelPriceASc) {
        const overrides = this.fuelBurnOverrides
        const rateForSpec = (spec) => {
            if (!spec) return null
            const burn = RouteAssistantFuelBurn.estimate(spec, overrides)
            const speed = Number(spec.speed) || 0
            if (!burn || !speed) return null
            return {rate: burn.perKmL * speed * fuelPriceASc / 100, perKmL: burn.perKmL, speed: speed}
        }
        if (this.selectedSpec) {
            const r = rateForSpec(this.selectedSpec)
            if (r) {
                r.label = this.selectedSpec.typeName || ("type " + this.selectedSpec.typeId)
                return r
            }
        }
        if (this.fleetSpecs && this.fleetSpecs.length) {
            // Seat-weighted average — bigger aircraft contribute more to the
            // "typical" cruise rate. Falls back to plain mean if no seats.
            let weightSum = 0, rateAcc = 0, perKmAcc = 0, speedAcc = 0, count = 0
            for (const s of this.fleetSpecs) {
                const r = rateForSpec(s)
                if (!r) continue
                const w = Math.max(1, Number(s.seats) || 1)
                weightSum += w
                rateAcc   += r.rate * w
                perKmAcc  += r.perKmL * w
                speedAcc  += r.speed * w
                count++
            }
            if (count > 0 && weightSum > 0) {
                return {
                    rate:   rateAcc   / weightSum,
                    perKmL: perKmAcc  / weightSum,
                    speed:  Math.round(speedAcc / weightSum),
                    label:  "fleet avg of " + count
                }
            }
        }
        return null
    }

    _fuelContextFields() {
        const econ = (this.settings && this.settings.economics) || {}
        const fp = this.fuelPrice
        const usable = econ.fuelPriceAutoEnabled
            && fp && fp.unit === "ASc$/l" && typeof fp.value === "number" && fp.value > 0
        return {
            useDistanceFuel:   !!usable,
            fuelPriceASc:      usable ? fp.value : null,
            fuelBurnOverrides: this.fuelBurnOverrides
        }
    }

    /**
     * Pass-through. Per-type fuel cost (cycle_L + per_km_L × dist) × ASc/l
     * lives in the estimator now and is gated by `useDistanceFuel`. The
     * legacy Phase-2 baseline-ratio scaling is no longer applied — see
     * `_fuelContextFields` for the gate. The flat `fuelCostPerHour` is used
     * only as a fallback when per-type fuel isn't available (spec missing).
     */
    _economicsForEstimator() {
        return (this.settings && this.settings.economics) || {}
    }

    /**
     * Bulk-load every cached type spec for typeIds present in the fleet, plus
     * the explicitly-selected typeId (if it's somehow not in the fleet — e.g.
     * the user sold the last one of a type). Populates this.typeSpecs.
     */
    async _loadCachedTypeSpecs() {
        const ids = new Set(RouteAssistantFleetStore.typeIdsIn(this.fleet))
        const a   = this.settings && this.settings.aircraft
        if (a && a.mode === "type" && a.typeId) ids.add(a.typeId)
        if (!ids.size) {
            this.typeSpecs = new Map()
            return
        }
        this.typeSpecs = await RouteAssistantTypeSpecsStore.getMany(Array.from(ids))
    }

    /**
     * Compute the chosen aircraft spec(s) for the current settings.aircraft
     * selection. Reads from this.typeSpecs (cache) — newly-fetched specs from
     * _enrichTypeSpecsAsync trigger a re-render which calls this again.
     */
    _resolveSelection() {
        this.selectedSpec = null
        this.fleetSpecs = null
        const a = this.settings && this.settings.aircraft
        if (!a || !a.mode || !this.fleet) return

        const lookup = (typeId, typeName, aircraftAge) => {
            const cached = this.typeSpecs.get(typeId)
            if (!cached) return null
            // aircraftAge: per-tail age in registration mode; avg-of-type
            // otherwise. Profit estimator scales fuel by age × penalty.
            return Object.assign({typeId: typeId, typeName: typeName || cached.typeName, aircraftAge: aircraftAge}, cached)
        }

        if (a.mode === "fleet") {
            const specs = []
            for (const slot of RouteAssistantFleetStore.activeTypeSlots(this.fleet)) {
                const s = lookup(slot.typeId, slot.typeName, slot.avgAge)
                if (s) specs.push(s)
            }
            this.fleetSpecs = specs
        } else if (a.mode === "type" && a.typeId) {
            const slot = RouteAssistantFleetStore.slotForTypeId(this.fleet, a.typeId)
            this.selectedSpec = lookup(a.typeId, slot ? slot.typeName : null, slot ? slot.avgAge : null)
        } else if (a.mode === "registration" && a.registration) {
            const ac = RouteAssistantFleetStore.findByRegistration(this.fleet, a.registration)
            if (ac && ac.typeId) {
                const tailAge = (typeof ac.age === "number" && isFinite(ac.age)) ? ac.age : null
                this.selectedSpec = lookup(ac.typeId, ac.equipment, tailAge)
            }
        }
    }

    /**
     * Bulk-load distance cache for every (hub, dest) pair in this.rows and
     * apply to row.distanceKm. Synchronous from the user's perspective —
     * one chrome.storage.local read for all pairs.
     */
    async _applyCachedDistances() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const pairs = this.rows.map(r => [this.hubIata, r.destIata])
        const maxAgeDays = this.settings && this.settings.distanceMaxAgeDays
        const cache = await RouteAssistantDistanceResolver.bulkLoadCache(pairs, {maxAgeDays: maxAgeDays})
        for (const r of this.rows) {
            if (r.distanceKm !== null && r.distanceKm !== undefined) continue
            const key = RouteAssistantDistanceResolver._pairKey(this.hubIata, r.destIata)
            const c = cache.get(key)
            if (c) r.distanceKm = c.distanceKm
        }
    }

    /**
     * Bulk-load the per-route cache and project both the live-data fields
     * (aircraft / departure / freq pattern / cruise speed) and the Tier 2
     * placeholders (ourPrice/ourYield/orsRank — currently always null) onto
     * each row.
     */
    async _applyCachedPrices() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cfg = (this.settings && this.settings.pricing) || {}
        const maxAgeDays = cfg.priceMaxAgeDays
        const cache = await RouteAssistantTicketPriceScraper.bulkLoadCache(pairs, {maxAgeDays: maxAgeDays})
        for (const r of this.rows) {
            const key = RouteAssistantTicketPriceScraper._pairKey(this.hubIata, r.destIata)
            const rec = cache.get(key)
            if (!rec) continue
            // Tier 2 placeholders — wired up so columns stay reactive once
            // the price/ORS scrapers land in a follow-up.
            r.ourPrice       = rec.ourPrice
            r.ourYield       = rec.ourYield
            r.orsRank        = rec.orsRank
            r.priceScrapedAt = rec.scrapedAt
            // Live route data scraped from /app/com/scheduling/<HUB><DEST>.
            r.liveAircraftType   = rec.primaryAircraftType
            r.liveAircraftTypeId = rec.primaryAircraftTypeId
            r.liveAircraftReg    = rec.primaryAircraftReg
            r.liveDeparture      = rec.departureTime
            r.liveDaysPerWeek    = rec.daysPerWeek
            r.liveCruiseSpeed    = rec.cruiseSpeedKmh
            r.liveScrapedAt      = rec.scrapedAt
            // Cross-reference primary registration against the cached fleet
            // so the Eq cell can deep-link to /app/fleets/aircraft/<id>/1
            // (the page that writes the aircraftFlights record consumed by
            // the yield-feedback snapshot). Falls back to null silently
            // when the fleet hasn't been refreshed since the tail was added.
            if (rec.primaryAircraftReg && this.fleet) {
                const fleetRec = RouteAssistantFleetStore.findByRegistration(
                    this.fleet, rec.primaryAircraftReg
                )
                r.liveAircraftId = fleetRec && fleetRec.aircraftId || null
            } else {
                r.liveAircraftId = null
            }

            // Per-day flight counts. Prefer the new shape; synthesize from
            // the legacy `frequencyPattern` (days-flown digits) for records
            // written before the parser learned about multi-daily. Lossy
            // when the legacy route was multi-daily — user can re-Sync to
            // get the precise per-day breakdown.
            if (Array.isArray(rec.dailyFlights) && rec.dailyFlights.length === 7) {
                r.liveDailyFlights  = rec.dailyFlights
                r.liveWeeklyFlights = (rec.weeklyFlights != null)
                    ? rec.weeklyFlights
                    : rec.dailyFlights.reduce((s, n) => s + n, 0)
            } else if (typeof rec.frequencyPattern === "string" && rec.frequencyPattern.length >= 7) {
                const synth = [0, 0, 0, 0, 0, 0, 0]
                for (let i = 0; i < 7; i++) {
                    const ch = rec.frequencyPattern.charAt(i)
                    if (ch >= "1" && ch <= "7") synth[i] = 1
                }
                r.liveDailyFlights  = synth
                r.liveWeeklyFlights = synth.reduce((s, n) => s + n, 0)
            } else if (rec.daysPerWeek > 0) {
                // Last-ditch: only the count survived. Show the count with a
                // null pattern so the cell renders something rather than "—".
                r.liveDailyFlights  = null
                r.liveWeeklyFlights = rec.daysPerWeek
            }
        }
    }

    /**
     * Letter F — load any cached per-route carrier records and decorate
     * rows with `carriers`, `carriersScrapedAt`, and the derived
     * `competitiveIntensity`. Mirrors `_applyCachedPrices`. Cells fall
     * back to the existing `airlineCount` integer when no record exists.
     */
    async _applyCachedCarriers() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const cfg = (this.settings && this.settings.carriers) || {}
        const maxAgeDays = cfg.carriersMaxAgeDays
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cache = await RouteAssistantCarriersScraper.bulkLoadCache(pairs, {maxAgeDays: maxAgeDays})
        for (const r of this.rows) {
            const key = RouteAssistantCarriersScraper._pairKey(this.hubIata, r.destIata)
            const rec = cache.get(key)
            if (!rec) continue
            r.carriers           = Array.isArray(rec.carriers) ? rec.carriers : []
            r.carriersScrapedAt  = rec.scrapedAt
            r.carriersParserNote = rec.parserNotes || null
            r.totalCarrierFlights = rec.totalWeeklyFlights || null
            // Intensity uses the cached `totalAirlines` when present (more
            // accurate, since the listing-page airlineCount can be stale)
            // and falls back to the row's existing flightsfrom count.
            const intensitySource = (typeof rec.totalAirlines === "number" && rec.totalAirlines > 0)
                ? rec.totalAirlines
                : r.airlineCount
            r.competitiveIntensity = RouteAssistantCarriersScraper.intensity(intensitySource)
        }
    }

    /**
     * F slice 2 — load any cached AS enterprise metadata (banner +
     * avatar URLs, name, IATA code) and decorate every market-share
     * entry on every row. Runs after `_applyCachedMarkets` so the
     * enterpriseIds are already on the rows.
     *
     * Decoration is in-place on `r.marketSharePax[i]` /
     * `marketShareCargo[i]` so the popover renderer doesn't need to
     * cross-reference a separate map at draw time. When metadata is
     * missing for an enterprise the entry stays untouched and the
     * popover falls back to plain-text rendering for that row.
     */
    async _applyCachedEnterpriseMeta() {
        if (!this.rows || !this.rows.length) return
        const cfg = (this.settings && this.settings.carriers) || {}
        const ids = new Set()
        for (const r of this.rows) {
            for (const list of [r.marketSharePax, r.marketShareCargo]) {
                if (!Array.isArray(list)) continue
                for (const e of list) {
                    if (e && e.enterpriseId != null) ids.add(String(e.enterpriseId))
                }
            }
        }
        if (!ids.size) return
        const cache = await RouteAssistantEnterpriseMetaScraper.bulkLoadCache(
            Array.from(ids), {maxAgeDays: cfg.enterpriseMetaMaxAgeDays}
        )
        if (!cache.size) return
        // Decorate every market-share entry that has a matching cache hit.
        for (const r of this.rows) {
            for (const list of [r.marketSharePax, r.marketShareCargo, r.competitorEntries]) {
                if (!Array.isArray(list)) continue
                for (const e of list) {
                    if (!e || e.enterpriseId == null) continue
                    const meta = cache.get(String(e.enterpriseId))
                    if (!meta) continue
                    e.bannerUrl = meta.bannerUrl || null
                    e.avatarUrl = meta.avatarUrl || null
                    e.iata      = meta.iata || null
                    if (!e.name && meta.name) e.name = meta.name
                }
            }
        }
    }

    /**
     * Background distance enrichment: for any row still missing distanceKm,
     * fire the three-tier resolver in parallel batches. Re-renders the
     * table after each batch so the km column fills in incrementally.
     * Idempotent — safe to call multiple times; resolved pairs short-circuit
     * via the resolver's session + persistent cache.
     */
    async _enrichDistancesAsync() {
        if (!this.hubIata || this._enrichingDistances || this._disposed) return
        const missing = (this.rows || []).filter(r =>
            r.destIata && (r.distanceKm === null || r.distanceKm === undefined)
        )
        if (!missing.length) {
            this.distanceProgress = null
            return
        }
        const maxAgeDays = this.settings && this.settings.distanceMaxAgeDays
        if (!this.distanceResolver) {
            this.distanceResolver = new RouteAssistantDistanceResolver(this.server, {maxAgeDays: maxAgeDays})
        } else {
            // Pick up any settings change made since the resolver was created;
            // the persistent cache filter must reflect the user's current choice.
            this.distanceResolver.maxAgeDays = RouteAssistantDistanceResolver._normaliseMaxAge(maxAgeDays)
        }

        this._enrichingDistances = true
        this.distanceProgress = {total: missing.length, done: 0}
        this._renderStatusBar()

        const concurrency = 4
        const staggerMs   = 800
        try {
            for (let i = 0; i < missing.length; i += concurrency) {
                if (this._disposed) return
                const batch = missing.slice(i, i + concurrency)
                await Promise.all(batch.map(async row => {
                    try {
                        const result = await this.distanceResolver.resolve(this.hubIata, row.destIata)
                        if (result && typeof result.distanceKm === "number") row.distanceKm = result.distanceKm
                    } catch (e) { /* graceful */ }
                    this.distanceProgress.done++
                }))
                if (this._disposed) return
                // Distances changed → fit/profit need to be recomputed.
                RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
                this._renderRows()  // table only — preserves any open picker dropdown
                if (i + concurrency < missing.length) await sleep(staggerMs)
            }
        } finally {
            this._enrichingDistances = false
            this.distanceProgress = null
            if (!this._disposed) this._renderStatusBar()
        }
    }

    /**
     * Background type-spec enrichment: any typeId present in the fleet but
     * missing from this.typeSpecs gets fetched via the shared
     * AESAircraftTypeSpecs.fetchById and persisted into the
     * RouteAssistantTypeSpecsStore. Mirrors _enrichDistancesAsync — same
     * 4 parallel × 800 ms stagger, re-render after each batch.
     *
     * Idempotent: a fleet aircraft whose typeId hasn't been backfilled yet
     * (older fleet record) is skipped. The "visit /app/fleets to refresh"
     * banner is what asks the user to backfill those.
     */
    async _enrichTypeSpecsAsync() {
        if (!this.fleet || this._enrichingTypeSpecs || this._disposed) return
        const need = []
        for (const id of RouteAssistantFleetStore.typeIdsIn(this.fleet)) {
            if (!this.typeSpecs.has(id)) need.push(id)
        }
        // Also enrich an explicitly-selected typeId in case the user sold all
        // of a type but kept the selection.
        const a = this.settings && this.settings.aircraft
        if (a && a.mode === "type" && a.typeId && !this.typeSpecs.has(a.typeId) && !need.includes(a.typeId)) {
            need.push(a.typeId)
        }
        if (!need.length) {
            this.typeSpecsProgress = null
            return
        }

        this._enrichingTypeSpecs = true
        this.typeSpecsProgress = {total: need.length, done: 0}
        this._renderStatusBar()

        const concurrency = 4
        const staggerMs   = 800
        try {
            for (let i = 0; i < need.length; i += concurrency) {
                if (this._disposed) return
                const batch = need.slice(i, i + concurrency)
                await Promise.all(batch.map(async typeId => {
                    try {
                        const specs = await AESAircraftTypeSpecs.fetchById(typeId)
                        if (specs) {
                            const typeName = this._typeNameFor(typeId)
                            const record = Object.assign({typeId: typeId, typeName: typeName}, specs)
                            const saved = await RouteAssistantTypeSpecsStore.save(record)
                            if (saved) this.typeSpecs.set(typeId, record)
                        }
                    } catch (e) { /* graceful */ }
                    this.typeSpecsProgress.done++
                }))
                if (this._disposed) return
                // A newly-fetched spec may flip the picked aircraft from
                // "no spec yet" to a real spec, so re-resolve and re-apply.
                this._resolveSelection()
                RouteAssistantAggregator.applyFleetContext(this.rows, this._fleetContext(), this._serviceContext())
                this._renderRows()
                if (i + concurrency < need.length) await sleep(staggerMs)
            }
        } finally {
            this._enrichingTypeSpecs = false
            this.typeSpecsProgress = null
            if (!this._disposed) this._renderStatusBar()
        }
    }

    /**
     * Background fuel-price scrape. Idempotent — flag prevents two scrapes
     * racing. On success, re-renders the settings drawer (if open) so the
     * "AS fuel index" line picks up the new value without a manual refresh.
     */
    async _scrapeFuelPriceAsync() {
        if (this._fuelScrapeInFlight || this._disposed) return
        this._fuelScrapeInFlight = true
        try {
            const scraper = new RouteAssistantFuelPriceScraper(this.server)
            const rec = await scraper.scrape()
            if (rec) this.fuelPrice = rec
        } catch (e) { /* graceful */ }
        finally {
            this._fuelScrapeInFlight = false
            if (!this._disposed && this.settingsHost && this.settingsHost.dataset.open === "1") {
                this._renderSettings()
            }
        }
    }

    /**
     * Best-effort type-name lookup for a typeId — first the fleet, then the
     * cache. Used as the saved record's `typeName` so the picker can render
     * a friendly label without re-fetching.
     */
    _typeNameFor(typeId) {
        const slot = RouteAssistantFleetStore.slotForTypeId(this.fleet, typeId)
        if (slot && slot.typeName) return slot.typeName
        const cached = this.typeSpecs.get(typeId)
        return (cached && cached.typeName) || null
    }

    /**
     * Storage-key probe: the schedule extractor (content_fligthSchedule.js)
     * writes to "<server><airlineCode>schedule". We don't know the airline
     * code from the scheduling page directly, so scan all keys with that
     * shape and pick whichever one's most recent latest-date entry contains
     * any flight from the current hub. That pins us to the right airline
     * even on a multi-airline account.
     */
    async _loadOwnSchedule() {
        const all = await chrome.storage.local.get(null)
        const candidates = []
        const prefix = this.server
        for (const key in all) {
            if (key.indexOf(prefix) !== 0) continue
            if (key.lastIndexOf("schedule") !== key.length - "schedule".length) continue
            const rec = all[key]
            if (!rec || rec.type !== "schedule" || !rec.date) continue
            candidates.push(rec)
        }
        if (!candidates.length) return null

        // Prefer one that has a flight from this hub in its latest date.
        const hub = this.hubIata
        for (const rec of candidates) {
            const dates = Object.keys(rec.date).sort()
            const latest = rec.date[dates[dates.length - 1]]
            if (latest && Array.isArray(latest.schedule)
                && latest.schedule.some(r => String(r.origin || "").toUpperCase() === hub)) {
                return rec
            }
        }
        // Fallback: just return the first one.
        return candidates[0]
    }

    // ---------- Status bar + actions ----------

    /**
     * Render the Pax / Cargo / All tab bar above the table. Persists
     * the chosen tab to settings on click + re-renders so column
     * visibility + score blend update in lockstep.
     *
     * The "All" tab keeps the existing combined score/columns. Pax
     * filters out cargoScore from the blend (and hides the Crg cell);
     * Cargo flips it. The underlying row data is the same on every tab
     * — only display + scoring change.
     */
    _renderTabBar() {
        if (!this.tabBar) return
        this.tabBar.innerHTML = ""
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;gap:0;margin:4px 0 8px 0;border-bottom:1px solid #374151;"
        const current = this._currentViewMode()
        const TABS = [
            {id: "all",   label: "All",   tip: "Combined score across pax + cargo signals (current default)"},
            {id: "pax",   label: "Pax",   tip: "Focus on passenger metrics — cargoScore drops from the blend, Crg cell hides"},
            {id: "cargo", label: "Cargo", tip: "Focus on cargo metrics — paxScore drops from the blend, Pax cell hides"}
        ]
        for (const t of TABS) {
            const btn = document.createElement("button")
            btn.textContent = t.label
            btn.title = t.tip
            const active = current === t.id
            Object.assign(btn.style, {
                background:    active ? "#1f2937" : "transparent",
                color:         active ? "#f3f4f6" : "#9ca3af",
                border:        "0",
                borderBottom:  active ? "2px solid #60a5fa" : "2px solid transparent",
                padding:       "6px 12px",
                cursor:        "pointer",
                fontSize:      "11px",
                fontWeight:    active ? "600" : "400",
                marginBottom:  "-1px"
            })
            btn.addEventListener("click", async () => {
                if (this._currentViewMode() === t.id) return
                this.settings.viewMode = t.id
                try {
                    await RouteAssistantSettings.save({viewMode: t.id})
                } catch (e) { /* persist failure is non-fatal — re-render anyway */ }
                this._renderRows()
                if (this.settingsHost && this.settingsHost.dataset.open === "1") {
                    this._renderSettings()
                }
            })
            wrap.append(btn)
        }
        this.tabBar.append(wrap)
    }

    _renderStatusBar() {
        this.statusBar.innerHTML = ""
        const hubText = document.createElement("span")
        hubText.innerHTML = `Hub <strong style="color:#f3f4f6;">${escapeHtml(this.hubIata || "—")}</strong>`
        this.statusBar.append(hubText)

        if (this.ffData) {
            const ageH = this.ffData.scrapedAt
                ? Math.round((Date.now() - this.ffData.scrapedAt) / 3600e3)
                : null
            const ageStr = ageH === null ? "" : ageH < 1 ? "just now" : ageH + "h ago"
            const stale = ageH !== null && ageH > (this.settings.flightsfromMaxAgeDays * 24)
            const ffSpan = document.createElement("span")
            ffSpan.textContent = `· FF: ${(this.ffData.routes || []).length} routes${ageStr ? ", " + ageStr : ""}`
            ffSpan.style.color = stale ? "#fbbf24" : "#9ca3af"
            this.statusBar.append(ffSpan)
        } else {
            const ffSpan = document.createElement("span")
            ffSpan.textContent = "· FF: not scanned"
            ffSpan.style.color = "#fbbf24"
            this.statusBar.append(ffSpan)
        }

        const unresolved = this.rows.filter(r => r.paxScore === null).length
        const demandSpan = document.createElement("span")
        demandSpan.textContent = `· Demand: ${this.rows.length - unresolved}/${this.rows.length} resolved`
        demandSpan.style.color = unresolved > 0 ? "#fbbf24" : "#9ca3af"
        this.statusBar.append(demandSpan)

        // Distance enrichment status — shown only while a fetch is in flight
        // or when some rows still have unknown distance.
        const totalRows = this.rows.length
        const knownDist = this.rows.filter(r => typeof r.distanceKm === "number").length
        const distSpan = document.createElement("span")
        if (this.distanceProgress) {
            distSpan.textContent = `· Distance: ${this.distanceProgress.done}/${this.distanceProgress.total} resolving…`
            distSpan.style.color = "#60a5fa"
        } else {
            distSpan.textContent = `· Distance: ${knownDist}/${totalRows}`
            distSpan.style.color = knownDist < totalRows ? "#fbbf24" : "#9ca3af"
        }
        this.statusBar.append(distSpan)

        // Type-spec enrichment — shows while specs are being fetched or when
        // any fleet typeId still lacks a cached spec. Suppressed when there's
        // no fleet at all (no specs to chase).
        if (this.fleet && this.fleet.aircraft && this.fleet.aircraft.length) {
            const fleetTypeIds = RouteAssistantFleetStore.typeIdsIn(this.fleet)
            const cachedTypeIds = fleetTypeIds.filter(id => this.typeSpecs.has(id))
            const specSpan = document.createElement("span")
            if (this.typeSpecsProgress) {
                specSpan.textContent = `· Specs: ${this.typeSpecsProgress.done}/${this.typeSpecsProgress.total} fetching…`
                specSpan.style.color = "#60a5fa"
            } else if (cachedTypeIds.length < fleetTypeIds.length) {
                specSpan.textContent = `· Specs: ${cachedTypeIds.length}/${fleetTypeIds.length}`
                specSpan.style.color = "#fbbf24"
            } else if (fleetTypeIds.length) {
                specSpan.textContent = `· Specs: ${fleetTypeIds.length}/${fleetTypeIds.length}`
                specSpan.style.color = "#9ca3af"
            }
            if (specSpan.textContent) this.statusBar.append(specSpan)
        }

        // Action buttons
        const actions = document.createElement("span")
        actions.style.cssText = "margin-left:auto;display:flex;gap:6px;"

        if (this.hubIata) {
            const scanBtn = document.createElement("button")
            scanBtn.textContent = this.ffData ? "Rescan flightsfrom" : "Scan flightsfrom"
            Object.assign(scanBtn.style, smallBtnStyle())
            scanBtn.addEventListener("click", () => this._scanFlightsFrom())
            actions.append(scanBtn)
        }

        if (unresolved > 0) {
            const demandBtn = document.createElement("button")
            demandBtn.textContent = `Resolve ${unresolved} demand`
            Object.assign(demandBtn.style, smallBtnStyle())
            demandBtn.addEventListener("click", () => this._resolveDemand())
            actions.append(demandBtn)
        }

        const seedBtn = document.createElement("button")
        seedBtn.textContent = "Seed all countries"
        seedBtn.title = "One-time bulk scrape of every AS country (5–15 min). Required after install."
        Object.assign(seedBtn.style, smallBtnStyle())
        seedBtn.style.background = "#7c3aed"
        seedBtn.addEventListener("click", () => this._seedAllCountries())
        actions.append(seedBtn)

        this.statusBar.append(actions)
    }

    async _seedAllCountries() {
        if (this.scanner) {
            this._noteToast("A scan is already running — wait for it to finish.")
            return
        }
        const ok = window.confirm(
            "Bulk-seed AS demand for every country in this game world?\n\n" +
            "This fetches ~150 country pages and takes 5–15 minutes. " +
            "After it finishes, every destination's demand resolves instantly. " +
            "You only need to do this once per game world."
        )
        if (!ok) return

        this.scanner = new RouteAssistantParallelScanner(this.server, {concurrency: 3, staggerMs: 1200})
        this.scanner.onProgress(state => {
            if (state.phase === "seeding") {
                const cur = state.currentCountryName ? ` (${state.currentCountryName})` : ""
                this._noteToast(
                    `Seeding ${state.fetched}/${state.total} countries${cur} · ` +
                    `${state.airportsSeeded} airports cached`
                )
            } else {
                this._noteToast(
                    `Seed complete. ${state.fetched}/${state.total} countries · ` +
                    `${state.airportsSeeded} airports cached · ` +
                    `${state.failedCountries.length} failed.`
                )
            }
        })
        try {
            await this.scanner.seedAllCountries()
        } finally {
            this.scanner = null
            await this.refresh()
        }
    }

    async _scanFlightsFrom() {
        if (!this.hubIata) return
        if (!this.scanController) {
            this.scanController = new FlightsFromController()
            this.scanController.onUpdate(scan => this._handleScanUpdate(scan))
        }
        try {
            await this.scanController.start(this.hubIata)
            this._noteToast(`Scanning flightsfrom.com for ${this.hubIata}…`)
        } catch (error) {
            this._noteToast(`Scan failed: ${error.message || error}`, true)
        }
    }

    _handleScanUpdate(scan) {
        if (!scan) return
        if (scan.status === "ok") {
            this._noteToast(`flightsfrom scrape complete for ${scan.iata}.`)
            this.refresh()
        } else if (scan.status === "error" || scan.status === "timeout") {
            this._noteToast(`flightsfrom scrape ${scan.status}: ${scan.error || "unknown"} — the scrape tab stayed open for debugging.`, true)
            this.refresh()
        }
    }

    async _resolveDemand() {
        const unresolved = this.rows.filter(r => r.paxScore === null).map(r => r.destIata)
        if (!unresolved.length) return
        if (this.scanner) {
            this._noteToast("Already resolving demand…")
            return
        }
        this.scanner = new RouteAssistantParallelScanner(this.server, {concurrency: 3, staggerMs: 1500})
        this.scanner.onProgress(state => {
            const phase = state.phase === "resolving" ? `Resolving ${state.resolved}/${state.total}…`
                        : state.phase === "fetching"  ? `Fetching demand (${state.fetched}/${state.total})…`
                        : `Done. ${state.fetched} resolved, ${state.failedIatas.length} unresolved.`
            this._noteToast(phase)
        })
        try {
            await this.scanner.run(unresolved)
        } finally {
            this.scanner = null
            await this.refresh()
        }
    }

    _noteToast(msg, isError) {
        // Single floating message line under the status bar; replaces previous.
        let toast = this.root.querySelector(".aes-ra-toast")
        if (!toast) {
            toast = document.createElement("div")
            toast.className = "aes-ra-toast"
            toast.style.cssText = "padding:4px 12px;font-size:11px;background:#0f1623;border-bottom:1px solid #374151;"
            this.statusBar.parentNode.insertBefore(toast, this.settingsHost)
        }
        toast.style.color = isError ? "#f87171" : "#60a5fa"
        toast.textContent = msg
    }

    // ---------- Aircraft picker ----------

    /**
     * Renders the Mode + Aircraft dropdowns inside this.controlsHost. Called
     * on every _render so the option list stays in sync with the live fleet
     * (e.g. after a fleet rescan in another tab).
     */
    _renderControls() {
        if (!this.controlsHost) return
        this.controlsHost.innerHTML = ""
        this.controlsHost.dataset.populated = "0"

        if (this.collapsed) {
            this.controlsHost.style.display = "none"
            return
        }

        const fleetEmpty = !this.fleet || !this.fleet.aircraft || !this.fleet.aircraft.length
        const a = this.settings.aircraft || {}
        const currentMode = a.mode || ""

        // Mode select
        const modeWrap = document.createElement("label")
        modeWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        modeWrap.append(document.createTextNode("Aircraft mode"))
        const modeSel = mkSelect([
            {value: "",             label: "None"},
            {value: "fleet",        label: "Fleet (any owned)"},
            {value: "type",         label: "By type"},
            {value: "registration", label: "By tail"}
        ], currentMode)
        modeSel.disabled = fleetEmpty
        modeWrap.append(modeSel)
        this.controlsHost.append(modeWrap)

        // Aircraft select — populated based on mode
        const acWrap = document.createElement("label")
        acWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        acWrap.append(document.createTextNode("Aircraft"))
        const acSel = document.createElement("select")
        acSel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;max-width:260px;"

        const noneOpt = document.createElement("option")
        noneOpt.value = ""
        noneOpt.textContent = fleetEmpty ? "(no fleet — visit /app/fleets)" : "(none)"
        acSel.append(noneOpt)

        if (currentMode === "fleet" && !fleetEmpty) {
            const sum = this._fleetSummaryLabel()
            const opt = document.createElement("option")
            opt.value = "fleet"
            opt.textContent = sum
            opt.selected = true
            acSel.append(opt)
        } else if (currentMode === "type" && !fleetEmpty) {
            const slots = RouteAssistantFleetStore.activeTypeSlots(this.fleet)
                .sort((x, y) => y.count - x.count)
            for (const s of slots) {
                const opt = document.createElement("option")
                opt.value = String(s.typeId)
                const cached = this.typeSpecs.get(s.typeId)
                const rangeStr = cached && cached.range ? ` · ${cached.range.toLocaleString()} km` : ""
                opt.textContent = `${s.typeName} (×${s.count})${rangeStr}`
                if (a.typeId && Number(a.typeId) === Number(s.typeId)) opt.selected = true
                acSel.append(opt)
            }
        } else if (currentMode === "registration" && !fleetEmpty) {
            const tails = (this.fleet.aircraft || []).slice()
                .filter(x => x && x.registration)
                .sort((x, y) => String(x.registration).localeCompare(String(y.registration)))
            for (const ac of tails) {
                const opt = document.createElement("option")
                opt.value = String(ac.registration)
                opt.textContent = `${ac.registration} — ${ac.equipment || "(unknown)"}`
                if (a.registration === ac.registration) opt.selected = true
                acSel.append(opt)
            }
        }

        acSel.disabled = (currentMode === "" || fleetEmpty)
        acWrap.append(acSel)
        this.controlsHost.append(acWrap)

        // Falloff% live tweak — only meaningful when an aircraft is selected.
        if (currentMode && !fleetEmpty) {
            const falloffWrap = document.createElement("label")
            falloffWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            falloffWrap.append(document.createTextNode("Fall-off %"))
            const falloffSel = mkSelect(
                [5, 7, 10, 12, 15, 20, 25].map(v => ({value: String(v), label: String(v)})),
                String(a.falloffPct || 10)
            )
            falloffSel.addEventListener("change", async () => {
                this.settings.aircraft.falloffPct = Number(falloffSel.value) || 10
                await RouteAssistantSettings.save({aircraft: this.settings.aircraft})
                this._recomputeProfit()
            })
            falloffWrap.append(falloffSel)
            this.controlsHost.append(falloffWrap)

            const flyableWrap = document.createElement("label")
            flyableWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            const cb = mkInput("checkbox", null)
            cb.checked = !!(this.settings.filters && this.settings.filters.fleetFlyableOnly)
            cb.addEventListener("change", async () => {
                this.settings.filters.fleetFlyableOnly = cb.checked
                await RouteAssistantSettings.save({filters: this.settings.filters})
                this._render()
            })
            flyableWrap.append(cb, document.createTextNode("Fleet-flyable only"))
            this.controlsHost.append(flyableWrap)
        }

        // Wire up the cascading change handlers — Mode change wipes selection,
        // Aircraft change saves the chosen typeId/registration.
        modeSel.addEventListener("change", async () => {
            const next = modeSel.value || null
            this.settings.aircraft.mode         = next
            this.settings.aircraft.typeId       = null
            this.settings.aircraft.registration = null
            await RouteAssistantSettings.save({aircraft: this.settings.aircraft})
            await this.refresh()
        })
        acSel.addEventListener("change", async () => {
            const v = acSel.value
            if (currentMode === "type") {
                this.settings.aircraft.typeId = v ? Number(v) : null
            } else if (currentMode === "registration") {
                this.settings.aircraft.registration = v || null
            } else if (currentMode === "fleet") {
                // value is "fleet" or "" (none) — mode covers it; no extra state.
                if (!v) this.settings.aircraft.mode = null
            }
            await RouteAssistantSettings.save({aircraft: this.settings.aircraft})
            await this.refresh()
        })

        this.controlsHost.style.display = "flex"
        this.controlsHost.dataset.populated = "1"
    }

    _fleetSummaryLabel() {
        if (!this.fleet) return "Any owned"
        const totalAc    = (this.fleet.aircraft || []).length
        const totalTypes = RouteAssistantFleetStore.activeTypeSlots(this.fleet).length
        return `Any owned (${totalAc} aircraft, ${totalTypes} type${totalTypes === 1 ? "" : "s"})`
    }

    // ---------- Table + filters ----------

    _render() {
        this._syncVarianceWarn()
        this._syncRenderContext()
        this._renderControls()
        this._renderRows()
    }

    /**
     * The Δ% column's render closure reads this static so the threshold
     * stays in sync with the user's `yieldFeedback.varianceWarnPct` setting
     * without having to thread the panel instance into static config.
     */
    _syncVarianceWarn() {
        const yf = this.settings && this.settings.yieldFeedback
        const v = yf && Number(yf.varianceWarnPct)
        RouteAssistantPanel._varianceWarnPct = (isFinite(v) && v > 0) ? v : 25
    }

    /**
     * Cell-render closures need the current hub IATA + server name to build
     * the AS URLs. Stash them in static fields right before render so the
     * closures don't need to capture the panel instance.
     */
    _syncRenderContext() {
        RouteAssistantPanel._currentHubIata = this.hubIata || ""
        RouteAssistantPanel._currentServer  = this.server  || ""
        RouteAssistantPanel._currentInstance = this
        RouteAssistantPanel._serviceProfilesCacheStatic = this.serviceProfilesCache || null
        const carriers = this.settings && this.settings.carriers
        RouteAssistantPanel._showCarrierIntensity = !carriers || carriers.showCarrierIntensity !== false
        const ors = this.settings && this.settings.ors
        RouteAssistantPanel._orsPrimaryColumn = (ors && ors.primaryColumn) || "ratingGapToTop"
    }

    /**
     * Body re-render only — skips _renderControls so a user-opened picker
     * dropdown isn't wiped while distance / type-spec batches stream in.
     * Called from both enrichment loops between batches.
     */
    _renderRows() {
        this._renderStatusBar()
        this._renderTabBar()
        if (!this.hubIata) return
        if (!this.ffData) {
            this._renderEmpty(`No flightsfrom.com data cached for ${this.hubIata}. Click "Scan flightsfrom" above.`)
            return
        }
        if (!this.rows.length) {
            this._renderEmpty(`flightsfrom.com cached, but no routes recorded for ${this.hubIata}.`)
            return
        }

        // Empty-cache banner — most common first-run state.
        const resolved = this.rows.filter(r => r.paxScore !== null).length
        if (resolved === 0) {
            this._renderSeedPrompt()
            return
        }

        const filtered = this._applyFilters(this.rows)
        // Filter SCORING_FIELDS by the active view mode so the score
        // blend reflects only signals relevant to the current tab.
        // Pax tab drops cargoScore; Cargo tab drops paxScore; All
        // keeps everything (preserves pre-tabbed behaviour).
        const mode = this._currentViewMode()
        const activeFields = RouteAssistantPanel.SCORING_FIELDS.filter(f =>
            !Array.isArray(f.modes) || f.modes.indexOf(mode) >= 0
        )
        this.scoredRows = RouteAssistantScore.computeScores(filtered, this.settings.scoring,
            activeFields)

        if (!this.scoredRows.length) {
            this._renderEmpty("No routes match the current filters.")
            return
        }

        const sorted = this._sortRows(this.scoredRows)
        this._drawTable(sorted)
    }

    _applyFilters(rows) {
        const f = this.settings.filters || {}
        const minScore = numOrNull(f.minScore)
        const maxDist  = numOrNull(f.maxDistanceKm)
        const statuses = f.statuses || {}
        const fleetFlyable = !!f.fleetFlyableOnly && this._fleetContext() !== null
        return rows.filter(r => {
            if (statuses[r.status] === false) return false
            if (maxDist !== null && r.distanceKm !== null && r.distanceKm > maxDist) return false
            // Fleet-flyable filter: only meaningful when an aircraft is picked.
            // OOR rows (or rows where the spec couldn't be evaluated) are dropped.
            if (fleetFlyable && (r.aircraftFit === "oor" || r.aircraftFit === null)) return false
            // minScore is checked AFTER scoring, since score depends on the
            // visible set. We do it in _drawTable by post-filtering.
            return true
        })
    }

    _sortRows(rows) {
        const dir = this.sortDir
        const field = this.sortField
        return rows.slice().sort((a, b) => {
            const va = a[field], vb = b[field]
            if (va === vb) return 0
            if (va === null || va === undefined || va === "") return 1
            if (vb === null || vb === undefined || vb === "") return -1
            if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir
            return String(va).localeCompare(String(vb)) * dir
        })
    }

    _drawTable(sorted) {
        this.tableHost.innerHTML = ""

        const minScore = numOrNull(this.settings.filters && this.settings.filters.minScore)
        const visible = minScore === null
            ? sorted
            : sorted.filter(r => r.score === null || r.score >= minScore)
        if (!visible.length) {
            this._renderEmpty(`No routes pass the min-score filter (≥ ${minScore}).`)
            return
        }

        const fleetBanner = this._renderFleetBanner()
        if (fleetBanner) this.tableHost.append(fleetBanner)
        this.tableHost.append(this._buildLegend())
        this.tableHost.append(this._buildTable(visible))

        // Publish a slim top-routes snapshot for cross-feature consumers
        // (currently the Used Aircraft Scanner's route-fit metric). Capped
        // at 50 to keep storage write small; the scanner doesn't need more.
        this._publishTopRoutes(visible)
    }

    /**
     * Persist the visible scored rows to `routeAssistant:topRoutes` so
     * other features (Used Aircraft Scanner) can score offers against
     * the user's current hub priorities without re-running the whole
     * RA pipeline. Single global key — overwritten on every render.
     * Only the fields downstream features need are kept, to bound the
     * write size.
     */
    _publishTopRoutes(visible) {
        if (!this.hubIata) return
        const fin = v => typeof v === "number" && isFinite(v)
        const slim = (visible || []).slice(0, 50).map(r => ({
            destIata:    r.destIata,
            destName:    r.destName,
            distanceKm:  fin(r.distanceKm) ? r.distanceKm : null,
            score:       fin(r.score)      ? r.score      : null,
            status:      r.status || null,
            paxScore:    fin(r.paxScore)   ? r.paxScore   : null,
            cargoScore:  fin(r.cargoScore) ? r.cargoScore : null
        }))
        const blob = {
            hub:       this.hubIata,
            server:    this.server,
            scrapedAt: Date.now(),
            count:     slim.length,
            rows:      slim
        }
        // Fire-and-forget; failures here mustn't break the panel render.
        try {
            chrome.storage.local.set({"routeAssistant:topRoutes": blob})
        } catch (e) {
            console.warn("[AES routeAssistant] topRoutes write failed:", e)
        }
    }

    /**
     * Top-of-table banner driven by the current fleet state. Returns null
     * when nothing notable to surface. Banner priority (only the highest one
     * renders):
     *   1. No fleet found at all
     *   2. Fleet has aircraft but some/all lack typeId (older fleet records)
     *
     * The "demand cache empty" state is handled separately by
     * `_renderSeedPrompt` because it replaces the whole view.
     */
    _renderFleetBanner() {
        if (!this.fleet) return null
        if (!this.fleet.aircraft || !this.fleet.aircraft.length) {
            return makeBanner({
                level: "amber",
                title: "No fleet data found.",
                body: "Visit /app/fleets in this game world to record your aircraft. Once it's saved, this panel can score routes by range and rough profit."
            })
        }
        if (RouteAssistantFleetStore.hasMissingTypeIds(this.fleet)) {
            const missing = this.fleet.aircraft.filter(a => a && !a.typeId).length
            return makeBanner({
                level: "amber",
                title: `${missing} aircraft missing type id.`,
                body: "Open Fleet Management once to refresh aircraft data — older saves don't carry the type id needed for spec lookup."
            })
        }
        if (this.fleet.ambiguous) {
            return makeBanner({
                level: "amber",
                title: "Multiple airlines on this server.",
                body: "Picked the airline with the largest fleet. Run Extract Schedule on the airline you want to score, and the panel will pin to it next refresh."
            })
        }
        return null
    }

    /**
     * Compact status legend pill row above the table — explains what NEW /
     * OK / UNDER / OVER / OOR mean without forcing the user to hover every cell.
     * OOR is only shown when an aircraft is selected (otherwise no row will
     * carry that status).
     */
    _buildLegend() {
        const legend = document.createElement("div")
        legend.style.cssText = "display:flex;gap:10px;font-size:10px;margin:4px 0 8px 0;flex-wrap:wrap;align-items:center;"
        const intro = document.createElement("span")
        intro.textContent = "Status legend:"
        intro.style.color = "#6b7280"
        legend.append(intro)
        const shortDesc = {NEW: "you don't fly", OK: "healthy", UNDER: "scale up", OVER: "trim", OOR: "out of range"}
        const keys = ["NEW", "OK", "UNDER", "OVER"]
        if (this._fleetContext() !== null) keys.push("OOR")
        for (const k of keys) {
            const def = RouteAssistantPanel.STATUS_DEF[k]
            const wrap = document.createElement("span")
            wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;"
            wrap.title = def.description
            const tag = document.createElement("strong")
            tag.textContent = k
            tag.style.color = def.color
            const desc = document.createElement("span")
            desc.textContent = shortDesc[k] || ""
            desc.style.color = "#9ca3af"
            wrap.append(tag, desc)
            legend.append(wrap)
        }
        return legend
    }

    /**
     * Builds the route table including the group-label sub-header (AS
     * in-game / Real-world / Aircraft). Cells in each group share a subtle
     * background tint so the source of every number is obvious at a glance.
     *
     * The "aircraft" group columns are hidden when no aircraft is picked, so
     * the Phase 1 view stays compact.
     */
    _buildTable(rows) {
        const cols = this._activeColumns()

        const table = document.createElement("table")
        table.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"

        const thead = document.createElement("thead")

        // Group sub-header — collapses adjacent columns sharing a group key
        // into one <th colspan>. This relies on COLUMNS being ordered such
        // that columns of the same group are contiguous.
        const groupRow = document.createElement("tr")
        let groupTh = null
        let groupSpan = 0
        let prevGroup = null
        for (const col of cols) {
            if (col.group !== prevGroup) {
                if (groupTh) groupTh.colSpan = groupSpan
                const def = RouteAssistantPanel.COLUMN_GROUPS[col.group] || {}
                groupTh = document.createElement("th")
                groupTh.textContent = def.label || ""
                groupTh.style.cssText = "padding:2px 6px;font-size:10px;font-weight:600;color:#9ca3af;"
                    + "text-align:center;border-bottom:1px solid #374151;"
                    + (def.headerTint ? `background:${def.headerTint};` : "")
                groupRow.append(groupTh)
                prevGroup = col.group
                groupSpan = 0
            }
            groupSpan++
        }
        if (groupTh) groupTh.colSpan = groupSpan
        thead.append(groupRow)

        // Column header — clickable for sort.
        const tr = document.createElement("tr")
        for (const col of cols) {
            const th = document.createElement("th")
            th.textContent = col.label + (this.sortField === col.field
                ? (this.sortDir === 1 ? " ▲" : " ▼") : "")
            const tint = (RouteAssistantPanel.COLUMN_GROUPS[col.group] || {}).tint
            th.style.cssText = "padding:4px 6px;border-bottom:1px solid #374151;cursor:pointer;"
                + "text-align:" + (col.align || "left") + ";white-space:nowrap;"
                + (tint ? `background:${tint};` : "")
            th.title = col.title || col.label
            th.addEventListener("click", () => {
                if (this.sortField === col.field) this.sortDir = -this.sortDir
                else { this.sortField = col.field; this.sortDir = col.defaultDir || -1 }
                this._render()
            })
            tr.append(th)
        }
        thead.append(tr)
        table.append(thead)

        const tbody = document.createElement("tbody")
        for (const row of rows) {
            const trow = document.createElement("tr")
            trow.style.cursor = "context-menu"
            trow.title = (trow.title || "") + (trow.title ? "\n" : "")
                + "Right-click to override LF / yield for this route."
            trow.addEventListener("contextmenu", (e) => {
                e.preventDefault()
                this._openOverrideEditor(row)
            })
            trow.addEventListener("click", (e) => {
                if (!e.target || !e.target.closest) return
                const profitTrig = e.target.closest("[data-profit-trigger='1']")
                if (profitTrig) {
                    e.preventDefault()
                    e.stopPropagation()
                    this._openProfitModifierPopover(row, profitTrig)
                    return
                }
                const svcTrig = e.target.closest("[data-service-trigger='1']")
                if (svcTrig) {
                    e.preventDefault()
                    e.stopPropagation()
                    this._openServiceConfigPopover(row, svcTrig)
                }
            })
            for (const col of cols) {
                const td = document.createElement("td")
                const tint = (RouteAssistantPanel.COLUMN_GROUPS[col.group] || {}).tint
                td.style.cssText = "padding:3px 6px;border-bottom:1px solid #2a3444;"
                    + "text-align:" + (col.align || "left") + ";"
                    + (tint ? `background:${tint};` : "")
                col.render(td, row)
                trow.append(td)
            }
            tbody.append(trow)
        }
        table.append(tbody)
        return table
    }

    /**
     * Returns the columns visible right now. Aircraft-group columns are only
     * shown when an aircraft is selected; pricing- and actuals-group columns
     * are each gated by their own settings toggle.
     */
    _activeColumns() {
        const showAircraft = this._fleetContext() !== null
        const showPricing  = !this.settings || !this.settings.pricing
            ? true
            : this.settings.pricing.showPricingColumns !== false
        const showActuals  = !this.settings || !this.settings.yieldFeedback
            ? true
            : this.settings.yieldFeedback.showColumns !== false
        const showMarkets  = !this.settings || !this.settings.marketAnalysis
            ? true
            : this.settings.marketAnalysis.showColumns !== false
        const showOrs      = !this.settings || !this.settings.ors
            ? true
            : this.settings.ors.showColumns !== false
        const showService  = !this.settings || !this.settings.serviceProfiles
            ? true
            : this.settings.serviceProfiles.showServiceColumns !== false
        const viewMode = this._currentViewMode()
        return RouteAssistantPanel.COLUMNS.filter(c => {
            if (c.group === "aircraft"    && !showAircraft) return false
            if (c.group === "pricing"     && !showPricing)  return false
            if (c.group === "actuals"     && !showActuals)  return false
            if (c.group === "service"     && !showService)  return false
            if (c.group === "competition" && !showMarkets)  return false
            if (c.group === "markets"     && !showMarkets)  return false
            if (c.group === "ors"         && !showOrs)      return false
            // Tabbed view filter — derive `modes` via _columnModes so
            // we don't have to tag every entry in the large COLUMNS
            // array. Only paxScore / cargoScore are mode-specific
            // today; everything else shows in all three tabs.
            const modes = RouteAssistantPanel._columnModes(c)
            if (modes.indexOf(viewMode) < 0) return false
            return true
        })
    }

    /** Resolve the active view tab safely; defaults to "all". */
    _currentViewMode() {
        const v = this.settings && this.settings.viewMode
        if (v === "pax" || v === "cargo" || v === "all") return v
        return "all"
    }

    _renderEmpty(msg) {
        this.tableHost.innerHTML = ""
        const p = document.createElement("p")
        p.style.cssText = "color:#9ca3af;margin:6px 0;"
        p.textContent = msg
        this.tableHost.append(p)
    }

    _renderSeedPrompt() {
        this.tableHost.innerHTML = ""
        const box = document.createElement("div")
        box.style.cssText = "background:#1e1b4b;border:1px solid #4c1d95;border-radius:4px;padding:10px 12px;margin:6px 0;"
        const h = document.createElement("strong")
        h.textContent = "Demand cache is empty for this game world."
        h.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;"
        const p = document.createElement("p")
        p.style.cssText = "margin:0 0 8px 0;color:#d8d4f5;font-size:12px;"
        p.textContent = "AirlineSim doesn't expose per-IATA airport lookup, so the assistant needs a one-time bulk seed of every country before it can score routes. This takes 5–15 minutes; after it's done you're set permanently."
        const btn = document.createElement("button")
        btn.textContent = "Seed all countries now"
        Object.assign(btn.style, smallBtnStyle())
        btn.style.background = "#7c3aed"
        btn.addEventListener("click", () => this._seedAllCountries())
        box.append(h, p, btn)
        this.tableHost.append(box)

        // Surface the fleet banner too so the user sees both first-run gates
        // at once and can knock them out in any order.
        const fleetBanner = this._renderFleetBanner()
        if (fleetBanner) this.tableHost.append(fleetBanner)

        // Still render the table below the banner so the user can see the
        // flightsfrom data we already have. Reuses _buildTable so column
        // groups and tints look identical to the post-seed view.
        const sep = document.createElement("div")
        sep.style.cssText = "margin:10px 0 4px 0;font-size:11px;color:#9ca3af;"
        sep.textContent = "Routes (no demand scored until seeded):"
        this.tableHost.append(sep)
        this.scoredRows = this.rows.map(r => Object.assign({score: null}, r))
        const sorted = this._sortRows(this.scoredRows)
        this.tableHost.append(this._buildTable(sorted))
    }

    // ---------- Settings UI ----------

    _renderSettings() {
        this.settingsHost.innerHTML = ""

        // ----- Header
        const scoringHeader = document.createElement("div")
        scoringHeader.innerHTML = "<strong>Score weights & filters</strong>"
        scoringHeader.style.cssText = "margin-bottom:6px;"
        this.settingsHost.append(scoringHeader)

        // ----- Quick presets row
        const presetRow = document.createElement("div")
        presetRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;"
        const presetLabel = document.createElement("span")
        presetLabel.textContent = "Quick presets:"
        presetLabel.style.cssText = "color:#9ca3af;font-size:11px;"
        presetRow.append(presetLabel)
        for (const preset of RouteAssistantPanel.WEIGHT_PRESETS) {
            const btn = document.createElement("button")
            btn.textContent = preset.name
            btn.title = preset.description
            Object.assign(btn.style, smallBtnStyle())
            btn.style.background = "#475569"
            btn.style.fontSize = "10px"
            btn.style.padding = "2px 7px"
            btn.addEventListener("click", () => this._applyWeightPreset(preset))
            presetRow.append(btn)
        }
        this.settingsHost.append(presetRow)

        // ----- Scoring table
        const scoringTable = document.createElement("table")
        scoringTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:8px;"
        scoringTable.innerHTML = `<thead><tr>
            <th style="text-align:center;padding:2px 4px;width:36px;">On</th>
            <th style="text-align:left;padding:2px 4px;">Variable</th>
            <th style="text-align:left;padding:2px 4px;">Direction</th>
            <th style="text-align:right;padding:2px 4px;width:60px;">Weight</th>
            <th style="text-align:right;padding:2px 4px;width:90px;">Min</th>
            <th style="text-align:right;padding:2px 4px;width:90px;">Max</th>
        </tr></thead>`
        const tbody = document.createElement("tbody")
        scoringTable.append(tbody)

        const settingsMode = this._currentViewMode()
        for (const f of RouteAssistantPanel.SCORING_FIELDS) {
            // Hide scoring rows that don't apply to the active tab so
            // the user doesn't toggle a field that's silently ignored
            // by the current view's score blend.
            if (Array.isArray(f.modes) && f.modes.indexOf(settingsMode) < 0) continue
            const cfg = this.settings.scoring[f.field] = Object.assign(
                {enabled: false, weight: 1, direction: f.direction, min: null, max: null},
                this.settings.scoring[f.field] || {}
            )
            const tr = document.createElement("tr")
            const groupTint = (RouteAssistantPanel.COLUMN_GROUPS[f.group] || {}).tint
            if (groupTint) tr.style.background = groupTint

            const cb = mkInput("checkbox", null)
            cb.checked = !!cfg.enabled

            const dirSel = mkSelect([
                {value: "higher", label: "higher = better"},
                {value: "lower",  label: "lower = better"}
            ], cfg.direction || f.direction)

            const w = mkInput("number", cfg.weight)
            w.min = "0"; w.step = "0.5"; w.style.width = "55px"

            const mn = mkSuggestSelect(cfg.min, f.suggestedValues)
            const mx = mkSuggestSelect(cfg.max, f.suggestedValues)

            const td1 = document.createElement("td")
            td1.style.cssText = "padding:2px 4px;text-align:center;"
            td1.append(cb); tr.append(td1)

            const td2 = document.createElement("td")
            td2.style.cssText = "padding:2px 4px;"
            td2.textContent = f.label
            tr.append(td2)

            const td3 = document.createElement("td")
            td3.style.cssText = "padding:2px 4px;"
            td3.append(dirSel); tr.append(td3)

            const td4 = document.createElement("td")
            td4.style.cssText = "padding:2px 4px;text-align:right;"
            td4.append(w); tr.append(td4)

            const td5 = document.createElement("td")
            td5.style.cssText = "padding:2px 4px;text-align:right;"
            td5.append(mn); tr.append(td5)

            const td6 = document.createElement("td")
            td6.style.cssText = "padding:2px 4px;text-align:right;"
            td6.append(mx); tr.append(td6)

            tbody.append(tr)

            const sync = async () => {
                const wNum = w.value === "" ? 1 : Number(w.value)
                this.settings.scoring[f.field] = {
                    enabled:   cb.checked,
                    weight:    isFinite(wNum) && wNum >= 0 ? wNum : 1,
                    direction: dirSel.value,
                    min:       numOrNull(mn.value),
                    max:       numOrNull(mx.value)
                }
                await RouteAssistantSettings.save({scoring: this.settings.scoring})
                this._render()
            }
            cb.addEventListener("change", sync)
            dirSel.addEventListener("change", sync)
            w.addEventListener("input", sync)
            mn.addEventListener("change", sync)
            mx.addEventListener("change", sync)
        }
        this.settingsHost.append(scoringTable)

        // ----- Filters: min score, max distance, status checkboxes
        const filtRow = document.createElement("div")
        filtRow.style.cssText = "display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const minScoreSel = mkSuggestSelect(
            (this.settings.filters || {}).minScore,
            [50, 60, 70, 80, 90]
        )
        const minScoreLbl = document.createElement("label")
        minScoreLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        minScoreLbl.append(document.createTextNode("Min score"), minScoreSel)
        filtRow.append(minScoreLbl)

        const maxDistSel = mkSuggestSelect(
            (this.settings.filters || {}).maxDistanceKm,
            [500, 1500, 3000, 5000, 8000, 12000, 15000]
        )
        const maxDistLbl = document.createElement("label")
        maxDistLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        maxDistLbl.append(document.createTextNode("Max km"), maxDistSel)
        filtRow.append(maxDistLbl)

        const statusBox = document.createElement("span")
        statusBox.style.cssText = "display:flex;gap:8px;"
        for (const s of ["NEW", "OK", "UNDER", "OVER", "OOR"]) {
            const sCb = mkInput("checkbox", null)
            sCb.checked = (this.settings.filters.statuses[s] !== false)
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:3px;align-items:center;color:" +
                ((RouteAssistantPanel.STATUS_DEF[s] || {}).color || "#9ca3af") + ";"
            lbl.append(sCb, document.createTextNode(s))
            statusBox.append(lbl)
            sCb.addEventListener("change", async () => {
                this.settings.filters.statuses[s] = sCb.checked
                await RouteAssistantSettings.save({filters: this.settings.filters})
                this._render()
            })
        }
        filtRow.append(statusBox)

        this.settingsHost.append(filtRow)

        const filterSync = async () => {
            this.settings.filters.minScore      = numOrNull(minScoreSel.value)
            this.settings.filters.maxDistanceKm = numOrNull(maxDistSel.value)
            await RouteAssistantSettings.save({filters: this.settings.filters})
            this._render()
        }
        minScoreSel.addEventListener("change", filterSync)
        maxDistSel.addEventListener("change", filterSync)

        // ----- Auto-Pricing (Tier 1 — visibility layer)
        // Surfaces the user's current ticket price / yield / ORS rank per
        // route, scraped from /app/com/scheduling/<HUB><DEST>. Tier 2
        // (recommendations) and Tier 3 (write-back) hang off the same
        // settings.pricing block.
        this._renderAutoPricingSection()

        // ----- Yield feedback (Roadmap G — actual-yields feedback loop)
        // Joins the live-route-data cache (which tells us which tails fly
        // each route) with `<server>aircraftFlights<id>` profit records
        // (written by content_aircraftFlights.js) and projects realised
        // $/flt onto the table. Closes the loop on the rough estimator.
        this._renderYieldFeedbackSection()

        // ----- Service profiles (per-class seats + service-level posture)
        // Default Y/C/F mix, class yield multipliers, per-class costs, and
        // service-level definitions. Per-route overrides land via the
        // Seats/wk ▾ popover.
        this._renderServiceProfilesSection()

        // ----- Carriers (Letter F — full carrier list per route)
        // Bulk-sync flightsfrom.com/<HUB>-<DEST> to enrich the Cmp
        // column with a colored intensity badge + per-carrier tooltip.
        this._renderCarriersSection()

        // ----- Market Analysis (Tier 2a — per-route markets-page scraper)
        // Bulk-sync /app/com/markets/<HUB><DEST> for competitor flights,
        // own pricing, market shares, and historic capacity/price charts.
        // Stored split across 4 chrome.storage.local key families.
        this._renderMarketAnalysisSection()

        // ----- ORS Rank (Tier 2b — Online Reservation System scraper)
        // Submits /app/info/ors per route and walks all result pages,
        // computing every flavor of "our rank". Stores the full connection
        // list so any rank metric can be re-derived at render time.
        this._renderOrsRankSection()

        // ----- Economics — feeds the rough profit estimator
        const econHeader = document.createElement("div")
        econHeader.style.cssText = "margin-top:10px;margin-bottom:4px;color:#9ca3af;font-size:11px;"
        econHeader.innerHTML = "<strong>Economics (rough profit estimator)</strong> — live-syncs as you type. Hover any $/flt cell for the full per-row breakdown."
        this.settingsHost.append(econHeader)

        const formula = document.createElement("div")
        formula.style.cssText = "margin:2px 0 6px 0;color:#6b7280;font-size:10px;line-height:1.5;"
        formula.innerHTML =
            "<strong>Pax LF</strong> = lerp(LF min, max) by pax demand 0–10. " +
            "<strong>Cargo LF</strong> = same with cargo demand. " +
            "<strong>Effective yield</strong> = base yield × (1 + <em>sensitivity</em> × (demand − 5)/5), " +
            "clamped [0.5×, 1.5×]. <strong>0 sensitivity = flat yield</strong>.<br>" +
            "Revenue = seats × paxLF × paxYield × dist × 2 × falloffMult <em>+</em> " +
            "cargoKg × cargoLF × cargoYield × dist × 2 × falloffMult.<br>" +
            "Cost = (fuel + crew + maint) × block hours + other-per-flight. " +
            "<em>$/flt = revenue − cost.</em>"
        this.settingsHost.append(formula)

        const econ = this.settings.economics || {}

        // Pax row
        const lfMinInput  = mkNumberInput(econ.loadFactorMin,          {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const lfMaxInput  = mkNumberInput(econ.loadFactorMax,          {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const lfInput     = mkNumberInput(econ.loadFactor,             {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const yieldInput  = mkNumberInput(econ.yieldPerKm,             {min: 0,    max: 10,   step: 0.01, width: "55px"})
        const yieldSensInput = mkNumberInput(econ.yieldDemandSensitivity, {min: 0, max: 1,    step: 0.1,  width: "55px"})
        // Cargo row
        const cyInput     = mkNumberInput(econ.cargoYieldPerKgKm,      {min: 0,    max: 1,    step: 0.0001, width: "75px"})
        const cLfMinInput = mkNumberInput(econ.cargoLoadFactorMin,     {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const cLfMaxInput = mkNumberInput(econ.cargoLoadFactorMax,     {min: 0,    max: 1,    step: 0.05, width: "55px"})
        const cySensInput = mkNumberInput(econ.cargoYieldDemandSensitivity, {min: 0, max: 1, step: 0.1, width: "55px"})
        // Cost row
        const fuelInput   = mkNumberInput(econ.fuelCostPerHour,        {min: 0,    max: 99999, step: 100, width: "70px"})
        const fuelAgeInput = mkNumberInput(econ.fuelAgePenaltyPerYear, {min: 0,    max: 0.05, step: 0.001, width: "65px"})
        const crewInput   = mkNumberInput(econ.crewCostPerHour,        {min: 0,    max: 99999, step: 50,  width: "65px"})
        const maintInput  = mkNumberInput(econ.maintenanceCostPerHour, {min: 0,    max: 99999, step: 50,  width: "65px"})
        const otherInput  = mkNumberInput(econ.otherFixedPerFlight,    {min: 0,    max: 9999999, step: 100, width: "75px"})
        const falloffMult = mkNumberInput(econ.falloffYieldMultiplier, {min: 0,    max: 1.5,  step: 0.05, width: "55px"})

        const wrap = (label, inp, hint) => {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
            w.title = hint || ""
            w.append(document.createTextNode(label), inp)
            return w
        }

        const paxRow = document.createElement("div")
        paxRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-bottom:4px;"
        const paxTag = document.createElement("strong")
        paxTag.textContent = "Pax"
        paxTag.style.cssText = "color:#60a5fa;font-size:10px;width:36px;"
        paxRow.append(
            paxTag,
            wrap("Yield AS$/km",       yieldInput,     "AS$ revenue per pax per km. Default 0.10 — tune to your game world."),
            wrap("Yield sens.",        yieldSensInput, "How much pax demand modulates yield. 0 = flat (default), 1 = ±20% by demand (clamped). Pairs with LF curve."),
            wrap("LF min (demand 0)",  lfMinInput,     "Pax load factor when AS pax demand is 0/10. Default 0.50."),
            wrap("LF max (demand 10)", lfMaxInput,     "Pax load factor when AS pax demand is 10/10. Default 0.95."),
            wrap("LF base",            lfInput,        "Pax fallback LF when demand isn't resolved. Default 0.75.")
        )
        this.settingsHost.append(paxRow)

        const cargoRow = document.createElement("div")
        cargoRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-bottom:4px;"
        const cargoTag = document.createElement("strong")
        cargoTag.textContent = "Cargo"
        cargoTag.style.cssText = "color:#a78bfa;font-size:10px;width:36px;"
        cargoRow.append(
            cargoTag,
            wrap("Yield AS$/kg-km",    cyInput,     "AS$ revenue per kg of cargo per km. Default 0 — cargo revenue is OFF until you enter a value. Try 0.0008 as a starting point."),
            wrap("Yield sens.",        cySensInput, "How much cargo demand modulates cargo yield. 0 = flat (default), 1 = ±20% by demand (clamped)."),
            wrap("LF min (demand 0)",  cLfMinInput, "Cargo load factor when AS cargo demand is 0/10. Default 0.40."),
            wrap("LF max (demand 10)", cLfMaxInput, "Cargo load factor when AS cargo demand is 10/10. Default 0.85.")
        )
        this.settingsHost.append(cargoRow)

        const commonRow = document.createElement("div")
        commonRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"
        const commonTag = document.createElement("strong")
        commonTag.textContent = "Cost"
        commonTag.style.cssText = "color:#9ca3af;font-size:10px;width:36px;"
        commonRow.append(
            commonTag,
            wrap("Fuel AS$/h",         fuelInput,    "AS$ per block hour, fleet-average fuel cost (base, before age penalty). Default 2500. When 'Auto-scale' is on in the Cache section below, this is the BASELINE — effective cost auto-scales by AS fuel price ratio."),
            wrap("Age penalty/yr",     fuelAgeInput, "Fraction of extra fuel per year of aircraft age. Default 0 = OFF. Try 0.005 (0.5%/yr) or 0.01 (1%/yr) — exact AS mechanic unconfirmed, calibrate from observation. Capped at 2× total. Per-tail mode uses exact tail age; per-type / Fleet mode uses avg age of owned aircraft of that type."),
            wrap("Crew AS$/h",         crewInput,    "AS$ per block hour for crew. Default 0 — disabled until you set it."),
            wrap("Maint AS$/h",        maintInput,   "AS$ per block hour for maintenance reserves. Default 0 — disabled until you set it."),
            wrap("Other AS$/flt",      otherInput,   "AS$ per round-trip: leasing, insurance, gate fees, anything fixed-per-flight. Default 0."),
            wrap("Falloff yield",      falloffMult,  "Revenue multiplier when distance is in the fall-off zone (90–95% of range). Default 0.85.")
        )
        this.settingsHost.append(commonRow)

        // ----- Cache section
        const cacheHeader = document.createElement("div")
        cacheHeader.style.cssText = "margin-top:10px;margin-bottom:4px;color:#9ca3af;font-size:11px;"
        cacheHeader.innerHTML = "<strong>Cache</strong> — distances are cached forever by default. Set a max age to re-resolve stale entries (e.g. after AS adjusts route restrictions)."
        this.settingsHost.append(cacheHeader)

        const cacheRow = document.createElement("div")
        cacheRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"
        const cacheTag = document.createElement("strong")
        cacheTag.textContent = "Distance"
        cacheTag.style.cssText = "color:#9ca3af;font-size:10px;width:50px;"
        const distAgeSel = mkSuggestSelect(
            this.settings.distanceMaxAgeDays,
            [7, 14, 30, 60, 90, 180]
        )
        const distAgeWrap = document.createElement("label")
        distAgeWrap.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        distAgeWrap.title = "Days before a cached distance is considered stale and re-resolved on next mount. Default: no expiry."
        distAgeWrap.append(document.createTextNode("Max age (days)"), distAgeSel)
        cacheRow.append(cacheTag, distAgeWrap)
        this.settingsHost.append(cacheRow)

        distAgeSel.addEventListener("change", async () => {
            this.settings.distanceMaxAgeDays = numOrNull(distAgeSel.value)
            await RouteAssistantSettings.save({distanceMaxAgeDays: this.settings.distanceMaxAgeDays})
            // Drop the resolver so it picks up the new max age, then refresh:
            // refresh rebuilds rows from ffData (distanceKm null), bulkLoad
            // applies only fresh entries, enrichment re-resolves the rest.
            this.distanceResolver = null
            await this.refresh()
        })

        // ----- AS fuel auto (letter A)
        // Per-type model: when Auto is on AND the scraped price is in ASc$/l,
        // fuel cost per flight = (cycle_L + per_km_L × dist × 2) × price/100,
        // with cycle_L and per_km_L derived per type (heuristic from spec, or
        // a stored override). When Auto is off, the legacy "Fuel AS$/h ×
        // block hours" model is used.
        const fuelRow = document.createElement("div")
        fuelRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;margin-top:4px;"
        const fuelTag = document.createElement("strong")
        fuelTag.textContent = "AS fuel"
        fuelTag.style.cssText = "color:#9ca3af;font-size:10px;width:50px;"

        const fp = this.fuelPrice
        const havePrice = fp && fp.unit === "ASc$/l" && typeof fp.value === "number" && fp.value > 0
        const fuelStatus = document.createElement("span")
        fuelStatus.style.color = "#9ca3af"
        if (this._fuelScrapeInFlight) {
            fuelStatus.textContent = "Scraping…"
            fuelStatus.style.color = "#60a5fa"
        } else if (fp && typeof fp.value === "number") {
            const ageH = Math.max(0, Math.round((Date.now() - fp.scrapedAt) / 3600e3))
            const ageStr = ageH < 1 ? "just now" : ageH + "h ago"
            const dateStr = fp.date ? " · " + (typeof fp.date === "number" ? fp.date.toFixed(2) : fp.date) : ""
            const unit = fp.unit === "ASc$/l" ? " ASc$/l" : " (chart-scale)"
            fuelStatus.textContent = `${fp.value.toFixed(2)}${unit} (${ageStr})${dateStr}`
            if (RouteAssistantFuelPriceScraper.isStale(fp)) fuelStatus.style.color = "#fbbf24"
        } else {
            fuelStatus.textContent = "Not scraped — click Refresh."
            fuelStatus.style.color = "#fbbf24"
        }

        const fuelRefreshBtn = document.createElement("button")
        fuelRefreshBtn.textContent = "Refresh"
        Object.assign(fuelRefreshBtn.style, smallBtnStyle())
        fuelRefreshBtn.style.fontSize = "10px"
        fuelRefreshBtn.style.padding = "1px 6px"
        fuelRefreshBtn.disabled = this._fuelScrapeInFlight
        if (this._fuelScrapeInFlight) fuelRefreshBtn.style.opacity = "0.5"
        fuelRefreshBtn.addEventListener("click", () => this._scrapeFuelPriceAsync())

        // Auto toggle — only meaningful with a usable ASc$/l price scrape.
        const autoCb = mkInput("checkbox", null)
        autoCb.checked = !!econ.fuelPriceAutoEnabled
        autoCb.disabled = !havePrice
        const autoLbl = document.createElement("label")
        autoLbl.style.cssText = "display:flex;gap:3px;align-items:center;color:#9ca3af;"
        autoLbl.title = "Compute fuel cost as (cycle_L + per_km_L × distance × 2) × current AS price. Per-type cycle/per_km derived from spec heuristic; override per type below."
        autoLbl.append(autoCb, document.createTextNode("Auto (per-type fuel)"))
        autoCb.addEventListener("change", async () => {
            this.settings.economics.fuelPriceAutoEnabled = autoCb.checked
            await RouteAssistantSettings.save({economics: this.settings.economics})
            this._recomputeProfit()
            this._renderSettings()
        })

        fuelRow.append(fuelTag, fuelStatus, fuelRefreshBtn, autoLbl)

        // When per-type fuel is on, override the Fuel AS$/h input with the
        // cruise-equivalent rate for the currently selected aircraft (or the
        // fleet average in Fleet mode). The user sees what fuel actually
        // costs them per hour at cruise. Field becomes read-only — the
        // underlying setting is preserved unchanged.
        const cruiseRate = (econ.fuelPriceAutoEnabled && havePrice)
            ? this._computeCruiseFuelRate(fp.value) : null
        if (cruiseRate !== null) {
            fuelInput.value = String(Math.round(cruiseRate.rate))
            fuelInput.disabled = true
            fuelInput.style.opacity = "0.7"
            fuelInput.title = `Auto-derived: ${cruiseRate.perKmL.toFixed(2)} L/km × ${cruiseRate.speed} km/h × ${fp.value} ASc/l ÷ 100 = AS$${Math.round(cruiseRate.rate)}/h cruise${cruiseRate.label ? " (" + cruiseRate.label + ")" : ""}. Disable Auto (per-type fuel) to edit.`
        }

        // Method indicator
        const methodNote = document.createElement("span")
        methodNote.style.cssText = "color:#6b7280;font-size:10px;"
        if (econ.fuelPriceAutoEnabled && havePrice) {
            methodNote.style.color = "#a3e635"
            const rateStr = cruiseRate
                ? ` · cruise rate AS$${Math.round(cruiseRate.rate)}/h${cruiseRate.label ? " (" + cruiseRate.label + ")" : ""}`
                : ""
            methodNote.textContent = "→ fuel = (cycle_L + per_km_L × dist × 2) × AS price" + rateStr
        } else if (econ.fuelPriceAutoEnabled && !havePrice) {
            methodNote.style.color = "#fbbf24"
            methodNote.textContent = "→ Auto on but no ASc$/l price — falling back to flat AS$/h"
        } else {
            methodNote.textContent = "→ legacy: Fuel AS$/h × block hours"
        }
        fuelRow.append(methodNote)

        this.settingsHost.append(fuelRow)

        // Per-type fuel-burn list (read-only summary; opens edit modal on click).
        if (econ.fuelPriceAutoEnabled && havePrice && this.fleet
                && Array.isArray(RouteAssistantFleetStore.activeTypeSlots(this.fleet))) {
            this._renderFuelBurnTable()
        }

        const allInputs = [lfMinInput, lfMaxInput, lfInput, yieldInput, yieldSensInput,
                           cyInput, cLfMinInput, cLfMaxInput, cySensInput,
                           fuelInput, fuelAgeInput, crewInput, maintInput, otherInput, falloffMult]

        // Apply changes immediately to in-memory settings (so the breakdown
        // tooltip on hover reads current values), but debounce the storage
        // write + recompute so a multi-keystroke entry like "0.123" doesn't
        // trigger 4 saves and 4 re-aggregations.
        const stageEconomics = () => {
            this.settings.economics = Object.assign({}, this.settings.economics, {
                loadFactor:                  parseFloatOr(lfInput.value, 0.75),
                loadFactorMin:               parseFloatOr(lfMinInput.value, 0.50),
                loadFactorMax:               parseFloatOr(lfMaxInput.value, 0.95),
                yieldPerKm:                  parseFloatOr(yieldInput.value, 0.10),
                yieldDemandSensitivity:      parseFloatOr(yieldSensInput.value, 0),
                cargoYieldPerKgKm:           parseFloatOr(cyInput.value, 0),
                cargoLoadFactorMin:          parseFloatOr(cLfMinInput.value, 0.40),
                cargoLoadFactorMax:          parseFloatOr(cLfMaxInput.value, 0.85),
                cargoYieldDemandSensitivity: parseFloatOr(cySensInput.value, 0),
                fuelCostPerHour:             fuelInput.disabled
                                                 ? this.settings.economics.fuelCostPerHour
                                                 : parseFloatOr(fuelInput.value, 2500),
                fuelAgePenaltyPerYear:       parseFloatOr(fuelAgeInput.value, 0),
                crewCostPerHour:             parseFloatOr(crewInput.value, 0),
                maintenanceCostPerHour:      parseFloatOr(maintInput.value, 0),
                otherFixedPerFlight:         parseFloatOr(otherInput.value, 0),
                falloffYieldMultiplier:      parseFloatOr(falloffMult.value, 0.85)
            })
        }

        const econDebounced = () => {
            stageEconomics()
            clearTimeout(this._economicsDebounceTimer)
            this._economicsDebounceTimer = setTimeout(async () => {
                await RouteAssistantSettings.save({economics: this.settings.economics})
                this._recomputeProfit()
            }, 250)
        }

        for (const inp of allInputs) {
            inp.addEventListener("input", econDebounced)
        }
    }

    // ---------- Auto-Pricing section (Tier 1) ----------

    /**
     * Renders the Auto-Pricing block inside the settings drawer:
     *   - status line (last scrape, K/N routes priced)
     *   - "Show pricing columns" toggle
     *   - "Scan prices for all visible routes" CTA + progress
     *   - placeholder note for Tier 2 / Tier 3 controls
     */
    _renderAutoPricingSection() {
        const cfg = this.settings.pricing = Object.assign(
            {showPricingColumns: true, concurrency: 4, staggerMs: 800, lastBulkScrapeAt: null},
            this.settings.pricing || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(244, 63, 94, 0.06);border:1px solid rgba(244, 63, 94, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#fda4af;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Live route data</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Captures aircraft, departure time, "
            + "frequency and cruise speed from /app/com/scheduling/&lt;HUB&gt;&lt;DEST&gt;. "
            + "Tier 2 will add prices and ORS rank from /app/com/markets/&lt;HUB&gt;&lt;DEST&gt;.</span>"
        wrap.append(header)

        // Status line — refreshed on every render; live progress updates
        // happen on this._priceStatusEl when a bulk scrape is running.
        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.liveAircraftType || r.liveDeparture).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Captured: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._priceStatusEl = status

        // Controls row: toggle + scan button
        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showPricingColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fda4af;"
        showLbl.append(showCb, document.createTextNode("Show live-data columns"))
        showCb.addEventListener("change", async () => {
            this.settings.pricing.showPricingColumns = showCb.checked
            await RouteAssistantSettings.save({pricing: this.settings.pricing})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._priceScrapeRunning
            ? "Syncing routes…"
            : "Sync route data for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#9f1239"
        scanBtn.disabled = !!this._priceScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkPriceScrape())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        // Tier 2/3 placeholder
        const futureNote = document.createElement("div")
        futureNote.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        futureNote.innerHTML = "Coming next: <em>Tier 2</em> — actual ticket prices + ORS rank from the markets page. "
            + "<em>Tier 3</em> — one-click apply with batch confirmation. "
            + "<em>Silent auto-apply</em> stays behind a separate explicit setting."
        wrap.append(futureNote)

        this.settingsHost.append(wrap)
    }

    /**
     * Bulk-scrape ticket prices for every (hub, dest) pair in this.rows
     * using RouteAssistantTicketPriceScraper. Updates the status line as
     * progress arrives; on completion, re-loads the cache, persists
     * lastBulkScrapeAt, and re-renders so columns fill in.
     */
    async _runBulkPriceScrape() {
        if (this._priceScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.pricing || {}
        const concurrency = cfg.concurrency || 4
        const staggerMs   = cfg.staggerMs   || 800

        if (!this.priceScraper) {
            this.priceScraper = new RouteAssistantTicketPriceScraper(this.server, {
                maxAgeDays: cfg.priceMaxAgeDays
            })
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._priceScrapeRunning = true
        this._renderSettings()  // disable button + flip label

        try {
            await this.priceScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    if (this._priceStatusEl) {
                        this._priceStatusEl.textContent = "Syncing route data: " + done + "/" + total + "…"
                    }
                }
            })
        } catch (e) {
            console.warn("[AES priceScraper] bulk scrape failed", e)
        }

        this._priceScrapeRunning = false
        this.settings.pricing.lastBulkScrapeAt = Date.now()
        await RouteAssistantSettings.save({pricing: this.settings.pricing})

        await this._applyCachedPrices()
        this._render()
    }

    // ---------- Yield feedback (Roadmap G) ----------

    /**
     * Settings-drawer block for the actual-yields feedback loop:
     *   - status line (last snapshot, K/N routes have history)
     *   - Snapshot CTA + progress
     *   - "Show actuals columns" toggle, attribution-mode select,
     *     variance threshold, history limit
     */
    _renderYieldFeedbackSection() {
        const cfg = this.settings.yieldFeedback = Object.assign(
            {showColumns: true, varianceWarnPct: 25, attributionMode: "frequency",
             historyLimit: 12, lastSnapshotAt: null, autoSnapshotOnMount: false,
             deltaMode: false},
            this.settings.yieldFeedback || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(168, 85, 247, 0.08);border:1px solid rgba(168, 85, 247, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#d8b4fe;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Yield feedback (actuals)</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Joins cached "
            + "live-route data with each tail's <code>aircraftFlights</code> profit record "
            + "to attribute realised $/flt per route. Closes the loop with the rough estimator.</span>"
        wrap.append(header)

        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.actualProfitPerFlight != null).length
        const lastSnap  = cfg.lastSnapshotAt
            ? new Date(cfg.lastSnapshotAt).toLocaleString()
            : "never"

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        status.textContent = "Snapshots: " + dataRows + "/" + totalRows
            + " routes · last snapshot: " + lastSnap
        wrap.append(status)
        this._snapshotStatusEl = status

        // Diagnostic block — only shown after the user actually clicked
        // "Snapshot yields now". Surfaces *why* the run produced what it did
        // so a 0-routes outcome doesn't read as silent failure.
        const diag = this._lastSnapshotResult
        if (diag) {
            const liveCaptured = (this.rows || []).filter(r => r.liveAircraftType || r.liveDeparture).length
            const lines = []
            const modeLine = diag.mode === "delta"
                ? "delta-mode · " + (diag.tailsUsingDelta || 0) + "/" + diag.tailsUsed + " tails had a prior baseline"
                : "cumulative-mode (lifetime average $/flt per tail)"
            lines.push(diag.routesUpdated + " route" + (diag.routesUpdated === 1 ? "" : "s")
                + " updated · " + diag.routesScanned + " scanned · "
                + diag.tailsUsed + "/" + diag.tailsSeen + " tails contributed · " + modeLine)
            if (diag.tailsMissingProfit > 0) {
                const sample = (diag.tailsMissingList || []).slice(0, 6).join(", ")
                lines.push("⚠ " + diag.tailsMissingProfit + " tail"
                    + (diag.tailsMissingProfit === 1 ? "" : "s")
                    + " missing profit data — visit /app/fleets/aircraft/<id>/1 to capture each."
                    + (sample ? "\n   First few: " + sample
                        + (diag.tailsMissingList.length > 6 ? ", …" : "") : ""))
            }
            if (diag.routesScanned === 0 && liveCaptured === 0) {
                lines.push("⚠ No live route data found. Click \"Sync route data for all visible routes\" first.")
            } else if (diag.routesScanned === 0 && liveCaptured > 0) {
                lines.push("⚠ Live route data exists but no flights were attributed. "
                    + "Re-sync the routes in case the previous fetch missed the Flight Numbers table.")
            }
            const diagBox = document.createElement("div")
            const errorish = diag.routesUpdated === 0 || diag.tailsMissingProfit > 0
            diagBox.style.cssText = "color:" + (errorish ? "#fde68a" : "#a7f3d0")
                + ";font-size:10px;margin-bottom:6px;white-space:pre-wrap;line-height:1.45;"
                + "background:" + (errorish ? "rgba(245,158,11,0.07)" : "rgba(34,197,94,0.07)")
                + ";border:1px solid " + (errorish ? "rgba(245,158,11,0.30)" : "rgba(34,197,94,0.30)")
                + ";border-radius:3px;padding:4px 6px;"
            diagBox.textContent = "Last snapshot: " + lines.join("\n")
            wrap.append(diagBox)
        }

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#d8b4fe;"
        showLbl.append(showCb, document.createTextNode("Show actuals columns"))
        showCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.showColumns = showCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
            this._render()
        })
        ctrlRow.append(showLbl)

        const modeSel = mkSelect([
            {value: "frequency", label: "by frequency"},
            {value: "distance",  label: "by distance × frequency"},
            {value: "equal",     label: "split equally per route"}
        ])
        modeSel.value = cfg.attributionMode || "frequency"
        modeSel.style.fontSize = "11px"
        modeSel.addEventListener("change", async () => {
            this.settings.yieldFeedback.attributionMode = modeSel.value
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        const modeLbl = document.createElement("label")
        modeLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        modeLbl.append(document.createTextNode("Attribution:"), modeSel)
        ctrlRow.append(modeLbl)

        const warnInput = mkNumberInput(cfg.varianceWarnPct, {min: 1, max: 200, step: 1, width: "55px"})
        warnInput.addEventListener("change", async () => {
            const v = parseFloatOr(warnInput.value, 25)
            this.settings.yieldFeedback.varianceWarnPct = Math.max(1, Math.round(v))
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
            this._render()
        })
        const warnLbl = document.createElement("label")
        warnLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        warnLbl.append(document.createTextNode("Δ% warn at ±"), warnInput, document.createTextNode("%"))
        ctrlRow.append(warnLbl)

        const limitInput = mkNumberInput(cfg.historyLimit, {min: 2, max: 60, step: 1, width: "50px"})
        limitInput.addEventListener("change", async () => {
            const v = parseFloatOr(limitInput.value, 12)
            this.settings.yieldFeedback.historyLimit = Math.max(2, Math.round(v))
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        const limitLbl = document.createElement("label")
        limitLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        limitLbl.append(document.createTextNode("History"), limitInput, document.createTextNode("snapshots"))
        ctrlRow.append(limitLbl)

        const deltaCb = mkInput("checkbox", null)
        deltaCb.checked = !!cfg.deltaMode
        const deltaLbl = document.createElement("label")
        deltaLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        deltaLbl.title = "Delta mode subtracts the previous snapshot's lifetime profit from each "
            + "tail's current cumulative profit, so $/flt reflects only flights flown SINCE the "
            + "last snapshot (true periodic yield). First snapshot still uses cumulative; "
            + "subsequent runs switch automatically per-tail when a baseline exists."
        deltaLbl.append(deltaCb, document.createTextNode("Delta mode"))
        deltaCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.deltaMode = deltaCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        ctrlRow.append(deltaLbl)

        const autoCb = mkInput("checkbox", null)
        autoCb.checked = !!cfg.autoSnapshotOnMount
        const autoLbl = document.createElement("label")
        autoLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        autoLbl.title = "When enabled, the panel runs a snapshot once after each mount/refresh. "
            + "Skipped silently when no live route data is cached yet."
        autoLbl.append(autoCb, document.createTextNode("Auto on mount"))
        autoCb.addEventListener("change", async () => {
            this.settings.yieldFeedback.autoSnapshotOnMount = autoCb.checked
            await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        })
        ctrlRow.append(autoLbl)

        const snapBtn = document.createElement("button")
        snapBtn.textContent = this._snapshotRunning ? "Snapshotting…" : "Snapshot yields now"
        Object.assign(snapBtn.style, smallBtnStyle())
        snapBtn.style.background = "#7c3aed"
        snapBtn.disabled = !!this._snapshotRunning || !this.hubIata
        snapBtn.addEventListener("click", () => this._runYieldSnapshot())
        ctrlRow.append(snapBtn)

        // Calibrate-flagged button — runs the per-route override editor's
        // "Calibrate from actuals" math against every row whose |Δ%| trips
        // the variance threshold, batched behind a confirmation modal so a
        // single click never silently overrides 50 routes.
        const flagged = this._flaggedRoutesForCalibration()
        const calibBtn = document.createElement("button")
        calibBtn.textContent = "Calibrate flagged (" + flagged.length + ")"
        Object.assign(calibBtn.style, smallBtnStyle())
        calibBtn.style.background = flagged.length ? "#7c3aed" : "#475569"
        calibBtn.disabled = !flagged.length
        if (!flagged.length) calibBtn.style.opacity = "0.5"
        calibBtn.title = flagged.length
            ? "Open a confirmation modal listing every route whose Δ% currently exceeds the warn threshold "
              + "and the per-route yield override that would make the estimator match the latest snapshot. "
              + "Save runs as a batch."
            : "No routes currently flagged. Lower the warn threshold or take a fresh snapshot to populate."
        calibBtn.addEventListener("click", () => this._openCalibrateFlaggedModal(flagged))
        ctrlRow.append(calibBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Requires recent <em>Sync route data</em> (so we know which tails fly each route) "
            + "and one visit to each tail's flight-history page (<code>/app/fleets/aircraft/&lt;id&gt;/1</code>) "
            + "so its profit is captured. Snapshot reports tails missing profit data so you can fill in the gaps."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Returns the rows whose |actualVariancePct| meets or exceeds the user's
     * warn threshold AND whose `derivedYieldFromActuals` solves to a finite
     * positive number. Used by the "Calibrate flagged" CTA.
     */
    _flaggedRoutesForCalibration() {
        if (!this.rows || !this.rows.length) return []
        const cfg = this.settings && this.settings.yieldFeedback
        const warn = (cfg && Number(cfg.varianceWarnPct) > 0) ? Number(cfg.varianceWarnPct) : 25
        const out = []
        for (const row of this.rows) {
            const v = row.actualVariancePct
            if (v === null || v === undefined) continue
            if (Math.abs(v) < warn) continue
            const target = derivedYieldFromActuals(row)
            if (target === null) continue
            out.push({row: row, target: target, variance: v})
        }
        return out
    }

    /**
     * Modal — list every flagged route's existing yield, the proposed
     * calibrated yield, and the resulting Δ%. User can deselect any row,
     * Save writes batch overrides via RouteAssistantRouteOverridesStore.
     */
    _openCalibrateFlaggedModal(flagged) {
        if (!flagged || !flagged.length) return
        if (this._calibrateFlaggedOverlay) return  // already open
        const overlay = document.createElement("div")
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,0.65);"
            + "z-index:10001;display:flex;align-items:center;justify-content:center;"
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._calibrateFlaggedOverlay = null
        }
        overlay.addEventListener("click", e => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        card.style.cssText = "background:#0f172a;color:#e5e7eb;border:1px solid #334155;"
            + "border-radius:6px;padding:14px 16px;max-width:680px;max-height:80vh;"
            + "overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,0.5);"

        const title = document.createElement("div")
        title.style.cssText = "font-size:13px;font-weight:600;color:#d8b4fe;margin-bottom:4px;"
        title.textContent = "Calibrate " + flagged.length + " flagged route"
            + (flagged.length === 1 ? "" : "s") + " from actuals"
        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;line-height:1.5;"
        sub.innerHTML = "Each row shows the existing yield (or default), the calibrated value that "
            + "would make the estimator match the latest snapshot at the current LF / spec, and the "
            + "Δ% that drove the flag. Untick any row you don't want to write. Saving creates or "
            + "extends a per-route override (other override fields are preserved)."
        card.append(title, sub)

        const tbl = document.createElement("table")
        tbl.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;"
        const head = document.createElement("tr")
        head.innerHTML = "<th></th>"
            + "<th style='text-align:left;padding:4px 6px;color:#94a3b8;'>Route</th>"
            + "<th style='text-align:right;padding:4px 6px;color:#94a3b8;'>Δ%</th>"
            + "<th style='text-align:right;padding:4px 6px;color:#94a3b8;'>Old yield</th>"
            + "<th style='text-align:right;padding:4px 6px;color:#94a3b8;'>New yield</th>"
        tbl.append(head)
        const checks = []
        for (const f of flagged) {
            const tr = document.createElement("tr")
            tr.style.borderTop = "1px solid #1f2937"
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.checked = true
            checks.push({entry: f, cb: cb})
            const td = (txt, align) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:4px 6px;text-align:" + (align || "left") + ";"
                c.textContent = txt
                return c
            }
            const oldYield = (f.row.override && typeof f.row.override.yieldPerKm === "number")
                ? f.row.override.yieldPerKm
                : (this.settings && this.settings.economics && this.settings.economics.yieldPerKm)
                    ? this.settings.economics.yieldPerKm
                    : null
            const cbCell = document.createElement("td")
            cbCell.style.padding = "4px 6px"
            cbCell.append(cb)
            const v = f.variance
            const vCell = td((v > 0 ? "+" : "") + v + "%", "right")
            vCell.style.color = v > 0 ? "#86efac" : "#fca5a5"
            tr.append(cbCell, td(f.row.destIata, "left"), vCell,
                td(oldYield != null ? oldYield.toFixed(4) : "—", "right"),
                td(f.target.toFixed(4), "right"))
            tbl.append(tr)
        }
        card.append(tbl)

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:8px;margin-top:12px;justify-content:flex-end;"
        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.addEventListener("click", () => close())
        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save selected"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.background = "#7c3aed"
        saveBtn.addEventListener("click", async () => {
            saveBtn.disabled = true
            saveBtn.textContent = "Saving…"
            const hubU = String(this.hubIata || "").toUpperCase()
            const noteStr = "calibrated " + new Date().toISOString().slice(0, 10)
            let written = 0
            for (const c of checks) {
                if (!c.cb.checked) continue
                const ex = c.entry.row.override || {}
                const fields = {
                    paxLF:             typeof ex.paxLF === "number" ? ex.paxLF : null,
                    cargoLF:           typeof ex.cargoLF === "number" ? ex.cargoLF : null,
                    yieldPerKm:        c.entry.target,
                    cargoYieldPerKgKm: typeof ex.cargoYieldPerKgKm === "number" ? ex.cargoYieldPerKgKm : null,
                    note:              ex.note ? (ex.note + " · " + noteStr) : noteStr
                }
                const destU = String(c.entry.row.destIata || "").toUpperCase()
                const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
                if (saved) {
                    c.entry.row.override = saved
                    this.overrideMap.set(hubU + "-" + destU, saved)
                    written++
                }
            }
            close()
            if (written) {
                this._recomputeProfit()
                console.log("[AES yieldFeedback] calibrated " + written + " route(s) from actuals")
            }
        })
        btnRow.append(cancelBtn, saveBtn)
        card.append(btnRow)

        overlay.append(card)
        document.body.append(overlay)
        this._calibrateFlaggedOverlay = overlay
    }

    /**
     * Walk every aircraftFlights record in this server's storage, join to the
     * cached scheduling-page scrape (tails ↔ routes), attribute profits, and
     * append one snapshot per route to RouteAssistantYieldHistoryStore.
     * Updates the panel's in-memory map + re-renders so the actuals columns
     * fill in without a full refresh.
     */
    async _runYieldSnapshot() {
        if (this._snapshotRunning || !this.hubIata) return
        const cfg = this.settings.yieldFeedback || {}
        this._snapshotRunning = true
        if (this._snapshotStatusEl) this._snapshotStatusEl.textContent = "Snapshotting…"
        this._renderSettings()

        let result = null
        try {
            // Distance-mode attribution wants a hub-pair → distance map. We
            // already cache distances per pair; the resolver's symmetric
            // pair-key matches what `RouteAssistantYieldSnapshot._lookupDistance`
            // tries. Fall back to "frequency" silently per-pair when missing.
            const distanceMap = await RouteAssistantDistanceResolver.bulkLoadCache(
                (this.rows || []).map(r => [this.hubIata, r.destIata])
            )
            result = await RouteAssistantYieldSnapshot.takeSnapshot({
                server:          this.server,
                hubIata:         this.hubIata,
                attributionMode: cfg.attributionMode,
                historyLimit:    cfg.historyLimit,
                distanceMap:     distanceMap,
                deltaMode:       !!cfg.deltaMode
            })
        } catch (e) {
            console.warn("[AES yieldFeedback] snapshot failed", e)
        }

        this._snapshotRunning = false
        this.settings.yieldFeedback.lastSnapshotAt = Date.now()
        await RouteAssistantSettings.save({yieldFeedback: this.settings.yieldFeedback})
        this._lastSnapshotResult = result

        if (this.hubIata && this.rows && this.rows.length) {
            const dests = this.rows.map(r => [this.hubIata, r.destIata])
            this.yieldHistoryMap = await RouteAssistantYieldHistoryStore.getMany(dests)
            RouteAssistantAggregator.applyYieldHistory(this.rows, this.yieldHistoryMap, this.hubIata)
        }
        this._render()
        this._renderSettings()

        if (result) {
            const modeStr = result.mode === "delta"
                ? "delta (" + (result.tailsUsingDelta || 0) + "/" + result.tailsUsed + " tails w/ baseline)"
                : "cumulative"
            const summary = "[AES yieldFeedback] snapshot: "
                + result.routesUpdated + " routes updated · "
                + result.tailsUsed + "/" + result.tailsSeen + " tails contributed · "
                + result.tailsMissingProfit + " missing profit data · mode: " + modeStr
            console.log(summary, result)
        }
    }

    // ---------- Carriers (letter F) ----------

    /**
     * Settings-drawer expander for the per-route service profiles defaults.
     * Per-route overrides land via the Seats/wk ▾ popover; this expander
     * lets the user tune the global defaults that fall through.
     */
    _renderServiceProfilesSection() {
        const cfg = this.settings.serviceProfiles = Object.assign(
            {showServiceColumns: true},
            this.settings.serviceProfiles || {}
        )
        // Ensure nested defaults exist (deep-merge already filled them at load,
        // but a fresh upgrade through save() may strip them).
        cfg.defaultClassMix  = Object.assign({Y: 1.0, C: 0,    F: 0  }, cfg.defaultClassMix  || {})
        cfg.classYieldMult   = Object.assign({Y: 1.0, C: 2.5,  F: 4.5}, cfg.classYieldMult   || {})
        cfg.classCostPerPax  = Object.assign({Y: 5,   C: 18,   F: 45 }, cfg.classCostPerPax  || {})
        cfg.serviceLevels    = Object.assign({
            budget:   {yieldMult: 0.85, costPerPax: 3,  label: "Budget"},
            standard: {yieldMult: 1.00, costPerPax: 8,  label: "Standard"},
            premium:  {yieldMult: 1.20, costPerPax: 22, label: "Premium"}
        }, cfg.serviceLevels || {})

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(56, 189, 248, 0.08);border:1px solid rgba(56, 189, 248, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#7dd3fc;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Service profiles</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Default Y/C/F class mix, class yield multipliers, per-pax cost, and service-level posture. Per-route overrides via the Seats/wk ▾.</span>"
        wrap.append(header)

        // ---- Show columns toggle
        const showRow = document.createElement("div")
        showRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:6px;"
        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showServiceColumns !== false
        showCb.addEventListener("change", async () => {
            cfg.showServiceColumns = showCb.checked
            await RouteAssistantSettings.save({serviceProfiles: cfg})
            this._render()
        })
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#7dd3fc;"
        showLbl.append(showCb, document.createTextNode("Show Service columns (Seats/wk · Mix · Svc)"))
        showRow.append(showLbl)
        wrap.append(showRow)

        // ---- Default class mix
        const mixWrap = document.createElement("div")
        mixWrap.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px;flex-wrap:wrap;"
        const mY = mkNumberInput(Math.round((cfg.defaultClassMix.Y || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mC = mkNumberInput(Math.round((cfg.defaultClassMix.C || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mF = mkNumberInput(Math.round((cfg.defaultClassMix.F || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        mixWrap.append((() => { const s = document.createElement("span"); s.textContent = "Default mix %"; s.style.color = "#9ca3af"; return s })())
        for (const [lbl, inp, color] of [["Y", mY, "#7dd3fc"], ["C", mC, "#fcd34d"], ["F", mF, "#fda4af"]]) {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:3px;align-items:center;color:" + color + ";"
            w.append(document.createTextNode(lbl), inp)
            mixWrap.append(w)
        }
        wrap.append(mixWrap)

        // ---- Per-class yield mult + cost
        const fareTable = document.createElement("table")
        fareTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        fareTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Class</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield × base</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
        </tr></thead>`
        const fareBody = document.createElement("tbody")
        const yldInputs = {}
        const costInputs = {}
        const classColors = {Y: "#7dd3fc", C: "#fcd34d", F: "#fda4af"}
        for (const cls of ["Y", "C", "F"]) {
            const yldIn  = mkNumberInput(cfg.classYieldMult[cls],  {min: 0, max: 20,    step: 0.1,  width: "70px"})
            const costIn = mkNumberInput(cfg.classCostPerPax[cls], {min: 0, max: 99999, step: 1,    width: "70px"})
            yldInputs[cls]  = yldIn
            costInputs[cls] = costIn
            const tr = document.createElement("tr")
            const cell = (text, color) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:2px 4px;color:" + (color || "#d1d5db") + ";"
                c.textContent = text
                return c
            }
            tr.append(cell(cls, classColors[cls]))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(yldCell, costCell)
            fareBody.append(tr)
        }
        fareTable.append(fareBody)
        wrap.append(fareTable)

        // ---- Service levels
        const lvlTable = document.createElement("table")
        lvlTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        lvlTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Service level</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield ×</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
        </tr></thead>`
        const lvlBody = document.createElement("tbody")
        const lvlInputs = {}
        for (const lvl of ["budget", "standard", "premium"]) {
            const def = cfg.serviceLevels[lvl] || {}
            const yldIn  = mkNumberInput(def.yieldMult,  {min: 0,    max: 5,    step: 0.05, width: "65px"})
            const costIn = mkNumberInput(def.costPerPax, {min: 0,    max: 9999, step: 1,    width: "65px"})
            lvlInputs[lvl] = {yld: yldIn, cost: costIn}
            const tr = document.createElement("tr")
            const labelCell = document.createElement("td")
            labelCell.style.cssText = "padding:2px 4px;color:#d1d5db;"
            labelCell.textContent = (def.label || (lvl.charAt(0).toUpperCase() + lvl.slice(1)))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(labelCell, yldCell, costCell)
            lvlBody.append(tr)
        }
        lvlTable.append(lvlBody)
        wrap.append(lvlTable)

        // ---- Save row
        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save service-profile defaults"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.background = "#0284c7"
        saveBtn.addEventListener("click", async () => {
            const sumPct = (parseFloatOr(mY.value, 0) || 0)
                         + (parseFloatOr(mC.value, 0) || 0)
                         + (parseFloatOr(mF.value, 0) || 0)
            const factor = sumPct > 0 ? 100 / sumPct : 1
            const norm = {
                Y: Math.max(0, (parseFloatOr(mY.value, 0) || 0) * factor) / 100,
                C: Math.max(0, (parseFloatOr(mC.value, 0) || 0) * factor) / 100,
                F: Math.max(0, (parseFloatOr(mF.value, 0) || 0) * factor) / 100
            }
            cfg.defaultClassMix  = norm
            for (const cls of ["Y", "C", "F"]) {
                cfg.classYieldMult[cls]  = parseFloatOr(yldInputs[cls].value,  cfg.classYieldMult[cls])
                cfg.classCostPerPax[cls] = parseFloatOr(costInputs[cls].value, cfg.classCostPerPax[cls])
            }
            for (const lvl of ["budget", "standard", "premium"]) {
                cfg.serviceLevels[lvl] = Object.assign({}, cfg.serviceLevels[lvl] || {}, {
                    yieldMult:  parseFloatOr(lvlInputs[lvl].yld.value,  cfg.serviceLevels[lvl].yieldMult),
                    costPerPax: parseFloatOr(lvlInputs[lvl].cost.value, cfg.serviceLevels[lvl].costPerPax)
                })
            }
            await RouteAssistantSettings.save({serviceProfiles: cfg})
            this._reapplyServiceProjection()
            this._render()
        })
        wrap.append(saveBtn)

        // ---- AS service profiles auto-detect block
        const asWrap = document.createElement("div")
        asWrap.style.cssText = "margin-top:8px;padding:6px 8px;background:rgba(15, 23, 42, 0.5);border:1px dashed rgba(56, 189, 248, 0.30);border-radius:3px;"
        const asHead = document.createElement("div")
        asHead.style.cssText = "color:#7dd3fc;font-size:10px;margin-bottom:4px;"
        const profileCount = (this.serviceProfilesCache && this.serviceProfilesCache.size) || 0
        const listCache    = this._serviceProfilesList || null
        const lastSyncTxt  = listCache && listCache.scrapedAt
            ? new Date(listCache.scrapedAt).toLocaleString()
            : "never"
        asHead.innerHTML = "<strong>AS service profiles auto-detect</strong> — "
            + profileCount + " profile" + (profileCount === 1 ? "" : "s") + " cached · last sync: " + lastSyncTxt
        asWrap.append(asHead)

        const refreshBtn = document.createElement("button")
        refreshBtn.textContent = this._serviceProfileSyncRunning ? "Syncing…" : "Refresh AS service profiles"
        Object.assign(refreshBtn.style, smallBtnStyle())
        refreshBtn.style.background = "#0ea5e9"
        refreshBtn.disabled = !!this._serviceProfileSyncRunning
        refreshBtn.addEventListener("click", () => this._refreshServiceProfilesFromAS())
        asWrap.append(refreshBtn)

        const asNote = document.createElement("div")
        asNote.style.cssText = "color:#6b7280;font-size:10px;margin-top:4px;line-height:1.4;"
        asNote.innerHTML = "Fetches /action/enterprise/serviceProfiles + per-profile detail pages. "
            + "Each route's <em>assigned</em> service profile (from the markets-page sync) "
            + "then surfaces in the Svc tooltip + Seats/wk popover with its real name + per-class quality score."
        asWrap.append(asNote)
        wrap.append(asWrap)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Mix percentages renormalise to 100% on save. Per-route overrides (Seats/wk ▾) take precedence over these defaults."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Sync the AS service-profile list + every detail referenced. Persists
     * `routeAssistant:serviceProfilesList` and `routeAssistant:serviceProfile:<id>`
     * for the popover / tooltip layer to read on next render.
     */
    async _refreshServiceProfilesFromAS() {
        if (this._serviceProfileSyncRunning) return
        if (typeof RouteAssistantServiceProfileScraper === "undefined") return
        this._serviceProfileSyncRunning = true
        this._renderSettings()
        try {
            if (!this._serviceProfileScraper) {
                this._serviceProfileScraper = new RouteAssistantServiceProfileScraper(this.server)
            }
            await this._serviceProfileScraper.syncAll()
            this.serviceProfilesCache = await RouteAssistantServiceProfileScraper.loadAllDetails()
            this._serviceProfilesList = await RouteAssistantServiceProfileScraper.loadList()
        } catch (e) {
            console.warn("[AES serviceProfile] sync failed", e)
        }
        this._serviceProfileSyncRunning = false
        this._render()
        this._renderSettings()
    }

    /**
     * Settings-drawer expander for the carrier-list scraper.
     * Mirrors `_renderAutoPricingSection`:
     *   - status line: "Synced X/Y routes · last bulk sync: …"
     *   - showCarrierIntensity toggle
     *   - "Sync carriers for all visible routes" CTA
     *
     * Fetches go through `RouteAssistantCarriersScraper.bulkScrape`
     * with concurrency + stagger from `settings.carriers`.
     */
    _renderCarriersSection() {
        const cfg = this.settings.carriers = Object.assign(
            {showCarrierIntensity: true, concurrency: 3, staggerMs: 1200, lastBulkScrapeAt: null},
            this.settings.carriers || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(34, 197, 94, 0.06);border:1px solid rgba(34, 197, 94, 0.25);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#86efac;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Carriers</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-route carrier list from "
            + "flightsfrom.com/&lt;HUB&gt;-&lt;DEST&gt;. Replaces the integer Cmp count with a "
            + "colored intensity badge (green/amber/red) and a hover tooltip listing each carrier.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r =>
            Array.isArray(r.carriers) || r.carriersScrapedAt
        ).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Synced: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._carrierStatusEl = status

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showCarrierIntensity !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#86efac;"
        showLbl.append(showCb, document.createTextNode("Show colored intensity badge"))
        showCb.addEventListener("change", async () => {
            this.settings.carriers.showCarrierIntensity = showCb.checked
            await RouteAssistantSettings.save({carriers: this.settings.carriers})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._carrierScrapeRunning
            ? "Syncing carriers…"
            : "Sync carriers for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#15803d"
        scanBtn.disabled = !!this._carrierScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkCarrierScrape())
        ctrlRow.append(scanBtn)

        // F slice 2 — bulk-sync AS enterprise metadata for the
        // competitor list. Different button so the user can keep
        // flightsfrom carriers fresh independently of AS enterprise
        // banner/avatar caches (different TTLs).
        const enterpriseBtn = document.createElement("button")
        enterpriseBtn.textContent = this._enterpriseMetaScrapeRunning
            ? "Syncing enterprise data…"
            : "Sync enterprise data (banners + avatars)"
        Object.assign(enterpriseBtn.style, smallBtnStyle())
        enterpriseBtn.style.background = "#1d4ed8"
        // Count distinct enterpriseIds across visible rows so we can
        // gate the button: nothing to do if no AS competitors yet.
        const visibleIds = (() => {
            const s = new Set()
            for (const r of (this.rows || [])) {
                for (const list of [r.marketSharePax, r.marketShareCargo]) {
                    if (!Array.isArray(list)) continue
                    for (const e of list) {
                        if (e && e.enterpriseId != null) s.add(String(e.enterpriseId))
                    }
                }
            }
            return s.size
        })()
        enterpriseBtn.disabled = !!this._enterpriseMetaScrapeRunning
            || !this.hubIata
            || visibleIds === 0
        enterpriseBtn.title = visibleIds > 0
            ? visibleIds + " distinct enterprises visible"
            : "Sync the Markets page first to populate AS competitors."
        enterpriseBtn.addEventListener("click", () => this._runBulkEnterpriseMetaSync())
        ctrlRow.append(enterpriseBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        const lastMeta = (cfg.lastEnterpriseMetaSyncAt)
            ? new Date(cfg.lastEnterpriseMetaSyncAt).toLocaleString()
            : "never"
        note.innerHTML = "flightsfrom.com is rate-limited — defaults are "
            + cfg.concurrency + " concurrent / " + cfg.staggerMs + "ms stagger. "
            + "Hover any Cmp pill to see the carrier list. "
            + "<br>AS enterprise data: " + visibleIds + " visible · last sync " + lastMeta + "."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Bulk-scrape carrier lists for every (hub, dest) pair in this.rows.
     * Mirrors `_runBulkPriceScrape` — same concurrency/stagger pattern,
     * same `lastBulkScrapeAt` persistence, same re-load + re-render
     * sequence on completion.
     */
    async _runBulkCarrierScrape() {
        if (this._carrierScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.carriers || {}
        const concurrency = cfg.concurrency || 3
        const staggerMs   = cfg.staggerMs   || 1200

        if (!this.carrierScraper) {
            this.carrierScraper = new RouteAssistantCarriersScraper({
                maxAgeDays: cfg.carriersMaxAgeDays
            })
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._carrierScrapeRunning = true
        this._renderSettings()

        try {
            await this.carrierScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    if (this._carrierStatusEl) {
                        this._carrierStatusEl.textContent =
                            "Syncing carriers: " + done + "/" + total + "…"
                    }
                }
            })
        } catch (e) {
            console.warn("[AES carriersScraper] bulk scrape failed", e)
        }

        this._carrierScrapeRunning = false
        this.settings.carriers.lastBulkScrapeAt = Date.now()
        await RouteAssistantSettings.save({carriers: this.settings.carriers})

        await this._applyCachedCarriers()
        this._render()
    }

    /**
     * F slice 2 — bulk-fetch enterprise metadata (banner + avatar +
     * name + IATA) for every distinct enterpriseId currently visible
     * across all rows' marketSharePax / marketShareCargo lists.
     *
     * Skips IDs we already have cached and unexpired — the user can
     * re-run the scrape after the configured TTL passes (default 90
     * days). Idempotent: a full second click does nothing if every ID
     * is fresh.
     */
    async _runBulkEnterpriseMetaSync() {
        if (this._enterpriseMetaScrapeRunning || !this.rows || !this.rows.length) return
        const cfg = this.settings.carriers || {}
        const concurrency = cfg.enterpriseMetaConcurrency || 4
        const staggerMs   = cfg.enterpriseMetaStaggerMs   || 600

        // Collect every enterpriseId visible across both pax + cargo
        // shares. De-duplicate to avoid hammering the same page once
        // per appearance.
        const ids = new Set()
        for (const r of this.rows) {
            for (const list of [r.marketSharePax, r.marketShareCargo]) {
                if (!Array.isArray(list)) continue
                for (const e of list) {
                    if (e && e.enterpriseId != null) ids.add(String(e.enterpriseId))
                }
            }
        }
        if (!ids.size) {
            if (this._carrierStatusEl) {
                this._carrierStatusEl.textContent = "No AS competitors visible — sync the Markets page first."
            }
            return
        }

        // Drop ids that are already fresh in cache.
        const cached = await RouteAssistantEnterpriseMetaScraper.bulkLoadCache(
            Array.from(ids), {maxAgeDays: cfg.enterpriseMetaMaxAgeDays}
        )
        const todo = Array.from(ids).filter(id => !cached.has(id))
        if (!todo.length) {
            if (this._carrierStatusEl) {
                this._carrierStatusEl.textContent = "All " + ids.size + " enterprise records are fresh — nothing to sync."
            }
            return
        }

        if (!this.enterpriseMetaScraper) {
            this.enterpriseMetaScraper = new RouteAssistantEnterpriseMetaScraper(this.server, {
                maxAgeDays: cfg.enterpriseMetaMaxAgeDays
            })
        }

        this._enterpriseMetaScrapeRunning = true
        this._renderSettings()

        try {
            await this.enterpriseMetaScraper.bulkScrape(todo, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    if (this._carrierStatusEl) {
                        this._carrierStatusEl.textContent =
                            "Syncing enterprise data: " + done + "/" + total + "…"
                    }
                }
            })
        } catch (e) {
            console.warn("[AES enterpriseMeta] bulk scrape failed", e)
        }

        this._enterpriseMetaScrapeRunning = false
        this.settings.carriers.lastEnterpriseMetaSyncAt = Date.now()
        await RouteAssistantSettings.save({carriers: this.settings.carriers})

        await this._applyCachedEnterpriseMeta()
        this._render()
    }

    // ---------- Market Analysis (Tier 2a — markets-page scraper) ----------

    /**
     * Bulk-load the per-route markets cache (4 split families) and project
     * derived fields onto each row: market share %, competitor count, median
     * competitor Y price, our pricing-drift flag.
     */
    async _applyCachedMarkets() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const cfg = (this.settings && this.settings.marketAnalysis) || {}
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cache = await RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {
            maxAge: {
                competitors: cfg.competitorMaxAgeDays,
                marketShare: cfg.shareMaxAgeDays,
                historic:    cfg.historicMaxAgeDays
            }
        })
        let ourName = ""
        try { ourName = (typeof AES !== "undefined" && AES.getAirlineIdentity) ? AES.getAirlineIdentity() : "" }
        catch (e) { ourName = "" }
        const ourNameLow = (ourName || "").toLowerCase().trim()

        // Our enterprise ID(s) — harvested from the navbar's "Switch
        // Enterprise" dropdown links (`<a href="../enterprise/dashboard?select=<ID>">`).
        // The leaderboard rows on the markets page link enterprise pages by
        // numeric ID, so an ID-match is rock-solid where a name match is
        // fragile (extra spaces, periods, "Airways" suffix variants).
        // Multi-enterprise users (e.g. FLY NYON. + NYON.) collect all IDs.
        const ourEnterpriseIds = new Set()
        try {
            for (const a of document.querySelectorAll(".as-navbar-main a[href*='dashboard?select=']")) {
                const m = /select=(\d+)/.exec(a.getAttribute("href") || "")
                if (m) ourEnterpriseIds.add(parseInt(m[1], 10))
            }
        } catch (e) { /* ignore */ }

        for (const r of this.rows) {
            const key = RouteAssistantMarketsPageScraper._pairKey(this.hubIata, r.destIata)
            const bucket = cache.get(key)
            if (!bucket) continue
            r.marketsScrapedAt = (bucket.competitors && bucket.competitors.scrapedAt)
                || (bucket.marketShare && bucket.marketShare.scrapedAt)
                || null

            if (bucket.marketShare) {
                r.marketSharePeriod = bucket.marketShare.period || null
                r.marketSharePax    = (bucket.marketShare.pax   || []).map(e => Object.assign({}, e))
                r.marketShareCargo  = (bucket.marketShare.cargo || []).map(e => Object.assign({}, e))

                // Match "us" in pax leaderboard: enterprise ID first
                // (rock-solid), then airline name (fragile).
                let ourPaxShare = null
                for (const e of r.marketSharePax) {
                    if (e.enterpriseId != null && ourEnterpriseIds.has(e.enterpriseId)) {
                        ourPaxShare = e.sharePct
                        break
                    }
                }
                if (ourPaxShare == null && ourNameLow) {
                    for (const e of r.marketSharePax) {
                        if (e.name && e.name.toLowerCase().trim() === ourNameLow) {
                            ourPaxShare = e.sharePct
                            break
                        }
                    }
                }
                r.ourPaxShare = ourPaxShare

                // Competitor count: distinct enterprises across BOTH pax
                // and cargo leaderboards, excluding ours. A pax-only
                // count missed any cargo-only operators on mixed
                // routes, which is the primary cause of "Cmp count
                // doesn't match the list" reports.
                const ids = new Set()
                const merged = new Map()  // key → {enterpriseId|name, name, paxShare, cargoShare, paxRank, cargoRank, paxChange, cargoChange}
                const addEntry = (e, kind) => {
                    if (!e) return
                    const isOurs = (e.enterpriseId != null && ourEnterpriseIds.has(e.enterpriseId))
                        || (e.name && e.name.toLowerCase().trim() === ourNameLow)
                    if (isOurs) return
                    const key = e.enterpriseId != null ? "id:" + e.enterpriseId : "name:" + (e.name || "").toLowerCase().trim()
                    if (!key || key === "name:") return
                    ids.add(key)
                    let slot = merged.get(key)
                    if (!slot) {
                        slot = {
                            enterpriseId: e.enterpriseId != null ? e.enterpriseId : null,
                            name:         e.name || null,
                            paxShare:     null,
                            cargoShare:   null,
                            paxRank:      null,
                            cargoRank:    null,
                            paxChange:    null,
                            cargoChange:  null
                        }
                        merged.set(key, slot)
                    }
                    if (e.name && !slot.name) slot.name = e.name
                    if (kind === "pax") {
                        slot.paxShare  = e.sharePct
                        slot.paxRank   = e.rank
                        slot.paxChange = e.change
                    } else {
                        slot.cargoShare  = e.sharePct
                        slot.cargoRank   = e.rank
                        slot.cargoChange = e.change
                    }
                }
                for (const e of (r.marketSharePax   || [])) addEntry(e, "pax")
                for (const e of (r.marketShareCargo || [])) addEntry(e, "cargo")
                r.competitorCount   = ids.size || null
                r.competitorEntries = Array.from(merged.values())
            }

            if (bucket.ownPricing) {
                r.ownPricing       = bucket.ownPricing.prices   || null
                r.ownPriceDefaults = bucket.ownPricing.defaults || null
                // Project AS's general settings for the route (service
                // profile + terminals + boarding/cargo prefs) onto the
                // row so the Service tooltip + popover surface what AS
                // currently has assigned.
                const gs = bucket.ownPricing.generalSettings || null
                if (gs) {
                    r.serviceProfileId    = (typeof gs.serviceProfileId === "number") ? gs.serviceProfileId : null
                    r.serviceProfileName  = gs.serviceProfile || null
                    r.originTerminal      = gs.originTerminal || null
                    r.destinationTerminal = gs.destinationTerminal || null
                    r.boardingPreference  = gs.boardingPreference || null
                    r.cargoPreference     = gs.cargoPreference || null
                }
                if (r.ownPricing && r.ownPriceDefaults) {
                    let drift = false
                    for (const cls of ["Y", "C", "F", "Cargo"]) {
                        if (r.ownPricing[cls] != null && r.ownPriceDefaults[cls] != null
                            && r.ownPricing[cls] !== r.ownPriceDefaults[cls]) {
                            drift = true; break
                        }
                    }
                    r.pricingDrift = drift ? "drift" : "default"
                }
            }

            if (bucket.competitors) {
                const all = bucket.competitors.competitors || []
                const competitorYs = []
                for (const c of all) {
                    if (c.isOurs) continue
                    if (c.serviceClass === "Y" && typeof c.price === "number" && c.price > 0) {
                        competitorYs.push(c.price)
                    }
                }
                if (competitorYs.length) {
                    competitorYs.sort((a, b) => a - b)
                    const mid = Math.floor(competitorYs.length / 2)
                    r.competitorMedianPriceY = competitorYs.length % 2
                        ? competitorYs[mid]
                        : Math.round((competitorYs[mid - 1] + competitorYs[mid]) / 2)
                } else {
                    r.competitorMedianPriceY = null
                }
            }

            if (bucket.historic) {
                r.historicPeriods    = bucket.historic.periods
                r.historicCapacities = bucket.historic.capacities
                r.historicPrices     = bucket.historic.prices
            }
        }
    }

    /**
     * Settings-drawer block for the markets-page scraper. Mirrors the
     * Live route data expander pattern: status line + show-cols toggle +
     * Sync CTA + lastBulkScrapeAt.
     */
    _renderMarketAnalysisSection() {
        const cfg = this.settings.marketAnalysis = Object.assign(
            {showColumns: true, concurrency: 4, staggerMs: 800, lastBulkScrapeAt: null,
             competitorMaxAgeDays: null, shareMaxAgeDays: 7, historicMaxAgeDays: null,
             defaultPayloadChart: "ECONOMY"},
            this.settings.marketAnalysis || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(20, 184, 166, 0.08);border:1px solid rgba(20, 184, 166, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#5eead4;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>Market Analysis</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Per-route competitor flights, "
            + "your pricing snapshot, market-share leaderboard, and 25-week capacity/price charts "
            + "from /app/com/markets/&lt;HUB&gt;&lt;DEST&gt;.</span>"
        wrap.append(header)

        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r =>
            r.ourPaxShare != null || r.competitorCount != null || r.competitorMedianPriceY != null
        ).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Captured: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._marketStatusEl = status

        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#5eead4;"
        showLbl.append(showCb, document.createTextNode("Show market-analysis columns"))
        showCb.addEventListener("change", async () => {
            this.settings.marketAnalysis.showColumns = showCb.checked
            await RouteAssistantSettings.save({marketAnalysis: this.settings.marketAnalysis})
            this._render()
        })
        ctrlRow.append(showLbl)

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._marketScrapeRunning
            ? "Syncing markets…"
            : "Sync market analysis for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#0d9488"
        scanBtn.disabled = !!this._marketScrapeRunning || !this.hubIata || !(this.rows && this.rows.length)
        scanBtn.addEventListener("click", () => this._runBulkMarketScrape())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Storage is split across 4 keys per route "
            + "(<code>competitors</code> / <code>ownPricing</code> / <code>marketShare</code> / "
            + "<code>historic</code>) so each can have its own freshness window. "
            + "Visiting /app/com/markets/&lt;HUB&gt;&lt;DEST&gt; in your browser also live-captures."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Bulk-scrape markets pages for every (hub, dest) pair in this.rows.
     * Mirrors `_runBulkPriceScrape` — same concurrency/stagger pattern,
     * same `lastBulkScrapeAt` persistence, same re-load + re-render.
     */
    async _runBulkMarketScrape() {
        if (this._marketScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.marketAnalysis || {}
        const concurrency = cfg.concurrency || 4
        const staggerMs   = cfg.staggerMs   || 800

        if (!this.marketsScraper) {
            this.marketsScraper = new RouteAssistantMarketsPageScraper(this.server, {})
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._marketScrapeRunning = true
        this._renderSettings()

        try {
            await this.marketsScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                onProgress:  (done, total) => {
                    if (this._marketStatusEl) {
                        this._marketStatusEl.textContent =
                            "Syncing market analysis: " + done + "/" + total + "…"
                    }
                }
            })
        } catch (e) {
            console.warn("[AES marketsScraper] bulk scrape failed", e)
        }

        this._marketScrapeRunning = false
        this.settings.marketAnalysis.lastBulkScrapeAt = Date.now()
        await RouteAssistantSettings.save({marketAnalysis: this.settings.marketAnalysis})

        await this._applyCachedMarkets()
        // Newly-cached ownPricing feeds the per-class yield resolution in the
        // service projection — re-apply so the Service columns reflect the
        // scraped fares without waiting for the next refresh.
        this._reapplyServiceProjection()
        this._render()
    }

    // ---------- ORS Rank (Tier 2b — Online Reservation System scraper) ----------

    /**
     * Bulk-load the per-route ORS cache and project the user-selected
     * primary metric (default `ratingGapToTop`) plus all rank flavors onto
     * each row. The full `connections` array is also attached so the
     * drill-in drawer can render it without re-scraping.
     */
    async _applyCachedOrs() {
        if (!this.rows || !this.rows.length || !this.hubIata) return
        const cfg = (this.settings && this.settings.ors) || {}
        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        const cache = await RouteAssistantOrsScraper.bulkLoadCache(pairs, {
            maxAgeDays: cfg.rankMaxAgeDays
        })
        for (const r of this.rows) {
            const key = RouteAssistantOrsScraper._pairKey(this.hubIata, r.destIata)
            const rec = cache.get(key)
            if (!rec) continue
            r.orsRecord = rec
            r.orsScrapedAt = rec.scrapedAt
            r.orsParams = rec.params
            r.orsTotalConnections = rec.totalConnections
            r.orsRankAny           = rec.rankAny
            r.orsRankFirstLegOurs  = rec.rankFirstLegOurs
            r.orsRankAllOurs       = rec.rankAllOurs
            r.orsRankNonstop       = rec.rankNonstop
            r.orsRankBookable      = rec.rankBookable
            r.orsOurTopRating      = rec.ourTopRating
            r.orsOurBestNonstopRating = rec.ourBestNonstopRating
            r.orsTopCompetitorRating = rec.topCompetitorRating
            r.orsRatingGapToTop    = rec.ratingGapToTop
            r.orsConnections       = rec.connections
            r.orsOurFlightIds      = rec.ourFlightIds
            r.orsOurCarrierPrefixes = rec.ourCarrierPrefixes

            // Apply min-rating display threshold (display-only filter).
            const minRating = cfg.minRatingThresholdDisplay
            if (minRating != null && r.orsOurTopRating != null && r.orsOurTopRating < minRating) {
                r.orsHiddenByThreshold = true
            } else {
                r.orsHiddenByThreshold = false
            }

            // Resolve the primary value the panel shows in the headline column.
            r.orsPrimaryValue = RouteAssistantPanel._resolveOrsPrimary(rec, cfg.primaryColumn)
        }
        // Stash circuit-breaker timestamp + cooldown for the expander UI.
        RouteAssistantPanel._orsCircuitTrippedAt = cfg.circuitBreakerTrippedAt || null
        RouteAssistantPanel._orsCircuitCooldown  = cfg.circuitBreakerCooldownMs || 600000
        RouteAssistantPanel._orsPrimaryColumn    = cfg.primaryColumn || "ratingGapToTop"
    }

    /**
     * Settings-drawer block for the ORS scraper. Per the user's "MAXIMISE
     * OPTIONS" direction, every form parameter + every rank flavor is
     * exposed here. Filtering happens at render time so toggling settings
     * never requires a re-scrape.
     */
    _renderOrsRankSection() {
        const cfg = this.settings.ors = Object.assign(
            {showColumns: true, concurrency: 2, staggerMs: 1500, lastBulkScrapeAt: null,
             rankMaxAgeDays: null,
             defaultPayload: "ECONOMY", defaultDepartureH: 0, defaultArrivalH: 72,
             defaultUseGround: true,
             primaryColumn: "ratingGapToTop",
             showRankAnyColumn: true, showRankNonstopColumn: true,
             showRatingGapColumn: true, showCompetitorCountColumn: true,
             minRatingThresholdDisplay: null,
             airlineCarrierPrefixOverride: null,
             circuitBreakerTrippedAt: null, circuitBreakerCooldownMs: 600000},
            this.settings.ors || {}
        )

        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:10px;padding:6px 8px;"
            + "background:rgba(245, 158, 11, 0.08);border:1px solid rgba(245, 158, 11, 0.30);"
            + "border-radius:4px;"

        const header = document.createElement("div")
        header.style.cssText = "color:#fcd34d;font-size:11px;margin-bottom:4px;"
        header.innerHTML = "<strong>ORS Rank</strong> "
            + "<span style='color:#9ca3af;font-weight:normal;'>— Submits the AS Online Reservation "
            + "System form for each route and walks every result page to compute your true rank "
            + "vs. competitors. The full connection list is cached so you can drill into any row "
            + "without re-scraping.</span>"
        wrap.append(header)

        // Circuit-breaker banner.
        const cooldownMs = cfg.circuitBreakerCooldownMs || 600000
        const trippedAt  = cfg.circuitBreakerTrippedAt
        const tripped    = trippedAt && (Date.now() - trippedAt < cooldownMs)
        if (tripped) {
            const remainMin = Math.ceil((cooldownMs - (Date.now() - trippedAt)) / 60000)
            const banner = document.createElement("div")
            banner.style.cssText = "color:#fca5a5;background:rgba(239,68,68,0.10);"
                + "border:1px solid rgba(239,68,68,0.40);border-radius:3px;"
                + "padding:4px 6px;font-size:10px;margin-bottom:6px;"
            banner.textContent = "⚠ Rate-limit circuit breaker tripped — bulk sync disabled for "
                + remainMin + " more minute" + (remainMin === 1 ? "" : "s") + "."
            wrap.append(banner)
        }

        // Status line.
        const status = document.createElement("div")
        status.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:6px;"
        const totalRows = (this.rows || []).length
        const dataRows  = (this.rows || []).filter(r => r.orsRankAny != null).length
        const lastScrape = cfg.lastBulkScrapeAt
            ? new Date(cfg.lastBulkScrapeAt).toLocaleString()
            : "never"
        status.textContent = "Captured: " + dataRows + "/" + totalRows
            + " routes · last bulk sync: " + lastScrape
        wrap.append(status)
        this._orsStatusEl = status

        // ----- Param controls row 1 — payload, window combo, ground -----
        const paramRow = document.createElement("div")
        paramRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:11px;margin-bottom:4px;"

        const payloadSel = mkSelect([
            {value: "ECONOMY",  label: "Y (Economy)"},
            {value: "BUSINESS", label: "C (Business)"},
            {value: "FIRST",    label: "F (First)"},
            {value: "CARGO",    label: "Cargo"}
        ])
        payloadSel.value = cfg.defaultPayload
        payloadSel.style.fontSize = "11px"
        payloadSel.addEventListener("change", async () => {
            this.settings.ors.defaultPayload = payloadSel.value
            await RouteAssistantSettings.save({ors: this.settings.ors})
        })
        const payloadLbl = document.createElement("label")
        payloadLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        payloadLbl.append(document.createTextNode("Payload:"), payloadSel)
        paramRow.append(payloadLbl)

        const windowSel = mkSelect([
            {value: "tight",    label: "Tight (0–24h)"},
            {value: "standard", label: "Standard (0–48h)"},
            {value: "wide",     label: "Wide (0–72h)"}
        ])
        windowSel.style.fontSize = "11px"
        const currentWindow = (cfg.defaultDepartureH === 0 && cfg.defaultArrivalH === 24) ? "tight"
                            : (cfg.defaultDepartureH === 0 && cfg.defaultArrivalH === 48) ? "standard"
                            : "wide"
        windowSel.value = currentWindow
        windowSel.addEventListener("change", async () => {
            const v = windowSel.value
            if (v === "tight")    { this.settings.ors.defaultDepartureH = 0; this.settings.ors.defaultArrivalH = 24 }
            else if (v === "standard") { this.settings.ors.defaultDepartureH = 0; this.settings.ors.defaultArrivalH = 48 }
            else                  { this.settings.ors.defaultDepartureH = 0; this.settings.ors.defaultArrivalH = 72 }
            await RouteAssistantSettings.save({ors: this.settings.ors})
        })
        const windowLbl = document.createElement("label")
        windowLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        windowLbl.append(document.createTextNode("Window:"), windowSel)
        paramRow.append(windowLbl)

        const groundCb = mkInput("checkbox", null)
        groundCb.checked = cfg.defaultUseGround !== false
        const groundLbl = document.createElement("label")
        groundLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#9ca3af;"
        groundLbl.append(groundCb, document.createTextNode("Use ground network"))
        groundCb.addEventListener("change", async () => {
            this.settings.ors.defaultUseGround = groundCb.checked
            await RouteAssistantSettings.save({ors: this.settings.ors})
        })
        paramRow.append(groundLbl)

        wrap.append(paramRow)

        // ----- Display controls row — primary col, per-col toggles, threshold, prefix override -----
        const displayRow = document.createElement("div")
        displayRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:11px;margin-bottom:4px;"

        const primarySel = mkSelect([
            {value: "ratingGapToTop",       label: "Rating gap (us − top competitor)"},
            {value: "rankAny",              label: "Rank — any leg ours"},
            {value: "rankFirstLegOurs",     label: "Rank — first leg ours"},
            {value: "rankAllOurs",          label: "Rank — all flight legs ours"},
            {value: "rankNonstop",          label: "Rank — own nonstop"},
            {value: "rankBookable",         label: "Rank — first own bookable"},
            {value: "ourTopRating",         label: "Our top rating"},
            {value: "ourBestNonstopRating", label: "Our best nonstop rating"}
        ])
        primarySel.value = cfg.primaryColumn
        primarySel.style.fontSize = "11px"
        primarySel.addEventListener("change", async () => {
            this.settings.ors.primaryColumn = primarySel.value
            await RouteAssistantSettings.save({ors: this.settings.ors})
            await this._applyCachedOrs()
            this._render()
        })
        const primaryLbl = document.createElement("label")
        primaryLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fcd34d;"
        primaryLbl.append(document.createTextNode("Primary column:"), primarySel)
        displayRow.append(primaryLbl)

        const showCb = mkInput("checkbox", null)
        showCb.checked = cfg.showColumns !== false
        const showLbl = document.createElement("label")
        showLbl.style.cssText = "display:flex;gap:4px;align-items:center;color:#fcd34d;"
        showLbl.append(showCb, document.createTextNode("Show ORS columns"))
        showCb.addEventListener("change", async () => {
            this.settings.ors.showColumns = showCb.checked
            await RouteAssistantSettings.save({ors: this.settings.ors})
            this._render()
        })
        displayRow.append(showLbl)

        wrap.append(displayRow)

        // ----- Per-column visibility row -----
        const colsRow = document.createElement("div")
        colsRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:10px;color:#9ca3af;margin-bottom:4px;"
        const mkColToggle = (label, settingsKey) => {
            const cb = mkInput("checkbox", null)
            cb.checked = cfg[settingsKey] !== false
            const lbl = document.createElement("label")
            lbl.style.cssText = "display:flex;gap:3px;align-items:center;"
            lbl.append(cb, document.createTextNode(label))
            cb.addEventListener("change", async () => {
                this.settings.ors[settingsKey] = cb.checked
                await RouteAssistantSettings.save({ors: this.settings.ors})
                this._render()
            })
            return lbl
        }
        colsRow.append(document.createTextNode("Show:"))
        colsRow.append(mkColToggle("Rank-any",       "showRankAnyColumn"))
        colsRow.append(mkColToggle("Rank-nonstop",   "showRankNonstopColumn"))
        colsRow.append(mkColToggle("Rating gap",     "showRatingGapColumn"))
        colsRow.append(mkColToggle("Competitor #",   "showCompetitorCountColumn"))
        wrap.append(colsRow)

        // ----- Override row — carrier prefix + display threshold -----
        const overrideRow = document.createElement("div")
        overrideRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;"
            + "font-size:10px;color:#9ca3af;margin-bottom:4px;"

        const prefixInput = document.createElement("input")
        prefixInput.type = "text"
        prefixInput.placeholder = "auto-detect (e.g., FGM,NYO)"
        prefixInput.value = cfg.airlineCarrierPrefixOverride || ""
        prefixInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;"
            + "border-radius:3px;padding:2px 6px;font-size:10px;width:140px;"
        prefixInput.addEventListener("change", async () => {
            const v = prefixInput.value.trim()
            this.settings.ors.airlineCarrierPrefixOverride = v || null
            await RouteAssistantSettings.save({ors: this.settings.ors})
        })
        const prefixLbl = document.createElement("label")
        prefixLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        prefixLbl.append(document.createTextNode("Carrier prefix:"), prefixInput)
        overrideRow.append(prefixLbl)

        const thInput = mkNumberInput(cfg.minRatingThresholdDisplay, {min: 0, max: 100, step: 1, width: "55px"})
        thInput.addEventListener("change", async () => {
            const v = numOrNull(thInput.value)
            this.settings.ors.minRatingThresholdDisplay = v
            await RouteAssistantSettings.save({ors: this.settings.ors})
            await this._applyCachedOrs()
            this._render()
        })
        const thLbl = document.createElement("label")
        thLbl.style.cssText = "display:flex;gap:4px;align-items:center;"
        thLbl.append(document.createTextNode("Hide rows below rating"), thInput)
        overrideRow.append(thLbl)

        wrap.append(overrideRow)

        // ----- Sync button -----
        const ctrlRow = document.createElement("div")
        ctrlRow.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px;"

        const scanBtn = document.createElement("button")
        scanBtn.textContent = this._orsScrapeRunning
            ? "Syncing ORS…"
            : "Sync ORS rank for all visible routes"
        Object.assign(scanBtn.style, smallBtnStyle())
        scanBtn.style.background = "#b45309"
        scanBtn.disabled = !!this._orsScrapeRunning || !this.hubIata
            || !(this.rows && this.rows.length) || tripped
        scanBtn.addEventListener("click", () => this._runBulkOrsScrape())
        ctrlRow.append(scanBtn)

        wrap.append(ctrlRow)

        const note = document.createElement("div")
        note.style.cssText = "color:#6b7280;font-size:10px;margin-top:6px;line-height:1.4;"
        note.innerHTML = "Pace: ~30 routes/min (concurrency 2, stagger 1.5s) — ORS runs an actual "
            + "routing solver per query. Per-route GET → POST handshake is required because "
            + "Wicket invalidates page-version IDs after one POST. Circuit breaker trips on 3× "
            + "consecutive 429/503 and disables this button for 10 minutes."
        wrap.append(note)

        this.settingsHost.append(wrap)
    }

    /**
     * Bulk-scrape ORS for every visible route. Mirrors `_runBulkPriceScrape`
     * but with circuit-breaker handling: persists `circuitBreakerTrippedAt`
     * on a halt and re-renders so the banner appears.
     */
    async _runBulkOrsScrape() {
        if (this._orsScrapeRunning || !this.hubIata || !this.rows || !this.rows.length) return
        const cfg = this.settings.ors || {}
        const concurrency = cfg.concurrency || 2
        const staggerMs   = cfg.staggerMs   || 1500

        if (!this.orsScraper) {
            this.orsScraper = new RouteAssistantOrsScraper(this.server, {
                maxAgeDays: cfg.rankMaxAgeDays,
                circuitBreakerCooldownMs: cfg.circuitBreakerCooldownMs
            })
        }

        const pairs = this.rows.map(r => ({hub: this.hubIata, dest: r.destIata}))
        this._orsScrapeRunning = true
        this._renderSettings()

        let halted = false, haltReason = null
        try {
            const result = await this.orsScraper.bulkScrape(pairs, {
                concurrency: concurrency,
                staggerMs:   staggerMs,
                scrapeParams: {
                    payload:    cfg.defaultPayload,
                    departureH: cfg.defaultDepartureH,
                    arrivalH:   cfg.defaultArrivalH,
                    useGround:  cfg.defaultUseGround,
                    carrierOverride: cfg.airlineCarrierPrefixOverride
                },
                onProgress:  (p) => {
                    if (this._orsStatusEl) {
                        let txt = "Syncing ORS rank: " + p.done + "/" + p.total + "…"
                        if (p.halted) txt = "⚠ Halted at " + p.done + "/" + p.total + ": " + p.reason
                        this._orsStatusEl.textContent = txt
                    }
                }
            })
            halted = result && result.halted
            haltReason = result && result.reason
        } catch (e) {
            console.warn("[AES orsScraper] bulk scrape failed", e)
        }

        this._orsScrapeRunning = false
        this.settings.ors.lastBulkScrapeAt = Date.now()
        if (halted) {
            this.settings.ors.circuitBreakerTrippedAt = Date.now()
            console.warn("[AES orsScraper] circuit breaker tripped: " + haltReason)
        }
        await RouteAssistantSettings.save({ors: this.settings.ors})

        await this._applyCachedOrs()
        this._render()
    }

    /**
     * Open a modal showing the cached ORS connection list for one route.
     * Lazy-rendered from cache only — never re-scrapes. Each connection row
     * shows its rank, rating, total price, total duration, and per-leg details.
     */
    _openOrsConnectionsDrawer(row) {
        if (!row || !row.orsConnections || !row.orsConnections.length) return
        if (this._orsDrawer && this._orsDrawer.parentNode) {
            this._orsDrawer.parentNode.removeChild(this._orsDrawer)
        }

        const overlay = document.createElement("div")
        Object.assign(overlay.style, {
            position: "fixed", inset: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center"
        })
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._orsDrawer = null
        }
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        Object.assign(card.style, {
            background: "#1f2937", color: "#f3f4f6",
            border: "1px solid #b45309", borderRadius: "6px",
            padding: "16px 18px", minWidth: "640px", maxWidth: "880px",
            maxHeight: "82vh", overflowY: "auto",
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
            font: "12px/1.5 sans-serif"
        })
        const title = document.createElement("strong")
        title.textContent = "ORS connections · " + this.hubIata + " → " + row.destIata
        title.style.cssText = "color:#fcd34d;display:block;margin-bottom:6px;font-size:14px;"
        card.append(title)

        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
        const params = row.orsParams || {}
        sub.textContent = "Total connections: " + row.orsTotalConnections
            + " · Payload: " + (params.payload || "—")
            + " · Window: " + (params.departureH != null ? params.departureH : "—") + "h–"
                + (params.arrivalH != null ? params.arrivalH : "—") + "h"
            + " · Ground: " + (params.useGround ? "on" : "off")
            + " · Scraped: " + (row.orsScrapedAt ? new Date(row.orsScrapedAt).toLocaleString() : "—")
        card.append(sub)

        const summary = document.createElement("div")
        summary.style.cssText = "color:#fcd34d;font-size:11px;margin-bottom:10px;"
            + "background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.30);"
            + "border-radius:3px;padding:6px 8px;"
        summary.innerHTML = "<strong>Rank flavors:</strong> "
            + "any=" + (row.orsRankAny != null ? row.orsRankAny : "—") + " · "
            + "first-leg-ours=" + (row.orsRankFirstLegOurs != null ? row.orsRankFirstLegOurs : "—") + " · "
            + "all-ours=" + (row.orsRankAllOurs != null ? row.orsRankAllOurs : "—") + " · "
            + "nonstop=" + (row.orsRankNonstop != null ? row.orsRankNonstop : "—") + " · "
            + "bookable=" + (row.orsRankBookable != null ? row.orsRankBookable : "—") + "<br>"
            + "<strong>Ratings:</strong> ours=" + (row.orsOurTopRating != null ? row.orsOurTopRating : "—")
            + " (best nonstop=" + (row.orsOurBestNonstopRating != null ? row.orsOurBestNonstopRating : "—") + ")"
            + " · top competitor=" + (row.orsTopCompetitorRating != null ? row.orsTopCompetitorRating : "—")
            + " · gap=" + (row.orsRatingGapToTop != null
                ? (row.orsRatingGapToTop > 0 ? "+" + row.orsRatingGapToTop : row.orsRatingGapToTop)
                : "—")
        card.append(summary)

        const list = document.createElement("table")
        list.style.cssText = "width:100%;border-collapse:collapse;font-size:11px;"
        list.innerHTML = "<thead><tr style='color:#9ca3af;text-align:left;'>"
            + "<th style='padding:4px;'>#</th>"
            + "<th style='padding:4px;'>Rating</th>"
            + "<th style='padding:4px;'>Duration</th>"
            + "<th style='padding:4px;'>Price</th>"
            + "<th style='padding:4px;'>Status</th>"
            + "<th style='padding:4px;'>Legs</th>"
            + "</tr></thead>"
        const tbody = document.createElement("tbody")
        for (const conn of row.orsConnections) {
            const tr = document.createElement("tr")
            const ourLeg = (conn.legs || []).some(l => l.isOurs)
            tr.style.background = ourLeg ? "rgba(245,158,11,0.08)" : "transparent"
            tr.style.borderBottom = "1px solid #2a3444"
            const legSummary = (conn.legs || []).map(l => {
                if (l.isGround) return "<span style='color:#6b7280;'>↪ ground</span>"
                const code = l.flightCode ? l.flightCode : "?"
                const fmt = l.isOurs
                    ? "<strong style='color:#fcd34d;'>" + escapeHtml(code) + "</strong>"
                    : escapeHtml(code)
                const rating = l.rating != null ? " r" + l.rating : ""
                const cls = l.serviceClass ? " (" + l.serviceClass + ")" : ""
                return fmt + rating + cls
            }).join(" → ")
            tr.innerHTML = "<td style='padding:4px;color:#9ca3af;'>" + (conn.idx + 1) + "</td>"
                + "<td style='padding:4px;font-weight:bold;color:#fcd34d;'>"
                    + (conn.rating != null ? conn.rating : "—") + "</td>"
                + "<td style='padding:4px;font-family:monospace;'>" + (conn.totalDuration || "—") + "</td>"
                + "<td style='padding:4px;'>" + (conn.totalPrice != null ? conn.totalPrice + " AS$" : "—") + "</td>"
                + "<td style='padding:4px;color:" + (conn.bookable ? "#86efac" : "#fca5a5") + ";'>"
                    + (conn.bookable ? "bookable" : "fully booked") + "</td>"
                + "<td style='padding:4px;'>" + legSummary + "</td>"
            tbody.append(tr)
        }
        list.append(tbody)
        card.append(list)

        const closeBtn = document.createElement("button")
        closeBtn.textContent = "Close"
        Object.assign(closeBtn.style, smallBtnStyle())
        closeBtn.style.marginTop = "12px"
        closeBtn.style.background = "#475569"
        closeBtn.addEventListener("click", close)
        card.append(closeBtn)

        overlay.append(card)
        document.body.append(overlay)
        this._orsDrawer = overlay
    }

    // ---------- Per-type fuel-burn table (letter A) ----------

    /**
     * Render a compact table inside the settings drawer listing each fleet
     * type's current cycle_L and per_km_L. Source is shown ("override" vs
     * "heuristic") and each row has an Edit link for manual override.
     */
    _renderFuelBurnTable() {
        const slots = RouteAssistantFleetStore.activeTypeSlots(this.fleet) || []
        if (!slots.length) return
        const wrap = document.createElement("div")
        wrap.style.cssText = "margin-top:6px;padding:6px 8px;background:#0b1220;border:1px solid #1f2a3a;border-radius:4px;"
        const head = document.createElement("div")
        head.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:4px;"
        head.textContent = "Per-type fuel burn (cycle_L + per_km_L × dist) — heuristic from spec; override with values from AS Performance Check."
        wrap.append(head)

        const table = document.createElement("table")
        table.style.cssText = "width:100%;font-size:10px;border-collapse:collapse;"
        table.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;">Type</th>
            <th style="text-align:right;padding:2px 4px;">cycle_L</th>
            <th style="text-align:right;padding:2px 4px;">per_km_L</th>
            <th style="text-align:left;padding:2px 4px;">Source</th>
            <th></th>
        </tr></thead>`
        const tbody = document.createElement("tbody")
        for (const slot of slots) {
            const spec = this.typeSpecs.get(slot.typeId)
            if (!spec) continue
            const burn = RouteAssistantFuelBurn.estimate(
                Object.assign({typeId: slot.typeId}, spec),
                this.fuelBurnOverrides
            )
            const tr = document.createElement("tr")
            const td = (text, align) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:2px 4px;text-align:" + (align || "left") + ";color:#d1d5db;"
                c.textContent = text
                return c
            }
            tr.append(td(slot.typeName + " ×" + slot.count, "left"))
            if (burn) {
                tr.append(td(Math.round(burn.cycleL), "right"))
                tr.append(td(burn.perKmL.toFixed(2), "right"))
                const srcCell = td(burn.source, "left")
                srcCell.style.color = burn.source === "override" ? "#a78bfa" : "#9ca3af"
                tr.append(srcCell)
            } else {
                tr.append(td("—", "right"))
                tr.append(td("—", "right"))
                tr.append(td("no spec", "left"))
            }
            const editTd = document.createElement("td")
            editTd.style.cssText = "padding:2px 4px;text-align:right;"
            const editBtn = document.createElement("button")
            editBtn.textContent = burn && burn.source === "override" ? "Edit" : "Override"
            Object.assign(editBtn.style, smallBtnStyle())
            editBtn.style.background = "#475569"
            editBtn.style.fontSize = "9px"
            editBtn.style.padding = "1px 5px"
            editBtn.disabled = !spec
            editBtn.addEventListener("click", () => this._openFuelBurnEditor(slot, spec, burn))
            editTd.append(editBtn)
            tr.append(editTd)
            tbody.append(tr)
        }
        table.append(tbody)
        wrap.append(table)
        this.settingsHost.append(wrap)
    }

    /**
     * Modal to set/clear per-type fuel-burn override. Same pattern as the
     * per-route override editor: show current values (override or heuristic),
     * Save / Clear / Cancel buttons.
     */
    _openFuelBurnEditor(slot, spec, currentBurn) {
        if (!slot || slot.typeId == null) return
        if (this._fuelBurnEditor && this._fuelBurnEditor.parentNode) {
            this._fuelBurnEditor.parentNode.removeChild(this._fuelBurnEditor)
        }

        const overlay = document.createElement("div")
        Object.assign(overlay.style, {
            position: "fixed", inset: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center"
        })
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._fuelBurnEditor = null
        }
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        Object.assign(card.style, {
            background: "#1f2937", color: "#f3f4f6",
            border: "1px solid #4c1d95", borderRadius: "6px",
            padding: "16px 18px", minWidth: "380px", maxWidth: "460px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
            font: "12px/1.5 sans-serif"
        })
        const title = document.createElement("strong")
        title.textContent = "Fuel burn · " + (slot.typeName || "type " + slot.typeId)
        title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:13px;"
        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
        sub.textContent = "Run Performance Check on AS for this type at two distances (e.g. 500 km and 2,000 km) to derive these constants. Empty = use heuristic."

        const cycleInput = mkNumberInput(currentBurn ? currentBurn.cycleL : null, {min: 0, max: 100000, step: 1, width: "80px"})
        const perKmInput = mkNumberInput(currentBurn ? Math.round(currentBurn.perKmL * 1000) / 1000 : null, {min: 0, max: 100, step: 0.01, width: "80px"})

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:12px;"
        const addRow = (label, input, hint) => {
            const lab = document.createElement("label")
            lab.textContent = label
            lab.style.cssText = "color:#9ca3af;font-size:11px;"
            grid.append(lab)
            const wrap = document.createElement("div")
            wrap.append(input)
            const h = document.createElement("span")
            h.textContent = " " + hint
            h.style.cssText = "color:#6b7280;font-size:10px;"
            wrap.append(h)
            grid.append(wrap)
        }
        addRow("cycle_L",  cycleInput, "litres per cycle (taxi+TO+approach+land)")
        addRow("per_km_L", perKmInput, "litres per km of round-trip distance")

        const heur = RouteAssistantFuelBurn.heuristic(Object.assign({typeId: slot.typeId}, spec))
        const heurLine = document.createElement("div")
        heurLine.style.cssText = "color:#6b7280;font-size:10px;margin-bottom:8px;"
        heurLine.textContent = heur
            ? `Heuristic suggests cycle=${Math.round(heur.cycleL)} L, per_km=${heur.perKmL.toFixed(2)} L (from ${spec && spec.seats ? spec.seats : "?"} seats × ${spec && spec.speed ? spec.speed : "?"} km/h).`
            : "Heuristic unavailable (spec missing seats/cargo)."

        const buttonRow = document.createElement("div")
        buttonRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;"

        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.addEventListener("click", close)

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear override"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.disabled = !(currentBurn && currentBurn.source === "override")
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            await RouteAssistantFuelBurn.removeOverride(slot.typeId)
            this.fuelBurnOverrides.delete(slot.typeId)
            this.fuelBurnOverrides.delete(String(slot.typeId))
            this._recomputeProfit()
            this._renderSettings()
            close()
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.addEventListener("click", async () => {
            const fields = {
                cycleL: numOrNull(cycleInput.value),
                perKmL: numOrNull(perKmInput.value)
            }
            const saved = await RouteAssistantFuelBurn.saveOverride(slot.typeId, fields)
            if (saved) {
                this.fuelBurnOverrides.set(slot.typeId, saved)
                this.fuelBurnOverrides.set(String(slot.typeId), saved)
            } else {
                this.fuelBurnOverrides.delete(slot.typeId)
                this.fuelBurnOverrides.delete(String(slot.typeId))
            }
            this._recomputeProfit()
            this._renderSettings()
            close()
        })

        buttonRow.append(cancelBtn, clearBtn, saveBtn)
        card.append(title, sub, grid, heurLine, buttonRow)
        overlay.append(card)
        document.body.append(overlay)
        this._fuelBurnEditor = overlay
        cycleInput.focus()
    }

    // ---------- Per-route override editor ----------

    /**
     * Inline quick-edit popover anchored to the $/flt cell's ▾ caret. Lets
     * the user tweak yield / LF for one route without opening the full
     * modal. Saves to RouteAssistantRouteOverridesStore on click; outside
     * click or Escape closes without saving. The full modal stays available
     * via the "Edit…" button at the bottom.
     */
    _openProfitModifierPopover(row, anchorEl) {
        if (!row || !this.hubIata) return
        this._closeProfitPopover()

        const hubU    = String(this.hubIata).toUpperCase()
        const destU   = String(row.destIata).toUpperCase()
        const pairKey = hubU + "-" + destU
        const econ    = (this.settings && this.settings.economics) || {}
        const existing = row.override || {}

        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:   "fixed",
            background: "#1f2937",
            color:      "#f3f4f6",
            border:     "1px solid #4c1d95",
            borderRadius: "5px",
            boxShadow:  "0 8px 25px rgba(0,0,0,0.55)",
            padding:    "10px 12px",
            zIndex:     "10002",
            minWidth:   "240px",
            font:       "11px/1.5 sans-serif"
        })

        const title = document.createElement("strong")
        title.textContent = `Modify · ${hubU} → ${destU}`
        title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:12px;"

        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;line-height:1.45;"
        const baseYield = existing.yieldPerKm != null ? existing.yieldPerKm
                        : (econ.yieldPerKm != null ? econ.yieldPerKm : 0.10)
        const baseCYld  = existing.cargoYieldPerKgKm != null ? existing.cargoYieldPerKgKm
                        : (econ.cargoYieldPerKgKm != null ? econ.cargoYieldPerKgKm : 0)
        sub.innerHTML = "Quick-edit ticket-price + LF for this route. Empty = inherit base economics.<br>"
            + "<span style='color:#6b7280;'>Effective ticket ≈ yield × distance (one-way).</span>"

        const yieldInput  = mkNumberInput(numOrNull(existing.yieldPerKm),        {min: 0, max: 10,  step: 0.01,   width: "80px"})
        const paxLfInput  = mkNumberInput(numOrNull(existing.paxLF),             {min: 0, max: 1,   step: 0.05,   width: "80px"})
        const cyldInput   = mkNumberInput(numOrNull(existing.cargoYieldPerKgKm), {min: 0, max: 1,   step: 0.0001, width: "80px"})
        const cLfInput    = mkNumberInput(numOrNull(existing.cargoLF),           {min: 0, max: 1,   step: 0.05,   width: "80px"})

        // Live preview of the effective one-way ticket price as the user
        // types. Distance × yield is the simplest read of "what will an
        // average pax pay" — Y/C/F per-class fares come with Tier 2.
        const previewLine = document.createElement("div")
        previewLine.style.cssText = "color:#cbd5e1;font-size:10px;margin-bottom:6px;font-style:italic;"
        const dist = row.distanceKm
        const updatePreview = () => {
            const y = parseFloatOr(yieldInput.value, baseYield)
            if (!dist) { previewLine.textContent = ""; return }
            const oneWay = y * dist
            previewLine.textContent = "≈ AS$" + Math.round(oneWay).toLocaleString()
                + " one-way ticket  (yield × " + dist.toLocaleString() + " km)"
        }
        updatePreview()

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:center;margin-bottom:6px;"
        const addRow = (label, input) => {
            const lab = document.createElement("label")
            lab.textContent = label
            lab.style.cssText = "color:#9ca3af;"
            grid.append(lab, input)
        }
        addRow("Yield AS$/pax-km", yieldInput)
        addRow("Pax LF",           paxLfInput)
        addRow("Cargo AS$/kg-km",  cyldInput)
        addRow("Cargo LF",         cLfInput)

        for (const inp of [yieldInput, paxLfInput, cyldInput, cLfInput]) {
            inp.addEventListener("input", updatePreview)
        }

        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap;"

        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.style.fontSize = "10px"
        cancelBtn.style.padding = "2px 8px"
        cancelBtn.addEventListener("click", () => this._closeProfitPopover())

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.style.fontSize = "10px"
        clearBtn.style.padding = "2px 8px"
        clearBtn.disabled = !row.override
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            await RouteAssistantRouteOverridesStore.remove(hubU, destU)
            row.override = null
            this.overrideMap.delete(pairKey)
            this._recomputeProfit()
            this._closeProfitPopover()
        })

        const editBtn = document.createElement("button")
        editBtn.textContent = "Full editor…"
        Object.assign(editBtn.style, smallBtnStyle())
        editBtn.style.background = "#475569"
        editBtn.style.fontSize = "10px"
        editBtn.style.padding = "2px 8px"
        editBtn.title = "Open the full editor (adds note + Calibrate-from-actuals)"
        editBtn.addEventListener("click", () => {
            this._closeProfitPopover()
            this._openOverrideEditor(row)
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.style.padding = "2px 8px"
        saveBtn.addEventListener("click", async () => {
            const fields = {
                paxLF:             numOrNull(paxLfInput.value),
                cargoLF:           numOrNull(cLfInput.value),
                yieldPerKm:        numOrNull(yieldInput.value),
                cargoYieldPerKgKm: numOrNull(cyldInput.value),
                note:              existing.note || ""    // preserve any note set in full editor
            }
            const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
            row.override = saved
            if (saved) this.overrideMap.set(pairKey, saved)
            else       this.overrideMap.delete(pairKey)
            this._recomputeProfit()
            this._closeProfitPopover()
        })

        btnRow.append(cancelBtn, clearBtn, editBtn, saveBtn)
        pop.append(title, sub, grid, previewLine, btnRow)

        document.body.append(pop)
        this._profitPopover = pop

        // Position next to the caret. Prefer below; flip above when too
        // close to the bottom edge of the viewport.
        const r = anchorEl.getBoundingClientRect()
        const popRect = pop.getBoundingClientRect()
        const vh = window.innerHeight
        const vw = window.innerWidth
        let top = r.bottom + 6
        if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
        let left = r.right - popRect.width
        if (left < 8) left = 8
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
        pop.style.top  = top  + "px"
        pop.style.left = left + "px"

        yieldInput.focus()
        yieldInput.select && yieldInput.select()

        // Outside-click + Escape close. Schedule the listener on the next
        // tick so the click that opened us doesn't immediately dismiss it.
        const onMouseDown = (e) => {
            if (pop.contains(e.target)) return
            if (e.target === anchorEl) return
            this._closeProfitPopover()
        }
        const onKey = (e) => { if (e.key === "Escape") this._closeProfitPopover() }
        setTimeout(() => {
            document.addEventListener("mousedown", onMouseDown)
            document.addEventListener("keydown",   onKey)
        }, 0)
        this._profitPopoverCleanup = () => {
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("keydown",   onKey)
        }
    }

    _closeProfitPopover() {
        if (this._profitPopoverCleanup) {
            try { this._profitPopoverCleanup() } catch (e) { /* noop */ }
            this._profitPopoverCleanup = null
        }
        if (this._profitPopover && this._profitPopover.parentNode) {
            this._profitPopover.parentNode.removeChild(this._profitPopover)
        }
        this._profitPopover = null
    }

    /**
     * F slice 2 — rich popover for the Cmp pill. Renders each AS
     * competitor with banner + avatar + clickable enterprise link +
     * pax share % + change indicator, mirroring AS's Stations table.
     * Opens on hover (200ms delay), auto-closes on leave (250ms grace),
     * or click-pins so the user can interact with the links inside.
     * Returns null when no `marketSharePax` data — caller falls back
     * to the existing plain-text title="" tooltip.
     */
    _openCarrierPopover(row, anchorEl, opts) {
        opts = opts || {}
        if (!row || !anchorEl) return null
        // Prefer the merged pax+cargo entries computed in
        // `_applyCachedMarkets` so cargo-only competitors don't go
        // missing from the popover. Fall back to pax-only for older
        // cache rows that predate this merge.
        const fromMerged = Array.isArray(row.competitorEntries) ? row.competitorEntries.slice() : null
        const fromPaxOnly = Array.isArray(row.marketSharePax) ? row.marketSharePax.slice() : []
        const shares = (fromMerged && fromMerged.length) ? fromMerged : fromPaxOnly
        if (!shares.length) return null
        // Rank by max share across pax + cargo so dominant operators
        // float to the top regardless of which leaderboard they lead.
        shares.sort((a, b) => {
            const aMax = Math.max(a.paxShare || a.sharePct || 0, a.cargoShare || 0)
            const bMax = Math.max(b.paxShare || b.sharePct || 0, b.cargoShare || 0)
            return bMax - aMax
        })

        this._closeCarrierPopover()

        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:     "fixed",
            background:   "#1f2937",
            color:        "#f3f4f6",
            border:       "1px solid #15803d",
            borderRadius: "5px",
            boxShadow:    "0 8px 25px rgba(0,0,0,0.55)",
            padding:      "8px 10px",
            zIndex:       "10002",
            minWidth:     "320px",
            maxWidth:     "440px",
            maxHeight:    "70vh",
            overflowY:    "auto",
            font:         "11px/1.4 sans-serif"
        })

        const header = document.createElement("div")
        header.style.cssText = "color:#86efac;font-size:11px;margin-bottom:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;"
        const intensity = row.competitiveIntensity
            || (typeof RouteAssistantCarriersScraper !== "undefined"
                ? RouteAssistantCarriersScraper.intensity(shares.length)
                : null)
        const intensityColor = (typeof RouteAssistantCarriersScraper !== "undefined")
            ? RouteAssistantCarriersScraper.intensityColor(intensity)
            : "#9ca3af"
        const intensityPill = document.createElement("span")
        intensityPill.textContent = intensity ? intensity.toUpperCase() : "—"
        intensityPill.style.cssText = "padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;color:#0f172a;background:" + intensityColor + ";"
        const headTitle = document.createElement("strong")
        // Decompose the count: how many compete on pax, how many on
        // cargo. The bare total can be misleading on freight-heavy
        // routes where pax shares look small but cargo competition is
        // fierce (or vice versa).
        const paxN   = shares.filter(e => (e.paxShare   != null) || (e.sharePct != null && e.cargoShare == null)).length
        const cargoN = shares.filter(e => e.cargoShare != null).length
        let label = shares.length + " AS competitor" + (shares.length === 1 ? "" : "s")
        if (paxN && cargoN) label += " · " + paxN + " pax / " + cargoN + " cargo"
        else if (cargoN)    label += " · cargo only"
        else if (paxN)      label += " · pax only"
        headTitle.textContent = label
        const period = document.createElement("span")
        period.textContent = row.marketSharePeriod ? "· " + row.marketSharePeriod : ""
        period.style.cssText = "color:#9ca3af;font-weight:normal;"
        header.append(headTitle, intensityPill, period)
        pop.append(header)

        const list = document.createElement("div")
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;"
        for (const e of shares) list.append(this._buildCarrierRow(e))
        pop.append(list)

        const footer = document.createElement("div")
        footer.style.cssText = "color:#6b7280;font-size:10px;margin-top:8px;border-top:1px solid #374151;padding-top:6px;"
        const meta = (this.settings && this.settings.carriers) || {}
        const missingMeta = shares.some(e => e.enterpriseId != null && !e.bannerUrl && !e.avatarUrl)
        const lastSync = meta.lastEnterpriseMetaSyncAt
            ? new Date(meta.lastEnterpriseMetaSyncAt).toLocaleString()
            : null
        const lines = []
        if (lastSync) lines.push("Enterprise meta last synced: " + lastSync)
        if (missingMeta) {
            lines.push("Some banners/avatars missing — open Settings → Carriers → \"Sync enterprise data\".")
        }
        if (row.marketsScrapedAt) {
            lines.push("Market shares from " + new Date(row.marketsScrapedAt).toLocaleString())
        }
        if (!lines.length) lines.push("Click a name to open the enterprise page.")
        footer.innerHTML = lines.map(s => escapeHtml(s)).join("<br>")
        pop.append(footer)

        document.body.append(pop)
        this._carrierPopover = pop
        this._carrierPopoverPinned = !!opts.pinned

        this._positionCarrierPopover(anchorEl)

        const cancelClose = () => {
            if (this._carrierPopoverCloseTimer) {
                clearTimeout(this._carrierPopoverCloseTimer)
                this._carrierPopoverCloseTimer = null
            }
        }
        const scheduleClose = () => {
            if (this._carrierPopoverPinned) return
            cancelClose()
            this._carrierPopoverCloseTimer = setTimeout(() => this._closeCarrierPopover(), 250)
        }
        pop.addEventListener("mouseenter", cancelClose)
        pop.addEventListener("mouseleave", scheduleClose)
        anchorEl.addEventListener("mouseleave", scheduleClose)

        const onMouseDown = (e) => {
            if (!this._carrierPopoverPinned) return
            if (pop.contains(e.target)) return
            if (e.target === anchorEl) return
            this._closeCarrierPopover()
        }
        const onKey = (e) => { if (e.key === "Escape") this._closeCarrierPopover() }
        setTimeout(() => {
            document.addEventListener("mousedown", onMouseDown)
            document.addEventListener("keydown",   onKey)
        }, 0)

        this._carrierPopoverCleanup = () => {
            cancelClose()
            anchorEl.removeEventListener("mouseleave", scheduleClose)
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("keydown",   onKey)
        }
        return pop
    }

    _closeCarrierPopover() {
        if (this._carrierPopoverCloseTimer) {
            clearTimeout(this._carrierPopoverCloseTimer)
            this._carrierPopoverCloseTimer = null
        }
        if (this._carrierPopoverCleanup) {
            try { this._carrierPopoverCleanup() } catch (e) { /* noop */ }
            this._carrierPopoverCleanup = null
        }
        if (this._carrierPopover && this._carrierPopover.parentNode) {
            this._carrierPopover.parentNode.removeChild(this._carrierPopover)
        }
        this._carrierPopover = null
        this._carrierPopoverPinned = false
    }

    _positionCarrierPopover(anchorEl) {
        const pop = this._carrierPopover
        if (!pop) return
        const r = anchorEl.getBoundingClientRect()
        const popRect = pop.getBoundingClientRect()
        const vh = window.innerHeight
        const vw = window.innerWidth
        let top = r.bottom + 6
        if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
        let left = r.right - popRect.width
        if (left < 8) left = 8
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
        pop.style.top  = top  + "px"
        pop.style.left = left + "px"
    }

    /**
     * Build one competitor row in the popover. Layout:
     *   [avatar 32×32]  [name link + banner OR name + #id]  [share% / Δ / rank]
     */
    _buildCarrierRow(entry) {
        const wrap = document.createElement("div")
        wrap.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:3px;"
        wrap.addEventListener("mouseenter", () => { wrap.style.background = "rgba(34,197,94,0.08)" })
        wrap.addEventListener("mouseleave", () => { wrap.style.background = "" })

        const avatarBox = document.createElement("div")
        avatarBox.style.cssText = "flex-shrink:0;width:32px;height:32px;border-radius:3px;background:#0f1623;display:flex;align-items:center;justify-content:center;overflow:hidden;"
        if (entry.avatarUrl) {
            const img = document.createElement("img")
            img.src = entry.avatarUrl
            img.alt = entry.name || ""
            img.style.cssText = "width:100%;height:100%;object-fit:cover;"
            img.addEventListener("error", () => {
                if (img.parentNode === avatarBox) avatarBox.removeChild(img)
                avatarBox.append(_initialBadge(entry.name))
            })
            avatarBox.append(img)
        } else {
            avatarBox.append(_initialBadge(entry.name))
        }
        wrap.append(avatarBox)

        const middle = document.createElement("div")
        middle.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;"
        const nameLink = document.createElement("a")
        nameLink.href = "/app/info/enterprises/" + encodeURIComponent(entry.enterpriseId || "")
        nameLink.target = "_blank"
        nameLink.rel = "noreferrer noopener"
        nameLink.textContent = entry.name || "(unknown)"
        nameLink.style.cssText = "color:#93c5fd;text-decoration:none;font-weight:600;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
        nameLink.addEventListener("mouseenter", () => { nameLink.style.textDecoration = "underline" })
        nameLink.addEventListener("mouseleave", () => { nameLink.style.textDecoration = "none" })
        middle.append(nameLink)

        if (entry.bannerUrl) {
            const banner = document.createElement("img")
            banner.src = entry.bannerUrl
            banner.alt = entry.name || ""
            banner.style.cssText = "max-width:100%;max-height:24px;object-fit:contain;border-radius:2px;"
            banner.addEventListener("error", () => {
                if (banner.parentNode === middle) middle.removeChild(banner)
            })
            middle.append(banner)
        } else {
            const sub = document.createElement("span")
            sub.textContent = (entry.iata ? entry.iata + " · " : "") + "#" + (entry.enterpriseId || "?")
            sub.style.cssText = "color:#6b7280;font-size:9px;"
            middle.append(sub)
        }
        wrap.append(middle)

        // Right-side share block. The merged shape exposes
        // {paxShare, cargoShare, paxRank, cargoRank, paxChange, cargoChange};
        // legacy entries from `marketSharePax` only have `sharePct/rank/change`.
        // Render whatever's present so both shapes work.
        const right = document.createElement("div")
        right.style.cssText = "flex-shrink:0;text-align:right;font-size:9px;line-height:1.25;min-width:80px;display:flex;flex-direction:column;gap:1px;"
        const paxShare   = entry.paxShare   != null ? entry.paxShare   : (entry.sharePct != null ? entry.sharePct : null)
        const cargoShare = entry.cargoShare != null ? entry.cargoShare : null
        const paxChange   = entry.paxChange   != null ? entry.paxChange   : (entry.change != null ? entry.change : null)
        const cargoChange = entry.cargoChange != null ? entry.cargoChange : null

        const buildShareLine = (label, share, change, primary) => {
            if (share == null) return null
            const wrap = document.createElement("div")
            wrap.style.cssText = "display:flex;justify-content:flex-end;align-items:baseline;gap:4px;"
            const tag = document.createElement("span")
            tag.textContent = label
            tag.style.cssText = "color:#6b7280;font-size:8px;"
            const value = document.createElement("span")
            value.textContent = share.toFixed(1) + "%"
            value.style.cssText = "color:" + (primary ? "#f3f4f6" : "#cbd5e1") + ";font-weight:" + (primary ? "600" : "400") + ";"
            wrap.append(tag, value)
            if (change != null && change !== 0) {
                const arrow = change > 0 ? "▲" : "▼"
                const color = change > 0 ? "#86efac" : "#fca5a5"
                const chgEl = document.createElement("span")
                chgEl.textContent = arrow + Math.abs(change).toFixed(1)
                chgEl.style.cssText = "color:" + color + ";font-size:8px;"
                wrap.append(chgEl)
            }
            return wrap
        }
        const primarySide = (paxShare != null && (cargoShare == null || paxShare >= cargoShare)) ? "pax" : "cargo"
        const paxLine = buildShareLine("Pax",   paxShare,   paxChange,   primarySide === "pax")
        const cargoLine = buildShareLine("Cargo", cargoShare, cargoChange, primarySide === "cargo")
        if (paxLine)   right.append(paxLine)
        if (cargoLine) right.append(cargoLine)
        // Rank pill (uses the most relevant side's rank).
        const rank = entry.paxRank != null ? entry.paxRank
                  : (entry.cargoRank != null ? entry.cargoRank
                  : (entry.rank != null ? entry.rank : null))
        if (rank != null) {
            const rankEl = document.createElement("div")
            rankEl.textContent = "#" + rank
            rankEl.style.cssText = "color:#6b7280;font-size:8px;"
            right.append(rankEl)
        }
        // Empty fallback when the entry somehow has neither share.
        if (!paxLine && !cargoLine) {
            const dash = document.createElement("div")
            dash.textContent = "—"
            dash.style.cssText = "color:#6b7280;"
            right.append(dash)
        }
        wrap.append(right)

        return wrap
    }

    /**
     * Inline popover anchored to the Seats/wk ▾ caret. Lets the user pin
     * the class mix (Y/C/F percentages), service level, and per-class
     * yield + per-pax cost overrides for one route. Save → persists to
     * RouteAssistantServiceConfigStore; aggregator re-projects so the
     * Seats/wk + Mix + Svc columns refresh without a full reload.
     */
    _openServiceConfigPopover(row, anchorEl) {
        if (!row || !this.hubIata) return
        if (typeof RouteAssistantServiceConfigStore === "undefined") return
        this._closeServicePopover()

        const hubU    = String(this.hubIata).toUpperCase()
        const destU   = String(row.destIata).toUpperCase()
        const pairKey = hubU + "-" + destU
        const defaults = (this.settings && this.settings.serviceProfiles) || {}
        const eff = RouteAssistantServiceConfigStore.resolveEffective(row.serviceConfig, defaults)
        const recordFares = (row.serviceConfig && row.serviceConfig.classFares) || {}

        const pop = document.createElement("div")
        pop.tabIndex = -1
        Object.assign(pop.style, {
            position:   "fixed",
            background: "#1f2937",
            color:      "#f3f4f6",
            border:     "1px solid #0ea5e9",
            borderRadius: "5px",
            boxShadow:  "0 8px 25px rgba(0,0,0,0.55)",
            padding:    "10px 12px",
            zIndex:     "10002",
            minWidth:   "320px",
            font:       "11px/1.5 sans-serif"
        })

        const title = document.createElement("strong")
        title.textContent = `Service · ${hubU} → ${destU}`
        title.style.cssText = "color:#7dd3fc;display:block;margin-bottom:4px;font-size:12px;"

        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:10px;margin-bottom:8px;line-height:1.45;"
        sub.innerHTML = "Class mix percentages auto-renormalise to 100% on save. Empty per-class field = inherit defaults from Settings → Service profiles."

        // ---- Auto-detected source line (markets-page sync — when present)
        if (row.serviceProfileName || row.serviceProfileId
                || (row.classMixSource === "tail")
                || (row.ownPricing && Object.keys(row.ownPricing).length)) {
            const detected = []
            if (row.classMixSource === "tail") {
                detected.push("mix from assigned tail")
            }
            if (row.ownPricing) {
                const fares = []
                for (const cls of ["Y", "C", "F", "Cargo"]) {
                    if (row.ownPricing[cls] != null) fares.push(cls + " " + row.ownPricing[cls])
                }
                if (fares.length) detected.push("AS fares: " + fares.join(" / "))
            }
            if (row.serviceProfileName || row.serviceProfileId) {
                const cache = this.serviceProfilesCache || new Map()
                const detail = row.serviceProfileId ? cache.get(row.serviceProfileId) : null
                let txt = "AS profile: " + (row.serviceProfileName || ("#" + row.serviceProfileId))
                if (detail && detail.classScore) {
                    const cs = detail.classScore
                    txt += " (Y=" + (cs.Y != null ? cs.Y.toFixed(2) : "?")
                        + " · C=" + (cs.C != null ? cs.C.toFixed(2) : "?")
                        + " · F=" + (cs.F != null ? cs.F.toFixed(2) : "?") + ")"
                }
                detected.push(txt)
            }
            if (detected.length) {
                const auto = document.createElement("div")
                auto.style.cssText = "color:#86efac;font-size:10px;margin-bottom:8px;padding:4px 6px;"
                    + "background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.30);border-radius:3px;"
                auto.textContent = "Auto-detected · " + detected.join(" · ")
                pop.append(title, sub, auto)
            } else {
                pop.append(title, sub)
            }
        } else {
            pop.append(title, sub)
        }

        // ---- Class mix row
        const yMix = mkNumberInput(Math.round((eff.classMix.Y || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const cMix = mkNumberInput(Math.round((eff.classMix.C || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const fMix = mkNumberInput(Math.round((eff.classMix.F || 0) * 100), {min: 0, max: 100, step: 1, width: "55px"})
        const mixRow = document.createElement("div")
        mixRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;"
        const mixLbl = document.createElement("span")
        mixLbl.style.cssText = "color:#9ca3af;"
        mixLbl.textContent = "Mix %"
        const chipFor = (label, input, color) => {
            const w = document.createElement("label")
            w.style.cssText = "display:flex;gap:3px;align-items:center;color:" + color + ";"
            w.append(document.createTextNode(label), input)
            return w
        }
        const mixSum = document.createElement("span")
        mixSum.style.cssText = "color:#94a3b8;font-size:10px;"
        const updateMixSum = () => {
            const s = (parseFloatOr(yMix.value, 0) || 0)
                + (parseFloatOr(cMix.value, 0) || 0)
                + (parseFloatOr(fMix.value, 0) || 0)
            mixSum.textContent = "Σ " + Math.round(s) + "%"
            mixSum.style.color = Math.abs(s - 100) < 0.5 ? "#86efac" : "#fbbf24"
        }
        updateMixSum()
        for (const inp of [yMix, cMix, fMix]) inp.addEventListener("input", updateMixSum)
        mixRow.append(mixLbl,
            chipFor("Y", yMix, "#7dd3fc"),
            chipFor("C", cMix, "#fcd34d"),
            chipFor("F", fMix, "#fda4af"),
            mixSum)

        // ---- Service level
        const levels = defaults.serviceLevels || {}
        const svcSelOptions = []
        for (const k of RouteAssistantServiceConfigStore.SERVICE_LEVELS) {
            const lvl = levels[k] || {}
            svcSelOptions.push({
                value: k,
                label: (lvl.label || (k.charAt(0).toUpperCase() + k.slice(1)))
                    + "  ×" + (lvl.yieldMult != null ? Number(lvl.yieldMult).toFixed(2) : "?")
                    + "  +AS$" + (lvl.costPerPax != null ? Math.round(lvl.costPerPax) : "?") + "/pax"
            })
        }
        const svcSel = mkSelect(svcSelOptions)
        svcSel.value = eff.serviceLevel
        svcSel.style.fontSize = "11px"
        const svcRow = document.createElement("div")
        svcRow.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:8px;"
        const svcLbl = document.createElement("span")
        svcLbl.style.cssText = "color:#9ca3af;"
        svcLbl.textContent = "Service level:"
        svcRow.append(svcLbl, svcSel)

        // ---- Per-class fares table
        const fareTable = document.createElement("table")
        fareTable.style.cssText = "width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px;"
        fareTable.innerHTML = `<thead><tr>
            <th style="text-align:left;padding:2px 4px;color:#9ca3af;font-weight:normal;">Class</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Yield AS$/km</th>
            <th style="text-align:right;padding:2px 4px;color:#9ca3af;font-weight:normal;">Cost AS$/pax</th>
            <th style="text-align:left;padding:2px 4px;color:#6b7280;font-weight:normal;font-size:10px;">defaults</th>
        </tr></thead>`
        const fareBody = document.createElement("tbody")
        const fareInputs = {Y: {}, C: {}, F: {}}
        const classColors = {Y: "#7dd3fc", C: "#fcd34d", F: "#fda4af"}
        for (const cls of RouteAssistantServiceConfigStore.CLASSES) {
            const f = eff.classFares[cls]
            const recF = recordFares[cls] || {}
            const yldIn  = mkNumberInput(numOrNull(recF.yieldPerKm), {min: 0, max: 10,    step: 0.01, width: "75px"})
            const costIn = mkNumberInput(numOrNull(recF.costPerPax), {min: 0, max: 99999, step: 1,    width: "70px"})
            fareInputs[cls].yld  = yldIn
            fareInputs[cls].cost = costIn
            const tr = document.createElement("tr")
            const cell = (text, align, color, font) => {
                const c = document.createElement("td")
                c.style.cssText = "padding:2px 4px;text-align:" + (align || "left") + ";color:" + (color || "#d1d5db") + ";"
                if (font) c.style.fontFamily = font
                c.textContent = text
                return c
            }
            tr.append(cell(cls, "left", classColors[cls], null))
            const yldCell  = document.createElement("td"); yldCell.style.cssText  = "padding:2px 4px;text-align:right;"; yldCell.append(yldIn)
            const costCell = document.createElement("td"); costCell.style.cssText = "padding:2px 4px;text-align:right;"; costCell.append(costIn)
            tr.append(yldCell, costCell)
            const defNote = "y×" + (f.yieldMult || 1).toFixed(2)
                + " · AS$" + Math.round(f.costPerPax || 0)
            tr.append(cell(defNote, "left", "#6b7280", "monospace"))
            fareBody.append(tr)
        }
        fareTable.append(fareBody)

        // ---- Buttons
        const btnRow = document.createElement("div")
        btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap;"
        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.style.fontSize = "10px"
        cancelBtn.style.padding = "2px 8px"
        cancelBtn.addEventListener("click", () => this._closeServicePopover())

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.style.fontSize = "10px"
        clearBtn.style.padding = "2px 8px"
        clearBtn.disabled = !row.serviceConfig
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            await RouteAssistantServiceConfigStore.remove(hubU, destU)
            row.serviceConfig = null
            this.serviceConfigMap.delete(pairKey)
            this._reapplyServiceProjection()
            this._renderRows()
            this._closeServicePopover()
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.style.fontSize = "10px"
        saveBtn.style.padding = "2px 8px"
        saveBtn.addEventListener("click", async () => {
            const fields = {
                classMix: {
                    Y: parseFloatOr(yMix.value, 0) || 0,
                    C: parseFloatOr(cMix.value, 0) || 0,
                    F: parseFloatOr(fMix.value, 0) || 0
                },
                serviceLevel: svcSel.value,
                classFares: {
                    Y: {yieldPerKm: numOrNull(fareInputs.Y.yld.value), costPerPax: numOrNull(fareInputs.Y.cost.value)},
                    C: {yieldPerKm: numOrNull(fareInputs.C.yld.value), costPerPax: numOrNull(fareInputs.C.cost.value)},
                    F: {yieldPerKm: numOrNull(fareInputs.F.yld.value), costPerPax: numOrNull(fareInputs.F.cost.value)}
                }
            }
            const saved = await RouteAssistantServiceConfigStore.save(hubU, destU, fields)
            row.serviceConfig = saved
            if (saved) this.serviceConfigMap.set(pairKey, saved)
            else       this.serviceConfigMap.delete(pairKey)
            this._reapplyServiceProjection()
            this._renderRows()
            this._closeServicePopover()
        })
        btnRow.append(cancelBtn, clearBtn, saveBtn)

        // Title + sub + (optional auto-detected banner) were appended above
        // already; we just need the rest of the controls.
        pop.append(mixRow, svcRow, fareTable, btnRow)
        document.body.append(pop)
        this._servicePopover = pop

        const r = anchorEl.getBoundingClientRect()
        const popRect = pop.getBoundingClientRect()
        const vh = window.innerHeight, vw = window.innerWidth
        let top  = r.bottom + 6
        if (top + popRect.height > vh - 8) top = Math.max(8, r.top - popRect.height - 6)
        let left = r.right - popRect.width
        if (left < 8) left = 8
        if (left + popRect.width > vw - 8) left = vw - popRect.width - 8
        pop.style.top  = top  + "px"
        pop.style.left = left + "px"
        yMix.focus(); yMix.select && yMix.select()

        const onMouseDown = (e) => {
            if (pop.contains(e.target)) return
            if (e.target === anchorEl) return
            this._closeServicePopover()
        }
        const onKey = (e) => { if (e.key === "Escape") this._closeServicePopover() }
        setTimeout(() => {
            document.addEventListener("mousedown", onMouseDown)
            document.addEventListener("keydown",   onKey)
        }, 0)
        this._servicePopoverCleanup = () => {
            document.removeEventListener("mousedown", onMouseDown)
            document.removeEventListener("keydown",   onKey)
        }
    }

    _closeServicePopover() {
        if (this._servicePopoverCleanup) {
            try { this._servicePopoverCleanup() } catch (e) { /* noop */ }
            this._servicePopoverCleanup = null
        }
        if (this._servicePopover && this._servicePopover.parentNode) {
            this._servicePopover.parentNode.removeChild(this._servicePopover)
        }
        this._servicePopover = null
    }

    /**
     * Re-project service config across all rows after a save/clear without
     * a full refresh. Cheap: aggregator's projector reads each row's
     * existing estimator output + the now-updated map.
     */
    _reapplyServiceProjection() {
        if (!this.rows || !this.rows.length) return
        const def = (this.settings && this.settings.serviceProfiles) || null
        RouteAssistantAggregator.applyServiceProjection(this.rows, def, this.serviceConfigMap, this.hubIata, this.fleet)
    }

    /**
     * Open a modal letting the user pin paxLF / cargoLF / yieldPerKm /
     * cargoYieldPerKgKm / a free-text note for this route. Saves to
     * RouteAssistantRouteOverridesStore and updates the in-memory row +
     * profit estimate in place — no full refresh required.
     */
    _openOverrideEditor(row) {
        if (!row || !this.hubIata) return
        if (this._overrideEditor && this._overrideEditor.parentNode) {
            this._overrideEditor.parentNode.removeChild(this._overrideEditor)
        }

        // Always uppercase before keying — buildRouteRows uppercases both ends
        // when hydrating row.override, so this match must be consistent.
        const hubU  = String(this.hubIata).toUpperCase()
        const destU = String(row.destIata).toUpperCase()
        const pairKey = hubU + "-" + destU
        const existing = row.override || {}
        const overlay = document.createElement("div")
        Object.assign(overlay.style, {
            position: "fixed", inset: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "10001",
            display: "flex", alignItems: "center", justifyContent: "center"
        })
        const close = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
            this._overrideEditor = null
        }
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })

        const card = document.createElement("div")
        Object.assign(card.style, {
            background: "#1f2937", color: "#f3f4f6",
            border: "1px solid #4c1d95", borderRadius: "6px",
            padding: "16px 18px", minWidth: "360px", maxWidth: "440px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
            font: "12px/1.5 sans-serif"
        })
        const title = document.createElement("strong")
        title.textContent = `Override · ${this.hubIata} → ${row.destIata}`
        title.style.cssText = "color:#a78bfa;display:block;margin-bottom:4px;font-size:13px;"
        const sub = document.createElement("div")
        sub.style.cssText = "color:#9ca3af;font-size:11px;margin-bottom:10px;"
        sub.textContent = "Pin route-specific values. Empty = use demand-driven LF curve / configured base yield."

        const paxLfInput   = mkNumberInput(numOrNull(existing.paxLF),             {min: 0, max: 1,   step: 0.05,   width: "70px"})
        const cargoLfInput = mkNumberInput(numOrNull(existing.cargoLF),           {min: 0, max: 1,   step: 0.05,   width: "70px"})
        const yldInput     = mkNumberInput(numOrNull(existing.yieldPerKm),        {min: 0, max: 10,  step: 0.01,   width: "70px"})
        const cyldInput    = mkNumberInput(numOrNull(existing.cargoYieldPerKgKm), {min: 0, max: 1,   step: 0.0001, width: "85px"})
        const noteInput    = document.createElement("input")
        noteInput.type = "text"
        noteInput.maxLength = 200
        noteInput.placeholder = "e.g. measured 88% LF Q3"
        noteInput.value = existing.note || ""
        noteInput.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:2px 6px;font-size:11px;width:100%;box-sizing:border-box;"

        const grid = document.createElement("div")
        grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:12px;"
        const addRow = (label, input, hint) => {
            const lab = document.createElement("label")
            lab.textContent = label
            lab.style.cssText = "color:#9ca3af;font-size:11px;"
            lab.title = hint || ""
            const wrap = document.createElement("div")
            wrap.append(input)
            if (hint) {
                const h = document.createElement("span")
                h.textContent = " " + hint
                h.style.cssText = "color:#6b7280;font-size:10px;"
                wrap.append(h)
            }
            grid.append(lab, wrap)
        }
        addRow("Pax LF",            paxLfInput,   "0–1, e.g. 0.85")
        addRow("Cargo LF",          cargoLfInput, "0–1, e.g. 0.70")
        addRow("Yield AS$/pax-km",  yldInput,     "Beats base yield for this route only")
        addRow("Cargo AS$/kg-km",   cyldInput,    "Beats base cargo yield for this route only")
        addRow("Note",              noteInput,    "")

        const status = document.createElement("div")
        status.style.cssText = "color:#6b7280;font-size:10px;margin-bottom:10px;"
        status.textContent = existing && existing.updatedAt
            ? "Last updated " + new Date(existing.updatedAt).toLocaleString()
            : "No override saved yet."

        const buttonRow = document.createElement("div")
        buttonRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;"

        const cancelBtn = document.createElement("button")
        cancelBtn.textContent = "Cancel"
        Object.assign(cancelBtn.style, smallBtnStyle())
        cancelBtn.style.background = "#475569"
        cancelBtn.addEventListener("click", close)

        const clearBtn = document.createElement("button")
        clearBtn.textContent = "Clear override"
        Object.assign(clearBtn.style, smallBtnStyle())
        clearBtn.style.background = "#7f1d1d"
        clearBtn.disabled = !row.override
        if (clearBtn.disabled) clearBtn.style.opacity = "0.5"
        clearBtn.addEventListener("click", async () => {
            await RouteAssistantRouteOverridesStore.remove(hubU, destU)
            row.override = null
            this.overrideMap.delete(pairKey)
            this._recomputeProfit()
            close()
        })

        const calibBtn = document.createElement("button")
        calibBtn.textContent = "Calibrate from actuals"
        Object.assign(calibBtn.style, smallBtnStyle())
        calibBtn.style.background = "#7c3aed"
        const calibTarget = derivedYieldFromActuals(row)
        calibBtn.disabled = !calibTarget
        if (!calibTarget) {
            calibBtn.style.opacity = "0.5"
            calibBtn.title = "Take a snapshot first — derives the base yield needed to reproduce the actuals at the current LF / aircraft."
        } else {
            calibBtn.title = "Pre-fills Yield AS$/pax-km with " + calibTarget.toFixed(4)
                + " — the value that would make the estimator match the latest snapshot at the current LF / spec.\n"
                + "Review and Save to pin it as a route override."
        }
        calibBtn.addEventListener("click", () => {
            const v = derivedYieldFromActuals(row)
            if (!v) return
            yldInput.value = v.toFixed(4)
            yldInput.focus()
            yldInput.select()
            sub.textContent = "Pre-filled yield from snapshot — edit if you want, then Save."
            sub.style.color = "#a78bfa"
        })

        const saveBtn = document.createElement("button")
        saveBtn.textContent = "Save"
        Object.assign(saveBtn.style, smallBtnStyle())
        saveBtn.addEventListener("click", async () => {
            const fields = {
                paxLF:             numOrNull(paxLfInput.value),
                cargoLF:           numOrNull(cargoLfInput.value),
                yieldPerKm:        numOrNull(yldInput.value),
                cargoYieldPerKgKm: numOrNull(cyldInput.value),
                note:              noteInput.value
            }
            const saved = await RouteAssistantRouteOverridesStore.save(hubU, destU, fields)
            row.override = saved
            if (saved) this.overrideMap.set(pairKey, saved)
            else this.overrideMap.delete(pairKey)
            this._recomputeProfit()
            close()
        })

        buttonRow.append(cancelBtn, calibBtn, clearBtn, saveBtn)
        card.append(title, sub, grid, status, buttonRow)
        overlay.append(card)
        document.body.append(overlay)
        this._overrideEditor = overlay
        paxLfInput.focus()
    }

    /**
     * Apply a weight preset: each variable listed in preset.weights gets that
     * weight (and is enabled if weight > 0); variables not in the preset get
     * disabled with weight 0. Re-renders settings + table so the user sees
     * the new state immediately.
     */
    async _applyWeightPreset(preset) {
        for (const f of RouteAssistantPanel.SCORING_FIELDS) {
            const cfg = this.settings.scoring[f.field] = Object.assign(
                {enabled: false, weight: 1, direction: f.direction, min: null, max: null},
                this.settings.scoring[f.field] || {}
            )
            if (preset.weights && preset.weights[f.field] !== undefined) {
                cfg.weight  = preset.weights[f.field]
                cfg.enabled = preset.weights[f.field] > 0
            } else {
                cfg.weight  = 0
                cfg.enabled = false
            }
        }
        await RouteAssistantSettings.save({scoring: this.settings.scoring})
        this._render()
        this._renderSettings()
    }
}

// ---------- Static config ----------

// Visual groups for the results table. Each column references one of these
// keys; the table renders a sub-header row with grouped labels and tints
// each cell to match. The intent is that a glance at a row's colour tells
// you whether you're looking at AirlineSim's in-game numbers or
// flightsfrom.com's real-world signal.
RouteAssistantPanel.COLUMN_GROUPS = {
    computed: {label: "",            tint: null,                          headerTint: null},
    as:       {label: "AS in-game",  tint: "rgba(96, 165, 250, 0.10)",    headerTint: "rgba(96, 165, 250, 0.22)"},
    real:     {label: "Real-world",  tint: "rgba(251, 191, 36, 0.10)",    headerTint: "rgba(251, 191, 36, 0.22)"},
    competition: {label: "Competition", tint: "rgba(132, 204, 22, 0.10)", headerTint: "rgba(132, 204, 22, 0.24)"},
    aircraft: {label: "Aircraft",    tint: "rgba(34, 197, 94, 0.10)",     headerTint: "rgba(34, 197, 94, 0.22)"},
    pricing:  {label: "Live route data", tint: "rgba(244, 63, 94, 0.10)", headerTint: "rgba(244, 63, 94, 0.22)"},
    actuals:  {label: "Actuals",     tint: "rgba(168, 85, 247, 0.10)",    headerTint: "rgba(168, 85, 247, 0.24)"},
    service:  {label: "Service",     tint: "rgba(56, 189, 248, 0.10)",    headerTint: "rgba(56, 189, 248, 0.24)"},
    markets:  {label: "Market Analysis", tint: "rgba(20, 184, 166, 0.10)", headerTint: "rgba(20, 184, 166, 0.24)"},
    ors:      {label: "ORS Rank",         tint: "rgba(245, 158, 11, 0.10)", headerTint: "rgba(245, 158, 11, 0.24)"}
}

RouteAssistantPanel.STATUS_DEF = {
    NEW:   {color: "#60a5fa", description: "You don't fly this route at all. Candidate to start."},
    OK:    {color: "#22c55e", description: "Your frequency is in line with real-world demand. No action needed."},
    UNDER: {color: "#fbbf24", description: "High pax demand (≥ 8/10) and you fly < 1/10 of real-world traffic. Room to scale up."},
    OVER:  {color: "#f97316", description: "You fly more than 1/5 of real-world traffic. Possibly over-deployed; consider trimming frequency."},
    OOR:   {color: "#ef4444", description: "Out of range — the selected aircraft can't reach this destination (over 95% of max range)."}
}

// `modes` gates which view tabs include the field in the score blend.
// "all" keeps every field active (preserves pre-tabbed behaviour);
// "pax"/"cargo" filter to fields relevant to that view. Frequency,
// competition, profit, fleet-fit, and actuals are mode-agnostic.
RouteAssistantPanel.SCORING_FIELDS = [
    {field: "paxScore",            label: "Pax demand",     group: "as",       direction: "higher",
     modes: ["all", "pax"],
     suggestedValues: [0,1,2,3,4,5,6,7,8,9,10]},
    {field: "cargoScore",          label: "Cargo demand",   group: "as",       direction: "higher",
     modes: ["all", "cargo"],
     suggestedValues: [0,1,2,3,4,5,6,7,8,9,10]},
    {field: "weeklyFlights",       label: "FF/week",        group: "real",     direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [5,10,25,50,75,100,150,200,300]},
    {field: "airlineCount",        label: "Competition",    group: "real",     direction: "lower",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [1,2,3,4,5,7,10]},
    {field: "profitPerWeek",       label: "AS$/week",       group: "aircraft", direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [10000, 50000, 100000, 250000, 500000, 1000000]},
    {field: "fitOk",               label: "Fleet-fit",      group: "aircraft", direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [0, 1]},
    {field: "actualProfitPerWeek", label: "Actual $/week",  group: "actuals",  direction: "higher",
     modes: ["all", "pax", "cargo"],
     suggestedValues: [10000, 50000, 100000, 250000, 500000, 1000000]}
]

// Quick-apply sets of weights. Click one and every variable's weight
// jumps to the listed value (variables not listed go to 0 = ignored).
RouteAssistantPanel.WEIGHT_PRESETS = [
    {name: "Balanced",
     description: "Equal weight on every signal",
     weights: {paxScore: 1, cargoScore: 1, weeklyFlights: 1, airlineCount: 1}},
    {name: "Chase demand",
     description: "Heavy real-world traffic, light competition penalty",
     weights: {paxScore: 2, cargoScore: 1, weeklyFlights: 3, airlineCount: 0.5}},
    {name: "Avoid competition",
     description: "Strong penalty on crowded routes",
     weights: {paxScore: 1, cargoScore: 1, weeklyFlights: 1, airlineCount: 3}},
    {name: "Cargo focus",
     description: "Cargo demand triple-counted",
     weights: {paxScore: 0.5, cargoScore: 3, weeklyFlights: 1, airlineCount: 1}}
]

RouteAssistantPanel.COLUMNS = [
    {field: "score", label: "Sc", group: "computed", align: "right", defaultDir: -1,
     title: "Score (0–100) = Σ(weightᵢ × normᵢ) / Σweightᵢ × 100\n  normᵢ = (xᵢ − min) / (max − min)            for higher = better\n  normᵢ = (max − xᵢ) / (max − min)            for lower = better\nmin/max are computed across the visible rows. Disable a variable in Settings to drop it from the average.",
     render(td, row) {
        if (row.score === null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const hue = Math.round((Math.max(0, Math.min(100, row.score)) / 100) * 120)
        td.style.background = `hsl(${hue}, 70%, 35%)`
        td.style.color = "#fff"
        td.style.fontWeight = "bold"
        td.textContent = row.score
    }},
    {field: "destIata", label: "Dest", group: "computed",
     title: "Click IATA → market analysis (per-route ORS, competitors). Small icons jump to scheduling / inventory / airport info. Right-click any row to override LF / yield.",
     render(td, row) {
        const hub  = RouteAssistantPanel._currentHubIata || ""
        const dest = row.destIata
        const pin = row.override
            ? ` <span title="${escapeHtml(formatOverrideSummary(row.override))}" style="color:#a78bfa;font-size:11px;cursor:help;">📌</span>`
            : ""
        const iataHtml = hub
            ? `<a href="/app/com/markets/${encodeURIComponent(hub)}${encodeURIComponent(dest)}" target="_blank" rel="noopener" class="aes-iata"`
                + ` title="Market analysis (ORS rank, competitors) for ${escapeHtml(hub)}→${escapeHtml(dest)}">${escapeHtml(dest)}</a>`
            : `<strong>${escapeHtml(dest)}</strong>`
        const icons = []
        if (hub) {
            icons.push(`<a href="/app/com/scheduling/${encodeURIComponent(hub)}${encodeURIComponent(dest)}"`
                + ` target="_blank" rel="noopener" title="Scheduling page for ${escapeHtml(hub)}→${escapeHtml(dest)}">📅</a>`)
            icons.push(`<a href="/app/com/inventory/${encodeURIComponent(hub)}${encodeURIComponent(dest)}"`
                + ` target="_blank" rel="noopener" title="Inventory + fares for ${escapeHtml(hub)}→${escapeHtml(dest)}">📦</a>`)
        }
        if (row.airportId) {
            icons.push(`<a href="/app/info/airports/${encodeURIComponent(row.airportId)}"`
                + ` target="_blank" rel="noopener" title="${escapeHtml(dest)} airport info">🛫</a>`)
        }
        const iconRow = icons.length ? `<span class="aes-iata-icons">${icons.join("")}</span>` : ""
        td.innerHTML = iataHtml + pin + iconRow
            + (row.destName ? `<br><span style="color:#9ca3af;font-size:10px;">${escapeHtml(row.destName)}</span>` : "")
    }},
    {field: "status", label: "St", group: "computed",
     title: "Status flag — hover a cell for the rule; click to sort. A VAR+/VAR− pill is appended when the latest snapshot's Δ% exceeds the variance warn threshold.",
     render(td, row) {
        const def = RouteAssistantPanel.STATUS_DEF[row.status] || {color: "#9ca3af", description: ""}
        td.textContent = ""
        const main = document.createElement("span")
        main.textContent = row.status
        main.style.color = def.color
        main.style.fontWeight = "bold"
        td.append(main)
        const v = row.actualVariancePct
        const warn = RouteAssistantPanel._varianceWarnPct || 25
        if (typeof v === "number" && Math.abs(v) >= warn) {
            const pill = document.createElement("span")
            const sign = v > 0 ? "+" : "−"
            pill.textContent = "V" + sign
            pill.style.cssText = "display:inline-block;margin-left:3px;padding:0 3px;"
                + "border-radius:3px;font-size:9px;font-weight:600;"
                + "background:" + (v > 0 ? "rgba(34,197,94,0.20)" : "rgba(239,68,68,0.20)") + ";"
                + "color:" + (v > 0 ? "#86efac" : "#fca5a5") + ";"
                + "border:1px solid " + (v > 0 ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)") + ";"
            pill.title = "Δ% = " + (v > 0 ? "+" : "") + v + "%"
                + (v > 0 ? " — actual exceeds estimate" : " — actual below estimate")
                + " (warn at ±" + warn + "%; tune in Settings → Yield feedback)"
            td.append(pill)
        }
        if (def.description) td.title = `${row.status}: ${def.description}`
    }},
    {field: "paxScore", label: "Pax", group: "as", align: "right",
     title: "AS in-game pax demand for the destination (0–10) — from /action/info/country",
     render(td, row) {
        td.textContent = row.paxScore === null ? "—" : row.paxScore
    }},
    {field: "cargoScore", label: "Crg", group: "as", align: "right",
     title: "AS in-game cargo demand for the destination (0–10) — from /action/info/country",
     render(td, row) {
        td.textContent = row.cargoScore === null ? "—" : row.cargoScore
    }},
    {field: "ownTotalFreq", label: "Own", group: "as", align: "right",
     title: "Your weekly frequency on this route — from your last extracted AS schedule",
     render(td, row) {
        td.textContent = row.ownTotalFreq || 0
    }},
    {field: "distanceKm", label: "km", group: "real", align: "right",
     title: "Real-world great-circle distance",
     render(td, row) {
        td.textContent = row.distanceKm === null ? "—" : row.distanceKm.toLocaleString()
        td.style.color = "#9ca3af"
    }},
    {field: "weeklyFlights", label: "FF/w", group: "real", align: "right",
     title: "Real-world weekly flights on this route — from flightsfrom.com",
     render(td, row) {
        td.textContent = row.weeklyFlights === null ? "—" : row.weeklyFlights
    }},
    {field: "airlineCount", label: "Cmp", group: "real", align: "right",
     title: "Distinct competitors on this route. Source priority: "
        + "AS market-share (pax + cargo deduped, excluding you) when the Markets page is synced, "
        + "else flightsfrom.com (real-world airlines). "
        + "Hover for the carrier list; click to pin.",
     render(td, row) {
        const carriers = Array.isArray(row.carriers) ? row.carriers : []
        const merged = Array.isArray(row.competitorEntries) ? row.competitorEntries : null
        const hasASShares = (merged && merged.length > 0)
            || (Array.isArray(row.marketSharePax) && row.marketSharePax.length > 0)
        // Prefer AS competitor count when available — it matches what
        // the popover renders and excludes ourself, so the user sees a
        // single consistent number across pill + tooltip.
        const asCount = (typeof row.competitorCount === "number" && row.competitorCount >= 0)
            ? row.competitorCount
            : (merged ? merged.length : null)
        const display = (asCount != null) ? asCount : row.airlineCount

        if (display === null || display === undefined) {
            td.textContent = "—"
            return
        }
        const showPill = RouteAssistantPanel._showCarrierIntensity !== false
        const intensity = row.competitiveIntensity
            || RouteAssistantCarriersScraper.intensity(display)

        const pill = document.createElement("span")
        pill.textContent = String(display)
        if (showPill && intensity) {
            pill.style.display      = "inline-block"
            pill.style.minWidth     = "1.6em"
            pill.style.padding      = "1px 6px"
            pill.style.borderRadius = "10px"
            pill.style.background   = RouteAssistantCarriersScraper.intensityColor(intensity)
            pill.style.color        = "#0f172a"
            pill.style.fontWeight   = "600"
            pill.style.fontSize     = "10px"
            pill.style.textAlign    = "center"
            pill.style.cursor       = hasASShares ? "pointer" : "default"
            // Subtle outline when the count is from AS-side data so
            // the user can see at a glance which routes are using
            // ground-truth vs. flightsfrom estimates.
            if (asCount != null) pill.style.boxShadow = "inset 0 0 0 1px rgba(15,23,42,0.4)"
        }
        td.append(pill)

        // F slice 2 — open the rich popover on hover when AS market-share
        // data is available; otherwise fall back to the plain-text tooltip.
        if (hasASShares) {
            let openTimer = null
            const open = (pinned) => {
                if (openTimer) { clearTimeout(openTimer); openTimer = null }
                const inst = RouteAssistantPanel._currentInstance
                if (!inst) return
                inst._openCarrierPopover(row, pill, {pinned: !!pinned})
            }
            pill.addEventListener("mouseenter", () => {
                if (openTimer) clearTimeout(openTimer)
                openTimer = setTimeout(() => open(false), 200)
            })
            pill.addEventListener("mouseleave", () => {
                if (openTimer) { clearTimeout(openTimer); openTimer = null }
            })
            pill.addEventListener("click", (e) => {
                e.preventDefault()
                e.stopPropagation()
                open(true)
            })
        } else {
            // No AS data — keep native text tooltip with flightsfrom carriers.
            pill.title = formatCarriersTooltip(row, carriers, intensity)
        }
    }},

    // ----- Competition (in-game) — its own little detached group sitting
    // next to the Real-World Cmp pill. Mkt% surfaces YOUR pax share of the
    // route; clicking/hovering opens the SAME rich popover the Real-World
    // Cmp pill does, so all in-game competition intel — your share AND the
    // full leaderboard — is one hover away from this column too.
    {field: "ourPaxShare", label: "Mkt%", group: "competition", align: "right", defaultDir: -1,
     title: "Your pax market share on this route — from /app/com/markets/<HUB><DEST>'s Market Shares section. Hover to see the full leaderboard with all in-game competitors. Color rail: ≥40% green, 20–40% amber, <20% red.",
     render(td, row) {
        if (row.ourPaxShare == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const v = row.ourPaxShare
        const cell = document.createElement("span")
        cell.textContent = v.toFixed(1) + "%"
        cell.style.fontWeight = "bold"
        cell.style.cursor = "pointer"
        if      (v >= 40) cell.style.color = "#86efac"
        else if (v >= 20) cell.style.color = "#fde68a"
        else              cell.style.color = "#fca5a5"
        td.append(cell)
        // Wire to the same rich popover the Real-World Cmp pill uses, so
        // the user sees the FULL leaderboard with all in-game competitors,
        // not just a top-5 truncation.
        const hasAS = (Array.isArray(row.competitorEntries) && row.competitorEntries.length > 0)
            || (Array.isArray(row.marketSharePax) && row.marketSharePax.length > 0)
        if (hasAS) {
            let openTimer = null
            const open = (pinned) => {
                if (openTimer) { clearTimeout(openTimer); openTimer = null }
                const inst = RouteAssistantPanel._currentInstance
                if (!inst) return
                inst._openCarrierPopover(row, cell, {pinned: !!pinned})
            }
            cell.addEventListener("mouseenter", () => {
                if (openTimer) clearTimeout(openTimer)
                openTimer = setTimeout(() => open(false), 200)
            })
            cell.addEventListener("mouseleave", () => {
                if (openTimer) { clearTimeout(openTimer); openTimer = null }
            })
            cell.addEventListener("click", (e) => {
                e.preventDefault()
                e.stopPropagation()
                open(true)
            })
        } else {
            const period = row.marketSharePeriod ? " (week " + row.marketSharePeriod + ")" : ""
            cell.title = "Pax market share" + period
                + (row.marketsScrapedAt ? "\nLast scraped: " + new Date(row.marketsScrapedAt).toLocaleString() : "")
        }
    }},

    {field: "aircraftFit", label: "Fit", group: "aircraft",
     title: "Fit class — depends on distance vs range:\n  Optimal: distance ≤ range × (1 − falloffPct/100)         e.g. ≤ 90% of range at default falloff = 10%\n  Fall-off: optimalLimit < distance ≤ range × 0.95             revenue × falloffYieldMultiplier (default 0.85)\n  OOR:      distance > range × 0.95                                  cannot operate the route safely",
     render(td, row) {
        if (!row.aircraftFit) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const map = {optimal: ["✓", "#22c55e"], falloff: ["⚠", "#fbbf24"], oor: ["✗", "#ef4444"]}
        const [glyph, color] = map[row.aircraftFit] || ["?", "#9ca3af"]
        td.textContent = glyph + " " + row.aircraftFit
        td.style.color = color
        td.style.fontWeight = "bold"
        if (row.aircraftTypeName) td.title = "Picked: " + row.aircraftTypeName
    }},
    {field: "blockHours", label: "Hrs", group: "aircraft", align: "right",
     title: "Block hours (round-trip) = 2 × distance / cruiseSpeed + 0.5 h\n  0.5 h is fixed taxi/approach overhead per round trip.\nFeeds the cost side of $/flt: fuel/crew/maint × blockHours.",
     render(td, row) {
        td.textContent = row.blockHours === null ? "—" : row.blockHours.toFixed(1)
        td.style.color = "#9ca3af"
    }},
    {field: "profitPerFlight", label: "$/flt", group: "aircraft", align: "right",
     title: "$/flt = revenue − cost  (per round-trip flight, AS$)\n  revenue = paxRevenue + cargoRevenue\n    paxRevenue   = seats × paxLF × yieldPerKm × distance × 2 × falloffMult\n    cargoRevenue = cargoKg × cargoLF × cargoYieldPerKgKm × distance × 2 × falloffMult\n  cost = (fuel + crew + maint) × blockHours + otherFixedPerFlight\nHover any data cell for the per-row breakdown. Click the ▾ to quick-edit yield / LF for this route.",
     render(td, row) {
        if (row.isCargoOnly) { td.textContent = "—"; td.style.color = "#9ca3af"; td.title = "Cargo aircraft — pax revenue estimate not applicable in v1."; return }
        if (row.profitPerFlight === null) { td.textContent = "—"; td.style.color = "#9ca3af"; return }
        const value = document.createElement("span")
        value.textContent = formatProfit(row.profitPerFlight)
        value.style.color = row.profitPerFlight >= 0 ? "#a3e635" : "#fca5a5"
        value.title = formatProfitBreakdown(row)
        const caret = document.createElement("span")
        caret.textContent = " ▾"
        caret.dataset.profitTrigger = "1"
        caret.title = "Quick-edit yield / LF for this route"
            + (row.override ? " (override active — click to adjust)" : "")
        caret.style.cssText = "cursor:pointer;font-size:10px;padding:0 2px;color:"
            + (row.override ? "#a78bfa" : "#94a3b8") + ";"
        td.append(value, caret)
    }},
    {field: "profitPerWeek", label: "$/wk", group: "aircraft", align: "right",
     title: "$/wk = $/flt × weekly frequency\nUses your own weekly flights from the latest schedule extract. Shows '—' when you don't fly the route yet (no frequency to multiply by).",
     render(td, row) {
        if (row.isCargoOnly) { td.textContent = "—"; td.style.color = "#9ca3af"; return }
        if (row.profitPerWeek === null) { td.textContent = "—"; td.style.color = "#9ca3af"; td.title = "You don't fly this route yet — start scheduling and weekly profit will populate."; return }
        td.textContent = formatProfit(row.profitPerWeek)
        td.style.color = row.profitPerWeek >= 0 ? "#a3e635" : "#fca5a5"
        td.style.fontWeight = "bold"
        td.title = formatProfitBreakdown(row)
    }},
    {field: "liveAircraftType", label: "Eq", group: "pricing",
     title: "Aircraft assigned to this route — captured from /app/com/scheduling/<HUB><DEST>. Type name links to the *individual tail's* flight-history page (visiting it captures the profit data the snapshot consumes). 📋 icon links to the generic spec page.",
     render(td, row) {
        if (!row.liveAircraftType) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const reg = row.liveAircraftReg
        const baseTitle = (reg ? reg + " — " : "")
            + row.liveAircraftType
            + (row.liveCruiseSpeed ? " · cruise " + row.liveCruiseSpeed + " km/h" : "")
        td.style.color = "#fda4af"
        const typeName = escapeHtml(row.liveAircraftType)
        // Primary link points at the individual tail. Falls back to the
        // generic spec page when the registration isn't in the cached fleet
        // (older record before the fleet refresh, or competitor data).
        let mainHtml
        if (row.liveAircraftId) {
            mainHtml = `<a href="/app/fleets/aircraft/${encodeURIComponent(row.liveAircraftId)}/1"`
                + ` target="_blank" rel="noopener" class="aes-aircraft-link"`
                + ` title="${escapeHtml(baseTitle)}\nClick: tail flight-history page (writes the profit record snapshots read)">${typeName}</a>`
        } else if (row.liveAircraftTypeId) {
            mainHtml = `<a href="/action/enterprise/aircraftsType?id=${encodeURIComponent(row.liveAircraftTypeId)}"`
                + ` target="_blank" rel="noopener" class="aes-aircraft-link"`
                + ` title="${escapeHtml(baseTitle)}\nFleet record for this tail not cached — falling back to the generic type spec page.">${typeName}</a>`
        } else {
            mainHtml = typeName
        }
        // 📋 icon → generic type spec page. Always shown when typeId is
        // known so the user can compare specs without leaving the tail page.
        const specIconHtml = row.liveAircraftTypeId
            ? ` <a href="/action/enterprise/aircraftsType?id=${encodeURIComponent(row.liveAircraftTypeId)}"`
                + ` target="_blank" rel="noopener"`
                + ` style="color:#fda4af;text-decoration:none;font-size:10px;opacity:0.6;"`
                + ` title="${escapeHtml(row.liveAircraftType)} — generic spec page">📋</a>`
            : ""
        td.innerHTML = mainHtml + specIconHtml
    }},
    {field: "liveDeparture", label: "Dep", group: "pricing", align: "right",
     title: "Departure time (HT) — captured from the live scheduling page.",
     render(td, row) {
        if (!row.liveDeparture) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        td.textContent = row.liveDeparture
        td.style.color = "#fda4af"
        td.style.fontFamily = "monospace"
    }},
    {field: "liveWeeklyFlights", label: "Wk", group: "pricing", align: "right", defaultDir: -1,
     title: "Total weekly departures + per-day pattern. Each digit is flights that day (Mon→Sun); '·' = not flown. Captures multi-daily — '2222211' = 2x Mon–Fri, 1x weekends, 12/wk.",
     render(td, row) {
        if (!row.liveWeeklyFlights) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const daily = Array.isArray(row.liveDailyFlights) ? row.liveDailyFlights : null
        const total = document.createElement("strong")
        total.textContent = String(row.liveWeeklyFlights)
        td.append(total)
        if (daily) {
            const pat = document.createElement("span")
            pat.textContent = " " + daily.map(n => n > 0 ? String(n) : "·").join("")
            pat.style.cssText = "font-family:monospace;color:rgba(253,164,175,0.7);font-size:10px;"
            td.append(pat)
        }
        td.style.color = "#fda4af"
        td.title = (daily
            ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                .map((d, i) => d + " " + (daily[i] || 0)).join(", ")
            : "Legacy record — click Sync route data for per-day breakdown")
            + " — " + row.liveWeeklyFlights + "/week"
            + (row.liveScrapedAt ? "\nLast scraped: " + new Date(row.liveScrapedAt).toLocaleString() : "")
    }},
    {field: "actualProfitPerFlight", label: "Act $/flt", group: "actuals", align: "right", defaultDir: -1,
     title: "Act $/flt = Σtail (tail.$/flt × tail.weeklyFlightsOnRoute) / Σtail tail.weeklyFlightsOnRoute\n  tail.$/flt = aircraftFlights.profit / aircraftFlights.profitFlights  (lifetime average)\n  tail.weeklyFlightsOnRoute is summed from the live-route-data scrape (each flight number × its days/wk)\nAttribution mode (frequency / distance / equal) selectable in Settings → Yield feedback.\nHover for tail mix + sparkline.",
     render(td, row) {
        if (row.actualProfitPerFlight === null || row.actualProfitPerFlight === undefined) {
            td.textContent = "—"; td.style.color = "#6b7280"
            td.title = "Take a snapshot to populate. Requires Live-route-data sync + a recent visit to each tail's flight-history page."
            return
        }
        td.textContent = formatProfit(row.actualProfitPerFlight)
        td.style.color = row.actualProfitPerFlight >= 0 ? "#d8b4fe" : "#fca5a5"
        td.style.fontWeight = "bold"
        td.title = formatActualsBreakdown(row)
    }},
    {field: "actualVariancePct", label: "Δ%", group: "actuals", align: "right",
     title: "Δ% = (Act $/flt − $/flt) / |$/flt| × 100\n  Positive → outperforming the estimator (yield is higher than predicted).\n  Negative → underperforming (lower than predicted).\nHighlighted green/red when |Δ%| ≥ variance warning threshold (default 25%, configurable in Settings → Yield feedback).",
     render(td, row) {
        if (row.actualVariancePct === null || row.actualVariancePct === undefined) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        const v = row.actualVariancePct
        td.textContent = (v > 0 ? "+" : "") + v + "%"
        const warn = RouteAssistantPanel._varianceWarnPct || 25
        if (Math.abs(v) >= warn)      td.style.color = v > 0 ? "#86efac" : "#fca5a5"
        else                          td.style.color = "#d8b4fe"
        td.style.fontWeight = "bold"
        td.title = formatActualsBreakdown(row)
    }},

    // ----- Service profile (per-route Y/C/F mix + service level) -----
    {field: "weeklySeatsTotal", label: "Seats/wk", group: "service", align: "right", defaultDir: -1,
     title: "Seats offered per week = seatsPerFlight × your weekly frequency (departures only).\n  seatsPerFlight is split across Y/C/F by the per-route class mix; each class is allocated by largest-remainder so the totals stay exact.\nHover for the per-class breakdown + revenue/cost. Click ▾ to edit class mix, service level, and per-class fares.",
     render(td, row) {
        if (!row.weeklySeatsTotal) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const value = document.createElement("span")
        value.textContent = Number(row.weeklySeatsTotal).toLocaleString()
        value.style.color = "#7dd3fc"
        value.title = formatServiceBreakdown(row)
        const caret = document.createElement("span")
        caret.textContent = " ▾"
        caret.dataset.serviceTrigger = "1"
        const overridden = row.classMixSource === "route" || row.serviceLevelSource === "route"
            || (row.serviceConfig && row.serviceConfig.classFares)
        caret.title = "Quick-edit class mix / service level / per-class fares"
            + (overridden ? " (route override active — click to adjust)" : "")
        caret.style.cssText = "cursor:pointer;font-size:10px;padding:0 2px;color:"
            + (overridden ? "#a78bfa" : "#94a3b8") + ";"
        td.append(value, caret)
    }},
    {field: "classMix", label: "Mix", group: "service", align: "right",
     title: "Class mix Y/C/F as percentages.\nResolution priority: route override → assigned tail's seat counts (auto from /app/fleets) → default.\nClick ▾ on Seats/wk to pin a per-route mix.",
     render(td, row) {
        if (!row.classMix) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const m = row.classMix
        const fmt = v => Math.round((Number(v) || 0) * 100)
        const text = fmt(m.Y) + "/" + fmt(m.C) + "/" + fmt(m.F)
        const sourceColor = {route: "#a78bfa", tail: "#86efac", default: "#7dd3fc"}
        const sourceLabel = {route: "route override", tail: "from assigned tail", default: "default"}
        td.textContent = text
        td.style.fontFamily = "monospace"
        td.style.color = sourceColor[row.classMixSource] || "#7dd3fc"
        td.style.fontSize = "10px"
        td.title = "Y " + fmt(m.Y) + "% · C " + fmt(m.C) + "% · F " + fmt(m.F) + "%"
            + "  (" + (sourceLabel[row.classMixSource] || "default") + ")"
    }},
    {field: "serviceLevel", label: "Svc", group: "service", align: "center",
     title: "Service level — multiplies effective yield and adds a fixed per-pax cost on top of class catering.\nB Budget · S Standard · P Premium. Tune the multipliers in Settings → Service profiles; flip per route via the Seats/wk ▾.\nWhen the markets-page sync has run, the AS profile assigned to the route appears in the tooltip with its per-class quality score.",
     render(td, row) {
        if (!row.serviceLevel) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const lvl = row.serviceLevel
        const map = {budget: ["B", "#94a3b8"], standard: ["S", "#7dd3fc"], premium: ["P", "#fcd34d"]}
        const [glyph, color] = map[lvl] || ["?", "#9ca3af"]
        td.textContent = glyph
        td.style.fontWeight = "bold"
        td.style.color = row.serviceLevelSource === "route" ? "#a78bfa" : color
        let title = "Service level: " + lvl
            + (row.serviceLevelSource === "route" ? "  (route override)" : "  (default)")
        if (row.serviceProfileName || row.serviceProfileId) {
            title += "\n\nAS profile assigned: " + (row.serviceProfileName || "")
                + (row.serviceProfileId ? " (#" + row.serviceProfileId + ")" : "")
            const profileCache = RouteAssistantPanel._serviceProfilesCacheStatic
            const detail = (profileCache && row.serviceProfileId)
                ? profileCache.get(row.serviceProfileId) : null
            if (detail && detail.classScore) {
                title += "\nQuality (0-1): Y=" + (detail.classScore.Y != null ? detail.classScore.Y.toFixed(2) : "?")
                    + " · C=" + (detail.classScore.C != null ? detail.classScore.C.toFixed(2) : "?")
                    + " · F=" + (detail.classScore.F != null ? detail.classScore.F.toFixed(2) : "?")
            }
        }
        td.title = title
    }},

    // ----- Market Analysis (Tier 2a — markets-page scraper) -----
    // Mkt% (your pax market share) lives in its own little detached
    // "competition" group, positioned next to the Real-World Cmp pill (see
    // COLUMNS array reordering below). Hover/click opens the SAME rich
    // popover the Real-World Cmp pill uses, so all in-game competition
    // intel — your share AND the full leaderboard — surfaces in one place.
    // The Cmp# duplicate count column was removed: the Real-World Cmp pill
    // already prefers competitorCount when AS market-share data is present.
    {field: "competitorMedianPriceY", label: "Cmp$", group: "markets", align: "right", defaultDir: -1,
     title: "Median competitor Y-class fare (excludes your own flights). Cell shows +/-X% delta vs. your Y price when both are known.",
     render(td, row) {
        if (row.competitorMedianPriceY == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const cmp = row.competitorMedianPriceY
        const ours = row.ownPricing && row.ownPricing.Y
        if (ours && ours > 0) {
            const delta = Math.round(((ours - cmp) / cmp) * 100)
            td.textContent = cmp + " (" + (delta > 0 ? "+" : "") + delta + "%)"
            td.style.color = delta > 0 ? "#fde68a" : (delta < 0 ? "#86efac" : "#5eead4")
            td.title = "Median competitor Y: " + cmp + " AS$\n"
                + "Your Y: " + ours + " AS$ (" + (delta > 0 ? "+" : "") + delta + "%)\n"
                + "Positive % = you're priced higher than the median; negative = you're under."
        } else {
            td.textContent = String(cmp)
            td.style.color = "#5eead4"
        }
    }},
    {field: "pricingDrift", label: "Drft", group: "markets", align: "center",
     title: "Pricing-drift flag — 'drift' = your prices differ from AS's recommended defaults; 'default' = matches. Drift means you've been actively pricing this route.",
     render(td, row) {
        if (!row.pricingDrift) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        if (row.pricingDrift === "drift") {
            td.textContent = "drift"
            td.style.color = "#fbbf24"
        } else {
            td.textContent = "dflt"
            td.style.color = "#9ca3af"
        }
        td.style.fontWeight = "bold"
        if (row.ownPricing && row.ownPriceDefaults) {
            const lines = ["Y / C / F / Cargo prices vs default:"]
            for (const cls of ["Y", "C", "F", "Cargo"]) {
                const o = row.ownPricing[cls]
                const d = row.ownPriceDefaults[cls]
                if (o == null && d == null) continue
                lines.push("  " + cls + ": " + (o != null ? o : "—") + " (default " + (d != null ? d : "—") + ")")
            }
            td.title = lines.join("\n")
        }
    }},

    // ----- ORS Rank (Tier 2b — Online Reservation System scraper) -----
    {field: "orsPrimaryValue", label: "ORS", group: "ors", align: "right", defaultDir: -1,
     title: "Whichever ORS metric you've picked as primary in Settings → ORS Rank. Default is rating-gap (positive = winning vs top competitor). Hover the cell to see ALL rank flavors. Click ▾ to drill into the connection list.",
     render(td, row) {
        if (row.orsHiddenByThreshold) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        const which = RouteAssistantPanel._orsPrimaryColumn || "ratingGapToTop"
        const v = row.orsPrimaryValue
        if (v == null) { td.textContent = "—"; td.style.color = "#6b7280"; return }
        let display = String(v)
        let color = "#fcd34d"
        if (which === "ratingGapToTop") {
            display = (v > 0 ? "+" : "") + v
            color = v > 0 ? "#86efac" : (v < 0 ? "#fca5a5" : "#fcd34d")
        } else if (which === "rankAny" || which === "rankFirstLegOurs"
                || which === "rankAllOurs" || which === "rankNonstop"
                || which === "rankBookable") {
            display = "#" + v
            color = v <= 3 ? "#86efac" : (v <= 10 ? "#fcd34d" : "#fca5a5")
        }
        td.style.color = color
        td.style.fontWeight = "bold"
        const wrap = document.createElement("span")
        wrap.style.cursor = "pointer"
        wrap.style.textDecoration = "underline dotted"
        wrap.textContent = display + " ▾"
        wrap.title = formatOrsRanksTooltip(row)
        wrap.addEventListener("click", (e) => {
            e.stopPropagation()
            const panel = RouteAssistantPanel._currentInstance
            if (panel) panel._openOrsConnectionsDrawer(row)
        })
        td.append(wrap)
    }},
    {field: "orsRankNonstop", label: "RkNS", group: "ors", align: "right", defaultDir: 1,
     title: "Rank of your top all-own NONSTOP connection in the ORS result list. # = position; lower is better.",
     render(td, row) {
        if (row.orsHiddenByThreshold || row.orsRankNonstop == null) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        td.textContent = "#" + row.orsRankNonstop
        td.style.color = row.orsRankNonstop <= 3 ? "#86efac"
            : (row.orsRankNonstop <= 10 ? "#fcd34d" : "#fca5a5")
    }},
    {field: "orsRatingGapToTop", label: "Gap", group: "ors", align: "right", defaultDir: -1,
     title: "Rating gap = (your top connection rating) − (top competitor rating). Positive = winning.",
     render(td, row) {
        if (row.orsHiddenByThreshold || row.orsRatingGapToTop == null) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        const v = row.orsRatingGapToTop
        td.textContent = (v > 0 ? "+" : "") + v
        td.style.color = v > 0 ? "#86efac" : (v < 0 ? "#fca5a5" : "#fcd34d")
        td.style.fontWeight = "bold"
    }},
    {field: "orsCompetitorCount", label: "OrsC#", group: "ors", align: "right", defaultDir: 1,
     title: "Distinct first-leg carriers (other than you) appearing in the cached ORS connection list. Lower = less direct competition in ORS results.",
     render(td, row) {
        if (row.orsHiddenByThreshold || !row.orsConnections || !row.orsConnections.length) {
            td.textContent = "—"; td.style.color = "#6b7280"; return
        }
        const carriers = new Set()
        for (const conn of row.orsConnections) {
            const flightLegs = (conn.legs || []).filter(l => !l.isGround)
            if (!flightLegs.length) continue
            const first = flightLegs[0]
            if (first.isOurs || !first.flightCode) continue
            const m = /^([A-Z0-9]+)/.exec(first.flightCode.trim().toUpperCase())
            if (m) carriers.add(m[1])
        }
        td.textContent = String(carriers.size)
        td.style.color = "#fcd34d"
    }}
]
// Updated in `_render` from settings.routeAssistant.yieldFeedback.varianceWarnPct;
// the column-render closures read it at draw time.
RouteAssistantPanel._varianceWarnPct = 25
// Updated in `_syncRenderContext` from settings.routeAssistant.carriers.showCarrierIntensity.
// Defaults to true so first render before settings load shows the pill.
RouteAssistantPanel._showCarrierIntensity = true

/**
 * Returns the list of view modes (subset of ["all","pax","cargo"]) in
 * which a column should render. Honours an explicit `modes` field if
 * the COLUMNS entry sets one; otherwise derives from the field name so
 * we don't have to tag every entry in the large COLUMNS array.
 *
 * Today only the `paxScore` and `cargoScore` cells are mode-specific
 * (the AS in-game pax/cargo demand badges). Everything else — distance,
 * frequency, competition, profit, fit, market analysis, ORS, etc. — is
 * relevant to both pax and cargo planning so it stays visible in every
 * tab.
 */
RouteAssistantPanel._columnModes = function(col) {
    if (col && Array.isArray(col.modes)) return col.modes
    const f = col && col.field
    if (f === "paxScore")   return ["all", "pax"]
    if (f === "cargoScore") return ["all", "cargo"]
    return ["all", "pax", "cargo"]
}
// Set in _applyCachedOrs from settings.routeAssistant.ors.primaryColumn so the
// per-cell render closure knows which metric to display.
RouteAssistantPanel._orsPrimaryColumn = "ratingGapToTop"
// Live reference to the active panel — render closures need it to open the
// drill-in drawer on click without capturing `this`.
RouteAssistantPanel._currentInstance = null

/**
 * Resolve which numeric value the ORS primary column should display, based
 * on the user's settings.ors.primaryColumn choice. Read by _applyCachedOrs;
 * stays a static helper so it's reachable from outside the instance.
 */
RouteAssistantPanel._resolveOrsPrimary = function(rec, which) {
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

function formatOrsRanksTooltip(row) {
    const lines = ["ORS rank flavors:"]
    const fmt = (v) => v != null ? String(v) : "—"
    lines.push("  any leg ours:        " + fmt(row.orsRankAny))
    lines.push("  first leg ours:      " + fmt(row.orsRankFirstLegOurs))
    lines.push("  all flight legs ours: " + fmt(row.orsRankAllOurs))
    lines.push("  own nonstop:         " + fmt(row.orsRankNonstop))
    lines.push("  first own bookable:  " + fmt(row.orsRankBookable))
    lines.push("Ratings:")
    lines.push("  our top:             " + fmt(row.orsOurTopRating))
    lines.push("  our best nonstop:    " + fmt(row.orsOurBestNonstopRating))
    lines.push("  top competitor:      " + fmt(row.orsTopCompetitorRating))
    lines.push("  rating gap:          " + (row.orsRatingGapToTop != null
        ? (row.orsRatingGapToTop > 0 ? "+" + row.orsRatingGapToTop : row.orsRatingGapToTop)
        : "—"))
    if (row.orsTotalConnections != null) {
        lines.push("Total connections in list: " + row.orsTotalConnections)
    }
    if (row.orsScrapedAt) {
        lines.push("Last scraped: " + new Date(row.orsScrapedAt).toLocaleString())
    }
    lines.push("Click ▾ to drill into the connection list.")
    return lines.join("\n")
}

// ---------- Helpers ----------

function makeBtn(label, title, onclick) {
    const b = document.createElement("button")
    b.textContent = label
    b.title = title
    b.style.cssText = "background:none;border:none;color:#f3f4f6;cursor:pointer;font-size:14px;"
    b.addEventListener("click", onclick)
    return b
}

function smallBtnStyle() {
    return {
        background: "#2563eb",
        color: "#fff",
        border: "none",
        padding: "3px 8px",
        borderRadius: "3px",
        fontSize: "11px",
        cursor: "pointer"
    }
}

function mkInput(type, value) {
    const i = document.createElement("input")
    i.type = type
    i.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;"
    if (type === "number" && value !== null && value !== undefined) i.value = value
    return i
}

/**
 * Generic <select> with a fixed option list. Used for the direction picker.
 */
function mkSelect(options, currentValue) {
    const sel = document.createElement("select")
    sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;"
    for (const opt of options) {
        const o = document.createElement("option")
        o.value = opt.value
        o.textContent = opt.label
        if (currentValue === opt.value) o.selected = true
        sel.append(o)
    }
    return sel
}

/**
 * Min/Max <select> with a list of suggested numeric values plus a "no limit"
 * option. If the currently-saved value isn't one of the suggestions, it gets
 * inserted into the dropdown so the user can see what's currently applied
 * (e.g. they migrated from a free-text input). Returns the <select>; reading
 * `.value === ""` means no limit, otherwise a number string.
 */
function mkSuggestSelect(currentValue, suggestedValues) {
    const sel = document.createElement("select")
    sel.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;width:80px;"

    const noLimit = document.createElement("option")
    noLimit.value = ""
    noLimit.textContent = "no limit"
    sel.append(noLimit)

    const values = (suggestedValues || []).slice()
    if (currentValue !== null && currentValue !== undefined && !values.includes(Number(currentValue))) {
        values.push(Number(currentValue))
    }
    values.sort((a, b) => a - b)

    const seen = new Set()
    for (const v of values) {
        if (seen.has(v)) continue
        seen.add(v)
        const o = document.createElement("option")
        o.value = String(v)
        o.textContent = String(v)
        if (currentValue !== null && currentValue !== undefined && Number(currentValue) === v) o.selected = true
        sel.append(o)
    }
    if (currentValue === null || currentValue === undefined) noLimit.selected = true

    return sel
}

function numOrNull(v) {
    if (v === null || v === undefined || v === "") return null
    const n = Number(v)
    return isFinite(n) ? n : null
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

/**
 * F slice 2 — fallback avatar shown when an enterprise has no cached
 * avatarUrl (or its <img> failed to load). Renders a 32×32 colored
 * tile with the first letter of the name. Color hashes from the
 * name so the same enterprise always gets the same tile — quick
 * visual recognition even without art.
 */
function _initialBadge(name) {
    const span = document.createElement("span")
    const ch = (name || "?").trim().charAt(0).toUpperCase() || "?"
    let h = 0
    for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
    const hue = ((h % 360) + 360) % 360
    span.textContent = ch
    span.style.cssText = "width:32px;height:32px;display:flex;align-items:center;justify-content:center;"
        + "color:#0f172a;font-weight:700;font-size:14px;"
        + "background:hsl(" + hue + ", 60%, 70%);"
    return span
}

/**
 * Numeric <input> with min/max/step/width. Returns "" when the cell is
 * cleared, so the caller's parseFloatOr() can apply the default.
 */
function mkNumberInput(value, opts) {
    const i = document.createElement("input")
    i.type = "number"
    if (opts && opts.min !== undefined)  i.min  = String(opts.min)
    if (opts && opts.max !== undefined)  i.max  = String(opts.max)
    if (opts && opts.step !== undefined) i.step = String(opts.step)
    const width = (opts && opts.width) || "60px"
    i.style.cssText = "background:#0f1623;color:#f3f4f6;border:1px solid #374151;border-radius:3px;padding:1px 4px;font-size:11px;width:" + width + ";"
    if (value !== null && value !== undefined && isFinite(value)) i.value = String(value)
    return i
}

function parseFloatOr(text, fallback) {
    if (text === null || text === undefined || text === "") return fallback
    const n = parseFloat(text)
    return isFinite(n) ? n : fallback
}

/**
 * Compact AS$ formatter: 12,345 → "12.3k", 1,234,567 → "1.23M". Negative
 * values keep the sign so the colour-coded cells read right.
 */
function formatProfit(num) {
    if (num === null || num === undefined || !isFinite(num)) return "—"
    const sign = num < 0 ? "−" : ""
    const abs = Math.abs(num)
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M"
    if (abs >= 1e4) return sign + Math.round(abs / 1e3) + "k"
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "k"
    return sign + Math.round(abs)
}

/**
 * Multiline string spelling out every term that fed into the row's profit
 * estimate. Rendered as a native title tooltip on the $/flt and $/wk cells
 * so users can see exactly how the number was produced.
 */
function formatProfitBreakdown(row) {
    const b = row && row.profitBreakdown
    if (!b) return ""
    const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toLocaleString()
    const fmt2 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(2)
    const fmt3 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(3)
    const fmt4 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(4)
    const ym  = fmt2(b.yieldMultiplier != null ? b.yieldMultiplier : 1)
    const paxLfFrom = b.paxLoadFactorSource === "override"
        ? "pinned override"
        : b.paxLoadFactorSource === "demand"
            ? "from pax demand " + (b.paxScore != null ? b.paxScore + "/10" : "?/10")
            : "fallback (pax demand unresolved)"
    const cargoLfFrom = b.cargoLoadFactorSource === "override"
        ? "pinned override"
        : b.cargoLoadFactorSource === "demand"
            ? "from cargo demand " + (b.cargoScore != null ? b.cargoScore + "/10" : "?/10")
            : "fallback (cargo demand unresolved)"

    const lines = []
    if (b.hasOverride) {
        lines.push("📌 Per-route override active"
            + (b.overrideNote ? " — " + b.overrideNote : ""))
    }
    lines.push("Aircraft: " + (row.aircraftTypeName || "?")
        + " · " + fmt(b.seats) + " seats"
        + (b.cargoCapacityKg ? " · " + fmt(b.cargoCapacityKg) + " kg cargo" : "")
        + " · " + fmt(b.speed) + " km/h")
    lines.push("Distance: " + fmt(b.distanceKm) + " km × 2 = " + fmt(b.distanceRoundTripKm) + " km round-trip")

    // Pax revenue branch
    if (b.seats > 0) {
        lines.push("Pax LF: " + fmt2(b.paxLoadFactor) + " (" + paxLfFrom + ")")
        const yMult = (b.yieldDemandMultiplier != null && b.yieldDemandMultiplier !== 1)
            ? " · demand-adjusted ×" + fmt2(b.yieldDemandMultiplier)
              + " → AS$" + fmt4(b.effectivePaxYield != null ? b.effectivePaxYield : b.yieldPerKm) + "/pax-km"
            : ""
        const ySrc = b.yieldSource === "override" ? " (pinned)" : ""
        lines.push("Pax yield: AS$" + fmt3(b.yieldPerKm) + "/pax-km" + ySrc + yMult)
        const yldUsed = b.effectivePaxYield != null ? b.effectivePaxYield : b.yieldPerKm
        lines.push("Pax revenue = " + fmt(b.seats) + " × " + fmt2(b.paxLoadFactor)
            + " × AS$" + fmt4(yldUsed) + " × " + fmt(b.distanceRoundTripKm)
            + " × " + ym + " (" + (row.aircraftFit || "?") + ") ≈ AS$" + fmt(b.paxRevenue))
    }
    // Cargo revenue branch (only when enabled)
    if (b.cargoYieldPerKgKm > 0 && b.cargoCapacityKg > 0) {
        lines.push("Cargo LF: " + fmt2(b.cargoLoadFactor) + " (" + cargoLfFrom + ")")
        const cyMult = (b.cargoYieldDemandMultiplier != null && b.cargoYieldDemandMultiplier !== 1)
            ? " · demand-adjusted ×" + fmt2(b.cargoYieldDemandMultiplier)
              + " → AS$" + fmt4(b.effectiveCargoYield != null ? b.effectiveCargoYield : b.cargoYieldPerKgKm) + "/kg-km"
            : ""
        const cySrc = b.cargoYieldSource === "override" ? " (pinned)" : ""
        lines.push("Cargo yield: AS$" + fmt4(b.cargoYieldPerKgKm) + "/kg-km" + cySrc + cyMult)
        const cyldUsed = b.effectiveCargoYield != null ? b.effectiveCargoYield : b.cargoYieldPerKgKm
        lines.push("Cargo revenue = " + fmt(b.cargoCapacityKg) + " kg × " + fmt2(b.cargoLoadFactor)
            + " × AS$" + fmt4(cyldUsed) + " × " + fmt(b.distanceRoundTripKm)
            + " × " + ym + " ≈ AS$" + fmt(b.cargoRevenue))
        lines.push("Total revenue = AS$" + fmt(b.paxRevenue) + " + AS$" + fmt(b.cargoRevenue) + " = AS$" + fmt(b.revenue))
    } else if (b.cargoCapacityKg > 0 && b.seats > 0) {
        lines.push("Cargo revenue = 0 (cargo yield is disabled — set Cargo AS$/kg-km in Economics to enable)")
    }

    lines.push("Block hours: " + fmt(b.distanceRoundTripKm) + " / " + fmt(b.speed) + " + 0.5 = " + fmt2(b.blockHours) + " h")
    // Age penalty line (if active) — explains why effective fuel/h differs
    // from the base setting.
    if (b.ageFuelMultiplier != null && b.ageFuelMultiplier > 1) {
        const ageStr = b.aircraftAge != null ? fmt2(b.aircraftAge) : "?"
        lines.push("Age penalty: AS$" + fmt(b.fuelCostPerHour) + "/h × (1 + "
            + fmt3(b.fuelAgePenaltyPerYear) + " × " + ageStr + " yr) = ×"
            + fmt2(b.ageFuelMultiplier) + " → AS$" + fmt(b.effectiveFuelPerHour) + "/h")
    }
    // Cost breakdown — only show non-zero lines
    const costLines = []
    const fuelHourly = b.effectiveFuelPerHour != null ? b.effectiveFuelPerHour : b.fuelCostPerHour
    if (b.fuelCost > 0) {
        if (b.fuelMethod === "perType" && b.fuelLiters != null && b.fuelPriceASc) {
            costLines.push("Fuel " + fmt(b.fuelLiters) + " L × " + fmt2(b.fuelPriceASc) + " ASc/l ÷ 100 = AS$" + fmt(b.fuelCost))
        } else {
            costLines.push("Fuel AS$" + fmt(fuelHourly) + "/h × " + fmt2(b.blockHours) + " = AS$" + fmt(b.fuelCost))
        }
    }
    if (b.crewCost > 0)        costLines.push("Crew AS$" + fmt(b.crewCostPerHour) + "/h × " + fmt2(b.blockHours) + " = AS$" + fmt(b.crewCost))
    if (b.maintenanceCost > 0) costLines.push("Maint AS$" + fmt(b.maintenanceCostPerHour) + "/h × " + fmt2(b.blockHours) + " = AS$" + fmt(b.maintenanceCost))
    if (b.otherFixedPerFlight > 0) costLines.push("Other AS$" + fmt(b.otherFixedPerFlight) + "/flt")
    if (costLines.length > 1) {
        lines.push("Cost = " + costLines.join(" + ") + " = AS$" + fmt(b.totalCost))
    } else if (costLines.length === 1) {
        lines.push("Cost = " + costLines[0] + (b.totalCost !== b.fuelCost ? " (+ ...) = AS$" + fmt(b.totalCost) : ""))
    } else {
        lines.push("Cost = AS$" + fmt(b.totalCost))
    }
    lines.push("$/flt = AS$" + fmt(b.revenue) + " − AS$" + fmt(b.totalCost) + " = AS$" + fmt(b.profitPerFlight))
    if (b.frequency > 0 && b.profitPerWeek !== null) {
        lines.push("$/wk = AS$" + fmt(b.profitPerFlight) + " × " + b.frequency + " flights/wk = AS$" + fmt(b.profitPerWeek))
    } else {
        lines.push("$/wk = — (you don't fly this route yet)")
    }

    // Append actuals comparison when a snapshot exists for this row. The
    // Actuals columns repeat much of this; mirroring it here gives the user a
    // single tooltip with the full forecast-vs-actual story when they hover
    // the existing $/flt cell.
    if (row.actualProfitPerFlight !== null && row.actualProfitPerFlight !== undefined) {
        lines.push("")
        lines.push(formatActualsBreakdown(row))
    }
    return lines.join("\n")
}

/**
 * Multiline string describing the actuals snapshot for a row — tail mix,
 * frequency, variance vs estimate, and a tiny ASCII sparkline showing the
 * stored history. Used by the Actual $/flt + Δ% column tooltips and tacked
 * onto the bottom of formatProfitBreakdown when a snapshot is present.
 */
function formatActualsBreakdown(row) {
    if (!row || row.actualProfitPerFlight === null || row.actualProfitPerFlight === undefined) {
        return "Actuals: no snapshot — click \"Snapshot yields now\" in Settings."
    }
    const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toLocaleString()
    const modeStr = row.actualSnapshotMode === "delta"
        ? "delta — $/flt across flights flown SINCE the prior snapshot"
        : "cumulative — lifetime average $/flt per tail (toggle Delta mode in Settings)"
    const lines = ["Actuals (" + modeStr + "):"]
    const taken = row.actualSnapshotAt ? new Date(row.actualSnapshotAt).toLocaleString() : "?"
    lines.push("  $/flt actual = AS$" + fmt(row.actualProfitPerFlight)
        + " · $/wk actual = AS$" + fmt(row.actualProfitPerWeek)
        + " (freq " + (row.actualFrequency != null ? Math.round(row.actualFrequency) : "?") + ")")
    if (row.actualVariancePct !== null && row.actualVariancePct !== undefined) {
        const v = row.actualVariancePct
        lines.push("  Δ vs estimate: " + (v > 0 ? "+" : "") + v + "%"
            + (v > 0 ? " — outperforming the estimator" : v < 0 ? " — underperforming" : ""))
    }
    if (Array.isArray(row.actualAircraftTypes) && row.actualAircraftTypes.length) {
        lines.push("  Tails: " + row.actualContributingTails + "/" + (row.actualTotalKnownTails || row.actualContributingTails)
            + " known · types: " + row.actualAircraftTypes.join(", "))
        if (row.actualTotalKnownTails && row.actualContributingTails < row.actualTotalKnownTails) {
            const missing = row.actualTotalKnownTails - row.actualContributingTails
            lines.push("  ⚠ " + missing + " tail" + (missing > 1 ? "s" : "")
                + " missing profit data — visit each aircraft's history page to fill in.")
        }
    }
    const spark = formatActualsSparkline(row.actualSnapshots)
    if (spark) lines.push("  History: " + spark + "  (oldest → newest)")
    lines.push("  Snapshot: " + taken)
    return lines.join("\n")
}

/**
 * Solve for the base pax yield that would make the rough estimator's
 * predicted profit match the latest snapshot's actual $/flt at the row's
 * current LF / aircraft / cost mix. Returns null when the math can't run
 * (no snapshot, no breakdown, no seats, zero distance).
 *
 * Derivation:
 *   actualProfit = effYield × seats × paxLF × distRT × yieldMult − totalCost
 *   ⇒ effYield = (actualProfit + totalCost) / (seats × paxLF × distRT × yieldMult)
 *   baseYield = effYield / yieldDemandMult
 *
 * Pure-pax for v1 — leaves cargo yield untouched. Cargo-only routes return
 * null (the cargo yield calibration is a separate flow).
 */
/**
 * Multiline tooltip describing the per-class seat allocation, weekly seats
 * offered, and class-aware revenue + cost breakdown. Powers the Seats/wk
 * column tooltip; pulls everything from row.classBreakdown so the panel
 * doesn't have to re-derive the math.
 */
function formatServiceBreakdown(row) {
    if (!row || !row.classBreakdown) {
        return "Service breakdown unavailable — pick an aircraft + ensure live route data is captured."
    }
    const fmt = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toLocaleString()
    const fmt4 = n => (n === null || n === undefined || !isFinite(n)) ? "—" : Number(n).toFixed(4)
    const cb = row.classBreakdown
    const mix = row.classMix || {}
    const lines = []
    lines.push("Service profile: " + (row.serviceLevel || "?")
        + (row.serviceLevelSource === "route" ? " (route override)" : " (default)"))
    if (cb.serviceLevelYieldMult != null && cb.serviceLevelYieldMult !== 1) {
        lines.push("  Service yield multiplier ×" + cb.serviceLevelYieldMult.toFixed(2)
            + " · +AS$" + Math.round(cb.serviceLevelPerPaxCost || 0) + "/pax")
    }
    lines.push("Class mix: Y " + Math.round((mix.Y || 0) * 100)
        + "%  C " + Math.round((mix.C || 0) * 100)
        + "%  F " + Math.round((mix.F || 0) * 100) + "%"
        + (row.classMixSource === "route" ? "  (route override)" : "  (default)"))
    lines.push("")
    lines.push("Per flight                              Per week")
    for (const cls of ["Y", "C", "F"]) {
        const c = cb.classes[cls]
        if (!c || !c.seats) continue
        lines.push("  " + cls + "  " + c.seats + " seats × LF "
            + (cb.classes[cls].seatsFilled / Math.max(1, c.seats)).toFixed(2)
            + " · y AS$" + fmt4(c.yieldPerKm)
            + (c.yieldOverride ? " (pin)" : "")
            + "  rev AS$" + fmt(c.revenuePerFlight)
            + " / wk AS$" + fmt(c.revenuePerWeek))
        lines.push("       cost AS$" + fmt(c.costPerFlight)
            + " (AS$" + c.costPerPax + "/pax"
            + (c.costOverride ? " pin" : "") + ")"
            + " / wk AS$" + fmt(c.costPerWeek)
            + " · seats/wk " + fmt(c.weeklySeats))
    }
    lines.push("")
    lines.push("Total revenue: AS$" + fmt(cb.totalRevenuePerFlight)
        + "/flt · AS$" + fmt(cb.totalRevenuePerWeek) + "/wk")
    lines.push("Total class-cost: AS$" + fmt(cb.totalCostPerFlight)
        + "/flt · AS$" + fmt(cb.totalCostPerWeek) + "/wk")
    lines.push("(class cost is catering/lounge/comfort-kit per filled seat —"
        + " block-hour costs stay on the $/flt column.)")
    return lines.join("\n")
}

function derivedYieldFromActuals(row) {
    if (!row) return null
    const actual = numOrNull(row.actualProfitPerFlight)
    if (actual === null) return null
    const b = row.profitBreakdown
    if (!b || !b.seats || b.seats <= 0) return null
    if (!b.distanceRoundTripKm || b.distanceRoundTripKm <= 0) return null
    const lf = numOrNull(b.paxLoadFactor)
    if (lf === null || lf <= 0) return null
    const yMult = numOrNull(b.yieldMultiplier) || 1
    const yDemand = numOrNull(b.yieldDemandMultiplier) || 1
    const denom = b.seats * lf * b.distanceRoundTripKm * yMult
    if (denom <= 0) return null
    const targetEff = (actual + (b.totalCost || 0)) / denom
    const base = targetEff / (yDemand || 1)
    if (!isFinite(base) || base < 0) return null
    return base
}

/**
 * 8-step ASCII sparkline (▁▂▃▄▅▆▇█) over the snapshot $/flt timeline. Single
 * data point gets a flat bar; identical values render as the lowest cell.
 */
function formatActualsSparkline(snapshots) {
    if (!Array.isArray(snapshots) || !snapshots.length) return null
    const values = snapshots.map(s => Number(s.profitPerFlight)).filter(v => isFinite(v))
    if (!values.length) return null
    if (values.length === 1) return "▄"
    const blocks = "▁▂▃▄▅▆▇█"
    let lo = Infinity, hi = -Infinity
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v }
    if (hi === lo) return blocks[0].repeat(values.length)
    const span = hi - lo
    return values.map(v => {
        const idx = Math.min(blocks.length - 1, Math.max(0, Math.floor((v - lo) / span * (blocks.length - 1))))
        return blocks[idx]
    }).join("")
}

/**
 * One-line summary of an override record, used as the pin glyph's tooltip
 * so the user can see what's pinned without opening the editor.
 */
function formatOverrideSummary(override) {
    if (!override) return ""
    const parts = []
    if (typeof override.paxLF === "number")             parts.push("Pax LF " + override.paxLF.toFixed(2))
    if (typeof override.cargoLF === "number")           parts.push("Cargo LF " + override.cargoLF.toFixed(2))
    if (typeof override.yieldPerKm === "number")        parts.push("Yield AS$" + override.yieldPerKm.toFixed(3) + "/pax-km")
    if (typeof override.cargoYieldPerKgKm === "number") parts.push("Cargo AS$" + override.cargoYieldPerKgKm.toFixed(4) + "/kg-km")
    let s = "Override: " + (parts.length ? parts.join(" · ") : "(no values)")
    if (override.note) s += "\n— " + override.note
    return s
}

/**
 * Multi-line tooltip body for the colored Cmp pill — Letter F.
 *
 * Source-of-truth priority:
 *   1. AS market-share data (`row.marketSharePax`) — preferred when
 *      present. Real AS competitors with `enterpriseId` (so we can
 *      build a link), share %, and rank ordering. Native `title=""` is
 *      plain text only, so the IDs are mentioned but NOT clickable —
 *      that ships in F slice 2 (custom DOM popover).
 *   2. flightsfrom carrier list (`carriers` arg) — real-world airlines.
 *      Used when AS market-share hasn't been scraped for this route yet.
 *   3. Fallback messaging when neither source is populated.
 */
function formatCarriersTooltip(row, carriers, intensity) {
    const lines = []
    const intensityLabel = intensity ? intensity.toUpperCase() + " competition" : ""

    const asShares = Array.isArray(row.marketSharePax) ? row.marketSharePax : []
    if (asShares.length) {
        // Primary path: AS-native competitor list.
        const period = row.marketSharePeriod ? " · " + row.marketSharePeriod : ""
        lines.push(asShares.length + " AS competitor" + (asShares.length === 1 ? "" : "s")
            + period + (intensityLabel ? " · " + intensityLabel : ""))
        lines.push("")
        const ordered = asShares.slice().sort((a, b) => (b.sharePct || 0) - (a.sharePct || 0))
        const cap = Math.min(ordered.length, 12)
        for (let i = 0; i < cap; i++) {
            const e = ordered[i]
            const name = e.name || "(unknown)"
            const share = (e.sharePct != null) ? " — " + e.sharePct.toFixed(1) + "%" : ""
            const id    = (e.enterpriseId != null) ? "  [#" + e.enterpriseId + "]" : ""
            lines.push("  • " + name + share + id)
        }
        if (ordered.length > cap) lines.push("  • +" + (ordered.length - cap) + " more")
        lines.push("")
        lines.push("(F slice 2 will turn each name into a clickable link with the AS banner + avatar.)")
        if (row.marketsScrapedAt) {
            lines.push("Last synced: " + new Date(row.marketsScrapedAt).toLocaleString())
        }
        return lines.join("\n")
    }

    // Secondary path: flightsfrom carrier list.
    const count = (row.totalAirlines != null) ? row.totalAirlines : (row.airlineCount || 0)
    const wk = row.totalCarrierFlights ? (" · " + row.totalCarrierFlights + " flights/wk") : ""
    lines.push(count + " airline" + (count === 1 ? "" : "s") + wk + (intensityLabel ? " · " + intensityLabel : ""))

    if (carriers && carriers.length) {
        lines.push("")
        const cap = Math.min(carriers.length, 12)
        for (let i = 0; i < cap; i++) {
            const c = carriers[i]
            const name = c.name || "(unknown)"
            const freq = c.weeklyFlights ? " — " + c.weeklyFlights + "/wk" : ""
            lines.push("  • " + name + freq)
        }
        if (carriers.length > cap) {
            lines.push("  • +" + (carriers.length - cap) + " more")
        }
    } else if (row.carriersScrapedAt) {
        lines.push("")
        lines.push("Scrape returned no carrier list" + (row.carriersParserNote ? " (" + row.carriersParserNote + ")" : ""))
    } else {
        lines.push("")
        lines.push("Sync flightsfrom (Carriers expander) for real-world carriers, or sync the Markets page (Market Analysis expander) for AS competitors.")
    }

    if (row.carriersScrapedAt) {
        lines.push("")
        lines.push("Last synced: " + new Date(row.carriersScrapedAt).toLocaleString())
    }
    return lines.join("\n")
}

/**
 * Inline banner for the table area. Levels: amber (informational nudge),
 * red (blocker).
 */
function makeBanner(opts) {
    const palette = {
        amber: {bg: "#3a2c11", border: "#92400e", title: "#fbbf24", body: "#fde68a"},
        red:   {bg: "#3f1d1d", border: "#7f1d1d", title: "#fca5a5", body: "#fecaca"}
    }
    const c = palette[opts.level] || palette.amber
    const box = document.createElement("div")
    box.style.cssText = `background:${c.bg};border:1px solid ${c.border};border-radius:4px;padding:8px 12px;margin:6px 0;`
    const h = document.createElement("strong")
    h.textContent = opts.title || ""
    h.style.cssText = `color:${c.title};display:block;margin-bottom:2px;font-size:12px;`
    const p = document.createElement("p")
    p.textContent = opts.body || ""
    p.style.cssText = `margin:0;color:${c.body};font-size:11px;`
    box.append(h, p)
    return box
}
