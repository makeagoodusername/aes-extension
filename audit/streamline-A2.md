# A2 — Background + Content Entrypoints + Auth — Streamline Report

Territory: `background.js`, `content_*.js` (24 files), `options.html/js`, `popup.html/js`,
`bridge.html`, `manifest.fingerprint`, `audit/credentials.json`.

Methodology: read-only audit (Read, grep, ls). No production code edited. No
credentials read beyond verifying gitignore status.

Reference: prior Agent 7 audit (`audit/findings-AGENT-7.md`) — 14 findings, all
in-territory bugs already fixed or deferred. This report is **streamline-focused**
(KEEP / CUT / FIX / DEFER), not bug-hunting.

---

## Summary

- **24 content scripts** (10,484 LOC across territory) — all referenced by manifest,
  no orphans, no typo-collisions.
- **Background SW** is a thin 108-line shim importing 13 `modules/_background/*.js`
  — clean separation, every imported module wired and consumed.
- **Auth surface** is OUT of extension code. `audit/credentials.json` is consumed
  only by `audit/scripts/run-eight.{sh,py}` and `cdp-login.py` — Playwright/CDP
  harness, never the .crx. Properly gitignored, untracked.
- **No hardcoded prod secrets** in `background.js` or any content script (grep
  for password/token/api-key in territory: 0 hits).
- **Top streamline targets**: massive content-script size variance (10–4000+ LOC)
  + the H-001 settings-bridge migration cross-blocked on Agent 1.

Counts: **KEEP 22**, **CUT 1**, **FIX 5**, **DEFER 4**, **STREAMLINE-top-5 below**.

---

## KEEP

These are working, in-scope, and earning their bytes. Do not touch.

1. `background.js` (108 LOC) — Already a thin importScripts shim. The pre-split
   monolith was 1,272 LOC; current form is well factored. Comments document
   load order. Try/catch around every import means a single broken module can't
   kill the SW boot. **Do not collapse back into a monolith.**

2. `popup.js` (10 LOC) + `popup.html` — Truly minimal. Stamps version, opens
   options. Zero state, zero AS POST risk, zero message-passing. Verified by A7.

3. `options.js` (252 LOC) + `options.html` — Data-Manager + Brutalist-Skin
   round-trip + Accounts table. Only sync keys touched: `aes_skin_enabled`,
   `aes_skin_density`. Single chrome.storage subscriber listens for round-trip.
   Working as designed.

4. `bridge.html` (51 LOC) — Command Bridge entry, referenced by:
   - `modules/_background/bridge-tab.js` (`chrome.tabs.query({url})` open/focus dedup)
   - `modules/command-bridge/menu-installer.js` (3 call sites: open via window.open)
   - `modules/command-bridge/opportunities-panel.js` (mounted under it)
   - `modules/central-hub/feed/index.js` (comment ref)
   Active surface — KEEP.

5. **Background message handlers — all 17 traced, all consumed.** Per A7's
   verification matrix and re-grepped this pass:
   - `aes:account:touch`, `aes:migration:set-version`, `aes:migration:set-pending`
   - `aes:bridge:open`
   - `aes:customization:patch`
   - `aes:notify:long-op` (post-fix: per-notif Map for click routing)
   - `aes:scrape-all:{start,abort,status,reset-breaker}`
   - `aes:vision:capture-tab`
   - `aes:silent-auto:tick` (alarm → tab broadcast, single-tab)
   - `aes:auto-drive:tick` (alarm → tab)
   - `aes:afp:{submit-leg, apply-batch, delete-batch, apply-batch:abort, delete-batch:abort}`
   - `aes:afp:fill-and-submit` (bg → AFP tab — `content_aircraftFlightPlan.js`)
   - `aes:afp:delete-flight-form` (bg → flightNumbers tab)
   - `aes:flight-numbers:{ensure-group, organize, snapshot, create-group, sort-visible-into-group}`
   - `aes:tab:close-self` (`content_flightsFrom.js` → bg)
   - `aes:site-skin:update` (bg → AS tabs broadcast)
   No dead handlers. KEEP.

6. **All 24 `content_*.js` files** — verified disk⇔manifest set equality:
   ```
   ls content_*.js  ↔  grep content_ in manifest.json
   ```
   No orphans (disk-only) and no missing files (manifest-only). All 24 keep
   their manifest match-pattern. KEEP.

7. `content_aircraftFlights.js` flightId regex fix already shipped at line 409:
   `url.match(/[?&]id=(\d+)/)` (not the legacy `\d+/0` that picked up "1" from
   `free1` hostname). KEEP.

---

## CUT

1. **`manifest.fingerprint`** (66 bytes, 1 line: a SHA256 digest)
   - **Zero references** anywhere in the codebase: grep across `*.js`,
     `*.json`, `*.html`, `manifest.json` returned nothing.
   - Not consumed by `manifest.json`, not by any `audit/scripts/*.py`, not by
     `tools/`, not by extension code.
   - File is dated `Jun 11 2024` (older than every other file in repo); looks
     like an artefact from a prior packaging pipeline that no longer exists.
   - **Risk of cut: zero** (not loaded; deleting it cannot affect runtime or
     packaging unless an external CI script reads it — none found).
   - Recommend: remove from repo. ~1 LOC reduction but eliminates a stale
     "what is this for?" file. (Defer the actual delete to user — not auditing
     CI/packaging surface.)

---

## FIX

These are open issues in territory. Some were filed by A7 and are still open;
some surfaced this pass.

1. **F-7-009 fix not yet committed** [HANDOFF from A7]
   - `modules/_background/notifications.js` — long-op click-routing fix is in
     working tree but not committed. `git status` confirms it's still M.
   - 1-commit task. No new bugs surface from waiting; this is durability hygiene.
   - **Note:** A7 re-flagged this is in `modules/_background/**` which is
     ambiguous wrt territory matrix. (See R4 below.)

2. **F-7-014 / H-001: 24 settings-writers in legacy content_*.js** [BLOCKED on A1]
   - Bypass `window.AesSettings.saveArea(...)` via direct
     `chrome.storage.local.set({settings: settings})` writes.
   - Files: `content_inventory.js` (5), `content_dashboard.js` (12 +1 dynkey),
     `content_personelManagement.js` (6), `content_settings.js` (5),
     `content_fligthSchedule.js` (3).
   - Blocker: `modules/_shared/settings-bridge.js` not in those 5 entries' `js`
     arrays in manifest. A7 filed `audit/manifest-requests.md`; A1 hasn't
     batched it yet. Mechanical migration once unblocked (~24 one-line edits).
   - **No new finding here** — just keeping it on the radar.

3. **R4 / Territory boundary on `modules/_background/**`** [QUESTION for user]
   - CLAUDE.md §4 matrix says A7 forbidden inside `modules/**`.
   - AGENT-7.md brief assigns audit + fix of items that live there
     (`afp-submit-queue.js`, `silent-auto-alarm.js`, `notifications.js`).
   - F-7-009 fix in working tree edits `modules/_background/notifications.js` —
     reverting it would lose a real bug fix.
   - Resolution needed: confirm `modules/_background/**` is A7's *de facto*
     territory (per brief content) so future fixes can land cleanly.

4. **`content_dashboard.js` is 4061 LOC** [streamline target — see below]
   - Single largest file in territory by 4×. It owns **9 dashboard panes**
     (general, routeManagement, competitorMonitoring, aircraftProfitability,
     stationAutomation, usedAircraftScanner, scheduleManagement, flightsFrom,
     other) plus the F-9228-100 hash-deep-link override.
   - Most of the size is dashboard-specific business logic that probably
     belongs under `modules/dashboard/**`. But a port out of `content_*` is
     out-of-territory for A2 (it'd be cross-territory with A5 / Substrate / A6).
   - Recommend: file as a [STREAMLINE proposal] for the user, not a unilateral fix.

5. **`content_inventory.js` is 1116 LOC** [streamline target]
   - Same shape as content_dashboard: page-specific feature wrapped in a
     single content script. The `displayInventory()` flow + `getAnalysis()` +
     auto-pricing automation could split into `modules/inventory-pricing/**`.
   - Same OOT concern as #4. File as proposal.

---

## DEFER

Things flagged, not actionable in this audit pass.

1. **F-7-010 / `legacy-defaults.js` shallow write-once** [DEFERRED-CONFIRMED by A7]
   - `setDefaultSettings()` only fires when blob is undefined. Old installs
     missing sub-trees (e.g. fresh `usedAircraftScanner` defaults) don't get
     backfilled.
   - Doc-comment says "preserved verbatim from pre-split" — intentional.
   - Not a candidate for reshape unless user asks.

2. **F-7-001 / login automation** [RESOLVED-EXTERNAL]
   - `audit/credentials.json` exists, gitignored, populated locally; consumed
     by `audit/scripts/run-eight.py` + `cdp-login.py` (CDP-driven Chrome
     automation harness — NOT extension code).
   - Brief item is OOS for extension audit. No work to do here.
   - Light recommend: rename CLAUDE.md / AGENT-N briefs to reflect "login
     automation lives in `audit/scripts/`" so the next agent doesn't waste a
     hunt cycle. (Doc fix only.)

3. **`content_dashboard.js` table-options dynamic settings key** [DEFER-tracked]
   - Line 2530/2692: `settings[tableOptionsRule.tableSettingStorage]` —
     dynamic key writer. Migrating this site to `AesSettings.saveArea` requires
     special-casing the dynamic area name. Tracked under H-001; defer until
     migration unblocked.

4. **Five tiny `content_finance_*.js` files (38–59 LOC each)** [STRUCTURAL — no fix]
   - `accounting.js`, `assets.js`, `capital.js`, `cashflow.js`, `leasing.js`
   - All same shape: anchor-finder + MutationObserver + `start()` calling
     `AccountingSnapshotStore.saveSister(...)` for the matching sister type.
   - Could be consolidated to one file with a path-routed dispatcher, BUT each
     is a separate manifest match pattern and the duplication is ~30 LOC each
     of pure boilerplate. Not worth the migration risk; they're cheap, working,
     and the manifest pattern is per-file. **DEFER — no payoff.**

---

## STREAMLINE — Top 5

Ranked by ratio of (impact on focus / risk + effort).

### 1. Delete `manifest.fingerprint` (low effort, low impact, very low risk)
- Single command: `rm manifest.fingerprint`.
- Removes a "what is this for?" file from repo root that no human or machine
  ever reads.
- Risk: ~zero — no references found.
- **Action: user gates.** Trivial.

### 2. Resolve A7 territory boundary (`modules/_background/**`) (zero effort, high impact)
- Either explicitly add `modules/_background/**` to A7's matrix line, OR
  reroute the 13 split modules through Substrate/A6.
- Unblocks F-7-009 commit + any future SW-side fixes.
- **Action: user clarifies in CLAUDE.md §4.**

### 3. Land H-001 settings-writer migration (mechanical, blocked on A1)
- 24 mechanical edits across 5 legacy `content_*.js` files once A1 adds
  `modules/_shared/settings-bridge.js` to entries 2/3/4/5/13.
- Locks the storage prefix invariant (CLAUDE.md §3 rule 2). Eliminates the last
  direct `chrome.storage.local.set({settings})` in territory.
- **Action: A1 batches manifest update; A7/A2 lands the migration same-day.**

### 4. File extraction proposal: `content_dashboard.js` 4,061 LOC → `modules/dashboard/**`
- Currently a god-file with 9 panes worth of logic. Hard to reason about,
  hard to test, blocks future incremental refactors of dashboard code by other
  agents.
- Move the per-pane render functions to `modules/dashboard/<pane>.js` (one
  module per pane), keep `content_dashboard.js` as a thin entrypoint that
  hydrates settings + dispatches to `AesDashboard.<pane>.mount()`.
- Cross-territory (A5 owns dashboard intelligence tiles; A6 owns substrate;
  A7/A2 owns the entry script). **Action: file proposal for user; multi-agent
  coordination required.**

### 5. File extraction proposal: `content_inventory.js` 1,116 LOC → `modules/inventory-pricing/**`
- Same pattern as #4 but smaller scope. Inventory pricing is a self-contained
  feature with one clear API surface.
- Easier than #4 because no cross-territory contention.
- **Action: file proposal.**

---

## Open questions for the user

1. **Territory: is `modules/_background/**` Agent 7/A2's de-facto turf?**
   The CLAUDE.md §4 matrix forbids A7 from `modules/**`, but the AGENT-7 brief
   explicitly assigns audit + fix items that live in `modules/_background/`.
   The F-7-009 fix is in working tree but uncommitted because of this
   ambiguity. Pick one — matrix or brief — so future SW work doesn't pingpong
   between A6 and A7.

2. **Should `manifest.fingerprint` be deleted?**
   Zero references in repo, dated June 2024, looks like a stale packaging
   artefact. One-line `rm`. (If you have an external CI pipeline that reads
   it, say so and we'll keep it.)

3. **`content_dashboard.js` (4,061 LOC) and `content_inventory.js` (1,116 LOC)
   extraction priority?**
   These two files dominate the territory's LOC. Lifting them into
   `modules/dashboard/**` and `modules/inventory-pricing/**` would dramatically
   shrink content-script complexity but is a multi-week refactor. Worth it
   now, or defer to a v0.7 cleanup pass?

4. **Should the brief fold-in mention that `audit/credentials.json` is harness
   code, not extension?**
   The CLAUDE.md territory description says "Credentials/login automation"
   for A7/A2 — both A7 and now A2 spent search-cycles confirming that's an
   external CDP harness. A one-line brief edit prevents repeats.

5. **Do you want any of the 5 `content_finance_*.js` files merged into a
   single dispatch script?**
   Pure stylistic / DRY question — they're 38–59 LOC each of identical
   anchor-find/observer/start boilerplate. Manifest match patterns are
   per-file so the merge would need URL-path routing inside the merged file.
   Net LOC savings ~150. Net complexity: ambiguous. Defer until you say go.
