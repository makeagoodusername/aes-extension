"use strict"

/**
 * Pure-function smoke for AesStrategyLessonMiner.mine() — Slice 26 Phase 2.
 *
 * Plants a 2-bucket synthetic journal × outcomes pair: the "short / low /
 * JFK / narrow" cluster is heavily favourable, the "long / high / LHR /
 * wide" cluster is heavily unfavourable. Both should surface as top
 * lessons with opposite-sign lift, ranked by `|lift| × √n`.
 */

const {loadModule, it, summary, assert} = require("./_helpers")

const win = loadModule("modules/strategy/lesson-miner.js", {})
const M = win.AesStrategyLessonMiner

function _journal(idPrefix, n, route, after, refPrefix) {
    const out = []
    for (let i = 0; i < n; i++) {
        out.push({
            id:         idPrefix + i,
            action:     "apply-decision",
            outcomeRef: refPrefix + i,
            route:      route,
            after:      after
        })
    }
    return out
}
function _outcomes(refPrefix, n, favourable) {
    const out = []
    for (let i = 0; i < n; i++) {
        out.push({
            outcomeId: refPrefix + i,
            after:     {favourable: favourable},
            before:    null
        })
    }
    return out
}

;(async () => {
    await it("mine returns empty when journal is empty", () => {
        const r = M.mine({journal: [], outcomes: []})
        assert.deepStrictEqual(r.lessons, [])
        assert.strictEqual(r.stats.globalN, 0)
    })

    await it("mine ignores entries without outcomeRef join", () => {
        const journal = [{id: "j1", action: "apply-decision",
            route: "JFK-LAX", after: {distanceKm: 500, incumbentCount: 1}}]
        const r = M.mine({journal, outcomes: []})
        assert.strictEqual(r.stats.globalN, 0)
    })

    await it("two-cluster planted lift surfaces both buckets in rank order", () => {
        const winnerJ = _journal("jW", 8, "JFK-LAX",
            {distanceKm: 500, incumbentCount: 1, equipFamily: "narrow"}, "oW")
        const loserJ  = _journal("jL", 6, "LHR-SYD",
            {distanceKm: 17000, incumbentCount: 8, equipFamily: "wide"}, "oL")
        const winnerO = _outcomes("oW", 8, true)
        const loserO  = _outcomes("oL", 6, false)
        const r = M.mine({journal: winnerJ.concat(loserJ),
                          outcomes: winnerO.concat(loserO)})
        assert.strictEqual(r.stats.globalN, 14)
        assert.strictEqual(r.stats.globalFav, 8)
        assert.strictEqual(r.lessons.length, 2)
        // Loser cluster ranks first: lift = -8/14 ≈ -0.571 with √6 wins
        // over winner's +6/14 ≈ +0.429 with √8.
        const loser  = r.lessons.find(l => l.attrCluster.hub === "LHR")
        const winner = r.lessons.find(l => l.attrCluster.hub === "JFK")
        assert.ok(loser && winner, "both buckets surfaced")
        assert.strictEqual(winner.attrCluster.distanceBand, "short")
        assert.strictEqual(winner.attrCluster.incumbentBand, "low")
        assert.strictEqual(winner.n, 8)
        assert.strictEqual(winner.supportFavorable, 8)
        assert.ok(winner.lift > 0, "winner lift positive: " + winner.lift)
        assert.strictEqual(loser.attrCluster.distanceBand, "long")
        assert.strictEqual(loser.attrCluster.incumbentBand, "high")
        assert.ok(loser.lift < 0, "loser lift negative: " + loser.lift)
        assert.ok(loser.score >= winner.score, "loser ranks first by |lift|×√n")
        assert.strictEqual(r.lessons[0].lessonId, loser.lessonId)
    })

    await it("buckets below MIN_BUCKET_N (3) are dropped", () => {
        const j = _journal("j", 2, "JFK-LAX",
            {distanceKm: 500, incumbentCount: 1, equipFamily: "narrow"}, "o")
        const o = _outcomes("o", 2, true)
        const r = M.mine({journal: j, outcomes: o})
        assert.strictEqual(r.lessons.length, 0)
    })

    await it("distance/incumbent banding edges", () => {
        assert.strictEqual(M._distanceBand(799),  "short")
        assert.strictEqual(M._distanceBand(800),  "medium")
        assert.strictEqual(M._distanceBand(2400), "long")
        assert.strictEqual(M._incumbentBand(0),   "low")
        assert.strictEqual(M._incumbentBand(2),   "low")
        assert.strictEqual(M._incumbentBand(5),   "mid")
        assert.strictEqual(M._incumbentBand(6),   "high")
    })

    await it("favourable derived from weeklyResult delta when boolean missing", () => {
        const out = {after: {weeklyResult: 100}, before: {weeklyResult: 50}}
        assert.strictEqual(M._favourable(out), true)
        const out2 = {after: {weeklyResult: 50}, before: {weeklyResult: 100}}
        assert.strictEqual(M._favourable(out2), false)
        assert.strictEqual(M._favourable({after: null}), null)
    })

    summary("lesson-miner-smoke")
})()
