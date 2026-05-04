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
| 2 | Grouped inventory tables (Group by flight) | [FIXED] | content_inventory.js | (this commit) |
| 3 | Inventory pricing reference recommendations (opt-in) | (pending) |  |  |
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
