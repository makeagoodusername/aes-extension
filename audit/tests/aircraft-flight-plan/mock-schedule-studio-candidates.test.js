"use strict"

/**
 * Mock-schedule studio candidate sourcing.
 *
 * The AS New Flight Number form can expose permitted station routes on either
 * the origin or destination select depending on the current reverse state.
 * The studio must read both selects so it does not mislabel a valid route as
 * "no permit" when the form is currently pointed inbound.
 */

const assert = require("assert")
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..", "..", "..")
const STUDIO_PATH = path.join(ROOT, "modules/aircraft-flight-plan/mock-schedule/studio.js")

let pass = 0, fail = 0
async function it(name, fn) {
    try { await fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"))
    }
}

function opt(text, value) {
    return {textContent: text, text, value}
}

function select(options, selectedIndex) {
    return {options, selectedIndex: selectedIndex == null ? 0 : selectedIndex}
}

function loadStudioWith(form, routes) {
    global.window = {}
    global.AesAfp = global.window.AesAfp = {
        getNewFlightForm: () => form
    }
    global.FlightsFromStore = global.window.FlightsFromStore = {
        loadAirport: async () => ({routes: routes || []})
    }
    const src = fs.readFileSync(STUDIO_PATH, "utf8")
    eval(src)
    return global.window.AesAfpMockScheduleStudio
}

async function run() {
    console.log("=== mock-schedule studio candidates ===")

    await it("uses origin-select routes as permitted when the AS form is reversed", async () => {
        const studio = loadStudioWith({
            originSelect: select([
                opt("New York (JFK)", "jfk"),
                opt("Chicago (ORD)", "ord"),
                opt("Seattle (SEA)", "sea")
            ], 1),
            destSelect: select([
                opt("New York (JFK)", "jfk")
            ], 0)
        }, [
            {iata: "ORD", name: "Chicago", distanceKm: 1188},
            {iata: "LAX", name: "Los Angeles", distanceKm: 3983}
        ])

        const candidates = await studio._internal.gatherCandidateAirports({}, "JFK")
        const byIata = new Map(candidates.map(c => [c.iata, c]))

        assert.ok(!byIata.has("JFK"), "hub should not be offered as a destination")
        assert.ok(byIata.has("ORD"), "ORD should be present from origin select")
        assert.strictEqual(byIata.get("ORD").pickable, true, "origin-select route should be usable")
        assert.strictEqual(byIata.get("ORD").inOriginSelect, true)
        assert.strictEqual(byIata.get("ORD").directions.inbound, true)
        assert.strictEqual(studio._internal.directionLabel(byIata.get("ORD")), "in")
        assert.strictEqual(byIata.get("LAX").pickable, false, "FF-only route still lacks AS permit")
    })

    await it("merges routes seen on both station selects and labels them in/out", async () => {
        const studio = loadStudioWith({
            originSelect: select([
                opt("New York (JFK)", "jfk"),
                opt("Miami (MIA)", "mia")
            ], 0),
            destSelect: select([
                opt("New York (JFK)", "jfk"),
                opt("Miami (MIA)", "mia")
            ], 1)
        }, [
            {iata: "MIA", name: "Miami", distance: 1760}
        ])

        const candidates = await studio._internal.gatherCandidateAirports({}, "JFK")
        const mia = candidates.find(c => c.iata === "MIA")

        assert.ok(mia, "MIA candidate present")
        assert.strictEqual(mia.inOriginSelect, true)
        assert.strictEqual(mia.inDestSelect, true)
        assert.strictEqual(mia.pickable, true)
        assert.strictEqual(studio._internal.directionLabel(mia), "in/out")
        assert.strictEqual(Math.round(mia.distanceKm), 1760)
    })

    console.log("\nmock-schedule-studio-candidates: " + pass + " passed, " + fail + " failed")
    process.exit(fail === 0 ? 0 : 1)
}

run().catch(e => {
    console.log("  FAIL uncaught - " + (e && e.message))
    process.exit(1)
})
