"use strict"

/**
 * Route Builder / Flight Studio smoke for the pure leg-spec contract used by
 * Preview and Create flights.
 */

const {loadAfpModule, resetGlobals, it, summary, assert} = require("./_helpers")

resetGlobals()
loadAfpModule("modules/aircraft-flight-plan/flight-studio/leg-spec.js")

const LegSpec = global.window.AesAfpLegSpec
assert.ok(LegSpec, "AesAfpLegSpec exported on window")

function selectWithIatas(iatas) {
    return {
        options: iatas.map(iata => ({textContent: "Airport (" + iata + ")"}))
    }
}

function validMultiLegSpec() {
    return LegSpec.createSpec({
        server: "free1",
        aircraftId: "22092",
        flightNumberText: "42",
        legs: [
            {origin: "ICN", destination: "NRT", depTimeLocal: "09:00", pricePct: 104, service: "719"},
            {origin: "NRT", destination: "ICN", depTimeLocal: "12:30", pricePct: 102, service: "719"}
        ]
    })
}

it("validates multi-leg station cycles used by Create flights", () => {
    const spec = validMultiLegSpec()
    const result = LegSpec.validateSpec(spec)
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
})

it("passes the typed flight number only to the first batch leg", () => {
    const legs = LegSpec.toBatchLegs(validMultiLegSpec())
    assert.strictEqual(legs.length, 2)
    assert.strictEqual(legs[0].flightNumberText, "42")
    assert.strictEqual(legs[1].flightNumberText, "")
    assert.strictEqual(legs[0]._studio.specId, legs[1]._studio.specId)
})

it("preserves auto-built day masks for Create flights", () => {
    const spec = LegSpec.createSpec({
        server: "free1",
        aircraftId: "22092",
        flightNumberText: "42"
    })
    const next = LegSpec.setLegsFromBuild(spec, [
        {
            seq: 1,
            origin: "LHR",
            destination: "JFK",
            depTimeLocal: "07:30",
            pricePct: 100,
            dayMask: [true, false, false, false, false, false, false]
        }
    ], {})
    const legs = LegSpec.toBatchLegs(next)
    assert.deepStrictEqual(
        legs[0].dayMask,
        [true, false, false, false, false, false, false]
    )
})

it("checks route-builder IATA codes against the live AS form options", () => {
    const spec = validMultiLegSpec()
    const form = {
        originSelect: selectWithIatas(["ICN", "NRT"]),
        destSelect:   selectWithIatas(["ICN", "NRT"])
    }
    const result = LegSpec.validateAgainstForm(spec, form)
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors))
})

it("surfaces unavailable destinations before Preview/Create flights", () => {
    const spec = LegSpec.createSpec({
        server: "free1",
        aircraftId: "22092",
        legs: [
            {origin: "ICN", destination: "HND", depTimeLocal: "09:00", pricePct: 100}
        ]
    })
    const form = {
        originSelect: selectWithIatas(["ICN"]),
        destSelect:   selectWithIatas(["NRT"])
    }
    const result = LegSpec.validateAgainstForm(spec, form)
    assert.strictEqual(result.ok, false)
    assert.ok(result.errors.some(e =>
        e.path === "legs.0.destination"
        && e.reason === "iata-not-in-airline-options"))
})

summary("flight-studio-leg-spec")
