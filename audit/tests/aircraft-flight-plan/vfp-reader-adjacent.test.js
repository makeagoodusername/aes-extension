"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"))
    }
}

function classList(names) {
    const set = new Set(names)
    return { contains: name => set.has(name) }
}

function locationBlock(direction, iata) {
    return {
        classList: classList(["block", "location"]),
        querySelector(selector) {
            const wanted = selector.split(",").map(s => s.trim())
            if (!wanted.includes("." + direction)) return null
            return {
                classList: classList([direction]),
                getAttribute(name) { return name === "title" ? iata : null },
                textContent: iata
            }
        }
    }
}

function block(kind) {
    return { classList: classList(["block", kind]) }
}

function loadReaderInternals() {
    const file = path.resolve(__dirname, "..", "..", "..", "modules/aircraft-flight-plan/vfp-reader.js")
    const sandbox = {window: {}, console}
    vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, {filename: file})
    return sandbox.window.AesAfpVfpReader._internals
}

console.log("=== vfp-reader adjacent endpoints ===")

const I = loadReaderInternals()

it("keeps scanning past opposite-direction location bars for destination", () => {
    const children = [
        locationBlock("outbound", "JFK"),
        block("flight"),
        locationBlock("outbound", "JFK"),
        block("ready"),
        locationBlock("inbound", "LHR")
    ]
    assert.strictEqual(I.findAdjacentIata(children, 1, +1, ".inbound"), "LHR")
})

it("keeps scanning past opposite-direction location bars for origin", () => {
    const children = [
        locationBlock("outbound", "JFK"),
        block("ready"),
        locationBlock("inbound", "LHR"),
        block("flight")
    ]
    assert.strictEqual(I.findAdjacentIata(children, 3, -1, ".outbound"), "JFK")
})

it("still stops at the next flight boundary", () => {
    const children = [
        block("flight"),
        locationBlock("outbound", "JFK"),
        block("flight"),
        locationBlock("inbound", "LHR")
    ]
    assert.strictEqual(I.findAdjacentIata(children, 0, +1, ".inbound"), null)
})

console.log("\nvfp-reader-adjacent: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)
