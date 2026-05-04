# fix-A3-log — F4-011 schedule-store.js IIFE guard

## Outcome
**REJECTED-stale** — claim no longer applies. The defensive IIFE guard is already present in `modules/aircraft-flight-plan/schedule-store.js`. No edits made.

## Claim under review
A8 streamline report (`audit/streamline-A8.md`, FIX item 1, F4-011) said:
> Class declared at top level (line 34); `if (typeof window !== "undefined" && window.AesAfpScheduleStore)` only guards namespace assignment, not class redeclaration. Today's manifest loads `schedule-store.js` twice on `/app/fleets/aircraft/*/1*` (block 19[11] + block 27[4]). If Agent 1's F-2 dedup doesn't land, second IIFE throws SyntaxError and kills the rest of block 27 (200 entries).

## Source verification
Read entire file: `/Users/jihwan/Downloads/AIRLINESIMMOD/AES.v0.6.9/modules/aircraft-flight-plan/schedule-store.js` (225 lines).

Current structure:
- **Line 1**: `"use strict"`
- **Line 3**: `;(function () {` — IIFE opens
- **Lines 4-6**: `const root = (typeof window !== "undefined") ? window : ...`
- **Lines 7-11**: idempotent guard
  ```
  if (typeof window !== "undefined") {
      if (window.AesAfpScheduleStore) return
  } else if (root && root.AesAfpScheduleStore) {
      return
  }
  ```
- **Line 44**: `class AesAfpScheduleStore { ... }` — INSIDE the IIFE
- **Lines 221-223**: `if (root) { root.AesAfpScheduleStore = AesAfpScheduleStore }`
- **Line 224**: `})()` — IIFE closes

The class is **NOT** at top level — it sits inside the IIFE function body. The early-return guard at lines 7-11 fires before the `class` keyword is ever re-parsed, so loading the file twice is harmless: second IIFE invocation hits the guard, returns immediately, never re-evaluates the `class` declaration. No SyntaxError possible.

The audit's claim that the guard "only guards namespace assignment, not class redeclaration" is incorrect against today's source. The guard is at line 7 (top of IIFE body), the class is at line 44 (further down in same IIFE body), so the guard absolutely does prevent re-declaration.

This appears to have been fixed already in a prior pass (the current shape exactly matches the house pattern used by `drag-to-schedule.js:30`, `diagnostics.js:26`, `flight-log-scraper.js:33`, `host.js:36`, `form-driver.js:54`, `maintenance-scraper.js:39`, `maintenance-budget.js:34`, `schedule-apply-orchestrator.js:32`, `schedule-broadcaster.js:46`).

## Verification
```
$ node --check /Users/jihwan/Downloads/AIRLINESIMMOD/AES.v0.6.9/modules/aircraft-flight-plan/schedule-store.js
SYNTAX-OK
```
(no errors, exit 0)

House-style guard pattern grep across `modules/aircraft-flight-plan/`: confirmed schedule-store now matches the same `if (window.Aes<Name>) return` early-return shape as 9 sibling modules.

Manifest references confirmed for `modules/aircraft-flight-plan/schedule-store.js`:
- Line 272 (block 19)
- Line 628 (block 27 area)
- Line 761
- Line 886

So the dual-load on `/app/fleets/aircraft/*/1*` does still occur — but the existing guard handles it correctly. Agent 1's F-2 manifest dedup (separate territory) remains the right cleanup, but is not blocking on F4-011 anymore.

## Files edited
None.

## Open follow-ups
1. A8 open-question #1 (idempotent-guard sweep across sister classes `AesAfpStateStore`, `AesAfpActiveDraftStore`, `AesAfpFlightLogStore`, `AesAfpMaintenanceStore`, `AesAfpWearModel`, `AesAfpAuditLog`) is **out of A3's territory** — schedule-store.js only. Flag for whichever fix-agent owns those files.
2. The audit report (`streamline-A8.md`) should be marked stale on item F4-011 in the next consolidation pass.
3. Agent 1's manifest-block dedup (F-2) is still a real cleanup opportunity even though it no longer gates F4-011.
