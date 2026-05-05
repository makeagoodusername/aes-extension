"use strict"

const fs = require("fs")
const path = require("path")
const {it, summary, assert, ROOT} = require("../strategy/_helpers")

function evalModule(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
}

function setup() {
    global.window = {}
    evalModule("modules/conductor/forecaster.js")
    return window.AesConductorForecaster
}

function linearSamples(slope, intercept, n, noiseAmp) {
    const out = []
    let seed = 42
    const rand = () => {
        seed = (seed * 9301 + 49297) % 233280
        return seed / 233280
    }
    const t0 = 1_700_000_000_000
    for (let i = 0; i < n; i++) {
        const t = t0 + i * 86_400_000
        const noise = (rand() - 0.5) * 2 * noiseAmp
        out.push({t, v: intercept + slope * (t - t0) / 86_400_000 + noise})
    }
    return out
}

async function main() {
    await it("forecastLinear projects slope+intercept within ~5% of P50 and orders P10<P50<P90", async () => {
        const F = setup()
        const samples = linearSamples(2, 100, 30, 1.0)
        const f = F.forecastLinear(samples, 7)
        assert.strictEqual(f.model, "linear")
        assert.strictEqual(f.n, 30)
        assert.strictEqual(typeof f.p50, "number")
        const expected = 100 + 2 * (29 + 7)
        const err = Math.abs((f.p50 - expected) / expected)
        assert.ok(err < 0.05, "p50 within 5% of analytic value (got " + f.p50 + " vs " + expected + ")")
        assert.ok(f.p10 < f.p50 && f.p50 < f.p90, "monotone CI")
    })

    await it("forecastLinear returns empty envelope on empty input", async () => {
        const F = setup()
        const f = F.forecastLinear([], 7)
        assert.strictEqual(f.p50, null)
        assert.strictEqual(f.n, 0)
    })

    await it("forecastEWMA projects monotone-increasing series upward", async () => {
        const F = setup()
        const samples = linearSamples(1.5, 50, 40, 0.0)
        const f = F.forecastEWMA(samples, 14, 0.3)
        assert.strictEqual(f.model, "ewma")
        const lastV = samples[samples.length - 1].v
        assert.ok(f.p50 > lastV, "p50 above last sample (got " + f.p50 + ", last " + lastV + ")")
        assert.ok(f.p10 < f.p50 && f.p50 < f.p90, "monotone CI")
    })

    await it("forecastMarkov assigns mass to observed-only state in deterministic series", async () => {
        const F = setup()
        const series = ["A", "B", "A", "B", "A", "B", "A", "B"]
        const f = F.forecastMarkov(series, 3)
        assert.strictEqual(f.model, "markov")
        assert.ok(f.fit && Array.isArray(f.fit.states), "states list present")
        assert.strictEqual(f.fit.states.length, 2)
        const sum = (f.fit.distribution || []).reduce((a, b) => a + b, 0)
        assert.ok(Math.abs(sum - 1) < 1e-6, "distribution sums to 1 (got " + sum + ")")
    })

    await it("forecastMarkov rejects too-short input gracefully", async () => {
        const F = setup()
        const f = F.forecastMarkov(["X"], 2)
        assert.strictEqual(f.p50, null)
        assert.ok(/≥2/.test(f.reason), "reason mentions ≥2 states (got: " + f.reason + ")")
    })

    summary("forecaster.test.js")
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
})
