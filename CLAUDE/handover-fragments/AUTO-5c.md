# AUTO-5c — Batch fillAndSubmit pipeline

Track 5 slice 5c — extends `background.js` with a per-aircraft batch
submit pipeline that opens ONE hidden tab, iterates through the batched
legs, and broadcasts progress back to the originating tab. Adds a
content-side bridge module (`apply-batch.js`) that the preview panel's
slice-5b confirmation modal calls into.

## What shipped

- EXTENDED `background.js` (~+170 LOC):
  - Three new constants (`AFP_BATCH_FILL_TIMEOUT_MS = 30000`,
    `AFP_BATCH_RELOAD_TIMEOUT_MS = 30000`,
    `AFP_BATCH_INTER_LEG_DELAY_MS = 500`,
    `AFP_BATCH_TOTAL_TIMEOUT_MS = 20 * 60 * 1000`).
  - `_afpBatchState` map keyed by `batchId` for abort plumbing.
  - `_afpRunBatchSubmit(req, sender)` — the core batch driver. Opens a
    hidden tab, waits for initial load, then iterates legs serially.
    Per-leg: send `aes:afp:fill-and-submit` with the leg + a `_batch`
    metadata bag, wait for the AS reload, broadcast progress, sleep
    `AFP_BATCH_INTER_LEG_DELAY_MS` (skipped after the last leg).
  - `_afpEnqueueBatch` — same per-aircraft serialisation as
    `_afpEnqueueSubmit` so a batch can't race a single-leg Apply on
    the same aircraft.
  - `_afpBroadcastBatchProgress` — chrome.tabs.sendMessage to the
    originating tab when known, else chrome.runtime.sendMessage. Both
    swallow `lastError` (a navigated/closed origin tab is OK; the
    batch keeps running in its own hidden tab).
  - `_afpNewBatchId` — `batch-<base36-ms>-<base36-rand4>` shape.
  - Two new chrome.runtime.onMessage handlers:
    - `aes:afp:apply-batch` — entry point; enqueues + responds with
      the final outcome.
    - `aes:afp:apply-batch:abort` — sets the abort flag AND closes the
      hidden tab so the in-flight `_waitForTabComplete` /
      `_sendTabMessageWithTimeout` reject promptly.
- NEW `modules/aircraft-flight-plan/auto-scheduler/apply-batch.js`
  (~330 LOC). Vanilla IIFE attaching `window.AesAfpAutoApplyBatch`:
  - `start(payload)` — defensive tier-gate re-check via
    `AesAfpSettings.load()` (slice 5b's gate is the load-bearing one;
    this is a backstop). Resets state, attaches the progress listener
    BEFORE dispatch, emits `auto-apply:start` on the bus, sends
    `aes:afp:apply-batch` to background, returns a Promise resolving on
    completion.
  - `abort()` — sends `aes:afp:apply-batch:abort`, sets local
    `aborted = true`, emits `auto-apply:aborted`. Background closes
    the tab; the `start()` Promise resolves shortly after with
    `{aborted: true}`.
  - `state` getter — returns a defensive copy of the live state for
    slice 5d's progress UI to poll.
  - Per-leg success mirrored into `AesAfpActiveDraftStore.appliedLegs`
    via `setApplied(server, aircraftId, seq, ts)` so the Fleet Hub
    overlay tab repaints applied legs in green within ~200ms.
  - `?aes-debug` smoke covers public surface, initial state, and the
    empty-legs bail.
- EXTENDED `modules/aircraft-flight-plan/form-driver.js` (~+25 LOC):
  - `fillAndSubmit(leg)` accepts `leg._batch = {idx, total, batchId,
    aircraftId}` metadata; surfaces it via `_diag("batch-leg", …)` so
    the diagnostics overlay shows "batch leg N of M…" while a batch
    runs.
  - Defensive: a top-level `{batch: [legs]}` shape on `fillAndSubmit`
    is rejected with a clear error pointing the caller at the
    `aes:afp:apply-batch` background message. The page reloads between
    legs so the form-driver instance can't carry state between them —
    batching MUST live in background.js.
- EDIT `manifest.json`: registered `apply-batch.js` AFTER the four
  auto-scheduler files it doesn't depend on but BEFORE `preview-panel.js`
  so `window.AesAfpAutoApplyBatch` exists by the time the preview
  panel's slice-5b modal would call into it.

## Background pipeline shape

```
┌────────────────┐  aes:afp:apply-batch     ┌─────────────────────────┐
│ AFP page       │ ───────────────────────► │ background.js           │
│ apply-batch.js │                          │ _afpEnqueueBatch        │
│ start(payload) │                          │  └─ _afpRunBatchSubmit  │
└────────────────┘                          │      ┌─ open hidden tab │
       ▲                                    │      ├─ wait for load   │
       │ aes:afp:apply-batch:progress       │      ├─ for each leg:   │
       │   (one per phase + one per leg)    │      │   ├─ send fill   │
       └────────────────────────────────────│      │   ├─ wait reload │
                                            │      │   ├─ broadcast   │
                                            │      │   └─ sleep 500ms │
                                            │      └─ close tab       │
                                            └─────────────────────────┘
```

Per-aircraft serialisation reuses the existing `_afpSubmitQueues` map,
so a single-leg Apply (Fleet Hub overlay) and a batch Apply on the
same aircraft can't race; whichever arrives second waits for the
first to settle.

## Progress message phases

`aes:afp:apply-batch:progress` carries `{batchId, aircraftId, total,
phase, legIdx?, seq?, ok?, error?, results?, ...}`:

- `queued` — request enqueued (may wait if another batch/single-leg
  on the same aircraft is in flight)
- `tab-opened` — hidden tab created, includes `tabId`
- `tab-loaded` — tab finished initial load
- `leg-start` — about to send `aes:afp:fill-and-submit` for leg N
- `leg-done` — leg N settled with `{ok, error?}`
- `aborted` — abort flag tripped between legs (no further leg-starts
  emitted; carries `completed` count)
- `timeout` — total wall-clock cap (20 min) hit
- `done` — batch finished naturally; carries final `results[]`
- `error` — batch errored before completion; carries `error` + partial
  `results[]`

Slice 5d consumes these for the live progress UI; slice 5e logs each
to the audit log.

## Tab recovery on reload timeout

If the AS reload after a leg's submit times out (`reload timeout: …`),
the batch:
1. Records the leg as failed.
2. Closes the (possibly wedged) hidden tab.
3. Recreates a fresh hidden tab.
4. Waits for initial load.
5. Continues to the next leg.

This stops a single bad leg from poisoning the rest of the batch.
Bad case: tab recreate ALSO fails (network down) → emit `phase: error`
with `tab recreate failed: …` and abort the batch cleanly.

## Tier gate posture

- `start(payload)` calls `AesAfpSettings.load()` and re-checks
  `enabled === true && tier === "apply-on-confirm"` AND
  `legs.length <= maxLegsPerApply`. Returns `{ok: false, skipped: true,
  error: "..."}` if any check fails.
- The preview panel (slice 5b) is the load-bearing gate; this re-check
  guards against the diagnostics console calling `start()` while the
  user toggled the gate off mid-flight.
- Background.js itself does NOT check the tier gate — once the
  `aes:afp:apply-batch` message arrives there, the work proceeds.
  This keeps the tier-gate logic in one place (the content side) and
  means a future "schedule a batch from cron" use case wouldn't need
  the gate.

## Defensive bail-outs

- Empty `legs[]` → background returns `{ok: true, results: [],
  emptyBatch: true}` immediately + emits `phase: done` so the UI
  closes cleanly.
- `chrome.tabs.create` throws → batch returns `{ok: false, error: ...}`
  before opening a tab.
- `_sendTabMessageWithTimeout` rejects (per-leg fill timeout) → leg
  recorded as failed, batch continues.
- `_waitForTabComplete` rejects (reload timeout) → leg failed + tab
  recreate (described above).
- Abort with no in-flight batch → background returns `{ok: false,
  error: "no batch in flight with id ..."}`. Content side's `abort()`
  returns `false` if local `_state.batchId` is null.
- Double `start()` → returns `{ok: false, error: "batch already in
  flight"}` without firing.
- Sender tab navigates away (closes origin tab) → progress messages
  are silently dropped (`lastError` swallowed); batch still completes
  in its own hidden tab. Slice 5d's reconciliation reads the
  `appliedLegs` field on next mount.

## Smoke / verification

`?aes-debug` smoke (4 assertions): `start` + `abort` exposed,
`state.inFlight === false` initial, empty-legs `start` rejects.

End-to-end verification requires an aircraft + populated build +
unlocked tier gate; covered by slice 5d's manual checklist + the
final Track-5 verification pass:

1. Settings unlocked (`enabled=true`, `tier=apply-on-confirm`).
2. Auto-build week.
3. Click "Apply all N flights" → confirm modal → tick I-understand →
   Apply.
4. Hidden tab opens; DevTools Network tab shows one POST per leg
   with `aes:afp:apply-batch:progress` runtime messages flowing back
   to the AFP page. Slice 5d's UI shows the progress bar advancing.
5. Close the AFP page tab mid-batch → background completes anyway
   (visible in `chrome://extensions` service worker console).

## Known limitations / TODO for next slices

- Slice 5d adds the live progress UI + abort button (we expose the
  `auto-apply:start/progress/done/aborted/error` events; this slice
  doesn't render them).
- Slice 5e adds the audit log entry per leg + retry queue surfaced as
  `<N> legs failed — retry?` CTA. The hooks are in place: every
  `phase: leg-done` carries `{ok, error}` so 5e can write one ring
  entry per result.
- No retry-on-rate-limit. AS occasionally returns Wicket session
  errors when posts come too quickly; slice 5d's abort path is the
  user's escape valve, but a polite back-off-and-retry per leg would
  be a Phase-2 enhancement.
- The 500ms inter-leg delay is a constant; it could become adaptive
  (longer after a reload that took >5s, shorter when AS is responsive)
  but that's optimisation territory.
- Tab recreation on reload timeout discards the post (the leg is
  marked failed). A more aggressive recovery would re-fetch the
  flight numbers list and check whether the post actually landed
  before retrying — out of scope for Phase-1.
