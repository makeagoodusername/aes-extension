# AGENT-5.md — Used Aircraft Scanner, World View, Dashboard Intelligence Tiles

You own the read-only intelligence surfaces — primarily the dashboard.

## Why this is its own territory

Mostly read-only against AS data and read-mostly against `chrome.storage.local`. Shares a content-script entry (`/app/enterprise/dashboard*`) and depends on the central-hub tile registry. Putting them together avoids stepping on Agent 6 (tile registry) and Agent 7 (content-script entry).

## Your Chrome instance

Open `/app/enterprise/dashboard*`. Most of your work happens here.

For Used Aircraft Scanner work, `/app/aircraft/market*` is where the child-tab worker runs.

**Lock requirement:** generally none. Your work is read-only against AS. The Used Aircraft Scanner does open child tabs to scrape per-type listings — coordinate via SHARED-NOTES if you're running a long bulk scan, just so other agents know to expect the child-tab activity.

**No lock needed for:**
- Tile rendering and verification.
- World View building network from cached data.
- Reading deal-metrics.

## Your scope

```
modules/used-aircraft-scanner/
├── type-family-map.js
├── presets-store.js
├── scan-session-store.js
├── deal-metrics.js
├── deal-classifier.js
├── results-table.js
├── scan-controller.js
├── family-grid-panel.js
├── market-panel.js
├── price-history-store.js
└── scan-lease.js

modules/world-view/
├── airport-coords.js
├── settings-store.js
├── network-cache.js
├── network-builder.js
├── carrier-classifier.js
├── recommend-alliance.js
├── recommend-interline.js
└── views/

modules/central-hub/tiles/
├── world-view-tile.js
├── fleet-hub-tile.js
├── fleet-command-tile.js
├── fleet-optimizer-tile.js
├── competitor-monitoring-tile.js
├── route-launcher-tile.js
├── data-flow-inspector-tile.js
└── alliance-tile.js

content_dashboard.js
content_marketScan.js
```

## Priority audit areas

1. **Used Aircraft Scanner Slice 2 deal-scoring** — `deal-metrics.js` should compute six metrics. Verify:
   - `decorate(row, ctx)` runs all six and writes named scalars.
   - `_blockHoursFor(row)` reads `BLOCK_HOURS_BY_CATEGORY` (commuter/turboprop/regional 8h, narrowbody 12h, widebody 14h).
   - `routeFit` reads `weeklyFlights` and uses `weeklyDemandPerScorePoint` (default 100).
   - `frequencyLimited` counter populates correctly.
   - Tooltip shows all three sequential gates.

2. **`routeAssistant:topRoutes` cross-module read** — UAS reads RA's published topRoutes for route-fit. Verify:
   - `displayUsedAircraftScanner` installs singleton `chrome.storage.onChanged` listener (250ms debounced).
   - `loadDealContext(server)` reads most-recent published hub.
   - Legacy single global key still works.

3. **World View tile** — Verify:
   - Mounts in central-hub `operations` section, priority 30.
   - Hub picker lists every entry in `snapshot.hubs[].iata`.
   - World map bubbles size by `weeklyFlights × competitionScore`, color by carrier class.
   - Wave pane synthesises 3-bank schedule and runs `RouteAssistantWaveOverlay.buildSchedule` + `renderGantt`.
   - Treemap squarified algorithm produces correct relative areas.
   - Recommend-alliance + recommend-interline filter own enterprises and current partners.
   - Network cache TTL respected (default 1h).
   - LRU index capped at 10 hubs per (server, airline).

4. **Cross-tile drill-in via bus** — Verify:
   - `competitor-monitoring-tile` auto-expands on `focus-route`.
   - `route-launcher-tile` auto-expands on `focus-aircraft`.
   - World View click on destination emits `focus-route` AND `focus-enterprise`.
   - Fleet-Hub-Tile + Fleet-Command-Tile + Fleet-Optimizer-Tile self-register via `CentralHubTileRegistry.register(...)` at load.

5. **Data-flow inspector tile** — debugging surface. Verify:
   - Bus topics pane shows live counts.
   - Cleanups pane shows `AesCleanup.list()` data.
   - Tile renders even when substrate stores are empty (graceful empty).

## Specific things flagged

- "Airport coordinate table covers most AS networks but will surface gaps in unusual servers" — note IATAs returning `null` from `airport-coords.project()`.
- "Multi-hub split view (Slice W5) deferred" — **deferred**.
- "Network cache evicts cleanly but does not auto-rebuild on TTL expiry — next tile open triggers lazy rebuild" — verify.

## Pure-function smokes

Write under `audit/tests/dashboard/`:

- `deal-metrics.js` — every metric function with synthetic rows.
- `network-builder.js build` — same input → same output.
- `recommend-alliance.js` — top-5 cap, score formula respected.
- `recommend-interline.js` — current ALLIANCE / INTERLINING partners excluded.
- `airport-coords.js project` — known IATAs return expected lat/lon ranges.
- `world-map.js` (renderer) — output SVG element count matches input bubble count.

## Live verifications

In your Chrome on dashboard:

- "World View" tile under Operations. Header summary like `2 HUBS · 47 routes · 12 ally members`.
- Hub picker chips list every hub. Picking one updates `worldView:settings:<airline>.focusedHub` in storage.
- World map: bubbles render at correct lat/lon. Hover shows tooltip. Click → `competitor-monitoring-tile` auto-expands.
- Wave pane: three banks render. Hover outbound; matching connection curves brighten.
- Treemap: cell click fires `focus-route`. Color matches map bubble color.
- Alliance recs: ≥1 card with rationale (when cached competitor enterprises exist).
- Interline recs: cards exclude current partners.
- Used Aircraft Scanner: open AES dropdown → Used Aircraft Scanner; family-card grid renders; scan starts on click.

## Forbidden

- No edits outside listed paths.
- No edits to `modules/central-hub/{shell,host,tile,tile-registry,activity-strip}.js` — Agent 6's territory.
- No new tile sections without Agent 6 confirmation.
- No edits to `modules/route-assistant/**` even though several tiles read RA storage.
- No edits to `_publishTopRoutes` writer.

## End-of-session deliverable

`audit/findings-AGENT-5.md`:

- UAS deal-metrics tooltips render with breakdowns.
- topRoutes consumer + listener verified.
- World View tile renders all four panes.
- Cross-tile drill-in verified for focus-route + focus-enterprise + focus-aircraft.
- Network cache TTL + LRU verified.
- Smoke tests under `audit/tests/dashboard/`.
- Live verification results.
