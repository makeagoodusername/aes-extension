# AGENT-2.md — Route Assistant Panel & Scrapers

You own `modules/route-assistant/**`. The largest single subsystem and the highest user-facing surface.

## Why this is its own territory

`modules/route-assistant/panel.js` is ~14,000 lines and serves as the central UI for ~80% of what users actually look at. It coordinates a dozen scrapers, a dozen stores, the wave overlay, the ORS sandbox, and the auto-pricing apply path. Highest density of half-features.

## Your Chrome instance

Open `/app/com/scheduling/<HUB>` in your Chrome. The panel mounts there. Most of your verifications happen here.

**Lock requirement:** acquire SHARED-NOTES real-write lock before:
- Flipping `apply.enabled` or `apply.dryRunOnly` to commit a real pricing apply.
- Running bulk apply in non-dry-run mode.
- Triggering silent-auto with `liveScopes.silentAuto: true`.

**No lock needed for:**
- Read-only scrapes (markets, ORS, schedule pages, demand-depth, carriers).
- Dry-run apply preview (the modal runs full pipeline + audit log without POST).
- Sandbox projection.
- Wave overlay rendering.

## Your scope

```
modules/route-assistant/
├── panel.js                    # the giant
├── settings-store.js
├── aggregator.js
├── score.js
├── profit-estimator.js
├── distance-resolver.js
├── demand-store.js
├── demand-derivator.js
├── country-resolver.js
├── parallel-scanner.js
├── route-overrides-store.js
├── route-note-store.js
├── status-history-store.js
├── watchlist-store.js
├── alert-rules-store.js
├── alert-evaluator.js
├── fleet-store.js
├── type-specs-store.js
├── fuel-price-scraper.js
├── fuel-burn-estimator.js
├── schedule-page-scraper.js
├── markets-page-scraper.js
├── ors-scraper.js
├── ors-model.js
├── ors-snapshot-store.js
├── inventory-page-scraper.js
├── carriers-scraper.js
├── enterprise-meta-scraper.js
├── contractual-partners-scraper.js
├── interline-store.js
├── service-profile-scraper.js
├── service-config-store.js
├── yield-history-store.js
├── yield-snapshot.js
├── pricing-applier.js
├── pricing-apply-log.js
├── rating-observation-store.js
├── rating-alpha-store.js
├── route-sync-orchestrator.js
├── sandbox-backtest-store.js
├── sandbox-scenarios-store.js
├── wave-overlay.js
├── wave-route-fitter.js
├── wave-plan-diagnostics.js
├── wave-keybinds-store.js
├── wave-favorites-store.js
├── wave-registry.js
├── wave-palette.js
├── drag-affordance-store.js
├── silent-auto-proposers.js
└── toast-host.js
```

## Priority audit areas

1. **Auto-Pricing Tier 3 path** — pricing-applier, pricing-apply-log, route-sync-orchestrator, per-route + bulk apply modals, silent-auto loop. HANDOVER claims shipped through 3.4 with circuit breakers, undo, bulk selection. Verify end-to-end **in dry-run only** unless you have the SHARED-NOTES lock. Smoke: preflight, body construction, audit log.

2. **ORS Sandbox** — ors-model, panel sandbox sections, rating-observation-store, rating-alpha-store, sandbox-backtest-store. Slices 1, 1.5, 2, 2c, 3 shipped. Verify the cascade resolver runs in order: `override > derived > siblingDerived > fleetMedian > global`. Verify per-class price multipliers thread through.

3. **Wave overlay** — wave-overlay, wave-route-fitter, panel's `_renderWaveOverlay`, drag-edit + save-back. H slices 1–3a shipped. Verify auto-optimiser actually fires when toggle is on.

4. **Demand depth** — demand-derivator, inventory-page-scraper, `useRealDemandForLF` opt-in path. Letter K shipped. Verify elasticity regression has the right confounder filters.

5. **Yield feedback** — yield-history-store, yield-snapshot, per-flight attribution. Roadmap G slices 1–4 shipped. Verify the `flightId` regex fix (`url.match(/[?&]id=(\d+)/)[1]`) is in current code — HANDOVER says it was a pre-existing silent bug.

6. **Carrier popover (F slice 2 + 3)** — enterprise-meta-scraper, contractual-partners-scraper, popover render. Verify partner-glyph rendering reads from `_partnersByEnterpriseId` correctly.

## Specific things flagged

From tech-debt and v1 deferrals:

- "Carriers SSR fragility" — flightsfrom.com sometimes doesn't SSR carrier list; record stores `parserNotes` and empty list. Verify panel handles empty gracefully.
- "Demand depth — elasticity small-N regressions" — returns null for routes with <4 valid points. Verify column shows em-dash, not NaN.
- "Inventory parser fragility" — heuristic-walks every table. Open `/app/com/inventory/<HUB><DEST>` in your Chrome and verify it parses.
- "ORS Wicket per-route handshake" — must NOT share session across bulk batch. Verify scraper does fresh GET per route.
- "Tier 3.2 circuit breaker persists through settings" — verify trippedAt round-trips through panel remount.

## Pure-function smokes

Write under `audit/tests/route-assistant/`:

- `ors-model.js` — `project(input)` is pure. Same input → same output, twice.
- `score.js` — pure normaliser. Synthetic rows.
- `profit-estimator.js` — pure. Test with override paxLF + observe LF reduction.
- `demand-derivator.js` — pure regressions. Test confounder filters drop right pairs.
- `pricing-applier.js` — `parseFormContext`, `buildBody`, `preflight`, `fingerprint` static + pure.
- `wave-overlay.js` — `buildSchedule`, `renderGantt` pure.

## Live verifications you can run

In your Chrome, navigate to `/app/com/scheduling/<HUB>`:

- Panel mounts within 1s.
- Right-click a row → context menu shows expected items.
- "Apply price…" opens modal in dry-run mode by default.
- 🧪 toggle opens ORS Sandbox. Drag a slider; outcome card updates without freezing.
- 📊 toggle opens Wave View; preset picker populates.
- 🔔 button shows notification history.
- Cmd-K opens command palette.

For each, note in findings whether it works as documented.

## Forbidden

- No edits outside `modules/route-assistant/`.
- No bus topic name changes (request via `audit/bus-topic-requests.md`).
- No `chrome.storage.local` key shape changes for any store under your territory **without** an entry in HANDOVER §10.
- No flipping `apply.dryRunOnly` defaults. No flipping `apply.enabled` defaults.

## Common pitfalls

- `panel.js` is huge; avoid full re-reads. Use `grep`.
- Many panel methods have ~13 reset sites for caches. When changing render path, audit every reset site.
- `_undoableSave` wraps writes; new write call sites should use it.
- Storage listeners fire on every tab. Toggling settings on tab A reflects in tab B's panel within ~250ms — across the eight Chromes too.

## End-of-session deliverable

`audit/findings-AGENT-2.md`:

- Tier 3 dry-run path: confirmed working / list of gaps.
- ORS sandbox cascade verified.
- Wave overlay auto-optimiser firing.
- Demand depth elasticity sane.
- Per-flight yield attribution: regex fix verified.
- Per-store account-scoping status (handover claims canopy L1–L3 partially deferred — verify which stores already namespace `:acct:<id>:` and which don't).
- Live verification results.
