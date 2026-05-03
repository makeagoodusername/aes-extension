"use strict"

const {loadAfpModule, resetGlobals, assert} = require("../afp/_helpers")

console.log("=== handoff-queue scaffold ===")

let pass = 0, fail = 0
async function step(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
    }
}

function setup() {
    resetGlobals()
    loadAfpModule("modules/_shared/handoff-store.js", ["AesHandoffStore"])
    loadAfpModule("modules/_shared/handoff-queue.js", ["AesHandoffQueue"])
}

;(async () => {
    await step("removeRoute requires destIata", async () => {
        setup()
        let threw = false
        try { await window.AesHandoffStore.set({aircraftId: "1", kind: "removeRoute"}) }
        catch (e) { threw = true }
        assert(threw, "removeRoute without destIata throws")
    })

    await step("removeRoute round-trips via store", async () => {
        setup()
        await window.AesHandoffStore.set({aircraftId: "1", kind: "removeRoute", destIata: "jfk", hub: "lax"})
        const peek = await window.AesHandoffStore.peek()
        assert(peek && peek.kind === "removeRoute", "kind persisted")
        assert(peek.destIata === "JFK", "destIata uppercased")
        assert(peek.hub === "LAX", "hub uppercased")
    })

    await step("moveRoute requires targetAircraftId", async () => {
        setup()
        let threw = false
        try { await window.AesHandoffStore.set({aircraftId: "1", kind: "moveRoute", destIata: "JFK"}) }
        catch (e) { threw = true }
        assert(threw, "moveRoute without targetAircraftId throws")
    })

    await step("moveRoute round-trips when full payload provided", async () => {
        setup()
        await window.AesHandoffStore.set({
            aircraftId: "1", kind: "moveRoute", destIata: "JFK", targetAircraftId: "2"
        })
        const peek = await window.AesHandoffStore.peek()
        assert(peek && peek.kind === "moveRoute", "kind persisted")
        assert(String(peek.targetAircraftId) === "2", "targetAircraftId persisted")
    })

    await step("queue.enqueue sets the head when active is empty", async () => {
        setup()
        const records = [
            {aircraftId: "1", kind: "removeRoute", destIata: "JFK"},
            {aircraftId: "2", kind: "removeRoute", destIata: "LAX"}
        ]
        const n = await window.AesHandoffQueue.enqueue(records)
        assert(n === 2, "enqueue returned 2")
        const peek = await window.AesHandoffStore.peek()
        assert(peek && String(peek.aircraftId) === "1", "head record set as active")
        const remaining = await window.AesHandoffQueue.peekQueue()
        assert(remaining.length === 1, "one record left in queue")
        assert(String(remaining[0].aircraftId) === "2", "remaining is the second record")
    })

    await step("queue.advance pops the next record", async () => {
        setup()
        await window.AesHandoffQueue.enqueue([
            {aircraftId: "1", kind: "removeRoute", destIata: "JFK"},
            {aircraftId: "2", kind: "removeRoute", destIata: "LAX"}
        ])
        await window.AesHandoffStore.consume("1")
        const advanced = await window.AesHandoffQueue.advance()
        assert(advanced && String(advanced.aircraftId) === "2", "advance returned record 2")
        const peek = await window.AesHandoffStore.peek()
        assert(peek && String(peek.aircraftId) === "2", "record 2 is now active")
    })

    await step("queue ttl expires stale arrays on next read", async () => {
        setup()
        await chrome.storage.local.set({
            "_shared:handoff:queue": {
                writtenAt: Date.now() - (window.AesHandoffQueue.QUEUE_TTL_MS + 1000),
                records: [{aircraftId: "9", kind: "removeRoute", destIata: "JFK"}]
            }
        })
        const peek = await window.AesHandoffQueue.peekQueue()
        assert(peek.length === 0, "stale queue dropped on peek")
    })

    await step("queue clear drops both queue and active record", async () => {
        setup()
        await window.AesHandoffQueue.enqueue([
            {aircraftId: "1", kind: "removeRoute", destIata: "JFK"},
            {aircraftId: "2", kind: "removeRoute", destIata: "LAX"}
        ])
        await window.AesHandoffQueue.clear()
        const peekActive = await window.AesHandoffStore.peek()
        const peekQueue = await window.AesHandoffQueue.peekQueue()
        assert(peekActive == null, "active cleared")
        assert(peekQueue.length === 0, "queue cleared")
    })

    console.log("\nhandoff-queue: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exit(1)
})()
