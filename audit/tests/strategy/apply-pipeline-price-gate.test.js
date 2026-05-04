"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

function makeChromeStorage() {
    const store = {
        "routeAssistant:markets:ownPricing:JFK-LAX": {prices: {Y: 100, Cargo: 0.85}}
    }
    return {
        store,
        api: {
            storage: {
                local: {
                    async get(keys) {
                        if (keys == null) return Object.assign({}, store)
                        const out = {}
                        const list = Array.isArray(keys) ? keys : [keys]
                        for (const key of list) out[key] = store[key]
                        return out
                    },
                    async set(obj) {
                        Object.assign(store, obj || {})
                    }
                }
            }
        }
    }
}

function makeDecision(overrides) {
    const patch = overrides || {}
    return {
        id: patch.id || "price-1",
        domain: "price",
        applicable: true,
        payload: Object.assign(
            {hub: "JFK", dest: "LAX", classKey: "Y", toPct: 110, impactWeekly: 1234},
            patch.payload || {}
        )
    }
}

async function runWithRouteAssistantApply(applySettings, decision) {
    const chromeStore = makeChromeStorage()
    global.chrome = chromeStore.api

    const constructed = []
    const applied = []

    class FakePricingApplier {
        constructor(server, opts) {
            constructed.push({server, opts})
        }
        async apply(hub, dest, prices, opts) {
            applied.push({hub, dest, prices, opts})
            return {status: this && constructed[0].opts.dryRunOnly ? "dry-run" : "posted", logId: "log-1"}
        }
    }

    const win = loadModule("modules/strategy/apply-pipeline.js", {
        CentralHubBus: {emit() {}},
        RouteAssistantSettings: {
            async load() {
                return {pricing: {apply: applySettings}}
            }
        },
        RouteAssistantPricingApplier: FakePricingApplier,
        AesStrategySettings: {
            async load() { return {tier: "apply-on-confirm", priceMovesEnabled: true} },
            resolveTier(settings) { return settings.tier },
            canApply(settings, domain) { return domain === "price" && !!settings.priceMovesEnabled }
        },
        AesStrategy: {
            diffPlan() {
                return {decisions: [decision || makeDecision()], summary: {}}
            }
        }
    })

    const report = await win.AesStrategy.apply(
        {planId: "plan-price-gate", server: "free1", airlineCode: "CF"},
        {source: "test"}
    )

    return {report, constructed, applied}
}

;(async function main() {
    await it("price moves skip when Route Assistant pricing apply is disabled", async () => {
        const {report, constructed, applied} = await runWithRouteAssistantApply({
            enabled: false,
            dryRunOnly: false
        })
        assert.strictEqual(constructed.length, 0, "pricing applier should not be constructed")
        assert.strictEqual(applied.length, 0, "pricing applier should not be called")
        assert.strictEqual(report.skipped.length, 1, "one decision skipped")
        assert.strictEqual(report.skipped[0].reason, "route-assistant-pricing-disabled")
        assert.strictEqual(report.totals.skipped, 1)
    })

    await it("price moves pass Route Assistant dry-run gate into the applier", async () => {
        const {report, constructed, applied} = await runWithRouteAssistantApply({
            enabled: true,
            dryRunOnly: true
        })
        assert.strictEqual(constructed.length, 1, "pricing applier constructed once")
        assert.strictEqual(constructed[0].server, "free1")
        assert.strictEqual(constructed[0].opts.applyEnabled, true)
        assert.strictEqual(constructed[0].opts.dryRunOnly, true)
        assert.strictEqual(applied.length, 1, "pricing applier called once")
        assert.deepStrictEqual(applied[0].prices, {Y: 110})
        assert.strictEqual(report.applied.length, 1)
        assert.strictEqual(report.applied[0].ok, true, "dry-run result is a successful rehearsal")
        assert.strictEqual(report.applied[0].result.status, "dry-run")
    })

    await it("cargo price moves preserve decimal absolute prices", async () => {
        const {report, applied} = await runWithRouteAssistantApply({
            enabled: true,
            dryRunOnly: true
        }, makeDecision({
            id: "price-cargo",
            payload: {classKey: "Cargo", toPct: 105, impactWeekly: 42}
        }))
        assert.strictEqual(report.applied.length, 1)
        assert.strictEqual(report.applied[0].ok, true)
        assert.notStrictEqual(applied[0].prices.Cargo, 1, "cargo must not integer-round to 1")
        assert.ok(Math.abs(applied[0].prices.Cargo - 0.89) < 0.001,
            "0.85 × 105% should apply as 0.89, got " + applied[0].prices.Cargo)
    })

    summary("apply-pipeline-price-gate")
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exitCode = 1
})
