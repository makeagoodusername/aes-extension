"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

console.log("=== recommend-alliance ===")

const win = loadModule("modules/world-view/recommend-alliance.js")
const RA = win.WorldViewRecommendAlliance
assert.ok(RA, "WorldViewRecommendAlliance not exposed")

function mkEnt(id, allianceName, hubIatas, footprintIatas) {
    return {
        enterpriseId: id,
        alliance: {id: allianceName, name: allianceName},
        hubs: (hubIatas || []).map(i => ({iata: i})),
        routeFootprint: (footprintIatas || []).map(i => ({destIata: i}))
    }
}

it("top-N cap respected", () => {
    // 7 alliances, limit 5 → output length 5
    const enterprises = new Map()
    for (let i = 1; i <= 7; i++) {
        enterprises.set("e" + i, mkEnt("e" + i, "Alliance" + i, ["JFK"], ["X" + i]))
    }
    const out = RA.rank({
        network: {
            destinations: [],
            hubs:        ["JFK"],
            myAlliance:  null,
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises: enterprises,
        hub:         "JFK",
        limit:       5
    })
    assert.strictEqual(out.length, 5)
})

it("default limit is 5 when omitted/zero", () => {
    const enterprises = new Map()
    for (let i = 1; i <= 9; i++) {
        enterprises.set("e" + i, mkEnt("e" + i, "Alliance" + i, ["JFK"], ["X" + i]))
    }
    const out = RA.rank({
        network: {destinations: [], hubs: ["JFK"], myAlliance: null,
                  carrierIndex: {ownEnterpriseIds: []}},
        enterprises: enterprises, hub: "JFK"
    })
    assert.strictEqual(out.length, 5)
})

it("score formula: reach + 8·feedersAtHub - 3·max(0, overlapHubs - feedersAtHub) - 2·contestedAt", () => {
    // Single alliance: 2 members, both at JFK (feedersAtHub=1 — set membership, not count)
    // Their union of dests = {LAX, DFW}; my dests = {ORD} → reach = 2
    // overlapHubs (allianceHubs ∩ myHubs) = {JFK} → 1
    // feedersAtHub = 1 (JFK in allianceHubs)
    // dup = max(0, 1-1) = 0
    // contestedAt = 0 (no destination dominantEnterpriseId in alliance ids)
    // score = 2 + 8 - 0 - 0 = 10
    const enterprises = new Map([
        ["A", mkEnt("A", "Star", ["JFK"], ["LAX"])],
        ["B", mkEnt("B", "Star", ["JFK"], ["DFW"])]
    ])
    const out = RA.rank({
        network: {
            destinations: [{dest: "ORD", competition: {dominantEnterpriseId: "Z"}}],
            hubs:         ["JFK"],
            myAlliance:   null,
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises: enterprises,
        hub:         "JFK",
        limit:       5
    })
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].score, 10)
    assert.strictEqual(out[0].reach, 2)
    assert.strictEqual(out[0].feedersAtHub, 1)
    assert.strictEqual(out[0].overlapHubs, 1)
})

it("contestedAt penalises alliances whose members are dominant on routes I serve", () => {
    const enterprises = new Map([
        ["A", mkEnt("A", "Rivals", ["JFK"], ["LAX", "ORD"])]
    ])
    const out = RA.rank({
        network: {
            destinations: [
                {dest: "LAX", competition: {dominantEnterpriseId: "A"}},
                {dest: "ORD", competition: {dominantEnterpriseId: "A"}}
            ],
            hubs:         ["JFK"],
            myAlliance:   null,
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises: enterprises,
        hub:         "JFK",
        limit:       5
    })
    // myDests = {LAX, ORD}; allianceDests = {LAX, ORD} → reach 0
    // feedersAtHub = 1; overlapHubs = 1
    // contestedAt = 2
    // score = 0 + 8 - 0 - 4 = 4
    assert.strictEqual(out[0].contestedAt, 2)
    assert.strictEqual(out[0].score, 4)
})

it("F-DASH-508 — isMine matches by name when bucket id has no myAlliance.id counterpart", () => {
    // Production shape: enterprise-scraper writes alliance: {id, name}
    // (bucket key = id), AllianceOverviewScraper writes myAlliance: {name}
    // (no id). Pre-fix the legacy `myAllianceKey === key` and slot.id===id
    // checks never matched, so isMine was universally false. Fix adds a
    // name-equal fallback so the user's own alliance still surfaces "MINE".
    const enterprises = new Map([["A", {
        enterpriseId: "A",
        alliance: {id: "42", name: "MyAlliance"},
        hubs: [{iata: "JFK"}],
        routeFootprint: [{destIata: "LAX"}]
    }]])
    const out = RA.rank({
        network: {
            destinations: [],
            hubs:         ["JFK"],
            myAlliance:   {name: "MyAlliance"},
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises: enterprises,
        hub:         "JFK",
        limit:       5
    })
    assert.strictEqual(out[0].isMine, true)
})

it("F-DASH-508 — isMine name-fallback is case-insensitive", () => {
    const enterprises = new Map([["A", {
        enterpriseId: "A",
        alliance: {id: "99", name: "Star Alliance"},
        hubs: [{iata: "JFK"}],
        routeFootprint: [{destIata: "LAX"}]
    }]])
    const out = RA.rank({
        network: {
            destinations: [],
            hubs:         ["JFK"],
            myAlliance:   {name: "STAR alliance"},
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises: enterprises,
        hub:         "JFK",
        limit:       5
    })
    assert.strictEqual(out[0].isMine, true)
})

it("F-DASH-508 — isMine stays false for unrelated alliances", () => {
    const enterprises = new Map([["A", {
        enterpriseId: "A",
        alliance: {id: "1", name: "OneWorld"},
        hubs: [{iata: "JFK"}],
        routeFootprint: [{destIata: "LAX"}]
    }]])
    const out = RA.rank({
        network: {
            destinations: [],
            hubs:         ["JFK"],
            myAlliance:   {name: "SkyTeam"},
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises: enterprises,
        hub:         "JFK",
        limit:       5
    })
    assert.strictEqual(out[0].isMine, false)
})

it("isMine matches when network.myAlliance.id matches bucket id", () => {
    // The fix path: populate myAlliance.id at the same source AllianceOverviewScraper
    // emits the name, OR network-builder cross-references the cached record by name
    // and stamps the matching id onto myAlliance.
    const enterprises = new Map([["A", {
        enterpriseId: "A",
        alliance: {id: "42", name: "MyAlliance"},
        hubs: [{iata: "JFK"}],
        routeFootprint: [{destIata: "LAX"}]
    }]])
    const out = RA.rank({
        network: {
            destinations: [],
            hubs:         ["JFK"],
            myAlliance:   {id: "42", name: "MyAlliance"},
            carrierIndex: {ownEnterpriseIds: []}
        },
        enterprises: enterprises,
        hub:         "JFK",
        limit:       5
    })
    assert.strictEqual(out[0].isMine, true)
})

it("output shape — return field surface (NO openHref)", () => {
    const enterprises = new Map([["A", mkEnt("A", "Z", ["JFK"], ["LAX"])]])
    const out = RA.rank({
        network: {destinations: [], hubs: ["JFK"], myAlliance: null,
                  carrierIndex: {ownEnterpriseIds: []}},
        enterprises: enterprises, hub: "JFK"
    })
    const card = out[0]
    const expectedKeys = ["id","name","members","reach","feedersAtHub","overlapHubs",
                          "contestedAt","score","rationale","isMine"]
    for (const k of expectedKeys) {
        assert.ok(k in card, "missing field " + k + " on card")
    }
    // F-DASH-506: docstring claims openHref but code does not set it.
    assert.strictEqual("openHref" in card, false,
                       "openHref unexpectedly present (docstring matches code)")
})

summary("recommend-alliance")
