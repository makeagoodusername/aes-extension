"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function makeBus() {
    const subs = new Map()
    const lastEmit = new Map()
    return {
        on(topic, cb) {
            let set = subs.get(topic)
            if (!set) { set = new Set(); subs.set(topic, set) }
            set.add(cb)
            return () => { const s = subs.get(topic); if (s) s.delete(cb) }
        },
        off(topic, cb) { const s = subs.get(topic); if (s) s.delete(cb) },
        emit(topic, payload) {
            const record = Object.assign({at: Date.now(), topic, source: "local"}, payload || {})
            lastEmit.set(topic, record)
            const s = subs.get(topic)
            if (!s) return record
            for (const cb of Array.from(s)) cb(record)
            return record
        },
        replay(topic) { return lastEmit.get(topic) || null },
        _subs: subs
    }
}

function makeChromeStorage() {
    const listeners = new Set()
    return {
        api: {
            storage: {
                onChanged: {
                    addListener(fn) { listeners.add(fn) },
                    removeListener(fn) { listeners.delete(fn) }
                }
            }
        },
        fireChange(changes, area) {
            for (const fn of Array.from(listeners)) fn(changes, area || "local")
        },
        listenerCount() { return listeners.size }
    }
}

function loadRelay(opts) {
    const bus = (opts && opts.bus) || null
    const storage = (opts && opts.storage) || null
    const context = {
        console: {warn() {}},
        Date,
        Object,
        Array,
        Map,
        Set,
        JSON,
        String,
        Number
    }
    context.window = context
    context.globalThis = context
    if (bus) context.AesDataBus = bus
    if (storage) context.chrome = storage.api
    vm.createContext(context)
    const src = fs.readFileSync(path.join(ROOT, "modules/_shared/relay-helpers.js"), "utf8")
    vm.runInContext(src, context, {filename: "relay-helpers.js"})
    return context
}

let pass = 0
let fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) { fail++; console.log("  FAIL " + name + " - " + (e && e.stack || e)) }
}

console.log("=== relay-helpers ===")

it("subscribeWithReplay attaches and replays last record", () => {
    const bus = makeBus()
    bus.emit("topic:a", {hint: "before-subscribe"})
    const ctx = loadRelay({bus})
    const calls = []
    const off = ctx.AesRelay.subscribeWithReplay(bus, "topic:a", r => calls.push(r))
    assert.strictEqual(calls.length, 1, "replay fires once on attach")
    assert.strictEqual(calls[0].hint, "before-subscribe")
    bus.emit("topic:a", {hint: "after-subscribe"})
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[1].hint, "after-subscribe")
    off()
    bus.emit("topic:a", {hint: "after-unsub"})
    assert.strictEqual(calls.length, 2, "unsubscribe stops further calls")
})

it("subscribeWithReplay attaches even when topic has never fired", () => {
    const bus = makeBus()
    const ctx = loadRelay({bus})
    const calls = []
    ctx.AesRelay.subscribeWithReplay(bus, "topic:fresh", r => calls.push(r))
    assert.strictEqual(calls.length, 0)
    bus.emit("topic:fresh", {n: 1})
    assert.strictEqual(calls.length, 1)
})

it("subscribeWithReplay no-ops on missing bus or non-callable handler", () => {
    const ctx = loadRelay({bus: null})
    const off = ctx.AesRelay.subscribeWithReplay(null, "topic:x", () => {})
    assert.strictEqual(typeof off, "function")
    off()  // should not throw
})

it("onSettingsArea filters by area", () => {
    const bus = makeBus()
    const ctx = loadRelay({bus})
    const calls = []
    ctx.AesRelay.onSettingsArea("routeAssistant", r => calls.push(r))
    bus.emit("data:settings:area:saved", {area: "aircraftFlightPlan", sections: ["x"]})
    assert.strictEqual(calls.length, 0, "skips other area")
    bus.emit("data:settings:area:saved", {area: "routeAssistant", sections: ["pricing"]})
    assert.strictEqual(calls.length, 1, "matches own area")
    assert.deepStrictEqual(calls[0].sections, ["pricing"])
})

it("onSettingsArea replays last matching record on attach", () => {
    const bus = makeBus()
    bus.emit("data:settings:area:saved", {area: "routeAssistant", sections: ["pre"]})
    const ctx = loadRelay({bus})
    const calls = []
    ctx.AesRelay.onSettingsArea("routeAssistant", r => calls.push(r))
    assert.strictEqual(calls.length, 1, "replay on attach when last record matches area")
    assert.deepStrictEqual(calls[0].sections, ["pre"])
})

it("onSettingsArea handler that throws is contained", () => {
    const bus = makeBus()
    const ctx = loadRelay({bus})
    ctx.AesRelay.onSettingsArea("routeAssistant", () => { throw new Error("boom") })
    bus.emit("data:settings:area:saved", {area: "routeAssistant"})  // must not throw
})

it("onStorageKey fires for matching prefix only", () => {
    const storage = makeChromeStorage()
    const ctx = loadRelay({storage})
    const calls = []
    ctx.AesRelay.onStorageKey("routeAssistant:demand:", c => calls.push(c))
    storage.fireChange({
        "routeAssistant:demand:LHR": {newValue: {pax: 100}, oldValue: null},
        "aircraftFleet": {newValue: {a: 1}}
    }, "local")
    assert.strictEqual(calls.length, 1, "only matching prefix fires handler")
    assert.strictEqual(calls[0].key, "routeAssistant:demand:LHR")
    assert.strictEqual(calls[0].suffix, "LHR")
    assert.deepStrictEqual(calls[0].newValue, {pax: 100})
})

it("onStorageKey single mode matches exact key", () => {
    const storage = makeChromeStorage()
    const ctx = loadRelay({storage})
    const calls = []
    ctx.AesRelay.onStorageKey("settings", c => calls.push(c), {single: true})
    storage.fireChange({"settings": {newValue: {a: 1}}, "settingsExtra": {newValue: 2}}, "local")
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].key, "settings")
})

it("onStorageKey ignores non-local areas", () => {
    const storage = makeChromeStorage()
    const ctx = loadRelay({storage})
    const calls = []
    ctx.AesRelay.onStorageKey("aircraftFleet", c => calls.push(c))
    storage.fireChange({"aircraftFleet": {newValue: 1}}, "sync")
    assert.strictEqual(calls.length, 0)
})

it("onStorageKey unsubscribe removes listener", () => {
    const storage = makeChromeStorage()
    const ctx = loadRelay({storage})
    const off = ctx.AesRelay.onStorageKey("foo", () => {})
    assert.strictEqual(storage.listenerCount(), 1)
    off()
    assert.strictEqual(storage.listenerCount(), 0)
})

console.log("pass=" + pass + " fail=" + fail)
if (fail) process.exit(1)
