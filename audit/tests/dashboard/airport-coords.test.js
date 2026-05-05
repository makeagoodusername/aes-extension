"use strict"

const {loadModule, it, summary, assert, approx} = require("./_helpers")

console.log("=== airport-coords ===")

const win = loadModule("modules/world-view/airport-coords.js")
const C = win.WorldViewAirportCoords
assert.ok(C, "WorldViewAirportCoords not exposed")

it("known IATAs return coords with sensible lat/lon ranges", () => {
    const cases = [
        ["JFK", 40, 41,  -75, -73],   // New York
        ["LAX", 33, 35, -119, -118],
        ["LHR", 51, 52,   -1,   1],
        ["NRT", 35, 36,  140, 141],
        ["SYD", -34, -33, 151, 152]
    ]
    for (const [iata, latLo, latHi, lonLo, lonHi] of cases) {
        const c = C.get(iata)
        assert.ok(c, "missing IATA " + iata)
        assert.ok(c.lat >= latLo && c.lat <= latHi,
                  iata + " lat " + c.lat + " out of [" + latLo + "," + latHi + "]")
        assert.ok(c.lon >= lonLo && c.lon <= lonHi,
                  iata + " lon " + c.lon + " out of [" + lonLo + "," + lonHi + "]")
    }
})

it("unknown IATAs return null (renderer hides bubble)", () => {
    assert.strictEqual(C.get("XYZ"), null)
    assert.strictEqual(C.get(""), null)
    assert.strictEqual(C.get(null), null)
})

it("get is case-insensitive on input", () => {
    const a = C.get("jfk")
    const b = C.get("JFK")
    assert.deepStrictEqual(a, b)
})

it("project: equirectangular x,y in [0,1]", () => {
    const p = C.project(40.6413, -73.7781)  // JFK
    assert.ok(p.x >= 0 && p.x <= 1)
    assert.ok(p.y >= 0 && p.y <= 1)
    // x should be west of center: lon = -73.78 → x ≈ (180-73.78)/360 ≈ 0.295
    assert.ok(approx(p.x, (180 - 73.7781) / 360, 0.01))
    // y should be northern hemisphere: lat = 40.6 → y ≈ (90-40.6)/180 ≈ 0.275
    assert.ok(approx(p.y, (90 - 40.6413) / 180, 0.01))
})

it("project clamps out-of-range values to [0,1]", () => {
    assert.deepStrictEqual(C.project(0, 200), {x: 1, y: 0.5})
    assert.deepStrictEqual(C.project(0, -200), {x: 0, y: 0.5})
    assert.deepStrictEqual(C.project(100, 0), {x: 0.5, y: 0})
    assert.deepStrictEqual(C.project(-100, 0), {x: 0.5, y: 1})
})

it("table size is large enough to cover most AS networks (>=200)", () => {
    // The brief notes coverage is "most" but unusual servers may surface gaps;
    // 200 is the working order of magnitude for this curated table.
    assert.ok(C.size() >= 200, "size " + C.size() + " < 200 — coverage may be lacking")
})

it("STO alias resolves to ARN (Stockholm)", () => {
    const sto = C.get("STO")
    const arn = C.get("ARN")
    assert.ok(sto && arn)
    assert.deepStrictEqual(sto, arn)
})

summary("airport-coords")
