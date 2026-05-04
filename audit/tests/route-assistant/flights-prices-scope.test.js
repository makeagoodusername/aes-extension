"use strict"

/**
 * Pure-function smoke for modules/route-assistant/flights-prices-scope.js.
 * Locks down the contract of resolveScope(filter, routes):
 *   - empty / "anywhere" filters pass everything
 *   - airport-id filter (a:NNN) matches by hubAirportId/destAirportId
 *   - country-id filter (c:NNN) matches by hubCountryId/destCountryId
 *   - serviceProfileId filter ("0"/"" = any)
 *   - class filter narrows by route.classes overlap
 *   - empty class filter → ALL_CLASSES echoed back
 */
const path = require("path")
const assert = require("assert")
const scopeApi = require(path.resolve(__dirname, "..", "..", "..",
    "modules/route-assistant/flights-prices-scope.js"))

let pass = 0, fail = 0
function it(name, fn) {
    try { fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"))
    }
}

console.log("=== flights-prices-scope resolver ===")

const ROUTES = [
    {hub: "JFK", dest: "LAX", hubAirportId: 3551, destAirportId: 3395,
     hubCountryId: 182, destCountryId: 182, serviceProfileId: 611, classes: ["Y","C","F"]},
    {hub: "JFK", dest: "MIA", hubAirportId: 3551, destAirportId: 3315,
     hubCountryId: 182, destCountryId: 182, serviceProfileId: 611, classes: ["Y","C"]},
    {hub: "JFK", dest: "PUJ", hubAirportId: 3551, destAirportId: 753,
     hubCountryId: 182, destCountryId: 38,  serviceProfileId: 611, classes: ["Y","Cargo"]},
    {hub: "JFK", dest: "YYZ", hubAirportId: 3551, destAirportId: 1701,
     hubCountryId: 182, destCountryId: 75,  serviceProfileId: 611, classes: ["Y","C"]},
    {hub: "BOS", dest: "LAX", hubAirportId: 3448, destAirportId: 3395,
     hubCountryId: 182, destCountryId: 182, serviceProfileId: 612, classes: ["Y"]}
]

it("anywhere → anywhere returns every route", () => {
    const r = scopeApi.resolveScope({fromCode: "", toCode: ""}, ROUTES)
    assert.strictEqual(r.routes.length, 5, "expected 5 routes")
    assert.deepStrictEqual(r.classes, ["Y", "C", "F", "Cargo"])
})

it("airport→airport filter matches a single pair", () => {
    const r = scopeApi.resolveScope({fromCode: "a:3551", toCode: "a:3395"}, ROUTES)
    assert.strictEqual(r.routes.length, 1)
    assert.strictEqual(r.routes[0].dest, "LAX")
})

it("airport→country filter spans multiple destinations", () => {
    const r = scopeApi.resolveScope({fromCode: "a:3551", toCode: "c:182"}, ROUTES)
    assert.strictEqual(r.routes.length, 2, "JFK→{LAX,MIA} are USA-USA")
})

it("country→country filter excludes other-country routes", () => {
    const r = scopeApi.resolveScope({fromCode: "c:182", toCode: "c:38"}, ROUTES)
    assert.strictEqual(r.routes.length, 1)
    assert.strictEqual(r.routes[0].dest, "PUJ")
})

it("serviceProfileId narrows", () => {
    const r = scopeApi.resolveScope({serviceProfileId: "612"}, ROUTES)
    assert.strictEqual(r.routes.length, 1)
    assert.strictEqual(r.routes[0].hub, "BOS")
})

it("serviceProfileId='0' is treated as any", () => {
    const r = scopeApi.resolveScope({serviceProfileId: "0"}, ROUTES)
    assert.strictEqual(r.routes.length, 5)
})

it("class filter narrows to routes offering at least one selected class", () => {
    const r = scopeApi.resolveScope({classes: ["F"]}, ROUTES)
    assert.strictEqual(r.routes.length, 1)
    assert.strictEqual(r.routes[0].dest, "LAX")
    assert.deepStrictEqual(r.classes, ["F"])
})

it("class filter ['Cargo'] picks only cargo-offering routes", () => {
    const r = scopeApi.resolveScope({classes: ["Cargo"]}, ROUTES)
    assert.strictEqual(r.routes.length, 1)
    assert.strictEqual(r.routes[0].dest, "PUJ")
})

it("empty class filter echoes all classes", () => {
    const r = scopeApi.resolveScope({classes: []}, ROUTES)
    assert.deepStrictEqual(r.classes, ["Y", "C", "F", "Cargo"])
})

it("invalid prefix gracefully falls back to any", () => {
    const r = scopeApi.resolveScope({fromCode: "garbage:xyz"}, ROUTES)
    assert.strictEqual(r.routes.length, 5)
})

it("empty match → reason='emptyMatch'", () => {
    const r = scopeApi.resolveScope({fromCode: "a:99999"}, ROUTES)
    assert.strictEqual(r.routes.length, 0)
    assert.strictEqual(r.reason, "emptyMatch")
})

console.log("\n" + pass + " passed, " + fail + " failed")
process.exit(fail ? 1 : 0)
