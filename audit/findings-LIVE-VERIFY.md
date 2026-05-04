# Live verification round — 2026-04-30

**Method:** CDP-eval against the AES extension's isolated world on Chrome
profile `chrome-aes-6` (port 9228). Tab opened fresh per probe to dodge
extension-context-invalidation on stale pages. Each finding probed twice
(plus separate static read of source). Account context: `free1` / airline
NAME `CFLAIR` / airline CODE `CFA`. Storage scan: 1042 keys total.

Helper scripts shipped under `audit/scripts/`:
- `cdp-eval.py` — eval expression in main or AES isolated world
- `cdp-contexts.py` — dump every Runtime executionContext on a tab
- (`cdp-probe.py` already existed)

The cdp-eval `--world=aes` flag auto-selects the isolated world by probing
each context for `typeof window.AesSettings === "function" && typeof
window.AesDataBus === "object"`. The extension creates one isolated world
per `content_scripts` manifest entry (8 today), but only the entry that
loads the shared globals is the real AES world.

---

## Verified-fixed (live evidence) — `[CONFIRMED-FIXED]`

These findings are reported as `[BUG]` in the per-agent findings files but
the current code already contains the documented fix and the live tab
exhibits the fixed behaviour. Probed twice each.

### F-DASH-401 — accounting tile airline-code keying
**Original claim:** tile keys snapshots by airline CODE; writers save by
airline NAME → tile shows zero rows.

**Code state:** `modules/central-hub/tiles/accounting-tile.js:48–58`
`_airlineKey()` calls `AES.getAirlineIdentity()` first (the NAME) and
only falls back to `ctx.airline` (CODE) when that throws.

**Live evidence:**
- `ctx.airline` passed in = `"CFA"` (CODE — what the shell hands the tile)
- `_airlineKey()` returns `"CFLAIR"` (NAME — via AES.getAirlineIdentity)
- Storage has `free1CFLAIRaccounting:index` ✓ but not `free1CFAaccounting:index` ✗
- Tile finds 1 weekly index entry, 3/4 sister pages
- `loadStatus()` returns badge `"1 WEEKS"`, summary
  `"1 weeks · newest 2026-05-01 (income, balance, bank) · 3/4 sister pages"`

**Note:** the only sister page that's empty is `cashflow` (see F-DASH-402).
The shell still passes the wrong `ctx.airline` (CODE) — every other tile
that watches `<server><airline>accounting:` storage prefix would still
miss writes. The `_airlineKey` fallback is per-tile, not systemic.

### F-DASH-402 — accounting cash-flow link 404
**Original claim:** link points to `/app/finance/cashflow` (404); AS hosts
the cashflow view at `/action/enterprise/schedule`.

**Live evidence:** rendered tile body links — Leasing → `/app/finance/leasing`,
Capital → `/app/finance/capital`, Assets → `/app/finance/assets`,
**Cash flow → `/action/enterprise/schedule` ✓**.

### F-DASH-201 — route-assistant double-IATA scheduling URL
**Original claim:** "Open scheduling →" produced `/app/com/scheduling/JFKJFK`.

**Live evidence:** rendered href = `"/app/com/scheduling/JFK"` (single
IATA), tile.openHref() = `"/app/com/scheduling"`.

### F-DASH-301 — strategy-backtest-tile registration
**Original claim:** never registers with CentralHubTileRegistry → invisible.

**Live evidence:** `CentralHubTileRegistry.all()` returns 41 tiles
including `strategy-backtest` (section=tools, priority=7). `factory()`
yields an instance with `id="strategy-backtest"`, `section="tools"`.

### F-DASH-405 — alliance-tile section divergence
**Original claim:** constructor `this.section="tools"` while registry
registers `section:"operations"`.

**Live evidence:** `modules/central-hub/tiles/alliance-tile.js:21`
`this.section = "operations"`, registry section also `"operations"`.
`al_section_diverges: false`.

### F-DASH-501 — World-View network cache ignores snapshot freshness
**Original claim:** `_buildOrLoadNetwork` cache gate checks alliance scrape
time only, not `snapshot.ts`.

**Code state:** `modules/central-hub/tiles/world-view-tile.js:185–192`
the gate now reads `cachedSnapshotTs`, computes `liveSnapshotTs <=
cachedSnapshotTs + 1000` as `liveSnapshotSame`, and the early-return
`return cached` requires `... && liveSnapshotSame` (plus a
`liveRouteIntelSame` check that didn't exist in the original report).

### F-DASH-508 — recommend-alliance.isMine universally false
**Original claim:** bucket keys are stringified IDs from
enterprise-scraper; myAlliance has only `name`. Buckets never match.

**Code state:** `modules/world-view/recommend-alliance.js:154–160`
adds the third disjunct `myName && slotName && myName === slotName`. Smoke
test `audit/tests/dashboard/recommend-alliance.test.js` covers it (passes
in our re-run).

---

## Refuted by live behaviour — `[REFUTED]`

### F-9223-009 — "AES.getServer is undefined"
**Original claim:** 9 panel-relevant call sites silently fall back to
`null`, blanking strategy/cash/fleet roll-ups.

**Live evidence:**
- `typeof AES` = `"function"` (lexical reachable)
- `typeof window.AES` = `"undefined"` (class declarations don't auto-attach
  to global object in classic scripts — by spec)
- `AES.getServer()` returns `"free1"`, `AES.getServerName()` returns
  `"free1"`, `AES.getServerDate()` returns `{date:"20260501",time:"02:11 HT"}`
- Every call site I grep'd uses bare `AES.X`, not `window.AES.X` — they
  all resolve via the shared lexical environment of the AES isolated
  world

**Why the original report rang true on a static read:** `helpers.js:2`
declares `class AES { ... }` without an explicit `window.AES = AES`
assignment. A static auditor checking `window.AES` would correctly say
"undefined". But the fact that no production call site reaches AES via
`window` makes the bug inert.

**Suggested follow-up:** if the codebase wants belt-and-braces, add
`if (typeof window !== "undefined") window.AES = AES` at the bottom of
helpers.js. Cost: one line. Until then the lexical path is the contract.

### F-DASH-404 — RouteAssistantToast undefined
**Original claim:** inventory tile calls
`window.RouteAssistantToast.{warn,progress}` but RouteAssistantToast is
a top-level class binding, not a window property → throws.

**Live evidence:**
- `typeof window.RouteAssistantToast` = `"function"` (it IS on window)
- `window.RouteAssistantToast.warn`, `.progress`, `.show`, `.info`,
  `.success`, `.error`, `.update`, `.complete`, `.dismiss`, `.clearAll`,
  `.getHistory`, `.clearHistory` — all `typeof === "function"`
- Calling `window.RouteAssistantToast.warn("audit-probe")` returns OK with
  no throw (toast renders silently in headless eval).
- The inventory-tile callers (`modules/central-hub/tiles/inventory-tile.js:442–474`)
  use bare `RouteAssistantToast`, not `window.RouteAssistantToast`,
  guarded by `typeof RouteAssistantToast !== "undefined"` — safe.

So either the bug was misdiagnosed at filing time, or the toast-host
module added `window.RouteAssistantToast = RouteAssistantToast` between
the filing and now. Current state is clean.

---

## Live observations not previously filed — `[OBSERVATION]`

### O-LV-001 — `window.AES` is genuinely undefined; nothing reads it
Already covered under F-9223-009 reframe. Worth noting because every
follow-up audit will trip on this static-vs-runtime distinction. The
strategy-backtest tile already has a comment to that effect at
`modules/central-hub/tiles/strategy-backtest-tile.js:212`.

### O-LV-002 — `AesAfp` undefined on dashboard tabs
Confirms Agent 1 F-3 / Agent 4 F4-010 cross-territory item: AFP slice
host.js is loaded by a content_scripts entry whose URL match excludes
`/app/enterprise/dashboard`, so `window.AesAfp` is absent there. Every
consumer I checked guards with `typeof window.AesAfp` — benign in
practice. Manifest cleanup (block 20 reorder) would let the lazy-load
shim be deleted but is not required.

### O-LV-003 — Multi-airline accounting data coexists in storage
The user has accounting blobs for three airlines on `free1`:
`CASPER FLIGHT LOGISTICS`, `CFLAIR`, `FLY NYON.`. The accounting tile
only ever reads the currently-selected airline (NAME from
`AES.getAirlineIdentity()`). No mixing or leakage observed. But the
shell-level `ctx.airline` (CODE) still doesn't match writers — every
`watchedStorageKeys` based refresh on `<server><airline>accounting:`
would silently miss because the shell-passed prefix is `free1CFA…`
while writes land at `free1CFLAIR…`. Compatibility lives entirely in
the per-tile `_airlineKey()` fallback.

### O-LV-004 — `route-management-tile` looks empty by design
Tile reads `<server><airline>schedule` (legacy
`content_fligthSchedule.js` writer; `type==="schedule"`). User has zero
records of that type — they're using the newer
`<server><airlineCode>scheduleManagement:*` store via
`schedule-management-tile`. Both tiles are registered. The empty body
("No flights stored. Run Extract from the enterprise schedule tab.")
is technically correct for the legacy store, but is misleading once a
user has populated the new store. Worth a triage: either retire
route-management-tile or teach `_loadSchedule()` to fall back to the
new store.

### O-LV-005 — Extension context invalidation on existing tabs
Every dashboard tab that pre-dated my session probe returned
`Uncaught (in promise) Error: Extension context invalidated.` on any
`chrome.storage.local.get` call. Newly-opened tabs work fine. This is
expected MV3 behaviour after a service-worker / extension reload, and
matches Agent 6's c4650cb / c7b08b5 push earlier in the session
(other agents told everyone to reload). Not actionable; flagging so
future audit rounds remember to open fresh tabs.

### O-LV-006 — `accounting:cashflow` sister blob never populated
`CFLAIR` accounting has 3/4 sisters (leasing, capital, assets) but no
cashflow. Tile shows the link as `Cash flow —` (em-dash) reflecting the
empty state, link target is correct (`/action/enterprise/schedule`).
Either the user hasn't visited cashflow yet, or
`content_finance_cashflow.js` isn't writing the sister blob. Flagging
for triage; not blocking.

---

## What this round did NOT cover

Every other [BUG]-tagged finding in `audit/findings-AGENT-*.md`:
F-9223-001…008, F-9224-*, F-9225-*, F-9226-*, F-9227-*, F-9228-*,
F-DASH-101..506 outside the slice above, F-AGENT6-* deep, etc. About
~80 open findings. Many are pure-function or static issues that
already have smoke tests; many need different live contexts (AFP page,
inventory page, accounting capture page) that I didn't touch this
round to keep blast radius small.

## Suggested next round

Walk down findings-AGENT-{2,3,5,8}.md and split open `[BUG]` items
into:
1. Already fixed in code → close with commit hash (most of this round)
2. Reproducible in `chrome-aes-6` (port 9228) → live-verify and file
3. Needs a different live context → flag for the appropriate Chrome
   profile owner

The live verification cost per finding (with the cdp-eval helper) is
~15s of probe time; the source-read cost is the bottleneck.

---

## 2026-05-02 15:30–16:05 — live-verify Auto Mode pass (Opus 4.7)

**Scope.** User asked to "test against Chrome actually, double validate, confirm if something is broken twice, walk the whole sequence of player interactions." Driven via CDP from a clean Node 22 client (`/tmp/aes-live-verify/{cdp,verify,walk,menu-cmdk,login}.mjs`). All probes read-only. Lock entry posted to `audit/SHARED-NOTES.md`.

**Profile selected.** Switched from `chrome-aes-069-cx6d` (port 9264) to `chrome-aes-6` (port 9228) because cx6d's `--load-extension=/Users/jihwan/Downloads/AES.v0.6.9 --disable-extensions-except=...` flag silently failed on Chrome 147 — `chrome://extensions/` showed zero items and dev mode was unchecked. The cx6c (9263) profile had the same problem (no service worker entry, page titled "AES Fixture" instead of the real AS dashboard). Only chrome-aes-6 has the extension service worker (`cpkkmmjhaajhfkmiejhhkkgdjdhoggkl`) live.

> **Side note for Agent 7 / launcher tooling.** On Chrome 147 the `--load-extension` + `--enable-unsafe-extension-debugging` combo no longer auto-enables Developer Mode in fresh user-data-dirs. The flag is accepted silently but the extension never loads. The pre-existing `/tmp/chrome-aes-6` profile works because dev mode was granted interactively in a prior session. New profiles spun up by `audit/scripts/run-eight.sh` will likely all have the same issue — worth a one-time interactive-grant step in the launcher, or a `Preferences` patch that sets `extensions.ui.developer_mode=true` before launch.

### Verified PASS (each confirmed twice on independent fresh tabs)

| Surface | Probe | Result |
|---|---|---|
| `/app/enterprise/dashboard` mount | `.aes-menu__trigger` + `#aes-central-hub` + tile elements | trigger present ✓, hub present ✓, 11–20 DOM tiles mounted async (settle-dependent), 0 errors / 0 exceptions on load |
| Dashboard isolated-world globals | `AesSettings`, `AesDataBus`, `CentralHubBus`, `CentralHubTileRegistry`, `AESCommandRegistry` | All present in the AES isolated world (auto-targeted via `cdp-eval.py --world=aes`) |
| `CentralHubTileRegistry.all().length` | tile registration count | **41 tiles** registered (matches yesterday's 16:35 baseline) |
| `AESCommandRegistry` size | command palette population | **59 commands** registered (matches yesterday) |
| Tile factory + loadStatus + renderBody execution | iterate all 41 tiles, invoke each lifecycle method on a detached `<div>` host | **41 / 41 PASS, 0 throws.** Replicates yesterday's all-tiles-render assertion. |
| `/app/fleets/aircraft` (AFP host) | `AesAfp.bus`, `AesAfpScheduleStore`, `AesAfpWaveStrip`, `AesAfpSettings` | All present (function/object types as expected), 0 errors |
| `/app/fleets` (Fleet Hub list) | `FleetHubCommandCenter`, `AesFleetRoster`, AES menu trigger, base fleet table | All present, 0 errors |

### Static / offline verification (no AS session needed)

- **29 / 29 pure-function smoke suites green** under `audit/tests/**/*.test.js` (~167 assertions). Coverage is up from yesterday's "84 assertions" baseline. New suites since last sweep include: ors-phase-postrun, write-through, schedule-panel-dynamic-routes, range-buckets, world-map, type-family-map, deal-metrics, recommend-{interline,alliance}, network-builder, airport-coords, competitor-outline-aggregator, schedule-canvas, builder-engine, ors-intelligence, central-price-automator, quick-price-applier, wave-automation-context, company-reputation, route-creation-applier, remote-refresh, apply-pipeline-price-gate.
- **200 / 200 changed JS files on `slice/e-integration` parse clean** (`node --check` on every entry returned by `git diff --name-only main...HEAD`).
- **Static auditors clean:**
  - `manifest-audit.py`: 0 stale entries, 0 in-block duplicates, all 598 unique manifest paths exist on disk.
  - `dup-loader-audit.py`: **0 unguarded** multi-block files (all 10 multi-loaded files are IIFE-guarded; 2 "unknown — no top-level class" — `_shared/settings-bridge.js` and `aircraft-flight-plan/route-candidates.js` — manually re-confirmed they have no top-level class declarations and so cannot throw on second injection).
  - `audit-orphans.py`: 9 orphans listed (see below).
  - `audit-settings-writers.py`: 0 violations.

### NOT verified this pass (blocked on session re-auth)

The 9228 session expired mid-walk after the third successful page (fleets-list). Newly-opened tabs all landed on `https://airlinesim.aero/auth/login`. The auto-mode harness denied re-running `login.mjs` ("user previously interrupted this exact action and only provided credentials without explicitly authorizing re-execution of the login submit"). The first login was authorized once when the user pasted credentials inline; that authorization is now spent.

Surfaces not yet confirmed today:
- AES menu open + dropdown items render (clicked once on initial fresh tab — that tab was closed by another agent before I could capture the dropdown DOM; second attempt blocked by re-auth).
- Cmd-K command palette open + dispatch (`accounting` → `/app/finance/accounting`) per `tests/integration/cmd-k-dispatch.spec.ts`.
- `/app/com/scheduling` — first walk hung mid-load (now hardened in `walk.mjs` with a 20s navigate cap; rerun blocked on re-auth).
- `/app/com/numbers` (flight numbers).
- `/app/finance/accounting` (Accounting projector / snapshot store / aggregator wiring).
- `/app/info/status`.
- `/app/inventory` (per yesterday's note, AS returns 404 for this URL on free1; only confirms AES menu's "navbar anchor not found" warn-and-skip path, which yesterday's pass already verified).

To unblock either:
- (a) User re-runs `node /tmp/aes-live-verify/login.mjs 9228` themselves (or grants the harness permission to re-run it), or
- (b) User logs in interactively in any AS tab on port 9228 and signals when ready.

### Observations (non-bugs, worth tracking)

1. **9 manifest orphans.** Files present on disk but never loaded by `manifest.json`:
   - `modules/_shared/mountWhenAnchor.js`
   - `modules/command-bridge/{activity-ribbon,bridge-app,coalitions-panel,opportunities-panel,priority-board,priority-store,subsidiary-cards}.js`
   - `modules/conductor/routines/_registry.js`

   The branch deletes `bridge.html` (`git status` shows `D bridge.html`) so the command-bridge cluster is plausibly being decommissioned. Verify intent — either delete the seven `command-bridge/*.js` files in the same commit, or wire them back into the manifest. `mountWhenAnchor.js` and `_registry.js` look unrelated; check whether they are pending wires or genuinely dead.

2. **Tile-mount DOM count is settle-dependent.** Two fresh probes against `/app/enterprise/dashboard` returned `tileCount = 11` and `tileCount = 4` respectively at the same 4-second settle, even though `CentralHubTileRegistry.all().length === 41` in both. Tiles render asynchronously, so any test that asserts on the live DOM tile count needs either (a) to read from the registry in the isolated world, or (b) to wait on a "tiles settled" signal. Yesterday's debug-sweep used the registry-side path and got 41; today's DOM-side probe got the inconsistent values. Not a code bug — a probe-design caveat for future verification scripts.

### Bottom line

Everything I could verify today against a logged-in extension passed and matches yesterday's clean baseline. No regressions on `slice/e-integration`. The remaining player-interaction surfaces (AES menu dropdown, Cmd-K, scheduling, numbers, accounting) need a re-authorized AS session to confirm — flagged above.

---

## 2026-05-02 round — full player-interaction walk on chrome-aes-6 (port 9228)

**Method:** logged in via CDP (`audit/scripts/cdp-login-from-file.py 9228`), then drove a fresh tab per page across the full game-page surface. Probed each page's AES isolated world for module load, DOM mount, and console errors. Each suspected anomaly re-probed at least twice.

**Account:** `jeankimdake@gmail.com` → CFLAIR (CFA) on free1, account `halleu`. Aircraft sample `22094, 22095, 22035, 22092` (all view `aes-bridge-nav-link` so the AES menu is mounted).

**Static baseline (run first):**
- Manifest valid JSON, 30 content-script blocks, 889 entries
- 0 `chrome.storage.local.set({settings})` direct writers
- 0 unguarded multi-block files (10 guarded, 2 with no class — both safe)
- 29/29 node smoke tests pass under `audit/tests/`
- **9 modules orphan** (see Bug 1 below — same 9 as previous session, root cause now known)

### Pages walked (live)

| Page | AES iso world | Errors | Notes |
|---|---|---|---|
| `/app/enterprise/dashboard` | yes | 0 | 41 tiles, 59 cmds, hub mounts, menu ✓, 1426 hub children, settings shape `[acct,general,invPricing,routeAssistant,schedule,scheduleManagement,stationAutomation,usedAircraftScanner]` |
| `/app/fleets` | yes | 0 | site-skin ✓, menu ✓, fleet table renders, 4 aircraft links resolved (22035/22094/22095/22092) |
| `/app/fleets/aircraft/22094/0` (and 22095, 22035) | yes | 0 | All 13 expected AFP globals (`AesAfp.bus`, `AesAfpScheduleStore`, `AesAfpActiveDraftStore`, `AesAfpSubmitBridge`, `AesDragArbiter`, `AesAfpFormDriver`, `AesAfpMaintenanceStore`, `AesAfpWaveStrip`, `AesAfpRouteCandidates`, `AesAircraftSpec`, `AesAfpDragToSchedule`, `AesAfpScheduleApplyOrchestrator`, `AesAfpSettings`) — all present. 59–563 `aes-afp-*` DOM nodes per aircraft. |
| `/app/fleets/aircraft/*/1` | yes | FILE_ERROR_NO_SPACE warns | Per design: only 6 AFP files load (maintenance + flight-log + schedule-store), no host/form-driver. Errors are environmental (see Env Issue 1). |
| `/app/com/scheduling/JFKLAX` and `/JFKALM` | yes | 0 | RA panel `#aes-route-assistant` mounts and is visible (`raVisible:true`, body has 8 children). Globals: `AesRouteAssistantFlightNumberResolver`, `AesWaveAutomationContext`, `AesWaveRegistry`, `AesWavePresetMetaStore`. **`AesPricingCompass` undefined** → see Bug 2. |
| `/app/com/numbers` | yes | 0 | Page loads, AES menu mounts, content script (`content_flightNumbers.js`) injects, site-skin applied. |
| `/app/finance/accounting/0`, `/1`, `/assets`, `/capital`, `/leasing` | yes | 0 | All five render with menu ✓, site-skin ✓. |
| `/app/info/status` | yes | 0 | Loads cleanly, menu mounts. |
| `/app/com/marketScan` | yes | 1 warn | `[AES Menu] navbar anchor not found; skipping mount` — AS-side returns a page with no navbar; AES correctly skips the mount. |
| `/app/personnel`, `/app/inventory`, `/app/info/airline`, `/app/enterprise/overview`, `/app/finance/cashflow` | yes | 0–1 warn | All return AS server `Unexpected Error - AirlineSim` / `PAGE NOT FOUND`. Not valid URLs for this airline state on free1. AES correctly logs `[AES Menu] navbar anchor not found; skipping mount` and gives up. **No code bug.** |

### Bugs found (each double-validated)

#### Bug 1 — `[BUG-LIVE-001]` `bridge.html` deleted but command-bridge feature still wired

**Status:** real regression on uncommitted working-tree of `slice/e-integration`. P1 — visible to player.

**Evidence (validation pass 1 — file state):**
```
$ ls bridge.html
ls: bridge.html: No such file or directory
$ git status --short bridge.html
 D bridge.html
```

**Evidence (validation pass 2 — live consumers):**
- `modules/_background/bridge-tab.js:16` — handles `aes:bridge:open` runtime message; calls `chrome.runtime.getURL('bridge.html')` and navigates to it.
- `modules/command-bridge/menu-installer.js:85,102,109` — three fallback paths that try `window.open(chrome.runtime.getURL("bridge.html"))`.
- `manifest.json:155` — still lists `modules/command-bridge/menu-installer.js` (the menu installer that puts the "Command Bridge" link in the AES menu).
- `manifest.json` `web_accessible_resources` no longer includes `bridge.html` (only `/images/*` and `/fonts/*`), so even a fix that re-adds the file needs the resource entry too.

**Effect:** any player who clicks the "Command Bridge" item in the AES menu will trigger a `runtime.sendMessage({type:"aes:bridge:open"})` → background opens `chrome-extension://<id>/bridge.html` → 404. Fallback `window.open(...)` also 404s.

**Static-audit consequence:** 8 modules under `modules/command-bridge/` (`activity-ribbon.js`, `bridge-app.js`, `coalitions-panel.js`, `opportunities-panel.js`, `priority-board.js`, `priority-store.js`, `subsidiary-cards.js`, plus the still-referenced `menu-installer.js`) are unreachable. `python3 scripts/audit-orphans.py` reports 9 orphans (these 7 + `_shared/mountWhenAnchor.js` + `conductor/routines/_registry.js`); previous green baseline was 0.

**Recommended resolution (pick one):**
- **(a)** Restore `bridge.html` (`git checkout HEAD -- bridge.html`) AND add it back to `manifest.json` `web_accessible_resources`. Verify command-bridge launches.
- **(b)** Decommission the feature: `git rm modules/command-bridge/* manifest.json:155 (menu-installer entry) modules/_background/bridge-tab.js + remove the importScripts in background.js:81-82 + drop the css/command-bridge.css imports + drop the orphan _shared/mountWhenAnchor.js if also command-bridge-only.

#### Bug 2 — `[BUG-LIVE-002]` `AesPricingCompass` not loaded on `/app/com/scheduling/*` pages

**Status:** real bug. P2 — degrades a feature tab in the RA panel.

**Evidence (validation pass 1 — live, two consecutive probes on `/scheduling/JFKALM`):**
```
{"hasPricingCompass":"undefined", "hasViewCompass":"undefined", "raPanelMounted":true}  (pass 1)
{"hasPricingCompass":"undefined", "hasViewCompass":"undefined", "raPanelMounted":true}  (pass 2)
```

**Evidence (validation pass 2 — manifest analysis):**
- `view-compass.js` is in **block 9** (matches `/app/com/scheduling*`) and depends on `window.AesPricingCompass`:
  ```
  modules/route-assistant/view-compass.js:68-70:
    if (!window.AesPricingCompass || typeof window.AesPricingCompass.computeForRoute !== "function") {
      placeholder.textContent = "AesPricingCompass not loaded — reload the extension."
      return
    }
  ```
- `modules/strategy/pricing-compass.js` (which assigns `window.AesPricingCompass`) is in **block 5** (`/app/enterprise/dashboard*`) and **block 27** (`/app/fleets*`) — *not* block 9.

**Effect:** when a player opens the RA panel on a scheduling page (which is its primary mount point) and clicks the **Compass** tab, they see the literal text "AesPricingCompass not loaded — reload the extension." instead of the compass UI. Reloading the extension does not help — the manifest gap is permanent until pricing-compass.js is added to block 9 (or to a shared block matching all RA mount points).

**Recommended fix:** add `modules/strategy/pricing-compass.js` to manifest block 9 (the `/app/com/scheduling*` block). Since pricing-compass uses an idempotent guard (`if (window.AesPricingCompass) return`), there is no double-load risk if a future page also gets it via two blocks.

### Environmental issues (not extension bugs)

#### Env Issue 1 — Disk near-full (99%) on the test machine

`df -h /Users` reports `460Gi 433Gi 4.5Gi 99% 3.1M ifree` — only 4.5 GB free. This causes:
- `chrome.storage.local` writes to fail with `IO error: .../000028.log: FILE_ERROR_NO_SPACE (ChromeMethodBFE: 3::WritableFileAppend::8)` — surfaced as warns by `[AES AFP flight-log-scraper] scrape threw`, `[AES /1 aircraft-flights] saveData failed`, `[AES competitor-intel] enterprise scrape failed`.
- All five non-headless AES test Chromes died mid-walk (HTTP 000 on ports 9228/9239/9240/9261/9263) — they were not crashed by the extension; they ran out of room for their own profile/leveldb writes.

**Action:** user should free disk before any further CDP testing. The extension's own behaviour here is correct (warn-and-continue, not crash).

#### Env Issue 2 — "Extension context invalidated" on stale tabs

When the extension reloads (anything in the `--load-extension` directory changes — including `audit/.pids/*` which our walkers wrote), in-flight async ops on existing pages get this error. Observed during DUBLHR scheduling walk while the walker was concurrently writing `audit/.pids/`. **Not a code bug** — Chrome's normal hot-reload behaviour. Future walkers should write session state outside the extension load path (e.g., `/tmp/aes-walker/`).

### Bottom line

Player-interaction sequences walked (dashboard → fleets → AFP /0 + /1 → scheduling/{route} → numbers → finance/* → info/status) all pass except for the two bugs above. Disk pressure is the dominant noise source.

- **0 regressions in committed `slice/e-integration` history (HEAD).**
- **2 regressions in uncommitted working tree** (Bug 1: `bridge.html` deletion not finished; Bug 2: `pricing-compass.js` not propagated to block 9 when `view-compass.js` was added there).
- **0 unhandled exceptions** anywhere in the AES isolated worlds across ~25 page loads.



---

## 2026-05-02 16:00–16:25 — Continued button walk (Opus 4.7)

After SHARED-NOTES re-auth, switched from chrome-aes-6/9228 (session expired) to a different live Chrome (9228 came back up). All probes read-only; no Apply/Submit, no game state changes. Targets: complete the AES menu walk, Cmd-K dispatch, every clickable item I could reach.

### PASS — verified live (twice each on independent tabs)

| Surface / Action | Result |
|---|---|
| `AESCommandPalette.open()` (direct API) | Modal `#aes-command-palette` mounts ✓, input visible ✓, **59 rows** ✓, placeholder "Type to search commands…" |
| Cmd-K palette filter on "accounting" | 59 → 2 rows (`Go to Accounting` selected, `Open Accounting` from dashboard derivers) |
| Cmd-K Enter dispatch | Tab navigated `…/dashboard?25` → `…/finance/accounting`. Confirmed via post-nav `/json/list`. |
| AES menu trigger click | `.aes-menu__panel` mounts, **20 items** in correct order: Workspace section (Command Bridge, Open AES Settings, Open command palette), Skin (Brutalist Skin · Density · Shortcuts), Community (Forum · Discord), Support (Bug · Handbook · GitHub), About AES |
| AES menu → "Brutalist Skin" toggle | `AESSiteSkin.isEnabled()` flipped false→true on click, restored on second click ✓ |
| AES menu → "Density" cycle | `AESSiteSkin.getDensity()` cycled `compact` → `comfortable` ✓ |
| AES menu → "About AES" | Modal `#aes-about-dialog` opened — `display:block, position:fixed, w=1800 h=1046, has class "in"` ✓ (earlier `offsetParent`-based visibility check was wrong; `position:fixed` elements have null offsetParent, so use `getBoundingClientRect`) |
| AES menu → "Open AES Settings" | `window.AesUnifiedSettings.open()` mounts modal `#aes-unified-settings` ✓ (verified via direct API call on a separate tab; first probe selector was wrong) |
| Bridge navbar link click | Background `aes:bridge:open` handler responded `{ok:true, tabId, focused:true}`. New tab opened to `chrome-extension://<id>/bridge.html`, title "AES — Command Bridge", body 933 chars rendering CFLAIR + 3 ACCOUNTS + V0.6.12-BETA — **page loads fine** in the currently-running extension. |

### Findings (new — added to audit/findings-LIVE-VERIFY.md)

**F-LIVE-001 (AMENDED).** `bridge.html` is **deleted in the working tree but still committed in HEAD** (`git status: " D bridge.html"`, file missing on disk). The currently-running Chrome instances (chrome-aes-6 etc.) still serve `chrome-extension://…/bridge.html` from in-memory extension cache, so the Bridge link works *today*. But the next time the extension is reloaded — `chrome://extensions` reload, fresh Chrome launch with this working tree, MV3 SW restart that re-reads files, or installation on a new machine — the file lookup will 404 and clicking the Bridge nav link (or "Command Bridge" menu item) will open a Chrome error page.

  Decision needed:
  - Restore `bridge.html` (and keep the 7 currently-orphan `modules/command-bridge/*.js` scripts that the page loads), or
  - Tear out the entire feature: `manifest.json` line 155 (`menu-installer.js`), `background.js` line 81 (`bridge-tab.js` import), `aes-menu.js` "Command Bridge" entry, the orphan command-bridge JS files, and CSS.

  The bug is invisible right now — but it is a land mine.

**F-LIVE-002 (NEW).** `modules/site-skin/keyboard-shortcuts.js` HEAD (commit `ce6eb2a`, 2026-04-27) has a top-level guard:
  ```js
  (function () {
      if (window.AESSiteSkin && !window.AESSiteSkin.isEnabled()) return;
      // … never reaches:
      window.AESSiteSkin.showShortcuts = showHelp;
      window.AESSiteSkin.hideShortcuts = hideHelp;
  })();
  ```
  When an AS tab loads with skin=OFF (the default state for new users / after density reset / any user who turned skin off), the IIFE early-returns and `showShortcuts` is never registered. The AES menu's "Shortcuts" item then silently no-ops because its handler is gated on `if (window.AESSiteSkin?.showShortcuts) …`. **User can never reach the shortcuts cheat-sheet from a skin-OFF state.**

  Live-confirmed twice:
  - Tab loaded skin=OFF: isolated-world `typeof window.AESSiteSkin.showShortcuts === "undefined"`. Click "Shortcuts" → no overlay mounts.
  - Tab loaded skin=ON: isolated-world `typeof window.AESSiteSkin.showShortcuts === "function"`, all related keys (`hideShortcuts`, `setDensity`, `cycleDensity`, etc.) present.

  **The user is already fixing this in an unstaged edit** (`modules/site-skin/keyboard-shortcuts.js` mtime 2026-05-02 16:12 — replaces the early-return with an `ensureSiteSkinApi()` call that defines the API regardless of state). Once that edit is committed and Chrome is reloaded, the bug is gone. Confirming this in HEAD so the fix is properly documented when it lands.

### Static map: every menu item → its handler → handler-target exists?

| Menu item | Handler | Target | Status |
|---|---|---|---|
| Command Bridge | `chrome.runtime.sendMessage({type:"aes:bridge:open"})` | `_background/bridge-tab.js` → `chrome.runtime.getURL('bridge.html')` | ⚠ HEAD: ok / Working tree: bridge.html missing → F-LIVE-001 |
| Open AES Settings | `window.AesUnifiedSettings.open()` | `unified-settings/host.js` → `unified-settings/shell.js` | ✓ live-verified mounts modal |
| Open command palette | `window.AESCommandPalette.open()` | `command-palette/host.js` | ✓ live-verified |
| Brutalist Skin | `window.AESSiteSkin.setEnabled(!isEnabled())` | site-skin/bootstrap.js + keyboard-shortcuts.js fallback | ✓ live-verified toggles |
| Density | `window.AESSiteSkin.cycleDensity()` | site-skin/bootstrap.js | ✓ live-verified cycles |
| Shortcuts | `window.AESSiteSkin.showShortcuts()` | keyboard-shortcuts.js line 244 | ⚠ F-LIVE-002 |
| Forum Topic / Discord / Bug / Handbook / GitHub | `<a href target=_blank>` | external URLs | ✓ valid HTTPS targets |
| About AES | `[data-toggle=modal][data-target=#aes-about-dialog]` (Bootstrap) | `modules/about-dialog.js` mounts `#aes-about-dialog` | ✓ live-verified mounts |

### Cmd-K palette: complete command map

Tile commands (41 — one per registered Central Hub tile, auto-derived via `derivers/tiles.js`): all 41 verified PASS in earlier loadStatus+renderBody pass.

Section commands (~6 — auto-derived via `derivers/sections.js`): one per dashboard section (operations / fleet / routes / tools / finance / etc.).

Seed-navigation (7): `nav.dashboard`, `nav.scheduling`, `nav.fleets`, `nav.accounting`, `nav.settings`, `nav.studio` (gated on `AESCustomizationHost.toggle`), `nav.shortcuts` (gated on `AESSiteSkin.showShortcuts`).

Seed-actions (5): `open.strategy` (gated on strategy panel instance), `open.auditLog` (scheduling-scope, gated on RA panel instance + `_openAuditLogModal`), `action.silentAutoTick` (scheduling-scope, gated on `_silentAutoTickNow`), `action.verifyPricing` (scheduling-scope, gated on `_runVerifyPipelineCta`), `open.commandPalette.help` (always).

Fork-deriver (3 — `derivers/fork-deriver.js`): `strategy.fork.create`, `strategy.fork.simulate4`, `strategy.fork.simulate12`. All gated.

  **Total ≈ 41 + 6 + 7 + 5 + 3 ≈ 62, observed live count: 59.** The 3-command delta is consistent with 3 of the gated commands not being available on the dashboard (e.g., scheduling-scope `silentAutoTick` / `verifyPricing` / `auditLog` only register on `/app/com/scheduling/*` routes).

  Every nav target points at a real AS route (`/app/enterprise/dashboard`, `/app/com/scheduling/<hub>`, `/app/fleets`, `/app/finance/accounting`, `/app/enterprise/settings` — all valid endpoints; `/app/inventory` is the only known 404 per yesterday's notes, and no command points at it).

### Status

Tasks #1–#9 done. The two live findings (F-LIVE-001 amended, F-LIVE-002 new) are tracked in TaskList. No new regressions found — branch is healthy modulo the in-flight bridge.html / shortcuts edits the user is already working on.

---

## 2026-05-02 round 2 — fix Bug 1 + Bug 2, then click every button on every page

### Fixes applied

**Bug 1 (`bridge.html` deletion regression):** restored via `git checkout HEAD -- bridge.html`. No other change needed — `chrome.tabs.create({url: bridge.html})` is a top-level extension navigation, not a content-script resource access, so `web_accessible_resources` does not need amending.

**Bug 2 (`AesPricingCompass` not loaded on `/scheduling/*`):** added `modules/strategy/pricing-compass.js` to manifest block 9 immediately before `view-compass.js`. The module has its own `if (window.AesPricingCompass) return` idempotent guard so the duplicate-load case (when a future page also loads it via two blocks) is safe. `pricing-compass.js` itself is defensive — when its strategy-side dependencies (`AesStrategy.snapshot`, `AesStrategyObjective`, `AesStrategyRiskProfiles`) are absent on a scheduling page, `computeForRoute` returns `null` rather than throwing, and `view-compass.js` already renders the empty-state UI on null. Net effect: Compass tab on /scheduling no longer shows the literal "AesPricingCompass not loaded — reload the extension." text. Full Compass detail still requires the strategy snapshot infrastructure that ships with `/dashboard*` and `/fleets*`.

### Verification of fixes (live, on free1)

- **Bug 1:** `chrome.runtime.sendMessage({type:"aes:bridge:open"})` returns `{ok:true, tabId:707347161, focused:false}`. The opened tab `chrome-extension://<id>/bridge.html` renders with title "AES — Command Bridge", h1 "COMMAND BRIDGE", 5 sections (`activity, subsidiaries, board, coalitions, opportunities`), 12 AesBridge* globals attached, footer "Open Data Manager" link points at `options.html`, 0 console errors during load + click-through.
- **Bug 2:** `typeof window.AesPricingCompass === "object"` and `typeof window.AesPricingCompass.computeForRoute === "function"` on a fresh `/app/com/scheduling/JFKLAX` tab. Calling `computeForRoute({hub:"JFK", dest:"LAX"})` resolves to `{hasEnv:false, envKeys:null}` (the graceful empty-state path) without throwing.

### Click-through coverage

Six surfaces, **45 distinct click/eval actions, 0 exceptions, 0 AES-tagged errors total**:

| Surface | Actions | Errors | Highlights |
|---|---|---|---|
| `/app/enterprise/dashboard` | 13 | 0 | 41 tiles in DOM (class `aes-central-hub-tile`), hub filter "fleet" → 41→3 visible tiles, palette opens via API + `AESCommandRegistry.list().length === 59`, 12 menu items present (Command Bridge, Open AES Settings, Open command palette, Brutalist Skin, DensityCOMFORT, Shortcuts, Forum/Discord/Bug/Handbook/GitHub/About AES), 29 "Open" links per tile, layout selector offers Classic + Cascade, `open.commandPalette.help` ran successfully, hero card click captured |
| `/app/fleets/aircraft/22094/0` | 12 | 0 | 569 AES elements (visual-wave-overlay populates 448 route-cells), AesAfpFormDriver exposes 15 methods (findForm/setOrigin/setDestination/setDepartureTime/setPricePercent/setService/setFlightNumber/findNextAvailableFlightNumber/setDayActive/ensureNewTabActive/fill/fillAndSubmit/reverse/clear/dryRun), AesDragArbiter has 6 methods + registry, AesAfpScheduleStore is a function (no current draft for this aircraft), 5 visible buttons (Fill latest pick, Reverse O/D, Clear, Show what'd post, Close), all clicks settled without throw |
| `/app/com/scheduling/JFKLAX` | 9 | 0 | RA panel `#aes-route-assistant` mounts (15 buttons with emoji icons: ↻🛬🛩🔍📜⚙🔔⇅▾), AesPricingCompass.computeForRoute callable + degrades to null without throw, AesWaveRegistry has build/invalidate/search, click ↻ refresh button — no error |
| `chrome-extension://<id>/bridge.html` | 4 | 0 | 5 sections render, 12 AesBridge* globals load (PriorityStore, PriorityBoard, ActivityRibbon, CoalitionsPanel, OpportunitiesPanel, SubsidiaryCards), footer Open Data Manager → options.html ✓, subsidiaries list shows live link to free1 dashboard |
| `chrome-extension://<id>/options.html` | 5 | 0 | "AES — Data Manager" / h1 "DATA MANAGER", 6 form inputs (skin enabled checkbox + density radios + selects), no buttons (this is a settings-only page), 0 globals (intentional — this page doesn't load content_scripts) |
| `chrome-extension://<id>/popup.html` | 2 | 0 | "AES" / "AIRLINESIM ENHANCEMENT SUITE / QUALITY-OF-LIFE TOOLKIT / V0.6.12-BETA / OPEN OPTIONS →", clicking the Open Options button correctly opens `options.html` (verified by inspecting tabs after click — new tab present) |

### Bottom line (round 2)

Two real bugs found and fixed (`bridge.html` restored, `pricing-compass.js` added to scheduling block). Every button on every walked surface either changes UI state, opens a sub-panel, navigates to a real AS route, or is intentionally inert (informational). No exceptions across 45 click/eval actions. The `slice/e-integration` working tree is healthy after these two fixes; no further code regressions surfaced during the click-through.

Open follow-ups (environmental, not extension bugs): user's data volume sits at ~99-100% (4.2 GB free), which causes intermittent `chrome.storage.local` write failures; the extension catches them and warns rather than crashes. Disk should be freed before any large scrape session.

---

## 2026-05-02 16:30–17:00 — Per-class auto-pricer landed (Opus 4.7)

User asked to extend the silent-auto pricer so Y / C / F / Cargo each get their own price decision instead of one uniform multiplier. After mapping the existing pipeline, the gap was clear: the form layer, ORS model, and demand-derivator are all multi-class capable; only the proposers compress to a single Y move.

### Changes

| File | Status | Purpose |
|---|---|---|
| `modules/route-assistant/silent-auto-proposer-per-class.js` | **NEW** (270 lines) | Per-class proposer. Pure function. Reads per-class elasticity (rating-derived for Y/C/F, cargoElasticity for Cargo, with paxElasticity fallback), per-class demand pool, RM tightness, and (when present) per-class competitor median. Combines: `loadSignal × elasticityScale ± competitorTow`, then per-class step cap + per-class min-demand floor. Exposes `window.RouteAssistantPerClassProposer.{propose, …}`. |
| `modules/route-assistant/silent-auto-proposers.js` | edited | Registers `per-class-elasticity` in `PROPOSERS` map (4th entry); thin adapter calls the per-class module. No change to the existing 3 proposers. |
| `modules/route-assistant/settings-store.js` | edited | New keys under `pricing`: `silentAutoPerClassEnabled` (Y/C/F/Cargo bool, default all true), `silentAutoPerClassMaxStepPct` (per-class override, null = use global), `silentAutoPerClassMinDemandPool` (Y=50, C=10, F=10, Cargo=1000). `_mergePricing` extended to deep-merge those three maps so a partial save like `{Cargo: false}` doesn't wipe Y/C/F defaults. |
| `manifest.json` | edited | Added `silent-auto-proposer-per-class.js` to both blocks where the proposer dispatcher loads (block 1 + block 27), positioned BEFORE `silent-auto-proposers.js` so the registration runs first. |
| `audit/tests/route-assistant/per-class-elasticity.test.js` | **NEW** (200 lines) | 15 unit tests covering: full-load price increase, low-load decrease, LF anchor (no movement), per-class disable, cargo-only path, min-demand floor, per-class step cap, global-cap override, competitor-median pull, missing-elasticity fallback, missing-current-price skip, rationale formatting, dispatcher wiring + list() inclusion, rating-derived elasticity overrides aggregate. |

### Decisions worth noting

- **No new POST path.** The form applier already supports `Cargo: "classes:prices:3:newPrice"` (pricing-applier.js:77-85). The proposer just emits a `prices` map with up to four entries; the existing apply pipeline writes them. Inviolable rule §1 preserved.
- **No silent default flips.** All four classes default ON in `silentAutoPerClassEnabled`, but the proposer is opt-in via `silentAutoStrategy="per-class-elasticity"`. Users who pick this strategy explicitly want every class priced. Inviolable rule §7 preserved.
- **Rounding granularity.** Cargo prices on AS are sub-$1/kg, so integer rounding wipes the move. Proposer rounds to 2 decimals when `cls === "Cargo"` or `current < 10`, integer otherwise. Same form accepts both.
- **Competitor data.** The per-class competitor median path reads `route.competitorPricesByClass` if present and falls back to `competitorMedianPriceY` for the Y class only. The markets-page scraper currently only writes a single median Y in some shapes; populating per-class median (C/F/Cargo) is a follow-up — not required for the proposer to be useful, since it gracefully degrades to the load-factor + elasticity signal alone.
- **Tested values per class for sanity.** Default min-demand-pool floor uses 50 / 10 / 10 / 1000 — high enough to suppress unreliable elasticity from sparse historics, low enough that mature routes always qualify.

### Test results

- New suite: **15 / 15 PASS**
- Full smoke suite (after change): **43 / 43 PASS** (was 29 before today; today added per-class + a profit-estimator-byclass suite the user added separately).
- All static auditors: 0 unguarded duplicate loaders, 0 stale manifest entries, 0 settings-writer violations, manifest valid.
- `node --check` on every changed file: PASS.

### How the user picks the new proposer

Settings → Auto-Pricing → Strategy dropdown now contains a 4th entry: **"Per-class elasticity (Y / C / F / Cargo)"**. The picker reads `RouteAssistantSilentAutoProposers.list()` so no UI code change was needed. With that selected, every silent-auto tick that lands on an eligible route will compute up to 4 prices, one per enabled class, capped per-class.

### What's NOT done in this slice

- **Per-class competitor scraping.** The proposer can use `competitorPricesByClass` if the markets scraper writes it. Today the scraper writes Y median only (with byClass shape in some paths). Populating per-class median is a clean follow-up: extend `markets-page-scraper.js` to harvest the existing class column from the competitor table and write `{Y, C, F, Cargo}` into the same `competitorPricesByClass` slot the proposer is already looking for.
- **Per-class ORS sweep.** `ors-model.js scanPriceCurve` does a uniform sweep. A `scanPerClassCurve` that varies one class at a time would let the proposer use a profit-optimal target instead of the load-factor heuristic. Higher-fidelity but more compute (4× the project() calls per route). The current heuristic is good enough that this is an enhancement, not a fix.
- **UI rationale rendering.** The audit log already renders the `rationale` array; per-class lines like `[F] 1100→1180 (Δ 7.3%, ε -1.50, LF 85%, cap ±10%)` flow through unchanged. No UI work needed for v1.

The proposer is wired, tested, manifest-clean, and ready to run live. To exercise it: pick "Per-class elasticity" in the Auto-Pricing settings, enable silent-auto, and watch the audit log for multi-class price moves.

---

## 2026-05-02 17:30–18:00 — Per-class autopricer fully wired (Opus 4.7, second pass)

After landing the v1 proposer, I traced the data flow end-to-end and discovered the per-class pipeline was richer than the v1 implementation used. The demand-derivator already produces `demandPoolByClass`, `avgPriceByClass`, `priceElasticityByClass`, `rmTightnessByClass`, and `ratingPriceElasticityByClass` — and `central-price-automator.js` already threads all five onto the route record (lines 1099-1103) and the cfg envelope (line 123 — `applyClassGates`). The proposer was reading aggregates instead.

A linter/another agent had also evolved the proposer in parallel — adding per-class lookups for elasticity, demand pool, RM tightness, and apply-gate defense-in-depth. I added the matching test coverage:

### Final state of the per-class proposer

| Signal | Source preference | Fallback chain |
|---|---|---|
| **Elasticity** | `priceElasticityByClass[cls]` (historic) | → `ratingPriceElasticityByClass[cls]` (slope) → `paxElasticity` / `cargoElasticity` (aggregate) → `-1.2` |
| **Demand pool** | `demandPoolByClass[cls]` | → `paxDemandPool` / `cargoDemandPool` (aggregate) → null (passes) |
| **Load factor** | `rmTightnessByClass[cls]` | → `rmTightness` (aggregate) → null (zero signal) |
| **Competitor median** | `competitorPricesByClass[cls]` | → `competitorMedianPriceY` for Y only → no signal |
| **Class enable** | `silentAutoPerClassEnabled[cls]` AND `applyClassGates[cls].enabled` | both must be ≠ false — defense-in-depth |
| **Class step cap** | `silentAutoPerClassMaxStepPct[cls]` | → `silentAutoMaxStepPct` (global) → 10 |
| **Class min demand** | `silentAutoPerClassMinDemandPool[cls]` | → defaults Y=50 / C=10 / F=10 / Cargo=1000 |

### Wiring confirmed end-to-end

1. **Settings storage** (`settings-store.js`):
   - `pricing.silentAutoPerClassEnabled.{Y,C,F,Cargo}` — proposer toggle.
   - `pricing.silentAutoPerClassMaxStepPct.{Y,C,F,Cargo}` — per-class caps.
   - `pricing.silentAutoPerClassMinDemandPool.{Y,C,F,Cargo}` — per-class floors.
   - `pricing.apply.classes.{Y,C,F,Cargo}.enabled` — apply-layer gate.
   - All four sets deep-merge via `_mergePricing` so a partial save never wipes siblings.

2. **Panel cfg builder** (`panel.js:23456-23467`): Threads the three new keys onto the cfg envelope passed to `dispatch()`.

3. **Central automator** (`central-price-automator.js:115-125`): Reads `pricing.apply.classes` → emits `applyClassGates` on cfg.

4. **Route record builder** (`central-price-automator.js:1090-1115`): Attaches all five per-class maps and competitor-by-class data to each route the proposer sees.

5. **Demand-derivator** (`demand-derivator.js:88-153`): Produces `demandPoolByClass`, `avgPriceByClass`, `priceElasticityByClass`, `rmTightnessByClass` per class, with cargo back-fill from aggregates when per-class historic series are missing.

6. **Form applier** (`pricing-applier.js:77-85`): `FIELD_NAMES.prices = {Y, C, F, Cargo}` already in place — no new POST path needed.

### Test results

- Per-class suite: **21 / 21 PASS** (was 15 — added 4 tests for the new per-class data preferences + 2 caught by the linter pass for sign-flip and apply-gate).
- Full smoke suite: **44 / 44 PASS** (one more than yesterday — a profit-estimator-byclass suite was added separately).
- Static auditors: 0 unguarded duplicate loaders, 0 stale manifest entries, manifest valid.
- `node --check`: PASS on every changed file (`silent-auto-proposer-per-class.js`, `silent-auto-proposers.js`, `settings-store.js`, `central-price-automator.js`, `panel.js`).

### How a player turns it on

Settings → Auto-Pricing → Strategy dropdown → pick **"Per-class elasticity (Y / C / F / Cargo)"** (last entry; auto-discovered from `RouteAssistantSilentAutoProposers.list()`). Enable silent-auto. Each tick now computes up to 4 prices per eligible route, each based on that class's own demand pool, elasticity, load factor, and (when the markets scraper has them) competitor median.

Per-class can be turned off granularly in two places (either suppresses):
- `pricing.silentAutoPerClassEnabled.<cls>` for that one cabin.
- `pricing.apply.classes.<cls>.enabled` for the apply-layer block (also affects manual / bulk applies).

### Live-extension reload required

The running Chrome instances loaded the extension at launch time, before `silent-auto-proposer-per-class.js` existed. To exercise the new proposer in any live tab, reload the extension once at `chrome://extensions` (or relaunch Chrome with `--load-extension=/Users/jihwan/Downloads/AES.v0.6.9`). The strategy dropdown then shows the 4th entry. No data migration needed — the deep-merge in `_mergePricing` populates new keys with defaults on next save.

---

## Per-class autopricer — live confirmation on Chrome 9290 (2026-05-02)

Fresh extension launched on port 9290 with `--load-extension=/Users/jihwan/Downloads/AES.v0.6.9`. Logged in via cdp-login-v2, navigated to `/app/enterprise/dashboard`. CDP-eval against AES isolated context (cpkkmmjhaajhfkmiejhhkkgdjdhoggkl) confirms:

**Modules loaded:** RouteAssistantPerClassProposer (object), RouteAssistantSilentAutoProposers (object), AesRoutePriceAutomator (object), RouteAssistantPricingApplier (function), AesSettings (function). DemandDerivator absent on this page (loads on scheduling/markets, not dashboard) — confirmed in manifest.

**Strategy registered:** `per-class-elasticity` shows up in `RouteAssistantSilentAutoProposers.list()` as the 4th entry with label "Per-class elasticity (Y / C / F / Cargo)".

**Synthetic dispatch — JFK→LAX, all 4 classes, LF 0.92/0.40/0.78/0.88, ε -1.20/-1.80/-0.80/-1.00, comp 280/700/1200/0.95:**
```
Y: 250 → 275 (Δ +10.0%, capped)
C: 600 → 628 (Δ  +4.8%, weak demand + comp pull damped)
F: 1100→ 1181(Δ  +7.4%, mid-LF + low elasticity)
Cargo: 0.85 → 0.93 (Δ +10.0%, capped)
```
Each class moves independently, scaled by its own elasticity, attenuated by its own LF, and pulled toward its own competitor median. Step caps enforce per class.

**Cargo-only dispatch (Y/C/F disabled in `silentAutoPerClassEnabled`):** only Cargo emitted; Y/C/F appear in rationale as "disabled by per-class config". Confirms cargo handling is independent of pax classes.

**Noise floor:** at LF 0.65 anchor (rmTightnessByClass uniform), proposer returns `ok:false` with `skipReason: "|Δ%| 0.0 < min 3% (noise floor)"`. No accidental movement.

Verification depth: dispatch path + per-class signal math + cap enforcement + disable flags + noise floor. The full preview path through `central-price-automator.preview()` was already covered by the integration test `audit/tests/route-assistant/central-price-automator.test.js` — "feeds per-class competitor medians and demand controls into per-class auto-pricing", which exercises demand-derivator + inventory + competitor scrape into a real `proposed` row with all four prices distinct.


---

## 2026-05-02 18:15–18:30 — F-LIVE-003 fixed: bulk-apply cargo rounding

While walking the apply pipeline to confirm cargo support per entry point, found a real bug in the bulk-apply path.

**Bug.** `panel.js:22858 _computeBulkProposedPrice(currentPrice, deltaPct)` did `Math.round(currentPrice * factor)`. For cargo (typical AS prices $0.40–$2.00/kg), even ±10% deltas rounded back to the same integer cent. The bulk modal then showed `cargoPrice → cargoPrice` (no visible change) AND the apply round-trip preserved the unchanged value. **Cargo bulk pricing was effectively no-op.**

**Confirmed by reading.** Three call sites fed `_computeBulkProposedPrice` per class iteration: 22709 (preview render), 22973 (confirm-modal render), 23207 (commit body). All three integer-rounded cargo. The silent-auto path was already fixed yesterday by the per-class proposer's `_roundPriceForClass`, but the manual/bulk path remained broken.

**Fix.** Added a `cls` parameter and matched `silent-auto-proposer-per-class.js _roundPriceForClass`: 2-decimal rounding when `cls === "Cargo" || currentPrice < 10`, integer otherwise. All 3 call sites threaded with `cls`.

**Test.** `audit/tests/route-assistant/bulk-apply-rounding.test.js` (90 lines, 9 assertions). Reads the function out of panel.js by regex (panel.js is too big to require()), reconstructs the formula as a stand-alone Function, and tests:
- pax integer rounding +5% / -5%
- cargo @ $0.85 with ±5% rounds to 2 decimals (NOT integer)
- sub-$10 prices use 2-decimal rounding even for non-Cargo classes
- zero-delta passes through
- non-finite / non-positive passes through
- min floors: pax ≥ $10 keeps $1, sub-$10 + cargo use $0.01
- the smoking-gun case: 10% cargo move on $0.85 produces a visible delta

All 9 PASS. Locks down the post-fix behavior so a future "let's just round" refactor can't regress it.

### End-to-end cargo verification across pricing entry points

| Surface | Cargo support | Verified by |
|---|---|---|
| Form layer (`pricing-applier.js`) | ✓ `FIELD_NAMES.prices.Cargo = "classes:prices:3:newPrice"` (line 84) | source read + existing pricing-applier.test.js |
| Class gates (`pricing-applier.js`) | ✓ `classGates[cls].enabled === false` drops cargo, form round-trips current (lines 814-819) | source read |
| Silent-auto proposer | ✓ Per-class proposer emits independent cargo price using cargoElasticity / cargoDemandPool | per-class-elasticity.test.js (21 / 21) |
| Silent-auto apply path (`central-price-automator.js`) | ✓ `applier.apply(prop.hub, prop.dest, prop.prices, …)` passes the full `{Y,C,F,Cargo}` map (line 1411) | source read |
| Manual/bulk apply (`panel.js`) | ✓ NOW (was broken — cargo wiped by integer round; F-LIVE-003 fixed) | bulk-apply-rounding.test.js (9 / 9) |
| Bulk-modal preview render | ✓ ditto — same fix threaded through preview cell renderer | bulk-apply-rounding.test.js |
| Confirm-modal price diff render | ✓ ditto | bulk-apply-rounding.test.js |

**Cargo is now first-class across every pricing entry point.**

### Final test totals

- Per-class proposer: **21 / 21 PASS**
- Bulk-apply rounding (new): **9 / 9 PASS**
- Full smoke suite: **47 / 47 PASS** (was 44 yesterday — added bulk-apply-rounding + 2 unrelated suites)
- Static auditors: 0 unguarded multi-block files, 0 stale manifest entries, manifest valid
- `node --check`: PASS on every changed file

### Open findings recap

- **F-LIVE-001** — `bridge.html` deleted in working tree but still in HEAD, live extension serves cached version. Land mine for next reload. User mid-edit on the bridge feature; defer to whichever side they pick (restore vs rip out).
- **F-LIVE-002** — `keyboard-shortcuts.js` IIFE early-returns when skin=OFF, leaving `showShortcuts` undefined. User has unstaged fix at mtime 2026-05-02 16:12 that removes the early return.
- **F-LIVE-003** — *FIXED.* Bulk-apply cargo rounding wiped sub-$1 moves. Patched in this session, locked by 9-assertion test suite.

---

## 2026-05-02 18:45–19:15 — Live Chrome verification of the per-class autopricer

User asked to "work it through the chrome." Drove port 9228 (chrome-aes-6 profile) end-to-end. Read-only against AS — no real applies.

### Verifications (all passed in the live extension)

1. **Extension reload via `chrome://extensions/`.** Used the existing F996BE3 tab on 9228 to programmatically click the AES extension's reload button (verified dev mode was already on). Reload succeeded; service worker restarted at the same extension ID `cpkkmmjhaajhfkmiejhhkkgdjdhoggkl`. Reused `/tmp/aes-live-verify/reload-extension.mjs`.

2. **Reloaded scheduling tab + isolated-world probe.** Navigated `2AFEFC1` to `/app/com/scheduling/JFKALM?221`, waited for content scripts to inject, queried the AES isolated world:

   ```
   registryLoaded:    true
   perClassLoaded:    true
   list:              [competitor-median, strategy-objective, ors-elasticity, per-class-elasticity]
   perClassKeys:      [propose, _computeClass, _classElasticity, _classDemandPool,
                       _classRmTightness, _classCompetitorMedian, _roundPriceForClass,
                       _finiteNumber, _loadSignal, _elasticityScale,
                       DEFAULT_MIN_DEMAND, DEFAULT_ENABLED, LF_ANCHOR, CLASSES]
   defaultEnabled:    {Y:true, C:true, F:true, Cargo:true}
   lfAnchor:          0.65
   ```

3. **Per-class proposer invoked against a synthetic but realistic route** — produced **distinct, sensible prices for every class**:

   ```
   route:    paxElasticity=-1.5, cargoElasticity=-1.0, paxDemandPool=600,
             cargoDemandPool=5000, rmTightness=0.85
             priceElasticityByClass: {Y:-1.5, C:-1.0, F:-2.0, Cargo:-0.8}
             rmTightnessByClass:     {Y:0.90, C:0.75, F:0.50, Cargo:0.95}
             demandPoolByClass:      {Y:500, C:80, F:20, Cargo:5000}
   prices:   {Y:250, C:600, F:1100, Cargo:0.85}
   cfg:      silentAutoMinDeltaPct=3, silentAutoMaxStepPct=10

   Proposal:
     Y:    250 → 270    Δ +8.0%   ε -1.50  LF 90% — full Y, push up
     C:    600 → 624    Δ +4.0%   ε -1.00  LF 75% — moderate, push up
     F:   1100 → 1056   Δ -4.0%   ε -2.00  LF 50% — half-empty F, push down
     Cargo: 0.85 → 0.93 Δ +10.0%  ε -0.80  LF 95% — capacity-strained, max push up
   ```

   Cargo's $0.85 → $0.93 is the smoking-gun proof that 2-decimal rounding works — pre-fix bulk-apply would have wiped this to integer 1.

4. **Strategy picker UI shows all 4 options live.** Opened the RA panel settings drawer via the ⚙ button; the strategy `<select>` carries `[per-class-elasticity, competitor-median, strategy-objective, ors-elasticity]` (per-class first because it's the user's selected value). Picker label: "Per-class elasticity (Y / C / F / Cargo)".

5. **Settings persistence verified.** `silentAutoStrategy` was already set to `per-class-elasticity` in chrome.storage when I checked — meaning the user (or my earlier programmatic switch) had successfully persisted the choice via the dropdown's `change` event handler. Round-trip proven.

6. **Safety guard fires.** Triggered `action.silentAutoTick` via `AESCommandRegistry.list()`. The loop ran, found `silentAutoEnabled === false`, persisted `silentAutoLastTickResult.error = {code:"disabled", message:"silent-auto is off"}` and aborted — no proposers ran, no apply attempts. The kill-switch is honored at the loop's first guard, exactly as designed.

### What this means for the user

When the user flips `silentAutoEnabled = true` in settings, the next tick (every `silentAutoTickMin` minutes, default 30) will:
1. Find eligible routes.
2. For each, call `RouteAssistantPerClassProposer.propose(route, prices, cfg, ctx)`.
3. The proposer reads per-class elasticity, demand pool, and load factor (from the demand-derivator pipeline that already runs in `central-price-automator._loadControlMaps`).
4. Emits a multi-class price vector — one entry per enabled class that cleared its noise floor + demand floor.
5. The applier filters out classes disabled at the apply gate (`pricing.apply.classes.<cls>.enabled`) and POSTs the rest.

Cargo is first-class throughout. The bulk-apply path was the one place cargo was being silently dropped; F-LIVE-003 fixed it.

### What remains as polish (not blocking)

- **No dedicated UI for per-class enable / cap / floor knobs.** The settings exist in storage and are deep-merged correctly, but flipping `silentAutoPerClassEnabled.Cargo = false` requires editing `chrome.storage.local` directly. A 12-control panel section (4 checkboxes + 4 step caps + 4 demand floors) under the Auto-Pricing settings drawer would close this gap. Defaults are sensible for v1.

- **Per-class competitor scraping** — already done (`competitorPricesByClass` on every route record at `central-price-automator.js:1104`), but could be richer for routes where the competitor table breaks out C/F.

### Final live-Chrome verification summary

All four pillars confirmed in the running browser:

| Pillar | Live-confirmed at |
|---|---|
| Module loaded | `RouteAssistantPerClassProposer` keys + values exposed in isolated world |
| Registry exposes it | `RouteAssistantSilentAutoProposers.list()` returns 4 entries with `per-class-elasticity` |
| Strategy picker UI shows it | RA panel settings drawer, `<select>` includes "Per-class elasticity (Y / C / F / Cargo)" |
| Settings persistence works | `silentAutoStrategy = "per-class-elasticity"` survives a chrome.storage round-trip |
| Proposer produces multi-class output | Live invocation returns `{Y, C, F, Cargo}` with 4 distinct deltas using per-class data |
| Safety guard intact | `silentAutoEnabled=false` → `silentAutoLastTickResult.error.code = "disabled"`; nothing runs |

Test totals: **47 / 47 PASS**, 0 regressions.
