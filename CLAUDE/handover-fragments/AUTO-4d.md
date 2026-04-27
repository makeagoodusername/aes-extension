# AUTO-4d — Scoring + selection

Track 4 slice 4d — runs Track 3's allocator against each surviving
proposal and picks the highest-scoring winner. Builds on 4c. Slice 4e
ties the full pipeline together and saves the winner as a real preset.

## What shipped

- EXTENDED `modules/aircraft-flight-plan/auto-scheduler/slot-optimizer.js`
  (~+125 LOC) — added `selectBest()` + the temp-preset round-trip
  helper.
- `?aes-debug` smoke tests extended with bail-path assertions only
  (the happy path is verified through slice 4e's `optimize()` call
  against the live page; 4d's per-proposal allocator runs require
  `chrome.storage.local`, `SchedulePresets`, and the Track 3 module
  graph all mounted).
- HANDOVER.md Track 4 entry updated.

## Public API surface (this slice)

```js
SlotOptimizer.selectBest(proposals, {candidates, spec, basePreset, afpCtx, budget?})
  → Promise<{winner: Proposal|null, winnerRun: object|null,
             runs: Array<{proposal, build, totalScore, error?}>}>
```

- `proposals` — output of slice 4c (cap-safe; 4d hard-clips to 16).
- `candidates`, `spec` — slice C records + Track B aircraft spec,
  passed straight through to `AesAfpAutoScheduler.run`.
- `basePreset` — used to compose synthetic presets (`_composeSynthPreset`
  from 4c).
- `afpCtx` — `AesAfp.ctx` snapshot; supplies `aircraftId`.
- `budget` — pass-through to the allocator. **Null is OK**: Track 3's
  allocator already calls `_fallbackBudget(settings)` when `o.budget`
  is missing, so we don't need Track 2's `MaintenanceBudget` to be
  ready before 4d ships.

## How it scores

For each surviving proposal:

1. Compose a synthetic preset via `_composeSynthPreset(basePreset,
   proposal.waves)`; name it `__aes-auto-tmp-<source>-<ts>`.
2. `SchedulePresets.create(synth)` — saves the temp preset to
   `chrome.storage.local`.
3. `AesAfpAutoScheduler.run({presetId: tmp.id, candidates, spec,
   budget, persist: false})` — runs Track 3's full greedy + swap pass.
4. Read `build.metadata.totalScore` (sum of placement scores from
   Track 3's objective function).
5. `SchedulePresets.remove(tmp.id)` in `finally` — cleanup whether
   step 3 throws or succeeds.

After all proposals run, sort descending by `totalScore` with
deterministic tie-breakers: `_meta.feasibilityScore` (lower wins),
then proposal source enum order (shift > split > merge). Winner is
the first sorted element when its score is finite; otherwise null.

### Why the temp-preset round-trip?

Track 3's allocator (`allocator.js:71-74`) resolves the preset via
`SchedulePresets.load()` keyed by `o.presetId`. There is **no**
direct `preset` override hook. The cleanest options were:

- (a) Add a `preset` arg to allocator. Touches Track 3's file
  (read-only per coordination protocol).
- (b) Monkey-patch `SchedulePresets.load` for the duration. Breaks
  invariants; risk of leaking state.
- (c) Persist a temp preset, run, remove it.

Picked (c). The trade-off is brief storage churn — at most 12
create+remove pairs per `optimize()` call (after the worst-quartile
cull), each bounded by the IIFE's try/finally so a thrown allocator
can't leak orphans.

The picker dropdown (slice 4e) filters out names starting with
`__aes-auto-tmp-`, so even if a temp does leak (e.g. tab killed
mid-run), users never see the orphan in their preset list. A
future slice could add a startup sweep for cleanup.

## Tie-breakers

When two proposals score identically:

1. **Lower `_meta.feasibilityScore` wins** — fewer warnings is
   always preferable.
2. **Source enum order**: shift (0) > split (1) > merge (2).
   Reflects the plan's "minimal disturbance" preference: shifts
   move ONE wave by ±2h; splits/merges are bigger structural
   changes the user might not want even when they score equally.

## Defensive bail-outs

- Empty `proposals` → `{winner: null, winnerRun: null, runs: []}`.
- `AesAfpAutoScheduler.run` undefined (Track 3 not mounted) →
  warn-and-bail.
- `SchedulePresets.create`/`.remove` undefined (presets-store not
  mounted) → warn-and-bail.
- All proposals returned `-Infinity` score (every allocator run
  threw) → null winner, but `runs` populated so the caller can
  inspect the errors.
- `tmp.id` missing from `SchedulePresets.create` return → record
  as an error in `runs[]`, skip the allocator call entirely.

## Known limitations / TODO for slice 4e

- No parallelism — runs are sequential. With <12 proposals and
  Track 3's allocator typically completing in ~50ms each, total
  search time is well under 1s; not worth a `Promise.all` until
  benchmarking says otherwise.
- The temp preset survives between `create` and `remove` for
  ~50ms per proposal; during that brief window other tabs'
  `chrome.storage.onChanged` listeners will see the temp records
  (if any). Slice 4e's picker filter handles this for the AFP
  page itself; cross-tab consumers are responsibility of
  whichever consumer actually subscribes (none today).
- `winnerRun.build` carries the full Build (flights + warnings +
  metadata). Slice 4e reads `winnerRun.build.preset.waves` to
  copy the wave list onto the saved tweaked preset.

## Verified outside the browser

`?aes-debug` smoke tests cover the empty-input bail-out and
function-existence assertions. Per-proposal happy-path is verified
end-to-end through slice 4e's `optimize()` flow on the live page.
