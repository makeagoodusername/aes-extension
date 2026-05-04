"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function installGlobals(storage) {
    global.window = global
    global.chrome = {storage: {local: storage}}
    global.acctKey = function (prefix, suffix) {
        const tail = suffix ? ":" + suffix : ""
        return prefix + ":acct:test" + tail
    }
}

function loadStore() {
    delete global.RouteAssistantWatchlistStore
    const src = fs.readFileSync(path.join(ROOT, "modules/route-assistant/watchlist-store.js"), "utf8")
    eval(src)
    return global.RouteAssistantWatchlistStore
}

async function main() {
    console.log("=== watchlist store context recovery ===")

    installGlobals({
        async get() {
            throw new Error("Extension context invalidated.")
        },
        async set() {
            throw new Error("Extension context invalidated.")
        }
    })
    const Store = loadStore()

    const keys = await Store.loadKeys()
    assert.ok(keys instanceof Set)
    assert.strictEqual(keys.size, 0)

    const saved = await Store._saveBlob({server: "free1", routes: {"JFK-LHR": {addedAt: 1}}})
    assert.strictEqual(saved, false)

    installGlobals({
        async get() {
            throw new Error("quota exceeded")
        },
        async set() {}
    })
    loadStore()
    await assert.rejects(() => global.RouteAssistantWatchlistStore.loadKeys(), /quota exceeded/)

    console.log("watchlist-store-context: passed")
}

main().catch(err => {
    console.error(err && err.stack || err)
    process.exit(1)
})
