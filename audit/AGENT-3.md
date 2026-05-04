# AGENT-3.md — Strategy + Conductor + Canopy + Alliance (Decision Layer)

You own the orchestration / decision layer. Most architecturally complex part of the codebase, most recent shipping focus per HANDOVER.

## Why this is its own territory

Strategy + Conductor + Canopy is where the engine actually decides things. Pure-function cores live here. Trust + drift + foresight machinery wired here. Apply pipeline ultimately dispatches from here. Conceptually heavy — needs a single agent with full context.

## Your Chrome instance

Open `/app/enterprise/dashboard*`. The strategy modal, conductor tile, family tile, DNA tiles all live there. The strategy briefing tile auto-opens once per game-week — you'll see it.

**Lock requirement:** acquire SHARED-NOTES real-write lock before:
- Clicking Apply on a strategy plan with tier `apply-on-confirm` flipped on (this triggers real writes via the apply-pipeline).
- Triggering an alliance/IL request apply with `dryRunOnly: false`.
- Promoting a counterfactual fork (returns `{ok:false}` today, but if you somehow get it working, lock first).

**No lock needed for:**
- Opening the strategy modal in tier `preview-only`.
- Composing plans.
- Running learn cycles (writes to settings, not AS).
- DNA wizard / per-account editor (writes to canopy storage, not AS).
- Reading conductor tile, family tile, drift tile, counterfactual lab tile.

## Your scope

```
modules/strategy/                # ~30 files
modules/conductor/               # ~15 files including routines/
modules/canopy/                  # ~10 files
modules/alliance/                # 1 file (il-request-applier.js)
modules/central-hub/tiles/strategy*.js
modules/central-hub/tiles/strategy-briefing-tile.js
modules/central-hub/tiles/conductor*.js
modules/central-hub/tiles/family-tile.js
modules/central-hub/tiles/dna-drift-tile.js
modules/central-hub/tiles/counterfactual-lab-tile.js
modules/central-hub/tiles/conductor-trust-tile.js
modules/central-hub/tiles/drift-tile.js
```

Read but don't edit `modules/route-assistant/wave-overlay.js` (your strategy modules consume it).

## Priority audit areas

1. **Apply pipeline two-gate** — `modules/strategy/apply-pipeline.js` is the central dispatcher. Must enforce both `tier !== "preview-only"` and per-domain `xxxEnabled` flag for every domain (schedule, service, price, crew, routeCreation, alliance). Verify gate is in `_applyXyzMoves` for each, not bypassable.

2. **Closed-loop learning chain** — `outcomes.js` records before/after; `learn.js` runs gradient descent; `journal-store.js` records narrative. Verify:
   - Outcomes ring caps at 100.
   - Learn requires ≥5 attributed outcomes.
   - `getCurrentWeights()` returns merged set.
   - Gradient estimator partitions outcomes into above-median / below-median per weight key.
   - Step size respected.

3. **K11 trust + K14 drift + Slice 21 forks** — Trust → Drift → Foresight wave. Verify:
   - `trust-store.js` Beta-Bayesian posterior updates on `conductor:outcome:applied` bus.
   - LCB at 5% drives tier promotion (alert → suggest → apply-confirm → apply-auto).
   - 0.05 hysteresis band prevents single-bad-outcome demotion.
   - `drift-detector.js` two-sided CUSUM with `k=0.5σ`, `h=5σ`, σ from rolling 50 residuals.
   - Drift-driver clamps K11 tier ceiling on trip; clears on cleared transition.
   - Threshold-store overlay's two-gate (`enabled=false OR dryRun=true` ⇒ no overlay write).
   - Fork-store cap 5 named forks per account FIFO.
   - `promote()` returns `{ok:false}` because composer not shipped (**deferred-confirmed**, not a bug).

4. **Conductor scenarios + routines** — 10 scenarios, 3 routines. Each should have:
   - `match(signal)` returning fire records.
   - State transitions logged in `instance.history[]`.
   - Per-account fire ring at `aesConductor:fires:<server>:<airline>`.

5. **Strategy DNA (L5)** — 10-dimension playstyle profile. Verify:
   - Template at `aesCanopy:dna`.
   - Per-account override at `aesCanopy:dnaOverride:acct:<id>`.
   - `effectiveDna(accountId)` deep-merges leaf-by-leaf.
   - Wizard, account editor, drift detector all read through `effectiveDna` (invariant L5-A).

6. **Affiliations (L4-lite) + Family tile (M1)** — Family tile renders cross-kin handoff opportunities. Verify:
   - `aesCanopy:affiliations` blob structure.
   - Auto-classification from contractualPartners.
   - userOverride absolute precedence (invariant L4-A).
   - `proposeKinHandoffMoves` defaults preview-only (invariant M-A).

7. **Slice 12 alliance & IL** — `connectivityWeight` term in `decide-routes.js`, `_applyAllianceMoves` sub-pipeline, `AllianceIlRequestApplier`. Verify IL applier ships with `dryRunOnly:true` (invariant — must not flip).

## Specific things flagged

- "Scenarios.js threshold-overlay reads — threshold-store + drift proposals + tile + apply gate all wired, but scenarios.js still uses hardcoded `RATIO_FLOOR`/`PROFIT_DECAY_PCT` constants" — **deferred K14.1**, not a bug.
- "Promote-to-Dispatch composer not shipped" — **deferred K11.2**.
- "K11 settings UI — per-scenario tier ceiling matrix" — **deferred**.
- "Cross-account trust pooling deferred" — **deferred**.
- "Decay/half-life on stale evidence" — **deferred K11.1**.
- Auto-route-creation (Slice 6) — verify AFP orchestrator integration. Applier picks aircraft and builds legs; if AFP tier dormant, report carries `aborted:true`. Correct.

## Pure-function smokes

These MUST be pure. Write under `audit/tests/strategy/`:

- `decide-routes.js scoreRoutes` — same input → same output.
- `diff-plan.js diffPlan` — flatten plan deterministically.
- `outcomes.js measure` — extracts only documented fields.
- `learn.js _gradient` — corner cases (all-zero, single sample, etc.).
- `risk-profiles.js apply` — Conservative/Balanced/Aggressive return expected weights.
- `tier-gate.js` — clamping order respected (user > scenario > drift > global).
- `dna-fit-scorer.js dnaFitScore` — score in [0, 1], breakdown sums correctly.
- `forward-simulator.js` — deterministic projection up to 12 weeks.
- `interline-gap-detector.js detectGaps` — synthetic kins produce expected gaps.

## Live verifications you can run

In your Chrome on dashboard:

- Strategy modal opens. Tier dropdown shows Preview-only / Apply-on-confirm.
- Conductor tile lists scenarios sorted by severity.
- Family tile shows N kins + M opportunities (or quick-start hint if 0–1 kins).
- DNA wizard opens via Settings → Account → Strategy DNA.
- DNA drift tile shows aligned/drifting/misaligned per account.
- Strategy briefing tile auto-opens once per game-week with applied/drifted/opportunities/risk cards.
- Counterfactual lab: Cmd-Shift-K → "Fork current snapshot" creates Fork 1.

For each, note what works and what's missing.

## Forbidden

- No edits outside listed scope.
- No introducing new actuator. Strategy dispatches to existing appliers (apply-batch, service-profile-applier, pricing-applier, staff-pilots-applier, route-creation-applier, il-request-applier). Don't add a sixth.
- No flipping any `dryRunOnly` default. No flipping any `apply.enabled` default.
- No mutating `aesStrategy:plan:applied` schema (Slice 5 outcome attribution depends on it).
- Bus topic name changes route through Agent 6.

## End-of-session deliverable

`audit/findings-AGENT-3.md`:

- Apply pipeline two-gate verified per domain.
- Outcomes → learn closed loop traced end-to-end.
- K11 + K14 + Slice 21 verification per priority list.
- L5 DNA resolver invariant L5-A checked at every consumer.
- IL applier dryRunOnly status + composer-not-shipped confirmation.
- Pure-function purity violations found.
- Smoke tests under `audit/tests/strategy/`.
- Live verification results.
