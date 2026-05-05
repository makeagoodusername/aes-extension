# Fix-Agent 7 — H-004 race in scenario-store.js

**Outcome: APPLIED**

## Claim re-verification

Re-read `modules/conductor/scenario-store.js` (original, 5,553 bytes,
148 lines, dated Apr 30 15:27). Confirmed the H-004 read-modify-write
race is real and present:

- `append(host, fire)`           lines 51-58: `_read` → push/splice → `set`
- `dismiss(host, fireId)`        lines 68-84: `_read` → mutate → `set`
- `accept(host, fireId)`         lines 89-106: `_read` → mutate → `set`
- `applyOutcome(host,fireId,o)`  lines 112-128: `_read` → mutate → `set`
- `clear(host)`                  lines 138-142: standalone `set`

No queue, no lock, nothing serializing concurrent writers. Two
overlapping writers (e.g. outcome-driver tick + a user dismiss tap, or
two outcome-driver iterations on different fires) would each read the
pre-state, mutate locally, then both `set` — last-write-wins drops the
first mutation, breaking K10 outcome attribution and K11 trust scoring.

NOT-stale. Fix proceeds.

## Fix applied

Added a 10-LOC tail-Promise queue at the top of the IIFE and routed
every read-modify-write (and the standalone `clear` write) through it.
Reads via `_read()` stay direct — they are snapshot consumers and do
not need serialization.

Pattern (lines 49-58 of the new file):

```js
let _writeChain = Promise.resolve()
function _enqueue(fn) {
    const next = _writeChain.then(fn).catch(e => {
        try { console.error("[scenario-store] write failed", e) } catch (_) {}
    })
    _writeChain = next
    return next
}
```

Then each writer is wrapped:

```js
async function append(host, fire) {
    const key = _key(host)
    if (!key || !fire) return
    return _enqueue(async () => {
        const arr = await _read(key)
        arr.push(fire)
        if (arr.length > CAP) arr.splice(0, arr.length - CAP)
        try { await chrome.storage.local.set({[key]: arr}) } catch (_) { /* noop */ }
    })
}
```

Wrappers added on: `append`, `dismiss`, `accept`, `applyOutcome`, `clear`.

The IIFE-scoped `_writeChain` rebuilds on every call so the chain always
extends from the last queued task. Errors inside a queued op are caught
and logged so one failed write cannot poison the chain for subsequent
ops. Public API surface unchanged — every method still returns a
Promise; callers that previously `await`-ed get the same back-pressure
they had, plus serialization across concurrent calls.

Also expanded the file-header docstring with a "Concurrency (H-004 fix)"
section explaining why the queue exists.

## File-level summary

- Before: 148 lines, 5,553 bytes — 4 racey RMW paths + 1 standalone write.
- After:  185 lines, ~6,800 bytes — same paths, all funneled through one
  tail-Promise queue. No public surface change.

## Verification

1. **Static** — `node --check
   /Users/jihwan/Downloads/AES.v0.6.9/modules/conductor/scenario-store.js`
   → exit 0, prints `SYNTAX_OK`.
2. **Coverage** — grep'd every `chrome.storage.local.set` in the file
   (lines 81, 108, 132, 156, 173). Each is inside an `_enqueue(async
   () => { ... })` block (queue starts at lines 77, 96, 119, 144, 172).
   Zero writes escape the queue.
3. **Function-by-function map** (awk):

   | Function     | set() line | Inside `_enqueue`? |
   | ------------ | ---------- | ------------------ |
   | append       | 81         | yes (line 77)      |
   | dismiss      | 108        | yes (line 96)      |
   | accept       | 132        | yes (line 119)     |
   | applyOutcome | 156        | yes (line 144)     |
   | clear        | 173        | yes (line 172)     |

4. **No new write paths** — pre-existing two-gate model untouched (this
   store is internal to the conductor; never POSTs to AS).
5. **No manifest change** — no need to re-validate `manifest.json`.
6. **No live verification** — H-004 is a concurrency race that
   reproduces only under simultaneous async writers; deterministic to
   audit by code review. Spinning up Playwright to drive two concurrent
   fires would be a much larger fixture than this 10-LOC fix warrants
   and risks colliding with other agents' AS sessions.

## Out-of-territory follow-ups

A6 streamline-A6.md flags H-004 as present in **three** stores:

- `modules/conductor/scenario-store.js` ← **this fix (A7 territory)**
- `modules/conductor/routine-store.js`  ← Fix-A8 territory, not touched
- `modules/conductor/signal-store.js`   ← Fix-A9 territory, not touched

Confirmed I did not edit either of those — both file mtimes still
`Apr 30 15:27` (verified via `ls -la modules/conductor/`).

The same tail-Promise pattern should be applied identically in those
two files; A8 and A9 own them.

## Open questions

None for this fix specifically. The wider H-004 cluster will be fully
closed once A8 and A9 land their parallel patches.
