# AUTO-5b — Apply-all CTA + confirmation modal

Track 5 slice 5b — adds the user-facing trigger for the auto-scheduler's
Apply-all flow plus a confirmation modal listing every leg AS will be
POSTed. Slice 5c implements the actual batch pipeline; 5b stops at the
confirmation handoff (`AesAfpAutoApplyBatch.start(payload)` is called
when present, otherwise a "pipeline not loaded" toast surfaces).

## What shipped

- EXTENDED `modules/aircraft-flight-plan/auto-scheduler/preview-panel.js`
  (~+330 LOC) — added the Apply-all button to `_renderCta`, plus a new
  modal builder `_openConfirmModal` + helpers (`_materialiseLegs`,
  `_updateModalCounts`, `_closeConfirmModal`, `_applyAll`, `_toast`,
  `_fmtDuration`).
- Public surface gained `openConfirmModal()` and `applyAll(legs, opts)`
  on `window.AesAfpAutoSchedulerPreview` so the diagnostics console
  (or a future keyboard shortcut) can drive the same flow without DOM
  clicks.
- HANDOVER.md Track 5 entry updated.

## Tier gate

The Apply-all button is rendered always (so users know it exists) but
disabled with an explanatory tooltip unless ALL of:

- `_state.lastBuild` is non-null (auto-build has produced a Build)
- `build.flights.length > 0`
- `_state.settings.autoScheduler.enabled === true`
- `_state.settings.autoScheduler.tier === "apply-on-confirm"`
- `build.flights.length <= autoScheduler.maxLegsPerApply` (default 28)
- The auto-build isn't currently running

Tooltip text on the disabled button names the specific blocker (per
`_applyBlockedReason`); a separate inline hint string under the CTA
points users at the two settings keys to flip when the gate is
dormant. Phase-1 default is `enabled: false, tier: "preview-only"` —
no AS POST possible without explicit user opt-in.

## Modal anatomy

Built imperatively (no jQuery) into `document.body` as a fixed-position
overlay (z 99998):

- **Header** — title `Apply N flights — confirm` + a × close button.
- **Body**:
  - Subtitle line with the up-front estimate
    (`legs.length × ESTIMATED_SECONDS_PER_LEG` formatted via `_fmtDuration`).
  - Per-leg list: alternating-row checkbox row showing index, direction
    (out/in colored), origin → destination, dep time, price %, an
    "edited" tag when a per-leg overlay is applied. Default all
    checked. Toggle updates the live counter + estimate in the
    acknowledgement strong tags.
  - I-understand checkbox: explicit acknowledgement that AS will get
    one POST per checked leg over the projected duration. Required to
    enable the Apply button.
- **Footer** — counter on the left ("X of N selected"), Cancel +
  Apply on the right. Apply turns crimson when armed (matches the CTA
  button) and is disabled (gray) until the ack box is checked AND
  selection > 0.

Esc closes; clicking the dim background closes; the × button closes;
Cancel closes — all routes through `_closeConfirmModal()`. Apply emits
the request to the bus AND calls `AesAfpAutoApplyBatch.start(payload)`
when 5c is loaded; on confirm the modal is removed before dispatch so
the user doesn't see a frozen modal during the (long-running) batch.

## Leg materialisation

`_materialiseLegs(build, draft)` is the canonical adapter from the
Track 3 `Build.flights[]` shape (which carries `depTimeLocal`) to the
`{seq, origin, destination, depTime, pricePct, service, ...}` shape
the existing form-driver pipeline (`AesAfpFormDriver.fill`) consumes.
It also merges `draft.perLegEdits[seq]` overlays so manual edits made
in the per-leg list flow through. Defaults for missing `pricePct` /
`service` come from `_state.settings.defaultPricePct` /
`.defaultService` (the AFP settings block defaults to 100% / `""`).

Slice 5c's `apply-batch.js` consumes this materialised shape directly;
no second adapter pass needed.

## Bus contract

`auto-apply:requested` emitted unconditionally on every Apply click,
even when slice 5c isn't loaded. Payload:

```js
{
    ctx:         {server, aircraftId, currentLocationIata},
    legs:        Leg[],            // materialised
    requestedAt: ms,
    source:      "preview-panel"   // or "confirm-modal" / future call sites
}
```

This gives slice 5e (audit log) a single subscription point that fires
even if the pipeline call itself fails or is short-circuited. Audit
log writes happen on dispatch + per-leg progress + completion, but the
"requested" marker lets us reconstruct intent for orphaned batches.

## Toast plumbing

`_toast(msg, kind)` defends against `RouteAssistantToast` not being
loaded — manifest order should always have toast-host.js before the
auto-scheduler files, but the IIFE-on-load timing isn't guaranteed
until ctx:ready fires. `info|warn|error|success` map to the four
RouteAssistantToast methods when available; falls back to console.warn
otherwise. Shape mirrors the wave-applier defensive call-pattern.

## Defensive bail-outs

- Empty selection → Apply stays disabled (counter shows "0 of N").
- Empty `legs` array → modal doesn't open (`_openConfirmModal` early
  return on length check).
- `RouteAssistantToast` undefined → fallback to console.warn.
- Background pipeline (`AesAfpAutoApplyBatch.start`) throws → caught
  and toasted as "Apply-batch pipeline threw: …" so the user can
  retry. State doesn't get stuck — the modal is already closed by
  the time we dispatch.
- Pipeline absent → toast "Apply-batch pipeline not loaded yet
  (slice 5c)" so the user sees the click landed.

## Estimated batch duration

`ESTIMATED_SECONDS_PER_LEG = 7` is calibrated against the existing
single-leg `_afpRunSubmit` flow in `background.js`: tab-load wait
(~3s typical) + form fill + submit + reload (~3s) + 500ms inter-leg
gap. Slice 5c's progress UI uses live timing once the pipeline runs;
the constant only drives the upfront modal estimate. Visible to the
user in two places (the subtitle line and the I-understand strong
tag) so it's easy to spot if the assumption drifts after 5c lands.

## Smoke / verification

The slice is render-only at the JS level (no AS POST), so manual
verification on a populated aircraft page:

1. Load `/app/fleets/aircraft/<id>/0?aes-debug` with default settings.
   Apply-all button is rendered + disabled with tooltip
   "autoScheduler.enabled === false (default Phase-1 posture)."
2. Run `Auto-build week`. The button stays disabled with the same
   tooltip until the user flips settings.
3. From the diagnostics console:
   ```js
   await AesAfpSettings.save({autoScheduler: {enabled: true, tier: "apply-on-confirm"}})
   AesAfpAutoSchedulerPreview.render()
   ```
   The button turns crimson + enabled.
4. Click → modal appears with one row per leg, all checked.
5. Toggle a leg checkbox → counter updates; ack-text strong-tag
   updates the count + estimate.
6. Tick I-understand → Apply button arms (crimson).
7. Click Apply → modal closes, `auto-apply:requested` fires on the
   bus, a toast surfaces "Apply-batch pipeline not loaded yet
   (slice 5c)" until 5c ships.
8. Esc / × / clicking the dim background each cancel cleanly.

## Known limitations / TODO for next slices

- The modal does not show the would-be POST body per leg (only the
  high-level shape). A "Show what'd post" expander per row would
  mirror the diagnostics overlay's dry-run table — easy to add in
  5c if the user wants it.
- No per-leg dry-run pre-validation (the form-driver's `dryRun`
  function is page-local; the modal is invoked from the AFP page so
  it COULD validate, but only against the currently-rendered form
  state — which only covers ONE leg at a time). Slice 5c batches
  through background.js so per-leg validation can happen there
  inside the hidden tab.
- No "save these defaults" toggle — every modal opens with all legs
  checked. If a user routinely deselects some legs, the audit log
  in 5e will surface that pattern; we can add a memory in a Phase-2
  pass.
- No cooldown tracking — clicking Apply twice in quick succession
  would queue two batches in slice 5c's per-aircraft pipeline. The
  background queue serialises them per `aircraftId`, so they'd run
  one after the other rather than racing, but the user would see
  N2 modals worth of work in flight.
