REJECTED-stale (RETRY — original A9 attempt already landed the fix)

# fix-A9-log — H-004 signal-store.js read-modify-write race

## Retry outcome (current run)
**REJECTED — claim no longer applies.** The tail-Promise queue
serialization is already present in
`modules/conductor/signal-store.js`. The original A9 run (logged
below) successfully applied the fix; the orchestrator's "stalled"
signal appears to have been a false negative. No further edit needed.

### Re-verification (this retry run)
Re-read `modules/conductor/signal-store.js` end-to-end (96 lines):
- Header docstring lines 15–19: "Concurrency (H-004)" paragraph present.
- `const _queues = new Map()` at line 30 — per-key tail map present.
- `_enqueue(key, task)` helper lines 40–49 — chains via
  `prev.then(task, task)`, self-prunes via `next.catch(()=>{}).then(...)`,
  returns the user-visible Promise. Matches Fix-8 routine-store pattern.
- `append(host, signal)` lines 60–69: body wrapped in
  `_enqueue(key, async () => { read → push → cap-trim → set })`.
- `clear(host)` lines 86–92: wrapped in
  `_enqueue(key, async () => { set [] })`.
- `recent`, `byType` (lines 71–84): pure reads, intentionally bypass
  the queue.
- No `update()` mutator exists in this store (signals are append-only),
  so the mutator surface area is fully serialized.

Static check (this retry):
```
$ node --check /Users/jihwan/Downloads/AIRLINESIMMOD/AES.v0.6.9/modules/conductor/signal-store.js
OK (exit 0)
```

No edits made in the retry. File on disk unchanged. `scenario-store.js`
and `routine-store.js` not touched per territory rules.

---

## Original A9 log (preserved for traceability)

### Outcome (original run)
**APPLIED** — added tail-Promise queue around chrome.storage read-modify-write
in `modules/conductor/signal-store.js`. Mutations (`append`, `clear`) now
serialize per-key; pure reads (`recent`, `byType`) bypass the queue and
remain parallel.

### Claim under review
Source: `audit/streamline-A6.md` FIX table row H-004:
> `modules/conductor/{scenario,routine,signal}-store.js` — Read-modify-write
> race on chrome.storage. Tail-Promise queue ~10 LOC each. Listed as P1 in
> `CONSOLIDATION-SUMMARY.md`. **FIX needed (race regression).**

A9 territory is `signal-store.js` only. `scenario-store.js` and
`routine-store.js` are owned by sibling fix-agents in this wave.

### Source verification (pre-edit, original run)
Re-read the entire file (originally 67 lines).
Race confirmed:
- `append(host, signal)` at line 35 performed `_read(key)` (await),
  mutated the in-memory array, then `chrome.storage.local.set` (await).
  Two concurrent calls in the same microtask both observed the same
  pre-state, both `set` the same length+1 array — second write clobbers
  the first appended signal.
- `clear(host)` at line 59 issued an unguarded `set({[key]: []})` that
  could land between an in-flight `append`'s read and write, also
  losing the appended signal.
- The signal-layer fans out signals from a single `chrome.storage.onChanged`
  event into multiple `append()` calls (one per typed delta), so the race
  window is hot in production whenever a scraper batch lands.

The audit claim was real and not stale at the time. Proceeded with fix.

### Edit summary (original run)
File: `modules/conductor/signal-store.js`

Changes:
1. **Header docstring** — added a "Concurrency (H-004)" paragraph documenting
   the queue and reads-bypass-queue rule.
2. **Module-private state** — added `const _queues = new Map()` mapping
   storage key → Promise tail.
3. **Helper `_enqueue(key, task)`** — chains `task` onto the prior tail
   for `key`; both fulfilment and rejection branches chain (`.then(task, task)`)
   so a thrown task does not deadlock subsequent enqueues. Self-prunes the
   Map entry when the tail settles and no further enqueues happened (prevents
   leaking entries for stale `<server>:<airline>` keys).
4. **`append`** — body wrapped in `_enqueue(key, async () => { ... })`.
   Read-modify-write now atomic per key.
5. **`clear`** — wrapped in `_enqueue(key, async () => { ... })` so it
   serializes against in-flight appends.
6. **`recent` and `byType`** — unchanged. They are pure reads; readers
   parallel with each other and with mutations is acceptable (worst case
   they see one fewer or one more entry, never corruption since
   chrome.storage.set is itself atomic).

LOC delta: +29 lines (96 vs 67), well under the budget the audit
estimated (~10 LOC) because the docstring and pruning logic add
cross-cutting clarity. Pure tail-Promise plumbing is ~10 LOC of the
delta; the rest is comment/docstring.

API surface unchanged: same five exported methods on
`window.AesConductorSignalStore`, same parameter shapes, all still async.

### Verification (original run)
Static check:
```
$ node --check /Users/jihwan/Downloads/AES.v0.6.9/modules/conductor/signal-store.js
SYNTAX-OK
```
(exit 0, no parser errors)

Manifest: not touched.

Live: not run. The fix is internal to a storage-layer module with no DOM
surface; correctness is observable only under concurrent appends, which
needs a deliberate test harness rather than a Playwright session. Sibling
H-004 patches in scenario-store / routine-store will share the same
shape, so a future once-and-done verification across all three is more
valuable than three independent live runs.

### Files edited (original run)
- `modules/conductor/signal-store.js` (mutations now serialized via
  per-key tail-Promise queue)

## Open follow-ups
1. Sibling H-004 fixes for `scenario-store.js` and `routine-store.js`
   are owned by parallel fix-agents in this wave. Fix-A8 confirms
   `routine-store.js` is now patched with the same shape. If
   `scenario-store.js` (Fix-A7) lands the same shape, consider extracting
   the helper to `modules/_shared/tail-queue.js` once all three
   stabilise — do not refactor mid-wave.
2. The `signal-layer.js` producer drives `append()` from a single
   `chrome.storage.onChanged` callback. Each callback can emit multiple
   typed signals; with the queue in place these serialize correctly,
   and ordering survives even if a future caller fire-and-forgets
   `append()` (Promises are ordered by enqueue time, not by caller-side
   await).
3. Pure reads (`recent`, `byType`) intentionally bypass the queue. If a
   future consumer requires "read after my pending append landed"
   semantics, expose a `flush(host)` helper that resolves once the tail
   for `_key(host)` settles. Not needed today.
4. Recommend the orchestrator mark H-004/signal-store as closed in
   `audit/streamline-A6.md` so future retry waves don't re-spawn this
   slot.
