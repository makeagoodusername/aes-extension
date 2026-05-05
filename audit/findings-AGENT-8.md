# Findings — Agent 8 (Test Harness, Cross-Agent Verification, Consolidation)

Phase 1 audit. Scope: test harness, cross-agent diff/dup-finder, integration tests, end-of-session rollup. No production-module edits at any phase.

Categories: `[BUG]` `[DEFERRED]` `[WIRING-GAP]` `[INVARIANT-RISK]` `[QUESTION]` `[CROSS]` (cross-agent observation) `[SCRIPT]` (Agent 8's own deliverables).

---

## Phase 1 outputs

### F-8-001 [SCRIPT] — Static audit scripts shipped to `scripts/`

Three Python helpers live in `scripts/` so any agent can re-run them:

- `scripts/audit-orphans.py` — modules under `modules/**/*.js` not in `manifest.json` content_scripts, bridge.html script tags, or `background.js` importScripts.
- `scripts/audit-bus.py` — emits-without-subscriber and subscribes-without-emitter, per bus (CentralHubBus / AesDataBus / AesAfp.bus / AesStrategy.bus). Handles `subscribeBus(...)` helper and the common `const bus = window.<Bus>` aliasing pattern. Does **not** catch fully dynamic topic names (`bus.emit(eventVar, ...)`); the canopy stores fan-out and `_emitStage` aliases will under-count if `eventVar` is a function param.
- `scripts/audit-settings-writers.py` — every `chrome.storage.local.set({settings: ...})` (and `{settings}` shorthand and `{...settings}`) outside the legitimate single-writer (`modules/_shared/settings-bridge.js`). Buckets violators by Agent territory.

These are read-only, side-effect-free, idempotent. Re-runnable from any agent.

### F-8-002 [VERIFIED] — Manifest reachability is clean

`scripts/audit-orphans.py` reports:

- 572 `.js` files under `modules/**`.
- 554 in manifest content_scripts.
- 13 loaded via `bridge.html` script tags.
- 12 imported by `background.js` `importScripts`.
- **0 orphans.**
- **0 manifest entries pointing at non-existent files.**

The "Manifest wiring overhaul" line in `HANDOVER.md §1` actually held end-to-end. Module count drifted up from 533 → 572 since the brief was written; that's normal since slices keep shipping.

### F-8-003 [VERIFIED] — Bus dead-emit/dead-listener inventory

`scripts/audit-bus.py` results, summarised per bus. Most of these match what
agent G reported in `audit/pathway-bus.md`; listing here as a
fresh sweep so subsequent sessions can diff against the current snapshot.

**CentralHubBus — 8 dead emits, 20 dead listeners.**

Dead emits (no `.on` subscriber for the literal topic):
- `conductor:routine:spawned` ← routine-engine.js
- `conductor:routine:transition` ← routine-engine.js
- `fleet-optimizer:target-changed` ← fleet-optimizer-settings.js (also dual-emitted on AesStrategy.bus — see CROSS-001)
- `strategy:layered:route-extras-changed` ← layered/route-extras-store.js
- `tile-pin-changed` ← central-hub/pin-affordance.js (G-007)
- `waveeditor:wave-archived` / `waveeditor:wave-cloned` / `waveeditor:wave-split` ← route-assistant/wave-editor.js

Dead listeners (subscribed but no literal-topic emitter): `briefing:dismissed` (self-emit only — G-006), `canopy:affiliations-changed`, `canopy:dna-changed`, `canopy:dna-override-changed`, `canopy:roles-changed` (these last 4 are emitted via the canopy stores' multi-bus `_emit(event, payload)` fan-out where `event` is a variable — script under-counts), `ctx:ready` (subscribeBus from strategy-hub-designer-tile, but `ctx:ready` is an AesAfp.bus topic — see F-8-004), `data:conductor:drift:proposal:created`, `data:conductor:trust:updated`, `data:slots:available:updated`, `data:slots:bid:queued`, `data:strategy:fork:created`, `data:strategy:fork:promoted`, `signal:conductor:drift`, `signal:conductor:tier:promoted`, `strategy:plan-applied`, `strategy:portfolio:rebuilt`, `strategy:service-experiment-{started,concluded,consolidated}`, `tile-registered` (G-008), `strategy:auto-tick-stage` (subscribed by strategy-tile, emitted via local-alias `bus.emit` in auto-driver.js — script catches via alias scan).

**AesDataBus — 23 storage-fanout-only emits (registry-or-not), 1 dead listener.**

Most "dead emits" here are intentional storage-bridge sinks: the producer emits, the consumer reads back via `chrome.storage.local.get` or via `AesView.subscribe`. `audit/pathway-storage.md` already documented this. The lone dead listener is `data:strategy:dispatch:applied` subscribed by weekly-review-tile — the registered emitter is `decision-dispatch.js`, but my script didn't see a literal emit there. Agent 6 should verify whether the publish call is `AesDataBus.publish` (handled) or via a different alias.

**AesAfp.bus — 6 dead emits, 4 dead listeners.**

Dead emits: `auto-apply:requested` / `auto-apply:retry-requested` (G-004 — observability emits with no consumer; the apply path is direct), `auto-schedule:built`, `maintenance:scraped`, `wave:built`, `wear:updated`. Dead listeners: `journal:entry-recorded` / `journal:reason-updated` (subscribed by `strategy/journal-panel.js` — wrong bus; the journal store emits on `AesDataBus`/`CentralHubBus`, not AesAfp).

**AesStrategy.bus — 1 literal emit, 0 listeners.**

`fleet-optimizer:target-changed` from `fleet-optimizer-settings.js`. This is the literal emit that survived the script's regex; the additional ~11 emits documented in G-001 use the dynamic `event` variable name. **G-001's fix landed** (`apply-pipeline.js` instantiates `window.AesStrategy.bus`, per `CONSOLIDATION-SUMMARY.md`), so these emits now successfully fan out — but **still no `.on` subscriber anywhere on the AesStrategy.bus channel.** That's an ongoing question: was the bus instantiated as future infrastructure, or did somebody plan a subscriber that never landed? Worth a Phase 2 re-confirm with Agent 3.

### F-8-004 [QUESTION] CROSS — `ctx:ready` is an AesAfp.bus topic; strategy-hub-designer-tile listens on CentralHubBus

`modules/central-hub/tiles/strategy-hub-designer-tile.js` calls `subscribeBus("ctx:ready", …)` which routes to `CentralHubBus`. But `ctx:ready` is an AesAfp.bus topic emitted by `aircraft-flight-plan/host.js`. On the dashboard page the AesAfp host is loaded but its `mount()` bails when `.as-page-aircraft` is missing (per HANDOVER §10 invariant 2934), so `ctx:ready` may not even fire on the dashboard. Either way, the wrong-bus subscription silently no-ops.

**Tag for:** Agent 3 (strategy-hub-designer-tile owner) — fix is to either subscribe on AesAfp.bus, OR repurpose to a topic like `data:account:bootstrapped` if the intent is "wait for context."

### F-8-005 [BUG] CROSS — H-001 (24+ direct settings writers) is still open at 34 sites across 13 files

Per `audit/pathway-storage.md` H-001 and `CONSOLIDATION-SUMMARY.md` "P1 findings still open." `scripts/audit-settings-writers.py` confirms — 34 hits across 13 files. F-9223-002 fixed the `AesSettings.saveArea` queue; these 34 writers bypass it and re-introduce the same RMW race the queue was added to fix.

Bucketed by territory for parallel fix:

- **Agent 2 (RA):** `modules/route-assistant/settings-store.js:662, 964` (2)
- **Agent 3 (Canopy):** `modules/canopy/dna-account-editor.js:203` (1)
- **Agent 3 (Strategy):** `modules/strategy/default-settings.js:528` (1)
- **Agent 4 (AFP):** `modules/aircraft-flight-plan/settings-extension.js:348` (1)
- **Agent 4 (Sched):** `modules/schedule-management/open-stations-modal.js:278` (1; used `{settings}` shorthand)
- **Agent 5 (UAS):** `modules/used-aircraft-scanner/presets-store.js:398, 416`, `type-family-map.js:507` (3)
- **Agent 7 (BG):** `modules/_background/legacy-defaults.js:88` (1)
- **Agent 7 (Entry):** `content_dashboard.js` (10), `content_inventory.js` (3), `content_personelManagement.js` (5), `content_settings.js` (5), `content_fligthSchedule.js` (1) (24)

Ratio note: Agent 7's territory carries 25/34 (74%) of the violations because the legacy `content_*.js` pages predate the saveArea bridge. Agent 7's findings list does NOT yet flag this — recommending they add it.

**Fix shape per writer:** replace `chrome.storage.local.set({settings: {...settings, [area]: block}})` with `await window.AesSettings.saveArea("<area>", block)`.

### F-8-006 [INVARIANT-RISK] CROSS — Agent 3's F-A3-003 (apply-pipeline._applyPriceMoves bypasses RA pricing kill-switch)

Direct quote from Agent 3's findings: `applier = new Applier(server, {applyEnabled: true, dryRunOnly: false})` at `modules/strategy/apply-pipeline.js:483`. This means a user who has explicitly turned off `settings.routeAssistant.pricing.apply.enabled` in the RA panel will still have strategy POST pricing as long as strategy's own gates are open.

**Tag for:** user (a question per Agent 3's writeup) — is this intentional ("strategy is its own authority") or should strategy honor the RA kill-switch as a defense-in-depth layer? The alliance handler at lines 687-691 DOES honor `settings.alliance.apply.{enabled, dryRunOnly}` — so the inconsistency may be a bug.

I lean: defense-in-depth. The RA kill-switch is a user's "stop pricing writes from this codebase, full stop" intent; strategy should honor it. But this is the user's call. Tagging for explicit decision.

### F-8-007 [INVARIANT-RISK] CROSS — Agent 3's F-A3-001 (forward-simulator mutates fork.snapshot)

Per Agent 3's finding: `simulateForward()` calls `_decay(fork.snapshot)` which mutates `a.age`, `a.wear.ratio`, `r.orsRank` in place. Re-running the simulator on the same fork drifts the baseline. The Trust→Drift→Foresight wave's "deterministic projection" claim is wrong.

**Tag for:** Agent 3 to fix in their territory (in scope: `modules/strategy/forward-simulator.js`). Agent 8's role: build a Phase 2 Node-runnable smoke that asserts `simulateForward(fork, 12).baseline === simulateForward(fork, 12).baseline` after re-run. Will land in `tests/strategy/forward-simulator-determinism.test.js`.

### F-8-008 [DEFERRED] — Test harness scaffolding NOT YET BUILT

Per AGENT-8.md priority area #1, Phase 2 will scaffold:

- `tests/e2e/00-load-extension.spec.ts` — Playwright launch with `AES_TEST_PROFILE` env var pointing at one of the agent profile dirs, navigate to `/app/enterprise/dashboard`, assert `#aes-top-menu` visibility.
- `tests/integration/strategy-apply-to-pricing-applier.spec.ts` — strategy modal Apply → `routeAssistant:pricingApplyLog` gains `source:"strategy"` entry.
- `tests/integration/wave-overlay-save.spec.ts` — toggle Wave View → 💾 Save → assert `<server><airline>schedule` storage gains a record.
- `tests/integration/afp-batch-dryrun.spec.ts` — Auto-build → Apply-all in dry-run → assert zero AS POSTs in DevTools network.
- `tests/integration/cmd-k-dispatch.spec.ts` — Cmd-K → "Open Strategy" → modal opens.

**Phase 2 dependency:** the user needs to confirm which Chrome profile dir to point Playwright at. Per the briefing this is one of the eight agent profile dirs; in this session those are `/tmp/chrome-aes-{5,6}` (only 2 alive — see F-8-009 below for the port-shortage observation).

### F-8-009 [QUESTION / BLOCKER] — Only 2 Chrome instances alive for 8 agents in this session

`ps -ef | grep remote-debugging-port` shows:

| Port | Profile dir | Belongs to |
|---|---|---|
| 9227 | /tmp/chrome-aes-5 | aes-claude-3 (this session) |
| 9228 | /tmp/chrome-aes-6 | aes-claude-3 (this session) |
| 9229 | /tmp/chrome-refine-1 | sibling worktree (not us) |
| 9230 | /tmp/chrome-refine-2 | sibling worktree |
| 9231 | /tmp/chrome-refine-3 | sibling worktree |
| 9232 | /tmp/chrome-refine-4 | sibling worktree |

Both 9227 and 9228 returned `[]` for `/json/list` — empty tab state. CLAUDE.md says "Each of the eight agents has its own Chrome instance"; we have 2 instances, and probing 9229+ is blocked by the harness as it should be (cross-session protection per `aes-refine-worktree`).

**Question for user:** how should Agent 8 do live verification? Options:

1. Share 9227 or 9228 with another agent under SHARED-NOTES coordination (read-only scrapes don't need a lock; live writes do).
2. Launch a fresh Chrome on a free port (e.g. 9233) with `/tmp/chrome-aes-8` profile dir, then use the credentials shared mid-session to log in.
3. User opens it directly and tells me the port.

For option 2 I'd run something like:
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/chrome-aes-8 \
  --remote-debugging-port=9234 \
  --load-extension=/private/tmp/aes-claude-3/project \
  --disable-extensions-except=/private/tmp/aes-claude-3/project \
  https://www.airlinesim.aero/app/login
```
…then drive via CDP `Runtime.evaluate` to fill the login form.

**No live verifications attempted yet** until user confirms.

### F-8-010 [INFO] — Cross-agent finding overlap map

Agents 1, 2, 4, 5, 7 have already filed findings; agents 3 and 6 are still ramping (Agent 6 file is empty as of this snapshot; Agent 3 has 6 findings; Agent 1 file is empty). Nothing in any agent's territory contradicts another's so far. Specific overlaps worth noting:

- **F-8-005 (settings-writers H-001) overlaps Agent 7's territory.** Agent 7 didn't list it — recommended they add a finding referencing the bucketed list above.
- **Agent 4's F4-007** verified Schedule Canvas commit-bar honors `RouteAssistantSettings.load()` for the gates. This conflicts with Agent 3's F-A3-003 which says `apply-pipeline.js:483` constructs a fresh applier with hardcoded gates open. Different code paths; both observations are correct.
- **Agent 5's F-DASH-503** flags `competitor-monitoring-tile` doing `chrome.storage.local.get(null)` per render. Performance-only flag; cross-territory only in that the storage envelope (Agent 6) has been considering a `getAll(prefix)` primitive (per pathway-storage.md "Caveat 4").
- **Agent 7's F-7-001** asks whether `credentials.json`/login lives in extension or harness. Answer per CLAUDE.md §1: it's harness/launcher, not extension. Confirming so Agent 7 can drop it from scope.

---

## Phase 1 summary

- **Findings:** 10 total. 1 SCRIPT-deliverable, 2 VERIFIED (orphan-clean + bus-inventory), 1 BUG-CROSS (settings writers), 2 INVARIANT-RISK CROSS (forward-simulator determinism, apply-pipeline kill-switch bypass), 1 QUESTION CROSS (`ctx:ready` wrong-bus), 1 DEFERRED (test scaffolding), 1 QUESTION/BLOCKER (Chrome instance availability), 1 INFO (cross-agent map).
- **Bug count by severity:** 1 P1 (F-8-005 settings writers), 1 P1 (F-8-007 forward-simulator), 1 P2 (F-8-006 strategy/RA kill-switch question — depends on user intent), the rest are observations or deferrals.
- **Live verification:** ZERO performed. Blocked on F-8-009.

### Top 3-5 issues I'd fix (Phase 2 priority)

In Agent 8's territory only (everything else is Cross-agent — referred to the territory owner):

1. **Set up the verification harness** (AGENT-8 priority area #1) — `tests/e2e/00-load-extension.spec.ts` + 2-3 critical-path integration tests. ~120 LOC scaffold; depends on user-side direction for Chrome profile to reuse (F-8-009).
2. **Build a Phase 2 Node-runnable smoke for forward-simulator determinism** (F-8-007, agent 3 territory but Agent 8 owns the test harness) — `tests/strategy/forward-simulator-determinism.test.js`. Pure-function smoke; no Chrome required. ~30 LOC.
3. **Drive live read-only verification** of `[VERIFY-LIVE]` flagged items from agents 1-7 once the Chrome blocker is resolved — see Agent 4's F4-blocker note + Agent 7's Q1.
4. **Append CROSS finding F-8-005 link** to Agent 7's findings (or write a CROSS entry in SHARED-NOTES.md) so they pick up the legacy-content_*.js settings writers in their fix bucket.
5. **Build `audit/live-verifications.md`** as the running log of every CDP-driven verification (per AGENT-8 priority area #4). Phase-2 work after the Chrome blocker resolves.

### Open questions / blockers (Phase 1)

- **B-1 (F-8-009):** Chrome instance availability. Need user direction.
- **Q-1 (F-8-006):** intentional that `apply-pipeline.js:483` bypasses the RA pricing kill-switch? — defense-in-depth or strategy autonomy?
- **Q-2 (F-8-004):** what was `subscribeBus("ctx:ready", …)` in `strategy-hub-designer-tile.js` meant to do? — wrong bus or repurpose intent?

### Handoff notes (for Phase 2 / next session)

- The three audit scripts in `scripts/` are repeatable ground truth. Re-run after each batch of fixes to confirm no regression in orphan/bus/settings-writers counts.
- The `audit-bus.py` script under-counts dynamic-topic emits (canopy `_emit(event, payload)` fan-out, `_emitStage` aliases). For thorough bus coverage prefer agent G's `audit/pathway-bus.md` plus this script.
- The 33 violations of H-001 are the highest-leverage cleanup item for the entire session — once they're all on `AesSettings.saveArea`, the `chrome.storage.local.set({settings})` race is fully closed in production.
