# Findings — Agent 2 (Route Assistant Panel & Scrapers)

## Phase 1 audit — complete

Territory: `modules/route-assistant/**`. ~74 files, ~14k-line panel.js.

**Counts so far:** 12 findings → 7 [VERIFIED] / 2 [WIRING-GAP] / 2 [QUESTION] / 1 [INVARIANT-RISK] (no [BUG] yet — strategic invariants all hold).

---

## [VERIFIED] flightId regex fix is in current code
- **Where:** `content_aircraftFlights.js:414` (Agent 7's territory — read-only verification only).
- **Code:** `const idMatch = url.match(/[?&]id=(\d+)/)`. Strict capture-group form; will not match `1` from `free1` hostname.
- **Cross-references in RA:** `yield-snapshot.js:300` consumes `env.flightId` from the envelope (no regex of its own). `markets-page-scraper.js:564` uses `/flight\?id=(\d+)/.exec(...)`. `ors-scraper.js:409` same pattern. All safe.
- **Disposition:** No bug. HANDOVER's documented fix is in place.

---

## [VERIFIED] Tier 3 two-gate model intact
- `pricing-applier.js:163–164` — constructor reads `dryRunOnly !== false` (defaults TRUE) and `applyEnabled` via `!!opts.applyEnabled` (defaults FALSE). `apply():584` computes `dryRun = !!opts.dryRun || this.dryRunOnly || !this.applyEnabled` — caller cannot bypass instance gates.
- `panel.js:14002 _getPricingApplier` threads settings through correctly.
- Circuit breaker persistence (`onBreakerTrip` → `_persistPricingBreakerTrip`) writes `circuitBreakerTrippedAt` to settings; reset path nulls it on first verified write.
- Step-0 cooldown gate at `pricing-applier.js:643` is dry-run-exempt (intentional per §10).
- **Disposition:** No bug. Two-gate + breaker invariant satisfied.

---

## [VERIFIED] silent-auto adds third gate (`liveScopes.silentAuto`)
- `panel.js:23244` requires `liveScopes.silentAuto === true` AND `apply.enabled` AND `!apply.dryRunOnly` for live silent-auto writes. All three required, otherwise dry-run.
- **Disposition:** No bug. Aligns with §10 "no silent default flips" — silent-auto is opt-in over and above the manual two-gate.

---

## [VERIFIED] silent-auto cross-tab dedup re-reads from storage
- `panel.js:23145–23161 _silentAutoTickIfDue` re-reads `settings.routeAssistant.pricing.silentAutoLastTickAt` directly from `chrome.storage.local`, not `this.settings`, before deciding to skip. Matches §10 invariant. The 0.9× gap multiplier guards against tight-race double-firing across tabs.
- **Disposition:** No bug.

---

## [VERIFIED] ORS Sandbox cascade resolver matches §10 invariant
- `panel.js:9966 _recomputeOrsSandbox` walks the cascade in two passes:
  - Pass 1 — `override` (Number.isFinite check on `route.ratingAlphaOverride[cls]`) then `derived` (counts ≥ minObs).
  - Pass 2 — `siblingDerived` (only from sibling classes whose source is exactly "derived" — single-hop guard preserved per §10) → `fleetMedian` → `global`.
- Order: **override > derived (≥minObs) > siblingDerived > fleetMedian > global default** ✓
- The `Number.isFinite` guards (not `||`) preserve a user override of `0` per §10 invariant.
- `ors-model.js:282` reads `alphaSourceByClass` purely for note labels — no I/O. Project() is pure (only `chrome.storage` reference is in the file-header docstring; `window.RouteAssistantOrsModel` assignment at EOF is the IIFE export).
- Per-class price multipliers (Y/C/F) thread through correctly via `scenario.priceMultipliers[cls]` at `ors-model.js:128`. Y multiplier drives demand-pool elasticity at line 184.
- **Disposition:** No bug. Cascade contract satisfied.

---

## [VERIFIED] Wave overlay auto-optimiser fires when toggle is on
- `panel.js:7593 modeBtn` cycles through `["greedy", "connection", "profit"]` (or `["greedy", "connection"]` when `RouteAssistantWaveSlotScorer` is missing). Saves `{optimizeMode, optimize: next === "connection"}` to settings.
- `panel.js:5586 buildSchedule` invocation reads `optimizeMode` and forwards `optimize: useConnection` and `mode: useProfit ? "profit" : null` to `RouteAssistantWaveOverlay.buildSchedule(...)`.
- `wave-overlay.js:139 builder.assignRoutes(routes, {optimize: !!c.optimize, mode: c.mode, ...})` — flag threads through to ScheduleBuilder.
- `wave-route-fitter.js` is pure (no DOM/IO).
- **Disposition:** No bug. Auto-optimiser fires when user picks "connection" mode (or "profit" when scorer module is loaded).

---

## [VERIFIED] Demand depth elasticity returns null on small-N, panel renders em-dash
- `demand-derivator.js:251 _elasticity` returns null when fewer than 4 valid (price, capacity) pairs survive after filtering. Note added.
- `_ratingPriceElasticity` returns `{alpha: null}` when surviving pairs < `minObs` (default 4).
- Confounder filter ordering preserved per §10 ("fire vs prior surviving obs, not prior raw obs"): `prior` reference updates only after a successful `pairs.push(...)` at line 414.
- `panel.js:25467` renders `paxElasticity == null` as em-dash `—` with muted color `#6b7280`. No NaN.
- **Disposition:** No bug.

---

## [VERIFIED] Carrier popover partner-glyph reads `_partnersByEnterpriseId` correctly
- `panel.js:2607 _applyCachedContractualPartners()` builds the map after `_applyCachedEnterpriseMeta()` per §10 invariant. Called from init (`:2128`), after `myEnterpriseIds` settings change (`:15028`), and after partner-sync (`:15356`).
- `panel.js:20126 popover render` reads `partnersMap.get(partnerKey)` keyed by `entry.enterpriseId`. INTERLINING shows ⇄ (`#16a34a`); ALLIANCE shows ✦ (`#a78bfa`). Both gated on `cfgC.show*Glyph`.
- **Disposition:** No bug. Glyph rendering matches contract.

---

## [WIRING-GAP] `interline-store.js` is NOT account-scoped
- **Where:** `modules/route-assistant/interline-store.js:32`. `KEY_PREFIX = "routeAssistant:interline:"` — no `:acct:<id>:` segment.
- **Why it's a gap:** This is per-route operational codeshare metadata, manually entered by the user. In a multi-account install (sister airlines via canopy L1+), sister A's interline notes leak to sister B's panel. Other RA stores (route-overrides, route-note, status-history, watchlist, sandbox-backtest, rating-observation, rating-alpha, sandbox-scenarios, ors-snapshot, yield-history) all use `acctKey()`.
- **Severity:** MEDIUM. No silent corruption, but user-visible cross-account leakage exactly the kind §4.14 federation rules forbid.
- **Disposition:** Candidate for Phase 2 fix. Would need a follow-on `:acct:<id>:` migration shim with one-shot legacy-fallback read (same shape as `route-overrides-store.js`). Storage-key-prefix change requires HANDOVER §10 entry.
- **Out-of-territory caveat:** Wave overlay's interline annotation renderer (in panel) reads via `interlineShareLookup`. The lookup walks per-route records keyed by `<HUB>-<DEST>` — adding an account scope upstream wouldn't break the consumer interface, only the storage location.

---

## [WIRING-GAP] `service-config-store.js` is NOT account-scoped
- **Where:** `modules/route-assistant/service-config-store.js:36`. `PREFIX = "routeAssistant:serviceConfig:"`.
- **What it stores:** per-(hub, dest) class mix (Y/C/F seat split) + service level + per-class fare overrides. User-tunable.
- **Why it's a gap:** Same multi-account leak pattern as interline-store. The aggregator + profit estimator read these to project class-aware revenue. Sister A's class mix leaks to sister B.
- **Severity:** MEDIUM (matches interline-store).
- **Disposition:** Candidate for Phase 2 fix alongside interline-store; same migration shim shape.

---

## [INVARIANT-RISK] `panel.js:351–353` cross-tab settings sync only mirrors `pricing` slice
- **Where:** `_attachStorageListener` storage-onChanged handler — when `settings` key changes in another tab, only `incoming.pricing` is mirrored into `this.settings.pricing`. Comment explicitly says "Limit to the routeAssistant slice to avoid stomping other modules' in-memory state".
- **Risk:** If a sister tab edits other RA settings (filters, watchlist toggles, ORS preset, demand-depth opt-in), this tab's in-memory `this.settings` stays stale until the user triggers a refresh path that calls `RouteAssistantSettings.load()`. The next user-initiated `save()` could then write back the stale values, undoing the sister tab's edit.
- **Mitigation already in place:** The `needAutoPricingPill` flag refreshes the pricing pill which is the only consumer that reads inline. Other settings — `filters`, `scoring`, etc. — are reloaded on `refresh()`. The `_attachHubShortcuts` and other listeners trigger `refresh()` on hub/distance/fleet changes.
- **Severity:** LOW-MEDIUM. Edge case; only fires if user actively edits same-RA-settings in two tabs simultaneously.
- **Disposition:** Document as known invariant for now. Phase 2 candidate: extend the mirror to also pick up `incoming.watchlist`, `incoming.filters`, `incoming.ors`, `incoming.demandDepth` since those are read inline from `this.settings.*` outside `refresh()`. Needs careful merge to not stomp ephemeral state.

---

## [QUESTION] Wave overlay save-back path
- **Where:** `panel.js _saveWaveScheduleToStore` (per §10 invariant: SOLE write path).
- **Question:** §10 says it must validate (preset present, airline loaded, no validation errors, ≥1 flight). Need to verify all four checks present and `_undoableSave` wraps it.
- **Disposition:** Will verify in Phase 2 audit-spillover; not flagged as bug yet.

---

## [QUESTION] AFP DRAG handle wired but `wave-overlay` interline pill render path
- §10 says the wave-overlay's interline-share callback pins a "Y 30%" pill on connection-curve midpoints. Need to verify pill positioning when `interline-store` data is sparse / partner is alliance (✦) vs interline (⇄).
- **Disposition:** Not bug-confirmed. Check in Phase 2.

---

## Live-verification status

User asked to validate live in Chrome. Status:

- **No Chrome instance is running with my project's extension.** The 6 active Chrome instances on ports 9227–9232 load `/Users/jihwan/Downloads/AES.v0.6.9` or `/tmp/aes-refine-worktree`, not `/private/tmp/aes-claude-1/project`.
- **Confirmed equivalence:** `diff -q /Users/jihwan/Downloads/AES.v0.6.9/modules/route-assistant/panel.js /private/tmp/aes-claude-1/project/modules/route-assistant/panel.js` returns **no diff**. The extension on port 9227 IS effectively the same code as my project (no edits applied yet — Phase 1 is audit-only).
- **AS session on port 9227 is logged out.** Tab URL: `airlinesim.aero/auth/login?od=https://free1.airlinesim.aero/app/redirectAfterLogin`. No credentials.json found. Cookie-store read denied by sandbox policy.
- **Recommendation:** user re-authenticates in the Chrome instance on port 9227 (or another), then I drive read-only verifications (panel mount, ORS sandbox slider drag, wave overlay mode toggle) via CDP. No live writes in Phase 1.

---

## Top 3–5 issues to fix first (Phase 2 priority)

1. **interline-store.js account scoping** [WIRING-GAP] — multi-account leak. Needs `:acct:<id>:` migration shim + HANDOVER §10 entry.
2. **service-config-store.js account scoping** [WIRING-GAP] — same pattern, same fix shape, can bundle with #1.
3. **Cross-tab settings mirror (panel.js:351)** [INVARIANT-RISK] — extend mirror to cover `filters`, `watchlist`, `ors`, `demandDepth`. Phase-2 only after risk-of-stomp analysis.
4. *(if scoped)* Verify wave-overlay save-back four-gate + `_undoableSave` wrap.
5. *(if scoped)* Live-validate ORS sandbox slider re-projection + Wave View mode cycling against actual scheduling page.

No bugs in the highest-stakes paths (Tier 3 pricing apply, ORS cascade, wave optimiser, elasticity null handling, partner glyphs). The strategic invariants from §10 all hold up under static audit.

---

## Open questions / blockers

- Live validation requires user re-login on a Chrome we agree on (likely port 9227 since its loaded extension matches my project).
- Should the two account-scoping fixes (interline + service-config) ship as one Phase 2 PR or two? They share the migration-shim pattern; bundling is cleaner.
- §10 wave-overlay-save-back four-gate verification not yet completed — flag as Phase 2 pre-fix.

---

# Phase 2 — second-pass static audit (resumed Agent 2 session, 2026-05-01 ~10:50)

**Counts (cumulative):** 17 findings → 10 [VERIFIED] / 2 [WIRING-GAP] / 2 [INVARIANT-RISK] / 1 [LOAD-ORDER-RISK] / 2 [QUESTION-RESOLVED] (no [BUG] yet — strategic invariants all hold).

**Live verification this session: BLOCKED.** Relaunched Chrome on port 9234 (chrome-aes-2 profile), then attempted CDP-driven login via `audit/scripts/cdp-login.py`. AS rejected with form-error `"Authentication failed. Please check the provided credentials."` Tried both `https://www.airlinesim.aero/auth/login` and `/auth/login?od=https://free1.airlinesim.aero/...` post-redirect form. Form fields filled correctly via native value setters + input/change events. credentials.json email = `jihwankim0330@icloud.com` (no trailing `2`); harness user-context email = `jihwankim03302@icloud.com`. Likely stale credentials. Documented in SHARED-NOTES so other agents (4 / 8) know the wall is shared.

---

## [QUESTION-RESOLVED] Wave-overlay save-back four-gate verified — _saveWaveScheduleToStore at panel.js:6902–6966
- Lifts the prior Phase 1 [QUESTION] to verified.
- Gate 1 — preset present: line 6906 `if (!build || !preset) → toast.warn + return` ✓
- Gate 2 — airline loaded: line 6911 `if (!airlineCode) → toast.warn + return` (sourced from `this.ownSchedule.airline`) ✓
- Gate 3 — no validation errors: line 6915 `if (build.validation && build.validation.length) → toast.error + return` ✓
- Gate 4 — ≥1 flight: line 6919 `if (!build.flights || !build.flights.length) → toast.warn + return` ✓
- `_undoableSave` wrap: line 6958 wraps the actual `ScheduleStore.save(record)` with a `restore` hook that calls `ScheduleStore.remove(...)` so a misclick reverts in one toast click ✓
- Side-quest: also walks `build.unplaced` (line 6942) and `build.shortfall` (line 6949) to push secondary warnings onto the persisted record so the dashboard's history pill shows the full picture, not just factor violations.
- **Disposition:** §10 invariant satisfied. SOLE write path is `_saveWaveScheduleToStore`; nothing else writes ScheduleStore from RA.

---

## [QUESTION-RESOLVED] Wave-overlay interline pill render path safe under sparsity / partner-class variance
- Lifts the prior Phase 1 [QUESTION] to verified.
- **Lookup short-circuits cleanly:** `_interlineShareLookup(hubIata)` (panel.js:7285) returns null when `interlineByPair.size === 0`. wave-overlay.js:174 guard `if (interlineShareLookup)` skips the per-connection loop entirely → no pill rendering work spent on cold-cache routes.
- **Class filter:** wave-overlay.js:176 only annotates connections where `classification === "interline"`. Alliance (`✦`) and own connections never get pills. Routes with no carrier data classify as "own" (panel.js:7261: `if (!leadId) return "own"`) → no spurious pills on uncrosswalked routes.
- **Empty record handling:** the share lookup at panel.js:7299 returns null when (a) `cache.get` misses or (b) `_interlineSharesFromRecord(rec)` returns null. wave-overlay.js:180 also gates on `share.paxPercent > 0 || share.cargoPercent > 0` — pills only on routes with actual partner share. Records with `partners: []` → null share → no pill.
- **Foreign carrier with no agreement:** classifier returns null (panel.js:7269), connection dropped at the routing layer → never reaches the pill-render branch.
- **Lookup outage:** wave-overlay.js:178 try/catch swallows errors silently — bad lookup function doesn't break the build.
- **Disposition:** Render path is robust. No bug.

---

## [VERIFIED] Tier 3.2 circuit-breaker round-trips through panel remount
- Spec from AGENT-2.md scope: "trippedAt round-trips through panel remount."
- Trip path: `pricing-applier.js:1048` calls `this.onBreakerTrip(reason, this.circuitBreakerTrippedAt)` → `panel.js:14014` wires it to `_persistPricingBreakerTrip` → `panel.js:14024` writes `circuitBreakerTrippedAt` + `circuitBreakerHaltReason` into `settings.pricing.apply` then `RouteAssistantSettings.save(this.settings)` persists to `chrome.storage.local`.
- Read-back path: cooldown gates at `panel.js:12150`, `:13379`, `:13593` all read `apply.circuitBreakerTrippedAt` and compare to `Date.now() - cooldownMs` (default 600000). On panel remount, settings are re-loaded via `RouteAssistantSettings.load()` and the trip state is intact.
- Reset: `_persistPricingBreakerReset` at panel.js:14036 nulls both fields on first verified write — symmetric.
- **Disposition:** Round-trip intact. §10 invariant satisfied.

---

## [VERIFIED] silent-auto-proposers registry — three strategies are statically pure
- Reviewing per AGENT-2.md scope.
- `competitor-median` (silent-auto-proposers.js:49): pure, deterministic given `(route, prices, cfg)`. Uses `cfg.silentAutoCompetitorMinCount` with default 2 (line 58–59). Noise floor → clamp → round → equality skip. ✓
- `strategy-objective` (line 113): pure given `(route, prices, cfg, ctx)` where ctx includes `strategyMovesByPair: Map<HUB-DEST, PriceMove>`. Same clamp/round/skip pattern. ✓
- `ors-elasticity` (line 190): not strictly pure — depends on `window.RouteAssistantOrsModel.scanPriceCurve` being loaded AND `Date.now()` for staleness gate (line 220). Otherwise deterministic given (route, prices, cfg, ctx).
- `dispatch` (line 382) wraps with try/catch + diagnostics. Unknown strategy returns `{ok:false, dest, skipReason: "unknown strategy '...'"}` — graceful.
- `surface` (line 439) emits a `canvas:advisor-suggestion` on positive proposals; the EDIT_STAGED payload threads `proposerStrategy + rationale + projectedDelta`. The rail's commit-bar still routes through `RouteAssistantPricingApplier.apply()` so the same gates fire.
- **Disposition:** Pure-function smokes feasible for all three. The ors-elasticity smoke would mock the OrsModel and time. Phase 3 candidate test under `audit/tests/route-assistant/silent-auto-proposers.test.js`.

---

## [VERIFIED] route-sync-orchestrator does NOT share Wicket session across bulk batch
- AGENT-2.md scope flagged: "ORS Wicket per-route handshake — must NOT share session across bulk batch."
- Orchestrator delegates per-route to `this.orsScraper.scrape(hub, dest, orsCallParams)` (line 140). The scraper internally calls `_scrapeOneClass` (ors-scraper.js:833) which does a fresh GET (line 847) per class to harvest a fresh Wicket session ID + form action, then POSTs against that. Per-class because Wicket page-version IDs invalidate per POST → sharing across classes returns PageExpiredException (per the code's own comment at line 842).
- The orchestrator's `bulkSync` (line 168) dispatches multiple `syncRoute` calls in parallel (concurrency-limited) with a stagger; each is self-contained for its handshake.
- **Disposition:** Invariant intact. Fresh GET per class per route per scrape.

---

## [VERIFIED] Carriers SSR fragility handled — empty carriers list does not break the row
- AGENT-2.md scope flagged: "flightsfrom.com sometimes doesn't SSR carrier list; record stores parserNotes and empty list. Verify panel handles empty gracefully."
- carriers-scraper.js:265 builds an `empty = {carriers:[], totalAirlines:null, totalWeeklyFlights:null, parserNotes:null}` and overlays `parserNotes` describing which strategies tried+failed (lines 266, 272, 274, 344). Records persist with `carriers: []` plus the diagnostic note.
- panel.js:2433 reads back: `r.carriers = Array.isArray(rec.carriers) ? rec.carriers : []`; line 2434 sets `r.carriersScrapedAt = rec.scrapedAt`; line 2435 sets `r.carriersParserNote = rec.parserNotes`.
- Intensity calc (line 2440–2443) prefers `rec.totalAirlines` only when it's a positive number; falls back to the listing-page `airlineCount`. Empty record → falls back; row still has a competitive-intensity reading.
- Popover/glyph render reads `r.competitorEntries` (markets-page leaderboard, separate cache); when carriers list is empty but markets ran, the popover still has data. When BOTH are empty, the popover is short but doesn't crash.
- **Disposition:** SSR-empty handled. No bug.

---

## [INVARIANT-RISK] pricing-applier.parseFormContext mutates class-level `_observedFieldNames` — shared across routes
- **Where:** `pricing-applier.js:328–331` writes `RouteAssistantPricingApplier._observedFieldNames[cls] = newName` on every parse. Line 384 echoes the ENTIRE shared object into the returned `formContext.observedFieldNames`.
- **Why it's a risk:** parsing route A populates the static map with route A's field names. Parsing route B then OVERWRITES the per-class entries (Y/C/F/Cargo are the same keys). If buildBody is called for route A's formContext AFTER B has been parsed, line 410 reads `formContext.observedFieldNames` — but that's a reference to the shared object, now reflecting B's last-written values. In practice the field names are identical across routes (AS uses the same fieldset structure on every markets page) so there is no observable behaviour change.
- **Severity:** LOW (theoretical). Real corruption would require AS to ship per-route field-name variations, which I have no evidence of.
- **Disposition:** Document; cleanup nice-to-have. Fix would either (a) make `_observedFieldNames` a local-only object (clobber-safe), or (b) freeze each formContext's observedFieldNames at parse time via a shallow copy. Not blocking.

---

## [INVARIANT-RISK] pricing-applier.preflight uses Date.now() inline — pure-function smoke needs a clock
- **Where:** `pricing-applier.js:885` and `:904` reference `Date.now()` for cooldown checks.
- **Why it matters:** AGENT-2.md says preflight is "static + pure". It is static, but the time dependency makes the function non-deterministic across calls — a smoke test wanting "same input → same output" needs to control the clock.
- **Mitigation suggestion:** thread `now` through as an optional parameter (defaulting to Date.now() if unset) so tests can pass a fixed timestamp. Tiny refactor; doesn't change runtime behaviour.
- **Severity:** LOW. Test ergonomics only. Not a runtime bug.
- **Disposition:** Phase 2 candidate alongside the Phase 3 smoke-test build-out.

---

## [LOAD-ORDER-RISK] parallel-scanner.js + route-sync-orchestrator.js declare top-level classes WITHOUT idempotent guards
- **Where:**
  - `parallel-scanner.js:21` — `class RouteAssistantParallelScanner { ... }` at module top (no IIFE wrapper, no `if (window.X) return` guard).
  - `route-sync-orchestrator.js:56` — `class RouteAssistantRouteSync { ... }` same pattern.
- **Why it's a risk:** matches the failure mode Agent 1's F-6 + Agent 4's F4-011 flagged for `AesAfpScheduleStore`. If these scripts are executed twice (extension reload, manifest dup, content-script duplicate matches), `class X { }` is a syntax-binding declaration in strict mode and re-declaring throws `SyntaxError: Identifier 'X' has already been declared`. The syntax error halts the entire script — every later declaration in the same file goes missing from the global scope.
- **Severity:** MEDIUM. Hits only on duplicate load, but the dup-loader audit (Agent 8 F-8-005-adjacent) suggests the manifest sometimes does double-include legacy content scripts.
- **Disposition:** Phase 2 fix. Wrap each class in `if (typeof window.RouteAssistantParallelScanner === "undefined") { class ... ; window.RouteAssistantParallelScanner = ... }` OR move into IIFE pattern that most other RA modules use (e.g., silent-auto-proposers.js:36 `;(function(){ if (window.X) return; ... })()`). One PR can knock out both files plus AesAfpScheduleStore (cross-territory; coordinate with Agent 4).
- **Cross-ref:** Agent 1 F-6 + Agent 4 F4-011. Bundling on a single Phase-2 fix-PR is cleaner than three separate ones.

---

## [VERIFIED] silent-auto.dispatch records skip diagnostics on every skip path
- silent-auto-proposers.js:382 `dispatch` calls `_recordSkip(hub, dest, skipReason)` on:
  - unknown strategy (line 389)
  - cache stale gate (line 400) when `cfg.silentAutoMaxCacheAgeMin > 0`
  - proposer threw (line 410)
  - proposer returned `{ok: false, skipReason}` (line 414)
- `_recordSkip` (line 365) defensive-guards `window.AesPriceDiagnostics` and try/catches the call so a missing diagnostics module never breaks dispatch.
- **Disposition:** Skip-attribution coverage is complete; a tick that skipped 80 of 100 routes will have a full audit trail.

---

## Phase 2 priority shifts (rolled-up)

The original Phase 1 priority list still stands (interline-store + service-config-store account-scoping is the highest-ROI fix). New additions from this session:

1. **interline-store + service-config-store account-scoping** [WIRING-GAP] — unchanged, MEDIUM severity, multi-account leak. Same migration-shim pattern. Bundle as one PR.
2. **parallel-scanner + route-sync-orchestrator class-decl idempotent guard** [LOAD-ORDER-RISK] — new addition; bundle with Agent 1 F-6 / Agent 4 F4-011 across territories.
3. **Cross-tab settings mirror (panel.js:351)** [INVARIANT-RISK] — unchanged, LOW-MEDIUM.
4. **pricing-applier `_observedFieldNames` shared-state cleanup** [INVARIANT-RISK] — new addition, LOW. Tiny refactor, low risk.
5. **pricing-applier preflight clock-injection refactor** [INVARIANT-RISK] — new addition, LOW. Test ergonomics.
6. **Live verification — credentials.json refresh** — blocker; user action required.

No new bugs. The strategic invariants from §10 (Tier 3 two-gate, ORS cascade, wave-overlay SOLE save path, breaker round-trip, fresh-handshake-per-route, demand-elasticity null handling, partner-glyph rendering, silent-auto third gate) all hold up under second-pass static audit.

---

## Live verification — re-attempt readiness

Chrome on port 9234 is up (PID written to `audit/.pids/agent-2.pid`). Profile `/tmp/chrome-aes-2`. Extension loaded from `/Users/jihwan/Downloads/AES.v0.6.9` (byte-equiv to project tree per Phase 1 finding). Tab on `/auth/login` showing the rejection error. As soon as credentials.json is refreshed (or the user manually authenticates the chrome-aes-2 profile), I can pick up:

- Panel mount on `/app/com/scheduling/<HUB>` (probe: settle <1s, scoredRows length, no console errors).
- ORS Sandbox slider drag — projection re-runs without freeze; cascade-source labels match expected order.
- Wave View mode toggle through greedy/connection/profit; verify buildSchedule fires with expected `optimize` flag.
- "Apply price..." dry-run modal — full preflight + body-construction + audit-log entry without POST.
- Cmd-K palette open + filter.
- Right-click context menu on a row.

All read-only / dry-run; no SHARED-NOTES real-write lock needed.

---

# Phase 3 — button-level wiring sweep (resumed Agent 2 session, 2026-05-02)

**Scope:** every visible control on the rendered Route Assistant panel — header strip, status bar, filter toolbar, quick-filter pills, mode tabs, per-row actions, and the full settings drawer (scoring, live-route-data, pricing diagnostics, Tier 3 Apply, silent-auto, yield feedback, service profiles, carriers, contractual partners, canopy view, market analysis, demand depth, ORS Rank, ORS Sandbox, alert rules, desktop notifications, economics, interlining records). 144 controls audited across four parallel sub-audits.

**Counts (Phase 3 only):** 144 controls → **142 [WIRED] / 0 [WIRING-GAP] / 1 [DEFERRED-AS-DESIGN] / 0 [BUG] / 1 [SCOPE-CLARIFICATION]**.
**Counts (cumulative across Phase 1 + 2 + 3):** 161 findings → 152 [VERIFIED-or-WIRED] / 2 [WIRING-GAP] / 2 [INVARIANT-RISK] / 1 [LOAD-ORDER-RISK] / 2 [QUESTION-RESOLVED] / 1 [DEFERRED-AS-DESIGN] / 1 [SCOPE-CLARIFICATION]. **Still no [BUG] across the whole audit.**

This is a surprising-but-defensible result. Phase 1+2 caught the gaps that exist (account-scoping leaks in two stores, top-level class-decl idempotency in two scrapers, cross-tab settings-mirror narrowness). Those are *deeper* than buttons. The button surface itself is well-attended — every toggle persists through `RouteAssistantSettings.save()`, every sync button instantiates a real scraper, every modal opens through a documented entry point. Confidence in this result comes from cross-checking citations against grep, confirming all referenced modules exist on disk, and confirming the manifest loads them (159 `modules/route-assistant/` entries).

What this Phase 3 sweep **does not** verify:
- Handler *correctness* under every input. It verifies that handlers exist, are bound, and call real downstream code. A handler that calls the right function with the wrong arguments would still register as [WIRED].
- Live behavior in Chrome. Same caveat as Phase 1+2 — the credentials wall blocks driving the AS session.
- Edge cases (empty caches, mid-sync interruption, race between two open tabs). Phase 1+2 covered some of these on the strategic invariants; the button surface has not been stress-tested.

---

## Phase 3 highlights — sub-audit citations

### Group 1 (shell, toolbar, modes, per-row) — 35 controls, all [WIRED]

- All 9 header buttons wired: `_renderHeaderStrip` → `refresh / _openStationsModal / _openRetirementPlanner / _toggleInspector / _toggleSettings / _openNotificationCenter / _openConfigMenu / _toggleCollapse`. Change log delegates to `window.AesChangeLogModal.open()` with a "module not loaded" toast fallback (panel.js:1507–1514).
- Status bar: `_scanFlightsFrom` (panel.js:4093) instantiates `FlightsFromController`; `_seedAllCountries` (panel.js:4056) prompts confirmation then runs `RouteAssistantParallelScanner` over ~150 countries; `_resolveDemand` (panel.js:4016) is correctly disabled when country cache is empty (the tooltip you saw in the rendered panel is the right behavior, not a bug).
- Filter toolbar: search input persists to `settings.searchQuery` with 200ms debounce; filter chips toggle individual `settings.filters[field]` keys; View / Strategy preset dropdowns apply named snapshots; Canopy pill toggles `settings.canopyView.active`.
- Per-row actions: IATA, 📅, 📦 are real `<a href>` tags with `target="_blank"` and `encodeURIComponent` escaping (panel.js:25033–25092) — opening AS pages directly, no JS event hop.
- DNA-fit pill is render-only by design (no click target documented).

### Group 2 (scoring + pricing path) — 27 controls, all [WIRED]

- Quick presets at panel.js:11454–11464; variable-row table with per-row enable/direction/weight/min/max at 11513–11585.
- Live route data sync wires to `_runBulkRouteSync` at panel.js:18366 → `RouteAssistantRouteSync.bulkSync()` (the orchestrator already verified Phase-2 to do per-route Wicket handshakes correctly).
- "Verify pipeline now" at panel.js:13840–13891: forced dry-run apply against the most-eligible route. Threads through the same `RouteAssistantPricingApplier.apply()` the manual modal uses, exercises GET handshake → parse → preflight → body construction → log write without committing. Lands in Recent applies.
- Tier 3 Apply controls (dry-run, apply-enabled, cooldowns, scopes, live-write scope per axis Manual/Bulk/Silent-auto, advanced tunables) all persist through `RouteAssistantSettings.save()`. Phase 2 already verified the gates themselves hold.
- Silent-auto block: top-level enable + strategy registry (`competitor-median` / `strategy-objective` / `ors-elasticity` / `per-class-elasticity`) + per-class proposer table (Y/C/F/Cargo: enable/maxStep/minPool) all wired. Per-class table's max-step blanks fall back to global Max step (panel.js:24391–24458).

### Group 3 (data syncs) — 54 controls, all [WIRED]

- Yield feedback: `_runYieldSnapshot` (panel.js:14762) calls `RouteAssistantYieldSnapshot.takeSnapshot()` with full attribution + distance resolution. "Calibrate flagged" button gated on `_flaggedRoutesForCalibration()` count.
- Service profiles: per-class yield-base + cost inputs persist; "Refresh AS service profiles" (panel.js:15021) calls `RouteAssistantServiceProfileScraper.syncAll() + loadAllDetails() + loadList()`.
- Carriers: `_runBulkCarrierScrape` (panel.js:15326) uses concurrency + stagger; `_runBulkEnterpriseMetaSync` (panel.js:15401) has the correct prerequisite gate (visibleIds === 0 → button disabled).
- Contractual partners: `_runRefreshContractualPartners` (panel.js:15503) calls `RouteAssistantContractualPartnersScraper.syncAll()`. The own-enterprise-IDs input parses comma-separated input, persists to `settings.myEnterpriseIds`, and reapplies cached partners.
- Canopy view (in settings drawer, separate from header pill): all 5 controls wired, cannib threshold/minKin/gap-min-pax bounded.
- Market analysis sync (panel.js:16385) is a 3-phase run — markets families + historic + inventory — and folds demand-depth into the same bulk pass (avoiding two parallel scrapes against the same endpoint family).
- Demand depth `useRealDemandForLF` toggle (panel.js:16900) is *consumed* downstream — `aggregator.applyFleetContext()` threads the flag through to `profit-estimator.estimate()` which switches LF source from `paxScore` interpolation to real demand pool / weeklySeats. The tooltip's "advanced" label is honest — it changes profit projection materially.
- ORS Rank: `_runBulkRouteSync` (panel.js:18366) is the schedule-then-ORS sequenced path; `_runBulkOrsScrape` (panel.js:18220) is the ORS-only repair path. Per-class custom weights normalize to sum 1.0 (panel.js:18177–18178).

### Group 4 (sandbox + alerts + economics) — 28 controls, 27 [WIRED] + 1 [DEFERRED-AS-DESIGN]

- ORS Sandbox model params: α price / α comfort / Default T persist to `settings.orsSandbox.modelParams` and re-read on remount via `cfg.modelParams`. "Reset all per-route Ts" clears `perRouteTemperature` + calibration timestamps. "Auto-calibrate per-route T after every ORS scrape" defaults to `true` if not set.
- Active prompts: variable selector populated from `RouteAssistantAlertEvaluator.availableFields()` — single source of truth (so adding a new field in the evaluator surfaces here automatically). "+ Add" validates threshold via `Number.isFinite()` before calling `RouteAssistantAlertRulesStore.add()` — non-numeric thresholds rejected with a warn toast (panel.js:17280–17283).
- "Test ping" path verified end-to-end: panel.js:17398 sends `chrome.runtime.sendMessage({type: "aes:notify:long-op", ...})` → `_background/notifications.js:33` handles it → `chrome.notifications.create()` fires OS notification → response returns to panel which shows success/error toast. Full hop intact.
- Economics block: all 18 inputs (5 pax + 4 cargo + 6 cost + 3 cache) persist via `stageEconomics()` (panel.js:11948) with debounced save + `_recomputeProfit()`. "Auto (per-type fuel)" correctly disables the flat Fuel AS$/h input when on, and downstream the profit estimator uses cycle + per-km burn from `fuel-burn-estimator.js` × current AS fuel price scraped by `fuel-price-scraper.js`.
- Distance-cache max-age dropdown (panel.js:11802–11834) nulls `this.distanceResolver` and forces re-scrape of stale entries on next refresh.
- Interline "Clear all" correctly disabled when `_records.length === 0` (panel.js:15945) — not a wiring gap.

---

## Phase 3 — special findings

### [DEFERRED-AS-DESIGN] DNA-fit pill (◯/◐/◉) on per-row destIata is render-only
- Group 1 sub-audit flagged this as a candidate gap. Verified: `panel.js:25101–25136` only renders the glyph when `dnaCtx` exists AND row status is NEW or UNDER. No click handler attached.
- HANDOVER (canopy section) describes DNA-fit as a *score signal* surfaced in the column, not an interactive entry point. Settings drawer has the toggle to enable/disable surfacing, plus the score weight rolls into the main score. Click-to-drilldown was never spec'd.
- **Disposition:** Not a bug. Render-only by design. If the user *wants* click-drilldown, that's a feature request, not a fix.

### [SCOPE-CLARIFICATION] Quick filter pills NEW/OK/UNDER/OVER/OOR are status indicators, not separate filter chips
- Group 1 sub-audit observed: above the table there's a row of pills labeled NEW / OK / UNDER / OVER / OOR. Looking at the rendered HTML, these *are* clickable filter pills (not just legend swatches) — they toggle which status rows show.
- Verified at `panel.js:5346` (filter gate) and the chip render at `panel.js:25140–25160`. Same `settings.filters` keys consumed by `_applyFilters()` and by the matching toggles in the settings drawer (Group 2 audit, "Status filter checkboxes" at `panel.js:11615–11634`). Quick-pill row and settings-drawer toggles share state.
- **Disposition:** No issue. Quick row is an in-context shortcut for the drawer toggles; the legend on the left of that row labels what each pill colour *means* (NEW = blue, OK = green, etc.) — it just happens to render those legend items as the same shape as the toggle pills.

---

## Phase 3 — what to do with the rolled-up priority list

**No reordering.** The Phase 1+2 priority list still drives Phase 4 work:

1. interline-store + service-config-store account-scoping [WIRING-GAP] — bundle as one PR.
2. parallel-scanner + route-sync-orchestrator class-decl idempotent guard [LOAD-ORDER-RISK] — bundle with Agent 1 F-6 / Agent 4 F4-011.
3. Cross-tab settings mirror (panel.js:351) [INVARIANT-RISK] — extend mirror to cover `filters`, `watchlist`, `ors`, `demandDepth`.
4. pricing-applier `_observedFieldNames` shared-state cleanup [INVARIANT-RISK].
5. pricing-applier preflight clock-injection refactor [INVARIANT-RISK].
6. Live verification — credentials.json refresh (still blocking).

Phase 3 didn't surface any new MEDIUM-or-higher items. The two soft notes (DNA-fit click drilldown, quick-pill row clarification) are documentation candidates for HANDOVER, not fix-PRs.

---

## Phase 3 — coverage matrix

For audit traceability, the four parallel sub-audits covered:

| Group | Subsystems | Controls | Sub-audit ID |
|---|---|---|---|
| 1 | header strip · status bar · filter toolbar · quick pills · mode tabs · per-row actions | 35 | shell |
| 2 | scoring + filters · live route data · pricing diagnostics · Tier 3 Apply · silent-auto | 27 | pricing-path |
| 3 | yield feedback · service profiles · carriers · contractual partners · canopy view · market analysis · demand depth · ORS Rank | 54 | data-syncs |
| 4 | ORS Sandbox · active prompts · long-op notifications · economics · interlining records | 28 | sandbox-alerts-economics |
| **Total** | | **144** | |

Sub-audit citations cross-spot-checked: handlers exist at cited lines, modules exist on disk, manifest loads them (159 `modules/route-assistant/` entries in `content_scripts`), and the Test ping background hop terminates in the documented `_background/notifications.js` handler.

---

## Phase 3 — what would actually move the needle next

If Phase 4 happens, the highest-ROI work is *not* more static audit. It's:

1. **Get a Chrome instance authenticated.** Until live verification can run, the ORS sandbox slider, wave-overlay mode cycling, and the pricing dry-run modal all sit unverified at the user-experience level. Phase 1+2 noted this; it's still the bottleneck.
2. **Run the Phase 1 fix bundle** (interline + service-config account-scoping + class-decl idempotency). Three small fixes against existing [WIRING-GAP] / [LOAD-ORDER-RISK] findings; user-visible payoff (no more cross-account leakage of interline notes).
3. **Build the pure-function smoke tests** AGENT-2.md called for under `audit/tests/route-assistant/`. The audit confirmed five candidates are pure-enough to test (`ors-model.project`, `score`, `profit-estimator.estimate`, `demand-derivator._elasticity`, the three silent-auto proposers); the only non-pure caveat is `pricing-applier.preflight` needs a clock-injection refactor first.

---

# Phase 4 — fix-pass + smoke-test build-out (resumed Agent 2 session, 2026-05-02)

**Outcome:** 1 real fix applied, 5 prior priorities verified already-fixed by other agents, 2 new smoke tests added. **Still no [BUG] across the entire 4-phase audit.**

## What changed on disk

### [FIXED] route-sync-orchestrator.js — added IIFE idempotency guard

- **Where:** `modules/route-assistant/route-sync-orchestrator.js`
- **Problem:** Phase 2 [LOAD-ORDER-RISK] — top-level `class RouteAssistantRouteSync` would throw `SyntaxError: Identifier ... has already been declared` on dup-load. parallel-scanner.js was already wrapped (per `streamline-A7.md`); this file was the lone holdout.
- **Fix:** Wrapped class declaration + window/module exports in `;(function () { … if (root && root.RouteAssistantRouteSync) return; class … ; root.RouteAssistantRouteSync = …; module.exports = …; })()`. Matches parallel-scanner.js's exact shape.
- **Verification:** `node --check` OK. `require()` returns the class function. Simulated double-load (cache wipe + re-require under `global.window = global`): same class identity, no SyntaxError.
- **Risk:** zero — wrapper is a pass-through on cold start, no-op on dup-load.

### [VERIFIED-ALREADY-FIXED] interline-store account-scoping

- Phase 1 finding had `KEY_PREFIX = "routeAssistant:interline:"` with no acctKey routing. Current state: `LEGACY_PREFIX` + `SCOPE_PREFIX`, full sibling-fallback pattern matching route-overrides-store.js. `audit/fix-A12-log.md` documents the migration. Closed.

### [VERIFIED-ALREADY-FIXED] service-config-store account-scoping

- Same pattern as interline-store (LEGACY_PREFIX, SCOPE_PREFIX, _key/loadAt/saveAt/bulkLoadAt/loadAllAt). No fix log but file shows it's done. Closed.

### [VERIFIED-ALREADY-FIXED] parallel-scanner idempotent guard

- File's top-of-class block (lines 28–35) already wraps in IIFE with `if (window.RouteAssistantParallelScanner) return`. JSDoc cites "FIX F-2 / streamline-A7.md". Closed.

### [VERIFIED-ALREADY-FIXED] pricing-applier `_observedFieldNames` cleanup

- Static class-level field doesn't exist anywhere in the file. `parseFormContext` uses local `observedFieldNames = {}` (line 326), copies into returned formContext at line 419. Per-route isolation is now structural. Closed.

### [VERIFIED-ALREADY-FIXED] pricing-applier preflight clock-injection

- `static preflight({…, now, …})` (line 881) accepts an optional `now` parameter; falls back to `Date.now()` only when not provided (line 884). Test ergonomics fix is shipped. Closed.

### [REMAINING-OPEN] cross-tab settings mirror narrowness (panel.js:351)

- Only Phase 2 priority not touched. Listener still mirrors `incoming.pricing` only into `this.settings.pricing`.
- **Decision this session:** not picked up. Severity LOW-MEDIUM, edge case fires only when user actively edits same-RA-settings in two tabs simultaneously. Proposed extension to also mirror `filters / watchlist / ors / demandDepth` requires careful merge logic (must not stomp ephemeral state) and benefits from live verification — which is still blocked on the credentials wall.

## New smoke tests added

Both placed under `audit/tests/route-assistant/`. Both pass.

### `score.test.js` — 16 cases

Locks the contract of `RouteAssistantScore.computeScores`:
- enabled=false on every field → score=null
- higher / lower direction inversion
- per-row weight contribution
- missing values: 0 numerator + full weight denominator (sparse rows score lower than dense rows)
- non-finite: when *every* enabled field is missing/non-finite for a row, score=null (not 0). Preserves the unmeasurable / measured-as-zero distinction.
- hi === lo (degenerate range) → norm=1
- single-row → 100
- empty rows → empty result
- zero/missing/negative weight defaults
- determinism across two calls
- does not mutate input

The non-finite test caught a contract distinction the original code makes deliberately. Initial test asserted `score=0`; actual behaviour is `score=null`. Re-reading the code that's correct — preserves "couldn't score" vs "scored 0". Test corrected.

To enable Node loading: appended a single-line `module.exports = RouteAssistantScore` at the bottom of `score.js`. Zero browser effect (no `module` global in MV3 content scripts); matches demand-derivator.js / route-sync-orchestrator.js / ors-model.js pattern.

### `ors-model-smoke.test.js` — 10 cases

Locks the structural contract of `RouteAssistantOrsModel.project`:
- determinism (deep-equal across two calls)
- legacy `{priceMultiplier: N}` migrated to `{priceMultipliers: {Y, C, F}}`
- empty `{}` route → no crash, `notes[]` reports the missing-connection-list gap
- `null` / `undefined` input → no crash
- missing C / F connections → `perClass.C === null` / `perClass.F === null`
- `RouteAssistantProfitEstimator` not on global → revenue/profit aggregates fall back to null cleanly
- `priceMultiplier=1` + `comfortDelta=0` → projected rating = baseline rating
- 20% price hike → projected rating < baseline (negative shift confirms ratingPriceElasticity wired)
- 20% price cut → projected rating > baseline

Doesn't exercise the deep revenue/cost paths — those are covered by `profit-estimator-byclass.test.js`. This is the no-crash + structural contract the panel relies on every render.

First iteration's price-shift tests failed because fixture connections lacked the `legs[]` array `_projectClass` reads to tag `oursAll` (lines 456–462). Real ORS scraper output has legs. Fixture corrected; tests pass with shifts in expected direction and magnitude.

## Full RA test suite status

```
account-scoped-stores.test.js              PASS
bulk-apply-rounding.test.js                PASS
central-price-automator.test.js            PASS
dashboard-pricing-manifest.test.js         PASS
demand-derivator.test.js                   PASS
markets-page-scraper.test.js               PASS
ors-intelligence.test.js                   PASS
ors-model-smoke.test.js                    PASS  ← new (10 cases)
per-class-elasticity.test.js               PASS
pricing-applier.test.js                    PASS
profit-estimator-byclass.test.js           PASS
quick-price-applier.test.js                PASS
scheduling-manifest.test.js                PASS
scheduling-origin-detection.test.js        PASS
score.test.js                              PASS  ← new (16 cases)
silent-auto-proposers.test.js              PASS
watchlist-store-context.test.js            PASS
wave-automation-context.test.js            PASS

18/18 PASS
```

## Phase 4 — bottom line

Of the six items on the rolled-up Phase 1+2 priority list:

| Item | Status |
|---|---|
| interline-store account-scoping | already fixed (fix-A12-log) |
| service-config-store account-scoping | already fixed (no log; file shows it) |
| parallel-scanner idempotent guard | already fixed (streamline-A7.md) |
| route-sync-orchestrator idempotent guard | **fixed this session** |
| pricing-applier `_observedFieldNames` cleanup | already fixed |
| pricing-applier preflight clock-injection | already fixed |
| cross-tab settings mirror extension | **still open** |

Substantive remaining work this session: one IIFE wrapper (~10 LOC, behaviour-preserving), two new smoke-test files (26 cases between them), one `module.exports` line on score.js to enable Node testing.

**No new bugs surfaced.** The Phase 3 button-level audit found 144/144 wired; the Phase 4 fix-pass found 6/7 priorities already closed. The route-assistant module is in better shape than the Phase 1+2 audit suggested — partly because other agents had already done the work between audit and fix-pass, partly because the prior audit flagged what *might* break even when the current code was already defensive.

What still moves the needle:

1. **Authenticate a Chrome instance** — still the live-verification bottleneck.
2. **Cross-tab settings mirror extension** — but ideally after live verification can confirm the merge logic doesn't stomp ephemeral state.
3. **Smoke tests for remaining candidates I didn't get to:** `wave-overlay.buildSchedule` (covered indirectly via wave-automation-context.test.js but not directly; needs DOM-shape fakes), `_recomputeOrsSandbox` cascade resolver (tightly coupled to panel state — would need extraction first).
