# AUTO-5d — Live progress UI + abort

Track 5 slice 5d — surfaces the slice-5c batch pipeline's progress
events as a live footer widget on the preview panel, plus an Abort
button and a post-completion summary banner with a "Retry failed"
hand-off into slice 5e.

## What shipped

- EXTENDED `modules/aircraft-flight-plan/auto-scheduler/preview-panel.js`
  (~+410 LOC): added an `apply` sub-state, five `auto-apply:*` bus
  subscriptions, a complete rewrite of `_renderFooter` to switch
  between live-progress / post-batch-summary / default-tip modes,
  and helpers (`_renderApplyProgress`, `_renderApplyResultBanner`,
  `_liveSecondsPerLeg`, `_abortApply`, `_retryFailed`,
  `_materialiseFailedLegs`, the five `_onApply*` handlers, plus a
  1Hz ticker for smooth elapsed/ETA updates).
- Public surface gained `abortApply()`, `retryFailed()`, and an
  `applyState` getter (defensive copy of `_state.apply`) so the
  diagnostics console can interrogate live progress without poking
  internals.
- HANDOVER.md Track 5 entry expanded with slice 5d.

## Footer states

`_renderFooter` switches on `_state.apply` to pick one of three modes:

1. **In-flight** (`apply.inFlight === true`). Renders
   `_renderApplyProgress`:
   - Top row: `Applying leg X of N…`, last-result symbol (✓/✗/·)
     with hover-title carrying the per-leg error, ok counter
     (green), failed counter (red, only when >0), live ETA on the
     right (`~Xm remaining` / `finalizing…`), and an Abort button
     (crimson).
   - Progress bar: linear-gradient blue, 200ms transition between
     widths so completion ticks feel smooth.
   - Status line: phase label (`Filling form…`, `Tab loaded`, etc.),
     batchId, elapsed time. Phase `error` makes the line red and
     appends the error string.
   - The 1Hz ticker (`_startApplyTicker`) re-renders every second so
     elapsed and ETA advance between leg-done events without
     hand-rolled animations.
2. **Just-finished** (`apply.finishedAt != null`, no longer in flight).
   Renders `_renderApplyResultBanner`:
   - "Done/Aborted/Errored: N ok · M failed · Tm elapsed".
   - "M failed — retry" button (only when `failed > 0`) → calls
     `_retryFailed()`.
   - "Dismiss" button clears the banner and reverts to the default
     tip on next render.
3. **Default**. Existing tip text (preview-only / Apply-all wired /
   build-required hint).

## Live ETA

`_liveSecondsPerLeg()` divides elapsed wall-clock by completed leg
count once the first leg lands, clamped to `[3s, 20s]` so a single
fast/slow leg doesn't wildly skew the projection. Falls back to the
slice-5b `ESTIMATED_SECONDS_PER_LEG = 7` constant before any leg
completes.

## Abort path

`_abortApply()` calls `AesAfpAutoApplyBatch.abort()` which sends the
`aes:afp:apply-batch:abort` runtime message. Background.js sets the
abort flag and closes the hidden tab; the in-flight
`_waitForTabComplete` / `_sendTabMessageWithTimeout` reject promptly.
The `start()` Promise resolves with `aborted: true` shortly after,
firing `auto-apply:done` (which we capture via `_onApplyDone` ↔ flips
`finishedAt` + leaves the result banner in the "Aborted" state).

**No rollback needed**: apply-batch.js writes
`AesAfpActiveDraftStore.appliedLegs[seq]` only on `phase: leg-done`
with `ok: true` — legs that hadn't been confirmed by AS were never
written, so no rollback is necessary on abort. Legs that DID complete
before abort stay marked applied (because they really did POST to
AS).

If the user closes the AFP page tab during a batch, the hidden tab
keeps running in background.js (it's owned by the service worker, not
the page). The progress UI is in-memory only and doesn't survive a
page reload — Phase-1 limitation; persisting the batch state to
`chrome.storage.local` for crash-recovery is a Phase-2 enhancement.

## Retry-failed hand-off

`_retryFailed()`:
1. Pulls failed seqs from `_state.apply.results.filter(!ok)`.
2. Looks up the corresponding flights in `_state.lastBuild.flights`
   so the materialised legs use the latest overlay edits (the user
   may have fixed the offending overlay between batches).
3. If the build no longer contains those seqs (e.g., the user
   re-ran Auto-build week and got a fresh seq numbering), toasts
   "No matching legs in the current Build — re-run Auto-build first."
4. Otherwise emits `auto-apply:retry-requested` on the bus + calls
   `_applyAll(legs, {source: "retry-failed"})` which dispatches
   straight to apply-batch.js (skipping the confirmation modal —
   the user already acknowledged the original batch).

Slice 5e wires the actual audit-log retry queue (per-batch + per-
aircraft rings); 5d's button is the immediate-after-batch path that
keeps the user from having to navigate elsewhere to retry.

## Bus contract

Subscribed events:
- `auto-apply:start    {batchId, total, ctx, legs, startedAt}` →
  reset apply state, render in-flight footer, start ticker.
- `auto-apply:progress {batchId, phase, legIdx?, seq?, ok?, error?}` →
  update counters + last-result on `leg-done`; latch
  `currentLegIdx` on `leg-start`.
- `auto-apply:done     {batchId, ok, results, succeeded, failed,
                        aborted, error, finishedAt}` → flip to
  result-banner mode, refresh the per-leg list (so applied seqs
  show the green tint via the active-draft listener), stop ticker.
- `auto-apply:aborted  {batchId, completed}` → same as done but
  flagged aborted.
- `auto-apply:error    {batchId, error}` → flag error, stop ticker.

All handlers guard on `batchId` mismatch so a stale event from a
previous batch (e.g., progress arriving after a quick start-stop-
start) doesn't corrupt the active state.

## Defensive bail-outs

- `AesAfpAutoApplyBatch` undefined when Abort clicked → toast
  "Apply-batch module not loaded — can't abort." (manifest order
  regression; never expected in production).
- Failed seqs not present in the current build (after a re-run) →
  toast "No matching legs in the current Build — re-run Auto-build
  first."
- Bus events without `batchId` → accepted (legacy / first-batch
  case); only mismatched non-null batchIds are dropped.
- 1Hz ticker self-cleans: if `apply.inFlight` flips to false between
  fires (e.g., race with a `done` event), the next tick stops the
  interval.

## Smoke / verification

Render-only at the JS level. Manual checklist (requires a live AS
session with a populated build + tier gate unlocked, which only the
user can drive):

1. Settings unlocked, Auto-build week → confirmation modal → Apply.
2. Footer flips into the live-progress widget within ~2s
   (`auto-apply:start` fires immediately).
3. Progress bar advances per leg; ETA shrinks; last-result symbol
   alternates ✓/✗ as appropriate.
4. Click Abort mid-batch → background tab closes, footer flips to
   "Aborted: N ok · …" banner with a Retry button if any failed.
5. Click Retry → second batch starts with only the failed legs.
6. Click Dismiss → banner clears.
7. Reload the AFP page mid-batch → progress UI starts blank (Phase-1
   limitation), but background continues; the per-leg list will
   show appliedLegs tints for legs the background completed via the
   active-draft chrome.storage.onChanged listener.

## Known limitations / TODO for slice 5e

- The `_state.apply.results` ring lives in-memory only. Slice 5e
  persists results into `AesAfpAutoApplyLog` (mirrors
  `pricing-apply-log.js`'s dual-store pattern) so the retry queue
  survives reload + a per-aircraft "Recent batches" expander can
  surface them.
- Failed-leg retry today re-runs through the confirmation-modal
  path (`_applyAll` straight, no modal). That's the right default
  for a retry, but a "review failed legs first" mode would be a
  reasonable polish — slice 5e could add it.
- No dedup against repeated abort clicks. The first abort sets the
  flag; subsequent clicks no-op cleanly because background returns
  "no batch in flight" — but the second click's failed call shows
  in the console. Harmless.
- Reload-recovery: the in-flight tab keeps running but the page-
  side UI restarts blank. A `chrome.storage.local` mirror of the
  apply state (cleared on `done`) would let the UI rehydrate after
  reload.
