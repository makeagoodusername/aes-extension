# AES — Handover

This is the live current-state doc for the **AirlineSim Enhancement Suite (AES)** Chrome extension. A fresh session should be able to read this top-to-bottom and pick up cleanly. For long-form reference (algorithms, formulas, derivations), see `MANUAL.md`.

- **Project:** AirlineSim Enhancement Suite (AES) — Chrome MV3 extension, vanilla JS + jQuery (no build step).
- **What it is:** quality-of-life toolkit for AirlineSim, the browser airline-management game. Reads game pages via content scripts, scrapes data into `chrome.storage.local`, surfaces panels with scoring/filtering/automation. Read-mostly today; no writes back to AS.
- **Repo root:** `/Users/jihwan/Downloads/AES.v0.6.9-beta/`
- **Manifest version:** 0.6.9-beta (`manifest.json` → `version_name`).
- **Upstream author:** Zoe Bijl (https://github.com/ZoeBijl/airlinesim-enhancement-suite/). User is maintaining/extending a fork.
- **Git user:** `makeagoodusername`.

---

## 1 · Current state

### Route Assistant — production
**Mounts on:** `/app/com/scheduling*`. **File:** `modules/route-assistant/panel.js` (~2700 lines).

A side-panel overlay that scores destinations from the current hub on demand × competition × distance × profit. Every Phase from 1 → 2.7 has shipped:

- **Phase 1** — basic table: destinations from flightsfrom + AS station demand + own-schedule cross-check. NEW/OK/UNDER/OVER status flags, sortable scored table.
- **Phase 1.5** — distance enrichment via three-tier resolver (`distance-resolver.js`): AS scheduling-page header → AS airport coords + great-circle → flightsfrom detail page. Persistent cache.
- **Phase 2** — aircraft-fit + profit estimator (`profit-estimator.js`). Falloff zone for over-range routes, OOR status flag. Per-route override modal (LF / yield) right-click on a row.
- **Phase 2.5** — yield modulation by demand, cargo revenue, crew/maintenance/fixed costs, age penalty.
- **Phase 2.6** — distance cache invalidation, per-route LF/yield overrides.
- **Phase 2.7** — fuel-price automation. Scrapes ASc$/l from `/action/portal/index`; per-type fuel burn via `RouteAssistantFuelBurn.estimate(spec, overrides)` (heuristic loadProxy × effFactor calibrated from forum data, ±15%); user can override per type.

Long form: `MANUAL.md §2–§15`.

### Used Aircraft Scanner — production (slices 1 + 2 of J shipped)
**Mounts in:** dashboard panel at `/app/enterprise/dashboard*`. **Files:** `modules/used-aircraft-scanner/`, `content_marketScan.js` (child-tab worker).

Concurrent child-tab scan of the AS used aircraft market across a preset list of types. Family + type filter automation; type-spec enrichment via `/action/enterprise/aircraftsType?id=`; sortable results table with scoring + filtering; route-range filter; CSV export; session resume across panel reloads; "Open offer" deep-link via Wicket-state replay.

**Slice 1 (earlier session) — GUI overhaul:**
- `family-grid-panel.js` — `MarketScanFamilyGrid` drill-down picker (chips strip, category filter, search, custom-add input, expandable per-family disclosures).
- `type-family-map.js` — `AS_FAMILY_CATEGORY` map, `AS_CATEGORY_ORDER`, `TypeFamilyMap.category()` / `categoryColor()` / `familyList()`.
- `results-table.js` — Family column + 4px color rail on the leftmost cell.

**Slice 2 (this session) — smarter deal-scoring:**
- New `modules/used-aircraft-scanner/deal-metrics.js` — `MarketScanDealMetrics` pure-function helpers: `pricePerSeat`, `seatKmYearCost`, `daysToBreakEven`, `fleetSynergy`, `routeFit`, `maintenanceTrajectory`, plus `decorate(row, ctx)` that runs all six and writes named scalars/labels onto the row.
- `results-table.js` — six new columns (`$/seat`, `$/seat·km/yr`, `BE (days)`, `Maint.` pill, `Fleet` badge, `Route-fit (HUB)`); four new scoring fields (`pricePerSeat`, `seatKmYearCost`, `breakEvenDays` lower-is-better; `routeFitCount` higher-is-better); maint pill is render-only (numeric `maintRank` for sort) and fleet badge is binary; new `setContext({fleetByType, economics, topRoutes, topRoutesHub})` plumbed before `_draw()`; CSV path emits the new columns.
- `presets-store.js` — added the four new scoring entries with `pricePerSeat` enabled by default; deep-merge ensures existing user blobs gain the new keys without resetting tuned siblings.
- `content_dashboard.js` — `loadDealContext(server)` loads RA fleet (synergy), RA economics (break-even math), and `routeAssistant:topRoutes` (route-fit count). Best-effort: any failure leaves the metric as null and the cell as em-dash.
- `modules/route-assistant/panel.js` — new `_publishTopRoutes(visible)` writes a slim snapshot (top-50 visible scored rows: destIata, destName, distanceKm, score, status, paxScore, cargoScore) to a single global key `routeAssistant:topRoutes` on every render. Single key (no per-hub keys); the scanner reads the most-recent published hub.
- `manifest.json` — registered `deal-metrics.js`, `modules/route-assistant/settings-store.js`, `modules/route-assistant/fleet-store.js` in the dashboard content-script block.

### Auto-Pricing — Tiers 1 + 2a + 2b shipped, Tier 3 open
**Surfaces in:** Route Assistant panel (`/app/com/scheduling*`). **Files:** `modules/route-assistant/ticket-price-scraper.js`, `modules/route-assistant/markets-page-scraper.js`, `modules/route-assistant/ors-scraper.js`, `content_scheduling.js`, `content_markets.js`, `modules/route-assistant/panel.js`.

Four-tier rollout, user-confirmed:

- **Tier 1 — visibility (shipped).** Scrapes `/app/com/scheduling/<HUB><DEST>` for live route data: assigned aircraft (registration + typeId + name), departure time, **per-day flight counts** (`dailyFlights[7]` Mon→Sun), weekly total (`weeklyFlights`), cruise speed. Live-capture on visit + bulk-sync CTA in the "Live route data" expander. Three columns under the rose-tinted `pricing` group: **Eq**, **Dep**, **Wk** (e.g. `12 2222211` = 12/wk, 2x Mon–Fri + 1x weekends). Multi-daily fully captured.
- **Tier 2a — Markets page (shipped this session).** New scraper for `/app/com/markets/<HUB><DEST>` covering competitor flights (every flight on the route with price + availability + status), your own pricing form snapshot (Y/C/F/Cargo current + default + slider ranges), market-share leaderboard (pax + cargo, with previous-period link), and 25-week historic capacity/price chart data. Storage **split across 4 directional key families** (`competitors`, `ownPricing`, `marketShare`, `historic`) so each can have its own freshness window. Live-capture on `/app/com/markets/*` visit + bulk-sync CTA in the teal-tinted "Market Analysis" expander. Four columns under the new `markets` group: **Mkt%** (your pax share), **Cmp#** (competitor count), **Cmp$** (median competitor Y price + delta), **Drft** (pricing drift vs. AS defaults).
- **Tier 2b — ORS rank (shipped this session).** New scraper for `/app/info/ors`. Per-route GET → POST handshake (Wicket session can't be shared), walks every result page, parses each connection's overall rating + per-leg flight code/ID/aircraft/price/status, identifies "our" connections via the user-schedule cache flight-number set + carrier-prefix fallback. Stores **all rank flavors** (`rankAny`, `rankFirstLegOurs`, `rankAllOurs`, `rankNonstop`, `rankBookable`) plus ratings (`ourTopRating`, `ourBestNonstopRating`, `topCompetitorRating`, `ratingGapToTop`) and the **full connection list** so any metric is re-derivable at render time without re-scraping. Concurrency=2, stagger=1500ms, **circuit breaker** halts after 3 consecutive 429/503 errors and disables the bulk button for 10 min. Per-row drill-in drawer (▾ icon) renders the cached connection list lazily. Amber-tinted "ORS Rank" expander with controls for payload, departure/arrival window, ground-network toggle, primary column dropdown (8 rank flavors), per-column visibility, carrier-prefix override, min display threshold. Four columns under the `ors` group: **ORS** (user-selected primary metric), **RkNS** (nonstop rank), **Gap** (rating gap to top competitor), **OrsC#** (distinct first-leg competitors).
- **Tier 3 — apply / write-back (open).** HIGH risk. Confirmed autonomy posture: one-click + batch-confirm by default; silent auto-apply behind a separate explicit setting. Target endpoint: the markets-page pricing form (`POST` to `/app/com/markets/<HUB><DEST>?<wicket>-pair~form` with `classes:prices:N:newPrice` body fields).
- **Tier 4 — yield feedback.** Shipped this session as Roadmap G slice 1; see "Yield Feedback" below. Auto-Pricing Tier 4 is now folded into that loop.

**Misnomer note:** the file is named `ticket-price-scraper.js` but it currently scrapes the **scheduling page** for live operational data (no prices on that page). Rename deferred to Tier 2 when the actual pricing scraper lands.

### Yield Feedback (Roadmap G) — slices 1–4 (sessions 1+2) shipped this session
**Surfaces in:** Route Assistant panel (`/app/com/scheduling*`). **Files:** `modules/route-assistant/yield-history-store.js`, `modules/route-assistant/yield-snapshot.js`, plus extensions to `aggregator.js`, `panel.js`, `settings-store.js`, `content_aircraftFlights.js`.

Closed-loop estimator-vs-actuals: takes the live-route-data cache (which lists assigned tails per route) and joins with each tail's `<server>aircraftFlights<id>` profit record (written by `content_aircraftFlights.js`). Profits are attributed per route by frequency-weighted (default), distance-weighted, equal split, or **per-flight (exact)** (slice 4); persisted as `routeAssistant:yieldHistory:<HUB>-<DEST>` time series.

**Slice 1 (earlier in session):**
- `RouteAssistantYieldHistoryStore` — directional cache with bulk load + append + history-limit prune.
- `RouteAssistantYieldSnapshot` — pure attribution engine. Reads aircraftFlights + ticketPrice records, returns per-route snapshots.
- `aggregator.js` — `buildRouteRows` accepts `yieldHistoryMap`; rows carry `actualProfitPerFlight/Week`, `actualFrequency`, `actualSnapshots`, `actualVariancePct`, `actualContributingTails`.
- `panel.js` — "Yield feedback (actuals)" expander, `actuals` column group with `Act $/flt` and `Δ%`, ASCII sparkline tooltip, **Calibrate from actuals** button in the per-route override editor.

**Slice 2 — delta-mode + auto-snapshot + Calibrate-flagged:**
- New `routeAssistant:yieldBaselines` global key — single blob of per-tail `{profit, profitFlights}` snapshots from the last run. Each `takeSnapshot` updates it for every observed tail.
- `yield-snapshot.js _buildRegProfitMap(aircraftRecs, baselines)` — when in `deltaMode`, computes per-tail $/flt as `(profit − prevProfit) / (profitFlights − prevProfitFlights)`. Tails without a prior baseline silently fall back to cumulative; result reports `tailsUsingDelta`.
- `panel.js` — yield-feedback expander gains **Delta mode**, **Auto on mount** checkboxes and a **Calibrate flagged (N)** button that opens a modal listing every Δ%-flagged route + the calibrated yield, batch-saving overrides on confirm. Status column appends a `V+` / `V−` pill when |Δ%| ≥ warn threshold. Diag block reports the snapshot mode + delta tail coverage.
- `settings-store.js` — `yieldFeedback` block gains `deltaMode`. `autoSnapshotOnMount` now wired to `_maybeAutoSnapshot()` after `mount()`'s refresh completes.

**Slice 3 — cargo-yield calibration:**
- `derivedYieldFromActuals(row)` refactored from `number | null` → `{side: "pax"|"cargo", value, alt: {side, value} | null} | null`. Inverts the estimator's `paxRevenue + cargoRevenue` equation for whichever side is solvable, holding the other at its current revenue contribution. Auto-picks the dominant side by current revenue share; carries the alt for mixed routes.
- Per-route override editor's Calibrate button branches: pre-fills `cyldInput` when `side === "cargo"`, `yldInput` when pax; surfaces the alt-side value in the status note for hand-paste; button label switches between "Calibrate (cargo) from actuals" and "Calibrate from actuals".
- Calibrate-flagged modal gains a **Side** column with a per-row P/C dropdown (disabled when only one side is solvable). On flip, Old/New cells refresh live from `primary` vs `alt`. Save loop branches on the chosen side and writes either `yieldPerKm` or `cargoYieldPerKgKm`. Note text reflects the side actually written: `"calibrated 2026-04-26 (pax)"` or `"… (cargo)"`. Cargo-only routes (e.g. freighters) now appear in the flagged list and produce valid calibrations.

**Slice 4 — per-flight attribution (sessions 1+2 shipped, session 3 parked):**
- `content_aircraftFlights.js` extended to capture per-flight FN linkage from the aircraft history page DOM (FN ID from `/app/com/numbers/<id>` href, origin/destination IATAs from rows 3/5, dep UTC from row 4 title) and persist a slim envelope array onto `<server>aircraftFlights<id>.flights[]`: `[{flightId, flightNumber, flightNumberId, status, originIata, destinationIata, depUtc}]`.
- **Pre-existing bug fixed:** the legacy `flight.id = parseInt(url.match(/\d+/)[0])` picked up the "1" in `free1` hostname instead of the actual flight ID after `?id=`. Replaced with `url.match(/[?&]id=(\d+)/)[1]`. Affects every join into `<server>flightInfo<flightId>` — was silently broken, fixed inline because per-flight attribution depends on the join.
- `yield-snapshot.js _collectPerFlightProfits(all, server, hubFilter, aircraftRecs)` — walks every tail's `flights[]`, joins each finished/inflight envelope with `<server>flightInfo<flightId>.money.CM5.Total`, aggregates per `{originIata, destinationIata}` route key. Multi-leg FNs naturally handled because each leg's envelope carries its own route.
- `takeSnapshot` accepts `attributionMode: "per-flight"` (added alongside `frequency`/`distance`/`equal`). When set, each route is attributed exactly from its measured flights; routes with no measured flights fall back to frequency-weighted per-tail attribution. Result includes `attributionMode`, `routesWithPerFlight`, `routesFellBack`, `perFlightAvailable`.
- `panel.js` — attribution dropdown gains **per-flight (exact)** as the first option. Diag block surfaces per-flight stats and a fallback warning when any route fell back. Console summary log includes per-flight stats.
- **Session 3 parked:** extending `content_flightInfo.js` to extract origin/dest/FN inline at parse time. Currently per-flight attribution requires both an aircraft history visit AND a flight-detail visit per measured flight. Session 3 would let the flight-detail visit alone suffice — tighter the path on fresh worlds. Needs a `/action/info/flight?id=<id>` HTML sample.

**Limits:**
- Snapshots only see routes whose ticket-price record has been scraped (run "Sync route data" first), and tails the user has visited via `/app/fleets/aircraft/<id>/1`.
- Per-flight mode additionally requires `<server>flightInfo<id>` records for each measured flight (visited via `/action/info/flight?id=<id>` or the "Extract finished flight profit" bulk button).
- v1 stores cumulative averages by default; flip Delta mode for true periodic yield (requires at least one prior snapshot to anchor).
- Cargo and pax sides cannot both be calibrated from a single snapshot — one variable per equation. Run two snapshots if the user wants to dial both.

### Service-profile + per-class auto-detect — shipped this session
**Surfaces in:** Service columns (Seats/wk · Mix · Svc) on the Route Assistant panel. **Files:** `modules/route-assistant/service-profile-scraper.js` (NEW), `modules/route-assistant/markets-page-scraper.js` (extended), `modules/route-assistant/service-config-store.js` (extended), `modules/route-assistant/aggregator.js` (extended), `content_fleetManagement.js` (extended), `modules/route-assistant/panel.js` (extended).

Replaces the manual class-mix / service-level inputs with values scraped from AS:

- **Per-tail Y/C/F seat counts** — `content_fleetManagement.js` now extracts the "Y/C/F" column on `/app/fleets` (e.g. "217/30/0") into `seatsY/seatsC/seatsF` on each tail's fleet record. Aggregator uses these as the second-priority class-mix source (after per-route override, before settings default).
- **Per-class fares (Y/C/F/Cargo)** — `markets-page-scraper.js` `_parseOwnPricing` reads the Pricing fieldset on `/app/com/markets/<HUB><DEST>`. The aggregator's `_applyServiceProjection` now resolves per-class effective yield as: route override → `ownPricing[cls] / distance` (scraped) → defaults. Per-class `yieldSource` exposed on the breakdown.
- **Service-profile assignment** — same scraper grabs the `serviceProfileId` from the General Settings fieldset's `<select>`. New `RouteAssistantServiceProfileScraper` fetches `/action/enterprise/serviceProfiles` (list) + `/action/enterprise/serviceProfile?id=<id>` (per-profile catering levels per class). The detail parser robustly walks any 2-letter category prefix + class letter naming convention (`dry/drc/drf` for drinks, `mdy/mdc/mdf` for entrees, etc.) so AS adding new categories doesn't break it. Aggregate `classScore: {Y, C, F}` ∈ [0..1] is normalised across whichever categories the page exposes.
- **Service-config popover** — gains a green "Auto-detected" banner above the inputs listing what AS knows (mix from assigned tail, AS fares per class, AS profile name + per-class quality scores).
- **Settings → Service profiles** — new "AS service profiles auto-detect" sub-block with **Refresh AS service profiles** CTA + cache count + last-sync timestamp.
- **Mix column** — color-codes the source (purple = route override, green = from assigned tail, sky-blue = settings default).

**Cache layout:**
- `routeAssistant:serviceProfilesList` → `{profiles: [{id, name, minDistanceKm, isDefault}], scrapedAt}`
- `routeAssistant:serviceProfile:<id>` → `{id, name, categories: {drinks: {Y, C, F}, ...}, categoryByPrefix, classScore, scrapedAt}`
- markets-page records (`routeAssistant:markets:ownPricing:<HUB>-<DEST>`) gain `generalSettings.serviceProfileId` (number) alongside the existing `serviceProfile` (label string).

**Limits:** the coarse Budget/Standard/Premium service-level model is preserved for now — the scraped profile name + quality score is informational (surfaced in Svc tooltip + popover banner). A follow-up slice will let users *score* a route by its profile's classScore directly. Per-pax cost has no AS source — still inherited from settings or manual override.

### Station Automation — production (earlier session)
**Mounts on:** `/app/info/airports/<id>` + `/app/ops/stations*`. **Files:** `content_stationOpen.js`, `modules/station-automation/`.

Auto-opens stations across queued countries. Worker runs on the airport detail page to click "Open Station", then on the stations-ops page to reconcile success. Untouched this session.

### FlightsFrom integration — production (earlier session)
**Mounts on:** `flightsfrom.com/*`. **Files:** `content_flightsFrom.js`, `modules/flightsfrom/`.

Scrapes per-IATA destination listings (weekly flights, airline counts, distance via detail-page tier-3). Cache: `flightsFrom:<IATA>`.

This session: Letter F shipped on top — `modules/route-assistant/carriers-scraper.js` adds a per-pair detail-page scraper that the Route Assistant panel calls directly via `fetch(...)` (cross-origin, covered by host_permissions, same pattern as distance-resolver tier-3). Output enriches the panel's Cmp column with a colored intensity badge + per-carrier hover tooltip.

### Contractual partners (F slice 3) — shipped this session
**Surfaces in:** Cmp popover on the Route Assistant panel (`/app/com/scheduling*`). **Files:** `modules/route-assistant/contractual-partners-scraper.js` (NEW), extensions to `modules/route-assistant/settings-store.js` and `modules/route-assistant/panel.js`.

Reads the user's own enterprise's "Contractual partners" tab (`/app/info/enterprises/<your_id>?tab=1`) and surfaces partner glyphs in the per-row carrier popover that opens from the `Cmp` column. The popover already lists every competitor on a route (F slice 2 work); F slice 3 adds:
- ⇄ (green) glyph next to enterprises in the user's INTERLINING set
- ✦ (purple) glyph next to enterprises in the ALLIANCE set (off by default; user opt-in via the toggle)

Source: a single fetch per own enterprise yields the entire partner list (alliance + interlining + lessor + any future relation types) in a `<table class="partners">` markup. Captures relation tags verbatim so unknown future tag values still land in the cache. Single key per own-enterprise, non-directional cache (`routeAssistant:contractualPartners:<enterpriseId>`), 30-day TTL. Multi-enterprise (canopy-style) users can list multiple comma-separated IDs; the popover unions every partner set.

UI: a new purple "Contractual partners" sub-panel in the Carriers expander hosts the own-enterprise-IDs text input, the Refresh CTA, the glyph toggles, and a hint for finding your enterprise ID in AS. The data layer (`_partnersByEnterpriseId`) is rebuilt by `_applyCachedContractualPartners()` on init and after every refresh.

### Diff against last visit (Daily-driver QoL slice 1) — shipped this session
**Surfaces in:** every numeric Route Assistant column. **Files:** `modules/route-assistant/panel.js`.

Each numeric column now carries a small grey ▲/▼ badge showing the change since the user's previous visit to this hub. Tracked fields: `score`, `paxScore`, `cargoScore`, `weeklyFlights`, `airlineCount` / `competitorCount` (Cmp), `paxDemandPool`, `cargoDemandPool`, `ourPaxShare` (Mkt%), `orsRatingGapToTop` (Gap), `rmTightness` (RM%).

**Data flow:**
- New cache `routeAssistant:lastSnapshot:<HUB>` — per-hub key, overwritten on every render with the full `this.scoredRows` set.
- `refresh()` loads the snapshot once per `(mount, hub)` pair into `this._diffPrevSnapshot`. Hub change in the scheduler dropdown invalidates and re-loads (`_diffBaselineHub` mismatch). Within a single mount the in-memory baseline survives across re-renders, so deltas stay anchored to "what the user saw last visit" instead of re-baselining on every storage event.
- `_renderRows` decorates `this.scoredRows` with `_diff.<field>` scalars before sort/draw, via `_decorateRowsWithDiffs`.
- `_drawTable` writes the new snapshot at the end (after `_publishTopRoutes`) via `_writeDiffSnapshot`.
- Each tracked column's render closure ends in `_appendDiffBadge(td, "<field>", row)`. Cmp passes an array fallback `["competitorCount", "airlineCount"]` so the badge tracks whichever source produced the displayed count.

**Display:** badge format varies by field type — pax/cargo pools render compact (`▲1.2k`), `ourPaxShare` and `rmTightness` render in percentage points (`▲5pp`), score / counts / gap render rounded integers (`▼3`). Hover any badge for the exact delta + the previous mount's timestamp.

### Watchlist / starred routes (Daily-driver QoL slice 2) — shipped this session
**Surfaces in:** the destination cell of every Route Assistant row. **Files:** `modules/route-assistant/watchlist-store.js` (already existed from a previous session, now wired in), `modules/route-assistant/panel.js`, `modules/route-assistant/settings-store.js`, `manifest.json`.

The destination cell now starts with a clickable ☆ glyph. Click it to star the route; the glyph flips to ★ (gold) and the row floats to the top of the table regardless of the current sort. Star is a *primary* sort key — within both the starred group and the unstarred group the user's chosen sort field+direction is honoured. Toggle is debounced at the storage level only; the UI flips immediately and persistence runs async.

**Watch triggers** — when a starred row's `_diff` (vs. the previous mount's snapshot) shows a "worse" change in any of the tracked fields, a small red `•` appears next to the star with a multi-line tooltip listing every fired trigger and its delta. Tracked fields + worsening directions are defined in the new top-level `RA_WATCH_TRIGGERS` array next to `RA_DIFF_TRACKED`:

| Field | Worse direction | Meaning |
|---|---|---|
| `paxScore` | decreases | Pax demand fell |
| `cargoScore` | decreases | Cargo demand fell |
| `airlineCount` | increases | Real-world competitor entered |
| `competitorCount` | increases | AS competitor entered |
| `rmTightness` | increases | RM tightness rose (less headroom) |
| `orsRatingGapToTop` | decreases | ORS gap-to-top shrunk |

**Settings** — new `settings.routeAssistant.watchlist` block: `floatStarredToTop` (default `true`) gates the float-to-top sort behaviour without affecting the star itself; `showAlertBadges` (default `true`) hides the red dot if the user finds it noisy. Storage of the starred set is unaffected by both toggles — the data persists either way.

**Storage** — single global key `routeAssistant:watchlist` → `{pairs: ["<HUB>-<DEST>", ...], updatedAt}`. NOT per-hub: a multi-hub user can star routes across hubs and the panel filters by current hub at render time. Pair key is **directional** `<HUB>-<DEST>` (uppercased), matching the orientation of the panel's other directional stores.

**Caveats:** filters (status / minScore / fleetFlyable) STILL apply to starred rows — a starred route hidden by a filter doesn't surface. Documented as a known choice in §10. No cross-tab `chrome.storage.onChanged` listener for the watchlist key in v1; refresh covers the multi-tab case.

### Schedule Management — production (earlier session)
**Files:** `modules/schedule-management/`.

Wave templates, range-bucket aircraft-fit checks, schedule builder. Used by Route Assistant for fleet-aware fit/profit. Untouched this session.

---

## 2 · This session's changes

| Feature | File | Type |
|---|---|---|
| Used Aircraft Scanner | `modules/used-aircraft-scanner/family-grid-panel.js` | NEW (slice 1) |
| Used Aircraft Scanner | `modules/used-aircraft-scanner/type-family-map.js` | extended (slice 1) |
| Used Aircraft Scanner | `modules/used-aircraft-scanner/results-table.js` | extended (slice 1 + 2) |
| Used Aircraft Scanner | `modules/used-aircraft-scanner/deal-metrics.js` | NEW (slice 2 — pure-function metrics) |
| Used Aircraft Scanner | `modules/used-aircraft-scanner/presets-store.js` | extended (slice 2 — 4 new scoring fields) |
| Used Aircraft Scanner | `content_dashboard.js` | extended (slice 1 + 2; `loadDealContext` helper) |
| Used Aircraft Scanner / Route Assistant cross-link | `modules/route-assistant/panel.js` | extended (slice 2 — `_publishTopRoutes`) |
| Used Aircraft Scanner | `manifest.json` | extended (registered family-grid-panel.js, deal-metrics.js, RA fleet-store.js + settings-store.js in dashboard block) |
| Auto-Pricing | `modules/route-assistant/ticket-price-scraper.js` | NEW (misnamed — scrapes scheduling page, not prices) |
| Auto-Pricing | `modules/route-assistant/settings-store.js` | extended (`pricing` block added) |
| Auto-Pricing | `modules/route-assistant/panel.js` | extended (Eq/Dep/Wk columns, expander, _applyCachedPrices) |
| Auto-Pricing | `content_scheduling.js` | extended (live-capture on /app/com/scheduling/<HUB><DEST>) |
| Auto-Pricing | `manifest.json` | extended (registered ticket-price-scraper.js) |
| Yield Feedback (G slice 1) | `modules/route-assistant/yield-history-store.js` | NEW (Roadmap G slice 1) |
| Yield Feedback (G slice 1) | `modules/route-assistant/yield-snapshot.js` | NEW (Roadmap G slice 1) |
| Yield Feedback (G slice 1) | `modules/route-assistant/aggregator.js` | extended (yieldHistoryMap input, applyYieldHistory, actuals projection) |
| Yield Feedback (G slice 1) | `modules/route-assistant/settings-store.js` | extended (`yieldFeedback` block) |
| Yield Feedback (G slice 1) | `modules/route-assistant/panel.js` | extended (snapshot expander, Actuals column group, sparkline tooltip, calibrate button) |
| Yield Feedback (G slice 1) | `manifest.json` | extended (registered yield-history-store.js + yield-snapshot.js) |
| Yield Feedback (G slice 2) | `modules/route-assistant/yield-snapshot.js` | extended — `BASELINE_KEY = "routeAssistant:yieldBaselines"`, `_buildRegProfitMap(aircraftRecs, baselines)` delta-aware, `_saveBaselines` persists current cumulative numbers post-run; result includes `mode`, `tailsUsingDelta` |
| Yield Feedback (G slice 2) | `modules/route-assistant/aggregator.js` | extended — row carries `actualSnapshotMode` for tooltip |
| Yield Feedback (G slice 2) | `modules/route-assistant/settings-store.js` | extended — `yieldFeedback.deltaMode` |
| Yield Feedback (G slice 2) | `modules/route-assistant/panel.js` | extended — Delta mode + Auto on mount checkboxes; **Calibrate flagged (N)** button + `_flaggedRoutesForCalibration` + `_openCalibrateFlaggedModal`; V+/V− pill on the status column; `_maybeAutoSnapshot()` after `mount()` refresh; diag block + summary log surface snapshot mode |
| Yield Feedback (G slice 3) | `modules/route-assistant/panel.js` | extended — `derivedYieldFromActuals` refactored to `{side, value, alt}`; pax + cargo solvers w/ dominant-side auto-pick; per-route override editor calibrate branches; Calibrate-flagged modal gains per-row Side dropdown w/ live Old/New refresh + branched save |
| Yield Feedback (G slice 4 sessions 1+2) | `content_aircraftFlights.js` | extended — `getFlights()` extracts `flightNumberId`, `originIata`, `destinationIata`, `depUtc` per row; saved cache gains `flights[]` envelope. Fixed pre-existing flightId regex bug (`?id=` query-string match instead of leading `\d+`). |
| Yield Feedback (G slice 4 sessions 1+2) | `modules/route-assistant/yield-snapshot.js` | extended — `_collectPerFlightProfits(all, server, hubFilter, aircraftRecs)` joins envelope × flightInfo per `{originIata, destinationIata}` route; `attributionMode: "per-flight"` short-circuit in `takeSnapshot`; `_weeklyFreqOf(rec)` helper; result includes `attributionMode`, `routesWithPerFlight`, `routesFellBack`, `perFlightAvailable` |
| Yield Feedback (G slice 4 sessions 1+2) | `modules/route-assistant/panel.js` | extended — attribution dropdown adds `per-flight (exact)` as first option; diag block + summary log report per-flight coverage |
| Carriers (F) | `modules/route-assistant/carriers-scraper.js` | NEW (per-pair flightsfrom scraper + bulkScrape + competitive-intensity classifier) |
| Carriers (F) | `modules/route-assistant/settings-store.js` | extended (`carriers` block — showCarrierIntensity, concurrency, staggerMs, lastBulkScrapeAt, carriersMaxAgeDays) |
| Carriers (F) | `modules/route-assistant/panel.js` | extended (`_applyCachedCarriers`, `_renderCarriersSection` expander, `_runBulkCarrierScrape`, Cmp column → colored pill + hover tooltip via `formatCarriersTooltip`) |
| Carriers (F) | `manifest.json` | extended (registered carriers-scraper.js in scheduling block) |
| Carriers (F slice 2) | `modules/route-assistant/enterprise-meta-scraper.js` | NEW (per-enterprise `/app/info/enterprises/<id>` scraper for banner + avatar + name + IATA; bulk + cache mirror of carriers-scraper) |
| Carriers (F slice 2) | `modules/route-assistant/panel.js` | extended (`_applyCachedEnterpriseMeta`, `_runBulkEnterpriseMetaSync`, `_openCarrierPopover` / `_closeCarrierPopover` / `_positionCarrierPopover` / `_buildCarrierRow`, Cmp column rewired to open the rich popover when AS market-share data is present, `_initialBadge` helper) |
| Carriers (F slice 2) | `modules/route-assistant/settings-store.js` | extended (`carriers` block — added enterpriseMetaConcurrency, enterpriseMetaStaggerMs, enterpriseMetaMaxAgeDays, lastEnterpriseMetaSyncAt) |
| Carriers (F slice 2) | `manifest.json` | extended (registered enterprise-meta-scraper.js in scheduling block) |
| Tabbed RA view | `modules/route-assistant/panel.js` | extended (tabBar above tableHost, `_renderTabBar`, `_currentViewMode`, `RouteAssistantPanel._columnModes`, mode-filtered `_activeColumns` + scoring blend + settings drawer) |
| Tabbed RA view | `modules/route-assistant/settings-store.js` | extended (`viewMode: "all"\|"pax"\|"cargo"` top-level field with defaults + load merge) |
| Tabbed RA view | `modules/route-assistant/panel.js` SCORING_FIELDS | each entry tagged with `modes` array (paxScore = ["all","pax"], cargoScore = ["all","cargo"], everything else = all three) |
| Demand depth (K) | `modules/route-assistant/markets-page-scraper.js` | extended — per-payload historic fetch via `?payload=` query param, `byPayload` cache shape with backwards-compat read (`_migrateHistoricRecord`), `_mergeHistoric` to fold partial scrapes into the union, new `scrapeHistoricPayload` + `bulkScrapeHistoric` orchestration |
| Demand depth (K) | `modules/route-assistant/inventory-page-scraper.js` | NEW — direct fetch of `/app/com/inventory/<HUB><DEST>`, multi-strategy parser for per-class RM buckets + forward departures, circuit breaker on consecutive 429/503 |
| Demand depth (K) | `modules/route-assistant/demand-derivator.js` | NEW — pure functions: pool / avgPrice / elasticity (log-log regression, clipped) / rmTightness. PAX series prefers explicit byPayload.PAX; falls back to summed Y+C+F |
| Demand depth (K) | `modules/route-assistant/aggregator.js` | extended — passes `paxDemandPool` / `cargoDemandPool` / `useRealDemandForLF` from fleet context to estimator |
| Demand depth (K) | `modules/route-assistant/profit-estimator.js` | extended — opt-in `useRealDemandForLF` path: when set + pool present + freq>0, LF = clamp(pool / (seats×freq), [LFmin, LFmax]). Existing paxScore-interpolated path kept as fallback |
| Demand depth (K) | `modules/route-assistant/settings-store.js` | extended — new `demandDepth` block (showDemandColumns, classCoverage, useRealDemandForLF, concurrency 3 / stagger 1200ms, historicWindowPeriods 12, lastBulkScrapeAt, historicMaxAgeDays null, inventoryMaxAgeDays 3) |
| Demand depth (K) | `modules/route-assistant/panel.js` | extended — 5 new SCORING_FIELDS (paxDemandPool/cargoDemandPool/paxElasticity/cargoElasticity/rmTightness) with mode-tags; new "demand" column group (Pool / C-Pool / Elast / C-Elast / Avg$ / RM%); `_columnModes` extended with pax*/cargo* prefix derivation; `_applyCachedDemand`, `_runBulkDemandSync`, `_renderDemandDepthSection` (slate-tinted expander with confirm gate on `useRealDemandForLF` toggle); fleet context carries the toggle into the estimator |
| Demand depth (K) | `manifest.json` | extended — registered `inventory-page-scraper.js` + `demand-derivator.js` in scheduling block |
| Markets (Tier 2a) | `modules/route-assistant/markets-page-scraper.js` | NEW (per-route scraper writing 4 split key families: competitors, ownPricing, marketShare, historic) |
| Markets (Tier 2a) | `content_markets.js` | NEW (live-capture on `/app/com/markets/<HUB><DEST>`) |
| Markets (Tier 2a) | `modules/route-assistant/settings-store.js` | extended (`marketAnalysis` block — showColumns, concurrency, staggerMs, per-family TTLs, defaultPayloadChart) |
| Markets (Tier 2a) | `modules/route-assistant/panel.js` | extended (`_applyCachedMarkets`, `_renderMarketAnalysisSection` expander, `_runBulkMarketScrape`, `markets` column group + 4 cols Mkt%/Cmp#/Cmp$/Drft) |
| Markets (Tier 2a) | `manifest.json` | extended (registered markets-page-scraper.js in scheduling block + new content-script block for `/app/com/markets/*`) |
| ORS (Tier 2b) | `modules/route-assistant/ors-scraper.js` | NEW (per-route GET→POST handshake, walks all result pages, computes 5 rank flavors + 4 ratings, circuit-breaker, full connections cached) |
| ORS (Tier 2b) | `modules/route-assistant/settings-store.js` | extended (`ors` block — every form input + every rank flavor exposed; primaryColumn dropdown drives the headline panel column) |
| ORS (Tier 2b) | `modules/route-assistant/panel.js` | extended (`_applyCachedOrs`, `_renderOrsRankSection` expander with all controls, `_runBulkOrsScrape` w/ circuit-breaker UI, `_openOrsConnectionsDrawer` drill-in modal, `ors` column group + 4 cols ORS/RkNS/Gap/OrsC#) |
| ORS (Tier 2b) | `manifest.json` | extended (registered ors-scraper.js in scheduling block) |
| Diff against last visit | `modules/route-assistant/panel.js` | extended (constructor `_diffPrevSnapshot` + `_diffBaselineLoaded` + `_diffBaselineHub`; `refresh()` per-(mount,hub) baseline load via `_loadDiffSnapshot`; `_renderRows` decorates `this.scoredRows` via `_decorateRowsWithDiffs`; `_drawTable` writes via `_writeDiffSnapshot`; module helpers `RA_DIFF_TRACKED` / `_loadDiffSnapshot` / `_writeDiffSnapshot` / `_decorateRowsWithDiffs` / `_formatDiffNumber` / `_appendDiffBadge`; 11 column render closures append the badge: score / paxScore / cargoScore / weeklyFlights / Cmp / Mkt% / Pool / C-Pool / Gap / RM%) |
| Docs | `HANDOVER.md` | rewrite (this file) |
| J slice 3 + 4 v3 | `modules/used-aircraft-scanner/deal-metrics.js` | extended (routeFit() reads `weeklyFlights`; `frequencyLimited` counter + label; `decorate()` passes `weeklyDemandPerScorePoint`; new row fields surfaced) |
| J slice 3 + 4 v3 | `modules/used-aircraft-scanner/results-table.js` | extended (route-fit tooltip lists all 3 gates; new `_formatPricePerSeatTooltip`/`_formatMaintTooltip`/`_formatFleetTooltip` wired into the column definitions; redundant inner-pill `title` attrs removed) |
| J slice 4 v3 | `modules/used-aircraft-scanner/presets-store.js` | extended (`routeFit.weeklyDemandPerScorePoint = 100` default; deep-merge auto-fills for older settings blobs) |
| F slice 3 | `modules/route-assistant/contractual-partners-scraper.js` | NEW (per-enterprise `?tab=1` scraper; `table.partners` parser keeps relations verbatim; bulk + cache mirror of `enterprise-meta-scraper`) |
| F slice 3 | `modules/route-assistant/settings-store.js` | extended (`carriers` block — `myEnterpriseIds`, `partnersConcurrency`, `partnersStaggerMs`, `partnersMaxAgeDays`, `lastPartnersSyncAt`, `showInterliningGlyph`, `showAllianceGlyph`) |
| F slice 3 | `modules/route-assistant/panel.js` | extended (`_applyCachedContractualPartners`, `_runRefreshContractualPartners`, ⇄/✦ glyphs in `_buildCarrierRow` via new `nameRow` wrapper, "Contractual partners" sub-panel in the Carriers expander with own-IDs input + Refresh CTA + glyph toggles) |
| F slice 3 | `manifest.json` | extended (registered `contractual-partners-scraper.js` in the scheduling block) |
| Watchlist (Daily-driver QoL slice 2) | `modules/route-assistant/watchlist-store.js` | wired in (file existed from a prior session but was never registered or referenced — no code change to the store itself) |
| Watchlist (Daily-driver QoL slice 2) | `modules/route-assistant/settings-store.js` | extended (new `watchlist` block — `floatStarredToTop`, `showAlertBadges`) |
| Watchlist (Daily-driver QoL slice 2) | `modules/route-assistant/panel.js` | extended (constructor `_watchlist` Set; `refresh()` loads via `RouteAssistantWatchlistStore.load()`; `_renderRows` decorates `r._starred`; `_sortRows` floats starred rows; `_syncRenderContext` exposes `_showWatchTriggers`; `_toggleWatchlist(hub, dest)` instance method; destIata render closure prepends `_buildWatchlistStar(row, hub)`; new top-level `RA_WATCH_TRIGGERS` + `_evaluateWatchTriggers(row)` + `_buildWatchlistStar(row, hub)`) |
| Watchlist (Daily-driver QoL slice 2) | `manifest.json` | extended (registered `watchlist-store.js` in the scheduling block, immediately before `panel.js`) |

Plan files written this session:
- `~/.claude/plans/abstract-popping-manatee.md` — used for slice 1 of J + earlier handoff plan.
- `~/.claude/plans/ticket-price-tier-1.md` — Auto-Pricing Tier 1 plan.
- `~/.claude/plans/let-s-start-with-1-a-quizzical-lynx.md` — Tier 2a (markets) + 2b (ORS) plan.
- `~/.claude/plans/enumerated-toasting-sonnet.md` — J slice 3 + J slice 4 v3 + F slice 3 plan (this session).
- `~/.claude/plans/kind-snuggling-chipmunk.md` — Watchlist / starred routes plan (this session).

---

## 3 · Project map

```
AES.v0.6.9-beta/
├── manifest.json                              MV3 manifest. Content-script blocks per AS URL pattern.
├── background.js                              MV3 service worker (minimal).
├── helpers.js                                 AS namespace: formatCurrency, cleanInteger, …
├── HANDOVER.md                                THIS file.
├── MANUAL.md                                  Long-form reference (~875 lines).
│
├── content_dashboard.js                       Dashboard panel mount. ~3700 lines. Hosts the Used Aircraft Scanner UI.
├── content_scheduling.js                      Mounts RouteAssistantPanel on /app/com/scheduling*; live-captures route data on /app/com/scheduling/<HUB><DEST>.
├── content_marketScan.js                      Used-aircraft-scanner CHILD TAB worker (runs on /app/aircraft/market*).
├── content_flightsFrom.js                     flightsfrom.com scraper (runs on www.flightsfrom.com).
├── content_stationOpen.js                     Station-opening automation.
├── content_aircraftFlights.js                 Per-aircraft flight-history extractor.
├── content_fligthSchedule.js                  Own-schedule extractor (note original typo).
├── content_inventory.js                       Inventory-page utilities.
├── content_personelManagement.js              Personnel staffing helpers.
├── content_enterpriceOverview.js              Enterprise overview helpers.
├── content_flightInfo.js                      Flight-detail data extractor.
├── content_settings.js                        AS settings-page helpers.
├── content_fleetManagement.js                 Fleet-page helpers.
│
├── modules/
│   ├── aes-menu.js                            Top-bar AES dropdown (every page).
│   ├── about-dialog.js                        About modal.
│   ├── aircraft-type-specs.js                 AESAircraftTypeSpecs.fetchById(typeId) — shared aircraft type-spec parser.
│   │
│   ├── used-aircraft-scanner/
│   │   ├── type-family-map.js                 AS_TYPE_TO_FAMILY map + AS_FAMILY_CATEGORY + helpers.
│   │   ├── presets-store.js                   UsedAircraftPresets settings CRUD.
│   │   ├── scan-session-store.js              MarketScanSession — per-scan storage.
│   │   ├── deal-metrics.js                    MarketScanDealMetrics — slice-2 metrics ($/seat, $/seat·km/yr, BE-days, fleet-synergy, route-fit, maint pill). NEW this session.
│   │   ├── results-table.js                   MarketScanResultsTable — sortable HTML + CSV. Family column + color rail + slice-2 deal columns.
│   │   ├── scan-controller.js                 ScanController — concurrent child-tab orchestrator.
│   │   └── family-grid-panel.js               MarketScanFamilyGrid — type picker.
│   │
│   ├── route-assistant/
│   │   ├── settings-store.js                  RouteAssistantSettings.load/save. Includes economics + pricing blocks.
│   │   ├── demand-store.js                    RouteAssistantDemandStore — per-IATA AS pax/cargo demand cache.
│   │   ├── country-resolver.js                IATA → countryId via DemandStore (cache-only).
│   │   ├── parallel-scanner.js                Concurrent CountryScraper runner; seedAllCountries().
│   │   ├── distance-resolver.js               Three-tier hub→dest distance with persistent cache.
│   │   ├── route-overrides-store.js           Per-route LF/yield user overrides.
│   │   ├── fleet-store.js                     User's fleet inventory cache.
│   │   ├── type-specs-store.js                AS aircraft-type spec cache.
│   │   ├── fuel-price-scraper.js              World fuel price scrape (table → SVG fallback).
│   │   ├── fuel-burn-estimator.js             Per-type fuel-burn heuristic + override.
│   │   ├── profit-estimator.js                Pure-function profit math.
│   │   ├── score.js                           Pure weighted-average normaliser.
│   │   ├── aggregator.js                      buildRouteRows + applyFleetContext.
│   │   ├── ticket-price-scraper.js            Scheduling-page scraper for live route data. NEW earlier-this-session, misnamed.
│   │   ├── carriers-scraper.js                Per-pair flightsfrom scraper for the full carrier list. NEW (Letter F). Bulk-scrape + competitive-intensity classifier.
│   │   ├── enterprise-meta-scraper.js         Per-enterprise /app/info/enterprises/<id> scraper for banner + avatar + name + IATA. NEW (F slice 2). Non-directional cache; powers the Cmp popover's rich rendering.
│   │   ├── contractual-partners-scraper.js    Per-(your-own)-enterprise /app/info/enterprises/<id>?tab=1 scraper for the contractual partners table (alliance + interlining + lessor). NEW (F slice 3). Cache keyed by your-own enterprise id; the popover cross-references competitor ids against the union of partner sets.
│   │   ├── inventory-page-scraper.js          Per-route /app/com/inventory/<HUB><DEST> scraper for RM buckets + forward departures. NEW this session (Letter K). Circuit breaker on consecutive 429/503.
│   │   ├── demand-derivator.js                Pure functions for pool / elasticity / RM tightness from cached markets historic + inventory + ownPricing. NEW this session (Letter K).
│   │   ├── markets-page-scraper.js            Markets-page scraper for /app/com/markets/<HUB><DEST>. NEW this session (Tier 2a). Writes 4 split key families: competitors, ownPricing, marketShare, historic. bulkLoadCache(pairs, {families}) reads any subset in one combined chrome.storage.local.get.
│   │   ├── ors-scraper.js                     ORS rank scraper for /app/info/ors. NEW this session (Tier 2b). Per-route GET → POST handshake (Wicket can't share sessions). Walks all result pages, computes 5 rank flavors + 4 ratings, stores full connection list. Circuit-breaker on 3× consecutive 429/503.
│   │   └── panel.js                           RouteAssistantPanel — UI. ~4200 lines after this session.
│   │
│   ├── flightsfrom/
│   │   ├── data-store.js                      FlightsFromStore.
│   │   └── scan-controller.js                 FlightsFromController (child-tab orchestrator).
│   │
│   ├── station-automation/
│   │   ├── storage.js                         StationAutomation run-state storage.
│   │   └── country-scraper.js                 CountryScraper — country/county directory walker.
│   │
│   ├── schedule-management/
│   │   ├── range-buckets.js                   ScheduleFactors — distance/time math.
│   │   ├── presets-store.js                   SchedulePresets.
│   │   ├── schedule-store.js                  Built schedule cache.
│   │   ├── schedule-builder.js                ScheduleBuilder — preset → wave-aware flight records.
│   │   └── schedule-panel.js                  Dashboard schedule UI.
│   │
│   ├── aircraft-flights/                      Per-aircraft history panel modules.
│   ├── inventory/                             Inventory-page validation.
│   └── data-models/                           Shared data shapes.
│
├── css/content.css                            Cross-feature styles.
├── images/                                    Logo assets.
├── popup.html / popup.js / options.html / options.js
└── js/jquery-3.4.1.min.js                     Vendored jQuery.
```

---

## 4 · chrome.storage.local keys

| Key pattern | Writer | Shape |
|---|---|---|
| `settings` | extension-wide | `{routeAssistant: {…}, usedAircraftScanner: {…}, …}` — single shared blob, deep-merged on load. |
| `flightsFrom:<IATA>` | flightsfrom scraper | `{iata, scrapedAt, airportName, routes: [{destIata, destName, weeklyFlights, seatsPerWeek, distanceKm?, airlines, aircraft, detailUrl}]}` |
| `flightsFrom:<IATA>:status` | flightsfrom scraper | `{iata, scanId, status, error?, progress: {phase, routeCount?}}` |
| `routeAssistant:demand:<IATA>` | DemandStore | `{iata, name?, airportId?, countryId?, paxScore, cargoScore, scrapedAt, lat?, lon?}` |
| `routeAssistant:distance:<MIN>-<MAX>` | DistanceResolver | `{distanceKm, source: "as-scheduling"\|"as-coords"\|"ff-detail", resolvedAt}`. **Pair key alphabetically sorted** (symmetric). |
| `routeAssistant:override:<HUB>-<DEST>` | RouteOverridesStore | `{hub, dest, paxLF?, cargoLF?, yieldPerKm?, cargoYieldPerKgKm?, note?, createdAt, updatedAt}`. Directional. |
| `routeAssistant:fuelPriceIndex` | fuel-price-scraper | `{value, unit: "ASc$/l"\|"index", date, scrapedAt, source: "table"\|"svg", sourceUrl, history?}` |
| `routeAssistant:fuelBurnOverride:<typeId>` | fuel-burn-estimator | `{typeId, cycleL, perKmL, source: "manual", updatedAt}` |
| `routeAssistant:typeSpec:<typeId>` | type-specs-store | `{typeId, typeName, seats, range, speed, cargoCapacity, paxSatisfaction?, …}` |
| `routeAssistant:ticketPrice:<HUB>-<DEST>` | ticket-price-scraper (this session) | `{hub, dest, scrapedAt, source: "live"\|"fetch", flights[], primaryAircraftType, primaryAircraftTypeId, primaryAircraftReg, departureTime, weeklyFlights, dailyFlights[7], daysPerWeek, cruiseSpeedKmh, ourPrice: null, ourYield: null, orsRank: null, fareClasses: null}`. **Directional** (price/freq differ by direction). Tier 2 fields stay null until those scrapers ship. |
| `routeAssistant:yieldHistory:<HUB>-<DEST>` | yield-snapshot.js (this session) | `{hub, dest, snapshots: [{timestamp, profitPerFlight, profitPerWeek, frequency, aircraftTypeNames, aircraftRegistrations, contributingTails, totalKnownTails, attributionMode}], lastSnapshotAt}`. **Directional**. Snapshots pruned to `historyLimit` (default 12) on each append. |
| `routeAssistant:topRoutes` | route-assistant/panel.js (`_publishTopRoutes`) | `{hub, server, scrapedAt, count, rows: [{destIata, destName, distanceKm, score, status, paxScore, cargoScore}]}`. **Single global key** — overwritten on every panel render with up to 50 visible scored rows. Consumer: Used Aircraft Scanner deal-metrics (route-fit count). |
| `routeAssistant:lastSnapshot:<HUB>` | route-assistant/panel.js (`_writeDiffSnapshot`) | `{hub, server, scrapedAt, rows: [{destIata, score, paxScore, cargoScore, weeklyFlights, airlineCount, competitorCount, paxDemandPool, cargoDemandPool, ourPaxShare, orsRatingGapToTop, rmTightness}]}`. **Per-hub key** (one record per hub the user has visited). Overwritten on every panel render from `this.scoredRows`. Read once per `(mount, hub)` pair in `refresh()` so the in-memory baseline anchors to "what the user saw last visit" rather than re-baselining on every storage event. **Row-property field names** (so `orsRatingGapToTop`, not `ratingGapToTop`). Consumer: render closures, via `_decorateRowsWithDiffs`. |
| `routeAssistant:watchlist` | watchlist-store.js (Daily-driver QoL slice 2) | `{pairs: ["<HUB>-<DEST>", ...], updatedAt}`. **Single global key**, NOT per-hub. Pair key is **directional** `<HUB>-<DEST>` uppercased. Loaded fresh per `refresh()` into the panel's `_watchlist` Set; the panel filters by current hub at render time. Consumer: `RouteAssistantPanel._buildWatchlistStar` (star glyph) + `_sortRows` (float-to-top) + `_evaluateWatchTriggers` (red dot when row's `_diff` shows worsening change). |
| `routeAssistant:carriers:<HUB>-<DEST>` | carriers-scraper.js (Letter F) | `{hub, dest, scrapedAt, source: "ff-detail", carriers: [{name, code?, weeklyFlights?, aircraftTypes?: []}], totalAirlines, totalWeeklyFlights, parserNotes?}`. **Directional**. Sourced from `flightsfrom.com/<HUB>-<DEST>` cross-origin fetch. `parserNotes` populated when no carrier markup matched (SPA didn't SSR the list). |
| `routeAssistant:enterpriseMeta:<id>` | enterprise-meta-scraper.js (this session — F slice 2) | `{enterpriseId, server, name, iata?, bannerUrl?, avatarUrl?, scrapedAt, parserNotes?}`. **NOT directional** — enterprise metadata is a property of the enterprise, not the route, so the same record serves every route that competitor appears on. Sourced from `/app/info/enterprises/<id>` cross-origin fetch (covered by `host_permissions`). 90-day default TTL; user-driven re-sync via the Carriers expander CTA. |
| `routeAssistant:contractualPartners:<enterpriseId>` | contractual-partners-scraper.js (this session — F slice 3) | `{enterpriseId, server, scrapedAt, partners: [{partnerId, partnerName, partnerIata, hqCity?, hqIata?, country?, relations: ["INTERLINING", "ALLIANCE", "LESSOR", ...]}], parserNotes?}`. **NOT directional, AND keyed by *your-own* enterprise id** (not by competitor — opposite to `enterpriseMeta`). One fetch of `/app/info/enterprises/<your_id>?tab=1` yields every partnership the enterprise has. The Cmp popover unions all your-own records into `_partnersByEnterpriseId` and renders glyphs (⇄ for INTERLINING, ✦ for ALLIANCE) next to matching competitor names. 30-day default TTL. |
| `routeAssistant:markets:competitors:<HUB>-<DEST>` | markets-page-scraper.js (this session — Tier 2a) | `{hub, dest, scrapedAt, source: "live"\|"fetch", competitors: [{flightCode, flightId, typeCode, typeId, depDateUtc, depDateLocal, depTimeUtc, depTimeLocal, arrTimeUtc, arrTimeLocal, serviceClass, availability, price, status, isOurs}]}`. **Directional**. Every competitor flight on the route with its actual prices + availability + status. |
| `routeAssistant:markets:ownPricing:<HUB>-<DEST>` | markets-page-scraper.js (this session — Tier 2a) | `{hub, dest, scrapedAt, source, prices: {Y, C, F, Cargo}, defaults: {…}, sliderRanges: {Y: [1, 296], …}, generalSettings: {originTerminal, destinationTerminal, serviceProfile, boardingPreference, cargoPreference}}`. **Directional**. Snapshot of the markets-page Pricing fieldset; Tier 3 write-back will POST against the same endpoint. |
| `routeAssistant:markets:marketShare:<HUB>-<DEST>` | markets-page-scraper.js (this session — Tier 2a) | `{hub, dest, scrapedAt, source, period: "17/2026", pax: [{rank, name, enterpriseId, sharePct, change}], cargo: [{…}]}`. **Directional**. Default `shareMaxAgeDays: 7` (weekly cadence). |
| `routeAssistant:markets:historic:<HUB>-<DEST>` | markets-page-scraper.js (Tier 2a + K extension) | **K — new shape:** `{hub, dest, scrapedAt, source, byPayload: {ECONOMY: {periods, capacities, prices}, BUSINESS: …, FIRST: …, PAX: …, CARGO: …}}`. **Directional**. Parsed from inline `lineChart(…).setData([…])` calls. Legacy single-payload records (`{periods, capacities, prices, payload}`) are auto-migrated on read by `_migrateHistoricRecord`; the next scrape persists the new shape. |
| `routeAssistant:inventory:<HUB>-<DEST>` | inventory-page-scraper.js (this session — Letter K) | `{hub, dest, scrapedAt, source: "fetch", classes: {Y, C, F, Cargo: {totalSeats, soldSeats, avgFare?}}, departures: [{date, time, totalSeats, sold}], parserNotes?}`. **Directional**. Sourced from `/app/com/inventory/<HUB><DEST>`. Multi-strategy parser; falls back gracefully when AS markup shifts. RM data is volatile — default 3-day TTL. |
| `routeAssistant:ors:<HUB>-<DEST>` | ors-scraper.js (this session — Tier 2b) | `{hub, dest, scrapedAt, params: {payload, departureH, arrivalH, useGround}, totalConnections, ourFlightIds[], ourCarrierPrefixes[], rankAny, rankFirstLegOurs, rankAllOurs, rankNonstop, rankBookable, ourTopRating, ourBestNonstopRating, topCompetitorRating, ratingGapToTop, connections: [{idx, rating, totalDuration, totalPrice, bookable, legs: [{flightCode, flightId, typeCode, typeId, rating, price, serviceClass, status, isOurs, isGround}]}]}`. **Directional**. Single key per route; ~10KB. **Connections is the source of truth** — every rank flavor is re-derivable, never re-scrape just to display a different metric. |
| `<server><airline>schedule` | content_fligthSchedule.js | `{type:"schedule", server, airline, date: {<YYYYMMDD>: {…schedule arrays…}}}`. ORS scraper reads this to build the "our flight numbers" set for `isOurs` detection. |
| `<server>aircraftFlights<aircraftId>` | content_aircraftFlights.js | per-aircraft profit/flight history. Used by Fleet Mgmt page directly; **read by yield-snapshot.js** to derive per-route actuals. Shape: `{aircraftId, server, registration, equipment, date, time, profit, profitFlights, finishedFlights, totalFlights, type:"aircraftFlights", flights: [{flightId, flightNumber, flightNumberId, status, originIata, destinationIata, depUtc}]}`. The `flights[]` envelope (G slice 4) is the per-FN linkage joined by `_collectPerFlightProfits` for exact attribution. Pre-G-slice-4 records are missing the envelope; visit the aircraft history page to populate. |
| `routeAssistant:yieldBaselines` | yield-snapshot.js | **NEW (G slice 2).** Single global blob `{<reg>: {profit, profitFlights, savedAt}}` of every observed tail's cumulative profit numbers from the most recent snapshot. Delta mode subtracts this from the next run's numbers to compute periodic per-tail $/flt. Refreshed on every snapshot regardless of mode so flipping into Delta later has a meaningful starting point. |
| `<server>marketScan:<scanId>` | scan-session-store | One scan's queue/state. |
| `<server>marketScan:<scanId>:r:<typeSlug>` | scan-controller (child tabs) | One per-type result blob. |
| `<server><airlineCode>stationAutomationRun:<runId>` | station-automation | One run's progress + results. |

**Stable** — every prefix above is contract. External code reads them.

---

## 5 · Settings shape

### `settings.routeAssistant` (defaults from `RouteAssistantSettings._defaults()`)

```js
{
    scoring: {
        paxScore:      {enabled, weight, direction, min, max},
        cargoScore:    {…}, weeklyFlights: {…}, airlineCount: {…},
        profitPerWeek: {…}, fitOk: {…},
        actualProfitPerWeek: {…}    // Yield Feedback — score routes by realised $/wk
    },
    filters: {
        minScore, maxDistanceKm,
        statuses: {NEW, OK, UNDER, OVER, OOR},
        fleetFlyableOnly
    },
    flightsfromMaxAgeDays,
    distanceMaxAgeDays,
    collapsed,
    viewMode,                        // "all" | "pax" | "cargo" — tabbed table view
    demandDepth: {                   // Letter K — per-class historic + RM buckets
        showDemandColumns,
        classCoverage,               // "summary" (PAX+CARGO) | "full" (5 payloads)
        useRealDemandForLF,          // opt-in: profit-estimator uses pool / weeklySeats for LF
        concurrency, staggerMs,
        historicWindowPeriods,       // last N weeks for elasticity regression
        lastBulkScrapeAt,
        historicMaxAgeDays,
        inventoryMaxAgeDays
    },
    aircraft: {mode, typeId, registration, falloffPct, showAircraftColumns},
    economics: {
        loadFactor, loadFactorMin, loadFactorMax,
        yieldPerKm, yieldDemandSensitivity,
        cargoYieldPerKgKm, cargoLoadFactor, cargoLoadFactorMin,
        cargoLoadFactorMax, cargoYieldDemandSensitivity,
        fuelCostPerHour, fuelPriceAutoEnabled, fuelPriceBaselineCost,
        fuelPriceBaselineValue, fuelPriceBaselineUnit, fuelAgePenaltyPerYear,
        crewCostPerHour, maintenanceCostPerHour, otherFixedPerFlight,
        falloffYieldMultiplier
    },
    pricing: {                    // Auto-Pricing scrape config
        showPricingColumns,       // gate the Live route data columns
        concurrency, staggerMs,
        lastBulkScrapeAt, priceMaxAgeDays,
        autonomyMode,             // off | suggest | oneClick | batch (T2/T3)
        silentAutoEnabled,        // separate gate for silent auto-apply
        targetMargin, competitorAdjust  // T2 placeholders
    },
    yieldFeedback: {              // Roadmap G — actual-yields feedback loop
        showColumns,              // gate the Actuals column group (Act $/flt + Δ%)
        varianceWarnPct,          // ±X% triggers the Δ% highlight (default 25)
        attributionMode,          // "frequency" | "distance" | "equal"
        historyLimit,             // newest N snapshots kept per route (default 12)
        lastSnapshotAt,           // unix-ms; surfaces in the expander
        autoSnapshotOnMount       // off by default; manual Snapshot CTA only
    },
    carriers: {                   // Letter F — full carrier list per route
        showCarrierIntensity, concurrency, staggerMs,
        lastBulkScrapeAt, carriersMaxAgeDays
    },
    marketAnalysis: {             // Tier 2a — markets-page scrape config
        showColumns,              // gate Mkt% / Cmp# / Cmp$ / Drft cols
        concurrency, staggerMs,
        lastBulkScrapeAt,
        competitorMaxAgeDays,     // null = never expire
        shareMaxAgeDays,          // 7 default — weekly cadence
        historicMaxAgeDays,
        defaultPayloadChart       // PAX | ECONOMY | BUSINESS | FIRST | FREIGHT
    },
    watchlist: {                  // Daily-driver QoL slice 2 — starred routes display
        floatStarredToTop,        // bool, default true — gate the star-as-primary-sort behaviour
        showAlertBadges           // bool, default true — gate the red dot when row's _diff worsens
                                  // Storage of the starred set itself is RouteAssistantWatchlistStore;
                                  // these toggles only affect display, never persistence.
    },
    ors: {                        // Tier 2b — ORS rank scrape + display config
        showColumns,
        concurrency,              // 2 default — ORS = expensive AS solver
        staggerMs,                // 1500 default
        lastBulkScrapeAt, rankMaxAgeDays,
        // Default scrape parameters (all surfaced in the expander):
        defaultPayload,           // ECONOMY | BUSINESS | FIRST | CARGO
        defaultDepartureH,        // 0..48
        defaultArrivalH,          // 24..72
        defaultUseGround,         // bool
        // Display preferences — every rank flavor surfaceable:
        primaryColumn,            // ratingGapToTop | rankAny | rankFirstLegOurs |
                                  // rankAllOurs | rankNonstop | rankBookable |
                                  // ourTopRating | ourBestNonstopRating
        showRankAnyColumn, showRankNonstopColumn,
        showRatingGapColumn, showCompetitorCountColumn,
        minRatingThresholdDisplay,   // hide values where ourTopRating < N
        // Carrier identification override (e.g. "FGM,NYO" for multi-airline users):
        airlineCarrierPrefixOverride,
        // Circuit-breaker state — bulk button disabled for cooldown after trip:
        circuitBreakerTrippedAt, circuitBreakerCooldownMs   // 600000 default = 10 min
    }
}
```

Defaults are deep-filled on load — adding new fields in a future version doesn't wipe user-tuned siblings.

### `settings.usedAircraftScanner` (defaults from `UsedAircraftPresets._defaults()`)

```js
{
    presets: [{id, name, types: string[]}],   // user-defined preset list
    typeFamilyOverrides: {<asLabel>: <familyName>},
    concurrency, staggerMs, lastScanId,
    routeFilter: {minRangeKm},
    scoring: {
        ageYears: {enabled, weight, min, max}, conditionPct: {…},
        seats: {…}, cargoCapacity: {…}, speed: {…}, range: {…},
        paxSatisfaction: {…}, nextBid: {…}, immediatePurchase: {…},
        leasingRate: {…}
    }
}
```

---

## 6 · AS endpoints used

| URL | Method | Purpose |
|---|---|---|
| `/action/info/countries` | GET | Country directory (StationAutomation, Route Assistant seed). |
| `/action/info/country?id=<id>` | GET | Country page (airports + demand). |
| `/action/info/county?id=<id>` | GET | Region page (US states, Russia oblasts; AS spelling: "county"). |
| `/action/info/airports/<airportId>` | GET | Airport detail (lat/lon for great-circle). |
| `/action/portal/index` | GET | World fuel price scrape (table → SVG fallback). |
| `/action/holding/stockexchanges` | GET | Fuel price secondary source. |
| `/action/enterprise/aircraftsType?id=<typeId>` | GET | Aircraft type specs. |
| `/app/com/scheduling/<HUB><DEST>` | GET | **Distance** (header) + **live route data** (Flight Numbers overview table + segments matrix). 6-char concatenated path. NO prices, NO ORS rank. |
| `/app/info/enterprises/<id>?tab=3` | GET | Own-schedule extract. |
| `/app/info/enterprises/<id>` | GET | Enterprise overview page — read by `enterprise-meta-scraper.js` (F slice 2) for banner + avatar + display name; also the link target from the Cmp popover's clickable enterprise names. |
| `/app/info/enterprises/<id>?tab=1` | GET | **INTEGRATED (F slice 3, this session).** Enterprise's "Contractual partners" tab. Source for `contractual-partners-scraper.js`. Lists every business relation in a `<table class="partners">` — each row carries one or more `<span class="type ALLIANCE">` / `<span class="type INTERLINING">` / `<span class="type LESSOR">` badges. Fetched per *your-own* enterprise id; the popover then cross-references competitor enterpriseIds against the union of partner sets to surface ⇄ / ✦ glyphs. |
| `https://www.flightsfrom.com/<IATA>` | GET (cross-origin) | Hub destination listing. |
| `https://www.flightsfrom.com/<HUB>-<DEST>` | GET (cross-origin) | Pair detail page — used by both distance tier-3 fallback **and** the Letter F carriers-scraper for the per-route carrier list. |
| `/app/com/markets/<HUB><DEST>` | GET | **INTEGRATED (Tier 2a, this session).** Per-route Market Analysis page. Source for: every competitor flight with prices + availability + status (`#inventory-table`), your own pricing form snapshot (Pricing fieldset), market-share leaderboard (pax + cargo), 25-week historic capacity/price charts (parsed from inline `lineChart(…).setData([…])`). Live-capture via `content_markets.js` + bulk-sync via the panel's Market Analysis expander. |
| `/app/info/ors` | POST (after GET handshake) | **INTEGRATED (Tier 2b, this session).** Online Reservation System search form. The actual sort the AS demand model runs against. Per-route GET first to harvest Wicket session + form action, then POST with `origin-group:…:origin = <full airport name>`, `destination-group:…:destination = <name>`, `payload = radio0\|radio1\|radio2\|radio3`, `departure-group:…:departure = <0-48>`, `arrival-group:…:arrival = <24-72>`, `ground:useGroundNetwork = on`. Walk pagination via `.navigation a.next` (sample: 77 connections / 3 pages for JFK→LAX). |
| `/app/com/markets/<HUB><DEST>` (POST `?<wicket>-pair~form`) | POST | **TIER 3 TARGET (open).** Pricing write-back. Form fields: `classes:prices:0:newPrice` (Y), `:1:` (C), `:2:` (F), `:3:` (Cargo) + `submit-prices` button. |
| `/action/enterprise/flightsPrices` | GET | Global pricing list. Not currently used — the markets-page per-route data is preferred per user. |
| `/app/com/inventory/<HUB><DEST>` | GET | Per-route inventory + fares. **Letter K** — read by `inventory-page-scraper.js` for per-class RM buckets + forward departures. Same-origin fetch under `host_permissions`. |
| `/app/com/markets/<HUB><DEST>?payload=NAME` | GET | **Letter K** — same markets page, query param drives which payload's historic chart renders. NAME ∈ {ECONOMY, BUSINESS, FIRST, PAX, CARGO}. Five fan-out fetches per route in `classCoverage = "full"`, two (PAX + CARGO) in `"summary"`. |

All AS reads use `fetch(url, {credentials: "include"})` + `DOMParser`. No writes to AS today.

---

## 7 · AS quirks (relearn-the-hard-way avoided)

- **Wicket session URLs.** AS pages have a numeric Wicket suffix like `?239`. Fetching without it usually still works (server redirects). The market scanner's child-tab worker uses `sessionStorage` to persist context across Wicket navigations.
- **Country/county spelling.** Region-level URLs use AS's spelling `/action/info/county` (US states, Russia oblasts). The country-scraper handles both spellings.
- **Airport detail page.** `/app/info/airports/<airportId>`. There's **no per-IATA lookup** endpoint — `/action/info/airports?searchString=` returns 404. IATA → airportId is cache-only via DemandStore.
- **Demand 0–10.** Encoded in image filenames `<n>.png` where `n` is 1-indexed (`1.png` = score 0, `11.png` = score 10). `CountryScraper._readDemandBars` subtracts 1.
- **Scheduling page URL.** `/app/com/scheduling/<HUB><DEST>` — concatenated 6-character path. Page header: e.g. `New York (JFK) – Los Angeles (LAX) 3,971 km` (distance source). The **Flight Numbers overview table** (legend "Flight Numbers") is the cleanest source for live route data — flight number, departure time, frequency-days pattern (`1234567`/`_234567`/etc.), assigned aircraft (registration link + type link). This page does **NOT** carry prices or ORS rank.
- **Multi-daily routes.** A single route can have multiple flight numbers AND multiple frequency rows per FN. The right representation is **per-day flight counts** (`dailyFlights[7]` Mon→Sun, integer count) not "days flown". `2222211` = 2x Mon–Fri + 1x weekends = 12/wk. Real-airline-style notation.
- **Server name.** `window.location.hostname.split(".")[0]` (e.g. `free1`, `tristar`). Storage keys are scoped per-server.
- **Pricing surfaces.** AS prices live on `/action/enterprise/flightsPrices` (global) and `/app/com/inventory/<HUB><DEST>` (per-route). NOT on the scheduling page.
- **ORS rank surfaces.** True ORS rank lives on `/app/info/ors` — submit the connection-search form (origin/destination/payload/window/ground) and parse the result list. Each `<tbody class="bookable\|unbookable">` is one connection; `<tr class="totals">` carries the connection-level rating (e.g., 67 for the top JFK→LAX nonstop in the sample). The markets-page market-share leaderboard is NOT the same as ORS rank — it's a per-period booking outcome, not a search-engine sort.
- **Wicket form POST.** The ORS form is Apache Wicket. Each scrape requires a fresh GET → POST handshake — page-version IDs increment per interaction; reusing a stale session returns a `PageExpiredException` HTML page that parses as zero results (silent corruption). Concurrency=2 / stagger=1500ms keeps the per-route 2-request handshake cost manageable. Circuit breaker on 3× consecutive 429/503 prevents soft-bans during long bulk runs.
- **Markets-page split storage.** One scrape of `/app/com/markets/<HUB><DEST>` writes 4 chrome.storage.local key families (`competitors`, `ownPricing`, `marketShare`, `historic`) so each can have its own freshness window. `RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {families: […]})` accepts a families array and issues one combined `chrome.storage.local.get`, so the split costs no extra round trip.
- **AS version.** Currently 6.13.x. Page format changes happen — when a parser stops matching, grep for the relevant label and update selectors.

---

## 8 · How to test cold

1. **Load.** `chrome://extensions` → Developer mode → Load unpacked → select `/Users/jihwan/Downloads/AES.v0.6.9-beta`. Or "Reload" if already loaded.
2. **Used Aircraft Scanner.** Dashboard → AES dropdown → Used Aircraft Scanner. Confirm:
   - Family-card grid renders with chips strip + category filter row + search input + custom-add row.
   - Pick a small preset or tick a few types in the narrowbody category.
   - Click **Start scan**. Child tabs open (allow popups for `*.airlinesim.aero`); queue table populates; results stream in.
   - Results table has **Family** column at index 0 (or 1 when scoring active), with a 4px color rail down the leftmost cell.
   - Click **Download CSV** — Family column present.
3. **Route Assistant — basic.** Visit `/app/com/scheduling`. Panel mounts bottom-right (~1 s). If first-time on this game world: purple "demand cache empty" banner → click **Seed all countries** (5–15 min, one-time).
4. **Auto-Pricing Tier 1 — live capture.** Open `/app/com/scheduling/JFKLAX` (or any route you fly). Open DevTools console. Within ~2 s, log:
   ```
   [AES routeAssistant] scheduling page parsed: 1 flight(s), primary=Boeing 767-300F, dep=06:05, 7/wk pattern=1111111, cruise=851km/h
   [AES priceScraper] live-captured JFK→LAX {…}
   ```
5. **Auto-Pricing Tier 1 — bulk sync.** Back on `/app/com/scheduling`, open the Route Assistant panel's **Live route data** expander. Click **Sync route data for all visible routes**. Watch progress: `Syncing route data: 12/87…`. After completion, **Eq / Dep / Wk** columns populate (Wk shows `12 2222211` style). Hover `Wk` → tooltip with per-day breakdown.
6. **Sanity-check distances.** JFK → LAX should be ~3,975 km, JFK → LHR ~5,540 km. Console logs `via as-scheduling` / `via as-coords` / `via ff-detail` per route.
7. **Console clean.** No JS errors during any flow.

If the Used Aircraft Scanner first-run logs `[AES priceScraper] no price/yield/ORS labels matched` — that's expected on the scheduling page; pricing/ORS aren't there. If `Wk` shows `—` for routes that have `Eq` and `Dep`: cache predates the multi-daily shape; click Sync to refresh.

8. **Tier 2a — Markets page live capture.** Open `/app/com/markets/JFKATL` (or any active route). DevTools console within ~2s:
   ```
   [AES marketsScraper] live-captured JFK→ATL competitors=N pricing=Y/C/F/Cargo share=4 hist=25
   ```
9. **Tier 2a — Markets bulk sync.** Back on `/app/com/scheduling`, open the new teal **Market Analysis** expander. Click **Sync market analysis for all visible routes**. Watch progress; after completion the **Mkt% / Cmp# / Cmp$ / Drft** columns populate. Drft shows "drift" when your prices diverge from defaults, "dflt" otherwise. Hover Mkt% for the period + top-5 leaderboard.
10. **Tier 2b — ORS rank.** Open the new amber **ORS Rank** expander. Choose payload (default Y) / window (default Wide 0–72h) / ground network (default on). Click **Sync ORS rank for all visible routes**. Pace ~30 routes/min. After completion, the **ORS** column shows your selected primary metric (default `ratingGapToTop`, signed; positive = winning). **RkNS / Gap / OrsC#** columns also populate. Click the ▾ on any ORS cell to drill into the cached connection list — no re-fetch.
11. **ORS — primary column swap.** Change the **Primary column** dropdown in the ORS expander to "Rank — own nonstop". Confirm the ORS column re-renders with `#1`-style values without re-scraping.
12. **ORS — circuit breaker.** Set ORS concurrency=10 in DevTools (`settings.routeAssistant.ors.concurrency = 10`) and trigger a bulk sync. After 3× consecutive 429/503, the expander shows a red banner with countdown and the bulk button disables.
13. **Two-enterprise sanity.** If you operate FLY NYON. + NYON. on the same world, confirm both prefixes appear in `routeAssistant:ors:JFK-LAX → ourCarrierPrefixes` and connections from either enterprise are highlighted in the drill-in drawer.

---

## 9 · Open work / next steps

Pulled from `MANUAL.md §16` (the master roadmap, letter-coded A–K) and the user's confirmed direction.

### Immediate
| Item | Status | Blocker |
|---|---|---|
| ~~**Auto-Pricing Tier 2a — Markets page**~~ | ✅ **Shipped this session.** See §1. Note the user actually wanted Tier 2a as the markets-page scraper (competitor flights + own pricing + market shares + historic charts), not just ORS rank — see new §1 for details. | — |
| ~~**Auto-Pricing Tier 2b — ORS rank**~~ | ✅ **Shipped this session as the ORS scraper.** True ORS rank from `/app/info/ors`, not the markets page (where the leaderboard is per-period booking outcomes, a different metric). | — |
| **Auto-Pricing Tier 3 — Apply / write-back** | Open. POST to `/app/com/markets/<HUB><DEST>?<wicket>-pair~form` with `classes:prices:N:newPrice` body. Per-route "Apply" button + batch-confirm modal default. Silent-auto behind a separate explicit setting (already wired into `settings.pricing.silentAutoEnabled`). |

### Next
| Letter | Item | Notes |
|---|---|---|
| **Tier 3** | Auto-Pricing apply / write-back | HIGH risk. Per-route "Apply" + batch-confirm modal default. Silent-auto behind separate explicit setting. POST to AS form. |
| ~~**Tier 4**~~ | ~~Yield feedback loop~~ | ✅ **Shipped this session as Roadmap G slice 1.** Folded into the new yield-feedback expander. Slice 2 is delta-mode + auto-snapshot. |
| ~~**J slice 2**~~ | ~~Used Aircraft Scanner — smarter deal-scoring~~ | ✅ **Shipped this session.** See §1 / §2. Six new metrics; `pricePerSeat` enabled by default in scoring blend. |
| ~~**F**~~ | ~~Full carrier list per route~~ | ✅ **Shipped this session.** See §1 / §2. New `routeAssistant:carriers:<HUB>-<DEST>` cache, colored intensity pill on Cmp column, hover tooltip with per-carrier list. **Caveat:** flightsfrom.com is a SPA — when their server doesn't SSR the carrier list (page returns skeleton HTML) the cache row carries `parserNotes` and an empty `carriers: []`. A future slice can add a child-tab worker for guaranteed extraction. |
| ~~**G**~~ | ~~Yield-timeline / actual-yields feedback~~ | ✅ **Slices 1–4 (sessions 1+2) shipped this session.** See §1 "Yield Feedback". Slice 2: delta-mode (per-tail baseline subtraction), V+/V− pill on the status column, `autoSnapshotOnMount` toggle, batch **Calibrate flagged** modal that opens a confirmation dialog listing every Δ%-flagged route and writes a batch override on save. Slice 3: cargo-yield calibration — `derivedYieldFromActuals` refactored to return `{side, value, alt}`; mixed routes auto-pick the dominant side and surface the alt; per-route override editor's Calibrate button branches `yieldPerKm` vs `cargoYieldPerKgKm`; Calibrate-flagged modal gains a per-row Side dropdown. Slice 4 sessions 1+2: per-flight attribution. `content_aircraftFlights.js` now writes a slim per-flight envelope onto `<server>aircraftFlights<id>.flights[]` (`{flightId, flightNumber, flightNumberId, status, originIata, destinationIata, depUtc}`); fixed the pre-existing flightId regex bug (`url.match(/\d+/)[0]` was picking "1" from `free1` hostname). New `attributionMode: "per-flight"` walks every tail's envelope, joins with `<server>flightInfo<id>.money.CM5.Total`, aggregates per `{originIata, destinationIata}` route — exact attribution, no frequency averaging, multi-leg FNs handled naturally. Routes with no measured flights fall back to per-tail frequency. Snapshot result reports `routesWithPerFlight` / `routesFellBack`. **Slice 4 session 3 parked**: extending `content_flightInfo.js` to extract origin/dest inline (would let per-flight work without first visiting the aircraft history page) — needs a `/action/info/flight?id=<id>` HTML sample first. |
| **H** | Wave + interlining + slot management | Tier 3, multi-session, ~600 LOC. Reuses `modules/schedule-management/`. |
| **I** | ORS-aware pricing simulation | Tier 3, ~500 LOC. **Fully unblocked — F + G + K all shipped.** Next big-ticket build. |
| ~~**K**~~ | ~~Deeper per-route demand from AS market analysis~~ | ✅ **Shipped this session.** Per-class historic via `?payload=` query param (Y/C/F/PAX/CARGO), new inventory-page scraper for RM buckets, pure-function demand-derivator computing pool / elasticity / RM tightness. New "Demand depth" expander + 5 scoring fields + 6 columns. Profit estimator gains opt-in `useRealDemandForLF` path. **I (ORS sandbox) now fully unblocked.** |
| ~~**J slice 3**~~ | ~~Used Aircraft Scanner — surface deal-metric tooltips with input breakdown~~ | ✅ **Shipped this session.** `daysToBreakEvenBreakdown()` and `seatKmYearCostBreakdown()` already retained intermediates and `decorate()` attached them to the row; results-table.js gained `_formatPricePerSeatTooltip`, `_formatMaintTooltip`, `_formatFleetTooltip` to fill remaining gaps so every deal column (`$/seat`, `$/seat·km/yr`, `BE (days)`, `Maint.`, `Fleet`, `Route-fit`) now shows a multi-line breakdown on hover. Inner-pill `title` attributes removed from `_renderMaintCell` / `_renderFleetCell` so the long tooltip wins. |
| ~~**J slice 4**~~ | ~~Used Aircraft Scanner — route-fit upgrade beyond range~~ | ✅ **Shipped this session as v3.** v2 had per-flight demand check (seats×LF ≥ paxScore×scale). v3 adds the weekly-frequency gate using the `weeklyFlights` field already on `topRoutes`: a regional that fits one flight's demand can still fail a route flown 14×/wk. New `frequencyLimited` counter, label format `x / y  (−A demand, −B freq)`, tunable via `routeFit.weeklyDemandPerScorePoint` (default 100, paxScore=10 → 1000 weekly seats). Routes without `weeklyFlights` skip the gate (no penalty — Tier 1 hasn't seen them yet). Tooltip extended to surface all three sequential gates. |
| ~~**F slice 2**~~ | ~~Carriers — AS-native enterprise enrichment in the Cmp tooltip~~ | ✅ **Shipped this session.** New `modules/route-assistant/enterprise-meta-scraper.js` fetches `/app/info/enterprises/<id>` per AS competitor and caches `{name, iata, bannerUrl, avatarUrl}` at `routeAssistant:enterpriseMeta:<id>` (90d TTL, single global key per id — non-directional). Cmp pill replaced its native `title=""` with a custom DOM popover (hover-open with 200ms delay, 250ms grace on leave, click-to-pin, Escape/outside-click dismiss — same pattern as `_openProfitModifierPopover`). Each row in the popover shows avatar + clickable name link to `/app/info/enterprises/<id>` + banner + share% + ▲/▼ change + rank, sorted by share. Falls back to the plain-text tooltip when `marketSharePax` is empty (routes without markets-scraper hits). New "Sync enterprise data" CTA in the Carriers expander batches the per-id fetches (default 4 concurrent / 600ms stagger). |
| ~~**F slice 3**~~ | ~~Carriers — interlining (IL) agreement indicator~~ | ✅ **Shipped this session.** Source resolved to `/app/info/enterprises/<your_id>?tab=1` ("Contractual partners" tab) — NOT `/action/enterprise/interlining` as the original guess suggested. New `modules/route-assistant/contractual-partners-scraper.js` mirrors `enterprise-meta-scraper.js`. Cache `routeAssistant:contractualPartners:<enterpriseId>` (non-directional, keyed by *your-own* enterprise id, NOT competitor). `_buildCarrierRow` reads `_partnersByEnterpriseId` and renders `⇄` (green) for INTERLINING and optionally `✦` (purple) for ALLIANCE next to the partner's name. New "Contractual partners" sub-panel in the Carriers expander with own-enterprise-IDs input + Refresh CTA + glyph toggles. Settings: `myEnterpriseIds`, `partnersMaxAgeDays` (30d default), `lastPartnersSyncAt`, `showInterliningGlyph`, `showAllianceGlyph`. Captures every relation type verbatim (LESSOR / ALLIANCE / INTERLINING / future tokens) so future relation types still surface. |

### Daily-driver QoL backlog (user-requested enumeration, end of K session)

The user asked "what else would be useful and practical?" after K shipped. The shortlist below is cheap-to-ship, high-frequency-use upgrades that would compound with everything currently in the panel. **Next slice picked: Diff against last visit.**

| Slice | What | Why it's practical | Est |
|---|---|---|---|
| ~~**Diff against last visit**~~ | ✅ **Shipped earlier this session.** New cache `routeAssistant:lastSnapshot:<HUB>` → `{hub, server, scrapedAt, rows: [{destIata, score, paxScore, cargoScore, weeklyFlights, airlineCount, competitorCount, paxDemandPool, cargoDemandPool, ourPaxShare, orsRatingGapToTop, rmTightness}]}` (row field `orsRatingGapToTop` rather than the spec's `ratingGapToTop` so the diff key matches the row property the cell reads). Baseline loaded once per (mount, hub) pair in `refresh()` into `this._diffPrevSnapshot`; rows decorated with `_diff.<field>` scalars in `_renderRows` before sort/draw; new snapshot written at end of `_drawTable` from `this.scoredRows` (overwrites storage but the in-memory baseline survives the mount, so intra-mount re-renders keep showing the same deltas). 11 numeric column render closures append a small grey ▲/▼ badge via `_appendDiffBadge`. Cmp column uses array-fallback (`["competitorCount", "airlineCount"]`) to track whichever source produced the cell value. | Turns the panel from a snapshot-stare into a change-detector — "on this hub overnight: Cmp +2 on JFK→LAX, RM% +5pp on JFK→ORD, ORS gap dropped on three routes." Replaces eye-scanning the table for what's changed. | ~175 LOC |
| ~~**Watchlist / starred routes**~~ | ✅ **Shipped this session as Daily-driver QoL slice 2.** See §1. The `RouteAssistantWatchlistStore` already existed from a prior session (`modules/route-assistant/watchlist-store.js`) but was unwired — manifest registration + panel.js wiring + `RA_WATCH_TRIGGERS` evaluation + the destIata cell `_buildWatchlistStar` glyph + `_sortRows` float-to-top + `settings.routeAssistant.watchlist.{floatStarredToTop, showAlertBadges}` finished it. Filters still apply to starred rows in v1; cross-tab `chrome.storage.onChanged` listener for the watchlist key was deferred. The "separate Watched table above the main one" optional sub-feature was deferred — float-to-top + visible star is enough to surface them without splitting the layout. | Keeps the few routes you're actively managing front-and-centre instead of having to re-find them in the score-sorted list every visit. | ~120 LOC |
| **Route notes** | Free-text per-route note (small textarea in a popover triggered from the dest IATA cell). Persists `routeAssistant:routeNote:<HUB>-<DEST>` → `{text, updatedAt}`. Surfaces in the destination tooltip + small 📝 glyph in the destination cell when present. | Memory across long-running games — "tried 2x daily, dropped — too much C-class capacity"; "watching for AA entry"; "served by partner under interline". Cheap to build, very high information density per char. | ~80 LOC |
| **Settings export / import** | JSON roundtrip for the entire `settings.routeAssistant` blob + Used Aircraft presets. Buttons in the panel header drop down: "Export config → file"; "Import config ← file" (with diff preview before commit). | Migrate between worlds, share configs with friends, back up tuning that took weeks. Single-click recovery if a sync goes wrong. | ~60 LOC |
| **Compare two enterprises** | Click any two enterprise pills in the Cmp popover → side-by-side diff modal of every overlap route showing each side's share + rank + change. | Useful for benchmarking specific competitors (who's eating your share?) without manually walking the leaderboard. Reuses F slice 2 popover infra. | ~180 LOC |
| **Alert thresholds** | Declarative per-row triggers — "alert me if RM% > 0.95 for 7 days running" or "alert me if competitor count increases on a route I serve". Persists alongside the watchlist; banner inside the panel + optional desktop notification on next mount. | Turns passive data into active prompts. Pairs strongly with watchlist. Defer until diff/watchlist/notes have shipped — it builds on those foundations. | ~250 LOC |
| **Cross-server view** | A unified dashboard that aggregates top routes across multiple AS worlds the user runs. Today every server is its own silo (storage keys are server-scoped). Probably belongs in the Used Aircraft Scanner dashboard rather than the RA panel. | Multi-world players currently can't see "what's hot" across their worlds at a glance. Niche but high-value for that segment. | ~300 LOC |
| **L** (NEW — user-requested, ultimate goal) | Multi-account "canopy" — manage multiple AS accounts as one virtual airline group | **Vision:** the user runs several AS accounts/enterprises (today: FLY NYON. + NYON., potentially more across game worlds). Today each requires a separate browser login + manual context switch. Goal is a single AES interface that holds saved credentials + session cookies for every account, transparently logs in/out as the user navigates, and aggregates every account's routes / fleet / yields / market shares / ORS rank into one consolidated dashboard. The user manages a whole "canopy" of routes across all profiles from one panel and never thinks about which account they're logged into. **Sub-features:** (1) Account-vault store with encrypted credentials + per-account session cookies, refreshed on demand. (2) Background tab orchestrator that opens a hidden tab per account, logs in if expired, runs a scrape pass, closes the tab. (3) Aggregator layer above existing per-server caches — new schema like `aesCanopy:account:<accountId>` referencing existing `<server>` keys. (4) Cross-account columns in the Route Assistant (e.g. "Best account for this route", "Routes my OTHER airline already flies"). (5) Cross-account scheduler that flags conflicts (same hub-pair operated by multiple of your airlines = pricing self-cannibalisation). (6) Permission/safety gates — bulk write actions (Tier 3 pricing apply, station opens) confirm per account. **Risks:** AS may have ToS limits around session sharing / multi-instance use; needs to read AS rules on automation. Login automation is fragile (CAPTCHA, MFA). Heavy storage growth. Probably the largest single feature on the roadmap — Tier 4, multi-session build, ~2000+ LOC. **Prereqs:** essentially every existing feature (this depends on each scraper being canopy-aware; refactor work first). |

### Tech debt
- **Rename `ticket-price-scraper.js`** → `schedule-page-scraper.js` once Tier 2 has a real price scraper. Defer until then to minimize churn.
- **Family-card grid override-walk** — slice 1 only walks the static `AS_TYPE_TO_FAMILY` map. User overrides land in the Custom card. A future slice should surface overridden labels inside their target family card.
- **Existing presets with multi-daily routes** — Wk column reads legacy cache via `frequencyPattern` fallback; one Sync click re-writes to the new `dailyFlights[]` shape.
- **`routeAssistant:topRoutes` freshness** — written every panel render, but the Used Aircraft Scanner reads on dashboard mount and never re-checks. If the user retunes weights and immediately scans, the dashboard will use the stale snapshot from the last RA panel visit. Acceptable for now; a `chrome.storage.onChanged` listener on the dashboard would auto-refresh the context (~20 LOC).
- **Break-even daily-hours assumption** — `MarketScanDealMetrics.DAILY_BLOCK_HOURS` is hard-coded at 10. A future tweak could pull it from a per-aircraft-class table (regionals 8, narrow 12, wide 14) or expose it as a setting. Today the constant is tuned for "earliest-sensible payback" rather than optimistic.
- **Carriers SSR fragility** — `RouteAssistantCarriersScraper` parses the initial HTML returned by `fetch(flightsfrom.com/<HUB>-<DEST>)`. When flightsfrom doesn't SSR the carrier list (or changes their markup), the record stores `parserNotes` describing what was tried and `carriers: []`. The panel falls back to the plain `airlineCount` integer in that case. A child-tab worker (parallel to `content_flightsFrom.js`) would let the SPA hydrate before extraction; defer until we observe SSR failing in practice.
- **Competitive-intensity bands** — three-band thresholds (1 / 2-3 / 4+) are intuition-tuned, not data-fit. If users want different cutoffs the boundaries should move into `settings.routeAssistant.carriers` as `{lowMax, midMax}`.
- **Enterprise-meta selector fragility** — `enterprise-meta-scraper.js` walks 4 strategies (`[class*='banner']`, `[class*='avatar' / 'logo' / 'profile']`, `og:image`, header-img) and disambiguates banner-vs-avatar by candidate width + class keywords. AS markup tweaks could break this. Records carry `parserNotes` so the failure mode surfaces in the popover footer ("Some banners/avatars missing — open Settings → Carriers → Sync enterprise data"). When the heuristic genuinely lands the wrong image in the banner slot, the user can right-click the popover row in a future slice to re-tune.
- **Tabbed view — per-tab weights not stored** — switching the tab gates which scoring fields contribute, but the *weight* for each field is shared across all three tabs. A user who wants `weeklyFlights × 1` on Pax but `× 0.5` on Cargo today can't express it. If demanded, lift `settings.routeAssistant.scoring` from a single block to `{all: {…}, pax: {…}, cargo: {…}}` with deep-fill on load.
- **Demand depth — elasticity small-N regressions** — `RouteAssistantDemandDerivator._elasticity` requires ≥ 4 valid (capacity, price) points after dropping zeros. New routes / dormant lanes will hit this floor and return null with a `derivationNotes` line. Acceptable now (the column shows em-dash); a future tweak could fall back to a global cross-route elasticity prior.
- **Demand depth — PAX double-count risk** — `_pickPaxSeries` prefers explicit `byPayload.PAX` over summing Y+C+F when all three are captured. AS's PAX historic is itself the sum of those three, so we pick one or the other deterministically. If AS ever exposes PAX as a *different* aggregate (e.g., excluding F), the demand pool would be wrong by ~5–10%. Verify against a live route before trusting.
- **Demand depth — inventory parser fragility** — `parseInventoryHtml` walks every table on the page and relies on header keywords (Economy/Business/First/Cargo, Total/Capacity/Sold/Booked). AS markup tweaks could break this. Records carry `parserNotes` describing what was tried. Real-world tuning likely needed against an actual `/app/com/inventory/<HUB><DEST>` HTML sample.

---

## 10 · Open invariants — don't break without checking

- Every `chrome.storage.local` key prefix in §4 is **stable**. Other features and saved user data read them.
- `RouteAssistantPanel.SCORING_FIELDS[i].field` ↔ `RouteAssistantPanel.COLUMNS[i].field` for any variable that's both scored and displayed.
- `RouteAssistantSettings.load()` always returns a fully-populated object (deep-merged with `_defaults()`). Never assume a freshly-loaded settings object lacks a field.
- `_pairKey` in `distance-resolver.js` is **alphabetically sorted** — distance is symmetric. `_pairKey` in `ticket-price-scraper.js` AND `yield-history-store.js` is **directional** — price/freq/profit differ by direction. Different rule per file; easy to mix up.
- `enterprise-meta-scraper.js` is **NOT keyed by route** — its cache key is `routeAssistant:enterpriseMeta:<enterpriseId>`. The same record is reused across every route the enterprise competes on. Don't add HUB/DEST to the key; you'd just blow up storage with duplicates.
- `contractual-partners-scraper.js` is keyed by `routeAssistant:contractualPartners:<enterpriseId>` where the enterpriseId is **your own**, not a competitor's. The record's *contents* tell you who that enterprise's partners are; the popover then matches partner ids against visible competitor ids. Fetching every visible competitor's `?tab=1` would (a) waste fetches and (b) miss cases where the partnership is asymmetric — only your own page reflects who YOU have agreed with. Don't repurpose the scraper for competitor-pulls without changing the consumer logic.
- F slice 3 popover glyphs read `this._partnersByEnterpriseId` which is built by `_applyCachedContractualPartners()`. That method is called from `init()` after `_applyCachedEnterpriseMeta()` and again after every refresh. Adding new ways for partners data to land must call it (or the glyphs go stale until the next mount).
- **Tabbed view (`viewMode`)** — `RouteAssistantPanel._columnModes(col)` and the SCORING_FIELDS `modes` array gate visibility per tab. The "all" tab MUST keep every field active (preserves the pre-tabbed score blend for users who don't switch tabs). New scoring/column entries that should hide on focused tabs need an explicit `modes` array; entries without one default to all three modes.
- **Demand depth — `historic.byPayload`** — DON'T fold the `byPayload` map back into a top-level `{periods, capacities, prices}` shape. The pre-K shape stored only ECONOMY; the new shape stores all five payloads under one record. `_migrateHistoricRecord` reads either shape on load, but new writes MUST use `byPayload`. Adding a top-level `payload` field again would silently break the per-class derivation in `demand-derivator.js`.
- **Demand depth — `useRealDemandForLF` defaults false** — flipping it on shifts every $/flt and $/wk number on routes that have demand-depth data. The `_renderDemandDepthSection` toggle prompts a confirm on first activation; that prompt MUST stay so users see the warning before profit numbers drift.
- **Demand depth cache key non-collision** — `routeAssistant:inventory:<HUB>-<DEST>` is **directional**. Cargo aircraft on the route still see the same key — there's no per-aircraft variant. Don't sub-key by typeId; the inventory page is route-level, not aircraft-level.
- Yield Feedback now supports four attribution modes (`frequency` / `distance` / `equal` / `per-flight`) and a separate `deltaMode` axis. **Cumulative vs delta** toggles per-tail averaging mode (subtracts the prior snapshot's cumulative profit/flights from each tail's current numbers). **Per-flight (exact)** is a different code path entirely — it ignores tail averages, joins each aircraftFlights envelope with `<server>flightInfo<flightId>.money.CM5.Total`, and aggregates by `{originIata, destinationIata}` from the envelope. Routes with no measured flights fall back to per-tail frequency-weighted, never silently fail. The baseline blob (`routeAssistant:yieldBaselines`) is updated on every snapshot regardless of the active mode so flipping into Delta mode doesn't need a warm-up pass.
- `dailyFlights` is always a 7-element array (Mon→Sun); `weeklyFlights = dailyFlights.reduce(+, 0)`; `daysPerWeek = dailyFlights.filter(>0).length`.
- The aggregator's `applyFleetContext(rows, null)` clears every fleet-derived field. Calling with `null` must reset to a clean Phase-1-style row.
- Cargo revenue defaults to OFF (`cargoYieldPerKgKm: 0`). Don't change the default; existing users would see surprise number shifts.
- Family-card grid does NOT walk `block.typeFamilyOverrides`. Override-walk is a slice-2 concern; scan-time controller still honors overrides.
- Phase 1 + 1.5 + 2 + 2.5 + 2.6 + 2.7 are all in production with user-tuned settings. Don't rip features without confirming.
- `routeAssistant:topRoutes` is **slim by design** (only the fields the Used Aircraft Scanner consumes). Adding fields here grows the per-render storage write — confirm a new consumer before extending.
- `routeAssistant:lastSnapshot:<HUB>` row keys are the **row property names** (`orsRatingGapToTop`, not the spec name `ratingGapToTop`). The diff lookup uses these literally — renaming the row field without renaming the snapshot key would silently kill the badge for that column on the next mount. The list of tracked fields lives in one place: `RA_DIFF_TRACKED` at the bottom of `panel.js`. Add a column → add an entry there → add `_appendDiffBadge(td, "<field>", row)` to the render closure. Don't fork the list.
- The diff baseline is **loaded once per (mount, hub) pair**, stored in `this._diffPrevSnapshot`. Within a single mount/hub session the baseline does NOT refresh from storage — even though `_drawTable` overwrites the snapshot every render, in-memory deltas remain anchored to "first read on mount". Hub change in the dropdown invalidates and re-loads via `this._diffBaselineHub` mismatch. Don't add a `chrome.storage.onChanged` listener for the snapshot key; the design intent is mount-anchored deltas, not live ones.
- `MarketScanDealMetrics.decorate()` mutates the row it's given. `MarketScanResultsTable._enrichDeal` always passes a fresh `Object.assign({}, r)` copy — new callers must do the same to avoid stomping `this.rows`.
- `RouteAssistantCarriersScraper._pairKey` is **directional** — `<HUB>-<DEST>` matches the flightsfrom URL pattern. Different from the symmetric `_pairKey` in `distance-resolver.js`. Easy to mix up.
- `RouteAssistantPanel._showCarrierIntensity` is a static class field updated in `_syncRenderContext()` from `settings.carriers.showCarrierIntensity`. The Cmp column's `render` closure reads it at draw time — adding new closures that depend on the carriers settings should follow the same pattern (don't reach back into a panel instance).
- **Markets-page split storage.** `routeAssistant:markets:*:<HUB>-<DEST>` is **4 sibling key families**, not one blob. Always read via `RouteAssistantMarketsPageScraper.bulkLoadCache(pairs, {families: [...]})` so the read amplifies into one combined `chrome.storage.local.get`. Writers MUST go through `saveAllRecords` — direct writes risk leaving the families out of sync.
- **ORS connections array is the source of truth for all rank flavors.** `routeAssistant:ors:<HUB>-<DEST>.connections` is the cached connection list; every rank flavor (`rankAny`, `rankNonstop`, …) and rating (`ourTopRating`, `ratingGapToTop`, …) is derived from it at scrape time. Adding a new rank metric should ALWAYS be a pure-function read against `connections`, never a re-scrape. The user explicitly chose "MAXIMISE OPTIONS" — keep that contract: store maximum data, filter at render time.
- **ORS Wicket per-route handshake.** Each `RouteAssistantOrsScraper.scrape()` does GET → POST. Do NOT try to share a wicket session across the bulk batch — page-version IDs increment per interaction; reusing a stale session returns a `PageExpiredException` HTML page that parses as zero results (silent corruption). The 2-request handshake cost is acceptable at concurrency=2 / stagger=1500ms.
- **ORS circuit breaker is mandatory.** First HTTP 429/503 increments `_consecutiveErrors`; 3 in a row halts the bulk run, persists `settings.ors.circuitBreakerTrippedAt`, and disables the bulk button for `circuitBreakerCooldownMs` (default 10 min). Never silently retry through rate limits.
- **`_pairKey` rule (recap, growing list).** Symmetric (alphabetically sorted): `distance-resolver.js`. Directional (`<HUB>-<DEST>` literal): `ticket-price-scraper.js`, `yield-history-store.js`, `route-overrides-store.js`, `carriers-scraper.js`, **`markets-page-scraper.js`** (this session, all 4 families), **`ors-scraper.js`** (this session). Different rule per file; easy to mix up.
- **`isOurs` detection** in `RouteAssistantOrsScraper.computeRanks` does **flight-number set match first, carrier-prefix fallback second**. Per user direction (option C of three offered). The flight-number set comes from the `<server><airline>schedule` cache (per-route `flightNumber: {FN1: {…}, FN2: {…}}` keys). For multi-enterprise users, both schedules contribute prefixes via `getOurCarrierPrefixes`.
- **Watchlist storage is global, not per-hub.** `routeAssistant:watchlist` holds every starred pair across every hub the user has touched. The panel filters by `this.hubIata` at render time (only pairs prefixed `<currentHub>-` decorate as starred). Don't add a per-hub key — the multi-hub design is intentional so a future "Watched routes" view can surface pinned routes across hubs in one place. Pair key is **directional** `<HUB>-<DEST>` uppercased; matches the orientation of `route-overrides`, `ticket-price`, `yield-history`.
- **Watchlist trigger fields piggyback on `RA_DIFF_TRACKED`.** `RA_WATCH_TRIGGERS` (in `panel.js`, immediately after `RA_DIFF_TRACKED`) lists `(field, worseDir)` pairs; every `field` MUST also appear in `RA_DIFF_TRACKED` because the trigger reads `row._diff.<field>` populated by `_decorateRowsWithDiffs`. Adding a tracked field for the diff badge is the prerequisite — the watchlist trigger is then a one-line addition. Removing a field from `RA_DIFF_TRACKED` without first removing it from `RA_WATCH_TRIGGERS` would leave the trigger inert (silent — the `Math.sign` check on a missing diff falls through). The signed direction matters: `+1` = an increase is bad, `-1` = a decrease is bad. Don't add a field whose worsening direction is ambiguous.
- **Watchlist + filters interact.** Starred rows are STILL subject to `status` / `minScore` / `fleetFlyableOnly` filters. A user who stars a route then dials minScore above the route's score will see it disappear from the table — the star isn't a filter override in v1. Documented behaviour; surface as a setting (`watchlist.bypassFilters`) only if the user asks. Float-to-top operates on rows that survived filtering, so the visual contract is "starred routes float above the rest of *what you're already showing*."
- **Watchlist toggle is optimistic.** `_toggleWatchlist` flips the in-memory Set + re-renders BEFORE awaiting `RouteAssistantWatchlistStore.toggle()` to keep the UI snappy. On storage failure the in-memory state is reverted and the panel re-renders again. Don't reorder these — awaiting storage first would block the click on a slow disk.

---

## 11 · What's been said (recent context)

- Auto-Pricing autonomy: c+d (one-click + batch-confirm) by default; silent-auto behind a separate explicit setting.
- Pricing UI: separate "Live route data" expander, not folded into Economics drawer.
- Tier order: 1 → 2a → 2b → 3 → 4. No skip-ahead.
- `Wk` column convention: real-airline-style per-day pattern (`2222211`) over "days flown" so multi-daily routes are accurate.
- Tier 2a parser: write against a real HTML sample (no heuristic-and-iterate this time).
- Pricing surfaces: user said "no separate price pages" — meaning prefer the markets page and possibly inventory; defer the global `/action/enterprise/flightsPrices` until needed.
- J slice 2 chosen this session over the (blocked) Auto-Pricing Tier 2a/2b. User will follow up with HTML samples for the Auto-Pricing Tier 2 work in a separate session.
- **This session — Tier 2a + 2b.** User shared HTML samples for `/app/com/markets/JFKATL`, `/app/info/ors` (empty + populated JFK→LAX). User chose: build Tier 2a (markets) first then 2b (ORS); identify "our" connections by flight-number match preferred + carrier-prefix fallback (option C of three); fetch ALL ORS pages (not just page 1); store split per-family for markets (4 keys); two new expanders (Market Analysis + ORS Rank); **MAXIMISE OPTIONS AND CHOICE FILTERINGS** for ORS — surface every rank flavor + every form input as user-tunable settings.
- Plan agent recommended trimming ORS rank flavors to 4 + cutting filter UI in half; this was overridden per the user's explicit "MAXIMISE OPTIONS" direction. Strategy: store maximum data, filter at render time. All 5 rank flavors stored, 8 rank flavors selectable as primary column, all form inputs (payload, window, ground, prefix override, threshold) exposed.
- Letter F chosen as the next unblocked deliverable after J slice 2 — small bridge work, builds on the existing flightsfrom infra, opens up I (ORS sandbox) by knocking out one of its three prereqs.
- Roadmap G chosen for the yield-feedback work (subsumes Auto-Pricing Tier 4). v1 is cumulative-average attribution; delta-mode and auto-snapshot left for slice 2 to keep the diff focused.
- Attribution default = **frequency-weighted**: each tail's lifetime average $/flt × its weekly flights on a route. Distance-mode + equal-split exposed in the dropdown but unverified — frequency is the one to defend.
- Calibrate-from-actuals affordance lives inside the existing per-route override editor (right-click a row), not as a one-click bulk action — high-impact write deserves a confirmation step.

End of handover.
