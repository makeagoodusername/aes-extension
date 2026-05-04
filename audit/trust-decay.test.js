"use strict"

/**
 * K11.1 trust-store decay smoke. Verifies:
 *   - record() is bit-for-bit compatible when lastAt is fresh (no decay path)
 *   - 16-week elapsed time halves the evidence mass (favourable=10 → ~5)
 *   - decay is floored at the Beta(2,2) prior (alpha never undershoots 2)
 *   - long dormancy + adverse outcome demotes tier instead of compounding
 *     stale favourable mass
 *   - the public _decayPosterior helper is pure (does not mutate input)
 *
 * Run: `node audit/trust-decay.test.js`
 */

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

let pass = 0, fail = 0
function it(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log("  ok  " + name) },
              e  => { fail++
                      console.log("  FAIL " + name)
                      console.log("       " + (e && e.message)) })
}

function makeChromeStub() {
    const store = new Map()
    return {
        storage: {
            local: {
                async get(keys) {
                    if (Array.isArray(keys)) {
                        const out = {}
                        for (const k of keys) if (store.has(k)) out[k] = store.get(k)
                        return out
                    }
                    if (typeof keys === "string") {
                        const out = {}
                        if (store.has(keys)) out[keys] = store.get(keys)
                        return out
                    }
                    const out = {}
                    for (const [k, v] of store) out[k] = v
                    return out
                },
                async set(items) { for (const k in items) store.set(k, items[k]) },
                async remove(keys) {
                    if (Array.isArray(keys)) for (const k of keys) store.delete(k)
                    else store.delete(keys)
                },
                _store: store
            },
            onChanged: { addListener() {} }
        }
    }
}

function setup() {
    global.window = {}
    global.chrome = makeChromeStub()
    const src = fs.readFileSync(path.join(ROOT, "modules/conductor/trust-store.js"), "utf8")
    eval(src)
    return global.window.AesConductorTrustStore
}

;(async () => {
    console.log("=== K11.1 trust-store decay ===")

    await it("fresh record() unchanged from K11", async () => {
        const TS = setup()
        const host = {server: "ZB", airline: "TST"}
        const r = await TS.record(host, "MaintenanceWatch", true)
        assert(Math.abs(r.alpha - 3) < 1e-9, "alpha=2+1 after one favourable")
        assert(Math.abs(r.beta - 2) < 1e-9, "beta unchanged")
        assert(r.lastAt > 0, "lastAt stamped")
    })

    await it("_decayPosterior halves evidence after one half-life", async () => {
        const TS = setup()
        const now = 1_700_000_000_000
        const halfLifeWeeks = 16
        const e = {
            alpha: 12, beta: 2, n: 10, tq: 12 / 14, lcb: 0.6,
            tier: "apply-confirm", ceiling: null,
            lastAt: now - halfLifeWeeks * 7 * 24 * 3600 * 1000
        }
        const decayed = TS._decayPosterior(e, now, halfLifeWeeks)
        // alpha-evidence was 10, beta-evidence was 0; one half-life halves both
        assert(Math.abs(decayed.alpha - (2 + 5)) < 0.01, "alpha decays from 12 to ~7 (2+5)")
        assert(Math.abs(decayed.beta - 2) < 0.01, "beta floors at prior")
        assert(decayed !== e, "returns new entry, does not mutate")
        assert(e.alpha === 12, "input untouched")
    })

    await it("decay floored at Beta(2,2) prior over 100 half-lives", async () => {
        const TS = setup()
        const now = 1_700_000_000_000
        const veryLongAgo = now - 100 * 16 * 7 * 24 * 3600 * 1000
        const e = {
            alpha: 50, beta: 50, n: 96, tq: 0.5, lcb: 0.4,
            tier: "suggest", ceiling: null, lastAt: veryLongAgo
        }
        const decayed = TS._decayPosterior(e, now, 16)
        assert(decayed.alpha >= 2 - 1e-9, "alpha never undershoots prior=2")
        assert(decayed.beta  >= 2 - 1e-9, "beta never undershoots prior=2")
        assert(Math.abs(decayed.alpha - 2) < 1e-6, "100 half-lives ≈ floor at prior")
        assert(Math.abs(decayed.beta  - 2) < 1e-6, "100 half-lives ≈ floor at prior")
    })

    await it("get() applies decay lazily on read", async () => {
        const TS = setup()
        const host = {server: "ZB", airline: "TST"}
        const stale = {
            alpha: 22, beta: 2, n: 20, tq: 22 / 24,
            lcb: 0.78, tier: "apply-auto", ceiling: null,
            lastAt: Date.now() - 32 * 7 * 24 * 3600 * 1000
        }
        await chrome.storage.local.set({"aesConductor:trust:ZB:TST": {MaintenanceWatch: stale}})
        const got = await TS.get(host, "MaintenanceWatch")
        // 2 half-lives → quarter the evidence (20 favourable → 5)
        assert(Math.abs(got.alpha - (2 + 5)) < 0.5, "alpha decays from 22 to ~7 over 2 half-lives")
        assert(got.tq < stale.tq, "TQ drops")
    })

    await it("dormant favourable + new adverse demotes tier", async () => {
        const TS = setup()
        const host = {server: "ZB", airline: "TST"}
        const stale = {
            alpha: 22, beta: 2, n: 20, tq: 22 / 24,
            lcb: 0.78, tier: "apply-auto", ceiling: null,
            lastAt: Date.now() - 32 * 7 * 24 * 3600 * 1000
        }
        await chrome.storage.local.set({"aesConductor:trust:ZB:TST": {MaintenanceWatch: stale}})
        const r = await TS.record(host, "MaintenanceWatch", false)
        assert(r.alpha < stale.alpha, "alpha decayed before incrementing beta")
        assert(r.lcb < stale.lcb, "LCB dropped from stale value")
    })

    await it("under-one-week dormancy is a no-op (cheap path)", async () => {
        const TS = setup()
        const now = 1_700_000_000_000
        const e = {
            alpha: 12, beta: 5, n: 13, tq: 12 / 17, lcb: 0.5,
            tier: "suggest", ceiling: null,
            lastAt: now - 6 * 24 * 3600 * 1000  // 6 days, under one week
        }
        const decayed = TS._decayPosterior(e, now, 16)
        assert(decayed === e, "returns identical reference (skip path)")
    })

    console.log("\nK11.1: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
})()
