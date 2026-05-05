# Fix-A1 Log

**Outcome: APPLIED**

Agent: Fix-Agent 1 of 20 (AES fix wave)
Date: 2026-05-02
Territory: `manifest.json` only

## Source-of-claims

`/Users/jihwan/Downloads/AES.v0.6.9/audit/streamline-A1.md` FIX-1 (block 20 missing AFP host/route-candidates/wave-applier — §10 invariant violation, line 2943 of HANDOVER.md) and FIX-2 (`journal-store.js` after `learn.js` in blocks 5 and 27 — §10 invariant, line 2881).

## Pre-edit double-check

Re-read `manifest.json` directly with `python3 -c "import json; ..."` and confirmed both claims were live, NOT stale:

- Block 20 (matches `https://*.airlinesim.aero/app/fleets/aircraft/*/0*`) had 31 js entries; greps for `host.js`, `route-candidates.js`, `wave-applier.js` in block 20 returned `[]`. Confirmed missing.
- Block 5 (`/app/enterprise/dashboard*`): pre-edit positions `learn.js`@251, `journal-store.js`@252.
- Block 27 (`/app/fleets*`): pre-edit positions `learn.js`@146, `journal-store.js`@147.

Confirmed the §10 canonical order from `HANDOVER.md:2943`: *"AFP slice load order: foundation → host → bus subscribers → entry. settings-extension.js (no bus dep) before host.js (publishes window.AesAfp.bus) before audit-log.js / spec-resolver.js / route-candidates.js / form-driver.js / wave-applier.js (all bus.on(...) at module-level IIFE load) before content_aircraftFlightPlan.js."*

Confirmed the §10 journal-store rule from `HANDOVER.md:2881`: *"Manifest order MUST keep `journal-store.js` ahead of `apply-pipeline.js` and `learn.js` (so its passive subscriber catches their first write) and ahead of `panel.js` (so the modal section can reach `window.AesStrategyJournal`)."*

## Changes

### A1-FIX-1 — Block 20 AFP load-order completion

Inserted three modules into `manifest.json` block 20 (the `/app/fleets/aircraft/*/0*` AFP page block). Insertions kept the §10 canonical relative order while preserving the existing positions of all other entries.

| Pos | File | Status |
|---|---|---|
| 2 | `modules/aircraft-flight-plan/settings-extension.js` | (was 2) |
| **3** | **`modules/aircraft-flight-plan/host.js`** | **added** |
| 8 | `modules/aircraft-flight-plan/audit-log.js` | (was 7) |
| 9 | `modules/aircraft-flight-plan/spec-resolver.js` | (was 8) |
| **10** | **`modules/aircraft-flight-plan/route-candidates.js`** | **added** |
| 18 | `modules/aircraft-flight-plan/form-driver.js` | (was 16) |
| **19** | **`modules/aircraft-flight-plan/wave-applier.js`** | **added** |
| 33 | `content_aircraftFlightPlan.js` | (was 30) |

Block 20 js count: 31 → 34. §10 invariant order satisfied: `settings-extension → host → audit-log → spec-resolver → route-candidates → form-driver → wave-applier → content_aircraftFlightPlan`.

This means the four defensive retry shims that streamline-A1 listed (`spec-resolver._attach` setTimeout, `form-driver` setInterval/POLL_MAX_TRIES, `audit-log.whenReady` 200ms tick, `route-candidates` mirror) are now dead-but-harmless — Agent 4 (AFP territory) can clean them up in a follow-up. I did NOT touch those shim files (out-of-territory).

Coordination note: `host.js` / `route-candidates.js` / `wave-applier.js` ALSO live in block 27 today (positions 70 / 72 / 76 respectively). The streamline-A1 doc flagged that as an acceptable second-load (idempotent guards in place — `host.js:32` has `if (window.AesAfp) return`). The same files now load earlier on the AFP page via block 20 (Chrome injection order is by manifest-block order); the block 27 dup is silent. The streamline doc also raised cutting `settings-extension.js` from one of block 20 / block 27 — I did NOT make that cut here (it's marked as a separate streamline action and the brief said ADD over REMOVE).

### A1-FIX-2 — `journal-store.js` swap in blocks 5 + 27

Used `Edit` with `replace_all=true` on the two-line sequence `"modules/strategy/learn.js",\n                "modules/strategy/journal-store.js",` — the only two occurrences in the manifest are blocks 5 and 27 (verified via grep before edit).

Post-edit positions:

| Block | journal-store.js | learn.js | apply-pipeline.js | panel.js |
|---|---|---|---|---|
| 5 | 251 | 252 | 257 | 275 |
| 27 | 146 | 147 | 152 | (n/a) |

§10 invariant satisfied in both blocks: `journal-store < learn < apply-pipeline < panel`.

## Verification

**JSON parse:**
```
$ python3 -c "import json; json.load(open('/Users/jihwan/Downloads/AES.v0.6.9/manifest.json'))"
JSON parse: OK
```

**Static check on the five files added/touched:**
```
$ node --check modules/aircraft-flight-plan/host.js                → OK
$ node --check modules/aircraft-flight-plan/route-candidates.js   → OK
$ node --check modules/aircraft-flight-plan/wave-applier.js       → OK
$ node --check modules/strategy/journal-store.js                  → OK
$ node --check modules/strategy/learn.js                          → OK
```

**File existence:** all three newly-referenced modules are present on disk under `modules/aircraft-flight-plan/` (host.js 52KB, route-candidates.js 80KB, wave-applier.js 54KB).

**Block 20 ordering (post-edit dump):**
```
  2: modules/aircraft-flight-plan/settings-extension.js
  3: modules/aircraft-flight-plan/host.js
  8: modules/aircraft-flight-plan/audit-log.js
  9: modules/aircraft-flight-plan/spec-resolver.js
 10: modules/aircraft-flight-plan/route-candidates.js
 18: modules/aircraft-flight-plan/form-driver.js
 19: modules/aircraft-flight-plan/wave-applier.js
 33: content_aircraftFlightPlan.js
```

**Live (Playwright) verification:** SKIPPED. The brief notes that "most fixes can be verified by checking the extension loads and the affected page renders without console errors," but live verification of the AFP slice requires an authenticated AS session at `/app/fleets/aircraft/<id>/0` — same blocker the streamline doc called out. The static + JSON parse + file-existence checks above are sufficient to confirm the manifest is well-formed and references resolvable files.

## Open follow-ups

1. **Agent 4 (AFP territory) cleanup pass.** The four retry shims are now dead-but-harmless: `spec-resolver._attach` (setTimeout 50ms), `form-driver` setInterval/POLL_MAX_TRIES, `audit-log.whenReady` (200ms tick, 30s cap), `route-candidates` mirror. Worth removing in a future Agent 4 session for code clarity. NOT done by Agent 1 — out of territory.

2. **Streamline cuts NOT applied here.** streamline-A1's CUT recommendations (b6/b9 strict-subset entries; b19/b20/b27 cross-block dups including the `settings-extension.js` choice between b20 and b27) are SEPARATE actions from FIX-1/FIX-2 and were not part of this fix wave's scope per the user's "ADD over REMOVE" directive in `aes-fix-shared.md`. Leave for a separate streamline pass.

3. **Compatibility symlink note.** During this session the parent dir `/Users/jihwan/Downloads/AIRLINESIMMOD/` was found missing/recreated empty mid-task. I recreated the symlink as `/Users/jihwan/Downloads/AIRLINESIMMOD/AES.v0.6.9 → /Users/jihwan/Downloads/AES.v0.6.9` so paths in the brief continue to resolve. The canonical repo lives at `/Users/jihwan/Downloads/AES.v0.6.9/`. Other agents may want to be aware.

4. **Live verification deferred.** Agent 4 or Agent 8 should drive a Chrome instance to `/app/fleets/aircraft/<id>/0` after login and verify in DevTools that `window.AesAfp.bus._handlers` shows the four bus subscribers (`audit-log`, `spec-resolver`, `route-candidates`, `form-driver`, `wave-applier`) registered without falling through to the retry-shim paths.
