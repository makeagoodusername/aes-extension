"use strict"

/**
 * Smoke for modules/schedule-management/range-buckets.js — pure utility
 * methods on `ScheduleFactors`. Brief: bucket boundaries, kmToNm, parseHHMM.
 */
const {loadAfpModule, it, summary, assert} = require("./_helpers")

console.log("=== range-buckets ===")

const win = loadAfpModule("modules/schedule-management/range-buckets.js")
const F = win.ScheduleFactors
assert.ok(F, "ScheduleFactors not exposed on window")

it("bucketize: 0..1500 → shortHaul (low edge)", () => {
    assert.strictEqual(F.bucketize(0),    "shortHaul")
    assert.strictEqual(F.bucketize(500),  "shortHaul")
    assert.strictEqual(F.bucketize(1499), "shortHaul")
})
it("bucketize: 1500..3500 → mediumHaul (boundary inclusive on min, exclusive on max)", () => {
    assert.strictEqual(F.bucketize(1500), "mediumHaul")
    assert.strictEqual(F.bucketize(2500), "mediumHaul")
    assert.strictEqual(F.bucketize(3499), "mediumHaul")
})
it("bucketize: 3500..99999 → longHaul", () => {
    assert.strictEqual(F.bucketize(3500), "longHaul")
    assert.strictEqual(F.bucketize(8000), "longHaul")
})
it("bucketize: out-of-range → null", () => {
    assert.strictEqual(F.bucketize(99999), null,  "max edge exclusive")
    assert.strictEqual(F.bucketize(100000), null)
})
it("bucketize honours custom buckets", () => {
    const custom = { tiny: {min: 0, max: 50}, big: {min: 50, max: 1000} }
    assert.strictEqual(F.bucketize(10, custom),  "tiny")
    assert.strictEqual(F.bucketize(50, custom),  "big")
    assert.strictEqual(F.bucketize(999, custom), "big")
    assert.strictEqual(F.bucketize(1000, custom), null)
})

it("kmToNm rounds: 1852km ≈ 1000nm", () => {
    assert.strictEqual(F.kmToNm(1852), 1000)
})
it("kmToNm 0 → 0", () => assert.strictEqual(F.kmToNm(0), 0))
it("nmToKm: 1000nm → 1852km", () => assert.strictEqual(F.nmToKm(1000), 1852))
it("nmToKm round-trips approximately", () => {
    const v = F.nmToKm(F.kmToNm(2000))
    assert.ok(Math.abs(v - 2000) <= 2, "round-trip 2000km within 2km tolerance")
})

it("parseHHMM canonical", () => {
    assert.strictEqual(F.parseHHMM("00:00"), 0)
    assert.strictEqual(F.parseHHMM("06:00"), 360)
    assert.strictEqual(F.parseHHMM("23:59"), 23*60+59)
    assert.strictEqual(F.parseHHMM("12:30"), 750)
})
it("parseHHMM rejects bad input via NaN", () => {
    assert.ok(Number.isNaN(F.parseHHMM("24:00")), "24:00 → NaN")
    assert.ok(Number.isNaN(F.parseHHMM("09:0")),  "minutes must be two digits")
})
it("parseHHMM single-digit hour permitted", () => {
    assert.strictEqual(F.parseHHMM("9:00"), 540)   // regex /^([0-2]?\d):([0-5]\d)$/
})
it("parseHHMM rejects malformed", () => {
    assert.ok(Number.isNaN(F.parseHHMM("xx:yy")))
    assert.ok(Number.isNaN(F.parseHHMM("")))
    assert.ok(Number.isNaN(F.parseHHMM(null)))
    assert.ok(Number.isNaN(F.parseHHMM("99:99")))
})

it("formatHHMM round-trips parseHHMM", () => {
    assert.strictEqual(F.formatHHMM(0),     "00:00")
    assert.strictEqual(F.formatHHMM(360),   "06:00")
    assert.strictEqual(F.formatHHMM(750),   "12:30")
    assert.strictEqual(F.formatHHMM(1439),  "23:59")
})
it("formatHHMM wraps past 24h", () => {
    assert.strictEqual(F.formatHHMM(1440),  "00:00")
    assert.strictEqual(F.formatHHMM(1500),  "01:00")
})

it("aircraftCanFly: 5% safety margin", () => {
    // Exactly at margin: range × 0.95 ≥ distance → can fly
    assert.strictEqual(F.aircraftCanFly(1000, 950), true)
    assert.strictEqual(F.aircraftCanFly(1000, 951), false)   // outside margin
    assert.strictEqual(F.aircraftCanFly(0, 100), false)      // missing range
    assert.strictEqual(F.aircraftCanFly(1000, 0), false)     // missing distance
})

it("haversineNm — same point → 0", () => {
    assert.strictEqual(F.haversineNm(40.6413, -73.7781, 40.6413, -73.7781), 0)
})
it("haversineNm — JFK→LAX ≈ 2150nm", () => {
    const d = F.haversineNm(40.6413, -73.7781, 33.9416, -118.4085)
    assert.ok(Math.abs(d - 2150) < 30, "JFK→LAX within 30nm of 2150 (got " + d + ")")
})

it("withinWindow non-wrap window", () => {
    assert.strictEqual(F.withinWindow("12:00", "06:00", "23:00"), true)
    assert.strictEqual(F.withinWindow("05:00", "06:00", "23:00"), false)
    assert.strictEqual(F.withinWindow("23:01", "06:00", "23:00"), false)
})
it("withinWindow wraps past midnight", () => {
    assert.strictEqual(F.withinWindow("23:30", "22:00", "05:00"), true)
    assert.strictEqual(F.withinWindow("02:00", "22:00", "05:00"), true)
    assert.strictEqual(F.withinWindow("12:00", "22:00", "05:00"), false)
})
it("withinWindow rejects bad input", () => {
    assert.strictEqual(F.withinWindow("xx", "06:00", "23:00"), false)
})

it("resolveDayMask presets", () => {
    assert.deepStrictEqual(F.resolveDayMask("daily"),    [1,1,1,1,1,1,1])
    assert.deepStrictEqual(F.resolveDayMask("weekdays"), [1,1,1,1,1,0,0])
    assert.deepStrictEqual(F.resolveDayMask("weekends"), [0,0,0,0,0,1,1])
    assert.deepStrictEqual(F.resolveDayMask("custom", [1,0,1,0,1,0,1]), [1,0,1,0,1,0,1])
    assert.deepStrictEqual(F.resolveDayMask("garbage"),  [1,1,1,1,1,1,1], "fallback to daily")
})

it("minutesBetween signed delta", () => {
    assert.strictEqual(F.minutesBetween("06:00", "07:00"), 60)
    assert.strictEqual(F.minutesBetween("07:00", "06:00"), -60)
})

summary("range-buckets")
