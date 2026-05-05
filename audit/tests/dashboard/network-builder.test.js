"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

console.log("=== network-builder ===")

const win = loadModule("modules/world-view/network-builder.js", {
    WorldViewStyles: {normalize: (x, lo, hi) => {
        if (!isFinite(x)) return 0
        const range = hi - lo
        if (range <= 0) return 0
        const v = (x - lo) / range
        return v < 0 ? 0 : v > 1 ? 1 : v
    }}
})
const NB = win.WorldViewNetworkBuilder
assert.ok(NB, "WorldViewNetworkBuilder not exposed")

function fixture() {
    return {
        snapshot: {
            ts: 1234567890,
            server: "tempest",
            airlineCode: "AA",
            hubs: [
                {iata: "JFK", byRoute: [
                    {dest: "LAX", weeklyFlights: 14, paxScore: 8, distanceKm: 4000,
                     ourPaxShare: 0.3, alreadyScheduled: true,
                     competitor: {flightCount: 7, seatCount: 1500, dominantEnterpriseId: "12345"}},
                    {dest: "ORD", weeklyFlights: 7, paxScore: 5, distanceKm: 1180,
                     competitor: {flightCount: 14, seatCount: 2800, dominantEnterpriseId: "67890"}},
                    {dest: "MIA", weeklyFlights: 0, paxScore: 2, distanceKm: 1750}
                ]},
                {iata: "LAX", byRoute: []}
            ]
        },
        alliance: {scrapedAt: 1000, allianceName: "TestAlliance", members: [
            {enterpriseId: "12345", routeFootprint: [{destIata: "LAX"}, {destIata: "DFW"}]}
        ]},
        partnerCache: new Map([["12345", ["ALLIANCE"]], ["67890", ["INTERLINING"]]]),
        ownEnterpriseIds: ["555"],
        hub: "JFK"
    }
}

it("build is deterministic — same input → same output", () => {
    const a = NB.build(fixture())
    const b = NB.build(fixture())
    // Pick deterministic surface fields. ts is Date.now() each call so skip.
    delete a.ts; delete b.ts
    assert.deepStrictEqual(a, b)
})

it("destinations sorted by sizeWeight desc", () => {
    const out = NB.build(fixture())
    for (let i = 0; i + 1 < out.destinations.length; i++) {
        assert.ok(out.destinations[i].sizeWeight >= out.destinations[i + 1].sizeWeight,
                  "sizeWeight not desc at " + i)
    }
})

it("sourceFreshness.snapshotTs reflects snapshot.ts", () => {
    const out = NB.build(fixture())
    assert.strictEqual(out.sourceFreshness.snapshotTs, 1234567890)
    assert.strictEqual(out.sourceFreshness.allianceTs, 1000)
})

it("carrierClass classified via partnerCache", () => {
    const out = NB.build(fixture())
    const lax = out.destinations.find(d => d.dest === "LAX")
    const ord = out.destinations.find(d => d.dest === "ORD")
    assert.strictEqual(lax.carrierClass, "alliance",
                       "LAX dominant in partnerCache as ALLIANCE")
    assert.strictEqual(ord.carrierClass, "interline",
                       "ORD dominant in partnerCache as INTERLINING")
})

it("missing hub in snapshot → empty result + warning", () => {
    const fx = fixture()
    fx.hub = "BOS"   // not in hubs
    const out = NB.build(fx)
    assert.deepStrictEqual(out.destinations, [])
    assert.ok(out.warnings.includes("hub-not-in-snapshot"))
})

it("HARD_CAP truncates destinations to 200 + emits warning", () => {
    const byRoute = []
    for (let i = 0; i < 250; i++) {
        byRoute.push({dest: "X" + i, weeklyFlights: 1, paxScore: 1, distanceKm: 1000,
                      competitor: {flightCount: 0, seatCount: 0}})
    }
    const out = NB.build({
        snapshot: {ts: 1, server: "s", airlineCode: "A", hubs: [{iata: "JFK", byRoute}]},
        alliance: null, partnerCache: null, ownEnterpriseIds: [], hub: "JFK"
    })
    assert.strictEqual(out.destinations.length, 200)
    assert.ok(out.warnings.find(w => /^dest-cap:/.test(w)))
})

it("metrics counters populated", () => {
    const out = NB.build(fixture())
    assert.strictEqual(out.metrics.routeCount, 3)
    assert.strictEqual(out.metrics.weeklyDepartures, 14 + 7 + 0)
    assert.ok(out.metrics.topCompetitorShare > 0)
    assert.ok(out.metrics.avgCompetitionScore > 0)
})

summary("network-builder")
