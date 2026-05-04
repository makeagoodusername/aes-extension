# AGENT-4.md — AFP, Fleet Hub, Schedule Management, Canvas

You own the per-aircraft and fleet-level surfaces.

## Why this is its own territory

The AFP module is the only place in the codebase that drives an AS form via the form-driver, and the only place where `fillAndSubmit` ever fires. It carries the strictest "no auto-submit" invariant. The Fleet Hub, schedule canvas, and wave applier all integrate with AFP. Keeping these together avoids cross-territory churn.

## Your Chrome instance

You'll work mostly across three URLs:

- `/app/fleets` — Fleet Hub overlay, D action chip, Schedule Canvas modal.
- `/app/fleets/aircraft/<id>/0` — AFP page, the per-aircraft Flight Plan.
- `/app/fleets/aircraft/<id>/0?aes-debug` — same AFP page with diagnostics overlay.

**Lock requirement:** acquire SHARED-NOTES real-write lock before:
- Clicking Apply-all in the auto-scheduler preview panel with the tier gate flipped to `apply-on-confirm`.
- Clicking individual leg Apply buttons that POST to the AFP form (via the gated `fillAndSubmit` path).
- Triggering wave-applier save to `ScheduleStore`.
- Anything in the Fleet Hub D chip beyond Tier 1 dry-run (Tier 1 hard-codes dry-run, but verify before assuming).

**No lock needed for:**
- Reading the VFP parser output.
- Auto-scheduler preview / Build / Re-build (these are pure compute, no AS POST).
- Schedule diff in dry-run.
- Schedule Canvas browsing without commits.

## Your scope

```
modules/aircraft-flight-plan/
├── host.js
├── settings-extension.js
├── state-store.js
├── active-draft-store.js
├── audit-log.js
├── spec-resolver.js
├── route-candidates.js
├── form-driver.js              # SACRED — never auto-submits
├── wave-applier.js
├── flight-studio/
│   ├── panel.js
│   ├── templates-store.js
│   ├── leg-spec.js
│   └── station-drawer.js
├── auto-scheduler/
│   ├── grid-state.js
│   ├── objective.js
│   ├── allocator.js
│   ├── slot-optimizer.js
│   ├── schedule-diff.js
│   ├── apply-batch.js
│   ├── auto-apply-log.js
│   ├── preview-panel.js
│   └── fleet-apply-orchestrator.js
└── SELECTORS.md

modules/aircraft-flight-plan-dashboard/
├── flight-number-applier.js
├── proxy-page-fetcher.js
├── candidate-pipeline.js
├── deep-link.js
├── settings-extension.js
├── fleet-roster-view.js
├── panel.js
├── flight-number-apply-log.js
└── host.js

modules/fleet-hub/
├── host.js
├── aircraft-aggregator.js
├── inline-table.js
├── schedule-row.js
├── summary-strip.js
├── command-center.js
├── optimizer-drilldown.js
└── hub-drilldown-panel.js

modules/schedule-management/
├── range-buckets.js
├── presets-store.js
├── schedule-store.js
├── schedule-builder.js
├── open-stations-modal.js
└── schedule-panel.js

modules/canvas/                  # Schedule Canvas, Slice E
```

## Priority audit areas

1. **AFP form-driver SACRED PATH** — `form-driver.js` must never auto-submit except via gated `fillAndSubmit`. Verify:
   - `setOrigin`, `setDestination`, `setDepartureTime`, `setPricePercent`, `setService`, `fill`, `reverse`, `clear`, `dryRun` only mutate inputs + dispatch `input`/`change` events.
   - `dryRun(leg)` returns would-be POST body — does NOT send.
   - `fillAndSubmit(leg)` invoked exclusively from `background.js` via `aes:afp:fill-and-submit` runtime message.
   - The `submitBtn.click()` is `setTimeout(0)` deferred so response rides back to background before AS POST tears down the content script.

2. **Track 1 form-driver hardening** — select2 v3/v4 commit fix, "New Flight Number" tab activation, diagnostics overlay, SELECTORS.md self-test. Verify:
   - `_detectSelect2Version()` correctly detects v3 vs v4.
   - `_commitSelect` branches on version (v3 needs `select2("val", value, true)` with triggerChange).
   - `_ensureNewTabActive()` polls every 100ms up to 1.5s for tab swap.
   - `?aes-debug` enables diagnostics overlay.
   - `runSelfTest()` walks `SELECTORS` table and returns pass/fail per row.

3. **Track 3 + 4 + 5 auto-scheduler** — slot optimiser, demand profile, batch fillAndSubmit pipeline. Verify:
   - `proposeAdjustments` returns ≤16 proposals (shift / split / merge).
   - Feasibility filter culls worst quartile.
   - `selectBest` dispatches per-proposal allocator runs.
   - Tier gate `autoScheduler.enabled === true && tier === "apply-on-confirm"` enforced everywhere.
   - Apply-all confirmation modal requires I-understand checkbox.
   - Per-leg `auto-apply:*` bus events fire correctly.
   - Abort path closes hidden tab promptly.

4. **Track 6 schedule diff** — VFP parser + diff engine. Verify:
   - `readVisualFlightPlan` filters to `.block.flight` (not just `.block`).
   - `_collapseDayCrossPairs` correctly pairs `started`/`ended` halves on `(dayIdx + 1) % 7`.
   - Sun→Mon wrap handled.
   - Unpaired halves emit warn but stay in output.
   - `compare(currentLegs, proposedLegs, opts?)` returns `{keep, delete, add, moveTime: []}`.
   - moveTime is always `[]` (Phase-1 simplification, intentional).
   - Tolerance default 15min, configurable via `opts.toleranceMin`.

5. **Schedule Canvas Slice E** — full-screen modal on `/app/fleets*`. Verify:
   - 19 canvas modules all load and modal opens via `▦ Open Schedule Canvas`.
   - Bimodal rail (Builder / Advisor) switches correctly.
   - Drop-bridge stages `addRoute` / `moveRoute`.
   - Commit-bar dispatches `applyPricing` to `RouteAssistantPricingApplier` (real, gated).
   - Single-leg `addRoute` writes to `AesHandoffStore`.
   - Multi-leg / `moveRoute` / `removeRoute` deferred to AFP — verify toast appears.

6. **Fleet Hub D chip** — dashboard expansion. Verify:
   - D action chip renders alongside R/S/P.
   - Click opens `AesAfpDashboardHost` panel.
   - Tier 1 hard-codes `dryRunOnly:true` + `applyEnabled:false` — applier always returns `{status:"dry-run"}`.
   - Zero POSTs in DevTools Network during any modal interaction.

## Specific things flagged

- "drag-affordance-store.js wired but no UI consumer" — `dragSubmitMode` competed-for by `settings.aircraftFlightPlan.dragSubmitMode` (live source). **Deferred-confirmed** — don't fix.
- "wave-registry.js consumers — Fleet Command and rebalance proposers still don't consume it" — **deferred**.
- "flightsfrom/schedule-panel.js — explicit dead code" — flag, don't delete.
- AFP/fleets de-dup: 66 known idempotent overlaps. Agent 1 owns dedup audit; you confirm idempotency guards (`if (window.X) return`) at every overlapping module.

## Pure-function smokes

Write under `audit/tests/afp/`:

- `range-buckets.js` — bucket boundaries, kmToNm conversion, parseHHMM.
- `schedule-builder.js validatePreset` — sub-MCT gaps detected.
- `schedule-builder.js assignRoutes` — deterministic placement.
- `schedule-diff.js compare` — every case from HANDOVER's 34-assertion smoke block.
- `slot-optimizer.js demandProfile` — flat fallback when no per-route hour buckets.
- `slot-optimizer.js proposeAdjustments` — ≤16 proposals cap.
- `auto-apply-log.js getRetryQueue` — failed-then-succeeded entries excluded.

## Live verifications

- AFP page mounts; ?aes-debug overlay appears.
- Click "Run self-test" — every row green.
- Click 5 candidate rows; form chips repaint correctly.
- Switch to Existing Flight Number tab and click candidate — auto-flips to New tab within 300ms.
- Auto-build week produces a build with N legs.
- Apply-all CTA disabled with tier dormant.
- Fleet Hub: D chip click opens modal; preset picker populates; Generate runs proxy GET (verify single GET, no POST in Network tab).

## Forbidden

- No edits outside listed paths.
- No relaxation of form-driver no-auto-submit rule.
- No new submit paths.
- No flipping `autoScheduler.enabled` default. No flipping AFP tier defaults.
- No edits to `modules/route-assistant/wave-overlay.js` even though Slice E wires it.
- No reshape of `aircraftFlightPlan:` storage prefixes.

## End-of-session deliverable

`audit/findings-AGENT-4.md`:

- Form-driver no-auto-submit invariant verified (re-read every method).
- Track 1 select2 fix verified.
- VFP parser day-cross collapse verified.
- Schedule diff `moveTime` always-empty contract verified.
- Schedule Canvas Slice E end-to-end.
- D chip Tier 1 zero-POST guarantee verified.
- Smoke tests under `audit/tests/afp/`.
- Live verification results.
