# Plan — Drag-to-Schedule (Phase 2)

> **Status:** plan only, no code yet.
> **Prerequisite:** Phase 1 wave strip overlay (this slice — `modules/aircraft-flight-plan/wave-strip.js`) is shipped so users have a wave-time canvas to drop onto.

## Goal

Let the user create a flight in one gesture: grab a candidate row in Flight Studio's destination list, drag it onto the wave strip (or, in a stretch slice, the Fleet Schedule Grid), release — the extension fills out the AS New Flight form in the background, validates, and either pre-fills for the user to confirm or auto-submits per the user's confidence setting.

The drop target uses the wave-strip's hour ruler to pick a departure time, then the destination row's metadata (block time, turnaround, restrictions) to derive the round-trip and verify feasibility before writing.

## Success criteria

- Drag a candidate row → a ghost "flight bar" follows the cursor, labelled with the destination IATA and computed round-trip duration.
- Drop on a wave lane → snap to the nearest 5-min slot inside the wave's departure window. Drop outside a wave → snap to the cursor minute.
- A toast / inline preview shows the resolved spec: hub → dest, departure HH:MM, block time, return arrival, turnaround, restrictions warnings (curfew, noise, size mismatch).
- One-click "Create flight" applies the spec via `form-driver.js`. A "Re-edit" button opens the form to the user.
- The candidate row gets a `✓ scheduled` badge after success and is filtered out by "Hide scheduled" on the next recompute.

## Out of scope

- Multi-leg drag (drop two destinations at once to build a back-to-back leg). Adds significant routing complexity; defer to phase 3.
- Drag from Flight Studio onto the **Fleet Schedule Grid** (cross-page DnD). Requires a postMessage bridge or a temporary chrome.storage handoff. Sketched at the bottom but not built.
- Bulk drop (drag a multi-select). Single row per gesture only in v1.

## Architecture

```
                  ┌────────────────────────────────┐
   candidate row ─┤ HTML5 dragstart → dataTransfer │
                  └──────────────┬─────────────────┘
                                 │
                  ┌──────────────▼─────────────────┐
                  │ wave-strip + new drop overlay  │
                  │ shows live ghost + minute hint │
                  └──────────────┬─────────────────┘
                                 │ drop
                  ┌──────────────▼─────────────────┐
                  │ AesAfpScheduleApplyOrchestrator│
                  │  • build FlightSpec            │
                  │  • feasibility check           │
                  │  • pre-fill via form-driver    │
                  │  • toast w/ Confirm | Edit     │
                  └────────────────────────────────┘
```

**New module:** `modules/aircraft-flight-plan/drag-to-schedule.js`
- Wires dragstart on every candidate row (post-`candidates:updated`).
- Renders a transparent drop overlay over the wave strip + (optionally) over the fleet schedule grid panels.
- Emits `dragschedule:dropped {spec, dropTimeMin, waveId}` for the orchestrator.

**New module:** `modules/aircraft-flight-plan/schedule-apply-orchestrator.js`
- Subscribes to `dragschedule:dropped`.
- Builds a `FlightSpec` (reuses `AesAfpLegSpec.createSpec` from flight-studio).
- Calls `RouteAssistantProfitEstimator.estimate()` + the new airport-meta cache for restriction checks.
- Pre-fills via `AesAfpFormDriver.prefill(spec)` (read-only — the driver already enforces no-submit).
- Emits a `dragschedule:preview {spec, validation}` event for the toast.

**Reuse:**
- `modules/aircraft-flight-plan/form-driver.js` — existing pre-fill path (do NOT bypass its no-submit invariant).
- `modules/aircraft-flight-plan/flight-studio/leg-spec.js` — `createSpec` + `normalizeSpec`.
- `modules/route-assistant/wave-overrides-store.js` — if the user drops on a specific wave, persist the (dest → wave) override so the wave-overlay's auto-assign respects the user's choice.
- `modules/aircraft-flight-plan/route-candidates.js` — `_buildRow` candidate already carries `blockMin`, `stationTurnMin`, `nightCurfew`, `noiseRestricted`, `sizeClass`; the orchestrator reads them straight off `candidate:selected`-style payloads.
- `modules/route-assistant/toast-host.js` — toast for the post-drop preview + Confirm CTA.

## Drop-target → minute mapping

The wave strip already lays out `0..24h` across `[LABEL_WIDTH_PX..stripWidth]`. Reuse its `_renderStrip` ctx values (`startMin`, `totalMin`, lane DOM) by exposing a helper:

```js
AesAfpWaveStrip.coordsToMinute(clientX) → int 0..1439 | null
AesAfpWaveStrip.coordsToWave(clientY)   → waveId | null
```

These get added to the wave-strip module without behavior changes — pure read.

## Drag UX

- `mousedown` on a candidate row's drag handle (a small `⋮⋮` glyph in the DEST cell) starts the drag. Don't hijack the row click — keep the existing pre-fill flow on click.
- During drag, render a 1×1 ghost pinned to the cursor:
  - Top: `MIA · 1:42 block · Wave 2` (live).
  - Color: green if no restrictions tripped, amber on size/curfew warning, red on OOR.
- Snap line (1px vertical bar) overlays the wave strip at the snapped minute.
- ESC cancels.

## Feasibility check (before pre-fill)

Hard-block when any of:
- `aircraftFit === "oor"` for the picked spec.
- Drop minute lies inside the destination's `nightCurfew` window (need to add a curfew time-range parser — for v1 skip if `curfewLabel` doesn't include a `HH:MM-HH:MM` pair).
- Round-trip + turnaround would push the return past the next-day same-slot start (uses `range-buckets.js` slot-window math).

Soft-warn (proceed with confirm step) when:
- `noiseRestricted` true.
- Block time + 2× turnaround > 22h (won't repeat next day at same slot).
- Aircraft size class > airport size class (TBD — the size-fit check we deferred from phase 1).

## Confirmation flow

After the orchestrator pre-fills:
1. Toast appears (via `RouteAssistantToastHost.show`) with title "Schedule MIA at 09:00?" and body listing block / return / turnaround / warnings.
2. Buttons: `[ Confirm & Create ]  [ Edit in form ]  [ Cancel ]`.
3. Confirm → `form-driver` clicks Submit (this is the FIRST and ONLY place we'd unlock the no-submit invariant). Add a setting `aircraftFlightPlan.dragSubmitMode` with values `"manual" | "confirmed" | "auto"` so the user opts in.
4. Edit → opens AS's form unchanged; user reviews + submits.
5. On success: emit `schedule:updated` so route-candidates re-recomputes and the row gets the ✓ badge.

## Storage

No new storage keys. The orchestrator reads existing stores; the only write besides AS itself is the optional `routeAssistant:waveOverrides:<HUB>:<presetId>` entry (already plumbed in phase 1 vocabulary).

## Files to touch / add

| Action | Path | Notes |
| --- | --- | --- |
| New | `modules/aircraft-flight-plan/drag-to-schedule.js` | Drag wiring + ghost + drop overlay. ~250 lines. |
| New | `modules/aircraft-flight-plan/schedule-apply-orchestrator.js` | Build spec + feasibility + pre-fill. ~200 lines. |
| Modify | `modules/aircraft-flight-plan/wave-strip.js` | Add `coordsToMinute` / `coordsToWave` exports + drop-zone visual hooks. |
| Modify | `modules/aircraft-flight-plan/route-candidates.js` | Add the `⋮⋮` drag handle to `_renderRow`. |
| Modify | `modules/aircraft-flight-plan/form-driver.js` | Conditional Submit behind explicit user setting. **Audit by user before merge.** |
| Modify | `manifest.json` | Register the two new modules in the AFP family entry. |

## Verification

1. **Drag** an MIA candidate from the table and drop on Wave 1's departure window → toast shows MIA · 09:00 · 1:42 block · same-day return.
2. **Drop outside window** → toast still shows but warns "outside arrival/departure windows — wave compositions ignored".
3. **Drop on OOR row** (drag handle disabled) → drag refuses to start; tooltip explains.
4. **Confirm** → AS form submits; new flight appears in `vfp-reader` output within ~3s; row gets ✓ badge.
5. **Edit** instead → form opens pre-filled; cancel doesn't poison state (form remains AS's normal blank).
6. **ESC mid-drag** → ghost vanishes, no side effects.
7. **Reload** → drag still wired, no orphan ghost listeners.

## Open questions

1. **Auto-submit policy.** Do we ship `dragSubmitMode: "confirmed"` as default (one extra click) or `"auto"` (true one-gesture)? Default `"confirmed"` keeps the safety invariant intact.
2. **Cross-page DnD to the Fleet Schedule Grid.** Worth it? The grid lives on `/app/fleets*`. We'd need a chrome.storage handoff: source tab writes a `dragHandoff:<token>` entry; target tab listens, recreates the ghost, and on its drop emits the same `dragschedule:dropped`. ~3 days of work; worth a separate slice once phase 2's same-page flow is stable.
3. **Bulk drag.** Once single-row works, multi-select with ⌘-click + drag would let the user populate a wave in one motion. Same orchestrator, just iterates.

## Dependencies on already-shipped work

- `airport-meta-scraper.js` (just shipped) — the orchestrator's curfew / noise / size warnings rely on its records.
- `wave-strip.js` (this slice) — the drop target geometry lives here.
- `form-driver.js` — pre-fill path; needs the conditional submit hook.
- `RouteAssistantWaveOverridesStore` (existing) — wave-pin persistence.
