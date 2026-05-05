# AUTO-4a — Slot optimizer demand profile

Track 4 (Slot Optimizer) of the AES Auto-Scheduler plan. Slice 4a only —
slices 4b-4e build on top of this in subsequent commits.

## What shipped

- NEW `modules/aircraft-flight-plan/auto-scheduler/slot-optimizer.js`
  (~210 LOC). Vanilla IIFE, attaches `window.SlotOptimizer`. Mirrors the
  style of sibling Track 3 files (`grid-state.js`, `objective.js`):
  `"use strict"`, top-of-file JSDoc + `@typedef`, idempotent singleton
  guard, `?aes-debug` smoke tests at the bottom via `console.assert`.
- `manifest.json` — registered the new file in the `/app/fleets/aircraft/*/0*`
  block AFTER Track 3's `allocator.js` (it depends on the Track 3 module
  graph at slice 4d) and BEFORE `wave-applier.js` + `content_aircraftFlightPlan.js`.

## Public API surface (this slice)

```js
SlotOptimizer.demandProfile({candidates, hubIata})
  → Array<{hour: 0..23, demandWeight: number}>   // length-24, indexed by hour
```

- `candidates` — Slice C `Candidate` records (the same shape
  `route-candidates.js` produces and `AesAfpAutoScheduler.run` consumes).
- `hubIata` — accepted but unused this slice; reserved for future per-hub
  priors (e.g. local-time wake/curfew bias) without an API break.

Slices 4b-4e are stubbed as `null` on the singleton and will fill in as
they ship: `proposeAdjustments`, `filterFeasible`, `selectBest`, `optimize`.

## Demand formula

Each candidate contributes `weight = (paxScore + 0.5 × cargoScore) ×
weeklyFlights`. `weeklyFlights` defaults to 1 when missing or non-positive.
A candidate whose base demand `(paxScore + 0.5 × cargoScore)` is zero or
negative is skipped (zero-weight contributors don't move the histogram).

The weight is distributed across hours by:

1. **Per-route hourly buckets** when the candidate (or its underlying
   `_raw`/`_scoredRow`) carries a length-24 `frequency` or `hourMask`
   array. The array is normalised to a probability distribution and
   `weight × p_h` accumulated into hour `h`.
2. **Flat fallback** otherwise — `weight / 24` added to every hour.

Today FlightsFromStore's scrape (`content_flightsFrom.js:560-583`) doesn't
expose a per-route `frequency` field, so production runs always go through
the flat path. The bucket-aware branch is wired up so the moment a future
scraper enrichment ships, the histogram becomes hour-aware without touching
`slot-optimizer.js`.

## Defensive bail-outs

- Empty `candidates` array → all zeros (length-24).
- Non-array `candidates` (e.g. caller forgot to pass it) → all zeros.
- Bad entries inside `candidates` (null / non-object / missing scores) →
  silently skipped, no throw. Smoke tests cover this path.

## Smoke tests (`?aes-debug` console)

Five assertions inside the IIFE, run only when the URL has `?aes-debug`:
empty input → zeros; single-candidate flat distribution matches the
formula; missing `weeklyFlights` defaults to 1; per-hour buckets respect
the supplied shape; junk inputs ignored without throwing. Pattern
matches `grid-state.js:152-211`.

## Known limitations / TODO for next slices

- No per-hub bias yet — `hubIata` is accepted but unused. If we want
  e.g. "MCO peaks at 09:00 and 17:00 by default", that prior would land
  here.
- The flat fallback means every candidate identically pulls every hour
  by the same amount — under that distribution, the proposal heuristic
  in slice 4b will only move waves when there's a *meaningful* skew
  introduced by `weeklyFlights` differences. With per-route hour
  buckets the heuristic gets sharper teeth.
- `paxScore`/`cargoScore` units — these come from `RouteAssistantScore`
  and are scale-bag (not normalised). The histogram is internally
  consistent (one wave's hour vs. another's hour) but not directly
  comparable across runs. Slice 4b/4d only need relative ordering,
  so this is fine.

## What slice 4b builds on

- `demandProfile()` returns the canonical 24-element histogram. 4b will
  consume it directly to find peaks/valleys for shift/split/merge
  proposals.
- The internal helpers `_cloneWaves()`, `MAX_SHIFT_MIN` (=120), and
  `SHIFT_STEP_MIN` (=30) are pre-declared in `_internal` for the next
  slice to pick up without duplication.
