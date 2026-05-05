# Findings — Agent 7 (Background, Content Entrypoints, Options, Popup)

Phase 1 audit (~30 min). No code edits made yet.

## Summary

10 findings — 0 BUG, 1 WIRING-GAP, 2 QUESTION, 4 INVARIANT-OK (verifications), 3 INFO/DEFERRED.
No territory-internal bugs surfaced; the previously-flagged regex fix is in
place; message-passing is consistent. Two questions for the user that require
external context before I can act.

---

## F-7-001 — credentials.json + login automation: not present in repo [QUESTION]

CLAUDE.md and the AGENT-7 brief both refer to a `credentials.json` and a "login
automation flow" as part of my territory. I see no such file and no login
automation in `background.js`, the bg-modules, the content-scripts I own, or
`options.js` / `popup.js`.

- `find . -name credentials*` → no matches.
- No `chrome.tabs.create` of a login URL, no programmatic POST to
  `/app/login` or similar, in any of my files.
- No "auto-login" or "credentials" tokens in my territory.

Disposition: likely lives outside the extension (Playwright / MCP harness /
user's launch script). Confirm with user before I do anything; per CLAUDE.md
this is read-only/audit anyway. **Question:** is the login flow handled by
your MCP launcher rather than the extension? If so, this brief item is OOS.

---

## F-7-002 — flightId regex fix already shipped [VERIFIED-FIXED]

Brief item 4 (pre-existing bug): `url.match(/\d+/)[0]` picked up "1" from
`free1` hostname.

Current code (`content_aircraftFlights.js:409-414`) uses
`url.match(/[?&]id=(\d+)/)` with explicit comment referencing the legacy bug.
No further action.

---

## F-7-003 — flights[] envelope present [VERIFIED]

`content_aircraftFlights.js:118` includes `flights: flights` on the saved blob;
`getFlights()` (line ~390) extracts `flightNumberId` via the `/com/numbers/`
href and origin/dest IATAs from `<title>` rows. Roadmap G slice 4 confirmed.

---

## F-7-004 — All content_*.js entries map to manifest [VERIFIED]

Disk and `manifest.json` both list the same 19 `content_*.js` files,
including the five `content_finance_*.js` scripts. No orphans, no missing
manifest entries.

---

## F-7-005 — chrome.runtime message types: senders ↔ handlers consistent [VERIFIED]

Cross-grepped every `type: "aes:..."` send call against every handler:

| Type | Handler |
|---|---|
| aes:account:touch | account-registry.js |
| aes:migration:set-version / set-pending | account-registry.js |
| aes:bridge:open | bridge-tab.js |
| aes:customization:patch | customization-store.js |
| aes:notify:long-op | notifications.js |
| aes:scrape-all:{start,abort,status,reset-breaker} | scrape-routing.js |
| aes:vision:capture-tab | vision-capture.js |
| aes:silent-auto:tick (alarm → tab) | sent by silent-auto-alarm.js, consumed in scheduling content |
| aes:auto-drive:tick (alarm → tab) | sent by alarms.js, consumed in scrape-orchestrator/auto-driver.js |
| aes:afp:submit-leg / apply-batch / delete-batch / *-abort | afp-submit-queue.js |
| aes:afp:fill-and-submit (bg → AFP tab) | content_aircraftFlightPlan.js |
| aes:afp:delete-flight-form (bg → flightNumbers tab) | content_flightNumbers.js |
| aes:afp:{apply,delete}-batch:progress (bg → originating tab) | content-side orchestrators |

All `chrome.runtime.onMessage.addListener` async handlers correctly
`return true` to keep the channel open (afp-submit-queue, customization-store,
account-registry, scrape-routing start/start, vision-capture, AFP content
listener). Sync responders correctly `return false`.

---

## F-7-006 — AFP batch pipeline timeouts present and honored [VERIFIED]

`afp-submit-queue.js:40-47` defines all four constants exactly as briefed:
`AFP_BATCH_FILL_TIMEOUT_MS=30000`, `AFP_BATCH_RELOAD_TIMEOUT_MS=30000`,
`AFP_BATCH_INTER_LEG_DELAY_MS=500`, `AFP_BATCH_TOTAL_TIMEOUT_MS=20*60*1000`.

Reload-timeout recovery (lines 272-291): closes the wedged tab, recreates a
fresh one, continues to next leg. **Bounded:** the recreate path inside the
catch block runs once per leg failure; it cannot loop infinitely on the same
leg because the catch only fires per `_waitForTabComplete` rejection, after
which the `for` loop advances. If the recreate itself fails, the function
returns immediately. Good.

Abort path (lines 509-532): sets `state.abort = true`, then closes the tab —
which causes any in-flight `_waitForTabComplete` / `_sendTabMessageWithTimeout`
to reject within one tick. Loop body's abort check at the top of each
iteration catches it on the next leg if the message was already in flight.

Per-aircraft serialisation via `_afpSubmitQueues` Map covers all three
pipelines (single, apply-batch, delete-batch) — they share the same per-aircraft
tail, so they cannot race.

---

## F-7-007 — silent-auto alarm sync correct, single-tab broadcast OK [VERIFIED]

`silent-auto-alarm.js`: registers/clears `aes:silent-auto:tick` based on
`settings.routeAssistant.pricing.{silentAutoEnabled,silentAutoTickMin}`, with
clamp 5–240 (matching panel). Reconciles on `onInstalled`, `onStartup`, and
filtered `storage.onChanged` (only fires when the two relevant fields change).

Broadcast picks the most-recently-active scheduling tab via
`tabs.lastAccessed` desc sort. **Per-Chrome scope verified:** each Chrome
instance's SW only sees its own tabs, so the "single tab per Chrome" guarantee
holds; cross-Chrome dedup happens at the panel via the persisted
`silentAutoLastTickAt` re-read (per the panel-side comment in alarm doc).

`tabs.lastAccessed` is in the stable Chrome API (since 121); not a concern
for current Chrome.

---

## F-7-008 — Customization patch handler documented [VERIFIED]

`customization-store.js`: single-writer queue for `chrome.storage.local
.customization`, shallow recursive merge with two sentinels (`null` → delete,
`"__CLEAR__"` → reset to `{}`). Default schema bootstrap inline if blob
missing. No issues.

---

## F-7-009 — Long-op notification listener: `_aesLongOpClickWired` placement [INVARIANT-OK]

`notifications.js:28`: stores the wired flag on `chrome.notifications._aesLongOpClickWired`.
The flag is held on a chrome API object; it is recreated when the SW restarts
(MV3 SW idle), but so is the listener registration — both are scoped to the
current SW lifetime. The first `aes:notify:long-op` after each restart wires
once. No duplicate-listener risk.

Minor: the `senderTabId` is captured at message-handler time but read inside
the listener closure. Because `_aesLongOpClickWired` only allows wiring once
per SW lifetime, the listener will use the **first** notification's
`senderTabId` for **every** subsequent click in that SW lifetime. This is a
real bug if the user has multiple tabs producing long-op notifications across
the same SW lifetime — clicking a later notification refocuses the wrong tab.

→ Re-categorising as **F-7-009 [BUG]** (low severity, click-routing only).
Fix candidate (Phase 2): move the `addListener` registration outside the
message handler, listener body uses notification ID → senderTabId Map.

---

## F-7-010 — `setDefaultSettings()` is shallow / write-once [DEFERRED-CONFIRMED]

`legacy-defaults.js:86`: only writes if `result.settings` is undefined.
A user with an older install missing a sub-tree (e.g. fresh
`usedAircraftScanner` defaults) won't get a backfill. This matches the
"preserved verbatim from pre-split" doc-comment — intentional — so call this
deferred-confirmed; not in my scope to widen.

---

## F-7-011 — Action click + onInstalled listeners in entry [VERIFIED]

`background.js`:
- `chrome.action.onClicked` (lines 82-91): opens / focuses the
  logicalflow shell tab via `chrome.tabs.query` dedup. OK.
- `chrome.runtime.onInstalled` (lines 96-108): calls `setDefaultSettings()`
  (idempotent guarded inside) then re-registers the declarativeContent
  PageStateMatcher for the `.airlinesim.aero` host. **Note:** other modules
  (silent-auto-alarm, alarms.js) also have their own onInstalled listeners
  — Chrome supports multiple listeners on the same event, no conflict.

---

## F-7-012 — Options page sync round-trip [VERIFIED]

`options.js:23-52`: only `aes_skin_enabled` and `aes_skin_density` keys
written to `chrome.storage.sync`. `storage.onChanged` listener filters on
`area === "sync"` for the round-trip. No other sync-area writes anywhere in
my territory (grep'd `chrome.storage.sync.set` across owned files: only
options.js).

---

## F-7-013 — popup.js minimal, no AS POST risk [VERIFIED]

`popup.js`: 10 lines, only stamps version + opens options page. No state, no
network, no message-passing.

---

## Top issues I'd fix in Phase 2 (in priority order)

1. **F-7-009** — long-op notification click routes to first-ever sender's tab.
   Move listener registration to module top; track `notifId → senderTabId`
   in a Map; clear entry on click or after a TTL. ~15 line change in
   `modules/_background/notifications.js`.

2. **F-7-001** — confirm with user whether credentials.json/login flow is
   inside or outside the extension. If outside, drop the brief item; if
   inside, point me at where it lives so I can audit it.

That's it. Everything else in territory is wired correctly per spec.

## Open questions

- Q1 (F-7-001): is the login flow extension code or harness/MCP code?
- Q2: should F-7-009 be fixed in this session or deferred? It only affects
  refocus-on-click of stale long-op notifications — not data-correctness,
  just UX.

## Handoff notes

If Phase 2 proceeds: only `notifications.js` edit needed in territory.
No manifest changes, no bus-topic additions, no new permissions.

---

# Phase 2 — 2026-05-01

## F-7-009 [FIXED] long-op notification click routes to first-ever sender

`modules/_background/notifications.js` rewritten:

- `chrome.notifications.onClicked` listener moved to module top-level so it
  registers exactly once per SW lifetime (preserves the
  `_aesLongOpClickWired` guard semantics).
- Per-notification `senderTabId` now stored in a module-scoped
  `Map<notifId, tabId>`; click handler reads from the map, then deletes the
  entry. No more closure-captured stale tab id.
- `notifId` adds a random suffix so two notifications created in the same
  millisecond can't collide.
- Each map entry self-evicts after 10 minutes to bound memory if a user
  ignores many long-op pings.

Verified `node --check` clean. No bus topics added, no message types
added, no manifest impact. Behavior change is invisible unless multiple
long-op notifications are produced from different tabs in one SW lifetime
— in which case clicks now refocus the correct tab instead of the first.

## F-7-014 [BLOCKED] H-001 settings-writer migration depends on Agent 1

Picked up from Agent 8's F-8-005 cross-call. 24 of the 25 in-territory
sites are in legacy `content_*.js` files; the 25th
(`modules/_background/legacy-defaults.js:88`) is the intentional
first-install bootstrap and is excluded from migration.

**Blocker:** the five legacy content_*.js manifest entries don't include
`modules/_shared/settings-bridge.js`, so `window.AesSettings` is undefined
in those scripts. Migration to `AesSettings.saveArea()` is a no-op without
the bridge.

**Action taken:** filed `audit/manifest-requests.md` request asking
Agent 1 to prepend `modules/_shared/settings-bridge.js` to entries 2, 3,
4, 5, 13. Once that ships, migration is mechanical (~24 sites, one-line
edits, one bucket per area: `flightInfo`, `invPricing`,
`personelManagement`, `general`, `routeManagement`, `competitorMonitoring`,
`schedule`, `stationAutomation`, plus the dynamic
`settings[tableOptionsRule.tableSettingStorage]` site at
`content_dashboard.js:2530/2692`).

**Why each writer maps cleanly to one area:** I traced the five files; in
every case the surrounding code mutates exactly one top-level `settings.<area>`
property before the write, so `saveArea(area, settings[area])` is a faithful
replacement. No multi-area writes in territory.

## Updated summary

13 findings — 1 BUG-FIXED (F-7-009), 1 BLOCKED-cross (F-7-014), 1 QUESTION
resolved by Agent 8 (F-7-001 — confirmed harness/launcher, not extension),
plus the 10 Phase 1 entries unchanged.

---

# Re-audit — 2026-05-01 (post /clear, fresh context)

Walked the territory again to confirm prior findings and check for drift.
Conclusion: prior findings hold; nothing new in territory; F-7-001 needs a
small correction on credential location.

## R1 — Prior fixes in working tree, NOT yet committed [HANDOFF]

`git status` shows three in-territory files modified vs origin (and not yet
committed):

- `modules/_background/notifications.js` — F-7-009 fix from prior session.
  Verified the diff is exactly what F-7-009 says it should be: top-level
  listener with `Map<notifId,tabId>`, random suffix, 10-min self-evict.
- `content_aircraftFlights.js` — five fixes prefixed `F-9228-803/804/806/
  809/810` from a sibling-worktree session (popup-blocker handling on
  Extract All, defensive null-chain on CM5.Total, save-failure logging,
  XFER-row gating, skip-row instead of throw). Authored before this session;
  not mine. `node --check` clean. No new POSTs, no gate weakening, no
  storage prefix changes.
- `content_dashboard.js` — `F-9228-100` adds a `#aes-section=…` URL-hash
  override for `defaultDashboard`, so external affordances can deep-link a
  pane. Authored before this session; not mine. Read-only in effect on
  refresh; no AS POST involved.

Background.js also gained a `chrome.action.onClicked` handler that opens
`tools/logicalflow/index.html` (vs the old AS-shell-tab dedup the prior
F-7-011 described). Same author/session as F-9228-* above. Behavior:
single-tab dedup via `chrome.tabs.query({url})`, focuses window. OK.

**Action:** none in audit phase. If user wants me to commit the F-7-009
fix and leave the F-9228-* set untouched (they're in territory but
authored elsewhere), that's a one-commit task in Phase 2.

## R2 — F-7-001 correction: credentials.json IS in repo [VERIFIED-CORRECT]

Prior F-7-001 said "credentials.json not present". Re-checked:
`audit/credentials.json` exists, gitignored (`.gitignore:11`), template
shipped with empty values, real values populated locally by the user. The
extension itself never reads it — `audit/scripts/cdp-login.py` (CDP-driven
test login) is the sole consumer.

So the brief's "credentials.json in the repo root" line was off-by-one on
location, and the login automation is harness code (Agent 8 / user
launcher), NOT extension code. Prior question stands resolved: Agent 7
territory does not include credentials handling.

## R3 — F-7-014 blocker still active [STILL-BLOCKED]

Re-confirmed via manifest scan: entries 2, 3, 4, 5, 13 (loading
`content_inventory.js`, `content_fligthSchedule.js`, `content_settings.js`,
`content_dashboard.js`, `content_personelManagement.js` respectively) all
still LACK `modules/_shared/settings-bridge.js` in their `js` array. 24
direct-`{settings:settings}` writers across those 5 files remain
un-migrated. Manifest request from prior session in
`audit/manifest-requests.md` is unchanged; Agent 1's findings do not yet
acknowledge the request.

Per-file counts re-verified: dashboard 12 local.set / 11 settings + 1
dyn-key (`tableOptionsRule.tableSettingStorage`); settings 5/5;
personelManagement 6/5 + 1 typed blob; fligthSchedule 3/1 + 2 typed;
inventory 5/3 + 2 typed. Migration scope unchanged from F-7-014.

## R4 — Territory boundary question [QUESTION]

Prior Phase 2 fix landed in `modules/_background/notifications.js`. The
territory matrix in CLAUDE.md §4 says Agent 7 is forbidden from "anything
inside `modules/**`" — but the AGENT-7.md brief explicitly assigns
"Notifications listener wired ONCE via `_aesLongOpClickWired` flag" as a
verification + fix item, and `modules/_background/` is by naming
convention the SW's split-out modules (afp-submit-queue, silent-auto-alarm,
notifications, etc.) that the brief's "background.js message handlers"
section catalogs.

**Question for user:** is `modules/_background/**` Agent 7's de facto
territory (per the brief's content), even though the matrix says no `modules/**`?
If yes, the prior fix and any future ones there are in-bounds. If no, the
prior fix should be reverted and re-filed as a request to Agent 6 / Agent 1.

I'm reading the brief as authoritative since it's specific and the matrix
is generic, but flagging for user disposition.

## R5 — Spot-check of message-handler return-true semantics [VERIFIED]

Re-grepped for all `chrome.runtime.onMessage.addListener` in territory and
confirmed each async handler `return true` at the right path:

- `modules/_background/afp-submit-queue.js` — three async handlers (submit-
  leg, apply-batch, delete-batch) each `return true`. Sync abort handler
  `return false`.
- `content_aircraftFlightPlan.js:54` — async fillAndSubmit, `return true`.
- `content_flightNumbers.js:61` — sync `sendResponse` BEFORE `form.submit`,
  `return false` documented inline (the form POST navigates the tab away;
  responding sync first avoids losing the channel).
- `modules/_background/notifications.js:58` — sync, `return false`.
- `modules/_background/scrape-routing.js`, `account-registry.js`,
  `customization-store.js`, `vision-capture.js` — verified prior session;
  no change.

No regressions on async-channel semantics.

## R6 — Top issues to fix in Phase 2 (revised order)

1. **Commit the F-7-009 fix** (in working tree but uncommitted) so the
   notifications behaviour is durable. ~1 commit, 0 LOC change beyond
   what's already in the diff.
2. **F-7-014** — still blocked on Agent 1's manifest update. Once
   bridge.js lands in entries 2/3/4/5/13, the migration is ~24 mechanical
   one-line replacements. Will land same-day.
3. **R4 territory question** — needs user nod before either committing in
   `modules/_background/**` or reverting+re-filing.

Nothing else surfaced in this re-audit. Territory is in good shape.

## Final summary (as of re-audit)

14 findings — 1 BUG-FIXED-uncommitted (F-7-009), 1 BLOCKED-cross
(F-7-014), 1 QUESTION (R4), 11 verified/deferred. No new bugs surfaced
this pass. Two HANDOFF items: commit F-7-009, await Agent 1 manifest
batch.

---

## R7 — Cross-territory edit, single-agent slice (2026-05-03)

Single-agent session (no parallel agents this run) shipped the
`flightsPrices?adjust=true` formula→applier bridge slice. Two edits
landed in Agent 7 territory; flagging here so a future consolidation
pass picks them up.

### F-7-015 — `content_flightInfo.js` extended scrape

**Disposition:** [WIRING-EXTENSION] — additive only, no regression risk
to existing readers.

**What changed:** added `getLoads()`, `getPrices()`, `getRoute()` and
extended `getData()` so `flightInfoData` now includes:
- `loads.{Y,C,F,Cargo}.{capacity, bookings, loadPct}`
- `prices.{Y,C,F,Cargo}.{unit, min}` — the AS-stated **Minimum Price** is
  the load-bearing new field; downstream the bridge uses it as a hard
  apply-time floor in `RouteAssistantPricingApplier._applyMinPriceFloor`.
- `route.{hub, dest}` IATA codes pulled from the General Flight
  Information block, used by the bridge to index per-route.

The existing `money` (CM rows) field is unchanged; storage key shape
unchanged (`<server><airline>flightInfo<flightId>`).

**Reachability:** existing manifest entry still loads it on the same
matches; no manifest change in this slice for content_flightInfo.

**Cross-territory rationale:** the Min Price floor needs to live
*upstream of the applier* (so silent-auto and any future caller also
get the protection automatically), and that meant capturing it where
AS exposes it — the Flight Information costing page.

**Reviewer ask for next consolidation pass:** confirm the costing-table
selector strategy survives the AS theme dark/light switch (snapshot was
dark theme via theme-dark-44h3O3O4.css). The selectors target structural
classes (`.as-fieldset`, `.legend`, costing tbody index), which should be
theme-independent.

**Tests:** `audit/tests/route-assistant/flights-prices-bridge-aggregation.test.js`
locks down the *aggregation* contract (the JSON shape readers depend on);
the parser itself is verified live against the AS page using the
`flightmoney.html` fixture in repo root.

### F-7-016 — `content_flightsPrices.js` (new)

**Disposition:** [WIRING-NEW] — net-new content script for the AS
`/action/enterprise/flightsPrices?adjust=true` page (HANDOVER §2963's
"deferred" surface). Mounts the AES recommendations panel beside the
native AS bulk-adjustment form; routes Apply through the existing
per-route `RouteAssistantPricingApplier` (no new POST path, no new gate
weakening). Manifest entry added in the same slice.

**Files added:** `content_flightsPrices.js`,
`modules/route-assistant/flights-prices-{scope,bridge,panel}.js`.
**Files modified:** `manifest.json`, `modules/route-assistant/pricing-applier.js`
(min-price clamp helper), `modules/route-assistant/settings-store.js`
(`liveScopes.bulkRecommended` + `minPriceFloor` block), CSS in
`css/components.css`.
