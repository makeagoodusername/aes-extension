"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const src = fs.readFileSync(path.join(ROOT, "modules/strategy/service-moves.js"), "utf8")

function loadServiceMoves() {
    const savedWindow = global.window
    const savedLocation = global.location
    global.window = {
        AesStrategy: {},
        AesStrategyObjective: {
            resolve() {
                return {
                    kind: "balanced",
                    weights: {shareWeight: 0.4, profitWeight: 0.4, rankWeight: 0.2}
                }
            }
        }
    }
    global.location = {search: ""}
    // eslint-disable-next-line no-eval
    eval(src)
    const fn = global.window.AesStrategy.proposeServiceMoves
    return {
        fn,
        cleanup() {
            if (savedWindow === undefined) delete global.window
            else global.window = savedWindow
            if (savedLocation === undefined) delete global.location
            else global.location = savedLocation
        }
    }
}

function snapshot(playstyle, competitor) {
    return {
        settings: {
            ors: {
                playstyle,
                monopolyOrsMultiplier: 0.25,
                competitiveOrsMultiplier: 1.5,
                competitiveRivalFlights: 6
            },
            serviceProfiles: {defaultClassMix: {Y: 1, C: 0, F: 0}}
        },
        hubs: [{iata: "LHR", byRoute: [
            {dest: "CDG", weeklyFlights: 14, lf: 0.8, spec: {seats: 180}, competitor}
        ]}],
        serviceProfiles: [
            {
                id: 1,
                name: "Lagging",
                classScore: {Y: 0.25, C: 0.4, F: 0.4},
                categories: {
                    drinks: {Y: 1, C: 2, F: 2},
                    snacks: {Y: 1, C: 2, F: 2},
                    entrees: {Y: 0, C: 1, F: 1},
                    headphones: {Y: 0, C: 1, F: 1}
                }
            },
            {id: 2, name: "Top", classScore: {Y: 0.9, C: 0.9, F: 0.9}, categories: null}
        ]
    }
}

console.log("=== strategy service moves ORS playstyle ===")

const loaded = loadServiceMoves()
try {
    const monopoly = loaded.fn(
        snapshot("adaptive", {flightCount: 7, ourFlightCount: 7}),
        {useJointTuner: false, minPredictedLift: 0.01}
    )
    const contested = loaded.fn(
        snapshot("adaptive", {flightCount: 14, ourFlightCount: 0}),
        {useJointTuner: false, minPredictedLift: 0.01}
    )
    assert.strictEqual(monopoly.length, 1)
    assert.strictEqual(contested.length, 1)
    assert.ok(contested[0].predictedOrsDelta > monopoly[0].predictedOrsDelta,
        "contested routes should produce a larger service/ORS lift than monopoly routes")
    assert.ok(monopoly[0].rationale.some(s => /ors-playstyle/i.test(s)))
    assert.ok(contested[0].rationale.some(s => /service aggression/i.test(s)))
} finally {
    loaded.cleanup()
}

console.log("  ok  adaptive playstyle dampens monopoly service moves and boosts contested lanes")
console.log("pass=1 fail=0")
