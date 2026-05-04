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
| 1 | Settings save/load race fix | [FIXED] | settings-bridge.js, content_inventory.js, content_settings.js | (pending) |
| 2 | Grouped inventory tables (Group by flight) | (pending) |  |  |
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
