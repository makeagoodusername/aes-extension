# AES Conductor — Pillar VIII roadmap

> Working title for the layer: **`AesConductor`**.
> Scope: Pillar VIII (ORCHESTRATE) — the layer that watches the whole airline, derives typed signals from every store write, matches them against declarative scenarios, schedules multi-step routines, learns from outcomes, and surfaces a single attention queue to the user. Slice letter **K** (K1–K20+).
> Read after `NORTH-STAR.md` §6 / §7 (Pillar VIII, Epoch H) and before any K-prefix slice work.
> When this contradicts NORTH-STAR, NORTH-STAR wins or NORTH-STAR changes — never both stay.

---

## Part I — Vision

### The user's articulated request

> "Innovate further and expand on the current features and streamline and design a brand new system that orchestrates multiple different scenarios across a diverse range of different situations that might arise as the game progresses and there are different challenges. Integrating data interconnected together to create different routines that are reliant on producing certain results by learning from the massive data set, integrating automation and different features of machine learning if possible."

Preserved verbatim. Every section below traces back to a clause in this sentence.

### The one-line mission for Pillar VIII

**Run the airline as a coherent system, learn from what happens, and tell me only the few things that matter right now.**

The Strategy engine (Slices 1–32) decides *what move to make on each axis*. The Conductor decides *which axis is worth attending to right now, in what order, with what trust*. It is the difference between a panel of advisors and a chief of staff.

### What's already shipped that the Conductor inherits

The codebase already has primitives the Conductor composes; it does not invent them.

| Primitive | Module | What it gives the Conductor |
|---|---|---|
| Bus + storage onChanged | `central-hub/bus.js`, `chrome.storage.onChanged` | Reactive signal source. Every meaningful state change is observable. |
| `AesStrategy.snapshot()` | `strategy/context.js` | One read-only synthesis of the airline's state. Conductor reads this rather than duplicating reads. |
| Outcomes log | `strategy/outcomes.js` (Slice 5) | Where applied decisions vs observed deltas already live. Conductor extends, doesn't replace. |
| Wear regression + maintenance forecast | `aircraft-flight-plan/wear-model.js`, `maintenance-budget.js` | A worked example of a rolling fit + forecast. Conductor's anomaly primitives reuse the same EWMA / regression patterns. |
| Auto-pricer Tier 3.3b silent loop | `background.js` chrome.alarms heartbeat | Proof that periodic background work + first-activation confirm + per-route cooldowns is feasible inside MV3. Conductor's K5 adaptive cadence builds on the same mechanism. |
| Scrape orchestrator + auto-drive cadence layer | `scrape-orchestrator/orchestrator.js`, `cadence-store.js`, `auto-driver.js` | Per-phase staleness + drip-style background scrapes. Conductor's K1 signal layer subscribes to the cadence-store changes; K5 (adaptive cadence) extends it with change-rate learning. |
| Standing orders rule engine (Strategy Slice 24, planned) | future `standing-orders.js` | Declarative rules → decisions in plan stream. Folds into K2 scenario engine when built. |
| Markets gossip feed (Strategy Slice 27, planned) | future `gossip-feed.js` | Anomaly events on the bus. Folds into K1 signal layer when built. |
| Strategy journal & lessons mining (Slice 26, planned) | future `journal.js` | Auto-log of overrides + outcomes. Folds into K20 latent scenario discovery when built. |
| Goal-seeker (Slice 23, planned) | future `goal-seeker.js` | Beam search over plan bundles. Conductor surfaces these as routines (K3) with KPI tracking. |

### Design principles specific to ORCHESTRATE

These extend, not replace, the 20 first principles in NORTH-STAR §4. Every K slice satisfies them all *plus* the 20 above.

1. **The Conductor is read-only by default.** Surfacing a scenario is read-only; running a routine that proposes a decision is read-only; only the underlying actuator (already two-gated) writes to AS. The Conductor never bypasses Pillar III's two-gate model.
2. **No new actuators.** K slices reuse `*Applier`s and `FormDriver`. If a scenario's recommended action has no actuator, the scenario stops at the suggest tier — never invents a write path.
3. **No new dependencies.** Vanilla JS, vanilla MV3, vanilla `chrome.storage.local`. ML primitives are hand-rolled (linear regression, EWMA, z-score, beta-Bayesian, Markov) implementable in ≤200 LOC each. No tensorflow.js. No npm. (NORTH-STAR §4.11.)
4. **Trust is local, never global.** Each scenario carries its own trust quotient. A user who trusts the Maintenance Pressure scenario at apply-auto can still hold the Cash Crunch Forecast at suggest-only. There is no "auto mode" master switch that flips everything.
5. **Every signal is named, every scenario explainable, every routine auditable.** A scenario whose rationale can't be summarised in one sentence has the wrong shape (NORTH-STAR §4.4 generalised).
6. **Storage is bounded and tiered.** Signals are ring-buffered at 1000 entries per signal type; scenario fires at 200 per scenario; routine state at 50 per routine; trust quotient at unbounded but tiny (one number per scenario). Total Conductor namespace cap: 1 MB (matches the strategy namespace cap, NORTH-STAR §4.10).
7. **Learning is opt-in to apply, on-by-default to observe.** The system always builds baselines, logs outcomes, computes trust quotients. It does not act on those numbers without the user crossing a tier gate.
8. **No new scrapers.** The signal layer derives signals from existing scrapers' writes. New scrapes only ship under the SENSE pillar (NORTH-STAR §3 STRATEGY-ROADMAP principle 7).
9. **Cross-account aware from day 1.** Conductor stores are scoped per-account where appropriate (Class B per L's rubric); per-scenario weights and trust quotients can roll up at the canopy level under L6 Strategy DNA.
10. **Adaptive but predictable.** Self-tuning thresholds and cadences, but every adjustment is logged with rationale and reversible. The user can pin a threshold or reset the trust quotient to neutral at any time.

---

## Part II — Architecture

### The five layers

```
        ┌──────────────────────────────────────────────────────────────┐
        │                 USER SURFACE                                  │
        │   Conductor tile · Briefing · Cmd-K · per-tile chips         │
        ├──────────────────────────────────────────────────────────────┤
        │                 CONDUCTOR (K9)                                │
        │   Priority queue · attention picker · conflict resolution    │
        │   Reservation lock per resource (tail, route, hub, capital)  │
        ├──────────────────────────────────────────────────────────────┤
        │                 ROUTINES (K3)                                 │
        │   Multi-step state machines with KPI targets                 │
        │   Wait-on-signal · run-scenario · apply-actuator · suspend   │
        ├──────────────────────────────────────────────────────────────┤
        │                 SCENARIO ENGINE (K2)                          │
        │   Declarative match patterns over signal streams              │
        │   {triggers, conditions, window, action, KPI, trust}         │
        ├──────────────────────────────────────────────────────────────┤
        │                 SIGNAL LAYER (K1)                             │
        │   Typed events derived from storage writes + scrape phases   │
        │   Ring-buffered, queryable, replayable                        │
        ├──────────────────────────────────────────────────────────────┤
        │                 LEARNING SUBSTRATE (K11–K15, K20)             │
        │   EWMA baselines · z-scores · regression fits · trust quotient│
        │   Outcome-weighted threshold adjustment · latent discovery    │
        └──────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ reads / observes (never writes)
                                    │
        ┌──────────────────────────────────────────────────────────────┐
        │   EXISTING AES SUBSTRATE                                      │
        │   Read stores · scrapers · snapshot() · actuators · bus       │
        └──────────────────────────────────────────────────────────────┘
```

The Conductor sits **above** the existing engine and **never reaches around** it. Every read goes through `snapshot()` or directly through the bus / storage; every write goes through an existing actuator.

### The flow of a single scenario fire

1. A scrape lands → `chrome.storage.onChanged` fires.
2. Signal layer (K1) inspects the change against its declared signal extractors → emits typed events to `aesConductor:bus` (e.g. `{type: "aircraft.maintenance.ratio.dropped", aircraftId: "FGM007", from: 110.4, to: 96.3, server: "free1", airline: "FGM"}`).
3. Scenario engine (K2) runs every active scenario's pattern matcher against the signal + the recent ring buffer → matched scenarios fire with `{scenarioId, matchedSignals[], snapshotRef, firedAt}`.
4. Conductor (K9) receives the fire → looks up the scenario's tier and trust quotient → decides whether to alert, suggest, queue-for-confirm, or auto-apply.
5. If a routine (K3) is currently running and owns a reservation lock on the affected resource, the routine receives the signal and steps its state machine instead.
6. The action surfaces in the Conductor tile (K9 surface) with rationale, projected outcome, and the appropriate affordance (Dismiss / Apply / Open).
7. Once observed (within the scenario's KPI window), outcomes feed the learning substrate → trust quotient updates → next fire rebalances the priority queue.

### Where ML actually lives

Realistic ML primitives in a Chrome MV3 extension with no dependencies:

| Primitive | Use | Implementation cost | Where it ships |
|---|---|---|---|
| **EWMA / EWMV** | Per-metric rolling baseline + variance | ~30 LOC | K13 baseline learning |
| **Rolling z-score** | Anomaly detection vs. baseline | ~20 LOC | K13 anomaly primitive |
| **Linear regression (weighted least squares)** | Trend lines, profit decay slope, equilibrium ratio | ~80 LOC | K13 (already shipped in `wear-model.js`; generalise) |
| **Logistic regression (SGD, batch)** | Binary classifiers (e.g. "will this route's profit cross zero in 4 weeks?") | ~120 LOC | K15 propensity scoring (advanced) |
| **Beta-Bayesian update** | Trust quotient (accepted / proposed) with shrinkage | ~30 LOC | K11 trust quotient |
| **Markov state transition** | "What state is this tail likely to be in next week?" | ~80 LOC | K15 short-horizon forecasting |
| **K-means (1-D, fixed K)** | Tail / route clustering by feature signature | ~60 LOC | K20 latent discovery (heuristic candidates) |
| **Counterfactual replay** | Pure-function rerun of `snapshot()` against historical accounting snapshots | already exists in Slice 15 backtest | K15 outcome attribution |

What the Conductor explicitly will NOT do:
- No neural networks (no GPU; no MV3 WebGPU access for content scripts).
- No transformer / sequence models.
- No tensorflow.js (~600 KB minified; violates §4.11).
- No external ML API. No cloud. No keys (NORTH-STAR §3, §10 row 11).

Every primitive above is realistic in vanilla JS; the cost ceiling is "could one developer ship it in a weekend." The LLM co-pilot (Strategy Slice 28) is a separate concern — it operates over the Conductor's already-computed scenarios; it does not replace them.

---

## Part III — Slice catalog

Each K slice ships with: a one-line user value, a primary pillar (always ORCHESTRATE), 0–2 secondary pillars, files added/modified, storage keys with caps, bus events, and verification steps. The slices are ordered so each builds on the previous; deviation from the order requires a NORTH-STAR §11.9 deferred-decision note.

### K1 — Signal layer foundation ✅ shipped
**User value.** "I can see, in one place, every meaningful change happening across the airline as it happens."
**Primary:** ORCHESTRATE. **Secondary:** SENSE.
**Shape.** New module `modules/conductor/signal-layer.js` registers signal extractors that subscribe to `chrome.storage.onChanged` and accept direct emits from `central-hub/bus.js` events. Each extractor declares: input keys / events, output signal type, derived payload. Ring buffer at `aesConductor:signals:<server>:<airline>` (cap 500 in v1 — see HANDOVER §1 K1 entry for the rationale; the spec's 1000/type aspiration is reachable via a single constant change once K10 demand justifies it).
**Initial extractors.** Eight extractors covering ten conceptual sources from the K1 spec — drop / rise / entry / exit pairs collapsed into single `*.changed` events with a `direction` payload field so K2 patterns match without a second extractor. Sources: maintenance-ratio · maintenance-condition · route-profit (per-route diff with $5k/wk OR 25% threshold) · competitor count · cash-balance · ORS rank (per-class) · scrape phase completion · auto-driver tick (direct emit) + a bonus `schedule.scraped` extractor.
**Bus event.** `conductor:signal` `{id, type, server, airline, payload, firedAt}`.
**Verification.** Open the dashboard with stored history; signal ring buffer populates within 5s. Manually trigger a maintenance scrape; signal of type `maintenance.ratio.changed` with `direction: "drop"` lands in the buffer. See HANDOVER §1 K1 entry for the full smoke checklist.

### K2 — Scenario engine ✅ shipped (thin)
**User value.** "I can write a one-paragraph rule and the system watches for it."
**Primary:** ORCHESTRATE. **Secondary:** DECIDE.
**Shape.** `modules/conductor/scenario-engine.js` subscribes to `conductor:signal`, runs each scenario's `match(signal)` matcher, persists fires to `modules/conductor/scenario-store.js` (ring buffer, 200 entries at `aesConductor:fires:<server>:<airline>`), broadcasts `conductor:scenario` on the CentralHubBus. The thin K2 ships with a single-signal `match()` contract — window-spanning patterns (the spec's `triggers: SignalPattern[]` shape) and snapshot-predicate conditions land in K2.1 once K13 baselines + K15 forecasts are available. Bundled library lives in `modules/conductor/scenarios.js` (10 of 17 from §IV — see HANDOVER §1 K2 entry for the inventory + the 7 deferred and why).
**Bus event.** `conductor:scenario` `{id, scenarioId, label, severity, server, airline, firedAt, rationale, payload, signalIds}`.
**Tier field.** Each scenario carries `tier` defaulting to `"alert"`. Engine ignores tier in K2; K11 (trust quotient) gates promotion.
**Verification.** Enable a scenario whose signal is reachable (e.g. `MaintenanceWatch` for a tail with a low-ratio scrape); the fire lands in the per-account ring within one signal tick; rationale carries the matched payload.

### K3 — Routine state machines ✅ shipped (alert tier, 3 of 3 bundled)
**User value.** "Some things take five steps over a week — I want one item to track instead of five disconnected alerts."
**Primary:** ORCHESTRATE. **Secondary:** DECIDE.
**Shape.** `modules/conductor/routine-engine.js` + `modules/conductor/routine-store.js` (ring buffer, 100 cap total per account, eviction prefers completed/expired) + `modules/conductor/routines/` directory (one file per bundled def). Each routine def exposes `{id, label, watchScenarios[], watchSignalTypes[], spawnFromScenarioFire, resolveTarget(event), initialState, initialScratch(event), advance(instance, event, ctx)}`. Engine subscribes to `conductor:scenario` + `conductor:signal`, dispatches advance() / spawn() based on resolveTarget. Transitions append to `instance.history[]` (cap 20).
**Initial routines (all shipped).** `MaintenanceRebalance` (target = aircraftId), `RouteProfitRecovery` (target = hub:dest), `CashRunwayDefence` (target = server:airline, account-singleton, spawn-direction-gated). Each follows observing → proposing → completed/expired with per-routine fire-count and time-window thresholds.
**Bus events.** `conductor:routine:spawned` `{instance}`, `conductor:routine:transition` `{instance, from, to, reason}`.
**Apply integration.** Deferred to K3.1+: today every routine's `proposing` state surfaces in the K6 tile with rationale; the user routes through existing actuators manually. K11 trust gating + per-routine actuator wiring completes the loop.
**Verification.** Spawn any routine by triggering the underlying scenario; routine appears in K6 tile's Routines section; second qualifying fire transitions it to `proposing` (amber dot); recovery condition transitions it to `completed` (green dot). See HANDOVER §1 K3 entry for the full smoke checklist.

### K4 — Reservation locks
**User value.** "Two scenarios fighting over the same tail's schedule should not happen — one waits."
**Primary:** ORCHESTRATE.
**Shape.** Lightweight in-memory + storage-backed lock table keyed by `(resourceType, resourceId)`. Routines acquire on transition into a state that may apply; release on completion / suspend. Conductor's priority queue (K9) refuses to dispatch a scenario whose target resource is locked.

### K5 — Adaptive cadence
**User value.** "The system stops scraping things that never change and ramps up things that change a lot."
**Primary:** ORCHESTRATE. **Secondary:** LEARN.
**Shape.** Extends `scrape-orchestrator/cadence-store.js` (already shipped). Tracks per-phase delta-rate (how often a phase's scrape produces a *meaningful* storage change vs. a no-op). Adjusts `DEFAULT_CADENCE_MS` per-phase per-server within bounds (×0.5 to ×4 of the default). Bounded and reversible — every adjustment logged to `aesConductor:cadenceLog` and visible on the auto-drive strip's tooltip.

### K6 — Conductor tile ✅ shipped (alert tier)
**User value.** "I open the dashboard and the top of the page tells me, in 5–15 lines, what the system is paying attention to."
**Primary:** ORCHESTRATE. **Secondary:** COMPOSE.
**Shape.** `modules/central-hub/tiles/conductor-tile.js` mounts in the dashboard `tools` section (priority 7). Three sub-sections — Routines (K3 hook, currently shows "no routines spawned yet"), Scenarios (top-5 fires from K2), and Signal feed (K1 ring filterable by source). Storage-key watching on `aesConductor:signals:*` + `aesConductor:fires:*` + `aesConductor:routines:*` re-renders on every append. Scenario sort: severity bucket (`alert > warn > info`) then recency within bucket. Per-row Dismiss (`✕`) writes `dismissedAt` to the fire and re-renders. Trust quotient (K11) and Open / Apply affordances (require K11 trust gate) deferred — the alert-tier surface is shipped.
**Bus events consumed.** `conductor:signal`, `conductor:scenario`, `conductor:routine:transition` (via storage broadcast — every emission also writes to its store).
**Verification.** Reload extension on `/app/enterprise/dashboard*`; tile lands in `tools`. Trigger any scenario fire; row appears with severity-coloured dot + rationale + ✕. Mixed severities sort alert > warn > info. Click ✕ → row disappears, ring entry retains `dismissedAt`. See HANDOVER §1 K6 entry for the full smoke checklist.

### K7 — Goal-seeker integration (folds Strategy Slice 23)
**User value.** "I tell the system 'reach $500M cash by week 80' and it spawns a routine that watches and proposes."
**Primary:** ORCHESTRATE. **Secondary:** DECIDE. **Replaces:** Strategy Slice 23 stand-alone proposal.
**Shape.** Goal-seeker output (top-K plan bundles) becomes the seed for a K3 routine. The routine measures progress against the goal each week and either continues, suspends, or escalates.

### K8 — Standing orders integration (folds Strategy Slice 24)
**User value.** "My standing rules ('if any 2-class widebody drops below 60% LF for 14 days, downgauge or kill') become first-class scenarios in the Conductor's queue."
**Primary:** ORCHESTRATE. **Secondary:** DECIDE + APPLY.
**Shape.** Standing-orders rule engine emits `conductor:scenario` events; user sees them in the same attention queue as bundled scenarios. Existing two-gate model preserved.

### K9 — Conductor priority queue + attention picker
**User value.** "When five things fire at once, I see the most-important one first, with rationale, not five toasts in random order."
**Primary:** ORCHESTRATE. **Secondary:** COMPOSE.
**Shape.** Pure-function `conductor.attentionScore(scenarioFire) → number`. Inputs: severity (the scenario declares), trust quotient (K11), recency, user-set priority bonus, snooze state. The tile (K6) renders this list. Cmd-K (Strategy Slice 29) gains "Conductor: open scenario X" actions.

### K10 — Outcome attribution per scenario ✅ shipped (thin)
**User value.** "When a Maintenance Pressure scenario fired and I applied its suggestion, did anything actually improve?"
**Primary:** ORCHESTRATE. **Secondary:** LEARN.
**Shape.** Each scenario fire writes to `aesConductor:fires:<server>:<airline>` (cap 200, shared ring — per-scenario partition deferred). The fire record gains `acceptanceState` (`open` / `accepted` / `dismissed`) and `outcome` (`{observedDelta, expectedDelta, favourable, terminal, reason}`). Six bundled scenarios ship instrumented evaluators (MaintenanceWatch, ConditionWatch, ProfitDecay, ProfitRecovery, OrsRegression, OrsRecovery); the four informational scenarios (CompetitorEntry/Exit, CashStep, AutoDriveActivity) leave the chip absent. `modules/conductor/outcome-driver.js` reruns evaluators on three triggers — bus signal arrival, 30-min interval, and dashboard mount — and persists when the verdict changes via `applyOutcome`. The Conductor tile (K6) gains an outcome chip and `Open` CTA per scenario row; clicking Open writes `acceptanceState=accepted` for K11 to read. See HANDOVER §1 K10 entry for the full smoke checklist.

### K11 — Trust quotient store
**User value.** "I trust the Maintenance Pressure scenario at apply-auto, but the Cash Crunch Forecast still wants my eyes for now."
**Primary:** ORCHESTRATE. **Secondary:** LEARN.
**Shape.** Per-scenario beta-Bayesian estimate of `P(favourable outcome | scenario fires and I accept)`. Shrinkage prior `Beta(2, 2)` so a scenario with 0 fires reads 50% by default. User can set the auto-apply threshold per scenario (`tier=apply-auto` only allowed when `lower-95% CI > threshold`). Storage `aesConductor:trust:<scenarioId>` — tiny, unbounded.

### K12 — Risk dashboard
**User value.** "I see one panel with my top 5 risks across the airline, ranked by severity × probability."
**Primary:** ORCHESTRATE. **Secondary:** COMPOSE + LEARN.
**Shape.** Aggregate scenario fires by risk category (financial / operational / competitive / regulatory). Surfaces top items in the executive briefing modal (Strategy Slice 16) under a "Risk register" section.

### K13 — Outcome-weighted threshold learning
**User value.** "The system stops alerting on profit dips that turned out to be noise and tightens its trigger on the ones that turned into real losses."
**Primary:** ORCHESTRATE. **Secondary:** LEARN.
**Shape.** Per-metric per-scope (per-tail / per-route / per-hub / global) EWMA baseline + variance. Each scenario declares which metric(s) it triggers on; the fire's threshold is computed from the baseline + scope's z-score, not a hand-tuned constant. Update happens nightly (chrome.alarms tick) and on big snapshot deltas.

### K14 — Drift detection
**User value.** "The system warns me when its own model is no longer matching reality."
**Primary:** ORCHESTRATE. **Secondary:** LEARN.
**Shape.** Each scenario tracks a model-fit measure (e.g., predicted vs observed deltas under K10). Sustained divergence → scenario flagged "drifted" → trust quotient floor lowers → user notified. Reuses Slice 15's backtest harness for the heavier weekly drift check.

### K15 — Short-horizon forecasting
**User value.** "I see 'JFK-LAX projected to drop to break-even in ~3 weeks at current trajectory' rather than a flat current-week number."
**Primary:** ORCHESTRATE. **Secondary:** DECIDE.
**Shape.** Pure-function forecasters per metric: linear extrapolation, EWMA forward-projection, Markov state transition for categorical states. Forecasts cite confidence intervals (P10/P50/P90). Surfaces in the Conductor tile and per-route panel.

### K16 — Cross-account scenario sharing
**User value.** "A scenario I trust on my flagship airline auto-suggests for my low-cost sister with neutral trust."
**Primary:** ORCHESTRATE. **Secondary:** FEDERATE.
**Shape.** Scenario definitions are global (Class A, world-fact); trust quotients per scenario per account (Class B). User can copy or fork a scenario across accounts. Folds with L6 Strategy DNA.

### K17 — Cross-pillar conflict resolution
**User value.** "If the Maintenance scenario wants to ground a tail and the Profit Recovery routine wants it on a high-yield route tomorrow, the system arbitrates and tells me."
**Primary:** ORCHESTRATE.
**Shape.** Conductor's priority queue inspects pending scenario actions for resource conflicts via reservation locks (K4). The losing scenario waits, queues a follow-up signal, and the user sees both items in the tile with the conflict noted.

### K18 — Routine library bundle
**User value.** "I have ~10 pre-built routines I can enable: Cash defence, Maintenance rebalance, Profit recovery, Hub-load levelling, …"
**Primary:** ORCHESTRATE. **Secondary:** DECIDE.
**Shape.** Curated routines that extend K3's initial three with: HubLoadLevelling, FleetIdleRedeployment, CompetitorResponseTracker, WaveStressRelief, ServiceProfileDrift, OrsRecoveryWatch, PortfolioRebalance (canopy), DemandShiftFollow.

### K19 — User-authored scenario UI
**User value.** "I open a wizard, pick a metric, set a threshold, choose an action, and a new scenario lands in the queue."
**Primary:** ORCHESTRATE. **Secondary:** COMPOSE.
**Shape.** Tile detail panel grows a "new scenario" form. Validates against the schema. Persists to `aesConductor:userScenarios`.

### K20 — Latent scenario discovery
**User value.** "The system says 'when X happens, Y often follows within 3 days — want to make this a scenario?'"
**Primary:** ORCHESTRATE. **Secondary:** LEARN.
**Shape.** Nightly batch over the signal ring buffer + outcomes log. For every pair of signal types, compute lift (P(Y | X) / P(Y)) and confidence intervals. Surfaces top candidates in the Conductor tile's "Discover" tab; user reviews and promotes to a real scenario in K2.

---

## Part IV — Initial scenario library

These ship bundled with K2 (the engine) so the user has something to watch out of the box. Each scenario carries: triggers, conditions, action, KPI. All start at **alert** tier; user promotes per-scenario to **suggest** then **apply-confirm** then optionally **apply-auto** (gated by K11 trust).

| Scenario | Triggers | Conditions | Action | KPI |
|---|---|---|---|---|
| **MaintenancePressure** | `aircraft.maintenance.ratio < ratioFloor + 5%` for any tail | `forecast7d.ratio < ratioFloor` AND no MX block scheduled in next 3 days | suggest: insert MX block on least-busy day | ratio recovers above `ratioFloor + 10%` within 14 days |
| **MaintenanceCascade** | 2+ tails fire MaintenancePressure within 7 days | fleet utilization > 85% | alert: fleet running too hot, propose lease/acquire OR pause new routes | aggregate ratio recovers within 21 days |
| **ProfitDecay** | route's 3-week EWMA profit dropped >15% from 12-week baseline | competitor entered OR demand dropped OR fuel rose | suggest: open RA for the route | 4-week-forward profit returns to baseline OR user accepts kill |
| **ProfitRecovery** | route's 3-week EWMA profit *rose* >20% above 12-week baseline | not on watchlist | alert: candidate for frequency increase | profit holds for next 4 weeks at upgraded freq |
| **CompetitorEntry** | new ID in `markets:competitors:<route>` not seen in last 30 days | route is in user's portfolio | alert: surface competitor enterprise meta + market share | LF / yield trajectory monitored for 4 weeks |
| **CompetitorExit** | ID in `markets:competitors:<route>` absent for 14+ days | route is in user's portfolio | suggest: increase frequency / re-price up | LF holds, yield rises within 4 weeks |
| **CashCrunchForecast** | 4-week forward EWMA of accounting snapshots projects cash < `cashFloor` | no large pending bond / capital action | alert: top-of-dashboard banner; suggest reducing capex | runway extends past `cashFloor + buffer` within next snapshot |
| **WaveStress** | turnaround minutes < 30 detected on >20% of legs in any hub's wave | `settings.allowAutoWaveAdjust == true` | suggest: time-shift wave by N minutes; show preview | conflict count drops 80% next observation |
| **FleetIdle** | aircraft utilization < 70% for 7+ consecutive days | hub has demand for type | suggest: route candidates from RA | utilization rises above 80% within 14 days |
| **CrewShortfall** | projected pilots-needed exceeds current pilots by >10% within 14 days | hiring path open | suggest: open Crew Mgmt with pre-filled roles | pilots-needed gap closes |
| **DemandShift** | market's `paxScore` or `cargoScore` changed by ≥2 bars in 14 days | market is in user's portfolio | alert: re-score routes touching the market | re-scored route ranks adjust within next snapshot |
| **OrsRegression** | route's ORS rank dropped >2 ranks over 4 weeks | not in active redesign | alert: open Service Profile + Pricing review | ORS rank recovers within 6 weeks |
| **PricingSpiralRisk** | self + competitor consecutive price-drop pattern detected | NORTH-STAR §4.17 floors not yet binding | alert: pause auto-pricing; surface to user | price stabilises above `marginalCost × 1.05` within 2 weeks |
| **SisterCannibalisation (canopy)** | two of user's airlines fly same hub-pair with overlapping wave windows | both airlines have positive LF | suggest: redistribute one to adjacent slot OR codeshare | combined LF lifts net of pair |
| **HubImbalance** | any hub's supply-demand ratio > 1.4 OR < 0.6 across 14-day window | RA topRoutes cache fresh for hub | alert: open Fleet Command for the hub | ratio normalises within 28 days |
| **ServiceDrift** | service profile S1 score drift > 0.3 from optimum | profile not pinned by user | suggest: service-tuner moves | S1 returns to within 0.1 of optimum |
| **AdaptiveCadence (meta)** | scrape phase produced 0 meaningful deltas in 5 consecutive runs | not at max cadence | self: extend that phase's cadence by ×1.5 (capped at ×4) | log entry + revisit if deltas re-appear |

These 17 scenarios are the v1 catalog. K18 (Routine library bundle) groups subsets into multi-step routines. Adding a 18th scenario follows the K19 user-authored path or a new K-prefix sub-slice.

---

## Part V — Storage scoping

All Conductor keys live under the `aesConductor:` prefix. Total cap **1 MB** (matches strategy namespace, NORTH-STAR §4.10). Eviction order on hitting cap: signals → fires → routine state → scenarios → trust → cadence log. Trust + scenario definitions are protected from eviction; they're tiny and irreplaceable.

| Key | Class | Cap | Cadence | Notes |
|---|---|---|---|---|
| `aesConductor:signals:<server>:<airline>` | B | 1000 entries / type | rolling | Ring buffer; oldest evicted first |
| `aesConductor:scenarios:builtin` | A | n/a | static | Bundled library, version-tagged |
| `aesConductor:userScenarios:<server>:<airline>` | B | 50 user scenarios | n/a | User-authored (K19) |
| `aesConductor:fires:<scenarioId>:<server>:<airline>` | B | 200 per scenario | rolling | Outcome-attributed (K10) |
| `aesConductor:routines:<routineId>:<server>:<airline>` | B | 50 per routine | rolling | State-machine snapshots |
| `aesConductor:trust:<scenarioId>:<server>:<airline>` | B | unbounded (tiny) | per-fire | Beta-Bayesian (α, β) |
| `aesConductor:baselines:<metric>:<scope>:<server>:<airline>` | B | unbounded (tiny) | EWMA | Used by K13 |
| `aesConductor:cadenceLog:<server>:<airline>` | B | 200 entries | rolling | K5 adjustments |
| `aesConductor:locks:<resourceType>:<resourceId>:<server>:<airline>` | B | n/a (transient) | live | K4 reservation locks |
| `aesConductor:settings:<server>:<airline>` | C | tiny | n/a | Per-scenario tier overrides, snooze, priority bonus |

`scrapeOrchestrator:phase:*` keys (already shipped under SENSE) are read but not owned by the Conductor namespace — K5 only mutates the cadence config (`aesConductor:cadenceLog` records the change rationale; the actual cadence override goes into `aesConductor:settings:cadence`).

---

## Part VI — Tier progression and the trust quotient

Every scenario advances through four tiers, per-account. The default install ships every scenario at **alert**.

| Tier | What the system does | What the user does | Gate to next tier |
|---|---|---|---|
| **alert** | Adds an item to the Conductor tile with rationale | Reads it; may dismiss | User clicks "Promote to suggest" once trust ≥ 30% |
| **suggest** | Pre-computes the recommended action with diff preview | Clicks Apply / Dismiss | User clicks "Promote to apply-confirm" once trust ≥ 60% AND ≥ 10 fires observed |
| **apply-confirm** | One-click apply through existing actuator (still two-gated) | Confirms each fire | User clicks "Promote to apply-auto" once trust lower-95%-CI ≥ 80% AND ≥ 30 fires observed |
| **apply-auto** | Applies without per-fire confirm; daily digest of actions taken | Reviews digest; can revoke any action | (Top tier; can be demoted at any time, immediately) |

**Trust quotient** = beta-Bayesian estimate of `P(favourable outcome | scenario fires and the user accepts the action)`. Shrinkage prior `Beta(2, 2)` so an unfired scenario reads 50% (neither trusted nor distrusted). A scenario whose lower 95% CI drops below 50% auto-demotes one tier; user is notified.

NORTH-STAR §4.16 is honoured — hub-open / hub-close decisions are **strictly advisory** (alert + suggest only), even at apply-auto trust. Same for fleet-renewal capital decisions and any standing-order rule that would close a hub.

---

## Part VII — Integration with existing slices

The Conductor does not replace; it composes. Specifically:

- **Strategy Slice 23 (goal-seeker)** → folds into K7. Goal-seeker output seeds a K3 routine.
- **Strategy Slice 24 (standing orders rule engine)** → folds into K8. Standing orders emit `conductor:scenario` events; the Conductor's queue is the surface.
- **Strategy Slice 26 (journal & lessons mining)** → folds into K20 (latent scenario discovery). Lessons mining was always going to discover patterns; under the Conductor, it discovers *scenario candidates* for user promotion.
- **Strategy Slice 27 (markets gossip feed)** → folds into K1 (signal layer). Gossip events become typed signals.
- **Strategy Slice 22 (probabilistic risk fans)** → integrated by K15 short-horizon forecasting (P10/P50/P90 reused).
- **Strategy Slice 21 (scenario forks)** → orthogonal; K3 routines can spawn and observe a fork before applying. K7 (goal-seeker integration) explicitly exercises this.
- **Strategy Slice 16 (executive briefing UI)** → grows a "Risk register" section sourced from K12.
- **Strategy Slice 28 (LLM co-pilot)** → operates over already-computed K-data; co-pilot can answer "explain why MaintenancePressure fired on N007FGM" without reaching around the Conductor.
- **Letter L Slice L6 (Strategy DNA)** → governs scenario tier overrides per account; K16 cross-account sharing builds on it.
- **Auto-Pricing Tier 3.3b (silent-auto loop)** → unchanged; the auto-pricer's per-route cooldowns continue to govern pricing applies. Conductor's PricingSpiralRisk scenario is an additional safety net, not a replacement.
- **scrape-orchestrator auto-driver** → the foundation K5 (adaptive cadence) extends. The shipped `cadence-store.js` + `auto-driver.js` are the prototype K5.

When in doubt: a feature that *picks what to do* belongs in Pillar II (DECIDE); a feature that *picks what to attend to and when* belongs in Pillar VIII (ORCHESTRATE).

---

## Part VIII — Verification and acceptance per epoch milestone

**Milestone H.1 (K1 + K2 + K6 land).** Dashboard shows a Conductor tile with at least 3 active scenarios populated within 60s of opening on an established airline. Each scenario fires within one auto-driver cycle of its trigger storage write.

**Milestone H.2 (K3 + K4 + K9 land).** Spawn `MaintenanceRebalance` routine on a tail; routine progresses through 4 states across simulated week of accounting snapshots; reservation lock on the tail prevents the FleetIdleRedeployment routine from acting on the same tail in parallel.

**Milestone H.3 (K10 + K11 land).** After 30 fires of MaintenancePressure on a test airline, trust quotient stable; promoting to apply-confirm requires trust ≥ 60% per the gate. Demoting because of a string of unfavourable outcomes auto-reverts the tier.

**Milestone H.4 (K13 + K14 + K15 land).** A scenario whose threshold was hand-tuned at v1 now self-tunes via baseline learning; drift detection flags a model that has decoupled from reality; forecasts cite P10/P50/P90 with confidence intervals.

**Milestone H.5 (K16 + K18 + K19 land).** The user enables 3+ pre-built routines, copies one across two canopy accounts, and authors one custom scenario via the wizard.

**Milestone H.6 (K20 lands).** Latent discovery has surfaced ≥ 5 candidate scenarios drawn from real signal correlations; ≥ 1 is promoted to a real scenario by the user.

---

## Part IX — Open questions (deferred-decision protocol)

Each question requires a user decision before the dependent slice ships. These extend NORTH-STAR §10.

| # | Question | Working default | Blocker for |
|---|---|---|---|
| 16 | Should `apply-auto` ever exist for the Conductor (vs. apply-confirm being the strictest)? | `apply-auto` exists per-scenario, opt-in, gated by K11 trust + tier promotion | K11 + K8 + K18 routines that have apply-auto candidates |
| 17 | Trust quotient shared across canopy accounts (one number per scenario) or per-account (one per `(scenario, account)`)? | Per-account (mirrors L6 Strategy DNA's per-account override) | K11 cross-account behaviour, K16 |
| 18 | Latent scenario discovery — auto-promote candidates above lift threshold, or always require user review? | Always require user review (NORTH-STAR §4.4 explainability) | K20 |
| 19 | Adaptive cadence — bound on phase cadence multiplier? Default ×0.5 to ×4; should it be tighter? | ×0.5 to ×4 of `DEFAULT_CADENCE_MS` | K5 |
| 20 | First-activation experience — does the Conductor tile land enabled at install, or hidden until user enables? | Tile enabled, scenarios all at `alert` tier (read-only); user promotes individually | K6 |
| 21 | Forecast horizon — short-horizon K15 fixed at 4 weeks or tunable? | 4 weeks default; tunable per-scenario | K15 |
| 22 | Drift detection sensitivity — how many fires before a scenario can be flagged drifted? | 30 fires minimum | K14 |
| 23 | User-authored scenario validation — schema-only or also dry-run against signal history? | Both: schema-validate on save; offer "test against last 30 days of signals" preview | K19 |
| 24 | Conductor tile ranking — pure attentionScore() or hybrid with user-pinned items always on top? | Hybrid: user-pinned items pinned, else attentionScore() | K9 |
| 25 | Should the Conductor's adaptive cadence ever override user-pinned cadence? | No (NORTH-STAR §4.15: per-account user override always wins) | K5 |

Document a chosen answer in HANDOVER §11 ("what's been said") when the user picks one.

---

## Part X — Risks specific to the Conductor

| Risk | Mitigation |
|---|---|
| **Alert fatigue** — 17 scenarios × 9 tails × N routes = thousands of fires/week if thresholds are loose | Shrinkage prior on baselines (K13) + attentionScore() pruning to top-K + per-scenario rate-limit |
| **Trust spoofing** — a scenario gets accepted because its action is harmless, not because it's right | K10's outcome attribution measures *observed delta* against *expected delta*, not just user acceptance |
| **Conflicting routines** — two routines acting on the same resource in overlapping windows | K4 reservation locks + K17 conflict resolution; tested as Milestone H.2 |
| **Scenario drift over game-world changes** — AS rebalance changes a metric distribution and old thresholds become wrong | K14 drift detection + auto-demote; baseline learning (K13) catches gradual shifts |
| **User loses oversight after auto-apply gates open** | Daily digest at apply-auto tier (mandatory); revoke-any-action affordance in tile; tier auto-demotes on adverse outcomes |
| **Storage budget breach as fires accumulate** | Per-scenario fire cap at 200; signal ring buffer cap at 1000; nightly compaction on `chrome.alarms` tick |
| **Cross-account scenario propagation surprises** | K16 explicitly opt-in copy/fork; trust quotient never propagates without user action |
| **The Conductor itself becomes "another thing to learn"** | K6 tile is the single surface; everything else hides behind one click; Cmd-K (Slice 29) provides power-user access |

---

## Part XI — Living amendments

| Date | Change | By |
|---|---|---|
| 2026-04-29 | Initial draft. Pillar VIII / Epoch H / letter K registered. Five-layer architecture, 20 K slices, 17-scenario v1 library, beta-Bayesian trust quotient, EWMA / regression / Markov ML primitives, integration map for existing Strategy Slices 16/21/22/23/24/26/27/28 + Letter L6 + Auto-Pricing 3.3b + the scrape auto-drive cadence layer just shipped. | session 2026-04-29 |
| 2026-04-29 | K1 (signal layer foundation) shipped. Eight extractors (ten conceptual sources via `direction` payload field) + 500-entry ring buffer + `conductor:signal` bus contract. K2/K3/K6 stubs remain unwired pending their own slices. | session 2026-04-29 |
| 2026-04-29 | K2 (scenario engine) shipped thin. Engine subscribes to `conductor:signal`, fires to `aesConductor:fires:*` ring (200 cap), broadcasts `conductor:scenario`. Bundled library expanded 4 → 10 scenarios with `tier` field defaulting `"alert"`. 7 §IV scenarios remain deferred on K13 baselines / K15 forecasting / window-spanning matchers (K2.1). K6 tile (the user-visible surface) still pending its own slice. | session 2026-04-29 |
| 2026-04-29 | K6 (Conductor tile) shipped at alert tier. Severity-weighted scenario sort (alert > warn > info, recency tiebreak); per-fire Dismiss (`✕`) via new `AesConductorScenarioStore.dismiss(host, fireId)`; section header counts by severity. Open / Apply affordances + trust-quotient priority deferred to K11. Routines section ready to populate when K3 ships. | session 2026-04-29 |
| 2026-04-29 | K3 (routine state machines) shipped at alert tier. 3 bundled routines: MaintenanceRebalance (existing), RouteProfitRecovery (new — hub:dest target, ProfitDecay/ProfitRecovery scenarios + route.profit.changed signal), CashRunwayDefence (new — account-singleton, spawn-direction-gated). All 3 follow observing → proposing → completed/expired lifecycle with fire-count + time-window thresholds. Apply affordances + K4 reservation locks + K3.1 base-class refactor deferred. | session 2026-04-29 |

---

*End of Conductor Roadmap.*
