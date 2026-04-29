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
    }

    // Reserved for future declaration:
    // - fleet:wear-rollup
    // - strategy:current-decision
    // - scanner:current-deals
    // - enterprise:financial-rollup
    // - enterprise:freshness
]
