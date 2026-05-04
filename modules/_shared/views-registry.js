"use strict"

/**
 * Canonical view registry for `AesView` — the documentation-only counterpart
 * to `data-bus-topics.js`. Read by humans (single source of truth for
 * cross-module derived data names) and by the slice-2 dashboard tile.
 *
 * **View grammar:** `<scope>:<slice>` — two colon-segments, scope is the
 * domain the data describes (NOT the producer), slice is the derivation.
 * Examples: `routes:fuel-context`, `fleet:wear-rollup`, `strategy:current-decision`,
 * `enterprise:financial-rollup`, `scanner:current-deals`.
 *
 * **Lifecycle.** Views are declared in `modules/_shared/views/<name>.js`
 * files which run as content scripts (loaded by manifest.json). Each file
 * is a self-installing IIFE that calls `AesView.declare(...)` exactly once.
 * Declarations are idempotent across reloads via a per-view sentinel flag.
 *
 * **Reads.** Consumers call `AesView.get("routes:fuel-context")` for a
 * synchronous cached value (or `undefined` when never computed) and
 * `AesView.subscribe(name, cb)` to react to recomputes. The view-engine
 * handles dedup, debounce, cycle detection, and error isolation; consumers
 * never need to subscribe to the underlying topics directly.
 *
 * **Why view-vs-bus-topic.** Topics fan out raw producer events; views fan
 * out cached derived shapes that 2+ modules want. Adding a view is the
 * answer when "module A and module B both compute X from the same inputs".
 */
window.AES_VIEWS = [
    {
        name:        "routes:fuel-context",
        declaredIn:  "modules/_shared/views/routes-fuel-context.js",
        deps:        [
            "data:route-assistant:fuel-price:updated",
            "data:route-assistant:settings:saved"
        ],
        valueShape:  "{fuelPrice: {value, unit, scrapedAt} | null, settings: {fuelCostPerHour, autoEnabled, baseline} | null, effective: {fuelCostPerHour, multiplier, basis: 'auto'|'manual'|'unset'}}",
        consumers:   [
            "modules/strategy/auto-driver.js",
            "modules/used-aircraft-scanner/market-panel/* (future)",
            "modules/route-assistant/panel.js (future)"
        ],
        notes:       "Composes latest fuel scrape + RA economics into the effective fuel cost per block hour. Replaces direct fuelPriceIndex storage reads in strategy and scanner."
    },
    {
        name:        "fleet:wear-rollup",
        declaredIn:  "modules/_shared/views/fleet-wear-rollup.js",
        deps:        [
            "data:afp:maintenance:updated",
            "data:afp:flightLog:appended",
            "data:account:bootstrapped"
        ],
        valueShape:  "{scrapedAt, totalTails, fleetWearAvg, wearStressCount, oldestAgeYears, byTail}",
        consumers:   [
            "modules/strategy/context.js",
            "modules/central-hub/tiles/fleet-optimizer-tile.js",
            "modules/central-hub/tiles/fleet-command-tile.js"
        ],
        notes:       "Canonical fleet-wide maintenance rollup for shared strategy and dashboard consumers."
    },
    {
        name:        "strategy:current-decision",
        declaredIn:  "modules/_shared/views/strategy-current-decision.js",
        deps:        [
            "data:strategy:dispatch:pending",
            "data:strategy:dispatch:applied",
            "data:strategy:applied:saved",
            "data:account:bootstrapped"
        ],
        valueShape:  "{pending, applied, inFlight, nextAction}",
        consumers:   [
            "modules/central-hub/tiles/strategy-briefing-tile.js",
            "modules/central-hub/tiles/weekly-review-tile.js",
            "modules/central-hub/tiles/strategy-tile.js"
        ],
        notes:       "Composes pending and applied strategy dispatch state into one dashboard-facing decision envelope."
    },
    {
        name:        "scanner:current-deals",
        declaredIn:  "modules/_shared/views/scanner-current-deals.js",
        deps:        [
            "data:scanner:price-history:appended",
            "data:scanner:scan:saved",
            "data:account:bootstrapped"
        ],
        valueShape:  "{scanId, server, presetName, status, startedAt, finishedAt, bestDeal, dealsCount, scrapedAt}",
        consumers:   [
            "modules/central-hub/tiles/used-aircraft-scanner-tile.js",
            "modules/central-hub/tiles/aircraft-profitability-tile.js"
        ],
        notes:       "Canonical newest scanner session plus current best deal projection."
    },
    {
        name:        "enterprise:financial-rollup",
        declaredIn:  "modules/_shared/views/enterprise-financial-rollup.js",
        deps:        [
            "data:accounting:weekly:saved",
            "data:account:bootstrapped"
        ],
        valueShape:  "{weekId, netCash, weeklyNet, trend, runwayWeeks, burnTrend, scrapedAt}",
        consumers:   [
            "modules/central-hub/tiles/accounting-tile.js",
            "modules/central-hub/tiles/strategy-briefing-tile.js",
            "modules/central-hub/tiles/weekly-review-tile.js"
        ],
        notes:       "Multi-week accounting trend and runway projection derived from canonical accounting snapshots."
    },
    {
        name:        "enterprise:freshness",
        declaredIn:  "modules/_shared/views/enterprise-freshness.js",
        deps:        [
            "data:accounting:weekly:saved",
            "data:route-assistant:fuel-price:updated",
            "data:route-assistant:markets:updated",
            "data:route-assistant:ors:updated",
            "data:scanner:scan:saved",
            "data:afp:maintenance:updated",
            "data:account:bootstrapped"
        ],
        valueShape:  "{ors, markets, accounting, fleet, fuel, scanner, worstAt, worstAgeMs, scrapedAt}",
        consumers:   [
            "modules/central-hub/tiles/data-flow-inspector-tile.js",
            "modules/central-hub/activity-strip.js",
            "modules/central-hub/hero-strip.js"
        ],
        notes:       "One dashboard-facing freshness envelope for the major cached data domains."
    }
]
