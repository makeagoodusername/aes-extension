# AFP coordination layer — bus events, storage keys, runtime messages

> Track 8 slice 8a. Canonical map of every event/key/message that wires
> the Aircraft Flight Plan (AFP) module to its tab-mates and to the
> background service worker. Source: grep over `modules/aircraft-flight-plan/`,
> sibling modules that subscribe (`fleet-hub`, `route-assistant`,
> `schedule-management`, `aircraft-flight-plan-dashboard`,
> `aircraft-flights`), and `background.js`.
>
> Three channels:
>
> 1. **`AesAfp.bus`** — same-tab in-memory pub/sub. Created in
>    `host.js:59` (`createBus()`); attached as `window.AesAfp.bus`.
>    No payload validation; emit and on are best-effort, handler
>    exceptions are caught.
> 2. **`chrome.storage.onChanged`** — cross-tab fan-out. Use the
>    per-store `<Store>.watch(cb)` helpers (8a) instead of subscribing
>    raw — the helpers parse `<server>:<aircraftId>` out of the key
>    and filter by PREFIX so consumers don't repeat that boilerplate.
> 3. **`chrome.runtime.sendMessage`** — content ↔ background. All AFP
>    messages are namespaced `aes:afp:*`. The background service worker
>    handles them in `background.js`.

## 1 — `AesAfp.bus` events

Lifecycle order (one mount):

```
ctx:ready  →  spec:resolved     ─┐
           →  schedule:updated  ─┤→ candidates:updated
           →  maintenance:scraped┤
                                 └→ wear:updated
```

User actions:

```
candidate:selected → form:filled   (or form:cleared)
wave:built         → leg:applied   (per leg the user applies)
auto-apply:requested → auto-apply:start → auto-apply:progress* → auto-apply:done|aborted|error
auto-delete:start    → auto-delete:progress* → auto-delete:done|aborted|error
```

| Event | Emitted by (file:line) | Payload | Notes |
|---|---|---|---|
| `ctx:ready` | `host.js:624`, `host.js:900` | `{ctx: PageContext}` | Fires on first mount **and** every Wicket re-mount. PageContext = `{server, aircraftId, airlineCode, registration, currentLocationIata, currentLocationName, currentLocationAirportId}`. Subscribers must re-read `AesAfp.ctx` at handler call time — the closure-captured ctx may be stale across re-mounts. |
| `spec:resolved` | `spec-resolver.js:89` | `{spec: Spec \| null}` | `Spec = {typeId, typeName, seats, cargoCapacity, cruiseSpeedKmh, range, paxSatisfaction, source}`. `null` payload when resolution failed all sources. |
| `schedule:updated` | `schedule-broadcaster.js:90` | `{schedule, server, aircraftId, scrapedAt}` | Re-fired by `schedule-broadcaster.js` whenever the VFP read produces a content-changed Schedule. Cross-tab consumers should prefer `AesAfpScheduleStore.watch()` instead. |
| `maintenance:scraped` | `maintenance-scraper.js:131` | `{record}` | `record = {ratio, condition, ratioStatus, conditionStatus, scrapedAt}`. Fires after every `maintenance-scraper` run. |
| `wear:updated` | `wear-model.js:216` | `{sample}` | Sample = trailing-7-day weekly block hours + maintenance ratio sample. Fires when either input changes. |
| `candidates:updated` | `route-candidates.js:176` | `{candidates: Candidate[]}` | After scoring + sorting; payload reflects the visible-list ordering. |
| `candidate:selected` | `route-candidates.js:411`, `wave-applier.js:176`, `diagnostics.js:287` | `{candidate, source}` | `source` ∈ `"row-click" \| "wave-leg" \| "memo-replay"`. `form-driver` listens and fills the AS form. |
| `candidate:dismissed` | (defensive subscription in `audit-log.js:403`) | `{candidate, source}` | Fired on row-dismiss CTA. Currently only audit-log subscribes. |
| `form:filled` | `form-driver.js:439–440` | `{leg, source}` | `leg = {origin, destination, depTime, pricePct, service}`. Means the AS form has been pre-filled — user still clicks AS's own Submit button (HANDOVER §10 invariant: AFP NEVER auto-submits). |
| `form:cleared` | `form-driver.js` (clear button) | (no payload) | Triggered by the form-driver toolbar Clear CTA. |
| `wave:built` | `wave-applier.js:461` | `{build}` | `Build` = `{flights[], warnings[], connections[], unplaced[], hub}`. |
| `preset:selected` | (defensive subscription in `audit-log.js:414`) | `{presetId}` | Reserved — emitter not currently wired (audit-log listens for forward compatibility). |
| `leg:applied` | (defensive subscription in `audit-log.js:420`) | `{leg \| candidate}` | Reserved — single-leg apply path. Bulk apply uses `auto-apply:*` instead. |
| `audit:logged` | `audit-log.js:353` | `{record}` | After every successful `AesAfpAuditLog.add()`. |
| `auto-schedule:built` | `auto-scheduler/allocator.js:566` | `{build}` | Allocator's grid + balancer pass produced a Build. Parallel to `wave:built` for the auto-scheduler track. |
| `auto-apply:requested` | `auto-scheduler/preview-panel.js:1439` | `{...}` | Preview-panel asks the orchestrator to start. |
| `auto-apply:retry-requested` | `auto-scheduler/preview-panel.js:906`, `:1103` | `{...}` | Preview-panel retry CTA. |
| `auto-apply:start` | `auto-scheduler/apply-batch.js:290` | `{batchId, total, ctx, legs, startedAt}` | Orchestrator confirms it's about to send the first leg. |
| `auto-apply:progress` | `auto-scheduler/apply-batch.js:187` | `{batchId, phase, legIdx, seq, ok, error?}` | Forwarded from `chrome.runtime.onMessage("aes:afp:apply-batch:progress")`. |
| `auto-apply:done` | `auto-scheduler/apply-batch.js:336` | `{batchId, ok, results, succeeded, failed, finishedAt}` | Batch ran to completion (no abort, no fatal error). |
| `auto-apply:aborted` | `auto-scheduler/apply-batch.js:336` | `{batchId, completed}` | User-cancelled or rate-limit-aborted. |
| `auto-apply:error` | `auto-scheduler/apply-batch.js:228, 235, 248, 255, 325` | `{batchId?, error}` | Fatal — no further legs will be attempted. |
| `auto-delete:start` | `auto-scheduler/flight-deleter.js:224` | `{batchId, flightIds, ctx, startedAt}` | Mirror of `auto-apply:start` for the delete pipeline. |
| `auto-delete:progress` | `auto-scheduler/flight-deleter.js:145` | (forwarded) | Mirror of `auto-apply:progress`. |
| `auto-delete:done` | `auto-scheduler/flight-deleter.js:265` | `{batchId, ok, results, succeeded, failed, finishedAt}` | |
| `auto-delete:aborted` | `auto-scheduler/flight-deleter.js:265, 326` | `{batchId, completed}` | |
| `auto-delete:error` | `auto-scheduler/flight-deleter.js:168, 173, 186, 192, 255, 300` | `{batchId?, error}` | |
| `studio:opened` | `flight-studio/panel.js:open()` | `{trigger: "menu" \| "vfp-edit" \| "candidate" \| "deeplink"}` | Flight Studio panel was programmatically opened (Slice S1). `trigger` records the entry path so the audit log can attribute the session. |
| `studio:draft-changed` | `flight-studio/panel.js:_flushSave()` | `{spec}` | Debounced 300ms after the user mutates the in-flight draft. Persisted to `aircraftFlightPlan:studioDraft:<server>:<aircraftId>` before the event fires (Slice S1). |
| `studio:dry-run-rendered` | `flight-studio/panel.js:_runPreview()` | `{spec, dryRun}` | The mini-Gantt + would-be POST body has been rendered. `dryRun` is `AesAfpFormDriver.dryRun()`'s return value (Slice S1). |

### Diagnostics

`diagnostics.js:84-89` wraps `bus.emit` to log every emit + payload to a
ring buffer. Open the AFP page, run `AesAfp.diagnostics.recent()` in the
DevTools console to see the last N events — useful for verifying a slice
emits what its docs say it does.

## 2 — `chrome.storage.local` keys

All AFP keys are under the `aircraftFlightPlan:` prefix (HANDOVER §10
invariant: do not reuse `routeAssistant:` for AFP state — Fleet Hub
reads AFP keys without RA loaded).

| Key shape | Stored value | Owner / single-writer | Subscribe via |
|---|---|---|---|
| `aircraftFlightPlan:schedule:<server>:<aircraftId>` | `Schedule` (legs[], blocks[], planningMatrix, summary, schemaVersion=1, scrapedAt) | `schedule-broadcaster.js` (only) | `AesAfpScheduleStore.watch(cb)` → `{server, aircraftId, schedule, oldSchedule}` |
| `aircraftFlightPlan:draft:<server>:<aircraftId>` | `{flights[], presetId, generatedAt, perLegEdits, appliedLegs, dismissedLegs, hub, createdAt, updatedAt}` | `wave-applier.js` + Fleet Hub overlay (bi-directional) | `AesAfpActiveDraftStore.watch(cb)` → `{server, aircraftId, draft, oldDraft}` |
| `aircraftFlightPlan:state:<server>:<aircraftId>` | `{draftedPlan[], dismissedCandidates[], selectedPresetId, lastFilledAt, currentLocationIata, currentLocationName, currentLocationAirportId, lastSeenAt, ...}` | `host.js` (`persistLocation`) + `route-candidates.js` (dismissals) + `form-driver.js` (lastFilledAt) | `AesAfpStateStore.watch(cb)` → `{server, aircraftId, state, oldState}` |
| `aircraftFlightPlan:flightLog:<server>:<aircraftId>` | `{flights[] (newest-first, capped 200), scrapedAt}` | `flight-log-scraper.js` (`/1` tab) | `AesAfpFlightLogStore.watch(cb)` → `{server, aircraftId, log, oldLog}` |
| `aircraftFlightPlan:maintenance:<server>:<aircraftId>` | `{ratio, condition, ratioStatus, conditionStatus, scrapedAt}` | `maintenance-scraper.js` (both `/0` and `/1`) | `AesAfpMaintenanceStore.watch(cb)` → `{server, aircraftId, maintenance, oldMaintenance}` |
| `aircraftFlightPlan:auditLog:<server>:<aircraftId>` | `{server, aircraftId, entries[] (newest-first, capped 50), updatedAt}` | `audit-log.js` (`AesAfpAuditLog.add`) | `AesAfpAuditLog.watch(cb)` → `{scope: "aircraft", server, aircraftId, record, oldRecord}` |
| `aircraftFlightPlan:auditLog` (global) | `{entries[] (newest-first, capped 200), updatedAt}` | `audit-log.js` (same `add`) | `AesAfpAuditLog.watch(cb)` → `{scope: "global", record, oldRecord}` |
| `aircraftFlightPlan:studioDraft:<server>:<aircraftId>` | `{server, aircraftId, spec: FlightSpec \| null, history: FlightSpec[] (capped 10, newest-first), createdAt, updatedAt}` | `flight-studio/draft-store.js` (single writer; `flight-studio/panel.js` is the only caller) | `AesAfpStudioDraftStore.watch(cb)` → `{server, aircraftId, draft, oldDraft}` |

### Wave-applier no-op semantics

Three stores (`schedule-store`, `maintenance-store`, `audit-log`) implement
content-equality short-circuits in `save()` so a Wicket re-render that
re-fires `ctx:ready` doesn't spam `chrome.storage.onChanged`. When you add
a new consumer via `.watch()`, expect events at most once per real change
— not once per scrape.

## 3 — `chrome.runtime.sendMessage` types

All AFP runtime messages are namespaced `aes:afp:*`. The background
service worker (`background.js`) is the receiver for the orchestration
calls; the content scripts are receivers for the per-tab fill/delete
broadcasts.

### Content → background

| Message type | Sender | Receiver | Purpose |
|---|---|---|---|
| `aes:afp:submit-leg` | `submit-bridge.js:52` | `background.js:661` | Fleet Hub overlay's single-leg apply. Background opens hidden tab → fills form → returns `{ok, error?, flightNumber?}`. |
| `aes:afp:apply-batch` | `auto-scheduler/apply-batch.js:316` | `background.js:676` | Bulk apply orchestrator. Background streams progress via `aes:afp:apply-batch:progress`. |
| `aes:afp:apply-batch:abort` | `auto-scheduler/apply-batch.js:394` | `background.js:707` | User-cancel. |
| `aes:afp:delete-batch` | `auto-scheduler/flight-deleter.js:246` | `background.js:691` | Bulk delete via hidden-tab form posts (uses `content_flightNumbers.js`). |
| `aes:afp:delete-batch:abort` | `auto-scheduler/flight-deleter.js:320` | `background.js:707` | |

### Background → content

| Message type | Sender | Receiver | Purpose |
|---|---|---|---|
| `aes:afp:fill-and-submit` | `background.js:281, 420` | `content_aircraftFlightPlan.js` (hidden tab) | Background asks the AFP content script to fill + submit one leg's form. Used by both single-leg and apply-batch flows. |
| `aes:afp:delete-flight-form` | `background.js:608` | `content_flightNumbers.js` (hidden tab on `/app/com/numbers/<flightId>`) | Background asks the flight-numbers tab to click Delete. |
| `aes:afp:apply-batch:progress` | `background.js:370` | `auto-scheduler/apply-batch.js` (origin tab listener) | Per-leg progress broadcast. |
| `aes:afp:delete-batch:progress` | `background.js:535` | `auto-scheduler/flight-deleter.js` (origin tab listener) | Per-flight delete progress. |

### Hidden-tab pipeline shape

```
preview-panel  ─[apply-batch]→  background  ─[fill-and-submit]→  hidden AFP tab
                                            ←[result]──────────
                       ←[apply-batch:progress, looping]──────
                       ←[apply-batch:done | :aborted | :error]
```

Background.js is the single arbiter; both content scripts (the origin
tab and the hidden tab) only see one direction of traffic each. This
keeps abort handling clean — abort signals always go origin → bg →
hidden, never sideways.

## 4 — Subscriber index (who reads what)

Mostly historical; consumers should migrate to `<Store>.watch()` per 8a.

| Subscriber (file:line) | Channel | What it watches |
|---|---|---|
| `route-candidates.js:717-722` | bus | `spec:resolved`, `ctx:ready`, `schedule:updated` |
| `route-candidates.js:731-738` | storage.onChanged (raw) | `aircraftFlightPlan:schedule:*` |
| `wave-applier.js:906-908` | bus | `ctx:ready`, `spec:resolved`, `candidates:updated` |
| `wave-applier.js:897` | storage.onChanged (raw) | `aircraftFlightPlan:draft:*` |
| `auto-scheduler/preview-panel.js:1752-1766` | bus | `ctx:ready`, `spec:resolved`, `candidates:updated`, `auto-schedule:built`, `maintenance:scraped`, `wear:updated`, `schedule:updated`, `auto-apply:start \| progress \| done \| aborted \| error` |
| `audit-log.js:360-433` | bus | `candidate:selected`, `form:filled`, `form:cleared`, `wave:built`, `candidate:dismissed`, `preset:selected`, `leg:applied`, `ctx:ready` |
| `maintenance-widget.js:259-262` | bus | `ctx:ready`, `maintenance:scraped`, `wear:updated`, `spec:resolved` |
| `maintenance-widget.js:264` | storage.onChanged (raw) | `aircraftFlightPlan:maintenance:*` |
| `wear-model.js:282` | storage.onChanged (raw) | `aircraftFlightPlan:flightLog:*`, `aircraftFlightPlan:maintenance:*` |
| `form-driver.js:605-606` | bus | `ctx:ready`, `candidate:selected` |
| `spec-resolver.js:276` | bus | `ctx:ready` |
| `schedule-broadcaster.js:117` | bus | `ctx:ready` |
| `host.js:714` | bus | `candidates:updated` (re-renders Stations button) |
| `maintenance-scraper.js:178` | bus | `ctx:ready` |
| `diagnostics.js:115-122` | bus | `candidate:selected`, `form:filled`, `form:cleared` |
| `fleet-hub/host.js:159` | storage.onChanged (raw) | AFP keys (cross-tab updates) |
| `aircraft-flight-plan-dashboard/host.js:42, 52` | storage.onChanged (raw) | `aircraftFlightPlan:schedule:*` |
| `aircraft-flights/scheduled-decorator.js:138` | storage.onChanged (raw) | `aircraftFlightPlan:schedule:*` |
| `schedule-management/schedule-panel.js:104, 109, 742` | storage.onChanged (raw) | AFP draft + schedule keys |
| `route-assistant/panel.js:252` | storage.onChanged (raw) | RA keys (not AFP) |

## 5 — How to add a new event/key/message

- **New bus event:** emit via `AesAfp.bus.emit(name, payload)`. Append a row to §1 with file:line + payload shape. If audit-log should track it, add a `bus.on(name, ...)` handler in `audit-log.js` and an entry in `ACTION_LABELS`.
- **New per-aircraft store:** prefix the key with `aircraftFlightPlan:<area>:` and follow the existing class shape (`PREFIX`, `_key`, `load`, `save`, `watch`). Single-writer convention — name the writer in §2. Don't reuse `routeAssistant:`.
- **New runtime message:** namespace it `aes:afp:*`. Add a handler in `background.js`. Append to §3 with sender + receiver file:line.

## See also

- `SELECTORS.md` — DOM contract this module reads/writes against.
- `HANDOVER.md` §10 — invariants (no auto-submit, prefix isolation, slice isolation, read-only-against-ScheduleStore).
- Plan: `/Users/jihwan/.claude/plans/quiet-snuggling-widget.md` — Track 8 slice plan.
