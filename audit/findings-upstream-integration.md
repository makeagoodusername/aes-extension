# Findings — Upstream AES v0.7.6–v0.7.8 integration

Cross-territory backport of the upstream AES (NEWLY2014) feature additions that
postdate this fork's split point. Plan: `~/.claude/plans/clever-toasting-haven.md`.

Upstream source: `/Users/jihwan/Downloads/AES.v0.6.9/AirlineSim-Enhancement-Suite-main/extension/`.
Current target: `/Users/jihwan/Desktop/AES.v0.6.9/`.

Each slice is one commit, scoped to one territory where possible.
Verification per slice: `node --check` on touched files; live verify in own
Chrome instance against AS; SHARED-NOTES real-write lock only if verification
mutates AS state (none expected for slices 1–6).

## Summary

| # | Slice | Disposition | Touches | Commit |
|---|---|---|---|---|
| 1 | Settings save/load race fix | [FIXED] | settings-bridge.js, content_inventory.js, content_settings.js | 447e7ca |
| 2 | Grouped inventory tables (Group by flight) | [FIXED] | content_inventory.js | 199ceee |
| 3 | Inventory pricing reference recommendations (opt-in) | [FIXED] | content_inventory.js (toggle: 2dcb2cd) | 91c42c4 |
| 4 | HUB override controls + auto-detection | (pending) |  |  |
| 5 | Richer Fleet Management extraction | (pending) |  |  |
| 6 | Aircraft Profitability new columns | (pending) |  |  |

---

## Slice 1 — Settings save/load race fix (v0.7.8)

**Disposition:** [FIXED]

**Origin:** Upstream CHANGELOG 0.7.8: *"Fixed Inventory Pricing so settings
toggles such as automatic price updates and automatic tab closing are no longer
overwritten by stale settings snapshots from other pages."*

**Diagnosis (current fork):**

The fork's `AesSettings.saveArea(area, block)` (`modules/_shared/settings-bridge.js`)
serializes writes through a same-realm tail-Promise queue, but it *replaces the
whole area block* with the caller's local snapshot. Across realms (different
tabs on different AS pages), this produces the same stale-snapshot race upstream
fixed in v0.7.8: tab A's toggle save can clobber tab B's just-saved sibling
field, because tab A's local snapshot was captured at page load, before tab B's
write.

Affected call sites (all use the vulnerable "edit one field locally, save the
whole block" pattern):

- `content_inventory.js:1192,1201,1210` — history-table toggles
  (`historyTable.showNow` / `showOnlyPricing` / `numberOfDates`)
- `content_settings.js:80` — flightInfo `autoClose` toggle
- `content_settings.js:164,172,180` — invPricing `autoAnalysisSave`,
  `autoPriceUpdate`, `autoClose` toggles
- `content_settings.js:298` — invPricing `recommendation[cmp]` save (per-class
  step table); previously clobbered sibling toggles

**Fix:**

Added two new methods to `AesSettings` in `modules/_shared/settings-bridge.js`:

- `mutateArea(area, mutator)` — read-modify-write primitive. Reads the freshest
  stored block, applies `mutator(block)` in place, writes back. Resolves with
  the new block.
- `mutateAreaScoped(area, mutator, accountId)` — scoped variant for
  `settings.acct.<id>.<area>`.

Both route through the existing `_enqueueWrite` queue, so same-realm
serialization is preserved. The cross-realm race window narrows from
"snapshot-since-page-load" (minutes/hours) to the storage I/O round-trip
(milliseconds) — matching upstream's `AES.updateSettings(mutator, callback)`
fix.

Migrated the seven vulnerable call sites above from `saveArea` /
`saveSettingsArea` to `mutateArea` with field-level patches. The local
`settings` snapshot is still updated for re-render; only the storage write
moves to RMW.

Left intentionally untouched: `saveInvPricingSettings()` and
`saveSettingsArea(area, done)` wrappers remain available for genuine
full-block replacement use cases.

**Inviolable rules check:**
- §2 storage contracts: no key shape change. `settings` blob structure preserved.
- §5 bus integration: `AesSettings.mutateArea` emits the same
  `data:settings:area:saved` topic shape via `_writeSettingsBlob` event hint.
- §7 no silent default flips: not applicable; this is a save-path fix, not a
  default change.

**Verification:**

- Static: `node --check` clean for all three files.
- Behavioral (run in browser): open the AS Settings page in tab A, the
  Inventory page in tab B; toggle `autoPriceUpdate` in A, then toggle
  `historyTable.showNow` in B; reload tab A; both toggles should remain
  applied. Without the fix, B's reload would show A's `autoPriceUpdate`
  state and B's own `showNow` change reverted (or A's `autoPriceUpdate`
  reverted depending on save order).

**Files changed:**

- `modules/_shared/settings-bridge.js` — added `mutateArea`, `mutateAreaScoped`
- `content_inventory.js` — three history-table toggle handlers
- `content_settings.js` — flightInfo + three invPricing + recommendation save

**Territory:** Spans Agent 6 (substrate) and Agent 7 (content scripts). Done as
one commit because the API addition and call-site migration are tightly coupled.

---

## Slice 2 — Grouped inventory tables, "Group by flight" (v0.7.8)

**Disposition:** [FIXED]

**Origin:** Upstream CHANGELOG 0.7.8:
- *"Added support for grouped inventory tables so AES analysis can read `Group
  by flight` layouts without forcing players back to the classic table."*
- *"Fixed Inventory Pricing so AES reloads automatically after toggling `Group
  by flight`, without requiring a full page refresh."*

**Diagnosis (current fork):**

`content_inventory.js:getFlights()` looked only for `#inventory-table` (the
classic flat layout) and threw `"Group by flight" needs to be unchecked` when
the user toggled the AS-native Group by flight control. There was no observer
to notice layout changes, so even after the user satisfied the message and
toggled back, AES would not re-mount until the user manually refreshed the
page.

**Fix:**

1. Added a layout-aware `getFlights()` that detects the grouped layout via
   `#inventory-grouped-table tbody` and dispatches to the new
   `getGroupedFlights()` parser; falls back to the classic `#inventory-table`
   path otherwise. Error message rewritten to "Unable to read inventory data.
   The inventory page layout might have changed." (no longer instructs the user
   to undo their layout choice).

2. Ported `getGroupedFlights(groupedTableBodies)` from upstream v0.7.8. Each
   `<tbody>` represents one flight (one date for one numbered flight): the
   first row carries the flight number, date, and status alongside the first
   compartment's data; subsequent rows carry only per-compartment data starting
   at cell[0]. Adapted to current's parsers (`getCompCode`,
   `parseInventoryPrice`) for cmp-aware Cargo decimals; added null-safe filters
   so partial rows mid-AS-render don't throw.

3. Added the rerender machinery from upstream:
   - `getInventorySignature()` — `[groupedBodies count]:[classicRows count]`
     so the observer can tell whether a mutation is a real layout change.
   - `cleanupInventoryDisplay()` — removes the AES-injected DOM
     (`#aes-h3-analysis`, `#aes-div-analysis`, `#aes-h3-history`,
     `#aes-div-invPricing-historicalData`, `#aes-h3-validation`,
     `#aes-panel-validation`).
   - `watchInventoryLayout()` — installs one `MutationObserver` on
     `.container-fluid .row .col-md-10`, debounced 150ms, that calls
     `rerenderInventoryModule(false)` on every change.
   - `rerenderInventoryModule(force)` — signature gate, cleanup, re-fetch
     settings, re-validate, re-render `displayInventory()`. Force-mode bypasses
     the signature gate for the initial mount.
4. Added IDs to existing `<h3>` elements that were previously
   ID-less (analysis, history, validation) so the cleanup selector works.

5. Updated the `AesBoot.register({ ... })` anchor from the bare string
   `"#inventory-table"` to a function returning either
   `#inventory-table` or `#inventory-grouped-table`, so the boot also fires
   when the user has already chosen the grouped layout.

6. `initInventory(ctx)` now resets the signature, starts the observer once,
   and force-renders the initial frame; subsequent renders flow through the
   observer. The observer is idempotent (`if (inventoryObserver) return`).

**Inviolable rules check:**
- §1 no new POSTs: pure DOM scraping; no new request paths added.
- §2 storage contracts: no storage key change.
- §5 bus integration: no new bus topics; the rerender uses the existing
  in-process state.
- §7 no silent default flips: not applicable; behavior is additive.

**Self-stabilization sanity:**

The MutationObserver fires on AES's own DOM injection (the analysis/history
divs land inside the observed area). The 150ms debounce coalesces the
injection burst, and the signature gate (`getInventorySignature`) returns
identical values before and after AES injects, so the rerender is a no-op.
Confirmed by tracing: AES inject → observer → 150ms wait → rerender → signature
match → return before re-rendering.

**Verification:**

- Static: `node --check content_inventory.js` clean.
- Behavioral (run in browser): open `/app/com/inventory/<route>`; toggle
  `Group by flight` ON via the native AS control; AES analysis + history
  panels regroup without page refresh; toggle OFF; classic layout returns;
  filter rows down to 0 then back; no DevTools errors.

**Files changed:**

- `content_inventory.js` — grouped-mode parser + observer + signature
  rerender + AesBoot anchor function + H3 IDs

**Territory:** Agent 7 (content scripts).

---

## Slice 3 — Inventory pricing reference recommendations, opt-in (v0.7.8)

**Disposition:** [FIXED] (rendering side; toggle was committed separately as
`2dcb2cd` by parallel work)

**Origin:** Upstream CHANGELOG 0.7.8: *"Added an opt-in Inventory Pricing
setting for reference recommendations when the current route price has no
finished or inflight results yet."* and *"Updated Inventory Pricing analysis
to separate executable recommendations from reference recommendations…"*.

**Context:**

The opt-in setting `invPricing.showReferenceRecommendation` (default `0`),
the AS Settings UI checkbox, and the click handler that uses slice 1's
`mutateArea` RMW pattern were committed as `2dcb2cd` by parallel work.
That commit explicitly punted the analyzer + rendering side as a follow-up,
which is what this slice does.

**Diagnosis (current fork):**

Current's `getAnalysis` populates `analysis.data[cmp].demandFallback = 1`
when the per-class flightArray comes from settled or observed flights rather
than current-price-matched flights — i.e., the current price had no flight
results yet. Upstream calls this exact case the "reference recommendation"
case: in this state the executable recommendation is conservative (or
absent), and the user benefits from a simpler step-table read against the
analysis price as a baseline.

Current's analysis object had no `displayReferenceRec()`, no
`referenceRecommendation`/`referenceNewPrice` fields, and no `Reference`
column in the rendered table. The setting toggle had no rendering effect.

**Fix:**

1. `createEmptyClassAnalysis` now initializes `referenceRecommendation: 0`,
   `referenceRecType: "neutral"`, `referenceNewPrice: 0`,
   `referenceNewPricePoint: 0`, parallel to upstream.

2. New `generateReferenceRecommendation(analysis, prices)` — ported from
   upstream v0.7.8. Iterates compartments, gates on
   `valid && demandFallback`, applies `getInventoryLoadStep` against the
   active recommendation config and computes a hypothetical new price using
   `analysisPricePoint + step.step`, clamped to `[minPrice, maxPrice]`.
   Reuses current's `roundInventoryPrice(cmp, …)` so Cargo decimals are
   preserved.

3. `getAnalysis` calls `generateReferenceRecommendation` after
   `generateRecommendation`, so the reference fields are populated whenever
   the analysis runs (cheap; no I/O, just step-table arithmetic).

4. New `analysis.displayReferenceRec(cmp)` method — recType-tinted span with
   the reference recommendation text and a `→ price (point%)` suffix when a
   `referenceNewPrice` was computed. Returns `'-'` when no reference applies
   (covers the confidently-grounded case where `demandFallback === 0`).

5. `displayAnalysis` reads `settings.invPricing.showReferenceRecommendation`
   into a local `showReference`. When truthy: appends a `<th>Reference</th>`
   header, a per-cmp `<td>` cell rendering `displayReferenceRec`, and bumps
   the spacer/trailing-colspan math (`totalCols`/`trailingCols`) to keep the
   footer aligned. When falsy: layout is unchanged (8-column default
   preserved). Default OFF satisfies inviolable rule §7.

**Inviolable rules check:**
- §1 no new POSTs: pure analysis + DOM rendering; no new request paths.
- §2 storage contracts: no key change; uses existing
  `settings.invPricing.recommendation` step config.
- §6 strategy pure-function cores: not applicable; this is content-script
  rendering, not a strategy-module core.
- §7 no silent default flips: setting defaults `0` (off); `2dcb2cd` already
  recorded the default in both default-settings paths.

**Note on semantics divergence from upstream:**

Upstream gates the reference recommendation on `!useCurrentPrice`. Current's
`useCurrentPrice` flag has slightly different semantics (it can be 1 even
when the data came from a fallback path), so this port gates on
`demandFallback === 1` instead — semantically equivalent to "the
recommendation is grounded in observation rather than current-price flight
rows", which is the case CHANGELOG 0.7.8 calls out.

**Verification:**

- Static: `node --check content_inventory.js` clean.
- Behavioral: open `/app/com/inventory/<route>` for a route with no recent
  finished/inflight flights at the current price; toggle
  `Show reference recommendation when current price has no flight results
  yet` ON in the Settings page; reload Inventory; the analysis table now has
  a `Reference` column showing the step-table read against the analysis
  price for any compartment in `demandFallback` state. Toggle OFF; column
  disappears and the existing 8-column layout returns.

**Files changed:**

- `content_inventory.js` — `createEmptyClassAnalysis` reference fields,
  `generateReferenceRecommendation`, analysis `displayReferenceRec` method,
  `displayAnalysis` conditional column + footer colspan
- (toggle UI + defaults: already committed as `2dcb2cd`)

**Territory:** Agent 7 (content scripts).

---

## Slice 5 — Fleet Management richer extraction + table polish (v0.7.6 / v0.7.7)

**Disposition:** [FIXED] (items 13, 16, 17, 19, 22) / [DEFERRED] (item 12)

**Origin:** Upstream CHANGELOG 0.7.6 + 0.7.7 — richer per-tail extraction,
schedule-state labels, HUB column, undelivered-tail persistence, and table
presentation polish in `content_fleetManagement.js`. See
`audit/integration-delta-matrix.md` rows 12, 13, 16, 17, 19, 22 for the diff.

**Items shipped this commit:**

- **Item 13** — Augmented `fltmng_getData` extraction with new fields
  (`delivered`, `owned`, `pilotAssigned`, `pilotAssignedLabel`, `seatConfig`,
  `totalSeats`, `pureCargo`, `scheduleState`, `scheduleStateLabel`,
  `seatY/C/F` aliases, `maintenance` alias). Fork's existing fields
  (`typeId`, `note`, `nickname`, `location`, `seatsY/C/F`, `maintanance`)
  preserved verbatim — both shapes coexist. New helpers added:
  `fltmng_isDelivered`, `fltmng_isOwned`, `fltmng_hasPilots`,
  `fltmng_getSeatConfig`, `fltmng_getTotalSeats`, `fltmng_isPureCargo`,
  `fltmng_getScheduleState`.
- **Item 16** — `<th>Aircraft model</th>` renamed to `<th>Model</th>`;
  `<th>HUB</th>` inserted after the model column; profit/extract-date headers
  centered.
- **Item 17** — `fltmng_getScheduleStateLabel` returns
  `Active|Locked|Conflict|Empty|Undelivered`; consumers map label -> CSS class
  via existing fork conventions (`good`/`warning`/`bad`/neutral) — same
  vocabulary upstream's `content_dashboard.js:241` already uses for the
  Aircraft Profitability tile.
- **Item 19** — Replaced strict `aircraftId == newValue.aircraftId`
  matching in `fltmng_updateAircraftFleetStorageData` with
  `fltmng_isSameAircraft(stored, aircraft)` (matches by id OR registration).
  Added `fltmng_getStoredAircraft(data, aircraft)` for the find-and-merge
  step. Relaxed `fltmng_isValidAircraftRecord` so undelivered tails (null
  aircraftId) survive in storage when keyed by registration. Relaxed the
  `if(!fltmng_isValidAircraftId(aircraftId)) return;` early discard in
  `fltmng_getData` so null-id rows enter `aircraftData`. Skipped
  `serveraircraftFlightsnull` lookups in `fltmng_getStorageData`.
- **Item 22** — `<td></td>` placeholders in the profit/extract-date columns
  replaced with `<td class="text-center">--</td>`.

**Item 12 disposition: [DEFERRED]**

`fltmng_buildFilterPanel` (Model/HUB/Seats/Delivery/Ownership/Schedule
selects) and `fltmng_bindNativeSelectionLinks` from upstream
content_fleetManagement.js (lines 567-650 + 663-725) require:

1. A `row` reference attached to every `aircraftData` entry so the filter's
   `.toggle(visible)` call has an element to hide.
2. A MutationObserver scaffold (`fltmng_watchFleetTable`,
   `fltmng_syncTableRows`, `fltmng_isFleetTableNode`,
   `fltmng_refreshFleetTableEnhancements`) so the filter survives
   AS-side table re-renders (the per-fleet sub-pagination triggers a partial
   table swap that the fork's renderer doesn't currently watch).
3. A `fltmng_refreshNativeSelectionState` helper that re-fires `change`
   events on AS's checkboxes.

That stack is ~150 lines and changes the boot/render lifecycle. Deferring
to a follow-up slice keeps this commit focused on items 13/16/17/19/22 and
avoids a double touch of the renderer when the filter UI lands. A TODO marker
in `fltmng_display` flags the intended port.

**Storage envelope check:**

- `<server><airline>aircraftFleet` blob — additive only. New fields written:
  `delivered`, `owned`, `pilotAssigned`, `pilotAssignedLabel`, `pureCargo`,
  `scheduleState`, `scheduleStateLabel`, `seatY/C/F`, `seatConfig`,
  `totalSeats`, `maintenance`. Existing fields (`age`, `aircraftId`, `date`,
  `equipment`, `typeId`, `fleet`, `location`, `maintanance`, `nickname`,
  `note`, `registration`, `seatsY/C/F`, `time`) preserved.
- `<server>aircraftFlights<id>` blob — unchanged shape; only the read path
  was hardened to skip null-id keys.

**Inviolable rules check:**

- §1 no new POSTs: pure DOM extraction + chrome.storage writes. No new AS
  request paths.
- §2 storage contracts: additive fields only on
  `<server><airline>aircraftFleet`; key shape and prefix unchanged.
- §3 AFP form-driver: untouched.
- §7 no silent default flips: not applicable; this is a presentation +
  storage-shape additive change with no gate flips.

**Verification:**

- Static: `node --check content_fleetManagement.js` clean.
- Behavioral (run in browser, no live writes needed): open
  `/app/fleets/`; the AES Fleet Management panel should show the centered
  HUB column, `--` placeholders on rows with no profit history, and the
  "Aircraft model" column renamed to "Model". Per-tail `scheduleState` and
  derived metadata available via `chrome.storage.local.get` against the
  `<server><airline>aircraftFleet` key.
- Cross-territory: dashboard (`content_dashboard.js`) consumes
  `scheduleStateLabel` for the Aircraft Profitability tile per upstream
  v0.7.6; the field is now populated. (Dashboard wiring of the label is
  scope of items 6/17 follow-up — not this slice.)

**Files changed:**

- `content_fleetManagement.js` — extraction + storage envelope + table polish
  + new helpers + item 12 deferral comment.

**Territory:** Agent 7 (content scripts).
