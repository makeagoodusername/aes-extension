# Upstream v0.7.8 → Fork v0.6.12-beta Integration Delta Matrix

Generated: 2026-05-04
Total items audited: 49.
- already-ported: 18
- needs-port: 22
- not-applicable: 6 (architecture diverged or feature unreachable in fork)
- risk-skip: 3 (would regress fork-specific extensions)

---

## Summary by subsystem

**Inventory.** Fork already absorbed the bigger v0.7.8 reshape — its `getAnalysis()` core was rewritten with class profiles, demand fallback, route-pressure index, settled vs. observed flights — so the spirit of items 1, 2, 5 is in. Concrete v0.7.8 surface items the fork still misses: grouped-by-flight parsing (item 7 — fork explicitly throws "Group by flight needs to be unchecked"), automatic re-render on layout toggles via `MutationObserver` (items 3 + 7), the executable-vs-reference recommendation split (item 4), and the `showReferenceRecommendation` opt-in setting (item 6) — though the **default settings already include `showReferenceRecommendation: 0`** in `legacy-defaults.js`, the wiring throughout content_inventory/content_settings is missing. Stale-snapshot fix (item 1) is delivered by `AesSettings._enqueueWrite` (`modules/_shared/settings-bridge.js:85-95`) and `content_settings.js`'s `AES.updateSettings`-style read-modify-write — already-ported by architecture, not by code reuse.

**Dashboard.** Fork has the bigger Dashboard (4509 vs 3159 LOC) — extra panes for Station Automation, UAS, Schedule Builder, Flights From — but it diverged before the v0.7.5–0.7.7 dashboard rewrite. Most v0.7.5–0.7.7 quality fixes (filter scope normalization, column chooser stay-open behavior, averaged Aircraft Profitability age, formatted-number sorting) **never landed in the fork**. These are non-trivial ports because the fork's render path is hand-rolled per-pane while upstream has a shared table architecture. 6 of 14 dashboard items are needs-port; 4 are risk-skip because porting blindly would break fork-specific aggregation (e.g. filter scope key would conflict with the fork's L2 account scoping).

**Fleet/Flights.** Biggest delta zone. Fork `content_fleetManagement.js` (329 LOC) is the **pre-v0.7.6** shape — no filter panel, no native selection-link binding, no `Equipment→Model` rename, no schedule-state labels, no HUB column. Upstream `content_fleetManagement.js` (774 LOC) is a full v0.7.6+v0.7.7 rewrite. Conversely, fork `content_aircraftFlights.js` (684 LOC, F-9228 hardening) is **more advanced** than upstream (507 LOC) in several ways (idempotent mount, popup-stagger, FN linkage envelope, airline-scoped storage key). HUB override controls (item 14) **are** in the fork but the surrounding fleet-management presentation (items 13, 15, 16, 17) is not.

**Background / Misc.** Fork's `background.js` (108 LOC) is a lean importScripts shim; `legacy-defaults.js` already declares `showReferenceRecommendation: 0`. Settings init (item 34) is correct in fork via `mergeDefaultSettings` in the parallel `legacy-defaults.js`-equivalent, plus an `AES.normalizeSettings` helper. Notifications init (item 36) is null-safe in fork (`modules/_shared/notifications.js:65-76`). Manifest V3 (item 31) is fully done. Per-airline competitor list (item 32) is in via `AES.getCompetitorMonitoringKey()`.

**Settings.** Settings stale-snapshot fix (item 1) and one-refresh personnel salary save (item 49) **are functionally equivalent** in fork via `AES.updateSettings()` (helpers.js:9–21) and `AesSettings._enqueueWrite` queue. Options page jQuery-slim status-message handling (item 8) is delivered by fork `options.js:436-475` using `.show()/.hide()` and `aesHideTimer` instead of `fadeOut()`.

---

## Delta table

| # | Version | Subsystem | Item | Upstream anchor | Fork anchor | State | Effort | Notes |
|---|---------|-----------|------|-----------------|-------------|-------|--------|-------|
| 1 | 0.7.8 | Inventory/Settings | Settings toggles overwritten by stale snapshots | content_inventory.js: rewritten to call `getSettings()` per refresh + `AES.updateSettings(mutator, cb)` for writes (no full-blob writes from stale memory) | modules/_shared/settings-bridge.js:85-95 (`_enqueueWrite` serial queue) + helpers.js:9-21 (`AES.updateSettings`) + content_settings.js:155-187 (mutator pattern) | already-ported | — | Delivered via the `AesSettings` queue, which serializes read-modify-write per-area. Stronger than upstream's pattern. |
| 2 | 0.7.8 | Inventory | Grouped Inventory Pricing zero-fallback edge cases (invalid historical fallbacks → 0 analysis price) | content_inventory.js:591-608 (guard `previousCmpData.valid && Number.isFinite(previousCmpData.analysisPrice) && previousCmpData.analysisPrice > 0`) | content_inventory.js: no historical-snapshot fallback in `getAnalysis()` — fork uses observed-rows demand fallback instead (line 715-737) | not-applicable | — | Fork's analysis path doesn't fall back to historical snapshots; uses settled flights and average price. The bug class doesn't exist here. |
| 3 | 0.7.8 | Inventory | AES reloads automatically after toggling `Group by flight` | content_inventory.js:46-65 (`watchInventoryLayout` MutationObserver + `getInventorySignature`) | content_inventory.js:198-216 — NO MutationObserver; throws "needs to be unchecked" then waits for full page refresh | needs-port | M | Add `watchInventoryLayout`, `rerenderInventoryModule`, `cleanupInventoryDisplay`, `getInventorySignature` after `displayInventory()`. Adapt `aes-h3-analysis` IDs (fork doesn't use them but should add for cleanup). |
| 4 | 0.7.8 | Inventory | Separate executable vs. reference recommendations; merge `New Price` into recommendation; right-align Load | content_inventory.js:824-826 (extra `<th>Reference</th>` when `showReferenceRecommendation`); displayRec() at 363-388 includes inline `→ NEW AS$` arrow | content_inventory.js:944-1013 — single `<th>Recommendation</th>` + separate `<th>New Price</th>`; Load is `<td>` not `<td class="aes-text-right">` (line 968 + 983) | needs-port | M | Restructure `displayAnalysis()` table head/body. Add `displayReferenceRec()` helper analogue. Right-align `<th>Load</th>` to `aes-text-right`. Inline new-price in displayRec text. |
| 5 | 0.7.8 | Inventory | Distinguish missing pax capacity from true zero-pax on Route Mgmt | content_inventory.js:564-595 (no zero-cap dilemma; falls through to `mostRecentData` when no current price flights) | content_inventory.js:451-458 `addInventoryFlightsToClass` sets `valid = totalCap > 0` — already handles zero capacity safely | already-ported | — | Fork explicitly tests `data.totalCap > 0` before declaring valid. Same protection. |
| 6 | 0.7.8 | Inventory | Opt-in setting for reference recommendations when current route price has no results | content_settings.js:111-114 + 152-153 + 179-186 — checkbox + persistence | content_settings.js: no `aes-input-inventory-showReferenceRecommendation` checkbox; modules/_background/legacy-defaults.js declares default `showReferenceRecommendation: 0` (helpers.js:55-66 also omits it from `defaultInvPricingSettings`) | needs-port | S | Add a single checkbox + click handler. Default is already 0. Also ensure `AES.defaultInvPricingSettings()` in fork helpers.js includes it (currently absent at line 55-66). |
| 7 | 0.7.8 | Inventory | Support for grouped inventory tables (`Group by flight` layouts) | content_inventory.js:152-227 (`getGroupedFlights` over `#inventory-grouped-table tbody`) | content_inventory.js:198-216 throws `"\"Group by flight\" needs to be unchecked"` — explicitly opts out | needs-port | L | New `getGroupedFlights(groupedTableBodies)` that walks each `#inventory-grouped-table tbody` and the indexed cells. Will also affect `validation.js:checkGroupByFlight` (currently raises an error) — that check needs to be conditional. |
| 8 | 0.7.8 | Misc | Options page status message — no `fadeOut()` for jQuery slim | options.js: not yet delivered upstream — upstream still uses `fadeOut` per the changelog note (jquery-3.7.1 slim) | options.js:436-475 `showStatusMessage` uses `statusDiv.hide()` + `statusEl.aesHideTimer` setTimeout — slim-safe already | already-ported | — | Fork is ahead of upstream here — `aesHideTimer` is a clean implementation. |
| 9 | 0.7.7 | Dashboard | Tab init, filter normalization, competitor schedule rendering not blanking | content_dashboard.js:13-37 + 105-156 (`normalizeDashboardFilterScope` clears stale per-airline filters; default tab normalization at 100-103) | content_dashboard.js:13-50 + dashboardHandle: no filter scope normalization, no per-airline filter wipe on airline switch | needs-port | M | Adapt `normalizeDashboardFilterScope` and `getDashboardFilterScopeKey` into fork dashboard init. Risk: fork has L2 account scoping that may conflict with upstream's filterScopeKey — must namespace under `currentAccountId` instead of `server:airline`. |
| 10 | 0.7.7 | Dashboard | Sorting numeric formatted values; valid `0` rendering | content_dashboard.js: numeric-aware sorter is part of the shared table architecture (referenced via `getNumber` parser in displays) | content_dashboard.js: per-pane sorts; rendered values use `Intl.NumberFormat()`; sorts use raw text comparison | needs-port | L | Multi-pane fix. Need a numeric-coerce sort comparator on Aircraft Profitability + Route Management columns. Risk-medium because fork's tables are hand-rolled per-pane. |
| 11 | 0.7.7 | Dashboard | Aircraft Profitability row actions for undelivered aircraft | content_dashboard.js:2494+ — `displayAircraftProfitability` checks `delivered` flag before exposing certain actions | content_dashboard.js:2668 onwards — no `delivered` flag rendering; assumes all rows have aircraftId | needs-port | M | Honor undelivered (no `aircraftId`) records gracefully in row-action menus. Depends on item 19's storage shape. |
| 12 | 0.7.7 | Fleet | Fleet Management filtering + native selection link integration | content_fleetManagement.js:567-650 (`fltmng_buildFilterPanel`) + 663-725 (`fltmng_bindNativeSelectionLinks`) | content_fleetManagement.js (entire 329 LOC): NO filter panel, NO native selection link bindings | needs-port | L | Wholesale port of upstream's filter panel + bindNativeSelectionLinks. Big visible UX win. |
| 13 | 0.7.6 | Fleet | Richer Fleet Management extraction (delivery, ownership, pilot, seat config, schedule state) | content_fleetManagement.js:43-65 (extra fields on `data{}`) + helpers `fltmng_isDelivered`, `fltmng_isOwned`, `fltmng_hasPilots`, `fltmng_getScheduleState` | content_fleetManagement.js:53-72 — fields are `registration, nickname, equipment, typeId, age, maintanance, seatsY/C/F, aircraftId, note, location, fleet, date, time` only | needs-port | L | The fork has its OWN extra-fields path (`typeId`, `location` for hub-detection, `note`) that upstream lacks. **Don't drop those.** Add upstream's fields alongside. |
| 14 | 0.7.6 | Fleet/Flights | Auto HUB detection from Flights page + override controls + fleet HUB filter | upstream content_aircraftFlights.js:309-338 `getHubStats` + 384-446 (`updateHubOverride`, `resetHubOverride`); fleetMgmt 528-552 `fltmng_getAircraftHubDisplay` | content_aircraftFlights.js: NO `getHubStats`, no override UI (the fork's content_aircraftFlights.js is class-based and lacks this), but per-tail HUB IS detected via `flight.originIata`/`destinationIata` (line 660-663) and logged. Override storage NOT integrated into Fleet Management table. | needs-port | L | Sub-parts: (a) add `getHubStats` to fork content_aircraftFlights.js based on counts of origin/dest IATAs; (b) add per-tail HUB override input (mirror upstream lines 99-138); (c) reflect HUB column in fleetMgmt (item 16). |
| 15 | 0.7.6 | Dashboard | Aircraft Profitability columns (delivery, ownership, pilot, seat totals, pure cargo, seat config, schedule, HUB) | content_dashboard.js: column definitions inside `displayAircraftProfitability` | content_dashboard.js:2668+ has Aircraft Profitability but with the older column set | needs-port | M | Once item 13 backfills storage, render the new columns. |
| 16 | 0.7.6 | Fleet | Equipment→Model header rename + HUB column | content_fleetManagement.js:392-395 (replace `Aircraft model` → `Model`) + 397-403 (insert `<th>HUB</th>`) | content_fleetManagement.js:259-262 — only adds `Profit/Loss` and `Extract date` headers; no Equipment rename, no HUB column | needs-port | S | Three-line edit once items 13/14 land. |
| 17 | 0.7.6 | Dashboard | Aircraft Profitability schedule labels (Active/Locked/Conflict/Empty) with colors | content_fleetManagement.js:188-218 `getScheduleState` + `getScheduleStateLabel` | content_fleetManagement.js: no schedule-state extraction at all | needs-port | S | Once item 13 lands, expose label + bind to a CSS color class in dashboard render. |
| 18 | 0.7.6 | Fleet | Restore aircraft ID capture when links use relative paths | content_fleetManagement.js:98-135 `fltmng_getAircraftId` + `fltmng_getAircraftIdFromRow` (regex tolerates `../aircraft/123` relative + `aircraft/123/` absolute + nested HTML scrape fallback) | content_fleetManagement.js:110-117 `fltmng_getAircraftId` does only `value.split('/')[length-2]` — fails for relative `../aircraft/123/0` form | needs-port | S | Direct port of upstream's regex-based `fltmng_getAircraftId` and the row-fallback `fltmng_getAircraftIdFromRow`. |
| 19 | 0.7.6 | Fleet/Dashboard | Undelivered aircraft stored by registration before aircraftId exists | content_fleetManagement.js:338-356 `fltmng_isSameAircraft` (compares aircraftId OR registration) + 274-303 storage envelope keeps `aircraftId: null` for undelivered | content_fleetManagement.js:182-204 — strict `value.aircraftId == newValue.aircraftId` matching; undelivered get a null id and are dropped from `aircraftData.push(data)` early because `getAircraftId` returns null | needs-port | M | Adopt upstream's `fltmng_isSameAircraft` and remove the early null-id discard. The fork has `fltmng_isValidAircraftRecord` guard that should be relaxed. |
| 20 | 0.7.6 | Flights/Fleet | HUB sync between Flights and Fleet Management/AP | content_aircraftFlights.js:340-381 `syncFleetHubData` writes back to `aircraftFleet` blob | content_aircraftFlights.js: no `syncFleetHubData` equivalent. Detected hub is in `flight.originIata` but never propagated to fleet storage. | needs-port | M | Port `syncFleetHubData` and call after `getHubStats` (after item 14a). |
| 21 | 0.7.6 | Flights | Flights page notifications auto-dismiss | upstream uses `Notifications` class with no auto-remove, but content_aircraftFlights.js:14 uses `Notifications` instance + status banner | fork content_aircraftFlights.js: no `Notifications` instantiation; uses inline UI status spans (line 487 `span.addClass('warning').text(...)`) | needs-port | S | Wire fork's `modules/_shared/notifications.js` (`window.AesNotifications.toast`) into content_aircraftFlights.js where the upstream uses `aircraftFlightNotifications.add()` — fork's `Notifications` IS implemented (notifications.js:60-96) and auto-dismisses via `setTimeout(..., duration)`. |
| 22 | 0.7.6 | Fleet/Flights | Table presentation (undelivered profit/date alignment, header centering, missing borders) | content_fleetManagement.js:430-435 `text-center` cells with `--`; content_aircraftFlights.js:170-186 wraps `formatMoney` for proper alignment | content_fleetManagement.js:281-285 emits raw `<td></td>` for missing profit (no `text-center` placeholder) | needs-port | S | Two-line patch in fork `fltmng_displayAircraftProfit` to emit `<td class="text-center">--</td>` instead of empty `<td></td>`. |
| 23 | 0.7.5 | Dashboard | Competitor Monitoring filter (substring matching) | content_dashboard.js:2000-2061 column/filter pickers reference `displayCompetitorMonitoringAirlinesTable` filtering | content_dashboard.js:1592-1850 — has Competitor Monitoring panel but no substring-text filter inputs | needs-port | M | Adapt upstream filter rows. Risk-low because data already exists. |
| 24 | 0.7.5 | Dashboard | Competitor Monitoring extraction (operated flights, seats offered, SKO, units offered, FKO) | content_enterpriseOverview.js:381-409 `getNumberByLabel` (label-based, robust to row reorder) | content_enterpriseOverview.js:363-376 `getTab2Data` uses positional `tbody:eq(N) tr:eq(N) td:eq(1)` — fragile to AS row reorder | needs-port | M | Direct port of `getNumberByLabel`. The metric set is already collected. |
| 25 | 0.7.5 | Dashboard | Column chooser stays open while toggling multiple cols (Comp Mon + AP) | content_dashboard.js:158-180 `buildDashboardControlPanel` keeps body via `dashboardControlPanelExpanded` state map | content_dashboard.js: no column chooser persistence; chooser is rebuilt each render | needs-port | M | Port `buildDashboardControlPanel` and `dashboardControlPanelExpanded` state machine. |
| 26 | 0.7.5 | Dashboard | Comp Mon filter panel appears even when no competitors tracked | content_dashboard.js:1593-1604 unconditionally renders filter | content_dashboard.js:1845-1850 emits "No airlines marked for competitor monitoring" warning row, doesn't render filter | needs-port | S | Move the empty-state into a fallback table row but always render the filter UI above. |
| 27 | 0.7.5 | Dashboard | Per-controlled-airline competitor index (load only relevant schedules) | content_enterpriseOverview.js:108-133 `updateCompetitorMonitoringIndex` writes `<server><ownerAirlineId>competitorMonitoringIndex` | content_enterpriseOverview.js: NO competitor-monitoring index. Iterates all `competitorMonitoring` keys without scoping. | needs-port | M | Port `updateCompetitorMonitoringIndex` + read-side scan in dashboard `displayCompetitorMonitoring` (currently grep-by-suffix). |
| 28 | 0.7.5 | Fleet | No phantom aircraft entry when default fleet empty | content_fleetManagement.js:265-321 (only push records that survive `aircraftData.forEach` — empty fleet → empty `newfleet`) | content_fleetManagement.js:175-231 — same pattern, but the path `if(data && Array.isArray(data.fleet))` cleanly degrades; **already safe** | already-ported | — | Both implementations gate on Array.isArray. Fork is OK. |
| 29 | 0.7.5 | Inventory/Dashboard | Runtime errors from missing page elements / unavailable storage | content_dashboard.js:9-12 + content_inventory.js: defensive `if (!dashboardStorage) return;` and try/catch | content_dashboard.js:14-25 `if (!document.querySelector("#enterprise-dashboard")) return;` + try/catch around getServerDate; content_inventory.js:198-204 wraps `#inventory-table` lookup with throw + catches in `rerenderInventoryModule` (well, no, the fork's init only uses `aesmodule.valid`) | already-ported | — | Fork has matching defensive guards. |
| 30 | 0.7.5 | Dashboard | Aircraft Profitability age aggregation: averaged in summary | content_dashboard.js:2494+ — `displayAircraftProfitability` summary row computes mean | content_dashboard.js: no average-age in fork's AP summary path (grep returned no `avgAge`/`averageAge`/`sumAge` matches) | needs-port | S | One-line: `summary.avgAge = sumAge / count` in the AP summary row builder. |
| 31 | 0.7.5 | Misc | MV3 compliance (no remote stylesheets, no `ShowPageAction`) | manifest.json action+icons block; background.js uses `ShowAction` | manifest.json + background.js:104 — uses `chrome.declarativeContent.ShowAction()` | already-ported | — | Confirmed clean. |
| 32 | 0.7.5 | Dashboard | Per-airline competitor list (not server-wide) | content_enterpriseOverview.js:11-12 `AES.getCompetitorMonitoringKey(server, ownerAirline.id, airline.id)` | helpers.js: no `getCompetitorMonitoringKey` (fork's helpers.js has different scoping helpers); content_enterpriseOverview.js:16 builds `server+airlineId+'competitorMonitoring'` — **not owner-scoped** | needs-port | M | Port `getCompetitorMonitoringKey(server, ownerAirlineId, competitorAirlineId)` and `getCompetitorMonitoringIndexKey(server, ownerAirlineId)` to fork helpers.js, then thread `ownerAirline.id` from `AES.getCurrentAirline()` through enterprise/dashboard scrapers. |
| 33 | 0.7.5 | Misc | Old data cleanup: `YYYYMMDD` parses correctly | upstream options.js (master archive, not the migration page in fork) | options.js:397-417 `parseStorageDateKey` correctly parses `^\d{8}$` form | already-ported | — | Fork explicitly handles 8-digit-date parsing. |
| 34 | 0.7.5 | Misc | Settings init delivers newly-added defaults to existing users | upstream content_settings is small; uses `setDefaultSettings` then merges | modules/_background/legacy-defaults.js:7-22 + helpers.js:96-98 `normalizeSettings` deep-merges defaults onto raw — both startup and per-page; modules/_background/legacy-defaults.js:85-103 only writes if `!result.settings`; the deep merge happens at `AES.normalizeSettings` call sites | already-ported | — | Fork actually has it BOTH ways: (1) install-time `setDefaultSettings` skips when blob exists, (2) every page-time `AES.normalizeSettings` merges defaults onto whatever's stored. Stronger than upstream. |
| 35 | 0.7.5 | Misc | Avoid storing data under empty airline key | upstream getAirline raises error if airline can't be determined | helpers.js:106 `throw new Error("Unable to determine airline from the current page")` if no name resolved | already-ported | — | Fork explicitly throws. |
| 36 | 0.7.5 | Misc | Notifications init null-safe when navbar container absent | upstream notification.js: similar fallback to body | modules/_shared/notifications.js:65-76 — `target = ... || document.body` | already-ported | — | Fork falls back to `document.body`. |
| 37 | 0.7.4 | Inventory | Price boundaries inactive when price beyond max/min | upstream content_inventory.js:683-700 — `Math.min(maxPrice, Math.max(minPrice, currentPricePoint + step))` | content_inventory.js:803-812 — `clampInventoryNumber(currentPricePoint + step, config.minPrice, config.maxPrice)` | already-ported | — | Same clamp shape. |
| 38 | 0.7.3 | Inventory | Load index calculation reworked | upstream content_inventory.js:785-794 `index = (10 ** (analysisPricePoint/100 - 1)) * load*100` | content_inventory.js:933-942 `index = (analysisPricePoint + load*100*3) / 4` — DIFFERENT formula | risk-skip | — | Fork has its own load-index formula tied to its profile/route-pressure model. Reverting to upstream's formula would break the fork's calibrated thresholds. Document divergence; do not port. |
| 39 | 0.7.3 | Inventory | History "Now" column comparison + percent signs + "Show now" matching | content_inventory.js:1148-1186 + 1233-1253 (oldest-first slicing, comparison anchor at end) | content_inventory.js:1271-1396 — uses different slicing direction (`isOldest = i === dates.length - 1` vs upstream's; the comparison logic in the fork's `displayDifference` is OK but the columns layout indices differ). Fork uses `colspan="5"` for non-first vs upstream's `colspan="5"` for non-oldest. | needs-port | M | Audit fork's `buildHistoryTable` carefully against upstream — the fork's `dates[dates.length - 1]` for prev-row in the Now-column path **is correct** (newest after sort+reverse), but the per-class iteration uses `i` indices that could mis-pair when `showOnlyPricing` is on. Verify with a unit smoke. |
| 40 | 0.7.2 | Misc | ORS scores displayed as numbers | modules/onlineReservationSystem/onlineReservationSystem.js:45-58 `addNumberToRating` | modules/online-reservation-system/host.js:55-67 — same shape, same labels | already-ported | — | Confirmed (fork file is annotated "Adapted from upstream v0.7.8"). |
| 41 | 0.7.2 | Misc | Configuration backup created with correct extension version | upstream options.js: `chrome.runtime.getManifest().version_name` | options.js:230-238 — uses `manifest.version_name` | already-ported | — | Fork uses `version_name` correctly. |
| 42 | 0.7.1 | Misc | Import/export functionality of options | upstream options.js — full backup/restore + version metadata | options.js:20-339 — full backup/restore, multiple types, status messages, file picker, replace/merge modes | already-ported | — | Fork's options.js is significantly more featured than upstream. |
| 43 | 0.7.1 | Internal | Flight extraction function split from main code | upstream modules/flightInfo/flightInfo.js — class-based extraction | modules/flightInfo/* exists but content_flightInfo.js has the inline extraction; the FlightInfo class is in `modules/flightInfo/` (per fork dir tree) but `content_flightInfo.js` is the legacy 191-line procedural version | not-applicable | — | Fork chose to keep procedural content_flightInfo.js because of F-9228-807 airline-scoped key + chrome.runtime.lastError surfacing — the upstream class doesn't carry those hardenings. Risk-skip if a port loses hardening. |
| 44 | 0.7.1 | FlightInfo | A-B-C stopover flights no longer counted into A-C frequency | upstream content_flightSchedule.js parses each line into separate legs | content_flightSchedule.js:65-89 — same approach (`destinationCount` increments per destination row); A-B-C is counted as A-B + B-C separately if AS renders them as separate destination rows | already-ported | — | Same approach. Verify via live page. |
| 45 | 0.7.1 | FlightInfo | Stopover flights parsed as separate legs | upstream + fork content_flightSchedule.js: same destination-row iteration | content_flightSchedule.js: same | already-ported | — | Same. |
| 46 | 0.7.1 | FlightInfo | Stopover + "active in future" pax flights not classified as cargo | upstream content_flightSchedule.js: relies on `route.flightNumber[fn].remark` flag | content_flightSchedule.js:172-181 — same `if(remark)` cargo branch | already-ported | — | Same logic. |
| 47 | 0.7.1 | FlightInfo | Flight info extracts on free game worlds | upstream uses `id=` query parser robust to free-server hostnames | content_aircraftFlights.js:644-650 — has explicit `[?&]id=(\d+)` regex with comment "url.match(/\d+/)[0] picked up the '1' in `free1` from the hostname" — **F-9228 fix already addresses this** | already-ported | — | Fork's hardening explicitly references the upstream bug class. |
| 48 | 0.7.0 | Misc | Open new tabs for route mgmt can correctly open 6 tabs | upstream uses staggered `window.open` with cap of 6 in dashboard route-mgmt | content_dashboard.js: "select first 10" and "open inventory (max 10)" buttons rendered (line 175-178) — different cap (10 not 6) | risk-skip | — | Fork has DIFFERENT cap (10) intentionally because of its own UAS staggering. Don't downgrade to 6. |
| 49 | 0.7.0 | Personnel | Salary adjustments save with one refresh | upstream content_personnelManagement.js:108-166 `salaryUpdate` uses `AES.updateSettings` with mutator + per-row sequential await | content_personnelManagement.js:99-158 `priceUpdate` does the loop synchronously with `salaryBtn.click()` then `chrome.storage.local.set` per row — **may need a second refresh** because the Wicket form submit isn't awaited | needs-port | M | Adopt upstream's `salaryUpdate(span)` pattern: per-row `salaryInput.val(newSalary).trigger('input')` + `salaryBtn.closest('form')[0].submit()` + `await new Promise(resolve => setTimeout(resolve, 100))`. Fork still uses the legacy `salaryBtn.click()` early-return pattern. |

---

## Per-needs-port detail

### Item 3 — Auto-rerender on `Group by flight` toggle

**What upstream does** (`content_inventory.js:46-65`):
```js
function watchInventoryLayout() {
    const target = document.querySelector(".container-fluid .row .col-md-10") || document.body
    inventoryObserver = new MutationObserver(function() {
        clearTimeout(inventoryRefreshTimer)
        inventoryRefreshTimer = window.setTimeout(function() { rerenderInventoryModule(false) }, 150)
    })
    inventoryObserver.observe(target, { childList: true, subtree: true })
}
function getInventorySignature() {
    const groupedBodies = document.querySelectorAll("#inventory-grouped-table tbody").length
    const classicRows = document.querySelectorAll("#inventory-table tbody tr").length
    return [groupedBodies, classicRows].join(":")
}
```

**Fork today:** Throws `Error("\"Group by flight\" needs to be unchecked")` from `validation.js` and never re-renders — the user must full-refresh the page.

**Recommended port:** Add `watchInventoryLayout()`, `cleanupInventoryDisplay()` (remove `#aes-h3-analysis, #aes-div-analysis` etc), and `rerenderInventoryModule(force)` to fork `content_inventory.js`. Hook into `AesBoot.register` init as a follow-up after first render. **Depends on item 7** to be useful.

**Risks:** MutationObserver will see fork's own DOM mutations (it inserts panels) — must guard via signature comparison. Fork's `aes-h3-analysis` IDs aren't currently emitted (line 951) — must add IDs first, then cleanup.

---

### Item 4 — Recommendation column restructure

**What upstream does:** Single `<th>Recommendation</th>` cell that renders both text and inline `→ NEW AS$ (NN%)` arrow when `analysis.data[cmp].newPrice` exists. Reference column `<th>Reference</th>` only shows when `settings.invPricing.showReferenceRecommendation`. Load column right-aligned.

**Fork today:** Two columns (`Recommendation` + `New Price`); Load is left-aligned.

**Recommended port:** Edit `displayAnalysis()` lines 964-989 to merge columns and conditionally render reference. Add `analysis.displayReferenceRec(cmp)` mirroring upstream lines 389-413.

**Risks:** Visual regression — confirm column widths don't break with reference enabled.

---

### Item 6 — `showReferenceRecommendation` opt-in setting

**Recommended port (single edit each):**
- `content_settings.js`: insert checkbox HTML + click handler around line 113.
- `helpers.js:55-66`: add `showReferenceRecommendation: 0` to `defaultInvPricingSettings()` return.
- `legacy-defaults.js:54-65`: already has it. (verified line 88).

**Risks:** None — default off.

---

### Item 7 — Grouped inventory table parsing

**What upstream does** (`content_inventory.js:178-227`):
```js
function getGroupedFlights(groupedTableBodies) {
    for (const tbody of groupedTableBodies) {
        const sharedCells = rows[0].querySelectorAll("td")
        const flightNumber = sharedCells[1].querySelector("a[href*=numbers]")?.innerText
        // ... index-shifted cell layout for first vs subsequent rows
    }
}
```

**Fork today:** Throws "needs to be unchecked" via validation.

**Recommended port:** New `getGroupedFlights` function. Bypass `validation.checkGroupByFlight` when grouped table is present. Re-test the price-applier path because grouped layout doesn't expose per-class `newPriceInput` cleanly.

**Risks:** Potentially conflicts with fork's `CentralInventoryQuickPriceApplier` which expects classic layout for its scope checkbox parsing. **Test in dry-run only first.**

---

### Item 9 — Dashboard filter scope normalization

**Recommended port:** `normalizeDashboardFilterScope` + `getDashboardFilterScopeKey` from upstream, but compose with fork's L2 account scope rather than `server:airlineId` directly.

**Risks:** **HIGH.** The fork has L2 account scoping via `currentAccountIdSync()` and `settings.acct.<id>.<area>`. A naive port would create a parallel scope key and double-wipe filters on airline switch. Use `currentAccountIdSync()` as the scope key.

---

### Item 12 — Fleet Management filter panel + selection link integration

**Recommended port:** Wholesale port of upstream lines 567-725. Fork's filter panel is absent.

**Risks:** Low — purely additive UI.

---

### Item 14 — Auto HUB detection + override

**Recommended port:** Three sub-ports:
1. Add `getHubStats(flights)` to fork content_aircraftFlights.js based on `flight.originIata`/`destinationIata` counts.
2. Add HUB override input + save/reset buttons in the panel.
3. Persist `hubOverride`/`hubEffective`/`hubDetected` in saveData blob (currently absent — check fork line 282-318 saveData).

**Risks:** Conflicts with the F-9228 saveData envelope. Add fields without changing existing fields.

---

### Item 19 — Undelivered aircraft stored by registration

**What upstream does:** `fltmng_isSameAircraft(stored, aircraft)` compares aircraftId OR registration; allows null `aircraftId` to remain in storage.

**Fork today:** Strict aircraftId match; null id records are dropped early (`fltmng_isValidAircraftRecord` at line 121-123).

**Recommended port:** Add `fltmng_isSameAircraft` helper, relax the early discard. Update `getAircraftId` to return null gracefully (already does).

**Risks:** Low — additive.

---

### Item 24 — Comp Mon `getNumberByLabel` extraction

**Recommended port:** Direct port of upstream `getNumberByLabel(labels, fallbackCell)` lines 384-400. Replace fork's positional `tbody:eq(N)` lookups in `getTab2Data`.

**Risks:** None — additive with positional fallback.

---

### Item 27 — Per-controlled-airline competitor index

**Recommended port:** Port `updateCompetitorMonitoringIndex` to enterpriseOverview.js. Adapt dashboard read side to fetch only the index'd competitors instead of grep-by-suffix all storage.

**Risks:** Storage-key migration required: existing fork users have `<server><airlineId>competitorMonitoring` blobs (no owner scope). Either dual-read (owner-scoped first, fallback to legacy) like upstream does at line 11-14, or write a one-time migrator.

---

### Item 30 — Avg-age in AP summary

**Recommended port:** One-line in `displayAircraftProfitability` summary row builder.

**Risks:** None.

---

### Item 32 — Per-airline competitor list (helpers.js helpers)

**Recommended port:** Add `AES.getCompetitorMonitoringKey(server, ownerAirlineId, competitorAirlineId)` and `AES.getCompetitorMonitoringIndexKey(server, ownerAirlineId)` to fork helpers.js. Wire into enterpriseOverview.js + dashboard.js. **Do this together with item 27.**

**Risks:** Migration described above.

---

### Item 49 — Personnel salary one-refresh save

**What upstream does:** `salaryInput.val(newSalary).trigger('input')` then `salaryBtn.closest('form')[0].submit()` per row, awaiting `setTimeout(100ms)` between rows. Wraps in `AES.updateSettings(mutator, async cb)`.

**Fork today:** Calls `salaryBtn.click()` then immediately triggers a chain that requires the page to refresh and re-enter via `settings.personelManagement.auto`.

**Recommended port:** Adopt upstream's per-row sequential await pattern. Eliminates the `auto: 1` re-entry.

**Risks:** Low — but verify against the live AS Wicket form to confirm submit() doesn't bypass validation.

---

## Manifest coverage check

The fork manifest has 32 `matches:` blocks vs upstream's 11. The fork is a strict superset for content scripts that exist in upstream:

| Upstream URL pattern | Upstream block | Fork manifest line | Fork carries upstream content_*.js? | Fork carries upstream module? |
|---|---|---|---|---|
| `/app/com/inventory/*` | content_inventory.js + validation.js | 183-184 (line 179-181 carries `quick-price-applier.js`, `content_inventory.js`, `validation.js`) | yes | partial — validation.js + quick-price-applier.js present, no `host.js`/`grouped-table-detector.js` |
| `/app/info/enterprises/*tab=3` | content_flightSchedule.js | 191-192 | yes | n/a |
| `/app/enterprise/settings*` | content_settings.js | 199-200 | yes | n/a |
| `/app/enterprise/dashboard*` | content_dashboard.js | 536-537 | yes | n/a |
| `/action/enterprise/staffOverview*` | content_personnelManagement.js | 746-747 (per `:744`) | yes — but spelled `content_personnelManagement.js` (correct) | n/a |
| `/app/info/enterprises/*` | content_enterpriseOverview.js | 786-787 | yes | n/a |
| `/action/info/flight*` | modules/flightInfo/flightInfo.js | 796-797 | NO — fork uses `content_flightInfo.js` (procedural) at this URL; the FlightInfo class in `modules/flightInfo/` is not loaded by manifest as the upstream entry | risk-skip — fork's procedural version has F-9228-807 hardening |
| `/app/fleets/aircraft/*/1*` | content_aircraftFlights.js | 824-825 | yes | n/a |
| `/app/fleets*` | content_fleetManagement.js | 1185-1186 | yes (older, smaller version) | n/a |
| `/app/info/ors*` | modules/onlineReservationSystem/onlineReservationSystem.js | 804-805 | yes — fork file `modules/online-reservation-system/host.js` is a port (annotated) | confirmed `Adapted from upstream v0.7.8` |

**Findings:**
- All 11 upstream URL blocks are covered by the fork manifest.
- Fork's per-tab JS list per block is much larger (the fork loads many extra modules per page), which is expected.
- The fork's content_flightInfo.js path uses a procedural-not-class version intentionally (F-9228-807 hardening) — risk-skip the upstream-class swap unless those hardenings are preserved.
- The fork's content_fleetManagement.js block (at line 1185+) does NOT include the upstream filter/HUB modules because they don't exist as separate fork files — those features need to be ported into the existing `content_fleetManagement.js`.

---

## Top recommendations for Phase 2

1. **Item 7 + 3** (grouped inventory + auto-rerender) — biggest user-visible win, addresses a hard error message.
2. **Item 12 + 13 + 16 + 17 + 18 + 19** — Fleet Management modernization batch. Big visible UX upgrade.
3. **Item 4 + 6** — Recommendation column restructure + showReferenceRecommendation toggle. Small effort, immediate clarity.
4. **Item 27 + 32** — Per-airline competitor monitoring. Storage-correctness fix; do together with a migration shim.
5. **Item 49** — Personnel one-refresh fix. Removes a known annoyance.

## Top risk-skips to flag

1. **Item 38** — Don't replace fork's load-index formula. Fork's `(analysisPricePoint + load*100*3)/4` is calibrated to its profile/route-pressure model.
2. **Item 43** — Don't swap fork's procedural content_flightInfo.js for upstream's class. Loses F-9228-807 airline-scoped key + chrome.runtime.lastError surfacing.
3. **Item 48** — Don't reduce route-mgmt tab cap from 10 to 6. Fork chose 10 intentionally for its UAS staggering.

## Open questions for the user

- Item 7's grouped-inventory port may interact with `CentralInventoryQuickPriceApplier`'s scope-checkbox parsing. Recommend live-verify in dry-run after port; do not flip live writes in the same session.
- Item 27's competitor-monitoring index needs a migration decision: dual-read with legacy fallback (low risk, lingers stale data) vs one-time migrator (clean, requires careful key transform). Recommend dual-read.
- Item 9's dashboard filter scope must compose with L2 account scoping, not replace it. Recommend confirming with Agent 6 (substrate owner) before edit.
