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
│   └── route-assistant/
│       ├── demand-store.js                RouteAssistantDemandStore — IATA → demand record + lat/lon.
│       ├── country-resolver.js            RouteAssistantCountryResolver — IATA → countryId via cache.
│       ├── parallel-scanner.js            RouteAssistantParallelScanner — concurrent CountryScraper, seedAllCountries().
│       ├── score.js                       RouteAssistantScore — pure weighted-avg scoring formula.
│       ├── aggregator.js                  RouteAssistantAggregator — buildRouteRows + applyFleetContext.
│       ├── settings-store.js              RouteAssistantSettings — load/save settings.routeAssistant.
│       ├── distance-resolver.js           RouteAssistantDistanceResolver — 3-tier + persistent cache.
│       ├── type-specs-store.js            RouteAssistantTypeSpecsStore — routeAssistant:typeSpec:<typeId>.
│       ├── fleet-store.js                 RouteAssistantFleetStore — loads <server><airline>aircraftFleet.
│       ├── profit-estimator.js            RouteAssistantProfitEstimator — pure profit math + pickEconomical.
│       └── panel.js                       RouteAssistantPanel — UI: header, picker, table, drawer.
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
| `<server><airlineCode>aircraftFleet` | fleet management | `{server, type:"aircraftFleet", airline, fleet: [aircraftRecord]}` |
| `<server><airlineCode>schedule` | schedule extractor | `{type:"schedule", server, airline, date: {YYYYMMDD: {date, updateTime, schedule: [routeRecord]}}}` |

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
        paxScore:      {enabled: true,  weight: 2, direction: "higher", min: null, max: null},
        cargoScore:    {enabled: true,  weight: 1, direction: "higher", min: null, max: null},
        weeklyFlights: {enabled: true,  weight: 1, direction: "higher", min: null, max: null},
        airlineCount:  {enabled: true,  weight: 1, direction: "lower",  min: null, max: null},
        profitPerWeek: {enabled: false, weight: 2, direction: "higher", min: null, max: null},
        fitOk:         {enabled: false, weight: 2, direction: "higher", min: null, max: null}
    },
    filters: {
        minScore:         null,
        maxDistanceKm:    null,
        statuses:         {NEW: true, OK: true, UNDER: true, OVER: true, OOR: true},
        fleetFlyableOnly: false
    },
    flightsfromMaxAgeDays: 7,
    distanceMaxAgeDays:    null,    // null = never expire; N = re-resolve cached distances older than N days
    collapsed: false,
    aircraft: {
        mode:                null,    // null | "fleet" | "type" | "registration"
        typeId:              null,    // when mode === "type"
        registration:        null,    // when mode === "registration"
        falloffPct:          10,      // amber-zone width as % of max range
        showAircraftColumns: true
    },
    economics: {
        // Pax
        loadFactor:                  0.75, // pax LF fallback (paxScore unresolved)
        loadFactorMin:               0.50, // pax LF when paxScore = 0
        loadFactorMax:               0.95, // pax LF when paxScore = 10
        yieldPerKm:                  0.10, // AS$ per pax-km (base)
        yieldDemandSensitivity:      0,    // 0–1 — 0 = flat yield, 1 = ±20% by pax demand (clamped)
        // Cargo
        cargoYieldPerKgKm:           0,    // AS$ per kg-km — 0 disables cargo revenue
        cargoLoadFactor:             0.60, // cargo LF fallback (cargoScore unresolved)
        cargoLoadFactorMin:          0.40,
        cargoLoadFactorMax:          0.85,
        cargoYieldDemandSensitivity: 0,    // same idea as pax, for cargo
        // Costs
        fuelCostPerHour:             2500, // AS$ per block hour, fleet average (base / baseline when auto on)
        fuelPriceAutoEnabled:        false,// scale fuelCostPerHour by current÷baseline AS price ratio (letter A)
        fuelPriceBaselineCost:       null, // captured fuelCostPerHour at calibration time
        fuelPriceBaselineValue:      null, // captured fuel price at calibration time
        fuelPriceBaselineUnit:       null, // "ASc$/l" | "index" — guards against scale mismatch
        fuelAgePenaltyPerYear:       0,    // 0–~0.02 — fraction extra fuel per aircraft-year. 0 = OFF.
        crewCostPerHour:             0,    // AS$ per block hour — default 0 = OFF
        maintenanceCostPerHour:      0,    // AS$ per block hour — default 0 = OFF
        otherFixedPerFlight:         0,    // AS$ per round-trip — leasing/insurance/gate amortised
        falloffYieldMultiplier:      0.85  // applied when fit === "falloff"
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

Single source of truth lives at `~/.claude/plans/generic-crunching-pinwheel.md`. This section mirrors it. Letters are stable across commits and breakdown-tooltip references.

### Status overview

| Letter | Item | Status |
|---|---|---|
| **A** | Fuel cost automation (world price + per-aircraft burn) | ✅ Shipped Phase 2.7. Scrapes ASc$/l from `/action/portal/index`. When **Auto (per-type fuel)** is on, fuel cost per flight = (cycle_L + per_km_L × dist × 2) × ASc/l ÷ 100. Per-type cycle/per_km come from a heuristic (loadProxy + speedClass) that calibrates against forum data within ±15%; user can override per type from the settings drawer. |
| **B** | Yield-by-demand modulation (pax + cargo) | ✅ Shipped Phase 2.5 |
| **C** | Crew + maintenance + other-fixed costs | ✅ Shipped Phase 2.5 |
| **L** | Aircraft-age fuel penalty (`fuelAgePenaltyPerYear`) | ✅ Shipped Phase 2.5 |
| **D** | Distance cache invalidation | ✅ Shipped Phase 2.6 |
| **E** | Per-route LF / yield override | ✅ Shipped Phase 2.6 |
| **F** | Full carrier list per route | Tier 2 |
| **G** | Yield-timeline / actual-yields feedback | Tier 3 |
| **H** | Wave + interlining + slot management workspace | Tier 3 |
| **I** | ORS-aware pricing simulation | Tier 3 |
| **J** | Used Aircraft Finder GUI overhaul + smarter scoring | Tier 2/3 |
| **K** | Deeper per-route demand from AS market analysis | Tier 3 (prereq for I) |

### Tier 1 — small, high value (queued)

| Letter | Item | Notes |
|---|---|---|
| **A** | **Fuel cost automation** | Replace flat `fuelCostPerHour` with per-aircraft-type number scraped from AS. ~50–150 LOC depending on source page. Awaiting user pointer. |

### Tier 2 — medium effort

| Letter | Item | Notes |
|---|---|---|
| **F** | **Full carrier list per route** | Scrape `flightsfrom.com/<HUB>-<DEST>` per route, gated by CTA. New cache `routeAssistant:carriers:<HUB>-<DEST>`. Replaces integer Cmp with hover-tooltip + competitive-intensity signal. ~150 LOC. |
| **J** | **Used Aircraft Finder GUI overhaul** | Family-card grid (color-coded boxes), type checklists per family, smarter "best deal" scoring (`$/seat`, days-to-break-even, fleet synergy, route-fit cross-link to Route Assistant). ~400–600 LOC. See plan file for full breakdown. |

### Tier 3 — large, dedicated planning sessions

#### G — Yield-timeline integration / actual-yields feedback loop (~250 LOC)

Track actual realised yield over time per route, compare against the rough estimator's projection, optionally feed back to refine future projections.

**Sources of "actual yields" already in chrome.storage.local:**
- `<server>aircraftFlights<aircraftId>` (written by `content_aircraftFlights.js`) — has `profit`, `finishedFlights`, `profitFlights`, `totalFlights`, `date`, `time` per aircraft. Currently used by the Fleet Management page only.
- Schedule extracts (`<server><airline>schedule.date[YYYYMMDD]`) — gives frequency snapshots over time.

**Algorithm:**
1. **Snapshot job**: every time the panel mounts (or via a manual "Snapshot yields" CTA), walk every aircraft in the fleet, read its `aircraftFlights` profit record, and attribute to the routes that aircraft flies (joined via the schedule extract for the same period). Persist as `routeAssistant:yieldHistory:<HUB>-<DEST>` → `[{timestamp, profitPerFlight, profitPerWeek, frequency, aircraftType}]` time series.
2. **Display**: per-row sparkline / mini-chart in the breakdown tooltip showing actual $/flt over the last N periods alongside the estimator's projection.
3. **Feedback**: when actuals diverge from estimate by > X%, surface a "Calibrate from actuals?" CTA. If the user accepts, derive a per-route yield override (Tier 1 #2 store) from the recent actuals.
4. **Variance flag**: new column or status flag for routes where actual ≠ estimate (overperforming / underperforming).

This creates a closed loop: configure economics → estimator projects → actuals come in → recalibrate. The estimator becomes self-tuning over weeks of play.

**Critical decisions to pin in design:**
- Attribution: how to split a single flight's profit when an aircraft flies multiple routes per period. Options: equal split, distance-weighted, frequency-weighted.
- Snapshot cadence: every panel mount, every N hours, or manual.
- Storage rotation: keep last 12 snapshots? Last 90 days? Cap entries to avoid unbounded growth.
- Estimator influence: weight the calibration vs the model; user-tunable (full model / 50-50 / full actuals).

#### H — Wave + interlining + slot management workspace (~600 LOC, multi-session)

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

#### I — ORS-aware pricing simulation (~500 LOC, dedicated planning)

**User ask:** "link the price manipulation to the demand and the real data that comes with elapsed time to actually manipulate the maximal prices and capitalise on routes that have minimal competition as well as to manage different parts of service which is the foundation of the ORS system which AirlineSim uses to simulate demand, to create a function in the overview which can be used to customise the approaches while projecting into the future how it will affect demand and the ORS using all the different data points that we now have."

AirlineSim's **ORS (Operating Ratio System)** ranks every operator's product on each route across multiple dimensions (price, frequency, schedule quality, comfort/legroom, service classes offered) and allocates demand based on the relative ranking. Higher ORS rank → larger share of the demand pool. This feature would model that and let the user simulate forward.

**Inputs (mostly already in our caches):**
- `paxScore`, `cargoScore` — demand pool size proxy.
- `weeklyFlights`, `airlineCount` — competitive intensity (current).
- (Tier 2 F) full carrier list — actual competitor count + their frequencies.
- Aircraft type spec — paxSatisfaction (already captured by the type-spec parser).
- User's own frequency, aircraft selection, configuration (Y/C/F mix — currently not tracked, would need fleet config scrape).
- (Tier 3 G) historical actuals — calibration source.

**New work:**
- `modules/route-assistant/ors-model.js` — pure-function ORS simulator. Inputs: `{route, ourProduct: {price, frequency, comfort, ...}, competitors: [{price, frequency, comfort, ...}]}`. Output: `{rank, sharePercent, projectedPaxPerWeek, projectedRevenuePerWeek}`.
- `modules/route-assistant/service-config.js` — per-aircraft seat-class config (Y/C/F mix, legroom, catering, IFE). Settings UI.
- New panel: "ORS Sandbox" — picks a route, shows current ORS rank + share, exposes sliders for own price / frequency / comfort, projects how rank/share/revenue change. Real-time graph.
- Forward-projection over time: use historical yield data (from G) to estimate demand growth/decay; combine with ORS to project N weeks out.

**Critical questions:**
- Where to source competitor product data? Tier 2 F gets the full carrier list, but their *prices* and *service config* aren't in any flightsfrom feed. AS market analysis pages may show per-route competitor info — Tier 3 #7 territory.
- ORS exact formula: AS doesn't publish the precise weighting. Have to fit empirically from observed share data. Tier 3 G actuals feed into this calibration.
- UI: graph library? Sparkline / mini-chart already needed for G; expand for ORS too.

This is the largest item on the roadmap and should follow F + G — it depends on richer per-route data that those two unlock.

#### J — Used Aircraft Finder GUI overhaul + smarter scoring (~400–600 LOC)

The existing scanner (`modules/used-aircraft-scanner/`, `content_marketScan.js`, `MarketScanResultsTable`) scrapes the market, parses offers, applies min/max + scoring filters, and exports CSV. This rebuilds the **dashboard UI** for it and adds smarter "best deal" detection.

**GUI overhaul:**
- Replace dropdown filters with a **family card grid**: one card per AS aircraft family (regional jets, narrowbody, widebody, freighter, turboprop). Each card has a distinct accent color.
- Inside each card: **type checklist** — every type belonging to that family (sourced from `TypeFamilyMap`), tickable. Checked types get scanned.
- Quick-select chips: "All narrowbody", "All widebody", "All freighters", "Reset".
- Summary bar: N types checked / X estimated scan time.
- Results table grouped by family with color rails so a row's family is obvious at a glance.

**New scoring data points (relevant ones for "best deal" detection):**
- **$/seat** — purchase efficiency (price ÷ seats).
- **$/seat-km/year** — lifecycle cost ratio combining price + age + range.
- **Days to break-even** — `purchase / (daily revenue at current panel-yield assumptions)`. Pulls from Economics settings.
- **Fleet synergy** — flag when offered type is already owned by the user (no new training/maintenance footprint). Sourced from `RouteAssistantFleetStore`.
- **Route-fit signal** — bridge to Route Assistant: for each offer, how many of the user's top-N scored routes the offer's spec can profitably fly. "Route-fit: 18/20" = clean signal this aircraft slots into the strategy.
- **Maintenance trajectory** — current `condition` + `age` → projected check schedule. Red/amber/green pill.
- **Fuel-cost-per-hour** (after A lands) — productivity-corrected score.

**Files:** new `modules/used-aircraft-scanner/family-grid-panel.js`, update `modules/used-aircraft-scanner/results-table.js` (grouping + new fields), `modules/used-aircraft-scanner/type-family-map.js` (add `category` metadata), `modules/used-aircraft-scanner/presets-store.js` (defaults for new fields), `content_dashboard.js` (mount the new panel).

**Dependencies:** A is helpful (fuel improves the score). Route-fit signal benefits from G but works against the current model.

### Tier 3 (continued) — heavy data sourcing

| Letter | Item | Notes |
|---|---|---|
| **K** | **Deeper per-route demand from AS market analysis** | Replaces 0–10 station-level with real per-route demand + price elasticity. Heavy scraping. Prerequisite for I (ORS sandbox). |

### Tier 4 — speculative / explicit non-goals

| Item | Notes |
|---|---|
| AS rate-limit backoff | Detect 429/503, backoff. Speculative — only if user hits limits. |
| AS scheduling-page state side-effects | HANDOVER §7. Watch for Wicket session weirdness from tier-1 distance fetches. |
| Schedule writing | Explicit MVP exclusion (HANDOVER §13). |
| Aircraft purchasing from panel | Out of scope until user asks. |
| Per-route load factors from competitor schedules | Subsumed by K + I; defer indefinitely. |

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

---

End of manual.
