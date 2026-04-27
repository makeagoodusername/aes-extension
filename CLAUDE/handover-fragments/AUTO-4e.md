# AUTO-4e — Save tweaked variant + full pipeline entry point

Track 4 slice 4e — closes the slot optimizer. Wires demandProfile (4a)
→ proposeAdjustments (4b) → filterFeasible (4c) → selectBest (4d)
into a single `SlotOptimizer.optimize()` entry point and saves the
winner as a real preset under `SchedulePresets`. Marks the saved
record with three provenance fields and surfaces a 🔧 glyph in the
existing preset picker dropdown.

## What shipped

- EXTENDED `modules/aircraft-flight-plan/auto-scheduler/slot-optimizer.js`
  (~+200 LOC) — added `optimize()` plus an async smoke test for the
  tier-gate path.
- EXTENDED `modules/schedule-management/presets-store.js` (~+45 LOC)
  — added `SchedulePresets.createTweaked({base, waves, tweakedFor})`
  that piggybacks on `create()` (no fork in the CRUD path), stamps
  `tweakedFrom` / `tweakedAt` / `tweakedFor` provenance fields onto
  the new record, and deep-clones `base.factors` so a future tweak
  doesn't mutate the source.
- EXTENDED `modules/aircraft-flight-plan/wave-applier.js` — surgical
  4-line patch in `_renderToolbar`: prepend `🔧 ` to dropdown entries
  whose record carries a `tweakedFrom` field, AND filter out names
  starting with `__aes-auto-tmp-` (the slice-4d scratch presets so
  orphans from a crashed run never reach the user).
- HANDOVER.md Track 4 entry updated; this fragment.

## Public API surface (4e)

```js
SlotOptimizer.optimize({aircraftId, presetId, candidates?, spec?, ctx?, budget?})
  → Promise<{
      savedPresetId: string|null,
      beforeWaves:   Wave[],
      afterWaves:    Wave[]|null,
      scoreDelta:    number|null,         // winner − baseline
      baselineScore: number|null,
      winnerScore:   number|null,
      proposalSource: "shift"|"split"|"merge"|null,
      proposalDelta:  string|null,
      runs?:         Array<{...}>,
      skipped?:      true,                // tier gate / dependency bail
      reason?:       string               // present when skipped
    }>

SchedulePresets.createTweaked({base, waves, tweakedFor, nameSuffix?})
  → Promise<Preset>     // new record with tweakedFrom/tweakedAt/tweakedFor
```

## Tier gate

`optimize()` is dormant unless
`settings.aircraftFlightPlan.autoScheduler.enabled === true`. When
disabled (Phase-1 ships disabled per the plan's tier-gate matrix),
returns `{skipped: true, reason: "autoScheduler disabled", ...}`
without reaching the allocator. The other helpers (`demandProfile`,
`proposeAdjustments`, `filterFeasible`, `selectBest`) remain callable
from the diagnostics console while disabled — they're pure / read-only.

## Pipeline order

1. **Tier gate check** — bail to `{skipped: true}` if disabled.
2. **Dependency check** — bail if `SchedulePresets` or
   `AesAfpAutoScheduler` aren't mounted.
3. **Resolve aircraft** — from `args.aircraftId` or `AesAfp.ctx`.
4. **Resolve base preset** — `args.presetId` →
   `settings.lastSelectedPresetId` → `presets.defaultPresetId` →
   `presets.list[0]`.
5. **Resolve candidates + spec** — from `args` or
   `AesAfpRouteCandidates.last` / `AesAfpSpecResolver.last`.
6. **Run 4a → 4b → 4c**.
7. **Score the BASELINE** — call `selectBest([{noopProposal}], ...)`
   so we get an apples-to-apples score for the *untouched* wave
   list. The temp-preset round-trip is identical for the noop, so
   the cost is one extra allocator run (#allocator runs = N + 1,
   where N ≤ 12).
8. **Run 4d** against the feasible survivors.
9. **Save winner** via `SchedulePresets.createTweaked(...)`.
10. **Return** the before/after waves, scoreDelta, savedPresetId.

If any step has nothing to work with (no candidates, no proposals,
no feasible survivors, no winner), return `{skipped: true, reason}`
WITH `beforeWaves` populated where possible so the caller can still
render "we couldn't find a better option" in the UI.

## Picker dropdown integration

`wave-applier.js:_renderToolbar` (around line 247) now does two
things differently when iterating the visible preset list:

```js
if (p.name && p.name.indexOf("__aes-auto-tmp-") === 0) continue
const tweakedGlyph = p.tweakedFrom ? "🔧 " : ""
const o = _opt(p.id, tweakedGlyph + (p.name || "(unnamed)") + ...)
```

- Skip transient temp presets (defensive — slice 4d's try/finally
  removes them, but a tab killed mid-run leaves orphans).
- Prepend the wrench glyph to any record carrying `tweakedFrom`
  so the user can tell at a glance which presets were auto-derived.

The `_visiblePresets(hub)` filter already in place handles the
hub-only chip; this patch is upstream of that and additive.

## Provenance fields on the saved preset

```
tweakedFrom: <base preset id>     // string
tweakedAt:   Date.now()           // ms epoch
tweakedFor:  <aircraftId>         // string (server-scoped at the call site)
```

Plain user-created presets leave all three undefined; existing CRUD
helpers (`update`, `remove`, `duplicate`) round-trip them
transparently because they live in the same plain-object record.

`createTweaked`'s name suffix defaults to ` · auto-tweaked`;
callers can override via `nameSuffix` if they're saving from a
different code path.

## Verified

Two Node stub runs:

1. **Tier gate** — three calls confirmed:
   - No `AesAfpSettings` available → `skipped: "autoScheduler disabled"`.
   - `enabled: false` → same.
   - `enabled: true` but no `SchedulePresets` → `skipped:
     "SchedulePresets unavailable"`.
2. **createTweaked round-trip** — confirmed the saved record carries
   `tweakedFrom` (matches base id), numeric `tweakedAt`, string
   `tweakedFor`, hub copied from base, name `<base> · auto-tweaked`,
   appears in the post-save `load()` list.

`?aes-debug` smoke tests assert the tier-gate posture.

## Production verification (per the plan's slice-4e spec)

> "With a deliberately-mistuned preset (e.g., MCO waves at 03:00 and
> 14:00), call `SlotOptimizer.optimize(...)` from console and check
> that the saved variant has waves nearer 09:00 and 17:00 (matching
> FlightsFrom MCO peak hours)."

This requires the live AFP page on `/app/fleets/aircraft/<id>/0`
with FlightsFromStore data cached for MCO + the autoScheduler
tier toggled on (via the diagnostics console:
`await AesAfpSettings.save({autoScheduler: {enabled: true}})`).
Then:

```js
await SlotOptimizer.optimize({
    aircraftId: "<live id>",
    presetId:   "<id of preset whose waves are at 03:00 and 14:00>"
})
```

Expected `result.afterWaves` should report a wave whose departure
window centre falls within the 09:00–10:00 or 17:00–18:00 window.
The `result.scoreDelta` should be positive (winner > baseline).
Open the preset picker — the new entry shows as
`🔧 <name> · auto-tweaked · MCO`.

I did not run this against the live page from this session (the
plan's verification language is "the agent's verification + open
questions for the human to resolve"). Live-page verification is
listed under the open questions at the end of this fragment.

## Known limitations

- The baseline score is computed via a noop proposal that goes
  through the same temp-preset round-trip. This means an extra
  `SchedulePresets.create + remove` per `optimize()` call, plus an
  extra allocator run. Cost is ~50ms; well within budget. Could
  be optimised by adding a `preset` arg to Track 3's allocator
  (which would mean editing a Track-3-owned file — declined per
  the coordination protocol).
- `optimize()` doesn't dedupe re-runs against the same base preset
  + aircraft — calling it 3 times yields 3 saved variants. A
  future slice could check for existing
  `tweakedFrom === base.id && tweakedFor === aircraftId` and update
  in place.
- The tier-gate posture lets `optimize()` produce a saved variant
  without a confirmation modal. Slice 5b ("Apply all CTA + confirmation
  modal" on Track 5) is the right place to add a "save tweaked
  preset?" pre-confirmation when wired to a button. Phase-1 ships
  this surface as console-only; the gate is `enabled: false` by
  default so users can't accidentally pile up tweaked variants
  unless they've explicitly toggled the optimizer on.

## Open questions for the human

- **Live verification with a real MCO/A320 mistuned preset** —
  blocked on access to the live page. The expected wave-shift
  behaviour (toward 09:00 / 17:00) presupposes FlightsFromStore
  data on MCO + a candidate set that drives the demand profile.
  Without per-route hour buckets in the scrape (slice 4a TODO),
  the histogram is flat and slice 4b's shift heuristic only fires
  on relative `weeklyFlights` gaps. With a flat profile,
  `_nearestPeakHour` falls back to `Math.round(fromHour) % 24`
  (essentially "stay put"). **Practically**: until FlightsFrom
  scrape exposes per-route frequency, slice 4b's shift heuristic
  won't produce visibly-different proposals.
- **Should the picker filter `__aes-auto-tmp-` for the hub-filter
  variant?** The current implementation filters them in
  `_renderToolbar` after `_visiblePresets(hub)` returns — i.e.
  the hub filter sees them but the dropdown doesn't render them.
  This is the correct order (filter first by hub, drop temps
  second), but if a future PR moves the temp filter into
  `_visiblePresets`, the hub-filter will pre-strip them too.
  Both behaviours are arguably correct; the current placement is
  the conservative pick.
- **Idempotency on re-run** — see "Known limitations" above.
  Should `optimize()` update an existing tweaked preset for the
  same `(base, aircraft)` pair instead of stacking? My instinct is
  yes; the right place is in `createTweaked` itself (look up by
  `tweakedFrom + tweakedFor`, fall through to update or create).
  Defer until Track 5 ships and we see how the user expects this
  to behave.
