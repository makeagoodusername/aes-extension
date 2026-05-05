"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function load(rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8")
    ;(0, eval)(src)
}

function makeChromeStorage(initial) {
    const store = new Map(Object.entries(initial || {}))
    const listeners = new Set()
    let getCount = 0
    return {
        storage: {
            local: {
                async get(keys) {
                    getCount++
                    if (keys == null) return Object.fromEntries(store)
                    const list = Array.isArray(keys) ? keys : [keys]
                    const out = {}
                    for (const key of list) if (store.has(key)) out[key] = store.get(key)
                    return out
                },
                async set(items) {
                    const changes = {}
                    for (const key in items) {
                        changes[key] = {oldValue: store.get(key), newValue: items[key]}
                        store.set(key, items[key])
                    }
                    for (const cb of Array.from(listeners)) cb(changes, "local")
                },
                async remove(keys) {
                    const list = Array.isArray(keys) ? keys : [keys]
                    const changes = {}
                    for (const key of list) {
                        changes[key] = {oldValue: store.get(key), newValue: undefined}
                        store.delete(key)
                    }
                    for (const cb of Array.from(listeners)) cb(changes, "local")
                }
            },
            onChanged: {
                addListener(cb) { listeners.add(cb) },
                removeListener(cb) { listeners.delete(cb) }
            }
        },
        _store: store,
        _getCount() { return getCount },
        _resetGetCount() { getCount = 0 }
    }
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
        console.log("  FAIL " + name + " - " + (e && e.stack || e))
    }
}

console.log("=== write-through substrate ===")

;(async function main() {
    global.window = global
    global.chrome = makeChromeStorage({settings: {seed: true}})

    load("modules/_shared/data-bus.js")
    load("modules/_shared/store-cache.js")
    load("modules/_shared/write-through.js")
    load("modules/_shared/settings-bridge.js")
    load("modules/_shared/prefix-store.js")

    await it("commits storage, updates L0 cache, and emits one bus event", async () => {
        const seen = []
        const off = AesDataBus.on("data:test:write:saved", rec => seen.push(rec))
        await AesWriteThrough.put("test:key", {v: 1}, {
            topic: "data:test:write:saved",
            hint:  {id: "test:key"}
        })
        off()

        assert.deepStrictEqual(chrome._store.get("test:key"), {v: 1})
        assert.deepStrictEqual(AesStoreCache.getMem("test:key").value, {v: 1})
        assert.strictEqual(seen.length, 1)
        assert.strictEqual(seen[0].source, "local")
        assert.strictEqual(seen[0].id, "test:key")
    })

    await it("prefix stores read back through the shared cache and topic hook", async () => {
        const seen = []
        const off = AesDataBus.on("data:test:prefix:saved", rec => seen.push(rec))
        const store = createPrefixStore({
            prefix: "test:prefix:",
            topic:  "data:test:prefix:saved",
            makePayload(suffix, value) {
                return {suffix: suffix, marker: value.marker}
            }
        })

        await store.set("A", {marker: "from-set"})
        chrome._resetGetCount()
        const rec = await store.get("A")
        off()

        assert.deepStrictEqual(rec, {marker: "from-set"})
        assert.strictEqual(chrome._getCount(), 0, "get should hit AesStoreCache after set")
        assert.strictEqual(seen.length, 1)
        assert.strictEqual(seen[0].suffix, "A")
        assert.strictEqual(seen[0].marker, "from-set")
    })

    await it("settings bridge serializes sibling area writes and emits the generic write signal", async () => {
        const seen = []
        const off = AesDataBus.on("data:settings:area:saved", rec => seen.push(rec))
        await Promise.all([
            AesSettings.saveArea("routeAssistant", {pricing: {enabled: true}}),
            AesSettings.saveArea("strategy", {tier: "apply-on-confirm"})
        ])
        off()

        const settings = chrome._store.get("settings")
        assert.strictEqual(settings.seed, true)
        assert.deepStrictEqual(settings.routeAssistant, {pricing: {enabled: true}})
        assert.deepStrictEqual(settings.strategy, {tier: "apply-on-confirm"})
        assert.strictEqual(seen.length, 2)
        assert.ok(seen.some(e => e.area === "routeAssistant" && e.sections[0] === "pricing"))
        assert.ok(seen.some(e => e.area === "strategy" && e.sections[0] === "tier"))
        assert.deepStrictEqual(AesStoreCache.getMem("settings").value, settings)
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exit(1)
})
