"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const src = fs.readFileSync(path.join(ROOT, "modules/aircraft-type-specs.js"), "utf8")
const AESAircraftTypeSpecs = new Function(src + "\nreturn AESAircraftTypeSpecs;")()

function fakeDoc(rows) {
    return {
        querySelectorAll(sel) {
            if (sel !== "table tr") return []
            return rows.map(([label, value]) => ({
                cells: [{textContent: label}, {textContent: value}],
                querySelectorAll(innerSel) {
                    if (innerSel !== "th, td") return []
                    return [{textContent: label}, {textContent: value}]
                }
            }))
        }
    }
}

console.log("=== aircraft type specs ORS attraction ===")

{
    const spec = AESAircraftTypeSpecs.parseFromDoc(fakeDoc([
        ["Seats", "180"],
        ["Cargo capacity", "12,500 kg"],
        ["Cruise speed", "840 km/h"],
        ["Range", "5,400 km"],
        ["Customer ORS attraction", "87 %"],
        ["Popularity with passengers", "79 %"]
    ]))
    assert.strictEqual(spec.seats, 180)
    assert.strictEqual(spec.cargoCapacity, 12500)
    assert.strictEqual(spec.speed, 840)
    assert.strictEqual(spec.range, 5400)
    assert.strictEqual(spec.orsAttraction, 87)
    assert.strictEqual(spec.customerAttraction, 87)
    assert.strictEqual(spec.paxSatisfaction, 79)
}

{
    const spec = AESAircraftTypeSpecs.parseFromDoc(fakeDoc([
        ["Passenger attraction", "64"]
    ]))
    assert.strictEqual(spec.orsAttraction, 64)
    assert.strictEqual(spec.customerAttraction, 64)
    assert.strictEqual(spec.paxSatisfaction, 64,
        "attraction backfills paxSatisfaction when no legacy popularity row exists")
}

{
    const spec = AESAircraftTypeSpecs.parseFromDoc(fakeDoc([
        ["Popularity with passengers", "757"]
    ]))
    assert.strictEqual(spec.paxSatisfaction, 757)
    assert.strictEqual(spec.orsAttraction, 757,
        "legacy passenger popularity backfills ORS attraction for AS pages using that label")
}

console.log("  ok  attraction fields parsed and preserved")
console.log("pass=3 fail=0")
