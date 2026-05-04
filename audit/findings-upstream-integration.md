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
| 3 | Inventory pricing reference recommendations (opt-in) | [FIXED] | content_inventory.js (toggle: 2dcb2cd) | (this commit) |
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
