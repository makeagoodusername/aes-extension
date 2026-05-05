# Findings — Agent 6 (Substrate)

**Phase 2 underway.** Territory: `modules/_shared/**`, `modules/central-hub/{shell,host,tile,tile-registry,activity-strip,salience,feed,hero-strip}.js`, `modules/site-skin/**`, `modules/command-palette/**`, `modules/unified-settings/**`, `modules/aes-menu.js`, `helpers.js`, `css/**`.

## Summary

10 findings — **3 FIXED, 7 remaining**:
- `[BUG]` × 2  → both **FIXED** (F-AGENT6-001 c4650cb, F-AGENT6-002 4fe02d1)
- `[WIRING-GAP]` × 1  → **FIXED** as part of F-AGENT6-004 (c7b08b5)
- `[INVARIANT-RISK]` × 2  → confirmed OK (no fix required)
- `[DEFERRED-CONFIRMED]` × 1  → no action
- `[QUESTION]` × 4  → awaiting user input

Static `node --check` clean across all three edited substrate files. SHARED-NOTES post follows for extension-reload coordination.

---

## F-AGENT6-001 — fork-deriver.js registers ZERO palette commands [BUG] (HIGH) — **[FIXED] c4650cb**

**File:** `modules/command-palette/derivers/fork-deriver.js`
**Severity:** HIGH — three advertised palette commands never appear, even on the dashboard where the deriver is loaded.

### What's broken

The deriver tries to register three commands (`strategy.fork.create`, `strategy.fork.simulate4`, `strategy.fork.simulate12`) via:

```js
function _api()      { return window.AESCommandPalette || null }
function _register(s){ const api = _api(); if (!api || typeof api.register !== "function") return null
                       try { return api.register(s) } catch (_) { return null } }
```

`window.AESCommandPalette` (from `modules/command-palette/host.js:480`) only exposes `{open, close, toggle, dispatch}` — there is no `register` method on it. The actual registry is `window.AESCommandRegistry` (from `modules/command-palette/registry.js:222`), which has `{register, list, dispatch, recent, subscribe}`.

Because the `typeof api.register !== "function"` guard is true, every call short-circuits to `return null`, but `_attach()` returns `true` regardless (line 65) so the rAF retry loop also exits cleanly. The deriver believes it succeeded; the user sees no fork commands in Cmd-K.

### Evidence

- `host.js:480`: `window.AESCommandPalette = {open, close, toggle, dispatch}`
- `registry.js:222`: `window.AESCommandRegistry = {register, list, dispatch, recent, subscribe}`
- `fork-deriver.js:14`: `function _api() { return window.AESCommandPalette || null }`  ← wrong global
- HANDOVER §1 (Trust→Drift→Foresight wave) claims: "Cmd-K → 'Fork current snapshot'" lights the counterfactual lab tile. Verified statically: it does not.

### Fix shape (Phase 2)

One-line: change `_api` to return `window.AESCommandRegistry`. (The registry's `register()` returns an unregister function, matching the deriver's null-return contract.) Comment update: the file's docstring also says "The palette is the only keyboard surface in v1" — palette = the host; the registry is what the host queries. The deriver should target the registry.

### Out-of-territory note

This is fully inside Agent 6's territory (`modules/command-palette/**`). No cross-agent coordination required.

---

## F-AGENT6-002 — Command palette `RECENT_CAP` is 20, not 8 [BUG] (LOW) — **[FIXED] 4fe02d1**

**File:** `modules/command-palette/registry.js:54`

The constant is `RECENT_CAP = 20`. Both AGENT-6.md brief (§Priority audit areas item 6) and HANDOVER §4 (`commandPalette:recent[:acct:<accountId>]` row) state cap = 8 ("`[{id, ts}]` — newest-first ring of dispatched command ids, capped at 8"). The current behaviour is harmless (a longer ring just remembers more recents) but the storage-key documentation contract in HANDOVER §4 is now wrong.

Three options:
- Lower constant to 8 (matches docs + HANDOVER).
- Update HANDOVER §4 + `commandPalette:recent` row to say 20.
- Keep 20 and document the rationale in HANDOVER (recent recency ranking benefits from a deeper ring at trivial storage cost: 20 × ~50B = 1KB, well under sync limits).

I'd lean toward option 1 (lower to 8) for the slim-by-design contract. Want a recommendation captured in `audit/manifest-requests.md` or HANDOVER §10?

---

## F-AGENT6-003 — `data-bus-topics.js` documents CentralHubBus topics under AesDataBus registry [WIRING-GAP] / [QUESTION]

**Files:** `modules/_shared/data-bus-topics.js` (registry), `modules/conductor/{trust-driver,drift-driver,threshold-store}.js`, `modules/strategy/{fork-store,forward-simulator}.js`, `modules/central-hub/tiles/{conductor-trust,drift,counterfactual-lab}-tile.js`

The eight Trust→Drift→Foresight topics are listed in `AES_DATA_BUS_TOPICS` (data-bus-topics.js:217–266) and self-register on `AesDataBus.register(...)` (line 281–286). However, all eight are emitted on `CentralHubBus` (e.g. `trust-driver.js:102`: `b.emit("signal:conductor:tier:promoted", …)` where `b = window.CentralHubBus`), and consumed via `CentralHubBus.on(...)` in the three tiles.

**Effect today:** topics work end-to-end (every emit has a matching subscriber). But:
1. `AesDataBus.auditTopics()` lists them under "registered" while they never actually flow through AesDataBus — confusing for the data-flow-inspector tile.
2. Strict-mode `AesDataBus.setStrict(true)` won't warn about real drift on these topics.
3. The file's docstring (line 5) says "Canonical topic registry for `AesDataBus`" — verifiably untrue for these eight.

**Sub-question:** is the design intent for the registry to span both buses (and maybe `AesAfp.bus` / `AesStrategy.bus` too), or do these topics belong moved to a sibling registry, or do the emits move to `AesDataBus`? HANDOVER §1 (top wave) doesn't take a position.

I'm the registry owner; I won't move emits across buses without explicit guidance. Flagging for a §10 invariant call from the user.

---

## F-AGENT6-004 — Several AesDataBus topics emitted from non-registry sources [WIRING-GAP] (LOW) — **[FIXED] c7b08b5**

The following topics are emitted somewhere but not in `AES_DATA_BUS_TOPICS`:

| Topic | Emitter |
|---|---|
| `data:account:bootstrapped` | `central-hub/shell.js:68`, `central-hub/feed/index.js:66` |
| `data:accounting:weekly:saved` | `central-hub/feed/index.js:35` |
| `data:strategy:applied:saved` | `central-hub/feed/index.js:43` (via `bridgeStorage`) |
| `data:strategy:settings:saved` | `central-hub/feed/index.js:49` (via `bridgeStorage`) |
| `data:command-palette:opened/closed/invoked/etc.` | `command-palette/host.js:475` (via dynamic kind) |
| `data:strategy:layered:{division,family,fleet,route-extras}-changed` | `modules/strategy/layered/*-store.js` |

All have real subscribers (HubFeed slices' `deps`, store-cache.js, etc.). The drift is the registry — adding entries with `emittedBy` and `hint` would make `auditTopics()` accurate and let strict mode work as intended. Pure documentation work; no behaviour change.

---

## F-AGENT6-005 — `acctKey()` signature documented incorrectly in brief [QUESTION]

**File:** `modules/_shared/account-scoped-key.js:28`

The brief at AGENT-6.md (Priority audit area 5) says `acctKey(prefix, accountId, suffix)`. The actual signature is `acctKey(prefix, suffix)` — accountId is read from `window.__aesAccountId` synchronously inside. The 3-arg form is `acctKeyForAccount(prefix, accountId, suffix)` (line 42), used by cross-account aggregators (Fleet Command, etc.).

Not a bug. Just a mismatch between brief and code. Mentioning so I don't waste time hunting for the 3-arg `acctKey` signature.

---

## F-AGENT6-006 — `AesCleanup.unregister` documented in brief, missing from API [QUESTION]

**File:** `modules/_shared/cleanup-registry.js:106–111`

Brief (Priority audit area 2) says the API is `register / list / runAll / unregister`. The actual surface is `register / runAll / runOne / list`. There is no `unregister` — `register()` is idempotent (re-registering by name overwrites, line 42–43). Two consumers exist: `route-assistant/demand-store.js:166` and `used-aircraft-scanner/price-history-store.js:226`. Neither needs unregister.

If a future store wants ephemeral cleanup (mounted/unmounted), `register` returning an unregister function — the same shape as `AesDataBus.on()` — would be the cleanest add. Flagging for design review; not blocking anything today.

---

## F-AGENT6-007 — bus-topic dead-emit / dead-listener noise from `scripts/audit-bus.py` [QUESTION]

The audit script (run with `python3 scripts/audit-bus.py`) lists ~20 "dead emit" or "dead listener" topics across the four buses. Most are false positives because the script's regex looks for direct `BusName.emit(...)` calls and misses:

- `b.emit(...)` patterns where `b = window.BusName` is hoisted (e.g. trust-driver.js, fork-store.js) — these get tagged as dead listeners on CentralHubBus
- AesView/HubFeed `deps:[topic]` that subscribe internally via `bus.on(topic, …)` inside view-engine.js — these tag as dead emits on AesDataBus (e.g. `data:accounting:weekly:saved` has `cash-feed.js` declaring it as a dep, but the audit script doesn't see that as a subscriber)

A handful are genuine drift, however:
- **CentralHubBus dead emits (genuine)**: `tile-pin-changed` (pin-affordance.js); `waveeditor:wave-{archived,cloned,split}` (wave-editor.js); `conductor:routine:{spawned,transition}` (routine-engine.js).  → All wave-editor and conductor topics are out-of-territory; flagging for Agents 3 and 4.
- **CentralHubBus dead listener (genuine)**: `briefing:dismissed` (subscribed by strategy-briefing-tile.js) — HANDOVER §1 Slice 16 says the briefing tile emits this topic. I see the subscriber but the emit is missing in `_openFullBriefing` / dismiss handlers. Out-of-territory (Agent 3 owns strategy/briefing modules).

Recommend Agent 8 review when consolidating.

---

## F-AGENT6-008 — Site-skin sync key invariant honoured [INVARIANT-RISK / OK]

`aes_skin_enabled` and `aes_skin_density` round-trip through `chrome.storage.sync` from three call sites:

- `modules/site-skin/bootstrap.js:62–77` (read on document_start, listen for changes, mirror to `<html data-aes-skin>`)
- `modules/site-skin/bootstrap.js:106–115` (writers — `setEnabled`, `setDensity`, `cycleDensity`)
- `modules/aes-menu.js:96–106` (reads via `window.AESSiteSkin.isEnabled() / getDensity()`, writes via `setEnabled / cycleDensity`)
- `options.js` (per HANDOVER §4 sync-keys table, not yet inspected; flagging for next pass)

The data flow is single-source-of-truth: storage → bootstrap → `AESSiteSkin.*` → menu/options. AES menu live-updates state badges via `chrome.storage.onChanged` listener (aes-menu.js:171–179). The `<html data-aes-skin>` stamp lands at document_start (`run_at: "document_start"` in manifest.json:53). All confirmed by inspection.

This is a working invariant — not a bug, but worth confirming once live in the user's Chrome instance during Phase 2 verification (toggle skin off, ~50ms revert; Shift+D density cycle).

---

## F-AGENT6-009 — `aesStrategy:lastSeenAt[:acct:<id>]` single-source-of-truth verified [INVARIANT-RISK / OK]

Both write paths confirm to the same key shape:

- `modules/central-hub/activity-strip.js:226–243` — `_lastSeenKey()` resolves `aesStrategy:lastSeenAt:acct:<id>` (legacy fallback when no account); `_onAcknowledge()` writes `{ts, weekId: null}`.
- `modules/central-hub/tiles/strategy-briefing-tile.js:847–852` — same key, writes `{ts, weekId: <briefing.weekId>}`.

Both readers (activity strip's `_loadLastSeen` line 161–165; briefing builder `modules/strategy/briefing.js:63`) read from the scoped key first, fall back to legacy. HANDOVER §4 records this contract.

No bug; just documenting that the invariant is honoured. Worth a smoke during live verify.

---

## F-AGENT6-010 — Wave-registry / drag-affordance-store consumers v1-deferred [DEFERRED-CONFIRMED]

Per HANDOVER §1 (manifest wiring overhaul, deferral list items #1 + #2):
- "**`drag-affordance-store.js` consumer** — wired but no UI reads from it; its `dragSubmitMode` field is competed-for by `settings.aircraftFlightPlan.dragSubmitMode` (the live source)."
- "**`wave-registry.js` consumers** — the aggregator is loaded but Fleet Command and rebalance proposers still don't consume it."

Confirmed by grep — the modules load (manifest entries exist) but no consumer reaches into them. Both are intentional v1 deferrals; AGENT-6.md brief specifically says drag-affordance-store is verified-as-loaded, no consumer expected. Wave-registry is RA territory (Agent 2/3) and the AGENT-6 brief says "**deferred**".

No action needed in my territory.

---

## Top 3–5 issues I'd fix first

1. **F-AGENT6-001 (HIGH)** — **DONE c4650cb.** `fork-deriver.js` now targets `AESCommandRegistry`. Three Slice-21 fork commands should appear in Cmd-K after extension reload.
2. **F-AGENT6-002 (LOW)** — **DONE 4fe02d1.** `RECENT_CAP` lowered from 20 to 8 to match docstring + HANDOVER §4.
3. **F-AGENT6-004 (LOW)** — **DONE c7b08b5.** `data-bus-topics.js` now registers 11 newly-discovered emit sites + folds in 8 prior uncommitted K11/K14/Slice21 entries (already in working tree). `auditTopics()` is now truthful.
4. **F-AGENT6-003 (QUESTION)** — still parked. Need user input on whether the K11/K14/Slice 21 topics should move to `AesDataBus` or whether the registry intentionally covers `CentralHubBus` too.

## Phase 2 — fixes landed (2026-05-01)

| Finding | Commit | One-liner |
|---|---|---|
| F-AGENT6-001 | `c4650cb` | fork-deriver targets AESCommandRegistry, not Palette host |
| F-AGENT6-002 | `4fe02d1` | RECENT_CAP back to 8 (docstring + HANDOVER §4) |
| F-AGENT6-004 | `c7b08b5` | register K11/K14/Slice21 + 11 newly-discovered emit sites |

`node --check` clean for all three files. Posted SHARED-NOTES coordination notice for other agents to reload extension after pulling.

## Open questions / blockers

1. **Out-of-territory bus dead-emits/listeners** (F-AGENT6-007) — the genuine wave-editor + conductor:routine + briefing:dismissed drift is Agent 3 / Agent 4 territory. Per CLAUDE.md §8 ("Do not write to other agents' findings files"), I'll leave them tagged here for Agent 8 to consolidate.
2. **Bus-registry reconciliation (F-AGENT6-003)** — still needs explicit user direction.
3. **Live Chrome verification (port 9238)** — pending. The Chrome instance is up; need to navigate to `/app/com/scheduling/<hub>` to confirm Cmd-K → "Fork current snapshot" now appears, and to dashboard to confirm `auditTopics()` no longer reports the 11 topics as drift.

## Handoff notes for next session

- **Phase 2 verify**: open port 9238 Chrome, navigate scheduling page (or fleet/dashboard depending on `AesStrategy + AesStrategyForkStore + AesStrategyForwardSimulator` availability), Cmd-K, confirm "Fork current snapshot" / "Run last fork forward 4/12 weeks" appear. Recent ring should now cap at 8 (previously 20).
- **F-AGENT6-003 user-call**: pick one of three options — (a) move K11/K14/Slice21 emits to `AesDataBus`, (b) split registry into per-bus files, (c) document that the registry intentionally spans both buses. I lean (c) with a docstring update and a tagged `bus:` field per entry.
- **F-AGENT6-005, 006** — brief↔code mismatches. Tiny doc fixes either way; not blocking.

## What I'd like instruction on

- Want me to attempt the live verification on port 9238 next, or defer until you've reviewed the three commits?
- Decision on F-AGENT6-003 to unblock the registry-cleanup pass.
