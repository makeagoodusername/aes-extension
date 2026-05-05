"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

/**
 * Eval a project module in a fresh `global.window` context. Most AES
 * modules are IIFEs that attach to `window.<Namespace>`; this helper
 * sets up the global, evals the source, and returns the populated window.
 *
 * `windowExtras` lets tests pre-stub globals the module reaches for
 * (e.g. `window.AesStrategy.scoreRoutes`).
 */
function loadModule(relPath, windowExtras) {
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    global.window = Object.assign({}, windowExtras || {})
    eval(src)
    return global.window
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
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) {
            console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
        }
    }
}

function summary(label) {
    console.log("\n" + label + ": " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
    return {pass, fail}
}

module.exports = {loadModule, it, summary, assert, ROOT}
