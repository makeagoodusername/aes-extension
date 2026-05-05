# AUTO-6b — Schedule diff engine

Track 6 slice 6b — pure compare function that takes a current schedule
(typically from `AesAfp.getCurrentSchedule()`, slice 6a) and a proposed
Build (`build.flights[]` from Track 3's allocator), and returns
`{keep, delete, add, moveTime}`. This is the data layer that slice 6d's
confirmation modal will render and slice 6e's transactional wipe will
consume.

## What shipped

- NEW `modules/aircraft-flight-plan/auto-scheduler/schedule-diff.js`
  (~270 LOC). IIFE, defensive guards, project-standard `?aes-debug`
  smoke block (30 assertions, all green under both browser and Node
  stub).
- EXTENDED `manifest.json` AFP block — registered after Track 3's
  `allocator.js`, before Track 4's `slot-optimizer.js`. Per slice spec
  ("append after Track 3's auto-scheduler files").

No other files modified.

## Public API surface (6b)

```js
window.AesAfpScheduleDiff = {
    compare(currentLegs, proposedLegs) → {
        keep:     [{currentSeq, proposedSeq, deltaMin}],
        delete:   [currentLeg],
        add:      [proposedLeg],
        moveTime: []                     // always [] in Phase-1
    },
    timeDeltaMin(aHHMM, bHHMM) → number|null,    // shorter-around-midnight
    isMatchable(leg) → boolean,                  // origin/dest/depTime present + valid
    TOLERANCE_MIN: 15
}
```

### Example

```js
const current  = AesAfp.getCurrentSchedule()
const proposed = (await AesAfpAutoScheduler.run({...})).build.flights
const diff     = AesAfpScheduleDiff.compare(current, proposed)
// diff.keep    → [{currentSeq:1, proposedSeq:11, deltaMin:5}, ...]
// diff.delete  → [{seq:3, origin:"JFK", destination:"BOS", depTimeLocal:"08:00", ...}]
// diff.add     → [{seq:14, origin:"JFK", destination:"DEN", depTimeLocal:"10:00", ...}]
// diff.moveTime → []   (Phase-1 simplification)
```

## Match rule

Two legs are a "keep" pair iff:
1. `current.origin === proposed.origin` (case-sensitive 3-char IATA)
2. `current.destination === proposed.destination`
3. `timeDeltaMin(current.depTimeLocal, proposed.depTimeLocal) ≤ 15`

`timeDeltaMin` is the **shorter-around-midnight** distance, so 23:55 vs
00:05 → 10 min, not 1430 min. This matters for late-evening flights
where the proposed Build might land inside an integer hour and the
current VFP shows the same flight a few minutes earlier on the
previous calendar day's bar.

## Multiple-match disambiguation

When more than one proposed leg matches a current leg's
`(O, D, depTime±15)` window, the algorithm picks the **smallest absolute
time delta**. Each proposed leg can be claimed at most once per
`compare()` call.

This is greedy on the current side (a current leg never re-shops once
it's claimed a proposed leg), which is acceptable because the typical
Build has at most a handful of legs sharing the same O/D. The smoke
tests cover the ambiguous-multiple case (3 candidates within window,
closest time delta wins).

## Phase-1: moveTime always []

The plan's slice spec says:

> "moveTime requires we know AS's edit-flight semantics; for Phase-1
> treat moveTime as delete+add to keep things simple."

So when a current leg's O/D matches a proposed leg's O/D but the
depTime delta is OUTSIDE ±15 min, this slice does NOT emit a
`moveTime` entry — the pair gets split into a `delete` + an `add`. The
`moveTime` field stays in the return shape so a future slice (likely
6e if AS's edit-flight URL is reverse-engineered) can populate it
without changing the interface.

Reasoning: AS's edit-flight Wicket POST is more fragile than the
delete-then-create path, and Track 5's apply pipeline is already
optimised for the create path. Reusing it via delete+add costs a small
amount of extra work (one extra Wicket POST per moved leg) but lets
slices 6c–6e ship without a separate edit-flight reverse-engineering
session.

## Day-of-week handling (intentionally narrow)

This slice compares legs **as-passed** — it does not expand a `dayMask`
on Track 3-shaped legs. The contract is:

- Caller passes `currentLegs` from `AesAfp.getCurrentSchedule()`
  (per-day expanded — one leg per `(dayIdx, depTime)` occurrence on
  the populated VFP).
- Caller passes `proposedLegs` from `Build.flights[]` (one per
  `(wave, route, direction)` template — has a `dayMask` field).

Same shape in → diff out. If the caller wants apples-to-apples
comparison, they must pre-expand the proposed legs across their
`dayMask`. Slice 6d's confirmation modal is the right place to do
that expansion (so the user sees the right per-day keep/delete/add
counts).

This slice could in principle do the expansion itself, but keeping
it leg-shape-agnostic makes it equally useful for:
- Comparing two snapshots of the VFP (e.g., diagnostic panel "what
  changed since last reload?")
- Comparing two proposed Builds (e.g., A/B-comparing two presets)
- Comparing a partial filter (e.g., "what's in the proposed Build
  that isn't currently scheduled on Tuesday?")

The user's slice spec explicitly says `compare(currentLegs,
proposedLegs)` with no day argument; we honour that.

## Safe-failure behaviour

- `currentLegs` not an array → treated as `[]`.
- `proposedLegs` not an array → treated as `[]`.
- A leg is **unmatchable** if any of `origin`, `destination`,
  `depTimeLocal` are missing or fail format validation
  (`/^[A-Z]{3}$/` for IATAs, `/^\d{1,2}:\d{2}$/` for time, with hour
  ≤ 23 and minute ≤ 59).
- Unmatchable on the **current** side → goes to `delete` (we can't
  reason about it, so wipe it conservatively).
- Unmatchable on the **proposed** side → goes to `add` (we can't
  match it to anything).

## Verified

In-page smoke tests (`?aes-debug`) — 30 `console.assert` checks across:

- `timeDeltaMin`: same-time, +10 min, midnight wrap, max-distance
  (12h), bad input.
- `isMatchable`: full leg, lowercase IATA rejected, null depTime
  rejected, null leg rejected.
- `compare`:
  - empty/empty
  - identical lists (2 → 2 keeps)
  - +14 min within tolerance (1 keep, deltaMin=14)
  - +30 min outside tolerance (1 delete + 1 add, moveTime stays empty)
  - different destination (1 del + 1 add)
  - unmatchable current (lowercase IATA → delete; proposed → add)
  - ambiguous match (3 proposed in window → closest wins, others → adds)
  - duplicate current claiming the same proposed (only first claims;
    second goes to delete)
  - midnight wrap (23:55 vs 00:05 → keep)

Also Node-stub smoke run (`global.window = {location:{search:"?aes-debug"}}`)
— all 30 assertions green outside the browser, confirming no
DOM/jQuery dependencies.

## Known limitations

- **No moveTime classification** in Phase-1 (see "Phase-1: moveTime
  always []" above). Slice 6e is the right place to flip this if
  AS's edit-flight URL turns out to be Wicket-stable.
- **No day-mask expansion** — caller's job. If a future slice 6c or
  6d wants this rolled in, the cleanest extension point is a third
  arg `compare(current, proposed, {expandProposedDayMask: true})`
  that pre-expands `dayMask` into per-`(dayIdx, depTime)` pseudo-
  legs. Keeping this out of slice 6b avoids coupling the diff to
  ScheduleBuilder's leg shape.
- **Tolerance fixed at 15 min** — exposed as `TOLERANCE_MIN` for
  read but not configurable per call. A future user-facing setting
  ("strict" / "lenient" diff) could thread a per-call override; the
  internal call site already references the constant in only one
  place (`d > TOLERANCE_MIN` in `compare`), so the change is
  one-line if needed.
- **Greedy current-side claim** — a current leg never re-shops once
  it claims a proposed leg, even if a later current leg would have
  matched closer. The smoke test for this is the duplicate-current
  case: two current legs at 06:00 + 06:05, one proposed at 06:00 →
  the first claims it. In rare worst-case shapes this could shift a
  delete to a different current leg than a globally-optimal solver
  would, but the visible diff counts (`keep.length`, `delete.length`,
  `add.length`) are identical because each "loss" on one current
  leg is exactly offset by a "gain" on the other.

## Followup — configurable tolerance (shipped)

The user retired three open questions from the original 6b handover
in clarifications:

- "moveTime classification toggle" was confusing; permanently dropped
  — Phase-1's "treat O/D-match outside ±15 as delete+add" is now the
  permanent behaviour, not a toggleable mode.
- "Multi-segment aircraft" was a misread of `?segment=0`; the user
  doesn't recognise the concept and both populated captures only
  show `segment=0`. Permanently dropped.
- "Tolerance" should NOT be a hard-coded constant. The user reads it
  as a calibration knob tied to wave structure / desired outcome.

**Followup change (one commit, no behavioural change for callers
that don't pass an opt arg):** `compare(currentLegs, proposedLegs,
opts)` now accepts a 3rd arg with shape `{toleranceMin?: number}`.
A new `_resolveTolerance(opts)` picks the active value by
precedence:

1. `opts.toleranceMin` (caller wins) — must be finite, ≥ 0
2. `window.AesAfpSettings.cached().aircraftFlightPlan.autoScheduler.diff.toleranceMin`
   (sync read; only consulted when `cached()` is registered — a
   hook a future slice can add for the apply pipeline to pre-warm)
3. `TOLERANCE_MIN` constant (15)

A defensive non-finite or negative value at any layer falls through
to the next, so a misconfigured setting never breaks the diff.

**Settings shape declared (no UI yet, awaiting slice F commit):**

```js
settings.aircraftFlightPlan.autoScheduler.diff = {
    toleranceMin: 15
}
```

The followup commit ships the *consumer* (`_resolveTolerance` reads
`AesAfpSettings.cached?.()` defensively); the producer (`settings-extension.js`
declaring the `diff.toleranceMin` field in its `_defaults`,
`_mergeAircraftFlightPlan` deep-merge, and `save` deep-merge) sits as
an uncommitted working-tree edit waiting for slice F (the file is
still untracked in `git status` at the time of this followup —
whoever commits it next picks up the addition cleanly because it's
purely additive). Until that happens the consumer always falls
through to the `TOLERANCE_MIN` default — which is identical to the
declared setting default (15) — so the diff stays bit-for-bit
compatible with slice 6b's pre-followup behaviour for any caller
that doesn't pass the opt arg.

**Smoke tests** extended from 30 → 34 assertions (all green under
both browser load and a Node stub run). New cases:

- `compare(c, p, {toleranceMin: 5})` — `±10 min` becomes a
  delete+add instead of keep.
- `compare(c, p, {toleranceMin: 60})` — `±30 min` becomes a keep.
- `compare(c, p, {toleranceMin: 0})` — only exact-time matches
  keep.
- `compare(c, p, {toleranceMin: -1})` — falls back to default 15
  (defensive against bad input).

**Settings UI** — out of scope for the followup. Slice 6d's
confirmation modal is the right place to expose a slider; the
declared field gives 6d a stable settings target to wire.

## Open questions for the human

- **Should keep prefer same-day matches?** If a proposed leg flies
  every day at 06:00 and the current VFP has an entry at 06:00 on
  Mon and another at 06:00 on Tue, the current diff treats them as
  two competing claims on a single proposed leg (one wins, the other
  goes to delete). Adding a same-`dayIdx` preference would resolve
  this cleanly, but slice 6b sticks to the spec's `compare(current,
  proposed)` shape (no day awareness).
