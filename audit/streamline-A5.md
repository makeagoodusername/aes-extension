# Streamline Audit — Agent 5 — Strategy Core (`modules/strategy/**`)

Read-only audit. No production code edited. Focus per brief: pure-function cores, scoring overlaps, version debris, bus topic surface, apply gates.

## Inventory snapshot

- **73 files** in `modules/strategy/` (66 in root + 9 in `layered/`).
- **27,530 LOC** total. Five files dominate: `panel.js` (2303), `apply-pipeline.js` (1235), `context.js` (1291), `auto-driver.js` (1049), `fleet-command-panel.js` (1042). Together = ~25% of strategy LOC; everything else averages ≤ 400 LOC.
- **0 versioned debris files** — `find -name "*v2*|*v3*|*_old*|*old*|*backup*|*deprecated*"` returned empty. No iteration sediment in strategy/.
- **Pure-function cores called out by §3 invariant 6** (must stay I/O-free):
  - `decide-routes.js::scoreRoutes` + `_connectivityTerm` — VERIFIED PURE (zero `chrome.storage` / `fetch` / `Date.now` / `Math.random`).
  - `diff-plan.js::diffPlan` — VERIFIED PURE.
  - `learn.js::_gradient` — VERIFIED PURE (the surrounding module reads storage, but the gradient fn itself is pure).
  - `objective.js::resolve` — VERIFIED PURE.
  - `risk-profiles.js::apply` — VERIFIED PURE.
  - `scoring-primitives.js::*` — VERIFIED PURE (header explicitly states "No DOM, no chrome.storage").
  - `forward-simulator.js::simulateForward` — MOSTLY PURE; reads `Date.now()` for `TIME_BUDGET_MS` watchdog (lines 139/159/188). Acceptable, but doc-string says "deterministic projection" — the time watchdog can short-circuit non-deterministically under load. (Already noted in findings-AGENT-3 F-A3-007 with separate mutation bug.)
  - `intervention-types.js`, `network-graph.js`, `congestion.js`, `competitor-response.js (proposer half)`, `pay-perception.js`, `rank-target-solver.js`, `joint-rank-tuner.js`, `elasticity-fit.js`, `kin-handoff-moves.js`, `rebalance-moves.js`, `crew-moves.js`, `price-moves.js`, `route-creation.js`, `alliance.js (_scoreRival)`, `hub-designer.js`, `marketing-tuner.js`, `slot-tuner.js`, `fleet-utilization.js` — all documented as pure compute and grep confirms (no `fetch`/`chrome.storage`/`localStorage`).
  - **`dnaFitScore`** lives in `modules/canopy/dna-fit-scorer.js`, NOT in strategy/. The brief listed it for me, but it's outside my territory — Agent 3 owns canopy. Skipping per territory matrix.

## Apply gate defaults — VERIFIED SAFE

`default-settings.js` (canonical, account-scoped):
- `tier: "preview-only"` (line 49) — global gate is the safe value.
- All six per-domain enables default `false` (lines 53-58): `scheduleApplyEnabled`, `routeCreationEnabled`, `priceMovesEnabled`, `serviceMovesEnabled`, `crewMovesEnabled`, `allianceMovesEnabled`. Plus `slotBidApplyEnabled` (line 59).
- `serviceApply.dryRunOnly: true` (line 78).
- `serviceTuner.enabled: false` (line 153).
- `alliance.apply.enabled: true` + `alliance.apply.dryRunOnly: true` (lines 217-218) — the second gate (dryRunOnly) is the meaningful one because IL form structure is uncalibrated; matches §4.18 invariant.
- `crewPay.apply.enabled: true` + `dryRunOnly: true` (lines 195-196).
- `fleetOptimizer.targetingEnabled: false` (Lane C).
- `learningEnabled: false` (line 66).
- `crossAirlineEnabled: false` (line 52).
- Smokes at lines 608-660 assert these defaults explicitly. **No silent default-on flips found.** §4.18 holds.

The one already-known inconsistency (carried from findings-AGENT-3 F-A3-002, also raised by Agent 8 F-8-006): `apply-pipeline.js:483` constructs the RA pricing applier with `applyEnabled: true, dryRunOnly: false` regardless of `settings.routeAssistant.pricing.apply.*`. Strategy substitutes its own two-gate, but a user's RA-panel kill-switch does not stop strategy-originated pricing. I am NOT classifying as a streamline action — it is already on Agent 3's QUESTION queue.

## Scoring overlap inventory

There are multiple modules with the word "score" in them, but on inspection they target DIFFERENT dimensions. No duplicate scorer for the same dimension was found:

| Scorer | Dimension | Overlap risk |
|---|---|---|
| `decide-routes.scoreRoutes` | composite per-route (profit/demand/competitor/ors/connectivity − maint/cash) | source of truth |
| `forward-simulator._scoreRoutes` | thin wrapper that delegates to `AesStrategy.scoreRoutes` | not a competitor — passthrough |
| `objective.score` | scalar projection score for proposers (share/profit/rank triple) | different axis — does NOT score routes; scores PROJECTIONS for tuner inner loops |
| `alliance._scoreRival` | rival-airline score for IL partner candidates | different entity (rival enterprise, not route) |
| `cross-airline-opportunities._seatFit` | seat-fit multiplier for sister-tail-to-route match | different entity (aircraft × route) |
| `rank-target-solver` | per-tuple objective J = rank/profit/share blend | uses `objective.score` — composes, doesn't duplicate |
| `joint-rank-tuner` | invokes `rank-target-solver` per route | composes, not duplicate |
| `slot-tuner` | slot-bid score (delegates to `AesSlotScorer` outside strategy/) | adapter |
| `pricing-engine` / `pricing-compass` / `elasticity-fit` / `price-moves` | four-piece pricing stack: deadband proposer (`price-moves`) → elasticity layer (`pricing-engine`) → curve fit (`elasticity-fit`) → end-user view (`pricing-compass`) | **NOT duplicates — they layer.** Header docs verify the layering. Could feel redundant on a quick scan; the comments justify the split. |
| `competitor-response._counterMove` | event→counter-move mapping (asymmetric defensive vs opportunistic) | different output (single-event proposal, not score) |

**Finding:** zero true duplicate scorers in strategy/. The pricing stack (4 files, ~1800 LOC) is the most-likely-to-feel-redundant cluster but is documented as deliberate layering — leave alone.

## Bus topic surface

Strategy emits to three buses:

**`AesDataBus` (publish/last-cached) — 4 topics, 3 documented in registry:**
- `signal:strategy:cash-low` (context.js:1087) — registered + subscribed by auto-driver.
- `data:strategy:serviceExperiment:concluded` (service-experiment-store.js:108) — registered + subscribed by weekly-review-tile.
- **`data:strategy:company-reputation:saved` (company-reputation-store.js:95) — ORPHAN. Not in `data-bus-topics.js`. Zero subscribers in any module.**
- `data:strategy:layered:route-extras-changed` (layered/route-extras-store.js:70) — registered (line 345 of registry); subscriber check inconclusive but registry-listed.

**`CentralHubBus` (eager) — 6 strategy-emit sites:**
- `strategy:decision-applied` (apply-pipeline.js:174) — subscribed by RA panel.js:23305.
- `strategy:auto-tick-stage` (auto-driver.js:363) — subscribed by strategy-tile.js:750.
- `data:strategy:fork:created/simulated/promoted` (fork-store.js + forward-simulator.js) — subscribed by counterfactual-lab-tile.
- `focus-aircraft` (fleet-command-panel.js:645) — subscribed in fleet-hub.
- **`fleet-optimizer:target-changed` (fleet-optimizer-settings.js:111+114) — ORPHAN. Not in `data-bus-topics.js`. Zero subscribers grep'd. Emitted on BOTH CentralHubBus and AesStrategy.bus simultaneously.**
- `strategy:layered:route-extras-changed` (layered/route-extras-store.js:68) — pair-emitted with the AesDataBus version above.

**`AesStrategy.bus` (module-owned, internal) — 3 emits:**
- `journal:entry-recorded`/`journal:reason-updated` (journal-store.js) — subscribed by journal-panel.js. (False-positive in Agent 8 audit, see findings-AGENT-3 F-A3-005.)
- `fleet-optimizer:target-changed` (fleet-optimizer-settings.js:114).
- `(rebalance) event` (rebalance-applier.js:75) — pass-through observability.

**Net topic-surface verdict:** 2 orphan emits (`data:strategy:company-reputation:saved`, `fleet-optimizer:target-changed`). Both look like preparation for tiles/listeners that didn't ship. Either delete the emit (CUT) or wire a subscriber (DEFER until consumer is decided).

---

# Classification

## KEEP

Pure-function cores that ARE pure and do their job:

- `decide-routes.js` (scoreRoutes + _connectivityTerm)
- `diff-plan.js`
- `learn.js` (_gradient is pure; storage I/O isolated to entry points)
- `objective.js`
- `risk-profiles.js`
- `scoring-primitives.js`
- `intervention-types.js`
- `congestion.js`
- `pay-perception.js`
- `rank-target-solver.js`
- `joint-rank-tuner.js`
- `elasticity-fit.js`
- `kin-handoff-moves.js`
- `rebalance-moves.js` (preview-only proposer, pure)
- `crew-moves.js`
- `price-moves.js`
- `service-moves.js` (one `Date.now` for staleness check, line 520, acceptable)
- `route-creation.js` (pure proposer)
- `alliance.js` (pure proposer + _scoreRival)
- `hub-designer.js` (advisory pure proposer)
- `network-graph.js`
- `marketing-tuner.js`
- `slot-tuner.js`
- `pay-perception.js`
- `pricing-compass.js`
- `pricing-engine.js`
- `objective.js`
- `default-settings.js` (defaults + canApply gate, well-tested via inline asserts)

Apply / persistence layer (correct two-gate):
- `apply-pipeline.js` (with the F-A3-002 question outstanding)
- `outcomes.js`
- `journal-store.js` + `journal-panel.js`
- `fork-store.js`
- `snapshot-fork.js`
- `service-experiment-store.js`
- `service-experiment-change-log-adapter.js`
- `competitor-prior-store.js`
- `route-objective-store.js`
- `rebalance-apply-log.js`
- `rebalance-applier.js`
- `route-creation-applier.js`
- `auto-driver.js`
- `briefing.js` (read-only composer)
- `route-record.js`
- `remote-refresh.js`
- `game-time-watcher.js`
- `store-readiness.js`
- `decision-dispatch.js`
- `tuning-panel.js`
- `panel.js`
- `journal-panel.js`
- `hub-designer-modal.js`
- `region-map-view.js`
- `fleet-command*.js` (3 files; clear separation of pure aggregator / panel / bulk-apply)

Layered (Slice 1+ canopy-aware override system; gated behind master kill-switch, default OFF):
- All of `layered/` (codec, division-membership, division-store, family-store, fleet-store, migrations, panel, resolver, route-extras-store).

## CUT (proposed)

None recommended. The cluster looks lean for its scope. The two orphan bus emits (below) are CUT-or-WIRE candidates but I'd lean toward FIX (register them) so future tiles can opt in.

## FIX

1. **Forward-simulator clones (already on the books).** F-A3-007 from findings-AGENT-3: `forward-simulator._decay` mutates `fork.snapshot` in place across re-runs. Pure-function invariant violation in spirit even if the inputs are framed as "advisory." Fix: `structuredClone(fork.snapshot)` at simulator entry. Agent 8 to land the smoke test under `audit/tests/strategy/`.

2. **Orphan bus emits — register or remove:**
   - `data:strategy:company-reputation:saved` (company-reputation-store.js:95). Either delete the emit (no subscriber) or register in `_shared/data-bus-topics.js` (Agent 6 owns) so a future tile can subscribe.
   - `fleet-optimizer:target-changed` (fleet-optimizer-settings.js:111, 114). Same call. Currently dual-emitted on CentralHubBus + AesStrategy.bus with no subscribers anywhere.

3. **Forward-simulator `Date.now()` watchdog** (line 139/159/188): documented as "deterministic" but the time-budget short-circuit makes the output non-deterministic under heavy load. Either rename to "best-effort projection" (cosmetic) or remove the budget when running from a test (env flag). Doc-string fix preferred; full rework deferred.

4. **Apply-pipeline RA pricing applier hardcoded ctor** (apply-pipeline.js:483) — already on findings-AGENT-3 F-A3-002 as a [QUESTION]. Pending user resolve before patching. Marking FIX-PENDING.

## DEFER

- **DNA fit (canopy/) integration into strategy.** Brief told me to look for `dnaFitScore` in strategy; it lives in canopy. Cross-territory — leave for Agent 3.
- **K11.2 promote-to-Dispatch composer** — confirmed `{ok:false}` return is intentional per HANDOVER. Defer.
- **K14.1 scenarios.js threshold-store overlay reads** — confirmed deferred per findings-AGENT-3 F-A3-006 cross-cutting note.
- **Decay/half-life on stale evidence (K11.1)** — deferred per HANDOVER.
- **Cross-account trust pooling** — deferred per HANDOVER.
- **`forward-simulator` v2 stochastic / competitor-reaction modeling** — deferred (intentional simple v1, doc-stringed).

## STREAMLINE (proposed cleanups, low priority, no behaviour change)

1. **Register the 2 orphan bus topics** in `modules/_shared/data-bus-topics.js` for parity with the rest of the strategy surface (Agent 6 owns the registry). Or delete if no consumer is ever planned. Prefer registration — cheaper than removing later if we want a tile.

2. **`pricing-*` cluster docs reference each other less cleanly than they could.** Four files (`price-moves` 664 LOC, `pricing-engine` 354, `pricing-compass` 507, `elasticity-fit` 274 = ~1800 LOC) layer well but a casual reader might think two of them are duplicates. Add a 4-line "the layering" note at the top of `price-moves.js` summarizing which file does what. Optional, no semantic change.

3. **`forward-simulator.js:88-90`** reaches into `window.AesCanopyDnaFit` + `AesCanopyDnaStore` from a strategy-pure module — that's a soft cross-territory dependency. The check is graceful-null, but it does hide the dependency. Could surface via `simulateForward(fork, opts)` as `opts.dnaFitFn` injection so the simulator stays purer. Defer to Phase 2 if Agent 3 wants to harden it.

4. **`auto-driver.js`** is 1049 LOC. Several disjoint subsystems (interval driver, signal handlers for cash-low / competitor-threat / pay-tier, cap-window logic). Splitting into `auto-driver-core.js` + `auto-driver-signals.js` would shrink each ~50%. Optional refactor, no behaviour change.

5. **`panel.js` is 2303 LOC.** By far the largest strategy file. Composition + render + apply-glue all in one IIFE. Streamline candidate: move per-section renderers (decisions, fleet allocation, settings strip, footer) into companion `panel-render-*.js` files, IIFE-wired through `window.AesStrategyPanelRender`. Pure-render extraction — no apply-path change. Mid-priority for a future audit pass; not load-bearing for current ship.

## Open questions

1. **Orphan emit policy** — When `company-reputation-store` emits `data:strategy:company-reputation:saved` and nothing subscribes, is the team's intent (a) consumers coming later, (b) telemetry for an out-of-tree tool, (c) dead code? The answer determines whether to register-or-delete. **Top open question — surfacing for the user.**

2. **Pricing-applier kill-switch defense-in-depth?** (carried, F-A3-002 / F-8-006). Should `apply-pipeline._applyPriceMoves` thread `settings.routeAssistant.pricing.apply.*` into the applier ctor, matching service/alliance? If yes — patch is one-line. If no — clarify in HANDOVER §10 that strategy supersedes RA panel for pricing.

3. **Pricing layering documentation** — Acceptable to add a short "this is how the four pricing files relate" header comment to `price-moves.js`? Or are doc-strings off-limits for the audit?

4. **Forward-simulator `Date.now()` watchdog** — Is the 2000ms budget meant to be deterministic (i.e. should the simulator never bail out under load)? Or is the bail-out by design? Cosmetic doc fix vs. rework.

5. **`forward-simulator` reading canopy DNA store directly** — should pure-strategy modules be allowed to peek at canopy? Or should DNA scoring inputs always be threaded as `opts.dnaFitFn`? The latter is purer; the former is what shipped.

---

## Counts (summary)

| Bucket | Count |
|---|---|
| Files in strategy/ | 73 |
| KEEP | ~67 |
| CUT | 0 |
| FIX | 4 (forward-simulator clone, 2 orphan emits, F-A3-002 pending) |
| DEFER | 6 documented features |
| STREAMLINE | 5 optional cleanups (panel split, auto-driver split, pricing docs, forward-simulator DI, register orphan topics) |
| Open questions | 5 |

**Bottom line for streamline:** strategy/ is in surprisingly good shape. No version debris, no duplicate scorers, defaults are uniformly safe, pure-function cores are pure (with one mostly-pure forward-simulator caveat already known). The only meaningful streamline opportunities are (a) splitting the two large UI files (panel.js 2303 LOC, auto-driver.js 1049 LOC) and (b) deciding what to do with the two orphan bus emits.
