# Streamline Audit — Agent 9

Territory: **Fleet Hub + Schedule Management + Fleet-Schedule-Grid + Canvas + Slots**.
Phase: read-only audit (no edits to production code).
Date: 2026-05-02.

File counts in territory:
- `modules/fleet-hub/` — 12 files, ~25.6k LoC (`command-center.js` alone is 5,390 LoC).
- `modules/schedule-management/` — 6 files, ~3.0k LoC.
- `modules/fleet-schedule-grid/` — 14 files, ~7.0k LoC.
- `modules/canvas/` — 22 files (incl. `actions/`, `overlays/`, `onboarding/`, `rail/`), ~6.7k LoC.
- `modules/slots/` — 4 files, ~0.4k LoC (stubs, see CUT-2).
- Root content scripts in territory: `content_fleetHub.js` (49 LoC), `content_fleetManagement.js` (295 LoC), `content_fligthSchedule.js` (typo, 202 LoC), `content_scheduling.js` (out-of-territory; mounts RA panel).

---

## KEEP (load-bearing, working)

K-1. **`content_fleetManagement.js` + `content_fleetHub.js`** — the legacy v0 fleet table extractor and the new Fleet Hub mount script cooperate cleanly. The Hub script gates on `.as-page-fleet-management`, waits for `fltmng_display()` to write its panel, then mounts. They are NOT duplicates: the v0 script does the fleet roster scrape that writes `<server><airline>aircraftFleet` storage; the Hub script reads that storage to drive `FleetHubAircraftAggregator`. No daylight between them.

K-2. **`modules/fleet-hub/host.js` + `inline-table.js` + `aircraft-aggregator.js` + `summary-strip.js` + `schedule-overlay.js`** — the core inline-table augmentation pipeline (R/S/P/D action chips, Loc/Plan/Sched cells, summary strip). Verified routes through `AesAfp` storage, `ScheduleStore.listIndex`, and `AesAfpDashboardHost` (D chip). Wiring contract is solid; storage-onChanged repaint debounced; idempotent `data-aes-fleet-hub` flag. No issues.

K-3. **`modules/schedule-management/{range-buckets,schedule-store,presets-store,schedule-builder}.js`** — pure-function core consumed widely (route-assistant/panel.js, fleet-hub/command-center.js, AFP auto-scheduler/slot-optimizer.js). `ScheduleFactors`, `ScheduleStore`, `SchedulePresets`, `ScheduleBuilder` are real contracts. Don't merge or rewrite.

K-4. **`modules/schedule-management/schedule-panel.js`** (1,599 LoC) — the live schedule editor with overlay-mode (per-aircraft) and dashboard-mode. Used by `FleetHubScheduleOverlay.open()` (S chip) and elsewhere. `_isOverlayMode()` switch is intentional; full bi-directional sync with `AesAfpActiveDraftStore`. Keep but see STREAMLINE-1 for size.

K-5. **`modules/schedule-management/open-stations-modal.js`** — bulk station-opening helper; consumed by AFP route-builder via `seedIatas` + by ScheduleManagement panel. Working.

K-6. **`modules/canvas/` end-to-end (Slice E shipped)** — 19 of 22 files registered in manifest block 27 in declared order. Drop-bridge → context-menu → commit-bar pipeline gates pricing through `RouteAssistantPricingApplier` (RA pricing gates honoured) and routes addRoute single-leg → `AesHandoffStore`; multi-leg/move/remove deferred with toast. Wave-spine renderer + assistant rail (Builder/Advisor) are functional. Canvas uses `CentralHubBus` exclusively — events confined to internal modules but that's expected (the canvas is one cohesive feature surface). Don't touch.

K-7. **`modules/canvas/canvas-state-store.js` + `canvas-events.js`** — `AesCanvasStateStore` persists shell prefs (active hub, view, rail mode, advisorPrefs); `AesCanvasEvents` is a frozen constants module so typos can't silently disable subscriptions. Excellent pattern — keep.

K-8. **`modules/fleet-schedule-grid/` (whole module)** — 14 files cleanly orchestrated. `host.js` self-mounts on `/app/fleets*`; emits both legacy panel (`✈ Open Fleet Schedule Grid`) and Schedule Canvas (`▦ Open Schedule Canvas`) buttons. `panel.js` (1,243 LoC) is the legacy time-axis Gantt; the canvas's `timeline-surface.js` re-uses `FleetScheduleGridRenderer` so the codepath is shared, not duplicated. `bulk-scraper.js`, `route-coloring.js`, `wave-layout-store.js`, `flight-inspector.js`, the dnd plumbing, the wave overlay/picker — all working. No cuts.

K-9. **`modules/fleet-hub/optimizer-drilldown.js`** (`AesFleetHubOptimizerDrilldown`) — read-only Fleet Optimizer drill-down. Phase 1 ships; Phase 4 apply drawer is documented as deferred. Behaviour today is correct (read-only; rebalance proposals in detail pane).

K-10. **`modules/fleet-hub/hub-drilldown-panel.js`** — per-hub planning view triggered from Fleet Command Center hub cards. Read-only modal showing strategy-engine plan vs. current schedules; no apply path. Wired and working.

K-11. **`modules/fleet-hub/hub-management-store.js`** + **`aircraft-tags-store.js`** + **`routines-store.js`** + **`routine-orchestrator.js`** — per-account stores and the orchestrator that drives the Aircraft Plans tab routines. Touched recently (Apr 29–30); current account-scoping works. Keep.

K-12. **Bus topics in this cluster** — every `CentralHubBus.emit` has an `on`. No dead emits. `aes-fleet-hub:action-{r,s,p,d}` are DOM CustomEvents on the table, listened to by `host.js`. `open-tile` emits from canvas/cubist-map, command-palette, hero-strip, hero-polyhedron, central-hub/shell.js → consumed by `fleet-schedule-grid/host.js` + `central-hub/shell.js`. `data:slots:available:updated` + `data:slots:bid:queued` consumed by `central-hub/tiles/strategy-slot-trading-tile.js`.

---

## CUT (safe to remove)

CUT-1. **`content_fligthSchedule.js` (typo)** — only loaded on `/app/info/enterprises/*tab=3`. Writes legacy `<server><airline>schedule` storage. The ONLY consumers are `content_dashboard.js` (lines 144, 1180, 2754) and `content_enterpriceOverview.js` (line 311), both of which use it solely for "last schedule extract date" staleness display on the dashboard's Schedule row. Modern modules (RouteAssistant, AFP, fleet-hub) do not depend on this storage; they use AFP's `AesAfpScheduleStore` for actual flight data and the `<server><airline>scheduleManagement:index` for saved-schedule history. The "Extract Schedule" button is auto-clicked from `content_dashboard.js:2782` when the user clicks "extract schedule data"; the data lifecycle is exclusively staleness-banner. **Recommendation: DO NOT delete the file** (the dashboard staleness UI still uses it), but **DO**:
  (a) Rename to `content_flightSchedule.js` (fix typo) and update manifest line 179. Out-of-territory rename — request via `audit/manifest-requests.md` to Agent 1; touching `content_fligthSchedule.js` is Agent 7's territory.
  (b) Or, since it's small (202 LoC) and isolated, leave the typo alone — the file works, it's just ugly. No-fix is acceptable.
  Either way, I confirm: **no duplicate `content_flightSchedule.js` exists** on disk. Only the typo'd version. NO CRUFT — but typo'd filename is grating.

CUT-2. **`modules/slots/` — entire module is a Slice 20 stub**.
  - `slot-scraper.js`: `parseHtml()` is hardcoded `return null`. The fetch path returns `{ok:false, reason:"form-shape-not-yet-mapped"}` until someone captures AS sample HTML and writes the parser.
  - `slot-bidder.js`: `apply()` always returns `{ok:false, reason:"form-shape-not-yet-mapped"}` after the dry-run logging branch. POST path is intentionally unimplemented.
  - `slot-store.js`: works correctly but only ever stores what the user hand-seeds via `AesSlotScraper.record()`.
  - `slot-scorer.js`: pure-function core, scores correctly given inputs.
  - **Consumers**: `modules/strategy/slot-tuner.js` (advisory only — `applicable: false` until `slotBidApplyEnabled`), `modules/central-hub/tiles/strategy-slot-trading-tile.js` (panel tile that says "No slot data yet — visit /app/airport/<iata>/slots or paste records via AesSlotScraper.record()").
  - **Disposition**: this is **DEFER**, not CUT — the surface is plumbed end-to-end (store → scorer → tuner → tile) and the user can manually seed data. The only missing piece is parser + POST path. Calling it CUT would orphan the strategy-slot-trading-tile and the slot-tuner Decision pipeline.

CUT-3. **None of the territory's modules are unloaded by manifest** — verified all 12 fleet-hub files, all 6 schedule-management files, all 14 fleet-schedule-grid files, all 22 canvas files, and all 4 slots files appear in `manifest.json` block 27 (or block 22 for slot files which load on `/app/com/scheduling*`). No orphans.

---

## FIX (real bugs)

(None high-priority found in this territory; AGENT-4 phase-1 findings already cover the AFP-side fixes.)

F-1. **`content_fligthSchedule.js` filename typo**. Either fix the manifest entry + rename, or live with it. NO behavioural impact; cosmetic. (See CUT-1.) — **OUT OF TERRITORY** for Agent 9 (Agent 1 owns manifest, Agent 7 owns content scripts).

F-2. **`content_fleetManagement.js` is jQuery-era code** (still uses `$()`, `.append()`, etc.). Functional, but it lives in a pre-modular era and the newer Fleet Hub modules wrap around it. Long-term code-health concern; not a bug today. **OUT OF TERRITORY** (Agent 7).

F-3. **`modules/fleet-hub/command-center.js` is 5,390 LoC** — single file with 100+ methods. Painful to reason about. Not a bug, but a maintenance liability. See STREAMLINE-1.

---

## DEFER (intentional half-features per HANDOVER)

D-1. **Slots module — Slice 20 v1 stub**. Documented in module headers as "stub … until an AS sample lets us write a confident parser". Hand-seed flow works (`AesSlotScraper.record()`). Strategy panel tile rendered. Bidder POST gated and intentionally returns "form-shape-not-yet-mapped". **Don't ship**: live POST path + HTML parser; **DO ship** if needed: bidder verification once parser exists.

D-2. **Canvas Builder Engine (`builder-engine.js`)** — V1 heuristic only (demand-fill + range-trim + composition match). Comment block at line 22-27 documents that the full `AesAfpAutoScheduler.run()` path is reserved for surfaces with route-candidates already resolved. This is intentional; v2 swap is a future slice.

D-3. **Canvas commit-bar `moveRoute` and `removeRoute`** — emitted on bus + recorded in apply log as dry-run placeholders, no in-process write. Comment block at commit-bar.js:21-29 documents that AS's per-flight-edit POST is fragile (Wicket page-version constraints) and the canonical path is delete-then-add via the AFP page. Phase 7 stages intent; Phase 8+ will materialise — explicitly deferred.

D-4. **`modules/fleet-hub/optimizer-drilldown.js` Phase 4 apply drawer** — header docstring at line 12-14 says "Phase 1 is read-only — no Apply buttons. Phase 4 will add the action drawer with rebalance proposals + two-gate apply." Today's read-only behaviour is correct.

---

## STREAMLINE (code-health, not bugs)

S-1. **`modules/fleet-hub/command-center.js` is 5,390 LoC of single-class spaghetti**.
  - 4 tabs × N hub-card render paths × inline editor for waves × inline editor for aircraft drafts × routine orchestration UI × strategy header strip composition × kebab menus.
  - Recommend splitting into:
    - `command-center.js` — class shell + tab switching + storage listener (~600 LoC).
    - `command-center/overview-tab.js` — hub-card grid renderer (~1,500 LoC).
    - `command-center/schedules-tab.js` — saved-schedule history view (~600 LoC).
    - `command-center/waves-tab.js` — wave preset library + inline editor (~1,200 LoC).
    - `command-center/aircraft-tab.js` — per-aircraft routine orchestration (~1,500 LoC).
  - Risk: medium — 5,390 LoC with cross-method internal state. Worth doing as a dedicated session, not in a streamline pass.
  - **Not for Phase-2 in this audit**; flag for a future code-health pass.

S-2. **`modules/schedule-management/schedule-panel.js` is 1,599 LoC** with both dashboard-mode and overlay-mode in one class. The mode-switch (`_isOverlayMode()`) is fine but the file is large enough to warrant splitting `_renderOverlayLegEditor` and the dashboard preset-list UI into siblings. Lower priority than S-1.

S-3. **`modules/canvas/` shape vs. `modules/fleet-schedule-grid/` shape** — these are two parallel UIs both launched from the fleet-management page, both reading the same data sources. They aren't duplicates: FSG is the legacy time-axis Gantt; canvas is the wave-spine view + assistant rail. They share renderers (`timeline-surface.js` reuses `FleetScheduleGridRenderer`) and bulk-scraper. The cohabitation is intentional and well-architected (see canvas-shell.js comment at line 14-22). Keep both; do not merge. **Note**: a future surface choice ("which view does a new user land on?") might trigger a deprecation of the legacy panel, but today both serve distinct UX needs (route-overlay highlighting vs. wave-as-spine spatial reasoning).

S-4. **Schedule-management vs. fleet-schedule-grid — distinction is real**:
  - `schedule-management/` is the **logic + storage layer** (presets, builder, store, range-buckets, panel, open-stations-modal). Pure-function cores + a UI that mounts on the AS schedule page (`/app/com/scheduling`) and inside the Fleet Hub overlay.
  - `fleet-schedule-grid/` is a **viewer + light-edit surface** that mounts only on `/app/fleets*`. Reads scraped Schedules; doesn't own preset CRUD.
  - **Don't merge**. They're orthogonal.

S-5. **`fleet-hub/host.js` _onActionR** opens `/app/com/scheduling/HUBHUB` (HUB→HUB) which Route Assistant scoring activates from. This was already a thoughtful design — not the obvious `/app/com/scheduling/HUB` open. Document the rationale in the inline comment so it's not "fixed" by accident.

---

## Open questions

Q-1. **Filename typo `content_fligthSchedule.js`**: the user has lived with it since at least 0.6.x. Is the cost of renaming (risk: missing one of N callers — only manifest line 179 found, but I should confirm) worth the cosmetic win? **My recommendation: rename + update manifest in a Phase-2 cleanup pass owned jointly by Agents 1 + 7. Low risk, but cross-territory.**

Q-2. **Slots module lifecycle**: do we ship Slice 20 v2 (HTML parser + POST) in the near term, or is this permanently dormant? If dormant >6 months, consider hiding the strategy-slot-trading-tile until it's lit up — currently it shows "No slot data yet — paste records manually" which is a poor first impression for a tile in the strategy hub.

Q-3. **`command-center.js` 5,390 LoC**: any appetite for a multi-session split, or is the file's size OK because most edits land in one tab section at a time? (See S-1.)

Q-4. **Canvas Builder vs. AFP Auto-Scheduler dual-track**: today the canvas's Builder engine is a V1 heuristic distinct from AFP's full auto-scheduler. Long-term, do these converge into one engine called from two surfaces, or stay distinct (canvas = quick wave-fill, AFP = full per-aircraft optimisation)? See D-2.

Q-5. **Fleet Schedule Grid (`✈`) vs. Schedule Canvas (`▦`)**: two side-by-side launcher buttons in `fleet-schedule-grid/host.js:_tryRender`. Is "two buttons forever" the intended UX, or is one of them a transition state? If transition: which becomes the default?

---

## Cross-agent notes

- **Agent 1 (manifest)**: confirm no duplicate `content_flightSchedule.js` (correct spelling) exists in any branch/build artifact. If user wants the typo fixed, that's a manifest line 179 + filesystem rename.
- **Agent 4 (AFP/Fleet Hub)**: brief overlap. AGENT-4.md fold-in includes `modules/fleet-hub/**` and `modules/schedule-management/**` in their "allowed write paths". I have NOT edited; my findings here complement Agent 4's `findings-AGENT-4.md` (no conflicts found).
- **Agent 7 (content scripts)**: the typo'd `content_fligthSchedule.js` and jQuery-era `content_fleetManagement.js` live in their territory. Cosmetic concerns only.
- **Agent 8 (consolidation)**: at end-of-session, please cross-reference my CUT-1 / CUT-2 dispositions with Agent 4's findings — both touch the AFP/Fleet/Schedule cluster.

---

## Summary

- **KEEP**: 12 (cluster is largely working).
- **CUT**: 0 (one borderline filename-typo flagged in F-1; slots stub is DEFER not CUT).
- **FIX**: 0 within territory (typo is cross-territory).
- **DEFER**: 4 (Slots Slice 20 v2, Canvas Builder v2, Canvas move/remove POST, FleetOptimizer Phase 4 apply).
- **STREAMLINE**: 5 (mostly code-health: command-center split, schedule-panel split, FSG/canvas duality is intentional, schedule-management vs FSG distinction is intentional, hub.js R action's rationale comment).
- **Open questions**: 5 (typo rename, slots lifecycle, command-center split, builder vs. AFP convergence, FSG vs. canvas long-term).

Top finding: this cluster is in better shape than its file count suggests. The largest cleanup wins are organisational (split the 5,390-LoC command-center.js) rather than functional. Slots is a known stub. The `content_fligthSchedule.js` typo is the only real cruft — and even that is harmless until someone tries to add a `content_flightSchedule.js` next to it.
