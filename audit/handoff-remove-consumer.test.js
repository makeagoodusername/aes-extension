"use strict"

/**
 * Slice D1 — handoff-remove-consumer smoke. Verifies:
 *   - Records with kind:"addRoute" are NOT consumed (wave-applier owns it)
 *   - Records with kind:"removeRoute" + matching aircraftId are consumed
 *   - Resolver matches flights by destIata via VfpReader stub
 *   - Live gate refuses when apply.enabled is false (default)
 *   - moveRoute chains an addRoute onto AesHandoffQueue
 *
 * Run: `node audit/handoff-remove-consumer.test.js`
 */

const fs = require("fs")
const path = require("path")
const assert = require("assert")

const ROOT = path.resolve(__dirname, "..")

let pass = 0, fail = 0
function it(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log("  ok  " + name) },
              e  => { fail++
                      console.log("  FAIL " + name)
                      console.log("       " + (e && e.message))
                      if (e && e.stack) console.log(e.stack.split("\n").slice(1, 3).map(l => "       " + l).join("\n")) })
}

function makeChromeStub() {
    const store = new Map()
    return {
        storage: {
            local: {
                async get(keys) {
                    const out = {}
                    if (Array.isArray(keys)) {
                        for (const k of keys) if (store.has(k)) out[k] = store.get(k)
                    } else if (typeof keys === "string") {
                        if (store.has(keys)) out[keys] = store.get(keys)
                    } else if (keys && typeof keys === "object") {
                        for (const k in keys) out[k] = store.has(k) ? store.get(k) : keys[k]
                    } else {
                        for (const [k, v] of store) out[k] = v
                    }
                    return out
                },
                async set(items) { for (const k in items) store.set(k, items[k]) },
                async remove(keys) {
                    if (Array.isArray(keys)) for (const k of keys) store.delete(k)
                    else store.delete(keys)
                },
                _store: store
            },
            onChanged: { addListener() {}, removeListener() {} }
        },
        runtime: { id: "test", onMessage: { addListener() {} }, sendMessage() {} }
    }
}

function setup({ctxAircraftId, ctxServer, vfpLegs, draftFlights, applyEnabled, dryRunOnly}) {
    global.window = {
        AesAfp: {
            ctx: {server: ctxServer || "ZB", aircraftId: ctxAircraftId || "777"},
            bus: {on() {}, emit() {}, off() {}}
        },
        AesAfpVfpReader: {
            lastLegs: () => vfpLegs || []
        },
        AesAfpActiveDraftStore: {
            getFlights: () => draftFlights || []
        },
        AesAfpAutoApplyLog: {
            add: async () => null
        },
        AesAfpAutoFlightDeleter: {
            start: async (p) => ({ok: true, total: (p.flights || []).length})
        },
        AesAfpSettings: {
            cached: () => ({aircraftFlightPlan: {apply: {enabled: !!applyEnabled, dryRunOnly: !!dryRunOnly}}})
        },
        RouteAssistantToast: {info() {}, warn() {}, error() {}},
        requestAnimationFrame: (fn) => fn()
    }
    global.chrome = makeChromeStub()

    // Load and bind classes to window. handoff-store and handoff-queue
    // declare top-level `class` symbols which content_scripts share via
    // isolated lexical scope; `eval()` scope here is local, so we re-expose
    // them onto window manually (matches audit/tests/afp/_helpers loadAfpModule).
    const loadModule = (rel, exposeNames) => {
        let src = fs.readFileSync(path.join(ROOT, rel), "utf8")
        if (Array.isArray(exposeNames) && exposeNames.length) {
            src += "\n;(function(){\n"
            for (const name of exposeNames) {
                src += `try { if (typeof ${name} !== 'undefined' && typeof window !== 'undefined') window.${name} = ${name}; } catch(_) {}\n`
            }
            src += "})();\n"
        }
        eval(src)
    }
    loadModule("modules/_shared/handoff-store.js", ["AesHandoffStore"])
    loadModule("modules/_shared/handoff-queue.js", ["AesHandoffQueue"])
    loadModule("modules/aircraft-flight-plan/handoff-remove-consumer.js")
    return global.window
}

;(async () => {
    console.log("=== handoff-remove-consumer ===")

    await it("addRoute kind is left alone (wave-applier owns it)", async () => {
        const win = setup({ctxAircraftId: "777"})
        await win.AesHandoffStore.set({aircraftId: "777", source: "wave-designer", presetId: "p1", hub: "JFK"})
        await win.AesAfpHandoffRemoveConsumer._consume()
        const peek = await win.AesHandoffStore.peek()
        assert(peek && peek.source === "wave-designer", "wave-designer record untouched")
    })

    await it("removeRoute consumes when aircraftId matches", async () => {
        const win = setup({
            ctxAircraftId: "777",
            vfpLegs: [{flightId: "f1", destination: "LAX", depTimeLocal: "0830"}]
        })
        await win.AesHandoffStore.set({aircraftId: "777", kind: "removeRoute", destIata: "LAX", hub: "JFK"})
        await win.AesAfpHandoffRemoveConsumer._consume()
        const peek = await win.AesHandoffStore.peek()
        assert(peek === null, "store cleared after consume")
    })

    await it("resolver matches by destIata in VFP legs", async () => {
        const win = setup({
            ctxAircraftId: "777",
            vfpLegs: [
                {flightId: "f1", destination: "LAX", depTimeLocal: "0830"},
                {flightId: "f2", destination: "ORD", depTimeLocal: "1200"},
                {flightId: "f3", destination: "LAX", depTimeLocal: "1900"}
            ]
        })
        const flights = win.AesAfpHandoffRemoveConsumer._resolveMatchingFlights({destIata: "lax"})
        assert(flights.length === 2, "two LAX legs found")
        assert(flights[0].flightId === "f1", "first match")
        assert(flights[1].flightId === "f3", "second match")
    })

    await it("falls back to active-draft when VFP reader empty", async () => {
        const win = setup({
            ctxAircraftId: "777",
            vfpLegs: [],
            draftFlights: [{flightId: "df1", destination: "JFK"}]
        })
        const flights = win.AesAfpHandoffRemoveConsumer._resolveMatchingFlights({destIata: "JFK"})
        assert(flights.length === 1, "draft fallback finds the leg")
    })

    await it("live gate refuses when apply.enabled false (default)", async () => {
        const win = setup({ctxAircraftId: "777", applyEnabled: false})
        const allow = win.AesAfpHandoffRemoveConsumer._gatesAllowLive()
        assert(allow === false, "default config refuses live writes")
    })

    await it("live gate refuses when apply.enabled true but dryRunOnly true", async () => {
        const win = setup({ctxAircraftId: "777", applyEnabled: true, dryRunOnly: true})
        const allow = win.AesAfpHandoffRemoveConsumer._gatesAllowLive()
        assert(allow === false, "dryRunOnly clamps live")
    })

    await it("live gate allows when both flags flipped", async () => {
        const win = setup({ctxAircraftId: "777", applyEnabled: true, dryRunOnly: false})
        const allow = win.AesAfpHandoffRemoveConsumer._gatesAllowLive()
        assert(allow === true, "explicit user opt-in unblocks live")
    })

    await it("moveRoute chains an addRoute onto the queue", async () => {
        const win = setup({
            ctxAircraftId: "777",
            vfpLegs: [{flightId: "f1", destination: "LAX"}]
        })
        await win.AesHandoffStore.set({
            aircraftId: "777", kind: "moveRoute", destIata: "LAX",
            targetAircraftId: "888", hub: "JFK"
        })
        await win.AesAfpHandoffRemoveConsumer._consume()
        // After enqueue with no active record, the queue auto-advances the
        // head into the active slot. So the queue is empty and the active
        // store now holds the addRoute targeting the recipient aircraft.
        const queued = await win.AesHandoffQueue.peekQueue()
        const active = await win.AesHandoffStore.peek()
        assert(queued.length === 0, "queue drained after auto-advance")
        assert(active && active.aircraftId === "888", "active slot now targets recipient aircraft")
        assert(active.destIata === "LAX", "dest preserved")
        assert(active.source === "dnd-grid", "synthesised as dnd-grid channel")
    })

    console.log("\nD1: " + pass + " passed, " + fail + " failed")
    if (fail > 0) process.exitCode = 1
})()
