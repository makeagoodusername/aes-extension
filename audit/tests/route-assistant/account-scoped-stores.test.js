"use strict"

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

let pass = 0
let fail = 0

async function it(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) {
            console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
        }
    }
}

function makeChromeStore(initial) {
    const store = new Map(Object.entries(initial || {}))
    return {
        async get(keys) {
            if (keys == null) {
                const out = {}
                for (const [k, v] of store) out[k] = v
                return out
            }
            const list = Array.isArray(keys)
                ? keys
                : (typeof keys === "string" ? [keys] : Object.keys(keys || {}))
            const out = {}
            for (const k of list) if (store.has(k)) out[k] = store.get(k)
            return out
        },
        async set(items) {
            for (const k in items) store.set(k, items[k])
        },
        async remove(keys) {
            for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k)
        },
        has(key) { return store.has(key) },
        getRaw(key) { return store.get(key) },
        entries() { return Array.from(store.entries()) }
    }
}

function installGlobals(storage, accountId) {
    global.window = global
    global.console = console
    global.__aesAccountId = accountId || null
    global.currentAccountIdSync = function () {
        return global.__aesAccountId || null
    }
    global.acctKey = function (prefix, suffix) {
        const tail = (suffix == null || suffix === "") ? "" : (":" + suffix)
        return global.__aesAccountId ? prefix + ":acct:" + global.__aesAccountId + tail : prefix + tail
    }
    global.acctKeyForAccount = function (prefix, acct, suffix) {
        const tail = (suffix == null || suffix === "") ? "" : (":" + suffix)
        return acct ? prefix + ":acct:" + acct + tail : prefix + tail
    }
    global.AesAccountKey = {
        acctKey: global.acctKey,
        acctKeyForAccount: global.acctKeyForAccount,
        currentAccountIdSync: global.currentAccountIdSync
    }
    global.chrome = {storage: {local: storage}}
}

function loadStore(relPath, exportName) {
    delete global[exportName]
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8")
    eval(src)
    assert.ok(global[exportName], exportName + " exported")
    return global[exportName]
}

function partner(id, name) {
    return {
        partnerEnterpriseId: id,
        partnerName: name || id,
        productClass: "Y",
        sharePercent: 25,
        relationType: "INTERLINING"
    }
}

function interlineRecord(pair, id) {
    return {
        pair,
        partners: [partner(id)],
        updatedAt: 1000
    }
}

function svc(level) {
    return {
        hub: "JFK",
        dest: "LAX",
        serviceLevel: level,
        createdAt: 1000,
        updatedAt: 1000
    }
}

console.log("=== account-scoped route assistant stores ===")

;(async function () {
    await it("interline saveAt/loadAt isolates sister accounts", async () => {
        const storage = makeChromeStore()
        installGlobals(storage, "acctA")
        const Store = loadStore("modules/route-assistant/interline-store.js", "RouteAssistantInterlineStore")

        await Store.saveAt("acctA", "jfk", "lax", [partner("PA", "Partner A")])
        const recA = await Store.loadAt("acctA", "JFK", "LAX")
        const recB = await Store.loadAt("acctB", "JFK", "LAX")

        assert.strictEqual(recA.partners.length, 1)
        assert.strictEqual(recA.partners[0].partnerEnterpriseId, "PA")
        assert.strictEqual(recB.partners.length, 0)
        assert.ok(storage.has("routeAssistant:interline:acct:acctA:JFK-LAX"))
        assert.ok(!storage.has("routeAssistant:interline:JFK-LAX"))
    })

    await it("interline reads scoped first and legacy only for accounts without scoped data", async () => {
        const storage = makeChromeStore({
            "routeAssistant:interline:JFK-LAX": interlineRecord("JFK-LAX", "LEG"),
            "routeAssistant:interline:JFK-BOS": interlineRecord("JFK-BOS", "BOS"),
            "routeAssistant:interline:acct:acctA:JFK-LAX": interlineRecord("JFK-LAX", "A")
        })
        installGlobals(storage, "acctA")
        const Store = loadStore("modules/route-assistant/interline-store.js", "RouteAssistantInterlineStore")

        assert.strictEqual((await Store.loadAt("acctA", "JFK", "LAX")).partners[0].partnerEnterpriseId, "A")
        assert.strictEqual((await Store.loadAt("acctB", "JFK", "LAX")).partners[0].partnerEnterpriseId, "LEG")
        const bulk = await Store.bulkLoadAt("acctA", [["JFK", "LAX"], ["JFK", "BOS"]])
        assert.strictEqual(bulk["JFK-LAX"].partners[0].partnerEnterpriseId, "A")
        assert.strictEqual(bulk["JFK-BOS"].partners[0].partnerEnterpriseId, "BOS")
    })

    await it("interline loadAll stays within the current account plus legacy fallback", async () => {
        const storage = makeChromeStore({
            "routeAssistant:interline:JFK-LAX": interlineRecord("JFK-LAX", "LEG"),
            "routeAssistant:interline:acct:acctA:JFK-LAX": interlineRecord("JFK-LAX", "A"),
            "routeAssistant:interline:acct:acctB:JFK-LAX": interlineRecord("JFK-LAX", "B"),
            "routeAssistant:interline:acct:acctB:JFK-SFO": interlineRecord("JFK-SFO", "B2")
        })
        installGlobals(storage, "acctA")
        const Store = loadStore("modules/route-assistant/interline-store.js", "RouteAssistantInterlineStore")

        const active = await Store.loadAll()
        assert.deepStrictEqual(active.map(r => r.pair).sort(), ["JFK-LAX"])
        assert.strictEqual(active[0].partners[0].partnerEnterpriseId, "A")

        const acctB = await Store.loadAllAt("acctB")
        assert.deepStrictEqual(acctB.map(r => r.pair).sort(), ["JFK-LAX", "JFK-SFO"])
        assert.ok(acctB.some(r => r.partners[0].partnerEnterpriseId === "B2"))

        const legacyOnly = await Store.loadAllAt(null)
        assert.deepStrictEqual(legacyOnly.map(r => r.pair), ["JFK-LAX"])
        assert.strictEqual(legacyOnly[0].partners[0].partnerEnterpriseId, "LEG")
    })

    await it("interline clearAt removes target account and legacy but not another account", async () => {
        const storage = makeChromeStore({
            "routeAssistant:interline:JFK-LAX": interlineRecord("JFK-LAX", "LEG"),
            "routeAssistant:interline:acct:acctA:JFK-LAX": interlineRecord("JFK-LAX", "A"),
            "routeAssistant:interline:acct:acctB:JFK-LAX": interlineRecord("JFK-LAX", "B")
        })
        installGlobals(storage, "acctA")
        const Store = loadStore("modules/route-assistant/interline-store.js", "RouteAssistantInterlineStore")

        await Store.clearAt("acctA", "JFK", "LAX")
        assert.ok(!storage.has("routeAssistant:interline:JFK-LAX"))
        assert.ok(!storage.has("routeAssistant:interline:acct:acctA:JFK-LAX"))
        assert.ok(storage.has("routeAssistant:interline:acct:acctB:JFK-LAX"))
    })

    await it("service config saveAt/getAt isolates sister accounts", async () => {
        const storage = makeChromeStore()
        installGlobals(storage, "acctA")
        const Store = loadStore("modules/route-assistant/service-config-store.js", "RouteAssistantServiceConfigStore")

        await Store.saveAt("acctA", "jfk", "lax", {serviceLevel: "premium", classMix: {Y: 80, C: 20, F: 0}})
        assert.strictEqual((await Store.getAt("acctA", "JFK", "LAX")).serviceLevel, "premium")
        assert.strictEqual(await Store.getAt("acctB", "JFK", "LAX"), null)
        assert.ok(storage.has("routeAssistant:serviceConfig:acct:acctA:JFK-LAX"))
        assert.ok(!storage.has("routeAssistant:serviceConfig:JFK-LAX"))
    })

    await it("service config reads scoped first and legacy as fallback", async () => {
        const storage = makeChromeStore({
            "routeAssistant:serviceConfig:JFK-LAX": svc("standard"),
            "routeAssistant:serviceConfig:JFK-BOS": {hub: "JFK", dest: "BOS", serviceLevel: "budget"},
            "routeAssistant:serviceConfig:acct:acctA:JFK-LAX": svc("premium")
        })
        installGlobals(storage, "acctA")
        const Store = loadStore("modules/route-assistant/service-config-store.js", "RouteAssistantServiceConfigStore")

        assert.strictEqual((await Store.get("JFK", "LAX")).serviceLevel, "premium")
        assert.strictEqual((await Store.getAt("acctB", "JFK", "LAX")).serviceLevel, "standard")
        const many = await Store.getManyAt("acctA", [["JFK", "LAX"], ["JFK", "BOS"]])
        assert.strictEqual(many.get("JFK-LAX").serviceLevel, "premium")
        assert.strictEqual(many.get("JFK-BOS").serviceLevel, "budget")
    })

    await it("service config removeAt leaves another account's scoped record intact", async () => {
        const storage = makeChromeStore({
            "routeAssistant:serviceConfig:JFK-LAX": svc("standard"),
            "routeAssistant:serviceConfig:acct:acctA:JFK-LAX": svc("premium"),
            "routeAssistant:serviceConfig:acct:acctB:JFK-LAX": svc("budget")
        })
        installGlobals(storage, "acctA")
        const Store = loadStore("modules/route-assistant/service-config-store.js", "RouteAssistantServiceConfigStore")

        await Store.removeAt("acctA", "JFK", "LAX")
        assert.ok(!storage.has("routeAssistant:serviceConfig:JFK-LAX"))
        assert.ok(!storage.has("routeAssistant:serviceConfig:acct:acctA:JFK-LAX"))
        assert.strictEqual(storage.getRaw("routeAssistant:serviceConfig:acct:acctB:JFK-LAX").serviceLevel, "budget")
    })

    console.log("\naccount-scoped route assistant stores: " + pass + " passed, " + fail + " failed")
    if (fail) process.exitCode = 1
})()
