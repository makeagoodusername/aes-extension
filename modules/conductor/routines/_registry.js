"use strict"

/**
 * AesConductorRoutines — shared registry for conductor routine specs.
 *
 * Loaded BEFORE any individual routine file (see manifest content_scripts
 * load order). Each routine file imports `window.AesConductorRoutines`,
 * builds its `def` object, and calls `register(def)`. This file is the
 * single owner of the registry shape; routine files no longer carry
 * "first-loader-wins" boilerplate.
 *
 * Shape:
 *   window.AesConductorRoutines = {
 *     _defs: { <RoutineId>: def },
 *     register(def): void   // idempotent on def.id
 *     all(): def[]          // returns Object.values(_defs)
 *   }
 *
 * Each routine also pins itself onto window.AesConductorRoutines under
 * its id (e.g. window.AesConductorRoutines.RouteProfitRecovery = def).
 * That pattern is preserved by each routine file post-register.
 *
 * Streamline A6 / fix-A10: extracted from the three routine files
 * (route-profit-recovery, cash-runway-defence, maintenance-rebalance)
 * which each carried a byte-for-byte identical 6-line bootstrap.
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesConductorRoutines && typeof window.AesConductorRoutines.register === "function") return

    window.AesConductorRoutines = window.AesConductorRoutines || {
        _defs: {},
        register(d) { if (d && d.id) this._defs[d.id] = d },
        all() { return Object.values(this._defs) }
    }
})()
