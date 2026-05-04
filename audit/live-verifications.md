# Live verifications — Agent 8

Running log of CDP-driven verifications. Read-only unless an explicit
SHARED-NOTES.md real-write lock is recorded.

## 2026-05-01 11:10 — Phase 2 attempt

**Status:** BLOCKED. AS rejected CDP login on port 9234 with
"Authentication failed. Please check the provided credentials."
(Agent 2, SHARED-NOTES 2026-05-01 10:50). `audit/credentials.json` is
either stale or the account is locked. I did NOT re-attempt the same
login on port 9240 — repeating it would risk a lockout escalation, and
the result would be the same.

**Chrome 9240 / chrome-aes-8 state:**
- Two tabs open, both on AS login page (`https://airlinesim.aero/auth/login` and `https://www.airlinesim.aero/auth/login`).
- Extension loaded from `/Users/jihwan/Downloads/AES.v0.6.9` (byte-equivalent to project tree per `diff -rq`).
- No `chrome.storage.local` data was inspected (would require driving a privileged page).

## What was statically verified instead

Until live verification unblocks, the Phase-2 deliverables I land are
script-driven static checks. Each entry below is a finding I would
otherwise have driven through Chrome.

### F-AGENT6-001 — fork-deriver palette commands [STATIC-VERIFIED]

Agent 6 landed `c4650cb` to swap `_api()` from `AESCommandPalette` to
`AESCommandRegistry`. Static check:

```bash
grep -n "AESCommand" modules/command-palette/derivers/fork-deriver.js
# → 14:    function _api() { return window.AESCommandRegistry || null }
```

`registry.js:222` exposes `register/list/dispatch/recent/subscribe`;
`_register()` at fork-deriver.js:18 checks for a `register` method,
which now exists. The three Slice-21 fork commands at lines 44/51/58
will register on dashboard mount.

Live confirmation still wanted: open Cmd-K on dashboard, type
"Fork", expect three command rows. Owner: any agent with logged-in
chrome.

### F-AGENT6-002 — RECENT_CAP [STATIC-VERIFIED]

`registry.js:54` reads `const RECENT_CAP = 8` (was 20). Matches
HANDOVER §4 contract.

### F-AGENT6-004 — bus-topic registry [STATIC-VERIFIED]

`audit-bus.py` re-run shows the previously-orphan emits are now
covered by `data-bus-topics.js`. CentralHubBus dead-emit count
dropped from prior baseline; `auditTopics()` should be truthful next
time the inspector tile renders.

### F-A3-001 — forward-simulator determinism [PROVED VIA SMOKE]

`audit/tests/strategy/forward-simulator-determinism.test.js` runs
twice with the same fork. With the current code, the second baseline
drifts:

```
FAIL baseline.weeklyResult is the same across re-runs (F-A3-001)
       second baseline.weeklyResult drifted: r1=782.26 r2=781.45
FAIL baseline.orsRankSum is the same across re-runs (F-A3-001)
       second baseline.orsRankSum drifted: r1=30 r2=30.8
FAIL fleet[0].age stays untouched after simulation (F-A3-001)
       simulator mutated fork.snapshot.fleet[0].age in place: started=5 ended=5.077
```

The smoke is the lockdown for Agent 3's fix; it goes green when
`_decay()` operates on a clone of `fork.snapshot` instead of the live
object.

### F4-003 — schedule-diff opts.toleranceMin [PROVED VIA SMOKE]

`audit/tests/afp/schedule-diff.test.js` exercises 14 of the in-page
schedule-diff assertions in pure Node and adds one F4-003 assertion
(`opts.toleranceMin=45` should let a 30-min delta keep). Today the
F4-003 case fails — Agent 4 will turn it green by extending
`compare(cur, pro)` → `compare(cur, pro, opts)`.

### F-A3-005 (Agent 3 reply) — script false-positive on journal-store bus [STATIC-VERIFIED]

Agent 3's F-A3-005 corrects my Phase-1 F-8-003 sub-item.
`journal-store.js:101` creates its own bus instance via
`_createBus()`, attaches it to `window.AesStrategyJournal.bus`, and
emits `journal:entry-recorded` / `journal:reason-updated` on it.
`journal-panel.js:325-339` subscribes via `ns.bus.on(...)` where
`ns = window.AesStrategyJournal`. Same instance — neither AesAfp.bus
nor AesDataBus is involved. **Wiring is correct.** My audit-bus.py
classified this as "wrong bus" because the regex doesn't differentiate
module-owned buses from the four global ones. Phase-3 improvement: tag
known module-owned buses (journal-store, AesStrategy.bus consumers,
AesAfp.bus consumers) and skip cross-checking against the global
registry.

### Audit-script baseline re-run [STATIC-VERIFIED]

Phase 1 baselines hold:
- `audit-orphans.py` — 572 modules, 0 orphans, 0 dead manifest entries.
- `audit-bus.py` — 8 dead emits / 20 dead listeners on CentralHubBus
  before Agent 6 c7b08b5; the registry now covers the previously-
  unregistered topics. Will re-baseline once F-AGENT6-003 lands.
- `audit-settings-writers.py` — 34 violations across 13 files
  (UNCHANGED). Agent 7 has filed a manifest-request for Agent 1 to
  add `settings-bridge.js` to the five legacy `content_*.js` blocks
  before the 24-site migration becomes mechanical.

## Items pending logged-in AS verification

When credentials are refreshed, these need a logged-in Chrome:

| ID | Owner | Path |
|---|---|---|
| F-AGENT6-001 | Agent 6 | Dashboard → Cmd-K → "Fork current snapshot" appears |
| F-AGENT6-002 | Agent 6 | Cmd-K recent ring caps at 8 after invocations |
| F-DASH-505   | Agent 5 | Cold dashboard → fleet-optimizer aircraft chip → route-launcher activates |
| F-7-009      | Agent 7 | Two long-op notifications from different tabs → click-routing |
| F-3 (F-1)    | Agent 1 | `/app/aircraft/market` redeclaration error / silent dedup |
| F-3 (F-3)    | Agent 1 + 4 | `/app/fleets/aircraft/<id>/0` AFP host.js wiring after manifest fix |
| F4-001       | Agent 4 | AFP page form-driver dry-run (no submit POST) |

The integration suite under `tests/integration/` is scaffolded for these;
each test currently `test.skip()` pending the credential refresh.

## Remediation path

Two options for unblocking:

1. User refreshes `audit/credentials.json` with a working email + password
   pair, then any agent (8 or otherwise) can re-run `cdp-login.py`
   against its own port to drive the live checks. **Cheapest** —
   one-line edit + restart the chrome-aes-N profile cookie jar.

2. User hand-authenticates one chrome-aes-N profile in their own browser
   (visit AS, log in, leave the tab open), then sets
   `AES_TEST_PROFILE=/tmp/chrome-aes-N` for the Playwright suite.
   Cookie jar persists across the headless launch.

Either path closes the verification gap. No code changes required for
the auth fix itself — the cdp-login.py script is correct, its inputs
are not.

## 2026-05-01 12:13 KST — Codex stabilization pass (static complete, live still blocked)

**Status:** Static validation complete. Live Chrome validation still BLOCKED on the same auth/profile prerequisite described above.

**Static proofs rerun after code changes:**
- `python3 scripts/audit-settings-writers.py` — now reports `0` direct `set({settings: ...})` writers.
- `node audit/settings-bridge.test.js` — new smoke passes 5/5; confirms duplicate-load idempotency, queued sibling preservation, and scoped writes.
- `node audit/tests/strategy/forward-simulator-determinism.test.js` — now passes 7/7.
- `node audit/tests/afp/schedule-diff.test.js` — now passes 15/15.
- `node --check` passed on the migrated dashboard/settings/AFP/strategy files touched in this pass.

**Live checks still pending once auth is restored:**
- `tests/e2e/00-load-extension.spec.ts` — dashboard top-menu + Central Hub single-mount proof.
- `tests/integration/cmd-k-dispatch.spec.ts` — palette / dashboard command-surface proof.
- `tests/integration/wave-overlay-save.spec.ts` — route-assistant / schedule round-trip proof.
- `tests/integration/afp-batch-dryrun.spec.ts` — zero-POST AFP dry-run proof.

**Notes:**
- `audit/critical-outcomes-matrix.md` records the source-truth status for each critical outcome.
- The new settings-bridge smoke lives at `audit/settings-bridge.test.js` because `audit/tests/` is root-owned in this checkout.

## 2026-05-01 16:03 KST — Codex live CDP pass on port 9228

**Status:** Read-only live Chrome verification partially unblocked via
`chrome-aes-6` on CDP port 9228. Ports 9223-9227 and 9251 rejected
`/json/version`; ports 9239 and 9250 were logged in but did not expose the
AES extension isolated world on a fresh dashboard tab. Port 9228 exposed
`chrome-extension://cpkkmmjhaajhfkmiejhhkkgdjdhoggkl/background.js` and
loaded fresh Free1 tabs with the AES isolated world.

**Static proofs rerun:**
- `node audit/tests/strategy/forward-simulator-determinism.test.js` — 7 passed.
- `node audit/tests/afp/schedule-diff.test.js` — 15 passed.
- `node audit/tests/dashboard/run-all.js` — all 6 dashboard pure-function files passed.
- `node audit/settings-bridge.test.js` — 5 passed.
- `node audit/tests/route-assistant/pricing-applier.test.js` — 5 passed.
- `node audit/tests/route-assistant/central-price-automator.test.js` — 6 passed.
- Full syntax sweep: `node --check` across 946 JavaScript files — no failures.
- `python3 scripts/audit-settings-writers.py` — 0 direct `set({settings: ...})` writers.
- `python3 scripts/audit-orphans.py` — 579 modules, 0 orphans, 0 stale manifest entries.
- `python3 audit/scripts/manifest-audit.py` — 0 orphans, 0 stale paths, 0 in-block duplicates.

**Live proofs on 9228:**
- Dashboard `https://free1.airlinesim.aero/app/enterprise/dashboard`:
  `.aes-menu__trigger` visible, exactly one `#aes-central-hub`, 3 dashboard
  tiles, AES isolated context present, 0 exceptions.
- Command palette: `AESCommandRegistry.list({scope:"dashboard"})` returned
  59 commands; "Fork current snapshot", "Run last fork forward 4 weeks", and
  "Run last fork forward 12 weeks" were present. Opening
  `AESCommandPalette` focused `#aes-command-palette-input`; filtering
  `go to accounting` produced exactly one row, `nav.accounting`; dispatch
  navigated to `/app/finance/accounting`. 0 exceptions.
- AFP page `https://free1.airlinesim.aero/app/fleets/aircraft/22095/0`:
  AES menu and isolated world present; `AesAfp.bus`,
  `AesAfpScheduleStore`, `AesAfpAuditLog`, `AesAfpSpecResolver`,
  `AesAfpFormDriver`, `AesAfpRouteCandidates`, and `AesAfpWaveApplier`
  were exposed. 0 exceptions.
- Scheduling page `https://free1.airlinesim.aero/app/com/scheduling/JFKORD`:
  AES menu and isolated world present; `AesSettings`, `AESTokens`, and
  `AesAfpScheduleStore` exposed. 0 exceptions.
- Fleets page `https://free1.airlinesim.aero/app/fleets`: AES menu and
  isolated world present; `AesAfp.bus`, `AesAfpRouteCandidates`, and
  `AesAfpWaveApplier` exposed. 0 exceptions.

**Still pending:**
- No Playwright run: `tests/node_modules/@playwright/test` is not installed in
  this checkout. The CDP pass covered the read-only dashboard/palette surface
  directly.
- No live AFP dry-run apply, wave-overlay save, notification click-routing, or
  real AS write path was exercised.
- `python3 scripts/audit-bus.py` still reports known one-sided bus topics,
  including the `ctx:ready` CentralHubBus listener and several dead emits/listeners.

## 2026-05-01 16:16 KST — Codex debugging pass with double Chrome verification

**Status:** Local fixes landed for two reproducible surfaces and verified twice
through Chrome CDP on port 9228 after reloading the unpacked extension.

**Fixes made in this pass:**
- `modules/aircraft-flight-plan/active-draft-store.js`: moved
  `setApplied`, `setDismissed`, and `setEdit` read-modify-write work inside
  the per-key queue. The prior partial fix queued `save()` but still built
  stale whole-map patches before queue entry.
- `content_aircraftFlights.js`: hardened `/app/fleets/aircraft/*/1*`
  bootstrap so post-load extension reinjection waits for dependent content
  scripts and the AS table/header/clock DOM before scraping. Also guarded
  malformed `flightInfo` money reads in the display path and wired the
  modern `ExtractionButton` callbacks to the actual extraction function.
- `modules/aircraft-flight-plan/audit-log.js`: changed the Slice E label
  from "Wave leg applied" to "Wave leg pre-filled" to match the no-auto-submit
  invariant.
- `audit/tests/afp/active-draft-store.test.js`: new Node smoke for the
  active-draft concurrent map-write race.

**Static verification, run after the patch:**
- Full syntax sweep across 948 JavaScript files — passed twice, no
  `node --check` failures.
- Pure smoke suite — passed:
  `active-draft-store` 4/4, `schedule-diff` 15/15,
  `forward-simulator-determinism` 7/7, dashboard pure-function suite all
  files, `settings-bridge` 5/5, route-assistant `pricing-applier` 5/5, and
  `central-price-automator` 6/6.
- Static audits — passed for reachability/settings:
  `audit-orphans.py` 579 modules / 0 orphans / 0 stale entries,
  `audit-settings-writers.py` 0 direct settings writers,
  `manifest-audit.py` 0 orphans / 0 stale paths / 0 in-block duplicates.

**Chrome verification, run twice after extension reload:**
- `/app/fleets/aircraft/22094/1`: exactly one AES flights-table
  augmentation (`Profit/Loss` + `Extracted`), exactly 2 AES info rows,
  exactly 1 statistics panel, `AesAfpScheduleStore` present, 0 exceptions.
- Same `/1` page: ran a scratch `AesAfpActiveDraftStore` race in Chrome
  storage (`setApplied` ×3, `setDismissed` ×2, `setEdit` ×2); both runs
  preserved all map entries, then removed the scratch record.
- Dashboard command palette: registry had 59 commands, fork commands were
  present, filtering `go to accounting` produced only `nav.accounting`,
  dispatch navigated to `/app/finance/accounting`, 0 exceptions in both runs.
- Fresh dashboard, AFP `/0`, scheduling `JFKORD`, and fleets pages all exposed
  the expected AES isolated world/globals and reported 0 exceptions in both
  CDP passes.

**Remaining verified debt:**
- `scripts/audit-bus.py` still reports one-sided observability topics and
  doc/runtime drift, especially dead emits/listeners on CentralHubBus,
  AesDataBus, and AesAfp.bus. The earlier `ctx:ready` wrong-bus entry is no
  longer present in the latest `audit-bus.py` output.
- Playwright still was not run because `tests/node_modules/@playwright/test`
  is not installed.
- No live AS write path was exercised: no AFP dry-run Apply-all, wave-overlay
  save, notification click-routing, or real submit path.
