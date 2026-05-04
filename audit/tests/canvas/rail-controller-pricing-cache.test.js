"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys]
            const out = {}
            for (const k of list) if (store.has(k)) out[k] = store.get(k)
            return out
        },
        _store: store
    }
}

function loadController(store, extras) {
    global.window = global
    global.chrome = {storage: {local: makeChromeStore(store)}}
    global.AesAccountKey = {
        acctKey(prefix, suffix) { return prefix + ":acct:acct-test:" + suffix }
    }
    global.CanvasCommitBar = null
    global.CanvasRailShell = {MODE_BUILDER: "builder", MODE_ADVISOR: "advisor"}
    Object.assign(global, extras || {})
    delete global.CanvasRailController
    eval(fs.readFileSync(path.join(ROOT, "modules/canvas/rail/rail-controller.js"), "utf8"))
    return global.CanvasRailController
}

let pass = 0
let fail = 0
async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
    }
}

console.log("=== canvas rail pricing cache ===")

;(async function () {
    await it("loads account-scoped ownPricing prices before legacy/old cache", async () => {
        const C = loadController({
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                prices: {Y: 99}
            },
            "routeAssistant:markets:ownPricing:acct:acct-test:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                prices: {Y: 100, C: 210, F: 520, Cargo: 75}
            },
            "routeAssistant:prices:ICN-NRT": {Y: 88}
        })
        const controller = new C({builderEngine: null, advisorEngine: null})
        const prices = await controller._loadCachedPrices("ICN", "NRT")
        assert.deepStrictEqual(prices, {Y: 100, C: 210, F: 520, Cargo: 75})
    })

    await it("falls back to legacy market ownPricing and old routeAssistant:prices cache", async () => {
        let C = loadController({
            "routeAssistant:markets:ownPricing:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                prices: {Y: 101, Cargo: 70}
            }
        })
        let controller = new C({builderEngine: null, advisorEngine: null})
        assert.deepStrictEqual(await controller._loadCachedPrices("ICN", "NRT"), {Y: 101, Cargo: 70})

        C = loadController({
            "routeAssistant:prices:ICN-NRT": {Y: 102, C: 202, F: 502, Cargo: 72}
        })
        controller = new C({builderEngine: null, advisorEngine: null})
        assert.deepStrictEqual(await controller._loadCachedPrices("ICN", "NRT"), {Y: 102, C: 202, F: 502, Cargo: 72})
    })

    await it("Run proposers now surfaces per-class prices from the shared market cache", async () => {
        const seen = []
        const C = loadController({
            "routeAssistant:topRoutes:acct:acct-test:ICN": {
                hub: "ICN",
                rows: [{hub: "ICN", destIata: "NRT", demandPoolByClass: {Y: 100, Cargo: 1000}}]
            },
            "routeAssistant:markets:ownPricing:acct:acct-test:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                prices: {Y: 100, C: 200, F: 500, Cargo: 70}
            }
        }, {
            RouteAssistantSettings: {
                async load() {
                    return {pricing: {silentAutoStrategy: "per-class-elasticity"}}
                }
            },
            RouteAssistantSilentAutoProposers: {
                surface(strategy, route, prices, cfg, ctx) {
                    seen.push({strategy, route, prices, cfg, ctx})
                    return {ok: true}
                }
            }
        })
        const controller = new C({
            builderEngine: null,
            advisorEngine: null,
            getInputs: () => ({hub: "ICN"})
        })
        const count = await controller._runProposerSurfaceTick()
        assert.strictEqual(count, 1)
        assert.strictEqual(seen[0].strategy, "per-class-elasticity")
        assert.deepStrictEqual(seen[0].prices, {Y: 100, C: 200, F: 500, Cargo: 70})
    })

    await it("Run proposers now defaults to per-class and threads apply class gates", async () => {
        const seen = []
        const C = loadController({
            "routeAssistant:topRoutes:acct:acct-test:ICN": {
                hub: "ICN",
                rows: [{hub: "ICN", destIata: "NRT", demandPoolByClass: {Y: 100, C: 20, F: 10, Cargo: 1000}}]
            },
            "routeAssistant:markets:ownPricing:acct:acct-test:ICN-NRT": {
                hub: "ICN",
                dest: "NRT",
                prices: {Y: 100, C: 200, F: 500, Cargo: 0.85}
            }
        }, {
            RouteAssistantSettings: {
                async load() {
                    return {
                        pricing: {
                            silentAutoPerClassEnabled: {C: false, Cargo: true},
                            silentAutoPerClassMaxStepPct: {Cargo: "2.5"},
                            silentAutoPerClassMinDemandPool: {Cargo: "1500"},
                            apply: {
                                classes: {
                                    Y: {enabled: true, maxMove: 8},
                                    C: {enabled: true, maxMove: 5},
                                    F: {enabled: true, maxMove: 4},
                                    Cargo: {enabled: false, maxMove: 2}
                                }
                            }
                        }
                    }
                }
            },
            RouteAssistantSilentAutoProposers: {
                surface(strategy, route, prices, cfg, ctx) {
                    seen.push({strategy, route, prices, cfg, ctx})
                    return {ok: true}
                }
            }
        })
        const controller = new C({
            builderEngine: null,
            advisorEngine: null,
            getInputs: () => ({hub: "ICN"})
        })
        const count = await controller._runProposerSurfaceTick()
        assert.strictEqual(count, 1)
        assert.strictEqual(seen[0].strategy, "per-class-elasticity")
        assert.strictEqual(seen[0].cfg.silentAutoPerClassEnabled.Y, true)
        assert.strictEqual(seen[0].cfg.silentAutoPerClassEnabled.C, false)
        assert.strictEqual(seen[0].cfg.silentAutoPerClassEnabled.Cargo, true)
        assert.strictEqual(seen[0].cfg.silentAutoPerClassMaxStepPct.Cargo, 2.5)
        assert.strictEqual(seen[0].cfg.silentAutoPerClassMinDemandPool.Cargo, 1500)
        assert.strictEqual(seen[0].cfg.applyClassGates.Cargo.enabled, false)
        assert.strictEqual(seen[0].cfg.applyClassGates.Cargo.maxMove, 2)
        assert.strictEqual(seen[0].ctx.strategy, "per-class-elasticity")
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})()
