# Manifest requests
# Agent 1 reads. Other agents append.

---

## 2026-05-03 — Agent 6 — register Site-skin coverage extension (3 new CSS + Coverage tab)

**Why:** Substrate Item 3 ships per-page-family skin coverage for three
previously-unstyled AS sections (alliance, marketing, staff/staffPilots)
plus a read-only Coverage diagnostic tab inside Unified Settings.

New CSS files (token-only, no literal hex; verified):

  - `css/skin/skin-alliance.css`  (≥110 lines)
  - `css/skin/skin-marketing.css` (≥115 lines)
  - `css/skin/skin-staff.css`     (≥117 lines)

New JS singletons:

  - `modules/_shared/skin-coverage.js`        — `window.AESSkinCoverage`. Static
    truth table; consumed by the Coverage tab.
  - `modules/unified-settings/tab-coverage.js` — `window.AesUnifiedSettingsTabs.coverage`.
    Tab renderer; reuses `AESFreshnessPill` (Item 1) for depth chips.

Bootstrap.js changes (already landed):
  - `pageKindFromPath` now classifies `/app/alliance/*` → "alliance",
    `/app/enterprise/marketing*` → "marketing",
    `/action/enterprise/staffPilots*` → "staff" (alongside the existing
    staffOverview branch).

**Ask:**

  1. In `manifest.json`, in the `content_scripts[0].css` array near the
     existing `css/skin/skin-ops.css` entry (manifest line ~49 in v0.6.11),
     add the three new CSS files in any order — each is scoped by
     `body.aes-skin[data-aes-page="<kind>"]` so adding to the global skin
     bundle is a no-op on pages that don't match.

  2. In every manifest entry that already loads
     `modules/unified-settings/shell.js` and any `modules/unified-settings/tab-*.js`,
     register the two new JS files. Suggested order:
     `_shared/skin-coverage.js` (before `tab-coverage.js`), then
     `tab-coverage.js` (next to the other tab modules).

  3. (Optional follow-up for Agent 7) The alliance and marketing page
     families currently have no dedicated `content_*.js` mounting an AES
     panel — they get the visual skin only. If/when richer modules want
     to mount on those pages, Agent 7 can add `content_alliance.js` /
     `content_marketing.js` content-script entries. Out of scope for
     this Item 3.

**Blocked work:** Coverage tab fails to render (silently — falls through to
"Tab unavailable.") until both new JS files load. New skin CSS files are
inert without manifest registration.

---

## 2026-05-03 — Agent 6 — register Command Palette v2 (fuzzy, chord buffer, legend seed)

**Why:** Substrate Item 2 ships three new IIFE singletons that upgrade
the command palette discoverability:

- `modules/command-palette/fuzzy.js` — `window.AESPaletteFuzzy`. Subsequence
  scorer; `registry.js` already consults it via runtime feature detection
  (falls back to legacy substring scoring when absent, so this is non-blocking
  but materially improves discovery).
- `modules/command-palette/chord-buffer.js` — `window.AESPaletteChords`.
  Self-installs a capture-phase keydown listener for `g g`, `g s`, `g c`
  chord sequences. No new write paths — chord runs only call existing
  `toggle()` / `open()` APIs on the customization, settings, and menu surfaces.
- `modules/command-palette/derivers/legend-seed.js` — populates 4 legend
  sections at boot and registers the `g _` chord set with the chord buffer.
  Idempotent.

**Ask:** in every manifest entry that already loads
`modules/command-palette/registry.js` and `modules/command-palette/api.js`
(typically: dashboard, scheduling, fleets, AFP, info pages — anywhere the
palette is currently active), add the three new files in this load order
**after** `host.js` and **before** the existing
`modules/command-palette/derivers/*` entries:

  fuzzy.js → chord-buffer.js → derivers/legend-seed.js

The existing `derivers/tiles.js`, `derivers/sections.js`, etc. should
continue to load after legend-seed.js; their hotkey legend contributions
will append to the seeded sections cleanly.

**Blocked work:** none — all three modules degrade gracefully when missing
(fuzzy: registry falls back to substring; chord buffer: only impacts chord
sequences which today don't exist; legend seed: legend modal stays sparse
but keyword `?` still finds it). User-visible payoff lands once registered.

**Tests:** Node-runnable smokes at `audit/tests/command-palette/fuzzy.test.js`
and `audit/tests/command-palette/chords.test.js`. Both pass under
`node audit/tests/command-palette/{fuzzy,chords}.test.js` (no DOM, no
chrome dependency). Add to any future smoke runner.

---

## 2026-05-03 — Agent 6 — register substrate Item 1 (FreshnessPill, Backup section, density-toggle button)

**Why:** Substrate polish pass ships three new IIFE singletons that other
substrate modules now reference:

- `modules/_shared/freshness-pill.js` — `window.AESFreshnessPill`. Consumed
  by `modules/central-hub/tile.js` (already updated; defensive fallback in
  place) and by Item 3's coverage tab.
- `modules/customization/sections/backup.js` — `window.AESStudioBackupSection`.
  Consumed by `modules/customization/panel-shell.js` renderers map (already
  updated; the §10 Backup nav item is now `active:true`).
- `modules/site-skin/density-toggle-button.js` — `window.AESDensityToggleButton`.
  Self-mounting nav button; pairs with the existing `density-toggle.js`
  keybind so users get a visible affordance.

**Ask:**

  1. In every manifest entry that already loads `modules/_shared/utils.js`
     (or any other shared singleton), add `modules/_shared/freshness-pill.js`
     after `modules/_shared/utils.js`. Load order: must precede
     `modules/central-hub/tile.js` so the tile picks up the new global.

  2. In every manifest entry that loads
     `modules/customization/panel-shell.js`, add
     `modules/customization/sections/backup.js` adjacent to the existing
     `modules/customization/sections/theme.js` etc. Load order: any of the
     section files; must load before `panel-shell.js` reads `window.AESStudioBackupSection`.

  3. In every entry that already loads `modules/site-skin/density-toggle.js`,
     add `modules/site-skin/density-toggle-button.js` immediately after.
     The button mounts opportunistically on DOMContentLoaded; safe to add to
     all skin-enabled entries.

All three modules are pure IIFE singletons with `if (window.X) return` guards
— adding to additional entries is a no-op.

**Blocked work:** central-hub tiles already fall back to the inline dot when
`AESFreshnessPill` is missing, so the central-hub mount is non-blocking.
However the Backup section in Customization Studio renders a "Section
unavailable." canvas until manifest registration lands. Density toggle
button is invisible (Shift+D still works).

---

## 2026-05-03 — Agent 4 — register schedule-color-overrides + color-picker-popover for FSG

**Why:** New "Day Overlay" row mode and switchable per-bar color customization
(Route / Aircraft / Day) for the Fleet Schedule Grid + Schedule Canvas
Timeline + Wave Spine. Two new modules need to load on the same matches as
the existing Fleet Schedule Grid bundle:

- `modules/_shared/schedule-color-overrides.js` — chrome.storage.local-backed
  override store (key `aesScheduleColors:overrides`). Surfaced as
  `window.AesScheduleColorOverrides`.
- `modules/fleet-schedule-grid/color-picker-popover.js` — context-menu
  color picker (`window.FleetScheduleGridColorPicker`).

**Ask:** in the manifest entry that already loads the Fleet Schedule Grid +
Canvas bundle (matches `/app/fleets*`, the entry containing
`modules/fleet-schedule-grid/route-coloring.js` at line 1123), insert two
new lines:

  - **Before** `modules/fleet-schedule-grid/route-coloring.js` (line 1123):
    `modules/_shared/schedule-color-overrides.js`
    Reason: route-coloring.js's `assign()` now consults the override store at
    paint time; the store object must exist when the renderer first paints.

  - **After** `modules/fleet-schedule-grid/flight-inspector.js` (line 1133)
    and **before** `modules/fleet-schedule-grid/aircraft-cockpit.js`
    (line 1134): `modules/fleet-schedule-grid/color-picker-popover.js`
    Reason: defines `window.FleetScheduleGridColorPicker`, used by the
    grid renderer's flight-bar context menu.

Both modules are IIFE singletons and idempotent — adding to additional
entries (e.g., the Schedule Canvas-only mount paths if any) is safe.

**Blocked work:** the Day Overlay mode + Color By selectors are already
landed on the renderer/panel/canvas-shell. Without the manifest registration
they'll throw `AesScheduleColorOverrides is not defined` on first paint
under MV3 isolation. Targeted nature of the change keeps blast radius to
the Fleet Schedule Grid surface.

---

## 2026-05-01 — Agent 7 — add settings-bridge.js to legacy content_*.js entries

**Why:** F-8-005 (cross from Agent 8) requires migrating 24 direct
`chrome.storage.local.set({settings})` writers in legacy content_*.js to
`window.AesSettings.saveArea()`. Today only 2 manifest entries inject
`modules/_shared/settings-bridge.js`; the entries that load
`content_dashboard.js`, `content_settings.js`, `content_inventory.js`,
`content_personelManagement.js`, and `content_fligthSchedule.js` do not.
Without bridge in scope, `window.AesSettings` is undefined and migration
is a no-op (or breaks).

**Ask:** prepend `modules/_shared/settings-bridge.js` to the `js` array of
the manifest entries that load each of these five content scripts (entries
2, 3, 4, 5, 13 in `manifest.json` per current ordering). The bridge is
idempotent — adding it to additional entries is safe.

**Blocked work:** F-8-005 settings-writer migration (24 sites in territory)
sits behind this. I'll land the migrations as soon as the bridge ships.

Note: `modules/_background/legacy-defaults.js:88` is intentionally a
whole-blob bootstrap write (first-install only); excluded from migration.

---

## 2026-05-03 — Agent 4 — add css/fleet-compact.css to content_scripts CSS

**Why:** Fleet Command Center (`modules/fleet-hub/command-center.js`) gained
a "Compact / Flight Board" view-mode toggle. The new `data-view-mode="compact"`
attribute on the FCC root is meaningless without `css/fleet-compact.css`,
which scopes all the board styling (mono font, status pills, expand panel,
split-flap flip keyframe) under that selector. Standard mode is unaffected
either way — no compact-only selector matches when the attribute is absent.

**Ask:** add a single line to `manifest.json` `content_scripts[0].css` after
`css/skin/skin-fleet.css` (currently line 46):

```
"css/skin/skin-fleet.css",
"css/fleet-compact.css",
"css/skin/skin-schedule.css",
```

The file consumes only design tokens already declared in
`css/design-tokens.css` (`--aes-rust`, `--aes-amber`, `--aes-moss`,
`--aes-crimson`, `--aes-font-mono`, `--aes-tile-bleed`, etc.) — no new
tokens, no font load, no asset reference.

**Blocked work:** the Compact view renders structurally without the CSS
(the JS still sets `data-view-mode="compact"` and the grid DOM is intact),
but the visual chrome — mono font, status pills, expand panel — only
materialises when this stylesheet loads.

---

## Request — agent 2 — competitor-intel store on the scheduling page (2026-05-03)

**Goal:** the Cmp popover's per-competitor stats line (added this session)
reads from `competitorIntel:enterprise:<server>:<id>` /
`competitorIntel:alliance:<server>:<id>` keys via raw
`chrome.storage.local.get(null)` because `AesCompetitorStore` isn't in this
content_script's `js` list. Functional but not ideal — the typed
`bulkLoadEnterprises` / `loadAlliance` APIs would be cleaner.

**Ask:** add to the `/app/com/scheduling*` content_script (around manifest
line 625, near where carriers/enterprise-meta scrapers already live):

```
"modules/competitor-intel/competitor-store.js",
```

Read-only consumer here — no scrape registration, no new permissions, no
new bus topic. Once added, panel.js's `_applyCachedCompetitorIntel()` can
swap the `chrome.storage.local.get(null)` scan for two typed bulk reads
keyed by the enterprise IDs already on rows.

**Blocked work:** none — current implementation works without this
addition. This is a cleanup follow-up only.

---

## 2026-05-04 — Agent 3 — K13 + K15 conductor learning substrate

**Goal:** new conductor modules `baseline-store.js`, `baseline-driver.js`,
`forecaster.js`, `forecast-store.js` need to load on the same content_script
entry that already pulls the rest of `modules/conductor/*` (currently the
entry near manifest lines 296–316).

**Status:** `baseline-store.js`, `baseline-driver.js`, and `forecaster.js`
are already present in the manifest at lines 298–300 (thank you).
`forecast-store.js` is the only one still missing.

**Ask:** add **after** `modules/conductor/forecaster.js` (line 300):

```
"modules/conductor/forecast-store.js",
```

It depends on `forecaster.js`, `signal-store.js`, and `scenarios.js` (all
already on this page-set), and on `CentralHubBus`. No new permissions, no
host-script changes, no new bus listener registration in the manifest.

**Blocked work:** the K15 forecast chip on the Conductor tile and the
CashCrunchForecast scenario both no-op gracefully when `forecast-store.js`
isn't loaded, but never produce data without it.

---

## 2026-05-04 — Cross-Territory Integration session — register CSS for release-notes dialog

**Why:** Item 1 of the upstream-v0.7.8 → fork integration session ships
`css/release-notes.css` (token-only, ~210 lines) so the modal `modules/release-notes.js`
(already loaded — root-level entry at `content_scripts[0].js` line 180)
gets its hero/card/footer styling. Without the CSS, the dialog renders with
only Bootstrap-modal-default styles; the `.aes-release-notes-*` classes
referenced in DOM construction have no rules until this lands.

**Ask:** add `css/release-notes.css` to `manifest.json` `content_scripts[0].css`
adjacent to the other shared CSS entries (e.g., next to
`css/skin/skin-fleet.css`). The file consumes only design tokens already
declared in `css/design-tokens.css` (`--aes-bone`, `--aes-oxide`, `--aes-rust`,
`--aes-rust-fg`, `--aes-rust-deep`, `--aes-bone-2`, `--aes-bone-fg`,
`--aes-oxide-bg`, `--aes-oxide-bg-2`, `--aes-oxide-rule`, `--aes-paper-rule`,
`--aes-slate`, `--aes-radius`, `--aes-font-display`, `--aes-font-mono`,
`--aes-fs-micro`, `--aes-fs-small`, `--aes-fs-body`, `--aes-fs-h3`,
`--aes-fs-h2`, `--aes-fw-display`, `--aes-fw-bold`, `--aes-tracking-caps`,
`--aes-tracking-mono`, `--aes-lh-tight`, `--aes-lh-body`, `--aes-sp-1` ..
`--aes-sp-5`).

**Blocked work:** the dialog itself works structurally — release-notes module
auto-bootstraps `addReleaseNotesFooterLink()` and `maybeShowReleaseNotes()` on
load — but visually appears as a plain Bootstrap modal until this CSS is
registered.

**Cleanup follow-up:** there is an orphan duplicate at
`modules/release-notes/release-notes.js` (18 KB, never loaded — no manifest
entry references the subdirectory path). It used inline design-token styles.
Recommend Agent 8 delete during end-of-session consolidation; safe — git
log only references the canonical root-level path.

---

## 2026-05-04 — Cross-Territory Integration session — register notifications API

**Why:** Item 2 of the upstream-v0.7.8 → fork integration session ships a
new in-page Notification class API at `modules/_shared/notifications-api.js`.
Exposes `window.AesNotification` and `window.AesNotifications` — success /
warning / error toasts in AS's native `.feedbackPanel`. Used by Options
import/export flow (Item 6) and intended as a general substrate surface.

The module is a pure IIFE singleton with `if (window.AesNotifications) return`
guards — adding it to additional entries is a no-op.

**Ask:** add `modules/_shared/notifications-api.js` to `manifest.json`
`content_scripts[0].js` immediately after `helpers.js` and before any
consumer (so module-level code that calls `new AesNotifications()` always
finds the class defined). Suggested line: between `helpers.js` and the
existing `modules/_shared/utils.js` reference.

**Blocked work:** Options page Item 6 (import/export) calls
`new AesNotifications().add(...)` for success/error feedback. Without this
registration, the calls degrade to console.log only (the module guards
`typeof AesNotifications === "function"` before instantiating).

---

## 2026-05-04 — Cross-Territory Integration session — register ORS page injector

**Why:** Item 3 ships `modules/online-reservation-system/page-injector.js`,
a read-only injection of numeric ORS scores into `/app/info/ors*`. Reuses
the existing `RouteAssistantOrsScraper.loadRecord` API and the existing
`data:route-assistant:ors:updated` bus topic — no new storage keys, no new
bus topics, no new POSTs to AS.

**Ask:** add a NEW content_scripts entry to `manifest.json`:

```json
{
  "matches": ["https://*.airlinesim.aero/app/info/ors*"],
  "js": [
    "js/jquery-3.4.1.min.js",
    "helpers.js",
    "modules/_shared/account-scoped-key.js",
    "modules/_shared/account-registry.js",
    "modules/_shared/data-bus.js",
    "modules/_shared/data-bus-topics.js",
    "modules/_shared/settings-bridge.js",
    "modules/_shared/notifications-api.js",
    "modules/route-assistant/settings-store.js",
    "modules/route-assistant/ors-scraper.js",
    "modules/online-reservation-system/page-injector.js"
  ]
}
```

The injector only runs in the top frame and only on the ORS results page.
Notes:
- jQuery + helpers + the substrate trio (`account-scoped-key`,
  `account-registry`, `data-bus`, `data-bus-topics`, `settings-bridge`)
  are needed because `RouteAssistantOrsScraper.loadRecord` reads through
  `acctKey()` + the namespaced storage shape.
- `route-assistant/settings-store.js` is needed because `ors-scraper.js`
  reads default `maxAgeDays` from the RA settings block.
- `notifications-api.js` is optional — used to surface a one-line "AES: ORS
  scores rendered" toast on first injection per page session.

**Blocked work:** the ORS page renders without numeric scores until this
entry lands. No silent breakage; the module simply isn't loaded.

---

## 2026-05-04 — AGENT-INTEGRATION — close-out: cross-agent asks for v0.7.8 deferred buckets

These three asks document upstream v0.7.8 changelog items the integration
session deferred. Each was investigated and rejected for the integration
role; the right home is the territory-owning agent. Filing here so Agent 1
sees them on the next consolidation cycle and can route to Agent 4/5/7.

### Bucket 1 — Fleet Management filter panel + native selection (Agent 7, possibly with Agent 4)

Upstream: `AirlineSim-Enhancement-Suite-main/extension/content_fleetManagement.js`
lines 586–725 (`fltmng_buildFilterSelect`, `fltmng_bindNativeSelectionLinks`,
`fltmng_refreshNativeSelectionState`). Changelog v0.7.7: "Fixed Fleet
Management filtering and native selection link integration so all/none/invert
works with AES filters, action availability stays in sync with checkbox
state, and native table refreshes no longer break AES-added columns."

**Why deferred from integration role:** Fork's `content_fleetManagement.js`
(313 LOC, extraction-only) has no filter UI at all. Adding ~250–300 LOC of
filter UI + selection-sync handlers conflicts with the central-hub Fleet
Hub tile (Agent 4 territory) which already does filtering at the tile
level. A page-level filter panel and a tile-level filter panel would
duplicate UX.

**Decision needed (user):** Should fleet filtering live page-level (port
upstream as-is) or stay tile-level (close as `[NOT-PORTABLE]`)? If
page-level, Agent 4 needs to subscribe Fleet Hub to a
`data:fleet-management:filter-changed` topic so the tile mirrors
page-level filter state.

**Risk:** Medium. No new POST paths.

### Bucket 2 — Aircraft Profitability summary `<tfoot>` row (Agent 7)

Upstream: `content_dashboard.js` `buildDashboardTableFooter()` (~lines
409–468) + per-column `aggregate: 'average'` directives. Changelog v0.7.5:
"Fixed Aircraft Profitability age aggregation so age is averaged in the
summary row instead of summed."

**Why deferred from integration role:** Fork's `generateTable()` is
monolithic and builds no `<tfoot>`. Two implementation options:

1. Inline a per-table summary builder for AP only (~80–150 LOC localized
   to AP rendering at `content_dashboard.js` lines ~2750–2885).
2. Refactor `generateTable()` to accept a footer-aggregator config
   (~200 LOC, unifies pattern across Route Management + Competitor
   Monitoring + AP).

**Decision needed (user):** Inline (point fix only) vs. refactor (general
pattern)? If neither has been explicitly requested by users, close as
`[NOT-PORTABLE-WORTH-IT]` — the fork's central-hub tiles already
aggregate via `modules/accounting/aggregator.js` which may serve the same
UX outcome elsewhere.

**Risk:** Medium (point fix) / Large (unification). No new POST paths.

### Bucket 3 — Dashboard render-path items (Agent 5 + Agent 4 — informational, do NOT port)

Upstream v0.7.5–v0.7.7 changelog dashboard refinements: unified table
rendering, column-chooser stay-open, per-airline competitor isolation,
dashboard-tab-init / sorting / zero-value fixes (changelog items 13, 14,
15, 16, 23, 32, 34, 36–38).

**Why deferred from integration role:** Architectural mismatch — fork's
central-hub + L2 scoping already achieves the same outcomes through a
different design:

- Per-airline competitor isolation: already structural in fork's tile design.
- Filter UX persistence: handled by `AesSettings.saveAreaScoped(area, data, {airline, server})`.
- Unified table rendering: replaced by `modules/central-hub/tile.js` shell + tile-feed contract.

**Recommendation:** Do NOT port these items. Instead, file targeted
verification asks on Agent 5 (dashboard tiles) + Agent 4 (Fleet Hub tile)
to confirm their tile implementations preserve the upstream UX outcomes
(per-airline isolation works, filter state persists, sort/zero-value
rendering is correct). Any gaps found get filed as new findings against
the tile implementation, not as upstream ports.

**Risk:** None (no port). Informational only.

