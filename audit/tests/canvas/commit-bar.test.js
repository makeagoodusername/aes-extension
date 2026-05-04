"use strict"

const {loadAfpModule, resetGlobals, it, summary, assert} = require("../afp/_helpers")

console.log("=== canvas commit-bar ===")

function resetWith(opts) {
    resetGlobals()
    const calls = {starts: [], toasts: []}
    window.AesCanvasEvents = {EDIT_COMMITTED: "canvas:edit-committed", EDIT_DISCARDED: "canvas:edit-discarded"}
    window.CentralHubBus = {emit() {}}
    window.RouteAssistantToast = {
        show(msg, cfg) { calls.toasts.push({msg, cfg}) }
    }
    window.AesAfpFleetApplyOrchestrator = {
        async start(payload) {
            calls.starts.push(payload)
            return (opts && opts.result) || {
                ok: true,
                totalSucceeded: payload.runs.reduce((sum, r) => sum + r.legs.length, 0),
                totalFailed: 0,
                perAircraft: []
            }
        }
    }
    window.AesAfpSettings = {
        async load() {
            return (opts && opts.settings) || {
                autoScheduler: {
                    enabled: false,
                    tier: "preview-only",
                    maxLegsPerApply: 28
                }
            }
        }
    }
    loadAfpModule("modules/canvas/actions/commit-bar.js", ["CanvasCommitBar"])
    return calls
}

async function main() {
    await it("applies addRoute edits through fleet apply even when auto-scheduler is preview-only", async () => {
        const calls = resetWith()
        const bar = new window.CanvasCommitBar({
            server: "free1",
            getInputs: () => ({
                hub: "JFK",
                preset: {
                    hub: "JFK",
                    waves: [{id: "w-am", departureWindow: {start: "09:15", end: "10:00"}}]
                }
            })
        })
        const result = await bar._runScheduleAdds([
            {kind: "addRoute", aircraftId: "101", destIata: "BOS", hub: "JFK", waveId: "w-am"},
            {kind: "addRoute", aircraftId: "101", destIata: "ALB", hub: "JFK", depTime: "11:30"},
            {kind: "addRoute", aircraftId: "102", destIata: "MIA", hub: "JFK", pricePct: 115}
        ].map(e => bar._normaliseAddPayload(e)))

        assert.strictEqual(result.ran, true)
        assert.strictEqual(result.succeeded, 3)
        assert.strictEqual(calls.starts.length, 1)
        assert.deepStrictEqual(calls.starts[0].runs.map(r => r.aircraftId), ["101", "102"])
        assert.deepStrictEqual(calls.starts[0].runs[0].legs.map(l => l.destination), ["BOS", "ALB"])
        assert.strictEqual(calls.starts[0].runs[0].legs[0].depTime, "09:15")
        assert.strictEqual(calls.starts[0].runs[1].legs[0].pricePct, 115)
    })

    await it("keeps the maxLegsPerApply cap without requiring the old enabled/tier gate", async () => {
        resetWith({settings: {autoScheduler: {enabled: false, tier: "preview-only", maxLegsPerApply: 2}}})
        const bar = new window.CanvasCommitBar({server: "free1"})
        const gateOk = await bar._scheduleApplyGate(2)
        const gateBlocked = await bar._scheduleApplyGate(3)
        assert.strictEqual(gateOk.ok, true)
        assert.strictEqual(gateBlocked.ok, false)
        assert.match(gateBlocked.reason, /too many legs/)
    })

    await it("threads per-class pricing apply gates into route-builder price commits", async () => {
        resetWith()
        const applyCalls = []
        window.RouteAssistantSettings = {
            async load() {
                return {
                    pricing: {
                        apply: {
                            enabled: true,
                            dryRunOnly: true,
                            warnAboveDeltaPct: 9,
                            classes: {
                                Y: {enabled: true, maxMove: 8},
                                C: {enabled: false, maxMove: 5},
                                F: {enabled: true, maxMove: 4},
                                Cargo: {enabled: true, maxMove: 2}
                            }
                        }
                    }
                }
            }
        }
        window.RouteAssistantPricingApplier = function (server, cfg) {
            this.apply = async function (hub, dest, prices, opts) {
                applyCalls.push({server, cfg, hub, dest, prices, opts})
                return {status: "dry-run"}
            }
        }
        const bar = new window.CanvasCommitBar({server: "free1"})
        const result = await bar._runPricingApply({
            kind: "applyPricing",
            hub: "ICN",
            dest: "NRT",
            prices: {Y: 100, C: 220, F: 500, Cargo: 0.92},
            rationale: ["test"]
        })

        assert.strictEqual(result.status, "dry-run")
        assert.strictEqual(applyCalls.length, 1)
        assert.strictEqual(applyCalls[0].cfg.warnAboveDeltaPct, 9)
        assert.strictEqual(applyCalls[0].opts.classGates.C.enabled, false)
        assert.strictEqual(applyCalls[0].opts.classGates.Cargo.maxMove, 2)
    })

    summary("canvas commit-bar")
}

main().catch(err => {
    console.error(err && err.stack || err)
    process.exitCode = 1
})
