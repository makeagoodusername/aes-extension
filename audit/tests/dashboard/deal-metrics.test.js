"use strict"

const {loadModule, it, summary, assert, approx} = require("./_helpers")

console.log("=== deal-metrics ===")

const win = loadModule("modules/used-aircraft-scanner/deal-metrics.js")
const M = win.MarketScanDealMetrics
assert.ok(M, "MarketScanDealMetrics not exposed")

it("BLOCK_HOURS_BY_CATEGORY values per AGENT-5.md spec", () => {
    assert.strictEqual(M.BLOCK_HOURS_BY_CATEGORY.commuter,   8)
    assert.strictEqual(M.BLOCK_HOURS_BY_CATEGORY.turboprop,  8)
    assert.strictEqual(M.BLOCK_HOURS_BY_CATEGORY.regional,   8)
    assert.strictEqual(M.BLOCK_HOURS_BY_CATEGORY.narrowbody, 12)
    assert.strictEqual(M.BLOCK_HOURS_BY_CATEGORY.widebody,   14)
})

it("_blockHoursFor reads category, falls back to 10h legacy default", () => {
    assert.strictEqual(M._blockHoursFor({familyCategory: "narrowbody"}), 12)
    assert.strictEqual(M._blockHoursFor({familyCategory: "widebody"}),   14)
    assert.strictEqual(M._blockHoursFor({}), 10)
    assert.strictEqual(M._blockHoursFor(null), 10)
    assert.strictEqual(M._blockHoursFor({familyCategory: "junk"}), 10)
})

it("acquisitionPrice picks the cheaper of nextBid/immediatePurchase, ignores zero", () => {
    assert.strictEqual(M.acquisitionPrice({nextBid: 100, immediatePurchase: 80}), 80)
    assert.strictEqual(M.acquisitionPrice({nextBid: 100}), 100)
    assert.strictEqual(M.acquisitionPrice({nextBid: 0,   immediatePurchase: 50}), 50)
    assert.strictEqual(M.acquisitionPrice({}), null)
    assert.strictEqual(M.acquisitionPrice(null), null)
})

it("monthlyLeasePayment returns null on missing/zero leasingRate", () => {
    assert.strictEqual(M.monthlyLeasePayment({leasingRate: 1500}), 1500)
    assert.strictEqual(M.monthlyLeasePayment({leasingRate: 0}), null)
    assert.strictEqual(M.monthlyLeasePayment({}), null)
})

it("leasePerSeat returns rounded monthly/seats", () => {
    assert.strictEqual(M.leasePerSeat({leasingRate: 15000, seats: 150}), 100)
    assert.strictEqual(M.leasePerSeat({leasingRate: 1234,  seats: 100}), 12)
    assert.strictEqual(M.leasePerSeat({leasingRate: 1500,  seats: 0}),  null)
    assert.strictEqual(M.leasePerSeat({}), null)
})

it("seatKmYearCostBreakdown formula: price / (seats × range × remaining)", () => {
    const b = M.seatKmYearCostBreakdown({
        nextBid: 1e7, seats: 100, range: 5000, ageYears: 5
    })
    assert.ok(b)
    assert.strictEqual(b.price, 1e7)
    assert.strictEqual(b.seats, 100)
    assert.strictEqual(b.range, 5000)
    assert.strictEqual(b.remainingYears, 20) // 25 - 5
    // 1e7 / (100 × 5000 × 20) = 1
    assert.ok(approx(b.value, 1, 0.0001))
})

it("seatKmYearCostBreakdown floors remainingYears at 1 for >=25y aircraft", () => {
    const b = M.seatKmYearCostBreakdown({
        nextBid: 1e6, seats: 100, range: 1000, ageYears: 25
    })
    assert.strictEqual(b.remainingYears, 1)
})

it("daysToBreakEvenBreakdown returns null when daily profit ≤ 0", () => {
    const row = {nextBid: 1e7, seats: 100, speed: 800, familyCategory: "narrowbody"}
    const econ = {loadFactor: 0.75, yieldPerKm: 0,
                  fuelCostPerHour: 1e6, crewCostPerHour: 0, maintenanceCostPerHour: 0}
    assert.strictEqual(M.daysToBreakEvenBreakdown(row, econ), null)
})

it("daysToBreakEvenBreakdown uses BLOCK_HOURS_BY_CATEGORY hours", () => {
    const econ = {loadFactor: 0.75, yieldPerKm: 0.10, fuelCostPerHour: 100,
                  crewCostPerHour: 100, maintenanceCostPerHour: 100}
    const wb = M.daysToBreakEvenBreakdown(
        {nextBid: 1e6, seats: 200, speed: 800, familyCategory: "widebody"}, econ)
    const nb = M.daysToBreakEvenBreakdown(
        {nextBid: 1e6, seats: 200, speed: 800, familyCategory: "narrowbody"}, econ)
    assert.strictEqual(wb.hours, 14)
    assert.strictEqual(nb.hours, 12)
    // widebody flies more hours/day at same speed → more dailyKm → faster payback
    assert.ok(wb.value < nb.value, "widebody should pay back faster than narrowbody")
})

it("routeFit total/fit/limited counters with synthetic topRoutes", () => {
    const topRoutes = [
        {distanceKm: 1000, paxScore: 5,  weeklyFlights: 7},   // small route
        {distanceKm: 2000, paxScore: 10, weeklyFlights: 14},  // medium
        {distanceKm: 8000, paxScore: 20, weeklyFlights: 7},   // long-haul, out of range
        {distanceKm: 500,  paxScore: 50, weeklyFlights: 100}, // demand-heavy
        {distanceKm: 0}                                        // unknown distance, dropped
    ]
    // Aircraft: 200 seats, 5000 km range — fits short & medium, can't reach 8000
    const fit = M.routeFit(
        {seats: 200, range: 5000},
        topRoutes,
        {loadFactor: 0.5, paxSeatsPerScorePoint: 15, weeklyDemandPerScorePoint: 100}
    )
    assert.strictEqual(fit.total, 4) // unknown-distance excluded from denominator
    assert.ok(fit.rangeOnly >= 0)
    // The 8000km route fails range
    // The 500km × paxScore 50 needs effective seats ≥ 50 × 15 = 750; we have 100. → demandLimited
    // Routes 1 and 2 should pass per-flight + freq gates
    assert.strictEqual(fit.demandLimited + fit.frequencyLimited + fit.fit, fit.rangeOnly)
})

it("routeFit weeklyDemandPerScorePoint default 100", () => {
    // Construct route where: per-flight gate passes but weekly gate fails with default 100
    // wf × effSeats < paxScore × wScale  →  3 × 100 < 5 × 100  → 300 < 500 → fails
    const topRoutes = [{distanceKm: 1000, paxScore: 5, weeklyFlights: 3}]
    const fit = M.routeFit(
        {seats: 200, range: 2000},
        topRoutes,
        {loadFactor: 0.5}  // effSeats = 100; paxScore=5 → per-flight needs 5×15=75 ✓
    )
    assert.strictEqual(fit.frequencyLimited, 1)
    assert.strictEqual(fit.fit, 0)
    assert.strictEqual(fit.weeklyDemandPerScorePoint, 100)
})

it("routeFit returns null when topRoutes is not an array", () => {
    assert.strictEqual(M.routeFit({seats: 100, range: 1000}, null, {}), null)
    assert.strictEqual(M.routeFit({seats: 100, range: 1000}, undefined, {}), null)
})

it("fleetSynergy: owned=true when count>0", () => {
    const fleetByType = new Map([["B738", {count: 4}], ["A320", {count: 0}]])
    const a = M.fleetSynergy({typeId: "B738"}, fleetByType)
    assert.strictEqual(a.owned, true)
    assert.strictEqual(a.count, 4)
    assert.strictEqual(a.label, "✓ 4")
    const b = M.fleetSynergy({typeId: "A320"}, fleetByType)
    assert.strictEqual(b.owned, false)
    assert.strictEqual(b.label, null)
    assert.strictEqual(M.fleetSynergy({typeId: "B738"}, null), null)
})

it("maintenanceTrajectory bands", () => {
    assert.strictEqual(M.maintenanceTrajectory({conditionPct: 90, ageYears: 3}).level,  "green")
    assert.strictEqual(M.maintenanceTrajectory({conditionPct: 70, ageYears: 8}).level,  "amber")
    assert.strictEqual(M.maintenanceTrajectory({conditionPct: 80, ageYears: 16}).level, "amber")
    assert.strictEqual(M.maintenanceTrajectory({conditionPct: 30, ageYears: 5}).level,  "red")
    assert.strictEqual(M.maintenanceTrajectory({conditionPct: 80, ageYears: 30}).level, "red")
    assert.strictEqual(M.maintenanceTrajectory({}), null)
})

it("decorate writes all named scalars from priority audit area #1", () => {
    const row = {
        typeId: "B738", familyCategory: "narrowbody",
        seats: 180, range: 4000, speed: 850, ageYears: 6, conditionPct: 85,
        nextBid: 5e6, immediatePurchase: 6e6,
        leasingRate: 1500, leasingDepot: 200000,
        cargoCapacity: 0
    }
    M.decorate(row, {
        leaseConfig: {mode: "lease", termMonths: 60},
        economics:   {loadFactor: 0.75, yieldPerKm: 0.08,
                      fuelCostPerHour: 500, crewCostPerHour: 400,
                      maintenanceCostPerHour: 200},
        fleetByType: new Map([["B738", {count: 2}]]),
        topRoutes:   [{distanceKm: 2000, paxScore: 5, weeklyFlights: 7}],
        routeFitConfig: {paxSeatsPerScorePoint: 15, weeklyDemandPerScorePoint: 100}
    })
    // priceBasis chosen, scalars all present:
    assert.ok(row.priceBasis === "lease")
    assert.ok(typeof row.leasePerSeat === "number")
    assert.ok(typeof row.monthlyLease === "number")
    assert.ok(typeof row.pricePerSeat === "number")
    assert.ok(typeof row.seatKmYearCost === "number")
    assert.ok(row.seatKmYearBreakdown && typeof row.seatKmYearBreakdown.value === "number")
    assert.ok(typeof row.breakEvenDays === "number")
    assert.ok(row.breakEvenBreakdown && typeof row.breakEvenBreakdown.value === "number")
    // route-fit fields populated
    assert.ok(typeof row.routeFitCount === "number")
    assert.ok(typeof row.routeFitTotal === "number")
    assert.ok(typeof row.routeFitLabel === "string")
    assert.ok(typeof row.routeFitRangeOnly === "number")
    // fleet
    assert.strictEqual(row.fleetOwned, true)
    assert.strictEqual(row.fleetOwnedCount, 2)
    // maintenance
    assert.ok(["green", "amber", "red"].includes(row.maintLevel))
    assert.ok([1, 2, 3].includes(row.maintRank))
    // userMode is the lease/buy display switch
    assert.strictEqual(row.userMode, "lease")
})

summary("deal-metrics")
