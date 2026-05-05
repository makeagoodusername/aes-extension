# Streamline — Agent 10

Territory: UAS, World View, Competitor Intel, Inventory, Market Scan + their content scripts and the 4061-line `content_dashboard.js`.

Pass: read-only static analysis (no live verification, no code edits).

---

## Headline

The territory is mostly working. The single biggest streamline win is `content_dashboard.js`: it's a 4061-line, eight-pane god-script that backs eight separate central-hub tiles, but its panes are independent and ready to split. Beyond that, the territory has three notable duplicate surfaces (legacy + modern) and a small handful of pre-existing unfixed bugs that survived the last session.

Counts: 6 KEEP · 0 CUT (only deletions are cosmetic/dead code) · 5 FIX · 4 DEFER · 4 STREAMLINE · 5 open questions.

---

## KEEP

### K-1. Used Aircraft Scanner module tree (`modules/used-aircraft-scanner/**`)
**Status: production, well-shaped, leave alone.**

15 files, ~290 KB total. Clean separation of concerns:
- `scan-controller.js` — pump/queue/lease/watchdog state machine.
- `scan-session-store.js`, `scan-lease.js`, `scan-diff-store.js`, `bid-intent-store.js`, `price-history-store.js` — persistence layer; each <11 KB.
- `deal-metrics.js`, `deal-classifier.js`, `deal-narrative.js` — pure-function scoring.
- `type-family-map.js` (30 KB) — large but data-only (aircraft type → family lookup).
- `presets-store.js`, `family-grid-panel.js`, `results-table.js`, `market-panel/*` — UI.

The market-panel folder (7 files, ~170 KB) is the modern in-page panel mounted by `content_marketScan.js` when a user visits `/app/aircraft/market` without a scan context. Coexists cleanly with the dashboard's scan-controller surface. Keep as-is.

Verified: scan-controller has lease coordination, watchdog, mirror mode, pop-up-block error handling. Manifest entries correct in two blocks (dashboard + market page).

### K-2. World View module tree (`modules/world-view/**`)
**Status: production, recently audited, retain.**

8 files + 6 view files. Total ~95 KB. Pure-function cores have smoke tests in `audit/tests/dashboard/` (deal-metrics, network-builder, recommend-alliance, recommend-interline, airport-coords, world-map). All passing per Agent 5's prior session.

Recently received fixes for F-DASH-501 (snapshot freshness gate now lines 181-187), F-DASH-508 (`isMine` name-fallback at lines 154-160). Both verified present in current code.

### K-3. Competitor Intel modular system (`modules/competitor-intel/**`)
**Status: keep — shoulders the modern intel surface.**

22 files, ~370 KB. Two distinct surfaces:
- **Hub modal** (`AesCompetitorIntelHost.open()`) — `host.js`, `hub-shell.js`, plus 5 views in `views/`. Triggered by both the legacy dashboard's competitor pane AND by central-hub `competitor-monitoring-tile.openHandler` (correctly preferred over the legacy bridge).
- **Per-page panels** — `airport-host.js` + `airport-panel.js` mounted by `content_competitorIntelAirport.js`; `enterprise-host.js` + `enterprise-panel.js` mounted by `content_competitorIntelEnterprise.js`.

Plus a third axis: `outline-aggregator.js` (56 KB) + `outline-panel.js` (40 KB) feeding the competitor-outline-tile. These are the largest single files in the territory and could benefit from review (see STREAMLINE), but they're working.

### K-4. Inventory module (`modules/inventory/**`)
**Status: keep — three thin files, distinct from content_inventory.js.**

- `inventory-summary-store.js` — 11 KB, read-side aggregator over `routeAssistant:inventory:` keys (written by `route-assistant/inventory-page-scraper.js`, NOT by content_inventory.js).
- `quick-price-applier.js` — 22 KB, single-class price update via the inventory form. Documented two-gate pattern (`applyEnabled`, `dryRunOnly`, `verifyAfter`). Compliant with CLAUDE.md rule #1 — does NOT introduce a new write path; it parallels the existing pricing-applier shape.
- `validation.js` — 7 KB, six checks against the AS inventory page; used by content_inventory.js.

`modules/inventory/**` and `content_inventory.js` use **disjoint storage prefixes** (`routeAssistant:inventory:` vs `<server><airline><HUB><DEST>routeAnalysis`). They're parallel, not overlapping. Don't merge.

### K-5. Modern coexistence shims (`content_competitorIntel*.js`, 52 + 56 lines)
**Status: keep — they do exactly one thing, well.**

Both are <60 LOC bootstraps that wait for an anchor element via MutationObserver, mount `AesCompetitorAirportHost` / `AesCompetitorEnterpriseHost`, and bail. Documented coexistence pattern with the legacy `content_enterpriceOverview.js` (different DOM nodes, no shared keys). Do not touch.

### K-6. `content_marketScan.js` (768 lines)
**Status: keep — single-responsibility worker.**

Child-tab worker for the used-aircraft scanner. Two entry modes (scan / goto) keyed on URL hash. Falls through to mounting `MarketPanel.mount()` when there's no AES context — that's how the in-page market UI lights up. Comment block at top is excellent.

`MAX_PAGES: 200` ceiling looks defensive. Note that natural exit is via "no next link"; the cap exists to avoid runaway loops if AS pagination malformed. F-DASH-504 from prior session flagged that silent truncation isn't surfaced — low severity.

---

## CUT

(Pure deletions only.)

### C-1. `_renderRecommendationsPlaceholder` in `world-view-tile.js` lines 453-467
**Dead code.** Branch only fires when `window.WorldViewRecommendationsPane` is undefined; manifest dashboard block (line 377) always loads it on `/app/enterprise/dashboard*`. The placeholder text "Alliance + interline recommendations land in slice W4" describes a slice that has shipped. Either delete, or convert to a true loading-state surface for the async `_loadEnterprisesForRecs` call. **15 lines of cleanup, zero behavior change.**

This is F-DASH-502 from the prior session — still present.

### C-2. Misleading variable name `route` in `wave-pane.js` lines 230, 232
**Cosmetic.** The forwarded callback receives `hubIata` (string) not a route object. Two-line rename. F-DASH-507 from prior session — still present.

---

## FIX

### F-1. F-DASH-505 — route-launcher tile cold-start race (still unfixed)
**File:** `modules/central-hub/tiles/route-launcher-tile.js:79-83`

Tile's `focus-aircraft` handler scrolls and expands but does NOT call `RouteLauncher.setActive({aircraftId})`. The controller's own subscription only attaches in `init()`, which runs lazily from `loadStatus()` / `renderBody()`. Cold-dashboard load + fleet-optimizer-click → focus-aircraft fires → route-launcher expands but picker stays on previous active.

Fix shape: add `if (window.RouteLauncher && typeof window.RouteLauncher.setActive === "function") { try { await window.RouteLauncher.setActive({aircraftId: String(aircraftId)}) } catch(_){} }` inside the handler.

**Severity: medium** (one bad expand per cold session per workflow).

**Out of A10 territory** — file owned by Agent 4 / route-launcher. Flag for cross-agent handoff.

### F-2. F-DASH-503 — competitor-monitoring-tile `get(null)` per render (perf)
**File:** `modules/central-hub/tiles/competitor-monitoring-tile.js:96`

`_loadCompetitors()` runs full-storage scan. Triggered on every render and on every storage change starting with the server prefix (server prefix matches everything: RA writes, strategy snapshots, AFP drafts). On a busy dashboard: dozens of full scans per minute.

Fix candidates:
- Cache by hash of competitor-shaped keys; invalidate only when those change.
- Filter `chrome.storage.local.getKeys?.()` by `endsWith("competitorMonitoring")` (modern API).
- At minimum, debounce 250 ms.

**Severity: not a bug — performance only.** Worth attention because the tile sits in a section that watches the busiest part of storage.

### F-3. `recommend-alliance.js` docstring drift (`openHref`)
**File:** `modules/world-view/recommend-alliance.js:21-23`

Docstring claims `openHref` is returned. Actual return at lines 154-178 omits it. No caller reads `openHref`. Either delete the claim from the docstring (preferred) or wire it. F-DASH-506 from prior session — still present.

**Severity: documentation only.**

### F-4. Legacy `content_enterpriceOverview.js` typo
**File:** `content_enterpriceOverview.js` (note: `enterprice`, not `enterprise`)

Misspelled filename. Real script (400 lines), mounts on `/app/info/enterprises/*`, writes to `<server><airlineId>competitorMonitoring` storage key. Multiple cross-references through the codebase already accept the misspelling.

Renaming would touch the manifest (line 733), 5+ comment references in `competitor-monitoring-tile.js`, plus storage-key compatibility. Storage keys themselves are fine — the typo is filename-only. **Defer, but worth noting.** Renaming is mechanical but invasive.

### F-5. Legacy `displayCompetitorMonitoring` triple-surface drift risk
**Files:** `content_dashboard.js:1145-1681` + `competitor-monitoring-tile.js` + `competitor-intel-hub-tile.js`

Three surfaces backed by the same `competitorMonitoring` storage records:
1. Legacy dashboard pane (~900 lines).
2. Central-hub mini-tile (lines 1-318).
3. Modern hub modal (`AesCompetitorIntelHost.open()` from `competitor-intel/host.js`).

All three iterate `chrome.storage.local.get(null)` and filter by `type === "competitorMonitoring"`. Schema changes here would need three coordinated touchpoints. Make schema changes a deliberate, documented event in HANDOVER.md §10.

**No fix needed today** — flag for invariants doc.

---

## DEFER

### D-1. Splitting `content_dashboard.js` (4061 lines)
**The big one. See STREAMLINE S-1.**

The script has 8 mostly-independent panes ranging 26–988 lines each. Each is reachable from its own central-hub tile via `CentralHubLegacy.switchDropdownTo(value)`. Splitting would be a 1-day refactor: add 8 new content-script entries to manifest with the same `/app/enterprise/dashboard*` matches, expose each `displayX()` as a separate file. **No behavior change required**, only file separation.

Defer because:
- Dashboard is heavily under audit by other agents (Agent 2 RA, Agent 3 Strategy, Agent 4 AFP).
- Splitting touches manifest (Agent 1's territory).
- Order-sensitive: legacy global vars (`settings, airline, server, todayDate`) are shared across all panes via module scope.
- Need an explicit cross-agent ticket; do not unilaterally split.

### D-2. Slice W5 multi-hub split view
Per AGENT-5 brief and inline `world-view-tile.js` comments — explicitly deferred. Don't touch.

### D-3. Legacy inventory pricing analysis (`content_inventory.js`)
1116 LOC, fully working, automation-driven (see `settings.invPricing.autoPriceUpdate` + `autoAnalysisSave` paths). Performs its own GET → analyse → write via `$('[name="submit-prices"]').click()` (line 647). This is an existing documented write path covered by CLAUDE rule #1 — leave alone.

### D-4. UAS Slice 2 deal-scoring tooltips
Per prior brief — verify, don't reshape. Code looks present and correct.

---

## STREAMLINE

### S-1. `content_dashboard.js` split (DEFER until cross-agent OK)
**Current: 4061 lines, 1 file, 1 manifest entry.**

Recommend splitting into 8 files (numbers from current ranges):

| Pane | Lines | Size | New file |
|---|---:|---:|---|
| Main / handler | 1-130 | 4 KB | `content_dashboard.js` (skeleton + dispatch) |
| Route Management | 131-1118 | ~30 KB | `content_dashboard_routeManagement.js` |
| General | 1119-1144 | <1 KB | inline in skeleton |
| Competitor Monitoring | 1145-2044 | ~30 KB | `content_dashboard_competitorMonitoring.js` |
| Aircraft Profitability | 2046-2746 | ~25 KB | `content_dashboard_aircraftProfitability.js` |
| Helpers | 2747-2828 | ~3 KB | inline |
| Station Automation | 2829-3203 | ~12 KB | `content_dashboard_stationAutomation.js` |
| Used Aircraft Scanner | 3204-3810 | ~24 KB | `content_dashboard_usedAircraftScanner.js` |
| Schedule Management | 3811-3913 | ~3 KB | `content_dashboard_scheduleManagement.js` |
| Flights From | 3914-4061 | ~5 KB | `content_dashboard_flightsFrom.js` |

Total: 158 KB → 7 files of 5–30 KB each. Easier to grep, faster to load incrementally, easier to attribute git blame.

Pre-condition: lift the 4 module-scope globals (`settings, airline, server, todayDate`) into a `window.AesDashboardCtx` object, OR pass them as args to each `displayX()` and rely on jQuery's late-binding for handlers.

Don't do unilaterally — needs Agent 1 manifest support and Agent 7 entry-point alignment.

### S-2. `outline-aggregator.js` (56 KB) and `outline-panel.js` (40 KB)
The two largest files in the territory. Aggregator joins 6 storage stores; panel renders the tree. Plausibly OK at this size given the join surface, but worth a code-organization pass to extract sub-aggregators (per-route, per-competitor) into separate files.

**Defer — verify load times first.**

### S-3. Three competitor-monitoring entry points
Currently:
1. Dashboard dropdown → `displayCompetitorMonitoring()` (legacy).
2. Central-hub `competitor-monitoring-tile` → opens `AesCompetitorIntelHost`.
3. Central-hub `competitor-intel-hub-tile` → opens `AesCompetitorIntelHost`.

The two central-hub tiles arguably overlap. `competitor-monitoring-tile` (`section: "routes", priority: 40`) and `competitor-intel-hub-tile` (`section: "routes", priority: 45`) both surface the same data with different lenses. Worth unifying or clarifying which is the canonical entry.

**Open question for the user.**

### S-4. UAS deal-metrics rule of three
The `MarketScanDealMetrics` static class has `BLOCK_HOURS_BY_CATEGORY`, `DAILY_BLOCK_HOURS` (legacy fallback), and `_blockHoursFor(row)`. Three coupled concepts, one of them legacy. If category coverage is now 100%, consider deleting the legacy fallback. Need data: how often does `_blockHoursFor` actually fall through to the fallback? **Open question.**

---

## Open questions

1. **Should `content_dashboard.js` be split?** This is the single biggest streamline lever (4061 → 7 files of 5-30 KB). Needs cross-agent buy-in (Agent 1, Agent 7) and is non-trivial because of shared module-scope globals.

2. **Are `competitor-monitoring-tile` and `competitor-intel-hub-tile` both needed?** They render different summaries of the same underlying data on the same dashboard section. Consider consolidation.

3. **F-DASH-505 (route-launcher cold-start race) — is the fleet-optimizer → route-launcher click workflow actually exercised?** Per prior agent brief, "synthetic concern — can be deferred" if not. Live verification needed.

4. **`content_enterpriceOverview.js` filename typo — fix it?** Mechanical rename, low risk, but invasive (manifest + comments). Storage keys are unaffected.

5. **`competitor-intel/outline-aggregator.js` (56 KB) — does it need sub-extraction?** Currently the largest single file in the territory. Working, but might benefit from splitting per-aggregation-axis.

---

## Out-of-territory flags

- **F-1 (F-DASH-505)** is in `route-launcher-tile.js` — Agent 4's territory. Flag in `audit/findings.md` for handoff.
- **D-1 split** requires `manifest.json` changes — Agent 1 owns. Submit via `audit/manifest-requests.md`.

## Verification status

- Static read-only of every territory file: complete.
- Module structure: mapped against manifest entries.
- Pure-function smoke tests: present in `audit/tests/dashboard/`, last reported all-passing per A5 findings.
- Live verification: NOT done (would need Chrome instance with auth).

## Bottom line

Three high-value moves for streamlining (in priority order):

1. **Split `content_dashboard.js`** — cross-agent coordination required. Single biggest readability/maintainability win in the territory.
2. **Cut the dead `_renderRecommendationsPlaceholder` (15 lines)** — pure-cleanup, zero risk, immediate.
3. **Fix or remove the `route-launcher-tile` cold-start race** — requires Agent 4 handoff, but is the only behavior bug currently visible in the territory.

The territory is in better shape than the file sizes suggest — `modules/used-aircraft-scanner/**`, `modules/world-view/**`, `modules/competitor-intel/**`, and `modules/inventory/**` are all production-ready and well-shaped. The 158 KB content_dashboard.js looks scary but its panes are independent.
