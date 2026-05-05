"use strict"

/**
 * Shared helpers for AFP smoke tests.
 *
 * Mirrors audit/tests/dashboard/_helpers.js but adds:
 *   - chrome.storage.local stub backed by an in-memory map (for auto-apply-log)
 *   - `loadAfpModule(relPath, exposeNames?)` — appends `window.X = X` for any
 *     top-level class names that the module doesn't self-export (e.g.
 *     `ScheduleBuilder`, where the production code relies on isolated-world
 *     lexical-scope sharing across content_scripts).
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function makeChromeStub() {
    const store = new Map()
    const stub = {
        storage: {
            local: {
                async get(keys) {
                    if (keys == null) {
                        const out = {}
                        for (const [k, v] of store) out[k] = v
                        return out
                    }
                    if (typeof keys === "string") {
                        const out = {}
                        if (store.has(keys)) out[keys] = store.get(keys)
                        return out
                    }
                    if (Array.isArray(keys)) {
                        const out = {}
                        for (const k of keys) if (store.has(k)) out[k] = store.get(k)
                        return out
                    }
                    if (typeof keys === "object") {
                        const out = {}
                        for (const k in keys) out[k] = store.has(k) ? store.get(k) : keys[k]
                        return out
                    }
                    return {}
                },
                async set(items) {
                    for (const k in items) store.set(k, items[k])
                },
                async remove(keys) {
                    if (Array.isArray(keys)) for (const k of keys) store.delete(k)
                    else store.delete(keys)
                },
                _store: store,
                _reset() { store.clear() }
            },
            onChanged: { addListener() {}, removeListener() {} }
        },
        runtime: { id: "test-stub", onMessage: { addListener() {} }, sendMessage() {} }
    }
    return stub
}

function loadAfpModule(relPath, exposeNames) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    let amended = src
    if (Array.isArray(exposeNames) && exposeNames.length) {
        amended += "\n;(function(){\n"
        for (const name of exposeNames) {
            amended += `try { if (typeof ${name} !== 'undefined' && typeof window !== 'undefined') window.${name} = ${name}; } catch(_) {}\n`
        }
        amended += "})();\n"
    }
    global.window = global.window || {}
    global.chrome = global.chrome || makeChromeStub()
    if (typeof global.location === "undefined") global.location = { search: "" }
    if (typeof global.document === "undefined") global.document = { readyState: "complete", addEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] } }
    eval(amended)
    return global.window
}

function resetGlobals() {
    global.window = {}
    global.chrome = makeChromeStub()
}

let pass = 0
let fail = 0
function it(name, fn) {
    try {
        const r = fn()
        if (r && typeof r.then === "function") {
            return r.then(() => { pass++; console.log("  ok  " + name) },
                          e  => { fail++; console.log("  FAIL " + name); console.log("       " + (e && e.message)) })
        }
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
    }
}

function summary(label) {
    console.log("\n" + label + ": " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
    return {pass, fail}
}

module.exports = {loadAfpModule, resetGlobals, makeChromeStub, it, summary, assert, ROOT}
