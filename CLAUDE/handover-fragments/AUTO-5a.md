# AUTO-5a — Auto-scheduler preview panel render

Track 5 of the AES Auto-Scheduler plan — the user-facing surface that
consumes Track 3's `Build` output and (eventually, in slices 5b-5e)
commits it through the existing background-tab fillAndSubmit pipeline.
Slice 5a only — render. Slices 5b/5c/5d/5e add Apply-all CTA, batch
pipeline, live progress UI, and audit log respectively.

## What shipped

- NEW `modules/aircraft-flight-plan/auto-scheduler/preview-panel.js`
  (~570 LOC). Vanilla IIFE attaching `window.AesAfpAutoSchedulerPreview`.
  Mirrors the style of sibling AFP modules: `"use strict"`, top-of-file
  JSDoc, idempotent singleton guard, defensive `typeof` guards on every
  cross-module dependency, `console.warn("[AES auto-5a]", …)` on bail.
- EDIT `modules/aircraft-flight-plan/host.js` — added `"auto-preview"` to
  `WIDE_SLOT_NAMES` between `"tools"` and `"candidates"`. The new slot
  becomes the most prominent surface in the wide host (right under the
  toolbar), visually replacing the role of AS's "Assign a new flight"
  form for users who opt into the auto-scheduler.
- EDIT `manifest.json` — registered `preview-panel.js` in the
  `/app/fleets/aircraft/*/0*` block AFTER the four auto-scheduler files
  (`grid-state.js`, `objective.js`, `allocator.js`, `slot-optimizer.js`)
  it depends on, BEFORE `wave-applier.js` + `content_aircraftFlightPlan.js`.

## Public API (this slice)

```js
AesAfpAutoSchedulerPreview.render()         // re-render from current state
AesAfpAutoSchedulerPreview.runAutoBuild()   // call AesAfpAutoScheduler.run + persist
AesAfpAutoSchedulerPreview.lastBuild        // diagnostic accessor (Build | null)
```

Slices 5b-5e will append additional handles (`openConfirmModal`,
`applyAll`, `abortBatch`, `retryFailed`) onto the same singleton.

## Render structure

The panel mounts into `AesAfp.slot("auto-preview")` and renders a
six-section root:

1. **Heading strip** — "Auto-build (preview)" + subtitle hint.
2. **Summary cells** — Legs, Weekly hours (vs. ceiling), Total Score,
   Maintenance forecast (Track 2's `forecastRatio7d`, color-coded
   <100% red / <105% amber / ≥105% green), and Built-when.
3. **CTA row** — primary "Auto-build week" / "Re-run auto-build" button
   (gated on `ctxReady && spec && candidatesLen > 0`) + a tier-status
   hint string when `autoScheduler.tier !== "apply-on-confirm"` or
   `autoScheduler.enabled !== true`.
4. **Status line** — error / running / validation messages (hidden when
   nothing to say).
5. **Gantt preview** — delegates to `RouteAssistantWaveOverlay.renderGantt`
   exactly like wave-applier does, so the visual shape is identical and
   we benefit for free from any future renderer improvements (connection
   overlay, warnings panel, unplaced strip, etc.).
6. **Per-leg overlay list** — one row per `build.flights[]`, with an
   inline editor that mutates `AesAfpActiveDraftStore.perLegEdits[seq]`
   via `setEdit(server, aircraftId, seq, patch)`. Edited rows render
   with an amber background tint + an "edited" tag + a Reset button
   that clears that seq's overlay.
7. **Footer hint** — explains the preview-only tier and points at the
   settings switch slice 5b will gate.

## Edit overlay invariants

- Per-leg edits ALWAYS round-trip through `AesAfpActiveDraftStore.setEdit`
  — never mutated locally first. This keeps the Fleet Hub overlay
  in sync via `chrome.storage.onChanged` (the same listener wave-applier
  uses).
- Origin/Destination inputs are validated as 3-letter uppercase IATA;
  invalid values flag the input red without writing.
- Time inputs accept `H:MM` or `HH:MM`; invalid values flag red.
- Price % accepts 1..500; outside that range flags red.
- Service is a free-text string up to 64 chars (matches AS's option-value
  shape).
- Empty value = clear that field from the overlay (writes `null`).

## State + bus wiring

```
ctx:ready              → load settings + draft + budget; renderRoot;
                          attach storage listener
spec:resolved          → store spec; recompute budget; partial repaint
candidates:updated     → update candidatesLen; re-enable Build button
auto-schedule:built    → adopt build payload; reload draft; partial repaint
maintenance:scraped    → recompute budget; partial repaint
wear:updated           → recompute budget; partial repaint
```

Storage events: a `chrome.storage.onChanged` listener watches
`aircraftFlightPlan:draft:<server>:<aircraftId>` (200ms-debounced) so
edits made on a sibling Fleet Hub overlay tab repaint the panel.

## Tier gate posture

Slice 5a is render-only — `runAutoBuild()` calls Track 3's allocator
which is itself a pure compute (no AS POST). The "Apply all" surface is
built in slice 5b and gated behind:

```
settings.aircraftFlightPlan.autoScheduler.enabled === true
  && settings.aircraftFlightPlan.autoScheduler.tier === "apply-on-confirm"
```

Default settings (`settings-extension.js:_defaults`) ship with
`enabled: false, tier: "preview-only"` — the user has to opt in
explicitly per the plan's tier-gate paragraph. The CTA row + footer
both surface this state to the user.

## Defensive bail-outs

- `RouteAssistantWaveOverlay` undefined → empty preview slot with a
  manifest-order warning instead of throw.
- `AesAfpAutoScheduler` undefined → "AesAfpAutoScheduler not loaded"
  status; no run attempted.
- `AesAfpActiveDraftStore` undefined → edit / persistence calls no-op
  cleanly.
- `AesAfpMaintenanceBudget` undefined → "Maint —" cell, no forecast.
- `AesAfpSettings` undefined → tier checks fall through to "disabled"
  posture (safest default).
- Slot not present in DOM → `_renderRoot` bails silently. The
  MutationObserver in host.js will re-mount the slot on Wicket
  re-renders; our `auto-schedule:built` listener triggers a render
  on next event arrival.

## Smoke tests (`?aes-debug` console)

Three assertions inside the IIFE, run only when the URL has `?aes-debug`:
public surface exposed (`render`, `runAutoBuild`), `_ago` formats a
30-second delta into "30s ago". Intentionally minimal — the heavy
lifting is delegated to Track 3 (which has its own smoke), and the UI
itself is verified by the manual checklist in slice 5e once the full
pipeline lands.

## Known limitations / TODO for later slices

- "Projected revenue" on the summary strip currently shows
  `metadata.totalScore` (Track 3's objective sum) instead of an AS$
  estimate. The objective unit is demand-weighted seats × pricePct,
  not a money figure — slice 5b can compute a rough revenue from
  `seats × pricePct × demand_normalisation` if we want a money cell,
  but for now Score is the load-bearing comparison number.
- The edit overlay does NOT currently re-run the allocator when a leg
  is edited — overlays are a presentation/persistence layer only. If
  the user wants edits to feed back into Track 3's scoring, that's a
  Phase-2 enhancement (would require `AesAfpAutoScheduler.run` to
  accept `{seedFlights}`).
- "Apply all" CTA is just a placeholder hint string this slice. Slice
  5b will replace it with a real button that opens the confirmation
  modal.
- Aborted / failed legs from a future batch run aren't surfaced yet —
  slice 5e adds the audit log + retry queue UI.
