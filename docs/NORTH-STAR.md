# AES — North Star

> The supreme guiding document for the AirlineSim Enhancement Suite.
> Read this before every session. Amend it when reality diverges from it.
> When other docs disagree with this one, this one wins or this one changes — never both stay.

---

## 0 · How to use this document

This is the **single source of truth** for *what AES is becoming and why*. It does not duplicate per-slice plans, per-feature roadmaps, or session handovers — those live elsewhere and rot quickly. This document is the **constitutional layer**: the parts that should change rarely and only with deliberation.

| If you need… | Go to… |
| --- | --- |
| The current vision and end state | this doc, §1–§3 |
| The first principles you must not break | this doc, §4 |
| The mental model of the architecture | this doc, §5 |
| The macro-themes every slice belongs to | this doc, §6 |
| The phased journey across the next ~50 sessions | this doc, §7 |
| How to pick what to ship next | this doc, §8 |
| How a "right-shaped" slice looks | this doc, §9 |
| What we have explicitly NOT decided | this doc, §10 |
| The strategy slice catalog (Slices 1–32, S/F/L/Q/U numbering) | `docs/STRATEGY-ROADMAP.md` |
| The Flight Studio expansion (F1 → F3) | `docs/FLIGHT-STUDIO-ROADMAP.md` |
| The Conductor (Pillar VIII) — scenarios, routines, learning | `docs/CONDUCTOR-ROADMAP.md` |
| Per-feature design docs | `docs/PLAN-*.md` |
| What shipped this/last session, invariants list | `HANDOVER.md` |

**Amendment rule.** When you discover that a principle here is wrong, blocking, or missing — change *this document first*, then the code. Don't ship code that contradicts the North Star without first updating the North Star.

---

## 1 · Genesis — The user's articulated vision

Preserved verbatim so the design intent stays anchored to the user's own words:

> "The information already being scraped should inform the production of the schedules which should be dynamically inserted and changing to allocate resources (airplanes) to certain schedules in a certain manner of flux and dynamic allocation to consider and utilise functions that are already existent such as the ORS and the sandbox system where the demand and therefore price is considered along with the competitors who are present or not present to define the strategy that can be deployed through the interface by automating certain functions that are already there."
>
> "It should consider maintenance, which it already does, it should consider the strategy of the company as a whole with the different personnel changes that might affect the ORS system by how the perception of the company changes with how much employees are payed."
>
> "It should also automate the creation of the new routes and define strategy that is dependent on the dynamic positioning of the various companies that hopefully will be integrated into the rest of the management of these different companies in the same game world."

**One-line mission.**
**Run the airline (or family of airlines) for me, but show me every decision and let me veto each one until I trust the engine.**

Every section below answers some piece of that one line.

---

## 2 · The End State — What "done" looks like

A concrete picture of AES at maturity. We are not "done" until a typical session looks like this:

> The user opens any AirlineSim page. The Central Hub dashboard's executive briefing card surfaces "since your last visit": three decisions the engine applied (with predicted vs observed deltas), one outcome that drifted (with the weight that's being nudged in response), two opportunities for next week, one risk flag (cash runway). Each item is one click from full rationale, full input snapshot, and an Undo button.
>
> A Route Assistant glance shows every route on the current hub annotated with: status, profit/wk, ORS rank delta vs last visit, watchlist star, override TTL, and a "Cmp*" column showing *effective* competitor count after subtracting kin airlines. Hover any cell for the breakdown; right-click for actions; Cmd-K for the global command palette.
>
> The user has three airlines across two game worlds. The canopy view shows combined supply on every contested hub-pair. The engine has flagged four routes where two of the user's airlines are silently cannibalising each other and proposed a redistribution. A standing order — *"if any 2-class widebody drops below 60% LF for 14 days, downgauge or kill"* — fires once a week on average and queues a decision into the next plan.
>
> Open Flight Studio on any aircraft and the decision sidebar shows demand, top operators, profit estimate, and (for multi-leg compositions) feasibility against all of: maintenance windows, curfews, slot availability, fleet wear headroom. Drag a candidate from the table onto the wave strip, drop on the 09:00 slot of Wave 1, the form pre-fills and a toast asks for confirmation before submit. The "Automate" button does the rest of the day's roster.
>
> Behind the scenes: every signal AS exposes (demand bars, ORS rank, market shares, historic prices, competitor footprints, alliance memberships, sister airline P&L, fuel index, wear curves, maintenance forecasts, crew pay tiers, marketing budgets, slot inventories) is scraped on a sane cadence, normalised into stable stores, and consumed by `AesStrategy.snapshot()` — one read-only synthesis the engine and every panel agrees on.
>
> The engine measures itself. After every applied plan it captures `before` and `after`, attributes profit/ORS/LF deltas to specific decisions, and finite-difference-learns the weights that should move. The user can pause learning, reset weights, or override any individual rationale. Every applied decision is undoable for at least one window. Every apply path has a kill switch *and* a slice-readiness gate; both must be on for any POST.
>
> The user has not memorised "which AS page does what". They drive the airline through AES, and AES drives AS. AS is the substrate; AES is the cockpit.

This is the end state. Everything below describes how we get there without breaking what we already shipped.

---

## 3 · The Promises — What AES is and what it isn't

### What AES IS

- A **closed-loop strategic operating system** for one-or-many AS airlines, built on top of the scraping + actuator infrastructure already in this repo.
- A **decision-explanation engine first**, an automation layer second. Every action ships with rationale; every applied action is observable, undoable, and auditable.
- A **single cockpit** that consolidates every AS surface the user touches into Central Hub tiles + per-page panels + a unifying Strategy modal.
- **Vanilla JavaScript, vanilla Chrome extension MV3, vanilla `chrome.storage.local`.** No build step. No bundler. No dependency we don't already have.
- **Defensive of every cross-tab race, every storage budget, every page-version handshake, every Wicket nuance** — see §4 invariants.

### What AES is NOT

- Not a backend. There is no server, no API beyond AS itself, no off-machine telemetry, no cloud sync (yet).
- Not a "play the game for me" autopilot. It is a *vetoable* engine — every automation tier defaults to off.
- Not a place for new dependencies, build tooling, framework migrations, type systems, or test runners we don't already have.
- Not a re-implementation of AS. We use AS's actuators, AS's forms, AS's flight numbers, AS's alliance system. We never bypass AS where AS is authoritative.
- Not a single-airline tool. Even the single-airline path must behave correctly under canopy assumptions (so that the canopy MVP slots in without rewriting half the codebase).

---

## 4 · First Principles — the inviolable invariants

These are the rules every slice must satisfy. Breaking one is a bug; getting close to one requires the explicit acknowledgement of why.

### 4.1 · Read-only by default; opt-in to apply

Every install is 100% advisory until the user opts in. Every apply path has **two gates**: a kill switch (`*.apply.enabled`) representing the user's "off" intent, and a slice-readiness gate (`*.dryRunOnly`, `tier === "preview-only"`, `*Enabled === false`) representing the codebase's "ready" intent. **Both must be on for any POST.** Collapsing these gates into one is a HIGH-severity regression.

### 4.2 · The form-driver invariant

`modules/aircraft-flight-plan/form-driver.js`'s user-facing surfaces (`fill`, `dryRun`, `reverse`, `clear`) NEVER POST and NEVER call `submitBtn.click()`. They mutate inputs and dispatch `input`/`change` events; the user submits AS's own button. Reverse O/D click is allowed because that's a same-page UI toggle, not a form submission. The single exception is `fillAndSubmit()` — invoked exclusively by `background.js`'s `_afpRunSubmit` / `_afpRunBatchSubmit` orchestrators in response to the `aes:afp:fill-and-submit` chrome.runtime message, which itself only fires from the gated apply pipeline (`AesAfpFleetApplyOrchestrator` two-gate `tier === "apply-on-confirm"` + `autoScheduler.enabled`). New write affordances need separate review and a fresh invariant entry.

### 4.3 · Reuse existing actuators; never re-implement them

The Strategy layer never POSTs directly. It calls `AesAfpFleetApplyOrchestrator`, `RouteAssistantPricingApplier`, `RouteAssistantServiceProfileApplier`, `CrewMgmtStaffPilotsApplier`, `AesStrategyRouteCreationApplier`. The single-source-of-truth for "things that POST" stays where it is. Adding a new POST path requires extending an existing actuator or shipping a new one with its own two-gate model — never bolting it onto a non-applier.

### 4.4 · Every decision is explainable

Each proposed action ships with a `rationale: string[]` referencing the inputs (which signals, with what values) and the score breakdown (which terms moved the needle). No black box. If the engine can't explain it in user-readable terms, it can't ship it.

### 4.5 · Closed-loop or it doesn't count

Anything the engine *decides* must, eventually, be measurable against what *happened*. Outcomes go into `aesStrategy:learn:outcomes`. Drift is observable. The user can inspect, pause, reset. A new decision type without an outcome path is a half-feature.

### 4.6 · Storage keys are contracts

Every `chrome.storage.local` key prefix in `HANDOVER.md §4` is **stable**. Other features and saved user data read them. A rename requires either (a) a one-time migration that preserves the user's data, or (b) preserving the old key as a compatibility read path. Never a silent rename.

### 4.7 · Pure-function cores; side-effecting actuators

Models (`ors-model.js`, `score.js`, `objective.js`, `allocate-fleet.js`, `route-creation.js`, `evaluate-flights`, `optimizeAssignment`) are PURE — no DOM, no I/O, no `chrome.storage`. They're called at 60 Hz during slider drags. Side effects live in actuators, scrapers, panels. When unsure: if it's called from a render loop, it must be pure.

### 4.8 · Defensive across schema drift, missing stores, missing fields

`snapshot()` reports `missing[]`; downstream layers degrade gracefully. Records are read with `_num()` / `_safe()` guards; missing fields become null, never throw. A scraper that fails parses leaves `parserNotes` and a partial record, never a corrupted store.

### 4.9 · Cross-tab and cross-mount safe

Multiple AS tabs may be open simultaneously. State that must survive is in `chrome.storage.local`; in-memory state is rebuilt on every mount. Diff baselines are anchored mount-anchored, not live (deliberate — see HANDOVER for the rationale). Race-prone applies use atomic `set` + first-writer-wins.

### 4.10 · Storage-budget aware

`chrome.storage.local` has a 10 MB cap. The strategy namespace alone is budgeted at 1 MB soft / 2 MB hard with explicit eviction order (see `STRATEGY-ROADMAP.md §IV`). Every new ring buffer ships with a cap; every per-route store has a TTL or eviction; every "log" is bounded.

### 4.11 · No new dependencies

Vanilla JS, vanilla Chrome MV3, jQuery (already vendored, used sparingly), Playwright is **NOT** in this project (that's the Hive project's CLAUDE.md describing a separate codebase; ignore it for AES). No npm install. No build. No transpiler. Period.

### 4.12 · Manifest discipline

Every new module must be content-script-wired in the right `matches` block, in the right load order (foundation → host → bus subscribers → entry), with the AFP de-dup rule honoured (`afp_js & fleets_js` empty). Manifest mistakes break pages silently — verify with `python3 -c "import json; json.load(open('manifest.json'))"` and a set-diff before every PR.

### 4.13 · The bus is the integration contract

Modules don't import each other. They emit/subscribe via `window.AesAfp.bus` (or the equivalent `AesStrategy.bus` on dashboard pages). New cross-module features go through bus events, not direct references. This is what makes partial-load + partial-failure recovery possible.

### 4.14 · Single-airline today must behave like canopy tomorrow

The canopy work (Letter L) is multi-account federation. The single-airline path must already respect the storage scoping rubric (Class A world-fact / Class B account-perspective / Class C user-tuned) so that L1–L3 storage refactor lands as plumbing, not as a rewrite. New stores get scoped correctly *the first time*.

### 4.15 · Per-account user override always wins

For affiliation graph (kin/allied/interline/codeshare/neutral/adversary), Strategy DNA, weights, settings: auto-classification fills empty slots; user override is absolute. "Reset to detected" clears the flag. This is the contract that makes auto-suggestion safe.

### 4.16 · Don't auto-apply hub-level decisions

Hub-open / hub-close are the highest-stakes moves in AS. The engine is **strictly advisory** for hub moves, *even at* `tier === "apply-auto"`. Same for fleet-renewal capital decisions.

### 4.17 · Anti-spiral guardrails on reactive moves

Two engines facing each other (yours + a competitor's autopilot) can spiral prices to zero or frequencies to infinity. Every reactive system (pricing, frequency, service-profile) has a price-floor at `marginalCost × 1.05`, a frequency-doubling cooldown (max 1 freq increase / route / 2 weeks), and a `maxPriceMovePerWindow` cap.

### 4.18 · No silent default flips

`useRealDemandForLF`, `cargoYieldPerKgKm`, `dryRunOnly`, every default that affects observable user numbers — flipping these is a HIGH-severity regression unless explicitly versioned. The first activation of any user-visible flip prompts a confirm.

### 4.19 · Bridge / transitional code stays minimal

If you're shipping a bridge between two states (legacy → new schema, dry-run → live, A → B migration), prefer disposable inline mechanisms over robust architecture. The bridge gets deleted when the long-term infra lands. (User feedback memory.)

### 4.20 · The mantra trumps the spec

When reading any plan: if a recommendation contradicts the one-line mission ("show me every decision and let me veto each one until I trust the engine"), the mission wins. Re-derive the recommendation.

---

## 5 · The Mental Model — one-page architecture

```
                                 ┌────────────────────────────────────┐
                                 │  The user's session                 │
                                 │  (one or many airlines, worlds)    │
                                 └───────────────────┬────────────────┘
                                                     │
                       ┌─────────────────────────────┴──────────────────────────────┐
                       │                                                            │
        ┌──────────────▼───────────────┐                          ┌─────────────────▼──────────────┐
        │   Surfaces (the cockpit)     │                          │   Bus (the integration         │
        │   • Central Hub tiles        │                          │     contract)                  │
        │   • Per-page panels          │◀──────  emits / on  ───▶│   window.AesAfp.bus            │
        │   • Strategy modal           │                          │   window.AesStrategy.bus       │
        │   • Flight Studio sidebar    │                          │   chrome.storage.onChanged     │
        │   • Toast / N2 notifications │                          │                                │
        │   • Cmd-K command palette    │                          └────────────────────────────────┘
        └──────────────┬───────────────┘
                       │
        ┌──────────────▼─────────────────────────────────────────────────────────────┐
        │   AesStrategy — the unifying engine                                          │
        │   ─────────────────────────────────────────────────────────────────────    │
        │   snapshot() → scoreRoutes() → allocateFleet() → diffPlan() → apply()        │
        │                          ↓                                  ↓               │
        │              proposeRouteCreations()           recordOutcome() → learn()    │
        │              proposePriceMoves()                                             │
        │              proposeServiceMoves()             explain() · riskProfile()    │
        │              proposeCrewMoves()                                              │
        │              proposeFleetRenewal()                                           │
        │              proposeHubMoves()                                               │
        │              proposeAlliancePartners()                                       │
        │              proposeMarketingSpend()                                         │
        └──────────────┬───────────────────────────────────────────────┬─────────────┘
                       │                                               │
        ┌──────────────▼───────────────┐               ┌───────────────▼────────────────┐
        │   Read stores                │               │   Write actuators              │
        │   (the senses)               │               │   (the muscles, two-gated)     │
        │   ─────────────────────────  │               │   ──────────────────────────── │
        │   demand · distance · ORS    │               │   AesAfpFleetApplyOrchestrator │
        │   markets (4 fams) · carriers│               │   RouteAssistantPricingApplier │
        │   yield · type-specs         │               │   ServiceProfileApplier        │
        │   maintenance · wear · log   │               │   StaffPilotsApplier           │
        │   crew · fleet · sisters     │               │   StrategyRouteCreationApplier │
        │   accounting ledger · ORS    │               │   FormDriver (reads-only here, │
        │   sandbox · interline        │               │     no submit)                 │
        │   contractual partners       │               │                                │
        │   alliance · airport-meta    │               │   Future: pay-tier · marketing │
        │   flightsfrom · enterprises  │               │   slot-bidder · IL-request     │
        │   competitor footprints      │               │                                │
        └──────────────────────────────┘               └────────────────────────────────┘
                       ▲                                               │
                       └───────────────  scrapers (sense)  ─────────────┘
```

**The loop:** sense → decide → apply → learn → re-sense.
**The contract:** every decision rationaled, every apply two-gated, every outcome attributable, every weight learnable.
**The shape:** read stores feed `snapshot()`, `snapshot()` feeds proposers, proposers feed `diffPlan()`, `diffPlan()` is the reviewable artefact, `apply()` runs gated actuators, outcomes feed `learn()`, learn updates weights, weights re-shape proposers.

This is the **only** mental model. New features are either a sense, a decide, an apply, a learn, a surface, or a federation primitive (Letter L). If a feature doesn't fit, the model is wrong — update §5 first.

---

## 6 · Strategic Pillars — the macro-themes every slice belongs to

Every slice in this project (every Strategy slice 1–32, every F slice, every Q/U QoL item, every Letter L slice, every auto-pricing tier, every ORS sandbox slice, every Conductor K slice, every pricing/service applier extension) maps to **exactly one** of these pillars. If you can't pick one, the slice is mis-shaped.

### Pillar I — SENSE
Read AS reliably. Normalise. Cache. Fail gracefully.
Examples: scrapers, demand-derivator, ORS lazy migration, contractual-partners, type-specs store, fuel-burn estimator, snapshot-store, airport-meta-scraper.
**Maturity:** ~85% (sensing is largely shipped; gaps are real-world reality overlay, marketing budget scrape, slot inventory scrape, pay-tier scrape).

### Pillar II — DECIDE
Score, rank, allocate, propose. Pure functions over `Snapshot`.
Examples: `decide-routes.js`, `allocate-fleet.js`, `route-creation.js`, `price-moves.js`, `service-moves.js`, `crew-moves.js`, `wave-route-fitter`, `wave-slot-scorer`, `optimizeAssignment`, ORS sandbox `project()`.
**Maturity:** ~80% (Slices 1–10 shipped; Slices 13 and 14 still open).

### Pillar III — APPLY
Two-gated, atomic, undoable, audited. Reuses existing actuators.
Examples: `apply-pipeline.js`, `pricing-applier.js`, `service-profile-applier.js`, `staff-pilots-applier.js`, `route-creation-applier.js`, `fleet-apply-orchestrator.js`, `il-request-applier.js`, future pay-tier-applier.
**Maturity:** ~65% (apply pipeline + 4 domains + service-tuner + pricing engine elaborations + IL-request actuator shipped (Slice 12, default `dryRunOnly:true` until live AS form calibration); crew pay-tier actuator (HTML inspection pending) / marketing / slot bidder still open).

### Pillar IV — LEARN
Close the loop. Outcomes, finite-difference learning, backtesting, drift detection.
Examples: `outcomes.js`, `learn.js`, future `backtest.js`, `synthetic-snapshot.js`, sandbox-backtest-store, model-fit summary.
**Maturity:** ~25% (Slice 5 foundation shipped; backtest harness + per-route P&L attribution + briefing UI still open).

### Pillar V — FEDERATE
Multi-account, multi-airline, multi-world. The canopy.
Examples: Letter L slices L1–L13, account-registry, account-scoped-key, affiliation graph, Strategy DNA, combined-supply analytics, cross-account wave coordination, sister coordination.
**Maturity:** ~15% (L1 shipped — account registry foundation; L2.1 / L2.2 / L3.1 shipped per HANDOVER; L4–L13 all open). This pillar is the highest-leverage upcoming work.

### Pillar VI — COMPOSE
Cross-module integration surfaces. Where domains meet.
Examples: Central Hub tiles, Strategy modal, Flight Studio sidebar (F1+F2+F3), Wave overlay, ORS Sandbox, Cmd-K command palette, executive briefing UI, network graph + time-scrubber.
**Maturity:** ~55% (Central Hub baseline + 14 tiles + Flight Studio F1 shipped; F2/F3, briefing UI, command palette, network graph still open).

### Pillar VII — POLISH
Daily-driver UX. Toasts, undo, hover, search, keyboard, theming, accessibility.
Examples: Q1–Q16, U1–U16 (most shipped — see HANDOVER); remaining: Q7 (settings presets), Q9 (bulk frequency), Q14 (fleet age heatmap), U2 (frozen leading columns), U3 (column groups collapse), U4 (right-click consolidation), U7 (column visibility), U9 (color-blind palette), U10 (keyboard nav), U13 (mini-map scroll), U16 (drawer pin).
**Maturity:** ~75% (most QoL shipped this past quarter; remaining items are accessibility + power-user affordances).

### Pillar VIII — ORCHESTRATE
Multi-scenario, multi-horizon coordination across the other seven pillars. Watch the whole airline, derive typed signals from every store write, match those signals against declarative scenarios, schedule routines (multi-step playbooks) against KPIs, and learn from outcomes which scenarios deserve more weight, which thresholds should move, which scrapes are worth refreshing more often.
The Conductor is the "what should the system pay attention to right now?" layer. It does not invent new actuators; it composes existing SENSE / DECIDE / APPLY primitives into goal-driven routines and surfaces a single attention queue to the user.
Examples: scrape-orchestrator auto-driver (shipped — adaptive cadence foundation), per-phase cadence store (shipped), Conductor signal layer (Slice K1), scenario engine (K2), routine state machines (K3), Conductor priority queue + dashboard tile (K9), trust quotient store (K11), outcome-weighted threshold learning (K13–K15), latent scenario discovery (K20). Strategy Slices 24 (standing orders), 27 (gossip feed), 23 (goal-seeker), 26 (lessons mining) and the Flight Schedule Grid maintenance overlay all fold under this pillar once the Conductor lands.
**Maturity:** ~5% (only the auto-drive cadence layer is shipped under SENSE; the scenario / routine / Conductor / learning surfaces are the Epoch H frontier — see `docs/CONDUCTOR-ROADMAP.md`).

### How pillars compose

A typical slice touches **2–3 pillars**, with a primary one. Examples:
- **F1 sidebar** (shipped): primary COMPOSE, secondary SENSE (reads demand/operators), tertiary DECIDE (profit estimate).
- **Slice 7 service tuner**: primary DECIDE, secondary APPLY (extends service-profile-applier), tertiary LEARN (closed-loop ORS validation).
- **Letter L Slice L7 combined-supply view**: primary FEDERATE, secondary COMPOSE (RA panel canopy toggle), tertiary SENSE (kin aggregation).
- **Conductor Slice K9 attention queue**: primary ORCHESTRATE, secondary COMPOSE (dashboard tile + briefing surface), tertiary LEARN (per-scenario trust quotient).

When proposing a slice, name its primary pillar in the title. It anchors review against drift.

---

## 7 · The Journey — epochs, not sprints

The next ~50 sessions cluster into seven epochs. Each is shippable on its own; each unlocks the next. **Within an epoch the order is flexible**; **across epochs, prerequisites must respect the dependency chain.**

### Epoch A · Close the strategy loop (sessions 1–10, primary: DECIDE + APPLY) — ✅ shipped
**Why first:** Slices 1–6 ship the spine. Slices 7–10 are the obvious continuation. Without them the engine has gaps where the user notices ("why doesn't it propose service changes?"). With them, the engine becomes a complete advisory voice across all five major decision domains (route / price / service / crew / schedule).

| Slice | Pillar | Notes |
| --- | --- | --- |
| Strategy Slice 7 — Service Profile Auto-Tuner | DECIDE + APPLY | ✅ Marginal-ORS-lift × demand × cost rank; A/B perturbation profiles in `service-moves.js`. |
| Strategy Slice 9 — Inventory Pricing Auto-Tuner | DECIDE + APPLY | ✅ Per-class S1 fallback (Y/C/F) + cargo asymmetric + orsHistory elasticity hint in `price-moves.js`. (Time-decay competitor band still pending a competitor-price history store.) |
| Strategy Slice 8 — Crew Pay & Hiring Auto-Tuner | DECIDE + APPLY | ✅ Perception model `pay-perception.js` + advisory pay decisions in `crew-moves.js`. Pay-tier scraper + applier deferred until live AS HTML inspection. |
| Strategy Slice 10 — Competitor Response Engine | DECIDE | ✅ `competitor-prior-store.js` + `competitor-response.js` with entry/exit/priceCut/freqAdd events; defensive/opportunistic counters; §4.17 anti-spiral guard. |
| Auto-Pricing Tier 3.3b — Silent-auto loop | APPLY + POLISH | ✅ `chrome.alarms` heartbeat in `background.js`, panel-side dedup + setInterval safety net, first-activation confirm modal, `silentAutoCap24h` + per-route/global cooldowns. |

**Acceptance:** the Strategy modal's decision list is non-empty across all five domains for any populated airline. Apply on a single test aircraft round-trips to AS. The decision count per session climbs as scrapers warm caches.

---

### Epoch B · Make the engine trustworthy (sessions 11–18, primary: LEARN + COMPOSE)
**Why next:** an engine that proposes without measuring itself is a black box, exactly what §4.4 forbids. Backtest + briefing + risk profiles are the trust layer.

| Slice | Pillar | Notes |
| --- | --- | --- |
| Strategy Slice 15 — Backtesting Harness | LEARN | ✅ `backtest.js` replays last N weekly accounting snapshots, attributes outcome deltas to applied decisions, optional cosine-weighted counterfactual for `alternativeWeights`. Strategy panel "Backtest" section: 4/8/12/26-week selector, summary line, inline SVG sparkline of cumulative profit (hypothetical dashed when alt weights set). Bonus: `recommend()` sensitivity sweep — K weight candidates (baseline + per-key ±15%/±30%) share one loaded bundle, ranks which perturbation directions erode attributed profit the least, and emits per-weight gradient hints (↑/↓ + magnitude). Panel CTA "Probe sensitivity" surfaces top-3 / bottom-3 candidates and the hint table. |
| Strategy Slice 16 — Executive Briefing UI | COMPOSE | One-page weekly summary modal that auto-opens once per game-week. Long-form rationale per applied decision. |
| Strategy Slice 17 — Risk Profiles + User Tuning | LEARN + POLISH | Conservative / Balanced / Aggressive presets; advanced sliders; live re-score preview. |
| ORS Sandbox Slice 4 — Workflow ergonomics (4a sweet-spot, 4b A/B, 4c saved scenarios, 4d batch) | COMPOSE | High-leverage workflow polish over an already-precise model. Slice 2c (per-route rating elasticity) lands before 4a. |
| ORS Sandbox Slice 5 — Visualisations (5a sparkline, 5b historic overlay, 5c heatmap) | COMPOSE | "Obviously effective" payoff. Reuses 4a's `scanPriceCurve` helper. |

**Acceptance:** Backtest runs on a 12-week window in <10s. Briefing modal opens automatically at game-week boundary. Switching risk profile re-scores routes deterministically. Sandbox sweet-spot scan returns within 200ms.

---

### Epoch C · Federate (sessions 19–30, primary: FEDERATE)
**Why now:** Letter L is the largest single feature on the roadmap and it's the gate to multi-account use. Once L1–L7 ship, the user's stated end state — "one cockpit for all my airlines across all worlds" — becomes real. Auto-login (the original Letter L+) stays explicitly deferred (see §10).

| Slice | Pillar | Notes |
| --- | --- | --- |
| L4 — Affiliation graph | FEDERATE | `aesCanopy:affiliations`; auto-classify from contractual-partners; user override always wins. |
| L5 — Cross-account read-only dashboard | FEDERATE + COMPOSE | Aggregator above existing per-server caches; unified portfolio view. Subsumes "Cross-server view" QoL row. |
| L6 — Strategy DNA (template + per-account override) | FEDERATE | Hybrid scope; effective-DNA = deepMerge; drift detection. |
| L7 — Combined-supply / effective-competition columns | FEDERATE + SENSE | RA panel "Canopy view" toggle; MyWk · Cmp* · FShare · Cannib · Gap?. Pure-function aggregator. |
| L8 — Geography (country/region as first-class dim) | FEDERATE + COMPOSE | Per-country demand pool, per-country kin presence, regulatory lens. New "Geography" tab. |
| Strategy Slice 11 — Cross-Airline / Sister Coordination | FEDERATE | Lifts `allocateFleet` to portfolio reasoning. Lease proposals between sisters. |
| Strategy Slice 12 — Alliance & IL Codeshare Optimisation | FEDERATE + DECIDE | ✅ Shipped. Connectivity bonus in `scoreRoutes`; per-card "Send IL request" with dry-run preview; per-account `alliance:ilRequestApplyLog:acct:<id>` ring. IL applier `dryRunOnly:true` until live AS form calibration. |

**Acceptance:** A user with two airlines on the same server sees: combined supply on contested hubs, kin cannibalisation warnings, cross-account gap routes, and a unified portfolio P&L. No data corruption: each airline's overrides / ORS readings / topRoutes stay isolated. Affiliation graph correctly classifies every observed enterprise.

---

### Epoch D · Capital decisions and network design (sessions 31–36, primary: DECIDE)
**Why now:** these are the highest-stakes moves; they need the trust layer (Epoch B) plus federation (Epoch C) plus the mature decision engine (Epoch A) all in place.

| Slice | Pillar | Notes |
| --- | --- | --- |
| Strategy Slice 13 — Fleet Renewal Planner | DECIDE | Retire / acquire / convert proposals based on lifetime profit + market deals. |
| Strategy Slice 14 — Hub Network Designer | DECIDE | Open / close hub candidates; **strictly advisory** per §4.16; network-effect scoring. |
| L9 — Cross-account wave coordination | FEDERATE + APPLY | Interline gateway detection; per-gateway wave audit; canopy wave editor. Tier-3 two-gate apply. |
| L10–L12 — Slot model + interline-aware schedule preset | FEDERATE | `aesCanopy:slots:<airport>` + canopy weight in `schedule-builder`. |
| Strategy Slice 19 — Marketing & Brand Investment | DECIDE + APPLY + SENSE | New scraper + applier; demand-elasticity model; budget allocation. |
| Strategy Slice 20 — Slot & Gate Trading | SENSE + APPLY | New slot scraper + bidder; auto-bid up to user-set max. |

**Acceptance:** Fleet renewal proposes retire/acquire candidates with rationale. Hub designer outputs candidates with network-effect scores; never auto-applies. Marketing budget moves only when demand is the binding constraint. Slot bids respect `maxBid` per slot.

---

### Epoch E · Flight Studio maturity (sessions 37–41, primary: COMPOSE)
**Why now:** F1 shipped the sidebar; F2 (templates) and F3 (multi-leg + station drawer) are the leg-by-leg power-user upgrades. Adjacent to (but independent of) the Strategy work.

| Slice | Pillar | Notes |
| --- | --- | --- |
| F2 — Templates | COMPOSE | Save / load named flight studio configs per server. `templates-store.js` + dropdown. |
| F3a — Multi-leg tray | COMPOSE | Replace single-leg form with stacked tray; drag candidates to add legs; batch Preview / Apply. |
| F3b — Station drawer | COMPOSE | Right-side drawer with full station detail; replaces the bulk-modal as the primary affordance. |
| Drag-to-Schedule (Phase 2 of `docs/PLAN-drag-to-schedule.md`) | COMPOSE | Drag candidate → wave-strip → toast → confirm → apply. `dragSubmitMode` setting. |
| Drag-to-Schedule (cross-page DnD to Fleet Schedule Grid) | COMPOSE | postMessage / chrome.storage handoff between AFP page and `/app/fleets*`. |

**Acceptance:** A power user composes a 5-leg day in <60s by dragging candidates onto the wave strip, with feasibility warnings live. Templates make the Morning Shuttle / Long-haul Evening / Cargo Overnight presets one click. Station drawer answers "is this airport viable?" without leaving Flight Studio.

---

### Epoch F · The thinking layer (sessions 42–47, primary: DECIDE + COMPOSE)
**Why now:** the engine is mature, federated, trusted. Now it gets a brain — scenarios, probabilistic reasoning, goal-seeking, standing orders. These compound with everything below them.

| Slice | Pillar | Notes |
| --- | --- | --- |
| Strategy Slice 21 — Scenario Forks (what-if branches) | DECIDE + COMPOSE | `forkSnapshot` + `simulateForward` + named fork tree. |
| Strategy Slice 22 — Probabilistic Demand & Risk Fans | DECIDE | Replace point estimates with P10/P50/P90 fans; risk-aversion term `λ × σ($/wk)`. |
| Strategy Slice 23 — Goal-Seeker | DECIDE | "Reach $500M cash by week 80" → beam-search over plan bundles. |
| Strategy Slice 24 — Standing Orders Rule Engine | DECIDE + APPLY | Declarative ongoing rules → emit decisions into the same plan stream. |
| Strategy Slice 25 — Network Graph & Time-Scrubber | COMPOSE | Force-directed network viz + time-scrubber that re-renders every panel against any prior snapshot. |
| Strategy Slice 26 — Strategy Journal & Lessons Mining | LEARN + COMPOSE | Auto-log every override + outcome; mine for patterns. |
| Strategy Slice 27 — Markets Gossip Feed | SENSE + COMPOSE | Anomaly events feed; feeds standing orders + briefing. |

**Acceptance:** The user can fork "buy 5× A350" and see a 12-week P&L tree. Every $/wk number ships with a risk fan. Goal-seeker returns the top-K plan bundles for any well-formed goal. Standing orders fire reliably. The network graph makes the airline's shape visible at a glance.

---

### Epoch G · The horizon (sessions 48–50+, primary: COMPOSE + POLISH + SENSE)
**Why last:** these are the "extension surfaces" — they layer on top of the mature engine to extend reach (LLM co-pilot, public API, real-world overlay, puzzle mode). Not blocking; not foundational; high optionality value.

| Slice | Pillar | Notes |
| --- | --- | --- |
| Strategy Slice 28 — Local LLM Co-Pilot | COMPOSE | WebLLM (in-tab WebGPU) or Ollama backend; tool-use bounded to existing read functions; **no cloud, no keys**. |
| Strategy Slice 29 — Command Palette + Spatial Pinboard | COMPOSE + POLISH | Cmd-K over every action; pinboard canvas. |
| Strategy Slice 30 — Public Read-Only API | COMPOSE | Localhost endpoint serving snapshot + journal + scenarios. Per-install token. |
| Strategy Slice 31 — Real-World Reality Check Overlay | SENSE | Bundled real-world O&D dataset; "AS says X, real-world says Y" column group. |
| Strategy Slice 32 — Scenario Puzzle Mode | COMPOSE | Sandboxed puzzle worlds with stated goals; local leaderboard. |
| Strategy Slice 18 — Multi-Game-World Federation | FEDERATE | Portfolio view across servers (already partially enabled by Letter L's account-registry; this completes the cross-world UI). |

**Acceptance:** the LLM co-pilot can answer "explain why JFK-EZE dropped to UNDER" with rationale grounded in cached snapshot + journal. Cmd-K feels native. Localhost API serves clean JSON. Reality overlay surfaces 5+ real-world flags per session for an active hub.

---

### Epoch H · The Conductor (sessions ~50–60, primary: ORCHESTRATE)
**Why now:** with the engine mature (A), trustworthy (B), federated (C), capital-aware (D), Flight-Studio-fluent (E), able to fork and goal-seek (F), and extended with the LLM co-pilot and Cmd-K (G), the Conductor is the layer that *runs the airline as a coherent whole*. It composes scenarios, routines, standing orders, and the goal-seeker into a single attention queue the user sees on the dashboard. It also runs the system's adaptive cadence — phase scrape frequencies, anomaly thresholds, and trust quotients — closing the loop on the auto-drive layer that Epoch A's Auto-Pricing Tier 3.3b started, the Slice 24 standing-order rule engine continued, and Slice 27 gossip feed almost completed. Full slice catalog lives in `docs/CONDUCTOR-ROADMAP.md`; below is the high-level shape.

| Slice | Pillar | Notes |
| --- | --- | --- |
| K1 — Signals layer foundation | ORCHESTRATE + SENSE | Typed events derived from every store write (`route.profit.delta`, `aircraft.maintenance.ratio.dropped`, `competitor.entered`, …). Ring-buffered to `aesConductor:signals`. |
| K2 — Scenario engine | ORCHESTRATE + DECIDE | Declarative match-pattern matchers over signal streams. Each scenario carries triggers, conditions, window, action, KPI. |
| K3 — Routine state machines | ORCHESTRATE + DECIDE | Multi-step playbooks: a `MaintenanceRebalance` routine waits on signals, runs sub-scenarios, applies actuators, tracks progress, self-suspends if losing. |
| K5 — Adaptive cadence | ORCHESTRATE + LEARN | Auto-tune scrape phase intervals based on observed change rate; downweight phases that produce empty deltas. |
| K9 — The Conductor (attention queue + tile) | ORCHESTRATE + COMPOSE | Dashboard tile: priority-sorted list of "what the system is paying attention to right now"; one-click drill into rationale; manual nudge / dismiss. |
| K11 — Trust quotient store | ORCHESTRATE + LEARN | Per-scenario score: (accepted / proposed) × (favourable outcomes / observed). Gates auto-apply tier per scenario, never global. |
| K13 — Outcome-weighted threshold learning | ORCHESTRATE + LEARN | EWMA / rolling z-score baselines per metric per tail/route/hub. Anomaly detection without hand-tuned thresholds. |
| K17 — Cross-pillar conflict resolution | ORCHESTRATE | When two scenarios want to act on the same resource (same tail's schedule, same route's price), the Conductor's priority queue + reservation lock arbitrates. |
| K20 — Latent scenario discovery | ORCHESTRATE + LEARN | Nightly batch finds signal-pair correlations; surfaces "when X fires, Y often follows within 3 days" as candidate scenarios for user review. |

**Acceptance:** the dashboard's Conductor tile lists 5–15 active scenarios across the user's airline(s) with one-line rationale each. Each item is one click from full input snapshot + projected outcome + Undo. The `auto · F 1m · H 28m · A 4h · R 18h` strip from the auto-drive layer evolves into per-phase trust ribbons that visibly tighten or relax as the system observes change-rate. A typical week sees 30+ scenarios fire, 10+ user-confirmed actions, and at least 3 scenarios whose trust quotient crosses a gate (either earning auto-apply for that user, or losing it).

---

### Sequencing notes

- **The epochs are not strictly sequential within sessions.** A session may close out an Epoch A slice and ship a Polish item from §6 or a P0 bug fix in parallel.
- **Polish slices are interleaved.** Pillar VII items (Q-series, U-series remaining) are picked opportunistically when an epoch slice ships and there's residual session.
- **Bug fixes outrank epochs.** A correctness regression in any shipped feature is the next thing to ship, regardless of epoch.
- **Letter L slices land in the order L4 → L5 → L6 → L7 → L8 → L9 → L10–L12.** L1–L3 (storage refactor + account registry foundation) are mostly shipped per HANDOVER; verify before extending.

---

## 8 · The Decision Rubric — how to pick what's next

When facing a choice between two candidate slices in any session, walk this checklist top-down. The first criterion that distinguishes the two wins.

1. **Is one a correctness regression?** Ship that.
2. **Is one a blocker for the next epoch?** Ship the unblocker.
3. **Does one close a half-feature** (e.g. add APPLY to a DECIDE-only slice)? Ship the closer.
4. **Does one expand the trust surface** (rationale, briefing, backtest, undo)? Prefer it — trust compounds.
5. **Is one a new APPLY path that lacks a LEARN attribution?** Ship the LEARN attribution before the new APPLY (§4.5).
6. **Does one introduce a new dependency, build step, or framework?** Don't ship it (§4.11).
7. **Does one violate canopy scoping** (Class A/B/C confusion)? Re-design before shipping.
8. **Does one need a new scrape that the existing scrapes can derive?** Use the existing scrape (§3 STRATEGY-ROADMAP principle).
9. **Does one have a 2-line "show me what'd post" path** (dry-run preview before live)? Prefer it.
10. **Default tie-breaker:** smaller diff, shorter blast radius, fewer files touched.

When in doubt: read §1 (the user's words). The slice that more directly serves "*allocate resources dynamically through the interface, with the user vetoing each step*" wins.

---

## 9 · How a "right-shaped" slice looks

Every slice that ships should answer YES to all of these. If any is NO, redesign.

- [ ] **Pillar named** (one of the seven; the slice's *primary* pillar in the title).
- [ ] **One-line user value** (concrete, observable outcome the user notices).
- [ ] **Files inventory** (added vs modified, each with a one-sentence purpose).
- [ ] **Reuses existing primitives** (cited by file path); doesn't re-implement what's already here.
- [ ] **Storage scoping correct** (Class A global / Class B per-account / Class C user-tuned per L's rubric).
- [ ] **Two-gate model** if any POST happens (§4.1).
- [ ] **Bus event added or reused** (no direct module references).
- [ ] **Defensive guards** for every cross-module dependency (`typeof X !== "undefined"`).
- [ ] **Manifest discipline** — load order verified; no AFP/fleets duplication; valid JSON.
- [ ] **Graceful degradation** when stores are missing or stale.
- [ ] **Pure-function core** if called from a render loop.
- [ ] **Audit log entry** if it writes anything to AS.
- [ ] **Undoable** if it changes user-visible state (or explicitly noted why not).
- [ ] **Storage budget budgeted** (cap, eviction, TTL).
- [ ] **Verification steps** (3–7 manual checks the user can run).
- [ ] **Open questions surfaced** before shipping, not after.
- [ ] **HANDOVER §1 entry** drafted in the same PR.
- [ ] **Invariant added to HANDOVER §10** if the slice introduces a new contract.
- [ ] **No emojis in code or docs** unless the user explicitly asked.
- [ ] **No new comments** explaining what well-named code already says (§project CLAUDE.md / global CLAUDE.md).

---

## 10 · Deferred — what we have explicitly NOT decided

These are the open questions. We have working defaults; we have not committed to the long-term answer. Each requires a user decision before its dependent work proceeds.

| # | Question | Working default | Blocker for |
| --- | --- | --- | --- |
| 1 | Auto-apply tier (`apply-auto`) — should it ever exist, or is `apply-on-confirm` the strictest tier? | `apply-on-confirm` is the default; `apply-auto` is opt-in but exists. | Slice 16 executive briefing's "automate weekly" affordance. |
| 2 | Cross-airline learning — should sisters share learned weights or learn independently? | Independent (each airline has its own weights). | Slice 11 portfolio learning. |
| 3 | Backtest depth — how many historical weeks to retain? | 200 weeks via `AccountingSnapshotStore` index cap. | Slice 15 deep-history backtests. |
| 4 | Marketing scrape cadence (etiquette concern). | Defer scraping until Slice 19. | Slice 19. |
| 5 | Hub-close decisions auto-applyable? | **No** (advisory only) — §4.16. | Slice 14 → confirmed advisory. |
| 6 | Service-profile A/B testing auto-create perturbation profiles? | Require user approval per perturbation. | Slice 7 A/B layer. |
| 7 | IL partner solicitation UX. | Engine recommends; user clicks "Send IL request" form-fill. | Slice 12. |
| 8 | Rollback budget — N applies undoable? | Last 3. | All APPLY slices. |
| 9 | Notification surface — Chrome desktop, in-page toasts, both? | Both, with `notifications` permission already in manifest. | Slice 24 standing orders fires. |
| 10 | Letter L+ (auto-login canopy with credential vault, hidden tabs, login automation). | **Deferred indefinitely** pending AS ToS re-evaluation + CAPTCHA/MFA fragility study. The L1–L13 plan ships *passive observation only*. | Long-tail of L+. |
| 11 | Cloud sync between devices for canopy state. | **Deferred** — local-only. | Multi-device users. |
| 12 | LLM co-pilot pluggable backend default (WebLLM in-tab vs Ollama localhost). | User picks in settings; no default. | Slice 28 install-experience. |
| 13 | Real-world reality dataset distribution (bundled vs live-fetched). | Bundled in v1; refresh via update channel. | Slice 31 staleness. |
| 14 | Right-click context menu consolidation (U4) vs inline glyph proliferation. | Inline glyphs survive; U4 adds an *additional* unified entry point, not a replacement. | U4 design. |
| 15 | Multi-leg drag (drop two destinations to build back-to-back) and bulk drag (multi-select). | Deferred to phase 3 of drag-to-schedule. | Drag-to-Schedule v3. |

When picking up a slice that touches any of these, raise the deferred question first; don't quietly assume the working default.

---

## 11 · How we work — disciplines across all sessions

Standing rules of engagement that compound across the next 50 sessions.

### 11.1 · Naming and numbering
- **Strategy slices** are numbered 1–32+ in `STRATEGY-ROADMAP.md`. Don't renumber.
- **Flight Studio slices** are F1, F2, F3a, F3b in `FLIGHT-STUDIO-ROADMAP.md`.
- **Letter L slices** are L1–L13 (cross-account federation). Auto-login is L+.
- **QoL slices** are Q1–Q16 (functional) and U1–U16 (UI/interaction) per HANDOVER §9.
- **ORS Sandbox slices** are I.1 through I.6, sub-numbered (2a, 2b, …).
- **Auto-Pricing tiers** are 1, 2a, 2b, 3.1, 3.2, 3.3a, 3.3b, 4.
- **Conductor slices** are K1–K20+ in `CONDUCTOR-ROADMAP.md` (Pillar VIII / Epoch H). Letter K reserved for the Conductor; sub-numbered (K3a, K3b, …) when sub-slicing is needed.
- A new slice category (J, M, N, …) gets its own letter; document the letter assignment in HANDOVER.

### 11.2 · Doc updates per slice
Every slice that ships in a session updates these in the same PR / commit:
- `HANDOVER.md §1` — the "shipped this session" entry with feature/verification matrix.
- `HANDOVER.md §10` — any new invariant introduced.
- `HANDOVER.md §4` — any new `chrome.storage.local` key.
- `HANDOVER.md §9` — flip the slice's status from open to ✅.
- The relevant roadmap doc (Strategy / Flight Studio / etc.) — flip status.
- `NORTH-STAR.md` — ONLY when a principle, pillar, or epoch changes. Not for every slice.

### 11.3 · Pre-PR checklist
Run before every commit:
- `python3 -c "import json; json.load(open('manifest.json'))"` — manifest valid JSON.
- `node --check <each new .js>` — clean.
- AFP/fleets de-dup verified (`set(afp_js) & set(fleets_js)` empty).
- Settings export round-trips through `RouteAssistantSettings.save` / `UsedAircraftPresets.save`.
- No new dependencies in `package.json` (vanilla JS only).
- No `console.log` left in (`console.warn` only on actual failures).
- All new modules header-docstring matches existing style.
- No emojis in code unless user requested.
- Storage stress test — namespace stays under budget (1 MB strategy, 10 MB total).

### 11.4 · The branch / PR shape
- One slice → one PR by default.
- A "PR-N" boundary in `STRATEGY-ROADMAP.md §VII` may bundle 2–3 cohesive slices when they share a tier-gate flip or settings migration.
- Branch name: `slice/<letter-or-number>-<slug>` (e.g. `slice/e-integration` for the recent F1 work; `slice/strat-7-service-tuner` for next).

### 11.5 · The session handover
Every session that ships work writes to `HANDOVER.md §1` with:
- The slice ID and pillar.
- The user value in one sentence.
- The feature matrix (UX surfaces / data model / settings flags / storage keys).
- The verification matrix (steps you ran; what passed; what's deferred).
- Any new invariant added to §10.
- Any new "what's been said" entry in §11 if the user clarified intent.

### 11.6 · The "show me what'd post" pattern
Every new APPLY path ships a dry-run-preview affordance *before* it ships its live POST. The user always has one click to see what AS would receive before authorising the request. This is non-negotiable for new actuators (§4.1 + §4.18).

### 11.7 · The "veto every decision" pattern
Every new DECIDE pipeline ships its rationale + diff UI *before* it ships any APPLY connection. The Strategy modal's decision list must populate even when no apply path exists. This is what makes the engine trustworthy: the user sees what it *would* propose long before it's allowed to act.

### 11.8 · The "one read at a time" pattern
Slices read one bus event or one storage key at a time. Multi-source reads happen in pure-function aggregators (`snapshot()`, `_assembleOrsSandboxRoute`, etc.). Adding a new aggregator is fine; bypassing them with ad-hoc cross-store reads in a render closure is not.

### 11.9 · The deferred-decision protocol
When a slice hits a §10 deferred question, raise it explicitly in the PR description (or this session's HANDOVER §11 "what's been said"). Don't quietly pick a path.

### 11.10 · The "delete bridges when long-term lands" rule
Per project memory: throwaway transitional code (legacy migrations, schema bridges, dry-run shims pending live) stays minimal and gets deleted when long-term infra lands. Don't over-engineer the bridge.

---

## 12 · Risks we're carrying

Things to watch across the next 50 sessions. None are blocking; all could become so.

| Risk | Mitigation |
| --- | --- |
| **Storage growth.** Per-route stores × hubs × airlines × game-worlds compounds quickly under canopy. | The 1 MB strategy budget; per-store eviction; periodic audit in HANDOVER §4. |
| **AS markup drift.** Wicket markup, AS HTML structure, flightsfrom SSR can change without warning. | Defensive parsing, `parserNotes` on every record, scrapers degrade to partial records. |
| **Tier gate erosion.** 50+ sessions of feature pressure can tempt "just this once" bypass paths. | §4.1 + §11.6 + code review against the two-gate pattern; never collapse the gates. |
| **Anti-spiral feedback.** Our auto-pricer + a competitor's auto-pricer = race-to-zero. | §4.17 floors and cooldowns; backtest harness watches for it. |
| **AS ToS on automation.** Background tabs, hidden logins, scrape cadence. | Letter L+ deferred; current scrapers respect their configured cadence; never open hidden tabs solely to scrape. |
| **Manifest fragility.** A wrong load order or a missing `_shared` script silently breaks a page. | §11.3 pre-PR checklist; defensive `typeof` guards (§4.13). |
| **Slice sprawl.** 32 strategy slices + Letter L 13 + F1–F3 + Q/U + ORS sandbox + auto-pricing = lots of in-flight work. | This document. The pillar mapping. The decision rubric. The seven-epoch cadence. |
| **User trust drift.** A confidently-wrong recommendation early erodes trust permanently. | Trust layer (Epoch B) before scale (Epoch C onward); confidence pills + model fit before any auto-apply tier. |
| **Documentation rot.** Three roadmap docs + HANDOVER + this doc + per-feature plans = drift surface. | This doc is the only "supreme" doc. Others are working docs. When this contradicts them, this wins or this changes — never both stay. |

---

## 13 · The mantra

> *"Run the airline for me, but show me every decision and let me veto each one until I trust the engine."*

Read it before every session.
Read it when picking what to ship.
Read it when tempted to bypass a gate.
Read it when sketching a new feature.
Read it when this document feels too long.

Every slice in this project answers a piece of that line. The engine never wins authority by default; it earns it slice-by-slice as the user observes its proposals matching their intuition and its applies producing measurable wins.

---

## 14 · Living amendments

When this document changes, log the change here in one line. Anyone reading the diff knows what shifted.

| Date | Change | By |
| --- | --- | --- |
| 2026-04-28 | Initial draft. Synthesises STRATEGY-ROADMAP, FLIGHT-STUDIO-ROADMAP, PLAN-drag-to-schedule, HANDOVER §1/§9/§10/§11 into one constitutional doc. Seven pillars, seven epochs, 20 first principles, one mantra. | session 2026-04-28 |
| 2026-04-29 | Added Pillar VIII (ORCHESTRATE) and Epoch H (The Conductor). Reserved letter K for Conductor slices. New companion doc `docs/CONDUCTOR-ROADMAP.md` covering signal layer, scenario engine, routine state machines, adaptive cadence, trust quotient, and the Conductor attention queue. Folds Strategy Slices 23/24/26/27 + the just-shipped scrape auto-drive cadence layer under the new pillar. | session 2026-04-29 |
| 2026-04-29 | Strategy Slice 12 (Alliance & IL Codeshare Optimisation) shipped — first FEDERATE + DECIDE slice in Epoch C to fully integrate. Pillar III maturity bumped 60% → 65% with IL-request actuator now in the example list (`dryRunOnly:true` until live AS form calibration). New first-principle bound by `dryRunOnly` two-gate model — see HANDOVER §10 invariant. | session 2026-04-29 |
| 2026-04-29 | §4.2 form-driver invariant tightened — explicitly carves out `fillAndSubmit()` as the single exception (gated background pipeline only via `aes:afp:fill-and-submit` chrome.runtime message). The previous "NEVER POSTs and NEVER calls submitBtn.click()" wording was strictly tighter than reality; the deliberate exception was buried in HANDOVER §10. Wording change only — no code or behaviour change. | session 2026-04-29 wiring-pass |

---

*End of North Star.*
