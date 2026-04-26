# Route Assistant — System Manual

**Companion to HANDOVER.md.** HANDOVER captures session state and "where we are"; this MANUAL is the reference for *how the system works* — every formula, every storage key, every interaction. Read top to bottom or skip to the section you need.

Repo root: `/Users/jihwan/Downloads/AES.v0.6.9-beta/`. Tech: Chrome MV3 extension, vanilla JS + jQuery 3.4.1, no build step. Target site: `https://*.airlinesim.aero/*` and `https://www.flightsfrom.com/*`.

---

## 1 · What this is

The Route Assistant is one feature inside the **AirlineSim Enhancement Suite (AES)** Chrome extension. It mounts a fixed-position side panel on AS's scheduling page (`/app/com/scheduling*`) and answers two questions:

1. **Which destinations are worth flying from this hub?** — by blending real-world demand (flightsfrom.com), AS in-game station demand, the user's existing schedule, and a configurable scoring formula.
2. **Which of my owned aircraft can fly each destination, and roughly what would it earn?** — by joining the user's fleet against route distance and a rough operating-margin estimator.

The panel is **read-only**. It never writes to AirlineSim — the user creates flights manually in AS's scheduler. The panel is a decision-support overlay, not an auto-pilot.

---

## 2 · Quick start

The panel needs three caches populated before it can score routes. After a fresh install:

1. **Open Fleet Management** (`/app/fleets`) once. Captures every aircraft's `typeId` so type specs can be looked up.
2. **Extract your schedule**: `/app/info/enterprises/<your-id>?tab=3` → click "Extract Schedule". Captures your existing weekly frequencies for status flag derivation (NEW/OK/UNDER/OVER).
3. **Seed all countries**: open the AS scheduler (`/app/com/scheduling`), the Route Assistant panel mounts in the bottom-right; click **Seed all countries** in the panel header. One-time per game world (5–15 min). Populates AS station demand 0–10 for every airport.

After that, navigating to any scheduling page mounts the panel and runs three background enrichments:
- distance per route (3-tier resolver)
- type specs per fleet aircraft (one fetch per type)
- demand for any destination not yet in cache

---

## 3 · Architecture

### Directory tree (Route Assistant–relevant files)

```
AES.v0.6.9-beta/
├── manifest.json                          MV3 manifest. The /app/com/scheduling* block lists every Route Assistant module.
├── content_scheduling.js                  Mounts RouteAssistantPanel on the scheduling page; IATA detection.
├── content_flightsFrom.js                 Scraper that runs on www.flightsfrom.com/<IATA>.
├── content_fleetManagement.js             Captures fleet on /app/fleets — including typeId (Phase 2).
├── content_marketScan.js                  Used-aircraft market scanner. Uses AESAircraftTypeSpecs for spec parsing.
├── content_fligthSchedule.js              "Extract Schedule" feature — writes <server><airline>schedule.
│
├── modules/
│   ├── aircraft-type-specs.js             AESAircraftTypeSpecs.fetchById(typeId) — shared with marketScan.
│   ├── flightsfrom/
│   │   ├── data-store.js                  FlightsFromStore — flightsFrom:<IATA> cache.
│   │   └── scan-controller.js             FlightsFromController — orchestrates child-tab scrape + watchdog.
│   ├── station-automation/
│   │   └── country-scraper.js             CountryScraper — AS country pages → demand 0–10.
│   ├── route-assistant/
│   │   ├── demand-store.js                RouteAssistantDemandStore — IATA → demand record + lat/lon.
│   │   ├── country-resolver.js            RouteAssistantCountryResolver — IATA → countryId via cache.
│   │   ├── parallel-scanner.js            RouteAssistantParallelScanner — concurrent CountryScraper, seedAllCountries().
│   │   ├── score.js                       RouteAssistantScore — pure weighted-avg scoring formula.
│   │   ├── aggregator.js                  RouteAssistantAggregator — buildRouteRows + applyFleetContext + applyYieldHistory.
│   │   ├── settings-store.js              RouteAssistantSettings — load/save settings.routeAssistant.
│   │   ├── distance-resolver.js           RouteAssistantDistanceResolver — 3-tier + persistent cache.
│   │   ├── type-specs-store.js            RouteAssistantTypeSpecsStore — routeAssistant:typeSpec:<typeId>.
│   │   ├── fleet-store.js                 RouteAssistantFleetStore — loads <server><airline>aircraftFleet.
│   │   ├── route-overrides-store.js       Per-route LF/yield user overrides — directional cache.
│   │   ├── fuel-price-scraper.js          World fuel-price scrape (table → SVG fallback).
│   │   ├── fuel-burn-estimator.js         Per-type fuel burn heuristic + override.
│   │   ├── profit-estimator.js            RouteAssistantProfitEstimator — pure profit math + pickEconomical.
│   │   ├── ticket-price-scraper.js        Auto-Pricing T1 — scrapes /app/com/scheduling/<HUB><DEST> for live route data. Misnamed; rename deferred. See §18.
│   │   ├── markets-page-scraper.js        Auto-Pricing T2a — /app/com/markets/<HUB><DEST> scraper. 4 split key families. Plus K extension for per-payload historic. See §18 + §22.
│   │   ├── inventory-page-scraper.js      Letter K — /app/com/inventory/<HUB><DEST> RM-bucket scraper. See §22.
│   │   ├── demand-derivator.js            Letter K — pure-function pool/elasticity/RM-tightness derivation. See §22.
│   │   ├── ors-scraper.js                 Auto-Pricing T2b — /app/info/ors GET → POST handshake; circuit breaker. See §21.
│   │   ├── carriers-scraper.js            F slice 1 — flightsfrom.com/<HUB>-<DEST> per-pair carrier list. See §19.
│   │   ├── enterprise-meta-scraper.js     F slice 2 — /app/info/enterprises/<id> meta cache (NOT directional, keyed by COMPETITOR). See §19.
│   │   ├── contractual-partners-scraper.js F slice 3 — /app/info/enterprises/<your_id>?tab=1 partners (NOT directional, keyed by YOUR-OWN). See §19.
│   │   ├── service-config-store.js        Service-config popover state.
│   │   ├── service-profile-scraper.js     /action/enterprise/serviceProfile(s) scrapers. See §24.
│   │   ├── yield-history-store.js         Roadmap G — directional snapshot cache. See §20.
│   │   ├── yield-snapshot.js              Roadmap G — pure attribution engine. See §20.
│   │   └── panel.js                       RouteAssistantPanel — UI: header, picker, table, settings drawer with all expanders.
│   └── used-aircraft-scanner/             See §23 (Used Aircraft Scanner).
│       ├── type-family-map.js             AS_TYPE_TO_FAMILY + AS_FAMILY_CATEGORY + AS_CATEGORY_ORDER + helpers.
│       ├── presets-store.js               UsedAircraftPresets settings CRUD (incl. routeFit thresholds).
│       ├── scan-session-store.js          MarketScanSession — per-scan storage.
│       ├── deal-metrics.js                MarketScanDealMetrics — slice-2 + 4 metrics.
│       ├── results-table.js               MarketScanResultsTable — sortable HTML + CSV. Family column + slice-3 tooltips.
│       ├── scan-controller.js             ScanController — concurrent child-tab orchestrator.
│       └── family-grid-panel.js           MarketScanFamilyGrid — drill-down type picker.
```

### Module responsibilities

| Module | Responsibility |
|---|---|
| `panel.js` | All UI. Mount, refresh, render. Owns DOM lifecycle and event listeners. |
| `aggregator.js` | Pure: takes ffData + demandMap + ownSchedule (+ optional fleetContext) → array of row objects. Also owns `applyFleetContext` which mutates rows in place when fleet/economics change. |
| `score.js` | Pure: weighted-avg normalisation across visible rows. Adds `score` to each row. |
| `profit-estimator.js` | Pure: per-row $/flt, $/wk, blockHours, fit, breakdown. Plus `pickEconomical` for fleet mode. |
| `settings-store.js` | Persists `settings.routeAssistant` block — scoring, filters, aircraft, economics. Deep-fills new fields on load. |
| `distance-resolver.js` | 3-tier fetcher with persistent cache (`routeAssistant:distance:*`). |
| `type-specs-store.js` | Persistent cache for AS aircraft type specs (`routeAssistant:typeSpec:*`). |
| `fleet-store.js` | Loads `<server><airline>aircraftFleet`, pinned by airline code from `ownSchedule`. |
| `demand-store.js` | Persistent cache for AS station demand (`routeAssistant:demand:<IATA>`). |
| `country-resolver.js` | IATA → countryId, cache-only (AS has no per-IATA lookup). |
| `parallel-scanner.js` | Concurrent CountryScraper runner; `seedAllCountries()` walks every AS country once. |

### Data flow on panel mount

```
User opens /app/com/scheduling*
  │
  ▼
content_scheduling.js waits ≤15s for the Wicket editor, then:
  new RouteAssistantPanel({resolveOriginIata}).mount()
  │
  ▼
panel.mount()
  ├─ RouteAssistantSettings.load()           → fills defaults if first run
  ├─ _buildSkeleton()                        → DOM scaffolding
  ├─ _attachStorageListener()                → debounced chrome.storage.onChanged
  └─ panel.refresh()
       ├─ resolveOriginIata()                → 7-fallback IATA detection
       ├─ FlightsFromStore.loadAirport(hub)
       │     └─ if missing/stale → CTA "Scan flightsfrom"
       ├─ panel._loadOwnSchedule()           → finds airline whose latest schedule
       │                                       contains a flight from current hub
       ├─ RouteAssistantFleetStore.loadFleet(server, airlineCode)
       ├─ panel._loadCachedTypeSpecs()       → bulk read for fleet typeIds
       ├─ panel._resolveSelection()          → settles selectedSpec / fleetSpecs
       ├─ RouteAssistantDemandStore.getMany(destIatas)
       ├─ RouteAssistantAggregator.buildRouteRows({hubIata, ffData, demandMap,
       │                                           ownSchedule})
       ├─ panel._applyCachedDistances()      → bulkLoadCache(pairs)
       ├─ RouteAssistantAggregator.applyFleetContext(rows, fleetCtx)
       │                                       (after distances so fit/profit see them)
       ├─ panel._render()                    → table + picker
       ├─ panel._enrichDistancesAsync()      → 4-parallel × 800ms stagger
       │                                       re-applies fleet ctx after each batch
       └─ panel._enrichTypeSpecsAsync()      → same, fetches uncached typeIds
```

User actions that re-trigger the flow:
- **↻ button** → `panel.refresh()` (reads caches, no AS hits).
- **Mode/Aircraft picker change** → `refresh()` (selection might require new spec resolution).
- **Falloff% selector change** → `_recomputeProfit()` (cheap re-aggregate).
- **Economics input typing** → debounced 250 ms → `_recomputeProfit()`.
- **Fleet-flyable checkbox** → `_render()` (filter only).
- **Rescan flightsfrom button** → `FlightsFromController.scan(hub)` → child tab → onChanged listener → `refresh()`.
- **Resolve N demand button** → `RouteAssistantParallelScanner.run(iatas)` → DemandStore writes → onChanged → `refresh()`.
- **Seed all countries button** → `RouteAssistantParallelScanner.seedAllCountries()` (5–15 min) → on completion: `refresh()`.

---

## 4 · Storage layout

All Route Assistant state lives in `chrome.storage.local`. Keys are strings; values are JSON-serialisable objects.

| Key pattern | Writer | Shape |
|---|---|---|
| `settings` | extension-wide | `{routeAssistant: {…}, usedAircraftScanner: {…}, schedule: {…}, …}` |
| `flightsFrom:<IATA>` | flightsfrom scraper | `{iata, scrapedAt, airportName, source, routes: [routeRecord]}` |
| `flightsFrom:<IATA>:status` | flightsfrom scraper | `{iata, scanId, status, error?, progress: {phase, routeCount?}}` |
| `routeAssistant:demand:<IATA>` | DemandStore | `{iata, name?, airportId?, countryId?, paxScore, cargoScore, scrapedAt, lat?, lon?}` |
| `routeAssistant:distance:<MIN>-<MAX>` | DistanceResolver | `{distanceKm, source: "as-scheduling"\|"as-coords"\|"ff-detail", resolvedAt}` |
| `routeAssistant:override:<HUB>-<DEST>` | RouteOverridesStore | `{hub, dest, paxLF?, cargoLF?, yieldPerKm?, cargoYieldPerKgKm?, note?, createdAt, updatedAt}` (directional) |
| `routeAssistant:fuelPriceIndex` | FuelPriceScraper | `{value, unit: "ASc$/l"\|"index", date, scrapedAt, source: "table"\|"svg", sourceUrl, history?}` |
| `routeAssistant:fuelBurnOverride:<typeId>` | FuelBurn editor | `{typeId, cycleL, perKmL, source: "manual", updatedAt}` — overrides spec heuristic |
| `routeAssistant:typeSpec:<typeId>` | TypeSpecsStore | `{typeId, typeName, seats, cargoCapacity, speed, range, paxSatisfaction, fetchedAt}` |
| `routeAssistant:ticketPrice:<HUB>-<DEST>` | ticket-price-scraper.js (Auto-Pricing T1) | `{hub, dest, scrapedAt, source: "live"\|"fetch", flights[], primaryAircraftType, primaryAircraftTypeId, primaryAircraftReg, departureTime, weeklyFlights, dailyFlights[7], daysPerWeek, cruiseSpeedKmh, ourPrice: null, ourYield: null, orsRank: null, fareClasses: null}`. **Directional** — price/freq differ by direction. Tier 2 fields stay null until those scrapers fill them in. File is misnamed (scrapes the scheduling page, not prices) — rename deferred. |
| `routeAssistant:yieldHistory:<HUB>-<DEST>` | yield-snapshot.js (Roadmap G slice 1) | `{hub, dest, snapshots: [{timestamp, profitPerFlight, profitPerWeek, frequency, aircraftTypeNames, aircraftRegistrations, contributingTails, totalKnownTails, attributionMode}], lastSnapshotAt}`. **Directional**. Pruned to `historyLimit` (default 12) on each append. Profit attribution mode: frequency-weighted (default) / distance-weighted / equal. |
| `routeAssistant:topRoutes` | route-assistant/panel.js (`_publishTopRoutes`) | `{hub, server, scrapedAt, count, rows: [{destIata, destName, distanceKm, score, status, paxScore, cargoScore, weeklyFlights}]}`. **Single global key** — overwritten on every panel render with up to 50 visible scored rows. Consumer: Used Aircraft Scanner deal-metrics (route-fit count + frequency-aware capacity check, J slice 4 v3). |
| `routeAssistant:carriers:<HUB>-<DEST>` | carriers-scraper.js (F slice 1) | `{hub, dest, scrapedAt, source: "ff-detail", carriers: [{name, code?, weeklyFlights?, aircraftTypes?: []}], totalAirlines, totalWeeklyFlights, parserNotes?}`. **Directional**. Sourced from `flightsfrom.com/<HUB>-<DEST>` cross-origin fetch. `parserNotes` populated when no carrier markup matched (SPA didn't SSR the list). |
| `routeAssistant:enterpriseMeta:<id>` | enterprise-meta-scraper.js (F slice 2) | `{enterpriseId, server, name, iata?, bannerUrl?, avatarUrl?, scrapedAt, parserNotes?}`. **NOT directional** — enterprise metadata is a property of the enterprise, not the route. Sourced from `/app/info/enterprises/<id>` cross-origin fetch. 90-day default TTL. |
| `routeAssistant:contractualPartners:<enterpriseId>` | contractual-partners-scraper.js (F slice 3) | `{enterpriseId, server, scrapedAt, partners: [{partnerId, partnerName, partnerIata, hqCity?, hqIata?, country?, relations: ["INTERLINING", "ALLIANCE", "LESSOR", ...]}], parserNotes?}`. **NOT directional, AND keyed by *your-own* enterprise id** (not by competitor — opposite to `enterpriseMeta`). One fetch of `/app/info/enterprises/<your_id>?tab=1` yields every partnership the enterprise has. The Cmp popover unions all your-own records into `_partnersByEnterpriseId` and renders glyphs (⇄ for INTERLINING, ✦ for ALLIANCE) next to matching competitor names. 30-day default TTL. |
| `routeAssistant:markets:competitors:<HUB>-<DEST>` | markets-page-scraper.js (Auto-Pricing T2a) | `{hub, dest, scrapedAt, source, competitors: [{flightCode, flightId, typeCode, typeId, depDateUtc, depDateLocal, depTimeUtc, depTimeLocal, arrTimeUtc, arrTimeLocal, serviceClass, availability, price, status, isOurs}]}`. **Directional**. Every competitor flight on the route with actual prices + availability + status. |
| `routeAssistant:markets:ownPricing:<HUB>-<DEST>` | markets-page-scraper.js (Auto-Pricing T2a) | `{hub, dest, scrapedAt, source, prices: {Y, C, F, Cargo}, defaults: {…}, sliderRanges: {Y: [1, 296], …}, generalSettings: {originTerminal, destinationTerminal, serviceProfile, serviceProfileId, boardingPreference, cargoPreference}}`. **Directional**. Snapshot of the markets-page Pricing fieldset; Auto-Pricing T3 write-back will POST against the same endpoint. |
| `routeAssistant:markets:marketShare:<HUB>-<DEST>` | markets-page-scraper.js (Auto-Pricing T2a) | `{hub, dest, scrapedAt, source, period: "17/2026", pax: [{rank, name, enterpriseId, sharePct, change}], cargo: [{…}]}`. **Directional**. Default `shareMaxAgeDays: 7` (weekly cadence). |
| `routeAssistant:markets:historic:<HUB>-<DEST>` | markets-page-scraper.js (Auto-Pricing T2a + K extension) | **K shape:** `{hub, dest, scrapedAt, source, byPayload: {ECONOMY: {periods, capacities, prices}, BUSINESS: …, FIRST: …, PAX: …, CARGO: …}}`. **Directional**. Parsed from inline `lineChart(…).setData([…])` calls. Legacy single-payload records auto-migrated on read by `_migrateHistoricRecord`. |
| `routeAssistant:ors:<HUB>-<DEST>` | ors-scraper.js (Auto-Pricing T2b) | `{hub, dest, scrapedAt, params: {payload, departureH, arrivalH, useGround}, totalConnections, ourFlightIds[], ourCarrierPrefixes[], rankAny, rankFirstLegOurs, rankAllOurs, rankNonstop, rankBookable, ourTopRating, ourBestNonstopRating, topCompetitorRating, ratingGapToTop, connections: [{idx, rating, totalDuration, totalPrice, bookable, legs: [{flightCode, flightId, typeCode, typeId, rating, price, serviceClass, status, isOurs, isGround}]}]}`. **Directional**. Single key per route; ~10KB. **Connections is the source of truth** — every rank flavor is re-derivable, never re-scrape just to display a different metric. |
| `routeAssistant:inventory:<HUB>-<DEST>` | inventory-page-scraper.js (Letter K) | `{hub, dest, scrapedAt, source: "fetch", classes: {Y, C, F, Cargo: {totalSeats, soldSeats, avgFare?}}, departures: [{date, time, totalSeats, sold}], parserNotes?}`. **Directional**. Sourced from `/app/com/inventory/<HUB><DEST>`. RM data is volatile — 3-day default TTL. |
| `routeAssistant:serviceProfilesList` | service-profile-scraper.js | `{profiles: [{id, name, minDistanceKm, isDefault}], scrapedAt}`. Single global key per server. |
| `routeAssistant:serviceProfile:<id>` | service-profile-scraper.js | `{id, name, categories: {drinks: {Y, C, F}, ...}, categoryByPrefix, classScore: {Y, C, F}, scrapedAt}`. Per-profile, sourced from `/action/enterprise/serviceProfile?id=<id>`. classScore ∈ [0..1], normalised across whichever categories the page exposes. |
| `<server><airlineCode>aircraftFleet` | fleet management | `{server, type:"aircraftFleet", airline, fleet: [aircraftRecord]}` |
| `<server><airlineCode>schedule` | schedule extractor | `{type:"schedule", server, airline, date: {YYYYMMDD: {date, updateTime, schedule: [routeRecord]}}}` |
| `<server>aircraftFlights<aircraftId>` | content_aircraftFlights.js | `{aircraftId, server, registration, equipment, date, time, profit, profitFlights, finishedFlights, totalFlights, type:"aircraftFlights"}`. Source for the Roadmap G yield-snapshot attribution. Cumulative-lifetime numbers; slice 2 will subtract previous snapshot's cumulatives for true periodic yield. |

### Distance pair key

`routeAssistant:distance:<MIN>-<MAX>` is **sorted alphabetically**: `JFK-LAX` and `LAX-JFK` share storage. Great-circle is symmetric, so this is correct.

### `flightsFrom:<IATA>.routes` element shape

```js
{
    destIata, destName,
    weeklyFlights,    // upper bound of "X-Y per day" × 7
    seatsPerWeek,     // currently null — not on listing page
    distanceKm,       // currently null — populated lazily by DistanceResolver
    airlines,         // array of length (1 + N) where N = "+N" badge
    aircraft,         // currently null
    detailUrl
}
```

### Aircraft fleet record shape

```js
{
    age,              // years
    aircraftId,       // AS internal id (used in /app/fleets/aircraft/<id>)
    date, time,       // last update timestamp
    equipment,        // type name, e.g. "Boeing 767-300ER"
    typeId,           // AS aircraftsType id (Phase 2 — captured from anchor href)
    fleet,            // user-defined fleet label, e.g. "Default fleet"
    maintanance,      // % (yes, AS spelling)
    nickname,
    note,
    registration,     // tail number
}
```

### Schedule record shape (latest date)

```js
date: {
    "20260415": {
        date: "20260415",
        updateTime: "07:08",
        schedule: [
            {
                origin: "JFK", destination: "ATL",
                od: "JFKATL", direction: "Outbound",
                flightNumber: {
                    "26": {paxFreq: 7, cargoFreq: 0, remark: "", valid: ""}
                }
            },
            …
        ]
    }
}
```

`paxFreq + cargoFreq` summed across all flightNumbers for a destination = `ownTotalFreq` for that destination.

---

## 5 · Settings schema

Lives at `chrome.storage.local["settings"].routeAssistant`. Defined in `modules/route-assistant/settings-store.js:_defaults()`. Defaults are deep-filled on load so new fields don't wipe existing user values.

```js
{
    scoring: {
        paxScore:            {enabled: true,  weight: 2, direction: "higher", min: null, max: null},
        cargoScore:          {enabled: true,  weight: 1, direction: "higher", min: null, max: null},
        weeklyFlights:       {enabled: true,  weight: 1, direction: "higher", min: null, max: null},
        airlineCount:        {enabled: true,  weight: 1, direction: "lower",  min: null, max: null},
        profitPerWeek:       {enabled: false, weight: 2, direction: "higher", min: null, max: null},
        fitOk:               {enabled: false, weight: 2, direction: "higher", min: null, max: null},
        actualProfitPerWeek: {enabled: false, weight: 2, direction: "higher", min: null, max: null}  // Roadmap G — score by realised actuals
    },
    filters: {
        minScore:         null,
        maxDistanceKm:    null,
        statuses:         {NEW: true, OK: true, UNDER: true, OVER: true, OOR: true},
        fleetFlyableOnly: false
    },
    flightsfromMaxAgeDays: 7,
    distanceMaxAgeDays:    null,    // null = never expire
    collapsed:             false,
    panelWidth:            1100,    // px, user-resizable via left-edge drag handle (clamp 600–3000)
    compactView:           false,   // master toggle — hides heavy column groups in one click
    viewMode:              "all",   // "all" | "pax" | "cargo" — tabbed table view
    aircraft: { mode, typeId, registration, falloffPct, showAircraftColumns },
    economics: { /* see above — pax LF/yield, cargo LF/yield, fuel/crew/maint, falloffYieldMultiplier */ },

    // --- Auto-Pricing tiers ---
    pricing: {
        showPricingColumns: true,    // gate the Eq / Dep / Wk columns
        concurrency:        4,
        staggerMs:          800,
        lastBulkScrapeAt:   null,
        priceMaxAgeDays:    null,    // null = never expire
        autonomyMode:       "off",   // off | suggest | oneClick | batch (T2/T3 placeholders)
        silentAutoEnabled:  false,   // separate explicit gate for silent auto-apply (T3)
        targetMargin:       null,
        competitorAdjust:   null
    },

    // --- Roadmap G — yield feedback ---
    yieldFeedback: {
        showColumns:         true,    // gate Act $/flt + Δ%
        varianceWarnPct:     25,
        attributionMode:     "frequency",  // frequency | distance | equal
        historyLimit:        12,
        lastSnapshotAt:      null,
        autoSnapshotOnMount: false,
        deltaMode:           false    // when true, snapshot uses tail.profit DELTA since last snapshot
                                      // (true periodic yield) — slice 2 default
    },

    // --- Letter F — carriers + enterprise meta + contractual partners ---
    carriers: {
        // F slice 1 — flightsfrom carrier list per route
        showCarrierIntensity:      true,
        concurrency:               3,
        staggerMs:                 1200,
        lastBulkScrapeAt:          null,
        carriersMaxAgeDays:        30,

        // F slice 2 — AS-native enterprise enrichment (banner + avatar + name + iata)
        enterpriseMetaConcurrency: 4,
        enterpriseMetaStaggerMs:   600,
        enterpriseMetaMaxAgeDays:  90,    // enterprises rarely rebrand
        lastEnterpriseMetaSyncAt:  null,

        // F slice 3 — contractual partners (alliance / interlining / lessor)
        myEnterpriseIds:           [],     // user's own enterprise ids (canopy users: multiple)
        partnersConcurrency:       2,
        partnersStaggerMs:         400,
        partnersMaxAgeDays:        30,
        lastPartnersSyncAt:        null,
        showInterliningGlyph:      true,   // ⇄ next to IL partners in the popover
        showAllianceGlyph:         false   // ✦ for alliance partners (off by default)
    },

    // --- Auto-Pricing T2a — markets-page scraper ---
    marketAnalysis: {
        showColumns:          true,    // gates Mkt% / Cmp# / Cmp$ / Drft cols
        concurrency:          4,
        staggerMs:            800,
        lastBulkScrapeAt:     null,
        competitorMaxAgeDays: null,    // null = never expire
        shareMaxAgeDays:      7,       // weekly cadence
        historicMaxAgeDays:   null,
        defaultPayloadChart:  "ECONOMY"  // PAX | ECONOMY | BUSINESS | FIRST | FREIGHT
    },

    // --- Letter K — demand depth from market analysis ---
    demandDepth: {
        showDemandColumns:     true,
        classCoverage:         "summary",   // "summary" (PAX+CARGO) | "full" (5 payloads)
        useRealDemandForLF:    false,       // opt-in profit-estimator switch
        concurrency:           3,
        staggerMs:             1200,
        historicWindowPeriods: 12,
        lastBulkScrapeAt:      null,
        historicMaxAgeDays:    null,
        inventoryMaxAgeDays:   3        // RM data is volatile; 3d expiry
    },

    // --- Auto-Pricing T2b — ORS rank ---
    ors: {
        showColumns:                  true,
        concurrency:                  2,       // ORS = expensive AS solver
        staggerMs:                    1500,
        lastBulkScrapeAt:             null,
        rankMaxAgeDays:               7,
        // Default scrape parameters — all surfaced in the expander:
        defaultPayload:               "ECONOMY",  // ECONOMY | BUSINESS | FIRST | CARGO
        defaultDepartureH:            0,           // 0..48
        defaultArrivalH:              72,          // 24..72
        defaultUseGround:             true,
        // Display preferences — every rank flavor surfaceable:
        primaryColumn:                "ratingGapToTop",
        // ratingGapToTop | rankAny | rankFirstLegOurs | rankAllOurs | rankNonstop | rankBookable | ourTopRating | ourBestNonstopRating
        showRankAnyColumn:            true,
        showRankNonstopColumn:        true,
        showRatingGapColumn:          true,
        showCompetitorCountColumn:    true,
        minRatingThresholdDisplay:    null,
        airlineCarrierPrefixOverride: null,        // e.g. "FGM,NYO" for multi-airline users
        // Circuit breaker — bulk button disabled for cooldown after trip:
        circuitBreakerTrippedAt:      null,
        circuitBreakerCooldownMs:     600000       // 10 min
    },

    // --- Service profiles + per-class auto-detect ---
    serviceProfiles: {
        // (Refer to HANDOVER §5 for the per-server cache layout)
        // Cache keys are persisted directly in chrome.storage.local — see §4.
    }
}
```

### Adding a new scoring variable

1. Append to `RouteAssistantPanel.SCORING_FIELDS` (`panel.js`).
2. Add a default to `RouteAssistantSettings._defaults().scoring`.
3. Make sure the row produced by `aggregator.buildRouteRows` carries that field name.
4. Add a column to `RouteAssistantPanel.COLUMNS` if you want it visible in the table.

---

## 6 · Score formula

Implemented in `modules/route-assistant/score.js:RouteAssistantScore.computeScores()`.

For each enabled scoring field:
1. Find min/max of the field across the **visible row set** (i.e. after filtering).
2. Normalise each row's value: `norm = (value − min) / (max − min)`. If `min === max`, `norm = 1`.
3. Direction: `directional = (direction === "lower") ? (1 − norm) : norm`.
4. Weighted sum: `weightedSum += directional × weight`; `weightTotal += weight`.

Final: `score = round(weightedSum / weightTotal × 100)` ∈ [0, 100].

Rows missing a value for an enabled field don't contribute to either numerator or denominator — they are not penalised for missing data.

The score is **relative to the visible row set** — changing filters changes the absolute scores. This is intentional: 100 means "best of what's currently shown," not "best possible."

---

## 7 · Profit estimator

Implemented in `modules/route-assistant/profit-estimator.js:RouteAssistantProfitEstimator.estimate()`. Marked "rough" everywhere. The output has a `breakdown` object the panel renders into a per-cell tooltip.

### Inputs

| From | Field |
|---|---|
| Picked aircraft spec | `seats`, `range`, `speed`, `cargoCapacity` |
| Route data | `distanceKm`, `paxScore`, `cargoScore` |
| Settings.aircraft | `falloffPct` |
| Settings.economics | `loadFactor*`, `cargoLoadFactor*`, `yieldPerKm`, `cargoYieldPerKgKm`, `fuelCostPerHour`, `falloffYieldMultiplier` |
| User's schedule | `frequency` (`ownTotalFreq` for the route) |

### Constants

```js
SAFETY_MARGIN     = 0.95   // matches ScheduleFactors.aircraftCanFly
FIXED_TURN_HOURS  = 0.5    // round-trip taxi+approach overhead
```

### Step 1: Fit class

```
safeRange    = range × 0.95
optimalRange = range × (1 − falloffPct/100)

if   distance > safeRange         → fit = "oor"      (out of range, blocked)
elif distance > optimalRange      → fit = "falloff"  (90–95%, amber)
else                              → fit = "optimal"
```

### Step 2: Block hours

```
blockHours = (distance × 2) / speed + 0.5
```

The `+ 0.5` is a fixed taxi/approach overhead, not a scaling factor. Earlier versions used `/ 0.85` which over-estimated fuel by 30–50% on short-haul; this form is closer to AS reality.

### Step 3: Demand-driven load factors (pax + cargo)

```
paxLF =
  if paxScore is resolved and lfMax >= lfMin:
    lfMin + (paxScore / 10) × (lfMax − lfMin)
  else:
    loadFactor (fallback)

cargoLF =
  if cargoScore is resolved and cargoLfMax >= cargoLfMin:
    cargoLfMin + (cargoScore / 10) × (cargoLfMax − cargoLfMin)
  else:
    cargoLoadFactor (fallback)
```

### Step 4: Yield multipliers (falloff + demand modulation)

```
yieldMult         = (fit === "falloff") ? falloffYieldMultiplier : 1
yieldDemandMult   = (yieldDemandSensitivity > 0 AND paxScore != null)
                  ? clamp(1 + sens × (paxScore − 5)/5, 0.5, 1.5)
                  : 1
cargoYieldMult    = same with cargoYieldDemandSensitivity, cargoScore

effectivePaxYield = yieldPerKm × yieldDemandMult
effectiveCargoYield = cargoYieldPerKgKm × cargoYieldMult
```

`yieldDemandSensitivity` defaults to 0 = flat yield (Phase 2 behaviour). At sensitivity 1, demand 10/10 gives +20% yield, demand 0/10 gives −20% yield (capped). Tune to your game-world economy. Symmetric for cargo.

Fit "oor" returns early — no profit beyond range.

### Step 5: Revenue

```
distanceRoundTrip = distance × 2

paxRevenue   = (seats > 0)
             ? seats × paxLF × effectivePaxYield × distanceRoundTrip × yieldMult
             : 0

cargoRevenue = (cargoCapacity > 0 AND effectiveCargoYield > 0)
             ? cargoCapacity × cargoLF × effectiveCargoYield × distanceRoundTrip × yieldMult
             : 0

revenue      = paxRevenue + cargoRevenue
```

`cargoYieldPerKgKm` defaults to 0 (cargo revenue OFF). Set to a non-zero value (start with 0.0008) to enable.

### Step 6: Costs + profit

Aircraft age scales fuel cost (letter L) when the user opts in. Per-tail mode uses the exact tail age; per-type / Fleet mode uses the average age across owned aircraft of that type.

```
ageFuelMult       = 1 + fuelAgePenaltyPerYear × aircraftAge
                    (clamped to max 2.0; reverts to 1 when penalty = 0
                     or aircraftAge unknown)
effectiveFuelPerHour = fuelCostPerHour × ageFuelMult

fuelCost          = effectiveFuelPerHour × blockHours
crewCost          = crewCostPerHour × blockHours
maintenanceCost   = maintenanceCostPerHour × blockHours
totalCost         = (effectiveFuelPerHour + crewCostPerHour + maintenanceCostPerHour) × blockHours
                  + otherFixedPerFlight
profitPerFlight   = round(revenue − totalCost)
profitPerWeek     = (frequency > 0) ? profitPerFlight × frequency : null
```

`fuelAgePenaltyPerYear` defaults to 0 (no behavioural change). Suggested starting values: `0.005` (0.5%/yr) or `0.01` (1%/yr). Exact AS mechanic is unconfirmed — calibrate from observation. `crewCostPerHour`, `maintenanceCostPerHour`, `otherFixedPerFlight` all default to 0. Once any is set, the breakdown tooltip shows the cost split per cell, including the age multiplier line when it's >1.

### Cargo-only aircraft

When `seats === null || seats === 0` and `cargoCapacity > 0`, the row is flagged `isCargoOnly: true`. If `cargoYieldPerKgKm > 0`, profit is computed from cargo only. If 0 (default), profit columns render `—` with the "cargo aircraft" tooltip.

### Out of scope (currently not modelled)

- Per-route LF / yield overrides (planned — see Roadmap §16, Tier 1).
- Fuel auto-pulled from AS pages (planned — Tier 1).
- Yield-timeline feedback loop / actual-yields (planned — Tier 2).
- ORS-aware pricing simulation (planned — Tier 3 G).
- Wave / interlining / slot management workspace (planned — Tier 3 H).
- Connection traffic uplift (would need network-wide simulation).

---

## 8 · Aircraft fit & fleet selection

### Fit (per row, per chosen aircraft)

See profit estimator step 1. The fall-off zone width is configurable via `settings.aircraft.falloffPct` (default 10 = 90–95% of range is amber).

### Fleet-mode "most economical" pick

Implemented in `modules/route-assistant/profit-estimator.js:pickEconomical()`. When the user picks **Fleet (any owned)**, the aggregator calls this for every row.

Algorithm:
1. For each fleet aircraft, compute its fit class (`optimal` / `falloff` / `oor`) for this route's distance.
2. Find the **highest-priority fit class** present in the fleet (`optimal` > `falloff` > `oor`).
3. Among aircraft in that class, pick the one with the **smallest range**.

This avoids assigning a 777 to a 1500 km regional just because the 777 happens to be the longest-ranged thing in the fleet. The smallest aircraft that can comfortably fly the route is usually the most economical.

The chosen aircraft's type name is stored in `row.aircraftTypeName` so the Fit cell tooltip can show it.

### Type vs Tail mode

Both produce identical numbers — AS aircraft of the same type share spec. Tail-specific fields (age, maintenance, condition) don't affect the profit estimate.

---

## 9 · Status flags

Implemented in `modules/route-assistant/aggregator.js:_statusFor()`. Five statuses, one per row:

| Flag | Rule | Meaning |
|---|---|---|
| `OOR` | `aircraftFit === "oor"` | Selected aircraft can't reach this destination. **Highest priority — overrides all others.** |
| `NEW` | `ownTotalFreq <= 0` | You don't fly this route. Candidate to start. |
| `UNDER` | `paxScore >= 8 AND ownTotalFreq < weeklyFlights/10` | High-demand route where you have <10% of real-world frequency. Room to scale up. |
| `OVER` | `ownTotalFreq > weeklyFlights/5` | You fly more than 20% of real-world frequency. Possibly over-deployed. |
| `OK` | otherwise | Frequency is in line with demand. No action needed. |

When `weeklyFlights = 0` (no real-world reference), only NEW / OK / OOR can apply.

When no aircraft is picked (`fleetContext === null`), `aircraftFit === null` and the OOR check is skipped — only the demand-based statuses apply.

### Adding / tuning thresholds

Edit `_statusFor` in `aggregator.js`. The thresholds (≥ 8 for UNDER, ÷10 for the under-threshold, ÷5 for over) are deliberately conservative — they only flag clear situations.

---

## 10 · Distance resolution tiers

Implemented in `modules/route-assistant/distance-resolver.js`. The three tiers are tried in order; first hit wins. Result is cached forever in `routeAssistant:distance:<MIN>-<MAX>`.

### Tier 1 — AS scheduling URL (most authoritative)

`https://<server>.airlinesim.aero/app/com/scheduling/<HUB><DEST>` renders the route distance in the page header (e.g. "New York (JFK) – Atlanta (ATL) 1,221 km"). This is AS's own number — used for block-time and fuel calculations in-game.

Parse strategy: scan headings (`h1, h2, h3, .as-page-title, header, [class*='heading'], [class*='title']`) for `(\d{1,3}(?:[,\.\s]\d{3})*|\d+)\s*km\b`. Falls back to body text if no heading matches. Plausibility check: 1–25,000 km.

If AS's page doesn't load this for a route (e.g. unreachable from hub, or page format change), tier 2 catches it.

### Tier 2 — AS airport coords + great-circle (fallback)

Fetches `/app/info/airports/<airportId>` for both endpoints, parses lat/lon (3 strategies: schema.org meta, table rows, free text DMS / decimal), Haversine.

`airportId` lives in the DemandStore record (populated by the country scrape). Lat/lon are persisted back into the same DemandStore record on first resolution so subsequent calls are free.

### Tier 3 — flightsfrom detail page (last resort)

`https://www.flightsfrom.com/<HUB>-<DEST>` typically shows a "Distance" line. Parsed via `[class*='distance' i]` selector, falls back to first km value in body.

### Concurrency

`panel._enrichDistancesAsync` runs 4 parallel × 800 ms stagger. Adjustable in `panel.js` if AS rate-limits.

---

## 11 · flightsfrom scraper

`content_flightsFrom.js` runs on `https://www.flightsfrom.com/<IATA>` pages spawned by the FlightsFromController.

### Overall flow

1. Read scan context from URL hash (`#aesFfScan=<scanId>|<IATA>`) or sessionStorage.
2. Wait ≤ 20 s for the routes container to render.
3. Run `loadAllRoutes()` — see below.
4. Extract every `<li class="ff-li-list">`, parse, push to `flightsFrom:<IATA>`.
5. Close the tab on success; leave open on error with a red banner.

### loadAllRoutes() — exhaustive expansion

flightsfrom shows ~30–40 routes by default and hides the long tail behind a `<div class="ff-show-all">Show all destinations</div>` (a `div`, not a button — easy to miss). The loop runs four nudges per round and stops when two consecutive rounds make zero progress:

1. **Dismiss overlays** — close any modal/cookie banner that intercepts clicks. Targets: `.uk-modal-close-default`, `[aria-label='Close']`, text-matched "no thanks / accept / got it".
2. **Scroll the inner routes container** — `findRoutesScrollContainer()` walks up from the first route row to find the nearest scrollable ancestor. Some flightsfrom variants put routes in a fixed-height div; scrolling the window doesn't trigger their lazy-load.
3. **Scroll the window** — for the variants that DO use body scroll.
4. **Click the expand control** — priority order:
   1. `.ff-show-all` div (the canonical control on the routes list).
   2. Any `button / a / div[class*='show-all']` with text matching `(show|load|view|see|display) (more|all|other|additional|further)` or `(more|other) (routes|destinations|flights)`. Skipped if inside `#route-update`, `.ff-mobile-filters`, `.uk-offcanvas`, `.uk-accordion`, `#ff-filters`, `#ff-sort` (those are unrelated sub-sections).
   3. Pagination-next: `a[rel='next']`, `.uk-pagination .uk-active + li a`, `[class*='pagination'] [class*='next']`.

Click is via `clickRobust()` — tries `el.click()` first, falls back to a `mousedown → mouseup → click` MouseEvent sequence for handlers that listen for raw mouse events.

### Per-route extraction

```js
{
    destIata,         // from anchor href "/JFK-LAX" — the half that isn't the hub
    destName,         // <strong> inside the anchor
    weeklyFlights,    // parsed from ".ff-flights-daily" — handles ranges, daily→weekly conversion
    seatsPerWeek:  null,
    distanceKm:    null,   // not on listing — DistanceResolver tier 3 if needed
    airlines,         // [primary, null, null, …] length = 1 + "+N" badge count
    aircraft:      null,
    detailUrl
}
```

Frequency parser handles: "14-16 flights per day", "14 flights per day", "14-16 flights per week", "14 flights weekly". Ranges take the upper bound.

---

## 12 · AirlineSim quirks

The hard-won lessons. Each one is a thing we got wrong at least once.

| Quirk | Reality |
|---|---|
| **Wicket session suffixes** | URLs often have `?239`, `?33` etc. — Wicket version markers. Fetching without the suffix usually still works (server redirects). |
| **Country / region URLs** | `/action/info/countries`, `/action/info/country?id=<id>`, `/action/info/county?id=<id>` — yes, `county` for region pages (USA states, Russia oblasts). |
| **No per-IATA airport lookup** | `/action/info/airports?searchString=` → 404. Treat IATA → airportId as cache-only. Bulk-seed via `seedAllCountries`. |
| **Demand image filenames are 1-indexed** | `<img src=".../demand/<N>.png" alt="pax 8">` where `1.png` = score 0, `11.png` = score 10. `CountryScraper._readDemandBars` subtracts 1. |
| **Airport detail** | `/app/info/airports/<airportId>` — schema.org meta tags for lat/lon (when present), table rows otherwise. |
| **Aircraft type detail** | `/action/enterprise/aircraftsType?id=<typeId>` — labelled rows for seats/cargo/speed/range/popularity. Parser pattern-matches labels (Seats / Capacity / PAX / Total Seats / Cruise speed / Range / Popularity with passengers / etc). |
| **Scheduling page format** | `/app/com/scheduling/<HUB><DEST>` — concatenated 6-character path. Header shows distance in km. |
| **Schedule extraction** | `<server><airlineCode>schedule.date[YYYYMMDD]` — pick the **latest** date when reading. |
| **Server name** | `window.location.hostname.split(".")[0]` (e.g. `free1`, `tristar`). |
| **Wicket form state** | Market scanner pages are stateful — changing Family or Type causes a full-page navigation. The market scanner uses sessionStorage to persist context across navigations. |

### Fleet management page anchors

The equipment column on `/app/fleets/...` renders as `<a href="../../action/enterprise/aircraftsType?id=17210">Boeing 767-300ER</a>`. `content_fleetManagement.js:fltmng_getTypeId()` parses `aircraftsType\?id=(\d+)` from the href. Both write paths (new-record and carry-forward) preserve typeId.

---

## 13 · Panel UI walkthrough

### Layout (top to bottom)

1. **Header** — `Route Assistant` title + ↻ refresh + ⚙ settings + `_` minimise.
2. **Status bar** — Hub IATA · FF route count + age · Demand resolved/total · Distance resolved/total · Specs cached/total · action buttons (Rescan flightsfrom / Resolve N demand / Seed all countries).
3. **Aircraft picker row** (`controlsHost`) — Mode + Aircraft dropdowns + Fall-off% selector + Fleet-flyable checkbox. Hidden when collapsed; shows disabled placeholders when fleet is empty.
4. **Settings drawer** (`settingsHost`) — toggled by ⚙. Contains:
   - Quick presets: Balanced / Chase demand / Avoid competition / Cargo focus.
   - Score weights table — per-variable On/Direction/Weight/Min/Max.
   - Filters row — Min score, Max km, status checkboxes (NEW/OK/UNDER/OVER/OOR).
   - Economics section (live-syncs as you type) — three rows:
     - **Pax**: Yield AS$/km, LF min, LF max, LF base.
     - **Cargo**: Yield AS$/kg-km (default 0 = OFF), LF min, LF max.
     - **Cost**: Fuel AS$/h, Falloff yield.
5. **Banner area** — top of the table. Priority order, only highest renders:
   1. Demand cache empty (purple — `_renderSeedPrompt`).
   2. No fleet found (amber).
   3. Fleet missing typeIds (amber — visit /app/fleets).
   4. Multi-airline ambiguous (amber — extract schedule on intended airline).
6. **Status legend pill bar** — explains each status with a 1-word hint.
7. **Route table** — three column groups, tinted:
   - **(no group)** — Sc, Dest, St (status flag).
   - **AS in-game** (blue tint) — Pax, Crg, Own.
   - **Real-world** (amber tint) — km, FF/w, Cmp.
   - **Aircraft** (green tint, hidden when no aircraft picked) — Fit, Hrs, $/flt, $/wk.

### Cell tooltips

- **Status cells**: hover for the rule in plain English.
- **Fit cells**: hover for the chosen aircraft's type name (relevant in Fleet mode).
- **$/flt and $/wk cells**: hover for the **full math breakdown** — every term that fed into the number, line by line. See `formatProfitBreakdown()` in `panel.js`.

### Sort

Click any column header. Toggles ascending/descending; first click on a fresh column uses the column's `defaultDir`.

### Live recompute paths

Three paths from a settings change to a re-rendered table, in increasing cost:

1. **`_render()`** — re-applies filters, recomputes scores, redraws table. Used by status-checkbox / min-score / max-km changes.
2. **`_recomputeProfit()`** — re-applies fleet context to existing rows + `_renderRows()`. Used by Economics input typing (debounced 250 ms) and Fall-off% selector.
3. **`refresh()`** — full reload from caches. Used by Mode/Aircraft picker changes and external storage events.

The picker dropdowns themselves are **not** rebuilt during enrichment loops — `_renderRows()` skips `_renderControls()`, so a user-opened dropdown stays open while distance/spec batches stream in.

---

## 14 · Common edits

| Want to | Edit |
|---|---|
| Add a new scoring variable | `panel.js:SCORING_FIELDS` + `panel.js:COLUMNS`, default in `settings-store.js:_defaults().scoring`, ensure `aggregator.buildRouteRows` produces the row field. |
| Tune NEW/UNDER/OVER thresholds | `aggregator.js:_statusFor()`. |
| Add a weight preset | `panel.js:WEIGHT_PRESETS`. |
| Change panel size / position | `panel.js:_buildSkeleton()` — `Object.assign(this.root.style, {…})`. |
| Tune flightsfrom selectors | `content_flightsFrom.js:AES_FF.SELECTORS`. |
| Tune AS scheduling distance regex | `distance-resolver.js:parseDistanceFromAsSchedulingHtml + extractKmNumber`. |
| Add a profit input | `settings-store.js:_defaults().economics`, `panel.js:_renderSettings` (Economics section), `profit-estimator.js:estimate` to consume it. |
| Add a new Aircraft column | `panel.js:COLUMNS` (group `"aircraft"`), make sure `aggregator.applyFleetContext` populates the row field. |
| Add a profit breakdown line | `panel.js:formatProfitBreakdown` (push to `lines`). |

### Panel render method cheat-sheet

| Method | What it does | When to call |
|---|---|---|
| `mount()` | One-time DOM build + first refresh | Once per panel lifecycle |
| `refresh()` | Re-read all caches → rebuild rows → render | User clicks ↻, picker change, storage event |
| `_render()` | Re-apply filters/scoring → draw legend + table | Filter/weights/score changes |
| `_renderRows()` | Same as `_render()` but skips picker rebuild | Enrichment batches (preserves dropdown state) |
| `_recomputeProfit()` | applyFleetContext + `_renderRows()` | Economics typing, falloff% changes |
| `_renderControls()` | Rebuild picker dropdowns | Called from `_render()`, picker rebuild |
| `_renderStatusBar()` | Redraw header status bar | Called from `_renderRows()`, progress updates |

---

## 15 · Verification (cold-start checklist)

```
1.  Open chrome://extensions, enable Developer mode, "Load unpacked" →
    select /Users/jihwan/Downloads/AES.v0.6.9-beta. Or hit Reload.
2.  Open AS, log in. Visit /app/fleets — captures aircraft + typeIds.
3.  Visit /app/info/enterprises/<your-id>?tab=3 → "Extract Schedule".
4.  Dashboard → AES → "Flights From" → enter your hub IATA → "Scan airport".
    A new tab opens to flightsfrom.com, dismisses overlay, clicks "Show all
    destinations", scrolls, scrapes, closes (~30–60 s for popular hubs).
5.  Navigate to /app/com/scheduling for the same hub.
    The Route Assistant card mounts bottom-right after ~1 s.
    First-time only: purple "Demand cache is empty" banner.
    Click "Seed all countries" → confirm → wait 5–15 min.
6.  After seed: panel auto-refreshes:
       - Pax/Crg columns populate
       - Score column colour-codes red→green
       - Status flags appear (NEW/OK/UNDER/OVER)
       - Distance enrichment runs (status bar: "Distance: 12/87 resolving…")
       - Specs enrichment runs (status bar: "Specs: 3/3")
7.  Open the Aircraft picker:
       - Mode "Fleet (any owned)" → green Aircraft column group appears
       - $/flt populates per row using picked aircraft's spec
       - Hover any $/flt cell → multi-line breakdown tooltip
8.  Toggle settings drawer (⚙):
       - Type into Yield AS$/km → cells update live (~250 ms debounce)
       - Set Cargo AS$/kg-km to 0.0008 → $/flt grows (cargo revenue contributes)
       - Pick a cargo aircraft (e.g. 767-300F) → $/flt now shows real numbers
9.  Reload the scheduling page — distances appear instantly from cache.
10. Try a different hub → first time repeats step 6 for FF and distances;
    demand is already seeded so that part is instant.
```

### Sanity-check distances

JFK → LAX should be ~3,975 km, JFK → LHR ~5,540 km, JFK → NRT ~10,860 km. Tier 1 (AS scheduling) returns AS's own number; tier 2 (great-circle) and tier 3 (flightsfrom) typically agree within 1–3%. Console logs the source per route:

```
[AES routeAssistant] distance JFK-LAX = 3974 km via as-scheduling
```

If most logs say `via as-coords` or `via ff-detail`, tier 1 isn't matching. Inspect a fetched page manually:

```js
fetch("/app/com/scheduling/JFKLAX", {credentials: "include"})
  .then(r => r.text())
  .then(t => { const m = /(\d{1,3}(?:[,\.\s]\d{3})*|\d+)\s*km\b/.exec(t); console.log(m); })
```

If no `km` match, the page format changed — update `parseDistanceFromAsSchedulingHtml` in `distance-resolver.js`.

### Sanity-check profit

JFK → ATL (1,221 km) with an A320-200 (180 seats, 833 km/h) at default constants should land near:

- Block hours = `(1221 × 2) / 833 + 0.5` ≈ `3.4 h`
- Pax LF (no demand resolved yet) = 0.75 fallback
- Pax revenue ≈ `180 × 0.75 × 0.10 × 1221 × 2 × 1.0` ≈ `AS$33k`
- Fuel ≈ `3.4 × 2500` ≈ `AS$8.5k`
- **$/flt ≈ AS$24k**

After seeding demand (paxScore = 10/10 for ATL): Pax LF jumps from 0.75 → 0.95, revenue ≈ AS$42k, $/flt ≈ AS$33k. Numbers in your panel should land in this neighbourhood; if they're an order of magnitude off, your real `Yield AS$/km` differs from the 0.10 default — adjust in the Economics row until JFK→ATL feels right, then trust the rest.

---

## 16 · Roadmap (letter-coded, prioritised)

Letters are stable across commits and breakdown-tooltip references. Status reflects HANDOVER.md as of v0.6.9-beta — see HANDOVER §9 for the current open-work list.

### Status overview

| Letter | Item | Status |
|---|---|---|
| **A** | Fuel cost automation (world price + per-aircraft burn) | ✅ Shipped Phase 2.7. Scrapes ASc$/l from `/action/portal/index`. When **Auto (per-type fuel)** is on, fuel cost per flight = (cycle_L + per_km_L × dist × 2) × ASc/l ÷ 100. Per-type cycle/per_km from a heuristic (loadProxy + speedClass) calibrated against forum data within ±15%; per-type override available. |
| **B** | Yield-by-demand modulation (pax + cargo) | ✅ Shipped Phase 2.5 |
| **C** | Crew + maintenance + other-fixed costs | ✅ Shipped Phase 2.5 |
| **L** (legacy) | Aircraft-age fuel penalty (`fuelAgePenaltyPerYear`) | ✅ Shipped Phase 2.5. (The letter "L" has since been reassigned to the multi-account canopy roadmap item — see new entry below. The fuel-age penalty does not need a letter any more, retaining the historical row only for traceability.) |
| **D** | Distance cache invalidation | ✅ Shipped Phase 2.6 |
| **E** | Per-route LF / yield override | ✅ Shipped Phase 2.6 |
| **F** | Full carrier list per route + AS-native enterprise enrichment + contractual partners | ✅ **All slices shipped.** Slice 1: per-pair flightsfrom carriers scrape + colored intensity badge. Slice 2: AS-native banner/avatar enrichment via `/app/info/enterprises/<id>` cache. Slice 3 (this session): contractual partners (alliance / interlining / lessor) glyphs in the Cmp popover, sourced from your-own `?tab=1` page. See §19 (Carriers). |
| **G** | Yield-timeline / actual-yields feedback | ✅ **Slice 1 shipped.** Closed-loop estimator-vs-actuals attribution; per-route snapshot history, ASCII sparkline + tail-mix tooltip extension, "Calibrate from actuals" affordance in the per-route override editor. Slice 2 (delta-mode + auto-snapshot + batch-calibrate) deferred. See §20 (Yield Feedback). |
| **H** | Wave + interlining + slot management workspace | Tier 3, ~600 LOC, multi-session. Open. |
| **I** | ORS-aware pricing simulation | ✅ **Slice 1 shipped.** New panel mode (🧪 toggle) + `modules/route-assistant/ors-model.js` (pure-function simulator). Closed-form rating shift (linear-in-percent) → numeric-stable softmax share → pool×share for pax/wk → existing profit estimator with overrides for revenue/profit. Per-route T calibration via cached marketShare leaderboard. Read-only against AS. **Slice 2 deferred:** cargo branch, Save-as-override CTA, multi-route batch sweep, sensitivity sparkline, three-class price sliders, frequency synthesis. See HANDOVER §1 + §10 for the full pipeline + invariants. |
| **J** | Used Aircraft Scanner — GUI + smarter scoring + frequency-aware route-fit | ✅ **Slices 1–4 v3 shipped.** Family-card grid, six deal columns ($/seat, $/seat·km/yr, BE days, Maint pill, Fleet badge, Route-fit), tooltips on every column, and v3 route-fit reads `weeklyFlights` for a weekly-frequency capacity gate. See §23 (Used Aircraft Scanner). |
| **K** | Deeper per-route demand from AS market analysis | ✅ **Shipped.** Per-class historic via `?payload=` query param on the markets page, inventory-page scraper for RM buckets, pure-function demand-derivator computing pool / elasticity / RM tightness. New "Demand depth" expander + 5 scoring fields + 6 columns. Profit estimator gains opt-in `useRealDemandForLF`. Unblocked I. See §22 (Demand Depth). |
| **Auto-Pricing T1** | Live route-data scrape (scheduling page) | ✅ Shipped. `routeAssistant:ticketPrice:<HUB>-<DEST>` carries `dailyFlights[7]`, `weeklyFlights`, primary aircraft + cruise speed. Eq/Dep/Wk columns on the panel. See §18 (Auto-Pricing). |
| **Auto-Pricing T2a** | Markets-page scraper | ✅ Shipped. 4 split key families (`competitors`, `ownPricing`, `marketShare`, `historic`) under `routeAssistant:markets:*:<HUB>-<DEST>`. Mkt%/Cmp#/Cmp$/Drft columns. See §18. |
| **Auto-Pricing T2b** | ORS rank | ✅ Shipped. `/app/info/ors` GET → POST handshake, every connection cached, 5 rank flavors + 4 ratings exposed. Concurrency=2, stagger=1500ms, circuit breaker on 3× consecutive 429/503. See §21 (ORS Rank). |
| **Auto-Pricing T3** | Apply / write-back | **OPEN — HIGH risk.** POST to `/app/com/markets/<HUB><DEST>?<wicket>-pair~form` with `classes:prices:N:newPrice` body. One-click + batch-confirm by default; silent auto-apply behind `settings.pricing.silentAutoEnabled`. |
| **Service Profiles** | Per-tail Y/C/F seats + per-class fares + AS service-profile auto-detect | ✅ Shipped. Replaces manual class-mix / service-level inputs with values scraped from the Fleet, Markets, and serviceProfile pages. See §18 + §24 (Service Profiles). |
| **Tabbed RA view** | Pax / Cargo / All view modes | ✅ Shipped. `settings.routeAssistant.viewMode` gates which scoring fields contribute and which columns render. |
| **L** (new) | Multi-account "canopy" — manage multiple AS accounts as one virtual airline group | **OPEN — Tier 4, ~2000+ LOC, ultimate roadmap target.** Account-vault store, background tab orchestrator, cross-account aggregator, conflict flagging. Prereqs: every existing scraper must become canopy-aware first (refactor work). See HANDOVER §9 row "L (new — user-requested, ultimate goal)" for the full design sketch. |

### Open work (HANDOVER §9 — current as of v0.6.9-beta)

| Item | Tier | Size | Status |
|---|---|---|---|
| **Auto-Pricing T3 — Apply / write-back** | 3 | ~200 LOC | OPEN. Highest-risk gate in the auto-pricing roadmap. Confirmed posture: per-route Apply + batch-confirm modal default, silent auto-apply behind `settings.pricing.silentAutoEnabled`. |
| ~~**I — ORS-aware pricing simulation**~~ | 3 | ~625 LOC | ✅ **Slice 1 shipped.** See HANDOVER §1 (ORS Sandbox) for the full pipeline. Slice 2 (cargo branch, Save-as-override CTA, batch sweep, sensitivity sparkline, three-class sliders, frequency synthesis) deferred. |
| **H — Wave + interlining + slot workspace** | 3 | ~600 LOC | OPEN. Multi-session build. Reuses `modules/schedule-management/`. |
| **G slice 2 — Yield-feedback delta-mode + auto-snapshot** | 2 | ~150 LOC | OPEN. Snapshot-to-snapshot deltas for true periodic yield (currently cumulative averages); auto-snapshot-on-mount; batch "calibrate all flagged" CTA. |
| **J slice 5+ — Scanner roadmap continuation** | 2 | ~80–150 LOC each | OPEN buckets (e.g. break-even tooltip surfacing daily-revenue inputs already on the row). |
| **F slice 4 — IL discovery beyond own enterprise** | 2 | ~80 LOC | OPEN — only relevant if user wants reciprocal-IL detection (currently only your-own page is scraped). |
| **L — Multi-account "canopy"** | 4 | ~2000+ LOC | OPEN — ultimate roadmap target. Prereq: every existing scraper must be canopy-aware first. See HANDOVER §9 for the full design sketch. |

### Tier 3 — large, dedicated planning sessions

#### G — Yield-timeline integration / actual-yields feedback loop

✅ **Slice 1 shipped.** Closed-loop estimator-vs-actuals attribution; per-route snapshot history at `routeAssistant:yieldHistory:<HUB>-<DEST>` (newest 12 by default); ASCII sparkline + tail-mix appended to the existing $/flt tooltip; "Calibrate from actuals" button in the per-route override editor pre-fills the yield value that would make the estimator match the latest snapshot. Attribution mode user-selectable (default: frequency-weighted). See **§19 (Yield Feedback)** for the full algorithm. Slice 2 (delta-mode + auto-snapshot + batch-calibrate) deferred — listed under Open work above.

#### H — Wave + interlining + slot management workspace (~600 LOC, multi-session, OPEN)

The user's mental model: integrate the Route Assistant with the existing `modules/schedule-management/` (which already has `range-buckets.js`, `schedule-builder.js`, `schedule-panel.js`, `presets-store.js`) into a single workspace where they can:
- See all current routes laid out as a wave-and-slot timeline.
- Overlay competitor schedules (sourced from F).
- Plan interlining (sharing flights with partner airlines).
- Manipulate slot allocations and see how proposed changes affect connection-graph and ORS rank.

**Reuse:**
- `ScheduleFactors` (range-buckets.js): default range buckets, `aircraftCanFly`, `kmToNm/nmToKm`, `haversineNm`, `parseHHMM/formatHHMM`, `withinWindow`, `resolveDayMask`. Fully reusable.
- `ScheduleBuilder` (schedule-builder.js): preset → routes → wave assignment → flight evaluation. Already produces wave-aware flight records with warnings.
- `SchedulePresets` (presets-store.js): wave templates, factor blocks.
- `SchedulePanel` (schedule-panel.js): existing UI that's currently isolated to the dashboard.

**New work:**
- `modules/route-assistant/wave-overlay.js` — bridges Route Assistant rows + ScheduleBuilder placements. Given current scoring weights + selected aircraft, produces a "recommended wave structure" by feeding the top-N rows into ScheduleBuilder.assignRoutes().
- `modules/route-assistant/interline-store.js` — track interlining partners per route. `routeAssistant:interline:<HUB>-<DEST>` → `[{partner, productClass, share}]`. Manual entry + UI; later sourced from real AS data if scrapable.
- `modules/route-assistant/slot-store.js` — per-airport slot inventory and planned allocations. Persistent.
- New panel mode: "Wave View" toggle on the existing Route Assistant panel — switches the table to a Gantt-style timeline rendering (hours of day on x-axis, routes on y-axis, wave bands shaded). Click a route to drag/edit its slot.
- Connection-graph computation: given placements, compute how many destination pairs become online connections (within minTransferMinutes / maxTransferMinutes).

**Out of scope for v1:**
- Auto-optimise (LP / heuristic) — start with manual placement + score.
- Multi-hub network optimisation — single-hub view only.

This is a major piece. Worth its own design doc once Tier 1 + F + G are done so the integration points are stable.

#### I — ORS-aware pricing simulation (slice 1 — ~625 LOC, ✅ SHIPPED)

Slice 1 ships a forward-projection layer on top of cached F (carriers + enterprise meta) + G (yield feedback) + K (demand depth) + Tier 2b (ORS rank). New panel mode toggled by 🧪 in the panel header replaces the table with a per-route pricing simulator. Read-only against AS — no scraping, no writes back to the game in slice 1.

**Module split:**
- `modules/route-assistant/ors-model.js` (~510 LOC, NEW) — pure-function simulator. Public API `RouteAssistantOrsModel.project({route, scenario, modelParams, economics, useRealDemandForLF})` returning `{baseline, projected, delta, perClass, notes, modelParams, scaledPrices, …}`. Plus `calibrateTemperature({allRatings, ourIndices, observedShare})` (bisection over `[1, 200]`) and `findOurInLeaderboard(marketSharePax, ourEnterpriseId)`. Reuses `RouteAssistantProfitEstimator.estimate` with `override.paxLF` / `override.yieldPerKm` for the revenue/cost half — slice 1 is a thin layer on existing plumbing.
- `panel.js` (~1380 LOC of additions) — header toggle + render branch + 5 supporting render methods + settings drawer expander + right-click menu split.

**Pipeline:**
1. **Rating projection** (per cabin class). `newRating = clamp(base − α_price × ΔpriceRatio + α_comfort × Δcomfort, [0.5×, 1.5×] × base)`. Linear-in-percent (NOT log-ratio). Defaults α_price = 8 (rating points per ±100% price), α_comfort = 5 (per service-level step). Mutates only "every-leg-ours" connections; mixed-ownership multi-leg connections (interline) keep their rating fixed.
2. **Rank projection.** Re-sort cached `byClass.<class>.connections[]` (top 50) by mutated rating descending; mirror `RouteAssistantOrsScraper.computeRanks` to derive `rankAny / rankFirstLegOurs / rankAllOurs / rankNonstop / rankBookable`.
3. **Share projection.** Numeric-stable softmax `weights = exp((rating − maxRating) / T)`; `ourShare = sum(weights[i] for i in ourIndices) / sum(weights)`. Default T = 25; per-route override populated by Calibrate-T button.
4. **Pax/week.** `paxDemandPool × ourShare`, with the pool first scaled by `(newPriceY/observedPriceY)^paxElasticity` when both are present.
5. **Revenue/profit.** `RouteAssistantProfitEstimator.estimate({distanceKm, spec, frequency, paxScore, paxDemandPool, override: {paxLF, yieldPerKm}, economics, useRealDemandForLF, …})`.

**UI structure:**
- Header strip: title · `<HUB>→<DEST>` route label · "↗ Open route in AS" link · "Pick another" button. Empty state shows a route-picker dropdown sourced from `this.scoredRows.filter(r => r.orsByClass)`.
- Two-column body: Scenario card (Y price multiplier slider + C/F preview labels + frequency input + comfort selector + Calibrate-T button + global-vs-perRoute T banner) and Outcome card (3-column Base / Projected / Δ table for rating, rank, share, pax/wk, rev/wk, profit/wk).
- Notes footer — every model caveat surfaced as a list (clamped rating, mixed-ownership rows, no own connection, no demand pool, etc.).

**Drill-in:** 🧪 header toggle (`settings.routeAssistant.orsSandbox.enabled`) and right-click row menu — 2-item ("Modify yield / LF…" preserves existing override-editor muscle memory + "Open in ORS Sandbox 🧪" routes to `_openInOrsSandbox`).

**Mutual exclusion** with Wave View: branch order in `_renderRows` is Wave View → ORS Sandbox → table. Wave wins when both flags are on.

**Calibrate-T:** solves the softmax equation for T given the cached `marketShare.pax[]` row matching `settings.carriers.myEnterpriseIds[0]`. Refuses when marketShare missing, our enterprise not in leaderboard, or `Math.abs(scrapedAt_marketShare − scrapedAt_ors) > 7 days`. Persists per-route under `settings.routeAssistant.orsSandbox.perRouteTemperature[<HUB>-<DEST>]`. Returns the closer endpoint when target share is unbracketable in `[1, 200]` (informative — user reads "T = 200" as "share can't be fully reproduced from rating alone").

**Slice 2 deferrals:** cargo branch (parallel cargo elasticity + share projection from `byClass.CARGO`); "Save scenario as route override" CTA writing paxLF/yieldPerKm/serviceLevel; multi-route batch sweep; sensitivity sparkline; three-class price sliders (independent Y/C/F adjustments); frequency synthesis (option b — generate connection rows when freq exceeds current); auto-calibrate-on-mount; warning banner when calibration is unbracketed.

**Slice 2c — per-route per-class rating-price elasticity (✅ shipped).** Replaces the global `α_price = 8` with a per-route per-class value derived from observations logged on every ORS scrape. Pipeline:

1. **Observation log** at `routeAssistant:ratingObservations:<HUB>-<DEST>` (directional, append-only, FIFO cap 50, 90d age prune). Each scrape's `_logRatingObservation` (inside `ors-scraper.js`, NOT panel — bulk syncs covered) joins the saved ORS record's `byClass.<cls>.ourTopRating` with the matching markets-page `ownPricing.prices[<cls>]`, plus per-class connection counts (own + competitor), `comfortLevel`, and timestamps for both scrapes. Auto-log default `true` (stable across versions; flagged in settings-store comment).
2. **Per-class regression** in `RouteAssistantDemandDerivator._ratingPriceElasticity(observations, cls, notes, opts)` — five confounder filters (>24h pricing/ORS gap, comfort change, ownConnections delta ≥ 1, competitor count churn > 20%) + sample floor (≥ 4 surviving) + range gate (max-min priceDev% ≥ 8% lever arm) + distinct-bucket gate (≥ 2 buckets at 1% rounding) + OLS via existing `_linregSlope` + slope→magnitude negation + non-monotone reject + `[0, 50]` clip. Returns `{alpha, usedCount}` per class; pushes per-skip notes to `ratingDerivationNotes` so the UI can surface the gating reason.
3. **Cascade resolver** in `panel.js:_recomputeOrsSandbox`. Per-class α resolution order: **override > derived (≥minObs) > siblingDerived > fleetMedian > global default**. Sibling cascade is single-hop (only fires from classes whose source on this route is exactly `derived`). Fleet-median computed across all rows once per `_applyCachedDemand` pass, skipped when fewer than 5 routes contributed (small-sample medians are unstable). The global default is `settings.orsSandbox.modelParams.ratingPriceElasticity` (default 8) — unchanged from slice 1.
4. **Sign convention.** α is stored everywhere as a positive magnitude in `[0, 50]`. The OLS slope is naturally negative on well-behaved routes; negate ONCE inside `_ratingPriceElasticity`. The model formula at `ors-model.js:466` keeps its existing `base − α × priceRatio` shape (no `Math.abs` at the consumer). Reads use `Number.isFinite`, never `||`, so a user override of `0` ("rating doesn't respond to price for this class on this route") is honored.
5. **Manual override store** at `routeAssistant:ratingAlpha:<HUB>-<DEST>` (sibling to `route-overrides-store`, kept SEPARATE because the existing `_clean` uses full-replace semantics that would silently erase α fields on every override save without them). Optional `{Y, C, F}` fields, range `[0, 50]`. The override-editor UI is a collapsed `<details>` expander mounted INSIDE the Outcome card via `_buildOrsSandboxAlphaExpander(result, route)`; each row shows the resolved α + source label and lets the user pin a manual value. Save wraps in `_undoableSave`.
6. **Notes footer.** Model emits one source-labeled line per class: "α=6.2 (derived from 12 observations)" / "α=8.5 (borrowed from sibling class on this route)" / "α=7.1 (fleet median, n=14)" / "α=8 (global default — no per-route data yet)". Plus all derivation-skip reasons from the regression's confounder pipeline.
7. **Cold-start UX.** Slice 2c does literally nothing on day one. As scrapes accumulate observations passing the gates, derivation kicks in per class. The cascade ensures partial-coverage routes (e.g. user only adjusts Y prices) still get sensible C/F αs from the sibling-class on the same route, then fleet median, only falling through to the global default when nothing else applies. Surface visible in the per-class α expander's "auto: X (source)" hint text + the model's notes footer.
8. **Settings drawer.** `_renderOrsSandboxSection` adds an "Auto-log rating observations on every ORS scrape" checkbox + a total observation count + a destructive "Reset all observations" button (confirms before wiping; manual α overrides are NOT touched).

#### J — Used Aircraft Scanner overhaul

✅ **Slices 1, 2, 3, 4 v3 all shipped.** See **§22 (Used Aircraft Scanner)** for the full per-slice breakdown.

#### K — Deeper per-route demand from AS market analysis

✅ **Shipped.** See **§21 (Demand Depth)** for the full design + per-class historic + RM bucket parsing + demand-derivator.

### Tier 4 — speculative / explicit non-goals

| Item | Notes |
|---|---|
| AS rate-limit backoff | The ORS scraper already has a circuit breaker (3× consecutive 429/503 → 10-min cooldown). Other scrapers don't yet — speculative. |
| AS scheduling-page state side-effects | HANDOVER §7. Watch for Wicket session weirdness from tier-1 distance fetches. |
| Schedule writing | Out of scope until Auto-Pricing Tier 3 ships and proves the write-back pattern. |
| Aircraft purchasing from panel | Out of scope until user asks. |
| Per-route load factors from competitor schedules | Subsumed by K + I; not pursued. |
| **L (multi-account canopy)** | Listed under Open work above. ~2000+ LOC. Tier 4 only because it requires every existing scraper to become canopy-aware first. |

---

## 17 · Open invariants (don't break these without checking)

From `HANDOVER.md §12` plus Phase 2 additions:

- Every `chrome.storage.local` key prefix in §4 must remain stable. Other parts of the extension (other features, the user's existing data) read them.
- `SCORING_FIELDS[i].field` must match `COLUMNS[i].field` for every variable that's both scored and displayed.
- `RouteAssistantSettings.load()` always returns a fully-populated object with every field. Never assume a freshly-loaded settings object lacks a field.
- `_pairKey()` in `distance-resolver.js` is **alphabetically sorted** — anything that reads `routeAssistant:distance:*` keys must use the same sort.
- Phase 1 + QoL + Phase 1.5 + Phase 2 + Phase 2.5 are all in production. Don't rip out features without checking — the user has tuned settings.
- Cargo revenue defaults to OFF (`cargoYieldPerKgKm: 0`). Don't change this default; existing users would see surprise number shifts.
- The aggregator's `applyFleetContext(rows, null)` clears every fleet-derived field. Calling it with `null` must reset to a clean Phase-1-style row.
- **Cache key direction rules.** Symmetric (alphabetically sorted): `distance-resolver.js`. Directional (`<HUB>-<DEST>`): `ticket-price-scraper.js`, `yield-history-store.js`, `route-overrides-store.js`, `carriers-scraper.js`, `markets-page-scraper.js` (all 4 families), `ors-scraper.js`, `inventory-page-scraper.js`. Per-enterprise non-directional: `enterpriseMeta:<id>` (keyed by competitor), `contractualPartners:<enterpriseId>` (keyed by *your-own*). Different rule per file; easy to mix up.
- **`enterprise-meta-scraper.js` cache is keyed by competitor enterprise id.** Same record reused across every route the enterprise competes on. Don't add HUB/DEST.
- **`contractual-partners-scraper.js` cache is keyed by *your-own* enterprise id.** The record's *contents* tell you who that enterprise's partners are; the popover then matches partner ids against visible competitor ids. Don't repurpose for competitor-pulls without changing the consumer logic.
- **F slice 3 popover glyphs read `_partnersByEnterpriseId`** which is built by `_applyCachedContractualPartners()`. Called from `init()` after `_applyCachedEnterpriseMeta()` and again after every refresh. New ways for partners data to land must call it (or glyphs go stale until next mount).
- **Tabbed view (`viewMode`)** — `RouteAssistantPanel._columnModes(col)` and SCORING_FIELDS `modes` array gate visibility per tab. The "all" tab MUST keep every field active. New scoring/column entries that should hide on focused tabs need an explicit `modes` array; entries without one default to all three.
- **Yield Feedback v1 stores cumulative-average $/flt** per route, not periodic deltas. `aircraftFlights` source is itself cumulative; G slice 2 needs to subtract previous snapshot's cumulatives for true periodic yield. Don't change this without updating slice-2 expectations.
- **`dailyFlights` is always a 7-element array** (Mon→Sun); `weeklyFlights = dailyFlights.reduce(+, 0)`; `daysPerWeek = dailyFlights.filter(>0).length`.
- **Markets-page split storage** — `routeAssistant:markets:*:<HUB>-<DEST>` is **4 sibling key families**, not one blob. Always read via `RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {families: [...]})`. Writers MUST go through `saveAllRecords` — direct writes risk leaving the families out of sync.
- **ORS `connections` array is the source of truth for all rank flavors.** Adding a new rank metric is ALWAYS a pure-function read against `connections`, never a re-scrape. User explicitly chose "MAXIMISE OPTIONS" — store maximum data, filter at render time.
- **ORS Wicket per-route handshake.** Each `RouteAssistantOrsScraper.scrape()` does GET → POST. Do NOT share a wicket session across the bulk batch — page-version IDs increment per interaction; reusing a stale session returns a `PageExpiredException` HTML page that parses as zero results (silent corruption).
- **ORS circuit breaker is mandatory.** First HTTP 429/503 increments `_consecutiveErrors`; 3 in a row halts the bulk run, persists `settings.ors.circuitBreakerTrippedAt`, disables the bulk button for `circuitBreakerCooldownMs` (default 10 min). Never silently retry through rate limits.
- **`isOurs` detection in ORS** does **flight-number set match first, carrier-prefix fallback second** (option C of three offered). Multi-enterprise users: both schedules contribute prefixes via `getOurCarrierPrefixes`.
- **`routeAssistant:topRoutes` is slim by design.** Only the fields the Used Aircraft Scanner consumes (`destIata`, `destName`, `distanceKm`, `score`, `status`, `paxScore`, `cargoScore`, `weeklyFlights`). Adding fields grows the per-render storage write — confirm a new consumer before extending.
- **`MarketScanDealMetrics.decorate()` mutates the row it's given.** `MarketScanResultsTable._enrichDeal` always passes a fresh `Object.assign({}, r)` copy — new callers must do the same to avoid stomping `this.rows`.
- **J slice 4 v3 route-fit gates are sequential.** Range → per-flight demand → weekly frequency. Routes that lack `weeklyFlights` skip the weekly gate (no penalty). Adding a fourth gate must follow the same "skip if input missing" pattern, not "fail closed".

---

## 18 · Auto-Pricing (Tier 1 + 2a + 2b shipped, Tier 3 open)

End-to-end roadmap for the per-route pricing surface. Four-tier rollout, user-confirmed:

- **Tier 1 — visibility (shipped).** `modules/route-assistant/ticket-price-scraper.js` scrapes `/app/com/scheduling/<HUB><DEST>` for live route data: assigned aircraft (registration + typeId + name), departure time, **per-day flight counts** (`dailyFlights[7]` Mon→Sun), weekly total (`weeklyFlights`), cruise speed. Live-capture on visit + bulk-sync CTA in the rose-tinted "Live route data" expander. Three columns under the `pricing` group: **Eq**, **Dep**, **Wk** (e.g. `12 2222211` = 12/wk, 2x Mon–Fri + 1x weekends). Multi-daily fully captured. Misnomer note: file is named `ticket-price-scraper.js` but currently scrapes the scheduling page (no prices on that page) — rename deferred until a real pricing scraper lands.
- **Tier 2a — Markets page (shipped).** `modules/route-assistant/markets-page-scraper.js` covers `/app/com/markets/<HUB><DEST>` for: every competitor flight with prices + availability + status, your own pricing form snapshot (Y/C/F/Cargo current + default + slider ranges), market-share leaderboard (pax + cargo, with previous-period link), and 25-week historic capacity/price chart data. Storage **split across 4 directional key families** (`competitors`, `ownPricing`, `marketShare`, `historic`) so each can have its own freshness window. Live-capture via `content_markets.js` + bulk-sync CTA in the teal-tinted "Market Analysis" expander. Four columns under the `markets` group: **Mkt%**, **Cmp#**, **Cmp$**, **Drft** (drift vs AS defaults).
- **Tier 2b — ORS rank (shipped).** See §21 (ORS Rank) for the full design. Per-route GET → POST handshake against `/app/info/ors`, walks every result page, parses each connection's overall rating + per-leg flight code/ID/aircraft/price/status. Stores **all rank flavors** + ratings + the **full connection list** so any metric is re-derivable at render time without re-scraping. Concurrency=2, stagger=1500ms, circuit breaker on 3× consecutive 429/503.
- **Tier 3 — apply / write-back (OPEN, HIGH risk).** Target endpoint: the markets-page pricing form (`POST` to `/app/com/markets/<HUB><DEST>?<wicket>-pair~form` with `classes:prices:N:newPrice` body fields). Confirmed posture: one-click + batch-confirm by default; silent auto-apply behind `settings.pricing.silentAutoEnabled`. The Tier 2a `ownPricing` cache is the source of "what is currently set" so the apply diff can show before/after.
- **Tier 4 — yield feedback.** Subsumed by Roadmap G; see §20 (Yield Feedback).

**Order is fixed.** No skip-ahead between tiers — a write-back that ships before T2 visibility would be flying blind.

---

## 19 · Carriers (F slices 1 + 2 + 3 — all shipped)

Three-slice progression of the Cmp column on the panel. Builds rich competitor identity from three independent sources.

- **F slice 1 — flightsfrom carrier list** (`modules/route-assistant/carriers-scraper.js`). Per-pair detail-page scraper that the panel calls directly via `fetch(...)` (cross-origin, covered by `host_permissions`, same pattern as distance-resolver tier-3). Three-band competitive-intensity classifier (1 / 2-3 / 4+) feeds a colored pill on the Cmp column. Hover tooltip lists each carrier and weekly frequency. Cache: `routeAssistant:carriers:<HUB>-<DEST>` (directional). Defensive: when flightsfrom doesn't SSR the carrier list, the record stores `parserNotes` and an empty `carriers: []`; the panel falls back to the plain `airlineCount` integer in that case.
- **F slice 2 — AS-native enterprise enrichment** (`modules/route-assistant/enterprise-meta-scraper.js`). Fetches `/app/info/enterprises/<id>` per AS competitor seen in the markets-page leaderboard. Caches `{name, iata, bannerUrl, avatarUrl}` at `routeAssistant:enterpriseMeta:<id>`. **NOT directional** — same record serves every route the enterprise competes on. 90-day default TTL (enterprises rarely rebrand). Cmp pill replaces its native `title=""` with a custom DOM popover (hover-open with 200ms delay, 250ms grace on leave, click-to-pin, Escape/outside-click dismiss). Each row in the popover shows avatar + clickable name link to `/app/info/enterprises/<id>` + banner + share% + ▲/▼ change + rank, sorted by share. Falls back to the plain-text tooltip when `marketSharePax` is empty.
- **F slice 3 — Contractual partners glyphs** (`modules/route-assistant/contractual-partners-scraper.js`). Reads the user's own enterprise's "Contractual partners" tab (`/app/info/enterprises/<your_id>?tab=1`) and surfaces partner glyphs in the popover: ⇄ (green) for INTERLINING, ✦ (purple, off by default) for ALLIANCE. **NOT directional, AND keyed by your-own enterprise id** (opposite to F2). One fetch per own enterprise yields the entire partner list (alliance + interlining + lessor + any future relation types). Multi-enterprise (canopy-style) users can list multiple comma-separated IDs; `_partnersByEnterpriseId` unions every partner set. Captures relation tags verbatim so unknown future relation types still surface.

**Open follow-up — F slice 4** (~80 LOC, OPEN): reciprocal-IL detection by also fetching each visible competitor's `?tab=1`. Currently only your-own page is scraped, so an asymmetric agreement (where they list you but you don't list them) wouldn't surface. Defer until requested.

---

## 20 · Yield Feedback (Roadmap G — slice 1 shipped)

Closed-loop estimator-vs-actuals. Takes the live-route-data cache (which lists assigned tails per route) and joins with each tail's `<server>aircraftFlights<id>` profit record to derive per-route actuals. The estimator becomes self-tuning over weeks of play.

**Files:** `modules/route-assistant/yield-history-store.js` (`RouteAssistantYieldHistoryStore` — directional cache with bulk load + append + history-limit prune), `modules/route-assistant/yield-snapshot.js` (`RouteAssistantYieldSnapshot` — pure attribution engine), plus extensions to `aggregator.js`, `panel.js`, `settings-store.js`.

### Attribution

For each tail in the user's fleet, look at its `aircraftFlights` cumulative `profit` and `finishedFlights`. Derive `profitPerFlight = profit / finishedFlights`. Then attribute that tail's profit-per-flight to the routes it flies, using one of three modes:

- **frequency** (default) — tail's profit-per-flight × its weekly flights on the route. Sum across all contributing tails for the route's `actualProfitPerWeek`.
- **distance** — weight by route distance × frequency.
- **equal** — equal split across the routes the tail covers.

### Storage

`routeAssistant:yieldHistory:<HUB>-<DEST>` → `{hub, dest, snapshots: [{timestamp, profitPerFlight, profitPerWeek, frequency, aircraftTypeNames, aircraftRegistrations, contributingTails, totalKnownTails, attributionMode}], lastSnapshotAt}`. Pruned to `historyLimit` (default 12) on each append. **Directional**.

### Display

- New **Actuals** column group on the panel: **Act $/flt** (latest snapshot) and **Δ%** (vs. estimator).
- ASCII sparkline + tail-mix appended to the existing $/flt breakdown tooltip.
- New **Calibrate from actuals** button in the per-route override editor — pre-fills the yield input with the value that would make the estimator match the latest snapshot at the current LF / spec.

### Limits (slice 1)

- Snapshots only see routes whose ticket-price record has been scraped (run "Sync route data" first).
- Tails the user hasn't visited via `/app/fleets/aircraft/<id>/1` won't have profit data.
- Profits are *cumulative* per tail — v1 stores cumulative averages.

### Slice 2 (deferred, OPEN)

Delta-mode (snapshot-to-snapshot subtraction for true periodic yield), per-status `VAR+`/`VAR−` flag in the status column, auto-snapshot-on-mount, batch "calibrate all flagged routes". ~150 LOC.

---

## 21 · ORS Rank (Auto-Pricing Tier 2b — shipped)

Scrapes the **true** ORS sort from `/app/info/ors` — the actual sort the AS demand model runs against. NOT the markets-page market-share leaderboard (which is a per-period booking outcome, a different metric).

**File:** `modules/route-assistant/ors-scraper.js`.

### Scrape flow

Per-route GET → POST handshake (Wicket session can't be shared across the bulk batch — page-version IDs increment per interaction; reusing a stale session returns a `PageExpiredException` HTML page that parses as zero results — silent corruption). After the GET harvests Wicket session + form action, the POST sends:

- `origin-group:…:origin = <full airport name>`
- `destination-group:…:destination = <name>`
- `payload = radio0|radio1|radio2|radio3` (Y/C/F/Cargo)
- `departure-group:…:departure = <0-48>` (hours window start)
- `arrival-group:…:arrival = <24-72>` (hours window end)
- `ground:useGroundNetwork = on|off`

Result page walks `.navigation a.next` until exhausted. Each `<tbody class="bookable|unbookable">` is one connection; `<tr class="totals">` carries the connection-level rating. Sample: 77 connections / 3 pages for JFK→LAX.

### What's stored

`routeAssistant:ors:<HUB>-<DEST>` keeps the **full connection list** so any new metric is a pure-function read; never re-scrape just to display a different metric. Five rank flavors + four ratings derived at scrape time:

- `rankAny` — among all connections
- `rankFirstLegOurs` — first-leg-is-ours connections only
- `rankAllOurs` — all-legs-ours connections only
- `rankNonstop` — nonstop connections only
- `rankBookable` — bookable connections only
- `ourTopRating` — best rating among any of our connections
- `ourBestNonstopRating` — best rating among our nonstops
- `topCompetitorRating` — best rating among any non-ours connection
- `ratingGapToTop` — `ourTopRating - topCompetitorRating` (signed; positive = winning)

### `isOurs` detection

Flight-number set match first, carrier-prefix fallback second (option C of three offered). Flight-number set comes from the `<server><airline>schedule` cache. Multi-enterprise users: both schedules contribute prefixes via `getOurCarrierPrefixes`.

### Concurrency + circuit breaker

- Default concurrency=2, stagger=1500ms (per-route 2-request handshake cost).
- First HTTP 429/503 increments `_consecutiveErrors`. **3 consecutive errors** halts the bulk run, persists `settings.ors.circuitBreakerTrippedAt`, and disables the bulk button for `circuitBreakerCooldownMs` (default 10 min).

### UI

Amber-tinted "ORS Rank" expander with controls for payload, departure/arrival window, ground-network toggle, primary column dropdown (8 rank flavors), per-column visibility, carrier-prefix override, min display threshold. Four columns under the `ors` group: **ORS** (user-selected primary metric), **RkNS** (nonstop rank), **Gap** (rating gap to top competitor), **OrsC#** (distinct first-leg competitors). Per-row drill-in drawer (▾ icon) renders the cached connection list lazily — no re-fetch.

---

## 22 · Demand Depth (Letter K — shipped)

Replaces the 0–10 station-level demand proxy with **real per-route demand pool size + price elasticity**, derived from the markets-page historic chart (per-payload) plus the inventory page's RM buckets. Unblocks I (ORS-aware pricing simulation) which depends on real demand inputs.

**Files:** `modules/route-assistant/inventory-page-scraper.js` (NEW), `modules/route-assistant/demand-derivator.js` (NEW), extensions to `markets-page-scraper.js` (per-payload historic), `aggregator.js`, `panel.js`, `settings-store.js`, `profit-estimator.js`.

### Source 1 — per-class historic from markets page

`/app/com/markets/<HUB><DEST>?payload=ECONOMY` (and `BUSINESS`, `FIRST`, `PAX`, `CARGO`) — issuing the request with the `payload` query param toggles which dataset the inline `lineChart(…).setData([…])` blocks render. Up to 5 payloads × 25 weeks = 125 weekly data points per route per class.

`routeAssistant:markets:historic` shape (K):
```js
{hub, dest, scrapedAt, source,
 byPayload: {
   ECONOMY:  {periods, capacities, prices},
   BUSINESS: {periods, capacities, prices},
   FIRST:    {…},
   PAX:      {…},
   CARGO:    {…}
 }}
```

Legacy single-payload records auto-migrated on read by `_migrateHistoricRecord`; the next scrape persists the new shape.

### Source 2 — RM buckets from inventory page

`/app/com/inventory/<HUB><DEST>` — exposes the revenue-management bucket allocations + sold seats per departure. Cache: `routeAssistant:inventory:<HUB>-<DEST>`.

```js
{hub, dest, scrapedAt, source: "fetch",
 classes: {Y, C, F, Cargo: {totalSeats, soldSeats, avgFare?}},
 departures: [{date, time, totalSeats, sold}],
 parserNotes?}
```

3-day default TTL (RM data is volatile). Multi-strategy parser; falls back gracefully when AS markup shifts.

### Demand-derivator (pure-function)

`modules/route-assistant/demand-derivator.js` reads markets historic + inventory and computes:

- **Pool size** — average weekly capacity over the last N periods (default 12).
- **Price elasticity** — regression of price-vs-capacity-vs-bookings over the historic window. Negative coefficient = elastic.
- **RM tightness** — sold-vs-allocated ratio per class (today's snapshot only — needs a longer history to be useful).

### UI

- New **"Demand depth"** expander in the settings drawer. Class coverage toggle (`summary` = PAX+CARGO, `full` = 5 payloads), `useRealDemandForLF` opt-in, concurrency / stagger / TTLs.
- 5 new scoring fields surfaced via the existing scoring config (pool size, elasticity, RM tightness, etc.).
- 6 new columns in the Demand Depth column group.

### Profit-estimator integration

When `settings.routeAssistant.demandDepth.useRealDemandForLF === true`, the estimator's `step3DemandLoadFactor` reads the derived pool size + elasticity instead of the 0–10 paxScore mapping. **Default flipped to `true`.** When the demand-pool inputs are missing (route not yet scraped), the estimator silently falls back to paxScore-interpolated LF — no user-visible disruption. Existing users with persisted `false` keep their preference via the deep-merge in `RouteAssistantSettings.load`.

### Automatic flow (the "seamless" wiring)

K's pieces shipped earlier than the wiring that delivers them automatically. Every cog in the chain is now triggered by the same single Markets-sync click + an on-mount stale check:

1. **Single-button fold.** `_runBulkMarketScrape()` is the canonical entry point. It runs three phases in one orchestration pass:
   - Phase 1 — markets families (`competitors`, `ownPricing`, `marketShare`).
   - Phase 2 — `bulkScrapeHistoric(pairs, payloads)` with `payloads` from `settings.demandDepth.classCoverage` (default `"full"` → all 5; `"summary"` → PAX + CARGO).
   - Phase 3 — `inventoryScraper.bulkScrape(pairs)` for RM tightness.
   Status text cascades through `_marketStatusEl` and `_demandStatusEl`. Persists `lastBulkScrapeAt` on both `marketAnalysis` and `demandDepth` blocks. Final calls: `_applyCachedMarkets()`, `_reapplyServiceProjection()`, `_applyCachedDemand()`, `applyFleetContext`. The standalone Demand Depth sync stays as a granular fallback.
2. **Auto-stale-refresh on mount.** `_maybeAutoRefreshMarketsAndDemand()` runs after `init()` finishes its synchronous cache application. Skip cases: `marketAnalysis.autoRefreshOnMount === false`, no hub or rows, both `lastBulkScrapeAt` values fresher than `staleThresholdDays` (default 14), or `lastAutoRefreshSkipAt` within the threshold window. Otherwise renders a banner above the table announcing "Auto-refresh starting in 5s" with a Skip button (sets `lastAutoRefreshSkipAt`); the actual sync fires 5s later. Banner self-clears after 10s or when the scrape begins.
3. **Per-cell diagnostic tooltips.** `RouteAssistantPanel._demandTooltip(field, row)` builds a multi-line `td.title` for every demand cell. When the cell has data: shows the "what does this column mean" preamble + "Last derived: N day(s) ago" + STALE flag if `_demandIsStale(row)`. When em-dash: shows the preamble + the row's `demandNotes` (e.g., "pax elasticity skipped — only 2 valid points") + a CTA pointing to the Markets sync.
4. **Per-cell freshness shading.** When `RouteAssistantPanel._demandIsStale(row)` returns true, the demand columns render in `#9ca3af` (grey) instead of their normal colour. Pure render-time decoration; no extra fetches.

### Settings — auto-flow keys

```js
marketAnalysis: {
    …
    autoRefreshOnMount:    true,     // gate the on-mount stale check
    staleThresholdDays:    14,       // also drives the per-cell shading
    lastAutoRefreshSkipAt: null      // user pressed Skip; suppressed for staleThresholdDays
},
demandDepth: {
    …
    classCoverage:        "full",    // default: 5 payloads (was "summary")
    useRealDemandForLF:   true,      // default: ON (was off)
    historicMaxAgeDays:   14         // align cache TTL with auto-refresh cadence
}
```

`RouteAssistantPanel._demandStaleThresholdDays` is mirrored from `settings.marketAnalysis.staleThresholdDays` in `_syncRenderContext`. Defaults to 14 if missing.

---

## 23 · Used Aircraft Scanner (J slices 1 + 2 + 3 + 4 v3 — all shipped)

**Mounts in:** dashboard panel at `/app/enterprise/dashboard*`. **Files:** `modules/used-aircraft-scanner/`, `content_marketScan.js` (child-tab worker).

Concurrent child-tab scan of the AS used aircraft market across a preset list of types. Family + type filter automation; type-spec enrichment via `/action/enterprise/aircraftsType?id=`; sortable results table with scoring + filtering; route-range filter; CSV export; session resume across panel reloads; "Open offer" deep-link via Wicket-state replay.

### Slice 1 — GUI overhaul

- `family-grid-panel.js` — `MarketScanFamilyGrid` drill-down picker (chips strip, category filter, search, custom-add input, expandable per-family disclosures).
- `type-family-map.js` — `AS_FAMILY_CATEGORY` map, `AS_CATEGORY_ORDER`, `TypeFamilyMap.category()` / `categoryColor()` / `familyList()`.
- `results-table.js` — Family column + 4px color rail on the leftmost cell.

### Slice 2 — smarter deal-scoring

`deal-metrics.js` (NEW) provides pure-function helpers:

- `pricePerSeat` — `acquisitionPrice / seats`. Lower is better.
- `seatKmYearCost` — `price / (seats × range × max(1, 25 − age))`. Lifecycle ratio. Lower is better.
- `daysToBreakEven` — uses `RouteAssistantSettings.economics`. `price / dailyProfit` at the user's current panel-yield assumptions. Returns null when daily profit ≤ 0.
- `fleetSynergy` — binary by typeId (same type = no extra training, shared maintenance, common parts pool). Family-level synergy NOT counted (AS doesn't share crew ratings across family).
- `routeFit` — counts how many of the user's top-N scored Route Assistant routes the aircraft can profitably fly. Sequential gates (range → demand → frequency); see slice 4 v3 below.
- `maintenanceTrajectory` — coarse red/amber/green pill from condition + age (worst-case rule wins).

`results-table.js` exposes six new columns ($/seat, $/seat·km/yr, BE (days), Maint pill, Fleet badge, Route-fit) and four new scoring fields. `pricePerSeat` enabled by default in the score blend; the rest opt-in. `presets-store.js` deep-merge ensures existing user blobs gain the new keys without resetting tuned siblings.

`content_dashboard.js` `loadDealContext(server)` loads RA fleet (synergy), RA economics (break-even math), `routeAssistant:topRoutes` (route-fit count), and the routeFit config. Best-effort: any failure leaves the metric as null and the cell as em-dash.

`modules/route-assistant/panel.js` `_publishTopRoutes(visible)` writes a slim snapshot (top-50 visible scored rows: `destIata`, `destName`, `distanceKm`, `score`, `status`, `paxScore`, `cargoScore`, `weeklyFlights`) to a single global key `routeAssistant:topRoutes` on every render.

### Slice 3 — tooltips on every deal column

`results-table.js` exposes `_formatPricePerSeatTooltip` / `_formatSeatKmYearTooltip` / `_formatBreakEvenTooltip` / `_formatMaintTooltip` / `_formatFleetTooltip` / `_formatRouteFitTooltip`. The breakdown helpers (`daysToBreakEvenBreakdown`, `seatKmYearCostBreakdown`) retain every intermediate (daily revenue, daily cost subcomponents, hours assumption) on the row at decorate-time, so tooltips render directly from cached numbers — no recomputation. Inner-pill `title` attributes on Maint and Fleet are removed so the long tooltips win over the short pill ones.

### Slice 4 v3 — frequency-aware route-fit

`routeFit()` runs three sequential gates per topRoutes entry:

1. **Range:** `aircraft.range ≥ route.distanceKm`
2. **Per-flight demand:** `seats × LF ≥ paxScore × paxSeatsPerScorePoint` (default scale 15 → paxScore=10 needs 150 effective seats per flight)
3. **Weekly frequency** (NEW v3): `weeklyFlights × seats × LF ≥ paxScore × weeklyDemandPerScorePoint` (default scale 100 → paxScore=10 needs 1000 effective weekly seats; a 150-seat narrowbody at LF 0.75 needs ~9 flights/wk)

Each gate is independently counted (`rangeOnly`, `demandLimited`, `frequencyLimited`) and surfaced in the label `x / y  (−A demand, −B freq)`. Routes lacking `weeklyFlights` skip the freq gate (no penalty — Tier 1 hasn't seen them yet). Tooltip surfaces all three gates so users can see *why* a route was rejected.

### Tunables

`settings.usedAircraftScanner.routeFit`:
- `paxSeatsPerScorePoint` (default 15)
- `weeklyDemandPerScorePoint` (default 100)

Both auto-fill via `presets-store.js` deep-merge for older settings blobs.

---

## 24 · Service Profiles + per-class auto-detect

Replaces the manual class-mix / service-level inputs on the panel with values scraped from AS.

**Files:** `modules/route-assistant/service-profile-scraper.js` (NEW), extensions to `markets-page-scraper.js`, `service-config-store.js`, `aggregator.js`, `content_fleetManagement.js`, `panel.js`.

### Source 1 — per-tail Y/C/F seats from Fleet Management

`content_fleetManagement.js` extracts the "Y/C/F" column on `/app/fleets` (e.g. "217/30/0") into `seatsY`, `seatsC`, `seatsF` on each tail's fleet record. Aggregator uses these as the **second-priority class-mix source** (after per-route override, before settings default).

### Source 2 — per-class fares from Markets page

`markets-page-scraper.js` `_parseOwnPricing` reads the Pricing fieldset on `/app/com/markets/<HUB><DEST>`. Aggregator's `_applyServiceProjection` resolves per-class effective yield as: route override → `ownPricing[cls] / distance` (scraped) → defaults. Per-class `yieldSource` exposed on the breakdown.

### Source 3 — Service profile assignment + per-class catering scores

Same scraper grabs the `serviceProfileId` from the General Settings fieldset's `<select>`. New `RouteAssistantServiceProfileScraper` fetches:

- `/action/enterprise/serviceProfiles` — list of profiles with `{id, name, minDistanceKm, isDefault}`
- `/action/enterprise/serviceProfile?id=<id>` — per-profile catering levels per class

The detail parser robustly walks any 2-letter category prefix + class letter naming convention (`dry/drc/drf` for drinks, `mdy/mdc/mdf` for entrees, etc.) so AS adding new categories doesn't break it. Aggregate `classScore: {Y, C, F}` ∈ [0..1] is normalised across whichever categories the page exposes.

### UI

- **Service-config popover** gains a green "Auto-detected" banner above the inputs listing what AS knows (mix from assigned tail, AS fares per class, AS profile name + per-class quality scores).
- **Settings → Service profiles** — new "AS service profiles auto-detect" sub-block with **Refresh AS service profiles** CTA + cache count + last-sync timestamp.
- **Mix column** color-codes the source (purple = route override, green = from assigned tail, sky-blue = settings default).

### Cache

- `routeAssistant:serviceProfilesList` (single global key per server)
- `routeAssistant:serviceProfile:<id>` (one per profile)
- `routeAssistant:markets:ownPricing:<HUB>-<DEST>.generalSettings.serviceProfileId` (number, alongside the existing label)

### Limits

The coarse Budget/Standard/Premium service-level model is preserved for now — the scraped profile name + quality score is informational (surfaced in Svc tooltip + popover banner). A follow-up slice could let users *score* a route by its profile's classScore directly. Per-pax cost has no AS source — still inherited from settings or manual override.

---

End of manual.
