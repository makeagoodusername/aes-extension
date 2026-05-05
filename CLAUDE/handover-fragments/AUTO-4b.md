# AUTO-4b — Slot proposal heuristic

Track 4 slice 4b — generates up to 16 tweaked-preset proposals from a
demand profile + a baseline preset. Builds on slice 4a's
`demandProfile()`. Slices 4c-4e plug feasibility filtering, scoring, and
preset-save on top.

## What shipped

- EXTENDED `modules/aircraft-flight-plan/auto-scheduler/slot-optimizer.js`
  (~+250 LOC) — added `proposeAdjustments()` + four private helpers.
- The singleton's `proposeAdjustments` field is now wired (4a left it
  null). `filterFeasible` / `selectBest` / `optimize` still null.
- `?aes-debug` smoke tests extended with 6 assertions covering shape,
  cap, source enum, peak-targeting, empty-preset bail, and the
  on-peak no-shift case.
- HANDOVER.md Track 4 entry updated.

## Public API surface (this slice)

```js
SlotOptimizer.proposeAdjustments({preset, demandProfile})
  → Array<Proposal>   // up to MAX_PROPOSALS (16) entries
```

Each `Proposal` is `{waves: Wave[], source: "shift"|"split"|"merge",
deltaDescription: string}`. The waves array is a NEW list (so the
caller can't accidentally mutate the source preset); each modified
wave is also a deep clone.

## Three heuristics

1. **Shift** — for every wave, compute the centre of its departure
   window, find the nearest demand peak via a "weight − 0.5×distance"
   tiebreaker, then emit ±step proposals (`SHIFT_STEP_MIN` = 30 min)
   up to `MAX_SHIFT_MIN` (120 min). Only the targeted wave moves; the
   others stay put. Direction follows the sign of `peakMin − centreMin`.
2. **Split** — when a wave's departure window is ≥1h wide AND contains
   an interior hour whose demand weight is <0.5× the average of the
   window's edge hours, split into two narrower waves around the
   valley. Composition is halved (ceil for first half, floor for
   second so totals round up rather than down). Arrival windows scale
   proportionally.
3. **Merge** — for every adjacent wave pair where BOTH windows are
   <60min wide AND both centres lie within ±2h of the same hour-bucket
   peak in their union span, merge into one wider wave. Composition
   sums; arrival window spans `min(starts) → max(ends)`.

All three respect `MAX_PROPOSALS` (16). Generation order is
shift→split→merge so a heavy shift portfolio doesn't crowd out the
qualitatively different split/merge variants — but if shifts alone
fill 16 slots, the cap holds and slice 4d will only see shifts. This
is the "quality over enumeration" tradeoff the plan calls out.

## Verification (Node smoke run)

Ran the helper logic outside the browser via a stub `ScheduleFactors`
with the synthetic demand profiles from the in-file smoke tests.
Verified:

- Mistuned preset (wave at 14:00, peaks at 09:00 + 17:00) → 4 shift
  proposals each targeting 17:00 (the higher peak). Each step is
  +30, +60, +90, +120 min — all within the cap.
- On-peak preset (wave at 17:00, peak at 17:00) → 0 shift proposals
  (the heuristic skips zero-distance shifts).
- Wide-window preset with a clear interior valley → 1 split proposal.
- Two adjacent thin waves both within ±2h of a shared peak → 1 merge
  proposal.

Results match the plan's verification spec for slice 4b ("With a
deliberately-mistuned MCO preset (waves at 03:00 and 14:00), run the
slot-optimizer — it should propose waves nearer 09:00 and 17:00").

## Defensive bail-outs

- Empty / missing `preset.waves` → empty proposals.
- Non-length-24 `demandProfile` → empty proposals.
- Window arithmetic that would cross 00:00 / 24:00 → null shift
  proposal (skipped).
- Composition sums that would produce negative or NaN → 0|0|0
  (via `| 0` coercion).

## Known limitations / TODO for later slices

- The shift heuristic only targets ONE peak per wave (the nearest by
  the `weight − 0.5×dist` score). A future slice could enumerate the
  top-3 peaks per wave and emit shifts toward each. Today the cap is
  16 across the whole preset; we'd need to extend that to keep all
  shifts in the proposal set.
- Split/merge proposals don't verify their resulting compositions are
  feasible against the candidate set — that's slice 4c's job.
- `_nearestPeakHour`'s tiebreaker prefers heavier peaks regardless of
  distance once the weight gap is >0.5×hours. With FlightsFromStore's
  current flat fallback this means EVERY wave shifts toward a single
  global peak — which is precisely what we want when there's no
  per-route hour data, but worth flagging when 4d scoring sees an
  unexpectedly-uniform proposal set.

## What slice 4c builds on

- `proposeAdjustments()` returns proposals carrying full `waves`
  arrays — slice 4c will iterate those and call
  `ScheduleFactors`-backed checks. The proposals are independent
  (no shared state), so 4c can sort/filter freely.
- The `Proposal` shape is documented in the top-of-file `@typedef`
  with an explicit `_meta` slot reserved for slice 4c/4d to attach
  feasibility scores without changing the public schema.
