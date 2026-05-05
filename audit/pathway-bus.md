# Bus pathway audit (read-only)

Static analysis only — agent G, parallel to live edits in six other agents.
No code edited; no Chrome instances launched.

## Inventory

| Bus                  | Producers (`.emit`/`.publish`) | Consumers (`.on`) |
|----------------------|--------------------------------|-------------------|
| **CentralHubBus**    | 87 emits across 32 files       | 29 `.on(...)` + 12 `subscribeBus(...)` (CentralHubTile helper) |
| **AesDataBus**       | 71 emit/publish hits across 27 files; 8 distinct `await chrome.storage.local.set(...)` → `AesDataBus.emit(...)` pairs (settings, demand, scanner price-history, schedule, ors, airportOverview, markets, service-profile, accounting snapshot, AFP maintenance/flightLog, crewMgmt, competitor snapshot, decision-dispatch, service-experiment outcomes) | 14 `.on(...)`; one dynamic `data:storage:hub-tile:<id>:<prefix>` per tile via `CentralHubTile._attachStorageListener` (modules/central-hub/tile.js:419-421) |
| **AesAfp.bus**       | 29 emits (host.js:701, 817, 1102; route-candidates.js:222, 268, 572, 754; wave-applier.js:176, 559; spec-resolver.js:89; maintenance-scraper.js:131; wear-model.js:216; allocator.js:576; preview-panel.js:935, 1132, 1494; fleet-apply-orchestrator.js:73; apply-batch.js:68; flight-studio/panel.js × N; flight-studio/station-drawer.js:61; diagnostics.js:293) | 15 `.on(...)` (audit-log.js × 7, diagnostics.js × 3, host.js:949, maintenance-scraper.js:178, schedule-broadcaster.js:117, spec-resolver.js:276, route-candidates.js:1342–1351, wave-applier.js:1060-1062, maintenance-widget.js:259-262, form-driver.js:736-737, preview-panel.js:1897-1917, flight-studio/panel.js:2460-3102) |
| **AesStrategy.bus**  | 12 emits via `window.AesStrategy.bus.emit(...)` (canopy/* × 6, fleet-optimizer-settings.js:114, rebalance-applier.js:76, layered/family-store.js:158, layered/division-store.js:85, layered/fleet-store.js:64, strategy-briefing-tile.js:865) | **0 listeners.** No `AesStrategy.bus.on(...)` exists anywhere. |
| **AesView**          | 2 declares (`routes:fuel-context`, `scanner:fuel-context`); engine emits `view:<name>:computed` per recompute | 3 `.subscribe(...)` (auto-driver `routes:fuel-context`, market-panel/panel.js `scanner:fuel-context`, hub-feed.js wrapper) |

## Topic registry coverage

`modules/_shared/data-bus-topics.js` registers **22 topics** via `AesDataBus.register(...)`.

- **With producer + ≥1 consumer (or storage-bridge sink):** 8
  - `data:competitor-intel:enterprise:updated` — emit + competitor-monitoring-tile
  - `data:competitor-intel:enterprise:diff` — emit + competitor-monitoring-tile
  - `data:crewMgmt:payTier:applied` — emit + auto-driver
  - `data:strategy:dispatch:applied` — emit + weekly-review-tile
  - `data:strategy:serviceExperiment:concluded` — emit + weekly-review-tile
  - `data:route-assistant:fuel-price:updated` — publish + AesView routes:fuel-context + scanner:fuel-context
  - `data:route-assistant:settings:saved` — emit + scanner view + routes view (deps)
  - `signal:strategy:competitor-threat` / `signal:strategy:cash-low` — emit + auto-driver
- **Registered but with NO direct subscriber on the bus** (storage-fan-out only — consumers re-fetch via storage; not strictly broken but worth flagging):
  - `data:route-assistant:demand:saved`
  - `data:route-assistant:markets:updated`
  - `data:route-assistant:serviceProfile:updated`
  - `data:route-assistant:serviceProfile:applied`
  - `data:route-assistant:ors:updated`
  - `data:route-assistant:schedule:updated`
  - `data:route-assistant:airportOverview:updated`
  - `data:route-assistant:pricing:applied`
  - `data:scanner:price-history:appended`
  - `data:crewMgmt:staffOverview:saved`
  - `data:afp:maintenance:updated`
  - `data:afp:flightLog:appended`
  - `data:accounting:snapshot:updated`
  - `data:strategy:dispatch:pending`
  - **`signal:strategy:wear-pressure`** — emitted by `modules/aircraft-flight-plan/maintenance-store.js:119` but `auto-driver.js` does NOT subscribe (it walks `snapshot.fleet[].wear.ratioStatus` directly at apply-pipeline.js wear-pressure gating). This contradicts the registry note "Consumed by auto-driver to drop schedule-domain candidates".
  - **`signal:strategy:crew-pressure`** — emitted by `crew-management/content-staff-overview.js:34`; no `.on(...)` subscriber. The registry says "Consumed by price-moves/service-moves to dampen aggressive moves" but those modules read the snapshot's pre-built crew block, not the bus.
- **Phantom topics (emitted but NOT in registry):** 13
  - `data:account:bootstrapped` (shell.js:56 + feed/index.js:66; consumed by store-cache.js + cash-feed + strategy-feed)
  - `data:accounting:weekly:saved` (feed/index.js:35; consumed by cash-feed)
  - `data:strategy:applied:saved` (feed/index.js bridge :45; consumed by strategy-feed)
  - `data:strategy:settings:saved` (feed/index.js bridge :52; consumed by strategy-feed)
  - `data:strategy:layered:family-changed` (layered/family-store.js:160 publish)
  - `data:strategy:layered:division-changed` (layered/division-store.js:87)
  - `data:strategy:layered:fleet-changed` (layered/fleet-store.js:66)
  - `data:strategy:layered:route-extras-changed` (layered/route-extras-store.js:70)
  - `data:command-palette:<kind>` (command-palette/host.js:475 — variable suffix; topic name is dynamic)
  - `data:storage:hub-tile:<tileId>:<prefix>` (central-hub/tile.js:419 — dynamic per tile + storage prefix)
  - `view:<name>:computed` (view-engine.js:178/190 — engine internal; 2 distinct names possible)
  - `view:scanner:fuel-context:computed` (panel.js declare)
  - `view:routes:fuel-context:computed` (views/routes-fuel-context.js declare)

## Findings

### G-001 — `AesStrategy.bus` referenced by 12 emits but never created [P1]
- Files emitting:
  - `modules/canopy/orgs-store.js:35`, `affiliations-store.js:96`, `dna-store.js:95`, `regions-store.js:33`, `wave-preset-meta-store.js:40`, `role-store.js:83`
  - `modules/strategy/fleet-optimizer-settings.js:114`
  - `modules/strategy/rebalance-applier.js:76`
  - `modules/strategy/layered/family-store.js:158`, `division-store.js:85`, `fleet-store.js:64`
  - `modules/central-hub/tiles/strategy-briefing-tile.js:865`
- Files probing for the bus to subscribe (multi-bus broadcaster pattern):
  - `modules/_shared/drag-arbiter.js:69` (push to `buses[]`)
  - `modules/route-assistant/wave-palette.js:58`
  - `modules/route-assistant/wave-overlay.js:970`
- Cause: nothing in the codebase ever assigns `window.AesStrategy.bus`. The `AesStrategy` namespace is created lazily in `route-creation.js`, `crew-moves.js`, `diff-plan.js`, `apply-pipeline.js`, etc. via `window.AesStrategy || (window.AesStrategy = {})`, but no module attaches a `.bus` property. Compare with `AesAfp.bus` which is set in `aircraft-flight-plan/host.js:1130` (`bus: createBus()`).
- Effect: every `AesStrategy.bus.emit(...)` short-circuits via the surrounding `if (window.AesStrategy && window.AesStrategy.bus)` guard — so it silently no-ops. The fan-out to `AesAfp.bus` and `CentralHubBus` still works, but the "AesStrategy bus channel" claimed by `rebalance-applier.js:45` ("CentralHubBus + AesStrategy.bus") never actually exists.
- Fix proposal: in `modules/strategy/apply-pipeline.js` (the strategy bundle's earliest-loading file) add a one-liner: `if (!ns.bus) ns.bus = (function() { /* same shape as journal-store.js _createBus */ })()`. Then re-test that journal-panel / multi-bus broadcasters fire on the strategy channel.

### G-002 — `signal:strategy:wear-pressure` orphan emit [P1]
- Producer: `modules/aircraft-flight-plan/maintenance-store.js:119` emits when `ratioStatus` is `warn`/`bad`.
- Registry contract (`data-bus-topics.js:190`) says: "Consumed by auto-driver to drop schedule-domain candidates; by salience scorer to boost fleet/maintenance tile."
- Reality: `modules/strategy/auto-driver.js:594-603` derives wear-pressure synchronously from `snapshot.fleet[].wear.ratioStatus`, not from the bus. No `AesDataBus.on("signal:strategy:wear-pressure", …)` exists anywhere.
- Effect: the signal fires but nothing reacts. Contract drift between registry and code.
- Fix proposal: either (a) add `AesDataBus.on("signal:strategy:wear-pressure", …)` to auto-driver alongside the existing `_competitorThreatOff` and `_cashLowOff`, OR (b) update the registry note to remove the "consumed by" claim.

### G-003 — `signal:strategy:crew-pressure` orphan emit [P1]
- Producer: `modules/crew-management/content-staff-overview.js:34` emits with severity hint.
- Registry contract: "Consumed by price-moves/service-moves to dampen aggressive moves; by salience scorer to boost crew tile."
- Reality: `price-moves.js:328` reads `snapshot.crew.pressure` (built in `context.js:718`). No bus subscriber. Same shape as G-002.
- Fix proposal: same options — wire a real `.on(...)` or amend the docstring.

### G-004 — `auto-apply:requested` and `auto-apply:retry-requested` are observability-only emits with no consumer [P2]
- `modules/aircraft-flight-plan/auto-scheduler/preview-panel.js:1494` emits `auto-apply:requested` but immediately calls the orchestrator directly (`AesAfpAutoScheduler.applyBatch.start(...)` etc. inside `_applyAll`). Same for `auto-apply:retry-requested` at lines 935 and 1132.
- No `bus.on("auto-apply:requested", …)` anywhere. EVENTS.md §1 lists them but doesn't say they are bare signals.
- Effect: dead emit. Diagnostics still records them via `diagnostics.js` (it wraps `bus.emit`), so they're not entirely useless, but other modules cannot listen to them as advertised.
- Fix proposal: either delete the emit, or refactor `_applyAll` to be the listener (apply-batch starts only on the bus event, decoupling the trigger). Today the emit is misleading.

### G-005 — Canopy stores triple-fan-out to a non-existent bus [P2]
- `modules/canopy/{orgs,affiliations,dna,roles,regions,wave-preset-meta}-store.js:_emit` always tries CentralHubBus + AesAfp.bus + AesStrategy.bus. Two of the three are valid; the third (G-001) silently no-ops.
- Effect: cosmetic noise plus a fixed-size silent failure on every change. Once G-001 is fixed, the fan-out actually works.
- Fix proposal: addressed by G-001.

### G-006 — `briefing:dismissed` is a self-loop [P2]
- `modules/central-hub/tiles/strategy-briefing-tile.js:479` emits `briefing:dismissed` via `_emitBus` → `CentralHubBus.emit + AesStrategy.bus.emit`.
- The same file at line 45 subscribes via `subscribeBus("briefing:dismissed", …)` — its OWN handler.
- Effect: the tile dismisses → emits → handles its own emit → re-renders. Not a broken loop today (handler is idempotent and only resets visibility) but is a pump-back pattern. If the dismissed handler ever calls `_emitBus("briefing:dismissed", …)` again it would be a hard infinite loop.
- Fix proposal: collapse to a direct method call OR add a guard flag.

### G-007 — `tile-pin-changed` / `tile-pinned` / `tile-unpinned` orphan emits [P3]
- `modules/central-hub/pin-affordance.js:170, 196` emits all three. No `.on(...)` subscriber anywhere. Diagnostics-tile listens to `tile-registered` and `waves:preset-updated` but not pin events.
- Effect: dead emit. Likely intended for future personalisation tracking.
- Fix proposal: track in a "deferred listener" comment or remove until a consumer ships.

### G-008 — `tile-registered` consumer with no producer [P3]
- `modules/command-palette/derivers/tiles.js:97` calls `bus.on("tile-registered", syncCommands)`. No producer of `"tile-registered"` exists in the codebase. The tiles registry uses its own callback (`reg.subscribe`) plus a CentralHubBus event named `tile-registered` that nothing emits.
- Effect: dead listener — the command palette never picks up newly registered tiles via this path. The `reg.subscribe(function (evt) { … })` path on the line just above this DOES work, so the feature isn't broken — but the bus listener is wired to a non-existent topic.
- Fix proposal: drop the `.on("tile-registered", …)` line, or have the tiles registry also emit on the bus when a tile registers (cleaner).

### G-009 — `studio:station-drawer-opened` / `studio:station-drawer-closed` emitted via wrapper, no bus consumer [P3]
- `modules/aircraft-flight-plan/flight-studio/station-drawer.js:54, 141` use `_emit(event, payload)` which forwards to `AesAfp.bus.emit`. No `bus.on("studio:station-drawer-…")` exists.
- Effect: dead emit; emit body is one-line and cheap, but EVENTS.md catalogs it as an event.
- Fix proposal: tag in EVENTS.md as "observability-only" or wire `audit-log.js` to record.

### G-010 — `data:strategy:dispatch:pending` registered but no bus consumer [P2]
- `modules/strategy/decision-dispatch.js:62` emits when a dispatch lands. Registry note says "Strategy panel reads aesStrategy:dispatchPending via readPending() to scroll/select" — i.e. the PANEL re-reads storage, not the bus. So the bus event is fired but no JS listener.
- Effect: emit lands in the data-bus history ring (helpful for inspector) but nothing reacts. Could be an intentional event-as-tombstone; should be documented as such.

### G-011 — Duplicate emit-on-same-channel: `fleet-optimizer:target-changed` [P3]
- `modules/strategy/fleet-optimizer-settings.js:111-114` fires the SAME payload to BOTH CentralHubBus AND `AesStrategy.bus`. Per G-001, the second emit no-ops, so today this is a non-issue, but post-G-001 fix it would mean all listeners receive it twice (once per bus) since most "listening" tiles subscribe to CentralHubBus only.
- Fix proposal: pick one bus per topic. Cross-bus broadcasters (drag-arbiter, wave-palette, wave-overlay) handle de-dup at the receiver via a Set, but tiles do not.

### G-012 — Phantom topics emitted but absent from `data-bus-topics.js` [P2]
See "Phantom topics" list above (13 topics). The data-flow inspector tile will surface every one as "discovered" drift the next time `auditTopics()` runs. Most have legitimate consumers (e.g. cash-feed reads `data:account:bootstrapped` and `data:accounting:weekly:saved`); they just aren't registered. The four `data:strategy:layered:*-changed` `publish(...)` calls are registered nowhere either, although the layered store IS the only producer/consumer of its own values via `AesDataBus.last()`.
- Fix proposal: add registry entries for at least the cross-module ones (`data:account:bootstrapped`, `data:accounting:weekly:saved`, `data:strategy:applied:saved`, `data:strategy:settings:saved`, the four `data:strategy:layered:*-changed`).

### G-013 — Strategy tile listens for `strategy:auto-tick-stage` — never registered, but producer exists in auto-driver [P3]
- `modules/strategy/auto-driver.js:363` emits `strategy:auto-tick-stage` on CentralHubBus. The strategy tile listens (`tiles/strategy-tile.js:750`). Working channel, but topic is on CentralHubBus and is undocumented in any registry. Same applies to `strategy:service-experiment-{started,concluded,consolidated}` (service-tuner.js → strategy-tile.js).
- Effect: works at runtime; brittle because nothing prevents a typo from silently muting the tile.
- Fix proposal: extend `data-bus-topics.js` (or a sibling `central-hub-bus-topics.js`) to register CentralHubBus topics too. Today the registry only covers AesDataBus.

### G-014 — `subscribeBus` (CentralHubTile.subscribeBus) used but underlying bus may not be ready [P3]
- `modules/central-hub/tile.js:68` `subscribeBus` checks `window.CentralHubBus && typeof window.CentralHubBus.on === "function"` and bails silently otherwise. On bridge.html / non-dashboard pages where central-hub/bus.js isn't loaded, every tile's `_wireBus` is a no-op without warning. Combined with replay (CentralHubBus stores per-event last record), this means cross-page open-tile intent fires before subscribers attach AND replay isn't called → intent is lost.
- Confirmed cases: `central-hub/shell.js:1058` does call `replay("open-tile")` after wiring; `fleet-schedule-grid/host.js:54` does likewise. But other tiles (route-launcher, fleet-hub-tile, alliance-tile, world-view-tile, competitor-monitoring-tile, strategy-briefing-tile) call `subscribeBus` with no replay, so a focus-* fired before the tile mounted is dropped.
- Fix proposal: have `subscribeBus` automatically `bus.replay(event)` synchronously after attach when the caller passes `{withReplay: true}`. CentralHubBus already has `replay()`; the helper is the missing layer.

### G-015 — Stale `bus-bridge` references: ZERO [info]
- `grep -rn "AesBusBridge\|attachCentralHub\|attachAesAfp\|bus-bridge"` returned zero hits across `modules/` and root JS. F-9223-001 cleanup is complete.

## Cross-bus inconsistencies

- **Same topic on two buses:**
  - `fleet-optimizer:target-changed` — emitted on both CentralHubBus and AesStrategy.bus (G-011).
  - `fleet-optimizer:proposal-applied` — same dual emit in `rebalance-applier.js`.
  - `wavepalette:preset-activated`, `waveeditor:wave-cloned`, `waveeditor:wave-archived`, `waveeditor:wave-split`, `waves:preset-updated` — fan out via the multi-bus broadcaster pattern (CentralHubBus + AesAfp.bus + AesStrategy.bus). Receivers subscribe to ONE bus only, so this is fine, but a post-G-001 fix means receivers wired to AesStrategy.bus will start seeing duplicate events alongside CentralHubBus.

- **Topic-naming convention violations:**
  - Mixed colon-style: AesDataBus topics (`data:<module>:<slice>:<verb>`) vs CentralHubBus topics (`canvas:hub-changed`, `focus-route`, `open-tile` — kebab + colon mix, not a uniform 3-segment grammar).
  - `aesStrategy:plan:applied`-prefixed STORAGE keys (camelCase prefix + colon) bleed into CentralHubBus topic names like `strategy:auto-tick-stage` — both styles coexist with no central registry.
  - `aesStrategy:` keys are storage keys, NOT bus topics, but are referenced in a way that visually resembles bus topic names. Easy to confuse — and decision-dispatch.js mixes both worlds in one file.

## Producer→consumer matrix (top topics by surface area)

| Topic                                | Producers | Consumers | Notes |
|--------------------------------------|-----------|-----------|-------|
| `open-tile`                          | 11        | 2 (shell, fleet-schedule-grid) | Replayed in shell + grid only |
| `focus-route`                        | 6         | 3 (route-launcher (no), competitor-monitoring-tile, world-view-tile) | Heavy fanout |
| `focus-aircraft`                     | 6         | 3 (route-launcher-tile, fleet-hub-tile, fleet-schedule-grid host) | |
| `focus-enterprise`                   | 2         | 2 (alliance-tile, competitor-monitoring-tile) | |
| `strategy:decision-applied`          | 1 (apply-pipeline) | 4 (RA panel, fleet-hub command-center, strategy-tile, strategy-briefing-tile, diagnostics-tile) | |
| `waves:preset-updated`               | 3 (wave-strip, wave-editor, route-candidates) | 4 (RA panel, wave-strip self, route-candidates, fleet-hub, diagnostics-tile) | Self-listen risk |
| `canvas:edit-staged`                 | 4 (canvas-shell, demand-overlay, silent-auto-proposers, rail-controller, advisor-engine) | 2 (rail-controller, advisor-engine) | Pump-back protected via batchId regex (rail-controller:540) |
| `ctx:ready` (AesAfp)                 | 3 (host, route-candidates, sidebar refresh) | 7+ (audit-log, form-driver, maint-scraper, route-candidates, schedule-broadcaster, spec-resolver, wave-applier, maintenance-widget, preview-panel, flight-studio, station-drawer) | Properly central |
| `candidate:selected` (AesAfp)        | 4 (route-candidates, wave-applier, diagnostics, host?) | 3 (audit-log, diagnostics, form-driver, flight-studio) | |
| `candidates:updated` (AesAfp)        | 2 (route-candidates) | 5 (host, wave-applier, preview-panel) | |
| `auto-apply:start/progress/done/aborted/error` | 1 each (apply-batch.js) | 2 each (preview-panel, flight-studio) | Healthy |
| `conductor:signal`                   | 1 (signal-layer) | 3 (scenario-engine, routine-engine, outcome-driver) | Healthy |
| `conductor:scenario`                 | 1 (scenario-engine) | 1 (routine-engine) | |
| `data:route-assistant:fuel-price:updated` | 1 publish (fuel-price-scraper + view seed) | 2 AesView declares + auto-driver via routes:fuel-context | Best-modeled topic |

## Stale/dangling references

`AesBusBridge`, `attachCentralHub`, `attachAesAfp`, `bus-bridge`: **zero hits**. F-9223-001 fully landed.

## Recommendations

1. **Create `AesStrategy.bus` (G-001).** One-liner in `modules/strategy/apply-pipeline.js` (or earlier-loading `default-settings.js`). Closes ~12 silent emit no-ops AND unlocks the canopy + layered-store fan-out + journal-panel cross-tab refresh path. Highest leverage single fix.

2. **Wire `signal:strategy:wear-pressure` and `signal:strategy:crew-pressure` (G-002, G-003) — OR amend `data-bus-topics.js` to remove the false consumer claims.** The current state (registry promises a consumer that doesn't exist) is a bigger trap than a missing registry entry, because the data-bus-inspector tile shows them as "registered with active producer" and a developer reading the registry will assume the wiring works.

3. **Register the 13 phantom topics in `data-bus-topics.js` (G-012) and add a sister CentralHubBus registry (G-013).** This converts the silent-discovery state into an enforced contract. Without it, any new emit anywhere can land without anyone noticing — exactly the failure mode the registry was meant to prevent. Specifically `data:account:bootstrapped`, `data:accounting:weekly:saved`, `data:strategy:applied:saved`, `data:strategy:settings:saved` are critical hub-feed bridges that drive the dashboard yet are documented in *comments* rather than the registry.
