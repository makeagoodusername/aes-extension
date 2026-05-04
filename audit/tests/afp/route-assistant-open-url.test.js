"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function loadHost(extras) {
    global.window = global
    global.document = {
        querySelector() { return null },
        querySelectorAll() { return [] }
    }
    global.AES = {
        getAirlineCode() { return {name: "", code: ""} },
        getAirlineIdentity() { return "" },
        getServerName() { return "free1" }
    }
    delete global.AesAfp
    delete global.AesAfpScheduleStore
    delete global.AesAfpRouteCandidates
    delete global.chrome
    Object.assign(global, extras || {})
    eval(fs.readFileSync(path.join(ROOT, "modules/aircraft-flight-plan/host.js"), "utf8"))
    return global.AesAfp
}

let pass = 0
let fail = 0
async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name + " - " + (e && e.message))
    }
}

console.log("=== afp route-assistant open url ===")

;(async function () {
    await it("resolves a concrete pair from stored schedule legs for the active hub", async () => {
        const AesAfp = loadHost({
            AesAfpScheduleStore: {
                async load() {
                    return {
                        legs: [
                            {origin: "JFK", destination: "LHR"},
                            {origin: "LHR", destination: "JFK"}
                        ]
                    }
                }
            }
        })
        const url = await AesAfp.resolveRouteAssistantSchedulingUrl("LHR", {
            server: "free1",
            aircraftId: "22092"
        })
        assert.strictEqual(url, "/app/com/scheduling/LHRJFK")
    })

    await it("falls back to top-routes cache when no schedule pair is known", async () => {
        const AesAfp = loadHost({
            AesAfpScheduleStore: {
                async load() { return {legs: []} }
            },
            chrome: {
                storage: {
                    local: {
                        async get(keys) {
                            return {
                                [keys[0]]: {
                                    hub: "ICN",
                                    rows: [{destIata: "NRT"}]
                                }
                            }
                        }
                    }
                }
            }
        })
        const url = await AesAfp.resolveRouteAssistantSchedulingUrl("ICN", {
            server: "free1",
            aircraftId: "1"
        })
        assert.strictEqual(url, "/app/com/scheduling/ICNNRT")
    })

    console.log("pass=" + pass + " fail=" + fail)
    if (fail) process.exit(1)
})()
