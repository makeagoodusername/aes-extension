# AES Strategic Operating System — full roadmap

> Working title for the engine: **`AesStrategy`**.
> Purpose: turn AES from a collection of helpers into a closed-loop strategic operating system for one or more AirlineSim airlines, where every signal already being scraped feeds dynamic decisions about allocation, pricing, service, crew, fleet composition, network design, and inter-airline coordination — applied through the existing actuators with explicit user opt-in and full auditability.

---

## Part I — Vision

### The user's articulated vision

> "The information already being scraped should inform the production of the schedules which should be dynamically inserted and changing to allocate resources (airplanes) to certain schedules in a certain manner of flux and dynamic allocation to consider and utilise functions that are already existent such as the ORS and the sandbox system where the demand and therefore price is considered along with the competitors who are present or not present to define the strategy that can be deployed through the interface by automating certain functions that are already there."
>
> "It should consider maintenance, which it already does, it should consider the strategy of the company as a whole with the different personnel changes that might affect the ORS system by how the perception of the company changes with how much employees are payed."
>
> "It should also automate the creation of the new routes and define strategy that is dependent on the dynamic positioning of the various companies that hopefully will be integrated into the rest of the management of these different companies in the same game world."
>
> *— Direct quotes, preserved verbatim so the engine's design intent is anchored to the user's words.*

### One-sentence mission

**Run the airline (or family of airlines) for me, but show me every decision and let me veto each one until I trust the engine.**

### Design principles

1. **Read-only by default; opt-in to apply.** Every slice that POSTs to AS is gated behind a tier setting and a confirm modal. The default install is a 100% advisory tool.
2. **Reuse existing actuators.** The strategy layer NEVER bypasses the safety gates already established in `apply-batch.js`, `service-profile-applier.js`, `quick-price-applier.js`, `staff-pilots-applier.js`, or `form-driver.js`. The single-source-of-truth for "things that POST" stays where it is.
3. **Every decision is explainable.** Each proposed action ships with a rationale string referencing the inputs (which signals, with what values) and the score breakdown (which terms moved the needle). No black box.
4. **Closed-loop.** After every apply window, the engine compares predicted vs. observed deltas (profit, ORS, load factor) and nudges its own weights. The user can inspect the drift and roll back.
5. **Backtestable.** Anything the engine decides can be replayed against historical snapshots from `AccountingSnapshotStore` to validate it would have made profitable decisions in the past before being trusted with the future.
6. **Multi-airline native, single-airline safe.** The same code path runs whether you own one airline or five sisters; cross-airline coordination is a switchable flag, never the default.
7. **No new scrapers unless absolutely required.** The exploration confirmed the codebase already scrapes virtually everything the engine needs. Net-new scrapes are last-resort.
8. **Storage-budget aware.** `chrome.storage.local` has a 10 MB cap. Every store the engine writes is sized + capped + TTL'd to stay under 1 MB total for the strategy namespace.
9. **Cross-tab safe.** Multiple AS tabs may be open simultaneously. The engine uses `chrome.storage.onChanged` for invalidation and never holds in-memory state that would diverge between tabs.

### Glossary

| Term | Meaning in this plan |
|---|---|
| **AS** | AirlineSim, the browser game |
| **ORS** | Operational Rating System — AirlineSim's per-route quality score combining service, frequency, timing |
| **alpha-Y / alpha-C / alpha-F** | Per-class rating multipliers in AS's demand model |
| **paxScore / cargoScore** | 0–10 demand bars surfaced on AS's airport pages |
| **IL** | Interline — AirlineSim's codeshare-style partner-flight-feed mechanism |
| **Sister** | A second airline owned by the same enterprise on the same server |
| **Tier** | An apply-policy level (`preview-only`, `apply-on-confirm`, `apply-auto`) controlling automation aggressiveness |
| **Snapshot** | The unified read-only context object produced by `AesStrategy.snapshot()` |
| **Decision** | A single proposed action: schedule a leg, change a price, hire a pilot, lease a tail |
| **Plan** | A bundle of decisions across the fleet, scored and ranked, presented to the user |
| **Apply window** | The interval between two strategy applies; the engine measures deltas across this window |

---

## Part II — Architecture

### Layer cake

```
┌───────────────────────────────────────────────────────────────────┐
│  UI: dashboard tile, per-page panels, executive briefing modal    │
├───────────────────────────────────────────────────────────────────┤
│  AesStrategy.apply(plan)        ← Slice 4 — marshals actuators    │
├───────────────────────────────────────────────────────────────────┤
│  AesStrategy.allocateFleet(snapshot, scored)   ← Slice 3          │
│  AesStrategy.scoreRoutes(snapshot, weights)    ← Slice 2 (DONE)   │
│  AesStrategy.snapshot({server, airline})       ← Slice 1 (DONE)   │
├───────────────────────────────────────────────────────────────────┤
│  Existing read stores                Existing write actuators     │
│  (demand, distance, comp, ors,       (apply-batch, service-       │
│   maint, wear, log, ledger,          profile-applier, quick-price │
│   crew, fleet, sisters, settings)    applier, staff-pilots-       │
│                                       applier, form-driver)       │
└───────────────────────────────────────────────────────────────────┘
```

### Public namespace contract

```js
window.AesStrategy = {
    // Slice 1 (shipped)
    snapshot({server?, airlineCode?, includeStaleDemand?}) → Promise<Snapshot>,

    // Slice 2 (shipped)
    scoreRoutes(snapshot, weights?) → {weights, global, routes: ScoredRoute[]},
    DEFAULT_WEIGHTS,

    // Slice 3
    allocateFleet(snapshot, scoredRoutes, opts?) → FleetPlan,
    proposeRouteCreations(snapshot, scoredRoutes, opts?) → RouteCreation[],
    proposePriceMoves(snapshot, opts?) → PriceMove[],
    proposeServiceMoves(snapshot, opts?) → ServiceMove[],
    proposeCrewMoves(snapshot, fleetPlan, opts?) → CrewMove[],

    // Slice 4
    diffPlan(plan, snapshot) → PlanDiff,
    apply(plan, opts?) → Promise<ApplyReport>,

    // Slice 5
    recordOutcome({plan, before, after, notes?}) → Promise<void>,
    learn(opts?) → Promise<{newWeights, changed, before, after}>,
    backtestWeights(weights, history) → BacktestReport,

    // Slice 6+
    proposeFleetRenewal(snapshot, opts?) → FleetRenewalProposal,
    proposeHubMoves(snapshot, opts?) → HubProposal[],
    proposeAlliancePartners(snapshot, opts?) → AllianceProposal[],
    proposeMarketingSpend(snapshot, opts?) → MarketingProposal,

    // Diagnostics / UI
    explain(decision) → ExplanationCard,
    riskProfile() → "conservative" | "balanced" | "aggressive",
}
```

### Storage namespacing

All strategy-owned keys live under `aesStrategy:<topic>:<scope>` so they never collide with `routeAssistant:*`, `aircraftFlightPlan:*`, `accounting:*`, or `crewMgmt:*` namespaces. Total budget: 1 MB across the whole namespace, enforced by a `aesStrategy:_budget` ledger that tracks bytes per topic and evicts oldest history when over.

```
aesStrategy:settings              → user weights + risk profile + opt-in flags
aesStrategy:learn:weights:current → current learnt weights
aesStrategy:learn:weights:history → ring buffer of past weights (cap 52 weeks)
aesStrategy:learn:outcomes        → ring buffer of (plan, before, after) tuples
aesStrategy:plan:proposed         → most recent proposed FleetPlan (preview cache)
aesStrategy:plan:applied          → most recent applied FleetPlan
aesStrategy:audit                 → ring buffer of every applied decision (cap 500)
aesStrategy:journal               → narrative ring of override/note/watchlist/apply/weight events (cap 750; per-account scoped at acct:<id>)
aesStrategy:backtest:results      → cached backtest results
aesStrategy:_budget               → byte accounting metadata
```

### Bus contract

The strategy layer reuses the existing `AesAfp.bus` where AFP is loaded; on the dashboard it owns its own `AesStrategy.bus` (re-exported `MessageBus` instance). All cross-tab events go through `chrome.storage.onChanged`.

```
out: strategy:snapshot-ready    {ts, server, airline, missing[]}
out: strategy:plan-proposed     {planId, ts, summary}
out: strategy:plan-applied      {planId, succeeded, failed, errors[]}
out: strategy:weights-changed   {oldWeights, newWeights, reason}
out: strategy:outcome-observed  {planId, profitDelta, orsDelta, lfDelta}
in:  ctx:ready                  → re-snapshot if context changed
in:  topRoutes:updated          → invalidate proposed plan cache
in:  competitorIntel:updated    → invalidate proposed plan cache
```

### Failure modes

| Failure | Engine response |
|---|---|
| Store missing on current page | `snapshot.missing[]` lists it; downstream layers degrade gracefully |
| Stale data (> TTL) | Surface "stale signal" badge in the rationale; don't refuse |
| Apply pipeline reports failure | Add to `audit` with full error; never auto-retry; user re-applies manually |
| Schema drift in a store record | Strategy reads with `_num()`/`_safe()` guards; missing fields → null, never throw |
| Storage budget exhausted | Evict oldest history entries first; never block writes; warn in tile |
| User races two apply windows | Per-aircraft serial queues already enforced by `apply-batch.js` |
| Cross-tab simultaneous apply | First writer wins on `aesStrategy:plan:applied`; second-tab apply aborts with notice |

---

## Part III — The slices

> **Status legend** — ✅ shipped (this branch) · 🟡 in-progress · ⬜ planned

### Slice 1 ✅ Strategy Context

**Status:** shipped at `modules/strategy/context.js`; manifest-wired on dashboard + `/app/fleets*`.

**What it does:** unified read-only synthesis over every signal store. Returns one `Snapshot` object (shape documented in file's header). Defensive of missing stores; reports `missing[]` so callers can tell graceful-null from real null.

**What we learned shipping it:**
- `AccountingAggregator.loadUnifiedLedger` is already cross-hub and cross-aircraft — we get fleet P&L for free.
- `RouteAssistantMarketsPageScraper.bulkLoadCache` returns multiple "families" (competitors, marketShare, historic). We currently summarize "competitors" + first-rank carrier; future slices can layer historic into pricing decisions.
- `AesAfpMaintenanceBudget.compute` already does the heavy maintenance math (regression vs. fallback, scheduled-maintenance subtraction, ratio forecast). Strategy is a thin caller.
- Crew is keyed by **skill label** (e.g. "B737"), not typeId. We pass the label through and let downstream layers map label → typeId via `RouteAssistantTypeSpecsStore`.

**Open hooks for later slices:**
- `rivals[]` is empty in v1 (Slice 6+ extends with `AesCompetitorEnterpriseScraper`).
- `sisters` is the raw page-scrape blob; Slice 11 normalizes it.
- No backfill of historic snapshots (Slice 14).

---

### Slice 2 ✅ Per-Route Decision Scoring

**Status:** shipped at `modules/strategy/decide-routes.js`; not yet manifest-wired (next commit).

**What it does:** pure function `scoreRoutes(snapshot, weights?)` ranks every (hub,dest) in the snapshot. Composite formula combines profit, demand, competitor opportunity, ORS leverage, fleet wear stress, cash stress. Each route ships with a `breakdown` (per-term contribution) and a `rationale[]` (human-readable strings).

**What's already correct:**
- `DEFAULT_WEIGHTS` is exposed publicly so the panel/learn slices can mutate without forking.
- Override-aware: routes carrying user-set `paxLF`/`yieldPerKm` overrides surface that fact in rationale and (Slice 3) skip demand-curve fallback.
- Watchlist-aware: routes the user has watchlisted earn a rationale tag (no score bump in v1, but visible).

**Known limitations to address in Slice 3:**
- `_orsTerm` uses the **best** Y-class score across all known profiles as a flat ceiling. Per-route the engine should pick the cheapest profile that hits a target ORS, not the most expensive.
- `_profitTerm` divides by a fleet-average seat count when the route isn't yet assigned to a specific aircraft. Slice 3's allocator will re-score routes against each candidate aircraft's actual seats.
- `_competitorTerm` uses a hardcoded saturation cap of 28 weekly flights. Should be calibrated per-route from `historic` family data.

---

### Slice 3 ⬜ Fleet Co-Allocator

**Goal:** lift the per-aircraft greedy allocator to fleet-level co-allocation that decides simultaneously: which aircraft flies which routes, with which service profile, at which price, with which crew prerequisites.

**Inputs:**
- `Snapshot` from Slice 1.
- `ScoredRoutes` from Slice 2.
- `opts`: `{horizonDays?, preserveLockedLegs?, riskProfile?, crossAirlineEnabled?}`.

**Outputs:**

```ts
type FleetPlan = {
    planId: string,                    // uuid for audit correlation
    server, airlineCode,
    horizonDays: number,
    perAircraft: [{
        aircraftId, registration, equipment,
        legs: [LegSpec],               // shape compatible with apply-batch.js
        ground: [{day, startMin, endMin, kind}],   // turnarounds + maintenance
        utilization: {weeklyHours, ratioForecast},
        rationale: string[]
    }],
    routeCreations: [{
        hub, dest, distanceKm,
        proposedTypeIds: number[],     // suitable aircraft types
        proposedFrequency: number,     // weekly flights
        proposedPricePct: number,
        proposedServiceProfileId: number,
        rationale: string[]
    }],
    serviceMoves: [{profileId, changes, predictedOrsDelta, rationale}],
    priceMoves:   [{hub, dest, classKey, fromPct, toPct, rationale}],
    crewMoves:    [{skillLabel, action: "hire"|"train", amount, rationale}],
    summary: {
        addedLegs, removedLegs, repricedRoutes, profileChanges,
        crewHires, predictedWeeklyProfit, predictedOrsAvg
    }
}
```

**Algorithm — fleet allocator:**

1. **Pre-seed** locked legs (existing in current schedule) into each aircraft's grid — never touched.
2. **Pre-seed** maintenance windows from `MaintenanceBudget` so the allocator can't fly during them.
3. **Build candidate (aircraft × route × wave-slot) tuples.** For each viable triple, compute a per-tuple score = `routeScore × aircraftFitMultiplier × waveBalanceBonus`. Filter on `range >= distance`, `crew.byTypeId[typeId].reserve >= flightsNeeded`, etc.
4. **Solve assignment.** v1: repeated-best-marginal greedy with conflict detection (one wave-slot can hold at most one leg per aircraft; one aircraft can only fly one leg per slot). v2: bipartite matching (Hungarian / auction) when candidate count is ≤ a few thousand.
5. **Rebalance** — round-robin pass that swaps the lowest-scoring placement against an unplaced higher-scoring tuple, capped at 50 iterations (matches existing `allocator.js` behavior).
6. **Predict P&L per leg** using `objective.js` math (gross − fuel − slack) plus the strategy weights' price/service modulations.

**Algorithm — route-creation proposer:**

For every (hub, dest) pair in `scoredRoutes` with `alreadyScheduled === false` and `score > settings.routeCreationThreshold`:
- Confirm the airline owns a hub at `hub` (skip if not).
- Confirm at least one type in fleet has `range >= distanceKm`.
- Compute predicted `weeklyFlights` from demand × competitor saturation.
- Pick `proposedServiceProfileId` = the cheapest profile whose `classScore.Y` clears `settings.minOrsTarget`.
- Pick `proposedPricePct` = midpoint of competitor `priceMin..priceMax` (or 100% if no competitor data).
- Stamp `rationale: ["new market", reasons...]`.

**Algorithm — price-move proposer:**

For each currently-scheduled route, compare our price to:
- Competitor `priceMin..priceMax` from `competitor` field.
- Historic 25-week trend — are we above the season's average? Below?
- ORS rank — are we top-3? If yes, we can charge a premium.

Propose a price move when `|currentPct − predictedOptimalPct| > settings.priceDeadband` (default 5 pct points). Cap moves at `settings.maxPriceMovePerWindow` (default 10 pct points per applied window) to avoid market shock.

**Algorithm — service-move proposer:**

For each profile actively used:
- Compute `currentClassScore` from `RouteAssistantServiceProfileScraper.loadDetail`.
- For each route using it, compute `predictedOrsDelta` if profile changed by ±1 step in each category.
- Rank by (profitDelta − costDelta). Surface positive-delta moves.

**Algorithm — crew-move proposer:**

For each typeId in fleet plan:
- Compute `flightsNeeded = sum(perAircraft[*].legs where typeId matches)`.
- Compare to `crew.bySkillLabel[label].active`.
- If `active < flightsNeeded × 1.1`, propose `{action: "hire", amount: ceil(flightsNeeded × 1.1) − active}`.
- If `marketAvailable < amount`, propose `action: "train"` instead.

**Files:**

- new `modules/strategy/allocate-fleet.js` (the orchestrator)
- new `modules/strategy/route-creation.js`
- new `modules/strategy/price-moves.js`
- new `modules/strategy/service-moves.js`
- new `modules/strategy/crew-moves.js`
- new `modules/strategy/scoring-primitives.js` (extracted shared math)
- modified `modules/aircraft-flight-plan/auto-scheduler/objective.js` (re-export shared math; behavior preserved)

**Reuses:**

- `auto-scheduler/allocator.js` — slot/wave grid math; lift the bipartite assignment up.
- `auto-scheduler/objective.js` — gross/fuel/slack math.
- `flight-studio/leg-spec.js` — `toFormDriverLeg`, `toBatchLegs` produce the shapes apply-batch consumes.

**Verification:**

- console: `await AesStrategy.allocateFleet(snap, scored, {})` returns a `FleetPlan` matching the type above.
- preview pane (Slice 4) renders the plan; toggling weights in settings re-renders deterministically.
- compare predicted weekly profit against `AccountingAggregator` ledger after one game-week.

---

### Slice 4 ✅ Strategy Preview UI + Apply

**Status:** shipped. Files: `modules/strategy/default-settings.js`, `modules/strategy/diff-plan.js`, `modules/strategy/apply-pipeline.js`, `modules/strategy/panel.js`, `modules/central-hub/tiles/strategy-tile.js`. Manifest-wired on dashboard + `/app/fleets*`. Tile defaults `tier: "preview-only"` + every `*Enabled` flag false — no POST happens until the user flips both the tier AND the relevant domain flag. See HANDOVER §1 "Strategy Slice 4" for the full verification matrix.

**v1 deferrals (carried into Slices 5/6/7):** service moves with empty `changes` (Slice 7 fills the per-category change set), route creation (Slice 6 ships the auto-add actuator), closed-loop learning (Slice 5), per-aircraft schedule slicing currently all-or-nothing inside the orchestrator (each aircraft is a separate decision-id; selecting only some tails works at the strategy layer but the orchestrator aborts the whole batch if AFP tier-gate is dormant — flagged in `report.aborted`).

**Goal (original spec):** dashboard tile + per-aircraft inline panel that shows the proposed plan, lets the user inspect rationale per decision, and applies via the existing actuators with explicit confirm.

**UI surfaces:**

1. **Dashboard tile (`modules/central-hub/tiles/strategy-tile.js`)** — summary card with predicted weekly profit, plan freshness, "Open strategy" button.
2. **Strategy modal (`modules/strategy/panel.js`)** — full-screen overlay with three columns:
   - **Plan** — accordion of per-aircraft schedules (Slice 3 output).
   - **Diff** — added/removed legs, repriced routes, profile changes, crew moves, with a numerical summary.
   - **Decisions** — flat scrollable list of every decision with rationale; user can tick/untick individual decisions to slice the plan.
3. **Per-aircraft inline panel** (on `/app/fleets/aircraft/<id>/0`) — same modal, scoped to that one tail; reuses Studio's slot.

**Apply pipeline:**

```js
async function apply(plan, opts) {
    const audit = []
    const tier = await _readTier()
    if (tier === "preview-only") throw new Error("apply blocked by tier")

    // 1. Schedules — reuse fleet-apply-orchestrator
    const scheduleRuns = plan.perAircraft.map(a => ({
        aircraftId: a.aircraftId,
        legs:       a.legs,
        hub:        a.legs[0]?.origin
    }))
    const schedRep = await window.AesAfpFleetApplyOrchestrator.start({
        runs: scheduleRuns, ctx, source: "aesStrategy"
    })
    audit.push({kind: "schedule", report: schedRep})

    // 2. Service profile changes
    for (const move of plan.serviceMoves) {
        const r = await window.RouteAssistantServiceProfileApplier
            .apply(move.profileId, move.changes, {applyEnabled: true})
        audit.push({kind: "service", move, result: r})
    }

    // 3. Price moves
    for (const move of plan.priceMoves) {
        const r = await window.CentralInventoryQuickPriceApplier.apply({
            hub: move.hub, dest: move.dest, classKey: move.classKey,
            newPrice: move.toPct, server: plan.server, dryRun: false
        })
        audit.push({kind: "price", move, result: r})
    }

    // 4. Crew moves
    for (const move of plan.crewMoves) {
        const r = await window.CrewMgmtStaffPilotsApplier.hireOrTrain({
            server: plan.server, skillId: move.skillId,
            amount: move.amount, mode: move.action
        })
        audit.push({kind: "crew", move, result: r})
    }

    // 5. Persist for Slice 5 to learn from
    await _persistAudit({planId: plan.planId, audit})
    await _persistApplied(plan)
    return audit
}
```

**Settings additions to `RouteAssistantSettings`:**

```
strategy: {
    tier:                     "preview-only" | "apply-on-confirm" | "apply-auto",
    riskProfile:              "conservative" | "balanced" | "aggressive",
    weights:                  Weights | null,           // null = use defaults
    crossAirlineEnabled:      false,
    routeCreationEnabled:     false,
    priceMovesEnabled:        false,
    serviceMovesEnabled:      false,
    crewMovesEnabled:         false,
    minOrsTarget:             0.7,
    routeCreationThreshold:   0.6,
    priceDeadband:            5,
    maxPriceMovePerWindow:    10,
    horizonDays:              7,
    learningStepSize:         0.05,
    learningEnabled:          false
}
```

**Safety:**

- The form-driver invariant holds. Strategy never POSTs directly. It calls existing actuators that already gate.
- Each individual sub-pipeline has its own gate (`apply-on-confirm` for schedules, `applyEnabled` for service profiles). Strategy's `tier === "preview-only"` short-circuits all of them.
- The user can untick any individual decision in the Decisions column before applying.

**Verification:**

- Apply on a single test aircraft; audit log + AS schedule reflect the plan.
- Tier set to `preview-only` blocks even when user clicks Apply.
- Network tab: zero AS POSTs on `preview-only`; expected POSTs on `apply-on-confirm`.

---

### Slice 5 ✅ Closed-Loop Learning

**Status:** shipped. Files: `modules/strategy/outcomes.js`, `modules/strategy/learn.js` + wiring into `apply-pipeline.js`, `panel.js`, `central-hub/tiles/strategy-tile.js`. Manifest-wired on dashboard + `/app/fleets*`. See HANDOVER §1 "Strategy Slice 5" for the full feature/verification matrix.

**v1 deferrals (carried into Slice 15 / 17):** the gradient estimator uses `weeklyResult` delta as the sole reward signal — per-route P&L attribution + ORS delta + load-factor delta layers ship in Slice 15's backtesting harness; Slice 17 risk profiles will set step-size + cohort filters per profile.

**Goal (original spec):** the engine measures itself and self-tunes its weights.

**Mechanism:**

After every applied plan, the engine snapshots `before`. After ≥ 1 game-week (configurable), the engine snapshots `after`. The delta is attributed to the plan: profit delta, ORS delta, load-factor delta, per-route P&L delta.

```js
async function learn(opts) {
    const outcomes = await _loadOutcomes()
    if (outcomes.length < 5) return {newWeights: null, reason: "insufficient-data"}

    const weights = await _loadWeights()
    const grad = _estimateGradient(outcomes, weights)
    const step = (opts && opts.stepSize) || 0.05

    const newWeights = {}
    for (const k of Object.keys(weights)) {
        const g = grad[k] || 0
        newWeights[k] = _clamp(weights[k] + step * g, 0, 2)
    }
    await _saveWeights(newWeights, {reason: "auto-learn"})
    return {newWeights, oldWeights: weights, gradient: grad}
}
```

`_estimateGradient` uses a finite-difference approximation: for each weight, partition outcomes into "above-median" and "below-median" applies and compute the profit delta between the two. Positive delta when weight was higher → positive gradient.

**User controls:**

- "Reset weights" button — restores defaults, archives current weights.
- Step-size slider (0–0.20) controls how aggressively the engine drifts.
- "Pause learning" toggle freezes weights.
- Audit history table shows every weight change with `{before, after, reason, ts}`.

**Files:**

- new `modules/strategy/learn.js`
- new `modules/strategy/outcomes.js` (the before/after snapshot recorder)

---

### Slice 6 ✅ Auto Route Creation

**Status:** shipped. Files: `modules/strategy/route-creation-applier.js` + wiring into `apply-pipeline.js` + `diff-plan.js`. Manifest-wired on dashboard + `/app/fleets*`. Aircraft selection prefers in-hub tails by wear headroom; legs spread evenly across 06:00–22:00 with a 60-min ground turn. See HANDOVER §1 "Strategy Slice 6" for the full feature/verification matrix.

**v1 deferrals (carried into Slice 6.1 / Slice 12 / Slice 16):** network-effect scoring (Slice 12 codeshare/IL bonus); slot availability check (Slice L11); wave-aware leg spread consulting user preset (Slice 6.1); auto-apply tier driving creations without a user click (Slice 16 executive briefing).

**Goal (original spec):** the engine proposes — and on opt-in, applies — brand-new routes the airline isn't yet flying. Critical because the user explicitly said: *"It should also automate the creation of the new routes."*

**Already partially scoped in Slice 3 (`route-creation.js`).** Slice 6 elevates it to a first-class workflow with:

- **Opportunity scanner** — scans all hubs the airline owns, for each hub queries `RouteAssistantDemandStore` for every airport in the same country/region, ranks unscheduled (hub, dest) pairs by `scoreRoutes` term values.
- **Feasibility check** — confirm range, crew, slot availability before proposing.
- **Network-effect scoring** — a new (hub, dest) that connects to existing routes via codeshare/IL earns bonus score (Slice 12 hooks in here).
- **Auto-application** — when `tier === "apply-auto"` AND `routeCreationEnabled === true`, the engine creates new flight numbers via the apply-batch pipeline. Each new route auto-gets a default service profile + price.

**New scrape required?** No — `DemandStore.getMany()` covers it; if a destination isn't in cache, the engine flags "scan needed" and uses `country-scraper.js` to bulk-load the country.

---

### Slice 7 ⬜ Service Profile Auto-Tuner

**Goal:** the engine proposes service-profile changes that maximize ORS-weighted profit.

**Algorithm:**

1. For each profile actively used, scrape (or read cache of) its current `classScore` per category.
2. For each category, compute `marginalOrsLift(category, +1)` — the delta in `classScore.Y` if you upgrade that one category one notch. AS publishes this in the service-profile detail page.
3. Compute `marginalCost(category, +1)` — the cost increase per pax.
4. Rank moves by `marginalOrsLift × demandLeverage − marginalCost × routeVolume`.
5. Propose top-K moves above threshold.

**Why it matters:** service profile changes are global per profile but affect every route using that profile. The current UI requires picking each category manually; the auto-tuner can batch-propose a coherent upgrade across categories.

**A/B testing layer:** when `tier === "apply-auto"`, the engine can create a second profile that's a perturbation of the current one and assign it to half the matching routes for one week to measure ORS delta empirically. Slice 5's outcomes recorder picks up the divergence.

**Files:**

- new `modules/strategy/service-tuner.js`
- extends `modules/route-assistant/service-profile-applier.js` (no breaking changes)

---

### Slice 8 ⬜ Crew Pay & Hiring Auto-Tuner

**Goal:** model the user's stated insight — *"personnel changes that might affect the ORS system by how the perception of the company changes with how much employees are payed"*.

**Mechanism:**

1. Read crew counts from `CrewMgmtStaffPilotsScraper`.
2. Read pay tiers (need a small new scraper for the pay-tier slider on the staff page; one of the very few new scrapers in this roadmap).
3. Model perception: `perceptionScore = f(payTier, marketAverage)`. Higher pay → higher perception → small but persistent ORS lift across all routes (the user's hypothesis; Slice 5's outcomes recorder will validate or reject empirically).
4. Optimize jointly with service-profile tuner: sometimes raising pay 5% buys more ORS lift per dollar than upgrading meals.

**Hiring side** is already drafted in Slice 3's `crew-moves.js`; Slice 8 adds the **pay-tier setter** as a new actuator (POST to staff page form) gated identical to other appliers.

**Files:**

- new `modules/crew-management/pay-tier-scraper.js`
- new `modules/crew-management/pay-tier-applier.js`
- new `modules/strategy/crew-tuner.js`

---

### Slice 9 ⬜ Inventory Pricing Auto-Tuner

**Goal:** dynamic pricing across the network. User said: *"the demand and therefore price is considered along with the competitors."*

**Already partially scoped in Slice 3 (`price-moves.js`).** Slice 9 elevates with:

- **Per-class price decisions** (Y / C / F / Cargo separately).
- **Time-decay model** on competitor history: more weight to recent weeks.
- **Yield-curve fitting:** for each route the engine maintains a record of `(pricePct, observedLF, observedYield)` tuples. Fits a logistic curve to estimate the LF-vs-price elasticity. Sets `priceOptimal` at the elasticity midpoint.
- **Defensive price cap** — never move price by more than `maxPriceMovePerWindow` AND never below `marginalCostFloor` (cost-per-seat from accounting × 1.05).

**Cargo asymmetry:** cargo prices respond to different signals (capacity utilization, sister cargo prices, regional cargo demand index). Cargo pricing gets its own module.

**Files:**

- new `modules/strategy/pricing-engine.js`
- new `modules/strategy/elasticity-fit.js`
- extends `modules/inventory/quick-price-applier.js` (batch mode for bulk applies)

---

### Slice 10 ⬜ Competitor Response Engine

**Goal:** the user said *"the competitors who are present or not present to define the strategy"* and *"dynamic positioning of the various companies"*. Slice 10 adds **active reaction** to competitor moves.

**Mechanism:**

1. Diff `markets-page-scraper`'s `historic` family week-over-week. Detect:
   - New entrant on a route we own → defensive price move (typically lower).
   - Competitor exit → opportunistic price move (raise).
   - Capacity expansion by rival → add frequency or upgrade aircraft type.
2. Diff `enterprise-meta-scraper` per-rival week-over-week. Detect:
   - Rival opens a new hub → flag potential network threat.
   - Rival joins an alliance → flag IL impact.
3. Generate `CompetitorResponse` decisions, each tagged with the diff that triggered it.

**Anti-spiral guardrail:** when a competitor and our airline both run engines, two reactive auto-pricers can spiral prices to zero. Slice 10 adds a **price-floor** at `marginalCost × 1.05` and a **frequency-doubling cooldown** (max 1 frequency increase per route per 2 weeks).

**Files:**

- new `modules/strategy/competitor-response.js`
- new `modules/strategy/diff-engine.js` (compares week-over-week competitor snapshots)

---

### Slice 11 ⬜ Cross-Airline / Sister Coordination

**Goal:** the user said *"the dynamic positioning of the various companies that hopefully will be integrated into the rest of the management of these different companies in the same game world"*.

**Mechanism:**

1. Extend `snapshot()` to load every owned airline on a server (not just the current one) using `sister-scraper.js` and per-airline `topRoutes` snapshots.
2. Extend `allocateFleet()` to reason about the **whole portfolio**:
   - Lease aircraft between sisters when one has demand-rich hubs and the other has spare tails.
   - Coordinate hub assignments — sister A focuses on long-haul, sister B regional, no overlap.
   - Joint pricing on overlapping routes — undercut competitors, not each other.
3. **Codeshare proposals** between sisters (Slice 12 covers this in depth).

**Settings:**

- `crossAirlineEnabled: true` (off by default).
- `coordinatedHubs: ["sister-A:HUB1", "sister-B:HUB2"]` — opt-in declaration of which hubs each sister owns.

**Files:**

- new `modules/strategy/portfolio.js`
- extends `modules/strategy/context.js` to include all sisters

---

### Slice 12 ⬜ Alliance & IL Codeshare Optimization

**Goal:** maximize feed traffic via interline / alliance partnerships.

**Mechanism:**

1. Read alliance membership from `airport-overview-scraper` and `enterprise-meta-scraper`.
2. For each alliance partner, model their route footprint (`AesCompetitorEnterpriseScraper.scrape().routeFootprint`).
3. Compute connectivity bonus: a route from `HUB → DEST` that connects to a partner's `DEST → THIRD` earns extra score (incremental pax via codeshare).
4. Propose **partner upgrades**: which non-allied airlines are best candidates for a new IL agreement. Score by `connectivityBonus × routeOverlapInverse`.

**Constraints:**

- IL agreements are POST-able via AS but require both parties to accept; engine can't unilaterally form. So Slice 12 surfaces *recommendations* with one-click "Send IL request" that fills the form.
- Alliance dynamics shift weekly; the engine refreshes recommendations on every learn cycle.

**Files:**

- new `modules/strategy/alliance.js`
- new `modules/alliance/il-request-applier.js` (one-click form filler, gated identical to other appliers)

---

### Slice 13 ⬜ Fleet Renewal Planner

**Goal:** decide which aircraft to lease, buy, retire, or convert.

**Mechanism:**

1. Read fleet from `AesFleetRoster`; for each tail compute lifetime profit and remaining useful years (age + condition + wear-model equilibrium).
2. Read used-aircraft market from `used-aircraft-scanner`.
3. Read sister sheet from `accounting/sister-scraper.js` (leasing tab) for current lease portfolio.
4. Compute per-type fit: which type maximizes margin on the airline's network.
5. Propose:
   - **Retire** — tails with negative-lifetime-profit and high maintenance forecast.
   - **Acquire** — N units of type X to fill predicted demand growth.
   - **Convert** — pax → cargo if cargo demand outpaces pax on the network.

**Files:**

- new `modules/strategy/fleet-renewal.js`
- reuses `used-aircraft-scanner/deal-metrics.js` for market reads

---

### Slice 14 ⬜ Hub Network Designer

**Goal:** decide where to open or close hubs. Highest-stakes decision in the game; the engine here is **advisory only** — never auto-applies hub moves.

**Mechanism:**

1. Compute hub fitness per candidate: demand catchment, competitor saturation, slot availability, runway compatibility with fleet types.
2. Compute hub redundancy: are existing hubs serving overlapping markets?
3. Propose:
   - **Open** — top-N candidate hubs with > threshold fitness.
   - **Close** — existing hubs with < threshold fitness AND > 2 weeks negative profit.
4. Network-effect score across the proposed hub graph (do new hubs synergize with existing routes?).

**Files:**

- new `modules/strategy/hub-designer.js`
- new `modules/strategy/network-graph.js`

---

### Slice 15 ⬜ Backtesting Harness

**Goal:** validate the engine against history before letting it touch the future.

**Mechanism:**

1. Replay historical `AccountingSnapshotStore` weeks one by one.
2. For each week, reconstruct the synthetic snapshot the engine would have seen.
3. Run `scoreRoutes`, `allocateFleet`, etc. with current weights.
4. Compare engine's hypothetical decisions against what actually happened in storage (price history, schedule changes).
5. Report cumulative profit delta vs. actual.

**UI:** a "Backtest" button in the strategy tile that runs across the last 12 weeks and shows a chart: *"engine would have made $X more / less than what actually happened"*.

**Files:**

- new `modules/strategy/backtest.js`
- new `modules/strategy/synthetic-snapshot.js`

---

### Slice 16 ✅ Executive Briefing UI — shipped

**Goal:** every game-week, present the user a one-page summary of:

- **What the engine did** (decisions applied since last briefing).
- **What it observed** (profit / ORS / LF deltas).
- **What it learned** (weights moved how much, why).
- **What it recommends next** (top-3 next-week moves).
- **What it's worried about** (risk flags: cash runway, wear stress, competitor pressure).

**Format:** a modal that opens automatically on first dashboard visit each game-week, dismissible, archivable. Long-form rationale per decision.

**Files (shipped):**

- `modules/strategy/briefing.js` — `AesStrategyBriefing.buildBriefing(opts)` returns a `BriefingReport` (`applied[≤3]`, `drifted`, `opportunities[≤2]`, `risk`). Pure read-only synthesis over `AesChangeLogAggregator`, `AesStrategyOutcomes`, `AesStrategyJournal`, `AesStrategyLearn`, `AccountingProjector`, and a freshly composed `snapshot → diffPlan`. Returns `autoOpenBucketId` (real `accounting:weekId` or `"synth-<floor(ts/7d)>"` fallback) for the tile's once-per-week guard.
- `modules/central-hub/tiles/strategy-briefing-tile.js` — `CentralHubStrategyBriefingTile` (`section: "operations"`, `priority: 0`). Renders the 4-card grid (Applied / Drifted / Opportunities / Risk), and a full modal with long-form rationale, structured-fields per applied decision, and source-envelope `<details>` JSON. Auto-opens once per `autoOpenBucketId`; "Mark as read" writes `aesStrategy:lastSeenAt[:acct:<id>]` to narrow the next briefing window. Settings kill switch `settings.strategy.briefing.briefingAutoOpen === false`.

See `HANDOVER.md §1 "Strategy Slice 16 — Executive Briefing UI"` for full details.

---

### Slice 17 ✅ Risk Profiles + User Tuning — shipped

**Goal:** preset weight bundles plus a tuning UI.

**Profiles (shipped):**

- **Conservative** — `cashPenalty: 0.50`, `maintenancePenalty: 0.40`, `profitWeight: 0.50`; `maxPriceMovePerWindow: 5`, `priceDeadband: 7`, `routeCreationThreshold: 0.75`, `learningStepSize: 0.02`.
- **Balanced** — `DEFAULT_WEIGHTS` values + default thresholds.
- **Aggressive** — `cashPenalty: 0.15`, `maintenancePenalty: 0.20`, `demandWeight: 0.30`, `competitorWeight: 0.30`; `maxPriceMovePerWindow: 15`, `priceDeadband: 3`, `routeCreationThreshold: 0.45`, `learningStepSize: 0.10`.

**Safety contract:** profiles ONLY touch scoring weights + threshold numerics. They never flip `settings.tier` or any per-domain enable flag — picking "Aggressive" tunes the *recommendations* aggressively but the user still opts in to applies via the existing two-gate model (§4.1 / §4.18).

UI: three radio buttons (with a fourth "Custom" appearing when the user diverges from a profile) above the existing Strategy modal Overlap card; an "Advanced — individual weights & thresholds" expander (collapsed by default) surfacing all 10 `DEFAULT_WEIGHTS` keys + 4 top-level thresholds as sliders. Manual slider drag flips the active profile to "Custom"; "Reset to balanced" returns to defaults.

**Files (shipped):**

- `modules/strategy/risk-profiles.js` — pure `AesStrategyRiskProfiles` with `PROFILES` / `names()` / `apply(name, settings) → patch` / `detect(settings) → name|"custom"` / `describe(name) → {label, blurb}`.
- `modules/strategy/tuning-panel.js` — `AesStrategyTuningPanel.render(host, {settings, onChange}) → teardown`. Persists through `AesStrategySettings.save(patch)`; fires `onChange(newSettings)` so the caller can re-score.
- `modules/strategy/panel.js` — wires the tuning host between Settings strip and Overlap card; passes the panel's `_refresh` as onChange so weight changes immediately re-score.

See `HANDOVER.md §1 "Strategy Slice 17 — Risk Profiles + User Tuning"` for full details.

---

### Slice 18 ⬜ Multi-Game-World Federation

**Goal:** one user can play multiple AirlineSim game worlds. The engine should treat each world as a sandboxed `Snapshot`, never mix data across worlds, but offer a **portfolio view** across worlds.

**Mechanism:**

1. Snapshot is already keyed by `server`; just expand the dashboard tile to iterate every server with cached data.
2. New `aesStrategy:portfolio` view aggregates across servers: which world is most profitable, which has the best growth trajectory, where to invest free cash next.

**Files:**

- new `modules/strategy/portfolio-multi-world.js`
- extends `modules/central-hub/tiles/strategy-tile.js`

---

### Slice 19 ⬜ Marketing & Brand Investment

**Goal:** if AS exposes marketing budgets (it does, per region), the engine optimizes spend.

**Mechanism:**

1. Scrape current marketing budget per region (new scraper).
2. Model elasticity: marketing $ → demand bar lift over 4 weeks.
3. Allocate budget to regions where engine's other moves are constrained by demand (not capacity / not price / not service).
4. Propose budget changes; Slice 4's apply pipeline executes them.

**Files:**

- new `modules/marketing/budget-scraper.js`
- new `modules/marketing/budget-applier.js`
- new `modules/strategy/marketing-tuner.js`

---

### Slice 20 ⬜ Slot & Gate Trading

**Goal:** AS sometimes has scarce slots at congested airports. The engine watches for slot availability and bids opportunistically.

**Mechanism:**

1. Scrape slot pages periodically (new scraper).
2. Score available slots by `routeScore × hubProximity`.
3. Auto-bid up to a user-set max per slot; gated like all other appliers.

**Files:**

- new `modules/slots/slot-scraper.js`
- new `modules/slots/slot-bidder.js`

---

### Slices 21–32 — Expansion ideas

A second wave of slices, captured from a brainstorm round. These extend the engine beyond "rank + apply" into *exploration*, *risk*, *autonomy*, *memory*, and *new interaction surfaces*. Numbering continues from Slice 20; each entry follows the same Goal / Mechanism / Files shape so it can be picked up independently.

A few brainstorm items map onto existing slices rather than new ones — recorded here so they're not lost:

| Brainstorm idea | Folds into |
|---|---|
| Counterfactual replay ("what if I'd opened this 3 weeks ago") | Slice 15 (Backtesting Harness) |
| Hub-of-hubs optimizer | Slice 14 (Hub Network Designer) |
| Route swap suggestions | Slice 3 (Fleet Co-Allocator) |
| Alliance & codeshare dashboard | Slice 12 (Alliance & IL Optimization) |
| Boardroom / annual-report PDF export | Slice 16 (Executive Briefing UI) |
| Cross-game-world strategy memory | Slice 18 (Multi-Game-World Federation) |
| Auto-pilot "shadow CEO" weekly batch + rollback checkpoints | Slice 4 (Apply pipeline, new tier) |

---

### Slice 21 ⬜ Scenario Forks (what-if branches)

**Goal:** let the user fork the current `Snapshot` into named hypothetical worlds ("buy 5× A350", "exit South America", "open BOM hub"), run the scoring + allocator forward N weeks against each fork, and present a side-by-side P&L tree. Decision board on top of the existing engine.

**Mechanism:**

1. `AesStrategy.forkSnapshot(snapshot, mutations[])` — applies a list of declarative diffs (add tail, remove route, change weight) into a copy without mutating the original.
2. `AesStrategy.simulateForward(fork, weeks)` — re-uses Slice 5's predicted-vs-observed model in *predict* mode, no observation loop.
3. New `ScenarioStore` (capped at ~12 named forks, 50 KB each) persists user-saved scenarios so they survive reloads.
4. UI: a "Scenarios" tab in the executive briefing that shows the fork tree with terminal-node P&L and a click-to-diff against baseline.

**Files:**

- new `modules/strategy/scenarios.js`
- new `modules/strategy/scenario-store.js`
- new `modules/strategy/scenarios-tab.js`

---

### Slice 22 ⬜ Probabilistic Demand & Risk Fans

**Goal:** replace point estimates of paxLF / yield / cargoLF with sampled distributions drawn from the per-route observation history, so every $/wk number ships with a P10/P50/P90 fan. Enables honest risk talk: "Loss-makers" chip can become "P10 negative", "Override" can become "tighten σ on this row".

**Mechanism:**

1. `RouteAssistantYieldFeedbackStore` already accumulates per-route observation residuals — fit a per-route empirical distribution (or normal with shrinkage when n < 10).
2. New `AesStrategy.sample(snapshot, {iters: 1000})` — Monte Carlo over the snapshot, returns per-route quantiles.
3. Score blends gain a **risk-aversion** term `λ × σ($/wk)` so the engine can be pushed conservative or aggressive via a single slider.
4. RA table: hover a $/wk cell → mini-violin sparkline.

**Files:**

- new `modules/strategy/probabilistic.js`
- extends `modules/route-assistant/yield-feedback-store.js`
- extends `modules/route-assistant/panel.js` (cell hover)

---

### Slice 23 ⬜ Goal-Seeker

**Goal:** user states a goal in plain terms ("reach $500M cash by week 80 without touching SE Asia", "double my widebody fleet utilisation"), and the engine searches the decision space for plan bundles that satisfy it.

**Mechanism:**

1. Goal grammar: `{metric, op, target, deadline, constraints[]}`. Surface as a guided form, not free text.
2. Search: beam-search over Slice 4 plan bundles, evaluating each terminal state with Slice 21's forward simulator.
3. Returns the top-K bundles ranked by feasibility × expected slack.
4. Output renders into the existing Slice 4 preview UI — the goal-seeker is a *generator* of plans, not a new applier.

**Files:**

- new `modules/strategy/goal-seeker.js`
- new `modules/strategy/goal-form.js`

---

### Slice 24 ⬜ Standing Orders Rule Engine

**Goal:** a first-class home for declarative ongoing rules — "if any 2-class widebody drops below 60% LF for 2 weeks, downgauge or kill"; "auto-reprice any route with >25% yield variance for 7 days"; "forbid opening any route within 800 km of an incumbent ≥3 carriers". The Q+ alerts foundation already exists; this elevates rules from notify-only to *actionable* with engine integration.

**Mechanism:**

1. Rule schema: `{when, where, threshold, hold-for, action, requireConfirm}`.
2. Evaluator runs after every snapshot refresh; matched rules emit decisions into the same Slice 4 plan stream as the engine's own proposals (sourced "rule:<id>" so the audit trail distinguishes them).
3. New "Standing Orders" drawer in the executive briefing — list, enable/disable, edit, last-fired log.
4. Composes with risk profiles (Slice 17): a profile can ship a default rule pack.

**Files:**

- new `modules/strategy/standing-orders.js`
- new `modules/strategy/standing-orders-store.js`
- new `modules/strategy/standing-orders-panel.js`

---

### Slice 25 ⬜ Network Graph & Time-Scrubber View

**Goal:** a force-directed full-network visualisation — nodes = airports sized by $/wk, edges = routes thickened by frequency, coloured by LF — with a time-scrubber along the top that re-renders every panel against any prior snapshot. Strategic comprehension at a glance.

**Mechanism:**

1. Network graph: D3-force in a Shadow DOM panel; data sourced from `Snapshot`. Node click → drill into RA panel filtered to that hub.
2. Time-scrubber: `AccountingSnapshotStore` already stores periodic snapshots; expose a hub-level scrubber that broadcasts a "view-time" through the bus, and have RA / wave overlay / dashboard tiles subscribe and re-render against the scrubbed snapshot.
3. Diff badges become always-on: every cell shows ▲▼ vs the scrubbed reference time.

**Files:**

- new `modules/strategy/network-graph.js`
- new `modules/strategy/time-scrubber.js`
- extends `modules/strategy/message-bus.js` (new `view-time` channel)

---

### Slice 26 — Strategy Journal & Lessons Mining (Phase 1 ✅; Phases 2/3 ⬜)

**Goal:** auto-log every override, opening, pricing change, and rule fire, with the user's typed reason if any. After a few months of play, mine the journal for patterns: "of your 14 CDG openings, the 5 that died early all had >3 incumbents AND distance <800 km — flagging this candidate."

**Phase 1 ✅ (this session):** `journal-store.js` + `journal-panel.js` shipped — single per-account ring `aesStrategy:journal:acct:<id>` (cap 750), hybrid passive/active subscriber, panel section at the bottom of the strategy modal with click-to-edit reason cells. Five action types: `override-save`, `note-save`, `watchlist-toggle`, `apply-decision`, `weight-change`. Phase 2 + 3 reserve `outcomeRef`, `tags`, `voiceMemoId` slots so they don't migrate.

**Phase 2 ⬜ — Lesson miner.** `modules/strategy/lesson-miner.js` reads `journal × outcomes` joined via `outcomeRef`, clusters by route attributes (incumbent count, distance band, hub, equipment family), correlates with "alive at +8 weeks" outcome bit, surfaces top patterns as `strategy:lesson-mined` events for the executive briefing.

**Phase 3 ⬜ — Voice memos.** Browser MediaRecorder + Web Speech API; entry's reserved `voiceMemoId` slot points to a separate `aesStrategy:journal:voice:<id>` keyed blob (kept out of the entry to avoid bloating the ring).

**Files:**

- ✅ `modules/strategy/journal-store.js`
- ✅ `modules/strategy/journal-panel.js`
- ⬜ `modules/strategy/lesson-miner.js`

---

### Slice 27 ⬜ Markets Gossip Feed

**Goal:** a chronological "anomaly events" feed across the whole airline — incumbent drops 30% price on FRA-GRU, new entrant on JFK-LHR, hub gets a slot expansion announcement, sister airline opens a route into your territory. Feeds into Slice 24 rules and Slice 16 briefing.

**Mechanism:**

1. Anomaly detectors run on each scrape:
   - markets pricing diff > Nσ
   - new carrier appears in flightsfrom data for a route you fly
   - own LF drop > Nσ over 2 weeks
   - sister airline mutation (covered already, surface here)
2. Events flow into a `GossipStore` (capped, TTL'd).
3. Notification center wiring (already exists) gets a "gossip" channel; the executive briefing shows the last 20.

**Files:**

- new `modules/strategy/gossip-detectors.js`
- new `modules/strategy/gossip-store.js`
- extends `modules/route-assistant/notification-center.js`

---

### Slice 28 ⬜ Local LLM Co-Pilot (no API keys)

**Goal:** a chat affordance that can read the snapshot + journal + recent gossip and answer in natural language ("explain why JFK-EZE dropped to UNDER", "draft a message to Alliance partner X about codesharing on AMS-DXB"). Runs in-browser via WebLLM/WebGPU or via a local Ollama endpoint — no cloud, no keys, no costs.

**Mechanism:**

1. Pluggable backend: `WebLLMBackend` (in-tab WebGPU) and `OllamaBackend` (POST to `http://localhost:11434`); user picks in settings.
2. Tool-use is *snapshot-bounded* — the LLM can only call read functions that already exist on the strategy namespace; never POSTs to AS.
3. The chat surface is anchored next to the executive briefing and prefilled with context (current hub, current selection).
4. Privacy invariant: nothing leaves the machine.

**Files:**

- new `modules/strategy/copilot/index.js`
- new `modules/strategy/copilot/webllm-backend.js`
- new `modules/strategy/copilot/ollama-backend.js`
- new `modules/strategy/copilot/chat-panel.js`

---

### Slice 29 ⬜ Command Palette & Spatial Pinboard

**Goal:** a unified Cmd-K command palette over every action across the extension (open hub, jump to route, toggle filter, fire rule), and a freeform spatial pinboard where the user can rip rows out of the RA table, group them, draw arrows, attach notes. Treats strategic thinking as a canvas, not a table.

**Mechanism:**

1. Palette: a registry pattern — each module registers `{id, title, group, run()}` at load time. Cmd-K opens a fuzzy-match list. The 50+ existing features become discoverable in one keystroke.
2. Pinboard: an HTML canvas-style surface (DOM + transforms, no canvas) where pinned items are live React-style cards bound to their source row — cell values stay live as scrapes update.

**Files:**

- new `modules/ux/command-palette.js`
- new `modules/ux/command-registry.js`
- new `modules/ux/pinboard.js`
- new `modules/ux/pinboard-store.js`

---

### Slice 30 ⬜ Public Read-Only API

**Goal:** expose the snapshot + journal over a localhost HTTP endpoint so the user (or their Discord bot, their dashboards, their own scripts) can pull cached state without touching AS.

**Mechanism:**

1. A native messaging host (or a tiny localhost server packaged as an optional companion binary) reads from `chrome.storage.local` via the extension and serves JSON.
2. Endpoints: `GET /snapshot`, `GET /journal?since=…`, `GET /scenarios`. Read-only; no apply.
3. Auth: a per-install token in settings; required header. No CORS to keep it scriptable.

**Files:**

- new `modules/strategy/api-bridge.js`
- new `companion/server.go` (or `.py` — small enough to ship both)
- docs page

---

### Slice 31 ⬜ Real-World Reality Check Overlay

**Goal:** pull real-world O&D estimates / route-launch news (anonymized, batched, low-frequency) and overlay them on the RA panel so the user can sanity-check AS demand against reality. "AS says JFK-EZE is OVER but the real-world market grew 18% YoY — maybe hold."

**Mechanism:**

1. Source: a small open dataset bundled in the extension (refreshed via update channel), keyed by IATA pair. No live fetches in v1 to keep it dependency-free.
2. New "Reality" column group in RA: `realDemandBand`, `realYoY`, `recentLaunches`.
3. Score blend gains an optional "reality alignment" term (off by default).

**Files:**

- new `modules/route-assistant/reality-store.js`
- bundled `data/real-world-od.json`
- extends `modules/route-assistant/panel.js` (column group)

---

### Slice 32 ⬜ Scenario Puzzle Mode

**Goal:** the engine generates synthetic frozen worlds with a stated goal ("reach $50M cash in 12 simulated weeks given this fleet, hub, and competitor field"), and the user solves them as practice — score, leaderboard (local), shareable seeds. Turns the strategy engine into a learnable craft.

**Mechanism:**

1. Scenario generator parameterises hub, fleet, competitor density, demand profile, starting cash; serialises to a single shareable seed string.
2. Plays inside a fully sandboxed `Snapshot` — no AS POSTs reachable from inside puzzle mode; Slice 21's simulator drives weekly tick.
3. Scoring: time-to-goal, cash slack, decisions-used. Local leaderboard; export-to-clipboard for sharing.

**Files:**

- new `modules/strategy/puzzle/generator.js`
- new `modules/strategy/puzzle/runner.js`
- new `modules/strategy/puzzle/panel.js`

---

## Part IV — Cross-cutting concerns

### Settings model

All strategy settings live under `settings.strategy` in the existing `RouteAssistantSettings` blob (via `RouteAssistantSettings.save({strategy: {...}})`). Read with `RouteAssistantSettings.load()`. Defaults shipped in `modules/strategy/default-settings.js`. Migration: on first load of the strategy module, if `settings.strategy` is undefined, write defaults; never overwrite user values.

### Audit logging

Every applied decision lands in `aesStrategy:audit` with full context: decision, inputs (snapshot hash + relevant signals), outputs (apply pipeline result), timestamp, planId. Ring-buffered at 500 entries. Surfaced in the strategy modal's "History" tab.

Reuses `auto-apply-log.js` shape so the existing AFP audit UI can render strategy entries side-by-side with manual auto-scheduler entries.

### Telemetry & diagnostics

A `aesStrategy:diag` lightweight ring buffer (50 entries) captures:
- snapshot generation duration
- per-slice CPU time
- store-miss counts (which signals were missing for each plan)
- apply pipeline error fingerprints

Toggleable on/off in settings. **Never sent off-machine.** Pure in-browser diagnostics.

### Performance budget

| Operation | Target |
|---|---|
| `snapshot()` cold | < 500 ms on dashboard with 50 aircraft, 200 routes |
| `snapshot()` warm (storage cached) | < 100 ms |
| `scoreRoutes()` | < 50 ms for 500 routes |
| `allocateFleet()` | < 2 s for 50 aircraft × 200 routes |
| Strategy modal open | < 300 ms first paint |

If exceeded, the engine surfaces a slow-warning badge and falls back to background `requestIdleCallback` chunks.

### Storage budget

Strategy namespace soft-cap 1 MB, hard-cap 2 MB. Eviction order on hit: oldest `learn:outcomes` → oldest `audit` → oldest `journal` → oldest `learn:weights:history` → oldest `backtest:results`. Never evicts `settings`, `weights:current`, or `plan:applied`.

### Multi-tab race conditions

- `plan:applied` writes are atomic via `chrome.storage.local.set`. First writer wins.
- A second tab's apply detects the conflict by checking `plan:applied.planId` matches the plan it loaded; if not, abort with notice.
- `chrome.storage.onChanged` propagates plan invalidations — if a plan applies in one tab, all tabs' strategy modals show "applied in another tab" and re-fetch.

### Privacy / scraping etiquette

- The engine NEVER scrapes more frequently than the underlying scrapers' configured cadence.
- The engine NEVER opens hidden tabs solely to scrape; only the apply pipeline opens hidden tabs (with user consent via tier).
- All cross-airline reads stay on-device. No cross-airline data leaves the user's machine.

### Safety invariants — extended

In addition to the existing form-driver invariant:

1. **Strategy never POSTs** — only routes through existing actuators.
2. **Tier gate is the SINGLE source of truth** for "may auto-apply." `tier === "preview-only"` blocks every actuator, full stop.
3. **Per-domain enable flag** is required even when tier permits. E.g. `priceMovesEnabled === false` blocks pricing applies even on `apply-auto`.
4. **Plan-diff display** — every plan shows the diff before apply. User can untick decisions.
5. **Apply atomicity** — failure on schedule apply does NOT proceed to price/service/crew applies. Batch-aborts.
6. **Undo path** — the "undo" feature applies the previous plan's inverse where possible (re-create deleted legs, restore old prices). Best-effort, not guaranteed.
7. **Cross-airline opt-in** — even when `tier === "apply-auto"`, the engine NEVER touches sister airlines unless `crossAirlineEnabled === true`.

---

## Part V — Verification strategy

### Per-slice acceptance tests

- **Slice 1**: console `await AesStrategy.snapshot({})` returns populated object with `missing[]` reflecting unloaded stores. Test on dashboard, fleet management, AFP per-aircraft pages — each should populate the relevant subset.
- **Slice 2**: `AesStrategy.scoreRoutes(snap)` returns ranked list with rationale strings; manually verify top routes match user intuition on a known fleet.
- **Slice 3**: `allocateFleet` returns a plan; per-aircraft leg counts respect maintenance windows; route-creation proposals only appear for unscheduled markets with sufficient fleet capacity.
- **Slice 4**: apply on a single test aircraft; audit log + AS schedule reflect the plan; tier `preview-only` blocks even on Apply click.
- **Slice 5**: after 2–3 game-weeks, weights drift toward higher-profit configurations; "Reset weights" button restores defaults and archives.
- **Slice 6**: route-creation proposals appear for hub-paired markets the airline isn't yet flying; auto-apply gated.
- **Slice 7**: service profile changes trigger `applier.apply()` with the correct payload; ORS deltas observable within 1 week.
- **Slice 8**: pay-tier scrape returns the slider value; pay-tier apply moves the slider; perception model is recorded as a hypothesis until learn-cycle validates.
- **Slice 9**: pricing changes log to audit; never violate `marginalCostFloor`; per-class moves run independently.
- **Slice 10**: week-over-week diff identifies new entrants; defensive price moves logged when triggered.
- **Slice 11**: portfolio view aggregates 2+ sisters' P&L; cross-airline lease proposals appear when one sister has demand and another has spare tails.
- **Slice 12**: alliance proposals rank by connectivity bonus; IL request form pre-fills with proposed partner.
- **Slice 13**: fleet renewal proposes retire candidates with negative lifetime P&L; acquire proposals match unmet demand.
- **Slice 14**: hub designer outputs candidates without auto-applying.
- **Slice 15**: backtest reports cumulative delta against last 12 weeks; chart renders.
- **Slice 16**: executive briefing modal auto-opens once per game-week; dismiss persists.
- **Slice 17**: risk profile presets re-score routes deterministically; advanced sliders update in real time.
- **Slice 18**: portfolio view across multiple servers with isolated snapshots.
- **Slice 19**: marketing budget proposals only when demand is the binding constraint.
- **Slice 20**: slot bids respect `maxBid` per slot; never auto-bids without tier permission.

### Synthetic backtest scenarios

- **Stable market** — small predictable demand, no competitor moves. Expect engine to converge on a steady plan.
- **Competitor entry shock** — new rival on a profitable route. Expect engine to match price within 2 windows.
- **Maintenance crisis** — wear ratios spike across fleet. Expect engine to reduce frequency and propose maintenance batches.
- **Cash crunch** — bank balance < 4-week runway. Expect engine to pause route creation and propose price-cuts on low-LF routes.
- **Sister rebalance** — sister A overcapacity, sister B undercapacity. Expect engine to propose lease with `crossAirlineEnabled`.

### Manual QA checklist (pre-PR)

- [ ] Every new file has a header docstring (matches existing style).
- [ ] Every public function has typed-via-jsdoc parameters.
- [ ] No `console.log` left in. `console.warn` only on actual failures.
- [ ] Manifest valid JSON (`python3 -c "import json; json.load(open('manifest.json'))"`).
- [ ] All new modules `node --check` clean.
- [ ] No new dependencies added to `package.json` (vanilla JS only).
- [ ] Skin CSS plays nicely with existing `css/skin/*.css`.
- [ ] All new strings localizable-ready (no hardcoded units in user-facing copy).
- [ ] Storage budget telemetry shows < 1 MB used on a stress-test scenario.
- [ ] Cross-tab simulator: open two AS tabs, apply in one, the other shows "applied elsewhere" notice.

---

## Part VI — Open questions

The user can clarify these via Ultraplan or directly. Plan proceeds with stated defaults if unanswered.

1. **Risk profile default** — ship as `conservative` or `balanced`?
2. **Auto-apply tier ever?** — should `apply-auto` be available, or is `apply-on-confirm` the strictest tier we ever offer?
3. **Cross-airline learning** — should sisters share learned weights, or learn independently?
4. **Backtest depth** — how many historical weeks should the engine retain for backtesting? (Current: 200 weeks via `AccountingSnapshotStore` index cap.)
5. **Marketing scrape cadence** — how aggressively to scan marketing pages? (User concern: scraping etiquette.)
6. **Hub-close decisions** — auto-applyable or strictly advisory? (Plan says strictly advisory; confirm.)
7. **Service-profile A/B testing** — auto-create perturbation profiles, or require user approval per perturbation?
8. **IL partner solicitation** — the engine recommends but the user clicks. Confirm UX.
9. **Notification surface** — Chrome desktop notifications, in-page toasts, or both?
10. **Rollback budget** — engine can undo last N applies; what's N? (Default: last 3.)

---

## Part VII — Roadmap & sequencing

### Dependency DAG

```
        Slice 1 (snapshot, ✅)
            │
            ├─→ Slice 2 (scoreRoutes, ✅)
            │       │
            │       ├─→ Slice 3 (allocateFleet)
            │       │       │
            │       │       ├─→ Slice 4 (preview UI + apply)
            │       │       │       │
            │       │       │       ├─→ Slice 5 (learn)
            │       │       │       ├─→ Slice 6 (auto route creation)
            │       │       │       ├─→ Slice 7 (service tuner)
            │       │       │       ├─→ Slice 9 (pricing tuner)
            │       │       │       ├─→ Slice 10 (competitor response)
            │       │       │       └─→ Slice 16 (executive briefing)
            │       │       │
            │       │       └─→ Slice 13 (fleet renewal)
            │       │
            │       └─→ Slice 17 (risk profiles)
            │
            └─→ Slice 11 (cross-airline) ─→ Slice 12 (alliance) ─→ Slice 18 (multi-world)
                                                                ├─→ Slice 19 (marketing)
                                                                └─→ Slice 20 (slot trading)

        Slice 8 (crew pay tuner) — depends on Slice 5
        Slice 14 (hub designer) — depends on Slice 11
        Slice 15 (backtest) — depends on Slice 5
```

### Suggested PR boundaries

- **PR-1 (foundation)**: Slices 1 + 2 + manifest wiring. Read-only, zero risk. *Already on this branch.*
- **PR-2 (allocator)**: Slice 3 + scoring-primitives extraction. Read-only. Adds preview cache key.
- **PR-3 (apply)**: Slice 4 + settings additions + audit log. **First writing PR.** Tier gate enforced.
- **PR-4 (learning)**: Slice 5 + outcomes. Background learning behind `learningEnabled`.
- **PR-5 (route + price)**: Slices 6 + 9. Major capability lift.
- **PR-6 (service + crew)**: Slices 7 + 8. Includes new pay-tier scraper/applier.
- **PR-7 (competitor response)**: Slice 10. Diff engine + reactive moves.
- **PR-8 (sisters + alliance)**: Slices 11 + 12. Cross-airline + IL.
- **PR-9 (fleet + hub)**: Slices 13 + 14. Capital decisions.
- **PR-10 (backtest + briefing)**: Slices 15 + 16. Validation + reporting layer.
- **PR-11 (risk + multi-world)**: Slices 17 + 18.
- **PR-12 (marketing + slots)**: Slices 19 + 20.

### Effort estimate

| PR | Estimated days (focused work) |
|---|---|
| PR-1 (done) | 0.5 |
| PR-2 | 2–3 |
| PR-3 | 3–4 |
| PR-4 | 2 |
| PR-5 | 4–5 |
| PR-6 | 3 |
| PR-7 | 2–3 |
| PR-8 | 4 |
| PR-9 | 3–4 |
| PR-10 | 2–3 |
| PR-11 | 1–2 |
| PR-12 | 3 |
| **Total** | **~30–40 focused days** |

Realistically across calendar with QA, game-world game-weeks needed for empirical validation: 3–6 months.

---

## Part VIII — What's already shipped on this branch

1. `modules/strategy/scoring-primitives.js` — shared math (flight-time, fuel, distance-factor, great-circle).
2. `modules/strategy/context.js` (Slice 1) — `AesStrategy.snapshot()` synthesizing every read store.
3. `modules/strategy/decide-routes.js` (Slice 2) — `AesStrategy.scoreRoutes(snapshot, weights?)` with composite scoring + rationale.
4. `modules/strategy/route-creation.js` (Slice 3 + 6) — `AesStrategy.proposeRouteCreations(snapshot, scored, opts?)`.
5. `modules/strategy/price-moves.js` (Slice 3 + 9) — `AesStrategy.proposePriceMoves(snapshot, opts?)` with deadband + max-move guardrails.
6. `modules/strategy/service-moves.js` (Slice 3 + 7) — `AesStrategy.proposeServiceMoves(snapshot, opts?)`.
7. `modules/strategy/crew-moves.js` (Slice 3 + 8) — `AesStrategy.proposeCrewMoves(snapshot, fleetPlan, opts?)`.
8. `modules/strategy/allocate-fleet.js` (Slice 3) — `AesStrategy.allocateFleet(snapshot, scoredRoutes, opts?)` returns a complete `FleetPlan` with per-aircraft greedy round-trip filler, route creations, price moves, service moves, crew moves, and a summary.
9. `modules/strategy/default-settings.js` (Slice 4) — `AesStrategySettings` store at `settings.strategy` (canopy-aware) with tier + per-domain enable flags + `canApply(s, domain)` single-source-of-truth gate.
10. `modules/strategy/diff-plan.js` (Slice 4) — `AesStrategy.diffPlan(plan, snapshot)` flattens a `FleetPlan` into a stable, deterministic decision list with applicable / advisory marks.
11. `modules/strategy/apply-pipeline.js` (Slice 4 — first writing module) — `AesStrategy.apply(plan, opts)` marshals decisions through existing actuators (`AesAfpFleetApplyOrchestrator`, `RouteAssistantServiceProfileApplier`, `RouteAssistantPricingApplier`, `CrewMgmtStaffPilotsApplier`) with tier gate + per-domain flags + audit ring at `aesStrategy:audit` (cap 500) + applied envelope at `aesStrategy:plan:applied`.
12. `modules/strategy/panel.js` (Slice 4 + 5) — `AesStrategyPanel.open()` full-screen modal with summary chips + live tier/flag controls + decision list (checkboxed, grouped by domain) + per-aircraft schedule accordion + Apply CTA wired into the pipeline; Slice 5 adds the Learning section (counters · pause toggle · step-size slider · run-cycle / capture-pending / reset-weights buttons · current-weights table · history list).
13. `modules/central-hub/tiles/strategy-tile.js` (Slice 4 + 5) — dashboard tile in Tools section with Open-modal CTA, settings strip, last-apply card from `aesStrategy:plan:applied`, inline "Quick plan preview" that hands the composed plan to the modal; Slice 5 adds the Learning summary card sourced from `aesStrategy:learn:outcomes` + `aesStrategy:learn:weights:current`.
14. `modules/strategy/outcomes.js` (Slice 5) — `AesStrategyOutcomes` ring at `aesStrategy:learn:outcomes` (cap 100) with `record()` / `tryCaptureAfter()` / `loadAll()` / `countReady()` / `measure()` / `clear()`. Pure `measure(snapshot, plan?)` extracts `{ts, cashBalance, weeklyResult, fleetCount, legCount, orsAvgY, perRouteCount, paxLfMean, predictedWeeklyProfit?, predictedOrsAvg?}` so storage cost stays bounded.
15. `modules/strategy/learn.js` (Slice 5) — `AesStrategyLearn` finite-difference learner over attributed outcomes; `aesStrategy:learn:weights:current` (override or null=defaults) + `aesStrategy:learn:weights:history` (cap 52). API: `getCurrentWeights()` / `setCurrentWeights(w, reason)` / `resetWeights()` / `getHistory()` / `learn({stepSize?, minSamples?, force?})`. Gates on `settings.learningEnabled` (force-override via `opts.force` for the modal's manual run-cycle button).
16. `modules/strategy/route-creation-applier.js` (Slice 6) — `AesStrategyRouteCreationApplier.apply(creation, snapshot, opts)` picks an aircraft (in-hub priority, wear-headroom sorted, fallback any-of-type), builds N round-trip leg pairs spread across 06:00–22:00 with 60-min ground turn, dispatches through `AesAfpFleetApplyOrchestrator`. Pure helpers (`pickAircraft`, `buildLegs`, `_spreadDepHours`, `_formatHHMM`) exposed for ?aes-debug smoke + future tests.
17. `manifest.json` — every strategy module wired into dashboard + `/app/fleets*` content-script blocks; strategy-tile registered on dashboard only.

Items 1-8 are **read-only**. Items 9-13 (Slice 4) introduce the first writing path; items 14-15 (Slice 5) add closed-loop learning storage (3 new keys, all under the `aesStrategy:learn:*` budget); item 16 (Slice 6) wires auto route creation through the existing fleet-apply orchestrator. The tier gate defaults to `preview-only` so installs are still 100% advisory until the user flips it; the learning gate (`learningEnabled`) defaults to `false` so outcomes only start recording when the user opts in; `routeCreationEnabled` defaults to `false` so the new-route applier never fires unless explicitly turned on.

---

## Part IX — Files inventory

### Files added (whole roadmap)

```
modules/strategy/
├── context.js                  ← Slice 1 ✅
├── decide-routes.js            ← Slice 2 ✅
├── scoring-primitives.js       ← Slice 3 (extracted)
├── allocate-fleet.js           ← Slice 3
├── route-creation.js           ← Slice 3 / 6
├── price-moves.js              ← Slice 3 / 9
├── service-moves.js            ← Slice 3 / 7
├── crew-moves.js               ← Slice 3 / 8
├── panel.js                    ← Slice 4
├── learn.js                    ← Slice 5
├── outcomes.js                 ← Slice 5
├── service-tuner.js            ← Slice 7
├── crew-tuner.js               ← Slice 8
├── pricing-engine.js           ← Slice 9
├── elasticity-fit.js           ← Slice 9
├── competitor-response.js      ← Slice 10
├── diff-engine.js              ← Slice 10
├── portfolio.js                ← Slice 11
├── alliance.js                 ← Slice 12
├── fleet-renewal.js            ← Slice 13
├── hub-designer.js             ← Slice 14
├── network-graph.js            ← Slice 14
├── backtest.js                 ← Slice 15
├── synthetic-snapshot.js       ← Slice 15
├── briefing.js                 ← Slice 16
├── risk-profiles.js            ← Slice 17
├── tuning-panel.js             ← Slice 17
├── portfolio-multi-world.js    ← Slice 18
├── marketing-tuner.js          ← Slice 19
├── default-settings.js         ← cross-cutting
├── EVENTS.md                   ← cross-cutting
└── README.md                   ← cross-cutting

modules/central-hub/tiles/
├── strategy-tile.js            ← Slice 4
└── briefing-tile.js            ← Slice 16

modules/crew-management/
├── pay-tier-scraper.js         ← Slice 8
└── pay-tier-applier.js         ← Slice 8

modules/marketing/
├── budget-scraper.js           ← Slice 19
└── budget-applier.js           ← Slice 19

modules/slots/
├── slot-scraper.js             ← Slice 20
└── slot-bidder.js              ← Slice 20

modules/alliance/
└── il-request-applier.js       ← Slice 12

docs/
└── STRATEGY-ROADMAP.md         ← this plan, copied into the repo on commit
```

### Files modified (whole roadmap)

- `manifest.json` — register every new module on the appropriate matches.
- `modules/route-assistant/settings-store.js` — extend with `strategy: {...}` settings block + defaults.
- `modules/aircraft-flight-plan/auto-scheduler/objective.js` — re-export shared math via scoring-primitives.
- `modules/aircraft-flight-plan/auto-scheduler/allocator.js` — accept fleet-level constraints from `allocate-fleet.js`.
- `modules/route-assistant/service-profile-applier.js` — small additions for batch apply.
- `modules/inventory/quick-price-applier.js` — small additions for batch apply.
- `HANDOVER.md` / `MANUAL.md` — document the strategy layer.

---

## Part X — Mantra

> *"Run the airline for me, but show me every decision and let me veto each one until I trust the engine."*

Every slice in this plan answers a piece of that mantra. The engine never wins authority by default; it earns it slice-by-slice as the user observes its proposals matching their intuition and its applies producing measurable wins.

---

## Appendix A — Commit / publish workflow (per user request)

The user's instruction includes *"commit it to the plan on github and everything else. make it big."* — interpreted as:

1. Copy this expanded plan into the repo at `docs/STRATEGY-ROADMAP.md` so it lives with the code rather than only in the planning sandbox.
2. Stage Slice 1 + Slice 2 implementation files (`modules/strategy/context.js`, `modules/strategy/decide-routes.js`), the manifest entries that wire them, and the new docs file.
3. Commit with a message announcing the roadmap and the foundation slice landings.
4. Push to `origin` on the active branch (`HEAD` per current `git status`).

Pre-flight checks before commit:
- `manifest.json` validates as JSON.
- Both new strategy modules pass `node --check`.
- No merge-conflict markers anywhere in the index (the user previously had `<<<<<<<` markers; system reminder confirmed they're resolved on the current manifest).
- `git status` shows only the intended files staged.

Commit message draft (subject + body):

```
feat(strategy): foundation — snapshot + per-route scoring + roadmap

Stand up modules/strategy/ as the home of the AES strategic operating
system. Two slices ship in this commit; eighteen further slices are
fully detailed in docs/STRATEGY-ROADMAP.md.

  • Slice 1: AesStrategy.snapshot() — read-only synthesis across every
    existing signal store (demand, distance, competitors, ORS, wear,
    flight log, ledger, sisters, crew, fleet, type specs, settings).
    Defensive of missing stores; reports `missing[]` so callers can
    distinguish graceful-null from real null.

  • Slice 2: AesStrategy.scoreRoutes(snapshot, weights?) — composite
    per-route ranking with profit/demand/competitor/ORS terms minus
    fleet wear and cash penalties. Emits rationale strings per route
    so every decision is explainable.

  • Manifest wiring on /app/enterprise/dashboard* and /app/fleets*.

The roadmap (docs/STRATEGY-ROADMAP.md) covers the full vision: fleet
allocator, apply pipeline, closed-loop learning, auto-route-creation,
service profile / crew pay / pricing tuners, competitor response,
sister-airline coordination, alliance partner suggestions, fleet
renewal, hub designer, backtesting, executive briefing, risk
profiles, multi-world federation, marketing, slot trading. Every
slice details inputs, outputs, algorithm, files, and verification.

No POSTs in this commit — all behavior is read-only and advisory.
Apply pipelines land in Slice 4 behind tier gates that re-use the
form-driver invariant established in modules/aircraft-flight-plan/
form-driver.js:10-24.
```

Post-commit, the user can iterate on the roadmap directly in `docs/STRATEGY-ROADMAP.md` (in-repo, in their editor) rather than via the Ultraplan session that 404'd.
