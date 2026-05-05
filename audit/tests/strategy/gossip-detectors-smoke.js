"use strict"

/**
 * Pure-function smoke for AesStrategyGossipDetectors — Slice 27.
 * Asserts each detector fires its expected GossipEvent shape on a planted
 * before/after pair, and stays silent on first-scrape (oldV null) and on
 * unrelated keys.
 */

const {loadModule, it, summary, assert} = require("./_helpers")

const win = loadModule("modules/strategy/gossip-detectors.js", {})
const D = win.AesStrategyGossipDetectors

;(async () => {
    await it("competitor-price-shift fires med at 20%, high at 30%", () => {
        const med = D.runAll("routeAssistant:markets:competitors:JFK-LAX",
            {flights: [{carrier: "AA", priceY: 200}]},
            {flights: [{carrier: "AA", priceY: 160}]})
        assert.strictEqual(med.length, 1)
        assert.strictEqual(med[0].kind, "competitor-price-shift")
        assert.strictEqual(med[0].severity, "med")
        assert.strictEqual(med[0].route, "JFK-LAX")
        assert.strictEqual(med[0].subject, "AA")

        const high = D.runAll("routeAssistant:markets:competitors:JFK-LAX",
            {flights: [{carrier: "AA", priceY: 200}]},
            {flights: [{carrier: "AA", priceY: 140}]})
        assert.strictEqual(high[0].severity, "high")
    })

    await it("competitor-price-shift below threshold stays silent", () => {
        const out = D.runAll("routeAssistant:markets:competitors:JFK-LAX",
            {flights: [{carrier: "AA", priceY: 200}]},
            {flights: [{carrier: "AA", priceY: 190}]})
        assert.strictEqual(out.length, 0)
    })

    await it("new-entrant detects carrier diff", () => {
        const out = D.runAll("flightsFrom:LHR",
            {routes: [{destIata: "JFK", airlines: [{code: "BA"}]}]},
            {routes: [{destIata: "JFK", airlines: [{code: "BA"}, {code: "VS"}]}]})
        assert.strictEqual(out.length, 1)
        assert.strictEqual(out[0].kind, "new-entrant")
        assert.strictEqual(out[0].subject, "VS")
        assert.strictEqual(out[0].iata, "LHR")
    })

    await it("new-entrant silent when no newcomers", () => {
        const out = D.runAll("flightsFrom:LHR",
            {routes: [{destIata: "JFK", airlines: [{code: "BA"}]}]},
            {routes: [{destIata: "JFK", airlines: [{code: "BA"}]}]})
        assert.strictEqual(out.length, 0)
    })

    await it("own-lf-drop fires med at 10pp, high at 20pp", () => {
        const med = D.runAll("routeAssistant:topRoutes:JFK",
            {routes: [{dest: "LAX", paxLF: 0.85}]},
            {routes: [{dest: "LAX", paxLF: 0.73}]})
        assert.strictEqual(med.length, 1)
        assert.strictEqual(med[0].kind, "own-lf-drop")
        assert.strictEqual(med[0].severity, "med")
        assert.strictEqual(med[0].route, "JFK-LAX")

        const high = D.runAll("routeAssistant:topRoutes:JFK",
            {routes: [{dest: "LAX", paxLF: 0.85}]},
            {routes: [{dest: "LAX", paxLF: 0.60}]})
        assert.strictEqual(high[0].severity, "high")
    })

    await it("first-scrape (oldV null) returns no events for any detector", () => {
        const out = D.runAll("routeAssistant:markets:competitors:JFK-LAX",
            null, {flights: [{carrier: "AA", priceY: 100}]})
        assert.strictEqual(out.length, 0)
        const out2 = D.runAll("flightsFrom:LHR",
            null, {routes: [{destIata: "JFK", airlines: [{code: "BA"}]}]})
        assert.strictEqual(out2.length, 0)
        const out3 = D.runAll("routeAssistant:topRoutes:JFK",
            null, {routes: [{dest: "LAX", paxLF: 0.85}]})
        assert.strictEqual(out3.length, 0)
    })

    await it("unrelated keys ignored", () => {
        const out = D.runAll("settings", {a: 1}, {a: 2})
        assert.strictEqual(out.length, 0)
    })

    summary("gossip-detectors-smoke")
})()
