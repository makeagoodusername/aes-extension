"use strict"

/**
 * AES Strategy — aircraft ORS modifier (Slice S1).
 *
 * The ORS model in route-assistant/ors-model.js currently treats every
 * aircraft identically — a 777 and an A320 on the same route with the
 * same price/comfort get the same baseline rating. In reality passengers
 * have preferences: widebodies on long-haul, regional jets on thin
 * spokes, narrowbodies in the middle. This module supplies a small
 * heuristic table mapping (aircraftCategory, distanceBucket) → rating
 * delta in points that the proposers add to the ORS projection so the
 * "right aircraft for the route" wins on rating.
 *
 * v1 ships static defaults; the table is exposed at
 * `settings.strategy.aircraftOrsModifier` so power users can tune it
 * without code changes. Slice 4 (future) will fit values from the
 * existing ors-snapshot-store time-series.
 *
 * Categories follow the existing aircraft-type-specs.js bucketing:
 *   regional   < 100 seats        (e.g. CRJ, ERJ, ATR)
 *   narrow     100–250 seats      (e.g. 737, A320, 757)
 *   wide       250–400 seats      (e.g. 777, A330, A350)
 *   heavy      400+ seats         (e.g. 747, A380)
 *
 * Distance buckets:
 *   short      < 1500 km          (intra-region)
 *   medium     1500–4500 km       (continental)
 *   long       > 4500 km          (intercontinental)
 *
 * Sign convention: positive = passengers prefer this combo, negative =
 * passengers dislike it. Magnitudes are conservative (<= ±4 points)
 * since the ORS rating clamp is ±50% — a ±4 nudge is meaningful but
 * never dominates price/comfort signals.
 *
 * Public API (window.AesStrategyAircraftOrsModifier):
 *   DEFAULT_TABLE                      — frozen baseline heuristic
 *   categoryFor(seats)                 → "regional"|"narrow"|"wide"|"heavy"
 *   distanceBucketFor(km)              → "short"|"medium"|"long"
 *   lookup(spec, distanceKm, override?)→ rating delta in points (number)
 *
 * `spec` may be a fleet aircraft (with `seats`) or a type spec — anything
 * with a numeric `seats` field. `distanceKm` is the route great-circle.
 * `override` is an optional table that takes precedence over DEFAULT_TABLE
 * (typically `settings.strategy.aircraftOrsModifier`).
 */
;(function () {
    if (typeof window === "undefined") return
    if (window.AesStrategyAircraftOrsModifier) return

    const DEFAULT_TABLE = Object.freeze({
        regional: Object.freeze({short:  +2, medium: -1, long:  -3}),
        narrow:   Object.freeze({short:  +1, medium: +2, long:  -1}),
        wide:     Object.freeze({short:  -1, medium: +1, long:  +3}),
        heavy:    Object.freeze({short:  -3, medium:  0, long:  +4})
    })

    const CATEGORIES   = Object.freeze(["regional", "narrow", "wide", "heavy"])
    const BUCKETS      = Object.freeze(["short", "medium", "long"])

    function _num(v) { const n = Number(v); return isFinite(n) ? n : null }

    function categoryFor(seats) {
        const n = _num(seats)
        if (n == null || n <= 0) return null
        if (n < 100)  return "regional"
        if (n < 250)  return "narrow"
        if (n < 400)  return "wide"
        return "heavy"
    }

    function distanceBucketFor(km) {
        const n = _num(km)
        if (n == null || n <= 0) return null
        if (n < 1500)  return "short"
        if (n < 4500)  return "medium"
        return "long"
    }

    function lookup(spec, distanceKm, override) {
        if (!spec) return 0
        const cat = categoryFor(spec.seats)
        const bkt = distanceBucketFor(distanceKm)
        if (!cat || !bkt) return 0
        const tables = []
        if (override && typeof override === "object") tables.push(override)
        tables.push(DEFAULT_TABLE)
        for (const t of tables) {
            const row = t && t[cat]
            if (row && Number.isFinite(row[bkt])) return Number(row[bkt])
        }
        return 0
    }

    /**
     * Merge user overrides on top of defaults so the panel's "Advanced"
     * editor can render the full grid even when the override only
     * specifies a few cells. Returns a fresh plain object — never the
     * frozen default table.
     */
    function mergedTable(override) {
        const out = {}
        for (const cat of CATEGORIES) {
            out[cat] = {}
            for (const bkt of BUCKETS) {
                const v = (override && override[cat] && Number.isFinite(override[cat][bkt]))
                    ? Number(override[cat][bkt])
                    : DEFAULT_TABLE[cat][bkt]
                out[cat][bkt] = v
            }
        }
        return out
    }

    window.AesStrategyAircraftOrsModifier = {
        DEFAULT_TABLE:     DEFAULT_TABLE,
        CATEGORIES:        CATEGORIES,
        BUCKETS:           BUCKETS,
        categoryFor:       categoryFor,
        distanceBucketFor: distanceBucketFor,
        lookup:            lookup,
        mergedTable:       mergedTable
    }

    // ── ?aes-debug smoke ──────────────────────────────────────────────
    try {
        if (typeof location !== "undefined" && /[?&]aes-debug\b/.test(location.search || "")) {
            console.assert(categoryFor(50)  === "regional",  "[smoke afm] 50 seats → regional")
            console.assert(categoryFor(180) === "narrow",    "[smoke afm] 180 seats → narrow")
            console.assert(categoryFor(350) === "wide",      "[smoke afm] 350 seats → wide")
            console.assert(categoryFor(500) === "heavy",     "[smoke afm] 500 seats → heavy")
            console.assert(distanceBucketFor(800)  === "short",  "[smoke afm] 800km → short")
            console.assert(distanceBucketFor(2500) === "medium", "[smoke afm] 2500km → medium")
            console.assert(distanceBucketFor(8000) === "long",   "[smoke afm] 8000km → long")
            console.assert(lookup({seats: 350}, 8000) === 3,     "[smoke afm] wide+long = +3")
            console.assert(lookup({seats: 50},  8000) === -3,    "[smoke afm] regional+long = -3")
            console.assert(lookup({seats: null}, 8000) === 0,    "[smoke afm] missing seats → 0")
        }
    } catch (_) { /* never let smoke break the page */ }
})()
