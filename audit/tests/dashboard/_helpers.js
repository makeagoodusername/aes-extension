"use strict"

/**
 * Shared helpers for dashboard smoke tests.
 *
 * Each test file reads its target source via fs, sets up a minimal `window`
 * global, evals it, and asserts. No jsdom — all targets are pure functions
 * that don't touch the DOM.
 */
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function loadModule(relPath, windowExtras) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    global.window = Object.assign({}, windowExtras || {})
    // module sources reference `window` via the global; run in this context
    // so the IIFE assigns to global.window.X.
    eval(src)
    return global.window
}

function approx(a, b, tol) {
    tol = tol == null ? 1e-6 : tol
    return Math.abs(a - b) <= tol
}

let pass = 0
let fail = 0
function it(name, fn) {
    try {
        fn()
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

module.exports = {loadModule, approx, it, summary, assert}
