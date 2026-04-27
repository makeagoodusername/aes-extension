# AUTO-5e — Audit log + retry queue

Track 5 slice 5e — final slice. Persists every batch lifecycle event +
per-leg outcome to a dual-store ring buffer (mirrors
`pricing-apply-log.js`); surfaces unresolved failed legs from the
latest batch as a "<N> legs failed — retry?" CTA on the preview panel
that survives page reload.

Also fixes a manifest regression: Track 6's slice 6b commit dropped
`apply-batch.js` from the AFP content-script block when adding
`schedule-diff.js`; this slice restores it (and adds the new
`auto-apply-log.js` ahead of `apply-batch.js`).

## What shipped

- NEW `modules/aircraft-flight-plan/auto-scheduler/auto-apply-log.js`
  (~260 LOC). `class AesAfpAutoApplyLogClass` exported as singleton
  `window.AesAfpAutoApplyLog`. Same convention as `audit-log.js`'s
  per-AFP-aircraft store. Dual-store ring buffer:
  - Global timeline `aircraftFlightPlan:autoApplyLog` (cap 200).
  - Per-aircraft ring `aircraftFlightPlan:autoApplyLog:<server>:<aircraftId>`
    (cap 80 ≈ three batches of 28 legs apiece).
  - Single `chrome.storage.local.set` write per `add(record)` keeps
    the two stores in sync (same single-writer invariant as
    `audit-log.js` per HANDOVER §10).
  - Statuses: `queued | started | ok | failed | aborted | done | error
    | queue-dismissed`.
  - `_cleanRecord` normalises IATAs to uppercase, clamps strings,
    drops nulls — keeps storage small and the entry shape stable.

- NEW APIs:
  - `add(record)` — atomic dual-store write.
  - `getRecent(n)` — global timeline newest-first.
  - `getForAircraft(server, aircraftId, n)` — per-aircraft ring.
  - `getRetryQueue(server, aircraftId)` → `{batchId, legs, dismissed?}`
    Failed entries from the LATEST batch on this aircraft, with three
    exclusions:
    - Failed seqs that have a later "ok" entry anywhere in the ring
      (succeeded on a retry batch OR via a manual single-leg apply
      elsewhere).
    - All entries when the latest batch carries a `queue-dismissed`
      marker (user clicked Dismiss; underlying entries stay in the
      ring for audit history).
    - Duplicate seqs within the same batch (a leg might fail twice
      under retry-on-recreate; we surface the most recent failure
      only).
  - `dismissRetryQueue(server, aircraftId)` — stamps a
    `queue-dismissed` marker for the latest batch. Idempotent
    (`getRetryQueue` returns `dismissed: true` if already dismissed
    — `dismissRetryQueue` short-circuits in that case).
  - `clear()` — wipes both stores; returns count removed.

- EXTENDED `apply-batch.js` (~+90 LOC): every bus emit pairs with a
  `_logEntry(...)` write. Lifecycle entries (`started`, `done`,
  `aborted`, `error`) carry batch-level metadata (`total`, `succeeded`,
  `failed`, `elapsedMs`, `error`); per-leg entries (`ok`, `failed`)
  enrich from `_state.legs[legIdx]` so the audit row carries
  `origin`, `dest`, `depTime`, `pricePct`, `service`, `direction`,
  `waveLabel` even after the batch state is reset. Defensive — log
  `add` failures are caught + warned but never block the pipeline.
  New `_legMetaForIdx(legIdx, seq)` helper resolves leg metadata by
  index with a seq-based fallback.

- EXTENDED `preview-panel.js` (~+125 LOC): added a `retryQueue`
  sub-state, `_loadRetryQueue` (called on `ctx:ready`, after every
  `auto-apply:done`, and after `_dismissPersistedQueue`),
  `_renderPersistedRetryBanner` (red-tinted banner with `Retry N` +
  `Dismiss` buttons), `_retryPersistedQueue` (materialises queue
  entries back into the form-driver leg shape and dispatches via
  `_applyAll(legs, {source: "retry-persisted"})` — no confirmation
  modal, this IS the retry), `_dismissPersistedQueue` (calls
  `AesAfpAutoApplyLog.dismissRetryQueue` then re-renders).
  `_renderFooter` switches between in-flight / just-finished /
  persisted-retry / default-tip modes — the persisted retry banner
  takes precedence over the default tip but yields to in-flight or
  just-finished.

- EDIT `manifest.json`: registered `auto-apply-log.js` BEFORE
  `apply-batch.js` (which depends on it), AFTER `slot-optimizer.js`
  + Track 6's `schedule-diff.js`. Restored `apply-batch.js` to the
  manifest — it was dropped by Track 6's slice 6b commit.

## Retry-queue lifecycle

```
batch starts
  ├─ apply-batch.js writes  status: "started"  to log
  ├─ per leg:
  │    ├─ on leg-done {ok}      → status: "ok"
  │    └─ on leg-done {!ok}     → status: "failed" (with error)
  └─ on settle:
       ├─ done                  → status: "done"
       ├─ aborted               → status: "aborted"
       └─ error                 → status: "error"

preview-panel mounts
  ├─ _loadRetryQueue(server, aircraftId)
  ├─ AesAfpAutoApplyLog.getRetryQueue(...)
  │    └─ returns {batchId, legs} for failed seqs from latest batch
  └─ _renderFooter
       └─ _renderPersistedRetryBanner if legs.length > 0

user clicks Retry N
  ├─ _retryPersistedQueue
  │    ├─ materialises {seq, origin, destination, depTime, ...}
  │    └─ _applyAll(legs, {source: "retry-persisted"})
  │         └─ AesAfpAutoApplyBatch.start(...) (no modal)
  └─ next leg-done {ok} for a retried seq → seq is excluded from
       getRetryQueue() going forward (later "ok" supersedes)

user clicks Dismiss
  ├─ AesAfpAutoApplyLog.dismissRetryQueue(...)
  │    └─ adds status: "queue-dismissed" entry for latest batch
  └─ _loadRetryQueue() → returns {dismissed: true}; banner hides
```

## Dismiss vs Retry semantics

- **Dismiss** writes a marker entry and DOES NOT delete the failed
  records. The audit log still shows what failed (and why) for any
  future operator review or diagnostics-console dump.
- **Retry** does NOT delete the original failed records either. A
  successful retry simply produces a new "ok" entry with the same
  `seq`; `getRetryQueue` excludes the seq from the queue because the
  "later ok" rule applies. The failed entry remains in the ring as
  history.
- A new batch (different `batchId`) supersedes the previous queue
  entirely — `getRetryQueue` always reports against the LATEST
  `batchId` it sees. Old failed legs from prior batches don't pollute
  the new queue.

## Defensive bail-outs

- `AesAfpAutoApplyLog` undefined when `_logEntry` is called →
  warn-and-continue; the pipeline isn't blocked.
- `getRetryQueue` on an aircraft with no persisted entries →
  `{batchId: null, legs: []}` → banner doesn't render → default tip
  surfaces.
- `_retryPersistedQueue` with entries missing origin/dest (shouldn't
  happen but the audit shape allows nulls) → toast "Persisted retry
  queue couldn't be reconstructed (missing origin/dest)." and bail.
- `dismissRetryQueue` when there's no queue to dismiss → returns
  `false`, no marker written, no UI update needed.

## Smoke / verification

`?aes-debug` smoke (4 assertions): `add` / `getRetryQueue` /
`dismissRetryQueue` exposed; `_cleanRecord` normalises IATAs to
uppercase + drops null fields.

End-to-end checklist (manual, requires a live AS session with
populated build + tier gate unlocked):

1. Settings unlocked, Auto-build week → Apply-all → induce a partial
   failure (e.g., temporarily block one origin via the diagnostics
   console mid-batch).
2. Batch settles with N ok / M failed. Result banner shows "N ok ·
   M failed" with a "M failed — retry" button.
3. Reload the AFP page. The persisted retry banner appears in the
   footer with the same "Retry M" / "Dismiss" buttons (in-memory
   `apply.results` is gone but the persisted log carries the queue).
4. Click Retry → second batch dispatches with only the M failed
   legs (no confirmation modal); each successful leg drops out of
   the queue via the "later ok" rule.
5. After the retry, the banner shows the FIRST batch's failed legs
   minus the ones now succeeded. If all retried successfully, the
   banner disappears entirely.
6. Click Dismiss → banner hides immediately. Inspecting
   `chrome.storage.local.get(...)` shows the original failed entries
   plus a new `queue-dismissed` marker entry for that batchId.
7. Run a fresh batch → new batchId resets the queue; the previous
   batch's dismiss-marker doesn't affect anything.

## Track 5 final-deliverable summary

End-to-end flow (slices 5a→5e):
- 5a — Auto-build week → Build renders into `auto-preview` slot
  (Gantt + per-leg overlay editor + summary cells).
- 5b — Apply-all CTA + confirmation modal (tier-gated, lists every
  leg, requires I-understand ack).
- 5c — Background.js batch pipeline (one hidden tab, serial per-leg,
  500ms inter-leg gap, 30s per-leg timeout, 20-min total cap, abort
  + reload-recovery).
- 5d — Live progress UI (progress bar, ETA, leg counter, last-result
  symbol) + Abort button. Result banner with immediate-after-batch
  "M failed — retry".
- 5e — Persisted audit log (dual-store ring) + retry queue surface
  on mount (survives page reload).

Tier gate: every Apply-all path is dormant unless
`settings.aircraftFlightPlan.autoScheduler.enabled === true && .tier
=== "apply-on-confirm"`. Default settings ship `false` /
`"preview-only"`.

No-programmatic-submit invariant held: every per-leg POST goes
through `AesAfpFormDriver.fillAndSubmit` clicking AS's own green
button — the SOLE entry point that triggers AS form submission. The
batch pipeline is a sequencing layer over the existing single-leg
path, not a new submit path.

## Known limitations / TODO

- Audit log has no UI surface yet — `getRecent` / `getForAircraft`
  are diagnostics-console only. A future polish slice could add a
  "Recent batches" expander to the preview panel reading from
  `getForAircraft` (or from the per-aircraft sidebar audit slot
  that `audit-log.js` currently owns; either mirror its layout or
  share the slot).
- Cross-aircraft "Recent applies across the fleet" view (the global
  ring's reason-to-exist) is a Phase-2 enhancement — would live on
  the Fleet Hub overlay or the AFP dashboard.
- `dismissRetryQueue` doesn't auto-fire when the user starts a fresh
  batch on the same aircraft. The new batch's `batchId` becomes the
  latest, so old queue entries naturally drop out of view; but the
  old `queue-dismissed` marker stays in the ring forever (small
  storage footprint — ~150 bytes per dismiss). A periodic
  `prune("queue-dismissed")` sweep would clean these up.
- No retry-on-rate-limit. AS occasionally returns Wicket session
  errors when posts come too quickly. The retry queue is the user's
  manual recovery; an automatic back-off-and-retry per leg would be
  a Phase-2 enhancement (would write retry attempts as separate
  entries with `source: "auto-retry"`).
