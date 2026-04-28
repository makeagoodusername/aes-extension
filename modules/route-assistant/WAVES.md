# Wave Subsystem — Module Contract

There are 14 `wave-*.js` files spread across three modules. This is intentional but easy to muddle. This doc pins the boundary so the next refactor doesn't fork the domain model.

## Three concepts, one name

The word "wave" means three different things in the codebase. They compose in a clear order — keep them straight:

| Layer    | Module                | Stored at                                       | Purpose                                   |
| -------- | --------------------- | ----------------------------------------------- | ----------------------------------------- |
| TEMPLATE | `schedule-management` | `SchedulePresets` (chrome.storage)              | Saved wave templates the user reuses      |
| DRAFT    | `route-assistant`    | `wave-draft-store`, `wave-overrides-store`      | Per-route working edits, scoring, fitting |
| APPLY    | `aircraft-flight-plan` | (no store — talks to AS form-driver via bus)   | Per-aircraft submission of a wave plan    |

`fleet-schedule-grid` is a fourth surface — see below.

## Module ownership

### `modules/route-assistant/` owns the wave **domain model**

Domain types, scoring, fitting, backtest, diagnostics, the in-RA editor, the per-route overlay.

- `wave-overlay.js`, `wave-editor.js`, `view-waves.js` — UI
- `wave-route-fitter.js`, `wave-slot-scorer.js` — scoring/fitting
- `wave-plan-backtest.js`, `wave-plan-diagnostics.js` — analysis
- `wave-draft-store.js`, `wave-overrides-store.js` — DRAFT-layer storage

Anything that's a **wave domain type** (slot, fitting result, scored plan) lives here.

### `modules/aircraft-flight-plan/` **wraps** RA for per-aircraft application

- `wave-applier.js` — header line 7: "Wraps RouteAssistantWaveOverlay." Consumes RA's draft + a Schedule preset, produces per-leg "apply" rows that talk to AFP's form-driver.
- `wave-strip.js` — render-only strip on the AFP page.

AFP must not introduce parallel domain types. If the wave shape needs a new field, add it in RA, then read it here.

### `modules/fleet-schedule-grid/` is a **render-only sibling**

FSG overlays `SchedulePresets` (the TEMPLATE layer) on a multi-aircraft grid for visualization. It does **not** read from `wave-draft-store` / `wave-overrides-store` — it consumes templates directly, like RA's editor does.

What FSG legitimately owns:
- `wave-layout-store.js` — **display state only**: per-grid color / opacity / drag-shift. The store's own docstring (lines 5-9) is explicit: "those changes live HERE, not in the saved preset, so experimenting on the grid never mutates the user's wave templates." This is the right shape.
- `overlay-wave-layer.js`, `overlay-wave-picker.js` — render the chosen TEMPLATE on the grid lanes.

What FSG must not do:
- Define wave-domain types (slot, fitting result, scored plan). Use RA's.
- Score, fit, or edit waves. If a grid action needs scoring, call into RA.
- Persist anything that should belong to RA's DRAFT layer or schedule-management's TEMPLATE layer.

## Failure mode to avoid

If a feature lands that needs to "edit" a wave from the FSG surface — even something small like "snap this layer to the nearest aircraft slot" — that's a wave-domain operation. The right move is to call into RA's editor primitives, not to add the operation inline in FSG. The first inline edit makes the second one easier; six months later FSG is a parallel wave editor.

## Read before changing waves

- RA's wave files: 9 files; the model is here.
- AFP's wrap: 2 files; thin adapter.
- FSG: 3 wave files; render + display-state only.

If you find yourself adding a 4th file to FSG with "wave" in the name, stop and check whether the logic belongs in RA.
