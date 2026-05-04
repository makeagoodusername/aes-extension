APPLIED

# Fix-Agent 8 — H-004 race-fix in modules/conductor/routine-store.js

## Outcome
APPLIED — tail-Promise serialization queue inserted around the read-modify-
write mutators in `routine-store.js`. Bug was real and present (no prior
serialization in `append()`/`update()`).

## Bug confirmed (pre-edit)
`AesConductorRoutineStore.append(host, instance)` and `update(host, instance)`
each performed an unserialized read-modify-write against the single
`aesConductor:routines:<server>:<airline>` key:

  1. `await _read(key)` returns the current array.
  2. Mutate the local copy (push / replace by `instanceId`).
  3. `await _write(key, arr)` clobbers the entire key.

Two concurrent callers (e.g. `routine-engine` advancing one instance while
`scenario-engine` spawns another, or two routines mid-tick) both read the
same baseline, both apply their mutation, and the second writer clobbers
the first writer's mutation. Net effect: silent loss of routine instances
or routine-state regressions on overlap. Cap-eviction in `_write()` runs
on stale data, compounding the loss.

`scenario-engine.js`, `routine-engine.js` and the conductor-tile all call
into these mutators on overlapping ticks (signal-layer broadcast → engines
fan out), so concurrent overlap is real, not theoretical.

The bug matches the pattern flagged in `audit/streamline-A6.md` (H-004) and
`CONSOLIDATION-SUMMARY.md` (P1 race regression).

## Fix applied
File: `/Users/jihwan/Downloads/AES.v0.6.9/modules/conductor/routine-store.js`

Added a tail-Promise queue, keyed by storage-key, around every mutating
public method:

- New private `_tails` map + `_enqueue(key, work)` helper. Each new write
  chains onto the previous tail Promise so writes execute in submission
  order. The tail stored in the map swallows rejections so a single
  storage error cannot poison the chain; the returned Promise still
  rejects to the caller for observability.
- `append(host, instance)` — wrapped read-mutate-write in `_enqueue(key, ...)`.
- `update(host, instance)` — wrapped read-mutate-write in `_enqueue(key, ...)`.
- `clear(host)` — also serialized via `_enqueue(key, ...)` so a clear
  cannot interleave between a queued read and its paired write.
- Pure reads (`all`, `active`, `findActive`) intentionally skip the queue —
  they are read-only snapshots. They will see consistent committed state
  because chrome.storage.local round-trips are atomic per call.

Net change: ~13 LOC added (queue helper + three wrappers). No public API
change; signatures and return types preserved.

## Verification

- `node --check /Users/jihwan/Downloads/AES.v0.6.9/modules/conductor/routine-store.js` → OK (syntax valid, no parse errors).
- No other files in this fix's territory edited.
- `scenario-store.js` and `signal-store.js` left untouched per assignment.
- Per the shared brief: did not commit changes (personal computer; save-only).

## Follow-ups / open items

- The same race pattern exists in `scenario-store.js` (Fix-Agent 7 territory)
  and `signal-store.js` (separate territory). Confirmed in audit/streamline-A6.md
  H-004 — they need the same tail-queue fix. Not edited here.
- Consider extracting `_enqueue` into a tiny `_shared/storage-queue.js`
  helper once all three stores are patched, to avoid drift between three
  near-identical implementations. STREAMLINE-class follow-up only — current
  patch is correct without it.
- No live Playwright verification was needed; race condition is non-visual
  and the fix is internal serialization only. `node --check` is sufficient
  for the static path; runtime correctness depends on chrome.storage.local
  semantics (atomic per get/set), which the prior code already assumed.
