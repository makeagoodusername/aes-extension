"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

global.window = global
global.console = console

const src = fs.readFileSync(path.join(ROOT, "modules/station-automation/country-scraper.js"), "utf8")
eval(src)

;(async function () {
    CountryScraper.FETCH_TIMEOUT_MS = 5
    CountryScraper.FETCH_RETRY_LIMIT = 0

    global.fetch = (_url, opts) => new Promise((_resolve, reject) => {
        if (opts && opts.signal) {
            opts.signal.addEventListener("abort", () => {
                const err = new Error("aborted")
                err.name = "AbortError"
                reject(err)
            }, {once: true})
        }
    })

    const started = Date.now()
    const doc = await CountryScraper._fetchDoc("https://free1.airlinesim.aero/action/info/county?id=1")
    assert.strictEqual(doc, null)
    assert.ok(Date.now() - started < 250, "fetch timeout should not hang the seed runner")
    console.log("country-scraper timeout test passed")
})().catch(err => {
    console.error(err)
    process.exit(1)
})
