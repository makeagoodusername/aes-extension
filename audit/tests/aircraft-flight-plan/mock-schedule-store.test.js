"use strict"

const assert = require("assert")
const path = require("path")

let pass = 0, fail = 0
async function it(name, fn) {
    try { await fn(); pass++; console.log("  ok  " + name) }
    catch (e) {
        fail++
        console.log("  FAIL " + name + " — " + (e && e.message))
    }
}

function loadStore() {
    const store = new Map()
    global.window = global
    global.AesAccountKey = {
        acctKey(prefix, suffix) {
            const acctId = global.__aesAccountId || null
            return acctId ? prefix + ":acct:" + acctId + ":" + suffix : prefix + ":" + suffix
        }
    }
    global.chrome = {
        storage: {
            local: {
                get(keys, cb) {
                    const list = Array.isArray(keys) ? keys : [keys]
                    const out = {}
                    for (const k of list) if (store.has(k)) out[k] = store.get(k)
                    cb(out)
                },
                set(items, cb) {
                    for (const k in items) store.set(k, items[k])
                    cb && cb()
                },
                remove(keys, cb) {
                    for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k)
                    cb && cb()
                }
            }
        },
        runtime: {lastError: null}
    }
    delete global.AesAfpMockScheduleStore
    const p = path.resolve(__dirname, "..", "..", "..", "modules/aircraft-flight-plan/mock-schedule/store.js")
    delete require.cache[require.resolve(p)]
    return {S: require(p), store}
}

;(async () => {
    console.log("=== mock-schedule store ===")

    await it("save + load round-trips a record", async () => {
        const {S} = loadStore()
        global.__aesAccountId = "acct-A"
        const rec = {
            server: "free1", aircraftId: "22092", hub: "LHR",
            spec: {seats: 218, cruiseSpeedKmh: 850, range: 11000},
            selectedAirports: [{iata: "FRA", distanceKm: 650}],
            flightsTarget: 7,
            legs: [{origin: "LHR", destination: "FRA", depTime: "09:00", dayMask: [true, true, true, true, true, true, true]}],
            warnings: []
        }
        const r1 = await S.save(rec)
        assert.strictEqual(r1.ok, true)
        const r2 = await S.load("free1", "22092")
        assert.ok(r2 && r2.aircraftId === "22092")
        assert.strictEqual(r2.flightsTarget, 7)
        assert.strictEqual(r2.legs[0].destination, "FRA")
        assert.ok(typeof r2.savedAt === "number")
    })

    await it("acct-scoped key is preferred over legacy", async () => {
        const {S, store} = loadStore()
        global.__aesAccountId = "acct-B"
        await S.save({server: "free1", aircraftId: "1", flightsTarget: 5, legs: []})
        // Plant a legacy record with a different value to confirm precedence.
        store.set("aircraftFlightPlan:mockSchedule:free1:1", {flightsTarget: 999, legs: []})
        // ...but the save() above already wrote both keys; rewrite legacy after.
        store.set("aircraftFlightPlan:mockSchedule:free1:1", {flightsTarget: 999, legs: []})
        const out = await S.load("free1", "1")
        assert.strictEqual(out.flightsTarget, 5, "scoped wins over legacy")
    })

    await it("legacy fallback works when no acct id is set", async () => {
        const {S} = loadStore()
        global.__aesAccountId = null
        await S.save({server: "free1", aircraftId: "9", flightsTarget: 11, legs: []})
        const out = await S.load("free1", "9")
        assert.strictEqual(out.flightsTarget, 11)
    })

    await it("save rejects records missing server/aircraftId", async () => {
        const {S} = loadStore()
        const r = await S.save({hub: "LHR"})
        assert.strictEqual(r.ok, false)
    })

    await it("clear removes both legacy and scoped keys", async () => {
        const {S} = loadStore()
        global.__aesAccountId = "acct-C"
        await S.save({server: "free1", aircraftId: "5", flightsTarget: 3, legs: []})
        const before = await S.load("free1", "5")
        assert.ok(before)
        await S.clear("free1", "5")
        const after = await S.load("free1", "5")
        assert.strictEqual(after, null)
    })

    console.log("\nmock-schedule-store: " + pass + " passed, " + fail + " failed")
    process.exit(fail === 0 ? 0 : 1)
})()
