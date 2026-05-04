"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

function loadRegistry(extra) {
    return loadModule("modules/central-hub/tile-registry.js", extra || {})
}

it("register normalizes specs and returns sorted summaries", () => {
    const win = loadRegistry()
    const offA = win.CentralHubTileRegistry.register({
        id: "late",
        section: "tools",
        priority: 20,
        topics: ["tools", "", null],
        factory: function () { return {} }
    })
    win.CentralHubTileRegistry.register({
        id: "early",
        section: "fleet",
        priority: 5,
        factory: function () { return {} }
    })

    const all = win.CentralHubTileRegistry.all()
    assert.strictEqual(all[0].id, "early")
    assert.strictEqual(all[1].id, "late")

    const summary = win.CentralHubTileRegistry.summary()
    assert.deepStrictEqual(summary.map(s => s.id), ["early", "late"])
    assert.deepStrictEqual(summary[1].topics, ["tools"])

    offA()
    assert.strictEqual(win.CentralHubTileRegistry.get("late"), null)
})

it("replace keeps one spec per id and notifies subscribers", () => {
    const events = []
    const win = loadRegistry()
    const offSub = win.CentralHubTileRegistry.subscribe(e => events.push(e.kind + ":" + e.spec.id))

    win.CentralHubTileRegistry.register({
        id: "route-assistant",
        section: "routes",
        priority: 30,
        factory: function () { return {} }
    })
    win.CentralHubTileRegistry.register({
        id: "route-assistant",
        section: "tools",
        priority: 10,
        factory: function () { return {} }
    })

    const all = win.CentralHubTileRegistry.all()
    assert.strictEqual(all.length, 1)
    assert.strictEqual(all[0].section, "tools")
    assert.deepStrictEqual(events, ["registered:route-assistant", "updated:route-assistant"])

    offSub()
})

it("emits tile-registered on CentralHubBus when available", () => {
    const emitted = []
    const win = loadRegistry({
        CentralHubBus: {
            emit: function (topic, payload) {
                emitted.push({topic, payload})
            }
        }
    })

    const off = win.CentralHubTileRegistry.register({
        id: "settings",
        section: "tools",
        priority: 1,
        factory: function () { return {} }
    })
    off()

    assert.strictEqual(emitted.length, 2)
    assert.strictEqual(emitted[0].topic, "tile-registered")
    assert.strictEqual(emitted[0].payload.kind, "registered")
    assert.strictEqual(emitted[1].payload.kind, "unregistered")
})

summary("tile-registry")
