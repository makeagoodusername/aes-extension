# CLAUDE.md — AES Debug & Wire-Up Foundation (v2)

You are working on the **AirlineSim Enhancement Suite (AES)**, a Chrome MV3 extension. The project has moved out of the old audit-era, dry-run-first posture: proven pricing, Strategy, and AFP apply paths are now intended to run live against AirlineSim by default.

Read this file completely before doing anything else. Then read your territory-specific brief in `audit/AGENT-N.md`.

---

## 1 · Project quick facts

- **Repo root:** the user will tell you the path (likely `/Users/jihwan/Downloads/AES.v0.6.9-beta/` or a successor).
- **Manifest:** `manifest.json`, MV3, `version_name: "0.6.11-beta"`. ~869 `content_scripts` entries.
- **Stack:** vanilla JS + jQuery, no build step. IIFEs attaching to `window.<Namespace>`.
- **Module count:** 533 `.js` files in `modules/`.
- **Storage:** `chrome.storage.local`. Key prefixes are contracts (see `HANDOVER.md §4`).
- **Reference docs:** `HANDOVER.md` (live state, ~5000 lines), `MANUAL.md` (long-form reference).
- **Auth:** the extension does not read credentials files. Live verification uses an already-authenticated Chrome profile or transient harness credentials supplied by the user.

---

## 2 · The multi-Chrome execution model

Each of the eight agents has its own Chrome instance, its own profile directory, and its own session cookie jar. All instances are logged into the same AirlineSim airline. This means:

- **You can drive your own Chrome** to verify your fixes against the live game. You don't need to wait for Agent 8 to do it for you.
- **You will see other agents' actions reflected in AS** if multiple agents are testing simultaneously. Pricing changes, schedule writes, override saves — all visible cross-instance after a refresh.
- **Wicket page-version IDs are per-session.** Each Chrome instance has its own. You won't conflict with other agents at the Wicket level, but you may conflict at the **game state** level (e.g., two agents both trying to apply pricing on the same route).
- **The extension's own concurrency guards apply per-instance.** The pricing applier's circuit breaker, the silent-auto dedup, the AFP submit queue — all of these are per-tab. They don't coordinate across the eight instances.

### What this means for your behavior

**Permanent-live posture.** This checkout defaults proven writers to live mode. Do not reintroduce dry-run-only defaults unless the user explicitly asks for a reversible rehearsal gate.

**Coordinate destructive writes through `audit/SHARED-NOTES.md` when multiple agents are active.** Before clicking Apply on a real write or running autonomous pricing against a shared route set, write a single-line claim:

```
2026-04-30 14:23 — Agent 3 — taking real-write lock for ~5 min: testing IL applier on JFK→LAX
```

Check the file before you write your own claim. If another agent has an unreleased lock that's <10 min old, wait. The lock is honor-system; locks released by writing `RELEASED <timestamp>` on a new line.

**Read-only scrapes (markets, ORS, schedule pages) don't need a lock.** They hit AS but don't mutate state, and the per-instance circuit breakers handle rate limits.

Read-only scrapes do not need a lock.

---

## 3 · Inviolable rules

These rules existed before this session and will exist after. **Don't relax them.**

1. **No duplicate POST paths to AirlineSim.** Several modules write to AS forms (pricing applier, IL request applier, AFP form-driver via background batch, AFP dashboard flight-number applier). Reuse the established appliers/bridges instead of creating parallel form-submit logic.

2. **Storage key prefixes are contract.** Other modules and saved user data depend on them. You may add new keys (document in HANDOVER §4). You may not rename or reshape existing ones without a migration shim and an entry in §10 invariants.

3. **The AFP form-driver never auto-submits except via `fillAndSubmit` from the gated background pipeline.** Don't add a second submit path.

4. **`_pairKey` rules differ per file.** Symmetric (alphabetically sorted): `distance-resolver.js`. Directional (`<HUB>-<DEST>` literal): everything else.

5. **The bus is the integration contract** (`CentralHubBus` / `AesAfp.bus` / `AesStrategy.bus` / `AesDataBus`). New cross-module dependencies use the bus, not direct global reaches.

6. **Strategy modules use pure-function cores.** Do not add I/O inside `scoreRoutes`, `decideRoutes`, `diffPlan`, `dnaFitScore`, `_gradient`, `_connectivityTerm`.

7. **Live defaults are intentional.** `permanentLiveMode` keeps proven apply paths live across old stored settings. If a surface still returns `form-shape-not-yet-mapped`, implement the form mapping before claiming it is live.

The full invariant list is `HANDOVER.md §10`. Read it before editing anything load-bearing.

---

## 4 · Territory matrix

Eight agents, eight territories, file-path-prefix based with explicit overlap rules.

| Agent | Territory | Allowed write paths | Forbidden write paths |
|---|---|---|---|
| 1 | Manifest + load order + module reachability | `manifest.json`, `modules/_shared/manifest-audit/*` (new) | Any business logic file |
| 2 | Route Assistant panel + scrapers | `modules/route-assistant/**` | Strategy, Conductor, AFP, Canopy |
| 3 | Strategy + Conductor + Canopy + Alliance | `modules/strategy/**`, `modules/conductor/**`, `modules/canopy/**`, `modules/alliance/**`, related central-hub tiles | RA panel, AFP host |
| 4 | AFP + Fleet Hub + scheduling/wave/canvas | `modules/aircraft-flight-plan/**`, `modules/aircraft-flight-plan-dashboard/**`, `modules/fleet-hub/**`, `modules/schedule-management/**`, `modules/canvas/**` | RA panel, Strategy modules |
| 5 | UAS + World View + dashboard intelligence tiles | `modules/used-aircraft-scanner/**`, `modules/world-view/**`, related tiles, `content_dashboard.js`, `content_marketScan.js` | RA panel, Strategy, AFP |
| 6 | Substrate (`_shared`, central-hub shell, site-skin, command-palette, unified-settings) | `modules/_shared/**`, `modules/central-hub/{shell,host,tile,tile-registry,activity-strip,salience,feed,hero-strip}.js`, `modules/site-skin/**`, `modules/command-palette/**`, `modules/unified-settings/**`, `modules/aes-menu.js`, `helpers.js`, `css/**` | Tiles other than shell, business modules |
| 7 | Background, content-script entrypoints, options, popup, credentials handling | `background.js`, `content_*.js`, `options.html`, `options.js`, `popup.html`, `popup.js`, login automation | Anything inside `modules/**` |
| 8 | Test harness + cross-agent verification + consolidation | `audit/**`, `tests/**` (new), Playwright scripts | Any production module |

### Cross-agent overlap rules

- **`manifest.json`** — Agent 1 owns. Other agents request additions via `audit/manifest-requests.md`. Agent 1 batches.
- **`HANDOVER.md`** — All agents append findings to `audit/findings-AGENT-N.md`. Agent 8 consolidates at end.
- **Bus topic registry** (`modules/_shared/data-bus-topics.js`) — Agent 6 owns. Others request via `audit/bus-topic-requests.md`.
- **`HANDOVER.md §10` invariants** — Append-only by any agent. Agent 8 reviews for conflicts.
- **`SHARED-NOTES.md`** — Real-write lock claims (see §2 above), cross-agent observations, anything everyone should see.

If you find yourself wanting to edit outside your territory, **stop**. Write a finding tagging which agent should handle it. Don't edit cross-territory.

---

## 5 · Distinguishing "deferred by design" from "broken"

The handover documents many features as "v1 deferrals." These are intentional half-features the original author shipped. Examples:

- "Promote-to-Dispatch composer not yet shipped, so `promote()` returns `{ok:false}`" — **deferred**, not a bug.
- "DNA-fit pills on RA panel route rows deferred to L6" — **deferred**.
- "Cross-account trust pooling deferred" — **deferred**.

Examples of actual bugs (silent breakage):

- AFP drop bug — drag handle rendered but orchestrator's `applyDrop` callback was never wired.
- Rebalance applier silent-fail — drilldown apply gated on undefined namespace because manifest missed two files.
- Per-flight attribution — flightId regex bug picked up "1" from `free1` hostname.

**Your job is to fix bugs, not ship deferred features.** If something looks broken but the handover documents it as deferred, note in findings and move on. If the handover claims something is "shipped" but it's broken, that's a bug — fix it.

---

## 6 · Workflow per agent

For each session within your territory:

1. **Read your brief** (`audit/AGENT-N.md`).
2. **Read the relevant section of HANDOVER.md** — usually 200–600 lines for your territory.
3. **Audit before fixing.** First ~30 minutes: map your territory. Write to `audit/findings-AGENT-N.md` as you go. Categorize:
   - `[BUG]` — claims to work, doesn't.
   - `[DEFERRED]` — intentionally half-wired per HANDOVER.
   - `[WIRING-GAP]` — module exists but not loaded or not consumed.
   - `[INVARIANT-RISK]` — code that, if changed wrong, breaks something.
   - `[QUESTION]` — needs human or cross-agent input.
4. **Fix in priority order.** Wiring gaps and bugs first; refactor only as needed.
5. **Verify each fix.**
   - Pure-function cores: write Node-runnable smoke under `audit/tests/<territory>/`.
   - UI/scrape logic: drive your own Chrome instance against AS to verify (acquire SHARED-NOTES lock if mutating).
   - Read-only verifications: just go.
6. **Commit per fix** with messages like `fix(strategy): apply-pipeline crash when alliance moves array empty`.
7. **Append to findings.md**: `[FIXED]`, `[BLOCKED]`, `[DEFERRED-CONFIRMED]`, `[OUT-OF-TERRITORY]`.

---

## 7 · Verification approach

You have your own Chrome instance with the extension loaded and AS logged in. Use it.

**Static analysis** — `node --check modules/**/*.js` after every batch of edits.

**Manifest validation** — `python3 -c "import json; json.load(open('manifest.json'))"` after any manifest touch.

**Pure-function smoke** — many modules have `?aes-debug` console smokes. Re-run them against the code.

**Reachability check** — for any module you suspect isn't loaded, grep the manifest. If absent, `[WIRING-GAP]`.

**Bus topic check** — for any `bus.emit` or `CentralHubBus.emit`, grep for matching `bus.on`. No subscriber → `[WIRING-GAP]` or `[DEFERRED-CONFIRMED]`.

**Live verification** — open your Chrome, navigate to the relevant AS page, check DevTools console for errors, click through the affected feature, observe.

For verifications requiring cross-agent coordination (e.g., "I need to test apply path while no other agent is writing"), acquire the SHARED-NOTES lock first.

---

## 8 · Communication artifacts

You write to (and only to) these directories under repo root:

- `audit/AGENT-N.md` — your brief (read-only after user wrote it; you may append `## Notes`).
- `audit/findings-AGENT-N.md` — your running log. Append-only. One section per finding.
- `audit/manifest-requests.md` — Agent 1 reads; everyone else appends.
- `audit/bus-topic-requests.md` — Agent 6 reads; everyone else appends.
- `audit/SHARED-NOTES.md` — real-write locks + cross-agent observations. Append-only with timestamp + agent number.
- Your code edits within your territory.

Do not write to other agents' findings files. Do not edit `HANDOVER.md` directly during the session — Agent 8 consolidates at end.

---

## 9 · Tone and posture

- Be skeptical of the codebase. Half is half-wired.
- Be skeptical of HANDOVER.md too — written cumulatively, some entries don't reflect current state.
- Don't trust comments saying "this works" without verifying.
- When in doubt, write a finding. The user prefers visibility over speed.
- The user is non-technical. Findings should be scannable. Lead with the bug, not the diff.

---

## 10 · End-of-session deliverable

When your window is up, your `audit/findings-AGENT-N.md` should contain:

1. **Summary** at top: `N findings, M fixed, K blocked, J deferred-confirmed`.
2. **Per-finding sections** with disposition and (if fixed) commit hash.
3. **Handoff notes** — what next session should pick up first.
4. **Open questions** for the user.

Agent 8 reads all eight files at end, consolidates into `audit/SESSION-SUMMARY.md`, and proposes HANDOVER.md additions for user review.

---

## 11 · One last thing

You have a real Chrome instance. The other seven agents may have real Chrome instances. You're all logged into the same airline. **Be a good neighbor.** Check SHARED-NOTES before destructive writes, prefer mapped live appliers over ad-hoc writes, prefer reads over unrelated writes, and prefer your own scratch route over a route someone else might be testing.

The biggest risk isn't AS — it's eight agents producing inconsistent fixes that take longer to untangle than to fix manually. Confidence in your territory, restraint everywhere else.

Good luck.
