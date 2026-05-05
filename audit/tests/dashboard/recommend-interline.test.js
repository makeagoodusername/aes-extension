"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

console.log("=== recommend-interline ===")

const win = loadModule("modules/world-view/recommend-interline.js")
const RI = win.WorldViewRecommendInterline
assert.ok(RI, "WorldViewRecommendInterline not exposed")

function mkEnt(id, hubs, footprint) {
    return {
        enterpriseId: id,
        name: "Carrier-" + id,
        hubs:           (hubs || []).map(i => ({iata: i})),
        routeFootprint: (footprint || []).map(i => ({destIata: i}))
    }
}

it("excludes own enterprise ids", () => {
    const enterprises = new Map([
        ["mine", mkEnt("mine", ["JFK"], ["LAX", "ORD", "DFW", "MIA", "BOS"])],
        ["A",    mkEnt("A",    ["JFK"], ["LAX", "ORD", "DFW", "MIA", "BOS"])]
    ])
    const out = RI.rank({
        network: {
            destinations: [],
            hubs:         ["JFK"],
            carrierIndex: {ownEnterpriseIds: ["mine"]}
        },
        enterprises:  enterprises,
        partnerCache: new Map(),
        hub:          "JFK"
    })
    // own ent excluded; only A is a candidate
    const ids = out.map(c => c.enterpriseId)
    assert.ok(!ids.includes("mine"))
    assert.ok(ids.includes("A"))
})

it("excludes existing ALLIANCE / INTERLINING partners", () => {
    const enterprises = new Map([
        ["A", mkEnt("A", ["JFK"], ["LAX", "ORD", "DFW", "MIA", "BOS"])],
        ["B", mkEnt("B", ["JFK"], ["LAX", "ORD", "DFW", "MIA", "BOS"])],
        ["C", mkEnt("C", ["JFK"], ["LAX", "ORD", "DFW", "MIA", "BOS"])]
    ])
    const partnerCache = new Map([
        ["A", ["ALLIANCE"]],
        ["B", ["INTERLINING"]],
        // C not in partnerCache → eligible
    ])
    const out = RI.rank({
        network: {
            destinations: [],
            hubs:         ["JFK"],
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises:  enterprises,
        partnerCache: partnerCache,
        hub:          "JFK"
    })
    const ids = out.map(c => c.enterpriseId)
    assert.ok(!ids.includes("A"))
    assert.ok(!ids.includes("B"))
    assert.ok(ids.includes("C"))
})

it("relation matching is case-insensitive (uppercase normalisation)", () => {
    // partnerCache might have lower-case rels (defensive)
    const enterprises = new Map([
        ["A", mkEnt("A", ["JFK"], ["LAX", "ORD", "DFW", "MIA"])]
    ])
    const partnerCache = new Map([["A", ["alliance"]]])  // lowercase
    const out = RI.rank({
        network: {destinations: [], hubs: ["JFK"], carrierIndex: {ownEnterpriseIds: []}},
        enterprises: enterprises, partnerCache, hub: "JFK"
    })
    assert.strictEqual(out.length, 0, "lowercase 'alliance' should still exclude")
})

it("skip when newReach < 4", () => {
    const enterprises = new Map([
        ["A", mkEnt("A", ["JFK"], ["LAX", "ORD", "DFW"])]   // only 3 dests
    ])
    const out = RI.rank({
        network: {destinations: [], hubs: ["JFK"], carrierIndex: {ownEnterpriseIds: []}},
        enterprises, partnerCache: new Map(), hub: "JFK"
    })
    assert.strictEqual(out.length, 0)
})

it("skip when contestedFraction > 0.35", () => {
    // myDests = {LAX, ORD, MIA}; rival dominant on LAX, ORD → 2/3 = 66% contested
    const enterprises = new Map([
        ["A", mkEnt("A", ["JFK"], ["LAX", "ORD", "DFW", "BOS", "DCA"])]
    ])
    const out = RI.rank({
        network: {
            destinations: [
                {dest: "LAX", competition: {dominantEnterpriseId: "A"}},
                {dest: "ORD", competition: {dominantEnterpriseId: "A"}},
                {dest: "MIA", competition: {dominantEnterpriseId: "Z"}}
            ],
            hubs:         ["JFK"],
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises, partnerCache: new Map(), hub: "JFK"
    })
    assert.strictEqual(out.length, 0)
})

it("score: 4·feedToHub + 1.5·newReach − 5·overlapDom (positive only)", () => {
    // Rival hubs at JFK → feedToHub = 1
    // Rival dests union = {LAX, ORD, DFW, MIA, BOS}; my dests = {} → newReach 5
    // overlapDom = 0 (no my-dests)
    // score = 4 + 7.5 = 11.5
    const enterprises = new Map([
        ["A", mkEnt("A", ["JFK"], ["LAX", "ORD", "DFW", "MIA", "BOS"])]
    ])
    const out = RI.rank({
        network: {destinations: [], hubs: ["JFK"], carrierIndex: {ownEnterpriseIds: []}},
        enterprises, partnerCache: new Map(), hub: "JFK"
    })
    assert.strictEqual(out[0].feedToHub, 1)
    assert.strictEqual(out[0].newReach, 5)
    assert.strictEqual(out[0].overlapDom, 0)
    assert.strictEqual(out[0].score, 11.5)
})

it("default limit is 8", () => {
    const enterprises = new Map()
    for (let i = 1; i <= 12; i++) {
        enterprises.set("E" + i, mkEnt("E" + i, ["JFK"],
            ["X" + i, "Y" + i, "Z" + i, "W" + i, "V" + i]))
    }
    const out = RI.rank({
        network: {destinations: [], hubs: ["JFK"], carrierIndex: {ownEnterpriseIds: []}},
        enterprises, partnerCache: new Map(), hub: "JFK"
    })
    assert.strictEqual(out.length, 8)
})

summary("recommend-interline")
