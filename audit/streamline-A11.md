# A11 — Accounting + Crew + Station + Data-models + Command-bridge + _background — Streamline Report

Territory:
- `modules/accounting/**` (12 files)
- `modules/crew-management/**` (10 files)
- `modules/station-automation/**` (3 files)
- `modules/data-models/**` (1 file)
- `modules/command-bridge/**` (8 files)
- `modules/_background/**` (14 files)
- Root content scripts: 5× `content_finance_*.js`, `content_personelManagement.js`,
  `content_stationOpen.js`, `content_scheduling.js`

Methodology: read-only audit (Read, grep, ls). No production code edited.
Manifest cross-checked for content_scripts wiring. HANDOVER.md skim for context.

Reference: A2 (background/content) + Agent 7 brief.

---

## Summary

- **48 files in territory**, ~6,400 LOC. All referenced by `manifest.json` or
  `bridge.html`; no orphans.
- **Major redundancy at staffOverview**: `content_personelManagement.js`
  (legacy, 175 LOC, jQuery, auto-clicks salary buttons) and the modern
  `modules/crew-management/**` slice (10 files, gated POST applier) BOTH inject
  on `https://*.airlinesim.aero/action/enterprise/staffOverview*` via two separate
  `content_scripts` blocks (manifest lines 691–711). Two appliers, two storage
  schemas, partly overlapping responsibilities.
- **5× `content_finance_*.js` are NOT overkill** — each is a tiny (40–60 LOC)
  per-URL anchor-detector + scrape kicker. AS routes the four sister pages
  (`/leasing`, `/capital`, `/assets`, `/cashflow`) at distinct paths, so each
  needs its own match pattern. Aggregating into one `content_finance.js` would
  not save bytes (manifest still needs one match pattern per URL).
- **Command-bridge is NOT a bus duplicate** — it lives only on the dedicated
  `bridge.html` extension page (chrome-extension://...). Cross-tab signals use
  `chrome.storage.onChanged` (correct mechanism for an extension-page context;
  the in-tab `AesDataBus` doesn't reach extension pages). Different layer, not
  duplicate.
- **`_background/**` is not "private" in any meaningful sense** — the leading
  underscore is a sort-prefix to keep the SW-imported modules grouped at the
  top of `modules/`. All 13 files are imported by `background.js`'s
  `importScripts()` chain. Clean separation; thin shim.

Counts: **KEEP 38, CUT 1, FIX 3, DEFER 2, STREAMLINE-top-4**.

---

## KEEP

These earn their bytes. Working, in-scope, well-factored.

### Accounting (10/12 keep)

1. `modules/accounting/snapshot-store.js` — central Storage wrapper
   (`<server><airlineCode>accounting:<type>:<weekId>` plus `:index`,
   `:leasing/capital/assets/cashflow`). 200-cap FIFO history. Bus-emits
   `data:accounting:snapshot:updated`. Load-bearing — every accounting consumer
   reads through it.

2. `modules/accounting/income-scraper.js` — Income-Statement parser
   (5 totals: Revenue, EBIT, EBT, Adj-EBITDA, EBITDA). Reads `weekClosesAt`
   from page footer for the canonical `weekId`.

3. `modules/accounting/balance-scraper.js` — Generic active-tab table
   walker. Slice 1.5 will sharpen but lossless capture is correct now.

4. `modules/accounting/bank-scraper.js` — Active-tab walker + navbar
   balance shortcut (parses headline cash even when table layout shifts).

5. `modules/accounting/sister-scraper.js` — Generic table-extractor shared
   by all 4 sister pages. Includes a robust empty-state record for
   `assets`-page when fully leased. Right call for slice 2.

6. `modules/accounting/aggregator.js` — Builds the unified ledger across
   topRoutes+aircraftFlights+income+sisters. Pure-shape coercion, no math.
   Has thoughtful account-scoped filtering (prefers `wantAccountId` matches).

7. `modules/accounting/profitability-cuts.js` — Pure functions
   (byHub, byAircraftType, byTail, unitEconomics). `byClassAirlineWide` is
   correctly stubbed pending a perClass primitive — defer-by-design.

8. `modules/accounting/projector.js` — Forward N-week EBIT/EBITDA/cash.
   Three-signal confidence pill matches the ORS-Sandbox 3a vocabulary.
   Solid.

9. `modules/accounting/operating-leverage.js` — DOL + bootstrap CI on EBIT.
   Reads salaries from staff-overview when the user has a pending change
   that post-dates the income snapshot — cleanly handles the one-tick lag.

10. `modules/accounting/reconciliation.js` — Modeled-vs-actual gap analyser.
    `applySuggestion` writes back into RouteAssistantSettings.economics.
    Cross-module consumer; one of two write paths (other is route-assistant).

### Crew-management (modern slice — 9/10 keep)

11. `modules/crew-management/staff-overview-scraper.js` — Reads via
    `<html data-aes-page="staff">` page-marker (set by site-skin). Returns null
    cleanly when not on the page. Computes `payTierPctVsCountry` for both
    current and pending salary. 220 LOC.

12. `modules/crew-management/staff-overview-store.js` — `:latest` (full)
    + `:history` (52-week summary ring). Account-scoped via `AesAccountKey`.

13. `modules/crew-management/staff-overview-applier.js` (no — not
    present; renamed to pay-tier-applier) → see #15.

14. `modules/crew-management/pay-tier-scraper.js` — Form-context harvester
    (Wicket hidden inputs + per-row {id, amount}). Two entry points
    (live-DOM + parseHtml) — exactly the right shape for a gated applier.

15. `modules/crew-management/pay-tier-applier.js` — POST applier with the
    proper two-gate (`applyEnabled` user kill switch + `dryRunOnly` codebase
    gate, defaulting `dryRunOnly: true`). Verified post-write reconcile.
    Consistent with route-assistant/service-profile-applier pattern.

16. `modules/crew-management/pay-tier-apply-log.js` — 50-cap FIFO ring with
    fingerprint-dedup-on-noop. Pattern matches strategy/outcomes ring.

17. `modules/crew-management/personnel-cost-model.js` — Pure analytics
    (byGroup linfit, byRole waste/country-avg deviation, hiring-gap cost).
    Used by accounting/operating-leverage and the strategy panel.

18. `modules/crew-management/staff-pilots-scraper.js` — `/action/enterprise/
    staffPilots` hire-form parser. Throws on login-redirect with `code`
    properties. Static `parseDoc` + instance `scrape`.

19. `modules/crew-management/staff-pilots-applier.js` — Hire/train POST
    applier, plain form-encoded (not Wicket), no PageExpired check. Returns
    `{status, error?}` envelopes — never throws.

20. `modules/crew-management/content-staff-overview.js` — Page-mount
    runner that calls scraper → save → bus-emit, with optional
    `formContext` capture. Derives crew-pressure signal for the strategy
    bus.

21. `modules/crew-management/content-staff-pilots.js` — Tiny seeder for
    pilots page. 22 LOC. OK as-is.

### Station-automation (3/3 keep)

22. `modules/station-automation/storage.js` — Run-state with per-airport
    result keys (`...stationAutomationRun:<runId>:r:<flatIdx>`) — splitting
    avoids RMW races between concurrent worker tabs.

23. `modules/station-automation/country-scraper.js` — Country/region/airports
    walker with defensive parse + tolerant column detection. Used by
    dashboard tab for the queue UX.

24. `modules/station-automation/status-strip.js` — Read-only summary strip
    mounted in two places (Schedule panel + RA header). Token-only styling.
    Tests on `chrome.storage.onChanged` with prefix-narrow filter to limit
    refresh churn.

### Command-bridge (8/8 keep)

25. `modules/command-bridge/menu-installer.js` — Top-bar "BRIDGE" entry
    that routes through `aes:bridge:open` to background `bridge-tab.js`
    for cross-tab dedup. Has a `window.open` fallback if the SW is
    asleep/restarting. **The only command-bridge file injected into AS
    pages** — others run only in the bridge.html extension page.

26. `modules/command-bridge/priority-store.js` — Cross-enterprise NOW/NEXT/
    LATER ring. Single global key (intentionally NOT account-scoped).

27. `modules/command-bridge/priority-board.js` — 3-lane Kanban with HTML5
    drag-drop. Subscribes via `subscribe(cb)` which wraps onChanged.

28. `modules/command-bridge/subsidiary-cards.js` — Renders one card per
    `kinId` from `AesCanopyAffiliations`, deep-links into AS dashboard.

29. `modules/command-bridge/activity-ribbon.js` — Aggregates
    `aesStrategy:journal*` rings across accounts. Has its own watermark
    (`aes:command-bridge:activity:lastSeenAt`) — separate from per-account
    last-seen. Thoughtful.

30. `modules/command-bridge/coalitions-panel.js` — Inline port of
    `modules/canopy/orgs-settings-page.js` styled to bridge tokens. Some
    duplication of CRUD logic (see CUT/STREAMLINE).

31. `modules/command-bridge/opportunities-panel.js` — Read-only over
    `AesStrategyPortfolio.scanAll()`. No AS POSTs.

32. `modules/command-bridge/bridge-app.js` — Page bootstrap. Wires
    masthead/ribbon/subs/board/coalitions/opps. Re-renders on
    `aesAccounts` or `aesCanopy:affiliations` change. Single boot guard
    (`__aesBridgeBooted`).

### _background (13/14 keep — afp-submit-queue is not your turf)

33. `modules/_background/account-registry.js` — L1 single-writer for
    `aesAccounts` + L2.2 migration setters. Tail-promise serialisation —
    correct invariant per HANDOVER §10.

34. `modules/_background/alarms.js` — `aes-cleanup` (6h sweep) +
    `aes-auto-drive` (5min nudge). Idempotent `chrome.alarms.create`.

35. `modules/_background/bridge-tab.js` — `aes:bridge:open` handler with
    cross-tab dedup via `chrome.tabs.query({url})` + window focus.
    51 LOC, well-shaped.

36. `modules/_background/customization-store.js` — Single-writer queue
    for `customization` blob with shallow merge + sentinel
    `null` / `"__CLEAR__"`. Mirror of account-registry pattern.

37. `modules/_background/legacy-defaults.js` — `setDefaultSettings()` for
    `onInstalled`. Idempotent; only seeds when `settings` key absent.

38. `modules/_background/notifications.js` — `aes:notify:long-op` SW
    bridge. The `_aesLongOpClickWired` flag prevents duplicate listener
    registration across SW restarts. Correct.

39. `modules/_background/scrape-routing.js` — Forwards
    `aes:scrape-all:{start,abort,status,reset-breaker}` to
    `globalThis.ScrapeTabPool`. Fail-closed with `tab-pool-not-loaded`.

40. `modules/_background/silent-auto-alarm.js` — Tier 3.3b alarm
    heartbeat. Reads from both legacy `settings.routeAssistant` and the
    per-account `settings.acct.<id>.routeAssistant` slots. Reconciles on
    install/startup/onChanged. Single-tab broadcast (most-recently-active
    capable tab).

41. `modules/_background/site-skin-sync.js` — Bridges `chrome.storage.sync`
    changes (`aes_skin_enabled`, `aes_skin_density`) to AS tabs. Necessary
    because content-script worlds didn't see sync onChanged in live verif.

42. `modules/_background/tab-lifecycle.js` — `aes:tab:close-self` for
    scrape helpers when `window.close()` is refused. ACK-then-close pattern.

43. `modules/_background/vision-capture.js` — `aes:vision:capture-tab` →
    `chrome.tabs.captureVisibleTab` for future LLM co-pilot / vision
    fallback paths. Not yet called by anything found in repo (defer note
    below).

44. `modules/_background/scrape-routing.js` — see #39.

45. `modules/_background/afp-submit-queue.js` — Out-of-territory (Agent 4
    AFP), but documented here for completeness. KEEP.

46. `modules/_background/flight-number-groups.js` — Out-of-territory, but
    KEEP for completeness.

### Root content scripts (5/8 keep)

47. `content_scheduling.js` — RouteAssistantPanel mount + live-price
    capture on `/scheduling/<HUB><DEST>` pages. 135 LOC. KEEP.

48. `content_stationOpen.js` — Worker tab for station-automation runs.
    Session-storage state machine, reconcile-on-load. **Verify with Agent 5
    or live: HANDOVER §"Stations open" still claims this functional. The
    detection patterns (OPEN_ACTION_RE / OPERATING_ACTION_RE) hand-tune AS
    button labels — fragile to UI changes.** KEEP but watch.

49–53. `content_finance_{accounting,assets,capital,cashflow,leasing}.js`
    (5 files, 40–60 LOC each) — KEEP. Each is the per-URL anchor-finder
    that wakes up the scraper on the right page. AS routes the 4 sister
    pages at distinct paths so they need distinct match patterns;
    consolidating into one `content_finance.js` doesn't reduce file count
    in `manifest.json` (still 5 entries) and would lose the per-page anchor
    selectors. Right call as-is.

---

## CUT

1. **`content_personelManagement.js` (175 LOC, jQuery, root)** — Legacy
   self-contained personnel-pay automator. Auto-clicks the salary `<input
   type=submit>` (line 138 `salaryBtn.click()`) **WITHOUT either of the two
   gates** (`apply.enabled` / `dryRunOnly`). Uses the legacy `settings.
   personelManagement` blob (see legacy-defaults.js? — actually not seeded
   there; it's only added on first user interaction). Writes a different
   storage shape (`<server><airline>personelManagement` with `{date,time}`)
   than the modern slice (`crewMgmt:staffOverview:latest`).

   This file PRE-DATES the modern `crew-management/pay-tier-applier.js`
   slice 8 with its proper two-gate model. They both run on
   `staffOverview*` URL via two separate `content_scripts` blocks
   (manifest lines 691–711). Symptoms:
   - Legacy applier may fire while modern applier is in `dryRunOnly:true`
     mode — bypasses the gate the user thinks is protecting them.
   - Two storage keys for "last salary action" — accounting's
     operating-leverage reads `crewMgmt:staffOverview:latest`, but the
     dashboard's "Personnel Management" tab still reads the legacy key.
   - jQuery dependency lives on for one tab.

   **Recommendation: remove `content_personelManagement.js` + its
   manifest content_scripts block, after wiring its dashboard tab UI
   into the modern slice.** Until the dashboard tab migration ships
   (Agent 7's territory), the legacy file is **STREAMLINE-flagged but
   functionally still required** because the dashboard "Personnel
   Management" select-option still routes there. See OPEN QUESTIONS below.

---

## FIX

1. **Manifest duplication on staffOverview** (manifest.json lines 691–711)
   — Two `content_scripts` entries with the same `matches:
   ["...staffOverview*"]`. Chrome dedups load order within one entry but
   not across entries. Both files run; their globals coexist; the modern
   slice's data-aes-page marker (`<html data-aes-page="staff">`) is set
   by site-skin AFTER both injections. Result: order-dependent.
   **Fix (Agent 1's territory):** merge into one block when the legacy
   file is cut (see CUT #1). Otherwise document load-order invariant in
   HANDOVER §10.

2. **`modules/data-models/flight-data.js` is mis-sized as a "module"**
   (line 1–80, 80 LOC) — Single class `FlightData` (used in
   `content_aircraftFlights.js:472` as `new FlightData()`) plus a
   commented-out `FlightDataExample` literal (lines 31–79) that never
   loads anywhere. The folder has ONE file. The `FlightDataExample`
   literal is stale documentation — it's never instantiated, never
   read, never assigned to a global beyond the file scope.
   **Fix:** keep the `FlightData` class (load-bearing — referenced from
   2 manifest blocks), delete the `FlightDataExample` block (stale
   doc-as-code). Optionally fold into `modules/aircraft-flights/aircraft-data.js`
   to retire the data-models folder — but that's cross-territory
   (Agent 4 owns aircraft-flights wiring). Standalone fix: just trim
   the 49 dead lines.

3. **`content_personelManagement.js` typo** (`personel` → `personnel`):
   filename, all storage keys, all settings paths. Per CLAUDE.md §3 rule
   2 ("Storage key prefixes are contract"), the storage key
   `<server><airline>personelManagement` cannot be renamed without a
   migration shim. **Fix when CUT'd:** the typo dies with the file. Until
   then leave it alone. Document in HANDOVER §10 invariants:
   "personelManagement storage key spelling intentional — legacy".

---

## DEFER

1. **`vision-capture.js` (47 LOC)** has zero callers found in the repo
   today. The header docstring mentions "future LLM co-pilot, visual
   scrape fallback paths". Clean implementation, low cost (uses
   permission already granted by the AS host pattern). Defer until at
   least one consumer ships.

2. **Accounting `byClassAirlineWide` cut** (profitability-cuts.js line
   176) — stub returning `{available:false, reason: "..."}`. Deferred
   by design; aggregator.js header documents the missing perClass
   primitive that route-assistant would need to emit. Confirmed
   deferred-by-design.

---

## STREAMLINE (top 4)

1. **Centralise the staffOverview surface.** Consolidate
   `content_personelManagement.js` into the modern crew-management slice.
   Wire the dashboard's "Personnel Management" tab to read
   `crewMgmt:staffOverview:latest` and POST through `pay-tier-applier.js`
   with the two-gate honoured. Net delete: 175 LOC + one manifest entry.

2. **Trim `data-models/flight-data.js` to its 30 working lines.** Drop
   `FlightDataExample` (lines 31–79). Cuts 49 LOC of stale comment-
   pretending-to-be-code. The folder still justifies its existence as a
   stable home for shared shapes.

3. **Coalitions-panel.js dedup vs canopy/orgs-settings-page.js.**
   `coalitions-panel.js` is documented as an "inline port" of the modal
   in canopy. The CRUD logic (create/rename/delete + member add/remove)
   appears duplicated, only the styling differs. Refactor to a shared
   widget that both surfaces consume, OR share a single
   `AesCanopyOrgsCRUD` helper. Roughly 200 LOC duplication. Cross-
   territory (canopy is Agent 3). Defer to coordinated cleanup.

4. **`content_finance_*.js` × 5 share the same MutationObserver
   anchor-detect + 5-second hard-timeout fallback.** Each file repeats
   `findAnchor() / observer / timeout / start()` in 30 LOC. Could be
   extracted to a shared helper (`mountWhenAnchor(findAnchor, start)`)
   in `modules/_shared/`. Saves ~120 LOC, reads cleaner. Low-risk —
   it's pure DOM scaffolding, not write paths. **Suggest Agent 6
   (substrate)** since the helper would live in `_shared/`.

---

## OPEN QUESTIONS

1. **Is `content_personelManagement.js` actually still functional today?
   Does any user invoke the auto-salary loop in 0.6.9-beta?** The
   dashboard's `displayStationAutomation` is the active analog for stations,
   and from `content_dashboard.js` line 65 we see `<option
   value="stationAutomation">` exists. Need to grep
   `content_dashboard.js` for `<option value="personelManagement">` to
   confirm whether the legacy auto-salary tab is still mounted in the AES
   menu — that determines whether the file is dead-code-walking or still
   reachable. If unreachable, CUT immediately. If still reachable from the
   legacy dashboard select, the migration to modern crew-management must
   ship first. **TOP open question.**

2. Does the legacy `personelManagement` settings shape get bootstrapped by
   `legacy-defaults.js`? Quick read says NO (only invPricing, general,
   schedule, stationAutomation, usedAircraftScanner are seeded). So the
   legacy file lazy-creates `settings.personelManagement` on first user
   interaction. If we cut the file, we must also delete any code that
   reads `settings.personelManagement.*` (likely in `content_dashboard.js`).

3. Is `vision-capture.js` future-shipping? If not within 2 sessions,
   consider gating its registration behind a settings flag so the SW
   doesn't carry an unused message handler.

4. The `_background/` underscore prefix — is this intentional convention
   ("loaded by SW, not content scripts") or just a sort hack? If
   convention, document in HANDOVER §10. If sort hack, rename to
   `background-modules/` for clarity (cross-cuts manifest? — no, manifest
   never references this folder; only `background.js` `importScripts()`
   does).

---

## File counts by disposition

| Disposition | Count | Notes |
|---|---:|---|
| KEEP | 38 | All accounting (10), modern crew-management (10), station (3), data-models (1 file kept, 49 LOC cut), command-bridge (8), _background (13 in territory + 2 out), root-content (5 finance + 2 station/sched) |
| CUT | 1 | `content_personelManagement.js` |
| FIX | 3 | manifest staffOverview dup; data-models stale literal; typo (dies with cut) |
| DEFER | 2 | vision-capture; byClassAirlineWide stub |
| STREAMLINE | 4 | items above |

Total files audited: ~48 in territory.
