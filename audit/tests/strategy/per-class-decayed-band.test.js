"use strict"

/**
 * Locks the per-class `timeDecayCompetitorBand` filter that landed in
 * the autopricer fix-pass:
 *   - When opts.classKey is set, only the matching markets-page payload
 *     (Y→ECONOMY, C→BUSINESS, F→FIRST, Cargo→CARGO) contributes to the
 *     decayed band.
 *   - Without classKey, all payloads roll up (legacy behaviour).
 *   - Engine recommendations now compute decayedBand inside the class
 *     loop, so each class sees its own historic band.
 *
 * Pre-fix: a route with FIRST history at $300 and ECONOMY history at
 * $90 would surface a single $90–$300 band annotated against every
 * class. Post-fix: the FIRST class sees only the FIRST history, and
 * the ECONOMY class sees only the ECONOMY history.
 */

const {loadModule, it, summary, assert} = require("./_helpers")

const win = loadModule("modules/strategy/pricing-engine.js")
const ENG = win.AesStrategyPricingEngine
assert.ok(ENG, "AesStrategyPricingEngine loaded")
assert.ok(typeof ENG.timeDecayCompetitorBand === "function",
    "timeDecayCompetitorBand exposed")

;(async function run() {
    await it("classKey:Y restricts to ECONOMY payload", () => {
        const now = Date.now()
        const historic = {
            byPayload: {
                ECONOMY:  {timestamp: now, priceMin: 90,  priceMax: 110},
                BUSINESS: {timestamp: now, priceMin: 200, priceMax: 250},
                FIRST:    {timestamp: now, priceMin: 300, priceMax: 350},
                CARGO:    {timestamp: now, priceMin: 100, priceMax: 115}
            }
        }
        const band = ENG.timeDecayCompetitorBand(historic, {classKey: "Y"})
        assert.ok(band, "band emitted for Y")
        assert.ok(Math.abs(band.priceMin - 90) < 1,
            "Y band priceMin tracks ECONOMY only (got " + band.priceMin + ")")
        assert.ok(Math.abs(band.priceMax - 110) < 1,
            "Y band priceMax tracks ECONOMY only (got " + band.priceMax + ")")
    })

    await it("classKey:F restricts to FIRST payload", () => {
        const now = Date.now()
        const historic = {
            byPayload: {
                ECONOMY: {timestamp: now, priceMin: 90,  priceMax: 110},
                FIRST:   {timestamp: now, priceMin: 300, priceMax: 350}
            }
        }
        const band = ENG.timeDecayCompetitorBand(historic, {classKey: "F"})
        assert.ok(band, "band emitted for F")
        assert.ok(Math.abs(band.priceMin - 300) < 1,
            "F band priceMin tracks FIRST only (got " + band.priceMin + ")")
        assert.ok(Math.abs(band.priceMax - 350) < 1,
            "F band priceMax tracks FIRST only (got " + band.priceMax + ")")
    })

    await it("classKey:Cargo restricts to CARGO payload", () => {
        const now = Date.now()
        const historic = {
            byPayload: {
                ECONOMY: {timestamp: now, priceMin: 90,  priceMax: 110},
                CARGO:   {timestamp: now, priceMin: 105, priceMax: 115}
            }
        }
        const band = ENG.timeDecayCompetitorBand(historic, {classKey: "Cargo"})
        assert.ok(band, "band emitted for Cargo")
        assert.ok(Math.abs(band.priceMin - 105) < 1,
            "Cargo band priceMin tracks CARGO only (got " + band.priceMin + ")")
    })

    await it("no classKey rolls up all payloads (legacy)", () => {
        const now = Date.now()
        const historic = {
            byPayload: {
                ECONOMY: {timestamp: now, priceMin: 90,  priceMax: 110},
                FIRST:   {timestamp: now, priceMin: 300, priceMax: 350}
            }
        }
        const band = ENG.timeDecayCompetitorBand(historic)
        assert.ok(band, "band emitted")
        // weighted avg of (90, 300) → 195; of (110, 350) → 230
        assert.ok(band.priceMin > 100 && band.priceMin < 250,
            "legacy band averages ECONOMY+FIRST (got " + band.priceMin + ")")
    })

    await it("falls back to union when requested payload missing", () => {
        const now = Date.now()
        const historic = {
            byPayload: {
                ECONOMY: {timestamp: now, priceMin: 90,  priceMax: 110}
                // No BUSINESS payload — proposer asks for C
            }
        }
        const band = ENG.timeDecayCompetitorBand(historic, {classKey: "C"})
        assert.ok(band, "band still emitted via union fallback")
        assert.ok(Math.abs(band.priceMin - 90) < 1,
            "C falls back to ECONOMY when BUSINESS missing (got " + band.priceMin + ")")
    })

    summary("per-class-decayed-band")
})()
