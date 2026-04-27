# Flight Studio — bus / storage / message addendum

> Slice-local supplement to the parent `modules/aircraft-flight-plan/EVENTS.md`.
> New events / keys / messages introduced by Track 9 (Flight Studio).
> Folded into the parent doc per slice; this file tracks "what landed
> where" so future slices can audit the Studio's surface area at a glance.
> **Plan of record:** `/Users/jihwan/.claude/plans/be-imaginative-and-innovative-frolicking-matsumoto.md`.

## S1 — bus events

| Event | Emitter | Payload | Notes |
|---|---|---|---|
| `studio:opened` | `flight-studio/panel.js:open()` | `{trigger: "menu" \| "vfp-edit" \| "candidate" \| "deeplink"}` | Audit-log-eligible. Currently no subscriber (audit-log integration lands when Slice S5 adds `studio.flight-applied` ACTION_LABELS). |
| `studio:draft-changed` | `flight-studio/panel.js:_flushSave()` | `{spec: FlightSpec}` | Debounced 300ms. Storage write happens **before** the emit. |
| `studio:dry-run-rendered` | `flight-studio/panel.js:_runPreview()` | `{spec, dryRun: {url, body, missed}}` | `dryRun` is the return value of `AesAfpFormDriver.dryRun()` verbatim. |

## S1 — storage keys

| Key | Owner | Shape |
|---|---|---|
| `aircraftFlightPlan:studioDraft:<server>:<aircraftId>` | `flight-studio/draft-store.js` | `{server, aircraftId, spec: FlightSpec \| null, history: FlightSpec[] (capped 10), createdAt, updatedAt}` |

`spec` follows the canonical `FlightSpec` shape from `flight-studio/leg-spec.js`. The `history` ring buffer drives the panel's Undo CTA (no redo yet — S2+).

## S1 — runtime messages

None. S1 ships pure in-page (panel + dry-run via form-driver). Cross-tab orchestration messages land in S5 (`aes:afp:studio:apply-batch`, `aes:afp:capture-flight-numbers`, `aes:afp:studio:open`).

## Note: AESMenu integration dropped

The plan called for a `menu-extension.js` injecting "Flight Studio…" into `AESMenu`. It shipped briefly and was removed when the user pointed out the panel auto-mounts on every AFP page via `ctx:ready`, making the menu entry redundant on the AFP page and useless elsewhere (the `studio` slot only exists on `/0`). The `panel.js#open()` API survives for programmatic callers (S6 VFP overlay, future deep-links).

## Future slices (placeholder — for handover continuity)

- **S2** — pre-fill mode wires through `form-driver-x.js`; emits `studio:pre-fill-applied {spec, set, missed}`. Adds DOM selectors for `+ Add via`, flight-number text input, aircraft-settings nickname/note.
- **S3** — paste-import via `paste-import.js`. No new events.
- **S4** — templates store: `aircraftFlightPlan:studioTemplates:<server>:<airlineCode>`. Emits `studio:template-saved`, `studio:template-instantiated`.
- **S5** — submit pipeline + flight-number registry. Emits `studio:apply-requested`, `studio:applied`, `studio:flight-captured`. New runtime messages `aes:afp:studio:apply-batch`, `aes:afp:capture-flight-numbers`, `aes:afp:studio:open`. New store `aircraftFlightPlan:flightNumberRegistry:<server>:<airlineCode>`. New audit `ACTION_LABELS`: `studio.flight-applied`, `studio.flight-captured`.
- **S6** — VFP overlay actions. Emits `studio:vfp-edit-requested`, `studio:vfp-delete-requested`. Audit label `studio.vfp-deleted`.
