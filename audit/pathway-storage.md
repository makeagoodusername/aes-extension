# Storage envelope audit (read-only)

Agent H — slice/e-integration. Static analysis only; no execution; no code edits.

## Inventory

| Metric | Count |
|---|---|
| `chrome.storage.local.set(` sites | 235 |
| `chrome.storage.local.get(` sites | 462 |
| `chrome.storage.local.remove(` sites | 79 |
| `chrome.storage.onChanged` sites (incl. add/remove/comments) | 182 |
| `chrome.storage.local.getKeys(` sites | 2 (price-history-store reference + comment) |
| `AesSettings.saveArea(` callers | 4 (across 2 stores: SchedulePresets, RouteLauncherDefaults) + bridge body |
| `AesSettings.loadArea(` callers | 0 (does not exist; bridge exposes `getArea`/`loadAll`) |
| `AesSettings.save(` / `.load(` legacy API | 0 (not exposed) |
| Distinct logical key prefixes (regex sweep) | ~245 (estimate; many `<server>:<airline>` and pair-specific permutations) |

Top‑level **content_*.js** legacy files contribute ~65 raw `chrome.storage.local.*` calls (mostly `content_dashboard.js`, `content_inventory.js`, `content_settings.js`, `content_personelManagement.js`, `content_aircraftFlights.js`, `content_enterpriceOverview.js`).

## Per-area envelope

| Key prefix | Writers | Readers | Acct-scoped? | Cap / eviction | Schema-version | Notes |
|---|---|---|---|---|---|---|
| `aesStrategy:audit` | strategy/apply-pipeline.js (`_persistAudit`) | apply-pipeline.getAudit; central-hub tiles (strategy-briefing, diagnostics, strategy); change-log-aggregator | YES via `_scopedKey()` (legacy fallback) | ring 500 (`AUDIT_RING`) | — | Scoped writer skips legacy key when scoped key exists; scoped read falls back to legacy on miss for legacy installs (correct). |
| `aesStrategy:plan:applied` | strategy/apply-pipeline.js (`_persistApplied`) | central-hub/feed/strategy-feed, tiles/strategy-tile, command-center, world-view-tile | YES (`acct:<id>` suffix) with legacy fallback | single-blob | — | Writer uses scoped-only when accountId resolved; central-hub readers read both scoped and legacy. Consistent. |
| `aesStrategy:autoTick:last` | strategy/auto-driver.js | strategy/briefing.js, central-hub/diagnostics-tile, strategy-briefing-tile, fleet-hub/command-center | YES (writes BOTH legacy and scoped) | single-blob | — | Writer dual-writes (line 102‑104). Risk: divergent updates from cross-account ticks since legacy is written in every realm regardless of accountId. |
| `aesStrategy:autoTick:lastAppliedGameDate` | auto-driver.js | auto-driver.js | NO (global) | single-blob | — | OK — process-singleton gate. |
| `aesStrategy:autoTick:firstActivationAck` | auto-driver.js | auto-driver.js | NO | single-blob | — | OK. |
| `alliance:ilRequestApplyLog:acct:<id>` | il-request-applier (active key) | il-request-applier (read with one-shot legacy fallback) | YES | ring 50 | — | Cleanly scoped. Writer keeps legacy key static for back-compat. |
| `aesConductor:fires:<server>:<airline>` | conductor/scenario-store.js | conductor/scenario-store.js, signal-layer, central-hub tiles | NO (server+airline only) | ring 200 | — | RMW race risk: 5 mutating methods (append/dismiss/accept/applyOutcome/clear) all read‑modify‑write the full array without serialization. Concurrent fires/dismissals lose updates. |
| `aesConductor:routines:<server>:<airline>` | conductor/routine-store.js | conductor/routine-store.js, conductor/routine-orchestrator | NO | cap 100 (completed‑first eviction) | — | Same RMW race in `append()` + `update()`. |
| `aesConductor:signals:<...>` | conductor/signal-store.js | signal-layer | NO | ring (TBD) | — | Same RMW pattern. |
| `routeAssistant:topRoutes` (global) and `routeAssistant:topRoutes:<HUB>` | route-assistant/panel.js (line 10316), canvas/advanced-toggle | accounting/aggregator, panel.js (Q13 bulk), schedule-management/open-stations-modal, scrape-orchestrator/enumerators, used-aircraft-scanner/results-table, route-assistant/view-heatmap | NO (HUB only) | single-blob per HUB; global key is "last render" | — | Global key + per‑HUB key co-exist; reader paths are aware. F-9223-016 already audited the staleness aging. |
| `routeAssistant:waveFavorites:acct:<id>` | wave-favorites-store | wave-favorites-store, wave-palette, wave-registry | YES (legacy fallback) | single-blob | — | RMW: `noteUsed()` increments useCount via load → mutate → save. Two near‑simultaneous palette opens lose increments. |
| `routeAssistant:waveKeybinds:acct:<id>` | wave-keybinds-store | same | YES (legacy fallback) | single-blob | — | OK; user‑driven write rate is low. |
| `routeAssistant:pricingApplyLog` + `:<HUB>-<DEST>` | route-assistant/pricing-apply-log.js | same + audit pipeline | partial — has `_scopedKey` + scoped variants but `GLOBAL_KEY` legacy still actively read | ring DEFAULT_LIMIT (50) global; perRouteLimit | — | Mixed scope (see findings). |
| `competitorIntel:airport:<server>:<airportId>` | competitor-intel/competitor-store.js (`saveAirport`) | aggregator, hub-shell, change-log-adapter, competitor-store | NO (server-public) | TTL only via `isExpired` | — | Spec listed key as `competitorIntel:airport:<iata>` — actual is `<server>:<airportId>`. Doc drift. |
| `competitorIntel:enterprise:<server>:<id>` | competitor-store.saveEnterprise; outline-runner; snapshot-store | host, outline-aggregator, watchlist, change-log-adapter, strategy/alliance, strategy/context | NO (server-public, by design) | TTL only | `scrapedAt`/`builtAt` | OK; `competitorIntel:profile:` is a 6h render cache parallel. No automatic eviction — relies on `clearAll(server)`. |
| `competitorIntel:assignHandoff` | competitor-intel/outline-panel.js:667 | **NO READERS** | NO | single-blob | — | **Orphan write.** Set on hub‑select navigation; nothing reads the key. F-H-002. |
| `aesCanopy:dna` | dna-store.saveTemplate | dna-store, dna-account-editor, central-hub/dna-drift-tile | NO (template is canopy-wide) | single-blob | yes (`schemaVersion: 1`, `_normTemplate` deep-fills defaults) | OK. |
| `aesCanopy:dnaOverride:acct:<id>` | dna-store.saveOverride | dna-store, dna-drift-tile | YES (explicit accountId, NOT `acctKey()`) | single-blob | yes | Doc explicitly notes the design choice. OK. |
| `aesCanopy:bulkApply:log` | strategy/fleet-command-bulk-apply.js | same | NO | single-blob | — | Writer reads, appends, writes. RMW race. |
| `aesAccounts` | _background/account-registry.js (single writer pattern via tail Promise) | _shared/account-registry, command-bridge readers | global registry | single-blob | `migrationVersion` field | Hardened pattern (single-writer queue). Reference architecture for serialization. |
| `customization` | _background/customization-store.js | customization/store.js, command-palette | global | single-blob | yes | Same hardened pattern. |
| `settings` (root blob) | many (see findings) | many | per-area blocks splice via `AesSettings.getArea`/`saveArea`; F-9223-002 fixed the in-tab race | single-blob | — | Many writers still bypass `saveArea` (see F-H-001). |
| `scrapeOrchestrator:lastRun` | scrape-orchestrator/host.js | central-hub/shell.js | NO | single-blob | — | OK. |
| `scrapeOrchestrator:runState` | background-tab-pool.js | same | NO | single-blob | — | Writes via callback API rather than promise; pre-dates Promise API used elsewhere. |
| `aesAutoDrive:silentRunActive` | auto-driver.js | scrape-orchestrator/host.js | NO | bool | — | OK. |
| `aesAutoDrive:enabled` | **NO WRITERS in tree** | auto-driver.js (line 86) | NO | bool | — | **Orphan read.** Default-true means feature works; if a future surface tries to flip it, no shipped writer exists. F-H-003. |

## Findings (H-001 … H-009)

### H-001 — Direct `chrome.storage.local.set({settings: ...})` bypasses AesSettings.saveArea queue
- **Severity:** P1
- **Files (writers bypassing saveArea):**
  - `modules/used-aircraft-scanner/presets-store.js:398, 416`
  - `modules/used-aircraft-scanner/type-family-map.js:507`
  - `modules/route-assistant/settings-store.js:662, 964`
  - `modules/aircraft-flight-plan/settings-extension.js:348`
  - `modules/strategy/default-settings.js:525`
  - `modules/canopy/dna-account-editor.js:203` (writes `settings.strategy.riskProfile` directly)
  - `modules/schedule-management/open-stations-modal.js:278`
  - `modules/_background/legacy-defaults.js:88`
  - All `content_*.js` legacy: `content_dashboard.js` (10 sites), `content_inventory.js` (3), `content_settings.js` (5), `content_personelManagement.js` (5), `content_fligthSchedule.js`, `content_marketScan.js` (none currently — verified)
- **What's broken:** F-9223-002 hardened `AesSettings.saveArea` with a tail‑Promise queue. These 24+ direct writers do `get('settings') → mutate → set({settings: ...})` and re-introduce the exact RMW race the queue was added to fix. Two concurrent flips from any two of these paths lose one area.
- **Fix:** Migrate every direct `settings:` writer to `AesSettings.saveArea("<area>", block)`. The bridge already preserves siblings.

### H-002 — `competitorIntel:assignHandoff` is an orphan write
- **Severity:** P2
- **File:** `modules/competitor-intel/outline-panel.js:667`
- **What's broken:** Outline panel writes a handoff record then navigates away. No code in `modules/`, `*.js`, or `content_*.js` reads `competitorIntel:assignHandoff`. The receiver was supposed to prefill the AFP/scheduling page from the blob; that consumer never shipped.
- **Fix:** Either (a) wire AFP `host.js` / scheduling content script to consume + delete the blob on destination load, or (b) drop the write and use a session‑bus topic instead.

### H-003 — `aesAutoDrive:enabled` is an orphan read
- **Severity:** P2
- **File:** `modules/scrape-orchestrator/auto-driver.js:86-87`
- **What's broken:** Auto‑driver reads `aesAutoDrive:enabled` as the master toggle but no shipped UI/setting writes the key. The toggle is therefore permanently `undefined → defaults to true`. Any future "stop auto‑drive" affordance will silently no‑op until a writer is added.
- **Fix:** Add a writer (options.html toggle or central-hub control) or hard‑code the default and remove the read.

### H-004 — Conductor stores have unmitigated RMW races on per‑server rings
- **Severity:** P1
- **Files:**
  - `modules/conductor/scenario-store.js:51-128` (5 mutating methods)
  - `modules/conductor/routine-store.js:84-99`
  - `modules/conductor/signal-store.js:33-62`
- **What's broken:** Each mutator does `await _read() → mutate array → await chrome.storage.local.set([key], arr)`. Multiple in‑flight signal/fire/dismiss calls on one tab (or across tabs in a federation) read the same baseline array and the last writer overwrites the others. Lost fires, lost dismissals, lost outcome attributions break K10/K11 trust scoring at exactly the moments it matters.
- **Fix:** Wrap each store with the tail‑Promise queue pattern from `_background/account-registry.js` (`_aesAccountTouchQueue`). Single‑writer guarantees ordering within a realm; cross-realm needs a background mailbox.

### H-005 — `routeAssistant:waveFavorites` `noteUsed()` lost-increment race
- **Severity:** P2
- **File:** `modules/route-assistant/wave-favorites-store.js:52-61`
- **What's broken:** Two near‑simultaneous palette opens both read `useCount=N`, both write `useCount=N+1`. Final value is `N+1` instead of `N+2`. Same class of bug as H-004 but smaller blast radius (recency rail ordering).
- **Fix:** Same tail‑Promise queue, or migrate to `chrome.storage.session` for ephemeral counters.

### H-006 — `aesStrategy:autoTick:last` writer dual-writes legacy and scoped on every tick
- **Severity:** P2
- **File:** `modules/strategy/auto-driver.js:102-104`
- **What's broken:** When `accountId` resolves, the writer writes BOTH the scoped key AND the legacy `aesStrategy:autoTick:last`. In federations, every account's tick clobbers the legacy slot, so any reader still on the legacy path (no scoped fallback yet) reads whichever account ticked last. F-9227-008 already addressed the parallel `aesStrategy:plan:applied`/`aesStrategy:audit` paths the same way (scoped‑only when accountId resolves) — autoTick wasn't migrated.
- **Fix:** Mirror `_persistAudit`/`_persistApplied`: when scoped key resolves, drop the legacy write.

### H-007 — `aesCanopy:bulkApply:log` RMW + no cap evidence
- **Severity:** P3
- **File:** `modules/strategy/fleet-command-bulk-apply.js:361-381`
- **What's broken:** Reads ring, appends entry, writes. No cap check visible in the persist path (need to read more). Concurrent bulk applies (one per sister account) collide.
- **Fix:** Tail‑Promise queue + explicit cap.

### H-008 — `routeAssistant:pricingApplyLog` mixed-scope writers
- **Severity:** P2
- **File:** `modules/route-assistant/pricing-apply-log.js`
- **What's broken:** Writer paths mix `GLOBAL_KEY` (legacy) and `_scopedKey` variants. `add()` writes both to global and per-route ring at lines 140‑151 (further block at 187 also writes); reads at 168, 200, 308, 376, 423 use `GLOBAL_KEY` directly without account scoping. Per HANDOVER §4.14 the apply log is per-airline data and should be acct-scoped throughout. Two airlines on one machine see each other's pricing applies in the global ring.
- **Fix:** Audit every read against `_scopedKey()` resolution; deprecate direct `GLOBAL_KEY` reads once writers all scope.

### H-009 — Spec drift: `competitorIntel:airport` envelope shape
- **Severity:** P3 (doc-only)
- **Files:** `modules/competitor-intel/competitor-store.js:22`, audit task brief
- **What's broken:** Task brief says `competitorIntel:airport:<iata>`. Code says `competitorIntel:airport:<server>:<airportId>` (numeric airport id, not IATA). Confirms the design (server‑public data) but the envelope name in §6 of the task brief is stale.
- **Fix:** Update task brief / docs to match code.

## Account-scoping gaps

Keys that look like per-airline data but appear unscoped in current writers:

- `aesConductor:fires:<server>:<airline>` and `aesConductor:routines:<server>:<airline>` — encode `airline` in the key but **not via `acctKey()`**, so two browser profiles for the same `(server, airline)` pair share state and federation routing of fires can't differentiate them. May or may not be intended (one airline = one canopy account in practice), but the `airline` in the key bypasses `:acct:<id>:` and is therefore not federation‑safe.
- `routeAssistant:topRoutes:<HUB>` — global hub-keyed; if two sister airlines share a hub IATA they trample each other's last‑render snapshot. Not always wrong (snapshot is an aggregate view) but no comment documents the intent.
- `aesCanopy:bulkApply:log` (H-007) — single global key; no scope.
- `routeAssistant:pricingApplyLog` (H-008) — partial migration.

Mixed-scope writers (some calls scope, others don't):
- `pricing-apply-log.js` — same store, both scoped and legacy paths active.
- `aesStrategy:autoTick:last` (H-006) — writes both keys.
- `route-assistant/settings-store.js` — saves `settings.routeAssistant` at the legacy slot AND `settings.acct.<id>.routeAssistant` at the L2 slot (`STORES.md:11` documents this; OK during rollout but two concurrent saves can race against each other through the same `chrome.storage.local.set({settings})` path → see H-001).

## Orphan keys

**Written never read** (within `modules/` + root `*.js`):
- `competitorIntel:assignHandoff` (H-002)

**Read never written**:
- `aesAutoDrive:enabled` (H-003)

(No further orphans surfaced from the literal-key sweep; many keys are dynamically constructed and verified by-prefix at read time, which prevents simple grep.)

## Schema drift

- `aesCanopy:dnaOverride:acct:<id>` — writer normalises via `_normOverride` (sparse). Reader resolves through `effectiveDnaSync` which deep-fills from `DEFAULT_TEMPLATE`. Adding a new dimension to `DIMENSIONS` automatically migrates legacy blobs by virtue of `_normTemplate` defaults — well-designed for forward evolution.
- `aircraftFlightPlan:schedule:<server>:<aircraftId>` — `schedule-store.js:68` returns `null` on `schemaVersion` mismatch (hard fail vs. migration). Future bumps will silently nuke existing schedules until consumers re-scrape.
- `aesAccounts.migrationVersion` gates `_shared/migrate-legacy.js` — looks correct.

No active writer/reader shape mismatch found in the seven envelopes covered by §6 of the brief; the canopy stores all carry `schemaVersion: 1` and reader normalisers fill defaults.

## Storage-cache layer caveats

`modules/_shared/store-cache.js`:
- F-9223-003 fix in place: 50ms write‑suppress now compares `c.newValue` to `existing.value` via `_echoEqualsWrite` JSON-stringify equality before suppressing.
- **Caveat 1:** `_echoEqualsWrite` uses `JSON.stringify` for object compare; objects with non-deterministic key order or `undefined` leaves can produce false negatives, causing harmless double-updates. Low impact.
- **Caveat 2:** No partition by namespace. `MAX_ENTRIES = 10000` LRU is shared across all keys; bulk reads (e.g. `chrome.storage.local.get(null)` calls — 36 sites — each followed by individual record updates) can churn smaller caches.
- **Caveat 3:** Account-bootstrap purge (`data:account:bootstrapped` listener at line 150) is a documented no-op. Pre-bootstrap reads of legacy unscoped keys remain in L0 indefinitely, returning stale legacy data after bootstrap until next remote write or explicit invalidate. Manifests as: panels open before account resolves → see legacy data → never refresh once scoped writers take over.
- **Caveat 4:** `chrome.storage.local.get(null)` paths bypass L0 entirely (the cache is per-key). 36 callers do this; each is unconditional storage read. Not a correctness bug but an opportunity for a `getAll(prefix)` primitive.

## Recommendations (top 3)

1. **Single-writer tail-Promise queue for every RMW ring store.** Replicate `_aesAccountTouchQueue` in `_background/account-registry.js` for: conductor/scenario-store, conductor/routine-store, conductor/signal-store, route-assistant/wave-favorites-store, strategy/fleet-command-bulk-apply, every per-route ring in route-assistant/*-apply-log/*-store. This unblocks K10/K11 trust scoring (H-004), prevents lost favourites (H-005), and prevents pricing-apply ring tearing (H-008). Implementation is ~10 lines per store.

2. **Migrate every `chrome.storage.local.set({settings: ...})` writer to `AesSettings.saveArea`.** F-9223-002 fixed the bridge; until the 24+ direct callers (H-001) are migrated, the area‑splice race is still live in production for routeAssistant, AFP, strategy, used-aircraft-scanner, schedule-management, and every legacy `content_*.js` page. This is the highest user-visible blast radius — settings flips on the most common pages still drop sibling areas.

3. **Wire or remove the orphan keys (H-002, H-003).** `competitorIntel:assignHandoff` is dead infrastructure; either land its consumer in AFP/scheduling host or replace with a bus topic. `aesAutoDrive:enabled` either needs a writer (options.js toggle) or the read should be removed and the default hard-coded — right now the `master toggle` in the auto-driver docstring is fictional.
