"use strict"

const {loadModule, it, summary, assert} = require("./_helpers")

const win = loadModule("modules/strategy/company-reputation-store.js", {})
const Store = win.AesCompanyReputationStore

function fakeDoc(rows) {
    return {
        querySelectorAll(selector) {
            if (selector !== "tr") return []
            return rows.map(([label, value]) => ({
                querySelectorAll() {
                    return [
                        {textContent: label},
                        {textContent: value}
                    ]
                }
            }))
        }
    }
}

;(async function run() {
    await it("maps AS rating labels to numeric scores", () => {
        assert.strictEqual(Store.scoreRating("AAA"), 10)
        assert.strictEqual(Store.scoreRating("AA"), 9)
        assert.strictEqual(Store.scoreRating("D"), 1)
        assert.strictEqual(Store.scoreRating("unknown"), null)
    })

    await it("normalises rating score into 0..1", () => {
        assert.strictEqual(Store.ratingNorm("AAA"), 1)
        assert.strictEqual(Store.ratingNorm("B"), 0.5)
        assert.strictEqual(Store.ratingNorm(null), null)
    })

    await it("extracts identity and rating from labelled table rows", () => {
        const rec = Store.fromDocument(fakeDoc([
            ["Name", "Fly Example"],
            ["Code", "FE"],
            ["Rating", "BBB"]
        ]), {source: "test"})
        assert.strictEqual(rec.displayName, "Fly Example")
        assert.strictEqual(rec.airlineCode, "FE")
        assert.strictEqual(rec.ratingLabel, "BBB")
        assert.strictEqual(rec.ratingScore, 7)
        assert.strictEqual(rec.ratingNorm, 0.7)
    })

    summary("company-reputation")
})()
