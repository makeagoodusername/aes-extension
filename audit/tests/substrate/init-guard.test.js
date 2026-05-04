"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function loadInitGuard() {
    const events = []
    const emitted = []
    const context = {
        console: {warn() {}},
        setTimeout,
        clearTimeout,
        Date,
        Error,
        String,
        Number,
        Array,
        Object,
        JSON,
        Map,
        Promise,
        location: {href: "https://test.airlinesim.aero/app/enterprise/dashboard"},
        CustomEvent: function CustomEvent(type, init) {
            this.type = type
            this.detail = init && init.detail
        }
    }
    context.window = context
    context.globalThis = context
    context.dispatchEvent = ev => events.push(ev)
    vm.createContext(context)
    const src = fs.readFileSync(path.join(ROOT, "modules/_shared/init-guard.js"), "utf8")
    vm.runInContext(src, context, {filename: "init-guard.js"})
    context.AesDataBus = {
        emit(topic, payload) {
            emitted.push({topic, payload})
        }
    }
    return {context, events, emitted}
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

console.log("=== init guard substrate ===")

;(async function main() {
    await it("safe captures sync throws and returns undefined", async () => {
        const {context} = loadInitGuard()
        const out = context.AesInit.safe("sync.throw", () => {
            throw new Error("sync boom")
        })
        const health = context.AesInit.health()
        assert.strictEqual(out, undefined)
        assert.strictEqual(health.ok, false)
        assert.strictEqual(health.failures.length, 1)
        assert.strictEqual(health.failures[0].label, "sync.throw")
        assert.strictEqual(health.failures[0].message, "sync boom")
    })

    await it("safe captures async rejections", async () => {
        const {context} = loadInitGuard()
        const out = await context.AesInit.safe("async.reject", () => Promise.reject(new Error("async boom")))
        const health = context.AesInit.health()
        assert.strictEqual(out, undefined)
        assert.strictEqual(health.failures.length, 1)
        assert.strictEqual(health.failures[0].label, "async.reject")
        assert.strictEqual(health.failures[0].message, "async boom")
    })

    await it("once runs only once and reuses the first result", async () => {
        const {context} = loadInitGuard()
        let count = 0
        const first = context.AesInit.once("only.once", () => {
            count += 1
            return "first"
        })
        const second = context.AesInit.once("only.once", () => {
            count += 1
            return "second"
        })
        assert.strictEqual(first, "first")
        assert.strictEqual(second, "first")
        assert.strictEqual(count, 1)
        assert.strictEqual(context.AesInit.health().ok, true)
    })

    await it("record emits health events and flushes to AesDataBus", async () => {
        const {context, events, emitted} = loadInitGuard()
        context.AesInit.record("manual.degrade", "missing anchor")
        await sleep(20)
        assert.strictEqual(events.length, 1)
        assert.strictEqual(events[0].type, "aes:init:health")
        assert.strictEqual(emitted.length, 1)
        assert.strictEqual(emitted[0].topic, "data:init:startup:failed")
        assert.strictEqual(emitted[0].payload.label, "manual.degrade")
        assert.strictEqual(emitted[0].payload.message, "missing anchor")
    })

    await it("health snapshots are defensive copies", async () => {
        const {context} = loadInitGuard()
        context.AesInit.record("copy.check", new Error("copy boom"))
        const first = context.AesInit.health()
        first.failures[0].label = "mutated"
        const second = context.AesInit.health()
        assert.strictEqual(second.failures[0].label, "copy.check")
        assert.strictEqual(second.records[0].message, "copy boom")
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})().catch(e => {
    console.error("Top-level test threw:", e)
    process.exit(1)
})
