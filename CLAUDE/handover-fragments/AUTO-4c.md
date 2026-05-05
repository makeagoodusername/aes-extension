# AUTO-4c — Turnaround-feasibility filter

Track 4 slice 4c — drops proposals where `ScheduleFactors`-backed checks
report turnaround / range failures, then discards the worst quartile by
feasibility score. Builds on 4b's proposal generator. Slice 4d plugs
allocator-driven scoring on top.

## What shipped

- EXTENDED `modules/aircraft-flight-plan/auto-scheduler/slot-optimizer.js`
  (~+125 LOC) — added `filterFeasible()` + private `_composeSynthPreset()`.
- `?aes-debug` smoke tests extended with 4 assertions.
- HANDOVER.md Track 4 entry updated.

## Public API surface (this slice)

```js
SlotOptimizer.filterFeasible(proposals, {basePreset, candidates, selectedSpec})
  → Array<Proposal & {_meta: {feasibilityScore, warningCount, warningTypes}}>
```

- `proposals` — output of slice 4b.
- `basePreset` — required. The proposal carries only modified `waves`;
  every other field (`hub`, `factors`, `id`, ...) comes from here.
  `factors.minTransferMinutes`, `rangeBuckets`, `slotWindow`,
  `dayPattern` are all reused verbatim.
- `candidates` — Slice C records; each must have `destIata` plus
  `distanceNm` or `distanceKm`.
- `selectedSpec` — `{range, typeName}` (range in km per the AS UI
  convention; converted to nm at the boundary).

Survivors carry a fresh `_meta` block with `feasibilityScore` (lower =
better), `warningCount`, and `warningTypes` (array of stable type
strings from `ScheduleBuilder._collectWarnings`). Slice 4d will read
these for tie-breaking.

## Scoring

Each proposal is composed into a synthetic preset via `_composeSynthPreset`
(deep-clone of `basePreset.factors` so per-proposal mutations don't
leak), validated via `ScheduleBuilder.validatePreset()`, then run
through `ScheduleBuilder.build(routes)` to surface per-leg warnings.

Warning weights:
- `presetInvalid` → 10  (proposal is structurally broken)
- `rangeExceeded` → 4   (aircraft can't fly the leg, hard fail)
- `shortfall`     → 2   (wave composition wants more routes than the bucket has)
- everything else → 1   (slot violations, route unplaced, etc.)

After scoring, proposals with `validation.length > 0` are HARD-DROPPED
(structural breaks should never survive). Surviving proposals are
sorted ascending by feasibilityScore and the worst quartile is culled
(`Math.ceil(N * 0.75)` kept, minimum 1).

## Out-of-range filtering

`filterFeasible` pre-filters the candidate set to drop OOR routes
before building. This avoids redundant `rangeExceeded` warnings on
routes that EVERY proposal would fail equally (the range check is
a property of the candidate, not the wave timing). Survivors then
score on the genuinely-discriminating warnings.

## Verified outside the browser

Stubbed `ScheduleStore.newSchedule` (the only `ScheduleBuilder.build`
dependency we don't carry into slot-optimizer.js). Loaded real
`ScheduleFactors` + `ScheduleBuilder`. Confirmed:

- 2 valid proposals (noop + a 60min shift) → 2 survivors, both with
  `feasibilityScore === 1` (one `routeUnplaced` each because the test
  wave wants 1 shortHaul but the candidate set has 2 shortHaul
  candidates and the second can't fit the wave).
- 1 invalid proposal (5min wave gap < 45min minTransferMinutes) → 0
  survivors.
- 4 proposals (all-shortcut shift variants) → 3 survivors after the
  worst-quartile cull.

The base preset's wave gap was tightened to 60min (arr 13:30 → dep
14:30) so it sits safely above `minTransferMinutes: 45`. The earlier
30min draft tripped `presetInvalid` on the base itself, which would
have been a self-inflicted false negative.

## Defensive bail-outs

- Empty `proposals` → empty output.
- Missing `basePreset` or `basePreset.factors` → bail with a
  `console.warn("[AES auto-4c] ...")` and return the input array
  unchanged. Project-pattern: never throw across an external API
  boundary. (Production callers always supply a base; the warn is
  for diagnostics.)
- `ScheduleBuilder` / `ScheduleFactors` undefined (pre-mount race) →
  same warn-and-passthrough.
- All proposals filtered → empty array (NOT a single fallback —
  callers in slice 4d / 4e check `length === 0` and skip).

## Known limitations / TODO for later slices

- Warning weights are heuristic. A `presetInvalid` is correctly the
  worst, but the relative weight of `rangeExceeded` (4) vs
  `routeUnplaced` (1) is currently a guess; slice 4d's allocator
  scoring is the real signal. If the cull is dropping good proposals,
  the right move is to lower the weights (or remove the cull entirely
  when proposal count is already small).
- The build is run against the FULL candidate set, not the actual
  wave's bucket capacity. A proposal whose composition is fundamentally
  mismatched to the candidate distribution will accrue many
  `routeUnplaced` warnings and may get dropped even though Track 3's
  allocator could have re-prioritised. This is a pessimistic filter
  — false negatives possible, false positives unlikely.
- Slot violations (`slotViolation` from the builder's `_collectWarnings`)
  cost only 1 point. If a hub has a strict curfew the user wants to
  honour, raising the slot-violation weight would express that. Today
  the curfew is just one signal among many.

## What slice 4d builds on

- `filterFeasible` returns at most `proposals.length` survivors with
  `_meta.feasibilityScore` attached.
- Slice 4d will call `AesAfpAutoScheduler.run({preset: synth, ...})`
  for each survivor. Bound at 16 by 4b's cap; quartile cull at 4c
  brings that to ~12 in practice — well under the 16-allocator-runs
  budget the plan specifies.
