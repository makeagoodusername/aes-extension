# streamline-A8 — Aircraft Flight Plan / AFP Dashboard / Aircraft Flights

Agent 8 streamline pass. Read-only static analysis. No live writes.
Cross-references AGENT-4 brief + findings-AGENT-4.md (Phase 1 complete) +
SHARED-NOTES debug-sweep entries (codebase = 0 OPEN / 163 FIXED at 2026-05-01 16:35).

Territory inventoried:
- `modules/aircraft-flight-plan/` — 27 top-level + `auto-scheduler/` (12) + `flight-studio/` (5) = 44 files, ~22.7k LoC.
- `modules/aircraft-flight-plan-dashboard/` — 9 files, ~1.9k LoC.
- `modules/aircraft-flights/` — 5 files, ~556 LoC.
- Root content scripts: `content_aircraftFlightPlan.js` (62 LoC), `content_aircraftFlights.js` (529 LoC).
- Background: `modules/_background/afp-submit-queue.js` (533 LoC) — sole AFP POST entry.
- Tile: `modules/central-hub/tiles/aircraft-flight-plan-tile.js` (213 LoC).

---

## Invariant 3.3 (form-driver gated path) — VERIFIED INTACT

`form-driver.js:489` is the **only** `submitBtn.click()` in the entire codebase.
`fillAndSubmit` (line 574) is reachable from exactly two callers, both gated:
1. `content_aircraftFlightPlan.js:48` — `chrome.runtime.onMessage` filter on
   `msg.type === "aes:afp:fill-and-submit"`.
2. `modules/_background/afp-submit-queue.js:136` (single-leg) and `:260`
   (apply-batch) — both go through `chrome.tabs.sendMessage(tabId, …)`.

Single-leg, apply-batch, and delete-batch pipelines all share one
per-aircraft queue (`_afpSubmitQueues`) and abort table (`_afpBatchState`)
in `afp-submit-queue.js`, so they cannot race each other. Sequenced
submit + reload-await + cleanup is correct.

UI paths (toolbar Fill, candidate-selected bus, drag-to-schedule, Slice E
wave-applier Apply) all call `fill()` only — never `fillAndSubmit`. Drag
orchestrator (`schedule-apply-orchestrator.js:34`) reads `dragSubmit.dryRunOnly`
and `dragSubmitMode`, only calls `fill()`, and rejects `mode==="auto"`
(reserved for later phase).

## AFP drag/drop bug (HANDOVER §5) — FIXED, FUNCTIONAL

`drag-to-schedule.js:_findStripRoot()` (line 77) addresses the wrap with
`[data-aes-wave-strip="1"]` (stamped by `wave-strip.js`), with a
back-compat parent walk for older builds. `applyDrop` callback wired
through `schedule-apply-orchestrator.applyDrop` (line 156). Manifest
loads `wave-strip.js → schedule-apply-orchestrator.js → drag-to-schedule.js`
in that order on `/app/fleets*` (lines 952-959). Live verification on
2026-05-01 16:35 confirmed `AesAfpDragToSchedule` + `AesAfpScheduleApplyOrchestrator`
namespaces present on /0 page.

## AFP submit queue / dedup — NO RECENT REGRESSIONS

Last AFP-touching commits (`4dcd9ca`, `b799604`, `e2c74c2`, `2f62e6b`,
`c589c36`) are scoped to wave-applier status messages, candidate-spec
race, and per-aircraft activity scoping. None touched the submit queue
itself; the per-aircraft serialisation contract is intact. Apply-batch
recovers from per-leg reload failures by recreating the tab
(`afp-submit-queue.js:277-291`). 20-minute total wall-clock cap +
`AFP_BATCH_INTER_LEG_DELAY_MS = 500ms` between legs.

---

## KEEP (load-bearing, working as documented)

### `modules/aircraft-flight-plan/`
- `host.js` — `AesAfp` namespace + slot system + bus + ctx mounting. Sole owner.
- `form-driver.js` — SACRED PATH; `_commitSelect` no-change strategy (Wicket-Ajax-race fix) is intentional, well-documented at lines 184-190.
- `vfp-reader.js`, `planning-matrix-reader.js`, `turnaround-popover-reader.js` — VFP scrapers feeding `schedule-broadcaster.js`.
- `schedule-broadcaster.js` — single writer of `aircraftFlightPlan:schedule:<server>:<aircraftId>`; consumers in route-assistant + schedule-management + aircraft-flights `scheduled-decorator.js`.
- `schedule-store.js` — load/save/watch contract; cross-territory consumer count is high (RA panel, RA aggregator, schedule-management, scrape-orchestrator).
- `schedule-model.js` — pure shape factory.
- `schedule-apply-orchestrator.js` + `drag-to-schedule.js` — drag pipeline; correctly two-gated (`dragSubmitMode` + `dragSubmit.dryRunOnly`).
- `route-candidates.js`, `spec-resolver.js`, `audit-log.js`, `state-store.js`, `active-draft-store.js` — core slices, all consumed cross-territory.
- `wave-strip.js` — drag target + `coordsToWave/coordsToMinute` API consumed by `drag-to-schedule.js`.
- `wave-applier.js` — Slice E wave-aware applier; renders into `slot("wave")`.
- `flight-log-store.js`, `flight-log-scraper.js` — per-flight log capture.
- `maintenance-store.js`, `maintenance-scraper.js`, `maintenance-budget.js`, `wear-model.js` — consumed by `preview-panel.js` budget block + Strategy `context.js`.
- `submit-bridge.js` — chrome.runtime wrapper for the schedule-management overlay; consumed in block 21 (manifest line 894). Documented contract.
- `page-bridge.js` — MAIN-world select2 commit bridge; legacy backstop the no-change strategy bypasses on AS today.
- `diagnostics.js` — `?aes-debug` overlay + SELECTORS self-test; consumed by form-driver instrumentation calls.
- `settings-extension.js` — sole writer of `settings.aircraftFlightPlan.*`. Tier defaults conservative.
- `auto-scheduler/*` — all 12 modules wired (grid-state → objective → allocator → slot-optimizer → preview-panel → apply-batch → flight-deleter → fleet-apply-orchestrator → fleet-picker-modal → locked-confirm-modal → schedule-diff). Tier gate + I-understand checkbox + 16-proposal cap verified intact (F4-005).
- `flight-studio/*` — all 5 modules wired through `content_aircraftFlightPlan.js:35-37` attach call.

### `modules/aircraft-flight-plan-dashboard/`
- `host.js` — singleton, lazy-wires on D chip click.
- `panel.js` — Tier 1 modal.
- `flight-number-applier.js` — Tier 1 hardcodes `dryRun = true` (line 338) and `applyEnabled = false`; settings layer also forces both regardless of storage. Belt-and-suspenders verified F4-006.
- `flight-number-apply-log.js`, `proxy-page-fetcher.js`, `candidate-pipeline.js`, `fleet-roster-view.js` — all wired into panel + consumed cross-territory (Fleet Hub `routine-orchestrator.js` + `command-center.js`).
- `deep-link.js` — URL builder with `?aes-debug` toggle.
- `settings-extension.js` — Tier 1 lockbox; T1 invariants forced post-merge.

### `modules/aircraft-flights/`
- `aircraft-data.js`, `info-panel.js`, `aircraft-statistics-panel.js`, `extraction-button.js` — /1 page panels. Recently fixed F-9228-801/802/805/807 (idempotent mount + airline-scoped storage + click handler wire).
- `scheduled-decorator.js` — /1 page row decorator joining `AesAfpScheduleStore` legs by flightId. Read-only. Storage onChanged → debounced repaint.

### Content scripts (in territory)
- `content_aircraftFlightPlan.js` — /0 page boot + `aes:afp:fill-and-submit` runtime listener. Tight, well-commented.
- `content_aircraftFlights.js` — /1 page boot + flights-table extraction. Hardened on 4da1466 (airline-scoped keys, idempotent updateTable, popup-blocker recovery).

### Background + tile (in scope, in territory)
- `modules/_background/afp-submit-queue.js` — three pipelines (single-leg / apply-batch / delete-batch) sharing per-aircraft serialisation. Single point of POST.
- `modules/central-hub/tiles/aircraft-flight-plan-tile.js` — registered into CentralHubTileRegistry (line 206).

---

## CUT (orphans, dead code, no consumers found)

**Findings file note:** AGENT-4 Phase 1 `[BUG] F4-002` already flagged
`form-driver.js:_detectSelect2Version` as dead code (zero callers, no
runtime effect). ~7-line cleanup deferred to Phase 2.

No other dead modules located. `visual-wave-overlay.js` (1376 LoC) has no
external callers beyond its own self-attach + bus subscriptions — but it
is the *primary* renderer of the Visual Flight Plan overlay (paints
preset windows + candidate bars on AS's `.visual-flight-plan` Gantt) and
is registered in the manifest at line 959. Self-rendering by design;
keep.

`page-bridge.js` (51 LoC) — backstop, not currently exercised because
`form-driver._commitSelect` uses no-change strategy. Comment block
explains it remains as protocol if AS ever switches to a build that
needs the change-event commit. Keep — cheap insurance.

---

## FIX (low-risk, scoped, queued by AGENT-4 Phase 2)

1. **F4-011 / Agent 1 F-6** — wrap `schedule-store.js` in idempotent IIFE
   guard. Class declared at top level (line 34); `if (typeof window !==
   "undefined" && window.AesAfpScheduleStore)` only guards namespace
   assignment, not class redeclaration. Today's manifest loads
   `schedule-store.js` twice on `/app/fleets/aircraft/*/1*` (block 19[11]
   + block 27[4]). If Agent 1's F-2 dedup doesn't land, second IIFE
   throws SyntaxError and kills the rest of block 27 (200 entries).
   ~6 LoC defensive fix.

2. **F4-002** — delete dead `_detectSelect2Version` helper from
   `form-driver.js:118`. Zero callers; the no-change `_commitSelect`
   strategy at line 202 bypasses select2 entirely. ~7 LoC. Cosmetic.

3. **F4-003** — extend `auto-scheduler/schedule-diff.js:compare(currentLegs,
   proposedLegs, opts?)` to honour `opts.toleranceMin` (default 15min).
   Two-arg today. Pure-function core; no apply path touched. ~5 LoC.

4. **AGENT-4 Phase 2 smokes** — write `audit/tests/afp/{range-buckets,
   schedule-builder, schedule-diff, slot-optimizer, auto-apply-log}.js`.
   No Chrome dep; locks down contracts AGENT-4 brief specified.

---

## DEFER (intentional half-features, do NOT ship)

- `dragSubmitMode === "auto"` reserved for Phase 5 stretch — `schedule-apply-orchestrator.js:81-82` returns explicit error.
- Tier 2 dashboard live POSTs — `flight-number-applier.js:466-475` has explicit `error.code: "tier2NotShipped"` anchor.
- `drag-affordance-store.js` (Agent 3 territory) wired but no UI consumer per AGENT-4.md spec — deferred-confirmed.
- `wave-registry.js` (Agent 3) — Fleet Command + rebalance proposers don't consume it. Deferred per brief.
- Slice E `moveRoute`/`removeRoute` deferred to AFP per `commit-bar.js`; multi-leg single-tab batches deferred. Toast wiring intact.

---

## STREAMLINE (process / structure observations, no edits in this pass)

### `aircraft-flights` vs. `aircraft-flight-plan` separation — clean

Two distinct concerns:
- `aircraft-flights/` = /1 page (historical flights table) panels +
  decorator. Read-only against AS, write-only to chrome.storage with
  airline-scoped keys.
- `aircraft-flight-plan/` = /0 page (per-aircraft Flight Plan) + the AFP
  Dashboard host. Form driving + schedule store + 12-module
  auto-scheduler + 5-module flight-studio + wave overlay/applier.

`scheduled-decorator.js` correctly bridges the two by joining
flightNumberId → AesAfpScheduleStore legs. No muddled ownership.

### Wave/canvas/scheduling integration — wired cleanly

- `wave-strip.js` provides `coordsToWave/coordsToMinute` API.
- `drag-to-schedule.js` consumes it for drop-target resolution.
- `schedule-apply-orchestrator.js` is the form-driver gate for drag drops.
- `wave-applier.js` (Slice E) consumes `RouteAssistantWaveOverlay`'s
  `buildSchedule` + paints into `slot("wave")`.
- `visual-wave-overlay.js` paints AS's Gantt with preset windows and is
  the only module that mutates the `.visual-flight-plan` panel directly
  (vs. AesAfp slots).

No dead wiring observed. Schedule Canvas Slice E (in `modules/canvas/`,
Agent 4 territory but not strictly AFP) verified by AGENT-4 F4-007 —
out-of-scope here, no findings.

### content_flightNumbers.js — partial overlap with AFP

Owned ambiguously: contains both `/app/com/numbers` group surface (A7
likely) AND the AFP delete-flight-form handler (consumed by
`afp-submit-queue.js:424`). Not assigned in either AGENT-4 or AGENT-7
brief. Recommend explicit assignment to A7 at consolidation since the
delete handler is just a chrome.runtime listener; the bulk is groups UI.

### AFP module count is high (44 + 9 + 5 = 58 files, ~25k LoC)

Could consolidate `flight-log-store.js` + `flight-log-scraper.js` and
`maintenance-store.js` + `maintenance-scraper.js` (each ~200-400 LoC
pair) into single files if the user wants. Today's split mirrors the
"reader vs. store" pattern used elsewhere (turnaround-popover-reader,
planning-matrix-reader). No urgency — pattern is consistent.

### Audit-log `_attach` / `whenReady` poll-retry plumbing

`spec-resolver.js:281-307`, `audit-log.js:280-303`,
`route-candidates.js:1348`, `wave-applier.js:1081-1113` — all carry
50-200ms poll-retry loops to defer until `window.AesAfp.bus` exists.
Workaround for Agent 1's F-3 (manifest block 20 missing host.js +
route-candidates.js + wave-applier.js). Per F4-010 these can be deleted
(~80 LoC) **if and only if** Agent 1 lands the manifest reorder. Sequence
the cleanup after Agent 1's commit.

---

## Open questions

1. **Should F4-011 idempotent-guard sweep extend beyond schedule-store?**
   Sister classes `AesAfpStateStore`, `AesAfpActiveDraftStore`,
   `AesAfpFlightLogStore`, `AesAfpMaintenanceStore`, `AesAfpWearModel`,
   `AesAfpAuditLog` are all class-bodied at top level. Need a quick grep
   to see which (if any) are duplicated across manifest blocks on the
   same URL match. AGENT-4 raised this as Phase-2 question; user OK
   needed.

2. **Sequence F4-010 vs Agent 1's F-3.** If Agent 1 lands the manifest
   reorder (host.js + route-candidates.js + wave-applier.js into block
   20 BEFORE audit-log.js while keeping them in block 27 too), AGENT-4
   should delete the four poll-retry workarounds. Otherwise, leave as
   belt-and-suspenders. Agent 1 owns the trigger.

3. **`content_flightNumbers.js` ownership.** Has AFP delete-flight-form
   listener (consumed by afp-submit-queue) inside the same file as the
   /app/com/numbers groups surface. Should the AFP delete handler move
   to its own file under `modules/aircraft-flight-plan/` or stay in the
   content script? Splitting would clean territory boundaries; staying
   keeps the content-script contract simple.

4. **`auto-scheduler/preview-panel.js` is 2168 LoC** — largest file in
   AFP territory. AGENT-4 Phase 1 verified the apply path + 16-proposal
   cap + I-understand checkbox; size alone isn't a bug. User call:
   refactor target for a future agent, or leave?

---

## Counts

- KEEP: 50 modules (all wired, consumed cross-territory or self-rendering by design).
- CUT: 0 (only F4-002 ~7-line dead helper inside form-driver.js, already queued).
- FIX: 4 items (F4-011 guard, F4-002 cleanup, F4-003 opts arg, smokes).
- DEFER: 5 deferred-by-design items.
- STREAMLINE: 4 process observations (aircraft-flights/AFP separation OK; wave wiring OK; content_flightNumbers ownership; module count).
- OPEN QUESTIONS: 4.

## Disposition

The AFP territory is **healthy and load-bearing**. SACRED PATH intact,
drag-drop fixed, dashboard Tier 1 zero-POST guarantee defended in two
places, schedule-store contract honoured by 5+ external consumers. The
queued Phase-2 fixes from AGENT-4 are low-risk and additive. No CUT
recommendations beyond the dead-helper cleanup AGENT-4 already filed.
