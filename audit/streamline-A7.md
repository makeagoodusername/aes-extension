# Streamline — Agent 7 (RA + Route Launcher + Scrape Orchestrator + FlightsFrom)

Territory: `modules/route-assistant/**` (74 files, ~59k LOC, panel.js ≈ 27k LOC),
`modules/route-launcher/**` (8 files, ~1.3k LOC), `modules/scrape-orchestrator/**`
(12 files, ~3.4k LOC), `modules/flightsfrom/**` (3 files + `content_flightsFrom.js`).

Read-only audit. Findings classified KEEP / CUT / FIX / DEFER / STREAMLINE.

Counts: **KEEP 7 · CUT 0 · FIX 4 · DEFER 3 · STREAMLINE 6 · Open Qs 4**.

---

## KEEP (load-bearing, working as designed)

### K-1 · Route Assistant `panel.js` as the daily-driver entrypoint
Mounts on `/app/com/scheduling/<HUB>` (manifest.json:647). The central-hub
`route-assistant-tile.js` is a *summary* tile — it reads
`routeAssistant:topRoutes:<HUB>` snapshots that the panel publishes, but it does
not run RA itself. `openHref()` returns `/app/com/scheduling`, sending the user
into the panel for any real refresh. **Not superseded — central-hub is a router
to the panel, not a replacement.** The panel owns the auto-pricing pipeline,
ORS sandbox, wave overlay, demand depth, yield feedback, and silent-auto loop.
Keep.

### K-2 · Tier 3 two-gate model + circuit breaker
`pricing-applier.js:163–164` defaults dryRun=true / applyEnabled=false; gates
verified intact in findings-AGENT-2.md. Circuit breaker round-trip via
`_persistPricingBreakerTrip` → `circuitBreakerTrippedAt` in settings. Keep.

### K-3 · ORS Sandbox cascade resolver
`override > derived(≥minObs) > siblingDerived > fleetMedian > global` at
`panel.js:9966`. Single-hop sibling guard preserved. Keep (and protect the
invariant — it's load-bearing).

### K-4 · Scrape Orchestrator phase plan + run archive
`phases.js` has a single source of truth for foundation targets
(`FOUNDATION_TARGETS`); `estimate()` and `buildJobs()` derive from it so the
ToS modal count cannot drift from dispatch. Per-phase `postRun` for ORS sync
after per-route scrapes is the right shape. `run-archive-store.js` (417 LOC)
+ `archive-modal.js` give the user a per-run audit trail. Keep.

### K-5 · Background tab pool crash-recovery
`background-tab-pool.js:512 _recoverFromCrash` re-emits a synthetic
`run-done` on SW boot if a previous run was mid-flight, closes orphan tabs, and
unwedges any content-side `await _runPhaseJobs(...)`. This is the right fix for
MV3 SW idle eviction. Keep.

### K-6 · Auto-driver drip-style background scrape
`auto-driver.js` ticks every 5 min, picks the most-overdue mandatory phase via
`AesPhaseCadenceStore.pickStalest`, and runs ScrapeOrchestrator silently
(no modal). Five gates (master toggle, ToS accepted, not running, host
resolved, something stale). Optional phases (per-competitor, flightsfrom)
are NOT in the mandatory list — auto-driver only does the core four. Keep.

### K-7 · Route Launcher dispatcher reuses AFP submit-bridge
`submit-dispatcher.js` does NOT introduce a new POST path — it wraps
`AesAfpSubmitBridge.submitLegInBackground()` (the documented gated AFP write
path). Keep — invariant `manifest §3.1 (no new POSTs)` satisfied.

---

## FIX (real bugs / silent breakage)

### F-1 · Background tab pool's "consecutive failure" breaker is heuristic, no rate-limit signal
`background-tab-pool.js:245`: trips after 3 consecutive failures of any kind
(parser miss, page-load timeout, storage-key-never-appeared). It does NOT
look at HTTP 429/503 codes — by the time the orchestrator sees the page in the
hidden tab, the response is already a fully-rendered AS error page (or an
empty result). A 429 manifests as "storage-key-never-appeared" with no rate-
limit attribution. The 10-minute cooldown is correct, but the trigger is
indirect: a single buggy job spec could trip the breaker for 10 minutes by
producing 3 unrelated parser misses. **FIX:** plumb a "rate-limited" signal
from per-page scrapers (markets, ORS, inventory) into the progress envelope
so the pool can distinguish parse failure from rate-limit. The RA panel-side
ORS scraper at `ors-scraper.js:881,931,968` already detects 429/503 — but
that signal stays inside RA, never reaches the background pool's breaker.

### F-2 · `parallel-scanner.js` and `route-sync-orchestrator.js` declare top-level classes without idempotent guards
Confirmed in findings-AGENT-2.md (LOAD-ORDER-RISK). Re-declaration on
duplicate manifest match throws SyntaxError, halts script load. Bundle with
Agent 1 F-6 / Agent 4 F4-011. Wrap in `if (typeof window.X === "undefined") { ... }`
or move to IIFE pattern (matches `silent-auto-proposers.js:36`).

### F-3 · `interline-store.js` + `service-config-store.js` not account-scoped
Confirmed in findings-AGENT-2.md (WIRING-GAP). Multi-account leak: sister
airlines share one user's interline notes / class-mix overrides. All other RA
stores (route-overrides, route-note, status-history, watchlist,
sandbox-backtest, rating-observation, rating-alpha, sandbox-scenarios,
ors-snapshot, yield-history) namespace via `acctKey()`. Same migration-shim
pattern; can ship as one PR.

### F-4 · Cross-tab settings sync only mirrors `pricing` slice
`panel.js:351–353`. If sister tab edits `filters` / `watchlist` / `ors` /
`demandDepth`, this tab's `this.settings` stays stale until the next
`refresh()`. Next user-initiated `save()` could stomp the sister edit.
LOW-MEDIUM severity (edge case requires simultaneous edit). Extend mirror
or trigger `refresh()` on any RA settings slice change.

---

## DEFER (intentional half-features per HANDOVER, do not ship now)

### D-1 · DNA-fit pills on opportunity rows
`panel.js:24897` — L6 deferral confirmed. HANDOVER §10 documents this.

### D-2 · Cross-account trust pooling (canopy L7+)
RA sees acctKey-namespaced records; pooling deferred upstream by canopy.
Out of territory.

### D-3 · Carriers SSR fragility — null parser-notes path is graceful, deeper fix deferred
`carriers-scraper.js:39` notes "deferred until we have a sample of a SSR-
empty page from a real airline". The `parserNotes` + empty-list fallback at
`carriers-scraper.js:265` is sufficient for v1. Panel reads back tolerantly
(findings-AGENT-2.md verified empty doesn't crash row).

---

## STREAMLINE (consolidation / reduction opportunities)

### S-1 · `panel.js` is 27,037 lines — extraction candidates already started
`view-table.js`, `view-heatmap.js`, `view-waves.js`, `view-sandbox.js`,
`view-compass.js`, `inspector.js`, `mode-tabs.js`, `wave-editor.js`,
`billboard-renderer.js` are separate files but their docstrings explicitly
say "rendering still lives in `RouteAssistantPanel._drawTable` /
`_buildTable`" (`view-table.js:7`). The extractions are scaffolds; the
heavy lifting is still in the monolith. **Don't refactor in-flight** (per
audit-only mandate), but **flag** as the highest-leverage future cleanup
target if the user wants to streamline aggressively. Risk: ~50 cache reset
sites + the giant settings/storage-listener web make a refactor expensive.

### S-2 · Route Launcher vs. Route Assistant — distinct, no overlap
- **RA panel** = analyse routes, score them, apply pricing on existing legs.
- **Route Launcher** = pick aircraft → pick destination → POST a NEW flight
  number. One-click flight creation. Uses RA's `routeAssistant:topRoutes`
  and `FlightsFromStore` data only as ranking inputs.
They share no UI surface. Both ship to the central-hub as separate tiles
(`route-launcher-tile.js`, `route-assistant-tile.js`). **No overlap, no
streamline target.** Keep both.

### S-3 · Scrape Orchestrator: 12 files, all consumed
Verified each module has a consumer:
- `host.js` → invoked from `central-hub/shell.js:358` (the "Scrape everything" button).
- `auto-driver.js` → mounts on dashboard via DOMContentLoaded.
- `competitor-outline-runner.js` → invoked from competitor-intel outline panel
  Refresh button.
- `archive-modal.js` → opened from progress-modal "View archive".
- `cadence-store.js` → consumed by auto-driver's `pickStalest`.
- `tos-confirmation.js` → modal in host's `open()`.
- `progress-modal.js` → instantiated by host + auto-resume.
- `run-archive-store.js` → consumed by orchestrator's `_saveArchive`.
- `phases.js` + `enumerators.js` → consumed by orchestrator.
- `background-tab-pool.js` → loaded via `importScripts` from background.js.
**No orphans.** Streamline-friendly: each file has one well-defined job.

### S-4 · `RouteAssistantBillboard` (billboard-renderer.js, 480+ LOC) used at exactly one panel call site
`panel.js:5063` — single `RouteAssistantBillboard.paint(...)` invocation.
Module is well-scoped + pure; not a CUT candidate, but worth flagging that
the call site is ONE method. If the call site dies, the module dies.

### S-5 · Route Launcher cache key versus controller persisted-active key
`destination-ranker.js:26` uses `routeLauncher:rankCache:<server>:<HUB>`,
`controller.js:18` uses `routeLauncher:activeAircraft:<server>`. Both
correctly include `<server>`. **No streamline needed**, but worth
documenting that the launcher does NOT account-scope (no `:acct:<id>:`).
For one-airline-per-account installs this is fine; sister airlines share
the active-aircraft pin (which may be intentional — one launcher across
sisters).

### S-6 · FlightsFrom integration surface area
- `data-store.js` (283 LOC) — solid; consumed by RA aggregator, AFP
  route-candidates, fleet-schedule-grid, world-view, schedule-management.
- `scan-controller.js` (155 LOC) — instantiated 4× across codebase
  (`panel.js:4096`, `route-candidates.js:600`, `content_dashboard.js:3934`,
  and self-references). Single-active-scan invariant via watchdog.
- `schedule-panel.js` (174 LOC) — side panel on AS scheduling page; small,
  read-only, uses cached data.
- `content_flightsFrom.js` (660 LOC) — runs on flightsfrom.com domain.
**STREAMLINE thought:** the 4 separate `new FlightsFromController()` sites
could share a singleton (similar to `window.RouteLauncher`). Today each tab
opens its own controller; not a bug, but a small surface tax.

---

## Open questions

### Q-1 · Is the FlightsFrom upstream API stable?
`content_flightsFrom.js:30–42` ships with **11 fallback CSS selectors** for
the routes container and **7** for row selectors. The `countRouteLikeChildren`
heuristic (line 181) is a last-resort fallback that scans for any element
with ≥3 IATA-code-bearing children. The error banner at line 103 says
"selectors in AES_FF.SELECTORS may need updating". This implies upstream has
drifted before. **Worth a live verification:** scrape a known-rich hub
(JFK, LHR) and compare the selector that ACTUALLY matches today vs. the list
order. If the primary selector is the catch-all, the named ones have died
without anyone noticing.

### Q-2 · Auto-driver ToS gate — does it block on ToS-not-yet-accepted?
`auto-driver.js:58` skips when `!await _isTosAccepted()`. ToS is set per
install via `ScrapeTosConfirmation`. **Question:** for a fresh install (or
fresh Chrome profile per the 8-instance setup), does each instance see its
own ToS-accepted flag? If `chrome.storage.local` is profile-local but
`tosAccepted` is set on shell scrape-button click in instance A, instance B
will still skip auto-drive ticks until the user clicks Scrape there too.
For an 8-Chrome workflow the user may need to accept ToS 8 times on first
boot.

### Q-3 · `wave-plan-backtest.js` — is N=4 weeks of data realistic for new installs?
`wave-plan-backtest.js:100` requires `>= MIN_WEEKS` (default 4) of yield
history before backtest runs. New installs have zero yield history; backtest
won't fire for ~4 weeks. The panel UI presumably renders a "needs more data"
state. **Worth verifying** the empty-state copy is informative
("4 weeks of yield history needed; you have 0") not silent.

### Q-4 · Scrape Orchestrator "consecutive failure" threshold of 3 — too aggressive?
`background-tab-pool.js:44 BREAKER_FAIL_THRESHOLD = 3` with a 10 min cooldown.
A flaky AS server (intermittent timeouts that resolve on retry) could trip
the breaker on what's effectively transient noise. There's no per-job retry
in the pool — first failure counts. The progress-modal's "Override breaker"
button is the only manual escape. **Question for the user:** is 3 the right
number, or should we add a single auto-retry per job before counting it
toward the breaker?

---

## Top-level summary

- **Route Assistant panel.js IS the daily-driver entrypoint** (manifest.json:647,
  mounts on `/app/com/scheduling/*`). Central-hub is a router/summary, not a
  replacement.
- **Route Launcher and Route Assistant DO NOT overlap** — different jobs,
  different surfaces.
- **Scrape Orchestrator rate-limit handling is a heuristic breaker, not a real
  rate-limit signal** (FIX F-1) — the RA-side scrapers detect 429/503 but that
  signal does not reach the background tab pool.
- **No orphan scrapers** in scrape-orchestrator/. Every module has a consumer.
- **No hardcoded test/scratch routes** found in any of the four module trees.
- **2 wiring-gap fixes pending from Phase 1** (interline-store + service-config
  account-scoping; F-3) — already documented in findings-AGENT-2.md with
  migration-shim pattern.
- **panel.js at 27k LOC is the largest streamline-leverage target** (S-1) but
  refactoring it is high-risk; defer absent explicit user mandate.
- **FlightsFrom upstream selectors look load-bearing** (Q-1) — recommend live
  verification on a high-traffic hub to see which selector ACTUALLY matches.
