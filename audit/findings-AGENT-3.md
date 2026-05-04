# Findings — Agent 3 (Strategy + Conductor + Canopy + Alliance)

Restarted from scratch. Phase-1 backup at `/tmp/findings-AGENT-3.phase1.bak.md`.
Categories: [BUG] / [DEFERRED-CONFIRMED] / [WIRING-GAP] / [INVARIANT-RISK] / [QUESTION].

(work in progress — entries appended as evidence is gathered)

---

## F-A3-001 [VERIFIED] apply-pipeline two-gate enforced for all six domains

**Files:** `modules/strategy/apply-pipeline.js:826,867,1101,1117`, `modules/strategy/default-settings.js:533-539`

`canApply(s, domain)` is the single point combining tier (`!== "preview-only"`) and per-domain flag (`DOMAIN_FLAGS` ⇒ `xxxEnabled`). All six brief-listed domains map cleanly:

| domain          | flag                   | enforced in apply()           | enforced in applyDecision() |
|-----------------|------------------------|-------------------------------|-----------------------------|
| schedule        | `scheduleApplyEnabled` | line 867 (bucket gate) + 826  | n/a (bulk only)             |
| service         | `serviceMovesEnabled`  | line 867 + 826                | n/a                         |
| price           | `priceMovesEnabled`    | line 867 + 826                | n/a                         |
| crew            | `crewMovesEnabled`     | line 867 + 826                | n/a                         |
| routeCreation   | `routeCreationEnabled` | line 867 + 826                | n/a                         |
| alliance        | `allianceMovesEnabled` | line 867 + 826                | line 1101 + 1117            |

**Note on brief wording.** The brief says "Verify gate is in `_applyXyzMoves` for each, not bypassable." In shipped code the gate lives in the public entry points (`apply()` bucketing loop + `applyDecision()` pre-checks); `_applyXyzMoves` are closure-private (defined inside the IIFE at lines 262/333/463/585/662/749 and never assigned to `ns`). External callers cannot reach them, so the gate is non-bypassable from outside the module. The two-gate is structurally upstream of every `_applyXyzMoves`, which is the same end behaviour the brief describes.

**One genuine inconsistency** — see F-A3-002 (pricing applier hardcodes its own gates open). Otherwise the gate model is clean.

---

## F-A3-002 [QUESTION] _applyPriceMoves bypasses the RA pricing applier kill-switch (carried forward)

**File:** `modules/strategy/apply-pipeline.js:483`

```js
applier = new Applier(server, {applyEnabled: true, dryRunOnly: false})
```

The RA pricing applier is constructed with both per-instance gates hardcoded open, regardless of `settings.routeAssistant.pricing.apply.{enabled,dryRunOnly}`. Strategy substitutes its own two-gate (`tier !== "preview-only"` AND `priceMovesEnabled`).

Compare:
- `_applyServiceMoves` (line 354–372): reads `settings.serviceApply.dryRunOnly`, threads it into the applier ctor.
- `_applyAllianceMoves` (line 683–691): reads `settings.alliance.apply.{enabled,dryRunOnly}`, threads both.
- `_applyPriceMoves` (line 483): hardcoded open. Pricing is the odd one out.

Practical effect: a user who explicitly turns OFF `settings.routeAssistant.pricing.apply.enabled` in the RA panel will still have **strategy** POST pricing as long as strategy's own gates are open. The RA panel's kill-switch only stops RA-originated pricing, not strategy-originated.

**Question for user** (also flagged by Agent 8 F-8-006, who leans defense-in-depth): is this intentional ("strategy is its own authority over pricing") or a bug? My read: align pricing with the service/alliance pattern — defense-in-depth — and the user's RA-panel kill-switch should mean "no pricing writes from this codebase, full stop." Awaiting user decision before patching.

---

## F-A3-003 [VERIFIED] outcomes → learn → journal closed loop

**Files:** `modules/strategy/outcomes.js`, `modules/strategy/learn.js`, `modules/strategy/journal-store.js`

End-to-end trace per brief item 2:

| spec item                                                       | location                                                | status |
|-----------------------------------------------------------------|---------------------------------------------------------|--------|
| Outcomes ring caps at 100                                       | `outcomes.js:56` `RING_CAP=100`; clamp at `:258`        | ✓      |
| Per-airline scoping with legacy fallback                        | `outcomes.js:69-77, 218-225`                            | ✓      |
| `tryCaptureAfter` only stamps when `now-applyTs ≥ windowMs`     | `outcomes.js:279`                                       | ✓      |
| `learn()` requires ≥5 attributed outcomes (default `minSamples`)| `learn.js:43, 261, 277-281`                             | ✓      |
| `getCurrentWeights()` returns merged set with `DEFAULT_WEIGHTS` | `learn.js:74-103`                                       | ✓      |
| Gradient partitions per weight key into above-/below-median     | `learn.js:222-244` (`_gradient`)                        | ✓      |
| Step size respected (settings → `learningStepSize`, fallback 0.05)| `learn.js:259-260, 290`                               | ✓      |
| Gradient guard: cohort < 2 → all-zero grad                      | `learn.js:220`                                          | ✓      |
| `learn()` short-circuits when `learningEnabled === false` (unless `force`) | `learn.js:262-266`                           | ✓      |
| Journal store ring cap 750, per-account scoped                  | `journal-store.js:68, 198, 109`                         | ✓      |
| Apply pipeline records 1 journal entry per applied decision     | `apply-pipeline.js:990-1017`                            | ✓      |
| Outcome `before` recorded only when `okCount > 0 && learningEnabled` | `apply-pipeline.js:1029-1057`                     | ✓      |

**Caveats and observations:**

1. `_gradient` partition uses `v >= median` for "above" and `v < median` for "below" — equality lands in *above*. For odd-length cohorts this gives a 1-extra "above" partition; for even-length it splits cleanly. Documented expected behaviour, no defect.
2. `learn.js:290` clamps new weights to `[0, 2]` regardless of source. Acceptable v1 floor/ceiling — not user-configurable.
3. `outcomes.measure()` is documented as "pure" but reads `Date.now()` (line 91, into `out.ts`) and optionally calls `window.AesStrategyFleetUtilization.compute()` (line 196, gated by typeof check). Both are intentional and the comment block at 188-211 explains the Lane C integration. The clock read populates the measurement timestamp; downstream `record()` overrides with `applyTs`. Not a defect, but the "Pure measurement extractor" header could read "Mostly-pure measurement extractor (clock + optional fleet utilization rollup)" — cosmetic.

---

## F-A3-004 [VERIFIED] Agent 1 F-4 carry-over: journal-store loads after learn.js but currently benign

**Files:** `manifest.json:418-419, 984-985`

Confirmed Agent 1's static read: in blocks 5 (dashboard) and 27 (fleets), `learn.js` loads at slots 418/984 and `journal-store.js` immediately after at 419/985. Agent 1 traced this as benign because `learn.js`'s IIFE only:
- defines `window.AesStrategyLearn` (line 302-313)
- runs an opt-in `?aes-debug` smoke that calls `_gradient(fakeOutcomes)` — pure, no writes (line 318-333).

`_journal()` (learn.js:189-199) is only invoked from `setCurrentWeights` / `resetWeights` / `learn()`, all user-triggered after both modules have loaded. So no race today. The Phase-2 fix (swap order to journal-store BEFORE learn.js) is still recommended as future-proofing — flagging in agreement with Agent 1.

---

## F-A3-005 [VERIFIED — refutes Agent 8 F-8-002 sub-item] journal-panel bus subscription is correct

**Files:** `modules/strategy/journal-store.js:101, 200, 212`, `modules/strategy/journal-panel.js:325-339`

Agent 8 F-8-002 lists `journal:entry-recorded` and `journal:reason-updated` as "Dead listeners (subscribed by `strategy/journal-panel.js` — wrong bus; the journal store emits on `AesDataBus`/`CentralHubBus`, not AesAfp)."

This is a script false-positive. journal-store.js creates its **own** internal bus via `_createBus()` (line 101), assigns it to `window.AesStrategyJournal.bus`, and emits both topics on that bus (lines 200, 212). journal-panel.js subscribes via `ns.bus.on(...)` where `ns = window.AesStrategyJournal` (lines 334-335). Same bus instance — neither AesDataBus nor AesAfp.bus is involved. Wiring is correct.

Tag for Agent 8: the bus-audit script's pattern matcher likely classifies any `ns.bus` reference into one of the four global buses. Worth flagging the false-positive class — at least journal store, AesStrategy.bus consumers, and AesAfp.bus consumers fit this pattern of "module-owned bus" and shouldn't be cross-checked against the global registry.

---

## F-A3-006 [VERIFIED + 1 BUG carried] K11 trust + K14 drift + Slice 21 forks

### K11 (trust)

| spec                                                          | location                                          | status |
|---------------------------------------------------------------|---------------------------------------------------|--------|
| Beta-Bayesian prior (2,2)                                     | `trust-store.js:39-40`                            | ✓      |
| LCB = mean − 1.6449 × stderr (5% one-sided)                   | `trust-store.js:71-80`                            | ✓      |
| Tier thresholds: suggest 0.40, apply-confirm 0.60, apply-auto 0.80 | `trust-store.js:43-47`                       | ✓      |
| 0.05 hysteresis band on demote                                | `trust-store.js:48, 92-93`                        | ✓      |
| Subscriber on `conductor:outcome:applied`                     | `trust-driver.js:119`                             | ✓      |
| fireId dedup ring (cap 200)                                   | `trust-driver.js:24, 82-83, 87-88`                | ✓      |
| Emits `data:conductor:trust:updated` + `signal:conductor:tier:promoted` | `trust-driver.js:94-110`                | ✓      |

### K14 (drift detection)

| spec                                                          | location                                          | status |
|---------------------------------------------------------------|---------------------------------------------------|--------|
| Two-sided CUSUM                                               | `drift-detector.js:109-110`                       | ✓      |
| `k = 0.5σ`, `h = 5σ`                                          | `drift-detector.js:41-42, 107-108`                | ✓      |
| σ from rolling window of last 50 residuals                    | `drift-detector.js:40, 79, 102-103, 61-74`        | ✓      |
| 20-residual clean-window self-reset                           | `drift-detector.js:43, 130-141`                   | ✓      |
| Drift driver clamps K11 ceiling on trip                       | `drift-driver.js:175-188`                         | ✓      |
| Drift driver clears ceiling on `cleared` transition           | `drift-driver.js:204-207`                         | ✓      |
| Threshold-store overlay two-gate (`enabled=false OR dryRun=true` ⇒ no write) | `threshold-store.js:71-92`         | ✓      |
| Polarity asymmetry on demote: pos = one notch, neg = straight to alert | `drift-driver.js:181-186`                | ✓ (intentional, documented at 173-174) |

### Slice 21 (forks)

| spec                                                          | location                                          | status |
|---------------------------------------------------------------|---------------------------------------------------|--------|
| Fork ring cap 5 FIFO (per account via `AesAccountKey`)        | `fork-store.js:26, 30-35, 68-71`                  | ✓      |
| `promote()` returns `{ok:false}` (composer not shipped)       | `fork-store.js:117-119`                           | ✓ (deferred-confirmed K11.2) |
| Additional safety: `promotionEnabled` default false (§4.18)   | `fork-store.js:113-116`                           | ✓ (defense-in-depth)         |

### F-A3-007 [BUG] (Phase 1 carry-over) `forward-simulator.js _decay` mutates `fork.snapshot` in place

**File:** `modules/strategy/forward-simulator.js:103-122, 152`

`simulateForward(fork, opts)` calls `_decay(fork.snapshot)` once per simulated week. `_decay` directly mutates `a.age`, `a.wear.ratio`, and `r.orsRank` on the shared snapshot object — there is no clone or restore. Re-running `simulateForward(fork, {weeks: 12})` after a previous run yields a divergent baseline because the second call begins from the already-decayed state.

User-visible: clicking "Simulate 4wk" then "Simulate 12wk" projects week 1 from a state that already has 4 weeks of decay baked in. The deltas table is meaningful only for the very first run. Contradicts the docstring's "deterministic projection" wording (line 4).

**Fix candidates (Phase-2):**
- Clone `fork.snapshot` (`AesStrategySnapshotFork.deepClone` or structuredClone with JSON fallback) at simulator entry; do all decay+score on the clone; never write back.
- Optionally update `fork.lastResult` only.

Agent 8 already announced (SHARED-NOTES 10:14) that they will write `audit/tests/strategy/forward-simulator-determinism.test.js` to lock this. Will coordinate so my own smoke (task #18) doesn't duplicate.

### Cross-cutting K14 deferral confirmed: scenarios.js doesn't read overlays

**File:** `modules/conductor/scenarios.js:52-57`

`scenarios.js` declares `RATIO_FLOOR=105`, `CONDITION_FLOOR=60`, `PROFIT_DECAY_PCT=0.25`, `PROFIT_RECOVER_PCT=0.25`, `ORS_RANK_DROP_MIN=2` as module-private constants and references them directly (lines 135, 141, 149, 152, 193, 197, 205, 208, 307, 367, 434, 488, 510). The constants never flow through `AesConductorThresholdStore.resolve(scenarioId, key, baseDefault)`. Net: drift-driver writes overlays into the store, the apply-gate works for `apply()`, the tile renders proposals — but the scenario `match()` path that *consumes* the overlays still uses the hardcoded values. **Confirmed deferred K14.1 per the brief**, not a bug.

The wiring already exists end-to-end except this last hop. K14.1 ship would just replace the constant references in scenarios.js with `await AesConductorThresholdStore.resolve(host, scenarioId, "RATIO_FLOOR", RATIO_FLOOR)` (or the synchronous `loadCached` cache pattern hinted at in threshold-store.js:60).

---

## F-A3-AUTOPRICE-AUDIT [VERIFIED] autopricer per-class + cargo pipeline end-to-end (2026-05-03)

**Scope check:** user requested confirmation that the autopricer (a) distinguishes Y / C / F / Cargo, (b) uses demand calculations, (c) writes per-class through the apply path. Audit covers: `silent-auto-proposer-per-class.js`, `silent-auto-proposers.js`, `pricing-applier.js`, `central-price-automator.js`, `demand-derivator.js`, `pricing-engine.js`, `pricing-compass.js`, `unified-settings/adapters/per-cabin-pricing.js`, `panel.js`'s silent-auto loop, and `strategy/apply-pipeline.js`.

| concern                                                              | location                                                  | status |
|----------------------------------------------------------------------|-----------------------------------------------------------|--------|
| Per-class proposer dispatched (default `per-class-elasticity`)       | `silent-auto-proposers.js:500-505`, `central-price-automator.js:130` | ✓ |
| Y/C/F/Cargo each priced from own elasticity + demand pool + LF       | `silent-auto-proposer-per-class.js:266-321`               | ✓ |
| Cargo class enabled by default, on its own demand curve              | `silent-auto-proposer-per-class.js:79`, `:137-144`        | ✓ |
| Per-class apply gate (`pricing.apply.classes.<cls>.enabled`) honored | `silent-auto-proposer-per-class.js:234-240`, `pricing-applier.js:903-907` | ✓ |
| Demand-derivator emits per-class signals                             | `demand-derivator.js:88-153`                              | ✓ |
| Applier writes all 4 classes via Wicket form fields                  | `pricing-applier.js:78-85, 446-458`                       | ✓ |
| Cargo decimal handling preserved through fingerprint + verify        | `pricing-applier.js:138, 1269-1300`                       | ✓ |
| Strategy apply-pipeline respects RA pricing kill-switch              | `apply-pipeline.js:131-146, 499-522`                      | ✓ (closes F-A3-002) |
| Forward-simulator no longer mutates fork (was F-A3-007)              | `forward-simulator.js:143`                                | ✓ |
| Per-cabin settings UI exposes Y/C/F/Cargo toggles + demand inputs    | `unified-settings/adapters/per-cabin-pricing.js:87-237`    | ✓ |
| Panel silent-auto tick threads classGates to applier                 | `panel.js:23899`                                          | ✓ |
| Manifest loads proposers BEFORE panel + central automator (3 entries)| `manifest.json:235-245, 597-639, 950-975`                 | ✓ |

**Tests run, 22/22 pass:**

```
route-assistant/account-scoped-stores         7  pass
route-assistant/bulk-apply-rounding           9  pass
route-assistant/central-price-automator      11  pass
route-assistant/dashboard-pricing-manifest    1  pass
route-assistant/demand-derivator              ✓  pass
route-assistant/markets-page-scraper          ✓  pass
route-assistant/ors-intelligence              4  pass
route-assistant/ors-model-smoke              10  pass
route-assistant/per-class-elasticity         24  pass
route-assistant/pricing-applier               8  pass
route-assistant/profit-estimator-byclass      5  pass
route-assistant/quick-price-applier           4  pass
route-assistant/score                        16  pass
route-assistant/silent-auto-proposers         6  pass
route-assistant/watchlist-store-context       ✓  pass
route-assistant/wave-automation-context       3  pass
strategy/per-class-competitor-band            5  pass
strategy/per-class-decayed-band               5  pass
strategy/forward-simulator-determinism        7  pass
strategy/apply-pipeline-price-gate            2  pass
```

**Conclusion:** the autopricer pipeline is sound for Y / C / F / Cargo distinction. Demand calculations (per-class elasticity, demand pool, RM tightness) drive proposals; per-class competitor median pulls a 50/50 blend when present; marginal-cost floor is computed per cabin so first-class isn't pinned to an economy floor. Apply path writes each cabin's price into the AS Wicket form via observed field names with cargo-specific decimal handling. Class gates work both at proposer level (silent-auto-proposer-per-class.js:_classEnabled) and at applier preflight (pricing-applier.js:903) — defense in depth.

**Open items the user should be aware of (not bugs, design defaults):**
- Both apply gates default to dry-run (`apply.dryRunOnly: true`, `apply.enabled: false`). To enable real writes the user has to flip both *and* set `apply.liveScopes.silentAuto = true` for autonomous ticks. Manual one-shots only need the two top-level gates. This is the documented HANDOVER §10 invariant.
- F-A3-002 was closed in current code (apply-pipeline.js:519-522 reads `raApply.enabled` + `raApply.dryRunOnly` from settings). Marking the carry-over question RESOLVED.
- Live-write live-test against the route builder is gated by the SHARED-NOTES real-write lock protocol (`CLAUDE.md §2`); not run in this audit pass.
