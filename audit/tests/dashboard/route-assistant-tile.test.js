"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

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

function loadTile() {
    global.window = global
    global.CentralHubTile = class {}
    global.CentralHubTileRegistry = { register() {} }
    let src = fs.readFileSync(path.join(ROOT, "modules/central-hub/tiles/route-assistant-tile.js"), "utf8")
    src += "\n;window.CentralHubRouteAssistantTile = CentralHubRouteAssistantTile;\n"
    eval(src)
    return new window.CentralHubRouteAssistantTile()
}

console.log("=== Route Assistant tile ===")

;(async () => {
    await it("opens cached top route pairs instead of same-airport scheduling paths", () => {
        const tile = loadTile()

        assert.strictEqual(tile._scheduleTargetForHub({
            hub: "JFK",
            record: {rows: [{destIata: "ORD"}]}
        }), "JFKORD")

        assert.strictEqual(tile._scheduleTargetForHub({
            hub: "jfk",
            record: {rows: [{dest: "lax"}]}
        }), "JFKLAX")
    })

    await it("generic Open uses the first complete cached route target", async () => {
        const tile = loadTile()
        global.location = {href: ""}
        tile._loadHubs = async () => [
            {hub: "JFK", record: {rows: []}},
            {hub: "LAX", record: {rows: [{destIata: "SFO"}]}}
        ]

        await tile.openHandler()()

        assert.strictEqual(global.location.href, "/app/com/scheduling/LAXSFO")
    })

    await it("keeps in-air routes visible even when proposal rows fill the panel", () => {
        const tile = loadTile()
        const preview = {rows: [
            {pair: "JFK-A", stage: "proposed"},
            {pair: "JFK-B", stage: "proposed"},
            {pair: "JFK-C", stage: "proposed"},
            {pair: "JFK-D", stage: "proposed"},
            {pair: "JFK-E", stage: "proposed"},
            {pair: "JFK-FCO", stage: "skipped",
             activeFlightControls: {inflight: 1, sourcePairs: ["FCO-JFK"]}},
            {pair: "JFK-Z", stage: "skipped"}
        ]}

        const rows = tile._autoPricingDisplayRows(preview)

        assert.strictEqual(rows.length, 6)
        assert.ok(rows.some(r => r.pair === "JFK-FCO"), "active flight row is included")
    })

    await it("keeps cooldown routes visible when live gate is cooling down", () => {
        const tile = loadTile()
        const preview = {rows: [
            {pair: "JFK-FCO", stage: "skipped",
             activeFlightControls: {inflight: 1, sourcePairs: ["FCO-JFK"]}},
            {pair: "JFK-DUS", stage: "cooldown", cooldown: {remainingMin: 48}},
            {pair: "JFK-ZRH", stage: "cooldown", cooldown: {remainingMin: 33}},
            {pair: "JFK-A", stage: "skipped", pricingSignals: {demand: true}},
            {pair: "JFK-B", stage: "skipped", pricingSignals: {competition: true}},
            {pair: "JFK-C", stage: "skipped", pricingSignals: {competition: true}},
            {pair: "JFK-D", stage: "skipped", pricingSignals: {competition: true}}
        ]}

        const rows = tile._autoPricingDisplayRows(preview)

        assert.strictEqual(rows.length, 6)
        assert.ok(rows.some(r => r.pair === "JFK-DUS"), "cooldown DUS row is included")
        assert.ok(rows.some(r => r.pair === "JFK-ZRH"), "cooldown ZRH row is included")
    })

    console.log("\nRoute Assistant tile: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
