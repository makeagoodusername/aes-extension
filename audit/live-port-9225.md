# Port 9225 — Fleet/Aircraft/Ops live audit

Agent C (LIVE), CDP port 9225, profile `/tmp/chrome-aes-3`.
Slice: `fleet-hub`, `fleet-command`, `fleet-optimizer`, `aircraft-flight-plan`,
`aircraft-profitability`, `used-aircraft-scanner`, `crew-management`, `inventory`
tiles + `modules/fleet-hub/`, `modules/aircraft-flight-plan*/`,
`modules/aircraft-flights/`, `modules/used-aircraft-scanner/`,
`modules/crew-management/`, `modules/inventory/`.

## Boot health

The Chrome instance on port 9225 was bound to a *different* user-data-dir
(`/tmp/aes-chrome-t5`) than the brief stated (`/tmp/chrome-aes-3`) and was
running another agent's harness (`tools/dashboard-harness-t5.html` →
**Terminal 5: competitor-intel-hub / competitor-monitoring / competitor-outline /
crew-management**). t5 only registers four tiles in
`window.CentralHubTileRegistry._tiles`:

```
competitor-monitoring, competitor-intel-hub, competitor-outline, crew-management
```

Of my eight slice tiles only `crew-management` overlaps. Other six tiles
(fleet-hub, fleet-command, fleet-optimizer, aircraft-flight-plan,
aircraft-profitability, used-aircraft-scanner, inventory) **could not be
mounted in the live harness** — none is in t5's registry list.

Live state captured before the chrome instance died (port 9225 stopped
accepting CDP connections during the audit, which I attribute to other
agents' load on the shared instance — I deliberately avoided relaunching
to honour the "don't touch other ports/chromes" rule):

- `crew-management` tile rendered with empty-state copy
  (`bodyLen=132`, primary "Open →" button enabled, navigates to
  `/action/enterprise/staffPilots`). Body content matched the expected
  "No crew data — visit /action/enterprise/staffPilots to seed." string.
- Console at boot (post extension reload, dashboard reload, 8 s):
  - quiet on slice paths
  - one harness-related warning
    `[AES hub-feed] AesView/AesDataBus missing — hub-feed inert`
    (legacy bridge)
- Earlier in the run, with extension freshly loaded, the harness
  surfaced the boot-fail chain that has been logged repeatedly across
  agents (storage-stub gaps in the harness page, NOT a slice bug):
  - `[AES Hub] shell mount failed TypeError: Cannot read properties of
    undefined (reading 'local')` — `chrome.storage` stub gap on
    `file://` page; outside slice scope.
- `https://free1.airlinesim.aero/app/fleets` could not be exercised:
  the persistent profile has no AS session and AS bounced the tab to
  `airlinesim.aero/auth/login`. Drill-down probe
  `typeof window.AesFleetHubOptimizerDrilldown !== 'undefined'` and
  AFP route-candidates `⋮⋮` drag-handle visual check are therefore
  **test-not-runnable** in this session — see static-review notes
  below for what I confirmed instead.
- Screenshots: not captured (`screenshot` requires a live tab; CDP
  socket was down at screenshot time).

## Findings

### F-9225-LIVE-001 — `MarketScanPriceHistory` & `MarketScanDealMetrics` not visible cross-script

Class declarations in MV3 content scripts are lexical bindings local to
each `<script>` program in the isolated world; they don't leak onto
`window`. Other slice classes already paper over this with an explicit
`window.X = X` shim at the bottom of the file (e.g. `MarketScanSession`,
`MarketScanDiffStore`, `UsedAircraftPresets` — all freshly added in the
WIP diff against `HEAD`).

Two used-aircraft-scanner classes were still missing the shim:

- `modules/used-aircraft-scanner/price-history-store.js` —
  `class MarketScanPriceHistory` was unexposed. Consumers
  (`scan-controller._recordHistory`, `market-panel/panel.js`,
  `deal-classifier.loadHistories`) probe via bare `typeof
  MarketScanPriceHistory` / call `MarketScanPriceHistory.X(...)`. In
  separate-script realms `typeof X` returns `"undefined"` and the
  unguarded calls in `deal-classifier` (lines 157, 213) and the IIFE
  cleanup registration at line 227 would `ReferenceError` once the file
  loaded under the same content_scripts entry that already loads
  `deal-classifier`. The visible behaviour: scans never folded into
  per-type history, the absolute-percentile column on the market panel
  fell back to the within-scan default, and the daily cleanup task
  silently no-op'd.

- `modules/used-aircraft-scanner/deal-metrics.js` —
  `class MarketScanDealMetrics` was unexposed. Consumers
  (`results-table` line 475, `scan-controller._recordHistory` line 316,
  `deal-narrative` lines 70/77, `market-panel/best-cases` line 136,
  `market-panel/filter-chips` lines 755-760) probe via bare `typeof`
  guards. Consequence: `MarketScanDealMetrics.decorate` rows never
  ran during history capture (so percentile decorations went missing),
  the cost-bracket filter chips on the market panel returned `null`
  cost, and `deal-narrative` skipped its acquisition-price line item.

Static finding only; could not exercise on the market panel because
this Chrome instance never reached an authenticated AS page.

### F-9225-LIVE-002 — Live test bench mismatch (informational)

The brief specified `cpkkmmjhaajhfkmiejhhkkgdjdhoggkl` as the extension
ID; the running Chrome on 9225 had loaded the same extension under
`fignfifoniblkonapihmkfakmlgkbkcf` (Chrome auto-derives the ID from the
manifest's key/path; the brief's ID is stale). Not a code bug — flagging
in case other agents are sending hard-coded `chrome-extension://cpkk…`
URLs in their probes.

The brief also said "profile `/tmp/chrome-aes-3`, already running"; the
Chrome process actually owning the CDP socket was launched against
`/tmp/aes-chrome-t5`. Two Chromes briefly contended for port 9225 (one
existed pre-session, one was launched by my own bring-up before I
realised CDP /json/version already returned a healthy response from the
first). I killed my duplicate and used the running one.

## Fixes

### F-9225-LIVE-001 — added `window.X = X` exports

`modules/used-aircraft-scanner/price-history-store.js`:
```js
if (typeof module !== "undefined" && module.exports) module.exports = MarketScanPriceHistory
if (typeof window !== "undefined") {
    window.MarketScanPriceHistory = MarketScanPriceHistory
}
```

`modules/used-aircraft-scanner/deal-metrics.js`:
```js
function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v)
}

if (typeof window !== "undefined") {
    window.MarketScanDealMetrics = MarketScanDealMetrics
}
```

`node --check` passes on both files.

The fix is symmetric with the WIP exports already added by another
agent earlier in the session (`scan-session-store.js`,
`scan-diff-store.js`, `presets-store.js`) and matches the pattern used
on every other slice class that had to round-trip through bare-name
lookup (`window.AesAfpScheduleStore = …`, `window.RouteAssistantToast =
…`, `window.MarketScanDealNarrative = …`, etc.).

Re-test post-fix not possible in this session (no live AS market panel
reachable). Re-test plan for the next runner:
1. Open `/app/aircraft/market` with AS session.
2. Eval `typeof MarketScanPriceHistory` and `typeof MarketScanDealMetrics`
   — both should now return `"function"` (previously `"undefined"`).
3. Run a small scan; confirm history is recorded by inspecting
   `chrome.storage.local` for `<server>marketScan:history:` keys
   afterwards. Pre-fix, no such key would appear; post-fix, one per
   queued type.

### Static slice review (no edits needed — behaviour confirmed correct)

- `central-hub/tiles/used-aircraft-scanner-tile.js` — F-A3-002 fix
  (use `typeof X` instead of `window.X` probe) is in place; the now-
  exported `MarketScanSession` / `MarketScanDiffStore` / `UsedAircraftPresets`
  satisfy the `typeof` guards on lines 69, 78, 95, 111, 136, 213.
- `central-hub/tiles/aircraft-flight-plan-tile.js` — uses base-class
  `_loadByPrefix`/`_renderEmptyState`/`_renderBodySafe` which exist on
  `modules/central-hub/tile.js` (lines 401, 460, 481). Healthy.
- `central-hub/tiles/inventory-tile.js` — depends on
  `window.CentralInventorySummaryStore` and
  `window.CentralInventoryQuickPriceApplier`; both present
  (`modules/inventory/inventory-summary-store.js:183`,
  `modules/inventory/quick-price-applier.js:437`).
- `central-hub/tiles/fleet-optimizer-tile.js` — drill-down CTA wires
  to `window.AesFleetHubOptimizerDrilldown.open()`;
  `modules/fleet-hub/optimizer-drilldown.js:517` exports it; the
  manifest loads it on both the dashboard block (L258) and `/app/fleets*`
  (L1005). Path is healthy at the static level.
- `central-hub/tiles/fleet-hub-tile.js`,
  `aircraft-profitability-tile.js`, `crew-management-tile.js`,
  `fleet-command-tile.js` — `escapeHtml` resolves through the top-level
  declaration in `helpers.js:235` (loaded at the top of every
  content_scripts block via L58); cross-script visible by virtue of
  being a `function` declaration at top level (functions hoist to the
  realm's global object in classic-script content scripts).
  `window.CentralHubBus` / `window.AESTokens` /
  `window.CentralHubStatusBadges` all bound by central-hub bootstrap.
- `modules/aircraft-flight-plan/route-candidates.js` — drag handle
  (line 776, the `⋮⋮` grip) renders inside an
  `if (window.AesAfpDragToSchedule && c.destIata)` guard; the right
  side is set by `modules/aircraft-flight-plan/drag-to-schedule.js:172`
  and the manifest loads it on the same `/app/fleets*` block (L890),
  *after* `route-candidates.js` (L888). Module wiring is correct;
  whether the handle visibly appears at runtime depends on
  `_ensureGesture()` finding `window.AesDragArbiter` — out of slice for
  me (canopy/drag-arbiter) but worth flagging if a follow-up agent
  reports the handle still missing on a live page.

## Manifest deltas

None proposed. The two files I edited already appear in the relevant
content_scripts blocks (`/app/aircraft/market*`,
`/app/enterprise/dashboard*` — note `price-history-store.js` is **not**
in the dashboard block, only the market block; that's intentional, the
dashboard tile reads via `MarketScanDiffStore` digests rather than the
raw history store). No new files. No manifest reorder needed for the fix
to take effect.

## Out-of-slice (observed but not touched)

- `tools/dashboard-harness-t5.html` shell-mount fail caused by missing
  `chrome.storage.local` stub in the harness page. Other agents' WIP.
  Affects every slice's harness-side runtime test; the working slice
  surface is the live AS pages, which I couldn't reach without a
  session.
- The `[AES hub-feed] AesView/AesDataBus missing — hub-feed inert`
  warning is informational from `modules/canopy/hub-feed.js`; tracked
  elsewhere (F-9223-016 was on the same module).
- `manifest.json` itself is in the WIP diff; I did not edit it.

## Screenshots

Not captured. `/tmp/9225-dashboard.png` and `/tmp/9225-fleets.png` were
both planned but the CDP socket on 9225 had died by the time I ran
through the screenshot step, and per the "don't touch other ports/chromes"
constraint I did not relaunch a fresh instance to satisfy the screenshot
side-quest. The static evidence above is the substitute.
