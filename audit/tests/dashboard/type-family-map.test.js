"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..", "..", "..")

function loadTypeFamilyMap(extras) {
    const src = fs.readFileSync(path.join(ROOT, "modules/used-aircraft-scanner/type-family-map.js"), "utf8")
    const ctx = Object.assign({console}, extras || {})
    vm.runInNewContext(src + "\nthis.TypeFamilyMap = TypeFamilyMap;", ctx)
    return ctx.TypeFamilyMap
}

function loadScanController(extras) {
    const typeSrc = fs.readFileSync(path.join(ROOT, "modules/used-aircraft-scanner/type-family-map.js"), "utf8")
    const scanSrc = fs.readFileSync(path.join(ROOT, "modules/used-aircraft-scanner/scan-controller.js"), "utf8")
    const ctx = Object.assign({
        console,
        setTimeout,
        clearTimeout,
        window: {open: function() { return true }},
        chrome: {storage: {onChanged: {addListener: function() {}, removeListener: function() {}}}},
        MarketScanSession: {
            create: function(args) {
                return Object.assign({
                    scanId: "scan-test",
                    status: "running",
                    inFlight: 0,
                    lastDispatchAt: 0
                }, args)
            },
            cleanupOld: async function() {},
            saveSession: async function() {}
        },
        MarketScanLease: {acquire: async function() { return true }},
        UsedAircraftPresets: {save: async function() {}}
    }, extras || {})
    vm.runInNewContext(
        typeSrc
        + "\nthis.TypeFamilyMap = TypeFamilyMap;"
        + "\n"
        + scanSrc
        + "\nthis.ScanController = ScanController;",
        ctx
    )
    return ctx
}

function makeSelect(labels, selectedIndex) {
    const options = labels.map(label => ({textContent: label, value: label}))
    return {options, selectedIndex: selectedIndex || 0}
}

function makeDoc(familyLabel, typeLabels) {
    const familySelect = makeSelect([familyLabel], 0)
    const typeSelect = makeSelect(["any aircraft type"].concat(typeLabels), 0)
    return {
        querySelector: function(selector) {
            if (selector.indexOf("filter-aircraftFamily") !== -1) return familySelect
            if (selector.indexOf("filter-aircraftType") !== -1) return typeSelect
            return null
        }
    }
}

let pass = 0
let fail = 0

async function test(name, fn) {
    try {
        await fn()
        pass++
        console.log("  ok  " + name)
    } catch (e) {
        fail++
        console.log("  FAIL " + name)
        console.log("       " + (e && e.message))
        if (e && e.stack) console.log(e.stack.split("\n").slice(1, 4).map(l => "       " + l).join("\n"))
    }
}

;(async function main() {
    console.log("=== type-family-map / scanner scope ===")

    await test("family-scoped AS dropdown is not treated as the global live type catalog", function() {
        const T = loadTypeFamilyMap()
        const doc = makeDoc("A320 / A321", ["Airbus A320-200", "Airbus A321-200"])
        assert.strictEqual(T.liveMarketTypeSet(doc), null)
    })

    await test("family-scoped live labels are merged as scan-capable type options", function() {
        const T = loadTypeFamilyMap()
        const doc = makeDoc("New Test Family", ["ACME 100", "ACME 200"])
        const options = T.marketTypeOptions({}, doc)
        assert.ok(options.some(e => e.type === "ACME 100" && e.family === "New Test Family"))
        assert.ok(options.some(e => e.type === "Airbus A320-200" && e.family === "A320 / A321"))
    })

    await test("global AS dropdown still filters stale static aliases while keeping live unknown labels", function() {
        const T = loadTypeFamilyMap()
        const doc = makeDoc("any aircraft family", ["Airbus A320-200", "ACME 100"])
        const live = T.liveMarketTypeSet(doc)
        const options = T.marketTypeOptions({}, doc).filter(e => live.has(e.type))
        assert.strictEqual(
            JSON.stringify(options.map(e => e.type).sort()),
            JSON.stringify(["ACME 100", "Airbus A320-200"])
        )
    })

    await test("scan controller queues unmapped live labels under any aircraft family", async function() {
        const ctx = loadScanController()
        ctx.ScanController.prototype.tick = async function() {}
        const ctrl = new ctx.ScanController("test")
        const session = await ctrl.start({id: "p", name: "Preset", types: ["ACME 100"]}, {})
        assert.strictEqual(session.queue.length, 1)
        assert.strictEqual(session.queue[0].type, "ACME 100")
        assert.strictEqual(session.queue[0].family, "any aircraft family")
        assert.strictEqual(session.queue[0].familyFallback, true)
        assert.strictEqual(session.queue[0].status, "pending")
    })

    console.log("\ntype-family-map / scanner scope: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
})().catch(err => {
    console.error(err)
    process.exitCode = 1
})
